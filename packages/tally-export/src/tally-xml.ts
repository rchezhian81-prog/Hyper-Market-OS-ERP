// A Tally-importable voucher file from the shop's own journals (WF-05 "→ AP/Tally" · M23-FR-04 · AVR-09).
//
// Tally is a DESTINATION, not the book of record (packages/period-close): the shop's append-only ledger is the truth and
// this file is a copy the accountant imports into the Tally company they already keep. So the export is built to be
// boringly safe:
//
//   • ONE JOURNAL IS ONE VOUCHER, keyed by the journal's own id (`REMOTEID="sre:<entryId>"`). Importing the same file twice
//     names the same vouchers again — Tally treats a known REMOTEID as the same voucher, so a re-import never doubles the
//     month. Our entry ids are append-only, so the key never moves.
//   • THE LEDGER NAMES ARE THE ACCOUNTANT'S. Our journals speak account codes; Tally speaks ledger names. Which Tally ledger an
//     account code is, is the accountant's map — never guessed. A journal that touches a code the map does not name is NOT
//     written to the file: it is listed as an exception by name (P-08), so a half-mapped month cannot import as if complete.
//   • A VOUCHER THAT DOES NOT BALANCE IS NEVER WRITTEN. Tally would refuse it; worse, a part-written month would look whole.
//     Amounts are whole paise rendered as rupees with exactly two decimals — no float ever touches a figure.
//   • TALLY'S SIGN CONVENTION, EXACTLY: a debit is `ISDEEMEDPOSITIVE` Yes with a negative AMOUNT; a credit is No with a
//     positive AMOUNT; each voucher's amounts sum to zero.
//   • CONTROL TOTALS travel with the file (vouchers, debits, credits), so the accountant can tie Tally's day book back to it.
//
// Built generally: the input is any balanced journal (payables vouchers today; the GL day book, rebate receipts or anything
// else later), so every lane that needs Tally reuses this one writer. Pure and deterministic — no clock, no I/O.

export interface TallyJournalLine {
  /** Our account code, as the accountant's posting map names it. */
  readonly accountCode: string;
  /** Whole paise, ≥ 0. */
  readonly debitMinor: number;
  /** Whole paise, ≥ 0. */
  readonly creditMinor: number;
}

export interface TallyJournal {
  /** Our journal's own id — becomes the voucher's REMOTEID, so a re-import is the same voucher. */
  readonly entryId: string;
  /** YYYY-MM-DD — the document date the voucher carries in Tally. */
  readonly documentDate: string;
  readonly narrative: string;
  readonly lines: readonly TallyJournalLine[];
  /** Tally voucher type (default `Journal`). */
  readonly voucherType?: string;
  /** The voucher number shown in Tally (default: the entry id). */
  readonly voucherNumber?: string;
}

export type TallyExceptionReason =
  | 'ledger_not_mapped' | 'does_not_balance' | 'bad_date' | 'no_lines' | 'bad_amount' | 'duplicate_entry' | 'no_narrative';

export interface TallyExportException {
  readonly entryId: string;
  readonly reason: TallyExceptionReason;
  readonly detail: string;
  /** For `ledger_not_mapped`: the account codes the map does not name. */
  readonly accountCodes?: readonly string[];
}

export interface TallyVoucherSummary {
  readonly entryId: string;
  readonly remoteId: string;
  readonly date: string;
  readonly voucherType: string;
  readonly voucherNumber: string;
  readonly debitMinor: number;
  readonly creditMinor: number;
  readonly ledgerEntries: number;
}

export interface TallyControlTotals {
  readonly voucherCount: number;
  readonly debitMinor: number;
  readonly creditMinor: number;
}

export interface TallyExport {
  readonly xml: string;
  readonly vouchers: readonly TallyVoucherSummary[];
  readonly exceptions: readonly TallyExportException[];
  readonly controlTotals: TallyControlTotals;
  /** True only when every journal asked for is in the file — an export with exceptions is said to be incomplete. */
  readonly complete: boolean;
}

export interface TallyExportInput {
  /** The Tally company the accountant imports into (`SVCURRENTCOMPANY`). */
  readonly companyName: string;
  readonly journals: readonly TallyJournal[];
  /** Account code → the Tally ledger name the accountant keeps it under. */
  readonly ledgerNames: Readonly<Record<string, string>>;
  readonly defaultVoucherType?: string;
}

/** The REMOTEID a journal is written under — stable for ever, because entry ids are append-only. */
export const remoteIdOf = (entryId: string): string => `sre:${entryId}`;

const isWholeNonNeg = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

