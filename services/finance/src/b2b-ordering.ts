// FUL-09 — B2B ordering the customer can do, and the orders that come round on their own (M22-FR-03 · M22-FR-04 · §28 ·
// P-02 · P-04 · hard rules #2 #6).
//
// The portal used to READ only. Now a business customer, on its own login (the binding a member of staff made — never a
// customer id in the request):
//   • ASKS for a quote — the items and quantities it wants; staff price it (the shop's price, never the customer's);
//   • PLACES the order by accepting one of ITS OWN quotations — at the quoted price, inside its window, with credit cleared
//     and every line's stock held at the store it was quoted from (the same conversion the desk uses: one rule);
//   • sees ITS OWN orders with what has been delivered and billed against each.
// A request naming another customer is refused and recorded, as the rest of the portal does.
//
// RECURRING orders (M22-FR-03 "recurring schedules are governed; a recurring order with insufficient stock/credit raises
// an exception"): a schedule is made from a quotation — its lines and prices and store — by one person and APPROVED by
// another before it runs. On each due date the run issues that day's quotation and converts it through the very same
// credit and stock checks; what cannot go through is recorded as a visible exception, never skipped quietly, and the day
// can be tried again once stock or credit allows. Each run is recorded with who ran it and what it made — once per day.

import type { Route, RequestContext } from '../../kernel/src/index';
import { apiError, ApiError, notFound } from '../../kernel/src/index';
import { checkChain } from '../../../packages/b2b/src/documents';
import { scopeToCustomer, type B2BGrant } from '../../../packages/b2b/src/collections';
import type { B2BPortalRefusal } from '../../../packages/b2b/src/portal-access';
import { convertToSalesOrder, issueQuotationDocument, type B2BDocumentsDeps, type StoredB2BDocument } from './b2b-documents';
import type { B2BLoginBinding } from './b2b-portal';

/** What a customer asked to be quoted for, on its own login. Staff price it; the customer never does. */
export interface B2BQuoteRequest {
  readonly requestId: string;
  readonly customerId: string;
  readonly lines: readonly { readonly productId: string; readonly qty: number }[];
  readonly note?: string;
  readonly requestedBy: string;
  readonly at: string;
}

export type Cadence = 'weekly' | 'monthly';

/** A recurring order, made from a quotation and approved by someone other than its maker. */
export interface RecurringSchedule {
  readonly scheduleId: string;
  readonly customerId: string;
  /** The quotation whose lines, prices and store each run repeats. */
  readonly templateQuotationId: string;
  readonly cadence: Cadence;
  /** Weekly: 1 (Monday) – 7 (Sunday). Monthly: 1 – 28. */
  readonly dayOf: number;
  readonly startsOn: string;
  readonly salespersonId?: string;
  readonly proposedBy: string;
  readonly proposedAt: string;
  readonly approvedBy?: string;
  readonly approvedAt?: string;
}

/** One day's run of one schedule: the order it made, or why it could not. */
export interface RecurringRun {
  readonly scheduleId: string;
  readonly customerId: string;
  readonly on: string;
  readonly outcome: 'generated' | 'exception';
  readonly orderId?: string;
  readonly quotationId: string;
  readonly code?: string;
  readonly detail?: string;
  readonly ranBy: string;
  readonly at: string;
}

