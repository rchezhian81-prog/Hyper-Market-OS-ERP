import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { MemoryIdempotencyStore, SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { InMemoryEventStore, SqlEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/index';
import { planAccountOpenings, executeAccountOpenings, readBackAccountOpenings, type ExtractTrialBalance } from '../../packages/migration/src/index';

/**
 * **GT-05 — the books open from the old system's trial balance (MG-08 "accounting openings" · MG-06 · §17.1 "trial balance /
 * control accounts" · §17.2 "zero unexplained difference in mandatory financial control totals" · §28 · QG-07 · hard rules
 * #2 #10 · P-08).**
 *
 * Through the real routes, as named people, on the in-memory store and — with DATABASE_URL — on REAL PostgreSQL:
 *
 *   1. the operator RECORDS the old trial balance (one balance per ledger account, mapped to this system's accounts); an
 *      unbalanced one, an account twice, a debit-and-credit line and a cashier are refused by name; recording is NOT the books;
 *   2. a SECOND finance person signs it off against the old system's PRINTED totals — the recorder cannot, a store manager
 *      cannot, a total that differs by a paisa is refused and nothing posts — and only then ONE opening journal goes through
 *      the finance posting path;
 *   3. the ledger reads back account by account and agrees with the old trial balance; the creditors' control figure sits on
 *      the opening clearing account until the supplier bills (the sub-ledger) are signed and posted, when it comes to nothing;
 *   4. a re-send, a second sign-off and a restart double nothing; different figures under the same load are a visible 409.
 * Synthetic data only.
 */

const OPERATOR = 'u-loader';   // owner: records the trial balance
const ACCOUNTANT = 'u-acct';   // a second finance person: signs it off
const MANAGER = 'u-mgr';       // store_manager: no authority to sign the accounts
const CASHIER = 'u-cash';
const LOAD = 'load-2026-10-10';
const OPENING_DATE = '2026-10-10';

/** A synthetic old trial balance: the creditors' control figure is carried on the opening clearing account (the supplier bills
 *  carry the detail), every other ledger at its balance. Debits = credits = 80 000 rupees. */
const TB: ExtractTrialBalance = {
  lines: [
    { accountCode: 'inventory', accountName: 'Stock in trade', debitMinor: 5_000_000, creditMinor: 0 },
    { accountCode: 'bank', accountName: 'Bank — current account', debitMinor: 2_000_000, creditMinor: 0 },
    { accountCode: 'cash_in_hand', accountName: 'Cash in hand', debitMinor: 150_000, creditMinor: 0 },
    { accountCode: 'sundry_debtors', accountName: 'Sundry debtors', debitMinor: 850_000, creditMinor: 0 },
    { accountCode: 'opening_balances', accountName: 'Sundry creditors (control — bills loaded per supplier)', debitMinor: 0, creditMinor: 900_000 },
    { accountCode: 'gst_output_payable', accountName: 'GST output payable', debitMinor: 0, creditMinor: 100_000 },
    { accountCode: 'capital', accountName: 'Proprietor\'s capital', debitMinor: 0, creditMinor: 7_000_000 },
  ],
  oldSystemTotals: { debitMinor: 8_000_000, creditMinor: 8_000_000, accountCount: 7 },
};
const BILLS = [{ supplierId: 'SUP-1', openingId: 'OB-1', amountMinor: 600_000 }, { supplierId: 'SUP-2', openingId: 'OB-2', amountMinor: 300_000 }];

let pool: Pool | undefined;
const DATABASE_URL = process.env['DATABASE_URL'];
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });

interface Backing { readonly store: EventStore; readonly idempotency: MemoryIdempotencyStore | SqlIdempotencyStore }
const backings: { name: string; backing: () => Backing }[] = [
  { name: 'the in-memory event store', backing: () => ({ store: new InMemoryEventStore(), idempotency: new MemoryIdempotencyStore() }) },
];
if (DATABASE_URL !== undefined) {
  backings.push({ name: 'real PostgreSQL', backing: () => { const sql = pgPoolClient(pool!); return { store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }; } });
}

type Reply = { status: number; body: unknown };
const codeOf = (r: Reply): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
interface ReadBody { signed: boolean; posted: boolean; agrees: boolean; ledger: { accountCode: string; debitMinor: number; creditMinor: number }[]; differences: { check: string; key: string; actual: number | null }[] }

