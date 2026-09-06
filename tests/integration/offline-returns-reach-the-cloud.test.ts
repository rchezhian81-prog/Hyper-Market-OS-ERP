import { describe, it, expect } from 'vitest';
import { apiHarness, TEST_IDP, type ApiHarness } from '../support/api-harness';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { SyncAgent } from '../../edge/sync-agent/src/agent';
import { httpTransport } from '../../edge/sync-agent/src/http-transport';
import { commitReturn, type CommitReturnInput } from '../../packages/returns/src/returns';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/ledger';
import { money } from '../../packages/contracts/src/money';

/**
 * **The offline return reaches the cloud and reconciles — M13-FR-01, §31, §28 (Slice 2a).**
 *
 * The lane takes a refund with the cable out: `commitReturn` moves the money against the local
 * append-only ledger and QUEUES a `ReturnAccepted` event. Until this increment that event had
 * **nowhere to go** — `EVENT_ROUTES` had no entry for it, so the sync agent rejected it by name and
 * it dead-lettered. The refund happened at the till and never reconciled in the cloud. This is the
 * wire: the event now carries its lane approver, and the sync agent routes it to the cloud's
 * record-and-flag endpoint `POST /v1/sales/:saleId/returns/synced`, which RE-VERIFIES that approver.
 *
 * The whole slice is exercised through the REAL parts: the real `commitReturn` mints the event, the
 * real `SyncOutbox` queues it, the real `SyncAgent` + `httpTransport` drain it, and `fetch` drives
 * the real cloud API surface (router, token auth, permission check, POS rules, append-only register).
 * Only the socket is replaced. So "it delivers" means "it delivers the way it is composed in production".
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AT = '2026-08-07T10:00:00.000Z';

/** The bill the return is against — banked in the cloud so the return has something to reconcile into. */
const sale = () => ({
  saleId: 'S1', receiptNumber: 'R-1', laneId: 'lane-1', cashierId: 'u-cash',
  tradingDay: '2026-08-07', committedAt: AT, totalMinor: 15000, currency: 'INR', packVersion: 1,
  lines: [{ productId: 'P1', quantityMinor: 3, uom: 'each', unitPriceMinor: 5000, lineTotalMinor: 15000 }],
  tenders: [{ kind: 'cash', amountMinor: 15000 }],
});
const bank = (h: ApiHarness, u: string) =>
  h.request({ method: 'POST', path: '/v1/sales', userId: u, tenantId: A, idempotencyKey: 'bank-S1', body: sale() });
const returnable = (h: ApiHarness, u: string) =>
  h.request({ method: 'GET', path: '/v1/sales/S1/returnable', userId: u, tenantId: A });
const exceptions = (h: ApiHarness, u: string) =>
  h.request({ method: 'GET', path: '/v1/pos/return-governance-exceptions', userId: u, tenantId: A });

interface Exc { count: number; exceptions: { returnId: string; processedBy: string; approvedBy?: string; governanceFlags: string[] }[] }

/**
 * A return as the lane commits it offline. Defaults describe a receipted, threshold-worthy refund
 * approved by a second person — the shape that must carry its approver across the wire and reconcile
 * cleanly. `over` overrides one field for a scenario (a bad approver, a no-receipt return).
 */
function returnInput(over: Partial<CommitReturnInput> = {}): CommitReturnInput {
  return {
    id: 'RT1', number: 'RT1', originalSaleId: 'S1', laneId: 'lane-1',
    processedBy: 'u-lanecash', processedAt: AT, reasonCode: 'customer_changed_mind',
    lines: [{ productId: 'P1', uom: 'each', quantityMinor: 1, originalQtyMinor: 3, disposition: 'resell' }],
    refund: money(5000, 'INR'), refundTender: 'cash', maxRefund: money(15000, 'INR'),
    // ₹1 threshold → the ₹50 refund is material, so the engine demands a separate approver, and the
    // event carries `approvedBy`. That is the field the cloud re-verifies on sync.
    approvalThresholdMinor: 100,
    approval: {
      id: 'appr-RT1', subjectType: 'return', subjectRef: 'RT1', requestedBy: 'u-lanecash',
      branchId: null, value: money(5000, 'INR'), status: 'approved', decidedBy: 'u-mgr',
      reason: 'customer ok', decidedAt: AT,
    },
    ...over,
  };
}

/**
 * A fresh cloud + a sync agent bound to it. The store's sync identity (`u-sync`, a cashier) holds
 * `pos.return.sync` and nothing more; the agent relays under that token. `u-mgr` genuinely holds
 * `pos.return.approve`; `u-owner` can read the governance surface (`lp.case.read`).
 */
