// W3 · MG-01 · MG-03 · MG-07 · MG-08 · MG-09 · MG-12 · MG-11 (roadmap §30 migration controls) — the "Old system checks"
// office page's tested, DOM-free session. W4 adds the load's own steps (WF-19 · MG-02 · MG-04 · MG-05 · MG-06): the export
// checked against its seal, the old data's problems decided, the trial load's record (volume, time, projection), the
// figures signed, and the switch-over gate's own reading with the rehearsed going-back. Until now these head-office routes had no caller on any screen: a named person
// could only discover the old sources, approve a code mapping, decide a left-behind exclusion, compare two exports, check
// the switch-over night, undo an opening load or assess retiring the old system by hand-made API calls.
//
// The page is a THIN CLIENT. Every rule is head office's (services/migration/src): the session only refuses what it can see
// is incomplete before asking, sends what the person typed (never their name — head office takes the signed-in person),
// and folds every answer into one Outcome the page shows in head office's own words. Nothing is read or written on open
// or on a timer; every act is an explicit click. Synthetic data only in tests; the routes refuse a production target (#7).

import type { ViewerIdentity } from './browser-entry';
import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

// ── what head office answers (the parts the page shows) ─────────────────────────────────────────────────────

export const SOURCE_KINDS = Object.freeze(['erp_database', 'pos_database', 'spreadsheet', 'paper', 'third_party_system', 'report_only'] as const);
export const VOLUME_BASES = Object.freeze(['counted', 'estimated', 'unknown'] as const);
export const MAPPING_DOMAINS = Object.freeze(['tax_code', 'uom', 'department', 'account', 'branch', 'identity', 'document_kind'] as const);
export const EXCLUSION_SCOPES = Object.freeze(['documents_before', 'entity_kind', 'named_records', 'inactive_records'] as const);

export interface SourceDraft {
  readonly sourceId: string; readonly name: string; readonly kind: string; readonly ownerUserId: string;
  readonly rowCount: string; readonly volumeBasis: string; readonly retentionYears: string; readonly extractable: boolean;
}
export interface LegacySourceBody {
  readonly sourceId: string; readonly name: string; readonly kind: string; readonly volumeBasis: string; readonly extractable: boolean;
  readonly ownerUserId?: string; readonly rowCount?: number; readonly retentionYears?: number;
}
export interface DiscoveryRead {
  readonly complete: boolean; readonly countedRows: number; readonly detail: string;
  readonly gaps: readonly { readonly sourceId: string; readonly name: string; readonly kind: string; readonly detail: string }[];
}
export interface MappingEntryBody { readonly domain: string; readonly legacyValue: string; readonly targetValue: string; readonly rationale: string }
export interface ObservedBody { readonly domain: string; readonly value: string; readonly rows: number }
export interface MappingTableRead {
  readonly mappingId: string; readonly tenantId: string; readonly version: number; readonly status: string;
  readonly entries: readonly MappingEntryBody[]; readonly approvedBy?: string; readonly approvedAt?: string;
}
export interface CoverageRead {
  readonly fullyCovered: boolean; readonly totalAffectedRows: number; readonly detail: string;
  readonly byDomain: readonly { readonly domain: string; readonly distinctValues: number; readonly covered: number; readonly uncovered: readonly string[]; readonly affectedRows: number }[];
}
export interface ExclusionRead {
  readonly exclusionId: string; readonly scope: string; readonly description: string; readonly recordCount: number; readonly valueMinor: number;
  readonly reason: string; readonly status: 'proposed' | 'approved' | 'rejected'; readonly proposedBy: string; readonly proposedAt: string;
  readonly approvedBy?: string; readonly approvedAt?: string; readonly ownerStatement?: string;
}
export interface ExclusionsRead { readonly exclusions: readonly ExclusionRead[]; readonly position: { readonly detail: string } }
export interface ExportDomainRead { readonly domain: string; readonly words: { readonly en: string; readonly ta: string }; readonly fields: readonly { readonly key: string; readonly required: boolean; readonly words: { readonly en: string; readonly ta: string } }[] }
export interface ExportRunRead {
  readonly diffId: string; readonly domain: string; readonly baselineLabel: string; readonly latestLabel: string; readonly by: string; readonly at: string;
  readonly counts: { readonly baseline: number; readonly latest: number; readonly added: number; readonly changed: number; readonly removed: number; readonly unchanged: number };
  readonly undecided?: number; readonly exceptionIds: readonly string[];
}
export interface ExportDiffsRead { readonly runs: readonly ExportRunRead[]; readonly domains: readonly ExportDomainRead[] }
export interface ExportDiffResult { readonly run: ExportRunRead; readonly detail?: string; readonly alreadyRecorded?: boolean }
export interface WindowRead {
  readonly cutoverId: string; readonly go: boolean; readonly openNow: boolean;
  readonly window: { readonly opensAt: string; readonly closesAt: string; readonly goBy: string } | null;
  readonly theCutover?: { readonly cutoverId: string; readonly opensAt: string; readonly closesAt: string };
}
export interface NightCheckRead {
  readonly rollBackNow: boolean; readonly detail: string; readonly cutoverId: string | null;
  readonly crossed: readonly { readonly limit: string; readonly detail: string }[];
  readonly notKnown: readonly string[];
  readonly newlyRaised: readonly unknown[];
}
export interface ReversalLine { readonly domain: string; readonly key: string; readonly openedMinor: number; readonly reversedMinor: number; readonly netMinor: number }
export interface ReversalRead {
  readonly request: { readonly loadId: string; readonly cutoverId: string; readonly reason: string; readonly requestedBy: string; readonly requestedAt: string };
  readonly approval: { readonly approvedBy: string; readonly approvedAt: string } | null;
  readonly position: readonly ReversalLine[]; readonly reversedToZero: boolean;
}
export interface RetirementRead {
  readonly archiveId: string; readonly mayRetireSystem: boolean; readonly blockedBy: readonly string[];
  readonly retentionEndsOn: string; readonly dataIsNeverDeleted: true; readonly detail: string;
}
// ── W4 · WF-19 · MG-02 · MG-04 · MG-05 · MG-06 — the load, its problems, its trial, its figures and the switch-over checks ─────
/** MG-02 — head office's answer to "are these the bytes that were sealed?" (digest AND row count). */
export interface VerifyRead { readonly matches: boolean; readonly rowCountMatches: boolean; readonly expected: string; readonly actual: string; readonly detail: string }
/** MG-05 — the trial-load record: the volume, the time it took, and the projection to the full volume. */
export interface TrialLoadRead {
  readonly ok: boolean; readonly trialId: string; readonly rowsLoaded: number; readonly elapsedMs?: number; readonly projectedFullVolumeMs?: number;
  readonly repeatable: boolean; readonly detail: string;
}
export interface MigrationExceptionRead {
  readonly exceptionId: string; readonly kind: string; readonly severity: string; readonly confidence: string; readonly legacyIds: readonly string[];
  readonly evidence: string; readonly valueMinor?: number;
  readonly resolution?: { readonly action: string; readonly decidedBy: string; readonly decidedAt: string; readonly reason: string; readonly survivingLegacyId?: string };
}
export interface ExceptionsRead {
  readonly exceptions: readonly MigrationExceptionRead[];
  readonly outstanding: { readonly total: number; readonly blockingUnresolved: readonly { readonly exceptionId: string }[]; readonly clearForCutover: boolean; readonly detail: string };
}
export interface ControlTotalRead {
  readonly totalId: string; readonly kind: string; readonly name: string; readonly unit: string; readonly legacyValue: number; readonly loadedValue: number;
  readonly legacyDerivation: string; readonly loadedDerivation: string;
  readonly signature?: { readonly signedBy: string; readonly signerRole: string; readonly signedAt: string; readonly statement: string };
}
export interface TotalsRead {
  readonly totals: readonly ControlTotalRead[];
  readonly reconciliation: { readonly qg07Passed: boolean; readonly detail: string; readonly assessments: readonly { readonly totalId: string; readonly status: string; readonly signed: boolean; readonly difference: number; readonly detail: string }[] };
}
/** The switch-over gate's own reading: every check worked out from head office's records ("not known" never passes). */
export interface GateRead {
  readonly decision: { readonly go: boolean; readonly failed: readonly string[] };
  readonly checks: readonly { readonly check: string; readonly state: 'passed' | 'failed' | 'not_known'; readonly evidence: string }[];
  readonly notKnown: readonly string[]; readonly detail: string;
}
export interface RollbackRead {
  readonly rollback: { readonly cutoverId: string; readonly state: string; readonly performed: boolean; readonly trigger: string; readonly decidedBy: string; readonly decidedAt: string; readonly detail: string };
  readonly reconciliations: readonly { readonly reconciled: boolean; readonly decidedAt: string }[];
  readonly demonstrated: boolean;
}
export const RESOLUTION_ACTIONS = Object.freeze(['correct', 'exclude', 'migrate_as_is', 'merge'] as const);

export interface RetirementDraft {
  readonly archiveId: string; readonly sourceId: string; readonly digest: string; readonly rowCount: string; readonly archivedOn: string;
  readonly retentionYears: string; readonly earliestRecordDate: string; readonly latestRecordDate: string; readonly restoreVerifiedOn: string;
  readonly cutoverAccepted: boolean; readonly openAssessments: string;
}

// ── U6 · MG-09 the delta LOAD: the changes file, the steps ladder ──────────────────────────────────────────────────

/** One change made in the old system after the final extract — the route's own fields (services/migration, DeltaChange). */
export interface DeltaChangeBody {
  readonly changeKey: string; readonly entity: string; readonly legacyId: string; readonly operation: 'insert' | 'update' | 'delete'; readonly changedAt: string;
  readonly deltaMinor?: number; readonly deltaQty?: number; readonly locationId?: string; readonly uom?: string; readonly unitCostMinor?: number;
  readonly netMinor?: number; readonly cgstMinor?: number; readonly sgstMinor?: number; readonly tender?: string;
}
export interface DeltaLineRead { readonly changeKey: string; readonly outcome: string; readonly detail: string; readonly effect?: string }
export interface DeltaRead {
  readonly ok: boolean; readonly applied: number; readonly duplicatesIgnored: number; readonly refused: number;
  readonly lines: readonly DeltaLineRead[]; readonly appliedKeys: readonly string[]; readonly netValueMinor: number; readonly netQty: number; readonly detail: string;
}
export type DeltaCsvRead =
  | { readonly ok: true; readonly changes: readonly DeltaChangeBody[] }
  | { readonly ok: false; readonly why: 'noDeltaFile' | 'noDeltaRows' }
  | { readonly ok: false; readonly why: 'deltaColumnsMissing'; readonly missing: readonly string[] }
  | { readonly ok: false; readonly why: 'deltaRowBad'; readonly row: number; readonly field: string };

const DELTA_REQUIRED = ['changeKey', 'entity', 'legacyId', 'operation', 'changedAt'] as const;
const DELTA_NUMBERS = ['deltaMinor', 'deltaQty', 'unitCostMinor', 'netMinor', 'cgstMinor', 'sgstMinor'] as const;
const DELTA_WORDS = ['locationId', 'uom', 'tender'] as const;
const DELTA_OPS = ['insert', 'update', 'delete'] as const;