async function shop(h: ApiHarness, t: string) {
  await h.seedOwner(t, OPERATOR);
  await h.provisionRole(t, ACCOUNTANT, 'accountant');
  await h.provisionRole(t, MANAGER, 'store_manager');
  await h.provisionRole(t, CASHIER, 'cashier');
  let n = 0;
  const call = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown, key?: string): Promise<Reply> =>
    h.request({ method, path, userId, tenantId: t, ...(method === 'GET' ? {} : { idempotencyKey: key ?? `k-${n += 1}` }), ...(body === undefined ? {} : { body }) });
  const record = (lines: unknown, userId = OPERATOR, key?: string) => call('POST', `/v1/finance/account-openings/${LOAD}`, userId, { openingDate: OPENING_DATE, lines }, key);
  const signOff = (userId: string, totals = { oldSystemDebitMinor: 8_000_000, oldSystemCreditMinor: 8_000_000, accountCount: 7 }, key?: string) =>
    call('POST', `/v1/finance/account-openings/${LOAD}/sign-off`, userId, { ...totals, note: 'agrees to the printed trial balance' }, key);
  const read = async (userId = ACCOUNTANT): Promise<ReadBody> => (await call('GET', `/v1/finance/account-openings/${LOAD}`, userId)).body as ReadBody;
  const openingJournals = async (): Promise<number> =>
    (await h.store.readStream(t, 'finance', { type: 'JournalPosted' })).filter((e) => (e.event.payload as { entryId?: string }).entryId === `opening-${LOAD}`).length;
  return { call, record, signOff, read, openingJournals };
}

const req = (t: string) => ({
  target: { targetId: 'rehearsal-gt05', tenantId: t, kind: 'rehearsal' as const, label: 'GT-05 rehearsal tenant' },
  tenantId: t, demoTenantIds: [], operator: OPERATOR, extractSealed: true, loadId: LOAD, receivedOnDate: OPENING_DATE,
});

