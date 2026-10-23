// API-04 warehouse-to-store & inter-store transfers (M09-FR-03 / WF-07). A transfer is the one stock
// movement that is in two places at once, and that is where shops lose it. So it moves through an
// explicit IN-TRANSIT state held AT THE DESTINATION — visible, owned, and deliberately not sellable
// until received (the van is a place). Two refusals matter more than they look, and both are the
// engine's: QUARANTINED/EXPIRED/RECALLED stock is never transferred (moving a problem to another branch
// launders it), and a RECEIPT SHORTFALL is a VALUED exception, never a silent adjustment (stock that
// left and never arrived is a miscount or a theft, and both need a name). Dispatch needs a SEPARATE
// approver (§28); allocation only ever proposes.
//
// The rules are the pure `dispatchTransfer` / `receiveTransfer` / `proposeAllocation` engines in
// `packages/warehouse`. This surface gives them the transfer aggregate lifecycle and the reads.
//
// SP-4 (audit finding F07): until this slice the dispatch took `approvedBy` and the `available` lots FROM THE BODY — a
// never-provisioned name could approve, and a fictitious quantity could permit an over-draw. Now the approver is the
// AUTHENTICATED dispatcher (who must not be the proposer, §28 — the engine's own check) and the available stock is head
// office's own position at the source, with recalled batches and quality holds read from their registers. A body that
// still carries either claim is refused by name, never quietly ignored (P-08).
//
// SP-5 (audit finding F05): until this slice the engine's movements rode the transfer events as EVIDENCE and never
// reached the M08 inventory projection — a received transfer left availability and valuation at the source with no row
// at the destination, and every reader of stock (availability, valuation, ageing, reorder, the pack) was wrong by the
// transfer. Now each step posts ONE authoritative effect to the M08 ledger, atomically with its transfer event and
// idempotent on the transfer step (the movement ids are the engine's own):
//   • dispatch → `transferred_out` at the SOURCE per line: on-hand falls where the stock left; its value leaves at the
//     source's average and is booked as moved, not sold (`transferredOut`, never COGS). The quantity is now IN TRANSIT,
//     visible at the destination on the availability read (`inTransit`) and deliberately not on-hand there (M08-FR-02).
//   • receive → `transferred_in` at the DESTINATION for what ARRIVED, carrying the source's unit cost so the value that
//     left is the value that arrives (re-averaged there). A SHORTFALL posts nothing on-hand anywhere — it is the valued
//     exception the engine raised, listed on the exceptions read (`transferShortfalls`) until a person owns it.
// The over-draw is refused against the STORED position (SP-4), which now falls at dispatch, so a second transfer cannot
// draw the same stock twice. A destination head office has no record of is refused by name (`unknown_location`).

import type { Route } from '../../kernel/src/index';
import { apiError, concurrentChange, notFound } from '../../kernel/src/index';
import { ConcurrencyConflictError } from '../../../packages/persistence/src/event-store';
import {
  dispatchTransfer, receiveTransfer, proposeAllocation, TransferRefusedError, judgeShortfallResolution, costedResolution,
  type Transfer, type TransferLine, type TransferApproval, type AvailableLot, type AllocationNeed,
  type FoundLine, type ShortfallLine, type ShortfallResolution, type ShortfallRefusal, type TransferRelay,
} from '../../../packages/warehouse/src/transfers';
import { isAdjustmentReason, ADJUSTMENT_REASON_CODES } from '../../../packages/adjustment/src/adjustment';
import type { StockMovement } from '../../../packages/stock/src/position';
import { isCurrencyCode, type CurrencyCode } from '../../../packages/contracts/src/money';
import { checkMovement, type Movement } from './index';
import { normaliseUom } from '../../../packages/contracts/src/quantity';
import { assertLocationInScope, locationInScope, type LocationBranches } from './location-scope';
import { assertNotFrozenByCount, type CountFreezeCheck } from './count-freeze';
import { outsideBranchScope, type RequestContext } from '../../kernel/src/index';
import type { DispatchEwbVerdict } from '../../../packages/e-way-bill/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';

/**
 * PA-01-r1: a transfer is the business of the branches at its two ends. Proposing or reading one needs either end in the
 * caller's branches; dispatching needs the SOURCE (the stock leaves there); receiving needs the DESTINATION.
 */
