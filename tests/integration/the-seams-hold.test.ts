import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { pgClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { makeEvent } from '../../packages/contracts/src/event';

import {
  admitRequest, bodyDigest, signWebhook, verifyWebhook, deprecationNotices,
  type ApiContract, type ServiceIdentity, type IdempotencyRecord,
} from '../../packages/integration/src/api-gateway';
import {
  applyMapping, drainConnector, deadLetters, queueHealth, requeueCorrected,
  type Mapping, type ConnectorMessage, type DeliveryResult,
} from '../../packages/integration/src/connector';
import {
  reviewSecrets, rotateSecret, revokeSecret, findUsageSignals, type SecretRef,
} from '../../packages/integration/src/secrets';
import {
  checkDevice, registerAdapter, integrationHealth,
  type CertifiedEntry, type AdapterConfig, type AdapterHeartbeat,
} from '../../packages/integration/src/adapters';
import { statusCentre } from '../../packages/platform-admin/src/support-access';
import { checkHealth } from '../../packages/ops/src/health';

/**
 * STAGE 19 — operate and improve.
 *
 * Gate (roadmap §21): **the seams hold, and the till never notices.**
 *
 * One day of integration traffic at SRE: a till on flaky 4G resending a sale it already
 * committed, a payment provider replaying a webhook, Tally rejecting a journal that
 * dead-letters and is corrected, a signing key rotated with an overlap and a leaked one
 * revoked without, an uncertified scanner turned away at the door — and through all of it,
 * **not one customer waits.**
 *
 * Executed against a REAL PostgreSQL, with the day's integration events banked in the same
 * append-only ledger the database refuses to delete from.
 *
 * Set DATABASE_URL to run; without it the suite skips rather than passing quietly.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT = '77777777-7777-7777-7777-777777777777';
const RUN = `u${Date.now().toString(36)}`;

/** Deterministic digest. The real one is injected at the edge. */
const hasher = (input: string): string => {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i += 1) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
};

const CONTRACTS: readonly ApiContract[] = [
  { api: 'API-05 pos', version: 'v2', status: 'current' },
  { api: 'API-05 pos', version: 'v1', status: 'deprecated', sunsetOn: '2026-12-31' },
  { api: 'API-05 pos', version: 'v0', status: 'retired', sunsetOn: '2025-06-30' },
];

const LANE: ServiceIdentity = {
  identityId: `svc-${RUN}-lane-3`, tenantId: TENANT, branchIds: ['b-main'],
  scopes: ['pos.write', 'pos.read'], expiresAt: '2027-01-01T00:00:00Z',
};

/** The sale the till committed locally at 18:42 and then tried to sync twice. */
const SALE = { saleId: `S-${RUN}`, totalMinor: 412_000, lines: 7, tenderedMinor: 500_000 };

const TALLY_MAPPING: Mapping = {
  connectorId: 'tally',
  version: 'v1',
  rules: [
    { kind: 'copy', from: 'voucherNo', to: 'VOUCHERNUMBER' },
    { kind: 'copy', from: 'amountMinor', to: 'AMOUNT' },
    { kind: 'lookup', from: 'ledger', to: 'LEDGERNAME', table: { sales: 'Sales Account', gst: 'Output GST' } },
    { kind: 'constant', to: 'VCHTYPE', value: 'Sales' },
  ],
  required: ['VOUCHERNUMBER', 'AMOUNT', 'LEDGERNAME', 'VCHTYPE'],
};

