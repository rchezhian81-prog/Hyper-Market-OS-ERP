import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TEST_IDP, TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import { useBackings } from '../support/backings';
import type { HttpRequest } from '../../services/kernel/src/index';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { GLOBAL_FOR } from '../../edge/store-edge/src/screen-data';
import { makeEvent, type DomainEvent } from '../../packages/contracts/src/event';
import type { BoxItemStatus, DeviceAck } from '../../packages/sync/src/device-relay';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';
import { addDays, rosterWeekStartOf } from '../../packages/workforce/src/working-time';

/**
 * **Round 7 · OB-507 and OB-502 — THE PROOF on the REAL store computer (`startEdge`) and the REAL head office (the API
 * harness behind a fetch this test cuts and makes lose a reply), in memory and — with DATABASE_URL — on real PostgreSQL.**
 *
 * M25-FR-01 "rosters/attendance cache, sync on reconnect":
 *   • head office's COMMITTED roster (published week) and its people's food-handling certificates ride the SIGNED store
 *     pack; with the cable OUT and after a COLD RESTART the self-service page still shows Rani her own shifts (and only a
 *     published week), saying how old the copy is;
 *   • her clock-in and clock-out are kept on the box (fsync'd, through another cold restart), sent ONCE when the line
 *     returns (a lost reply settles to one); a re-sent mark is "duplicate";
 *   • a CONFLICT — a different mark under the same mark id — is refused at head office by name and kept on the box,
 *     visible (hard rule #10); a second "in" is booked and FLAGGED as an exception, never silently fixed.
 * M25-FR-03 · OB-502 "an expired certification blocks the gated task":
 *   • on the box, offline, a production run in the name of a cook whose food-handling certificate EXPIRED is refused before
 *     the disk in plain words naming the certificate and its expiry; a cook with a valid certificate is kept; a cook with NO
 *     certificate on file is kept too (owner, 28 Oct 2026: only an expired certificate blocks); the production screen is
 *     told the signed-in cook's verdict.
 */

