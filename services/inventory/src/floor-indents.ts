// API-04 — the FLOOR INDENT chain (WF-06 · WF-07 · M09-FR-03 · M04-FR-03 · M08-FR-02 · §28 · §31 · P-03 · P-08 — SP-8,
// audit finding F08). The sales floor asks the back store for stock and the ask lives as ONE durable record — requested,
// approved (allocated against head office's own back-store stock), issued (each issue a TRANSFER dispatched at the scan:
// stock off the back store, in transit at the floor, not sellable), received INDEPENDENTLY at the floor (a different
// person counts; what arrived becomes shelf availability — the place the till sells from; a shortfall is a valued
// exception), cancelled (the unissued remainder only) and returned (floor → back store, accepted by a second person).
// Requested / allocated / issued / received / in transit / shortfall / returned / outstanding are derived per line,
// never stored twice. Issue and receipt reuse the transfer engines, so stock is never created twice and a dispatch is
// never a receipt (hard rule #2).

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { dispatchTransfer, receiveTransfer, TransferRefusedError, type Transfer, type TransferLine, type AvailableLot, type TransferDiscrepancy } from '../../../packages/warehouse/src/transfers';
import { applyMovement, type Bin, type BinContents, type MovementCommand } from '../../../packages/warehouse/src/movements';
import {
  requestIndent, approveIndent, rejectIndent, planIssue, applyIssue, planReceipt, applyReceipt, cancelIndent,
  planReturn, applyReturnRequest, returnTransfer, planReturnAcceptance, applyReturnAcceptance, indentTotals, indentAttention,
  IndentRefusedError,
  type FloorIndent, type IndentLine, type IssueLine, type ReceivedLine, type ShortfallLine, type DamagedLine, type IndentRefusal,
} from '../../../packages/warehouse/src/indents';
import type { StockMovement } from '../../../packages/stock/src/position';
import { isCurrencyCode, type CurrencyCode } from '../../../packages/contracts/src/money';
import { dispatchPostings, receivePostings } from './warehouse-transfers';
import type { Movement } from './index';

export type IndentEventType =
  | 'FloorIndentRequested' | 'FloorIndentApproved' | 'FloorIndentRejected' | 'FloorIndentCancelled' | 'FloorIndentReturnRequested';

/** SP-8c: one bin-level movement head office applied for a handheld issue, keyed on the command it collapses on. */
export interface BinMovementRecord {
  readonly commandId: string;
  readonly movements: readonly StockMovement[];
}

/**
 * SP-8c: the bin-level PICKS for an issue whose lines name the back-store bin they came from — judged by the same
 * `applyMovement` engine the handheld runs, against head office's own bin register. A bin head office does not know, or
 * whose contents cannot cover the line, is a DISAGREEMENT to be said (`bin_disagrees`), never forced: the location-level
 * stock is the truth and it left the back store once. Each pick is keyed `<indent>:<issue>:<line>`, so a re-sent issue
 * moves a bin once. Shared by the direct and the relayed issue routes.
 */
export async function binPicksFor(
  deps: Pick<FloorIndentsDeps, 'bins' | 'contents' | 'appliedCommandIds'>,
  input: { readonly tenantId: string; readonly indentId: string; readonly issueId: string; readonly lines: readonly IssueLine[]; readonly uomOf: (productId: string, batchId: string | null) => string; readonly movedBy: string; readonly at: string },
): Promise<{ readonly binMovements: readonly BinMovementRecord[]; readonly disagrees: boolean }> {
  const binMovements: BinMovementRecord[] = [];
  let disagrees = false;
  if (deps.bins === undefined || deps.contents === undefined || deps.appliedCommandIds === undefined || !input.lines.some((l) => isStr(l.binId))) return { binMovements, disagrees };
  const bins = await deps.bins(input.tenantId);
  const contents = await deps.contents(input.tenantId);
  const applied = [...await deps.appliedCommandIds(input.tenantId)];
  input.lines.forEach((l, i) => {
    if (!isStr(l.binId)) return;
    const commandId = `${input.indentId}:${input.issueId}:${i + 1}`;
    if (applied.includes(commandId)) return;
    const bin = bins.find((x) => x.binId === l.binId);
    if (bin === undefined) { disagrees = true; return; }
    const command: MovementCommand = {
      commandId, kind: 'pick', storeId: bin.storeId, productId: l.productId, batchId: l.batchId, quantityMinor: l.quantityMinor,
      uom: input.uomOf(l.productId, l.batchId), fromBinId: l.binId, toBinId: null, movedBy: input.movedBy, at: input.at,
      reason: `indent ${input.indentId} issue ${input.issueId}`,
    };
    const result = applyMovement({ command, appliedCommandIds: applied, bins, contents });
    if (!result.accepted) { disagrees = true; return; }
    applied.push(commandId);
    binMovements.push({ commandId, movements: result.movements });
  });
  return { binMovements, disagrees };
}

