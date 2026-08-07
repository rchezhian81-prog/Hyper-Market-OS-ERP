// Partner and developer ecosystem (M36-FR-04 / M32 / P-06 / hard rule #7).
//
// A partner ecosystem is how a product like this reaches shops we will never visit. It is
// also how a product like this loses its first customer's data, and the two facts are the
// same fact: **an ecosystem is a set of people we do not employ, holding credentials to
// systems we are responsible for.**
//
// So the rules here are narrower than they look:
//
//   • **A SANDBOX IS NEVER PRODUCTION** (hard rule #7). Not "should not be" — a sandbox
//     credential presented against a production tenant is refused and recorded as a security
//     event, and the refusal is the same whether it was a mistake or an attempt.
//   • **A PARTNER IS SCOPED TO THE TENANTS THAT ENGAGED THEM.** The implementation partner
//     who set up one retailer does not thereby hold a key to every retailer on the platform.
//     This is the failure that ends a SaaS business, and it is always an over-broad
//     credential rather than a break-in.
//   • **CERTIFICATION EXPIRES.** A connector certified against v1 and running unchanged
//     against v4 is not a certified connector, it is an old one with a badge.
//   • **AN UNVERSIONED CALL IS REFUSED.** Not defaulted to the latest — refused. Defaulting
//     to latest is what silently breaks a partner integration on the morning we ship.
//
// Pure and deterministic: the clock is injected, no I/O.

export type Environment = 'sandbox' | 'production';

export interface PartnerCredential {
  readonly credentialId: string;
  readonly partnerId: string;
  readonly environment: Environment;
  /** Tenants this partner has been engaged by. Empty means none — not "all". */
  readonly scopedTenantIds: readonly string[];
  readonly scopes: readonly string[];
  readonly issuedOn: string;
  readonly expiresOn: string;
  readonly revokedOn?: string;
}

export type PartnerAccessOutcome =
  | 'allowed'
  | 'sandbox_credential_in_production'
  | 'production_credential_in_sandbox'
  | 'tenant_not_in_scope'
  | 'scope_missing'
  | 'expired'
  | 'revoked'
  | 'unversioned'
  | 'unknown_version'
  | 'version_retired';

export interface PartnerAccessDecision {
  readonly allowed: boolean;
  readonly outcome: PartnerAccessOutcome;
  /** True when this looks like something the security team should see. */
  readonly securityEvent: boolean;
  readonly detail: string;
}

export interface ApiVersion {
  readonly contract: string;
  readonly version: string;
  readonly status: 'current' | 'supported' | 'deprecated' | 'retired';
  readonly retiredOn?: string;
}

/**
 * Decide whether a partner call may proceed.
 *
 * Every refusal names itself, because a partner developer staring at a 403 at 11pm with no
 * reason is a support ticket, and a support ticket about credentials is one where somebody is
 * eventually tempted to widen a scope "just to unblock them".
 *
 * The two **environment** mismatches are separated on purpose. A sandbox credential presented
 * against production is a security event whatever the intent. A production credential used
 * against the sandbox is a mistake worth stopping, but it is not an attack — and calling it
 * one trains people to ignore the alerts.
 */
