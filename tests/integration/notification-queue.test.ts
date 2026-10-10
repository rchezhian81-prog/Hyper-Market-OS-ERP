import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';
import { recordingTransport } from '../../packages/notifications/src/index';

// Notification delivery queue, end to end (M31-FR-03/04 · M21-FR-01 · audit PA-08 / PF-10, API-06). The audit queued a
// WhatsApp message with nothing but `{ channel: 'whatsapp' }` and got 201. Now a notification is a full intent that head
// office decides: an APPROVED template (drafted by one person, approved by another), a recipient whose OWN consent
// ledger allows that purpose on that channel, and every placeholder filled. The sender re-checks consent IMMEDIATELY
// before each send — a withdrawal after queuing WITHHOLDS the message (kept, never sent). Failures retry with backoff
// and dead-letter, visible and never dropped (hard rule #6). The transport here is the RECORDING test adapter: no real
// provider is configured (the SMS provider is release R4, OB-29), and production's drain says so.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const req = (h: ApiHarness, method: 'GET' | 'POST', path: string, u: string, body?: unknown, key?: string) =>
  h.request({ method, path, userId: u, tenantId: A, ...(body === undefined ? {} : { body }), ...(key === undefined ? {} : { idempotencyKey: key }) });
const consent = (h: ApiHarness, customerId: string, given: boolean, key: string) =>
  req(h, 'POST', `/v1/customers/${customerId}/consent`, 'u-owner', { purpose: 'marketing', channel: 'whatsapp', given, evidence: given ? 'ticked the box at the desk' : 'asked us to stop on the phone' }, key);
const enqueue = (h: ApiHarness, id: string, body: Record<string, unknown>, u = 'u-owner', key = `e-${id}`) =>
  req(h, 'POST', `/v1/notifications/queue/${id}`, u, body, key);
const drain = (h: ApiHarness, key: string, body: Record<string, unknown> = {}) => req(h, 'POST', '/v1/notifications/queue/drain', 'u-owner', body, key);
const offer = (customerId: string, extra: Record<string, unknown> = {}) =>
  ({ customerId, purpose: 'marketing', channel: 'whatsapp', templateId: 'diwali', values: { name: 'Meena' }, ...extra });

/** A shop with an APPROVED marketing WhatsApp template: drafted by the owner, approved by the store manager. */
async function shop(transport = recordingTransport(), store = new InMemoryEventStore()): Promise<{ h: ApiHarness; transport: ReturnType<typeof recordingTransport> }> {
  const h = apiHarness({ store, notificationTransport: transport });
  await h.seedOwner(A, 'u-owner');                // notification.send.check, document.template.manage, customer.consent.write
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // document.template.manage
  await h.provisionRole(A, 'u-cash', 'cashier');  // none
  expect((await req(h, 'POST', '/v1/notifications/templates/diwali', 'u-owner', { purpose: 'marketing', channel: 'whatsapp', body: 'Hello {name}, Diwali offers are in store this week.' }, 't1')).status).toBe(201);
  expect((await req(h, 'POST', '/v1/notifications/templates/diwali/approval', 'u-mgr', { version: 1 }, 't1a')).status).toBe(200);
  // PA-08 round 4: the owner's messaging budget — off until set; room for plenty here.
  expect((await req(h, 'POST', '/v1/notifications/budget', 'u-owner', { capMinor: 100_000, costMinorByChannel: { whatsapp: 50, sms: 25 } }, 'b1')).status).toBe(201);
  return { h, transport };
}

