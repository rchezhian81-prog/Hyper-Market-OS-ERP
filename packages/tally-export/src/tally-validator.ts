// A STAND-IN for Tally's own import check (WF-05 · M23-FR-04). The real proof is the accountant importing the file into
// their Tally company (an outside party, AVR-09); until then this reads the file back WITHOUT the writer's help — its own
// small XML reader, its own amount parser — and refuses anything Tally would refuse or a person would misread:
//
//   • the envelope is an `Import Data` request for `Vouchers` into a named company;
//   • every VOUCHER has a unique REMOTEID, a voucher type that matches its VOUCHERTYPENAME, `ACTION="Create"`, a real
//     calendar DATE (YYYYMMDD), a narration and at least two ledger entries;
//   • every ledger entry names a ledger, carries an AMOUNT with exactly two decimals, and its ISDEEMEDPOSITIVE agrees with
//     the sign (Yes ⇔ debit ⇔ negative);
//   • each voucher's amounts sum to exactly zero paise;
//   • the totals read back equal the control totals the export claimed.
//
// It never "fixes" a file. A problem is a sentence naming the voucher, so the person exporting sees exactly what Tally would
// have refused. Pure and deterministic.

export interface ParsedLedgerEntry {
  readonly ledgerName: string;
  readonly deemedPositive: boolean;
  /** Tally's sign: negative = debit. Whole paise. */
  readonly amountMinor: number;
}

export interface ParsedVoucher {
  readonly remoteId: string;
  readonly voucherType: string;
  readonly date: string;
  readonly voucherNumber: string;
  readonly narration: string;
  readonly entries: readonly ParsedLedgerEntry[];
}

export interface TallyImportCheck {
  readonly ok: boolean;
  readonly company: string | undefined;
  readonly vouchers: readonly ParsedVoucher[];
  readonly problems: readonly string[];
  readonly totals: { readonly voucherCount: number; readonly debitMinor: number; readonly creditMinor: number };
}

interface XmlNode { readonly name: string; readonly attrs: Readonly<Record<string, string>>; readonly children: XmlNode[]; text: string }

const ENTITY: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Decode the five predefined entities; anything else (a raw `&`) is a problem the caller reports. */
function decode(s: string, problems: string[], where: string): string {
  return s.replace(/&([a-z]+);|&/g, (whole, name: string | undefined) => {
    if (name !== undefined && ENTITY[name] !== undefined) return ENTITY[name]!;
    problems.push(`${where}: an unescaped "&" (Tally refuses the file)`);
    return whole;
  });
}

/** A deliberately small XML reader for the subset a Tally import uses: elements, attributes, text; no DTDs, no CDATA. */
function parseXml(xml: string, problems: string[]): XmlNode | undefined {
  const body = xml.replace(/^\uFEFF?\s*<\?xml[^?]*\?>/, '');
  const root: XmlNode = { name: '#root', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  const tag = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+="[^"<]*")*)\s*(\/?)>|([^<]+)|(<)/g;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(body)) !== null) {
    const top = stack[stack.length - 1]!;
    if (m[6] !== undefined) { problems.push('the file has a "<" that is not a tag'); return undefined; }
    if (m[5] !== undefined) {
      if (m[5].includes('>')) problems.push(`${top.name}: an unescaped ">" in text`);
      top.text += decode(m[5], problems, top.name);
      continue;
    }
    const [, closing, name, rawAttrs, selfClosing] = m;
    if (closing === '/') {
      if (top.name !== name) { problems.push(`</${name}> closes <${top.name}> — the file is not well formed`); return undefined; }
      stack.pop();
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of (rawAttrs ?? '').matchAll(/([\w.:-]+)="([^"]*)"/g)) attrs[a[1]!] = decode(a[2]!, problems, `${name}@${a[1]}`);
    const node: XmlNode = { name: name!, attrs, children: [], text: '' };
    top.children.push(node);
    if (selfClosing !== '/') stack.push(node);
  }
  if (stack.length !== 1) { problems.push(`<${stack[stack.length - 1]!.name}> is never closed — the file is not well formed`); return undefined; }
  return root;
}

const child = (n: XmlNode | undefined, name: string): XmlNode | undefined => n?.children.find((c) => c.name === name);
const children = (n: XmlNode | undefined, name: string): readonly XmlNode[] => n?.children.filter((c) => c.name === name) ?? [];
const textOf = (n: XmlNode | undefined, name: string): string | undefined => child(n, name)?.text.trim();

/** Two-decimal rupees to whole paise, read independently of the writer. */
function readAmount(s: string): number | undefined {
  const m = /^(-?)(\d+)\.(\d{2})$/.exec(s);
  if (m === null) return undefined;
  const v = Number(m[2]) * 100 + Number(m[3]);
  return m[1] === '-' ? -v : v;
}

