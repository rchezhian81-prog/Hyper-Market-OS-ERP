import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { pgClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';

// M22-FR-04 / M23, API-09 — the B2B AR RECONCILIATION. The collections sub-ledger (structured invoices,
// aged from the due date) and the finance AR balance (projected from receivable movements, M22-FR-01)
// are two folds of the SAME customer stream, and the shop cannot count if they disagree: the customer
// pays what the portal shows and finance chases the difference. `reconcileAr` was a tested engine no
// running route called; this proves the wired GET over the real pipeline and real per-tenant RBAC —
// the difference reported EXACTLY and with its sign, and the report gated one rung above the ageing
// read (a manager who chases customers cannot audit the sub-ledger against the GL — that is finance).

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

// A collections invoice (b2b.receivable.record) — the sub-ledger the portal ages.
const invoice = (h: ApiHarness, tenantId: string, userId: string, customerId: string, invoiceId: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/b2b/collections/${customerId}/invoices/${invoiceId}`, userId, tenantId, idempotencyKey: `inv-${invoiceId}`, body });
// A finance AR movement (b2b.receivable.record) — the GL balance the reconciliation compares against.
const receivable = (h: ApiHarness, tenantId: string, userId: string, customerId: string, movementId: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/b2b/accounts/${customerId}/receivables`, userId, tenantId, idempotencyKey: `rcv-${movementId}`, body: { movementId, ...body } });
const ageing = (h: ApiHarness, tenantId: string, userId: string, customerId: string, asOf: string) =>
  h.request({ method: 'GET', path: `/v1/b2b/collections/${customerId}/ageing`, userId, tenantId, query: { asOf } });
const reconcile = (h: ApiHarness, tenantId: string, userId: string, customerId: string, asOf: string) =>
  h.request({ method: 'GET', path: `/v1/b2b/collections/${customerId}/reconciliation`, userId, tenantId, query: { asOf } });

interface Recon {
  customerId: string; portalOutstandingMinor: number; financeOutstandingMinor: number;
  differenceMinor: number; agrees: boolean; detail: string;
}

// Give a customer both ledgers: two structured invoices (150,000 outstanding) and, unless overridden,
// a matching finance balance. Returns nothing — the caller reconciles and asserts.
async function bothLedgers(h: ApiHarness, tenant: string, cust: string, financeMinor: number) {
  await invoice(h, tenant, 'u-owner', cust, 'inv-1', { number: 'INV-1', issuedOn: '2026-07-21', dueOn: '2026-08-20', grossMinor: 100_000 });
  await invoice(h, tenant, 'u-owner', cust, 'inv-2', { number: 'INV-2', issuedOn: '2026-08-16', dueOn: '2026-09-15', grossMinor: 50_000 });
  if (financeMinor > 0) await receivable(h, tenant, 'u-owner', cust, 'm-1', { kind: 'invoice', amountMinor: financeMinor });
}

describe('b2b AR reconciliation: the sub-ledger vs the GL, exact and signed (M22-FR-04 / M23)', () => {
  it('agrees when the collections ageing total equals the finance AR balance', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await bothLedgers(h, A, 'CUST1', 150_000); // 100,000 + 50,000 on both sides

    const r = (await reconcile(h, A, 'u-owner', 'CUST1', '2026-08-31')).body as Recon;
    expect(r.portalOutstandingMinor).toBe(150_000);
    expect(r.financeOutstandingMinor).toBe(150_000);
    expect(r.differenceMinor).toBe(0);
    expect(r.agrees).toBe(true);
  });

  it('surfaces a drift where the portal shows MORE than finance (customer asked for money the books do not record)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await bothLedgers(h, A, 'CUST1', 100_000); // portal 150,000, finance only 100,000

    const r = (await reconcile(h, A, 'u-owner', 'CUST1', '2026-08-31')).body as Recon;
    expect(r.differenceMinor).toBe(50_000);       // portal − finance, positive
    expect(r.agrees).toBe(false);
    expect(r.detail).toContain('MORE');
  });

  it('surfaces the WORST case — the sub-ledger is empty while finance records a debt — instead of 404ing it away', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    // No collections invoice at all; finance says 90,000 is owed. The customer's portal would show
    // NOTHING due while the books say otherwise — a report that must appear, not disappear as "no data".
    await receivable(h, A, 'u-owner', 'CUST1', 'm-1', { kind: 'invoice', amountMinor: 90_000 });

    const res = await reconcile(h, A, 'u-owner', 'CUST1', '2026-08-31');
    expect(res.status).toBe(200);                  // NOT 404 — the discrepancy is the whole point
    const r = res.body as Recon;
    expect(r.portalOutstandingMinor).toBe(0);
    expect(r.financeOutstandingMinor).toBe(90_000);
    expect(r.differenceMinor).toBe(-90_000);       // negative — shown a SMALLER debt than owed
    expect(r.agrees).toBe(false);
    expect(r.detail).toContain('LESS');
  });

  it('gates the reconciliation ONE RUNG above the ageing read (a manager reads ageing, not the reconciliation)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-mgr', 'store_manager'); // b2b.account.read — NOT b2b.receivable.record
    await h.provisionRole(A, 'u-acct', 'accountant');   // b2b.receivable.record
    await h.provisionRole(A, 'u-cash', 'cashier');       // neither
    await bothLedgers(h, A, 'CUST1', 150_000);

    // The store manager chases customers: reads the ageing…
    expect((await ageing(h, A, 'u-mgr', 'CUST1', '2026-08-31')).status).toBe(200);
    // …but reconciling the sub-ledger to the GL is a finance-controllership act — refused (403).
    expect((await reconcile(h, A, 'u-mgr', 'CUST1', '2026-08-31')).status).toBe(403);
    // The cashier holds neither.
    expect((await reconcile(h, A, 'u-cash', 'CUST1', '2026-08-31')).status).toBe(403);
    // The accountant and the owner (the receivable-recording tier) read it.
    expect((await reconcile(h, A, 'u-acct', 'CUST1', '2026-08-31')).status).toBe(200);
    expect((await reconcile(h, A, 'u-owner', 'CUST1', '2026-08-31')).status).toBe(200);
  });

  it('404s only when NEITHER ledger knows the customer, needs a date, and is tenant-scoped', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await bothLedgers(h, A, 'CUST1', 150_000);

    // Nothing on either ledger for GHOST → 404 (there is genuinely nothing to reconcile).
    expect((await reconcile(h, A, 'u-owner', 'GHOST', '2026-08-31')).status).toBe(404);
    // A reconciliation reads against a date; without one it refuses rather than guessing.
    expect((await reconcile(h, A, 'u-owner', 'CUST1', '')).status).toBe(400);

    // The customer exists only in tenant A (§35) — tenant B sees neither ledger.
    await h.seedOwner(B, 'u-owner-b');
    expect((await reconcile(h, B, 'u-owner-b', 'CUST1', '2026-08-31')).status).toBe(404);
  });
});

