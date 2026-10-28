import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { TEST_IDP, TEST_PACK_KEY } from '../support/api-harness';
import type { HttpRequest } from '../../services/kernel/src/index';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { GLOBAL_FOR } from '../../edge/store-edge/src/screen-data';
import { certificationsPackSection } from '../../services/api/src/r7d-workforce-adapters';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';
import { addDays } from '../../packages/workforce/src/working-time';

// Round 8 · R8-C — head office's side and the real store computer, in memory and (with DATABASE_URL) on real PostgreSQL,
// with cold restarts. Synthetic people only.
//   • OB-522 (M25-FR-03 · OB-502): a FoSTaC certificate is the same food-handling certificate. Only an EXPIRED certificate
//     blocks (owner, 28 Oct 2026 — a person with none on file is not blocked). A cook whose certificate expired stays
//     blocked when a FoSTaC renewal is recorded WITHOUT verifying it (no cover); the cook cannot verify their own; nobody can
//     verify in another's name; a manager who saw it verifies it (re-recording it in their own name) and the run goes through. It rides the signed
//     store pack, and the store computer, offline, lets the FoSTaC cook's food work through.
//   • OB-531 (M25-FR-01): the store computer puts its copy of head office's roster — with the gaps folded by the same engine —
//     on the manager's rostering screen, with when head office last sent it; with the cable out across a cold restart.

const backings = useRestartableBackings();
type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const TODAY = shopDateIn(new Date().toISOString());
const S1 = 'br-1';
const savedFetch = globalThis.fetch;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  globalThis.fetch = savedFetch;
  for (const c of cleanups.splice(0).reverse()) await c();
});
const IST = (day: string, hhmm: string): string => new Date(Date.parse(`${day}T${hhmm}:00+05:30`)).toISOString();

