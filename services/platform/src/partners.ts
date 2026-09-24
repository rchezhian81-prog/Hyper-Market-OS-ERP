// Partner and developer ecosystem — the credential registry + access-check decision path
// (M36-FR-04 / P-06 / hard rule #7). A partner ecosystem is a set of people we do not employ holding
// credentials to systems we are responsible for, so this surface does two things and nothing else:
//
//   • REGISTER / REVOKE a partner credential, durably and append-only. A credential is scoped to the
//     TENANTS that engaged the partner (empty means none — never "all"), to an ENVIRONMENT (sandbox or
//     production) and to named scopes, with an expiry. Revoking appends a new version with a revocation
//     date; the history stays (hard rule #6).
//   • DECIDE whether a partner call may proceed, against the STORED credential — the security principal
//     is authoritative from the ledger, never the request body. The tested `checkPartnerAccess` engine
//     refuses a sandbox credential presented against production (hard rule #7), a tenant the partner is
//     not scoped to, a revoked or expired credential, and an UNVERSIONED call (refused, never defaulted
//     to latest). The contract-version catalogue is platform config the calling gateway supplies; note
//     that every SECURITY refusal is decided from the stored credential before any version is consulted,
//     so the catalogue cannot widen access.
//
// The rules are the pure engine in `packages/platform`; this file is the persistence + HTTP skin. No AI
// writes here (hard rule #5). seedSandbox and the full certification store are separate follow-on slices.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  checkPartnerAccess, certificationStatus,
  type PartnerCredential, type PartnerAccessDecision, type ApiVersion, type Environment,
  type Certification, type CertificationStatus,
} from '../../../packages/platform/src/partner';

export type { PartnerCredential, Certification } from '../../../packages/platform/src/partner';

