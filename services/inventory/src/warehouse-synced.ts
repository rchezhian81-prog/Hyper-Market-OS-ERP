// API-04 — the warehouse HANDHELD's work, relayed by the store box (M09-FR-01 · M07-FR-01 · §28 · §31 — SP-3a, audit
// finding F11's handheld half; ADR-0019).
//
// A worker in the racking puts away, picks and receives with no signal. Every accepted scan is decided locally by the
// tested engines and queued on the DEVICE; the device hands it to the box over the authenticated device socket; the
// box relays it HERE under the store's sync credential. These two routes make the handheld's facts head office's
// facts the same way the manager's decisions, receipts and counts became so in SP-2:
//
//   • they trust the FACT (who moved or received what, where, when — the command id is the handheld's own, so a
//     re-sent scan is one movement, §31.1) and re-run the JUDGEMENT here: a put-away or a pick goes through the same
//     `applyMovement` the direct route runs, against head office's bins and contents (an unknown bin, a full bin, a
//     draw the bin cannot cover, bad stock into a pickable bin are ITS refusals — 422, which the box dead-letters
//     visibly for a person, hard rule #6); a receiving scan becomes a `received` movement on the M08 ledger at the
//     store's location, so stock RISES at head office when goods come in the back door (M08-FR-01);
//   • they re-verify the WORKER named by the device from their grants and FLAG a breach on the record — never a silent
//     apply, never a silent drop (hard rules #4/#10); the relay (the box) is recorded beside them, never as the actor;
//   • stock that arrived damaged, expired or quarantined is recorded as a scan but appended to no sellable position —
//     said as a flag (`held_out_of_stock`) rather than counted as on-hand;
//   • every scan is also kept on its own GRN-scans register, so the delivery can be assembled into its goods receipt
//     and folded into the purchase order later (SP-6) without re-asking the handheld.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { applyMovement, type MovementCommand, type MovementKind } from '../../../packages/warehouse/src/movements';
import type { StockState } from '../../../packages/stock/src/position';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { MOVEMENT_KINDS, STOCK_STATES, type WarehouseDeps } from './warehouse';
import type { Movement } from './index';
import { coldChainVerdict, type ColdChainVerdict, type ProductReceiptRules, type ReceiptPolicy } from '../../../packages/receiving/src/index';

export const WAREHOUSE_SYNC_FLAGS = Object.freeze([
  'mover_unknown', 'mover_lacks_authority', 'receiver_unknown', 'receiver_lacks_authority', 'held_out_of_stock',
  // SP-6b: a scan that reached head office AFTER the delivery was assembled into its GRN — recorded and posted (the goods
  // are in the building), said so the review screen shows a receipt that no longer matches its scans.
  'after_assembly',
  // Wave 3 · SF-07 part 3: a cold-chain scan with no reading, or one out of the product's limits — recorded, NOT put on-hand.
  'cold_chain_held',
] as const);
export type WarehouseSyncFlag = (typeof WAREHOUSE_SYNC_FLAGS)[number];

/** The permission a worker must hold to have moved or received stock in their own name. */
const MOVE_PERMISSION = 'inventory.movement.append';

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPosInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
const isIso = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(v));
const optStr = (v: unknown): string | null => (isStr(v) ? v : null);

type Permissions = (tenantId: string, userId: string) => Promise<readonly string[] | undefined> | readonly string[] | undefined;

/** Re-verify the named worker from THEIR grants (§28): flags, never a silent trust of the relay's word. */
async function verifyWorker(
  permissionsOfUser: Permissions, tenantId: string, userId: string, unknownFlag: WarehouseSyncFlag, lacksFlag: WarehouseSyncFlag,
): Promise<WarehouseSyncFlag[]> {
  const permissions = await permissionsOfUser(tenantId, userId);
  if (permissions === undefined) return [unknownFlag];
  return permissions.includes(MOVE_PERMISSION) ? [] : [lacksFlag];
}

// ── Put-away / pick ─────────────────────────────────────────────────────────

