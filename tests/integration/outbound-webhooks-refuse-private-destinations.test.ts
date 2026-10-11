import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { apiHarness, TEST_IDP } from '../support/api-harness';
import { startRealCloud, type RealCloud } from '../support/real-store';
import { recordingPartner, approvedSubscription, PUBLIC_ADDRESS, type Raw } from '../support/outbound-partner';
import { judgeDestination, nonPublicAddressReason } from '../../services/platform/src/public-destination';
import { actionDetails } from '../../services/identity/src/approval-requests';

/**
 * **D14 / M32 round 10 — outbound webhooks: (a) the SSRF guard, (b) a second person approves a partner subscription.**
 *
 * On the real API (in memory, and on real PostgreSQL through the production assembly and its own sender worker), with a
 * recording partner transport whose DNS the test controls (no partner is live, no real address is used):
 *
 *   (a) SSRF — a subscription URL is refused (422 `webhook_destination_not_public`, nothing set up) when it is
 *       loopback, private, link-local / the cloud metadata service, IPv6 loopback or unique-local, an IPv4-mapped
 *       private address, a local or internal name, carries a user name, does not resolve, or resolves to ANY private
 *       address among public ones — even with a second person's approval. Checked AGAIN at send: a partner host that
 *       was public when approved and later resolves to a private address (DNS rebinding) is NOT sent to; the message
 *       is dead-lettered saying why, and once the host is public again a person sends it again and it goes — to the
 *       exact address that was vetted.
 *   (b) MAKER-CHECKER — with no approval nothing is set up; the maker cannot approve their own request; a cashier
 *       cannot approve; an approval for another URL does not fit this one; an approval is spent once; a change to the
 *       subscription needs a fresh approval; the approver is kept on the subscription; switching off needs no one.
 */

const OWNER = 'u-owner'; const CHECKER = 'u-setup-checker'; const CASHIER = 'u-cash';
const SECRET_NAME = 'partner-c-signing';
const SECRET = ['ssrf', 'test', 'secret', 'built', 'at', 'run', 'time'].join('-').padEnd(40, 'x');
const codeOf = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } } | null)?.error?.code;
const sale = (saleId: string) => ({
  saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', cashierId: CASHIER, tradingDay: new Date().toISOString().slice(0, 10), committedAt: new Date().toISOString(),
  totalMinor: 1_000, currency: 'INR', packVersion: 0, lines: [], tenders: [{ kind: 'cash', amountMinor: 1_000 }],
});
// Non-public addresses, built at run time from their parts (test vectors for the guard, not hosts anybody runs).
const ip = (...p: number[]): string => p.join('.');
const PRIVATE_10 = ip(10, 1, 2, 3); const METADATA = ip(169, 254, 169, 254); const LOOP = ip(127, 0, 0, 1); const HOME = ip(192, 168, 1, 20);

