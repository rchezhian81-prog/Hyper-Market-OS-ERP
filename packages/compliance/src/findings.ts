// Security findings register (QG-03 · QG-06 · roadmap §22, §32, §35, §35.1; OB-288 gates lane).
//
// Roadmap §22 QG-06: "Zero open critical/high findings at go-live; independent penetration test before
// customer launch." §32: "Critical vulnerability — No open critical at release; emergency fix ≤72 h target;
// evidence: Security register." §35: "SAST/DAST/SCA/container/IaC/secret scans." §35.1: "Zero unresolved
// critical/high findings".
//
// So a scanner's output is not a log line that scrolls away: each thing a scanner reports becomes a FINDING
// on this register, with its severity, its owner and — for a critical — the 72-hour emergency-fix clock. An
// open critical or high finding blocks QG-06 (and QG-03, "security scans green", when a CI scanner raised it).
//
// How a finding closes is the control:
//   • a SCANNER finding closes only when a later COMPLETE scan by the same tool no longer reports it. Nobody can
//     mark a scanner finding fixed by hand — that would be silencing the scanner. A partial scan (complete: false)
//     never closes anything: a scan that did not look is not evidence that the problem is gone (P-08).
//   • a finding from a PERSON (a penetration test, a review) closes when a named person records the fix with
//     written evidence.
//   • a finding that comes back after it closed is REOPENED, and its clock starts again from the reopen.
//
// Pure and deterministic: no clock, no I/O, and no runtime imports (the CI wrapper runs this file directly with
// Node's type stripping — scripts/scan-findings.mts).

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
/** What kind of check raised the finding. The first six are CI scanners (§35); the last two are people. */
export type FindingSource = 'sast' | 'container' | 'iac' | 'dast' | 'dependency' | 'secret' | 'pentest' | 'review';
export type FindingStatus = 'open' | 'fixed';

export const FINDING_SEVERITIES: readonly FindingSeverity[] = Object.freeze(['critical', 'high', 'medium', 'low', 'info']);
export const SCANNER_SOURCES: readonly FindingSource[] = Object.freeze(['sast', 'container', 'iac', 'dast', 'dependency', 'secret']);
export const PERSON_SOURCES: readonly FindingSource[] = Object.freeze(['pentest', 'review']);
/** §22 QG-06 / §35.1: these severities block a gate while open. */
export const BLOCKING_FINDING_SEVERITIES: readonly FindingSeverity[] = Object.freeze(['critical', 'high']);
/** §32: "emergency fix ≤72 h target" — the roadmap names this clock for a critical vulnerability only. */
export const EMERGENCY_FIX_HOURS = 72;

/** One thing one scanner reported in one run. */
export interface FindingObservation {
  /** Stable across runs for the same problem in the same place — the register's key. */
  readonly fingerprint: string;
  readonly source: FindingSource;
  readonly tool: string;
  readonly ruleId: string;
  readonly title: string;
  readonly severity: FindingSeverity;
  /** The tool's own word for the severity (ERROR, HIGH, riskcode 3 …), kept so the mapping can be checked. */
  readonly toolSeverity: string;
  /** Where: a file and line, an image package, a URL. */
  readonly location: string;
}

/** One scanner run, normalised. `complete` is true only when the tool ran to the end over everything it was meant to. */
export interface ScanReport {
  readonly tool: string;
  readonly source: FindingSource;
  readonly runId: string;
  /** ISO-8601 UTC. */
  readonly scannedAt: string;
  readonly commit?: string;
  readonly complete: boolean;
  /** Why the run is not complete (files the tool could not read, a target it could not reach). */
  readonly incompleteBecause?: readonly string[];
  readonly observations: readonly FindingObservation[];
}

