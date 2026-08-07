// Tenant export, closure and upgrade compatibility (M36-FR-03 / OD-09 / P-06 / #6, #7).
//
// This module exists to answer one question honestly: **what happens when a customer wants to
// leave?**
//
// Every vendor says the data belongs to the customer. The test of it is what the export
// actually contains and how hard it is to get. An "export" that produces PDFs of screens, or
// omits the join tables, or takes six weeks and a support ticket, is a hostage arrangement
// with a friendly name — and a retailer who discovers that at the point of leaving tells every
// other retailer they know.
//
//   • **A TENANT'S EXPORT IS COMPLETE OR IT IS NOT AN EXPORT.** The completeness check runs
//     against the declared domain list, and a missing domain **fails** the export rather than
//     producing a smaller file. Half a dataset handed over as "your data" is worse than a
//     refusal, because the customer finds out months later.
//   • **CLOSURE IS BLOCKED WHILE THE LAW STILL WANTS THE RECORDS.** Indian tax retention
//     outlives the commercial relationship. Deleting on request would make a customer's exit
//     into our statutory problem.
//   • **AUDIT EVIDENCE SURVIVES CLOSURE** (hard rule #6). Everything else can go; the record
//     of who did what cannot.
//   • **AN UPGRADE THAT BREAKS A LIVE TENANT IS NOT AN UPGRADE.** Compatibility is asserted
//     against the contracts in use, and a breaking change needs a deprecation window that has
//     actually elapsed — not one that was announced.
//
// Pure and deterministic: the clock is injected, no I/O.

export type TenantLifecycleState = 'provisioning' | 'active' | 'suspended' | 'closing' | 'closed';

export interface ExportDomain {
  readonly domain: string;
  readonly rows: number;
  /** Portable format actually produced. */
  readonly format: 'csv' | 'jsonl' | 'sql';
  readonly checksum: string;
  readonly bytes: number;
}

export type ExportOutcome = 'complete' | 'missing_domains' | 'empty_domain' | 'no_manifest' | 'wrong_tenant';

export interface TenantExport {
  readonly exportId: string;
  readonly tenantId: string;
  readonly requestedBy: string;
  readonly at: string;
  readonly outcome: ExportOutcome;
  readonly complete: boolean;
  readonly domains: readonly ExportDomain[];
  readonly missing: readonly string[];
  readonly totalRows: number;
  readonly totalBytes: number;
  readonly detail: string;
}

/**
 * Produce a tenant's export **and refuse to call it complete when it is not**.
 *
 * The check is against the platform's own declared domain list, so adding a domain to the
 * product without adding it to the exporter turns every subsequent export into a **failure**
 * rather than a quietly smaller file. That is the intended pressure: the exporter is not
 * allowed to fall behind the product.
 *
 * A domain that legitimately has no rows must still be **present** in the manifest, listed
 * with zero — absence and emptiness are different facts, and only one of them is reassuring.
 */
export function buildTenantExport(input: {
  readonly exportId: string;
  readonly tenantId: string;
  readonly requestedBy: string;
  readonly domains: readonly (ExportDomain & { readonly tenantId?: string })[];
  /** Every domain the platform holds tenant data in. */
  readonly declaredDomains: readonly string[];
  readonly at: string;
}): TenantExport {
  const base = {
    exportId: input.exportId,
    tenantId: input.tenantId,
    requestedBy: input.requestedBy,
    at: input.at,
    totalRows: input.domains.reduce((s, d) => s + d.rows, 0),
    totalBytes: input.domains.reduce((s, d) => s + d.bytes, 0),
  };

  const foreign = input.domains.filter((d) => d.tenantId !== undefined && d.tenantId !== input.tenantId);
  if (foreign.length > 0) {
    return {
      ...base,
      outcome: 'wrong_tenant',
      complete: false,
      domains: [],
      missing: [],
      totalRows: 0,
      totalBytes: 0,
      detail: `${foreign.length} domain file(s) contain another tenant's data — the export is refused entirely rather than shipped with a note`,
    };
  }

  if (input.declaredDomains.length === 0) {
    return {
      ...base,
      outcome: 'no_manifest',
      complete: false,
      domains: input.domains,
      missing: [],
      detail: 'there is no declared domain list to check completeness against, so this cannot be called a complete export',
    };
  }

  const present = new Set(input.domains.map((d) => d.domain));
  const missing = input.declaredDomains.filter((d) => !present.has(d)).sort();

  if (missing.length > 0) {
    return {
      ...base,
      outcome: 'missing_domains',
      complete: false,
      domains: input.domains,
      missing,
      detail: `${missing.length} domain(s) are absent from the export: ${missing.join(', ')}. Half a dataset handed over as "your data" is worse than a refusal — the customer finds out months later`,
    };
  }

  const unchecksummed = input.domains.filter((d) => d.checksum.trim() === '');
  if (unchecksummed.length > 0) {
    return {
      ...base,
      outcome: 'empty_domain',
      complete: false,
      domains: input.domains,
      missing: unchecksummed.map((d) => d.domain).sort(),
      detail: `${unchecksummed.length} domain file(s) have no checksum — an export nobody can verify is a file, not evidence`,
    };
  }

  return {
    ...base,
    outcome: 'complete',
    complete: true,
    domains: [...input.domains].sort((a, b) => a.domain.localeCompare(b.domain)),
    missing: [],
    detail: `${base.totalRows} row(s) across all ${input.declaredDomains.length} domain(s), each checksummed and in a portable format`,
  };
}

