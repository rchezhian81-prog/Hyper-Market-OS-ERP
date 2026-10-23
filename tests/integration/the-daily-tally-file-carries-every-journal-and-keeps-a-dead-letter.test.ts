import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import type { ApiHarness } from '../support/api-harness';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/index';
import { validateTallyImport } from '../../packages/tally-export/src/index';

// OB-293 (owner, 23 Oct 2026: "a daily Tally import file first") · M23-FR-04 · M32-FR-04 · D10-FR-06 · D14-FR-03 · P-08.
// Every journal the ledger posts for a day — the day book's sales, cash and card vouchers, a journal posted by hand — goes
// to the accountant as ONE Tally import file through a STORED outbox: queued once the shop day has ended, waiting (not
// failing) until the accountant names the Tally ledgers, DEAD-LETTERED by name when a journal touches a ledger nobody
// named (never lost, never deleted, raised to the owner), REQUEUED as a new posting once a person says what they fixed,
// then ready to download (recorded who took it). The month-end evidence pack reads the real dead-letter count; a typed
// number is refused. A late journal goes in the day's NEXT file, once. In memory and on real PostgreSQL, with a cold restart.

const backings = useRestartableBackings();
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const DAY = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10); // ended in every time zone
const TODAY = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10); // the shop's own day (IST) — not yet ended
const PERIOD = DAY.slice(0, 7);

interface OutboxView {
  postings: { postingId: string; day: string; sequence: number; state: string; attempts: number; lastFailure: string | null; waitingFor: string | null; corrects: string | null; journals: number; file: { fileName: string; byFamily: { family: string; vouchers: number }[]; gst: { accountCode: string; creditMinor: number }[] } | null }[];
  deadLetters: { postingId: string }[];
  counts: { posted: number; queued: number; deadLettered: number };
  deadLetteredByPeriod: { period: string; deadLettered: number }[];
  waitingFor: string | null;
}

async function shop(h: ApiHarness, T: string): Promise<void> {
  await h.seedOwner(T, 'u-owner');
  await h.provisionRole(T, 'u-acct', 'accountant');
  await h.provisionRole(T, 'u-cash', 'cashier');
  await h.provisionRole(T, 'u-mgr', 'store_manager');
}

const sale = (saleId: string, day: string, totalMinor: number, tenders: readonly Record<string, unknown>[]) => ({
  saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', cashierId: 'u-cash', tradingDay: day, committedAt: `${day}T06:30:00.000Z`,
  totalMinor, currency: 'INR', packVersion: 1,
  lines: [{ productId: 'P1', quantityMinor: 1, uom: 'each', unitPriceMinor: totalMinor, lineTotalMinor: totalMinor, taxRateBps: 1800 }],
  tenders,
});

