// API-12 Migration — staging, mapping, exceptions, reconciliation, the verification report.
//
// **This service can never point at production** (hard rule #7). Not "should not" — the target is
// asserted before anything else happens, exactly as `packages/migration/src/trial.ts` does, and
// the check runs first because a load that reached production has already done its damage by the
// time any other validation would have run.
//
// It exposes the six outside-evidence checks and the page that gets signed, and it exposes them
// **read-only for the results and write-only for the evidence**: nothing here can mark a domain
// as verified. A domain becomes verified by its evidence agreeing, and an endpoint that could set
// the verdict directly is a way to sign the report without doing the work.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { assertNonProduction, type LoadTarget } from '../../../packages/migration/src/trial';
import {
  inventorySources, sealExtract, verifyExtract, simpleHasher,
  type LegacySource, type SealedExtract,
} from '../../../packages/migration/src/discovery';
import {
  buildVerificationReport, renderVerificationReport,
  type DomainFinding, type Acceptance, type Signature,
} from '../../../packages/migration/src/verification-report';

const SOURCE_KINDS: readonly string[] = ['erp_database', 'pos_database', 'spreadsheet', 'paper', 'third_party_system', 'report_only'];
const VOLUME_BASES: readonly string[] = ['counted', 'estimated', 'unknown'];
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';

/**
 * Is this a legacy source the discovery step can assess? The fields discovery reasons about — a name,
 * a kind, whether the volume is counted/estimated/unknown, and whether it can be extracted. Optional
 * fields (owner, row count, retention) are what discovery reports as GAPS when absent, so they are
 * not required here; a missing one is a finding, not a malformed request.
 */
function isLegacySource(v: unknown): v is LegacySource {
  if (!isObj(v)) return false;
  return typeof v['sourceId'] === 'string' && v['sourceId'] !== ''
    && typeof v['name'] === 'string' && v['name'] !== ''
    && typeof v['kind'] === 'string' && SOURCE_KINDS.includes(v['kind'])
    && typeof v['volumeBasis'] === 'string' && VOLUME_BASES.includes(v['volumeBasis'])
    && typeof v['extractable'] === 'boolean';
}

/** Is this a sealed extract the load-time check can verify against — the seal `sealExtract` produced?
 * The digest and row count taken at extraction (MG-02) are what a load verifies against, so both
 * must be present and the record must actually claim to be sealed. */
function isSealedExtract(v: unknown): v is SealedExtract {
  if (!isObj(v)) return false;
  return typeof v['extractId'] === 'string' && v['extractId'] !== ''
    && typeof v['tenantId'] === 'string'
    && typeof v['sourceId'] === 'string'
    && typeof v['digest'] === 'string' && v['digest'] !== ''
    && typeof v['rowCount'] === 'number'
    && typeof v['extractedAt'] === 'string'
    && typeof v['extractedBy'] === 'string'
    && v['sealed'] === true;
}

export interface MigrationDeps {
  readonly target: (tenantId: string) => Promise<LoadTarget> | LoadTarget;
  readonly findings: (tenantId: string) => Promise<readonly DomainFinding[]> | readonly DomainFinding[];
  readonly acceptances: (tenantId: string) => Promise<readonly Acceptance[]> | readonly Acceptance[];
  readonly signatures: (tenantId: string) => Promise<readonly Signature[]> | readonly Signature[];
  readonly recordAcceptance: (tenantId: string, a: Acceptance) => Promise<void> | void;
  /**
   * Who the owner is. **`undefined` means we cannot tell, and nobody may accept in their place.**
   *
   * This was a hard-coded `'u-owner'` in the composition root, which meant the check below —
   * "only the owner may accept a figure into the opening books" — was satisfied by anybody who
   * typed that string. A control comparing a caller against a placeholder is not a control.
   */
  readonly ownerId: (tenantId: string) => Promise<string | undefined> | string | undefined;
  /**
   * Who ran the extraction. **`undefined` means we cannot tell, and no report is produced.**
   *
   * It appears by name on the page the owner and the CA sign, and it is load-bearing there: the
   * rule that whoever ran the extraction cannot choose which stock lines get counted only means
   * something if the page says who that was. A placeholder here is a fabricated audit record on a
   * signed document.
   */
  readonly extractionOperator: (tenantId: string) => Promise<string | undefined> | string | undefined;
  readonly now: () => string;
}

/**
 * Refuse the whole surface if the configured target is production.
 *
 * Called at the top of every handler rather than once at startup: a target can be re-pointed by
 * configuration between requests, and the check is worth nothing if it only ran at boot.
 */
async function assertSafeTarget(deps: MigrationDeps, tenantId: string): Promise<void> {
  const assertion = assertNonProduction(await deps.target(tenantId));
  if (!assertion.permitted) {
    throw apiError(403, {
      code: 'target_is_production',
      whatHappened: `The migration target is ${assertion.detail}. Nothing in this service will run against production (hard rule #7).`,
      wasItSaved: 'not_saved',
      nextSafeAction: 'Point the migration at the rehearsal environment. Nothing was read or written.',
    });
  }
}

