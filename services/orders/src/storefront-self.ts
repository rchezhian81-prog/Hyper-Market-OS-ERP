// The signed-in customer's own shopping records and service requests (round 8 · D08-FR-02 lists and favourites ·
// D08-FR-05 return/refund and complaints · M20 · WF-16 · WF-17 · §28 · P-04).
//
// Everything here is the customer's OWN, scoped from the session (the authenticated subject) — never from an id in the
// request; another customer's order is answered exactly as an order that does not exist (nothing about it leaks).
//
//   • FAVOURITES and LISTS — products from the shop's PUBLISHED catalogue only (an unknown product is refused by name).
//     Append-only: a change is a new version; the latest per list / per product is what the app shows.
//   • A COMPLAINT from the app opens a case on the service desk (WF-17) under the customer's own reference, about one
//     of their own orders when they name one — the desk works it from there (SLA clocks, reply, root cause).
//   • A RETURN REQUEST from the app (WF-16): only on the customer's own order once it has been delivered or collected,
//     only for lines on that order and no more than was ordered. It is RECORDED and opens a service case — it moves no
//     money and no stock: the desk receives the goods and refunds through the existing return and refund surfaces, by
//     people who hold those permissions (hard rules #2, #5).
//   • MY CASES — the customer's own cases, with the replies a person SENT them (the words exactly as approved).

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import type { ServiceCase } from '../../../packages/service-desk/src/index';
import type { PlacedOrder } from './index';

export interface FavouriteRecord { readonly customerRef: string; readonly productId: string; readonly favourite: boolean; readonly at: string }
export interface ShoppingListVersion {
  readonly customerRef: string; readonly listId: string; readonly version: number; readonly name: string;
  readonly items: readonly { readonly productId: string; readonly quantityMinor: number }[];
  readonly archived: boolean; readonly at: string;
}
export interface ReturnRequestRecord {
  readonly requestId: string; readonly customerRef: string; readonly orderId: string;
  readonly lines: readonly { readonly productId: string; readonly quantityMinor: number }[];
  readonly reason: string; readonly caseId: string; readonly at: string;
}

