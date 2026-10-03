import { describe, it, expect } from 'vitest';
import {
  syncedWaveRoutes, crateFromLines, latestOutcomes, presentWave, foldWaveIntoOrders, WAVE_SYNC_FLAGS, PICK_LINE_OUTCOMES,
  type WaveSyncDeps, type WaveLineOutcome, type WavePackRecord,
} from '../../services/fulfilment/src/waves';
import type { HandlingClass, PackResult } from '../../packages/fulfilment/src/index';
import type { RequestContext, Route } from '../../services/kernel/src/index';
import type { AuditEntry } from '../../packages/audit/src/index';

/**
 * **The picker handheld's outcomes and pack become head office's facts — re-verified, once, and flagged, never silently
 * applied or dropped (SP-3c-i · F11's picker half · M19-FR-01/02 · D09 · §28 · hard rules #4/#6/#10).**
 *
 * The routes over in-memory ports: the line register is append-only history, a re-sent outcome is one record, a new outcome
 * for the same line is a second, the picker and the packer are re-verified from THEIR grants with the relay recorded beside
 * them, the pack is compared with the register and a disagreement is said, and a payload that cannot be read is a 400 the
 * box dead-letters by name. Nothing here moves stock.
 */

const NOW = '2026-10-01T10:00:00.000Z';
const A = 'tenant-a';

interface World {
  readonly lines: WaveLineOutcome[];
  readonly packs: WavePackRecord[];
  /** The per-order pack register (M19-FR-02 fold) — latest last, one record per key like the real adapter. */
  readonly orderPacks: Map<string, PackResult[]>;
  readonly audit: AuditEntry[];
  readonly grants: Record<string, readonly string[] | undefined>;
  readonly routes: readonly Route[];
}

/** The product master's handling classes head office knows — p-ghee deliberately has none. */
const PRODUCTS: Record<string, HandlingClass | undefined> = { 'p-rice': 'ambient', 'p-milk': 'chilled', 'p-paneer': 'chilled' };

function world(
  grants: Record<string, readonly string[] | undefined> = { 'u-picker': ['fulfilment.pack.record'], 'u-floor': ['pos.sale.record'] },
  products: Record<string, HandlingClass | undefined> = PRODUCTS,
): World {
  const lines: WaveLineOutcome[] = [];
  const packs: WavePackRecord[] = [];
  const orderPacks = new Map<string, PackResult[]>();
  const orderPackKeys = new Set<string>();
  const audit: AuditEntry[] = [];
  const deps: WaveSyncDeps = {
    permissionsOfUser: (_t, userId) => grants[userId],
    lineOutcomes: (_t, waveId) => lines.filter((l) => l.waveId === waveId),
    recordLineOutcome: (_t, o) => { lines.push(o); },
    pack: (_t, waveId) => packs.find((p) => p.waveId === waveId),
    recordPack: (_t, r) => { packs.push(r); },
    productHandling: (_t, productId) => products[productId],
    orderPack: (_t, orderId) => orderPacks.get(orderId)?.at(-1),
    recordOrderPack: (_t, orderId, result, key) => {
      if (orderPackKeys.has(`${orderId}|${key}`)) return; // the adapter's idempotency key — a retry writes nothing
      orderPackKeys.add(`${orderId}|${key}`);
      orderPacks.set(orderId, [...(orderPacks.get(orderId) ?? []), result]);
    },
    recordAudit: (_t, e) => { audit.push(e); },
    now: () => NOW,
  };
  return { lines, packs, orderPacks, audit, grants, routes: syncedWaveRoutes(deps) };
}

const route = (w: World, method: string, path: string): Route => {
  const r = w.routes.find((x) => x.method === method && x.path === path);
  if (r === undefined) throw new Error(`no ${method} ${path}`);
  return r;
};
const ctx = (params: Record<string, string>, body: unknown = undefined): RequestContext => ({
  tenantId: A, userId: 'u-box', branchId: null, params, query: {}, body, traceId: 't', idempotencyKey: 'k',
});

const picked = (over: Record<string, unknown> = {}) => ({
  waveId: 'W-1', lineId: 'l1', orderRef: 'ORD-1', productId: 'p-rice', state: 'picked', pickedQty: 2, uom: 'ea',
  finalPriceMinor: 200_00, currency: 'INR', substituted: false, note: null, pickedBy: 'u-picker', description: 'Rice 5kg', requiredQty: 2, ...over,
});
const packed = (over: Record<string, unknown> = {}) => ({
  waveId: 'W-1', packedBy: 'u-picker', lineCount: 1, totalValueMinor: 200_00, currency: 'INR', temperatureC: 4, tamperSealRef: 'SEAL-1', ...over,
});

