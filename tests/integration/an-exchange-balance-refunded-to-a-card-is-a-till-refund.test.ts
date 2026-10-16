import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { InMemoryEventStore, SqlEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM } from '../../services/api/src/adapters';
import { settlementRefundsAdapter } from '../../services/api/src/r2-data-adapters';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { refundApprovalId } from '../support/refund-approval';

/**
 * **C13 (verifier NEW-5, NEW-4): an exchange whose balance the shop paid back to a card or UPI is a till refund, and the
 * cash pipeline nets refunds against captures.**
 *
 * Through the real API — the bill is banked, the exchange is recorded with the balance refunded to the card, the
 * provider's T+1 file is imported with that refund debited — on the memory store and on PostgreSQL:
 *   • the review MATCHES the provider's refund line to the exchange's balance (no "refund without a till record"),
 *   • before the provider debits it, the balance is a refund awaiting settlement, and "money still to arrive" is the
 *     pending captures LESS the pending refunds, with the two parts shown separately,
 *   • a cash balance, an even exchange and a top-up are not read as card refunds.
 * Synthetic data only (hard rule #7). The PostgreSQL leg needs DATABASE_URL; without it that leg skips, never passes quietly.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
// The exchange route stamps its own clock, so the test runs on today's date rather than a fixed one.
const NOW = new Date(Date.now() - 60_000).toISOString();
const DAY = (iso: string, d: number) => new Date(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) + d * 86_400_000).toISOString();
const FROM = DAY(NOW, -30);
const TO = DAY(NOW, 2);
const TXN = 'TXN-SYN-0001';

interface Review {
  matchedRefundCount: number; awaitingValueMinor: number; awaitingCapturesMinor: number; awaitingRefundsMinor: number;
  exceptions: { finding: string; ref: string; valueMinor: number }[]; detail: string;
}

const publishPack = (h: ApiHarness, tenant: string) =>
  h.store.append(tenant, STREAM.catalogue, makeEvent({
    id: `pack-${tenant}-1`, type: 'CataloguePublished', occurredAt: NOW, idempotencyKey: `catalogue-${tenant}-v1`, source: 'test/catalogue',
    payload: {
      snapshot: {
        tenantId: tenant, version: 1, builtAt: NOW, scope: { tenantId: tenant, storeId: 'L1' },
        products: [
          { productId: 'P1', sku: 'P1', name: 'P1', unitPriceMinor: 1000_00, taxBps: 500, status: 'active', uom: 'each' },
          { productId: 'P3', sku: 'P3', name: 'P3', unitPriceMinor: 600_00, taxBps: 500, status: 'active', uom: 'each' },
        ],
        barcodes: [],
      },
    },
  }));

/** A ₹1,000 bill paid by card under the provider's reference TXN; it is exchanged for a ₹600 item and ₹400 goes back. */
async function cast(store: EventStore, tenant: string): Promise<ApiHarness> {
  const h = apiHarness({ store, now: () => NOW });
  await h.seedOwner(tenant, 'u-owner');
  await h.provisionRole(tenant, 'u-mgr', 'store_manager');
  await h.provisionRole(tenant, 'u-cash', 'cashier');
  await publishPack(h, tenant);
  const sale = {
    saleId: 'S1', receiptNumber: 'R-1', laneId: 'lane-1', locationId: 'L1', cashierId: 'u-cash',
    tradingDay: NOW.slice(0, 10), committedAt: NOW, totalMinor: 1000_00, currency: 'INR', packVersion: 1,
    lines: [{ productId: 'P1', quantityMinor: 1, uom: 'each', unitPriceMinor: 1000_00, lineTotalMinor: 1000_00 }],
    tenders: [{ kind: 'card', amountMinor: 1000_00, ref: TXN }],
  };
  expect((await h.request({ method: 'POST', path: '/v1/sales', userId: 'u-owner', tenantId: tenant, idempotencyKey: 'bank-S1', body: sale })).status).toBe(202);
  return h;
}

async function exchange(h: ApiHarness, tenant: string, exchangeId: string, settlement: Record<string, unknown>, replacementMinor = 600_00, approve = true) {
  const balance = 1000_00 - replacementMinor;
  const approvalId = approve && balance > 0 ? await refundApprovalId(h, tenant, 'u-mgr', { kind: 'exchange_refund', saleId: 'S1', valueMinor: balance, requestedBy: 'u-cash' }) : undefined;
  return h.request({
    method: 'POST', path: '/v1/sales/S1/exchanges', userId: 'u-cash', tenantId: tenant, idempotencyKey: `x-${exchangeId}`,
    body: {
      exchangeId, reasonCode: 'wrong_size', returnLines: [{ productId: 'P1', uom: 'each', quantityMinor: 1, disposition: 'resell' }],
      replacement: { saleId: `S1-${exchangeId}`, receiptNumber: `R-${exchangeId}`, lines: [{ productId: 'P3', uom: 'each', quantityMinor: 1, unitPriceMinor: replacementMinor, lineTotalMinor: replacementMinor }] },
      settlement, ...(approvalId === undefined ? {} : { approvalId }),
    },
  });
}

