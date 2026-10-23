// The risk-acceptance screen — the compliance owner's gate-blocker desk (M34-FR-04 · API-11 · P-03
// control-by-exception · §28 traceable approvals). An open, CRITICAL risk blocks the quality gates it is
// registered against; a gate that cannot pass while nobody has decided what to do about the risk is the exact
// thing "control by exception" exists to surface. The cloud folds the blocked gates into a worklist
// (`GET /v1/compliance/gates/blocked`, one row per gate × open-critical risk); this is the screen that works
// them, and the one action from here — ACCEPT a risk, in the accepter's own name, with a written rationale,
// which unblocks its gate.
//
// Three truths the screen must carry, all already true in the engine and re-stated here so the surface cannot
// weaken them:
//   • **It self-heals.** The worklist is re-READ from the cloud, so an accepted risk's gate-blocks drop off on
//     their own; this screen never carries a "done" flag that could go stale against reality.
//   • **Acceptance is a NAMED, REASONED decision, never silence** (§28 / hard rule #6). Accepting records WHO
//     accepted (the caller's own login, never typed in) and WHY (a mandatory rationale); the screen refuses an
//     empty rationale locally, and the engine refuses a blank name or reason server-side.
//   • **Nothing is overwritten.** Acceptance is a new append-only fact on the risk; the register is not edited.
//
// OB-330 (owner, 23 Oct 2026 · §35.1): a critical or high risk is accepted only with TWO signatures — the owner's and the
// named security reviewer's, each in their own session. The screen says who the reviewer is (or that nobody is named, so
// a critical or high risk must be FIXED, not accepted); lets the owner name the reviewer on screen (never in code); and
// offers the one signature the viewer may give: "Sign as owner" or "Sign as security reviewer". A first signature is
// said as waiting for the second; only both together accept the risk (the server decides; the screen shows its answer).
//
// Like every ERP screen the rules live here in a tested, DOM-free session model on the shared packages/ui
// primitives (colour is never the only signal — an icon and a word ride with every tone); the shell only
// renders what this hands over. No AI accepts a risk (hard rule #5).

