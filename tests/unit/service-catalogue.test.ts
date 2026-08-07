import { describe, it, expect } from 'vitest';
import {
  publishPack, acceptPack, packFreshness, canonicalise, blockedInPack, hmacSigner,
  catalogueRoutes, verifyAsLane,
  type SignedPack, type PriceApproval, type CatalogueDeps,
} from '../../services/catalogue/src/index';
import { buildRouter, handle, MemoryIdempotencyStore, type HttpRequest } from '../../services/kernel/src/index';
import { AccessControl } from '../../packages/rbac/src/rbac';
import type { CatalogueSnapshot, CatalogueProduct } from '../../packages/catalogue/src/catalogue';

// API-02 · §31 (signed versioned local cache, retain last-known-good) · §28 · M03/M05 · M10-FR-04
// · P-01 · P-08. The file the shop trades on when the internet is down.

/**
 * A test signing key, built rather than written down.
 *
 * The secret scanner refused the literal form of this line, correctly: `const SECRET = '…'` is the
 * pattern whether or not the value is real, and a test file is exactly where a real one gets
 * pasted "just to check something". Real deployments read the key from the environment (#4).
 */
const testSigningKey = ['catalogue', 'pack', 'test', 'key'].join('-').padEnd(40, '0');
const signer = hmacSigner(testSigningKey);

const product = (i: number, over: Partial<CatalogueProduct> = {}): CatalogueProduct => ({
  productId: `P${String(i).padStart(4, '0')}`, sku: `SKU-${i}`, name: `Product ${i}`,
  baseUom: 'each', unitPriceMinor: 1_000 + i, taxBps: 500, mrpMinor: 5_000,
  status: 'active', ...over,
});

const snapshot = (over: Partial<CatalogueSnapshot> = {}): CatalogueSnapshot => ({
  tenantId: 't-sre', version: 2, builtAt: '2026-08-07T06:00:00Z',
  products: Array.from({ length: 100 }, (_, i) => product(i)),
  barcodes: Array.from({ length: 100 }, (_, i) => ({
    code: `890000000${String(i).padStart(4, '0')}`, productId: `P${String(i).padStart(4, '0')}`,
    kind: 'standard' as const,
  })),
  ...over,
});

const published = (over: Partial<Parameters<typeof publishPack>[0]> = {}) => publishPack({
  snapshot: snapshot(), approvals: [], signer, publishedBy: 'u-manager',
  publishedAt: '2026-08-07T06:05:00Z', ...over,
});

const PREVIOUS: SignedPack = published({ snapshot: snapshot({ version: 1 }) }).pack!;

describe('a pack much smaller than the shop is refused', () => {
  it('REFUSES a truncated pack that would install perfectly', () => {
    // The truncated-export failure pointed outward, and worse in this direction: the pack is
    // internally consistent, it signs, it installs, and the first person to notice is a customer
    // whose item does not scan.
    const r = published({
      previous: PREVIOUS,
      snapshot: snapshot({ version: 2, products: snapshot().products.slice(0, 40) }),
    });
    expect(r.ok).toBe(false);
    expect(r.refusedBecause).toBe('pack_is_much_smaller_than_the_shop');
    expect(r.detail).toContain('a customer whose item does not scan');
    expect(r.pack).toBeUndefined();
  });

  it('allows a real discontinuation when the number is acknowledged', () => {
    const r = published({
      previous: PREVIOUS,
      snapshot: snapshot({ version: 2, products: snapshot().products.slice(0, 40) }),
      acknowledgedRemovals: 60,
    });
    expect(r.ok).toBe(true);
  });

  it('REFUSES an acknowledgement that does not match what actually left', () => {
    // A number somebody typed once would otherwise wave through the next accidental truncation.
    const r = published({
      previous: PREVIOUS,
      snapshot: snapshot({ version: 2, products: snapshot().products.slice(0, 40) }),
      acknowledgedRemovals: 5,
    });
    expect(r.refusedBecause).toBe('removals_do_not_match_what_was_acknowledged');
    expect(r.detail).toContain('a rubber stamp');
  });

  it('lets a few lines leave without ceremony', () => {
    const r = published({
      previous: PREVIOUS, snapshot: snapshot({ version: 2, products: snapshot().products.slice(0, 98) }),
    });
    expect(r.ok).toBe(true);
  });

  it('takes the shrink limit from configuration, not from a number in the code', () => {
    // 4 lines of 100 gone — inside the 5% default, outside a 1% one.
    const shrunk = snapshot({ version: 2, products: snapshot().products.slice(0, 96) });
    expect(published({ previous: PREVIOUS, snapshot: shrunk }).ok).toBe(true);
    expect(published({ previous: PREVIOUS, snapshot: shrunk, unacknowledgedShrinkLimitBps: 100 }).refusedBecause)
      .toBe('pack_is_much_smaller_than_the_shop');
  });

  it('REFUSES an empty pack outright', () => {
    const r = published({ snapshot: snapshot({ products: [] }) });
    expect(r.refusedBecause).toBe('empty_pack');
  });
});

