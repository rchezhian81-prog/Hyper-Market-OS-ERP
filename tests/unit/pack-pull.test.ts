import { describe, it, expect } from 'vitest';
import {
  httpPackSource, pullPack,
  type PackSource, type PackFetch, type PackReceiver,
} from '../../edge/sync-agent/src/index';
import { createEdgeNode } from '../../edge/store-edge/src/index';
import { hmacSigner } from '../../services/catalogue/src/index';
import { publishPack, type SignedPack } from '../../services/catalogue/src/pack';
import type { DurableLog } from '../../edge/store-edge/src/durability';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';

// Inbound pack pull (SYNC-01, audit GAP-SYNC-01). The outbox drain carries sales UP; nothing carried
// prices/recalls DOWN. This is the inbound mirror: a PackSource fetches the signed pack, and pullPack
// runs it through the SAME acceptPack the lane already trusts (via EdgeNode.takePack). The rule that
// matters: whatever happens — offline, bad signature, older pack — the lane keeps trading on the last
// pack it trusted (P-01), and how stale that is is always visible (P-08).

const KEY = ['sync', 'one', 'pack', 'pull', 'signing', 'key'].join('-').padEnd(48, '0');
const SIGNER = hmacSigner(KEY);
const TENANT = 't-sre';

/** A durable log that is never used here — pullPack touches only pack()/takePack(), not commit(). */
const STUB_LOG: DurableLog = {
  append: () => Promise.resolve(),
  usedBytes: () => Promise.resolve(0),
  capacityBytes: 1_000_000,
};

function snapshot(version: number, builtAt: string, tenantId = TENANT): CatalogueSnapshot {
  return {
    tenantId, version, builtAt,
    products: [{
      productId: 'P1', sku: 'GHEE-1L', name: 'Ghee 1L', baseUom: 'each',
      unitPriceMinor: 64_000, taxBps: 500, mrpMinor: 70_000, status: 'active',
    }],
    barcodes: [{ code: '8901234567890', productId: 'P1', kind: 'standard' }],
  };
}

/** A genuinely signed pack at a version — real signature, so acceptPack's check is really exercised. */
function signedPack(version: number, builtAt: string, tenantId = TENANT): SignedPack {
  const result = publishPack({
    snapshot: snapshot(version, builtAt, tenantId), approvals: [], signer: SIGNER,
    publishedBy: 'u-manager', publishedAt: builtAt,
  });
  if (!result.ok || result.pack === undefined) throw new Error(result.detail);
  return result.pack;
}

/** A PackSource that returns one programmed outcome and records that it was asked. */
function sourceReturning(fetchResult: PackFetch): PackSource & { calls: number } {
  return {
    calls: 0,
    fetch(this: { calls: number }) { this.calls += 1; return Promise.resolve(fetchResult); },
  };
}

const edge = (initialPack?: SignedPack): PackReceiver =>
  createEdgeNode({ tenantId: TENANT, log: STUB_LOG, signer: SIGNER, ...(initialPack ? { initialPack } : {}) });

const AT_V1 = '2026-08-08T09:00:00Z';
const AT_V2 = '2026-08-09T09:00:00Z';
const NOW = '2026-08-09T12:00:00Z';

