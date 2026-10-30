// API-03 SUPPLIER REBATE CLAIMS (D03-FR-03 "accrue rebate/funding claims" · M06-FR-03 "Purchase + Finance (rebate claims)" ·
// §28 "Finance approves rebate claims" · OB-404, owner, 27 Oct 2026, in writing, option A · P-03 · P-08 · hard rules #2, #5,
// #6, #10).
//
// Before this the shop ACCRUED what a supplier owed it (`rebates.ts`, "earned-not-claimed") and finance RECORDED the money
// when it came (`services/finance/src/rebate-receipts.ts`) — but nothing was ever claimed: no document asked the supplier
// for the money, nobody approved it, and an unanswered claim could not be seen. Now, between the two:
//
//   • RAISE (`POST /v1/purchase/rebate-schemes/:schemeId/claims/:claimId`, the person who keeps the schemes) — { amountMinor,
//     note? }. Never more than the scheme has EARNED and not yet received, less what open claims already ask for: the same
//     money is never claimed twice. Written under the scheme's claim guard, so two claims at once cannot both pass.
//   • FINANCE APPROVES it through head office's maker-checker engine (ADR-0024, kind `rebate_claim`): the person who will
//     send it asks (`POST /v1/approvals/requests` with the `approvalAsk` the register gives — exactly the claim's supplier,
//     scheme and amount); a different person with Finance's authority (`purchase.supplier.approve`) approves it in their own
//     session. The person who RAISED the claim can never be its approver.
//   • SEND (`POST /v1/purchase/rebate-claims/:claimId/send`) — { approvalId, sentOn }: the approval is spent on it, once, and
//     the claim is "sent on" that day. From then the claim DOCUMENT (`GET …/:claimId/document`) prints as sent, and the
//     supplier sees it on the supplier portal (`GET /v1/supplier-portal/me/rebate-claims`).
//   • MATCH (`POST /v1/purchase/rebate-claims/:claimId/matches/:receiptId`, finance) — { amountMinor? }: a receipt finance's
//     ledger already holds, under the same scheme, answers the claim; never more than either has left.
//   • WITHDRAW (`POST …/:claimId/withdraw`) — { reason }: a compensating fact; what is still unanswered may be claimed again.
//   • OVERDUE — a sent claim still unanswered after the OWNER's answer period (`POST /v1/purchase/rebate-claims/answer-period`,
//     the owner's alone). Until he sets it every sent claim says "not set", never a guessed number of days.
//   • READ (`GET /v1/purchase/rebate-claims`) — per scheme: accrued, received, outstanding, claimable, the accruals and the
//     receipts; every claim with its state, due day and whether it is overdue; receipts not matched to any claim.
//
// Every state is an appended fact (hard rule #2); nothing is edited or deleted (#6); nothing here moves money (the receipt
// is finance's journal) and no AI writes anything (#5). The rule is the tested engine in `@sre/purchasing`.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound, concurrentChange } from '../../kernel/src/index';
import { ConcurrencyConflictError } from '../../../packages/persistence/src/event-store';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { approvalNamedIn, type ApprovalPort } from '../../identity/src/approval-requests';
import {
  foldRebateClaims, claimView, claimableFor, judgeRaise, judgeSend, judgeMatch, judgeWithdraw, matchedOfReceipts, unmatchedReceipts,
  type RebateClaimFact, type RebateClaimView, type RebateReceiptFact, type RebateScheme, type ClaimRefusal,
} from '../../../packages/purchasing/src/index';
import { shopClock, shopDateIn, shopToday, type ShopCalendarOf } from '../../../packages/calendar/src/shop-clock';
import type { StoredRebateAccrual } from './rebates';

/** The owner's answer period: how many days a supplier has to answer a sent claim. `days: null` = cleared. Latest applies. */
export interface RebateAnswerPeriodSetting {
  readonly days: number | null;
  readonly setBy: string;
  readonly setAt: string;
  readonly reason?: string;
}

