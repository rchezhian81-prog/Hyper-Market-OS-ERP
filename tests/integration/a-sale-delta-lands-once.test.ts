import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startRealCloud, type RealCloud } from '../support/real-store';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { MemoryIdempotencyStore } from '../../services/kernel/src/index';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/day-book';

/**
 * **A migration delta's MONEY lands once, with its source kept (audit GT-04 · MG-09 · QG-07).**
 *
 * The stock half was proven earlier (`a-delta-lands-once.test.ts`). This is the money half: bills the OLD till rang after
 * the final extract — a ₹1,180 cash sale (₹1,000 + 9 % CGST + 9 % SGST), a ₹236 UPI sale and a ₹118 cash return — are
 * posted through head office's own ledger mapping as the same vouchers the day book posts, dated the day they were rung.
 * Read back from the FINANCE domain (the day book for that day): the accounts move by exactly those amounts, and every
 * voucher names its legacy bill and its delta change. Re-sent under a NEW idempotency key — and again after the API
 * process is stopped and a new one started over the same PostgreSQL — nothing moves twice. A bill that does not add up,
 * a voided bill, and a sale with no ledger mapping are refused by name and never counted.
 *
 * Synthetic data only (hard rule #7): a fresh random tenant per run.
 */

const OWNER = 'u-owner';
const CUTOFF = '2026-10-09T00:00:00.000Z';
const DAY = '2026-10-09';
const SALES = [
  { changeKey: 'm-1', entity: 'sale', legacyId: 'BILL-7001', operation: 'insert', changedAt: '2026-10-09T10:15:00.000Z', deltaMinor: 1_180_00, netMinor: 1_000_00, cgstMinor: 90_00, sgstMinor: 90_00, tender: 'cash' },
  { changeKey: 'm-2', entity: 'sale', legacyId: 'BILL-7002', operation: 'insert', changedAt: '2026-10-09T11:40:00.000Z', deltaMinor: 236_00, netMinor: 200_00, cgstMinor: 18_00, sgstMinor: 18_00, tender: 'upi' },
  { changeKey: 'm-3', entity: 'sale', legacyId: 'BILL-7003', operation: 'insert', changedAt: '2026-10-09T12:05:00.000Z', deltaMinor: -118_00, netMinor: -100_00, cgstMinor: -9_00, sgstMinor: -9_00, tender: 'cash' },
];
const BAD = [
  { changeKey: 'm-bad-sum', entity: 'sale', legacyId: 'BILL-7004', operation: 'insert', changedAt: '2026-10-09T12:30:00.000Z', deltaMinor: 500_00, netMinor: 400_00, cgstMinor: 9_00, sgstMinor: 9_00, tender: 'cash' },
  { changeKey: 'm-void', entity: 'sale', legacyId: 'BILL-7001', operation: 'delete', changedAt: '2026-10-09T13:00:00.000Z', deltaMinor: -1_180_00, netMinor: -1_000_00, cgstMinor: -90_00, sgstMinor: -90_00, tender: 'cash' },
];

type Send = (key: string, changes?: readonly unknown[]) => Promise<{ status: number; body: unknown }>;
type Read = (path: string) => Promise<{ status: number; body: unknown }>;
interface DayBook { accounts: { account?: string; accountCode?: string; debitMinor: number; creditMinor: number }[] | Record<string, { debitMinor: number; creditMinor: number }>; journals: { entryId: string; kind: string; narrative: string; lines: { accountCode: string; debitMinor: number; creditMinor: number }[]; sources?: number }[] }

