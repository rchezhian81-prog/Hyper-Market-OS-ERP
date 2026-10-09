import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import type { PaymentProviderPort } from '../../edge/store-edge/src/payment-attempts';
import type { ProviderAuthorisation } from '../../packages/tender/src/pending-recovery';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { prepareTillBox, signInTill, signInAtLane, operatorHeader } from '../support/till-operator';

/**
 * **PF-06 — a card or UPI payment is written down before the machine is asked, a no-answer is settled only by the
 * provider's record, and one payment pays one bill (Wave 4 · M12-FR-03 · D04-FR-02 · §4.3 · hard rules #1, #3, #6).**
 *
 * The audit reproduced it: a card machine that did not answer left ZERO records — if it had in fact taken the money,
 * nobody knew, and the next try could charge the customer again. A real store computer, its lane socket and disk, the
 * real till, and a stand-in payment provider (no live provider is connected in this build): the attempt is on the disk
 * before the machine is asked; a no-answer is kept, visible, and blocks a second charge on the same bill; the provider's
 * record — and only that — settles it; a confirmed payment is used, never charged again; a sale paid by card must carry
 * a payment this box recorded as paid, once.
 */

const KEY = ['card', 'attempt', 'box', 'key'].join('-').padEnd(48, '0');
const dirs: string[] = [];
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** A stand-in provider: what it "knows" is set by the test, and whether its record for the period is complete. */
const provider = (records: () => { authorisations: ProviderAuthorisation[]; statementComplete: boolean }): PaymentProviderPort => ({
  lookup: async (reference) => {
    const r = records();
    return { authorisations: r.authorisations.filter((a) => a.ref === reference), statementComplete: r.statementComplete };
  },
});

const startBox = async (opts: { dir?: string; paymentProvider?: PaymentProviderPort } = {}): Promise<{ edge: EdgeProcess; dir: string }> => {
  const dir = opts.dir ?? await mkdtemp(join(tmpdir(), 'sre-card-attempt-'));
  if (opts.dir === undefined) dirs.push(dir);
  const ready = opts.dir !== undefined ? { EDGE_LANE_ID: 'lane-1', EDGE_PACK_FILE: join(dir, 'store-pack.json') } : await prepareTillBox({ dir, key: KEY });
  const edge = (await startEdge({
    EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', ...ready,
  }, () => {}, opts.paymentProvider === undefined ? {} : { paymentProvider: opts.paymentProvider }))!;
  stops.push(() => edge.stop());
  return { edge, dir };
};
const tillWithABasket = async (edge: EdgeProcess) => {
  const t = bootPos({ laneId: 'lane-1', taxPercent: 0, lanePort: edge.lane!.port });
  await signInTill(t, 'u-lanecash');
  t.scan({ productId: 'P1', description: 'Ghee 1L', unitPriceMinor: 64_000, qty: 1 });
  return t;
};
const payWith = async (t: Awaited<ReturnType<typeof tillWithABasket>>, ref?: string) => {
  const n = await t.nextReceipt();
  return t.tenderCardOrUpi({ saleId: `S-${n}`, receiptNumber: n, atIsoUtc: new Date().toISOString(), kind: 'card', outcome: 'approved', ...(ref === undefined ? {} : { ref }) });
};
const attempts = async (dir: string) => (await readLog(join(dir, 'payment-attempts.log'))).flatMap((r) => (r.ok ? [JSON.parse(r.record) as Record<string, unknown>] : []));
const sales = async (edge: EdgeProcess) => (await readLog(edge.log.path)).flatMap((r) => (r.ok ? [JSON.parse(r.record) as { id: string; tenders: { kind: string; ref?: string }[] }] : []));
const account = async (edge: EdgeProcess, token: string) => (await fetch(`http://127.0.0.1:${edge.lane!.port}/lane/payment-attempts`, { headers: operatorHeader(token) })).json() as Promise<{ unresolved: { attemptId: string }[]; paidWithoutSale: { attemptId: string }[]; owedToCustomers: { attemptId: string; owedToCustomerMinor: number }[] }>;

