// R2 · batch 18c — CORRECT A SAVED GOODS RECEIPT when a wrong quantity was keyed (M07-FR-01/03 · M08-FR-01 · hard rules
// #2, #10 · pilot audit B-5 · OB-873, decided under OB-801).
//
// A saved receipt is NEVER changed. A correction is its own record, linked to the receipt (which keeps its number), with its
// own number in the store's correction range (`GRC1/26-27/00001`). In ONE atomic save it:
//
//   • fixes the STOCK LEDGER by a compensating movement for the difference only — more units in at the receipt line's own
//     cost (`received`), or the extra units out at that same cost (`receipt_corrected_out`, a purchase reversal, never cost
//     of goods sold) — on the line's batch;
//   • fixes the ORDER's received quantity by a compensating receipt posting of the difference (positive or negative) under
//     the order's own write guard, so the open commitment and every later bill match read the corrected figure;
//   • and when a supplier bill was ALREADY matched (or paid) against the old quantity, it does not touch the bill: it puts a
//     visible exception on the correction — "a debit note is needed" (fewer units) or "match the bill again" (more units),
//     with the value — never silent (hard rule #10).
//
// It corrects the quantity that went into stock (the sellable part of the line); a held excess, quarantined or refused units
// keep their own decisions. A correction that would take stock below what is still there — because the units were already
// sold or moved — is refused in plain words. It needs a reason and a SECOND person's approval (an approval of kind
// `goods_receipt_correction`, checked by another person who handles stock, as a write-off is), whatever its value. Every
// correction is sealed on the audit trail with who asked, who approved, what changed and why.
//
// OB-875 B (owner, 19 Nov 2026): a receipt dated in a month whose GST return is already filed, or whose accounting month is
// closed and signed, is NOT corrected until the CA signs that month off — reopens it with the existing `period_reopen`
// approval (Approvals → Reopen a signed accounting month). Head office refuses it here, in plain words that name the month
// and the way forward; the receipt screen shows the same words when the receipt is opened.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound, concurrentChange } from '../../kernel/src/index';
import { ConcurrencyConflictError } from '../../../packages/persistence/src/event-store';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { valueAtCost } from '../../../packages/contracts/src/quantity';
import { tradingMonthIn } from '../../../packages/calendar/src/shop-clock';
import { actionDetails, approvalNamedIn, type ApprovalPort } from '../../identity/src/approval-requests';
import { assertLocationInScope, type LocationBranches } from './location-scope';
import type { GrnRecord } from './goods-receipt';
import type { Movement } from './index';

/** A bill already matched against the receipt's order before the correction — now needs a person (never silent). */
export interface CorrectionBillException {
  readonly invoiceId: string;
  /** `debit_note_needed` — fewer units than the bill was matched for; `rematch_needed` — more units, the bill may pay more. */
  readonly kind: 'debit_note_needed' | 'rematch_needed';
  readonly paid: boolean;
  /** The difference at the line's cost (before GST). */
  readonly valueMinor: number;
  readonly says: string;
}

export interface StoredReceiptCorrection {
  readonly correctionId: string;
  /** `GRC1/26-27/00001`. */
  readonly documentNumber?: string;
  readonly grnId: string;
  /** The receipt's own number, unchanged (`GRN1/…`, or its older number). */
  readonly receiptNumber: string;
  readonly lineId: string;
  readonly productId: string;
  readonly warehouseId: string;
  readonly batchId: string | null;
  readonly uom: string;
  /** The quantity in stock from this line before this correction (the receipt's, after any earlier corrections). */
  readonly wasMinor: number;
  readonly nowMinor: number;
  /** nowMinor − wasMinor; never 0. */
  readonly deltaMinor: number;
  readonly unitCost: { readonly minor: number; readonly currency: string; readonly per?: number };
  readonly valueMinor: number;
  readonly reason: string;
  readonly requestedBy: string;
  readonly approvedBy: string;
  readonly at: string;
  readonly movementId: string;
  readonly poId: string | null;
  /** The order's received quantity was corrected too (the receipt had folded into an issued order). */
  readonly orderCorrected: boolean;
  readonly billExceptions: readonly CorrectionBillException[];
}

/** A bill on head office's register against the receipt's order, as the correction needs it. */
export interface BillForCorrection {
  readonly invoiceId: string;
  readonly productIds: readonly string[];
  readonly matched: boolean;
  readonly paid: boolean;
}

