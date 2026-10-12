import { describe, it, expect } from 'vitest';
import { createReceiptPrefixSession, PREFIX_WORDS, type ReceiptPrefixesRead } from '../../apps/web-erp/src/receipt-prefix-session';

// The till bill-number prefix panel's logic (OB-81). The browser proof on the production API is
// tests/e2e/till-bill-number-prefixes-on-the-production-api.e2e.ts.

const READ: ReceiptPrefixesRead = {
  storesInBusiness: 2, multiStore: true,
  tills: [{ storeId: 'S1', tillId: 'lane-1', prefix: 'S1A1-', version: 2, setBy: 'u-owner', setAt: '2026-10-12T08:00:00.000Z', firstNumber: 'S1A1-000001', lastNumber: 'S1A1-999999', history: [{ prefix: 'S1L1-', version: 1 }, { prefix: 'S1A1-', version: 2 }] }],
  needsPrefix: [{ storeId: 'S2', tillId: 'lane-9', flagged: true, why: 'no prefix' }],
};

describe('OB-81 — the till bill-number prefix panel', () => {
  it('rows: the flagged till first; an issued one with its range and the prefixes it held before', () => {
    const s = createReceiptPrefixSession({ read: READ, canEdit: true }, { post: async () => ({ status: 500, body: null }), reload: async () => null, newKey: () => 'k' });
    expect(s.rows().map((r) => [r.storeId, r.tillId, r.prefix, r.flagged])).toEqual([['S2', 'lane-9', null, true], ['S1', 'lane-1', 'S1A1-', false]]);
    expect(s.rows()[1]).toMatchObject({ range: 'S1A1-000001 … S1A1-999999', earlier: ['S1L1-'] });
    expect(s.multiStore()).toBe(true);
    expect(Object.keys(PREFIX_WORDS.ta).sort()).toEqual(Object.keys(PREFIX_WORDS.en).sort());
  });

  it('checks a typed prefix by head office\'s rule and shows the numbers it would make; a refused one is never sent', async () => {
    const sent: unknown[] = [];
    const s = createReceiptPrefixSession({ read: READ, canEdit: true }, { post: async (p, b) => { sent.push([p, b]); return { status: 201, body: {} }; }, reload: async () => null, newKey: () => 'k' });
    expect(s.check('S2L9-')).toBeUndefined();
    expect(s.preview('S2L9-')).toBe('S2L9-000001 … S2L9-999999');
    expect(s.check('S2LANE0009-')).toMatch(/at most 10/);
    expect(s.preview('zz')).toBeUndefined();
    expect(await s.save('S2', 'lane-9', 'R-9-')).toMatchObject({ kind: 'refused', code: 'receipt_prefix_not_allowed' });
    expect(sent).toEqual([]);
  });

  it('saves under one key per (till, prefix): a retry after a lost line is the same request; head office\'s refusal is shown in its words', async () => {
    const keys: string[] = [];
    let n = 0; let down = true;
    const s = createReceiptPrefixSession({ read: READ, canEdit: true }, {
      post: async (path, _b, key) => {
        keys.push(key);
        if (down) throw new Error('offline');
        expect(path).toBe('/v1/stores/S2/tills/lane-9/receipt-prefix');
        return { status: 409, body: { error: { code: 'receipt_prefix_taken', whatHappened: 'The prefix S1A1- was issued to till lane-1 at Store One (S1).' } } };
      },
      reload: async () => null, newKey: () => `key-${(n += 1)}`,
    });
    expect(await s.save('S2', 'lane-9', 'S1A1-')).toMatchObject({ kind: 'failed', words: expect.stringMatching(/could not be reached/) });
    down = false;
    expect(await s.save('S2', 'lane-9', 'S1A1-')).toEqual({ kind: 'refused', code: 'receipt_prefix_taken', words: 'The prefix S1A1- was issued to till lane-1 at Store One (S1).' });
    expect(keys).toEqual(['key-1', 'key-1']);
  });
});
