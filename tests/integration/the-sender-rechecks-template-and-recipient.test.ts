import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { InMemoryEventStore, SqlEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { SqlIdempotencyStore, type IdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { recordingTransport } from '../../packages/notifications/src/index';

/**
 * **PA-08 (round 6) — at the moment of sending, the sender re-checks that the template version is STILL approved and
 * that the recipient still stands on their own (M31-FR-03/04 · M32-FR-02/04 · M21-FR-01 · P-08 · hard rule #6).**
 *
 * Round 4 re-checked consent and budget at send, but not the template or the recipient: a message queued with words a
 * manager later withdrew, or to a customer who has since been erased or merged into another record, still went out.
 * Here, on the REAL routes (API harness, in memory and on PostgreSQL):
 *   • a second person approves two templates; four messages are queued, all allowed at the time;
 *   • then — the "offer" template's approval is WITHDRAWN (with a reason); customer B's record is MERGED into D's (two
 *     people); customer C exercises the right to ERASURE (the governed flow: verify, approve, execute, tombstone);
 *   • nothing new can be queued with the withdrawn words, or to B or C;
 *   • the sender's pass WITHHOLDS the three — kept and visible on the withheld list with the reason — and sends only D's;
 *   • a second pass sends nothing again; a cashier cannot withdraw a template.
 */

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

async function theSenderRechecks(h: ApiHarness, transport: ReturnType<typeof recordingTransport>, t: string): Promise<void> {
  const req = (method: 'GET' | 'POST', path: string, u: string, body?: unknown) =>
    h.request({ method, path, userId: u, tenantId: t, ...(body === undefined ? {} : { body }), ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}) });
  await h.seedOwner(t, 'u-maker');
  await h.provisionOwner(t, 'u-checker');           // the second person — approves templates, merges and the erasure
  await h.provisionRole(t, 'u-cash', 'cashier');
  for (const [id, body] of [['offer', 'Hello {name}, 20% off this week only.'], ['notice', 'Hello {name}, your order is ready.']] as const) {
    expect((await req('POST', `/v1/notifications/templates/${id}`, 'u-maker', { purpose: 'marketing', channel: 'whatsapp', body })).status).toBe(201);
    expect((await req('POST', `/v1/notifications/templates/${id}/approval`, 'u-checker', { version: 1 })).status).toBe(200);
  }
  expect((await req('POST', '/v1/notifications/budget', 'u-maker', { capMinor: 100_000, costMinorByChannel: { whatsapp: 50 } })).status).toBe(201);
  // B and D are real customer records here (loyalty members) — a merge joins two records head office holds.
  const enrol = async (mobile: string): Promise<string> => ((await req('POST', '/v1/loyalty/members', 'u-maker', { mobile, consent: true, verifiedHow: 'seen_on_phone' })).body as { memberRef: string }).memberRef;
  const B = await enrol('98400 11111');
  const D = await enrol('98400 22222');
  for (const c of ['C-A', B, 'C-C', D]) {
    expect((await req('POST', `/v1/customers/${c}/consent`, 'u-maker', { purpose: 'marketing', channel: 'whatsapp', given: true, evidence: 'ticked the box at the desk' })).status).toBeLessThan(300);
  }
  const msg = (customerId: string, templateId: string) => ({ customerId, purpose: 'marketing', channel: 'whatsapp', templateId, values: { name: 'Meena' } });
  for (const [id, c, tpl] of [['n-a', 'C-A', 'offer'], ['n-b', B, 'notice'], ['n-c', 'C-C', 'notice'], ['n-d', D, 'notice']] as const) {
    expect((await req('POST', `/v1/notifications/queue/${id}`, 'u-maker', msg(c, tpl))).status).toBe(201);
  }

  // 1 — the offer's words are WITHDRAWN (a cashier may not; a reason is required).
  expect((await req('POST', '/v1/notifications/templates/offer/withdrawal', 'u-cash', { version: 1, reason: 'wrong price' })).status).toBe(403);
  expect(codeOf(await req('POST', '/v1/notifications/templates/offer/withdrawal', 'u-checker', { version: 1 }))).toBe('withdrawal_needs_a_version_and_reason');
  const w = await req('POST', '/v1/notifications/templates/offer/withdrawal', 'u-checker', { version: 1, reason: 'the 20% offer was printed wrong — it is 10%' });
  expect(w.status).toBe(200);
  expect((w.body as { template: { state: string; withdrawnBy: string } }).template).toMatchObject({ state: 'withdrawn', withdrawnBy: 'u-checker' });
  expect(codeOf(await req('POST', '/v1/notifications/queue/n-a2', 'u-maker', msg('C-A', 'offer')))).toBe('template_not_approved');

  // 2 — B's record is MERGED into D's (proposed by one person, approved by another).
  expect((await req('POST', `/v1/customers/${D}/merges/m-1`, 'u-maker', { mergedRef: B, reason: 'same person, changed number' })).status).toBe(201);
  expect((await req('POST', '/v1/customers/merges/m-1/approve', 'u-checker', {})).status).toBe(200);

  // 3 — C exercises the right to ERASURE, through the governed flow.
  expect((await req('POST', '/v1/privacy/data-requests/dsr-c', 'u-maker', { customerRef: 'C-C', kind: 'erasure' })).status).toBeLessThan(300);
  expect((await req('POST', '/v1/privacy/data-requests/dsr-c/verification', 'u-maker', { verifiedBy: 'otp' })).status).toBeLessThan(300);
  expect((await req('POST', '/v1/privacy/pii/C-C/marketing_profile', 'u-maker', { recordCount: 1 })).status).toBeLessThan(300);
  expect((await req('POST', '/v1/privacy/data-requests/dsr-c/erasure-approval', 'u-checker')).status).toBe(200);
  expect((await req('POST', '/v1/privacy/data-requests/dsr-c/erasure-execution', 'u-maker', {})).status).toBe(200);

  // Nothing new can be queued to B (merged away) or C (erased).
  expect(codeOf(await req('POST', '/v1/notifications/queue/n-b2', 'u-maker', msg(B, 'notice')))).toBe('recipient_not_allowed');
  expect(codeOf(await req('POST', '/v1/notifications/queue/n-c2', 'u-maker', msg('C-C', 'notice')))).toBe('recipient_not_allowed');

  // 4 — THE SEND: three withheld with their reasons, only D's message goes.
  const pass = await req('POST', '/v1/notifications/queue/drain', 'u-maker', {});
  expect(pass.status).toBe(200);
  const outcome = Object.fromEntries((pass.body as { outcome: { id: string; result: string }[] }).outcome.map((o) => [o.id, o.result]));
  expect(outcome).toEqual({ 'n-a': 'withheld', 'n-b': 'withheld', 'n-c': 'withheld', 'n-d': 'delivered' });
  expect(transport.sent.map((m) => m.messageId)).toEqual(['n-d']);
  const withheld = (await req('GET', '/v1/notifications/queue/withheld', 'u-maker')).body as { withheld: { id: string; reason: string }[]; count: number };
  const why = Object.fromEntries(withheld.withheld.map((i) => [i.id, i.reason]));
  expect(withheld.count).toBe(3);
  expect(why['n-a']).toMatch(/^template_no_longer_approved: template offer version 1 was withdrawn by u-checker at .*: the 20% offer was printed wrong/);
  expect(why['n-b']).toBe(`recipient_not_allowed: ${B} was merged into ${D} (m-1) — the record no longer stands on its own`);
  expect(why['n-c']).toMatch(/^recipient_not_allowed: C-C exercised their right to erasure/);

  // 5 — a second pass sends nothing again; the withheld stay withheld and visible.
  await req('POST', '/v1/notifications/queue/drain', 'u-maker', {});
  expect(transport.sent.map((m) => m.messageId)).toEqual(['n-d']);
  expect(((await req('GET', '/v1/notifications/queue/withheld', 'u-maker')).body as { count: number }).count).toBe(3);
}

describe('PA-08 r6 — the sender re-checks the template and the recipient at send (in memory)', () => {
  it('a withdrawn template, a merged-away and an erased recipient are withheld with the reason; only the allowed message goes', async () => {
    const transport = recordingTransport();
    const store: EventStore = new InMemoryEventStore();
    await theSenderRechecks(apiHarness({ store, notificationTransport: transport }), transport, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0808');
  });
});

const DATABASE_URL = process.env['DATABASE_URL'];
describe.skipIf(!DATABASE_URL)('PA-08 r6 — the same on real PostgreSQL', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4, options: '-c app.tenant_id=*' });
    const dir = 'db/migrations';
    await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
  });
  afterAll(async () => { await pool.end(); });

  it('withheld for the template and the recipient, kept and visible; sent once', async () => {
    const transport = recordingTransport();
    const sql = pgPoolClient(pool);
    const idempotency: IdempotencyStore = new SqlIdempotencyStore(sql);
    await theSenderRechecks(apiHarness({ store: new SqlEventStore(sql), idempotency, notificationTransport: transport }), transport, randomUUID());
  });
});
