import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { pgClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { issueCreditNote, DEFAULT_RETAIL_POSTING_MAP, type SourceInvoice } from '../../packages/finance/src/index';
import { financeNotesAdapter, b2bPostingAdapter } from '../../services/api/src/adapters';
import type { B2BJournal } from '../../services/finance/src/b2b-postings';

// M23-FR-02, API-09 (W4) — the PERIOD CREDIT-NOTE RECONCILIATION (CGST s.34 / GSTR-1). The credit notes ISSUED for a
// return period (grouped by the month they were ISSUED, never the invoice's month) are folded from the `CreditNoteIssued`
// ledger and compared against what the POSTED LEDGER carries for that period — the `b2b:credit_note` journals the
// accountant's posting run put on it, the same `JournalPosted` facts the month close reads — the difference EXACT and
// SIGNED, and every note of the period missing from that period's books NAMED with why. Before W4 the two ledger figures
// were typed into the query (`?ledgerTaxable=&ledgerTax=`); a request that still carries them is now refused by name.
// The value issued OUTSIDE the s.34(2) window stays out of the tax figures but visible. Real pipeline, real RBAC.

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

// M23-FR-02 · OB-678 (W3): the issue route looks up the business tax invoice head office holds (proved in
// tests/integration/w3-gst-notes-to-business-customers.test.ts). This suite is about the reconciliation, so it records its
// notes straight onto the CreditNoteIssued ledger, each worked by the same tested engine (issueCreditNote).
const issueNote = async (h: ApiHarness, tenant: string, body: Record<string, unknown>): Promise<{ status: number }> => {
  const result = issueCreditNote({
    noteId: String(body['noteId']), number: String(body['number']), kind: 'credit_note', invoice: body['invoice'] as SourceInvoice,
    customerId: String(body['customerId']), reason: 'goods_returned', taxableMinor: body['taxableMinor'] as number,
    taxes: body['taxes'] as SourceInvoice['taxes'], alreadyCreditedMinor: 0, issuedOn: String(body['issuedOn']),
  });
  if (!result.issued || result.note === undefined) return { status: 422 };
  await financeNotesAdapter({ store: h.store, now: () => String(body['issuedOn']) }).appendCreditNote(tenant, result.note);
  return { status: 201 };
};

// The accountant's credit-note rule (account names are this test's, not a suggestion — the CA signs the real ones off).
const NOTE_RULE = { kind: 'b2b:credit_note', legs: [{ account: 'sales_returns', side: 'debit', component: 'net' }, { account: 'gst_output', side: 'debit', component: 'tax' }, { account: 'trade_receivables', side: 'credit', component: 'total' }] };
const writeRule = async (h: ApiHarness, tenant: string, rule: unknown = NOTE_RULE) => {
  const r = await h.request({ method: 'PUT', path: '/v1/finance/posting-map', userId: 'u-owner', tenantId: tenant, idempotencyKey: `map-${JSON.stringify(rule)}`, body: { rules: [...DEFAULT_RETAIL_POSTING_MAP.rules, rule] } });
  expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
};

/** What the posting run puts on the ledger for one note: its value and GST debited, the receivable credited. */
const postedJournal = async (h: ApiHarness, tenant: string, noteId: string, taxableMinor: number, taxMinor: number, period = '2026-06', accounts = { net: 'sales_returns', tax: 'gst_output' }) => {
  const journal: B2BJournal = {
    entryId: `b2b:credit_note:C-1:${noteId}`, period, documentDate: '2026-06-15', narrative: `B2B credit note CN/${noteId} — customer C-1`,
    lines: [
      { accountCode: accounts.net, debitMinor: taxableMinor, creditMinor: 0 },
      { accountCode: accounts.tax, debitMinor: taxMinor, creditMinor: 0 },
      { accountCode: 'trade_receivables', debitMinor: 0, creditMinor: taxableMinor + taxMinor },
    ],
    postedBy: 'u-acct', b2b: { sourceId: `credit_note:C-1:${noteId}`, kind: 'b2b:credit_note', customerId: 'C-1' },
  };
  await b2bPostingAdapter({ store: h.store, now: () => '2026-06-30T10:00:00.000Z' }).appendJournal(tenant, journal);
};

const reconcile = (h: ApiHarness, tenant: string, userId: string, period: string) =>
  h.request({ method: 'GET', path: '/v1/finance/credit-notes/reconciliation', userId, tenantId: tenant, query: { period } });

interface NoteRecon {
  period: string; notesIssued: number; creditedTaxableMinor: number; creditedTaxMinor: number;
  outsideTaxWindowMinor: number; reconciles: boolean; differenceMinor: number; detail: string; notesTotalMinor: number;
  ledger: { read: string; derivation: string; journals: string[]; totalMinor: number; taxableMinor: number; taxMinor: number; split: string };
  notInTheBooks: { noteId: string; number: string; grossMinor: number; state: string; postedToPeriod?: string }[];
}

// Two adjustable notes issued in 2026-06: 50,00 + 30,00 taxable (proportional 4,50 / 2,70 tax each side).
async function twoNotes(h: ApiHarness, tenant: string) {
  expect((await issueNote(h, tenant, note('CN-1', 50_00, 4_50))).status).toBe(201);
  expect((await issueNote(h, tenant, note('CN-2', 30_00, 2_70))).status).toBe(201);
}

describe('period credit-note reconciliation: the notes against the POSTED ledger, exact and signed (M23-FR-02)', () => {
  it('reconciles when the posted ledger carries exactly the period\'s notes — read from the journals, never typed', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await twoNotes(h, A);
    await writeRule(h, A);
    await postedJournal(h, A, 'CN-1', 5000, 900);
    await postedJournal(h, A, 'CN-2', 3000, 540);

    const r = (await reconcile(h, A, 'u-owner', '2026-06')).body as NoteRecon;
    expect(r.notesIssued).toBe(2);
    expect(r.creditedTaxableMinor).toBe(8000);
    expect(r.creditedTaxMinor).toBe(1440);
    expect(r.ledger).toMatchObject({ read: 'posted_ledger', totalMinor: 9440, taxableMinor: 8000, taxMinor: 1440, split: 'by_account', journals: ['b2b:credit_note:C-1:CN-1', 'b2b:credit_note:C-1:CN-2'] });
    expect(r.ledger.derivation).toContain('gst_output');
    expect(r.differenceMinor).toBe(0);
    expect(r.reconciles).toBe(true);
    expect(r.notInTheBooks).toEqual([]);
  });

  it('a note not yet in the books is a signed difference, and the note is named with why — never silent', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await twoNotes(h, A);

    // No posting map at all: the books carry nothing; the whole 94,40 is the gap, each note waits for the rule.
    const none = (await reconcile(h, A, 'u-owner', '2026-06')).body as NoteRecon;
    expect(none.ledger.totalMinor).toBe(0);
    expect(none.differenceMinor).toBe(9440);
    expect(none.reconciles).toBe(false);
    expect(none.detail).toContain('GSTR-2B');
    expect(none.notInTheBooks.map((n) => [n.number, n.state])).toEqual([['CN/CN-1', 'waiting_for_posting_rule'], ['CN/CN-2', 'waiting_for_posting_rule']]);

    // The rule written and one note posted: the other is the +35,40 gap, "not posted yet".
    await writeRule(h, A);
    await postedJournal(h, A, 'CN-1', 5000, 900);
    const half = (await reconcile(h, A, 'u-owner', '2026-06')).body as NoteRecon;
    expect(half.differenceMinor).toBe(3540);
    expect(half.notInTheBooks.map((n) => [n.number, n.state, n.grossMinor])).toEqual([['CN/CN-2', 'not_posted_yet', 3540]]);
  });

  it('a note posted to a LATER month (its own was closed) shows on both months with opposite signs, named', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await twoNotes(h, A);
    await writeRule(h, A);
    await postedJournal(h, A, 'CN-1', 5000, 900);
    await postedJournal(h, A, 'CN-2', 3000, 540, '2026-07');

    const june = (await reconcile(h, A, 'u-owner', '2026-06')).body as NoteRecon;
    expect(june.differenceMinor).toBe(3540);
    expect(june.notInTheBooks).toEqual([expect.objectContaining({ number: 'CN/CN-2', state: 'posted_to_another_period', postedToPeriod: '2026-07' })]);
    const july = (await reconcile(h, A, 'u-owner', '2026-07')).body as NoteRecon;
    expect(july.notesIssued).toBe(0);
    expect(july.ledger.totalMinor).toBe(3540);
    expect(july.differenceMinor).toBe(-3540); // the books carry more than the month's notes — signed, exact
  });

  it('with no separate GST account in the rule the split is "not known" — the whole value is still compared exactly', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await twoNotes(h, A);
    const oneAccount = { kind: 'b2b:credit_note', legs: [{ account: 'sales_returns', side: 'debit', component: 'net' }, { account: 'sales_returns', side: 'debit', component: 'tax' }, { account: 'trade_receivables', side: 'credit', component: 'total' }] };
    await writeRule(h, A, oneAccount);
    await postedJournal(h, A, 'CN-1', 5000, 900, '2026-06', { net: 'sales_returns', tax: 'sales_returns' });
    await postedJournal(h, A, 'CN-2', 3000, 500, '2026-06', { net: 'sales_returns', tax: 'sales_returns' }); // 40 short

    const r = (await reconcile(h, A, 'u-owner', '2026-06')).body as NoteRecon;
    expect(r.ledger).toMatchObject({ split: 'not_known', totalMinor: 9400, taxMinor: 0 });
    expect(r.ledger.derivation).toContain('not known');
    expect(r.differenceMinor).toBe(40);
  });

  it('counts notes issued OUTSIDE the s.34(2) window separately (commercially real, fiscally not)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await twoNotes(h, A);
    // A note issued in 2026-06 against an FY2024-25 invoice (s.34(2) deadline 2025-11-30, already past) is commercial-only.
    const old = invoice({ invoiceId: 'INV-OLD', number: 'INV/2024/9', issuedOn: '2024-08-10', financialYear: '2024-25' });
    expect((await issueNote(h, A, note('CN-3', 20_00, 1_80, { invoice: old }))).status).toBe(201);
    await writeRule(h, A);
    await postedJournal(h, A, 'CN-1', 5000, 900);
    await postedJournal(h, A, 'CN-2', 3000, 540);

    const r = (await reconcile(h, A, 'u-owner', '2026-06')).body as NoteRecon;
    expect(r.notesIssued).toBe(3);              // all three fall in 2026-06
    expect(r.creditedTaxableMinor).toBe(8000);  // CN-3 excluded from the adjustable total
    expect(r.outsideTaxWindowMinor).toBe(2000); // …but surfaced here
    expect(r.reconciles).toBe(true);
  });

  it('refuses without a period, and refuses typed ledger figures by name (a reconciliation reads, it never takes them)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await twoNotes(h, A);
    const base = { method: 'GET' as const, path: '/v1/finance/credit-notes/reconciliation', userId: 'u-owner', tenantId: A };
    const code = (r: { body: unknown }) => (r.body as { error: { code: string } }).error.code;
    expect(code(await h.request({ ...base, query: {} }))).toBe('reconciliation_needs_a_period');
    expect(code(await h.request({ ...base, query: { period: 'June' } }))).toBe('reconciliation_needs_a_period');
    expect(code(await h.request({ ...base, query: { period: '2026-13' } }))).toBe('reconciliation_needs_a_period');
    const typed = await h.request({ ...base, query: { period: '2026-06', ledgerTaxable: '8000', ledgerTax: '1440' } });
    expect(typed.status).toBe(400);
    expect(code(typed)).toBe('ledger_is_read_not_typed');
    expect(code(await h.request({ ...base, query: { period: '2026-06', ledgerTax: '1440' } }))).toBe('ledger_is_read_not_typed');
  });

  it('gates the reconciliation on the credit-note tier — a manager reads period data but not this', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-mgr', 'store_manager'); // has finance.period.read, NOT finance.creditnote.issue
    await h.provisionRole(A, 'u-acct', 'accountant');   // has finance.creditnote.issue
    await h.provisionRole(A, 'u-cash', 'cashier');       // neither
    await twoNotes(h, A);

    expect((await reconcile(h, A, 'u-mgr', '2026-06')).status).toBe(403);
    expect((await reconcile(h, A, 'u-cash', '2026-06')).status).toBe(403);
    expect((await reconcile(h, A, 'u-acct', '2026-06')).status).toBe(200);
    expect((await reconcile(h, A, 'u-owner', '2026-06')).status).toBe(200);
  });

  it('keeps the fold tenant-scoped — another shop\'s notes and journals are never read', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.seedOwner(B, 'u-owner');
    await twoNotes(h, A);
    await writeRule(h, A);
    await postedJournal(h, A, 'CN-1', 5000, 900);

    const inB = (await reconcile(h, B, 'u-owner', '2026-06')).body as NoteRecon;
    expect(inB.notesIssued).toBe(0);
    expect(inB.ledger.totalMinor).toBe(0);
    expect(inB.reconciles).toBe(true);
    expect(((await reconcile(h, A, 'u-owner', '2026-06')).body as NoteRecon).notesIssued).toBe(2);
  });
});

