import { describe, it, expect } from 'vitest';
import { bootPos, SALE_UNCONFIRMED_WORDS } from '../../apps/pos/src/browser-entry';
import { SaleUnconfirmedError, LocalCommitRefusedError, GUEST_SALES_ONLY_WORDS } from '../../apps/pos/src/session';
import { LocalRefundRefusedError, GUEST_ONLY_REFUND_WORDS } from '../../apps/pos/src/till-session';
import { money } from '../../packages/contracts/src/money';
import type { CommitOutcome } from '../../edge/store-edge/src/durability';

/**
 * The till's own rules, with no store computer and no network — the durable write is a stand-in that answers as told.
 *
 * **A8:** a sale whose answer is UNCONFIRMED is held: the exact record it sent is re-sent under the same id until the box
 * says saved or not saved; nothing else may happen meanwhile; asking to ring the same sale again resolves the held one
 * instead of making a new one. **OB-252:** with guest sales only on, no customer number is taken, none leaves the till,
 * points and store credit are refused, and a refund names no customer — each refused in words, never dropped quietly.
 */

const AT = '2026-10-20T10:00:00.000Z';
const saved: CommitOutcome = { committed: true, durable: true, detail: 'saved', laneMessage: 'Saved.' };
const unconfirmed: CommitOutcome = { committed: false, unconfirmed: true, refusedBecause: 'could_not_write_durably', detail: 'no answer', laneMessage: SALE_UNCONFIRMED_WORDS };
const refused: CommitOutcome = { committed: false, refusedBecause: 'could_not_write_durably', detail: 'refused', laneMessage: 'Refused by the box. Nothing was saved.' };

/** A till whose durable write answers from a script, and remembers every record it was handed. */
const scripted = (answers: CommitOutcome[], extra: Record<string, unknown> = {}) => {
  const sent: { id: string; record: string }[] = [];
  const view = bootPos({
    laneId: 'lane-1', cashierId: 'u-meena', taxPercent: 0, ...extra,
    durable: async (id, record) => { sent.push({ id, record }); return answers.shift() ?? unconfirmed; },
    durableReturn: async (id, record) => { sent.push({ id, record }); return answers.shift() ?? unconfirmed; },
  });
  view.scan({ productId: 'P1', description: 'Toor dal 1kg', unitPriceMinor: 48_000, qty: 1 });
  return { view, sent };
};

describe('A8 — an unconfirmed sale is held, re-sent unchanged, and resolved only by the box', () => {
  it('re-sends the IDENTICAL record under the same id, and finishes the sale exactly as an immediate "saved" would', async () => {
    const { view, sent } = scripted([unconfirmed, unconfirmed, saved]);
    await expect(view.tenderCash('S-1', 'R-1', AT)).rejects.toBeInstanceOf(SaleUnconfirmedError);
    await expect(view.confirmPendingSale()).rejects.toBeInstanceOf(SaleUnconfirmedError);
    expect(await view.confirmPendingSale()).toBe('R-1');
    expect(sent.map((s) => s.id)).toEqual(['S-1', 'S-1', 'S-1']);
    expect(new Set(sent.map((s) => s.record)).size).toBe(1); // byte-identical, so the box's idempotency guard matches it
    expect(view.state()).toBe('committed');
    expect(JSON.stringify(view.receiptLines())).toContain('R-1'); // the bill is made from the sale confirmed late
  });

  it('while held: no scan, no quantity, no void, no new sale, no hold, and no OTHER sale — each refused in words', async () => {
    const { view } = scripted([unconfirmed]);
    await expect(view.tenderCash('S-1', 'R-1', AT)).rejects.toBeInstanceOf(SaleUnconfirmedError);
    const line = view.basket()[0]!;
    for (const act of [
      () => view.scan({ productId: 'P2', description: 'Sugar', unitPriceMinor: 5_000, qty: 1 }),
      () => view.setQuantity(line.lineId, 2),
      () => view.voidLine(line.lineId, 'wrong item'),
      () => view.newSale(),
      () => view.suspend(),
      () => view.setLoyaltyMobile('9840012345'),
    ]) {
      expect(act).toThrow(SaleUnconfirmedError);
    }
    const other = await view.tenderCash('S-2', 'R-2', AT).catch((e: unknown) => e);
    expect(other).toBeInstanceOf(SaleUnconfirmedError);
    expect((other as SaleUnconfirmedError).laneMessage).toMatch(/still checking .* sale R-1 was saved/);
    expect(view.pendingSale()).toEqual({ saleId: 'S-1', number: 'R-1' });
  });

  it('ringing the SAME sale again resolves the held one — it never becomes a second sale', async () => {
    const { view, sent } = scripted([unconfirmed, saved]);
    await expect(view.tenderCash('S-1', 'R-1', AT)).rejects.toBeInstanceOf(SaleUnconfirmedError);
    expect(await view.tenderCash('S-1', 'R-1', '2026-10-20T10:05:00.000Z')).toBe('R-1');
    expect(new Set(sent.map((s) => s.record)).size).toBe(1); // the held record, not one re-made at 10:05
  });

  it('the box says "not saved": LocalCommitRefusedError in its words, and the basket is back to be paid again', async () => {
    const { view } = scripted([unconfirmed, refused, saved]);
    await expect(view.tenderCash('S-1', 'R-1', AT)).rejects.toBeInstanceOf(SaleUnconfirmedError);
    const answer = await view.confirmPendingSale().catch((e: unknown) => e);
    expect(answer).toBeInstanceOf(LocalCommitRefusedError);
    expect((answer as LocalCommitRefusedError).laneMessage).toBe(refused.laneMessage);
    expect(view.pendingSale()).toBeNull();
    expect(view.basket()).toHaveLength(1);
    expect(await view.tenderCash('S-2', 'R-2', AT)).toBe('R-2'); // a new number, a fresh sale
  });

  it('a plain first-time refusal is still a refusal (nothing held)', async () => {
    const { view } = scripted([refused]);
    await expect(view.tenderCash('S-1', 'R-1', AT)).rejects.toBeInstanceOf(LocalCommitRefusedError);
    expect(view.pendingSale()).toBeNull();
  });

  it('a refund whose answer is unconfirmed is held the same way and re-sent unchanged', async () => {
    const { view, sent } = scripted([unconfirmed, saved]);
    const refund = {
      id: 'RT-1', number: 'RT-1', originalSaleId: 'S-0', processedAt: AT, reasonCode: 'damaged',
      lines: [{ productId: 'P1', uom: 'ea', quantityMinor: 1, originalQtyMinor: 1, disposition: 'resell' as const }],
      refund: money(5_000, 'INR'), refundTender: 'cash' as const, maxRefund: money(48_000, 'INR'), approvalThresholdMinor: 1_000_000,
    };
    expect((await view.confirmPendingRefund()).kind).toBe('refused'); // nothing is waiting yet
    await expect(view.till.refund(refund)).rejects.toMatchObject({ name: 'RefundUncertainError' });
    expect(view.pendingRefund()).toEqual({ returnId: 'RT-1', number: 'RT-1' });
    expect(await view.confirmPendingRefund()).toMatchObject({ kind: 'settled', number: 'RT-1' });
    expect(sent.map((s) => s.id)).toEqual(['RT-1', 'RT-1']);
    expect(sent[0]!.record).toBe(sent[1]!.record);
  });
});

