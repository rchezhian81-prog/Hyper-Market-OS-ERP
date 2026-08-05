import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { pgClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { buildRouter, handle, MemoryIdempotencyStore, type HttpRequest } from '../../services/kernel/src/index';
import { AccessControl } from '../../packages/rbac/src/rbac';
import { buildSurface } from '../../services/api/src/main';
import { STREAM } from '../../services/api/src/adapters';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { SyncAgent } from '../../edge/sync-agent/src/agent';
import { httpTransport } from '../../edge/sync-agent/src/http-transport';
import { makeEvent } from '../../packages/contracts/src/event';
import type { DomainEvent } from '../../packages/contracts/src/event';

/**
 * **The spine: a sale rung up with no internet reaches the cloud, exactly once.**
 *
 * Every piece of this has been tested apart. The edge commits durably before the receipt prints;
 * the outbox queues and dead-letters honestly; the agent drains in order with backoff; the API
 * banks a sale and dedupes a resend. What has never been tested is the *join* — and until this
 * session the join did not exist, because `SyncTransport` was a port with no implementation. The
 * edge could queue a sale and had nowhere to send it.
 *
 * The whole product rests on this working when the line is bad, so that is what is exercised:
 * the shop trades through an outage, the link comes back, and every sale is in the cloud once.
 *
 * `fetch` is replaced by a function that drives the real API surface against real PostgreSQL —
 * so the transport, the router, the permission check, the idempotency store, the POS rules and
 * the append-only ledger are all the production ones. Only the socket is missing.
 *
 * Set DATABASE_URL to run; without it the suite skips rather than passing quietly.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const RUN = `c${Date.now().toString(36)}`;
const TENANT = `8${Date.now().toString(16).slice(-7)}-8888-4888-8888-${'8'.repeat(12)}`;
const KEY = ['reaches', 'the', 'cloud', 'signing', 'key'].join('-').padEnd(48, '0');
const COMMITTED = new Date(Date.now() - 60_000).toISOString();
const TOKEN = ['edge', 'token', 'for', 'this', 'store'].join('-').padEnd(40, 'y');

const ACCESS = new AccessControl(
  [{ id: 'lane', name: 'Lane', permissions: ['pos.sale.sync', 'pos.sale.read', 'inventory.movement.append'] }],
  [{ userId: 'u-lane', roleId: 'lane', branchScope: 'all' }],
);

/** A sale as the lane commits it, wrapped as the event the outbox carries. */
const saleEvent = (n: number): DomainEvent => makeEvent({
  id: `sale-${RUN}-${n}`,
  type: 'SaleCommitted',
  occurredAt: COMMITTED,
  // Minted at the lane when the sale was committed — not per attempt.
  idempotencyKey: `edge-${RUN}-S${n}`,
  source: 'edge/lane-1',
  payload: {
    saleId: `${RUN}-S${n}`, receiptNumber: `${RUN}-R${n}`, laneId: 'lane-1', cashierId: 'u-meena',
    tradingDay: COMMITTED.slice(0, 10), committedAt: COMMITTED, totalMinor: 10_000 + n,
    currency: 'INR', packVersion: 0,
    lines: [{ productId: 'P1', quantityMinor: 1, uom: 'each', unitPriceMinor: 10_000 + n, lineTotalMinor: 10_000 + n }],
    tenders: [{ kind: 'cash', amountMinor: 10_000 + n }],
  },
});

describe.skipIf(!DATABASE_URL)('the shop reaches the cloud (real PostgreSQL)', () => {
  let client: Client;
  let store: SqlEventStore;
  let kernel: Parameters<typeof handle>[0];

  /** The link. Flipped to simulate an outage — nothing else in the test changes. */
  let online = true;
  let requests = 0;

  /**
   * A `fetch` that drives the real API surface.
   *
   * Everything below the socket is production: the router, the permission check, the idempotency
   * store, the POS rules, the adapters and the append-only ledger.
   */
  const apiFetch = (async (url: string, init: RequestInit): Promise<Response> => {
    requests += 1;
    if (!online) throw new Error('ENETUNREACH');
    const request: HttpRequest = {
      method: 'POST',
      path: new URL(url).pathname,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)) as unknown,
    };
    const res = await handle(kernel, request);
    return new Response(JSON.stringify(res.body), { status: res.status });
  }) as unknown as typeof globalThis.fetch;

  const transport = () => httpTransport({
    baseUrl: 'https://cloud.example.test', token: TOKEN, fetch: apiFetch, timeoutMs: 5_000,
  });
  const agentFor = (box: SyncOutbox) => new SyncAgent(box, transport());

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    const sql = pgClient(client);
    const dir = 'db/migrations';
    await runMigrations(sql, readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
    store = new SqlEventStore(sql);

    const built = buildRouter(buildSurface({ signingKey: KEY, migrationTargetKind: 'rehearsal', store }));
    expect(built.ok, built.refusals.map((r) => r.detail).join('; ')).toBe(true);
    kernel = {
      router: built.router!,
      authenticate: () => ({ tenantId: TENANT, userId: 'u-lane', branchId: 'b-main' }),
      access: ACCESS, idempotency: new MemoryIdempotencyStore(),
      newTraceId: () => `trace-${RUN}`,
    };
  });

  afterAll(async () => { await client.end(); });

  // ─── The shop trades through an outage ──────────────────────────────────────

  const outbox = new SyncOutbox();

  it('keeps selling with the line down, and nothing reaches the cloud', async () => {
    online = false;
    for (let n = 1; n <= 5; n += 1) outbox.enqueue(saleEvent(n));

    const result = await agentFor(outbox).drain({ at: COMMITTED });

    // Nothing acknowledged, nothing dead-lettered, everything still queued. A shop on a rural line
    // meets this several times a day, and none of it says the sales were bad.
    expect(result.acknowledged).toBe(0);
    expect(result.deadLettered).toBe(0);
    expect(result.remaining).toBe(5);
    expect((await store.readStream(TENANT, STREAM.sales)).length).toBe(0);
  });

  it('stops hammering a dead link rather than retrying every item', async () => {
    // The pass ended early. Retrying all five against a link that is plainly down burns the
    // attempt budget on every sale at once, and the fifth would dead-letter for being fifth.
    online = false;
    requests = 0;
    const result = await agentFor(outbox).drain({ at: COMMITTED, stopAfterConsecutiveFailures: 2 });
    expect(result.stoppedEarly).toBe(true);
    expect(requests).toBeLessThan(5);
  });

  it('tells the cashier the truth while it is offline (P-08)', () => {
    const badge = agentFor(outbox).health();
    expect(badge.unsentCount).toBe(5);
    expect(badge.deadLetterCount).toBe(0);
  });

  // ─── The line comes back ────────────────────────────────────────────────────

  it('delivers every held sale once the link returns', async () => {
    online = true;
    const result = await agentFor(outbox).drain({ at: COMMITTED });

    expect(result.acknowledged).toBe(5);
    expect(result.remaining).toBe(0);
    expect(agentFor(outbox).health().unsentCount).toBe(0);

    const banked = (await store.readStream(TENANT, STREAM.sales, { type: 'SaleCommitted' }));
    expect(banked).toHaveLength(5);
  });

  it('banks each sale EXACTLY once, however many times it was attempted', async () => {
    // Three failed passes and a successful one is four deliveries of the same sale from the edge's
    // point of view. The key was minted at the lane, so they collapse to one (§31.1).
    for (let i = 0; i < 3; i += 1) {
      outbox.enqueue(saleEvent(1)); // the outbox itself dedupes; this is belt and braces
      await agentFor(outbox).drain({ at: COMMITTED });
    }
    const forSaleOne = (await store.readStream(TENANT, STREAM.sales, { type: 'SaleCommitted' }))
      .filter((e) => (e.event.payload as { saleId: string }).saleId === `${RUN}-S1`);
    expect(forSaleOne).toHaveLength(1);
  });

  it('a re-sent sale still arrives once when the outbox has forgotten it', async () => {
    // The harder case: the edge restarted, lost its outbox, and re-queues a sale it already sent.
    // Nothing at the edge can tell. The cloud's dedupe on the event key is what saves it.
    const fresh = new SyncOutbox();
    fresh.enqueue(saleEvent(2));
    const result = await agentFor(fresh).drain({ at: COMMITTED });
    expect(result.acknowledged).toBe(1);

    const forSaleTwo = (await store.readStream(TENANT, STREAM.sales, { type: 'SaleCommitted' }))
      .filter((e) => (e.event.payload as { saleId: string }).saleId === `${RUN}-S2`);
    expect(forSaleTwo).toHaveLength(1);
  });

  // ─── What cannot be delivered is kept, never dropped ────────────────────────

  it('dead-letters what the cloud will never take, and keeps it (hard rule #6)', async () => {
    const nonsense = new SyncOutbox();
    nonsense.enqueue(makeEvent({
      id: `bad-${RUN}`, type: 'SaleCommitted', occurredAt: COMMITTED,
      idempotencyKey: `edge-${RUN}-BAD`, source: 'edge/lane-1',
      // Missing everything the POS route needs — a permanent 400, not a bad minute.
      payload: { nothing: 'useful' },
    }));

    const result = await agentFor(nonsense).drain({ at: COMMITTED, maxAttempts: 1 });
    expect(result.deadLettered).toBe(1);
    expect(agentFor(nonsense).health().deadLetterCount).toBe(1);

    // Kept, and visible. Never discarded — this is the one that needs a person.
    const dead = nonsense.deadLetters();
    expect(dead).toHaveLength(1);
    expect(dead[0]?.reason).toBeTruthy();
  });

  it('an event with no cloud endpoint is dead-lettered, not posted somewhere hopeful', async () => {
    const unknown = new SyncOutbox();
    unknown.enqueue(makeEvent({
      id: `unk-${RUN}`, type: 'SomethingNobodyWiredUp', occurredAt: COMMITTED,
      idempotencyKey: `edge-${RUN}-UNK`, source: 'edge/lane-1', payload: {},
    }));
    const result = await agentFor(unknown).drain({ at: COMMITTED, maxAttempts: 1 });
    expect(result.deadLettered).toBe(1);
    expect(unknown.deadLetters()[0]?.reason).toContain('no cloud endpoint');
  });

  it('the sales it delivered cannot be altered afterwards (hard rule #2)', async () => {
    const first = (await store.readStream(TENANT, STREAM.sales, { type: 'SaleCommitted' }))[0]!;
    await expect(
      client.query('UPDATE event_ledger SET payload = $1 WHERE id = $2', ['{"x":1}', first.event.id]),
    ).rejects.toThrow(/append-only/i);
  });
});
