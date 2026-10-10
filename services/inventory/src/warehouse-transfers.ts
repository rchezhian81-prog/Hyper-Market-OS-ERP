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
  dispatchTransfer, receiveTransfer, proposeAllocation, TransferRefusedError, judgeShortfallResolution,
  type Transfer, type TransferLine, type TransferApproval, type AvailableLot, type AllocationNeed,
  type FoundLine, type ShortfallLine, type ShortfallResolution, type ShortfallRefusal,
} from '../../../packages/warehouse/src/transfers';
import { isAdjustmentReason, ADJUSTMENT_REASON_CODES } from '../../../packages/adjustment/src/adjustment';
import type { StockMovement } from '../../../packages/stock/src/position';
import { isCurrencyCode, type CurrencyCode, type Money } from '../../../packages/contracts/src/money';
import { checkMovement, type Movement } from './index';

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isInt = (v: unknown): v is number => Number.isInteger(v);
const isPosInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
const rec = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isMoney = (v: unknown): v is Money => { const r = rec(v); return r !== null && Number.isInteger(r['minor']) && isCurrencyCode(r['currency'] as string); };

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
  readonly transfer: (tenantId: string, transferId: string) => Promise<Transfer | undefined> | Transfer | undefined;
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
  readonly now: () => string;
}

const SHORTFALL_STATUS: Readonly<Record<ShortfallRefusal, number>> = Object.freeze({
  nothing_short: 409, shortfall_already_resolved: 409, counter_cannot_resolve: 422, issuer_cannot_resolve: 422, not_on_shortfall: 422, more_found_than_missing: 422,
});

