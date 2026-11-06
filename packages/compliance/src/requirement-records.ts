// W7 · QG-01 "No build without approved ID, rules, actors, errors, permissions and testable acceptance" (roadmap §22) — the
// requirement-records reading. Every module requirement `M##-FR-##` in `docs/requirements/M##.md` is the Appendix B record a
// build starts from; QG-01 asks that each one carries the five things the gate names. This file is THE check — the CI
// guardrail (tests/guardrails/every-requirement-record-has-actors-rules-errors-permissions-and-acceptance.test.ts) runs it on
// every pull request, and the CI's reading step (scripts/requirement-records-reading.mts) runs the very same functions and
// sends the result to head office, so the Quality gates page shows the same check the build makes:
//
//   • the reading becomes a findings report on head office's register (tool `requirement-records`, source `repository` —
//     the CI's reading of the repository's own documents, as QG-03's branch-protection reading is), so a record missing a
//     field is an open HIGH finding that holds QG-01 by name, and a later complete reading closes it — never by hand;
//   • a reading that could not read every record (fewer or more than the 144, or an id twice) is INCOMPLETE and closes
//     nothing;
//   • the gate register adds one rule (`qg01RequirementRecordsBlockers`): no reading on file, or a latest reading that was
//     not complete, holds QG-01 as NOT KNOWN. Silence is never "complete" (P-08).
// A clean reading is evidence for the owner's QG-01 decision — never the decision: GO needs his signed review (QG-12).
// Pure: no clock, no I/O (the script reads the files and hands their text in).

import type { FindingObservation, ScanReport, SecurityFinding } from './findings';
import type { GateBlocker } from './gate-decisions';
import type { ScanRunView } from './branch-protection';

export const REQUIREMENT_RECORDS_TOOL = 'requirement-records';
/** 36 modules × 4 functional requirements (roadmap Appendix B). */
export const QG01_EXPECTED_RECORDS = 144;

export type RecordField = 'actors' | 'rules' | 'errors' | 'permissions' | 'acceptance';
export const RECORD_FIELD_WORDS: Readonly<Record<RecordField, string>> = Object.freeze({
  actors: 'actors', rules: 'business rules', errors: 'error flow', permissions: 'permissions', acceptance: 'acceptance criteria',
});
const LABELS: Readonly<Record<RecordField, RegExp>> = {
  actors: /\*\*Actors[^*\n]{0,40}:\*\*/i,
  rules: /\*\*(?:Business rules|Rules)[^*\n]{0,40}:\*\*/i,
  errors: /\*\*(?:Alternate \/ error flows|Alt\/error|Alt \/ error|Error flows?)[^*\n]{0,40}:\*\*/i,
  permissions: /\*\*Permissions[^*\n]{0,40}:\*\*/i,
  acceptance: /\*\*Acceptance(?: criteria)?[^*\n]{0,40}:\*\*/i,
};
/** Where a field's text ends: the next labelled field on the line, or the next bullet. */
const NEXT_FIELD = /\*\*[^*\n]{1,60}:\*\*|\n\s*-\s+\*\*/;

export interface RequirementRecord { readonly id: string; readonly file: string; readonly body: string }

