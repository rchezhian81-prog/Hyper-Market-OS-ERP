import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ApiHarness } from '../support/api-harness';
import { TEST_IDP } from '../support/api-harness';
import { r3OpsBackings, tenantClient } from '../support/r3-ops-backings';
import { runOwnerSetup, type SetupClient } from '../../packages/migration/src/owner-steps-command';
import { buildOperatorToken, buildPersonToken } from '../../scripts/lib/operator-env';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';

/**
 * OB-257 (owner, 20 Oct 2026, "Owner setup commands") · W-3 — head office's own jobs, done on the store PC by the
 * owner's commands, each through the EXISTING route, as the person whose act it is, on the real API — in memory and on
 * PostgreSQL, with a COLD RESTART before everything is read back:
 *
 *   shop               → the company, the GST registration (legal name, GSTIN), the store, active
 *   store-settings     → the store's settings, a new version, set by the owner
 *   bill-prefix        → the till's prefix, issued by the owner (on the audit trail as the owner)
 *   grant              → asked by the store manager, approved by the owner (on the audit trail as each of them) — for the
 *                        cashier, and the store_computer role for the till's own store-edge sign-in at this store only
 *   publish-catalogue  → the signed pack, published by the owner
 *
 * The client mints each person's token exactly as scripts/owner-setup.ts does (only after their PIN matched): the API's
 * own step-up accepts it for the grant routes; a stand-in token with no PIN evidence is refused there (403). A cashier
 * cannot run a head-office job (403), and after the restart the store-edge sign-in reads the store's setup, which names
 * the cashier and their role — the till can sign them in.
 */

const backings = r3OpsBackings();
const OWNER = 'u-owner';
const MANAGER = 'u-manager';
const CASHIER = 'u-cashier';
const STORE = 'SRE-MAIN';
const GSTIN = '33AABCS1429B1Z1';

/** The shell's client, over the harness: the person's token minted at their PIN's moment, sent through the real pipeline. */
function personClient(get: () => ApiHarness): SetupClient {
  return {
    request: async (r) => get().raw({
      method: r.method, path: r.path, ...(r.body === undefined ? {} : { body: r.body }), ...(r.idempotencyKey === undefined ? {} : { idempotencyKey: r.idempotencyKey }),
      token: buildPersonToken({ sub: r.userId, tenantId: r.tenantId, ttlSeconds: 300, authTimeSec: Math.floor(Date.parse(r.signedInAt) / 1000) }, TEST_IDP.policy(), Date.now()),
    }),
  };
}

