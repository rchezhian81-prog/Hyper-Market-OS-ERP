import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM } from '../../services/api/src/adapters';

/**
 * **Verifier r18 C2-R2 and the boxscope residual — a grant naming a ghost or non-canonical store is never approved, and a
 * store computer whose grant already names one never relays.** Round 18 checked a grant's scope at the REQUEST only, so:
 *
 *   • a request made before that check (on the ledger, pending) naming "store-99" (canonical, never registered) or
 *     "store-1<U+200B>" could still be APPROVED — adding a ghost store to the stores OB-82 counts. Now the approval judges the
 *     scope again: 422 `unknown_store`, nobody's access changes; a good request is still approved;
 *   • a store-computer grant ALREADY on the ledger with "store-1<U+200B>" relayed till cash (202, ₹1,000 at a phantom till).
 *     Now every relay from a credential naming a non-canonical store is refused (403, kept on head office's refusal list),
 *     and nothing is booked.
 *
 * In memory and on PostgreSQL, through the real routes.
 */

const ZW = 'store-1​';
type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } } | null)?.error?.code;

async function ghostGrants(h: ApiHarness): Promise<void> {
  const T = randomUUID();
  await h.seedOwner(T, 'u-owner');
  await h.provisionRole(T, 'u-mgr', 'store_manager');
  const call = (method: 'GET' | 'POST', path: string, user: string, body?: unknown, query?: Record<string, string>): Promise<Res> =>
    h.request({ method, path, userId: user, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
  expect((await call('POST', '/v1/org/nodes/C1', 'u-owner', { kind: 'company', name: 'C' })).status).toBeLessThan(300);
  expect((await call('POST', '/v1/org/nodes/store-1', 'u-owner', { kind: 'branch', name: 's1', parentId: 'C1', companyId: 'C1' })).status).toBeLessThan(300);

  // Two requests made before round 18's request check, still pending on the ledger.
  for (const [grantId, scope] of [['g-ghost', ['store-99']], ['g-zw', [ZW]]] as const) {
    await h.store.append(T, STREAM.identity, makeEvent({
      id: `grant-request-${grantId}`, type: 'RoleGrantRequested', occurredAt: '2026-10-01T00:00:00.000Z', idempotencyKey: `grant-request-${T}-${grantId}`, source: 'api/identity',
      payload: { grantId, userId: `u-box-${grantId}`, roleId: 'store_computer', branchScope: scope, requestedBy: 'u-mgr', requestedAt: '2026-10-01T00:00:00.000Z', reason: 'old request' },
    }));
  }
  for (const grantId of ['g-ghost', 'g-zw']) {
    const approve = await call('POST', `/v1/identity/grants/${grantId}/approve`, 'u-owner', {});
    expect(approve.status, JSON.stringify(approve.body)).toBe(422);
    expect(codeOf(approve)).toBe('unknown_store');
    // Nobody's access changed: the would-be box relays nothing.
    const relay = await call('POST', '/v1/tills/lane-9/cash-movements/synced', `u-box-${grantId}`, { movementId: `cm-${grantId}`, tillId: 'lane-9', kind: 'float_issue', amountMinor: 100_000, custodianId: 'u-cash', tradingDay: '2026-10-07', at: '2026-10-07T04:00:00.000Z' });
    expect(relay.status).toBe(403);
  }
  // A good request is still approved.
  expect((await call('POST', '/v1/identity/grants', 'u-mgr', { grantId: 'g-ok', userId: 'u-box-ok', roleId: 'store_computer', branchScope: ['store-1'], reason: 'new box' })).status).toBe(202);
  expect((await call('POST', '/v1/identity/grants/g-ok/approve', 'u-owner', {})).status).toBe(201);

  // A store-computer grant ALREADY on the ledger naming "store-1<ZWSP>": every relay refused and kept; nothing booked.
  await h.provisionRole(T, 'u-zw', 'store_computer', [ZW]);
  await h.provisionRole(T, 'u-cash', 'cashier', ['store-1']);
  const cash = await h.request({
    method: 'POST', path: '/v1/tills/lane-1/cash-movements/synced', userId: 'u-zw', tenantId: T, branchId: ZW, idempotencyKey: `k-${randomUUID()}`,
    body: { movementId: 'cm1', tillId: 'lane-1', kind: 'float_issue', amountMinor: 100_000, custodianId: 'u-cash', tradingDay: '2026-10-07', at: '2026-10-07T04:00:00.000Z' },
  });
  expect(cash.status).toBe(403);
  expect(codeOf(cash)).toBe('store_computer_credential_store_not_canonical');
  const refusals = ((await call('GET', '/v1/store-computers/refusals', 'u-owner')).body as { refusals: { userId: string; reason: string }[] }).refusals;
  expect(refusals).toEqual(expect.arrayContaining([expect.objectContaining({ userId: 'u-zw', reason: 'credential_store_not_canonical' })]));
  for (const storeId of [ZW, 'store-1']) {
    expect(((await call('GET', '/v1/tills/lane-1/cash', 'u-owner', undefined, { storeId })).body as { balanceMinor: number }).balanceMinor).toBe(0);
  }
}

describe('C2-R2: a ghost-store grant is never approved or relayed (memory)', () => {
  it('approval re-checks the scope; a non-canonical credential never relays', async () => { await ghostGrants(apiHarness()); }, 60_000);
});

const DATABASE_URL = process.env['DATABASE_URL'];
describe.skipIf(DATABASE_URL === undefined)('C2-R2: a ghost-store grant is never approved or relayed (PostgreSQL)', () => {
  it('approval re-checks the scope; a non-canonical credential never relays', async () => {
    const pool = new Pool({ connectionString: DATABASE_URL, max: 8, options: '-c app.tenant_id=*' });
    const sql = pgPoolClient(pool);
    try { await ghostGrants(apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) })); } finally { await pool.end(); }
  }, 120_000);
});
