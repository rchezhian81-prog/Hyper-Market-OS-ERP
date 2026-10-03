// API-08 — the PICKER handheld's work, relayed by the store box (M19-FR-01 · M19-FR-02 · D09 · §28 · §31 — SP-3c-i, audit
// finding F11's picker half; ADR-0019).
//
// A picker walks the shop with a wave on a cheap handheld and no signal. Every line's outcome — picked, short, swapped
// with the customer's agreement, rejected on quality — is decided locally by the tested `PickSession`, queued on the DEVICE,
// handed to the box over the authenticated device socket, and relayed HERE under the store's sync credential. So is the
// wave's pack, with its cold-chain and tamper evidence. Until this file existed the picker's queue reached nobody (F11).
//
// These routes make the handheld's facts head office's facts the way the warehouse handheld's became so in SP-3a:
//
//   • they trust the FACT (which line went which way, how many, at what final price — the key is the handheld's own, so a
//     re-sent outcome is ONE record, §31.1) and keep an append-only WAVE REGISTER: a line that was picked and then rejected
//     on quality is two things that happened, and both are kept;
//   • they re-verify the PICKER / PACKER named by the device from THEIR grants and FLAG a breach on the record — never a
//     silent apply, never a silent drop (hard rules #4/#10); the relay (the box) is recorded beside them, never as the actor;
//   • the PACK is checked against the line outcomes already on this register — the crate's line count and value are
//     derived here from what head office holds, and a handheld pack that disagrees is recorded WITH the disagreement said
//     (`lines_disagree`), because a manifest nobody compared is a list of what the shop hoped to send;
//   • nothing here moves stock: an online order's stock was reserved when the order was placed (M18), and the back store's
//     bin moves ride the warehouse handheld's own route. A pick outcome is a fulfilment fact.
//
// Recording gated `fulfilment.pick.sync` (the box's hop); the read `fulfilment.pack.read`. Append-only.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { packOrder, type HandlingClass, type PackLine, type PackResult } from '../../../packages/fulfilment/src/index';
import { packDigest } from './packing';

/** The outcomes a line can be relayed in. `pending` is not an outcome — a line nobody has resolved sends nothing. */
export const PICK_LINE_OUTCOMES = Object.freeze(['picked', 'short', 'substituted', 'quality_failed'] as const);
export type PickLineOutcomeState = (typeof PICK_LINE_OUTCOMES)[number];

export const WAVE_SYNC_FLAGS = Object.freeze([
  'picker_unnamed', 'picker_unknown', 'picker_lacks_authority',
  'packer_unknown', 'packer_lacks_authority',
  // The handheld's pack names a line count or a value that head office's own line register does not support.
  'lines_disagree',
  // A crate sealed with no temperature or no tamper seal recorded — said, so the review screen can ask why.
  'no_cold_chain_temperature', 'no_tamper_seal',
  // M19-FR-02 fold — the wave becomes one pack per ORDER:
  // a line's product has no handling class on the product master: refused on the order's pack and said here; never guessed.
  'handling_unknown',
  // a line arrived without the quantity the order asked for (a handheld before 3 Oct 2026): the pack cannot say how short.
  'required_qty_unknown',
  // an order on the wave already had a pack head office keeps (the desk packed it, or another wave did): left as it was, said.
  'order_already_packed',
  // the crate the handheld sealed is not what the orders' packs add up to — value in the crate no order pack carries (a refusal), or the reverse.
  'orders_disagree',
] as const);
export type WaveSyncFlag = (typeof WAVE_SYNC_FLAGS)[number];

/** The permission a person must hold to have picked or packed in their own name (the crate's recorder). */
const PICK_PERMISSION = 'fulfilment.pack.record';

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonNegInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isIso = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(v));
const optStr = (v: unknown): string | null => (isStr(v) ? v : null);

type Permissions = (tenantId: string, userId: string) => Promise<readonly string[] | undefined> | readonly string[] | undefined;

/** One line outcome as head office keeps it — the handheld's fact, the relay beside it, the flags on it. */
export interface WaveLineOutcome {
  readonly waveId: string;
  readonly lineId: string;
  readonly orderRef: string;
  readonly productId: string;
  readonly state: PickLineOutcomeState;
  readonly pickedQty: number;
  readonly uom: string;
  readonly finalPriceMinor: number;
  readonly currency: string;
  readonly substituted: boolean;
  readonly note: string | null;
  readonly pickedBy: string | null;
  readonly relayedBy: string;
  readonly at: string;
  readonly governanceFlags: readonly WaveSyncFlag[];
  /** M19-FR-02 fold — the name as the shop wrote it and the quantity the order asked for. Absent on records before 3 Oct 2026. */
  readonly description?: string | null;
  readonly requiredQty?: number | null;
}

