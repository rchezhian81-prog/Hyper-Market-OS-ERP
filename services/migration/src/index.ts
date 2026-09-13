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
import {
  assertNonProduction, runTrialLoad, applyDelta,
  type LoadTarget, type DeltaChange,
} from '../../../packages/migration/src/trial';
import {
  recordControlTotal, assessReconciliation, buildOpeningEvents, signControlTotal,
  type ControlTotal, type OpeningKind, type ReconciliationReport,
} from '../../../packages/migration/src/reconcile';
import {
  inventorySources, sealExtract, verifyExtract, simpleHasher,
  type LegacySource, type SealedExtract,
} from '../../../packages/migration/src/discovery';
import {
  approveMapping, assessCoverage,
  type MappingTable, type MappingEntry, type MappingDomain,
} from '../../../packages/migration/src/mapping';
import { detectExceptions, type OutstandingExceptions } from '../../../packages/migration/src/cleaning';
import type { LegacyDataset } from '../../../packages/migration/src/synthetic';
import { decideCutover, type ParallelRunPosition } from '../../../packages/migration/src/cutover';
import { buildCutoverChecklist, type CutoverEvidence, type TeamMember } from '../../../packages/migration/src/cutover-checklist';
import {
  buildVerificationReport, renderVerificationReport,
  type DomainFinding, type Acceptance, type Signature,
} from '../../../packages/migration/src/verification-report';
import {
  proposeExclusion, approveExclusion, exclusionPosition, assessRetirement,
  type HistoryExclusion, type ExclusionScope, type LegacyArchive,
} from '../../../packages/migration/src/history';

const EXCLUSION_SCOPES: readonly string[] = ['documents_before', 'entity_kind', 'named_records', 'inactive_records'];

/**
 * Is this a legacy archive the retirement assessment can read — a sealed, read-only capture with the
 * dates retention runs from? `readOnly` must be the literal true: an archive that is not read-only is
 * not an archive, it is still a live system.
 */
function isLegacyArchive(v: unknown): v is LegacyArchive {
  if (!isObj(v)) return false;
  return typeof v['archiveId'] === 'string' && v['archiveId'] !== ''
    && typeof v['sourceId'] === 'string'
    && typeof v['digest'] === 'string' && v['digest'] !== ''
    && Number.isInteger(v['rowCount'])
    && typeof v['archivedAt'] === 'string'
    && Number.isInteger(v['retentionYears']) && (v['retentionYears'] as number) >= 0
    && typeof v['earliestRecordDate'] === 'string' && v['earliestRecordDate'] !== ''
    && typeof v['latestRecordDate'] === 'string' && v['latestRecordDate'] !== ''
    && v['readOnly'] === true
    && (v['restoreVerifiedAt'] === undefined || typeof v['restoreVerifiedAt'] === 'string');
}

const SOURCE_KINDS: readonly string[] = ['erp_database', 'pos_database', 'spreadsheet', 'paper', 'third_party_system', 'report_only'];
const VOLUME_BASES: readonly string[] = ['counted', 'estimated', 'unknown'];
const MAPPING_DOMAINS: readonly string[] = ['tax_code', 'uom', 'department', 'account', 'branch', 'identity', 'document_kind'];
const MAPPING_STATUSES: readonly string[] = ['draft', 'approved', 'superseded'];
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';

/** Is this one entry of a mapping table — a legacy value, its target, and WHY (read at an assessment)? */
function isMappingEntry(v: unknown): v is MappingEntry {
  if (!isObj(v)) return false;
  return typeof v['domain'] === 'string' && MAPPING_DOMAINS.includes(v['domain'])
    && typeof v['legacyValue'] === 'string'
    && typeof v['targetValue'] === 'string'
    && typeof v['rationale'] === 'string';
}

/** Is this a mapping table the MG-03 engine can approve / measure coverage against? */
function isMappingTable(v: unknown): v is MappingTable {
  if (!isObj(v)) return false;
  return typeof v['mappingId'] === 'string' && v['mappingId'] !== ''
    && typeof v['tenantId'] === 'string'
    && typeof v['version'] === 'number'
    && typeof v['status'] === 'string' && MAPPING_STATUSES.includes(v['status'])
    && Array.isArray(v['entries']) && v['entries'].every(isMappingEntry);
}

interface ObservedValue { readonly domain: MappingDomain; readonly value: string; readonly rows: number }

/** One value seen in the extract, and how many rows carry it — coverage is measured against these. */
function isObservedValue(v: unknown): v is ObservedValue {
  if (!isObj(v)) return false;
  return typeof v['domain'] === 'string' && MAPPING_DOMAINS.includes(v['domain'])
    && typeof v['value'] === 'string'
    && typeof v['rows'] === 'number';
}

