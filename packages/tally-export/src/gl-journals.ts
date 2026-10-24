// EVERY journal the general ledger posts, as one daily Tally import file (OB-293 "daily Tally import file first" ·
// M23-FR-04 · M32-FR-04 · D10-FR-06 "Tally control totals" · D14-FR-03 · AVR-09). Pure and deterministic — no clock, no I/O.
//
// The writer (`tally-xml.ts`) already takes any balanced journal. What this adds is the day's file as the accountant
// receives it:
//
//   • EVERY FAMILY OF JOURNAL: the day book's sales, returns, cash, card/UPI/online money and loyalty vouchers; payables
//     (bills, debit notes, payments, supplier advances); credit-customer receivables; the stock and cost-of-goods
//     adjustments (count differences, write-offs, transfer losses, the month-end stock adjustment); fixed assets;
//     supplier income (rebates, display funding); openings; GST-only journals; and anything posted by hand. Each journal
//     is put in ONE family, worked out from what the journal itself says it is (its own tag, else its id) — nothing is
//     guessed from an account name.
//   • THE VOUCHER TYPE IS THE ACCOUNTANT'S. Which Tally voucher type each family imports as (Sales, Receipt, Payment,
//     Journal …) is the accountant's map; a family the map does not name imports as "Journal", which every Tally
//     company has. Nothing is invented.
//   • GST IS SHOWN ON ITS OWN. Which accounts are GST is read from the accountant's posting map (the legs whose amount
//     component is a tax: cgst, sgst, igst, cess or tax) — never from the account's name. The file's GST summary is the
//     day's debits and credits on those accounts, so the accountant can tie it to the returns.
//   • CONTROL TOTALS PER FAMILY travel with the file, beside the whole file's (vouchers, debits, credits).

import { buildTallyVouchers, type TallyExport, type TallyJournal, type TallyJournalLine } from './tally-xml';
import { validateTallyImport, type TallyImportCheck } from './tally-validator';

export type TallyFamily =
  | 'sales' | 'returns' | 'cash' | 'bank' | 'stored_value' | 'loyalty' | 'gst' | 'payables' | 'receivables'
  | 'stock' | 'fixed_assets' | 'supplier_income' | 'opening' | 'general';

/** Every family, in the order a file's summary lists them. */
export const TALLY_FAMILIES: readonly TallyFamily[] = Object.freeze([
  'sales', 'returns', 'cash', 'bank', 'stored_value', 'loyalty', 'gst', 'payables', 'receivables',
  'stock', 'fixed_assets', 'supplier_income', 'opening', 'general',
]);

/** What a family is, in English and Tamil — for the accountant's screen. */
export const TALLY_FAMILY_WORDS: Readonly<Record<TallyFamily, { readonly en: string; readonly ta: string }>> = Object.freeze({
  sales: { en: 'Sales', ta: 'விற்பனை' },
  returns: { en: 'Sales returns and refunds', ta: 'விற்பனை திருப்பம் மற்றும் பணத்திருப்பம்' },
  cash: { en: 'Cash', ta: 'ரொக்கம்' },
  bank: { en: 'Card, UPI and online money', ta: 'அட்டை, UPI மற்றும் இணையப் பணம்' },
  stored_value: { en: 'Store credit and exchange credit', ta: 'கடை வரவு மற்றும் மாற்று வரவு' },
  loyalty: { en: 'Loyalty points', ta: 'விசுவாசப் புள்ளிகள்' },
  gst: { en: 'GST', ta: 'ஜிஎஸ்டி' },
  payables: { en: 'Suppliers (bills, debit notes, payments, advances)', ta: 'சப்ளையர்கள் (பில்கள், பற்று குறிப்புகள், கொடுப்பனவுகள், முன்பணம்)' },
  receivables: { en: 'Credit customers', ta: 'கடன் வாடிக்கையாளர்கள்' },
  stock: { en: 'Stock and cost of goods', ta: 'சரக்கு மற்றும் விற்ற பொருளின் அடக்கவிலை' },
  fixed_assets: { en: 'Fixed assets', ta: 'நிலையான சொத்துக்கள்' },
  supplier_income: { en: 'Supplier rebates and display funding', ta: 'சப்ளையர் தள்ளுபடி மற்றும் காட்சி நிதி' },
  opening: { en: 'Opening balances', ta: 'தொடக்க இருப்புகள்' },
  general: { en: 'Other journals', ta: 'பிற பதிவுகள்' },
});