/** What the product master says about packing a product: how it travels, and its own cold-chain limits when set (HA-3). */
export interface ProductPacking {
  readonly handling?: HandlingClass;
  readonly coldChain?: { readonly minTenthsC?: number; readonly maxTenthsC?: number };
}

/** How one ORDER on the wave reached the per-order pack register (M19-FR-02 fold). */
export interface OrderFold {
  readonly orderId: string;
  /** The pack engine's outcome for the pack head office recorded — or `already_packed`: the order already had a pack head office keeps, left as it was and said. */
  readonly outcome: PackResult['outcome'] | 'already_packed';
  readonly lineCount: number;
  readonly totalMinor: number;
  readonly refused: readonly { readonly lineId: string; readonly reason: string }[];
}

/** The wave's pack as head office keeps it: the handheld's figures beside the figures ITS register supports. */
export interface WavePackRecord {
  readonly waveId: string;
  readonly packedBy: string;
  readonly relayedBy: string;
  readonly lineCount: number;
  readonly totalValueMinor: number;
  readonly currency: string;
  readonly temperatureC: number | null;
  readonly tamperSealRef: string | null;
  readonly at: string;
  /** What the line register held when the pack arrived — the crate as head office can prove it. */
  readonly fromLines: { readonly lineCount: number; readonly totalValueMinor: number };
  readonly governanceFlags: readonly WaveSyncFlag[];
  /** M19-FR-02 fold — each order on the wave and how it reached the per-order pack register. Absent on records before 3 Oct 2026. */
  readonly orders?: readonly OrderFold[];
  readonly ordersTotalMinor?: number;
}

export interface WaveSyncDeps {
  readonly permissionsOfUser: Permissions;
  /** Every outcome recorded for a wave, oldest first (append-only history — a line may appear more than once). */
  readonly lineOutcomes: (tenantId: string, waveId: string) => Promise<readonly WaveLineOutcome[]> | readonly WaveLineOutcome[];
  readonly recordLineOutcome: (tenantId: string, outcome: WaveLineOutcome) => Promise<void> | void;
  readonly pack: (tenantId: string, waveId: string) => Promise<WavePackRecord | undefined> | WavePackRecord | undefined;
  readonly recordPack: (tenantId: string, record: WavePackRecord) => Promise<void> | void;
  /** What the product master says about packing a product (M19-FR-02 fold · HA-3): its handling class and its own cold-chain
   *  limits. Undefined when head office has no such product; a product with no handling class packs as `handling_unknown`. */
  readonly productPacking: (tenantId: string, productId: string) => Promise<ProductPacking | undefined> | ProductPacking | undefined;
  /** The per-order pack register — the SAME one `/v1/fulfilment/orders/:orderId/pack` writes and dispatch reads. */
  readonly orderPack: (tenantId: string, orderId: string) => Promise<PackResult | undefined> | PackResult | undefined;
  readonly recordOrderPack: (tenantId: string, orderId: string, result: PackResult, key: string) => Promise<void> | void;
  readonly now: () => string;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}

/** The latest outcome per line, in first-seen order — the register folded to the wave as it stands. */
export function latestOutcomes(history: readonly WaveLineOutcome[]): readonly WaveLineOutcome[] {
  const latest = new Map<string, WaveLineOutcome>();
  for (const o of history) latest.set(o.lineId, o);
  return [...latest.values()];
}

/** What is in the crate by head office's register: lines with something picked that were not rejected on quality. */
export function crateFromLines(history: readonly WaveLineOutcome[]): { readonly lineCount: number; readonly totalValueMinor: number } {
  const inCrate = latestOutcomes(history).filter((o) => o.pickedQty > 0 && o.state !== 'quality_failed');
  return { lineCount: inCrate.length, totalValueMinor: inCrate.reduce((n, o) => n + o.finalPriceMinor, 0) };
}

/** Tenths of a degree from the handheld's °C reading; undefined when none was taken. */
const tenths = (c: number | null): number | undefined => (c === null ? undefined : Math.round(c * 10));

