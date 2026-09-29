// The DAY BOOK — the accountant's posting screen (M23-FR-01 · API-09 · P-03 · P-08 · §28). Every till sale and
// every return the store makes lands in the cloud as a fact; the day book is how those facts become the
// accounts: one trading day, aggregated per posting KIND (sales, returns, takings per tender, refunds per
// tender), each kind posted as a balanced journal through the owner's posting map into the period that is
// open — a closed month routes to the next open period, carrying its real date and saying so. What could NOT be
// posted is never silently dropped: it becomes an EXCEPTION on the day (a tax rate nobody defined, a receipt
// whose lines do not sum, a tender kind with no rule) that stays OPEN until a later posting covers it.
//
// This screen shows one trading day as the cloud holds it — the journals posted for it (`GET
// /v1/finance/day-book/:tradingDay`), the account totals they move, and the exceptions with their state — and
// carries the one write an accountant makes from here: POST the day (`POST …/:tradingDay/post`), idempotent on
// the server (a day posted twice is one posting), refused when the posting map is not defined (409), in the
// accountant's own name.
//
// Truths the screen carries, already true in the engine and re-stated so the surface cannot weaken them:
//   • **It never previews what it did not post.** The cloud has no dry-run; an unposted day reads as "not yet
//     posted", never as figures that look booked.
//   • **An open exception is an ERROR on the day** — money the accounts have not taken (P-08); a resolved one
//     stays on the record as resolved (hard rule #6).
//   • **The write runs only on an explicit click, in the caller's own name**, and is refused locally before
//     any POST without `finance.journal.post` or a valid date.
//
// Like every ERP screen the rules live here in a tested, DOM-free session model on the shared packages/ui
// primitives (colour is never the only signal — an icon and a word ride with every tone); the shell only
// renders what this hands over.

