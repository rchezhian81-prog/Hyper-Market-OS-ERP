// W3 · the gates' OUTSIDE evidence (QG-04 · QG-05 · QG-06 · roadmap §22, §32, §35.1) — the register head office keeps of
// the tests only real hardware, a real store or an independent vendor can run, and the machine checks that read it.
//
// §22 gives each gate a pass condition; §32 names the evidence for it:
//   QG-04 Offline      "Offline duration — minimum 72 hours core trading … 72-hour simulation";
//                      "Transaction durability — zero acknowledged transaction loss … Power/process/chaos tests".
//   QG-05 Performance  "POS scan-to-line p95 ≤300 ms on certified pilot hardware — Performance test";
//                      "POS total/tender screen p95 ≤500 ms excluding external authorization — Performance test".
//   QG-06 Security     "independent penetration test before customer launch" (§35.1: "before customer-facing production").
//
// None of these can be produced by the software alone, so the register holds what a named person recorded: what was
// tested, where (the certified hardware, the vendor), when, the result, and where the report is. The rules:
//
//   • MISSING EVIDENCE NEVER READS AS PASSED. A kind with nothing on file is a blocker on its gate, by name (P-08).
//   • The latest record of a kind decides (by the day it was tested, then when it was recorded); a failed one blocks.
//   • A p95 is never typed as "passed": the measured milliseconds are recorded and the result is WORKED OUT here against
//     the fixed §32 target — a 340 ms scan-to-line cannot be recorded as a pass.
//   • Append-only (hard rules #2, #6): a record is never changed; a newer test is a new record.
//   • The penetration test counts for the releases from R4 "Customer commerce" (the roadmap's first customer-facing
//     release, §35.1 "before customer-facing production"). Every other kind counts for every release.
//
// This is EVIDENCE for the owner's GO / HOLD / REWORK (QG-12), never the decision. Pure: no clock, no I/O.

import type { GateBlocker } from './gate-decisions';
import { RELEASES } from './gate-decisions';

export type GateEvidenceKind = 'offline_72h_simulation' | 'power_process_chaos' | 'scan_to_line_p95' | 'total_tender_p95' | 'independent_pentest';

export interface GateEvidenceSpec {
  readonly kind: GateEvidenceKind;
  readonly gate: 'QG-04' | 'QG-05' | 'QG-06';
  /** What it is, in words. */
  readonly words: string;
  /** The roadmap's own words for the target and its evidence. */
  readonly roadmap: string;
  /** For a timing: the §32 p95 target in milliseconds. The result is worked out from the measured figure. */
  readonly maxMs?: number;
  /** The releases this evidence is needed for (absent: every release). */
  readonly releases?: readonly string[];
}

/** R4 "Customer commerce" is the roadmap's first customer-facing release (§20 release plan; §35.1). */
export const CUSTOMER_FACING_RELEASES: readonly string[] = Object.freeze(RELEASES.slice(RELEASES.indexOf('R4')));

export const GATE_EVIDENCE_SPECS: readonly GateEvidenceSpec[] = Object.freeze([
  { kind: 'offline_72h_simulation', gate: 'QG-04', words: '72-hour offline trading simulation', roadmap: '§32 Offline duration: minimum 72 hours core trading — 72-hour simulation' },
  { kind: 'power_process_chaos', gate: 'QG-04', words: 'Power, process and chaos test (no acknowledged sale lost)', roadmap: '§32 Transaction durability: zero acknowledged transaction loss — power/process/chaos tests' },
  { kind: 'scan_to_line_p95', gate: 'QG-05', words: 'Scan-to-line speed on certified pilot hardware', roadmap: '§32 POS scan-to-line: p95 ≤300 ms on certified pilot hardware — performance test', maxMs: 300 },
  { kind: 'total_tender_p95', gate: 'QG-05', words: 'Total and tender screen speed', roadmap: '§32 POS total/tender screen: p95 ≤500 ms excluding external authorization — performance test', maxMs: 500 },
  { kind: 'independent_pentest', gate: 'QG-06', words: 'Independent penetration test', roadmap: '§22 QG-06 / §35.1: independent penetration test before customer-facing production', releases: CUSTOMER_FACING_RELEASES },
].map((s) => Object.freeze(s)) as GateEvidenceSpec[]);

export const GATE_EVIDENCE_KINDS: readonly GateEvidenceKind[] = Object.freeze(GATE_EVIDENCE_SPECS.map((s) => s.kind));

export interface GateEvidenceRecord {
  readonly evidenceId: string;
  readonly kind: GateEvidenceKind;
  readonly gate: string;
  readonly result: 'passed' | 'failed';
  /** For a timing: the measured p95 in milliseconds. */
  readonly measuredMs?: number;
  /** Where it was done: the certified store PC and lanes, the vendor — in words. */
  readonly where: string;
  /** Where the report is: a file, a link, a register id. */
  readonly reportRef: string;
  /** The day it was tested (YYYY-MM-DD). */
  readonly testedOn: string;
  /** What the person who records it says, in writing. */
  readonly statement: string;
  /** The signed-in person who recorded it — never a body field. */
  readonly recordedBy: string;
  readonly recordedAt: string;
}

