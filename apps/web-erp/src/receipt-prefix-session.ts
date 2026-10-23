// Till bill-number prefixes on the store-setup page — the logic (OB-81 "A" · M01-FR-02).
//
// Head office issues each till a short prefix per (store, till) (`POST /v1/stores/:storeId/tills/:tillId/receipt-prefix`)
// and lists every till's prefix, and every registered till with none (`GET /v1/receipt-prefixes`). This session turns that
// answer into rows the page draws, checks a typed prefix with the SAME rule head office enforces (so the screen never sends
// what would be refused, and shows the bill numbers it would make), and saves under an idempotency key kept per (till,
// prefix) so a retry after a lost reply is the same request. Head office's refusal (a prefix another till holds) is shown
// in head office's own words. No new rule lives here.

import { readReceiptPrefix, receiptNumberFor, RECEIPT_COUNTER_MAX, financialYearOf, nextFinancialYear, isFinancialYear } from '../../../packages/contracts/src/receipt-number';

// A2 (CGST Rule 46(b): the series resets each financial year): a prefix may be issued FOR a financial year. The page shows
// each till's prefix per year, offers this year and next year when issuing, and flags every year-scoped till with no
// prefix for the current year (or, in March, the coming one) — head office's `needsYearPrefix`.

export interface TillPrefixRead {
  readonly storeId: string;
  readonly tillId: string;
  readonly prefix: string;
  readonly version: number;
  readonly setBy: string;
  readonly setAt: string;
  readonly firstNumber: string;
  readonly lastNumber: string;
  readonly history: readonly { readonly prefix: string; readonly version: number }[];
  /** A2: the financial year this prefix numbers, when year-scoped. */
  readonly financialYear?: string;
}
/** A2: a year-scoped till with no prefix for a year that needs one. */
export interface NeedsYearPrefixRead {
  readonly storeId: string;
  readonly storeName?: string;
  readonly tillId: string;
  readonly financialYear: string;
  readonly why: string;
}
export interface NeedsPrefixRead {
  readonly storeId: string;
  readonly storeName?: string;
  readonly tillId: string;
  readonly label?: string;
  readonly flagged: boolean;
  readonly why: string;
}
/** `GET /v1/receipt-prefixes`. */
export interface ReceiptPrefixesRead {
  readonly storesInBusiness: number;
  readonly multiStore: boolean;
  readonly tills: readonly TillPrefixRead[];
  readonly needsPrefix: readonly NeedsPrefixRead[];
  /** A2: head office's current financial year, and every year-scoped till still to be given a prefix. */
  readonly currentFinancialYear?: string;
  readonly needsYearPrefix?: readonly NeedsYearPrefixRead[];
}

export interface PrefixRow {
  readonly storeId: string;
  readonly tillId: string;
  readonly prefix: string | null;
  readonly version: number;
  /** Flagged for the owner: no prefix while the business has more than one store. */
  readonly flagged: boolean;
  readonly why?: string;
  readonly setBy?: string;
  readonly setAt?: string;
  readonly range?: string;
  readonly earlier: readonly string[];
  /** A2: the financial year the row is for — absent for a till's one prefix for every year. */
  readonly financialYear?: string;
}

export type PrefixSaveResult =
  | { readonly kind: 'saved'; readonly row: PrefixRow }
  | { readonly kind: 'refused'; readonly code: string; readonly words: string }
  | { readonly kind: 'failed'; readonly words: string };

export interface ReceiptPrefixPorts {
  readonly post: (path: string, body: unknown, idempotencyKey: string) => Promise<{ readonly status: number; readonly body: unknown }>;
  readonly reload: () => Promise<ReceiptPrefixesRead | null>;
  readonly newKey: () => string;
}