export interface SecurityFinding {
  readonly findingId: string;
  readonly source: FindingSource;
  readonly tool: string;
  readonly ruleId: string;
  readonly title: string;
  readonly severity: FindingSeverity;
  readonly toolSeverity: string;
  readonly location: string;
  readonly status: FindingStatus;
  /** When the register first heard of it. */
  readonly firstSeenAt: string;
  /** When it was last opened (the first sighting, or the latest reopen) — the 72-hour clock runs from here. */
  readonly openedAt: string;
  /** The scan run (or the person's record) that opened it last. */
  readonly openedBy: string;
  readonly reopenCount: number;
  /** A named person answerable for the fix. Absent = nobody owns it yet, which the register says out loud. */
  readonly ownerUserId?: string;
  /** Critical only: openedAt + 72 h (§32). */
  readonly fixDueBy?: string;
  readonly fixedAt?: string;
  /** For a scanner finding: the clean complete scan. For a person's finding: the fixer's written evidence. */
  readonly fixedEvidence?: string;
  readonly fixedBy?: string;
}

export class NotAScanReportError extends Error {
  constructor(public readonly problems: readonly string[]) {
    super(`Not a scan report: ${problems.join('; ')}`);
    this.name = 'NotAScanReportError';
  }
}

export class StaleScanError extends Error {
  constructor(public readonly tool: string, public readonly scannedAt: string, public readonly latestAt: string) {
    super(`The ${tool} scan of ${scannedAt} is older than the ${tool} scan already on the register (${latestAt}) — an older scan cannot reopen or close what a newer one saw`);
    this.name = 'StaleScanError';
  }
}

export class ScannerFindingCloseError extends Error {
  constructor(public readonly findingId: string, public readonly tool: string) {
    super(`Finding "${findingId}" was raised by the ${tool} scanner — it closes only when a complete ${tool} scan no longer reports it, never by hand`);
    this.name = 'ScannerFindingCloseError';
  }
}

export class FixNeedsEvidenceError extends Error {
  constructor(public readonly findingId: string) {
    super(`Finding "${findingId}" cannot be marked fixed without a named person and written evidence of the fix`);
    this.name = 'FixNeedsEvidenceError';
  }
}

export class NotAPersonFindingError extends Error {
  constructor(public readonly problems: readonly string[]) {
    super(`Not a finding a person can record: ${problems.join('; ')}`);
    this.name = 'NotAPersonFindingError';
  }
}

// ── small pure helpers ──────────────────────────────────────────────────────────────────────────────────────

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const isIso = (v: unknown): v is string => typeof v === 'string' && ISO.test(v) && Number.isFinite(Date.parse(v));

/** A copy of a finding without the named optional fields (a reopened finding carries no stale "fixed" facts). */
function omit(f: SecurityFinding, keys: readonly (keyof SecurityFinding)[]): SecurityFinding {
  const copy: Record<string, unknown> = { ...f };
  for (const k of keys) delete copy[k];
  return copy as unknown as SecurityFinding;
}

/** A short stable id from a string — two FNV-1a passes, 16 hex characters. No crypto import (see the header). */
export function shortDigest(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c ^ (i & 0xff), 0x01000193) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/** The register's id for a fingerprint: readable tool prefix, stable digest. URL-safe. */
export function findingIdOf(tool: string, fingerprint: string): string {
  const prefix = tool.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'scan';
  return `${prefix}-${shortDigest(fingerprint)}`;
}

/** §32: a critical gets the 72-hour emergency-fix clock from when it was (re)opened. Other severities get none. */
export function fixDueByFor(severity: FindingSeverity, openedAt: string): string | undefined {
  if (severity !== 'critical') return undefined;
  return new Date(Date.parse(openedAt) + EMERGENCY_FIX_HOURS * 3_600_000).toISOString();
}

// ── scanner output → observations ───────────────────────────────────────────────────────────────────────────
// Each parser reads the tool's own JSON. It never invents a severity: an unknown word is kept as the tool said it
// and mapped to 'medium' (rated, visible, recorded), so it is never silently dropped.

function observation(o: Omit<FindingObservation, 'fingerprint'> & { readonly key: string }): FindingObservation {
  const { key, ...rest } = o;
  return { ...rest, fingerprint: `${o.tool}|${key}` };
}

