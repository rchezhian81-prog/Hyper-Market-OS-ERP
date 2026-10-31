import { describe, it, expect } from 'vitest';
import {
  createCatalogueSession, promotionLaunchBody,
  type CatalogueConfig, type CataloguePorts, type PromotionDefinitionPort, type PromotionLaunchPort, type PromotionSimulationInput,
} from '../../apps/web-erp/src/catalogue-session';
import { offerDefinitionBody, OFFER_KINDS, OFFER_DEFINITION_PROBLEMS, type OfferDefinitionInput } from '../../apps/web-erp/src/offer-definition';
import type { HttpAnswer } from '../../apps/web-erp/src/head-office-http';
import { PROMOTION_KINDS } from '../../packages/promotions/src/promotions';
import { money } from '../../packages/contracts/src/money';
import { apiHarness, type ApiHarness } from '../support/api-harness';

/**
 * **The Offer tab defines the offer's rule at head office, then Start works (M05-FR-03 · M05-FR-04 · re-audit 30 Oct 2026).**
 *
 * Before: the tab worked out an offer's margin and pressed Start, and head office refused every Start of a new offer with
 * `promotion_not_defined` — no screen ever told head office what the offer IS. Now the session sends the rule (kind,
 * products or group, whole shop days, coupon, members only, exclusive group, abuse cap, minimum spend) to head office's
 * own definition route, and these cases run against the REAL head-office surface (in memory, real routes, real permission
 * checks): the rule is recorded as a draft, Start then launches it and switches exactly that rule on; head office's
 * refusals come back in its own words; no answer claims nothing.
 */

const T = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ZONE = 'Asia/Kolkata';
const CONFIG: CatalogueConfig = { tenantId: T, storeId: 'store-1', userId: 'u-mgr', currency: 'INR', today: '2026-10-07', marginFloorBps: 2000, timeZone: ZONE };

const answerOf = (r: { status: number; body: unknown }): HttpAnswer => {
  if (r.status >= 200 && r.status < 300) return { result: 'ok', status: r.status, body: r.body };
  const err = (r.body as { error?: { code?: string; whatHappened?: string } } | null)?.error ?? {};
  return { result: 'refused', status: r.status, code: err.code ?? `http_${r.status}`, whatHappened: err.whatHappened ?? '' };
};

async function headOffice(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(T, 'u-owner');
  await h.provisionRole(T, 'u-mgr', 'store_manager');
  await h.provisionRole(T, 'u-cash', 'cashier');
  return h;
}

/** The two ports over the real head office, as `who`; every definition POST recorded. */
function wired(h: ApiHarness, who: string, sent: { promotionId: string; body: unknown }[] = []): Pick<CataloguePorts, 'definePromotion' | 'launchPromotion'> {
  let n = 0;
  const define: PromotionDefinitionPort = {
    post: async (promotionId, body) => {
      sent.push({ promotionId, body });
      n += 1;
      return answerOf(await h.request({ method: 'POST', path: `/v1/promotions/${encodeURIComponent(promotionId)}/definition`, userId: who, tenantId: T, body, idempotencyKey: `d-${who}-${n}` }));
    },
  };
  const launch: PromotionLaunchPort = {
    post: async (l) => {
      n += 1;
      const r = await h.request({ method: 'POST', path: `/v1/promotions/${encodeURIComponent(l.input.promotionId)}/launch`, userId: who, tenantId: T, body: promotionLaunchBody(l), idempotencyKey: `l-${who}-${n}` });
      const a = answerOf(r);
      if (a.result === 'ok') return { launched: true, verdict: String((a.body as { verdict?: unknown }).verdict), approvedBy: null };
      return a.result === 'refused' ? { launched: false, reason: a.whatHappened, code: a.code } : { launched: false, reason: 'lost', code: 'lost_link' };
    },
  };
  return { definePromotion: () => define, launchPromotion: () => launch };
}

function session(over: Partial<CataloguePorts> = {}) {
  return createCatalogueSession(CONFIG, {
    categories: () => [], products: () => [], priceEntries: () => [], costOf: () => ({ known: false, why: 'not told' }),
    barcodesInUse: () => [], promotions: () => [], shelfMap: () => null,
    ...over,
  });
}