/**
 * The two people the signed page names, or a refusal.
 *
 * Both were placeholders in the composition root — `'u-owner'` and `'u-operator'`. A page that
 * names a person who does not exist is worse than a page that will not render: it is signed.
 */
async function namedPeople(
  deps: MigrationDeps, tenantId: string,
): Promise<{ ownerId: string; extractionOperator: string }> {
  const ownerId = await deps.ownerId(tenantId);
  const extractionOperator = await deps.extractionOperator(tenantId);
  const missing = [
    ownerId === undefined ? 'who the owner is' : undefined,
    extractionOperator === undefined ? 'who ran the extraction' : undefined,
  ].filter((m): m is string => m !== undefined);

  if (missing.length > 0) {
    throw apiError(409, {
      code: 'the_page_would_name_nobody',
      whatHappened: `This report is signed, and it does not yet know ${missing.join(' or ')}.`,
      wasItSaved: 'not_saved',
      nextSafeAction: 'No report was produced. Record those people first — a signed page naming a placeholder is a fabricated record, and the rule that whoever ran the extraction cannot choose which lines get counted only means something if the page says who that was.',
    });
  }
  return { ownerId: ownerId!, extractionOperator: extractionOperator! };
}

export function migrationRoutes(deps: MigrationDeps): readonly Route[] {
  return [
    {
      // MG-01 — the first step of the pipeline: inventory the legacy sources and NAME what is
      // missing from the inventory (an unowned source, an estimated volume, no retention period, a
      // source that cannot be extracted). Read-only assessment — it computes from the sources the
      // operator declares in the body and stores nothing, so it takes them in the body like the other
      // what-if surfaces. The completeness verdict is the output: a migration that starts before
      // discovery is complete migrates what somebody happened to remember (MG-01).
      api: 'API-12', method: 'POST', path: '/v1/migration/discovery',
      permission: 'migration.discovery.read', idempotent: true,
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const b = ctx.body;
        const rawSources = isObj(b) ? b['sources'] : undefined;
        if (!Array.isArray(rawSources) || rawSources.length === 0 || !rawSources.every(isLegacySource)) {
          throw apiError(400, {
            code: 'not_readable_as_a_source_inventory',
            whatHappened: 'This payload could not be read as a list of legacy sources. Each source needs a sourceId, a name, a kind (erp_database/pos_database/spreadsheet/paper/third_party_system/report_only), whether its volume is counted/estimated/unknown, and whether it can be extracted.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was assessed and nothing was stored. Correct the sources and send them again — discovery reads and reports, it changes no data.',
          });
        }
        // The tenant is stamped from the authenticated context, never the body: a source is
        // discovered FOR this tenant, and trusting a body-supplied tenantId would let one tenant's
        // discovery name another's source.
        const sources = rawSources.map((s) => ({ ...s, tenantId: ctx.tenantId }));
        return { status: 200, body: inventorySources({ tenantId: ctx.tenantId, sources }) };
      },
    },
    {
      // MG-02 — preservation, step one: SEAL the raw extract at extraction. Hash it, stamp who took
      // it and when, and REFUSE it without a verified backup restore (a backup job that reported
      // success is not a backup that restores, and the difference is only discovered when it matters).
      // The digest is taken here, at extraction — a hash taken later, at load, proves nothing. The
      // seal is returned to the operator to keep; verifying it at load is the next route.
      api: 'API-12', method: 'POST', path: '/v1/migration/extracts/:extractId/seal',
      permission: 'migration.preservation.seal', idempotent: true,
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const b = ctx.body;
        const extractId = ctx.params['extractId'] ?? '';
        const sourceId = isObj(b) ? b['sourceId'] : undefined;
        const material = isObj(b) ? b['material'] : undefined;
        const rowCount = isObj(b) ? b['rowCount'] : undefined;
        const extractedBy = isObj(b) ? b['extractedBy'] : undefined;
        const backupVerifiedAt = isObj(b) ? b['backupVerifiedAt'] : undefined;
        if (extractId === '' || typeof sourceId !== 'string' || sourceId === ''
          || typeof material !== 'string' || typeof rowCount !== 'number' || typeof extractedBy !== 'string'
          || (backupVerifiedAt !== undefined && typeof backupVerifiedAt !== 'string')) {
          throw apiError(400, {
            code: 'not_readable_as_an_extract_to_seal',
            whatHappened: 'This payload could not be read as a raw extract. Sealing needs the extract id (in the path), the sourceId it came from, the material to hash, the row count, and who extracted it.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was sealed. Correct the fields and send them again.',
          });
        }
        const sealed = sealExtract({
          extractId, tenantId: ctx.tenantId, sourceId, material, rowCount, extractedBy,
          ...(backupVerifiedAt === undefined ? {} : { backupVerifiedAt }),
          hasher: simpleHasher, now: deps.now(),
        });
        if (!sealed.ok) {
          // Refused, by name — most importantly a backup that was never verified (MG-02). Understood
          // but cannot be produced, so 422, and nothing is sealed.
          throw apiError(422, {
            code: sealed.refusedBecause!, whatHappened: sealed.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: 'No seal was produced. A raw extract without a VERIFIED backup restore, an empty extract, or one with nobody\'s name on it cannot be sealed — resolve that first.',
          });
        }
        return { status: 200, body: sealed.extract };
      },
    },
    {
      // MG-02 — preservation, step two: VERIFY at load time that the bytes about to be loaded are the
      // bytes that were sealed. Both the digest AND the row count, because they fail differently: a
      // changed digest means the content moved; a smaller row count means part of it did not arrive,
      // and a truncated extract loads perfectly and reconciles to a smaller, self-consistent shop. A
      // mismatch is not an HTTP error — the answer (matches / rowCountMatches) is in the body for the
      // operator to act on, the same way discovery's gaps are.
      api: 'API-12', method: 'POST', path: '/v1/migration/extracts/verify',
      permission: 'migration.preservation.verify', idempotent: true,
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const b = ctx.body;
        const extract = isObj(b) ? b['extract'] : undefined;
        const material = isObj(b) ? b['material'] : undefined;
        const rowCount = isObj(b) ? b['rowCount'] : undefined;
        if (!isSealedExtract(extract) || typeof material !== 'string' || typeof rowCount !== 'number') {
          throw apiError(400, {
            code: 'not_readable_as_a_load_to_verify',
            whatHappened: 'This payload could not be read as a load to verify. It needs the sealed extract taken at extraction, the material about to be loaded, and its row count.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was verified. Send the seal from extraction alongside the bytes about to be loaded.',
          });
        }
        // A seal belongs to the tenant it was taken for; verifying it under another is refused rather
        // than quietly recomputing against the wrong shop's seal.
        if (extract.tenantId !== ctx.tenantId) {
          throw apiError(403, {
            code: 'seal_belongs_to_another_tenant',
            whatHappened: 'This sealed extract was taken for a different tenant.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was verified. Verify a seal against the tenant it was taken for.',
          });
        }
        return { status: 200, body: verifyExtract({ extract, material, rowCount, hasher: simpleHasher }) };
      },
    },
    {
      api: 'API-12', method: 'GET', path: '/v1/migration/verification',
      permission: 'migration.verification.read',
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const people = await namedPeople(deps, ctx.tenantId);
        const built = buildVerificationReport({
          reportId: `VR-${ctx.tenantId}`, asAt: deps.now(),
          preparedBy: ctx.userId,
          extractionOperator: people.extractionOperator,
          findings: await deps.findings(ctx.tenantId),
          acceptances: await deps.acceptances(ctx.tenantId),
          ownerId: people.ownerId,
        });
        if (!built.ok) {
          // A refusal here is the report declining to exist, which is the point: a partial one
          // renders perfectly and reads as complete.
          throw apiError(422, {
            code: built.refusedBecause!,
            whatHappened: built.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: 'No report was produced. Close what is named above — a report over some of the domains would look finished and would not be.',
          });
        }
        return { status: 200, body: built.report };
      },
    },
    {
      api: 'API-12', method: 'GET', path: '/v1/migration/verification/page',
      permission: 'migration.verification.read',
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const people = await namedPeople(deps, ctx.tenantId);
        const built = buildVerificationReport({
          reportId: `VR-${ctx.tenantId}`, asAt: deps.now(),
          preparedBy: ctx.userId,
          extractionOperator: people.extractionOperator,
          findings: await deps.findings(ctx.tenantId),
          acceptances: await deps.acceptances(ctx.tenantId),
          ownerId: people.ownerId,
        });
        if (!built.ok) throw apiError(422, {
          code: built.refusedBecause!, whatHappened: built.detail,
          wasItSaved: 'not_saved', nextSafeAction: 'No report was produced.',
        });
        return {
          status: 200,
          body: { markdown: renderVerificationReport(built.report!, await deps.signatures(ctx.tenantId)) },
        };
      },
    },
    {
      api: 'API-12', method: 'POST', path: '/v1/migration/acceptances',
      permission: 'migration.exception.accept', idempotent: true,
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const a = ctx.body as Acceptance;
        const owner = await deps.ownerId(ctx.tenantId);
        if (owner === undefined) {
          throw apiError(409, {
            code: 'nobody_is_recorded_as_the_owner',
            whatHappened: 'No user holds the owner role for this tenant, so there is nobody this acceptance could be checked against.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was accepted. Record who the owner is first — until then a check that only the owner may accept has nothing to compare a caller with, and would pass for anybody.',
          });
        }
        if (a?.acceptedBy !== owner) {
          throw apiError(403, {
            code: 'accepted_by_somebody_other_than_the_owner',
            whatHappened: 'Carrying a figure into the opening books on the old system\'s word alone is the owner\'s decision and nobody else\'s.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was accepted. The owner records this one themselves, in their own words.',
          });
        }
        await deps.recordAcceptance(ctx.tenantId, a);
        return { status: 201, body: a };
      },
    },
  ];
}
