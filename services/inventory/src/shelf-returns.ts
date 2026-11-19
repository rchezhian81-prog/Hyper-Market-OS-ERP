// S1 · batch 18c — RETURN SHELF STOCK TO THE SUPPLIER: expired, near-expiry or damaged stock found on the shelf or in the
// back store goes back to the supplier (roadmap §29 `purchase_return` · §30 API-03 "return/claim" · M10-FR-01 · OB-872,
// decided under OB-801).
//
// Before this a return to the supplier was offered only for goods held at the door (a quarantined receipt line, a rejected
// over-delivery) and for customer returns; stock already on the shelf could only be marked down, written off or released.
// Now one save, from the Expiry or Quarantine page, does all of it:
//
//   • the return gets its own number in the store's return-to-supplier range (`RTS1/26-27/00001`) — the same range a
//     return from the goods-receipt page takes — in the SAME atomic save as everything below (hard rule #2);
//   • the stock leaves by a `returned_to_supplier` ledger movement (a compensating movement, never an edit), off the batch
//     when one is named; a return of more than is on hand there is refused in plain words, nothing saved;
//   • the supplier's debit note is raised and ISSUED in the same save under the shop's one debit-note range
//     (`SDN/26-27/00001`, the existing path's `recordNumberedDebitNoteIssue` numbering), valued at the stock's own average
//     cost. OB-874 C (owner, 19 Nov 2026): the note is SHOWN on the supplier's account and NOT netted from what is owed
//     until the supplier accepts it (P-08 — said on the account in words: "waiting for the supplier to accept");
//   • above the e-way-bill limit the goods leave only under a GENERATED e-way bill for this return's movement — the same
//     tested rule (`checkDispatchEwb`) a return from the goods-receipt page passes; refused by name otherwise;
//   • it needs the same approval as a write-off of that value (OB-872): at or above the shop's write-off threshold — or
//     when head office holds no cost for the stock — a second person who handles stock approves exactly this return
//     (an approval of kind `stock_write_off`, never the person who raised it); below it, the raiser's own act.
//
// The raiser is the authenticated caller. Every return is sealed on the audit trail with who, what, why and the approver.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { DEFAULT_WRITE_OFF_THRESHOLD_MINOR } from '../../../packages/waste/src/waste';
import type { DispatchEwbVerdict } from '../../../packages/e-way-bill/src/index';
import { actionDetails, approvalNamedIn, type ApprovalPort } from '../../identity/src/approval-requests';
import { assertLocationInScope, stockReadScope, type LocationBranches } from './location-scope';
import { assertNotFrozenByCount, type CountFreezeCheck } from './count-freeze';
import { lossValueOf } from './write-off';

/** Why the stock goes back. */
export const SHELF_RETURN_REASONS = Object.freeze(['expired', 'near_expiry', 'damaged'] as const);
export type ShelfReturnReason = (typeof SHELF_RETURN_REASONS)[number];

/** A return to the supplier of stock that was on the shelf, as it is stored and read back. */
export interface StoredShelfReturn {
  readonly returnId: string;
  /** `RTS1/26-27/00001` — the store's return-to-supplier range, taken in the same save. */
  readonly documentNumber?: string;
  readonly productId: string;
  readonly locationId: string;
  readonly batchId?: string;
  readonly quantityMinor: number;
  readonly uom: string;
  readonly supplierId: string;
  readonly reason: ShelfReturnReason;
  readonly note?: string;
  /** The goods at the stock's own average cost (before GST). */
  readonly valueMinor: number;
  readonly currency: 'INR';
  /** `stock_cost` — head office's own cost; `cost_unknown` — the raiser's stated value (always needed a second person). */
  readonly valueSource: 'stock_cost' | 'cost_unknown';
  readonly unitCostMinor?: number;
  readonly raisedBy: string;
  readonly approvedBy: string | null;
  readonly requiredApproval: boolean;
  readonly at: string;
  readonly movementId: string;
  /** The e-way bill the goods left under (null when the value is at or below the limit). */
  readonly ewbNo: string | null;
  readonly ewbThresholdMinor: number;
  /** The supplier's debit note: its reference on the account and its SDN number, issued in the same save. */
  readonly debitNote: { readonly debitNoteRef: string; readonly number?: string; readonly valueMinor: number; readonly gstTreatment: 'not_decided' };
}

