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
 *   • for a margin-losing offer, carry only the `approvalId` of the caller's own approved request (ADR-0024) —
 *     never an approver's name or a rationale;
 *   • surface the cloud's refusal verbatim with its code, and NEVER report a launch that did not happen (P-08).
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
    // A margin-improving offer carries no approval of any kind.
    expect(body.approvedBy).toBeUndefined();
    expect(body.approvalId).toBeUndefined();
  });

  it('a margin-losing offer carries ONLY the approval it names — never an approver\'s name or a rationale (ADR-0024)', async () => {
    let sent: Record<string, unknown> = {};
    (globalThis as { fetch?: typeof fetch }).fetch = (async (_url: string, init: { body?: string }) => {
      sent = JSON.parse(init.body ?? '{}');
      return { status: 201, json: async () => ({ launched: true, verdict: 'below_floor', approvedBy: 'u-owner' }) };
    }) as unknown as typeof fetch;

    const input = { ...launchInput.input, promoPrice: money(80_00, 'INR') };
    const outcome = await openPromotionLaunchPort().post({ input, approvalId: 'areq-7' });

    expect(outcome).toEqual({ launched: true, verdict: 'below_floor', approvedBy: 'u-owner' });
    // Exactly the simulation input plus the approval's id: head office reads who approved it from its own records.
    expect(sent).toEqual({ ...JSON.parse(JSON.stringify(input)), approvalId: 'areq-7' });
    expect(sent).not.toHaveProperty('approvedBy');
    expect(sent).not.toHaveProperty('rationale');
    expect(sent).not.toHaveProperty('approval');
  });

  it('surfaces the cloud\'s refusal verbatim with its code on a 422, and never a false launch (§28)', async () => {
    (globalThis as { fetch?: typeof fetch }).fetch = (async () => ({
      status: 422,
      json: async () => ({ error: { code: 'launch_needs_approval', whatHappened: 'this offer loses margin and needs a second person\'s approval' } }),
    })) as unknown as typeof fetch;

    const outcome = await openPromotionLaunchPort().post(launchInput);
    expect(outcome).toEqual({ launched: false, reason: 'this offer loses margin and needs a second person\'s approval', code: 'launch_needs_approval' });
  });

  it('a refusal with no words of its own still says plainly that nothing launched', async () => {
    (globalThis as { fetch?: typeof fetch }).fetch = (async () => ({
      status: 500, json: async () => { throw new Error('not json'); },
    })) as unknown as typeof fetch;

    const outcome = await openPromotionLaunchPort().post(launchInput);
    expect(outcome).toEqual({ launched: false, reason: 'head office did not launch the offer', code: 'http_500' });
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
 * `checkPrice` (MRP ceiling / cost / margin floor) and checks the approval itself. It must send the raw figures the
 * session assembled to `POST /v1/prices/changes`, carry ONLY the `approvalId` for a below-cost/below-floor price
 * (never a typed approver — ADR-0024), surface the cloud's refusal verbatim with its code, and NEVER report a change
 * that did not happen (P-08).
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
    // A clean price carries no approval of any kind — the body is exactly the six figures.
    expect(body).toEqual(priceChange);
  });

  it('a below-cost price carries ONLY the approval it names — never an approver\'s name or a reason (ADR-0024)', async () => {
    let sent: Record<string, unknown> = {};
    (globalThis as { fetch?: typeof fetch }).fetch = (async (_url: string, init: { body?: string }) => {
      sent = JSON.parse(init.body ?? '{}');
      return { status: 201, json: async () => ({ productId: 'p1', priceMinor: 90_00, verdict: 'below_cost', approvedBy: 'u-owner' }) };
    }) as unknown as typeof fetch;

    const outcome = await openPriceChangePort().post({ ...priceChange, priceMinor: 90_00, approvalId: 'areq-3' });

    expect(outcome).toEqual({ saved: true, verdict: 'below_cost', approvedBy: 'u-owner' });
    // The six figures and the approval's id: head office reads who approved it, and why, from its own records.
    expect(sent).toEqual({ ...priceChange, priceMinor: 90_00, approvalId: 'areq-3' });
    expect(sent).not.toHaveProperty('approval');
    expect(sent).not.toHaveProperty('approvedBy');
    expect(sent).not.toHaveProperty('rationale');
  });

  it('surfaces the cloud\'s refusal verbatim with its code on a 422, and never a false change (MRP is a legal ceiling)', async () => {
    (globalThis as { fetch?: typeof fetch }).fetch = (async () => ({
      status: 422,
      json: async () => ({ error: { code: 'price_above_mrp', whatHappened: 'The price is above the printed MRP — a legal ceiling no approval can lift.' } }),
    })) as unknown as typeof fetch;

    const outcome = await openPriceChangePort().post({ ...priceChange, priceMinor: 200_00 });
    expect(outcome).toEqual({ saved: false, reason: 'The price is above the printed MRP — a legal ceiling no approval can lift.', code: 'price_above_mrp' });
  });

  it('hands back the engine\'s approval refusal code, so the screen can say it in plain words', async () => {
    (globalThis as { fetch?: typeof fetch }).fetch = (async () => ({
      status: 422,
      json: async () => ({ error: { code: 'approver_named_without_approval', whatHappened: 'This names u-owner as approval.decidedBy, but naming a person is not their approval.' } }),
    })) as unknown as typeof fetch;

    const outcome = await openPriceChangePort().post({ ...priceChange, priceMinor: 90_00 });
    expect(outcome.saved).toBe(false);
    if (outcome.saved) return;
    expect(outcome.code).toBe('approver_named_without_approval');
  });

  it('turns a dropped link into a refusal-with-reason, not a change (P-08)', async () => {
    (globalThis as { fetch?: typeof fetch }).fetch = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;

    const outcome = await openPriceChangePort().post(priceChange);
    expect(outcome.saved).toBe(false);
    if (outcome.saved) return;
    expect(outcome.reason).toMatch(/no connection to head office/i);
    expect(outcome.code).toBe('lost_link');
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