const TOTAL_KINDS: readonly string[] = ['migration', 'stock', 'financial', 'tax', 'loyalty'];
const TOTAL_UNITS: readonly string[] = ['rows', 'quantity', 'minor_currency', 'points'];

/**
 * Is this a control total the reconciliation can assess — two independently-derived figures with a
 * note on where each side came from? The derivations are required because the whole point of MG-06 is
 * catching a total that reconciles because both sides were computed the same way.
 */
function isControlTotal(v: unknown): v is ControlTotal {
  if (!isObj(v)) return false;
  return typeof v['totalId'] === 'string' && v['totalId'] !== ''
    && typeof v['kind'] === 'string' && TOTAL_KINDS.includes(v['kind'])
    && typeof v['name'] === 'string'
    && typeof v['unit'] === 'string' && TOTAL_UNITS.includes(v['unit'])
    && typeof v['legacyValue'] === 'number'
    && typeof v['loadedValue'] === 'number'
    && typeof v['legacyDerivation'] === 'string'
    && typeof v['loadedDerivation'] === 'string';
}

const DELTA_OPS: readonly string[] = ['insert', 'update', 'delete'];

/** Is this a post-extract change to apply exactly once — a stable key, an entity, and when it happened? */
function isDeltaChange(v: unknown): v is DeltaChange {
  if (!isObj(v)) return false;
  return typeof v['changeKey'] === 'string' && v['changeKey'] !== ''
    && typeof v['entity'] === 'string'
    && typeof v['legacyId'] === 'string'
    && typeof v['operation'] === 'string' && DELTA_OPS.includes(v['operation'])
    && typeof v['changedAt'] === 'string'
    && (v['deltaMinor'] === undefined || typeof v['deltaMinor'] === 'number')
    && (v['deltaQty'] === undefined || typeof v['deltaQty'] === 'number');
}

const OPENING_KINDS: readonly string[] = ['stock', 'customer_outstanding', 'supplier_outstanding', 'loyalty_points', 'open_order'];

interface OpeningPosition {
  readonly kind: OpeningKind; readonly subjectId: string; readonly fromTotalId: string;
  readonly quantity?: number; readonly valueMinor?: number; readonly points?: number;
}

/** Is this an opening position — a figure that must trace back to a signed control total (MG-08)? */
function isOpeningPosition(v: unknown): v is OpeningPosition {
  if (!isObj(v)) return false;
  return typeof v['kind'] === 'string' && OPENING_KINDS.includes(v['kind'])
    && typeof v['subjectId'] === 'string' && v['subjectId'] !== ''
    && typeof v['fromTotalId'] === 'string' && v['fromTotalId'] !== ''
    && (v['quantity'] === undefined || typeof v['quantity'] === 'number')
    && (v['valueMinor'] === undefined || typeof v['valueMinor'] === 'number')
    && (v['points'] === undefined || typeof v['points'] === 'number');
}

