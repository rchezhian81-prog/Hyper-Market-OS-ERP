import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { outsidePartyLoginAdapter } from '../../services/api/src/adapters';
import { recordingTransport } from '../../packages/notifications/src/transport';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';

/**
 * **M10-FR-04 "identify affected customers (notify per consent)"; "affected customer contact respects consent (M16)";
 * owner decision OB-297 (D8): "Call list now, SMS later" (Lane 2 · P1) — through the real API, in memory and on real
 * PostgreSQL, with cold restarts.**
 *
 * THE CALL LIST for one recall: who bought the batch — on a bill that recorded it, and on a bill for a bun the kitchen
 * made from it — and of those, who said yes to service messages about what they bought, as their own privacy centre shows
 * it. Each entry: the customer's name (where the shop holds one), ONLY the last four digits of their phone, and the lot
 * and date they bought. A "no", or nothing on record, is not a yes: those customers are named by reference only as not to
 * be contacted, never dropped. Walk-ins are counted. Consent is read at the moment the list is asked for.
 *
 * THE SMS NOTICE PORT is switched OFF: with no provider connected it refuses; with a stand-in provider it still refuses
 * until the OWNER switches recall messages on, in writing; then it messages only customers whose SMS consent stands at
 * that moment, each once. No live provider is ever called. Every read, switch and send is sealed on the audit trail.
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
const backings: { name: string; harness: () => ApiHarness; restart: (h: ApiHarness, extra?: Opts) => ApiHarness }[] = [
  { name: 'the in-memory event store', harness: () => apiHarness(), restart: (h, extra) => apiHarness({ ...extra, store: h.store }) },
];
if (DATABASE_URL !== undefined) {
  const pg = (extra?: Opts): ApiHarness => { const sql = pgPoolClient(pool!); return apiHarness({ ...extra, store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); };
  backings.push({ name: 'real PostgreSQL', harness: () => pg(), restart: (_h, extra) => pg(extra) });
}

type Res = { status: number; body: unknown };
interface NoticeList {
  batchId: string; recall: { status: string };
  decision: string; consentPurpose: string;
  callList: { customerRef: string; name: string | null; phoneLast4: string | null; consentedOn: string[]; bought: { lot: string; date: string; saleId: string; madeFromLot?: string }[] }[];
  notContactable: { customerRef: string; why: string; purchases: number }[];
  anonymousSales: number; smsConsented: number;
  messages: { channel: string; switchedOn: boolean; providerConnected: boolean; detail: string };
  detail: string;
}
interface Sent { sent: string[]; failed: unknown[]; alreadyTold: string[]; notOnSms: string[]; notContactable: string[]; transport: string }

const sale = (saleId: string, productId: string, batchId: string, customerRef?: string) => ({
  saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', locationId: 'S1', cashierId: 'u-owner', tradingDay: '2030-06-10', committedAt: '2030-06-10T10:00:00Z',
  totalMinor: 9_000, currency: 'INR', packVersion: 1, ...(customerRef === undefined ? {} : { customerRef }),
  lines: [{ productId, quantityMinor: 1, uom: 'ea', unitPriceMinor: 9_000, lineTotalMinor: 9_000, batchId }],
  tenders: [{ kind: 'cash', amountMinor: 9_000 }],
});

describe.each(backings)('M10-FR-04 · OB-297: a recall reaches only the customers who consented — on $name', ({ harness, restart }) => {
  it('the call list: name, last four digits, lot and date, for consented customers only; the SMS port off until a provider and the owner\'s switch; every step sealed', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-baker', 'store_manager');
    await h.provisionRole(T, 'u-cash', 'cashier');
    await h.enableFeature(T, 'dept.bakery');
    const req = (method: 'GET' | 'POST', path: string, body?: unknown, userId = 'u-owner'): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    const consent = (customerRef: string, channel: string, given: boolean, purpose = 'transactional') =>
      ok(req('POST', `/v1/customers/${customerRef}/consent`, { purpose, channel, given, evidence: given ? 'said yes at the service desk' : 'asked to stop at the service desk' }), `consent ${customerRef} ${channel} ${given}`);

    // Batch M-9 of milk powder, received; a bun batch the kitchen made from it.
    await ok(req('POST', '/v1/org/nodes/C1', { kind: 'company', name: 'SRE Retail' }), 'company');
    await ok(req('POST', '/v1/org/nodes/S1', { kind: 'branch', name: 'Store 1', parentId: 'C1', companyId: 'C1' }), 'store');
    await ok(req('POST', '/v1/production/departments/bakery', {}), 'bakery on');
    await ok(req('POST', '/v1/inventory/movements', { movementId: 'rx-M-9', productId: 'MILKPOWDER', locationId: 'S1', kind: 'received', quantityMinor: 1_000, uom: 'kg', occurredAt: '2030-04-01T01:00:00.000Z', enteredBy: 'u-owner', unitCostMinor: 4_000, batchId: 'M-9', expiry: '2030-12-01' }), 'receive M-9');
    await ok(req('POST', '/v1/production/recipes/bun', { departmentId: 'bakery', outputProductId: 'BUN', outputQuantityMinor: 10, outputUom: 'ea', shelfLifeHours: 48, expectedYieldBp: 9_000, yieldToleranceBp: 2_000, inputs: [{ productId: 'MILKPOWDER', quantityMinor: 100, uom: 'kg' }] }), 'recipe');
    await ok(req('POST', '/v1/production/runs/run-1', { recipeId: 'bun', batches: 1, actualOutputMinor: 9, outputBatchId: 'BUN-M', locationId: 'S1' }, 'u-baker'), 'run');
    await ok(req('POST', '/v1/production/runs/run-1/release', { qcPassed: true }, 'u-mgr'), 'release');

    // A is a loyalty member enrolled at the desk (the shop keeps only the last four digits of her number), who also has an
    // app login in her name — the only place the shop holds a customer's name.
    const enrolled = (await ok(req('POST', '/v1/loyalty/members', { mobile: '9876543210', consent: true, verifiedHow: 'seen_on_phone' }, 'u-mgr'), 'enrol')).body as { memberRef: string };
    const member = enrolled.memberRef;
    await outsidePartyLoginAdapter({ store: h.store, now: () => '2030-06-01T00:00:00.000Z' }).recordInvite(T, {
      inviteId: 'inv-A', role: 'customer', partyId: member, userId: member, displayName: 'Anitha Raman', invitedBy: 'u-owner', invitedAt: '2030-06-01T00:00:00.000Z', reason: null,
    });
    // Who bought: A twice, B, C, a walk-in — and D bought a bun made from the batch.
    await ok(req('POST', '/v1/sales', sale('S-A1', 'MILKPOWDER', 'M-9', member)), 'S-A1');
    await ok(req('POST', '/v1/sales', sale('S-A2', 'MILKPOWDER', 'M-9', member)), 'S-A2');
    await ok(req('POST', '/v1/sales', sale('S-B', 'MILKPOWDER', 'M-9', 'cust-B')), 'S-B');
    await ok(req('POST', '/v1/sales', sale('S-C', 'MILKPOWDER', 'M-9', 'cust-C')), 'S-C');
    await ok(req('POST', '/v1/sales', sale('S-W', 'MILKPOWDER', 'M-9')), 'S-W');
    await ok(req('POST', '/v1/sales', sale('S-D', 'BUN', 'BUN-M', 'cust-D')), 'S-D');
    // Their own answers: A yes on SMS and WhatsApp; B yes then no (withdrawn); C only agreed to marketing; D yes by email.
    await consent(member, 'sms', true);
    await consent(member, 'whatsapp', true);
    await consent('cust-B', 'sms', true);
    await consent('cust-B', 'sms', false);
    await consent('cust-C', 'sms', true, 'marketing');
    await consent('cust-D', 'email', true);

    // No recall, no list: this is not a way to find out who bought what (purpose limitation).
    expect((await req('GET', '/v1/quality/recalls/M-9/notice-list')).status).toBe(404);
    await ok(req('POST', '/v1/quality/recalls/M-9', { reason: 'supplier notice: milk powder contamination' }, 'u-mgr'), 'recall');
    expect((await req('GET', '/v1/quality/recalls/M-9/notice-list', undefined, 'u-cash')).status).toBe(403);
    expect((await req('GET', '/v1/quality/recalls/bad%20batch/notice-list')).status).toBe(400);

    h = restart(h); // ── COLD RESTART ──
    const list = (await ok(req('GET', '/v1/quality/recalls/M-9/notice-list', undefined, 'u-mgr'), 'list')).body as NoticeList;
    expect(list).toMatchObject({ batchId: 'M-9', recall: { status: 'open' }, decision: 'OB-297', consentPurpose: 'transactional', anonymousSales: 1 });
    expect(list.callList.map((c) => [c.customerRef, c.name, c.phoneLast4, c.consentedOn])).toEqual([
      ['cust-D', null, null, ['email']], // no name or number on record: said, never invented
      [member, 'Anitha Raman', '3210', ['sms', 'whatsapp']], // the member: her app name, the last four digits only
    ].sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1)));
    const anitha = list.callList.find((c) => c.customerRef === member)!;
    const dee = list.callList.find((c) => c.customerRef === 'cust-D')!;
    // What they bought: the lot and the date. D's lot is the bun batch made from the recalled batch.
    expect(anitha.bought.map((b) => [b.lot, b.date, b.saleId])).toEqual([['M-9', '2030-06-10', 'S-A1'], ['M-9', '2030-06-10', 'S-A2']]);
    expect(dee.bought).toEqual([expect.objectContaining({ lot: 'BUN-M', madeFromLot: 'M-9', saleId: 'S-D' })]);
    expect(JSON.stringify(list)).not.toMatch(/9876543210|98765/); // never the whole number
    expect(list.notContactable).toEqual([
      { customerRef: 'cust-B', why: 'withdrawn', purchases: 1 },
      { customerRef: 'cust-C', why: 'no_consent_on_record', purchases: 1 },
    ]);
    expect(list.smsConsented).toBe(1);
    expect(list.messages).toMatchObject({ channel: 'sms', switchedOn: false, providerConnected: false });
    expect(list.detail).toMatch(/2 customer\(s\) to call/);

    // Consent is read now, not when the recall started: the member withdraws WhatsApp a minute later; the list follows.
    await consent(member, 'whatsapp', false);
    const after = (await ok(req('GET', '/v1/quality/recalls/M-9/notice-list'), 'list again')).body as NoticeList;
    expect(after.callList.find((c) => c.customerRef === member)!.consentedOn).toEqual(['sms']);

    // ── THE SMS PORT, switched OFF ─────────────────────────────────────────────────────────────────────────────────────
    const text = 'SRE Hyper Market: the milk powder you bought (lot M-9) is recalled. Please do not use it; bring it back to the store.';
    // No provider connected (production): refused, nothing sent.
    const noProvider = await req('POST', '/v1/quality/recalls/M-9/notices', { text }, 'u-mgr');
    expect(noProvider.status).toBe(503);
    expect((noProvider.body as { error: { code: string } }).error.code).toBe('recall_messages_have_no_provider');
    // A stand-in provider (the recording test adapter — it sends nothing anywhere). Still OFF until the owner says so.
    const provider = recordingTransport();
    h = restart(h, { notificationTransport: provider });
    const off = await req('POST', '/v1/quality/recalls/M-9/notices', { text }, 'u-mgr');
    expect(off.status).toBe(409);
    expect((off.body as { error: { code: string } }).error.code).toBe('recall_messages_switched_off');
    expect((await req('POST', '/v1/quality/recall-notices/switch', { on: true, reason: 'SMS provider connected' }, 'u-mgr')).status).toBe(403); // the owner's alone
    expect((await req('POST', '/v1/quality/recalls/M-9/notices', { text }, 'u-cash')).status).toBe(403);
    await ok(req('POST', '/v1/quality/recall-notices/switch', { on: true, reason: 'test provider connected for the drill' }), 'switch on');
    expect((await req('POST', '/v1/quality/recalls/M-9/notices', { text: 'short' }, 'u-mgr')).status).toBe(400);
    const first = (await ok(req('POST', '/v1/quality/recalls/M-9/notices', { text }, 'u-mgr'), 'send')).body as Sent;
    // Only the SMS-consented customer is messaged; D said yes by email only (call her); B and C are never contacted.
    expect(first).toMatchObject({ sent: [member], failed: [], alreadyTold: [], notOnSms: ['cust-D'], notContactable: ['cust-B', 'cust-C'], transport: 'recording-test-adapter' });
    expect(provider.sent.map((m) => [m.customerId, m.channel, m.text])).toEqual([[member, 'sms', text]]);
    // Sent again: whoever was told is not told twice.
    h = restart(h, { notificationTransport: provider });
    const again = (await ok(req('POST', '/v1/quality/recalls/M-9/notices', { text }, 'u-mgr'), 'resend')).body as Sent;
    expect(again).toMatchObject({ sent: [], alreadyTold: [member] });
    expect(provider.sent).toHaveLength(1);

    // Closed with evidence: the list is still there (part of the recall's record); no new message is sent for it.
    await ok(req('POST', '/v1/quality/recalls/M-9/closure', { evidenceRef: 'DOC-contact-log-M-9' }, 'u-mgr'), 'close');
    h = restart(h, { notificationTransport: provider });
    expect(((await ok(req('GET', '/v1/quality/recalls/M-9/notice-list'), 'closed list')).body as NoticeList).recall.status).toBe('closed');
    expect((await req('POST', '/v1/quality/recalls/M-9/notices', { text }, 'u-mgr')).status).toBe(409);

    // Every read of the list, the switch and each send are on the audit trail.
    const trail = async (q: Record<string, string>) => ((await ok(h.request({ method: 'GET', path: '/v1/audit/trail', userId: 'u-owner', tenantId: T, query: q }), 'trail')).body as { matches: { actorId: string; action: string; after: Record<string, string> | null }[] }).matches;
    expect((await trail({ objectId: 'recall-notice:M-9', action: 'quality.lottrace.read' })).map((m) => [m.actorId, m.after?.['customersNamed']])).toEqual([['u-mgr', '4'], ['u-owner', '4'], ['u-owner', '4']]);
    expect((await trail({ action: 'quality.recall.notice.switch' })).map((m) => [m.actorId, m.after?.['on']])).toEqual([['u-owner', 'true']]);
    expect((await trail({ action: 'quality.recall.notice.send' })).map((m) => [m.actorId, m.after?.['sent']])).toEqual([['u-mgr', '1'], ['u-mgr', '0']]);
  }, 120_000);
});