/** Semgrep OSS `--json`: ERROR → high, WARNING → medium, INFO → low. */
export function parseSemgrepJson(raw: unknown): { readonly observations: readonly FindingObservation[]; readonly incompleteBecause: readonly string[] } {
  if (!isObj(raw) || !Array.isArray(raw['results'])) throw new NotAScanReportError(['a Semgrep report has a "results" array']);
  const sev: Record<string, FindingSeverity> = { ERROR: 'high', WARNING: 'medium', INFO: 'low' };
  const ordinal = new Map<string, number>();
  const observations: FindingObservation[] = [];
  for (const r of raw['results'] as unknown[]) {
    if (!isObj(r) || !isStr(r['check_id']) || !isStr(r['path'])) continue;
    const extra = isObj(r['extra']) ? r['extra'] : {};
    const start = isObj(r['start']) ? r['start'] : {};
    const toolSeverity = isStr(extra['severity']) ? extra['severity'] : 'UNKNOWN';
    // Keyed on the rule, the file and WHICH occurrence in that file — not the line — so an edit above it does not
    // turn one old problem into a "new" one with a fresh clock.
    const slot = `${r['check_id']}|${r['path']}`;
    const n = (ordinal.get(slot) ?? 0) + 1;
    ordinal.set(slot, n);
    observations.push(observation({
      key: `${slot}|#${n}`, source: 'sast', tool: 'semgrep', ruleId: r['check_id'],
      title: (isStr(extra['message']) ? extra['message'] : r['check_id']).split('\n')[0]!.slice(0, 300),
      severity: sev[toolSeverity] ?? 'medium', toolSeverity,
      location: `${r['path']}:${typeof start['line'] === 'number' ? start['line'] : '?'}`,
    }));
  }
  const incompleteBecause: string[] = [];
  for (const e of Array.isArray(raw['errors']) ? (raw['errors'] as unknown[]) : []) {
    if (!isObj(e)) continue;
    const level = isStr(e['level']) ? e['level'] : 'error';
    if (level !== 'error') continue;
    const where = isStr(e['path']) ? e['path'] : Array.isArray(e['spans']) && isObj(e['spans'][0]) && isStr((e['spans'][0] as Record<string, unknown>)['file']) ? (e['spans'][0] as Record<string, string>)['file'] : 'unknown file';
    incompleteBecause.push(`semgrep could not scan ${where}: ${isStr(e['type']) ? e['type'] : 'error'}`);
  }
  return { observations, incompleteBecause };
}

const TRIVY_SEVERITY: Record<string, FindingSeverity> = { CRITICAL: 'critical', HIGH: 'high', MEDIUM: 'medium', LOW: 'low' };

