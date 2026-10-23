// The security findings register on the compliance API (QG-03 · QG-06 · roadmap §22, §32, §35, §35.1).
//
// Scanner output becomes recorded findings: the CI scan wrapper (scripts/scan-findings.mts) normalises each tool's
// report into a ScanReport, and this route folds it onto the register on the tested `importScan` engine
// (`packages/compliance/src/findings.ts`). A person's finding (a penetration test, a review) is recorded on its own.
//
//   POST /v1/compliance/finding-scans                 import one scanner run                    compliance.finding.record
//   GET  /v1/compliance/finding-scans                 every imported run, newest first          compliance.finding.read
//   POST /v1/compliance/findings/:findingId           record a person's finding (pentest/review) compliance.finding.record
//   POST /v1/compliance/findings/:findingId/owner     name the person answerable for a finding  compliance.finding.record
//   POST /v1/compliance/findings/:findingId/fixed     a person's finding fixed, with evidence   compliance.finding.record
//   GET  /v1/compliance/findings                      the register: open first, overdue first   compliance.finding.read
//
// A scanner finding cannot be closed by hand (422 by name) — it closes when a complete scan no longer reports it.
// Append-only: every change of state is a new fact (hard rules #2, #6). The kernel audits every write.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  readScanReport, importScan, recordPersonFinding, markPersonFindingFixed, assignFindingOwner,
  findingBlocks, overdueFindings, summariseFindings, BLOCKING_FINDING_SEVERITIES, FINDING_SEVERITIES,
  NotAScanReportError, StaleScanError, ScannerFindingCloseError, FixNeedsEvidenceError, NotAPersonFindingError,
  type SecurityFinding, type ScanImportSummary,
} from '../../../packages/compliance/src/index';

/** One imported scanner run, as kept on the register. */
export interface ScanRunRecord extends ScanImportSummary {
  readonly source: string;
  readonly commit?: string;
  readonly incompleteBecause?: readonly string[];
  readonly importedBy: string;
  readonly importedAt: string;
  /** How many critical/high things the run reported — the number that fails CI. */
  readonly blockingObserved: number;
}

