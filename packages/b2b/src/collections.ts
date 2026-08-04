// B2B portal, outstanding and collections (M22-FR-04 / M23 / ADR-0003 / hard rule #3).
//
// This is the second place in the product where **someone outside the business logs in**
// (the first is the supplier portal, M24). Same class of risk, different blast radius: a
// caterer seeing a rival caterer's prices and volumes is a commercial injury the shop cannot
// undo, and a school seeing another school's outstanding is a data-protection incident.
//
// So the isolation rule is identical and deliberately repeated rather than shared by
// accident: **the customer id comes from the authenticated session, never from the request.**
//
// The collections half is where a retail ERP usually goes quietly wrong, in three ways:
//
//   • **AGEING FROM THE DUE DATE, NOT THE INVOICE DATE.** An invoice on 30-day terms issued
//     40 days ago is 10 days overdue, not 40. Ageing from the invoice date makes every
//     account on terms look delinquent, so the report gets ignored — and then the genuinely
//     overdue account is ignored with it.
//   • **A PAYMENT IS ALLOCATED, NOT ABSORBED.** ₹50,000 against ₹120,000 of invoices has to
//     land somewhere specific. Netting it against a balance loses which invoice is still
//     open, and the customer and the shop then argue about different invoices.
//   • **A DISPUTED INVOICE DOES NOT AGE INTO A DUNNING LETTER.** Chasing a customer for an
//     invoice they have already queried is how a good account is lost over ₹4,000.
//
// Pure and deterministic: the clock is injected, no I/O, no card data anywhere (#3).

export type B2BGrant = 'place_order' | 'view_invoices' | 'view_statement' | 'make_payment';

/** The authenticated portal session. The customer id comes from HERE and nowhere else. */
export interface B2BSession {
  readonly sessionId: string;
  readonly customerId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly grants: readonly B2BGrant[];
}

export type B2BAccessOutcome = 'allowed' | 'not_your_data' | 'no_grant';

export interface B2BAccessDecision<T> {
  readonly allowed: boolean;
  readonly outcome: B2BAccessOutcome;
  readonly rows: readonly T[];
  readonly securityEvent: boolean;
  readonly detail: string;
}

/**
 * Scope any customer-owned collection to the session's own customer.
 *
 * **From the session, never from the request.** A request naming another customer is refused
 * and marked a security event — one caterer asking for another caterer's volumes is not a
 * UI mistake.
 */
export function scopeToCustomer<T extends { readonly customerId: string; readonly tenantId?: string }>(input: {
  readonly session: B2BSession;
  readonly rows: readonly T[];
  readonly grant: B2BGrant;
  readonly requestedCustomerId?: string;
}): B2BAccessDecision<T> {
  const { session } = input;

  if (!session.grants.includes(input.grant)) {
    return {
      allowed: false,
      outcome: 'no_grant',
      rows: [],
      securityEvent: false,
      detail: `this portal login does not have "${input.grant}"`,
    };
  }
  if (input.requestedCustomerId !== undefined && input.requestedCustomerId !== session.customerId) {
    return {
      allowed: false,
      outcome: 'not_your_data',
      rows: [],
      securityEvent: true,
      detail: `session belongs to ${session.customerId} and the request asked for ${input.requestedCustomerId} — refused and recorded`,
    };
  }

  const mine = input.rows.filter(
    (r) => r.customerId === session.customerId && (r.tenantId === undefined || r.tenantId === session.tenantId),
  );
  return {
    allowed: true,
    outcome: 'allowed',
    rows: mine,
    securityEvent: false,
    detail: `${mine.length} row(s), filtered server-side from the session`,
  };
}

export interface Receivable {
  readonly invoiceId: string;
  readonly number: string;
  readonly customerId: string;
  readonly tenantId?: string;
  readonly issuedOn: string;
  /** Payment terms applied. Ageing runs from HERE, not from `issuedOn`. */
  readonly dueOn: string;
  readonly grossMinor: number;
  readonly settledMinor: number;
  /** A queried invoice is not chased. It is escalated to a person instead. */
  readonly disputed?: boolean;
  readonly disputeReason?: string;
}

