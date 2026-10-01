import { describe, it, expect } from 'vitest';
import {
  httpIndentsFeedSource, pullIndentsFeed, readIndentsFeed, indentsFeedDigest,
  type IndentsFeed, type IndentsFeedSource, type IndentsFeedFetch, type IndentsFeedReceiver,
} from '../../edge/sync-agent/src/indents-feed';
import { emptyPack, withIndentsFeed, type StorePack } from '../../edge/store-edge/src/store-pack';
import { warehousePayload, indentsPayload, type ScreenInput } from '../../edge/store-edge/src/screen-data';
import { known } from '../../edge/store-edge/src/store-pack';
import { SyncOutbox } from '../../packages/sync/src/index';

/**
 * **The box pulls head office's open floor indents and serves them to the warehouse handheld (SP-8c · F08 · P-01 · P-08 ·
 * hard rule #4).** Shaped like the migration-register pull: a clean 200 with a register is taken; anything else keeps what
 * is held and says so; an older register is kept out; the rows ride into the pack whole, and the handheld's payload derives
 * ONE row per owed line (approved / issuing, something outstanding, this back store) while the Indents screen gets the
 * register as its offline snapshot. The token never appears in a message.
 */

const NOW = '2026-10-01T09:30:00.000Z';
const TOKEN = ['unit', 'indents', 'token'].join('-').padEnd(40, 'z');

const line = (productId: string, outstandingMinor: number) => ({ productId, uom: 'EA', requestedMinor: outstandingMinor, allocatedMinor: outstandingMinor, issuedMinor: 0, receivedMinor: 0, inTransitMinor: 0, shortfallMinor: 0, damagedMinor: 0, returnedMinor: 0, outstandingMinor });
const feed = (over: Partial<IndentsFeed> = {}): IndentsFeed => ({
  asAt: '2026-10-01T09:00:00.000Z',
  indents: [
    { indentId: 'ind-1', state: 'approved', fromLocationId: 'S1-BACK', toLocationId: 'S1', requestedBy: 'u-floor', requestedAt: '2026-10-01T08:00:00.000Z', flags: [], attention: ['owed_by_back_store'], needsAttention: true, issues: [], totals: { lines: [line('RICE', 20), line('OIL', 0)] } },
    { indentId: 'ind-2', state: 'requested', fromLocationId: 'S1-BACK', toLocationId: 'S1', requestedBy: 'u-mgr', totals: { lines: [line('GHEE', 0)] } },
    { indentId: 'ind-3', state: 'issuing', fromLocationId: 'OTHER-BACK', toLocationId: 'S2', requestedBy: 'u-x', totals: { lines: [line('RICE', 4)] } },
  ],
  ...over,
});

const fetchReturning = (status: number, body: unknown): typeof globalThis.fetch =>
  (async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })) as unknown as typeof globalThis.fetch;

describe('readIndentsFeed — what the box accepts as the register', () => {
  it('accepts the register\'s shape and refuses one it cannot interpret', () => {
    expect(readIndentsFeed(feed())).toBeDefined();
    expect(readIndentsFeed({ asAt: NOW, indents: [] })).toBeDefined(); // nothing open is a valid register
    expect(readIndentsFeed(null)).toBeUndefined();
    expect(readIndentsFeed({ indents: [] })).toBeUndefined();
    expect(readIndentsFeed({ asAt: 'soon', indents: [] })).toBeUndefined();
    expect(readIndentsFeed({ asAt: NOW, indents: [{ state: 'approved' }] })).toBeUndefined();
    expect(readIndentsFeed({ asAt: NOW, indents: [{ indentId: 'i', state: 'approved', totals: { lines: [{ productId: 'P', outstandingMinor: 'ten' }] } }] })).toBeUndefined();
    expect(readIndentsFeed({ asAt: NOW, indents: [{ indentId: 'i', state: 'approved', totals: 'none' }] })).toBeUndefined();
  });
});

describe('httpIndentsFeedSource — GET /v1/floor/indents?open=true', () => {
  it('a clean 200 is fetched under the bearer token on the one path; a 403, a 5xx, a non-register body and a network error are "unreachable" with the status, never the body or the token', async () => {
    let seen: { url: string; auth: string | undefined } | undefined;
    const spy: typeof globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), auth: (init?.headers as Record<string, string>)['authorization'] };
      return new Response(JSON.stringify(feed()), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const got = await httpIndentsFeedSource({ baseUrl: 'https://cloud.example.test/', token: TOKEN, fetch: spy }).fetch();
    expect(got.status).toBe('fetched');
    expect(seen).toEqual({ url: 'https://cloud.example.test/v1/floor/indents?open=true', auth: `Bearer ${TOKEN}` });

    for (const [status, body] of [[403, { code: 'forbidden', echo: TOKEN }], [500, 'boom'], [200, { not: 'a register', echo: TOKEN }]] as const) {
      const r = await httpIndentsFeedSource({ baseUrl: 'https://cloud.example.test', token: TOKEN, fetch: fetchReturning(status, body) }).fetch();
      expect(r.status).toBe('unreachable');
      expect((r as { reason: string }).reason).not.toContain(TOKEN);
    }
    const down = await httpIndentsFeedSource({ baseUrl: 'https://cloud.example.test', token: TOKEN, fetch: (async () => { throw new Error('ENETUNREACH'); }) as unknown as typeof globalThis.fetch }).fetch();
    expect(down.status).toBe('unreachable');
  });
});

