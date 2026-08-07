import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildRouter } from '../../services/kernel/src/index';
import { buildSurface } from '../../services/api/src/main';
import { isPermission } from '../../packages/rbac/src/rbac';
import { ROLE_CATALOGUE } from '../../services/api/src/roles';

// API surface contract (Phase 2, §30 / SEC-03 / P-06). The router enforces versioned paths, a
// declared permission, write-idempotency and uniqueness AT REGISTRATION. This locks the WHOLE live
// surface and adds two checks the router does not make:
//   • every permission a route requires is a well-formed permission code (the router only checks it
//     is non-empty — a malformed code would register and then never match a grant);
//   • every permission a route requires is GRANTABLE by some role in the catalogue — a permission no
//     role can hold is an endpoint that returns 403 for everyone, i.e. a dead route (now that
//     authorization is really enforced, this is the difference between "shipped" and "reachable").

const ROUTES = (() => {
  const built = buildRouter(buildSurface({ signingKey: 'x'.repeat(32), migrationTargetKind: 'rehearsal' }));
  if (!built.ok) throw new Error(`surface malformed: ${built.refusals.map((r) => r.detail).join('; ')}`);
  return built.router!.list();
})();

const GRANTABLE = new Set(ROLE_CATALOGUE.flatMap((r) => r.permissions));
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const API_ID = /^API-(?:0[1-9]|1[0-3])$/;

describe('the live API surface conforms to its contract (§30)', () => {
  it('registers a non-empty surface', () => {
    expect(ROUTES.length).toBeGreaterThan(0);
  });

  it('every route declares a valid api id, method, versioned path and permission', () => {
    const bad = ROUTES.filter((r) =>
      !API_ID.test(r.api) || !METHODS.has(r.method) || !r.path.startsWith('/v1/') || !isPermission(r.permission));
    expect(bad.map((r) => `${r.method} ${r.path} [${r.api} · ${r.permission}]`)).toEqual([]);
  });

  it('has no two routes for one address', () => {
    const seen = new Map<string, number>();
    for (const r of ROUTES) {
      const key = `${r.method} ${r.path}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    expect([...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k)).toEqual([]);
  });

  it('every permission a route requires is GRANTABLE by some role — no dead, unreachable endpoint', () => {
    const unreachable = ROUTES
      .filter((r) => !GRANTABLE.has(r.permission))
      .map((r) => `${r.method} ${r.path} needs "${r.permission}", which no role in ROLE_CATALOGUE grants`);
    expect(unreachable).toEqual([]);
  });
});

const CATALOGUE = readFileSync(join(new URL('../../', import.meta.url).pathname, 'docs/api/catalogue.md'), 'utf8');

describe('every API domain on the surface has a documented home (docs/api/catalogue.md)', () => {
  it('names every API-NN that the surface actually serves', () => {
    const served = [...new Set(ROUTES.map((r) => r.api))].sort();
    const undocumented = served.filter((api) => !CATALOGUE.includes(api));
    expect(undocumented).toEqual([]);
  });
});