const importFile = (h: ApiHarness, tenant: string, lines: Record<string, unknown>[], gross: number) =>
  h.request({
    method: 'POST', path: '/v1/settlement/batches', userId: 'u-owner', tenantId: tenant, idempotencyKey: 'sb-B1',
    body: { batchId: 'B1', providerId: 'synthetic-aggregator', currency: 'INR', settlementDate: NOW.slice(0, 10), lines, declaredGrossMinor: gross, declaredFeesMinor: 0, declaredNetMinor: gross },
  });

const review = async (h: ApiHarness, tenant: string, date: string): Promise<Review> =>
  (await h.request({ method: 'GET', path: '/v1/settlement/review', userId: 'u-owner', tenantId: tenant, query: { date, cycleDays: '1' } })).body as Review;

function contract(label: string, tenantOf: (n: number) => string, storeOf: () => EventStore) {
  it(`${label}: the provider's refund line matches the exchange balance refunded to the card`, async () => {
    const tenant = tenantOf(1);
    const store = storeOf();
    const h = await cast(store, tenant);
    const x = await exchange(h, tenant, 'X1', { refundTender: 'card' });
    expect(x.status).toBe(201);
    expect(x.body).toMatchObject({ balance: { kind: 'refund', amountMinor: 400_00, tender: 'card' } });

    // The feed: one till refund of the BALANCE (400), keyed to the original bill's card capture — not the 1,000 credited.
    const feed = await settlementRefundsAdapter({ store }).electronicRefunds(tenant, FROM, TO);
    expect(feed).toEqual([{ id: expect.any(String), originalRef: TXN, amountMinor: 400_00, refundedOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) }]);
    const today = feed[0]!.refundedOn;

    // Before the provider's file: the capture is paid in nowhere yet and the refund is still to go out — net 600.
    const before = await review(h, tenant, today);
    expect(before.exceptions.map((e) => e.finding).sort()).toEqual(['awaiting_settlement', 'refund_awaiting_settlement']);
    expect(before.awaitingCapturesMinor).toBe(1000_00);
    expect(before.awaitingRefundsMinor).toBe(400_00);
    expect(before.awaitingValueMinor).toBe(600_00);
    expect(before.detail).toContain('100000 still to come in, 40000 in refunds still to go out');

    // The provider pays the capture and debits the refund against the same original reference: all matched.
    expect((await importFile(h, tenant, [
      { id: 'L1', ref: TXN, amountMinor: 1000_00 },
      { id: 'L2', ref: 'RF-SYN-1', type: 'refund', originalRef: TXN, amountMinor: 400_00 },
    ], 600_00)).status).toBe(201);
    const after = await review(h, tenant, today);
    expect(after.exceptions.map((e) => e.finding)).toEqual([]);
    expect(after.matchedRefundCount).toBe(1);
    expect(after.awaitingValueMinor).toBe(0);
  });

  it(`${label}: a UPI balance on a card-paid bill is still read, keyed to the bill (it never vanishes)`, async () => {
    const tenant = tenantOf(2);
    const store = storeOf();
    const h = await cast(store, tenant);
    expect((await exchange(h, tenant, 'X1', { refundTender: 'upi' })).status).toBe(201);
    // The bill was paid by card, so a UPI balance has no UPI capture to reverse: it is still read, keyed to the bill.
    const feed = await settlementRefundsAdapter({ store }).electronicRefunds(tenant, FROM, TO);
    expect(feed.map((r) => [r.originalRef, r.amountMinor])).toEqual([['bill:S1', 400_00]]);
  });

  it(`${label}: a cash balance, an even exchange and a top-up are not card or UPI refunds`, async () => {
    const tenant = tenantOf(3);
    const store = storeOf();
    const h = await cast(store, tenant);
    expect((await exchange(h, tenant, 'X1', { refundTender: 'cash' })).status).toBe(201);
    const feed = await settlementRefundsAdapter({ store }).electronicRefunds(tenant, FROM, TO);
    expect(feed).toEqual([]);
    const h2 = await cast(storeOf(), tenantOf(4));
    expect((await exchange(h2, tenantOf(4), 'X2', {}, 1000_00)).status).toBe(201); // even
    expect((await settlementRefundsAdapter({ store: h2.store }).electronicRefunds(tenantOf(4), FROM, TO))).toEqual([]);
    // A top-up of 200 by card is money coming in on the replacement bill, never a refund.
    const h3 = await cast(storeOf(), tenantOf(5));
    expect((await exchange(h3, tenantOf(5), 'X3', { topUpTenders: [{ kind: 'card', amountMinor: 200_00, ref: 'TXN-SYN-0002' }] }, 1200_00)).status).toBe(201);
    expect((await settlementRefundsAdapter({ store: h3.store }).electronicRefunds(tenantOf(5), FROM, TO))).toEqual([]);
  });
}

describe('C13 exchange balance refunds — memory store', () => {
  contract('memory', (n) => `aaaaaaa${n}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`, () => new InMemoryEventStore());
});

const describePg = DATABASE_URL ? describe : describe.skip;

describePg('C13 exchange balance refunds — PostgreSQL store', () => {
  const RUN = Date.now().toString(16).slice(-6);
  let pool: Pool;
  let store: SqlEventStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4, options: '-c app.tenant_id=*' });
    const dir = 'db/migrations';
    await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
    store = new SqlEventStore(pgPoolClient(pool));
  });

  afterAll(async () => { await pool?.end(); });

  contract('pg', (n) => `${RUN}${n}c-1313-4313-8313-${'1'.repeat(12)}`, () => store);
});