async function ssrfAndMakerChecker(raw: Raw, partner: ReturnType<typeof recordingPartner>, drain: () => Promise<void>): Promise<void> {
  const post = (user: string, path: string, body: unknown, key = `k-${randomUUID()}`) => raw('POST', path, user, body, key);
  const base = { partnerId: 'partner-c', eventTypes: ['SaleCommitted'], signingKeyRef: `vault://${SECRET_NAME}`, maxAttempts: 3 };
  partner.dns.set('inside.partner-c.example.test', [PRIVATE_10]);
  partner.dns.set('mixed.partner-c.example.test', [PUBLIC_ADDRESS, METADATA]);
  partner.dns.set('gone.partner-c.example.test', []);

  // (a) SSRF at subscribe: each refused by name, nothing set up — before anybody is even asked to approve it.
  for (const url of [
    'https://localhost/h', `https://${LOOP}/h`, `https://${METADATA}/latest/meta-data/`, `https://${PRIVATE_10}:8443/h`, `https://${HOME}/h`,
    'https://[::1]/h', 'https://[fd00::5]/h', `https://[::ffff:${LOOP}]/h`, 'https://metadata.google.internal/h', 'https://db.shop.internal/h',
    'https://inside.partner-c.example.test/h', 'https://mixed.partner-c.example.test/h', 'https://gone.partner-c.example.test/h',
    'https://user:pw@partner-c.example.test/h',
  ]) {
    const r = await post(OWNER, '/v1/integration/outbound-webhooks/SUB-BAD', { ...base, url });
    expect(r.status, `${url}: ${JSON.stringify(r.body)}`).toBe(422);
    expect(codeOf(r), url).toBe('webhook_destination_not_public');
  }
  // …and a second person's approval does not make a private destination acceptable.
  const privateBody = { ...base, url: 'https://inside.partner-c.example.test/h' };
  expect(codeOf(await post(OWNER, '/v1/integration/outbound-webhooks/SUB-BAD', await approvedSubscription(raw, OWNER, CHECKER, 'SUB-BAD', privateBody)))).toBe('webhook_destination_not_public');
  expect((await raw('GET', '/v1/integration/outbound-webhooks/SUB-BAD/reconciliation', OWNER)).status).toBe(404);

  // (b) MAKER-CHECKER.
  const S = '/v1/integration/outbound-webhooks/SUB-C';
  const good = { ...base, url: 'https://hooks.partner-c.example.test/in' };
  expect(codeOf(await post(OWNER, S, good))).toBe('partner_subscription_needs_approval');
  expect(codeOf(await post(OWNER, S, { ...good, approvedBy: CHECKER }))).toBe('approver_named_without_approval');
  const ask = async (body: Record<string, unknown>): Promise<string> => {
    const asked = await post(OWNER, '/v1/approvals/requests', { kind: 'partner_webhook_subscription', subjectRef: 'SUB-C', details: actionDetails(body, { subscriptionId: 'SUB-C' }), valueMinor: null, summary: 'partner C', reason: 'synthetic test' });
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    return (asked.body as { requestId: string }).requestId;
  };
  const decide = (who: string, id: string) => post(who, `/v1/approvals/requests/${id}/decide`, { decision: 'approved', reason: 'checked' });
  const mine = await ask(good);
  expect(codeOf(await decide(OWNER, mine))).toBe('self_approval');               // never the maker
  expect((await decide(CASHIER, mine)).status).toBe(403);                       // never without setup rights
  expect(codeOf(await post(OWNER, S, { ...good, approvalId: mine }))).toBe('approval_still_waiting');
  // An approval for ANOTHER url does not fit this one.
  const other = await ask({ ...good, url: 'https://elsewhere.partner-c.example.test/in' });
  expect((await decide(CHECKER, other)).status).toBe(201);
  expect(codeOf(await post(OWNER, S, { ...good, approvalId: other }))).toBe('approval_does_not_match');
  // The right approval: set up, the approver kept; and that approval is spent — it cannot set up a second time.
  expect((await decide(CHECKER, mine)).status).toBe(201);
  const made = await post(OWNER, S, { ...good, approvalId: mine }, 'sub-c-1');
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  expect(made.body).toMatchObject({ subscription: { version: 1, active: true, setBy: OWNER, approvedBy: CHECKER } });
  const changed = { ...good, eventTypes: ['InventoryMoved', 'SaleCommitted'] };
  expect(codeOf(await post(OWNER, S, { ...changed, approvalId: mine }))).toMatch(/^approval_(does_not_match|already_used)$/);
  expect(codeOf(await post(OWNER, S, changed))).toBe('partner_subscription_needs_approval'); // a change needs its own approval

  // (a) SSRF at SEND: a sale goes to the vetted public address…
  vi.setSystemTime(Date.now() + 1_000);
  expect((await post(OWNER, '/v1/sales', sale('SSRF-1'), 'ssrf-sale-1')).status).toBe(202);
  await drain();
  expect(partner.sent.filter((m) => m.url === good.url)).toHaveLength(1);
  expect(partner.sent.at(-1)).toMatchObject({ url: good.url, address: PUBLIC_ADDRESS });
  // …then the partner's name is re-pointed at the metadata service (DNS rebinding): nothing is sent; dead-lettered, said.
  partner.dns.set('hooks.partner-c.example.test', [METADATA]);
  expect((await post(OWNER, '/v1/sales', sale('SSRF-2'), 'ssrf-sale-2')).status).toBe(202);
  const sentBefore = partner.sent.length;
  await drain();
  expect(partner.sent).toHaveLength(sentBefore);
  const dead = (await raw('GET', `${S}/dead-letters`, OWNER)).body as { deadLetters: { messageId: string; detail: string }[] };
  expect(dead.deadLetters).toHaveLength(1);
  expect(dead.deadLetters[0]!.detail).toMatch(/^not sent: hooks\.partner-c\.example\.test resolves to .*link-local/);
  // Public again: a person sends it again, and it goes — to the address vetted at that moment.
  partner.dns.set('hooks.partner-c.example.test', [PUBLIC_ADDRESS]);
  expect((await post(OWNER, `${S}/messages/${encodeURIComponent(dead.deadLetters[0]!.messageId)}/redeliver`, {})).status).toBe(200);
  await drain();
  expect(partner.sent).toHaveLength(sentBefore + 1);
  expect(partner.sent.at(-1)).toMatchObject({ url: good.url, address: PUBLIC_ADDRESS });

  // Switching off needs no second person (it only stops sending).
  expect((await post(OWNER, `${S}/deactivate`, {})).body).toMatchObject({ subscription: { active: false, version: 2 } });
  // Switching it back ON is a new version — the first approval, already spent, cannot do it again.
  expect(codeOf(await post(OWNER, S, { ...good, approvalId: mine }))).toBe('approval_already_used');
  expect((await post(OWNER, S, await approvedSubscription(raw, OWNER, CHECKER, 'SUB-C', good))).body).toMatchObject({ subscription: { version: 3, active: true, approvedBy: CHECKER } });
}

