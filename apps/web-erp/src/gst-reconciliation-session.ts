// GST e-invoice / e-way-bill RECONCILIATION — the operator triage view (owner directive item 3 inc2;
// API-09; A20/A23). Item 2 built the durable registers and their reconciliation tools — the exception
// queue, poll (acknowledgement recovery), verify (mismatch detection). This is the screen a person uses to
// WORK that queue: which documents are done, which are stuck, which the portal has rejected, and which now
// DISAGREE with the portal (a mismatch) — and, for each, what to do and whether this user may do it.
//
// Like every ERP screen, all the rules live here in a tested, DOM-free session model; the shell
// (`apps/web-erp/web/gst-reconciliation.js`) only renders what this hands it. It is built on the shared
// `packages/ui` primitives so the status colours, the screen states and the bilingual copy are the same
// vocabulary every other screen will use — colour is never the only signal (a word + an icon always ride
// with it), and the whole screen's copy is ONE `BilingualCopy` a guardrail binds to.
//
// This is a READ / TRIAGE surface: it decides what NEEDS doing and whether the person may do it. It does
// not itself call the portal — poll and verify are the item-2 API routes, gated `finance.einvoice.generate`;
// wiring a button to them (through the box's command path) is a later increment. So a document is never
// silently changed from this screen, and a mismatch is surfaced for a human, never auto-corrected (rule #10).

import {
  translator, presentQueueCategory, presentScreenState,
  type BilingualCopy, type Lang, type QueueCategory,
} from '../../../packages/ui/src/index';
import type { StatusPresentation } from '../../../packages/a11y/src/signals';

/** Which document a queue row is. */
export type DocumentType = 'e_invoice' | 'e_way_bill';
export const DOCUMENT_TYPES: readonly DocumentType[] = ['e_invoice', 'e_way_bill'];

/** What the operator should do about a row. `none` = done, nothing needed. */
export type RecommendedAction = 'none' | 'poll' | 'verify' | 'reissue' | 'investigate' | 'wait';
export const RECOMMENDED_ACTIONS: readonly RecommendedAction[] = ['none', 'poll', 'verify', 'reissue', 'investigate', 'wait'];

/** One row of the reconciliation queue as the box hands it over (a fold of the item-2 register). */
export interface QueueRow {
  readonly documentType: DocumentType;
  /** The invoice or movement id. */
  readonly id: string;
  readonly category: QueueCategory;
  /** The IRN / EWB number on file, when there is one. */
  readonly number?: string;
  readonly detail?: string;
  /** Present when a re-query disagreed with the stored number (item 2 inc4) — surfaced, never applied. */
  readonly mismatch?: { readonly observedState: string; readonly observedNumber?: string; readonly note: string };
}

export interface GstReconciliationPorts {
  /** The queue snapshot the box last synced (both documents). */
  rows(): readonly QueueRow[];
  /** Whether the user may read the queue at all (`finance.einvoice.read`). */
  mayRead(): boolean;
  /** Whether the user may run a portal action — poll / verify (`finance.einvoice.generate`). */
  mayAct(): boolean;
}

export interface GstReconciliationConfig {
  /** Who is looking. `null` means the box was not told — the queue is read-only and says so. */
  readonly userId: string | null;
}

// ── the copy: ONE bilingual object for the whole screen (the guardrail binds to it) ──────────────────

export type CopyKey =
  | 'title' | 'lead' | 'langName'
  | 'colDocument' | 'colNumber' | 'colStatus' | 'colAction'
  | 'docEInvoice' | 'docEWayBill' | 'noNumber'
  | 'catRegistered' | 'catGenerated' | 'catProcessing' | 'catRejected' | 'catUnknown' | 'catError' | 'catCancelled' | 'catMismatch'
  | 'actNone' | 'actPoll' | 'actVerify' | 'actReissue' | 'actInvestigate' | 'actWait'
  | 'mayAct' | 'needsRole' | 'attentionCount' | 'allClear'
  | 'stateReady' | 'stateEmpty' | 'stateError' | 'stateNotPermitted'
  | 'mismatchNote' | 'nobodyNamed' | 'staleShell' | 'sampleData';