describe('PF-06 — the attempt is on the box before the machine is asked', () => {
  it('approved: recorded, answered, and the sale carries the payment\'s reference — one payment, one bill', async () => {
    const { edge, dir } = await startBox();
    const t = await tillWithABasket(edge);
    const started = await t.startCardPayment('card');
    expect(started).toMatchObject({ ok: true, attemptId: expect.stringMatching(/^PAY-/), state: 'asked', amountMinor: 64_000 });
    // On the disk before the machine said anything.
    expect(await attempts(dir)).toEqual([expect.objectContaining({ kind: 'asked', attemptId: started.attemptId, amountMinor: 64_000, by: 'u-lanecash' })]);
    expect(await t.answerCardPayment(started.attemptId!, 'approved')).toMatchObject({ ok: true, state: 'approved' });
    const receipt = await payWith(t, started.attemptId);
    expect((await sales(edge))[0]!.tenders).toEqual([expect.objectContaining({ kind: 'card', ref: started.attemptId })]);

    // The same payment cannot pay a second bill.
    t.newSale();
    t.scan({ productId: 'P1', description: 'Ghee 1L', unitPriceMinor: 64_000, qty: 1 });
    await expect(payWith(t, started.attemptId)).rejects.toThrow(/already paid another bill/);
    expect((await sales(edge)).map((s) => s.id)).toEqual([`S-${receipt}`]);
  });

  it('a card sale the box never recorded a payment for is refused before the disk', async () => {
    const { edge } = await startBox();
    const t = await tillWithABasket(edge);
    await expect(payWith(t)).rejects.toThrow(/was not recorded on this store computer/);
    await expect(payWith(t, 'PAY-made-up')).rejects.toThrow(/was not recorded on this store computer/);
    expect(await sales(edge)).toHaveLength(0);
  });

  it('declined is recorded and stands; a later "approved" for the same attempt is refused', async () => {
    const { edge } = await startBox();
    const t = await tillWithABasket(edge);
    const a = await t.startCardPayment('upi');
    expect(await t.answerCardPayment(a.attemptId!, 'declined')).toMatchObject({ ok: true, state: 'declined' });
    expect(await t.answerCardPayment(a.attemptId!, 'approved')).toMatchObject({ ok: false, refusedBecause: 'already_answered' });
    await expect(payWith(t, a.attemptId)).rejects.toThrow(/declined, not paid/);
    // A declined payment does not block another try on the same bill.
    expect(await t.startCardPayment('card')).toMatchObject({ ok: true });
  });
});