const LINE = '/v1/fulfilment/waves/:waveId/lines/:lineId/synced';
const PACK = '/v1/fulfilment/waves/:waveId/packed/synced';

describe('the routes and their gates', () => {
  it('are the box\'s hop (fulfilment.pick.sync), idempotent writes, with a read for the screens (fulfilment.pack.read)', () => {
    const w = world();
    expect(route(w, 'POST', LINE)).toMatchObject({ api: 'API-08', permission: 'fulfilment.pick.sync', idempotent: true });
    expect(route(w, 'POST', PACK)).toMatchObject({ api: 'API-08', permission: 'fulfilment.pick.sync', idempotent: true });
    expect(route(w, 'GET', '/v1/fulfilment/waves/:waveId')).toMatchObject({ permission: 'fulfilment.pack.read' });
    expect(w.routes.every((r) => r.entitlement === undefined)).toBe(true); // picking is core — click-and-collect picks too
    expect([...PICK_LINE_OUTCOMES]).toEqual(['picked', 'short', 'substituted', 'quality_failed']);
    expect(WAVE_SYNC_FLAGS).toContain('lines_disagree');
  });
});

describe('a line outcome from the handheld', () => {
  it('is recorded with the picker re-verified and the relay beside them — 202, no flags, audited in the picker\'s name', async () => {
    const w = world();
    const res = await route(w, 'POST', LINE).handler(ctx({ waveId: 'W-1', lineId: 'l1' }, picked()));
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ waveId: 'W-1', lineId: 'l1', state: 'picked', recorded: true, flags: [] });
    expect(w.lines).toHaveLength(1);
    expect(w.lines[0]).toMatchObject({ pickedBy: 'u-picker', relayedBy: 'u-box', finalPriceMinor: 200_00, governanceFlags: [], at: NOW });
    expect(w.audit[0]).toMatchObject({ actorId: 'u-picker', action: 'fulfilment.pick.record', objectType: 'pick_wave', objectId: 'W-1', after: { relayedBy: 'u-box', state: 'picked' } });
  });

  it('is ONE record however often it is re-sent (the handheld\'s own key: wave + line + state) — and a NEW outcome for the same line is a second record', async () => {
    const w = world();
    await route(w, 'POST', LINE).handler(ctx({ waveId: 'W-1', lineId: 'l1' }, picked()));
    const again = await route(w, 'POST', LINE).handler(ctx({ waveId: 'W-1', lineId: 'l1' }, picked()));
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ recorded: true, alreadyRecorded: true });
    expect(w.lines).toHaveLength(1);
    // Picked, then rejected on quality: two things happened; both are kept, the latest wins the fold.
    const rejected = await route(w, 'POST', LINE).handler(ctx({ waveId: 'W-1', lineId: 'l1' }, picked({ state: 'quality_failed', pickedQty: 0, finalPriceMinor: 0, note: 'damaged' })));
    expect(rejected.status).toBe(202);
    expect(w.lines).toHaveLength(2);
    expect(latestOutcomes(w.lines).map((o) => o.state)).toEqual(['quality_failed']);
    expect(crateFromLines(w.lines)).toEqual({ lineCount: 0, totalValueMinor: 0 });
    const view = presentWave('W-1', w.lines, undefined);
    expect(view['lines']).toEqual([expect.objectContaining({ lineId: 'l1', state: 'quality_failed', outcomesRecorded: 2 })]);
  });

  it('flags — never refuses — a picker head office does not know, one who lacks the authority, or an outcome that names nobody', async () => {
    const w = world();
    const unknown = await route(w, 'POST', LINE).handler(ctx({ waveId: 'W-1', lineId: 'l1' }, picked({ pickedBy: 'u-stranger' })));
    expect(unknown.status).toBe(202);
    expect(unknown.body).toMatchObject({ flags: ['picker_unknown'] });
    const lacks = await route(w, 'POST', LINE).handler(ctx({ waveId: 'W-1', lineId: 'l2' }, picked({ lineId: 'l2', pickedBy: 'u-floor' })));
    expect(lacks.body).toMatchObject({ flags: ['picker_lacks_authority'] });
    const nobody = await route(w, 'POST', LINE).handler(ctx({ waveId: 'W-1', lineId: 'l3' }, picked({ lineId: 'l3', pickedBy: null })));
    expect(nobody.body).toMatchObject({ flags: ['picker_unnamed'] });
    expect(w.lines.map((l) => l.governanceFlags)).toEqual([['picker_unknown'], ['picker_lacks_authority'], ['picker_unnamed']]);
    // The audit names the relay when nobody was named — never an invented picker.
    expect(w.audit[2]?.actorId).toBe('u-box');
  });

  it.each([
    ['a state that is not an outcome', picked({ state: 'pending' })],
    ['a state nobody defined', picked({ state: 'vanished' })],
    ['a wave id that disagrees with the path', picked({ waveId: 'W-9' })],
    ['a line id that disagrees with the path', picked({ lineId: 'l9' })],
    ['a negative quantity', picked({ pickedQty: -1 })],
    ['a fractional price', picked({ finalPriceMinor: 12.5 })],
    ['no product', picked({ productId: '' })],
    ['not an object', 'picked'],
  ])('refuses %s as unreadable (400) — the box dead-letters it by name, nothing is recorded', async (_why, body) => {
    const w = world();
    await expect(route(w, 'POST', LINE).handler(ctx({ waveId: 'W-1', lineId: 'l1' }, body))).rejects.toMatchObject({ status: 400, body: { code: 'not_readable_as_a_pick_outcome', wasItSaved: 'not_saved' } });
    expect(w.lines).toEqual([]);
    expect(w.audit).toEqual([]);
  });
});