const ENVIRONMENTS: readonly Environment[] = ['sandbox', 'production'];
const VERSION_STATUSES: readonly ApiVersion['status'][] = ['current', 'supported', 'deprecated', 'retired'];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00.000Z`));
const strArray = (v: unknown): readonly string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim() !== '') ? (v as string[]) : undefined;

const isApiVersion = (v: unknown): v is ApiVersion =>
  isObj(v) && isStr(v['contract']) && isStr(v['version'])
  && typeof v['status'] === 'string' && VERSION_STATUSES.includes(v['status'] as ApiVersion['status'])
  && (v['retiredOn'] === undefined || isDate(v['retiredOn']));

/** Read a credential to register off the request body — the credentialId comes from the path, never the body. */
function readCredential(credentialId: string, b: Record<string, unknown>): PartnerCredential | undefined {
  const scopedTenantIds = strArray(b['scopedTenantIds']);
  const scopes = strArray(b['scopes']);
  if (!isStr(b['partnerId']) || typeof b['environment'] !== 'string' || !ENVIRONMENTS.includes(b['environment'] as Environment)
    || scopedTenantIds === undefined || scopes === undefined || !isDate(b['issuedOn']) || !isDate(b['expiresOn'])) {
    return undefined;
  }
  return {
    credentialId, partnerId: b['partnerId'] as string, environment: b['environment'] as Environment,
    scopedTenantIds, scopes, issuedOn: b['issuedOn'] as string, expiresOn: b['expiresOn'] as string,
  };
}

/** One contract-version a certification was tested against — the shape inside `againstVersions`. */
const isCertVersion = (v: unknown): v is { readonly contract: string; readonly version: string } =>
  isObj(v) && isStr(v['contract']) && isStr(v['version']);

/** Read a certification to register off the request body — the certificationId comes from the path. */
function readCertification(certificationId: string, b: Record<string, unknown>): Certification | undefined {
  const against = Array.isArray(b['againstVersions']) && b['againstVersions'].length > 0 && b['againstVersions'].every(isCertVersion)
    ? (b['againstVersions'] as { contract: string; version: string }[]) : undefined;
  if (!isStr(b['partnerId']) || !isStr(b['connectorId']) || !isDate(b['certifiedOn']) || against === undefined || !isStr(b['certifiedBy'])) {
    return undefined;
  }
  return {
    certificationId, partnerId: b['partnerId'] as string, connectorId: b['connectorId'] as string,
    certifiedOn: b['certifiedOn'] as string, againstVersions: against, certifiedBy: b['certifiedBy'] as string,
  };
}

export interface PartnerDeps {
  /** The current version of a partner credential, folded latest-wins from the append-only log. */
  readonly credential: (tenantId: string, credentialId: string) => Promise<PartnerCredential | undefined> | PartnerCredential | undefined;
  /** Append a credential version (register or revoke). Idempotent on the key. */
  readonly recordCredential: (tenantId: string, credential: PartnerCredential, key: string) => Promise<void> | void;
  /** The current certification for a connector (latest-wins per partner+connector), or undefined. */
  readonly certification: (tenantId: string, partnerId: string, connectorId: string) => Promise<Certification | undefined> | Certification | undefined;
  /** Append a connector certification, keyed latest-wins per partner+connector. Idempotent on the key. */
  readonly recordCertification: (tenantId: string, certification: Certification) => Promise<void> | void;
  readonly now: () => string;
}

export function partnerRoutes(deps: PartnerDeps): readonly Route[] {
  return [
    {
      // Decide whether a partner call may proceed, against the STORED credential (M36-FR-04). Every security
      // refusal — sandbox-in-production (hard rule #7), out-of-scope tenant, revoked, expired — is decided
      // from the stored credential before any version is consulted; the version catalogue is the calling
      // gateway's own config and cannot widen access. An unversioned call is REFUSED, never defaulted to
      // latest. Registered BEFORE `/:credentialId` so this literal address is never captured as an id.
      api: 'API-11', method: 'POST', path: '/v1/platform/partners/access-check',
      permission: 'platform.partner.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const versions = Array.isArray(b['versions']) && b['versions'].every(isApiVersion) ? (b['versions'] as ApiVersion[]) : undefined;
        if (!isStr(b['credentialId']) || typeof b['environment'] !== 'string' || !ENVIRONMENTS.includes(b['environment'] as Environment)
          || !isStr(b['tenantId']) || !isStr(b['requiredScope']) || !isStr(b['contract']) || versions === undefined
          || (b['requestedVersion'] !== undefined && typeof b['requestedVersion'] !== 'string')) {
          throw apiError(400, {
            code: 'not_readable_as_an_access_check',
            whatHappened: 'An access-check needs { credentialId, environment (sandbox|production), tenantId, requiredScope, contract, versions[] (each { contract, version, status }) } and optionally requestedVersion.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the check fields. This only decides — it stores nothing.',
          });
        }
        const credential = await deps.credential(ctx.tenantId, b['credentialId'] as string);
        if (credential === undefined) throw notFound(`partner credential ${b['credentialId'] as string}`);
        const decision: PartnerAccessDecision = checkPartnerAccess({
          credential, environment: b['environment'] as Environment, tenantId: b['tenantId'] as string,
          requiredScope: b['requiredScope'] as string, contract: b['contract'] as string,
          ...(isStr(b['requestedVersion']) ? { requestedVersion: b['requestedVersion'] as string } : {}),
          versions, today: deps.now().slice(0, 10),
        });
        return { status: 200, body: { ...decision, credentialId: credential.credentialId, asAt: deps.now() } };
      },
    },
    {
      // Register a partner credential — scoped to the tenants that engaged the partner, to an environment
      // and to named scopes, with an expiry. Append-only; re-registering with new terms is a new version.
      api: 'API-11', method: 'POST', path: '/v1/platform/partners/:credentialId',
      permission: 'platform.partner.manage', idempotent: true,
      handler: async (ctx) => {
        const credentialId = ctx.params['credentialId'] ?? '';
        const credential = readCredential(credentialId, (ctx.body ?? {}) as Record<string, unknown>);
        if (credential === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_a_partner_credential',
            whatHappened: 'A partner credential needs { partnerId, environment (sandbox|production), scopedTenantIds[], scopes[], issuedOn (YYYY-MM-DD), expiresOn (YYYY-MM-DD) }. scopedTenantIds empty means the partner is scoped to no tenants — never all.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the credential fields. Nothing was stored.',
          });
        }
        await deps.recordCredential(ctx.tenantId, credential,
          `set-${credential.environment}-${credential.issuedOn}-${credential.expiresOn}-${credential.scopedTenantIds.join(',')}-${credential.scopes.join(',')}`);
        return { status: 201, body: { credentialId, partnerId: credential.partnerId, environment: credential.environment, scopedTenantIds: credential.scopedTenantIds, scopes: credential.scopes, expiresOn: credential.expiresOn } };
      },
    },
    {
      // Revoke a partner credential — append a version carrying the revocation date. The credential must
      // exist; a revoked credential is refused by every access-check from that date (hard rule #6: the
      // history stays, the credential is not deleted).
      api: 'API-11', method: 'POST', path: '/v1/platform/partners/:credentialId/revoke',
      permission: 'platform.partner.manage', idempotent: true,
      handler: async (ctx) => {
        const credentialId = ctx.params['credentialId'] ?? '';
        const current = await deps.credential(ctx.tenantId, credentialId);
        if (current === undefined) throw notFound(`partner credential ${credentialId}`);
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const revokedOn = isDate(b['revokedOn']) ? (b['revokedOn'] as string) : deps.now().slice(0, 10);
        const revoked: PartnerCredential = { ...current, revokedOn };
        await deps.recordCredential(ctx.tenantId, revoked, `revoke-${revokedOn}`);
        return { status: 200, body: { credentialId, revokedOn } };
      },
    },
    {
      // Read the current partner credential (its latest version). Registered as a deeper path than the
      // access-check literal below is registered before it, so `access-check` is never read as a credentialId.
      api: 'API-11', method: 'GET', path: '/v1/platform/partners/:credentialId',
      permission: 'platform.partner.read',
      handler: async (ctx) => {
        const credentialId = ctx.params['credentialId'] ?? '';
        const credential = await deps.credential(ctx.tenantId, credentialId);
        if (credential === undefined) throw notFound(`partner credential ${credentialId}`);
        return { status: 200, body: { ...credential, asAt: deps.now() } };
      },
    },
    {
      // Register a connector certification — the versions it was TESTED against, who signed it off, when.
      // Append-only, latest-wins per partner+connector. Deeper path than /:credentialId, so no capture.
      api: 'API-11', method: 'POST', path: '/v1/platform/partners/certifications/:certificationId',
      permission: 'platform.partner.manage', idempotent: true,
      handler: async (ctx) => {
        const certificationId = ctx.params['certificationId'] ?? '';
        const certification = readCertification(certificationId, (ctx.body ?? {}) as Record<string, unknown>);
        if (certification === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_a_certification',
            whatHappened: 'A certification needs { partnerId, connectorId, certifiedOn (YYYY-MM-DD), againstVersions[] (each { contract, version }), certifiedBy }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the certification fields. Nothing was stored.',
          });
        }
        await deps.recordCertification(ctx.tenantId, certification);
        return { status: 201, body: { certificationId, partnerId: certification.partnerId, connectorId: certification.connectorId, certifiedOn: certification.certifiedOn } };
      },
    },
    {
      // Is this connector still certified? A connector certified against v1 and running unchanged against
      // v4 is not certified, it is old with a badge — `stale_version` (still runs, flagged) — while a
      // never-certified connector CANNOT run in production. The current-versions catalogue is the calling
      // gateway's own config, supplied in the body.
      api: 'API-11', method: 'POST', path: '/v1/platform/partners/:partnerId/certifications/:connectorId/status',
      permission: 'platform.partner.read', idempotent: true,
      handler: async (ctx) => {
        const partnerId = ctx.params['partnerId'] ?? '';
        const connectorId = ctx.params['connectorId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const currentVersions = Array.isArray(b['currentVersions']) && b['currentVersions'].every(isApiVersion) ? (b['currentVersions'] as ApiVersion[]) : undefined;
        if (currentVersions === undefined || (b['validMonths'] !== undefined && (!Number.isInteger(b['validMonths']) || (b['validMonths'] as number) <= 0))) {
          throw apiError(400, {
            code: 'not_readable_as_a_certification_status_check',
            whatHappened: 'A certification-status check needs { currentVersions[] (each { contract, version, status }) } and optionally a whole positive validMonths.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the current contract versions. This only decides — it stores nothing.',
          });
        }
        const certification = await deps.certification(ctx.tenantId, partnerId, connectorId);
        const status: CertificationStatus = certificationStatus({
          connectorId, partnerId,
          ...(certification === undefined ? {} : { certification }),
          currentVersions,
          ...(b['validMonths'] !== undefined ? { validMonths: b['validMonths'] as number } : {}),
          today: deps.now().slice(0, 10),
        });
        return { status: 200, body: { ...status, asAt: deps.now() } };
      },
    },
  ];
}
