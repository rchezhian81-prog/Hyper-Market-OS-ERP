// The concessionaire's own counter — the tested, DOM-free model behind its portal (M27-FR-02 "only the concessionaire
// accesses it" · M27-FR-03 · OB-676 "A", owner, 2 Nov 2026 · OB-76 · §35 · P-04 · P-07 · P-08).
//
// A concessionaire trading a counter inside the shop signs in with its OWN login (given through the outside-party invite a
// second person approves) and sees four things about its OWN counter, each scoped on the server to the concessionaire its
// login is bound to — the browser has no concessionaire id to send:
//   • its counters: the contract's terms, whether it may trade today (and every reason it may not), its deposit held;
//   • the sales recorded for its counters;
//   • the stock on the shop's shelves that it owns;
//   • the invoices the shop issued to it.
// It reads and reports; it writes nothing. A feed that could not be read is said so ("could not be read just now") — never an
// empty list or a zero (P-08). A login bound to no counter is told so, in words.

import { presentStatus, type StatusPresentation } from '../../../packages/a11y/src/signals';

export type Lang = 'en' | 'ta';
export type ConcessionFeed = 'counters' | 'sales' | 'stock' | 'invoices';
export const CONCESSION_FEEDS: readonly ConcessionFeed[] = ['counters', 'sales', 'stock', 'invoices'];
/** Why a feed is not shown: the login is bound to no counter, the login may not read it, or it could not be read now. */
export type FeedRefusal = 'not_bound' | 'no_grant' | 'unavailable';

export interface CounterView {
  readonly contractId: string; readonly name: string; readonly branchId: string; readonly basis: string;
  readonly fixedRentMinor?: number; readonly revenueShareBps?: number; readonly depositMinor: number;
  readonly validUntil?: string; readonly insuranceUntil?: string; readonly licenceUntil?: string;
  readonly mayTrade: boolean; readonly blockers: readonly string[];
}
export interface SaleView { readonly saleId: string; readonly contractId: string; readonly at: string; readonly grossMinor: number; readonly taxMinor: number; readonly tenderedTo: string; readonly refundOf?: string }
export interface StockLineView { readonly productId: string; readonly locationId: string; readonly onHandMinor: number; readonly valueMinor: number }
export interface InvoiceView { readonly invoiceId: string; readonly number: string; readonly contractId: string; readonly from: string; readonly to: string; readonly issuedOn: string; readonly totalMinor: number | null }

export interface ConcessionPortalData {
  readonly concessionaireId: string | null;
  readonly counters: readonly CounterView[] | null;
  readonly depositHeldMinor: number | null;
  readonly sales: readonly SaleView[] | null;
  readonly stock: readonly StockLineView[] | null;
  readonly invoices: readonly InvoiceView[] | null;
  readonly refusals: Partial<Record<ConcessionFeed, FeedRefusal>>;
  readonly asAt: string;
}