describe('OB-252 — guest sales only', () => {
  it('no customer number is taken or sent; points and store credit are refused before the box; the till says it is on', async () => {
    const { view, sent } = scripted([saved], { guestSalesOnly: true });
    expect(view.guestSalesOnly()).toBe(true);
    expect(view.setLoyaltyMobile('9840012345')).toEqual({ ok: false, laneMessage: GUEST_SALES_ONLY_WORDS });
    expect(view.loyaltyMemberLast4()).toBeNull();
    expect(await view.loyaltyWallet()).toMatchObject({ ok: false, refusedBecause: 'guest_sales_only' });
    await expect(view.tenderSplit({ saleId: 'S-1', receiptNumber: 'R-1', atIsoUtc: AT, parts: [{ kind: 'loyalty_points', amountMinor: 48_000 }] }))
      .rejects.toThrow(/Guest sales only/);
    expect(sent).toHaveLength(0); // refused before anything was sent
    expect(await view.tenderCash('S-1', 'R-1', AT)).toBe('R-1');
    expect(sent[0]!.record).not.toContain('customerMobile');
  });

  it('a refund to store credit, or naming a customer, is refused in words before anything is written', async () => {
    const { view, sent } = scripted([saved], { guestSalesOnly: true });
    const base = {
      id: 'RT-1', number: 'RT-1', originalSaleId: 'S-0', processedAt: AT, reasonCode: 'damaged',
      lines: [{ productId: 'P1', uom: 'ea', quantityMinor: 1, originalQtyMinor: 1, disposition: 'resell' as const }],
      refund: money(5_000, 'INR'), maxRefund: money(48_000, 'INR'), approvalThresholdMinor: 1_000_000,
    };
    await expect(view.till.refund({ ...base, refundTender: 'store_credit', customerRef: '9840012345' })).rejects.toBeInstanceOf(LocalRefundRefusedError);
    await expect(view.till.refund({ ...base, refundTender: 'cash', customerRef: '9840012345' })).rejects.toThrow(GUEST_ONLY_REFUND_WORDS.slice(0, 40));
    expect(sent).toHaveLength(0);
    expect((await view.till.refund({ ...base, refundTender: 'cash' })).refundStatus).toBe('settled');
  });

  it('off by default: a member can be named, exactly as before', () => {
    const { view } = scripted([saved]);
    expect(view.guestSalesOnly()).toBe(false);
    expect(view.setLoyaltyMobile('9840012345')).toEqual({ ok: true, last4: '2345' });
  });
});
