import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Connector DELIVERY queue, end to end through the real API (M32-FR-02, the transport half, API-11). The
// mapping half decides a record is SAFE to send; this is the durable outbox that carries the ones that may.
// A message is enqueued, marked delivered when the transport gets it through (a duplicate counts as
// delivered), or its failure recorded — permanent failures dead-letter at once, retryable ones back off and
// dead-letter after maxAttempts. A dead letter is kept on a VISIBLE queue, NEVER silently dropped (hard rule
// #6). The retry-then-dead-letter state machine is the tested `@sre/integration` engine's, replayed over the
// append-only log. Writes gated platform.setup.write; reads platform.health.read.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const CONN = 'tally';
const msg = (over: Record<string, unknown> = {}) => ({
  kind: 'journal', payload: { VOUCHERNUMBER: 'V-1', AMOUNT: 412_000 }, deliveryKey: 'k-1', connectorVersion: 'v1', ...over,
});

const enqueue = (h: ApiHarness, u: string, id: string, body: Record<string, unknown> = msg(), key = `e-${id}`, tenantId = A, conn = CONN) =>
  h.request({ method: 'POST', path: `/v1/integration/connectors/${conn}/queue/${id}`, userId: u, tenantId, idempotencyKey: key, body });
const delivered = (h: ApiHarness, u: string, id: string, key = `d-${id}`, tenantId = A, conn = CONN) =>
  h.request({ method: 'POST', path: `/v1/integration/connectors/${conn}/queue/${id}/delivered`, userId: u, tenantId, idempotencyKey: key });
const failed = (h: ApiHarness, u: string, id: string, body: Record<string, unknown>, key: string, tenantId = A, conn = CONN) =>
  h.request({ method: 'POST', path: `/v1/integration/connectors/${conn}/queue/${id}/failed`, userId: u, tenantId, idempotencyKey: key, body });
const pending = (h: ApiHarness, u: string, tenantId = A, conn = CONN) =>
  h.request({ method: 'GET', path: `/v1/integration/connectors/${conn}/queue/pending`, userId: u, tenantId });
const deadLetters = (h: ApiHarness, u: string, tenantId = A, conn = CONN) =>
  h.request({ method: 'GET', path: `/v1/integration/connectors/${conn}/queue/dead-letters`, userId: u, tenantId });

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');                     // platform.setup.write + platform.health.read
  await h.provisionRole(A, 'u-mgr', 'store_manager');  // platform.health.read (reads), NOT setup.write
  await h.provisionRole(A, 'u-cash', 'cashier');       // neither
  return h;
}