const COPY = {
  en: {
    title: 'Your counter at SRE', langName: 'தமிழ்', refresh: 'Refresh', asOfLabel: 'As of',
    lead: 'Your own counter only: its terms, its sales, the stock you own on the shop’s shelves and the invoices the shop issued to you. Nothing here can be changed from this page.',
    countersHeading: 'Your counters', salesHeading: 'Sales at your counters', stockHeading: 'Your stock on the shop’s shelves', invoicesHeading: 'Invoices issued to you',
    countersNone: 'No counter is on record for you yet.', salesNone: 'No sales recorded for your counters yet.', stockNone: 'The shop’s records show none of your stock on its shelves.', invoicesNone: 'No invoice has been issued to you yet.',
    notBound: 'This login is not linked to a counter (it was never approved, or it was switched off). Ask the shop to invite your login.',
    noGrant: 'Your login cannot see this. Ask the shop.', unavailable: 'This could not be read just now — it does not mean there is nothing. Try Refresh.',
    notSignedIn: 'Nobody is signed in on this page, so nothing can be shown.', notPermitted: 'This page is for a concessionaire’s own login only.',
    mayTrade: 'May trade today', mayNotTrade: 'May NOT trade today', depositLabel: 'Deposit held for you', basisLabel: 'Terms', rentLabel: 'Fixed rent', shareLabel: 'Revenue share',
    validLabel: 'Agreement until', insuranceLabel: 'Insurance until', licenceLabel: 'Licence until', storeLabel: 'Store',
    basis_fixed_rent: 'fixed rent', basis_revenue_share: 'revenue share', basis_higher_of_both: 'the higher of rent or share',
    grossLabel: 'Amount', taxLabel: 'Tax', tillLabel: 'Taken at', till_store_till: 'the shop’s till', till_concessionaire_till: 'your own till', refundLabel: 'Refund of', salesTotal: 'Total of these sales',
    productLabel: 'Product', placeLabel: 'Place', qtyLabel: 'On hand', valueLabel: 'Value at cost', stockTotal: 'Total value at cost',
    periodLabel: 'Period', issuedLabel: 'Issued', totalLabel: 'Total',
    sampleData: 'Sample data — this is not your counter.', staleShell: 'No connection. This page is what you were last shown, at',
  },
  ta: {
    title: 'SRE-இல் உங்கள் கவுண்டர்', langName: 'English', refresh: 'புதுப்பி', asOfLabel: 'நிலவரம்',
    lead: 'உங்கள் சொந்தக் கவுண்டர் மட்டும்: அதன் நிபந்தனைகள், விற்பனைகள், கடை அலமாரிகளில் உள்ள உங்கள் சரக்கு, கடை உங்களுக்கு வழங்கிய விலைப்பட்டியல்கள். இந்தப் பக்கத்திலிருந்து எதையும் மாற்ற முடியாது.',
    countersHeading: 'உங்கள் கவுண்டர்கள்', salesHeading: 'உங்கள் கவுண்டர்களின் விற்பனை', stockHeading: 'கடை அலமாரிகளில் உங்கள் சரக்கு', invoicesHeading: 'உங்களுக்கு வழங்கிய விலைப்பட்டியல்கள்',
    countersNone: 'உங்களுக்கு இன்னும் கவுண்டர் பதிவில் இல்லை.', salesNone: 'உங்கள் கவுண்டர்களுக்கு இன்னும் விற்பனை பதிவாகவில்லை.', stockNone: 'கடையின் பதிவுகளில் அதன் அலமாரிகளில் உங்கள் சரக்கு இல்லை.', invoicesNone: 'உங்களுக்கு இன்னும் விலைப்பட்டியல் வழங்கப்படவில்லை.',
    notBound: 'இந்த உள்நுழைவு எந்தக் கவுண்டருடனும் இணைக்கப்படவில்லை (அனுமதிக்கப்படவில்லை, அல்லது நிறுத்தப்பட்டது). உங்கள் உள்நுழைவை அழைக்கக் கடையிடம் கேளுங்கள்.',
    noGrant: 'உங்கள் உள்நுழைவு இதைப் பார்க்க முடியாது. கடையிடம் கேளுங்கள்.', unavailable: 'இதை இப்போது படிக்க முடியவில்லை — எதுவும் இல்லை என்று பொருள் அல்ல. புதுப்பி அழுத்துங்கள்.',
    notSignedIn: 'இந்தப் பக்கத்தில் யாரும் உள்நுழையவில்லை, எனவே எதையும் காட்ட முடியாது.', notPermitted: 'இந்தப் பக்கம் கவுண்டர் உரிமையாளரின் சொந்த உள்நுழைவுக்கு மட்டுமே.',
    mayTrade: 'இன்று வியாபாரம் செய்யலாம்', mayNotTrade: 'இன்று வியாபாரம் செய்ய முடியாது', depositLabel: 'உங்களுக்காக வைத்துள்ள வைப்புத்தொகை', basisLabel: 'நிபந்தனைகள்', rentLabel: 'நிலையான வாடகை', shareLabel: 'வருவாய்ப் பங்கு',
    validLabel: 'ஒப்பந்தம் வரை', insuranceLabel: 'காப்பீடு வரை', licenceLabel: 'உரிமம் வரை', storeLabel: 'கடை',
    basis_fixed_rent: 'நிலையான வாடகை', basis_revenue_share: 'வருவாய்ப் பங்கு', basis_higher_of_both: 'வாடகை அல்லது பங்கில் அதிகமானது',
    grossLabel: 'தொகை', taxLabel: 'வரி', tillLabel: 'பெற்ற இடம்', till_store_till: 'கடையின் கல்லா', till_concessionaire_till: 'உங்கள் சொந்தக் கல்லா', refundLabel: 'இதன் திருப்பம்', salesTotal: 'இந்த விற்பனைகளின் மொத்தம்',
    productLabel: 'பொருள்', placeLabel: 'இடம்', qtyLabel: 'கையிருப்பு', valueLabel: 'அடக்க மதிப்பு', stockTotal: 'மொத்த அடக்க மதிப்பு',
    periodLabel: 'காலம்', issuedLabel: 'வழங்கியது', totalLabel: 'மொத்தம்',
    sampleData: 'மாதிரித் தகவல் — இது உங்கள் கவுண்டர் அல்ல.', staleShell: 'இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகக் காட்டப்பட்டது:',
  },
} as const;