async function assertEitherEndInScope(
  ctx: Pick<RequestContext, 'scope' | 'tenantId'>, branches: LocationBranches | undefined, fromLocationId: string, toLocationId: string,
): Promise<void> {
  if (await locationInScope(ctx, fromLocationId, branches) || await locationInScope(ctx, toLocationId, branches)) return;
  throw outsideBranchScope(fromLocationId);
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isInt = (v: unknown): v is number => Number.isInteger(v);
const isPosInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
const rec = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Batch 2: what the resolver says turned up — [{ productId, batchId?, foundMinor (whole, zero or more), foundAtLocationId? }]. */
export function readFound(v: unknown): FoundLine[] | undefined {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return undefined;
  const out: FoundLine[] = [];
  for (const raw of v) {
    if (!isObj(raw) || !isStr(raw['productId']) || !isInt(raw['foundMinor']) || (raw['foundMinor'] as number) < 0
      || (raw['batchId'] !== undefined && raw['batchId'] !== null && !isStr(raw['batchId']))
      || (raw['foundAtLocationId'] !== undefined && !isStr(raw['foundAtLocationId']))) return undefined;
    const batchId = isStr(raw['batchId']) ? raw['batchId'] : null;
    if (out.some((f) => f.productId === raw['productId'] && f.batchId === batchId)) return undefined; // one line per product and batch
    out.push({ productId: raw['productId'], batchId, foundMinor: raw['foundMinor'] as number, ...(isStr(raw['foundAtLocationId']) ? { foundAtLocationId: raw['foundAtLocationId'] } : {}) });
  }
  return out;
}

/** The same resolution again? Same reason and the same found figures per line — the replay answer, not a second truth. */
export const sameResolution = (prior: ShortfallResolution, reasonCode: string, found: readonly FoundLine[]): boolean =>
  prior.reasonCode === reasonCode
  && prior.lines.every((l) => l.foundMinor === (found.find((f) => f.productId === l.productId && f.batchId === l.batchId)?.foundMinor ?? 0));

/**
 * Batch 2: the compensating movements for units that TURNED UP — `adjusted` at the place they were found, at the quantity
 * found. Two people, as every `adjusted` movement needs (§28 · `checkMovement`): raised by the count that said they were
 * missing (the receiver), approved by the resolver. Keyed on the transfer, so a replay cannot post twice.
 */
export function foundPostings(transfer: Transfer, issue: { readonly receivedBy?: string }, resolution: ShortfallResolution): Movement[] {
  return resolution.lines.filter((l) => l.foundMinor > 0).map((l, i): Movement => ({
    movementId: `${transfer.transferId}-found-${i + 1}`, productId: l.productId, locationId: l.foundAtLocationId ?? transfer.toLocationId, kind: 'adjusted',
    quantityMinor: l.foundMinor, uom: transfer.lines.find((t) => t.productId === l.productId && t.batchId === l.batchId)?.uom ?? 'EA',
    occurredAt: resolution.resolvedAt, enteredBy: issue.receivedBy ?? resolution.resolvedBy, approvedBy: resolution.resolvedBy,
    reason: `transfer ${transfer.transferId} shortfall resolved by ${resolution.resolvedBy}: ${l.foundMinor} of ${l.missingMinor} found at ${l.foundAtLocationId ?? transfer.toLocationId} (${resolution.reasonCode}) — ${resolution.note}`,
    ...(l.batchId === null ? {} : { batchId: l.batchId }),
  }));
}

export interface TransfersDeps {
  /** PA-01-r1: which branch a location belongs to (the org hierarchy); absent → a location is its own branch key. */
  readonly locationBranches?: LocationBranches;
  readonly transfer: (tenantId: string, transferId: string) => Promise<Transfer | undefined> | Transfer | undefined;
  /** Round 12 (WF-07 screen): every transfer on file, in the order first recorded (absent on a bare stub — none listed). */
  readonly transfers?: (tenantId: string) => Promise<readonly Transfer[]> | readonly Transfer[];
  /**
   * SP-4 (F07): head office's OWN stock at the source for the transfer's lines — the on-hand position per product, the
   * batch's recall and quality-hold state read from their registers. Never the body's word.
   */
  readonly availableAt: (tenantId: string, fromLocationId: string, lines: readonly TransferLine[]) => Promise<readonly AvailableLot[]> | readonly AvailableLot[];
  readonly recordProposed: (tenantId: string, transfer: Transfer) => Promise<void> | void;
  /**
   * SP-5 (F05): record the dispatched aggregate AND append its M08 movements (`transferred_out` at the source) in ONE
   * atomic write, each movement idempotent on its own id — a crash between the two must never leave a transfer in
   * transit whose stock is still on the source's shelf, or the reverse.
   */
  /** The source location's stock write-guard version (Wave 2a · audit SF-04): read BEFORE `availableAt`, passed back to
   *  `recordDispatched`; two transfers that both read the same stock cannot both leave — the second is refused by name. */
  readonly stockVersion?: (tenantId: string, locationId: string) => Promise<number> | number;
  readonly recordDispatched: (tenantId: string, transfer: Transfer, movements: readonly StockMovement[], posted: readonly Movement[], expectedVersion?: number) => Promise<void> | void;
  /** SP-5 (F05): the received aggregate AND its `transferred_in` movements at the destination, atomically. */
  readonly recordReceived: (tenantId: string, transfer: Transfer, movements: readonly StockMovement[], discrepancies: unknown, posted: readonly Movement[]) => Promise<void> | void;
  /**
   * SP-5 (F05): head office's own unit cost for the product AT this location — the weighted average of what is held there
   * — or `undefined` when that stock is unvalued. The value that leaves the source is the value that arrives.
   */
  readonly unitCostAt: (tenantId: string, locationId: string, productId: string) => Promise<number | undefined> | number | undefined;
  /**
   * SP-5: is this a place head office has ANY record of — an org node (branch / warehouse / department), a location a bin
   * belongs to, or a location that has ever held stock? A transfer to a place nobody reads strands the stock (P-08).
   */
  readonly knownLocation: (tenantId: string, locationId: string) => Promise<boolean> | boolean;
  /**
   * SF-03 — the unit the PRODUCT MASTER counts this product in, or `undefined` when the master does not know the product.
   * A line in another unit (a "case" of what is stocked in "each") would move the wrong quantity, so it is refused.
   */
  readonly productUom?: (tenantId: string, productId: string) => Promise<string | undefined> | string | undefined;
  /** Batch 2: the valued shortfall a received transfer's count raised (from its receipt record); empty when none. */
  readonly shortfallOf?: (tenantId: string, transferId: string) => Promise<readonly ShortfallLine[]> | readonly ShortfallLine[];
  /** Batch 2: true when the transfer travels for a floor indent — its shortfall is resolved on the indent, not here. */
  readonly belongsToIndent?: (tenantId: string, transferId: string) => Promise<boolean> | boolean;
  /** Batch 2: the transfer's own write guard — two resolutions cannot both land. Optional on a bare stub. */
  readonly transferVersion?: (tenantId: string, transferId: string) => Promise<number> | number;
  /** Batch 2: the resolved transfer and the found units' compensating movements — ONE atomic write. */
  readonly recordShortfallResolved?: (tenantId: string, transfer: Transfer, posted: readonly Movement[], expectedVersion?: number) => Promise<void> | void;
  /** WF-08 / OB-59: which open count plan freezes an adjustment here (absent on a bare stub — nothing is frozen). */
  readonly countFreeze?: CountFreezeCheck;
  /**
   * R3 · A23: may these goods leave — above the e-way-bill threshold only with a generated e-way bill for the transfer's
   * movement. Absent on a bare stub (then not checked); the running system provides it.
   */
  readonly ewayBillGate?: (tenantId: string, transfer: Transfer, lineCostsMinor: readonly (number | null)[]) => Promise<DispatchEwbVerdict> | DispatchEwbVerdict;
  readonly now: () => string;
}

const SHORTFALL_STATUS: Readonly<Record<ShortfallRefusal, number>> = Object.freeze({
  nothing_short: 409, shortfall_already_resolved: 409, counter_cannot_resolve: 422, issuer_cannot_resolve: 422, not_on_shortfall: 422, more_found_than_missing: 422,
});

/** SF-03 — each line's unit against the product master's; the first that disagrees is refused by name (422). */
async function assertUnitsAreTheProducts(deps: TransfersDeps, tenantId: string, lines: readonly Pick<TransferLine, 'productId' | 'uom'>[]): Promise<void> {
  if (deps.productUom === undefined) return;
  for (const line of lines) {
    const uom = await deps.productUom(tenantId, line.productId);
    // OB-31: judged on the one spelling (ea/each/EA are the same unit), never on how it was typed.
    if (uom !== undefined && (normaliseUom(uom) ?? uom) !== (normaliseUom(line.uom) ?? line.uom)) {
      throw apiError(422, {
        code: 'unit_not_the_products',
        whatHappened: `${line.productId} is counted in "${uom}" on the product master, but this transfer line says "${line.uom}" — the quantity would mean something different at each end.`,
        wasItSaved: 'not_saved',
        nextSafeAction: `Send the line in "${uom}". Nothing was recorded or moved.`,
      });
    }
  }
}

/**
 * The M08 movements a dispatch posts (SP-5 · F05): ONE `transferred_out` per line at the SOURCE, under the engine's own
 * `-out-` movement id, so a re-run of the same dispatch is the same movement (§31.1). Entered by the dispatcher.
 */
export function dispatchPostings(transfer: Transfer, movements: readonly StockMovement[], enteredBy: string): readonly Movement[] {
  return movements
    .filter((m) => m.from === 'on_hand' && m.to === null && m.locationId === transfer.fromLocationId)
    .map((m): Movement => ({
      movementId: m.movementId, productId: m.productId, locationId: m.locationId, kind: 'transferred_out',
      quantityMinor: m.quantityMinor, uom: m.uom, occurredAt: m.at, enteredBy,
      reason: `transfer ${transfer.transferId} dispatched to ${transfer.toLocationId}`,
      ...(m.batchId === null ? {} : { batchId: m.batchId }),
    }));
}

/**
 * The M08 movements a receipt posts (SP-5 · F05): ONE `transferred_in` per line at the DESTINATION for what ARRIVED, under
 * the engine's own `-recv-` id, carrying the source's unit cost recorded at dispatch (`lineCostsMinor`) so the value
 * follows the stock. A shortfall posts NOTHING — it is the valued exception, never a quiet adjustment.
 */
export function receivePostings(transfer: Transfer, movements: readonly StockMovement[], receivedBy: string): readonly Movement[] {
  return movements
    .filter((m) => m.from === 'in_transit' && m.to === 'on_hand' && m.locationId === transfer.toLocationId)
    .map((m): Movement => {
      const i = transfer.lines.findIndex((l) => l.productId === m.productId && l.batchId === m.batchId);
      const cost = i >= 0 ? transfer.lineCostsMinor?.[i] ?? null : null;
      return {
        movementId: m.movementId, productId: m.productId, locationId: m.locationId, kind: 'transferred_in',
        quantityMinor: m.quantityMinor, uom: m.uom, occurredAt: m.at, enteredBy: receivedBy,
        reason: `transfer ${transfer.transferId} received from ${transfer.fromLocationId}`,
        ...(m.batchId === null ? {} : { batchId: m.batchId }),
        ...(cost === null ? {} : { unitCostMinor: cost }),
      };
    });
}

/** A proposed line as read from the body — WITHOUT a cost: the cost is head office's (round 10), never the proposer's. */
type ProposedLine = Omit<TransferLine, 'unitCost'>;

function readLines(v: unknown): { lines: ProposedLine[]; callerSentCost: boolean } | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const lines: ProposedLine[] = [];
  let callerSentCost = false;
  for (const raw of v) {
    const l = rec(raw);
    if (l === null || !isStr(l['productId']) || !isPosInt(l['quantityMinor']) || !isStr(l['uom'])
      || (l['batchId'] !== null && l['batchId'] !== undefined && !isStr(l['batchId']))) return null;
    if (l['unitCost'] !== undefined) callerSentCost = true;
    lines.push({ productId: l['productId'] as string, batchId: isStr(l['batchId']) ? (l['batchId'] as string) : null, quantityMinor: l['quantityMinor'] as number, uom: l['uom'] as string });
  }
  return { lines, callerSentCost };
}

