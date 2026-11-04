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
//   • OB-686 (owner, 3 Nov 2026): the chasing steps are the OWNER's — the smallest amount worth chasing and the three day
//     counts (GET/POST /v1/b2b/collections/chasing-steps). The programmers' ₹500 and 7 / 60 / 90 days are gone: until he
//     sets his own, the dunning read says "not set by the owner" and gives NO step.
//
// The rules are the pure `ageReceivables` / `allocatePayment` / `decideDunning` in `packages/b2b`.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/audit-trail';
import {
  ageReceivables, allocatePayment, decideDunning, reconcileAr, dunningStepsProblem,
  type Receivable, type PaymentAllocation, type DunningSteps,
} from '../../../packages/b2b/src/index';
import { shopToday, type ShopCalendarOf } from '../../../packages/calendar/src/shop-clock';

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

/** The owner's chasing steps as recorded — who set them and when (append-only; the newest applies). */
export interface ChasingStepsSetting extends DunningSteps {
  readonly setBy: string;
  readonly setAt: string;
}

/** What a reader is told when the owner has set no chasing steps. */
export const CHASING_STEPS_NOT_SET = 'The chasing steps are not set by the owner — no reminder, final notice or stop-supply step is given until he sets the smallest amount worth chasing and the three day counts.';

export interface B2BCollectionsDeps {
  /** OB-686: the owner's chasing steps (latest), or undefined when he has set none. */
  readonly chasingSteps?: (tenantId: string) => Promise<ChasingStepsSetting | undefined> | ChasingStepsSetting | undefined;
  readonly recordChasingSteps?: (tenantId: string, setting: ChasingStepsSetting) => Promise<void> | void;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  /** R1c (M01-FR-02): the shop's calendar — "today" is the shop's date, never the UTC one. */
  readonly calendar?: ShopCalendarOf;
  /** Invoices with `settledMinor` PROJECTED from the recorded allocations — never stored (#2). */
  readonly invoices: (tenantId: string, customerId: string) => Promise<readonly Receivable[]> | readonly Receivable[];
  /** The finance AR balance for this customer, PROJECTED from the receivable-movement ledger the
   *  credit surface writes (M22-FR-01) — the independent second figure `reconcileAr` compares the
   *  collections ageing against. Same customer stream, so it is the very balance the credit check uses. */
  readonly outstandingMinor: (tenantId: string, customerId: string) => Promise<number> | number;
  /** With `openingLoadId` (a migration load opening a carried-over invoice), the load's opening-item register entry is written
   *  in the SAME atomic write. */
  readonly recordInvoice: (tenantId: string, customerId: string, invoice: Receivable, openingLoadId?: string) => Promise<void> | void;
  readonly recordPayment: (tenantId: string, customerId: string, payment: RecordedPayment) => Promise<void> | void;
  /** FUL-09: the money received moves the customer's AR ledger and reaches the books — in ONE write with the allocation.
   *  When present it records the payment itself (instead of `recordPayment`). */
  readonly recordPaymentWithMoney?: (tenantId: string, customerId: string, payment: RecordedPayment, receivedOn: string) => Promise<void>;
  readonly now: () => string;
}

