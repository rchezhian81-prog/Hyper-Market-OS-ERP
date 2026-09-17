// The data import & export console — the operator's screen (M30-FR-01/02/03 · API-03 · §28 · P-06).
//
// Two panels, one screen, both over already-integration-tested routes:
//   • EXPORT — "your data is yours" (FR-02). Lists the exportable domains (GET /v1/export) with which
//     columns are sensitive, runs one export (POST /v1/export/:domain — the caller's own authority decides
//     allowed / branch scope / redaction, and every export is logged), and shows the recent-exports audit
//     trail (GET /v1/exports). Running an export is a real, AUDITED action.
//   • IMPORT — bulk load under maker-checker (FR-01/03). The operator picks a template (the box ships the
//     store's templates), pastes the delimited file, VALIDATES it (POST /v1/import/validate — a preview of
//     what would apply, every error by line, whether a financial file reconciles), then COMMITS the whole job
//     or nothing (POST /v1/import/commit) — which needs a SEPARATE approver (§28: the uploader may never
//     approve their own). The server re-validates and is the single gate; the screen refuses the cheap things
//     locally before any POST (no permission, no approver, an approver who is the uploader).
//
// Every rule lives here in a tested, DOM-free session model on the shared packages/ui + a11y primitives
// (colour is never the only signal); the shell only renders what this hands over. No AI runs an import or an
// export (hard rule #5).

import { translator, presentScreenState, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { presentStatus, type StatusPresentation } from '../../../packages/a11y/src/signals';

// ── the shapes the ports hand over ─────────────────────────────────────────────────────────────────────────

export interface ExportColumnView { readonly name: string; readonly type: string; readonly sensitive: boolean; }
/** One exportable domain (GET /v1/export). `requires` is the permission the engine enforces server-side. */
export interface ExportDomainView { readonly domain: string; readonly requires: string; readonly columns: readonly ExportColumnView[]; }
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

export type ExportResult = 'exported' | 'refused' | 'lost_link';
export type CommitResult = 'committed' | 'refused' | 'lost_link';
/** A validate returns a preview, or a signal it could not run (no permission / lost link). */
export type ValidateResult = ImportPreviewView | 'refused' | 'lost_link';

export interface ValidateRequest { readonly templateId: string; readonly text: string; readonly declaredTotalMinor?: number; }
export interface CommitRequest {
  readonly templateId: string; readonly text: string; readonly jobId: string;
  readonly approver: string; readonly declaredTotalMinor?: number;
}

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
  /** Whether this user may commit an import (`purchase.import.record`). */
  mayCommitImport(): boolean;
  /** Run an export (POST /v1/export/:domain). Only from an explicit action. */
  runExport(domain: string): Promise<ExportResult>;
  /** Preview an import (POST /v1/import/validate). Reads only — writes nothing. */
  validate(req: ValidateRequest): Promise<ValidateResult>;
  /** Commit an import (POST /v1/import/commit) under §28. Only from an explicit action. */
  commit(req: CommitRequest): Promise<CommitResult>;
}

export interface DataIoConfig {
  /** Who is looking. `null` means the store computer was not told; a commit carries the uploader's name. */
  readonly userId: string | null;
}

// ── the copy: ONE bilingual object for the whole screen ───────────────────────────────────────────────────