/** A small RFC-4180 reader: quoted fields, doubled quotes, CR/LF lines, a BOM. */
function csvLines(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let field = ''; let quoted = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') { if (src[i + 1] === '"') { field += '"'; i += 1; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && src[i + 1] === '\n') i += 1; row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

/**
 * The changes file → the route's own body, or why it cannot be sent. The columns ARE the route's field names (no format of
 * this page's own); the five the route requires must be there; a number column must hold a number; blanks are left out.
 */
export function readDeltaCsv(csv: string): DeltaCsvRead {
  if (csv.trim() === '') return { ok: false, why: 'noDeltaFile' };
  const lines = csvLines(csv);
  const head = (lines[0] ?? []).map((h) => h.trim());
  const missing = DELTA_REQUIRED.filter((f) => !head.includes(f));
  if (missing.length > 0) return { ok: false, why: 'deltaColumnsMissing', missing };
  const body = lines.slice(1);
  if (body.length === 0) return { ok: false, why: 'noDeltaRows' };
  const changes: DeltaChangeBody[] = [];
  for (const [i, cells] of body.entries()) {
    const row = i + 2; // the row as a person counts it in the file (the heading is row 1)
    const at = (f: string): string => (cells[head.indexOf(f)] ?? '').trim();
    for (const f of DELTA_REQUIRED) if (at(f) === '') return { ok: false, why: 'deltaRowBad', row, field: f };
    if (!(DELTA_OPS as readonly string[]).includes(at('operation'))) return { ok: false, why: 'deltaRowBad', row, field: 'operation' };
    const change: Record<string, string | number> = { changeKey: at('changeKey'), entity: at('entity'), legacyId: at('legacyId'), operation: at('operation'), changedAt: at('changedAt') };
    for (const f of DELTA_NUMBERS) {
      if (!head.includes(f) || at(f) === '') continue;
      const n = Number(at(f));
      if (!Number.isFinite(n)) return { ok: false, why: 'deltaRowBad', row, field: f };
      change[f] = n;
    }
    for (const f of DELTA_WORDS) if (head.includes(f) && at(f) !== '') change[f] = at(f);
    changes.push(change as unknown as DeltaChangeBody);
  }
  return { ok: true, changes };
}

/** A shop day (YYYY-MM-DD) at a shop time (HH:MM, Asia/Kolkata — the shop calendar's zone, no DST) → the instant head office compares with. */
export function shopMomentOf(day: string, time = '00:00'): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day.trim())) return undefined;
  const t = /^\d{2}:\d{2}$/.test(time.trim()) ? time.trim() : '00:00';
  const ms = Date.parse(`${day.trim()}T${t}:00+05:30`);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** The migration controls in the roadmap's order (§30 MG-01…MG-12), each with its section on this page — the ladder at the top. */
export const MIGRATION_STEPS = Object.freeze([
  { control: 'MG-01', word: 'step_discovery', anchor: '#disc' },
  { control: 'MG-02', word: 'step_seal', anchor: '#seal' },
  { control: 'MG-03', word: 'step_mapping', anchor: '#map' },
  { control: 'MG-04', word: 'step_cleaning', anchor: '#prob' },
  { control: 'MG-05', word: 'step_trial', anchor: '#trial' },
  { control: 'MG-06', word: 'step_totals', anchor: '#tot' },
  { control: 'MG-07', word: 'step_history', anchor: '#excl' },
  { control: 'MG-08', word: 'step_opening', anchor: '#night' },
  { control: 'MG-09', word: 'step_delta_capture', anchor: '#diff' },
  { control: 'MG-09', word: 'step_delta_load', anchor: '#delta' },
  { control: 'MG-10', word: 'step_parallel', anchor: '#books' },
  { control: 'MG-11', word: 'step_cutover', anchor: '#gate' },
  { control: 'MG-12', word: 'step_retire', anchor: '#retire' },
] as const);

// ── words ───────────────────────────────────────────────────────────────────────────────────────────────────

