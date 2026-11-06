// W5 · MG-10 · MG-11 · OD-05 · GT-02 (roadmap §30 / §34 migration controls) — the switch-over EVIDENCE sections of the "Old
// system checks" office page, as a tested, DOM-free session. Until now these head-office routes had no caller on any screen
// (the runbook told the owner to make hand-made API calls with the load's token):
//
//   MG-11  the signed verification page: who ran the extraction, the six outside witnesses (the blind count, the
//          suppliers' statements, the bank, the filed GST returns, the CA's signed accounts, the customers' own answers),
//          where the twelve kinds of record stand, the page itself and the owner's / CA's signature over it;
//   OD-05  the owner accepts, in writing and in his own name, a kind of record carried on the old system's word alone;
//   MG-11  the owner's four rollback limits — his numbers, "not set" until he sets each one, never a default;
//   MG-10  the books side of a parallel day (the old ERP's day reports), putting a name on each difference, the printable
//          daily sheet;
//   GT-02  confirming a decided rollback with the old system's first bill, and reconciling its window.
//
// The page is a THIN CLIENT. Every rule is head office's (services/migration/src): the session reads the transcribed
// evidence files into the shape head office reads, refuses only what it can see is incomplete before asking, and NEVER sends
// the person's name (head office takes the signed-in person). Nothing is read or written on open or on a timer. The old
// system's data is never deleted by anything here. Synthetic data only in tests; the routes refuse a production target (#7).

import type { ViewerIdentity } from './browser-entry';
import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';
import { paiseOf, rupees, type Lang } from './old-system-session';

// ── what head office answers (the parts the page shows) ─────────────────────────────────────────────────────

export const DATA_DOMAINS = Object.freeze(['products', 'barcodes', 'prices', 'stock', 'batches', 'suppliers', 'purchases', 'customers', 'loyalty', 'sales', 'tax', 'ledgers'] as const);
export const WITNESSES = Object.freeze(['count', 'suppliers', 'bank', 'tax', 'books', 'loyalty'] as const);
export type Witness = (typeof WITNESSES)[number];
export const WRONG_SIDES = Object.freeze(['legacy', 'new', 'both', 'neither'] as const);
export const DATE_ORDERS = Object.freeze(['dmy', 'mdy', 'ymd'] as const);
export const SAMPLE_SOURCES = Object.freeze(['drawn_before_anybody_was_told', 'drawn_from_complaints'] as const);

export interface FindingRead {
  readonly domain: string; readonly verdict: string; readonly figureMinor?: number; readonly figureLabel?: string;
  readonly provedBy?: readonly string[]; readonly whatItCannotProve: string; readonly ownerAction: string;
  readonly recordedBy?: string; readonly recordedAt?: string; readonly evidenceRef?: string;
}
export interface ProgressRead {
  readonly covered: readonly string[]; readonly missing: readonly string[]; readonly findings: readonly FindingRead[];
  readonly ownerKnown: boolean; readonly extractionOperatorKnown: boolean; readonly signaturesOverThisPage: number; readonly detail: string;
}
export interface PageRead { readonly markdown: string; readonly signatures: number }
export interface WitnessResult { readonly findings: readonly FindingRead[] }
export interface LimitsRead {
  readonly limits: { readonly controlTotalDifferenceMinor: number | null; readonly edgeOutageMinutes: number | null; readonly windowMinutes: number | null; readonly backupMaxAgeHours: number | null; readonly version: number; readonly setBy: string; readonly setAt: string } | null;
  readonly notSet: readonly string[];
  readonly backup: { readonly state: 'passed' | 'failed' | 'not_known'; readonly evidence: string };
}
export const LIMIT_NAMES = Object.freeze(['controlTotalDifferenceMinor', 'edgeOutageMinutes', 'windowMinutes', 'backupMaxAgeHours'] as const);
export type LimitName = (typeof LIMIT_NAMES)[number];

export interface DifferenceRead {
  readonly differenceId: string; readonly businessDate: string; readonly area: string; readonly subject?: string; readonly difference: number;
  readonly status: string; readonly ownerUserId?: string; readonly explanation?: string; readonly wrongSide?: string;
}
export interface ParallelRead {
  readonly started: boolean; readonly detail: string;
  readonly position?: { readonly consecutiveCleanDays: number; readonly openDifferences: readonly DifferenceRead[]; readonly unownedDifferences: readonly DifferenceRead[]; readonly valueAtStakeMinor: number; readonly sufficient: boolean; readonly detail: string };
  readonly days?: readonly { readonly businessDate: string; readonly clean: boolean; readonly differences: number; readonly open: number; readonly recordedBy: string }[];
}
export interface BooksTemplate { readonly report: string; readonly file: string; readonly words: { readonly en: string; readonly ta: string }; readonly fields: readonly { readonly key: string; readonly required: boolean; readonly words: { readonly en: string; readonly ta: string } }[] }
export interface BooksDayRead {
  readonly record: { readonly businessDate: string; readonly reports: readonly string[]; readonly lines: number; readonly notCompared: readonly unknown[]; readonly by: string; readonly at: string } | null;
  readonly templates: readonly BooksTemplate[];
}
export interface BooksRecorded { readonly differences: number; readonly notGiven: readonly string[]; readonly notCompared: readonly unknown[]; readonly detail: string; readonly record: { readonly by: string; readonly lines: number } }
export interface SheetRead { readonly markdown: string }
export interface RollbackConfirmed { readonly rollback: { readonly cutoverId: string; readonly state: string; readonly performed: boolean; readonly execution?: { readonly confirmedBy: string; readonly legacyFirstBillRef: string; readonly legacyTradingFrom: string } } }
export interface RollbackReconciled { readonly reconciliation: { readonly reconciled: boolean; readonly detail?: string; readonly differences?: readonly string[]; readonly by: string }; readonly demonstrated: boolean }

// ── the evidence files: one published header per file, read row by row ──────────────────────────────────────

type ColKind = 'text' | 'opt_text' | 'num' | 'int' | 'opt_int' | 'rupees' | 'percent_bps' | 'yes_no' | 'date';
export interface Column { readonly col: string; readonly key: string; readonly kind: ColKind; readonly oneOf?: readonly string[] }

const c = (col: string, key: string, kind: ColKind, oneOf?: readonly string[]): Column => ({ col, key, kind, ...(oneOf === undefined ? {} : { oneOf }) });
const TENDERS = ['cash', 'card', 'upi', 'other'] as const;
const TB = [c('account_code', 'accountCode', 'text'), c('account_name', 'accountName', 'text'), c('nature', 'nature', 'text', ['asset', 'liability', 'equity', 'income', 'expense']), c('debit', 'debitMinor', 'rupees'), c('credit', 'creditMinor', 'rupees'), c('contra', 'contra', 'yes_no')];