const MATRIX: readonly CertifiedEntry[] = [
  { entryId: 'hw-scan-1', category: 'hardware', deviceKind: 'barcode_scanner', vendor: 'Honeywell', model: 'Voyager 1250g', versions: [], certifiedOn: '2026-02-01', edgeOnly: true },
  { entryId: 'hw-scan-2', category: 'hardware', deviceKind: 'barcode_scanner', vendor: 'Zebra', model: 'DS2208', versions: ['1.4', '1.5'], certifiedOn: '2026-02-01', edgeOnly: true },
  { entryId: 'pay-1', category: 'payment', vendor: 'Razorpay', model: 'API', versions: ['v1'], certifiedOn: '2026-01-15', rbiAuthorised: true },
  { entryId: 'pay-2', category: 'payment', vendor: 'QuickPay', model: 'API', versions: ['v1'], certifiedOn: '2026-01-15', rbiAuthorised: false },
  { entryId: 'acc-1', category: 'accounting', vendor: 'Tally', model: 'Prime', versions: ['3.0'], certifiedOn: '2026-01-10' },
];

const message = (over: Partial<ConnectorMessage>): ConnectorMessage => ({
  messageId: `m-${RUN}-1`, tenantId: TENANT, connectorId: 'tally', connectorVersion: 'v1',
  kind: 'journal', payload: { voucherNo: `V-${RUN}`, amountMinor: 412_000, ledger: 'sales' },
  deliveryKey: `k-${RUN}-1`, enqueuedAt: '2026-08-04T19:00:00Z', state: 'queued', attempts: 0,
  ...over,
});