/** A journal as the ledger holds it — the shared shape, plus whichever tag its posting route put on it. */
export interface GlJournal {
  readonly entryId: string;
  readonly period: string;
  readonly documentDate: string;
  readonly narrative: string;
  readonly lines: readonly TallyJournalLine[];
  readonly dayBook?: { readonly kind: string };
  readonly payables?: { readonly kind: string };
  readonly b2b?: unknown;
  readonly stockAdjustment?: unknown;
  readonly stockPeriod?: unknown;
  readonly stockLoss?: unknown;
  readonly fixedAsset?: unknown;
  readonly rebateReceipt?: unknown;
  readonly rebateAccrual?: unknown;
  readonly displayFunding?: unknown;
  readonly referral?: unknown;
  readonly supplierAdvance?: unknown;
}

const TAX_COMPONENTS: ReadonlySet<string> = new Set(['cgst', 'sgst', 'igst', 'cess', 'tax', 'utgst']);

/** The GST accounts — every account a rule of the accountant's posting map posts a TAX component to. */
export function gstAccountsOf(map: { readonly rules: readonly { readonly legs: readonly { readonly account: string; readonly component: string }[] }[] } | undefined): readonly string[] {
  if (map === undefined) return [];
  return [...new Set(map.rules.flatMap((r) => r.legs).filter((l) => TAX_COMPONENTS.has(l.component)).map((l) => l.account))].sort();
}

/** Which family a day-book voucher is, by its kind (`sale`, `sale_return`, `tender:<kind>`, `refund:<kind>`, `loyalty:*`). */
function dayBookFamily(kind: string): TallyFamily {
  if (kind === 'sale') return 'sales';
  if (kind === 'sale_return') return 'returns';
  if (kind.startsWith('loyalty:')) return 'loyalty';
  const tender = kind.startsWith('tender:') ? kind.slice(7) : kind.startsWith('refund:') ? kind.slice(7) : undefined;
  if (tender === undefined) return 'general';
  if (kind.startsWith('refund:') && tender !== 'cash') return 'returns';
  if (tender === 'cash') return kind.startsWith('refund:') ? 'returns' : 'cash';
  if (tender === 'store_credit' || tender === 'exchange_credit') return 'stored_value';
  if (tender === 'loyalty_points') return 'loyalty';
  return 'bank';
}

/**
 * The ONE family a journal belongs to — from its own tag first (the posting route that wrote it), else its id's prefix,
 * else a journal whose every line is a GST account is `gst`; anything else is `general` (posted by hand).
 */
export function familyOf(j: GlJournal, gstAccounts: readonly string[] = []): TallyFamily {
  if (j.dayBook !== undefined) return dayBookFamily(j.dayBook.kind);
  if (j.payables !== undefined || j.supplierAdvance !== undefined) return 'payables';
  if (j.b2b !== undefined) return 'receivables';
  if (j.stockAdjustment !== undefined || j.stockPeriod !== undefined || j.stockLoss !== undefined) return 'stock';
  if (j.fixedAsset !== undefined) return 'fixed_assets';
  if (j.rebateReceipt !== undefined || j.rebateAccrual !== undefined || j.displayFunding !== undefined) return 'supplier_income';
  if (j.referral !== undefined) return 'loyalty';
  const id = j.entryId;
  if (id.startsWith('daybook:')) return dayBookFamily(id.split(':').slice(2, -1).join(':'));
  if (id.startsWith('payables:') || id.startsWith('supplier-advance')) return 'payables';
  if (id.startsWith('b2b:')) return 'receivables';
  if (id.startsWith('stock-adjustment:') || id.startsWith('stock-period:') || id.startsWith('stock-loss:')) return 'stock';
  if (id.startsWith('fixed-asset')) return 'fixed_assets';
  if (id.startsWith('supplier-rebate') || id.startsWith('display-funding:')) return 'supplier_income';
  if (id.startsWith('referral:')) return 'loyalty';
  if (id.startsWith('opening') || id.startsWith('migration-')) return 'opening';
  if (gstAccounts.length > 0 && j.lines.length > 0 && j.lines.every((l) => gstAccounts.includes(l.accountCode))) return 'gst';
  return 'general';
}