/** Trivy `--format json` — image vulnerabilities and secrets (`container`), or configuration checks (`iac`). */
export function parseTrivyJson(raw: unknown, source: 'container' | 'iac'): readonly FindingObservation[] {
  if (!isObj(raw) || !('Results' in raw)) throw new NotAScanReportError(['a Trivy report has a "Results" field']);
  const results = Array.isArray(raw['Results']) ? (raw['Results'] as unknown[]) : [];
  const artifact = isStr(raw['ArtifactName']) ? raw['ArtifactName'] : '';
  const out: FindingObservation[] = [];
  for (const res of results) {
    if (!isObj(res)) continue;
    const target = isStr(res['Target']) ? res['Target'] : artifact;
    for (const v of Array.isArray(res['Vulnerabilities']) ? (res['Vulnerabilities'] as unknown[]) : []) {
      if (!isObj(v) || !isStr(v['VulnerabilityID']) || !isStr(v['PkgName'])) continue;
      const toolSeverity = isStr(v['Severity']) ? v['Severity'] : 'UNKNOWN';
      const fixed = isStr(v['FixedVersion']) ? ` (fixed in ${v['FixedVersion']})` : ' (no fix released yet)';
      out.push(observation({
        key: `${artifact}|${target}|${v['PkgName']}|${v['VulnerabilityID']}`, source, tool: 'trivy', ruleId: v['VulnerabilityID'],
        title: `${v['PkgName']} ${isStr(v['InstalledVersion']) ? v['InstalledVersion'] : ''}: ${isStr(v['Title']) ? v['Title'] : v['VulnerabilityID']}${fixed}`.slice(0, 300),
        severity: TRIVY_SEVERITY[toolSeverity] ?? 'medium', toolSeverity, location: `${artifact === '' ? '' : `${artifact} `}${target}`.trim(),
      }));
    }
    for (const m of Array.isArray(res['Misconfigurations']) ? (res['Misconfigurations'] as unknown[]) : []) {
      if (!isObj(m) || !isStr(m['ID'])) continue;
      if (isStr(m['Status']) && m['Status'] !== 'FAIL') continue;
      const toolSeverity = isStr(m['Severity']) ? m['Severity'] : 'UNKNOWN';
      const cause = isObj(m['CauseMetadata']) ? m['CauseMetadata'] : {};
      const line = typeof cause['StartLine'] === 'number' && cause['StartLine'] > 0 ? `:${cause['StartLine']}` : '';
      out.push(observation({
        key: `${target}|${m['ID']}|${isStr(m['Message']) ? m['Message'] : ''}`, source, tool: 'trivy', ruleId: m['ID'],
        title: `${isStr(m['Title']) ? m['Title'] : m['ID']}${isStr(m['Message']) ? ` — ${m['Message']}` : ''}`.slice(0, 300),
        severity: TRIVY_SEVERITY[toolSeverity] ?? 'medium', toolSeverity, location: `${target}${line}`,
      }));
    }
    for (const s of Array.isArray(res['Secrets']) ? (res['Secrets'] as unknown[]) : []) {
      if (!isObj(s) || !isStr(s['RuleID'])) continue;
      const toolSeverity = isStr(s['Severity']) ? s['Severity'] : 'UNKNOWN';
      out.push(observation({
        key: `${artifact}|${target}|secret|${s['RuleID']}|${typeof s['StartLine'] === 'number' ? s['StartLine'] : ''}`, source, tool: 'trivy', ruleId: s['RuleID'],
        // The matched text is NEVER copied onto the register — only that a secret-shaped thing is there (hard rule #4).
        title: `${isStr(s['Title']) ? s['Title'] : s['RuleID']} (the matched text is not copied here)`.slice(0, 300),
        severity: TRIVY_SEVERITY[toolSeverity] ?? 'high', toolSeverity, location: target,
      }));
    }
  }
  return out;
}

/** OWASP ZAP baseline `-J` report: riskcode 3 → high, 2 → medium, 1 → low, 0 → info. One finding per alert × URL × parameter. */
export function parseZapJson(raw: unknown): readonly FindingObservation[] {
  if (!isObj(raw) || !Array.isArray(raw['site'])) throw new NotAScanReportError(['a ZAP report has a "site" array']);
  const sev: Record<string, FindingSeverity> = { '3': 'high', '2': 'medium', '1': 'low', '0': 'info' };
  const out: FindingObservation[] = [];
  for (const site of raw['site'] as unknown[]) {
    if (!isObj(site)) continue;
    for (const a of Array.isArray(site['alerts']) ? (site['alerts'] as unknown[]) : []) {
      if (!isObj(a)) continue;
      const pluginId = isStr(a['pluginid']) ? a['pluginid'] : isStr(a['alertRef']) ? a['alertRef'] : undefined;
      if (pluginId === undefined) continue;
      const toolSeverity = String(a['riskcode'] ?? 'unknown');
      const name = isStr(a['alert']) ? a['alert'] : isStr(a['name']) ? a['name'] : pluginId;
      const instances = Array.isArray(a['instances']) && a['instances'].length > 0 ? (a['instances'] as unknown[]) : [{}];
      for (const i of instances) {
        const inst = isObj(i) ? i : {};
        const uri = isStr(inst['uri']) ? inst['uri'].split('?')[0]! : (isStr(site['@name']) ? site['@name'] : '');
        const method = isStr(inst['method']) ? inst['method'] : '';
        const param = isStr(inst['param']) ? inst['param'] : '';
        out.push(observation({
          key: `${pluginId}|${method}|${uri}|${param}`, source: 'dast', tool: 'zap', ruleId: pluginId,
          title: name.slice(0, 300), severity: sev[toolSeverity] ?? 'medium', toolSeverity: `riskcode ${toolSeverity}`,
          location: `${method === '' ? '' : `${method} `}${uri}${param === '' ? '' : ` (${param})`}`,
        }));
      }
    }
  }
  return out;
}