export type CopyKey =
  | 'title' | 'lead' | 'langName' | 'nobodyNamed' | 'staleShell' | 'sampleData'
  | 'exportHeading' | 'exportLead' | 'exportBtn' | 'sensitiveTag' | 'noExport'
  | 'recentHeading' | 'recentEmpty' | 'rowsLabel' | 'redactedLabel'
  | 'importHeading' | 'importLead' | 'templateLabel' | 'fileLabel' | 'filePlaceholder'
  | 'totalLabel' | 'validateBtn' | 'jobLabel' | 'approverLabel' | 'commitBtn'
  | 'previewValid' | 'previewErrors' | 'previewDupes' | 'previewReconciles' | 'previewNotReconcile' | 'previewReady' | 'previewNotReady'
  | 'exported' | 'exportRefused' | 'exportLostLink'
  | 'validateRefused' | 'validateLostLink'
  | 'committed' | 'commitRefused' | 'commitLostLink'
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
    importHeading: 'Bring data in', importLead: 'Pick what you are loading, paste the file, and check it. Nothing is applied until a second person (not you) approves the whole job.',
    templateLabel: 'What are you loading', fileLabel: 'The file (first row is the column names)', filePlaceholder: 'sku,name,price\\nRICE5,Rice 5kg,45000',
    totalLabel: 'Declared total (whole paise, financial loads only)', validateBtn: 'Check the file',
    jobLabel: 'A name for this load', approverLabel: 'Approved by (a second person, not you)', commitBtn: 'Load it',
    previewValid: 'ready to load', previewErrors: 'rows with a problem', previewDupes: 'already exist (for review)',
    previewReconciles: 'The total matches.', previewNotReconcile: 'The rows do NOT add up to the declared total.',
    previewReady: 'This file is ready — a second person can approve and load it.', previewNotReady: 'This file is not ready — fix the problems above and check again.',
    exported: 'Exported.', exportRefused: 'Could not export — you may not have permission for this data.', exportLostLink: 'No connection — not exported. Try again.',
    validateRefused: 'Could not check — you do not have permission, or the file could not be read.', validateLostLink: 'No connection — could not check. Try again.',
    committed: 'Loaded.', commitRefused: 'Could not load — every row must be clean, a financial load must add up, and a second person (not the uploader) must approve it (§28).', commitLostLink: 'No connection — not loaded. Try again.',
    noImport: 'You do not have permission to import data.', noCommit: 'You may check a file, but a second person with load permission must approve and load it (§28).',
  },
  ta: {
    title: 'இறக்குமதி & ஏற்றுமதி', langName: 'English',
    lead: 'எந்த விரிதாளும் படிக்கக்கூடிய திறந்த வடிவத்தில் உங்கள் தரவை வெளியே எடுங்கள், அல்லது தரவை உள்ளே ஏற்றுங்கள் — வரிசை வரிசையாகச் சரிபார்க்கப்பட்டு, இரண்டாம் நபர் அனுமதித்தால் மட்டுமே பயன்படுத்தப்படும்.',
    nobodyNamed: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை.',
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:', sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
    exportHeading: 'தரவை வெளியே எடு', exportLead: 'ஒவ்வொரு ஏற்றுமதியும் திறந்த CSV-ஆக எழுதப்பட்டு பதிவு செய்யப்படும் — யார் எதை எப்போது எடுத்தார் என்பது. உணர்திறன் கொண்ட நெடுவரிசைகள் உங்களுக்கு அனுமதி இருந்தால் மட்டுமே காட்டப்படும்.',
    exportBtn: 'ஏற்றுமதி', sensitiveTag: 'உணர்திறன்', noExport: 'தரவை ஏற்றுமதி செய்ய உங்களுக்கு அனுமதி இல்லை.',
    recentHeading: 'சமீபத்திய ஏற்றுமதிகள்', recentEmpty: 'இதுவரை ஏற்றுமதிகள் இல்லை.', rowsLabel: 'வரிசைகள்', redactedLabel: 'மறைக்கப்பட்ட நெடுவரிசைகள்',
    importHeading: 'தரவை உள்ளே கொண்டு வா', importLead: 'எதை ஏற்றுகிறீர்கள் என்பதைத் தேர்ந்தெடுத்து, கோப்பை ஒட்டி, சரிபார்க்கவும். இரண்டாம் நபர் (நீங்கள் அல்ல) முழு வேலையையும் அனுமதிக்கும் வரை எதுவும் பயன்படுத்தப்படாது.',
    templateLabel: 'எதை ஏற்றுகிறீர்கள்', fileLabel: 'கோப்பு (முதல் வரிசை நெடுவரிசைப் பெயர்கள்)', filePlaceholder: 'sku,name,price\\nRICE5,அரிசி 5கிலோ,45000',
    totalLabel: 'அறிவிக்கப்பட்ட மொத்தம் (முழு பைசா, நிதி ஏற்றங்களுக்கு மட்டும்)', validateBtn: 'கோப்பைச் சரிபார்',
    jobLabel: 'இந்த ஏற்றத்திற்கு ஒரு பெயர்', approverLabel: 'அனுமதித்தவர் (இரண்டாம் நபர், நீங்கள் அல்ல)', commitBtn: 'ஏற்று',
    previewValid: 'ஏற்றத் தயார்', previewErrors: 'சிக்கல் உள்ள வரிசைகள்', previewDupes: 'ஏற்கனவே உள்ளன (மறுபரிசீலனைக்கு)',
    previewReconciles: 'மொத்தம் பொருந்துகிறது.', previewNotReconcile: 'வரிசைகள் அறிவிக்கப்பட்ட மொத்தத்துடன் கூடவில்லை.',
    previewReady: 'இந்தக் கோப்பு தயார் — இரண்டாம் நபர் அனுமதித்து ஏற்றலாம்.', previewNotReady: 'இந்தக் கோப்பு தயாராக இல்லை — மேலே உள்ள சிக்கல்களைச் சரிசெய்து மீண்டும் சரிபார்க்கவும்.',
    exported: 'ஏற்றுமதி செய்யப்பட்டது.', exportRefused: 'ஏற்றுமதி செய்ய முடியவில்லை — இந்தத் தரவுக்கு உங்களுக்கு அனுமதி இல்லாமல் இருக்கலாம்.', exportLostLink: 'இணைப்பு இல்லை — ஏற்றுமதி செய்யப்படவில்லை. மீண்டும் முயற்சிக்கவும்.',
    validateRefused: 'சரிபார்க்க முடியவில்லை — உங்களுக்கு அனுமதி இல்லை, அல்லது கோப்பைப் படிக்க முடியவில்லை.', validateLostLink: 'இணைப்பு இல்லை — சரிபார்க்க முடியவில்லை. மீண்டும் முயற்சிக்கவும்.',
    committed: 'ஏற்றப்பட்டது.', commitRefused: 'ஏற்ற முடியவில்லை — ஒவ்வொரு வரிசையும் சுத்தமாக இருக்க வேண்டும், நிதி ஏற்றம் கூட வேண்டும், இரண்டாம் நபர் (ஏற்றியவர் அல்ல) அனுமதிக்க வேண்டும் (§28).', commitLostLink: 'இணைப்பு இல்லை — ஏற்றப்படவில்லை. மீண்டும் முயற்சிக்கவும்.',
    noImport: 'தரவை இறக்குமதி செய்ய உங்களுக்கு அனுமதி இல்லை.', noCommit: 'நீங்கள் ஒரு கோப்பைச் சரிபார்க்கலாம், ஆனால் ஏற்ற அனுமதி உள்ள இரண்டாம் நபர் அனுமதித்து ஏற்ற வேண்டும் (§28).',
  },
};

