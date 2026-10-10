// A bank statement, imported as INDEPENDENT evidence (Wave 5 · PF-12 · M23-FR-02/03/04 · QG-07 · P-08). Pure.
//
// A month is signed off on two figures reached two different ways. The second way has to come from OUTSIDE this system:
// the provider's settlement file (`packages/settlement`) and the bank's own statement. This reads a statement — as the
// bank's export arrives (a CSV) or already structured — and refuses one that does not add up to its own declared opening
// and closing balances, exactly as a settlement file is refused when its lines do not sum to its declared totals: a file
// that does not reconcile to itself will not become right once it is inside the books.
//
// The statement names the account by a REFERENCE the shop chooses (e.g. "HDFC-current-1"), never the account number,
// and no line carries anything but a date, an amount, the bank's reference and narrative. No live bank connection exists
// — importing the file a person downloaded is the adapter; a bank feed is an external gate (PF-12).

export interface BankStatementLine {
  readonly lineId: string;
  /** YYYY-MM-DD, the value date. */
  readonly date: string;
  /** Signed paise: a credit into the account is positive, a debit negative. */
  readonly amountMinor: number;
  /** The bank's reference for the line (UTR / cheque / payer reference) — what a payout is matched on. */
  readonly reference: string;
  readonly narrative?: string;
}