export interface ShelfReturnDeps {
  readonly returns: (tenantId: string) => Promise<readonly StoredShelfReturn[]> | readonly StoredShelfReturn[];
  /** Record the return, its stock movement and its issued debit note in ONE atomic save, each with its number. */
  readonly recordShelfReturn: (tenantId: string, rec: StoredShelfReturn) => Promise<{ readonly documentNumber?: string; readonly debitNoteNumber?: string }>;
  /** What is on hand of the product at the place — of the batch when one is named. */
  readonly onHandAt: (tenantId: string, productId: string, locationId: string, batchId?: string) => Promise<number> | number;
  readonly unitCostAt?: (tenantId: string, locationId: string, productId: string) => Promise<number | undefined> | number | undefined;
  readonly writeOffThreshold: (tenantId: string) => Promise<number | undefined> | number | undefined;
  /** The supplier master's word on the supplier: active (approved), proposed (waiting), or unknown. */
  readonly supplierStatus: (tenantId: string, supplierId: string) => Promise<'active' | 'proposed' | undefined> | 'active' | 'proposed' | undefined;
  /** The e-way-bill rule for the goods leaving (the supplier-return gate's `checkDispatchEwb`, from the place to the supplier). */
  readonly ewbGate?: (tenantId: string, input: { readonly locationId: string; readonly supplierId: string; readonly movementId: string; readonly valueMinor: number }) => Promise<DispatchEwbVerdict> | DispatchEwbVerdict;
  readonly approvals?: ApprovalPort;
  readonly locationBranches?: LocationBranches;
  readonly countFreeze?: CountFreezeCheck;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isPosInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const rupees = (m: number): string => `₹${(m / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The ledger movement a shelf return's goods leave by — also the e-way bill's movement id. */
export const shelfReturnMovementId = (returnId: string): string => `shelf-return-${returnId}`;
/** The debit note's reference on the supplier's account. */
export const shelfReturnDebitNoteRef = (returnId: string): string => `DN-RTS-${returnId}`;

export function shelfReturnRoutes(deps: ShelfReturnDeps): readonly Route[] {
  return [
    {
      api: 'API-04', method: 'POST', path: '/v1/inventory/shelf-returns/:returnId',
      permission: 'inventory.movement.append', idempotent: true,
      handler: async (ctx) => {
        const returnId = (ctx.params['returnId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (returnId === '' || !isStr(b['productId']) || !isStr(b['locationId']) || !isPosInt(b['qty']) || !isStr(b['uom']) || !isStr(b['supplierId'])
          || !(SHELF_RETURN_REASONS as readonly unknown[]).includes(b['reason'])
          || (b['batchId'] !== undefined && b['batchId'] !== null && !isStr(b['batchId']))
          || (b['note'] !== undefined && typeof b['note'] !== 'string')
          || (b['valueMinor'] !== undefined && !(Number.isSafeInteger(b['valueMinor']) && (b['valueMinor'] as number) >= 0))) {
          throw apiError(400, {
            code: 'not_readable_as_a_shelf_return',
            whatHappened: `A return to the supplier needs the item, the place, a whole quantity above 0, its unit, the supplier, and why it goes back (${SHELF_RETURN_REASONS.join(' / ')}).`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Fill in every box and send it again. Nothing was returned.',
          });
        }
        const productId = (b['productId'] as string).trim();
        const locationId = (b['locationId'] as string).trim();
        const supplierId = (b['supplierId'] as string).trim();
        const batchId = isStr(b['batchId']) ? (b['batchId'] as string).trim() : undefined;
        const qty = b['qty'] as number;
        const uom = (b['uom'] as string).trim();
        const reason = b['reason'] as ShelfReturnReason;
        const note = typeof b['note'] === 'string' && b['note'].trim() !== '' ? b['note'].trim() : undefined;

        const done = (await deps.returns(ctx.tenantId)).find((r) => r.returnId === returnId);
        if (done !== undefined) {
          if (done.raisedBy === ctx.userId && done.productId === productId && done.quantityMinor === qty && done.supplierId === supplierId) {
            return { status: 200, body: { shelfReturn: done, alreadyRecorded: true } };
          }
          throw apiError(409, {
            code: 'shelf_return_already_recorded',
            whatHappened: `Return ${done.documentNumber ?? returnId} is already recorded — a return id is used once.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Start a new return. Nothing was changed.',
          });
        }
        await assertLocationInScope(ctx, locationId, deps.locationBranches);
        await assertNotFrozenByCount(deps.countFreeze, ctx.tenantId, [{ productId, locationId, kind: 'returned_to_supplier' }], 'return to the supplier');

        const status = await deps.supplierStatus(ctx.tenantId, supplierId);
        if (status !== 'active') {
          throw apiError(422, {
            code: status === undefined ? 'supplier_unknown' : 'supplier_not_approved',
            whatHappened: status === undefined ? `There is no supplier "${supplierId}" in the supplier master.` : `Supplier "${supplierId}" is still waiting for finance to approve it.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Choose the supplier the goods came from, from the list. Nothing was returned.',
          });
        }
        // Never more than is there: the return cannot take stock below nothing.
        const onHand = await deps.onHandAt(ctx.tenantId, productId, locationId, batchId);
        if (qty > onHand) {
          throw apiError(422, {
            code: 'more_than_on_hand',
            whatHappened: `Only ${onHand} of ${productId}${batchId === undefined ? '' : ` (batch ${batchId})`} is on hand at ${locationId}, so ${qty} cannot go back to the supplier.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Count what is really there and return that many. Nothing was returned.',
          });
        }
        // The value is head office's own (quantity × the stock's average cost there) — or, when it holds none, the raiser's
        // stated value, which then always needs a second person (as a write-off does).
        const priced = await lossValueOf(deps, ctx.tenantId, productId, locationId, qty, uom);
        if (!priced.known && b['valueMinor'] === undefined) {
          throw apiError(422, {
            code: 'shelf_return_cost_unknown',
            whatHappened: `Head office holds no cost for ${productId} at ${locationId}, so it cannot value this return or its debit note itself.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Type the value from the supplier\'s bill; a second person then approves the return. Nothing was returned.',
          });
        }
        const valueMinor = priced.known ? priced.valueMinor : (b['valueMinor'] as number);
        const thresholdMinor = priced.known ? ((await deps.writeOffThreshold(ctx.tenantId)) ?? DEFAULT_WRITE_OFF_THRESHOLD_MINOR) : 0;
        const needsApproval = valueMinor >= thresholdMinor;
        const at = deps.now();
        // OB-872: the same approval as a write-off of this value — a `stock_write_off` approval another person who handles
        // stock gave in their own session for exactly this return, never the raiser.
        const opened = await approvalNamedIn(deps.approvals, {
          tenantId: ctx.tenantId, approvalId: b['approvalId'], typedField: 'approvedBy', typedValue: b['approvedBy'],
          kind: 'stock_write_off', subjectRef: returnId, details: actionDetails(ctx.body, { returnId }), valueMinor,
          maker: ctx.userId, usedBy: `shelf-return:${returnId}`, now: at,
        });
        if (needsApproval && opened === undefined) {
          throw apiError(422, {
            code: 'shelf_return_needs_approval',
            whatHappened: `This return is worth ${rupees(valueMinor)}${priced.known ? `, at or above the write-off limit of ${rupees(thresholdMinor)}` : ' (head office holds no cost for it)'}, so a second person who handles stock approves it first — the same as a write-off of that value. The person who raised it cannot approve it.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Press "Ask for approval"; once another person approves it, press Return to supplier again. Nothing was returned.',
          });
        }
        const movementId = shelfReturnMovementId(returnId);
        // The e-way-bill rule for goods leaving the shop (the same tested gate as a return from the goods-receipt page).
        let ewbNo: string | null = null;
        let ewbThresholdMinor = 0;
        if (deps.ewbGate !== undefined) {
          const verdict = await deps.ewbGate(ctx.tenantId, { locationId, supplierId, movementId, valueMinor });
          if (verdict.outcome === 'refused') {
            throw apiError(422, {
              code: 'ewb_required',
              whatHappened: `${verdict.detail} The e-way bill is generated for movement ${movementId}.`,
              wasItSaved: 'not_saved',
              nextSafeAction: `Generate the e-way bill for movement ${movementId} on the E-way bills page, then press Return to supplier again. Nothing was returned.`,
            });
          }
          ewbNo = verdict.outcome === 'covered' ? verdict.ewbNo : null;
          ewbThresholdMinor = verdict.thresholdMinor;
        }
        await opened?.spend();
        const rec: StoredShelfReturn = {
          returnId, productId, locationId, ...(batchId === undefined ? {} : { batchId }), quantityMinor: qty, uom, supplierId, reason,
          ...(note === undefined ? {} : { note }), valueMinor, currency: 'INR',
          valueSource: priced.known ? 'stock_cost' : 'cost_unknown', ...(priced.known ? { unitCostMinor: priced.unitCostMinor } : {}),
          raisedBy: ctx.userId, approvedBy: opened?.decision.decidedBy ?? null, requiredApproval: needsApproval, at, movementId,
          ewbNo, ewbThresholdMinor,
          debitNote: { debitNoteRef: shelfReturnDebitNoteRef(returnId), valueMinor, gstTreatment: 'not_decided' },
        };
        const numbered = await deps.recordShelfReturn(ctx.tenantId, rec);
        const saved: StoredShelfReturn = {
          ...rec, ...(numbered.documentNumber === undefined ? {} : { documentNumber: numbered.documentNumber }),
          debitNote: { ...rec.debitNote, ...(numbered.debitNoteNumber === undefined ? {} : { number: numbered.debitNoteNumber }) },
        };
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'stock.return_to_supplier', objectType: 'product', objectId: productId,
          at, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: null,
          after: {
            returnId, documentNumber: saved.documentNumber ?? '', supplierId, locationId, batchId: batchId ?? '', quantityMinor: String(qty),
            valueMinor: String(valueMinor), reason, approvedBy: saved.approvedBy ?? '', debitNote: saved.debitNote.number ?? '', ewbNo: ewbNo ?? '',
          },
          reason: note ?? reason, correlationId: returnId,
        });
        return { status: 201, body: { shelfReturn: saved } };
      },
    },
    {
      // Every shelf return on file, newest first — what the Expiry and Quarantine pages list under the form.
      api: 'API-04', method: 'GET', path: '/v1/inventory/shelf-returns',
      permission: 'inventory.availability.read',
      handler: async (ctx) => {
        const scope = await stockReadScope(ctx, deps.locationBranches);
        const all = (await deps.returns(ctx.tenantId)).filter((r) => scope.everything || scope.covers(r.locationId));
        const rows = [...all].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
        return { status: 200, body: { returns: rows, count: rows.length, asAt: deps.now() } };
      },
    },
  ];
}