export function checkPartnerAccess(input: {
  readonly credential: PartnerCredential;
  readonly environment: Environment;
  readonly tenantId: string;
  readonly requiredScope: string;
  readonly contract: string;
  /** The API version the caller asked for. Absent is a refusal, never a default. */
  readonly requestedVersion?: string;
  readonly versions: readonly ApiVersion[];
  readonly today: string;
}): PartnerAccessDecision {
  const c = input.credential;

  if (c.revokedOn !== undefined && c.revokedOn <= input.today) {
    return { allowed: false, outcome: 'revoked', securityEvent: true, detail: `this credential was revoked on ${c.revokedOn}` };
  }
  if (c.expiresOn < input.today) {
    return { allowed: false, outcome: 'expired', securityEvent: false, detail: `this credential expired on ${c.expiresOn}` };
  }

  if (c.environment === 'sandbox' && input.environment === 'production') {
    return {
      allowed: false,
      outcome: 'sandbox_credential_in_production',
      // Whatever the intent. A sandbox key touching real shops is the same event either way.
      securityEvent: true,
      detail: 'a sandbox credential was presented against production — refused and recorded, whether it was a mistake or not (hard rule #7)',
    };
  }
  if (c.environment === 'production' && input.environment === 'sandbox') {
    return {
      allowed: false,
      outcome: 'production_credential_in_sandbox',
      // A mistake worth stopping, but calling it an attack trains people to ignore alerts.
      securityEvent: false,
      detail: 'a production credential was used against the sandbox — stopped, but this is a mix-up rather than an attack',
    };
  }

  if (!c.scopedTenantIds.includes(input.tenantId)) {
    return {
      allowed: false,
      outcome: 'tenant_not_in_scope',
      securityEvent: true,
      detail: `${c.partnerId} is engaged by ${c.scopedTenantIds.length} tenant(s) and ${input.tenantId} is not one of them — an implementation partner for one retailer does not hold a key to every retailer`,
    };
  }
  if (!c.scopes.includes(input.requiredScope)) {
    return {
      allowed: false,
      outcome: 'scope_missing',
      securityEvent: false,
      detail: `this credential does not carry "${input.requiredScope}"`,
    };
  }

  if (input.requestedVersion === undefined || input.requestedVersion.trim() === '') {
    return {
      allowed: false,
      outcome: 'unversioned',
      securityEvent: false,
      detail: `no API version was requested for ${input.contract} — refused rather than defaulted to the latest, because defaulting is what breaks a partner integration on the morning we ship`,
    };
  }

  const version = input.versions.find(
    (v) => v.contract === input.contract && v.version === input.requestedVersion,
  );
  if (version === undefined) {
    return {
      allowed: false,
      outcome: 'unknown_version',
      securityEvent: false,
      detail: `${input.contract} has no version ${input.requestedVersion}`,
    };
  }
  if (version.status === 'retired') {
    return {
      allowed: false,
      outcome: 'version_retired',
      securityEvent: false,
      detail: `${input.contract} ${input.requestedVersion} was retired${version.retiredOn === undefined ? '' : ` on ${version.retiredOn}`}`,
    };
  }

  return {
    allowed: true,
    outcome: 'allowed',
    securityEvent: false,
    detail:
      version.status === 'deprecated'
        ? `allowed on ${input.contract} ${input.requestedVersion}, which is DEPRECATED — it still works and it will not forever`
        : `allowed on ${input.contract} ${input.requestedVersion}`,
  };
}

export interface Certification {
  readonly certificationId: string;
  readonly partnerId: string;
  readonly connectorId: string;
  readonly certifiedOn: string;
  /** The contract versions it was tested against. */
  readonly againstVersions: readonly { readonly contract: string; readonly version: string }[];
  readonly certifiedBy: string;
}

export type CertificationVerdict = 'current' | 'stale_version' | 'expired' | 'never_certified';

export interface CertificationStatus {
  readonly connectorId: string;
  readonly partnerId: string;
  readonly verdict: CertificationVerdict;
  readonly mayRunInProduction: boolean;
  /** Contracts where the certified version is no longer the current one. */
  readonly behind: readonly { readonly contract: string; readonly certified: string; readonly current: string }[];
  readonly detail: string;
}

/**
 * Is this connector still certified?
 *
 * **A connector certified against v1 and running unchanged against v4 is not certified, it is
 * old with a badge.** The certification names the versions it was tested against; when those
 * stop being current, the badge lapses to `stale_version` — which still runs, because pulling
 * a working integration out of a live shop over paperwork is worse than the risk, but it is
 * visible and it has a date on it.
 *
 * `never_certified` is the one that cannot run in production. An uncertified connector against
 * real shops is somebody else's untested code holding our customers' data.
 */
