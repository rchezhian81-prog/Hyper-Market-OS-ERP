import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { SqlIdempotencyStore, MemoryIdempotencyStore } from '../../services/kernel/src/index';
import { segmentDataAdapter, serviceCaseAdapter } from '../../services/api/src/adapters';

/**
 * **An erasure is carried out over the REAL domain stores, on synthetic data (audit FUL-12 · M16-FR-03 · M20-FR-04).**
 *
 * The audit found the erasure executor acting only on a simulated "PII register". Here a customer has real data in four
 * domains — a marketing profile (segmentation facts), a service complaint in their own words, a storefront order (a tax
 * invoice) and their consent history. The customer raises an erasure in their own session; an officer verifies it; a
 * second officer approves; the first carries it out. Then, read back from each DOMAIN (not from the privacy module):
 *
 *   • ERASED — the marketing profile is anonymised: segmentation's own reader no longer shows the person; the totals stay.
 *   • MINIMISED — the complaint keeps its case, dates and state; the customer's words are gone.
 *   • RETAINED — the order (tax invoice) and the consent history are untouched, each with the law that keeps it, and the
 *     customer statement says so.
 *   • PREVENT-RESTORE — a new profile fact for the erased customer is refused, never re-created silently.
 *   • ONCE — a second execution is refused; the sealed tombstone stands. All of it survives a restart, and on PostgreSQL.
 *
 * DEVELOPMENT-APPROVED: the owner's authorisation and a lawyer's confirmation of the retention policy are still needed
 * before any real customer's data is erased (matrix residual). Synthetic data only (hard rule #7).
 */

const OWNER = 'u-owner'; const CHECKER = 'u-checker'; const C = 'cust-erase-1'; const OTHER = 'cust-keep-2';
const AT = '2026-10-10T10:00:00.000Z';

async function seed(h: ApiHarness, T: string): Promise<void> {
  await h.seedOwner(T, OWNER);
  await h.provisionOwner(T, CHECKER);
  await h.provisionRole(T, C, 'customer');
  await h.provisionRole(T, OTHER, 'customer');
  await h.enableFeature(T, 'customer_app');
  const ok = async (userId: string, path: string, body: unknown, key: string) => {
    const r = await h.request({ method: 'POST', path, userId, tenantId: T, idempotencyKey: key, body });
    expect(r.status, `${path} ${JSON.stringify(r.body)}`).toBeLessThan(300);
  };
  // Consent history, given by the customer in their own session (FUL-06's route).
  await ok(C, '/v1/me/privacy/consent', { purpose: 'profiling', channel: 'email', given: true }, 'c-prof');
  await ok(OTHER, '/v1/me/privacy/consent', { purpose: 'profiling', channel: 'email', given: true }, 'o-prof');
  // Marketing profile — two orders and a complaint as segmentation facts; another customer's for contrast.
  await ok(OWNER, '/v1/customer/facts/orders/o-1', { customerRef: C, at: '2026-09-01', netMinor: 1_200_00, marginMinor: 300_00, channel: 'app' }, 'f1');
  await ok(OWNER, '/v1/customer/facts/orders/o-2', { customerRef: C, at: '2026-09-20', netMinor: 800_00, marginMinor: 200_00, channel: 'store' }, 'f2');
  await ok(OWNER, '/v1/customer/facts/complaints/case-1', { customerRef: C, at: '2026-09-21', resolved: true }, 'f3');
  await ok(OWNER, '/v1/customer/facts/orders/o-9', { customerRef: OTHER, at: '2026-09-02', netMinor: 500_00, marginMinor: 100_00, channel: 'app' }, 'f4');
  // A service complaint in the customer's own words.
  await ok(OWNER, '/v1/service/cases/case-1', { kind: 'complaint', customerRef: C, priority: 'normal', summary: 'Delivered to 14 Gandhi Street, wrong flat, call me on my number', assignedTo: OWNER }, 'case-1');
  // A storefront order — a tax invoice the law keeps.
  await ok(OWNER, '/v1/inventory/movements', { movementId: 'mv-1', productId: 'MILK', locationId: 'L1', kind: 'received', quantityMinor: 5, uom: 'each', occurredAt: AT, enteredBy: OWNER }, 'mv-1');
  await ok(C, '/v1/storefront/orders/ORD-ERASE-1', { lines: [{ productId: 'MILK', quantityMinor: 1 }], locationId: 'L1' }, 'ord-1');
}