async function scene() {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // a genuine refund approver
  await h.provisionRole(A, 'u-sync', 'cashier');      // the lane's sync identity: pos.return.sync only
  await bank(h, 'u-owner');

  const token = TEST_IDP.issue({ sub: 'u-sync', tenantId: A });
  let online = true;

  // `fetch` drives the real cloud surface. Everything below the socket is production.
  const apiFetch = (async (url: string, init: RequestInit): Promise<Response> => {
    if (!online) throw new Error('ENETUNREACH');
    const hdr = init.headers as Record<string, string>;
    const res = await h.raw({
      method: 'POST', path: new URL(url).pathname,
      token: hdr['authorization']?.replace(/^Bearer /, ''),
      idempotencyKey: hdr['idempotency-key'],
      body: JSON.parse(String(init.body)) as unknown,
    });
    return new Response(JSON.stringify(res.body), { status: res.status });
  }) as unknown as typeof globalThis.fetch;

  const transport = httpTransport({ baseUrl: 'https://cloud.example.test', token, fetch: apiFetch, timeoutMs: 5_000 });

  /** Commit a return offline through the REAL engine, returning the outbox holding its ReturnAccepted. */
  const commitOffline = (over: Partial<CommitReturnInput> = {}): SyncOutbox => {
    const outbox = new SyncOutbox();
    const ledger = new Ledger(new InMemoryLedgerStore());
    commitReturn(returnInput(over), ledger, outbox);
    return outbox;
  };

  return {
    h,
    commitOffline,
    setOnline: (v: boolean) => { online = v; },
    drain: (outbox: SyncOutbox) => new SyncAgent(outbox, transport).drain({ at: AT }),
    agentFor: (outbox: SyncOutbox) => new SyncAgent(outbox, transport),
  };
}

describe('offline returns reach the cloud and reconcile on sync (M13-FR-01, §31, §28)', () => {
  it('delivers a receipted offline refund to the cloud, and it reconciles into the register', async () => {
    const s = await scene();
    const outbox = s.commitOffline(); // clean: approved by u-mgr, who genuinely holds the authority
    expect(outbox.unsentCount()).toBe(1);

    const result = await s.drain(outbox);

    // Before this increment ReturnAccepted had no route and dead-lettered here. Now it is delivered.
    expect(result.acknowledged).toBe(1);
    expect(result.deadLettered).toBe(0);
    expect(result.remaining).toBe(0);

    // It reconciled INTO the register: one of three units is now off the returnable, ₹50 off refundable.
    const r = (await returnable(s.h, 'u-owner')).body as { returnable: { productId: string; returnableMinor: number }[]; refundableMinor: number };
    expect(r.returnable.find((l) => l.productId === 'P1')?.returnableMinor).toBe(2);
    expect(r.refundableMinor).toBe(10000);
    // A refund approved by a genuine authority is not a governance exception.
    expect((await exceptions(s.h, 'u-owner')).body as Exc).toMatchObject({ count: 0 });
  });

  it('reconciles a refund whose lane approver lacks authority, AND flags it as a visible §28 exception', async () => {
    const s = await scene();
    // The lane relayed an approver who does not hold pos.return.approve. The money already left the
    // drawer offline, so the cloud RECORDS it (never rejects a refund that happened) and flags it.
    const outbox = s.commitOffline({
      approval: { ...returnInput().approval!, decidedBy: 'u-nobody' },
    });

    const result = await s.drain(outbox);
    expect(result.acknowledged).toBe(1); // recorded, not refused
    expect(result.deadLettered).toBe(0);

    // Recorded (the refund is real): the register reflects it.
    expect(((await returnable(s.h, 'u-owner')).body as { refundableMinor: number }).refundableMinor).toBe(10000);
    // And surfaced as a visible governance exception — the offline engine could not check authority; the cloud did.
    const exc = (await exceptions(s.h, 'u-owner')).body as Exc;
    expect(exc.count).toBe(1);
    expect(exc.exceptions[0]).toMatchObject({ returnId: 'RT1', processedBy: 'u-lanecash', approvedBy: 'u-nobody', governanceFlags: ['approver_lacks_authority'] });
  });

  it('keeps a no-receipt return for a person — there is no synced endpoint yet, so it is never posted hopefully (hard rule #6)', async () => {
    const s = await scene();
    // A no-receipt return has no original bill: originalSaleId is null, so the route resolver yields
    // no path. It must be dead-lettered by name, not posted to some generic ingest.
    const outbox = s.commitOffline({ originalSaleId: null, noReceipt: true, noReceiptCapMinor: 100000 });

    const result = await s.drain(outbox);
    expect(result.acknowledged).toBe(0);
    expect(result.deadLettered).toBe(1);

    const dead = outbox.deadLetters();
    expect(dead).toHaveLength(1);
    expect(dead[0]?.reason).toContain('no cloud endpoint');
    // Nothing reconciled — the register is untouched.
    expect(((await returnable(s.h, 'u-owner')).body as { refundableMinor: number }).refundableMinor).toBe(15000);
  });

  it('waits out an outage, then reconciles once the line returns (§31)', async () => {
    const s = await scene();
    const outbox = s.commitOffline();

    s.setOnline(false);
    const offlinePass = await s.drain(outbox);
    // Nothing acknowledged, nothing dead-lettered, the refund still queued — a slow link never says the refund was bad.
    expect(offlinePass.acknowledged).toBe(0);
    expect(offlinePass.deadLettered).toBe(0);
    expect(offlinePass.remaining).toBe(1);
    expect(((await returnable(s.h, 'u-owner')).body as { refundableMinor: number }).refundableMinor).toBe(15000);

    s.setOnline(true);
    const backPass = await s.drain(outbox);
    expect(backPass.acknowledged).toBe(1);
    expect(s.agentFor(outbox).health().unsentCount).toBe(0);
    expect(((await returnable(s.h, 'u-owner')).body as { refundableMinor: number }).refundableMinor).toBe(10000);
  });
});
