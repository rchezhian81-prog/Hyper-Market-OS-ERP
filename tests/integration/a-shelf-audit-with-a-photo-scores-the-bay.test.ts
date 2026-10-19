import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { deliveryPlaces } from '../support/approved-supplier';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore, InMemoryEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { shelfBayComplianceAdapter } from '../../services/api/src/r4-supply-lp-adapters';
import { shelfBayComplianceRoutes } from '../../services/inventory/src/shelf-bay-compliance';
import { testStandInShelfRecognition, type ShelfImageRecognition } from '../../packages/merchandising/src/shelf-image-port';

/**
 * **D-13 (R4, OB-219) — a shelf check with a photo scores the bay; recognition is switched off and no photo leaves the
 * shop**, on the real API, in memory and on REAL PostgreSQL, with a cold restart:
 *
 *   • a shelf map of three bays, a planogram in force, staff counts (one of them a day old), stock in the building;
 *   • the score per bay over the observed facings, every gap named: "empty, stock in back", "empty, none in building",
 *     "never counted", "counted too long ago"; a bay nobody counted is "not scored";
 *   • a photo of a bay is kept on head office's own store, checked for type and size, listed against its bay, and still
 *     there after a restart; the score says "counted by staff" and the recognition link — switched off — sent nothing;
 *   • with the TEST STAND-IN in place of the switched-off link (a route-level composition only tests make), the bay's latest
 *     photo is asked about and its answer is shown as a suggestion — the score does not move.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });

const backings: { name: string; harness: () => ApiHarness; restart: (h: ApiHarness) => ApiHarness }[] = [
  { name: 'the in-memory event store', harness: () => apiHarness(), restart: (h) => apiHarness({ store: h.store }) },
];
if (DATABASE_URL !== undefined) {
  const sqlHarness = () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); };
  backings.push({ name: 'real PostgreSQL', harness: sqlHarness, restart: sqlHarness });
}

const S1 = 'S1';
const LOCS = [
  { locationId: 'L1', aisle: 1, rack: 1, bay: 1, shelf: 1, position: 1, zone: 'ambient' },
  { locationId: 'L2', aisle: 1, rack: 1, bay: 1, shelf: 1, position: 2, zone: 'ambient' },
  { locationId: 'L3', aisle: 1, rack: 1, bay: 2, shelf: 1, position: 1, zone: 'ambient' },
  { locationId: 'L4', aisle: 1, rack: 1, bay: 2, shelf: 1, position: 2, zone: 'ambient' },
  { locationId: 'L5', aisle: 2, rack: 1, bay: 1, shelf: 1, position: 1, zone: 'ambient' },
];
const ASSIGN = [
  { productId: 'P-RICE', locationId: 'L1', capacityMinor: 40, primary: true },
  { productId: 'P-SOAP', locationId: 'L2', capacityMinor: 60, primary: true },
  { productId: 'P-DAL', locationId: 'L3', capacityMinor: 20, primary: true },
  { productId: 'P-OIL', locationId: 'L4', capacityMinor: 20, primary: true },
  { productId: 'P-SALT', locationId: 'L5', capacityMinor: 10, primary: true },
];
/** A tiny real PNG (1×1), as the phone would send it. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
interface Bay { bayKey: string; planned: number; observed: number; score: { kind: string; bp?: number }; gaps: { productId: string; words: string }[]; photos: { photoId: string }[]; measuredBy: string; recognitionSuggestion?: unknown }
interface Bays { asOf?: string; bays: Bay[]; measuredBy: string; recognition: { state: string; photosSent: number; changesTheScore: boolean } }

describe.each(backings)('a shelf audit with a photo scores the bay — on $name (D-13)', ({ harness, restart }) => {
  it('per-bay score with every gap named; a photo kept here and sent nowhere; counted by staff', async () => {
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    try {
      vi.setSystemTime(Date.parse('2026-10-18T05:00:00.000Z'));
      let h = harness();
      const T = randomUUID();
      await h.seedOwner(T, 'u-owner');
      await h.provisionRole(T, 'u-mgr', 'store_manager');
      await h.provisionRole(T, 'u-acct', 'accountant');
      await deliveryPlaces(h, T, S1);
      const req = (method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, userId = 'u-mgr', query?: Record<string, string>, key = `k-${randomUUID()}`): Promise<Res> =>
        h.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: key }), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
      const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
      await ok(req('PUT', `/v1/merchandising/stores/${S1}/shelf-map`, { locations: LOCS }), 'map');
      await ok(req('PUT', `/v1/merchandising/stores/${S1}/planograms/PG-1`, { effectiveFrom: '2026-10-01', assignments: ASSIGN }), 'plan');
      for (const [p, q] of [['P-RICE', 100], ['P-DAL', 50]] as const) {
        await ok(req('POST', '/v1/inventory/movements', { movementId: `rx-${p}`, productId: p, locationId: S1, kind: 'received', quantityMinor: q, uom: 'ea', occurredAt: '2026-10-10T05:00:00.000Z', enteredBy: 'u-owner', unitCostMinor: 100 }, 'u-owner'), `stock ${p}`);
      }
      const count = (id: string, productId: string, locationId: string, countedMinor: number) =>
        ok(req('POST', `/v1/merchandising/shelf-counts/${id}`, { storeId: S1, productId, locationId, countedMinor, knownLocationIds: LOCS.map((l) => l.locationId) }), `count ${id}`);
      await count('c-oil', 'P-OIL', 'L4', 20); // a day before
      vi.setSystemTime(Date.parse('2026-10-19T05:00:00.000Z'));
      await count('c-rice', 'P-RICE', 'L1', 0);
      await count('c-soap', 'P-SOAP', 'L2', 0);
      await count('c-dal', 'P-DAL', 'L3', 20);

      // The photo of bay A1-R1-B1: type and size checked; kept here; sent nowhere.
      const photo = (id: string, over: Record<string, unknown> = {}, userId = 'u-mgr') => req('POST', `/v1/merchandising/shelf-photos/${id}`, { storeId: S1, aisle: 1, rack: 1, bay: 1, mediaType: 'image/png', contentBase64: PNG, countIds: ['c-rice', 'c-soap'], ...over }, userId);
      expect(codeOf(await photo('ph-gif', { mediaType: 'image/gif' }))).toBe('image_type_not_allowed');
      expect(codeOf(await photo('ph-big', { contentBase64: Buffer.alloc(700 * 1024 + 1, 1).toString('base64') }))).toBe('image_too_large');
      expect(codeOf(await photo('ph-nowhere', { bay: 9 }))).toBe('no_such_bay');
      expect((await photo('ph-acct', {}, 'u-acct')).status).toBe(403);
      const kept = await ok(photo('ph-1'), 'photo');
      expect(kept.body).toMatchObject({ photo: { photoId: 'ph-1', bayKey: 'A1-R1-B1', mediaType: 'image/png', takenBy: 'u-mgr' }, sentAnywhere: false });
      expect((await photo('ph-1')).status).toBe(200); // the same photo again is the same record
      expect(codeOf(await photo('ph-1', { bay: 2 }))).toBe('photo_id_used');

      const bays = async (): Promise<Bays> => (await ok(req('GET', '/v1/merchandising/planogram-compliance/bays', undefined, 'u-mgr', { storeId: S1 }), 'bays')).body as Bays;
      const first = await bays();
      const at = Object.fromEntries(first.bays.map((b) => [b.bayKey, b]));
      expect(at['A1-R1-B1']).toMatchObject({ planned: 2, observed: 2, score: { kind: 'scored', bp: 0 }, photos: [{ photoId: 'ph-1' }] });
      expect(at['A1-R1-B1']!.gaps.map((g) => g.words)).toEqual(['empty, stock in back', 'empty, none in building']);
      expect(at['A1-R1-B2']).toMatchObject({ planned: 2, observed: 1, score: { kind: 'scored', bp: 10_000 } });
      expect(at['A1-R1-B2']!.gaps.map((g) => g.words)).toEqual(['counted too long ago']);
      expect(at['A2-R1-B1']).toMatchObject({ observed: 0, score: { kind: 'not_scored' } });
      expect(at['A2-R1-B1']!.gaps.map((g) => g.words)).toEqual(['never counted']);
      expect(first).toMatchObject({ measuredBy: 'counted by staff', recognition: { state: 'switched_off', photosSent: 0, changesTheScore: false } });
      expect(first.bays.every((b) => b.measuredBy === 'counted by staff' && b.recognitionSuggestion === undefined)).toBe(true);

      // ── A COLD RESTART: the photo is still kept, byte for byte ───────────────────────────────────────────────────
      h = restart(h);
      const got = (await ok(req('GET', '/v1/merchandising/shelf-photos/ph-1', undefined, 'u-mgr', { storeId: S1 }), 'photo read')).body as { photo: { contentBase64: string; bytes: number } };
      expect(got.photo.contentBase64).toBe(PNG);
      expect(((await ok(req('GET', '/v1/merchandising/shelf-photos', undefined, 'u-mgr', { storeId: S1 }), 'list')).body as { photos: Record<string, unknown>[] }).photos[0]).not.toHaveProperty('contentBase64');
      const { asOf: _a, ...again } = await bays(); const { asOf: _b, ...before } = first; void _a; void _b;
      expect(again).toEqual(before);
      expect((await req('GET', '/v1/merchandising/planogram-compliance/bays', undefined, 'u-acct', { storeId: S1 })).status).toBe(403);
      expect(codeOf(await req('GET', '/v1/merchandising/planogram-compliance/bays', undefined, 'u-mgr'))).toBe('store_required');
    } finally { vi.useRealTimers(); }
  }, 120_000);
});

describe('D-13 — the recognition link: off sends nothing; the test stand-in only suggests', () => {
  const ctx = (query: Record<string, string>) => ({ tenantId: 'T', userId: 'u-mgr', params: {}, query, body: undefined, branchId: null }) as unknown as Parameters<ReturnType<typeof shelfBayComplianceRoutes>[number]['handler']>[0];
  async function shop(recognition: ShelfImageRecognition) {
    const store = new InMemoryEventStore();
    const base = shelfBayComplianceAdapter({ store, now: () => '2026-10-19T05:00:00.000Z' });
    const deps = {
      ...base, recognition,
      shelfMap: async () => ({ storeId: S1, version: 1, locations: LOCS.map((l) => ({ ...l, storeId: S1 })) as never, publishedBy: 'u', publishedAt: '' }),
      planograms: async () => [{ planogramId: 'PG-1', storeId: S1, version: 1, effectiveFrom: '2026-10-01', createdBy: 'u', publishedAt: '', shelfMapVersion: 1, assignments: ASSIGN.map((a) => ({ ...a, storeId: S1 })) }],
      counts: async () => [{ storeId: S1, productId: 'P-RICE', locationId: 'L1', countedMinor: 0, countedBy: 'u-mgr', at: '2026-10-19T04:00:00.000Z' }],
      onHandAtStore: async () => ({ 'P-RICE': 100 }),
    };
    await deps.recordPhoto('T', { photoId: 'ph-1', storeId: S1, aisle: 1, rack: 1, bay: 1, bayKey: 'A1-R1-B1', mediaType: 'image/png', bytes: 1, sha256: 'x', contentBase64: PNG, countIds: [], takenBy: 'u-mgr', takenAt: '2026-10-19T04:00:00.000Z' });
    const bays = shelfBayComplianceRoutes(deps).find((r) => r.path === '/v1/merchandising/planogram-compliance/bays')!;
    return (await bays.handler(ctx({ storeId: S1 }))).body as Bays;
  }

  it('switched off: the link is never asked, nothing is sent', async () => {
    const asked: string[] = [];
    const off: ShelfImageRecognition = { state: 'switched_off', detail: 'off', recognise: async (p) => { asked.push(p.photoId); return []; } };
    const out = await shop(off);
    expect(asked).toEqual([]);
    expect(out.recognition).toMatchObject({ state: 'switched_off', photosSent: 0 });
  });

  it('the test stand-in is asked about the bay\'s latest photo; its answer is a suggestion and the score does not move', async () => {
    const fake = testStandInShelfRecognition({ 'ph-1': [{ productId: 'P-RICE', facingsSeen: 3 }] });
    const on = await shop(fake);
    const offOut = await shop({ state: 'switched_off', detail: 'off', recognise: async () => [] });
    expect(fake.asked).toEqual(['ph-1']);
    const b = on.bays.find((x) => x.bayKey === 'A1-R1-B1')!;
    expect(b.recognitionSuggestion).toEqual([{ productId: 'P-RICE', facingsSeen: 3 }]);
    expect(b.score).toEqual(offOut.bays.find((x) => x.bayKey === 'A1-R1-B1')!.score);
    expect(b.gaps.map((g) => g.words)).toContain('empty, stock in back');
    expect(on).toMatchObject({ measuredBy: 'counted by staff', recognition: { state: 'test_stand_in', photosSent: 1, changesTheScore: false } });
  });
});