describe('a notification is a full, consent-checked intent — and the send re-checks consent (PA-08)', () => {
  it('the audit\'s channel-only enqueue is refused; a template nobody approved is refused; the maker cannot approve their own', async () => {
    const { h } = await shop();
    expect(codeOf(await enqueue(h, 'n0', { channel: 'whatsapp' }))).toBe('enqueue_needs_a_full_intent');
    expect((await req(h, 'POST', '/v1/notifications/templates/promo', 'u-owner', { purpose: 'marketing', channel: 'whatsapp', body: 'Sale!' }, 't2')).status).toBe(201);
    expect(codeOf(await req(h, 'POST', '/v1/notifications/templates/promo/approval', 'u-owner', { version: 1 }, 't2a'))).toBe('maker_cannot_approve');
    await consent(h, 'C-1', true, 'c1');
    expect(codeOf(await enqueue(h, 'n1', offer('C-1', { templateId: 'promo' })))).toBe('template_not_approved');
    // An approved template used for a purpose or channel it was not approved for is refused too.
    expect(codeOf(await enqueue(h, 'n2', offer('C-1', { channel: 'sms' })))).toBe('template_not_approved');
    expect(codeOf(await enqueue(h, 'n3', offer('C-1', { values: {} })))).toBe('template_value_missing');
  });

  it('a customer with no consent on record, or who withdrew, is never queued — silence is not agreement', async () => {
    const { h } = await shop();
    expect(codeOf(await enqueue(h, 'n1', offer('C-SILENT')))).toBe('no_consent_on_record');
    await consent(h, 'C-2', true, 'c2');
    await consent(h, 'C-2', false, 'c2w');
    expect(codeOf(await enqueue(h, 'n2', offer('C-2')))).toBe('consent_withdrawn');
    expect((await req(h, 'GET', '/v1/notifications/queue/pending', 'u-owner')).body).toMatchObject({ count: 0 });
  });

  it('queues the rendered message, sends it once through the transport, and keeps the receipt — durable across a restart', async () => {
    const { h, transport } = await shop();
    await consent(h, 'C-1', true, 'c1');
    const q = await enqueue(h, 'n1', offer('C-1'));
    expect(q.status).toBe(201);
    expect(q.body).toMatchObject({ intent: { customerId: 'C-1', templateId: 'diwali', templateVersion: 1, text: 'Hello Meena, Diwali offers are in store this week.' } });
    expect((await enqueue(h, 'n1', offer('C-1'), 'u-owner', 'e-n1-again')).body).toMatchObject({ alreadyQueued: true });

    const pass = (await drain(h, 'dr1')).body as { transport: string; outcome: { id: string; result: string }[] };
    expect(pass.transport).toBe('recording-test-adapter');
    expect(pass.outcome).toEqual([expect.objectContaining({ id: 'n1', result: 'delivered' })]);
    expect(transport.sent).toEqual([{ messageId: 'n1', channel: 'whatsapp', customerId: 'C-1', text: 'Hello Meena, Diwali offers are in store this week.' }]);
    // A second pass sends nothing more; a restart finds it delivered.
    expect(((await drain(h, 'dr2')).body as { outcome: unknown[] }).outcome).toEqual([]);
    const h2 = apiHarness({ store: h.store, notificationTransport: transport });
    expect((await req(h2, 'GET', '/v1/notifications/queue/pending', 'u-owner')).body).toMatchObject({ count: 0 });
    expect(transport.sent).toHaveLength(1);
  });

  it('a customer who withdraws AFTER the message was queued is WITHHELD at the send — kept, visible, never sent', async () => {
    const { h, transport } = await shop();
    await consent(h, 'C-3', true, 'c3');
    expect((await enqueue(h, 'n3', offer('C-3'))).status).toBe(201);
    await consent(h, 'C-3', false, 'c3w');
    const pass = (await drain(h, 'dr3')).body as { outcome: { id: string; result: string }[] };
    expect(pass.outcome).toEqual([expect.objectContaining({ id: 'n3', result: 'withheld' })]);
    expect(transport.sent).toEqual([]);
    const withheld = (await req(h, 'GET', '/v1/notifications/queue/withheld', 'u-owner')).body as { withheld: { id: string; reason: string }[]; count: number };
    expect(withheld.count).toBe(1);
    expect(withheld.withheld[0]?.reason).toMatch(/consent no longer holds at the moment of sending/);
  });

  it('a failing send retries with backoff, a permanent failure dead-letters — never dropped', async () => {
    const transport = recordingTransport();
    const { h } = await shop(transport);
    await consent(h, 'C-4', true, 'c4');
    await consent(h, 'C-5', true, 'c5');
    await enqueue(h, 'n4', offer('C-4'));
    transport.failWith({ reason: 'provider timeout' }, 1);
    expect(((await drain(h, 'dr4')).body as { outcome: { id: string; result: string }[] }).outcome).toEqual([expect.objectContaining({ id: 'n4', result: 'retry_later' })]);
    // Straight away it is not due yet — the backoff is honoured, not hammered.
    expect(((await drain(h, 'dr5')).body as { outcome: { id: string; result: string }[] }).outcome).toEqual([expect.objectContaining({ id: 'n4', result: 'not_yet_due' })]);
    // A permanent failure (number not on the channel) goes straight to the visible dead-letter queue.
    await enqueue(h, 'n5', offer('C-5'));
    transport.failWith({ reason: 'not a WhatsApp number', permanent: true }, 1);
    const pass = (await drain(h, 'dr6')).body as { outcome: { id: string; result: string }[] };
    expect(pass.outcome).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'n5', result: 'dead_lettered' })]));
    const dead = (await req(h, 'GET', '/v1/notifications/queue/dead-letters', 'u-owner')).body as { deadLetters: { id: string; reason: string }[] };
    expect(dead.deadLetters).toEqual([expect.objectContaining({ id: 'n5', reason: 'not a WhatsApp number' })]);
  });

  it('PA-08 round 4: the messaging budget is checked when queued AND when sent — a month that filled up holds the message, kept and visible', async () => {
    const { h, transport } = await shop();
    await consent(h, 'C-6', true, 'c6');
    await consent(h, 'C-7', true, 'c7');
    // Room for exactly two WhatsApp messages (cost 50 each).
    expect((await req(h, 'POST', '/v1/notifications/budget', 'u-owner', { capMinor: 100, costMinorByChannel: { whatsapp: 50 } }, 'b-small')).body).toMatchObject({ budget: { version: 2 } });
    expect((await enqueue(h, 'n6', offer('C-6'))).status).toBe(201);
    expect((await enqueue(h, 'n7', offer('C-7'))).status).toBe(201);
    // Before either is sent, the owner cuts the budget to one message: the send re-checks it.
    expect((await req(h, 'POST', '/v1/notifications/budget', 'u-owner', { capMinor: 50, costMinorByChannel: { whatsapp: 50 } }, 'b-cut')).status).toBe(201);
    const pass = (await drain(h, 'dr-b1')).body as { outcome: { id: string; result: string; detail: string }[] };
    expect(pass.outcome.map((o) => [o.id, o.result])).toEqual([['n6', 'delivered'], ['n7', 'held']]);
    expect(transport.sent.map((m) => m.messageId)).toEqual(['n6']);
    const status = (await req(h, 'GET', '/v1/notifications/budget', 'u-owner')).body as { spentMinor: number; remainingMinor: number; held: { id: string }[] };
    expect(status).toMatchObject({ spentMinor: 50, remainingMinor: 0, held: [expect.objectContaining({ id: 'n7' })] });
    // Held is pending, not lost; and a new message that does not fit is not even queued.
    expect(((await req(h, 'GET', '/v1/notifications/queue/pending', 'u-owner')).body as { pending: { id: string }[] }).pending.map((i) => i.id)).toEqual(['n7']);
    expect(codeOf(await enqueue(h, 'n8', offer('C-6')))).toBe('messaging_budget_exhausted');
    // A manager may not set the budget (it is the owner's, §28); a malformed one is refused by name.
    expect((await req(h, 'POST', '/v1/notifications/budget', 'u-mgr', { capMinor: 1_000_000, costMinorByChannel: { whatsapp: 1 } }, 'b-mgr')).status).toBe(403);
    expect(codeOf(await req(h, 'POST', '/v1/notifications/budget', 'u-owner', { capMinor: -1, costMinorByChannel: {} }, 'b-bad'))).toBe('not_readable_as_a_messaging_budget');
    // The owner raises it: the held message goes on the next pass.
    await req(h, 'POST', '/v1/notifications/budget', 'u-owner', { capMinor: 500, costMinorByChannel: { whatsapp: 50 } }, 'b-up');
    expect(((await drain(h, 'dr-b2')).body as { outcome: { id: string; result: string }[] }).outcome).toEqual([expect.objectContaining({ id: 'n7', result: 'delivered' })]);
  });

  it('with no transport configured (production today), the drain sends nothing and says why; and the queue is gated', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');
    expect(codeOf(await drain(h, 'dr-none'))).toBe('no_transport_configured');
    expect((await enqueue(h, 'n9', offer('C-1'), 'u-cash', 'e-cash')).status).toBe(403);
    expect((await req(h, 'GET', '/v1/notifications/queue/pending', 'u-cash')).status).toBe(403);
  });
});