// The same reconciliation end to end against real PostgreSQL — proving both folds (collections ageing
// and finance AR) and the RBAC gate hold on the actual database, not only the in-memory reference.
// Skips (never passes quietly) without DATABASE_URL; runs in the "Stage gate suites" CI job.
const DATABASE_URL = process.env['DATABASE_URL'];
const RUN = `r${Date.now().toString(36)}`;
const E2E_TENANT = `d${Date.now().toString(16).slice(-7)}-dddd-4ddd-8ddd-${'d'.repeat(12)}`;

describe.skipIf(!DATABASE_URL)('b2b AR reconciliation, end to end on real PostgreSQL (M22-FR-04 / M23, API-09)', () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    const sql = pgClient(client);
    const dir = 'db/migrations';
    await runMigrations(sql, readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
  });
  afterAll(async () => { await client.end(); });

  it('agrees, surfaces a signed drift, and holds the RBAC gate, on real PostgreSQL', async () => {
    const sql = pgClient(client);
    const h = apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) });
    await h.seedOwner(E2E_TENANT, 'u-owner');
    await h.provisionRole(E2E_TENANT, 'u-mgr', 'store_manager');

    const cust = `${RUN}-CUST`;
    await invoice(h, E2E_TENANT, 'u-owner', cust, `${RUN}-inv-1`, { number: 'INV-1', issuedOn: '2026-07-21', dueOn: '2026-08-20', grossMinor: 100_000 });
    await invoice(h, E2E_TENANT, 'u-owner', cust, `${RUN}-inv-2`, { number: 'INV-2', issuedOn: '2026-08-16', dueOn: '2026-09-15', grossMinor: 50_000 });

    // Finance records only 100,000 of the 150,000 the sub-ledger holds → a +50,000 drift, exact and signed.
    await receivable(h, E2E_TENANT, 'u-owner', cust, `${RUN}-m-1`, { kind: 'invoice', amountMinor: 100_000 });

    const r = (await reconcile(h, E2E_TENANT, 'u-owner', cust, '2026-08-31')).body as Recon;
    expect(r.portalOutstandingMinor).toBe(150_000);
    expect(r.financeOutstandingMinor).toBe(100_000);
    expect(r.differenceMinor).toBe(50_000);
    expect(r.agrees).toBe(false);

    // A payment closes the gap on the finance side → the two ledgers then agree at 150,000… by recording
    // the missing 50,000 as a finance invoice movement (the drift was finance under-recording).
    await receivable(h, E2E_TENANT, 'u-owner', cust, `${RUN}-m-2`, { kind: 'invoice', amountMinor: 50_000 });
    const agreed = (await reconcile(h, E2E_TENANT, 'u-owner', cust, '2026-08-31')).body as Recon;
    expect(agreed.differenceMinor).toBe(0);
    expect(agreed.agrees).toBe(true);

    // Least privilege holds against the real database too: a manager reads the ageing, not the reconciliation.
    expect((await ageing(h, E2E_TENANT, 'u-mgr', cust, '2026-08-31')).status).toBe(200);
    expect((await reconcile(h, E2E_TENANT, 'u-mgr', cust, '2026-08-31')).status).toBe(403);
  });
});