describe('connector delivery queue: enqueue, deliver, retry then dead-letter — never dropped (M32-FR-02)', () => {
  it('enqueues (idempotently), marks delivered, and drops it off the pending list — durably', async () => {
    const h = await cast();
    expect((await enqueue(h, 'u-owner', 'm1')).status).toBe(201);
    // A re-enqueue of the same id returns the existing item, never a second copy.
    expect((await enqueue(h, 'u-owner', 'm1', msg(), 'e-m1-again')).body).toMatchObject({ alreadyQueued: true });
    const p = (await pending(h, 'u-owner')).body as { count: number; pending: { messageId: string; connectorVersion: string }[] };
    expect(p.count).toBe(1);
    // The message travels with its own version, so an upgrade never re-maps it in flight.
    expect(p.pending[0]).toMatchObject({ messageId: 'm1', connectorVersion: 'v1' });

    expect((await delivered(h, 'u-owner', 'm1')).body).toMatchObject({ messageId: 'm1', state: 'delivered' });
    expect((await pending(h, 'u-owner')).body).toMatchObject({ count: 0 });
    // A delivery of an already-delivered message is a no-op.
    expect((await delivered(h, 'u-owner', 'm1', 'd-m1-again')).body).toMatchObject({ note: 'already resolved' });

    // Survives a restart — the queue is the append-only log replayed.
    const h2 = apiHarness({ store: h.store });
    expect((await pending(h2, 'u-owner')).body).toMatchObject({ count: 0 });
  });

  it('retries a retryable failure and dead-letters it after maxAttempts — kept, never dropped', async () => {
    const h = await cast();
    // maxAttempts 3 (set at enqueue): two failures keep it queued, the third dead-letters it.
    await enqueue(h, 'u-owner', 'm2', msg({ maxAttempts: 3 }));
    expect((await failed(h, 'u-owner', 'm2', { reason: 'connection reset' }, 'f1')).body).toMatchObject({ state: 'queued', attempts: 1 });
    expect((await failed(h, 'u-owner', 'm2', { reason: 'connection reset' }, 'f2')).body).toMatchObject({ state: 'queued', attempts: 2 });
    expect((await failed(h, 'u-owner', 'm2', { reason: 'still down' }, 'f3')).body).toMatchObject({ state: 'dead_lettered', attempts: 3 });

    // On the visible dead-letter queue and off pending — never silently lost (hard rule #6).
    const dl = (await deadLetters(h, 'u-owner')).body as { deadLetters: { messageId: string; lastError: string }[]; count: number };
    expect(dl.count).toBe(1);
    expect(dl.deadLetters[0]?.messageId).toBe('m2');
    expect(dl.deadLetters[0]?.lastError).toContain('gave up after 3 attempts');
    expect((await pending(h, 'u-owner')).body).toMatchObject({ count: 0 });

    // Failing an already-dead-lettered message is a no-op.
    expect((await failed(h, 'u-owner', 'm2', { reason: 'again' }, 'f4')).body).toMatchObject({ note: 'already resolved' });

    // The dead letter is durable across a restart — it cannot be dropped, and there is no route to delete it.
    const h2 = apiHarness({ store: h.store });
    expect((await deadLetters(h2, 'u-owner')).body).toMatchObject({ count: 1 });
  });

  it('DEAD-LETTERS a permanent failure at once, without burning retries', async () => {
    const h = await cast();
    await enqueue(h, 'u-owner', 'm3', msg({ maxAttempts: 5 }));
    // A rejected record (permanent) dead-letters immediately — retrying a 400 nine times buries the message
    // that mattered behind it.
    const r = await failed(h, 'u-owner', 'm3', { reason: 'destination rejected: unknown ledger', permanent: true }, 'fp');
    expect(r.body).toMatchObject({ state: 'dead_lettered', attempts: 1 });
    const dl = (await deadLetters(h, 'u-owner')).body as { deadLetters: { messageId: string; lastError: string }[]; count: number };
    expect(dl.deadLetters[0]).toMatchObject({ messageId: 'm3', lastError: 'destination rejected: unknown ledger' });
  });

  it('validates the message, 404s an unknown id, gates writes and reads, and is per-tenant', async () => {
    const h = await cast();
    // Missing message fields / payload / bad maxAttempts.
    expect(codeOf(await enqueue(h, 'u-owner', 'mbad', { kind: 'journal', deliveryKey: 'k', connectorVersion: '' }))).toBe('enqueue_needs_message_fields');
    expect(codeOf(await enqueue(h, 'u-owner', 'mbad2', { kind: 'journal', deliveryKey: 'k', connectorVersion: 'v1' }))).toBe('enqueue_needs_a_payload');
    expect(codeOf(await enqueue(h, 'u-owner', 'mbad3', msg({ maxAttempts: 0 })))).toBe('max_attempts_not_a_count');

    await enqueue(h, 'u-owner', 'm4');
    expect(codeOf(await failed(h, 'u-owner', 'm4', {}, 'f-noreason'))).toBe('failure_needs_a_reason');

    // Unknown message id → 404 on both transitions.
    expect((await delivered(h, 'u-owner', 'ghost', 'd-ghost')).status).toBe(404);
    expect((await failed(h, 'u-owner', 'ghost', { reason: 'x' }, 'f-ghost')).status).toBe(404);

    // A cashier holds neither permission → refused on write and read.
    expect((await enqueue(h, 'u-cash', 'm9', msg(), 'e-cash')).status).toBe(403);
    expect((await pending(h, 'u-cash')).status).toBe(403);
    expect((await deadLetters(h, 'u-cash')).status).toBe(403);
    // A store manager may READ the queue (health) but not enqueue (setup).
    expect((await enqueue(h, 'u-mgr', 'm10', msg(), 'e-mgr')).status).toBe(403);
    expect((await pending(h, 'u-mgr')).status).toBe(200);

    // Per-tenant: another tenant sees nothing of A's queue.
    await h.seedOwner(B, 'u-owner-b');
    expect((await pending(h, 'u-owner-b', B)).body).toMatchObject({ count: 0 });
    expect((await deadLetters(h, 'u-owner-b', B)).body).toMatchObject({ count: 0 });
  });
});
