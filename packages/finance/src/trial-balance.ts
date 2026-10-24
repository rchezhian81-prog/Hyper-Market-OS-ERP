// M23-FR-01 "trial balance and AP/AR reports … cost/profit centre allocation … cost-centre reports tie to the ledger" —
// the trial balance and the centre report, both read straight off the posted journals. Pure and deterministic: whole paise,
// no clock, no I/O, no floating point.
//
//   • TRIAL BALANCE. Every account the ledger holds: its balance brought forward (every journal posted to an EARLIER
//     month), what the month posted (debits and credits), and the balance carried forward. Debit balances and credit
//     balances must be equal; when they are not, the report says by how much (P-08) — it never balances itself.
//   • CENTRE REPORT. Each journal of the month is attributed to centres (a branch or a department of the organisation) by
//     the facts the journal itself carries: a line that names its centre keeps it; a journal its sources place in one
//     centre goes there whole; a journal whose sources span centres is shared by the sources' own amounts, the paise split
//     by largest remainder so nothing is lost or made. Anything that cannot be placed is UNASSIGNED, listed with why — never
//     dropped and never guessed. The report TIES: for every account, the centres plus unassigned equal the month's posting
//     in the ledger, and the tie is computed and shown, not assumed.

export interface LedgerLine {
  readonly accountCode: string;
  readonly debitMinor: number;
  readonly creditMinor: number;
  /** A centre the posting route named for this line (a branch or department id), when it knew one. */
  readonly centre?: string;
}

export interface LedgerJournal {
  readonly entryId: string;
  readonly period: string;
  readonly lines: readonly LedgerLine[];
}

export interface TrialBalanceRow {
  readonly account: string;
  /** The accountant's class for it, or null when none is set (said, never guessed). */
  readonly accountClass: string | null;
  /** Debit less credit brought forward from every earlier month. */
  readonly openingNetDebitMinor: number;
  readonly periodDebitMinor: number;
  readonly periodCreditMinor: number;
  /** Debit less credit carried forward. Positive: a debit balance; negative: a credit balance. */
  readonly closingNetDebitMinor: number;
}

export interface TrialBalance {
  readonly period: string;
  readonly rows: readonly TrialBalanceRow[];
  readonly totals: {
    readonly periodDebitMinor: number;
    readonly periodCreditMinor: number;
    /** Sum of the debit balances carried forward. */
    readonly closingDebitMinor: number;
    /** Sum of the credit balances carried forward (as a positive figure). */
    readonly closingCreditMinor: number;
  };
  /** True only when debit balances equal credit balances AND the month's debits equal its credits. */
  readonly balanced: boolean;
  /** How far it is out, when it is (closing debits less closing credits). */
  readonly outByMinor: number;
  readonly journalsInPeriod: number;
  readonly journalsBroughtForward: number;
  /** Accounts with no class — listed so the reader knows what the classes do not yet cover. */
  readonly unclassified: readonly string[];
}

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
export const isPeriod = (v: unknown): v is string => typeof v === 'string' && PERIOD.test(v);

/** The trial balance of a month from every journal on the ledger. Journals of LATER months are not read into it. */
export function trialBalance(period: string, journals: readonly LedgerJournal[], classes: Readonly<Record<string, string>> = {}): TrialBalance {
  const open = new Map<string, number>();
  const dr = new Map<string, number>();
  const cr = new Map<string, number>();
  let inPeriod = 0;
  let before = 0;
  for (const j of journals) {
    if (j.period < period) {
      before += 1;
      for (const l of j.lines) open.set(l.accountCode, (open.get(l.accountCode) ?? 0) + l.debitMinor - l.creditMinor);
    } else if (j.period === period) {
      inPeriod += 1;
      for (const l of j.lines) {
        dr.set(l.accountCode, (dr.get(l.accountCode) ?? 0) + l.debitMinor);
        cr.set(l.accountCode, (cr.get(l.accountCode) ?? 0) + l.creditMinor);
      }
    }
  }
  const accounts = [...new Set([...open.keys(), ...dr.keys(), ...cr.keys()])].sort();
  const rows: TrialBalanceRow[] = accounts.map((account) => {
    const o = open.get(account) ?? 0;
    const d = dr.get(account) ?? 0;
    const c = cr.get(account) ?? 0;
    return { account, accountClass: classes[account] ?? null, openingNetDebitMinor: o, periodDebitMinor: d, periodCreditMinor: c, closingNetDebitMinor: o + d - c };
  }).filter((r) => r.openingNetDebitMinor !== 0 || r.periodDebitMinor !== 0 || r.periodCreditMinor !== 0);
  const periodDebitMinor = rows.reduce((s, r) => s + r.periodDebitMinor, 0);
  const periodCreditMinor = rows.reduce((s, r) => s + r.periodCreditMinor, 0);
  const closingDebitMinor = rows.reduce((s, r) => s + Math.max(0, r.closingNetDebitMinor), 0);
  const closingCreditMinor = rows.reduce((s, r) => s + Math.max(0, -r.closingNetDebitMinor), 0);
  return {
    period, rows,
    totals: { periodDebitMinor, periodCreditMinor, closingDebitMinor, closingCreditMinor },
    balanced: closingDebitMinor === closingCreditMinor && periodDebitMinor === periodCreditMinor,
    outByMinor: closingDebitMinor - closingCreditMinor,
    journalsInPeriod: inPeriod, journalsBroughtForward: before,
    unclassified: rows.filter((r) => r.accountClass === null).map((r) => r.account),
  };
}