const S1 = 'S1';
const KITCHEN = 'S1-KITCHEN';
type Body = Record<string, unknown>;
const cleanups: Array<() => Promise<void>> = [];
const savedFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = savedFetch;
  for (const c of cleanups.splice(0).reverse()) await c();
});
const SETTINGS = { tradingDayCutoff: '02:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 5_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 15, warehouseId: S1 };
const IST = (day: string, hhmm: string): string => new Date(Date.parse(`${day}T${hhmm}:00+05:30`)).toISOString();

async function cloudAndBox(harness: () => ApiHarness) {
  const h = harness();
  const T = randomUUID();
  let n = 0;
  const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, query?: Record<string, string>) =>
    h.request({ method, path, userId, tenantId: T, ...(userId === 'u-mgr' || userId === 'u-box' ? { branchId: S1 } : {}), ...(method === 'GET' ? {} : { idempotencyKey: `ho-${n++}` }), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
  const ok = async (p: Promise<{ status: number; body: unknown }>, what: string) => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
  await h.seedOwner(T, 'u-owner');
  await h.provisionRole(T, 'u-box', 'store_computer', [S1]);
  await h.provisionRole(T, 'u-mgr', 'store_manager', [S1]);
  await h.provisionRole(T, 'E-RANI', 'cashier', [S1]);
  await h.provisionRole(T, 'E-COOK', 'store_manager', [S1]);
  await h.provisionRole(T, 'E-OK', 'store_manager', [S1]);
  await h.provisionRole(T, 'E-NEW', 'store_manager', [S1]);
  for (const [id, body] of [['C1', { kind: 'company', name: 'SRE Retail' }], [S1, { kind: 'branch', name: 'SRE Hyper Market', parentId: 'C1', companyId: 'C1' }], [KITCHEN, { kind: 'department', name: 'Cafe kitchen', parentId: S1, companyId: 'C1' }]] as const) {
    await ok(call('POST', `/v1/org/nodes/${id}`, 'u-owner', body), `org ${id}`);
  }
  await ok(call('POST', `/v1/stores/${S1}/settings`, 'u-owner', SETTINGS), 'settings');
  // The roster: Rani on two shifts of NEXT week, which the manager publishes; one shift of the week after (not published).
  const today = shopDateIn(new Date().toISOString());
  const week = addDays(rosterWeekStartOf(today), 7);
  for (const [id, name, roles] of [['E-RANI', 'Rani', ['cashier']], ['E-COOK', 'Kumar', ['cook']], ['E-OK', 'Selvi', ['cook']], ['E-NEW', 'Devi', ['cook']]] as const) {
    await ok(call('POST', `/v1/hr/workforce/employees/${id}`, 'u-mgr', { name, branchId: S1, roles, active: true }), `employee ${id}`);
  }
  const shifts = [['SH-1', addDays(week, 1)], ['SH-2', addDays(week, 2)], ['SH-9', addDays(week, 8)]] as const;
  for (const [id, day] of shifts) {
    await ok(call('POST', `/v1/hr/workforce/shifts/${id}`, 'u-mgr', { branchId: S1, startsAt: IST(day, '06:00'), endsAt: IST(day, '14:00'), requiredRoles: [{ role: 'cashier', count: 1 }] }), `shift ${id}`);
    await ok(call('POST', `/v1/hr/workforce/shifts/${id}/assignments/E-RANI`, 'u-mgr', { role: 'cashier' }), `assign ${id}`);
  }
  await ok(call('POST', '/v1/hr/compliance/roster-publications/P-1', 'u-mgr', { branchId: S1, weekStart: week }), 'publish next week');
  // Certificates: Kumar's EXPIRED yesterday; Selvi's is valid. Each verified by the manager who saw it. Devi has none on file.
  await ok(call('POST', '/v1/hr/workforce/certifications/C-COOK', 'u-mgr', { employeeId: 'E-COOK', kind: 'Food handling', issuedOn: '2025-01-01', validUntil: addDays(today, -1), verifiedBy: 'u-mgr' }), 'cert cook');
  await ok(call('POST', '/v1/hr/workforce/certifications/C-OK', 'u-mgr', { employeeId: 'E-OK', kind: 'food-handling', issuedOn: '2026-01-01', validUntil: addDays(today, 200), verifiedBy: 'u-mgr' }), 'cert ok');

  const dir = await mkdtemp(join(tmpdir(), 'sre-r7d-box-'));
  cleanups.push(async () => { await rm(dir, { recursive: true, force: true }); });
  const net = { up: true, loseNext: false, posts: 0 };
  globalThis.fetch = (async (url: string, init: RequestInit = {}): Promise<Response> => {
    if (url.startsWith('http://127.0.0.1:')) return savedFetch(url, init);
    if (!net.up) throw new Error('ECONNREFUSED');
    const hdr = (init.headers ?? {}) as Record<string, string>;
    const u = new URL(url);
    if ((init.method ?? 'GET') === 'POST') net.posts += 1;
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
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: T, PACK_SIGNING_KEY: TEST_PACK_KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
      EDGE_SCREEN_TRUST_FORWARDED_USER: '1', EDGE_STORE_PACK_SOURCE: 'head-office', EDGE_STORE_ID: S1,
      CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box', tenantId: T, branchId: S1 }),
    }, () => {}))!;
    cleanups.push(async () => { await edge.stop(); });
    return edge;
  };
  return { h, T, call, ok, net, start, week, today };
}

const hand = async (edge: EdgeProcess, events: readonly DomainEvent[]): Promise<DeviceAck[]> => {
  const res = await savedFetch(`http://127.0.0.1:${edge.lane!.port}/lane/outbox`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:8091' },
    body: JSON.stringify({ source: 'manager', items: events.map((e) => ({ key: e.idempotencyKey, event: e })) }),
  });
  return ((await res.json()) as { acks: DeviceAck[] }).acks;
};
const statusOf = async (edge: EdgeProcess, keys: readonly string[]): Promise<BoxItemStatus[]> =>
  ((await (await savedFetch(`http://127.0.0.1:${edge.lane!.port}/lane/outbox/status?keys=${encodeURIComponent(keys.join(','))}`)).json()) as { items: BoxItemStatus[] }).items;
