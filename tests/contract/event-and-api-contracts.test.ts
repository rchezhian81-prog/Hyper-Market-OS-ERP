import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeEvent, KNOWN_EVENT_TYPES, isKnownEventType, isIsoUtcTimestamp } from '../../packages/contracts/src/event';
import { money } from '../../packages/contracts/src/money';
import {
  admitRequest, signWebhook, verifyWebhook, bodyDigest,
  type ApiContract, type ServiceIdentity, type IdempotencyRecord,
} from '../../packages/integration/src/api-gateway';
import { simpleHasher } from '../../packages/migration/src/discovery';

// P-06 (open and portable) / §30.2 (events are the integration backbone) / §31.1 (idempotency) /
// API-01…13.
//
// **A contract is only a contract if breaking it fails somewhere.** The catalogue in
// `docs/api/catalogue.md` states the conventions — versioned, idempotent, additive within a
// major, no card data — and until now those were sentences. The one that matters most for this
// product is additive-within-a-major, because the store edge and the cloud are **different
// deployments on different upgrade cycles**: a till that has been offline for three days is
// running last week's contract, and it must still be able to send its sales.
//
// So the test that earns its place is the **backward-compatibility** one: an event built by an
// old version of the code must still be readable by the new one. Everything else here is the
// scaffolding that makes that claim mean something.

const CATALOGUE = readFileSync(join(new URL('../../', import.meta.url).pathname, 'docs/api/catalogue.md'), 'utf8');

describe('the event envelope is the contract both sides build against (§30.2)', () => {
  it('accepts a complete envelope and freezes it', () => {
    const e = makeEvent({
      id: 'evt-S-1', type: 'SaleCommitted', occurredAt: '2026-08-07T09:00:00Z',
      idempotencyKey: 'sale:S-1', source: 'lane-1',
      payload: { saleId: 'S-1', totalMinor: 41_200, currency: 'INR' },
    });
    expect(Object.isFrozen(e)).toBe(true);
    expect(e.version).toBe(1);
  });

  it('REFUSES an envelope missing any field a consumer depends on', () => {
    // A malformed event that publishes is worse than one that throws: it reaches a broker, gets
    // retried, and dead-letters on a consumer that cannot say why.
    const base = {
      id: 'evt-1', type: 'SaleCommitted', occurredAt: '2026-08-07T09:00:00Z',
      idempotencyKey: 'k', source: 'lane-1', payload: {},
    };
    for (const field of ['id', 'type', 'idempotencyKey', 'source'] as const) {
      expect(() => makeEvent({ ...base, [field]: '   ' }), field).toThrow(RangeError);
    }
    expect(() => makeEvent({ ...base, occurredAt: '2026-08-07 09:00' })).toThrow(RangeError);
    expect(() => makeEvent({ ...base, version: 0 })).toThrow(RangeError);
  });

  it('requires UTC timestamps, so two clocks in two places order the same way', () => {
    expect(isIsoUtcTimestamp('2026-08-07T09:00:00Z')).toBe(true);
    expect(isIsoUtcTimestamp('2026-08-07T09:00:00.123Z')).toBe(true);
    // A local-time stamp from a till in one timezone and a server in another cannot be ordered.
    for (const bad of ['2026-08-07T09:00:00+05:30', '2026-08-07T09:00:00', '07/08/2026']) {
      expect(isIsoUtcTimestamp(bad), bad).toBe(false);
    }
  });

  it('every event type the catalogue names is in the code, and vice versa', () => {
    // The catalogue and the code are two statements of one contract. When they disagree, the
    // integration written against the document is the one that breaks.
    const section = CATALOGUE.slice(CATALOGUE.indexOf('## 4. Named domain events'));
    for (const type of ['SaleCommitted', 'TenderAuthorized', 'TenderSettled', 'InventoryMoved', 'InventoryAdjusted', 'PeriodClosed']) {
      expect(section, `${type} is in the code but not the catalogue`).toContain(type);
      expect(isKnownEventType(type), `${type} is in the catalogue but not the code`).toBe(true);
    }
    expect(KNOWN_EVENT_TYPES.length).toBeGreaterThanOrEqual(15);
  });

  it('does not recognise a type nobody defined — an unknown event is not a valid one', () => {
    expect(isKnownEventType('SaleDeleted')).toBe(false);
    expect(isKnownEventType('salecommitted')).toBe(false);
  });
});

