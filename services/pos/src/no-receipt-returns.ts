// API-05 Controlled no-receipt returns — a return against NO bill, under the owner's policy (M13-FR-01, M15,
// §28, §31). Un-parks the no-receipt half of CH-01 (the cloud write-paths the owner deferred on 24 Aug 2026).
//
// A receipted return is bounded by its bill: what was sold, what was paid, what already came back. A
// no-receipt return has none of that, so the roadmap puts two controls in its place — it ALWAYS needs a
// supervisor's approval (there is no threshold below which it is immaterial) and it is CAPPED by a per-tenant
// limit the owner sets. Both are enforced here with the same shape as the receipted guard in `returns.ts`:
// the processor is the authenticated caller, the cap is server-side policy (never a body value), and the
// approver must genuinely hold `pos.return.approve` — a name in the box is not authority.
//
// Fail-safe by construction: until the owner sets a cap, the no-receipt path is UNAVAILABLE (the desk shows
// "not set up", the lane's own screen already does the same) — never a guessed default. The lane can take a
// no-receipt return with the cable out (§31, its own engine enforces cap + approval offline); the SYNCED
// route here never rejects one that already happened (the money left the drawer) — it records it and turns a
// breach into a VISIBLE governance exception (record-and-flag, hard rule #10) on the same exceptions screen
// the receipted breaches use. A resold unit re-enters stock at the location the desk or lane names (M08-FR-01
// names "return" among the movements); there is no original sale to take a location from, so a resell with no
// location is refused at the desk and STATED on the lane path (assumed from the lane), never guessed silently.
//
// What this module deliberately does NOT do: it never touches a bill's own return register (a no-receipt
// return cannot count against any sale), and it never invents a price — the refund is the amount the desk
// agreed with the customer, within the cap.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { noReceiptGovernanceFindings, type ReturnRequestLine, type RefundGovernanceFinding } from '../../../packages/returns/src/assess-return';
import type { RefundStatus } from '../../../packages/returns/src/returns';
import { issueRefundCredit } from '../../../packages/loyalty/src/stored-value';
import type { AuditEntry } from '../../../packages/audit/src/index';
import type { ReturnRecord, StoreCreditIssue } from './returns';
import type { SaleStockLocation } from './sale-stock';

const DISPOSITIONS: ReadonlySet<string> = new Set(['resell', 'quarantine', 'damaged', 'scrap']);
/** Cash and store credit settle at the desk; card/UPI is a provider reversal, pending until reconciled (M13-FR-04). */
const SETTLED_AT_DESK: ReadonlySet<string> = new Set(['cash', 'store_credit']);