export const COPY_KEYS: readonly CopyKey[] = Object.freeze(Object.keys(DATA_IO_COPY.en) as CopyKey[]);

// ── the presented shapes the view renders ────────────────────────────────────────────────────────────────

export interface PresentedDomain {
  readonly domain: string;
  readonly columns: readonly { readonly name: string; readonly sensitive: boolean }[];
  readonly sensitiveCount: number;
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

export interface DataIoSession {
  text(lang: Lang, key: CopyKey): string;
  exportPanel(lang: Lang): ExportPanelView;
  importPanel(): ImportPanelView;
  /** Run an export — refused locally without `export.read` before any POST. */
  runExport(domain: string): Promise<ExportResult>;
  /** Preview an import — refused locally without `purchase.import.read` or an unknown template. */
  validate(templateId: string, text: string, declaredTotalMinor?: number): Promise<ValidateResult>;
  /** Commit an import — refused locally without `purchase.import.record`, a job name, or a SEPARATE approver
   *  (§28: the approver may not be the uploader). The server re-validates and is the single gate. */
  commit(input: { templateId: string; text: string; jobId: string; approver: string; declaredTotalMinor?: number }): Promise<CommitResult>;
  presentExportResult(lang: Lang, r: ExportResult): StatusPresentation;
  presentValidateResult(lang: Lang, r: 'refused' | 'lost_link'): StatusPresentation;
  presentCommitResult(lang: Lang, r: CommitResult): StatusPresentation;
}

export function createDataIoSession(config: DataIoConfig, ports: DataIoPorts): DataIoSession {
  const text = (lang: Lang, key: CopyKey): string => translator(DATA_IO_COPY, lang)(key);

  const knownTemplate = (id: string): boolean => ports.importTemplates().some((t) => t.id === id);

  return {
    text,
    exportPanel: (lang) => {
      const t = translator(DATA_IO_COPY, lang);
      const mayExport = ports.mayExport();
      if (!mayExport) {
        return { screenState: presentScreenState({ state: 'locked', label: t('noExport') }), mayExport: false, domains: [], recent: [] };
      }
      const domains: PresentedDomain[] = ports.exportDomains().map((d) => ({
        domain: d.domain,
        columns: d.columns.map((c) => ({ name: c.name, sensitive: c.sensitive })),
        sensitiveCount: d.columns.filter((c) => c.sensitive).length,
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

    validate: async (templateId, text2, declaredTotalMinor) => {
      if (!ports.mayImport() || !knownTemplate(templateId) || text2.trim() === '') return 'refused';
      return ports.validate({ templateId, text: text2, ...(declaredTotalMinor !== undefined ? { declaredTotalMinor } : {}) });
    },

    // §28 is enforced by the engine on the server; the screen refuses the cheap things first — no permission,
    // no job name, no approver, or an approver who IS the uploader (a self-approval that would be refused).
    commit: async ({ templateId, text: text2, jobId, approver, declaredTotalMinor }) => {
      if (!ports.mayCommitImport() || !knownTemplate(templateId)) return 'refused';
      if (jobId.trim() === '' || approver.trim() === '' || text2.trim() === '') return 'refused';
      if (config.userId !== null && approver.trim() === config.userId) return 'refused'; // self-approval (§28)
      return ports.commit({ templateId, text: text2, jobId: jobId.trim(), approver: approver.trim(), ...(declaredTotalMinor !== undefined ? { declaredTotalMinor } : {}) });
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
    presentCommitResult: (lang, r) => {
      const t = translator(DATA_IO_COPY, lang);
      if (r === 'committed') return presentStatus({ tone: 'ok', icon: '✓', label: t('committed'), needsAttention: false });
      if (r === 'lost_link') return presentStatus({ tone: 'degraded', icon: '⚠', label: t('commitLostLink'), needsAttention: true });
      return presentStatus({ tone: 'error', icon: '✕', label: t('commitRefused'), needsAttention: true });
    },
  };
}