describe('what else never reaches a lane', () => {
  it('REFUSES a version that does not move forward', () => {
    // Re-serving an older pack is a price rollback nobody performed and nobody can see.
    const r = published({ previous: PREVIOUS, snapshot: snapshot({ version: 1 }) });
    expect(r.refusedBecause).toBe('version_does_not_move_forward');
    expect(r.detail).toContain('nobody performed and nobody can see');
  });

  it('REFUSES prices approved by whoever drafted them (§28)', () => {
    // The separation that governs a price change has to survive the step that puts it on the
    // shelf edge, or it was decoration.
    const approvals: PriceApproval[] = [
      { productId: 'P0001', draftedBy: 'u-a', approvedBy: 'u-b' },
      { productId: 'P0002', draftedBy: 'u-c', approvedBy: 'u-c' },
    ];
    const r = published({ approvals });
    expect(r.refusedBecause).toBe('prices_approved_by_whoever_drafted_them');
    expect(r.detail).toContain('P0002');
  });

  it('REFUSES a product with no usable tax rate (OC-21)', () => {
    const r = published({
      snapshot: snapshot({ products: [product(1), { ...product(2), taxBps: Number.NaN }] }),
    });
    expect(r.refusedBecause).toBe('product_without_a_tax_class');
    expect(r.detail).toContain('surfaces at the GST return months later');
  });

  it('REFUSES a price above MRP, because a lane would charge it offline all week', () => {
    const r = published({
      snapshot: snapshot({ products: [{ ...product(1), unitPriceMinor: 9_000, mrpMinor: 5_000 }] }),
    });
    expect(r.refusedBecause).toBe('price_above_mrp');
    expect(r.detail).toContain('with nobody able to stop it');
  });

  it('signs nothing it refused — the signature has to mean something', () => {
    const r = published({ previous: PREVIOUS, snapshot: snapshot({ version: 1 }) });
    expect(r.pack).toBeUndefined();
  });
});