/**
 * The wave folded into ONE pack per ORDER (M19-FR-02) — from the line register head office holds, through the SAME tested
 * pack engine the desk's route runs, under the approved handling rules: the picker's final price stands (D09, settled at
 * the scale), the crate's temperature stands as every line's pack reading (none taken → the engine's own cold-chain
 * refusal), a product whose master names no handling class is refused `handling_unknown` and said — never defaulted,
 * never read off its name. A quality-failed line is `nothing_picked`. Every refusal is listed on the order's pack. Pure.
 */
export function foldWaveIntoOrders(input: {
  readonly history: readonly WaveLineOutcome[];
  readonly temperatureC: number | null;
  readonly packingOf: (productId: string) => ProductPacking | undefined;
  readonly at: string;
}): { readonly orders: readonly { readonly orderId: string; readonly result: PackResult }[]; readonly flags: readonly WaveSyncFlag[] } {
  const flags = new Set<WaveSyncFlag>();
  const byOrder = new Map<string, WaveLineOutcome[]>();
  for (const o of latestOutcomes(input.history)) byOrder.set(o.orderRef, [...(byOrder.get(o.orderRef) ?? []), o]);
  const reading = tenths(input.temperatureC);
  const orders: { orderId: string; result: PackResult }[] = [];
  for (const [orderId, outcomes] of byOrder) {
    const lines: PackLine[] = [];
    const unknown: { lineId: string; reason: 'handling_unknown'; detail: string }[] = [];
    for (const o of outcomes) {
      const name = o.description ?? o.productId;
      const packing = input.packingOf(o.productId);
      const handling = packing?.handling;
      if (handling === undefined) {
        flags.add('handling_unknown');
        unknown.push({ lineId: o.lineId, reason: 'handling_unknown', detail: `${name}: the product master names no handling class for ${o.productId} — it cannot be packed from the wave until a person sets one (never guessed from its name)` });
        continue;
      }
      const required = o.requiredQty ?? null;
      if (required === null) flags.add('required_qty_unknown');
      const picked = o.state === 'quality_failed' ? 0 : o.pickedQty;
      lines.push({
        lineId: o.lineId, orderId, productId: o.productId, name, handling,
        orderedMinor: required ?? picked, pickedMinor: picked, uom: o.uom,
        unitPriceMinor: 0, finalPriceMinor: o.finalPriceMinor,
        ...(reading === undefined ? {} : { packTenthsC: reading }),
        // HA-3: the product's own limits when the master set them; else the engine's approved class default — the line says which.
        ...(packing?.coldChain === undefined ? {} : { coldChain: packing.coldChain }),
      });
    }
    const engine: PackResult = lines.length === 0
      ? { orderId, packed: false, outcome: 'handling_unknown', lines: [], refused: [], totalMinor: 0, detail: '' }
      : packOrder({ orderId, lines, crateAssignment: {}, at: input.at });
    const refused = [...engine.refused, ...unknown];
    orders.push({
      orderId,
      result: {
        ...engine,
        refused,
        outcome: engine.refused.length === 0 && unknown.length > 0 ? 'handling_unknown' : engine.outcome,
        detail: unknown.length === 0
          ? engine.detail
          : `${engine.lines.length} line(s) packed, ${engine.totalMinor}; ${refused.length} refused and listed rather than quietly left out (${unknown.length} with no handling class on the product master)`,
      },
    });
  }
  return { orders, flags: [...flags] };
}

/** Re-verify the named person from THEIR grants (§28): flags, never a silent trust of the relay's word. */
async function verifyPerson(
  permissionsOfUser: Permissions, tenantId: string, userId: string, unknownFlag: WaveSyncFlag, lacksFlag: WaveSyncFlag,
): Promise<WaveSyncFlag[]> {
  const permissions = await permissionsOfUser(tenantId, userId);
  if (permissions === undefined) return [unknownFlag];
  return permissions.includes(PICK_PERMISSION) ? [] : [lacksFlag];
}

interface RelayedOutcome {
  readonly orderRef: string; readonly productId: string; readonly state: PickLineOutcomeState; readonly pickedQty: number;
  readonly uom: string; readonly finalPriceMinor: number; readonly currency: string; readonly substituted: boolean;
  readonly note: string | null; readonly pickedBy: string | null; readonly at: string;
  readonly description: string | null; readonly requiredQty: number | null;
}