export interface FloorIndentsDeps {
  readonly indent: (tenantId: string, indentId: string) => Promise<FloorIndent | undefined> | FloorIndent | undefined;
  readonly indents: (tenantId: string) => Promise<readonly FloorIndent[]> | readonly FloorIndent[];
  /** The transfer an issue travels on — the same aggregate the transfer routes read (one truth, SP-5). */
  readonly transferOf: (tenantId: string, transferId: string) => Promise<Transfer | undefined> | Transfer | undefined;
  /** SP-5's rule: a place head office has ANY record of (org node, a bin's place, a place that has held stock). */
  readonly knownLocation: (tenantId: string, locationId: string) => Promise<boolean> | boolean;
  /** Head office's own on-hand at a place per product — what the approver's allocation is judged against. */
  readonly onHandAt: (tenantId: string, locationId: string, productIds: readonly string[]) => Promise<readonly { readonly productId: string; readonly onHandMinor: number }[]> | readonly { readonly productId: string; readonly onHandMinor: number }[];
  /** SP-4 (F07): the source's own lots for the transfer engine — on-hand, recall and quality-hold state from the registers. */
  readonly availableAt: (tenantId: string, fromLocationId: string, lines: readonly TransferLine[]) => Promise<readonly AvailableLot[]> | readonly AvailableLot[];
  /** SP-5: head office's weighted-average unit cost at a place, or undefined when that stock is unvalued. */
  readonly unitCostAt: (tenantId: string, locationId: string, productId: string) => Promise<number | undefined> | number | undefined;
  /** A lifecycle step that moves no stock — the indent aggregate alone. */
  readonly recordIndent: (tenantId: string, indent: FloorIndent, type: IndentEventType) => Promise<void> | void;
  /** An ISSUE: the indent, the transfer proposed AND dispatched, and its `transferred_out` movements — ONE atomic write.
   *  SP-8c: a handheld issue also names the back-store BIN it took from; its bin movement(s) ride the same write. */
  readonly recordIssued: (tenantId: string, indent: FloorIndent, transfer: Transfer, movements: readonly StockMovement[], posted: readonly Movement[], binMovements?: readonly BinMovementRecord[]) => Promise<void> | void;
  /** A floor RECEIPT: the indent, the received transfer and its `transferred_in` movements — ONE atomic write. */
  readonly recordReceipt: (tenantId: string, indent: FloorIndent, transfer: Transfer, movements: readonly StockMovement[], discrepancies: readonly TransferDiscrepancy[], posted: readonly Movement[]) => Promise<void> | void;
  /** A RETURN accepted at the back store: the indent and the return's transfer proposed, dispatched and received in one step, with both legs' movements — ONE atomic write. */
  readonly recordReturnAccepted: (tenantId: string, indent: FloorIndent, transfer: Transfer, dispatchMovements: readonly StockMovement[], receiveMovements: readonly StockMovement[], discrepancies: readonly TransferDiscrepancy[], posted: readonly Movement[]) => Promise<void> | void;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  /** SP-8c: head office's bin register, so an issue that names a bin lowers the same bin it took from — on the handheld's
   *  relayed route AND the direct route (Batch 2: the direct route named the bin and left it full). Optional: a cloud without
   *  bins flags, never fails. */
  readonly bins?: (tenantId: string) => Promise<readonly Bin[]> | readonly Bin[];
  readonly contents?: (tenantId: string) => Promise<BinContents> | BinContents;
  readonly appliedCommandIds?: (tenantId: string) => Promise<readonly string[]> | readonly string[];
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v: unknown): v is number => Number.isInteger(v);
const isPosInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;

const REFUSAL_STATUS: Readonly<Record<IndentRefusal, number>> = Object.freeze({
  not_readable_as_an_indent: 400, same_place: 422, duplicate_product: 400,
  indent_not_requested: 409, self_approval: 422, over_allocation: 422, nothing_allocated: 422, not_on_indent: 422,
  indent_not_approved: 409, requester_cannot_issue: 422, over_issue: 422, issue_unknown: 404, issue_already_received: 409,
  issuer_cannot_receive: 422, not_on_issue: 422, indent_not_open: 409, nothing_received: 409, over_return: 422,
  return_unknown: 404, return_already_accepted: 409, returner_cannot_accept: 422, not_on_return: 422,
});

/** The engine's refusal, as the API says it — nothing saved, and the next safe step in words. */
export const refusedBy = (e: unknown): never => {
  if (e instanceof IndentRefusedError) {
    throw apiError(REFUSAL_STATUS[e.code], { code: e.code, whatHappened: e.why, wasItSaved: 'not_saved', nextSafeAction: 'Nothing was changed. Correct the request and try again, or read the indent.' });
  }
  if (e instanceof TransferRefusedError) {
    throw apiError(422, { code: 'issue_refused', whatHappened: e.why, wasItSaved: 'not_saved', nextSafeAction: 'Nothing was moved. Check the back store\'s stock and the batch, then issue again.' });
  }
  throw e;
};

export function readIndentLines(v: unknown): IndentLine[] | undefined {
  if (!Array.isArray(v) || v.length === 0) return undefined;
  const out: IndentLine[] = [];
  for (const raw of v) {
    if (!isObj(raw) || !isStr(raw['productId']) || !isPosInt(raw['quantityMinor']) || !isStr(raw['uom'])) return undefined;
    out.push({ productId: raw['productId'], requestedMinor: raw['quantityMinor'], uom: raw['uom'] });
  }
  return out;
}

