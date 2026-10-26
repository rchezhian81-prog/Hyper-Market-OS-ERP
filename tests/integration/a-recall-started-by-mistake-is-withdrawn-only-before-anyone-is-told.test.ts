import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { recordingTransport } from '../../packages/notifications/src/transport';
import { MemoryIdempotencyStore, SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { STREAM, streamName } from '../../services/api/src/adapters';

/**
 * **OB-383 (WF-09 "cancellation") — a recall started by mistake may be withdrawn only before any customer is called or
 * any stock is disposed of; after that it is closed with evidence.** Through the real API, in memory and on real
 * PostgreSQL, with cold restarts.
 *
 *   • withdrawn with a reason and the person's own word that nobody was phoned — the batch sells again, the owner's alert
 *     clears, the record is KEPT marked withdrawn, and the withdrawal is sealed on the audit trail;
 *   • refused BY NAME once a recall message went to a customer (`recall_customers_already_contacted`) or once any of the
 *     batch was disposed of (`recall_stock_already_disposed`) — and then it closes with evidence, as before;
 *   • a cashier may not; a reply lost on the way back is one withdrawal when re-sent; a second withdrawal is refused.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });

type Opts = Parameters<typeof apiHarness>[0];
const backings: { name: string; harness: (extra?: Opts) => ApiHarness; restart: (h: ApiHarness, extra?: Opts) => ApiHarness }[] = [
  { name: 'the in-memory event store', harness: (extra) => apiHarness(extra), restart: (h, extra) => apiHarness({ ...extra, store: h.store, idempotency: new MemoryIdempotencyStore() }) },
];
if (DATABASE_URL !== undefined) {
  const pg = (extra?: Opts): ApiHarness => { const sql = pgPoolClient(pool!); return apiHarness({ ...extra, store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); };
  backings.push({ name: 'real PostgreSQL', harness: (extra) => pg(extra), restart: (_h, extra) => pg(extra) });
}

type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const recallOf = (r: Res) => (r.body as { recall: { status: string; withdrawal?: { withdrawnBy: string; reason: string }; evidenceRef: string | null } }).recall;

const sale = (saleId: string, batchId: string, customerRef?: string) => ({
  saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', locationId: 'S1', cashierId: 'u-owner', tradingDay: '2030-06-10', committedAt: '2030-06-10T10:00:00Z',
  totalMinor: 9_000, currency: 'INR', packVersion: 1, ...(customerRef === undefined ? {} : { customerRef }),
  lines: [{ productId: 'DAL', quantityMinor: 1, uom: 'ea', unitPriceMinor: 9_000, lineTotalMinor: 9_000, batchId }],
  tenders: [{ kind: 'cash', amountMinor: 9_000 }],
});

describe.each(backings)('OB-383: a recall started by mistake is withdrawn only before anyone is told or any stock is disposed of — on $name', ({ harness, restart }) => {
  const cast = async (extra?: Opts) => {
    const h = harness(extra);
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-cash', 'cashier');
    return { h, T };
  };
  const reqOf = (hh: () => ApiHarness, T: string) => (method: 'GET' | 'POST', path: string, body?: unknown, userId = 'u-owner', key?: string): Promise<Res> =>
    hh().request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: key ?? `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }) });
  const receive = (req: ReturnType<typeof reqOf>, batchId: string) =>
    req('POST', '/v1/inventory/movements', { movementId: `rx-${batchId}`, productId: 'DAL', locationId: 'S1', kind: 'received', quantityMinor: 20, uom: 'ea', occurredAt: '2030-06-01T01:00:00.000Z', enteredBy: 'u-owner', unitCostMinor: 4_000, batchId, expiry: '2030-12-01' });

  it('withdrawn before anyone is told: the record is kept marked withdrawn, the batch sells again, the alert clears, the seal names who and why', async () => {
    const c = await cast();
    let h = c.h;
    const req = reqOf(() => h, c.T);
    expect((await receive(req, 'B-OOPS')).status).toBeLessThan(300);
    expect((await req('POST', '/v1/quality/recalls/B-OOPS', { reason: 'typed the wrong batch code' }, 'u-mgr')).status).toBe(201);
    const blocked = async () => ((await req('GET', '/v1/quality/sale-blocks')).body as { blocks: { batchId: string; kind: string }[] }).blocks.filter((b) => b.kind === 'recall' && b.batchId === 'B-OOPS').length;
    expect(await blocked()).toBeGreaterThan(0);
    const alertState = async () => ((await req('GET', '/v1/platform/alerts')).body as { alerts: { alert: { alertId: string }; state: string }[] })
      .alerts.filter((a) => a.alert.alertId === 'recall:B-OOPS').map((a) => a.state);
    expect(await alertState()).toEqual(['open']);

    // Permission: a cashier may not withdraw a recall.
    expect((await req('POST', '/v1/quality/recalls/B-OOPS/withdrawal', { reason: 'wrong batch typed', noCustomerPhoned: true }, 'u-cash')).status).toBe(403);
    // The person must say nobody was phoned, and why it was a mistake — both refused by name, nothing changed.
    const noWord = await req('POST', '/v1/quality/recalls/B-OOPS/withdrawal', { reason: 'wrong batch typed' }, 'u-mgr');
    expect([noWord.status, codeOf(noWord)]).toEqual([400, 'recall_withdrawal_needs_no_phone_call_confirmed']);
    const noReason = await req('POST', '/v1/quality/recalls/B-OOPS/withdrawal', { reason: ' ', noCustomerPhoned: true }, 'u-mgr');
    expect([noReason.status, codeOf(noReason)]).toEqual([400, 'recall_withdrawal_needs_a_reason']);
    expect(recallOf(await req('GET', '/v1/quality/recalls/B-OOPS')).status).toBe('open');

    // Withdrawn — and the reply is lost: the same request re-sent is the same one withdrawal.
    const first = await req('POST', '/v1/quality/recalls/B-OOPS/withdrawal', { reason: 'typed the wrong batch code; B-OOQ was meant', noCustomerPhoned: true }, 'u-mgr', 'wd-1');
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(recallOf(first)).toMatchObject({ status: 'withdrawn', withdrawal: { withdrawnBy: 'u-mgr', reason: 'typed the wrong batch code; B-OOQ was meant' } });
    const resent = await req('POST', '/v1/quality/recalls/B-OOPS/withdrawal', { reason: 'typed the wrong batch code; B-OOQ was meant', noCustomerPhoned: true }, 'u-mgr', 'wd-1');
    expect(resent.status).toBe(200);
    expect(recallOf(resent).status).toBe('withdrawn');
    const events = await h.store.readStream(c.T, streamName(STREAM.inventory, 'recalls'), { type: 'RecallWithdrawn' });
    expect(events.length).toBe(1);

    h = restart(h); // ── COLD RESTART ──
    // Kept for good, marked withdrawn; no longer blocks the sale; a second withdrawal or a closure is refused by name.
    expect(recallOf(await req('GET', '/v1/quality/recalls/B-OOPS'))).toMatchObject({ status: 'withdrawn' });
    expect(((await req('GET', '/v1/quality/recalls')).body as { openCount: number; count: number })).toMatchObject({ openCount: 0, count: 1 });
    expect(await blocked()).toBe(0);
    const twice = await req('POST', '/v1/quality/recalls/B-OOPS/withdrawal', { reason: 'again, by mistake', noCustomerPhoned: true }, 'u-mgr');
    expect([twice.status, codeOf(twice)]).toEqual([409, 'no_open_recall_to_withdraw']);
    const closeIt = await req('POST', '/v1/quality/recalls/B-OOPS/closure', { evidenceRef: 'x' }, 'u-mgr');
    expect([closeIt.status, codeOf(closeIt)]).toEqual([409, 'no_open_recall_to_close']);
    // The owner's recall alert was cleared (kept, with its history).
    expect(await alertState()).toEqual(['cleared']);
    // The seal on the audit trail: who withdrew it, why, and that nobody had been told.
    const trail = (await h.request({ method: 'GET', path: '/v1/audit/trail', userId: 'u-owner', tenantId: c.T, query: { action: 'quality.recall.withdraw' } })).body as { matches: { actorId: string; objectId: string; reason?: string; after: Record<string, string> | null }[] };
    expect(trail.matches.map((m) => [m.actorId, m.objectId, m.after?.['status'], m.after?.['noCustomerPhoned']])).toEqual([['u-mgr', 'recall:B-OOPS', 'withdrawn', 'confirmed']]);
    expect(trail.matches[0]?.reason).toMatch(/wrong batch code/);
    // A real recall on the same batch can still be started afterwards — a new record.
    expect((await req('POST', '/v1/quality/recalls/B-OOPS', { reason: 'supplier notice after all' }, 'u-mgr')).status).toBe(201);
  });

  it('refused by name once a recall message went to a customer — then it is closed with evidence', async () => {
    const transport = recordingTransport();
    const c = await cast({ notificationTransport: transport });
    let h = c.h;
    const req = reqOf(() => h, c.T);
    expect((await receive(req, 'B-TOLD')).status).toBeLessThan(300);
    expect((await req('POST', '/v1/sales', sale('S-1', 'B-TOLD', 'cust-A'))).status).toBeLessThan(300);
    expect((await req('POST', '/v1/customers/cust-A/consent', { purpose: 'transactional', channel: 'sms', given: true, evidence: 'said yes at the desk' })).status).toBeLessThan(300);
    expect((await req('POST', '/v1/quality/recalls/B-TOLD', { reason: 'supplier notice SN-9' }, 'u-mgr')).status).toBe(201);
    expect((await req('POST', '/v1/quality/recall-notices/switch', { on: true, reason: 'test provider connected for the drill' })).status).toBe(200);
    const sent = await req('POST', '/v1/quality/recalls/B-TOLD/notices', { text: 'Please return the toor dal batch B-TOLD for a refund.' }, 'u-mgr');
    expect((sent.body as { sent: string[] }).sent).toEqual(['cust-A']);

    h = restart(h, { notificationTransport: transport }); // ── COLD RESTART ──
    const refused = await req('POST', '/v1/quality/recalls/B-TOLD/withdrawal', { reason: 'we think it was a mistake', noCustomerPhoned: true }, 'u-mgr');
    expect([refused.status, codeOf(refused)]).toEqual([409, 'recall_customers_already_contacted']);
    expect(recallOf(await req('GET', '/v1/quality/recalls/B-TOLD')).status).toBe('open');
    const closed = await req('POST', '/v1/quality/recalls/B-TOLD/closure', { evidenceRef: 'Supplier withdrew its notice SN-9; cust-A told by SMS it is safe' }, 'u-mgr');
    expect(closed.status).toBe(200);
    expect(recallOf(closed)).toMatchObject({ status: 'closed', evidenceRef: expect.stringMatching(/SN-9/) });
  });

  it('refused by name once any of the batch was disposed of — then it is closed with evidence', async () => {
    const c = await cast();
    let h = c.h;
    const req = reqOf(() => h, c.T);
    expect((await receive(req, 'B-GONE')).status).toBeLessThan(300);
    expect((await req('POST', '/v1/quality/recalls/B-GONE', { reason: 'mould seen on two packs' }, 'u-mgr')).status).toBe(201);
    // Two packs destroyed through the governed write-off route (a small loss, under the second-person threshold).
    const binned = await req('POST', '/v1/inventory/write-off/wo-gone', { productId: 'DAL', locationId: 'S1', qty: 2, uom: 'ea', lossType: 'destruction', reasonCode: 'recall', evidenceRef: 'BIN-PHOTO-1', batchId: 'B-GONE' }, 'u-mgr', 'wo-gone');
    expect(binned.status, JSON.stringify(binned.body)).toBeLessThan(300);

    h = restart(h); // ── COLD RESTART ──
    const refused = await req('POST', '/v1/quality/recalls/B-GONE/withdrawal', { reason: 'it was only two packs', noCustomerPhoned: true }, 'u-mgr');
    expect([refused.status, codeOf(refused)]).toEqual([409, 'recall_stock_already_disposed']);
    expect(recallOf(await req('GET', '/v1/quality/recalls/B-GONE')).status).toBe('open');
    expect((await req('POST', '/v1/quality/recalls/B-GONE/closure', { evidenceRef: '2 packs binned, rest inspected and fine: QC-NOTE-4' }, 'u-mgr')).status).toBe(200);
  });
});
