import { describe, it, expect } from 'vitest';
import {
  project, checkMovement, negativeStock, EFFECT_ON_HAND, inventoryRoutes,
  type Movement, type InventoryDeps,
} from '../../services/inventory/src/index';
import { grantRole, identityRoutes, type GrantRequest, type IdentityDeps } from '../../services/identity/src/index';
import {
  assessHealth, platformRoutes, inMemorySettings,
  type DependencyProbe, type SupportAccessRequest, type OwnerApproval, type PlatformDeps,
} from '../../services/platform/src/index';
// The ONE implementation. The service used to carry a second, weaker copy of this control.
import { grantSupportAccess } from '../../packages/platform-admin/src/index';
import { buildRouter, handle, MemoryIdempotencyStore } from '../../services/kernel/src/index';
import { AccessControl, type Role } from '../../packages/rbac/src/rbac';

// API-04 Inventory · API-01 Identity · API-11 Platform — the store-core services.

const NOW = '2026-08-07T12:00:00Z';

const move = (over: Partial<Movement> = {}): Movement => ({
  movementId: 'M-1', productId: 'P1', locationId: 'L1', kind: 'received',
  quantityMinor: 10, uom: 'each', occurredAt: NOW, enteredBy: 'u-warehouse', ...over,
});

describe('API-04 — movements are appended and balances are projected', () => {
  it('declares what each kind does rather than inferring it from a sign', () => {
    expect(EFFECT_ON_HAND.received).toBe(1);
    expect(EFFECT_ON_HAND.sold).toBe(-1);
    expect(EFFECT_ON_HAND.wasted).toBe(-1);
  });

  it('gives the same balance whatever order the movements arrive in', () => {
    // A handheld back from the chiller and a lane back from three days offline both send out of
    // order. A projection over an append-only set does not care, and that is asserted here.
    const ms: Movement[] = [
      move({ movementId: 'M-1', kind: 'received', quantityMinor: 100 }),
      move({ movementId: 'M-2', kind: 'sold', quantityMinor: 30 }),
      move({ movementId: 'M-3', kind: 'sold', quantityMinor: 20 }),
      move({ movementId: 'M-4', kind: 'returned', quantityMinor: 5 }),
    ];
    const forward = project(ms, NOW);
    const backward = project([...ms].reverse(), NOW);
    const shuffled = project([ms[2]!, ms[0]!, ms[3]!, ms[1]!], NOW);
    expect(forward[0]?.onHandMinor).toBe(55);
    expect(backward).toEqual(forward);
    expect(shuffled).toEqual(forward);
  });

  it('stamps every projection with when it was made (P-08)', () => {
    expect(project([move()], NOW)[0]?.asAt).toBe(NOW);
  });

  it('keeps locations apart', () => {
    const rows = project([
      move({ movementId: 'M-1', locationId: 'L1', quantityMinor: 10 }),
      move({ movementId: 'M-2', locationId: 'L2', quantityMinor: 4 }),
    ], NOW);
    expect(rows.map((r) => r.onHandMinor)).toEqual([10, 4]);
  });

  it('REFUSES a write-off nobody explained', () => {
    const r = checkMovement(move({ kind: 'wasted', approvedBy: 'u-manager' }));
    expect(r.refusedBecause).toBe('adjustment_without_a_reason');
    expect(r.detail).toContain('need telling apart at the year end');
  });

  it('REFUSES a write-off the same person entered and approved (§28)', () => {
    const r = checkMovement(move({
      kind: 'adjusted', reason: 'damaged in the chiller', enteredBy: 'u-a', approvedBy: 'u-a',
    }));
    expect(r.refusedBecause).toBe('adjustment_not_approved');
    expect(r.detail).toContain('makes a difference disappear');
  });

  it('REFUSES a signed quantity, because the kind carries the direction', () => {
    expect(checkMovement(move({ quantityMinor: -10 })).refusedBecause).toBe('quantity_not_positive');
    expect(checkMovement(move({ quantityMinor: 0 })).refusedBecause).toBe('quantity_not_positive');
  });

  it('accepts an ordinary receipt or sale without ceremony', () => {
    expect(checkMovement(move()).ok).toBe(true);
    expect(checkMovement(move({ kind: 'sold' })).ok).toBe(true);
  });

  it('REPORTS negative stock rather than blocking it', () => {
    // The shelf was already wrong before this service heard about it. Refusing the movement leaves
    // the ledger disagreeing with the aisle, and the aisle wins.
    const rows = project([
      move({ movementId: 'M-1', kind: 'received', quantityMinor: 5 }),
      move({ movementId: 'M-2', kind: 'sold', quantityMinor: 8 }),
    ], NOW);
    const neg = negativeStock(rows);
    expect(neg).toHaveLength(1);
    expect(neg[0]?.onHandMinor).toBe(-3);
    expect(neg[0]?.ownerAction).toContain('do not adjust it to zero, which hides whichever of those it was');
  });

  it('offers no way to update or delete a movement (hard rule #2)', async () => {
    const service = await import('../../services/inventory/src/index');
    for (const name of Object.keys(service)) {
      expect(name).not.toMatch(/updateMovement|deleteMovement|setOnHand|overrideStock/i);
    }
  });
});

