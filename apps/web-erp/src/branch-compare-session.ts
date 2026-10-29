// The Compare side by side page (M29-FR-02 "KPI comparison and drill-through" · §27 Owner "branch comparison" · NFR-15 · §28).
// A tested, DOM-free session over head office's own reporting routes (services/reporting/src/drill-through.ts):
//   • the owner picks WHAT to rank — branches, departments, suppliers or staff (cashiers) — and the trading days;
//   • the figures and the transactions behind them are HEAD OFFICE'S: the governed drill (`POST /v1/reporting/drill/governed`)
//     loads the headline and its source records from the same producer that made the report, in the reader's scope as the
//     SERVER derives it (a branch-limited manager gets only their branch, whatever this page sends), and logs the looking;
//   • the ranking is head office's compare (`POST /v1/reporting/compare`) over exactly those governed rows — again scoped by
//     the server — rows that reconcile to the total, the unattributed grouped and never dropped;
//   • one click on a row shows the exact transactions behind it (the governed rows, nothing recomputed here);
//   • a drill that does not add up to its headline is said loudly, never smoothed over.
// The department and supplier rankings first read which figures the report has (`GET /v1/reports/:name`), so each of them is
// drilled by name. Nothing is read on open; nothing is written except the drill's own audit line, which head office keeps.

import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';
import { rupees } from './blanket-orders-session';
import { shopDateIn } from '../../../packages/calendar/src/shop-clock';
import { servedShopZone } from '../../../packages/calendar/src/shop-day';

export { rupees };
export type Lang = 'en' | 'ta';
/** Today in the shop's own zone (packages/calendar shop-clock), never the browser's or UTC — the form's default day. */
export const todayAtShop = (nowIso: string = new Date().toISOString(), timeZone: string = servedShopZone()): string => shopDateIn(nowIso, timeZone);
export type CompareBy = 'branch' | 'category' | 'vendor' | 'staff';
export const COMPARE_BY: readonly CompareBy[] = ['branch', 'category', 'vendor', 'staff'];
/** The longest period one drill may cover — head office's own bound (MAX_DRILL_DAYS), checked here only to say it first. */
export const MAX_COMPARE_DAYS = 31;

export const COMPARE_COPY = {
  en: {
    title: 'Compare side by side', lead: 'Rank your branches, departments, suppliers or staff on head office\'s own figures — then open any row to see the exact bills behind it. You see only the branches your role covers; head office decides that, not this screen.',
    formH: 'What to compare', by: 'Rank', from: 'From (YYYY-MM-DD)', to: 'To (YYYY-MM-DD)', go: 'Compare',
    by_branch: 'Branches — takings', by_category: 'Departments — takings by bill line', by_vendor: 'Suppliers — purchase orders (as they stand)', by_staff: 'Staff (cashiers) — takings',
    resultH: 'Ranking', total: 'Total', share: 'share', txns: 'transactions', open: 'Show the transactions', close: 'Hide',
    reconciles: 'The rows add up to the total.', notReconciled: 'THE ROWS DO NOT ADD UP TO THE TOTAL — do not act on this ranking; tell head office.',
    drillWrong: 'A figure and its transactions do not agree:', scopeIs: 'Branches you can see:', scopeAll: 'all branches', withheld: 'transaction(s) in branches outside your access are not shown, worth',
    nothing: 'Nothing to rank in these days.', notAvailable: 'Not available:', periodNote: 'Suppliers are ranked on purchase orders as they stand today — the days do not apply.',
    txnH: 'Transactions behind', when: 'When', branch: 'Branch', amount: 'Amount', what: 'What', unattributed: 'Unattributed — no value recorded for this',
    needDays: 'Write both days (YYYY-MM-DD), from on or before to, at most 31 days.', needBy: 'Pick what to rank.',
    nobody: 'Nobody is signed in on this screen.', cannotCompare: 'Your role cannot read the owner\'s figures.', cannotList: 'Your role cannot read the reports this ranking is made from.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read.',
  },
  ta: {
    title: 'அருகருகே ஒப்பிடு', lead: 'தலைமை அலுவலகத்தின் சொந்த எண்களில் உங்கள் கிளைகள், துறைகள், விநியோகஸ்தர்கள் அல்லது பணியாளர்களை வரிசைப்படுத்துங்கள் — பிறகு எந்த வரியையும் திறந்து அதன் பின்னுள்ள சரியான பில்களைப் பாருங்கள். உங்கள் பணிக்குரிய கிளைகளை மட்டுமே பார்ப்பீர்கள்; அதைத் தலைமை அலுவலகம் தீர்மானிக்கிறது, இந்தத் திரை அல்ல.',
    formH: 'எதை ஒப்பிட வேண்டும்', by: 'வரிசைப்படுத்து', from: 'முதல் (YYYY-MM-DD)', to: 'வரை (YYYY-MM-DD)', go: 'ஒப்பிடு',
    by_branch: 'கிளைகள் — வசூல்', by_category: 'துறைகள் — பில் வரிவாரியான வசூல்', by_vendor: 'விநியோகஸ்தர்கள் — கொள்முதல் ஆணைகள் (இப்போதைய நிலை)', by_staff: 'பணியாளர்கள் (காசாளர்கள்) — வசூல்',
    resultH: 'வரிசை', total: 'மொத்தம்', share: 'பங்கு', txns: 'பரிவர்த்தனைகள்', open: 'பரிவர்த்தனைகளைக் காட்டு', close: 'மறை',
    reconciles: 'வரிகள் மொத்தத்துடன் பொருந்துகின்றன.', notReconciled: 'வரிகள் மொத்தத்துடன் பொருந்தவில்லை — இந்த வரிசையை வைத்துச் செயல்பட வேண்டாம்; தலைமை அலுவலகத்திடம் சொல்லுங்கள்.',
    drillWrong: 'ஒரு எண்ணும் அதன் பரிவர்த்தனைகளும் பொருந்தவில்லை:', scopeIs: 'நீங்கள் பார்க்கும் கிளைகள்:', scopeAll: 'எல்லாக் கிளைகளும்', withheld: 'பரிவர்த்தனை(கள்) உங்கள் அணுகலுக்கு வெளியே உள்ள கிளைகளில் உள்ளன, காட்டப்படவில்லை, மதிப்பு',
    nothing: 'இந்த நாட்களில் வரிசைப்படுத்த எதுவும் இல்லை.', notAvailable: 'கிடைக்கவில்லை:', periodNote: 'விநியோகஸ்தர்கள் இன்றைய கொள்முதல் ஆணைகளின் நிலையில் வரிசைப்படுத்தப்படுகிறார்கள் — நாட்கள் பொருந்தாது.',
    txnH: 'இதன் பின்னுள்ள பரிவர்த்தனைகள்', when: 'எப்போது', branch: 'கிளை', amount: 'தொகை', what: 'என்ன', unattributed: 'ஒதுக்கப்படாதது — இதற்கு மதிப்பு பதிவாகவில்லை',
    needDays: 'இரண்டு நாட்களையும் (YYYY-MM-DD) எழுதுங்கள், முதல் நாள் வரை நாளுக்கு முன், அதிகபட்சம் 31 நாட்கள்.', needBy: 'எதை வரிசைப்படுத்த வேண்டும் எனத் தேர்ந்தெடுங்கள்.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotCompare: 'உங்கள் பணி உரிமையாளரின் எண்களைப் படிக்க முடியாது.', cannotList: 'இந்த வரிசை உருவாகும் அறிக்கைகளை உங்கள் பணி படிக்க முடியாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை.',
  },
} as const;