export type AgeBucket = 'not_due' | 'due_0_30' | 'due_31_60' | 'due_61_90' | 'due_90_plus';

export interface AgedItem {
  readonly invoiceId: string;
  readonly number: string;
  readonly outstandingMinor: number;
  readonly daysOverdue: number;
  readonly bucket: AgeBucket;
  readonly disputed: boolean;
  readonly detail: string;
}

export interface AgeingReport {
  readonly customerId: string;
  readonly asAt: string;
  readonly totalOutstandingMinor: number;
  readonly overdueMinor: number;
  readonly disputedMinor: number;
  /** Overdue and NOT disputed — the only figure a dunning run may act on. */
  readonly chaseableMinor: number;
  readonly buckets: Readonly<Record<AgeBucket, number>>;
  readonly items: readonly AgedItem[];
  readonly detail: string;
}

const DAY_MS = 86_400_000;

function bucketFor(daysOverdue: number): AgeBucket {
  if (daysOverdue <= 0) return 'not_due';
  if (daysOverdue <= 30) return 'due_0_30';
  if (daysOverdue <= 60) return 'due_31_60';
  if (daysOverdue <= 90) return 'due_61_90';
  return 'due_90_plus';
}

/**
 * Age a customer's receivables **from the due date**.
 *
 * An invoice on 30-day terms issued 40 days ago is 10 days overdue. Ageing from the invoice
 * date would put it in the 31–60 bucket and make every account on terms look delinquent —
 * and a report where everything is red is a report nobody reads.
 *
 * `chaseableMinor` deliberately excludes disputed invoices: it is the only number a dunning
 * run is allowed to act on.
 */
export function ageReceivables(input: {
  readonly customerId: string;
  readonly invoices: readonly Receivable[];
  readonly asAt: string;
}): AgeingReport {
  const buckets: Record<AgeBucket, number> = {
    not_due: 0, due_0_30: 0, due_31_60: 0, due_61_90: 0, due_90_plus: 0,
  };
  const items: AgedItem[] = [];
  let totalOutstandingMinor = 0;
  let overdueMinor = 0;
  let disputedMinor = 0;
  let chaseableMinor = 0;

  const asAtMs = Date.parse(`${input.asAt}T00:00:00Z`);

  for (const invoice of input.invoices.filter((i) => i.customerId === input.customerId)) {
    const outstandingMinor = invoice.grossMinor - invoice.settledMinor;
    if (outstandingMinor <= 0) continue;

    const daysOverdue = Math.floor((asAtMs - Date.parse(`${invoice.dueOn}T00:00:00Z`)) / DAY_MS);
    const bucket = bucketFor(daysOverdue);
    const disputed = invoice.disputed === true;

    totalOutstandingMinor += outstandingMinor;
    buckets[bucket] += outstandingMinor;
    if (bucket !== 'not_due') overdueMinor += outstandingMinor;
    if (disputed) disputedMinor += outstandingMinor;
    else if (bucket !== 'not_due') chaseableMinor += outstandingMinor;

    items.push({
      invoiceId: invoice.invoiceId,
      number: invoice.number,
      outstandingMinor,
      daysOverdue,
      bucket,
      disputed,
      detail: disputed
        ? `${outstandingMinor} queried by the customer${invoice.disputeReason === undefined ? '' : ` (${invoice.disputeReason})`} — this is a conversation, not a reminder letter`
        : bucket === 'not_due'
          ? `${outstandingMinor} not due for another ${-daysOverdue} day(s)`
          : `${outstandingMinor}, ${daysOverdue} day(s) past the agreed due date`,
    });
  }

  items.sort((a, b) => b.daysOverdue - a.daysOverdue || a.invoiceId.localeCompare(b.invoiceId));

  return {
    customerId: input.customerId,
    asAt: input.asAt,
    totalOutstandingMinor,
    overdueMinor,
    disputedMinor,
    chaseableMinor,
    buckets,
    items,
    detail:
      disputedMinor === 0
        ? `${totalOutstandingMinor} outstanding, ${overdueMinor} of it past the due date`
        : `${totalOutstandingMinor} outstanding, ${overdueMinor} past due, of which ${disputedMinor} is queried and must not be chased`,
  };
}