export interface RetentionObligation {
  readonly obligationId: string;
  readonly tenantId: string;
  readonly what: string;
  /** The statute or contract requiring it, named. */
  readonly law: string;
  /** Inclusive date until which the records must be kept, YYYY-MM-DD. */
  readonly keepUntil: string;
}

export type ClosureOutcome =
  | 'closed'
  | 'obligations_outstanding'
  | 'export_not_taken'
  | 'not_approved'
  | 'already_closed';

export interface ClosureResult {
  readonly tenantId: string;
  readonly closed: boolean;
  readonly outcome: ClosureOutcome;
  /** What is retained despite closure, and why. */
  readonly retained: readonly { readonly what: string; readonly law: string; readonly untilDate: string }[];
  /** What access is revoked immediately on closure. */
  readonly accessRevoked: boolean;
  readonly detail: string;
}

/**
 * Close a tenant.
 *
 * Access is revoked **immediately**; deletion is not the same event and mostly does not happen
 * at all, because Indian tax retention outlives the commercial relationship. Honouring a
 * "delete everything" request over a statutory obligation converts a customer's exit into our
 * statutory problem.
 *
 * Closure is refused while the tenant has not taken its export. That is not a lock-in tactic
 * — it is the last moment at which taking it is still easy, and a retailer who closes and
 * then asks for their data three weeks later is a conversation nobody wants to have.
 *
 * **Audit evidence is never in scope for deletion** (hard rule #6), whatever anybody asks.
 */
export function closeTenant(input: {
  readonly tenantId: string;
  readonly state: TenantLifecycleState;
  readonly obligations: readonly RetentionObligation[];
  readonly exportTaken?: TenantExport;
  readonly approvedBy?: string;
  readonly today: string;
}): ClosureResult {
  const live = input.obligations
    .filter((o) => o.tenantId === input.tenantId && o.keepUntil >= input.today)
    .sort((a, b) => b.keepUntil.localeCompare(a.keepUntil));

  const retained = [
    ...live.map((o) => ({ what: o.what, law: o.law, untilDate: o.keepUntil })),
    // Not negotiable, not listed as an obligation, and never deleted.
    { what: 'audit evidence', law: 'hard rule #6 — audit evidence is never deleted', untilDate: 'indefinitely' },
  ];

  const base = { tenantId: input.tenantId, retained };

  if (input.state === 'closed') {
    return { ...base, closed: true, outcome: 'already_closed', accessRevoked: true, detail: 'this tenant is already closed' };
  }
  if (input.approvedBy === undefined || input.approvedBy.trim() === '') {
    return {
      ...base,
      closed: false,
      outcome: 'not_approved',
      accessRevoked: false,
      detail: 'closing a tenant ends a business relationship and needs a named approver (§28)',
    };
  }
  if (input.exportTaken === undefined || !input.exportTaken.complete) {
    return {
      ...base,
      closed: false,
      outcome: 'export_not_taken',
      accessRevoked: false,
      detail: 'this tenant has not taken a complete export — closing now is the last easy moment to get their data, and three weeks later it is a conversation nobody wants',
    };
  }

  return {
    ...base,
    closed: true,
    outcome: 'closed',
    accessRevoked: true,
    detail:
      live.length === 0
        ? 'access revoked; audit evidence retained indefinitely (#6) and nothing else is legally required'
        : `access revoked; ${live.length} record set(s) RETAINED because the law still wants them — longest until ${live[0]!.keepUntil} under ${live[0]!.law} — plus audit evidence indefinitely (#6)`,
  };
}

