import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Notification delivery queue, end to end (M31-FR-04, API-06). The durable outbox behind the send-guard: a
// message is enqueued, marked delivered on success, or its failure recorded — and after maxAttempts failures
// it moves to a VISIBLE dead-letter queue for a person, NEVER silently dropped (hard rule #6). The
// retry-then-dead-letter state machine is the tested engine's, replayed over the append-only log. Gated
// notification.send.check.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const enqueue = (h: ApiHarness, u: string, id: string, channel: string, key = `e-${id}`) =>
  h.request({ method: 'POST', path: `/v1/notifications/queue/${id}`, userId: u, tenantId: A, idempotencyKey: key, body: { channel } });
const delivered = (h: ApiHarness, u: string, id: string, key = `d-${id}`) =>
  h.request({ method: 'POST', path: `/v1/notifications/queue/${id}/delivered`, userId: u, tenantId: A, idempotencyKey: key });
const failed = (h: ApiHarness, u: string, id: string, body: Record<string, unknown>, key: string) =>
  h.request({ method: 'POST', path: `/v1/notifications/queue/${id}/failed`, userId: u, tenantId: A, idempotencyKey: key, body });
const pending = (h: ApiHarness, u: string) =>
  h.request({ method: 'GET', path: '/v1/notifications/queue/pending', userId: u, tenantId: A });
const deadLetters = (h: ApiHarness, u: string) =>
  h.request({ method: 'GET', path: '/v1/notifications/queue/dead-letters', userId: u, tenantId: A });

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');                // notification.send.check
  await h.provisionRole(A, 'u-cash', 'cashier');  // none
  return h;
}

describe('notification queue: enqueue, deliver, retry then dead-letter — never dropped (M31-FR-04)', () => {
  it('enqueues (idempotently), marks delivered, and drops it off the pending list', async () => {
    const h = await cast();
    expect((await enqueue(h, 'u-owner', 'n1', 'sms')).status).toBe(201);
    expect((await enqueue(h, 'u-owner', 'n1', 'sms', 'e-n1-again')).body).toMatchObject({ alreadyQueued: true });
    expect((await pending(h, 'u-owner')).body).toMatchObject({ count: 1 });

    expect((await delivered(h, 'u-owner', 'n1')).body).toMatchObject({ id: 'n1', state: 'delivered' });
    expect((await pending(h, 'u-owner')).body).toMatchObject({ count: 0 }); // no longer awaiting delivery

    // Survives a restart.
    const h2 = apiHarness({ store: h.store });
    expect((await pending(h2, 'u-owner')).body).toMatchObject({ count: 0 });
  });

  it('retries a failing send and dead-letters it after maxAttempts — kept, never dropped', async () => {
    const h = await cast();
    await enqueue(h, 'u-owner', 'n2', 'whatsapp');

    // maxAttempts 3: two failures keep it pending, the third dead-letters it.
    expect((await failed(h, 'u-owner', 'n2', { reason: 'no answer', maxAttempts: 3 }, 'f1')).body).toMatchObject({ state: 'pending', attempts: 1 });
    expect((await failed(h, 'u-owner', 'n2', { reason: 'no answer', maxAttempts: 3 }, 'f2')).body).toMatchObject({ state: 'pending', attempts: 2 });
    expect((await failed(h, 'u-owner', 'n2', { reason: 'number invalid', maxAttempts: 3 }, 'f3')).body).toMatchObject({ state: 'dead_letter', attempts: 3 });

    // It is on the visible dead-letter queue, and off the pending list — never silently lost.
    const dl = (await deadLetters(h, 'u-owner')).body as { deadLetters: { id: string; reason: string }[]; count: number };
    expect(dl.count).toBe(1);
    expect(dl.deadLetters[0]).toMatchObject({ id: 'n2', reason: 'number invalid' });
    expect((await pending(h, 'u-owner')).body).toMatchObject({ count: 0 });

    // Failing an already-dead-lettered send is a no-op (already resolved).
    expect((await failed(h, 'u-owner', 'n2', { reason: 'again' }, 'f4')).body).toMatchObject({ state: 'dead_letter' });

    // Durable across a restart.
    const h2 = apiHarness({ store: h.store });
    expect((await deadLetters(h2, 'u-owner')).body).toMatchObject({ count: 1 });
  });

  it('rejects a missing channel / reason (400), 404s an unknown id, and gates on notification.send.check', async () => {
    const h = await cast();
    expect((await enqueue(h, 'u-owner', 'n3', '')).status).toBe(400);
    await enqueue(h, 'u-owner', 'n3', 'email');
    expect(codeOf(await failed(h, 'u-owner', 'n3', {}, 'f-noreason'))).toBe('failure_needs_a_reason');

    expect((await delivered(h, 'u-owner', 'ghost', 'd-ghost')).status).toBe(404);
    expect((await failed(h, 'u-owner', 'ghost', { reason: 'x' }, 'f-ghost')).status).toBe(404);

    // A cashier holds no notification.send.check → refused on write and read.
    expect((await enqueue(h, 'u-cash', 'n9', 'sms', 'e-cash')).status).toBe(403);
    expect((await pending(h, 'u-cash')).status).toBe(403);
    expect((await deadLetters(h, 'u-cash')).status).toBe(403);
  });
});
