import { describe, it, expect } from 'vitest';
import {
  syncedWaveRoutes, crateFromLines, latestOutcomes, presentWave, WAVE_SYNC_FLAGS, PICK_LINE_OUTCOMES,
  type WaveSyncDeps, type WaveLineOutcome, type WavePackRecord,
} from '../../services/fulfilment/src/waves';
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
  readonly audit: AuditEntry[];
  readonly grants: Record<string, readonly string[] | undefined>;
  readonly routes: readonly Route[];
}

function world(grants: Record<string, readonly string[] | undefined> = { 'u-picker': ['fulfilment.pack.record'], 'u-floor': ['pos.sale.record'] }): World {
  const lines: WaveLineOutcome[] = [];
  const packs: WavePackRecord[] = [];
  const audit: AuditEntry[] = [];
  const deps: WaveSyncDeps = {
    permissionsOfUser: (_t, userId) => grants[userId],
    lineOutcomes: (_t, waveId) => lines.filter((l) => l.waveId === waveId),
    recordLineOutcome: (_t, o) => { lines.push(o); },
    pack: (_t, waveId) => packs.find((p) => p.waveId === waveId),
    recordPack: (_t, r) => { packs.push(r); },
    recordAudit: (_t, e) => { audit.push(e); },
    now: () => NOW,
  };
  return { lines, packs, audit, grants, routes: syncedWaveRoutes(deps) };
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
  finalPriceMinor: 200_00, currency: 'INR', substituted: false, note: null, pickedBy: 'u-picker', ...over,
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
    expect(res.body).toMatchObject({ flags: ['packer_unknown', 'lines_disagree', 'no_cold_chain_temperature', 'no_tamper_seal'], fromLines: { lineCount: 1, totalValueMinor: 200_00 } });
    expect(w.packs[0]?.lineCount).toBe(2); // the handheld's figure is kept as the handheld said it — beside the register's
    const w2 = world();
    await route(w2, 'POST', LINE).handler(ctx({ waveId: 'W-1', lineId: 'l1' }, picked()));
    const lacks = await route(w2, 'POST', PACK).handler(ctx({ waveId: 'W-1' }, packed({ packedBy: 'u-floor' })));
    expect(lacks.body).toMatchObject({ flags: ['packer_lacks_authority'] });
    // A pack before any line reached head office: nothing supports it, and that is said rather than refused (the lines may still be on the box).
    const w3 = world();
    const early = await route(w3, 'POST', PACK).handler(ctx({ waveId: 'W-1' }, packed()));
    expect(early.body).toMatchObject({ flags: ['lines_disagree'], fromLines: { lineCount: 0, totalValueMinor: 0 } });
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