/** SF-03 — each line's unit against the product master's; the first that disagrees is refused by name (422). */
async function assertUnitsAreTheProducts(deps: TransfersDeps, tenantId: string, lines: readonly TransferLine[]): Promise<void> {
  if (deps.productUom === undefined) return;
  for (const line of lines) {
    const uom = await deps.productUom(tenantId, line.productId);
    if (uom !== undefined && uom !== line.uom) {
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

function readLines(v: unknown): TransferLine[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const lines: TransferLine[] = [];
  for (const raw of v) {
    const l = rec(raw);
    if (l === null || !isStr(l['productId']) || !isPosInt(l['quantityMinor']) || !isStr(l['uom']) || !isMoney(l['unitCost'])
      || (l['batchId'] !== null && !isStr(l['batchId']))) return null;
    lines.push({ productId: l['productId'] as string, batchId: isStr(l['batchId']) ? (l['batchId'] as string) : null, quantityMinor: l['quantityMinor'] as number, uom: l['uom'] as string, unitCost: l['unitCost'] as Money });
  }
  return lines;
}

const refused = (why: string): never => {
  throw apiError(422, { code: 'transfer_refused', whatHappened: why, wasItSaved: 'not_saved', nextSafeAction: 'Nothing was moved.' });
};

export function transfersRoutes(deps: TransfersDeps): readonly Route[] {
  return [
    {
      // Propose a transfer — it moves nothing yet; a separate person approves it at dispatch (§28).
      api: 'API-04', method: 'POST', path: '/v1/warehouse/transfers/:transferId',
      permission: 'inventory.movement.append', idempotent: true,
      handler: async (ctx) => {
        const transferId = ctx.params['transferId'] ?? '';
        const b = (ctx.body ?? {}) as { fromLocationId?: unknown; toLocationId?: unknown; lines?: unknown };
        const lines = readLines(b.lines);
        if (!isStr(b.fromLocationId) || !isStr(b.toLocationId) || lines === null) {
          throw apiError(400, { code: 'not_readable_as_a_transfer', whatHappened: 'A transfer needs a fromLocationId, a toLocationId and at least one line (productId, whole quantityMinor, uom, unitCost).', wasItSaved: 'not_saved', nextSafeAction: 'Send the transfer. Nothing was recorded.' });
        }
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
        await assertUnitsAreTheProducts(deps, ctx.tenantId, lines);
        const transfer: Transfer = { transferId, fromLocationId: b.fromLocationId, toLocationId: b.toLocationId, lines, state: 'proposed', requestedBy: ctx.userId };
        await deps.recordProposed(ctx.tenantId, transfer);
        return { status: 201, body: { transferId, state: 'proposed', fromLocationId: transfer.fromLocationId, toLocationId: transfer.toLocationId, lines: lines.length } };
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
        // SF-03: a transfer proposed before the unit check is checked again before anything moves.
        await assertUnitsAreTheProducts(deps, ctx.tenantId, transfer.lines);
        const approval: TransferApproval = { subjectRef: transferId, status: 'approved', decidedBy: ctx.userId };
        // The guard version first, then the stock it protects (Wave 2a · SF-04).
        const expectedVersion = deps.stockVersion === undefined ? undefined : await Promise.resolve(deps.stockVersion(ctx.tenantId, transfer.fromLocationId));
        const available = await deps.availableAt(ctx.tenantId, transfer.fromLocationId, transfer.lines);
        try {
          const result = dispatchTransfer({ transfer, approval, available, at: deps.now() });
          // SP-5 (F05): the value that leaves is head office's own average at the source, recorded per line on the
          // aggregate so the receipt re-enters it at the destination — never the proposer's figure.
          const lineCostsMinor: (number | null)[] = [];
          for (const line of transfer.lines) lineCostsMinor.push((await deps.unitCostAt(ctx.tenantId, transfer.fromLocationId, line.productId)) ?? null);
          const dispatched: Transfer = { ...result.transfer, lineCostsMinor };
          const posted = dispatchPostings(dispatched, result.movements, ctx.userId);
          await deps.recordDispatched(ctx.tenantId, dispatched, result.movements, posted, expectedVersion);
          return { status: 200, body: { transferId, state: dispatched.state, approvedBy: dispatched.approvedBy, movements: result.movements.length, posted: posted.map((m) => m.movementId), lineCostsMinor, availableChecked: available.map((l) => ({ productId: l.productId, batchId: l.batchId, quantityMinor: l.quantityMinor, state: l.state, recalled: l.recalled === true })) } };
        } catch (e) {
          if (e instanceof TransferRefusedError) refused(e.why);
          // Another movement out of this stock landed first (Wave 2a · SF-04): this dispatch was decided on a figure that
          // is no longer true — nothing moved; the approver re-reads. Never two transfers of the same stock.
          if (e instanceof ConcurrencyConflictError) throw concurrentChange(`the stock at ${transfer.fromLocationId}`);
          throw e;
        }
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
        try {
          const result = receiveTransfer({ transfer, counted, receivedBy: ctx.userId, at: deps.now(), currency: (b.currency as CurrencyCode) ?? 'INR' });
          // SP-5 (F05): what arrived becomes on-hand at the destination on the M08 ledger, at the cost it left with.
          const posted = receivePostings(result.transfer, result.movements, ctx.userId);
          await deps.recordReceived(ctx.tenantId, result.transfer, result.movements, result.discrepancies, posted);
          return { status: 200, body: { transferId, state: result.transfer.state, received: result.movements.length, posted: posted.map((m) => m.movementId), discrepancies: result.discrepancies } };
        } catch (e) {
          if (e instanceof TransferRefusedError) refused(e.why);
          throw e;
        }
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
        for (const m of posted) {
          const check = checkMovement(m);
          if (!check.ok) throw apiError(422, { code: check.refusedBecause ?? 'movement_refused', whatHappened: check.detail, wasItSaved: 'not_saved', nextSafeAction: 'Nothing was changed.' });
        }
        const resolution: ShortfallResolution = { ...judged.resolution, movementIds: posted.map((m) => m.movementId) };
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
      api: 'API-04', method: 'GET', path: '/v1/warehouse/transfers/:transferId',
      permission: 'inventory.availability.read',
      handler: async (ctx) => {
        const transfer = await deps.transfer(ctx.tenantId, ctx.params['transferId'] ?? '');
        if (transfer === undefined) throw notFound(`transfer ${ctx.params['transferId']}`);
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