export interface NoReceiptReturnsDeps {
  /** The tenant's no-receipt cap in minor units (M13-FR-01) — `undefined` means the owner has not set one, so
   *  the no-receipt path is UNAVAILABLE (fail-safe). Sourced SERVER-SIDE: the caller cannot declare a cap. */
  readonly noReceiptCap: (tenantId: string) => Promise<number | undefined> | number | undefined;
  /** Set the tenant's no-receipt cap — append-only config (latest wins), owner-only. */
  readonly recordNoReceiptCap: (tenantId: string, capMinor: number, key: string) => Promise<void> | void;
  /** Whether the catalogue knows this product — a no-receipt return is "identify the item" first (M13-FR-01);
   *  the shop does not take back goods it never sold. */
  readonly knownProduct: (tenantId: string, productId: string) => Promise<boolean> | boolean;
  /** Whether a user holds `pos.return.approve` (the §28 authority) — same read the receipted guard uses. */
  readonly canApproveRefund: (tenantId: string, userId: string) => Promise<boolean> | boolean;
  /** The tenant's store-credit issuance cap (M13-FR-03 / M17) — same policy the receipted refund reads. */
  readonly storeCreditCap: (tenantId: string) => Promise<number | undefined> | number | undefined;
  /** Append the accepted no-receipt return to ITS OWN register and the tenant-wide returns projection, with
   *  any store credit and the `returned` movements of its resold lines at `location`, in ONE atomic batch.
   *  Idempotent on the return id. */
  readonly recordNoReceiptReturn: (
    tenantId: string, record: ReturnRecord, storeCredit: StoreCreditIssue | undefined, location: SaleStockLocation | undefined,
  ) => Promise<void> | void;
  /** Every no-receipt return recorded, tenant-wide — the report (M13-FR-01 "no-receipt-return reports", M15). */
  readonly noReceiptReturns: (tenantId: string) => Promise<readonly ReturnRecord[]> | readonly ReturnRecord[];
  /** Seal the refund fact into the domain audit trail (M34-FR-01). Optional; a bare stub may omit it. */
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

/** A no-receipt return as the desk sends it. `processedBy` is the authenticated caller, never a body value. */
interface NoReceiptRequest {
  readonly returnId: string;
  readonly number: string;
  readonly reasonCode: string;
  readonly lines: readonly ReturnRequestLine[];
  readonly refundMinor: number;
  readonly refundTender: string;
  readonly approvedBy?: string;
  readonly customerRef?: string;
  readonly locationId?: string;
  readonly processedAt?: string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isNonNegInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

function readLines(v: unknown): readonly ReturnRequestLine[] | 'invalid' {
  if (!Array.isArray(v) || v.length === 0) return 'invalid';
  const out: ReturnRequestLine[] = [];
  for (const raw of v) {
    if (raw === null || typeof raw !== 'object') return 'invalid';
    const l = raw as Record<string, unknown>;
    if (!isStr(l['productId']) || !isStr(l['uom']) || !isStr(l['disposition']) || !DISPOSITIONS.has(l['disposition'])) return 'invalid';
    if (typeof l['quantityMinor'] !== 'number' || !Number.isInteger(l['quantityMinor']) || l['quantityMinor'] <= 0) return 'invalid';
    out.push({
      productId: l['productId'], uom: l['uom'], quantityMinor: l['quantityMinor'],
      disposition: l['disposition'] as ReturnRequestLine['disposition'],
      ...(isStr(l['condition']) ? { condition: l['condition'] } : {}),
      ...(isStr(l['batchId']) ? { batchId: l['batchId'] } : {}),
    });
  }
  return out;
}

/** Structural read only — every rule is a named refusal in the handler, not a silent 400. */
function readNoReceipt(body: unknown): NoReceiptRequest | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  if (!isStr(b['returnId']) || typeof b['reasonCode'] !== 'string' || !isNonNegInt(b['refundMinor']) || !isStr(b['refundTender'])) return undefined;
  const lines = readLines(b['lines']);
  if (lines === 'invalid') return undefined;
  return {
    returnId: b['returnId'],
    number: isStr(b['number']) ? b['number'] : b['returnId'],
    reasonCode: b['reasonCode'],
    lines,
    refundMinor: b['refundMinor'],
    refundTender: b['refundTender'],
    ...(isStr(b['approvedBy']) ? { approvedBy: b['approvedBy'] } : {}),
    ...(isStr(b['customerRef']) ? { customerRef: b['customerRef'] } : {}),
    ...(isStr(b['locationId']) ? { locationId: b['locationId'] } : {}),
    ...(isStr(b['processedAt']) ? { processedAt: b['processedAt'] } : {}),
  };
}

/** A no-receipt return that ALREADY HAPPENED at the lane, relayed by the sync agent — the operator identity is
 *  the lane's, trusted as the synced-sale/return routes trust it. Tolerant: an unreadable line is kept as sent
 *  (the money moved; nothing here may drop it), only the identity + money fields must be present. */
interface SyncedNoReceipt extends NoReceiptRequest {
  readonly processedBy: string;
  readonly laneId?: string;
  readonly refundStatus: RefundStatus;
}

function readSyncedNoReceipt(body: unknown): SyncedNoReceipt | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  if (!isStr(b['returnId']) || !isStr(b['processedBy']) || typeof b['reasonCode'] !== 'string'
    || !isNonNegInt(b['refundMinor']) || !isStr(b['refundTender']) || !Array.isArray(b['lines'])) return undefined;
  const lines = readLines(b['lines']);
  return {
    returnId: b['returnId'],
    number: isStr(b['number']) ? b['number'] : b['returnId'],
    processedBy: b['processedBy'],
    reasonCode: b['reasonCode'],
    lines: lines === 'invalid' ? (b['lines'] as ReturnRequestLine[]) : lines,
    refundMinor: b['refundMinor'],
    refundTender: b['refundTender'],
    // Never assume a card/UPI refund settled (M13-FR-04): only an explicit 'settled' is trusted.
    refundStatus: b['refundStatus'] === 'settled' ? 'settled' : 'pending',
    ...(isStr(b['approvedBy']) ? { approvedBy: b['approvedBy'] } : {}),
    ...(isStr(b['customerRef']) ? { customerRef: b['customerRef'] } : {}),
    ...(isStr(b['locationId']) ? { locationId: b['locationId'] } : {}),
    ...(isStr(b['laneId']) ? { laneId: b['laneId'] } : {}),
    ...(isStr(b['processedAt']) ? { processedAt: b['processedAt'] } : {}),
  };
}