export const GST_RECON_COPY: BilingualCopy<CopyKey> = {
  en: {
    title: 'GST reconciliation',
    lead: 'Every e-invoice and e-way bill, and what it needs. The ones needing attention are first. Nothing here changes a document — a stuck one is chased up and a disagreement is investigated by a person.',
    langName: 'தமிழ்',
    colDocument: 'Document', colNumber: 'Number', colStatus: 'Status', colAction: 'What to do',
    docEInvoice: 'E-invoice', docEWayBill: 'E-way bill', noNumber: 'no number yet',
    catRegistered: 'Registered', catGenerated: 'Generated', catProcessing: 'Being processed',
    catRejected: 'Rejected by the portal', catUnknown: 'Unknown — the portal did not answer',
    catError: 'Portal error', catCancelled: 'Cancelled', catMismatch: 'Portal disagrees',
    actNone: 'Nothing — it is done', actPoll: 'Chase up the portal', actVerify: 'Re-check against the portal',
    actReissue: 'Fix and issue again', actInvestigate: 'A person must investigate — do NOT issue again',
    actWait: 'Wait — it is still in progress',
    mayAct: 'You can do this', needsRole: 'Needs the GST-portal role',
    attentionCount: 'need attention', allClear: 'Everything is settled — nothing needs attention.',
    stateReady: 'Showing the queue', stateEmpty: 'There are no documents in the queue yet.',
    stateError: 'The queue could not be read.', stateNotPermitted: 'You do not have permission to see the GST reconciliation queue.',
    mismatchNote: 'The portal now shows something different from what is on file. Do not re-issue — investigate first.',
    nobodyNamed: 'This store computer has not been told who is using this screen, so the queue is read-only.',
    staleShell: 'No connection to the store computer. This page is what it was last told, at',
    sampleData: 'Sample data — this is not your shop.',
  },
  ta: {
    title: 'GST சரிபார்ப்பு',
    lead: 'ஒவ்வொரு மின்-விலைப்பட்டியல் மற்றும் மின்-வழிச்சீட்டு, அதற்கு என்ன தேவை என்பதும். கவனம் தேவைப்படுபவை முதலில். இங்கு எந்த ஆவணமும் மாற்றப்படாது — சிக்கியது பின்தொடரப்படும், முரண்பாடு ஒருவரால் விசாரிக்கப்படும்.',
    langName: 'English',
    colDocument: 'ஆவணம்', colNumber: 'எண்', colStatus: 'நிலை', colAction: 'என்ன செய்ய வேண்டும்',
    docEInvoice: 'மின்-விலைப்பட்டியல்', docEWayBill: 'மின்-வழிச்சீட்டு', noNumber: 'இன்னும் எண் இல்லை',
    catRegistered: 'பதிவு செய்யப்பட்டது', catGenerated: 'உருவாக்கப்பட்டது', catProcessing: 'செயலாக்கப்படுகிறது',
    catRejected: 'போர்ட்டல் மறுத்தது', catUnknown: 'தெரியவில்லை — போர்ட்டல் பதிலளிக்கவில்லை',
    catError: 'போர்ட்டல் பிழை', catCancelled: 'ரத்து செய்யப்பட்டது', catMismatch: 'போர்ட்டல் முரண்படுகிறது',
    actNone: 'எதுவும் இல்லை — முடிந்தது', actPoll: 'போர்ட்டலைப் பின்தொடரவும்', actVerify: 'போர்ட்டலுடன் மீண்டும் சரிபார்க்கவும்',
    actReissue: 'சரிசெய்து மீண்டும் வழங்கவும்', actInvestigate: 'ஒருவர் விசாரிக்க வேண்டும் — மீண்டும் வழங்க வேண்டாம்',
    actWait: 'காத்திருங்கள் — இன்னும் நடந்து கொண்டிருக்கிறது',
    mayAct: 'நீங்கள் இதைச் செய்யலாம்', needsRole: 'GST-போர்ட்டல் அனுமதி தேவை',
    attentionCount: 'கவனம் தேவை', allClear: 'அனைத்தும் தீர்க்கப்பட்டன — எதற்கும் கவனம் தேவையில்லை.',
    stateReady: 'வரிசையைக் காட்டுகிறது', stateEmpty: 'வரிசையில் இன்னும் ஆவணங்கள் இல்லை.',
    stateError: 'வரிசையைப் படிக்க முடியவில்லை.', stateNotPermitted: 'GST சரிபார்ப்பு வரிசையைப் பார்க்க உங்களுக்கு அனுமதி இல்லை.',
    mismatchNote: 'கோப்பில் உள்ளதைவிட போர்ட்டல் இப்போது வேறு ஒன்றைக் காட்டுகிறது. மீண்டும் வழங்க வேண்டாம் — முதலில் விசாரிக்கவும்.',
    nobodyNamed: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை, எனவே வரிசை படிக்க மட்டுமே.',
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:',
    sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
  },
};

export const COPY_KEYS: readonly CopyKey[] = Object.freeze(Object.keys(GST_RECON_COPY.en) as CopyKey[]);

/** The category → its copy key, so the view's status label is bilingual and guardrail-covered. */
export const CATEGORY_LABEL: Readonly<Record<QueueCategory, CopyKey>> = {
  registered: 'catRegistered', generated: 'catGenerated', processing: 'catProcessing',
  rejected: 'catRejected', unknown: 'catUnknown', error: 'catError', cancelled: 'catCancelled', mismatch: 'catMismatch',
};

