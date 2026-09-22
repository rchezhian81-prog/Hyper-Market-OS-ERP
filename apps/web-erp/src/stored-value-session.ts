// The stored-value oversight desk — the manager / accountant's control-by-exception screen for the
// money the shop OWES on gift cards and store credit (M17-FR-03/04 · P-03 · hard rule #10 · §28). Every
// unspent rupee on a gift card is a liability, and stored value is where quiet loss hides: a card spent
// twice while two channels were out of sync, a balance that has drifted from what the books posted, an
// instrument being drained unusually fast. This screen folds the three cloud oversight feeds — all on
// the loss/books gate `lp.case.read`, NOT the cashier's balance read (P-04) — into ONE worst-first view:
//
//   • **Given away twice** (`GET /v1/stored-value/households/:ownerRef/double-spends`, `findDoubleSpends`)
//     — an instrument that went past zero once every channel's movements arrived. This is REAL money the
//     shop paid out twice; both redemptions are kept and both channels named (hard rule #10 — never a
//     silent last-write-wins). Ranked first, biggest overspend at the top: it is settled loss, not a risk.
//   • **Unrecorded debt** (`GET /v1/stored-value/liability?posted=<minor>`, `reconcileLiability`) — the
//     outstanding stored value folded from movements, compared EXACTLY against the liability the accounts
//     posted; any gap is named WITH ITS SIGN, the same discipline as a period-close control total. Needs
//     the posted figure to compare against — until one is entered the reconciliation is simply absent, not
//     guessed "about right".
//   • **Draining fast** (`GET /v1/stored-value/velocity`, `flagVelocity`) — instruments redeemed unusually
//     many times in a short window. DETECT-ONLY: it blocks nothing (a genuine customer spending a large
//     card across a big shop looks identical), it asks a person to look — so it rides a watch tone, below
//     the settled losses above.
//
// Like every ERP screen the rules live here in a tested, DOM-free session model on the shared
// packages/ui + packages/a11y primitives (colour is NEVER the only signal — an icon and a word ride with
// every tone). This is a READ surface: it shows exposure and asks for a human's eyes; it commits nothing.

