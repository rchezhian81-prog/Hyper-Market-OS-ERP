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
export type AcceptResult = 'accepted' | 'refused' | 'lost_link';

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
}

export interface RiskAcceptanceConfig {
  /** Who is looking. `null` means the store computer was not told who is at the screen; an acceptance carries
   *  the accepter's name, so the screen surfaces when nobody is named. */
  readonly userId: string | null;
}

// ── the copy: ONE bilingual object for the whole screen ───────────────────────────────────────────────────

export type CopyKey =
  | 'title' | 'lead' | 'langName'
  | 'severityCritical'
  | 'openHeading' | 'blockedCount' | 'gatesLabel' | 'allClear'
  | 'gateLabel' | 'riskLabel' | 'ownerLabel' | 'reasonLabel'
  | 'acceptHeading' | 'riskChoiceLabel' | 'rationaleLabel' | 'rationalePlaceholder' | 'acceptBtn'
  | 'acceptRecorded' | 'acceptRefused' | 'acceptLostLink'
  | 'scrReady' | 'scrEmpty' | 'stateNotPermitted' | 'noManage'
  | 'nobodyNamed' | 'staleShell' | 'sampleData';

export const RISK_ACCEPTANCE_COPY: BilingualCopy<CopyKey> = {
  en: {
    title: 'Risk acceptance', langName: 'தமிழ்',
    lead: 'Quality gates that cannot pass right now because an open, serious risk is registered against them. Nothing here is deleted: accepting a risk records — in your name and with a written reason — that the business is knowingly carrying it, which lets its gate pass. If a risk should not be carried, fix or close it instead; do not accept it.',
    severityCritical: 'Critical',
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
  },
  ta: {
    title: 'இடர் ஏற்பு', langName: 'English',
    lead: 'ஒரு திறந்த, தீவிர இடர் பதிவு செய்யப்பட்டிருப்பதால் இப்போது கடக்க முடியாத தர வாயில்கள். இங்கு எதுவும் அழிக்கப்படாது: ஒரு இடரை ஏற்பது — உங்கள் பெயரிலும் எழுத்துப்பூர்வக் காரணத்துடனும் — வணிகம் அதை அறிந்தே சுமக்கிறது என்பதைப் பதிவு செய்து அதன் வாயிலைக் கடக்க அனுமதிக்கிறது. ஒரு இடரைச் சுமக்கக் கூடாது என்றால், அதை ஏற்காமல் சரிசெய்யவும் அல்லது மூடவும்.',
    severityCritical: 'தீவிரம்',
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
}

const EMPTY_VIEW = (screenState: StatusPresentation, nobodyNamed: boolean, mayManage: boolean): RiskAcceptanceView => ({
  screenState, blocked: [], blockedCount: 0, risks: [], nobodyNamed, mayManage,
});

const SEVERITY_COPY: Readonly<Record<string, CopyKey>> = { critical: 'severityCritical' };

export function createRiskAcceptanceSession(config: RiskAcceptanceConfig, ports: RiskAcceptancePorts): RiskAcceptanceSession {
  const text = (lang: Lang, key: CopyKey): string => translator(RISK_ACCEPTANCE_COPY, lang)(key);

  const present = (lang: Lang, b: GateBlockView): PresentedBlock => {
    const t = translator(RISK_ACCEPTANCE_COPY, lang);
    // The blocked gates are, by the route's definition, open + critical — so the severity word is "critical".
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
    };
  };

  return {
    text,
    view: (lang) => {
      const t = translator(RISK_ACCEPTANCE_COPY, lang);
      const nobodyNamed = config.userId === null;
      const mayManage = ports.mayManage();

      if (!ports.mayRead()) {
        return EMPTY_VIEW(presentScreenState({ state: 'error', label: t('stateNotPermitted') }), nobodyNamed, mayManage);
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
      };
    },

    // Accept a risk. Refuse BEFORE any POST — no permission or an empty rationale is a local refusal, not a
    // round trip. The server still records the acceptance in the accepter's own name and enforces the
    // name+reason rule; the screen never fabricates the reason.
    accept: async (riskId, rationale) => {
      if (!ports.mayManage() || riskId.trim() === '' || rationale.trim() === '') return 'refused';
      return ports.acceptPort().post({ riskId, rationale: rationale.trim() });
    },

    presentAcceptResult: (lang, result) => {
      const t = translator(RISK_ACCEPTANCE_COPY, lang);
      if (result === 'accepted') return presentStatus({ tone: 'ok', icon: '✓', label: t('acceptRecorded'), needsAttention: false });
      if (result === 'lost_link') return presentStatus({ tone: 'degraded', icon: '⚠', label: t('acceptLostLink'), needsAttention: true });
      return presentStatus({ tone: 'error', icon: '✕', label: t('acceptRefused'), needsAttention: true });
    },
  };
}