const screen = async (edge: EdgeProcess, path: string, global: string, user: string): Promise<Body> => {
  const html = await (await savedFetch(`http://127.0.0.1:${edge.screens!.port}${path}`, { headers: { 'x-sre-user': user } })).text();
  const m = new RegExp(`<script>window\\.${global} = ([\\s\\S]*?);</script>`).exec(html);
  expect(m, html.slice(0, 300)).not.toBeNull();
  return JSON.parse(m![1]!) as Body;
};
const mark = (markId: string, kind: 'in' | 'out', at: string, key = `attendance:${markId}`, employeeId = 'E-RANI'): DomainEvent =>
  makeEvent({ id: key, type: 'AttendanceMarked', occurredAt: at, idempotencyKey: key, source: 'web-erp/ess', payload: { markId, employeeId, kind, method: 'pin', at, storeId: S1, source: 'self-service-screen' } });
const run = (runId: string, producedBy: string, at: string): DomainEvent =>
  makeEvent({ id: `run:${runId}`, type: 'ProductionRunCaptured', occurredAt: at, idempotencyKey: `run:${runId}`, source: 'web-erp/production', payload: { runId, storeId: S1, recipeId: 'r-cake', batches: 1, actualOutputMinor: 1, outputBatchId: `CAKE-${runId}`, locationId: KITCHEN, producedBy, at, source: 'production-screen' } });

const backings = useBackings();