import { translator, presentScreenState, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { presentStatus, type StatusPresentation } from '../../../packages/a11y/src/signals';

// ── the raw feeds, exactly as the cloud hands them over (the screen consumes the served JSON) ───────────

/** The liability reconciliation body (`GET /v1/stored-value/liability`). Present only when a posted
 *  figure has been supplied to compare against; absent otherwise (never a guessed reconciliation). */
export interface LiabilityReconciliationView {
  readonly outstandingMinor: number;
  readonly issuedMinor: number;
  readonly redeemedMinor: number;
  readonly expiredMinor: number;
  readonly postedLiabilityMinor: number;
  /** posted − outstanding, WITH ITS SIGN: positive = the books carry more than the cards owe; negative =
   *  unrecorded debt the books are missing. Zero = reconciled. */
  readonly differenceMinor: number;
  readonly reconciles: boolean;
  readonly detail: string;
}

/** One instrument spent past zero across channels (`…/double-spends`) — settled loss, both sides kept. */
export interface DoubleSpendView {
  readonly instrumentId: string;
  readonly ownerRef: string;
  /** How far past zero it went — real money the shop gave away twice. */
  readonly overspentMinor: number;
  readonly channels: readonly string[];
  readonly detail: string;
}

/** One instrument redeemed unusually fast (`/velocity`) — a person's look, detect-only. */
export interface VelocityFlagView {
  readonly instrumentId: string;
  readonly count: number;
  readonly valueMinor: number;
  readonly windowMinutes: number;
  readonly detail: string;
}

/** The three oversight feeds the shell last read (live from the cloud, or the injected stand-in). */
export interface StoredValueOversightData {
  readonly liability: LiabilityReconciliationView | null;
  readonly doubleSpends: readonly DoubleSpendView[];
  readonly velocity: readonly VelocityFlagView[];
  readonly asAt: string;
}

export interface StoredValueOversightPorts {
  /** The oversight feeds the shell last read. */
  oversight(): StoredValueOversightData;
  /** Whether this user may read the stored-value loss/books oversight (`lp.case.read`). */
  mayRead(): boolean;
}

export interface StoredValueOversightConfig {
  /** Who is looking. `null` means the store computer was not told who is at the screen. */
  readonly userId: string | null;
}

// ── the copy: ONE bilingual object for the whole screen ─────────────────────────────────────────────────

export type CopyKey =
  | 'title' | 'lead' | 'langName'
  | 'lossHeading' | 'lossCount' | 'lossExposure' | 'lossNone'
  | 'gapHeading' | 'gapNeedsPosted' | 'gapReconciled'
  | 'outstandingLabel' | 'postedLabel' | 'differenceLabel' | 'issuedLabel' | 'redeemedLabel' | 'expiredLabel'
  | 'watchHeading' | 'watchCount' | 'watchNone'
  | 'instrumentLabel' | 'ownerLabel' | 'overspentLabel' | 'channelsLabel'
  | 'countLabel' | 'valueLabel' | 'windowLabel'
  | 'kindLoss' | 'kindGap' | 'kindWatch' | 'kindReconciled'
  | 'scrReady' | 'scrEmpty' | 'stateNotPermitted'
  | 'nobodyNamed' | 'staleShell' | 'sampleData';

export const STORED_VALUE_COPY: BilingualCopy<CopyKey> = {
  en: {
    title: 'Stored-value oversight', langName: 'தமிழ்',
    lead: 'The money the shop owes on gift cards and store credit — and where it quietly leaks. Settled losses first (a card spent twice while channels were out of sync — real money paid out, both sides kept), then any gap between the cards’ balance and what the books posted, then cards draining unusually fast that a person should look at. This screen reads and reports; it changes nothing.',
    lossHeading: 'Given away twice', lossCount: 'to settle', lossExposure: 'Paid out twice',
    lossNone: 'No cross-channel double-spends — nothing given away twice.',
    gapHeading: 'Liability vs the books', gapNeedsPosted: 'Enter the liability the books currently carry to reconcile the cards against it — nothing is assumed.',
    gapReconciled: 'The cards’ outstanding balance matches the posted liability exactly.',
    outstandingLabel: 'Outstanding on cards', postedLabel: 'Posted in the books', differenceLabel: 'Gap (posted − cards)',
    issuedLabel: 'Issued', redeemedLabel: 'Redeemed', expiredLabel: 'Expired',
    watchHeading: 'Draining fast', watchCount: 'to look at', watchNone: 'No cards draining unusually fast.',
    instrumentLabel: 'Card', ownerLabel: 'Owner', overspentLabel: 'Overspent', channelsLabel: 'Channels',
    countLabel: 'Redemptions', valueLabel: 'Value', windowLabel: 'Within (min)',
    kindLoss: 'Loss', kindGap: 'Unrecorded debt', kindWatch: 'Watch', kindReconciled: 'Reconciled',
    scrReady: 'Showing stored-value exposure', scrEmpty: 'All clear — nothing given away twice, no watch flags, and the books reconcile.',
    stateNotPermitted: 'You do not have permission to see the stored-value oversight.',
    nobodyNamed: 'This store computer has not been told who is using this screen.',
    staleShell: 'No connection to the store computer. This page is what it was last told, at', sampleData: 'Sample data — this is not your shop.',
  },
  ta: {
    title: 'சேமிப்பு-மதிப்பு கண்காணிப்பு', langName: 'English',
    lead: 'பரிசு அட்டைகள் மற்றும் கடை வரவில் கடை கடன்பட்டுள்ள பணம் — அது எங்கே அமைதியாகக் கசிகிறது. முதலில் நிலைபெற்ற இழப்புகள் (சேனல்கள் ஒத்திசைவின்றி இருந்தபோது இருமுறை செலவழிக்கப்பட்ட அட்டை — உண்மையான பணம், இரண்டு பக்கமும் வைக்கப்படுகிறது), பின்னர் அட்டைகளின் இருப்புக்கும் கணக்கில் பதிந்ததற்கும் இடையிலான வித்தியாசம், பின்னர் வழக்கத்திற்கு மாறாக விரைவாகக் குறையும் அட்டைகள். இந்தத் திரை படித்து அறிக்கை செய்கிறது; எதையும் மாற்றாது.',
    lossHeading: 'இருமுறை கொடுக்கப்பட்டது', lossCount: 'தீர்க்க வேண்டியவை', lossExposure: 'இருமுறை செலுத்தப்பட்டது',
    lossNone: 'சேனல்கள் இடையே இரட்டைச் செலவு இல்லை — இருமுறை எதுவும் கொடுக்கப்படவில்லை.',
    gapHeading: 'கடன் vs கணக்கு', gapNeedsPosted: 'அட்டைகளை ஒப்பிட, கணக்கில் தற்போது உள்ள கடன் தொகையை உள்ளிடவும் — எதுவும் ஊகிக்கப்படாது.',
    gapReconciled: 'அட்டைகளின் நிலுவை இருப்பு பதிந்த கடனுடன் சரியாகப் பொருந்துகிறது.',
    outstandingLabel: 'அட்டைகளில் நிலுவை', postedLabel: 'கணக்கில் பதிந்தது', differenceLabel: 'வித்தியாசம் (பதிந்தது − அட்டைகள்)',
    issuedLabel: 'வழங்கப்பட்டது', redeemedLabel: 'மீட்கப்பட்டது', expiredLabel: 'காலாவதி',
    watchHeading: 'விரைவாகக் குறைகிறது', watchCount: 'பார்க்க வேண்டியவை', watchNone: 'வழக்கத்திற்கு மாறாக விரைவாகக் குறையும் அட்டைகள் இல்லை.',
    instrumentLabel: 'அட்டை', ownerLabel: 'உரிமையாளர்', overspentLabel: 'மிகைச் செலவு', channelsLabel: 'சேனல்கள்',
    countLabel: 'மீட்புகள்', valueLabel: 'மதிப்பு', windowLabel: 'கால அளவு (நிமி)',
    kindLoss: 'இழப்பு', kindGap: 'பதியப்படாத கடன்', kindWatch: 'கவனி', kindReconciled: 'சரிசெய்யப்பட்டது',
    scrReady: 'சேமிப்பு-மதிப்பு ஆபத்தைக் காட்டுகிறது', scrEmpty: 'அனைத்தும் சரி — இருமுறை எதுவும் கொடுக்கப்படவில்லை, கவனிப்புக் கொடிகள் இல்லை, கணக்கும் பொருந்துகிறது.',
    stateNotPermitted: 'சேமிப்பு-மதிப்பு கண்காணிப்பைப் பார்க்க உங்களுக்கு அனுமதி இல்லை.',
    nobodyNamed: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை.',
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:', sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
  },
};

export const COPY_KEYS: readonly CopyKey[] = Object.freeze(Object.keys(STORED_VALUE_COPY.en) as CopyKey[]);

// ── the presented shapes the view renders ────────────────────────────────────────────────────────────────

export interface PresentedLiability {
  readonly outstanding: string;
  readonly posted: string;
  readonly issued: string;
  readonly redeemed: string;
  readonly expired: string;
  /** The gap, signed and formatted (₹). */
  readonly difference: string;
  readonly differenceMinor: number;
  readonly reconciles: boolean;
  readonly detail: string;
  /** ok when it reconciles, error (unrecorded debt) when it does not — icon + word, never colour alone. */
  readonly status: StatusPresentation;
}

export interface PresentedDoubleSpend {
  readonly instrumentId: string;
  readonly ownerRef: string;
  readonly overspent: string;
  readonly overspentMinor: number;
  readonly channels: readonly string[];
  readonly detail: string;
  /** Always an error tone — this is settled loss, not a risk. */
  readonly status: StatusPresentation;
}

export interface PresentedVelocityFlag {
  readonly instrumentId: string;
  readonly count: number;
  readonly value: string;
  readonly valueMinor: number;
  readonly windowMinutes: number;
  readonly detail: string;
  /** A degraded watch tone — a person's look, detect-only. */
  readonly status: StatusPresentation;
}

export interface StoredValueOversightView {
  readonly screenState: StatusPresentation;
  readonly liability: PresentedLiability | null;
  readonly doubleSpends: readonly PresentedDoubleSpend[];
  readonly velocity: readonly PresentedVelocityFlag[];
  readonly doubleSpendCount: number;
  readonly velocityCount: number;
  /** Total money given away twice across the double-spends — the settled-loss exposure, formatted (₹). */
  readonly totalOverspent: string;
  readonly totalOverspentMinor: number;
  readonly nobodyNamed: boolean;
  /** True when there is a settled loss or a books gap — the things that need action, not just a watch. */
  readonly anyException: boolean;
}

export interface StoredValueOversightSession {
  text(lang: Lang, key: CopyKey): string;
  view(lang: Lang): StoredValueOversightView;
}

const rupees = (minor: number): string => {
  const sign = minor < 0 ? '-' : '';
  return `${sign}₹${(Math.abs(minor) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const EMPTY_VIEW = (screenState: StatusPresentation, nobodyNamed: boolean): StoredValueOversightView => ({
  screenState, liability: null, doubleSpends: [], velocity: [],
  doubleSpendCount: 0, velocityCount: 0, totalOverspent: '₹0.00', totalOverspentMinor: 0,
  nobodyNamed, anyException: false,
});

export function createStoredValueOversightSession(
  config: StoredValueOversightConfig,
  ports: StoredValueOversightPorts,
): StoredValueOversightSession {
  const text = (lang: Lang, key: CopyKey): string => translator(STORED_VALUE_COPY, lang)(key);

  const presentLiability = (lang: Lang, l: LiabilityReconciliationView): PresentedLiability => {
    const t = translator(STORED_VALUE_COPY, lang);
    return {
      outstanding: rupees(l.outstandingMinor), posted: rupees(l.postedLiabilityMinor),
      issued: rupees(l.issuedMinor), redeemed: rupees(l.redeemedMinor), expired: rupees(l.expiredMinor),
      difference: rupees(l.differenceMinor), differenceMinor: l.differenceMinor,
      reconciles: l.reconciles, detail: l.detail,
      // Reconciled is a clean OK; any gap is unrecorded debt and reads as an error (icon + word ride with it).
      status: l.reconciles
        ? presentStatus({ tone: 'ok', icon: '✓', label: t('kindReconciled'), announcement: l.detail, needsAttention: false })
        : presentStatus({ tone: 'error', icon: '✕', label: t('kindGap'), announcement: l.detail, needsAttention: true }),
    };
  };

  const presentDoubleSpend = (lang: Lang, d: DoubleSpendView): PresentedDoubleSpend => {
    const t = translator(STORED_VALUE_COPY, lang);
    return {
      instrumentId: d.instrumentId, ownerRef: d.ownerRef,
      overspent: rupees(d.overspentMinor), overspentMinor: d.overspentMinor,
      channels: [...d.channels], detail: d.detail,
      status: presentStatus({ tone: 'error', icon: '✕', label: t('kindLoss'), announcement: d.detail, needsAttention: true }),
    };
  };

  const presentVelocity = (lang: Lang, v: VelocityFlagView): PresentedVelocityFlag => {
    const t = translator(STORED_VALUE_COPY, lang);
    return {
      instrumentId: v.instrumentId, count: v.count,
      value: rupees(v.valueMinor), valueMinor: v.valueMinor, windowMinutes: v.windowMinutes,
      detail: v.detail,
      status: presentStatus({ tone: 'degraded', icon: '⚠', label: t('kindWatch'), announcement: v.detail, needsAttention: true }),
    };
  };

  return {
    text,
    view: (lang) => {
      const t = translator(STORED_VALUE_COPY, lang);
      const nobodyNamed = config.userId === null;

      if (!ports.mayRead()) {
        return EMPTY_VIEW(presentScreenState({ state: 'error', label: t('stateNotPermitted') }), nobodyNamed);
      }

      const data = ports.oversight();
      // Worst-first inside each feed: the biggest settled loss and the fastest drain at the top. The
      // engine does not order them; the screen guarantees it so the eye lands on the worst first (P-03).
      const doubleSpends = [...data.doubleSpends]
        .sort((a, b) => b.overspentMinor - a.overspentMinor)
        .map((d) => presentDoubleSpend(lang, d));
      const velocity = [...data.velocity]
        .sort((a, b) => b.valueMinor - a.valueMinor)
        .map((v) => presentVelocity(lang, v));
      const liability = data.liability === null ? null : presentLiability(lang, data.liability);

      const totalOverspentMinor = data.doubleSpends.reduce((s, d) => s + d.overspentMinor, 0);
      const anyException = doubleSpends.length > 0 || (liability !== null && !liability.reconciles);
      const anythingShown = anyException || velocity.length > 0 || liability !== null;
      const state = anythingShown ? 'ready' : 'empty';

      return {
        screenState: presentScreenState({ state, label: t(state === 'empty' ? 'scrEmpty' : 'scrReady') }),
        liability,
        doubleSpends,
        velocity,
        doubleSpendCount: doubleSpends.length,
        velocityCount: velocity.length,
        totalOverspent: rupees(totalOverspentMinor),
        totalOverspentMinor,
        nobodyNamed,
        anyException,
      };
    },
  };
}
