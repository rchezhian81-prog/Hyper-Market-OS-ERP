// Free-sample stock issues and their GST credit give-back (A12 (1) · s.17(5)(h) · OB-386, owner, 26 Oct 2026, in writing,
// option A).
//
//   • POST /v1/inventory/free-samples/:issueId — staff record a "free sample" stock issue: the product, where it was taken
//     from, how many, and what it was for. The stock leaves as a compensating movement (never an edit, hard rule #2); its
//     value is head office's own average buying cost, never typed. The system then works out the input tax credit to give
//     back (`freeSampleItc`) and places it — as a free-sample ITC reversal — in the next GST return: the issue's month, or
//     the first later month whose GSTR-3B is not yet locked. Nothing is netted off silently: it appears in GSTR-3B Table
//     4(B) on its own (the existing bridge), marked as computed by the system.
//   • GET  /v1/finance/free-sample-itc?month=YYYY-MM — the accountant's list: every free-sample issue, its give-back (or why
//     none was computed), the return it went into, and whether it has been checked.
//   • POST /v1/finance/free-sample-itc/:issueId/check — the accountant checks it: { outcome: agreed | query, note }. Never
//     the person who recorded the issue (§28). Append-only: a later check stands over an earlier one, both are kept.
//
// OB-393 (owner decision, 26 Oct 2026): a store manager OTHER THAN THE GIVER approves each free sample BEFORE the stock
// leaves and the GST give-back is placed. So the POST above now records a REQUEST, waiting; nothing moves:
//   • GET  /v1/inventory/free-samples/pending — every sample waiting for approval (who gave it, what, where, since when);
//   • POST /v1/inventory/free-samples/:issueId/decision — { decision: approve | reject, reason }. Refused BY NAME when the
//     approver is the giver (`free_sample_self_approval`). Approved: valued at head office's buying cost NOW, the stock
//     leaves, the give-back is worked out and placed (all as before), the issue names both people. Rejected: kept with the
//     reason; nothing moves. Once only. The accountant's list shows the waiting ones on their own, never as "nothing".
//
// A free sample is a stock ISSUE, not waste: it is kept on its own register, so the waste reason list (OB-159) and its
// analytics are not touched. Every record here is append-only and audited (hard rules #2, #6).

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { valueAtUnitCost } from '../../../packages/contracts/src/quantity';
import { freeSampleItc, returnMonthFor, type FreeSampleItc, type PurchaseTaxLine } from '../../../packages/input-tax/src/free-sample-itc';
import type { ItcReversal } from '../../../packages/input-tax/src/index';
import { assertLocationInScope, type LocationBranches } from './location-scope';
import { assertNotFrozenByCount, type CountFreezeCheck } from './count-freeze';

export const FREE_SAMPLE_REASON = 'free_sample';

/** A free-sample issue as it is stored on its own append-only register. */
export interface FreeSampleIssue {
  readonly issueId: string;
  readonly productId: string;
  readonly locationId: string;
  readonly qty: number;
  readonly uom: string;
  readonly batchId?: string;
  /** What it was for — a tasting at the counter, a sample handed to a customer. */
  readonly note: string;
  readonly issuedBy: string;
  readonly issuedAt: string;
  /** The shop's trading day it was given. */
  readonly tradingDay: string;
  /** Head office's average buying cost of the stock there (paise per unit), or null when it holds none. */
  readonly unitCostMinor: number | null;
  readonly itc: FreeSampleItc;
  /** The GST return (YYYY-MM) the give-back was placed in; absent when nothing was given back. */
  readonly returnMonth?: string;
  /** Set when the issue's own month was already locked, so it went into a later return. */
  readonly movedFrom?: string;
  readonly reversalId?: string;
  /** OB-393: when the giver asked, and the store manager (never the giver) who approved it — the stock left then. */
  readonly requestedAt?: string;
  readonly approvedBy?: string;
  readonly approvedAt?: string;
}

/** OB-393: a free sample as the giver recorded it — waiting for another store manager; nothing has moved yet. */
export interface FreeSampleRequest {
  readonly issueId: string;
  readonly productId: string;
  readonly locationId: string;
  readonly qty: number;
  readonly uom: string;
  readonly batchId?: string;
  readonly note: string;
  readonly requestedBy: string;
  readonly requestedAt: string;
  /** The shop's trading day it was given. */
  readonly tradingDay: string;
}

