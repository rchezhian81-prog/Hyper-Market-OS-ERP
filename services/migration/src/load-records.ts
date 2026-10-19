// API-12 — the LOAD RECORD: who ran a real-data load, read from the signed-in session, never typed (MG-05 · MG-06 ·
// §28 · §34.1 · OB-241 · STEP-1 §4 item 9).
//
// Until now "who ran the load" was a name somebody typed: the manifest's `operator`, or the `operatorId` the owner
// put in an extraction-run record. The control-total signature compared the signer against that name — so a signer
// who had run the load could name somebody else and sign their own work. Here the load is RECORDED by the person
// running it, in their own authenticated session, and the record's operator is `ctx.userId`. A body that tries to
// say who the operator is, is refused by name.
//
// One record per load id carries the slice (OB-241: one department's products, barcodes, tax classes and prices)
// as it was STAGED: its digest, the counts, and the full exception list — every quarantined row with its source
// key and reason (§34.1 reject/quarantine file). Three more facts hang off it, each append-only:
//
//   • ACCEPTANCE — a named person accepts THIS exception list (bound by the digest). Without it the load is never
//     applied (the CLI's gate, `sliceApplyGate`, reads the acceptance from here — not from a file).
//   • APPLIED — the operator says what landed. Only the person who staged the load may record that it was applied.
//   • the OPERATOR — read by the control-total signature: whoever ran a load cannot sign its totals.
//
// Every route refuses a production target first (hard rule #7).

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import { looksLikeNoReason } from '../../../packages/migration/src/verification-report';
import type { SliceAcceptance, SliceException } from '../../../packages/migration/src/slice-import';
import { assertSafeTarget } from './guards';
import type { MigrationDeps } from './index';

/** The most rows one load record may quarantine. More than this is a wrong mapping, not a list to accept row by row. */
export const MAX_RECORDED_EXCEPTIONS = 4_000;

export interface LoadRecord {
  readonly loadId: string;
  /** The person who ran it — the authenticated caller, never a body field. */
  readonly operator: string;
  readonly recordedAt: string;
  /** The staged slice this record describes; a re-stage after fixing a file is a new record (newest applies). */
  readonly sliceDigest: string;
  /** The pilot department a slice load covers (OB-241). Absent on a full-extract load (`pnpm run migration:load`). */
  readonly department?: { readonly categoryId: string; readonly name: string };
  readonly counts: Readonly<Record<string, { readonly rows: number; readonly staged: number; readonly quarantined: number }>>;
  readonly exceptions: readonly SliceException[];
}

export interface LoadApplied {
  readonly loadId: string;
  readonly sliceDigest: string;
  readonly appliedBy: string;
  readonly appliedAt: string;
  readonly acceptedBy: string;
  readonly landed: Readonly<Record<string, number>>;
  readonly failedSteps: number;
}

