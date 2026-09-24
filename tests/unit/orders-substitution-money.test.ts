import { describe, it, expect } from 'vitest';
import {
  settleSubstitutionMoney,
  type SubstitutionOffer,
  type TenderMode,
} from '../../packages/orders/src/index';

// M19-FR-01 substitution MONEY settlement. Composes applySubstitution and maps the outcome onto how
// the order is paid: a cheaper swap or a short-pick is a refund (prepaid) or a smaller total to
// collect (COD/pay-at-store); a dearer swap is capped at the original price UNLESS the customer
// explicitly approved paying more. settlementMinor is always >= 0 — the direction is in the kind.

const offer = (over: Partial<SubstitutionOffer> = {}): SubstitutionOffer => ({
  lineId: 'l1',
  orderedProductId: 'p-ord',
  orderedName: 'Aavin Milk 500ml',
  orderedUnitPriceMinor: 100_00,
  orderedQuantityMinor: 1,
  substituteProductId: 'p-sub',
  substituteName: 'Arokya Milk 500ml',
  substituteUnitPriceMinor: 100_00,
  substituteQuantityMinor: 1,
  offeredAt: '2026-09-24T08:00:00Z',
  ...over,
});

const settle = (o: SubstitutionOffer, decision: 'confirmed' | 'declined' | 'no_answer', tender: TenderMode, approvedAboveCap = false) =>
  settleSubstitutionMoney({ offer: o, decision, tender, approvedAboveCap });

describe('settleSubstitutionMoney — the money of a substitution, by tender (M19-FR-01)', () => {
  it('a cheaper swap on a prepaid order is a refund of the difference', () => {
    const d = settle(offer({ substituteUnitPriceMinor: 80_00 }), 'confirmed', 'prepaid');
    expect(d).toMatchObject({ outcome: 'substituted', chargeMinor: 80_00, aboveCap: false, settlementKind: 'prepaid_refund', settlementMinor: 20_00 });
    expect(d.tellTheCustomer).toContain('₹20.00');
  });

  it('a cheaper swap on a COD order collects less', () => {
    const d = settle(offer({ substituteUnitPriceMinor: 80_00 }), 'confirmed', 'cod');
    expect(d).toMatchObject({ settlementKind: 'collect_less', settlementMinor: 20_00, chargeMinor: 80_00 });
  });

  it('a cheaper swap on a pay-at-store order collects less', () => {
    const d = settle(offer({ substituteUnitPriceMinor: 80_00 }), 'confirmed', 'pay_at_store');
    expect(d.settlementKind).toBe('collect_less');
  });

  it('a dearer swap NOT approved is capped at the original price — no settlement, shop absorbs it', () => {
    const d = settle(offer({ substituteUnitPriceMinor: 130_00 }), 'confirmed', 'prepaid');
    expect(d).toMatchObject({ chargeMinor: 100_00, aboveCap: false, settlementKind: 'none', settlementMinor: 0 });
    expect(d.tellTheCustomer).toContain('original price');
  });

  it('a dearer swap EXPLICITLY approved is charged above the cap (prepaid → additional charge)', () => {
    const d = settle(offer({ substituteUnitPriceMinor: 130_00 }), 'confirmed', 'prepaid', true);
    expect(d).toMatchObject({ chargeMinor: 130_00, aboveCap: true, settlementKind: 'prepaid_additional_charge', settlementMinor: 30_00 });
  });

  it('a dearer swap approved on a COD order collects more', () => {
    const d = settle(offer({ substituteUnitPriceMinor: 130_00 }), 'confirmed', 'cod', true);
    expect(d).toMatchObject({ aboveCap: true, settlementKind: 'collect_more', settlementMinor: 30_00 });
    expect(d.tellTheCustomer).toContain('on delivery');
  });

  it('a same-price swap moves no money', () => {
    const d = settle(offer(), 'confirmed', 'prepaid');
    expect(d).toMatchObject({ chargeMinor: 100_00, settlementKind: 'none', settlementMinor: 0 });
  });

  it('a declined substitution refunds the whole line on a prepaid order (charged nothing)', () => {
    const d = settle(offer({ substituteUnitPriceMinor: 80_00 }), 'declined', 'prepaid');
    expect(d).toMatchObject({ outcome: 'short_picked', chargeMinor: 0, settlementKind: 'prepaid_refund', settlementMinor: 100_00 });
  });

  it('no answer on a COD order drops the line from what is collected (silence is not consent)', () => {
    const d = settle(offer({ substituteUnitPriceMinor: 80_00 }), 'no_answer', 'cod');
    expect(d).toMatchObject({ outcome: 'not_confirmed', chargeMinor: 0, settlementKind: 'collect_less', settlementMinor: 100_00 });
  });

  it('settlementMinor is never negative across every case', () => {
    const cases: Array<[number, 'confirmed' | 'declined' | 'no_answer', TenderMode, boolean]> = [
      [80_00, 'confirmed', 'prepaid', false],
      [130_00, 'confirmed', 'prepaid', false],
      [130_00, 'confirmed', 'cod', true],
      [100_00, 'confirmed', 'pay_at_store', false],
      [80_00, 'declined', 'cod', false],
      [80_00, 'no_answer', 'prepaid', false],
    ];
    for (const [price, decision, tender, approved] of cases) {
      const d = settle(offer({ substituteUnitPriceMinor: price }), decision, tender, approved);
      expect(d.settlementMinor).toBeGreaterThanOrEqual(0);
    }
  });
});
