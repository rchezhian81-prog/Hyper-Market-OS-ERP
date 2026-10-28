import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { outsidePartyLoginAdapter } from '../../services/api/src/adapters';
import { recordingTransport } from '../../packages/notifications/src/transport';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';
import { InMemorySubjectKeyStore, isSealed } from '../../packages/persistence/src/personal-data';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { certifyFoodHandler } from '../support/food-handler';

/**
 * **M10-FR-04 "identify affected customers (notify per consent)"; "affected customer contact respects consent (M16)";
 * owner decision OB-297 (D8): "Call list now, SMS later" (Lane 2 · P1) — through the real API, in memory and on real
 * PostgreSQL, with cold restarts.**
 *
 * THE CALL LIST for one recall (OB-328 "Everyone known — safety first"): EVERY identified customer who bought the batch —
 * on a bill that recorded it, and on a bill for a bun the kitchen made from it — whatever their marketing consent, each
 * with the name they gave at enrolment (OB-329) or "not on record", ONLY the last four digits of their phone, the lot and
 * date they bought, and a note on what they said no to ("said no to promotions — safety call only"). The list carries
 * "Data-law basis to be confirmed by your CA or lawyer." Walk-ins are counted. Consent is read when the list is asked for.
 *
 * THE SMS NOTICE PORT keeps its rule and is switched OFF: with no provider connected it refuses; with a stand-in provider
 * it still refuses until the OWNER switches recall messages on, in writing; then it messages only customers whose consent
 * to SERVICE messages by SMS stands at that moment, each once. No live provider is ever called. Every read, switch and
 * send is sealed on the audit trail.
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
  decisions: string[]; smsConsentPurpose: string; dataLawBasis: { en: string; ta: string };
  callList: { customerRef: string; name: string | null; phoneLast4: string | null; serviceMessagesOn: string[]; smsAllowed: boolean; notes: string[]; noteSay: string[]; bought: { lot: string; date: string; saleId: string; madeFromLot?: string }[] }[];
  anonymousSales: number; smsConsented: number;
  messages: { channel: string; switchedOn: boolean; providerConnected: boolean; detail: string };
  detail: string;
}
interface Sent { sent: string[]; failed: unknown[]; alreadyTold: string[]; notOnSms: string[]; transport: string }

const sale = (saleId: string, productId: string, batchId: string, customerRef?: string) => ({
  saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', locationId: 'S1', cashierId: 'u-owner', tradingDay: '2030-06-10', committedAt: '2030-06-10T10:00:00Z',
  totalMinor: 9_000, currency: 'INR', packVersion: 1, ...(customerRef === undefined ? {} : { customerRef }),
  lines: [{ productId, quantityMinor: 1, uom: 'ea', unitPriceMinor: 9_000, lineTotalMinor: 9_000, batchId }],
  tenders: [{ kind: 'cash', amountMinor: 9_000 }],
});

describe.each(backings)('M10-FR-04 · OB-297 · OB-328 · OB-329: a recall reaches every customer the shop knows; SMS only on consent — on $name', ({ harness, restart }) => {
  it('the call list: everyone known, name or "not on record", last four digits, lot and date, notes; the SMS port off until a provider and the owner\'s switch; every step sealed', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await certifyFoodHandler(h.store, T, 'u-owner'); // OB-502: food-handling work needs a valid certificate
    await certifyFoodHandler(h.store, T, 'u-baker'); // OB-502: food-handling work needs a valid certificate
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

    // OB-329: the desk reads the enrolment notice (it says the name is kept), then enrols A WITH her name and E without
    // one (she skipped it). A name that is not a name is refused, never kept. The shop keeps only the last four digits.
    const notice = (await ok(req('GET', '/v1/loyalty/enrolment-notice', undefined, 'u-mgr'), 'notice')).body as { en: string; ta: string; version: string };
    expect(notice.en).toMatch(/your name only if you choose to give it/);
    expect(notice.ta).toMatch(/பெயர்/);
    expect((await req('POST', '/v1/loyalty/members', { mobile: '9876543210', consent: true, verifiedHow: 'seen_on_phone', name: '98765' }, 'u-mgr')).status).toBe(400);
    const enrolled = (await ok(req('POST', '/v1/loyalty/members', { mobile: '9876543210', consent: true, verifiedHow: 'seen_on_phone', name: ' Anitha  Raman ' }, 'u-mgr'), 'enrol')).body as { memberRef: string; name: string | null; noticeVersion: string };
    expect(enrolled).toMatchObject({ name: 'Anitha Raman', noticeVersion: notice.version });
    const member = enrolled.memberRef;
    const skipped = (await ok(req('POST', '/v1/loyalty/members', { mobile: '9123456780', consent: true, verifiedHow: 'seen_on_phone', name: '' }, 'u-mgr'), 'enrol E')).body as { memberRef: string; name: string | null };
    expect(skipped.name).toBeNull();
    const memberE = skipped.memberRef;
    // D is an app customer: the only name the shop holds for D is the app login's.
    await outsidePartyLoginAdapter({ store: h.store, now: () => '2030-06-01T00:00:00.000Z' }).recordInvite(T, {
      inviteId: 'inv-D', role: 'customer', partyId: 'cust-D', userId: 'cust-D', displayName: 'Dev Kumar', invitedBy: 'u-owner', invitedAt: '2030-06-01T00:00:00.000Z', reason: null,
    });
    // Who bought: A twice, B, C, a walk-in — and D bought a bun made from the batch.
    await ok(req('POST', '/v1/sales', sale('S-A1', 'MILKPOWDER', 'M-9', member)), 'S-A1');
    await ok(req('POST', '/v1/sales', sale('S-A2', 'MILKPOWDER', 'M-9', member)), 'S-A2');
    await ok(req('POST', '/v1/sales', sale('S-B', 'MILKPOWDER', 'M-9', 'cust-B')), 'S-B');
    await ok(req('POST', '/v1/sales', sale('S-C', 'MILKPOWDER', 'M-9', 'cust-C')), 'S-C');
    await ok(req('POST', '/v1/sales', sale('S-W', 'MILKPOWDER', 'M-9')), 'S-W');
    await ok(req('POST', '/v1/sales', sale('S-D', 'BUN', 'BUN-M', 'cust-D')), 'S-D');
    await ok(req('POST', '/v1/sales', sale('S-E', 'MILKPOWDER', 'M-9', memberE)), 'S-E');
    // Their own answers: A yes on SMS and WhatsApp; B yes then no (withdrawn); C only agreed to marketing; D yes by email;
    // E said yes to service messages by SMS but NO to promotions.
    await consent(member, 'sms', true);
    await consent(member, 'whatsapp', true);
    await consent('cust-B', 'sms', true);
    await consent('cust-B', 'sms', false);
    await consent('cust-C', 'sms', true, 'marketing');
    await consent('cust-D', 'email', true);
    await consent(memberE, 'sms', true);
    await consent(memberE, 'sms', false, 'marketing');

    // No recall, no list: this is not a way to find out who bought what (purpose limitation).
    expect((await req('GET', '/v1/quality/recalls/M-9/notice-list')).status).toBe(404);
    await ok(req('POST', '/v1/quality/recalls/M-9', { reason: 'supplier notice: milk powder contamination' }, 'u-mgr'), 'recall');
    expect((await req('GET', '/v1/quality/recalls/M-9/notice-list', undefined, 'u-cash')).status).toBe(403);
    expect((await req('GET', '/v1/quality/recalls/bad%20batch/notice-list')).status).toBe(400);

    h = restart(h); // ── COLD RESTART ──
    const list = (await ok(req('GET', '/v1/quality/recalls/M-9/notice-list', undefined, 'u-mgr'), 'list')).body as NoticeList;
    expect(list).toMatchObject({ batchId: 'M-9', recall: { status: 'open' }, decisions: ['OB-297', 'OB-328', 'OB-329'], smsConsentPurpose: 'transactional', anonymousSales: 1 });
    expect(list.dataLawBasis.en).toBe('Data-law basis to be confirmed by your CA or lawyer.');
    // OB-328: EVERYONE known is on the list — whatever they said to promotions or to service messages.
    const byRef = new Map(list.callList.map((c) => [c.customerRef, c] as const));
    expect([...byRef.keys()].sort()).toEqual(['cust-B', 'cust-C', 'cust-D', member, memberE].sort());
    expect([member, 'cust-B', 'cust-C', 'cust-D', memberE].map((r) => { const c = byRef.get(r)!; return [c.name, c.phoneLast4, c.serviceMessagesOn, c.smsAllowed, c.notes]; })).toEqual([
      ['Anitha Raman', '3210', ['sms', 'whatsapp'], true, []], // the name she gave; the last four digits only
      [null, null, [], false, ['said_no_to_service_messages']], // still called — a safety recall
      [null, null, [], false, ['no_answer_on_service_messages']],
      ['Dev Kumar', null, ['email'], false, []], // the app login's name; no number on record
      [null, '6780', ['sms'], true, ['said_no_to_promotions']], // skipped her name: not on record, never invented
    ]);
    expect(byRef.get(memberE)!.noteSay).toEqual(['said no to promotions — safety call only']);
    // What they bought: the lot and the date. D's lot is the bun batch made from the recalled batch.
    expect(byRef.get(member)!.bought.map((b) => [b.lot, b.date, b.saleId])).toEqual([['M-9', '2030-06-10', 'S-A1'], ['M-9', '2030-06-10', 'S-A2']]);
    expect(byRef.get('cust-D')!.bought).toEqual([expect.objectContaining({ lot: 'BUN-M', madeFromLot: 'M-9', saleId: 'S-D' })]);
    expect(JSON.stringify(list)).not.toMatch(/9876543210|98765|9123456780/); // never the whole number
    expect(list.smsConsented).toBe(2);
    expect(list.messages).toMatchObject({ channel: 'sms', switchedOn: false, providerConnected: false });
    expect(list.detail).toMatch(/5 customer\(s\) to call/);

    // Consent is read now, not when the recall started: the member withdraws WhatsApp a minute later; the list follows.
    await consent(member, 'whatsapp', false);
    const after = (await ok(req('GET', '/v1/quality/recalls/M-9/notice-list'), 'list again')).body as NoticeList;
    expect(after.callList.find((c) => c.customerRef === member)!.serviceMessagesOn).toEqual(['sms']);

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
    // The port's rule is unchanged by OB-328: only customers with service-message consent by SMS are messaged (A, and E —
    // a "no" to promotions does not stop a service message). B, C and D are on the call list, not messaged.
    expect(first).toMatchObject({ failed: [], alreadyTold: [], transport: 'recording-test-adapter' });
    expect([...first.sent].sort()).toEqual([member, memberE].sort());
    expect([...first.notOnSms].sort()).toEqual(['cust-B', 'cust-C', 'cust-D']);
    expect(provider.sent.map((m) => [m.customerId, m.channel, m.text]).sort()).toEqual([[member, 'sms', text], [memberE, 'sms', text]].sort());
    // Sent again: whoever was told is not told twice.
    h = restart(h, { notificationTransport: provider });
    const again = (await ok(req('POST', '/v1/quality/recalls/M-9/notices', { text }, 'u-mgr'), 'resend')).body as Sent;
    expect(again.sent).toEqual([]);
    expect([...again.alreadyTold].sort()).toEqual([member, memberE].sort());
    expect(provider.sent).toHaveLength(2);

    // Closed with evidence: the list is still there (part of the recall's record); no new message is sent for it.
    await ok(req('POST', '/v1/quality/recalls/M-9/closure', { evidenceRef: 'DOC-contact-log-M-9' }, 'u-mgr'), 'close');
    h = restart(h, { notificationTransport: provider });
    expect(((await ok(req('GET', '/v1/quality/recalls/M-9/notice-list'), 'closed list')).body as NoticeList).recall.status).toBe('closed');
    expect((await req('POST', '/v1/quality/recalls/M-9/notices', { text }, 'u-mgr')).status).toBe(409);

    // Every read of the list, the switch and each send are on the audit trail.
    const trail = async (q: Record<string, string>) => ((await ok(h.request({ method: 'GET', path: '/v1/audit/trail', userId: 'u-owner', tenantId: T, query: q }), 'trail')).body as { matches: { actorId: string; action: string; after: Record<string, string> | null }[] }).matches;
    expect((await trail({ objectId: 'recall-notice:M-9', action: 'quality.lottrace.read' })).map((m) => [m.actorId, m.after?.['customersNamed']])).toEqual([['u-mgr', '5'], ['u-owner', '5'], ['u-owner', '5']]);
    expect((await trail({ action: 'quality.recall.notice.switch' })).map((m) => [m.actorId, m.after?.['on']])).toEqual([['u-owner', 'true']]);
    expect((await trail({ action: 'quality.recall.notice.send' })).map((m) => [m.actorId, m.after?.['sent']])).toEqual([['u-mgr', '2'], ['u-mgr', '0']]);
  }, 120_000);
});

describe('OB-329: the name given at enrolment is sealed with the member, and erased with them', () => {
  it('the raw store holds ciphertext; the call list reads it opened; after the key is shredded the name is "not on record"', async () => {
    const raw = new InMemoryEventStore();
    const keys = new InMemorySubjectKeyStore();
    const h = apiHarness({ store: raw, personalDataKeys: keys });
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await certifyFoodHandler(h.store, T, 'u-owner'); // OB-502: food-handling work needs a valid certificate
    await certifyFoodHandler(h.store, T, 'u-baker'); // OB-502: food-handling work needs a valid certificate
    const req = (method: 'GET' | 'POST', path: string, body?: unknown): Promise<Res> =>
      h.request({ method, path, userId: 'u-owner', tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }) });
    const enrolled = (await req('POST', '/v1/loyalty/members', { mobile: '9876543210', consent: true, verifiedHow: 'seen_on_phone', name: 'Meena Sundaram' })).body as { memberRef: string };
    await req('POST', '/v1/inventory/movements', { movementId: 'rx-1', productId: 'P', locationId: 'S1', kind: 'received', quantityMinor: 5, uom: 'EA', occurredAt: '2030-05-01T00:00:00.000Z', enteredBy: 'u-owner', batchId: 'Z-1' });
    expect((await req('POST', '/v1/sales', sale('S-Z', 'P', 'Z-1', enrolled.memberRef))).status).toBeLessThan(300);
    await req('POST', '/v1/quality/recalls/Z-1', { reason: 'notice' });
    const stored = (await raw.exportTenant(T)).filter((r) => r.event.type === 'LoyaltyMember').map((r) => r.event.payload as Record<string, unknown>);
    expect(stored).toHaveLength(1);
    expect(isSealed(stored[0]!['fullName'])).toBe(true);
    expect(JSON.stringify(await raw.exportTenant(T))).not.toContain('Meena Sundaram');
    const named = (await req('GET', '/v1/quality/recalls/Z-1/notice-list')).body as NoticeList;
    expect(named.callList.map((c) => c.name)).toEqual(['Meena Sundaram']);
    await keys.shred(T, { subjectRef: enrolled.memberRef, category: 'loyalty_member' }, { requestId: 'er-1', shreddedBy: 'u-owner', at: '2030-06-20T00:00:00.000Z' });
    const erased = (await req('GET', '/v1/quality/recalls/Z-1/notice-list')).body as NoticeList;
    expect(erased.callList.map((c) => [c.name, c.phoneLast4])).toEqual([[null, null]]);
  });
});