describe('the wave\'s pack from the handheld', () => {
  it('is recorded with the crate DERIVED from the line register beside the handheld\'s figures — agreeing: no flags', async () => {
    const w = world();
    await route(w, 'POST', LINE).handler(ctx({ waveId: 'W-1', lineId: 'l1' }, picked()));
    await route(w, 'POST', LINE).handler(ctx({ waveId: 'W-1', lineId: 'l2' }, picked({ lineId: 'l2', productId: 'p-milk', state: 'quality_failed', pickedQty: 0, finalPriceMinor: 0 })));
    const res = await route(w, 'POST', PACK).handler(ctx({ waveId: 'W-1' }, packed()));
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ waveId: 'W-1', recorded: true, flags: [], fromLines: { lineCount: 1, totalValueMinor: 200_00 } });
    expect(w.packs[0]).toMatchObject({ packedBy: 'u-picker', relayedBy: 'u-box', temperatureC: 4, tamperSealRef: 'SEAL-1', governanceFlags: [] });
    expect(w.audit.at(-1)).toMatchObject({ actorId: 'u-picker', action: 'fulfilment.pack.record', objectId: 'W-1', after: { fromLinesCount: '1', fromLinesValueMinor: '20000' } });
    const view = presentWave('W-1', w.lines, w.packs[0]);
    expect(view).toMatchObject({ crate: { lineCount: 1, totalValueMinor: 200_00 }, packed: { lineCount: 1 }, flags: [], lineCount: 2 });
  });

  it('says when the handheld\'s crate disagrees with the register, when no temperature or seal was recorded, and when the packer is unknown or lacks authority — recorded, flagged, never refused', async () => {
    const w = world();
    await route(w, 'POST', LINE).handler(ctx({ waveId: 'W-1', lineId: 'l1' }, picked()));
    const res = await route(w, 'POST', PACK).handler(ctx({ waveId: 'W-1' }, packed({ lineCount: 2, totalValueMinor: 300_00, temperatureC: null, tamperSealRef: null, packedBy: 'u-stranger' })));
    expect(res.status).toBe(202);
    // …and the fold says the crate the handheld sealed (300) is not what the one order's pack adds up to (200).
    expect(res.body).toMatchObject({ flags: ['packer_unknown', 'lines_disagree', 'no_cold_chain_temperature', 'no_tamper_seal', 'orders_disagree'], fromLines: { lineCount: 1, totalValueMinor: 200_00 } });
    expect(w.packs[0]?.lineCount).toBe(2); // the handheld's figure is kept as the handheld said it — beside the register's
    const w2 = world();
    await route(w2, 'POST', LINE).handler(ctx({ waveId: 'W-1', lineId: 'l1' }, picked()));
    const lacks = await route(w2, 'POST', PACK).handler(ctx({ waveId: 'W-1' }, packed({ packedBy: 'u-floor' })));
    expect(lacks.body).toMatchObject({ flags: ['packer_lacks_authority'] });
    // A pack before any line reached head office: nothing supports it, and that is said rather than refused (the lines may still be on the box).
    const w3 = world();
    const early = await route(w3, 'POST', PACK).handler(ctx({ waveId: 'W-1' }, packed()));
    expect(early.body).toMatchObject({ flags: ['lines_disagree', 'orders_disagree'], fromLines: { lineCount: 0, totalValueMinor: 0 }, orders: [], ordersTotalMinor: 0 });
  });

  it('is ONE record however often it is re-sent (a wave packs once)', async () => {
    const w = world();
    await route(w, 'POST', LINE).handler(ctx({ waveId: 'W-1', lineId: 'l1' }, picked()));
    await route(w, 'POST', PACK).handler(ctx({ waveId: 'W-1' }, packed()));
    const again = await route(w, 'POST', PACK).handler(ctx({ waveId: 'W-1' }, packed()));
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ recorded: true, alreadyRecorded: true, flags: [] });
    expect(w.packs).toHaveLength(1);
  });

  it.each([
    ['no packer', packed({ packedBy: '' })],
    ['a wave id that disagrees with the path', packed({ waveId: 'W-9' })],
    ['a fractional line count', packed({ lineCount: 1.5 })],
    ['a temperature that is not a number', packed({ temperatureC: 'cold' })],
    ['not an object', null],
  ])('refuses %s as unreadable (400), nothing recorded', async (_why, body) => {
    const w = world();
    await expect(route(w, 'POST', PACK).handler(ctx({ waveId: 'W-1' }, body))).rejects.toMatchObject({ status: 400, body: { code: 'not_readable_as_a_wave_pack' } });
    expect(w.packs).toEqual([]);
  });
});

