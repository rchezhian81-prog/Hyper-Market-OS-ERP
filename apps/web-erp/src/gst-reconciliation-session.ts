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
// This is a READ / TRIAGE surface first, but an operator can also ACT on the two portal-touching routes it
// identifies — poll (chase up a stuck document) and verify (re-check a settled one against the portal), the
// item-2 API routes gated `finance.einvoice.generate`. Acting NEVER calls the portal from here: the button
// commits a deterministic command to the offline OUTBOX (hard rule #1 — a user action never blocks on a
// network call), which the sync agent drains idempotently to the API command path afterwards. Two documents
// are NEVER given an action button: a disagreement (`mismatch`) and a bad signature (`error`) — a person must
// investigate those and they are never auto-corrected from this screen (hard rule #10). No AI is involved; the
// command is deterministic (hard rule #5 does not even arise). So nothing is silently changed from here.

import {
  translator, presentQueueCategory, presentScreenState,
  type BilingualCopy, type Lang, type QueueCategory,
} from '../../../packages/ui/src/index';
import type { StatusPresentation } from '../../../packages/a11y/src/signals';
import { makeEvent, type DomainEvent } from '../../../packages/contracts/src/event';
import type { SyncOutbox, OutboxState } from '../../../packages/sync/src/outbox';

/** Which document a queue row is. */
export type DocumentType = 'e_invoice' | 'e_way_bill';
export const DOCUMENT_TYPES: readonly DocumentType[] = ['e_invoice', 'e_way_bill'];

/** What the operator should do about a row. `none` = done, nothing needed. */
export type RecommendedAction = 'none' | 'poll' | 'verify' | 'reissue' | 'investigate' | 'wait';
export const RECOMMENDED_ACTIONS: readonly RecommendedAction[] = ['none', 'poll', 'verify', 'reissue', 'investigate', 'wait'];

/** The two portal-touching actions this screen can WIRE to a button (a subset of `RecommendedAction`). */
export type GstPortalAction = 'poll' | 'verify';
export const GST_PORTAL_ACTIONS: readonly GstPortalAction[] = ['poll', 'verify'];

/** The event type the outbox command carries — the reconciliation queue's write-path identity. */
export const GST_PORTAL_ACTION_EVENT = 'GstPortalActionRequested';

/** The command payload the sync agent drains to the item-2 API command path. PII-free — an id and an action. */
export interface GstPortalActionPayload {
  readonly documentType: DocumentType;
  readonly id: string;
  readonly action: GstPortalAction;
  /** Who asked — the authenticated operator, so the request is attributable a year later. */
  readonly requestedBy: string;
  /** The row's observed category when the request was made, so a re-request after the state moves is distinct. */
  readonly observedCategory: QueueCategory;
}
export type GstPortalCommand = DomainEvent<typeof GST_PORTAL_ACTION_EVENT, GstPortalActionPayload>;

/**
 * The portal actions offerable for a queue category — and ONLY these. A stuck document (`unknown`) can be
 * CHASED UP (poll); a settled one (registered/generated/cancelled) can be RE-CHECKED against the portal
 * (verify). A disagreement (`mismatch`) or a bad signature (`error`) is NEVER a button — a person investigates
 * it and it is never auto-corrected (hard rule #10). A rejected document needs a fix-and-reissue workflow, not
 * a one-click portal call; an in-flight one (`processing`) is simply waited on.
 */
export function portalActionsFor(category: QueueCategory): readonly GstPortalAction[] {
  switch (category) {
    case 'unknown': return ['poll'];
    case 'registered': case 'generated': case 'cancelled': return ['verify'];
    case 'processing': case 'rejected': case 'error': case 'mismatch': return [];
  }
}

/**
 * The dedupe identity of a portal command. Keyed on the document, the action AND the observed category, so a
 * double-click or a reload collapses to one command (§31.1), while a genuine re-request after the portal has
 * moved the document to a new state is a distinct, legitimate command.
 */
export function portalCommandKey(documentType: DocumentType, id: string, action: GstPortalAction, observedCategory: QueueCategory): string {
  return `gst-portal|${action}|${documentType}|${id}|${observedCategory}`;
}

/** Build the (deterministic, PII-free) outbox command for a portal action. `at` is the caller's clock. */
export function buildPortalCommand(input: {
  readonly documentType: DocumentType; readonly id: string; readonly action: GstPortalAction;
  readonly observedCategory: QueueCategory; readonly requestedBy: string; readonly at: string;
}): GstPortalCommand {
  const key = portalCommandKey(input.documentType, input.id, input.action, input.observedCategory);
  return makeEvent({
    id: key, // one key ⇒ one command, so the idempotency key is a sound event id (a duplicate collapses)
    type: GST_PORTAL_ACTION_EVENT,
    occurredAt: input.at,
    idempotencyKey: key,
    source: 'web-erp/gst-reconciliation',
    payload: {
      documentType: input.documentType, id: input.id, action: input.action,
      requestedBy: input.requestedBy, observedCategory: input.observedCategory,
    },
  });
}