/** OB-875 B: what head office knows of the receipt's month — its accounts' state and its GST returns filed. */
export interface ReceiptMonthState {
  /** `YYYY-MM` — the month of the receipt's own date. */
  readonly period: string;
  /** The accounting month's latest fact: `closed` (closed and signed) or `open` (never closed, or reopened). */
  readonly accounts: 'open' | 'closed';
  /** The month's GST returns recorded as filed (GSTR-1, GSTR-3B), with the date filed (`YYYY-MM-DD`; '' when not known). */
  readonly filedReturns: readonly { readonly type: string; readonly filedOn: string }[];
  /** When the month's latest fact is a reopen (the CA's sign-off): the shop's date it was reopened (`YYYY-MM-DD`). */
  readonly reopenedOn?: string;
}

export type ReceiptMonthLock =
  | { readonly locked: false }
  | { readonly locked: true; readonly period: string; readonly why: 'accounts_signed' | 'gst_filed'; readonly says: string; readonly next: string };

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;
/** `2026-10` → `October 2026`. */
export function monthInWords(period: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  const name = m === null ? undefined : MONTHS[Number(m[2]) - 1];
  return m === null || name === undefined ? period : `${name} ${m[1]}`;
}
const RETURN_WORDS: Readonly<Record<string, string>> = { GSTR1: 'GSTR-1', GSTR3B: 'GSTR-3B' };

/**
 * OB-875 B: may a receipt dated in this month still be corrected? Not when the month's accounts are closed and signed; not
 * when a GST return of the month is filed — unless the CA reopened the month (`period_reopen`) on or after the filing.
 */
export function receiptMonthLock(receiptNumber: string, m: ReceiptMonthState): ReceiptMonthLock {
  const month = monthInWords(m.period);
  const returns = [...new Set(m.filedReturns.map((r) => RETURN_WORDS[r.type] ?? r.type))].join(' and ');
  const filed = m.filedReturns.length > 0;
  const reopenStep = `Ask the CA to reopen ${month} (Approvals → Reopen a signed accounting month), then correct the receipt.`;
  if (m.accounts === 'closed') {
    return {
      locked: true, period: m.period, why: 'accounts_signed', next: reopenStep,
      says: `${receiptNumber} is dated ${month}. ${filed ? `That month's GST return (${returns}) is filed and its` : 'That month\'s'} accounts are closed and signed, so the receipt is not corrected until the CA signs the month off. ${reopenStep}`,
    };
  }
  if (!filed) return { locked: false };
  const lastFiled = m.filedReturns.map((r) => r.filedOn).sort().at(-1) ?? '';
  if (m.reopenedOn !== undefined && m.reopenedOn >= lastFiled) return { locked: false };
  const next = `Ask the CA to close and sign ${month} and then reopen it (Approvals → Close and sign an accounting month, then Approvals → Reopen a signed accounting month), then correct the receipt.`;
  return {
    locked: true, period: m.period, why: 'gst_filed', next,
    says: `${receiptNumber} is dated ${month}. That month's GST return (${returns}) is filed, so the receipt is not corrected until the CA signs the month off. ${next}`,
  };
}

/** The month a receipt belongs to: the shop's trading month of the moment it was saved (never the UTC month). */
export const receiptMonthOf = (rec: GrnRecord): string => tradingMonthIn(rec.receivedAt);

