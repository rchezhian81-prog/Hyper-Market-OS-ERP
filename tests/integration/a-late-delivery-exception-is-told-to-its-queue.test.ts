import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { startRealCloud, type RealCloud } from '../support/real-store';
import { seedSubstitutionTruth, SWAP_PRODUCTS } from '../support/substitution-truth';
import { recordingTransport } from '../../packages/notifications/src/transport';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM } from '../../services/api/src/adapters';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';

/**
 * **M19-FR-04 (SLA management) · PA-08 (round 8) — a delivery exception past its time limit raises an alert through the
 * message service.** A short-picked line whose swap was recorded three hours ago sits in the customer-service desk queue
 * (30-minute limit): the breach sweep puts one transactional alert per person who staffs that queue (the desk cashier,
 * and the managers who staff every queue — `QUEUES_STAFFED_BY`) on the PA-08 queue; the sender delivers them through the
 * transport with the budget and recipient checks; a second sweep queues nothing twice; an escalation to the next queue
 * alerts that queue's people (and not the cashier); and in the served API the head-office worker does it on its own
 * timer, with nobody pressing anything. In memory and, with DATABASE_URL, on real PostgreSQL. Synthetic data only.
 */

const OWNER = 'u-owner'; const MGR = 'u-mgr'; const CASH = 'u-cash'; const ACCT = 'u-acct';
const ID = 'ord-late:l1:policy_short_pick';

/** A swap recorded three hours ago (kept as the route then wrote it) — the exception is as old as the decision. */
async function lateSwap(store: EventStore, tenantId: string): Promise<void> {
  const at = new Date(Date.now() - 3 * 3_600_000).toISOString();
  const rec = { orderId: 'ord-late', lineId: 'l1', decision: 'confirmed', outcome: 'short_picked', pickProductId: null, pickQuantityMinor: 0, chargeMinor: 0, refundMinor: 0, at, eligibility: 'refused', policyReason: 'controlled_item' };
  for (const [stream, key] of [[[STREAM.orders, 'ord-late'].join('\u001f'), 'ord-sub'], [[STREAM.orders, 'substitutions'].join('\u001f'), 'ord-sub-idx']] as const) {
    await store.append(tenantId, stream, makeEvent({ id: `${key}-ord-late-l1`, type: 'LineSubstituted', occurredAt: at, idempotencyKey: `${key}-${tenantId}-ord-late-l1`, source: 'api/orders', payload: rec }));
  }
}

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  await runMigrations(pgPoolClient(pool), readdirSync('db/migrations').filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join('db/migrations', name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });

type Transport = ReturnType<typeof recordingTransport>;
const backings: { name: string; harness: (t: Transport) => ApiHarness }[] = [{ name: 'the in-memory event store', harness: (t) => apiHarness({ notificationTransport: t }) }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: (t) => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql), notificationTransport: t }); } });

