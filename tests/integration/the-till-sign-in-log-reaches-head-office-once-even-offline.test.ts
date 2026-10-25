import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TEST_IDP, type ApiHarness } from '../support/api-harness';
import { useRestartableBackings } from '../support/p3-backings';
import { prepareTillBox, signInAtLane, pinOf } from '../support/till-operator';
import type { HttpRequest } from '../../services/kernel/src/index';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { STREAM, streamName } from '../../services/api/src/adapters';
import { wallClockIn } from '../../packages/calendar/src/index';

// OB-365 (owner, 24–25 Oct 2026, in writing): "the store computer sends its till sign-in log to head office so after-hours
// and failed-sign-in alerts work." THE PROOF, through the REAL store box (`startEdge`) and the REAL head office (the API
// harness behind a `fetch` this test can cut and make lose a reply), in memory and on PostgreSQL with a cold restart:
//   • with the line DOWN a cashier signs in, another person keys wrong PINs until the staff ID locks — every one is checked
//     on the box, offline, and the sign-in never waits for head office; nothing is sent;
//   • a cold restart of the box, still offline, loses nothing and queues nothing twice;
//   • the line comes back, a reply is lost: head office holds each record ONCE — and never a PIN, a PIN's hash or the
//     session token's hash;
//   • the owner's after-hours and failed-sign-in alerts, which used to say they could not fire, now fire from it; the
//     security report counts the failed sign-ins and the lockout; a cold restart of head office reads it all the same.
// Synthetic data only (hard rule #7); every PIN is made at run time.

const S1 = 'S1';
const KEY = ['ob365', 'box', 'edge', 'signing', 'key'].join('-').padEnd(48, '0');
const cleanups: Array<() => Promise<void>> = [];
const savedFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = savedFetch;
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface Entry { entryId: string; kind: string; person: string; reason?: string; laneId: string | null }

const backings = useRestartableBackings();