// ── The centre report ─────────────────────────────────────────────────────────────────────────────────────────────

/** How one journal is placed in centres, from its own facts. */
export type CentreAttribution =
  | { readonly kind: 'whole'; readonly centre: string; readonly basis: string }
  | { readonly kind: 'shared'; readonly shares: readonly { readonly centre: string; readonly weightMinor: number }[]; readonly basis: string }
  | { readonly kind: 'unassigned'; readonly reason: string };

/** Split whole paise by weights, exactly: floors first, then the largest remainders (ties by centre id) take a paisa each. */
export function splitByWeights(amountMinor: number, shares: readonly { readonly centre: string; readonly weightMinor: number }[]): ReadonlyMap<string, number> {
  // BigInt inside: a crore of paise times a crore of weight is past what a double holds exactly.
  const total = shares.reduce((s, x) => s + BigInt(Math.max(0, x.weightMinor)), 0n);
  const out = new Map<string, number>();
  if (amountMinor === 0 || total <= 0n) return out;
  const amount = BigInt(amountMinor);
  const parts = shares.map((s) => {
    const exact = amount * BigInt(Math.max(0, s.weightMinor));
    const floor = exact / total;
    return { centre: s.centre, floor, rem: exact - floor * total };
  });
  let left = amount - parts.reduce((s, p) => s + p.floor, 0n);
  const order = [...parts].sort((a, b) => (b.rem > a.rem ? 1 : b.rem < a.rem ? -1 : a.centre.localeCompare(b.centre)));
  for (const p of order) {
    if (left <= 0n) break;
    p.floor += 1n;
    left -= 1n;
  }
  for (const p of parts) out.set(p.centre, (out.get(p.centre) ?? 0) + Number(p.floor));
  return out;
}

export interface CentreAccountLine {
  readonly account: string;
  readonly debitMinor: number;
  readonly creditMinor: number;
}

export interface CentreSection {
  readonly centre: string;
  readonly accounts: readonly CentreAccountLine[];
  /** By the accountant's classes: income less expenses placed in this centre — its profit (negative: a loss). */
  readonly incomeMinor: number;
  readonly expenseMinor: number;
  readonly profitMinor: number;
  readonly journals: number;
}

export interface CentreReport {
  readonly period: string;
  readonly centres: readonly CentreSection[];
  readonly unassigned: {
    readonly accounts: readonly CentreAccountLine[];
    readonly journals: readonly { readonly entryId: string; readonly reason: string }[];
  };
  /** Per account: the centres plus unassigned against the ledger's posting for the month. `ties` is every account agreeing. */
  readonly tie: readonly { readonly account: string; readonly ledgerDebitMinor: number; readonly ledgerCreditMinor: number; readonly centresDebitMinor: number; readonly centresCreditMinor: number }[];
  readonly ties: boolean;
  /** The share of the month's debits that is placed in a centre (basis points), so "how much is attributed" is a figure. */
  readonly attributedBps: number | null;
}

