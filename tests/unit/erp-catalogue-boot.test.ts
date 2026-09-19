import { describe, it, expect, afterEach } from 'vitest';
import { openPromotionLaunchPort, openPriceChangePort } from '../../apps/web-erp/src/browser-entry';
import type { PromotionLaunchInput } from '../../apps/web-erp/src/catalogue-session';
import { money } from '../../packages/contracts/src/money';

/**
 * **The promotion launch reaches head office under the operator's own session (M05-FR-03/04, API-02).**
 *
 * The catalogue screen simulates an offer in the browser, but a launch is a governed online action — it is
 * RECORDED at head office, which re-simulates the input and re-checks §28 for itself. `openPromotionLaunchPort`
 * is the one authenticated POST that carries the ask and reports back what the cloud decided. It must:
 *   • send the simulation INPUT (never a client-computed verdict) to `POST /v1/promotions/:id/launch`;
 *   • carry the §28 approver + reason alongside a margin-losing offer, for the cloud to verify;
 *   • surface the cloud's refusal verbatim, and NEVER report a launch that did not happen (P-08).
 */

const launchInput: PromotionLaunchInput = {
  input: {
    promotionId: 'promo-1', description: '10% off dal',
    normalPrice: money(145_00, 'INR'), promoPrice: money(130_00, 'INR'),
    unitCost: money(100_00, 'INR'), baselineUnits: 100, expectedUnits: 200,
  },
};

