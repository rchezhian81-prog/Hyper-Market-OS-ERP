// The data import & export console — the operator's screen (M30-FR-01/02/03 · API-03 · §28 · P-06 · ADR-0024).
//
// Two panels, one screen, both over already-integration-tested routes:
//   • EXPORT — "your data is yours" (FR-02). Lists the exportable domains (GET /v1/export) with which
//     columns are sensitive, runs one export (POST /v1/export/:domain — the caller's own authority decides
//     allowed / branch scope / redaction, and every export is logged), and shows the recent-exports audit
//     trail (GET /v1/exports). Running an export is a real, AUDITED action.
//   • IMPORT — bulk load under maker-checker (FR-01/03, ADR-0024). The operator picks a template (the box ships
//     the store's templates), pastes the delimited file and CHECKS it (POST /v1/import/validate — a preview of
//     what would apply, every error by line, whether a financial file reconciles, and the file's check code).
//     Then the TWO-PERSON flow, which no typed name can stand in for:
//       1. **Ask for approval** — the uploader, in their own session, asks head office's approval engine
//          (POST /v1/approvals/requests, kind `data_import_commit`) to approve THIS load of THIS exact file: the
//          job name and the file's check code. They say why. The screen then shows it waiting for a second person.
//       2. A DIFFERENT person who may load data approves or rejects it on their Approvals page, in their own session.
//       3. **Load it** — the screen finds the uploader's own APPROVED request for this job (GET
//          /v1/approvals/requests) whose check code is still the file's, and commits the whole job naming that
//          approval (POST /v1/import/commit with `approvalId`). Not approved yet, rejected (by whom, and why),
//          expired, already used, or the file changed since asking — each is said plainly, and nothing is loaded.
//     The server re-validates, re-computes the check code and is the single gate; the screen refuses the cheap
//     things locally before any POST.
//
// Every rule lives here in a tested, DOM-free session model on the shared packages/ui + a11y primitives
// (colour is never the only signal); the shell only renders what this hands over. No AI runs an import or an
// export (hard rule #5).

