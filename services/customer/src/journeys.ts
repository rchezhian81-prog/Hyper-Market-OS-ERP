// API-06 Customer journeys worked out from the shop's own facts (M21-FR-02 · M21-FR-01 · M31-FR-03/04 · P-03 · P-08).
//
//   • THE FACTS. A signed-in customer's basket is kept on the shop as they fill it (`PUT /v1/me/cart`); a birthday or
//     anniversary is kept only when the customer gives it themselves and ticks yes (`POST /v1/me/occasions/:id`), and is
//     removed in one tap; the last purchase is read from the till's banked bills and the customer's online orders.
//   • THE TRIGGERS are worked out from those facts (`journeyTriggers`) and judged by the journey engine
//     (`findJourneyCandidates`: too soon is surveillance, too late is irrelevant, already done is an apology).
//   • SENDING IS OFF until a person with campaign authority switches a journey on, naming a template a second person
//     approved. Then each eligible candidate goes through the CAMPAIGN SEND — the consent ledger, the frequency cap, the
//     do-not-contact register and the budget — once per trigger. What was excluded and why is kept (P-08).
//   • The run is on head office's timer and on demand. Nothing here is AI and nothing here sets a price or an offer.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import { findJourneyCandidates, type JourneyKind, type JourneyCandidate } from '../../../packages/service-desk/src/campaigns';
import { journeyTriggers, JOURNEY_WINDOWS, type HeldCart, type Occasion, type Purchase } from '../../../packages/service-desk/src/journey-facts';
import { tobaccoAdvertisingRefusal } from '../../../packages/restricted-sales/src/advertising';

export const JOURNEY_KINDS: readonly JourneyKind[] = ['abandoned_cart', 'occasion', 'win_back'];

export interface CartFact { readonly customerRef: string; readonly lines: readonly { readonly productId: string; readonly quantityMinor: number }[]; readonly valueMinor: number; readonly updatedAt: string }
export interface JourneySwitch { readonly kind: JourneyKind; readonly on: boolean; readonly templateId?: string; readonly channel?: string; readonly by: string; readonly at: string; readonly reason: string }
export interface JourneyOutcome { readonly kind: JourneyKind; readonly ref: string; readonly customerRef: string; readonly campaignId: string; readonly outcome: 'queued' | 'not_queued'; readonly code?: string; readonly detail: string; readonly at: string }