const pii = async (h: ApiHarness, T: string) =>
  ((await h.request({ method: 'GET', path: `/v1/privacy/pii/${C}`, userId: OWNER, tenantId: T })).body as { categories: { category: string; domain: string; state: string; recordCount: number; retentionBasis?: string }[] }).categories;

async function journey(h: ApiHarness, T: string, restart: () => ApiHarness): Promise<void> {
  await seed(h, T);

  // LOCATE: the four real domains answer for this customer.
  const located = await pii(h, T);
  expect(located.map((c) => [c.category, c.domain, c.state, c.recordCount])).toEqual([
    ['consent_history', 'customer consent', 'held', 1],
    ['marketing_profile', 'customer segmentation', 'held', 3],
    ['service_cases', 'service desk', 'held', 1],
    ['storefront_orders', 'orders', 'held', 1],
  ]);

  // The customer raises the erasure in their own session; an officer verifies; a second officer approves.
  const raised = await h.request({ method: 'POST', path: '/v1/me/privacy/requests/DSR-ERASE-1', userId: C, tenantId: T, idempotencyKey: 'raise', body: { kind: 'erasure' } });
  expect(raised.status).toBe(201);
  expect((await h.request({ method: 'POST', path: '/v1/privacy/data-requests/DSR-ERASE-1/verification', userId: OWNER, tenantId: T, idempotencyKey: 'verify', body: { verifiedBy: 'otp to registered phone + order reference' } })).status).toBe(200);
  expect((await h.request({ method: 'POST', path: '/v1/privacy/data-requests/DSR-ERASE-1/erasure-approval', userId: CHECKER, tenantId: T, idempotencyKey: 'approve' })).status).toBe(200);

  // EXECUTE (the maker; a fresh MFA sign-in).
  const run = await h.request({ method: 'POST', path: '/v1/privacy/data-requests/DSR-ERASE-1/erasure-execution', userId: OWNER, tenantId: T, idempotencyKey: 'exec', body: {} });
  expect(run.status, JSON.stringify(run.body)).toBe(200);
  const body = run.body as { state: string; report: { complete: boolean; totals: Record<string, number> }; tombstone: { categoriesErased: string[]; categoriesMinimised: string[]; categoriesRetained: { category: string; basis?: string }[] }; customerStatement: string[] };
  expect(body.report.complete).toBe(true);
  expect(body.state).toBe('partially_fulfilled'); // the invoice and consent proof are kept — honestly partial
  expect(body.tombstone.categoriesErased).toEqual(['marketing_profile']);
  expect(body.tombstone.categoriesMinimised).toEqual(['service_cases']);
  expect(body.tombstone.categoriesRetained.map((c) => c.category).sort()).toEqual(['consent_history', 'storefront_orders']);
  expect(body.customerStatement.join(' ')).toMatch(/storefront_orders/);

  await readBack(h, T, h.store);

  // ONCE: a second run under a new key is refused; the sealed record stands.
  const again = await h.request({ method: 'POST', path: '/v1/privacy/data-requests/DSR-ERASE-1/erasure-execution', userId: OWNER, tenantId: T, idempotencyKey: 'exec-2', body: {} });
  expect(again.status).toBe(409);
  expect((again.body as { error: { code: string } }).error.code).toBe('erasure_already_carried_out');

  // RESTART: a new process over the same store — every domain still reads the same.
  const h2 = restart();
  await readBack(h2, T, h2.store);
}