export interface StorefrontSelfDeps {
  /** Whether the shop's published catalogue carries this product. */
  readonly productKnown: (tenantId: string, productId: string) => Promise<boolean> | boolean;
  readonly placedOrder: (tenantId: string, orderId: string) => Promise<PlacedOrder | undefined> | PlacedOrder | undefined;
  readonly orderStateOf: (tenantId: string, orderId: string) => Promise<string | undefined> | string | undefined;
  readonly favourites: (tenantId: string, customerRef: string) => Promise<readonly FavouriteRecord[]> | readonly FavouriteRecord[];
  readonly recordFavourite: (tenantId: string, rec: FavouriteRecord, key: string) => Promise<void> | void;
  readonly lists: (tenantId: string, customerRef: string) => Promise<readonly ShoppingListVersion[]> | readonly ShoppingListVersion[];
  readonly recordList: (tenantId: string, rec: ShoppingListVersion, key: string) => Promise<void> | void;
  readonly returnRequests: (tenantId: string, customerRef: string) => Promise<readonly ReturnRequestRecord[]> | readonly ReturnRequestRecord[];
  readonly recordReturnRequest: (tenantId: string, rec: ReturnRequestRecord, key: string) => Promise<void> | void;
  /** The service desk's own case register (the same the desk reads). */
  readonly serviceCase: (tenantId: string, caseId: string) => Promise<ServiceCase | undefined> | ServiceCase | undefined;
  readonly serviceCases: (tenantId: string) => Promise<readonly ServiceCase[]> | readonly ServiceCase[];
  readonly openCase: (tenantId: string, c: ServiceCase) => Promise<void> | void;
  /** The replies a person sent on a case (words exactly as approved). */
  readonly sentReplies?: (tenantId: string, caseId: string) => Promise<readonly { readonly text: string; readonly at: string; readonly channel: string }[]>;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isPosInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** Where the desk picks up what a customer raised in the app — a queue, not a person, until somebody takes it. */
export const APP_CASE_QUEUE = 'service-desk';
const RETURNABLE = new Set(['delivered', 'collected']);

const readLines = (v: unknown): { productId: string; quantityMinor: number }[] | undefined => {
  if (!Array.isArray(v) || v.length === 0 || v.length > 200) return undefined;
  const out: { productId: string; quantityMinor: number }[] = [];
  for (const x of v) {
    if (x === null || typeof x !== 'object' || !isStr((x as Record<string, unknown>)['productId']) || !isPosInt((x as Record<string, unknown>)['quantityMinor'])) return undefined;
    out.push({ productId: (x as Record<string, string>)['productId']!, quantityMinor: (x as Record<string, number>)['quantityMinor']! });
  }
  return out;
};

export function storefrontSelfRoutes(deps: StorefrontSelfDeps): readonly Route[] {
  /** The customer's own order, or a 404 indistinguishable from an order that does not exist. */
  const ownOrder = async (tenantId: string, customerRef: string, orderId: string): Promise<PlacedOrder> => {
    const o = await deps.placedOrder(tenantId, orderId);
    if (o === undefined || o.customerRef !== customerRef) throw notFound(`order ${orderId}`);
    return o;
  };
  const unknownProducts = async (tenantId: string, ids: readonly string[]): Promise<string[]> => {
    const out: string[] = [];
    for (const id of new Set(ids)) if (!(await deps.productKnown(tenantId, id))) out.push(id);
    return out.sort();
  };
  const latestLists = async (tenantId: string, me: string): Promise<ShoppingListVersion[]> => {
    const byId = new Map<string, ShoppingListVersion>();
    for (const l of await deps.lists(tenantId, me)) if ((byId.get(l.listId)?.version ?? 0) < l.version) byId.set(l.listId, l);
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  };

  return [
    {
      api: 'API-06', method: 'GET', path: '/v1/me/favourites',
      permission: 'storefront.order.read', entitlement: 'customer_app',
      handler: async (ctx) => {
        const latest = new Map<string, FavouriteRecord>();
        for (const f of await deps.favourites(ctx.tenantId, ctx.userId)) latest.set(f.productId, f);
        const favourites = [...latest.values()].filter((f) => f.favourite).map((f) => ({ productId: f.productId, at: f.at })).sort((a, b) => a.productId.localeCompare(b.productId));
        return { status: 200, body: { favourites, count: favourites.length } };
      },
    },
    {
      // Mark (or unmark) a favourite. Body: { favourite: true | false }.
      api: 'API-06', method: 'POST', path: '/v1/me/favourites/:productId',
      permission: 'storefront.order.place', entitlement: 'customer_app', idempotent: true,
      handler: async (ctx) => {
        const productId = (ctx.params['productId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (productId === '' || typeof b['favourite'] !== 'boolean') {
          throw apiError(400, { code: 'not_readable_as_a_favourite', whatHappened: 'A favourite needs the product in the address and { favourite: true or false }.', wasItSaved: 'not_saved', nextSafeAction: 'Tap the heart again.' });
        }
        if ((await unknownProducts(ctx.tenantId, [productId])).length > 0) {
          throw apiError(422, { code: 'unknown_product', whatHappened: `The shop does not sell "${productId}".`, wasItSaved: 'not_saved', nextSafeAction: 'Pick something from the shop.' });
        }
        const rec: FavouriteRecord = { customerRef: ctx.userId, productId, favourite: b['favourite'] as boolean, at: deps.now() };
        await deps.recordFavourite(ctx.tenantId, rec, `${productId}-${rec.favourite}-${ctx.idempotencyKey ?? rec.at}`);
        return { status: 200, body: { productId, favourite: rec.favourite } };
      },
    },
    {
      api: 'API-06', method: 'GET', path: '/v1/me/lists',
      permission: 'storefront.order.read', entitlement: 'customer_app',
      handler: async (ctx) => {
        const lists = (await latestLists(ctx.tenantId, ctx.userId)).filter((l) => !l.archived)
          .map((l) => ({ listId: l.listId, name: l.name, version: l.version, items: l.items, at: l.at }));
        return { status: 200, body: { lists, count: lists.length } };
      },
    },
    {
      // Save a shopping list (a new version each time). Body: { name, items: [{ productId, quantityMinor }], archived? }.
      api: 'API-06', method: 'POST', path: '/v1/me/lists/:listId',
      permission: 'storefront.order.place', entitlement: 'customer_app', idempotent: true,
      handler: async (ctx) => {
        const listId = (ctx.params['listId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const archived = b['archived'] === true;
        const items = archived && b['items'] === undefined ? [] : readLines(b['items']);
        if (!ID.test(listId) || !isStr(b['name']) || (b['name'] as string).length > 60 || items === undefined || (b['archived'] !== undefined && typeof b['archived'] !== 'boolean')) {
          throw apiError(400, { code: 'not_readable_as_a_list', whatHappened: 'A list needs a short id, { name (≤ 60 characters), items: [{ productId, quantityMinor (a whole number above 0) }] (1–200), archived? }.', wasItSaved: 'not_saved', nextSafeAction: 'Name the list and add at least one thing.' });
        }
        const unknown = await unknownProducts(ctx.tenantId, items.map((i) => i.productId));
        if (unknown.length > 0) {
          throw apiError(422, { code: 'unknown_product', whatHappened: `The shop does not sell ${unknown.join(', ')}.`, wasItSaved: 'not_saved', nextSafeAction: 'Take those off the list and save it again.' });
        }
        const prior = (await deps.lists(ctx.tenantId, ctx.userId)).filter((l) => l.listId === listId);
        const version = Math.max(0, ...prior.map((l) => l.version)) + 1;
        const rec: ShoppingListVersion = { customerRef: ctx.userId, listId, version, name: (b['name'] as string).trim(), items, archived, at: deps.now() };
        await deps.recordList(ctx.tenantId, rec, `${listId}-${ctx.idempotencyKey ?? version}`);
        return { status: 201, body: { list: { listId, name: rec.name, version, items, archived } } };
      },
    },
    {
      // A complaint raised in the app — a case on the service desk. Body: { summary, orderRef? }.
      api: 'API-06', method: 'POST', path: '/v1/me/complaints/:complaintId',
      permission: 'storefront.order.place', entitlement: 'customer_app', idempotent: true,
      handler: async (ctx) => {
        const complaintId = (ctx.params['complaintId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!ID.test(complaintId) || !isStr(b['summary']) || (b['summary'] as string).length > 1_000 || (b['orderRef'] !== undefined && !isStr(b['orderRef']))) {
          throw apiError(400, { code: 'not_readable_as_a_complaint', whatHappened: 'A complaint needs { summary (≤ 1,000 characters), orderRef? }.', wasItSaved: 'not_saved', nextSafeAction: 'Tell us what went wrong.' });
        }
        if (isStr(b['orderRef'])) await ownOrder(ctx.tenantId, ctx.userId, b['orderRef'] as string);
        const caseId = `app-${complaintId}`;
        const held = await deps.serviceCase(ctx.tenantId, caseId);
        if (held !== undefined) {
          if (held.customerRef !== ctx.userId) throw apiError(409, { code: 'complaint_id_taken', whatHappened: 'That reference is already used.', wasItSaved: 'not_saved', nextSafeAction: 'Try again — the app picks a new reference.' });
          return { status: 200, body: { caseId, state: held.state, alreadyRaised: true } };
        }
        const c: ServiceCase = {
          caseId, tenantId: ctx.tenantId, kind: 'complaint', customerRef: ctx.userId, openedAt: deps.now(), assignedTo: APP_CASE_QUEUE,
          priority: 'normal', state: 'open', summary: (b['summary'] as string).trim(), ...(isStr(b['orderRef']) ? { orderRef: b['orderRef'] as string } : {}),
        };
        await deps.openCase(ctx.tenantId, c);
        return { status: 201, body: { caseId, state: 'open', tellTheCustomer: `We have your complaint (reference ${caseId}). Someone at the shop will reply.` } };
      },
    },
    {
      // A return request from the app (WF-16). Body: { lines: [{ productId, quantityMinor }], reason }.
      api: 'API-06', method: 'POST', path: '/v1/me/orders/:orderId/return-requests/:requestId',
      permission: 'storefront.order.place', entitlement: 'customer_app', idempotent: true,
      handler: async (ctx) => {
        const orderId = ctx.params['orderId'] ?? '';
        const requestId = (ctx.params['requestId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const lines = readLines(b['lines']);
        if (!ID.test(requestId) || lines === undefined || !isStr(b['reason']) || (b['reason'] as string).length > 500) {
          throw apiError(400, { code: 'not_readable_as_a_return_request', whatHappened: 'A return request needs { lines: [{ productId, quantityMinor }], reason (≤ 500 characters) }.', wasItSaved: 'not_saved', nextSafeAction: 'Choose what you want to return and say why.' });
        }
        const order = await ownOrder(ctx.tenantId, ctx.userId, orderId);
        const prior = (await deps.returnRequests(ctx.tenantId, ctx.userId)).find((r) => r.requestId === requestId);
        if (prior !== undefined) return { status: 200, body: { request: prior, alreadyRaised: true } };
        const state = (await deps.orderStateOf(ctx.tenantId, orderId)) ?? order.state;
        if (!RETURNABLE.has(state)) {
          throw apiError(409, { code: 'order_not_received_yet', whatHappened: `Order ${orderId} is ${state} — a return is asked for once you have the goods.`, wasItSaved: 'not_saved', nextSafeAction: state === 'cancelled' ? 'This order was cancelled; there is nothing to return.' : 'To change an order you have not received yet, cancel it or raise a complaint.' });
        }
        const ordered = new Map<string, number>();
        for (const l of order.lines) ordered.set(l.productId, (ordered.get(l.productId) ?? 0) + l.quantityMinor);
        const asked = new Map<string, number>();
        for (const r of await deps.returnRequests(ctx.tenantId, ctx.userId)) if (r.orderId === orderId) for (const l of r.lines) asked.set(l.productId, (asked.get(l.productId) ?? 0) + l.quantityMinor);
        for (const l of lines) {
          const room = (ordered.get(l.productId) ?? 0) - (asked.get(l.productId) ?? 0);
          if (l.quantityMinor > room) {
            throw apiError(422, { code: 'more_than_was_ordered', whatHappened: `${l.productId}: you asked to return ${l.quantityMinor}, but ${room <= 0 ? 'none is left to return on this order' : `only ${room} is left to return on this order`}.`, wasItSaved: 'not_saved', nextSafeAction: 'Ask for no more than you received.' });
          }
        }
        const caseId = `app-return-${requestId}`;
        const at = deps.now();
        const rec: ReturnRequestRecord = { requestId, customerRef: ctx.userId, orderId, lines, reason: (b['reason'] as string).trim(), caseId, at };
        await deps.recordReturnRequest(ctx.tenantId, rec, requestId);
        if (await deps.serviceCase(ctx.tenantId, caseId) === undefined) {
          await deps.openCase(ctx.tenantId, {
            caseId, tenantId: ctx.tenantId, kind: 'complaint', customerRef: ctx.userId, openedAt: at, assignedTo: APP_CASE_QUEUE, priority: 'normal', state: 'open', orderRef: orderId,
            summary: `Return requested in the app for order ${orderId}: ${lines.map((l) => `${l.quantityMinor} × ${l.productId}`).join(', ')} — ${rec.reason}`,
          });
        }
        return { status: 201, body: { request: rec, tellTheCustomer: `We have your return request (reference ${requestId}). The shop will tell you how to bring or send the goods back; nothing is refunded until they arrive.` } };
      },
    },
    {
      // My cases — the customer's own, with the replies a person sent and the return requests behind them.
      api: 'API-06', method: 'GET', path: '/v1/me/cases',
      permission: 'storefront.order.read', entitlement: 'customer_app',
      handler: async (ctx) => {
        const mine = (await deps.serviceCases(ctx.tenantId)).filter((c) => c.customerRef === ctx.userId).sort((a, b) => b.openedAt.localeCompare(a.openedAt));
        const returns = await deps.returnRequests(ctx.tenantId, ctx.userId);
        const cases = [];
        for (const c of mine) {
          const replies = deps.sentReplies === undefined ? [] : (await deps.sentReplies(ctx.tenantId, c.caseId)).map((r) => ({ text: r.text, at: r.at, channel: r.channel }));
          const ret = returns.find((r) => r.caseId === c.caseId);
          cases.push({ caseId: c.caseId, kind: c.kind, state: c.state, openedAt: c.openedAt, ...(c.orderRef === undefined ? {} : { orderRef: c.orderRef }), ...(c.resolvedAt === undefined ? {} : { resolvedAt: c.resolvedAt }), replies, ...(ret === undefined ? {} : { returnRequest: { requestId: ret.requestId, lines: ret.lines } }) });
        }
        return { status: 200, body: { cases, count: cases.length } };
      },
    },
  ];
}
