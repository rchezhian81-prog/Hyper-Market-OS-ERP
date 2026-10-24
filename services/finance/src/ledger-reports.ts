// API-09 Finance — the TRIAL BALANCE and the COST / PROFIT CENTRE REPORT (M23-FR-01 "trial balance and AP/AR reports",
// "cost/profit centre allocation", acceptance "cost-centre reports tie to the ledger" · D10-FR-01 · WF-18 · P-08).
//
// Both are reads over the posted journals through the tested engine `@sre/finance` trial-balance.ts; nothing posts, nothing
// changes. The centre report places each journal in a branch or department by the facts the journal carries (wired in
// head office's adapter: a sale's store, a stock adjustment's location, an asset's store, a line that names its centre);
// what cannot be placed is listed as unassigned with the reason, and the tie to the ledger is shown per account.
//
// OB-340 (owner, 24 Oct 2026): both also show DEPARTMENT SALES AND MARGIN — each department's sales as the ledger holds them
// (the day book carries every till line's exact net, after its discount, to its product's department), what those goods
// cost at the average buying cost (OB-39), the margin, and the tie: departments plus what no department owns equal the
// month's revenue in the ledger. A cost that is not known is said, never a zero.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { trialBalance, centreReport, departmentSales, isPeriod, type CentreAttribution, type LedgerJournal, type DepartmentCost, type DepartmentSales } from '../../../packages/finance/src/trial-balance';

export interface LedgerReportDeps {
  readonly journals: (tenantId: string) => Promise<readonly LedgerJournal[]> | readonly LedgerJournal[];
  readonly accountClasses: (tenantId: string) => Promise<Readonly<Record<string, string>> | undefined> | Readonly<Record<string, string>> | undefined;
  /** Builds, for one shop, how each journal is placed in centres (resolved once per read). */
  readonly attributor: (tenantId: string) => Promise<(journal: LedgerJournal) => CentreAttribution>;
  /** The centres head office knows (branches and departments of the organisation), with their names. */
  readonly centres: (tenantId: string) => Promise<readonly { readonly centre: string; readonly kind: string; readonly name: string }[]>;
  readonly periodState?: (tenantId: string, period: string) => Promise<string> | string;
  /**
   * OB-340: the organisation's departments, the revenue accounts (the `net` legs of the sale rules in force) and what each
   * department's goods sold in the month cost at the average buying cost. Absent: no department section.
   */
  readonly departmentFacts?: (tenantId: string, period: string, journals: readonly LedgerJournal[]) => Promise<{
    readonly departments: readonly { readonly departmentId: string; readonly name: string }[];
    readonly revenueAccounts: readonly string[];
    readonly costs: readonly DepartmentCost[];
  }>;
  readonly now: () => string;
}

/** OB-340: the month's department sales and margin, with the words a reader needs (null when the composition has none). */
async function departmentsOf(deps: LedgerReportDeps, tenantId: string, period: string, journals: readonly LedgerJournal[]): Promise<(DepartmentSales & { readonly detail: string }) | null> {
  if (deps.departmentFacts === undefined) return null;
  const facts = await deps.departmentFacts(tenantId, period, journals);
  const d = departmentSales({ period, journals, ...facts });
  const detail = d.departments.length === 0
    ? 'The organisation has no departments yet, so no sales are placed in one.'
    : d.departments.every((r) => r.salesMinor === 0)
      ? `No sale posted to ${period} is in a department yet (a department owns products through its categories; the day book places each line when it posts).`
      : d.ties ? 'The departments plus what no department owns add up to the month\'s revenue in the ledger.' : 'The departments do NOT add up to the ledger\'s revenue — a person must look.';
  return { ...d, detail };
}

const badPeriod = (period: string) => apiError(400, { code: 'bad_period', whatHappened: `'${period}' is not a month (YYYY-MM).`, wasItSaved: 'not_saved', nextSafeAction: 'Send the month as YYYY-MM.' });

export function ledgerReportRoutes(deps: LedgerReportDeps): readonly Route[] {
  return [
    {
      // The month's trial balance: every account brought forward, posted in the month and carried forward; balanced or by how much not.
      api: 'API-09', method: 'GET', path: '/v1/finance/periods/:period/trial-balance',
      permission: 'finance.period.read',
      handler: async (ctx) => {
        const period = ctx.params['period'] ?? '';
        if (!isPeriod(period)) throw badPeriod(period);
        const [journals, classes] = await Promise.all([deps.journals(ctx.tenantId), deps.accountClasses(ctx.tenantId)]);
        const tb = trialBalance(period, journals, classes ?? {});
        return {
          status: 200,
          body: {
            ...tb, classesDefined: classes !== undefined,
            departments: await departmentsOf(deps, ctx.tenantId, period, journals),
            periodState: deps.periodState === undefined ? null : await deps.periodState(ctx.tenantId, period),
            detail: tb.rows.length === 0
              ? `No journal is posted to ${period} or before it — there is no trial balance to show yet (this is not a balanced zero).`
              : tb.balanced ? `${tb.rows.length} account(s); debit and credit balances agree to the paisa.` : `The trial balance is OUT by ${tb.outByMinor} paise — a person must find the journal that does not balance.`,
            asAt: deps.now(),
          },
        };
      },
    },
    {
      // The month's centres: each branch and department's share of the books, its profit, the unassigned, and the tie to the ledger.
      api: 'API-09', method: 'GET', path: '/v1/finance/periods/:period/centres',
      permission: 'finance.period.read',
      handler: async (ctx) => {
        const period = ctx.params['period'] ?? '';
        if (!isPeriod(period)) throw badPeriod(period);
        const [journals, classes, attributionOf, centres] = await Promise.all([
          deps.journals(ctx.tenantId), deps.accountClasses(ctx.tenantId), deps.attributor(ctx.tenantId), deps.centres(ctx.tenantId),
        ]);
        const report = centreReport({ period, journals, attributionOf, classes: classes ?? {} });
        const named = new Map(centres.map((c) => [c.centre, c]));
        return {
          status: 200,
          body: {
            ...report,
            centres: report.centres.map((c) => ({ ...c, name: named.get(c.centre)?.name ?? null, kind: named.get(c.centre)?.kind ?? null, known: named.has(c.centre) })),
            classesDefined: classes !== undefined,
            departments: await departmentsOf(deps, ctx.tenantId, period, journals),
            detail: report.tie.length === 0
              ? `No journal is posted to ${period} — there is nothing to place in a centre yet.`
              : report.ties ? 'Every account\'s centres and unassigned add up to the ledger for the month.' : 'The centres do NOT add up to the ledger — a person must look.',
            asAt: deps.now(),
          },
        };
      },
    },
  ];
}