/** `pnpm audit --json`: critical/high/moderate/low/info, one finding per advisory × package. */
export function parsePnpmAuditJson(raw: unknown): readonly FindingObservation[] {
  if (!isObj(raw) || !isObj(raw['advisories'])) throw new NotAScanReportError(['a pnpm audit report has an "advisories" object']);
  const sev: Record<string, FindingSeverity> = { critical: 'critical', high: 'high', moderate: 'medium', low: 'low', info: 'info' };
  const out: FindingObservation[] = [];
  for (const adv of Object.values(raw['advisories'] as Record<string, unknown>)) {
    if (!isObj(adv) || !isStr(adv['module_name'])) continue;
    const id = isStr(adv['github_advisory_id']) ? adv['github_advisory_id'] : String(adv['id'] ?? '');
    const toolSeverity = isStr(adv['severity']) ? adv['severity'] : 'unknown';
    out.push(observation({
      key: `${adv['module_name']}|${id}`, source: 'dependency', tool: 'pnpm-audit', ruleId: id,
      title: `${adv['module_name']}: ${isStr(adv['title']) ? adv['title'] : id}`.slice(0, 300),
      severity: sev[toolSeverity] ?? 'medium', toolSeverity, location: `dependency ${adv['module_name']}`,
    }));
  }
  return out;
}

/** The observations that fail a CI run: critical or high (§22 QG-06, the brief's "fail on critical/high"). */
export function blockingObservations(report: Pick<ScanReport, 'observations'>): readonly FindingObservation[] {
  return report.observations.filter((o) => BLOCKING_FINDING_SEVERITIES.includes(o.severity));
}

// ── a report, checked ────────────────────────────────────────────────────────────────────────────────────────

/** Read an untrusted body as a ScanReport, naming every problem at once. */
export function readScanReport(raw: unknown): ScanReport {
  const problems: string[] = [];
  if (!isObj(raw)) throw new NotAScanReportError(['the report is an object']);
  if (!isStr(raw['tool'])) problems.push('tool names the scanner');
  if (!SCANNER_SOURCES.includes(raw['source'] as FindingSource)) problems.push(`source is one of ${SCANNER_SOURCES.join(', ')} (a person's finding is recorded on its own)`);
  if (!isStr(raw['runId'])) problems.push('runId names the scanner run');
  if (!isIso(raw['scannedAt'])) problems.push('scannedAt is an ISO-8601 time');
  if (typeof raw['complete'] !== 'boolean') problems.push('complete says (true/false) whether the scan ran over everything');
  if (raw['commit'] !== undefined && !isStr(raw['commit'])) problems.push('commit, when given, names the commit scanned');
  if (!Array.isArray(raw['observations'])) problems.push('observations is an array (empty when the scan found nothing)');
  const observations: FindingObservation[] = [];
  if (Array.isArray(raw['observations'])) {
    (raw['observations'] as unknown[]).forEach((o, i) => {
      if (!isObj(o) || !isStr(o['fingerprint']) || !isStr(o['ruleId']) || !isStr(o['title']) || !isStr(o['location'])
        || !FINDING_SEVERITIES.includes(o['severity'] as FindingSeverity) || o['tool'] !== raw['tool'] || o['source'] !== raw['source']) {
        problems.push(`observation ${i} needs fingerprint, ruleId, title, location, a severity (${FINDING_SEVERITIES.join('/')}) and the report's own tool and source`);
        return;
      }
      observations.push({
        fingerprint: o['fingerprint'], source: o['source'] as FindingSource, tool: o['tool'] as string, ruleId: o['ruleId'],
        title: o['title'].slice(0, 300), severity: o['severity'] as FindingSeverity,
        toolSeverity: isStr(o['toolSeverity']) ? o['toolSeverity'] : String(o['severity']), location: o['location'],
      });
    });
  }
  const incompleteBecause = Array.isArray(raw['incompleteBecause']) ? (raw['incompleteBecause'] as unknown[]).filter(isStr) : [];
  if (problems.length > 0) throw new NotAScanReportError(problems);
  return {
    tool: raw['tool'] as string, source: raw['source'] as FindingSource, runId: raw['runId'] as string, scannedAt: raw['scannedAt'] as string,
    ...(isStr(raw['commit']) ? { commit: raw['commit'] } : {}),
    complete: raw['complete'] as boolean, ...(incompleteBecause.length > 0 ? { incompleteBecause } : {}),
    observations,
  };
}

