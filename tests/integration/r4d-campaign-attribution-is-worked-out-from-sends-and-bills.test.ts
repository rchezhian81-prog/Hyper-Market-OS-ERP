import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { recordingTransport } from '../../packages/notifications/src/transport';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { signedReport, testProviderSecret, TEST_PROVIDER } from '../support/provider-report';

/**
 * **Round 4d · M21-FR-02 "attribution derived" — "attribution ties revenue to a campaign".** Through the real API, in memory
 * and on real PostgreSQL: a campaign goes out through the queue; WHO was sent to and WHEN is read from its recorded sends
 * (a message the provider reported failed is not "sent"; a customer with no consent was never messaged); the ORDERS are the
 * shop's own banked bills by customer. A bill made after the customer's message, inside the window, is attributed; a bill
 * made BEFORE the message is not; the control group's bills are read the same way and reported beside it. The margin is
 * "not known" when the bills' cost is not known — never a made-up figure. A typed body is refused.
 */

const OWNER = 'u-owner'; const CHECKER = 'u-checker'; const RELAY = 'u-provider-relay'; const CASH = 'u-cash';
const SECRET = testProviderSecret();
const SECRETS = new Map([[TEST_PROVIDER, SECRET]]);
const A = 'cust-a'; const B = 'cust-b'; const C = 'cust-c'; const D = 'cust-d'; const X = 'cust-x'; const Y = 'cust-y';

const bill = (saleId: string, customerRef: string, committedAt: string, totalMinor: number) => ({
  saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', cashierId: OWNER, tradingDay: committedAt.slice(0, 10), committedAt,
  totalMinor, currency: 'INR', packVersion: 1, customerRef,
  lines: [{ productId: 'RICE', quantityMinor: 1, uom: 'ea', unitPriceMinor: totalMinor, lineTotalMinor: totalMinor }],
  tenders: [{ kind: 'cash', amountMinor: totalMinor }],
});

async function journey(h: ApiHarness, T: string): Promise<void> {
  const req = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown) =>
    h.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
  const ok = async (p: ReturnType<typeof req>, what: string) => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
  await h.seedOwner(T, OWNER);
  await h.provisionOwner(T, CHECKER);
  await h.provisionRole(T, RELAY, 'message_provider_relay');
  await h.provisionRole(T, CASH, 'cashier');
  for (const c of [A, B, C, D]) await h.provisionRole(T, c, 'customer');
  for (const c of [A, B, C]) await ok(req('POST', '/v1/me/privacy/consent', c, { purpose: 'marketing', channel: 'sms', given: true }), `consent ${c}`);
  await ok(req('POST', '/v1/notifications/templates/tpl-offer', OWNER, { purpose: 'marketing', channel: 'sms', body: 'SRE this week: {offer}' }), 'template');
  await ok(req('POST', '/v1/notifications/budget', OWNER, { capMinor: 100_000, costMinorByChannel: { sms: 25 } }), 'budget');
  await ok(req('POST', '/v1/notifications/templates/tpl-offer/approval', CHECKER, { version: 1 }), 'approve words');
  await ok(req('PUT', '/v1/service/campaigns/frequency-policy', OWNER, { capPerWindow: 5, windowDays: 7 }), 'cap');

  // a bill A made an hour BEFORE the campaign — it did not come from it
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  await ok(req('POST', '/v1/sales', OWNER, bill('S-A-before', A, hourAgo, 40_000)), 'A before');

  // never sent yet: nothing to measure
  const early = await req('POST', '/v1/service/campaigns/cw/attribution', OWNER, { attributionWindowHours: 48 });
  expect([early.status, (early.body as { error?: { code?: string } }).error?.code]).toEqual([404, 'campaign_never_sent']);

  await ok(req('POST', '/v1/service/campaigns/cw/send', OWNER, { purpose: 'marketing', channel: 'sms', templateId: 'tpl-offer', containsPromotion: true, audience: [A, B, C, D], values: { offer: 'rice 10% off' } }), 'send');
  await ok(req('POST', '/v1/notifications/queue/drain', OWNER, {}), 'drain');
  // the provider says B's message never arrived
  const path = '/v1/service/campaigns/cw/messages/cmp-cw-cust-b/status';
  const failed = await h.request({ method: 'POST', path, userId: RELAY, tenantId: T, idempotencyKey: 'rep-b', body: signedReport(path, { status: 'failed', providerRef: 'rec-cmp-cw-cust-b', reason: 'handset unreachable', reportedAt: new Date().toISOString() }, SECRET, { reportId: `${T}-rep-b` }) });
  expect(failed.status, JSON.stringify(failed.body)).toBe(201);

  // after the send: A buys (attributed), B buys (but B's message failed — not sent), X (control) buys
  const now = new Date(Date.now() + 1_000).toISOString();
  await ok(req('POST', '/v1/sales', OWNER, bill('S-A-after', A, now, 50_000)), 'A after');
  await ok(req('POST', '/v1/sales', OWNER, bill('S-B-after', B, now, 30_000)), 'B after');
  await ok(req('POST', '/v1/sales', OWNER, bill('S-X', X, now, 20_000)), 'X');

  const typed = await req('POST', '/v1/service/campaigns/cw/attribution', OWNER, { attributionWindowHours: 48, sentTo: [A], orders: [] });
  expect((typed.body as { error?: { code?: string } }).error?.code).toBe('attribution_is_worked_out');
  expect((await req('POST', '/v1/service/campaigns/cw/attribution', CASH, { attributionWindowHours: 48 })).status).toBe(403);

  const r = (await ok(req('POST', '/v1/service/campaigns/cw/attribution', OWNER, { attributionWindowHours: 48, controlGroup: [X, Y] }), 'attribution')).body as {
    sent: number; converted: number; conversionBps: number; attributedRevenueMinor: number; attributedMarginMinor: number | null; marginNotKnownOrders: number;
    controlConversionBps: number; upliftBps: number; notSent: Record<string, number>; attributedOrders: { orderId: string; customerRef: string }[];
  };
  expect(r).toMatchObject({ sent: 2, converted: 1, conversionBps: 5000, attributedRevenueMinor: 50_000, controlConversionBps: 5000, upliftBps: 0 });
  expect(r.notSent).toEqual({ waiting: 0, withheld: 0, deadLettered: 0, failedReported: 1 });
  expect(r.attributedOrders.map((o) => o.customerRef)).toEqual([A]);
  expect(r.attributedOrders.map((o) => o.orderId)).not.toContain('S-A-before');
  // no stock cost is on record for these bills: the margin is not known, never a number made up
  expect(r.attributedMarginMinor).toBeNull();
  expect(r.marginNotKnownOrders).toBe(1);
}

describe('M21-FR-02 — campaign attribution is worked out from the sends and the shop\'s own bills', () => {
  it('in memory', async () => {
    await journey(apiHarness({ notificationTransport: recordingTransport(), deliveryReportSecrets: SECRETS }), randomUUID());
  });
});

const DATABASE_URL = process.env['DATABASE_URL'];
describe.skipIf(!DATABASE_URL)('M21-FR-02 — campaign attribution is worked out — real PostgreSQL', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4, options: '-c app.tenant_id=*' });
    const dir = 'db/migrations';
    await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(`${dir}/${name}`, 'utf8') })));
  });
  afterAll(async () => { await pool.end(); });
  it('the same on PostgreSQL', async () => {
    const sql = pgPoolClient(pool);
    await journey(apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql), notificationTransport: recordingTransport(), deliveryReportSecrets: SECRETS }), randomUUID());
  });
});