export interface SyncedWarehouseDeps extends WarehouseDeps {
  readonly permissionsOfUser: Permissions;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}

/** The movement as the handheld queued it (`WarehouseMovementApplied`: the command it applied, who applied it). */
interface RelayedMovement {
  readonly command: MovementCommand;
  readonly movedBy: string;
  readonly orderRef: string | null;
  readonly lineId: string | null;
}

function readRelayedMovement(body: unknown, commandId: string, now: string): RelayedMovement | undefined {
  if (!isObj(body) || !isObj(body['command'])) return undefined;
  const c = body['command'];
  const kind = c['kind'];
  if (!isStr(kind) || !(MOVEMENT_KINDS as readonly string[]).includes(kind)) return undefined;
  if (!isStr(c['storeId']) || !isStr(c['productId']) || !isPosInt(c['quantityMinor']) || !isStr(c['uom'])) return undefined;
  if (isStr(c['commandId']) && c['commandId'] !== commandId) return undefined;
  const movedBy = isStr(body['movedBy']) ? body['movedBy'] : isStr(c['movedBy']) ? c['movedBy'] : undefined;
  if (movedBy === undefined) return undefined;
  const stockState = c['stockState'];
  if (stockState !== undefined && !(STOCK_STATES as readonly string[]).includes(stockState as string)) return undefined;
  return {
    command: {
      commandId, kind: kind as MovementKind, storeId: c['storeId'], productId: c['productId'],
      batchId: optStr(c['batchId']), quantityMinor: c['quantityMinor'], uom: c['uom'],
      fromBinId: optStr(c['fromBinId']), toBinId: optStr(c['toBinId']),
      movedBy, at: isIso(c['at']) ? c['at'] : now,
      ...(isStr(stockState) ? { stockState: stockState as StockState } : {}),
      ...(isStr(c['reason']) ? { reason: c['reason'] } : {}),
    },
    movedBy,
    orderRef: optStr(body['orderRef']),
    lineId: optStr(body['lineId']),
  };
}

export function syncedWarehouseRoutes(deps: SyncedWarehouseDeps): readonly Route[] {
  return [
    {
      api: 'API-04', method: 'POST', path: '/v1/warehouse/movements/:commandId/synced',
      permission: 'inventory.movement.sync', idempotent: true,
      handler: async (ctx) => {
        const commandId = (ctx.params['commandId'] ?? '').trim();
        const now = deps.now();
        const r = commandId === '' ? undefined : readRelayedMovement(ctx.body, commandId, now);
        if (r === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_a_relayed_movement',
            whatHappened: 'This payload could not be read as a movement applied on a handheld — it needs { command: { kind, storeId, productId, quantityMinor, uom, fromBinId|null, toBinId|null, batchId|null }, movedBy } with the command id matching the path.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Do not discard it at the store. Keep it in the queue and raise it — a movement that cannot be read still happened in the racking.',
          });
        }
        // The handheld's own command id keys the ledger: a re-sent scan is ONE movement (§31.1).
        const applied = await deps.appliedCommandIds(ctx.tenantId);
        if (applied.includes(commandId)) {
          return { status: 200, body: { commandId, outcome: 'duplicate_ignored', accepted: false, alreadyApplied: true } };
        }
        const flags = await verifyWorker(deps.permissionsOfUser, ctx.tenantId, r.movedBy, 'mover_unknown', 'mover_lacks_authority');

        // The SAME tested engine as the direct route, over head office's bins and contents. Its refusal is the fact.
        const result = applyMovement({
          command: r.command, appliedCommandIds: applied,
          bins: await deps.bins(ctx.tenantId), contents: await deps.contents(ctx.tenantId),
        });
        if (result.outcome === 'duplicate_ignored') {
          return { status: 200, body: { commandId, outcome: result.outcome, accepted: false, alreadyApplied: true } };
        }
        if (!result.accepted) {
          throw apiError(result.outcome === 'invalid_command' ? 400 : 422, {
            code: `movement_${result.outcome}`,
            whatHappened: `${result.detail} (applied on the handheld by ${r.movedBy}; head office's bins disagree).`,
            wasItSaved: 'not_saved',
            nextSafeAction: result.resolutionRequired === true
              ? 'A person must resolve the bin at head office; the scan stays on the store computer for them to see.'
              : 'Nothing was moved at head office. The scan stays on the store computer for a person to look at.',
          });
        }
        await deps.recordMovement(ctx.tenantId, commandId, result.movements);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: r.movedBy, action: 'warehouse.movement.record', objectType: 'warehouse_movement', objectId: commandId,
          at: now, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: null,
          after: {
            kind: r.command.kind, storeId: r.command.storeId, productId: r.command.productId, quantityMinor: String(r.command.quantityMinor),
            fromBinId: r.command.fromBinId ?? '', toBinId: r.command.toBinId ?? '', orderRef: r.orderRef ?? '', lineId: r.lineId ?? '',
            relayedBy: ctx.userId, flags: flags.join(','),
          },
          reason: r.command.reason ?? '',
          correlationId: commandId,
        });
        // 202: it happened in the racking; this records that head office's bins now agree.
        return { status: 202, body: { commandId, outcome: result.outcome, accepted: true, detail: result.detail, movements: result.movements.length, flags } };
      },
    },
  ];
}