/** The outcome as the handheld queued it (`PickLineResolved`), read strictly; undefined when it cannot be read. */
function readRelayedOutcome(body: unknown, waveId: string, lineId: string, now: string): RelayedOutcome | undefined {
  if (!isObj(body)) return undefined;
  if (isStr(body['waveId']) && body['waveId'] !== waveId) return undefined;
  if (isStr(body['lineId']) && body['lineId'] !== lineId) return undefined;
  const state = body['state'];
  if (!isStr(state) || !(PICK_LINE_OUTCOMES as readonly string[]).includes(state)) return undefined;
  if (!isStr(body['orderRef']) || !isStr(body['productId']) || !isNonNegInt(body['pickedQty']) || !isNonNegInt(body['finalPriceMinor'])) return undefined;
  if (body['substituted'] !== undefined && typeof body['substituted'] !== 'boolean') return undefined;
  return {
    orderRef: body['orderRef'], productId: body['productId'], state: state as PickLineOutcomeState, pickedQty: body['pickedQty'],
    uom: isStr(body['uom']) ? body['uom'] : 'ea', finalPriceMinor: body['finalPriceMinor'],
    currency: isStr(body['currency']) ? body['currency'] : 'INR',
    substituted: typeof body['substituted'] === 'boolean' ? body['substituted'] : state === 'substituted',
    note: optStr(body['note']), pickedBy: optStr(body['pickedBy']), at: isIso(body['occurredAt']) ? body['occurredAt'] : isIso(body['at']) ? body['at'] : now,
    description: optStr(body['description']), requiredQty: isNonNegInt(body['requiredQty']) ? body['requiredQty'] : null,
  };
}

interface RelayedPack {
  readonly packedBy: string; readonly lineCount: number; readonly totalValueMinor: number; readonly currency: string;
  readonly temperatureC: number | null; readonly tamperSealRef: string | null; readonly at: string;
}

/** The pack as the handheld queued it (`WavePacked`), read strictly; a pack that names no packer cannot be read. */
function readRelayedPack(body: unknown, waveId: string, now: string): RelayedPack | undefined {
  if (!isObj(body)) return undefined;
  if (isStr(body['waveId']) && body['waveId'] !== waveId) return undefined;
  if (!isStr(body['packedBy']) || !isNonNegInt(body['lineCount']) || !isNonNegInt(body['totalValueMinor'])) return undefined;
  const t = body['temperatureC'];
  if (t !== undefined && t !== null && (typeof t !== 'number' || !Number.isFinite(t))) return undefined;
  return {
    packedBy: body['packedBy'], lineCount: body['lineCount'], totalValueMinor: body['totalValueMinor'],
    currency: isStr(body['currency']) ? body['currency'] : 'INR',
    temperatureC: typeof t === 'number' ? t : null, tamperSealRef: optStr(body['tamperSealRef']),
    at: isIso(body['at']) ? body['at'] : isIso(body['occurredAt']) ? body['occurredAt'] : now,
  };
}

/** The wave as a screen reads it: each line's latest outcome with its history depth, the pack, every flag in one list. */
export function presentWave(waveId: string, history: readonly WaveLineOutcome[], pack: WavePackRecord | undefined): Record<string, unknown> {
  const depth = new Map<string, number>();
  for (const o of history) depth.set(o.lineId, (depth.get(o.lineId) ?? 0) + 1);
  const lines = latestOutcomes(history).map((o) => ({ ...o, outcomesRecorded: depth.get(o.lineId) ?? 1 }));
  const flags = [...new Set([...history.flatMap((o) => o.governanceFlags), ...(pack?.governanceFlags ?? [])])];
  return { waveId, lines, crate: crateFromLines(history), packed: pack ?? null, flags, lineCount: lines.length };
}

