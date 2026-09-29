// API-09 B2B customer portal — a business customer reads ITS OWN account, invoices, statement and documents
// (M22-FR-04 · §35 · P-04 · hard rules #4 #6). The third party outside the business to hold a key, after the
// supplier (M24) and the storefront customer (M20), and shaped exactly like them:
//
//   • WHO the login is comes from a stored binding a member of staff made — never from the request. A
//     `b2b_customer` role holds one permission, `b2b.portal.self`, and every `/me` route resolves the
//     customer id from that binding. There is no `:customerId` on a `/me` path to change.
//   • WHAT the login may see is the binding's grants (`view_statement`, `view_invoices`, …) — the same
//     `B2BGrant` vocabulary the pure `scopeToCustomer` engine has always enforced. A missing grant is a
//     permission answer (403 `no_grant`), never an empty list read as "nothing owed".
//   • A request that names ANOTHER customer (`?customerId=`) is refused AND recorded (403 `not_your_data`);
//     a pattern of them is surfaced to staff as probing (`GET /v1/b2b-portal/probing`) — one caterer asking
//     for another caterer's statement is not a UI mistake.
//   • Nothing here writes money. The portal is read-only for the customer; invoices, payments and
//     documents are recorded by staff on the existing B2B surfaces and PROJECTED here.
//
// Gated by the `b2b` entitlement (M36-FR-01), like the rest of the B2B family.
import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import { scopeToCustomer, ageReceivables, type B2BGrant, type B2BSession } from '../../../packages/b2b/src/collections';
import { findB2BProbing, type B2BPortalRefusal } from '../../../packages/b2b/src/portal-access';
import type { B2BCollectionsDeps } from './b2b-collections';
import type { B2BCreditDeps } from './b2b-credit';
import type { B2BDocumentsDeps } from './b2b-documents';

export const B2B_GRANTS: readonly B2BGrant[] = ['place_order', 'view_invoices', 'view_statement', 'make_payment'];

/** A portal login bound to a B2B customer by a member of staff. Latest binding per user wins. */
export interface B2BLoginBinding {
  readonly customerId: string;
  readonly userId: string;
  readonly grants: readonly B2BGrant[];
  readonly boundBy: string;
  readonly at: string;
}

export interface B2BPortalDeps {
  /** The customer this authenticated user is a portal login for — from the stored binding, never the request. */
  readonly customerForUser: (tenantId: string, userId: string) => Promise<B2BLoginBinding | undefined> | B2BLoginBinding | undefined;
  readonly recordLoginBinding: (tenantId: string, binding: B2BLoginBinding) => Promise<void> | void;
  /** The logins currently bound to a customer — what staff review. */
  readonly loginsFor: (tenantId: string, customerId: string) => Promise<readonly B2BLoginBinding[]> | readonly B2BLoginBinding[];
  readonly recordAccessRefusal: (tenantId: string, r: B2BPortalRefusal) => Promise<void> | void;
  readonly accessRefusals: (tenantId: string) => Promise<readonly B2BPortalRefusal[]> | readonly B2BPortalRefusal[];
}

