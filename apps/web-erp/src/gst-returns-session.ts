// GST returns — the filing-status operator view (owner directive item 3, the 4th UI domain; API-09; M23).
// WP4 (item 1) built the GSTR-1 SUBMISSION-SAFETY state machine (`packages/finance/src/gstr1-submission.ts`)
// and wired it durably (`services/finance/src/gstr1-submission-store.ts`): preview → approve (maker ≠ checker)
// → submit → filed, with failed/unknown/cancelled branches and reconciliation. This is the screen a finance
// person uses to SEE the state of every filing period — which returns are filed, which are waiting for a
// second person to approve, which are ready to file, and — the point of the screen — which are STUCK: a
// portal rejection (failed) or an unresolved outcome (unknown) that needs a person to reconcile with evidence.
//
// Like every ERP screen, the rules live here in a tested, DOM-free session model on the shared packages/ui
// primitives (colour is never the only signal — an icon and a word ride with every tone) over the tested
// `packages/finance` submission engine (`queueCategory`/`isSubmissionException`); the shell only renders what
// this hands over. It shows what each period's return needs and, in plain language, the next step — AND lets an
// authorised person take the two governance steps that move a return toward filing: APPROVE a prepared return
// (by a checker who is NOT the maker — §28) and SUBMIT (file) an approved one. Acting NEVER calls the portal
// from the screen: the button commits a deterministic command to the offline OUTBOX (hard rule #1 — a user
// action never blocks on a network call), which the sync agent drains to the maker→checker API afterwards,
// where the engine re-checks maker ≠ checker, the digest match and the live-portal gate at the write boundary.
// A stuck return (failed/unknown) is NEVER given a one-click button — it is surfaced for a person to correct or
// reconcile with evidence, never resolved silently (hard rule #10). No AI is involved (hard rule #5).