/** The centre report of a month. `attributionOf` places each journal; a line that names its own centre overrides it. */
export function centreReport(input: {
  readonly period: string;
  readonly journals: readonly LedgerJournal[];
  readonly attributionOf: (journal: LedgerJournal) => CentreAttribution;
  readonly classes?: Readonly<Record<string, string>>;
}): CentreReport {
  const classes = input.classes ?? {};
  const UNASSIGNED = '\u0000unassigned';
  const cells = new Map<string, Map<string, { debitMinor: number; creditMinor: number }>>();
  const journalsIn = new Map<string, Set<string>>();
  const unassignedJournals: { entryId: string; reason: string }[] = [];
  const ledger = new Map<string, { debitMinor: number; creditMinor: number }>();
  const put = (centre: string, account: string, debit: number, credit: number, entryId: string): void => {
    if (debit === 0 && credit === 0) return;
    const byAccount = cells.get(centre) ?? new Map<string, { debitMinor: number; creditMinor: number }>();
    const cur = byAccount.get(account) ?? { debitMinor: 0, creditMinor: 0 };
    byAccount.set(account, { debitMinor: cur.debitMinor + debit, creditMinor: cur.creditMinor + credit });
    cells.set(centre, byAccount);
    const js = journalsIn.get(centre) ?? new Set<string>();
    js.add(entryId);
    journalsIn.set(centre, js);
  };
  for (const j of input.journals) {
    if (j.period !== input.period) continue;
    const attribution = input.attributionOf(j);
    let anyUnassigned = false;
    for (const l of j.lines) {
      const led = ledger.get(l.accountCode) ?? { debitMinor: 0, creditMinor: 0 };
      ledger.set(l.accountCode, { debitMinor: led.debitMinor + l.debitMinor, creditMinor: led.creditMinor + l.creditMinor });
      const named = (l.centre ?? '').trim();
      if (named !== '') { put(named, l.accountCode, l.debitMinor, l.creditMinor, j.entryId); continue; }
      if (attribution.kind === 'whole') { put(attribution.centre, l.accountCode, l.debitMinor, l.creditMinor, j.entryId); continue; }
      if (attribution.kind === 'shared') {
        const d = splitByWeights(l.debitMinor, attribution.shares);
        const c = splitByWeights(l.creditMinor, attribution.shares);
        for (const centre of new Set([...d.keys(), ...c.keys()])) put(centre, l.accountCode, d.get(centre) ?? 0, c.get(centre) ?? 0, j.entryId);
        continue;
      }
      anyUnassigned = true;
      put(UNASSIGNED, l.accountCode, l.debitMinor, l.creditMinor, j.entryId);
    }
    if (anyUnassigned && attribution.kind === 'unassigned') unassignedJournals.push({ entryId: j.entryId, reason: attribution.reason });
  }
  const linesOf = (centre: string): CentreAccountLine[] =>
    [...(cells.get(centre) ?? new Map()).entries()].sort(([a], [b]) => a.localeCompare(b)).map(([account, v]) => ({ account, ...v }));
  const sections: CentreSection[] = [...cells.keys()].filter((c) => c !== UNASSIGNED).sort().map((centre) => {
    const accounts = linesOf(centre);
    const incomeMinor = accounts.filter((a) => classes[a.account] === 'income').reduce((s, a) => s + a.creditMinor - a.debitMinor, 0);
    const expenseMinor = accounts.filter((a) => classes[a.account] === 'expense').reduce((s, a) => s + a.debitMinor - a.creditMinor, 0);
    return { centre, accounts, incomeMinor, expenseMinor, profitMinor: incomeMinor - expenseMinor, journals: journalsIn.get(centre)?.size ?? 0 };
  });
  const tie = [...ledger.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([account, led]) => {
    let d = 0;
    let c = 0;
    for (const byAccount of cells.values()) {
      const v = byAccount.get(account);
      if (v !== undefined) { d += v.debitMinor; c += v.creditMinor; }
    }
    return { account, ledgerDebitMinor: led.debitMinor, ledgerCreditMinor: led.creditMinor, centresDebitMinor: d, centresCreditMinor: c };
  });
  const totalDebit = tie.reduce((s, t) => s + t.ledgerDebitMinor, 0);
  const unassignedDebit = linesOf(UNASSIGNED).reduce((s, a) => s + a.debitMinor, 0);
  return {
    period: input.period,
    centres: sections,
    unassigned: { accounts: linesOf(UNASSIGNED), journals: unassignedJournals },
    tie,
    ties: tie.every((t) => t.ledgerDebitMinor === t.centresDebitMinor && t.ledgerCreditMinor === t.centresCreditMinor),
    attributedBps: totalDebit === 0 ? null : Math.round(((totalDebit - unassignedDebit) * 10_000) / totalDebit),
  };
}

// ── OB-340 — department sales and margin, tied to the ledger ─────────────────────────────────────────────────────────

/** What one department's sold goods cost at the average buying cost (OB-39), worked out by head office from the sold lines. */
export interface DepartmentCost {
  readonly departmentId: string;
  /** Goods sold less goods back, each at its average buying cost; null when any of them has no cost (never a zero). */
  readonly costMinor: number | null;
  /** The products sold in the department with no average buying cost — why the cost is not known. */
  readonly notCosted: readonly string[];
}