describe('API-01 — identity resolves scope and holds no credential', () => {
  const ROLES: Role[] = [
    { id: 'cashier', name: 'Cashier', permissions: ['pos.sale.create'] },
    { id: 'admin', name: 'Administrator', permissions: ['pos.sale.create', 'identity.role.grant', 'platform.flag.write'] },
  ];

  const request = (over: Partial<GrantRequest> = {}): GrantRequest => ({
    grantId: 'G-1', userId: 'u-new', roleId: 'cashier', branchScope: ['b-main'],
    requestedBy: 'u-manager', approvedBy: 'u-owner', requestedAt: NOW, ...over,
  });

  it('grants a role when two different people asked and approved', () => {
    const r = grantRole({ request: request(), roles: ROLES, approverPermissions: ['pos.sale.create'] });
    expect(r.ok).toBe(true);
    expect(r.assignment?.userId).toBe('u-new');
  });

  it('REFUSES a role somebody requested for themselves', () => {
    const r = grantRole({
      request: request({ userId: 'u-manager' }), roles: ROLES, approverPermissions: ['pos.sale.create'],
    });
    expect(r.refusedBecause).toBe('granting_to_yourself');
    expect(r.detail).toContain('shortest path to every other control');
  });

  it('REFUSES a grant the requester approved', () => {
    const r = grantRole({
      request: request({ approvedBy: 'u-manager' }), roles: ROLES, approverPermissions: ['pos.sale.create'],
    });
    expect(r.refusedBecause).toBe('approved_by_the_requester');
    expect(r.detail).toContain('self-approval with an extra step');
  });

  it('REFUSES an approver handing out authority they do not hold themselves', () => {
    // Otherwise somebody who may approve access changes can create an administrator, and every
    // other limit on them is decorative.
    const r = grantRole({
      request: request({ roleId: 'admin' }), roles: ROLES, approverPermissions: ['pos.sale.create'],
    });
    expect(r.refusedBecause).toBe('escalates_beyond_the_approver');
    expect(r.detail).toContain('identity.role.grant');
    expect(r.detail).toContain('every other limit on them is decorative');
  });

  it('has nowhere to put a password (M02-FR-01, hard rule #4)', async () => {
    const service = await import('../../services/identity/src/index');
    for (const name of Object.keys(service)) {
      expect(name).not.toMatch(/password|passwd|credential|setSecret|enrolMfa|storeToken/i);
    }
    const source = await import('node:fs').then((fs) => fs.readFileSync(
      'services/identity/src/index.ts', 'utf8',
    ));
    expect(source).toContain('never stores a credential');
  });
});