const refused = (why: string): never => {
  throw apiError(422, { code: 'transfer_refused', whatHappened: why, wasItSaved: 'not_saved', nextSafeAction: 'Nothing was moved.' });
};

/** OB-288 lane 2: the refusal for any step on a transfer that was cancelled before it left (WF-07 cancellation). */
function cancelledRefusal(transfer: Transfer): ReturnType<typeof apiError> {
  return apiError(422, {
    code: 'transfer_cancelled',
    whatHappened: `Transfer ${transfer.transferId} was cancelled${transfer.cancelledBy === undefined ? '' : ` by ${transfer.cancelledBy}`}${transfer.cancelledAt === undefined ? '' : ` at ${transfer.cancelledAt}`} before it left${transfer.cancelReason === undefined ? '' : ` ("${transfer.cancelReason}")`}. Nothing can be sent or counted in on it.`,
    wasItSaved: 'not_saved',
    nextSafeAction: 'If the goods really moved, a person must look at this: propose a new transfer for what moved. Nothing was moved.',
  });
}

/**
 * The DISPATCH itself (M09-FR-03 · §28 · SP-4/SP-5): the approver is `dispatcher`, the stock is head office's own at the
 * source, the value that leaves is the source's own average, an e-way bill is required above the threshold, a count freeze
 * holds it, and the aggregate and its M08 movements are ONE atomic write under the source's stock guard. Shared by the
 * direct route (the authenticated dispatcher, head office's clock) and the synced route (the person the store computer
 * verified, the time it was done at the store) — one engine, one set of refusals (OB-288 lane 2, WF-07 offline).
 */
export async function dispatchCore(deps: TransfersDeps, tenantId: string, transfer: Transfer, dispatcher: string, at: string, relay?: TransferRelay): Promise<Record<string, unknown>> {
  const transferId = transfer.transferId;
  // SF-03: a transfer proposed before the unit check is checked again before anything moves.
  await assertUnitsAreTheProducts(deps, tenantId, transfer.lines);
  const approval: TransferApproval = { subjectRef: transferId, status: 'approved', decidedBy: dispatcher };
  // The guard version first, then the stock it protects (Wave 2a · SF-04).
  const expectedVersion = deps.stockVersion === undefined ? undefined : await Promise.resolve(deps.stockVersion(tenantId, transfer.fromLocationId));
  const available = await deps.availableAt(tenantId, transfer.fromLocationId, transfer.lines);
  try {
    const result = dispatchTransfer({ transfer, approval, available, at });
    // SP-5 (F05): the value that leaves is head office's own average at the source, recorded per line on the
    // aggregate so the receipt re-enters it at the destination — never the proposer's figure.
    const lineCostsMinor: (number | null)[] = [];
    for (const line of transfer.lines) lineCostsMinor.push((await deps.unitCostAt(tenantId, transfer.fromLocationId, line.productId)) ?? null);
    // R3 · A23: above the e-way-bill threshold the goods leave only under a GENERATED e-way bill — refused by name
    // otherwise, before anything moves; with one, the transfer carries its number.
    const ewb = deps.ewayBillGate === undefined ? undefined : await Promise.resolve(deps.ewayBillGate(tenantId, transfer, lineCostsMinor));
    if (ewb?.outcome === 'refused') {
      throw apiError(409, {
        code: ewb.code,
        whatHappened: `Transfer ${transferId} cannot leave without an e-way bill: ${ewb.detail}.`,
        wasItSaved: 'not_saved',
        nextSafeAction: `Generate the e-way bill for movement ${ewb.movementId} (POST /v1/finance/e-way-bill/movements/${ewb.movementId}/submit, then the portal's answer), then dispatch again. Nothing was moved.`,
      });
    }
    const dispatched: Transfer = {
      ...result.transfer, lineCostsMinor,
      ...(ewb?.outcome === 'covered' ? { ewayBill: { movementId: ewb.movementId, ewbNo: ewb.ewbNo } } : {}),
      ...(relay === undefined ? {} : { dispatchRelay: relay }),
    };
    const posted = dispatchPostings(dispatched, result.movements, dispatcher);
    // WF-08 / OB-59: stock leaving a place where an open count froze `transferred_out` for the product is refused by
    // name, like every other direct head-office movement (the default freeze — adjustments and write-offs — leaves a
    // dispatch alone). Nothing moves; a relayed record would be kept and shown instead.
    await assertNotFrozenByCount(deps.countFreeze, tenantId, posted, 'transfer dispatch');
    await deps.recordDispatched(tenantId, dispatched, result.movements, posted, expectedVersion);
    return { transferId, state: dispatched.state, approvedBy: dispatched.approvedBy, movements: result.movements.length, posted: posted.map((m) => m.movementId), lineCostsMinor, ...(ewb === undefined ? {} : { ewayBill: ewb }), availableChecked: available.map((l) => ({ productId: l.productId, batchId: l.batchId, quantityMinor: l.quantityMinor, state: l.state, recalled: l.recalled === true })) };
  } catch (e) {
    if (e instanceof TransferRefusedError) refused(e.why);
    // Another movement out of this stock landed first (Wave 2a · SF-04): this dispatch was decided on a figure that
    // is no longer true — nothing moved; the approver re-reads. Never two transfers of the same stock.
    if (e instanceof ConcurrencyConflictError) throw concurrentChange(`the stock at ${transfer.fromLocationId}`);
    throw e;
  }
}