describe('the read', () => {
  it('shows the wave as head office holds it: latest outcome per line with history depth, the pack or null, every flag once', async () => {
    const w = world();
    await route(w, 'POST', LINE).handler(ctx({ waveId: 'W-1', lineId: 'l1' }, picked({ pickedBy: 'u-stranger' })));
    await route(w, 'POST', LINE).handler(ctx({ waveId: 'W-1', lineId: 'l1' }, picked({ state: 'short', pickedQty: 1, finalPriceMinor: 100_00, pickedBy: 'u-stranger' })));
    const empty = await route(w, 'GET', '/v1/fulfilment/waves/:waveId').handler(ctx({ waveId: 'W-2' }));
    expect(empty.body).toMatchObject({ waveId: 'W-2', lines: [], packed: null, flags: [], lineCount: 0, asAt: NOW });
    const res = await route(w, 'GET', '/v1/fulfilment/waves/:waveId').handler(ctx({ waveId: 'W-1' }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      waveId: 'W-1', lineCount: 1, packed: null, flags: ['picker_unknown'], crate: { lineCount: 1, totalValueMinor: 100_00 },
      lines: [{ lineId: 'l1', state: 'short', pickedQty: 1, outcomesRecorded: 2 }],
    });
    await expect(route(w, 'GET', '/v1/fulfilment/waves/:waveId').handler(ctx({ waveId: '' }))).rejects.toMatchObject({ status: 400 });
  });
});

