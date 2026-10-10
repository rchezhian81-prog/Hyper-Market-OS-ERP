// API-04 — the floor's INDENT, the back store's ISSUE and the floor's independent RECEIPT, RELAYED from the served screens
// and the warehouse handheld through the store box (SP-8b · SP-8c · F08 · WF-06 · M09-FR-03 · M08-FR-02 · §28 · §31 · P-01 ·
// P-08 · hard rules #1 #2 #4 #10).
//
// The floor raises an indent and counts in an issue on a screen the box serves; the back store ISSUES against the indent on
// the warehouse handheld (SP-8c: tap the line → scan the bin → scan the item → confirm). Each keeps its fact on the DURABLE
// device queue before it says "saved" (the same mechanism as the manager's decisions, receipts and counts and the buyer's
// invoices — SP-2 / SP-7a), hands it to the box over `/lane/outbox`, and the box relays it HERE under the store's sync
// credential. These routes make the device's facts head office's facts the same way the manager's became so:
//
//   • they trust the FACT (who asked / issued / counted what, when — the id is the device's own, so a re-sent item is one
//     record, §31.1) and re-run the JUDGEMENT here through the SAME indent and transfer engines the direct routes run: an
//     unknown place, a duplicate product, the requester issuing to themselves, an over-issue, an over-draw against head
//     office's own back-store stock, a wrong item, the issuer receiving their own issue are THEIR refusals — 4xx, which the
//     box dead-letters visibly for a person (hard rule #6), never silently applied and never dropped;
//   • they re-verify the REQUESTER / ISSUER / RECEIVER named by the device from their own grants and FLAG a breach on the
//     record (`requester_lacks_authority`, `issuer_unknown`, …) — never a silent trust of the relay's word (hard rules
//     #4/#10); the relay (the box) is recorded beside them, never as the actor;
//   • an issue posts the `transferred_out` movements exactly as the direct issue does, and lowers the back-store BIN the
//     handheld took from in the SAME atomic write (SP-8c) — one event in, one write out, never a second stock posting; a bin
//     head office disagrees with is FLAGGED, never silently forced;
//   • a receipt posts `transferred_in` once, writes damaged arrivals off at the floor in the same write (SP-8c), and values a
//     shortfall as the same exception the direct receipt raises.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { dispatchTransfer, receiveTransfer, type Transfer } from '../../../packages/warehouse/src/transfers';
import { applyMovement, type Bin, type BinContents, type MovementCommand } from '../../../packages/warehouse/src/movements';
import { requestIndent, planIssue, applyIssue, planReceipt, applyReceipt, indentTotals, type FloorIndent, type RelayedBy } from '../../../packages/warehouse/src/indents';
import { isCurrencyCode, type CurrencyCode } from '../../../packages/contracts/src/money';
import { dispatchPostings, receivePostings } from './warehouse-transfers';
import { assertIndentInScope } from './floor-indents';
import {
  presentIndent, refusedBy, readIndentLines, readIssueLines, readCounted, receivedOf, shortfallOf, arrivedOf, damagedOf, goodOf, damagePostings,
  type FloorIndentsDeps, type BinMovementRecord,
} from './floor-indents';

export const INDENT_SYNC_FLAGS = Object.freeze([
  'requester_unknown', 'requester_lacks_authority',
  'issuer_unknown', 'issuer_lacks_authority',
  'receiver_unknown', 'receiver_lacks_authority',
  // SP-8c: the handheld named a back-store bin head office does not know or whose contents cannot cover the issue — the
  // location-level stock is the truth (it left the back store once); the bin disagreement is said, not forced.
  'bin_disagrees',
] as const);
export type IndentSyncFlag = (typeof INDENT_SYNC_FLAGS)[number];

/** The permission the floor person must hold to have RAISED an indent in their own name; the issuer's / receiver's to have moved stock. */
const REQUEST_PERMISSION = 'inventory.indent.request';
const MOVE_PERMISSION = 'inventory.movement.append';

