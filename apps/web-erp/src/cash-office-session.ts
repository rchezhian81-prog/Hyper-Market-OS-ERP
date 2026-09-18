// The cash-office over/short sign-off screen — the day-close reconciliation desk (M14-FR-02 · API-05 ·
// P-03 control-by-exception · §28 separation of duties). A cashier closes a drawer against a BLIND count;
// a material over/short raises a reconciliation exception the cash office must account for. The cloud folds
// the still-OPEN over/shorts into a worklist (`GET /v1/shifts/over-short`), and this is the screen that
// works them: every unsigned over/short, biggest first, and the one action taken from here — SIGN OFF a
// variance with a stated finding, in the reviewer's own name.
//
// Three truths the screen must carry, all already true in the engine and re-stated here so the surface
// cannot weaken them:
//   • **It self-heals.** The worklist is re-READ from the cloud, so a signed-off over/short drops off on
//     its own; this screen never carries a "done" flag that could go stale against reality.
//   • **A different person signs it off** (§28 / P-03). The reviewer is the authenticated caller and may
//     NEVER be the cashier who counted the drawer — the engine refuses `cannot_review_your_own_drawer`, and
//     the screen refuses it locally too (it knows whose drawer each row is), so a cashier can never clear
//     their own shortage. A sign-off never edits the close; it is an append-only accountable finding.
//   • **A finding is required, and nothing is deleted** (hard rule #2/#6). Signing off records the coded
//     finding + optional note against the shift; the close itself is untouched.
//
// Like every ERP screen the rules live here in a tested, DOM-free session model on the shared packages/ui
// primitives (colour is never the only signal — an icon and a word ride with every tone); the shell only
// renders what this hands over. No AI signs off a variance (hard rule #5).