describe.each(backings)('the till sign-in log reaches head office once, even offline (OB-365) — head office on $name', ({ harness }) => {
  it('signed in and refused offline → kept on the box across a restart → sent once (a lost reply) → the owner\'s alerts fire; no PIN, no hash', async () => {
    let h: ApiHarness = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-box', 'store_computer', [S1]);
    let n = 0;
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, query?: Record<string, string>) =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `ho-${n++}` }), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    for (const [id, body] of [['C1', { kind: 'company', name: 'SRE Retail' }], [S1, { kind: 'branch', name: 'Store 1', parentId: 'C1', companyId: 'C1' }]] as const) {
      expect((await call('POST', `/v1/org/nodes/${id}`, 'u-owner', body)).status).toBe(201);
    }
    // Before any record arrives, the alerts say they cannot be judged — never "none".
    const before = (await call('GET', '/v1/reporting/owner-alert-thresholds', 'u-owner')).body as { thresholds: { kind: string; canFire: boolean }[] };
    expect(before.thresholds.map((t) => t.kind)).toContain('failed_sign_in');

    const dir = await mkdtemp(join(tmpdir(), 'sre-ob365-box-'));
    cleanups.push(async () => { await rm(dir, { recursive: true, force: true }); });
    const env = await prepareTillBox({ dir, key: KEY, people: [{ userId: 'u-lanecash', displayName: 'Lane Cashier' }, { userId: 'u-guess' }], pack: { lossPreventionRules: [], policies: { tradingDayCutoff: '02:00', storeId: S1, branchId: S1 } } });
    const net = { up: false, loseNext: false, posts: 0 };
    const bodies: string[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit = {}): Promise<Response> => {
      if (url.startsWith('http://127.0.0.1:')) return savedFetch(url, init);
      if (!net.up) throw new Error('ECONNREFUSED');
      const hdr = (init.headers ?? {}) as Record<string, string>;
      const u = new URL(url);
      if ((init.method ?? 'GET') === 'POST') { net.posts += 1; bodies.push(String(init.body ?? '')); }
      const res = await h.raw({
        method: (init.method ?? 'GET') as HttpRequest['method'], path: u.pathname, query: Object.fromEntries(u.searchParams),
        token: hdr['authorization']?.replace(/^Bearer /, ''), idempotencyKey: hdr['idempotency-key'],
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
      });
      if (net.loseNext) { net.loseNext = false; throw new Error('ECONNRESET'); } // head office acted; the reply never came
      return new Response(JSON.stringify(res.body), { status: res.status, headers: { date: new Date().toUTCString() } });
    }) as unknown as typeof globalThis.fetch;
    const start = async (): Promise<EdgeProcess> => {
      const edge = (await startEdge({
        EDGE_DATA_DIR: dir, EDGE_TENANT_ID: T, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
        CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box', tenantId: T, branchId: S1 }), ...env,
      }, () => {}))!;
      cleanups.push(async () => { await edge.stop(); });
      return edge;
    };
    const wrongPin = (staffId: string): string => String((Number(pinOf(staffId)) + 1) % 1_000_000).padStart(6, '1');
    const tryAt = async (edge: EdgeProcess, staffId: string, pin: string) => (await (await savedFetch(`http://127.0.0.1:${edge.lane!.port}/lane/operator/sign-in`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ staffId, pin }),
    })).json()) as { signedIn: boolean; refusedBecause?: string };

    // ── The line is DOWN. A cashier signs in; u-guess keys five wrong PINs (locked), then one more (refused: locked). ──
    const box = await start();
    const startedAt = Date.now();
    await signInAtLane(box.lane!.port, 'u-lanecash');
    expect(Date.now() - startedAt, 'the sign-in never waits for head office').toBeLessThan(5_000);
    for (let i = 0; i < 5; i += 1) expect((await tryAt(box, 'u-guess', wrongPin('u-guess'))).refusedBecause).toBe('wrong_staff_id_or_pin');
    expect((await tryAt(box, 'u-guess', pinOf('u-guess'))).refusedBecause, 'locked, even with the right PIN').toBe('locked');
    expect((await box.syncOnce!()).sent).toBe(0);
    expect(net.posts).toBe(0);

    // ── Cold restart, still offline: nothing lost, nothing queued twice. ──
    await box.stop(); cleanups.pop();
    const again = await start();
    expect((await again.syncOnce!()).sent).toBe(0);
    expect(net.posts).toBe(0);

    // ── The line is back; the first reply is lost; the next passes settle every record ONCE. ──
    net.up = true;
    net.loseNext = true;
    for (let i = 0; i < 6; i += 1) await again.syncOnce!();
    const day = wallClockIn(new Date().toISOString(), 'Asia/Kolkata').slice(0, 10);
    const read = async () => (await call('GET', '/v1/identity/till-sign-ins', 'u-owner', undefined)).body as { day: string; entries: Entry[]; counts: { signIns: number; failed: number; lockouts: number }; received: boolean };
    const log = await read();
    expect(log.received).toBe(true);
    const shape = log.entries.map((e) => `${e.kind}:${e.person}${e.reason === undefined ? '' : `:${e.reason}`}`);
    expect(shape).toEqual([
      'signed_in:u-lanecash',
      ...Array.from({ length: 5 }, () => 'refused:u-guess:wrong_staff_id_or_pin'),
      'refused:u-guess:locked',
    ]);
    expect(new Set(log.entries.map((e) => e.entryId)).size, 'each record once').toBe(7);
    expect(log.entries.every((e) => e.laneId === 'lane-1')).toBe(true);
    expect(log.counts).toEqual({ signIns: 1, failed: 6, lockouts: 1 });
    // Never a PIN, a PIN's hash or the token's hash — not in what was sent, not in what head office keeps.
    const kept = JSON.stringify((await h.store.readStream(T, streamName(STREAM.identity, 'till-sign-ins'))).map((e) => e.event.payload));
    const sent = bodies.filter((b) => b.includes('till-sign-in') || b.includes('"entryId"')).join('\n');
    expect(sent.length).toBeGreaterThan(0);
    for (const text of [kept, sent]) {
      expect(text).not.toMatch(/tokenHash|verifier|salt|"pin":/i);
      for (const who of ['u-lanecash', 'u-guess']) expect(text).not.toContain(pinOf(who));
    }
    // Sent once: another pass sends nothing more.
    const postsBefore = net.posts;
    await again.syncOnce!();
    expect(net.posts).toBe(postsBefore);

    // ── The owner's alerts now fire from it: three failed sign-ins in a day, and trading hours that exclude now. ──
    const hour = Number(wallClockIn(new Date().toISOString(), 'Asia/Kolkata').slice(11, 13));
    const hours = hour <= 22 ? { opensAtHour: hour + 1, closesAtHour: 24 } : { opensAtHour: 0, closesAtHour: 23 };
    expect((await call('POST', '/v1/reporting/owner-alert-thresholds/failed_sign_in', 'u-owner', { value: 3 })).status).toBe(201);
    expect((await call('POST', '/v1/reporting/owner-alert-thresholds/after_hours_login', 'u-owner', { value: hours })).status).toBe(201);
    const board = (await call('GET', '/v1/reporting/owner-alert-thresholds', 'u-owner')).body as { thresholds: { kind: string; canFire: boolean; whyNot?: string }[] };
    expect(board.thresholds.filter((t) => t.kind === 'after_hours_login' || t.kind === 'failed_sign_in').map((t) => [t.kind, t.canFire])).toEqual([['after_hours_login', true], ['failed_sign_in', true]]);
    const today = (await call('GET', '/v1/reporting/owner-exceptions', 'u-owner', undefined, { day })).body as { alerts: { kind: string; severity: string; actorId: string; headline: string; count: number }[] };
    const failed = today.alerts.find((a) => a.kind === 'failed_sign_in');
    expect(failed).toMatchObject({ actorId: 'u-guess', severity: 'urgent', count: 6 });
    expect(failed!.headline).toContain('locked out');
    expect(today.alerts.find((a) => a.kind === 'after_hours_login')).toMatchObject({ actorId: 'u-lanecash', severity: 'urgent' });
    // The worker's pass raises them into the owner's inbox — once.
    const raised = (await call('POST', '/v1/reporting/owner-exceptions/raise', 'u-owner', {})).body as { raised: number };
    expect(raised.raised).toBeGreaterThanOrEqual(2);
    expect(((await call('POST', '/v1/reporting/owner-exceptions/raise', 'u-owner', {})).body as { raised: number }).raised).toBe(0);

    // ── The security report counts them (P-08: no longer "not known"). ──
    const securityRes = await call('GET', '/v1/reports/security', 'u-owner', undefined, { day });
    expect(securityRes.status, JSON.stringify(securityRes.body)).toBe(200);
    const security = securityRes.body as { figures: { name: string; valueMinor?: number; notAvailableBecause?: string }[] };
    const fig = (name: string) => security.figures.find((f) => f.name === name);
    expect(fig('Failed sign-ins')).toMatchObject({ valueMinor: 6 });
    expect(fig('Sign-in lockouts')).toMatchObject({ valueMinor: 1 });

    // ── A cold restart of head office reads the same log. ──
    h = harness(h);
    expect((await read()).counts).toEqual({ signIns: 1, failed: 6, lockouts: 1 });
    // A record carrying anything like a PIN or a hash is refused by name, and nothing is kept.
    const bad = await h.request({ method: 'POST', path: '/v1/identity/till-sign-ins/tsl-x/synced', userId: 'u-box', tenantId: T, branchId: S1, idempotencyKey: 'bad-1', body: { entryId: 'tsl-x', kind: 'signed_in', at: new Date().toISOString(), laneId: 'lane-1', person: 'u-lanecash', via: 'pin', tokenHash: 'ab'.repeat(32) } });
    expect(bad.status).toBe(400);
    expect((bad.body as { error: { code: string } }).error.code).toBe('secret_in_sign_in_record');
    expect((await call('POST', '/v1/identity/till-sign-ins/tsl-z/synced', 'u-cash-none', { entryId: 'tsl-z', kind: 'signed_in', at: new Date().toISOString(), laneId: 'lane-1', person: 'x', via: 'pin' })).status).toBe(403);
  }, 120_000);
});
