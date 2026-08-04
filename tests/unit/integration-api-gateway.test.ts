import { describe, it, expect } from 'vitest';
import {
  admitRequest,
  bodyDigest,
  signWebhook,
  verifyWebhook,
  deprecationNotices,
  type ApiContract,
  type ServiceIdentity,
  type IdempotencyRecord,
} from '../../packages/integration/src/api-gateway';

// M32-FR-01 acceptance: "a replayed API call produces one business effect; an unsupported
// version is rejected cleanly; webhooks are signed and replay-protected."

/** A deterministic test hasher. The real one is injected at the edge. */
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

const IDENTITY: ServiceIdentity = {
  identityId: 'svc-lane-3',
  tenantId: 't-sre',
  branchIds: ['b-main'],
  scopes: ['pos.write', 'pos.read'],
  expiresAt: '2027-01-01T00:00:00Z',
};

const BODY = { saleId: 'S-1', totalMinor: 412_000, lines: 3 };

function admit(over: Partial<Parameters<typeof admitRequest>[0]> = {}) {
  return admitRequest({
    api: 'API-05 pos', requestedVersion: 'v2', contracts: CONTRACTS, identity: IDENTITY,
    requiredScope: 'pos.write', tenantId: 't-sre', branchId: 'b-main', method: 'POST',
    idempotencyKey: 'idem-1', body: BODY, seen: [], hasher,
    correlationId: 'corr-1', at: '2026-08-04T09:00:00Z', ...over,
  });
}

describe('a replay returns the FIRST answer, never a second effect (M32-FR-01)', () => {
  const record: IdempotencyRecord = {
    tenantId: 't-sre', key: 'idem-1', bodyDigest: bodyDigest(BODY, hasher),
    response: { saleId: 'S-1', receiptNo: 'R000042' }, at: '2026-08-04T08:59:00Z',
  };

  it('accepts a first call', () => {
    const d = admit();
    expect(d.accepted).toBe(true);
    expect(d.outcome).toBe('accepted');
  });

  it('returns the ORIGINAL response on a replay, not a fresh empty one', () => {
    const d = admit({ seen: [record] });
    expect(d.accepted).toBe(false);
    expect(d.outcome).toBe('replayed');
    // A fresh 200 with no body leaves the caller unable to tell whether it worked, so
    // it retries again — which is how a duplicate sale reaches a ledger.
    expect(d.replayedResponse).toEqual({ saleId: 'S-1', receiptNo: 'R000042' });
  });

  it('treats the SAME KEY with a different body as a conflict, not a replay', () => {
    const d = admit({ body: { ...BODY, totalMinor: 999_000 }, seen: [record] });
    expect(d.outcome).toBe('idempotency_conflict');
    expect(d.detail).toContain('would hide a lost transaction');
  });

  it('is insensitive to key ORDER in the body — the same request is the same request', () => {
    const reordered = { lines: 3, totalMinor: 412_000, saleId: 'S-1' };
    expect(bodyDigest(reordered, hasher)).toBe(bodyDigest(BODY, hasher));
    expect(admit({ body: reordered, seen: [record] }).outcome).toBe('replayed');
  });

  it('scopes idempotency per TENANT — the same key from two tenants is two requests', () => {
    const other: IdempotencyRecord = { ...record, tenantId: 't-kumar' };
    expect(admit({ seen: [other] }).outcome).toBe('accepted');
  });

  it('REFUSES a write with no idempotency key', () => {
    const d = admit({ idempotencyKey: undefined });
    expect(d.outcome).toBe('missing_idempotency_key');
    expect(d.detail).toContain('resent a sale');
  });

  it('does not demand a key on a read', () => {
    expect(admit({ method: 'GET', requiredScope: 'pos.read', idempotencyKey: undefined }).accepted).toBe(true);
  });
});

describe('an unsupported version is refused CLEANLY, naming what works', () => {
  it('names the supported versions', () => {
    const d = admit({ requestedVersion: 'v9' });
    expect(d.outcome).toBe('unsupported_version');
    // A vague 400 is what has a partner developer guessing at midnight.
    expect(d.detail).toContain('supported: v1, v2');
  });

  it('refuses a retired version and says where to go', () => {
    const d = admit({ requestedVersion: 'v0' });
    expect(d.outcome).toBe('retired_version');
    expect(d.detail).toContain('2025-06-30');
    expect(d.detail).toContain('move to v1 or v2');
  });

  it('accepts a deprecated version and says when it sunsets', () => {
    const d = admit({ requestedVersion: 'v1' });
    expect(d.accepted).toBe(true);
    expect(d.detail).toContain('sunsets on 2026-12-31');
  });
});