describe.skipIf(!DATABASE_URL)('Stage 19 — the seams hold (real PostgreSQL)', () => {
  let client: Client;
  let store: SqlEventStore;

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    const sql = pgClient(client);
    const dir = 'db/migrations';
    await runMigrations(
      sql,
      readdirSync(dir)
        .filter((f) => f.endsWith('.sql'))
        .sort()
        .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })),
    );
    store = new SqlEventStore(sql);
  });

  afterAll(async () => {
    await client.end();
  });

  // ─── 1. THE TILL RESENDS A SALE IT ALREADY COMMITTED ────────────────────────

  it('BANKS THE SALE ONCE when a till on flaky 4G sends it three times', async () => {
    const key = `idem-${RUN}-sale`;
    const seen: IdempotencyRecord[] = [];

    const first = admitRequest({
      api: 'API-05 pos', requestedVersion: 'v2', contracts: CONTRACTS, identity: LANE,
      requiredScope: 'pos.write', tenantId: TENANT, branchId: 'b-main', method: 'POST',
      idempotencyKey: key, body: SALE, seen, hasher,
      correlationId: `corr-${RUN}-1`, at: '2026-08-04T18:42:00Z',
    });
    expect(first.accepted).toBe(true);

    // The write lands, and its answer is remembered.
    await store.append(
      TENANT, `sale/${RUN}`,
      makeEvent({
        id: SALE.saleId, type: 'SaleCommitted', occurredAt: '2026-08-04T18:42:00Z',
        idempotencyKey: `${RUN}:${key}`, source: 'pos', payload: SALE,
      }),
    );
    const response = { saleId: SALE.saleId, receiptNo: `R-${RUN}` };
    seen.push({ tenantId: TENANT, key, bodyDigest: bodyDigest(SALE, hasher), response, at: '2026-08-04T18:42:00Z' });

    // 4G drops. The till retries twice, in a different field order the second time.
    for (const [n, body] of [SALE, { lines: 7, tenderedMinor: 500_000, totalMinor: 412_000, saleId: SALE.saleId }].entries()) {
      const retry = admitRequest({
        api: 'API-05 pos', requestedVersion: 'v2', contracts: CONTRACTS, identity: LANE,
        requiredScope: 'pos.write', tenantId: TENANT, branchId: 'b-main', method: 'POST',
        idempotencyKey: key, body, seen, hasher,
        correlationId: `corr-${RUN}-retry-${n}`, at: '2026-08-04T18:43:00Z',
      });
      expect(retry.outcome).toBe('replayed');
      // The FIRST answer, so the till knows it worked and stops retrying.
      expect(retry.replayedResponse).toEqual(response);
    }

    // One sale in the ledger. Not three.
    expect(await store.readStream(TENANT, `sale/${RUN}`)).toHaveLength(1);
  });

  it('calls a REUSED KEY WITH A DIFFERENT SALE a conflict, not a replay', () => {
    const key = `idem-${RUN}-sale`;
    const seen: IdempotencyRecord[] = [
      { tenantId: TENANT, key, bodyDigest: bodyDigest(SALE, hasher), response: {}, at: '2026-08-04T18:42:00Z' },
    ];
    const d = admitRequest({
      api: 'API-05 pos', requestedVersion: 'v2', contracts: CONTRACTS, identity: LANE,
      requiredScope: 'pos.write', tenantId: TENANT, branchId: 'b-main', method: 'POST',
      idempotencyKey: key, body: { ...SALE, totalMinor: 99_000 }, seen, hasher,
      correlationId: `corr-${RUN}-2`, at: '2026-08-04T18:44:00Z',
    });
    expect(d.outcome).toBe('idempotency_conflict');
    // Silently returning the first answer would hide a genuinely lost ₹990 sale.
    expect(d.detail).toContain('would hide a lost transaction');

    // And a write with no key at all never gets in.
    const naked = admitRequest({
      api: 'API-05 pos', requestedVersion: 'v2', contracts: CONTRACTS, identity: LANE,
      requiredScope: 'pos.write', tenantId: TENANT, branchId: 'b-main', method: 'POST',
      body: SALE, seen: [], hasher, correlationId: `corr-${RUN}-3`, at: '2026-08-04T18:45:00Z',
    });
    expect(naked.outcome).toBe('missing_idempotency_key');
  });

  it('refuses an old lane build cleanly and NAMES who is still on the old version', () => {
    const retired = admitRequest({
      api: 'API-05 pos', requestedVersion: 'v0', contracts: CONTRACTS, identity: LANE,
      requiredScope: 'pos.write', tenantId: TENANT, branchId: 'b-main', method: 'POST',
      idempotencyKey: `idem-${RUN}-old`, body: SALE, seen: [], hasher,
      correlationId: `corr-${RUN}-4`, at: '2026-08-04T18:46:00Z',
    });
    expect(retired.outcome).toBe('retired_version');
    // A vague 400 is what has somebody guessing at midnight.
    expect(retired.detail).toContain('move to v1 or v2');

    const notices = deprecationNotices({
      contracts: CONTRACTS,
      usage: [
        { identityId: `svc-${RUN}-lane-7`, api: 'API-05 pos', version: 'v1' },
        { identityId: `svc-${RUN}-partner`, api: 'API-05 pos', version: 'v1' },
      ],
      today: '2026-08-04',
    });
    const v1 = notices.find((n) => n.version === 'v1');
    expect(v1?.callers).toEqual([`svc-${RUN}-lane-7`, `svc-${RUN}-partner`]);
    expect(v1?.detail).toContain('do not count them');
  });

  // ─── 2. THE PAYMENT PROVIDER REPLAYS A WEBHOOK ──────────────────────────────

  it('accepts the payment webhook once and REFUSES its forgeries', () => {
    const envelope = signWebhook({
      deliveryId: `dlv-${RUN}`, event: 'payment.succeeded', tenantId: TENANT,
      payload: { saleId: SALE.saleId, amountMinor: 412_000 }, sentAt: '2026-08-04T18:42:30Z',
      signingKeyRef: 'vault://webhooks/pos#v2', hasher,
    });

    const verify = (over: Partial<Parameters<typeof verifyWebhook>[0]> = {}) =>
      verifyWebhook({
        envelope, tenantId: TENANT, signingKeyRef: 'vault://webhooks/pos#v2',
        seenDeliveryIds: [], hasher, at: '2026-08-04T18:42:45Z', ...over,
      });

    expect(verify().accepted).toBe(true);

    // The provider's ack was lost, so it retries. That is correct behaviour, not an attack.
    const retried = verify({ seenDeliveryIds: [`dlv-${RUN}`] });
    expect(retried.verdict).toBe('replayed');
    expect(retried.securityEvent).toBe(false);

    // Somebody captured that delivery and posts it back six hours later.
    const stale = verify({ at: '2026-08-05T00:42:45Z' });
    expect(stale.verdict).toBe('too_old');
    expect(stale.securityEvent).toBe(true);
    expect(stale.detail).toContain('captured delivery being posted back');

    // And the amount edited in flight.
    const tampered = verify({ envelope: { ...envelope, payload: { saleId: SALE.saleId, amountMinor: 4_120_000 } } });
    expect(tampered.verdict).toBe('bad_signature');
    expect(tampered.securityEvent).toBe(true);
  });

  // ─── 3. TALLY REJECTS A JOURNAL ─────────────────────────────────────────────

  it('MAPS THE JOURNAL OR REFUSES — an unmapped cess is not a dropped field', () => {
    const clean = applyMapping({
      mapping: TALLY_MAPPING,
      source: { voucherNo: `V-${RUN}`, amountMinor: 412_000, ledger: 'sales' },
    });
    expect(clean.mapped).toBe(true);
    expect(clean.output['LEDGERNAME']).toBe('Sales Account');

    // A cess line nobody added a rule for.
    const withCess = applyMapping({
      mapping: TALLY_MAPPING,
      source: { voucherNo: `V-${RUN}`, amountMinor: 412_000, ledger: 'sales', cessMinor: 4_120 },
    });
    expect(withCess.mapped).toBe(false);
    expect(withCess.unmapped).toEqual(['cessMinor']);
    expect(withCess.detail).toContain('for a quarter');

    // A ledger code the mapping has never seen.
    const unknown = applyMapping({
      mapping: TALLY_MAPPING,
      source: { voucherNo: `V-${RUN}`, amountMinor: 412_000, ledger: 'cess_payable' },
    });
    expect(unknown.outcome).toBe('lookup_miss');
    expect(unknown.detail).toContain('posts and is wrong');
  });

  it('DEAD-LETTERS a rejection immediately and retries only what is worth retrying', () => {
    const permanent: DeliveryResult = { outcome: 'permanent', detail: 'ledger "Cess Payable" does not exist' };
    const rejected = drainConnector({
      connectorId: 'tally',
      messages: [message({})],
      transport: () => permanent,
      at: '2026-08-04T19:05:00Z',
    });
    expect(rejected.deadLettered).toEqual([`m-${RUN}-1`]);
    // One attempt, not five. Nine retries with backoff buries the message that mattered.
    expect(rejected.messages[0]?.attempts).toBe(1);

    // A dropped connection is a different matter, and it backs off.
    const flaky = drainConnector({
      connectorId: 'tally',
      messages: [message({ messageId: `m-${RUN}-2`, deliveryKey: `k-${RUN}-2` })],
      transport: () => ({ outcome: 'retryable', detail: 'connection reset' }),
      at: '2026-08-04T19:06:00Z',
    });
    expect(flaky.requeued).toEqual([{ messageId: `m-${RUN}-2`, nextAttemptInSeconds: 2 }]);

    // A duplicate counts as delivered: Tally already has it, our ack was lost.
    const dup = drainConnector({
      connectorId: 'tally',
      messages: [message({ messageId: `m-${RUN}-3`, deliveryKey: `k-${RUN}-3` })],
      transport: () => ({ outcome: 'duplicate', detail: 'voucher already exists' }),
      at: '2026-08-04T19:07:00Z',
    });
    expect(dup.delivered).toEqual([`m-${RUN}-3`]);

    // And a rate limit WAITS rather than discarding.
    const limited = drainConnector({
      connectorId: 'tally',
      messages: [message({ messageId: `m-${RUN}-4`, deliveryKey: `k-${RUN}-4` })],
      transport: () => ({ outcome: 'throttled', detail: 'HTTP 429' }),
      at: '2026-08-04T19:08:00Z',
    });
    expect(limited.throttled).toEqual([`m-${RUN}-4`]);
    expect(limited.messages[0]?.state).toBe('queued');
  });

  it('CORRECTS the failure with a new key and keeps the original on file (#6)', () => {
    const failed = message({
      state: 'dead_lettered', attempts: 1, lastError: 'ledger "Cess Payable" does not exist',
      deadLetteredAt: '2026-08-04T19:05:00Z',
    });

    // The queue is visibly unwell while it sits there.
    const before = queueHealth({ connectorId: 'tally', messages: [failed], at: '2026-08-05T09:00:00Z' });
    expect(before.needsAttention).toBe(true);
    expect(before.detail).toContain('read, never deleted');

    // Reusing the key is refused — at Tally it would be indistinguishable from a retry.
    expect(requeueCorrected({
      original: failed, correctedPayload: {}, newMessageId: `m-${RUN}-1c`,
      newDeliveryKey: failed.deliveryKey, correctedBy: 'u-finance',
      messages: [failed], at: '2026-08-05T09:30:00Z',
    }).outcome).toBe('same_key');

    const corrected = requeueCorrected({
      original: failed,
      correctedPayload: { voucherNo: `V-${RUN}`, amountMinor: 412_000, ledger: 'gst' },
      newMessageId: `m-${RUN}-1c`, newDeliveryKey: `k-${RUN}-1c`, correctedBy: 'u-finance',
      messages: [failed], at: '2026-08-05T09:30:00Z',
    });
    expect(corrected.requeued).toBe(true);

    // The original failure still stands, marked rather than edited away.
    const original = corrected.messages.find((m) => m.messageId === `m-${RUN}-1`);
    expect(original?.state).toBe('dead_lettered');
    expect(original?.lastError).toContain('Cess Payable');
    expect(original?.supersededBy).toBe(`m-${RUN}-1c`);
    expect(deadLetters(corrected.messages)).toHaveLength(1);

    const after = queueHealth({ connectorId: 'tally', messages: corrected.messages, at: '2026-08-05T09:31:00Z' });
    expect(after.needsAttention).toBe(false);
  });

  it('sees a queue that is neither growing NOR MOVING', () => {
    const stuck = queueHealth({
      connectorId: 'tally',
      messages: [message({ enqueuedAt: '2026-08-04T15:00:00Z' })],
      at: '2026-08-04T19:00:00Z',
    });
    expect(stuck.needsAttention).toBe(true);
    expect(stuck.oldestQueuedMinutes).toBe(240);
    // Twenty messages is fine. Twenty since Tuesday is an outage nobody noticed.
    expect(stuck.detail).toContain('depth alone says nothing');
  });

  // ─── 4. A KEY IS ROTATED, AND ANOTHER IS LEAKED ─────────────────────────────

  const PAYMENT_KEY: SecretRef = {
    secretId: `s-${RUN}-pay`, kind: 'payment_provider', vaultRef: 'vault://payments/live#v4',
    version: 4, state: 'active', createdOn: '2026-01-01', owner: 'u-sivakumar',
    protects: 'card payments at every till', lastRotatedOn: '2026-01-01',
    rotateEveryDays: 90, environment: 'production',
  };

  it('ROTATES WITH AN OVERLAP so unsynced lanes keep working', () => {
    const overdue = reviewSecrets({ secrets: [PAYMENT_KEY], asAt: '2026-08-04' });
    expect(overdue.issues[0]?.finding).toBe('overdue_rotation');
    // The sentence that gets it done, rather than "secret 14 is 216 days old".
    expect(overdue.issues[0]?.detail).toContain('card payments at every till');

    const hardCut = rotateSecret({
      secret: PAYMENT_KEY, newVaultRef: 'vault://payments/live#v5',
      rotatedBy: 'u-sivakumar', graceDays: 0, at: '2026-08-05T10:00:00Z',
    });
    expect(hardCut.rotated).toBe(false);
    expect(hardCut.detail).toContain('accept the breakage deliberately');

    const rotated = rotateSecret({
      secret: PAYMENT_KEY, newVaultRef: 'vault://payments/live#v5',
      rotatedBy: 'u-sivakumar', graceDays: 7, at: '2026-08-05T10:00:00Z',
    });
    expect(rotated.next?.version).toBe(5);
    expect(rotated.previous?.state).toBe('superseded');
    expect(rotated.oldValidUntil).toBe('2026-08-12');
    expect(rotated.detail).toContain('edge devices that have not synced keep working');
  });

  it('REVOKES A LEAKED KEY IMMEDIATELY and names what stops before it stops', () => {
    const leaked: SecretRef = {
      ...PAYMENT_KEY, secretId: `s-${RUN}-hook`, kind: 'webhook_signing',
      vaultRef: 'vault://webhooks/pos#v2', protects: 'every inbound payment notification',
    };
    const references = [
      { adapterId: 'adp-razorpay', vaultRef: 'vault://webhooks/pos#v2' },
      { adapterId: 'adp-upi', vaultRef: 'vault://webhooks/pos#v2' },
      { adapterId: 'adp-tally', vaultRef: 'vault://accounting/live#v2' },
    ];

    const revoked = revokeSecret({
      secret: leaked, reason: 'pasted into a support ticket', revokedBy: 'u-security',
      referencedBy: references, at: '2026-08-05T11:00:00Z',
    });
    expect(revoked.revoked.state).toBe('revoked');
    expect(revoked.breaks).toEqual(['adp-razorpay', 'adp-upi']);
    expect(revoked.detail).toContain('better paid knowingly');

    // A week later, one adapter was never repointed. That is the blocking finding.
    const stillWired = reviewSecrets({
      secrets: [revoked.revoked],
      referencedBy: references.map((r) => ({ ...r, environment: 'production' as const })),
      asAt: '2026-08-12',
    });
    expect(stillWired.issues[0]?.finding).toBe('revoked_still_referenced');
    expect(stillWired.issues[0]?.blocking).toBe(true);
    expect(stillWired.detail).toContain('WILL fail');
  });

  it('SURFACES odd traffic and blocks nothing', () => {
    const findings = findUsageSignals({
      current: [
        { identityId: `svc-${RUN}-partner`, api: 'API-06 customer', calls: 9_000, errors: 0, onDate: '2026-08-04' },
        { identityId: `svc-${RUN}-lane-3`, api: 'API-05 pos', calls: 400, errors: 90, onDate: '2026-08-04' },
      ],
      baseline: [
        { identityId: `svc-${RUN}-partner`, api: 'API-06 customer', calls: 200, errors: 0, onDate: '2026-07-28' },
        { identityId: `svc-${RUN}-lane-3`, api: 'API-05 pos', calls: 380, errors: 2, onDate: '2026-07-28' },
        { identityId: `svc-${RUN}-esl`, api: 'API-02 catalogue', calls: 1_200, errors: 0, onDate: '2026-07-28' },
      ],
    });

    expect(findings.every((f) => f.actionTaken === false)).toBe(true);
    expect(findings.find((f) => f.signal === 'spike')?.detail).toContain('kills a payment integration mid-sale');
    expect(findings.some((f) => f.signal === 'error_surge')).toBe(true);
    // The one nobody would have noticed: the shelf-label feed stopped calling entirely.
    const silent = findings.find((f) => f.signal === 'silent');
    expect(silent?.identityId).toBe(`svc-${RUN}-esl`);
    expect(silent?.detail).toContain('nobody reports the alert that never fires');
  });

  // ─── 5. HARDWARE AND PROVIDERS AT THE DOOR ──────────────────────────────────

  it('TURNS AWAY the cheap Sunday scanner and says what to buy instead', () => {
    const refused = checkDevice({
      vendor: 'NoName', model: 'BC-99', deviceKind: 'barcode_scanner', matrix: MATRIX,
    });
    expect(refused.allowed).toBe(false);
    // A refusal with no alternative is one somebody overrides on a Sunday.
    expect(refused.alternatives).toEqual(['Honeywell Voyager 1250g', 'Zebra DS2208']);

    const stale = checkDevice({
      vendor: 'Zebra', model: 'DS2208', firmware: '1.2', deviceKind: 'barcode_scanner', matrix: MATRIX,
    });
    expect(stale.detail).toContain('update it rather than replace it');

    expect(checkDevice({
      vendor: 'Honeywell', model: 'Voyager 1250g', deviceKind: 'barcode_scanner', matrix: MATRIX,
    }).detail).toContain('no cloud in the path of a scan');
  });

  it('REFUSES A PAYMENT ADAPTER that keeps anything but a token, or an inline key', () => {
    const good: AdapterConfig = {
      adapterId: `adp-${RUN}-pay`, tenantId: TENANT, category: 'payment', vendor: 'Razorpay',
      environment: 'production', credentialRef: 'vault://payments/live#v5',
      retains: ['provider_token', 'last4'], enabled: true, queueOnOutage: true,
    };
    expect(registerAdapter({ config: good, matrix: MATRIX, environment: 'production' }).registered).toBe(true);

    const keepsTooMuch = registerAdapter({
      config: { ...good, retains: ['provider_token', 'full_card_digits'] },
      matrix: MATRIX, environment: 'production',
    });
    expect(keepsTooMuch.outcome).toBe('stores_card_data');
    expect(keepsTooMuch.detail).toContain('no override anywhere');

    const unauthorised = registerAdapter({
      config: { ...good, vendor: 'QuickPay' }, matrix: MATRIX, environment: 'production',
    });
    expect(unauthorised.outcome).toBe('provider_not_authorised');

    const typedIn = registerAdapter({
      config: { ...good, credentialRef: 'rzp_live_TYPEDINTOASCREEN' },
      matrix: MATRIX, environment: 'production',
    });
    expect(typedIn.outcome).toBe('credential_inline');
    expect(typedIn.detail).toContain('typed into a configuration screen');
  });

  // ─── 6. AND THE TILL NEVER NOTICES ──────────────────────────────────────────

  it('KEEPS THE TILL OUT OF IT while Tally is down and the ESL feed is silent', () => {
    const configs: readonly AdapterConfig[] = [
      { adapterId: 'adp-tally', tenantId: TENANT, category: 'accounting', vendor: 'Tally', environment: 'production', credentialRef: 'vault://accounting/live#v2', enabled: true, queueOnOutage: true },
      { adapterId: 'adp-esl', tenantId: TENANT, category: 'hardware', vendor: 'SoluM', environment: 'production', credentialRef: 'vault://esl/live#v1', enabled: true },
      { adapterId: `adp-${RUN}-pay`, tenantId: TENANT, category: 'payment', vendor: 'Razorpay', environment: 'production', credentialRef: 'vault://payments/live#v5', retains: ['provider_token'], enabled: true, queueOnOutage: true },
    ];
    const heartbeats: readonly AdapterHeartbeat[] = [
      { adapterId: 'adp-tally', at: '2026-08-04T14:00:00Z', ok: true },
      { adapterId: 'adp-tally', at: '2026-08-04T19:05:00Z', ok: false },
      { adapterId: `adp-${RUN}-pay`, at: '2026-08-04T18:58:00Z', ok: true },
    ];

    const report = integrationHealth({ tenantId: TENANT, configs, heartbeats, at: '2026-08-04T19:10:00Z' });

    // Typed as the literal `true`: no integration failure may reach the till.
    expect(report.posUnaffected).toBe(true);
    expect(report.detail).toContain('the till is unaffected either way');

    // Tally last worked five hours ago and the ESL feed has never reported.
    const tally = report.adapters.find((a) => a.adapterId === 'adp-tally');
    expect(tally?.state).toBe('silent');
    expect(tally?.shopKeepsTrading).toBe(true);
    expect(report.adapters.find((a) => a.adapterId === 'adp-esl')?.detail).toContain('"configured" is not health');
    expect(report.adapters.find((a) => a.adapterId === `adp-${RUN}-pay`)?.state).toBe('healthy');

    // And the status centre tells the owner the same thing, from the SAME health
    // computation rather than a cheerful status of its own: the cloud is unreachable and
    // the shop keeps selling (P-01).
    const health = checkHealth(
      {
        databaseReachable: false,
        localStoreWritable: true,
        lastSyncAt: '2026-08-04T14:00:00Z',
        queueDepth: 41,
        deadLetterCount: 1,
        catalogueBuiltAt: '2026-08-04T06:00:00Z',
        // The integrations the rest of this suite has been exercising.
        integrations: { tally: false, esl: false, razorpay: true },
      },
      '2026-08-04T19:10:00Z',
    );
    expect(health.status).not.toBe('ok');
    expect(health.canTrade).toBe(true);

    const centre = statusCentre({
      tenantId: TENANT,
      health,
      fleet: { total: 6, trading: 6, blocked: 0 },
      supportSessions: [],
      entitlements: [],
      now: '2026-08-04T19:10:00Z',
    });
    expect(centre.health.canTrade).toBe(true);
    expect(centre.fleet.blocked).toBe(0);
    // The headline names the problem without ever saying "stop selling".
    expect(centre.headline).not.toBe('Everything normal');
  });

  it('banks the day\'s integration events, and the database refuses to unpick them', async () => {
    const events = [
      { id: `evt-${RUN}-replay`, type: 'ApiReplayServed', payload: { key: `idem-${RUN}-sale`, effects: 1 } },
      { id: `evt-${RUN}-hook`, type: 'WebhookRejected', payload: { deliveryId: `dlv-${RUN}`, reason: 'too_old' } },
      { id: `evt-${RUN}-dead`, type: 'ConnectorDeadLettered', payload: { messageId: `m-${RUN}-1`, connector: 'tally' } },
      { id: `evt-${RUN}-fix`, type: 'ConnectorCorrectionQueued', payload: { supersedes: `m-${RUN}-1`, newKey: `k-${RUN}-1c` } },
      { id: `evt-${RUN}-revoke`, type: 'SecretRevoked', payload: { secretId: `s-${RUN}-hook`, breaks: 2 } },
      { id: `evt-${RUN}-device`, type: 'DeviceRefused', payload: { vendor: 'NoName', model: 'BC-99' } },
    ];

    for (const [n, e] of events.entries()) {
      await store.append(
        TENANT, `integration/${RUN}`,
        makeEvent({
          id: e.id, type: e.type, occurredAt: `2026-08-04T2${n === 5 ? 3 : n}:00:00Z`,
          idempotencyKey: `${RUN}:${e.id}`, source: 'web-erp', payload: e.payload,
        }),
      );
    }

    expect(await store.readStream(TENANT, `integration/${RUN}`)).toHaveLength(6);

    // The same event again is one row, not seven — the same rule the API applies.
    await store.append(
      TENANT, `integration/${RUN}`,
      makeEvent({
        id: `evt-${RUN}-replay`, type: 'ApiReplayServed', occurredAt: '2026-08-04T20:00:00Z',
        idempotencyKey: `${RUN}:evt-${RUN}-replay`, source: 'web-erp',
        payload: { key: `idem-${RUN}-sale`, effects: 1 },
      }),
    );
    expect(await store.readStream(TENANT, `integration/${RUN}`)).toHaveLength(6);

    const refusalFor = async (sql: string): Promise<string> => {
      try {
        await client.query(sql, [TENANT]);
        return 'THE DATABASE ALLOWED IT';
      } catch (error) {
        return (error as Error).message;
      }
    };
    expect(await refusalFor('DELETE FROM event_ledger WHERE tenant_id = $1')).toMatch(/append-only/i);
    expect(await refusalFor("UPDATE event_ledger SET type = 'x' WHERE tenant_id = $1")).toMatch(/append-only/i);
    expect(await store.readStream(TENANT, `integration/${RUN}`)).toHaveLength(6);
  });
});