/** Every evidence file the sections read, with its exact header — the template a person fills from the outside document. */
export const EVIDENCE_FILES = Object.freeze({
  count_lines: [c('line_id', 'lineId', 'text'), c('product_id', 'productId', 'text'), c('description', 'description', 'text'), c('extracted_qty', 'extractedQty', 'num'), c('extracted_value', 'extractedValueMinor', 'rupees')],
  count_counted: [c('line_id', 'lineId', 'text'), c('counted_qty', 'countedQty', 'num'), c('counter_id', 'counterId', 'text')],
  supplier_items: [c('supplier_id', 'supplierId', 'text'), c('statement_date', 'statementDate', 'date'), c('side', 'side', 'text', ['ours', 'theirs']), c('document_number', 'documentNumber', 'text'), c('kind', 'kind', 'text', ['invoice', 'credit_note', 'payment']), c('amount', 'amountMinor', 'rupees'), c('document_date', 'documentDate', 'date'), c('reference', 'reference', 'opt_text')],
  bank_takings: [c('business_date', 'businessDate', 'date'), c('tender', 'tender', 'text', TENDERS), c('gross', 'grossMinor', 'rupees')],
  bank_credits: [c('line_id', 'lineId', 'text'), c('value_date', 'valueDate', 'date'), c('amount', 'amountMinor', 'rupees'), c('narrative', 'narrative', 'text'), c('attributed_to', 'attributedTo', 'text', [...TENDERS, 'unattributed'])],
  bank_terms: [c('tender', 'tender', 'text', TENDERS), c('commission_percent', 'commissionBps', 'percent_bps'), c('gst_on_commission_percent', 'gstOnCommissionBps', 'percent_bps'), c('settlement_lag_days', 'settlementLagDays', 'int'), c('tolerance_days', 'toleranceDays', 'int'), c('source', 'source', 'text', ['merchant_agreement', 'provider_advice', 'bank_confirmation', 'derived_from_the_difference'])],
  tax_returns: [c('period', 'period', 'text'), c('kind', 'kind', 'text', ['gstr1', 'gstr3b']), c('gstin', 'gstin', 'text'), c('filed_on', 'filedOn', 'date'), c('acknowledgement_ref', 'acknowledgementRef', 'opt_text')],
  tax_lines: [c('period', 'period', 'text'), c('kind', 'kind', 'text', ['gstr1', 'gstr3b', 'books']), c('rate_percent', 'rateBps', 'percent_bps'), c('taxable', 'taxableValueMinor', 'rupees'), c('cgst', 'cgstMinor', 'rupees'), c('sgst', 'sgstMinor', 'rupees'), c('igst', 'igstMinor', 'rupees'), c('cess', 'cessMinor', 'rupees')],
  books_accounts: TB,
  books_opening: TB,
  loyalty_balances: [c('customer_id', 'customerId', 'text'), c('customer_name', 'customerName', 'text'), c('points', 'pointsBalance', 'int'), c('tier', 'tier', 'opt_text'), c('last_activity_date', 'lastActivityDate', 'opt_text'), c('points_expiring_soon', 'pointsExpiringSoon', 'opt_int')],
  loyalty_confirmations: [c('customer_id', 'customerId', 'text'), c('method', 'method', 'text', ['customer_stated_their_own_figure', 'customer_confirmed_recent_activity', 'customer_shown_the_balance_and_agreed']), c('stated_points', 'statedPoints', 'opt_int'), c('activity_confirmed', 'activityConfirmed', 'opt_text'), c('confirmed_on', 'confirmedOn', 'date')],
  rollback_stock: [c('product_id', 'productId', 'text'), c('net_quantity', 'netQuantityMinor', 'int')],
} as const satisfies Record<string, readonly Column[]>);
export type EvidenceFile = keyof typeof EVIDENCE_FILES;

/** The empty template of one evidence file — just its header row. */
export const templateOf = (file: EvidenceFile): string => `${EVIDENCE_FILES[file].map((x) => x.col).join(',')}\r\n`;

/** One CSV line → its cells (double-quoted cells may hold commas and "" for a quote). */
function cellsOf(line: string): string[] {
  const out: string[] = [];
  let cur = ''; let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; } else if (ch === '"') quoted = false; else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

type Invalid = { readonly result: 'invalid'; readonly why: string };
const invalid = (why: string): Invalid => ({ result: 'invalid', why });
const isInvalid = (v: unknown): v is Invalid => v !== null && typeof v === 'object' && (v as { result?: unknown }).result === 'invalid';
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * An evidence file as transcribed → its rows in head office's shape, or why not (`csv:<file>:<line>:<column>`, which the
 * page says in words). Every named column must be in the header; an empty file, or one with no data row, is refused.
 */
export function readEvidenceFile(file: EvidenceFile, text: string): readonly Record<string, unknown>[] | Invalid {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const header = cellsOf(lines[0] ?? '').map((h) => h.toLowerCase());
  const cols = EVIDENCE_FILES[file] as readonly Column[];
  const at = new Map(cols.map((x) => [x.col, header.indexOf(x.col)]));
  for (const x of cols) if (at.get(x.col)! < 0 && !x.kind.startsWith('opt_') && x.kind !== 'yes_no') return invalid(`csv:${file}:1:${x.col}`);
  const rows: Record<string, unknown>[] = [];
  for (let n = 1; n < lines.length; n += 1) {
    if (lines[n]!.trim() === '') continue;
    const cells = cellsOf(lines[n]!);
    const row: Record<string, unknown> = {};
    for (const x of cols) {
      const i = at.get(x.col)!;
      const v = i < 0 ? '' : (cells[i] ?? '');
      const bad = invalid(`csv:${file}:${n + 1}:${x.col}`);
      switch (x.kind) {
        case 'text': if (v === '' || (x.oneOf !== undefined && !x.oneOf.includes(v))) return bad; row[x.key] = v; break;
        case 'opt_text': if (v !== '') row[x.key] = v; break;
        case 'date': if (!DAY.test(v)) return bad; row[x.key] = v; break;
        case 'num': if (!/^-?\d+(\.\d+)?$/.test(v)) return bad; row[x.key] = Number(v); break;
        case 'int': if (!/^-?\d+$/.test(v)) return bad; row[x.key] = Number(v); break;
        case 'opt_int': if (v === '') break; if (!/^\d+$/.test(v)) return bad; row[x.key] = Number(v); break;
        case 'rupees': { const p = paiseOf(v); if (p === undefined) return bad; row[x.key] = p; break; }
        case 'percent_bps': { const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(v); if (m === null) return bad; row[x.key] = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')); break; }
        case 'yes_no': { const y = v.toLowerCase(); if (y === '' || y === 'no') break; if (y !== 'yes') return bad; row[x.key] = true; break; }
      }
    }
    rows.push(row);
  }
  if (rows.length === 0) return invalid(`csv:${file}:2:`);
  return rows;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const whole = (s: string): number | undefined => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : undefined);
/** A shop-clock time from a `datetime-local` field ("2026-11-03T19:05") → the instant, read in Asia/Kolkata (never UTC). */
export function shopInstantOf(local: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(local.trim())) return undefined;
  const v = local.trim().length === 16 ? `${local.trim()}:00` : local.trim();
  const t = Date.parse(`${v}+05:30`);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}
const list = (s: string): string[] => s.split(/[,\n]/).map((x) => x.trim()).filter((x) => x !== '');

/** The file the person saves to print or keep: the page or the sheet exactly as head office wrote it. */
export function keptFile(name: string, markdown: string): { readonly name: string; readonly href: string } {
  return { name, href: `data:text/markdown;charset=utf-8,${encodeURIComponent(markdown.endsWith('\n') ? markdown : `${markdown}\n`)}` };
}

// ── words ───────────────────────────────────────────────────────────────────────────────────────────────────

