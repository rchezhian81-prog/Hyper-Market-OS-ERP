import { describe, it, expect } from 'vitest';
import { loadCodeEntries } from './lib/scan.js';

// CR-01 step 4c-1 · ADR-0034 decision 2: once two people change what a role may do (OB-730 "A"), EVERY access decision must
// read the shop's adjusted roles (`effectiveRoleCatalogue`, or a function that applies the adjustments on top of the built-in
// list it is given). A place that still reads the built-in `ROLE_CATALOGUE` directly would silently keep the old rule —
// a permission switched off would still work there. So every remaining read is listed here, with why it is safe; a new
// one fails this test until it is moved to the adjusted roles or listed with a reason.

const ALLOWED: readonly { readonly file: string; readonly line: string; readonly why: string }[] = [
  // The fold itself, and the built-in list the routes judge "what is locked" on.
  { file: 'services/api/src/adapters.ts', line: 'return applyRoleAdjustments(ROLE_CATALOGUE, await roleAdjustmentsOf(store, tenantId));', why: 'the fold: the built-in roles are the starting point' },
  { file: 'services/api/src/role-adjustment-adapters.ts', line: 'builtInRoles: ROLE_CATALOGUE,', why: 'what is locked is judged on the built-in roles (OB-741: the owner\'s reserved list cannot drift)' },
  // Passed as the BUILT-IN list to functions that apply the shop's adjustments on top, every call.
  { file: 'services/api/src/main.ts', line: 'identityAdapter({ store, now, roleCatalogue: ROLE_CATALOGUE,', why: 'identityAdapter applies the adjustments (roles, permissionsOf)' },
  { file: 'services/api/src/main.ts', line: 'accessLifecycleAdapter({ store, now, roleCatalogue: ROLE_CATALOGUE })', why: 'accessLifecycleAdapter applies the adjustments' },
  { file: 'services/api/src/main.ts', line: 'tenantAccessResolver(store, ROLE_CATALOGUE)', why: 'the kernel\'s resolver applies the adjustments on every request' },
  // Ids and names only — a change never adds, removes or renames a role.
  { file: 'services/api/src/main.ts', line: 'roleIds: ROLE_CATALOGUE.map((r) => r.id),', why: 'role ids only' },
  { file: 'services/api/src/p1-identity-adapters.ts', line: 'roleIds: () => ROLE_CATALOGUE.map((r) => r.id),', why: 'role ids only' },
  { file: 'services/api/src/w2-assigned-work.ts', line: 'const role = ROLE_CATALOGUE.find((r) => r.id === roleId)?.name ?? roleId;', why: 'a role\'s name in a refusal' },
  { file: 'services/api/src/w2-movement-jobs.ts', line: 'const names = reach.roles.map((r) => ROLE_CATALOGUE.find((x) => x.id === r)?.name ?? r)', why: 'role names in a refusal' },
  // Whether a role is the IT function: a change that would flip it is refused (ADR-0034 4e), so the built-in answer stands.
  { file: 'services/api/src/p1-identity-adapters.ts', line: 'isItRole: (roleId) => { const r = ROLE_CATALOGUE.find((x) => x.id === roleId);', why: 'IT or business never changes by an adjustment' },
  // The first owner laid down at setup — before any person exists to change a role.
  { file: 'services/api/src/access.ts', line: 'const both = dutiesSetRefusal(admins.filter((a) => a.userId === who).map((a) => a.roleId), ROLE_CATALOGUE);', why: 'bootstrap, before any adjustment can exist' },
  // OB-676's starting suggestion of the roles a delivery-exception queue may name. Narrower is safe: the work itself is
  // judged on the adjusted roles by the kernel; a role given the permission later is simply not suggested.
  { file: 'services/api/src/ob676-settings-adapters.ts', line: "ROLE_CATALOGUE.filter((r) => r.permissions.includes('order.exception.work'))", why: 'a starting suggestion; the work is judged on the adjusted roles' },
];

const reads = (): { file: string; line: string }[] => loadCodeEntries(['services', 'edge', 'apps', 'packages'])
  .filter((e) => !e.file.endsWith('services/api/src/roles.ts'))
  .flatMap((e) => e.content.split('\n').map((line) => ({ file: e.file, line: line.trim() })))
  .filter((x) => /\bROLE_CATALOGUE\b/.test(x.line) && !x.line.startsWith('import ') && !x.line.startsWith('//') && !x.line.startsWith('*'));

describe('CR-01 step 4c-1: every access decision reads the shop\'s adjusted roles (ADR-0034)', () => {
  it('reads the built-in role list only where it is listed here, with a reason', () => {
    const unexplained = reads().filter((r) => !ALLOWED.some((a) => r.file.endsWith(a.file) && r.line.includes(a.line)));
    expect(unexplained).toEqual([]);
  });

  it('every listed exception still exists (a stale entry would hide a new read)', () => {
    const all = reads();
    const stale = ALLOWED.filter((a) => !all.some((r) => r.file.endsWith(a.file) && r.line.includes(a.line)));
    expect(stale).toEqual([]);
  });

  it('would FIRE on a new direct read (tripwire)', () => {
    const sample = { file: 'services/api/src/new-thing.ts', line: "return ROLE_CATALOGUE.some((r) => r.permissions.includes('pos.return.approve'));" };
    expect(ALLOWED.some((a) => sample.file.endsWith(a.file) && sample.line.includes(a.line))).toBe(false);
  });
});