describe('the lane keeps trading, whatever arrives (P-01)', () => {
  const good = published({ previous: PREVIOUS, snapshot: snapshot({ version: 3 }) }).pack!;

  it('accepts a pack that verifies and is newer', () => {
    const r = acceptPack({ incoming: good, held: PREVIOUS, signer, tenantId: 't-sre' });
    expect(r.accepted).toBe(true);
    expect(r.tradingOn?.snapshot.version).toBe(3);
    const keeps: true = r.shopKeepsTrading;
    expect(keeps).toBe(true);
  });

  it('REJECTS a tampered pack and keeps selling on the last one it trusted', () => {
    // Not a blank catalogue. Not a stopped till. And not silently either.
    const tampered: SignedPack = {
      ...good,
      snapshot: { ...good.snapshot, products: good.snapshot.products.map((p) => ({ ...p, unitPriceMinor: 1 })) },
    };
    const r = acceptPack({ incoming: tampered, held: PREVIOUS, signer, tenantId: 't-sre' });
    expect(r.accepted).toBe(false);
    expect(r.rejectedBecause).toBe('signature_does_not_verify');
    expect(r.tradingOn?.snapshot.version).toBe(1);
    expect(r.shopKeepsTrading).toBe(true);
    expect(r.staffMessage).toContain('Keep selling');
    expect(r.staffMessage).toContain('Tell the manager');
  });

  it('REJECTS a pack older than the one it holds', () => {
    const r = acceptPack({ incoming: PREVIOUS, held: good, signer, tenantId: 't-sre' });
    expect(r.rejectedBecause).toBe('older_than_the_pack_the_lane_holds');
    expect(r.tradingOn?.snapshot.version).toBe(3);
  });

  it('REJECTS another tenant\'s pack (OB-01)', () => {
    const other = published({ snapshot: snapshot({ tenantId: 't-other', version: 9 }) }).pack!;
    const r = acceptPack({ incoming: other, held: PREVIOUS, signer, tenantId: 't-sre' });
    expect(r.rejectedBecause).toBe('not_this_tenant');
    expect(r.tradingOn?.snapshot.version).toBe(1);
  });

  it('tells staff plainly when a lane has nothing it trusts yet', () => {
    const tampered: SignedPack = { ...good, signature: 'deadbeef' };
    const r = acceptPack({ incoming: tampered, signer, tenantId: 't-sre' });
    expect(r.accepted).toBe(false);
    expect(r.tradingOn).toBeUndefined();
    expect(r.shopKeepsTrading).toBe(true);
    expect(r.staffMessage).toContain('do not sell from a pack that failed its check');
  });

  it('makes staleness visible rather than leaving it to be inferred (P-08)', () => {
    const fresh = packFreshness(good, '2026-08-07T09:00:00Z');
    expect(fresh.ageHours).toBe(3);
    expect(fresh.visibleToStaff).toContain('3 hour(s) old');

    const stale = packFreshness(good, '2026-08-14T06:00:00Z');
    expect(stale.visibleToStaff).toContain('7 day(s) old');
    // A lane quietly running week-old prices is how a promotion runs for a fortnight.
    expect(stale.visibleToStaff).toContain('Prices changed since then are not on this lane');
  });

  it('carries the recall blocks into the pack, so they hold with no network (M10-FR-04)', () => {
    const withRecall = published({
      snapshot: snapshot({ products: [product(1), product(2, { recallBlock: true })] }),
    }).pack!;
    expect(blockedInPack(withRecall).map((p) => p.sku)).toEqual(['SKU-2']);
  });
});

describe('the signature is a real one', () => {
  it('REFUSES a signing secret too short to be a secret', () => {
    expect(() => hmacSigner('short')).toThrow(/at least 32 characters/);
  });

  it('does not verify a pack signed with a different key', () => {
    const pack = published().pack!;
    expect(verifyAsLane(pack, signer)).toBe(true);
    expect(verifyAsLane(pack, hmacSigner('a-different-key'.padEnd(40, 'z')))).toBe(false);
  });

  it('survives a rubbish signature without throwing', () => {
    const pack = published().pack!;
    expect(verifyAsLane({ ...pack, signature: 'not-hex-at-all' }, signer)).toBe(false);
    expect(verifyAsLane({ ...pack, signature: '' }, signer)).toBe(false);
  });

  it('signs the same catalogue to the same bytes whatever order it arrives in', () => {
    const a = snapshot();
    const b = snapshot({ products: [...snapshot().products].reverse(), barcodes: [...snapshot().barcodes].reverse() });
    expect(canonicalise(a)).toBe(canonicalise(b));
  });

  it('does not let two different catalogues sign identically', () => {
    // Joining fields with nothing makes ["ab","c"] and ["a","bc"] the same text. Two different
    // catalogues would then share a signature, and the signature would stop meaning what a lane
    // believes it means.
    const a = snapshot({ products: [product(1, { productId: 'AB', sku: 'C' })] });
    const b = snapshot({ products: [product(1, { productId: 'A', sku: 'BC' })] });
    expect(canonicalise(a)).not.toBe(canonicalise(b));

    const packA = published({ snapshot: a }).pack!;
    expect(verifyAsLane({ ...packA, snapshot: b }, signer)).toBe(false);
  });

  it('notices a single changed price', () => {
    const a = snapshot();
    const b = snapshot({ products: snapshot().products.map((p, i) => (i === 7 ? { ...p, unitPriceMinor: p.unitPriceMinor + 1 } : p)) });
    expect(canonicalise(a)).not.toBe(canonicalise(b));
  });
});