import { translator, presentScreenState, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { presentStatus, type StatusPresentation } from '../../../packages/a11y/src/signals';

/** One blocked gate as the worklist route hands it over (`GET /v1/compliance/gates/blocked` → `blocked[]`) —
 *  one row per (gate, open-critical risk). Mirrors the engine's `GateBlock`. */
export interface GateBlockView {
  readonly gate: string;
  readonly riskId: string;
  readonly title: string;
  readonly severity: string;
  readonly ownerUserId: string;
  readonly reason: string;
}

/** The worklist body (`GET /v1/compliance/gates/blocked`). Only gates blocked RIGHT NOW; an accepted risk's
 *  blocks are gone from the next read. */
export interface BlockedGatesData {
  readonly count: number;
  readonly blocked: readonly GateBlockView[];
}

/** The outcome of an acceptance — recorded, refused by the server (blank name/reason, permission), or a lost
 *  link. */
export type AcceptResult = 'accepted' | 'awaiting_second_signature' | 'must_be_fixed' | 'refused' | 'lost_link';

/** OB-330: where acceptance stands (`GET /v1/compliance/risk-acceptances`) — the reviewer named, and each risk's signatures. */
export interface AcceptanceState {
  readonly reviewer: { readonly userId: string; readonly displayName: string } | null;
  readonly risks: readonly { readonly riskId: string; readonly owner: string | null; readonly securityReviewer: string | null }[];
}

/** OB-330: the owner's naming of the security reviewer (`PUT /v1/compliance/security-reviewer`). */
export type NameResult = 'named' | 'refused' | 'lost_link';
export interface ReviewerNamePort {
  put(input: { readonly userId: string; readonly displayName: string; readonly reason: string }): Promise<NameResult>;
}

/** The authenticated POST of an acceptance decision. Injected, so the model never opens a socket itself; the
 *  server records the acceptance in the caller's own name and enforces the name+rationale rule. */
export interface RiskAcceptPort {
  post(input: { readonly riskId: string; readonly rationale: string }): Promise<AcceptResult>;
}

export interface RiskAcceptancePorts {
  /** The blocked-gates worklist the shell last read (live from the cloud, or the injected stand-in). */
  worklist(): BlockedGatesData;
  /** Whether this user may read the compliance worklist (`compliance.risk.read`). */
  mayRead(): boolean;
  /** Whether this user may accept a risk (`compliance.risk.manage`). */
  mayManage(): boolean;
  /** Records an acceptance. Only reached from the explicit action, never on render. */
  acceptPort(): RiskAcceptPort;
  /** OB-330: where acceptance stands, as last read live — undefined when it could not be read (said as "not known"). */
  acceptances?(): AcceptanceState | undefined;
  /** OB-330: may this user name the security reviewer (`compliance.reviewer.name`, the owner's)? */
  mayNameReviewer?(): boolean;
  /** OB-330: the reviewer's own signature (`POST …/acceptance/review`). */
  reviewPort?(): RiskAcceptPort;
  /** OB-330: the owner's naming of the reviewer. */
  namePort?(): ReviewerNamePort;
}

export interface RiskAcceptanceConfig {
  /** Who is looking. `null` means the store computer was not told who is at the screen; an acceptance carries
   *  the accepter's name, so the screen surfaces when nobody is named. */
  readonly userId: string | null;
}

// ── the copy: ONE bilingual object for the whole screen ───────────────────────────────────────────────────

export type CopyKey =
  | 'title' | 'lead' | 'langName'
  | 'severityCritical' | 'severityHigh'
  | 'openHeading' | 'blockedCount' | 'gatesLabel' | 'allClear'
  | 'gateLabel' | 'riskLabel' | 'ownerLabel' | 'reasonLabel'
  | 'acceptHeading' | 'riskChoiceLabel' | 'rationaleLabel' | 'rationalePlaceholder' | 'acceptBtn'
  | 'acceptRecorded' | 'acceptRefused' | 'acceptLostLink'
  | 'scrReady' | 'scrEmpty' | 'stateNotPermitted' | 'noManage'
  | 'nobodyNamed' | 'staleShell' | 'sampleData'
  | 'reviewerHeading' | 'reviewerNamed' | 'reviewerNotNamed' | 'reviewerNotKnown' | 'signOwnerBtn' | 'signReviewerBtn'
  | 'awaitingSecond' | 'mustBeFixed' | 'signedOwner' | 'signedReviewer' | 'notSignedYet'
  | 'nameHeading' | 'reviewerIdLabel' | 'reviewerNameLabel' | 'reviewerReasonLabel' | 'nameBtn' | 'nameRecorded' | 'nameRefused';

export const RISK_ACCEPTANCE_COPY: BilingualCopy<CopyKey> = {
  en: {
    title: 'Risk acceptance', langName: 'தமிழ்',
    lead: 'Quality gates that cannot pass right now because an open, serious risk is registered against them. Nothing here is deleted: accepting a risk records — in your name and with a written reason — that the business is knowingly carrying it, which lets its gate pass. If a risk should not be carried, fix or close it instead; do not accept it.',
    severityCritical: 'Critical', severityHigh: 'High',
    openHeading: 'Blocking a gate', blockedCount: 'gates blocked', gatesLabel: 'Blocked gates',
    allClear: 'No gates blocked — every gate can pass.',
    gateLabel: 'Gate', riskLabel: 'Risk', ownerLabel: 'Risk owner', reasonLabel: 'Why it blocks',
    acceptHeading: 'Accept a risk', riskChoiceLabel: 'Which risk', rationaleLabel: 'Why you are accepting it (this is the record)',
    rationalePlaceholder: 'Why is the business knowingly carrying this risk?',
    acceptBtn: 'Accept the risk',
    acceptRecorded: 'Risk accepted.',
    acceptRefused: 'Could not accept — an acceptance needs a written reason and is recorded in your name; or you do not have permission.',
    acceptLostLink: 'No connection — not saved. Try again.',
    scrReady: 'Showing the blocked gates', scrEmpty: 'No gates blocked — every gate can pass.',
    stateNotPermitted: 'You do not have permission to see the compliance gates.',
    noManage: 'You can see the blocked gates, but accepting a risk needs compliance permission.',
    nobodyNamed: 'This store computer has not been told who is using this screen.',
    staleShell: 'No connection to the store computer. This page is what it was last told, at', sampleData: 'Sample data — this is not your shop.',
    reviewerHeading: 'Security reviewer',
    reviewerNamed: 'A critical or high risk is accepted only when the owner AND the security reviewer both sign. Security reviewer:',
    reviewerNotNamed: 'No security reviewer is named. A critical or high risk cannot be accepted — it must be fixed. The owner names the reviewer below.',
    reviewerNotKnown: 'Head office could not be read, so who the security reviewer is, and what is signed, is not known here.',
    signOwnerBtn: 'Sign as owner', signReviewerBtn: 'Sign as security reviewer',
    awaitingSecond: 'Your signature is recorded. The risk is not accepted until the second person signs.',
    mustBeFixed: 'Not accepted — no security reviewer is named, so this risk must be fixed.',
    signedOwner: 'Owner signed', signedReviewer: 'Security reviewer signed', notSignedYet: 'not yet',
    nameHeading: 'Name the security reviewer', reviewerIdLabel: 'Their sign-in (user id)', reviewerNameLabel: 'Their name, as you know them',
    reviewerReasonLabel: 'Why this person (kept on the record)', nameBtn: 'Name the reviewer',
    nameRecorded: 'The security reviewer is named.', nameRefused: 'Not named — head office refused it (they need their own sign-in that may read the risk register, and cannot be you).',
  },
  ta: {
    title: 'இடர் ஏற்பு', langName: 'English',
    lead: 'ஒரு திறந்த, தீவிர இடர் பதிவு செய்யப்பட்டிருப்பதால் இப்போது கடக்க முடியாத தர வாயில்கள். இங்கு எதுவும் அழிக்கப்படாது: ஒரு இடரை ஏற்பது — உங்கள் பெயரிலும் எழுத்துப்பூர்வக் காரணத்துடனும் — வணிகம் அதை அறிந்தே சுமக்கிறது என்பதைப் பதிவு செய்து அதன் வாயிலைக் கடக்க அனுமதிக்கிறது. ஒரு இடரைச் சுமக்கக் கூடாது என்றால், அதை ஏற்காமல் சரிசெய்யவும் அல்லது மூடவும்.',
    severityCritical: 'தீவிரம்', severityHigh: 'உயர்',
    openHeading: 'ஒரு வாயிலைத் தடுக்கிறது', blockedCount: 'வாயில்கள் தடுக்கப்பட்டன', gatesLabel: 'தடுக்கப்பட்ட வாயில்கள்',
    allClear: 'தடுக்கப்பட்ட வாயில்கள் இல்லை — எல்லா வாயில்களும் கடக்கலாம்.',
    gateLabel: 'வாயில்', riskLabel: 'இடர்', ownerLabel: 'இடர் உரிமையாளர்', reasonLabel: 'ஏன் தடுக்கிறது',
    acceptHeading: 'ஒரு இடரை ஏற்று', riskChoiceLabel: 'எந்த இடர்', rationaleLabel: 'நீங்கள் ஏன் ஏற்கிறீர்கள் (இதுவே பதிவு)',
    rationalePlaceholder: 'இந்த இடரை வணிகம் ஏன் அறிந்தே சுமக்கிறது?',
    acceptBtn: 'இடரை ஏற்று',
    acceptRecorded: 'இடர் ஏற்கப்பட்டது.',
    acceptRefused: 'ஏற்க முடியவில்லை — ஏற்புக்கு எழுத்துப்பூர்வக் காரணம் தேவை, உங்கள் பெயரில் பதிவாகும்; அல்லது உங்களுக்கு அனுமதி இல்லை.',
    acceptLostLink: 'இணைப்பு இல்லை — சேமிக்கப்படவில்லை. மீண்டும் முயற்சிக்கவும்.',
    scrReady: 'தடுக்கப்பட்ட வாயில்களைக் காட்டுகிறது', scrEmpty: 'தடுக்கப்பட்ட வாயில்கள் இல்லை — எல்லா வாயில்களும் கடக்கலாம்.',
    stateNotPermitted: 'இணக்க வாயில்களைப் பார்க்க உங்களுக்கு அனுமதி இல்லை.',
    noManage: 'தடுக்கப்பட்ட வாயில்களைப் பார்க்கலாம், ஆனால் இடரை ஏற்க இணக்க அனுமதி தேவை.',
    nobodyNamed: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை.',
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:', sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
    reviewerHeading: 'பாதுகாப்புச் சரிபார்ப்பாளர்',
    reviewerNamed: 'உரிமையாளரும் பாதுகாப்புச் சரிபார்ப்பாளரும் இருவரும் கையொப்பமிட்டால் மட்டுமே தீவிர அல்லது உயர் இடர் ஏற்கப்படும். பாதுகாப்புச் சரிபார்ப்பாளர்:',
    reviewerNotNamed: 'பாதுகாப்புச் சரிபார்ப்பாளர் யாரும் பெயரிடப்படவில்லை. தீவிர அல்லது உயர் இடரை ஏற்க முடியாது — அதைச் சரிசெய்ய வேண்டும். உரிமையாளர் கீழே சரிபார்ப்பாளரைப் பெயரிடுவார்.',
    reviewerNotKnown: 'தலைமை அலுவலகத்திலிருந்து படிக்க முடியவில்லை, எனவே பாதுகாப்புச் சரிபார்ப்பாளர் யார், எது கையொப்பமிடப்பட்டது என்பது இங்கே தெரியவில்லை.',
    signOwnerBtn: 'உரிமையாளராகக் கையொப்பமிடு', signReviewerBtn: 'பாதுகாப்புச் சரிபார்ப்பாளராகக் கையொப்பமிடு',
    awaitingSecond: 'உங்கள் கையொப்பம் பதிவாகியது. இரண்டாவது நபர் கையொப்பமிடும் வரை இடர் ஏற்கப்படாது.',
    mustBeFixed: 'ஏற்கப்படவில்லை — பாதுகாப்புச் சரிபார்ப்பாளர் பெயரிடப்படவில்லை, எனவே இந்த இடரைச் சரிசெய்ய வேண்டும்.',
    signedOwner: 'உரிமையாளர் கையொப்பமிட்டார்', signedReviewer: 'பாதுகாப்புச் சரிபார்ப்பாளர் கையொப்பமிட்டார்', notSignedYet: 'இன்னும் இல்லை',
    nameHeading: 'பாதுகாப்புச் சரிபார்ப்பாளரைப் பெயரிடு', reviewerIdLabel: 'அவருடைய உள்நுழைவு (பயனர் அடையாளம்)', reviewerNameLabel: 'உங்களுக்குத் தெரிந்த அவருடைய பெயர்',
    reviewerReasonLabel: 'ஏன் இவர் (பதிவில் வைக்கப்படும்)', nameBtn: 'சரிபார்ப்பாளரைப் பெயரிடு',
    nameRecorded: 'பாதுகாப்புச் சரிபார்ப்பாளர் பெயரிடப்பட்டார்.', nameRefused: 'பெயரிடப்படவில்லை — தலைமை அலுவலகம் மறுத்தது (அவருக்கு இடர் பதிவேட்டைப் படிக்கக்கூடிய சொந்த உள்நுழைவு வேண்டும், அவர் நீங்களாக இருக்கக் கூடாது).',
  },
};

export const COPY_KEYS: readonly CopyKey[] = Object.freeze(Object.keys(RISK_ACCEPTANCE_COPY.en) as CopyKey[]);

// ── the presented shapes the view renders ────────────────────────────────────────────────────────────────

export interface PresentedBlock {
  readonly gate: string;
  readonly riskId: string;
  readonly title: string;
  readonly severity: string;
  readonly ownerUserId: string;
  readonly reason: string;
  /** Every blocked gate needs attention (P-03) — a degraded tone with an icon and word, never colour alone. */
  readonly status: StatusPresentation;
  readonly needsAttention: boolean;
  /** OB-330: the two signatures on this risk's acceptance, in words (null when not known). */
  readonly signatures: string | null;
}

/** One distinct risk the accepter can pick, for the dropdown (a risk may block several gates — one entry). */
export interface RiskChoice {
  readonly riskId: string;
  readonly label: string;
}

export interface RiskAcceptanceView {
  readonly screenState: StatusPresentation;
  readonly blocked: readonly PresentedBlock[];
  readonly blockedCount: number;
  /** The distinct risks behind the blocked gates — what the accept action can target. */
  readonly risks: readonly RiskChoice[];
  readonly nobodyNamed: boolean;
  /** Whether to offer the accept action — this user holds `compliance.risk.manage`. */
  readonly mayManage: boolean;
  /** OB-330: the security reviewer, in words, with its state (named / not named → must be fixed / not known). */
  readonly reviewer: { readonly state: 'named' | 'not_named' | 'not_known'; readonly words: string; readonly status: StatusPresentation };
  /** OB-330: the one signature this viewer may give — the named reviewer signs as reviewer, a compliance manager as owner. */
  readonly actingAs: 'owner' | 'security_reviewer' | 'none';
  /** The accept button's words for that signature. */
  readonly acceptLabel: string;
  /** OB-330: whether to offer the naming form (the owner's). */
  readonly mayNameReviewer: boolean;
}

export interface RiskAcceptanceSession {
  text(lang: Lang, key: CopyKey): string;
  view(lang: Lang): RiskAcceptanceView;
  /** Accept a risk, in the accepter's name — a HUMAN write (§28, append-only). Runs only from an explicit
   *  action, never on render; refuses BEFORE any POST without permission or a rationale (the server also
   *  enforces the name+reason rule; the screen never fabricates a reason). */
  accept(riskId: string, rationale: string): Promise<AcceptResult>;
  /** Present an acceptance outcome as one glanceable status the shell shows after the action. */
  presentAcceptResult(lang: Lang, result: AcceptResult): StatusPresentation;
  /** OB-330: the owner names the security reviewer — refused locally without the right or any field; then the port. */
  nameReviewer(userId: string, displayName: string, reason: string): Promise<NameResult>;
  presentNameResult(lang: Lang, result: NameResult): StatusPresentation;
}

type ViewExtras = Pick<RiskAcceptanceView, 'reviewer' | 'actingAs' | 'acceptLabel' | 'mayNameReviewer'>;
const EMPTY_VIEW = (screenState: StatusPresentation, nobodyNamed: boolean, mayManage: boolean, extras: ViewExtras): RiskAcceptanceView => ({
  screenState, blocked: [], blockedCount: 0, risks: [], nobodyNamed, mayManage, ...extras,
});

const SEVERITY_COPY: Readonly<Record<string, CopyKey>> = { critical: 'severityCritical', high: 'severityHigh' };

export function createRiskAcceptanceSession(config: RiskAcceptanceConfig, ports: RiskAcceptancePorts): RiskAcceptanceSession {
  const text = (lang: Lang, key: CopyKey): string => translator(RISK_ACCEPTANCE_COPY, lang)(key);

  /** OB-330: who the viewer signs as — the named reviewer as reviewer; a compliance manager as owner (the server checks). */
  const actingAs = (): 'owner' | 'security_reviewer' | 'none' => {
    const reviewer = ports.acceptances?.()?.reviewer;
    if (reviewer != null && config.userId !== null && reviewer.userId === config.userId) return 'security_reviewer';
    return ports.mayManage() ? 'owner' : 'none';
  };
  const extras = (lang: Lang): ViewExtras => {
    const t = translator(RISK_ACCEPTANCE_COPY, lang);
    const state = ports.acceptances?.();
    const as = actingAs();
    const reviewer = state === undefined
      ? { state: 'not_known' as const, words: t('reviewerNotKnown'), status: presentStatus({ tone: 'idle', icon: '?', label: t('reviewerNotKnown'), needsAttention: true }) }
      : state.reviewer === null
        ? { state: 'not_named' as const, words: t('reviewerNotNamed'), status: presentStatus({ tone: 'error', icon: '✕', label: t('reviewerNotNamed'), needsAttention: true }) }
        : { state: 'named' as const, words: `${t('reviewerNamed')} ${state.reviewer.displayName} (${state.reviewer.userId})`, status: presentStatus({ tone: 'ok', icon: '✓', label: `${t('reviewerHeading')}: ${state.reviewer.displayName}`, needsAttention: false }) };
    return { reviewer, actingAs: as, acceptLabel: as === 'security_reviewer' ? t('signReviewerBtn') : t('signOwnerBtn'), mayNameReviewer: ports.mayNameReviewer?.() ?? false };
  };
  const signaturesOf = (lang: Lang, riskId: string): string | null => {
    const state = ports.acceptances?.();
    if (state === undefined) return null;
    const t = translator(RISK_ACCEPTANCE_COPY, lang);
    const r = state.risks.find((x) => x.riskId === riskId);
    return `${t('signedOwner')}: ${r?.owner ?? t('notSignedYet')} · ${t('signedReviewer')}: ${r?.securityReviewer ?? t('notSignedYet')}`;
  };

  const present = (lang: Lang, b: GateBlockView): PresentedBlock => {
    const t = translator(RISK_ACCEPTANCE_COPY, lang);
    // The blocked gates are, by the route's definition, open + critical or high (§22 QG-06) — so the word is one of those two.
    // Fall back to the raw code if a future severity ever appears, so nothing renders blank.
    const severityWord = SEVERITY_COPY[b.severity] ? t(SEVERITY_COPY[b.severity]!) : b.severity;
    return {
      gate: b.gate,
      riskId: b.riskId,
      title: b.title,
      severity: severityWord,
      ownerUserId: b.ownerUserId,
      reason: b.reason,
      // Every blocked gate is work — a degraded tone that asks for a glance (P-03). Colour is never the only
      // signal: an icon and the severity word ride with it.
      status: presentStatus({ tone: 'degraded', icon: '⚠', label: severityWord, announcement: `${severityWord}: ${b.title} — ${b.gate}`, needsAttention: true }),
      needsAttention: true,
      signatures: signaturesOf(lang, b.riskId),
    };
  };

  return {
    text,
    view: (lang) => {
      const t = translator(RISK_ACCEPTANCE_COPY, lang);
      const nobodyNamed = config.userId === null;
      const mayManage = ports.mayManage();

      if (!ports.mayRead()) {
        return EMPTY_VIEW(presentScreenState({ state: 'error', label: t('stateNotPermitted') }), nobodyNamed, mayManage, extras(lang));
      }

      const worklist = ports.worklist();
      const blocked = worklist.blocked.map((b) => present(lang, b));
      // Distinct risks (a risk may block several gates) — one dropdown entry each, first-seen order preserved.
      const seen = new Set<string>();
      const risks: RiskChoice[] = [];
      for (const b of worklist.blocked) {
        if (!seen.has(b.riskId)) { seen.add(b.riskId); risks.push({ riskId: b.riskId, label: `${b.title} (${b.riskId})` }); }
      }
      const state = blocked.length === 0 ? 'empty' : 'ready';
      return {
        screenState: presentScreenState({ state, label: t(state === 'empty' ? 'scrEmpty' : 'scrReady') }),
        blocked,
        blockedCount: blocked.length,
        risks,
        nobodyNamed,
        mayManage,
        ...extras(lang),
      };
    },

    // Accept a risk. Refuse BEFORE any POST — no permission or an empty rationale is a local refusal, not a
    // round trip. The server still records the acceptance in the accepter's own name and enforces the
    // name+reason rule; the screen never fabricates the reason.
    accept: async (riskId, rationale) => {
      const as = actingAs();
      if (as === 'none' || riskId.trim() === '' || rationale.trim() === '') return 'refused';
      // OB-330: the named reviewer's signature goes to the reviewer's route; anyone else's is the owner's signature.
      if (as === 'security_reviewer') return ports.reviewPort === undefined ? 'refused' : ports.reviewPort().post({ riskId, rationale: rationale.trim() });
      return ports.acceptPort().post({ riskId, rationale: rationale.trim() });
    },

    nameReviewer: async (userId, displayName, reason) => {
      if (!(ports.mayNameReviewer?.() ?? false) || ports.namePort === undefined) return 'refused';
      if (userId.trim() === '' || displayName.trim() === '' || reason.trim() === '') return 'refused';
      return ports.namePort().put({ userId: userId.trim(), displayName: displayName.trim(), reason: reason.trim() });
    },

    presentNameResult: (lang, result) => {
      const t = translator(RISK_ACCEPTANCE_COPY, lang);
      if (result === 'named') return presentStatus({ tone: 'ok', icon: '✓', label: t('nameRecorded'), needsAttention: false });
      if (result === 'lost_link') return presentStatus({ tone: 'degraded', icon: '⚠', label: t('acceptLostLink'), needsAttention: true });
      return presentStatus({ tone: 'error', icon: '✕', label: t('nameRefused'), needsAttention: true });
    },

    presentAcceptResult: (lang, result) => {
      const t = translator(RISK_ACCEPTANCE_COPY, lang);
      if (result === 'accepted') return presentStatus({ tone: 'ok', icon: '✓', label: t('acceptRecorded'), needsAttention: false });
      if (result === 'awaiting_second_signature') return presentStatus({ tone: 'degraded', icon: '✍', label: t('awaitingSecond'), needsAttention: true });
      if (result === 'must_be_fixed') return presentStatus({ tone: 'error', icon: '✕', label: t('mustBeFixed'), needsAttention: true });
      if (result === 'lost_link') return presentStatus({ tone: 'degraded', icon: '⚠', label: t('acceptLostLink'), needsAttention: true });
      return presentStatus({ tone: 'error', icon: '✕', label: t('acceptRefused'), needsAttention: true });
    },
  };
}