describe('API-11 — health tells the truth, support access is bounded', () => {
  const probe = (over: Partial<DependencyProbe> = {}): DependencyProbe => ({
    name: 'postgres', criticality: 'shop_cannot_trade_without_it', reachable: true, ...over,
  });

  it('is healthy when everything answers', () => {
    const h = assessHealth([probe(), probe({ name: 'redis', criticality: 'degrades_service' })]);
    expect(h.state).toBe('healthy');
  });

  it('does NOT report healthy when it checked NOTHING', () => {
    // `filter` over an empty list finds nothing, and nothing found reads as nothing wrong: with no
    // probes at all this returned healthy — "all 0 dependencies reachable". A monitoring gap and a
    // working system are not the same state, and this module exists to say that the process being
    // alive is not the same as it working. Green-because-unchecked is that fault one level up.
    const h = assessHealth([]);
    expect(h.state).toBe('unknown');
    expect(h.state).not.toBe('healthy');
    expect(h.detail).toContain('it is an unmonitored one');
    // Not `unhealthy` either: that means the shop cannot trade and would trigger a failover for
    // what is a gap in monitoring.
    expect(h.state).not.toBe('unhealthy');
  });

  it('tripwire — one reachable dependency still reports healthy', () => {
    expect(assessHealth([probe()]).state).toBe('healthy');
  });

  it('does NOT report healthy just because the process is alive', () => {
    // The most common lie in operations: a check that stays green while the database is
    // unreachable and every request is failing.
    const h = assessHealth([probe({ reachable: false })]);
    expect(h.state).toBe('unhealthy');
    const alive: true = h.processAlive;
    expect(alive).toBe(true); // reported separately, so nothing can read one as the other
    expect(h.detail).toContain('the process is running and that is not the same as working');
  });

  it('separates degraded from unhealthy by what the shop needs', () => {
    expect(assessHealth([probe(), probe({ name: 'email', criticality: 'degrades_service', reachable: false })]).state)
      .toBe('degraded');
    expect(assessHealth([probe(), probe({ name: 'sitemap', criticality: 'background_only', reachable: false })]).state)
      .toBe('healthy');
  });

  const access = (over: Partial<SupportAccessRequest> = {}): SupportAccessRequest => ({
    requestId: 'A-1', tenantId: 't-other', requesterId: 'u-eng', requesterName: 'Eng',
    reason: 'investigating the duplicate settlement raised in ticket 4471',
    scopes: ['read:settlements'], at: NOW, minutes: 60, ...over,
  });

  const approval = (over: Partial<OwnerApproval> = {}): OwnerApproval => ({
    subjectRef: 'A-1', status: 'approved', decidedBy: 'u-lead', ...over,
  });

  it('grants time-bound access with an expiry', () => {
    const session = grantSupportAccess(access(), approval());
    expect(session.expiresAt).toBe('2026-08-07T13:00:00Z');
    expect(session.scopes).toEqual(['read:settlements']);
  });

  it('REFUSES a reason that says nothing', () => {
    expect(() => grantSupportAccess(access({ reason: 'investigate' }), approval()))
      .toThrow(/not a reason/);
  });

  it('REFUSES access an engineer approved for themselves', () => {
    expect(() => grantSupportAccess(access(), approval({ decidedBy: 'u-eng' })))
      .toThrow(/cannot approve their own/);
    expect(() => grantSupportAccess(access(), undefined)).toThrow(/has not approved/);
  });

  it('REFUSES access that outlives the problem', () => {
    expect(() => grantSupportAccess(access({ minutes: 10_000 }), approval()))
      .toThrow(/no perpetual support access/);
  });

  it('REFUSES blanket access — the rule the service’s own copy could not express', () => {
    // The copy wired to the API had no `scopes` field at all, so least privilege could not be
    // stated, let alone enforced.
    expect(() => grantSupportAccess(access({ scopes: [] }), approval()))
      .toThrow(/never blanket admin/);
  });

  it('REFUSES an approval that tries to LENGTHEN the requested window', () => {
    expect(() => grantSupportAccess(access({ minutes: 30 }), approval({ grantedMinutes: 240 })))
      .toThrow(/never extend it/);
  });
});

describe('all three register cleanly on the kernel', () => {
  const ACCESS = new AccessControl(
    [{
      id: 'all', name: 'All', permissions: [
        'inventory.movement.append', 'inventory.availability.read',
        'identity.self.read', 'identity.role.read', 'identity.role.grant', 'org.branch.read',
        'platform.health.read', 'platform.flag.read', 'platform.flag.write', 'platform.support.grant',
      ],
    }],
    [{ userId: 'u-1', roleId: 'all', branchScope: 'all' }],
  );

  const invDeps: InventoryDeps = {
    availability: () => project([move()], NOW), appendMovement: () => {}, isKnown: () => false, now: () => NOW,
  };
  const idDeps: IdentityDeps = {
    roles: () => [], permissionsOf: () => [], recordGrant: () => {}, branches: () => [], allocateNumber: () => Promise.resolve(1), now: () => NOW,
  };
  const platDeps: PlatformDeps = {
    probe: () => [{ name: 'postgres', criticality: 'shop_cannot_trade_without_it', reachable: true }],
    flags: () => ({}), setFlag: () => {}, recordSupportAccess: () => {},
    settings: inMemorySettings(), now: () => NOW,
  };

  const all = [...inventoryRoutes(invDeps), ...identityRoutes(idDeps), ...platformRoutes(platDeps)];

  it('passes every kernel registration rule', () => {
    const built = buildRouter(all);
    expect(built.refusals.map((r) => r.detail)).toEqual([]);
    expect(built.ok).toBe(true);
  });

  it('declares a permission on every single route', () => {
    for (const r of buildRouter(all).router!.list()) {
      expect(r.permission.length, `${r.method} ${r.path}`).toBeGreaterThan(0);
    }
  });

  it('answers 503 when the shop cannot trade, and says why', async () => {
    const built = buildRouter(platformRoutes({
      ...platDeps,
      probe: () => [{ name: 'postgres', criticality: 'shop_cannot_trade_without_it', reachable: false }],
    }));
    const res = await handle({
      router: built.router!,
      authenticate: () => ({ tenantId: 't-sre', userId: 'u-1', branchId: null }),
      access: ACCESS, idempotency: new MemoryIdempotencyStore(), newTraceId: () => 'trace-1',
    }, { method: 'GET', path: '/v1/platform/health', headers: { authorization: 'Bearer good' } });

    expect(res.status).toBe(503);
    expect((res.body as { state: string }).state).toBe('unhealthy');
  });
});
