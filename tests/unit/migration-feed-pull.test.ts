import { describe, it, expect } from 'vitest';
import {
  httpMigrationFeedSource, pullMigrationFeed, readMigrationFeed, feedDigest,
  type MigrationFeed, type MigrationFeedSource, type MigrationFeedFetch, type MigrationFeedReceiver,
} from '../../edge/sync-agent/src/index';
import { emptyPack, readPack, withMigrationFeed, type StorePack } from '../../edge/store-edge/src/store-pack';
import { migrationPayload, type ScreenInput } from '../../edge/store-edge/src/screen-data';
import { SyncOutbox } from '../../packages/sync/src/index';

/**
 * **The box pulls the cloud's migration register (Stage C3b) — MG-04 · MG-06 · MG-10 · §31 · P-01 · P-08 · #4.**
 *
 * Three units, each without a network: the HTTP source (what counts as "got the register" vs "could not");
 * the puller (this shop's, not older, changed or re-confirmed); and the store-pack merge, whose one rule is
 * that a section the cloud did not send is left exactly as it was — never filled in — while the cloud's facts
 * about the cutover replace the file's, and the box's own facts (who is on the screen) survive.
 */

const NOW = '2026-10-10T21:00:00.000Z';
const T = 't-sre';
const TOKEN = ['unit', 'feed', 'token'].join('-').padEnd(40, 'z');

const feed = (over: Partial<MigrationFeed> = {}): MigrationFeed => ({
  tenantId: T, generatedAt: '2026-10-10T20:00:00.000Z',
  policy: { cutoverId: 'cut-1', requiredCleanDays: 3, maxParallelDays: 14, startedOn: '2026-10-01', dailyReconcilerUserId: 'u-recon' },
  loadOperator: 'u-loader',
  exceptions: [{ exceptionId: 'EX-1', tenantId: T, kind: 'duplicate_product', severity: 'low', confidence: 'probable', legacyIds: ['L-1'], evidence: 'e' }],
  refusedDecisions: [], rollbacks: [],
  verification: { covered: [], missing: ['products'], ownerKnown: true, extractionOperatorKnown: true, signaturesOverThisPage: 0, detail: '0 of 12' },
  ...over,
});

