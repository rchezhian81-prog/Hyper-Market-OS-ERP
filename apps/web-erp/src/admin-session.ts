// Admin and security (M01 · M02-FR-01…04 · M33 · M33-FR-03 · M34-FR-01/02 · D12 · §27 · §28 · SEC-11 · ADR-0024 ·
// audit PA-03).
//
// The design bar for this surface is three lines: **least privilege by default; no shared logins
// (hard rule #4); every privileged action audited and support access time-bound** (P-04).
//
// ── What was written, tested, and called by nothing ─────────────────────────
//
// `accessReview`, `supportSessionActive`, `evaluateDevice`, `fleetSummary`, `planRetention`,
// `holdApplies`, `liftHold` and `validateVersionPolicy` — eight rules, none of them reached from
// anywhere outside their own unit tests. The eleventh instance of this codebase's recurring shape.
//
// ── Outside access is head office's two-step lifecycle, decided in the owner's own session ──
//
// This screen used to carry a LOCAL "let somebody in" form: the person at the screen typed who needed access, the
// scopes, the minutes — and "who approves it (not them)" — and the one engine (`grantSupportAccess`) ran in the
// browser. A name typed into a box is not anybody's approval (audit PA-03), and a grant that never reached head office
// was not a grant anywhere that mattered. That form is gone. Support access is now exactly head office's lifecycle
// (`services/platform/src/support-access-lifecycle.ts`, M33-FR-03):
//
//   1. the SUPPORT PERSON files their own request from their own sign-in (`POST …/support-access/requests` — the
//      requester is the caller). Nobody types a request, or a requester, on this screen;
//   2. the OWNER sees it here, under "Waiting for your decision", and approves (optionally for FEWER minutes — never
//      more than asked) or rejects it IN THEIR OWN SESSION (`POST …/requests/:requestId/decision`). The decider is the
//      signed-in person; this screen never names one, and head office's engine refuses a self-approval, a forbidden
//      scope and an over-long window;
//   3. a live session can be ended early, again in the owner's own session (`POST …/sessions/:sessionId/end`).
//
// This model refuses only the cheap things locally, BEFORE any POST: nobody named at the screen, a person without the
// owner's authority (`platform.support.grant`), a page not connected to head office or whose list head office has not
// just answered, a request no longer waiting, the person's own request (§28), and minutes that are unreadable or LONGER
// than asked. Everything else is head office's to decide, and its own refusals are said in plain words.
//
// ── The rule this screen turns on ───────────────────────────────────────────
//
// **A grant that has expired is not access.** `supportSessionActive` decides that from the clock —
// "expiry is a fact about time, not an event someone triggers" — every time the screen is read: against head
// office's own clock (`asAt`) for the list head office just gave, or the store computer's for the list it last knew.
// Never from a stored flag, because a flag has to be turned off by something.