/** Read each effect back FROM ITS OWN DOMAIN. */
async function readBack(h: ApiHarness, T: string, store: EventStore): Promise<void> {
  const now = () => AT;
  // ERASED: segmentation's own reader shows an anonymous ref in place of the customer; totals survive.
  const facts = await segmentDataAdapter({ store, now }).orderFacts(T);
  expect(facts.some((f) => f.customerRef === C)).toBe(false);
  const anonymous = facts.filter((f) => f.customerRef.startsWith('anon-'));
  expect(anonymous.map((f) => f.netMinor).sort((a, b) => a - b)).toEqual([800_00, 1_200_00]);
  expect(facts.find((f) => f.orderId === 'o-9')?.customerRef).toBe(OTHER); // another customer untouched
  const ranking = ((await h.request({ method: 'GET', path: '/v1/customer/segments/value-ranking', userId: OWNER, tenantId: T })).body as { ranking: { customerRef: string }[] }).ranking;
  expect(ranking.map((r) => r.customerRef)).toEqual([OTHER]);

  // MINIMISED: the case, its dates and state are kept; the customer's words are gone.
  const kase = await serviceCaseAdapter({ store, now }).serviceCase(T, 'case-1');
  expect(kase).toMatchObject({ caseId: 'case-1', customerRef: C, kind: 'complaint', state: 'open' });
  expect(kase?.summary).toBe('[removed under privacy request DSR-ERASE-1]');
  expect(JSON.stringify(kase)).not.toContain('Gandhi');

  // RETAINED: the order (tax invoice) reads exactly as placed; the consent proof is untouched.
  const order = await h.request({ method: 'GET', path: '/v1/storefront/orders/ORD-ERASE-1', userId: C, tenantId: T });
  expect(order.status).toBe(200);
  expect((order.body as { lines: { productId: string }[] }).lines.map((l) => l.productId)).toEqual(['MILK']);
  const consent = ((await h.request({ method: 'GET', path: `/v1/customers/${C}/consent`, userId: OWNER, tenantId: T })).body as { records: unknown[] }).records;
  expect(consent).toHaveLength(1);

  // The located list now reads honestly, from the domains.
  const located = await pii(h, T);
  const state = (c: string) => located.find((e) => e.category === c);
  expect(state('marketing_profile')).toMatchObject({ state: 'erased', recordCount: 0 });
  expect(state('service_cases')).toMatchObject({ state: 'minimised' });
  expect(state('storefront_orders')).toMatchObject({ state: 'held', retentionBasis: 'tax_invoice' });

  // PREVENT-RESTORE: a late re-import of the erased customer's profile is refused, by name.
  const restore = await h.request({ method: 'POST', path: '/v1/customer/facts/orders/o-late', userId: OWNER, tenantId: T, idempotencyKey: `late-${Math.random()}`, body: { customerRef: C, at: '2026-10-01', netMinor: 100_00, marginMinor: 10_00, channel: 'app' } });
  expect(restore.status).toBe(409);
  expect((restore.body as { error: { code: string } }).error.code).toBe('subject_was_erased');
  // …while another customer's fact is still taken.
  const fine = await h.request({ method: 'POST', path: '/v1/customer/facts/orders/o-10', userId: OWNER, tenantId: T, idempotencyKey: `fine-${Math.random()}`, body: { customerRef: OTHER, at: '2026-10-01', netMinor: 100_00, marginMinor: 10_00, channel: 'app' } });
  expect(fine.status).toBe(201);
}

describe('an erasure reaches the real domain stores (FUL-12)', () => {
  it('erases, minimises and retains in the owning domains; refuses a restore; runs once; survives a restart', async () => {
    const h = apiHarness();
    await journey(h, 'ab000000-0000-4000-8000-000000000f12', () => apiHarness({ store: h.store, idempotency: new MemoryIdempotencyStore() }));
  });
});

const DATABASE_URL = process.env['DATABASE_URL'];
describe.skipIf(!DATABASE_URL)('an erasure reaches the real domain stores — real PostgreSQL, across a restart (FUL-12)', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4, options: '-c app.tenant_id=*' });
    const dir = 'db/migrations';
    await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .map((name) => ({ name, sql: readFileSync(`${dir}/${name}`, 'utf8') })));
  });
  afterAll(async () => { await pool.end(); });

  it('the same journey on PostgreSQL', async () => {
    const sql = pgPoolClient(pool);
    const fresh = () => ({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) });
    await journey(apiHarness(fresh()), randomUUID(), () => apiHarness(fresh()));
  });
});