/** The recommended action → its copy key. */
export const ACTION_LABEL: Readonly<Record<RecommendedAction, CopyKey>> = {
  none: 'actNone', poll: 'actPoll', verify: 'actVerify', reissue: 'actReissue', investigate: 'actInvestigate', wait: 'actWait',
};

/** What to do about a category. Exceptions get a real action; the settled ones need nothing. */
export function recommendedAction(category: QueueCategory): RecommendedAction {
  switch (category) {
    case 'unknown': return 'poll';        // acknowledgement recovery
    case 'rejected': return 'reissue';    // the portal refused it — fix and re-issue
    case 'error': return 'investigate';   // a signature/number that did not verify
    case 'mismatch': return 'investigate'; // the portal disagrees — never auto-corrected (rule #10)
    case 'processing': return 'wait';     // in-flight
    case 'registered': case 'generated': case 'cancelled': return 'none';
  }
}

/** Do poll/verify need the portal role? Only the two that actually touch the portal. */
function actionTouchesPortal(action: RecommendedAction): boolean {
  return action === 'poll' || action === 'verify';
}

// ── the presented shapes the view renders ────────────────────────────────────────────────────────────

export interface PresentedRow {
  readonly documentType: DocumentType;
  readonly documentLabel: string;
  readonly id: string;
  readonly number: string;          // the number, or the "no number yet" phrase
  readonly status: StatusPresentation; // tone + label + icon + announcement + needsAttention (translated)
  readonly action: RecommendedAction;
  readonly actionLabel: string;
  readonly needsAttention: boolean;
  /** Whether THIS user may run the action (only meaningful when it touches the portal). */
  readonly permitted: boolean;
  readonly permissionNote?: string;  // "needs the GST-portal role", when they may not
  readonly detail: string;
  readonly mismatchNote?: string;
}

export interface ReconciliationView {
  readonly screenState: StatusPresentation;
  readonly rows: readonly PresentedRow[];
  readonly attentionCount: number;
  readonly total: number;
  readonly mayAct: boolean;
  readonly nobodyNamed: boolean;
}

export interface GstReconciliationSession {
  /** One bilingual string. */
  text(lang: Lang, key: CopyKey): string;
  /** The whole screen, in the chosen language, with the ones needing attention first. */
  view(lang: Lang): ReconciliationView;
}

export function createGstReconciliationSession(config: GstReconciliationConfig, ports: GstReconciliationPorts): GstReconciliationSession {
  const text = (lang: Lang, key: CopyKey): string => translator(GST_RECON_COPY, lang)(key);

  const presentRow = (lang: Lang, row: QueueRow): PresentedRow => {
    const t = translator(GST_RECON_COPY, lang);
    const status = presentQueueCategory({ category: row.category, label: t(CATEGORY_LABEL[row.category]) });
    const action = recommendedAction(row.category);
    const permitted = actionTouchesPortal(action) ? ports.mayAct() : true;
    return {
      documentType: row.documentType,
      documentLabel: t(row.documentType === 'e_invoice' ? 'docEInvoice' : 'docEWayBill'),
      id: row.id,
      number: row.number ?? t('noNumber'),
      status,
      action,
      actionLabel: t(ACTION_LABEL[action]),
      needsAttention: status.needsAttention,
      permitted,
      ...(actionTouchesPortal(action) && !permitted ? { permissionNote: t('needsRole') } : {}),
      detail: row.detail ?? '',
      ...(row.mismatch !== undefined ? { mismatchNote: t('mismatchNote') } : {}),
    };
  };

  return {
    text,
    view: (lang) => {
      const t = translator(GST_RECON_COPY, lang);
      if (!ports.mayRead()) {
        return {
          screenState: presentScreenState({ state: 'error', label: t('stateNotPermitted') }),
          rows: [], attentionCount: 0, total: 0, mayAct: false, nobodyNamed: config.userId === null,
        };
      }
      const raw = ports.rows();
      const rows = raw.map((r) => presentRow(lang, r));
      // The ones needing attention first; within each, a stable order by document then id.
      const ordered = [...rows].sort((a, b) => {
        if (a.needsAttention !== b.needsAttention) return a.needsAttention ? -1 : 1;
        return `${a.documentType}|${a.id}`.localeCompare(`${b.documentType}|${b.id}`);
      });
      const attentionCount = rows.filter((r) => r.needsAttention).length;
      const state = rows.length === 0 ? 'empty' : 'ready';
      return {
        screenState: presentScreenState({ state, label: t(state === 'empty' ? 'stateEmpty' : 'stateReady') }),
        rows: ordered,
        attentionCount,
        total: rows.length,
        mayAct: ports.mayAct(),
        nobodyNamed: config.userId === null,
      };
    },
  };
}