import { translator, presentScreenState, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { presentStatus, type StatusPresentation } from '../../../packages/a11y/src/signals';
import {
  supportSessionActive, evaluateDevice, fleetSummary,
  type Device, type DeviceDecision, type FleetSummary,
  type SupportAccessRequest, type SupportSession, type VersionPolicy,
} from '../../../packages/platform-admin/src/index';
// Import from the specific module, NOT the `@sre/identity` barrel: the barrel also re-exports the OTP and
// org-membership engines, which use `node:crypto` and cannot be bundled for the browser. `accessReview`
// and its types live in `account.ts`, which is browser-safe (no node built-ins). See the browser-apps
// bundle guardrail.
import { accessReview, type AccessReviewRow, type UserAccount } from '../../../packages/identity/src/account';
import { planRetention, type AuditRecord, type LegalHold, type RetentionPlan, type RetentionPolicy } from '../../../packages/audit/src/index';
import type { Role, RoleAssignment } from '../../../packages/rbac/src/index';
import { shopTime, type LostLink, type Refused } from './approvals-session';

/** The authority head office checks for a support-access decision and an early end — the owner's. */
export const SUPPORT_DECIDE_PERMISSION = 'platform.support.grant';

// ── What head office hands over, and what the page sends ─────────────────────────────────────────────────────

/** Head office's support-access state (`GET /v1/platform/support-access/sessions`). */
export interface SupportAccessState {
  /** Every granted session, live and finished. Liveness is NOT read from here — this model computes it. */
  readonly sessions: readonly SupportSession[];
  /** Requests a support person filed, waiting for the owner's decision. */
  readonly pending: readonly SupportAccessRequest[];
  /** Head office's clock when it answered — the moment each session is judged against. */
  readonly asAt: string;
}

/** A read of head office's support-access state (a GET — writes nothing). */
export type SupportRead = { readonly result: 'read'; readonly state: SupportAccessState } | Refused | LostLink;

export type SupportDecision = 'approved' | 'rejected';

/** What head office said to a decision. */
export type SupportDecisionResult =
  | { readonly result: 'approved'; readonly session: SupportSession }
  | { readonly result: 'rejected' }
  | Refused | LostLink;

/** What head office said to an early end. */
export type SupportEndResult = { readonly result: 'ended'; readonly endedAt: string } | Refused | LostLink;

/**
 * Head office's support-access routes, called in the signed-in person's OWN session. Injected, so this model never
 * opens a socket. A decision carries only `{ decision, grantedMinutes? }` — never a decider: head office takes the
 * caller as the person who decided.
 */
export interface SupportAccessPort {
  read(): Promise<SupportRead>;
  decide(input: { readonly requestId: string; readonly decision: SupportDecision; readonly grantedMinutes?: number }): Promise<SupportDecisionResult>;
  end(input: { readonly sessionId: string }): Promise<SupportEndResult>;
}

/** What this surface can see, and what it honestly cannot. */
export interface AdminPorts {
  /** Every account, so joiners, movers and leavers can be reviewed (M02-FR-04). */
  accounts(): readonly UserAccount[];
  roles(): readonly Role[];
  assignments(): readonly RoleAssignment[];
  /** The support sessions the STORE COMPUTER last knew. Never pruned — somebody outside the business saw live data.
   *  Shown only until head office answers; head office's own list replaces it. */
  supportSessions(): readonly SupportSession[];
  /** Whether this person holds the owner's authority to decide support access and end it early
   *  (`platform.support.grant`). Default-deny: head office re-checks it on every POST. */
  mayDecideSupport(): boolean;
  /** Head office's support-access routes. Absent when the page is not connected to head office — then the screen
   *  says so and decides nothing. */
  readonly supportAccess?: SupportAccessPort;
  /** The tills, handhelds and phones this shop runs on. */
  devices(): readonly Device[];
  /** The minimum versions this tenant will allow. Absent means nothing is being enforced. */
  versionPolicy(): VersionPolicy | undefined;
  /** Audit records in scope for a retention review. */
  auditRecords(): readonly AuditRecord[];
  retentionPolicies(): readonly RetentionPolicy[];
  legalHolds(): readonly LegalHold[];
}

export interface AdminConfig {
  readonly tenantId: string;
  /** Who is looking. `null` means the box was not told — nothing privileged may be done. */
  readonly userId: string | null;
  readonly now: string;
  /** Days without a login after which an account is stale enough to review. Per-tenant. */
  readonly dormantAfterDays: number;
}

// ── The copy: ONE bilingual object for the outside-access tab ────────────────────────────────────────────────

export type SupportCopyKey =
  | 'waitingTitle' | 'waitingLead' | 'nothingWaiting' | 'sessionsTitle' | 'requestsNote'
  | 'askedBy' | 'whyLabel' | 'wantsToSee' | 'askedFor' | 'askedAt' | 'shorterLabel'
  | 'approveBtn' | 'rejectBtn' | 'endBtn' | 'checkAgainBtn' | 'ownRequestRow'
  | 'windowWords' | 'endedEarlyAt' | 'ranOutAt'
  | 'sourceRead' | 'sourceChecking' | 'sourceNotConnected' | 'sourceLostLink' | 'sourceLostLinkKnown'
  | 'sourceNotPermitted' | 'sourceRefused' | 'sourceRefusedNoWords'
  | 'cannotNobody' | 'cannotPermission' | 'cannotNotConnected' | 'cannotNotRead'
  | 'decidedApproved' | 'decidedRejected' | 'decideNotWaiting' | 'decideOwnRequest'
  | 'decideMinutesUnreadable' | 'decideLonger' | 'decideAlreadyDecided' | 'decideAlreadyDecidedNoWords' | 'decideUnknown'
  | 'decidePolicy' | 'decidePolicyNoWords' | 'decideForbidden' | 'decideRefused' | 'decideRefusedNoWords'
  | 'decideLostLink'
  | 'endedNow' | 'endNotLive' | 'endUnknown' | 'endForbidden' | 'endRefused' | 'endRefusedNoWords' | 'endLostLink'
  | 'nothingSent';

export const SUPPORT_ACCESS_COPY: BilingualCopy<SupportCopyKey> = {
  en: {
    waitingTitle: 'Waiting for your decision',
    waitingLead: 'A support person has asked to see part of your live data. Only the owner decides — for no longer than they asked, and never for a request of their own.',
    nothingWaiting: 'Nobody is waiting for a decision.',
    sessionsTitle: 'Who has been let in',
    requestsNote: 'A support person files their own request, from their own sign-in. Nobody types a request, or an approver, on this screen.',
    askedBy: 'Asked by', whyLabel: 'Why', wantsToSee: 'Wants to see', askedFor: 'for {minutes} minutes', askedAt: 'Asked at',
    shorterLabel: 'Let them in for fewer minutes (optional — at most {minutes})',
    approveBtn: 'Approve', rejectBtn: 'Reject', endBtn: 'End it now', checkAgainBtn: 'Check again',
    ownRequestRow: 'You asked for this, so someone else must decide it.',
    windowWords: 'from {from} until {until}', endedEarlyAt: 'ended early at {at}', ranOutAt: 'its time ran out at {at}',
    sourceRead: 'From head office, as at {at}.',
    sourceChecking: 'Asking head office…',
    sourceNotConnected: 'This page is not connected to head office, so nothing can be decided here. What is shown is what the store computer last knew.',
    sourceLostLink: 'No connection to head office. What is shown is what the store computer last knew — nothing can be decided until head office answers. Press “Check again”.',
    sourceLostLinkKnown: 'No connection to head office. What is shown is what head office said at {at} — nothing can be decided until it answers again. Press “Check again”.',
    sourceNotPermitted: 'Head office says you may not see outside access.',
    sourceRefused: 'Head office did not give the list:',
    sourceRefusedNoWords: 'Head office refused to give the list.',
    cannotNobody: 'This store computer has not been told who is using this screen, so nothing can be decided here.',
    cannotPermission: 'You can see these requests, but only the owner decides who is let in, and you do not hold that permission.',
    cannotNotConnected: 'Not connected to head office — nothing can be decided here.',
    cannotNotRead: 'Head office has not answered, so nothing can be decided until it does. Press “Check again”.',
    decidedApproved: 'Approved. {who} may see {scopes} for {minutes} minutes, until {until}. It ends by itself.',
    decidedRejected: 'Rejected. {who} was not let in.',
    decideNotWaiting: 'That request is no longer waiting — it may already have been decided. The list has been read again.',
    decideOwnRequest: 'You asked for this yourself, so someone else must decide it (§28).',
    decideMinutesUnreadable: 'Write the minutes as a whole number from 1 to {asked} — or leave the box empty to allow what was asked.',
    decideLonger: 'You can only shorten the time, never lengthen it. They asked for {asked} minutes; {typed} is longer.',
    decideAlreadyDecided: 'Someone already decided this request:',
    decideAlreadyDecidedNoWords: 'Someone already decided this request.',
    decideUnknown: 'Head office has no such request — it may have been withdrawn. The list has been read again.',
    decidePolicy: 'Head office’s rules refused this, and nobody was let in:',
    decidePolicyNoWords: 'Head office’s rules refused this, and nobody was let in.',
    decideForbidden: 'Head office says you are not permitted to decide outside access. Nothing was decided.',
    decideRefused: 'Not decided:',
    decideRefusedNoWords: 'Not decided — head office refused it.',
    decideLostLink: 'No connection to head office — nothing was decided. Try again.',
    endedNow: 'Ended. {who} can no longer see your data — from {at}.',
    endNotLive: 'That session is not live any more — there is nothing to end. The list has been read again.',
    endUnknown: 'Head office has no such session. The list has been read again.',
    endForbidden: 'Head office says you are not permitted to end outside access. The session was NOT ended.',
    endRefused: 'Not ended:',
    endRefusedNoWords: 'Not ended — head office refused it.',
    endLostLink: 'No connection to head office — the session was NOT ended. Try again.',
    nothingSent: 'Nothing was sent.',
  },
  ta: {
    waitingTitle: 'உங்கள் முடிவுக்காகக் காத்திருப்பவை',
    waitingLead: 'ஒரு உதவி நிபுணர் உங்கள் நேரடித் தகவலின் ஒரு பகுதியைப் பார்க்க அனுமதி கேட்டுள்ளார். உரிமையாளர் மட்டுமே முடிவு செய்வார் — அவர்கள் கேட்டதை விட அதிக நேரத்துக்கு ஒருபோதும் இல்லை, தன் சொந்தக் கோரிக்கைக்கும் இல்லை.',
    nothingWaiting: 'முடிவுக்காக யாரும் காத்திருக்கவில்லை.',
    sessionsTitle: 'உள்ளே அனுமதிக்கப்பட்டவர்கள்',
    requestsNote: 'உதவி நிபுணர் தனது சொந்த உள்நுழைவிலிருந்து தானே கோரிக்கையைப் பதிவு செய்கிறார். இந்தத் திரையில் யாரும் கோரிக்கையையோ அனுமதிப்பவரின் பெயரையோ தட்டச்சு செய்வதில்லை.',
    askedBy: 'கேட்டவர்', whyLabel: 'ஏன்', wantsToSee: 'பார்க்க விரும்புவது', askedFor: '{minutes} நிமிடங்களுக்கு', askedAt: 'கேட்ட நேரம்',
    shorterLabel: 'குறைவான நிமிடங்களுக்கு மட்டும் அனுமதிக்க (விருப்பம் — அதிகபட்சம் {minutes})',
    approveBtn: 'அனுமதி', rejectBtn: 'மறு', endBtn: 'இப்போதே முடி', checkAgainBtn: 'மீண்டும் சரிபார்',
    ownRequestRow: 'இதைக் கேட்டது நீங்கள், எனவே வேறொருவர்தான் முடிவு செய்ய வேண்டும்.',
    windowWords: '{from} முதல் {until} வரை', endedEarlyAt: '{at}-க்கு முன்கூட்டியே முடிக்கப்பட்டது', ranOutAt: '{at}-க்கு நேரம் முடிந்தது',
    sourceRead: 'தலைமை அலுவலகத்திலிருந்து, {at} நிலவரப்படி.',
    sourceChecking: 'தலைமை அலுவலகத்திடம் கேட்கிறது…',
    sourceNotConnected: 'இந்தப் பக்கம் தலைமை அலுவலகத்துடன் இணைக்கப்படவில்லை, எனவே இங்கே எதையும் முடிவு செய்ய முடியாது. காட்டப்படுவது கடைக் கணினிக்குக் கடைசியாகத் தெரிந்தது.',
    sourceLostLink: 'தலைமை அலுவலகத்துடன் இணைப்பு இல்லை. காட்டப்படுவது கடைக் கணினிக்குக் கடைசியாகத் தெரிந்தது — தலைமை அலுவலகம் பதில் சொல்லும் வரை எதையும் முடிவு செய்ய முடியாது. “மீண்டும் சரிபார்” அழுத்தவும்.',
    sourceLostLinkKnown: 'தலைமை அலுவலகத்துடன் இணைப்பு இல்லை. காட்டப்படுவது {at}-க்குத் தலைமை அலுவலகம் சொன்னது — அது மீண்டும் பதில் சொல்லும் வரை எதையும் முடிவு செய்ய முடியாது. “மீண்டும் சரிபார்” அழுத்தவும்.',
    sourceNotPermitted: 'வெளியாட்கள் அணுகலைப் பார்க்க உங்களுக்கு அனுமதி இல்லை என்று தலைமை அலுவலகம் சொல்கிறது.',
    sourceRefused: 'தலைமை அலுவலகம் பட்டியலைத் தரவில்லை:',
    sourceRefusedNoWords: 'தலைமை அலுவலகம் பட்டியலைத் தர மறுத்தது.',
    cannotNobody: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை, எனவே இங்கே எதையும் முடிவு செய்ய முடியாது.',
    cannotPermission: 'இந்தக் கோரிக்கைகளை நீங்கள் பார்க்கலாம், ஆனால் யாரை உள்ளே அனுமதிப்பது என்று உரிமையாளர் மட்டுமே முடிவு செய்வார்; அந்த அனுமதி உங்களிடம் இல்லை.',
    cannotNotConnected: 'தலைமை அலுவலகத்துடன் இணைக்கப்படவில்லை — இங்கே எதையும் முடிவு செய்ய முடியாது.',
    cannotNotRead: 'தலைமை அலுவலகம் இன்னும் பதில் சொல்லவில்லை, எனவே அது சொல்லும் வரை எதையும் முடிவு செய்ய முடியாது. “மீண்டும் சரிபார்” அழுத்தவும்.',
    decidedApproved: 'அனுமதிக்கப்பட்டது. {who} {minutes} நிமிடங்களுக்கு, {until} வரை, {scopes} பார்க்கலாம். அது தானாகவே முடிந்துவிடும்.',
    decidedRejected: 'மறுக்கப்பட்டது. {who} உள்ளே அனுமதிக்கப்படவில்லை.',
    decideNotWaiting: 'அந்தக் கோரிக்கை இனி காத்திருக்கவில்லை — ஏற்கனவே முடிவு செய்யப்பட்டிருக்கலாம். பட்டியல் மீண்டும் படிக்கப்பட்டது.',
    decideOwnRequest: 'இதைக் கேட்டது நீங்களே, எனவே வேறொருவர்தான் முடிவு செய்ய வேண்டும் (§28).',
    decideMinutesUnreadable: 'நிமிடங்களை 1 முதல் {asked} வரையிலான முழு எண்ணாக எழுதுங்கள் — அல்லது கேட்ட நேரத்தையே அனுமதிக்கப் பெட்டியைக் காலியாக விடுங்கள்.',
    decideLonger: 'நேரத்தைக் குறைக்க மட்டுமே முடியும், ஒருபோதும் நீட்டிக்க முடியாது. அவர்கள் கேட்டது {asked} நிமிடங்கள்; {typed} அதைவிட அதிகம்.',
    decideAlreadyDecided: 'இந்தக் கோரிக்கையை ஏற்கனவே ஒருவர் முடிவு செய்துவிட்டார்:',
    decideAlreadyDecidedNoWords: 'இந்தக் கோரிக்கையை ஏற்கனவே ஒருவர் முடிவு செய்துவிட்டார்.',
    decideUnknown: 'தலைமை அலுவலகத்தில் அப்படி ஒரு கோரிக்கை இல்லை — அது திரும்பப் பெறப்பட்டிருக்கலாம். பட்டியல் மீண்டும் படிக்கப்பட்டது.',
    decidePolicy: 'தலைமை அலுவலகத்தின் விதிகள் இதை மறுத்தன, யாரும் உள்ளே அனுமதிக்கப்படவில்லை:',
    decidePolicyNoWords: 'தலைமை அலுவலகத்தின் விதிகள் இதை மறுத்தன, யாரும் உள்ளே அனுமதிக்கப்படவில்லை.',
    decideForbidden: 'வெளியாட்கள் அணுகலை முடிவு செய்ய உங்களுக்கு அனுமதி இல்லை என்று தலைமை அலுவலகம் சொல்கிறது. எதுவும் முடிவு செய்யப்படவில்லை.',
    decideRefused: 'முடிவு பதிவு செய்யப்படவில்லை:',
    decideRefusedNoWords: 'முடிவு பதிவு செய்யப்படவில்லை — தலைமை அலுவலகம் அதை ஏற்கவில்லை.',
    decideLostLink: 'தலைமை அலுவலகத்துடன் இணைப்பு இல்லை — எதுவும் முடிவு செய்யப்படவில்லை. மீண்டும் முயற்சிக்கவும்.',
    endedNow: 'முடிக்கப்பட்டது. {at} முதல் {who} உங்கள் தகவலைப் பார்க்க முடியாது.',
    endNotLive: 'அந்த அமர்வு இப்போது நடப்பில் இல்லை — முடிக்க எதுவும் இல்லை. பட்டியல் மீண்டும் படிக்கப்பட்டது.',
    endUnknown: 'தலைமை அலுவலகத்தில் அப்படி ஒரு அமர்வு இல்லை. பட்டியல் மீண்டும் படிக்கப்பட்டது.',
    endForbidden: 'வெளியாட்கள் அணுகலை முடிக்க உங்களுக்கு அனுமதி இல்லை என்று தலைமை அலுவலகம் சொல்கிறது. அமர்வு முடிக்கப்படவில்லை.',
    endRefused: 'முடிக்கப்படவில்லை:',
    endRefusedNoWords: 'முடிக்கப்படவில்லை — தலைமை அலுவலகம் அதை ஏற்கவில்லை.',
    endLostLink: 'தலைமை அலுவலகத்துடன் இணைப்பு இல்லை — அமர்வு முடிக்கப்படவில்லை. மீண்டும் முயற்சிக்கவும்.',
    nothingSent: 'எதுவும் அனுப்பப்படவில்லை.',
  },
};

export const SUPPORT_COPY_KEYS: readonly SupportCopyKey[] = Object.freeze(Object.keys(SUPPORT_ACCESS_COPY.en) as SupportCopyKey[]);

const fill = (template: string, values: Readonly<Record<string, string>>): string =>
  template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);