export const PREFIX_WORDS = {
  en: {
    heading: 'Till bill-number prefixes',
    lead: 'Head office gives each till a short prefix so no two stores ever print the same bill number. A bill number is the prefix and a 6-digit count — at most 16 characters (GST).',
    oneStore: 'One store: a till with no prefix keeps its store computer\'s own numbering. Issue prefixes before a second store opens.',
    manyStores: 'More than one store: a till with no prefix numbers its bills under its store computer\'s own store prefix (ZZ…) until you issue one.',
    noTills: 'No tills are known to head office yet. Register each till on the Devices page, or type its store and till below.',
    store: 'Store', till: 'Till', prefix: 'Prefix', issue: 'Issue prefix', change: 'Change prefix',
    none: 'No prefix issued', flagged: 'Needs a prefix', setBy: 'issued by', earlier: 'earlier',
    numbers: 'Bills will be numbered', saving: 'Saving…', saved: 'Issued ✓', refused: 'Head office refused:', failed: 'Not saved:',
    readOnly: 'You are viewing this — an administrator issues prefixes.', newTill: 'Another till',
    year: 'Financial year', everyYear: 'Every year (does not start again)', forYear: 'for',
    yearLead: 'GST bill numbers start again every financial year (1 April). Issue each till a new prefix for each year, before 1 April — a prefix is never used in two years.',
  },
  ta: {
    heading: 'கவுண்டர் பில் எண் முன்னொட்டுகள்',
    lead: 'இரண்டு கடைகள் ஒரே பில் எண்ணை அச்சிடாமல் இருக்க, தலைமை அலுவலகம் ஒவ்வொரு கவுண்டருக்கும் ஒரு சிறிய முன்னொட்டைத் தருகிறது. பில் எண் = முன்னொட்டு + 6 இலக்க எண்ணிக்கை — அதிகபட்சம் 16 எழுத்துகள் (GST).',
    oneStore: 'ஒரே கடை: முன்னொட்டு இல்லாத கவுண்டர் தன் கடை கணினியின் சொந்த எண்களைத் தொடரும். இரண்டாவது கடை திறக்கும் முன் முன்னொட்டுகளை வழங்கவும்.',
    manyStores: 'ஒன்றுக்கு மேற்பட்ட கடைகள்: முன்னொட்டு இல்லாத கவுண்டர், நீங்கள் வழங்கும் வரை, தன் கடை கணினியின் கடை முன்னொட்டில் (ZZ…) பில் எண்களை இடும்.',
    noTills: 'தலைமை அலுவலகத்துக்கு இன்னும் எந்தக் கவுண்டரும் தெரியவில்லை. சாதனங்கள் பக்கத்தில் பதிவு செய்யவும், அல்லது கீழே கடையையும் கவுண்டரையும் தட்டச்சு செய்யவும்.',
    store: 'கடை', till: 'கவுண்டர்', prefix: 'முன்னொட்டு', issue: 'முன்னொட்டை வழங்கு', change: 'முன்னொட்டை மாற்று',
    none: 'முன்னொட்டு வழங்கப்படவில்லை', flagged: 'முன்னொட்டு தேவை', setBy: 'வழங்கியவர்', earlier: 'முன்பு',
    numbers: 'பில் எண்கள்', saving: 'சேமிக்கிறது…', saved: 'வழங்கப்பட்டது ✓', refused: 'தலைமை அலுவலகம் மறுத்தது:', failed: 'சேமிக்கப்படவில்லை:',
    readOnly: 'நீங்கள் இதைப் பார்க்கிறீர்கள் — ஒரு நிர்வாகி முன்னொட்டுகளை வழங்குவார்.', newTill: 'மற்றொரு கவுண்டர்',
    year: 'நிதியாண்டு', everyYear: 'எல்லா ஆண்டுகளுக்கும் (மீண்டும் தொடங்காது)', forYear: 'ஆண்டு',
    yearLead: 'GST பில் எண்கள் ஒவ்வொரு நிதியாண்டும் (ஏப்ரல் 1) மீண்டும் தொடங்கும். ஏப்ரல் 1-க்கு முன், ஒவ்வொரு கவுண்டருக்கும் ஒவ்வொரு ஆண்டுக்கும் புதிய முன்னொட்டை வழங்கவும் — ஒரு முன்னொட்டு இரண்டு ஆண்டுகளில் பயன்படாது.',
  },
} as const;
export type PrefixLang = keyof typeof PREFIX_WORDS;

export interface ReceiptPrefixSession {
  readonly canEdit: boolean;
  rows(): readonly PrefixRow[];
  multiStore(): boolean;
  words(lang: PrefixLang): (typeof PREFIX_WORDS)[PrefixLang];
  /** Head office's rule, before sending: undefined when the prefix may be issued, else the words why not. */
  check(prefix: string): string | undefined;
  /** The first and last bill numbers a prefix would make, or undefined when it may not be issued. */
  preview(prefix: string): string | undefined;
  save(storeId: string, tillId: string, prefix: string, financialYear?: string): Promise<PrefixSaveResult>;
  /** A2: the years a prefix may be issued for here — '' (every year), this year and next year. */
  yearChoices(): readonly string[];
}