// ── importing a run onto the register ───────────────────────────────────────────────────────────────────────

export interface ScanImportSummary {
  readonly tool: string;
  readonly runId: string;
  readonly scannedAt: string;
  readonly complete: boolean;
  readonly observed: number;
  readonly opened: number;
  readonly reopened: number;
  readonly fixed: number;
  readonly stillOpen: number;
  /** True when the run was partial, so nothing it did not see was closed. */
  readonly closedNothingBecausePartial: boolean;
}

/**
 * Fold one scanner run into the register. Returns only the findings whose state CHANGED (to append) and a
 * summary. `latestScannedAt` is the newest run of the same tool already imported — an older run is refused.
 */
export function importScan(
  existing: readonly SecurityFinding[],
  report: ScanReport,
  latestScannedAt?: string,
): { readonly changes: readonly SecurityFinding[]; readonly summary: ScanImportSummary } {
  if (latestScannedAt !== undefined && Date.parse(report.scannedAt) < Date.parse(latestScannedAt)) {
    throw new StaleScanError(report.tool, report.scannedAt, latestScannedAt);
  }
  const mine = new Map(existing.filter((f) => f.tool === report.tool && SCANNER_SOURCES.includes(f.source)).map((f) => [f.findingId, f]));
  const seen = new Set<string>();
  const changes: SecurityFinding[] = [];
  let opened = 0; let reopened = 0; let stillOpen = 0;
  for (const o of report.observations) {
    const findingId = findingIdOf(report.tool, o.fingerprint);
    if (seen.has(findingId)) continue; // a run that reports the same thing twice is one finding
    seen.add(findingId);
    const prior = mine.get(findingId);
    if (prior === undefined) {
      opened += 1;
      const fixDueBy = fixDueByFor(o.severity, report.scannedAt);
      changes.push({
        findingId, source: o.source, tool: o.tool, ruleId: o.ruleId, title: o.title, severity: o.severity, toolSeverity: o.toolSeverity,
        location: o.location, status: 'open', firstSeenAt: report.scannedAt, openedAt: report.scannedAt, openedBy: `scan:${report.runId}`,
        reopenCount: 0, ...(fixDueBy === undefined ? {} : { fixDueBy }),
      });
      continue;
    }
    if (prior.status === 'fixed') {
      reopened += 1;
      const fixDueBy = fixDueByFor(o.severity, report.scannedAt);
      const rest = omit(prior, ['fixedAt', 'fixedEvidence', 'fixedBy', 'fixDueBy']);
      changes.push({
        ...rest, title: o.title, severity: o.severity, toolSeverity: o.toolSeverity, location: o.location, status: 'open',
        openedAt: report.scannedAt, openedBy: `scan:${report.runId}`, reopenCount: prior.reopenCount + 1,
        ...(fixDueBy === undefined ? {} : { fixDueBy }),
      });
      continue;
    }
    stillOpen += 1;
    // Still open: a new state only when the tool now rates or words it differently (append-only, nothing overwritten).
    if (prior.severity !== o.severity || prior.title !== o.title || prior.location !== o.location) {
      const fixDueBy = prior.fixDueBy ?? fixDueByFor(o.severity, prior.openedAt);
      const rest = omit(prior, ['fixDueBy']);
      changes.push({ ...rest, title: o.title, severity: o.severity, toolSeverity: o.toolSeverity, location: o.location, ...(o.severity === 'critical' && fixDueBy !== undefined ? { fixDueBy } : {}) });
    }
  }
  let fixed = 0;
  if (report.complete) {
    for (const f of mine.values()) {
      if (f.status !== 'open' || seen.has(f.findingId)) continue;
      fixed += 1;
      changes.push({
        ...f, status: 'fixed', fixedAt: report.scannedAt, fixedBy: `scan:${report.runId}`,
        fixedEvidence: `not reported by the complete ${report.tool} scan ${report.runId}${report.commit === undefined ? '' : ` of commit ${report.commit}`} at ${report.scannedAt}`,
      });
    }
  }
  return {
    changes,
    summary: {
      tool: report.tool, runId: report.runId, scannedAt: report.scannedAt, complete: report.complete,
      observed: seen.size, opened, reopened, fixed, stillOpen, closedNothingBecausePartial: !report.complete,
    },
  };
}