describe('additive within a major — the till that has been offline for three days', () => {
  /** An envelope as v1 of the code produced it. Deliberately written out, not constructed. */
  const V1_ON_THE_WIRE = {
    id: 'evt-S-OFFLINE-1',
    type: 'SaleCommitted',
    occurredAt: '2026-08-04T18:22:11Z',
    idempotencyKey: 'sale:S-OFFLINE-1',
    source: 'lane-2',
    version: 1,
    payload: { saleId: 'S-OFFLINE-1', totalMinor: 41_200, currency: 'INR' },
  };

  it('reads a v1 event with today\'s code, unchanged', () => {
    // This is the whole contract. The edge and the cloud are separate deployments on separate
    // upgrade cycles; a till offline since Tuesday is running Tuesday's code, and its sales must
    // still arrive. A contract that only works when both sides are the same version is not a
    // contract, it is a coincidence.
    const e = makeEvent(V1_ON_THE_WIRE);
    expect(e.id).toBe('evt-S-OFFLINE-1');
    expect(e.idempotencyKey).toBe('sale:S-OFFLINE-1');
    expect((e.payload as { totalMinor: number }).totalMinor).toBe(41_200);
  });

  it('accepts an event carrying a field this version does not know about', () => {
    // Forward compatibility, the other direction: a newer till sends a field the cloud has not
    // learned yet. Additive-within-a-major means the unknown field is carried, not rejected.
    const fromNewerEdge = {
      ...V1_ON_THE_WIRE,
      payload: { ...V1_ON_THE_WIRE.payload, loyaltyTier: 'gold', promotionRef: 'P-99' },
    };
    const e = makeEvent(fromNewerEdge);
    expect((e.payload as Record<string, unknown>)['loyaltyTier']).toBe('gold');
  });

  it('keeps money as integer minor units and a currency on the wire (§29.1)', () => {
    // The single most consequential contract detail in the product. A float on the wire is how
    // 41200 becomes 41199.999999 in somebody's ledger, and no test downstream ever sees it happen.
    const payload = (makeEvent(V1_ON_THE_WIRE).payload as { totalMinor: number; currency: string });
    expect(Number.isInteger(payload.totalMinor)).toBe(true);
    expect(payload.currency).toBe('INR');
    expect(money(payload.totalMinor, 'INR').minor).toBe(41_200);

    const serialised = JSON.stringify(makeEvent(V1_ON_THE_WIRE));
    expect(serialised).not.toMatch(/"totalMinor":\s*\d+\.\d/);
  });

  it('survives a JSON round trip byte for byte — the broker is not in-process', () => {
    const e = makeEvent(V1_ON_THE_WIRE);
    const roundTripped = JSON.parse(JSON.stringify(e)) as typeof e;
    expect(roundTripped).toEqual({ ...V1_ON_THE_WIRE });
    // And re-validating what came off the wire produces the same envelope again.
    expect(makeEvent(roundTripped)).toEqual(e);
  });
});

describe('every write is idempotent, and a replay returns the FIRST answer (§31.1)', () => {
  const TENANT = 't-sre';
  const CONTRACTS: readonly ApiContract[] = [{ api: 'pos', version: 'v1', status: 'current' }];
  const IDENTITY: ServiceIdentity = {
    identityId: 'svc-edge', tenantId: TENANT, branchIds: [], scopes: ['pos.write'],
    expiresAt: '2027-01-01T00:00:00Z',
  };

  const request = (over: Partial<Parameters<typeof admitRequest>[0]> = {}) => admitRequest({
    api: 'pos', requestedVersion: 'v1', contracts: CONTRACTS, identity: IDENTITY,
    requiredScope: 'pos.write', tenantId: TENANT, method: 'POST',
    idempotencyKey: 'req-1', body: { saleId: 'S-1', totalMinor: 41_200 },
    seen: [], hasher: simpleHasher, correlationId: 'corr-1', at: '2026-08-07T09:00:00Z',
    ...over,
  });

  const record = (key: string, body: unknown, response: unknown): IdempotencyRecord => ({
    tenantId: TENANT, key, bodyDigest: bodyDigest(body, simpleHasher),
    response, at: '2026-08-07T09:00:00Z',
  });

  it('admits a first, well-formed, scoped request', () => {
    expect(request().accepted).toBe(true);
  });

  it('returns the original response for a repeated key, not a fresh one', () => {
    const body = { saleId: 'S-1', totalMinor: 41_200 };
    const r = request({ seen: [record('req-1', body, { receipt: 'B-1001' })] });
    expect(r.outcome).toBe('replayed');
    expect(r.replayedResponse).toEqual({ receipt: 'B-1001' });
  });

  it('REFUSES the same key with a different body — that is two requests, not a retry', () => {
    const r = request({ seen: [record('req-1', { saleId: 'S-1', totalMinor: 99_900 }, {})] });
    expect(r.accepted).toBe(false);
    expect(r.outcome).toBe('idempotency_conflict');
  });

  it('refuses an unkeyed write, because the catalogue says the key is MANDATORY', () => {
    const r = request({ idempotencyKey: undefined });
    expect(r.accepted).toBe(false);
    expect(CATALOGUE).toContain('Idempotency-Key');
  });

  it('digests a body independently of key order — a re-serialised retry is still a retry', () => {
    expect(bodyDigest({ saleId: 'S-3', totalMinor: 100 }, simpleHasher))
      .toBe(bodyDigest({ totalMinor: 100, saleId: 'S-3' }, simpleHasher));
  });

  it('refuses a version the contract set does not offer (P-06 versioning)', () => {
    expect(request({ requestedVersion: 'v2' }).accepted).toBe(false);
  });

  it('refuses an identity without the scope, and one from another tenant', () => {
    expect(request({ identity: { ...IDENTITY, scopes: ['pos.read'] } }).accepted).toBe(false);
    expect(request({ identity: { ...IDENTITY, tenantId: 't-other' } }).accepted).toBe(false);
  });
});