import { translator, presentScreenState, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { presentStatus, type StatusPresentation } from '../../../packages/a11y/src/signals';

/** The cash-office finding codes the screen offers for a signed-off over/short. The engine takes the
 *  `disposition` as an opaque non-empty string (a coded finding is FR-required, the vocabulary is the
 *  screen's presentation of it), so this list is the dropdown, from one place — extend it here alone. */
export const OVER_SHORT_DISPOSITIONS = ['miscount', 'change_error', 'banking_variance', 'unexplained', 'theft_suspected'] as const;
export type OverShortDisposition = (typeof OVER_SHORT_DISPOSITIONS)[number];

/** One still-open over/short as the worklist route hands it over (`GET /v1/shifts/over-short`). The cashier
 *  id rides along for the audit trail AND for the §28 check (a reviewer may not sign off their own drawer). */
export interface OverShortView {
  readonly shiftId: string;
  readonly tillId: string;
  readonly cashierId: string;
  readonly tradingDay: string;
  /** counted − expected: positive = over, negative = short. */
  readonly varianceMinor: number;
  /** The reason the cashier gave for the material variance at close (never blank for a material one). */
  readonly reasonCode: string | null;
}

/** The worklist body (`GET /v1/shifts/over-short`). Only the OPEN (unsigned) rows are worked here; the route
 *  also returns the reviewed ones, which the port filters out before handing them over. */
export interface CashOverShortData {
  readonly openCount: number;
  /** The net over/short across the open rows — the size of the desk's open reconciliation exposure. */
  readonly totalVarianceMinor: number;
  readonly open: readonly OverShortView[];
}

/** The outcome of a sign-off — recorded, refused by the server (own drawer / no finding / permission), or a
 *  lost link. */
export type SignOffResult = 'signed' | 'refused' | 'lost_link';

/** The authenticated POST of a reviewer's sign-off. Injected, so the model never opens a socket itself; the
 *  server records the sign-off in the caller's own name and enforces §28 (reviewer ≠ cashier). */
export interface OverShortSignOffPort {
  post(input: { readonly shiftId: string; readonly disposition: string; readonly note: string }): Promise<SignOffResult>;
}

export interface CashOfficePorts {
  /** The over/short worklist the shell last read (live from the cloud, or the injected stand-in). */
  worklist(): CashOverShortData;
  /** Whether this user may read the over/short worklist (`till.shift.read`). */
  mayRead(): boolean;
  /** Whether this user may sign off an over/short (`till.overshort.review`). */
  mayReview(): boolean;
  /** Records a sign-off. Only reached from the explicit action, never on render. */
  signOffPort(): OverShortSignOffPort;
}

export interface CashOfficeConfig {
  /** Who is looking. `null` means the store computer was not told who is at the screen; when known, it is
   *  used for the local §28 check — a reviewer may not sign off a drawer they themselves counted. */
  readonly userId: string | null;
}

// ── the copy: ONE bilingual object for the whole screen ───────────────────────────────────────────────────

export type CopyKey =
  | 'title' | 'lead' | 'langName'
  | 'over' | 'short'
  | 'openHeading' | 'openCount' | 'exposureLabel' | 'allClear'
  | 'tillLabel' | 'cashierLabel' | 'dayLabel' | 'varianceLabel' | 'reasonLabel' | 'yourDrawer'
  | 'signHeading' | 'shiftLabel' | 'dispositionLabel' | 'noteLabel' | 'notePlaceholder' | 'signBtn'
  | 'dispMiscount' | 'dispChangeError' | 'dispBankingVariance' | 'dispUnexplained' | 'dispTheftSuspected'
  | 'signRecorded' | 'signRefused' | 'signLostLink'
  | 'scrReady' | 'scrEmpty' | 'stateNotPermitted' | 'noReview'
  | 'nobodyNamed' | 'staleShell' | 'sampleData';

export const CASH_OFFICE_COPY: BilingualCopy<CopyKey> = {
  en: {
    title: 'Over / short sign-off', langName: 'தமிழ்',
    lead: 'Drawers that closed over or short by more than the tolerance — biggest first — waiting for the cash office to account for them. You cannot sign off a drawer you counted yourself: a different person must (separation of duties). Signing off records your finding against the shift; it never changes the close, and nothing is deleted.',
    over: 'Over', short: 'Short',
    openHeading: 'To account for', openCount: 'to account for', exposureLabel: 'Net over/short',
    allClear: 'No over/shorts to account for — every drawer is signed off.',
    tillLabel: 'Till', cashierLabel: 'Counted by', dayLabel: 'Trading day', varianceLabel: 'Over/short', reasonLabel: 'Cashier’s reason',
    yourDrawer: 'You counted this drawer — someone else must sign it off.',
    signHeading: 'Sign off an over/short', shiftLabel: 'Which shift', dispositionLabel: 'Your finding',
    noteLabel: 'Note (optional)', notePlaceholder: 'Anything the finding does not already say.',
    signBtn: 'Sign it off',
    dispMiscount: 'Miscount at the drawer', dispChangeError: 'Change / keying error', dispBankingVariance: 'Banking / float variance',
    dispUnexplained: 'Unexplained — needs follow-up', dispTheftSuspected: 'Suspected theft',
    signRecorded: 'Signed off.',
    signRefused: 'Could not sign off — a different person from the cashier must sign it, with a stated finding; or you do not have permission.',
    signLostLink: 'No connection — not saved. Try again.',
    scrReady: 'Showing the open over/shorts', scrEmpty: 'No over/shorts to account for — every drawer is signed off.',
    stateNotPermitted: 'You do not have permission to see the over/shorts.',
    noReview: 'You can see the over/shorts, but signing one off needs cash-office permission.',
    nobodyNamed: 'This store computer has not been told who is using this screen.',
    staleShell: 'No connection to the store computer. This page is what it was last told, at', sampleData: 'Sample data — this is not your shop.',
  },
  ta: {
    title: 'கூடுதல் / குறைவு கையொப்பம்', langName: 'English',
    lead: 'சகிப்புத்தன்மையை மீறி கூடுதலாகவோ குறைவாகவோ மூடப்பட்ட பணப்பெட்டிகள் — பெரியது முதலில் — பணக்கச்சேரி விளக்கம் அளிக்கக் காத்திருக்கின்றன. நீங்கள் எண்ணிய பணப்பெட்டியை நீங்களே கையொப்பமிட முடியாது: வேறொருவர் செய்ய வேண்டும் (பொறுப்புப் பிரிப்பு). கையொப்பம் உங்கள் கண்டுபிடிப்பை ஷிப்டில் பதிவு செய்கிறது; மூடலை மாற்றாது, எதுவும் அழிக்கப்படாது.',
    over: 'கூடுதல்', short: 'குறைவு',
    openHeading: 'விளக்கம் அளிக்க வேண்டியவை', openCount: 'விளக்கம் அளிக்க', exposureLabel: 'நிகர கூடுதல்/குறைவு',
    allClear: 'விளக்கம் அளிக்க கூடுதல்/குறைவு இல்லை — எல்லா பணப்பெட்டிகளும் கையொப்பமிடப்பட்டன.',
    tillLabel: 'பணப்பெட்டி', cashierLabel: 'எண்ணியவர்', dayLabel: 'வர்த்தக நாள்', varianceLabel: 'கூடுதல்/குறைவு', reasonLabel: 'காசாளர் காரணம்',
    yourDrawer: 'இந்தப் பணப்பெட்டியை நீங்கள் எண்ணினீர்கள் — வேறொருவர் கையொப்பமிட வேண்டும்.',
    signHeading: 'ஒரு கூடுதல்/குறைவைக் கையொப்பமிடு', shiftLabel: 'எந்த ஷிப்ட்', dispositionLabel: 'உங்கள் கண்டுபிடிப்பு',
    noteLabel: 'குறிப்பு (விருப்பம்)', notePlaceholder: 'கண்டுபிடிப்பு சொல்லாதது ஏதேனும் இருந்தால்.',
    signBtn: 'கையொப்பமிடு',
    dispMiscount: 'பணப்பெட்டியில் தவறான எண்ணிக்கை', dispChangeError: 'சில்லறை / உள்ளீட்டுப் பிழை', dispBankingVariance: 'வங்கி / மிதப்பு வேறுபாடு',
    dispUnexplained: 'விளக்கமில்லை — தொடர் நடவடிக்கை தேவை', dispTheftSuspected: 'திருட்டு சந்தேகம்',
    signRecorded: 'கையொப்பமிடப்பட்டது.',
    signRefused: 'கையொப்பமிட முடியவில்லை — காசாளரிடமிருந்து வேறொருவர் ஒரு கண்டுபிடிப்புடன் கையொப்பமிட வேண்டும்; அல்லது உங்களுக்கு அனுமதி இல்லை.',
    signLostLink: 'இணைப்பு இல்லை — சேமிக்கப்படவில்லை. மீண்டும் முயற்சிக்கவும்.',
    scrReady: 'திறந்த கூடுதல்/குறைவுகளைக் காட்டுகிறது', scrEmpty: 'விளக்கம் அளிக்க கூடுதல்/குறைவு இல்லை — எல்லா பணப்பெட்டிகளும் கையொப்பமிடப்பட்டன.',
    stateNotPermitted: 'கூடுதல்/குறைவுகளைப் பார்க்க உங்களுக்கு அனுமதி இல்லை.',
    noReview: 'கூடுதல்/குறைவுகளைப் பார்க்கலாம், ஆனால் கையொப்பமிட பணக்கச்சேரி அனுமதி தேவை.',
    nobodyNamed: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை.',
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:', sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
  },
};

export const COPY_KEYS: readonly CopyKey[] = Object.freeze(Object.keys(CASH_OFFICE_COPY.en) as CopyKey[]);

/** The copy key for each disposition's human label, so the dropdown renders from one place. */
const DISPOSITION_COPY: Readonly<Record<OverShortDisposition, CopyKey>> = {
  miscount: 'dispMiscount',
  change_error: 'dispChangeError',
  banking_variance: 'dispBankingVariance',
  unexplained: 'dispUnexplained',
  theft_suspected: 'dispTheftSuspected',
};

// ── the presented shapes the view renders ────────────────────────────────────────────────────────────────

export interface PresentedOverShort {
  readonly shiftId: string;
  readonly tillId: string;
  readonly cashierId: string;
  readonly tradingDay: string;
  /** The over/short direction word ("Over"/"Short"), from the sign — never colour alone. */
  readonly direction: string;
  /** The magnitude, formatted for reading (₹), always positive; the direction word carries the sign. */
  readonly amount: string;
  readonly varianceMinor: number;
  readonly reasonCode: string | null;
  /** True when the logged-in reviewer counted this drawer — the screen flags it and refuses the sign-off. */
  readonly isOwnDrawer: boolean;
  /** Every open over/short needs attention (P-03) — a degraded tone with an icon and word. */
  readonly status: StatusPresentation;
  readonly needsAttention: boolean;
}

export interface CashOfficeView {
  readonly screenState: StatusPresentation;
  readonly open: readonly PresentedOverShort[];
  readonly openCount: number;
  /** The net over/short across the open rows, formatted (₹, signed). */
  readonly totalVariance: string;
  readonly totalVarianceMinor: number;
  readonly nobodyNamed: boolean;
  /** Whether to offer the sign-off action — this user holds `till.overshort.review`. */
  readonly mayReview: boolean;
}

export interface CashOfficeSession {
  text(lang: Lang, key: CopyKey): string;
  view(lang: Lang): CashOfficeView;
  /** The dispositions a reviewer can choose, each with its human label — the dropdown, from one place. */
  dispositionOptions(lang: Lang): readonly { readonly value: OverShortDisposition; readonly label: string }[];
  /** Sign off an over/short, in the reviewer's name — a HUMAN write. Runs only from an explicit action,
   *  never on render; refuses BEFORE any POST without permission, a finding, or when the reviewer counted
   *  the drawer (§28 — the server enforces it too; the screen never sends a self-review). */
  signOff(shiftId: string, disposition: string, note: string): Promise<SignOffResult>;
  /** Present a sign-off outcome as one glanceable status the shell shows after the action. */
  presentSignOffResult(lang: Lang, result: SignOffResult): StatusPresentation;
}

const EMPTY_VIEW = (screenState: StatusPresentation, nobodyNamed: boolean, mayReview: boolean): CashOfficeView => ({
  screenState, open: [], openCount: 0, totalVariance: '₹0.00', totalVarianceMinor: 0, nobodyNamed, mayReview,
});

/** Format paise as rupees; when `signed`, a positive value keeps a leading + so over/short reads at a glance. */
const rupees = (minor: number, signed = false): string => {
  const sign = signed && minor > 0 ? '+' : minor < 0 ? '-' : '';
  const body = (Math.abs(minor) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sign}₹${body}`;
};

const isDisposition = (v: string): v is OverShortDisposition => (OVER_SHORT_DISPOSITIONS as readonly string[]).includes(v);

export function createCashOfficeSession(config: CashOfficeConfig, ports: CashOfficePorts): CashOfficeSession {
  const text = (lang: Lang, key: CopyKey): string => translator(CASH_OFFICE_COPY, lang)(key);

  const present = (lang: Lang, r: OverShortView): PresentedOverShort => {
    const t = translator(CASH_OFFICE_COPY, lang);
    const isShort = r.varianceMinor < 0;
    const directionWord = t(isShort ? 'short' : 'over');
    const isOwnDrawer = config.userId !== null && r.cashierId === config.userId;
    return {
      shiftId: r.shiftId,
      tillId: r.tillId,
      cashierId: r.cashierId,
      tradingDay: r.tradingDay,
      direction: directionWord,
      amount: rupees(Math.abs(r.varianceMinor)), // magnitude only; the direction word carries the sign
      varianceMinor: r.varianceMinor,
      reasonCode: r.reasonCode,
      isOwnDrawer,
      // Every open over/short is work — a degraded tone that asks for a glance (P-03). Colour is never the
      // only signal: an icon and the direction word ride with it. The worklist ordering puts the biggest
      // exposure at the top; no severity band the engine does not define is invented here.
      status: presentStatus({ tone: 'degraded', icon: '⚠', label: directionWord, announcement: `${directionWord} ${rupees(Math.abs(r.varianceMinor))} — ${r.tillId}`, needsAttention: true }),
      needsAttention: true,
    };
  };

  return {
    text,
    dispositionOptions: (lang) => {
      const t = translator(CASH_OFFICE_COPY, lang);
      return OVER_SHORT_DISPOSITIONS.map((value) => ({ value, label: t(DISPOSITION_COPY[value]) }));
    },
    view: (lang) => {
      const t = translator(CASH_OFFICE_COPY, lang);
      const nobodyNamed = config.userId === null;
      const mayReview = ports.mayReview();

      if (!ports.mayRead()) {
        return EMPTY_VIEW(presentScreenState({ state: 'error', label: t('stateNotPermitted') }), nobodyNamed, mayReview);
      }

      const worklist = ports.worklist();
      // Biggest exposure first — by absolute over/short, so a big over ranks with a big short.
      const open = worklist.open
        .slice()
        .sort((a, b) => Math.abs(b.varianceMinor) - Math.abs(a.varianceMinor))
        .map((r) => present(lang, r));
      const state = open.length === 0 ? 'empty' : 'ready';
      return {
        screenState: presentScreenState({ state, label: t(state === 'empty' ? 'scrEmpty' : 'scrReady') }),
        open,
        openCount: open.length,
        totalVariance: rupees(worklist.totalVarianceMinor, true),
        totalVarianceMinor: worklist.totalVarianceMinor,
        nobodyNamed,
        mayReview,
      };
    },

    // Sign off an over/short. Refuse BEFORE any POST — no permission, an unknown/empty finding, or the
    // reviewer's OWN drawer (§28) is a local refusal, not a round trip. The server still enforces §28 and
    // records the sign-off in the reviewer's own name; the screen never sends a self-review.
    signOff: async (shiftId, disposition, note) => {
      if (!ports.mayReview() || !isDisposition(disposition)) return 'refused';
      const row = ports.worklist().open.find((r) => r.shiftId === shiftId);
      if (row === undefined) return 'refused';
      if (config.userId !== null && row.cashierId === config.userId) return 'refused'; // §28: not your own drawer
      return ports.signOffPort().post({ shiftId, disposition, note: note.trim() });
    },

    presentSignOffResult: (lang, result) => {
      const t = translator(CASH_OFFICE_COPY, lang);
      if (result === 'signed') return presentStatus({ tone: 'ok', icon: '✓', label: t('signRecorded'), needsAttention: false });
      if (result === 'lost_link') return presentStatus({ tone: 'degraded', icon: '⚠', label: t('signLostLink'), needsAttention: true });
      return presentStatus({ tone: 'error', icon: '✕', label: t('signRefused'), needsAttention: true });
    },
  };
}