describe('pullPack — inbound signed pack refresh (SYNC-01)', () => {
  it('adopts a newer, verified pack and reports its version and age', async () => {
    const node = edge(signedPack(1, AT_V1));
    const outcome = await pullPack({ source: sourceReturning({ status: 'fetched', pack: signedPack(2, AT_V2) }), receiver: node, now: NOW });

    expect(outcome.status).toBe('updated');
    expect(outcome.heldVersion).toBe(2);
    expect(outcome.ageHours).toBe(3); // NOW is 3h after v2's builtAt
    expect(outcome.staffMessage).toContain('v2');
    expect(node.pack()?.snapshot.version).toBe(2); // the lane really moved
  });

  it('adopts the FIRST pack when the lane holds none yet', async () => {
    const node = edge(); // no initial pack
    const outcome = await pullPack({ source: sourceReturning({ status: 'fetched', pack: signedPack(1, AT_V1) }), receiver: node, now: NOW });
    expect(outcome.status).toBe('updated');
    expect(outcome.heldVersion).toBe(1);
  });

  it('keeps the last good pack when the signature does not verify', async () => {
    const node = edge(signedPack(1, AT_V1));
    const tampered: SignedPack = { ...signedPack(2, AT_V2), signature: 'deadbeef'.repeat(8) };
    const outcome = await pullPack({ source: sourceReturning({ status: 'fetched', pack: tampered }), receiver: node, now: NOW });

    expect(outcome.status).toBe('kept');
    expect(outcome.heldVersion).toBe(1); // did NOT move to the forged v2
    expect(node.pack()?.snapshot.version).toBe(1);
    expect(outcome.staffMessage).toMatch(/keep selling/i);
  });

  it('keeps the last good pack when the offered pack is not newer', async () => {
    const node = edge(signedPack(2, AT_V2));
    const outcome = await pullPack({ source: sourceReturning({ status: 'fetched', pack: signedPack(1, AT_V1) }), receiver: node, now: NOW });
    expect(outcome.status).toBe('kept');
    expect(outcome.heldVersion).toBe(2); // yesterday's prices are not put back
  });

  it('keeps the last good pack when the pack is built for another tenant', async () => {
    const node = edge(signedPack(1, AT_V1));
    const foreign = signedPack(2, AT_V2, 'some-other-tenant');
    const outcome = await pullPack({ source: sourceReturning({ status: 'fetched', pack: foreign }), receiver: node, now: NOW });
    expect(outcome.status).toBe('kept');
    expect(outcome.heldVersion).toBe(1);
  });

  it('when offline, keeps the last good pack, never even offers it to the lane, and shows its age', async () => {
    const node = edge(signedPack(1, AT_V1));
    const source = sourceReturning({ status: 'unreachable', reason: 'could not reach the cloud' });
    // Wrap takePack to prove it is never called on an unreachable fetch.
    let takeCalls = 0;
    const spy: PackReceiver = { pack: () => node.pack(), takePack: (p) => { takeCalls += 1; return node.takePack(p); } };

    const outcome = await pullPack({ source, receiver: spy, now: NOW });
    expect(outcome.status).toBe('offline');
    expect(outcome.heldVersion).toBe(1);
    expect(outcome.ageHours).toBe(27); // NOW is 27h after v1's builtAt — staleness is visible (P-08)
    expect(outcome.reason).toBe('could not reach the cloud');
    expect(takeCalls).toBe(0);
  });

  it('when offline with no pack ever held, says so and reports no version or age', async () => {
    const outcome = await pullPack({ source: sourceReturning({ status: 'unreachable', reason: 'timeout' }), receiver: edge(), now: NOW });
    expect(outcome.status).toBe('offline');
    expect(outcome.heldVersion).toBeNull();
    expect(outcome.ageHours).toBeNull();
    expect(outcome.staffMessage).toMatch(/no catalogue yet/i);
  });

  it('reports when the cloud has no catalogue published, keeping any held pack', async () => {
    const node = edge(signedPack(1, AT_V1));
    const outcome = await pullPack({ source: sourceReturning({ status: 'none_published' }), receiver: node, now: NOW });
    expect(outcome.status).toBe('none_published');
    expect(outcome.heldVersion).toBe(1);
  });
});

// ── httpPackSource: the thin adapter to GET /v1/catalogue/pack ──────────────
const TOKEN = 'store-token-abcdef-do-not-log';
const sourceOn = (fetchFn: typeof globalThis.fetch, timeoutMs = 10_000): PackSource =>
  httpPackSource({ baseUrl: 'https://api.example.test/', token: TOKEN, fetch: fetchFn, timeoutMs });

describe('httpPackSource', () => {
  it('GETs the catalogue pack with a bearer token and returns the parsed pack on 200', async () => {
    const pack = signedPack(1, AT_V1);
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchFn = ((url: string, init: RequestInit) => {
      seen = { url, init };
      return Promise.resolve(new Response(JSON.stringify(pack), { status: 200 }));
    }) as unknown as typeof globalThis.fetch;

    const result = await sourceOn(fetchFn).fetch();
    expect(result.status).toBe('fetched');
    expect(result.status === 'fetched' && result.pack.snapshot.version).toBe(1);
    expect(seen?.url).toBe('https://api.example.test/v1/catalogue/pack');
    expect(seen?.init.method).toBe('GET');
    expect((seen?.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('maps a 404 to none_published — a real answer, not an error', async () => {
    const fetchFn = (() => Promise.resolve(new Response('', { status: 404 }))) as unknown as typeof globalThis.fetch;
    expect((await sourceOn(fetchFn).fetch()).status).toBe('none_published');
  });

  it('treats a 5xx / expired-token / 429 as unreachable — keep the last good pack', async () => {
    for (const status of [500, 401, 429, 503]) {
      const fetchFn = (() => Promise.resolve(new Response('', { status }))) as unknown as typeof globalThis.fetch;
      const result = await sourceOn(fetchFn).fetch();
      expect(result.status).toBe('unreachable');
    }
  });

  it('treats a network failure as unreachable and never leaks the token', async () => {
    const fetchFn = (() => Promise.reject(new Error(`connect failed using ${TOKEN}`))) as unknown as typeof globalThis.fetch;
    const result = await sourceOn(fetchFn).fetch();
    expect(result.status).toBe('unreachable');
    expect(result.status === 'unreachable' && result.reason).not.toContain(TOKEN);
  });

  it('treats a timeout (abort) as unreachable', async () => {
    const aborts = (() => {
      const err = new Error('aborted'); err.name = 'AbortError'; return Promise.reject(err);
    }) as unknown as typeof globalThis.fetch;
    const result = await sourceOn(aborts).fetch();
    expect(result.status).toBe('unreachable');
    expect(result.status === 'unreachable' && result.reason).toMatch(/no answer within/i);
  });

  it('treats a body that is not a signed pack as unreachable, never a pack to trust', async () => {
    const fetchFn = (() => Promise.resolve(new Response(JSON.stringify({ oops: true }), { status: 200 }))) as unknown as typeof globalThis.fetch;
    const result = await sourceOn(fetchFn).fetch();
    expect(result.status).toBe('unreachable');
  });
});