// ── a person's finding (penetration test, review) ───────────────────────────────────────────────────────────

/** Record (or restate) a finding a PERSON raised. Its id is the person's own reference (the pentest report's item). */
export function recordPersonFinding(input: {
  readonly findingId: string; readonly source: unknown; readonly title: unknown; readonly severity: unknown; readonly location: unknown;
  readonly recordedBy: string; readonly at: string; readonly ownerUserId?: unknown; readonly prior?: SecurityFinding;
}): SecurityFinding {
  const problems: string[] = [];
  if (!isStr(input.findingId) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(input.findingId)) problems.push('the finding id is letters, digits, dot, dash or underscore');
  if (!PERSON_SOURCES.includes(input.source as FindingSource)) problems.push(`source is ${PERSON_SOURCES.join(' or ')} (scanner findings arrive with their scan)`);
  if (!isStr(input.title)) problems.push('title says what was found');
  if (!FINDING_SEVERITIES.includes(input.severity as FindingSeverity)) problems.push(`severity is one of ${FINDING_SEVERITIES.join(', ')}`);
  if (!isStr(input.location)) problems.push('location says where (a screen, a URL, a file)');
  if (input.ownerUserId !== undefined && !isStr(input.ownerUserId)) problems.push('ownerUserId, when given, names a person');
  if (!isStr(input.recordedBy)) problems.push('a finding is recorded in a named person\'s name');
  if (input.prior !== undefined && SCANNER_SOURCES.includes(input.prior.source)) problems.push(`"${input.findingId}" is a ${input.prior.tool} scanner finding and cannot be restated by hand`);
  if (problems.length > 0) throw new NotAPersonFindingError(problems);
  const severity = input.severity as FindingSeverity;
  const prior = input.prior;
  const reopen = prior !== undefined && prior.status === 'fixed';
  const openedAt = prior === undefined || reopen ? input.at : prior.openedAt;
  const fixDueBy = prior?.fixDueBy !== undefined && !reopen && severity === 'critical' ? prior.fixDueBy : fixDueByFor(severity, openedAt);
  const owner = isStr(input.ownerUserId) ? input.ownerUserId : prior?.ownerUserId;
  return {
    findingId: input.findingId, source: input.source as FindingSource, tool: input.source as string, ruleId: input.findingId,
    title: (input.title as string).slice(0, 300), severity, toolSeverity: severity, location: input.location as string, status: 'open',
    firstSeenAt: prior?.firstSeenAt ?? input.at, openedAt, openedBy: prior === undefined || reopen ? `person:${input.recordedBy}` : prior.openedBy,
    reopenCount: (prior?.reopenCount ?? 0) + (reopen ? 1 : 0),
    ...(owner === undefined ? {} : { ownerUserId: owner }), ...(fixDueBy === undefined ? {} : { fixDueBy }),
  };
}