export const CUTOVER_EVIDENCE_COPY = {
  en: {
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was changed.', nobody: 'Nobody is signed in on this screen — you can read nothing and change nothing.',
    notAllowed: 'Your role cannot do this step.', badFile: 'Fix the file:', badFileLine: 'line', badFileColumn: 'column', badFileEmpty: 'it has no data row', badFileMissing: 'the header has no column',
    template: 'Empty template', chooseFile: 'Choose the file.',
    // MG-11 — the signed verification page
    verH: 'Every figure has a witness — the signed page', verLead: 'Each of the twelve kinds of record is checked against something outside the old system. Record who ran the extraction, give each witness the document transcribed into its template, and watch the twelve fill up. Evidence a check refuses (a count planned by the person who ran the extraction, a commission worked out from the difference, a return with no acknowledgement number, unsigned accounts, a balance shown to the customer) records NOTHING. Head office works out every verdict — none is typed here.',
    runH: 'Who ran the extraction', runId: 'Run name', runOperator: 'Who ran it (their sign-in)', runSources: 'Sources it took (comma between)', runNote: 'Note', runRecord: 'Record who ran it', runRecorded: 'Recorded — this person can now neither plan the count nor sign the page:',
    noRunId: 'Name the run (letters, digits, dot, dash).', noOperator: 'Type the sign-in of the person who ran the extraction.',
    witH: 'The six witnesses', witWhich: 'Which witness', evidenceRef: 'Which document (its reference)', recordWitness: 'Give this evidence to head office', witRecorded: 'Head office recorded what it found:',
    w_count: 'The shelves — the blind count', w_suppliers: 'The suppliers\' own statements', w_bank: 'The bank statement', w_tax: 'The filed GST returns', w_books: 'The chartered accountant\'s signed accounts', w_loyalty: 'The customers\' own answers',
    planId: 'Sample plan name', plannedBy: 'Who planned the sample (their sign-in)', seed: 'Sample number (seed)',
    f_count_lines: 'What the extract says is on the shelf (CSV)', f_count_counted: 'What was counted, blind (CSV)',
    f_supplier_items: 'Each supplier statement line, ours and theirs (CSV)', suppliersAsked: 'Suppliers asked for a statement (comma between)',
    periodStart: 'Takings from', periodEnd: 'Takings to', stmtFrom: 'Statement period from (as printed)', stmtTo: 'Statement period to (as printed)',
    f_bank_takings: 'The old system\'s takings per day and tender (CSV)', f_bank_credits: 'The bank\'s credit lines (CSV)', f_bank_terms: 'The merchant terms per tender (CSV)',
    periodsExpected: 'Months that must have a return (YYYY-MM, comma between)', f_tax_returns: 'Each filed return (CSV)', f_tax_lines: 'The slabs: each return and the books (CSV)',
    entity: 'Whose accounts', periodEndAcc: 'Accounts drawn to', preparedBy: 'Prepared by', signedOn: 'Signed on', membership: 'Membership number', cutoverDate: 'Switch-over date',
    f_books_accounts: 'The signed trial balance (CSV)', f_books_opening: 'The opening trial balance here (CSV)',
    sampleSource: 'How the sample was drawn', ss_drawn_before_anybody_was_told: 'Drawn before anybody was told', ss_drawn_from_complaints: 'Drawn from complaints', pointCost: 'What one point costs the shop (₹)',
    f_loyalty_balances: 'The points balances carried across (CSV)', f_loyalty_confirmations: 'What each customer said (CSV)', f_rollback_stock: 'Each product\'s stock movement in the old system (CSV)',
    noEvidenceRef: 'Name the document this evidence comes from.', noPlanId: 'Name the sample plan.', noPlannedBy: 'Type who planned the sample.', noSeed: 'The sample number is a whole number.',
    noAsked: 'Name the suppliers asked for a statement.', noPeriod: 'Fill in every date.', noPeriods: 'Name the months that must have a return.', noEntity: 'Fill in whose accounts, the dates and who prepared them.',
    noSampleSource: 'Say how the sample was drawn.', noPointCost: 'What one point costs, in rupees, for example 0.25.', noWitness: 'Choose which witness.',
    progH: 'Where the twelve kinds stand', showProgress: 'Show where they stand', coveredK: 'of 12 have a finding', missingK: 'still missing', signaturesK: 'signature(s) over this page',
    ownerUnknown: 'Nobody is recorded as the owner — the page cannot be built.', operatorUnknown: 'Nobody is recorded as having run the extraction — the page cannot be built.',
    v_proved: 'proved', v_proved_with_differences: 'proved, with differences', v_not_proved: 'NOT proved', v_no_evidence_exists: 'no outside evidence exists',
    findingBy: 'recorded by', cannotProve: 'What it cannot prove:', ownerDo: 'What the owner does:',
    d_products: 'Products', d_barcodes: 'Barcodes', d_prices: 'Prices', d_stock: 'Stock', d_batches: 'Batches', d_suppliers: 'Suppliers', d_purchases: 'Purchases', d_customers: 'Customers', d_loyalty: 'Loyalty points', d_sales: 'Sales', d_tax: 'Tax', d_ledgers: 'The books',
    pageH: 'The page, and its signatures', showPage: 'Show the page', savePage: 'Keep a copy (to print)', printPage: 'Print it', pageSigs: 'signature(s) over these figures',
    signStatement: 'What you checked, in your own words', signPage: 'Sign the page', signed: 'Signed in your name over these figures. Signatures now:', noSignStatement: 'Say what you checked, in your own words.',
    // OD-05
    accH: 'The owner accepts a kind of record on the old system\'s word', accLead: 'Where nothing outside the old system could check a kind of record, or the check did not prove it, it is carried into the opening books only on the owner\'s written acceptance — in his own name, with his reason. Words that say nothing ("ok", "approved", "as discussed") are refused when the page is built.',
    accDomain: 'Which kind of record', accReason: 'Why you accept it, in your own words', accept: 'Accept it, in my name', accepted: 'Accepted in your name:', noDomain: 'Choose the kind of record.', noAccReason: 'Write your reason — in two years it is the only record that you decided this.',
    // MG-11 — the rollback limits
    limH: 'The owner\'s going-back limits', limLead: 'Four numbers the owner agrees before the switch-over night. Each one is his — a limit left empty stays NOT SET, and the switch-over cannot be said GO until all four are set. Once GO is given they do not move.',
    lim_controlTotalDifferenceMinor: 'Largest money difference allowed on the night (₹)', lim_edgeOutageMinutes: 'Longest the store may be cut off from head office (minutes)', lim_windowMinutes: 'How long the night may run after GO (minutes)', lim_backupMaxAgeHours: 'How old the last good backup may be (hours)',
    showLimits: 'Show the limits', setLimits: 'Save my limits', notSetK: 'NOT SET', setByK: 'set by', versionK: 'version', backupK: 'The backup:', allSet: 'Every limit is set', someNotSet: 'limit(s) not set — the switch-over cannot be said GO',
    noLimit: 'Each limit is a whole number (money in rupees, for example 500 or 500.50), or empty for not set.',
    // MG-10 — the books side of a parallel day
    booksH: 'Running both — the books side of a day', booksLead: 'The old ERP\'s own day reports for one trading day, compared with what head office holds for that day. Sending the books side again replaces the earlier books side of that day; the sales side stays. Figures are compared exactly. Only the named daily reconciler or the owner records it.',
    booksDate: 'Trading day', showBooks: 'Show the reports and the day', booksReport: 'Which report', booksFile: 'The report as the old ERP printed it (CSV)', booksDateOrder: 'Dates in the file are written', do_dmy: 'day/month/year', do_mdy: 'month/day/year', do_ymd: 'year-month-day',
    booksColumn: 'their column for', addReport: 'Add this report', recordBooks: 'Record the books side of the day', reportsNone: 'No report added yet.', booksHeld: 'Held for this day:', booksNoneHeld: 'No books side recorded for this day yet.',
    noBooksDate: 'Choose the trading day.', noReport: 'Choose the report.', noReports: 'Add at least one report first.', booksFirst: 'Show the reports first — head office tells the page what each report holds.', noBooksColumns: 'Name their column for every required field.', sameReport: 'That report is already added — remove it to add it again.',
    differencesK: 'difference(s)', notComparedK: 'figure(s) could not be compared', notGivenK: 'not given:',
    diffH: 'Put a name on each difference', showDiffs: 'Show the open differences', diffsNone: 'No open difference.', diffWhich: 'Which difference', diffExplain: 'What caused it (when known)', diffWrong: 'Which system was wrong',
    ws_legacy: 'the old system', ws_new: 'the new system', ws_both: 'both', ws_neither: 'neither', ownDiff: 'Own this difference', owned: 'Owned in your name.', noDiff: 'Choose a difference.', unownedK: 'NOBODY OWNS IT', ownerK: 'owned by', cleanDaysK: 'clean day(s) in a row', atStakeK: 'still at stake',
    sheetH: 'The daily sheet to sign', showSheet: 'Show the sheet', saveSheet: 'Keep a copy (to print)', printSheet: 'Print it',
    // GT-02 — confirming and reconciling a rollback
    rbH: 'Going back to the old system — confirm it and reconcile it', rbLead: 'Going back is decided at the store computer, at once, by one button. It is DONE only when somebody has seen the old till take its first sale: type that bill here. Then reconcile the window — head office counts what the new system took from its own sales; you type what the old system now holds from the carry-back. A reconciliation that does not balance is kept too, and demonstrates nothing.',
    rbCutover: 'Switch-over name', rbBill: 'The old system\'s first bill number', rbFrom: 'When the old system started taking sales (shop time)', rbConfirm: 'Confirm going back', rbConfirmed: 'Going back is DONE — confirmed in your name with bill',
    rbNewFrom: 'When the new system started taking sales (shop time)', rbCount: 'Bills carried back into the old system', rbTotal: 'Their total (₹)', rbRefunds: 'Refunds carried back', rbRefundTotal: 'Refunds total (₹)',
    rbReconcile: 'Reconcile the window', rbReconciled: 'Reconciled — the old system holds every bill the new one took. Going back is demonstrated.', rbNotReconciled: 'Does NOT balance — kept as evidence; going back is not demonstrated:',
    noRbCutover: 'Name the switch-over.', noBill: 'Type the old system\'s first bill number.', noTime: 'Choose the date and time on the shop\'s clock.', noCount: 'Bills and refunds are whole numbers.', noMoney: 'A total in rupees, for example 1250.50.',
  },
  ta: {
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அணுக முடியவில்லை — எதுவும் மாற்றப்படவில்லை.', nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை — எதையும் படிக்கவோ மாற்றவோ முடியாது.',
    notAllowed: 'உங்கள் பணிப்பொறுப்பால் இந்தப் படியைச் செய்ய முடியாது.', badFile: 'கோப்பைச் சரிசெய்யவும்:', badFileLine: 'வரி', badFileColumn: 'நெடுவரிசை', badFileEmpty: 'அதில் தரவு வரி இல்லை', badFileMissing: 'தலைப்பு வரியில் இந்த நெடுவரிசை இல்லை',
    template: 'வெற்று மாதிரி', chooseFile: 'கோப்பைத் தேர்ந்தெடுக்கவும்.',
    verH: 'ஒவ்வொரு எண்ணுக்கும் ஒரு சாட்சி — கையெழுத்திடும் பக்கம்', verLead: 'பன்னிரண்டு வகைப் பதிவுகள் ஒவ்வொன்றும் பழைய முறைக்கு வெளியே உள்ள ஒன்றுடன் சரிபார்க்கப்படுகிறது. பிரித்தெடுத்தவர் யார் என்று பதிவு செய்யுங்கள், ஒவ்வொரு சாட்சிக்கும் ஆவணத்தை அதன் மாதிரியில் எழுதிக் கொடுங்கள், பன்னிரண்டும் நிரம்புவதைப் பாருங்கள். சோதனை மறுக்கும் சான்று எதையும் பதிவு செய்யாது. ஒவ்வொரு முடிவையும் தலைமை அலுவலகமே கணக்கிடுகிறது — இங்கு எதுவும் தட்டச்சு செய்யப்படுவதில்லை.',
    runH: 'பிரித்தெடுத்தவர் யார்', runId: 'ஓட்டத்தின் பெயர்', runOperator: 'செய்தவர் (அவரது உள்நுழைவு)', runSources: 'எடுத்த மூலங்கள் (காற்புள்ளியால் பிரிக்கவும்)', runNote: 'குறிப்பு', runRecord: 'செய்தவரைப் பதிவு செய்', runRecorded: 'பதிவானது — இவர் இனி எண்ணிக்கையைத் திட்டமிடவோ பக்கத்தில் கையெழுத்திடவோ முடியாது:',
    noRunId: 'ஓட்டத்துக்குப் பெயரிடவும் (எழுத்துகள், எண்கள், புள்ளி, கோடு).', noOperator: 'பிரித்தெடுத்தவரின் உள்நுழைவைத் தட்டச்சு செய்யவும்.',
    witH: 'ஆறு சாட்சிகள்', witWhich: 'எந்தச் சாட்சி', evidenceRef: 'எந்த ஆவணம் (அதன் குறிப்பு)', recordWitness: 'இந்தச் சான்றைத் தலைமை அலுவலகத்துக்குக் கொடு', witRecorded: 'தலைமை அலுவலகம் கண்டதைப் பதிவு செய்தது:',
    w_count: 'அலமாரிகள் — மறைமுக எண்ணிக்கை', w_suppliers: 'விற்பனையாளர்களின் சொந்த அறிக்கைகள்', w_bank: 'வங்கி அறிக்கை', w_tax: 'தாக்கல் செய்த GST அறிக்கைகள்', w_books: 'பட்டயக் கணக்காளரின் கையெழுத்திட்ட கணக்குகள்', w_loyalty: 'வாடிக்கையாளர்களின் சொந்தப் பதில்கள்',
    planId: 'மாதிரித் திட்டத்தின் பெயர்', plannedBy: 'மாதிரியைத் திட்டமிட்டவர் (உள்நுழைவு)', seed: 'மாதிரி எண் (விதை)',
    f_count_lines: 'அலமாரியில் இருப்பதாகப் பிரித்தெடுப்பு சொல்வது (CSV)', f_count_counted: 'மறைமுகமாக எண்ணியது (CSV)',
    f_supplier_items: 'ஒவ்வொரு விற்பனையாளர் அறிக்கை வரியும், நம்முடையதும் அவர்களுடையதும் (CSV)', suppliersAsked: 'அறிக்கை கேட்கப்பட்ட விற்பனையாளர்கள் (காற்புள்ளியால் பிரிக்கவும்)',
    periodStart: 'வசூல் தொடக்கம்', periodEnd: 'வசூல் முடிவு', stmtFrom: 'அறிக்கைக் காலம் தொடக்கம் (அச்சிட்டபடி)', stmtTo: 'அறிக்கைக் காலம் முடிவு (அச்சிட்டபடி)',
    f_bank_takings: 'பழைய முறையின் நாள் மற்றும் செலுத்தும் வழி வாரியான வசூல் (CSV)', f_bank_credits: 'வங்கியின் வரவு வரிகள் (CSV)', f_bank_terms: 'ஒவ்வொரு வழிக்கும் வணிக விதிமுறைகள் (CSV)',
    periodsExpected: 'அறிக்கை இருக்க வேண்டிய மாதங்கள் (YYYY-MM, காற்புள்ளியால் பிரிக்கவும்)', f_tax_returns: 'தாக்கல் செய்த ஒவ்வொரு அறிக்கையும் (CSV)', f_tax_lines: 'வரி அடுக்குகள்: ஒவ்வொரு அறிக்கையும் கணக்கேடுகளும் (CSV)',
    entity: 'யாருடைய கணக்குகள்', periodEndAcc: 'கணக்குகள் வரையப்பட்ட நாள்', preparedBy: 'தயாரித்தவர்', signedOn: 'கையெழுத்திட்ட நாள்', membership: 'உறுப்பினர் எண்', cutoverDate: 'மாற்ற நாள்',
    f_books_accounts: 'கையெழுத்திட்ட இருப்புநிலைச் சோதனை (CSV)', f_books_opening: 'இங்குள்ள தொடக்க இருப்புநிலைச் சோதனை (CSV)',
    sampleSource: 'மாதிரி எப்படி எடுக்கப்பட்டது', ss_drawn_before_anybody_was_told: 'யாருக்கும் சொல்லும் முன் எடுக்கப்பட்டது', ss_drawn_from_complaints: 'புகார்களிலிருந்து எடுக்கப்பட்டது', pointCost: 'ஒரு புள்ளிக்குக் கடைக்கு ஆகும் செலவு (₹)',
    f_loyalty_balances: 'கொண்டுவரப்பட்ட புள்ளி இருப்புகள் (CSV)', f_loyalty_confirmations: 'ஒவ்வொரு வாடிக்கையாளரும் சொன்னது (CSV)', f_rollback_stock: 'பழைய முறையில் ஒவ்வொரு பொருளின் இருப்பு நகர்வு (CSV)',
    noEvidenceRef: 'இந்தச் சான்று வந்த ஆவணத்தைக் குறிப்பிடவும்.', noPlanId: 'மாதிரித் திட்டத்துக்குப் பெயரிடவும்.', noPlannedBy: 'மாதிரியைத் திட்டமிட்டவரைத் தட்டச்சு செய்யவும்.', noSeed: 'மாதிரி எண் ஒரு முழு எண்.',
    noAsked: 'அறிக்கை கேட்கப்பட்ட விற்பனையாளர்களைக் குறிப்பிடவும்.', noPeriod: 'ஒவ்வொரு தேதியையும் நிரப்பவும்.', noPeriods: 'அறிக்கை இருக்க வேண்டிய மாதங்களைக் குறிப்பிடவும்.', noEntity: 'யாருடைய கணக்குகள், தேதிகள், தயாரித்தவர் ஆகியவற்றை நிரப்பவும்.',
    noSampleSource: 'மாதிரி எப்படி எடுக்கப்பட்டது என்று சொல்லவும்.', noPointCost: 'ஒரு புள்ளியின் செலவு, ரூபாயில், எ.கா. 0.25.', noWitness: 'எந்தச் சாட்சி என்று தேர்ந்தெடுக்கவும்.',
    progH: 'பன்னிரண்டு வகைகளின் நிலை', showProgress: 'நிலையைக் காட்டு', coveredK: '/12 வகைகளுக்குக் கண்டுபிடிப்பு உள்ளது', missingK: 'இன்னும் இல்லை', signaturesK: 'இந்தப் பக்கத்தின் மீதான கையெழுத்து(கள்)',
    ownerUnknown: 'உரிமையாளர் யார் என்று பதிவு இல்லை — பக்கத்தை உருவாக்க முடியாது.', operatorUnknown: 'பிரித்தெடுத்தவர் யார் என்று பதிவு இல்லை — பக்கத்தை உருவாக்க முடியாது.',
    v_proved: 'நிரூபிக்கப்பட்டது', v_proved_with_differences: 'வித்தியாசங்களுடன் நிரூபிக்கப்பட்டது', v_not_proved: 'நிரூபிக்கப்படவில்லை', v_no_evidence_exists: 'வெளிச் சான்று எதுவும் இல்லை',
    findingBy: 'பதிவு செய்தவர்', cannotProve: 'இது நிரூபிக்க முடியாதது:', ownerDo: 'உரிமையாளர் செய்ய வேண்டியது:',
    d_products: 'பொருட்கள்', d_barcodes: 'பார்கோடுகள்', d_prices: 'விலைகள்', d_stock: 'இருப்பு', d_batches: 'தொகுதிகள்', d_suppliers: 'விற்பனையாளர்கள்', d_purchases: 'கொள்முதல்கள்', d_customers: 'வாடிக்கையாளர்கள்', d_loyalty: 'விசுவாசப் புள்ளிகள்', d_sales: 'விற்பனை', d_tax: 'வரி', d_ledgers: 'கணக்கேடுகள்',
    pageH: 'பக்கமும் அதன் கையெழுத்துகளும்', showPage: 'பக்கத்தைக் காட்டு', savePage: 'ஒரு நகலை வைத்துக்கொள் (அச்சிட)', printPage: 'அச்சிடு', pageSigs: 'இந்த எண்களின் மீதான கையெழுத்து(கள்)',
    signStatement: 'நீங்கள் சரிபார்த்தது, உங்கள் சொந்த வார்த்தைகளில்', signPage: 'பக்கத்தில் கையெழுத்திடு', signed: 'இந்த எண்களின் மீது உங்கள் பெயரில் கையெழுத்திடப்பட்டது. இப்போது கையெழுத்துகள்:', noSignStatement: 'நீங்கள் சரிபார்த்ததை உங்கள் சொந்த வார்த்தைகளில் சொல்லவும்.',
    accH: 'பழைய முறையின் சொல்லின் மீது உரிமையாளர் ஒரு வகைப் பதிவை ஏற்கிறார்', accLead: 'பழைய முறைக்கு வெளியே எதுவும் ஒரு வகைப் பதிவைச் சரிபார்க்க முடியாதபோது, அல்லது சோதனை அதை நிரூபிக்காதபோது, அது உரிமையாளரின் எழுத்துபூர்வ ஏற்புடன் மட்டுமே தொடக்கக் கணக்கில் கொண்டுவரப்படும் — அவரது பெயரில், அவரது காரணத்துடன். எதுவும் சொல்லாத வார்த்தைகள் ("சரி", "ஒப்புதல்") பக்கம் உருவாக்கும்போது மறுக்கப்படும்.',
    accDomain: 'எந்த வகைப் பதிவு', accReason: 'ஏன் ஏற்கிறீர்கள், உங்கள் சொந்த வார்த்தைகளில்', accept: 'என் பெயரில் ஏற்கிறேன்', accepted: 'உங்கள் பெயரில் ஏற்கப்பட்டது:', noDomain: 'வகைப் பதிவைத் தேர்ந்தெடுக்கவும்.', noAccReason: 'உங்கள் காரணத்தை எழுதவும் — இரண்டு ஆண்டுகளில் நீங்கள் இதை முடிவு செய்ததற்கான ஒரே பதிவு அதுதான்.',
    limH: 'உரிமையாளரின் திரும்பிச் செல்லும் வரம்புகள்', limLead: 'மாற்ற இரவுக்கு முன் உரிமையாளர் ஒப்புக்கொள்ளும் நான்கு எண்கள். ஒவ்வொன்றும் அவருடையது — காலியாக விடப்பட்ட வரம்பு "அமைக்கப்படவில்லை" என்றே இருக்கும்; நான்கும் அமைக்கப்படும் வரை மாற்றத்துக்கு GO சொல்ல முடியாது. GO கொடுத்த பின் அவை மாறாது.',
    lim_controlTotalDifferenceMinor: 'அன்றிரவு அனுமதிக்கப்படும் அதிகபட்ச பண வித்தியாசம் (₹)', lim_edgeOutageMinutes: 'கடை தலைமை அலுவலகத்துடன் தொடர்பின்றி இருக்கக்கூடிய அதிகபட்ச நேரம் (நிமிடங்கள்)', lim_windowMinutes: 'GO-க்குப் பிறகு இரவு வேலை நடக்கக்கூடிய நேரம் (நிமிடங்கள்)', lim_backupMaxAgeHours: 'கடைசி நல்ல காப்புப்பிரதி எவ்வளவு பழையதாக இருக்கலாம் (மணிநேரம்)',
    showLimits: 'வரம்புகளைக் காட்டு', setLimits: 'என் வரம்புகளைச் சேமி', notSetK: 'அமைக்கப்படவில்லை', setByK: 'அமைத்தவர்', versionK: 'பதிப்பு', backupK: 'காப்புப்பிரதி:', allSet: 'எல்லா வரம்புகளும் அமைக்கப்பட்டன', someNotSet: 'வரம்பு(கள்) அமைக்கப்படவில்லை — மாற்றத்துக்கு GO சொல்ல முடியாது',
    noLimit: 'ஒவ்வொரு வரம்பும் ஒரு முழு எண் (பணம் ரூபாயில், எ.கா. 500 அல்லது 500.50), அல்லது அமைக்காவிட்டால் காலி.',
    booksH: 'இரண்டையும் இயக்குதல் — ஒரு நாளின் கணக்குப் பக்கம்', booksLead: 'ஒரு வணிக நாளுக்கான பழைய ERP-யின் சொந்த நாள் அறிக்கைகள், அந்த நாளுக்குத் தலைமை அலுவலகம் வைத்திருப்பதுடன் ஒப்பிடப்படுகின்றன. கணக்குப் பக்கத்தை மீண்டும் அனுப்பினால் அந்த நாளின் முந்தைய கணக்குப் பக்கம் மாற்றப்படும்; விற்பனைப் பக்கம் அப்படியே இருக்கும். எண்கள் துல்லியமாக ஒப்பிடப்படுகின்றன. பெயரிடப்பட்ட தினசரி சரிபார்ப்பவர் அல்லது உரிமையாளர் மட்டுமே பதிவு செய்வார்.',
    booksDate: 'வணிக நாள்', showBooks: 'அறிக்கைகளையும் நாளையும் காட்டு', booksReport: 'எந்த அறிக்கை', booksFile: 'பழைய ERP அச்சிட்டபடி அறிக்கை (CSV)', booksDateOrder: 'கோப்பில் தேதிகள் எழுதப்பட்ட விதம்', do_dmy: 'நாள்/மாதம்/ஆண்டு', do_mdy: 'மாதம்/நாள்/ஆண்டு', do_ymd: 'ஆண்டு-மாதம்-நாள்',
    booksColumn: 'இதற்கான அவர்களின் நெடுவரிசை', addReport: 'இந்த அறிக்கையைச் சேர்', recordBooks: 'நாளின் கணக்குப் பக்கத்தைப் பதிவு செய்', reportsNone: 'இன்னும் அறிக்கை எதுவும் சேர்க்கப்படவில்லை.', booksHeld: 'இந்த நாளுக்கு வைத்திருப்பது:', booksNoneHeld: 'இந்த நாளுக்கு இன்னும் கணக்குப் பக்கம் பதிவாகவில்லை.',
    noBooksDate: 'வணிக நாளைத் தேர்ந்தெடுக்கவும்.', noReport: 'அறிக்கையைத் தேர்ந்தெடுக்கவும்.', noReports: 'முதலில் குறைந்தது ஒரு அறிக்கையைச் சேர்க்கவும்.', booksFirst: 'முதலில் அறிக்கைகளைக் காட்டவும் — ஒவ்வொரு அறிக்கையிலும் என்ன உள்ளது என்று தலைமை அலுவலகம் பக்கத்துக்குச் சொல்லும்.', noBooksColumns: 'தேவையான ஒவ்வொரு புலத்துக்கும் அவர்களின் நெடுவரிசையைக் குறிப்பிடவும்.', sameReport: 'அந்த அறிக்கை ஏற்கெனவே சேர்க்கப்பட்டுள்ளது.',
    differencesK: 'வித்தியாசம்(கள்)', notComparedK: 'எண்(கள்) ஒப்பிட முடியவில்லை', notGivenK: 'கொடுக்கப்படாதவை:',
    diffH: 'ஒவ்வொரு வித்தியாசத்துக்கும் ஒருவர் பொறுப்பு', showDiffs: 'திறந்த வித்தியாசங்களைக் காட்டு', diffsNone: 'திறந்த வித்தியாசம் எதுவும் இல்லை.', diffWhich: 'எந்த வித்தியாசம்', diffExplain: 'காரணம் (தெரிந்தால்)', diffWrong: 'எந்த முறை தவறியது',
    ws_legacy: 'பழைய முறை', ws_new: 'புதிய முறை', ws_both: 'இரண்டும்', ws_neither: 'இரண்டும் இல்லை', ownDiff: 'இந்த வித்தியாசத்துக்கு நான் பொறுப்பு', owned: 'உங்கள் பெயரில் பொறுப்பேற்கப்பட்டது.', noDiff: 'ஒரு வித்தியாசத்தைத் தேர்ந்தெடுக்கவும்.', unownedK: 'யாரும் பொறுப்பேற்கவில்லை', ownerK: 'பொறுப்பாளர்', cleanDaysK: 'தொடர்ச்சியான சுத்தமான நாள்(கள்)', atStakeK: 'இன்னும் ஆபத்தில்',
    sheetH: 'கையெழுத்திட வேண்டிய தினசரித் தாள்', showSheet: 'தாளைக் காட்டு', saveSheet: 'ஒரு நகலை வைத்துக்கொள் (அச்சிட)', printSheet: 'அச்சிடு',
    rbH: 'பழைய முறைக்குத் திரும்புதல் — உறுதிசெய்து சரிபார்', rbLead: 'திரும்பிச் செல்வது கடைக் கணினியில், உடனே, ஒரு பொத்தானால் முடிவு செய்யப்படுகிறது. பழைய பில்லிங் தன் முதல் விற்பனையை எடுத்ததை யாராவது பார்த்த பிறகுதான் அது முடிந்தது: அந்த பில்லை இங்கே தட்டச்சு செய்யுங்கள். பிறகு அந்தக் காலத்தைச் சரிபார்க்கவும் — புதிய முறை எடுத்ததைத் தலைமை அலுவலகம் தன் விற்பனைப் பதிவிலிருந்து எண்ணுகிறது; பழைய முறையில் இப்போது இருப்பதை நீங்கள் தட்டச்சு செய்கிறீர்கள். பொருந்தாத சரிபார்ப்பும் சான்றாக வைக்கப்படும், ஆனால் எதையும் நிரூபிக்காது.',
    rbCutover: 'மாற்றத்தின் பெயர்', rbBill: 'பழைய முறையின் முதல் பில் எண்', rbFrom: 'பழைய முறை விற்பனை எடுக்கத் தொடங்கிய நேரம் (கடை நேரம்)', rbConfirm: 'திரும்பியதை உறுதிசெய்', rbConfirmed: 'திரும்புதல் முடிந்தது — உங்கள் பெயரில் இந்த பில்லுடன் உறுதிசெய்யப்பட்டது',
    rbNewFrom: 'புதிய முறை விற்பனை எடுக்கத் தொடங்கிய நேரம் (கடை நேரம்)', rbCount: 'பழைய முறைக்குத் திரும்பக் கொண்டுசென்ற பில்கள்', rbTotal: 'அவற்றின் மொத்தம் (₹)', rbRefunds: 'திரும்பக் கொண்டுசென்ற பணத்திருப்பங்கள்', rbRefundTotal: 'பணத்திருப்ப மொத்தம் (₹)',
    rbReconcile: 'காலத்தைச் சரிபார்', rbReconciled: 'சரிபார்க்கப்பட்டது — புதிய முறை எடுத்த ஒவ்வொரு பில்லும் பழைய முறையில் உள்ளது. திரும்புதல் நிரூபிக்கப்பட்டது.', rbNotReconciled: 'பொருந்தவில்லை — சான்றாக வைக்கப்பட்டது; திரும்புதல் நிரூபிக்கப்படவில்லை:',
    noRbCutover: 'மாற்றத்துக்குப் பெயரிடவும்.', noBill: 'பழைய முறையின் முதல் பில் எண்ணைத் தட்டச்சு செய்யவும்.', noTime: 'கடையின் கடிகாரப்படி தேதியும் நேரமும் தேர்ந்தெடுக்கவும்.', noCount: 'பில்களும் பணத்திருப்பங்களும் முழு எண்கள்.', noMoney: 'ரூபாயில் ஒரு மொத்தம், எ.கா. 1250.50.',
  },
} as const;

