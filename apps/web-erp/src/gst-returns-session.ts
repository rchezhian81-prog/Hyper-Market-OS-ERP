// GST returns — the GSTR-1 filing list and its maker-checker (owner directive item 3; API-09; M23).
// WP4 (item 1) built the GSTR-1 SUBMISSION-SAFETY state machine (`packages/finance/src/gstr1-submission.ts`) and wired it
// durably (`services/finance/src/gstr1-submission-store.ts`): preview → approve (maker ≠ checker) → submit → filed, with
// failed / unknown / cancelled branches and reconciliation. This is the screen a finance person uses to SEE every filing
// period — filed, waiting for a second person, ready — and the ones STUCK (a portal rejection, an unknown outcome).
//
// W5 (route audit rows 161–167): the Approve and File clicks used to commit a `GstReturnActionRequested` command to a
// browser outbox that nothing ever sent on — and the store computer's sync agent deliberately has NO relay route for it
// (relaying under the store's own token would approve as the STORE, not the person who clicked, breaking maker ≠ checker,
// §28). So "Approve" never reached head office. Roadmap §31 puts this work under "Purchase/finance/admin — generally
// online … no unsafe stale approval/period mutation", and every act here is head office's to allow or refuse. So the
// session now reads the filing list LIVE from head office (GET /v1/finance/gstr1/submissions, then each period) and sends
// each act straight to head office's own maker-checker routes, under the signed-in person's own session:
//   • prepare (the maker records head office's own digest of the month's figures — POST …/preview);
//   • approve (a DIFFERENT person — POST …/approve);  • withdraw with a reason (POST …/cancel);
//   • reconcile an unknown outcome WITH EVIDENCE (POST …/reconcile, hard rule #10).
// Exactly once: each act carries an idempotency key that is KEPT while head office's answer is lost (a retry is the same
// act, which the kernel answers once) and dropped on a definite answer; a second click while one is on its way sends
// nothing. With head office out of reach nothing is approved and nothing is queued — the page says so. Filing to the
// portal stays OFF (live filing is externally blocked; the sandbox would put a pretend acknowledgement on the shop's real
// record), so "File" is shown switched off and is never sent. No AI is involved (hard rule #5).