type Deps = B2BPortalDeps & Pick<B2BCollectionsDeps, 'invoices'> & Pick<B2BCreditDeps, 'account' | 'outstandingMinor'> & Pick<B2BDocumentsDeps, 'documents'> & { readonly now: () => string };

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00.000Z`));
const isGrants = (v: unknown): v is B2BGrant[] => Array.isArray(v) && v.length > 0 && v.every((g) => (B2B_GRANTS as readonly string[]).includes(g as string));

export function b2bPortalRoutes(deps: Deps): readonly Route[] {
  // The caller's OWN session — customer id and grants from the stored binding (§35). A login bound to no
  // customer is refused as "not a B2B login": it has no portal data of its own, and saying so beats an
  // empty statement read as "nothing owed".
  const meSession = async (tenantId: string, userId: string): Promise<B2BSession> => {
    const binding = await deps.customerForUser(tenantId, userId);
    if (binding === undefined) {
      throw apiError(403, {
        code: 'not_a_b2b_login',
        whatHappened: 'This login is not bound to any business customer, so it has no portal data of its own.',
        wasItSaved: 'not_saved',
        nextSafeAction: 'A member of staff binds a login to a customer (POST /v1/b2b-portal/customers/:customerId/logins/:userId).',
      });
    }
    return { sessionId: `b2b-portal-${binding.customerId}`, customerId: binding.customerId, tenantId, userId, grants: binding.grants };
  };
  // Scope rows to the session, or refuse. A request naming another customer is a security event: recorded on
  // the tenant's refusal register (so `findB2BProbing` sees a pattern — hard rule #6) and refused 403, never
  // silently emptied. A missing grant is a permission answer, also 403, never an empty list.
  const scopedOrRefused = async <T extends { readonly customerId: string; readonly tenantId?: string }>(
    session: B2BSession, rows: readonly T[], grant: B2BGrant, requestedCustomerId: string | undefined, action: string,
  ): Promise<readonly T[]> => {
    const decision = scopeToCustomer({ session, rows, grant, ...(requestedCustomerId === undefined ? {} : { requestedCustomerId }) });
    if (decision.securityEvent) {
      await deps.recordAccessRefusal(session.tenantId, {
        customerId: session.customerId, userId: session.userId, requestedCustomerId: requestedCustomerId ?? '', action, outcome: decision.outcome, at: deps.now(),
      });
    }
    if (!decision.allowed) {
      throw apiError(403, {
        code: decision.outcome,
        whatHappened: decision.detail,
        wasItSaved: 'not_saved',
        nextSafeAction: decision.outcome === 'not_your_data'
          ? 'You can only see your own account. This attempt was recorded.'
          : 'Ask the shop to grant this on your portal login.',
      });
    }
    return decision.rows;
  };
  const requested = (q: Readonly<Record<string, string>>): string | undefined => (isStr(q['customerId']) ? q['customerId'] : undefined);

  return [
    {
      // Staff bind a login to a customer with the grants it may use. Latest binding per login wins, so a login
      // moved to another customer re-points and the old customer's list no longer shows it.
      api: 'API-09', method: 'POST', path: '/v1/b2b-portal/customers/:customerId/logins/:userId',
      permission: 'b2b.account.manage', idempotent: true,
      entitlement: 'b2b',
      handler: async (ctx) => {
        const customerId = ctx.params['customerId'] ?? '';
        const userId = ctx.params['userId'] ?? '';
        const b = ctx.body;
        if (!isObj(b) || !isGrants(b['grants'])) {
          throw apiError(400, {
            code: 'not_readable_as_a_portal_login',
            whatHappened: `A portal login needs { grants: [one or more of ${B2B_GRANTS.join(' | ')}] }.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the grants this login may use. Nothing was changed.',
          });
        }
        const binding: B2BLoginBinding = { customerId, userId, grants: b['grants'], boundBy: ctx.userId, at: deps.now() };
        await deps.recordLoginBinding(ctx.tenantId, binding);
        return { status: 201, body: binding };
      },
    },
    {
      // The logins bound to a customer — for staff to review who holds a key to this account.
      api: 'API-09', method: 'GET', path: '/v1/b2b-portal/customers/:customerId/logins',
      permission: 'b2b.account.read',
      entitlement: 'b2b',
      handler: async (ctx) => {
        const customerId = ctx.params['customerId'] ?? '';
        const logins = await deps.loginsFor(ctx.tenantId, customerId);
        return { status: 200, body: { customerId, logins, count: logins.length } };
      },
    },
    {
      // Portal logins probing for other customers' data — the tenant-wide security view for staff. One
      // refusal is a mis-click; a pattern is somebody trying doors, and the shop should hear it from its own
      // system. `?threshold=` is how many refusals count as a pattern (default 3).
      api: 'API-09', method: 'GET', path: '/v1/b2b-portal/probing',
      permission: 'b2b.account.read',
      entitlement: 'b2b',
      handler: async (ctx) => {
        const raw = Number(ctx.query['threshold']);
        const threshold = Number.isInteger(raw) && raw > 0 ? raw : 3;
        const refusals = await deps.accessRefusals(ctx.tenantId);
        const probing = findB2BProbing(refusals, threshold);
        return { status: 200, body: { probing, threshold, count: probing.length, refusals: refusals.length, asAt: deps.now() } };
      },
    },
    {
      // My account — credit terms and what I owe, PROJECTED from the same ledger the credit check reads.
      api: 'API-09', method: 'GET', path: '/v1/b2b-portal/me/account',
      permission: 'b2b.portal.self',
      entitlement: 'b2b',
      handler: async (ctx) => {
        const session = await meSession(ctx.tenantId, ctx.userId);
        await scopedOrRefused(session, [{ customerId: session.customerId }], 'view_statement', requested(ctx.query), 'read:account');
        const account = await deps.account(ctx.tenantId, session.customerId);
        const outstandingMinor = await deps.outstandingMinor(ctx.tenantId, session.customerId);
        return {
          status: 200,
          body: account === undefined
            ? { customerId: session.customerId, hasCreditAccount: false, outstandingMinor, detail: 'no credit terms have been set for this account; purchases are settled as they are made' }
            : {
              customerId: session.customerId, hasCreditAccount: true,
              creditLimitMinor: account.creditLimitMinor, currency: account.currency, outstandingMinor,
              availableCreditMinor: Math.max(0, account.creditLimitMinor - outstandingMinor),
            },
        };
      },
    },
    {
      // My invoices — each with what has been settled against it and what is still open; a disputed invoice
      // shown as such (it is outstanding, and it is with a person, not a letter).
      api: 'API-09', method: 'GET', path: '/v1/b2b-portal/me/invoices',
      permission: 'b2b.portal.self',
      entitlement: 'b2b',
      handler: async (ctx) => {
        const session = await meSession(ctx.tenantId, ctx.userId);
        const mine = await scopedOrRefused(session, await deps.invoices(ctx.tenantId, session.customerId), 'view_invoices', requested(ctx.query), 'read:invoices');
        const invoices = mine
          .map((i) => ({
            invoiceId: i.invoiceId, number: i.number, issuedOn: i.issuedOn, dueOn: i.dueOn,
            grossMinor: i.grossMinor, settledMinor: i.settledMinor, outstandingMinor: Math.max(0, i.grossMinor - i.settledMinor),
            disputed: i.disputed === true, ...(i.disputeReason === undefined ? {} : { disputeReason: i.disputeReason }),
          }))
          .sort((a, b) => a.dueOn.localeCompare(b.dueOn) || a.number.localeCompare(b.number));
        return { status: 200, body: { customerId: session.customerId, invoices, count: invoices.length, outstandingMinor: invoices.reduce((s, i) => s + i.outstandingMinor, 0), asAt: deps.now() } };
      },
    },
    {
      // My statement — the ageing of my own invoices from their DUE dates, as at a date. No invoices is said
      // plainly, never as a zero-balance statement that looks like a clean slate.
      api: 'API-09', method: 'GET', path: '/v1/b2b-portal/me/statement',
      permission: 'b2b.portal.self',
      entitlement: 'b2b',
      handler: async (ctx) => {
        const session = await meSession(ctx.tenantId, ctx.userId);
        const asAt = ctx.query['asOf'] ?? deps.now().slice(0, 10);
        if (!isDate(asAt)) {
          throw apiError(400, { code: 'statement_needs_a_date', whatHappened: 'A statement is aged as at a date: ?asOf=YYYY-MM-DD (today when omitted).', wasItSaved: 'not_saved', nextSafeAction: 'Send a valid date. Nothing was changed.' });
        }
        const mine = await scopedOrRefused(session, await deps.invoices(ctx.tenantId, session.customerId), 'view_statement', requested(ctx.query), 'read:statement');
        if (mine.length === 0) {
          return { status: 200, body: { customerId: session.customerId, asAt, ageing: null, detail: 'no invoices have been recorded for this account' } };
        }
        return { status: 200, body: { customerId: session.customerId, asAt, ageing: ageReceivables({ customerId: session.customerId, invoices: mine, asAt }) } };
      },
    },
    {
      // My documents — the quotations, orders, proformas, challans and tax invoices issued to me, own only.
      api: 'API-09', method: 'GET', path: '/v1/b2b-portal/me/documents',
      permission: 'b2b.portal.self',
      entitlement: 'b2b',
      handler: async (ctx) => {
        const session = await meSession(ctx.tenantId, ctx.userId);
        const mine = await scopedOrRefused(session, await deps.documents(ctx.tenantId, session.customerId), 'view_invoices', requested(ctx.query), 'read:documents');
        const documents = mine.map((d) => ({
          documentId: d.documentId, kind: d.kind, number: d.number, grossMinor: d.grossMinor,
          ...(d.derivedFrom === undefined ? {} : { derivedFrom: d.derivedFrom }),
          ...(d.orderId === undefined ? {} : { orderId: d.orderId }),
          ...(d.validUntil === undefined ? {} : { validUntil: d.validUntil }),
        }));
        return { status: 200, body: { customerId: session.customerId, documents, count: documents.length, asAt: deps.now() } };
      },
    },
    {
      // One of my documents in full — a quotation to accept, an invoice to pay. Another customer's → 404 as
      // "not yours" would confirm it exists; the scope decision above is what records probing, so this read
      // is answered only from MY documents.
      api: 'API-09', method: 'GET', path: '/v1/b2b-portal/me/documents/:documentId',
      permission: 'b2b.portal.self',
      entitlement: 'b2b',
      handler: async (ctx) => {
        const session = await meSession(ctx.tenantId, ctx.userId);
        const documentId = ctx.params['documentId'] ?? '';
        const mine = await scopedOrRefused(session, await deps.documents(ctx.tenantId, session.customerId), 'view_invoices', requested(ctx.query), 'read:document');
        const doc = mine.find((d) => d.documentId === documentId);
        if (doc === undefined) throw notFound(`document ${documentId} on your account`);
        return { status: 200, body: doc };
      },
    },
  ];
}