describe.each(backings)('OB-507 · OB-502: the roster and the certificates ride the signed pack; attendance is kept on the box and sent once — head office on $name', ({ harness }) => {
  it('my shifts with the cable out across a cold restart; marks kept and sent once; a conflict refused and kept; a lapsed certificate refused at the box', async () => {
    const c = await cloudAndBox(harness);
    const first = await c.start();
    expect(await first.refreshStorePack!()).toMatchObject({ status: 'updated' });

    // ── THE CABLE IS CUT; COLD RESTART ──
    c.net.up = false;
    await first.stop(); cleanups.pop();
    const box = await c.start();
    const ess = await screen(box, '/ess/', GLOBAL_FOR.ess, 'E-RANI');
    const mine = ess['myRoster'] as { known: boolean; active: boolean; shifts: { shiftId: string; role: string }[]; notYetPublished: number; asAt: string; weeks: { weekStart: string; limitsNotChecked: string[] }[] };
    expect(mine).toMatchObject({ known: true, active: true, notYetPublished: 1 });
    expect(mine.shifts.map((s) => [s.shiftId, s.role])).toEqual([['SH-1', 'cashier'], ['SH-2', 'cashier']]); // the unpublished week is held back
    expect(mine.weeks.map((w) => w.weekStart)).toEqual([c.week]);
    expect(mine.weeks[0]!.limitsNotChecked.length).toBeGreaterThan(0); // OB-155: the limits not checked travel with the week
    expect(Date.parse(mine.asAt)).not.toBeNaN();
    // Another person sees their own (none), never Rani's.
    expect((await screen(box, '/ess/', GLOBAL_FOR.ess, 'E-OK'))['myRoster']).toMatchObject({ known: true, shifts: [] });

    // ── attendance marked on the box with the line down ──
    const inAt = new Date(Date.now() - 4 * 3_600_000).toISOString();
    const outAt = new Date(Date.now() - 60_000).toISOString();
    const keys = ['attendance:M-1', 'attendance:M-2'];
    expect((await hand(box, [mark('M-1', 'in', inAt), mark('M-2', 'out', outAt)])).map((a) => a.status)).toEqual(['accepted', 'accepted']);
    // A second device's copy naming the SAME mark id with different facts — a conflict head office must refuse by name.
    const conflict = mark('M-1', 'out', outAt, 'attendance:M-1-from-another-screen');
    // A second "in" with no "out" between — booked, but flagged.
    const twice = mark('M-3', 'in', new Date(Date.now() - 3 * 3_600_000).toISOString());
    expect((await hand(box, [conflict, twice])).map((a) => a.status)).toEqual(['accepted', 'accepted']);
    expect((await box.syncOnce!()).sent).toBe(0);
    expect(c.net.posts).toBe(0);

    // ── OB-502 at the box's door, offline: Kumar's certificate expired; Selvi's is valid; Devi has none on file ──
    const refused = (await hand(box, [run('R-K', 'E-COOK', outAt)]))[0]!;
    expect(refused.status).toBe('refused');
    expect(refused.reason).toContain('food_handling_certificate_expired');
    expect(refused.reason).toContain(`expired on ${addDays(c.today, -1)}`);
    expect(refused.reason).toContain('Kumar');
    expect(refused.reason).toMatch(/[஀-௿]/); // and in Tamil
    expect((await hand(box, [run('R-S', 'E-OK', outAt)]))[0]!.status).toBe('accepted');
    // No certificate on file is NOT a block (only an expired one is): Devi's run is kept, offline.
    expect((await hand(box, [run('R-D', 'E-NEW', outAt)]))[0]!.status).toBe('accepted');
    // The production screen is told the signed-in cook's verdict, in words.
    expect((await screen(box, '/production/', GLOBAL_FOR.production, 'E-COOK'))['foodHandling']).toMatchObject({ allowed: false, code: 'food_handling_certificate_expired', expiredOn: addDays(c.today, -1) });
    expect((await screen(box, '/production/', GLOBAL_FOR.production, 'E-OK'))['foodHandling']).toMatchObject({ allowed: true });
    expect((await screen(box, '/production/', GLOBAL_FOR.production, 'E-NEW'))['foodHandling']).toMatchObject({ allowed: true, noCertificateOnFile: true });

    // ── COLD RESTART, still offline: nothing lost; a re-sent mark is the same mark ──
    await box.stop(); cleanups.pop();
    const again = await c.start();
    expect((await statusOf(again, keys)).map((s) => s.state)).toEqual(['pending', 'pending']);
    expect((await hand(again, [mark('M-1', 'in', inAt)]))[0]!.status).toBe('duplicate');
    expect((await hand(again, [run('R-K', 'E-COOK', outAt)]))[0]!.status).toBe('refused'); // still refused after the restart

    // ── the line is back; one reply is lost; the next passes settle each mark to ONE ──
    c.net.up = true;
    c.net.loseNext = true;
    await again.syncOnce!();
    for (let i = 0; i < 3; i += 1) await again.syncOnce!();
    const [m1, m2] = await statusOf(again, keys);
    expect([m1?.state, m2?.state]).toEqual(['posted', 'posted']);
    const [cf, tw] = await statusOf(again, ['attendance:M-1-from-another-screen', 'attendance:M-3']);
    expect(cf).toMatchObject({ state: 'refused' });
    expect(cf?.reason).toContain('mark_conflicts_with_record');
    expect(tw?.state).toBe('posted');
    const day = shopDateIn(inAt);
    const booked = (await c.ok(c.call('GET', '/v1/hr/workforce/attendance-marks', 'u-mgr', undefined, { date: day }), 'marks')).body as { marks: { markId: string; kind: string; recordedBy: string; relayed?: { relayedBy: string }; exceptions?: string[] }[]; withExceptions: number };
    const rani = booked.marks.filter((m) => ['M-1', 'M-2', 'M-3'].includes(m.markId));
    expect(rani.map((m) => m.markId).sort()).toEqual(day === shopDateIn(outAt) ? ['M-1', 'M-2', 'M-3'] : ['M-1', 'M-3']); // each ONCE
    expect(rani.find((m) => m.markId === 'M-1')).toMatchObject({ kind: 'in', recordedBy: 'E-RANI', relayed: { relayedBy: 'u-box' } });
    expect(rani.find((m) => m.markId === 'M-3')?.exceptions).toEqual(['repeats_the_last_mark']);
    expect(booked.withExceptions).toBeGreaterThanOrEqual(1);

    // Another restart after posting: nothing sent twice; the refusal is kept, visible.
    await again.stop(); cleanups.pop();
    const third = await c.start();
    await third.syncOnce!();
    expect((await statusOf(third, [...keys, 'attendance:M-1-from-another-screen'])).map((s) => s.state)).toEqual(['posted', 'posted', 'refused']);
    const recount = ((await c.call('GET', '/v1/hr/workforce/attendance-marks', 'u-mgr', undefined, { date: day })).body as { marks: { markId: string }[] }).marks.filter((m) => m.markId === 'M-1');
    expect(recount).toHaveLength(1);
  }, 120_000);
});