const DAL_OFFER: OfferDefinitionInput = {
  promotionId: 'pongal-dal', kind: 'percent_off', startsOn: '2026-10-08', endsOn: '2026-10-10', productIds: 'p-dal, p-rice',
  percent: '10', coupon: 'PONGAL', memberOnly: true, exclusiveGroup: 'festival', maxApplications: '2', minSpend: '199.50',
};
const GOOD_SIM: PromotionSimulationInput = {
  promotionId: 'pongal-dal', description: 'pongal-dal', normalPrice: money(145_00, 'INR'), promoPrice: money(130_00, 'INR'),
  unitCost: money(100_00, 'INR'), baselineUnits: 100, expectedUnits: 200,
};
const definitionAt = async (h: ApiHarness, id: string) => (await h.request({ method: 'GET', path: `/v1/promotions/${id}/definition`, userId: 'u-owner', tenantId: T })).body as Record<string, unknown>;

describe('the offer\'s rule is built exactly as head office\'s definition route reads it', () => {
  it('offers every kind the engine computes except the bank-card offer, which is switched off (OB-305)', () => {
    expect([...OFFER_KINDS, 'bank_offer'].sort()).toEqual([...PROMOTION_KINDS].sort());
  });

  it('sends whole SHOP days (OB-610), exact paise and basis points, and the stacking, eligibility and abuse-cap fields', () => {
    const built = offerDefinitionBody(DAL_OFFER, ZONE);
    expect(built).toEqual({
      ok: true, promotionId: 'pongal-dal',
      body: {
        kind: 'percent_off', startsAt: '2026-10-07T18:30:00.000Z', endsAt: '2026-10-10T18:29:59.000Z',
        productIds: ['p-dal', 'p-rice'], percentBps: 1000, requiresCoupon: 'PONGAL', requiresMember: true,
        exclusiveGroup: 'festival', maxApplications: 2, minSpendMinor: 199_50,
      },
    });
  });

  it('sends only the chosen kind\'s figures — a number left in another kind\'s box never travels', () => {
    const multibuy = offerDefinitionBody({ promotionId: 'oil-3', kind: 'multibuy', startsOn: '2026-10-08', endsOn: '2026-10-08', productIds: 'p-oil', multibuyQty: '3', multibuyPrice: '99', percent: '50', amountOff: '5' }, ZONE);
    expect(multibuy.ok && multibuy.body).toEqual({ kind: 'multibuy', startsAt: '2026-10-07T18:30:00.000Z', endsAt: '2026-10-08T18:29:59.000Z', productIds: ['p-oil'], multibuyQty: 3, multibuyPriceMinor: 99_00 });
    const bundle = offerDefinitionBody({ promotionId: 'b-1', kind: 'bundle_price', startsOn: '2026-10-08', endsOn: '2026-10-09', bundleItems: 'p-rice x 2, p-dal×1', bundlePrice: '250' }, ZONE);
    expect(bundle.ok && bundle.body).toMatchObject({ bundleItems: [{ productId: 'p-rice', qty: 2 }, { productId: 'p-dal', qty: 1 }], bundlePriceMinor: 250_00 });
    const mix = offerDefinitionBody({ promotionId: 'm-1', kind: 'mix_match', startsOn: '2026-10-08', endsOn: '2026-10-09', buyGroup: 'biscuits', getProductIds: 'p-tea', buyQty: '2', getQty: '1', percent: '100' }, ZONE);
    expect(mix.ok && mix.body).toMatchObject({ buyGroup: 'biscuits', getProductIds: ['p-tea'], buyQty: 2, getQty: 1, getPercentBps: 10_000 });
    expect(mix.ok && mix.body).not.toHaveProperty('percentBps');
    const member = offerDefinitionBody({ promotionId: 'mp', kind: 'member_price', startsOn: '2026-10-08', endsOn: '2026-10-09', productIds: 'p-ghee', memberPrice: '540.5' }, ZONE);
    expect(member.ok && member.body).toMatchObject({ memberUnitPrice: { minor: 540_50, currency: 'INR' } });
  });

  it('says why nothing could be sent: no name, no kind, days missing or backwards, a figure that is not a number, a set it cannot read', () => {
    const problem = (over: Partial<OfferDefinitionInput>) => { const b = offerDefinitionBody({ ...DAL_OFFER, ...over }, ZONE); return b.ok ? 'ok' : b.problem; };
    expect(problem({ promotionId: '  ' })).toBe('needs_name');
    expect(problem({ kind: 'bank_offer' })).toBe('needs_kind');
    expect(problem({ startsOn: '' })).toBe('needs_days');
    expect(problem({ endsOn: '2026-10-01' })).toBe('needs_days');
    expect(problem({ percent: 'ten' })).toBe('not_a_number');
    expect(problem({ maxApplications: '1.5' })).toBe('not_a_number');
    expect(problem({ kind: 'bundle_price', bundleItems: 'rice and dal' })).toBe('bad_bundle_line');
    expect(OFFER_DEFINITION_PROBLEMS).toEqual(['needs_name', 'needs_kind', 'needs_days', 'not_a_number', 'bad_bundle_line']);
  });
});

