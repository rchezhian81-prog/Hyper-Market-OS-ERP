// API-07 The signed-in customer's own account controls, suggestions and help (M20-FR-04 · M20-FR-02 · A05 · AI-NFR-11 ·
// OB-314 · OB-296 · P-04 · hard rule #3).
//
//   • SAVED ADDRESSES (M20-FR-04 "account controls … addresses"): a short label, the location kept to about 100 m, and an
//     optional landmark — nothing more is kept (minimised, P-04). Removing one is one tap and a fact on the record; a
//     removed address is never offered again. Full erasure is the privacy centre's erasure request.
//   • SAVED PAYMENTS: the shop keeps NO card (hard rule #3) and no payment provider is connected, so there is nothing
//     saved to remove — said plainly, with a remove control that answers the same (a stand-in until a provider exists).
//   • RECOMMENDATIONS (M20-FR-02 "consent-safe"): "customers who bought this also bought" from the shop's own banked bills,
//     and "you bought this before" ONLY when the customer said yes to their purchases being used to suggest things
//     (the `profiling` consent on their own ledger). Without it, nothing of their history is read.
//   • HELP (A05, customer side): plain answers to the questions customers ask most — where is my order (their OWN order
//     only, through the A05 service assistant, which is stopped when the AI switch is off), the return windows, and how
//     delivery is charged — each from the shop's own records and marked as an automatic answer (AI-NFR-11). No free text
//     (OB-296). Anything it cannot answer is handed to a person (a case on the service desk).

import type { Route, RequestContext } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import { recommend } from '../../../packages/storefront/src/browse';

export interface SavedAddress {
  readonly addressId: string;
  readonly customerRef: string;
  readonly label: string;
  readonly location: { readonly lat: number; readonly lon: number };
  readonly landmark?: string;
  readonly change: 'saved' | 'removed';
  readonly at: string;
}

/** OB-314 / AI-NFR-11: the plain notice on every automatic help answer, in both languages. */
export const HELP_ANSWER_NOTICE = Object.freeze({
  en: 'This answer was given automatically by the shop\'s assistant, from the shop\'s own records. Not right? Ask a person — one tap below.',
  ta: 'இந்தப் பதில் கடையின் உதவியாளரால், கடையின் சொந்தப் பதிவுகளிலிருந்து தானாக வழங்கப்பட்டது. சரியில்லையா? ஒருவரிடம் கேளுங்கள் — கீழே ஒரே தட்டல்.',
});

export type HelpTopic = 'order_status' | 'return_policy' | 'delivery_charges';
export const HELP_TOPICS: readonly HelpTopic[] = ['order_status', 'return_policy', 'delivery_charges'];