/** OB-393: the approver's decision on one request — once; kept for good. */
export interface FreeSampleDecision {
  readonly issueId: string;
  readonly decision: 'approved' | 'rejected';
  readonly reason: string;
  readonly by: string;
  readonly at: string;
}

export interface FreeSampleCheck {
  readonly issueId: string;
  readonly outcome: 'agreed' | 'query';
  readonly note: string;
  readonly by: string;
  readonly at: string;
}

export interface FreeSampleDeps {
  /** OB-393: every request the givers recorded, and every decision on them (append-only). */
  readonly requests: (tenantId: string) => Promise<readonly FreeSampleRequest[]>;
  readonly recordRequest: (tenantId: string, request: FreeSampleRequest) => Promise<void>;
  readonly decisions: (tenantId: string) => Promise<readonly FreeSampleDecision[]>;
  readonly recordDecision: (tenantId: string, decision: FreeSampleDecision) => Promise<void>;
  readonly issues: (tenantId: string) => Promise<readonly FreeSampleIssue[]>;
  /** Record the issue AND its compensating stock movement (keyed on the issue id, so a retry is one movement, not two). */
  readonly recordIssue: (tenantId: string, issue: FreeSampleIssue) => Promise<void>;
  readonly unitCostAt: (tenantId: string, locationId: string, productId: string) => Promise<number | undefined>;
  /** Non-own owners holding stock of this product here (concession / consignment) — staff never give that away. */
  readonly ownersOfStockAt: (tenantId: string, productId: string, locationId: string) => Promise<readonly { readonly ownership: string; readonly ownerId: string }[]>;
  readonly bills: (tenantId: string) => Promise<readonly PurchaseTaxLine[]>;
  /** The GSTR-3B months (MMYYYY) already locked to a filed GSTR-1. */
  readonly lockedMonths: (tenantId: string) => Promise<ReadonlySet<string>>;
  /** Record a reversal once per id; returns the one that stands. */
  readonly recordReversal: (tenantId: string, reversal: ItcReversal) => Promise<ItcReversal>;
  readonly checks: (tenantId: string) => Promise<readonly FreeSampleCheck[]>;
  readonly recordCheck: (tenantId: string, check: FreeSampleCheck) => Promise<void>;
  readonly tradingDay: (tenantId: string, at: string) => Promise<string>;
  readonly locationBranches?: LocationBranches;
  readonly countFreeze?: CountFreezeCheck;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isPosInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
const isMonth = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
const rupees = (minor: number): string => `₹${(minor / 100).toFixed(2)}`;

const NOT_COMPUTED_WORDS: Readonly<Record<'no_buying_cost' | 'no_bill_for_the_product', string>> = {
  no_buying_cost: 'head office holds no buying cost for this stock here, so the credit to give back cannot be worked out',
  no_bill_for_the_product: 'no supplier bill for this product is on record, so the tax it was bought with is not known',
};

/** The words an accountant reads for an issue's give-back. */
export function itcWords(issue: Pick<FreeSampleIssue, 'itc' | 'returnMonth' | 'movedFrom'>): string {
  const i = issue.itc;
  if (i.state === 'not_computed') return `Not computed: ${NOT_COMPUTED_WORDS[i.why]}. Work it out by hand and record it on the ITC review.`;
  if (i.state === 'no_gst_on_the_bill') return `Nothing to give back: bill ${i.fromInvoiceId} charged no GST on this product.`;
  const total = i.cgstMinor + i.sgstMinor + i.igstMinor + i.cessMinor;
  const heads = ([['CGST', i.cgstMinor], ['SGST', i.sgstMinor], ['IGST', i.igstMinor]] as const).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${rupees(v)}`).join(', ');
  return `${rupees(total)} (${heads}) on a buying value of ${rupees(i.buyingValueMinor)}, at the rate of bill ${i.fromInvoiceId}; in the ${issue.returnMonth ?? ''} return${issue.movedFrom === undefined ? '' : ` (the ${issue.movedFrom} return was already locked)`}.`;
}

const AWAITING_WORDS = 'Recorded and waiting: a store manager other than you approves it before the stock leaves and the GST credit is given back (OB-393).';

/** OB-393: the requests with no decision yet, oldest first. */
export async function pendingOf(deps: Pick<FreeSampleDeps, 'requests' | 'decisions'>, tenantId: string): Promise<FreeSampleRequest[]> {
  const decided = new Set((await deps.decisions(tenantId)).map((d) => d.issueId));
  return (await deps.requests(tenantId)).filter((r) => !decided.has(r.issueId)).sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
}

/** OB-393: on approval — value the stock at head office's cost now, work out the give-back, place it, and move the stock. */
async function placeIssue(deps: FreeSampleDeps, tenantId: string, request: FreeSampleRequest, approvedBy: string, at: string): Promise<FreeSampleIssue> {
  const { issueId, productId, locationId, qty, uom, tradingDay } = request;
  const unitCost = await deps.unitCostAt(tenantId, locationId, productId);
  const buyingValueMinor = unitCost === undefined ? undefined : valueAtUnitCost(qty, uom, unitCost);
  const itc = freeSampleItc({ productId, buyingValueMinor, bills: await deps.bills(tenantId) });
  let placed: { month: string; movedFrom?: string } | undefined;
  let reversalId: string | undefined;
  if (itc.state === 'computed') {
    // The give-back goes into the return of the month the sample was GIVEN, or the first later one not yet locked.
    placed = returnMonthFor(tradingDay.slice(0, 7), await deps.lockedMonths(tenantId));
    reversalId = `free-sample-${issueId}`;
    await deps.recordReversal(tenantId, {
      reversalId, period: placed.month, rule: 'free_samples', sourceRef: `free-sample:${issueId}`,
      reason: `Free sample of ${qty} ${uom} ${productId} at ${locationId} on ${tradingDay} (${request.note.slice(0, 120)}), given by ${request.requestedBy} and approved by ${approvedBy}: credit given back on its buying cost — computed by the system, for the accountant to check (OB-386, OB-393).`,
      igstMinor: itc.igstMinor, cgstMinor: itc.cgstMinor, sgstMinor: itc.sgstMinor, cessMinor: itc.cessMinor, by: 'system:free-sample', at,
    });
  }
  const issue: FreeSampleIssue = {
    issueId, productId, locationId, qty, uom, ...(request.batchId === undefined ? {} : { batchId: request.batchId }),
    note: request.note, issuedBy: request.requestedBy, issuedAt: at, tradingDay, unitCostMinor: unitCost ?? null, itc,
    ...(placed === undefined ? {} : { returnMonth: placed.month, ...(placed.movedFrom === undefined ? {} : { movedFrom: placed.movedFrom }) }),
    ...(reversalId === undefined ? {} : { reversalId }),
    requestedAt: request.requestedAt, approvedBy, approvedAt: at,
  };
  await deps.recordIssue(tenantId, issue);
  return issue;
}

export function freeSampleRoutes(deps: FreeSampleDeps): readonly Route[] {
  const audit = async (tenantId: string, entry: AuditEntry) => { await deps.recordAudit?.(tenantId, entry); };
  return [
    {
      // Record a free-sample stock issue. Body: { productId, locationId, qty (whole, > 0), uom, note, batchId? }. The
      // person is the one signed in; the value is head office's; the give-back is the system's, for the accountant to check.
      api: 'API-04', method: 'POST', path: '/v1/inventory/free-samples/:issueId',
      permission: 'inventory.movement.append', idempotent: true,
      handler: async (ctx) => {
        const issueId = (ctx.params['issueId'] ?? '').trim();
        const b = (ctx.body !== null && typeof ctx.body === 'object' ? ctx.body : {}) as Record<string, unknown>;
        if (b['valueMinor'] !== undefined || b['itc'] !== undefined || b['issuedBy'] !== undefined) {
          throw apiError(400, { code: 'free_sample_carries_its_own_figures', whatHappened: 'A free sample is valued at head office\'s own buying cost and its GST give-back is worked out by the system; a body that names a value, a tax figure or a person is refused.', wasItSaved: 'not_saved', nextSafeAction: 'Send the product, place, quantity, unit and what it was for. Nothing was recorded.' });
        }
        if (issueId === '' || !isStr(b['productId']) || !isStr(b['locationId']) || !isPosInt(b['qty']) || !isStr(b['uom']) || !isStr(b['note'])
          || (b['batchId'] !== undefined && !isStr(b['batchId']))) {
          throw apiError(400, { code: 'not_readable_as_a_free_sample', whatHappened: 'A free sample needs an issueId in the path and { productId, locationId, qty (a whole number above 0), uom, note (what it was for), batchId? }.', wasItSaved: 'not_saved', nextSafeAction: 'Send the free sample again. Nothing was recorded.' });
        }
        const productId = b['productId'].trim();
        const locationId = b['locationId'].trim();
        await assertLocationInScope(ctx, locationId, deps.locationBranches);
        if ((await deps.requests(ctx.tenantId)).some((r) => r.issueId === issueId) || (await deps.issues(ctx.tenantId)).some((i) => i.issueId === issueId)) {
          throw apiError(409, { code: 'free_sample_already_recorded', whatHappened: `Free sample ${issueId} is already recorded — an id is used once; a correction is a new, compensating record.`, wasItSaved: 'not_saved', nextSafeAction: 'Use a new id. Nothing was changed.' });
        }
        await assertNotFrozenByCount(deps.countFreeze, ctx.tenantId, [{ productId, locationId, kind: 'wasted' }], 'free sample');
        const others = await deps.ownersOfStockAt(ctx.tenantId, productId, locationId);
        if (others.length > 0) {
          throw apiError(422, { code: 'stock_not_owned_by_the_store', whatHappened: `${productId} at ${locationId} holds stock owned by ${others[0]!.ownerId} (${others[0]!.ownership}); the store does not give away stock it does not own (M27-FR-02).`, wasItSaved: 'not_saved', nextSafeAction: 'Take the sample from the store\'s own stock. Nothing was recorded.' });
        }
        const at = deps.now();
        const request: FreeSampleRequest = {
          issueId, productId, locationId, qty: b['qty'] as number, uom: b['uom'].trim(), ...(isStr(b['batchId']) ? { batchId: b['batchId'].trim() } : {}),
          note: b['note'].trim().slice(0, 300), requestedBy: ctx.userId, requestedAt: at, tradingDay: await deps.tradingDay(ctx.tenantId, at),
        };
        // OB-393: nothing moves yet — the stock and the GST give-back wait for another store manager's approval.
        await deps.recordRequest(ctx.tenantId, request);
        await audit(ctx.tenantId, {
          actorId: ctx.userId, action: 'stock.free_sample.request', objectType: 'product', objectId: productId, at,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: null,
          after: { issueId, locationId, qty: String(request.qty), uom: request.uom, status: 'awaiting_approval' },
          reason: request.note, correlationId: issueId,
        });
        return { status: 202, body: { request, status: 'awaiting_approval', detail: AWAITING_WORDS } };
      },
    },
    {
      // OB-393: every free sample waiting for a store manager's approval — nothing of these has moved yet.
      api: 'API-04', method: 'GET', path: '/v1/inventory/free-samples/pending',
      permission: 'inventory.free_sample.approve',
      handler: async (ctx) => {
        const pending = await pendingOf(deps, ctx.tenantId);
        return {
          status: 200,
          body: {
            pending, count: pending.length, asAt: deps.now(),
            detail: pending.length === 0 ? 'No free sample is waiting for approval.' : `${pending.length} free sample(s) wait for a store manager other than the giver; their stock has not left and no GST credit has been given back yet.`,
          },
        };
      },
    },
    {
      // OB-393: a store manager other than the giver approves (the stock leaves, the give-back is placed) or rejects it.
      // Body: { decision: "approve" | "reject", reason }.
      api: 'API-04', method: 'POST', path: '/v1/inventory/free-samples/:issueId/decision',
      permission: 'inventory.free_sample.approve', idempotent: true,
      handler: async (ctx) => {
        const issueId = (ctx.params['issueId'] ?? '').trim();
        const b = (ctx.body !== null && typeof ctx.body === 'object' ? ctx.body : {}) as Record<string, unknown>;
        if ((b['decision'] !== 'approve' && b['decision'] !== 'reject') || !isStr(b['reason'])) {
          throw apiError(400, { code: 'not_readable_as_a_free_sample_decision', whatHappened: 'A decision on a free sample is { decision: "approve" | "reject", reason }.', wasItSaved: 'not_saved', nextSafeAction: 'Send the decision and a reason. Nothing was changed.' });
        }
        const decision: FreeSampleDecision['decision'] = b['decision'] === 'approve' ? 'approved' : 'rejected';
        const request = (await deps.requests(ctx.tenantId)).find((r) => r.issueId === issueId);
        if (request === undefined) throw notFound(`free sample ${issueId} waiting for approval`);
        if (request.requestedBy === ctx.userId) {
          throw apiError(403, { code: 'free_sample_self_approval', whatHappened: `${ctx.userId} gave free sample ${issueId} and cannot also approve it — a store manager other than the giver approves each free sample (OB-393).`, wasItSaved: 'not_saved', nextSafeAction: 'Ask another store manager to approve it. Nothing was changed; the stock has not left.' });
        }
        await assertLocationInScope(ctx, request.locationId, deps.locationBranches);
        const done = (await deps.decisions(ctx.tenantId)).find((d) => d.issueId === issueId);
        const issued = (await deps.issues(ctx.tenantId)).find((i) => i.issueId === issueId);
        if (done !== undefined) {
          if (done.decision === decision && done.by === ctx.userId) return { status: 200, body: { decision: done, alreadyDecided: true, ...(issued === undefined ? {} : { issue: issued, itcWords: itcWords(issued) }) } };
          throw apiError(409, { code: 'free_sample_already_decided', whatHappened: `Free sample ${issueId} was already ${done.decision} by ${done.by} at ${done.at} — a decision is made once.`, wasItSaved: 'not_saved', nextSafeAction: 'Nothing was changed. A correction is a new, compensating record.' });
        }
        const at = deps.now();
        const record: FreeSampleDecision = { issueId, decision, reason: b['reason'].trim().slice(0, 300), by: ctx.userId, at };
        if (decision === 'rejected') {
          await deps.recordDecision(ctx.tenantId, record);
          await audit(ctx.tenantId, {
            actorId: ctx.userId, action: 'stock.free_sample.reject', objectType: 'free_sample', objectId: issueId, at,
            origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: { status: 'awaiting_approval', requestedBy: request.requestedBy },
            after: { status: 'rejected' }, reason: record.reason, correlationId: issueId,
          });
          return { status: 201, body: { decision: record, alreadyDecided: false, detail: 'Rejected. Nothing moved: the stock stays and no GST credit is given back.' } };
        }
        // Approved: the same checks as at the request, on the stock as it stands NOW (a count freeze since is a visible refusal).
        await assertNotFrozenByCount(deps.countFreeze, ctx.tenantId, [{ productId: request.productId, locationId: request.locationId, kind: 'wasted' }], 'free sample');
        const others = await deps.ownersOfStockAt(ctx.tenantId, request.productId, request.locationId);
        if (others.length > 0) {
          throw apiError(422, { code: 'stock_not_owned_by_the_store', whatHappened: `${request.productId} at ${request.locationId} holds stock owned by ${others[0]!.ownerId} (${others[0]!.ownership}); the store does not give away stock it does not own (M27-FR-02).`, wasItSaved: 'not_saved', nextSafeAction: 'Reject this sample, or take it from the store\'s own stock. Nothing was changed.' });
        }
        // A retry after the issue was placed but before the decision was written finds the issue and does not place it twice.
        const issue = issued ?? await placeIssue(deps, ctx.tenantId, request, ctx.userId, at);
        await deps.recordDecision(ctx.tenantId, record);
        await audit(ctx.tenantId, {
          actorId: ctx.userId, action: 'stock.free_sample', objectType: 'product', objectId: issue.productId, at,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: { status: 'awaiting_approval', requestedBy: request.requestedBy },
          after: {
            issueId, locationId: issue.locationId, qty: String(issue.qty), uom: issue.uom, givenBy: issue.issuedBy, approvedBy: ctx.userId,
            buyingValueMinor: issue.itc.buyingValueMinor === null ? 'not known' : String(issue.itc.buyingValueMinor),
            itc: issue.itc.state, returnMonth: issue.returnMonth ?? '', reversalId: issue.reversalId ?? '',
          },
          reason: record.reason, correlationId: issueId,
        });
        return { status: 201, body: { decision: record, alreadyDecided: false, issue, itcWords: itcWords(issue) } };
      },
    },

    {
      // The accountant's list (?month=YYYY-MM narrows to the issues whose give-back went into that return, or — for one not
      // computed — were given that month). Each with its check, if any.
      api: 'API-09', method: 'GET', path: '/v1/finance/free-sample-itc',
      permission: 'finance.itc.read',
      handler: async (ctx) => {
        const month = ctx.query['month'];
        if (month !== undefined && !isMonth(month)) {
          throw apiError(400, { code: 'not_a_month', whatHappened: `"${month}" is not a month — send ?month=YYYY-MM, or none for every month.`, wasItSaved: 'not_saved', nextSafeAction: 'Correct the month. Nothing was changed; this only reads.' });
        }
        const [issues, checks, waiting] = await Promise.all([deps.issues(ctx.tenantId), deps.checks(ctx.tenantId), pendingOf(deps, ctx.tenantId)]);
        const latest = new Map<string, FreeSampleCheck>();
        for (const c of checks) latest.set(c.issueId, c);
        const rows = issues
          .filter((i) => month === undefined || (i.returnMonth ?? i.tradingDay.slice(0, 7)) === month)
          .map((i) => ({ ...i, itcWords: itcWords(i), check: latest.get(i.issueId) ?? null }));
        return {
          status: 200,
          body: {
            month: month ?? null, issues: rows, count: rows.length,
            toCheck: rows.filter((r) => r.check === null || r.check.outcome === 'query').length,
            notComputed: rows.filter((r) => r.itc.state === 'not_computed').length,
            // OB-393: samples given but not yet approved — no credit is given back for them yet; listed, never left out (P-08).
            awaitingApproval: waiting.filter((w) => month === undefined || w.tradingDay.slice(0, 7) === month),
            asAt: deps.now(),
          },
        };
      },
    },
    {
      // The accountant checks one: { outcome: agreed | query, note }. Not the person who recorded the issue (§28).
      api: 'API-09', method: 'POST', path: '/v1/finance/free-sample-itc/:issueId/check',
      permission: 'finance.itc.action', idempotent: true,
      handler: async (ctx) => {
        const issueId = (ctx.params['issueId'] ?? '').trim();
        const b = (ctx.body !== null && typeof ctx.body === 'object' ? ctx.body : {}) as Record<string, unknown>;
        if ((b['outcome'] !== 'agreed' && b['outcome'] !== 'query') || !isStr(b['note'])) {
          throw apiError(400, { code: 'not_readable_as_a_check', whatHappened: 'A check is { outcome: "agreed" | "query", note }.', wasItSaved: 'not_saved', nextSafeAction: 'Send the outcome and a note. Nothing was recorded.' });
        }
        const issue = (await deps.issues(ctx.tenantId)).find((i) => i.issueId === issueId);
        if (issue === undefined) throw notFound(`free sample ${issueId}`);
        if (issue.issuedBy === ctx.userId) {
          throw apiError(403, { code: 'self_check', whatHappened: `${ctx.userId} recorded free sample ${issueId} and cannot also check its GST give-back (§28).`, wasItSaved: 'not_saved', nextSafeAction: 'A different person (the accountant) checks it. Nothing was recorded.' });
        }
        const before = [...(await deps.checks(ctx.tenantId))].reverse().find((c) => c.issueId === issueId);
        const check: FreeSampleCheck = { issueId, outcome: b['outcome'], note: b['note'].trim().slice(0, 300), by: ctx.userId, at: deps.now() };
        if (before !== undefined && before.outcome === check.outcome && before.note === check.note && before.by === check.by) {
          return { status: 200, body: { check: before, alreadyRecorded: true } };
        }
        await deps.recordCheck(ctx.tenantId, check);
        await audit(ctx.tenantId, {
          actorId: ctx.userId, action: `finance.free_sample_itc.${check.outcome}`, objectType: 'free_sample', objectId: issueId, at: check.at,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: before === undefined ? null : { outcome: before.outcome, by: before.by },
          after: { outcome: check.outcome, itc: issue.itc.state, returnMonth: issue.returnMonth ?? '' }, reason: check.note, correlationId: issueId,
        });
        return { status: 201, body: { check, alreadyRecorded: false } };
      },
    },
  ];
}