/**
 * The RECEIPT itself (M09-FR-03 · §28 · SP-5): the dispatcher cannot count it in, what arrived goes on-hand at the
 * destination at the cost it left with, a shortfall is a valued exception, a count freeze holds it. Shared by the direct
 * and the synced route (OB-288 lane 2).
 */
export async function receiveCore(
  deps: TransfersDeps, tenantId: string, transfer: Transfer,
  counted: readonly { productId: string; batchId: string | null; quantityMinor: number }[], receivedBy: string, at: string, currency: CurrencyCode, relay?: TransferRelay,
): Promise<Record<string, unknown>> {
  const transferId = transfer.transferId;
  // Round 2 (like indents — M09-FR-03 "receiver at destination confirms" · §28): the person who dispatched the transfer
  // cannot also count it in. The destination's count is independent, or it is not a check.
  if (transfer.state === 'in_transit' && transfer.approvedBy !== undefined && transfer.approvedBy === receivedBy) {
    throw apiError(422, {
      code: 'dispatcher_cannot_receive',
      whatHappened: `${receivedBy} dispatched transfer ${transferId} and cannot also count it in at ${transfer.toLocationId} (§28) — the receiving count must be a different person's.`,
      wasItSaved: 'not_saved',
      nextSafeAction: 'Have someone at the destination count it in. Nothing was received.',
    });
  }
  try {
    const result = receiveTransfer({ transfer, counted: [...counted], receivedBy, at, currency });
    const received: Transfer = relay === undefined ? result.transfer : { ...result.transfer, receiptRelay: relay };
    // SP-5 (F05): what arrived becomes on-hand at the destination on the M08 ledger, at the cost it left with.
    const posted = receivePostings(received, result.movements, receivedBy);
    // WF-08 / OB-59: stock arriving at a place where an open count froze `transferred_in` for the product is refused by
    // name (nothing received; the transfer stays in transit) — before, it was accepted and only shown as a breach.
    await assertNotFrozenByCount(deps.countFreeze, tenantId, posted, 'transfer receipt');
    await deps.recordReceived(tenantId, received, result.movements, result.discrepancies, posted);
    return { transferId, state: received.state, received: result.movements.length, posted: posted.map((m) => m.movementId), discrepancies: result.discrepancies };
  } catch (e) {
    if (e instanceof TransferRefusedError) refused(e.why);
    throw e;
  }
}