function readCap(v: unknown): number | 'invalid' {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return 'invalid';
  const c = (v as Record<string, unknown>)['capMinor'];
  return isNonNegInt(c) ? c : 'invalid';
}

const hasResell = (lines: readonly ReturnRequestLine[]): boolean => lines.some((l) => l.disposition === 'resell');

/** The no-receipt report: totals and who gave / who approved — the loss-prevention view (M15). */
export function noReceiptReport(all: readonly ReturnRecord[], asAt: string): {
  readonly count: number;
  readonly totalRefundedMinor: number;
  readonly flaggedCount: number;
  readonly byProcessor: readonly { readonly userId: string; readonly count: number; readonly refundedMinor: number }[];
  readonly byApprover: readonly { readonly userId: string; readonly count: number; readonly refundedMinor: number }[];
  readonly returns: readonly ReturnRecord[];
  readonly asAt: string;
} {
  const tally = (key: (r: ReturnRecord) => string) => {
    const m = new Map<string, { count: number; refundedMinor: number }>();
    for (const r of all) {
      const k = key(r);
      const cur = m.get(k) ?? { count: 0, refundedMinor: 0 };
      m.set(k, { count: cur.count + 1, refundedMinor: cur.refundedMinor + r.refundMinor });
    }
    return [...m.entries()].map(([userId, v]) => ({ userId, ...v })).sort((a, b) => b.refundedMinor - a.refundedMinor || a.userId.localeCompare(b.userId));
  };
  const sorted = [...all].sort((a, b) => (a.processedAt < b.processedAt ? 1 : a.processedAt > b.processedAt ? -1 : 0));
  return {
    count: all.length,
    totalRefundedMinor: all.reduce((s, r) => s + r.refundMinor, 0),
    flaggedCount: all.filter((r) => (r.governanceFlags?.length ?? 0) > 0).length,
    byProcessor: tally((r) => r.processedBy),
    byApprover: tally((r) => r.approvedBy ?? ''),
    returns: sorted,
    asAt,
  };
}