describe.each(backings)('the owner does head office\'s jobs on the store PC — on $name (OB-257)', ({ harness, restart }) => {
  it('every command reaches its route as the named person, and every record reads back after a cold restart', async () => {
    let h: ApiHarness = harness();
    const T = randomUUID();
    await h.seedOwner(T, OWNER);
    await h.provisionRole(T, MANAGER, 'store_manager'); // laid down with the owner by tenant:bootstrap
    // OB-288 P1 (M01-FR-01): the person who sets the shop up (platform administration) asks; the owner approves the activation.
    await h.provisionRole(T, 'u-it', 'platform_admin');
    const client = personClient(() => h);
    const deps = { client, confirm: async () => true, askPin: async () => '123456', verifyPin: () => 'ok' as const };
    const run = (step: string, values: Record<string, string>) => runOwnerSetup({ step, tenantId: T, targetKind: 'rehearsal', demoTenantIds: ['pilot-demo'], values, today: shopDateIn(new Date().toISOString()), now: () => new Date().toISOString() }, deps);
    const expectDone = async (p: ReturnType<typeof run>): Promise<void> => { const o = await p; expect(o.exitCode, o.lines.join('\n')).toBe(0); };

    await expectDone(run('shop', { as: 'u-it', approver: OWNER, company: 'SRE', 'legal-name': 'SRE Hyper Market Private Limited', gstin: GSTIN, store: STORE, 'store-name': 'SRE Hyper Market' }));
    await expectDone(run('store-settings', { as: OWNER, store: STORE, cutoff: '00:00', 'stale-after-minutes': '15', 'count-approval-rupees': '0', 'handover-tolerance-rupees': '0', 'cash-variance-rupees': '0' }));
    await expectDone(run('bill-prefix', { as: OWNER, store: STORE, till: 'lane-1', prefix: 'S1L1-', reason: 'mirror pilot till' }));
    await expectDone(run('grant', { as: MANAGER, approver: OWNER, person: CASHIER, role: 'cashier', store: STORE, reason: 'pilot cashier' }));
    await expectDone(run('grant', { as: MANAGER, approver: OWNER, person: 'store-edge', role: 'store_computer', store: STORE, reason: 'the till on the store PC' }));

    // A product to publish (head office's catalogue routes, as the owner — what the department slice will load).
    const { req, ok } = tenantClient(() => h, T);
    await ok(req('POST', '/v1/catalogue/tax-classes/1006/rates/2017-07-01', { rateBps: 500 }), 'tax rate');
    await ok(req('POST', '/v1/catalogue/products/p-rice/publish', { product: { sku: 'RICE-5KG', name: 'Ponni rice 5kg', baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '1006', lifecycle: 'active' }, categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }] }), 'product');
    await ok(req('POST', '/v1/prices/list/p-rice/entries/e1', { scope: 'store', scopeRef: STORE, priceMinor: 48_000, mrpMinor: 50_000, costMinor: 40_000, marginFloorBps: 0, currency: 'INR', effectiveFrom: shopDateIn(new Date().toISOString()) }), 'price');
    await expectDone(run('publish-catalogue', { as: OWNER, store: STORE }));

    // A cashier cannot do head office's jobs; a stand-in token with no PIN evidence cannot grant.
    const cashier = await run('bill-prefix', { as: CASHIER, store: STORE, till: 'lane-2', prefix: 'S1L2-' });
    expect(cashier.exitCode).toBe(1);
    expect(cashier.lines.join('\n')).toMatch(/NOT DONE — head office refused: (forbidden|HTTP 403)/);
    const noPin = await h.raw({ method: 'POST', path: '/v1/identity/grants', idempotencyKey: `k-${randomUUID()}`, token: buildOperatorToken({ sub: MANAGER, tenantId: T, ttlSeconds: 300 }, TEST_IDP.policy(), Date.now()), body: { grantId: 'g-x', userId: 'u-x', roleId: 'cashier', branchScope: [STORE] } });
    expect(noPin.status).toBe(403);
    expect((noPin.body as { error: { code: string } }).error.code).toBe('reauthentication_required');

    h = restart(h); // ── COLD RESTART ───────────────────────────────────────────────────────────────────────────
    const get = async (path: string, userId = OWNER, query?: Record<string, string>) => { const r = await h.request({ method: 'GET', path, userId, tenantId: T, ...(query === undefined ? {} : { query }) }); expect(r.status, `${path}: ${JSON.stringify(r.body)}`).toBe(200); return r.body as Record<string, unknown>; };

    expect(await get(`/v1/org/nodes/${STORE}`)).toMatchObject({ node: { status: 'active', kind: 'branch', name: 'SRE Hyper Market' }, filedUnderGstin: GSTIN, ancestry: [STORE, 'SRE'] });
    expect(await get(`/v1/stores/${STORE}/settings`)).toMatchObject({ settings: { tradingDayCutoff: '00:00', staleAfterSeconds: 900, privacySlaDays: 15, setBy: OWNER } });
    const prefixes = (await get('/v1/receipt-prefixes')) as { tills?: { tillId: string; prefix: string; setBy: string }[] };
    expect(prefixes.tills?.find((t) => t.tillId === 'lane-1')).toMatchObject({ prefix: 'S1L1-', setBy: OWNER });
    expect(((await get('/v1/catalogue/pack')) as { publishedBy: string }).publishedBy).toBe(OWNER);

    // The audit trail names each person for their own act.
    const trail = async (query: Record<string, string>) => ((await get('/v1/audit/trail', OWNER, query)) as { matches: { actorId: string; action: string; objectId: string }[] }).matches;
    expect((await trail({ action: 'role.grant.request' })).map((m) => [m.actorId, m.objectId]).sort()).toEqual([[MANAGER, 'store-edge'], [MANAGER, CASHIER]]);
    expect((await trail({ action: 'role.grant' })).map((m) => [m.actorId, m.objectId]).sort()).toEqual([[OWNER, 'store-edge'], [OWNER, CASHIER]]);
    expect((await trail({ action: 'receipt.prefix.issue' })).map((m) => m.actorId)).toEqual([OWNER]);

    // The till's own sign-in reads the store's setup: the cashier, their role, the till's prefix.
    const pack = await h.request({ method: 'GET', path: `/v1/store-packs/${STORE}`, userId: 'store-edge', tenantId: T, branchId: STORE });
    expect(pack.status, JSON.stringify(pack.body)).toBe(200);
    const sections = JSON.stringify(pack.body);
    expect(sections).toContain(`"userId":"${CASHIER}"`);
    expect(sections).toContain('"prefix":"S1L1-"');
  }, 120_000);
});