export interface BankStatement {
  readonly statementId: string;
  /** The shop's own name for the account — never the account number. */
  readonly accountRef: string;
  readonly fromDate: string;
  readonly toDate: string;
  readonly openingMinor: number;
  readonly closingMinor: number;
  readonly lines: readonly BankStatementLine[];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar date — 31 Feb is not one (a bare `Date.parse` would quietly roll it into March). */
const isDate = (s: unknown): s is string => typeof s === 'string' && DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00.000Z`))
  && new Date(`${s}T00:00:00.000Z`).toISOString().slice(0, 10) === s;
const isStr = (s: unknown): s is string => typeof s === 'string' && s.trim() !== '';
/** An account number looks like 9–18 digits; the reference must not be one (hard rule #3's spirit — no account data). */
const looksLikeAnAccountNumber = (s: string): boolean => /^\d{9,18}$/.test(s.replace(/[\s-]/g, ''));

/** "1,234.50" / "1234.5" / "" → paise; undefined when it is not an amount. */
function paise(raw: string): number | undefined {
  const t = raw.replace(/[,\s₹]/g, '');
  if (t === '') return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return undefined;
  const [whole, frac = ''] = t.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

/** "DD/MM/YYYY" or "YYYY-MM-DD" → YYYY-MM-DD. */
function isoDate(raw: string): string | undefined {
  const t = raw.trim();
  if (isDate(t)) return t;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(t);
  if (m === null) return undefined;
  const iso = `${m[3]}-${m[2]}-${m[1]}`;
  return isDate(iso) ? iso : undefined;
}

/** Split one CSV row, honouring double quotes. */
function cells(row: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < row.length; i += 1) {
    const c = row[i]!;
    if (quoted) {
      if (c === '"' && row[i + 1] === '"') { cur += '"'; i += 1; } else if (c === '"') quoted = false; else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

export type StatementReading =
  | { readonly ok: true; readonly statement: BankStatement }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * Read a bank's CSV export: a header row naming `date`, `reference`, `narrative`, `debit`, `credit` (any order, any case),
 * then one row per line. The statement's own figures (id, account reference, period, opening and closing) are given
 * beside it, as the bank prints them at the top and bottom of the statement.
 */
export function parseBankStatementCsv(csv: string, meta: Omit<BankStatement, 'lines'>): StatementReading {
  const rows = csv.split(/\r?\n/).filter((r) => r.trim() !== '');
  if (rows.length === 0) return { ok: false, problems: ['the file is empty'] };
  const header = cells(rows[0]!).map((h) => h.toLowerCase());
  const col = (name: string): number => header.indexOf(name);
  const missing = ['date', 'reference', 'debit', 'credit'].filter((n) => col(n) < 0);
  if (missing.length > 0) return { ok: false, problems: [`the header row has no ${missing.join(', ')} column`] };
  const problems: string[] = [];
  const lines: BankStatementLine[] = [];
  rows.slice(1).forEach((row, i) => {
    const c = cells(row);
    const date = isoDate(c[col('date')] ?? '');
    const debit = paise(c[col('debit')] ?? '');
    const credit = paise(c[col('credit')] ?? '');
    const reference = c[col('reference')] ?? '';
    if (date === undefined) problems.push(`row ${i + 2}: '${c[col('date')] ?? ''}' is not a date`);
    if (debit === undefined || credit === undefined) problems.push(`row ${i + 2}: the debit or credit is not an amount`);
    if (debit !== undefined && credit !== undefined && debit > 0 && credit > 0) problems.push(`row ${i + 2}: a line is a debit or a credit, not both`);
    if (date !== undefined && debit !== undefined && credit !== undefined) {
      const narrative = col('narrative') >= 0 ? c[col('narrative')] ?? '' : '';
      lines.push({ lineId: `${meta.statementId}:${i + 1}`, date, amountMinor: credit - debit, reference, ...(narrative === '' ? {} : { narrative }) });
    }
  });
  if (problems.length > 0) return { ok: false, problems };
  return checkBankStatement({ ...meta, lines });
}

/** Check a structured statement: shape, no account number, every line in its period, and opening + lines = closing. */
export function checkBankStatement(raw: unknown): StatementReading {
  const s = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const problems: string[] = [];
  if (!isStr(s['statementId'])) problems.push('a statement needs a statementId');
  if (!isStr(s['accountRef'])) problems.push('a statement needs the shop\'s reference for the account (accountRef)');
  else if (looksLikeAnAccountNumber(s['accountRef'])) problems.push('accountRef looks like an account number — name the account by a reference instead; account numbers are not kept');
  if (!isDate(s['fromDate']) || !isDate(s['toDate']) || (s['fromDate'] as string) > (s['toDate'] as string)) problems.push('a statement needs a fromDate on or before its toDate (YYYY-MM-DD)');
  if (!Number.isSafeInteger(s['openingMinor']) || !Number.isSafeInteger(s['closingMinor'])) problems.push('opening and closing balances must be whole paise');
  if (!Array.isArray(s['lines'])) problems.push('a statement needs its lines');
  if (problems.length > 0) return { ok: false, problems };
  const lines: BankStatementLine[] = [];
  const ids = new Set<string>();
  (s['lines'] as unknown[]).forEach((l, i) => {
    const line = (l !== null && typeof l === 'object' ? l : {}) as Record<string, unknown>;
    if (!isStr(line['lineId']) || !isDate(line['date']) || !Number.isSafeInteger(line['amountMinor']) || typeof line['reference'] !== 'string') {
      problems.push(`line ${i + 1} needs a lineId, a date, whole-paise amountMinor and a reference`);
      return;
    }
    if (ids.has(line['lineId'])) problems.push(`line ${line['lineId']} appears twice`);
    ids.add(line['lineId']);
    if ((line['date'] as string) < (s['fromDate'] as string) || (line['date'] as string) > (s['toDate'] as string)) problems.push(`line ${line['lineId']} is dated outside the statement's period`);
    lines.push({ lineId: line['lineId'], date: line['date'], amountMinor: line['amountMinor'] as number, reference: line['reference'], ...(isStr(line['narrative']) ? { narrative: line['narrative'] } : {}) });
  });
  if (problems.length > 0) return { ok: false, problems };
  const moved = lines.reduce((n, l) => n + l.amountMinor, 0);
  if ((s['openingMinor'] as number) + moved !== (s['closingMinor'] as number)) {
    return { ok: false, problems: [`the statement does not add up: opening ${s['openingMinor'] as number} + lines ${moved} = ${(s['openingMinor'] as number) + moved}, but it declares a closing balance of ${s['closingMinor'] as number}`] };
  }
  return {
    ok: true,
    statement: {
      statementId: s['statementId'] as string, accountRef: s['accountRef'] as string, fromDate: s['fromDate'] as string, toDate: s['toDate'] as string,
      openingMinor: s['openingMinor'] as number, closingMinor: s['closingMinor'] as number, lines,
    },
  };
}
