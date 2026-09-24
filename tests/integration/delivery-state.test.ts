import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// The order's delivery lifecycle on the live surface (API-08 · M19-FR-03 · hard rule #6 · P-08). The full
// tested delivery state machine (packages/fulfilment/src/delivery.ts) made durable per order: a stop leaves
// `assigned` only by `depart`, is `deliver`ed WITH PROOF or `fail`ed, and a failed stop is `reattempt`ed or
// returned to origin — never a silence. The machine refuses an out-of-order step and a proofless delivery
// BEFORE anything is written, every step is append-only in the driver's own name, and a dispatcher can read
// where any order has got to.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const transition = (h: ApiHarness, u: string, orderId: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/delivery/orders/${orderId}/transition`, userId: u, tenantId: A, idempotencyKey: key, body });
const readOrder = (h: ApiHarness, u: string, orderId: string) =>
  h.request({ method: 'GET', path: `/v1/delivery/orders/${orderId}`, userId: u, tenantId: A });

interface StateBody { readonly orderId: string; readonly state: string; readonly final: boolean; readonly history?: readonly { readonly event: string; readonly to: string; readonly proofRef?: string }[] }

describe('the order delivery lifecycle (M19-FR-03 state machine, made durable)', () => {
  it('walks assigned → out_for_delivery → delivered (with proof), and reads the state + history back', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.enableFeature(A, 'delivery'); // this shop's plan includes home delivery (M36-FR-01)

    // An order not yet moved reads as `assigned` — the machine's start, with no history.
    const before = (await readOrder(h, 'u-owner', 'ord-1')).body as StateBody;
    expect(before.state).toBe('assigned');
    expect(before.final).toBe(false);
    expect(before.history).toEqual([]);

    expect((await transition(h, 'u-owner', 'ord-1', { event: 'depart' }, 'd1')).status).toBe(200);
    const depart = (await transition(h, 'u-owner', 'ord-1', { event: 'depart' }, 'd1-dup')).status; // (already out) 409
    expect(depart).toBe(409);

    const delivered = await transition(h, 'u-owner', 'ord-1', { event: 'deliver', proof: { kind: 'otp', ref: 'OTP-4821' } }, 'd2');
    expect(delivered.status).toBe(200);
    expect((delivered.body as StateBody).state).toBe('delivered');
    expect((delivered.body as StateBody).final).toBe(true);

    const after = (await readOrder(h, 'u-owner', 'ord-1')).body as StateBody;
    expect(after.state).toBe('delivered');
    expect(after.final).toBe(true);
    expect(after.history!.map((s) => s.event)).toEqual(['depart', 'deliver']);
    // The proof rides with the delivered step — evidence and state can never drift apart (#6).
    expect(after.history!.find((s) => s.event === 'deliver')!.proofRef).toBe('OTP-4821');
  });

  it('walks the full path assigned → picked_up → out_for_delivery → attempted → partially_delivered (with proof)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.enableFeature(A, 'delivery');

    expect((await transition(h, 'u-owner', 'ord-p', { event: 'pick_up' }, 'p-1')).status).toBe(200);
    expect(((await readOrder(h, 'u-owner', 'ord-p')).body as StateBody).state).toBe('picked_up');
    expect((await transition(h, 'u-owner', 'ord-p', { event: 'depart' }, 'p-2')).status).toBe(200);
    expect((await transition(h, 'u-owner', 'ord-p', { event: 'arrive' }, 'p-3')).status).toBe(200);
    expect(((await readOrder(h, 'u-owner', 'ord-p')).body as StateBody).state).toBe('attempted');

    // A partial delivery hands SOME lines over — so it needs proof, like a full delivery, and it is a
    // terminal outcome (the undelivered remainder is put right by a compensating money/stock event).
    const partial = await transition(h, 'u-owner', 'ord-p', { event: 'deliver_partial', proof: { kind: 'photo', ref: 'PH-77' } }, 'p-4');
    expect(partial.status).toBe(200);
    expect((partial.body as StateBody).state).toBe('partially_delivered');
    expect((partial.body as StateBody).final).toBe(true);

    const after = (await readOrder(h, 'u-owner', 'ord-p')).body as StateBody;
    expect(after.history!.map((s) => s.event)).toEqual(['pick_up', 'depart', 'arrive', 'deliver_partial']);
    expect(after.history!.find((s) => s.event === 'deliver_partial')!.proofRef).toBe('PH-77'); // proof rides with the hand-over (#6)
    // Terminal — a partially delivered order accepts nothing more.
    expect((await transition(h, 'u-owner', 'ord-p', { event: 'rto' }, 'p-5')).status).toBe(409);
  });

  it('refuses a partial delivery without proof — the state does not move', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.enableFeature(A, 'delivery');
    await transition(h, 'u-owner', 'ord-pp', { event: 'depart' }, 'pp-1');
    const noProof = await transition(h, 'u-owner', 'ord-pp', { event: 'deliver_partial' }, 'pp-2');
    expect(noProof.status).toBe(422);
    expect(codeOf(noProof)).toBe('delivered_without_proof');
    expect(((await readOrder(h, 'u-owner', 'ord-pp')).body as StateBody).state).toBe('out_for_delivery'); // unmoved
  });

  it('refuses to mark delivered without proof — the state does not move', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.enableFeature(A, 'delivery'); // this shop's plan includes home delivery (M36-FR-01)
    expect((await transition(h, 'u-owner', 'ord-2', { event: 'depart' }, 'p1')).status).toBe(200);

    const noProof = await transition(h, 'u-owner', 'ord-2', { event: 'deliver' }, 'p2');
    expect(noProof.status).toBe(422);
    expect(codeOf(noProof)).toBe('delivered_without_proof');
    const blank = await transition(h, 'u-owner', 'ord-2', { event: 'deliver', proof: { kind: 'photo', ref: '  ' } }, 'p3');
    expect(blank.status).toBe(422);

    expect(((await readOrder(h, 'u-owner', 'ord-2')).body as StateBody).state).toBe('out_for_delivery'); // unmoved
  });

  it('refuses an out-of-order step — cannot deliver an order that never departed', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.enableFeature(A, 'delivery'); // this shop's plan includes home delivery (M36-FR-01)
    const early = await transition(h, 'u-owner', 'ord-3', { event: 'deliver', proof: { kind: 'signature', ref: 'S-1' } }, 'x1');
    expect(early.status).toBe(409);
    expect(codeOf(early)).toBe('invalid_delivery_transition');
    expect(((await readOrder(h, 'u-owner', 'ord-3')).body as StateBody).state).toBe('assigned'); // never moved
  });

  it('a failed stop can be reattempted then delivered, or returned to origin — never a silence', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.enableFeature(A, 'delivery'); // this shop's plan includes home delivery (M36-FR-01)

    // Reattempt path.
    await transition(h, 'u-owner', 'ord-4', { event: 'depart' }, 'r1');
    expect((await transition(h, 'u-owner', 'ord-4', { event: 'fail' }, 'r2')).status).toBe(200);
    expect((await transition(h, 'u-owner', 'ord-4', { event: 'reattempt' }, 'r3')).status).toBe(200);
    expect(((await readOrder(h, 'u-owner', 'ord-4')).body as StateBody).state).toBe('out_for_delivery');
    const done = await transition(h, 'u-owner', 'ord-4', { event: 'deliver', proof: { kind: 'otp', ref: 'OTP-9' } }, 'r4');
    expect((done.body as StateBody).state).toBe('delivered');

    // Return-to-origin path (terminal).
    await transition(h, 'u-owner', 'ord-5', { event: 'depart' }, 's1');
    await transition(h, 'u-owner', 'ord-5', { event: 'fail' }, 's2');
    const rto = await transition(h, 'u-owner', 'ord-5', { event: 'rto' }, 's3');
    expect((rto.body as StateBody).state).toBe('returned_to_origin');
    expect((rto.body as StateBody).final).toBe(true);
    // A terminal order accepts nothing more.
    expect((await transition(h, 'u-owner', 'ord-5', { event: 'reattempt' }, 's4')).status).toBe(409);
  });

  it('gates the write and the read, and refuses a malformed transition', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.enableFeature(A, 'delivery'); // this shop's plan includes home delivery (M36-FR-01)
    await h.provisionRole(A, 'u-cash', 'cashier'); // holds neither delivery permission

    expect((await transition(h, 'u-cash', 'ord-6', { event: 'depart' }, 'g1')).status).toBe(403);
    expect((await readOrder(h, 'u-cash', 'ord-6')).status).toBe(403);
    const bad = await transition(h, 'u-owner', 'ord-6', { event: 'teleport' }, 'g2');
    expect(bad.status).toBe(400);
    expect(codeOf(bad)).toBe('not_readable_as_a_delivery_transition');
  });
});