// Imported from the specific engine module, NOT the packages/finance barrel: the barrel re-exports the GSTN sandbox, which
// uses `node:crypto` and would break the browser bundle.
import {
  queueCategory, isSubmissionException,
  type Gstr1SubmissionState, type Gstr1SubmissionQueueCategory,
} from '../../../packages/finance/src/gstr1-submission';
import { translator, presentScreenState, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { presentStatus, type StatusPresentation } from '../../../packages/a11y/src/signals';

/** One filing period's submission, as head office answers it (or the box last copied it). */
export interface ReturnRow {
  /** The filing period, MMYYYY. */
  readonly period: string;
  readonly state: Gstr1SubmissionState;
  /** The portal reference (ARN) once filed. */
  readonly arn?: string;
  readonly detail?: string;
  /** Who prepared / approved it, when known (shown, never invented). */
  readonly previewedBy?: string;
  readonly approvedBy?: string;
}

/** What the operator should do next about a return. `none` = filed or withdrawn, nothing needed. */
export type ReturnAction = 'none' | 'approve' | 'file' | 'wait' | 'refile' | 'reconcile';
export const RETURN_ACTIONS: readonly ReturnAction[] = ['none', 'approve', 'file', 'wait', 'refile', 'reconcile'];

/** The governance acts a row can offer. `submit` is always shown switched off (live filing is blocked). */
export type GstReturnCommandAction = 'approve' | 'submit' | 'cancel' | 'reconcile';
export const GST_RETURN_COMMAND_ACTIONS: readonly GstReturnCommandAction[] = ['approve', 'submit', 'cancel', 'reconcile'];

/**
 * The acts offerable for a submission state — and ONLY these, as head office's state machine allows them. A PREPARED
 * return can be approved (by a checker ≠ the maker) or withdrawn with a reason; an APPROVED one can be withdrawn (filing it
 * is switched off); an UNKNOWN outcome is reconciled by a person WITH EVIDENCE (hard rule #10). A rejected one is prepared
 * again, an in-flight one waited on, a filed or withdrawn one is terminal.
 */
export function commandActionsFor(state: Gstr1SubmissionState): readonly GstReturnCommandAction[] {
  switch (state) {
    case 'previewed': return ['approve', 'cancel'];
    case 'approved': return ['submit', 'cancel'];
    case 'unknown': return ['reconcile'];
    case 'submitting': case 'filed': case 'failed': case 'cancelled': return [];
  }
}

/** What head office answered a call — a definite answer, or none at all (the link was lost: nothing is known). */
export type HeadOfficeAnswer =
  | { readonly kind: 'ok'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'refused'; readonly status: number; readonly code: string; readonly whatHappened: string; readonly nextSafeAction: string }
  | { readonly kind: 'lost' };

/** One same-origin call to head office under the signed-in person's own session. `key` rides as the idempotency key. */
export type HeadOfficeCall = (method: 'GET' | 'POST', path: string, body?: unknown, key?: string) => Promise<HeadOfficeAnswer>;

/** A same-origin `HeadOfficeCall` over `fetch` — the one the page uses. */
export function headOfficeOverFetch(http: typeof globalThis.fetch): HeadOfficeCall {
  return async (method, path, body, key) => {
    try {
      const res = await http(path, {
        method, credentials: 'same-origin',
        headers: { accept: 'application/json', ...(method === 'POST' ? { 'content-type': 'application/json', ...(key === undefined ? {} : { 'idempotency-key': key }) } : {}) },
        ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.ok) return { kind: 'ok', status: res.status, body: json };
      // A gateway that never reached head office (502/503/504 with no head-office error) is a lost link, not an answer.
      const err = (json['error'] ?? undefined) as { code?: string; whatHappened?: string; nextSafeAction?: string } | undefined;
      if (err === undefined && res.status >= 502 && res.status <= 504) return { kind: 'lost' };
      return { kind: 'refused', status: res.status, code: err?.code ?? String(res.status), whatHappened: err?.whatHappened ?? `status ${res.status}`, nextSafeAction: err?.nextSafeAction ?? '' };
    } catch {
      return { kind: 'lost' };
    }
  };
}

/** Why an act was not sent — said before anything leaves the page. */
export type ReturnActionRefusal = 'not_permitted' | 'not_actionable' | 'already_sending' | 'unknown_period' | 'self_approval'
  | 'filing_off' | 'needs_reason' | 'needs_evidence' | 'not_live' | 'bad_period';
export type ReturnActionResult =
  | { readonly ok: true; readonly action: GstReturnCommandAction | 'preview'; readonly period: string; readonly state?: Gstr1SubmissionState }
  | { readonly ok: false; readonly reason: ReturnActionRefusal }
  | { readonly ok: false; readonly reason: 'refused'; readonly whatHappened: string; readonly nextSafeAction: string }
  | { readonly ok: false; readonly reason: 'lost' };

/** What an act carries beyond the period: a withdrawal's reason; a reconciliation's resolution, evidence and ARN. */
export interface ReturnActInput {
  readonly period: string;
  readonly action: GstReturnCommandAction;
  readonly reason?: string;
  readonly resolvedState?: 'filed' | 'failed';
  readonly note?: string;
  readonly arn?: string;
}

export interface GstReturnsPorts {
  /** The filing periods the box last copied — shown only while head office cannot be read, and never acted on. */
  rows(): readonly ReturnRow[];
  /** Whether the user may read the filing list (`finance.gstr.read`). */
  mayRead(): boolean;
  /** Whether the user may approve or withdraw a prepared return (`finance.gstr.approve`). */
  mayApprove(): boolean;
  /** Whether the user may file (and so reconcile) a return (`finance.gstr.submit`). */
  maySubmit(): boolean;
  /** Whether the user may prepare a return for approval (`finance.gstr.generate`). */
  mayPrepare?(): boolean;
  /** Head office, same origin, under the person's own session. Absent: nothing live can be read or done. */
  headOffice?: HeadOfficeCall;
  /** A fresh idempotency key. */
  newKey?(): string;
  /** How many requests an earlier version of this page left on this computer, never sent to head office. */
  unsentEarlier?(): number;
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
  | 'btnApprove' | 'btnSubmit' | 'btnCancel' | 'btnReconcile' | 'btnPrepare'
  | 'needsApproveRole' | 'needsSubmitRole' | 'needsPrepareRole' | 'youPrepared' | 'filingOff'
  | 'sending' | 'lostRetry' | 'notLive' | 'needReason' | 'needEvidence'
  | 'reasonLabel' | 'evidenceLabel' | 'arnOptional' | 'resolvedLabel' | 'resolvedFiled' | 'resolvedFailed'
  | 'doneApprove' | 'doneCancel' | 'doneReconcile' | 'donePreview' | 'refusedWord' | 'unknownPeriod' | 'notActionable' | 'badPeriod'
  | 'arnLabel' | 'periodLabel' | 'preparedBy' | 'approvedByLabel'
  | 'attentionCount' | 'allClear'
  | 'stateReady' | 'stateEmpty' | 'stateNotPermitted' | 'stateReading'
  | 'fromBox' | 'liveLost' | 'liveRefused' | 'unsentEarlier'
  | 'nobodyNamed' | 'staleShell' | 'sampleData';

export const GST_RETURNS_COPY: BilingualCopy<CopyKey> = {
  en: {
    title: 'GST returns', langName: 'தமிழ்',
    lead: 'Every GSTR-1 filing period and what it needs next, read live from head office. The ones needing attention are first — a return the portal rejected, or one whose outcome is unknown and must be reconciled. A return is prepared by one person and approved by a different one; nothing is filed to the portal from here.',
    stPreviewed: 'Prepared — awaiting approval', stApproved: 'Approved — ready to file', stSubmitting: 'Being filed',
    stFiled: 'Filed', stFailed: 'Rejected by the portal', stUnknown: 'Outcome unknown — reconcile', stCancelled: 'Withdrawn before filing',
    actNone: 'Nothing — it is done', actApprove: 'A second person must approve it', actFile: 'File it to the portal',
    actWait: 'Wait — it is being filed', actRefile: 'Correct the figures and prepare it again', actReconcile: 'A person must reconcile it with evidence — do NOT assume it is filed',
    btnApprove: 'Approve', btnSubmit: 'File to the portal', btnCancel: 'Withdraw', btnReconcile: 'Record what the portal shows', btnPrepare: 'Prepare for approval',
    needsApproveRole: 'Needs the approve-returns role', needsSubmitRole: 'Needs the file-returns role', needsPrepareRole: 'Needs the prepare-returns role',
    youPrepared: 'You prepared this — a different person must approve it',
    filingOff: 'Filing to the GST portal is switched off. Nothing is filed from this page.',
    sending: 'Sending to head office…',
    lostRetry: 'Head office did not answer, so it is not known whether this was done. Press again — it is the same request and head office does it only once.',
    notLive: 'Head office cannot be read right now, so nothing can be approved or withdrawn. This list is the store computer\'s last copy.',
    needReason: 'Write the reason first. Nothing was sent.', needEvidence: 'Choose what the portal shows and write the evidence first. Nothing was sent.',
    reasonLabel: 'Reason (required)', evidenceLabel: 'Evidence (what you saw on the portal)', arnOptional: 'Portal reference (ARN), if shown',
    resolvedLabel: 'The portal shows', resolvedFiled: 'Filed', resolvedFailed: 'Not filed (rejected)',
    doneApprove: 'Approved', doneCancel: 'Withdrawn', doneReconcile: 'Reconciled', donePreview: 'Prepared — waiting for a second person to approve',
    refusedWord: 'Not done', unknownPeriod: 'That month is not on the list.', notActionable: 'That cannot be done to this return now.',
    badPeriod: 'Write the month as MMYYYY, e.g. 052026.',
    arnLabel: 'Portal reference', periodLabel: 'Period', preparedBy: 'Prepared by', approvedByLabel: 'Approved by',
    attentionCount: 'need attention', allClear: 'Every return is settled — nothing needs attention.',
    stateReady: 'Showing the filing periods', stateEmpty: 'No filing period has been started yet.',
    stateNotPermitted: 'You do not have permission to see the GST returns list.', stateReading: 'Asking head office…',
    fromBox: 'The store computer\'s last copy — not live.',
    liveLost: 'Head office cannot be reached. Nothing can be approved or withdrawn until it can.',
    liveRefused: 'Head office refused to show the filing list.',
    unsentEarlier: 'request(s) made on this computer by an earlier version of this page never reached head office — nothing was approved or filed by them. Press the button again.',
    nobodyNamed: 'This store computer has not been told who is using this screen.',
    staleShell: 'No connection to the store computer. This page is what it was last told, at', sampleData: 'Sample data — this is not your shop.',
  },
  ta: {
    title: 'GST வருமானங்கள்', langName: 'English',
    lead: 'ஒவ்வொரு GSTR-1 தாக்கல் காலமும் அடுத்து என்ன தேவை என்பதும், தலைமை அலுவலகத்திலிருந்து நேரடியாக. கவனம் தேவைப்படுபவை முதலில் — போர்ட்டல் மறுத்த வருமானம், அல்லது முடிவு தெரியாத ஒன்று. ஒருவர் தயாரிக்கிறார், வேறொருவர் ஒப்புதல் அளிக்கிறார்; இங்கிருந்து போர்ட்டலில் எதுவும் தாக்கல் செய்யப்படாது.',
    stPreviewed: 'தயாரிக்கப்பட்டது — ஒப்புதலுக்குக் காத்திருக்கிறது', stApproved: 'ஒப்புதல் — தாக்கல் செய்யத் தயார்', stSubmitting: 'தாக்கல் செய்யப்படுகிறது',
    stFiled: 'தாக்கல் செய்யப்பட்டது', stFailed: 'போர்ட்டல் மறுத்தது', stUnknown: 'முடிவு தெரியவில்லை — சரிபார்க்கவும்', stCancelled: 'தாக்கலுக்கு முன் திரும்பப்பெறப்பட்டது',
    actNone: 'எதுவும் இல்லை — முடிந்தது', actApprove: 'இரண்டாவது நபர் ஒப்புதல் அளிக்க வேண்டும்', actFile: 'போர்ட்டலில் தாக்கல் செய்யவும்',
    actWait: 'காத்திருங்கள் — தாக்கல் செய்யப்படுகிறது', actRefile: 'எண்களைச் சரிசெய்து மீண்டும் தயாரிக்கவும்', actReconcile: 'ஒருவர் ஆதாரத்துடன் சரிபார்க்க வேண்டும் — தாக்கல் ஆனதாகக் கருத வேண்டாம்',
    btnApprove: 'ஒப்புதல்', btnSubmit: 'போர்ட்டலில் தாக்கல் செய்யவும்', btnCancel: 'திரும்பப்பெறு', btnReconcile: 'போர்ட்டல் காட்டுவதைப் பதிவு செய்', btnPrepare: 'ஒப்புதலுக்குத் தயாரி',
    needsApproveRole: 'ஒப்புதல் அளிக்கும் அனுமதி தேவை', needsSubmitRole: 'தாக்கல் செய்யும் அனுமதி தேவை', needsPrepareRole: 'தயாரிக்கும் அனுமதி தேவை',
    youPrepared: 'இதை நீங்கள் தயாரித்தீர்கள் — வேறு ஒருவர் ஒப்புதல் அளிக்க வேண்டும்',
    filingOff: 'GST போர்ட்டலில் தாக்கல் செய்வது நிறுத்தப்பட்டுள்ளது. இந்தப் பக்கத்திலிருந்து எதுவும் தாக்கல் செய்யப்படாது.',
    sending: 'தலைமை அலுவலகத்திற்கு அனுப்புகிறது…',
    lostRetry: 'தலைமை அலுவலகம் பதில் அளிக்கவில்லை; இது நடந்ததா என்று தெரியவில்லை. மீண்டும் அழுத்தவும் — இது அதே கோரிக்கை, தலைமை அலுவலகம் ஒரே ஒருமுறை செய்யும்.',
    notLive: 'தலைமை அலுவலகத்தை இப்போது படிக்க முடியவில்லை; ஆகவே எதற்கும் ஒப்புதல் அளிக்கவோ திரும்பப்பெறவோ முடியாது. இந்தப் பட்டியல் கடைக் கணினியின் கடைசிப் பிரதி.',
    needReason: 'முதலில் காரணத்தை எழுதுங்கள். எதுவும் அனுப்பப்படவில்லை.', needEvidence: 'போர்ட்டல் காட்டுவதைத் தேர்ந்தெடுத்து ஆதாரத்தை எழுதுங்கள். எதுவும் அனுப்பப்படவில்லை.',
    reasonLabel: 'காரணம் (தேவை)', evidenceLabel: 'ஆதாரம் (போர்ட்டலில் பார்த்தது)', arnOptional: 'போர்ட்டல் குறிப்பு (ARN), இருந்தால்',
    resolvedLabel: 'போர்ட்டல் காட்டுவது', resolvedFiled: 'தாக்கல் ஆனது', resolvedFailed: 'தாக்கல் ஆகவில்லை (மறுக்கப்பட்டது)',
    doneApprove: 'ஒப்புதல் அளிக்கப்பட்டது', doneCancel: 'திரும்பப்பெறப்பட்டது', doneReconcile: 'சரிபார்க்கப்பட்டது', donePreview: 'தயாரிக்கப்பட்டது — இரண்டாவது நபரின் ஒப்புதலுக்குக் காத்திருக்கிறது',
    refusedWord: 'செய்யப்படவில்லை', unknownPeriod: 'அந்த மாதம் பட்டியலில் இல்லை.', notActionable: 'இந்த வருமானத்திற்கு இப்போது அதைச் செய்ய முடியாது.',
    badPeriod: 'மாதத்தை MMYYYY ஆக எழுதுங்கள், எ.கா. 052026.',
    arnLabel: 'போர்ட்டல் குறிப்பு', periodLabel: 'காலம்', preparedBy: 'தயாரித்தவர்', approvedByLabel: 'ஒப்புதல் அளித்தவர்',
    attentionCount: 'கவனம் தேவை', allClear: 'ஒவ்வொரு வருமானமும் தீர்க்கப்பட்டது — எதற்கும் கவனம் தேவையில்லை.',
    stateReady: 'தாக்கல் காலங்களைக் காட்டுகிறது', stateEmpty: 'இன்னும் எந்தத் தாக்கல் காலமும் தொடங்கப்படவில்லை.',
    stateNotPermitted: 'GST வருமானங்கள் பட்டியலைப் பார்க்க உங்களுக்கு அனுமதி இல்லை.', stateReading: 'தலைமை அலுவலகத்திடம் கேட்கிறது…',
    fromBox: 'கடைக் கணினியின் கடைசிப் பிரதி — நேரடி அல்ல.',
    liveLost: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை. அதுவரை எதற்கும் ஒப்புதல் அளிக்கவோ திரும்பப்பெறவோ முடியாது.',
    liveRefused: 'தாக்கல் பட்டியலைக் காட்ட தலைமை அலுவலகம் மறுத்தது.',
    unsentEarlier: 'இந்தக் கணினியில் இந்தப் பக்கத்தின் முந்தைய பதிப்பு செய்த கோரிக்கை(கள்) தலைமை அலுவலகத்தை அடையவே இல்லை — அவற்றால் எதுவும் ஒப்புதல் பெறவோ தாக்கல் ஆகவோ இல்லை. பொத்தானை மீண்டும் அழுத்தவும்.',
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

const BUTTON_LABEL: Readonly<Record<GstReturnCommandAction, CopyKey>> = {
  approve: 'btnApprove', submit: 'btnSubmit', cancel: 'btnCancel', reconcile: 'btnReconcile',
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
    case 'failed': return 'refile';       // the portal rejected it — correct and prepare again
    case 'unknown': return 'reconcile';   // no clear answer — reconcile with evidence (hard rule #10)
    case 'filed': case 'cancelled': return 'none';
  }
}

/** Where an act goes at head office, and what it carries. Pure — the session sends it. */
export function returnActRequest(input: ReturnActInput): { readonly path: string; readonly body: Record<string, unknown> } {
  const base = `/v1/finance/gstr1/submission/${encodeURIComponent(input.period)}`;
  switch (input.action) {
    case 'approve': return { path: `${base}/approve`, body: {} };
    case 'cancel': return { path: `${base}/cancel`, body: { reason: (input.reason ?? '').trim() } };
    case 'reconcile': return {
      path: `${base}/reconcile`,
      body: { resolvedState: input.resolvedState, note: (input.note ?? '').trim(), ...((input.arn ?? '').trim() === '' ? {} : { arn: (input.arn ?? '').trim() }) },
    };
    case 'submit': return { path: `${base}/submit`, body: {} };
  }
}

// ── the presented shapes the view renders ────────────────────────────────────────────────────────────

/** One governance act on a return, already gated. */
export interface PresentedReturnAction {
  readonly action: GstReturnCommandAction;
  readonly label: string;
  readonly period: string;
  /** Whether THIS user may run it now (right role, not the maker for approve, live list, nothing on its way). */
  readonly enabled: boolean;
  /** What the act needs typed first: nothing, a reason (withdraw) or evidence (reconcile). */
  readonly needs: 'nothing' | 'reason' | 'evidence';
  /** A short bilingual note: needs-role, you-prepared-this, filing-off, sending, lost — never in the dark (P-08). */
  readonly note?: string;
}

export interface PresentedReturn {
  readonly period: string;
  readonly category: Gstr1SubmissionQueueCategory;
  readonly status: StatusPresentation;
  readonly action: ReturnAction;
  readonly actionLabel: string;
  readonly needsAttention: boolean;
  readonly arn?: string;
  readonly preparedBy?: string;
  readonly approvedByName?: string;
  readonly detail: string;
  readonly actions: readonly PresentedReturnAction[];
}

export interface GstReturnsView {
  readonly screenState: StatusPresentation;
  readonly rows: readonly PresentedReturn[];
  readonly attentionCount: number;
  readonly total: number;
  readonly nobodyNamed: boolean;
  /** Where the list came from: head office now, the box's last copy, or nowhere yet. */
  readonly source: 'head_office' | 'box' | 'none';
  /** The sentence saying why the list is not live, when it is not. */
  readonly liveProblem?: string;
  /** The sentence about requests an earlier version left unsent on this computer, when there are any. */
  readonly unsentEarlier?: string;
  /** Whether this user may prepare a return (the Prepare form is offered). */
  readonly mayPrepare: boolean;
}

export interface GstReturnsSession {
  /** One bilingual string. */
  text(lang: Lang, key: CopyKey): string;
  /** The whole screen, in the chosen language, with the ones needing attention first. */
  view(lang: Lang): GstReturnsView;
  /** Read the filing list from head office (each period's own state, with who prepared and approved it). */
  load(): Promise<void>;
  /**
   * Ask head office to do an act on a return. Re-checks every guard the view used (role, maker ≠ checker, the state
   * offers it, the list is live, nothing already on its way, a reason / evidence typed), then sends it ONCE: the key is
   * kept while the answer is lost, so a retry is the same act. On a definite answer the list is read again.
   */
  act(input: ReturnActInput): Promise<ReturnActionResult>;
  /** The maker prepares a month for approval: head office's own digest of its figures is recorded (POST …/preview). */
  prepare(period: string): Promise<ReturnActionResult>;
  /** A result in words. */
  resultWords(lang: Lang, result: ReturnActionResult): string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const STATES: readonly Gstr1SubmissionState[] = ['previewed', 'approved', 'submitting', 'filed', 'failed', 'unknown', 'cancelled'];
const FP = /^(0[1-9]|1[0-2])\d{4}$/;

/** Head office's folded submission → the row this page shows; `undefined` for anything it cannot read. */
export function rowFromHeadOffice(raw: unknown): ReturnRow | undefined {
  if (!isObj(raw) || typeof raw['period'] !== 'string' || !STATES.includes(raw['state'] as Gstr1SubmissionState)) return undefined;
  const str = (k: string): string | undefined => (typeof raw[k] === 'string' && raw[k] !== '' ? raw[k] as string : undefined);
  const arn = str('arn'); const detail = str('detail'); const by = str('previewedBy'); const ok = str('approvedBy');
  return {
    period: raw['period'], state: raw['state'] as Gstr1SubmissionState,
    ...(arn !== undefined ? { arn } : {}), ...(detail !== undefined ? { detail } : {}),
    ...(by !== undefined ? { previewedBy: by } : {}), ...(ok !== undefined ? { approvedBy: ok } : {}),
  };
}

export function createGstReturnsSession(config: GstReturnsConfig, ports: GstReturnsPorts): GstReturnsSession {
  const text = (lang: Lang, key: CopyKey): string => translator(GST_RETURNS_COPY, lang)(key);
  const newKey = ports.newKey ?? (() => `gst-return-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

  let live: readonly ReturnRow[] | undefined;
  let liveProblem: 'lost' | 'refused' | undefined;
  let reading = false;
  /** The key of each act whose answer was lost — kept so the retry is the same act. */
  const lostKeys = new Map<string, string>();
  /** Acts on their way now — a second click sends nothing. */
  const inFlight = new Set<string>();

  const rows = (): readonly ReturnRow[] => live ?? ports.rows();
  const isLive = (): boolean => live !== undefined;

  const slotOf = (action: string, period: string, state: string, body: unknown): string => `${action}|${period}|${state}|${JSON.stringify(body)}`;
  /** The slots per row so the view can say "sending" / "lost" on the right button. */
  const rowSlotState = (action: GstReturnCommandAction, period: string): 'sending' | 'lost' | undefined => {
    const prefix = `${action}|${period}|`;
    for (const s of inFlight) if (s.startsWith(prefix)) return 'sending';
    for (const s of lostKeys.keys()) if (s.startsWith(prefix)) return 'lost';
    return undefined;
  };

  /** May THIS user run this act on this row? (The definite rules; head office re-checks every one.) */
  const maySelfRun = (action: GstReturnCommandAction, row: ReturnRow): { readonly ok: boolean; readonly why?: CopyKey; readonly refusal?: ReturnActionRefusal } => {
    if (action === 'submit') return { ok: false, why: 'filingOff', refusal: 'filing_off' };
    if (config.userId === null) return { ok: false, why: action === 'reconcile' ? 'needsSubmitRole' : 'needsApproveRole', refusal: 'not_permitted' };
    if (action === 'reconcile') return ports.maySubmit() ? { ok: true } : { ok: false, why: 'needsSubmitRole', refusal: 'not_permitted' };
    if (!ports.mayApprove()) return { ok: false, why: 'needsApproveRole', refusal: 'not_permitted' };
    if (action === 'approve' && row.previewedBy !== undefined && row.previewedBy === config.userId) return { ok: false, why: 'youPrepared', refusal: 'self_approval' };
    return { ok: true };
  };

  const presentActions = (t: (key: CopyKey) => string, row: ReturnRow): PresentedReturnAction[] =>
    commandActionsFor(row.state).map((action) => {
      const may = maySelfRun(action, row);
      const slot = rowSlotState(action, row.period);
      const note = !may.ok ? t(may.why!) : !isLive() ? t('notLive') : slot === 'sending' ? t('sending') : slot === 'lost' ? t('lostRetry') : undefined;
      return {
        action, label: t(BUTTON_LABEL[action]), period: row.period,
        enabled: may.ok && isLive() && slot !== 'sending',
        needs: action === 'cancel' ? 'reason' : action === 'reconcile' ? 'evidence' : 'nothing',
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

  const load = async (): Promise<void> => {
    if (!ports.mayRead() || ports.headOffice === undefined) return;
    reading = true;
    try {
      const list = await ports.headOffice('GET', '/v1/finance/gstr1/submissions');
      if (list.kind !== 'ok') { live = undefined; liveProblem = list.kind; return; }
      const periods = (isObj(list.body) && Array.isArray(list.body['submissions']) ? list.body['submissions'] : [])
        .flatMap((s) => (isObj(s) && typeof s['period'] === 'string' ? [s['period']] : []));
      const out: ReturnRow[] = [];
      for (const period of periods) {
        const one = await ports.headOffice('GET', `/v1/finance/gstr1/submission/${encodeURIComponent(period)}`);
        if (one.kind !== 'ok') { live = undefined; liveProblem = one.kind; return; }
        const row = rowFromHeadOffice(one.body);
        if (row !== undefined) out.push(row);
      }
      live = out;
      liveProblem = undefined;
    } finally {
      reading = false;
    }
  };

  /** Send one act once: key kept while lost, dropped on any definite answer, and the list read again. */
  const send = async (slot: string, path: string, body: unknown, action: GstReturnCommandAction | 'preview', period: string): Promise<ReturnActionResult> => {
    if (inFlight.has(slot)) return { ok: false, reason: 'already_sending' };
    const key = lostKeys.get(slot) ?? newKey();
    inFlight.add(slot);
    let answer: HeadOfficeAnswer;
    try {
      answer = await ports.headOffice!('POST', path, body, key);
    } finally {
      inFlight.delete(slot);
    }
    if (answer.kind === 'lost') { lostKeys.set(slot, key); return { ok: false, reason: 'lost' }; }
    lostKeys.delete(slot);
    await load();
    if (answer.kind === 'refused') return { ok: false, reason: 'refused', whatHappened: answer.whatHappened, nextSafeAction: answer.nextSafeAction };
    const current = isObj(answer.body) && isObj(answer.body['current']) ? rowFromHeadOffice(answer.body['current']) : undefined;
    return { ok: true, action, period, ...(current !== undefined ? { state: current.state } : {}) };
  };

  return {
    text,
    view: (lang) => {
      const t = translator(GST_RETURNS_COPY, lang);
      const mayPrepare = config.userId !== null && (ports.mayPrepare?.() ?? false);
      const unsent = ports.unsentEarlier?.() ?? 0;
      const extra = {
        ...(liveProblem !== undefined ? { liveProblem: t(liveProblem === 'lost' ? 'liveLost' : 'liveRefused') } : {}),
        ...(unsent > 0 ? { unsentEarlier: `${unsent} ${t('unsentEarlier')}` } : {}),
      };
      if (!ports.mayRead()) {
        return {
          screenState: presentScreenState({ state: 'error', label: t('stateNotPermitted') }),
          rows: [], attentionCount: 0, total: 0, nobodyNamed: config.userId === null, source: 'none', mayPrepare: false,
        };
      }
      const raw = rows();
      const presented = raw.map((r) => present(lang, r));
      // The ones needing attention first; within each, most recent filing period first.
      const ordered = [...presented].sort((a, b) => {
        if (a.needsAttention !== b.needsAttention) return a.needsAttention ? -1 : 1;
        return periodSortKey(b.period).localeCompare(periodSortKey(a.period));
      });
      const attentionCount = presented.filter((r) => r.needsAttention).length;
      const source = isLive() ? 'head_office' : raw.length > 0 ? 'box' : 'none';
      const state = presented.length === 0 ? (reading ? 'loading' : 'empty') : 'ready';
      const label = state === 'loading' ? t('stateReading') : state === 'empty' ? (liveProblem !== undefined ? t(liveProblem === 'lost' ? 'liveLost' : 'liveRefused') : t('stateEmpty')) : t('stateReady');
      return {
        screenState: presentScreenState({ state: state === 'empty' && liveProblem !== undefined ? 'error' : state, label }),
        rows: ordered, attentionCount, total: presented.length, nobodyNamed: config.userId === null,
        source, mayPrepare, ...extra,
      };
    },
    load,

    act: async (input) => {
      if (!ports.mayRead()) return { ok: false, reason: 'not_permitted' };
      const row = rows().find((r) => r.period === input.period);
      if (row === undefined) return { ok: false, reason: 'unknown_period' };
      // The rule-#10 guard: a state that offers no act cannot be acted on, even if a stale button asked.
      if (!commandActionsFor(row.state).includes(input.action)) return { ok: false, reason: 'not_actionable' };
      const may = maySelfRun(input.action, row);
      if (!may.ok) return { ok: false, reason: may.refusal ?? 'not_permitted' };
      // §31: no approval against a stale copy — only the live list may be acted on.
      if (!isLive() || ports.headOffice === undefined) return { ok: false, reason: 'not_live' };
      if (input.action === 'cancel' && (input.reason ?? '').trim() === '') return { ok: false, reason: 'needs_reason' };
      if (input.action === 'reconcile' && ((input.resolvedState !== 'filed' && input.resolvedState !== 'failed') || (input.note ?? '').trim() === '')) {
        return { ok: false, reason: 'needs_evidence' };
      }
      const { path, body } = returnActRequest(input);
      return send(slotOf(input.action, row.period, row.state, body), path, body, input.action, row.period);
    },

    prepare: async (period) => {
      const p = period.trim();
      if (!FP.test(p)) return { ok: false, reason: 'bad_period' };
      if (config.userId === null || !(ports.mayPrepare?.() ?? false)) return { ok: false, reason: 'not_permitted' };
      if (ports.headOffice === undefined) return { ok: false, reason: 'not_live' };
      // The digest is head office's own, of the month's figures (GSTR-3B's `gstr1PreviewDigest`) — never worked out here.
      const month = await ports.headOffice('GET', `/v1/finance/gstr3b/${encodeURIComponent(p)}`);
      if (month.kind === 'lost') return { ok: false, reason: 'lost' };
      if (month.kind === 'refused') return { ok: false, reason: 'refused', whatHappened: month.whatHappened, nextSafeAction: month.nextSafeAction };
      const digest = isObj(month.body) && typeof month.body['gstr1PreviewDigest'] === 'string' ? month.body['gstr1PreviewDigest'] : '';
      const body = { returnDigest: digest };
      return send(slotOf('preview', p, 'digest', body), `/v1/finance/gstr1/submission/${encodeURIComponent(p)}/preview`, body, 'preview', p);
    },

    resultWords: (lang, result) => {
      const t = translator(GST_RETURNS_COPY, lang);
      if (result.ok) {
        const done: CopyKey = result.action === 'approve' ? 'doneApprove' : result.action === 'cancel' ? 'doneCancel' : result.action === 'reconcile' ? 'doneReconcile' : 'donePreview';
        return `${t(done)}: ${result.period}`;
      }
      switch (result.reason) {
        case 'refused': return `${t('refusedWord')}: ${result.whatHappened} ${result.nextSafeAction}`.trim();
        case 'lost': return t('lostRetry');
        case 'already_sending': return t('sending');
        case 'not_live': return t('notLive');
        case 'needs_reason': return t('needReason');
        case 'needs_evidence': return t('needEvidence');
        case 'self_approval': return t('youPrepared');
        case 'filing_off': return t('filingOff');
        case 'unknown_period': return t('unknownPeriod');
        case 'not_actionable': return t('notActionable');
        case 'bad_period': return t('badPeriod');
        case 'not_permitted': return t('needsApproveRole');
      }
    },
  };
}

/** MMYYYY → YYYYMM so string comparison sorts chronologically; a malformed period sorts last. */
function periodSortKey(period: string): string {
  return /^\d{6}$/.test(period) ? `${period.slice(2)}${period.slice(0, 2)}` : '000000';
}