// ── The presented shapes ─────────────────────────────────────────────────────────────────────────────────────

/** A support session as the screen shows it — and whether it is still access at all. */
export interface SupportView {
  readonly session: SupportSession;
  /**
   * Decided from the clock, every time this is read.
   *
   * Never a stored flag: a flag has to be turned off by something, and the something is exactly
   * what did not exist. An expired grant that still reads "active" is standing access.
   */
  readonly active: boolean;
  readonly minutesLeft: number;
  /** What it was allowed to touch. Blanket access cannot be granted, so this is never empty. */
  readonly scopes: readonly string[];
  readonly actionCount: number;
  /** Its window in shop time ("from … until …"). */
  readonly from: string;
  readonly until: string;
  /** When it was ended early, in shop time; null when it was not. */
  readonly endedAt: string | null;
}

/** One request waiting for the owner's decision, as the screen shows it. */
export interface WaitingRequestView {
  readonly requestId: string;
  readonly requesterId: string;
  readonly requesterName: string;
  readonly reason: string;
  readonly scopes: readonly string[];
  /** The minutes they asked for — the most an approval can allow. */
  readonly askedMinutes: number;
  /** When they asked, in shop time. */
  readonly askedAt: string;
  /** This person filed it — someone else must decide (§28). It is shown, never offered to decide. */
  readonly ownRequest: boolean;
}

