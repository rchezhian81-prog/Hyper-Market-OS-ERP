// Guardrail — CR-01 OI-12 step 6b · OB-760 A · P-04 least privilege · P-05 · hard rules 4, 5: the rule that places an approved
// act is a DEDICATED NON-HUMAN identity holding ONLY the permissions of the three ordinary routes it places through.
//
//   1. `rule:auto-approve` holds exactly the permissions of its routes (purchase order raise + issue, price change, transfer
//      raise) as the REAL surface declares them — never a refund, payment, privilege, identity or any other permission.
//   2. It may call only those routes, and the placer names no other path.
//   3. It is not on the role catalogue (so no person can ever be given it on Users & roles), and nothing grants it a role.
//   4. Its widened authority and shop-wide scope exist only INSIDE a placement the placer started — never read from a request.
//   5. The placer lives in the composition layer (services/api), never in services/ai; the assistants' act builders write
//      nothing (hard rule 5: the assistant drafts, a rule or a person decides, the ordinary route does the act).
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildSurface } from '../../services/api/src/main';
import { ROLE_CATALOGUE } from '../../services/api/src/roles';
import { AUTO_APPROVE_RULE_ROLE, RULE_ROUTES, RULE_IDENTITY } from '../../services/api/src/ai-auto-approve-executor';

const PACK_KEY = ['sre', 'local', 'test', 'pack', 'signing', 'key'].join('-').padEnd(48, '0');
const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const FORBIDDEN = /refund|payment|payout|tender|privilege|identity|role|grant|permission|approval\.decide|payroll|journal|write.?off|credential|secret|ai\./i;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

describe('guardrail: the auto-approve rule holds only the permissions of its three routes (CR-01 OI-12 step 6b)', () => {
  it('its permissions are exactly those the real surface declares on its routes — and none is a money-out, privilege or AI one', () => {
    const surface = buildSurface({ signingKey: PACK_KEY, migrationTargetKind: 'rehearsal' });
    const needed = RULE_ROUTES.map((r) => {
      const route = surface.find((x) => x.method === r.method && x.path === r.path);
      expect(route, `${r.method} ${r.path} is on the surface`).toBeDefined();
      expect(route!.reauth, `${r.path} needs no fresh sign-in`).toBeUndefined();
      return route!.permission as string;
    });
    expect([...AUTO_APPROVE_RULE_ROLE.permissions].sort()).toEqual([...new Set(needed)].sort());
    expect(AUTO_APPROVE_RULE_ROLE.permissions).toHaveLength(4);
    for (const p of AUTO_APPROVE_RULE_ROLE.permissions) expect(p, p).not.toMatch(FORBIDDEN);
    expect(Object.isFrozen(AUTO_APPROVE_RULE_ROLE) && Object.isFrozen(AUTO_APPROVE_RULE_ROLE.permissions) && Object.isFrozen(RULE_ROUTES)).toBe(true);
  });

  it('it may call only its routes, and the placer names no other path', () => {
    expect(RULE_ROUTES.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /v1/purchase/orders/:poId', 'POST /v1/purchase/orders/:poId/approval', 'POST /v1/prices/changes', 'POST /v1/warehouse/transfers/:transferId',
    ]);
    const src = read('services/api/src/ai-auto-approve-executor.ts');
    const called = [...src.matchAll(/await call\(deps, tenantId, 'POST', '([^']+)'/g)].map((m) => m[1]!);
    expect(called.length).toBeGreaterThan(0);
    for (const path of called) expect(RULE_ROUTES.map((r) => r.path), path).toContain(path);
  });

  it('it is not on the role catalogue, and nothing anywhere grants a role to a rule identity', () => {
    expect(ROLE_CATALOGUE.map((r) => r.id)).not.toContain(AUTO_APPROVE_RULE_ROLE.id);
    for (const r of ROLE_CATALOGUE) expect(r.permissions.length === 0 || r.id !== AUTO_APPROVE_RULE_ROLE.id).toBe(true);
    const offenders: string[] = [];
    for (const dir of ['packages', 'services', 'apps', 'edge', 'db', 'scripts']) {
      for (const f of sources(dir)) {
        const s = readFileSync(f, 'utf8');
        if (/(?:provisionRole|grantRole|RoleGranted)[^\n]*['"`]rule:/.test(s) || /userId:\s*['"`]rule:[^'"`]*['"`][^\n]*roleId/.test(s)) offenders.push(f);
      }
    }
    expect(offenders).toEqual([]);
    expect(RULE_IDENTITY).toBe('rule:auto-approve');
  });

  it('its authority and its shop-wide reach exist only inside a placement, never read from a request', () => {
    const src = read('services/api/src/ai-auto-approve-executor.ts');
    for (const fn of ['export function ruleAwareAuthority', 'export function isTheRulePlacing']) {
      const start = src.indexOf(fn);
      expect(start, fn).toBeGreaterThan(0);
      const body = src.slice(start, src.indexOf('\n}\n', start));
      expect(body, fn).toMatch(/acting\.getStore\(\)/);
      expect(body, fn).not.toMatch(/\.body\b|headers|query|params|startsWith\('rule:'\)/);
    }
    // The only place the scope checks widen for the rule is through that same test.
    expect(read('services/api/src/fg4-buying-adapters.ts')).toMatch(/isTheRulePlacing\(tenantId, userId\) \? 'all'/);
  });

  it('the placer lives in services/api, never in services/ai; the act builders write nothing', () => {
    for (const f of readdirSync(new URL('../../services/ai/src/', import.meta.url))) {
      const s = readFileSync(new URL(`../../services/ai/src/${f}`, import.meta.url), 'utf8');
      expect(s, f).not.toMatch(/ai-auto-approve-executor|ai-auto-approve-acts/);
    }
    const acts = read('services/api/src/ai-auto-approve-acts.ts');
    expect(acts).not.toMatch(/\.\s*(?:append|appendBatch|record[A-Z]\w*)\s*\(|\bmakeEvent\s*\(|\bfetch\s*\(|\.handler\s*\(/);
  });

  it('the tripwire fires on a known-bad permission', () => {
    for (const bad of ['refund.issue', 'payment.payout', 'identity.role.grant', 'ai.autoapprove.confirm', 'finance.journal.post']) expect(bad).toMatch(FORBIDDEN);
    for (const good of AUTO_APPROVE_RULE_ROLE.permissions) expect(good).not.toMatch(FORBIDDEN);
  });
});