/** Net movement per account, summed from the day book's own journals (read from the finance domain). */
async function ledgerOf(read: Read): Promise<{ net: Record<string, number>; journals: DayBook['journals'] }> {
  const res = await read(`/v1/finance/day-book/${DAY}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const book = res.body as DayBook;
  const net: Record<string, number> = {};
  for (const j of book.journals) for (const l of j.lines) net[l.accountCode] = (net[l.accountCode] ?? 0) + l.debitMinor - l.creditMinor;
  return { net, journals: book.journals };
}

const EXPECTED_NET = {
  // Dr cash 1180 (sale) − 118 (refund) ; Dr UPI 236 ; clearing nets to 0 (tenders cover sales)
  cash_in_hand: 1_180_00 - 118_00,
  upi_receivable: 236_00,
  sales_clearing: 0,
  sales_revenue: -(1_000_00 + 200_00 - 100_00),
  gst_output_cgst: -(90_00 + 18_00 - 9_00),
  gst_output_sgst: -(90_00 + 18_00 - 9_00),
};

async function journey(send: Send, read: Read, restart: () => Promise<{ send: Send; read: Read }>): Promise<void> {
  // With no ledger mapping, the money is refused by name — not applied, not counted.
  const unmapped = await send('run-0');
  expect(unmapped.body).toMatchObject({ applied: 0, refused: 3 });
  expect((unmapped.body as { lines: { outcome: string; detail: string }[] }).lines.every((l) => l.outcome === 'refused_incomplete' && /ledger mapping/.test(l.detail))).toBe(true);

  // The accountant's mapping (the suggested one, adopted as the shop's own).
  const put = await read('PUT /v1/finance/posting-map');
  expect(put.status, JSON.stringify(put.body)).toBe(200);

  const applied = await send('run-1', [...SALES, ...BAD]);
  expect(applied.status, JSON.stringify(applied.body)).toBe(200);
  expect(applied.body).toMatchObject({ applied: 3, refused: 2, netMinor: 1_180_00 + 236_00 - 118_00 });
  const lines = (applied.body as { lines: { changeKey: string; outcome: string; detail: string }[] }).lines;
  expect(lines.find((l) => l.changeKey === 'm-bad-sum')).toMatchObject({ outcome: 'refused_incomplete', detail: expect.stringMatching(/does not add up/) });
  expect(lines.find((l) => l.changeKey === 'm-void')).toMatchObject({ outcome: 'refused_incomplete', detail: expect.stringMatching(/sale delete is not applied/) });

  const first = await ledgerOf(read);
  expect(first.net).toEqual(EXPECTED_NET);
  // Source identity kept: every voucher names its delta change and its legacy bill.
  expect(first.journals.map((j) => j.entryId).sort()).toEqual([
    'migration-delta:m-1:sale', 'migration-delta:m-1:tender:cash',
    'migration-delta:m-2:sale', 'migration-delta:m-2:tender:upi',
    'migration-delta:m-3:refund:cash', 'migration-delta:m-3:sale_return',
  ]);
  for (const j of first.journals) {
    const change = SALES.find((c) => j.entryId.startsWith(`migration-delta:${c.changeKey}:`))!;
    expect(j.narrative).toContain(change.legacyId);
    expect(j.narrative).toContain(change.changeKey);
  }
  // The day-close totals read them as legacy sales (source ids are the legacy bills).
  const book = (await read(`/v1/finance/day-book/${DAY}`)).body as { journals: { entryId: string; sources: number }[] };
  expect(book.journals.every((j) => j.sources === 1)).toBe(true);

  // A NEW HTTP key: head office's own record decides — nothing posts twice.
  const retry = await send('run-2', SALES);
  expect(retry.body).toMatchObject({ applied: 0, duplicatesIgnored: 3 });
  expect((await ledgerOf(read)).net).toEqual(EXPECTED_NET);

  // RESTART.
  const after = await restart();
  const again = await after.send('run-3', SALES);
  expect(again.body).toMatchObject({ applied: 0, duplicatesIgnored: 3 });
  const reborn = await ledgerOf(after.read);
  expect(reborn.net).toEqual(EXPECTED_NET);
  expect(reborn.journals).toHaveLength(6);
  // The bad bill, corrected and re-sent with its own key, lands once.
  const fixed = await after.send('run-4', [{ ...BAD[0], cgstMinor: 50_00, sgstMinor: 50_00 }]);
  expect(fixed.body).toMatchObject({ applied: 1 });
  expect((await ledgerOf(after.read)).net['sales_revenue']).toBe(EXPECTED_NET.sales_revenue - 400_00);
}

describe('a sale delta lands as money, once, with its source kept (GT-04)', () => {
  it('in-process API over one store, across a restart (a new process over the same store)', async () => {
    const T = 'ab000000-0000-4000-8000-0000000d0404';
    const h0 = apiHarness();
    await h0.seedOwner(T, OWNER);
    const wire = (h: ApiHarness) => ({
      send: ((key, changes = SALES) => h.request({ method: 'POST', path: '/v1/migration/deltas', userId: OWNER, tenantId: T, idempotencyKey: key, body: { changes, extractCutoff: CUTOFF } })) as Send,
      read: ((path) => path === 'PUT /v1/finance/posting-map'
        ? h.request({ method: 'PUT', path: '/v1/finance/posting-map', userId: OWNER, tenantId: T, idempotencyKey: 'map', body: { rules: DEFAULT_RETAIL_POSTING_MAP.rules } })
        : h.request({ method: 'GET', path, userId: OWNER, tenantId: T })) as Read,
    });
    const w = wire(h0);
    await journey(w.send, w.read, async () => wire(apiHarness({ store: h0.store, idempotency: new MemoryIdempotencyStore() })));
  });
});

const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['sale', 'delta', 'lands', 'once', 'key'].join('-').padEnd(48, '0');
describe.skipIf(!DATABASE_URL)('a sale delta lands as money, once — real API, real PostgreSQL, real restart (GT-04)', () => {
  const clouds: RealCloud[] = [];
  afterAll(async () => { for (const c of clouds) await c.stop(); });

  it('posts, reads back from the day book, and a new-key retry and a restarted process change nothing', async () => {
    const tenantId = randomUUID();
    const wire = (cloud: RealCloud) => ({
      send: ((key, changes = SALES) => cloud.request({ method: 'POST', path: '/v1/migration/deltas', userId: OWNER, idempotencyKey: key, body: { changes, extractCutoff: CUTOFF } })) as Send,
      read: ((path) => path === 'PUT /v1/finance/posting-map'
        ? cloud.request({ method: 'PUT', path: '/v1/finance/posting-map', userId: OWNER, idempotencyKey: 'map', body: { rules: DEFAULT_RETAIL_POSTING_MAP.rules } })
        : cloud.request({ method: 'GET', path, userId: OWNER })) as Read,
    });
    const first = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId, owner: OWNER, packSigningKey: KEY });
    clouds.push(first);
    const w = wire(first);
    await journey(w.send, w.read, async () => {
      await first.stop();
      clouds.splice(clouds.indexOf(first), 1);
      const second = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId, owner: OWNER, packSigningKey: KEY });
      clouds.push(second);
      return wire(second);
    });
  }, 120_000);
});
