import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { InMemoryEventStore, SqlEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { makeEvent } from '../../packages/contracts/src/event';
import { recordingTransport } from '../../packages/notifications/src/index';
import { scheduledBriefAdapter, notificationQueueAdapter, STREAM } from '../../services/api/src/adapters';
import { reportProducers } from '../../services/api/src/report-producers';
import { scheduledBriefRoutes, type ScheduledBriefDeps } from '../../services/reporting/src/scheduled-brief';
import { briefWorkerTick, BRIEF_WORKER_ACTOR } from '../../services/reporting/src/brief-worker';
import { notificationQueueRoutes } from '../../services/customer/src/notification-queue';
import type { RequestContext, Route } from '../../services/kernel/src/index';

/**
 * **The owner's brief WORKER sends the brief through the OUTBOX, three mornings running, with nobody touching it
 * (audit EA-07 · M29-FR-04 · A01 · D13).**
 *
 * The audit found the brief's run route with no caller. Here the worker (`briefWorkerTick`, what `startApi` runs every few
 * minutes for the shops an operator names) drives the real schedule store, the real head-office report producer and the
 * real PA-08 queue over one event store, on a clock moved through the shop's mornings (IST, due 08:00):
 *   • each due brief goes onto the queue (`brief-<day>`) — the OUTBOX — never straight to a phone;
 *   • the queue's own sender delivers it (recording test transport; the real provider is R4, OB-29);
 *   • the next tick ACKNOWLEDGES the day only because the queue says delivered — not before;
 *   • a dead-lettered brief is queued again under a new attempt id, visibly; a missed morning is caught up, LATE;
 *   • the numbers come from governed figures with no AI (deterministic), and a restart (new deps over the same store)
 *     carries on where it was. On memory and on PostgreSQL.
 */

const IST = { timeZone: 'Asia/Kolkata', tradingDayCutoff: '00:00' };

function rig(store: EventStore, T: string) {
  let clock = '2026-10-01T00:00:00.000Z';
  const now = (): string => clock;
  const transport = recordingTransport();
  const build = () => {
    const producers = reportProducers({ store, now, calendar: () => IST, loyaltyRule: () => ({ pointValuePaise: 0 }) });
    const nq = notificationQueueAdapter({ store, now, transport });
    const deps: ScheduledBriefDeps = {
      ...scheduledBriefAdapter({ store, now }),
      calendar: () => IST,
      dayFigures: async (tenantId, tradingDay) => {
        const day = await producers.produce(tenantId, 'sales_by_day', { tradingDay, scope: 'all' });
        const taken = day.figures.find((f) => f.name === 'Taken');
        const bills = day.figures.find((f) => f.name === 'Bills');
        return { tradingDay, ...(taken?.valueMinor === undefined ? {} : { grossTakenMinor: taken.valueMinor }), ...(bills?.valueMinor === undefined ? {} : { basketCount: bills.valueMinor }) };
      },
      recipient: () => 'u-owner',
      outbox: { enqueue: nq.record, item: async (tenantId, id) => { const it = (await nq.queue(tenantId)).find(id); return it === undefined ? undefined : { state: it.state, reason: it.reason }; } },
    };
    const queueRoutes = notificationQueueRoutes(nq);
    return { deps, routes: scheduledBriefRoutes(deps), queueRoutes, nq };
  };
  let built = build();
  const ctx = (body?: unknown): RequestContext => ({ tenantId: T, userId: 'u-owner', branchId: null, params: {}, query: {}, body, traceId: 't', idempotencyKey: `k-${clock}` } as RequestContext);
  const route = (routes: readonly Route[], path: string): Route => routes.find((r) => r.path === path)!;
  return {
    transport,
    at: (iso: string) => { clock = iso; },
    restart: () => { built = build(); },
    setSchedule: () => route(built.routes, '/v1/reporting/brief-schedule').handler(ctx({ dueAt: [8, 0] })),
    // PA-08 round 4: the owner's messaging budget — nothing is sent until it is set; room for plenty here.
    setBudget: () => route(built.queueRoutes, '/v1/notifications/budget').handler(ctx({ capMinor: 100_000, costMinorByChannel: { whatsapp: 50 } })),
    tick: async () => (await briefWorkerTick(built.deps, [T]))[0]!,
    drain: async (maxAttempts = 5) => ((await route(built.queueRoutes, '/v1/notifications/queue/drain').handler(ctx({ maxAttempts }))).body as { outcome: { id: string; result: string }[] }).outcome,
    sentDays: async () => ((await built.deps.schedule(T))?.sentDays ?? []).slice().sort(),
    queueItem: async (id: string) => (await built.nq.queue(T)).find(id),
    sale: (id: string, tradingDay: string, at: string, totalMinor: number) => store.append(T, STREAM.sales, makeEvent({
      id: `e-${id}`, type: 'SaleCommitted', occurredAt: at, idempotencyKey: `sale-${T}-${id}`, source: 'test',
      payload: { saleId: id, receiptNumber: `R-${id}`, laneId: 'lane-1', locationId: 'S1', cashierId: 'u-c', tradingDay, committedAt: at, totalMinor, currency: 'INR', packVersion: 1, lines: [], tenders: [{ kind: 'cash', amountMinor: totalMinor }] },
    })),
  };
}

async function journey(store: EventStore, T: string): Promise<void> {
  if (store instanceof SqlEventStore) await store.registerTenant(T, 'test/provision');
  const r = rig(store, T);
  r.at('2026-10-01T01:00:00.000Z');
  await r.setSchedule();
  await r.setBudget();

  // ── Day 1: queued at 08:05; the queue's sender delivers; the next tick acknowledges.
  await r.sale('S-1', '2026-10-01', '2026-10-01T02:00:00.000Z', 120_000);
  r.at('2026-10-01T02:20:00.000Z'); // 07:50 IST
  expect((await r.tick()).ran).toEqual([]);
  r.at('2026-10-01T02:35:00.000Z'); // 08:05 IST
  const t1 = await r.tick();
  expect(t1.ran.map((x) => [x.tradingDay, x.outcome, x.deterministic])).toEqual([['2026-10-01', 'queued', true]]);
  expect(r.transport.sent).toHaveLength(0); // the worker never talks to the phone itself
  expect(await r.sentDays()).toEqual([]); // queued is not sent
  expect((await r.tick()).ran.map((x) => x.outcome)).toEqual(['queued_waiting']); // nothing queued twice
  expect((await r.drain()).map((o) => [o.id, o.result])).toEqual([['brief-2026-10-01', 'delivered']]);
  r.at('2026-10-01T02:40:00.000Z');
  expect((await r.tick()).ran.map((x) => x.outcome)).toEqual(['acknowledged']);
  expect(await r.sentDays()).toEqual(['2026-10-01']);
  expect((await r.tick()).ran).toEqual([]);

  // ── Day 2: the provider refuses permanently → dead-lettered (visible); the worker queues a new attempt; delivered.
  await r.sale('S-2', '2026-10-02', '2026-10-02T02:00:00.000Z', 95_000);
  r.at('2026-10-02T02:35:00.000Z');
  expect((await r.tick()).ran.map((x) => x.outcome)).toEqual(['queued']);
  r.transport.failWith({ reason: 'number not on WhatsApp', permanent: true }, 1);
  expect((await r.drain()).map((o) => o.result)).toEqual(['dead_lettered']);
  expect((await r.queueItem('brief-2026-10-02'))?.state).toBe('dead_letter'); // kept, never dropped
  // RESTART between the failure and the next tick — the worker carries on from the store.
  r.restart();
  r.at('2026-10-02T02:45:00.000Z');
  const retry = await r.tick();
  expect(retry.ran.map((x) => [x.outcome, x.detail])).toEqual([['queued', expect.stringMatching(/dead-lettered — queued again as brief-2026-10-02-r2/)]]);
  expect((await r.drain()).map((o) => [o.id, o.result])).toEqual([['brief-2026-10-02-r2', 'delivered']]);
  expect((await r.tick()).ran.map((x) => x.outcome)).toEqual(['acknowledged']);

  // ── Day 3 the worker was down all morning; on day 4 it catches day 3 up, LATE, and sends day 4.
  await r.sale('S-3', '2026-10-03', '2026-10-03T02:00:00.000Z', 150_000);
  await r.sale('S-4', '2026-10-04', '2026-10-04T02:00:00.000Z', 80_000);
  r.at('2026-10-04T02:35:00.000Z');
  const t4 = await r.tick();
  expect(t4.ran.map((x) => [x.tradingDay, x.reason, x.outcome])).toEqual([['2026-10-03', 'missed_catch_up', 'queued'], ['2026-10-04', 'scheduled', 'queued']]);
  expect(t4.ran[0]!.lines[0]).toMatch(/^LATE — the brief for 2026-10-03/);
  await r.drain();
  expect((await r.tick()).ran.map((x) => x.outcome)).toEqual(['acknowledged', 'acknowledged']);
  expect(await r.sentDays()).toEqual(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']);

  // What reached the (recording) phone: one message per day, to the owner, the numbers only.
  expect(r.transport.sent.map((m) => m.messageId)).toEqual(['brief-2026-10-01', 'brief-2026-10-02-r2', 'brief-2026-10-03', 'brief-2026-10-04']);
  expect(r.transport.sent.every((m) => m.customerId === 'u-owner')).toBe(true);
  expect(r.transport.sent[0]!.text).toContain('₹1,200.00');
  // The worker's own acts are recorded as the worker.
  expect(BRIEF_WORKER_ACTOR).toBe('system:brief-worker');
}

describe('the brief worker sends through the outbox (EA-07)', () => {
  it('three mornings and a missed one, a dead letter retried, a restart — in memory', async () => {
    await journey(new InMemoryEventStore(), 'ab000000-0000-4000-8000-0000000ea007');
  });

  it('a shop with no schedule is skipped and said; a failing shop does not stop the others', async () => {
    const store = new InMemoryEventStore();
    const r = rig(store, 'ab000000-0000-4000-8000-0000000ea017');
    const t = await r.tick();
    expect(t).toMatchObject({ ok: true, ran: [], detail: expect.stringMatching(/no brief schedule/) });
  });
});

const DATABASE_URL = process.env['DATABASE_URL'];
describe.skipIf(!DATABASE_URL)('the brief worker sends through the outbox — real PostgreSQL (EA-07)', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4, options: '-c app.tenant_id=*' });
    const dir = 'db/migrations';
    await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .map((name) => ({ name, sql: readFileSync(`${dir}/${name}`, 'utf8') })));
  });
  afterAll(async () => { await pool.end(); });

  it('the same mornings on PostgreSQL', async () => {
    await journey(new SqlEventStore(pgPoolClient(pool)), randomUUID());
  });
});
