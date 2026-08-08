// API-04 warehouse put-away & bin movements (M09-FR-01). The handheld scans a movement; the surface
// applies it against the CURRENT bins and their contents and appends the ledger movements, or refuses
// with the reason. The refusals are the point (each protects something a later report cannot rebuild):
//   • a movement carries a unique commandId, so a DOUBLE SCAN is a no-op that says so (a movement done
//     twice makes a bin negative, and negative bins are how a warehouse stops believing its numbers);
//   • an UNKNOWN BIN is queued for resolution, never invented ("somewhere near aisle 4" loses stock);
//   • a FULL BIN is blocked (capacity is not advisory — the overflow ends up on the floor);
//   • MOVING MORE THAN A BIN HOLDS is refused (a negative bin poisons every count after it);
//   • QUARANTINED/EXPIRED/DAMAGED stock cannot be put into a PICKABLE bin — the commonest way bad stock
//     reaches a customer is a put-away, not a decision.
//
// The rules are the pure `applyMovement` / `suggestPutAway` / `binOccupancy` engines in
// `packages/warehouse` (a complete engine nothing fed). This surface gives them the bin registry, the
// append-only movement ledger (contents PROJECTED from it, never stored — hard rule #2) and the reads.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  applyMovement, suggestPutAway, binOccupancy,
  type Bin, type MovementCommand, type MovementKind, type BinContents,
} from '../../../packages/warehouse/src/movements';
import type { StockMovement, StockState } from '../../../packages/stock/src/position';

const KINDS: readonly MovementKind[] = ['put_away', 'bin_to_bin', 'pick', 'pack', 'dispatch', 'return_to_bin'];
const ZONES = ['ambient', 'chilled', 'frozen', 'secure', 'quarantine'] as const;
const STATES: readonly StockState[] = ['on_hand', 'reserved', 'quarantine', 'damaged', 'expired', 'in_transit'];
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isInt = (v: unknown): v is number => Number.isInteger(v);
const nbin = (v: unknown): string | null => (isStr(v) ? v : null);

export interface WarehouseDeps {
  readonly bins: (tenantId: string) => Promise<readonly Bin[]> | readonly Bin[];
  readonly contents: (tenantId: string) => Promise<BinContents> | BinContents;
  readonly appliedCommandIds: (tenantId: string) => Promise<readonly string[]> | readonly string[];
  readonly recordBin: (tenantId: string, bin: Bin) => Promise<void> | void;
  readonly recordMovement: (tenantId: string, commandId: string, movements: readonly StockMovement[]) => Promise<void> | void;
  readonly now: () => string;
}