describe.each(backings)('GT-05 the books open from the old trial balance — on $name', ({ backing }) => {
  it('recorded by the operator, signed off by a second finance person against the printed totals, posted once, and the ledger agrees account by account', async () => {
    const t = randomUUID();
    const h = apiHarness(backing());
    const s = await shop(h, t);

    // 1. Refused by name: a cashier; a trial balance that does not balance; an account twice; a debit AND a credit.
    expect((await s.record(TB.lines, CASHIER)).status).toBe(403);
    const unbalanced = await s.record(TB.lines.map((l) => (l.accountCode === 'capital' ? { ...l, creditMinor: 6_999_999 } : l)));
    expect(codeOf(unbalanced)).toBe('trial_balance_not_usable');
    expect((unbalanced.body as { error: { whatHappened: string } }).error.whatHappened).toMatch(/differ by 1 paise/);
    expect(codeOf(await s.record([...TB.lines, TB.lines[0]!]))).toBe('trial_balance_not_usable');
    expect(codeOf(await s.record([{ ...TB.lines[0]!, creditMinor: 5 }, ...TB.lines.slice(1)]))).toBe('trial_balance_not_usable');

    // The operator records it through the migration phase — recorded, NOT the books.
    const plan = planAccountOpenings(TB, req(t));
    if (!plan.ok) throw new Error(plan.detail);
    const recorded = await executeAccountOpenings(h, plan);
    expect(recorded).toMatchObject({ ok: true, status: 201, signed: false });
    let rb = await s.read();
    expect(rb).toMatchObject({ signed: false, posted: false, agrees: false, ledger: [] });
    expect(await s.openingJournals()).toBe(0);
    expect((await readBackAccountOpenings(h, TB, req(t))).signed).toBe(false);
    // Sent again: the same record. Different figures under the same load: a visible conflict, never an overwrite.
    expect((await s.record(TB.lines)).body).toMatchObject({ alreadyRecorded: true });
    expect(codeOf(await s.record(TB.lines.map((l) => (l.accountCode === 'bank' ? { ...l, debitMinor: 2_000_001 } : l === TB.lines[6] ? { ...l, creditMinor: 7_000_001 } : l))))).toBe('account_openings_conflict');

    // 2. The sign-off: never the recorder, never someone without the authority to sign the accounts; the totals must agree.
    const self = await s.signOff(OPERATOR);
    expect(self.status).toBe(403);
    expect(codeOf(self)).toBe('signer_recorded_the_openings');
    expect((await s.signOff(MANAGER)).status).toBe(403);
    const short = await s.signOff(ACCOUNTANT, { oldSystemDebitMinor: 8_000_000, oldSystemCreditMinor: 7_999_999, accountCount: 7 });
    expect(codeOf(short)).toBe('opening_total_differs');
    expect(codeOf(await s.signOff(ACCOUNTANT, { oldSystemDebitMinor: 8_000_000, oldSystemCreditMinor: 8_000_000, accountCount: 6 }))).toBe('opening_total_differs');
    expect(await s.openingJournals()).toBe(0); // nothing posted by a refused sign-off
    const signed = await s.signOff(ACCOUNTANT, undefined, 'sign-1');
    expect(signed.status).toBe(201);
    expect(signed.body).toMatchObject({ signOff: { signedBy: ACCOUNTANT, entryId: `opening-${LOAD}`, accountCount: 7 }, alreadySigned: false });
    expect(await s.openingJournals()).toBe(1);

    // 3. The ledger, account by account, IS the old trial balance; only the clearing account is open until the bills are in.
    rb = await s.read();
    expect(rb).toMatchObject({ signed: true, posted: true });
    expect(rb.ledger).toEqual(TB.lines.map((l) => ({ accountCode: l.accountCode, debitMinor: l.debitMinor, creditMinor: l.creditMinor })).sort((a, b) => (a.accountCode < b.accountCode ? -1 : 1)));
    expect(rb.differences).toEqual([expect.objectContaining({ check: 'opening_clearing', key: 'opening_balances', actual: -900_000 })]);
    expect(rb.agrees).toBe(false);
    const mine = await readBackAccountOpenings(h, TB, req(t));
    expect(mine.signed).toBe(true);
    expect(mine.differences.map((d) => d.check)).toEqual(['opening_clearing']);

    // The supplier bills: recorded per supplier, signed off against the creditors' list, posted through the accountant's map.
    for (const b of BILLS) {
      expect((await s.call('POST', `/v1/purchase/suppliers/${b.supplierId}`, OPERATOR, { name: `Synthetic Traders ${b.supplierId}` })).status).toBeLessThan(300);
      expect((await s.call('POST', `/v1/purchase/suppliers/${b.supplierId}/opening-balances/${b.openingId}`, OPERATOR, { billNumber: `BILL-${b.openingId}`, billDate: '2026-09-15', amountMinor: b.amountMinor, openingDate: OPENING_DATE, loadId: LOAD })).status).toBe(201);
    }
    expect((await s.call('POST', `/v1/purchase/opening-balances/sign-off/${LOAD}`, ACCOUNTANT, { expectedTotalMinor: 900_000, expectedCount: 2 })).status).toBe(201);
    expect((await s.call('PUT', '/v1/finance/posting-map', ACCOUNTANT, DEFAULT_RETAIL_POSTING_MAP)).status).toBe(200);
    expect((await s.call('POST', '/v1/finance/payables/post', ACCOUNTANT, {})).status).toBe(201);
    rb = await s.read();
    expect(rb.differences).toEqual([]);
    expect(rb.agrees).toBe(true);
    const full = await readBackAccountOpenings(h, TB, req(t));
    expect(full.differences).toEqual([]);
    expect(full.agrees).toBe(true);

    // 4. Signed again (a re-sent or interrupted sign-off): the same sign-off, still ONE opening journal; a restart reads the same.
    const again = await s.signOff(ACCOUNTANT, undefined, 'sign-2');
    expect(again.body).toMatchObject({ alreadySigned: true });
    expect(await s.openingJournals()).toBe(1);
    expect((await executeAccountOpenings(h, plan)).ok).toBe(true); // the operator re-running the phase: the same record, nothing new
    const restarted = apiHarness({ store: h.store });
    const after = (await restarted.request({ method: 'GET', path: `/v1/finance/account-openings/${LOAD}`, userId: OPERATOR, tenantId: t })).body as ReadBody;
    expect(after.ledger).toEqual(rb.ledger);
    expect(after.agrees).toBe(true);
  }, 180_000);

  it('the migration phase refuses a trial balance that is not the old system\'s whole one, before anything is sent', () => {
    const t = randomUUID();
    const missing = planAccountOpenings({ ...TB, lines: TB.lines.slice(1) }, req(t));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.problems.join(' ')).toMatch(/does not balance|not the whole trial balance/);
    const prod = planAccountOpenings(TB, { ...req(t), target: { ...req(t).target, kind: 'production' as never } });
    expect(prod.ok === false && prod.refusedBecause).toBe('production_target');
    const sameTwice = planAccountOpenings({ ...TB, lines: [...TB.lines, TB.lines[1]!] }, req(t));
    expect(sameTwice.ok === false && sameTwice.problems.some((p) => p.includes('appears twice'))).toBe(true);
  });
});