export type CutoverEvidenceCopyKey = keyof typeof CUTOVER_EVIDENCE_COPY.en;

/** The words for a key — and for a file problem (`csv:<file>:<line>:<column>`), a whole sentence naming the line and column. */
export function evidenceWords(lang: Lang, key: string): string {
  const w = (k: string): string => (CUTOVER_EVIDENCE_COPY[lang] as Record<string, string>)[k] ?? (CUTOVER_EVIDENCE_COPY.en as Record<string, string>)[k] ?? k;
  const m = /^csv:([a-z_]+):(\d+):(.*)$/.exec(key);
  if (m === null) return w(key);
  const [, file, line, column] = m;
  const what = w(`f_${file}`);
  if (column === '') return `${w('badFile')} ${what} — ${w('badFileEmpty')}.`;
  if (line === '1') return `${w('badFile')} ${what} — ${w('badFileMissing')} “${column}”.`;
  return `${w('badFile')} ${what} — ${w('badFileLine')} ${line}, ${w('badFileColumn')} “${column}”.`;
}
export const evidenceOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => evidenceWords(lang, k), out);
export { rupees };

// ── the session ───────────────────────────────────────────────────────────────────────────────────────────

export interface CutoverEvidenceMay {
  readonly named: boolean;
  readonly verifyRead: boolean; readonly extraction: boolean; readonly evidence: boolean; readonly signPage: boolean;
  readonly accept: boolean; readonly limitsRead: boolean; readonly limitsSet: boolean;
  readonly parallelRead: boolean; readonly parallelRecord: boolean; readonly rollback: boolean;
}