export function readIssueLines(v: unknown): IssueLine[] | undefined {
  if (!Array.isArray(v) || v.length === 0) return undefined;
  const out: IssueLine[] = [];
  for (const raw of v) {
    if (!isObj(raw) || !isStr(raw['productId']) || !isPosInt(raw['quantityMinor']) || (raw['batchId'] !== undefined && raw['batchId'] !== null && !isStr(raw['batchId']))
      || (raw['binId'] !== undefined && raw['binId'] !== null && !isStr(raw['binId']))) return undefined;
    out.push({ productId: raw['productId'], batchId: isStr(raw['batchId']) ? raw['batchId'] : null, quantityMinor: raw['quantityMinor'], ...(isStr(raw['binId']) ? { binId: raw['binId'] } : {}) });
  }
  return out;
}

export function readCounted(v: unknown): ReceivedLine[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: ReceivedLine[] = [];
  for (const raw of v) {
    if (!isObj(raw) || !isStr(raw['productId']) || !isInt(raw['quantityMinor']) || (raw['quantityMinor'] as number) < 0 || (raw['batchId'] !== undefined && raw['batchId'] !== null && !isStr(raw['batchId']))
      || (raw['damagedMinor'] !== undefined && (!isInt(raw['damagedMinor']) || (raw['damagedMinor'] as number) < 0))) return undefined;
    out.push({ productId: raw['productId'], batchId: isStr(raw['batchId']) ? raw['batchId'] : null, quantityMinor: raw['quantityMinor'], ...(isInt(raw['damagedMinor']) && (raw['damagedMinor'] as number) > 0 ? { damagedMinor: raw['damagedMinor'] as number } : {}) });
  }
  return out;
}

export const shortfallOf = (discrepancies: readonly TransferDiscrepancy[]): ShortfallLine[] =>
  discrepancies.filter((d) => d.differenceMinor < 0).map((d) => ({ productId: d.productId, batchId: d.batchId, quantityMinor: -d.differenceMinor, valueMinor: d.value.minor }));

export const receivedOf = (movements: readonly StockMovement[], transfer: Transfer): ReceivedLine[] =>
  movements.filter((m) => m.from === 'in_transit' && m.to === 'on_hand' && m.locationId === transfer.toLocationId)
    .map((m) => ({ productId: m.productId, batchId: m.batchId, quantityMinor: m.quantityMinor }));

// ── SP-8c: damage on arrival ──────────────────────────────────────────────────────────────────────────────────
// The floor counts GOOD and DAMAGED separately. Both ARRIVED — so both leave transit through the transfer engine (a damaged
// carton is in the building, not a shortfall) — but only the good units become shelf availability. The damaged units are
// written off at the floor in the SAME atomic write, valued at the cost the stock left with, and carried on the indent as a
// valued exception with an owner. Nothing is on the shelf that cannot sell; nothing is quietly gone (P-08, hard rule #2).

/** What arrived, good and damaged alike — what the transfer engine receives out of transit. */
export const arrivedOf = (counted: readonly ReceivedLine[]): { productId: string; batchId: string | null; quantityMinor: number }[] =>
  counted.map((c) => ({ productId: c.productId, batchId: c.batchId, quantityMinor: c.quantityMinor + (c.damagedMinor ?? 0) }));

/** The damaged units, valued at the transfer line's cost (what left the back store). */
export const damagedOf = (counted: readonly ReceivedLine[], transfer: Transfer): DamagedLine[] =>
  counted.filter((c) => (c.damagedMinor ?? 0) > 0).map((c) => {
    const i = transfer.lines.findIndex((l) => l.productId === c.productId && l.batchId === c.batchId);
    const unitCost = i >= 0 ? transfer.lineCostsMinor?.[i] ?? transfer.lines[i]!.unitCost.minor : 0;
    return { productId: c.productId, batchId: c.batchId, quantityMinor: c.damagedMinor!, valueMinor: unitCost * c.damagedMinor! };
  });

/** The GOOD units received: what arrived (capped at what was sent, as the engine counts it) less what arrived damaged. */
export const goodOf = (received: readonly ReceivedLine[], damaged: readonly DamagedLine[]): ReceivedLine[] =>
  received.map((r) => {
    const d = damaged.find((x) => x.productId === r.productId && x.batchId === r.batchId);
    return d === undefined ? r : { ...r, quantityMinor: Math.max(0, r.quantityMinor - d.quantityMinor) };
  });

/** The M08 write-off of the damaged units at the floor — `wasted`, in the same batch as the `transferred_in` that brought them. */
export const damagePostings = (transfer: Transfer, damaged: readonly DamagedLine[], receivedBy: string, at: string): Movement[] =>
  damaged.map((d, i): Movement => ({
    movementId: `${transfer.transferId}-damaged-${i + 1}`, productId: d.productId, locationId: transfer.toLocationId, kind: 'wasted',
    quantityMinor: d.quantityMinor, uom: transfer.lines.find((l) => l.productId === d.productId && l.batchId === d.batchId)?.uom ?? 'EA',
    occurredAt: at, enteredBy: receivedBy,
    reason: `transfer ${transfer.transferId} arrived damaged at ${transfer.toLocationId} — written off, value ${d.valueMinor} minor`,
    ...(d.batchId === null ? {} : { batchId: d.batchId }),
  }));

/** The indent as every read returns it: the aggregate plus its derived figures and why it needs a person. */
export function presentIndent(indent: FloorIndent): Record<string, unknown> {
  return { ...indent, totals: indentTotals(indent), attention: indentAttention(indent) };
}

