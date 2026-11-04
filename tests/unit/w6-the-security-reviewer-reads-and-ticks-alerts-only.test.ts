import { describe, it, expect } from 'vitest';
import { buildRouter } from '../../services/kernel/src/index';
import { buildSurface } from '../../services/api/src/main';
import { ROLE_CATALOGUE, SECURITY_REVIEWER_ROLE_ID } from '../../services/api/src/roles';

// OB-690 (owner, 4 Nov 2026): the Security reviewer (the IT custodian, OB-405/OB-406) reads the Operational alerts page and
// its alert inbox and ticks an alert as seen — and never raises, escalates or re-owns an alert, opens an incident or changes
// an alert rule. Ticking is its own narrow permission, which every role that could tick before still holds.
const ROUTES = (() => {
  const built = buildRouter(buildSurface({ signingKey: 'x'.repeat(32), migrationTargetKind: 'rehearsal' }));
  if (!built.ok) throw new Error('surface malformed');
  return built.router!.list();
})();
const role = (id: string) => ROLE_CATALOGUE.find((r) => r.id === id)!;
const routesFor = (permission: string) => ROUTES.filter((r) => r.permission === permission).map((r) => `${r.method} ${r.path}`);

describe('OB-690 · the security reviewer reads alerts and ticks them as seen, nothing more', () => {
  it('ticking an alert as seen is its own permission, and only that route needs it', () => {
    expect(routesFor('platform.alert.acknowledge')).toEqual(['POST /v1/platform/alerts/:alertId/acknowledge']);
    expect(routesFor('platform.alert.manage')).not.toContain('POST /v1/platform/alerts/:alertId/acknowledge');
  });

  it('every role that could tick before still can', () => {
    for (const r of ROLE_CATALOGUE.filter((x) => x.permissions.includes('platform.alert.manage'))) {
      expect(r.permissions, r.id).toContain('platform.alert.acknowledge');
    }
  });

  it('the reviewer holds the read and the tick, and none of raising, escalating, incidents or rules', () => {
    const p = role(SECURITY_REVIEWER_ROLE_ID).permissions;
    expect(p).toEqual(expect.arrayContaining(['platform.health.read', 'platform.alert.acknowledge']));
    expect(p).not.toContain('platform.alert.manage');
    for (const route of routesFor('platform.alert.manage')) expect(route).not.toMatch(/acknowledge$/);
    // Only reads come with platform.health.read — the reviewer gains no write through it.
    expect(ROUTES.filter((r) => r.permission === 'platform.health.read' && r.method !== 'GET').map((r) => r.path).every((path) => !/alert-rules|escalate|raise|incidents/.test(path))).toBe(true);
    // Still a business role (OB-95): no grant, device, flag or setup code.
    expect(p.filter((x) => /^(identity\.role\.|platform\.(device|flag|setup|entitlement)\.)/.test(x))).toEqual([]);
  });
});