/** Paise as rupees with exactly two decimals, sign first — integer arithmetic only. */
export function rupees(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** "1234.56" / "-1234.56" back to whole paise; undefined for anything else. */
export function paiseOf(text: string): number | undefined {
  const m = /^(-?)(\d+)\.(\d{2})$/.exec(text);
  if (m === null) return undefined;
  const v = Number(m[2]) * 100 + Number(m[3]);
  return m[1] === '-' ? -v : v;
}

/** XML text and attribute escaping — the five predefined entities. */
export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

const isCalendarDate = (d: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = Date.parse(`${d}T00:00:00.000Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d;
};

/** One journal line as a Tally ledger entry: net of the line, Tally's sign. Zero lines are dropped. */
function ledgerEntryOf(name: string, line: TallyJournalLine): { name: string; amount: number } | undefined {
  const net = line.creditMinor - line.debitMinor; // Tally: credit positive, debit negative
  return net === 0 ? undefined : { name, amount: net };
}

/**
 * Build the Tally import file. Every journal is judged first; only a journal that is fully mapped, balanced, dated and
 * narrated is written. Everything else is an exception by name — the file never carries a part of a month silently.
 */
export function buildTallyVouchers(input: TallyExportInput): TallyExport {
  const exceptions: TallyExportException[] = [];
  const vouchers: TallyVoucherSummary[] = [];
  const bodies: string[] = [];
  const seen = new Set<string>();
  let debit = 0;
  let credit = 0;
  const sorted = [...input.journals].sort((a, b) => (a.documentDate < b.documentDate ? -1 : a.documentDate > b.documentDate ? 1 : a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0));
  for (const j of sorted) {
    if (seen.has(j.entryId)) {
      exceptions.push({ entryId: j.entryId, reason: 'duplicate_entry', detail: `journal ${j.entryId} was given twice — one journal is one voucher` });
      continue;
    }
    seen.add(j.entryId);
    if (!isCalendarDate(j.documentDate)) {
      exceptions.push({ entryId: j.entryId, reason: 'bad_date', detail: `"${j.documentDate}" is not a calendar date (YYYY-MM-DD)` });
      continue;
    }
    if (j.narrative.trim() === '') {
      exceptions.push({ entryId: j.entryId, reason: 'no_narrative', detail: 'a voucher with no narration cannot be traced back to the shop\'s record' });
      continue;
    }
    if (j.lines.length < 2) {
      exceptions.push({ entryId: j.entryId, reason: 'no_lines', detail: 'a voucher needs at least one debit and one credit' });
      continue;
    }
    if (!j.lines.every((l) => isWholeNonNeg(l.debitMinor) && isWholeNonNeg(l.creditMinor))) {
      exceptions.push({ entryId: j.entryId, reason: 'bad_amount', detail: 'every amount is whole paise and not negative' });
      continue;
    }
    const dr = j.lines.reduce((s, l) => s + l.debitMinor, 0);
    const cr = j.lines.reduce((s, l) => s + l.creditMinor, 0);
    if (dr !== cr || dr === 0) {
      exceptions.push({ entryId: j.entryId, reason: 'does_not_balance', detail: `debits ${rupees(dr)} and credits ${rupees(cr)} do not balance` });
      continue;
    }
    const unmapped = [...new Set(j.lines.map((l) => l.accountCode).filter((c) => (input.ledgerNames[c] ?? '').trim() === ''))].sort();
    if (unmapped.length > 0) {
      exceptions.push({
        entryId: j.entryId, reason: 'ledger_not_mapped', accountCodes: unmapped,
        detail: `account ${unmapped.join(', ')} has no Tally ledger name in the accountant's map, so this voucher is not in the file`,
      });
      continue;
    }
    const entries = j.lines.map((l) => ledgerEntryOf(input.ledgerNames[l.accountCode]!.trim(), l)).filter((e): e is { name: string; amount: number } => e !== undefined);
    const voucherType = (j.voucherType ?? input.defaultVoucherType ?? 'Journal').trim() || 'Journal';
    const voucherNumber = (j.voucherNumber ?? j.entryId).trim() || j.entryId;
    const remoteId = remoteIdOf(j.entryId);
    const date = j.documentDate.replace(/-/g, '');
    bodies.push([
      `<TALLYMESSAGE xmlns:UDF="TallyUDF">`,
      `<VOUCHER REMOTEID="${escapeXml(remoteId)}" VCHTYPE="${escapeXml(voucherType)}" ACTION="Create">`,
      `<DATE>${date}</DATE>`,
      `<VOUCHERTYPENAME>${escapeXml(voucherType)}</VOUCHERTYPENAME>`,
      `<VOUCHERNUMBER>${escapeXml(voucherNumber)}</VOUCHERNUMBER>`,
      `<NARRATION>${escapeXml(j.narrative.trim())}</NARRATION>`,
      ...entries.map((e) => [
        '<ALLLEDGERENTRIES.LIST>',
        `<LEDGERNAME>${escapeXml(e.name)}</LEDGERNAME>`,
        `<ISDEEMEDPOSITIVE>${e.amount < 0 ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>`,
        `<AMOUNT>${rupees(e.amount)}</AMOUNT>`,
        '</ALLLEDGERENTRIES.LIST>',
      ].join('')),
      '</VOUCHER>',
      '</TALLYMESSAGE>',
    ].join(''));
    vouchers.push({ entryId: j.entryId, remoteId, date: j.documentDate, voucherType, voucherNumber, debitMinor: dr, creditMinor: cr, ledgerEntries: entries.length });
    debit += dr;
    credit += cr;
  }
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ENVELOPE>',
    '<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>',
    '<BODY><IMPORTDATA>',
    `<REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${escapeXml(input.companyName.trim())}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC>`,
    '<REQUESTDATA>',
    ...bodies,
    '</REQUESTDATA>',
    '</IMPORTDATA></BODY>',
    '</ENVELOPE>',
    '',
  ].join('\n');
  return {
    xml, vouchers, exceptions,
    controlTotals: { voucherCount: vouchers.length, debitMinor: debit, creditMinor: credit },
    complete: exceptions.length === 0,
  };
}
