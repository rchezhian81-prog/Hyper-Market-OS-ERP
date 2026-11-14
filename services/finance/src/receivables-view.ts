// API-09 Finance — the RECEIVABLES VIEW across every credit customer (U6 · M23-FR-01 "manage payable/receivable" · acceptance
// "AP/AR reconciles to purchase/sales" · QG-07 · P-08; UI/UX gap audit lane 3: "Finance · AP/AR — no payables/receivables
// account screen"; `docs/design/screens/finance.md` SP-9: "no screen shows the account").
//
// The per-customer engines exist (`packages/b2b`: `ageReceivables` from the DUE date, `reconcileAr` of the collections
// figure against the finance ledger's) and the month-end check sums them. No read put them side by side for the
// accountant to look at. This one does, for every credit customer with any movement on their account: the collections
// register's outstanding (what the customer is asked for) beside the finance ledger's outstanding (what the books hold),
// two figures reached two different ways, the difference ALWAYS visible — a customer whose two figures differ sorts first.
// A read only: nothing is written; the payables half of the screen is `GET /v1/finance/payables`.

import type { Route } from '../../kernel/src/index';
import { ageReceivables, reconcileAr, type Receivable, type AgeingReport } from '../../../packages/b2b/src/index';
import { shopClock, type ShopCalendarOf } from '../../../packages/calendar/src/shop-clock';
import { tradingDayIn } from '../../../packages/calendar/src/trading-day';

export interface CustomerReceivablesRow {
  readonly customerId: string;
  /** The collections register: every open invoice's outstanding, aged from its due date. */
  readonly outstandingMinor: number;
  /** The finance ledger's outstanding for the customer — the credit check's own balance (M22-FR-01). */
  readonly financeOutstandingMinor: number;
  readonly differenceMinor: number;
  readonly agrees: boolean;
  readonly overdueMinor: number;
  readonly disputedMinor: number;
  readonly chaseableMinor: number;
  readonly buckets: AgeingReport['buckets'];
  readonly invoices: number;
  readonly detail: string;
}

export interface ReceivablesView {
  readonly asAt: string;
  readonly customers: readonly CustomerReceivablesRow[];
  readonly totals: {
    readonly customers: number; readonly differing: number;
    readonly outstandingMinor: number; readonly financeOutstandingMinor: number; readonly differenceMinor: number;
    readonly overdueMinor: number; readonly disputedMinor: number; readonly chaseableMinor: number;
  };
  /** null when there is no credit customer — nothing was compared, which is not "agrees". */
  readonly agrees: boolean | null;
}

export const RECEIVABLES_LEFT_DERIVATION = 'the collections register: every open invoice of each credit customer, aged from its due date, less what the recorded payments were allocated to';
export const RECEIVABLES_RIGHT_DERIVATION = 'the finance ledger: the outstanding balance projected from every invoice, collection and hand-keyed movement on the customer\'s own receivables account';

/** Every credit customer's two figures side by side, the differing ones first, then the largest outstanding. Pure. */
export function receivablesView(input: {
  readonly asAt: string;
  readonly customers: readonly { readonly customerId: string; readonly invoices: readonly Receivable[]; readonly financeOutstandingMinor: number }[];
}): ReceivablesView {
  const rows: CustomerReceivablesRow[] = input.customers.map((c) => {
    const ageing = ageReceivables({ customerId: c.customerId, invoices: c.invoices, asAt: input.asAt });
    const rec = reconcileAr({ customerId: c.customerId, ageing, financeOutstandingMinor: c.financeOutstandingMinor });
    return {
      customerId: c.customerId, outstandingMinor: rec.portalOutstandingMinor, financeOutstandingMinor: rec.financeOutstandingMinor,
      differenceMinor: rec.differenceMinor, agrees: rec.agrees, overdueMinor: ageing.overdueMinor, disputedMinor: ageing.disputedMinor,
      chaseableMinor: ageing.chaseableMinor, buckets: ageing.buckets, invoices: c.invoices.length, detail: rec.detail,
    };
  }).sort((a, b) => Number(a.agrees) - Number(b.agrees) || Math.abs(b.differenceMinor) - Math.abs(a.differenceMinor) || b.outstandingMinor - a.outstandingMinor || a.customerId.localeCompare(b.customerId));
  const sum = (f: (r: CustomerReceivablesRow) => number): number => rows.reduce((n, r) => n + f(r), 0);
  return {
    asAt: input.asAt, customers: rows,
    totals: {
      customers: rows.length, differing: rows.filter((r) => !r.agrees).length,
      outstandingMinor: sum((r) => r.outstandingMinor), financeOutstandingMinor: sum((r) => r.financeOutstandingMinor), differenceMinor: sum((r) => r.differenceMinor),
      overdueMinor: sum((r) => r.overdueMinor), disputedMinor: sum((r) => r.disputedMinor), chaseableMinor: sum((r) => r.chaseableMinor),
    },
    agrees: rows.length === 0 ? null : rows.every((r) => r.agrees),
  };
}

export interface ReceivablesViewDeps {
  /** Every credit customer with any movement on their receivables account (OB-408's index). */
  readonly customers: (tenantId: string) => Promise<readonly string[]>;
  readonly invoices: (tenantId: string, customerId: string) => Promise<readonly Receivable[]> | readonly Receivable[];
  readonly outstandingMinor: (tenantId: string, customerId: string) => Promise<number> | number;
  readonly calendar?: ShopCalendarOf;
  readonly now: () => string;
}

export function receivablesViewRoutes(deps: ReceivablesViewDeps): readonly Route[] {
  return [
    {
      // Every credit customer's receivables beside the ledger's figure, as at the shop's day. Reads only.
      api: 'API-09', method: 'GET', path: '/v1/finance/receivables',
      permission: 'finance.period.read',
      handler: async (ctx) => {
        const t = ctx.tenantId;
        const asAt = tradingDayIn(deps.now(), await shopClock(deps.calendar).calendar(t));
        const ids = await deps.customers(t);
        const customers = await Promise.all(ids.map(async (customerId) => ({
          customerId, invoices: await deps.invoices(t, customerId), financeOutstandingMinor: await deps.outstandingMinor(t, customerId),
        })));
        const view = receivablesView({ asAt, customers });
        return { status: 200, body: { ...view, leftDerivation: RECEIVABLES_LEFT_DERIVATION, rightDerivation: RECEIVABLES_RIGHT_DERIVATION, readAt: deps.now() } };
      },
    },
  ];
}