export interface PaymentAllocation {
  readonly invoiceId: string;
  readonly number: string;
  readonly appliedMinor: number;
  readonly stillOpenMinor: number;
}

export interface PaymentResult {
  readonly receiptId: string;
  readonly customerId: string;
  readonly receivedMinor: number;
  readonly allocations: readonly PaymentAllocation[];
  readonly allocatedMinor: number;
  /** Money received that no invoice could absorb. Held, never quietly kept. */
  readonly unappliedMinor: number;
  readonly detail: string;
}

/**
 * Allocate a received payment to specific invoices.
 *
 * **Netting a payment against a balance is the mistake this exists to prevent.** ₹50,000
 * against three open invoices has to land somewhere; if it does not, the shop's "outstanding"
 * and the customer's "what I have paid" are both right and they disagree, and the argument
 * takes three weeks and a printout of everything.
 *
 * Default order is **oldest due first**, which is what a collections clerk does by hand. A
 * customer paying a specific invoice overrides that: they know what they are paying for.
 *
 * Anything left over is **unapplied and visible** — never absorbed into a balance, because
 * an advance the shop cannot point at is an advance the customer will ask about.
 */
export function allocatePayment(input: {
  readonly receiptId: string;
  readonly customerId: string;
  readonly receivedMinor: number;
  readonly invoices: readonly Receivable[];
  /** Invoice ids the customer named. Paid in this order, before anything else. */
  readonly against?: readonly string[];
  /** Whether a disputed invoice may absorb the payment. Default false. */
  readonly allocateToDisputed?: boolean;
}): PaymentResult {
  const mine = input.invoices
    .filter((i) => i.customerId === input.customerId && i.grossMinor > i.settledMinor)
    .filter((i) => (input.allocateToDisputed ?? false) || i.disputed !== true);

  const named = (input.against ?? [])
    .map((id) => mine.find((i) => i.invoiceId === id))
    .filter((i): i is Receivable => i !== undefined);
  const rest = mine
    .filter((i) => !(input.against ?? []).includes(i.invoiceId))
    .sort((a, b) => a.dueOn.localeCompare(b.dueOn) || a.invoiceId.localeCompare(b.invoiceId));

  let remaining = input.receivedMinor;
  const allocations: PaymentAllocation[] = [];

  for (const invoice of [...named, ...rest]) {
    if (remaining <= 0) break;
    const open = invoice.grossMinor - invoice.settledMinor;
    const appliedMinor = Math.min(open, remaining);
    remaining -= appliedMinor;
    allocations.push({
      invoiceId: invoice.invoiceId,
      number: invoice.number,
      appliedMinor,
      stillOpenMinor: open - appliedMinor,
    });
  }

  const allocatedMinor = allocations.reduce((s, a) => s + a.appliedMinor, 0);

  return {
    receiptId: input.receiptId,
    customerId: input.customerId,
    receivedMinor: input.receivedMinor,
    allocations,
    allocatedMinor,
    unappliedMinor: remaining,
    detail:
      remaining > 0
        ? `${allocatedMinor} allocated across ${allocations.length} invoice(s); ${remaining} is UNAPPLIED and held on account — it is not netted into a balance`
        : `${allocatedMinor} allocated across ${allocations.length} invoice(s), oldest due first`,
  };
}

export type DunningStep = 'none' | 'statement' | 'reminder' | 'final_notice' | 'stop_supply';

export interface DunningDecision {
  readonly customerId: string;
  readonly step: DunningStep;
  readonly chaseableMinor: number;
  readonly worstDaysOverdue: number;
  /** True when a person must decide before anything is sent. */
  readonly needsHuman: boolean;
  readonly detail: string;
}

/**
 * Decide the collections step for an account.
 *
 * **Stopping supply is never automatic.** It is a commercial decision that ends a
 * relationship, and a system that takes it on a date arithmetic is a system that cuts off a
 * school on the morning of a function because an invoice was queried by email rather than in
 * the portal. The step is recommended; a person commits it (P-05, §28).
 */