const isYmd = (d: string): boolean => {
  if (!/^\d{8}$/.test(d)) return false;
  const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  const t = Date.parse(`${iso}T00:00:00.000Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === iso;
};

/**
 * Read a Tally import file back and check it the way Tally's import would. `expected` (the export's control totals), when
 * given, must equal what is read back.
 */
export function validateTallyImport(xml: string, expected?: { readonly voucherCount: number; readonly debitMinor: number; readonly creditMinor: number }): TallyImportCheck {
  const problems: string[] = [];
  const root = parseXml(xml, problems);
  const empty = { ok: false, company: undefined, vouchers: [], problems, totals: { voucherCount: 0, debitMinor: 0, creditMinor: 0 } } as const;
  if (root === undefined) return empty;
  const envelope = child(root, 'ENVELOPE');
  if (envelope === undefined) { problems.push('there is no <ENVELOPE>'); return empty; }
  if (textOf(child(envelope, 'HEADER'), 'TALLYREQUEST') !== 'Import Data') problems.push('the header is not an "Import Data" request');
  const importData = child(child(envelope, 'BODY'), 'IMPORTDATA');
  const desc = child(importData, 'REQUESTDESC');
  if (textOf(desc, 'REPORTNAME') !== 'Vouchers') problems.push('the request is not for "Vouchers"');
  const company = textOf(child(desc, 'STATICVARIABLES'), 'SVCURRENTCOMPANY');
  if (company === undefined || company === '') problems.push('no Tally company is named (SVCURRENTCOMPANY)');
  const data = child(importData, 'REQUESTDATA');
  if (data === undefined) problems.push('there is no <REQUESTDATA>');
  const vouchers: ParsedVoucher[] = [];
  const ids = new Set<string>();
  let debit = 0;
  let credit = 0;
  for (const message of children(data, 'TALLYMESSAGE')) {
    for (const v of children(message, 'VOUCHER')) {
      const remoteId = v.attrs['REMOTEID'] ?? '';
      const where = `voucher ${remoteId === '' ? '(no REMOTEID)' : remoteId}`;
      if (remoteId === '') problems.push(`${where}: no REMOTEID — a re-import would make a second voucher`);
      else if (ids.has(remoteId)) problems.push(`${where}: the REMOTEID appears twice`);
      ids.add(remoteId);
      const vchType = v.attrs['VCHTYPE'] ?? '';
      const typeName = textOf(v, 'VOUCHERTYPENAME') ?? '';
      if (vchType === '' || vchType !== typeName) problems.push(`${where}: VCHTYPE "${vchType}" and VOUCHERTYPENAME "${typeName}" differ`);
      if (v.attrs['ACTION'] !== 'Create') problems.push(`${where}: ACTION is not "Create"`);
      const date = textOf(v, 'DATE') ?? '';
      if (!isYmd(date)) problems.push(`${where}: DATE "${date}" is not a calendar date (YYYYMMDD)`);
      const narration = textOf(v, 'NARRATION') ?? '';
      if (narration === '') problems.push(`${where}: no NARRATION`);
      const entries: ParsedLedgerEntry[] = [];
      for (const e of children(v, 'ALLLEDGERENTRIES.LIST')) {
        const name = textOf(e, 'LEDGERNAME') ?? '';
        const deemed = textOf(e, 'ISDEEMEDPOSITIVE');
        const amount = readAmount(textOf(e, 'AMOUNT') ?? '');
        if (name === '') problems.push(`${where}: a ledger entry names no ledger`);
        if (amount === undefined) { problems.push(`${where}: an AMOUNT is not rupees with two decimals`); continue; }
        if (amount === 0) problems.push(`${where}: a ledger entry of zero`);
        if (deemed !== 'Yes' && deemed !== 'No') problems.push(`${where}: ISDEEMEDPOSITIVE is neither Yes nor No`);
        else if ((deemed === 'Yes') !== (amount < 0)) problems.push(`${where}: ledger "${name}" — ISDEEMEDPOSITIVE ${deemed} disagrees with the sign of ${textOf(e, 'AMOUNT')}`);
        entries.push({ ledgerName: name, deemedPositive: deemed === 'Yes', amountMinor: amount });
      }
      if (entries.length < 2) problems.push(`${where}: fewer than two ledger entries`);
      const sum = entries.reduce((s, e) => s + e.amountMinor, 0);
      if (sum !== 0) problems.push(`${where}: the ledger entries do not balance (they differ by ${sum} paise)`);
      debit += entries.filter((e) => e.amountMinor < 0).reduce((s, e) => s - e.amountMinor, 0);
      credit += entries.filter((e) => e.amountMinor > 0).reduce((s, e) => s + e.amountMinor, 0);
      vouchers.push({ remoteId, voucherType: vchType, date, voucherNumber: textOf(v, 'VOUCHERNUMBER') ?? '', narration, entries });
    }
  }
  const totals = { voucherCount: vouchers.length, debitMinor: debit, creditMinor: credit };
  if (expected !== undefined && (expected.voucherCount !== totals.voucherCount || expected.debitMinor !== totals.debitMinor || expected.creditMinor !== totals.creditMinor)) {
    problems.push(`the file holds ${totals.voucherCount} vouchers, debits ${totals.debitMinor} and credits ${totals.creditMinor} paise, but the export claimed ${expected.voucherCount}, ${expected.debitMinor} and ${expected.creditMinor}`);
  }
  return { ok: problems.length === 0, company, vouchers, problems, totals };
}
