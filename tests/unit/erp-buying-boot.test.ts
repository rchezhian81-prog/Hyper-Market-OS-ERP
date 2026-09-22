import { describe, it, expect, afterEach } from 'vitest';
import {
  openProposePurchaseOrderPort, buyingPortsFromData, bootBuying, type BuyingData,
} from '../../apps/web-erp/src/browser-entry';
import { money } from '../../packages/contracts/src/money';

/**
 * **The buyer's PO reaches head office under the buyer's own session (M06-FR-02, API-03).**
 *
 * The buyer's screen used to issue a PO in the browser with a name typed into an "approved by" box.
 * `openProposePurchaseOrderPort` is the one authenticated POST that PROPOSES the order at head office,
 * where the requisitioner is attributed to the authenticated caller and issuing is a separate second
 * person's §28 act. It must:
 *   • POST `{ supplierId, lines }` to `/v1/purchase/orders/:poId` under the buyer's OWN session;
 *   • use the PO id as the idempotency key, so a re-click collapses to one order (never a duplicate);
 *   • carry NO approver (issuing is a separate act);
 *   • report `proposed:true` only on a 2xx that confirms it, surfacing any refusal verbatim, and turn a
 *     dropped link into an honest `proposed:false` — never a false "raised" (P-08).
 */

const LINES = [
  { productId: 'p1', orderedQty: 10, unitCost: money(50_00, 'INR') },
  { productId: 'p2', orderedQty: 4, unitCost: money(25_00, 'INR') },
];

describe('the PO proposal POSTs to head office and reports back honestly (M06-FR-02)', () => {
  const originalFetch = (globalThis as { fetch?: typeof fetch }).fetch;
  afterEach(() => {
    if (originalFetch === undefined) delete (globalThis as { fetch?: typeof fetch }).fetch;
    else (globalThis as { fetch?: typeof fetch }).fetch = originalFetch;
  });

  it('POSTs { supplierId, lines } to the PO route under the buyer\'s own session, keyed by the PO id', async () => {
    const calls: { url: string; init: { method?: string; headers?: Record<string, string>; credentials?: string; body?: string } }[] = [];
    (globalThis as { fetch?: typeof fetch }).fetch = (async (url: string, init: Record<string, unknown>) => {
      calls.push({ url, init: init as never });
      return { status: 201, json: async () => ({ order: { status: 'proposed', requisitionedBy: 'u-buyer', totalMinor: 60000 }, openCommitment: null }) };
    }) as unknown as typeof fetch;

    const outcome = await openProposePurchaseOrderPort().post({ poId: 'PO-1', supplierId: 'sup-1', lines: LINES });

    expect(outcome).toEqual({ proposed: true, requisitionedBy: 'u-buyer', totalMinor: 60000 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/v1/purchase/orders/PO-1');
    expect(calls[0]?.init.method).toBe('POST');
    // The buyer's OWN session, never a service token (§28, hard rule #4).
    expect(calls[0]?.init.credentials).toBe('same-origin');
    // The PO id is the idempotency key — a re-click of "raise" collapses to one order.
    expect(calls[0]?.init.headers?.['idempotency-key']).toBe('PO-1');
    const body = JSON.parse(calls[0]?.init.body ?? '{}');
    expect(body.supplierId).toBe('sup-1');
    expect(body.lines).toEqual([
      { productId: 'p1', orderedQty: 10, unitCost: { minor: 50_00, currency: 'INR' } },
      { productId: 'p2', orderedQty: 4, unitCost: { minor: 25_00, currency: 'INR' } },
    ]);
    // No approver rides with a proposal — issuing is a separate second person's act (§28).
    expect(JSON.stringify(body)).not.toContain('approv');
  });

  it('reports proposed on the idempotent re-send (200), not only the first 201', async () => {
    (globalThis as { fetch?: typeof fetch }).fetch = (async () => ({
      status: 200,
      json: async () => ({ order: { status: 'proposed', requisitionedBy: 'u-buyer', totalMinor: 60000 }, openCommitment: null, alreadyProposed: true }),
    })) as unknown as typeof fetch;

    const outcome = await openProposePurchaseOrderPort().post({ poId: 'PO-1', supplierId: 'sup-1', lines: LINES });
    expect(outcome).toEqual({ proposed: true, requisitionedBy: 'u-buyer', totalMinor: 60000 });
  });

  it('surfaces the cloud\'s refusal verbatim, and never a false raise', async () => {
    (globalThis as { fetch?: typeof fetch }).fetch = (async () => ({
      status: 422,
      json: async () => ({ code: 'purchase_order_currency_mismatch', whatHappened: 'Every line must be priced in one known currency.' }),
    })) as unknown as typeof fetch;

    const outcome = await openProposePurchaseOrderPort().post({ poId: 'PO-2', supplierId: 'sup-1', lines: LINES });
    expect(outcome).toEqual({ proposed: false, reason: 'Every line must be priced in one known currency.' });
  });

  it('turns a dropped link into a refusal-with-reason, not an order (P-08)', async () => {
    (globalThis as { fetch?: typeof fetch }).fetch = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;

    const outcome = await openProposePurchaseOrderPort().post({ poId: 'PO-3', supplierId: 'sup-1', lines: LINES });
    expect(outcome.proposed).toBe(false);
    if (outcome.proposed) return;
    expect(outcome.reason).toMatch(/no connection to head office/i);
  });

  it('does not report a raise on a 2xx whose body does not confirm a proposed order', async () => {
    (globalThis as { fetch?: typeof fetch }).fetch = (async () => ({
      status: 200, json: async () => ({ ok: true }),
    })) as unknown as typeof fetch;

    const outcome = await openProposePurchaseOrderPort().post({ poId: 'PO-4', supplierId: 'sup-1', lines: LINES });
    expect(outcome.proposed).toBe(false);
  });

  it('refuses plainly when the runtime has no fetch at all', async () => {
    delete (globalThis as { fetch?: typeof fetch }).fetch;
    const outcome = await openProposePurchaseOrderPort().post({ poId: 'PO-5', supplierId: 'sup-1', lines: LINES });
    expect(outcome.proposed).toBe(false);
    if (outcome.proposed) return;
    expect(outcome.reason).toMatch(/no connection to head office/i);
  });
});

/**
 * **The boot wiring only claims a cloud when a real port is present.** A box handed the propose port can
 * raise orders (`canProposeToCloud` true); one told nothing about buying boots no session; and the ports
 * builder omits `proposeOrder` entirely when no port is passed, so an offline box keeps its local compute.
 */
const DATA: BuyingData = { buyerId: 'u-buyer', productIds: ['p1', 'p2'] };

describe('bootBuying wires the propose port only when one is given (M06-FR-02)', () => {
  it('a box given the port can propose to the cloud', () => {
    const session = bootBuying(DATA, openProposePurchaseOrderPort());
    expect(session).not.toBeNull();
    expect(session!.canProposeToCloud).toBe(true);
  });

  it('a box with no port keeps local compute and cannot propose', () => {
    const session = bootBuying(DATA);
    expect(session).not.toBeNull();
    expect(session!.canProposeToCloud).toBe(false);
  });

  it('a box told nothing about buying boots no session', () => {
    expect(bootBuying(undefined, openProposePurchaseOrderPort())).toBeNull();
  });

  it('the ports builder omits proposeOrder when no port is passed', () => {
    expect(buyingPortsFromData(DATA).proposeOrder).toBeUndefined();
    expect(buyingPortsFromData(DATA, openProposePurchaseOrderPort()).proposeOrder).toBeTypeOf('function');
  });
});