export interface FamilyTotals {
  readonly family: TallyFamily;
  readonly vouchers: number;
  readonly debitMinor: number;
  readonly creditMinor: number;
}

export interface GstLedgerTotal {
  readonly accountCode: string;
  readonly debitMinor: number;
  readonly creditMinor: number;
}

export interface DailyTallyFile {
  readonly day: string;
  readonly fileName: string;
  readonly export: TallyExport;
  readonly check: TallyImportCheck;
  /** Per family: how many of its vouchers are IN the file, and their debits and credits. */
  readonly byFamily: readonly FamilyTotals[];
  /** The day's GST: debits and credits on each GST account, across the vouchers in the file. */
  readonly gst: readonly GstLedgerTotal[];
  /** True only when every journal asked for is in the file AND the stand-in import check accepts it. */
  readonly importable: boolean;
}

/**
 * Build one day's file: every journal given (the caller passes one day's), one voucher each, its type from the
 * accountant's map per family, read straight back through the stand-in import check. A journal that cannot be written
 * stays OUT and is an exception by name, and the file says it is not importable — a part of a day never passes as a day.
 */
export function buildDailyTallyFile(input: {
  readonly day: string;
  /** Which file of the day this is: 1 for the day's first; 2, 3 … for journals that arrived after it was sent. */
  readonly sequence: number;
  readonly companyName: string;
  readonly ledgerNames: Readonly<Record<string, string>>;
  /** Family → Tally voucher type; a family not named imports as "Journal". */
  readonly voucherTypes?: Readonly<Partial<Record<TallyFamily, string>>>;
  readonly journals: readonly GlJournal[];
  readonly gstAccounts?: readonly string[];
}): DailyTallyFile {
  const gstAccounts = input.gstAccounts ?? [];
  const familyById = new Map<string, TallyFamily>();
  const journals: TallyJournal[] = input.journals.map((j) => {
    const family = familyOf(j, gstAccounts);
    familyById.set(j.entryId, family);
    const voucherType = (input.voucherTypes?.[family] ?? '').trim();
    return {
      entryId: j.entryId, documentDate: j.documentDate, narrative: j.narrative, lines: j.lines,
      voucherType: voucherType === '' ? 'Journal' : voucherType,
    };
  });
  const out = buildTallyVouchers({ companyName: input.companyName, ledgerNames: input.ledgerNames, journals });
  const check = validateTallyImport(out.xml, out.controlTotals);
  const inFile = new Set(out.vouchers.map((v) => v.entryId));
  const byFamily: FamilyTotals[] = [];
  for (const family of TALLY_FAMILIES) {
    const mine = out.vouchers.filter((v) => familyById.get(v.entryId) === family);
    if (mine.length === 0) continue;
    byFamily.push({ family, vouchers: mine.length, debitMinor: mine.reduce((s, v) => s + v.debitMinor, 0), creditMinor: mine.reduce((s, v) => s + v.creditMinor, 0) });
  }
  const gst = new Map<string, { debitMinor: number; creditMinor: number }>();
  for (const j of input.journals) {
    if (!inFile.has(j.entryId)) continue;
    for (const l of j.lines) {
      if (!gstAccounts.includes(l.accountCode)) continue;
      const cur = gst.get(l.accountCode) ?? { debitMinor: 0, creditMinor: 0 };
      gst.set(l.accountCode, { debitMinor: cur.debitMinor + l.debitMinor, creditMinor: cur.creditMinor + l.creditMinor });
    }
  }
  return {
    day: input.day,
    fileName: `sre-tally-${input.day}-${String(input.sequence).padStart(2, '0')}.xml`,
    export: out, check,
    byFamily,
    gst: [...gst.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([accountCode, t]) => ({ accountCode, ...t })),
    importable: out.complete && check.ok && out.vouchers.length > 0,
  };
}