export interface FindingsDeps {
  readonly findings: (tenantId: string) => Promise<readonly SecurityFinding[]> | readonly SecurityFinding[];
  readonly scans: (tenantId: string) => Promise<readonly ScanRunRecord[]> | readonly ScanRunRecord[];
  /** Append the changed findings (append-only; the fold takes the latest per findingId). */
  readonly recordFindings: (tenantId: string, changes: readonly SecurityFinding[]) => Promise<void> | void;
  readonly recordScan: (tenantId: string, scan: ScanRunRecord) => Promise<void> | void;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const SEVERITY_ORDER = new Map(FINDING_SEVERITIES.map((s, i) => [s, i]));

const refuse = (status: number, code: string, whatHappened: string, nextSafeAction: string) =>
  apiError(status, { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction });

export function findingsRoutes(deps: FindingsDeps): readonly Route[] {
  const findingOf = async (tenantId: string, findingId: string): Promise<SecurityFinding | undefined> =>
    (await deps.findings(tenantId)).find((f) => f.findingId === findingId);

  return [
    {
      // Import one scanner run. Body: { report: ScanReport } — tool, source, runId, scannedAt, commit?, complete,
      // incompleteBecause?, observations[]. Opens new findings, reopens returned ones, and — only when the run is
      // complete — closes the tool's open findings it no longer reports. A run already imported is refused (409),
      // and so is a run older than the tool's newest one (it could reopen or close what a newer run saw).
      api: 'API-11', method: 'POST', path: '/v1/compliance/finding-scans',
      permission: 'compliance.finding.record', idempotent: true,
      handler: async (ctx) => {
        const body = (ctx.body ?? {}) as Record<string, unknown>;
        let report;
        try {
          report = readScanReport(body['report']);
        } catch (e) {
          if (e instanceof NotAScanReportError) {
            throw refuse(400, 'not_readable_as_a_scan_report', `The scan report could not be read: ${e.problems.join('; ')}.`, 'Send { report } as scripts/scan-findings.mts writes it.');
          }
          throw e;
        }
        const runs = (await deps.scans(ctx.tenantId)).filter((r) => r.tool === report.tool);
        const already = runs.find((r) => r.runId === report.runId);
        if (already !== undefined) {
          throw refuse(409, 'scan_run_already_imported', `The ${report.tool} run ${report.runId} is already on the register (imported ${already.importedAt} by ${already.importedBy}).`, 'Import a new run; a run is folded in once.');
        }
        const latest = runs.map((r) => r.scannedAt).sort().at(-1);
        let imported;
        try {
          imported = importScan(await deps.findings(ctx.tenantId), report, latest);
        } catch (e) {
          if (e instanceof StaleScanError) throw refuse(409, 'scan_older_than_the_register', e.message, 'Import the newest run of this scanner.');
          throw e;
        }
        if (imported.changes.length > 0) await deps.recordFindings(ctx.tenantId, imported.changes);
        const blockingObserved = report.observations.filter((o) => BLOCKING_FINDING_SEVERITIES.includes(o.severity)).length;
        const scan: ScanRunRecord = {
          ...imported.summary, source: report.source, ...(report.commit === undefined ? {} : { commit: report.commit }),
          ...(report.incompleteBecause === undefined ? {} : { incompleteBecause: report.incompleteBecause }),
          importedBy: ctx.userId, importedAt: deps.now(), blockingObserved,
        };
        await deps.recordScan(ctx.tenantId, scan);
        return { status: 201, body: { scan, changed: imported.changes.length } };
      },
    },
    {
      api: 'API-11', method: 'GET', path: '/v1/compliance/finding-scans',
      permission: 'compliance.finding.read',
      handler: async (ctx) => {
        const scans = [...await deps.scans(ctx.tenantId)].sort((a, z) => (a.scannedAt < z.scannedAt ? 1 : a.scannedAt > z.scannedAt ? -1 : 0));
        const latestByTool = new Map<string, ScanRunRecord>();
        for (const s of scans) if (!latestByTool.has(s.tool)) latestByTool.set(s.tool, s);
        return { status: 200, body: { scans, count: scans.length, latestByTool: [...latestByTool.values()] } };
      },
    },
    {
      // Record (or restate) a finding a PERSON raised — a penetration test or a review. Body: { source: pentest|review,
      // title, severity, location, ownerUserId? }. Recorded in the caller's own name. A scanner finding's id is refused.
      api: 'API-11', method: 'POST', path: '/v1/compliance/findings/:findingId',
      permission: 'compliance.finding.record', idempotent: true,
      handler: async (ctx) => {
        const findingId = (ctx.params['findingId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        let finding: SecurityFinding;
        try {
          const prior = await findingOf(ctx.tenantId, findingId);
          finding = recordPersonFinding({
            findingId, source: b['source'], title: b['title'], severity: b['severity'], location: b['location'],
            ...(b['ownerUserId'] === undefined ? {} : { ownerUserId: b['ownerUserId'] }),
            recordedBy: ctx.userId, at: deps.now(), ...(prior === undefined ? {} : { prior }),
          });
        } catch (e) {
          if (e instanceof NotAPersonFindingError) {
            throw refuse(400, 'not_readable_as_a_finding', `The finding could not be recorded: ${e.problems.join('; ')}.`, 'Send { source, title, severity, location, ownerUserId? }.');
          }
          throw e;
        }
        await deps.recordFindings(ctx.tenantId, [finding]);
        return { status: 201, body: { finding } };
      },
    },
    {
      // Name the person answerable for a finding (any finding). Body: { ownerUserId }.
      api: 'API-11', method: 'POST', path: '/v1/compliance/findings/:findingId/owner',
      permission: 'compliance.finding.record', idempotent: true,
      handler: async (ctx) => {
        const findingId = ctx.params['findingId'] ?? '';
        const owner = (ctx.body as { ownerUserId?: unknown } | null)?.ownerUserId;
        if (!isStr(owner)) throw refuse(400, 'owner_needs_a_person', 'Naming an owner needs { ownerUserId } — a named person.', 'Send the person answerable for the fix.');
        const prior = await findingOf(ctx.tenantId, findingId);
        if (prior === undefined) throw notFound(`finding ${findingId}`);
        const finding = assignFindingOwner(prior, owner);
        await deps.recordFindings(ctx.tenantId, [finding]);
        return { status: 200, body: { findingId, ownerUserId: finding.ownerUserId } };
      },
    },
    {
      // A PERSON's finding is fixed — recorded in the caller's own name with written evidence. Body: { evidence }.
      // A scanner finding is refused by name: it closes only when a complete scan no longer reports it.
      api: 'API-11', method: 'POST', path: '/v1/compliance/findings/:findingId/fixed',
      permission: 'compliance.finding.record', idempotent: true,
      handler: async (ctx) => {
        const findingId = ctx.params['findingId'] ?? '';
        const evidence = (ctx.body as { evidence?: unknown } | null)?.evidence;
        const prior = await findingOf(ctx.tenantId, findingId);
        if (prior === undefined) throw notFound(`finding ${findingId}`);
        if (prior.status === 'fixed') throw refuse(409, 'finding_already_fixed', `Finding ${findingId} was already recorded fixed (${prior.fixedAt ?? ''}).`, 'Nothing to do.');
        let finding: SecurityFinding;
        try {
          finding = markPersonFindingFixed(prior, ctx.userId, typeof evidence === 'string' ? evidence : '', deps.now());
        } catch (e) {
          if (e instanceof ScannerFindingCloseError) throw refuse(422, 'scanner_finding_closes_on_a_clean_scan', e.message, `Fix it, then import a complete ${prior.tool} scan.`);
          if (e instanceof FixNeedsEvidenceError) throw refuse(400, 'fix_needs_evidence', e.message, 'Say, in writing, what was fixed and how it was checked.');
          throw e;
        }
        await deps.recordFindings(ctx.tenantId, [finding]);
        return { status: 200, body: { findingId, status: finding.status, fixedBy: finding.fixedBy } };
      },
    },
    {
      // The register: overdue criticals first, then open by severity, then fixed. Query: status=open|fixed (optional).
      api: 'API-11', method: 'GET', path: '/v1/compliance/findings',
      permission: 'compliance.finding.read',
      handler: async (ctx) => {
        const now = deps.now();
        const all = await deps.findings(ctx.tenantId);
        const overdue = new Set(overdueFindings(all, now).map((f) => f.findingId));
        const status = ctx.query['status'];
        const shown = all.filter((f) => status !== 'open' && status !== 'fixed' ? true : f.status === status);
        const findings = [...shown].sort((a, z) =>
          (a.status === z.status ? 0 : a.status === 'open' ? -1 : 1)
          || (Number(overdue.has(z.findingId)) - Number(overdue.has(a.findingId)))
          || ((SEVERITY_ORDER.get(a.severity) ?? 9) - (SEVERITY_ORDER.get(z.severity) ?? 9))
          || (a.openedAt < z.openedAt ? -1 : a.openedAt > z.openedAt ? 1 : 0));
        const blocks = findingBlocks(all);
        return {
          status: 200,
          body: {
            findings: findings.map((f) => ({ ...f, overdue: overdue.has(f.findingId) })),
            count: findings.length, summary: summariseFindings(all, now), blocks, asAt: now,
          },
        };
      },
    },
  ];
}
