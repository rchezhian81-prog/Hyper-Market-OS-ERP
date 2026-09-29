// A SECOND, REAL tenant beside the demo — the guards, pure (STEP-1-REAL-DATA-PLAN §4 item 3).
//
// Until now a tenant came into being one way: `BOOTSTRAP_OWNER_TENANT_ID` / `BOOTSTRAP_OWNER_USER_ID` at
// boot, naming ONE tenant, which on the hosted demo is the demo tenant. Real data needs its own tenant,
// created on purpose, by a named person, with an initial admin set that can then run maker-checker
// (§28) between themselves. This module decides whether such a bootstrap may happen; the script that
// writes the events (`scripts/bootstrap-tenant.ts`) does only what a plan from here says.
//
// Refused, by name: a production target (hard rule #7), a tenant id that is not a UUID (the ledger
// declares `tenant_id uuid NOT NULL` — the 28 Sep stand-up found this the hard way), a demo tenant
// (gate G4), no owner in the set, a role the catalogue does not know, the same person twice, no operator.

import { assertNonProduction, type TargetKind } from './trial';

export interface InitialAdminRequest {
  readonly userId: string;
  readonly roleId: string;
}

export interface TenantBootstrapRequest {
  readonly tenantId: string;
  /** The first owner — recorded first, exactly as the boot-time genesis path records it. */
  readonly owner: string;
  /** The rest of the initial admin set (a chartered accountant, a second owner…). May be empty. */
  readonly admins: readonly InitialAdminRequest[];
  /** `MIGRATION_TARGET_KIND` as the box has it. Unset means the API's own default, rehearsal. */
  readonly targetKind: string | undefined;
  readonly demoTenantIds: readonly string[];
  /** Role ids the API's catalogue knows — an unknown role would grant nothing and mislead everyone. */
  readonly knownRoleIds: readonly string[];
  /** The named human running the bootstrap. */
  readonly operator: string;
  readonly ownerRoleId: string;
}

export type BootstrapRefusal =
  | 'production_target'
  | 'unknown_target_kind'
  | 'not_a_uuid'
  | 'demo_tenant'
  | 'no_owner'
  | 'no_operator'
  | 'unknown_role'
  | 'duplicate_admin';

export interface TenantBootstrapPlanOk {
  readonly ok: true;
  readonly tenantId: string;
  /** Owner first; the order the events are appended in. */
  readonly admins: readonly InitialAdminRequest[];
  readonly operator: string;
}

export interface TenantBootstrapRefused {
  readonly ok: false;
  readonly refusedBecause: BootstrapRefusal;
  readonly detail: string;
}

export type TenantBootstrapPlan = TenantBootstrapPlanOk | TenantBootstrapRefused;

const TARGET_KINDS: readonly TargetKind[] = ['rehearsal', 'staging', 'local', 'production'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isTenantUuid = (s: string): boolean => UUID.test(s);

export function planTenantBootstrap(req: TenantBootstrapRequest): TenantBootstrapPlan {
  const refuse = (refusedBecause: BootstrapRefusal, detail: string): TenantBootstrapRefused => ({ ok: false, refusedBecause, detail });

  const kind = req.targetKind ?? 'rehearsal';
  if (!(TARGET_KINDS as readonly string[]).includes(kind)) {
    return refuse('unknown_target_kind', `MIGRATION_TARGET_KIND is "${kind}" — not one of ${TARGET_KINDS.join(', ')}; a box whose kind cannot be read is not one to create tenants on`);
  }
  const assertion = assertNonProduction({ targetId: 'bootstrap', tenantId: req.tenantId, kind: kind as TargetKind, label: 'tenant bootstrap' });
  if (!assertion.permitted) return refuse('production_target', assertion.detail);
  if (!isTenantUuid(req.tenantId)) {
    return refuse('not_a_uuid', `tenant id "${req.tenantId}" is not a UUID — the ledger stores tenant_id as uuid, so a readable label cannot be written to it (the demo's "pilot-demo" label had to become a fixed UUID for this reason)`);
  }
  if (req.demoTenantIds.includes(req.tenantId)) {
    return refuse('demo_tenant', `tenant "${req.tenantId}" is the demo tenant — real people and real data never go into it (pilot gate G4)`);
  }
  if (req.owner.trim() === '') return refuse('no_owner', 'a tenant needs its first owner named — without one nobody can grant anything, ever');
  if (req.operator.trim() === '') return refuse('no_operator', 'a bootstrap with nobody\'s name on it cannot be questioned later');
  const admins: InitialAdminRequest[] = [{ userId: req.owner.trim(), roleId: req.ownerRoleId }, ...req.admins.map((a) => ({ userId: a.userId.trim(), roleId: a.roleId.trim() }))];
  const seen = new Set<string>();
  for (const a of admins) {
    if (a.userId === '' || a.roleId === '') return refuse('unknown_role', 'every admin needs a user id and a role id');
    if (!req.knownRoleIds.includes(a.roleId)) return refuse('unknown_role', `role "${a.roleId}" is not in the role catalogue — a grant of it would give ${a.userId} nothing while looking like access`);
    const key = `${a.userId}|${a.roleId}`;
    if (seen.has(key)) return refuse('duplicate_admin', `${a.userId} is listed twice as ${a.roleId}`);
    seen.add(key);
  }
  return { ok: true, tenantId: req.tenantId, admins, operator: req.operator.trim() };
}