/** The outcome of asking to run a portal action — queued, or refused with a reason the shell can word. */
export type PortalActionRefusal = 'not_permitted' | 'not_actionable' | 'already_queued' | 'unknown_row';
export type PortalActionResult =
  | { readonly ok: true; readonly key: string; readonly state: OutboxState }
  | { readonly ok: false; readonly reason: PortalActionRefusal };

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
  /**
   * The offline command queue this screen commits portal actions to (P-01, §31). Read to show which rows
   * already have a request in flight; written when the operator asks for one. A single injected instance, so
   * a queued command and its displayed state are the same truth.
   */
  outbox(): SyncOutbox;
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
  | 'queuedPending' | 'queuedSent' | 'queuedFailed'
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
    queuedPending: 'Requested — it will be sent to the portal when there is a connection.',
    queuedSent: 'Sent to the portal — the answer will appear when the queue next refreshes.',
    queuedFailed: 'Could not be sent — a person should check.',
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
    queuedPending: 'கோரப்பட்டது — இணைப்பு கிடைக்கும்போது போர்ட்டலுக்கு அனுப்பப்படும்.',
    queuedSent: 'போர்ட்டலுக்கு அனுப்பப்பட்டது — வரிசை புதுப்பிக்கும்போது பதில் தோன்றும்.',
    queuedFailed: 'அனுப்ப முடியவில்லை — ஒருவர் சரிபார்க்க வேண்டும்.',
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

/** One clickable portal action on a row, already gated and with its queued state resolved for the shell. */
export interface PresentedAction {
  readonly action: GstPortalAction;
  readonly label: string;           // bilingual button text ("Chase up the portal" / "Re-check against the portal")
  readonly documentType: DocumentType;
  readonly id: string;
  /** The command's dedupe key — the shell passes the identity back to `requestAction`, not this. */
  readonly key: string;
  /** Whether THIS user may run it (`finance.einvoice.generate`). */
  readonly permitted: boolean;
  /** The queued state of this exact request, or `null` when nothing is queued for it yet. */
  readonly queued: OutboxState | null;
  /** Clickable only when permitted AND nothing is already queued for it (one effect per observed state). */
  readonly enabled: boolean;
  /** A short bilingual note: needs-role, or the queued state — so the operator is never in the dark (P-08). */
  readonly note?: string;
}

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
  /** The clickable portal actions for this row (empty for the ones a person must handle — rule #10). */
  readonly actions: readonly PresentedAction[];
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
  /**
   * Ask to run a portal action on a row. Re-validates the guards the view used (permitted, actionable, not
   * already queued) so a stale button can never queue something the model would not offer, then commits a
   * deterministic command to the OUTBOX — never a network call (hard rule #1). `at` is the caller's clock.
   */
  requestAction(input: { documentType: DocumentType; id: string; action: GstPortalAction; at: string }): PortalActionResult;
}

export function createGstReconciliationSession(config: GstReconciliationConfig, ports: GstReconciliationPorts): GstReconciliationSession {
  const text = (lang: Lang, key: CopyKey): string => translator(GST_RECON_COPY, lang)(key);

  /** The queued state of a request, and the note that words it — needs-role wins over any queued state. */
  const queuedNote = (t: (key: CopyKey) => string, permitted: boolean, state: OutboxState | null): string | undefined => {
    if (!permitted) return t('needsRole');
    if (state === 'pending') return t('queuedPending');
    if (state === 'acknowledged') return t('queuedSent');
    if (state === 'dead_letter') return t('queuedFailed');
    return undefined;
  };

  const presentActions = (t: (key: CopyKey) => string, row: QueueRow): PresentedAction[] => {
    const permitted = ports.mayAct();
    return portalActionsFor(row.category).map((action) => {
      const key = portalCommandKey(row.documentType, row.id, action, row.category);
      const queued = ports.outbox().find(key)?.state ?? null;
      return {
        action,
        label: t(ACTION_LABEL[action]),
        documentType: row.documentType,
        id: row.id,
        key,
        permitted,
        queued,
        enabled: permitted && queued === null,
        ...(queuedNote(t, permitted, queued) !== undefined ? { note: queuedNote(t, permitted, queued)! } : {}),
      };
    });
  };

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
      actions: presentActions(t, row),
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

    requestAction: (input) => {
      // Without a named operator we cannot attribute the request, and the screen is read-only in that state.
      if (config.userId === null || !ports.mayRead()) return { ok: false, reason: 'not_permitted' };
      const row = ports.rows().find((r) => r.documentType === input.documentType && r.id === input.id);
      if (row === undefined) return { ok: false, reason: 'unknown_row' };
      // The rule-#10 guard: a category that offers no button (mismatch/error/rejected/processing) cannot be
      // acted on, even if a stale button somehow asked. verify is only for terminal, poll only for stuck.
      if (!portalActionsFor(row.category).includes(input.action)) return { ok: false, reason: 'not_actionable' };
      if (!ports.mayAct()) return { ok: false, reason: 'not_permitted' };
      const key = portalCommandKey(input.documentType, input.id, input.action, row.category);
      const existing = ports.outbox().find(key);
      if (existing !== undefined) return { ok: false, reason: 'already_queued' };
      const item = ports.outbox().enqueue(buildPortalCommand({
        documentType: input.documentType, id: input.id, action: input.action,
        observedCategory: row.category, requestedBy: config.userId, at: input.at,
      }));
      return { ok: true, key, state: item.state };
    },
  };
}
