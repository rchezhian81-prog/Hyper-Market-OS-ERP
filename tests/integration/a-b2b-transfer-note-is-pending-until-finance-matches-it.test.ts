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
 * **OB-41 "A" (owner, 11 Oct 2026) · FUL-09 · M22-FR-04 — a business customer pays through the portal by a BANK-TRANSFER
 * NOTE; it is pending, and never reduces what is owed, until finance — a second person — matches it to money its own bank
 * statement shows (P-04 · §28 · hard rules #2 #6 #10).**
 *
 * On the real API, in memory and (with DATABASE_URL) on real PostgreSQL:
 *   • the caterer, on its own login with the `make_payment` grant, notes a transfer against its invoice — PENDING: its
 *     balance, its statement and the ledger the credit check reads are unchanged; a login without the grant, a reach for
 *     another account, a second note on the same bank reference and a changed re-send are refused;
 *   • the customer cannot confirm its own money (no finance authority); a store manager cannot either;
 *   • finance sees the note in its queue; a match whose amount or reference differs from the note is refused by name and
 *     the note stays pending; the exact match records the money ONCE through the collection path — the invoice is settled,
 *     the balance falls to zero, a re-sent match changes nothing, and the books hold one postable receipt;
 *   • a note finance finds no money for is REJECTED with a reason, kept on record, never matched later; the customer sees
 *     every note's state.
 */

const OWNER = 'u-owner'; const ACCT = 'u-acct'; const MGR = 'u-mgr'; const CUST_LOGIN = 'u-caterer'; const VIEW_ONLY = 'u-caterer-viewer'; const OTHER_LOGIN = 'u-canteen';
const RICE = { lineId: 'l1', productId: 'rice', description: 'Ponni rice 25kg', unitPriceMinor: 10_000, taxRateBps: 500 };
const INVOICE_GROSS = 5 * 10_000 + 2_500; // 5 bags at ₹100 + 5% GST
const UTR = 'UTR2026101100042';
const codeOf = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } }).error?.code;

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

