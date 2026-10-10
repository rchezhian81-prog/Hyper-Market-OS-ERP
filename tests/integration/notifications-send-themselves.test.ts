import { describe, it, expect, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { startRealCloud, type RealCloud } from '../support/real-store';
import { recordingTransport, type NotificationTransport, type OutboundMessage } from '../../packages/notifications/src/index';

/**
 * **PA-08 — notifications send themselves: a worker in the head-office process drains the queue on its own timer, with
 * consent and the messaging budget re-checked at the moment of sending (M31-FR-03/04 · M32-FR-02 · D3 · hard rule #6).**
 *
 * Before: the queue was durable and consent-checked, but a message left only when somebody called the drain route. Here
 * the REAL API (`startApi`, the code the container runs) on REAL PostgreSQL is handed a message provider exactly as a
 * deployment would hand one in — the RECORDING test adapter, because every real provider is an external gate (the SMS
 * provider is release R4, OB-29) — and NO test step ever calls the drain route. The worker:
 *   • sends a queued message by itself, once (idempotent on the message id), and costs it against the owner's budget;
 *   • on a provider timeout records the attempt and waits out the backoff (it does not hammer), then sends;
 *   • dead-letters a permanent failure — visible, never dropped;
 *   • WITHHOLDS a message whose customer withdrew consent after it was queued — kept, never sent;
 *   • HOLDS a message the month's budget no longer covers (budget re-checked at send, not just at enqueue), keeps it
 *     pending and visible, and sends it when the owner raises the budget;
 *   • survives a restart of the API process: the held message, the dead letter and the spend are on the ledger, nothing
 *     already sent is sent again, and the new process's worker carries on.
 * The budget is checked at enqueue too: a message that does not fit is not queued. No budget set → nothing is queued.
 *
 * Synthetic data only (hard rule #7): a fresh random tenant per run. Needs DATABASE_URL; without it the suite SKIPS.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const describeOrSkip = DATABASE_URL ? describe : describe.skip;
const KEY = ['notifications', 'send', 'themselves', 'key'].join('-').padEnd(48, '0');
const OWNER = 'u-owner';
const T0 = Date.parse('2026-10-12T04:00:00.000Z');
const travel = (minutes: number): void => { vi.setSystemTime(new Date(T0 + minutes * 60_000)); };
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

/** The recording adapter, counting every call (a resend would show here even though the adapter dedupes by id). */
function countingTransport(): NotificationTransport & { readonly sent: OutboundMessage[]; readonly calls: string[]; failWith: ReturnType<typeof recordingTransport>['failWith'] } {
  const inner = recordingTransport();
  const calls: string[] = [];
  return {
    name: inner.name, sent: inner.sent, calls, failWith: inner.failWith,
    send: (m) => { calls.push(m.messageId); return inner.send(m); },
  };
}

describeOrSkip('PA-08 — the notification worker drains the queue by itself — real API, real PostgreSQL, across a restart', () => {
  const clouds: RealCloud[] = [];
  afterAll(async () => { for (const c of clouds) await c.stop(); vi.useRealTimers(); });

  it('sends, backs off, dead-letters, withholds on withdrawn consent, holds on an exhausted budget — and carries on after a restart', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    travel(0);
    const tenantId = randomUUID();
    const transport = countingTransport();
    const boot = async (): Promise<RealCloud> => {
      const c = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId, owner: OWNER, packSigningKey: KEY, providers: { notificationTransport: transport, notificationWorkerIntervalMs: 50 } });
      clouds.push(c);
      return c;
    };
    let cloud = await boot();
    expect(cloud.notificationWorker).toBeDefined();
    expect(cloud.said.join('\n')).toMatch(/notifications: the sender runs every/);

    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, key?: string) =>
      cloud.request({ method, path, userId, ...(body === undefined ? {} : { body }), ...(key === undefined ? {} : { idempotencyKey: key }) });
    /** Wait until the worker has finished `n` more whole passes (so a change made before this call has been seen). */
    const passes = async (n = 2): Promise<void> => {
      const target = cloud.notificationWorker!.total() + n;
      for (let i = 0; i < 400 && cloud.notificationWorker!.total() < target; i += 1) await sleep(10);
      if (cloud.notificationWorker!.total() < target) console.log(cloud.said.filter((l) => !l.startsWith('{')).join('\n'));
      expect(cloud.notificationWorker!.total()).toBeGreaterThanOrEqual(target);
    };
    const stateOf = async (id: string): Promise<string> => {
      for (const [path, key, state] of [['/v1/notifications/queue/pending', 'pending', 'pending'], ['/v1/notifications/queue/dead-letters', 'deadLetters', 'dead_letter'], ['/v1/notifications/queue/withheld', 'withheld', 'withheld']] as const) {
        const list = (await call('GET', path, OWNER)).body as Record<string, { id: string }[]>;
        if (list[key]!.some((i) => i.id === id)) return state;
      }
      return 'not pending, dead or withheld';
    };
    const consent = (customerId: string, given: boolean, purpose = 'transactional') =>
      call('POST', `/v1/customers/${customerId}/consent`, OWNER, { purpose, channel: 'sms', given, evidence: given ? 'agreed at the desk' : 'asked us to stop' }, `c-${customerId}-${purpose}-${String(given)}-${Math.random()}`);
    const enqueue = (id: string, customerId: string, purpose = 'transactional') =>
      call('POST', `/v1/notifications/queue/${id}`, OWNER, { customerId, purpose, channel: 'sms', templateId: purpose === 'marketing' ? 'offer' : 'ready', values: { name: customerId } }, `q-${id}`);
    const budget = (capMinor: number) => call('POST', '/v1/notifications/budget', OWNER, { capMinor, costMinorByChannel: { sms: 40 } }, `b-${capMinor}-${Math.random()}`);

    // An approved template (owner drafts, the second admin approves — §28) and customers who said yes.
    expect((await call('POST', '/v1/notifications/templates/ready', OWNER, { purpose: 'transactional', channel: 'sms', body: 'Hello {name}, your order is ready to collect.' }, 't1')).status).toBe(201);
    expect((await call('POST', '/v1/notifications/templates/ready/approval', 'u-hr', { version: 1 }, 't1a')).status).toBe(200);
    expect((await call('POST', '/v1/notifications/templates/offer', OWNER, { purpose: 'marketing', channel: 'sms', body: 'Hello {name}, this week\'s offers are in store.' }, 't2')).status).toBe(201);
    expect((await call('POST', '/v1/notifications/templates/offer/approval', 'u-hr', { version: 1 }, 't2a')).status).toBe(200);
    for (const c of ['C-1', 'C-2', 'C-3', 'C-4', 'C-5']) expect((await consent(c, true)).status).toBeLessThan(300);
    expect((await consent('C-4', true, 'marketing')).status).toBeLessThan(300);

    // No budget set: off until the owner sets one — nothing is queued (fail safe, D3). Only the owner may set it.
    expect(codeOf(await enqueue('n0', 'C-1'))).toBe('no_messaging_budget');
    expect((await call('POST', '/v1/notifications/budget', 'u-hr', { capMinor: 1_000, costMinorByChannel: { sms: 40 } }, 'b-hr')).status).toBe(403);
    expect((await budget(200)).status).toBe(201);

    // 1 — SENT BY THE WORKER, nobody pressing drain. Once, costed.
    expect((await enqueue('n1', 'C-1')).status).toBe(201);
    await passes();
    expect(transport.sent.map((m) => m.messageId)).toEqual(['n1']);
    expect(transport.calls).toEqual(['n1']);
    expect(transport.sent[0]).toMatchObject({ channel: 'sms', customerId: 'C-1', text: 'Hello C-1, your order is ready to collect.' });
    expect(await stateOf('n1')).toBe('not pending, dead or withheld');
    expect((await call('GET', '/v1/notifications/budget', OWNER)).body).toMatchObject({ spentMinor: 40, remainingMinor: 160 });

    // 2 — A PROVIDER TIMEOUT: the attempt is recorded and the backoff honoured (not retried pass after pass)…
    transport.failWith({ reason: 'provider timeout' }, 1);
    expect((await enqueue('n2', 'C-2')).status).toBe(201);
    await passes();
    await passes();
    expect(transport.calls.filter((c) => c === 'n2')).toHaveLength(1);           // one attempt, then it waits
    const pending = (await call('GET', '/v1/notifications/queue/pending', OWNER)).body as { pending: { id: string; attempts: number; reason: string }[] };
    expect(pending.pending.find((i) => i.id === 'n2')).toMatchObject({ attempts: 1, reason: 'provider timeout' });

    // …and while it waits, the owner LOWERS the budget: 40 spent, 50 allowed, the next message costs 40. Two minutes on,
    // it is due — and the budget, RE-CHECKED at the moment of sending, holds it. Kept, pending, said.
    expect((await budget(50)).status).toBe(201);
    travel(2);
    await passes();
    expect(transport.calls.filter((c) => c === 'n2')).toHaveLength(1);           // never handed to the provider
    expect(await stateOf('n2')).toBe('pending');
    const held = (await call('GET', '/v1/notifications/budget', OWNER)).body as { held: { id: string; reason: string }[]; spentMinor: number };
    expect(held.spentMinor).toBe(40);
    expect(held.held).toEqual([expect.objectContaining({ id: 'n2', reason: expect.stringMatching(/^over_budget:/) as unknown as string })]);
    // The budget is checked at enqueue as well: a message that does not fit is not even queued.
    expect(codeOf(await enqueue('n-nofit', 'C-5'))).toBe('messaging_budget_exhausted');

    // 3 — RESTART the API process. The ledger is the worker's memory: n1 is not sent again, n2 is still held.
    await cloud.stop(); clouds.pop();
    cloud = await boot();
    await passes();
    expect(transport.calls.filter((c) => c === 'n1')).toHaveLength(1);
    expect(await stateOf('n2')).toBe('pending');
    expect((await call('GET', '/v1/notifications/budget', OWNER)).body).toMatchObject({ spentMinor: 40 });

    // The owner raises the budget: the new process's worker sends the held message by itself.
    expect((await budget(500)).status).toBe(201);
    await passes();
    expect(transport.sent.map((m) => m.messageId)).toEqual(['n1', 'n2']);
    expect((await call('GET', '/v1/notifications/budget', OWNER)).body).toMatchObject({ spentMinor: 80 });

    // 4 — A PERMANENT failure is dead-lettered by the worker: visible, with its reason, never dropped.
    transport.failWith({ reason: 'not a mobile number', permanent: true }, 1);
    expect((await enqueue('n3', 'C-3')).status).toBe(201);
    await passes();
    expect(await stateOf('n3')).toBe('dead_letter');
    const dead = (await call('GET', '/v1/notifications/queue/dead-letters', OWNER)).body as { deadLetters: { id: string; reason: string }[] };
    expect(dead.deadLetters).toEqual([expect.objectContaining({ id: 'n3', reason: 'not a mobile number' })]);

    // 5 — CONSENT RE-CHECKED AT SEND: a marketing message queued while C-4 agreed; C-4 withdraws before the worker
    // reaches it (the first try times out, and the withdrawal lands during the backoff). Withheld — never sent, kept.
    transport.failWith({ reason: 'provider timeout' }, 1);
    expect((await enqueue('n4', 'C-4', 'marketing')).status).toBe(201);
    await passes();
    expect(transport.calls.filter((c) => c === 'n4')).toHaveLength(1);
    expect((await consent('C-4', false, 'marketing')).status).toBeLessThan(300);
    travel(10);
    await passes();
    expect(await stateOf('n4')).toBe('withheld');
    expect(transport.sent.map((m) => m.messageId)).not.toContain('n4');
    const withheld = (await call('GET', '/v1/notifications/queue/withheld', OWNER)).body as { withheld: { id: string; reason: string }[] };
    expect(withheld.withheld[0]?.reason).toMatch(/consent no longer holds at the moment of sending/);

    // And after all of it, one more restart: the dead letter and the withheld message are still there (hard rule #6).
    await cloud.stop(); clouds.pop();
    cloud = await boot();
    expect(await stateOf('n3')).toBe('dead_letter');
    expect(await stateOf('n4')).toBe('withheld');
    await passes();
    expect(transport.calls.filter((c) => c === 'n1' || c === 'n2')).toHaveLength(3); // n1 once; n2 once timed out + once sent
  }, 60_000);
});