/** What the person typed and chose for one witness: plain fields plus the transcribed files' text by file name. */
export interface WitnessDraft { readonly fields: Readonly<Record<string, string>>; readonly files: Readonly<Partial<Record<EvidenceFile, string>>> }
export interface BooksReportDraft { readonly report: string; readonly csv: string; readonly mapping: Readonly<Record<string, string>>; readonly dateOrder: string }

export interface CutoverEvidenceSession {
  readonly may: CutoverEvidenceMay;
  recordExtractionRun(d: { readonly runId: string; readonly operatorId: string; readonly sources: string; readonly note: string }): Promise<Outcome<{ readonly run: { readonly runId: string; readonly operatorId: string; readonly recordedBy: string } }>>;
  witness(which: string, d: WitnessDraft): Promise<Outcome<WitnessResult>>;
  progress(): Promise<Outcome<ProgressRead>>;
  page(): Promise<Outcome<PageRead>>;
  signPage(statement: string): Promise<Outcome<{ readonly signatures: number; readonly detail: string }>>;
  accept(domain: string, reason: string): Promise<Outcome<{ readonly domain: string; readonly acceptedBy: string; readonly acceptedOn: string; readonly reason: string }>>;
  limits(): Promise<Outcome<LimitsRead>>;
  /** Each limit as typed; empty is "not set" (null) — never a default. Money in rupees, sent in paise. */
  setLimits(d: Readonly<Record<LimitName, string>>): Promise<Outcome<{ readonly notSet: readonly string[] }>>;
  parallel(): Promise<Outcome<ParallelRead>>;
  booksDay(businessDate: string): Promise<Outcome<BooksDayRead>>;
  /** The books side of one day: every report added, each with its column mapping (checked against head office's templates). */
  recordBooks(businessDate: string, reports: readonly BooksReportDraft[], templates: readonly BooksTemplate[]): Promise<Outcome<BooksRecorded>>;
  ownDifference(differenceId: string, explanation: string, wrongSide: string): Promise<Outcome<{ readonly difference: DifferenceRead; readonly detail: string }>>;
  sheet(): Promise<Outcome<SheetRead>>;
  confirmRollback(cutoverId: string, firstBill: string, tradingFromLocal: string): Promise<Outcome<RollbackConfirmed>>;
  reconcileRollback(cutoverId: string, d: { readonly newFromLocal: string; readonly count: string; readonly total: string; readonly refunds: string; readonly refundsTotal: string; readonly stockCsv: string }): Promise<Outcome<RollbackReconciled>>;
}