export const compareWords = (lang: Lang, key: string): string =>
  (COMPARE_COPY[lang] as Record<string, string>)[key] ?? (COMPARE_COPY.en as Record<string, string>)[key] ?? key;

export interface GovernedTxn { readonly transactionId: string; readonly at: string; readonly branchId: string; readonly categoryId?: string; readonly vendorId?: string; readonly staffId?: string; readonly amountMinor: number; readonly description: string }
interface GovernedDrill {
  readonly transactions: readonly GovernedTxn[]; readonly reconciles: boolean; readonly discrepancy?: string; readonly withheldCount: number; readonly withheldTotalMinor: number;
  readonly figure: string; readonly filters?: { readonly branchScope?: readonly string[] | 'all' };
}
export interface ComparisonRow { readonly key: string; readonly label: string; readonly valueMinor: number; readonly transactionCount: number; readonly shareBps: number }
export interface Comparison { readonly dimension: CompareBy; readonly metric: string; readonly rows: readonly ComparisonRow[]; readonly totalMinor: number; readonly reconciles: boolean; readonly detail: string }
export interface CompareView {
  readonly by: CompareBy; readonly from: string; readonly to: string;
  /** Head office's ranking over the governed rows — absent when nothing could be ranked (`notAvailable` says why). */
  readonly comparison?: Comparison;
  readonly notAvailable?: string;
  /** The governed rows the ranking was made from — what a row opens to. */
  readonly transactions: readonly GovernedTxn[];
  /** Each governed drill's honesty line: did its rows add up, and what (if anything) was withheld. */
  readonly drills: readonly { readonly figure: string; readonly reconciles: boolean; readonly discrepancy?: string; readonly withheldCount: number; readonly withheldTotalMinor: number }[];
  /** The branches head office let this reader see (the server's answer). */
  readonly branchScope: readonly string[] | 'all' | null;
}

type Why = 'nobody' | 'cannotCompare' | 'cannotList' | 'needDays' | 'needBy';
type Done<T> = Promise<Outcome<T, Why>>;

export interface CompareSession {
  readonly may: { readonly named: boolean; readonly compare: boolean; readonly list: boolean };
  compare(form: { readonly by: string; readonly from: string; readonly to: string }): Done<CompareView>;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const dayCount = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000) + 1;