export interface JourneyDeps {
  readonly carts: (tenantId: string) => Promise<readonly CartFact[]>;
  readonly recordCart: (tenantId: string, c: CartFact) => Promise<void>;
  /** The published value of a basket (the shop's own prices) — what an abandoned cart is worth. */
  readonly valueOf: (tenantId: string, lines: CartFact['lines']) => Promise<number>;
  readonly occasions: (tenantId: string) => Promise<readonly (Occasion & { readonly at: string })[]>;
  readonly recordOccasion: (tenantId: string, o: Occasion & { readonly at: string }) => Promise<void>;
  readonly purchases: (tenantId: string) => Promise<readonly Purchase[]>;
  /** The segment policy's own "lapsing" line, in days. */
  readonly lapsingAfterDays: (tenantId: string) => Promise<number>;
  readonly switches: (tenantId: string) => Promise<readonly JourneySwitch[]>;
  readonly recordSwitch: (tenantId: string, s: JourneySwitch) => Promise<void>;
  readonly outcomes: (tenantId: string) => Promise<readonly JourneyOutcome[]>;
  readonly recordOutcome: (tenantId: string, o: JourneyOutcome) => Promise<void>;
  /** One message through the campaign send (consent, cap, do-not-contact, budget, approved template). */
  readonly send: (tenantId: string, input: { readonly campaignId: string; readonly customerRef: string; readonly templateId: string; readonly channel: string; readonly values: Readonly<Record<string, string>> }) => Promise<{ readonly queued: true } | { readonly queued: false; readonly code: string; readonly detail: string }>;
  readonly today: (tenantId: string) => Promise<string>;
  /**
   * B15 (COTPA s.5): whether a product is tobacco on the product master. A journey message is a campaign: an abandoned-cart
   * reminder never counts — or is ever sent for — tobacco left in a basket.
   */
  readonly isTobacco?: (tenantId: string, productId: string) => Promise<boolean>;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const MONTH_DAY = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const latestBy = <T>(xs: readonly T[], key: (x: T) => string): T[] => { const m = new Map<string, T>(); for (const x of xs) m.set(key(x), x); return [...m.values()]; };
const shortHash = (s: string): string => { let h = 2166136261; for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h.toString(36); };
/** One campaign per trigger, so each trigger reaches its customer once (the send keys a message on campaign + customer). */
export const journeyCampaignId = (kind: JourneyKind, ref: string): string => `jr-${kind.replace('_', '-')}-${shortHash(ref)}-${shortHash(`${ref}|2`)}`.slice(0, 48);

/**
 * B15: the one advertising guard on a held basket — the tobacco in it is taken out before the basket can become a campaign
 * ("you left these in your basket"). A basket of nothing but tobacco is no reminder at all; the rest is valued again.
 */
async function withoutTobacco(deps: JourneyDeps, tenantId: string, c: CartFact): Promise<CartFact> {
  if (deps.isTobacco === undefined || c.lines.length === 0) return c;
  const tobacco = new Set<string>();
  for (const l of c.lines) if (await deps.isTobacco(tenantId, l.productId)) tobacco.add(l.productId);
  const refused = tobaccoAdvertisingRefusal('campaign', c.lines.map((l) => l.productId), (id) => tobacco.has(id));
  if (refused === undefined) return c;
  const lines = c.lines.filter((l) => !refused.tobaccoProductIds.includes(l.productId));
  return { ...c, lines, valueMinor: lines.length === 0 ? 0 : await deps.valueOf(tenantId, lines) };
}

async function candidatesOf(deps: JourneyDeps, tenantId: string, kind: JourneyKind): Promise<readonly JourneyCandidate[]> {
  const held = await Promise.all(latestBy(await deps.carts(tenantId), (c) => c.customerRef).map((c) => withoutTobacco(deps, tenantId, c)));
  const carts = held.filter((c) => c.lines.length > 0).map((c): HeldCart => ({ customerRef: c.customerRef, lineCount: c.lines.length, valueMinor: c.valueMinor, updatedAt: c.updatedAt }));
  const occasions = latestBy(await deps.occasions(tenantId), (o) => o.occasionId);
  const t = journeyTriggers({ kind, carts, occasions, purchases: await deps.purchases(tenantId), today: await deps.today(tenantId), lapsingAfterDays: await deps.lapsingAfterDays(tenantId) });
  return findJourneyCandidates({ kind, triggers: t.triggers, completedRefs: t.completedRefs, now: deps.now(), ...JOURNEY_WINDOWS[kind] });
}

const switchOf = (all: readonly JourneySwitch[], kind: JourneyKind): JourneySwitch | undefined => [...all].reverse().find((s) => s.kind === kind);

export async function runJourneys(deps: JourneyDeps, tenantId: string): Promise<{ readonly queued: number; readonly notQueued: number }> {
  const switches = await deps.switches(tenantId);
  const done = new Set((await deps.outcomes(tenantId)).filter((o) => o.outcome === 'queued').map((o) => o.ref));
  const tried = new Map<string, string>();
  for (const o of await deps.outcomes(tenantId)) if (o.outcome === 'not_queued') tried.set(o.ref, o.code ?? '');
  let queued = 0;
  let notQueued = 0;
  for (const kind of JOURNEY_KINDS) {
    const sw = switchOf(switches, kind);
    if (sw === undefined || !sw.on || sw.templateId === undefined || sw.channel === undefined) continue;
    for (const c of (await candidatesOf(deps, tenantId, kind)).filter((x) => x.eligible && !done.has(x.ref))) {
      const campaignId = journeyCampaignId(kind, c.ref);
      const r = await deps.send(tenantId, { campaignId, customerRef: c.customerRef, templateId: sw.templateId, channel: sw.channel, values: { value: `₹${(c.valueMinor / 100).toFixed(2)}` } });
      if (r.queued) {
        await deps.recordOutcome(tenantId, { kind, ref: c.ref, customerRef: c.customerRef, campaignId, outcome: 'queued', detail: `queued on ${sw.channel}`, at: deps.now() });
        queued += 1;
      } else if (tried.get(c.ref) !== r.code) {
        await deps.recordOutcome(tenantId, { kind, ref: c.ref, customerRef: c.customerRef, campaignId, outcome: 'not_queued', code: r.code, detail: r.detail, at: deps.now() });
        tried.set(c.ref, r.code);
        notQueued += 1;
      }
    }
  }
  return { queued, notQueued };
}

export function journeyRoutes(deps: JourneyDeps): readonly Route[] {
  const readLines = (v: unknown): CartFact['lines'] | undefined =>
    Array.isArray(v) && v.length <= 200 && v.every((l) => l !== null && typeof l === 'object' && isStr((l as Record<string, unknown>)['productId']) && Number.isSafeInteger((l as Record<string, unknown>)['quantityMinor']) && ((l as Record<string, unknown>)['quantityMinor'] as number) > 0)
      ? (v as { productId: string; quantityMinor: number }[]).map((l) => ({ productId: l.productId.trim(), quantityMinor: l.quantityMinor })) : undefined;
  return [
    {
      // My basket, kept on the shop while I am signed in (so a basket left on a bus is not lost). Body: { lines }.
      api: 'API-06', method: 'PUT', path: '/v1/me/cart',
      permission: 'storefront.order.place', entitlement: 'customer_app', idempotent: true,
      handler: async (ctx) => {
        const lines = readLines(((ctx.body ?? {}) as Record<string, unknown>)['lines']);
        if (lines === undefined) throw apiError(400, { code: 'not_readable_as_a_basket', whatHappened: 'A basket is { lines: [{ productId, quantityMinor > 0 }] } (an empty list clears it).', wasItSaved: 'not_saved', nextSafeAction: 'Nothing was saved.' });
        const c: CartFact = { customerRef: ctx.userId, lines, valueMinor: lines.length === 0 ? 0 : await deps.valueOf(ctx.tenantId, lines), updatedAt: deps.now() };
        await deps.recordCart(ctx.tenantId, c);
        return { status: 200, body: { cart: c } };
      },
    },
    {
      api: 'API-06', method: 'GET', path: '/v1/me/cart',
      permission: 'storefront.order.read', entitlement: 'customer_app',
      handler: async (ctx) => {
        const mine = latestBy((await deps.carts(ctx.tenantId)).filter((c) => c.customerRef === ctx.userId), (c) => c.customerRef)[0];
        return { status: 200, body: { cart: mine ?? null } };
      },
    },
    {
      // A birthday or anniversary I choose to give — kept only with my yes. Body: { kind, monthDay "MM-DD", consent: true }.
      api: 'API-06', method: 'POST', path: '/v1/me/occasions/:occasionId',
      permission: 'storefront.order.place', entitlement: 'customer_app', idempotent: true,
      handler: async (ctx) => {
        const id = ctx.params['occasionId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!ID.test(id) || (b['kind'] !== 'birthday' && b['kind'] !== 'anniversary') || typeof b['monthDay'] !== 'string' || !MONTH_DAY.test(b['monthDay'])) {
          throw apiError(400, { code: 'not_readable_as_an_occasion', whatHappened: 'An occasion is { kind: birthday | anniversary, monthDay: "MM-DD", consent: true }. The year is never asked.', wasItSaved: 'not_saved', nextSafeAction: 'Nothing was saved.' });
        }
        if (b['consent'] !== true) throw apiError(422, { code: 'consent_required', whatHappened: 'An occasion is kept only when you say yes to the shop keeping it.', wasItSaved: 'not_saved', nextSafeAction: 'Tick yes if you want the shop to remember it. Nothing was saved.' });
        const o = { occasionId: id, customerRef: ctx.userId, kind: b['kind'] as 'birthday' | 'anniversary', monthDay: b['monthDay'] as string, at: deps.now() };
        const prior = (await deps.occasions(ctx.tenantId)).find((x) => x.occasionId === id);
        if (prior !== undefined && prior.customerRef !== ctx.userId) throw apiError(409, { code: 'occasion_id_in_use', whatHappened: 'That id is taken.', wasItSaved: 'not_saved', nextSafeAction: 'Nothing was saved.' });
        await deps.recordOccasion(ctx.tenantId, o);
        return { status: 201, body: { occasion: o } };
      },
    },
    {
      api: 'API-06', method: 'POST', path: '/v1/me/occasions/:occasionId/remove',
      permission: 'storefront.order.place', entitlement: 'customer_app', idempotent: true,
      handler: async (ctx) => {
        const id = ctx.params['occasionId'] ?? '';
        const cur = latestBy((await deps.occasions(ctx.tenantId)).filter((o) => o.customerRef === ctx.userId), (o) => o.occasionId).find((o) => o.occasionId === id && o.removed !== true);
        if (cur === undefined) throw notFound(`occasion ${id}`);
        await deps.recordOccasion(ctx.tenantId, { ...cur, removed: true, at: deps.now() });
        return { status: 200, body: { occasionId: id, removed: true } };
      },
    },
    {
      api: 'API-06', method: 'GET', path: '/v1/me/occasions',
      permission: 'storefront.order.read', entitlement: 'customer_app',
      handler: async (ctx) => {
        const mine = latestBy((await deps.occasions(ctx.tenantId)).filter((o) => o.customerRef === ctx.userId), (o) => o.occasionId).filter((o) => o.removed !== true);
        return { status: 200, body: { occasions: mine.map((o) => ({ occasionId: o.occasionId, kind: o.kind, monthDay: o.monthDay })) } };
      },
    },
    {
      // Staff: each journey — on or off (and with which approved template), who it would reach now and who is held back
      // and why, and what was sent or refused. Reading sends nothing.
      api: 'API-06', method: 'GET', path: '/v1/service/journeys',
      permission: 'customer.campaign.read',
      handler: async (ctx) => {
        const switches = await deps.switches(ctx.tenantId);
        const outcomes = await deps.outcomes(ctx.tenantId);
        const journeys = [];
        for (const kind of JOURNEY_KINDS) {
          const sw = switchOf(switches, kind);
          const candidates = await candidatesOf(deps, ctx.tenantId, kind);
          journeys.push({
            kind, on: sw?.on === true, templateId: sw?.on === true ? sw.templateId : null, channel: sw?.on === true ? sw.channel : null, lastSwitch: sw ?? null,
            say: sw?.on === true ? `On — sends template ${sw.templateId} on ${sw.channel} through the campaign send (consent, cap, do-not-contact, budget).` : 'Off — nothing is sent until a person switches it on with an approved template.',
            candidates, eligibleCount: candidates.filter((c) => c.eligible).length,
            outcomes: outcomes.filter((o) => o.kind === kind).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 50),
          });
        }
        return { status: 200, body: { journeys, lapsingAfterDays: await deps.lapsingAfterDays(ctx.tenantId) } };
      },
    },
    {
      // Switch a journey on (naming its approved template and channel) or off. Body: { on, templateId?, channel?, reason }.
      api: 'API-06', method: 'PUT', path: '/v1/service/journeys/:kind',
      permission: 'customer.campaign.send', idempotent: true,
      handler: async (ctx) => {
        const kind = ctx.params['kind'] as JourneyKind;
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!JOURNEY_KINDS.includes(kind) || typeof b['on'] !== 'boolean' || !isStr(b['reason']) || (b['on'] === true && (!isStr(b['templateId']) || !['whatsapp', 'sms', 'email', 'push'].includes(String(b['channel']))))) {
          throw apiError(400, { code: 'not_readable_as_a_journey_switch', whatHappened: 'A journey switch is { on: true, templateId, channel (whatsapp/sms/email/push), reason } or { on: false, reason }, for abandoned_cart, occasion or win_back.', wasItSaved: 'not_saved', nextSafeAction: 'Nothing was changed.' });
        }
        const s: JourneySwitch = { kind, on: b['on'] as boolean, ...(b['on'] === true ? { templateId: (b['templateId'] as string).trim(), channel: String(b['channel']) } : {}), by: ctx.userId, at: deps.now(), reason: (b['reason'] as string).trim().slice(0, 300) };
        await deps.recordSwitch(ctx.tenantId, s);
        return { status: 200, body: { switch: s } };
      },
    },
    {
      // Staff: run the switched-on journeys now (they also run on head office's timer).
      api: 'API-06', method: 'POST', path: '/v1/service/journeys/run',
      permission: 'customer.campaign.send', idempotent: true,
      handler: async (ctx) => ({ status: 200, body: await runJourneys(deps, ctx.tenantId) }),
    },
  ];
}