// Imported from the specific engine module, NOT the packages/finance barrel: the barrel re-exports the
// GSTN sandbox, which uses `node:crypto` and would break the browser bundle. This screen needs only the pure
// submission lifecycle helpers.
import {
  queueCategory, isSubmissionException,
  type Gstr1SubmissionState, type Gstr1SubmissionQueueCategory,
} from '../../../packages/finance/src/gstr1-submission';
import { translator, presentScreenState, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { presentStatus, type StatusPresentation } from '../../../packages/a11y/src/signals';
import { makeEvent, type DomainEvent } from '../../../packages/contracts/src/event';
import type { SyncOutbox, OutboxState } from '../../../packages/sync/src/outbox';

/** One filing period's submission, as the box hands it over (a fold of the durable submission stream). */
export interface ReturnRow {
  /** The filing period, MMYYYY. */
  readonly period: string;
  readonly state: Gstr1SubmissionState;
  /** The portal reference (ARN) once filed. */
  readonly arn?: string;
  readonly detail?: string;
  /** Who prepared / approved it, when the box knows (shown, never invented). */
  readonly previewedBy?: string;
  readonly approvedBy?: string;
}

/** What the operator should do next about a return. `none` = filed or withdrawn, nothing needed. */
export type ReturnAction = 'none' | 'approve' | 'file' | 'wait' | 'refile' | 'reconcile';
export const RETURN_ACTIONS: readonly ReturnAction[] = ['none', 'approve', 'file', 'wait', 'refile', 'reconcile'];

/** The two one-click governance steps this screen can WIRE to a button (a subset of `ReturnAction`). */
export type GstReturnCommandAction = 'approve' | 'submit';
export const GST_RETURN_COMMAND_ACTIONS: readonly GstReturnCommandAction[] = ['approve', 'submit'];

/** The event type the outbox command carries — the return-filing write-path identity. */
export const GST_RETURN_ACTION_EVENT = 'GstReturnActionRequested';

/** The command payload the sync agent drains to the maker→checker API. PII-free — a period and an action. */
export interface GstReturnActionPayload {
  readonly period: string;
  readonly action: GstReturnCommandAction;
  /** Who asked — the authenticated operator, checked against the maker for approve (maker ≠ checker). */
  readonly requestedBy: string;
  /** The return's observed state when the request was made, so a re-request after it moves is distinct. */
  readonly observedState: Gstr1SubmissionState;
}
export type GstReturnCommand = DomainEvent<typeof GST_RETURN_ACTION_EVENT, GstReturnActionPayload>;

/**
 * The one-click command actions offerable for a submission state — and ONLY these. A PREPARED return can be
 * APPROVED (by a checker ≠ the maker); an APPROVED one can be SUBMITTED (filed). Everything else offers no
 * one-click button here: a stuck return (failed/unknown) is corrected or reconciled with EVIDENCE by a person
 * (hard rule #10), an in-flight one is waited on, and a filed/withdrawn one is terminal. Preview (needs the
 * assembled figures), reconcile (needs an evidence note) and cancel (needs a reason) are richer forms, not
 * one-click affordances — a later increment.
 */
export function commandActionsFor(state: Gstr1SubmissionState): readonly GstReturnCommandAction[] {
  switch (state) {
    case 'previewed': return ['approve'];
    case 'approved': return ['submit'];
    case 'submitting': case 'filed': case 'failed': case 'unknown': case 'cancelled': return [];
  }
}

/**
 * The dedupe identity of a return command. Keyed on the period, the action AND the observed state, so a
 * double-click or a reload collapses to one command (§31.1), while a genuine re-request after the return has
 * moved to a new state is a distinct, legitimate command.
 */
export function returnCommandKey(period: string, action: GstReturnCommandAction, observedState: Gstr1SubmissionState): string {
  return `gst-return|${action}|${period}|${observedState}`;
}

/** Build the (deterministic, PII-free) outbox command for a return action. `at` is the caller's clock. */
export function buildReturnCommand(input: {
  readonly period: string; readonly action: GstReturnCommandAction;
  readonly observedState: Gstr1SubmissionState; readonly requestedBy: string; readonly at: string;
}): GstReturnCommand {
  const key = returnCommandKey(input.period, input.action, input.observedState);
  return makeEvent({
    id: key, // one key ⇒ one command, so the idempotency key is a sound event id (a duplicate collapses)
    type: GST_RETURN_ACTION_EVENT,
    occurredAt: input.at,
    idempotencyKey: key,
    source: 'web-erp/gst-returns',
    payload: { period: input.period, action: input.action, requestedBy: input.requestedBy, observedState: input.observedState },
  });
}

/** The outcome of asking to run a return action — queued, or refused with a reason the shell can word. */
export type ReturnActionRefusal = 'not_permitted' | 'not_actionable' | 'already_queued' | 'unknown_period' | 'self_approval';
export type ReturnActionResult =
  | { readonly ok: true; readonly key: string; readonly state: OutboxState }
  | { readonly ok: false; readonly reason: ReturnActionRefusal };

export interface GstReturnsPorts {
  /** The filing periods the box last synced, each folded to its current submission state. */
  rows(): readonly ReturnRow[];
  /** Whether the user may read the filing queue (`finance.gstr.read`). */
  mayRead(): boolean;
  /** Whether the user may approve a prepared return (`finance.gstr.approve`). */
  mayApprove(): boolean;
  /** Whether the user may file (submit) an approved return (`finance.gstr.submit`). */
  maySubmit(): boolean;
  /**
   * The offline command queue this screen commits governance actions to (P-01, §31). Read to show which
   * returns already have a request in flight; written when the operator asks for one. A single injected
   * instance, so a queued command and its displayed state are the same truth.
   */
  outbox(): SyncOutbox;
}

export interface GstReturnsConfig {
  /** Who is looking. `null` means the box was not told — the screen says so. */
  readonly userId: string | null;
}

// ── the copy: ONE bilingual object for the whole screen (a guardrail binds to it) ────────────────────────

export type CopyKey =
  | 'title' | 'lead' | 'langName'
  | 'stPreviewed' | 'stApproved' | 'stSubmitting' | 'stFiled' | 'stFailed' | 'stUnknown' | 'stCancelled'
  | 'actNone' | 'actApprove' | 'actFile' | 'actWait' | 'actRefile' | 'actReconcile'
  | 'btnApprove' | 'btnSubmit'
  | 'needsApproveRole' | 'needsSubmitRole' | 'youPrepared'
  | 'queuedPending' | 'queuedSent' | 'queuedFailed'
  | 'arnLabel' | 'periodLabel' | 'preparedBy' | 'approvedByLabel'
  | 'attentionCount' | 'allClear'
  | 'stateReady' | 'stateEmpty' | 'stateNotPermitted'
  | 'nobodyNamed' | 'staleShell' | 'sampleData';

export const GST_RETURNS_COPY: BilingualCopy<CopyKey> = {
  en: {
    title: 'GST returns', langName: 'தமிழ்',
    lead: 'Every GSTR-1 filing period and what it needs next. The ones needing attention are first — a return the portal rejected, or one whose outcome is unknown and must be reconciled. Nothing is filed here; a stuck return is resolved by a person with evidence, never silently.',
    stPreviewed: 'Prepared — awaiting approval', stApproved: 'Approved — ready to file', stSubmitting: 'Being filed',
    stFiled: 'Filed', stFailed: 'Rejected by the portal', stUnknown: 'Outcome unknown — reconcile', stCancelled: 'Withdrawn before filing',
    actNone: 'Nothing — it is done', actApprove: 'A second person must approve it', actFile: 'File it to the portal',
    actWait: 'Wait — it is being filed', actRefile: 'Correct the figures and file again', actReconcile: 'A person must reconcile it with evidence — do NOT assume it is filed',
    btnApprove: 'Approve', btnSubmit: 'File to the portal',
    needsApproveRole: 'Needs the approve-returns role', needsSubmitRole: 'Needs the file-returns role',
    youPrepared: 'You prepared this — a different person must approve it',
    queuedPending: 'Requested — it will be sent when there is a connection.',
    queuedSent: 'Sent — the queue will refresh when it is done.',
    queuedFailed: 'Could not be sent — a person should check.',
    arnLabel: 'Portal reference', periodLabel: 'Period', preparedBy: 'Prepared by', approvedByLabel: 'Approved by',
    attentionCount: 'need attention', allClear: 'Every return is settled — nothing needs attention.',
    stateReady: 'Showing the filing periods', stateEmpty: 'No filing period has been started yet.',
    stateNotPermitted: 'You do not have permission to see the GST returns queue.',
    nobodyNamed: 'This store computer has not been told who is using this screen.',
    staleShell: 'No connection to the store computer. This page is what it was last told, at', sampleData: 'Sample data — this is not your shop.',
  },
  ta: {
    title: 'GST வருமானங்கள்', langName: 'English',
    lead: 'ஒவ்வொரு GSTR-1 தாக்கல் காலமும் அடுத்து என்ன தேவை என்பதும். கவனம் தேவைப்படுபவை முதலில் — போர்ட்டல் மறுத்த வருமானம், அல்லது முடிவு தெரியாத ஒன்று. இங்கு எதுவும் தாக்கல் செய்யப்படாது; சிக்கிய வருமானம் ஒருவரால் ஆதாரத்துடன் தீர்க்கப்படும், அமைதியாக அல்ல.',
    stPreviewed: 'தயாரிக்கப்பட்டது — ஒப்புதலுக்குக் காத்திருக்கிறது', stApproved: 'ஒப்புதல் — தாக்கல் செய்யத் தயார்', stSubmitting: 'தாக்கல் செய்யப்படுகிறது',
    stFiled: 'தாக்கல் செய்யப்பட்டது', stFailed: 'போர்ட்டல் மறுத்தது', stUnknown: 'முடிவு தெரியவில்லை — சரிபார்க்கவும்', stCancelled: 'தாக்கலுக்கு முன் திரும்பப்பெறப்பட்டது',
    actNone: 'எதுவும் இல்லை — முடிந்தது', actApprove: 'இரண்டாவது நபர் ஒப்புதல் அளிக்க வேண்டும்', actFile: 'போர்ட்டலில் தாக்கல் செய்யவும்',
    actWait: 'காத்திருங்கள் — தாக்கல் செய்யப்படுகிறது', actRefile: 'எண்களைச் சரிசெய்து மீண்டும் தாக்கல் செய்யவும்', actReconcile: 'ஒருவர் ஆதாரத்துடன் சரிபார்க்க வேண்டும் — தாக்கல் ஆனதாகக் கருத வேண்டாம்',
    btnApprove: 'ஒப்புதல்', btnSubmit: 'போர்ட்டலில் தாக்கல் செய்யவும்',
    needsApproveRole: 'ஒப்புதல் அளிக்கும் அனுமதி தேவை', needsSubmitRole: 'தாக்கல் செய்யும் அனுமதி தேவை',
    youPrepared: 'இதை நீங்கள் தயாரித்தீர்கள் — வேறு ஒருவர் ஒப்புதல் அளிக்க வேண்டும்',
    queuedPending: 'கோரப்பட்டது — இணைப்பு கிடைக்கும்போது அனுப்பப்படும்.',
    queuedSent: 'அனுப்பப்பட்டது — முடிந்ததும் வரிசை புதுப்பிக்கப்படும்.',
    queuedFailed: 'அனுப்ப முடியவில்லை — ஒருவர் சரிபார்க்க வேண்டும்.',
    arnLabel: 'போர்ட்டல் குறிப்பு', periodLabel: 'காலம்', preparedBy: 'தயாரித்தவர்', approvedByLabel: 'ஒப்புதல் அளித்தவர்',
    attentionCount: 'கவனம் தேவை', allClear: 'ஒவ்வொரு வருமானமும் தீர்க்கப்பட்டது — எதற்கும் கவனம் தேவையில்லை.',
    stateReady: 'தாக்கல் காலங்களைக் காட்டுகிறது', stateEmpty: 'இன்னும் எந்தத் தாக்கல் காலமும் தொடங்கப்படவில்லை.',
    stateNotPermitted: 'GST வருமானங்கள் வரிசையைப் பார்க்க உங்களுக்கு அனுமதி இல்லை.',
    nobodyNamed: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை.',
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:', sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
  },
};

export const COPY_KEYS: readonly CopyKey[] = Object.freeze(Object.keys(GST_RETURNS_COPY.en) as CopyKey[]);

/** Each lifecycle state → its status label copy key. */
export const STATE_LABEL: Readonly<Record<Gstr1SubmissionState, CopyKey>> = {
  previewed: 'stPreviewed', approved: 'stApproved', submitting: 'stSubmitting',
  filed: 'stFiled', failed: 'stFailed', unknown: 'stUnknown', cancelled: 'stCancelled',
};

/** Each recommended action → its copy key. */
export const ACTION_LABEL: Readonly<Record<ReturnAction, CopyKey>> = {
  none: 'actNone', approve: 'actApprove', file: 'actFile', wait: 'actWait', refile: 'actRefile', reconcile: 'actReconcile',
};

/** The face (tone + icon) each lifecycle state wears — colour is never the only signal. */
const STATE_FACE: Readonly<Record<Gstr1SubmissionState, { readonly tone: 'ok' | 'degraded' | 'error' | 'idle'; readonly icon: string }>> = {
  previewed: { tone: 'degraded', icon: '◔' },   // in progress — awaiting approval
  approved: { tone: 'degraded', icon: '◑' },    // in progress — ready to file
  submitting: { tone: 'degraded', icon: '…' },  // in flight
  filed: { tone: 'ok', icon: '✓' },             // done
  failed: { tone: 'error', icon: '✕' },         // rejected — an exception
  unknown: { tone: 'degraded', icon: '?' },     // unresolved — an exception
  cancelled: { tone: 'idle', icon: '⊘' },       // withdrawn — deliberate, not an error
};

/** What the operator should do next about a return in this state. Pure, total. */
export function recommendedAction(state: Gstr1SubmissionState): ReturnAction {
  switch (state) {
    case 'previewed': return 'approve';   // a second, different person must approve (maker ≠ checker)
    case 'approved': return 'file';       // locked to the approved figures — ready to file
    case 'submitting': return 'wait';     // in flight
    case 'failed': return 'refile';       // the portal rejected it — correct and re-file
    case 'unknown': return 'reconcile';   // no clear answer — reconcile with evidence (hard rule #10)
    case 'filed': case 'cancelled': return 'none';
  }
}

// ── the presented shapes the view renders ────────────────────────────────────────────────────────────

/** One clickable governance action on a return, already gated and with its queued state resolved. */
export interface PresentedReturnAction {
  readonly action: GstReturnCommandAction;
  readonly label: string;           // bilingual button text ("Approve" / "File to the portal")
  readonly period: string;
  /** The command's dedupe key — the shell passes the period + action back to `requestAction`, not this. */
  readonly key: string;
  /** Whether THIS user may run it (right role AND, for approve, not the maker). */
  readonly enabled: boolean;
  /** The queued state of this exact request, or `null` when nothing is queued for it yet. */
  readonly queued: OutboxState | null;
  /** A short bilingual note: needs-role, you-prepared-this, or the queued state — never in the dark (P-08). */
  readonly note?: string;
}

export interface PresentedReturn {
  readonly period: string;
  readonly category: Gstr1SubmissionQueueCategory;
  readonly status: StatusPresentation;
  readonly action: ReturnAction;
  readonly actionLabel: string;
  readonly needsAttention: boolean;
  /** The portal reference, present only once filed. */
  readonly arn?: string;
  readonly preparedBy?: string;
  readonly approvedByName?: string;
  readonly detail: string;
  /** The clickable governance actions (empty for the ones a person must handle — rule #10). */
  readonly actions: readonly PresentedReturnAction[];
}

export interface GstReturnsView {
  readonly screenState: StatusPresentation;
  readonly rows: readonly PresentedReturn[];
  readonly attentionCount: number;
  readonly total: number;
  readonly nobodyNamed: boolean;
}

export interface GstReturnsSession {
  /** One bilingual string. */
  text(lang: Lang, key: CopyKey): string;
  /** The whole screen, in the chosen language, with the ones needing attention first. */
  view(lang: Lang): GstReturnsView;
  /**
   * Ask to run a governance action on a return. Re-validates the guards the view used (right role, maker ≠
   * checker for approve, correct state, not already queued) so a stale button can never queue something the
   * model would not offer, then commits a deterministic command to the OUTBOX — never a network call (hard
   * rule #1); the engine re-checks everything at the API write boundary. `at` is the caller's clock.
   */
  requestAction(input: { period: string; action: GstReturnCommandAction; at: string }): ReturnActionResult;
}

export function createGstReturnsSession(config: GstReturnsConfig, ports: GstReturnsPorts): GstReturnsSession {
  const text = (lang: Lang, key: CopyKey): string => translator(GST_RETURNS_COPY, lang)(key);

  /** May THIS user run this action? approve needs the approve role AND a checker ≠ the maker; submit the file role. */
  const maySelfRun = (action: GstReturnCommandAction, row: ReturnRow): { readonly ok: boolean; readonly why?: CopyKey } => {
    if (config.userId === null) return { ok: false, why: 'needsApproveRole' }; // nobody named → cannot attribute
    if (action === 'approve') {
      if (!ports.mayApprove()) return { ok: false, why: 'needsApproveRole' };
      if (row.previewedBy !== undefined && row.previewedBy === config.userId) return { ok: false, why: 'youPrepared' };
      return { ok: true };
    }
    // submit
    if (!ports.maySubmit()) return { ok: false, why: 'needsSubmitRole' };
    return { ok: true };
  };

  const queuedNote = (t: (key: CopyKey) => string, state: OutboxState | null): string | undefined => {
    if (state === 'pending') return t('queuedPending');
    if (state === 'acknowledged') return t('queuedSent');
    if (state === 'dead_letter') return t('queuedFailed');
    return undefined;
  };

  const presentActions = (t: (key: CopyKey) => string, row: ReturnRow): PresentedReturnAction[] =>
    commandActionsFor(row.state).map((action) => {
      const key = returnCommandKey(row.period, action, row.state);
      const queued = ports.outbox().find(key)?.state ?? null;
      const may = maySelfRun(action, row);
      // The needs-role / you-prepared note wins over a queued note; else show the queued state.
      const note = may.ok ? queuedNote(t, queued) : t(may.why!);
      return {
        action,
        label: t(action === 'approve' ? 'btnApprove' : 'btnSubmit'),
        period: row.period,
        key,
        enabled: may.ok && queued === null,
        queued,
        ...(note !== undefined ? { note } : {}),
      };
    });

  const present = (lang: Lang, row: ReturnRow): PresentedReturn => {
    const t = translator(GST_RETURNS_COPY, lang);
    const face = STATE_FACE[row.state];
    const label = t(STATE_LABEL[row.state]);
    const needsAttention = isSubmissionException(row.state);
    const action = recommendedAction(row.state);
    return {
      period: row.period,
      category: queueCategory(row.state),
      status: presentStatus({ tone: face.tone, icon: face.icon, label, announcement: `${row.period}: ${label}`, needsAttention }),
      action,
      actionLabel: t(ACTION_LABEL[action]),
      needsAttention,
      ...(row.arn !== undefined ? { arn: row.arn } : {}),
      ...(row.previewedBy !== undefined ? { preparedBy: row.previewedBy } : {}),
      ...(row.approvedBy !== undefined ? { approvedByName: row.approvedBy } : {}),
      detail: row.detail ?? '',
      actions: presentActions(t, row),
    };
  };

  return {
    text,
    view: (lang) => {
      const t = translator(GST_RETURNS_COPY, lang);
      if (!ports.mayRead()) {
        return {
          screenState: presentScreenState({ state: 'error', label: t('stateNotPermitted') }),
          rows: [], attentionCount: 0, total: 0, nobodyNamed: config.userId === null,
        };
      }
      const raw = ports.rows();
      const rows = raw.map((r) => present(lang, r));
      // The ones needing attention first; within each, most recent filing period first (MMYYYY string order
      // is not chronological, so sort by the year then the month — a stable, sensible order for an operator).
      const ordered = [...rows].sort((a, b) => {
        if (a.needsAttention !== b.needsAttention) return a.needsAttention ? -1 : 1;
        return periodSortKey(b.period).localeCompare(periodSortKey(a.period));
      });
      const attentionCount = rows.filter((r) => r.needsAttention).length;
      const state = rows.length === 0 ? 'empty' : 'ready';
      return {
        screenState: presentScreenState({ state, label: t(state === 'empty' ? 'stateEmpty' : 'stateReady') }),
        rows: ordered,
        attentionCount,
        total: rows.length,
        nobodyNamed: config.userId === null,
      };
    },

    requestAction: (input) => {
      if (!ports.mayRead()) return { ok: false, reason: 'not_permitted' };
      const row = ports.rows().find((r) => r.period === input.period);
      if (row === undefined) return { ok: false, reason: 'unknown_period' };
      // The rule-#10 guard: a state that offers no button (submitting/filed/failed/unknown/cancelled) cannot
      // be acted on, even if a stale button somehow asked.
      if (!commandActionsFor(row.state).includes(input.action)) return { ok: false, reason: 'not_actionable' };
      const may = maySelfRun(input.action, row);
      if (!may.ok) return { ok: false, reason: may.why === 'youPrepared' ? 'self_approval' : 'not_permitted' };
      const key = returnCommandKey(input.period, input.action, row.state);
      if (ports.outbox().find(key) !== undefined) return { ok: false, reason: 'already_queued' };
      const item = ports.outbox().enqueue(buildReturnCommand({
        period: input.period, action: input.action, observedState: row.state,
        requestedBy: config.userId!, at: input.at,
      }));
      return { ok: true, key, state: item.state };
    },
  };
}

/** MMYYYY → YYYYMM so string comparison sorts chronologically; a malformed period sorts last. */
function periodSortKey(period: string): string {
  return /^\d{6}$/.test(period) ? `${period.slice(2)}${period.slice(0, 2)}` : '000000';
}
