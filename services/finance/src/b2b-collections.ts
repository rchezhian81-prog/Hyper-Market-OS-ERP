// API-09 B2B collections — structured receivables, ageing, allocation & dunning (M22-FR-04). The wired
// credit-control surface (M22-FR-01) projects a FLAT AR balance from invoice/payment deltas — right for
// a credit-limit check, but a flat balance cannot be aged or chased: dunning needs a structured invoice
// with a DUE DATE and a settled amount. So this surface records those, and runs the collections engine
// over them:
//
//   • Ageing runs from the DUE DATE, not the invoice date — an invoice on 30-day terms 40 days old is
//     10 days overdue, not 40; a report where every account on terms looks delinquent is one nobody reads.
//   • A payment is ALLOCATED to named invoices (oldest due first by default), and anything left over is
//     UNAPPLIED and visible — never netted into a balance, because an advance the shop cannot point at
//     is one the customer will ask about.
//   • A DISPUTED invoice is outstanding but never chaseable — it belongs with a person, not a letter.
//   • Dunning escalates statement → reminder → final notice → stop supply, and STOPPING SUPPLY is
//     RECOMMENDED, never automatic (P-05, §28) — date arithmetic does not get to end a relationship.
//
// The rules are the pure `ageReceivables` / `allocatePayment` / `decideDunning` in `packages/b2b`.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  ageReceivables, allocatePayment, decideDunning,
  type Receivable, type PaymentAllocation,
} from '../../../packages/b2b/src/index';

export type { Receivable, PaymentAllocation } from '../../../packages/b2b/src/index';

const isStr = (s: unknown): s is string => typeof s === 'string' && s.trim() !== '';
const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00.000Z`));
const isPosInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;
const strArray = (v: unknown): readonly string[] | undefined =>
  v === undefined ? [] : Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;

/** A recorded payment and the allocations it was split into — enough to project each invoice's settled. */
export interface RecordedPayment {
  readonly receiptId: string;
  readonly receivedMinor: number;
  readonly allocations: readonly PaymentAllocation[];
}

export interface B2BCollectionsDeps {
  /** Invoices with `settledMinor` PROJECTED from the recorded allocations — never stored (#2). */
  readonly invoices: (tenantId: string, customerId: string) => Promise<readonly Receivable[]> | readonly Receivable[];
  readonly recordInvoice: (tenantId: string, customerId: string, invoice: Receivable) => Promise<void> | void;
  readonly recordPayment: (tenantId: string, customerId: string, payment: RecordedPayment) => Promise<void> | void;
  readonly now: () => string;
}

export function b2bCollectionsRoutes(deps: B2BCollectionsDeps): readonly Route[] {
  return [
    {
      // Record a structured receivable invoice — number, terms (issued/due) and gross. Ageing needs these.
      api: 'API-09', method: 'POST', path: '/v1/b2b/collections/:customerId/invoices/:invoiceId',
      permission: 'b2b.receivable.record', idempotent: true,
      handler: async (ctx) => {
        const customerId = ctx.params['customerId'] ?? '';
        const invoiceId = ctx.params['invoiceId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isStr(b['number']) || !isDate(b['issuedOn']) || !isDate(b['dueOn']) || !isPosInt(b['grossMinor'])
          || (b['disputed'] !== undefined && typeof b['disputed'] !== 'boolean')
          || (b['disputeReason'] !== undefined && !isStr(b['disputeReason']))) {
          throw apiError(400, {
            code: 'not_readable_as_an_invoice',
            whatHappened: 'A receivable invoice needs a number, an issue date, a due date and a gross amount in minor units.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the invoice fields. Nothing was recorded.',
          });
        }
        const invoice: Receivable = {
          invoiceId, number: b['number'] as string, customerId, tenantId: ctx.tenantId,
          issuedOn: b['issuedOn'] as string, dueOn: b['dueOn'] as string, grossMinor: b['grossMinor'] as number, settledMinor: 0,
          ...(b['disputed'] === true ? { disputed: true } : {}),
          ...(isStr(b['disputeReason']) ? { disputeReason: b['disputeReason'] } : {}),
        };
        await deps.recordInvoice(ctx.tenantId, customerId, invoice);
        return { status: 201, body: { invoiceId, number: invoice.number, dueOn: invoice.dueOn, grossMinor: invoice.grossMinor } };
      },
    },
    {
      // Allocate a received payment to invoices — named first, then oldest due; the remainder is held
      // UNAPPLIED and visible, never netted into a balance.
      api: 'API-09', method: 'POST', path: '/v1/b2b/collections/:customerId/payments/:receiptId',
      permission: 'b2b.receivable.record', idempotent: true,
      handler: async (ctx) => {
        const customerId = ctx.params['customerId'] ?? '';
        const receiptId = ctx.params['receiptId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const against = strArray(b['against']);
        if (!isPosInt(b['receivedMinor']) || against === undefined) {
          throw apiError(400, { code: 'not_readable_as_a_payment', whatHappened: 'A payment needs a received amount in minor units, and an optional list of invoice ids to pay first.', wasItSaved: 'not_saved', nextSafeAction: 'Send { "receivedMinor": <int> }. Nothing was recorded.' });
        }
        const result = allocatePayment({
          receiptId, customerId, receivedMinor: b['receivedMinor'] as number,
          invoices: await deps.invoices(ctx.tenantId, customerId), against,
        });
        await deps.recordPayment(ctx.tenantId, customerId, { receiptId, receivedMinor: result.receivedMinor, allocations: result.allocations });
        return { status: 201, body: { receiptId, allocatedMinor: result.allocatedMinor, unappliedMinor: result.unappliedMinor, allocations: result.allocations } };
      },
    },
    {
      // The ageing report — from the DUE DATE, with a chaseable figure that excludes disputes.
      api: 'API-09', method: 'GET', path: '/v1/b2b/collections/:customerId/ageing',
      permission: 'b2b.account.read',
      handler: async (ctx) => {
        const customerId = ctx.params['customerId'] ?? '';
        const asAt = ctx.query['asOf'];
        if (!isDate(asAt)) throw apiError(400, { code: 'ageing_needs_a_date', whatHappened: 'The ageing report needs ?asOf=YYYY-MM-DD to age against.', wasItSaved: 'not_saved', nextSafeAction: 'Send the date. A report reads, it never writes.' });
        const invoices = await deps.invoices(ctx.tenantId, customerId);
        if (invoices.length === 0) throw notFound(`b2b customer ${customerId} receivables`);
        return { status: 200, body: ageReceivables({ customerId, invoices, asAt }) };
      },
    },
    {
      // The dunning step — and stopping supply is RECOMMENDED, never automatic (needsHuman).
      api: 'API-09', method: 'GET', path: '/v1/b2b/collections/:customerId/dunning',
      permission: 'b2b.account.read',
      handler: async (ctx) => {
        const customerId = ctx.params['customerId'] ?? '';
        const asAt = ctx.query['asOf'];
        if (!isDate(asAt)) throw apiError(400, { code: 'dunning_needs_a_date', whatHappened: 'A dunning decision needs ?asOf=YYYY-MM-DD.', wasItSaved: 'not_saved', nextSafeAction: 'Send the date. A decision reads, it never writes.' });
        const invoices = await deps.invoices(ctx.tenantId, customerId);
        if (invoices.length === 0) throw notFound(`b2b customer ${customerId} receivables`);
        const ageing = ageReceivables({ customerId, invoices, asAt });
        return { status: 200, body: decideDunning({ ageing }) };
      },
    },
  ];
}