const groupBy = <T>(rows: readonly T[], key: (r: T) => string): Map<string, T[]> => {
  const m = new Map<string, T[]>();
  for (const r of rows) { const k = key(r); m.set(k, [...(m.get(k) ?? []), r]); }
  return m;
};
const omit = (r: Record<string, unknown>, ...keys: string[]): Record<string, unknown> => Object.fromEntries(Object.entries(r).filter(([k]) => !keys.includes(k)));

/** One witness as drafted → the body its route reads, or why it cannot be sent (exported for the tests). */
export function witnessBody(which: string, d: WitnessDraft): Record<string, unknown> | Invalid {
  if (!(WITNESSES as readonly string[]).includes(which)) return invalid('noWitness');
  const f = (k: string): string => (d.fields[k] ?? '').trim();
  const file = (name: EvidenceFile): readonly Record<string, unknown>[] | Invalid => {
    const text = d.files[name] ?? '';
    return text.trim() === '' ? invalid('chooseFile') : readEvidenceFile(name, text);
  };
  const evidenceRef = f('evidenceRef');
  if (evidenceRef === '') return invalid('noEvidenceRef');
  const sample = (): { planId: string; plannedBy: string; seed: number } | Invalid => {
    if (f('planId') === '') return invalid('noPlanId');
    if (f('plannedBy') === '') return invalid('noPlannedBy');
    const seed = whole(f('seed')); if (seed === undefined) return invalid('noSeed');
    return { planId: f('planId'), plannedBy: f('plannedBy'), seed };
  };
  switch (which) {
    case 'count': {
      const s = sample(); if (isInvalid(s)) return s;
      const lines = file('count_lines'); if (isInvalid(lines)) return lines;
      const counted = file('count_counted'); if (isInvalid(counted)) return counted;
      return { evidenceRef, ...s, lines, counted };
    }
    case 'suppliers': {
      const asked = list(f('suppliersAsked')); if (asked.length === 0) return invalid('noAsked');
      const items = file('supplier_items'); if (isInvalid(items)) return items;
      const statements = [...groupBy(items, (r) => `${String(r['supplierId'])}|${String(r['statementDate'])}`).values()].map((rs) => ({
        supplierId: rs[0]!['supplierId'], statementDate: rs[0]!['statementDate'],
        ourItems: rs.filter((r) => r['side'] === 'ours').map((r) => omit(r, 'supplierId', 'statementDate', 'side')),
        theirItems: rs.filter((r) => r['side'] === 'theirs').map((r) => omit(r, 'supplierId', 'statementDate', 'side')),
      }));
      return { evidenceRef, statements, suppliersAsked: asked };
    }
    case 'bank': {
      const dates = [f('periodStart'), f('periodEnd'), f('stmtFrom'), f('stmtTo')];
      if (!dates.every((x) => DAY.test(x))) return invalid('noPeriod');
      const takings = file('bank_takings'); if (isInvalid(takings)) return takings;
      const credits = file('bank_credits'); if (isInvalid(credits)) return credits;
      const terms = file('bank_terms'); if (isInvalid(terms)) return terms;
      return { evidenceRef, periodStart: dates[0], periodEnd: dates[1], statementPeriod: { from: dates[2], to: dates[3] }, takings, credits, terms };
    }
    case 'tax': {
      const expected = list(f('periodsExpected')); if (expected.length === 0 || !expected.every((p) => /^\d{4}-\d{2}$/.test(p))) return invalid('noPeriods');
      const returns = file('tax_returns'); if (isInvalid(returns)) return returns;
      const lines = file('tax_lines'); if (isInvalid(lines)) return lines;
      const slab = (r: Record<string, unknown>): Record<string, unknown> => omit(r, 'period', 'kind');
      const filed = (period: string, kind: string): Record<string, unknown> => {
        const head = returns.find((r) => r['period'] === period && r['kind'] === kind);
        // A return with no row is sent as one with no acknowledgement — head office's check refuses it by name.
        return { period, kind, gstin: head?.['gstin'] ?? '', filedOn: head?.['filedOn'] ?? '', acknowledgementRef: head?.['acknowledgementRef'] ?? '', lines: lines.filter((l) => l['period'] === period && l['kind'] === kind).map(slab) };
      };
      const periods = [...new Set([...returns, ...lines].map((r) => String(r['period'])))].sort().map((period) => ({
        period, gstr1: filed(period, 'gstr1'), gstr3b: filed(period, 'gstr3b'), books: lines.filter((l) => l['period'] === period && l['kind'] === 'books').map(slab),
      }));
      return { evidenceRef, periods, periodsExpected: expected };
    }
    case 'books': {
      if (f('entity') === '' || !DAY.test(f('periodEndAcc')) || f('preparedBy') === '' || !DAY.test(f('cutoverDate')) || (f('signedOn') !== '' && !DAY.test(f('signedOn')))) return invalid('noEntity');
      const accounts = file('books_accounts'); if (isInvalid(accounts)) return accounts;
      const opening = file('books_opening'); if (isInvalid(opening)) return opening;
      return {
        evidenceRef, cutoverDate: f('cutoverDate'), opening,
        // Unsigned accounts, or no membership number, are sent as they are — head office's check refuses them by name.
        accounts: { entity: f('entity'), periodEnd: f('periodEndAcc'), preparedBy: f('preparedBy'), ...(f('signedOn') === '' ? {} : { signedOn: f('signedOn') }), ...(f('membership') === '' ? {} : { membershipNumber: f('membership') }), lines: accounts },
      };
    }
    default: { // loyalty
      const s = sample(); if (isInvalid(s)) return s;
      if (!(SAMPLE_SOURCES as readonly string[]).includes(f('sampleSource'))) return invalid('noSampleSource');
      const cost = paiseOf(f('pointCost')); if (cost === undefined) return invalid('noPointCost');
      const balances = file('loyalty_balances'); if (isInvalid(balances)) return balances;
      const confirmations = file('loyalty_confirmations'); if (isInvalid(confirmations)) return confirmations;
      return { evidenceRef, ...s, source: f('sampleSource'), pointCostMinor: cost, balances, confirmations };
    }
  }
}