export const concessionWords = (lang: Lang, key: string): string => (COPY[lang] as Record<string, string>)[key] ?? (COPY.en as Record<string, string>)[key] ?? key;

/** Rupees with paise, Indian grouping — from whole paise. */
export function rupees(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}₹${Math.floor(abs / 100).toLocaleString('en-IN')}.${String(abs % 100).padStart(2, '0')}`;
}

export interface ConcessionPortalView {
  /** 'shown' when the page has something to say; 'not_signed_in' / 'not_permitted' stand in for everything. */
  readonly screen: 'shown' | 'not_signed_in' | 'not_permitted';
  readonly screenStatus: StatusPresentation;
  readonly counters: readonly { readonly contractId: string; readonly headline: string; readonly status: StatusPresentation; readonly facts: readonly string[] }[];
  readonly deposit: string | null;
  readonly sales: readonly { readonly saleId: string; readonly headline: string; readonly amount: string; readonly facts: readonly string[] }[];
  readonly salesTotal: string | null;
  readonly stock: readonly { readonly key: string; readonly headline: string; readonly value: string; readonly facts: readonly string[] }[];
  readonly stockTotal: string | null;
  readonly invoices: readonly { readonly invoiceId: string; readonly headline: string; readonly amount: string; readonly facts: readonly string[] }[];
  /** Per feed: the words to show instead of rows (a refusal, or "none yet") — absent when there are rows. */
  readonly notes: Partial<Record<ConcessionFeed, { readonly words: string; readonly tone: 'muted' | 'warn' }>>;
}

export interface ConcessionPortalSession {
  view(lang: Lang): ConcessionPortalView;
  text(lang: Lang, key: string): string;
}

const SELF = 'concession.portal.self';

/** Build the view model over what the four feeds said. Pure. */
export function createConcessionPortalSession(viewer: { readonly userId: string | null; readonly permissions: readonly string[] }, data: ConcessionPortalData): ConcessionPortalSession {
  const view = (lang: Lang): ConcessionPortalView => {
    const w = (k: string): string => concessionWords(lang, k);
    const empty = { counters: [], deposit: null, sales: [], salesTotal: null, stock: [], stockTotal: null, invoices: [], notes: {} };
    if (viewer.userId === null) return { screen: 'not_signed_in', screenStatus: presentStatus({ tone: 'error', icon: '✕', label: w('notSignedIn') }), ...empty };
    if (!viewer.permissions.includes(SELF)) return { screen: 'not_permitted', screenStatus: presentStatus({ tone: 'error', icon: '✕', label: w('notPermitted') }), ...empty };
    const notes: Partial<Record<ConcessionFeed, { words: string; tone: 'muted' | 'warn' }>> = {};
    const refusalWords = (r: FeedRefusal): string => w(r === 'not_bound' ? 'notBound' : r === 'no_grant' ? 'noGrant' : 'unavailable');
    for (const f of CONCESSION_FEEDS) { const r = data.refusals[f]; if (r !== undefined) notes[f] = { words: refusalWords(r), tone: 'warn' }; }
    const none = (f: ConcessionFeed, rows: readonly unknown[] | null, key: string): void => { if (rows !== null && rows.length === 0 && notes[f] === undefined) notes[f] = { words: w(key), tone: 'muted' }; };
    none('counters', data.counters, 'countersNone'); none('sales', data.sales, 'salesNone'); none('stock', data.stock, 'stockNone'); none('invoices', data.invoices, 'invoicesNone');
    const counters = (data.counters ?? []).map((c) => ({
      contractId: c.contractId,
      headline: `${c.name === '' ? c.contractId : `${c.name} (${c.contractId})`} · ${w('storeLabel')} ${c.branchId}`,
      status: presentStatus(c.mayTrade ? { tone: 'ok', icon: '✓', label: w('mayTrade') } : { tone: 'error', icon: '✕', label: `${w('mayNotTrade')}: ${c.blockers.join('; ')}` }),
      facts: [
        `${w('basisLabel')}: ${w(`basis_${c.basis}`)}`,
        ...(c.fixedRentMinor === undefined ? [] : [`${w('rentLabel')}: ${rupees(c.fixedRentMinor)}`]),
        ...(c.revenueShareBps === undefined ? [] : [`${w('shareLabel')}: ${(c.revenueShareBps / 100).toFixed(2)}%`]),
        ...(c.validUntil === undefined ? [] : [`${w('validLabel')}: ${c.validUntil}`]),
        ...(c.insuranceUntil === undefined ? [] : [`${w('insuranceLabel')}: ${c.insuranceUntil}`]),
        ...(c.licenceUntil === undefined ? [] : [`${w('licenceLabel')}: ${c.licenceUntil}`]),
      ],
    }));
    const sales = (data.sales ?? []).map((s) => ({
      saleId: s.saleId, headline: `${s.saleId} · ${s.contractId}`, amount: rupees(s.grossMinor),
      facts: [`${w('taxLabel')}: ${rupees(s.taxMinor)}`, `${w('tillLabel')}: ${w(`till_${s.tenderedTo}`)}`, s.at, ...(s.refundOf === undefined ? [] : [`${w('refundLabel')} ${s.refundOf}`])],
    }));
    const stock = (data.stock ?? []).map((l) => ({
      key: `${l.productId}@${l.locationId}`, headline: `${w('productLabel')}: ${l.productId}`, value: rupees(l.valueMinor),
      facts: [`${w('placeLabel')}: ${l.locationId}`, `${w('qtyLabel')}: ${l.onHandMinor}`],
    }));
    const invoices = (data.invoices ?? []).map((i) => ({
      invoiceId: i.invoiceId, headline: `${i.number} · ${i.contractId}`, amount: i.totalMinor === null ? '—' : rupees(i.totalMinor),
      facts: [`${w('periodLabel')}: ${i.from} – ${i.to}`, `${w('issuedLabel')}: ${i.issuedOn}`],
    }));
    return {
      screen: 'shown', screenStatus: presentStatus({ tone: 'ok', icon: '✓', label: w('title') }),
      counters, deposit: data.depositHeldMinor === null ? null : rupees(data.depositHeldMinor),
      sales, salesTotal: data.sales === null || data.sales.length === 0 ? null : rupees(data.sales.reduce((n, s) => n + s.grossMinor, 0)),
      stock, stockTotal: data.stock === null || data.stock.length === 0 ? null : rupees(data.stock.reduce((n, l) => n + l.valueMinor, 0)),
      invoices, notes,
    };
  };
  return { view, text: concessionWords };
}

type FeedRead = { readonly ok: true; readonly body: Record<string, unknown> } | { readonly ok: false; readonly refusal: FeedRefusal };

/** Read one portal GET. A 403 `no_grant` / `login_not_bound_to_a_concessionaire` is carried as such; anything else is unavailable. */
export async function readFeed(fetchFn: typeof globalThis.fetch | undefined, path: string): Promise<FeedRead> {
  if (fetchFn === undefined) return { ok: false, refusal: 'unavailable' };
  try {
    const res = await fetchFn(path, { method: 'GET', headers: { accept: 'application/json' }, credentials: 'same-origin' });
    if (res.status >= 400) {
      let code = '';
      try { code = String(((await res.json()) as { error?: { code?: string } }).error?.code ?? ''); } catch { /* an unreadable refusal is still a refusal */ }
      return { ok: false, refusal: res.status === 403 && code === 'login_not_bound_to_a_concessionaire' ? 'not_bound' : res.status === 403 && code === 'no_grant' ? 'no_grant' : 'unavailable' };
    }
    return { ok: true, body: (await res.json()) as Record<string, unknown> };
  } catch {
    return { ok: false, refusal: 'unavailable' };
  }
}

const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const optNum = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
const obj = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const opt = <K extends string, V>(k: K, v: V | undefined): Partial<Record<K, V>> => (v === undefined ? {} : { [k]: v } as Record<K, V>);

/** Read the concessionaire's OWN four feeds (GETs). Null only when nothing at all could be read (offline). */
export async function fetchConcessionPortal(fetchFn: typeof globalThis.fetch | undefined = (globalThis as { fetch?: typeof globalThis.fetch }).fetch): Promise<ConcessionPortalData | null> {
  const [counters, sales, stock, invoices] = await Promise.all(CONCESSION_FEEDS.map((f) => readFeed(fetchFn, `/v1/concession-portal/me/${f}`)));
  const reads: readonly [ConcessionFeed, FeedRead][] = [['counters', counters!], ['sales', sales!], ['stock', stock!], ['invoices', invoices!]];
  if (reads.every(([, r]) => !r.ok && r.refusal === 'unavailable')) return null;
  const refusals: Partial<Record<ConcessionFeed, FeedRefusal>> = {};
  for (const [f, r] of reads) if (!r.ok) refusals[f] = r.refusal;
  const body = (r: FeedRead): Record<string, unknown> | null => (r.ok ? r.body : null);
  const c = body(counters!); const s = body(sales!); const k = body(stock!); const i = body(invoices!);
  return {
    concessionaireId: optStr((c ?? s ?? k ?? i)?.['concessionaireId']) ?? null,
    counters: c === null ? null : arr(c['counters']).map((row) => {
      const contract = obj(row['contract']); const trading = obj(row['trading']);
      const blocked = Array.isArray(trading['blockedBy']) ? (trading['blockedBy'] as unknown[]).map((b) => str(b).replace(/_/g, ' ')).filter((x) => x !== '') : [];
      const blockers = blocked.length > 0 && str(trading['detail']) !== '' ? [str(trading['detail'])] : blocked;
      return {
        contractId: str(contract['contractId']), name: str(contract['name']), branchId: str(contract['branchId']), basis: str(contract['basis']), depositMinor: num(contract['depositMinor']),
        ...opt('fixedRentMinor', optNum(contract['fixedRentMinor'])), ...opt('revenueShareBps', optNum(contract['revenueShareBps'])),
        ...opt('validUntil', optStr(contract['endsOn'])), ...opt('insuranceUntil', optStr(contract['insuranceUntil'])), ...opt('licenceUntil', optStr(contract['licenceUntil'])),
        mayTrade: trading['mayTrade'] === true, blockers,
      };
    }),
    depositHeldMinor: c === null ? null : optNum(obj(c['deposit'])['outstandingLiabilityMinor']) ?? null,
    sales: s === null ? null : arr(s['sales']).map((x) => ({
      saleId: str(x['saleId']), contractId: str(x['contractId']), at: str(x['at']), grossMinor: num(x['grossMinor']), taxMinor: num(x['taxMinor']), tenderedTo: str(x['tenderedTo']),
      ...opt('refundOf', optStr(x['refundOf'])),
    })),
    stock: k === null ? null : arr(k['lines']).map((x) => ({ productId: str(x['productId']), locationId: str(x['locationId']), onHandMinor: num(x['onHandMinor']), valueMinor: num(x['valueMinor']) })),
    invoices: i === null ? null : arr(i['invoices']).map((x) => ({
      invoiceId: str(x['invoiceId']), number: str(x['number']), contractId: str(x['contractId']), from: str(x['from']), to: str(x['to']), issuedOn: str(x['issuedOn']),
      totalMinor: optNum(x['invoiceTotalMinor']) ?? null,
    })),
    refusals,
    asAt: new Date().toISOString(),
  };
}