/** A named person on the night, with a role each — "the team" is not a team at 2am (MG-11). */
function isTeamMember(v: unknown): v is TeamMember {
  if (!isObj(v)) return false;
  return typeof v['userId'] === 'string' && v['userId'] !== ''
    && typeof v['role'] === 'string' && v['role'] !== '';
}

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
  /**
   * The roles a user holds in a tenant, read from their own grants — used to decide whether a signer
   * is a chartered accountant (MG-06). Optional so existing callers/stubs need not supply it; when it
   * is absent the caller is treated as holding no roles, so a finance/tax total cannot be signed.
   */
  readonly rolesOf?: (tenantId: string, userId: string) => Promise<readonly string[]> | readonly string[];
  /** Every history exclusion (MG-07), latest state per id — proposed, then owner-decided. */
  readonly exclusions: (tenantId: string) => Promise<readonly HistoryExclusion[]> | readonly HistoryExclusion[];
  /** Persist an exclusion — the proposal, then the owner's written decision. Append-only. */
  readonly recordExclusion: (tenantId: string, exclusion: HistoryExclusion) => Promise<void> | void;
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
      // MG-03 — mapping, the approval half. A mapping table is a set of accounting decisions wearing
      // the costume of a config file, so it is APPROVED by a named person (from the token) with a date,
      // and the one contradiction that cannot be resolved at load — a single legacy value meaning two
      // different targets — is refused HERE, by name, rather than picked arbitrarily during the load
      // (where nine products quietly become zero-rated). Stateless: the approved table is returned for
      // the operator to keep and use at load, the same chain-of-custody contract as the seal.
      api: 'API-12', method: 'POST', path: '/v1/migration/mapping/approve',
      permission: 'migration.mapping.approve', idempotent: true,
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const b = ctx.body;
        const table = isObj(b) ? b['table'] : undefined;
        if (!isMappingTable(table)) {
          throw apiError(400, {
            code: 'not_readable_as_a_mapping_table',
            whatHappened: 'This payload could not be read as a mapping table. It needs a mappingId, a version, a status, and entries — each with a domain (tax_code/uom/department/account/branch/identity/document_kind), a legacyValue, a targetValue and a rationale.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was approved. Correct the table and send it again.',
          });
        }
        if (table.tenantId !== ctx.tenantId) {
          throw apiError(403, {
            code: 'mapping_belongs_to_another_tenant',
            whatHappened: 'This mapping table was built for a different tenant.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was approved. Approve a mapping under the tenant it was built for.',
          });
        }
        const result = approveMapping({ table, approvedBy: ctx.userId, now: deps.now() });
        if (!result.ok) {
          throw apiError(422, {
            code: result.refusedBecause!,
            whatHappened: result.conflicts.length > 0 ? `${result.detail} — ${result.conflicts.join('; ')}` : result.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: 'No mapping was approved. Resolve what is named above — a one-legacy-value-to-two-targets conflict, a missing rationale, or an empty table — and approve again. A change to an already-approved table is a new version.',
          });
        }
        return { status: 200, body: result.table };
      },
    },
    {
      // MG-03 — mapping, the coverage half. Coverage is measured against the values ACTUALLY present in
      // the extract, never against the table's own size: "142 mappings approved" says nothing, while
      // "9 products carry a code no approved mapping covers" is the fact that decides whether the load
      // is safe. Read-only; every uncovered value is an exception to resolve, never a default to apply.
      api: 'API-12', method: 'POST', path: '/v1/migration/mapping/coverage',
      permission: 'migration.mapping.read', idempotent: true,
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const b = ctx.body;
        const table = isObj(b) ? b['table'] : undefined;
        const observed = isObj(b) ? b['observed'] : undefined;
        if (!isMappingTable(table) || !Array.isArray(observed) || !observed.every(isObservedValue)) {
          throw apiError(400, {
            code: 'not_readable_as_a_coverage_check',
            whatHappened: 'This payload could not be read as a coverage check. It needs the mapping table and the values observed in the extract — each an entry of { domain, value, rows }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was assessed. Send the table alongside the values actually present in the source.',
          });
        }
        if (table.tenantId !== ctx.tenantId) {
          throw apiError(403, {
            code: 'mapping_belongs_to_another_tenant',
            whatHappened: 'This mapping table was built for a different tenant.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was assessed. Measure coverage under the tenant the mapping was built for.',
          });
        }
        return { status: 200, body: assessCoverage({ tenantId: ctx.tenantId, table, observed }) };
      },
    },
    {
      // MG-04 — cleaning. Find everything wrong with the legacy data and CHANGE NONE OF IT: duplicate
      // products, a barcode on two products, negative stock, a batch with no expiry, a document whose
      // total disagrees with its lines, an unmapped tax code (blocking — defaulting it is a zero
      // rating). Cleaning proposes; it never decides, never merges, never drops (hard rules #2/#6). The
      // report is severity-ordered by money and law, so the working queue is right. Read-only: the
      // response even carries `nothingWasModified: true` so a caller cannot assume otherwise.
      api: 'API-12', method: 'POST', path: '/v1/migration/cleaning/exceptions',
      permission: 'migration.cleaning.read', idempotent: true,
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const b = ctx.body;
        const ds = isObj(b) ? b['dataset'] : undefined;
        const ARRAYS = ['products', 'stock', 'customers', 'suppliers', 'documents', 'lines'] as const;
        if (!isObj(ds) || ARRAYS.some((f) => ds[f] !== undefined && !Array.isArray(ds[f]))) {
          throw apiError(400, {
            code: 'not_readable_as_a_dataset',
            whatHappened: 'This payload could not be read as a legacy dataset. It needs a dataset object whose products, stock, customers, suppliers, documents and lines are each a list (any may be omitted, but present ones must be lists).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was assessed and nothing was changed — cleaning only ever reads. Correct the dataset and send it again.',
          });
        }
        const mappingTable = isObj(b) ? b['mappingTable'] : undefined;
        const rateRevisionDate = isObj(b) ? b['rateRevisionDate'] : undefined;
        if (mappingTable !== undefined && !isMappingTable(mappingTable)) {
          throw apiError(400, {
            code: 'not_readable_as_a_mapping_table',
            whatHappened: 'The mappingTable supplied for tax judgement could not be read as a mapping table.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was assessed. Send a valid mapping table, or omit it (tax codes are then not judged, never guessed).',
          });
        }
        if (rateRevisionDate !== undefined && typeof rateRevisionDate !== 'string') {
          throw apiError(400, {
            code: 'not_readable_as_a_date',
            whatHappened: 'rateRevisionDate must be a date string when supplied.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was assessed. Send an ISO date, or omit it.',
          });
        }
        const dataset: LegacyDataset = {
          seed: 0,
          products: (ds['products'] ?? []) as LegacyDataset['products'],
          stock: (ds['stock'] ?? []) as LegacyDataset['stock'],
          customers: (ds['customers'] ?? []) as LegacyDataset['customers'],
          suppliers: (ds['suppliers'] ?? []) as LegacyDataset['suppliers'],
          documents: (ds['documents'] ?? []) as LegacyDataset['documents'],
          lines: (ds['lines'] ?? []) as LegacyDataset['lines'],
          plantedFaults: {} as LegacyDataset['plantedFaults'],
          plantedIds: {} as LegacyDataset['plantedIds'],
        };
        try {
          const report = detectExceptions({
            tenantId: ctx.tenantId, dataset,
            ...(mappingTable === undefined ? {} : { mappingTable }),
            ...(rateRevisionDate === undefined ? {} : { rateRevisionDate }),
          });
          return { status: 200, body: report };
        } catch {
          throw apiError(400, {
            code: 'not_readable_as_a_dataset',
            whatHappened: 'The legacy dataset could not be assessed — a record was shaped in a way the detectors could not read.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was changed — cleaning only reads. Check the records against the legacy field shapes and send again.',
          });
        }
      },
    },
    {
      // MG-05 — trial load. Run the mapped and cleaned data into a NON-production rehearsal at full
      // volume and report how long it took: the cutover window is a real evening, so timing is an
      // output, not a footnote. Refuses, by name, a load that rehearses nothing — no operator, an
      // extract not verified against its seal (MG-02), open blocking exceptions (MG-04), or a target
      // not prepared empty (a load that only works once is the cutover, not a rehearsal). The
      // production check runs first and is absolute (hard rule #7).
      api: 'API-12', method: 'POST', path: '/v1/migration/trial-loads',
      permission: 'migration.trial.run', idempotent: true,
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const b = ctx.body;
        const rowsToLoad = isObj(b) ? b['rowsToLoad'] : undefined;
        const elapsedMs = isObj(b) ? b['elapsedMs'] : undefined;
        const extractVerified = isObj(b) ? b['extractVerified'] : undefined;
        const blockingExceptionsOpen = isObj(b) ? b['blockingExceptionsOpen'] : undefined;
        const targetPreparedEmpty = isObj(b) ? b['targetPreparedEmpty'] : undefined;
        const fullVolumeRows = isObj(b) ? b['fullVolumeRows'] : undefined;
        const trialId = isObj(b) && typeof b['trialId'] === 'string' && b['trialId'] !== ''
          ? b['trialId'] : `trial-${ctx.tenantId}-${deps.now()}`;
        if (typeof rowsToLoad !== 'number' || typeof elapsedMs !== 'number'
          || typeof extractVerified !== 'boolean' || typeof blockingExceptionsOpen !== 'number'
          || typeof targetPreparedEmpty !== 'boolean'
          || (fullVolumeRows !== undefined && typeof fullVolumeRows !== 'number')) {
          throw apiError(400, {
            code: 'not_readable_as_a_trial_load',
            whatHappened: 'This payload could not be read as a trial load. It needs rowsToLoad, elapsedMs, extractVerified (was the extract verified against its seal, MG-02), blockingExceptionsOpen (MG-04), and targetPreparedEmpty.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was loaded. Correct the fields and run the trial again.',
          });
        }
        const target = await deps.target(ctx.tenantId);
        const result = runTrialLoad({
          plan: {
            trialId, tenantId: ctx.tenantId, target, rowsToLoad,
            operator: ctx.userId, extractVerified, blockingExceptionsOpen, targetPreparedEmpty,
          },
          elapsedMs,
          ...(fullVolumeRows === undefined ? {} : { fullVolumeRows }),
        });
        if (!result.ok) {
          // A precondition stopped the rehearsal. Understood but cannot proceed → 422. (production_target
          // cannot occur here — assertSafeTarget already refused a production target with 403.)
          throw apiError(422, {
            code: result.refusedBecause!,
            whatHappened: result.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was loaded into the rehearsal. Resolve what is named above and run the trial again.',
          });
        }
        return { status: 200, body: result };
      },
    },
    {
      // MG-06 — reconciliation. Compare the loaded totals against the legacy control totals and decide
      // QG-07 (the cutover gate). The check that makes this worth running: a total whose two sides were
      // derived the SAME WAY reconciles nothing, and it is refused here (422) — it is the one migration
      // mistake nobody notices, because the report is green. A difference is reconciled, explained to
      // the rupee by approved exclusions, or OPEN; QG-07 passes only when every total is
      // reconciled/explained AND signed. Read-only assessment; the tenant is stamped from the caller.
      api: 'API-12', method: 'POST', path: '/v1/migration/reconciliation',
      permission: 'migration.reconciliation.read', idempotent: true,
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const b = ctx.body;
        const rawTotals = isObj(b) ? b['totals'] : undefined;
        if (!Array.isArray(rawTotals) || !rawTotals.every(isControlTotal)) {
          throw apiError(400, {
            code: 'not_readable_as_control_totals',
            whatHappened: 'This payload could not be read as control totals. Each needs a totalId, a kind (migration/stock/financial/tax/loyalty), a name, a unit (rows/quantity/minor_currency/points), a legacyValue and loadedValue, and — crucially — a legacyDerivation and loadedDerivation saying where each side came from.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was assessed. Correct the totals and send them again.',
          });
        }
        let acc: readonly ControlTotal[] = [];
        for (const t of rawTotals) {
          const stamped: ControlTotal = { ...t, tenantId: ctx.tenantId };
          const r = recordControlTotal({ totals: acc, total: stamped });
          if (!r.ok) {
            // Most importantly same_derivation_both_sides — a self-comparison wearing the costume of a check.
            throw apiError(422, {
              code: r.refusedBecause!,
              whatHappened: r.detail,
              wasItSaved: 'not_saved',
              nextSafeAction: 'Nothing was assessed. Give the two sides different, independent derivations (or a unique id), then send again.',
            });
          }
          acc = r.totals;
        }
        return { status: 200, body: assessReconciliation({ tenantId: ctx.tenantId, totals: acc }) };
      },
    },
    {
      // MG-06 sign-off — put a NAME to a control total (QG-07). Two refusals matter: the person who ran
      // the load cannot sign its totals (§28 — they already believe it worked, which is the whole
      // reason a second pair of eyes exists), and a FINANCE or TAX total is the chartered accountant's
      // to sign and nobody else's (M23 / C-01). The signer is the authenticated caller and their role
      // is read from their OWN grants, never the body. There is no provisional signature — an open
      // total is refused, because this is the last place a wrong opening balance can be stopped.
      api: 'API-12', method: 'POST', path: '/v1/migration/control-totals/sign',
      permission: 'migration.controltotal.sign', idempotent: true,
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const b = ctx.body;
        const rawTotals = isObj(b) ? b['totals'] : undefined;
        const totalId = isObj(b) ? b['totalId'] : undefined;
        const loadOperator = isObj(b) ? b['loadOperator'] : undefined;
        const statement = isObj(b) ? b['statement'] : undefined;
        if (!Array.isArray(rawTotals) || !rawTotals.every(isControlTotal)
          || typeof totalId !== 'string' || totalId === ''
          || typeof loadOperator !== 'string' || loadOperator === ''
          || typeof statement !== 'string' || statement === '') {
          throw apiError(400, {
            code: 'not_readable_as_a_signature',
            whatHappened: 'This payload could not be read as a control-total signature. It needs the control totals, the totalId to sign, who ran the load (loadOperator), and the signer\'s statement.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was signed. Correct the fields and send them again.',
          });
        }
        const totals = rawTotals.map((t) => ({ ...t, tenantId: ctx.tenantId }));
        const roles = deps.rolesOf ? await deps.rolesOf(ctx.tenantId, ctx.userId) : [];
        // The role that carries authority for THIS signature: a chartered accountant if the signer
        // actually holds that role (only they may sign finance/tax), otherwise the caller's own role,
        // recorded for the audit. Read from grants, never taken from the request body.
        const signerRole = roles.includes('chartered_accountant') ? 'chartered_accountant' : (roles[0] ?? 'unknown');
        const result = signControlTotal({
          totals, totalId, signedBy: ctx.userId, signerRole, loadOperator, statement, now: deps.now(),
        });
        if (!result.ok) {
          throw apiError(422, {
            code: result.refusedBecause!,
            whatHappened: result.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was signed. The person who ran the load cannot sign its totals; a finance or tax total is the chartered accountant\'s to sign; and an open total cannot be signed at all.',
          });
        }
        return { status: 200, body: { totals: result.totals } };
      },
    },
    {
      // MG-08 — opening balances as EVENTS, never a written balance (hard rule #2). Turn signed control
      // totals into append-only opening events. Refuses unless QG-07 has passed and every position
      // traces to a SIGNED total — because an opening event cannot be withdrawn once banked, and a
      // compensating event on day one is a permanent scar on the ledger. An opening quantity with no
      // event behind it is the one number in the shop that can never be explained.
      api: 'API-12', method: 'POST', path: '/v1/migration/opening-events',
      permission: 'migration.opening.build', idempotent: true,
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const b = ctx.body;
        const rawTotals = isObj(b) ? b['totals'] : undefined;
        const rawPositions = isObj(b) ? b['positions'] : undefined;
        if (!Array.isArray(rawTotals) || !rawTotals.every(isControlTotal)
          || !Array.isArray(rawPositions) || !rawPositions.every(isOpeningPosition)) {
          throw apiError(400, {
            code: 'not_readable_as_opening_state',
            whatHappened: 'This payload could not be read as an opening state. It needs the signed control totals and the opening positions — each { kind, subjectId, fromTotalId, and a quantity / valueMinor / points }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was built. Correct the totals and positions and send again.',
          });
        }
        const totals = rawTotals.map((t) => ({ ...t, tenantId: ctx.tenantId }));
        const result = buildOpeningEvents({ tenantId: ctx.tenantId, totals, positions: rawPositions, now: deps.now() });
        if (!result.ok) {
          throw apiError(422, {
            code: result.refusedBecause!,
            whatHappened: result.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: 'No opening events were built. QG-07 must have passed and every opening figure must trace to a SIGNED total — a balance with no signature behind it can never be explained.',
          });
        }
        return { status: 200, body: { events: result.events, detail: result.detail } };
      },
    },
    {
      // MG-09 — delta. Between the final extract and cutover the shop keeps trading (P-01), so a delta
      // always exists. Apply it EXACTLY ONCE (§31.1): a re-sent change is already_applied (a success, so
      // an interrupted run resumes at midnight instead of being decided by hand), and a change dated
      // before the extract cutoff is refused as already loaded — the double-count MG-09 exists to
      // prevent. Every outcome is a visible line in the body (P-08). Refuses production first (#7).
      api: 'API-12', method: 'POST', path: '/v1/migration/deltas',
      permission: 'migration.delta.apply', idempotent: true,
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const b = ctx.body;
        const rawChanges = isObj(b) ? b['changes'] : undefined;
        const extractCutoff = isObj(b) ? b['extractCutoff'] : undefined;
        const alreadyApplied = isObj(b) ? b['alreadyApplied'] : undefined;
        if (!Array.isArray(rawChanges) || !rawChanges.every(isDeltaChange)
          || typeof extractCutoff !== 'string' || extractCutoff === ''
          || (alreadyApplied !== undefined && (!Array.isArray(alreadyApplied) || !alreadyApplied.every((k) => typeof k === 'string')))) {
          throw apiError(400, {
            code: 'not_readable_as_a_delta',
            whatHappened: 'This payload could not be read as a delta. It needs the changes (each { changeKey, entity, legacyId, operation, changedAt }), the extractCutoff, and optionally the keys already applied by an earlier run.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was applied. Correct the delta and send it again.',
          });
        }
        const target = await deps.target(ctx.tenantId);
        const result = applyDelta({
          target, changes: rawChanges, extractCutoff,
          ...(alreadyApplied === undefined ? {} : { alreadyApplied: alreadyApplied as readonly string[] }),
        });
        return { status: 200, body: result };
      },
    },
    {
      // MG-10/11 — the cutover gate. DERIVES the eight checks from the evidence the earlier steps
      // produced ("not known" fails, never a comfortable default), then decides GO / NO GO with every
      // failed check named at once. This is the gate on the single most irreversible action in the
      // project — the night the shop stops running on the old system. Whichever way it goes, the shop
      // opens the next morning (the decision's shopKeepsTrading is typed `true`, P-01).
      api: 'API-12', method: 'POST', path: '/v1/migration/cutover/decision',
      permission: 'migration.cutover.decide', idempotent: true,
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const b = ctx.body;
        const cutoverId = isObj(b) && typeof b['cutoverId'] === 'string' && b['cutoverId'] !== ''
          ? b['cutoverId'] : `cutover-${ctx.tenantId}-${deps.now()}`;
        const ev = isObj(b) ? b['evidence'] : undefined;
        if (!isObj(ev)) {
          throw apiError(400, {
            code: 'not_readable_as_cutover_evidence',
            whatHappened: 'This payload could not be read as cutover evidence. It needs an evidence object; any of its parts may be absent, and an absent one FAILS its check rather than passing it.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was decided. Send { evidence: { … } } assembled from the earlier steps.',
          });
        }
        // Each PRESENT part is checked on the field the gate actually reads; an absent part is left
        // undefined so the derived checklist fails or marks it not-known. A malformed present part is
        // refused rather than silently treated as a pass.
        const malformed = (): never => {
          throw apiError(400, {
            code: 'malformed_cutover_evidence',
            whatHappened: 'A part of the cutover evidence was the wrong shape.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was decided. Each present part must match what its producing step returns.',
          });
        };
        const recon = ev['reconciliation'];
        if (recon !== undefined && (!isObj(recon) || typeof recon['qg07Passed'] !== 'boolean')) malformed();
        const parallel = ev['parallel'];
        if (parallel !== undefined && (!isObj(parallel) || typeof parallel['sufficient'] !== 'boolean')) malformed();
        const exceptions = ev['exceptions'];
        if (exceptions !== undefined && (!isObj(exceptions) || typeof exceptions['clearForCutover'] !== 'boolean' || !Array.isArray(exceptions['blockingUnresolved']))) malformed();
        const edge = ev['edgeUnsyncedItems'];
        if (edge !== undefined && typeof edge !== 'number') malformed();
        const deltaAppliedAt = ev['deltaAppliedAt'];
        if (deltaAppliedAt !== undefined && typeof deltaAppliedAt !== 'string') malformed();
        const rollbackDemonstratedAt = ev['rollbackDemonstratedAt'];
        if (rollbackDemonstratedAt !== undefined && typeof rollbackDemonstratedAt !== 'string') malformed();
        const ownerGoBy = ev['ownerGoBy'];
        if (ownerGoBy !== undefined && typeof ownerGoBy !== 'string') malformed();
        const team = ev['namedTeam'];
        if (team !== undefined && (!Array.isArray(team) || !team.every(isTeamMember))) malformed();

        const evidence: CutoverEvidence = {
          ...(recon === undefined ? {} : { reconciliation: recon as unknown as ReconciliationReport }),
          ...(parallel === undefined ? {} : { parallel: parallel as unknown as ParallelRunPosition }),
          ...(exceptions === undefined ? {} : { exceptions: exceptions as unknown as OutstandingExceptions }),
          ...(edge === undefined ? {} : { edgeUnsyncedItems: edge as number }),
          ...(deltaAppliedAt === undefined ? {} : { deltaAppliedAt: deltaAppliedAt as string }),
          ...(rollbackDemonstratedAt === undefined ? {} : { rollbackDemonstratedAt: rollbackDemonstratedAt as string }),
          ...(ownerGoBy === undefined ? {} : { ownerGoBy: ownerGoBy as string }),
          ...(team === undefined ? {} : { namedTeam: team as readonly TeamMember[] }),
        };
        const derived = buildCutoverChecklist({ cutoverId, tenantId: ctx.tenantId, evidence });
        const decision = decideCutover(derived.checklist);
        return { status: 200, body: { decision, checks: derived.checks, notKnown: derived.notKnown, detail: derived.detail } };
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
    {
      // MG-07 — propose leaving legacy data behind. An exclusion is a WRITTEN, VALUED proposal; it is
      // not a smaller migration until the owner approves it, and until then it explains nothing in the
      // reconciliation (it sits as an undecided difference). Age alone is refused as a reason (the
      // engine's rule — a warranty claim in year four is exactly the record somebody needs). Open-once
      // per id. Refuses production (#7).
      api: 'API-12', method: 'POST', path: '/v1/migration/history/exclusions',
      permission: 'migration.exclusion.propose', idempotent: true,
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const exclusionId = typeof b['exclusionId'] === 'string' ? b['exclusionId'] : '';
        if (exclusionId === '' || typeof b['scope'] !== 'string' || !EXCLUSION_SCOPES.includes(b['scope'] as string)
          || typeof b['description'] !== 'string' || !Number.isInteger(b['recordCount']) || !Number.isInteger(b['valueMinor'])
          || typeof b['reason'] !== 'string') {
          throw apiError(400, {
            code: 'not_readable_as_an_exclusion',
            whatHappened: 'An exclusion needs an id, a scope (documents_before/entity_kind/named_records/inactive_records), a description, a whole record count and value in paise, and a reason.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was proposed. Send the exclusion with a reason that is unusability, not age.',
          });
        }
        if ((await deps.exclusions(ctx.tenantId)).some((e) => e.exclusionId === exclusionId)) {
          throw apiError(409, {
            code: 'exclusion_already_exists',
            whatHappened: `Exclusion ${exclusionId} already exists — a decided exclusion stays decided, and its record is the evidence.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Use a new id, or read the existing exclusion.',
          });
        }
        const result = proposeExclusion({
          exclusionId, tenantId: ctx.tenantId, scope: b['scope'] as ExclusionScope,
          description: b['description'] as string, recordCount: b['recordCount'] as number,
          valueMinor: b['valueMinor'] as number, reason: b['reason'] as string,
          proposedBy: ctx.userId, now: deps.now(),
        });
        if (!result.ok || result.exclusion === undefined) {
          throw apiError(422, {
            code: result.refusedBecause!,
            whatHappened: result.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was proposed. State why the data is not usable — age alone is never a reason, and the money it covers must be stated so it can be reconciled against.',
          });
        }
        await deps.recordExclusion(ctx.tenantId, result.exclusion);
        return { status: 201, body: result.exclusion };
      },
    },
    {
      // MG-07 — the OWNER approves or rejects an exclusion, in writing (OD-05). The proposer cannot
      // approve their own even if they are the owner (the person who decided the data is not worth
      // migrating is not the person to confirm it), and only the owner may decide. Refuses production (#7).
      api: 'API-12', method: 'POST', path: '/v1/migration/history/exclusions/:exclusionId/decision',
      permission: 'migration.exclusion.approve', idempotent: true,
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const exclusionId = ctx.params['exclusionId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (typeof b['approve'] !== 'boolean' || typeof b['ownerStatement'] !== 'string') {
          throw apiError(400, {
            code: 'not_readable_as_a_decision',
            whatHappened: 'A decision needs approve (true/false) and a written ownerStatement.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was decided. Send the decision in writing — a year later the record is all there is.',
          });
        }
        const existing = (await deps.exclusions(ctx.tenantId)).find((e) => e.exclusionId === exclusionId);
        if (existing === undefined) {
          throw apiError(404, {
            code: 'no_such_exclusion',
            whatHappened: `There is no proposed exclusion "${exclusionId}" to decide.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Check the exclusion id on the history list and try again.',
          });
        }
        const owner = await deps.ownerId(ctx.tenantId);
        if (owner === undefined) {
          throw apiError(409, {
            code: 'nobody_is_recorded_as_the_owner',
            whatHappened: 'No user holds the owner role for this tenant, so there is nobody this decision could be checked against.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was decided. Record who the owner is first — OD-05 requires the owner to approve an exclusion.',
          });
        }
        const result = approveExclusion({
          exclusion: existing, decidedBy: ctx.userId, decidedByIsOwner: ctx.userId === owner,
          approve: b['approve'] as boolean, ownerStatement: b['ownerStatement'] as string, now: deps.now(),
        });
        if (!result.ok || result.exclusion === undefined) {
          const status = result.refusedBecause === 'not_the_owner' || result.refusedBecause === 'proposer_cannot_approve' ? 403 : 422;
          throw apiError(status, {
            code: result.refusedBecause!,
            whatHappened: result.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was decided. Only the owner may approve an exclusion, and not one they proposed themselves.',
          });
        }
        await deps.recordExclusion(ctx.tenantId, result.exclusion);
        return { status: 200, body: result.exclusion };
      },
    },
    {
      // MG-07 read — every exclusion and what they add up to, split by whether the owner has decided.
      // Only the APPROVED figure may explain a reconciliation difference (MG-06); undecided exclusions
      // leave the difference open, which forces the decision before cutover rather than after.
      api: 'API-12', method: 'GET', path: '/v1/migration/history/exclusions',
      permission: 'migration.reconciliation.read',
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const all = await deps.exclusions(ctx.tenantId);
        return { status: 200, body: { exclusions: all, position: exclusionPosition(all), asAt: deps.now() } };
      },
    },
    {
      // MG-12 — may the legacy SYSTEM be switched off? A what-if over the supplied archive: retention is
      // a DATE in the future (run from the data, not from confidence), the restore must have been
      // demonstrated, the cutover must be accepted, and no assessment may still need the records. Every
      // blocker is named at once. Retiring the system NEVER deletes the data (hard rule #6) — the archive
      // stays read-only. "today" is the server clock, never the body, so nobody fakes elapsed retention.
      // Computes and stores nothing. Refuses a production target first (#7).
      api: 'API-12', method: 'POST', path: '/v1/migration/retirement/assessment',
      permission: 'migration.retirement.assess', idempotent: true,
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isLegacyArchive(b['archive']) || typeof b['cutoverAccepted'] !== 'boolean'
          || !Number.isInteger(b['openAssessments']) || (b['openAssessments'] as number) < 0) {
          throw apiError(400, {
            code: 'not_readable_as_a_retirement_check',
            whatHappened: 'A retirement check needs a read-only archive (with its retention years and earliest/latest record dates), whether the cutover is accepted, and a whole non-negative count of open assessments.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was assessed and nothing was changed — this check reads and reports, it never deletes data or switches anything off.',
          });
        }
        // The archive is FOR this tenant — stamped from the authenticated context, never the body.
        const archive: LegacyArchive = { ...(b['archive'] as LegacyArchive), tenantId: ctx.tenantId };
        const assessment = assessRetirement({
          archive,
          cutoverAccepted: b['cutoverAccepted'] as boolean,
          openAssessments: b['openAssessments'] as number,
          today: deps.now(),
        });
        return { status: 200, body: assessment };
      },
    },
  ];
}
