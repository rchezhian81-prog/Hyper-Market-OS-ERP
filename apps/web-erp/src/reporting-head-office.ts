// Batch 20c · O2 — the reports head office works out, run from the store computer's Reports page (D13 · M29-FR-01/02 ·
// M08-FR-04 · roadmap §8.3 · P-02 · P-08).
//
// Eighteen of the twenty-nine reports the catalogue names rest on facts the store computer does not keep: the purchase-order
// register, the supplier bills and their match verdicts, the stock ledger, the shelf counts, the write-offs, the loyalty
// ledger, the posted day book, the bank and settlement files, the GST returns, online orders, campaigns, the assistant's
// register and the identity ledger. Head office already holds every one of them and already works each report out from its
// own governed records (`GET /v1/reports/:name`, services/api/src/report-producers*.ts). Until now the Reports page listed
// them as "this version cannot work it out yet". This module asks head office for them — one truth (P-02), never a second
// sum here — for exactly the period the person chose, and says exactly which days the figures cover:
//
//   • a PERIOD report (purchases, supplier service, bill differences, shrinkage, waste, customers coming back, campaigns,
//     online orders, deliveries, the assistant, security, profitability) is asked for `?from=…&to=…`; head office names
//     the days its figures cover (a period runs to today at the latest);
//   • a report about how things stand NOW (stock on hand, loyalty points, approaching expiry) is shown for Today only — for
//     any other period it reads "Not known for this period" with why (head office keeps no record of how it stood then);
//   • MONEY IN THE BANK is checked by whole months (the month close's own evidence) — head office says which months;
//   • GST is read from the GST RETURNS (GSTR-3B for each whole month, `GET /v1/finance/gstr3b/:MMYYYY`) — the same source
//     the GST returns page files from, never a re-count; a period that is not whole months reads "Not known" with why;
//   • PROFITABILITY: revenue from the posted day book; the cost of goods (and so the profit) only for Today — for any other
//     period "Not known for this period" (owner, OB-877 A: head office keeps only today's average buying cost).
//
// With head office out of reach (no internet), NOTHING is shown in its place — no old copy as if it were current (P-08): the
// report says "Not known — head office cannot be reached …". A refusal (no permission, company-wide records) is shown in
// head office's own words.
//
// DOM-free; the page hands in the `HeadOfficeHttp` (tests hand in a fake). Read-only: every call is a GET.

import type { HeadOfficeHttp } from './head-office-http';
import { REPORTS, type ReportDefinition } from '../../../packages/reporting/src/index';
import { figure, type Figure } from '../../../services/reporting/src/index';

/** The reports this page asks head office for — every catalogue report the store computer does not work out itself. */
export const AT_HEAD_OFFICE: readonly string[] = Object.freeze([
  'purchases_by_supplier', 'supplier_service', 'invoice_differences',
  'stock_on_hand', 'shrinkage', 'expiry', 'waste',
  'customer_repeat', 'loyalty', 'marketing',
  'orders_and_substitutions', 'delivery_sla', 'delivery_contribution',
  'gst', 'reconciliation', 'profitability',
  'ai_outcomes', 'security',
]);

/** The head-office reports about how things stand NOW (not over a period). */
export const NOW_AT_HEAD_OFFICE: ReadonlySet<string> = new Set(['stock_on_hand', 'loyalty', 'expiry']);

export const HEAD_OFFICE_NOT_REACHED = 'Not known — this report is worked out by head office from its own records, and this computer cannot reach head office right now. Nothing is shown rather than an old copy; try again when the internet is back';
export const NOW_FOR_PERIOD_AT_HEAD_OFFICE = 'Not known for this period — this report shows how things stand now; head office keeps no record of how it stood on earlier days. Choose Today';
export const GST_WHOLE_MONTHS = 'Not known for this period — GST is read from the GST returns, which are made for whole months. Choose This month or Last month, or From – to running from the 1st of a month to its last day';
export const PERIOD_NOT_STARTED = 'Not known for this period — the period has not started yet';

