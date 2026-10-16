import { describe, it, expect } from 'vitest';
import {
  WASTE_REASON_CODES, WASTE_REASON_WORDS, checkWasteReason, isWasteReason, aggregateWaste, UNCLASSIFIED, NO_DEPARTMENT,
  type WasteEvent,
} from '../../packages/waste/src/reasons';

// D-5 (roadmap v2.1 addendum, ratified R2): "Waste is captured against a closed reason taxonomy; analytics aggregate by
// SKU/dept/reason; a bare (reasonless) waste event is rejected".

describe('D-5 the closed waste reason taxonomy', () => {
  it('is closed: exactly the shop\'s six waste sources, frozen, each with English and Tamil words', () => {
    expect([...WASTE_REASON_CODES]).toEqual(['expiry', 'damage', 'shrinkage', 'preparation', 'customer_return', 'recall']);
    expect(Object.isFrozen(WASTE_REASON_CODES)).toBe(true);
    for (const r of WASTE_REASON_CODES) {
      expect(WASTE_REASON_WORDS[r].en.length).toBeGreaterThan(0);
      expect(WASTE_REASON_WORDS[r].ta).toMatch(/[஀-௿]/);
    }
  });

  it('a bare (reasonless) waste event is rejected — absent, null, empty or spaces', () => {
    for (const v of [undefined, null, '', '   ']) expect(checkWasteReason(v)).toEqual({ ok: false, why: 'bare' });
  });

  it('a reason off the list is rejected by name — free text, wrong case, padding, a number', () => {
    for (const v of ['leaking', 'Damage', ' damage', 'damage ', 7, {}]) {
      expect(checkWasteReason(v)).toEqual({ ok: false, why: 'not_in_taxonomy' });
      expect(isWasteReason(v)).toBe(false);
    }
    for (const r of WASTE_REASON_CODES) expect(checkWasteReason(r)).toEqual({ ok: true, reason: r });
  });
});

describe('D-5 analytics aggregate by SKU, department and reason', () => {
  const ev = (eventId: string, productId: string, departmentId: string | null, reason: string, valueMinor: number, qty?: number): WasteEvent =>
    ({ eventId, productId, departmentId, reason, valueMinor, at: '2026-10-10T10:00:00.000Z', ...(qty === undefined ? {} : { qty }) });

  it('groups every event three ways, worst first, with shares that add up; nothing is dropped', () => {
    const a = aggregateWaste([
      ev('w1', 'MILK-1', 'dairy', 'expiry', 6_000, 6),
      ev('w2', 'MILK-1', 'dairy', 'damage', 2_000, 2),
      ev('w3', 'BREAD-1', 'bakery', 'expiry', 1_500, 3),
      ev('w4', 'APPLE-1', null, 'leaking', 500, 1), // stored before D-5 / another path: off the list, no department
    ]);
    expect(a.events).toBe(4);
    expect(a.totalValueMinor).toBe(10_000);
    expect(a.bySku).toEqual([
      { key: 'MILK-1', valueMinor: 8_000, qty: 8, events: 2, shareBps: 8_000 },
      { key: 'BREAD-1', valueMinor: 1_500, qty: 3, events: 1, shareBps: 1_500 },
      { key: 'APPLE-1', valueMinor: 500, qty: 1, events: 1, shareBps: 500 },
    ]);
    expect(a.byDepartment.map((l) => [l.key, l.valueMinor])).toEqual([['dairy', 8_000], ['bakery', 1_500], [NO_DEPARTMENT, 500]]);
    expect(a.byReason.map((l) => [l.key, l.valueMinor, l.events])).toEqual([['expiry', 7_500, 2], ['damage', 2_000, 1], [UNCLASSIFIED, 500, 1]]);
    expect(a.unclassified).toEqual({ events: 1, reasonsSeen: ['leaking'] });
    for (const lines of [a.bySku, a.byDepartment, a.byReason]) {
      expect(lines.reduce((s, l) => s + l.valueMinor, 0)).toBe(a.totalValueMinor);
      expect(lines.reduce((s, l) => s + l.events, 0)).toBe(a.events);
    }
  });

  it('an empty window is all zeros, never a division by zero', () => {
    expect(aggregateWaste([])).toEqual({ events: 0, totalValueMinor: 0, bySku: [], byDepartment: [], byReason: [], unclassified: { events: 0, reasonsSeen: [] } });
  });
});
