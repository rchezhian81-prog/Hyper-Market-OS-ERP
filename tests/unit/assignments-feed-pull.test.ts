import { describe, it, expect } from 'vitest';
import {
  httpAssignmentsFeedSource, pullAssignmentsFeed, readAssignmentsFeed, assignmentsFeedDigest,
  type AssignmentsFeed, type AssignmentsFeedSource, type AssignmentsFeedFetch, type AssignmentsFeedReceiver,
} from '../../edge/sync-agent/src/assignments-feed';
import { emptyPack, withAssignmentsFeed, known, type StorePack } from '../../edge/store-edge/src/store-pack';
import { pickerPayload, driverPayload, type ScreenInput } from '../../edge/store-edge/src/screen-data';
import { SyncOutbox } from '../../packages/sync/src/index';

/**
 * **The box pulls head office's open wave and route assignments and serves them to the picker and driver phones (HA-1 · M19-FR-01/03 ·
 * P-01 · P-08 · hard rule #4).** Shaped like the floor-indents pull: a clean 200 for THIS store is taken; anything else keeps what
 * is held and says so; an older feed is kept out; the pack file's hand-written wave / route win and the screens say which source
 * they hold. The token never appears in a message.
 */

const NOW = '2026-10-03T06:30:00.000Z';
const TOKEN = ['unit', 'assignments', 'token'].join('-').padEnd(40, 'z');
const wave = (over: Record<string, unknown> = {}) => ({
  waveId: 'W-HQ', pickerId: 'u-picker', assignedBy: 'u-dispatcher', assignedAt: '2026-10-03T06:00:00.000Z',
  lines: [{ lineId: 'h1', orderRef: 'ORD-HQ', productId: 'p-rice', description: 'Rice 5kg', bin: 'A-01', requiredQty: 1, uom: 'ea', unitPriceMinor: 100_00 }], ...over,
});
const routeHQ = (over: Record<string, unknown> = {}) => ({
  routeId: 'R-HQ', driverId: 'u-driver', assignedBy: 'u-dispatcher', assignedAt: '2026-10-03T06:00:00.000Z',
  stops: [{ stopId: 's1', orderRef: 'ORD-HQ', area: 'Anna Nagar', codMinor: 100_00 }], ...over,
});
const feed = (over: Partial<AssignmentsFeed> = {}): AssignmentsFeed => ({ asAt: '2026-10-03T06:00:00.000Z', storeId: 'store-1', waves: [wave()], routes: [routeHQ()], ...over });
const fetchReturning = (status: number, body: unknown): typeof globalThis.fetch =>
  (async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })) as unknown as typeof globalThis.fetch;
const input = (pack: StorePack): ScreenInput => ({ pack, sales: [], unreadableRecords: 0, outbox: new SyncOutbox(), now: NOW, tradingDay: '2026-10-03' });

describe('readAssignmentsFeed — what the box accepts', () => {
  it('accepts the feed\'s shape, an empty one included, and refuses anything a phone could not act on', () => {
    expect(readAssignmentsFeed(feed())).toBeDefined();
    expect(readAssignmentsFeed(feed({ waves: [], routes: [] }))).toBeDefined();
    expect(readAssignmentsFeed(null)).toBeUndefined();
    expect(readAssignmentsFeed({ asAt: NOW, waves: [], routes: [] })).toBeUndefined(); // no store
    expect(readAssignmentsFeed(feed({ asAt: 'soon' }))).toBeUndefined();
    expect(readAssignmentsFeed(feed({ waves: [wave({ pickerId: '' })] }))).toBeUndefined();
    expect(readAssignmentsFeed(feed({ waves: [wave({ lines: [{ lineId: 'x' }] })] }))).toBeUndefined();
    expect(readAssignmentsFeed(feed({ routes: [routeHQ({ stops: [{ stopId: 's', orderRef: 'o', area: 'a', codMinor: 'ten' }] })] }))).toBeUndefined();
    expect(readAssignmentsFeed(feed({ routes: [routeHQ({ contributionRule: { maxCostShareBps: 'lots' } })] }))).toBeUndefined();
  });
});

describe('httpAssignmentsFeedSource — GET /v1/fulfilment/assignments?storeId=', () => {
  it('a clean 200 for THIS store is fetched under the bearer token; a 403, a 5xx, a non-feed body, another store\'s feed and a network error are "unreachable" with the status, never the body or the token', async () => {
    let seen: { url: string; auth: string | undefined } | undefined;
    const spy: typeof globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), auth: (init?.headers as Record<string, string>)['authorization'] };
      return new Response(JSON.stringify(feed()), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const got = await httpAssignmentsFeedSource({ baseUrl: 'https://cloud.example.test/', token: TOKEN, storeId: 'store-1', fetch: spy }).fetch();
    expect(got.status).toBe('fetched');
    expect(seen).toEqual({ url: 'https://cloud.example.test/v1/fulfilment/assignments?storeId=store-1', auth: `Bearer ${TOKEN}` });
    for (const [status, body] of [[403, { code: 'forbidden', echo: TOKEN }], [500, 'boom'], [200, { not: 'a feed', echo: TOKEN }], [200, feed({ storeId: 'store-2' })]] as const) {
      const r = await httpAssignmentsFeedSource({ baseUrl: 'https://cloud.example.test', token: TOKEN, storeId: 'store-1', fetch: fetchReturning(status, body) }).fetch();
      expect(r.status).toBe('unreachable');
      expect((r as { reason: string }).reason).not.toContain(TOKEN);
    }
    const down: typeof globalThis.fetch = (async () => { throw new Error('ENETUNREACH'); }) as unknown as typeof globalThis.fetch;
    const r = await httpAssignmentsFeedSource({ baseUrl: 'https://cloud.example.test', token: TOKEN, storeId: 'store-1', fetch: down }).fetch();
    expect(r).toMatchObject({ status: 'unreachable', reason: expect.stringContaining('could not reach the cloud') });
  });
});

