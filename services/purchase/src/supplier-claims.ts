// API-03 Supplier claims — ONE register for everything claimed between the shop and a supplier over a delivery
// (U6 of the UI/UX gap audit, §27 "Purchase — claims": judged PARTIAL because the claims were spread over the goods
// receipt page and the rebates page; M07-FR-03 "supplier claim raised where due"; M24-FR-02 "a supplier raises claims").
//
// Nothing here is a second record. The shop's claims AGAINST a supplier are read from the supplier ACCOUNT fold
// (supplier-account.ts): a debit note a second person's disposition raised (short or damaged goods returned or claimed,
// valued at the delivered cost), the goods refused at the dock and never owed, a return still to go back, and the
// numbered debit notes raised at the DSD door. A supplier's claims ON the shop are the `claim` submissions it sent through
// the portal, each with the buyer's decision beside it. The register lays both sides out with their states, so the person
// who settles claims sees every one in one place — and acts through the routes that already exist (issue the debit note:
// supplier-master.ts; decide a supplier's claim: supplier-portal.ts review).
//
// Round U7 adds two governed steps after a buyer's decision on a supplier's claim:
//   • OB-724 (owner, 13 Nov 2026, in writing: B) — an ACCEPTED claim with a value is a DRAFT credit note to the supplier. It is
//     read, never stored: the accepted claim IS the draft. It moves no money until the ACCOUNTANT approves it — a second
//     person, never the buyer who accepted the claim nor whoever sent it — and only then is it a fact
//     (`SupplierClaimCreditDecided`, approved) the supplier account counts (what the shop owes rises) and the payables run
//     posts through the accountant's own rule. A refused draft is kept with its reason and counts for nothing.
//   • M24-FR-02 alt flow ("disputed claim becomes an exception") — a REJECTED claim is an exception with its value, owned by
//     the buyer who rejected it, open until a person resolves it with an outcome and a reason
//     (`SupplierClaimDisputeResolved`); open after the shop day it was raised on, it reads OVERDUE (P-08). Both facts are
//     append-only (hard rule #2); a decision is never edited or replaced.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { shopClock, type ShopCalendarOf } from '../../../packages/calendar/src/shop-clock';
import { tradingDayIn } from '../../../packages/calendar/src/trading-day';
import type { SupplierClaimCredit } from './supplier-account';
import { accountRegisters, foldAllSupplierAccounts, foldSupplierAccount, type SupplierAccountDeps, type SupplierAccountStatement } from './supplier-account';
import type { SubmissionRecord, SubmissionReview, SupplierClaimAgainst } from './supplier-portal';

export interface SupplierClaimsDeps {
  readonly account: SupplierAccountDeps;
  /** Every supplier the portal has met, and what each sent and how the buyer decided (M24-FR-02). Optional: no portal, no supplier-raised claims. */
  readonly partners?: (tenantId: string) => Promise<readonly string[]>;
  readonly submissions?: (tenantId: string, partnerId: string) => Promise<readonly SubmissionRecord[]> | readonly SubmissionRecord[];
  readonly reviews?: (tenantId: string, partnerId: string) => Promise<readonly SubmissionReview[]> | readonly SubmissionReview[];
  /** The supplier's name on the master, for the register's rows. */
  readonly supplierName?: (tenantId: string, supplierId: string) => Promise<string | undefined> | string | undefined;
  /** OB-724 — the accountant's decisions on draft credits (append-only; the first per credit stands). Optional: none yet. */
  readonly creditDecisions?: (tenantId: string) => Promise<readonly ClaimCreditDecision[]> | readonly ClaimCreditDecision[];
  readonly recordCreditDecision?: (tenantId: string, d: ClaimCreditDecision) => Promise<void> | void;
  /** M24-FR-02 alt — how each disputed (rejected) claim was settled (append-only; the first per claim stands). */
  readonly disputeResolutions?: (tenantId: string) => Promise<readonly ClaimDisputeResolution[]> | readonly ClaimDisputeResolution[];
  readonly recordDisputeResolution?: (tenantId: string, r: ClaimDisputeResolution) => Promise<void> | void;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  /** The shop's calendar — "raised on" and "overdue" are the shop's trading day, never the UTC date. */
  readonly calendar?: ShopCalendarOf;
  readonly now: () => string;
}