describe('pullIndentsFeed — take, re-confirm, keep, offline', () => {
  const receiver = (held?: IndentsFeed): IndentsFeedReceiver & { taken: IndentsFeed[] } => {
    let current = held;
    const taken: IndentsFeed[] = [];
    return { taken, heldFeed: () => current, takeFeed: (f) => { current = f; taken.push(f); } };
  };
  const source = (result: IndentsFeedFetch): IndentsFeedSource => ({ fetch: async () => result });

  it('takes a register when none is held (updated), re-confirms the same one quietly (unchanged), keeps out an older one, and holds on when offline', async () => {
    const fresh = receiver();
    expect(await pullIndentsFeed({ source: source({ status: 'fetched', feed: feed() }), receiver: fresh, now: NOW })).toMatchObject({ status: 'updated', asAt: '2026-10-01T09:00:00.000Z', ageMinutes: 30 });
    expect(fresh.taken).toHaveLength(1);
    // The same indents under a newer clock: taken (the clock moves), reported quietly.
    const same = await pullIndentsFeed({ source: source({ status: 'fetched', feed: feed({ asAt: '2026-10-01T09:20:00.000Z' }) }), receiver: fresh, now: NOW });
    expect(same).toMatchObject({ status: 'unchanged', asAt: '2026-10-01T09:20:00.000Z', ageMinutes: 10 });
    // An OLDER register (a stale replica) is kept out.
    const older = await pullIndentsFeed({ source: source({ status: 'fetched', feed: feed({ asAt: '2026-10-01T08:00:00.000Z', indents: [] }) }), receiver: fresh, now: NOW });
    expect(older).toMatchObject({ status: 'kept', reason: 'older than held', asAt: '2026-10-01T09:20:00.000Z' });
    expect(fresh.taken).toHaveLength(2);
    // Offline: the held register stands, and the message says how old it is.
    const off = await pullIndentsFeed({ source: source({ status: 'unreachable', reason: 'no answer' }), receiver: fresh, now: NOW });
    expect(off).toMatchObject({ status: 'offline', reason: 'no answer', asAt: '2026-10-01T09:20:00.000Z', ageMinutes: 10 });
    expect(off.staffMessage).toContain('10 minute(s) behind');
    // A changed register (an indent closed) is an update — the whole register replaces what was held.
    const closed = await pullIndentsFeed({ source: source({ status: 'fetched', feed: feed({ asAt: '2026-10-01T09:25:00.000Z', indents: feed().indents.slice(1) }) }), receiver: fresh, now: NOW });
    expect(closed.status).toBe('updated');
    expect(fresh.heldFeed()?.indents.map((i) => i.indentId)).toEqual(['ind-2', 'ind-3']);
  });

  it('the digest ignores the clock and row order — the same indents are the same register', () => {
    const a = feed();
    const b = feed({ asAt: NOW, indents: [...feed().indents].reverse() });
    expect(indentsFeedDigest(a)).toBe(indentsFeedDigest(b));
    expect(indentsFeedDigest(a)).not.toBe(indentsFeedDigest(feed({ indents: [] })));
  });
});

describe('into the pack and onto the screens', () => {
  const base = (): StorePack => ({
    ...emptyPack('never pulled'),
    policies: known({ storeId: 'S1', branchId: 'S1', branchName: 'Store 1', tradingDayCutoff: '02:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, warehouseId: 'S1-BACK' }),
    warehouse: known({ assignmentId: 'A-1', workerId: 'u-back', storeId: 'S1', bins: [{ binId: 'BIN-A', storeId: 'S1', capacityMinor: 100, pickable: true, zone: 'ambient' }] }),
    indentsPolicy: known({ userId: 'u-floor', permissions: ['inventory.indent.read'] }),
  } as StorePack);
  const input = (pack: StorePack): ScreenInput => ({ pack, sales: [], unreadableRecords: 0, outbox: new SyncOutbox(), now: NOW, tradingDay: '2026-10-01' });

  it('the handheld gets ONE row per owed line — approved or issuing, something outstanding, THIS back store — and the register\'s clock; nothing when none was pulled', () => {
    const without = warehousePayload(input(base()))!;
    expect(without).not.toHaveProperty('indentLines');
    const pack = withIndentsFeed(base(), feed(), NOW);
    expect(pack.floorIndents).toMatchObject({ known: true, value: { asAt: '2026-10-01T09:00:00.000Z', receivedAt: NOW } });
    const payload = warehousePayload(input(pack))!;
    // ind-1 RICE (20 owed) only: OIL has nothing outstanding; ind-2 is not approved; ind-3 is another back store's.
    expect(payload['indentLines']).toEqual([{ indentId: 'ind-1', productId: 'RICE', uom: 'EA', outstandingMinor: 20, requestedBy: 'u-floor', toLocationId: 'S1' }]);
    expect(payload['indentsAsAt']).toBe('2026-10-01T09:00:00.000Z');
  });

  it('the Indents screen gets the register as its offline snapshot, each indent with its lines beside its totals', () => {
    const payload = indentsPayload(input(withIndentsFeed(base(), feed(), NOW)))!;
    const snapshot = payload['snapshot'] as { asAt: string; indents: { indentId: string; lines: unknown[] }[] };
    expect(snapshot.asAt).toBe('2026-10-01T09:00:00.000Z');
    expect(snapshot.indents.map((i) => i.indentId)).toEqual(['ind-1', 'ind-2', 'ind-3']);
    expect(snapshot.indents[0]!.lines).toEqual([line('RICE', 20), line('OIL', 0)]);
    expect(indentsPayload(input(base()))).not.toHaveProperty('snapshot');
  });
});
