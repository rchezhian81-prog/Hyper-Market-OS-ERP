// API-09 Finance — the TRIAL BALANCE and the COST / PROFIT CENTRE REPORT (M23-FR-01 "trial balance and AP/AR reports",
// "cost/profit centre allocation", acceptance "cost-centre reports tie to the ledger" · D10-FR-01 · WF-18 · P-08).
//
// Both are reads over the posted journals through the tested engine `@sre/finance` trial-balance.ts; nothing posts, nothing
// changes. The centre report places each journal in a branch or department by the facts the journal carries (wired in
// head office's adapter: a sale's store, a stock adjustment's location, an asset's store, a line that names its centre);
// what cannot be placed is listed as unassigned with the reason, and the tie to the ledger is shown per account.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { trialBalance, centreReport, isPeriod, type CentreAttribution, type LedgerJournal } from '../../../packages/finance/src/trial-balance';

export interface LedgerReportDeps {
  readonly journals: (tenantId: string) => Promise<readonly LedgerJournal[]> | readonly LedgerJournal[];
  readonly accountClasses: (tenantId: string) => Promise<Readonly<Record<string, string>> | undefined> | Readonly<Record<string, string>> | undefined;
  /** Builds, for one shop, how each journal is placed in centres (resolved once per read). */
  readonly attributor: (tenantId: string) => Promise<(journal: LedgerJournal) => CentreAttribution>;
  /** The centres head office knows (branches and departments of the organisation), with their names. */
  readonly centres: (tenantId: string) => Promise<readonly { readonly centre: string; readonly kind: string; readonly name: string }[]>;
  readonly periodState?: (tenantId: string, period: string) => Promise<string> | string;
  readonly now: () => string;
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