describe('pullAssignmentsFeed — take, re-confirm, keep out the old, hold through offline', () => {
  const receiver = (): AssignmentsFeedReceiver & { held: AssignmentsFeed | undefined; receivedAt: string[] } => {
    const r = { held: undefined as AssignmentsFeed | undefined, receivedAt: [] as string[], heldFeed: () => r.held, takeFeed: (f: AssignmentsFeed, at: string) => { r.held = f; r.receivedAt.push(at); } };
    return r;
  };
  const source = (...answers: AssignmentsFeedFetch[]): AssignmentsFeedSource => ({ fetch: async () => answers.shift() ?? { status: 'unreachable', reason: 'no more answers' } });

  it('takes a feed when it holds none (updated), re-confirms the same content quietly (unchanged), keeps out an OLDER one (kept), and holds what it has when the cloud is unreachable (offline) — with the age said', async () => {
    const r = receiver();
    const first = await pullAssignmentsFeed({ source: source({ status: 'fetched', feed: feed() }), receiver: r, now: NOW });
    expect(first).toMatchObject({ status: 'updated', asAt: '2026-10-03T06:00:00.000Z', ageMinutes: 30, staffMessage: expect.stringContaining('1 wave(s) to pick, 1 route(s) to drive') });
    const again = await pullAssignmentsFeed({ source: source({ status: 'fetched', feed: feed({ asAt: '2026-10-03T06:10:00.000Z' }) }), receiver: r, now: NOW });
    expect(again.status).toBe('unchanged');
    expect(r.held?.asAt).toBe('2026-10-03T06:10:00.000Z');
    const older = await pullAssignmentsFeed({ source: source({ status: 'fetched', feed: feed({ asAt: '2026-10-03T05:00:00.000Z', waves: [] }) }), receiver: r, now: NOW });
    expect(older).toMatchObject({ status: 'kept', reason: 'older than held' });
    expect(r.held?.waves).toHaveLength(1);
    const offline = await pullAssignmentsFeed({ source: source({ status: 'unreachable', reason: 'ENETUNREACH' }), receiver: r, now: NOW });
    expect(offline).toMatchObject({ status: 'offline', asAt: '2026-10-03T06:10:00.000Z', ageMinutes: 20 });
    expect(offline.staffMessage).toContain('20 minute(s) behind the cloud');
    // A newer feed that no longer lists the wave (it was packed) is taken — done work leaves the phone by itself.
    const done = await pullAssignmentsFeed({ source: source({ status: 'fetched', feed: feed({ asAt: '2026-10-03T06:20:00.000Z', waves: [] }) }), receiver: r, now: NOW });
    expect(done.status).toBe('updated');
    expect(r.held?.waves).toEqual([]);
    expect(assignmentsFeedDigest(feed())).toBe(assignmentsFeedDigest(feed({ asAt: '2099-01-01T00:00:00.000Z' })));
  });
});

describe('the pack and the phones', () => {
  it('lays the feed into the pack\'s `assignments` and leaves the pack file\'s wave / route alone; the picker sees head office\'s wave with the source named; a hand-written wave WINS and says so; the driver gets head office\'s route by driver, named', () => {
    const base = emptyPack('no pack file');
    const pack = withAssignmentsFeed(base, feed({ waves: [wave(), wave({ waveId: 'W-2', pickerId: 'u-other' })], routes: [routeHQ(), routeHQ({ routeId: 'R-2', driverId: 'u-other-driver' })] }), NOW);
    expect(pack.assignments).toMatchObject({ known: true, value: { asAt: '2026-10-03T06:00:00.000Z', storeId: 'store-1', receivedAt: NOW } });
    expect(pack.wave).toEqual(base.wave); // the hand-written section is untouched (still not known here)
    const picker = pickerPayload(input(pack))!;
    expect(picker).toMatchObject({ waveId: 'W-HQ', pickerId: 'u-picker', assignedBy: 'head office, as of 2026-10-03T06:00:00.000Z', wavesAssigned: 2 });
    expect((picker['lines'] as { lineId: string; unitPrice: unknown }[])[0]).toMatchObject({ lineId: 'h1', unitPrice: { minor: 100_00, currency: 'INR' } });
    const handWritten = pickerPayload(input({ ...pack, wave: known({ waveId: 'W-HAND', pickerId: 'u-picker', lines: wave().lines }) }))!;
    expect(handWritten).toMatchObject({ waveId: 'W-HAND', assignedBy: 'this box\'s pack file — a wave written by hand', wavesAssigned: 2 });
    expect(pickerPayload(input(withAssignmentsFeed(base, feed({ waves: [] }), NOW)))).toBeNull(); // nothing assigned, nothing written: no wave, not an empty one
    const driver = driverPayload(input(pack))!;
    expect(driver).toMatchObject({ routeId: 'R-HQ', driverId: 'u-driver', plannedBy: 'head office, as of 2026-10-03T06:00:00.000Z', routesAssigned: 2, stops: routeHQ().stops });
    expect(driverPayload(input(pack), 'u-other-driver')).toMatchObject({ routeId: 'R-2' });
    expect(driverPayload(input(pack), 'u-nobody')).toBeNull();
    const byHand = driverPayload(input({ ...pack, route: known({ routeId: 'R-HAND', driverId: 'u-driver', stops: routeHQ().stops }) }))!;
    expect(byHand).toMatchObject({ routeId: 'R-HAND', plannedBy: 'a dispatcher, by hand' });
  });
});