describe('the identity carries tenant, branch and scope claims', () => {
  it('refuses a tenant the identity does not belong to', () => {
    expect(admit({ tenantId: 't-kumar' }).outcome).toBe('wrong_tenant');
  });

  it('refuses a branch outside the identity\'s claims', () => {
    expect(admit({ branchId: 'b-other' }).outcome).toBe('branch_not_in_scope');
  });

  it('treats an EMPTY branch claim as the whole tenant, not as none', () => {
    const d = admit({ identity: { ...IDENTITY, branchIds: [] }, branchId: 'b-anything' });
    expect(d.accepted).toBe(true);
  });

  it('refuses a missing scope and an expired identity', () => {
    expect(admit({ requiredScope: 'finance.write' }).outcome).toBe('scope_missing');
    expect(admit({ identity: { ...IDENTITY, expiresAt: '2026-01-01T00:00:00Z' } }).outcome).toBe('identity_expired');
  });

  it('carries a correlation id through every answer (NFR-15)', () => {
    expect(admit({ correlationId: 'corr-9' }).correlationId).toBe('corr-9');
    expect(admit({ correlationId: 'corr-9', requestedVersion: 'v9' }).correlationId).toBe('corr-9');
  });
});

describe('a webhook is signed and time-bound (M32-FR-01)', () => {
  const envelope = signWebhook({
    deliveryId: 'dlv-1', event: 'payment.succeeded', tenantId: 't-sre',
    payload: { amountMinor: 412_000 }, sentAt: '2026-08-04T09:00:00Z',
    signingKeyRef: 'vault://webhooks/pos#v2', hasher,
  });

  const verify = (over: Partial<Parameters<typeof verifyWebhook>[0]> = {}) =>
    verifyWebhook({
      envelope, tenantId: 't-sre', signingKeyRef: 'vault://webhooks/pos#v2', seenDeliveryIds: [],
      hasher, at: '2026-08-04T09:01:00Z', ...over,
    });

  it('accepts a correctly signed, fresh delivery', () => {
    const c = verify();
    expect(c.accepted).toBe(true);
    expect(c.verdict).toBe('valid');
  });

  it('REFUSES a forged signature as a security event', () => {
    const c = verify({ envelope: { ...envelope, signature: 'deadbeefdeadbeef' } });
    expect(c.verdict).toBe('bad_signature');
    expect(c.securityEvent).toBe(true);
    expect(c.detail).toContain('unauthenticated POST from the internet');
  });

  it('REFUSES a correctly signed delivery replayed hours later', () => {
    const c = verify({ at: '2026-08-04T15:00:00Z' });
    expect(c.verdict).toBe('too_old');
    expect(c.securityEvent).toBe(true);
    // The timestamp is INSIDE the signature; a signature over the body alone is valid forever.
    expect(c.detail).toContain('captured delivery being posted back');
  });

  it('treats a duplicate delivery id as a provider RETRY, not an attack', () => {
    const c = verify({ seenDeliveryIds: ['dlv-1'] });
    expect(c.accepted).toBe(false);
    expect(c.verdict).toBe('replayed');
    // Calling every retry an attack trains people to ignore the alerts.
    expect(c.securityEvent).toBe(false);
    expect(c.detail).toContain('correct behaviour');
  });

  it('refuses a delivery aimed at another tenant', () => {
    const c = verify({ tenantId: 't-kumar' });
    expect(c.verdict).toBe('wrong_tenant');
    expect(c.securityEvent).toBe(true);
  });

  it('changes signature when ANY signed field changes', () => {
    const tampered = { ...envelope, payload: { amountMinor: 1 } };
    expect(verify({ envelope: tampered }).verdict).toBe('bad_signature');
    expect(verify({ envelope: { ...envelope, sentAt: '2026-08-04T09:00:01Z' } }).verdict).toBe('bad_signature');
  });
});

describe('deprecation names who is still calling', () => {
  it('telephones them rather than counting them', () => {
    const notices = deprecationNotices({
      contracts: CONTRACTS,
      usage: [
        { identityId: 'svc-partner-a', api: 'API-05 pos', version: 'v1' },
        { identityId: 'svc-partner-a', api: 'API-05 pos', version: 'v1' },
        { identityId: 'svc-partner-b', api: 'API-05 pos', version: 'v1' },
      ],
      today: '2026-08-04',
    });
    const v1 = notices.find((n) => n.version === 'v1');
    expect(v1?.callers).toEqual(['svc-partner-a', 'svc-partner-b']);
    expect(v1?.daysRemaining).toBe(149);
    expect(v1?.detail).toContain('do not count them');
  });

  it('says a version nobody calls is safe to remove', () => {
    const notices = deprecationNotices({ contracts: CONTRACTS, usage: [], today: '2026-08-04' });
    expect(notices.every((n) => n.detail.includes('safe to remove'))).toBe(true);
  });

  it('says nothing about a current version', () => {
    const notices = deprecationNotices({ contracts: CONTRACTS, usage: [], today: '2026-08-04' });
    expect(notices.map((n) => n.version)).not.toContain('v2');
  });
});
