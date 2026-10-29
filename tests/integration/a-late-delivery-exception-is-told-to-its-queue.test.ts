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
import { InMemoryEventStore, SqlEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';

/**
 * **M19-FR-04 (SLA management) · PA-08 · owner decision OB-61 — a late delivery exception is told to the person HOLDING
 * it, and only when nobody holds it, to the store's DUTY MANAGER — never to everyone on the queue.** A short-picked line
 * whose swap was recorded three hours ago (order placed at store br-1) sits in the customer-service desk queue (30-minute
 * limit), past its limit:
 *   • nobody holds it → the manager ROSTERED on a shift at br-1 that covers now (not the manager whose shift has ended,
 *     not br-2's manager on duty, not the owner, not the cashier, not the accountant);
 *   • a cashier claims it → the cashier alone (the duty manager is not told twice);
 *   • the cashier lets go and a manager claims it → that manager alone; the cashier (old holder) is not told again;
 *   • a restart (a fresh server over the same store) queues nothing a second time — the check reads the stored queue;
 *   • with no roster saying who is on duty, the store's managers by grant scope (br-1 or company-wide; not br-2's);
 *   • the sender delivers through the transport with the PA-08 budget and recipient checks, as before.
 * In memory and, with DATABASE_URL, on real PostgreSQL. Synthetic data only.
 */

const OWNER = 'u-owner'; const DUTY = 'u-duty'; const OFF = 'u-mgr-off'; const MGR2 = 'u-mgr-br2'; const CASH = 'u-cash'; const ACCT = 'u-acct';
const ID = 'ord-late:l1:policy_short_pick';

/** A swap recorded three hours ago (kept as the route then wrote it), on an order placed at store br-1. */
async function lateSwap(store: EventStore, tenantId: string): Promise<void> {
  const at = new Date(Date.now() - 3 * 3_600_000).toISOString();
  await store.append(tenantId, [STREAM.orders, 'ord-late'].join('\u001f'), makeEvent({ id: 'ord-placed-ord-late', type: 'OrderPlaced', occurredAt: at, idempotencyKey: `ord-placed-${tenantId}-ord-late`, source: 'api/orders', payload: { orderId: 'ord-late', locationId: 'br-1', lines: [], placedAt: at, state: 'placed' } }));
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
/** One durable store per run, and a server over it — `serve` again is a restart over the same records. */
const backings: { name: string; store: () => EventStore; serve: (s: EventStore, t: Transport) => ApiHarness }[] = [
  { name: 'the in-memory event store', store: () => new InMemoryEventStore(), serve: (s, t) => apiHarness({ store: s, notificationTransport: t }) },
];
if (DATABASE_URL !== undefined) {
  backings.push({
    name: 'real PostgreSQL',
    store: () => new SqlEventStore(pgPoolClient(pool!)),
    serve: (s, t) => apiHarness({ store: s, idempotency: new SqlIdempotencyStore(pgPoolClient(pool!)), notificationTransport: t }),
  });
}

type Swept = { queued: { exceptionId: string; to: string; id: string; as: string }[]; alreadyQueued: number; nobodyToTell: string[]; breached: number };

describe.each(backings)('a late delivery exception is told to its holder, else the duty manager (OB-61) — on $name', ({ store: makeStore, serve }) => {
  const hours = (h: number): string => new Date(Date.now() + h * 3_600_000).toISOString();

  it('unheld → the rostered duty manager only; held → the holder only; re-holding does not re-tell the old holder; a restart re-sends nothing', async () => {
    const store = makeStore();
    const transport = recordingTransport();
    let h = serve(store, transport);
    const T = randomUUID();
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, key?: string) =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: key ?? `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
    await h.seedOwner(T, OWNER);
    await h.provisionRole(T, DUTY, 'store_manager');
    await h.provisionRole(T, OFF, 'store_manager');
    await h.provisionRole(T, MGR2, 'store_manager', ['br-2']);
    await h.provisionRole(T, CASH, 'cashier');
    await h.provisionRole(T, ACCT, 'accountant');
    await seedSubstitutionTruth(h, T, SWAP_PRODUCTS);
    await lateSwap(h.store, T);
    expect((await call('POST', '/v1/notifications/budget', OWNER, { capMinor: 100_000, costMinorByChannel: { sms: 25 } })).status).toBe(201);

    // The roster: DUTY is on the br-1 shift now as duty manager; OFF's br-1 shift ended an hour ago; MGR2 is on duty at br-2.
    for (const [emp, branchId] of [[DUTY, 'br-1'], [OFF, 'br-1'], [MGR2, 'br-2'], [CASH, 'br-1']] as const) {
      expect((await call('POST', `/v1/hr/workforce/employees/${emp}`, OWNER, { name: emp, branchId, roles: ['staff'], active: true })).status).toBe(200);
    }
    for (const [shiftId, branchId, from, to] of [['s-now', 'br-1', -2, 6], ['s-early', 'br-1', -9, -1], ['s-br2', 'br-2', -2, 6]] as const) {
      expect((await call('POST', `/v1/hr/workforce/shifts/${shiftId}`, OWNER, { branchId, startsAt: hours(from), endsAt: hours(to), requiredRoles: [{ role: 'duty_manager', count: 1 }] })).status).toBe(200);
    }
    for (const [shiftId, emp, role] of [['s-now', DUTY, 'duty_manager'], ['s-now', CASH, 'cashier'], ['s-early', OFF, 'duty_manager'], ['s-br2', MGR2, 'duty_manager']] as const) {
      expect((await call('POST', `/v1/hr/workforce/shifts/${shiftId}/assignments/${emp}`, OWNER, { role })).status).toBe(200);
    }

    const w = (await call('GET', '/v1/orders/substitution-exceptions', OWNER)).body as { exceptions: { exceptionId: string; owner: string; sla: { breached: boolean } }[] };
    expect(w.exceptions.find((e) => e.exceptionId === ID)).toMatchObject({ owner: 'customer_service_desk', sla: { breached: true } });

    // A cashier cannot run the sweep; a manager can.
    expect((await call('POST', '/v1/orders/substitution-exceptions/breach-alerts', CASH, {})).status).toBe(403);
    const sweep = async (key: string): Promise<Swept> => {
      const r = await call('POST', '/v1/orders/substitution-exceptions/breach-alerts', DUTY, {}, key);
      expect(r.status).toBe(200);
      return r.body as Swept;
    };

    // 1. Nobody holds it → the duty manager on the roster for br-1 now, and nobody else.
    const s1 = await sweep('sweep-1');
    expect(s1.queued).toEqual([{ exceptionId: ID, to: DUTY, id: `subx-${ID}-customer_service_desk-${DUTY}`, as: 'roster' }]);
    // The same request again is the same answer; a fresh sweep queues nothing twice.
    expect((await sweep('sweep-1')).queued).toHaveLength(1);
    expect(await sweep('sweep-2')).toMatchObject({ queued: [], alreadyQueued: 1, breached: 1 });

    // 2. The cashier claims it → the holder alone (the duty manager is not told again).
    expect((await call('POST', `/v1/orders/substitution-exceptions/${ID}/claim`, CASH, {})).status).toBe(200);
    const s3 = await sweep('sweep-3');
    expect(s3.queued).toEqual([{ exceptionId: ID, to: CASH, id: `subx-${ID}-customer_service_desk-${CASH}`, as: 'holder' }]);
    expect(s3.alreadyQueued).toBe(0);

    // 3. The cashier lets go, the off-shift manager takes it → that manager alone; the old holder is not told again.
    expect((await call('POST', `/v1/orders/substitution-exceptions/${ID}/release`, CASH, { reasonCode: 'shift-end' })).status).toBe(200);
    expect((await call('POST', `/v1/orders/substitution-exceptions/${ID}/claim`, OFF, {})).status).toBe(200);
    const s4 = await sweep('sweep-4');
    expect(s4.queued).toEqual([{ exceptionId: ID, to: OFF, id: `subx-${ID}-customer_service_desk-${OFF}`, as: 'holder' }]);
    expect((await sweep('sweep-5'))).toMatchObject({ queued: [], alreadyQueued: 1 });

    // On the PA-08 queue: exactly one alert per person told, then delivered by the sender (recipient and budget re-checked).
    const subx = async (): Promise<string[]> => ((await call('GET', '/v1/notifications/queue/pending', OWNER)).body as { pending: { id: string }[] }).pending.map((p) => p.id).filter((id) => id.startsWith('subx-')).sort();
    expect(await subx()).toEqual([DUTY, CASH, OFF].map((p) => `subx-${ID}-customer_service_desk-${p}`).sort());
    const drained = (await call('POST', '/v1/notifications/queue/drain', OWNER, {}, 'drain-1')).body as { outcome: { id: string; result: string }[] };
    expect(drained.outcome.filter((o) => o.id.startsWith('subx-')).map((o) => o.result)).toEqual(['delivered', 'delivered', 'delivered']);
    expect(transport.sent.map((m) => m.customerId).sort()).toEqual([CASH, DUTY, OFF].sort());
    expect(transport.sent.find((m) => m.customerId === DUTY)!.text).toMatch(/^Delivery exception past its time limit: order ord-late line l1 — policy short pick, ₹0\.00 at stake, in the customer service desk queue \(nobody has claimed it — you are the duty manager\)/);
    expect(transport.sent.find((m) => m.customerId === CASH)!.text).toContain(`held by you (${CASH})`);

    // 4. Restart: a fresh server over the same records — nothing is queued or delivered a second time.
    const transport2 = recordingTransport();
    h = serve(store, transport2);
    expect(await sweep('after-restart-1')).toMatchObject({ queued: [], alreadyQueued: 1, breached: 1 });
    await call('POST', '/v1/notifications/queue/drain', OWNER, {}, 'drain-after-restart');
    expect(transport2.sent).toEqual([]);

    // 5. Escalation clears the holder and moves it to the next queue (a new breach) → the duty manager, not the old holder.
    const esc = (await call('POST', '/v1/orders/substitution-exceptions/escalate', OWNER, {}, 'esc-1')).body as { escalated: { exceptionId: string; toOwner: string }[]; alerts: Swept };
    expect(esc.escalated).toEqual([expect.objectContaining({ exceptionId: ID, toOwner: 'fulfilment_supervisor' })]);
    expect(esc.alerts.queued).toEqual([{ exceptionId: ID, to: DUTY, id: `subx-${ID}-fulfilment_supervisor-${DUTY}`, as: 'roster' }]);
  }, 60_000);

  it('with no roster saying who is on duty, the store\'s managers by grant scope are told (not another store\'s, not the owner)', async () => {
    const store = makeStore();
    const h = serve(store, recordingTransport());
    const T = randomUUID();
    await h.seedOwner(T, OWNER);
    await h.provisionRole(T, DUTY, 'store_manager', ['br-1']);
    await h.provisionRole(T, OFF, 'store_manager');
    await h.provisionRole(T, MGR2, 'store_manager', ['br-2']);
    await h.provisionRole(T, CASH, 'cashier');
    await seedSubstitutionTruth(h, T, SWAP_PRODUCTS);
    await lateSwap(h.store, T);
    const r = await h.request({ method: 'POST', path: '/v1/orders/substitution-exceptions/breach-alerts', userId: OWNER, tenantId: T, idempotencyKey: 'fallback-1', body: {} });
    expect(r.status).toBe(200);
    expect((r.body as Swept).queued.map((q) => [q.to, q.as])).toEqual([[DUTY, 'store_manager_grants'], [OFF, 'store_manager_grants']]);
  }, 60_000);
});

describe.skipIf(DATABASE_URL === undefined)('in the served API the head-office worker raises the alerts on its own timer (PA-08 · OB-61)', () => {
  let cloud: RealCloud;
  afterAll(async () => { await cloud?.stop(); });
  it('nobody presses anything: the worker pass tells the duty manager (no roster → the store manager), and only them', async () => {
    const tenantId = randomUUID();
    const transport = recordingTransport();
    cloud = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId, owner: OWNER, packSigningKey: ['late', 'exception', 'key'].join('-').padEnd(48, '0'), providers: { notificationTransport: transport, opsAlertWorkerIntervalMs: 50 } });
    await cloud.grant(CASH, 'cashier');
    await lateSwap(new SqlEventStore(pgPoolClient(pool!)), tenantId);
    let pending: string[] = [];
    for (let i = 0; i < 300 && pending.filter((id) => id.startsWith(`subx-${ID}`)).length < 1; i += 1) {
      await sleep(20);
      pending = ((await cloud.request({ method: 'GET', path: '/v1/notifications/queue/pending', userId: OWNER })).body as { pending?: { id: string }[] }).pending?.map((p) => p.id) ?? [];
    }
    await sleep(300); // a few more passes: still only the one alert
    pending = ((await cloud.request({ method: 'GET', path: '/v1/notifications/queue/pending', userId: OWNER })).body as { pending?: { id: string }[] }).pending?.map((p) => p.id) ?? [];
    expect(pending.filter((id) => id.startsWith(`subx-${ID}`))).toEqual([`subx-${ID}-customer_service_desk-u-hr`]);
    expect(cloud.said.some((l) => l.includes('delivery-exception alert(s) put on the message queue'))).toBe(true);
  }, 60_000);
});