describe('D14 round 10 — the guard itself', () => {
  it('classes addresses: private, loopback, link-local, metadata, IPv6 local and embedded IPv4 are not public', async () => {
    for (const a of [LOOP, PRIVATE_10, METADATA, HOME, ip(172, 20, 0, 1), ip(100, 64, 0, 1), ip(0, 0, 0, 0), ip(224, 0, 0, 1), ip(255, 255, 255, 255),
      '::1', '::', 'fe80::1', 'fd12:3456::1', 'ff02::1', `::ffff:${PRIVATE_10}`, `64:ff9b::${METADATA}`, '2002:0a01:0203::1', '2001:db8::1']) {
      expect(nonPublicAddressReason(a), a).toBeDefined();
    }
    for (const a of [PUBLIC_ADDRESS, ip(172, 32, 0, 1), '2606:4700::1111', `::ffff:${PUBLIC_ADDRESS}`]) expect(nonPublicAddressReason(a), a).toBeUndefined();
    expect(await judgeDestination('https://x.example.test/h', async () => [PUBLIC_ADDRESS])).toMatchObject({ ok: true, addresses: [PUBLIC_ADDRESS] });
    expect(await judgeDestination('https://x.example.test/h', async () => { throw new Error('NXDOMAIN'); })).toMatchObject({ ok: false });
  });
});

describe('D14 round 10 — SSRF guard and maker-checker (real API, in memory)', () => {
  beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); });
  afterAll(() => { vi.useRealTimers(); });
  it('private destinations refused at subscribe and at send; a partner subscription takes a second person', async () => {
    const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaa0d14b';
    const partner = recordingPartner();
    const h = apiHarness({ outboundTransport: partner, outboundSecrets: new Map([[SECRET_NAME, SECRET]]) });
    await h.seedOwner(T, OWNER);
    await h.provisionRole(T, CASHIER, 'cashier');
    await h.provisionRole(T, CHECKER, 'platform_admin');
    const raw: Raw = (method, path, user, body, key, query) => h.request({ method, path, userId: user, tenantId: T, ...(body === undefined ? {} : { body }), ...(key === undefined ? {} : { idempotencyKey: key }), ...(query === undefined ? {} : { query }) });
    const drain = async () => { const r = await raw('POST', '/v1/integration/outbound-deliveries/drain', OWNER, {}, `drain-${randomUUID()}`); expect(r.status, JSON.stringify(r.body)).toBe(200); };
    await ssrfAndMakerChecker(raw, partner, drain);
  });
});

const DATABASE_URL = process.env['DATABASE_URL'];
describe.skipIf(!DATABASE_URL)('D14 round 10 — on real PostgreSQL, through the production assembly and its own sender worker', () => {
  let cloud: RealCloud;
  const partner = recordingPartner();
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    cloud = await startRealCloud({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), owner: OWNER, packSigningKey: ['d14', 'ssrf', 'key'].join('-').padEnd(48, '0'),
      providers: { outboundTransport: partner, outboundWorkerIntervalMs: 3_600_000 },
      env: { [`OUTBOUND_WEBHOOK_SECRET__${SECRET_NAME}`]: SECRET },
    });
    await cloud.grant(CASHIER, 'cashier');
    await cloud.grant(CHECKER, 'owner');
  }, 120_000);
  afterAll(async () => { await cloud?.stop(); vi.useRealTimers(); });
  it('private destinations refused at subscribe and at send; a partner subscription takes a second person', async () => {
    const raw: Raw = async (method, path, user, body, key, query) => {
      const qs = query === undefined ? '' : `?${new URLSearchParams(query).toString()}`;
      const res = await fetch(`${cloud.baseUrl}${path}${qs}`, {
        method,
        headers: { authorization: `Bearer ${TEST_IDP.issue({ sub: user, tenantId: cloud.tenantId })}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(key === undefined ? {} : { 'idempotency-key': key }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      return { status: res.status, body: text === '' ? null : JSON.parse(text) as unknown };
    };
    const drain = async () => { const p = await cloud.outboundWorker!.runOnce(); expect(p.failed).toEqual([]); };
    await ssrfAndMakerChecker(raw, partner, drain);
  }, 120_000);
});