export function decideDunning(input: {
  readonly ageing: AgeingReport;
  /** Per-tenant thresholds in days overdue. */
  readonly reminderAfterDays?: number;
  readonly finalNoticeAfterDays?: number;
  readonly stopSupplyAfterDays?: number;
  /** Below this, chasing costs more than the debt. Per-tenant. Default ₹500. */
  readonly minimumChaseMinor?: number;
}): DunningDecision {
  const chaseable = input.ageing.items.filter((i) => !i.disputed && i.daysOverdue > 0);
  const worstDaysOverdue = chaseable.reduce((w, i) => Math.max(w, i.daysOverdue), 0);
  const minimum = input.minimumChaseMinor ?? 50_000;
  const base = {
    customerId: input.ageing.customerId,
    chaseableMinor: input.ageing.chaseableMinor,
    worstDaysOverdue,
  };

  if (input.ageing.chaseableMinor === 0) {
    return {
      ...base,
      step: 'none',
      needsHuman: false,
      detail:
        input.ageing.disputedMinor > 0
          ? `nothing chaseable — ${input.ageing.disputedMinor} is queried and belongs with a person, not a reminder letter`
          : 'nothing overdue',
    };
  }
  if (input.ageing.chaseableMinor < minimum) {
    return {
      ...base,
      step: 'statement',
      needsHuman: false,
      detail: `${input.ageing.chaseableMinor} overdue — below the chase threshold, so it goes on the next statement rather than becoming a letter`,
    };
  }

  const stopAfter = input.stopSupplyAfterDays ?? 90;
  const finalAfter = input.finalNoticeAfterDays ?? 60;
  const remindAfter = input.reminderAfterDays ?? 7;

  if (worstDaysOverdue > stopAfter) {
    return {
      ...base,
      step: 'stop_supply',
      // The whole point. This ends a relationship; date arithmetic does not get to do that.
      needsHuman: true,
      detail: `${input.ageing.chaseableMinor} is ${worstDaysOverdue} days overdue — stopping supply is RECOMMENDED and needs your decision, not an automatic cut-off on the morning of their function`,
    };
  }
  if (worstDaysOverdue > finalAfter) {
    return {
      ...base,
      step: 'final_notice',
      needsHuman: true,
      detail: `${input.ageing.chaseableMinor} is ${worstDaysOverdue} days overdue — a final notice is drafted for you to send`,
    };
  }
  if (worstDaysOverdue > remindAfter) {
    return {
      ...base,
      step: 'reminder',
      needsHuman: false,
      detail: `${input.ageing.chaseableMinor} is ${worstDaysOverdue} days overdue — a reminder goes out`,
    };
  }
  return {
    ...base,
    step: 'statement',
    needsHuman: false,
    detail: `${worstDaysOverdue} day(s) past due — a statement is enough this early`,
  };
}

export interface ArReconciliation {
  readonly customerId: string;
  readonly portalOutstandingMinor: number;
  readonly financeOutstandingMinor: number;
  readonly differenceMinor: number;
  readonly agrees: boolean;
  readonly detail: string;
}

/**
 * Reconcile what the portal shows against what finance holds (M23).
 *
 * A customer portal that disagrees with the ledger is worse than no portal: the customer
 * pays what the screen said and finance chases the difference, and the shop looks like it
 * cannot count. The difference is reported **exactly and with its sign**, never as
 * "approximately reconciled".
 */
export function reconcileAr(input: {
  readonly customerId: string;
  readonly ageing: AgeingReport;
  readonly financeOutstandingMinor: number;
}): ArReconciliation {
  const portalOutstandingMinor = input.ageing.totalOutstandingMinor;
  const differenceMinor = portalOutstandingMinor - input.financeOutstandingMinor;

  return {
    customerId: input.customerId,
    portalOutstandingMinor,
    financeOutstandingMinor: input.financeOutstandingMinor,
    differenceMinor,
    agrees: differenceMinor === 0,
    detail:
      differenceMinor === 0
        ? `portal and finance agree at ${portalOutstandingMinor}`
        : differenceMinor > 0
          ? `the portal shows ${differenceMinor} MORE than finance — the customer is being asked for money the books do not record`
          : `the portal shows ${-differenceMinor} LESS than finance — the customer is being shown a smaller debt than they owe, and they will pay the smaller one`,
  };
}