export interface SyncedFloorIndentsDeps extends FloorIndentsDeps {
  readonly permissionsOfUser: (tenantId: string, userId: string) => Promise<readonly string[] | undefined> | readonly string[] | undefined;
  /** SP-8c: head office's bin register, so a handheld issue lowers the same bin it took from. Optional: a cloud without bins flags, never fails. */
  readonly bins?: (tenantId: string) => Promise<readonly Bin[]> | readonly Bin[];
  readonly contents?: (tenantId: string) => Promise<BinContents> | BinContents;
  readonly appliedCommandIds?: (tenantId: string) => Promise<readonly string[]> | readonly string[];
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isIso = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(v));

/** Re-verify the named person from THEIR grants (§28): flags, never a silent trust of the relay's word. */
async function verify(deps: SyncedFloorIndentsDeps, tenantId: string, userId: string, permission: string, unknown: IndentSyncFlag, lacks: IndentSyncFlag): Promise<IndentSyncFlag[]> {
  const permissions = await deps.permissionsOfUser(tenantId, userId);
  if (permissions === undefined) return [unknown];
  return permissions.includes(permission) ? [] : [lacks];
}

const relayOf = (ctx: { userId: string }, body: Record<string, unknown>): RelayedBy =>
  ({ relayedBy: ctx.userId, source: isStr(body['source']) ? body['source'] : 'unknown', storeId: isStr(body['storeId']) ? body['storeId'] : null });