describe('PF-06 — no answer from the machine: kept, visible, never settled by hand, never charged twice', () => {
  it('THE AUDIT\'S CASE: the no-answer is on the disk; asking the machine again for that bill is refused; a restart keeps it', async () => {
    const { edge, dir } = await startBox();
    const t = await tillWithABasket(edge);
    const a = await t.startCardPayment('card');
    expect(await t.answerCardPayment(a.attemptId!, 'no_answer')).toMatchObject({ ok: true, state: 'no_answer' });
    expect(await t.startCardPayment('card')).toMatchObject({ ok: false, refusedBecause: 'unresolved_payment_on_this_bill', attemptId: a.attemptId, laneMessage: expect.stringMatching(/Do not ask the machine again/) });
    await expect(payWith(t, a.attemptId)).rejects.toThrow(/no answer, not paid/);
    // No provider connected: it cannot be settled here, and says so — it is not settled by hand.
    expect(await t.checkCardPayment(a.attemptId!)).toMatchObject({ ok: false, refusedBecause: 'no_provider_connected', laneMessage: expect.stringMatching(/Do not run the card again/) });

    const token = await signInAtLane(edge.lane!.port, 'u-lanecash');
    expect((await account(edge, token)).unresolved.map((x) => x.attemptId)).toEqual([a.attemptId]);
    await edge.stop();
    stops.splice(0);
    const again = await startBox({ dir });
    const token2 = await signInAtLane(again.edge.lane!.port, 'u-lanecash');
    expect((await account(again.edge, token2)).unresolved.map((x) => x.attemptId)).toEqual([a.attemptId]);
  });

  it('the provider confirms it was paid: the bill is paid with THAT payment — the machine is not asked again', async () => {
    const records = { authorisations: [] as ProviderAuthorisation[], statementComplete: false };
    const { edge } = await startBox({ paymentProvider: provider(() => records) });
    const t = await tillWithABasket(edge);
    const a = await t.startCardPayment('card');
    await t.answerCardPayment(a.attemptId!, 'no_answer');
    // Not yet on the provider's record, and the record is incomplete: still unknown — not a decline.
    expect(await t.checkCardPayment(a.attemptId!)).toMatchObject({ ok: false, refusedBecause: 'still_unknown' });
    records.authorisations.push({ ref: a.attemptId!, amountMinor: 64_000, status: 'captured', at: new Date().toISOString() });
    expect(await t.checkCardPayment(a.attemptId!)).toMatchObject({ ok: true, state: 'recovered_paid', laneMessage: expect.stringMatching(/do not charge again/) });
    // A new attempt on this bill hands back the confirmed one instead.
    expect(await t.startCardPayment('card')).toMatchObject({ ok: false, refusedBecause: 'already_paid_on_this_bill', attemptId: a.attemptId });
    await payWith(t, a.attemptId);
    expect((await sales(edge))[0]!.tenders).toEqual([expect.objectContaining({ ref: a.attemptId })]);
  });

  it('the provider\'s complete record shows no payment: settled as NOT paid, and the customer may pay again', async () => {
    const { edge } = await startBox({ paymentProvider: provider(() => ({ authorisations: [], statementComplete: true })) });
    const t = await tillWithABasket(edge);
    const a = await t.startCardPayment('card');
    await t.answerCardPayment(a.attemptId!, 'no_answer');
    expect(await t.checkCardPayment(a.attemptId!)).toMatchObject({ ok: true, state: 'recovered_not_paid' });
    expect(await t.startCardPayment('card')).toMatchObject({ ok: true });
  });

  it('the provider took the money twice: paid, and the extra is listed as owed back to the customer', async () => {
    const records = { authorisations: [] as ProviderAuthorisation[], statementComplete: true };
    const { edge } = await startBox({ paymentProvider: provider(() => records) });
    const t = await tillWithABasket(edge);
    const a = await t.startCardPayment('card');
    await t.answerCardPayment(a.attemptId!, 'no_answer');
    records.authorisations.push(
      { ref: a.attemptId!, amountMinor: 64_000, status: 'captured', at: '2026-10-09T10:00:00Z' },
      { ref: a.attemptId!, amountMinor: 64_000, status: 'captured', at: '2026-10-09T10:01:00Z' },
    );
    expect(await t.checkCardPayment(a.attemptId!)).toMatchObject({ ok: true, state: 'recovered_paid', laneMessage: expect.stringMatching(/owed back/) });
    const token = await signInAtLane(edge.lane!.port, 'u-lanecash');
    const before = await account(edge, token);
    expect(before.owedToCustomers).toEqual([expect.objectContaining({ attemptId: a.attemptId, owedToCustomerMinor: 64_000 })]);
    // Paid, with no sale yet to show for it: listed until the bill is paid with it.
    expect(before.paidWithoutSale.map((x) => x.attemptId)).toEqual([a.attemptId]);
    await payWith(t, a.attemptId);
    expect((await account(edge, token)).paidWithoutSale).toEqual([]);
  });

  it('a reference that looks like a card number is never recorded (hard rule #3)', async () => {
    const { edge, dir } = await startBox();
    const token = await signInAtLane(edge.lane!.port, 'u-lanecash');
    const res = await fetch(`http://127.0.0.1:${edge.lane!.port}/lane/payment-attempts`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...operatorHeader(token) },
      body: JSON.stringify({ attemptId: '4111111111111111', billRef: 'B-1', kind: 'card', amountMinor: 100 }),
    });
    expect(await res.json()).toMatchObject({ ok: false, refusedBecause: 'reference_looks_like_card_data' });
    expect(await attempts(dir)).toEqual([]);
  });
});