// The same reconciliation end to end against real PostgreSQL — the CreditNoteIssued fold, the posted journals read back,
// the signed difference and the RBAC gate on the actual database. Skips (never passes quietly) without DATABASE_URL.
const DATABASE_URL = process.env['DATABASE_URL'];
const E2E_TENANT = `f${Date.now().toString(16).slice(-7)}-ffff-4fff-8fff-${'f'.repeat(12)}`;

describe.skipIf(!DATABASE_URL)('period credit-note reconciliation, end to end on real PostgreSQL (M23-FR-02, API-09)', () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL, options: '-c app.tenant_id=*' });
    await client.connect();
    const sql = pgClient(client);
    const dir = 'db/migrations';
    await runMigrations(sql, readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
  });
  afterAll(async () => { await client.end(); });

  it('reads the posted ledger, surfaces a signed gap, and holds the RBAC gate, on real PostgreSQL', async () => {
    const sql = pgClient(client);
    const h = apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) });
    await h.seedOwner(E2E_TENANT, 'u-owner');
    await h.provisionRole(E2E_TENANT, 'u-mgr', 'store_manager');

    const inv = invoice({ invoiceId: `INV-${E2E_TENANT}`, number: `INV/${E2E_TENANT}` });
    expect((await issueNote(h, E2E_TENANT, note('E2E-CN1', 50_00, 4_50, { invoice: inv }))).status).toBe(201);
    expect((await issueNote(h, E2E_TENANT, note('E2E-CN2', 10_00, 90, { invoice: inv }))).status).toBe(201);
    await writeRule(h, E2E_TENANT);
    await postedJournal(h, E2E_TENANT, 'E2E-CN1', 5000, 900);

    const drift = (await reconcile(h, E2E_TENANT, 'u-owner', '2026-06')).body as NoteRecon;
    expect(drift.ledger).toMatchObject({ totalMinor: 5900, taxableMinor: 5000, taxMinor: 900 });
    expect(drift.differenceMinor).toBe(1180); // E2E-CN2 (₹10 + ₹1.80) is not in the books
    expect(drift.notInTheBooks.map((n) => n.number)).toEqual(['CN/E2E-CN2']);

    await postedJournal(h, E2E_TENANT, 'E2E-CN2', 1000, 180);
    const agreed = (await reconcile(h, E2E_TENANT, 'u-owner', '2026-06')).body as NoteRecon;
    expect(agreed.reconciles).toBe(true);
    expect((await reconcile(h, E2E_TENANT, 'u-mgr', '2026-06')).status).toBe(403);
  });
});