describe('the promotion launch POSTs to head office and reports back honestly (M05-FR-03/04)', () => {
  const originalFetch = (globalThis as { fetch?: typeof fetch }).fetch;
  afterEach(() => {
    if (originalFetch === undefined) delete (globalThis as { fetch?: typeof fetch }).fetch;
    else (globalThis as { fetch?: typeof fetch }).fetch = originalFetch;
  });

  it('POSTs the simulation input to the launch route under the operator\'s own session', async () => {
    const calls: { url: string; init: { method?: string; headers?: Record<string, string>; credentials?: string; body?: string } }[] = [];
    (globalThis as { fetch?: typeof fetch }).fetch = (async (url: string, init: Record<string, unknown>) => {
      calls.push({ url, init: init as never });
      return { status: 201, json: async () => ({ launched: true, verdict: 'improves_margin', approvedBy: null }) };
    }) as unknown as typeof fetch;

    const outcome = await openPromotionLaunchPort().post(launchInput);

    expect(outcome).toEqual({ launched: true, verdict: 'improves_margin', approvedBy: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/v1/promotions/promo-1/launch');
    expect(calls[0]?.init.method).toBe('POST');
    // The operator's OWN session, never a service token (§28, hard rule #4).
    expect(calls[0]?.init.credentials).toBe('same-origin');
    expect(calls[0]?.init.headers?.['idempotency-key']).toBeTruthy();
    // The body carries the simulation INPUT flattened — the cloud re-runs it and never trusts a client verdict.
    const body = JSON.parse(calls[0]?.init.body ?? '{}');
    expect(body.promotionId).toBe('promo-1');
    expect(body.normalPrice).toEqual(money(145_00, 'INR'));
    expect(body.promoPrice).toEqual(money(130_00, 'INR'));
    // A margin-improving offer carries no approver.
    expect(body.approvedBy).toBeUndefined();
  });

  it('carries the §28 approver + reason alongside a margin-losing offer', async () => {
    let sent: Record<string, unknown> = {};
    (globalThis as { fetch?: typeof fetch }).fetch = (async (_url: string, init: { body?: string }) => {
      sent = JSON.parse(init.body ?? '{}');
      return { status: 201, json: async () => ({ launched: true, verdict: 'below_floor', approvedBy: 'u-owner' }) };
    }) as unknown as typeof fetch;

    const outcome = await openPromotionLaunchPort().post({
      input: { ...launchInput.input, promoPrice: money(80_00, 'INR') },
      approval: { approvedBy: 'u-owner', rationale: 'footfall driver for Pongal' },
    });

    expect(outcome).toEqual({ launched: true, verdict: 'below_floor', approvedBy: 'u-owner' });
    // The name and reason ride ALONGSIDE the input; the cloud verifies the authority — a typed name is not one.
    expect(sent.approvedBy).toBe('u-owner');
    expect(sent.rationale).toBe('footfall driver for Pongal');
  });

  it('surfaces the cloud\'s refusal verbatim on a 422, and never a false launch (§28)', async () => {
    (globalThis as { fetch?: typeof fetch }).fetch = (async () => ({
      status: 422,
      json: async () => ({ launched: false, whatHappened: 'this offer loses margin and needs an authorised approver' }),
    })) as unknown as typeof fetch;

    const outcome = await openPromotionLaunchPort().post(launchInput);
    expect(outcome).toEqual({ launched: false, reason: 'this offer loses margin and needs an authorised approver' });
  });

  it('turns a dropped link into a refusal-with-reason, not a launch (P-08)', async () => {
    (globalThis as { fetch?: typeof fetch }).fetch = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;

    const outcome = await openPromotionLaunchPort().post(launchInput);
    expect(outcome.launched).toBe(false);
    if (outcome.launched) return;
    expect(outcome.reason).toMatch(/no connection to head office/i);
  });

  it('does not report a launch on a 2xx whose body does not confirm one', async () => {
    (globalThis as { fetch?: typeof fetch }).fetch = (async () => ({
      status: 200, json: async () => ({ alreadyLaunched: true }),
    })) as unknown as typeof fetch;

    const outcome = await openPromotionLaunchPort().post(launchInput);
    // Nothing said launched:true, so the screen must not claim one — it surfaces a plain reason instead.
    expect(outcome.launched).toBe(false);
  });

  it('refuses plainly when the runtime has no fetch at all', async () => {
    delete (globalThis as { fetch?: typeof fetch }).fetch;
    const outcome = await openPromotionLaunchPort().post(launchInput);
    expect(outcome.launched).toBe(false);
    if (outcome.launched) return;
    expect(outcome.reason).toMatch(/no connection to head office/i);
  });
});

/**
 * **The governed price change reaches head office under the operator's own session (M05-FR-02, API-02).**
 *
 * `openPriceChangePort` is the one authenticated POST that records a price change at head office, which re-runs
 * `checkPrice` (MRP ceiling / cost / margin floor) and re-checks §28 for itself. It must send the raw figures the
 * session assembled to `POST /v1/prices/changes`, carry the §28 approver + reason for a below-cost/below-floor
 * price, surface the cloud's refusal verbatim, and NEVER report a change that did not happen (P-08).
 */
const priceChange = {
  productId: 'p1', priceMinor: 150_00, mrpMinor: 160_00, costMinor: 100_00,
  currency: 'INR', marginFloorBps: 2000,
} as const;

describe('the price change POSTs to head office and reports back honestly (M05-FR-02)', () => {
  const originalFetch = (globalThis as { fetch?: typeof fetch }).fetch;
  afterEach(() => {
    if (originalFetch === undefined) delete (globalThis as { fetch?: typeof fetch }).fetch;
    else (globalThis as { fetch?: typeof fetch }).fetch = originalFetch;
  });

  it('POSTs the figures to the price-change route under the operator\'s own session', async () => {
    const calls: { url: string; init: { method?: string; headers?: Record<string, string>; credentials?: string; body?: string } }[] = [];
    (globalThis as { fetch?: typeof fetch }).fetch = (async (url: string, init: Record<string, unknown>) => {
      calls.push({ url, init: init as never });
      return { status: 201, json: async () => ({ productId: 'p1', priceMinor: 150_00, verdict: 'improves_margin', approvedBy: null }) };
    }) as unknown as typeof fetch;

    const outcome = await openPriceChangePort().post(priceChange);

    expect(outcome).toEqual({ saved: true, verdict: 'improves_margin', approvedBy: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/v1/prices/changes');
    expect(calls[0]?.init.method).toBe('POST');
    // The operator's OWN session, never a service token (§28, hard rule #4).
    expect(calls[0]?.init.credentials).toBe('same-origin');
    expect(calls[0]?.init.headers?.['idempotency-key']).toBeTruthy();
    // The body carries the raw figures — the cloud re-runs the guard over them and never trusts a client verdict.
    const body = JSON.parse(calls[0]?.init.body ?? '{}');
    expect(body).toMatchObject({ productId: 'p1', priceMinor: 150_00, mrpMinor: 160_00, costMinor: 100_00, currency: 'INR', marginFloorBps: 2000 });
    // A clean price carries no approval.
    expect(body.approval).toBeUndefined();
  });

  it('maps the §28 approver to the route\'s {decidedBy, reason} for a below-cost price', async () => {
    let sent: Record<string, unknown> = {};
    (globalThis as { fetch?: typeof fetch }).fetch = (async (_url: string, init: { body?: string }) => {
      sent = JSON.parse(init.body ?? '{}');
      return { status: 201, json: async () => ({ productId: 'p1', priceMinor: 90_00, verdict: 'below_cost', approvedBy: 'u-owner' }) };
    }) as unknown as typeof fetch;

    const outcome = await openPriceChangePort().post({
      ...priceChange, priceMinor: 90_00,
      approval: { approvedBy: 'u-owner', rationale: 'clearing short-dated stock' },
    });

    expect(outcome).toEqual({ saved: true, verdict: 'below_cost', approvedBy: 'u-owner' });
    // The screen's {approvedBy, rationale} becomes the route's {decidedBy, reason}; the cloud verifies the authority.
    expect(sent.approval).toEqual({ decidedBy: 'u-owner', reason: 'clearing short-dated stock' });
  });

  it('surfaces the cloud\'s refusal verbatim on a 422, and never a false change (MRP is a legal ceiling)', async () => {
    (globalThis as { fetch?: typeof fetch }).fetch = (async () => ({
      status: 422,
      json: async () => ({ code: 'price_above_mrp', whatHappened: 'The price is above the printed MRP — a legal ceiling no approval can lift.' }),
    })) as unknown as typeof fetch;

    const outcome = await openPriceChangePort().post({ ...priceChange, priceMinor: 200_00 });
    expect(outcome).toEqual({ saved: false, reason: 'The price is above the printed MRP — a legal ceiling no approval can lift.' });
  });

  it('turns a dropped link into a refusal-with-reason, not a change (P-08)', async () => {
    (globalThis as { fetch?: typeof fetch }).fetch = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;

    const outcome = await openPriceChangePort().post(priceChange);
    expect(outcome.saved).toBe(false);
    if (outcome.saved) return;
    expect(outcome.reason).toMatch(/no connection to head office/i);
  });

  it('does not report a change on a 2xx whose body carries no verdict', async () => {
    (globalThis as { fetch?: typeof fetch }).fetch = (async () => ({
      status: 200, json: async () => ({ ok: true }),
    })) as unknown as typeof fetch;

    const outcome = await openPriceChangePort().post(priceChange);
    expect(outcome.saved).toBe(false);
  });

  it('refuses plainly when the runtime has no fetch at all', async () => {
    delete (globalThis as { fetch?: typeof fetch }).fetch;
    const outcome = await openPriceChangePort().post(priceChange);
    expect(outcome.saved).toBe(false);
    if (outcome.saved) return;
    expect(outcome.reason).toMatch(/no connection to head office/i);
  });
});