describe('the Offer tab against the real head office: define, then Start works', () => {
  it('Start before the rule is refused by head office (promotion_not_defined); define it, and Start launches EXACTLY that rule', async () => {
    const h = await headOffice();
    const s = session(wired(h, 'u-mgr'));
    expect(s.canDefineOffer).toBe(true);
    const early = await s.launchToCloud({ input: GOOD_SIM });
    expect(early).toMatchObject({ launched: false, code: 'promotion_not_defined' });

    const defined = await s.defineOffer(DAL_OFFER);
    expect(defined).toEqual({ kind: 'defined', promotionId: 'pongal-dal', status: 'draft', startsAt: '2026-10-07T18:30:00.000Z', endsAt: '2026-10-10T18:29:59.000Z' });
    // A DRAFT — it applies to nothing until it is launched.
    expect(await definitionAt(h, 'pongal-dal')).toMatchObject({ status: 'draft', exclusiveGroup: 'festival', maxApplications: 2, requiresCoupon: 'PONGAL', requiresMember: true, minSpendMinor: 199_50, percentBps: 1000 });

    expect(await s.launchToCloud({ input: GOOD_SIM })).toMatchObject({ launched: true });
    // The launch switched THAT rule on — what the lanes apply is what was defined.
    expect(await definitionAt(h, 'pongal-dal')).toMatchObject({ status: 'active', exclusiveGroup: 'festival', maxApplications: 2 });
  });

  it('head office\'s refusals come back in its own words: the same name twice, a role that may not, a kind it cannot read', async () => {
    const h = await headOffice();
    const s = session(wired(h, 'u-mgr'));
    expect((await s.defineOffer(DAL_OFFER)).kind).toBe('defined');
    const twice = await s.defineOffer(DAL_OFFER);
    expect(twice).toMatchObject({ kind: 'refused', code: 'promotion_already_defined' });
    if (twice.kind === 'refused') expect(twice.whatHappened).toContain('already exists');

    const cashier = await session(wired(h, 'u-cash')).defineOffer({ ...DAL_OFFER, promotionId: 'cash-try' });
    expect(cashier).toMatchObject({ kind: 'refused', code: 'forbidden' });

    // Head office reads the kind's parameters: a percent offer with no percentage is not an offer.
    const vague = await s.defineOffer({ ...DAL_OFFER, promotionId: 'no-pct', percent: '' });
    expect(vague).toMatchObject({ kind: 'refused', code: 'not_readable_as_a_promotion' });
  });

  it('a problem on the screen sends nothing; no answer claims nothing; no head office says so', async () => {
    const h = await headOffice();
    const sent: { promotionId: string; body: unknown }[] = [];
    expect(await session(wired(h, 'u-mgr', sent)).defineOffer({ ...DAL_OFFER, startsOn: '' })).toEqual({ kind: 'invalid', problem: 'needs_days' });
    expect(sent).toEqual([]);
    const lost: PromotionDefinitionPort = { post: async () => ({ result: 'lost_link' }) };
    expect(await session({ definePromotion: () => lost }).defineOffer(DAL_OFFER)).toEqual({ kind: 'lost_link' });
    const vague: PromotionDefinitionPort = { post: async () => ({ result: 'ok', status: 201, body: {} }) };
    expect(await session({ definePromotion: () => vague }).defineOffer(DAL_OFFER)).toMatchObject({ kind: 'refused', code: 'unreadable_answer' });
    const bare = session();
    expect(bare.canDefineOffer).toBe(false);
    expect(await bare.defineOffer(DAL_OFFER)).toEqual({ kind: 'not_connected' });
  });
});
