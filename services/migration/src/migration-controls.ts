// API-12 — the migration controls OB-288 package P5 adds (MG-09 · MG-10 · MG-11 · §34 · P-08 · hard rules #2, #6, #10):
//
//   • MG-09 DELTA BY TWO FULL EXPORTS (owner decision OB-309) — `POST /v1/migration/export-diffs/:diffId`: the export that
//     was loaded and the latest one of the same domain (items, prices, barcodes, suppliers, customers), read through a
//     column mapping, compared on the domain's key. Every difference is RECORDED as a blocking exception on the migration
//     register — the cutover cannot pass until a person decides each — and nothing is applied here. The register never
//     deletes one (hard rule #6). A diff id is one comparison: the same files again are the same run; other files under
//     the same id are refused.
//   • MG-10 THE BOOKS SIDE OF THE DAY — `POST /v1/migration/parallel-run/days/:businessDate/books`: the old ERP's purchase
//     register, supplier and customer outstanding, closing stock and gross-profit reports against head office's own
//     registers for the day (`books-comparison.ts`). The lines join the day's MG-10 record beside the sales lines (a day
//     recorded again with other figures is numbered apart — OB-263), so each difference needs its reason before the day
//     is signed; anything head office could not work out is NOT COMPARED, kept, and the day cannot be signed while any is.
//   • MG-11 BACKUP AND ROLLBACK LIMITS — `PUT /v1/migration/cutover/rollback-limits` (the OWNER's four numbers, each "not
//     set" until he enters it, frozen once the GO is recorded); `GET` it with the backup's standing; and
//     `POST /v1/migration/cutover/night-check` — on the night, head office's own observations (the largest money
//     control-total difference, how long the stalest store has been cut off, minutes since GO) against the agreed limits:
//     a crossed limit RAISES the rollback trigger (recorded once, raised to the owner) — a person still performs the one
//     labelled rollback, but nobody has to argue that it is time.
//
// Every route refuses a production target (`assertSafeTarget`, hard rule #7). Nothing here edits or deletes a record.

import { createHash } from 'node:crypto';
import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { assertSafeTarget } from './guards';
import type { MigrationDeps } from './index';
import type { CutoverGo } from './opening-reversal';
import { outstandingExceptions } from '../../../packages/migration/src/cleaning';
import { compareParallelDay, differencePrefixFor, type DayComparison } from '../../../packages/migration/src/cutover';
import { dayDigestOf } from '../../../packages/migration/src/parallel-day-sign';
import { OLD_ERP_FILE_MAX_BYTES, DATE_ORDERS, type DateOrder } from '../../../packages/migration/src/old-erp-reports';
import { EXPORT_DOMAINS, EXPORT_DOMAIN_SPECS, readExport, diffExports, diffExceptions, type ExportDomain } from '../../../packages/migration/src/export-diff';
import { BOOKS_REPORTS, BOOKS_AREAS, BOOKS_REPORT_SPECS, readBooksReport, compareBooksDay, type BooksReport, type HeadOfficeBooksDay, type Row, type BooksComparison } from '../../../packages/migration/src/books-comparison';
import {
  ROLLBACK_LIMIT_NAMES, ROLLBACK_LIMIT_WORDS, isLimitValue, limitsNotSet, backupStanding, crossedLimits,
  type RollbackLimits, type BackupReport, type CrossedLimit, type NightObservations,
} from '../../../packages/migration/src/rollback-limits';

/** One recorded comparison of two exports (MG-09). The files themselves are not kept — their digests are. */
export interface ExportDiffRun {
  readonly diffId: string;
  readonly domain: ExportDomain;
  readonly baselineDigest: string;
  readonly latestDigest: string;
  readonly baselineLabel: string;
  readonly latestLabel: string;
  readonly counts: { readonly baseline: number; readonly latest: number; readonly added: number; readonly changed: number; readonly removed: number; readonly unchanged: number };
  readonly exceptionIds: readonly string[];
  readonly by: string;
  readonly at: string;
}