import { translator, presentScreenState, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { presentStatus, type StatusPresentation } from '../../../packages/a11y/src/signals';

// ── the raw feeds, exactly as the cloud hands them over ───────────────────────────────────────────────────

export type DayBookSourceKind = 'sale' | 'return';

/** One posted journal as the read route summarises it. */
export interface DayBookJournalView {
  readonly entryId: string;
  /** The posting kind: `sale`, `sale_return`, `tender:<kind>`, `refund:<kind>`. */
  readonly kind: string;
  readonly sourceKind: DayBookSourceKind;
  /** How many receipts / returns the journal aggregates. */
  readonly sources: number;
  readonly period: string;
  readonly documentDate: string;
  /** Set when the day belonged to a CLOSED month and was posted to the next open period. */
  readonly belongsTo?: string;
  readonly components: Readonly<Record<string, number>>;
  readonly lines: readonly { readonly accountCode: string; readonly debitMinor: number; readonly creditMinor: number }[];
  readonly postedBy: string;
  readonly narrative: string;
}

export interface DayBookAccountView {
  readonly accountCode: string;
  readonly debitMinor: number;
  readonly creditMinor: number;
  readonly balanceMinor: number;
}

export type DayBookExceptionReason =
  | 'tax_rate_unknown' | 'tax_split_failed' | 'negative_line' | 'lines_do_not_sum_to_total' | 'tenders_do_not_sum_to_total'
  | 'refund_split_unknown' | 'unmapped_kind' | 'missing_component' | 'unbalanced_journal';

export interface DayBookExceptionView {
  readonly exceptionId: string;
  readonly tradingDay: string;
  readonly sourceKind: DayBookSourceKind;
  readonly sourceIds: readonly string[];
  readonly kind?: string;
  readonly reason: DayBookExceptionReason | string;
  readonly detail: string;
  readonly raisedAt: string;
  readonly raisedBy: string;
  readonly state: 'open' | 'resolved';
}

/** `GET /v1/finance/day-book/:tradingDay` — what the cloud holds for the day. */
export interface DayBookReadData {
  readonly tradingDay: string;
  readonly journals: readonly DayBookJournalView[];
  readonly accounts: readonly DayBookAccountView[];
  readonly covered: number;
  readonly exceptions: readonly DayBookExceptionView[];
  readonly open: number;
  readonly asAt: string;
}

/** `POST /v1/finance/day-book/:tradingDay/post` — what the posting did (201 when a journal was appended, 200 when nothing new). */
export interface DayBookPostBody {
  readonly tradingDay: string;
  readonly postedTo: string;
  readonly postedLate?: { readonly belongsTo: string };
  readonly journals: readonly DayBookJournalView[];
  readonly exceptions: readonly Omit<DayBookExceptionView, 'state'>[];
  readonly skipped: number;
  readonly zeroValue: readonly string[];
  readonly counted: { readonly sales: number; readonly returns: number };
}

export type PostResult =
  | { readonly result: 'posted' | 'nothing_new'; readonly body: DayBookPostBody }
  | { readonly result: 'no_posting_map' | 'refused' | 'lost_link' };

/** The authenticated POST of the accountant's posting. Injected, so the model never opens a socket itself. */
export interface DayBookPostPort {
  post(input: { readonly tradingDay: string }): Promise<PostResult>;
}

export interface DayBookPorts {
  /** The day the shell last read (live from the cloud), or null when nothing was read yet. */
  dayBook(): DayBookReadData | null;
  /** Whether this user may read the day book (`finance.period.read`). */
  mayRead(): boolean;
  /** Whether this user may post the day (`finance.journal.post`). */
  mayPost(): boolean;
  /** Records a posting. Only reached from the explicit post action, never on render. */
  postPort(): DayBookPostPort;
}

export interface DayBookConfig {
  /** Who is looking. `null` means the store computer was not told who is at the screen. */
  readonly userId: string | null;
}

export const isTradingDay = (s: unknown): s is string =>
  typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00.000Z`));

// ── the copy: ONE bilingual object for the whole screen ───────────────────────────────────────────────────

export type CopyKey =
  | 'title' | 'lead' | 'langName'
  | 'dayLabel' | 'loadBtn' | 'postBtn' | 'badDay'
  | 'notPosted' | 'postedSummary' | 'salesTotalLabel' | 'returnsTotalLabel' | 'coveredLabel' | 'openLabel'
  | 'journalsHeading' | 'accountsHeading' | 'exceptionsHeading' | 'noExceptions'
  | 'kindSale' | 'kindSaleReturn' | 'kindTender' | 'kindRefund'
  | 'sourcesLabel' | 'periodLabel' | 'lateLabel' | 'postedByLabel' | 'debitLabel' | 'creditLabel' | 'balanceLabel'
  | 'stateOpen' | 'stateResolved' | 'stateOk' | 'stateLate'
  | 'reasonTaxRateUnknown' | 'reasonTaxSplitFailed' | 'reasonNegativeLine' | 'reasonLinesDoNotSum' | 'reasonTendersDoNotSum'
  | 'reasonRefundSplitUnknown' | 'reasonUnmappedKind' | 'reasonMissingComponent' | 'reasonUnbalancedJournal' | 'reasonOther'
  | 'postDone' | 'postNothing' | 'postNoMap' | 'postRefused' | 'postLostLink' | 'postLate' | 'postCounted'
  | 'scrReady' | 'scrEmpty' | 'stateNotPermitted'
  | 'nobodyNamed' | 'staleShell' | 'sampleData';

export const DAY_BOOK_COPY: BilingualCopy<CopyKey> = {
  en: {
    title: 'Day book', langName: 'தமிழ்',
    lead: 'One trading day, posted into the accounts: sales, returns, the takings by tender and the refunds by tender, each a balanced journal through the posting map into the open period. What could not be posted is an exception that stays open until a later posting covers it — never dropped. Posting is your act, in your name; a day posted twice is one posting.',
    dayLabel: 'Trading day', loadBtn: 'Show the day', postBtn: 'Post this day to the accounts', badDay: 'Pick a trading day (YYYY-MM-DD).',
    notPosted: 'Nothing posted for this day yet.', postedSummary: 'journals posted',
    salesTotalLabel: 'Sales posted', returnsTotalLabel: 'Returns posted', coveredLabel: 'Receipts covered', openLabel: 'open exceptions',
    journalsHeading: 'Journals', accountsHeading: 'Accounts moved', exceptionsHeading: 'Exceptions', noExceptions: 'No exceptions on this day.',
    kindSale: 'Sales', kindSaleReturn: 'Returns', kindTender: 'Takings', kindRefund: 'Refunds',
    sourcesLabel: 'Receipts', periodLabel: 'Period', lateLabel: 'Belongs to a closed month', postedByLabel: 'Posted by',
    debitLabel: 'Debit', creditLabel: 'Credit', balanceLabel: 'Balance',
    stateOpen: 'Open — not in the accounts', stateResolved: 'Resolved', stateOk: 'Posted', stateLate: 'Posted late to the next open period',
    reasonTaxRateUnknown: 'Tax rate unknown', reasonTaxSplitFailed: 'Tax could not be split', reasonNegativeLine: 'Negative line',
    reasonLinesDoNotSum: 'Lines do not add up to the total', reasonTendersDoNotSum: 'Tenders do not add up to the total',
    reasonRefundSplitUnknown: 'Refund tender unknown', reasonUnmappedKind: 'No posting rule for this kind', reasonMissingComponent: 'A posting rule names a figure the day does not have',
    reasonUnbalancedJournal: 'The journal did not balance — nothing posted for this kind', reasonOther: 'Could not be posted',
    postDone: 'Posted.', postNothing: 'Nothing new to post — the day is already posted, or has no sales.',
    postNoMap: 'The posting map is not defined — an accountant defines the rules first (Finance → posting map). Nothing was posted.',
    postRefused: 'Could not post — you may not have permission, or the date is not a trading day. Nothing was posted.',
    postLostLink: 'No connection — not saved. Try again.',
    postLate: 'This day belongs to a closed month; it was posted to the next open period', postCounted: 'counted',
    scrReady: 'Showing the day book', scrEmpty: 'Nothing posted for this day yet.',
    stateNotPermitted: 'You do not have permission to see the day book.',
    nobodyNamed: 'This store computer has not been told who is using this screen.',
    staleShell: 'No connection to the store computer. This page is what it was last told, at', sampleData: 'Sample data — this is not your shop.',
  },
  ta: {
    title: 'நாள் புத்தகம்', langName: 'English',
    lead: 'ஒரு வர்த்தக நாள், கணக்குகளில் பதிவு: விற்பனை, திருப்பங்கள், ஒவ்வொரு பணவகை வசூல் மற்றும் திருப்பிச் செலுத்தல் — ஒவ்வொன்றும் பதிவு வரைபடத்தின் வழியாகத் திறந்த காலத்திற்குச் சமநிலை ஜர்னல். பதிவு செய்ய முடியாதது ஒரு விதிவிலக்காக, பின்னர் ஒரு பதிவு அதை மூடும் வரை திறந்திருக்கும் — ஒருபோதும் கைவிடப்படாது. பதிவு உங்கள் பெயரில் உங்கள் செயல்; இருமுறை பதிவு செய்த நாள் ஒரே பதிவு.',
    dayLabel: 'வர்த்தக நாள்', loadBtn: 'நாளைக் காட்டு', postBtn: 'இந்த நாளைக் கணக்குகளில் பதிவு செய்', badDay: 'ஒரு வர்த்தக நாளைத் தேர்வு செய்யுங்கள் (YYYY-MM-DD).',
    notPosted: 'இந்த நாளுக்கு இன்னும் எதுவும் பதிவு செய்யப்படவில்லை.', postedSummary: 'ஜர்னல்கள் பதிவு செய்யப்பட்டன',
    salesTotalLabel: 'பதிவான விற்பனை', returnsTotalLabel: 'பதிவான திருப்பங்கள்', coveredLabel: 'உள்ளடக்கிய ரசீதுகள்', openLabel: 'திறந்த விதிவிலக்குகள்',
    journalsHeading: 'ஜர்னல்கள்', accountsHeading: 'நகர்ந்த கணக்குகள்', exceptionsHeading: 'விதிவிலக்குகள்', noExceptions: 'இந்த நாளில் விதிவிலக்குகள் இல்லை.',
    kindSale: 'விற்பனை', kindSaleReturn: 'திருப்பங்கள்', kindTender: 'வசூல்', kindRefund: 'திருப்பிச் செலுத்தல்',
    sourcesLabel: 'ரசீதுகள்', periodLabel: 'காலம்', lateLabel: 'மூடிய மாதத்திற்குரியது', postedByLabel: 'பதிவு செய்தவர்',
    debitLabel: 'பற்று', creditLabel: 'வரவு', balanceLabel: 'இருப்பு',
    stateOpen: 'திறந்தது — கணக்குகளில் இல்லை', stateResolved: 'தீர்க்கப்பட்டது', stateOk: 'பதிவு செய்யப்பட்டது', stateLate: 'அடுத்த திறந்த காலத்தில் தாமதமாகப் பதிவு',
    reasonTaxRateUnknown: 'வரி விகிதம் தெரியவில்லை', reasonTaxSplitFailed: 'வரியைப் பிரிக்க முடியவில்லை', reasonNegativeLine: 'எதிர்மறை வரி',
    reasonLinesDoNotSum: 'வரிகள் மொத்தத்துடன் பொருந்தவில்லை', reasonTendersDoNotSum: 'பணவகைகள் மொத்தத்துடன் பொருந்தவில்லை',
    reasonRefundSplitUnknown: 'திருப்பிச் செலுத்தல் பணவகை தெரியவில்லை', reasonUnmappedKind: 'இந்த வகைக்குப் பதிவு விதி இல்லை', reasonMissingComponent: 'பதிவு விதி குறிப்பிடும் எண் நாளில் இல்லை',
    reasonUnbalancedJournal: 'ஜர்னல் சமநிலையில் இல்லை — இந்த வகைக்கு எதுவும் பதிவு செய்யப்படவில்லை', reasonOther: 'பதிவு செய்ய முடியவில்லை',
    postDone: 'பதிவு செய்யப்பட்டது.', postNothing: 'புதிதாகப் பதிவு செய்ய எதுவும் இல்லை — நாள் ஏற்கனவே பதிவு செய்யப்பட்டது, அல்லது விற்பனை இல்லை.',
    postNoMap: 'பதிவு வரைபடம் வரையறுக்கப்படவில்லை — ஒரு கணக்காளர் முதலில் விதிகளை வரையறுக்கிறார் (நிதி → பதிவு வரைபடம்). எதுவும் பதிவு செய்யப்படவில்லை.',
    postRefused: 'பதிவு செய்ய முடியவில்லை — உங்களுக்கு அனுமதி இல்லாமல் இருக்கலாம், அல்லது தேதி வர்த்தக நாள் அல்ல. எதுவும் பதிவு செய்யப்படவில்லை.',
    postLostLink: 'இணைப்பு இல்லை — சேமிக்கப்படவில்லை. மீண்டும் முயற்சிக்கவும்.',
    postLate: 'இந்த நாள் மூடிய மாதத்திற்குரியது; அடுத்த திறந்த காலத்தில் பதிவு செய்யப்பட்டது', postCounted: 'எண்ணப்பட்டது',
    scrReady: 'நாள் புத்தகத்தைக் காட்டுகிறது', scrEmpty: 'இந்த நாளுக்கு இன்னும் எதுவும் பதிவு செய்யப்படவில்லை.',
    stateNotPermitted: 'நாள் புத்தகத்தைப் பார்க்க உங்களுக்கு அனுமதி இல்லை.',
    nobodyNamed: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை.',
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:', sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
  },
};

export const COPY_KEYS: readonly CopyKey[] = Object.freeze(Object.keys(DAY_BOOK_COPY.en) as CopyKey[]);

const REASON_COPY: Readonly<Record<DayBookExceptionReason, CopyKey>> = {
  tax_rate_unknown: 'reasonTaxRateUnknown', tax_split_failed: 'reasonTaxSplitFailed', negative_line: 'reasonNegativeLine',
  lines_do_not_sum_to_total: 'reasonLinesDoNotSum', tenders_do_not_sum_to_total: 'reasonTendersDoNotSum',
  refund_split_unknown: 'reasonRefundSplitUnknown', unmapped_kind: 'reasonUnmappedKind', missing_component: 'reasonMissingComponent',
  unbalanced_journal: 'reasonUnbalancedJournal',
};
const isReason = (r: string): r is DayBookExceptionReason => r in REASON_COPY;

// ── the presented shapes the view renders ────────────────────────────────────────────────────────────────

export interface PresentedJournal {
  readonly entryId: string;
  readonly kind: string;
  /** "Sales", "Returns", "Takings — cash", "Refunds — upi" … */
  readonly kindLabel: string;
  readonly amount: string;
  readonly amountMinor: number;
  readonly sources: number;
  readonly period: string;
  readonly documentDate: string;
  readonly late: boolean;
  readonly belongsTo: string | null;
  readonly postedBy: string;
  readonly narrative: string;
  readonly lines: readonly { readonly accountCode: string; readonly debit: string; readonly credit: string }[];
  /** Posted = ok; posted late into the next open period = degraded (a word and an icon ride with it). */
  readonly status: StatusPresentation;
}

export interface PresentedAccount {
  readonly accountCode: string;
  readonly debit: string;
  readonly credit: string;
  readonly balance: string;
  readonly balanceMinor: number;
}

export interface PresentedException {
  readonly exceptionId: string;
  readonly reason: string;
  readonly reasonLabel: string;
  readonly detail: string;
  readonly sourceKind: DayBookSourceKind;
  readonly sourceCount: number;
  readonly kind: string | null;
  readonly state: 'open' | 'resolved';
  /** Open = error (money the accounts have not taken); resolved = ok. */
  readonly status: StatusPresentation;
}

export interface DayBookView {
  readonly screenState: StatusPresentation;
  readonly tradingDay: string | null;
  /** True when at least one journal is posted for the day. */
  readonly posted: boolean;
  readonly journals: readonly PresentedJournal[];
  readonly accounts: readonly PresentedAccount[];
  /** Open exceptions first, then resolved. */
  readonly exceptions: readonly PresentedException[];
  readonly openCount: number;
  readonly resolvedCount: number;
  readonly covered: number;
  /** The sales and returns totals as posted (from the `sale` / `sale_return` journals), or null when not posted. */
  readonly salesTotal: string | null;
  readonly returnsTotal: string | null;
  readonly nobodyNamed: boolean;
  /** Whether to offer the post action — this user holds `finance.journal.post`. */
  readonly mayPost: boolean;
}

export interface DayBookSession {
  text(lang: Lang, key: CopyKey): string;
  view(lang: Lang): DayBookView;
  /** Post a trading day into the accounts, in the caller's own name — a HUMAN write that runs only from an
   *  explicit action; refuses BEFORE any POST without permission or a valid trading day. */
  post(tradingDay: string): Promise<PostResult>;
  /** Present a posting's outcome as one glanceable status the shell shows after the action. */
  presentPostResult(lang: Lang, result: PostResult): StatusPresentation;
}

const rupees = (minor: number): string => {
  const sign = minor < 0 ? '-' : '';
  return `${sign}₹${(Math.abs(minor) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const EMPTY_VIEW = (screenState: StatusPresentation, tradingDay: string | null, nobodyNamed: boolean, mayPost: boolean): DayBookView => ({
  screenState, tradingDay, posted: false, journals: [], accounts: [], exceptions: [], openCount: 0, resolvedCount: 0, covered: 0,
  salesTotal: null, returnsTotal: null, nobodyNamed, mayPost,
});

export function createDayBookSession(config: DayBookConfig, ports: DayBookPorts): DayBookSession {
  const text = (lang: Lang, key: CopyKey): string => translator(DAY_BOOK_COPY, lang)(key);

  const kindLabel = (lang: Lang, kind: string): string => {
    const t = translator(DAY_BOOK_COPY, lang);
    if (kind === 'sale') return t('kindSale');
    if (kind === 'sale_return') return t('kindSaleReturn');
    const [head, tail] = kind.split(':');
    if (head === 'tender') return `${t('kindTender')} — ${tail ?? ''}`;
    if (head === 'refund') return `${t('kindRefund')} — ${tail ?? ''}`;
    return kind;
  };

  const presentJournal = (lang: Lang, j: DayBookJournalView): PresentedJournal => {
    const t = translator(DAY_BOOK_COPY, lang);
    const late = j.belongsTo !== undefined;
    const amountMinor = j.components['total'] ?? j.components['amount'] ?? 0;
    const label = kindLabel(lang, j.kind);
    return {
      entryId: j.entryId, kind: j.kind, kindLabel: label, amount: rupees(amountMinor), amountMinor, sources: j.sources,
      period: j.period, documentDate: j.documentDate, late, belongsTo: j.belongsTo ?? null, postedBy: j.postedBy, narrative: j.narrative,
      lines: j.lines.map((l) => ({ accountCode: l.accountCode, debit: rupees(l.debitMinor), credit: rupees(l.creditMinor) })),
      status: late
        ? presentStatus({ tone: 'degraded', icon: '⚠', label: t('stateLate'), announcement: `${label}: ${t('stateLate')} ${j.period}`, needsAttention: true })
        : presentStatus({ tone: 'ok', icon: '✓', label: t('stateOk'), announcement: `${label}: ${t('stateOk')} ${j.period}`, needsAttention: false }),
    };
  };

  const presentException = (lang: Lang, e: DayBookExceptionView): PresentedException => {
    const t = translator(DAY_BOOK_COPY, lang);
    const reasonLabel = isReason(e.reason) ? t(REASON_COPY[e.reason]) : t('reasonOther');
    return {
      exceptionId: e.exceptionId, reason: e.reason, reasonLabel, detail: e.detail, sourceKind: e.sourceKind, sourceCount: e.sourceIds.length,
      kind: e.kind ?? null, state: e.state,
      status: e.state === 'open'
        ? presentStatus({ tone: 'error', icon: '✕', label: t('stateOpen'), announcement: `${reasonLabel}: ${t('stateOpen')}`, needsAttention: true })
        : presentStatus({ tone: 'ok', icon: '✓', label: t('stateResolved'), announcement: `${reasonLabel}: ${t('stateResolved')}`, needsAttention: false }),
    };
  };

  return {
    text,
    view: (lang) => {
      const t = translator(DAY_BOOK_COPY, lang);
      const nobodyNamed = config.userId === null;
      const mayPost = ports.mayPost();
      if (!ports.mayRead()) {
        return EMPTY_VIEW(presentScreenState({ state: 'error', label: t('stateNotPermitted') }), null, nobodyNamed, mayPost);
      }
      const data = ports.dayBook();
      if (data === null) return EMPTY_VIEW(presentScreenState({ state: 'empty', label: t('scrEmpty') }), null, nobodyNamed, mayPost);

      const journals = data.journals.map((j) => presentJournal(lang, j));
      const accounts = data.accounts.map((a) => ({ accountCode: a.accountCode, debit: rupees(a.debitMinor), credit: rupees(a.creditMinor), balance: rupees(a.balanceMinor), balanceMinor: a.balanceMinor }));
      const exceptions = [...data.exceptions].sort((a, b) => (a.state === b.state ? 0 : a.state === 'open' ? -1 : 1)).map((e) => presentException(lang, e));
      const total = (kind: string): string | null => {
        const j = data.journals.find((x) => x.kind === kind);
        return j === undefined ? null : rupees(j.components['total'] ?? 0);
      };
      const posted = journals.length > 0;
      const state = posted || exceptions.length > 0 ? 'ready' : 'empty';
      return {
        screenState: presentScreenState({ state, label: t(state === 'empty' ? 'scrEmpty' : 'scrReady') }),
        tradingDay: data.tradingDay, posted, journals, accounts, exceptions,
        openCount: exceptions.filter((e) => e.state === 'open').length,
        resolvedCount: exceptions.filter((e) => e.state === 'resolved').length,
        covered: data.covered,
        salesTotal: total('sale'), returnsTotal: total('sale_return'),
        nobodyNamed, mayPost,
      };
    },

    // Post the day. Refuse BEFORE any POST — no permission or not a trading day is a local refusal, not a round
    // trip. The server re-checks the permission, needs a posting map, and is idempotent on the day.
    post: async (tradingDay) => {
      if (!ports.mayPost() || !isTradingDay(tradingDay)) return { result: 'refused' };
      return ports.postPort().post({ tradingDay });
    },

    presentPostResult: (lang, r) => {
      const t = translator(DAY_BOOK_COPY, lang);
      if (r.result === 'posted') {
        const late = r.body.postedLate !== undefined;
        const label = `${t('postDone')} ${r.body.journals.length} ${t('postedSummary')} → ${r.body.postedTo}; ${r.body.counted.sales}/${r.body.counted.returns} ${t('postCounted')}${late ? ` · ${t('postLate')} (${r.body.postedLate?.belongsTo ?? ''})` : ''}`;
        return presentStatus({ tone: late ? 'degraded' : 'ok', icon: late ? '⚠' : '✓', label, needsAttention: late || r.body.exceptions.length > 0 });
      }
      if (r.result === 'nothing_new') return presentStatus({ tone: 'idle', icon: '○', label: t('postNothing'), needsAttention: false });
      if (r.result === 'no_posting_map') return presentStatus({ tone: 'error', icon: '✕', label: t('postNoMap'), needsAttention: true });
      if (r.result === 'lost_link') return presentStatus({ tone: 'degraded', icon: '⚠', label: t('postLostLink'), needsAttention: true });
      return presentStatus({ tone: 'error', icon: '✕', label: t('postRefused'), needsAttention: true });
    },
  };
}
