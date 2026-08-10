import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { pgClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';

// M23-FR-02, API-09 — the PERIOD CREDIT-NOTE RECONCILIATION (CGST s.34 / GSTR-1). The credit notes
// ISSUED for a return period (grouped by the month they were ISSUED, never the invoice's month) are
// folded from the wired `CreditNoteIssued` ledger and compared against what the accounts POSTED for
// that period (supplied), reporting the difference EXACTLY and with its sign — the number the buyer's
// GSTR-2B finds before we do — plus the value issued OUTSIDE the s.34(2) window (commercially real,
// fiscally not). `reconcileNotes` was a tested engine no route called; this proves the wired GET over
// the real pipeline and real per-tenant RBAC. Same shape as the stored-value liability + B2B AR
// reconciliations: side 1 folded from the cloud, side 2 a supplied comparison figure; nothing posted.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

// A source invoice on 18% GST (9% CGST + 9% SGST). `over` lets a test age it into an old financial year.
const invoice = (over: Record<string, unknown> = {}) => ({
  invoiceId: 'INV-1', number: 'INV/2026/1', customerId: 'C-1', issuedOn: '2026-05-10',
  taxableMinor: 100_00,
  taxes: [{ component: 'CGST', rateBps: 900, amountMinor: 9_00 }, { component: 'SGST', rateBps: 900, amountMinor: 9_00 }],
  grossMinor: 118_00, financialYear: '2026-27', ...over,
});

// A proportional credit note (tax reversed in the same proportion the goods came back).
const note = (id: string, taxableMinor: number, taxEach: number, over: Record<string, unknown> = {}) => ({
  noteId: id, number: `CN/${id}`, kind: 'credit_note', invoice: invoice(), customerId: 'C-1',
  reason: 'goods_returned', taxableMinor,
  taxes: [{ component: 'CGST', rateBps: 900, amountMinor: taxEach }, { component: 'SGST', rateBps: 900, amountMinor: taxEach }],
  issuedOn: '2026-06-15T10:00:00Z', ...over,
});

const issueNote = (h: ApiHarness, tenant: string, userId: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: '/v1/finance/credit-notes', userId, tenantId: tenant, idempotencyKey: `cn-${String(body['noteId'])}`, body });

const reconcile = (h: ApiHarness, tenant: string, userId: string, period: string, ledgerTaxable: string, ledgerTax: string) =>
  h.request({ method: 'GET', path: '/v1/finance/credit-notes/reconciliation', userId, tenantId: tenant, query: { period, ledgerTaxable, ledgerTax } });

interface NoteRecon {
  period: string; notesIssued: number; creditedTaxableMinor: number; creditedTaxMinor: number;
  outsideTaxWindowMinor: number; reconciles: boolean; differenceMinor: number; detail: string;
}

// Two adjustable notes issued in 2026-06: 50,00 + 30,00 taxable (proportional 4,50 / 2,70 tax each side).
async function twoNotes(h: ApiHarness, tenant: string, userId = 'u-owner') {
  expect((await issueNote(h, tenant, userId, note('CN-1', 50_00, 4_50))).status).toBe(201);
  expect((await issueNote(h, tenant, userId, note('CN-2', 30_00, 2_70))).status).toBe(201);
}