const fetchReturning = (status: number, body: unknown, delayMs = 0): typeof globalThis.fetch =>
  (async (_url: string | URL | Request, init?: RequestInit) => {
    if (delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, delayMs);
        init?.signal?.addEventListener('abort', () => { clearTimeout(t); const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
      });
    }
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as unknown as typeof globalThis.fetch;

describe('readMigrationFeed — what the box accepts as a register', () => {
  it('accepts the cloud\'s shape and refuses one it cannot interpret', () => {
    expect(readMigrationFeed(feed())).toBeDefined();
    expect(readMigrationFeed({ tenantId: T, generatedAt: NOW })).toBeDefined(); // nothing recorded yet is a valid feed
    expect(readMigrationFeed(null)).toBeUndefined();
    expect(readMigrationFeed({ generatedAt: NOW })).toBeUndefined();
    expect(readMigrationFeed({ tenantId: T, generatedAt: 'yesterday-ish' })).toBeUndefined();
    expect(readMigrationFeed(feed({ policy: { cutoverId: 'cut-1', requiredCleanDays: 0 } }))).toBeUndefined();
    expect(readMigrationFeed(feed({ policy: { cutoverId: '', requiredCleanDays: 3 } }))).toBeUndefined();
    expect(readMigrationFeed({ ...feed(), exceptions: 'lots' })).toBeUndefined();
    expect(readMigrationFeed({ ...feed(), loadOperator: 42 })).toBeUndefined();
  });
});

describe('httpMigrationFeedSource — GET /v1/migration/screen', () => {
  it('a clean 200 with a register is fetched; the request carries the bearer token and hits the one path', async () => {
    let seen: { url: string; auth: string | undefined } | undefined;
    const f = (async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), auth: (init?.headers as Record<string, string>)['authorization'] };
      return new Response(JSON.stringify(feed()), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const r = await httpMigrationFeedSource({ baseUrl: 'https://cloud.example.test/', token: TOKEN, fetch: f }).fetch();
    expect(r.status).toBe('fetched');
    expect(seen).toEqual({ url: 'https://cloud.example.test/v1/migration/screen', auth: `Bearer ${TOKEN}` });
  });

  it('a 403, a 401, a 500 and a body that is not a register are all "unreachable" — and the reason never carries the token (#4)', async () => {
    for (const [status, body] of [[403, { error: 'forbidden' }], [401, {}], [500, 'boom'], [200, { nope: true }]] as const) {
      const r = await httpMigrationFeedSource({ baseUrl: 'https://c.test', token: TOKEN, fetch: fetchReturning(status, body) }).fetch();
      expect(r.status).toBe('unreachable');
      expect((r as { reason: string }).reason).not.toContain(TOKEN);
    }
  });

  it('a hung socket is cut off at the timeout and reported as unreachable', async () => {
    const r = await httpMigrationFeedSource({ baseUrl: 'https://c.test', token: TOKEN, fetch: fetchReturning(200, feed(), 500), timeoutMs: 20 }).fetch();
    expect(r).toMatchObject({ status: 'unreachable' });
    expect((r as { reason: string }).reason).toContain('no answer within 20ms');
  });
});

// A source that returns one programmed outcome, and a receiver that remembers what it took.
const sourceOf = (result: MigrationFeedFetch): MigrationFeedSource => ({ fetch: async () => result });
function receiver(held?: MigrationFeed) {
  const taken: { feed: MigrationFeed; receivedAt: string }[] = [];
  let current = held;
  const r: MigrationFeedReceiver = {
    tenantId: T,
    heldFeed: () => current,
    takeFeed: (f, at) => { current = f; taken.push({ feed: f, receivedAt: at }); },
  };
  return { r, taken };
}

describe('pullMigrationFeed — this shop\'s, not older, changed or re-confirmed', () => {
  it('takes a first register: updated, with its cloud clock and age', async () => {
    const { r, taken } = receiver();
    const o = await pullMigrationFeed({ source: sourceOf({ status: 'fetched', feed: feed() }), receiver: r, now: NOW });
    expect(o).toMatchObject({ status: 'updated', generatedAt: '2026-10-10T20:00:00.000Z', ageHours: 1 });
    expect(o.staffMessage).toContain('cutover cut-1');
    expect(taken).toEqual([{ feed: feed(), receivedAt: NOW }]);
  });

  it('re-confirms the same content at a newer clock quietly: taken (so the age is honest), reported unchanged', async () => {
    const { r, taken } = receiver(feed());
    const again = feed({ generatedAt: '2026-10-10T20:59:00.000Z' });
    const o = await pullMigrationFeed({ source: sourceOf({ status: 'fetched', feed: again }), receiver: r, now: NOW });
    expect(o.status).toBe('unchanged');
    expect(o.generatedAt).toBe('2026-10-10T20:59:00.000Z');
    expect(taken).toHaveLength(1);
    expect(feedDigest(again)).toBe(feedDigest(feed()));
  });

  it('a newer register whose content differs is updated — a resolution folded in on the cloud reaches the box', async () => {
    const { r } = receiver(feed());
    const resolved = feed({ generatedAt: '2026-10-10T20:30:00.000Z', exceptions: [{ ...(feed().exceptions![0] as object), resolution: { action: 'merge', decidedBy: 'u-mgr' } }] });
    expect((await pullMigrationFeed({ source: sourceOf({ status: 'fetched', feed: resolved }), receiver: r, now: NOW })).status).toBe('updated');
  });

  it('keeps out another shop\'s register and one generated before the held one — never goes backwards', async () => {
    const { r, taken } = receiver(feed());
    const other = await pullMigrationFeed({ source: sourceOf({ status: 'fetched', feed: feed({ tenantId: 't-other' }) }), receiver: r, now: NOW });
    expect(other).toMatchObject({ status: 'kept', reason: 'tenant mismatch' });
    const older = await pullMigrationFeed({ source: sourceOf({ status: 'fetched', feed: feed({ generatedAt: '2026-10-09T09:00:00.000Z', exceptions: [] }) }), receiver: r, now: NOW });
    expect(older).toMatchObject({ status: 'kept', reason: 'older than held', generatedAt: '2026-10-10T20:00:00.000Z' });
    expect(taken).toHaveLength(0);
  });

  it('offline keeps the held register and says how far behind it is (P-08); with none held it says so', async () => {
    const { r } = receiver(feed({ generatedAt: '2026-10-08T21:00:00.000Z' }));
    const o = await pullMigrationFeed({ source: sourceOf({ status: 'unreachable', reason: 'dns' }), receiver: r, now: NOW });
    expect(o).toMatchObject({ status: 'offline', ageHours: 48, reason: 'dns' });
    expect(o.staffMessage).toContain('48 hour(s) behind the cloud');
    const none = await pullMigrationFeed({ source: sourceOf({ status: 'unreachable', reason: 'dns' }), receiver: receiver().r, now: NOW });
    expect(none).toMatchObject({ status: 'offline', generatedAt: null, ageHours: null });
    expect(none.staffMessage).toContain('has not been told anything by the cloud yet');
  });
});

describe('withMigrationFeed — the cloud\'s register laid over the pack, never filling a gap', () => {
  const filePack = (): StorePack => readPack({
    version: 7,
    migrationPolicy: { cutoverId: 'cut-from-file', requiredCleanDays: 2, userId: 'u-owner', namedTeam: [{ userId: 'u-owner', role: 'decides' }], openAssessments: 1 },
    migrationTotals: [{ totalId: 'CT-FILE' }],
  }, NOW);

  it('replaces only the sections the feed carries; the rest keep what the file said, known or not', () => {
    const merged = withMigrationFeed(filePack(), feed(), NOW);
    expect(merged.migrationExceptions).toEqual({ known: true, value: feed().exceptions });
    expect(merged.migrationTotals).toEqual({ known: true, value: [{ totalId: 'CT-FILE' }] }); // the feed had no totals — untouched
    expect(merged.parallelDays.known).toBe(false);                                            // never sent, never invented
    expect(merged.historyExclusions.known).toBe(false);
    expect(merged.version).toBe(7);
    expect(merged.migrationFeed).toEqual({ known: true, value: { generatedAt: feed().generatedAt, receivedAt: NOW, refusedDecisions: [], verification: feed().verification } });
  });

  it('the cloud owns the cutover\'s terms and the ledger facts; the box keeps who is on its screen and what the cloud does not record', () => {
    const merged = withMigrationFeed(filePack(), feed({ rollbackDemonstratedAt: '2026-10-05T10:00:00.000Z' }), NOW);
    expect(merged.migrationPolicy).toEqual({ known: true, value: {
      cutoverId: 'cut-1', requiredCleanDays: 3,               // from the owner's written terms on the cloud
      loadOperator: 'u-loader', rollbackDemonstratedAt: '2026-10-05T10:00:00.000Z', // ledger facts
      userId: 'u-owner', namedTeam: [{ userId: 'u-owner', role: 'decides' }], openAssessments: 1, // the box's own
    } });
  });

  it('a feed without terms leaves the file\'s policy standing, adding only the ledger facts it does carry', () => {
    const merged = withMigrationFeed(filePack(), feed({ policy: undefined }), NOW);
    expect(merged.migrationPolicy).toEqual({ known: true, value: { cutoverId: 'cut-from-file', requiredCleanDays: 2, userId: 'u-owner', namedTeam: [{ userId: 'u-owner', role: 'decides' }], openAssessments: 1, loadOperator: 'u-loader' } });
  });

  it('with no terms on the cloud and none in the pack there is still no policy — and the screen says the box was told nothing about a cutover', () => {
    const merged = withMigrationFeed(emptyPack(), feed({ policy: undefined }), NOW);
    expect(merged.migrationPolicy.known).toBe(false);
    expect(merged.migrationExceptions.known).toBe(true); // the register itself is still carried, for when terms arrive
    expect(migrationPayload({ pack: merged, sales: [], unreadableRecords: 0, outbox: new SyncOutbox(), now: NOW, tradingDay: '2026-10-10' })).toBeNull();
  });

  it('the screen payload then shows the register\'s age from the CLOUD\'s clock, and the two registers with no section of their own', () => {
    const merged = withMigrationFeed(emptyPack(), feed(), NOW);
    const input: ScreenInput = { pack: merged, sales: [], unreadableRecords: 0, outbox: new SyncOutbox(), now: NOW, tradingDay: '2026-10-10' };
    const payload = migrationPayload(input)!;
    expect(payload['cutoverId']).toBe('cut-1');
    expect(payload['loadOperator']).toBe('u-loader');
    expect(payload).not.toHaveProperty('userId'); // nobody is on this box's screen until the box is told — nothing may be signed
    expect(payload['exceptions']).toEqual(feed().exceptions);
    expect(payload).not.toHaveProperty('totals');
    expect(payload).not.toHaveProperty('parallelDays');
    expect(payload['cloudRegister']).toEqual({ generatedAt: '2026-10-10T20:00:00.000Z', receivedAt: NOW, ageHours: 1 });
    expect(payload['refusedDecisions']).toEqual([]);
    expect(payload['verification']).toEqual(feed().verification);
    // A box that has never pulled has no cloudRegister at all — it must not look like a fresh one.
    expect(migrationPayload({ ...input, pack: { ...emptyPack(), migrationPolicy: { known: true, value: { cutoverId: 'c', requiredCleanDays: 1 } } } })).not.toHaveProperty('cloudRegister');
  });
});