export interface RebateClaimDeps {
  /** Head office's maker-checker engine (ADR-0024). Absent on a bare stub: then no claim can be sent (never by accident). */
  readonly approvals?: ApprovalPort;
  /** R1c (M01-FR-02): the shop's calendar — "today" for overdue is the shop's date, never UTC. */
  readonly calendar?: ShopCalendarOf;
  readonly schemes: (tenantId: string) => Promise<readonly RebateScheme[]> | readonly RebateScheme[];
  /** Every posted accrual of a scheme (latest per accrual id) — what the scheme has EARNED. */
  readonly accruals: (tenantId: string, schemeId: string) => Promise<readonly StoredRebateAccrual[]> | readonly StoredRebateAccrual[];
  /** Every rebate receipt on finance's ledger (the rebate-receipt journals) — what has been RECEIVED. */
  readonly receipts: (tenantId: string) => Promise<readonly RebateReceiptFact[]> | readonly RebateReceiptFact[];
  /** Every claim fact, oldest first. */
  readonly claimFacts: (tenantId: string) => Promise<readonly RebateClaimFact[]> | readonly RebateClaimFact[];
  /** The scheme's claim write guard — read BEFORE the facts it protects. */
  readonly claimsVersion: (tenantId: string, schemeId: string) => Promise<number> | number;
  /** Append one fact under the scheme's claim guard (else `ConcurrencyConflictError`). */
  readonly recordFact: (tenantId: string, schemeId: string, fact: RebateClaimFact, guard: { readonly key: string; readonly expectedVersion: number }) => Promise<void>;
  /** Every answer-period setting, oldest first (the latest applies). */
  readonly answerPeriods: (tenantId: string) => Promise<readonly RebateAnswerPeriodSetting[]> | readonly RebateAnswerPeriodSetting[];
  readonly recordAnswerPeriod: (tenantId: string, setting: RebateAnswerPeriodSetting) => Promise<void> | void;
  /** The shop's company as its documents name it; undefined when head office has none on record. */
  readonly shopName?: (tenantId: string) => Promise<{ readonly name: string; readonly gstin?: string } | undefined>;
  /** A supplier's name on the supplier master; undefined when unknown. */
  readonly supplierName?: (tenantId: string, supplierId: string) => Promise<string | undefined>;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

export const rebateClaimGuardKey = (schemeId: string): string => `rebate-claims:${schemeId}`;

/** What Finance approves for a claim — exactly its supplier, scheme and amount. The register hands it to the asker. */
export function rebateClaimApprovalAsk(c: { readonly claimId: string; readonly schemeId: string; readonly supplierId: string; readonly amountMinor: number }) {
  return {
    kind: 'rebate_claim', subjectRef: c.claimId, valueMinor: c.amountMinor,
    details: { claimId: c.claimId, schemeId: c.schemeId, supplierId: c.supplierId, amountMinor: c.amountMinor },
    summary: `Rebate claim ${c.claimId}: ₹${(c.amountMinor / 100).toFixed(2)} from supplier ${c.supplierId} under scheme ${c.schemeId}`,
    reason: 'rebate earned and not yet received (D03-FR-03)',
  } as const;
}

export const ANSWER_PERIOD_NOT_SET = 'Not set. The owner has not said how many days a supplier has to answer a rebate claim, so no claim can show as overdue until he does.';

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isPosInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const refuse = (r: ClaimRefusal, next: string): Error => apiError(r.status, { code: r.code, whatHappened: r.why, wasItSaved: 'not_saved', nextSafeAction: next });

export function rebateClaimRoutes(deps: RebateClaimDeps): readonly Route[] {
  const answerDaysOf = async (t: string): Promise<{ days: number | null; latest: RebateAnswerPeriodSetting | undefined }> => {
    const latest = (await deps.answerPeriods(t)).at(-1);
    return { days: latest?.days ?? null, latest };
  };
  /** R16-A (M01-FR-02): the SHOP's date of a moment, in the tenant's calendar — never the UTC date of its ISO text. */
  const shopDateOfFor = async (t: string): Promise<(iso: string) => string> => {
    const clock = shopClock(deps.calendar);
    const zone = (await clock.calendar(t)).timeZone;
    return (iso) => shopDateIn(iso, zone);
  };
  /** Everything one decision needs, read AFTER the guard: the scheme's claims as views, what it earned and received. */
  const schemeFacts = async (t: string, schemeId: string) => {
    const [facts, accruals, receipts, { days }, today] = await Promise.all([
      deps.claimFacts(t), deps.accruals(t, schemeId), deps.receipts(t), answerDaysOf(t), shopToday(deps, t),
    ]);
    const claims = foldRebateClaims(facts);
    const views = [...claims.values()].map((c) => claimView(c, { today, answerDays: days }));
    const mine = receipts.filter((r) => r.schemeId === schemeId);
    return {
      claims, views, schemeClaims: views.filter((v) => v.schemeId === schemeId), accruals, receipts,
      accruedMinor: accruals.reduce((s, a) => s + a.accrued.minor, 0), receivedMinor: mine.reduce((s, r) => s + r.amountMinor, 0), today, days,
    };
  };
  const write = async (t: string, schemeId: string, fact: RebateClaimFact, expectedVersion: number): Promise<void> => {
    try {
      await deps.recordFact(t, schemeId, fact, { key: rebateClaimGuardKey(schemeId), expectedVersion });
    } catch (e) {
      if (e instanceof ConcurrencyConflictError) throw concurrentChange(`the rebate claims of scheme ${schemeId} (another claim, send or match landed a moment ago)`);
      throw e;
    }
  };
  const audit = async (t: string, entry: Omit<AuditEntry, 'origin' | 'objectType'> & { branchId?: string | null }) => {
    const { branchId, ...rest } = entry;
    await deps.recordAudit?.(t, { ...rest, objectType: 'rebate_claim', origin: { tenantId: t, branchId: branchId ?? null } });
  };
  const claimOr404 = (views: readonly RebateClaimView[], claimId: string): RebateClaimView => {
    const v = views.find((x) => x.claimId === claimId);
    if (v === undefined) throw notFound(`rebate claim ${claimId}`);
    return v;
  };
  const schemeOfClaim = async (t: string, claimId: string): Promise<string> => {
    const raised = (await deps.claimFacts(t)).find((f) => f.type === 'raised' && f.claimId === claimId);
    if (raised === undefined) throw notFound(`rebate claim ${claimId}`);
    return (raised as Extract<RebateClaimFact, { type: 'raised' }>).schemeId;
  };

  /** The claim DOCUMENT — what is printed and sent, and what the supplier's portal shows. */
  const documentOf = async (t: string, v: RebateClaimView, scheme: RebateScheme | undefined, accruals: readonly StoredRebateAccrual[]) => {
    const from = await deps.shopName?.(t);
    const supplierName = await deps.supplierName?.(t, v.supplierId);
    const shopDate = await shopDateOfFor(t); // R16-A: the dates printed on the claim are the SHOP's
    return {
      title: 'Supplier rebate claim', titleTa: 'விநியோகஸ்தர் தள்ளுபடிக் கோரிக்கை',
      claimNumber: v.claimId,
      status: v.sent === undefined ? (v.state === 'withdrawn' ? 'withdrawn' : 'draft_not_approved') : v.state,
      from: from === undefined ? null : { name: from.name, ...(from.gstin === undefined ? {} : { gstin: from.gstin }) },
      to: { supplierId: v.supplierId, name: supplierName ?? null },
      scheme: scheme === undefined ? { schemeId: v.schemeId } : { schemeId: scheme.schemeId, basis: scheme.basis, rateBp: scheme.rateBp, startsOn: scheme.startsOn, endsOn: scheme.endsOn },
      earnedFrom: accruals.map((a) => ({ accrualId: a.accrualId ?? null, periodFrom: a.periodFrom ?? null, periodTo: a.periodTo ?? null, accruedMinor: a.accrued.minor })),
      amountClaimedMinor: v.amountMinor,
      raisedOn: shopDate(v.raisedAt),
      sentOn: v.sent?.sentOn ?? null,
      approvedByFinance: v.sent === undefined ? null : v.sent.approvedBy,
      answerDueOn: v.dueOn,
      answerDue: v.dueOn === null ? (v.sent === undefined ? 'not_sent' : 'not_set') : 'set',
      paidMinor: v.matchedMinor,
      leftToPayMinor: v.unansweredMinor,
      ...(v.note === undefined ? {} : { note: v.note }),
      ...(v.withdrawn === undefined ? {} : { withdrawn: { reason: v.withdrawn.reason, on: shopDate(v.withdrawn.withdrawnAt) } }),
      words: `Please pay ₹${(v.amountMinor / 100).toFixed(2)} as the rebate earned under scheme ${v.schemeId}, quoting claim ${v.claimId}.`,
    };
  };

  return [
    {
      // RAISE a claim for money the scheme earned and has not received or claimed. Body: { amountMinor, note? }.
      api: 'API-03', method: 'POST', path: '/v1/purchase/rebate-schemes/:schemeId/claims/:claimId',
      permission: 'purchase.contract.manage', idempotent: true,
      handler: async (ctx) => {
        const t = ctx.tenantId;
        const schemeId = (ctx.params['schemeId'] ?? '').trim();
        const claimId = (ctx.params['claimId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (schemeId === '' || claimId === '' || !isPosInt(b['amountMinor']) || (b['note'] !== undefined && !(typeof b['note'] === 'string' && b['note'].length <= 300))) {
          throw apiError(400, {
            code: 'not_readable_as_a_rebate_claim',
            whatHappened: 'A rebate claim needs the schemeId and claimId in the path and { amountMinor (whole paise, more than 0), note? (up to 300 characters) } in the body.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the amount to claim. Nothing was raised.',
          });
        }
        const scheme = (await deps.schemes(t)).find((s) => s.schemeId === schemeId);
        if (scheme === undefined) throw notFound(`rebate scheme ${schemeId}`);
        const expectedVersion = await deps.claimsVersion(t, schemeId);
        const f = await schemeFacts(t, schemeId);
        const amountMinor = b['amountMinor'] as number;
        const judged = judgeRaise({ existing: f.claims.get(claimId), claimId, schemeId, amountMinor, accruedMinor: f.accruedMinor, receivedMinor: f.receivedMinor, schemeClaims: f.schemeClaims });
        if (!judged.ok) throw refuse(judged, judged.code === 'claim_exceeds_unclaimed' ? 'Post the accrual for the period first, or claim only what is shown as claimable. Nothing was raised.' : 'Use a new claim number. Nothing was raised.');
        if (judged.alreadyRaised) {
          return { status: 200, body: { claim: claimOr404(f.views, claimId), alreadyRaised: true } };
        }
        const at = deps.now();
        const note = typeof b['note'] === 'string' && b['note'].trim() !== '' ? b['note'].trim() : undefined;
        await write(t, schemeId, { type: 'raised', claimId, schemeId, supplierId: scheme.supplierId, amountMinor, raisedBy: ctx.userId, raisedAt: at, ...(note === undefined ? {} : { note }) }, expectedVersion);
        await audit(t, {
          actorId: ctx.userId, action: 'rebate_claim.raise', objectId: claimId, at, before: null,
          after: { schemeId, supplierId: scheme.supplierId, amountMinor: String(amountMinor), state: 'raised' }, correlationId: claimId, branchId: ctx.branchId ?? null,
        });
        const claim = claimView({ claimId, schemeId, supplierId: scheme.supplierId, amountMinor, raisedBy: ctx.userId, raisedAt: at, ...(note === undefined ? {} : { note }), matches: [] }, { today: f.today, answerDays: f.days });
        return {
          status: 201,
          body: {
            claim, alreadyRaised: false,
            // The next step, said: Finance approves exactly this before it is sent.
            approvalAsk: rebateClaimApprovalAsk(claim),
            next: 'Ask Finance to approve it (POST /v1/approvals/requests with approvalAsk); once a different person approves it, record it as sent with the approvalId.',
          },
        };
      },
    },
    {
      // SEND: Finance's approval of exactly this claim is spent on it, and the claim is sent on a day. Body: { approvalId, sentOn }.
      api: 'API-03', method: 'POST', path: '/v1/purchase/rebate-claims/:claimId/send',
      permission: 'purchase.contract.manage', idempotent: true,
      handler: async (ctx) => {
        const t = ctx.tenantId;
        const claimId = (ctx.params['claimId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (claimId === '' || !isDate(b['sentOn'])) {
          throw apiError(400, {
            code: 'not_readable_as_a_claim_sent',
            whatHappened: 'Recording a claim as sent needs the claimId in the path and { approvalId (Finance\'s approval of this claim), sentOn (YYYY-MM-DD) } in the body.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send Finance\'s approval number and the day it was sent. Nothing was recorded.',
          });
        }
        const schemeId = await schemeOfClaim(t, claimId);
        const expectedVersion = await deps.claimsVersion(t, schemeId);
        const f = await schemeFacts(t, schemeId);
        const claim = claimOr404(f.views, claimId);
        const judged = judgeSend({ claim, accruedMinor: f.accruedMinor, receivedMinor: f.receivedMinor, schemeClaims: f.schemeClaims });
        if (!judged.ok) throw refuse(judged, judged.code === 'claim_withdrawn' ? 'Raise a new claim if money is still owed. Nothing was recorded.' : 'Withdraw this claim and raise one for what is still owed. Nothing was recorded.');
        if (judged.alreadySent) return { status: 200, body: { claim, alreadySent: true } };
        // R16-A: the day the claim was raised is the SHOP's date of its moment — a claim raised at 01:00 in the shop (19:30
        // UTC the day before) may be sent that same shop day; before round 16 the UTC date let it be "sent" the day before.
        const raisedOn = (await shopDateOfFor(t))(claim.raisedAt);
        if ((b['sentOn'] as string) < raisedOn || (b['sentOn'] as string) > f.today) {
          throw apiError(422, {
            code: 'sent_on_outside_the_claim',
            whatHappened: `A claim raised on ${raisedOn} cannot be sent on ${b['sentOn']} (before it was raised, or after today, ${f.today}).`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the day it actually went to the supplier. Nothing was recorded.',
          });
        }
        const ask = rebateClaimApprovalAsk(claim);
        const opened = await approvalNamedIn(deps.approvals, {
          tenantId: t, approvalId: b['approvalId'], typedField: 'approvedBy', typedValue: b['approvedBy'],
          kind: ask.kind, subjectRef: ask.subjectRef, details: ask.details, valueMinor: ask.valueMinor,
          maker: ctx.userId, usedBy: `rebate-claim:${claimId}`, now: deps.now(),
        });
        if (opened === undefined) {
          throw apiError(422, {
            code: 'claim_needs_finance_approval',
            whatHappened: `Claim ${claimId} is sent only once Finance has approved it (§28 "Finance approves rebate claims").`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Ask for approval (POST /v1/approvals/requests, kind rebate_claim, with the claim\'s approvalAsk); once a different person with Finance\'s authority approves it, send its approvalId. Nothing was recorded.',
          });
        }
        if (opened.decision.decidedBy === claim.raisedBy) {
          throw apiError(422, {
            code: 'raiser_cannot_approve_claim',
            whatHappened: `${claim.raisedBy} raised claim ${claimId} and cannot also be the one who approves it (§28).`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Ask a different person with Finance\'s authority to approve it. Nothing was recorded, and the approval was not used.',
          });
        }
        await opened.spend();
        const at = deps.now();
        await write(t, schemeId, { type: 'sent', claimId, approvalId: (b['approvalId'] as string).trim(), approvedBy: opened.decision.decidedBy, sentBy: ctx.userId, sentOn: b['sentOn'] as string, sentAt: at }, expectedVersion);
        await audit(t, {
          actorId: ctx.userId, action: 'rebate_claim.send', objectId: claimId, at,
          before: { state: claim.state }, after: { state: 'sent', sentOn: b['sentOn'] as string, approvedBy: opened.decision.decidedBy },
          approvalId: (b['approvalId'] as string).trim(), correlationId: claimId, branchId: ctx.branchId ?? null,
        });
        const sent = claimView({ ...claim, sent: { approvalId: (b['approvalId'] as string).trim(), approvedBy: opened.decision.decidedBy, sentBy: ctx.userId, sentOn: b['sentOn'] as string, sentAt: at } }, { today: f.today, answerDays: f.days });
        return { status: 201, body: { claim: sent, alreadySent: false } };
      },
    },
    {
      // WITHDRAW a claim (a compensating fact): what is still unanswered may be claimed again. Body: { reason }.
      api: 'API-03', method: 'POST', path: '/v1/purchase/rebate-claims/:claimId/withdraw',
      permission: 'purchase.contract.manage', idempotent: true,
      handler: async (ctx) => {
        const t = ctx.tenantId;
        const claimId = (ctx.params['claimId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (claimId === '' || !isStr(b['reason'])) {
          throw apiError(400, { code: 'withdrawal_needs_a_reason', whatHappened: 'Withdrawing a claim needs { reason } — why it is no longer asked for.', wasItSaved: 'not_saved', nextSafeAction: 'Say why. Nothing was changed.' });
        }
        const schemeId = await schemeOfClaim(t, claimId);
        const expectedVersion = await deps.claimsVersion(t, schemeId);
        const f = await schemeFacts(t, schemeId);
        const claim = claimOr404(f.views, claimId);
        const judged = judgeWithdraw(claim);
        if (!judged.ok) throw refuse(judged, 'Nothing was changed.');
        if (judged.alreadyWithdrawn) return { status: 200, body: { claim, alreadyWithdrawn: true } };
        const at = deps.now();
        const reason = (b['reason'] as string).trim().slice(0, 300);
        await write(t, schemeId, { type: 'withdrawn', claimId, reason, withdrawnBy: ctx.userId, withdrawnAt: at }, expectedVersion);
        await audit(t, {
          actorId: ctx.userId, action: 'rebate_claim.withdraw', objectId: claimId, at, before: { state: claim.state, unansweredMinor: String(claim.unansweredMinor) },
          after: { state: 'withdrawn', releasedMinor: String(claim.unansweredMinor) }, reason, correlationId: claimId, branchId: ctx.branchId ?? null,
        });
        const withdrawn = claimView({ ...claim, withdrawn: { reason, withdrawnBy: ctx.userId, withdrawnAt: at } }, { today: f.today, answerDays: f.days });
        return { status: 201, body: { claim: withdrawn, alreadyWithdrawn: false } };
      },
    },
    {
      // MATCH a receipt finance's ledger holds to a sent claim. Body: { amountMinor? } (default: as much as both have left).
      api: 'API-03', method: 'POST', path: '/v1/purchase/rebate-claims/:claimId/matches/:receiptId',
      permission: 'finance.journal.post', idempotent: true,
      handler: async (ctx) => {
        const t = ctx.tenantId;
        const claimId = (ctx.params['claimId'] ?? '').trim();
        const receiptId = (ctx.params['receiptId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (claimId === '' || receiptId === '' || (b['amountMinor'] !== undefined && !isPosInt(b['amountMinor']))) {
          throw apiError(400, { code: 'not_readable_as_a_claim_match', whatHappened: 'A match needs the claimId and receiptId in the path, and optionally { amountMinor (whole paise, more than 0) }.', wasItSaved: 'not_saved', nextSafeAction: 'Send the receipt to match. Nothing was matched.' });
        }
        const schemeId = await schemeOfClaim(t, claimId);
        const expectedVersion = await deps.claimsVersion(t, schemeId);
        const f = await schemeFacts(t, schemeId);
        const claim = claimOr404(f.views, claimId);
        const receipt = f.receipts.find((r) => r.schemeId === schemeId && r.receiptId === receiptId);
        const judged = judgeMatch({
          claim, receipt, receiptId, amountMinor: b['amountMinor'] as number | undefined,
          matchedOfReceiptMinor: matchedOfReceipts([...f.claims.values()]).get(`${schemeId}\u0000${receiptId}`) ?? 0,
        });
        if (!judged.ok) throw refuse(judged, judged.code === 'receipt_not_on_this_scheme' ? 'Record the money first (POST /v1/finance/rebate-receipts/:schemeId/receipts/:receiptId), then match it. Nothing was matched.' : 'Nothing was matched.');
        if (judged.alreadyMatched) return { status: 200, body: { claim, alreadyMatched: true } };
        const at = deps.now();
        await write(t, schemeId, { type: 'matched', claimId, receiptId, amountMinor: judged.amountMinor, matchedBy: ctx.userId, matchedAt: at }, expectedVersion);
        await audit(t, {
          actorId: ctx.userId, action: 'rebate_claim.match', objectId: claimId, at, before: { unansweredMinor: String(claim.unansweredMinor) },
          after: { receiptId, matchedMinor: String(judged.amountMinor), unansweredMinor: String(claim.unansweredMinor - judged.amountMinor) }, correlationId: claimId, branchId: ctx.branchId ?? null,
        });
        const matched = claimView({ ...claim, matches: [...claim.matches, { receiptId, amountMinor: judged.amountMinor, matchedBy: ctx.userId, matchedAt: at }] }, { today: f.today, answerDays: f.days });
        return { status: 201, body: { claim: matched, alreadyMatched: false } };
      },
    },
    {
      // The OWNER's answer period — how many days a supplier has to answer a sent claim. Body: { days } or { clear: true, reason }.
      api: 'API-03', method: 'POST', path: '/v1/purchase/rebate-claims/answer-period',
      permission: 'purchase.rebate.terms.set', idempotent: true,
      handler: async (ctx) => {
        const t = ctx.tenantId;
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const at = deps.now();
        let setting: RebateAnswerPeriodSetting;
        if (b['clear'] === true) {
          if (!isStr(b['reason'])) throw apiError(400, { code: 'clear_needs_a_reason', whatHappened: 'Clearing the answer period stops every claim showing overdue; say why.', wasItSaved: 'not_saved', nextSafeAction: 'Send { clear: true, reason }. Nothing was changed.' });
          setting = { days: null, setBy: ctx.userId, setAt: at, reason: (b['reason'] as string).trim().slice(0, 300) };
        } else {
          if (!isPosInt(b['days'])) throw apiError(400, { code: 'not_readable_as_an_answer_period', whatHappened: 'The answer period is { days } — a whole number of days, more than 0, that a supplier has to answer a sent claim.', wasItSaved: 'not_saved', nextSafeAction: 'Send the number of days. Nothing was changed.' });
          setting = { days: b['days'] as number, setBy: ctx.userId, setAt: at };
        }
        const { latest } = await answerDaysOf(t);
        await deps.recordAnswerPeriod(t, setting);
        await deps.recordAudit?.(t, {
          actorId: ctx.userId, action: setting.days === null ? 'rebate_claim.answer_period.clear' : 'rebate_claim.answer_period.set', objectType: 'rebate_claim_answer_period', objectId: 'answer-period', at,
          origin: { tenantId: t, branchId: null }, before: latest === undefined || latest.days === null ? null : { days: String(latest.days) },
          after: { days: setting.days === null ? 'not set' : String(setting.days) }, ...(setting.reason === undefined ? {} : { reason: setting.reason }), correlationId: 'answer-period',
        });
        return { status: 201, body: { answerPeriod: setting.days === null ? { state: 'not_set', days: null, say: ANSWER_PERIOD_NOT_SET } : { state: 'set', days: setting.days }, setBy: ctx.userId, setAt: at } };
      },
    },
    {
      // THE REGISTER — per scheme: earned, received, outstanding, claimable, accruals, receipts; every claim with its state,
      // due day and overdue; receipts matched to no claim; the owner's answer period ("not set" until he sets it).
      api: 'API-03', method: 'GET', path: '/v1/purchase/rebate-claims',
      permission: 'purchase.commitment.read',
      handler: async (ctx) => {
        const t = ctx.tenantId;
        const [schemes, facts, receipts, { days, latest }, today] = await Promise.all([deps.schemes(t), deps.claimFacts(t), deps.receipts(t), answerDaysOf(t), shopToday(deps, t)]);
        const claims = [...foldRebateClaims(facts).values()];
        const views = claims.map((c) => claimView(c, { today, answerDays: days }));
        const matched = matchedOfReceipts(claims);
        const lines = [];
        for (const s of schemes) {
          const accruals = await deps.accruals(t, s.schemeId);
          const mineReceipts = receipts.filter((r) => r.schemeId === s.schemeId);
          const accruedMinor = accruals.reduce((x, a) => x + a.accrued.minor, 0);
          const receivedMinor = mineReceipts.reduce((x, r) => x + r.amountMinor, 0);
          const room = claimableFor({ accruedMinor, receivedMinor, claims: views.filter((v) => v.schemeId === s.schemeId) });
          const findings: string[] = [];
          if (s.approvedBy === undefined) findings.push('scheme_not_approved');
          if (room.overClaimedMinor > 0) findings.push('claims_exceed_outstanding');
          if (room.claimableMinor > 0) findings.push('earned_not_claimed');
          lines.push({
            schemeId: s.schemeId, supplierId: s.supplierId, basis: s.basis, rateBp: s.rateBp, startsOn: s.startsOn, endsOn: s.endsOn, approved: s.approvedBy !== undefined,
            accruedMinor, receivedMinor, ...room, findings,
            accruals: accruals.map((a) => ({ accrualId: a.accrualId ?? null, periodFrom: a.periodFrom ?? null, periodTo: a.periodTo ?? null, accruedMinor: a.accrued.minor, thresholdMet: a.thresholdMet })),
            receipts: mineReceipts.map((r) => ({ ...r, matchedMinor: matched.get(`${s.schemeId}\u0000${r.receiptId}`) ?? 0 })),
          });
        }
        const claimRows = views
          .sort((a, b) => b.raisedAt.localeCompare(a.raisedAt) || a.claimId.localeCompare(b.claimId))
          .map((v) => {
            const findings: string[] = [];
            if (v.overdue === true) findings.push('overdue');
            if (v.overdue === 'not_set') findings.push('answer_period_not_set');
            if (v.state === 'raised') findings.push('waiting_for_finance');
            return { ...v, findings, ...(v.state === 'raised' ? { approvalAsk: rebateClaimApprovalAsk(v) } : {}) };
          });
        return {
          status: 200,
          body: {
            answerPeriod: days === null
              ? { state: 'not_set', days: null, say: ANSWER_PERIOD_NOT_SET, ...(latest === undefined ? {} : { clearedBy: latest.setBy, clearedAt: latest.setAt }) }
              : { state: 'set', days, setBy: latest!.setBy, setAt: latest!.setAt },
            schemes: lines, claims: claimRows,
            unmatchedReceipts: unmatchedReceipts(receipts, claims),
            receivedFrom: 'finance_ledger',
            counts: {
              claims: claimRows.length, waitingForFinance: claimRows.filter((c) => c.state === 'raised').length,
              overdue: claimRows.filter((c) => c.overdue === true).length, overdueNotKnown: claimRows.filter((c) => c.overdue === 'not_set').length,
            },
            today, asAt: deps.now(),
          },
        };
      },
    },
    {
      // The claim DOCUMENT, to print and send (status "draft_not_approved" until Finance's approval is spent on it).
      api: 'API-03', method: 'GET', path: '/v1/purchase/rebate-claims/:claimId/document',
      permission: 'purchase.commitment.read',
      handler: async (ctx) => {
        const t = ctx.tenantId;
        const claimId = (ctx.params['claimId'] ?? '').trim();
        const schemeId = await schemeOfClaim(t, claimId);
        const f = await schemeFacts(t, schemeId);
        const v = claimOr404(f.views, claimId);
        const scheme = (await deps.schemes(t)).find((s) => s.schemeId === schemeId);
        return { status: 200, body: { document: await documentOf(t, v, scheme, f.accruals), printable: v.sent !== undefined, asAt: deps.now() } };
      },
    },
  ];
}

/** One sent claim as the supplier's portal shows it — the document, never who approved it inside the shop. */
export interface SupplierRebateClaim {
  readonly partnerId: string;
  readonly claimId: string;
  readonly schemeId: string;
  readonly amountMinor: number;
  readonly sentOn: string;
  readonly answerDueOn: string | null;
  readonly paidMinor: number;
  readonly leftToPayMinor: number;
  readonly state: RebateClaimView['state'];
  readonly words: string;
}

/** A supplier's OWN sent claims (raised-but-not-approved claims are never shown outside the shop). */
export async function supplierRebateClaims(deps: Pick<RebateClaimDeps, 'claimFacts' | 'answerPeriods' | 'calendar' | 'now'>, tenantId: string, partnerId: string): Promise<readonly SupplierRebateClaim[]> {
  const [facts, periods, today] = await Promise.all([deps.claimFacts(tenantId), deps.answerPeriods(tenantId), shopToday(deps, tenantId)]);
  const answerDays = periods.at(-1)?.days ?? null;
  return [...foldRebateClaims(facts).values()]
    .filter((c) => c.supplierId === partnerId && c.sent !== undefined)
    .map((c) => claimView(c, { today, answerDays }))
    .map((v) => ({
      partnerId, claimId: v.claimId, schemeId: v.schemeId, amountMinor: v.amountMinor, sentOn: v.sent!.sentOn, answerDueOn: v.dueOn,
      paidMinor: v.matchedMinor, leftToPayMinor: v.unansweredMinor, state: v.state,
      words: `Please pay ₹${(v.amountMinor / 100).toFixed(2)} as the rebate earned under scheme ${v.schemeId}, quoting claim ${v.claimId}.`,
    }))
    .sort((a, b) => b.sentOn.localeCompare(a.sentOn) || a.claimId.localeCompare(b.claimId));
}