describe('period credit-note reconciliation: sub-ledger vs the GL, exact and signed (M23-FR-02)', () => {
  it('reconciles when the issued notes equal what the accounts posted for the period', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await twoNotes(h, A);

    // creditedTaxable = 8000, creditedTax = 900 + 540 = 1440.
    const r = (await reconcile(h, A, 'u-owner', '2026-06', '8000', '1440')).body as NoteRecon;
    expect(r.notesIssued).toBe(2);
    expect(r.creditedTaxableMinor).toBe(8000);
    expect(r.creditedTaxMinor).toBe(1440);
    expect(r.differenceMinor).toBe(0);
    expect(r.reconciles).toBe(true);
  });

  it('surfaces a signed difference the buyer\'s GSTR-2B would find first', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await twoNotes(h, A);

    // The ledger posted 40 less tax than the notes carry → a +40 gap, reconciles false.
    const r = (await reconcile(h, A, 'u-owner', '2026-06', '8000', '1400')).body as NoteRecon;
    expect(r.differenceMinor).toBe(40);
    expect(r.reconciles).toBe(false);
    expect(r.detail).toContain('GSTR-2B');
  });

  it('counts notes issued OUTSIDE the s.34(2) window separately (commercially real, fiscally not)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await twoNotes(h, A);
    // A note issued in 2026-06 against an FY2024-25 invoice (s.34(2) deadline 2025-11-30, already past)
    // is commercial-only — it does NOT count toward the adjustable credited totals, but IS surfaced.
    const old = invoice({ invoiceId: 'INV-OLD', number: 'INV/2024/9', issuedOn: '2024-08-10', financialYear: '2024-25' });
    expect((await issueNote(h, A, 'u-owner', note('CN-3', 20_00, 1_80, { invoice: old }))).status).toBe(201);

    const r = (await reconcile(h, A, 'u-owner', '2026-06', '8000', '1440')).body as NoteRecon;
    expect(r.notesIssued).toBe(3);              // all three fall in 2026-06
    expect(r.creditedTaxableMinor).toBe(8000);  // CN-3 excluded from the adjustable total
    expect(r.outsideTaxWindowMinor).toBe(2000); // …but surfaced here
    expect(r.reconciles).toBe(true);            // the adjustable side still matches the ledger
  });

  it('refuses without a period or without both ledger figures (a reconciliation reads, it never guesses)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await twoNotes(h, A);
    const base = { method: 'GET' as const, path: '/v1/finance/credit-notes/reconciliation', userId: 'u-owner', tenantId: A };
    expect((await h.request({ ...base, query: { ledgerTaxable: '8000', ledgerTax: '1440' } })).status).toBe(400); // no period
    expect((await h.request({ ...base, query: { period: 'June', ledgerTaxable: '8000', ledgerTax: '1440' } })).status).toBe(400); // malformed period
    expect((await h.request({ ...base, query: { period: '2026-06', ledgerTax: '1440' } })).status).toBe(400); // no ledgerTaxable
    expect((await h.request({ ...base, query: { period: '2026-06', ledgerTaxable: 'lots', ledgerTax: '1440' } })).status).toBe(400); // non-numeric
  });

  it('gates the reconciliation on the credit-note tier — a manager reads period data but not this', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-mgr', 'store_manager'); // has finance.period.read, NOT finance.creditnote.issue
    await h.provisionRole(A, 'u-acct', 'accountant');   // has finance.creditnote.issue
    await h.provisionRole(A, 'u-cash', 'cashier');       // neither
    await twoNotes(h, A);

    expect((await reconcile(h, A, 'u-mgr', '2026-06', '8000', '1440')).status).toBe(403);
    expect((await reconcile(h, A, 'u-cash', '2026-06', '8000', '1440')).status).toBe(403);
    // The accountant and owner (finance.creditnote.issue) read it.
    expect((await reconcile(h, A, 'u-acct', '2026-06', '8000', '1440')).status).toBe(200);
    expect((await reconcile(h, A, 'u-owner', '2026-06', '8000', '1440')).status).toBe(200);
  });

  it('keeps the fold tenant-scoped — a period with no notes reconciles at zero, not another tenant\'s figure', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.seedOwner(B, 'u-owner');
    await twoNotes(h, A);

    const inB = (await reconcile(h, B, 'u-owner', '2026-06', '0', '0')).body as NoteRecon;
    expect(inB.notesIssued).toBe(0);
    expect(inB.reconciles).toBe(true);
    expect(((await reconcile(h, A, 'u-owner', '2026-06', '8000', '1440')).body as NoteRecon).notesIssued).toBe(2);
  });
});

// The same reconciliation end to end against real PostgreSQL — proving the CreditNoteIssued fold, the
// signed difference and the RBAC gate hold on the actual database. Skips (never passes quietly) without
// DATABASE_URL; runs in the "Stage gate suites" CI job.
const DATABASE_URL = process.env['DATABASE_URL'];
const E2E_TENANT = `f${Date.now().toString(16).slice(-7)}-ffff-4fff-8fff-${'f'.repeat(12)}`;

describe.skipIf(!DATABASE_URL)('period credit-note reconciliation, end to end on real PostgreSQL (M23-FR-02, API-09)', () => {
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

  it('reconciles, surfaces a signed gap, and holds the RBAC gate, on real PostgreSQL', async () => {
    const sql = pgClient(client);
    const h = apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) });
    await h.seedOwner(E2E_TENANT, 'u-owner');
    await h.provisionRole(E2E_TENANT, 'u-mgr', 'store_manager');

    // A distinct invoice id per run so an append-only database keeps runs apart (§35).
    const inv = invoice({ invoiceId: `INV-${E2E_TENANT}`, number: `INV/${E2E_TENANT}` });
    expect((await issueNote(h, E2E_TENANT, 'u-owner', note('E2E-CN1', 50_00, 4_50, { invoice: inv }))).status).toBe(201);

    const agreed = (await reconcile(h, E2E_TENANT, 'u-owner', '2026-06', '5000', '900')).body as NoteRecon;
    expect(agreed.creditedTaxableMinor).toBe(5000);
    expect(agreed.creditedTaxMinor).toBe(900);
    expect(agreed.reconciles).toBe(true);

    const drift = (await reconcile(h, E2E_TENANT, 'u-owner', '2026-06', '4000', '900')).body as NoteRecon;
    expect(drift.differenceMinor).toBe(1000); // notes 5000 taxable vs ledger 4000
    expect(drift.reconciles).toBe(false);

    // Least privilege holds against the real database too.
    expect((await reconcile(h, E2E_TENANT, 'u-mgr', '2026-06', '5000', '900')).status).toBe(403);
  });
});