export function syncedWaveRoutes(deps: WaveSyncDeps): readonly Route[] {
  return [
    {
      // A line's outcome from the picker handheld, relayed by the box. Idempotent on (wave, line, state) — the handheld's own
      // key — so a re-sent outcome is one record; a NEW outcome for the same line (picked, then rejected) is a second record.
      api: 'API-08', method: 'POST', path: '/v1/fulfilment/waves/:waveId/lines/:lineId/synced',
      permission: 'fulfilment.pick.sync', idempotent: true,
      handler: async (ctx) => {
        const waveId = (ctx.params['waveId'] ?? '').trim();
        const lineId = (ctx.params['lineId'] ?? '').trim();
        const now = deps.now();
        const r = waveId === '' || lineId === '' ? undefined : readRelayedOutcome(ctx.body, waveId, lineId, now);
        if (r === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_a_pick_outcome',
            whatHappened: 'This payload could not be read as a line outcome from a picker handheld — it needs waveId and lineId matching the path, a state of picked | short | substituted | quality_failed, orderRef, productId, a whole pickedQty and a whole finalPriceMinor.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Do not discard it at the store. Keep it in the queue and raise it — an outcome that cannot be read still happened in the aisle.',
          });
        }
        const history = await deps.lineOutcomes(ctx.tenantId, waveId);
        const prior = history.find((o) => o.lineId === lineId && o.state === r.state);
        if (prior !== undefined) {
          return { status: 200, body: { waveId, lineId, state: r.state, recorded: true, alreadyRecorded: true, flags: prior.governanceFlags } };
        }
        const flags: WaveSyncFlag[] = r.pickedBy === null
          ? ['picker_unnamed']
          : await verifyPerson(deps.permissionsOfUser, ctx.tenantId, r.pickedBy, 'picker_unknown', 'picker_lacks_authority');
        const outcome: WaveLineOutcome = {
          waveId, lineId, orderRef: r.orderRef, productId: r.productId, state: r.state, pickedQty: r.pickedQty, uom: r.uom,
          finalPriceMinor: r.finalPriceMinor, currency: r.currency, substituted: r.substituted, note: r.note,
          pickedBy: r.pickedBy, relayedBy: ctx.userId, at: r.at, governanceFlags: flags,
          description: r.description, requiredQty: r.requiredQty,
        };
        await deps.recordLineOutcome(ctx.tenantId, outcome);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: r.pickedBy ?? ctx.userId, action: 'fulfilment.pick.record', objectType: 'pick_wave', objectId: waveId,
          at: now, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: null,
          after: {
            lineId, orderRef: r.orderRef, productId: r.productId, state: r.state, pickedQty: String(r.pickedQty), uom: r.uom,
            finalPriceMinor: String(r.finalPriceMinor), substituted: String(r.substituted), note: r.note ?? '',
            relayedBy: ctx.userId, flags: flags.join(','),
          },
          correlationId: waveId,
        });
        // 202: it happened in the aisle; this records that head office now holds it.
        return { status: 202, body: { waveId, lineId, state: r.state, recorded: true, flags } };
      },
    },
    {
      // The wave's pack from the picker handheld. Idempotent on the wave (a wave packs once). The crate's count and value
      // are DERIVED here from the line register and compared with what the handheld says; a disagreement is said on the record.
      api: 'API-08', method: 'POST', path: '/v1/fulfilment/waves/:waveId/packed/synced',
      permission: 'fulfilment.pick.sync', idempotent: true,
      handler: async (ctx) => {
        const waveId = (ctx.params['waveId'] ?? '').trim();
        const now = deps.now();
        const p = waveId === '' ? undefined : readRelayedPack(ctx.body, waveId, now);
        if (p === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_a_wave_pack',
            whatHappened: 'This payload could not be read as a wave pack from a picker handheld — it needs waveId matching the path, packedBy, a whole lineCount and a whole totalValueMinor (temperatureC a number or null, tamperSealRef a string or null).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Do not discard it at the store. Keep it in the queue and raise it — a crate that cannot be read was still sealed.',
          });
        }
        const existing = await deps.pack(ctx.tenantId, waveId);
        if (existing !== undefined) {
          return { status: 200, body: { waveId, recorded: true, alreadyRecorded: true, flags: existing.governanceFlags, fromLines: existing.fromLines, orders: existing.orders ?? [], ordersTotalMinor: existing.ordersTotalMinor ?? null } };
        }
        const flags = await verifyPerson(deps.permissionsOfUser, ctx.tenantId, p.packedBy, 'packer_unknown', 'packer_lacks_authority');
        const history = await deps.lineOutcomes(ctx.tenantId, waveId);
        const fromLines = crateFromLines(history);
        if (fromLines.lineCount !== p.lineCount || fromLines.totalValueMinor !== p.totalValueMinor) flags.push('lines_disagree');
        if (p.temperatureC === null) flags.push('no_cold_chain_temperature');
        if (p.tamperSealRef === null) flags.push('no_tamper_seal');

        // M19-FR-02: the wave becomes ONE pack per ORDER on the register the desk's pack route writes and dispatch reads.
        // The handling class comes from the product master — read once per product, never guessed; the fold is pure.
        const packingById = new Map<string, ProductPacking | undefined>();
        for (const id of new Set(latestOutcomes(history).map((o) => o.productId))) packingById.set(id, await deps.productPacking(ctx.tenantId, id));
        const fold = foldWaveIntoOrders({ history, temperatureC: p.temperatureC, packingOf: (id) => packingById.get(id), at: p.at });
        for (const f of fold.flags) flags.push(f);
        const orders: OrderFold[] = [];
        for (const { orderId, result } of fold.orders) {
          const existing = await deps.orderPack(ctx.tenantId, orderId);
          if (existing !== undefined && packDigest(existing) !== packDigest(result)) {
            // The order already has a pack head office keeps (the desk packed it, or another wave did): left as it is, SAID.
            flags.push('order_already_packed');
            orders.push({ orderId, outcome: 'already_packed', lineCount: existing.lines.length, totalMinor: existing.totalMinor, refused: existing.refused.map((x) => ({ lineId: x.lineId, reason: x.reason })) });
            continue;
          }
          // The same pack already there (a fold that was cut off before this record was written, now retried) writes nothing.
          if (existing === undefined) await deps.recordOrderPack(ctx.tenantId, orderId, result, `wave:${waveId}:${packDigest(result)}`);
          orders.push({ orderId, outcome: result.outcome, lineCount: result.lines.length, totalMinor: result.totalMinor, refused: result.refused.map((x) => ({ lineId: x.lineId, reason: x.reason })) });
        }
        const ordersTotalMinor = orders.reduce((n, o) => n + o.totalMinor, 0);
        // The crate the handheld sealed against the orders head office could pack from it: a difference is value in the crate
        // no order pack carries (a refusal listed on that order), or the reverse — said, so the dispatcher looks before the van leaves.
        if (ordersTotalMinor !== p.totalValueMinor) flags.push('orders_disagree');

        const record: WavePackRecord = {
          waveId, packedBy: p.packedBy, relayedBy: ctx.userId, lineCount: p.lineCount, totalValueMinor: p.totalValueMinor,
          currency: p.currency, temperatureC: p.temperatureC, tamperSealRef: p.tamperSealRef, at: p.at, fromLines, governanceFlags: flags,
          orders, ordersTotalMinor,
        };
        await deps.recordPack(ctx.tenantId, record);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: p.packedBy, action: 'fulfilment.pack.record', objectType: 'pick_wave', objectId: waveId,
          at: now, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: null,
          after: {
            lineCount: String(p.lineCount), totalValueMinor: String(p.totalValueMinor), currency: p.currency,
            temperatureC: p.temperatureC === null ? '' : String(p.temperatureC), tamperSealRef: p.tamperSealRef ?? '',
            fromLinesCount: String(fromLines.lineCount), fromLinesValueMinor: String(fromLines.totalValueMinor),
            orders: orders.map((o) => `${o.orderId}:${o.outcome}:${o.lineCount}:${o.totalMinor}`).join(','), ordersTotalMinor: String(ordersTotalMinor),
            relayedBy: ctx.userId, flags: flags.join(','),
          },
          correlationId: waveId,
        });
        return { status: 202, body: { waveId, recorded: true, flags, fromLines, orders, ordersTotalMinor } };
      },
    },
    {
      // The wave as head office holds it — for the dispatcher's and the review screens, and for the proofs.
      api: 'API-08', method: 'GET', path: '/v1/fulfilment/waves/:waveId',
      permission: 'fulfilment.pack.read',
      handler: async (ctx) => {
        const waveId = (ctx.params['waveId'] ?? '').trim();
        if (waveId === '') {
          throw apiError(400, { code: 'not_readable_as_a_wave_query', whatHappened: 'Reading a wave needs its id in the path.', wasItSaved: 'not_saved', nextSafeAction: 'Send /v1/fulfilment/waves/:waveId. Nothing was changed.' });
        }
        const history = await deps.lineOutcomes(ctx.tenantId, waveId);
        const pack = await deps.pack(ctx.tenantId, waveId);
        return { status: 200, body: { ...presentWave(waveId, history, pack), asAt: deps.now() } };
      },
    },
  ];
}