// ── Receiving scans ─────────────────────────────────────────────────────────

/** One scan at the back door as head office keeps it (SP-3a; SP-6 folds these into the GRN and the purchase order). */
export interface ReceivingScanRecord {
  readonly commandId: string;
  readonly grnId: string;
  readonly productId: string;
  readonly batchId: string | null;
  readonly quantityMinor: number;
  readonly uom: string;
  readonly source: string;
  readonly poId: string | null;
  readonly state: string;
  readonly expiry: string | null;
  readonly receivedBy: string;
  readonly relayedBy: string;
  readonly storeId: string;
  readonly at: string;
  /** The `received` movement this scan appended, or null when the stock was held out of the sellable position. */
  readonly onHandMovementId: string | null;
  readonly governanceFlags: readonly string[];
  /** Wave 3 · SF-07 part 3 — the arrival temperature the worker probed, °C; absent when none was taken. */
  readonly temperatureC?: number;
  /**
   * Wave 3 · SF-07 part 3 — set when the product master names a cold-chain item and the reading was missing or out of range:
   * the scan was recorded but NOT put on-hand, and the assembled receipt holds that line for a second person. Absent otherwise.
   */
  readonly coldChainHeld?: Exclude<ColdChainVerdict, 'ok' | 'not_cold_chain'>;
}

export interface ReceivingScanDeps {
  readonly permissionsOfUser: Permissions;
  /** Append one `received` movement to the M08 ledger (the inventory adapter's own). */
  readonly appendMovement: (tenantId: string, m: Movement) => Promise<void> | void;
  readonly isKnown: (tenantId: string, movementId: string) => Promise<boolean> | boolean;
  readonly scanExists: (tenantId: string, commandId: string) => Promise<boolean> | boolean;
  readonly recordScan: (tenantId: string, scan: ReceivingScanRecord) => Promise<void> | void;
  readonly scansOf: (tenantId: string, grnId: string) => Promise<readonly ReceivingScanRecord[]> | readonly ReceivingScanRecord[];
  /** SP-6b: whether the delivery has already been assembled into its GRN — a later scan is flagged `after_assembly`. */
  readonly receiptExists?: (tenantId: string, grnId: string) => Promise<boolean> | boolean;
  /** Wave 3 · SF-07 part 3 — the product's receiving rule from the product master (the goods receipt's own), for the cold-chain check. */
  readonly productRule?: (tenantId: string, productId: string) => Promise<ProductReceiptRules | undefined> | ProductReceiptRules | undefined;
  /** Wave 3 · SF-07 part 3 — the tenant's receipt policy (its cold-chain maximum stands behind a product's own). */
  readonly receiptPolicy?: (tenantId: string) => Promise<Pick<ReceiptPolicy, 'coldChainMaxC'> | undefined> | Pick<ReceiptPolicy, 'coldChainMaxC'> | undefined;
  readonly now: () => string;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}