/** What the page shows for a head-office report: the figures, the rows, and exactly what they cover. */
export interface HeadOfficeReport {
  readonly report: ReportDefinition;
  readonly figures: readonly Figure[];
  readonly rows: readonly Readonly<Record<string, string>>[];
  /** The days the figures cover, as head office said; `null` = how things stand now (or nothing could be shown). */
  readonly covers: { readonly from: string; readonly to: string } | null;
  /** True when the figures are about NOW (stock on hand, loyalty, expiry). */
  readonly now: boolean;
  /** How it ended: `shown` (head office answered), `not_reached`, `refused` (head office said no, in its words) or `not_for_period`. */
  readonly state: 'shown' | 'not_reached' | 'refused' | 'not_for_period';
  /** Things to read beside the figures (a GST month still provisional, a difference that needs a person). */
  readonly notes: readonly string[];
  /** When head office answered (ISO); absent when it did not. */
  readonly readAt?: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const shift = (iso: string, n: number): string => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const lastOfMonth = (iso: string): string => shift(`${shift(`${iso.slice(0, 8)}01`, 32).slice(0, 8)}01`, -1);

/** The whole months a period covers (each `YYYY-MM`), or `null` when it is not whole months (the current month may end today). */
export function wholeMonths(period: { readonly from: string; readonly to: string }, today: string): readonly string[] | null {
  if (!DAY.test(period.from) || !DAY.test(period.to) || period.to < period.from) return null;
  if (period.from.slice(8) !== '01') return null;
  const endsWell = period.to === lastOfMonth(period.to) || (period.to === today && period.to.slice(0, 7) === today.slice(0, 7));
  if (!endsWell) return null;
  const months: string[] = [];
  for (let m = period.from.slice(0, 7); m <= period.to.slice(0, 7); m = shift(`${m}-01`, 32).slice(0, 7)) months.push(m);
  return months;
}

interface Gstr3bView {
  readonly period: string;
  readonly basis: 'locked_to_filed_gstr1' | 'provisional_gstr1_not_filed' | 'gstr1_filed_not_yet_locked';
  readonly table31: { readonly a: { taxableMinor: number; cgstMinor: number; sgstMinor: number; igstMinor: number }; readonly c: { taxableMinor: number }; readonly d: { taxableMinor: number; cgstMinor: number; sgstMinor: number; igstMinor: number } };
  readonly table4: { readonly a5AllOther: { readonly status: string; readonly igstMinor?: number; readonly cgstMinor?: number; readonly sgstMinor?: number; readonly cessMinor?: number; readonly detail: string } };
  readonly exceptions?: readonly { readonly code: string; readonly detail: string }[];
}

const BASIS_WORDS: Readonly<Record<Gstr3bView['basis'], string>> = Object.freeze({
  locked_to_filed_gstr1: 'filed (GSTR-3B locked to the filed GSTR-1)',
  gstr1_filed_not_yet_locked: 'GSTR-1 filed; GSTR-3B not locked to it yet',
  provisional_gstr1_not_filed: 'provisional — GSTR-1 not filed yet, so these will move as sales are banked',
});

/**
 * Ask head office for one report, for the period the person chose (`asked`, the shop's `today`). Never throws for a lost
 * link or a refusal — each is a report that says so, in the space where the figures would be.
 */
export async function runAtHeadOffice(input: {
  readonly reportId: string;
  readonly http: HeadOfficeHttp | undefined;
  readonly asked: { readonly from: string; readonly to: string };
  readonly today: string;
  readonly now: string;
  readonly laggingAfterMinutes: number;
  readonly staleAfterMinutes: number;
}): Promise<HeadOfficeReport | undefined> {
  const report = REPORTS.find((r) => r.id === input.reportId);
  if (report === undefined || !AT_HEAD_OFFICE.includes(input.reportId)) return undefined;
  const isNow = NOW_AT_HEAD_OFFICE.has(input.reportId);
  const notKnown = (state: HeadOfficeReport['state'], why: string, notes: readonly string[] = []): HeadOfficeReport => ({
    report, rows: [], covers: null, now: isNow, state, notes,
    figures: [figure({ name: report.name, unit: 'count', asAt: null, now: input.now, laggingAfterMinutes: input.laggingAfterMinutes, staleAfterMinutes: input.staleAfterMinutes, notAvailableBecause: why })],
  });
  const todayOnly = input.asked.from === input.today && input.asked.to === input.today;
  if (isNow && !todayOnly) return notKnown('not_for_period', NOW_FOR_PERIOD_AT_HEAD_OFFICE);
  if (input.asked.from > input.today) return notKnown('not_for_period', PERIOD_NOT_STARTED);
  const period = { from: input.asked.from, to: input.asked.to > input.today ? input.today : input.asked.to };
  if (input.http === undefined) return notKnown('not_reached', HEAD_OFFICE_NOT_REACHED);

  if (input.reportId === 'gst') return gstFromReturns(input, report, period, notKnown);

  const path = `/v1/reports/${encodeURIComponent(input.reportId)}${isNow ? '' : `?from=${period.from}&to=${period.to}`}`;
  const answer = await input.http.get(path);
  if (answer.result === 'lost_link') return notKnown('not_reached', HEAD_OFFICE_NOT_REACHED);
  if (answer.result === 'refused') return notKnown('refused', `Not shown — head office said: ${answer.whatHappened === '' ? `it refused (${answer.code})` : answer.whatHappened}`);
  const body = answer.body as { figures?: Figure[]; rows?: Record<string, string>[]; period?: { from: string; to: string }; tradingDay?: string; readAt?: string } | null;
  if (body === null || !Array.isArray(body.figures)) return notKnown('not_reached', HEAD_OFFICE_NOT_REACHED);
  // What the figures cover, as head office said it: a period (asked for, or the whole months a bank check covers), else
  // the day it reported on; a report about now covers no days.
  const covers = isNow ? null : (body.period ?? (typeof body.tradingDay === 'string' ? { from: body.tradingDay, to: body.tradingDay } : period));
  return {
    report, figures: body.figures, rows: Array.isArray(body.rows) ? body.rows : [], covers, now: isNow, state: 'shown', notes: [],
    ...(typeof body.readAt === 'string' ? { readAt: body.readAt } : {}),
  };
}

/** GST, from the GST returns: GSTR-3B for each whole month of the period, added up head by head (nothing re-computed). */
async function gstFromReturns(
  input: Parameters<typeof runAtHeadOffice>[0],
  report: ReportDefinition,
  period: { from: string; to: string },
  notKnown: (state: HeadOfficeReport['state'], why: string, notes?: readonly string[]) => HeadOfficeReport,
): Promise<HeadOfficeReport> {
  const months = wholeMonths(period, input.today);
  if (months === null) return notKnown('not_for_period', GST_WHOLE_MONTHS);
  const views: Gstr3bView[] = [];
  let readAt: string | undefined;
  for (const m of months) {
    const answer = await input.http!.get(`/v1/finance/gstr3b/${m.slice(5, 7)}${m.slice(0, 4)}`);
    if (answer.result === 'lost_link') return notKnown('not_reached', HEAD_OFFICE_NOT_REACHED);
    if (answer.result === 'refused') return notKnown('refused', `Not shown — head office said: ${answer.whatHappened === '' ? `it refused (${answer.code})` : answer.whatHappened}`);
    views.push(answer.body as Gstr3bView);
    readAt = input.now;
  }
  const mk = (name: string, valueMinor: number | undefined, because?: string): Figure => figure({
    name, unit: 'minor_currency', asAt: readAt ?? null, now: input.now, laggingAfterMinutes: input.laggingAfterMinutes, staleAfterMinutes: input.staleAfterMinutes,
    ...(because !== undefined ? { notAvailableBecause: because } : valueMinor === undefined ? {} : { valueMinor }),
  });
  const total = (f: (v: Gstr3bView) => number): number => views.reduce((t, v) => t + f(v), 0);
  const itcOpen = views.filter((v) => v.table4.a5AllOther.status !== 'reconciled');
  const itcWhy = itcOpen.length === 0 ? undefined
    : `Not known — the purchase GST you may claim is not reconciled yet for ${itcOpen.map((v) => `${v.period.slice(0, 2)}/${v.period.slice(2)}`).join(', ')} (${itcOpen[0]!.table4.a5AllOther.detail})`;
  const itc = (v: Gstr3bView): number => (v.table4.a5AllOther.cgstMinor ?? 0) + (v.table4.a5AllOther.sgstMinor ?? 0) + (v.table4.a5AllOther.igstMinor ?? 0) + (v.table4.a5AllOther.cessMinor ?? 0);
  const notes: string[] = views.map((v) => `${v.period.slice(0, 2)}/${v.period.slice(2)}: ${BASIS_WORDS[v.basis] ?? v.basis}`);
  for (const v of views) for (const e of v.exceptions ?? []) if (e.code === 'reconciliation_difference') notes.push(`${v.period.slice(0, 2)}/${v.period.slice(2)}: ${e.detail}`);
  return {
    report, state: 'shown', now: false, notes, ...(readAt === undefined ? {} : { readAt }),
    covers: { from: `${months[0]!}-01`, to: period.to },
    figures: [
      mk('Taxable sales (GSTR-3B 3.1 a)', total((v) => v.table31.a.taxableMinor)),
      mk('GST collected — CGST', total((v) => v.table31.a.cgstMinor)),
      mk('GST collected — SGST', total((v) => v.table31.a.sgstMinor)),
      mk('GST collected — IGST', total((v) => v.table31.a.igstMinor)),
      mk('Nil-rated and exempt sales (3.1 c)', total((v) => v.table31.c.taxableMinor)),
      mk('GST on purchases under reverse charge (3.1 d)', total((v) => v.table31.d.cgstMinor + v.table31.d.sgstMinor + v.table31.d.igstMinor)),
      mk('GST paid on purchases you may claim (4 A 5)', itcWhy === undefined ? total(itc) : undefined, itcWhy),
    ],
    rows: views.map((v) => ({
      month: `${v.period.slice(0, 2)}/${v.period.slice(2)}`, basis: BASIS_WORDS[v.basis] ?? v.basis,
      taxableMinor: String(v.table31.a.taxableMinor), cgstMinor: String(v.table31.a.cgstMinor), sgstMinor: String(v.table31.a.sgstMinor), igstMinor: String(v.table31.a.igstMinor),
      nilMinor: String(v.table31.c.taxableMinor), claimableMinor: v.table4.a5AllOther.status === 'reconciled' ? String(itc(v)) : 'not known',
    })),
  };
}

// ── One language at a time: this module's own sentences in Tamil (head office's own findings stay as it said them) ──────
const TA: Readonly<Record<string, string>> = Object.freeze({
  [HEAD_OFFICE_NOT_REACHED]: 'தெரியவில்லை — இந்த அறிக்கையைத் தலைமை அலுவலகம் அதன் சொந்தப் பதிவுகளிலிருந்து கணக்கிடுகிறது; இந்தக் கணினியால் இப்போது தலைமை அலுவலகத்தை அடைய முடியவில்லை. பழைய நகலைக் காட்டுவதற்குப் பதில் எதுவும் காட்டப்படவில்லை; இணையம் திரும்பியதும் மீண்டும் முயலவும்',
  [NOW_FOR_PERIOD_AT_HEAD_OFFICE]: 'இந்தக் காலத்திற்குத் தெரியவில்லை — இந்த அறிக்கை இப்போது உள்ள நிலையைக் காட்டுகிறது; முந்தைய நாட்களில் அது எப்படி இருந்தது என்ற பதிவைத் தலைமை அலுவலகம் வைத்திருக்கவில்லை. "இன்று" என்பதைத் தேர்வு செய்க',
  [GST_WHOLE_MONTHS]: 'இந்தக் காலத்திற்குத் தெரியவில்லை — ஜிஎஸ்டி, ஜிஎஸ்டி ரிட்டர்ன்களிலிருந்து படிக்கப்படுகிறது; அவை முழு மாதங்களுக்கு மட்டுமே. "இந்த மாதம்", "கடந்த மாதம்", அல்லது ஒரு மாதத்தின் 1 ஆம் தேதி முதல் அதன் கடைசி நாள் வரை தேர்வு செய்க',
  [PERIOD_NOT_STARTED]: 'இந்தக் காலத்திற்குத் தெரியவில்லை — காலம் இன்னும் தொடங்கவில்லை',
  'Not known for this period — head office keeps only today\'s average buying cost, not the cost on each earlier day (owner, OB-877 A)': 'இந்தக் காலத்திற்குத் தெரியவில்லை — தலைமை அலுவலகம் இன்றைய சராசரி வாங்கும் விலையை மட்டுமே வைத்திருக்கிறது, முந்தைய ஒவ்வொரு நாளின் விலையை அல்ல (உரிமையாளர், OB-877 A)',
  [BASIS_WORDS.locked_to_filed_gstr1]: 'தாக்கல் செய்யப்பட்டது (GSTR-3B, தாக்கல் செய்த GSTR-1 உடன் பூட்டப்பட்டது)',
  [BASIS_WORDS.gstr1_filed_not_yet_locked]: 'GSTR-1 தாக்கல் செய்யப்பட்டது; GSTR-3B இன்னும் அதனுடன் பூட்டப்படவில்லை',
  [BASIS_WORDS.provisional_gstr1_not_filed]: 'தற்காலிகம் — GSTR-1 இன்னும் தாக்கல் செய்யப்படவில்லை, எனவே விற்பனை வங்கியில் சேரச் சேர இவை மாறும்',
});

/** A sentence this module (or head office's fixed OB-877 sentence) wrote, in the reader's language; anything else as said. */
export function reasonIn(lang: 'en' | 'ta', text: string): string {
  if (lang !== 'ta') return text;
  if (TA[text] !== undefined) return TA[text]!;
  const month = /^(\d{2}\/\d{4}): (.*)$/.exec(text);
  if (month !== null && TA[month[2]!] !== undefined) return `${month[1]}: ${TA[month[2]!]}`;
  const shown = /^Not shown — head office said: ([\s\S]*)$/.exec(text);
  if (shown !== null) return `காட்டப்படவில்லை — தலைமை அலுவலகம் சொன்னது: ${shown[1]}`;
  const itc = /^Not known — the purchase GST you may claim is not reconciled yet for ([\s\S]*)$/.exec(text);
  if (itc !== null) return `தெரியவில்லை — கோரக்கூடிய கொள்முதல் ஜிஎஸ்டி இன்னும் சரிபார்க்கப்படவில்லை: ${itc[1]}`;
  return text;
}