export interface ReceiptCorrectionDeps {
  readonly grn: (tenantId: string, grnId: string) => Promise<GrnRecord | undefined> | GrnRecord | undefined;
  readonly corrections: (tenantId: string) => Promise<readonly StoredReceiptCorrection[]> | readonly StoredReceiptCorrection[];
  readonly onHandAt: (tenantId: string, productId: string, locationId: string, batchId?: string) => Promise<number> | number;
  /** The bills against an order, with whether each was matched and paid. */
  readonly billsForOrder: (tenantId: string, poId: string) => Promise<readonly BillForCorrection[]> | readonly BillForCorrection[];
  /** The order's write-guard version (read before anything is judged) — the correction lands only on the order as judged. */
  readonly orderVersion?: (tenantId: string, poId: string) => Promise<number> | number;
  /** The correction, its movement and (when the receipt folded into an order) its compensating order posting — ONE save. */
  readonly commitCorrection: (tenantId: string, rec: StoredReceiptCorrection, movement: Movement, orderGuard?: { readonly poId: string; readonly expectedVersion: number }) => Promise<{ readonly documentNumber?: string }>;
  /** OB-875 B: the receipt's month — its accounts' state and its GST returns filed. Absent: no month lock is judged. */
  readonly monthState?: (tenantId: string, period: string) => Promise<ReceiptMonthState> | ReceiptMonthState;
  readonly approvals?: ApprovalPort;
  readonly locationBranches?: LocationBranches;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const rupees = (m: number): string => `₹${(m / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The quantity in stock from each line of a receipt, after its corrections. */
export function correctedSellable(rec: GrnRecord, corrections: readonly StoredReceiptCorrection[]): Readonly<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const l of rec.captured.lines) out[l.lineId] = l.sellableMinor;
  for (const c of corrections) if (c.grnId === rec.grnId && out[c.lineId] !== undefined) out[c.lineId] = out[c.lineId]! + c.deltaMinor;
  return out;
}

export function goodsReceiptCorrectionRoutes(deps: ReceiptCorrectionDeps): readonly Route[] {
  return [
    {
      // Body: { lineId, correctQuantityMinor (what should have been booked into stock), reason, approvalId }.
      api: 'API-04', method: 'POST', path: '/v1/inventory/goods-receipt/:grnId/corrections/:correctionId',
      permission: 'inventory.movement.append', idempotent: true,
      handler: async (ctx) => {
        const grnId = (ctx.params['grnId'] ?? '').trim();
        const correctionId = (ctx.params['correctionId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const nowMinor = b['correctQuantityMinor'];
        if (correctionId === '' || !isStr(b['lineId']) || !Number.isSafeInteger(nowMinor) || (nowMinor as number) < 0) {
          throw apiError(400, {
            code: 'not_readable_as_a_receipt_correction',
            whatHappened: 'A correction needs the line and the right quantity (a whole number, 0 or more), with a reason.',
            wasItSaved: 'not_saved', nextSafeAction: 'Fill in the line, the right quantity and why. Nothing was changed.',
          });
        }
        const reason = isStr(b['reason']) ? b['reason'].trim() : '';
        const all = await deps.corrections(ctx.tenantId);
        const done = all.find((c) => c.correctionId === correctionId);
        if (done !== undefined) {
          if (done.grnId === grnId && done.lineId === b['lineId'] && done.nowMinor === nowMinor) return { status: 200, body: { correction: done, alreadyRecorded: true } };
          throw apiError(409, { code: 'correction_already_recorded', whatHappened: `Correction ${done.documentNumber ?? correctionId} is already recorded — an id is used once.`, wasItSaved: 'not_saved', nextSafeAction: 'Start a new correction. Nothing was changed.' });
        }
        // The order's guard first, then the receipt and everything judged on it.
        const rec0 = await deps.grn(ctx.tenantId, grnId);
        if (rec0 === undefined) throw notFound(`goods receipt ${grnId}`);
        const version = rec0.poId !== null && rec0.poReceipt != null && deps.orderVersion !== undefined ? await deps.orderVersion(ctx.tenantId, rec0.poId) : undefined;
        const rec = (await deps.grn(ctx.tenantId, grnId)) ?? rec0;
        await assertLocationInScope(ctx, rec.warehouseId, deps.locationBranches);
        const line = rec.captured.lines.find((l) => l.lineId === b['lineId']);
        const receiptNumber = rec.documentNumber ?? rec.number;
        if (line === undefined) throw notFound(`line ${String(b['lineId'])} on goods receipt ${receiptNumber}`);
        if (reason === '') {
          throw apiError(422, { code: 'reason_required', whatHappened: 'A correction of a saved receipt needs a reason — what was keyed wrong.', wasItSaved: 'not_saved', nextSafeAction: 'Write why, and send it again. Nothing was changed.' });
        }
        // OB-875 B: a month whose GST return is filed, or whose accounts are closed and signed, is not corrected until the CA
        // signs it off (reopens it) — refused here, at head office, before anyone is asked to approve anything.
        const lock = deps.monthState === undefined ? { locked: false as const } : receiptMonthLock(receiptNumber, await deps.monthState(ctx.tenantId, receiptMonthOf(rec)));
        if (lock.locked) {
          throw apiError(409, { code: 'receipt_month_filed_or_signed', whatHappened: `${lock.says} Nothing was changed.`, wasItSaved: 'not_saved', nextSafeAction: `${lock.next} Nothing was changed.` });
        }
        if (line.costNotKnown === true && !(rec.billCosts ?? []).some((c) => c.lineId === line.lineId)) {
          throw apiError(422, {
            code: 'line_cost_not_known',
            whatHappened: `Line ${line.lineId} (${line.productId}) was booked with its cost not known, so the correction could not be valued.`,
            wasItSaved: 'not_saved', nextSafeAction: 'Match the supplier\'s bill to this receipt first, then correct it. Nothing was changed.',
          });
        }
        const wasMinor = correctedSellable(rec, all)[line.lineId] ?? line.sellableMinor;
        const deltaMinor = (nowMinor as number) - wasMinor;
        if (deltaMinor === 0) {
          throw apiError(422, { code: 'nothing_to_correct', whatHappened: `Line ${line.lineId} already has ${wasMinor} in stock from this receipt.`, wasItSaved: 'not_saved', nextSafeAction: 'Type the quantity that is right. Nothing was changed.' });
        }
        const batchId = line.batchId ?? undefined;
        // Never below what is still there: the extra units may already have been sold or moved.
        if (deltaMinor < 0) {
          const left = await deps.onHandAt(ctx.tenantId, line.productId, rec.warehouseId, batchId);
          if (left < -deltaMinor) {
            throw apiError(422, {
              code: 'correction_below_what_was_sold',
              whatHappened: `The receipt cannot be reduced by ${-deltaMinor}: only ${Math.max(0, left)} of ${line.productId}${batchId === undefined ? '' : ` (batch ${batchId})`} are still at ${rec.warehouseId} — the rest were already sold or moved.`,
              wasItSaved: 'not_saved',
              nextSafeAction: 'Count what is there. If the stock really is short, record that on a stock count, not on the receipt. Nothing was changed.',
            });
          }
        }
        const unitCost: { readonly minor: number; readonly currency: string; readonly per?: number } =
          (rec.billCosts ?? []).find((c) => c.lineId === line.lineId && c.costWasKnown !== true)?.unitCost ?? line.unitCost;
        const valueMinor = valueAtCost(Math.abs(deltaMinor), line.uom, unitCost);
        const at = deps.now();
        // The second person: an approval another person who handles stock gave for exactly this correction.
        const opened = await approvalNamedIn(deps.approvals, {
          tenantId: ctx.tenantId, approvalId: b['approvalId'], typedField: 'approvedBy', typedValue: b['approvedBy'],
          kind: 'goods_receipt_correction', subjectRef: correctionId, details: actionDetails(ctx.body, { grnId, correctionId }),
          // The approval is of exactly this line and quantity (its fingerprint); its value is worked out here, not asked for.
          valueMinor: null,
          maker: ctx.userId, usedBy: `receipt-correction:${correctionId}`, now: at,
        });
        if (opened === undefined) {
          throw apiError(422, {
            code: 'correction_needs_approval',
            whatHappened: `Correcting ${receiptNumber} line ${line.lineId} from ${wasMinor} to ${nowMinor as number} (${deltaMinor > 0 ? '+' : '−'}${Math.abs(deltaMinor)}, ${rupees(valueMinor)}) changes stock, the order and the bill match, so a second person who handles stock approves it first. The person who asks cannot approve it.`,
            wasItSaved: 'not_saved', nextSafeAction: 'Press "Ask for approval"; once another person approves it, press Save correction again. Nothing was changed.',
          });
        }
        // Bills already matched (or paid) against the old quantity: a visible exception, never a silent change.
        const billExceptions: CorrectionBillException[] = [];
        if (rec.poId !== null) {
          for (const bill of await deps.billsForOrder(ctx.tenantId, rec.poId)) {
            if (!bill.matched || !bill.productIds.includes(line.productId)) continue;
            const kind = deltaMinor < 0 ? 'debit_note_needed' as const : 'rematch_needed' as const;
            billExceptions.push({
              invoiceId: bill.invoiceId, kind, paid: bill.paid, valueMinor,
              says: kind === 'debit_note_needed'
                ? `Bill ${bill.invoiceId} was matched${bill.paid ? ' and paid' : ''} for ${Math.abs(deltaMinor)} more ${line.productId} than came. A debit note to the supplier for ${rupees(valueMinor)} (before GST) is needed.`
                : `Bill ${bill.invoiceId} was matched against ${Math.abs(deltaMinor)} fewer ${line.productId} than came. Match the bill again so the extra ${rupees(valueMinor)} (before GST) can be paid.`,
            });
          }
        }
        const orderCorrected = rec.poId !== null && rec.poReceipt != null;
        const movementId = `grn-correction-${correctionId}`;
        const correction: StoredReceiptCorrection = {
          correctionId, grnId, receiptNumber, lineId: line.lineId, productId: line.productId, warehouseId: rec.warehouseId,
          batchId: line.batchId, uom: line.uom, wasMinor, nowMinor: nowMinor as number, deltaMinor,
          unitCost: { minor: unitCost.minor, currency: unitCost.currency, ...(unitCost.per === undefined ? {} : { per: unitCost.per }) },
          valueMinor, reason, requestedBy: ctx.userId, approvedBy: opened.decision.decidedBy, at, movementId,
          poId: rec.poId, orderCorrected, billExceptions,
        };
        const movement: Movement = {
          movementId, productId: line.productId, locationId: rec.warehouseId,
          kind: deltaMinor > 0 ? 'received' : 'receipt_corrected_out', quantityMinor: Math.abs(deltaMinor), uom: line.uom, occurredAt: at,
          reason: `correction of goods receipt ${receiptNumber}: ${reason}`, enteredBy: ctx.userId, approvedBy: opened.decision.decidedBy,
          unitCostMinor: unitCost.minor, ...(unitCost.per === undefined ? {} : { unitCostPer: unitCost.per }),
          ...(batchId === undefined ? {} : { batchId }), ...(line.expiry === null || deltaMinor < 0 ? {} : { expiry: line.expiry }),
        };
        await opened.spend();
        let numbered: { readonly documentNumber?: string };
        try {
          numbered = await deps.commitCorrection(ctx.tenantId, correction, movement, orderCorrected && version !== undefined ? { poId: rec.poId!, expectedVersion: version } : undefined);
        } catch (err) {
          if (err instanceof ConcurrencyConflictError) throw concurrentChange(`purchase order ${rec.poId ?? ''} (a receipt, cancellation or change landed on it a moment ago — look again and correct again)`);
          throw err;
        }
        const saved: StoredReceiptCorrection = numbered.documentNumber === undefined ? correction : { ...correction, documentNumber: numbered.documentNumber };
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'goods_receipt.correct', objectType: 'goods_receipt', objectId: grnId,
          at, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: { lineId: line.lineId, quantityMinor: String(wasMinor) },
          after: {
            correctionId, documentNumber: saved.documentNumber ?? '', receiptNumber, lineId: line.lineId, quantityMinor: String(saved.nowMinor),
            deltaMinor: String(deltaMinor), valueMinor: String(valueMinor), approvedBy: saved.approvedBy, orderCorrected: String(orderCorrected),
            billExceptions: billExceptions.map((x) => `${x.invoiceId}:${x.kind}${x.paid ? ':paid' : ''}`).join(','),
          },
          reason, correlationId: grnId,
        });
        return { status: 201, body: { correction: saved } };
      },
    },
    {
      // A receipt's corrections, oldest first, with the quantity in stock from each line now — the receipt screen shows the
      // original and every correction beside it.
      api: 'API-04', method: 'GET', path: '/v1/inventory/goods-receipt/:grnId/corrections',
      permission: 'inventory.availability.read',
      handler: async (ctx) => {
        const grnId = (ctx.params['grnId'] ?? '').trim();
        const rec = await deps.grn(ctx.tenantId, grnId);
        if (rec === undefined) throw notFound(`goods receipt ${grnId}`);
        await assertLocationInScope(ctx, rec.warehouseId, deps.locationBranches);
        const mine = (await deps.corrections(ctx.tenantId)).filter((c) => c.grnId === grnId);
        const receiptNumber = rec.documentNumber ?? rec.number;
        // OB-875 B: the screen says, as soon as the receipt is opened, when its month is filed or signed.
        const lock = deps.monthState === undefined ? { locked: false as const } : receiptMonthLock(receiptNumber, await deps.monthState(ctx.tenantId, receiptMonthOf(rec)));
        return {
          status: 200,
          body: {
            grnId, receiptNumber,
            ...(lock.locked ? { monthLocked: { period: lock.period, why: lock.why, says: lock.says } } : {}),
            lines: rec.captured.lines.map((l) => ({ lineId: l.lineId, productId: l.productId, uom: l.uom, receivedMinor: l.sellableMinor, nowMinor: correctedSellable(rec, mine)[l.lineId] ?? l.sellableMinor })),
            corrections: mine, openBillExceptions: mine.flatMap((c) => c.billExceptions.map((x) => ({ ...x, correctionId: c.correctionId, documentNumber: c.documentNumber ?? c.correctionId }))),
            asAt: deps.now(),
          },
        };
      },
    },
  ];
}