/** States that put the goods on the SELLABLE position. Anything else is kept out of stock and said so. */
const ON_HAND_STATES: ReadonlySet<string> = new Set(['on_hand', 'good']);

interface RelayedScan {
  readonly grnId: string; readonly productId: string; readonly batchId: string | null; readonly quantityMinor: number;
  readonly uom: string; readonly source: string; readonly poId: string | null; readonly state: string; readonly expiry: string | null;
  readonly receivedBy: string; readonly storeId: string; readonly at: string;
  readonly temperatureC?: number;
}

function readRelayedScan(body: unknown, commandId: string, now: string): RelayedScan | undefined {
  if (!isObj(body)) return undefined;
  if (isStr(body['commandId']) && body['commandId'] !== commandId) return undefined;
  if (!isStr(body['grnId']) || !isStr(body['productId']) || !isPosInt(body['quantityMinor']) || !isStr(body['receivedBy']) || !isStr(body['storeId'])) return undefined;
  // Wave 3 · SF-07 part 3: the probed arrival temperature, °C — a number or absent, never anything else.
  const temperatureC = body['temperatureC'];
  if (!(temperatureC === undefined || temperatureC === null || (typeof temperatureC === 'number' && Number.isFinite(temperatureC)))) return undefined;
  return {
    ...(typeof temperatureC === 'number' ? { temperatureC } : {}),
    grnId: body['grnId'], productId: body['productId'], batchId: optStr(body['batchId']), quantityMinor: body['quantityMinor'],
    uom: isStr(body['uom']) ? body['uom'] : 'EA', source: isStr(body['source']) ? body['source'] : 'unknown',
    poId: optStr(body['poId']), state: isStr(body['state']) ? body['state'] : 'on_hand', expiry: isIso(body['expiry']) ? body['expiry'] : null,
    receivedBy: body['receivedBy'], storeId: body['storeId'], at: isIso(body['at']) ? body['at'] : now,
  };
}