export const OLD_SYSTEM_COPY = {
  en: {
    lang: 'தமிழ்', title: 'Old system checks',
    // U6: the steps ladder (MG-01…MG-12) and the delta LOAD step (MG-09)
    stepsH: 'The twelve controls, in order', stepsLead: 'Every migration control the roadmap names (MG-01 to MG-12) is a step on this page. Source profiling, the trial load and the delta are their own steps; tap one to go to it.',
    step_discovery: 'Source profiling — where the old records are, how many, who owns each', step_seal: 'The export checked against its seal', step_mapping: 'The code mapping and its coverage', step_cleaning: 'Problems in the old data, decided',
    step_trial: 'Trial load — full volume, timed, repeatable', step_totals: 'The figures, reconciled and signed', step_history: 'What is left behind, and why', step_opening: 'The opening load and undoing it',
    step_delta_capture: 'Delta — the changes since the final extract, found by comparing two exports', step_delta_load: 'Delta — the changes loaded, exactly once', step_parallel: 'Running both systems: the books side of a day', step_cutover: 'The switch-over night and its gate', step_retire: 'Switching the old system off',
    deltaH: 'Load the changes made after the final extract', deltaLead: 'Between the final extract and the switch-over night the old shop keeps trading. The changes file carries each change with its own key (the columns are head office\'s own field names: changeKey, entity, legacyId, operation, changedAt, and for stock deltaQty, locationId, uom, unitCostMinor; for a sale deltaMinor, netMinor, cgstMinor, sgstMinor, tender). Head office applies each exactly once: a change sent again is "already applied" (a success), a change dated before the extract\'s moment is refused as already in the extract, and a kind this version cannot apply is refused by name — never counted.',
    deltaCutoff: 'The final extract was taken on (day)', deltaCutoffTime: 'at (shop time, HH:MM)', deltaFile: 'The changes file (CSV)', readDelta: 'Read the file', loadDelta: 'Load the changes', deltaRead: 'changes read from the file — nothing sent yet',
    deltaConfirmTitle: 'Load these changes into the shop?', deltaConfirmDetail: '{n} changes made in the old system after {cutoff} will be applied at head office in your name: stock moves and sales become real records, each exactly once. A change already applied is left alone. This is recorded and cannot be undone except by a compensating entry.',
    deltaOk: 'Head office answered. Each change\'s outcome is below.', deltaAppliedK: 'applied', deltaDupK: 'already applied', deltaRefusedK: 'refused', deltaNetK: 'net stock', deltaValueK: 'net value',
    noCutoff: 'Say the day the final extract was taken first. Nothing was sent.', noDeltaFile: 'Choose the changes file first. Nothing was sent.', noDeltaRows: 'The file has a heading and no changes. Nothing was sent.',
    deltaColumnsMissing: 'The file is missing a column head office needs ({missing}). Nothing was sent.', deltaRowBad: 'Row {row} cannot be read: "{field}" is missing or not a number / one of insert, update, delete. Nothing was sent — fix the file and read it again.',
    cChangeKey: 'Change', cEntity: 'Kind', cLegacyId: 'Old id', cOperation: 'What', cChangedAt: 'When (old system)', cQty: 'Quantity', cValue: 'Value', cOutcome: 'Outcome', cDetail: 'Head office said',
    o_applied: 'applied', o_already_applied: 'already applied — left alone', o_refused_before_cutoff: 'refused — dated before the extract', o_refused_production: 'refused — this is the real shop', o_refused_unsupported_entity: 'refused — a kind head office does not apply', o_refused_incomplete: 'refused — incomplete',
    op_insert: 'added', op_update: 'changed', op_delete: 'removed',
    lead: 'The office steps of moving from the old system: list what it keeps, approve how its codes map, decide what is left behind, compare two exports, check the switch-over night, undo an opening load inside its window, and check whether the old system may be switched off. Head office checks every step; nothing here deletes old data.',
    nobody: 'Nobody is signed in on this screen — you can read nothing and change nothing.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was changed.',
    notAllowed: 'Your role cannot do this step.', done: 'Done.', recorded: 'Recorded at head office, in your name.',
    // MG-01
    discH: 'What the old shop keeps its records in', discLead: 'Add each place the old shop keeps records — the old program, spreadsheets, paper files. Head office names every gap: nobody owning it, a guessed row count, no keeping period, no way to get the data out. This check keeps nothing — keep the list.',
    srcId: 'Short name (letters and digits)', srcName: 'What it is', srcKind: 'Kind', srcOwner: 'Who answers for it (their sign-in)', srcRows: 'How many rows', srcBasis: 'Row count is', srcRetention: 'Keep for (years)', srcExtract: 'We can get the data out',
    k_erp_database: 'The old shop program', k_pos_database: 'The old till program', k_spreadsheet: 'A spreadsheet', k_paper: 'Paper files', k_third_party_system: 'Another company\'s system', k_report_only: 'Only printed reports',
    b_counted: 'counted', b_estimated: 'a guess', b_unknown: 'not known',
    addSource: 'Add to the list', checkSources: 'Check the list', sourcesNone: 'Nothing on the list yet.',
    discComplete: 'The list is complete', discGaps: 'gap(s) — the list is not complete', countedRowsK: 'rows counted',
    noSourceId: 'Give the source a short name of letters and digits.', noSourceName: 'Say what the source is.', noKind: 'Choose its kind.', noBasis: 'Say whether its row count is counted, a guess or not known.',
    noRows: 'Rows is a whole number.', noRetention: 'Keep-for is a whole number of years.', noSources: 'Add at least one source first.', sameSource: 'That short name is already on the list.',
    // MG-03
    mapH: 'How the old codes map', mapLead: 'Each old code (a tax code, a unit, a department…) and what it means here, with why. Approving it puts your name and today on it, and head office refuses one old code meaning two things. Then check the approved mapping covers every value the old data actually carries.',
    mapId: 'Mapping name', mapVersion: 'Version', mapDomain: 'What kind of code', mapOld: 'Old code', mapNew: 'Means here', mapWhy: 'Why',
    d_tax_code: 'Tax code', d_uom: 'Unit', d_department: 'Department', d_account: 'Account', d_branch: 'Branch', d_identity: 'Person or customer number', d_document_kind: 'Document kind',
    addEntry: 'Add this code', seenH: 'Values seen in the old data', seenValue: 'Value', seenRows: 'Rows carrying it', addSeen: 'Add this value',
    checkCoverage: 'Check the approved mapping covers the old data', approveMapping: 'Approve this mapping', approveFirst: 'Approve the mapping first — head office measures coverage only with an approved mapping.', entriesNone: 'No codes yet.', seenNone: 'No values yet.',
    coverageFull: 'Every value in the old data is covered', coverageGaps: 'rows carry a value nothing covers',
    approvedBy: 'Approved by', approvedAt: 'on', saveTable: 'Save the approved mapping (keep it for the load)',
    noMapId: 'Give the mapping a name.', noVersion: 'Version is a whole number from 1.', noDomain: 'Choose what kind of code.', noOld: 'Type the old code.', noNew: 'Type what it means here.', noWhy: 'Say why — this is what anybody reads a year from now.',
    noEntries: 'Add at least one code first.', noSeen: 'Add the values seen in the old data first.', noSeenValue: 'Type the value.', noSeenRows: 'Rows is a whole number.', notReady: 'Head office is not ready — read who is signed in first.',
    // MG-07
    exclH: 'Old records left behind', exclLead: 'Leaving old records behind needs a written, valued reason — age alone is never one — and the owner\'s written decision. Until the owner decides, it explains nothing in the figures.',
    showExclusions: 'Show the list', exclNone: 'Nothing has been proposed to leave behind.',
    exclId: 'Short name', exclScope: 'What is left behind', exclDesc: 'Describe it', exclCount: 'How many records', exclValue: 'Value (₹)', exclReason: 'Why it cannot be used',
    s_documents_before: 'Documents before a date', s_entity_kind: 'A whole kind of record', s_named_records: 'Named records', s_inactive_records: 'Records not used any more',
    proposeExclusion: 'Propose leaving it behind', decideExclusion: 'Record my decision', approveK: 'Approve', rejectK: 'Reject', statementK: 'Your decision, in writing',
    st_proposed: 'waiting for the owner', st_approved: 'approved by the owner', st_rejected: 'rejected by the owner', proposedByK: 'proposed by', decidedByK: 'decided by',
    noExclId: 'Give it a short name.', noScope: 'Choose what is left behind.', noDesc: 'Describe it.', noCount: 'How many records — a whole number.', noValue: 'Value in rupees, for example 1250.50.', noReason: 'Say why it cannot be used.',
    noChoice: 'Choose approve or reject.', noStatement: 'Write your decision.',
    // MG-09
    diffH: 'Compare two exports from the old system', diffLead: 'The export that was loaded, and a newer one. Every difference becomes a problem to decide on the migration list — nothing is applied.',
    showDiffs: 'Show the comparisons', diffId: 'Name this comparison', diffDomain: 'What was exported', diffColumn: 'their column for', baselineFile: 'The export that was loaded (CSV)', latestFile: 'The newer export (CSV)',
    runDiff: 'Compare them', diffsNone: 'No comparison yet.', addedK: 'new', changedK: 'changed', removedK: 'gone', unchangedK: 'same', undecidedK: 'still to decide',
    noDiffId: 'Name the comparison (letters, digits, dot, dash).', noDiffDomain: 'Choose what was exported.', noFiles: 'Choose both export files.', noColumns: 'Name their column for every required field.', domainsFirst: 'Show the comparisons first — head office tells the page what each export holds.',
    // night, window, reversal (MG-11 / MG-08)
    nightH: 'The switch-over night', nightLead: 'The window to undo an opening load opens at the owner\'s switch-over GO and closes 48 hours later. The night check compares what head office sees with the limits the owner agreed.',
    cutoverId: 'Switch-over name', showWindow: 'Show the window', nightCheck: 'Check the night now',
    noGo: 'No switch-over GO is on record — the window has not opened.', windowOpen: 'Window OPEN', windowClosed: 'Window closed', opensK: 'opens', closesK: 'closes', goByK: 'GO given by', notTheCutover: 'This is not the shop\'s switch-over — that one is',
    rollBackNow: 'ROLL BACK NOW — an agreed limit is crossed', limitsHold: 'No agreed limit is crossed', notJudged: 'Could not be judged',
    loadId: 'Opening load', reverseReason: 'Why it must be undone', askReverse: 'Ask to undo this opening load', approveReverse: 'Approve undoing it (a second person)', showReverse: 'Show what it undid',
    reversedZero: 'Every domain is back to zero', notYetReversed: 'Not undone yet', requestedByK: 'asked by', approvedByK: 'approved by', openedK: 'opened', reversedK: 'taken back', netK: 'left',
    noCutover: 'Name the switch-over.', noLoad: 'Name the opening load.', noReverseReason: 'Say why it must be undone.',
    // MG-12
    retireH: 'Switching the old system off', retireLead: 'Switching the old system off never deletes the old data. Head office checks the keeping period from the latest record, that a restore from the archive was shown to work, that the switch-over was accepted, and that nobody still needs the records.',
    archiveId: 'Archive name', archiveSource: 'Which source', archiveDigest: 'Archive fingerprint', archiveRows: 'Rows in it', archivedOn: 'Archived on', retentionYears: 'Keep for (years)',
    earliest: 'Oldest record', latest: 'Newest record', restoreOn: 'Restore shown to work on (leave empty if never)', cutoverAccepted: 'The switch-over was accepted', openAssessments: 'Open questions that could still need the records',
    assess: 'Check whether it may be switched off', mayRetire: 'The old system MAY be switched off', mayNot: 'Not yet', keepUntil: 'keep the records until', neverDeleted: 'The old data is never deleted, whatever else happens.',
    r_retention_not_elapsed: 'the keeping period has not ended', r_restore_never_verified: 'nobody has shown a restore from the archive works', r_cutover_not_accepted: 'the switch-over is not accepted', r_open_assessment: 'open questions could still need the records',
    noArchive: 'Fill in every archive field (fingerprint, rows, dates).', noOpen: 'Open questions is a whole number (0 if none).',
    // W4 · MG-02 · MG-04 · MG-05 · MG-06 · WF-19
    sealH: 'Check the export against its seal before loading', sealLead: 'The seal was taken when the export came out of the old system. Head office checks the file you are about to load is that same file — its fingerprint AND its number of rows. A file that does not match must not be loaded.',
    sealFile: 'The seal kept when the export was taken (JSON)', extractFile: 'The export about to be loaded (CSV)', verifyBtn: 'Check it against its seal',
    verifiedOk: 'The same export that was sealed', verifiedNo: 'NOT the export that was sealed — do not load it', rowsK: 'data rows',
    noSealFile: 'Choose the seal file kept when the export was taken.', notASeal: 'That file is not a seal — it needs the fingerprint and row count taken when the export came out.', noExtractFile: 'Choose the export file about to be loaded.',
    excH: 'Problems in the old data', excLead: 'Everything wrong with the old data, the ones that stop the switch-over first. Nothing here is ever deleted — a decided one stays on the list as the record that somebody looked at it, in their name.',
    showProblems: 'Show the problems', problemsNone: 'No problem has been recorded from the old data.', blockingK: 'STOPS THE SWITCH-OVER', undecidedK2: 'nobody has decided', decidedByK2: 'decided by',
    excWhich: 'Which problem', excAction: 'What to do', a_correct: 'Correct it', a_exclude: 'Leave it out', a_migrate_as_is: 'Bring it across as it is', a_merge: 'Merge it into another record',
    excSurvivor: 'The record that stays (for a merge)', excReason: 'Why', decideProblem: 'Record my decision',
    noProblem: 'Choose a problem.', noAction: 'Choose what to do.', noProblemReason: 'Say why — a decision about the old data carries your name and your reason.', noSurvivor: 'Name the record that stays.',
    clearK: 'Nothing blocking is left', blockingLeftK: 'blocking problem(s) nobody has decided',
    trialH: 'Trial load', trialLead: 'A rehearsal load into the practice shop at full volume, timed — the switch-over night is a real evening, so how long it takes is an answer, not a footnote. Head office refuses one that rehearses nothing: an export not checked against its seal, a blocking problem nobody decided, or a practice shop not emptied first.',
    trialId: 'Name this trial', trialRows: 'Rows loaded', trialMinutes: 'Minutes it took', trialFull: 'Rows the real switch-over will carry (leave empty if the same)', trialEmpty: 'The practice shop was emptied before this load',
    runTrial: 'Record the trial load', trialOk: 'Trial load recorded', loadedK: 'rows loaded', tookK: 'took', projectsK: 'the full volume would take', repeatableK: 'can be repeated', minK: 'min',
    verifyFirst: 'Check the export against its seal first — a trial of an unchecked export rehearses nothing.', noTrialId: 'Name the trial (letters, digits, dot, dash).', noTrialRows: 'Rows loaded is a whole number.', noMinutes: 'Minutes is a number, for example 12.5.', noFull: 'Rows for the real switch-over is a whole number.',
    totH: 'The figures (control totals)', totLead: 'Every figure twice — what the old system says and what came across — with how each side was worked out. Somebody who did not run the load signs each one; a finance or tax figure only the chartered accountant signs.',
    showTotals: 'Show the figures', totalsNone: 'No figure has been recorded yet — nothing has been checked, which is not the same as everything agreeing.',
    oldSaysK: 'old system', cameK: 'came across', signedByK: 'signed by', notSignedK: 'NOT SIGNED', totWhich: 'Which figure', totStatement: 'What you checked', signTotal: 'Sign this figure',
    qg07Ok: 'Every figure agrees and is signed (QG-07)', qg07No: 'Not every figure agrees and is signed yet (QG-07)', noTotal: 'Choose a figure.', noTotStatement: 'Say what you checked, in your own words.',
    ts_reconciled: 'agrees exactly', ts_explained: 'explained by what was agreed to leave behind', ts_open: 'does not agree',
    gateH: 'Can we switch over — the checks', gateLead: 'Head office works out every check from its own records — none is a box somebody ticks. What only the store computer knows (its unsent sales, the team on the night) reads "not known" here; the owner says GO at the store computer\'s migration screen.',
    gateCutover: 'Switch-over name', readGate: 'Read the checks', showRollback: 'Show the rehearsed going-back', goK: 'YES — every check has passed', notYetK: 'NOT YET',
    c_passed: 'passed', c_failed: 'not yet', c_not_known: 'not known',
    rbDemonstrated: 'Going back to the old system was rehearsed — performed and reconciled', rbNot: 'Going back to the old system is NOT shown to work yet',
    ck_control_totals_signed: 'Every figure agrees and is signed', ck_rollback_demonstrated: 'Going back to the old system was rehearsed', ck_parallel_run_sufficient: 'Enough clean days running both',
    ck_edge_fully_synced: 'The store computer has sent everything', ck_blocking_exceptions_cleared: 'No blocking problem left', ck_delta_applied: 'The last changes were loaded',
    ck_team_named: 'The team for the night is named', ck_owner_go: 'The owner said GO', ck_backup_verified: 'A good backup, recent enough', ck_rollback_limits_agreed: 'The going-back limits are agreed',
  },
  ta: {
    lang: 'English', title: 'பழைய முறை சோதனைகள்',
    stepsH: 'பன்னிரண்டு கட்டுப்பாடுகள், வரிசையில்', stepsLead: 'வரைபடம் பெயரிடும் ஒவ்வொரு இடமாற்றக் கட்டுப்பாடும் (MG-01 முதல் MG-12 வரை) இந்தப் பக்கத்தில் ஒரு படி. மூலப் பகுப்பாய்வு, சோதனை ஏற்றம், மாற்றங்கள் — தனித்தனிப் படிகள்; ஒன்றைத் தட்டி அங்கே செல்லலாம்.',
    step_discovery: 'மூலப் பகுப்பாய்வு — பழைய பதிவுகள் எங்கே, எத்தனை, யார் பொறுப்பு', step_seal: 'முத்திரையோடு சரிபார்த்த ஏற்றுமதி', step_mapping: 'குறியீட்டு வரைபடமும் அதன் பரப்பும்', step_cleaning: 'பழைய தகவலின் சிக்கல்கள், முடிவு செய்யப்பட்டவை',
    step_trial: 'சோதனை ஏற்றம் — முழு அளவு, நேரம் அளக்கப்பட்டது, மீண்டும் செய்யக்கூடியது', step_totals: 'எண்ணிக்கைகள், சரிகட்டி கையொப்பமிட்டவை', step_history: 'விட்டுவிடப்பட்டவை, ஏன்', step_opening: 'தொடக்க ஏற்றமும் அதைத் திரும்பப் பெறுதலும்',
    step_delta_capture: 'மாற்றங்கள் — இறுதி ஏற்றுமதிக்குப் பின் நடந்தவை, இரு ஏற்றுமதிகளை ஒப்பிட்டுக் கண்டவை', step_delta_load: 'மாற்றங்கள் — ஒரே ஒரு முறை ஏற்றப்பட்டவை', step_parallel: 'இரு முறைகளும் இயக்குதல்: ஒரு நாளின் கணக்குப் பக்கம்', step_cutover: 'மாற்ற இரவும் அதன் வாயிலும்', step_retire: 'பழைய முறையை நிறுத்துதல்',
    deltaH: 'இறுதி ஏற்றுமதிக்குப் பின் நடந்த மாற்றங்களை ஏற்று', deltaLead: 'இறுதி ஏற்றுமதிக்கும் மாற்ற இரவுக்கும் இடையில் பழைய கடை வியாபாரம் தொடரும். மாற்றங்கள் கோப்பு ஒவ்வொரு மாற்றத்தையும் அதன் சொந்தச் சாவியோடு கொண்டிருக்கும் (நிரல்கள் தலைமை அலுவலகத்தின் சொந்தப் புலப் பெயர்கள்: changeKey, entity, legacyId, operation, changedAt; சரக்குக்கு deltaQty, locationId, uom, unitCostMinor; விற்பனைக்கு deltaMinor, netMinor, cgstMinor, sgstMinor, tender). ஒவ்வொன்றையும் தலைமை அலுவலகம் ஒரே ஒரு முறை பயன்படுத்தும்: மீண்டும் அனுப்பிய மாற்றம் "ஏற்கனவே பயன்படுத்தப்பட்டது" (வெற்றி), ஏற்றுமதி நேரத்துக்கு முந்தைய மாற்றம் ஏற்கனவே ஏற்றுமதியில் உள்ளதாக மறுக்கப்படும், இந்தப் பதிப்பு பயன்படுத்த முடியாத வகை பெயரோடு மறுக்கப்படும் — ஒருபோதும் எண்ணப்படாது.',
    deltaCutoff: 'இறுதி ஏற்றுமதி எடுத்த நாள்', deltaCutoffTime: 'நேரம் (கடை நேரம், HH:MM)', deltaFile: 'மாற்றங்கள் கோப்பு (CSV)', readDelta: 'கோப்பைப் படி', loadDelta: 'மாற்றங்களை ஏற்று', deltaRead: 'மாற்றங்கள் கோப்பிலிருந்து படிக்கப்பட்டன — இன்னும் எதுவும் அனுப்பப்படவில்லை',
    deltaConfirmTitle: 'இந்த மாற்றங்களைக் கடைக்குள் ஏற்றவா?', deltaConfirmDetail: '{cutoff}-க்குப் பின் பழைய முறையில் நடந்த {n} மாற்றங்கள் உங்கள் பெயரில் தலைமை அலுவலகத்தில் பயன்படுத்தப்படும்: சரக்கு நகர்வுகளும் விற்பனைகளும் உண்மைப் பதிவுகளாகும், ஒவ்வொன்றும் ஒரே ஒரு முறை. ஏற்கனவே பயன்படுத்திய மாற்றம் விடப்படும். இது பதிவு செய்யப்படும்; ஈடுசெய்யும் பதிவால் மட்டுமே திரும்பப் பெற முடியும்.',
    deltaOk: 'தலைமை அலுவலகம் பதிலளித்தது. ஒவ்வொரு மாற்றத்தின் முடிவும் கீழே.', deltaAppliedK: 'பயன்படுத்தப்பட்டது', deltaDupK: 'ஏற்கனவே பயன்படுத்தப்பட்டது', deltaRefusedK: 'மறுக்கப்பட்டது', deltaNetK: 'நிகர சரக்கு', deltaValueK: 'நிகர மதிப்பு',
    noCutoff: 'முதலில் இறுதி ஏற்றுமதி எடுத்த நாளைச் சொல்லுங்கள். எதுவும் அனுப்பப்படவில்லை.', noDeltaFile: 'முதலில் மாற்றங்கள் கோப்பைத் தேர்ந்தெடுக்கவும். எதுவும் அனுப்பப்படவில்லை.', noDeltaRows: 'கோப்பில் தலைப்பு மட்டும் உள்ளது, மாற்றங்கள் இல்லை. எதுவும் அனுப்பப்படவில்லை.',
    deltaColumnsMissing: 'தலைமை அலுவலகத்துக்குத் தேவையான நிரல் கோப்பில் இல்லை ({missing}). எதுவும் அனுப்பப்படவில்லை.', deltaRowBad: 'வரிசை {row} படிக்க முடியவில்லை: "{field}" இல்லை அல்லது எண் அல்ல / insert, update, delete இல் ஒன்று அல்ல. எதுவும் அனுப்பப்படவில்லை — கோப்பைத் திருத்தி மீண்டும் படிக்கவும்.',
    cChangeKey: 'மாற்றம்', cEntity: 'வகை', cLegacyId: 'பழைய அடையாளம்', cOperation: 'என்ன', cChangedAt: 'எப்போது (பழைய முறை)', cQty: 'அளவு', cValue: 'மதிப்பு', cOutcome: 'முடிவு', cDetail: 'தலைமை அலுவலகம் சொன்னது',
    o_applied: 'பயன்படுத்தப்பட்டது', o_already_applied: 'ஏற்கனவே பயன்படுத்தப்பட்டது — விடப்பட்டது', o_refused_before_cutoff: 'மறுக்கப்பட்டது — ஏற்றுமதிக்கு முந்தையது', o_refused_production: 'மறுக்கப்பட்டது — இது உண்மைக் கடை', o_refused_unsupported_entity: 'மறுக்கப்பட்டது — தலைமை அலுவலகம் பயன்படுத்தாத வகை', o_refused_incomplete: 'மறுக்கப்பட்டது — முழுமையற்றது',
    op_insert: 'சேர்க்கப்பட்டது', op_update: 'மாற்றப்பட்டது', op_delete: 'நீக்கப்பட்டது',
    lead: 'பழைய முறையிலிருந்து மாறுவதன் அலுவலகப் படிகள்: அது வைத்திருப்பவற்றைப் பட்டியலிடு, அதன் குறியீடுகள் எப்படிப் பொருந்துகின்றன என்பதை ஒப்புக்கொள், விட்டுச் செல்வதை முடிவு செய், இரண்டு ஏற்றுமதிகளை ஒப்பிடு, மாறும் இரவைச் சோதி, தொடக்க ஏற்றத்தை அதன் கால அளவுக்குள் திரும்பப் பெறு, பழைய முறையை அணைக்கலாமா என்று சோதி. ஒவ்வொரு படியையும் தலைமை அலுவலகம் சோதிக்கிறது; இங்கே எதுவும் பழைய தரவை அழிப்பதில்லை.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை — எதையும் படிக்கவோ மாற்றவோ முடியாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் மாற்றப்படவில்லை.',
    notAllowed: 'உங்கள் பங்கு இந்தப் படியைச் செய்ய முடியாது.', done: 'முடிந்தது.', recorded: 'உங்கள் பெயரில் தலைமை அலுவலகத்தில் பதிவு செய்யப்பட்டது.',
    discH: 'பழைய கடை பதிவுகளை வைத்திருக்கும் இடங்கள்', discLead: 'பழைய கடை பதிவுகளை வைத்திருக்கும் ஒவ்வொரு இடத்தையும் சேர்க்கவும் — பழைய நிரல், விரிதாள்கள், காகிதக் கோப்புகள். ஒவ்வொரு இடைவெளியையும் தலைமை அலுவலகம் பெயரிடுகிறது: பொறுப்பாளர் இல்லை, ஊகித்த வரிசை எண்ணிக்கை, வைத்திருக்கும் காலம் இல்லை, தரவை வெளியே எடுக்க வழி இல்லை. இந்தச் சோதனை எதையும் சேமிப்பதில்லை — பட்டியலை வைத்திருங்கள்.',
    srcId: 'சுருக்கப் பெயர் (எழுத்துகள், எண்கள்)', srcName: 'அது என்ன', srcKind: 'வகை', srcOwner: 'பொறுப்பாளர் (அவரது உள்நுழைவு)', srcRows: 'எத்தனை வரிசைகள்', srcBasis: 'வரிசை எண்ணிக்கை', srcRetention: 'வைத்திருக்கும் காலம் (ஆண்டுகள்)', srcExtract: 'தரவை வெளியே எடுக்க முடியும்',
    k_erp_database: 'பழைய கடை நிரல்', k_pos_database: 'பழைய கவுண்டர் நிரல்', k_spreadsheet: 'விரிதாள்', k_paper: 'காகிதக் கோப்புகள்', k_third_party_system: 'வேறு நிறுவனத்தின் முறை', k_report_only: 'அச்சிட்ட அறிக்கைகள் மட்டும்',
    b_counted: 'எண்ணியது', b_estimated: 'ஊகம்', b_unknown: 'தெரியாது',
    addSource: 'பட்டியலில் சேர்', checkSources: 'பட்டியலைச் சோதி', sourcesNone: 'பட்டியலில் இன்னும் எதுவும் இல்லை.',
    discComplete: 'பட்டியல் முழுமையானது', discGaps: 'இடைவெளி(கள்) — பட்டியல் முழுமையாக இல்லை', countedRowsK: 'எண்ணிய வரிசைகள்',
    noSourceId: 'இடத்திற்கு எழுத்து, எண்களால் ஆன சுருக்கப் பெயர் கொடுக்கவும்.', noSourceName: 'அது என்ன என்று சொல்லவும்.', noKind: 'அதன் வகையைத் தேர்ந்தெடுக்கவும்.', noBasis: 'வரிசை எண்ணிக்கை எண்ணியதா, ஊகமா, தெரியாததா என்று சொல்லவும்.',
    noRows: 'வரிசைகள் முழு எண்.', noRetention: 'வைத்திருக்கும் காலம் முழு ஆண்டுகள்.', noSources: 'முதலில் குறைந்தது ஒரு இடத்தைச் சேர்க்கவும்.', sameSource: 'அந்தச் சுருக்கப் பெயர் ஏற்கனவே பட்டியலில் உள்ளது.',
    mapH: 'பழைய குறியீடுகள் எப்படிப் பொருந்துகின்றன', mapLead: 'ஒவ்வொரு பழைய குறியீடும் (வரிக் குறியீடு, அலகு, துறை…) இங்கே என்ன பொருள், ஏன் என்பதுடன். பழைய தரவில் உண்மையில் உள்ள ஒவ்வொரு மதிப்பையும் பொருத்தம் உள்ளடக்குகிறதா என்று தலைமை அலுவலகம் சோதிக்கிறது; ஒரு பழைய குறியீடு இரண்டு பொருள் தருவதை மறுக்கிறது. ஒப்புதல் உங்கள் பெயரையும் இன்றைய நாளையும் அதில் இடுகிறது.',
    mapId: 'பொருத்தத்தின் பெயர்', mapVersion: 'பதிப்பு', mapDomain: 'எந்த வகைக் குறியீடு', mapOld: 'பழைய குறியீடு', mapNew: 'இங்கே பொருள்', mapWhy: 'ஏன்',
    d_tax_code: 'வரிக் குறியீடு', d_uom: 'அலகு', d_department: 'துறை', d_account: 'கணக்கு', d_branch: 'கிளை', d_identity: 'நபர் அல்லது வாடிக்கையாளர் எண்', d_document_kind: 'ஆவண வகை',
    addEntry: 'இந்தக் குறியீட்டைச் சேர்', seenH: 'பழைய தரவில் காணப்பட்ட மதிப்புகள்', seenValue: 'மதிப்பு', seenRows: 'அதைக் கொண்ட வரிசைகள்', addSeen: 'இந்த மதிப்பைச் சேர்',
    checkCoverage: 'ஒப்புக்கொண்ட பொருத்தம் பழைய தரவை உள்ளடக்குகிறதா என்று சோதி', approveMapping: 'இந்தப் பொருத்தத்தை ஒப்புக்கொள்', approveFirst: 'முதலில் பொருத்தத்தை ஒப்புக்கொள்ளவும் — ஒப்புக்கொண்ட பொருத்தத்துடன் மட்டுமே தலைமை அலுவலகம் உள்ளடக்கத்தை அளவிடுகிறது.', entriesNone: 'இன்னும் குறியீடுகள் இல்லை.', seenNone: 'இன்னும் மதிப்புகள் இல்லை.',
    coverageFull: 'பழைய தரவின் ஒவ்வொரு மதிப்பும் உள்ளடக்கப்பட்டது', coverageGaps: 'வரிசைகளில் எதுவும் உள்ளடக்காத மதிப்பு உள்ளது',
    approvedBy: 'ஒப்புக்கொண்டவர்', approvedAt: 'நாள்', saveTable: 'ஒப்புக்கொண்ட பொருத்தத்தைச் சேமி (ஏற்றத்திற்கு வைத்திருங்கள்)',
    noMapId: 'பொருத்தத்திற்குப் பெயர் கொடுக்கவும்.', noVersion: 'பதிப்பு 1 முதல் முழு எண்.', noDomain: 'எந்த வகைக் குறியீடு என்று தேர்ந்தெடுக்கவும்.', noOld: 'பழைய குறியீட்டைத் தட்டச்சு செய்யவும்.', noNew: 'இங்கே அதன் பொருளைத் தட்டச்சு செய்யவும்.', noWhy: 'ஏன் என்று சொல்லவும் — ஓராண்டு கழித்து யாரும் படிப்பது இதுவே.',
    noEntries: 'முதலில் குறைந்தது ஒரு குறியீட்டைச் சேர்க்கவும்.', noSeen: 'முதலில் பழைய தரவில் காணப்பட்ட மதிப்புகளைச் சேர்க்கவும்.', noSeenValue: 'மதிப்பைத் தட்டச்சு செய்யவும்.', noSeenRows: 'வரிசைகள் முழு எண்.', notReady: 'தலைமை அலுவலகம் தயாராக இல்லை — முதலில் யார் உள்நுழைந்துள்ளார் என்று படிக்கவும்.',
    exclH: 'விட்டுச் செல்லும் பழைய பதிவுகள்', exclLead: 'பழைய பதிவுகளை விட்டுச் செல்ல எழுத்தில், மதிப்புடன் காரணம் தேவை — வயது மட்டும் ஒருபோதும் காரணம் அல்ல — உரிமையாளரின் எழுத்து முடிவும் தேவை. உரிமையாளர் முடிவு செய்யும் வரை அது எண்களில் எதையும் விளக்காது.',
    showExclusions: 'பட்டியலைக் காட்டு', exclNone: 'விட்டுச் செல்ல எதுவும் முன்மொழியப்படவில்லை.',
    exclId: 'சுருக்கப் பெயர்', exclScope: 'எது விட்டுச் செல்லப்படுகிறது', exclDesc: 'அதை விவரிக்கவும்', exclCount: 'எத்தனை பதிவுகள்', exclValue: 'மதிப்பு (₹)', exclReason: 'ஏன் பயன்படுத்த முடியாது',
    s_documents_before: 'ஒரு நாளுக்கு முந்தைய ஆவணங்கள்', s_entity_kind: 'ஒரு முழு வகைப் பதிவு', s_named_records: 'பெயரிட்ட பதிவுகள்', s_inactive_records: 'இனி பயன்படாத பதிவுகள்',
    proposeExclusion: 'விட்டுச் செல்ல முன்மொழி', decideExclusion: 'என் முடிவைப் பதிவு செய்', approveK: 'ஒப்புக்கொள்', rejectK: 'மறு', statementK: 'உங்கள் முடிவு, எழுத்தில்',
    st_proposed: 'உரிமையாளருக்காகக் காத்திருக்கிறது', st_approved: 'உரிமையாளர் ஒப்புக்கொண்டார்', st_rejected: 'உரிமையாளர் மறுத்தார்', proposedByK: 'முன்மொழிந்தவர்', decidedByK: 'முடிவு செய்தவர்',
    noExclId: 'சுருக்கப் பெயர் கொடுக்கவும்.', noScope: 'எது விட்டுச் செல்லப்படுகிறது என்று தேர்ந்தெடுக்கவும்.', noDesc: 'அதை விவரிக்கவும்.', noCount: 'எத்தனை பதிவுகள் — முழு எண்.', noValue: 'மதிப்பு ரூபாயில், எ.கா. 1250.50.', noReason: 'ஏன் பயன்படுத்த முடியாது என்று சொல்லவும்.',
    noChoice: 'ஒப்புக்கொள் அல்லது மறு என்று தேர்ந்தெடுக்கவும்.', noStatement: 'உங்கள் முடிவை எழுதவும்.',
    diffH: 'பழைய முறையின் இரண்டு ஏற்றுமதிகளை ஒப்பிடு', diffLead: 'ஏற்றப்பட்ட ஏற்றுமதியும் புதியதும். ஒவ்வொரு வேறுபாடும் தரவு மாற்றப் பட்டியலில் முடிவு செய்ய வேண்டிய சிக்கலாகிறது — எதுவும் பயன்படுத்தப்படுவதில்லை.',
    showDiffs: 'ஒப்பீடுகளைக் காட்டு', diffId: 'இந்த ஒப்பீட்டுக்குப் பெயர்', diffDomain: 'என்ன ஏற்றுமதி செய்யப்பட்டது', diffColumn: 'இதற்கான அவர்களின் நெடுவரிசை', baselineFile: 'ஏற்றப்பட்ட ஏற்றுமதி (CSV)', latestFile: 'புதிய ஏற்றுமதி (CSV)',
    runDiff: 'ஒப்பிடு', diffsNone: 'இன்னும் ஒப்பீடு இல்லை.', addedK: 'புதியவை', changedK: 'மாறியவை', removedK: 'போனவை', unchangedK: 'அதேவை', undecidedK: 'இன்னும் முடிவு செய்ய வேண்டியவை',
    noDiffId: 'ஒப்பீட்டுக்குப் பெயரிடவும் (எழுத்துகள், எண்கள், புள்ளி, கோடு).', noDiffDomain: 'என்ன ஏற்றுமதி செய்யப்பட்டது என்று தேர்ந்தெடுக்கவும்.', noFiles: 'இரண்டு ஏற்றுமதிக் கோப்புகளையும் தேர்ந்தெடுக்கவும்.', noColumns: 'தேவையான ஒவ்வொரு புலத்திற்கும் அவர்களின் நெடுவரிசையைப் பெயரிடவும்.', domainsFirst: 'முதலில் ஒப்பீடுகளைக் காட்டவும் — ஒவ்வொரு ஏற்றுமதியிலும் என்ன உள்ளது என்று தலைமை அலுவலகம் சொல்கிறது.',
    nightH: 'மாறும் இரவு', nightLead: 'தொடக்க ஏற்றத்தைத் திரும்பப் பெறும் கால அளவு உரிமையாளரின் மாற்ற GO-வில் திறந்து 48 மணி நேரத்தில் மூடுகிறது. இரவுச் சோதனை தலைமை அலுவலகம் காண்பதை உரிமையாளர் ஒப்புக்கொண்ட வரம்புகளுடன் ஒப்பிடுகிறது.',
    cutoverId: 'மாற்றத்தின் பெயர்', showWindow: 'கால அளவைக் காட்டு', nightCheck: 'இரவை இப்போது சோதி',
    noGo: 'மாற்ற GO எதுவும் பதிவில் இல்லை — கால அளவு திறக்கவில்லை.', windowOpen: 'கால அளவு திறந்துள்ளது', windowClosed: 'கால அளவு மூடியது', opensK: 'திறப்பு', closesK: 'மூடல்', goByK: 'GO கொடுத்தவர்', notTheCutover: 'இது கடையின் மாற்றம் அல்ல — அது',
    rollBackNow: 'இப்போதே பின்வாங்கு — ஒப்புக்கொண்ட வரம்பு மீறப்பட்டது', limitsHold: 'ஒப்புக்கொண்ட எந்த வரம்பும் மீறப்படவில்லை', notJudged: 'மதிப்பிட முடியவில்லை',
    loadId: 'தொடக்க ஏற்றம்', reverseReason: 'ஏன் திரும்பப் பெற வேண்டும்', askReverse: 'இந்தத் தொடக்க ஏற்றத்தைத் திரும்பப் பெறக் கேள்', approveReverse: 'திரும்பப் பெறுவதை ஒப்புக்கொள் (இரண்டாம் நபர்)', showReverse: 'திரும்பப் பெற்றதைக் காட்டு',
    reversedZero: 'ஒவ்வொரு பகுதியும் பூஜ்யத்திற்குத் திரும்பியது', notYetReversed: 'இன்னும் திரும்பப் பெறவில்லை', requestedByK: 'கேட்டவர்', approvedByK: 'ஒப்புக்கொண்டவர்', openedK: 'திறந்தது', reversedK: 'திரும்பப் பெற்றது', netK: 'மீதி',
    noCutover: 'மாற்றத்தின் பெயரைக் கொடுக்கவும்.', noLoad: 'தொடக்க ஏற்றத்தின் பெயரைக் கொடுக்கவும்.', noReverseReason: 'ஏன் திரும்பப் பெற வேண்டும் என்று சொல்லவும்.',
    retireH: 'பழைய முறையை அணைத்தல்', retireLead: 'பழைய முறையை அணைப்பது பழைய தரவை ஒருபோதும் அழிப்பதில்லை. சமீபத்திய பதிவிலிருந்து வைத்திருக்கும் காலம், காப்பகத்திலிருந்து மீட்பு வேலை செய்வது காட்டப்பட்டதா, மாற்றம் ஏற்கப்பட்டதா, யாருக்கும் இன்னும் பதிவுகள் தேவையா என்று தலைமை அலுவலகம் சோதிக்கிறது.',
    archiveId: 'காப்பகப் பெயர்', archiveSource: 'எந்த இடம்', archiveDigest: 'காப்பகக் கைரேகை', archiveRows: 'அதில் வரிசைகள்', archivedOn: 'காப்பகப்படுத்திய நாள்', retentionYears: 'வைத்திருக்கும் காலம் (ஆண்டுகள்)',
    earliest: 'பழமையான பதிவு', latest: 'சமீபத்திய பதிவு', restoreOn: 'மீட்பு வேலை செய்வது காட்டப்பட்ட நாள் (இல்லையெனில் காலியாக விடவும்)', cutoverAccepted: 'மாற்றம் ஏற்கப்பட்டது', openAssessments: 'இன்னும் பதிவுகள் தேவைப்படக்கூடிய திறந்த கேள்விகள்',
    assess: 'அணைக்கலாமா என்று சோதி', mayRetire: 'பழைய முறையை அணைக்கலாம்', mayNot: 'இன்னும் இல்லை', keepUntil: 'பதிவுகளை வைத்திருக்க வேண்டிய நாள் வரை', neverDeleted: 'எது நடந்தாலும் பழைய தரவு ஒருபோதும் அழிக்கப்படுவதில்லை.',
    r_retention_not_elapsed: 'வைத்திருக்கும் காலம் முடியவில்லை', r_restore_never_verified: 'காப்பகத்திலிருந்து மீட்பு வேலை செய்வதை யாரும் காட்டவில்லை', r_cutover_not_accepted: 'மாற்றம் ஏற்கப்படவில்லை', r_open_assessment: 'திறந்த கேள்விகளுக்கு இன்னும் பதிவுகள் தேவைப்படலாம்',
    noArchive: 'காப்பகத்தின் ஒவ்வொரு புலத்தையும் நிரப்பவும் (கைரேகை, வரிசைகள், நாட்கள்).', noOpen: 'திறந்த கேள்விகள் முழு எண் (இல்லையெனில் 0).',
    sealH: 'ஏற்றும் முன் ஏற்றுமதியை அதன் முத்திரையுடன் சோதி', sealLead: 'ஏற்றுமதி பழைய முறையிலிருந்து வெளியே வந்தபோது முத்திரை எடுக்கப்பட்டது. நீங்கள் ஏற்றப்போகும் கோப்பு அதே கோப்புதானா என்று தலைமை அலுவலகம் சோதிக்கிறது — அதன் கைரேகையும் வரிசை எண்ணிக்கையும். பொருந்தாத கோப்பை ஏற்றக்கூடாது.',
    sealFile: 'ஏற்றுமதி எடுத்தபோது வைத்த முத்திரை (JSON)', extractFile: 'ஏற்றப்போகும் ஏற்றுமதி (CSV)', verifyBtn: 'முத்திரையுடன் சோதி',
    verifiedOk: 'முத்திரையிடப்பட்ட அதே ஏற்றுமதி', verifiedNo: 'முத்திரையிடப்பட்ட ஏற்றுமதி அல்ல — இதை ஏற்ற வேண்டாம்', rowsK: 'தரவு வரிசைகள்',
    noSealFile: 'ஏற்றுமதி எடுத்தபோது வைத்த முத்திரைக் கோப்பைத் தேர்ந்தெடுக்கவும்.', notASeal: 'அந்தக் கோப்பு முத்திரை அல்ல — ஏற்றுமதி வந்தபோது எடுத்த கைரேகையும் வரிசை எண்ணிக்கையும் தேவை.', noExtractFile: 'ஏற்றப்போகும் ஏற்றுமதிக் கோப்பைத் தேர்ந்தெடுக்கவும்.',
    excH: 'பழைய தரவில் உள்ள சிக்கல்கள்', excLead: 'பழைய தரவில் தவறான அனைத்தும், மாற்றத்தை நிறுத்துபவை முதலில். இங்கே எதுவும் அழிக்கப்படுவதில்லை — முடிவு செய்யப்பட்டது யாரோ பார்த்தார் என்ற பதிவாக, அவரது பெயரில், பட்டியலில் இருக்கும்.',
    showProblems: 'சிக்கல்களைக் காட்டு', problemsNone: 'பழைய தரவிலிருந்து எந்தச் சிக்கலும் பதிவு செய்யப்படவில்லை.', blockingK: 'மாற்றத்தை நிறுத்துகிறது', undecidedK2: 'யாரும் முடிவு செய்யவில்லை', decidedByK2: 'முடிவு செய்தவர்',
    excWhich: 'எந்தச் சிக்கல்', excAction: 'என்ன செய்வது', a_correct: 'திருத்து', a_exclude: 'விட்டுவிடு', a_migrate_as_is: 'அப்படியே கொண்டு வா', a_merge: 'வேறொரு பதிவுடன் இணை',
    excSurvivor: 'நிலைக்கும் பதிவு (இணைப்புக்கு)', excReason: 'ஏன்', decideProblem: 'என் முடிவைப் பதிவு செய்',
    noProblem: 'ஒரு சிக்கலைத் தேர்ந்தெடுக்கவும்.', noAction: 'என்ன செய்வது என்று தேர்ந்தெடுக்கவும்.', noProblemReason: 'ஏன் என்று சொல்லவும் — பழைய தரவு பற்றிய முடிவு உங்கள் பெயரையும் காரணத்தையும் சுமக்கிறது.', noSurvivor: 'நிலைக்கும் பதிவைப் பெயரிடவும்.',
    clearK: 'நிறுத்தும் எதுவும் மீதமில்லை', blockingLeftK: 'யாரும் முடிவு செய்யாத நிறுத்தும் சிக்கல்(கள்)',
    trialH: 'சோதனை ஏற்றம்', trialLead: 'பயிற்சிக் கடைக்குள் முழு அளவில் ஒத்திகை ஏற்றம், நேரம் அளந்து — மாறும் இரவு ஒரு உண்மையான மாலை, எனவே எவ்வளவு நேரம் ஆகிறது என்பது பதில், அடிக்குறிப்பு அல்ல. எதையும் ஒத்திகை செய்யாததைத் தலைமை அலுவலகம் மறுக்கிறது: முத்திரையுடன் சோதிக்காத ஏற்றுமதி, யாரும் முடிவு செய்யாத நிறுத்தும் சிக்கல், அல்லது முதலில் காலி செய்யாத பயிற்சிக் கடை.',
    trialId: 'இந்தச் சோதனைக்குப் பெயர்', trialRows: 'ஏற்றிய வரிசைகள்', trialMinutes: 'ஆன நிமிடங்கள்', trialFull: 'உண்மையான மாற்றம் கொண்டு செல்லும் வரிசைகள் (அதே எனில் காலியாக விடவும்)', trialEmpty: 'இந்த ஏற்றத்திற்கு முன் பயிற்சிக் கடை காலி செய்யப்பட்டது',
    runTrial: 'சோதனை ஏற்றத்தைப் பதிவு செய்', trialOk: 'சோதனை ஏற்றம் பதிவு செய்யப்பட்டது', loadedK: 'ஏற்றிய வரிசைகள்', tookK: 'ஆனது', projectsK: 'முழு அளவுக்கு ஆகும் நேரம்', repeatableK: 'மீண்டும் செய்யலாம்', minK: 'நிமி',
    verifyFirst: 'முதலில் ஏற்றுமதியை அதன் முத்திரையுடன் சோதிக்கவும் — சோதிக்காத ஏற்றுமதியின் சோதனை எதையும் ஒத்திகை செய்வதில்லை.', noTrialId: 'சோதனைக்குப் பெயரிடவும் (எழுத்துகள், எண்கள், புள்ளி, கோடு).', noTrialRows: 'ஏற்றிய வரிசைகள் முழு எண்.', noMinutes: 'நிமிடங்கள் ஒரு எண், எ.கா. 12.5.', noFull: 'உண்மையான மாற்றத்தின் வரிசைகள் முழு எண்.',
    totH: 'எண்கள் (கட்டுப்பாட்டு மொத்தங்கள்)', totLead: 'ஒவ்வொரு எண்ணும் இருமுறை — பழைய முறை சொல்வதும் வந்து சேர்ந்ததும் — ஒவ்வொரு பக்கமும் எப்படிக் கணக்கிடப்பட்டது என்பதுடன். ஏற்றத்தை இயக்காத ஒருவர் ஒவ்வொன்றிலும் கையொப்பமிடுகிறார்; நிதி அல்லது வரி எண்ணில் பட்டயக் கணக்காளர் மட்டுமே கையொப்பமிடுவார்.',
    showTotals: 'எண்களைக் காட்டு', totalsNone: 'இன்னும் எந்த எண்ணும் பதிவு செய்யப்படவில்லை — எதுவும் சோதிக்கப்படவில்லை, அது எல்லாம் பொருந்துகிறது என்பதற்குச் சமம் அல்ல.',
    oldSaysK: 'பழைய முறை', cameK: 'வந்து சேர்ந்தது', signedByK: 'கையொப்பமிட்டவர்', notSignedK: 'கையொப்பம் இல்லை', totWhich: 'எந்த எண்', totStatement: 'நீங்கள் சோதித்தது', signTotal: 'இந்த எண்ணில் கையொப்பமிடு',
    qg07Ok: 'ஒவ்வொரு எண்ணும் பொருந்தி கையொப்பமிடப்பட்டது (QG-07)', qg07No: 'இன்னும் ஒவ்வொரு எண்ணும் பொருந்திக் கையொப்பமிடப்படவில்லை (QG-07)', noTotal: 'ஒரு எண்ணைத் தேர்ந்தெடுக்கவும்.', noTotStatement: 'நீங்கள் சோதித்ததை உங்கள் சொந்த வார்த்தைகளில் சொல்லவும்.',
    ts_reconciled: 'சரியாகப் பொருந்துகிறது', ts_explained: 'விட்டுச் செல்ல ஒப்புக்கொண்டதால் விளக்கப்பட்டது', ts_open: 'பொருந்தவில்லை',
    gateH: 'மாற முடியுமா — சோதனைகள்', gateLead: 'ஒவ்வொரு சோதனையையும் தலைமை அலுவலகம் தனது சொந்தப் பதிவுகளிலிருந்து கணக்கிடுகிறது — யாரும் டிக் செய்யும் பெட்டி இல்லை. கடைக் கணினிக்கு மட்டுமே தெரிந்தவை (அனுப்பாத விற்பனைகள், இரவுக் குழு) இங்கே "தெரியாது" எனப் படிக்கும்; உரிமையாளர் GO-வைக் கடைக் கணினியின் தரவு மாற்றத் திரையில் சொல்கிறார்.',
    gateCutover: 'மாற்றத்தின் பெயர்', readGate: 'சோதனைகளைப் படி', showRollback: 'ஒத்திகை செய்த பின்வாங்கலைக் காட்டு', goK: 'ஆம் — ஒவ்வொரு சோதனையும் தேறியது', notYetK: 'இன்னும் இல்லை',
    c_passed: 'தேறியது', c_failed: 'இன்னும் இல்லை', c_not_known: 'தெரியாது',
    rbDemonstrated: 'பழைய முறைக்குத் திரும்புவது ஒத்திகை செய்யப்பட்டது — செய்து, பொருத்தப்பட்டது', rbNot: 'பழைய முறைக்குத் திரும்புவது இன்னும் வேலை செய்வதாகக் காட்டப்படவில்லை',
    ck_control_totals_signed: 'ஒவ்வொரு எண்ணும் பொருந்தி கையொப்பமிடப்பட்டது', ck_rollback_demonstrated: 'பழைய முறைக்குத் திரும்புவது ஒத்திகை செய்யப்பட்டது', ck_parallel_run_sufficient: 'இரண்டையும் இயக்கிய போதுமான சுத்தமான நாட்கள்',
    ck_edge_fully_synced: 'கடைக் கணினி அனைத்தையும் அனுப்பியது', ck_blocking_exceptions_cleared: 'நிறுத்தும் சிக்கல் எதுவும் இல்லை', ck_delta_applied: 'கடைசி மாற்றங்கள் ஏற்றப்பட்டன',
    ck_team_named: 'இரவுக்கான குழு பெயரிடப்பட்டது', ck_owner_go: 'உரிமையாளர் GO சொன்னார்', ck_backup_verified: 'போதுமான சமீபத்திய நல்ல காப்புப் பிரதி', ck_rollback_limits_agreed: 'பின்வாங்கும் வரம்புகள் ஒப்புக்கொள்ளப்பட்டன',
  },
} as const;
export type OldSystemCopyKey = keyof typeof OLD_SYSTEM_COPY.en;
export const oldSystemWords = (lang: Lang, key: OldSystemCopyKey | string): string =>
  (OLD_SYSTEM_COPY[lang] as Record<string, string>)[key] ?? (OLD_SYSTEM_COPY.en as Record<string, string>)[key] ?? key;