export function floorIndentRoutes(deps: FloorIndentsDeps): readonly Route[] {
  const audit = async (tenantId: string, entry: AuditEntry): Promise<void> => { await deps.recordAudit?.(tenantId, entry); };
  const origin = (tenantId: string, branchId: string | null): AuditEntry['origin'] => ({ tenantId, branchId });

  const costsFor = async (tenantId: string, locationId: string, productIds: readonly string[]): Promise<Record<string, number | null>> => {
    const out: Record<string, number | null> = {};
    for (const p of productIds) out[p] = (await deps.unitCostAt(tenantId, locationId, p)) ?? null;
    return out;
  };

  return [
    {
      // The floor ASKS. Body: { fromLocationId (the back store), toLocationId (the floor — where the till sells from),
      // lines: [{ productId, quantityMinor, uom }], reason? }. Both places must be ones head office knows (SP-5). Nothing
      // moves; a different person decides.
      api: 'API-04', method: 'POST', path: '/v1/floor/indents/:indentId',
      permission: 'inventory.indent.request', idempotent: true,
      handler: async (ctx) => {
        const indentId = (ctx.params['indentId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const lines = readIndentLines(b['lines']);
        if (indentId === '' || !isStr(b['fromLocationId']) || !isStr(b['toLocationId']) || lines === undefined || (b['reason'] !== undefined && b['reason'] !== null && typeof b['reason'] !== 'string')) {
          throw apiError(400, {
            code: 'not_readable_as_an_indent',
            whatHappened: 'A floor indent needs an indentId in the path and { fromLocationId, toLocationId, lines: [{ productId, quantityMinor (whole, above zero), uom }], reason? }.',
            wasItSaved: 'not_saved', nextSafeAction: 'Send the indent. Nothing was recorded.',
          });
        }
        const existing = await deps.indent(ctx.tenantId, indentId);
        if (existing !== undefined) return { status: 200, body: { indent: presentIndent(existing), alreadyRecorded: true } };
        for (const [role, locationId] of [['fromLocationId', b['fromLocationId']], ['toLocationId', b['toLocationId']]] as const) {
          if (!(await deps.knownLocation(ctx.tenantId, locationId))) {
            throw apiError(422, {
              code: 'unknown_location',
              whatHappened: `${role} "${locationId}" is not a place head office has any record of — no branch, warehouse or department by that id, no bin there, and no stock has ever been held there.`,
              wasItSaved: 'not_saved', nextSafeAction: 'Check the location id against the org structure or the bins. Nothing was recorded.',
            });
          }
        }
        const now = deps.now();
        let indent: FloorIndent;
        try {
          indent = requestIndent({ indentId, fromLocationId: b['fromLocationId'], toLocationId: b['toLocationId'], lines, requestedBy: ctx.userId, at: now, reason: isStr(b['reason']) ? b['reason'].trim() : null });
        } catch (e) { return refusedBy(e); }
        await deps.recordIndent(ctx.tenantId, indent, 'FloorIndentRequested');
        await audit(ctx.tenantId, {
          actorId: ctx.userId, action: 'floor_indent.request', objectType: 'floor_indent', objectId: indentId, at: now, origin: origin(ctx.tenantId, ctx.branchId ?? null),
          before: null, after: { state: 'requested', from: indent.fromLocationId, to: indent.toLocationId, lines: String(lines.length), requestedMinor: String(indentTotals(indent).requestedMinor) },
          ...(indent.reason === null ? {} : { reason: indent.reason }), correlationId: indentId,
        });
        return { status: 201, body: { indent: presentIndent(indent), alreadyRecorded: false } };
      },
    },
    {
      // A DIFFERENT person APPROVES, allocating against head office's own back-store stock (M09-FR-03 · §28). Body:
      // { allocations?: [{ productId, quantityMinor }], reason? } — a product left out is allocated min(requested, on-hand);
      // more than requested is refused; less is said (`short_allocated`); a back store short of the ask is said (`short_stock`).
      api: 'API-04', method: 'POST', path: '/v1/floor/indents/:indentId/approval',
      permission: 'inventory.indent.approve', idempotent: true,
      handler: async (ctx) => {
        const indentId = (ctx.params['indentId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const allocations: { productId: string; quantityMinor: number }[] = [];
        if (b['allocations'] !== undefined) {
          if (!Array.isArray(b['allocations'])) throw apiError(400, { code: 'not_readable_as_an_allocation', whatHappened: 'allocations is a list of { productId, quantityMinor (whole, zero or more) }.', wasItSaved: 'not_saved', nextSafeAction: 'Fix the allocations. Nothing was changed.' });
          for (const raw of b['allocations']) {
            if (!isObj(raw) || !isStr(raw['productId']) || !isInt(raw['quantityMinor'])) throw apiError(400, { code: 'not_readable_as_an_allocation', whatHappened: 'Each allocation needs a productId and a whole quantityMinor.', wasItSaved: 'not_saved', nextSafeAction: 'Fix the allocations. Nothing was changed.' });
            allocations.push({ productId: raw['productId'], quantityMinor: raw['quantityMinor'] });
          }
        }
        const indent = await deps.indent(ctx.tenantId, indentId);
        if (indent === undefined) throw notFound(`floor indent ${indentId}`);
        if (indent.state !== 'requested' && indent.approvedBy !== undefined) return { status: 200, body: { indent: presentIndent(indent), alreadyApproved: true } };
        const available = await deps.onHandAt(ctx.tenantId, indent.fromLocationId, indent.lines.map((l) => l.productId));
        const now = deps.now();
        let approved: FloorIndent;
        try {
          approved = approveIndent({ indent, approvedBy: ctx.userId, at: now, available, ...(b['allocations'] === undefined ? {} : { allocations }), reason: isStr(b['reason']) ? b['reason'].trim() : null });
        } catch (e) { return refusedBy(e); }
        await deps.recordIndent(ctx.tenantId, approved, 'FloorIndentApproved');
        await audit(ctx.tenantId, {
          actorId: ctx.userId, action: 'floor_indent.approve', objectType: 'floor_indent', objectId: indentId, at: now, origin: origin(ctx.tenantId, ctx.branchId ?? null),
          before: { state: 'requested', requestedBy: indent.requestedBy }, after: { state: 'approved', allocatedMinor: String(indentTotals(approved).allocatedMinor), flags: approved.flags.join(',') },
          ...(approved.approvalReason ? { reason: approved.approvalReason } : {}), correlationId: indentId,
        });
        return { status: 200, body: { indent: presentIndent(approved), alreadyApproved: false } };
      },
    },
    {
      // A DIFFERENT person REJECTS, with the reason (§28). Nothing moves.
      api: 'API-04', method: 'POST', path: '/v1/floor/indents/:indentId/rejection',
      permission: 'inventory.indent.approve', idempotent: true,
      handler: async (ctx) => {
        const indentId = (ctx.params['indentId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isStr(b['reason'])) throw apiError(400, { code: 'rejection_needs_a_reason', whatHappened: 'Rejecting an indent needs { reason }.', wasItSaved: 'not_saved', nextSafeAction: 'Send the reason. Nothing was changed.' });
        const indent = await deps.indent(ctx.tenantId, indentId);
        if (indent === undefined) throw notFound(`floor indent ${indentId}`);
        if (indent.state === 'rejected') return { status: 200, body: { indent: presentIndent(indent), alreadyRejected: true } };
        const now = deps.now();
        let rejected: FloorIndent;
        try { rejected = rejectIndent({ indent, rejectedBy: ctx.userId, at: now, reason: b['reason'].trim() }); } catch (e) { return refusedBy(e); }
        await deps.recordIndent(ctx.tenantId, rejected, 'FloorIndentRejected');
        await audit(ctx.tenantId, {
          actorId: ctx.userId, action: 'floor_indent.reject', objectType: 'floor_indent', objectId: indentId, at: now, origin: origin(ctx.tenantId, ctx.branchId ?? null),
          before: { state: 'requested', requestedBy: indent.requestedBy }, after: { state: 'rejected' }, reason: b['reason'].trim(), correlationId: indentId,
        });
        return { status: 200, body: { indent: presentIndent(rejected), alreadyRejected: false } };
      },
    },
    {
      // The back store ISSUES (the scan): each issue is a TRANSFER dispatched here — stock leaves the back store once, sits
      // in transit at the floor, not sellable. Body: { lines: [{ productId, batchId?, quantityMinor }] }. Refused: the
      // requester issuing to themselves (§28), a product the floor did not ask for (wrong item), more than is still owed,
      // and — by the transfer engine, against head office's own stock — an over-draw, a recalled or held batch.
      api: 'API-04', method: 'POST', path: '/v1/floor/indents/:indentId/issues/:issueId',
      permission: 'inventory.movement.append', idempotent: true,
      handler: async (ctx) => {
        const indentId = (ctx.params['indentId'] ?? '').trim();
        const issueId = (ctx.params['issueId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const lines = readIssueLines(b['lines']);
        if (indentId === '' || issueId === '' || lines === undefined || (b['currency'] !== undefined && !isCurrencyCode(b['currency'] as string))) {
          throw apiError(400, { code: 'not_readable_as_an_issue', whatHappened: 'An issue needs the indentId and issueId in the path and { lines: [{ productId, batchId?, quantityMinor (whole, above zero) }] }.', wasItSaved: 'not_saved', nextSafeAction: 'Send the issued lines. Nothing was moved.' });
        }
        const indent = await deps.indent(ctx.tenantId, indentId);
        if (indent === undefined) throw notFound(`floor indent ${indentId}`);
        const prior = indent.issues.find((i) => i.issueId === issueId);
        if (prior !== undefined) return { status: 200, body: { indent: presentIndent(indent), issue: prior, alreadyIssued: true } };
        const now = deps.now();
        const currency = (b['currency'] as CurrencyCode | undefined) ?? 'INR';
        try {
          const unitCostsMinor = await costsFor(ctx.tenantId, indent.fromLocationId, [...new Set(lines.map((l) => l.productId))]);
          const plan = planIssue({ indent, issueId, issuedBy: ctx.userId, lines, unitCostsMinor, currency, at: now });
          // The transfer engine's own §28 (dispatcher ≠ requester) and stock checks (SP-4/SP-5): head office's lots at the back store.
          const available = await deps.availableAt(ctx.tenantId, indent.fromLocationId, plan.transfer.lines);
          const dispatched = dispatchTransfer({ transfer: plan.transfer, approval: { subjectRef: plan.transfer.transferId, status: 'approved', decidedBy: ctx.userId }, available, at: now });
          const lineCostsMinor = plan.transfer.lines.map((l) => unitCostsMinor[l.productId] ?? null);
          const transfer: Transfer = { ...dispatched.transfer, lineCostsMinor };
          const posted = dispatchPostings(transfer, dispatched.movements, ctx.userId);
          // SP-8c on the direct route too: the bin a line names is lowered in the SAME write; a disagreement is said.
          const picks = await binPicksFor(deps, {
            tenantId: ctx.tenantId, indentId, issueId, lines, movedBy: ctx.userId, at: now,
            uomOf: (productId, batchId) => plan.transfer.lines.find((t) => t.productId === productId && t.batchId === batchId)?.uom ?? 'EA',
          });
          const next = applyIssue(indent, picks.disagrees ? { ...plan.issue, governanceFlags: ['bin_disagrees'] } : plan.issue);
          await deps.recordIssued(ctx.tenantId, next, transfer, dispatched.movements, posted, picks.binMovements);
          await audit(ctx.tenantId, {
            actorId: ctx.userId, action: 'floor_indent.issue', objectType: 'floor_indent', objectId: indentId, at: now, origin: origin(ctx.tenantId, ctx.branchId ?? null),
            before: { state: indent.state }, after: { state: next.state, issueId, transferId: transfer.transferId, issuedMinor: String(lines.reduce((s, l) => s + l.quantityMinor, 0)), posted: posted.map((m) => m.movementId).join(',') },
            correlationId: indentId,
          });
          return { status: 201, body: { indent: presentIndent(next), issue: plan.issue, transferId: transfer.transferId, posted: posted.map((m) => m.movementId), lineCostsMinor, binMovements: picks.binMovements.map((m) => m.commandId), flags: picks.disagrees ? ['bin_disagrees'] : [], alreadyIssued: false } };
        } catch (e) { return refusedBy(e); }
      },
    },
    {
      // The floor RECEIVES an issue — INDEPENDENTLY: a different person from the issuer counts what arrived. What arrived
      // becomes on-hand at the floor (shelf availability, at the cost it left with); a shortfall is a VALUED exception on
      // the exceptions read, never absorbed. A product not on the issue is refused (a wrong item is not received against it).
      api: 'API-04', method: 'POST', path: '/v1/floor/indents/:indentId/issues/:issueId/receipt',
      permission: 'inventory.movement.append', idempotent: true,
      handler: async (ctx) => {
        const indentId = (ctx.params['indentId'] ?? '').trim();
        const issueId = (ctx.params['issueId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const counted = readCounted(b['counted']);
        if (indentId === '' || issueId === '' || counted === undefined || (b['currency'] !== undefined && !isCurrencyCode(b['currency'] as string))) {
          throw apiError(400, { code: 'not_readable_as_a_receipt', whatHappened: 'A floor receipt needs { counted: [{ productId, batchId?, quantityMinor (whole, zero or more) }] } — what the floor actually counted.', wasItSaved: 'not_saved', nextSafeAction: 'Send what was counted. Nothing was recorded.' });
        }
        const indent = await deps.indent(ctx.tenantId, indentId);
        if (indent === undefined) throw notFound(`floor indent ${indentId}`);
        const issue = indent.issues.find((i) => i.issueId === issueId);
        if (issue === undefined) throw notFound(`issue ${issueId} on floor indent ${indentId}`);
        if (issue.state === 'received') return { status: 200, body: { indent: presentIndent(indent), issue, alreadyReceived: true } };
        const now = deps.now();
        try {
          planReceipt({ indent, issueId, receivedBy: ctx.userId, counted });
          const transfer = await deps.transferOf(ctx.tenantId, issue.transferId);
          if (transfer === undefined) throw notFound(`transfer ${issue.transferId}`);
          const result = receiveTransfer({ transfer, counted: arrivedOf(counted), receivedBy: ctx.userId, at: now, currency: (b['currency'] as CurrencyCode | undefined) ?? 'INR' });
          // SP-8c: damaged units arrived (out of transit) and are written off at the floor in the same write — never on the shelf.
          const damaged = damagedOf(counted, result.transfer);
          const posted = [...receivePostings(result.transfer, result.movements, ctx.userId), ...damagePostings(result.transfer, damaged, ctx.userId, now)];
          const next = applyReceipt(indent, issueId, { receivedBy: ctx.userId, at: now, received: goodOf(receivedOf(result.movements, result.transfer), damaged), shortfall: shortfallOf(result.discrepancies), damaged });
          await deps.recordReceipt(ctx.tenantId, next, result.transfer, result.movements, result.discrepancies, posted);
          await audit(ctx.tenantId, {
            actorId: ctx.userId, action: 'floor_indent.receive', objectType: 'floor_indent', objectId: indentId, at: now, origin: origin(ctx.tenantId, ctx.branchId ?? null),
            before: { state: indent.state, issueId, issuedBy: issue.issuedBy },
            after: { state: next.state, receivedMinor: String(counted.reduce((s, c) => s + c.quantityMinor, 0)), damagedMinor: String(damaged.reduce((s, d) => s + d.quantityMinor, 0)), shortfalls: String(result.discrepancies.filter((d) => d.differenceMinor < 0).length), posted: posted.map((m) => m.movementId).join(',') },
            correlationId: indentId,
          });
          return { status: 201, body: { indent: presentIndent(next), issue: next.issues.find((i) => i.issueId === issueId), posted: posted.map((m) => m.movementId), discrepancies: result.discrepancies, damaged, alreadyReceived: false } };
        } catch (e) { return refusedBy(e); }
      },
    },
    {
      // CANCEL the unissued remainder, with a reason. Stock already on the trolley must still be received; nothing issued
      // is undone here (a return is its own step).
      api: 'API-04', method: 'POST', path: '/v1/floor/indents/:indentId/cancel',
      permission: 'inventory.indent.request', idempotent: true,
      handler: async (ctx) => {
        const indentId = (ctx.params['indentId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isStr(b['reason'])) throw apiError(400, { code: 'cancel_needs_a_reason', whatHappened: 'Cancelling an indent needs { reason }.', wasItSaved: 'not_saved', nextSafeAction: 'Send the reason. Nothing was changed.' });
        const indent = await deps.indent(ctx.tenantId, indentId);
        if (indent === undefined) throw notFound(`floor indent ${indentId}`);
        if (indent.remainderCancelled) return { status: 200, body: { indent: presentIndent(indent), alreadyCancelled: true } };
        const now = deps.now();
        let cancelled: FloorIndent;
        try { cancelled = cancelIndent({ indent, cancelledBy: ctx.userId, at: now, reason: b['reason'].trim() }); } catch (e) { return refusedBy(e); }
        await deps.recordIndent(ctx.tenantId, cancelled, 'FloorIndentCancelled');
        await audit(ctx.tenantId, {
          actorId: ctx.userId, action: 'floor_indent.cancel', objectType: 'floor_indent', objectId: indentId, at: now, origin: origin(ctx.tenantId, ctx.branchId ?? null),
          before: { state: indent.state, outstandingMinor: String(indentTotals(indent).outstandingMinor) }, after: { state: cancelled.state, outstandingMinor: '0' }, reason: b['reason'].trim(), correlationId: indentId,
        });
        return { status: 200, body: { indent: presentIndent(cancelled), alreadyCancelled: false } };
      },
    },
    {
      // The floor asks to RETURN stock this indent brought (wrong item, overstock, damage found on the shelf). Body:
      // { lines: [{ productId, batchId?, quantityMinor }], reason }. Nothing moves until a different person at the back
      // store accepts it.
      api: 'API-04', method: 'POST', path: '/v1/floor/indents/:indentId/returns/:returnId',
      permission: 'inventory.indent.request', idempotent: true,
      handler: async (ctx) => {
        const indentId = (ctx.params['indentId'] ?? '').trim();
        const returnId = (ctx.params['returnId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const lines = readIssueLines(b['lines']);
        if (indentId === '' || returnId === '' || lines === undefined || !isStr(b['reason'])) {
          throw apiError(400, { code: 'not_readable_as_a_return', whatHappened: 'A return needs the indentId and returnId in the path and { lines: [{ productId, batchId?, quantityMinor }], reason }.', wasItSaved: 'not_saved', nextSafeAction: 'Send the lines and the reason. Nothing was recorded.' });
        }
        const indent = await deps.indent(ctx.tenantId, indentId);
        if (indent === undefined) throw notFound(`floor indent ${indentId}`);
        const prior = indent.returns.find((r) => r.returnId === returnId);
        if (prior !== undefined) return { status: 200, body: { indent: presentIndent(indent), return: prior, alreadyRecorded: true } };
        const now = deps.now();
        let next: FloorIndent;
        let ret;
        try {
          ret = planReturn({ indent, returnId, returnedBy: ctx.userId, lines, reason: b['reason'].trim(), at: now });
          next = applyReturnRequest(indent, ret);
        } catch (e) { return refusedBy(e); }
        await deps.recordIndent(ctx.tenantId, next, 'FloorIndentReturnRequested');
        await audit(ctx.tenantId, {
          actorId: ctx.userId, action: 'floor_indent.return.request', objectType: 'floor_indent', objectId: indentId, at: now, origin: origin(ctx.tenantId, ctx.branchId ?? null),
          before: { state: indent.state }, after: { returnId, returnedMinor: String(lines.reduce((s, l) => s + l.quantityMinor, 0)) }, reason: b['reason'].trim(), correlationId: indentId,
        });
        return { status: 201, body: { indent: presentIndent(next), return: ret, alreadyRecorded: false } };
      },
    },
    {
      // The back store ACCEPTS a return — a different person from the one who sent it back counts it in. The return's
      // transfer is dispatched (stock off the floor) and received (on-hand at the back store) in ONE step, a trolley walk;
      // a shortfall between what the floor said and what arrived is a valued exception.
      api: 'API-04', method: 'POST', path: '/v1/floor/indents/:indentId/returns/:returnId/accepted',
      permission: 'inventory.movement.append', idempotent: true,
      handler: async (ctx) => {
        const indentId = (ctx.params['indentId'] ?? '').trim();
        const returnId = (ctx.params['returnId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const counted = readCounted(b['counted']);
        if (indentId === '' || returnId === '' || counted === undefined || (b['currency'] !== undefined && !isCurrencyCode(b['currency'] as string))) {
          throw apiError(400, { code: 'not_readable_as_a_receipt', whatHappened: 'Accepting a return needs { counted: [{ productId, batchId?, quantityMinor }] } — what the back store counted in.', wasItSaved: 'not_saved', nextSafeAction: 'Send what was counted. Nothing was recorded.' });
        }
        const indent = await deps.indent(ctx.tenantId, indentId);
        if (indent === undefined) throw notFound(`floor indent ${indentId}`);
        const ret = indent.returns.find((r) => r.returnId === returnId);
        if (ret === undefined) throw notFound(`return ${returnId} on floor indent ${indentId}`);
        if (ret.state === 'accepted') return { status: 200, body: { indent: presentIndent(indent), return: ret, alreadyAccepted: true } };
        const now = deps.now();
        const currency = (b['currency'] as CurrencyCode | undefined) ?? 'INR';
        try {
          planReturnAcceptance({ indent, returnId, acceptedBy: ctx.userId, counted });
          const unitCostsMinor = await costsFor(ctx.tenantId, indent.toLocationId, [...new Set(ret.lines.map((l) => l.productId))]);
          const proposed = returnTransfer(indent, ret, unitCostsMinor, currency);
          const available = await deps.availableAt(ctx.tenantId, indent.toLocationId, proposed.lines);
          const dispatched = dispatchTransfer({ transfer: proposed, approval: { subjectRef: proposed.transferId, status: 'approved', decidedBy: ctx.userId }, available, at: now });
          const withCosts: Transfer = { ...dispatched.transfer, lineCostsMinor: proposed.lines.map((l) => unitCostsMinor[l.productId] ?? null) };
          const received = receiveTransfer({ transfer: withCosts, counted, receivedBy: ctx.userId, at: now, currency });
          const posted = [...dispatchPostings(withCosts, dispatched.movements, ctx.userId), ...receivePostings(received.transfer, received.movements, ctx.userId)];
          const next = applyReturnAcceptance(indent, returnId, { acceptedBy: ctx.userId, at: now, received: receivedOf(received.movements, received.transfer), shortfall: shortfallOf(received.discrepancies) });
          await deps.recordReturnAccepted(ctx.tenantId, next, received.transfer, dispatched.movements, received.movements, received.discrepancies, posted);
          await audit(ctx.tenantId, {
            actorId: ctx.userId, action: 'floor_indent.return.accept', objectType: 'floor_indent', objectId: indentId, at: now, origin: origin(ctx.tenantId, ctx.branchId ?? null),
            before: { returnId, returnedBy: ret.returnedBy }, after: { receivedMinor: String(counted.reduce((s, c) => s + c.quantityMinor, 0)), posted: posted.map((m) => m.movementId).join(',') }, correlationId: indentId,
          });
          return { status: 201, body: { indent: presentIndent(next), return: next.returns.find((r) => r.returnId === returnId), transferId: received.transfer.transferId, posted: posted.map((m) => m.movementId), discrepancies: received.discrepancies, alreadyAccepted: false } };
        } catch (e) { return refusedBy(e); }
      },
    },
    {
      api: 'API-04', method: 'GET', path: '/v1/floor/indents/:indentId',
      permission: 'inventory.indent.read',
      handler: async (ctx) => {
        const indent = await deps.indent(ctx.tenantId, (ctx.params['indentId'] ?? '').trim());
        if (indent === undefined) throw notFound(`floor indent ${ctx.params['indentId']}`);
        return { status: 200, body: presentIndent(indent) };
      },
    },
    {
      // The REGISTER the manager reads: pending indents and stock on the trolley (the matrix's "pending indents / stock in
      // transit"). Needing-a-person first (awaiting approval, then owed / on the trolley / arrived short), then the rest,
      // oldest first. `?toLocationId=` narrows to one floor; `?state=` to one state; `?open=true` hides closed ones.
      api: 'API-04', method: 'GET', path: '/v1/floor/indents',
      permission: 'inventory.indent.read',
      handler: async (ctx) => {
        const q = ctx.query ?? {};
        const all = await deps.indents(ctx.tenantId);
        const CLOSED: readonly string[] = ['received', 'rejected', 'cancelled'];
        const kept = all
          .filter((i) => (isStr(q['toLocationId']) ? i.toLocationId === q['toLocationId'] : true))
          .filter((i) => (isStr(q['state']) ? i.state === q['state'] : true))
          .filter((i) => (q['open'] === 'true' ? !CLOSED.includes(i.state) : true));
        const needing = (i: FloorIndent): boolean => indentAttention(i).length > 0;
        // Awaiting approval FIRST (a decision nobody has made outranks a trolley in progress, P-03), then oldest first.
        const rank = (i: FloorIndent): number => (i.state === 'requested' ? 0 : 1);
        const first = kept.filter(needing).sort((a, b) => rank(a) - rank(b) || a.requestedAt.localeCompare(b.requestedAt) || a.indentId.localeCompare(b.indentId));
        const rest = kept.filter((i) => !needing(i)).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt) || a.indentId.localeCompare(b.indentId));
        const totals = kept.map(indentTotals);
        return {
          status: 200,
          body: {
            indents: [...first, ...rest].map((i) => ({ ...presentIndent(i), needsAttention: needing(i) })),
            count: kept.length, needingAttentionCount: first.length,
            inTransitMinor: totals.reduce((s, t) => s + t.inTransitMinor, 0),
            outstandingMinor: totals.reduce((s, t) => s + t.outstandingMinor, 0),
            asAt: deps.now(),
          },
        };
      },
    },
  ];
}
