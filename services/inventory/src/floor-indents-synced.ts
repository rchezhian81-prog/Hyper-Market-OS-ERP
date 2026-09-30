// API-04 — the floor's INDENT and its independent RECEIPT, RELAYED from the served Indents screen through the store box
// (SP-8b · F08 · WF-06 · M09-FR-03 · M08-FR-02 · §28 · §31 · P-01 · P-08 · hard rules #1 #2 #4 #10).
//
// The floor raises an indent and counts in an issue on a screen the box serves. The screen keeps each on the DURABLE
// device queue before it says "saved" (the same mechanism as the manager's decisions, receipts and counts and the buyer's
// invoices — SP-2 / SP-7a), hands it to the box over `/lane/outbox`, and the box relays it HERE under the store's sync
// credential. These two routes make the floor's facts head office's facts the same way the manager's became so:
//
//   • they trust the FACT (who asked for what, who counted what, when — the id is the screen's own, so a re-sent item
//     is one record, §31.1) and re-run the JUDGEMENT here through the SAME indent engine the direct routes run: an
//     unknown place, a duplicate product, a wrong item, the issuer receiving their own issue are ITS refusals — 422,
//     which the box dead-letters visibly for a person (hard rule #6), never silently applied and never dropped;
//   • they re-verify the REQUESTER / RECEIVER named by the device from their own grants and FLAG a breach on the record
//     (`requester_lacks_authority`, `receiver_unknown`, …) — never a silent trust of the relay's word (hard rules #4/#10);
//     the relay (the box) is recorded beside them, never as the actor;
//   • a receipt posts the `transferred_in` movements exactly as the direct receipt does — what arrived is on the shelf
//     once, at the cost it left with; a shortfall is the same valued exception. Nothing here is a second stock posting.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { receiveTransfer } from '../../../packages/warehouse/src/transfers';
import { requestIndent, planReceipt, applyReceipt, indentTotals, type FloorIndent, type RelayedBy } from '../../../packages/warehouse/src/indents';
import { isCurrencyCode, type CurrencyCode } from '../../../packages/contracts/src/money';
import { receivePostings } from './warehouse-transfers';
import { presentIndent, refusedBy, readIndentLines, readCounted, receivedOf, shortfallOf, type FloorIndentsDeps } from './floor-indents';

export const INDENT_SYNC_FLAGS = Object.freeze(['requester_unknown', 'requester_lacks_authority', 'receiver_unknown', 'receiver_lacks_authority'] as const);
export type IndentSyncFlag = (typeof INDENT_SYNC_FLAGS)[number];

/** The permission the floor person must hold to have RAISED an indent in their own name; the receiver's to have received. */
const REQUEST_PERMISSION = 'inventory.indent.request';
const RECEIVE_PERMISSION = 'inventory.movement.append';

export interface SyncedFloorIndentsDeps extends FloorIndentsDeps {
  readonly permissionsOfUser: (tenantId: string, userId: string) => Promise<readonly string[] | undefined> | readonly string[] | undefined;
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
      // The floor's independent RECEIPT of an issue as the screen queued it (`FloorIndentReceived`): { indentId, issueId,
      // counted [{ productId, batchId?, quantityMinor }], receivedBy, at, storeId?, source? }. The engine refuses the issuer
      // receiving their own issue and a wrong item; what arrived becomes shelf availability once; a shortfall is valued.
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
            whatHappened: 'This payload could not be read as a floor receipt from the store — it needs the indentId and issueId matching the path, counted [{ productId, batchId?, quantityMinor }], the receivedBy and when it was counted.',
            wasItSaved: 'not_saved', nextSafeAction: 'Do not discard it at the store. Keep it in the queue and raise it.',
          });
        }
        const indent = await deps.indent(ctx.tenantId, indentId);
        if (indent === undefined) throw notFound(`floor indent ${indentId}`);
        const issue = indent.issues.find((i) => i.issueId === issueId);
        if (issue === undefined) throw notFound(`issue ${issueId} on floor indent ${indentId}`);
        if (issue.state === 'received') return { status: 200, body: { indentId, issueId, recorded: true, alreadyReceived: true, indent: presentIndent(indent) } };
        const flags = await verify(deps, ctx.tenantId, b['receivedBy'], RECEIVE_PERMISSION, 'receiver_unknown', 'receiver_lacks_authority');
        const relayed = relayOf(ctx, b);
        try {
          planReceipt({ indent, issueId, receivedBy: b['receivedBy'], counted });
          const transfer = await deps.transferOf(ctx.tenantId, issue.transferId);
          if (transfer === undefined) throw notFound(`transfer ${issue.transferId}`);
          const result = receiveTransfer({ transfer, counted, receivedBy: b['receivedBy'], at: b['at'], currency: (b['currency'] as CurrencyCode | undefined) ?? 'INR' });
          const posted = receivePostings(result.transfer, result.movements, b['receivedBy']);
          const next = applyReceipt(indent, issueId, { receivedBy: b['receivedBy'], at: b['at'], received: receivedOf(result.movements, result.transfer), shortfall: shortfallOf(result.discrepancies), governanceFlags: flags, relayed });
          await deps.recordReceipt(ctx.tenantId, next, result.transfer, result.movements, result.discrepancies, posted);
          await audit(ctx.tenantId, {
            actorId: b['receivedBy'], action: 'floor_indent.receive', objectType: 'floor_indent', objectId: indentId, at: b['at'], origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
            before: { state: indent.state, issueId, issuedBy: issue.issuedBy },
            after: { state: next.state, receivedMinor: String(counted.reduce((s, c) => s + c.quantityMinor, 0)), shortfalls: String(result.discrepancies.filter((d) => d.differenceMinor < 0).length), posted: posted.map((m) => m.movementId).join(','), relayedBy: ctx.userId, source: relayed.source, storeId: relayed.storeId ?? '', flags: flags.join(',') },
            correlationId: indentId,
          });
          return { status: 202, body: { indentId, issueId, recorded: true, alreadyReceived: false, flags, posted: posted.map((m) => m.movementId), discrepancies: result.discrepancies, indent: presentIndent(next) } };
        } catch (e) { return refusedBy(e); }
      },
    },
  ];
}