describe('M19-FR-02 — the wave becomes ONE pack per ORDER on the register dispatch reads (3 Oct 2026)', () => {
  const line = (w: World, body: Record<string, unknown>) => route(w, 'POST', LINE).handler(ctx({ waveId: 'W-1', lineId: body['lineId'] as string }, body));
  const packW1 = (w: World, over: Record<string, unknown> = {}) => route(w, 'POST', PACK).handler(ctx({ waveId: 'W-1' }, packed(over)));
  const milk = (over: Record<string, unknown> = {}) => picked({ lineId: 'l2', productId: 'p-milk', description: 'Milk 1L', pickedQty: 1, requiredQty: 1, finalPriceMinor: 60_00, ...over });
  const paneer = (over: Record<string, unknown> = {}) => picked({ lineId: 'l3', orderRef: 'ORD-2', productId: 'p-paneer', description: 'Paneer 200g', state: 'short', pickedQty: 1, requiredQty: 2, finalPriceMinor: 50_00, ...over });

  it('two orders on one wave are folded with the exact figures: the picker\'s price stands, the crate\'s temperature is every line\'s reading, a short line says by how much, the crate reconciles — and the read and the audit show how each order joined', async () => {
    const w = world();
    await line(w, picked()); await line(w, milk()); await line(w, paneer());
    const res = await packW1(w, { lineCount: 3, totalValueMinor: 310_00 });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      flags: [], fromLines: { lineCount: 3, totalValueMinor: 310_00 }, ordersTotalMinor: 310_00,
      orders: [
        { orderId: 'ORD-1', outcome: 'packed', lineCount: 2, totalMinor: 260_00, refused: [] },
        { orderId: 'ORD-2', outcome: 'packed', lineCount: 1, totalMinor: 50_00, refused: [] },
      ],
    });
    const o1 = w.orderPacks.get('ORD-1')!;
    expect(o1).toHaveLength(1);
    expect(o1[0]).toMatchObject({ orderId: 'ORD-1', packed: true, outcome: 'packed', totalMinor: 260_00, refused: [] });
    expect(o1[0]!.lines).toEqual([
      expect.objectContaining({ lineId: 'l1', productId: 'p-rice', name: 'Rice 5kg', handling: 'ambient', packedMinor: 2, finalPriceMinor: 200_00, shortMinor: 0, crateId: 'crate-1' }),
      expect.objectContaining({ lineId: 'l2', productId: 'p-milk', name: 'Milk 1L', handling: 'chilled', packedMinor: 1, finalPriceMinor: 60_00, shortMinor: 0, crateId: 'crate-1' }),
    ]);
    const o2 = w.orderPacks.get('ORD-2')![0]!;
    expect(o2.lines).toEqual([expect.objectContaining({ lineId: 'l3', name: 'Paneer 200g', handling: 'chilled', packedMinor: 1, shortMinor: 1, finalPriceMinor: 50_00 })]);
    expect(o2.lines[0]!.detail).toContain('1 of 2, short, and charged only for what is going');
    expect(w.packs[0]).toMatchObject({ orders: [{ orderId: 'ORD-1' }, { orderId: 'ORD-2' }], ordersTotalMinor: 310_00, governanceFlags: [] });
    expect(presentWave('W-1', w.lines, w.packs[0])).toMatchObject({ packed: { orders: [{ orderId: 'ORD-1', totalMinor: 260_00 }, { orderId: 'ORD-2', totalMinor: 50_00 }] }, flags: [] });
    expect(w.audit.at(-1)).toMatchObject({ action: 'fulfilment.pack.record', after: { orders: 'ORD-1:packed:2:26000,ORD-2:packed:1:5000', ordersTotalMinor: '31000' } });
  });

  it('a product with NO handling class on the product master is refused on the order\'s pack and SAID on the wave — never defaulted, never read off its name — and the crate then disagrees with the orders', async () => {
    const w = world();
    await line(w, picked());
    await line(w, picked({ lineId: 'l4', productId: 'p-ghee', description: 'Ghee 500g', pickedQty: 1, requiredQty: 1, finalPriceMinor: 450_00 }));
    const res = await packW1(w, { lineCount: 2, totalValueMinor: 650_00 });
    expect(res.body).toMatchObject({
      flags: ['handling_unknown', 'orders_disagree'], ordersTotalMinor: 200_00,
      orders: [{ orderId: 'ORD-1', outcome: 'handling_unknown', lineCount: 1, totalMinor: 200_00, refused: [{ lineId: 'l4', reason: 'handling_unknown' }] }],
    });
    const pack = w.orderPacks.get('ORD-1')![0]!;
    expect(pack).toMatchObject({ packed: true, outcome: 'handling_unknown', totalMinor: 200_00 });
    expect(pack.lines.map((l) => l.lineId)).toEqual(['l1']);
    expect(pack.refused).toEqual([{ lineId: 'l4', reason: 'handling_unknown', detail: expect.stringContaining('names no handling class for p-ghee') }]);
    expect(pack.refused[0]!.detail).toContain('never guessed from its name');
    expect(pack.detail).toContain('1 with no handling class on the product master');
    // The pure fold, over the same register: the SAME answer, so the route adds nothing the engine did not say.
    const fold = foldWaveIntoOrders({ history: w.lines, temperatureC: 4, handlingOf: (id) => PRODUCTS[id], at: NOW });
    expect(fold.flags).toEqual(['handling_unknown']);
    expect(fold.orders[0]!.result.refused.map((r) => r.reason)).toEqual(['handling_unknown']);
  });

  it('applies the approved handling rules: a chilled line with no crate temperature is refused `temperature_not_taken` (the wave already says no temperature); a quality-failed line is `nothing_picked` — every refusal listed, the value never quietly dropped', async () => {
    const w = world();
    await line(w, milk());
    const res = await packW1(w, { lineCount: 1, totalValueMinor: 60_00, temperatureC: null });
    expect(res.body).toMatchObject({ flags: ['no_cold_chain_temperature', 'orders_disagree'], orders: [{ orderId: 'ORD-1', outcome: 'temperature_not_taken', lineCount: 0, totalMinor: 0, refused: [{ lineId: 'l2', reason: 'temperature_not_taken' }] }] });
    expect(w.orderPacks.get('ORD-1')![0]).toMatchObject({ packed: false, outcome: 'temperature_not_taken', totalMinor: 0 });
    const w2 = world();
    await line(w2, picked()); await line(w2, milk({ state: 'quality_failed', pickedQty: 0, finalPriceMinor: 0, note: 'leaking' }));
    const r2 = await packW1(w2, { lineCount: 1, totalValueMinor: 200_00 });
    expect(r2.body).toMatchObject({ flags: [], orders: [{ orderId: 'ORD-1', outcome: 'nothing_picked', lineCount: 1, totalMinor: 200_00, refused: [{ lineId: 'l2', reason: 'nothing_picked' }] }] });
  });

  it('an order that already has a DIFFERENT pack head office keeps is left as it was and SAID; the same pack already there (a fold cut off before the wave record, now retried) and a re-sent pack both write nothing twice', async () => {
    const desk: PackResult = { orderId: 'ORD-1', packed: true, outcome: 'packed', lines: [{ lineId: 'd1', productId: 'p-rice', name: 'Rice 5kg', packedMinor: 3, finalPriceMinor: 999_00, shortMinor: 0, handling: 'ambient', crateId: 'crate-1', detail: '3 × 33300' }], refused: [], totalMinor: 999_00, detail: '1 line(s) packed, 99900' };
    const w = world();
    w.orderPacks.set('ORD-1', [desk]);
    await line(w, picked());
    const res = await packW1(w);
    expect(res.body).toMatchObject({ flags: ['order_already_packed', 'orders_disagree'], orders: [{ orderId: 'ORD-1', outcome: 'already_packed', lineCount: 1, totalMinor: 999_00 }], ordersTotalMinor: 999_00 });
    expect(w.orderPacks.get('ORD-1')).toEqual([desk]);

    // Cut off between the order's record and the wave's: the retry finds the identical pack and writes nothing, flags nothing.
    const w2 = world();
    await line(w2, picked());
    const same = foldWaveIntoOrders({ history: w2.lines, temperatureC: 4, handlingOf: (id) => PRODUCTS[id], at: NOW }).orders[0]!.result;
    w2.orderPacks.set('ORD-1', [same]);
    const retried = await packW1(w2);
    expect(retried.body).toMatchObject({ flags: [], orders: [{ orderId: 'ORD-1', outcome: 'packed', totalMinor: 200_00 }] });
    expect(w2.orderPacks.get('ORD-1')).toHaveLength(1);
    expect(w2.packs).toHaveLength(1);

    // The handheld re-sending the pack: the wave answers "already recorded" with the orders, and nothing is written again.
    const again = await packW1(w2);
    expect(again.body).toMatchObject({ alreadyRecorded: true, orders: [{ orderId: 'ORD-1', outcome: 'packed' }], ordersTotalMinor: 200_00 });
    expect(w2.orderPacks.get('ORD-1')).toHaveLength(1);
    expect(w2.packs).toHaveLength(1);
  });

  it('a line from a handheld that did not send the quantity the order asked for is folded as picked = ordered and FLAGGED — the pack cannot say how short', async () => {
    const w = world();
    const legacy = Object.fromEntries(Object.entries(picked({ state: 'short', pickedQty: 1, finalPriceMinor: 100_00 })).filter(([k]) => k !== 'description' && k !== 'requiredQty'));
    await line(w, legacy);
    const res = await packW1(w, { lineCount: 1, totalValueMinor: 100_00 });
    expect(res.body).toMatchObject({ flags: ['required_qty_unknown'], orders: [{ orderId: 'ORD-1', outcome: 'packed', lineCount: 1, totalMinor: 100_00 }] });
    expect(w.orderPacks.get('ORD-1')![0]!.lines[0]).toMatchObject({ name: 'p-rice', packedMinor: 1, shortMinor: 0, finalPriceMinor: 100_00 });
    expect(w.lines[0]).toMatchObject({ description: null, requiredQty: null });
  });
});