export interface StorefrontAccountDeps {
  readonly addresses: (tenantId: string, customerRef: string) => Promise<readonly SavedAddress[]>;
  readonly recordAddress: (tenantId: string, a: SavedAddress) => Promise<void>;
  /** The customer's own consent records (their ledger), for the `profiling` gate on personal suggestions. */
  readonly consentRecords: (tenantId: string, customerRef: string) => Promise<readonly { readonly purpose: string; readonly given: boolean; readonly recordedAt: string }[]>;
  /** How often each product was bought together with `productId` on banked bills in the last 90 days. */
  readonly alsoBought: (tenantId: string, productId: string) => Promise<readonly { readonly productId: string; readonly count: number }[]>;
  /** What this customer bought online before, with when. */
  readonly boughtBefore: (tenantId: string, customerRef: string) => Promise<readonly { readonly productId: string; readonly lastBoughtAt: string }[]>;
  /** Whether a product is on the shop's catalogue now (suggestions name only real, sellable products). */
  readonly sellable: (tenantId: string, productId: string) => Promise<boolean>;
  /** A05: the service assistant's order answer for an order (the staff-side engine), or that it is not running. */
  readonly a05OrderAnswer: (tenantId: string, orderId: string) => Promise<{ readonly answered: boolean; readonly agentActive: boolean; readonly text: string }>;
  /** The order's owner, to scope the answer to the customer's OWN order. */
  readonly orderOwner: (tenantId: string, orderId: string) => Promise<string | undefined>;
  /** The shop's return windows in words, or that they are not set (OB-213). */
  readonly returnPolicyWords: (tenantId: string) => Promise<string>;
  /** How delivery is charged now, in words, from the serviceability policy in force. */
  readonly deliveryWords: (tenantId: string) => Promise<string>;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

/** The latest state of each of my addresses — removed ones left out. */
function currentAddresses(all: readonly SavedAddress[]): readonly SavedAddress[] {
  const latest = new Map<string, SavedAddress>();
  for (const a of all) latest.set(a.addressId, a);
  return [...latest.values()].filter((a) => a.change === 'saved').sort((a, b) => a.label.localeCompare(b.label));
}

/** The latest consent for a purpose on any channel — given? */
function consented(records: readonly { readonly purpose: string; readonly given: boolean; readonly recordedAt: string }[], purpose: string): boolean {
  let latest: { readonly given: boolean; readonly recordedAt: string } | undefined;
  for (const r of records) if (r.purpose === purpose && (latest === undefined || r.recordedAt >= latest.recordedAt)) latest = r;
  return latest?.given === true;
}

const view = (a: SavedAddress) => ({ addressId: a.addressId, label: a.label, location: a.location, ...(a.landmark === undefined ? {} : { landmark: a.landmark }), savedAt: a.at });

export function storefrontAccountRoutes(deps: StorefrontAccountDeps): readonly Route[] {
  const mine = async (ctx: RequestContext) => currentAddresses(await deps.addresses(ctx.tenantId, ctx.userId));
  return [
    {
      api: 'API-07', method: 'GET', path: '/v1/me/addresses',
      permission: 'storefront.order.read', entitlement: 'customer_app',
      handler: async (ctx) => {
        const list = await mine(ctx);
        return { status: 200, body: { addresses: list.map(view), count: list.length, kept: 'A label, the location to about 100 metres, and a landmark if you give one — nothing more.' } };
      },
    },
    {
      // Save an address. Body: { label (≤ 30), location: { lat, lon }, landmark? (≤ 80) }.
      api: 'API-07', method: 'POST', path: '/v1/me/addresses/:addressId',
      permission: 'storefront.order.place', entitlement: 'customer_app', idempotent: true,
      handler: async (ctx) => {
        const addressId = ctx.params['addressId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const loc = (b['location'] ?? {}) as Record<string, unknown>;
        const landmark = typeof b['landmark'] === 'string' ? b['landmark'].trim() : '';
        if (!ID.test(addressId) || !isStr(b['label']) || (b['label'] as string).trim().length > 30 || typeof loc['lat'] !== 'number' || typeof loc['lon'] !== 'number'
          || Math.abs(loc['lat']) > 90 || Math.abs(loc['lon']) > 180 || landmark.length > 80) {
          throw apiError(400, { code: 'not_readable_as_an_address', whatHappened: 'An address needs { label (up to 30 letters), location: { lat, lon }, landmark? (up to 80) }.', wasItSaved: 'not_saved', nextSafeAction: 'Nothing was saved.' });
        }
        if ((await mine(ctx)).length >= 10 && !(await mine(ctx)).some((a) => a.addressId === addressId)) {
          throw apiError(409, { code: 'too_many_addresses', whatHappened: 'You can keep up to 10 addresses. Remove one first.', wasItSaved: 'not_saved', nextSafeAction: 'Nothing was saved.' });
        }
        const a: SavedAddress = {
          addressId, customerRef: ctx.userId, label: (b['label'] as string).trim(), change: 'saved', at: deps.now(),
          location: { lat: Math.round((loc['lat'] as number) * 1000) / 1000, lon: Math.round((loc['lon'] as number) * 1000) / 1000 },
          ...(landmark === '' ? {} : { landmark }),
        };
        await deps.recordAddress(ctx.tenantId, a);
        return { status: 201, body: { address: view(a) } };
      },
    },
    {
      // Remove an address — one tap; a fact, the address is not offered again.
      api: 'API-07', method: 'POST', path: '/v1/me/addresses/:addressId/remove',
      permission: 'storefront.order.place', entitlement: 'customer_app', idempotent: true,
      handler: async (ctx) => {
        const addressId = ctx.params['addressId'] ?? '';
        const a = (await mine(ctx)).find((x) => x.addressId === addressId);
        if (a === undefined) throw notFound(`address ${addressId}`);
        await deps.recordAddress(ctx.tenantId, { ...a, change: 'removed', at: deps.now() });
        return { status: 200, body: { addressId, removed: true } };
      },
    },
    {
      // Saved payments: none — the shop keeps no card and no provider is connected (hard rule #3).
      api: 'API-07', method: 'GET', path: '/v1/me/payment-methods',
      permission: 'storefront.order.read', entitlement: 'customer_app',
      handler: () => ({ status: 200, body: { saved: [], providerConnected: false, say: 'The shop keeps no card details. Nothing is saved for paying, so there is nothing to remove. You pay through the payment provider\'s own screen each time.' } }),
    },
    {
      api: 'API-07', method: 'POST', path: '/v1/me/payment-methods/:methodRef/remove',
      permission: 'storefront.order.place', entitlement: 'customer_app', idempotent: true,
      handler: () => ({ status: 200, body: { removed: false, saved: [], say: 'Nothing was saved for paying, so nothing needed removing.' } }),
    },
    {
      // Consent-safe suggestions for a product (M20-FR-02): bought together by everyone; "you bought before" only with
      // the customer's own yes to profiling. Query: productId.
      api: 'API-07', method: 'GET', path: '/v1/storefront/recommendations',
      permission: 'storefront.order.read', entitlement: 'customer_app',
      handler: async (ctx) => {
        const productId = (ctx.query['productId'] ?? '').trim();
        if (productId === '') throw apiError(400, { code: 'product_not_given', whatHappened: 'Suggestions are for one product: send ?productId=…', wasItSaved: 'not_saved', nextSafeAction: 'Nothing was read.' });
        const records = await deps.consentRecords(ctx.tenantId, ctx.userId);
        const mayPersonalise = consented(records, 'profiling');
        const aggregate = (await deps.alsoBought(ctx.tenantId, productId)).filter((p) => p.productId !== productId);
        // Nothing of the customer's history is read without their yes.
        const history = mayPersonalise ? (await deps.boughtBefore(ctx.tenantId, ctx.userId)).filter((p) => p.productId !== productId) : [];
        const out = recommend({ customerRef: ctx.userId, consents: mayPersonalise ? ['profiling'] : [], aggregateAlsoBought: aggregate, ...(mayPersonalise ? { personalHistory: history } : {}), limit: 6 });
        const sellable: typeof out.recommendations[number][] = [];
        for (const r of out.recommendations) if (await deps.sellable(ctx.tenantId, r.productId)) sellable.push(r);
        return {
          status: 200,
          body: {
            productId, recommendations: sellable, personalised: mayPersonalise,
            say: mayPersonalise ? 'Including things you bought before, because you said yes to that.' : 'From what other customers bought together — not from what you bought, because you have not said yes to that.',
          },
        };
      },
    },
    {
      // A05 for the customer: a plain answer from the shop's own records, marked as automatic; anything else goes to a
      // person. Body: { topic: order_status | return_policy | delivery_charges, orderId? }. No free text (OB-296).
      api: 'API-07', method: 'POST', path: '/v1/me/help/answers',
      permission: 'storefront.order.read', entitlement: 'customer_app', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const topic = b['topic'] as HelpTopic;
        if (!HELP_TOPICS.includes(topic) || b['question'] !== undefined || (topic === 'order_status' && !isStr(b['orderId']))) {
          throw apiError(400, { code: 'not_readable_as_a_help_question', whatHappened: 'Choose a question: { topic: "order_status", orderId } or { topic: "return_policy" } or { topic: "delivery_charges" }. Typed questions go to a person.', wasItSaved: 'not_saved', nextSafeAction: 'Nothing was asked.' });
        }
        const base = { notice: HELP_ANSWER_NOTICE, committedAnything: false, askAPerson: 'POST /v1/me/complaints/:complaintId' };
        if (topic === 'order_status') {
          const orderId = (b['orderId'] as string).trim();
          // Only the customer's OWN order is answered about — another's is "not found", never described.
          if ((await deps.orderOwner(ctx.tenantId, orderId)) !== ctx.userId) throw notFound(`order ${orderId}`);
          const a = await deps.a05OrderAnswer(ctx.tenantId, orderId);
          if (!a.agentActive || !a.answered) {
            return { status: 200, body: { ...base, answered: false, escalate: true, topic, said: 'The shop\'s assistant cannot answer this just now. Ask a person and the shop will reply.' } };
          }
          return { status: 200, body: { ...base, answered: true, escalate: false, topic, text: a.text, source: 'the order register' } };
        }
        const text = topic === 'return_policy' ? await deps.returnPolicyWords(ctx.tenantId) : await deps.deliveryWords(ctx.tenantId);
        return { status: 200, body: { ...base, answered: true, escalate: false, topic, text, source: topic === 'return_policy' ? 'the shop\'s return windows (store setup)' : 'the shop\'s delivery charges (store setup)' } };
      },
    },
  ];
}