export function transfersRoutes(deps: TransfersDeps): readonly Route[] {
  return [
    {
      // Propose a transfer — it moves nothing yet; a separate person approves it at dispatch (§28).
      api: 'API-04', method: 'POST', path: '/v1/warehouse/transfers/:transferId',
      permission: 'inventory.movement.append', idempotent: true,
      handler: async (ctx) => {
        const transferId = ctx.params['transferId'] ?? '';
        const b = (ctx.body ?? {}) as { fromLocationId?: unknown; toLocationId?: unknown; lines?: unknown };
        const read = readLines(b.lines);
        if (!isStr(b.fromLocationId) || !isStr(b.toLocationId) || read === null) {
          throw apiError(400, { code: 'not_readable_as_a_transfer', whatHappened: 'A transfer needs a fromLocationId, a toLocationId and at least one line (productId, whole quantityMinor, uom). Its value is head office\'s own cost of the stock at the sending place — never sent.', wasItSaved: 'not_saved', nextSafeAction: 'Send the transfer. Nothing was recorded.' });
        }
        await assertEitherEndInScope(ctx, deps.locationBranches, b.fromLocationId, b.toLocationId);
        if ((await deps.transfer(ctx.tenantId, transferId)) !== undefined) {
          throw apiError(409, { code: 'transfer_already_exists', whatHappened: `Transfer ${transferId} already exists.`, wasItSaved: 'not_saved', nextSafeAction: 'Use a new id. Nothing was changed.' });
        }
        // SP-5: both ends must be places head office knows — a transfer to a mistyped location strands the stock where
        // no report reads it (P-08). The source is checked too: stock cannot leave a place that has never held any.
        for (const [role, locationId] of [['fromLocationId', b.fromLocationId], ['toLocationId', b.toLocationId]] as const) {
          if (!(await deps.knownLocation(ctx.tenantId, locationId))) {
            throw apiError(422, {
              code: 'unknown_location',
              whatHappened: `${role} "${locationId}" is not a place head office has any record of — no branch, warehouse or department by that id, no bin there, and no stock has ever been held there.`,
              wasItSaved: 'not_saved',
              nextSafeAction: 'Check the location id against the org structure or the bins. Nothing was recorded.',
            });
          }
        }
        await assertUnitsAreTheProducts(deps, ctx.tenantId, read.lines);
        // Round 10 (A03 finding): the transfer's cost is head office's OWN valuation of the stock at the sending location —
        // a unitCost the proposer sends is IGNORED (and the reply says so). Where head office holds no cost, the line carries
        // 0 and is named in `costUnknown`; dispatch values the stock again at what it then leaves with (`lineCostsMinor`).
        const from = b.fromLocationId;
        const costs = await Promise.all(read.lines.map(async (l) => (await deps.unitCostAt(ctx.tenantId, from, l.productId)) ?? null));
        const lines: TransferLine[] = read.lines.map((l, i) => ({ ...l, unitCost: { minor: costs[i] ?? 0, currency: 'INR' } }));
        const costUnknown = [...new Set(read.lines.filter((_, i) => costs[i] === null).map((l) => l.productId))];
        const transfer: Transfer = { transferId, fromLocationId: b.fromLocationId, toLocationId: b.toLocationId, lines, state: 'proposed', requestedBy: ctx.userId };
        await deps.recordProposed(ctx.tenantId, transfer);
        return { status: 201, body: {
          transferId, state: 'proposed', fromLocationId: transfer.fromLocationId, toLocationId: transfer.toLocationId, lines: lines.length,
          unitCostsMinor: costs, costUnknown, ignoredFromCaller: read.callerSentCost ? ['unitCost'] : [],
        } };
      },
    },
    {
      // Dispatch: stock leaves the source and becomes in-transit AT THE DESTINATION. The AUTHENTICATED dispatcher is
      // the approver — the engine refuses the proposer approving their own (§28) — and the available stock is head
      // office's own (SP-4, F07); recalled/quarantined/expired/damaged stock and an over-draw are refused.
      api: 'API-04', method: 'POST', path: '/v1/warehouse/transfers/:transferId/dispatch',
      permission: 'inventory.movement.append', idempotent: true,
      handler: async (ctx) => {
        const transferId = ctx.params['transferId'] ?? '';
        const b = (ctx.body ?? {}) as { approvedBy?: unknown; available?: unknown };
        if (b.approvedBy !== undefined || b.available !== undefined) {
          throw apiError(400, {
            code: 'dispatch_carries_caller_claims',
            whatHappened: 'A dispatch names no approver and no stock: the approver is the person dispatching (who cannot be the person who proposed it, §28) and the available stock is head office\'s own position at the source.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the dispatch with an empty body, as the person approving it. Nothing was moved.',
          });
        }
        const transfer = await deps.transfer(ctx.tenantId, transferId);
        if (transfer === undefined) throw notFound(`transfer ${transferId}`);
        await assertLocationInScope(ctx, transfer.fromLocationId, deps.locationBranches); // the stock leaves the caller's branch
        // OB-288 lane 2 (WF-07 cancellation): a cancelled transfer never leaves — said by name, nothing moves.
        if (transfer.state === 'cancelled') throw cancelledRefusal(transfer);
        return { status: 200, body: await dispatchCore(deps, ctx.tenantId, transfer, ctx.userId, deps.now()) };
      },
    },
    {
      // Receive: in-transit becomes on-hand for what actually arrived; a shortfall is a VALUED exception,
      // never a silent adjustment.
      api: 'API-04', method: 'POST', path: '/v1/warehouse/transfers/:transferId/receive',
      permission: 'inventory.movement.append', idempotent: true,
      handler: async (ctx) => {
        const transferId = ctx.params['transferId'] ?? '';
        const b = (ctx.body ?? {}) as { counted?: unknown; currency?: unknown };
        if (!Array.isArray(b.counted) || (b.currency !== undefined && !isCurrencyCode(b.currency as string))) {
          throw apiError(400, { code: 'not_readable_as_a_receipt', whatHappened: 'A receipt needs the counted quantities (productId, whole quantityMinor).', wasItSaved: 'not_saved', nextSafeAction: 'Send what was counted. Nothing was recorded.' });
        }
        const counted: { productId: string; batchId: string | null; quantityMinor: number }[] = [];
        for (const raw of b.counted) {
          const c = rec(raw);
          if (c === null || !isStr(c['productId']) || !isInt(c['quantityMinor']) || (c['batchId'] !== null && c['batchId'] !== undefined && !isStr(c['batchId']))) {
            throw apiError(400, { code: 'not_readable_as_a_receipt', whatHappened: 'Each counted line needs a productId and a whole quantityMinor.', wasItSaved: 'not_saved', nextSafeAction: 'Fix the counted lines. Nothing was recorded.' });
          }
          counted.push({ productId: c['productId'] as string, batchId: isStr(c['batchId']) ? (c['batchId'] as string) : null, quantityMinor: c['quantityMinor'] as number });
        }
        const transfer = await deps.transfer(ctx.tenantId, transferId);
        if (transfer === undefined) throw notFound(`transfer ${transferId}`);
        await assertLocationInScope(ctx, transfer.toLocationId, deps.locationBranches); // it arrives in the caller's branch
        if (transfer.state === 'cancelled') throw cancelledRefusal(transfer);
        return { status: 200, body: await receiveCore(deps, ctx.tenantId, transfer, counted, ctx.userId, deps.now(), (b.currency as CurrencyCode) ?? 'INR') };
      },
    },
    {
      // Batch 2 — RESOLVE a plain transfer's receipt shortfall, accountably (M09-FR-03 · M08-FR-03 · §28 · P-08 · hard rules
      // #2 #6 #10). Body: { lines?: [{ productId, batchId?, foundMinor, foundAtLocationId? }], reasonCode, note }. A person who
      // neither dispatched nor counted it says what turned up (a compensating two-person `adjusted` movement in the same
      // write) and why the rest is gone (confirmed lost at the cost it left with). Once; the shortfall stays on the record.
      // A floor-indent transfer is resolved on its indent.
      api: 'API-04', method: 'POST', path: '/v1/warehouse/transfers/:transferId/shortfall/resolution',
      permission: 'inventory.adjustment.approve', idempotent: true,
      handler: async (ctx) => {
        const transferId = (ctx.params['transferId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const found = readFound(b['lines']);
        if (transferId === '' || found === undefined || !isAdjustmentReason(b['reasonCode']) || !isStr(b['note']) || (b['note'] as string).trim().length < 4) {
          throw apiError(400, {
            code: 'not_readable_as_a_resolution',
            whatHappened: `Resolving a shortfall needs a reasonCode (${ADJUSTMENT_REASON_CODES.join(' / ')}), a note saying what was done to look for the stock, and optionally lines [{ productId, batchId?, foundMinor, foundAtLocationId? }] for what turned up (one line per product and batch).`,
            wasItSaved: 'not_saved', nextSafeAction: 'Send { reasonCode, note, lines? }. Nothing was changed.',
          });
        }
        if (deps.recordShortfallResolved === undefined || deps.shortfallOf === undefined) throw notFound(`shortfall resolution for transfer ${transferId}`);
        const reasonCode = b['reasonCode'] as string;
        const note = (b['note'] as string).trim();
        const version = deps.transferVersion === undefined ? undefined : await deps.transferVersion(ctx.tenantId, transferId);
        const transfer = await deps.transfer(ctx.tenantId, transferId);
        if (transfer === undefined) throw notFound(`transfer ${transferId}`);
        await assertEitherEndInScope(ctx, deps.locationBranches, transfer.fromLocationId, transfer.toLocationId); // PA-01-r1
        if (deps.belongsToIndent !== undefined && await deps.belongsToIndent(ctx.tenantId, transferId)) {
          throw apiError(409, { code: 'resolve_on_the_indent', whatHappened: `Transfer ${transferId} carries a floor indent issue; its shortfall is resolved on the indent.`, wasItSaved: 'not_saved', nextSafeAction: 'Use POST /v1/floor/indents/:indentId/issues/:issueId/shortfall/resolution. Nothing was changed.' });
        }
        if (transfer.state !== 'received') {
          throw apiError(409, { code: 'transfer_not_received', whatHappened: `Transfer ${transferId} is ${transfer.state} — it has not been counted in, so there is no shortfall to resolve.`, wasItSaved: 'not_saved', nextSafeAction: 'Receive it first. Nothing was changed.' });
        }
        const prior = transfer.shortfallResolution;
        if (prior !== undefined && sameResolution(prior, reasonCode, found)) return { status: 200, body: { transferId, resolution: prior, alreadyResolved: true } };
        const at = deps.now();
        const judged = judgeShortfallResolution({
          what: `transfer ${transferId}`, shortfall: await deps.shortfallOf(ctx.tenantId, transferId), prior,
          sentBy: transfer.approvedBy, countedBy: transfer.receivedBy, fromLocationId: transfer.fromLocationId, toLocationId: transfer.toLocationId,
          resolvedBy: ctx.userId, found, reasonCode, note, at,
        });
        if (!judged.ok) throw apiError(SHORTFALL_STATUS[judged.code], { code: judged.code, whatHappened: judged.why, wasItSaved: 'not_saved', nextSafeAction: 'Nothing was changed. Read the transfer and its exception, then try again.' });
        const posted = foundPostings(transfer, { ...(transfer.receivedBy === undefined ? {} : { receivedBy: transfer.receivedBy }) }, judged.resolution);
        // WF-08 / OB-59: found units come back on an adjustment — refused while an open count there froze adjustments.
        await assertNotFrozenByCount(deps.countFreeze, ctx.tenantId, posted, 'found-stock adjustment');
        const costed = costedResolution(judged.resolution, transfer);
        for (const m of posted) {
          const check = checkMovement(m);
          if (!check.ok) throw apiError(422, { code: check.refusedBecause ?? 'movement_refused', whatHappened: check.detail, wasItSaved: 'not_saved', nextSafeAction: 'Nothing was changed.' });
        }
        const resolution: ShortfallResolution = { ...costed, movementIds: posted.map((m) => m.movementId) };
        try {
          await deps.recordShortfallResolved(ctx.tenantId, { ...transfer, shortfallResolution: resolution }, posted, version);
        } catch (e) {
          if (e instanceof ConcurrencyConflictError) throw concurrentChange(`transfer ${transferId}`);
          throw e;
        }
        return { status: 201, body: { transferId, resolution, posted, alreadyResolved: false } };
      },
    },
    {
      // Round 12 (WF-07 · M09-FR-03): the transfers register the dispatch-and-receipt screen reads — every transfer with
      // either end in the caller's branches (PA-01-r1), newest first, each with its open receipt shortfall (valued at the
      // cost it left with) and whether it travels for a floor indent (resolved there). A read: it changes nothing.
      api: 'API-04', method: 'GET', path: '/v1/warehouse/transfers',
      permission: 'inventory.availability.read',
      handler: async (ctx) => {
        const all = deps.transfers === undefined ? [] : [...(await deps.transfers(ctx.tenantId))].reverse();
        // OB-288 lane 2: the STORE at each end, so the store computer's handheld offers only its own end of a transfer.
        const branchOf = deps.locationBranches === undefined ? undefined : await deps.locationBranches(ctx.tenantId);
        const rows = [];
        for (const t of all) {
          if (!(await locationInScope(ctx, t.fromLocationId, deps.locationBranches)) && !(await locationInScope(ctx, t.toLocationId, deps.locationBranches))) continue;
          const shortfall = t.state === 'received' && deps.shortfallOf !== undefined ? await deps.shortfallOf(ctx.tenantId, t.transferId) : [];
          const forIndent = deps.belongsToIndent === undefined ? false : await deps.belongsToIndent(ctx.tenantId, t.transferId);
          rows.push({
            transfer: t, shortfall, shortfallOpen: shortfall.length > 0 && t.shortfallResolution === undefined, forIndent,
            ...(branchOf === undefined ? {} : { fromStoreId: branchOf(t.fromLocationId), toStoreId: branchOf(t.toLocationId) }),
          });
        }
        return { status: 200, body: { transfers: rows, asAt: deps.now() } };
      },
    },
    {
      api: 'API-04', method: 'GET', path: '/v1/warehouse/transfers/:transferId',
      permission: 'inventory.availability.read',
      handler: async (ctx) => {
        const transfer = await deps.transfer(ctx.tenantId, ctx.params['transferId'] ?? '');
        if (transfer === undefined) throw notFound(`transfer ${ctx.params['transferId']}`);
        await assertEitherEndInScope(ctx, deps.locationBranches, transfer.fromLocationId, transfer.toLocationId);
        return { status: 200, body: transfer };
      },
    },
    {
      // Advisory: how to spread scarce warehouse stock across stores — by DAYS OF COVER, not raw shortfall.
      // It proposes; a person approves a resulting transfer (§28). Nothing moves here.
      api: 'API-04', method: 'POST', path: '/v1/warehouse/allocation/propose',
      permission: 'inventory.availability.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as { productId?: unknown; fromLocationId?: unknown; availableMinor?: unknown; needs?: unknown };
        if (!isStr(b.productId) || !isStr(b.fromLocationId) || !isInt(b.availableMinor) || (b.availableMinor as number) < 0 || !Array.isArray(b.needs)) {
          throw apiError(400, { code: 'not_readable_as_an_allocation', whatHappened: 'An allocation needs a productId, a fromLocationId, a whole availableMinor and the needs (locationId, shortfallMinor).', wasItSaved: 'not_saved', nextSafeAction: 'Send the allocation inputs. Nothing was changed.' });
        }
        const needs: AllocationNeed[] = [];
        for (const raw of b.needs) {
          const n = rec(raw);
          if (n === null || !isStr(n['locationId']) || !isInt(n['shortfallMinor']) || (n['dailyDemandMinor'] !== undefined && !isInt(n['dailyDemandMinor']))) {
            throw apiError(400, { code: 'not_readable_as_a_need', whatHappened: 'Each need has a locationId and a whole shortfallMinor (dailyDemandMinor optional).', wasItSaved: 'not_saved', nextSafeAction: 'Fix the needs. Nothing was changed.' });
          }
          needs.push({ locationId: n['locationId'] as string, productId: b.productId, shortfallMinor: n['shortfallMinor'] as number, ...(isInt(n['dailyDemandMinor']) ? { dailyDemandMinor: n['dailyDemandMinor'] as number } : {}) });
        }
        const proposals = proposeAllocation({ productId: b.productId, fromLocationId: b.fromLocationId, availableMinor: b.availableMinor as number, needs });
        return { status: 200, body: { proposals } };
      },
    },
  ];
}

// ── OB-288 lane 2 · WF-07: cancellation before dispatch, and the offline dispatch / receipt the store computer relays ──
//
// CANCEL (WF-07 "cancellation" scenario): a transfer that has NOT left can be withdrawn by a person at either end — a
// compensating `TransferCancelled` event carrying who, when and why; the proposal stays on the record (hard rules #2, #6).
// Once dispatched it cannot be cancelled (the stock is on the van: the receipt and its shortfall path settle it). The cancel
// is written under the SOURCE's stock guard, the same guard a dispatch writes under, so a dispatch and a cancel racing each
// other cannot both land — the second is refused by name.
//
// SYNCED DISPATCH / RECEIPT (§31 "Receiving/count/transfer: queue-capable", P-01): the warehouse handheld at the store keeps
// a dispatch or a receipt count on its durable queue with the line down; the store computer holds it on its fsync'd log and
// relays it here under its own store credential. Head office trusts the FACT (who, when — the person the box verified) and
// re-runs every JUDGEMENT on its own records with the SAME cores the direct routes run (`dispatchCore`, `receiveCore`):
// the stock at the source, the proposer ≠ dispatcher rule, the dispatcher ≠ receiver rule, the e-way bill, the count freeze.
// The person is re-verified from THEIR grants. What cannot be accepted is REFUSED by name (422) — the box keeps it as a
// visible dead-letter for a person (hard rules #6, #10), never last-write-wins:
//   • the transfer was cancelled at head office while the van was being loaded (`transfer_cancelled`);
//   • somebody else already dispatched / received it, or the same person counted different figures (`…_differently`);
//   • a receipt that arrives before head office has heard the dispatch is answered 425 (`transfer_not_dispatched_yet`) — the
//     box keeps it and sends it again; its attempt budget bounds the wait and then shows it to a person.
// The same step again (a re-sent queue item) is 200, one effect (§31.1).

export interface TransferLifecycleDeps extends TransfersDeps {
  /** Append the cancelled aggregate — a compensating event — under the source's stock guard read before the decision. */
  readonly recordCancelled: (tenantId: string, transfer: Transfer, expectedStockVersion?: number) => Promise<void> | void;
  /** The named person's own grants, to re-verify a RELAYED dispatcher / receiver (§28). Absent → every relayed person is unknown. */
  readonly permissionsOfUser?: (tenantId: string, userId: string) => Promise<readonly string[] | undefined> | readonly string[] | undefined;
  /** The durable domain audit trail (M34), when composed. */
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}

/** The permission a person must hold to have dispatched or counted in a transfer in their own name (the direct routes'). */
const MOVE_PERMISSION = 'inventory.movement.append';
const isIsoTime = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(v));
type CountedLine = { productId: string; batchId: string | null; quantityMinor: number };
const sameCounts = (a: readonly CountedLine[], b: readonly CountedLine[]): boolean => {
  const key = (l: CountedLine): string => `${l.productId}\u001f${l.batchId ?? ''}\u001f${l.quantityMinor}`;
  return a.map(key).sort().join('|') === b.map(key).sort().join('|');
};

