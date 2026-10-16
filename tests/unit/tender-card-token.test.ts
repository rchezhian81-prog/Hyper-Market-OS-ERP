import { describe, it, expect } from 'vitest';
import {
  readCardTokenReference, containsCardNumber, isCardNumberShape,
  CARD_TENDER_PERMITTED_FIELDS, CARD_NETWORKS,
} from '../../packages/tender/src/card-token';
import { settle, type Tender } from '../../packages/tender/src/tender';
import { money } from '../../packages/contracts/src/money';

// C10 (v2.1 addendum · M12 · hard rule #3): the tender surface stores only a network-token reference plus the last four
// digits and the network — never the card number, the security code or the expiry. Synthetic test numbers only (the
// industry's published test PANs), assembled at run time.

const TEST_VISA = ['4111', '1111', '1111', '1111'].join('');
const TEST_MASTERCARD = ['5555', '5555', '5555', '4444'].join('');

describe('a card tender keeps the token reference, the last four digits and the network — nothing else (C10)', () => {
  it('reads the three permitted facts', () => {
    const r = readCardTokenReference({ tokenRef: 'ntok_7Hq2', last4: '1111', network: 'visa' });
    expect(r).toEqual({ ok: true, value: { tokenRef: 'ntok_7Hq2', last4: '1111', network: 'visa' } });
    expect(CARD_TENDER_PERMITTED_FIELDS).toEqual(['tokenRef', 'last4', 'network']);
    expect(CARD_NETWORKS).toContain('rupay');
  });

  it('refuses any field outside the allowlist by name — whatever it is called — and never repeats its value', () => {
    const offered = { tokenRef: 'ntok_1', last4: '1111', network: 'visa', pan: TEST_VISA, cvv: '123', expiry: '12/29', bin: '411111' };
    const r = readCardTokenReference(offered);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const refused = r.problems.filter((p) => p.code === 'field_not_permitted').map((p) => p.field);
    expect(refused).toEqual(['bin', 'cvv', 'expiry', 'pan']);
    // The full number is also refused by its SHAPE, and nowhere in the answer is a value repeated.
    expect(r.problems.some((p) => p.code === 'value_looks_like_a_card_number' && p.field === 'pan')).toBe(true);
    const words = JSON.stringify(r.problems);
    for (const v of [TEST_VISA, '123', '12/29', '411111']) expect(words).not.toContain(v);
  });

  it('refuses a token that hides a full card number, and a "last four" that is more of the card', () => {
    const hidden = readCardTokenReference({ tokenRef: `tok_${TEST_VISA}`, last4: '1111', network: 'visa' });
    expect(hidden.ok).toBe(false);
    if (!hidden.ok) expect(hidden.problems.map((p) => p.code)).toContain('value_looks_like_a_card_number');

    const long = readCardTokenReference({ tokenRef: 'ntok_1', last4: TEST_MASTERCARD, network: 'mastercard' });
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.problems.map((p) => p.code).sort()).toEqual(['last4_not_four_digits', 'value_looks_like_a_card_number']);
  });

  it('refuses a missing token, an unknown network and a non-object', () => {
    const r = readCardTokenReference({ last4: '12a4', network: 'mystery' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.map((p) => p.code).sort()).toEqual(['last4_not_four_digits', 'network_unknown', 'token_missing']);
    expect(readCardTokenReference(null).ok).toBe(false);
    expect(readCardTokenReference([]).ok).toBe(false);
  });

  it('a tender carries the card facts beside its provider reference, and settles as before', () => {
    const t: Tender = { kind: 'card', amount: money(50_000, 'INR'), status: 'authorized', ref: 'MREF-1', card: { tokenRef: 'ntok_9', last4: '4242', network: 'mastercard' } };
    expect(settle(money(50_000, 'INR'), [t]).fullyPaid).toBe(true);
  });
});

describe('the card-number shape test is quiet on retail traffic', () => {
  it('finds a card number on its own, grouped, or inside a reference', () => {
    expect(isCardNumberShape(TEST_VISA)).toBe(true);
    expect(containsCardNumber(TEST_VISA.replace(/(\d{4})/g, '$1 ').trim())).toBe(true);
    expect(containsCardNumber(TEST_VISA.replace(/(\d{4})(?=\d)/g, '$1-'))).toBe(true);
    expect(containsCardNumber(`remark: paid by ${TEST_VISA} at counter`)).toBe(true);
  });

  it('does not fire on a 13-digit barcode, a 14-digit carton code, a UTR, a GSTIN, a long acquirer reference or a date', () => {
    for (const v of ['8901030865278', '18901030865275', 'UTR2026101100042', '33AABCS1429B1ZB', '74537606296201234567890', '2026-10-16', '9876543210']) {
      expect(containsCardNumber(v), v).toBe(false);
    }
  });
});