describe('home delivery is a paid feature — off until the shop enables it (M36-FR-01, §35)', () => {
  it('refuses feature_not_entitled for a shop whose plan has no delivery — even a full owner', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner'); // a real owner, but this shop never bought home delivery
    const res = await transition(h, 'u-owner', 'ord-1', { event: 'depart' }, 'd1');
    expect(res.status).toBe(403);
    expect(codeOf(res)).toBe('feature_not_entitled');
    // Reading a delivery's state is off too — about the PLAN, not a missing order.
    expect(codeOf(await readOrder(h, 'u-owner', 'ord-1'))).toBe('feature_not_entitled');
  });

  it('lets the same shop in once the delivery feature is enabled', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.enableFeature(A, 'delivery');
    expect((await transition(h, 'u-owner', 'ord-1', { event: 'depart' }, 'd1')).status).toBe(200);
  });

  it('is per-tenant: enabling delivery for one shop never turns it on for another', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.enableFeature(A, 'delivery');
    await h.seedOwner(B, 'u-owner-b'); // B has an owner but no delivery feature
    expect((await transition(h, 'u-owner', 'ord-1', { event: 'depart' }, 'd1')).status).toBe(200);
    const bRes = await h.request({ method: 'POST', path: '/v1/delivery/orders/ord-1/transition', userId: 'u-owner-b', tenantId: B, idempotencyKey: 'db', body: { event: 'depart' } });
    expect(bRes.status).toBe(403);
    expect(codeOf(bRes)).toBe('feature_not_entitled');
  });
});