export interface LoadView {
  readonly record: LoadRecord;
  /** Earlier stagings of the same load — kept, never replaced (hard rule #6). */
  readonly earlierStagings: number;
  readonly acceptance?: SliceAcceptance;
  readonly applied?: LoadApplied;
  readonly detail: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isCount = (v: unknown): boolean => isObj(v) && ['rows', 'staged', 'quarantined'].every((k) => Number.isInteger(v[k]) && (v[k] as number) >= 0);
const FILES = new Set(['products.csv', 'barcodes.csv', 'tax-classes.csv', 'prices.csv']);

function isSliceException(v: unknown): v is SliceException {
  return isObj(v) && typeof v['file'] === 'string' && FILES.has(v['file']) && Number.isInteger(v['line'])
    && typeof v['sourceKey'] === 'string' && isStr(v['code']) && isStr(v['reason']) && v['disposition'] === 'quarantined'
    && (v['column'] === undefined || typeof v['column'] === 'string');
}

const notWired = (): never => {
  throw apiError(503, {
    code: 'load_record_store_not_wired',
    whatHappened: 'This deployment has no ledger to keep load records in.',
    wasItSaved: 'not_saved',
    nextSafeAction: 'Nothing was recorded. Run against a deployment with the event ledger configured.',
  });
};

/** The newest record for each load id, and how many stagings came before it. */
export async function latestLoadRecords(deps: MigrationDeps, tenantId: string): Promise<ReadonlyMap<string, { record: LoadRecord; earlier: number }>> {
  const all = deps.loadRecords === undefined ? [] : await deps.loadRecords(tenantId);
  const out = new Map<string, { record: LoadRecord; earlier: number }>();
  for (const r of all) {
    const held = out.get(r.loadId);
    out.set(r.loadId, { record: r, earlier: held === undefined ? 0 : held.earlier + 1 });
  }
  return out;
}

/**
 * Who ran the load, for the control-total signature (§28) — read from the STORED load records.
 *
 * When this deployment keeps load records, they are the only answer: no record, no operator, and nothing can be
 * signed. A bare stub that keeps none falls back to the extraction-run record it always used, so the older routes'
 * own tests keep their meaning — the composition root always wires the records.
 */
export async function storedLoadOperators(deps: MigrationDeps, tenantId: string): Promise<{ readonly operators: readonly string[]; readonly latest?: string; readonly source: 'load_record' | 'extraction_run' | 'none' }> {
  if (deps.loadRecords !== undefined) {
    const records = await deps.loadRecords(tenantId);
    const operators = [...new Set(records.map((r) => r.operator))];
    const latest = [...records].sort((a, b) => (a.recordedAt < b.recordedAt ? -1 : a.recordedAt > b.recordedAt ? 1 : 0)).at(-1)?.operator;
    return latest === undefined ? { operators: [], source: 'none' } : { operators, latest, source: 'load_record' };
  }
  const declared = await deps.extractionOperator(tenantId);
  return declared === undefined ? { operators: [], source: 'none' } : { operators: [declared], latest: declared, source: 'extraction_run' };
}

/** The operator the signature rule compares a signer against: the signer themselves if they ran ANY load, else the latest. */
export async function loadOperatorFor(deps: MigrationDeps, tenantId: string, signer: string): Promise<string | undefined> {
  const { operators, latest } = await storedLoadOperators(deps, tenantId);
  if (operators.includes(signer)) return signer;
  return latest;
}

async function viewOf(deps: MigrationDeps, tenantId: string, loadId: string): Promise<LoadView | undefined> {
  const latest = (await latestLoadRecords(deps, tenantId)).get(loadId);
  if (latest === undefined) return undefined;
  const acceptances = deps.sliceAcceptances === undefined ? [] : await deps.sliceAcceptances(tenantId, loadId);
  const acceptance = acceptances.filter((a) => a.sliceDigest === latest.record.sliceDigest).at(0);
  const applied = (deps.loadsApplied === undefined ? [] : await deps.loadsApplied(tenantId, loadId))
    .filter((a) => a.sliceDigest === latest.record.sliceDigest).at(-1);
  const q = latest.record.exceptions.length;
  return {
    record: latest.record, earlierStagings: latest.earlier,
    ...(acceptance === undefined ? {} : { acceptance }),
    ...(applied === undefined ? {} : { applied }),
    detail: applied !== undefined
      ? `applied by ${applied.appliedBy} on ${applied.appliedAt}; ${q} row(s) quarantined and accepted by ${applied.acceptedBy}`
      : acceptance !== undefined
        ? `staged by ${latest.record.operator}; ${q} quarantined row(s) accepted by ${acceptance.acceptedBy} — ready to apply`
        : `staged by ${latest.record.operator}; ${q} quarantined row(s) waiting for a named person to accept the exception list — nothing may be applied until then`,
  };
}

export function loadRecordRoutes(deps: MigrationDeps): readonly Route[] {
  return [
    {
      // Record a staged load. Body: { sliceDigest, department: { categoryId, name }, counts, exceptions[] }. The
      // operator is the caller. Re-sending the same staging is idempotent; a new digest (a re-stage) appends a new
      // record and the newest applies; a different person staging the same load id is refused — a load has one
      // operator, or "who ran it" stops meaning anything.
      api: 'API-12', method: 'POST', path: '/v1/migration/loads/:loadId',
      permission: 'migration.load.record', idempotent: true,
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const loadId = (ctx.params['loadId'] ?? '').trim();
        const b = isObj(ctx.body) ? ctx.body : {};
        if (b['operator'] !== undefined || b['operatorId'] !== undefined || b['recordedBy'] !== undefined) {
          throw apiError(422, {
            code: 'load_operator_is_read_from_the_session',
            whatHappened: 'Who ran a load is the person signed in when it is recorded — never a name in the request.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the load record without operator; run it signed in as the person doing the load. Nothing was recorded.',
          });
        }
        const department = b['department'];
        const counts = b['counts'];
        const exceptions = b['exceptions'];
        if (!/^[A-Za-z0-9._-]{1,80}$/.test(loadId) || !isStr(b['sliceDigest'])
          || (department !== undefined && (!isObj(department) || !isStr(department['categoryId']) || !isStr(department['name'])))
          || !isObj(counts) || !Object.entries(counts).every(([k, v]) => /^[a-z0-9-]{1,60}\.csv$/.test(k) && isCount(v))
          || !Array.isArray(exceptions) || !exceptions.every(isSliceException)) {
          throw apiError(400, {
            code: 'not_readable_as_a_load_record',
            whatHappened: 'A load record needs the load id in the path (letters, digits, dot, dash, underscore) and { sliceDigest, department?: { categoryId, name }, counts: { "<file>.csv": { rows, staged, quarantined } }, exceptions[] } — every quarantined row with file, line, sourceKey, code, reason and disposition "quarantined".',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was recorded. Stage the slice with the load command, which sends exactly this.',
          });
        }
        if (exceptions.length > MAX_RECORDED_EXCEPTIONS) {
          throw apiError(422, {
            code: 'too_many_quarantined_rows',
            whatHappened: `${exceptions.length} rows are quarantined — more than ${MAX_RECORDED_EXCEPTIONS}. That is a wrong export or mapping, not a list a person can accept row by row.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was recorded. Fix the export or the template mapping and stage again.',
          });
        }
        if (deps.recordLoad === undefined) notWired();
        const held = (await latestLoadRecords(deps, ctx.tenantId)).get(loadId);
        if (held !== undefined && held.record.operator !== ctx.userId) {
          throw apiError(409, {
            code: 'load_has_another_operator',
            whatHappened: `Load ${loadId} was staged by ${held.record.operator}. One load has one operator.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was recorded. Use a new load id for your own load.',
          });
        }
        if (held !== undefined && held.record.sliceDigest === b['sliceDigest']) {
          return { status: 200, body: { record: held.record, alreadyRecorded: true } };
        }
        if (held !== undefined && (deps.loadsApplied === undefined ? [] : await deps.loadsApplied(ctx.tenantId, loadId)).length > 0) {
          throw apiError(409, {
            code: 'load_already_applied',
            whatHappened: `Load ${loadId} has already been applied. A changed slice is a new load, not a re-staging of the old one.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was recorded. Stage the change under a new load id — or as a delta (MG-09).',
          });
        }
        const record: LoadRecord = {
          loadId, operator: ctx.userId, recordedAt: deps.now(), sliceDigest: b['sliceDigest'] as string,
          ...(isObj(department) ? { department: { categoryId: (department['categoryId'] as string).trim(), name: (department['name'] as string).trim() } } : {}),
          counts: counts as LoadRecord['counts'], exceptions: exceptions as SliceException[],
        };
        await deps.recordLoad!(ctx.tenantId, record);
        return { status: 201, body: { record } };
      },
    },
    {
      // Accept the exception list of the load as it is NOW staged. Body: { sliceDigest, statement }. The acceptor is
      // the caller — a named person, in their own session. The digest must be the latest staging's: an acceptance
      // over a list the files no longer produce accepts nothing. The first acceptance of a staging stands.
      api: 'API-12', method: 'POST', path: '/v1/migration/loads/:loadId/exception-list/acceptance',
      permission: 'migration.load.accept', idempotent: true,
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const loadId = (ctx.params['loadId'] ?? '').trim();
        const b = isObj(ctx.body) ? ctx.body : {};
        if (!isStr(b['sliceDigest']) || typeof b['statement'] !== 'string' || b['acceptedBy'] !== undefined) {
          throw apiError(400, {
            code: 'not_readable_as_an_acceptance',
            whatHappened: 'Accepting an exception list needs { sliceDigest, statement }. Who accepts is the person signed in — never a name in the request.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was accepted. Send the digest the staging printed and what you checked.',
          });
        }
        if (looksLikeNoReason(b['statement'] as string)) {
          throw apiError(422, {
            code: 'acceptance_explains_nothing',
            whatHappened: 'An acceptance must say, in at least 20 characters, what you read and why the quarantined rows may stay behind. "OK" accepts things nobody read.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was accepted. Read the exception list and say what you decided.',
          });
        }
        const view = await viewOf(deps, ctx.tenantId, loadId);
        if (view === undefined) throw notFound(`load ${loadId}`);
        if (view.record.sliceDigest !== b['sliceDigest']) {
          throw apiError(409, {
            code: 'exception_list_changed',
            whatHappened: `Load ${loadId} is now staged as ${view.record.sliceDigest}, not ${b['sliceDigest'] as string}: the files changed after the list you read.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was accepted. Read the CURRENT exception list (GET /v1/migration/loads/:loadId) and accept that one.',
          });
        }
        if (view.acceptance !== undefined) {
          return { status: 200, body: { acceptance: view.acceptance, alreadyAccepted: true } };
        }
        if (deps.recordSliceAcceptance === undefined) notWired();
        const acceptance: SliceAcceptance = {
          sliceDigest: view.record.sliceDigest, acceptedBy: ctx.userId, acceptedAt: deps.now(),
          statement: (b['statement'] as string).trim(), quarantined: view.record.exceptions.length,
        };
        await deps.recordSliceAcceptance!(ctx.tenantId, loadId, acceptance);
        return { status: 201, body: { acceptance } };
      },
    },
    {
      // Record that the accepted slice was applied, and what landed. Only the load's own operator (the caller who
      // staged it) may say so, and only over an ACCEPTED staging — the server's half of "never apply silently".
      api: 'API-12', method: 'POST', path: '/v1/migration/loads/:loadId/applied',
      permission: 'migration.load.record', idempotent: true,
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const loadId = (ctx.params['loadId'] ?? '').trim();
        const b = isObj(ctx.body) ? ctx.body : {};
        const landed = b['landed'];
        if (!isStr(b['sliceDigest']) || !isObj(landed) || !Object.values(landed).every((n) => Number.isInteger(n) && (n as number) >= 0)
          || !Number.isInteger(b['failedSteps']) || (b['failedSteps'] as number) < 0) {
          throw apiError(400, {
            code: 'not_readable_as_an_applied_load',
            whatHappened: 'Recording an applied load needs { sliceDigest, landed: { group: count }, failedSteps }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was recorded.',
          });
        }
        const view = await viewOf(deps, ctx.tenantId, loadId);
        if (view === undefined) throw notFound(`load ${loadId}`);
        if (view.record.operator !== ctx.userId) {
          throw apiError(403, {
            code: 'not_the_load_operator',
            whatHappened: `Load ${loadId} was staged by ${view.record.operator}; ${ctx.userId} cannot record that it was applied.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was recorded. The operator who staged the load records its outcome.',
          });
        }
        if (view.record.sliceDigest !== b['sliceDigest'] || view.acceptance === undefined) {
          throw apiError(409, {
            code: view.acceptance === undefined ? 'exception_list_not_accepted' : 'exception_list_changed',
            whatHappened: view.acceptance === undefined
              ? `Nobody has accepted load ${loadId}'s exception list, so it may not be applied — a partial load is never applied silently.`
              : `Load ${loadId} is staged as ${view.record.sliceDigest}, not ${b['sliceDigest'] as string}.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was recorded.',
          });
        }
        if (deps.recordLoadApplied === undefined) notWired();
        const applied: LoadApplied = {
          loadId, sliceDigest: view.record.sliceDigest, appliedBy: ctx.userId, appliedAt: deps.now(), acceptedBy: view.acceptance.acceptedBy,
          landed: landed as Record<string, number>, failedSteps: b['failedSteps'] as number,
        };
        await deps.recordLoadApplied!(ctx.tenantId, applied);
        return { status: 201, body: { applied } };
      },
    },
    {
      // One load: its newest staging (with every quarantined row), its acceptance, whether it was applied.
      api: 'API-12', method: 'GET', path: '/v1/migration/loads/:loadId',
      permission: 'migration.load.read',
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const view = await viewOf(deps, ctx.tenantId, (ctx.params['loadId'] ?? '').trim());
        if (view === undefined) throw notFound(`load ${(ctx.params['loadId'] ?? '').trim()}`);
        return { status: 200, body: view };
      },
    },
  ];
}