describe.each(backings)('OB-41 — a B2B bank-transfer note is pending until finance matches it — on $name', ({ harness }) => {
  it('noted on the customer\'s own login, pending and owed in full; refused when duplicated, mismatched or self-confirmed; matched once by finance; rejected notes kept', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, OWNER);
    await h.enableFeature(T, 'b2b');
    await h.provisionRole(T, ACCT, 'accountant');
    await h.provisionRole(T, MGR, 'store_manager');
    for (const u of [CUST_LOGIN, VIEW_ONLY, OTHER_LOGIN]) await h.provisionRole(T, u, 'b2b_customer');
    const call = (method: 'GET' | 'POST', path: string, user: string, body?: unknown, key?: string, query?: Record<string, string>) =>
      h.request({ method, path, userId: user, tenantId: T, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: key ?? `${path}-${user}-${randomUUID()}` }), ...(query === undefined ? {} : { query }) });
    const ok = async (p: ReturnType<typeof call>, what: string) => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    const owed = async (): Promise<number> => ((await call('GET', '/v1/b2b-portal/me/account', CUST_LOGIN)).body as { outstandingMinor: number }).outstandingMinor;
    const today = new Date().toISOString().slice(0, 10);

    // The caterer is billed for 5 bags (a real tax invoice: the receivable, the AR ledger and the books' postable).
    await ok(call('POST', '/v1/inventory/movements', OWNER, { movementId: 'rice-in', productId: 'rice', locationId: 'S1', kind: 'received', quantityMinor: 20, uom: 'ea', occurredAt: new Date().toISOString(), enteredBy: OWNER }), 'stock');
    await ok(call('POST', '/v1/b2b/accounts/CATERER', OWNER, { creditLimitMinor: 10_000_000, paymentTermsDays: 30 }), 'terms');
    await ok(call('POST', `/v1/b2b-portal/customers/CATERER/logins/${CUST_LOGIN}`, OWNER, { grants: ['view_invoices', 'view_statement', 'make_payment'] }), 'bind payer');
    await ok(call('POST', `/v1/b2b-portal/customers/CATERER/logins/${VIEW_ONLY}`, OWNER, { grants: ['view_invoices', 'view_statement'] }), 'bind viewer');
    await ok(call('POST', `/v1/b2b-portal/customers/CANTEEN/logins/${OTHER_LOGIN}`, OWNER, { grants: ['view_invoices', 'make_payment'] }), 'bind other');
    await ok(call('POST', '/v1/b2b/documents/CATERER/quotations/q1', MGR, { lines: [{ ...RICE, qty: 5 }], locationId: 'S1' }), 'quotation');
    await ok(call('POST', '/v1/b2b/documents/CATERER/orders/so1', MGR, { fromQuotationId: 'q1' }), 'order');
    await ok(call('POST', '/v1/b2b/documents/CATERER/challans/dc1', MGR, { fromOrderId: 'so1', dispatched: { l1: 5 } }), 'challan');
    await ok(call('POST', '/v1/b2b/documents/CATERER/invoices/inv1', MGR, { fromOrderId: 'so1' }), 'invoice');
    expect(await owed()).toBe(INVOICE_GROSS);

    // ── 1 · The caterer notes its transfer — PENDING; nothing it owes changes.
    const noteBody = { amountMinor: INVOICE_GROSS, transferredOn: today, bankReference: UTR, against: ['inv1'] };
    const noted = await ok(call('POST', '/v1/b2b-portal/me/transfer-notes/tn-1', CUST_LOGIN, noteBody, 'tn-1'), 'transfer note');
    expect(noted.status).toBe(201);
    expect(noted.body).toMatchObject({ noteId: 'tn-1', customerId: 'CATERER', state: 'pending', outstandingMinor: INVOICE_GROSS, recordedBy: CUST_LOGIN });
    expect(await owed()).toBe(INVOICE_GROSS);
    expect(((await call('GET', '/v1/b2b-portal/me/invoices', CUST_LOGIN)).body as { invoices: { invoiceId: string; settledMinor: number }[] }).invoices).toEqual([expect.objectContaining({ invoiceId: 'inv1', settledMinor: 0 })]);

    // ── 2 · Refusals at the portal: no grant; another account (recorded); the same bank reference twice; a changed re-send.
    expect(codeOf(await call('POST', '/v1/b2b-portal/me/transfer-notes/tn-v', VIEW_ONLY, { ...noteBody, bankReference: 'UTR2026101100099' }))).toBe('no_grant');
    expect(codeOf(await call('POST', '/v1/b2b-portal/me/transfer-notes/tn-x', CUST_LOGIN, { ...noteBody, bankReference: 'UTR2026101100098' }, undefined, { customerId: 'CANTEEN' }))).toBe('not_your_data');
    expect(((await call('GET', '/v1/b2b-portal/probing', OWNER, undefined, undefined, { threshold: '1' })).body as { probing: unknown[] }).probing).toHaveLength(1);
    const dup = await call('POST', '/v1/b2b-portal/me/transfer-notes/tn-dup', CUST_LOGIN, { ...noteBody, bankReference: UTR.toLowerCase() });
    expect(dup.status).toBe(409);
    expect(codeOf(dup)).toBe('duplicate_bank_reference');
    expect(codeOf(await call('POST', '/v1/b2b-portal/me/transfer-notes/tn-dup2', OTHER_LOGIN, { ...noteBody, against: [] }))).toBe('duplicate_bank_reference');
    expect((await ok(call('POST', '/v1/b2b-portal/me/transfer-notes/tn-1', CUST_LOGIN, noteBody), 're-send')).body).toMatchObject({ alreadyRecorded: true, state: 'pending' });
    expect(codeOf(await call('POST', '/v1/b2b-portal/me/transfer-notes/tn-1', CUST_LOGIN, { ...noteBody, amountMinor: 1 }))).toBe('transfer_note_exists');
    expect(codeOf(await call('POST', '/v1/b2b-portal/me/transfer-notes/tn-future', CUST_LOGIN, { ...noteBody, bankReference: 'UTR2026101100097', transferredOn: '2999-01-01' }))).toBe('transfer_date_in_the_future');

    // ── 3 · Nobody confirms money on the customer's word: the customer and a store manager cannot match it.
    expect((await call('POST', '/v1/b2b/transfer-notes/tn-1/match', CUST_LOGIN, { receivedMinor: INVOICE_GROSS, receivedOn: today, bankReference: UTR })).status).toBe(403);
    expect((await call('POST', '/v1/b2b/transfer-notes/tn-1/match', MGR, { receivedMinor: INVOICE_GROSS, receivedOn: today, bankReference: UTR })).status).toBe(403);
    expect((await call('GET', '/v1/b2b/transfer-notes', CUST_LOGIN)).status).toBe(403);

    // ── 4 · Finance's queue shows it pending; a mismatch of amount or reference is refused and the note stays pending.
    const queue = (await call('GET', '/v1/b2b/transfer-notes', ACCT, undefined, undefined, { state: 'pending' })).body as { notes: { noteId: string; state: string }[]; pendingMinor: number };
    expect(queue.notes.map((n) => [n.noteId, n.state])).toEqual([['tn-1', 'pending']]);
    expect(queue.pendingMinor).toBe(INVOICE_GROSS);
    expect(codeOf(await call('POST', '/v1/b2b/transfer-notes/tn-1/match', ACCT, { receivedMinor: INVOICE_GROSS - 100, receivedOn: today, bankReference: UTR }))).toBe('amount_mismatch');
    expect(codeOf(await call('POST', '/v1/b2b/transfer-notes/tn-1/match', ACCT, { receivedMinor: INVOICE_GROSS, receivedOn: today, bankReference: 'UTR9999999999' }))).toBe('bank_reference_mismatch');
    expect(await owed()).toBe(INVOICE_GROSS);

    // ── 5 · The exact match: the money is recorded ONCE through the collection path; a re-sent match changes nothing.
    const matched = await ok(call('POST', '/v1/b2b/transfer-notes/tn-1/match', ACCT, { receivedMinor: INVOICE_GROSS, receivedOn: today, bankReference: UTR }, 'match-1'), 'match');
    expect(matched.body).toMatchObject({ state: 'matched', decidedBy: ACCT, receiptId: 'TN-tn-1', allocatedMinor: INVOICE_GROSS, unappliedMinor: 0, outstandingMinor: 0 });
    expect(await owed()).toBe(0);
    expect((await ok(call('POST', '/v1/b2b/transfer-notes/tn-1/match', ACCT, { receivedMinor: INVOICE_GROSS, receivedOn: today, bankReference: UTR }, 'match-2'), 're-match')).body).toMatchObject({ alreadyMatched: true });
    expect(await owed()).toBe(0);
    expect(((await call('GET', '/v1/b2b-portal/me/invoices', CUST_LOGIN)).body as { invoices: { invoiceId: string; settledMinor: number }[] }).invoices).toEqual([expect.objectContaining({ invoiceId: 'inv1', settledMinor: INVOICE_GROSS })]);
    // The books: the receipt reaches finance once, through the accountant's mapping.
    const map = (await call('GET', '/v1/finance/posting-map', ACCT)).body as { suggested: unknown };
    await ok(call('PUT', '/v1/finance/posting-map', ACCT, map.suggested), 'posting map');
    const posted = (await ok(call('POST', '/v1/finance/b2b/post', ACCT, {}), 'b2b post')).body as { posted: { b2b: { sourceId: string } }[]; exceptions: unknown[] };
    expect(posted.exceptions).toEqual([]);
    expect(posted.posted.map((j) => j.b2b.sourceId).filter((id) => id.startsWith('receipt:'))).toEqual(['receipt:CATERER:TN-tn-1']);
    expect(((await ok(call('POST', '/v1/finance/b2b/post', ACCT, {}), 'b2b post again')).body as { posted: unknown[] }).posted).toEqual([]);

    // ── 6 · A note finance finds no money for is rejected with a reason — kept, never matched later; the customer sees it.
    await ok(call('POST', '/v1/b2b-portal/me/transfer-notes/tn-2', CUST_LOGIN, { amountMinor: 10_000, transferredOn: today, bankReference: 'UTR2026101100043' }), 'second note');
    expect(codeOf(await call('POST', '/v1/b2b/transfer-notes/tn-2/reject', ACCT, {}))).toBe('rejection_needs_a_reason');
    await ok(call('POST', '/v1/b2b/transfer-notes/tn-2/reject', ACCT, { reason: 'no credit with this reference on the statement to 11 Oct' }), 'reject');
    expect(codeOf(await call('POST', '/v1/b2b/transfer-notes/tn-2/match', ACCT, { receivedMinor: 10_000, receivedOn: today, bankReference: 'UTR2026101100043' }))).toBe('transfer_note_rejected');
    expect(codeOf(await call('POST', '/v1/b2b/transfer-notes/tn-1/reject', ACCT, { reason: 'late' }))).toBe('transfer_note_matched');
    const mine = (await call('GET', '/v1/b2b-portal/me/transfer-notes', CUST_LOGIN)).body as { notes: { noteId: string; state: string; reason?: string }[]; pendingMinor: number; outstandingMinor: number };
    expect(mine.notes.map((n) => [n.noteId, n.state]).sort()).toEqual([['tn-1', 'matched'], ['tn-2', 'rejected']]);
    expect(mine.notes.find((n) => n.noteId === 'tn-2')!.reason).toMatch(/no credit/);
    expect(mine).toMatchObject({ pendingMinor: 0, outstandingMinor: 0 });
    // A person who holds BOTH a customer's portal login and finance authority still cannot confirm a note they wrote (§28).
    await h.provisionRole(T, 'u-both', 'b2b_customer');
    await h.provisionRole(T, 'u-both', 'accountant');
    await ok(call('POST', '/v1/b2b-portal/customers/CATERER/logins/u-both', OWNER, { grants: ['make_payment'] }), 'bind both');
    await ok(call('POST', '/v1/b2b-portal/me/transfer-notes/tn-3', 'u-both', { amountMinor: 5_000, transferredOn: today, bankReference: 'UTR2026101100044' }), 'note by both');
    const self = await call('POST', '/v1/b2b/transfer-notes/tn-3/match', 'u-both', { receivedMinor: 5_000, receivedOn: today, bankReference: 'UTR2026101100044' });
    expect(self.status).toBe(403);
    expect(codeOf(self)).toBe('maker_cannot_approve');
    expect(codeOf(await call('POST', '/v1/b2b/transfer-notes/tn-3/reject', 'u-both', { reason: 'mine' }))).toBe('maker_cannot_approve');
    // The canteen's login sees none of the caterer's notes.
    expect(((await call('GET', '/v1/b2b-portal/me/transfer-notes', OTHER_LOGIN)).body as { notes: unknown[] }).notes).toEqual([]);
  }, 60_000);
});