export interface B2BOrderingDeps {
  readonly documents: B2BDocumentsDeps;
  readonly customerForUser: (tenantId: string, userId: string) => Promise<B2BLoginBinding | undefined> | B2BLoginBinding | undefined;
  readonly recordAccessRefusal: (tenantId: string, r: B2BPortalRefusal) => Promise<void> | void;
  readonly quoteRequests: (tenantId: string) => Promise<readonly B2BQuoteRequest[]> | readonly B2BQuoteRequest[];
  readonly recordQuoteRequest: (tenantId: string, r: B2BQuoteRequest) => Promise<void> | void;
  readonly schedules: (tenantId: string) => Promise<readonly RecurringSchedule[]> | readonly RecurringSchedule[];
  readonly recordSchedule: (tenantId: string, s: RecurringSchedule) => Promise<void> | void;
  readonly runs: (tenantId: string) => Promise<readonly RecurringRun[]> | readonly RecurringRun[];
  readonly recordRun: (tenantId: string, r: RecurringRun) => Promise<void> | void;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00.000Z`));

/** The latest record per schedule id (a schedule is proposed, then approved — two facts, the later wins). */
const latestSchedules = (all: readonly RecurringSchedule[]): RecurringSchedule[] => {
  const byId = new Map<string, RecurringSchedule>();
  for (const s of all) byId.set(s.scheduleId, s);
  return [...byId.values()];
};

/** Is a schedule due on this date? Weekly on its weekday, monthly on its day of the month — from its start. */
export function isDue(s: RecurringSchedule, on: string): boolean {
  if (on < s.startsOn) return false;
  const d = new Date(`${on}T00:00:00.000Z`);
  if (s.cadence === 'weekly') return ((d.getUTCDay() + 6) % 7) + 1 === s.dayOf;
  return d.getUTCDate() === s.dayOf;
}

export function b2bOrderingRoutes(deps: B2BOrderingDeps): readonly Route[] {
  // The caller's own customer, from the stored binding — and the grant this action needs.
  const me = async (ctx: RequestContext, grant: B2BGrant, action: string): Promise<string> => {
    const binding = await deps.customerForUser(ctx.tenantId, ctx.userId);
    if (binding === undefined) {
      throw apiError(403, { code: 'not_a_b2b_login', whatHappened: 'This login is not bound to any business customer.', wasItSaved: 'not_saved', nextSafeAction: 'Ask the shop to bind your login to your account.' });
    }
    const requested = isStr(ctx.query['customerId']) ? ctx.query['customerId'] : undefined;
    const decision = scopeToCustomer({
      session: { sessionId: `b2b-portal-${binding.customerId}`, customerId: binding.customerId, tenantId: ctx.tenantId, userId: ctx.userId, grants: binding.grants },
      rows: [{ customerId: binding.customerId }], grant, ...(requested === undefined ? {} : { requestedCustomerId: requested }),
    });
    if (decision.securityEvent) {
      await deps.recordAccessRefusal(ctx.tenantId, { customerId: binding.customerId, userId: ctx.userId, requestedCustomerId: requested ?? '', action, outcome: decision.outcome, at: deps.now() });
    }
    if (!decision.allowed) {
      throw apiError(403, { code: decision.outcome, whatHappened: decision.detail, wasItSaved: 'not_saved', nextSafeAction: decision.outcome === 'not_your_data' ? 'You can only act on your own account. This attempt was recorded.' : 'Ask the shop to grant this on your portal login.' });
    }
    return binding.customerId;
  };

  const orderView = async (tenantId: string, customerId: string, order: StoredB2BDocument) => {
    const all = await deps.documents.documents(tenantId, customerId);
    const chain = checkChain({ order, challans: all.filter((d) => d.kind === 'challan' && d.orderId === order.documentId), invoices: all.filter((d) => d.kind === 'tax_invoice' && d.orderId === order.documentId) });
    return { orderId: order.documentId, number: order.number, grossMinor: order.grossMinor, derivedFrom: order.derivedFrom, issuedAt: order.issuedAt, ...(order.locationId === undefined ? {} : { locationId: order.locationId }), chain };
  };

  return [
    {
      // Ask the shop for a quote — items and quantities only; the shop prices it. Body: { lines: [{ productId, qty }], note? }.
      api: 'API-09', method: 'POST', path: '/v1/b2b-portal/me/quote-requests/:requestId',
      permission: 'b2b.portal.self', idempotent: true, entitlement: 'b2b',
      handler: async (ctx) => {
        const customerId = await me(ctx, 'place_order', 'place:quote-request');
        const b = (ctx.body ?? {}) as { lines?: unknown; note?: unknown };
        const lines = Array.isArray(b.lines) && b.lines.length > 0 && b.lines.every((l) => l !== null && typeof l === 'object' && isStr((l as Record<string, unknown>)['productId'])
          && Number.isInteger((l as Record<string, unknown>)['qty']) && ((l as Record<string, unknown>)['qty'] as number) > 0)
          ? (b.lines as { productId: string; qty: number }[]).map((l) => ({ productId: l.productId, qty: l.qty })) : undefined;
        if (lines === undefined) {
          throw apiError(400, { code: 'not_readable_as_a_quote_request', whatHappened: 'A quote request is { lines: [{ productId, qty > 0 }], note? }.', wasItSaved: 'not_saved', nextSafeAction: 'Send the items and quantities. Nothing was recorded.' });
        }
        const requestId = ctx.params['requestId'] ?? '';
        const prior = (await deps.quoteRequests(ctx.tenantId)).find((r) => r.requestId === requestId);
        if (prior !== undefined) {
          if (prior.customerId !== customerId) throw notFound(`quote request ${requestId}`);
          return { status: 200, body: { ...prior, alreadyRecorded: true } };
        }
        const r: B2BQuoteRequest = { requestId, customerId, lines, ...(isStr(b.note) ? { note: b.note.slice(0, 500) } : {}), requestedBy: ctx.userId, at: deps.now() };
        await deps.recordQuoteRequest(ctx.tenantId, r);
        return { status: 201, body: { ...r, tellTheCustomer: 'The shop will price this and send you a quotation to accept.' } };
      },
    },
    {
      // The customer PLACES an order by accepting one of its own quotations — the desk's conversion, unchanged: quoted price,
      // inside the window, credit cleared, stock held at the store it was quoted from. Body: { fromQuotationId }.
      api: 'API-09', method: 'POST', path: '/v1/b2b-portal/me/orders/:documentId',
      permission: 'b2b.portal.self', idempotent: true, entitlement: 'b2b',
      handler: async (ctx) => {
        const customerId = await me(ctx, 'place_order', 'place:order');
        const b = (ctx.body ?? {}) as { fromQuotationId?: unknown };
        const documentId = ctx.params['documentId'] ?? '';
        const existing = await deps.documents.document(ctx.tenantId, customerId, documentId);
        if (existing !== undefined && existing.kind === 'sales_order') return { status: 200, body: { ...(await orderView(ctx.tenantId, customerId, existing)), alreadyPlaced: true } };
        // The customer's own quotation only — another customer's id simply is not found in this customer's documents.
        const order = await convertToSalesOrder(deps.documents, { tenantId: ctx.tenantId, customerId, documentId, fromQuotationId: b.fromQuotationId, locationId: undefined, salespersonId: undefined });
        return { status: 201, body: { ...(await orderView(ctx.tenantId, customerId, order)), placedBy: ctx.userId } };
      },
    },
    {
      // My orders — each with what has been delivered and billed against it. Own only.
      api: 'API-09', method: 'GET', path: '/v1/b2b-portal/me/orders',
      permission: 'b2b.portal.self', entitlement: 'b2b',
      handler: async (ctx) => {
        const customerId = await me(ctx, 'view_invoices', 'read:orders');
        const orders = [];
        for (const o of (await deps.documents.documents(ctx.tenantId, customerId)).filter((d) => d.kind === 'sales_order')) orders.push(await orderView(ctx.tenantId, customerId, o));
        const requests = (await deps.quoteRequests(ctx.tenantId)).filter((r) => r.customerId === customerId);
        return { status: 200, body: { customerId, orders, count: orders.length, quoteRequests: requests, asAt: deps.now() } };
      },
    },
    {
      // Staff: the quote requests customers have sent, newest first.
      api: 'API-09', method: 'GET', path: '/v1/b2b/quote-requests',
      permission: 'b2b.document.read', entitlement: 'b2b',
      handler: async (ctx) => {
        const requests = [...await deps.quoteRequests(ctx.tenantId)].sort((a, b) => b.at.localeCompare(a.at));
        return { status: 200, body: { requests, count: requests.length } };
      },
    },
    {
      // Propose a recurring order from a quotation. Not in force until someone else approves it.
      // Body: { customerId, fromQuotationId, cadence: weekly | monthly, dayOf, startsOn, salespersonId? }.
      api: 'API-09', method: 'POST', path: '/v1/b2b/recurring/:scheduleId',
      permission: 'b2b.document.issue', idempotent: true, entitlement: 'b2b',
      handler: async (ctx) => {
        const scheduleId = ctx.params['scheduleId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const cadence = b['cadence'] === 'weekly' || b['cadence'] === 'monthly' ? b['cadence'] : undefined;
        const dayOf = b['dayOf'];
        if (!isStr(b['customerId']) || !isStr(b['fromQuotationId']) || cadence === undefined || !Number.isInteger(dayOf) || (dayOf as number) < 1
          || (dayOf as number) > (cadence === 'weekly' ? 7 : 28) || !isDate(b['startsOn']) || (b['salespersonId'] !== undefined && !isStr(b['salespersonId']))) {
          throw apiError(400, { code: 'not_readable_as_a_recurring_order', whatHappened: 'A recurring order needs { customerId, fromQuotationId, cadence: weekly | monthly, dayOf (1–7 weekly, 1–28 monthly), startsOn YYYY-MM-DD, salespersonId? }.', wasItSaved: 'not_saved', nextSafeAction: 'Send it again. Nothing was recorded.' });
        }
        const template = await deps.documents.document(ctx.tenantId, b['customerId'], b['fromQuotationId']);
        if (template === undefined || template.kind !== 'quotation') throw notFound(`quotation ${b['fromQuotationId']} for ${b['customerId']}`);
        if (latestSchedules(await deps.schedules(ctx.tenantId)).some((s) => s.scheduleId === scheduleId)) {
          throw apiError(409, { code: 'recurring_order_exists', whatHappened: `Recurring order ${scheduleId} is already on record.`, wasItSaved: 'not_saved', nextSafeAction: 'Use a new id for a new schedule. Nothing was changed.' });
        }
        const s: RecurringSchedule = {
          scheduleId, customerId: b['customerId'], templateQuotationId: b['fromQuotationId'], cadence, dayOf: dayOf as number, startsOn: b['startsOn'],
          ...(isStr(b['salespersonId']) ? { salespersonId: b['salespersonId'] } : {}), proposedBy: ctx.userId, proposedAt: deps.now(),
        };
        await deps.recordSchedule(ctx.tenantId, s);
        return { status: 201, body: { ...s, inForce: false } };
      },
    },
    {
      // Approve a recurring order — by someone other than its maker (§28). It then runs on its due dates.
      api: 'API-09', method: 'POST', path: '/v1/b2b/recurring/:scheduleId/approve',
      permission: 'b2b.recurring.approve', idempotent: true, entitlement: 'b2b',
      handler: async (ctx) => {
        const scheduleId = ctx.params['scheduleId'] ?? '';
        const s = latestSchedules(await deps.schedules(ctx.tenantId)).find((x) => x.scheduleId === scheduleId);
        if (s === undefined) throw notFound(`recurring order ${scheduleId}`);
        if (s.approvedBy !== undefined) return { status: 200, body: { ...s, inForce: true } };
        if (s.proposedBy === ctx.userId) {
          // Maker-checker (§28), said as such: the refusal is about WHO, not about a missing permission.
          throw apiError(403, { code: 'maker_cannot_approve', whatHappened: `${ctx.userId} set up recurring order ${scheduleId} and cannot also approve it — a second person must (§28).`, wasItSaved: 'not_saved', nextSafeAction: 'Ask another approver. Nothing was changed; the order does not run until then.' });
        }
        const approved: RecurringSchedule = { ...s, approvedBy: ctx.userId, approvedAt: deps.now() };
        await deps.recordSchedule(ctx.tenantId, approved);
        return { status: 200, body: { ...approved, inForce: true } };
      },
    },
    {
      // Run the recurring orders due on a date (the scheduler calls this each day; a person may too). Each approved
      // schedule due that day makes its order ONCE through the ordinary credit and stock checks; what cannot go through is
      // an EXCEPTION on record. Body: { on: YYYY-MM-DD }.
      api: 'API-09', method: 'POST', path: '/v1/b2b/recurring-runs',
      permission: 'b2b.document.issue', idempotent: true, entitlement: 'b2b',
      handler: async (ctx) => {
        const on = ((ctx.body ?? {}) as { on?: unknown }).on;
        if (!isDate(on)) throw apiError(400, { code: 'run_needs_a_date', whatHappened: 'A run is for a date: { on: YYYY-MM-DD }.', wasItSaved: 'not_saved', nextSafeAction: 'Send the date. Nothing was run.' });
        const runs = await deps.runs(ctx.tenantId);
        const results: RecurringRun[] = [];
        for (const s of latestSchedules(await deps.schedules(ctx.tenantId))) {
          if (s.approvedBy === undefined || !isDue(s, on)) continue;
          if (runs.some((r) => r.scheduleId === s.scheduleId && r.on === on && r.outcome === 'generated')) continue;
          const quotationId = `REC-${s.scheduleId}-${on}`;
          const orderId = `RSO-${s.scheduleId}-${on}`;
          const base = { scheduleId: s.scheduleId, customerId: s.customerId, on, quotationId, ranBy: ctx.userId, at: deps.now() };
          let run: RecurringRun;
          try {
            const template = await deps.documents.document(ctx.tenantId, s.customerId, s.templateQuotationId);
            if (template === undefined) throw notFound(`template quotation ${s.templateQuotationId}`);
            // The day's quotation repeats the template's lines, prices and store — issued once per day, reused on a retry.
            const quoted = await deps.documents.document(ctx.tenantId, s.customerId, quotationId)
              ?? await issueQuotationDocument(deps.documents, { tenantId: ctx.tenantId, customerId: s.customerId, documentId: quotationId, lines: template.lines, validForDays: 1, ...(template.locationId === undefined ? {} : { locationId: template.locationId }) });
            const order = await convertToSalesOrder(deps.documents, { tenantId: ctx.tenantId, customerId: s.customerId, documentId: orderId, fromQuotationId: quoted.documentId, locationId: undefined, salespersonId: s.salespersonId });
            run = { ...base, outcome: 'generated', orderId: order.documentId };
          } catch (e) {
            if (!(e instanceof ApiError)) throw e;
            run = { ...base, outcome: 'exception', code: e.body.code, detail: e.body.whatHappened };
          }
          await deps.recordRun(ctx.tenantId, run);
          results.push(run);
        }
        return { status: 200, body: { on, runs: results, generated: results.filter((r) => r.outcome === 'generated').length, exceptions: results.filter((r) => r.outcome === 'exception').length } };
      },
    },
    {
      // The recurring orders — each with its runs — and the open exceptions (a day that could not go through and has not since).
      api: 'API-09', method: 'GET', path: '/v1/b2b/recurring',
      permission: 'b2b.document.read', entitlement: 'b2b',
      handler: async (ctx) => {
        const runs = await deps.runs(ctx.tenantId);
        const schedules = latestSchedules(await deps.schedules(ctx.tenantId)).map((s) => ({ ...s, inForce: s.approvedBy !== undefined, runs: runs.filter((r) => r.scheduleId === s.scheduleId) }));
        const exceptions = runs.filter((r) => r.outcome === 'exception' && !runs.some((g) => g.scheduleId === r.scheduleId && g.on === r.on && g.outcome === 'generated'));
        return { status: 200, body: { schedules, exceptions, count: schedules.length } };
      },
    },
  ];
}