export function noReceiptReturnRoutes(deps: NoReceiptReturnsDeps): readonly Route[] {
  return [
    {
      // The no-receipt CAP (M13-FR-01) — the most a return with no bill may refund. READ so the desk can see the
      // policy (a cashier reads it). `null` + isSet:false means the owner has not set one, so no-receipt
      // returns are UNAVAILABLE until they do (fail-safe, P-08).
      api: 'API-05', method: 'GET', path: '/v1/pos/no-receipt-cap',
      permission: 'pos.return.record',
      handler: async (ctx) => {
        const stored = await deps.noReceiptCap(ctx.tenantId);
        return { status: 200, body: { capMinor: stored ?? null, isSet: stored !== undefined } };
      },
    },
    {
      // Set the no-receipt cap — an owner decision (M13-FR-01 "capped", M15). Append-only (latest wins). Body:
      // { capMinor } — a whole amount in paise ≥ 0 (0 = no-receipt returns are switched off: nothing may be
      // refunded without a bill). Not a per-return input; a caller cannot declare their own cap.
      api: 'API-05', method: 'POST', path: '/v1/pos/no-receipt-cap',
      permission: 'pos.return.noreceipt.cap.set', idempotent: true,
      handler: async (ctx) => {
        const capMinor = readCap(ctx.body);
        if (capMinor === 'invalid') {
          throw apiError(400, {
            code: 'not_readable_as_a_no_receipt_cap',
            whatHappened: 'A no-receipt cap needs { capMinor } — a whole amount in paise ≥ 0 (0 switches no-receipt returns off).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the most a single return with no bill may refund.',
          });
        }
        const now = deps.now();
        await deps.recordNoReceiptCap(ctx.tenantId, capMinor, `${capMinor}-${now}`);
        return { status: 200, body: { capMinor, setAt: now } };
      },
    },
    {
      // Take a controlled no-receipt return at the desk (M13-FR-01, §28). No money has moved yet, so every
      // breach is REFUSED here, not recorded: no cap set; over the cap; a product the shop does not sell; no
      // approver / the processor approving themselves / an approver without the authority; a resold unit with
      // nowhere to go back to; store credit without a customer or over its own cap.
      api: 'API-05', method: 'POST', path: '/v1/returns/no-receipt',
      permission: 'pos.return.record', idempotent: true,
      handler: async (ctx) => {
        const req = readNoReceipt(ctx.body);
        if (req === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_a_no_receipt_return',
            whatHappened: 'This payload could not be read as a no-receipt return — it needs a return id, a reason code, lines (product, uom, a positive whole quantity, a disposition of resell/quarantine/damaged/scrap), a whole refund amount ≥ 0 and a tender. Who processed it is your login.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'No money has moved. Fix the return and send it again.',
          });
        }
        if (req.reasonCode.trim() === '') {
          throw apiError(422, {
            code: 'no_reason',
            whatHappened: 'A no-receipt return must say why the goods are coming back.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Pick a reason and send it again. No money has moved.',
          });
        }

        // The owner's cap is the FIRST gate: no cap, no no-receipt path (fail-safe); over it, refused.
        const capMinor = await deps.noReceiptCap(ctx.tenantId);
        if (capMinor === undefined) {
          throw apiError(422, {
            code: 'no_receipt_returns_unavailable',
            whatHappened: 'No-receipt returns are not set up for this shop — the owner has not set a no-receipt cap.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Ask the owner to set a no-receipt cap (POST /v1/pos/no-receipt-cap), or find the original bill and take a receipted return. No money has moved.',
          });
        }
        if (req.refundMinor > capMinor) {
          throw apiError(422, {
            code: 'no_receipt_over_cap',
            whatHappened: `A no-receipt refund of ${req.refundMinor} paise is above this shop's no-receipt cap of ${capMinor} paise.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Lower the refund to within the cap, or find the original bill and take a receipted return. No money has moved.',
          });
        }

        // Identify the item (M13-FR-01): the shop takes back only goods it sells.
        for (const line of req.lines) {
          if (!(await deps.knownProduct(ctx.tenantId, line.productId))) {
            throw apiError(422, {
              code: 'product_not_in_catalogue',
              whatHappened: `${line.productId} is not a product this shop sells, so it cannot be taken back without a bill.`,
              wasItSaved: 'not_saved',
              nextSafeAction: 'Check the item against the catalogue (scan its barcode). No money has moved.',
            });
          }
        }

        // §28: a no-receipt return ALWAYS needs a second, authorised person — whatever the amount.
        if (req.approvedBy === undefined) {
          throw apiError(422, {
            code: 'needs_a_second_person',
            whatHappened: 'A no-receipt return always needs a supervisor/manager to approve it — there is no bill to bound it.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Have a supervisor/manager approve it (send approvedBy). No money has moved.',
          });
        }
        if (req.approvedBy === ctx.userId) {
          throw apiError(422, {
            code: 'approved_by_the_person_processing_it',
            whatHappened: `${ctx.userId} cannot approve their own no-receipt return (§28).`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'A different supervisor/manager must approve it. No money has moved.',
          });
        }
        if (!(await deps.canApproveRefund(ctx.tenantId, req.approvedBy))) {
          throw apiError(422, {
            code: 'approver_may_not_approve',
            whatHappened: `${req.approvedBy} does not hold the authority to approve a refund, so their approval of this no-receipt return does not count.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Have a supervisor/manager (one who can approve refunds) approve it. No money has moved.',
          });
        }

        // A resold unit re-enters stock somewhere (M08-FR-01). There is no bill to take the location from, so
        // the desk must say — a shelf count that quietly drifts is exactly what P-08 forbids.
        if (hasResell(req.lines) && req.locationId === undefined) {
          throw apiError(422, {
            code: 'resell_needs_a_location',
            whatHappened: 'A no-receipt return that puts goods back on sale must say which stock location they go back to — there is no original bill to take it from.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send locationId (the store or shelf location), or set the disposition to quarantine/damaged/scrap. No money has moved.',
          });
        }

        const processedAt = req.processedAt ?? deps.now();
        const refundStatus: RefundStatus = SETTLED_AT_DESK.has(req.refundTender) ? 'settled' : 'pending';

        // Store credit as the refund method (M13-FR-03 / M17) — the same rules as a receipted refund.
        let storeCredit: StoreCreditIssue | undefined;
        let creditBalanceMinor: number | undefined;
        if (req.refundTender === 'store_credit' && req.refundMinor > 0) {
          if (req.customerRef === undefined) {
            throw apiError(422, {
              code: 'store_credit_needs_a_customer',
              whatHappened: 'A store-credit refund must name the customer it is issued to (customerRef) — store credit is money held on account and cannot belong to nobody.',
              wasItSaved: 'not_saved',
              nextSafeAction: 'Identify the customer and send the refund again, or refund by another method. No money has moved.',
            });
          }
          const scCap = await deps.storeCreditCap(ctx.tenantId);
          const issue = issueRefundCredit({
            ownerRef: req.customerRef, amountMinor: req.refundMinor, returnId: req.returnId, at: processedAt,
            ...(scCap === undefined ? {} : { capMinor: scCap }),
          });
          if (!issue.ok) {
            const code = issue.outcome === 'cap_not_configured' ? 'store_credit_unavailable'
              : issue.outcome === 'cap_exceeded' ? 'store_credit_over_cap' : 'store_credit_amount_invalid';
            throw apiError(422, {
              code, whatHappened: issue.detail, wasItSaved: 'not_saved',
              nextSafeAction: issue.outcome === 'cap_not_configured'
                ? 'Set a store-credit cap (owner) before issuing store credit, or refund by another method. No money has moved.'
                : 'Lower the store-credit amount or refund by another method. No money has moved.',
            });
          }
          storeCredit = { movement: issue.movement!, ...(issue.instrument === undefined ? {} : { instrument: issue.instrument }) };
          creditBalanceMinor = issue.balanceAfterMinor;
        }

        const location: SaleStockLocation | undefined = req.locationId === undefined ? undefined : { locationId: req.locationId, basis: 'declared_by_lane' };
        const record: ReturnRecord = {
          returnId: req.returnId, number: req.number, originalSaleId: null, noReceipt: true,
          processedBy: ctx.userId, processedAt, reasonCode: req.reasonCode,
          refundMinor: req.refundMinor, refundTender: req.refundTender, refundStatus, lines: req.lines,
          approvedBy: req.approvedBy,
          ...(req.customerRef === undefined ? {} : { customerRef: req.customerRef }),
          ...(req.locationId === undefined ? {} : { locationId: req.locationId }),
        };
        await deps.recordNoReceiptReturn(ctx.tenantId, record, storeCredit, location);
        // Seal the refund FACT (M34-FR-01) — amount, reason, status, approver, that it was without a bill. No
        // tender instrument is recorded (hard rule #3).
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'refund.accept', objectType: 'no_receipt_return', objectId: req.returnId,
          at: processedAt, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: null,
          after: {
            returnId: req.returnId, noReceipt: 'yes', refundMinor: String(req.refundMinor), capMinor: String(capMinor),
            reasonCode: req.reasonCode, refundStatus, approvedBy: req.approvedBy,
            ...(req.locationId === undefined ? {} : { locationId: req.locationId }),
            ...(storeCredit === undefined ? {} : { storeCreditInstrumentId: storeCredit.movement.instrumentId }),
          },
          correlationId: req.returnId,
        });
        return {
          status: 201,
          body: {
            returnId: req.returnId, noReceipt: true, refundStatus,
            restockedLines: req.lines.filter((l) => l.disposition === 'resell').length,
            capMinor,
            ...(storeCredit === undefined ? {} : { storeCredit: { instrumentId: storeCredit.movement.instrumentId, balanceMinor: creditBalanceMinor } }),
          },
        };
      },
    },
    {
      // Reconcile a no-receipt return that ALREADY HAPPENED at the lane (M13-FR-01, §31). Relayed by the sync
      // agent under the store's sync token; the OPERATOR identity is the lane's, trusted here as the synced
      // sale/return routes trust it. The money already left the drawer, so this NEVER rejects: it RECORDS the
      // return and, for a breach — no approver, a self-approval, an approver without authority, a refund over
      // the cap or with no cap set, store credit with no customer or over its cap — records a VISIBLE governance
      // exception (record-and-flag, hard rule #10) on the same exceptions surface as the receipted breaches.
      api: 'API-05', method: 'POST', path: '/v1/returns/no-receipt/synced',
      permission: 'pos.return.sync', idempotent: true,
      handler: async (ctx) => {
        const s = readSyncedNoReceipt(ctx.body);
        if (s === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_a_synced_no_receipt_return',
            whatHappened: 'This payload could not be read as a synced no-receipt return — it needs a return id, who processed it, a reason code, a whole refund amount, a tender and lines.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Keep it in the outbox and raise it — a refund that happened at the lane must not be dropped.',
          });
        }
        const capMinor = await deps.noReceiptCap(ctx.tenantId);
        const approverHoldsAuthority = s.approvedBy !== undefined ? await deps.canApproveRefund(ctx.tenantId, s.approvedBy) : false;
        const flags: RefundGovernanceFinding[] = [...noReceiptGovernanceFindings({
          refundMinor: s.refundMinor, capMinor, processedBy: s.processedBy,
          ...(s.approvedBy === undefined ? {} : { approvedBy: s.approvedBy }), approverHoldsAuthority,
        })];

        // Store credit taken offline: issued regardless (it happened at the lane), breaches flagged (as `returns.ts`).
        const processedAt = s.processedAt ?? deps.now();
        let storeCredit: StoreCreditIssue | undefined;
        if (s.refundTender === 'store_credit' && s.refundMinor > 0) {
          if (s.customerRef === undefined) {
            flags.push('store_credit_no_customer');
          } else {
            const scCap = await deps.storeCreditCap(ctx.tenantId);
            if (scCap === undefined || s.refundMinor > scCap) flags.push('store_credit_over_cap');
            const issue = issueRefundCredit({ ownerRef: s.customerRef, amountMinor: s.refundMinor, returnId: s.returnId, at: processedAt, capMinor: s.refundMinor });
            if (issue.ok) storeCredit = { movement: issue.movement!, ...(issue.instrument === undefined ? {} : { instrument: issue.instrument }) };
          }
        }

        // Where the resold units went back: the lane's declared location, else the lane itself — STATED on the
        // movement (P-08), the same rule a synced sale follows. Absent both, no movement is guessed.
        const location: SaleStockLocation | undefined = s.locationId !== undefined
          ? { locationId: s.locationId, basis: 'declared_by_lane' }
          : s.laneId !== undefined ? { locationId: s.laneId, basis: 'assumed_from_lane' } : undefined;

        const record: ReturnRecord = {
          returnId: s.returnId, number: s.number, originalSaleId: null, noReceipt: true,
          processedBy: s.processedBy, processedAt, reasonCode: s.reasonCode,
          refundMinor: s.refundMinor, refundTender: s.refundTender, refundStatus: s.refundStatus, lines: s.lines,
          ...(flags.length > 0 ? { governanceFlags: flags } : {}),
          ...(s.approvedBy === undefined ? {} : { approvedBy: s.approvedBy }),
          ...(s.customerRef === undefined ? {} : { customerRef: s.customerRef }),
          ...(location === undefined ? {} : { locationId: location.locationId }),
        };
        await deps.recordNoReceiptReturn(ctx.tenantId, record, storeCredit, location);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: record.processedBy, action: 'refund.accept', objectType: 'no_receipt_return', objectId: s.returnId,
          at: processedAt, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null, capturedOffline: true },
          before: null,
          after: {
            returnId: s.returnId, noReceipt: 'yes', refundMinor: String(s.refundMinor), capMinor: capMinor === undefined ? 'not set' : String(capMinor),
            reasonCode: s.reasonCode, refundStatus: s.refundStatus, approvedBy: s.approvedBy ?? '', flagged: flags.length > 0 ? 'yes' : 'no',
          },
          correlationId: s.returnId,
        });
        return { status: 202, body: { returnId: s.returnId, noReceipt: true, reconciled: true, flags } };
      },
    },
    {
      // The no-receipt-return REPORT (M13-FR-01 reporting, M15 loss prevention): every return taken without a
      // bill, the money it cost, and who gave / who approved — a loss surface one rung above the desk
      // (lp.case.read: owner / manager / accountant), like the governance exceptions. Read-only.
      api: 'API-05', method: 'GET', path: '/v1/pos/no-receipt-returns',
      permission: 'lp.case.read',
      handler: async (ctx) => {
        const all = await deps.noReceiptReturns(ctx.tenantId);
        return { status: 200, body: noReceiptReport(all, deps.now()) };
      },
    },
  ];
}