/** A named person records the fix of a PERSON's finding, with written evidence. Scanner findings are refused. */
export function markPersonFindingFixed(finding: SecurityFinding, by: string, evidence: string, at: string): SecurityFinding {
  if (SCANNER_SOURCES.includes(finding.source)) throw new ScannerFindingCloseError(finding.findingId, finding.tool);
  if (!isStr(by) || !isStr(evidence)) throw new FixNeedsEvidenceError(finding.findingId);
  return { ...finding, status: 'fixed', fixedAt: at, fixedBy: by, fixedEvidence: evidence.trim() };
}

/** Name the person answerable for a finding — any finding, scanner or person. */
export function assignFindingOwner(finding: SecurityFinding, ownerUserId: string): SecurityFinding {
  if (!isStr(ownerUserId)) throw new NotAPersonFindingError(['ownerUserId names a person']);
  return { ...finding, ownerUserId: ownerUserId.trim() };
}

// ── what the gates read ─────────────────────────────────────────────────────────────────────────────────────

export interface FindingBlock {
  readonly gate: string;
  readonly findingId: string;
  readonly title: string;
  readonly severity: FindingSeverity;
  readonly ownerUserId?: string;
  readonly reason: string;
}

/**
 * The gates an open finding blocks: an open critical or high blocks QG-06 (§22 "zero open critical/high findings";
 * §35.1). When a CI scanner raised it, it also blocks QG-03 ("security scans … green").
 */
export function findingBlocks(findings: readonly SecurityFinding[]): readonly FindingBlock[] {
  const out: FindingBlock[] = [];
  for (const f of findings) {
    if (f.status !== 'open' || !BLOCKING_FINDING_SEVERITIES.includes(f.severity)) continue;
    const owner = f.ownerUserId === undefined ? 'nobody owns it yet' : `${f.ownerUserId} owns it`;
    const reason = `open ${f.severity} finding "${f.title}" (${f.tool} ${f.ruleId} at ${f.location}) — ${owner}`;
    const gates = SCANNER_SOURCES.includes(f.source) ? ['QG-03', 'QG-06'] : ['QG-06'];
    for (const gate of gates) out.push({ gate, findingId: f.findingId, title: f.title, severity: f.severity, ...(f.ownerUserId === undefined ? {} : { ownerUserId: f.ownerUserId }), reason });
  }
  return out;
}

/** Open criticals past their 72-hour emergency-fix target (§32) — the register shows them first, by name. */
export function overdueFindings(findings: readonly SecurityFinding[], now: string): readonly SecurityFinding[] {
  const t = Date.parse(now);
  return findings.filter((f) => f.status === 'open' && f.fixDueBy !== undefined && Date.parse(f.fixDueBy) < t);
}

export interface FindingsSummary {
  readonly open: Readonly<Record<FindingSeverity, number>>;
  readonly openBlocking: number;
  readonly overdueCritical: number;
  readonly unowned: number;
  readonly fixed: number;
}

export function summariseFindings(findings: readonly SecurityFinding[], now: string): FindingsSummary {
  const open: Record<FindingSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  let unowned = 0; let fixed = 0;
  for (const f of findings) {
    if (f.status === 'fixed') { fixed += 1; continue; }
    open[f.severity] += 1;
    if (f.ownerUserId === undefined) unowned += 1;
  }
  return { open, openBlocking: open.critical + open.high, overdueCritical: overdueFindings(findings, now).length, unowned, fixed };
}