export function receivingScanRoutes(deps: ReceivingScanDeps): readonly Route[] {
  return [
    {
      api: 'API-04', method: 'POST', path: '/v1/inventory/receiving-scans/:commandId/synced',
      permission: 'inventory.receipt.sync', idempotent: true,
      handler: async (ctx) => {
        const commandId = (ctx.params['commandId'] ?? '').trim();
        const now = deps.now();
        const s = commandId === '' ? undefined : readRelayedScan(ctx.body, commandId, now);
        if (s === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_a_receiving_scan',
            whatHappened: 'This payload could not be read as a receiving scan from a handheld — it needs the commandId matching the path, grnId, productId, a whole quantityMinor, receivedBy and storeId.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Do not discard it at the store. Keep it in the queue and raise it — goods that were scanned in are in the building.',
          });
        }
        if (await deps.scanExists(ctx.tenantId, commandId)) {
          const prior = (await deps.scansOf(ctx.tenantId, s.grnId)).find((r) => r.commandId === commandId);
          return { status: 200, body: { commandId, grnId: s.grnId, recorded: true, alreadyRecorded: true, onHand: prior?.onHandMovementId !== null, flags: prior?.governanceFlags ?? [] } };
        }
        const flags = await verifyWorker(deps.permissionsOfUser, ctx.tenantId, s.receivedBy, 'receiver_unknown', 'receiver_lacks_authority');
        // SP-6b: the delivery was already assembled into its GRN — this scan is still the truth about goods in the building,
        // so it is recorded and posted exactly as before, and SAID, so the receipt is reviewed against its late scans.
        if (deps.receiptExists !== undefined && (await deps.receiptExists(ctx.tenantId, s.grnId))) flags.push('after_assembly');

        // Wave 3 · SF-07 part 3: a cold-chain item (the product master's word) with no reading, or one out of its limits, is
        // recorded but NOT put on-hand — the same limits the receipt is judged by; its assembled line is held for a second person.
        let coldChainHeld: ReceivingScanRecord['coldChainHeld'];
        if (ON_HAND_STATES.has(s.state) && deps.productRule !== undefined) {
          const rule = await deps.productRule(ctx.tenantId, s.productId);
          const policy = deps.receiptPolicy === undefined ? undefined : await deps.receiptPolicy(ctx.tenantId);
          const verdict = coldChainVerdict(rule, { ...(policy?.coldChainMaxC === undefined ? {} : { coldChainMaxC: policy.coldChainMaxC }) }, s.temperatureC);
          if (verdict !== 'ok' && verdict !== 'not_cold_chain') { coldChainHeld = verdict; flags.push('cold_chain_held'); }
        }

        // Good stock rises the store's on-hand position at once (M08-FR-01); anything else is recorded and HELD.
        let onHandMovementId: string | null = null;
        if (ON_HAND_STATES.has(s.state) && coldChainHeld === undefined) {
          onHandMovementId = `recv:${s.grnId}:${commandId}`;
          if (!(await deps.isKnown(ctx.tenantId, onHandMovementId))) {
            await deps.appendMovement(ctx.tenantId, {
              movementId: onHandMovementId, productId: s.productId, locationId: s.storeId, kind: 'received',
              quantityMinor: s.quantityMinor, uom: s.uom, occurredAt: s.at, enteredBy: s.receivedBy,
              reason: `receiving scan ${commandId} for ${s.grnId}`,
              ...(s.batchId !== null ? { batchId: s.batchId } : {}),
              ...(s.expiry !== null ? { expiry: s.expiry } : {}),
            });
          }
        } else if (coldChainHeld === undefined) {
          flags.push('held_out_of_stock');
        }

        const record: ReceivingScanRecord = {
          commandId, grnId: s.grnId, productId: s.productId, batchId: s.batchId, quantityMinor: s.quantityMinor, uom: s.uom,
          source: s.source, poId: s.poId, state: s.state, expiry: s.expiry, receivedBy: s.receivedBy, relayedBy: ctx.userId,
          storeId: s.storeId, at: s.at, onHandMovementId, governanceFlags: flags,
          ...(s.temperatureC === undefined ? {} : { temperatureC: s.temperatureC }),
          ...(coldChainHeld === undefined ? {} : { coldChainHeld }),
        };
        await deps.recordScan(ctx.tenantId, record);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: s.receivedBy, action: 'receipt.scan', objectType: 'goods_receipt', objectId: s.grnId,
          at: now, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: null,
          after: {
            commandId, productId: s.productId, quantityMinor: String(s.quantityMinor), uom: s.uom, state: s.state, poId: s.poId ?? '',
            storeId: s.storeId, onHandMovementId: onHandMovementId ?? '', relayedBy: ctx.userId, flags: flags.join(','),
          },
          correlationId: s.grnId,
        });
        return { status: 202, body: { commandId, grnId: s.grnId, recorded: true, onHand: onHandMovementId !== null, flags } };
      },
    },
    {
      // What has been scanned in against a delivery so far — for the review screens and for SP-6 to assemble the GRN.
      api: 'API-04', method: 'GET', path: '/v1/inventory/receiving-scans',
      permission: 'inventory.availability.read',
      handler: async (ctx) => {
        const grnId = ctx.query['grnId'];
        if (!isStr(grnId)) {
          throw apiError(400, { code: 'not_readable_as_a_scan_query', whatHappened: 'Reading receiving scans needs a grnId.', wasItSaved: 'not_saved', nextSafeAction: 'Send ?grnId=…. Nothing was changed.' });
        }
        const scans = await deps.scansOf(ctx.tenantId, grnId);
        return {
          status: 200,
          body: { grnId, scans, count: scans.length, receivedMinor: scans.reduce((n, r) => n + (r.onHandMovementId === null ? 0 : r.quantityMinor), 0), asAt: deps.now() },
        };
      },
    },
  ];
}