describe.each(backings)('a late delivery exception is told to the people who staff its queue — on $name', ({ harness }) => {
  it('swept onto the PA-08 queue once per person, delivered by the sender, escalated to the next queue\'s people', async () => {
    const transport = recordingTransport();
    const h = harness(transport);
    const T = randomUUID();
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, key?: string) =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: key ?? `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
    await h.seedOwner(T, OWNER);
    await h.provisionRole(T, MGR, 'store_manager');
    await h.provisionRole(T, CASH, 'cashier');
    await h.provisionRole(T, ACCT, 'accountant');
    await seedSubstitutionTruth(h, T, SWAP_PRODUCTS);
    await lateSwap(h.store, T);
    expect((await call('POST', '/v1/notifications/budget', OWNER, { capMinor: 100_000, costMinorByChannel: { sms: 25 } })).status).toBe(201);

    const w = (await call('GET', '/v1/orders/substitution-exceptions', OWNER)).body as { exceptions: { exceptionId: string; owner: string; sla: { breached: boolean } }[] };
    expect(w.exceptions.find((e) => e.exceptionId === ID)).toMatchObject({ owner: 'customer_service_desk', sla: { breached: true } });

    // A cashier cannot run the sweep; a manager can.
    expect((await call('POST', '/v1/orders/substitution-exceptions/breach-alerts', CASH, {})).status).toBe(403);
    const swept = await call('POST', '/v1/orders/substitution-exceptions/breach-alerts', MGR, {}, 'sweep-1');
    expect(swept.status).toBe(200);
    const s = swept.body as { queued: { exceptionId: string; to: string; id: string }[]; alreadyQueued: number; breached: number };
    // The desk queue's people: the cashier, and the owner and manager who staff every queue — never the accountant.
    expect(s.queued.map((q) => q.to).sort()).toEqual([CASH, MGR, OWNER].sort());
    expect(s.queued.every((q) => q.id === `subx-${ID}-customer_service_desk-${q.to}`)).toBe(true);
    // The same request again is the same answer; a fresh sweep queues nothing twice.
    expect(((await call('POST', '/v1/orders/substitution-exceptions/breach-alerts', MGR, {}, 'sweep-1')).body as { queued: unknown[] }).queued).toHaveLength(3);
    expect((await call('POST', '/v1/orders/substitution-exceptions/breach-alerts', MGR, {}, 'sweep-2')).body).toMatchObject({ queued: [], alreadyQueued: 3, breached: 1 });

    // On the PA-08 queue, then delivered by the sender through the transport (recipient and budget re-checked).
    const pending = ((await call('GET', '/v1/notifications/queue/pending', OWNER)).body as { pending: { id: string }[] }).pending.map((p) => p.id);
    expect(pending.filter((id) => id.startsWith('subx-')).sort()).toEqual(s.queued.map((q) => q.id).sort());
    const drained = (await call('POST', '/v1/notifications/queue/drain', OWNER, {}, 'drain-1')).body as { outcome: { id: string; result: string }[] };
    expect(drained.outcome.filter((o) => o.id.startsWith('subx-')).every((o) => o.result === 'delivered')).toBe(true);
    const toCash = transport.sent.find((m) => m.customerId === CASH)!;
    expect(toCash.text).toMatch(/^Delivery exception past its time limit: order ord-late line l1 — policy short pick, ₹0\.00 at stake, in the customer service desk queue \(nobody has claimed it\)/);

    // Escalation moves it to the next queue — that queue's people are told; the cashier (desk only) is not told again.
    const esc = (await call('POST', '/v1/orders/substitution-exceptions/escalate', OWNER, {}, 'esc-1')).body as { escalated: { exceptionId: string; toOwner: string }[]; alerts: { queued: { to: string; id: string }[] } };
    expect(esc.escalated).toEqual([expect.objectContaining({ exceptionId: ID })]);
    const next = esc.escalated[0]!.toOwner;
    expect(next).not.toBe('customer_service_desk');
    expect(esc.alerts.queued.map((q) => q.to).sort()).toEqual([MGR, OWNER].sort());
    expect(esc.alerts.queued.every((q) => q.id.includes(`-${next}-`))).toBe(true);
  });
});

describe.skipIf(DATABASE_URL === undefined)('in the served API the head-office worker raises the alerts on its own timer (PA-08 · round 8)', () => {
  let cloud: RealCloud;
  afterAll(async () => { await cloud?.stop(); });
  it('nobody presses anything: the worker pass puts the late exception\'s alerts on the queue', async () => {
    const tenantId = randomUUID();
    const transport = recordingTransport();
    cloud = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId, owner: OWNER, packSigningKey: ['late', 'exception', 'key'].join('-').padEnd(48, '0'), providers: { notificationTransport: transport, opsAlertWorkerIntervalMs: 50 } });
    await cloud.grant(CASH, 'cashier');
    await lateSwap(new SqlEventStore(pgPoolClient(pool!)), tenantId);
    let pending: string[] = [];
    for (let i = 0; i < 300 && pending.filter((id) => id.startsWith(`subx-${ID}`)).length < 3; i += 1) {
      await sleep(20);
      pending = ((await cloud.request({ method: 'GET', path: '/v1/notifications/queue/pending', userId: OWNER })).body as { pending?: { id: string }[] }).pending?.map((p) => p.id) ?? [];
    }
    const mine = pending.filter((id) => id.startsWith(`subx-${ID}`)).sort();
    expect(mine).toEqual([`subx-${ID}-customer_service_desk-${CASH}`, `subx-${ID}-customer_service_desk-${OWNER}`, `subx-${ID}-customer_service_desk-u-hr`].sort());
    expect(cloud.said.some((l) => l.includes('delivery-exception alert(s) put on the message queue'))).toBe(true);
  }, 60_000);
});
