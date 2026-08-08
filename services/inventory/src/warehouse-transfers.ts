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

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  dispatchTransfer, receiveTransfer, proposeAllocation, TransferRefusedError,
  type Transfer, type TransferLine, type TransferApproval, type AvailableLot, type AllocationNeed,
} from '../../../packages/warehouse/src/transfers';
import type { StockMovement } from '../../../packages/stock/src/position';
import { isCurrencyCode, type CurrencyCode, type Money } from '../../../packages/contracts/src/money';

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isInt = (v: unknown): v is number => Number.isInteger(v);
const isPosInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
const rec = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const isMoney = (v: unknown): v is Money => { const r = rec(v); return r !== null && Number.isInteger(r['minor']) && isCurrencyCode(r['currency'] as string); };
const LOT_STATES = ['on_hand', 'quarantine', 'expired', 'damaged'] as const;

export interface TransfersDeps {
  readonly transfer: (tenantId: string, transferId: string) => Promise<Transfer | undefined> | Transfer | undefined;
  readonly recordProposed: (tenantId: string, transfer: Transfer) => Promise<void> | void;
  readonly recordDispatched: (tenantId: string, transfer: Transfer, movements: readonly StockMovement[]) => Promise<void> | void;
  readonly recordReceived: (tenantId: string, transfer: Transfer, movements: readonly StockMovement[], discrepancies: unknown) => Promise<void> | void;
  readonly now: () => string;
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

function readLots(v: unknown): AvailableLot[] | null {
  if (!Array.isArray(v)) return null;
  const lots: AvailableLot[] = [];
  for (const raw of v) {
    const l = rec(raw);
    if (l === null || !isStr(l['productId']) || !isInt(l['quantityMinor']) || typeof l['state'] !== 'string' || !(LOT_STATES as readonly string[]).includes(l['state'])
      || (l['batchId'] !== null && !isStr(l['batchId'])) || (l['recalled'] !== undefined && typeof l['recalled'] !== 'boolean')) return null;
    lots.push({ productId: l['productId'] as string, batchId: isStr(l['batchId']) ? (l['batchId'] as string) : null, quantityMinor: l['quantityMinor'] as number, state: l['state'] as AvailableLot['state'], ...(l['recalled'] === true ? { recalled: true } : {}) });
  }
  return lots;
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
        const transfer: Transfer = { transferId, fromLocationId: b.fromLocationId, toLocationId: b.toLocationId, lines, state: 'proposed', requestedBy: ctx.userId };
        await deps.recordProposed(ctx.tenantId, transfer);
        return { status: 201, body: { transferId, state: 'proposed', fromLocationId: transfer.fromLocationId, toLocationId: transfer.toLocationId, lines: lines.length } };
      },
    },
    {
      // Dispatch: stock leaves the source and becomes in-transit AT THE DESTINATION. Needs a separate
      // approver, and refuses recalled/quarantined/expired/damaged stock and an over-draw.
      api: 'API-04', method: 'POST', path: '/v1/warehouse/transfers/:transferId/dispatch',
      permission: 'inventory.movement.append', idempotent: true,
      handler: async (ctx) => {
        const transferId = ctx.params['transferId'] ?? '';
        const b = (ctx.body ?? {}) as { approvedBy?: unknown; available?: unknown };
        const available = readLots(b.available);
        if (!isStr(b.approvedBy) || available === null) {
          throw apiError(400, { code: 'not_readable_as_a_dispatch', whatHappened: 'A dispatch needs an approvedBy and the available lots (productId, whole quantityMinor, state).', wasItSaved: 'not_saved', nextSafeAction: 'Send the approver and available stock. Nothing was moved.' });
        }
        const transfer = await deps.transfer(ctx.tenantId, transferId);
        if (transfer === undefined) throw notFound(`transfer ${transferId}`);
        const approval: TransferApproval = { subjectRef: transferId, status: 'approved', decidedBy: b.approvedBy };
        try {
          const result = dispatchTransfer({ transfer, approval, available, at: deps.now() });
          await deps.recordDispatched(ctx.tenantId, result.transfer, result.movements);
          return { status: 200, body: { transferId, state: result.transfer.state, approvedBy: result.transfer.approvedBy, movements: result.movements.length } };
        } catch (e) {
          if (e instanceof TransferRefusedError) refused(e.why);
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
          await deps.recordReceived(ctx.tenantId, result.transfer, result.movements, result.discrepancies);
          return { status: 200, body: { transferId, state: result.transfer.state, received: result.movements.length, discrepancies: result.discrepancies } };
        } catch (e) {
          if (e instanceof TransferRefusedError) refused(e.why);
          throw e;
        }
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