export function b2bCollectionsRoutes(deps: B2BCollectionsDeps): readonly Route[] {
  return [
    {
      // Record a structured receivable invoice — number, terms (issued/due) and gross. Ageing needs these.
      api: 'API-09', method: 'POST', path: '/v1/b2b/collections/:customerId/invoices/:invoiceId',
      permission: 'b2b.receivable.record', idempotent: true,
      entitlement: 'b2b',
      handler: async (ctx) => {
        const customerId = ctx.params['customerId'] ?? '';
        const invoiceId = ctx.params['invoiceId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isStr(b['number']) || !isDate(b['issuedOn']) || !isDate(b['dueOn']) || !isPosInt(b['grossMinor'])
          || (b['disputed'] !== undefined && typeof b['disputed'] !== 'boolean')
          || (b['disputeReason'] !== undefined && !isStr(b['disputeReason']))
          || (b['openingLoadId'] !== undefined && !isStr(b['openingLoadId']))) {
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
        const openingLoadId = isStr(b['openingLoadId']) ? b['openingLoadId'].trim() : undefined;
        if (openingLoadId !== undefined) {
          // A load opens an invoice; it never adopts one already on the ledger (an identical re-send is the same opening).
          const held = (await deps.invoices(ctx.tenantId, customerId)).find((i) => i.invoiceId === invoiceId);
          if (held !== undefined && (held.grossMinor !== invoice.grossMinor || held.dueOn !== invoice.dueOn || held.number !== invoice.number || held.settledMinor !== 0)) {
            throw apiError(409, { code: 'invoice_already_on_the_ledger', whatHappened: `Invoice ${invoiceId} of ${customerId} is already on the receivables ledger, so load ${openingLoadId} cannot open it.`, wasItSaved: 'not_saved', nextSafeAction: 'Leave it out of the load, or correct the extract. Nothing was recorded.' });
          }
        }
        await deps.recordInvoice(ctx.tenantId, customerId, invoice, openingLoadId);
        return { status: 201, body: { invoiceId, number: invoice.number, dueOn: invoice.dueOn, grossMinor: invoice.grossMinor } };
      },
    },
    {
      // Allocate a received payment to invoices — named first, then oldest due; the remainder is held
      // UNAPPLIED and visible, never netted into a balance.
      api: 'API-09', method: 'POST', path: '/v1/b2b/collections/:customerId/payments/:receiptId',
      permission: 'b2b.receivable.record', idempotent: true,
      entitlement: 'b2b',
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
        const payment: RecordedPayment = { receiptId, receivedMinor: result.receivedMinor, allocations: result.allocations };
        if (deps.recordPaymentWithMoney !== undefined) await deps.recordPaymentWithMoney(ctx.tenantId, customerId, payment, await shopToday(deps, ctx.tenantId));
        else await deps.recordPayment(ctx.tenantId, customerId, payment);
        return { status: 201, body: { receiptId, allocatedMinor: result.allocatedMinor, unappliedMinor: result.unappliedMinor, allocations: result.allocations } };
      },
    },
    {
      // The ageing report — from the DUE DATE, with a chaseable figure that excludes disputes.
      api: 'API-09', method: 'GET', path: '/v1/b2b/collections/:customerId/ageing',
      permission: 'b2b.account.read',
      entitlement: 'b2b',
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
      entitlement: 'b2b',
      handler: async (ctx) => {
        const customerId = ctx.params['customerId'] ?? '';
        const asAt = ctx.query['asOf'];
        if (!isDate(asAt)) throw apiError(400, { code: 'dunning_needs_a_date', whatHappened: 'A dunning decision needs ?asOf=YYYY-MM-DD.', wasItSaved: 'not_saved', nextSafeAction: 'Send the date. A decision reads, it never writes.' });
        const invoices = await deps.invoices(ctx.tenantId, customerId);
        if (invoices.length === 0) throw notFound(`b2b customer ${customerId} receivables`);
        const ageing = ageReceivables({ customerId, invoices, asAt });
        const steps = await deps.chasingSteps?.(ctx.tenantId);
        if (steps === undefined) {
          // OB-686: no built-in step. The facts are shown; the step is the owner's to set.
          const worstDaysOverdue = ageing.items.filter((i) => !i.disputed && i.daysOverdue > 0).reduce((w, i) => Math.max(w, i.daysOverdue), 0);
          return { status: 200, body: { customerId, stepsSet: false, chaseableMinor: ageing.chaseableMinor, worstDaysOverdue, needsHuman: false, detail: CHASING_STEPS_NOT_SET } };
        }
        return { status: 200, body: { ...decideDunning({ ageing, steps }), stepsSet: true, steps: { minimumChaseMinor: steps.minimumChaseMinor, reminderAfterDays: steps.reminderAfterDays, finalNoticeAfterDays: steps.finalNoticeAfterDays, stopSupplyAfterDays: steps.stopSupplyAfterDays, setBy: steps.setBy, setAt: steps.setAt } } };
      },
    },
    {
      // OB-686: the owner's chasing steps — "not set" until he sets them. Read by anyone who may chase.
      api: 'API-09', method: 'GET', path: '/v1/b2b/collections/chasing-steps',
      permission: 'b2b.account.read',
      entitlement: 'b2b',
      handler: async (ctx) => {
        const steps = await deps.chasingSteps?.(ctx.tenantId);
        return { status: 200, body: steps === undefined ? { state: 'not_set', say: CHASING_STEPS_NOT_SET } : { state: 'set', steps } };
      },
    },
    {
      // OB-686: the OWNER sets the chasing steps — { minimumChaseMinor, reminderAfterDays, finalNoticeAfterDays,
      // stopSupplyAfterDays }, all four together. Append-only: every version stays on the ledger; the newest applies.
      api: 'API-09', method: 'POST', path: '/v1/b2b/collections/chasing-steps',
      permission: 'b2b.chasing.steps.set', idempotent: true,
      entitlement: 'b2b',
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const problem = dunningStepsProblem(b);
        if (problem !== undefined) {
          throw apiError(400, { code: 'not_readable_as_chasing_steps', whatHappened: `The chasing steps need { minimumChaseMinor, reminderAfterDays, finalNoticeAfterDays, stopSupplyAfterDays }: ${problem}.`, wasItSaved: 'not_saved', nextSafeAction: 'Send all four of the owner\'s numbers. Nothing was changed.' });
        }
        if (deps.recordChasingSteps === undefined) throw apiError(503, { code: 'chasing_steps_not_kept', whatHappened: 'Head office has no durable store to keep the chasing steps.', wasItSaved: 'not_saved', nextSafeAction: 'Try again when head office is running on its database.' });
        const before = await deps.chasingSteps?.(ctx.tenantId);
        const setting: ChasingStepsSetting = {
          minimumChaseMinor: b['minimumChaseMinor'] as number, reminderAfterDays: b['reminderAfterDays'] as number,
          finalNoticeAfterDays: b['finalNoticeAfterDays'] as number, stopSupplyAfterDays: b['stopSupplyAfterDays'] as number,
          setBy: ctx.userId, setAt: deps.now(),
        };
        await deps.recordChasingSteps(ctx.tenantId, setting);
        const shown = (x: DunningSteps): Record<string, string> => ({ minimumChaseMinor: String(x.minimumChaseMinor), reminderAfterDays: String(x.reminderAfterDays), finalNoticeAfterDays: String(x.finalNoticeAfterDays), stopSupplyAfterDays: String(x.stopSupplyAfterDays) });
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'b2b.chasing_steps.set', objectType: 'b2b_chasing_steps', objectId: ctx.tenantId, at: setting.setAt,
          origin: { tenantId: ctx.tenantId, branchId: null }, before: before === undefined ? null : shown(before), after: shown(setting), correlationId: ctx.traceId,
        });
        return { status: 201, body: { state: 'set', steps: setting } };
      },
    },
    {
      // The sub-ledger ↔ GL reconciliation (M23): does the collections ageing total agree with the
      // finance AR balance the credit surface holds? A disagreement is a CONTROL EXCEPTION reported
      // EXACTLY and with its sign (the customer is being asked for money the books do not record, or
      // shown a smaller debt than they owe and will pay the smaller one), never "approximately
      // reconciled". Gated ONE RUNG ABOVE the ageing read: a store manager (b2b.account.read) chases
      // customers, but reconciling the sub-ledger to the general ledger is a finance-controllership
      // act, so it sits on `b2b.receivable.record` (owner + accountant — the tier that records the
      // receivables), exactly as the settlement day-review reconciliation is kept off the shop floor.
      api: 'API-09', method: 'GET', path: '/v1/b2b/collections/:customerId/reconciliation',
      permission: 'b2b.receivable.record',
      entitlement: 'b2b',
      handler: async (ctx) => {
        const customerId = ctx.params['customerId'] ?? '';
        const asAt = ctx.query['asOf'];
        if (!isDate(asAt)) throw apiError(400, { code: 'reconciliation_needs_a_date', whatHappened: 'A reconciliation needs ?asOf=YYYY-MM-DD to age the sub-ledger against.', wasItSaved: 'not_saved', nextSafeAction: 'Send the date. A reconciliation reads, it never writes.' });
        const invoices = await deps.invoices(ctx.tenantId, customerId);
        const financeOutstandingMinor = await deps.outstandingMinor(ctx.tenantId, customerId);
        // 404 only when NEITHER ledger knows this customer. When collections is empty but finance
        // records a balance, that is the WORST discrepancy (the customer is shown nothing owed while
        // the books say otherwise) — it must SURFACE, not 404 like the ageing/dunning reads do.
        if (invoices.length === 0 && financeOutstandingMinor === 0) throw notFound(`b2b customer ${customerId} receivables`);
        const ageing = ageReceivables({ customerId, invoices, asAt });
        return { status: 200, body: reconcileAr({ customerId, ageing, financeOutstandingMinor }) };
      },
    },
  ];
}