/** The books side of one day as recorded (MG-10). */
export interface BooksDayRecord {
  readonly businessDate: string;
  readonly reports: readonly BooksReport[];
  readonly lines: number;
  readonly notCompared: BooksComparison['notCompared'];
  readonly dayDigest: string;
  readonly by: string;
  readonly at: string;
}

/** A rollback limit the night crossed, raised by itself (MG-11). */
export interface RaisedRollbackTrigger extends CrossedLimit {
  readonly cutoverId: string;
  readonly raisedAt: string;
  readonly raisedBy: string;
}

export interface MigrationControlsDeps {
  readonly rollbackLimits: (tenantId: string) => Promise<RollbackLimits | undefined>;
  readonly recordRollbackLimits: (tenantId: string, limits: RollbackLimits) => Promise<void>;
  readonly backups: (tenantId: string) => Promise<readonly BackupReport[]>;
  readonly cutoverGo: (tenantId: string) => Promise<CutoverGo | undefined>;
  readonly triggers: (tenantId: string) => Promise<readonly RaisedRollbackTrigger[]>;
  readonly recordTrigger: (tenantId: string, trigger: RaisedRollbackTrigger) => Promise<void>;
  readonly raiseToOwners?: (tenantId: string, alertId: string, component: string, detail: string, at: string) => Promise<void>;
  readonly exportDiffs: (tenantId: string) => Promise<readonly ExportDiffRun[]>;
  readonly recordExportDiff: (tenantId: string, run: ExportDiffRun) => Promise<void>;
  readonly headOfficeBooks: (tenantId: string, businessDate: string) => Promise<HeadOfficeBooksDay>;
  readonly booksDays: (tenantId: string) => Promise<readonly BooksDayRecord[]>;
  readonly recordBooksDay: (tenantId: string, record: BooksDayRecord) => Promise<void>;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isNonNegInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const sha = (s: string): string => `sha256:${createHash('sha256').update(s).digest('hex')}`;
const BOOKS_AREA_SET: ReadonlySet<string> = new Set(BOOKS_AREAS);

const notWired = (): never => {
  throw apiError(503, { code: 'migration_controls_not_wired', whatHappened: 'This deployment has no ledger for the migration controls.', wasItSaved: 'not_saved', nextSafeAction: 'Nothing was recorded. Use the full head-office service.' });
};
const tooBig = (what: string): never => {
  throw apiError(413, { code: 'file_too_large', whatHappened: `${what} is larger than ${OLD_ERP_FILE_MAX_BYTES} bytes — that is not one export or one day's report.`, wasItSaved: 'not_saved', nextSafeAction: 'Export only the domain or the day asked for. Nothing was recorded.' });
};

/** The largest money control-total difference head office holds (MG-06's totals in paise) — undefined when it holds none. */
async function largestMoneyDifference(deps: MigrationDeps, tenantId: string): Promise<number | undefined> {
  const totals = deps.controlTotals === undefined ? [] : await deps.controlTotals(tenantId);
  const money = totals.filter((t) => t.unit === 'minor_currency');
  if (money.length === 0) return undefined;
  return Math.max(...money.map((t) => Math.abs(t.loadedValue - t.legacyValue - (t.approvedExclusionValue ?? 0))));
}

/** How long the stalest store has had no complete sales sync, in whole minutes — undefined when nothing has reported. */
async function stalestStoreMinutes(deps: MigrationDeps, tenantId: string, now: string): Promise<number | undefined> {
  const stores = deps.storeSalesSyncedThrough === undefined ? [] : await deps.storeSalesSyncedThrough(tenantId);
  if (stores.length === 0) return undefined;
  if (stores.some((s) => s.completeThrough === null)) return Number.MAX_SAFE_INTEGER;
  const oldest = stores.map((s) => Date.parse(s.completeThrough!)).reduce((a, b) => Math.min(a, b));
  return Math.max(0, Math.floor((Date.parse(now) - oldest) / 60_000));
}

export function migrationControlRoutes(deps: MigrationDeps): readonly Route[] {
  const c = (): MigrationControlsDeps => deps.controls ?? notWired();
  const ownerOnly = async (tenantId: string, userId: string, what: string): Promise<void> => {
    if (userId !== await deps.ownerId(tenantId)) {
      throw apiError(403, { code: 'owner_only', whatHappened: `${what} is the owner's decision — only the owner, signed in, sets it (OB-288: his numbers, never invented).`, wasItSaved: 'not_saved', nextSafeAction: 'Ask the owner to set it. Nothing was changed.' });
    }
  };
  return [
    // ── MG-11 ─────────────────────────────────────────────────────────────────────────────────────────────────────
    {
      // The owner's four rollback limits. Body: { controlTotalDifferenceMinor, edgeOutageMinutes, windowMinutes,
      // backupMaxAgeHours } — each a whole number, or null for "not set". A new version each time; frozen after the GO.
      api: 'API-12', method: 'PUT', path: '/v1/migration/cutover/rollback-limits',
      permission: 'migration.cutover.decide', idempotent: true,
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const b = isObj(ctx.body) ? ctx.body : {};
        if (!ROLLBACK_LIMIT_NAMES.every((n) => n in b && isLimitValue(b[n])) || Object.keys(b).some((k) => !(ROLLBACK_LIMIT_NAMES as readonly string[]).includes(k))) {
          throw apiError(400, {
            code: 'not_readable_as_rollback_limits',
            whatHappened: `Rollback limits are { ${ROLLBACK_LIMIT_NAMES.join(', ')} } — each a whole number not below zero, or null for "not set".`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send all four (null for one not decided yet). Nothing was changed.',
          });
        }
        await ownerOnly(ctx.tenantId, ctx.userId, 'The rollback limits');
        const go = await c().cutoverGo(ctx.tenantId);
        if (go !== undefined) {
          throw apiError(409, { code: 'rollback_limits_frozen', whatHappened: `The cutover GO was given at ${go.goAt}; the limits are the ones agreed before the night and do not move during it.`, wasItSaved: 'not_saved', nextSafeAction: 'Nothing was changed. If the night must be judged differently, decide the rollback yourself — it is one labelled action.' });
        }
        const prior = await c().rollbackLimits(ctx.tenantId);
        const limits: RollbackLimits = {
          controlTotalDifferenceMinor: b['controlTotalDifferenceMinor'] as number | null, edgeOutageMinutes: b['edgeOutageMinutes'] as number | null,
          windowMinutes: b['windowMinutes'] as number | null, backupMaxAgeHours: b['backupMaxAgeHours'] as number | null,
          version: (prior?.version ?? 0) + 1, setBy: ctx.userId, setAt: deps.now(),
        };
        await c().recordRollbackLimits(ctx.tenantId, limits);
        return { status: 200, body: { limits, notSet: limitsNotSet(limits) } };
      },
    },
    {
      api: 'API-12', method: 'GET', path: '/v1/migration/cutover/rollback-limits',
      permission: 'migration.parallel.read',
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const [limits, backups, triggers] = await Promise.all([c().rollbackLimits(ctx.tenantId), c().backups(ctx.tenantId), c().triggers(ctx.tenantId)]);
        return {
          status: 200,
          body: {
            limits: limits ?? null, notSet: limitsNotSet(limits), words: ROLLBACK_LIMIT_WORDS,
            backup: backupStanding(backups, limits?.backupMaxAgeHours ?? null, deps.now()),
            raisedTriggers: triggers, asAt: deps.now(),
          },
        };
      },
    },
    {
      // On the night: head office's own observations against the agreed limits. A crossed limit raises the trigger, once.
      api: 'API-12', method: 'POST', path: '/v1/migration/cutover/night-check',
      permission: 'migration.cutover.decide', idempotent: true,
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const now = deps.now();
        const [limits, go, already] = await Promise.all([c().rollbackLimits(ctx.tenantId), c().cutoverGo(ctx.tenantId), c().triggers(ctx.tenantId)]);
        const ct = await largestMoneyDifference(deps, ctx.tenantId);
        const outage = await stalestStoreMinutes(deps, ctx.tenantId, now);
        const observed: NightObservations = {
          ...(ct === undefined ? {} : { controlTotalDifferenceMinor: ct }),
          ...(outage === undefined ? {} : { edgeOutageMinutes: outage }),
          ...(go === undefined ? {} : { minutesSinceGo: Math.max(0, Math.floor((Date.parse(now) - Date.parse(go.goAt)) / 60_000)) }),
        };
        const result = crossedLimits(limits, observed);
        const cutoverId = go?.cutoverId ?? 'before-go';
        const raised: RaisedRollbackTrigger[] = [];
        for (const x of result.crossed) {
          if (already.some((t) => t.cutoverId === cutoverId && t.limit === x.limit)) continue;
          const trig: RaisedRollbackTrigger = { ...x, cutoverId, raisedAt: now, raisedBy: ctx.userId };
          await c().recordTrigger(ctx.tenantId, trig);
          await c().raiseToOwners?.(ctx.tenantId, `rollback-trigger:${cutoverId}:${x.limit}`, 'Cutover rollback limit', `${x.detail} — the agreed rollback limit is crossed. Decide the rollback now (it is one labelled action on the migration screen).`, now);
          raised.push(trig);
        }
        return {
          status: 200,
          body: {
            observed, crossed: result.crossed, notKnown: result.notKnown, newlyRaised: raised,
            rollBackNow: result.crossed.length > 0, cutoverId: go?.cutoverId ?? null,
            detail: result.crossed.length > 0
              ? `${result.crossed.length} agreed limit(s) crossed — the rollback trigger is raised; perform the rollback.`
              : result.notKnown.length > 0 ? 'No agreed limit is crossed by what head office can see; some could not be judged — named in notKnown.' : 'Every agreed limit holds.',
            asAt: now,
          },
        };
      },
    },
    // ── MG-09 ─────────────────────────────────────────────────────────────────────────────────────────────────────
    {
      // Compare two full exports. Body: { domain, mapping: { <our field>: "<their column>" }, baseline: { csv, label? },
      // latest: { csv, label? } }. Every difference becomes a blocking exception on the register; nothing is applied.
      api: 'API-12', method: 'POST', path: '/v1/migration/export-diffs/:diffId',
      permission: 'migration.exception.record', idempotent: true,
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const diffId = (ctx.params['diffId'] ?? '').trim();
        const b = isObj(ctx.body) ? ctx.body : {};
        const domain = b['domain'] as ExportDomain;
        const base = b['baseline'];
        const latest = b['latest'];
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(diffId) || !EXPORT_DOMAINS.includes(domain) || !isObj(b['mapping']) || !isObj(base) || !isObj(latest) || typeof base['csv'] !== 'string' || typeof latest['csv'] !== 'string') {
          throw apiError(400, {
            code: 'not_readable_as_an_export_diff',
            whatHappened: `Comparing two exports needs a diff id (letters, digits, . _ -) and { domain (${EXPORT_DOMAINS.join(' / ')}), mapping: { "<our field>": "<their column>" }, baseline: { csv, label? } (the export that was loaded), latest: { csv, label? } }.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send both exports of the same domain with the column mapping. Nothing was recorded.',
          });
        }
        if ((base['csv'] as string).length > OLD_ERP_FILE_MAX_BYTES) tooBig('The baseline export');
        if ((latest['csv'] as string).length > OLD_ERP_FILE_MAX_BYTES) tooBig('The latest export');
        if (deps.recordException === undefined || deps.exceptions === undefined) notWired();
        const baselineDigest = sha(base['csv'] as string);
        const latestDigest = sha(latest['csv'] as string);
        const prior = (await c().exportDiffs(ctx.tenantId)).find((r) => r.diffId === diffId);
        if (prior !== undefined) {
          if (prior.domain === domain && prior.baselineDigest === baselineDigest && prior.latestDigest === latestDigest) {
            return { status: 200, body: { run: prior, alreadyRecorded: true, outstanding: outstandingExceptions(await deps.exceptions!(ctx.tenantId)) } };
          }
          throw apiError(409, { code: 'diff_id_used', whatHappened: `Comparison ${diffId} was already recorded for other files (${prior.domain}, ${prior.at}). One diff id is one comparison.`, wasItSaved: 'not_saved', nextSafeAction: 'Use a new diff id for these files. Nothing was changed.' });
        }
        const a = readExport(domain, base['csv'] as string, b['mapping']);
        const z = readExport(domain, latest['csv'] as string, b['mapping']);
        if (!a.ok || !z.ok) {
          throw apiError(422, {
            code: 'export_not_readable',
            whatHappened: `The exports could not be read whole, so nothing was compared: ${[...(a.ok ? [] : a.problems.map((p) => `baseline — ${p}`)), ...(z.ok ? [] : z.problems.map((p) => `latest — ${p}`))].join('; ')}`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Fix what is named (or the column mapping) and send both exports again. Nothing was recorded.',
          });
        }
        const diff = diffExports(domain, a, z);
        const exceptions = diffExceptions(diffId, ctx.tenantId, diff);
        const known = new Set((await deps.exceptions!(ctx.tenantId)).map((e) => e.exceptionId));
        for (const e of exceptions) if (!known.has(e.exceptionId)) await deps.recordException!(ctx.tenantId, e);
        const run: ExportDiffRun = {
          diffId, domain, baselineDigest, latestDigest,
          baselineLabel: isStr(base['label']) ? (base['label'] as string).trim() : 'the export that was loaded',
          latestLabel: isStr(latest['label']) ? (latest['label'] as string).trim() : 'the latest export',
          counts: { baseline: diff.baselineRecords, latest: diff.latestRecords, added: diff.added.length, changed: diff.changed.length, removed: diff.removed.length, unchanged: diff.unchanged },
          exceptionIds: exceptions.map((e) => e.exceptionId), by: ctx.userId, at: deps.now(),
        };
        await c().recordExportDiff(ctx.tenantId, run);
        return {
          status: 201,
          body: {
            run, added: diff.added, changed: diff.changed, removed: diff.removed,
            outstanding: outstandingExceptions(await deps.exceptions!(ctx.tenantId)),
            detail: exceptions.length === 0 ? `No difference between the two ${EXPORT_DOMAIN_SPECS[domain].words.en.toLowerCase()} exports.` : `${exceptions.length} difference(s), each now an exception to decide on the migration register — nothing was applied.`,
          },
        };
      },
    },
    {
      api: 'API-12', method: 'GET', path: '/v1/migration/export-diffs',
      permission: 'migration.cleaning.read',
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const [runs, all] = await Promise.all([c().exportDiffs(ctx.tenantId), deps.exceptions === undefined ? [] : deps.exceptions(ctx.tenantId)]);
        return {
          status: 200,
          body: {
            runs: runs.map((r) => ({ ...r, undecided: all.filter((e) => r.exceptionIds.includes(e.exceptionId) && e.resolution === undefined).length })),
            domains: EXPORT_DOMAINS.map((d) => ({ domain: d, words: EXPORT_DOMAIN_SPECS[d].words, fields: EXPORT_DOMAIN_SPECS[d].fields.map((f) => ({ key: f.key, required: f.required, words: f.words })) })),
            asAt: deps.now(),
          },
        };
      },
    },
    // ── MG-10 ─────────────────────────────────────────────────────────────────────────────────────────────────────
    {
      // The books side of a parallel day. Body: { reports: { <report>: { csv, mapping, dateOrder? } }, tolerance?: {
      // valueMinor, quantityThousandths } }. The named reconciler or the owner records it.
      api: 'API-12', method: 'POST', path: '/v1/migration/parallel-run/days/:businessDate/books',
      permission: 'migration.parallel.record', idempotent: true,
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const businessDate = (ctx.params['businessDate'] ?? '').trim();
        const b = isObj(ctx.body) ? ctx.body : {};
        const reports = b['reports'];
        const tol = b['tolerance'] === undefined ? { valueMinor: 0, quantityThousandths: 0 } : b['tolerance'];
        const given = isObj(reports) ? Object.keys(reports) : [];
        if (!isDate(businessDate) || !isObj(reports) || given.length === 0 || !given.every((k) => (BOOKS_REPORTS as readonly string[]).includes(k))
          || !given.every((k) => { const r = (reports as Record<string, unknown>)[k]; return isObj(r) && typeof r['csv'] === 'string' && isObj(r['mapping']) && (r['dateOrder'] === undefined || (DATE_ORDERS as readonly string[]).includes(r['dateOrder'] as string)); })
          || !isObj(tol) || !isNonNegInt(tol['valueMinor']) || !isNonNegInt(tol['quantityThousandths'])) {
          throw apiError(400, {
            code: 'not_readable_as_books_reports',
            whatHappened: `The books side of a day needs the date (YYYY-MM-DD) in the path and { reports: { <one of ${BOOKS_REPORTS.join(', ')}>: { csv, mapping, dateOrder? } }, tolerance?: { valueMinor, quantityThousandths } }.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send at least one of the old ERP\'s day reports with its column mapping. Nothing was recorded.',
          });
        }
        const policy = deps.parallelPolicy === undefined ? undefined : await deps.parallelPolicy(ctx.tenantId);
        if (policy === undefined) throw apiError(409, { code: 'parallel_run_not_started', whatHappened: 'No parallel-run policy has been written, so nobody is named to reconcile daily (R-05).', wasItSaved: 'not_saved', nextSafeAction: 'The owner writes the policy first — PUT /v1/migration/parallel-run/policy. Nothing was recorded.' });
        if (ctx.userId !== policy.dailyReconcilerUserId && ctx.userId !== await deps.ownerId(ctx.tenantId)) {
          throw apiError(403, { code: 'not_the_named_reconciler', whatHappened: `${policy.dailyReconcilerUserId} is the person named to reconcile this parallel run daily; ${ctx.userId} is not, and is not the owner.`, wasItSaved: 'not_saved', nextSafeAction: 'Nothing was recorded.' });
        }
        if (deps.recordParallelDay === undefined || deps.recordParallelDifference === undefined || deps.parallelDays === undefined) notWired();
        const old: Partial<Record<BooksReport, readonly Row[]>> = {};
        const problems: string[] = [];
        for (const k of given as BooksReport[]) {
          const r = (reports as Record<string, Record<string, unknown>>)[k]!;
          if ((r['csv'] as string).length > OLD_ERP_FILE_MAX_BYTES) tooBig(BOOKS_REPORT_SPECS[k].words.en);
          const read = readBooksReport({ report: k, text: r['csv'] as string, mapping: r['mapping'], day: businessDate, ...(r['dateOrder'] === undefined ? {} : { dateOrder: r['dateOrder'] as DateOrder }) });
          if (!read.ok) problems.push(...read.problems.map((p) => `${BOOKS_REPORT_SPECS[k].words.en} — ${p}`));
          else old[k] = read.rows;
        }
        if (problems.length > 0) {
          throw apiError(422, { code: 'books_reports_not_readable', whatHappened: `The reports could not be read whole, so nothing was compared: ${problems.join('; ')}`, wasItSaved: 'not_saved', nextSafeAction: 'Fix what is named and send the reports again. Nothing was recorded.' });
        }
        const ho = await c().headOfficeBooks(ctx.tenantId, businessDate);
        const compared = compareBooksDay({ old, ho, tolerance: { valueMinor: tol['valueMinor'] as number, quantityThousandths: tol['quantityThousandths'] as number } });
        // Join the day's MG-10 record: its sales lines stay, any earlier books lines are replaced by these.
        const held = (await deps.parallelDays!(ctx.tenantId)).find((d) => d.businessDate === businessDate);
        const keep = (held?.comparisons ?? []).filter((x) => !BOOKS_AREA_SET.has(x.area));
        const comparisons: DayComparison[] = [...keep, ...compared.comparisons];
        const digest = dayDigestOf(comparisons);
        if (held === undefined || dayDigestOf(held.comparisons) !== digest) {
          const result = compareParallelDay({ tenantId: ctx.tenantId, businessDate, comparisons, idPrefix: differencePrefixFor(held !== undefined, digest) });
          await deps.recordParallelDay!(ctx.tenantId, { ...result, comparisons, recordedBy: ctx.userId, recordedAt: deps.now() });
          for (const d of result.differences) await deps.recordParallelDifference!(ctx.tenantId, d);
        }
        const record: BooksDayRecord = { businessDate, reports: compared.reports, lines: compared.comparisons.length, notCompared: compared.notCompared, dayDigest: digest, by: ctx.userId, at: deps.now() };
        await c().recordBooksDay(ctx.tenantId, record);
        const differences = compareParallelDay({ tenantId: ctx.tenantId, businessDate, comparisons: compared.comparisons }).differences;
        return {
          status: 201,
          body: {
            record, comparisons: compared.comparisons, differences: differences.length, notCompared: compared.notCompared,
            notGiven: BOOKS_REPORTS.filter((r) => !compared.reports.includes(r)),
            detail: compared.notCompared.length > 0
              ? `${compared.notCompared.length} figure(s) could not be compared — the day cannot be signed until head office can work them out.`
              : differences.length === 0 ? 'The books side of the day agrees.' : `${differences.length} difference(s) on the books side — each needs a reason before the day is signed.`,
          },
        };
      },
    },
    {
      api: 'API-12', method: 'GET', path: '/v1/migration/parallel-run/days/:businessDate/books',
      permission: 'migration.parallel.read',
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const businessDate = (ctx.params['businessDate'] ?? '').trim();
        const all = (await c().booksDays(ctx.tenantId)).filter((r) => r.businessDate === businessDate);
        return {
          status: 200,
          body: {
            record: all.at(-1) ?? null, history: all,
            templates: BOOKS_REPORTS.map((r) => ({ report: r, file: BOOKS_REPORT_SPECS[r].file, words: BOOKS_REPORT_SPECS[r].words, fields: BOOKS_REPORT_SPECS[r].fields.map((f) => ({ key: f.key, required: f.required, words: f.words })) })),
            asAt: deps.now(),
          },
        };
      },
    },
  ];
}

/** The latest books record of a day whose figures are still the day's — what the day's signature must not sign over. */
export async function booksNotComparedFor(deps: MigrationDeps, tenantId: string, businessDate: string): Promise<BooksComparison['notCompared']> {
  if (deps.controls === undefined) return [];
  const latest = (await deps.controls.booksDays(tenantId)).filter((r) => r.businessDate === businessDate).at(-1);
  if (latest === undefined) return [];
  const day = deps.parallelDays === undefined ? undefined : (await deps.parallelDays(tenantId)).find((d) => d.businessDate === businessDate);
  if (day === undefined || dayDigestOf(day.comparisons) !== latest.dayDigest) return [];
  return latest.notCompared;
}