function readCounted(v: unknown): CountedLine[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: CountedLine[] = [];
  for (const raw of v) {
    const c = rec(raw);
    if (c === null || !isStr(c['productId']) || !isInt(c['quantityMinor']) || (c['quantityMinor'] as number) < 0 || (c['batchId'] !== null && c['batchId'] !== undefined && !isStr(c['batchId']))) return undefined;
    out.push({ productId: c['productId'] as string, batchId: isStr(c['batchId']) ? (c['batchId'] as string) : null, quantityMinor: c['quantityMinor'] as number });
  }
  return out;
}

export function transferLifecycleRoutes(deps: TransferLifecycleDeps): readonly Route[] {
  const relayOf = (ctx: RequestContext, b: Record<string, unknown>): TransferRelay => ({
    relayedBy: ctx.userId, source: isStr(b['source']) ? b['source'] : 'unknown', storeId: isStr(b['storeId']) ? b['storeId'] : null,
  });
  /** Re-verify the person a relayed step names, from THEIR grants — refused by name when unknown or not allowed (§28). */
  const assertPersonMayMove = async (tenantId: string, userId: string, what: string): Promise<void> => {
    const held = await deps.permissionsOfUser?.(tenantId, userId);
    if (held === undefined || !held.includes(MOVE_PERMISSION)) {
      throw apiError(422, {
        code: held === undefined ? 'person_unknown_at_head_office' : 'person_lacks_authority',
        whatHappened: held === undefined
          ? `${userId}, named as the person who ${what}, is not anyone head office knows, so the step cannot be booked in their name.`
          : `${userId}, named as the person who ${what}, does not hold stock-movement authority at head office (${MOVE_PERMISSION}), so it is not booked in their name.`,
        wasItSaved: 'not_saved',
        nextSafeAction: 'Kept at the store for a person: check who did it and whose sign-in was used. Nothing was moved.',
      });
    }
  };
  const audit = async (tenantId: string, entry: AuditEntry): Promise<void> => { await deps.recordAudit?.(tenantId, entry); };

  return [
    {
      // WF-07 cancellation: withdraw a transfer that has not left. Body: { reason } (a few words). Either end may cancel.
      api: 'API-04', method: 'POST', path: '/v1/warehouse/transfers/:transferId/cancel',
      permission: MOVE_PERMISSION, idempotent: true,
      handler: async (ctx) => {
        const transferId = (ctx.params['transferId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (transferId === '' || !isStr(b['reason']) || (b['reason'] as string).trim().length < 4) {
          throw apiError(400, { code: 'not_readable_as_a_cancellation', whatHappened: 'Cancelling a transfer needs { reason } — a few words a person can read later.', wasItSaved: 'not_saved', nextSafeAction: 'Say why it is being cancelled. Nothing was changed.' });
        }
        const reason = (b['reason'] as string).trim();
        const transfer = await deps.transfer(ctx.tenantId, transferId);
        if (transfer === undefined) throw notFound(`transfer ${transferId}`);
        await assertEitherEndInScope(ctx, deps.locationBranches, transfer.fromLocationId, transfer.toLocationId); // PA-01-r1
        if (transfer.state === 'cancelled') return { status: 200, body: { transferId, state: 'cancelled', cancelledBy: transfer.cancelledBy, cancelledAt: transfer.cancelledAt, alreadyCancelled: true } };
        if (deps.belongsToIndent !== undefined && await deps.belongsToIndent(ctx.tenantId, transferId)) {
          throw apiError(409, { code: 'cancel_on_the_indent', whatHappened: `Transfer ${transferId} carries a floor indent issue; the indent is cancelled on its own screen.`, wasItSaved: 'not_saved', nextSafeAction: 'Cancel the indent instead. Nothing was changed.' });
        }
        if (transfer.state !== 'proposed' && transfer.state !== 'approved') {
          throw apiError(409, {
            code: 'transfer_already_dispatched',
            whatHappened: `Transfer ${transferId} is ${transfer.state} — it has already left ${transfer.fromLocationId}, so it can no longer be cancelled.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Count it in at the other end; anything that did not arrive becomes a valued shortfall to settle. Nothing was changed.',
          });
        }
        // The source's stock guard first — the guard a dispatch writes under, so the two can never both land.
        const expected = deps.stockVersion === undefined ? undefined : await Promise.resolve(deps.stockVersion(ctx.tenantId, transfer.fromLocationId));
        const at = deps.now();
        const cancelled: Transfer = { ...transfer, state: 'cancelled', cancelledBy: ctx.userId, cancelledAt: at, cancelReason: reason };
        try {
          await deps.recordCancelled(ctx.tenantId, cancelled, expected);
        } catch (e) {
          if (e instanceof ConcurrencyConflictError) throw concurrentChange(`transfer ${transferId}`);
          throw e;
        }
        await audit(ctx.tenantId, {
          actorId: ctx.userId, action: 'transfer.cancel', objectType: 'stock_transfer', objectId: transferId, at,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: { state: transfer.state }, after: { state: 'cancelled' }, reason, correlationId: transferId,
        });
        return { status: 200, body: { transferId, state: 'cancelled', cancelledBy: ctx.userId, cancelledAt: at, reason, alreadyCancelled: false } };
      },
    },
    {
      // §31 offline: a dispatch made on the store's handheld, relayed by the box. Body: { transferId (= path), storeId,
      // dispatchedBy, at, source? }. No stock, cost or approver beyond the person — head office's own, as on the direct route.
      api: 'API-04', method: 'POST', path: '/v1/warehouse/transfers/:transferId/dispatch/synced',
      permission: 'inventory.transfer.sync', idempotent: true,
      handler: async (ctx) => {
        const transferId = (ctx.params['transferId'] ?? '').trim();
        const b = rec(ctx.body) ?? {};
        if (transferId === '' || b['transferId'] !== transferId || !isStr(b['dispatchedBy']) || !isIsoTime(b['at'])
          || b['available'] !== undefined || b['approvedBy'] !== undefined || b['lines'] !== undefined) {
          throw apiError(400, {
            code: 'not_readable_as_a_relayed_dispatch',
            whatHappened: 'A relayed dispatch names the transfer (matching the path), who sent it (dispatchedBy) and when (at) — and nothing else: the lines, the stock and the cost are head office\'s own.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Do not discard it at the store. Keep it in the queue and raise it.',
          });
        }
        const dispatchedBy = (b['dispatchedBy'] as string).trim();
        const at = new Date(Date.parse(b['at'] as string)).toISOString();
        const transfer = await deps.transfer(ctx.tenantId, transferId);
        if (transfer === undefined) {
          throw apiError(422, { code: 'transfer_not_known_at_head_office', whatHappened: `Head office holds no transfer ${transferId}, so a dispatch of it cannot be booked.`, wasItSaved: 'not_saved', nextSafeAction: 'Kept at the store for a person: check the transfer note\'s number. Nothing was moved.' });
        }
        await assertLocationInScope(ctx, transfer.fromLocationId, deps.locationBranches); // only the sending store's own computer
        if (transfer.state === 'cancelled') throw cancelledRefusal(transfer);
        if (transfer.state === 'in_transit' || transfer.state === 'received') {
          if (transfer.approvedBy === dispatchedBy) return { status: 200, body: { transferId, state: transfer.state, approvedBy: transfer.approvedBy, alreadyDispatched: true } };
          throw apiError(422, {
            code: 'transfer_dispatched_by_another',
            whatHappened: `Transfer ${transferId} was already sent by ${transfer.approvedBy ?? 'someone else'}; this store says ${dispatchedBy} sent it. The two cannot both be right.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Kept at the store for a person to compare and settle. Nothing was moved twice.',
          });
        }
        await assertPersonMayMove(ctx.tenantId, dispatchedBy, `sent transfer ${transferId}`);
        const relay = relayOf(ctx, b);
        const body = await dispatchCore(deps, ctx.tenantId, transfer, dispatchedBy, at, relay);
        await audit(ctx.tenantId, {
          actorId: dispatchedBy, action: 'transfer.dispatch', objectType: 'stock_transfer', objectId: transferId, at,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null, capturedOffline: true },
          before: { state: transfer.state }, after: { state: 'in_transit', relayedBy: ctx.userId, source: relay.source }, correlationId: transferId,
        });
        return { status: 202, body: { ...body, alreadyDispatched: false, relayed: relay } };
      },
    },
    {
      // §31 offline: a receipt counted on the store's handheld, relayed by the box. Body: { transferId (= path), storeId,
      // receivedBy, at, counted: [{ productId, batchId?, quantityMinor }], currency?, source? }.
      api: 'API-04', method: 'POST', path: '/v1/warehouse/transfers/:transferId/receive/synced',
      permission: 'inventory.transfer.sync', idempotent: true,
      handler: async (ctx) => {
        const transferId = (ctx.params['transferId'] ?? '').trim();
        const b = rec(ctx.body) ?? {};
        const counted = readCounted(b['counted']);
        if (transferId === '' || b['transferId'] !== transferId || !isStr(b['receivedBy']) || !isIsoTime(b['at']) || counted === undefined
          || (b['currency'] !== undefined && !isCurrencyCode(b['currency'] as string))) {
          throw apiError(400, {
            code: 'not_readable_as_a_relayed_receipt',
            whatHappened: 'A relayed receipt names the transfer (matching the path), who counted it in (receivedBy), when (at) and what arrived (counted: [{ productId, batchId?, quantityMinor ≥ 0 }]).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Do not discard it at the store. Keep it in the queue and raise it.',
          });
        }
        const receivedBy = (b['receivedBy'] as string).trim();
        const at = new Date(Date.parse(b['at'] as string)).toISOString();
        const transfer = await deps.transfer(ctx.tenantId, transferId);
        if (transfer === undefined) {
          throw apiError(422, { code: 'transfer_not_known_at_head_office', whatHappened: `Head office holds no transfer ${transferId}, so a receipt against it cannot be booked.`, wasItSaved: 'not_saved', nextSafeAction: 'Kept at the store for a person: check the transfer note\'s number. Nothing was received.' });
        }
        await assertLocationInScope(ctx, transfer.toLocationId, deps.locationBranches); // only the receiving store's own computer
        if (transfer.state === 'cancelled') throw cancelledRefusal(transfer);
        if (transfer.state === 'proposed' || transfer.state === 'approved') {
          // The sending end's dispatch has not reached head office yet (the other store's line may be down too): not a
          // refusal — 425, so the box keeps the count and sends it again; its attempt budget then shows it to a person.
          throw apiError(425, {
            code: 'transfer_not_dispatched_yet',
            whatHappened: `Head office has not yet heard that transfer ${transferId} left ${transfer.fromLocationId}, so this count cannot be booked against it yet.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing to do: the store computer keeps the count and sends it again once the dispatch has arrived.',
          });
        }
        if (transfer.state === 'received') {
          if (transfer.receivedBy === receivedBy) {
            // The same person's count again — a re-sent queue item — is the same receipt; a different figure is a conflict.
            const shortfall = deps.shortfallOf === undefined ? [] : await deps.shortfallOf(ctx.tenantId, transferId);
            const arrived = transfer.lines.map((l): CountedLine => ({
              productId: l.productId, batchId: l.batchId,
              quantityMinor: l.quantityMinor - (shortfall.find((s) => s.productId === l.productId && s.batchId === l.batchId)?.quantityMinor ?? 0),
            }));
            if (sameCounts(arrived, counted)) return { status: 200, body: { transferId, state: 'received', receivedBy, alreadyReceived: true } };
          }
          throw apiError(422, {
            code: 'transfer_received_differently',
            whatHappened: `Transfer ${transferId} was already counted in by ${transfer.receivedBy ?? 'someone'}${transfer.receivedBy === receivedBy ? ' with different figures' : ''}; this store's count (by ${receivedBy}) cannot also be booked.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Kept at the store for a person to compare the two counts. Nothing was received twice.',
          });
        }
        await assertPersonMayMove(ctx.tenantId, receivedBy, `counted in transfer ${transferId}`);
        const relay = relayOf(ctx, b);
        const body = await receiveCore(deps, ctx.tenantId, transfer, counted, receivedBy, at, (b['currency'] as CurrencyCode) ?? 'INR', relay);
        await audit(ctx.tenantId, {
          actorId: receivedBy, action: 'transfer.receive', objectType: 'stock_transfer', objectId: transferId, at,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null, capturedOffline: true },
          before: { state: transfer.state }, after: { state: 'received', relayedBy: ctx.userId, source: relay.source }, correlationId: transferId,
        });
        return { status: 202, body: { ...body, alreadyReceived: false, relayed: relay } };
      },
    },
  ];
}