export class NotGateEvidenceError extends Error {
  constructor(public readonly problems: readonly string[]) {
    super(`Gate evidence needs: ${problems.join('; ')}`);
    this.name = 'NotGateEvidenceError';
  }
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export const specOf = (kind: GateEvidenceKind): GateEvidenceSpec => GATE_EVIDENCE_SPECS.find((s) => s.kind === kind)!;

/**
 * Read one record from an untrusted body. The recorder and the moment come from the caller (the signed-in person, the
 * server clock). For a timing the result is worked out from `measuredMs`; a body that sends its own `result` for a timing
 * is refused rather than believed.
 */
export function readGateEvidence(input: {
  readonly evidenceId: string; readonly body: unknown; readonly recordedBy: string; readonly recordedAt: string;
}): GateEvidenceRecord {
  const b = (input.body !== null && typeof input.body === 'object' && !Array.isArray(input.body) ? input.body : {}) as Record<string, unknown>;
  const problems: string[] = [];
  if (!ID.test(input.evidenceId)) problems.push('an evidence id of letters, digits, dot, dash or underscore');
  const kind = b['kind'] as GateEvidenceKind;
  const spec = GATE_EVIDENCE_KINDS.includes(kind) ? specOf(kind) : undefined;
  if (spec === undefined) problems.push(`kind is one of ${GATE_EVIDENCE_KINDS.join(', ')}`);
  let result: 'passed' | 'failed' | undefined;
  let measuredMs: number | undefined;
  if (spec?.maxMs !== undefined) {
    if (b['result'] !== undefined) problems.push(`a timing's result is worked out from the measured p95 against the ${spec.maxMs} ms target — send measuredMs, not a result`);
    if (!Number.isInteger(b['measuredMs']) || (b['measuredMs'] as number) <= 0) problems.push('measuredMs is the measured p95 in whole milliseconds');
    else { measuredMs = b['measuredMs'] as number; result = measuredMs <= spec.maxMs ? 'passed' : 'failed'; }
  } else if (spec !== undefined) {
    if (b['measuredMs'] !== undefined) problems.push('only a timing carries measuredMs');
    if (b['result'] !== 'passed' && b['result'] !== 'failed') problems.push('result is passed or failed');
    else result = b['result'];
  }
  if (!isStr(b['where'])) problems.push(spec?.kind === 'independent_pentest' ? 'where names the independent vendor who tested' : 'where says what it ran on (the certified store PC and lanes)');
  if (!isStr(b['reportRef'])) problems.push('reportRef says where the report is (a file, a link, a register id)');
  if (!isStr(b['testedOn']) || !DAY.test(b['testedOn'] as string) || Number.isNaN(Date.parse(`${b['testedOn'] as string}T00:00:00Z`))) problems.push('testedOn is the day it was tested (YYYY-MM-DD)');
  if (!isStr(b['statement'])) problems.push('statement says, in writing, what was seen');
  if (!isStr(input.recordedBy)) problems.push('evidence is recorded in a named person\'s own name');
  if (problems.length > 0) throw new NotGateEvidenceError(problems);
  return {
    evidenceId: input.evidenceId, kind, gate: spec!.gate, result: result!, ...(measuredMs === undefined ? {} : { measuredMs }),
    where: (b['where'] as string).trim().slice(0, 300), reportRef: (b['reportRef'] as string).trim().slice(0, 500),
    testedOn: b['testedOn'] as string, statement: (b['statement'] as string).trim().slice(0, 1000),
    recordedBy: input.recordedBy, recordedAt: input.recordedAt,
  };
}

/** The same record again (a re-send) — everything but when it was recorded. */
export const sameEvidence = (a: GateEvidenceRecord, z: GateEvidenceRecord): boolean =>
  (['evidenceId', 'kind', 'gate', 'result', 'measuredMs', 'where', 'reportRef', 'testedOn', 'statement', 'recordedBy'] as const).every((k) => a[k] === z[k]);

/** The latest record of a kind: the latest day tested, then the latest recorded. */
export function latestEvidence(records: readonly GateEvidenceRecord[], kind: GateEvidenceKind): GateEvidenceRecord | undefined {
  let best: GateEvidenceRecord | undefined;
  for (const r of records) {
    if (r.kind !== kind) continue;
    if (best === undefined || r.testedOn > best.testedOn || (r.testedOn === best.testedOn && r.recordedAt >= best.recordedAt)) best = r;
  }
  return best;
}

/** A blocker as the gate register reads it, with the releases it counts for (absent: every release). */
export type ScopedGateBlocker = GateBlocker;

/** Every kind with nothing on file, or whose latest record failed, blocks its gate — by name. */
export function gateEvidenceBlockers(records: readonly GateEvidenceRecord[]): readonly ScopedGateBlocker[] {
  const out: ScopedGateBlocker[] = [];
  for (const spec of GATE_EVIDENCE_SPECS) {
    const latest = latestEvidence(records, spec.kind);
    const scope = spec.releases === undefined ? {} : { releases: spec.releases };
    if (latest === undefined) {
      out.push({ gate: spec.gate, kind: 'check', ref: `evidence:${spec.kind}`, reason: `${spec.words}: nothing on file — not passed until it is done and recorded (${spec.roadmap})`, ...scope });
    } else if (latest.result === 'failed') {
      const figure = latest.measuredMs === undefined ? '' : ` — p95 ${latest.measuredMs} ms against the ${spec.maxMs} ms target`;
      out.push({ gate: spec.gate, kind: 'check', ref: `evidence:${spec.kind}:${latest.evidenceId}`, reason: `${spec.words}: the latest one (${latest.testedOn}, ${latest.where}) FAILED${figure}; report ${latest.reportRef}`, ...scope });
    }
  }
  return out;
}

/** Only the blockers that count for this release. */
export const blockersForRelease = <B extends { readonly releases?: readonly string[] }>(blockers: readonly B[], release: string): readonly B[] =>
  blockers.filter((b) => b.releases === undefined || b.releases.includes(release));