export function syncedFloorIndentRoutes(deps: SyncedFloorIndentsDeps): readonly Route[] {
  const audit = async (tenantId: string, entry: AuditEntry): Promise<void> => { await deps.recordAudit?.(tenantId, entry); };
  const costsFor = async (tenantId: string, locationId: string, productIds: readonly string[]): Promise<Record<string, number | null>> => {
    const out: Record<string, number | null> = {};
    for (const p of productIds) out[p] = (await deps.unitCostAt(tenantId, locationId, p)) ?? null;
    return out;
  };

  return [
    {
      // The floor's INDENT as the screen queued it (`FloorIndentRequested`): { indentId, fromLocationId, toLocationId, lines,
      // reason?, requestedBy, at, storeId?, source? }. Idempotent per indentId: the same indent again is 200.
      api: 'API-04', method: 'POST', path: '/v1/floor/indents/:indentId/synced',
      permission: 'inventory.indent.sync', idempotent: true,
      handler: async (ctx) => {
        const indentId = (ctx.params['indentId'] ?? '').trim();
        const b = isObj(ctx.body) ? ctx.body : {};
        const lines = readIndentLines(b['lines']);
        if (indentId === '' || b['indentId'] !== indentId || !isStr(b['fromLocationId']) || !isStr(b['toLocationId']) || lines === undefined
          || !isStr(b['requestedBy']) || !isIso(b['at']) || (b['reason'] !== undefined && b['reason'] !== null && typeof b['reason'] !== 'string')) {
          throw apiError(400, {
            code: 'not_readable_as_a_relayed_indent',
            whatHappened: 'This payload could not be read as a floor indent from the store — it needs the indentId matching the path, fromLocationId, toLocationId, lines [{ productId, quantityMinor, uom }], the requestedBy and when it was raised.',
            wasItSaved: 'not_saved', nextSafeAction: 'Do not discard it at the store. Keep it in the queue and raise it.',
          });
        }
        const existing = await deps.indent(ctx.tenantId, indentId);
        await assertIndentInScope(ctx, deps.locationBranches, existing ?? { fromLocationId: b['fromLocationId'], toLocationId: b['toLocationId'] }); // PA-01-r1
        if (existing !== undefined) return { status: 200, body: { indentId, recorded: true, alreadyRecorded: true, indent: presentIndent(existing) } };
        for (const [role, locationId] of [['fromLocationId', b['fromLocationId']], ['toLocationId', b['toLocationId']]] as const) {
          if (!(await deps.knownLocation(ctx.tenantId, locationId))) {
            throw apiError(422, {
              code: 'unknown_location',
              whatHappened: `${role} "${locationId}" is not a place head office has any record of.`,
              wasItSaved: 'not_saved', nextSafeAction: 'A person must look at this indent: the place it names is not known to head office. Nothing was recorded.',
            });
          }
        }
        const flags = await verify(deps, ctx.tenantId, b['requestedBy'], REQUEST_PERMISSION, 'requester_unknown', 'requester_lacks_authority');
        const relayed = relayOf(ctx, b);
        let indent: FloorIndent;
        try {
          indent = { ...requestIndent({ indentId, fromLocationId: b['fromLocationId'], toLocationId: b['toLocationId'], lines, requestedBy: b['requestedBy'], at: b['at'], reason: isStr(b['reason']) ? b['reason'].trim() : null }), governanceFlags: flags, relayed };
        } catch (e) { return refusedBy(e); }
        await deps.recordIndent(ctx.tenantId, indent, 'FloorIndentRequested');
        await audit(ctx.tenantId, {
          actorId: b['requestedBy'], action: 'floor_indent.request', objectType: 'floor_indent', objectId: indentId, at: b['at'], origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: null,
          after: { state: 'requested', from: indent.fromLocationId, to: indent.toLocationId, lines: String(lines.length), requestedMinor: String(indentTotals(indent).requestedMinor), relayedBy: ctx.userId, source: relayed.source, storeId: relayed.storeId ?? '', flags: flags.join(',') },
          ...(indent.reason === null ? {} : { reason: indent.reason }), correlationId: indentId,
        });
        // 202: the floor asked at the store; this records it and what head office found about the asker.
        return { status: 202, body: { indentId, recorded: true, alreadyRecorded: false, flags, indent: presentIndent(indent) } };
      },
    },
    {
      // SP-8c: the back store's ISSUE as the warehouse handheld queued it (`FloorIndentIssued`): { indentId, issueId,
      // lines [{ productId, batchId?, quantityMinor, binId? }], issuedBy, at, storeId?, source? }. The SAME engines as the
      // direct issue: the indent engine refuses the requester issuing to themselves, a wrong item and an over-issue; the
      // transfer engine dispatches against head office's own back-store lots (over-draw, recalled, held refused); the
      // `transferred_out` movements post once; the named BIN is lowered in the same write, or flagged if head office
      // disagrees. Idempotent per issueId: the same issue again is 200.
      api: 'API-04', method: 'POST', path: '/v1/floor/indents/:indentId/issues/:issueId/synced',
      permission: 'inventory.indent.sync', idempotent: true,
      handler: async (ctx) => {
        const indentId = (ctx.params['indentId'] ?? '').trim();
        const issueId = (ctx.params['issueId'] ?? '').trim();
        const b = isObj(ctx.body) ? ctx.body : {};
        const lines = readIssueLines(b['lines']);
        if (indentId === '' || issueId === '' || b['indentId'] !== indentId || b['issueId'] !== issueId || lines === undefined || !isStr(b['issuedBy']) || !isIso(b['at'])
          || (b['currency'] !== undefined && !isCurrencyCode(b['currency'] as string))) {
          throw apiError(400, {
            code: 'not_readable_as_a_relayed_issue',
            whatHappened: 'This payload could not be read as a back-store issue from the handheld — it needs the indentId and issueId matching the path, lines [{ productId, batchId?, quantityMinor, binId? }], the issuedBy and when it was issued.',
            wasItSaved: 'not_saved', nextSafeAction: 'Do not discard it at the store. Keep it in the queue and raise it.',
          });
        }
        const indent = await deps.indent(ctx.tenantId, indentId);
        await assertIndentInScope(ctx, deps.locationBranches, indent); // PA-01-r1
        if (indent === undefined) throw notFound(`floor indent ${indentId}`);
        const prior = indent.issues.find((i) => i.issueId === issueId);
        if (prior !== undefined) return { status: 200, body: { indentId, issueId, recorded: true, alreadyIssued: true, issue: prior, indent: presentIndent(indent) } };
        const issuedBy = b['issuedBy'];
        const at = b['at'];
        const flags: IndentSyncFlag[] = await verify(deps, ctx.tenantId, issuedBy, MOVE_PERMISSION, 'issuer_unknown', 'issuer_lacks_authority');
        const relayed = relayOf(ctx, b);
        const currency = (b['currency'] as CurrencyCode | undefined) ?? 'INR';
        try {
          const unitCostsMinor = await costsFor(ctx.tenantId, indent.fromLocationId, [...new Set(lines.map((l) => l.productId))]);
          const plan = planIssue({ indent, issueId, issuedBy, lines, unitCostsMinor, currency, at });
          // The transfer engine's own §28 (dispatcher ≠ requester) and stock checks against head office's lots at the back store.
          const available = await deps.availableAt(ctx.tenantId, indent.fromLocationId, plan.transfer.lines);
          const dispatched = dispatchTransfer({ transfer: plan.transfer, approval: { subjectRef: plan.transfer.transferId, status: 'approved', decidedBy: issuedBy }, available, at });
          const lineCostsMinor = plan.transfer.lines.map((l) => unitCostsMinor[l.productId] ?? null);
          const transfer: Transfer = { ...dispatched.transfer, lineCostsMinor };
          const posted = dispatchPostings(transfer, dispatched.movements, issuedBy);

          // SP-8c: lower the bin the handheld took from — in the SAME write as the stock movement. Head office's bin register
          // is judged with the same engine the handheld ran; a disagreement is flagged for a person, never forced and never
          // a second location-level posting.
          const binMovements: BinMovementRecord[] = [];
          if (deps.bins !== undefined && deps.contents !== undefined && deps.appliedCommandIds !== undefined && lines.some((l) => isStr(l.binId))) {
            const bins = await deps.bins(ctx.tenantId);
            const contents = await deps.contents(ctx.tenantId);
            const applied = [...await deps.appliedCommandIds(ctx.tenantId)];
            lines.forEach((l, i) => {
              if (!isStr(l.binId)) return;
              const commandId = `${indentId}:${issueId}:${i + 1}`;
              if (applied.includes(commandId)) return;
              const bin = bins.find((x) => x.binId === l.binId);
              if (bin === undefined) { if (!flags.includes('bin_disagrees')) flags.push('bin_disagrees'); return; }
              const command: MovementCommand = {
                commandId, kind: 'pick', storeId: bin.storeId, productId: l.productId, batchId: l.batchId, quantityMinor: l.quantityMinor,
                uom: plan.transfer.lines.find((t) => t.productId === l.productId && t.batchId === l.batchId)?.uom ?? 'EA',
                fromBinId: l.binId, toBinId: null, movedBy: issuedBy, at, reason: `indent ${indentId} issue ${issueId}`,
              };
              const result = applyMovement({ command, appliedCommandIds: applied, bins, contents });
              if (!result.accepted) { if (!flags.includes('bin_disagrees')) flags.push('bin_disagrees'); return; }
              applied.push(commandId);
              binMovements.push({ commandId, movements: result.movements });
            });
          }

          const next = applyIssue(indent, { ...plan.issue, governanceFlags: flags, relayed });
          await deps.recordIssued(ctx.tenantId, next, transfer, dispatched.movements, posted, binMovements);
          await audit(ctx.tenantId, {
            actorId: issuedBy, action: 'floor_indent.issue', objectType: 'floor_indent', objectId: indentId, at, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
            before: { state: indent.state },
            after: {
              state: next.state, issueId, transferId: transfer.transferId, issuedMinor: String(lines.reduce((s, l) => s + l.quantityMinor, 0)),
              bins: lines.map((l) => l.binId ?? '').filter((x) => x !== '').join(','), binMovements: String(binMovements.length),
              posted: posted.map((m) => m.movementId).join(','), relayedBy: ctx.userId, source: relayed.source, storeId: relayed.storeId ?? '', flags: flags.join(','),
            },
            correlationId: indentId,
          });
          return {
            status: 202,
            body: { indentId, issueId, recorded: true, alreadyIssued: false, flags, transferId: transfer.transferId, posted: posted.map((m) => m.movementId), lineCostsMinor, binMovements: binMovements.map((m) => m.commandId), indent: presentIndent(next) },
          };
        } catch (e) { return refusedBy(e); }
      },
    },
    {
      // The floor's independent RECEIPT of an issue as the screen queued it (`FloorIndentReceived`): { indentId, issueId,
      // counted [{ productId, batchId?, quantityMinor, damagedMinor? }], receivedBy, at, storeId?, source? }. The engine
      // refuses the issuer receiving their own issue and a wrong item; what arrived GOOD becomes shelf availability once; what
      // arrived DAMAGED is written off at the floor in the same write (SP-8c); a shortfall is valued.
      api: 'API-04', method: 'POST', path: '/v1/floor/indents/:indentId/issues/:issueId/receipt/synced',
      permission: 'inventory.indent.sync', idempotent: true,
      handler: async (ctx) => {
        const indentId = (ctx.params['indentId'] ?? '').trim();
        const issueId = (ctx.params['issueId'] ?? '').trim();
        const b = isObj(ctx.body) ? ctx.body : {};
        const counted = readCounted(b['counted']);
        if (indentId === '' || issueId === '' || b['indentId'] !== indentId || b['issueId'] !== issueId || counted === undefined || !isStr(b['receivedBy']) || !isIso(b['at'])
          || (b['currency'] !== undefined && !isCurrencyCode(b['currency'] as string))) {
          throw apiError(400, {
            code: 'not_readable_as_a_relayed_receipt',
            whatHappened: 'This payload could not be read as a floor receipt from the store — it needs the indentId and issueId matching the path, counted [{ productId, batchId?, quantityMinor, damagedMinor? }], the receivedBy and when it was counted.',
            wasItSaved: 'not_saved', nextSafeAction: 'Do not discard it at the store. Keep it in the queue and raise it.',
          });
        }
        const indent = await deps.indent(ctx.tenantId, indentId);
        await assertIndentInScope(ctx, deps.locationBranches, indent); // PA-01-r1
        if (indent === undefined) throw notFound(`floor indent ${indentId}`);
        const issue = indent.issues.find((i) => i.issueId === issueId);
        if (issue === undefined) throw notFound(`issue ${issueId} on floor indent ${indentId}`);
        if (issue.state === 'received') return { status: 200, body: { indentId, issueId, recorded: true, alreadyReceived: true, indent: presentIndent(indent) } };
        const flags = await verify(deps, ctx.tenantId, b['receivedBy'], MOVE_PERMISSION, 'receiver_unknown', 'receiver_lacks_authority');
        const relayed = relayOf(ctx, b);
        try {
          planReceipt({ indent, issueId, receivedBy: b['receivedBy'], counted });
          const transfer = await deps.transferOf(ctx.tenantId, issue.transferId);
          if (transfer === undefined) throw notFound(`transfer ${issue.transferId}`);
          const result = receiveTransfer({ transfer, counted: arrivedOf(counted), receivedBy: b['receivedBy'], at: b['at'], currency: (b['currency'] as CurrencyCode | undefined) ?? 'INR' });
          const damaged = damagedOf(counted, result.transfer);
          const posted = [...receivePostings(result.transfer, result.movements, b['receivedBy']), ...damagePostings(result.transfer, damaged, b['receivedBy'], b['at'])];
          const next = applyReceipt(indent, issueId, {
            receivedBy: b['receivedBy'], at: b['at'], received: goodOf(receivedOf(result.movements, result.transfer), damaged), shortfall: shortfallOf(result.discrepancies), damaged, governanceFlags: flags, relayed,
          });
          await deps.recordReceipt(ctx.tenantId, next, result.transfer, result.movements, result.discrepancies, posted);
          await audit(ctx.tenantId, {
            actorId: b['receivedBy'], action: 'floor_indent.receive', objectType: 'floor_indent', objectId: indentId, at: b['at'], origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
            before: { state: indent.state, issueId, issuedBy: issue.issuedBy },
            after: {
              state: next.state, receivedMinor: String(counted.reduce((s, c) => s + c.quantityMinor, 0)), damagedMinor: String(damaged.reduce((s, d) => s + d.quantityMinor, 0)),
              shortfalls: String(result.discrepancies.filter((d) => d.differenceMinor < 0).length), posted: posted.map((m) => m.movementId).join(','),
              relayedBy: ctx.userId, source: relayed.source, storeId: relayed.storeId ?? '', flags: flags.join(','),
            },
            correlationId: indentId,
          });
          return { status: 202, body: { indentId, issueId, recorded: true, alreadyReceived: false, flags, posted: posted.map((m) => m.movementId), discrepancies: result.discrepancies, damaged, indent: presentIndent(next) } };
        } catch (e) { return refusedBy(e); }
      },
    },
  ];
}