export const oldSystemOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => oldSystemWords(lang, k), out);

/** Paise as rupees, Indian grouping. */
export const rupees = (minor: number): string => `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ── the pure checks the page makes before asking ───────────────────────────────────────────────────────────

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const whole = (s: string): number | undefined => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : undefined);
type Invalid = { readonly result: 'invalid'; readonly why: string };
const invalid = (why: string): Invalid => ({ result: 'invalid', why });

/** One source as typed → the body head office reads, or why it cannot be sent. An empty owner / rows / retention is sent as absent: that IS the gap. */
export function readSource(d: SourceDraft): LegacySourceBody | Invalid {
  if (!ID.test(d.sourceId.trim())) return invalid('noSourceId');
  if (d.name.trim() === '') return invalid('noSourceName');
  if (!(SOURCE_KINDS as readonly string[]).includes(d.kind)) return invalid('noKind');
  if (!(VOLUME_BASES as readonly string[]).includes(d.volumeBasis)) return invalid('noBasis');
  const rows = d.rowCount.trim() === '' ? undefined : whole(d.rowCount);
  if (d.rowCount.trim() !== '' && rows === undefined) return invalid('noRows');
  const years = d.retentionYears.trim() === '' ? undefined : whole(d.retentionYears);
  if (d.retentionYears.trim() !== '' && years === undefined) return invalid('noRetention');
  return {
    sourceId: d.sourceId.trim(), name: d.name.trim(), kind: d.kind, volumeBasis: d.volumeBasis, extractable: d.extractable,
    ...(d.ownerUserId.trim() === '' ? {} : { ownerUserId: d.ownerUserId.trim() }),
    ...(rows === undefined ? {} : { rowCount: rows }), ...(years === undefined ? {} : { retentionYears: years }),
  };
}

export function readEntry(d: { readonly domain: string; readonly legacyValue: string; readonly targetValue: string; readonly rationale: string }): MappingEntryBody | Invalid {
  if (!(MAPPING_DOMAINS as readonly string[]).includes(d.domain)) return invalid('noDomain');
  if (d.legacyValue.trim() === '') return invalid('noOld');
  if (d.targetValue.trim() === '') return invalid('noNew');
  if (d.rationale.trim() === '') return invalid('noWhy');
  return { domain: d.domain, legacyValue: d.legacyValue.trim(), targetValue: d.targetValue.trim(), rationale: d.rationale.trim() };
}

export function readSeen(d: { readonly domain: string; readonly value: string; readonly rows: string }): ObservedBody | Invalid {
  if (!(MAPPING_DOMAINS as readonly string[]).includes(d.domain)) return invalid('noDomain');
  if (d.value.trim() === '') return invalid('noSeenValue');
  const rows = whole(d.rows);
  if (rows === undefined) return invalid('noSeenRows');
  return { domain: d.domain, value: d.value.trim(), rows };
}

/** "1250.50" → 125050 paise; undefined when it is not a rupee amount. */
export function paiseOf(text: string): number | undefined {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text.trim().replace(/,/g, ''));
  if (m === null) return undefined;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

/** MG-02 — the data rows of an export: every non-empty line after the header (the count its seal was taken with). */
export const dataRowsOf = (csv: string): number => csv.replace(/^\uFEFF/, '').split(/\r?\n/).slice(1).filter((l) => l.trim() !== '').length;

/** MG-02 — the seal file as kept (the seal itself, or slice.json's `{ seal }` entry) → the seal, or undefined. */
export function readSeal(text: string): Readonly<Record<string, unknown>> | undefined {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return undefined; }
  const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
  const seal = isObj(raw) && isObj(raw['seal']) ? raw['seal'] : raw;
  if (!isObj(seal) || typeof seal['digest'] !== 'string' || typeof seal['rowCount'] !== 'number' || seal['sealed'] !== true) return undefined;
  return seal;
}

/** "12.5" minutes → 750000 ms; undefined when it is not a positive number of minutes. */
export function msOfMinutes(text: string): number | undefined {
  const m = /^(\d+)(?:\.(\d{1,3}))?$/.exec(text.trim());
  if (m === null) return undefined;
  const ms = Math.round(Number(text.trim()) * 60_000);
  return ms > 0 ? ms : undefined;
}

/** The download the approved table is kept as — the chain-of-custody copy the load reads. */
export function approvedTableFile(t: MappingTableRead): { readonly name: string; readonly href: string } {
  return { name: `${t.mappingId}-v${t.version}-approved.json`, href: `data:application/json;charset=utf-8,${encodeURIComponent(`${JSON.stringify(t, null, 2)}\n`)}` };
}

// ── the session ───────────────────────────────────────────────────────────────────────────────────────────

export interface OldSystemMay {
  readonly named: boolean;
  readonly discover: boolean; readonly mapRead: boolean; readonly mapApprove: boolean;
  readonly exclusionsRead: boolean; readonly propose: boolean; readonly decideExclusion: boolean;
  readonly diffRead: boolean; readonly diffRun: boolean;
  readonly windowRead: boolean; readonly cutoverDecide: boolean;
  readonly retire: boolean;
  // W4 · WF-19
  readonly verify: boolean; readonly trial: boolean; readonly resolve: boolean; readonly sign: boolean;
  // U6 · MG-09: loading the changes made after the final extract, exactly once
  readonly delta: boolean;
}

export interface OldSystemSession {
  readonly may: OldSystemMay;
  discover(sources: readonly LegacySourceBody[]): Promise<Outcome<DiscoveryRead>>;
  /** Coverage is measured with the APPROVED table (head office maps nothing with a draft — a draft is a proposal). */
  coverage(observed: readonly ObservedBody[]): Promise<Outcome<CoverageRead>>;
  approveMapping(table: { readonly mappingId: string; readonly version: string; readonly entries: readonly MappingEntryBody[] }): Promise<Outcome<MappingTableRead>>;
  exclusions(): Promise<Outcome<ExclusionsRead>>;
  proposeExclusion(d: { readonly exclusionId: string; readonly scope: string; readonly description: string; readonly recordCount: string; readonly value: string; readonly reason: string }): Promise<Outcome<ExclusionRead>>;
  decideExclusion(exclusionId: string, choice: string, statement: string): Promise<Outcome<ExclusionRead>>;
  exportDiffs(): Promise<Outcome<ExportDiffsRead>>;
  runExportDiff(d: { readonly diffId: string; readonly domain: string; readonly columns: Readonly<Record<string, string>>; readonly baseline: { readonly csv: string; readonly label: string } | null; readonly latest: { readonly csv: string; readonly label: string } | null }, domains: readonly ExportDomainRead[]): Promise<Outcome<ExportDiffResult>>;
  window(cutoverId: string): Promise<Outcome<WindowRead>>;
  nightCheck(): Promise<Outcome<NightCheckRead>>;
  askReversal(loadId: string, cutoverId: string, reason: string): Promise<Outcome<unknown>>;
  approveReversal(loadId: string): Promise<Outcome<unknown>>;
  reversal(loadId: string): Promise<Outcome<ReversalRead>>;
  assessRetirement(d: RetirementDraft): Promise<Outcome<RetirementRead>>;
  // ── W4 · WF-19: the load, its problems, its trial, its figures, the switch-over checks ──
  /** MG-02 — is the export about to be loaded the one that was sealed? Remembered for the trial load on this page. */
  verifyExtract(sealText: string, csv: string): Promise<Outcome<VerifyRead>>;
  /** MG-04 — every problem ever recorded, and what still stops the switch-over. */
  problems(): Promise<Outcome<ExceptionsRead>>;
  decideProblem(exceptionId: string, action: string, reason: string, survivor: string): Promise<Outcome<unknown>>;
  /** MG-05 — the trial load: the verified export and head office's own count of undecided blocking problems go with it. */
  trialLoad(d: { readonly trialId: string; readonly rows: string; readonly minutes: string; readonly fullRows: string; readonly preparedEmpty: boolean }): Promise<Outcome<TrialLoadRead>>;
  /** U6 · MG-09 — LOAD the changes made after the final extract, exactly once: the changes file (the route's own fields as
   *  columns) and the extract's moment at the shop. A row that cannot be read is refused by name and nothing is sent. */
  applyDeltas(d: { readonly extractCutoff: string; readonly cutoffTime?: string; readonly csv: string }): Promise<Outcome<DeltaRead>>;
  /** MG-06 — the figures and their reconciliation (QG-07). */
  totals(): Promise<Outcome<TotalsRead>>;
  signTotal(totalId: string, statement: string): Promise<Outcome<unknown>>;
  /** WF-19 — the switch-over gate's own reading (no GO is said from here). */
  gate(cutoverId: string): Promise<Outcome<GateRead>>;
  rollback(cutoverId: string): Promise<Outcome<RollbackRead>>;
}

export function createOldSystemSession(input: { readonly viewer: ViewerIdentity | undefined; readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string }): OldSystemSession {
  const perms = new Set(input.viewer?.permissions ?? []);
  const named = input.viewer?.userId !== undefined;
  const has = (p: string): boolean => named && perms.has(p);
  const may: OldSystemMay = {
    named,
    discover: has('migration.discovery.read'), mapRead: has('migration.mapping.read'), mapApprove: has('migration.mapping.approve'),
    exclusionsRead: has('migration.reconciliation.read'), propose: has('migration.exclusion.propose'), decideExclusion: has('migration.exclusion.approve'),
    diffRead: has('migration.cleaning.read'), diffRun: has('migration.exception.record'),
    windowRead: has('migration.parallel.read'), cutoverDecide: has('migration.cutover.decide'),
    retire: has('migration.retirement.assess'),
    verify: has('migration.preservation.verify'), trial: has('migration.trial.run'),
    resolve: has('migration.exception.resolve'), sign: has('migration.controltotal.sign'),
    delta: has('migration.delta.apply'),
  };
  const call = makeCaller({ keyPrefix: 'old-system', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const gate = (right: boolean): Invalid | undefined => (!named ? invalid('nobody') : right ? undefined : invalid('notAllowed'));
  // The mapping table is built FOR this shop: its tenant is head office's answer about who is signed in, never typed.
  let tenantId: string | undefined;
  /** The table head office last approved on this page — what coverage is measured with. */
  let approved: MappingTableRead | undefined;
  const tenant = async (): Promise<string | Invalid> => {
    if (tenantId !== undefined) return tenantId;
    const me = await call<{ tenantId?: string }>('GET', '/v1/identity/me');
    if (me.result !== 'ok' || typeof me.value.tenantId !== 'string') return invalid('notReady');
    tenantId = me.value.tenantId;
    return tenantId;
  };
  const tableOf = async (t: { readonly mappingId: string; readonly version: string; readonly entries: readonly MappingEntryBody[] }): Promise<MappingTableRead | Invalid> => {
    if (!ID.test(t.mappingId.trim())) return invalid('noMapId');
    const version = whole(t.version);
    if (version === undefined || version < 1) return invalid('noVersion');
    if (t.entries.length === 0) return invalid('noEntries');
    const tid = await tenant();
    if (typeof tid !== 'string') return tid;
    return { mappingId: t.mappingId.trim(), tenantId: tid, version, status: 'draft', entries: t.entries };
  };
  const enc = encodeURIComponent;
  /** MG-02: what head office said about the export checked on this page — the trial load sends exactly that. */
  let verified: boolean | undefined;
  return {
    may,
    discover: async (sources) => gate(may.discover) ?? (sources.length === 0 ? invalid('noSources') : call('POST', '/v1/migration/discovery', { sources })),
    coverage: async (observed) => {
      const no = gate(may.mapRead); if (no) return no;
      if (approved === undefined) return invalid('approveFirst');
      if (observed.length === 0) return invalid('noSeen');
      return call('POST', '/v1/migration/mapping/coverage', { table: approved, observed });
    },
    approveMapping: async (t) => {
      const no = gate(may.mapApprove); if (no) return no;
      const table = await tableOf(t); if ('result' in table) return table;
      const out = await call<MappingTableRead>('POST', '/v1/migration/mapping/approve', { table });
      if (out.result === 'ok') approved = out.value; // head office's approved table, exactly as it came back
      return out;
    },
    exclusions: async () => gate(may.exclusionsRead) ?? call('GET', '/v1/migration/history/exclusions'),
    proposeExclusion: async (d) => {
      const no = gate(may.propose); if (no) return no;
      if (!ID.test(d.exclusionId.trim())) return invalid('noExclId');
      if (!(EXCLUSION_SCOPES as readonly string[]).includes(d.scope)) return invalid('noScope');
      if (d.description.trim() === '') return invalid('noDesc');
      const count = whole(d.recordCount); if (count === undefined) return invalid('noCount');
      const value = paiseOf(d.value); if (value === undefined) return invalid('noValue');
      if (d.reason.trim() === '') return invalid('noReason');
      return call('POST', '/v1/migration/history/exclusions', { exclusionId: d.exclusionId.trim(), scope: d.scope, description: d.description.trim(), recordCount: count, valueMinor: value, reason: d.reason.trim() });
    },
    decideExclusion: async (id, choice, statement) => {
      const no = gate(may.decideExclusion); if (no) return no;
      if (choice !== 'approve' && choice !== 'reject') return invalid('noChoice');
      if (statement.trim() === '') return invalid('noStatement');
      return call('POST', `/v1/migration/history/exclusions/${enc(id)}/decision`, { approve: choice === 'approve', ownerStatement: statement.trim() });
    },
    exportDiffs: async () => gate(may.diffRead) ?? call('GET', '/v1/migration/export-diffs'),
    runExportDiff: async (d, domains) => {
      const no = gate(may.diffRun); if (no) return no;
      if (!ID.test(d.diffId.trim())) return invalid('noDiffId');
      const spec = domains.find((x) => x.domain === d.domain);
      if (domains.length === 0) return invalid('domainsFirst');
      if (spec === undefined) return invalid('noDiffDomain');
      if (d.baseline === null || d.latest === null || d.baseline.csv === '' || d.latest.csv === '') return invalid('noFiles');
      const mapping: Record<string, string> = {};
      for (const f of spec.fields) {
        const col = (d.columns[f.key] ?? '').trim();
        if (col !== '') mapping[f.key] = col;
        else if (f.required) return invalid('noColumns');
      }
      return call('POST', `/v1/migration/export-diffs/${enc(d.diffId.trim())}`, { domain: d.domain, mapping, baseline: d.baseline, latest: d.latest });
    },
    window: async (cutoverId) => gate(may.windowRead) ?? (cutoverId.trim() === '' ? invalid('noCutover') : call('GET', `/v1/migration/cutover/windows/${enc(cutoverId.trim())}`)),
    nightCheck: async () => gate(may.cutoverDecide) ?? call('POST', '/v1/migration/cutover/night-check', {}),
    askReversal: async (loadId, cutoverId, reason) => {
      const no = gate(may.cutoverDecide); if (no) return no;
      if (loadId.trim() === '') return invalid('noLoad');
      if (cutoverId.trim() === '') return invalid('noCutover');
      if (reason.trim() === '') return invalid('noReverseReason');
      // Only WHICH cutover and WHY — what is taken back is head office's, from the load's own register (hard rule #10).
      return call('POST', `/v1/migration/opening-reversals/${enc(loadId.trim())}`, { cutoverId: cutoverId.trim(), reason: reason.trim() });
    },
    approveReversal: async (loadId) => gate(may.cutoverDecide) ?? (loadId.trim() === '' ? invalid('noLoad') : call('POST', `/v1/migration/opening-reversals/${enc(loadId.trim())}/approval`, {})),
    reversal: async (loadId) => gate(may.windowRead) ?? (loadId.trim() === '' ? invalid('noLoad') : call('GET', `/v1/migration/opening-reversals/${enc(loadId.trim())}`)),
    assessRetirement: async (d) => {
      const no = gate(may.retire); if (no) return no;
      const rows = whole(d.rowCount); const years = whole(d.retentionYears); const open = whole(d.openAssessments);
      if (!ID.test(d.archiveId.trim()) || d.sourceId.trim() === '' || d.digest.trim() === '' || rows === undefined || years === undefined
        || !DAY.test(d.archivedOn.trim()) || !DAY.test(d.earliestRecordDate.trim()) || !DAY.test(d.latestRecordDate.trim())
        || (d.restoreVerifiedOn.trim() !== '' && !DAY.test(d.restoreVerifiedOn.trim()))) return invalid('noArchive');
      if (open === undefined) return invalid('noOpen');
      return call('POST', '/v1/migration/retirement/assessment', {
        archive: {
          archiveId: d.archiveId.trim(), sourceId: d.sourceId.trim(), digest: d.digest.trim(), rowCount: rows, archivedAt: `${d.archivedOn.trim()}T00:00:00.000Z`,
          retentionYears: years, earliestRecordDate: d.earliestRecordDate.trim(), latestRecordDate: d.latestRecordDate.trim(), readOnly: true,
          ...(d.restoreVerifiedOn.trim() === '' ? {} : { restoreVerifiedAt: `${d.restoreVerifiedOn.trim()}T00:00:00.000Z` }),
        },
        cutoverAccepted: d.cutoverAccepted, openAssessments: open,
      });
    },
    verifyExtract: async (sealText, csv) => {
      const no = gate(may.verify); if (no) return no;
      if (sealText.trim() === '') return invalid('noSealFile');
      const extract = readSeal(sealText); if (extract === undefined) return invalid('notASeal');
      if (csv.trim() === '') return invalid('noExtractFile');
      const out = await call<VerifyRead>('POST', '/v1/migration/extracts/verify', { extract, material: csv, rowCount: dataRowsOf(csv) });
      verified = out.result === 'ok' ? out.value.matches && out.value.rowCountMatches : verified;
      return out;
    },
    problems: async () => gate(may.diffRead) ?? call('GET', '/v1/migration/exceptions'),
    decideProblem: async (id, action, reason, survivor) => {
      const no = gate(may.resolve); if (no) return no;
      if (id.trim() === '') return invalid('noProblem');
      if (!(RESOLUTION_ACTIONS as readonly string[]).includes(action)) return invalid('noAction');
      if (reason.trim() === '') return invalid('noProblemReason');
      if (action === 'merge' && survivor.trim() === '') return invalid('noSurvivor');
      return call('POST', `/v1/migration/exceptions/${enc(id.trim())}/resolution`, { action, reason: reason.trim(), ...(action === 'merge' ? { survivingLegacyId: survivor.trim() } : {}) });
    },
    trialLoad: async (d) => {
      const no = gate(may.trial); if (no) return no;
      if (!ID.test(d.trialId.trim())) return invalid('noTrialId');
      const rows = whole(d.rows); if (rows === undefined) return invalid('noTrialRows');
      const elapsedMs = msOfMinutes(d.minutes); if (elapsedMs === undefined) return invalid('noMinutes');
      const full = d.fullRows.trim() === '' ? undefined : whole(d.fullRows);
      if (d.fullRows.trim() !== '' && full === undefined) return invalid('noFull');
      if (verified === undefined) return invalid('verifyFirst');
      // The blocking problems nobody decided are head office's own count, read now — never typed (MG-04).
      const open = await call<ExceptionsRead>('GET', '/v1/migration/exceptions');
      if (open.result !== 'ok') return open;
      return call('POST', '/v1/migration/trial-loads', {
        trialId: d.trialId.trim(), rowsToLoad: rows, elapsedMs, extractVerified: verified,
        blockingExceptionsOpen: open.value.outstanding.blockingUnresolved.length, targetPreparedEmpty: d.preparedEmpty,
        ...(full === undefined ? {} : { fullVolumeRows: full }),
      });
    },
    // U6 · MG-09: the changes LOADED, exactly once. Head office judges each (already applied / before the cutoff / a kind it
    // does not apply); the page sends the file's changes and the extract's moment, nothing of its own.
    applyDeltas: async (d) => {
      const no = gate(may.delta); if (no) return no;
      const cutoff = shopMomentOf(d.extractCutoff, d.cutoffTime);
      if (cutoff === undefined) return invalid('noCutoff');
      const read = readDeltaCsv(d.csv);
      if (!read.ok) return invalid(read.why);
      return call('POST', '/v1/migration/deltas', { changes: read.changes, extractCutoff: cutoff });
    },
    totals: async () => gate(may.exclusionsRead) ?? call('GET', '/v1/migration/control-totals'),
    signTotal: async (id, statement) => {
      const no = gate(may.sign); if (no) return no;
      if (id.trim() === '') return invalid('noTotal');
      if (statement.trim() === '') return invalid('noTotStatement');
      return call('POST', `/v1/migration/control-totals/${enc(id.trim())}/signature`, { statement: statement.trim() });
    },
    // The gate's own reading: no `ownerGo` and no evidence of the page's own — head office answers every check from its
    // records, and what only the store computer knows reads "not known" (the owner says GO at the box).
    gate: async (cutoverId) => gate(may.cutoverDecide) ?? (cutoverId.trim() === '' ? invalid('noCutover') : call('POST', '/v1/migration/cutover/decision', { cutoverId: cutoverId.trim(), evidence: {} })),
    rollback: async (cutoverId) => gate(may.windowRead) ?? (cutoverId.trim() === '' ? invalid('noCutover') : call('GET', `/v1/migration/cutover/rollback/${enc(cutoverId.trim())}`)),
  };
}