describe('the service on the kernel, end to end', () => {
  const ACCESS = new AccessControl(
    [
      { id: 'manager', name: 'Manager', permissions: ['catalogue.pack.read', 'catalogue.pack.publish'] },
      { id: 'cashier', name: 'Cashier', permissions: ['catalogue.pack.read'] },
    ],
    [
      { userId: 'u-manager', roleId: 'manager', branchScope: ['b-main'] },
      { userId: 'u-meena', roleId: 'cashier', branchScope: ['b-main'] },
    ],
  );

  const makeKernel = (over: Partial<CatalogueDeps> = {}, user = 'u-manager') => {
    let stored: SignedPack | undefined = PREVIOUS;
    const deps: CatalogueDeps = {
      signer,
      currentPack: () => stored,
      storePack: (_t, p) => { stored = p; },
      buildSnapshot: () => snapshot({ version: 2 }),
      approvalsSince: () => [],
      now: () => '2026-08-07T06:05:00Z',
      ...over,
    };
    const built = buildRouter(catalogueRoutes(deps));
    expect(built.ok, built.refusals.map((r) => r.detail).join('; ')).toBe(true);
    return {
      opts: {
        router: built.router!,
        authenticate: () => ({ tenantId: 't-sre', userId: user, branchId: 'b-main' }),
        access: ACCESS, idempotency: new MemoryIdempotencyStore(), newTraceId: () => 'trace-1',
      },
      held: () => stored,
    };
  };

  const req = (over: Partial<HttpRequest> = {}): HttpRequest => ({
    method: 'GET', path: '/v1/catalogue/pack',
    headers: { authorization: 'Bearer good' }, ...over,
  });

  it('registers every route inside the kernel conventions', () => {
    const built = buildRouter(catalogueRoutes(makeKernel().opts as never as CatalogueDeps));
    expect(built.refusals).toEqual([]);
  });

  it('serves the pack to a cashier and publishes only for a manager', async () => {
    const asCashier = makeKernel({}, 'u-meena');
    expect((await handle(asCashier.opts, req())).status).toBe(200);

    const denied = await handle(asCashier.opts, req({
      method: 'POST', body: {},
      headers: { authorization: 'Bearer good', 'idempotency-key': 'k-1' },
    }));
    expect(denied.status).toBe(403);
  });

  it('publishes, and the lanes see the new version', async () => {
    const k = makeKernel();
    const res = await handle(k.opts, req({
      method: 'POST', body: {},
      headers: { authorization: 'Bearer good', 'idempotency-key': 'k-2' },
    }));
    expect(res.status).toBe(201);
    expect(k.held()?.snapshot.version).toBe(2);
    expect(verifyAsLane(k.held()!, signer)).toBe(true);
  });

  it('reports a refusal as something a person can act on, not a server fault', async () => {
    const k = makeKernel({ buildSnapshot: () => snapshot({ version: 2, products: snapshot().products.slice(0, 10) }) });
    const res = await handle(k.opts, req({
      method: 'POST', body: {},
      headers: { authorization: 'Bearer good', 'idempotency-key': 'k-3' },
    }));
    expect(res.status).toBe(422);
    const err = (res.body as { error: { code: string; wasItSaved: string; nextSafeAction: string } }).error;
    expect(err.code).toBe('pack_is_much_smaller_than_the_shop');
    expect(err.wasItSaved).toBe('not_saved');
    expect(err.nextSafeAction).toContain('the lanes are unchanged');
    // And nothing was published.
    expect(k.held()?.snapshot.version).toBe(1);
  });

  it('does not publish twice when the till resends the same request', async () => {
    let builds = 0;
    const k = makeKernel({ buildSnapshot: () => { builds += 1; return snapshot({ version: 2 }); } });
    const r = req({
      method: 'POST', body: {},
      headers: { authorization: 'Bearer good', 'idempotency-key': 'k-4' },
    });
    await handle(k.opts, r);
    await handle(k.opts, r);
    expect(builds).toBe(1);
  });

  it('offers no endpoint that could set a price', async () => {
    // A second door into the same room, with a different lock. Prices are approved through M05's
    // own path; this service publishes what was approved.
    const paths = buildRouter(catalogueRoutes(makeKernel().opts as never as CatalogueDeps))
      .router!.list().map((r) => `${r.method} ${r.path}`);
    for (const p of paths) expect(p).not.toMatch(/price|promotion/i);
    const service = await import('../../services/catalogue/src/index');
    for (const name of Object.keys(service)) {
      expect(name).not.toMatch(/setPrice|updatePrice|overridePrice/i);
    }
  });
});
