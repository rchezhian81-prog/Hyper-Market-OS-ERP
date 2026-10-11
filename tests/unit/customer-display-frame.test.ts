import { describe, it, expect } from 'vitest';
import { customerDisplayFrame, recordingDisplay, CUSTOMER_DISPLAY_CHANNEL } from '../../apps/pos/src/customer-display';
import { bootPos } from '../../apps/pos/src/browser-entry';

/** D04-FR-05 · M12-FR-01: the customer display's frame comes from the till's own basket — voided lines never show. */
describe('the customer display frame', () => {
  it('an empty basket is a welcome; voided lines are not shown; the saving and the amount to pay are the till\'s', () => {
    expect(customerDisplayFrame({ laneId: 'lane-1', basket: [], lineTotalsMinor: [], promotionDiscountMinor: 0, payableMinor: 0, currency: 'INR', seq: 1 }))
      .toMatchObject({ state: 'idle', lines: [], payableMinor: 0 });
    const frame = customerDisplayFrame({
      laneId: 'lane-1',
      basket: [
        { description: 'Ghee', qty: 1, uom: 'each', voided: false },
        { description: 'Rice', qty: 2, uom: 'each', voided: true },
        { description: 'Dal', qty: 1, uom: 'each', voided: false },
      ],
      lineTotalsMinor: [64_000, 12_000], promotionDiscountMinor: 6_400, payableMinor: 69_600, currency: 'INR', seq: 2,
    });
    expect(frame).toEqual({
      state: 'basket', laneId: 'lane-1', currency: 'INR', seq: 2, savedMinor: 6_400, payableMinor: 69_600,
      lines: [{ description: 'Ghee', qty: 1, uom: 'each', amountMinor: 64_000 }, { description: 'Dal', qty: 1, uom: 'each', amountMinor: 12_000 }],
    });
    expect(CUSTOMER_DISPLAY_CHANNEL).toBe('sre-customer-display');
  });

  it('the till\'s own session builds it, and a recording port keeps what it was shown', () => {
    const t = bootPos({ laneId: 'lane-1', taxPercent: 0 });
    t.scan({ productId: 'P1', description: 'Amul Ghee Gold 1L', unitPriceMinor: 64_000, qty: 2 });
    const port = recordingDisplay();
    port.show(t.customerDisplay());
    expect(port.shown[0]).toMatchObject({ state: 'basket', laneId: 'lane-1', payableMinor: 128_000, lines: [{ description: 'Amul Ghee Gold 1L', qty: 2, amountMinor: 128_000 }] });
    expect(JSON.stringify(port.shown[0])).not.toMatch(/pin|token|cashier/i);
  });
});