import { translator, presentScreenState, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { presentStatus, type StatusPresentation } from '../../../packages/a11y/src/signals';
import {
  presentRequestStatus, rupees, shopTime,
  type ApprovalAsk, type ApprovalRequestView, type AskResult, type InboxRead,
} from './approvals-session';

// ── the shapes the ports hand over ─────────────────────────────────────────────────────────────────────────

export interface ExportColumnView { readonly name: string; readonly type: string; readonly sensitive: boolean; }
/** One exportable domain (GET /v1/export). `requires` is the permission the engine enforces server-side. */
export interface ExportDomainView {
  readonly domain: string; readonly requires: string; readonly columns: readonly ExportColumnView[];
  /** SF-10: a dated domain (attendance) is exported for a bounded period — head office says how long at most. */
  readonly period?: { readonly required: boolean; readonly maxDays: number };
}
/** A period of whole days, inclusive, in the shop's calendar (YYYY-MM-DD). */
export interface ExportPeriodInput { readonly from: string; readonly to: string }
/** What an export of a dated domain answered: the rows taken and the columns hidden for this person, the server's
 *  refusal in its own words (`code` names which rule), or no connection. */
export type ExportReply =
  | { readonly kind: 'exported'; readonly rowCount: number; readonly redactedColumns: readonly string[] }
  | { readonly kind: 'refused'; readonly code: string; readonly whatHappened: string }
  | { readonly kind: 'lost_link' };
/** One export audit row (GET /v1/exports) — who took what, when, how many rows, what was redacted for them. */
export interface ExportAuditView {
  readonly userId: string; readonly domain: string; readonly at: string;
  readonly rowCount: number; readonly redactedColumns: readonly string[];
}
/** An import template the box ships to the screen (the store's configured loads). */
export interface ImportTemplateView {
  readonly id: string;
  readonly domain: string;
  readonly label: string;
  /** True when the template carries an amount column and must reconcile to a declared control total. */
  readonly financial: boolean;
}
export interface RowErrorView { readonly line: number; readonly column: string; readonly message: string; }
/** The import preview (POST /v1/import/validate) — what would apply, and everything wrong, before anything. */
export interface ImportPreviewView {
  readonly totalRows: number;
  readonly validCount: number;
  readonly errorRowCount: number;
  readonly errors: readonly RowErrorView[];
  readonly duplicateCount: number;
  readonly sumMinor?: number;
  readonly reconciles?: boolean;
  /** True only when the load may proceed to approval (no errors, reconciles if financial). */
  readonly commitReady: boolean;
}
/** A checked file: the preview, and the check code head office computed over the template, every row and the
 *  declared total — what an approval is FOR (ADR-0024). `null` when the server did not return one. */
export interface ValidatedImport { readonly preview: ImportPreviewView; readonly contentFingerprint: string | null; }

export type ExportResult = 'exported' | 'refused' | 'lost_link';
/** A validate returns the checked file, or a signal it could not run (no permission / lost link). */
export type ValidateResult = ValidatedImport | 'refused' | 'lost_link';
/** A commit: loaded, no answer, or the server's refusal in its own words (`code` names which rule). */
export type CommitResult = 'committed' | 'lost_link' | { readonly code: string; readonly whatHappened: string };

export interface ValidateRequest { readonly templateId: string; readonly text: string; readonly declaredTotalMinor?: number; }
export interface CommitRequest {
  readonly templateId: string; readonly text: string; readonly jobId: string;
  /** The requestId of the uploader's own APPROVED `data_import_commit` request for this job and this file. */
  readonly approvalId: string;
  readonly declaredTotalMinor?: number;
}

/** The approval kind an import is asked under (head office's engine, ADR-0024). */
export const IMPORT_APPROVAL_KIND = 'data_import_commit';

export interface DataIoPorts {
  /** The exportable domains the shell last read (GET /v1/export), or an injected stand-in. */
  exportDomains(): readonly ExportDomainView[];
  /** The export audit trail the shell last read (GET /v1/exports). */
  recentExports(): readonly ExportAuditView[];
  /** The import templates the box shipped (the store's configured loads). */
  importTemplates(): readonly ImportTemplateView[];
  /** Whether this user may see + run exports (`export.read`). */
  mayExport(): boolean;
  /** Whether this user may validate + see import history (`purchase.import.read`). */
  mayImport(): boolean;
  /** Whether this user may ask for and load an import (`purchase.import.record`). */
  mayCommitImport(): boolean;
  /** Run an export (POST /v1/export/:domain). Only from an explicit action. */
  runExport(domain: string): Promise<ExportResult>;
  /** SF-10: run an export of a dated domain for a period ({ from, to } in the body). Only from an explicit action.
   *  Absent on a bare stand-in: then nothing can be sent, and the screen says there is no link. */
  runPeriodExport?(domain: string, period: ExportPeriodInput): Promise<ExportReply>;
  /** Check an import (POST /v1/import/validate). Reads only — writes nothing. */
  validate(req: ValidateRequest): Promise<ValidateResult>;
  /** Commit an import (POST /v1/import/commit) naming an approved request. Only from an explicit action. */
  commit(req: CommitRequest): Promise<CommitResult>;
  /** Ask a second person to approve (POST /v1/approvals/requests) — the caller's own session is the maker. Only from
   *  an explicit action. Absent on a bare stand-in: then nothing can be asked, and the screen says there is no link. */
  askApproval?(ask: ApprovalAsk): Promise<AskResult>;
  /** The caller's approvals inbox (GET /v1/approvals/requests) — read only. Absent on a bare stand-in (no link). */
  approvalInbox?(): Promise<InboxRead>;
}

export interface DataIoConfig {
  /** Who is looking. `null` means the store computer was not told; head office still knows the signed-in caller. */
  readonly userId: string | null;
  /** The clock (ISO). The default period is read from it in the shop's calendar (IST). Absent: the browser's clock. */
  readonly now?: () => string;
}

/** The shop's calendar day (IST, UTC+05:30 with no daylight saving) of an instant, as YYYY-MM-DD. */
export function shopDay(iso: string): string {
  return new Date(Date.parse(iso) + 330 * 60_000).toISOString().slice(0, 10);
}
const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** The default period for a dated export: the last 7 days ending YESTERDAY in the shop's calendar (a finished day). */
export function defaultExportPeriod(nowIso: string): ExportPeriodInput {
  const to = addDays(shopDay(nowIso), -1);
  return { from: addDays(to, -6), to };
}

// ── the copy: ONE bilingual object for the whole screen ───────────────────────────────────────────────────

export type CopyKey =
  | 'title' | 'lead' | 'langName' | 'nobodyNamed' | 'staleShell' | 'sampleData'
  | 'exportHeading' | 'exportLead' | 'exportBtn' | 'sensitiveTag' | 'noExport'
  | 'recentHeading' | 'recentEmpty' | 'rowsLabel' | 'redactedLabel'
  | 'importHeading' | 'importLead' | 'templateLabel' | 'fileLabel' | 'filePlaceholder'
  | 'totalLabel' | 'validateBtn' | 'jobLabel' | 'whyLabel' | 'whyPlaceholder' | 'askBtn' | 'commitBtn'
  | 'previewValid' | 'previewErrors' | 'previewDupes' | 'previewReconciles' | 'previewNotReconcile' | 'previewReady' | 'previewNotReady'
  | 'exported' | 'exportRefused' | 'exportLostLink'
  | 'periodFrom' | 'periodTo' | 'periodHint' | 'exportedRows' | 'exportedHidden' | 'periodRefused' | 'exportRefusedWords'
  | 'validateRefused' | 'validateLostLink'
  | 'summaryLine' | 'summaryTotal' | 'rowOne' | 'rowMany'
  | 'askedWaiting' | 'askNotAllowed' | 'askNeedsTemplate' | 'askNeedsFile' | 'askNeedsJob' | 'askNeedsWhy'
  | 'askNotReady' | 'askRefused' | 'askRefusedNoWords' | 'askLostLink'
  | 'loadCommitted' | 'loadNotAllowed' | 'loadNotAsked' | 'loadWaiting' | 'loadRejected' | 'loadExpired' | 'loadUsed'
  | 'loadFileChanged' | 'loadRefused' | 'loadRefusedNoWords' | 'loadLostLink'
  | 'requestsHeading' | 'requestsEmpty' | 'requestsLostLink' | 'requestIdLabel' | 'askedAtLabel'
  | 'noImport' | 'noCommit';

export const DATA_IO_COPY: BilingualCopy<CopyKey> = {
  en: {
    title: 'Import & export', langName: 'தமிழ்',
    lead: 'Take your data out in an open format any spreadsheet can read, or load data in — checked row by row, and applied only when a second person approves it.',
    nobodyNamed: 'This store computer has not been told who is using this screen.',
    staleShell: 'No connection to the store computer. This page is what it was last told, at', sampleData: 'Sample data — this is not your shop.',
    exportHeading: 'Take data out', exportLead: 'Every export is written to an open CSV and logged — who took what, when. Columns marked sensitive are hidden unless you are allowed to see them.',
    exportBtn: 'Export', sensitiveTag: 'sensitive', noExport: 'You do not have permission to export data.',
    recentHeading: 'Recent exports', recentEmpty: 'No exports yet.', rowsLabel: 'rows', redactedLabel: 'hidden columns',
    importHeading: 'Bring data in', importLead: 'Pick what you are loading, paste the file and check it. Give the load a name, say why, and ask for approval. Nothing is applied until a second person (not you) approves it on their Approvals page — then you load it.',
    templateLabel: 'What are you loading', fileLabel: 'The file (first row is the column names)', filePlaceholder: 'sku,name,price\\nRICE5,Rice 5kg,45000',
    totalLabel: 'Declared total (whole paise, financial loads only)', validateBtn: 'Check the file',
    jobLabel: 'A name for this load', whyLabel: 'Why this load is needed (the approver reads it)', whyPlaceholder: 'For example: September price list from the supplier.',
    askBtn: 'Ask for approval', commitBtn: 'Load it',
    previewValid: 'ready to load', previewErrors: 'rows with a problem', previewDupes: 'already exist (for review)',
    previewReconciles: 'The total matches.', previewNotReconcile: 'The rows do NOT add up to the declared total.',
    previewReady: 'This file is ready — give it a name and ask a second person to approve it.', previewNotReady: 'This file is not ready — fix the problems above and check again.',
    exported: 'Exported.', exportRefused: 'Could not export — you may not have permission for this data.', exportLostLink: 'No connection — not exported. Try again.',
    periodFrom: 'From', periodTo: 'To', periodHint: 'Choose the days to export — at most {max} days.',
    exportedRows: 'Exported {n} {rowWord}.', exportedHidden: 'Hidden for you: {cols}.',
    periodRefused: 'Not exported — choose a period of at most {max} days, with "From" on or before "To". Nothing was taken.',
    exportRefusedWords: 'Not exported — {words}',
    validateRefused: 'Could not check — you do not have permission, or the file could not be read.', validateLostLink: 'No connection — could not check. Try again.',
    summaryLine: 'Load {rows} {rowWord} ({template}) as "{job}"', summaryTotal: ', declared total {total}', rowOne: 'row', rowMany: 'rows',
    askedWaiting: 'Asked. Waiting for a second person to approve:',
    askNotAllowed: 'You do not have permission to load data, so you cannot ask for a load to be approved.',
    askNeedsTemplate: 'Pick what you are loading first.', askNeedsFile: 'Paste the file first.',
    askNeedsJob: 'Give this load a name first — the approval is for that name.',
    askNeedsWhy: 'Say why this load is needed — the person approving reads it.',
    askNotReady: 'This file is not ready — fix the problems and check again. Nothing was asked.',
    askRefused: 'Not asked:', askRefusedNoWords: 'Not asked — head office refused the request.',
    askLostLink: 'No connection — nothing was asked. Try again.',
    loadCommitted: 'Loaded. The approval has now been used — another load needs a new approval.',
    loadNotAllowed: 'You do not have permission to load data.',
    loadNotAsked: 'Not approved yet — nobody has been asked. Press "Ask for approval" first.',
    loadWaiting: 'Not approved yet — waiting for a second person who may load data (not you) to approve it on their Approvals page.',
    loadRejected: 'Not loaded — {who} rejected it: "{reason}". Fix what they said and ask again.',
    loadExpired: 'Not loaded — the approval ran out of time before it was used. Ask again.',
    loadUsed: 'Not loaded — that approval was already used for a load. A new load needs a new approval.',
    loadFileChanged: 'Not loaded — the file (or what you are loading, or the declared total) changed after you asked. Ask for approval again for this exact file.',
    loadRefused: 'Not loaded:', loadRefusedNoWords: 'Not loaded — every row must be clean and a financial load must add up.',
    loadLostLink: 'No connection — not loaded. Try again.',
    requestsHeading: 'Your requests to load', requestsEmpty: 'You have not asked for any load to be approved.',
    requestsLostLink: 'Could not read your requests just now — no connection.', requestIdLabel: 'Request', askedAtLabel: 'Asked',
    noImport: 'You do not have permission to import data.', noCommit: 'You may check a file, but a person with load permission must ask for approval and load it, and a second person must approve it (§28).',
  },
  ta: {
    title: 'இறக்குமதி & ஏற்றுமதி', langName: 'English',
    lead: 'எந்த விரிதாளும் படிக்கக்கூடிய திறந்த வடிவத்தில் உங்கள் தரவை வெளியே எடுங்கள், அல்லது தரவை உள்ளே ஏற்றுங்கள் — வரிசை வரிசையாகச் சரிபார்க்கப்பட்டு, இரண்டாம் நபர் அனுமதித்தால் மட்டுமே பயன்படுத்தப்படும்.',
    nobodyNamed: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை.',
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:', sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
    exportHeading: 'தரவை வெளியே எடு', exportLead: 'ஒவ்வொரு ஏற்றுமதியும் திறந்த CSV-ஆக எழுதப்பட்டு பதிவு செய்யப்படும் — யார் எதை எப்போது எடுத்தார் என்பது. உணர்திறன் கொண்ட நெடுவரிசைகள் உங்களுக்கு அனுமதி இருந்தால் மட்டுமே காட்டப்படும்.',
    exportBtn: 'ஏற்றுமதி', sensitiveTag: 'உணர்திறன்', noExport: 'தரவை ஏற்றுமதி செய்ய உங்களுக்கு அனுமதி இல்லை.',
    recentHeading: 'சமீபத்திய ஏற்றுமதிகள்', recentEmpty: 'இதுவரை ஏற்றுமதிகள் இல்லை.', rowsLabel: 'வரிசைகள்', redactedLabel: 'மறைக்கப்பட்ட நெடுவரிசைகள்',
    importHeading: 'தரவை உள்ளே கொண்டு வா', importLead: 'எதை ஏற்றுகிறீர்கள் என்பதைத் தேர்ந்தெடுத்து, கோப்பை ஒட்டி, சரிபார்க்கவும். ஏற்றத்திற்கு ஒரு பெயர் கொடுத்து, ஏன் என்று சொல்லி, அனுமதி கேளுங்கள். இரண்டாம் நபர் (நீங்கள் அல்ல) தனது அனுமதிகள் பக்கத்தில் அனுமதிக்கும் வரை எதுவும் பயன்படுத்தப்படாது — பிறகு நீங்கள் ஏற்றலாம்.',
    templateLabel: 'எதை ஏற்றுகிறீர்கள்', fileLabel: 'கோப்பு (முதல் வரிசை நெடுவரிசைப் பெயர்கள்)', filePlaceholder: 'sku,name,price\\nRICE5,அரிசி 5கிலோ,45000',
    totalLabel: 'அறிவிக்கப்பட்ட மொத்தம் (முழு பைசா, நிதி ஏற்றங்களுக்கு மட்டும்)', validateBtn: 'கோப்பைச் சரிபார்',
    jobLabel: 'இந்த ஏற்றத்திற்கு ஒரு பெயர்', whyLabel: 'இந்த ஏற்றம் ஏன் தேவை (அனுமதிப்பவர் இதைப் படிப்பார்)', whyPlaceholder: 'உதாரணம்: விநியோகஸ்தரின் செப்டம்பர் விலைப் பட்டியல்.',
    askBtn: 'அனுமதி கேள்', commitBtn: 'ஏற்று',
    previewValid: 'ஏற்றத் தயார்', previewErrors: 'சிக்கல் உள்ள வரிசைகள்', previewDupes: 'ஏற்கனவே உள்ளன (மறுபரிசீலனைக்கு)',
    previewReconciles: 'மொத்தம் பொருந்துகிறது.', previewNotReconcile: 'வரிசைகள் அறிவிக்கப்பட்ட மொத்தத்துடன் கூடவில்லை.',
    previewReady: 'இந்தக் கோப்பு தயார் — ஒரு பெயர் கொடுத்து இரண்டாம் நபரிடம் அனுமதி கேளுங்கள்.', previewNotReady: 'இந்தக் கோப்பு தயாராக இல்லை — மேலே உள்ள சிக்கல்களைச் சரிசெய்து மீண்டும் சரிபார்க்கவும்.',
    exported: 'ஏற்றுமதி செய்யப்பட்டது.', exportRefused: 'ஏற்றுமதி செய்ய முடியவில்லை — இந்தத் தரவுக்கு உங்களுக்கு அனுமதி இல்லாமல் இருக்கலாம்.', exportLostLink: 'இணைப்பு இல்லை — ஏற்றுமதி செய்யப்படவில்லை. மீண்டும் முயற்சிக்கவும்.',
    periodFrom: 'முதல்', periodTo: 'வரை', periodHint: 'ஏற்றுமதி செய்ய வேண்டிய நாட்களைத் தேர்ந்தெடுக்கவும் — அதிகபட்சம் {max} நாட்கள்.',
    exportedRows: '{n} {rowWord} ஏற்றுமதி செய்யப்பட்டது.', exportedHidden: 'உங்களுக்கு மறைக்கப்பட்டவை: {cols}.',
    periodRefused: 'ஏற்றுமதி செய்யப்படவில்லை — அதிகபட்சம் {max} நாட்கள் கொண்ட காலத்தைத் தேர்ந்தெடுக்கவும்; "முதல்" தேதி "வரை" தேதிக்கு முன் அல்லது அதே நாளாக இருக்க வேண்டும். எதுவும் எடுக்கப்படவில்லை.',
    exportRefusedWords: 'ஏற்றுமதி செய்யப்படவில்லை — {words}',
    validateRefused: 'சரிபார்க்க முடியவில்லை — உங்களுக்கு அனுமதி இல்லை, அல்லது கோப்பைப் படிக்க முடியவில்லை.', validateLostLink: 'இணைப்பு இல்லை — சரிபார்க்க முடியவில்லை. மீண்டும் முயற்சிக்கவும்.',
    summaryLine: '{rows} {rowWord} ({template}) "{job}" என்ற பெயரில் ஏற்றுதல்', summaryTotal: ', அறிவிக்கப்பட்ட மொத்தம் {total}', rowOne: 'வரிசை', rowMany: 'வரிசைகள்',
    askedWaiting: 'கேட்கப்பட்டது. இரண்டாம் நபரின் அனுமதிக்காகக் காத்திருக்கிறது:',
    askNotAllowed: 'தரவை ஏற்ற உங்களுக்கு அனுமதி இல்லை, எனவே ஏற்றத்திற்கு அனுமதி கேட்க முடியாது.',
    askNeedsTemplate: 'முதலில் எதை ஏற்றுகிறீர்கள் என்பதைத் தேர்ந்தெடுக்கவும்.', askNeedsFile: 'முதலில் கோப்பை ஒட்டவும்.',
    askNeedsJob: 'முதலில் இந்த ஏற்றத்திற்கு ஒரு பெயர் கொடுங்கள் — அனுமதி அந்தப் பெயருக்குத்தான்.',
    askNeedsWhy: 'இந்த ஏற்றம் ஏன் தேவை என்று சொல்லுங்கள் — அனுமதிப்பவர் அதைப் படிப்பார்.',
    askNotReady: 'இந்தக் கோப்பு தயாராக இல்லை — சிக்கல்களைச் சரிசெய்து மீண்டும் சரிபார்க்கவும். எதுவும் கேட்கப்படவில்லை.',
    askRefused: 'கேட்கப்படவில்லை:', askRefusedNoWords: 'கேட்கப்படவில்லை — தலைமை அலுவலகம் கோரிக்கையை ஏற்கவில்லை.',
    askLostLink: 'இணைப்பு இல்லை — எதுவும் கேட்கப்படவில்லை. மீண்டும் முயற்சிக்கவும்.',
    loadCommitted: 'ஏற்றப்பட்டது. அனுமதி இப்போது பயன்படுத்தப்பட்டுவிட்டது — இன்னொரு ஏற்றத்திற்குப் புதிய அனுமதி தேவை.',
    loadNotAllowed: 'தரவை ஏற்ற உங்களுக்கு அனுமதி இல்லை.',
    loadNotAsked: 'இன்னும் அனுமதிக்கப்படவில்லை — யாரிடமும் கேட்கப்படவில்லை. முதலில் "அனுமதி கேள்" அழுத்தவும்.',
    loadWaiting: 'இன்னும் அனுமதிக்கப்படவில்லை — தரவை ஏற்ற அனுமதி உள்ள இரண்டாம் நபர் (நீங்கள் அல்ல) தனது அனுமதிகள் பக்கத்தில் அனுமதிக்கக் காத்திருக்கிறது.',
    loadRejected: 'ஏற்றப்படவில்லை — {who} மறுத்தார்: "{reason}". அவர் சொன்னதைச் சரிசெய்து மீண்டும் கேளுங்கள்.',
    loadExpired: 'ஏற்றப்படவில்லை — பயன்படுத்தும் முன்பே அனுமதியின் நேரம் முடிந்துவிட்டது. மீண்டும் கேளுங்கள்.',
    loadUsed: 'ஏற்றப்படவில்லை — அந்த அனுமதி ஏற்கனவே ஒரு ஏற்றத்திற்குப் பயன்படுத்தப்பட்டது. புதிய ஏற்றத்திற்குப் புதிய அனுமதி தேவை.',
    loadFileChanged: 'ஏற்றப்படவில்லை — நீங்கள் கேட்ட பிறகு கோப்பு (அல்லது ஏற்றும் வகை, அல்லது அறிவிக்கப்பட்ட மொத்தம்) மாறிவிட்டது. இந்தக் கோப்பிற்கே மீண்டும் அனுமதி கேளுங்கள்.',
    loadRefused: 'ஏற்றப்படவில்லை:', loadRefusedNoWords: 'ஏற்றப்படவில்லை — ஒவ்வொரு வரிசையும் சுத்தமாக இருக்க வேண்டும், நிதி ஏற்றம் கூட வேண்டும்.',
    loadLostLink: 'இணைப்பு இல்லை — ஏற்றப்படவில்லை. மீண்டும் முயற்சிக்கவும்.',
    requestsHeading: 'ஏற்றுவதற்கான உங்கள் கோரிக்கைகள்', requestsEmpty: 'எந்த ஏற்றத்திற்கும் நீங்கள் அனுமதி கேட்கவில்லை.',
    requestsLostLink: 'உங்கள் கோரிக்கைகளை இப்போது படிக்க முடியவில்லை — இணைப்பு இல்லை.', requestIdLabel: 'கோரிக்கை', askedAtLabel: 'கேட்டது',
    noImport: 'தரவை இறக்குமதி செய்ய உங்களுக்கு அனுமதி இல்லை.', noCommit: 'நீங்கள் ஒரு கோப்பைச் சரிபார்க்கலாம், ஆனால் ஏற்ற அனுமதி உள்ள ஒருவர் அனுமதி கேட்டு ஏற்ற வேண்டும், இரண்டாம் நபர் அதை அனுமதிக்க வேண்டும் (§28).',
  },
};

export const COPY_KEYS: readonly CopyKey[] = Object.freeze(Object.keys(DATA_IO_COPY.en) as CopyKey[]);

// ── the presented shapes the view renders ────────────────────────────────────────────────────────────────

export interface PresentedDomain {
  readonly domain: string;
  readonly columns: readonly { readonly name: string; readonly sensitive: boolean }[];
  readonly sensitiveCount: number;
  /** SF-10: present when the domain is exported for a period — its limit, the default days and the hint to show. */
  readonly period?: { readonly maxDays: number; readonly defaultFrom: string; readonly defaultTo: string; readonly hint: string };
}
export interface PresentedExport {
  readonly domain: string; readonly userId: string; readonly at: string;
  readonly rowCount: number; readonly redactedColumns: readonly string[];
}

export interface ExportPanelView {
  readonly screenState: StatusPresentation;
  readonly mayExport: boolean;
  readonly domains: readonly PresentedDomain[];
  readonly recent: readonly PresentedExport[];
}
export interface ImportPanelView {
  readonly mayImport: boolean;
  readonly mayCommit: boolean;
  readonly templates: readonly { readonly id: string; readonly label: string; readonly financial: boolean }[];
  readonly nobodyNamed: boolean;
}

/** One of the uploader's own load requests, as the import panel lists it. */
export interface PresentedImportRequest {
  readonly requestId: string;
  readonly jobId: string;
  readonly summary: string;
  readonly reason: string;
  readonly askedAt: string;
  /** Where it stands — waiting / approved until … / rejected by X: why / expired / used — in words, never colour alone. */
  readonly status: StatusPresentation;
}
export interface ImportRequestsView {
  /** `read` — the list is current; `lost_link` / `refused` — it could not be read just now (said so on the page). */
  readonly state: 'read' | 'lost_link' | 'refused' | 'not_allowed';
  readonly rows: readonly PresentedImportRequest[];
}

export interface ImportInput {
  readonly templateId: string;
  readonly text: string;
  readonly jobId: string;
  readonly declaredTotalMinor?: number;
}

/** The outcome of pressing "Ask for approval". */
export type AskOutcome =
  | { readonly kind: 'asked'; readonly request: ApprovalRequestView }
  | { readonly kind: 'not_allowed' }
  | { readonly kind: 'incomplete'; readonly missing: 'template' | 'file' | 'job' | 'why' }
  | { readonly kind: 'not_ready' }
  | { readonly kind: 'refused'; readonly whatHappened: string }
  | { readonly kind: 'lost_link' };

/** The outcome of pressing "Load it". */
export type LoadOutcome =
  | { readonly kind: 'committed' }
  | { readonly kind: 'not_allowed' }
  | { readonly kind: 'incomplete'; readonly missing: 'template' | 'file' | 'job' }
  | { readonly kind: 'not_asked' }
  | { readonly kind: 'waiting' }
  | { readonly kind: 'rejected'; readonly decidedBy: string; readonly reason: string }
  | { readonly kind: 'expired' }
  | { readonly kind: 'used' }
  | { readonly kind: 'file_changed' }
  | { readonly kind: 'refused'; readonly whatHappened: string }
  | { readonly kind: 'lost_link' };

export interface DataIoSession {
  text(lang: Lang, key: CopyKey): string;
  exportPanel(lang: Lang): ExportPanelView;
  importPanel(): ImportPanelView;
  /** Run an export — refused locally without `export.read` before any POST. */
  runExport(domain: string): Promise<ExportResult>;
  /** SF-10: export a dated domain for a period. Refused locally (no POST) only without `export.read`; the period's
   *  rules are head office's, and its refusal is shown in plain words. */
  runPeriodExport(domain: string, period: ExportPeriodInput): Promise<ExportReply>;
  presentExportReply(lang: Lang, domain: string, r: ExportReply): StatusPresentation;
  /** Check an import — refused locally without `purchase.import.read` or an unknown template. Writes nothing. */
  validate(templateId: string, text: string, declaredTotalMinor?: number): Promise<ValidateResult>;
  /** Ask a second person to approve THIS load of THIS file: checks the file (for its check code), then asks head
   *  office's approval engine in the caller's own session. Refused locally (no POST) without load permission, a
   *  template, a file, a job name or a reason, or when the file is not ready. */
  askForApproval(lang: Lang, input: ImportInput & { readonly why: string }): Promise<AskOutcome>;
  /** Load the job: finds the caller's own APPROVED request for this job whose check code is still the file's, and
   *  commits naming it. Says plainly when it is not approved yet, rejected, expired, used, or the file changed —
   *  and then nothing is POSTed to commit. The server re-validates and is the single gate. */
  commit(input: ImportInput): Promise<LoadOutcome>;
  /** The caller's own load requests (a GET — read only), newest first. */
  importRequests(lang: Lang): Promise<ImportRequestsView>;
  presentExportResult(lang: Lang, r: ExportResult): StatusPresentation;
  presentValidateResult(lang: Lang, r: 'refused' | 'lost_link'): StatusPresentation;
  presentAskOutcome(lang: Lang, o: AskOutcome): StatusPresentation;
  presentLoadOutcome(lang: Lang, o: LoadOutcome): StatusPresentation;
}

const NO_LINK = { result: 'lost_link' } as const;

const fill = (template: string, values: Readonly<Record<string, string>>): string =>
  template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);