describe.each(backings)('OB-522 · OB-531 — on $name', ({ harness }) => {
  it('a FoSTaC certificate recorded, then verified by a manager who saw it, lets the cook\'s food work through; self- and proxy-verification refused; across a restart', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-kumar', 'store_manager');
    await h.provisionRole(T, 'u-clerk', 'cashier');
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    await ok(call('POST', '/v1/org/nodes/C1', 'u-owner', { kind: 'company', name: 'SRE Retail' }), 'company');
    await ok(call('POST', `/v1/org/nodes/${S1}`, 'u-owner', { kind: 'branch', name: 'Store 1', parentId: 'C1', companyId: 'C1' }), 'branch');
    await ok(call('POST', '/v1/production/departments/cafe', 'u-owner', {}), 'cafe');
    await ok(call('POST', '/v1/production/recipes/r-cake', 'u-owner', { departmentId: 'cafe', outputProductId: 'CAKE', outputQuantityMinor: 1, outputUom: 'ea', inputs: [{ productId: 'FLOUR', quantityMinor: 100, uom: 'g' }], shelfLifeHours: 48 }), 'recipe');
    await ok(call('POST', '/v1/inventory/movements', 'u-owner', { movementId: 'seed-flour', productId: 'FLOUR', locationId: S1, kind: 'received', quantityMinor: 5_000, uom: 'g', occurredAt: new Date(Date.now() - 86_400_000).toISOString(), enteredBy: 'u-owner' }), 'flour');
    await ok(call('POST', '/v1/hr/workforce/employees/u-kumar', 'u-mgr', { name: 'Kumar', branchId: S1, roles: ['cook'], active: true }), 'kumar');
    const runBody = (id: string) => ({ recipeId: 'r-cake', batches: 1, actualOutputMinor: 1, outputBatchId: `CAKE-${id}`, locationId: S1 });
    const fostac = { employeeId: 'u-kumar', kind: 'fostac', issuedOn: TODAY, validUntil: addDays(TODAY, 365) };

    // ── no certificate on file: NOT blocked (owner, 28 Oct 2026: only an expired certificate blocks) ──
    expect((await call('POST', '/v1/production/runs/run-0', 'u-kumar', runBody('0'))).status).toBe(201);
    // ── his verified food-handling certificate EXPIRED: blocked ──
    await ok(call('POST', '/v1/hr/workforce/certifications/CERT-OLD', 'u-mgr', { employeeId: 'u-kumar', kind: 'food-handling', issuedOn: '2025-01-01', validUntil: addDays(TODAY, -2), verifiedBy: 'u-mgr' }), 'expired');
    expect(codeOf(await call('POST', '/v1/production/runs/run-1', 'u-kumar', runBody('1')))).toBe('food_handling_certificate_expired');
    // ── the FoSTaC renewal recorded WITHOUT verifying (as the page does when "I have seen it" is not ticked): still no cover ──
    await ok(call('POST', '/v1/hr/workforce/certifications/CERT-K', 'u-mgr', fostac), 'recorded');
    expect(codeOf(await call('POST', '/v1/production/runs/run-1', 'u-kumar', runBody('1')))).toBe('food_handling_certificate_expired');
    // ── Kumar cannot verify his own; a manager cannot verify in another person's name; a cashier cannot record at all ──
    const self = await call('POST', '/v1/hr/workforce/certifications/CERT-K', 'u-kumar', { ...fostac, verifiedBy: 'u-kumar' });
    expect([self.status, codeOf(self)]).toEqual([422, 'self_verification']);
    const proxy = await call('POST', '/v1/hr/workforce/certifications/CERT-K', 'u-mgr', { ...fostac, verifiedBy: 'u-owner' });
    expect(proxy.status).toBeGreaterThanOrEqual(400);
    expect((await call('POST', '/v1/hr/workforce/certifications/CERT-K', 'u-clerk', { ...fostac, verifiedBy: 'u-clerk' })).status).toBe(403);
    expect(codeOf(await call('POST', '/v1/production/runs/run-1', 'u-kumar', runBody('1')))).toBe('food_handling_certificate_expired');

    h = harness(h); // ── COLD RESTART ──
    // ── the manager who saw it verifies it — the same certificate, re-recorded in her own name ──
    await ok(call('POST', '/v1/hr/workforce/certifications/CERT-K', 'u-mgr', { ...fostac, verifiedBy: 'u-mgr' }), 'verified');
    expect((await call('POST', '/v1/production/runs/run-1', 'u-kumar', runBody('1'))).status).toBe(201);

    h = harness(h); // ── COLD RESTART: the verified FoSTaC certificate is read back, and still counts ──
    const listed = ((await ok(call('GET', '/v1/hr/workforce/certifications', 'u-mgr'), 'list')).body as { certifications: { certificationId: string; kind: string; verifiedBy?: string }[] }).certifications;
    expect(listed).toEqual(expect.arrayContaining([expect.objectContaining({ certificationId: 'CERT-K', kind: 'fostac', verifiedBy: 'u-mgr' })]));
    expect((await call('POST', `/v1/production/weighed-runs/w-1`, 'u-kumar', { departmentId: 'meat_fish', inputs: [{ productId: 'CHICKEN', weightGrams: 2_000, costPerKg: { minor: 18_000, currency: 'INR' } }], outputs: [{ productId: 'CUTS', weightGrams: 1_900 }] })).status).toBe(201);
    // ── it rides the signed store pack as a food-handling certificate ──
    const section = await certificationsPackSection(h.store, () => new Date().toISOString(), T, S1);
    expect(section?.certifications).toEqual(expect.arrayContaining([expect.objectContaining({ certificationId: 'CERT-K', kind: 'fostac', verifiedBy: 'u-mgr' })]));
  }, 60_000);

  it('the store computer puts its copy of head office\'s roster on the manager\'s rostering screen, with its time — cable out, cold restart', async () => {
    const h = harness();
    const T = randomUUID();
    let n = 0;
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown) =>
      h.request({ method, path, userId, tenantId: T, ...(userId === 'u-mgr' || userId === 'u-box' ? { branchId: S1 } : {}), ...(method === 'GET' ? {} : { idempotencyKey: `ho-${n++}` }), ...(body === undefined ? {} : { body }) });
    const ok = async (p: Promise<Res>, what: string) => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-box', 'store_computer', [S1]);
    await h.provisionRole(T, 'u-mgr', 'store_manager', [S1]);
    await h.provisionRole(T, 'E-COOK', 'store_manager', [S1]);
    for (const [id, body] of [['C1', { kind: 'company', name: 'SRE Retail' }], [S1, { kind: 'branch', name: 'SRE Hyper Market', parentId: 'C1', companyId: 'C1' }]] as const) await ok(call('POST', `/v1/org/nodes/${id}`, 'u-owner', body), `org ${id}`);
    await ok(call('POST', `/v1/stores/${S1}/settings`, 'u-owner', { tradingDayCutoff: '02:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 5_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 15, warehouseId: S1 }), 'settings');
    for (const [id, name, roles] of [['E-RANI', 'Rani', ['cashier']], ['E-ASHA', 'Asha', ['cashier']], ['E-COOK', 'Kumar', ['cook']]] as const) {
      await ok(call('POST', `/v1/hr/workforce/employees/${id}`, 'u-mgr', { name, branchId: S1, roles, active: true }), `employee ${id}`);
    }
    const tomorrow = addDays(TODAY, 1);
    await ok(call('POST', '/v1/hr/workforce/shifts/SH-1', 'u-mgr', { branchId: S1, startsAt: IST(tomorrow, '06:00'), endsAt: IST(tomorrow, '14:00'), requiredRoles: [{ role: 'cashier', count: 2 }] }), 'shift');
    await ok(call('POST', '/v1/hr/workforce/shifts/SH-1/assignments/E-RANI', 'u-mgr', { role: 'cashier' }), 'assign');
    await ok(call('POST', '/v1/hr/workforce/certifications/C-COOK', 'u-mgr', { employeeId: 'E-COOK', kind: 'FoSTaC', issuedOn: TODAY, validUntil: addDays(TODAY, 365), verifiedBy: 'u-mgr' }), 'fostac');
    const liveGaps = ((await ok(call('GET', '/v1/hr/workforce/roster-gaps', 'u-mgr'), 'gaps')).body as { gaps: unknown[] }).gaps;

    const dir = await mkdtemp(join(tmpdir(), 'sre-r8c-box-'));
    cleanups.push(async () => { await rm(dir, { recursive: true, force: true }); });
    const net = { up: true };
    globalThis.fetch = (async (url: string, init: RequestInit = {}): Promise<Response> => {
      if (url.startsWith('http://127.0.0.1:')) return savedFetch(url, init);
      if (!net.up) throw new Error('ECONNREFUSED');
      const hdr = (init.headers ?? {}) as Record<string, string>;
      const u = new URL(url);
      const res = await h.raw({ method: (init.method ?? 'GET') as HttpRequest['method'], path: u.pathname, query: Object.fromEntries(u.searchParams), token: hdr['authorization']?.replace(/^Bearer /, ''), idempotencyKey: hdr['idempotency-key'], body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown });
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
    const screen = async (edge: EdgeProcess, path: string, global: string, user: string): Promise<Record<string, unknown>> => {
      const html = await (await savedFetch(`http://127.0.0.1:${edge.screens!.port}${path}`, { headers: { 'x-sre-user': user } })).text();
      const m = new RegExp(`<script>window\\.${global} = ([\\s\\S]*?);</script>`).exec(html);
      expect(m, html.slice(0, 300)).not.toBeNull();
      return JSON.parse(m![1]!) as Record<string, unknown>;
    };
    const first = await start();
    expect(await first.refreshStorePack!()).toMatchObject({ status: 'updated' });

    // ── THE CABLE IS CUT; COLD RESTART ──
    net.up = false;
    await first.stop(); cleanups.pop();
    const box = await start();
    const rostering = await screen(box, '/rostering/', GLOBAL_FOR.rostering, 'u-mgr');
    const copy = rostering['boxRoster'] as { storeId: string; asAt: string; employees: { employeeId: string; name: string }[]; shifts: { shiftId: string }[]; assignments: unknown[]; gaps: unknown[] };
    expect(copy.storeId).toBe(S1);
    expect(Date.parse(copy.asAt)).not.toBeNaN();
    expect(Date.now() - Date.parse(copy.asAt)).toBeLessThan(10 * 60_000);
    expect(copy.employees.map((e) => e.name).sort()).toEqual(['Asha', 'Kumar', 'Rani']);
    expect(copy.shifts.map((s) => s.shiftId)).toEqual(['SH-1']);
    expect(copy.gaps).toEqual(liveGaps); // the same engine head office's /roster-gaps runs
    expect(JSON.stringify(copy)).not.toMatch(/hourlyRate/);
    // ── OB-522 offline: the FoSTaC cook's food work is allowed on the box ──
    expect((await screen(box, '/production/', GLOBAL_FOR.production, 'E-COOK'))['foodHandling']).toMatchObject({ allowed: true });
  });
});