/** OB-724 — the accountant's decision on one draft credit: approved (a fact the account counts) or refused (counts nothing). */
export interface ClaimCreditDecision {
  readonly creditId: string;
  readonly supplierId: string;
  readonly submissionId: string;
  readonly decision: 'approved' | 'refused';
  readonly amountMinor: number;
  readonly why: string;
  readonly acceptedBy: string;
  readonly decidedBy: string;
  readonly decidedAt: string;
  readonly reason: string;
}

/** A draft credit as the register reads it: an accepted claim with a value, and where the accountant's decision stands. */
export interface ClaimCreditDraft {
  readonly creditId: string;
  readonly supplierId: string;
  readonly submissionId: string;
  readonly amountMinor: number;
  readonly why: string;
  readonly acceptedBy: string;
  readonly acceptedAt: string;
  readonly submittedBy: string | null;
  readonly state: 'draft' | 'approved' | 'refused';
  readonly decision: ClaimCreditDecision | null;
}

export const DISPUTE_OUTCOMES = ['supplier_withdrew', 'shop_position_upheld', 'agreed_another_way', 'other'] as const;
export type DisputeOutcome = (typeof DISPUTE_OUTCOMES)[number];

/** M24-FR-02 alt — how a disputed claim was settled, by whom, why. */
export interface ClaimDisputeResolution {
  readonly exceptionId: string;
  readonly supplierId: string;
  readonly submissionId: string;
  readonly outcome: DisputeOutcome;
  readonly reason: string;
  readonly by: string;
  readonly at: string;
}

/** A disputed (rejected) claim as an exception: its value, who owns it, the shop day it was raised on, its state. */
export interface ClaimDispute {
  readonly exceptionId: string;
  readonly supplierId: string;
  readonly submissionId: string;
  /** The claim's value as the supplier put it; null when it named none (said, never 0). */
  readonly valueMinor: number | null;
  readonly why: string;
  /** The buyer's reason for rejecting it — the dispute itself. */
  readonly rejectedBecause: string;
  readonly ownerUserId: string;
  readonly raisedAt: string;
  readonly raisedOn: string;
  readonly state: 'open' | 'resolved';
  readonly overdue: boolean;
  readonly resolution: ClaimDisputeResolution | null;
}

export const creditIdOf = (submissionId: string): string => `SCC-${submissionId}`;
export const disputeIdOf = (submissionId: string): string => `DSP-${submissionId}`;

/** The first decision per credit stands (append-only). Pure. */
const firstBy = <T>(xs: readonly T[], key: (x: T) => string): Map<string, T> => {
  const m = new Map<string, T>();
  for (const x of xs) if (!m.has(key(x))) m.set(key(x), x);
  return m;
};

/** OB-724 — every accepted claim with a value, as a draft credit with the accountant's decision beside it. Pure. */
export function creditDrafts(claims: readonly SupplierRaisedClaim[], decisions: readonly ClaimCreditDecision[]): readonly ClaimCreditDraft[] {
  const byCredit = firstBy(decisions, (d) => d.creditId);
  return claims
    .filter((c) => c.state === 'accepted' && c.claimMinor !== null && c.claimMinor > 0 && c.decidedBy !== null)
    .map((c) => {
      const creditId = creditIdOf(c.submissionId);
      const decision = byCredit.get(creditId) ?? null;
      return {
        creditId, supplierId: c.supplierId, submissionId: c.submissionId, amountMinor: c.claimMinor!, why: c.why,
        acceptedBy: c.decidedBy!, acceptedAt: c.decidedAt ?? c.receivedAt, submittedBy: c.submittedBy,
        state: decision === null ? 'draft' : decision.decision, decision,
      };
    });
}

/** The approved decisions as the facts the supplier account counts. Pure. */
export function approvedClaimCredits(decisions: readonly ClaimCreditDecision[]): readonly SupplierClaimCredit[] {
  return [...firstBy(decisions, (d) => d.creditId).values()].filter((d) => d.decision === 'approved').map((d) => ({
    creditId: d.creditId, supplierId: d.supplierId, submissionId: d.submissionId, amountMinor: d.amountMinor, currency: 'INR' as const,
    why: d.why, acceptedBy: d.acceptedBy, approvedBy: d.decidedBy, approvedAt: d.decidedAt, reason: d.reason,
  }));
}