/** Every `## M##-FR-##` record in the given `M##.md` files (other files are ignored), in file order. */
export function requirementRecordsOf(files: readonly { readonly name: string; readonly text: string }[]): readonly RequirementRecord[] {
  const out: RequirementRecord[] = [];
  for (const f of [...files].filter((x) => /^M\d\d\.md$/.test(x.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    for (const part of f.text.split(/^## (?=M\d\d-FR-\d\d)/m).slice(1)) out.push({ id: part.slice(0, 9), file: f.name, body: part.split(/^##? /m)[0]! });
  }
  return out;
}

/** The fields a record is missing — a label that is absent, or present with nothing after it. */
export function missingFields(body: string): readonly RecordField[] {
  const missing: RecordField[] = [];
  for (const [field, label] of Object.entries(LABELS) as [RecordField, RegExp][]) {
    const m = label.exec(body);
    if (m === null) { missing.push(field); continue; }
    const rest = body.slice(m.index + m[0].length);
    const end = NEXT_FIELD.exec(rest);
    if ((end === null ? rest : rest.slice(0, end.index)).trim() === '') missing.push(field);
  }
  return missing;
}

export interface RequirementRecordsReading {
  readonly records: number;
  readonly expected: number;
  readonly distinct: number;
  /** Every record read in full: exactly the expected count, each id once. */
  readonly readAll: boolean;
  readonly incomplete: readonly { readonly id: string; readonly file: string; readonly missing: readonly RecordField[] }[];
  readonly detail: string;
}

/** QG-01's check over the requirement files — the same check the CI guardrail makes. */
export function readRequirementRecords(files: readonly { readonly name: string; readonly text: string }[], expected: number = QG01_EXPECTED_RECORDS): RequirementRecordsReading {
  const all = requirementRecordsOf(files);
  const distinct = new Set(all.map((r) => r.id)).size;
  const readAll = all.length === expected && distinct === expected;
  const incomplete = all.map((r) => ({ id: r.id, file: r.file, missing: missingFields(r.body) })).filter((r) => r.missing.length > 0);
  const detail = !readAll
    ? `read ${all.length} requirement records (${distinct} different ids) where ${expected} are expected — the reading is not complete`
    : incomplete.length === 0
      ? `all ${expected} module requirement records carry actors, rules, error flow, permissions and acceptance`
      : `${incomplete.length} of ${expected} records are missing a field: ${incomplete.map((r) => `${r.id} (${r.missing.map((m) => RECORD_FIELD_WORDS[m]).join(', ')})`).join('; ')}`;
  return { records: all.length, expected, distinct, readAll, incomplete, detail };
}

/**
 * The reading as a findings report for head office's register. Every record missing a field is a HIGH observation (high
 * blocks a gate while open, §22); a reading that could not read every record is an incomplete run, so it closes nothing.
 */
export function requirementRecordsReport(reading: RequirementRecordsReading, run: { readonly runId: string; readonly scannedAt: string; readonly commit?: string }): ScanReport {
  const observations: FindingObservation[] = reading.incomplete.map((r) => ({
    fingerprint: `${REQUIREMENT_RECORDS_TOOL}|${r.id}|${r.missing.join(',')}`,
    source: 'repository', tool: REQUIREMENT_RECORDS_TOOL,
    ruleId: `missing:${r.missing.join(',')}`,
    title: `QG-01: ${r.id} is missing ${r.missing.map((m) => RECORD_FIELD_WORDS[m]).join(', ')}`,
    severity: 'high', toolSeverity: 'MISSING',
    location: `docs/requirements/${r.file} ${r.id}`,
  }));
  return {
    tool: REQUIREMENT_RECORDS_TOOL, source: 'repository', runId: run.runId, scannedAt: run.scannedAt,
    ...(run.commit === undefined ? {} : { commit: run.commit }),
    complete: reading.readAll, ...(reading.readAll ? {} : { incompleteBecause: [reading.detail] }), observations,
  };
}

/**
 * The gate register's own QG-01 rule: no requirement-records reading on file, or a latest reading that could not read every
 * record, holds QG-01 as NOT KNOWN. (A record a reading found missing a field is already an open high finding on QG-01.)
 */
export function qg01RequirementRecordsBlockers(scans: readonly ScanRunView[]): readonly GateBlocker[] {
  const mine = scans.filter((s) => s.tool === REQUIREMENT_RECORDS_TOOL);
  if (mine.length === 0) {
    return [{ gate: 'QG-01', kind: 'check', ref: 'requirement-records:no-reading', reason: 'the requirement records are NOT KNOWN — no reading of them is on file, so nothing shows every module requirement carries actors, rules, error flow, permissions and acceptance' }];
  }
  const latest = mine.reduce((a, z) => (z.scannedAt >= a.scannedAt ? z : a));
  if (!latest.complete) {
    return [{ gate: 'QG-01', kind: 'check', ref: `requirement-records:not-known:${latest.runId}`, reason: `the requirement records are NOT KNOWN — the latest reading (${latest.scannedAt}) could not read every record` }];
  }
  return [];
}

/** What the Quality gates page shows for QG-01: the latest reading and what it found, in words. Never "passed". */
export interface Qg01ReadingView {
  readonly standing: 'not_known' | 'failing' | 'check_clean';
  readonly latest: { readonly runId: string; readonly scannedAt: string; readonly complete: boolean; readonly commit?: string; readonly incompleteBecause?: readonly string[] } | null;
  readonly failing: readonly { readonly findingId: string; readonly title: string; readonly location: string }[];
  readonly says: string;
}

export function qg01ReadingOf(
  scans: readonly (ScanRunView & { readonly commit?: string; readonly incompleteBecause?: readonly string[] })[],
  findings: readonly Pick<SecurityFinding, 'findingId' | 'tool' | 'status' | 'title' | 'location'>[],
): Qg01ReadingView {
  const mine = scans.filter((s) => s.tool === REQUIREMENT_RECORDS_TOOL);
  const failing = findings.filter((f) => f.tool === REQUIREMENT_RECORDS_TOOL && f.status === 'open').map((f) => ({ findingId: f.findingId, title: f.title, location: f.location }));
  if (mine.length === 0) return { standing: 'not_known', latest: null, failing, says: 'No reading of the requirement records is on file — QG-01 holds as NOT KNOWN.' };
  const l = mine.reduce((a, z) => (z.scannedAt >= a.scannedAt ? z : a));
  const latest = { runId: l.runId, scannedAt: l.scannedAt, complete: l.complete, ...(l.commit === undefined ? {} : { commit: l.commit }), ...(l.incompleteBecause === undefined ? {} : { incompleteBecause: l.incompleteBecause }) };
  if (!l.complete) return { standing: 'not_known', latest, failing, says: 'The latest reading could not read every requirement record — QG-01 holds as NOT KNOWN.' };
  if (failing.length > 0) return { standing: 'failing', latest, failing, says: `${failing.length} requirement record(s) are missing a field — QG-01 holds until each is completed.` };
  return { standing: 'check_clean', latest, failing, says: `The latest reading found every one of the ${QG01_EXPECTED_RECORDS} records complete. This is evidence for the owner's QG-01 decision, not the decision: the gate is not passed until he records it with his signed review (QG-12).` };
}
