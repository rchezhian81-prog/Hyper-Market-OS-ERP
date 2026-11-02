import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';

/**
 * **OB-676 "A" (owner, 2 Nov 2026, in writing) — three values that were written in code become the owner's, on the real
 * head-office API (in memory and, with DATABASE_URL, on real PostgreSQL):**
 *
 *   1. the driver cash hand-over limit (M19-FR-04): today's figure is offered as the starting suggestion and reads "not
 *      confirmed"; the owner's confirmation is recorded and audited; another figure is a NEW store-settings version (the
 *      older kept); the signed store pack carries the confirmation to the store computer (and so the phone) — and stops
 *      carrying it the moment someone else changes the figure;
 *   2. which roles staff each delivery-exception queue (M19-FR-01 · Item 2): the code's map is the suggestion, "not
 *      confirmed"; the owner sets the roles per queue — a role that may not work exceptions is refused; a queue left with
 *      no role is UNOWNED on the worklist, never dropped; only the owner may set it;
 *   3. the concessionaire's own login (M27-FR-02 "only the concessionaire accesses it"): invited by one person who manages
 *      concessions, approved by a DIFFERENT one (the outside-party flow), it reads ONLY its own counter's terms, sales, stock
 *      and invoices — another concessionaire's is refused and recorded; it holds no staff authority; revoked, it reads
 *      nothing.
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

const backings: { name: string; harness: () => ApiHarness }[] = [{ name: 'the in-memory event store', harness: () => apiHarness() }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });

type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const SETTINGS = { tradingDayCutoff: '02:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 15, warehouseId: 'BR1' };
const day = (offset: number): string => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);

describe.each(backings)('OB-676 — three values the owner confirms on screen — on $name', ({ harness }) => {
  const setUp = async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-acct', 'accountant');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-cash', 'cashier');
    let n = 0;
    const call = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown, query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }), ...(method === 'GET' ? {} : { idempotencyKey: `k-${n += 1}` }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    return { h, T, call, ok };
  };

  it('1 · the driver hand-over limit: suggested, not confirmed → confirmed (audited) → changed as a new version → not confirmed when someone else changes it; the pack says which', async () => {
    const { h, T, call, ok } = await setUp();
    await h.enableFeature(T, 'delivery');
    await ok(call('POST', '/v1/org/nodes/CO', 'u-owner', { kind: 'company', name: 'SRE' }), 'company');
    await ok(call('POST', '/v1/org/nodes/BR1', 'u-owner', { kind: 'branch', name: 'Main store', parentId: 'CO', companyId: 'CO' }), 'branch');

    // A store with no settings yet: the suggestion is the code's old ₹100, and nothing can be confirmed until it is set up.
    const bare = await ok(call('GET', '/v1/delivery/handover-tolerance', 'u-owner', undefined, { storeId: 'BR1' }), 'read bare');
    expect(bare.body).toMatchObject({ valueMinor: null, suggestedMinor: 10_000, state: 'not_confirmed', confirmed: null });
    expect(codeOf(await call('POST', '/v1/delivery/handover-tolerance/BR1', 'u-owner', { valueMinor: 10_000 }))).toBe('store_not_set_up');

    await ok(call('POST', '/v1/stores/BR1/settings', 'u-owner', SETTINGS), 'settings');
    const before = await ok(call('GET', '/v1/delivery/handover-tolerance', 'u-mgr', undefined, { storeId: 'BR1' }), 'read');
    expect(before.body).toMatchObject({ valueMinor: 10_000, suggestedMinor: 10_000, state: 'not_confirmed', history: [] });
    const packOf = async () => ((await ok(call('GET', '/v1/store-packs/BR1', 'u-owner'), 'pack')).body as { sections: { policies: Record<string, unknown> } }).sections.policies;
    expect((await packOf())['handoverToleranceConfirmed'], 'not confirmed: the pack carries no confirmation').toBeUndefined();
    expect((await packOf())['handoverToleranceMinor']).toBe(10_000);

    // Only the owner confirms; zero is refused.
    expect((await call('POST', '/v1/delivery/handover-tolerance/BR1', 'u-mgr', { valueMinor: 10_000 })).status).toBe(403);
    expect(codeOf(await call('POST', '/v1/delivery/handover-tolerance/BR1', 'u-owner', { valueMinor: 0 }))).toBe('not_readable_as_a_handover_tolerance');

    // Confirmed as suggested — the settings are not re-versioned; the confirmation is kept and audited.
    const confirmed = await ok(call('POST', '/v1/delivery/handover-tolerance/BR1', 'u-owner', { valueMinor: 10_000, reason: 'as we run it today' }), 'confirm');
    expect(confirmed.status).toBe(201);
    expect(confirmed.body).toMatchObject({ state: 'confirmed', valueMinor: 10_000, confirmed: { version: 1, by: 'u-owner' }, history: [{ version: 1, kind: 'as_suggested', valueMinor: 10_000, previousMinor: 10_000, settingsVersion: 1 }] });
    expect((await call('POST', '/v1/delivery/handover-tolerance/BR1', 'u-owner', { valueMinor: 10_000 })).body).toMatchObject({ alreadyConfirmed: true, history: [{ version: 1 }] });
    expect((await packOf())['handoverToleranceConfirmed']).toMatchObject({ by: 'u-owner', version: 1 });

    // A change is a NEW settings version (every other figure carried over) and its own confirmation.
    const changed = await ok(call('POST', '/v1/delivery/handover-tolerance/BR1', 'u-owner', { valueMinor: 5_000 }), 'change');
    expect(changed.body).toMatchObject({ state: 'confirmed', valueMinor: 5_000, history: [{ version: 1 }, { version: 2, kind: 'changed', previousMinor: 10_000, valueMinor: 5_000, settingsVersion: 2 }] });
    const settings = (await ok(call('GET', '/v1/stores/BR1/settings', 'u-owner'), 'settings read')).body as { settings: Record<string, unknown> };
    expect(settings.settings).toMatchObject({ ...SETTINGS, handoverToleranceMinor: 5_000, version: 2, setBy: 'u-owner' });
    expect((await packOf())['handoverToleranceMinor']).toBe(5_000);
    expect((await packOf())['handoverToleranceConfirmed']).toMatchObject({ version: 2 });

    // Someone sets the store's settings again with another figure: the owner has not confirmed THAT — it says so, by itself.
    await ok(call('POST', '/v1/stores/BR1/settings', 'u-owner', { ...SETTINGS, handoverToleranceMinor: 20_000 }), 'settings again');
    expect((await ok(call('GET', '/v1/delivery/handover-tolerance', 'u-owner', undefined, { storeId: 'BR1' }), 'read again')).body).toMatchObject({ valueMinor: 20_000, state: 'not_confirmed', changedSinceConfirmed: true, confirmed: null });
    expect((await packOf())['handoverToleranceConfirmed']).toBeUndefined();

    // The Dispatch board says the same beside every cash difference.
    const board = await ok(call('GET', `/v1/delivery/dispatch/${day(0)}/board`, 'u-owner', undefined, { storeId: 'BR1' }), 'board');
    expect((board.body as { handoverTolerance: unknown }).handoverTolerance).toEqual({ valueMinor: 20_000, state: 'not_confirmed' });

    // Every confirmation is on the audit trail.
    const audit = await ok(call('GET', '/v1/audit/trail', 'u-owner', undefined, { action: 'delivery.handover_tolerance.confirm' }), 'audit');
    const records = (audit.body as { matches: { action: string }[] }).matches.filter((r) => r.action === 'delivery.handover_tolerance.confirm');
    expect(records.length).toBe(2);
  });

  it('2 · who staffs each exception queue: the suggestion, not confirmed → the owner sets it; a queue with no role is unowned on the worklist; a role that may not work exceptions is refused', async () => {
    const { call, ok } = await setUp();
    const first = await ok(call('GET', '/v1/orders/exception-queue-staffing', 'u-mgr'), 'read');
    expect(first.body).toMatchObject({
      state: 'not_confirmed', confirmed: null, unowned: [],
      suggested: { fulfilment_supervisor: ['owner', 'store_manager'], customer_service_desk: ['cashier', 'owner', 'store_manager'], finance_recon_queue: ['accountant', 'owner', 'store_manager'], duty_manager: ['owner', 'store_manager'] },
    });
    expect((first.body as { rolesThatMayWork: string[] }).rolesThatMayWork).toEqual(expect.arrayContaining(['accountant', 'cashier', 'owner', 'store_manager']));
    expect((first.body as { rolesThatMayWork: string[] }).rolesThatMayWork).not.toContain('supplier');
    const worklist0 = await ok(call('GET', '/v1/orders/substitution-exceptions', 'u-owner'), 'worklist');
    expect((worklist0.body as { staffing: unknown }).staffing).toMatchObject({ state: 'not_confirmed', unowned: [] });

    const staffing = { fulfilment_supervisor: ['store_manager'], customer_service_desk: [], finance_recon_queue: ['accountant'], duty_manager: ['owner', 'store_manager'] };
    expect((await call('POST', '/v1/orders/exception-queue-staffing', 'u-mgr', { staffing })).status, 'a manager may not set it').toBe(403);
    expect(codeOf(await call('POST', '/v1/orders/exception-queue-staffing', 'u-owner', { staffing: { ...staffing, finance_recon_queue: ['supplier'] } }))).toBe('not_readable_as_queue_staffing');
    expect(codeOf(await call('POST', '/v1/orders/exception-queue-staffing', 'u-owner', { staffing: { fulfilment_supervisor: ['owner'] } })), 'every queue is named').toBe('not_readable_as_queue_staffing');
    const set = await ok(call('POST', '/v1/orders/exception-queue-staffing', 'u-owner', { staffing, reason: 'the service desk is not staffed yet' }), 'set');
    expect(set.body).toMatchObject({ state: 'confirmed', confirmed: { version: 1, by: 'u-owner' }, unowned: ['customer_service_desk'], history: [{ version: 1, asSuggested: false, reason: 'the service desk is not staffed yet' }] });
    const worklist = await ok(call('GET', '/v1/orders/substitution-exceptions', 'u-owner'), 'worklist after');
    expect((worklist.body as { staffing: unknown }).staffing).toMatchObject({ state: 'confirmed', unowned: ['customer_service_desk'], byQueue: { customer_service_desk: [] } });
    const queue = await ok(call('GET', '/v1/orders/substitution-exceptions/queue/customer_service_desk', 'u-owner'), 'queue');
    expect(queue.body).toMatchObject({ unowned: true, staffedBy: [], staffingState: 'confirmed' });
    // The same staffing again records nothing new.
    expect((await call('POST', '/v1/orders/exception-queue-staffing', 'u-owner', { staffing })).body).toMatchObject({ alreadyConfirmed: true, history: [{ version: 1 }] });
  });

  it('3 · the concessionaire\'s own login: invited and approved by two people, it reads only its own counter — another is refused and recorded; revoked, nothing', async () => {
    const { h, T, call, ok } = await setUp();
    await h.enableFeature(T, 'dept.concession');
    const CON = '/v1/identity/outside-logins/concessionaires';
    const contract = (id: string, who: string, name: string) => ({ concessionaireId: who, name, branchId: 'BR1', startsOn: day(-30), endsOn: day(300), basis: 'revenue_share', revenueShareBps: 1_500, depositMinor: 50_000, insuranceUntil: day(200), licenceUntil: day(200) });
    await ok(call('POST', '/v1/concession/contracts/C-JWL', 'u-owner', contract('C-JWL', 'JWL-1', 'Jewellery counter')), 'jeweller');
    await ok(call('POST', '/v1/concession/contracts/C-MOB', 'u-owner', contract('C-MOB', 'MOB-1', 'Mobile counter')), 'mobile');
    await ok(call('POST', '/v1/concession/contracts/C-JWL/sales', 'u-owner', { saleId: 'S-J1', grossMinor: 250_000, taxMinor: 7_500, tenderedTo: 'store_till' }), 'jeweller sale');
    await ok(call('POST', '/v1/concession/contracts/C-MOB/sales', 'u-owner', { saleId: 'S-M1', grossMinor: 999_900, taxMinor: 0, tenderedTo: 'store_till' }), 'mobile sale');
    const at = new Date().toISOString();
    await ok(call('POST', '/v1/inventory/movements', 'u-owner', { movementId: 'g1', productId: 'GOLD-CHAIN', locationId: 'BR1', kind: 'received', quantityMinor: 2, uom: 'each', unitCostMinor: 2_000_000, ownership: 'concession', ownerId: 'JWL-1', occurredAt: at, enteredBy: 'u-owner' }), 'jeweller stock');
    await ok(call('POST', '/v1/inventory/movements', 'u-owner', { movementId: 'm1', productId: 'PHONE-X', locationId: 'BR1', kind: 'received', quantityMinor: 5, uom: 'each', unitCostMinor: 1_000_000, ownership: 'concession', ownerId: 'MOB-1', occurredAt: at, enteredBy: 'u-owner' }), 'mobile stock');
    await ok(call('POST', '/v1/inventory/movements', 'u-owner', { movementId: 'r1', productId: 'RICE', locationId: 'BR1', kind: 'received', quantityMinor: 10, uom: 'each', unitCostMinor: 5_000, occurredAt: at, enteredBy: 'u-owner' }), 'own stock');

    // The generic grant route refuses the concessionaire role; only the outside-party flow gives it.
    const asked = await call('POST', '/v1/identity/grants', 'u-mgr', { grantId: 'g-con', userId: 'u-x-con', roleId: 'concessionaire', branchScope: 'all', reason: 'counter' });
    expect([asked.status, codeOf(asked)]).toEqual([422, 'outside_party_login_holds_only_its_role']);
    // A cashier does not manage concessions; an unknown concessionaire has no record to bind to.
    const invite = { userId: 'u-jewel', displayName: 'Lakshmi Narayanan', reason: 'the jeweller\'s counter manager' };
    expect((await call('POST', `${CON}/JWL-1/invites/inv-j`, 'u-cash', invite)).status).toBe(403);
    expect(codeOf(await call('POST', `${CON}/NOBODY/invites/inv-n`, 'u-owner', invite))).toBe('party_record_unknown');
    expect(codeOf(await call('POST', `${CON}/JWL-1/invites/inv-s`, 'u-owner', { ...invite, displayName: 'Counter Staff' }))).toBe('shared_or_generic_sign_in');
    await ok(call('POST', `${CON}/JWL-1/invites/inv-j`, 'u-owner', invite), 'invite');
    // Invited is not approved: nothing to read yet.
    expect((await call('GET', '/v1/concession-portal/me/counters', 'u-jewel')).status).toBe(403);
    expect(codeOf(await call('POST', `${CON}/invites/inv-j/approve`, 'u-owner', {}))).toBe('approved_by_the_inviter');
    const approved = await ok(call('POST', `${CON}/invites/inv-j/approve`, 'u-acct', {}), 'approve');
    expect((approved.body as { login: unknown }).login).toMatchObject({ state: 'approved', role: 'concessionaire', partyId: 'JWL-1', invitedBy: 'u-owner', approvedBy: 'u-acct' });

    // It reads ITS OWN counter: the contract, the sale, the stock it owns and (none yet) invoices — never the mobile counter's.
    const counters = await ok(call('GET', '/v1/concession-portal/me/counters', 'u-jewel'), 'counters');
    expect(counters.body).toMatchObject({ concessionaireId: 'JWL-1', counters: [{ contract: { contractId: 'C-JWL', name: 'Jewellery counter' } }], deposit: { concessionaireId: 'JWL-1' } });
    expect((counters.body as { counters: unknown[] }).counters).toHaveLength(1);
    const sales = await ok(call('GET', '/v1/concession-portal/me/sales', 'u-jewel'), 'sales');
    expect(sales.body).toMatchObject({ concessionaireId: 'JWL-1', count: 1, grossMinor: 250_000, sales: [{ saleId: 'S-J1' }] });
    const stock = await ok(call('GET', '/v1/concession-portal/me/stock', 'u-jewel'), 'stock');
    expect(stock.body).toMatchObject({ concessionaireId: 'JWL-1', lines: [{ productId: 'GOLD-CHAIN', locationId: 'BR1', onHandMinor: 2 }] });
    expect((stock.body as { lines: unknown[] }).lines).toHaveLength(1);
    expect((await ok(call('GET', '/v1/concession-portal/me/invoices', 'u-jewel'), 'invoices')).body).toMatchObject({ concessionaireId: 'JWL-1', invoices: [] });

    // Another concessionaire's counter is refused AND recorded; no staff route opens to it.
    const probe = await call('GET', '/v1/concession-portal/me/sales', 'u-jewel', undefined, { concessionaireId: 'MOB-1' });
    expect([probe.status, codeOf(probe)]).toEqual([403, 'not_your_counter']);
    const audit = await ok(call('GET', '/v1/audit/trail', 'u-owner', undefined, { action: 'concession_portal.other_party_refused' }), 'audit');
    expect((audit.body as { matches: { action: string; objectId: string }[] }).matches.some((r) => r.action === 'concession_portal.other_party_refused' && r.objectId === 'MOB-1')).toBe(true);
    for (const [method, path, body] of [['GET', '/v1/concession/contracts', undefined], ['GET', '/v1/concession/contracts/C-MOB/charge', undefined], ['POST', '/v1/concession/contracts/C-JWL/sales', { saleId: 'S-X', grossMinor: 1, taxMinor: 0, tenderedTo: 'store_till' }]] as const) {
      expect((await call(method, path, 'u-jewel', body)).status, `${method} ${path}`).toBe(403);
    }
    // A member of staff reads nothing through the concessionaire's door (it is the concessionaire's own).
    expect((await call('GET', '/v1/concession-portal/me/counters', 'u-owner')).status).toBe(403);

    // Revoked: bound to nobody, reads nothing.
    await ok(call('POST', `${CON}/invites/inv-j/revoke`, 'u-acct', { reason: 'counter closed' }), 'revoke');
    // (its open sessions are cut on the next request — 401 — and the role is gone either way)
    expect([401, 403]).toContain((await call('GET', '/v1/concession-portal/me/counters', 'u-jewel')).status);
  });
});