describe.each(backings)('the daily Tally file outbox (OB-293 · M23-FR-04) — on $name', ({ harness }) => {
  it('queues each ended day, waits for the ledger names, dead-letters an unnamed ledger by name, requeues, and hands the accountant an importable file; a restart reads the same', async () => {
    const h = harness();
    const T = randomUUID();
    await shop(h, T);
    const call = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown, query?: Record<string, string>) =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });

    for (const [id, day, total, tenders] of [
      ['S1', DAY, 118_000, [{ kind: 'cash', amountMinor: 118_000 }]],
      ['S2', DAY, 59_000, [{ kind: 'card', amountMinor: 59_000, ref: 'APPR-0001' }]],
      ['S3', TODAY, 11_800, [{ kind: 'cash', amountMinor: 11_800 }]],
    ] as const) {
      const r = await h.request({ method: 'POST', path: '/v1/sales', userId: 'u-cash', tenantId: T, idempotencyKey: `bank-${id}`, body: sale(id, day, total, tenders) });
      expect(r.status, JSON.stringify(r.body)).toBe(202);
    }
    expect((await call('PUT', '/v1/finance/posting-map', 'u-acct', DEFAULT_RETAIL_POSTING_MAP)).status).toBeLessThan(300);
    for (const d of [DAY, TODAY]) {
      const posted = await call('POST', `/v1/finance/day-book/${d}/post`, 'u-acct', {});
      expect(posted.status, JSON.stringify(posted.body)).toBeLessThan(300);
      expect((posted.body as { exceptions: unknown[] }).exceptions).toEqual([]);
    }
    // A journal posted by hand on the same day — a different family, the same file.
    const manual = { entryId: `manual-${T.slice(0, 8)}`, period: PERIOD, documentDate: DAY, narrative: 'Petty cash spent on shop cleaning, voucher PC-7', postedBy: 'u-acct',
      lines: [{ accountCode: 'shop_expenses', debitMinor: 5_000, creditMinor: 0 }, { accountCode: 'cash_in_hand', debitMinor: 0, creditMinor: 5_000 }] };
    expect((await call('POST', '/v1/finance/journals', 'u-acct', manual)).status).toBe(201);

    const outbox = async (who = 'u-acct') => {
      const r = await call('GET', '/v1/finance/tally/outbox', who);
      expect(r.status).toBe(200);
      return r.body as OutboxView;
    };
    expect((await outbox()).postings).toEqual([]);
    // Permissions: a cashier cannot read the Tally files; a store manager reads but cannot run or requeue.
    expect((await call('GET', '/v1/finance/tally/outbox', 'u-cash')).status).toBe(403);
    expect((await call('POST', '/v1/finance/tally/outbox/run', 'u-mgr', {})).status).toBe(403);

    // 1. Queued, waiting for the accountant's ledger names — nothing attempted, nothing lost; today's day is not queued.
    const first = (await call('POST', '/v1/finance/tally/outbox/run', 'u-acct', {})).body as { queued: string[]; waitingFor?: string };
    expect(first.queued).toEqual([`tally-day:${DAY}:1`]);
    expect(first.waitingFor).toBe('ledger_names');
    const waiting = await outbox('u-mgr');
    expect(waiting.postings).toHaveLength(1);
    expect(waiting.postings[0]).toMatchObject({ state: 'queued', attempts: 0, waitingFor: 'ledger_names', journals: 4 });
    expect(waiting.waitingFor).toBe('ledger_names');

    // 2. Half the ledgers named: the day is REJECTED by name into the dead letter (no retries burned) and raised to the owner.
    const codes = (await call('GET', `/v1/finance/periods/${PERIOD}/trial-balance`, 'u-acct')).body as { rows: { account: string }[] };
    const accounts = codes.rows.map((r) => r.account);
    expect(accounts).toEqual(expect.arrayContaining(['cash_in_hand', 'card_receivable', 'sales_revenue', 'gst_output_cgst', 'gst_output_sgst', 'sales_clearing', 'shop_expenses']));
    const half = Object.fromEntries(accounts.filter((a) => a !== 'shop_expenses').map((a) => [a, `Tally ${a}`]));
    expect((await call('POST', '/v1/finance/tally/ledger-names', 'u-acct', { companyName: 'SRE Hyper Market (synthetic)', names: half, voucherTypes: { nonsense: 'Sales' } })).status).toBe(400);
    expect((await call('POST', '/v1/finance/tally/ledger-names', 'u-acct', { companyName: 'SRE Hyper Market (synthetic)', names: half })).status).toBe(201);
    const second = (await call('POST', '/v1/finance/tally/outbox/run', 'u-acct', {})).body as { deadLettered: string[] };
    expect(second.deadLettered).toEqual([`tally-day:${DAY}:1`]);
    const dead = await outbox();
    expect(dead.counts).toEqual({ posted: 0, queued: 0, deadLettered: 1 });
    expect(dead.postings[0]!.lastFailure).toMatch(/shop_expenses/);
    expect(dead.postings[0]!.attempts).toBe(1);
    expect(dead.deadLetteredByPeriod).toEqual([{ period: PERIOD, deadLettered: 1 }]);
    const alerts = (await call('GET', '/v1/platform/alerts', 'u-owner')).body as { alerts?: { alert: { alertId: string } }[] };
    expect(JSON.stringify(alerts)).toContain(`tally-dead-letter:tally-day:${DAY}:1`);
    expect(codeOf(await call('GET', `/v1/finance/tally/files/tally-day:${DAY}:1`, 'u-acct'))).toBe('tally_file_not_ready');

    // The month-end evidence pack reads the REAL count: a typed number is refused; the pack is not signable.
    const totals = [{ name: 'Sales', ledgerMinor: 100, postedMinor: 100, method: 'sales ledger vs bank credits' }];
    expect(codeOf(await call('POST', `/v1/finance/periods/${PERIOD}/evidence-pack`, 'u-acct', { totals, tradingDayCutoff: `${PERIOD}-01T00:00:00Z`, deadLetteredCount: 0 }))).toBe('dead_lettered_count_is_read_not_typed');
    const blocked = (await call('POST', `/v1/finance/periods/${PERIOD}/evidence-pack`, 'u-acct', { totals, tradingDayCutoff: `${PERIOD}-01T00:00:00Z` })).body as { signable: boolean; deadLetteredFrom: string };
    expect(blocked.signable).toBe(false);
    expect(blocked.deadLetteredFrom).toMatch(/Tally outbox/);

    // 3. The accountant names the last ledger (and a voucher type), then REQUEUES the day saying what was fixed.
    expect((await call('POST', '/v1/finance/tally/ledger-names', 'u-acct', { companyName: 'SRE Hyper Market (synthetic)', names: { ...half, shop_expenses: 'Shop Expenses' }, voucherTypes: { sales: 'Sales' } })).status).toBe(201);
    expect(codeOf(await call('POST', `/v1/finance/tally/outbox/tally-day:${DAY}:1/requeue`, 'u-acct', {}))).toBe('requeue_needs_a_reason');
    expect((await call('POST', `/v1/finance/tally/outbox/tally-day:${DAY}:1/requeue`, 'u-mgr', { reason: 'x' })).status).toBe(403);
    const requeued = await call('POST', `/v1/finance/tally/outbox/tally-day:${DAY}:1/requeue`, 'u-acct', { reason: 'named the ledger for shop expenses' });
    expect(requeued.status, JSON.stringify(requeued.body)).toBe(201);
    expect((await call('POST', `/v1/finance/tally/outbox/tally-day:${DAY}:1/requeue`, 'u-acct', { reason: 'again' })).body).toMatchObject({ requeued: false, alreadyRequeuedAs: `tally-day:${DAY}:1:r1` });
    const third = (await call('POST', '/v1/finance/tally/outbox/run', 'u-acct', {})).body as { posted: string[] };
    expect(third.posted).toEqual([`tally-day:${DAY}:1:r1`]);

    const ready = await outbox();
    // The dead letter is never emptied: the original stays beside its correction.
    expect(ready.deadLetters.map((d) => d.postingId)).toEqual([`tally-day:${DAY}:1`]);
    expect(ready.deadLetteredByPeriod).toEqual([{ period: PERIOD, deadLettered: 0 }]);
    const posted = ready.postings.find((p) => p.postingId === `tally-day:${DAY}:1:r1`)!;
    expect(posted).toMatchObject({ state: 'posted', corrects: `tally-day:${DAY}:1` });
    expect(posted.file!.fileName).toBe(`sre-tally-${DAY}-01.xml`);
    expect(posted.file!.byFamily.map((f) => f.family)).toEqual(['sales', 'cash', 'bank', 'general']);
    expect(posted.file!.gst.map((g) => g.accountCode)).toEqual(['gst_output_cgst', 'gst_output_sgst']);
    expect(posted.file!.gst.reduce((s, g) => s + g.creditMinor, 0)).toBe(27_000); // 18% inside ₹1,770

    // The download: an importable file, every voucher keyed by the shop's own journal id, the sales voucher a "Sales" one.
    const file = await call('GET', `/v1/finance/tally/files/tally-day:${DAY}:1:r1`, 'u-acct');
    expect(file.status).toBe(200);
    const f = file.body as { xml: string; controlTotals: { voucherCount: number; debitMinor: number; creditMinor: number }; sha256: string; downloadedBefore: unknown[] };
    expect(validateTallyImport(f.xml, f.controlTotals).ok).toBe(true);
    expect(f.controlTotals.voucherCount).toBe(4); // the day's sales, its cash, its card money, and the hand journal
    expect(f.xml).toContain(`REMOTEID="sre:${manual.entryId}"`);
    expect(f.xml).toMatch(/VCHTYPE="Sales"/);
    expect(f.downloadedBefore).toEqual([]);
    expect((await call('GET', `/v1/finance/tally/files/tally-day:${DAY}:1:r1`, 'u-mgr')).body).toMatchObject({ downloadedBefore: [expect.objectContaining({ by: 'u-acct' })] });
    const evidence = (await call('POST', `/v1/finance/periods/${PERIOD}/evidence-pack`, 'u-acct', { totals, tradingDayCutoff: `${PERIOD}-01T00:00:00Z` })).body as { signable: boolean };
    expect(evidence.signable).toBe(true);

    // 4. A late journal for the same day goes in the day's NEXT file, once; running again sends nothing twice.
    const late = { ...manual, entryId: `${manual.entryId}-late`, narrative: 'Late petty cash voucher PC-8 for the shop cleaning' };
    expect((await call('POST', '/v1/finance/journals', 'u-acct', late)).status).toBe(201);
    const fourth = (await call('POST', '/v1/finance/tally/outbox/run', 'u-acct', {})).body as { queued: string[]; posted: string[] };
    expect(fourth.queued).toEqual([`tally-day:${DAY}:2`]);
    expect(fourth.posted).toEqual([`tally-day:${DAY}:2`]);
    expect((await call('POST', '/v1/finance/tally/outbox/run', 'u-acct', {})).body).toMatchObject({ queued: [], posted: [] });
    expect((await call('GET', `/v1/finance/tally/outbox/periods/${PERIOD}`, 'u-acct')).body).toMatchObject({ deadLettered: 0, posted: 2 });

    // A cold restart: the same queue, the same dead letter, the very same file.
    const h2 = harness(h);
    const again = await h2.request({ method: 'GET', path: '/v1/finance/tally/outbox', userId: 'u-acct', tenantId: T });
    expect((again.body as OutboxView).counts).toEqual({ posted: 2, queued: 0, deadLettered: 1 });
    const file2 = await h2.request({ method: 'GET', path: `/v1/finance/tally/files/tally-day:${DAY}:1:r1`, userId: 'u-acct', tenantId: T });
    expect((file2.body as { xml: string; sha256: string }).sha256).toBe(f.sha256);
    expect(codeOf(await h2.request({ method: 'GET', path: '/v1/finance/tally/files/nope', userId: 'u-acct', tenantId: T }))).toBe('not_found');
  }, 120_000);
});