const daysOf = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00.000Z`); t <= Date.parse(`${to}T00:00:00.000Z`); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};
const METRIC: Readonly<Record<CompareBy, string>> = {
  branch: 'sales_by_day:Taken', staff: 'sales_by_day:Taken', category: 'units_by_category:<department> — taken', vendor: 'purchases_by_supplier:Ordered',
};

/** The key a governed row ranks under — the same rule head office's compare uses (missing → `unattributed`). */
export function keyOf(t: GovernedTxn, by: CompareBy): string {
  const k = by === 'branch' ? t.branchId : by === 'category' ? t.categoryId : by === 'vendor' ? t.vendorId : t.staffId;
  return k ?? 'unattributed';
}
/** The exact governed transactions behind one ranked row, newest first. */
export const rowTransactions = (view: CompareView, key: string): readonly GovernedTxn[] =>
  view.transactions.filter((t) => keyOf(t, view.by) === key).sort((a, b) => b.at.localeCompare(a.at) || a.transactionId.localeCompare(b.transactionId));
/** Basis points → "12.34%". */
export const shareWords = (bps: number): string => `${(bps / 100).toFixed(2)}%`;

export const compareOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => (out.result === 'ok' ? '' : outcomeIn((k) => compareWords(lang, k), out));

export function createCompareSession(input: {
  readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined;
  readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string;
}): CompareSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, compare: named && held.has('owner.kpi.read'), list: named && held.has('reporting.report.read') };
  const call = makeCaller({ keyPrefix: 'compare', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });

  /** The figures a report has, by name (department or supplier rankings drill each one). */
  const figuresOf = async (reportId: string, day?: string): Promise<Outcome<readonly { name: string; valueMinor?: number; notAvailableBecause?: string }[], never>> => {
    const r = await call<{ figures?: readonly { name: string; valueMinor?: number; notAvailableBecause?: string }[] }>('GET', `/v1/reports/${reportId}${day === undefined ? '' : `?day=${day}`}`);
    return r.result === 'ok' ? { result: 'ok', value: r.value.figures ?? [] } : r;
  };

  return {
    may,
    compare: async (f) => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      if (!may.compare) return { result: 'invalid', why: 'cannotCompare' };
      if (!(COMPARE_BY as readonly string[]).includes(f.by)) return { result: 'invalid', why: 'needBy' };
      const by = f.by as CompareBy;
      const from = f.from.trim(); const to = f.to.trim();
      if (!DAY.test(from) || !DAY.test(to) || from > to || dayCount(from, to) > MAX_COMPARE_DAYS) return { result: 'invalid', why: 'needDays' };
      if ((by === 'category' || by === 'vendor') && !may.list) return { result: 'invalid', why: 'cannotList' };

      // Which governed figures to drill.
      let drills: { reportId: string; figure: string; period: boolean }[];
      if (by === 'branch' || by === 'staff') drills = [{ reportId: 'sales_by_day', figure: 'Taken', period: true }];
      else if (by === 'category') {
        const names = new Set<string>();
        for (const d of daysOf(from, to)) {
          const figs = await figuresOf('units_by_category', d);
          if (figs.result !== 'ok') return figs;
          for (const fig of figs.value) if (fig.name.endsWith(' — taken')) names.add(fig.name);
        }
        drills = [...names].sort().map((figure) => ({ reportId: 'units_by_category', figure, period: true }));
      } else {
        const figs = await figuresOf('purchases_by_supplier');
        if (figs.result !== 'ok') return figs;
        const unavailable = figs.value.find((x) => x.valueMinor === undefined && x.notAvailableBecause !== undefined);
        if (unavailable !== undefined && figs.value.every((x) => x.valueMinor === undefined)) {
          return { result: 'ok', value: { by, from, to, notAvailable: unavailable.notAvailableBecause!, transactions: [], drills: [], branchScope: null } };
        }
        drills = figs.value.filter((x) => x.valueMinor !== undefined).map((x) => ({ reportId: 'purchases_by_supplier', figure: x.name, period: false }));
      }

      const transactions: GovernedTxn[] = [];
      const honesty: CompareView['drills'][number][] = [];
      let branchScope: CompareView['branchScope'] = null;
      for (const d of drills) {
        const r = await call<GovernedDrill>('POST', '/v1/reporting/drill/governed', { reportId: d.reportId, figure: d.figure, ...(d.period ? { period: { from, to } } : {}) });
        if (r.result !== 'ok') return r;
        transactions.push(...r.value.transactions);
        honesty.push({ figure: d.figure, reconciles: r.value.reconciles, ...(r.value.discrepancy === undefined ? {} : { discrepancy: r.value.discrepancy }), withheldCount: r.value.withheldCount, withheldTotalMinor: r.value.withheldTotalMinor });
        branchScope = r.value.filters?.branchScope ?? branchScope;
      }
      if (drills.length === 0) return { result: 'ok', value: { by, from, to, transactions: [], drills: [], branchScope } };
      const ranked = await call<Comparison>('POST', '/v1/reporting/compare', { dimension: by, metric: METRIC[by], transactions });
      if (ranked.result !== 'ok') return ranked;
      return { result: 'ok', value: { by, from, to, comparison: ranked.value, transactions, drills: honesty, branchScope } };
    },
  };
}