/** M24-FR-02 alt — every rejected claim as an exception, open until resolved, overdue after the shop day it was raised on. Pure. */
export function claimDisputes(
  claims: readonly SupplierRaisedClaim[], resolutions: readonly ClaimDisputeResolution[], dayOf: (iso: string) => string, today: string,
): readonly ClaimDispute[] {
  const byId = firstBy(resolutions, (r) => r.exceptionId);
  return claims.filter((c) => c.state === 'rejected' && c.decidedBy !== null).map((c) => {
    const exceptionId = disputeIdOf(c.submissionId);
    const resolution = byId.get(exceptionId) ?? null;
    const raisedAt = c.decidedAt ?? c.receivedAt;
    const raisedOn = dayOf(raisedAt);
    return {
      exceptionId, supplierId: c.supplierId, submissionId: c.submissionId, valueMinor: c.claimMinor, why: c.why,
      rejectedBecause: c.reason ?? '', ownerUserId: c.decidedBy!, raisedAt, raisedOn,
      state: resolution === null ? 'open' : 'resolved', overdue: resolution === null && today > raisedOn, resolution,
    };
  });
}

/** The shop's claims AGAINST one supplier, read from its account fold. Pure. */
export function claimsAgainstSupplier(a: SupplierAccountStatement): readonly SupplierClaimAgainst[] {
  const partnerId = a.supplierId;
  const notes = a.debitNotes.map((d): SupplierClaimAgainst => ({
    partnerId, claimId: d.debitNoteRef, kind: 'debit_note', grnId: d.grnId, poId: d.poId, productId: d.productId, quantityMinor: d.quantityMinor,
    valueMinor: d.valueMinor, reason: `${d.disposition}: ${d.reason}`, raisedAt: d.decidedAt, number: d.number, state: d.number === null ? 'raised' : 'issued',
  }));
  const refused = a.refusedNotOwed.map((r): SupplierClaimAgainst => ({
    partnerId, claimId: `refused-${r.grnId}-${r.lineId}`, kind: 'refused_at_door', grnId: r.grnId, poId: r.poId, productId: r.productId, quantityMinor: r.quantityMinor,
    valueMinor: r.valueMinor, reason: `${r.disposition}: refused at the dock, never received against the order, so never owed`, raisedAt: a.asAt, number: null, state: 'never_owed',
  }));
  const returns = a.pendingLineReturns.map((r): SupplierClaimAgainst => ({
    partnerId, claimId: `return-${r.grnId}-${r.lineId}`, kind: 'return_pending', grnId: r.grnId, poId: r.poId, productId: r.productId, quantityMinor: r.quantityMinor,
    valueMinor: r.valueMinor, reason: `goods to go back to the supplier (debit note ${r.debitNoteRef})`, raisedAt: r.decidedAt, number: null, state: r.returned ? 'returned' : 'pending',
  }));
  const door = a.doorDebitNotes.map((d): SupplierClaimAgainst => ({
    partnerId, claimId: d.debitNoteRef, kind: 'door_debit_note', grnId: d.checkInId, poId: null, productId: d.lines.length === 1 ? d.lines[0]!.productId : null,
    quantityMinor: d.lines.length === 1 ? d.lines[0]!.quantityMinor : null, valueMinor: d.valueMinor,
    reason: d.lines.map((l) => `${l.productId}: ${l.reason}`).join('; '), raisedAt: d.raisedAt, number: d.number, state: d.number === null ? 'raised' : 'issued',
  }));
  return [...notes, ...refused, ...returns, ...door];
}

/** A supplier's claim ON the shop, as the register reads a `claim` submission with the buyer's decision beside it. */
export interface SupplierRaisedClaim {
  readonly supplierId: string;
  readonly submissionId: string;
  readonly poId: string | null;
  readonly claimMinor: number | null;
  readonly why: string;
  readonly receivedAt: string;
  readonly submittedBy: string | null;
  readonly state: 'awaiting_buyer' | 'accepted' | 'rejected';
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly reason: string | null;
}

export function supplierRaisedClaim(partnerId: string, s: SubmissionRecord, review: SubmissionReview | undefined): SupplierRaisedClaim {
  const d = s.document ?? {};
  return {
    supplierId: partnerId, submissionId: s.submissionId, poId: typeof d['poId'] === 'string' ? d['poId'] : null,
    claimMinor: typeof d['claimMinor'] === 'number' ? d['claimMinor'] : null, why: typeof d['why'] === 'string' ? d['why'] : '',
    receivedAt: s.receivedAt, submittedBy: s.submittedBy ?? null,
    state: review === undefined ? 'awaiting_buyer' : review.decision, decidedBy: review?.reviewedBy ?? null, decidedAt: review?.reviewedAt ?? null, reason: review?.reason ?? null,
  };
}