/** The outside-access tab, as the screen paints it. */
export interface OutsideAccessView {
  /** Wired to head office's routes. Without it nothing is ever decided here. */
  readonly connected: boolean;
  /** Where the lists came from, in words — tone + icon + words, never colour alone. */
  readonly source: StatusPresentation;
  /** Whether Approve, Reject and End are offered at all. */
  readonly mayDecide: boolean;
  /** Why this person cannot decide here, in plain words; null when they can. */
  readonly cannotDecide: string | null;
  /** Whether head office has ever answered with its waiting list. Until it has, an empty list is NOT "nobody is waiting"
   *  — it is not known (P-08). */
  readonly waitingKnown: boolean;
  /** Head office's waiting requests, oldest first. Empty until head office has answered. */
  readonly waiting: readonly WaitingRequestView[];
  /** Live first, then most recent. */
  readonly sessions: readonly SupportView[];
  readonly liveCount: number;
}

/** What reading head office gave. */
export type SupportReadOutcome =
  | { readonly kind: 'read' }
  | { readonly kind: 'not_connected' }
  | { readonly kind: 'lost_link' }
  | { readonly kind: 'not_permitted_at_head_office'; readonly whatHappened: string }
  | { readonly kind: 'refused'; readonly code: string; readonly whatHappened: string };