export function certificationStatus(input: {
  readonly connectorId: string;
  readonly partnerId: string;
  readonly certification?: Certification;
  readonly currentVersions: readonly ApiVersion[];
  /** Months a certification stands before it must be renewed. Default 24. */
  readonly validMonths?: number;
  readonly today: string;
}): CertificationStatus {
  const base = { connectorId: input.connectorId, partnerId: input.partnerId };

  if (input.certification === undefined) {
    return {
      ...base,
      verdict: 'never_certified',
      mayRunInProduction: false,
      behind: [],
      detail: 'this connector has never been certified — uncertified code against real shops is somebody else\'s untested software holding our customers\' data',
    };
  }

  const months = input.validMonths ?? 24;
  const expiry = new Date(Date.parse(`${input.certification.certifiedOn}T00:00:00Z`));
  expiry.setUTCMonth(expiry.getUTCMonth() + months);
  const expired = input.today > expiry.toISOString().slice(0, 10);

  const behind = input.certification.againstVersions
    .map((cv) => {
      const current = input.currentVersions.find((v) => v.contract === cv.contract && v.status === 'current');
      return current === undefined || current.version === cv.version
        ? undefined
        : { contract: cv.contract, certified: cv.version, current: current.version };
    })
    .filter((r): r is { contract: string; certified: string; current: string } => r !== undefined)
    .sort((a, b) => a.contract.localeCompare(b.contract));

  if (expired) {
    return {
      ...base,
      verdict: 'expired',
      // Still runs. Pulling a working integration out of a live shop over paperwork is
      // worse than the risk it is protecting against.
      mayRunInProduction: true,
      behind,
      detail: `certified ${input.certification.certifiedOn}, past its ${months}-month renewal — it keeps running and it needs recertifying`,
    };
  }
  if (behind.length > 0) {
    return {
      ...base,
      verdict: 'stale_version',
      mayRunInProduction: true,
      behind,
      detail: `certified against ${behind.map((b) => `${b.contract} ${b.certified}`).join(', ')} while current is ${behind.map((b) => b.current).join(', ')} — old with a badge, not certified`,
    };
  }

  return {
    ...base,
    verdict: 'current',
    mayRunInProduction: true,
    behind: [],
    detail: `certified ${input.certification.certifiedOn} by ${input.certification.certifiedBy} against the current contracts`,
  };
}

export interface SandboxTenant {
  readonly tenantId: string;
  readonly partnerId: string;
  readonly createdOn: string;
  readonly expiresOn: string;
  /** Always true. A sandbox holds generated data and nothing else. */
  readonly syntheticDataOnly: true;
}

export type SandboxSeedOutcome = 'seeded' | 'production_data_refused' | 'expired';

export interface SandboxSeedResult {
  readonly tenantId: string;
  readonly seeded: boolean;
  readonly outcome: SandboxSeedOutcome;
  readonly records: number;
  readonly detail: string;
}

/**
 * Seed a partner sandbox.
 *
 * **Production data is refused outright** (hard rule #7). The temptation is real and it always
 * arrives with a good reason — *"the partner needs realistic data to test against"* — and the
 * result is a copy of a retailer's customer list on a developer's laptop, outside every control
 * that protects it. Realistic data is generated, not copied.
 */
export function seedSandbox(input: {
  readonly sandbox: SandboxTenant;
  readonly records: readonly { readonly recordId: string; readonly origin: 'generated' | 'production' }[];
  readonly today: string;
}): SandboxSeedResult {
  if (input.sandbox.expiresOn < input.today) {
    return {
      tenantId: input.sandbox.tenantId,
      seeded: false,
      outcome: 'expired',
      records: 0,
      detail: `this sandbox expired on ${input.sandbox.expiresOn}`,
    };
  }

  const fromProduction = input.records.filter((r) => r.origin === 'production');
  if (fromProduction.length > 0) {
    return {
      tenantId: input.sandbox.tenantId,
      seeded: false,
      outcome: 'production_data_refused',
      records: 0,
      detail: `${fromProduction.length} record(s) came from production and the whole seed is REFUSED — realistic data is generated, never copied, whatever the reason given (hard rule #7)`,
    };
  }

  return {
    tenantId: input.sandbox.tenantId,
    seeded: true,
    outcome: 'seeded',
    records: input.records.length,
    detail: `${input.records.length} generated record(s) seeded into the sandbox`,
  };
}