export type CompatibilityVerdict = 'compatible' | 'additive' | 'breaking' | 'deprecation_pending';

export interface ContractChange {
  readonly contract: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  /** Fields or endpoints removed or narrowed. Any entry here makes it breaking. */
  readonly removed: readonly string[];
  /** Fields or endpoints added. Additive on its own. */
  readonly added: readonly string[];
  /** A previously optional field made required — breaking for existing callers. */
  readonly nowRequired?: readonly string[];
  /** When the removal was announced, if it was. */
  readonly deprecatedOn?: string;
}

export interface CompatibilityResult {
  readonly contract: string;
  readonly verdict: CompatibilityVerdict;
  readonly safeToDeploy: boolean;
  /** Tenants currently calling the removed surface. Named, not counted. */
  readonly tenantsAffected: readonly string[];
  readonly detail: string;
}

/**
 * Decide whether a contract change can be deployed to live tenants.
 *
 * **A breaking change with an announced-but-unelapsed deprecation window is still breaking.**
 * The announcement is not the mitigation; the elapsed time is, and only if somebody checked
 * who is still calling the old surface. This function checks — by name, not by count, because
 * "3 tenants affected" gets deployed on a Friday and "Sri Lakshmi Stores and two others" does
 * not.
 *
 * Making an optional field required is breaking. It looks additive on a diff and it is the
 * change that most often takes a partner integration down.
 */
export function assessCompatibility(input: {
  readonly change: ContractChange;
  /** Which tenants are calling which fields/endpoints of this contract today. */
  readonly liveUsage: readonly { readonly tenantId: string; readonly uses: readonly string[] }[];
  /** Days a deprecation must have run before removal. Default 180. */
  readonly deprecationDays?: number;
  readonly today: string;
}): CompatibilityResult {
  const days = input.deprecationDays ?? 180;
  const breakingSurface = [...input.change.removed, ...(input.change.nowRequired ?? [])];

  const tenantsAffected = input.liveUsage
    .filter((u) => u.uses.some((s) => breakingSurface.includes(s)))
    .map((u) => u.tenantId)
    .sort();

  if (breakingSurface.length === 0) {
    return {
      contract: input.change.contract,
      verdict: input.change.added.length > 0 ? 'additive' : 'compatible',
      safeToDeploy: true,
      tenantsAffected: [],
      detail:
        input.change.added.length > 0
          ? `${input.change.added.length} addition(s) and nothing removed — existing callers are unaffected`
          : 'no surface change',
    };
  }

  if (input.change.deprecatedOn === undefined) {
    return {
      contract: input.change.contract,
      verdict: 'breaking',
      safeToDeploy: false,
      tenantsAffected,
      detail: `${breakingSurface.join(', ')} would be removed or made required with NO deprecation announced${tenantsAffected.length === 0 ? '' : `, and ${tenantsAffected.join(', ')} still call it`}`,
    };
  }

  const elapsed = Math.floor(
    (Date.parse(`${input.today}T00:00:00Z`) - Date.parse(`${input.change.deprecatedOn}T00:00:00Z`)) / 86_400_000,
  );

  if (elapsed < days) {
    return {
      contract: input.change.contract,
      verdict: 'deprecation_pending',
      safeToDeploy: false,
      tenantsAffected,
      detail: `deprecated ${elapsed} day(s) ago against a ${days}-day window — the announcement is not the mitigation, the elapsed time is`,
    };
  }

  if (tenantsAffected.length > 0) {
    return {
      contract: input.change.contract,
      verdict: 'breaking',
      safeToDeploy: false,
      tenantsAffected,
      detail: `the window has elapsed, but ${tenantsAffected.join(', ')} are STILL calling ${breakingSurface.join(', ')} — deploying this takes their integration down today`,
    };
  }

  return {
    contract: input.change.contract,
    verdict: 'compatible',
    safeToDeploy: true,
    tenantsAffected: [],
    detail: `deprecated ${elapsed} day(s) ago and nobody is still calling ${breakingSurface.join(', ')}`,
  };
}