/** The screen refused before anything was sent. */
type LocalRefusal =
  | { readonly kind: 'nobody_named' }
  | { readonly kind: 'not_permitted' }
  | { readonly kind: 'not_connected' }
  | { readonly kind: 'not_read' };

/** The outcome of pressing Approve or Reject. */
export type SupportDecideOutcome =
  | { readonly kind: 'approved'; readonly who: string; readonly minutes: number; readonly until: string; readonly scopes: readonly string[] }
  | { readonly kind: 'rejected'; readonly who: string }
  | LocalRefusal
  | { readonly kind: 'not_waiting' }
  | { readonly kind: 'own_request' }
  | { readonly kind: 'minutes_unreadable'; readonly asked: number }
  | { readonly kind: 'longer_than_asked'; readonly asked: number; readonly typed: number }
  | { readonly kind: 'already_decided'; readonly whatHappened: string }
  | { readonly kind: 'unknown_request'; readonly whatHappened: string }
  | { readonly kind: 'refused_by_policy'; readonly whatHappened: string }
  | { readonly kind: 'not_permitted_at_head_office'; readonly whatHappened: string }
  | { readonly kind: 'refused'; readonly code: string; readonly whatHappened: string }
  | { readonly kind: 'lost_link' };

/** The outcome of pressing "End it now". */
export type SupportEndOutcome =
  | { readonly kind: 'ended'; readonly who: string; readonly endedAt: string }
  | LocalRefusal
  | { readonly kind: 'not_live' }
  | { readonly kind: 'unknown_session'; readonly whatHappened: string }
  | { readonly kind: 'not_permitted_at_head_office'; readonly whatHappened: string }
  | { readonly kind: 'refused'; readonly code: string; readonly whatHappened: string }
  | { readonly kind: 'lost_link' };