export function createCutoverEvidenceSession(input: { readonly viewer: ViewerIdentity | undefined; readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string }): CutoverEvidenceSession {
  const perms = new Set(input.viewer?.permissions ?? []);
  const named = input.viewer?.userId !== undefined;
  const has = (p: string): boolean => named && perms.has(p);
  const may: CutoverEvidenceMay = {
    named,
    verifyRead: has('migration.verification.read'), extraction: has('migration.extraction.record'), evidence: has('migration.evidence.record'),
    signPage: has('migration.verification.sign'), accept: has('migration.exception.accept'),
    limitsRead: has('migration.parallel.read'), limitsSet: has('migration.cutover.decide'),
    parallelRead: has('migration.parallel.read'), parallelRecord: has('migration.parallel.record'), rollback: has('migration.cutover.decide'),
  };
  const call = makeCaller({ keyPrefix: 'cutover-evidence', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const gate = (right: boolean): Invalid | undefined => (!named ? invalid('nobody') : right ? undefined : invalid('notAllowed'));
  const enc = encodeURIComponent;
  return {
    may,
    recordExtractionRun: async (d) => {
      const no = gate(may.extraction); if (no) return no;
      if (!ID.test(d.runId.trim())) return invalid('noRunId');
      if (d.operatorId.trim() === '') return invalid('noOperator');
      const sources = list(d.sources);
      return call('POST', `/v1/migration/extraction-runs/${enc(d.runId.trim())}`, {
        operatorId: d.operatorId.trim(), ...(sources.length === 0 ? {} : { sources }), ...(d.note.trim() === '' ? {} : { note: d.note.trim() }),
      });
    },
    witness: async (which, d) => {
      const no = gate(may.evidence); if (no) return no;
      const body = witnessBody(which, d); if (isInvalid(body)) return body;
      return call('POST', `/v1/migration/witness/${which}`, body);
    },
    progress: async () => gate(may.verifyRead) ?? call('GET', '/v1/migration/verification/progress'),
    page: async () => gate(may.verifyRead) ?? call('GET', '/v1/migration/verification/page'),
    signPage: async (statement) => {
      const no = gate(may.signPage); if (no) return no;
      if (statement.trim() === '') return invalid('noSignStatement');
      return call('POST', '/v1/migration/verification/signatures', { statement: statement.trim() });
    },
    accept: async (domain, reason) => {
      const no = gate(may.accept); if (no) return no;
      if (!(DATA_DOMAINS as readonly string[]).includes(domain)) return invalid('noDomain');
      if (reason.trim() === '') return invalid('noAccReason');
      // Only WHICH kind and WHY — head office takes who (the signed-in owner) and when (its own clock).
      return call('POST', '/v1/migration/acceptances', { domain, reason: reason.trim() });
    },
    limits: async () => gate(may.limitsRead) ?? call('GET', '/v1/migration/cutover/rollback-limits'),
    setLimits: async (d) => {
      const no = gate(may.limitsSet); if (no) return no;
      const body: Record<string, number | null> = {};
      for (const n of LIMIT_NAMES) {
        const v = (d[n] ?? '').trim();
        if (v === '') { body[n] = null; continue; }
        const num = n === 'controlTotalDifferenceMinor' ? paiseOf(v) : whole(v);
        if (num === undefined) return invalid('noLimit');
        body[n] = num;
      }
      return call('PUT', '/v1/migration/cutover/rollback-limits', body);
    },
    parallel: async () => gate(may.parallelRead) ?? call('GET', '/v1/migration/parallel-run'),
    booksDay: async (day) => gate(may.parallelRead) ?? (!DAY.test(day.trim()) ? invalid('noBooksDate') : call('GET', `/v1/migration/parallel-run/days/${enc(day.trim())}/books`)),
    recordBooks: async (day, reports, templates) => {
      const no = gate(may.parallelRecord); if (no) return no;
      if (!DAY.test(day.trim())) return invalid('noBooksDate');
      if (templates.length === 0) return invalid('booksFirst');
      if (reports.length === 0) return invalid('noReports');
      const body: Record<string, unknown> = {};
      for (const r of reports) {
        const spec = templates.find((t) => t.report === r.report);
        if (spec === undefined) return invalid('noReport');
        if (r.csv.trim() === '') return invalid('chooseFile');
        const mapping: Record<string, string> = {};
        for (const fld of spec.fields) {
          const col = (r.mapping[fld.key] ?? '').trim();
          if (col !== '') mapping[fld.key] = col; else if (fld.required) return invalid('noBooksColumns');
        }
        body[r.report] = { csv: r.csv, mapping, ...((DATE_ORDERS as readonly string[]).includes(r.dateOrder) ? { dateOrder: r.dateOrder } : {}) };
      }
      // No tolerance is sent: the figures are compared exactly (a tolerance would be the owner's number, never ours).
      return call('POST', `/v1/migration/parallel-run/days/${enc(day.trim())}/books`, { reports: body });
    },
    ownDifference: async (id, explanation, wrongSide) => {
      const no = gate(may.parallelRecord); if (no) return no;
      if (id.trim() === '') return invalid('noDiff');
      return call('POST', `/v1/migration/parallel-run/differences/${enc(id.trim())}/own`, {
        ...(explanation.trim() === '' ? {} : { explanation: explanation.trim() }),
        ...((WRONG_SIDES as readonly string[]).includes(wrongSide) ? { wrongSide } : {}),
      });
    },
    sheet: async () => gate(may.parallelRead) ?? call('GET', '/v1/migration/parallel-run/sheet'),
    confirmRollback: async (cutoverId, firstBill, fromLocal) => {
      const no = gate(may.rollback); if (no) return no;
      if (cutoverId.trim() === '') return invalid('noRbCutover');
      if (firstBill.trim() === '') return invalid('noBill');
      const from = shopInstantOf(fromLocal); if (from === undefined) return invalid('noTime');
      return call('POST', `/v1/migration/cutover/rollback/${enc(cutoverId.trim())}/confirmation`, { legacyFirstBillRef: firstBill.trim(), legacyTradingFrom: from });
    },
    reconcileRollback: async (cutoverId, d) => {
      const no = gate(may.rollback); if (no) return no;
      if (cutoverId.trim() === '') return invalid('noRbCutover');
      const from = shopInstantOf(d.newFromLocal); if (from === undefined) return invalid('noTime');
      const count = whole(d.count); const refunds = whole(d.refunds);
      if (count === undefined || refunds === undefined) return invalid('noCount');
      const total = paiseOf(d.total); const refundsTotal = paiseOf(d.refundsTotal);
      if (total === undefined || refundsTotal === undefined) return invalid('noMoney');
      // No stock movement in the old system is an empty list — an empty file is not a refusal here.
      const stock = d.stockCsv.trim() === '' ? [] : readEvidenceFile('rollback_stock', d.stockCsv);
      if (isInvalid(stock)) return stock;
      return call('POST', `/v1/migration/cutover/rollback/${enc(cutoverId.trim())}/reconciliation`, {
        newSystemTradingFrom: from,
        legacyCarriedBack: { count, totalMinor: total, refunds: { count: refunds, totalMinor: refundsTotal }, stockMovements: stock },
      });
    },
  };
}