export function createDataIoSession(config: DataIoConfig, ports: DataIoPorts): DataIoSession {
  const text = (lang: Lang, key: CopyKey): string => translator(DATA_IO_COPY, lang)(key);

  const findTemplate = (id: string): ImportTemplateView | undefined => ports.importTemplates().find((t) => t.id === id);
  const knownTemplate = (id: string): boolean => findTemplate(id) !== undefined;
  const readInbox = (): Promise<InboxRead> => (ports.approvalInbox === undefined ? Promise.resolve(NO_LINK) : ports.approvalInbox());
  const withTotal = (declaredTotalMinor: number | undefined): { declaredTotalMinor?: number } =>
    (declaredTotalMinor !== undefined ? { declaredTotalMinor } : {});

  /** The caller's own requests for one job (kind `data_import_commit`, subject = the job name). */
  const requestsFor = (mine: readonly ApprovalRequestView[], jobId: string): ApprovalRequestView[] =>
    mine.filter((r) => r.kind === IMPORT_APPROVAL_KIND && r.subjectRef === jobId);

  return {
    text,
    exportPanel: (lang) => {
      const t = translator(DATA_IO_COPY, lang);
      const mayExport = ports.mayExport();
      if (!mayExport) {
        return { screenState: presentScreenState({ state: 'locked', label: t('noExport') }), mayExport: false, domains: [], recent: [] };
      }
      const defaults = defaultExportPeriod((config.now ?? (() => new Date().toISOString()))());
      const domains: PresentedDomain[] = ports.exportDomains().map((d) => ({
        domain: d.domain,
        columns: d.columns.map((c) => ({ name: c.name, sensitive: c.sensitive })),
        sensitiveCount: d.columns.filter((c) => c.sensitive).length,
        ...(d.period === undefined ? {} : {
          period: { maxDays: d.period.maxDays, defaultFrom: defaults.from, defaultTo: defaults.to, hint: fill(t('periodHint'), { max: String(d.period.maxDays) }) },
        }),
      }));
      const recent: PresentedExport[] = ports.recentExports().map((e) => ({
        domain: e.domain, userId: e.userId, at: e.at, rowCount: e.rowCount, redactedColumns: e.redactedColumns,
      }));
      const state = domains.length === 0 ? 'empty' : 'ready';
      return { screenState: presentScreenState({ state, label: t('exportHeading') }), mayExport: true, domains, recent };
    },
    importPanel: () => ({
      mayImport: ports.mayImport(),
      mayCommit: ports.mayCommitImport(),
      templates: ports.importTemplates().map((tpl) => ({ id: tpl.id, label: tpl.label, financial: tpl.financial })),
      nobodyNamed: config.userId === null,
    }),

    runExport: async (domain) => {
      if (!ports.mayExport() || domain.trim() === '') return 'refused';
      return ports.runExport(domain);
    },
    runPeriodExport: async (domain, period) => {
      if (!ports.mayExport() || domain.trim() === '') return { kind: 'refused', code: 'export_not_permitted', whatHappened: '' };
      if (ports.runPeriodExport === undefined) return { kind: 'lost_link' };
      return ports.runPeriodExport(domain, { from: period.from.trim(), to: period.to.trim() });
    },
    presentExportReply: (lang, domain, r) => {
      const t = translator(DATA_IO_COPY, lang);
      if (r.kind === 'exported') {
        const rows = fill(t('exportedRows'), { n: String(r.rowCount), rowWord: r.rowCount === 1 ? t('rowOne') : t('rowMany') });
        const hidden = r.redactedColumns.length === 0 ? '' : ` ${fill(t('exportedHidden'), { cols: r.redactedColumns.join(', ') })}`;
        return presentStatus({ tone: 'ok', icon: '✓', label: `${rows}${hidden}`, needsAttention: false });
      }
      if (r.kind === 'lost_link') return presentStatus({ tone: 'degraded', icon: '⚠', label: t('exportLostLink'), needsAttention: true });
      // The server's refusal, in plain words: a period it will not take is said in the page's own words (with the limit
      // head office gave); any other refusal carries head office's own sentence, or the general one when it gave none.
      const max = ports.exportDomains().find((d) => d.domain === domain)?.period?.maxDays;
      if (r.code === 'export_period_not_bounded') return presentStatus({ tone: 'error', icon: '✕', label: fill(t('periodRefused'), { max: String(max ?? '') }), needsAttention: true });
      if (r.whatHappened.trim() === '') return presentStatus({ tone: 'error', icon: '✕', label: t('exportRefused'), needsAttention: true });
      return presentStatus({ tone: 'error', icon: '✕', label: fill(t('exportRefusedWords'), { words: r.whatHappened }), needsAttention: true });
    },

    validate: async (templateId, text2, declaredTotalMinor) => {
      if (!ports.mayImport() || !knownTemplate(templateId) || text2.trim() === '') return 'refused';
      return ports.validate({ templateId, text: text2, ...withTotal(declaredTotalMinor) });
    },

    // The MAKER's step (ADR-0024). The approval is for this job AND this exact file: the check code head office
    // computed over the template, every row and the declared total. So the file is checked first — a file that is
    // not ready is never put in front of a second person.
    askForApproval: async (lang, { templateId, text: text2, jobId, why, declaredTotalMinor }) => {
      if (!ports.mayCommitImport()) return { kind: 'not_allowed' };
      const template = findTemplate(templateId);
      if (template === undefined) return { kind: 'incomplete', missing: 'template' };
      if (text2.trim() === '') return { kind: 'incomplete', missing: 'file' };
      if (jobId.trim() === '') return { kind: 'incomplete', missing: 'job' };
      if (why.trim() === '') return { kind: 'incomplete', missing: 'why' };
      if (ports.askApproval === undefined) return { kind: 'lost_link' };

      const checked = await ports.validate({ templateId, text: text2, ...withTotal(declaredTotalMinor) });
      if (checked === 'lost_link') return { kind: 'lost_link' };
      if (checked === 'refused') return { kind: 'refused', whatHappened: text(lang, 'validateRefused') };
      if (!checked.preview.commitReady) return { kind: 'not_ready' };
      if (checked.contentFingerprint === null || checked.contentFingerprint.trim() === '') return { kind: 'refused', whatHappened: '' };

      const t = translator(DATA_IO_COPY, lang);
      const job = jobId.trim();
      const rows = checked.preview.validCount;
      const summary = fill(t('summaryLine'), { rows: String(rows), rowWord: t(rows === 1 ? 'rowOne' : 'rowMany'), template: template.label, job })
        + (template.financial && declaredTotalMinor !== undefined ? fill(t('summaryTotal'), { total: rupees(declaredTotalMinor) }) : '');
      const asked = await ports.askApproval({
        kind: IMPORT_APPROVAL_KIND,
        subjectRef: job,
        // EXACTLY these two — the commit route recomputes them from the file it is given and refuses any difference.
        details: { jobId: job, contentFingerprint: checked.contentFingerprint },
        valueMinor: null,
        summary,
        reason: why.trim(),
      });
      if (asked.result === 'asked') return { kind: 'asked', request: asked.request };
      if (asked.result === 'lost_link') return { kind: 'lost_link' };
      return { kind: 'refused', whatHappened: asked.whatHappened };
    },

    // The load. Never a typed approver: the caller's own APPROVED request for this job, for this exact file.
    commit: async ({ templateId, text: text2, jobId, declaredTotalMinor }) => {
      if (!ports.mayCommitImport()) return { kind: 'not_allowed' };
      if (!knownTemplate(templateId)) return { kind: 'incomplete', missing: 'template' };
      if (text2.trim() === '') return { kind: 'incomplete', missing: 'file' };
      if (jobId.trim() === '') return { kind: 'incomplete', missing: 'job' };
      const job = jobId.trim();

      const inbox = await readInbox();
      if (inbox.result === 'lost_link') return { kind: 'lost_link' };
      if (inbox.result === 'refused') return { kind: 'refused', whatHappened: inbox.whatHappened };
      const mine = requestsFor(inbox.inbox.mine, job);
      if (mine.length === 0) return { kind: 'not_asked' };

      // Check the file NOW: an approval is only for the file as it was when asked (its check code). A changed file is
      // refused here, before any commit is sent (the server would refuse it too).
      const checked = await ports.validate({ templateId, text: text2, ...withTotal(declaredTotalMinor) });
      if (checked === 'lost_link') return { kind: 'lost_link' };
      if (checked === 'refused' || checked.contentFingerprint === null) return { kind: 'refused', whatHappened: '' };
      const newest = (rows: readonly ApprovalRequestView[]): ApprovalRequestView | undefined =>
        rows.slice().sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))[0];
      const forThisFile = mine.filter((r) => r.details['contentFingerprint'] === checked.contentFingerprint && r.details['jobId'] === job);

      const match = newest(forThisFile.filter((r) => r.status === 'approved'));
      if (match === undefined) {
        // Nothing usable for THIS file. A request for it still waiting is the news; otherwise the newest request for it
        // says what happened; with none for this file, a rejection still says who and why, and anything else means the
        // file changed after asking.
        if (forThisFile.some((r) => r.status === 'waiting')) return { kind: 'waiting' };
        const latest = newest(forThisFile) ?? newest(mine)!;
        if (latest.status === 'rejected') return { kind: 'rejected', decidedBy: latest.decidedBy ?? '—', reason: latest.decisionReason ?? '—' };
        if (forThisFile.length === 0) return { kind: 'file_changed' };
        return latest.status === 'expired' ? { kind: 'expired' } : { kind: 'used' };
      }

      const r = await ports.commit({ templateId, text: text2, jobId: job, approvalId: match.requestId, ...withTotal(declaredTotalMinor) });
      if (r === 'committed') return { kind: 'committed' };
      if (r === 'lost_link') return { kind: 'lost_link' };
      switch (r.code) {
        case 'approval_does_not_match': return { kind: 'file_changed' };
        case 'approval_still_waiting': return { kind: 'waiting' };
        case 'approval_expired': return { kind: 'expired' };
        case 'approval_already_used': return { kind: 'used' };
        case 'no_approval': return { kind: 'not_asked' };
        // Anything else (rejected meanwhile, a checker who lost the authority, a row that broke): the server's own words.
        default: return { kind: 'refused', whatHappened: r.whatHappened };
      }
    },

    importRequests: async (lang) => {
      if (!ports.mayCommitImport()) return { state: 'not_allowed', rows: [] };
      const inbox = await readInbox();
      if (inbox.result !== 'read') return { state: inbox.result, rows: [] };
      const rows = inbox.inbox.mine
        .filter((r) => r.kind === IMPORT_APPROVAL_KIND)
        .slice()
        .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
        .map((r) => ({
          requestId: r.requestId, jobId: r.subjectRef, summary: r.summary, reason: r.reason,
          askedAt: shopTime(r.requestedAt), status: presentRequestStatus(lang, r),
        }));
      return { state: 'read', rows };
    },

    presentExportResult: (lang, r) => {
      const t = translator(DATA_IO_COPY, lang);
      if (r === 'exported') return presentStatus({ tone: 'ok', icon: '✓', label: t('exported'), needsAttention: false });
      if (r === 'lost_link') return presentStatus({ tone: 'degraded', icon: '⚠', label: t('exportLostLink'), needsAttention: true });
      return presentStatus({ tone: 'error', icon: '✕', label: t('exportRefused'), needsAttention: true });
    },
    presentValidateResult: (lang, r) => {
      const t = translator(DATA_IO_COPY, lang);
      if (r === 'lost_link') return presentStatus({ tone: 'degraded', icon: '⚠', label: t('validateLostLink'), needsAttention: true });
      return presentStatus({ tone: 'error', icon: '✕', label: t('validateRefused'), needsAttention: true });
    },
    presentAskOutcome: (lang, o) => {
      const t = translator(DATA_IO_COPY, lang);
      const err = (label: string): StatusPresentation => presentStatus({ tone: 'error', icon: '✕', label, needsAttention: true });
      switch (o.kind) {
        case 'asked':
          // Waiting is a pending state — a person has to come back to it — shown with its own icon and words.
          return presentScreenState({ state: 'pending', label: `${t('askedWaiting')} ${o.request.summary}` });
        case 'not_allowed': return err(t('askNotAllowed'));
        case 'incomplete':
          return err(t(o.missing === 'template' ? 'askNeedsTemplate' : o.missing === 'file' ? 'askNeedsFile' : o.missing === 'job' ? 'askNeedsJob' : 'askNeedsWhy'));
        case 'not_ready': return err(t('askNotReady'));
        case 'refused': return err(o.whatHappened.trim() === '' ? t('askRefusedNoWords') : `${t('askRefused')} ${o.whatHappened.trim()}`);
        case 'lost_link': return presentStatus({ tone: 'degraded', icon: '⚠', label: t('askLostLink'), needsAttention: true });
      }
    },
    presentLoadOutcome: (lang, o) => {
      const t = translator(DATA_IO_COPY, lang);
      const err = (label: string): StatusPresentation => presentStatus({ tone: 'error', icon: '✕', label, needsAttention: true });
      const warn = (label: string): StatusPresentation => presentStatus({ tone: 'degraded', icon: '⚠', label, needsAttention: true });
      switch (o.kind) {
        case 'committed': return presentStatus({ tone: 'ok', icon: '✓', label: t('loadCommitted'), needsAttention: false });
        case 'not_allowed': return err(t('loadNotAllowed'));
        case 'incomplete':
          return err(t(o.missing === 'template' ? 'askNeedsTemplate' : o.missing === 'file' ? 'askNeedsFile' : 'askNeedsJob'));
        case 'not_asked': return warn(t('loadNotAsked'));
        case 'waiting': return presentScreenState({ state: 'pending', label: t('loadWaiting') });
        case 'rejected': return err(fill(t('loadRejected'), { who: o.decidedBy, reason: o.reason }));
        case 'expired': return warn(t('loadExpired'));
        case 'used': return warn(t('loadUsed'));
        case 'file_changed': return warn(t('loadFileChanged'));
        case 'refused': return err(o.whatHappened.trim() === '' ? t('loadRefusedNoWords') : `${t('loadRefused')} ${o.whatHappened.trim()}`);
        case 'lost_link': return warn(t('loadLostLink'));
      }
    },
  };
}