/** Every decide outcome kind — the guardrail proves each has words in both languages. */
export const SUPPORT_DECIDE_OUTCOME_KINDS: readonly SupportDecideOutcome['kind'][] = Object.freeze([
  'approved', 'rejected', 'nobody_named', 'not_permitted', 'not_connected', 'not_read', 'not_waiting', 'own_request',
  'minutes_unreadable', 'longer_than_asked', 'already_decided', 'unknown_request', 'refused_by_policy',
  'not_permitted_at_head_office', 'refused', 'lost_link',
] as const);
/** Every end outcome kind. */
export const SUPPORT_END_OUTCOME_KINDS: readonly SupportEndOutcome['kind'][] = Object.freeze([
  'ended', 'nobody_named', 'not_permitted', 'not_connected', 'not_read', 'not_live', 'unknown_session',
  'not_permitted_at_head_office', 'refused', 'lost_link',
] as const);

export interface AdminSession {
  /** Who has access to what, and who should not (M02-FR-02/04). */
  access(): readonly AccessReviewRow[];
  /** Every support session the page knows of, live ones first, each judged against the clock. */
  support(): readonly SupportView[];
  /** True when this screen is wired to head office's support-access routes. */
  readonly connected: boolean;
  /** The outside-access words, in English or Tamil. */
  text(lang: Lang, key: SupportCopyKey): string;
  /** The outside-access tab: where the lists came from, what waits for a decision, who has been let in. */
  outside(lang: Lang): OutsideAccessView;
  /** Read head office's support-access state (a GET — writes nothing). */
  refreshSupport(): Promise<SupportReadOutcome>;
  /** The owner approves (optionally for fewer minutes — the box's raw text) or rejects a waiting request, in their own
   *  session. Refused locally — nothing sent — for the cheap things; otherwise head office decides, and the list is
   *  read again. */
  decideSupport(requestId: string, decision: SupportDecision, minutesTyped?: string): Promise<SupportDecideOutcome>;
  /** End a live session early, in the owner's own session. */
  endSupport(sessionId: string): Promise<SupportEndOutcome>;
  presentDecideOutcome(lang: Lang, outcome: SupportDecideOutcome): StatusPresentation;
  presentEndOutcome(lang: Lang, outcome: SupportEndOutcome): StatusPresentation;
  /** The fleet: what is running, what is out of date, what is blocked (M33). */
  fleet(): { readonly summary: FleetSummary | undefined; readonly verdicts: readonly DeviceDecision[]; readonly policyKnown: boolean };
  /**
   * What retention would do — and what a legal hold stops it doing.
   *
   * `undefined` when the shop has set no retention policy at all, which is **different from
   * nothing being due for deletion**: the first is a shop that has never decided, and a screen
   * showing "nothing to delete" for it would be reporting a decision nobody made.
   */
  retention(): RetentionPlan | undefined;
}

/** Head office's word on who lacks permission: the kernel's `forbidden`, or any 403 that came back without a code. */
const isForbidden = (code: string): boolean => code === 'forbidden' || code === 'http_403';

/** Where the support list stands: never asked, head office's answer, or why there is none. */
type SupportSource =
  | { readonly kind: 'not_connected' }
  | { readonly kind: 'not_read' }
  | { readonly kind: 'read' }
  | { readonly kind: 'lost_link' }
  | { readonly kind: 'not_permitted_at_head_office' }
  | { readonly kind: 'refused'; readonly whatHappened: string };