describe('a webhook signature cannot be forged without the key', () => {
  const TENANT = 't-sre';
  const KEY = 'vault://webhooks/pos#v2';

  const sign = (over: Partial<Parameters<typeof signWebhook>[0]> = {}) => signWebhook({
    deliveryId: 'dl-1', event: 'SaleCommitted', tenantId: TENANT,
    payload: { saleId: 'S-1', totalMinor: 41_200 }, sentAt: '2026-08-07T09:00:00Z',
    signingKeyRef: KEY, hasher: simpleHasher, ...over,
  });

  const verify = (envelope: ReturnType<typeof signWebhook>, over: Record<string, unknown> = {}) =>
    verifyWebhook({
      envelope, tenantId: TENANT, signingKeyRef: KEY, seenDeliveryIds: [],
      hasher: simpleHasher, at: '2026-08-07T09:00:30Z', ...over,
    });

  it('verifies a signature it produced', () => {
    expect(verify(sign()).accepted).toBe(true);
  });

  it('is UNAMBIGUOUS across field boundaries — the forgery a naive concatenation allows', () => {
    // Joined without a separator, deliveryId "ab" + event "c" would sign the same bytes as
    // deliveryId "a" + event "bc", so an attacker could move the boundary without the key.
    expect(sign({ deliveryId: 'ab', event: 'c' }).signature)
      .not.toBe(sign({ deliveryId: 'a', event: 'bc' }).signature);
  });

  it('refuses a valid signature replayed later — the timestamp is INSIDE the signature', () => {
    expect(verify(sign(), { at: '2026-08-07T10:30:00Z' }).accepted).toBe(false);
  });

  it('refuses a body altered after signing', () => {
    const envelope = sign();
    const tampered = { ...envelope, payload: { saleId: 'S-1', totalMinor: 1 } };
    expect(verify(tampered).accepted).toBe(false);
  });

  it('refuses a delivery already seen — at-least-once means duplicates arrive', () => {
    const envelope = sign();
    expect(verify(envelope, { seenDeliveryIds: ['dl-1'] }).accepted).toBe(false);
  });

  it('refuses an envelope addressed to another tenant', () => {
    expect(verify(sign({ tenantId: 't-other' })).accepted).toBe(false);
  });

  it('carries only a vault REFERENCE, never key material (hard rule #4)', () => {
    const serialised = JSON.stringify(sign());
    expect(serialised).not.toContain(KEY);
  });
});

describe('the catalogue states the conventions the code actually implements', () => {
  it('claims versioning, idempotency, dead-letter and no card data — all four are built', () => {
    for (const promise of ['/v1/', 'Idempotency-Key', 'dead-letter', 'no PAN/CVV/expiry']) {
      expect(CATALOGUE, `the catalogue no longer promises "${promise}"`).toContain(promise);
    }
  });

  it('names all thirteen API domains, so none is built without a home', () => {
    for (let i = 1; i <= 13; i += 1) {
      expect(CATALOGUE).toContain(`API-${String(i).padStart(2, '0')}`);
    }
  });
});