/** The claims the shop holds against one supplier (for the portal's `/me/claims`). */
export async function claimsAgainst(deps: SupplierAccountDeps, tenantId: string, supplierId: string): Promise<readonly SupplierClaimAgainst[]> {
  return claimsAgainstSupplier(foldSupplierAccount({ ...(await accountRegisters(deps, tenantId)), supplierId }));
}

export function supplierClaimsRoutes(deps: SupplierClaimsDeps): readonly Route[] {
  const dayOfIn = async (t: string): Promise<(iso: string) => string> => {
    const cal = await shopClock(deps.calendar).calendar(t);
    return (iso: string) => tradingDayIn(iso, cal);
  };
  const raisedClaims = async (t: string): Promise<readonly SupplierRaisedClaim[]> => {
    const out: SupplierRaisedClaim[] = [];
    if (deps.partners === undefined || deps.submissions === undefined) return out;
    for (const partnerId of await deps.partners(t)) {
      const reviews = (await deps.reviews?.(t, partnerId)) ?? [];
      for (const s of await deps.submissions(t, partnerId)) {
        if (s.kind !== 'claim') continue;
        out.push(supplierRaisedClaim(partnerId, s, reviews.find((r) => r.submissionId === s.submissionId)));
      }
    }
    return out;
  };
  const isStr = (x: unknown): x is string => typeof x === 'string' && x.trim() !== '';
  return [
    {
      // The one register (U6 · M07-FR-03 · M24-FR-02): every claim between the shop and its suppliers, both sides, with the
      // state each is in and the counts — read from the account fold and the portal's submissions, never kept twice.
      api: 'API-03', method: 'GET', path: '/v1/purchase/supplier-claims',
      permission: 'purchase.commitment.read',
      handler: async (ctx) => {
        const t = ctx.tenantId;
        const folded = foldAllSupplierAccounts(await accountRegisters(deps.account, t));
        const shopClaims = folded.accounts.flatMap((a) => claimsAgainstSupplier(a));
        const supplierClaims: SupplierRaisedClaim[] = [...(await raisedClaims(t))];
        const dayOf = await dayOfIn(t);
        const drafts = creditDrafts(supplierClaims, (await deps.creditDecisions?.(t)) ?? []);
        const disputes = claimDisputes(supplierClaims, (await deps.disputeResolutions?.(t)) ?? [], dayOf, dayOf(deps.now()));
        const names: Record<string, string> = {};
        if (deps.supplierName !== undefined) {
          for (const id of new Set([...shopClaims.map((c) => c.partnerId), ...supplierClaims.map((c) => c.supplierId)])) {
            const name = await deps.supplierName(t, id);
            if (name !== undefined) names[id] = name;
          }
        }
        const counts = {
          raised: shopClaims.filter((c) => c.state === 'raised').length,
          issued: shopClaims.filter((c) => c.state === 'issued').length,
          neverOwed: shopClaims.filter((c) => c.state === 'never_owed').length,
          returnPending: shopClaims.filter((c) => c.state === 'pending').length,
          returned: shopClaims.filter((c) => c.state === 'returned').length,
          awaitingBuyer: supplierClaims.filter((c) => c.state === 'awaiting_buyer').length,
          accepted: supplierClaims.filter((c) => c.state === 'accepted').length,
          rejected: supplierClaims.filter((c) => c.state === 'rejected').length,
          // OB-724 · M24-FR-02 alt
          creditDrafts: drafts.filter((d) => d.state === 'draft').length,
          creditsApproved: drafts.filter((d) => d.state === 'approved').length,
          creditsRefused: drafts.filter((d) => d.state === 'refused').length,
          openDisputes: disputes.filter((d) => d.state === 'open').length,
          overdueDisputes: disputes.filter((d) => d.overdue).length,
        };
        return {
          status: 200,
          body: {
            shopClaims: shopClaims.map(({ partnerId, ...c }) => ({ supplierId: partnerId, ...c })).sort((a, b) => (a.raisedAt < b.raisedAt ? 1 : -1)),
            supplierClaims: supplierClaims.sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1)),
            creditDrafts: [...drafts].sort((a, b) => (a.acceptedAt < b.acceptedAt ? 1 : -1)),
            disputes: [...disputes].sort((a, b) => (a.raisedAt < b.raisedAt ? 1 : -1)),
            counts, supplierNames: names, unattributed: folded.unattributed, asAt: deps.now(),
          },
        };
      },
    },
    {
      // OB-724 — the ACCOUNTANT decides a draft credit: { decision: 'approve' | 'refuse', reason }. Approved, it is a fact the
      // supplier account counts (the shop owes more) and the payables run posts; refused, it is kept with its reason and
      // counts for nothing. Never the buyer who accepted the claim, never whoever sent it (§28). Once per credit: the same
      // decision again is 200 (a retry), a different one 409 — a second decision would be a second truth.
      api: 'API-03', method: 'POST', path: '/v1/purchase/supplier-claims/credits/:supplierId/:submissionId',
      permission: 'purchase.supplier.pay', idempotent: true,
      handler: async (ctx) => {
        const t = ctx.tenantId;
        const supplierId = (ctx.params['supplierId'] ?? '').trim();
        const submissionId = (ctx.params['submissionId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const decision = b['decision'] === 'approve' ? 'approved' : b['decision'] === 'refuse' ? 'refused' : undefined;
        if (decision === undefined || !isStr(b['reason'])) {
          throw apiError(400, {
            code: 'not_readable_as_a_credit_decision',
            whatHappened: 'Deciding a draft credit needs { decision: "approve" | "refuse", reason } — why, in words.',
            wasItSaved: 'not_saved', nextSafeAction: 'Choose approve or refuse and say why. Nothing was decided.',
          });
        }
        if (deps.recordCreditDecision === undefined) {
          throw apiError(503, { code: 'credit_register_unavailable', whatHappened: 'The supplier-claim credit register is not wired here.', wasItSaved: 'not_saved', nextSafeAction: 'Try again later. Nothing was decided.' });
        }
        const claim = (await raisedClaims(t)).find((c) => c.supplierId === supplierId && c.submissionId === submissionId);
        if (claim === undefined) throw notFound(`claim ${submissionId} from supplier ${supplierId}`);
        const draft = creditDrafts([claim], [])[0];
        if (draft === undefined) {
          throw apiError(409, {
            code: 'not_a_draft_credit',
            whatHappened: claim.state !== 'accepted'
              ? `Claim ${submissionId} is ${claim.state === 'rejected' ? 'rejected — it is a disputed claim, not a credit' : 'still waiting for a buyer to accept or reject it'}.`
              : `Claim ${submissionId} names no amount, so there is no credit to approve.`,
            wasItSaved: 'not_saved',
            nextSafeAction: claim.state === 'awaiting_buyer' ? 'A buyer decides the claim first on the Supplier claims page. Nothing was decided.' : 'Nothing to decide here. Nothing was decided.',
          });
        }
        const prior = ((await deps.creditDecisions?.(t)) ?? []).find((d) => d.creditId === draft.creditId);
        if (prior !== undefined) {
          if (prior.decision === decision) return { status: 200, body: { decision: prior, alreadyDecided: true } };
          throw apiError(409, {
            code: 'credit_already_decided',
            whatHappened: `${prior.decidedBy} already ${prior.decision} credit ${draft.creditId} at ${prior.decidedAt}; a second decision would be a second truth.`,
            wasItSaved: 'not_saved', nextSafeAction: 'Read the decision on the Supplier claims page. Nothing was changed.',
          });
        }
        if (ctx.userId === draft.acceptedBy || ctx.userId === draft.submittedBy) {
          throw apiError(403, {
            code: 'same_person',
            whatHappened: ctx.userId === draft.acceptedBy
              ? `${ctx.userId} accepted claim ${submissionId}, so cannot also approve the credit it creates (§28: a second person).`
              : `${ctx.userId} sent claim ${submissionId}, so cannot decide the credit it creates.`,
            wasItSaved: 'not_saved', nextSafeAction: 'The accountant — someone who did not accept the claim — decides the credit. Nothing was decided.',
          });
        }
        const at = deps.now();
        const d: ClaimCreditDecision = {
          creditId: draft.creditId, supplierId, submissionId, decision, amountMinor: draft.amountMinor, why: draft.why,
          acceptedBy: draft.acceptedBy, decidedBy: ctx.userId, decidedAt: at, reason: (b['reason'] as string).trim().slice(0, 300),
        };
        await deps.recordCreditDecision(t, d);
        await deps.recordAudit?.(t, {
          actorId: ctx.userId, action: decision === 'approved' ? 'purchase.supplier_claim.credit.approve' : 'purchase.supplier_claim.credit.refuse',
          objectType: 'supplier_claim_credit', objectId: draft.creditId, at, origin: { tenantId: t, branchId: ctx.branchId ?? null },
          before: { state: 'draft' }, after: { state: decision, supplierId, amountMinor: String(draft.amountMinor), acceptedBy: draft.acceptedBy },
          reason: d.reason, correlationId: draft.creditId,
        });
        return { status: 201, body: { decision: d, alreadyDecided: false } };
      },
    },
    {
      // M24-FR-02 alt — settle a disputed claim: { outcome, reason }. The exception closes; the claim and the buyer's
      // rejection stay as they were (hard rule #2). Once per dispute: the same outcome again is 200, a different one 409.
      api: 'API-03', method: 'POST', path: '/v1/purchase/supplier-claims/disputes/:supplierId/:submissionId/resolve',
      permission: 'supplier.portal.review', idempotent: true,
      handler: async (ctx) => {
        const t = ctx.tenantId;
        const supplierId = (ctx.params['supplierId'] ?? '').trim();
        const submissionId = (ctx.params['submissionId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!(DISPUTE_OUTCOMES as readonly unknown[]).includes(b['outcome']) || !isStr(b['reason'])) {
          throw apiError(400, {
            code: 'not_readable_as_a_dispute_resolution',
            whatHappened: `Settling a disputed claim needs { outcome (${DISPUTE_OUTCOMES.join(' / ')}), reason }.`,
            wasItSaved: 'not_saved', nextSafeAction: 'Choose how it was settled and say why. Nothing was recorded.',
          });
        }
        if (deps.recordDisputeResolution === undefined) {
          throw apiError(503, { code: 'dispute_register_unavailable', whatHappened: 'The disputed-claims register is not wired here.', wasItSaved: 'not_saved', nextSafeAction: 'Try again later. Nothing was recorded.' });
        }
        const claim = (await raisedClaims(t)).find((c) => c.supplierId === supplierId && c.submissionId === submissionId);
        if (claim === undefined) throw notFound(`claim ${submissionId} from supplier ${supplierId}`);
        if (claim.state !== 'rejected') {
          throw apiError(409, {
            code: 'not_a_disputed_claim',
            whatHappened: `Claim ${submissionId} is ${claim.state === 'accepted' ? 'accepted' : 'still waiting for a buyer'} — only a rejected claim is a dispute.`,
            wasItSaved: 'not_saved', nextSafeAction: 'Nothing to settle here. Nothing was recorded.',
          });
        }
        const exceptionId = disputeIdOf(submissionId);
        const outcome = b['outcome'] as DisputeOutcome;
        const prior = ((await deps.disputeResolutions?.(t)) ?? []).find((r) => r.exceptionId === exceptionId);
        if (prior !== undefined) {
          if (prior.outcome === outcome) return { status: 200, body: { resolution: prior, alreadyResolved: true } };
          throw apiError(409, {
            code: 'dispute_already_resolved',
            whatHappened: `${prior.by} already settled dispute ${exceptionId} as ${prior.outcome.replace(/_/g, ' ')} at ${prior.at}.`,
            wasItSaved: 'not_saved', nextSafeAction: 'Read the settlement on the Supplier claims page. Nothing was changed.',
          });
        }
        const at = deps.now();
        const r: ClaimDisputeResolution = { exceptionId, supplierId, submissionId, outcome, reason: (b['reason'] as string).trim().slice(0, 300), by: ctx.userId, at };
        await deps.recordDisputeResolution(t, r);
        await deps.recordAudit?.(t, {
          actorId: ctx.userId, action: 'purchase.supplier_claim.dispute.resolve', objectType: 'supplier_claim_dispute', objectId: exceptionId, at,
          origin: { tenantId: t, branchId: ctx.branchId ?? null }, before: { state: 'open' }, after: { state: 'resolved', outcome, supplierId },
          reason: r.reason, correlationId: exceptionId,
        });
        return { status: 201, body: { resolution: r, alreadyResolved: false } };
      },
    },
  ];
}