export function createAdminSession(config: AdminConfig, ports: AdminPorts): AdminSession {
  const port = ports.supportAccess;
  const connected = port !== undefined;
  /** Head office's last answer — kept across a later failed read, and said to be what it is. */
  let live: SupportAccessState | null = null;
  let source: SupportSource = connected ? { kind: 'not_read' } : { kind: 'not_connected' };
  /** A decision is only taken against a list head office has JUST given — never a stale one. */
  const fresh = (): boolean => source.kind === 'read' && live !== null;

  const viewOf = (session: SupportSession, at: string): SupportView => {
    const active = supportSessionActive(session, at);
    const msLeft = Date.parse(session.expiresAt) - Date.parse(at);
    return {
      session,
      active,
      minutesLeft: active ? Math.max(0, Math.floor(msLeft / 60_000)) : 0,
      scopes: session.scopes,
      actionCount: session.actions.length,
      from: shopTime(session.startedAt),
      until: shopTime(session.expiresAt),
      endedAt: session.endedAt === undefined ? null : shopTime(session.endedAt),
    };
  };

  // Live first, then most recent. A live session into a customer's data is the most urgent
  // thing on this screen, and a list ordered by date buries it under history.
  const support = (): readonly SupportView[] => {
    // Head office's list, judged against head office's own clock at the moment it answered; until it has answered,
    // the list the store computer last knew, judged against the store computer's.
    const state = live;
    const views = state === null
      ? ports.supportSessions().map((s) => viewOf(s, config.now))
      : state.sessions.map((s) => viewOf(s, state.asAt));
    return [...views].sort((a, b) =>
      (a.active === b.active ? 0 : a.active ? -1 : 1)
      || b.session.startedAt.localeCompare(a.session.startedAt));
  };

  const readNow = async (): Promise<SupportReadOutcome> => {
    if (port === undefined) return { kind: 'not_connected' };
    const r = await port.read();
    if (r.result === 'read') {
      live = r.state;
      source = { kind: 'read' };
      return { kind: 'read' };
    }
    if (r.result === 'lost_link') {
      source = { kind: 'lost_link' };
      return { kind: 'lost_link' };
    }
    if (isForbidden(r.code)) {
      // Not permitted to read: nothing head office said earlier is shown as current.
      live = null;
      source = { kind: 'not_permitted_at_head_office' };
      return { kind: 'not_permitted_at_head_office', whatHappened: r.whatHappened };
    }
    source = { kind: 'refused', whatHappened: r.whatHappened };
    return { kind: 'refused', code: r.code, whatHappened: r.whatHappened };
  };

  /** Why this person cannot decide here — or null when they can. Checked in the same order as every action. */
  const localRefusal = (): LocalRefusal | null => {
    if (config.userId === null) return { kind: 'nobody_named' };
    if (!ports.mayDecideSupport()) return { kind: 'not_permitted' };
    if (!connected) return { kind: 'not_connected' };
    if (!fresh()) return { kind: 'not_read' };
    return null;
  };

  const presentSource = (lang: Lang): StatusPresentation => {
    const t = translator(SUPPORT_ACCESS_COPY, lang);
    switch (source.kind) {
      case 'not_connected':
        return presentStatus({ tone: 'idle', icon: 'ℹ', label: t('sourceNotConnected'), needsAttention: false });
      case 'not_read':
        return presentScreenState({ state: 'pending', label: t('sourceChecking') });
      case 'read':
        return presentStatus({ tone: 'ok', icon: '✓', label: fill(t('sourceRead'), { at: shopTime(live?.asAt ?? null) }), needsAttention: false });
      case 'lost_link':
        return presentStatus({
          tone: 'degraded', icon: '⚠', needsAttention: true,
          label: live === null ? t('sourceLostLink') : fill(t('sourceLostLinkKnown'), { at: shopTime(live.asAt) }),
        });
      case 'not_permitted_at_head_office':
        return presentStatus({ tone: 'error', icon: '✕', label: t('sourceNotPermitted'), needsAttention: true });
      case 'refused': {
        const words = source.whatHappened.trim();
        return presentStatus({ tone: 'error', icon: '✕', needsAttention: true, label: words === '' ? t('sourceRefusedNoWords') : `${t('sourceRefused')} ${words}` });
      }
    }
  };

  const cannotWords = (lang: Lang, r: LocalRefusal): string => {
    const t = translator(SUPPORT_ACCESS_COPY, lang);
    switch (r.kind) {
      case 'nobody_named': return t('cannotNobody');
      case 'not_permitted': return t('cannotPermission');
      case 'not_connected': return t('cannotNotConnected');
      case 'not_read': return t('cannotNotRead');
    }
  };

  const session: AdminSession = {
    access: () => accessReview(ports.accounts(), config.now, config.dormantAfterDays),

    support,
    connected,

    text: (lang, key) => translator(SUPPORT_ACCESS_COPY, lang)(key),

    outside: (lang) => {
      const refusal = localRefusal();
      const waiting = (live?.pending ?? [])
        .slice()
        .sort((a, b) => a.at.localeCompare(b.at))
        .map((r): WaitingRequestView => ({
          requestId: r.requestId, requesterId: r.requesterId, requesterName: r.requesterName, reason: r.reason,
          scopes: r.scopes, askedMinutes: r.minutes, askedAt: shopTime(r.at),
          ownRequest: config.userId !== null && r.requesterId === config.userId,
        }));
      const sessions = support();
      return {
        connected,
        source: presentSource(lang),
        mayDecide: refusal === null,
        cannotDecide: refusal === null ? null : cannotWords(lang, refusal),
        waitingKnown: live !== null,
        waiting,
        sessions,
        liveCount: sessions.filter((s) => s.active).length,
      };
    },

    refreshSupport: () => readNow(),

    decideSupport: async (requestId, decision, minutesTyped) => {
      const refusal = localRefusal();
      if (refusal !== null) return refusal;
      if (port === undefined) return { kind: 'not_connected' };
      const request = live?.pending.find((r) => r.requestId === requestId);
      if (request === undefined) { await readNow(); return { kind: 'not_waiting' }; }
      // §28: the person who asked never decides it — and this screen never sends it to be refused.
      if (request.requesterId === config.userId) return { kind: 'own_request' };

      let grantedMinutes: number | undefined;
      if (decision === 'approved') {
        const typed = (minutesTyped ?? '').trim();
        if (typed !== '') {
          if (!/^\d+$/.test(typed) || Number(typed) < 1) return { kind: 'minutes_unreadable', asked: request.minutes };
          const minutes = Number(typed);
          // An approval may only SHORTEN the window — said here, in plain words, before anything is sent.
          if (minutes > request.minutes) return { kind: 'longer_than_asked', asked: request.minutes, typed: minutes };
          grantedMinutes = minutes;
        }
      }

      // The decider is the signed-in person: head office takes the caller. Nothing here names anybody.
      const r = await port.decide({ requestId, decision, ...(grantedMinutes === undefined ? {} : { grantedMinutes }) });
      if (r.result === 'lost_link') return { kind: 'lost_link' };
      // Head office answered: its list is read again, so what shows is what it now holds — never what the page assumed.
      await readNow();
      if (r.result === 'approved') {
        const minutes = Math.round((Date.parse(r.session.expiresAt) - Date.parse(r.session.startedAt)) / 60_000);
        return { kind: 'approved', who: request.requesterName, minutes, until: r.session.expiresAt, scopes: r.session.scopes };
      }
      if (r.result === 'rejected') return { kind: 'rejected', who: request.requesterName };
      if (r.code === 'support_request_already_decided') return { kind: 'already_decided', whatHappened: r.whatHappened };
      if (r.code === 'unknown_support_request') return { kind: 'unknown_request', whatHappened: r.whatHappened };
      if (r.code === 'support_access_refused') return { kind: 'refused_by_policy', whatHappened: r.whatHappened };
      if (isForbidden(r.code)) return { kind: 'not_permitted_at_head_office', whatHappened: r.whatHappened };
      return { kind: 'refused', code: r.code, whatHappened: r.whatHappened };
    },

    endSupport: async (sessionId) => {
      const refusal = localRefusal();
      if (refusal !== null) return refusal;
      if (port === undefined) return { kind: 'not_connected' };
      const target = support().find((v) => v.session.sessionId === sessionId);
      if (target === undefined || !target.active) { await readNow(); return { kind: 'not_live' }; }
      const r = await port.end({ sessionId });
      if (r.result === 'lost_link') return { kind: 'lost_link' };
      await readNow();
      if (r.result === 'ended') return { kind: 'ended', who: target.session.requesterName, endedAt: r.endedAt };
      if (r.code === 'unknown_support_session') return { kind: 'unknown_session', whatHappened: r.whatHappened };
      if (isForbidden(r.code)) return { kind: 'not_permitted_at_head_office', whatHappened: r.whatHappened };
      return { kind: 'refused', code: r.code, whatHappened: r.whatHappened };
    },

    presentDecideOutcome: (lang, o) => {
      const t = translator(SUPPORT_ACCESS_COPY, lang);
      const err = (label: string): StatusPresentation => presentStatus({ tone: 'error', icon: '✕', label, needsAttention: true });
      const warn = (label: string): StatusPresentation => presentStatus({ tone: 'degraded', icon: '⚠', label, needsAttention: true });
      const unsent = (label: string): string => `${label} ${t('nothingSent')}`;
      const withWords = (lead: string, noWords: string, words: string): string => (words.trim() === '' ? noWords : `${lead} ${words.trim()}`);
      switch (o.kind) {
        case 'approved':
          return presentStatus({
            tone: 'ok', icon: '✓', needsAttention: false,
            label: fill(t('decidedApproved'), { who: o.who, scopes: o.scopes.join(', '), minutes: String(o.minutes), until: shopTime(o.until) }),
          });
        case 'rejected':
          return presentStatus({ tone: 'ok', icon: '✓', needsAttention: false, label: fill(t('decidedRejected'), { who: o.who }) });
        case 'nobody_named':
        case 'not_permitted':
        case 'not_connected':
        case 'not_read':
          return err(unsent(cannotWords(lang, o)));
        case 'not_waiting': return warn(t('decideNotWaiting'));
        case 'own_request': return err(unsent(t('decideOwnRequest')));
        case 'minutes_unreadable': return err(unsent(fill(t('decideMinutesUnreadable'), { asked: String(o.asked) })));
        case 'longer_than_asked': return err(unsent(fill(t('decideLonger'), { asked: String(o.asked), typed: String(o.typed) })));
        case 'already_decided': return warn(withWords(t('decideAlreadyDecided'), t('decideAlreadyDecidedNoWords'), o.whatHappened));
        case 'unknown_request': return warn(t('decideUnknown'));
        case 'refused_by_policy': return err(withWords(t('decidePolicy'), t('decidePolicyNoWords'), o.whatHappened));
        case 'not_permitted_at_head_office': return err(t('decideForbidden'));
        case 'refused': return err(withWords(t('decideRefused'), t('decideRefusedNoWords'), o.whatHappened));
        case 'lost_link': return warn(t('decideLostLink'));
      }
    },

    presentEndOutcome: (lang, o) => {
      const t = translator(SUPPORT_ACCESS_COPY, lang);
      const err = (label: string): StatusPresentation => presentStatus({ tone: 'error', icon: '✕', label, needsAttention: true });
      const warn = (label: string): StatusPresentation => presentStatus({ tone: 'degraded', icon: '⚠', label, needsAttention: true });
      switch (o.kind) {
        case 'ended':
          return presentStatus({ tone: 'ok', icon: '✓', needsAttention: false, label: fill(t('endedNow'), { who: o.who, at: shopTime(o.endedAt) }) });
        case 'nobody_named':
        case 'not_permitted':
        case 'not_connected':
        case 'not_read':
          return err(`${cannotWords(lang, o)} ${t('nothingSent')}`);
        case 'not_live': return warn(t('endNotLive'));
        case 'unknown_session': return warn(t('endUnknown'));
        case 'not_permitted_at_head_office': return err(t('endForbidden'));
        case 'refused': return err(o.whatHappened.trim() === '' ? t('endRefusedNoWords') : `${t('endRefused')} ${o.whatHappened.trim()}`);
        case 'lost_link': return warn(t('endLostLink'));
      }
    },

    fleet: () => {
      const policy = ports.versionPolicy();
      const devices = ports.devices();
      // No policy means nothing is being enforced, and that is what the screen says — rather than
      // judging every device against a minimum version nobody has set, which would report a fleet
      // as compliant with a rule the shop never made.
      if (policy === undefined) return { summary: undefined, verdicts: [], policyKnown: false };
      return {
        summary: fleetSummary(devices, policy, config.now),
        verdicts: devices.map((device) => evaluateDevice(device, policy)),
        policyKnown: true,
      };
    },

    retention: () => {
      const policies = ports.retentionPolicies();
      if (policies.length === 0) return undefined;
      return planRetention(ports.auditRecords(), policies, ports.legalHolds(), config.now);
    },
  };

  return session;
}