export function warehouseRoutes(deps: WarehouseDeps): readonly Route[] {
  return [
    {
      // Register (or re-define) a bin — capacity and pickability are facts a movement is decided against.
      api: 'API-04', method: 'POST', path: '/v1/warehouse/bins/:binId',
      permission: 'inventory.movement.append', idempotent: true,
      handler: async (ctx) => {
        const binId = ctx.params['binId'] ?? '';
        const b = (ctx.body ?? {}) as { storeId?: unknown; capacityMinor?: unknown; pickable?: unknown; zone?: unknown; locationId?: unknown };
        if (!isStr(b.storeId) || !isInt(b.capacityMinor) || (b.capacityMinor as number) < 0 || typeof b.pickable !== 'boolean'
          || (b.zone !== undefined && !(ZONES as readonly string[]).includes(b.zone as string))
          || (b.locationId !== undefined && !isStr(b.locationId))) {
          throw apiError(400, {
            code: 'not_readable_as_a_bin',
            whatHappened: 'A bin needs a storeId, a whole non-negative capacityMinor, and pickable true/false (zone and locationId optional).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the bin definition. Nothing was recorded.',
          });
        }
        const bin: Bin = {
          binId, storeId: b.storeId, capacityMinor: b.capacityMinor as number, pickable: b.pickable,
          ...(isStr(b.zone) ? { zone: b.zone as Bin['zone'] } : {}),
          ...(isStr(b.locationId) ? { locationId: b.locationId } : {}),
        };
        await deps.recordBin(ctx.tenantId, bin);
        return { status: 201, body: { binId, storeId: bin.storeId, capacityMinor: bin.capacityMinor, pickable: bin.pickable, zone: bin.zone ?? null } };
      },
    },
    {
      // Apply one scanned movement — a double scan is idempotent, an unknown/full/over-drawn bin is
      // refused, and bad stock never enters a pickable bin.
      api: 'API-04', method: 'POST', path: '/v1/warehouse/movements/:commandId',
      permission: 'inventory.movement.append', idempotent: true,
      handler: async (ctx) => {
        const commandId = ctx.params['commandId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (typeof b['kind'] !== 'string' || !(KINDS as readonly string[]).includes(b['kind'])
          || !isStr(b['storeId']) || !isStr(b['productId']) || !isInt(b['quantityMinor']) || !isStr(b['uom'])
          || (b['stockState'] !== undefined && !(STATES as readonly string[]).includes(b['stockState'] as string))) {
          throw apiError(400, {
            code: 'not_readable_as_a_movement',
            whatHappened: 'A movement needs a kind, storeId, productId, whole quantityMinor and a uom (fromBinId/toBinId/batchId may be null).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the scanned movement. Nothing was recorded.',
          });
        }
        const command: MovementCommand = {
          commandId, kind: b['kind'] as MovementKind, storeId: b['storeId'] as string,
          productId: b['productId'] as string, batchId: nbin(b['batchId']), quantityMinor: b['quantityMinor'] as number,
          uom: b['uom'] as string, fromBinId: nbin(b['fromBinId']), toBinId: nbin(b['toBinId']),
          movedBy: ctx.userId, at: deps.now(),
          ...((STATES as readonly string[]).includes(b['stockState'] as string) ? { stockState: b['stockState'] as StockState } : {}),
          ...(isStr(b['reason']) ? { reason: b['reason'] as string } : {}),
        };

        const result = applyMovement({
          command,
          appliedCommandIds: await deps.appliedCommandIds(ctx.tenantId),
          bins: await deps.bins(ctx.tenantId),
          contents: await deps.contents(ctx.tenantId),
        });

        if (result.outcome === 'duplicate_ignored') {
          return { status: 200, body: { commandId, outcome: result.outcome, accepted: false, detail: result.detail } };
        }
        if (!result.accepted) {
          throw apiError(result.outcome === 'invalid_command' ? 400 : 422, {
            code: `movement_${result.outcome}`,
            whatHappened: result.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: result.resolutionRequired === true ? 'Resolve the bin, then re-scan. Nothing was moved.' : 'Nothing was moved.',
          });
        }
        await deps.recordMovement(ctx.tenantId, commandId, result.movements);
        return { status: 201, body: { commandId, outcome: result.outcome, accepted: true, detail: result.detail, movements: result.movements.length } };
      },
    },
    {
      // What a bin holds now — its contents (projected from the ledger) and how full it is.
      api: 'API-04', method: 'GET', path: '/v1/warehouse/bins/:binId',
      permission: 'inventory.availability.read',
      handler: async (ctx) => {
        const binId = ctx.params['binId'] ?? '';
        const bin = (await deps.bins(ctx.tenantId)).find((x) => x.binId === binId);
        if (bin === undefined) throw notFound(`bin ${binId}`);
        const contents = await deps.contents(ctx.tenantId);
        const held = Object.entries(contents)
          .filter(([key, qty]) => key.startsWith(`${binId}|`) && qty !== 0)
          .map(([key, qty]) => ({ key, quantityMinor: qty }));
        return {
          status: 200,
          body: { binId, storeId: bin.storeId, capacityMinor: bin.capacityMinor, pickable: bin.pickable, zone: bin.zone ?? null, occupancyMinor: binOccupancy(binId, contents), held },
        };
      },
    },
    {
      // Advisory: where should this stock go? Keeps a product together, never suggests a pickable bin for
      // stock that is not sellable. It suggests; a person (or a later movement) commits.
      api: 'API-04', method: 'POST', path: '/v1/warehouse/put-away/suggest',
      permission: 'inventory.availability.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as { productId?: unknown; batchId?: unknown; quantityMinor?: unknown; state?: unknown };
        if (!isStr(b.productId) || !isInt(b.quantityMinor) || (b.quantityMinor as number) <= 0
          || (b.state !== undefined && !(STATES as readonly string[]).includes(b.state as string))) {
          throw apiError(400, {
            code: 'not_readable_as_a_put_away',
            whatHappened: 'A put-away suggestion needs a productId and a whole positive quantityMinor (batchId and state optional).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the product and quantity. Nothing was changed.',
          });
        }
        const suggestion = suggestPutAway({
          productId: b.productId, batchId: nbin(b.batchId), quantityMinor: b.quantityMinor as number,
          ...((STATES as readonly string[]).includes(b.state as string) ? { state: b.state as StockState } : {}),
          bins: await deps.bins(ctx.tenantId), contents: await deps.contents(ctx.tenantId),
        });
        return { status: 200, body: suggestion };
      },
    },
  ];
}