export interface DepartmentSalesRow {
  readonly departmentId: string;
  readonly name: string | null;
  /** Credits less debits on the revenue accounts on lines that name this department — the ledger's own figure. */
  readonly salesMinor: number;
  readonly costMinor: number | null;
  /** Sales less cost, only when the cost is known (P-08: never a margin on a guessed cost). */
  readonly marginMinor: number | null;
  /** Margin as basis points of sales; null when either is not known or sales are zero. */
  readonly marginBps: number | null;
  readonly notCosted: readonly string[];
  readonly journals: number;
}

export interface DepartmentSales {
  readonly period: string;
  /** The accounts revenue posts to (the `net` legs of the sale and sale-return rules in the mapping in force). */
  readonly revenueAccounts: readonly string[];
  readonly departments: readonly DepartmentSalesRow[];
  /** Revenue on lines that name no department — products no department owns, and every journal that is not a till sale. */
  readonly notInADepartmentMinor: number;
  /** The month's revenue as the ledger holds it: credits less debits on the revenue accounts across every journal. */
  readonly ledgerRevenueMinor: number;
  /** Departments plus not-in-a-department equal the ledger — computed and shown, never assumed. */
  readonly ties: boolean;
  /** Returns whose net could not be told apart by department (left with the store), by id. */
  readonly departmentNotKnown: readonly string[];
}

/**
 * OB-340 (owner, 24 Oct 2026): each department's sales for a month straight off the posted journals — the day book carries
 * every sale and sale-return line's exact net to its product's department, as a revenue line naming the department — and
 * its margin against what its goods cost at the average buying cost (OB-39, the profitability report's rule). Pure.
 * With no revenue account given (no mapping yet), the accounts are those the department lines themselves were posted to.
 */
export function departmentSales(input: {
  readonly period: string;
  readonly journals: readonly (LedgerJournal & { readonly dayBook?: { readonly departmentNotKnown?: readonly string[] } })[];
  readonly departments: readonly { readonly departmentId: string; readonly name: string }[];
  readonly revenueAccounts: readonly string[];
  readonly costs?: readonly DepartmentCost[];
}): DepartmentSales {
  const ids = new Set(input.departments.map((d) => d.departmentId));
  const inMonth = input.journals.filter((j) => j.period === input.period);
  const accounts = new Set(input.revenueAccounts);
  if (accounts.size === 0) {
    for (const j of inMonth) for (const l of j.lines) if (l.centre !== undefined && ids.has(l.centre) && j.dayBook !== undefined) accounts.add(l.accountCode);
  }
  const sales = new Map<string, number>();
  const journalsOf = new Map<string, Set<string>>();
  let notIn = 0;
  let ledger = 0;
  const notKnown: string[] = [];
  for (const j of inMonth) {
    for (const id of j.dayBook?.departmentNotKnown ?? []) notKnown.push(id);
    for (const l of j.lines) {
      if (!accounts.has(l.accountCode)) continue;
      const v = l.creditMinor - l.debitMinor;
      ledger += v;
      const d = l.centre !== undefined && ids.has(l.centre) ? l.centre : undefined;
      if (d === undefined) { notIn += v; continue; }
      sales.set(d, (sales.get(d) ?? 0) + v);
      const js = journalsOf.get(d) ?? new Set<string>();
      js.add(j.entryId);
      journalsOf.set(d, js);
    }
  }
  const costOf = new Map((input.costs ?? []).map((c) => [c.departmentId, c] as const));
  const rows = input.departments.map((d): DepartmentSalesRow => {
    const salesMinor = sales.get(d.departmentId) ?? 0;
    const c = costOf.get(d.departmentId);
    // A department that sold nothing cost nothing; one that sold with no worked-out cost is "not known", never zero.
    const costMinor = c === undefined ? (salesMinor === 0 ? 0 : null) : c.costMinor;
    const marginMinor = costMinor === null ? null : salesMinor - costMinor;
    return {
      departmentId: d.departmentId, name: d.name, salesMinor, costMinor, marginMinor,
      marginBps: marginMinor === null || salesMinor === 0 ? null : Math.round((marginMinor * 10_000) / salesMinor),
      notCosted: c?.notCosted ?? [], journals: journalsOf.get(d.departmentId)?.size ?? 0,
    };
  }).sort((a, b) => a.departmentId.localeCompare(b.departmentId));
  const inDepartments = rows.reduce((s, r) => s + r.salesMinor, 0);
  return {
    period: input.period, revenueAccounts: [...accounts].sort(), departments: rows,
    notInADepartmentMinor: notIn, ledgerRevenueMinor: ledger, ties: inDepartments + notIn === ledger,
    departmentNotKnown: [...new Set(notKnown)].sort(),
  };
}