function rowsOf(read: ReceiptPrefixesRead): readonly PrefixRow[] {
  const issued: PrefixRow[] = read.tills.map((t) => ({
    storeId: t.storeId, tillId: t.tillId, prefix: t.prefix, version: t.version, flagged: false, setBy: t.setBy, setAt: t.setAt,
    range: `${t.firstNumber} … ${t.lastNumber}`, earlier: t.history.filter((h) => h.version !== t.version).map((h) => h.prefix),
    ...(t.financialYear === undefined ? {} : { financialYear: t.financialYear }),
  }));
  const missing: PrefixRow[] = [
    ...read.needsPrefix.map((n) => ({ storeId: n.storeId, tillId: n.tillId, prefix: null, version: 0, flagged: n.flagged, why: n.why, earlier: [] })),
    // A2: a year-scoped till with no prefix for a year that needs one — always flagged: 1 April would number under ZZ….
    ...(read.needsYearPrefix ?? []).map((n) => ({ storeId: n.storeId, tillId: n.tillId, prefix: null, version: 0, flagged: true, why: n.why, earlier: [], financialYear: n.financialYear })),
  ];
  // The ones that need the owner first, then by store and till.
  return [...missing, ...issued].sort((a, b) => (a.flagged !== b.flagged ? (a.flagged ? -1 : 1)
    : a.storeId !== b.storeId ? (a.storeId < b.storeId ? -1 : 1) : a.tillId < b.tillId ? -1 : a.tillId > b.tillId ? 1 : 0));
}

export function createReceiptPrefixSession(input: { readonly read: ReceiptPrefixesRead; readonly canEdit: boolean }, ports: ReceiptPrefixPorts): ReceiptPrefixSession {
  let read = input.read;
  /** One key per (store, till, prefix) until head office answers — a retry after a lost reply is the same request. */
  const keys = new Map<string, string>();
  return {
    canEdit: input.canEdit,
    rows: () => rowsOf(read),
    multiStore: () => read.multiStore,
    words: (lang) => PREFIX_WORDS[lang],
    check: (prefix) => { const r = readReceiptPrefix(prefix); return r.ok ? undefined : r.words; },
    preview: (prefix) => (readReceiptPrefix(prefix).ok ? `${receiptNumberFor(prefix, 1)} … ${receiptNumberFor(prefix, RECEIPT_COUNTER_MAX)}` : undefined),
    yearChoices: () => {
      const now = read.currentFinancialYear !== undefined && isFinancialYear(read.currentFinancialYear) ? read.currentFinancialYear : financialYearOf(new Date().toISOString());
      return now === undefined ? [''] : ['', now, nextFinancialYear(now)];
    },
    save: async (storeId, tillId, prefix, financialYear) => {
      const why = readReceiptPrefix(prefix);
      if (!why.ok) return { kind: 'refused', code: 'receipt_prefix_not_allowed', words: why.words };
      const year = financialYear === undefined || financialYear === '' ? undefined : financialYear;
      const k = `${storeId}\u0000${tillId}\u0000${prefix}\u0000${year ?? ''}`;
      const key = keys.get(k) ?? ports.newKey();
      keys.set(k, key);
      let reply: { readonly status: number; readonly body: unknown };
      try {
        reply = await ports.post(`/v1/stores/${encodeURIComponent(storeId)}/tills/${encodeURIComponent(tillId)}/receipt-prefix`, { prefix, ...(year === undefined ? {} : { financialYear: year }) }, key);
      } catch {
        return { kind: 'failed', words: 'Head office could not be reached, so the prefix was not issued. Try again when the line is back.' };
      }
      keys.delete(k);
      if (reply.status < 300) {
        const fresh = await ports.reload();
        if (fresh !== null) read = fresh;
        const row = rowsOf(read).find((r) => r.storeId === storeId && r.tillId === tillId && r.prefix === prefix);
        return { kind: 'saved', row: row ?? { storeId, tillId, prefix, version: 0, flagged: false, earlier: [], ...(year === undefined ? {} : { financialYear: year }) } };
      }
      const err = (reply.body as { error?: { code?: string; whatHappened?: string } } | null)?.error;
      return { kind: 'refused', code: err?.code ?? `http_${reply.status}`, words: err?.whatHappened ?? 'Head office refused the prefix.' };
    },
  };
}
