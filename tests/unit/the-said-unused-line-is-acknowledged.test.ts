import { describe, it, expect } from 'vitest';
import {
  billNumberFindingsFor, unusedReceivedAcknowledgementStands, UNUSED_RECEIVED_STAYS_WORDS,
  type UnusedReceived, type UnusedReceivedAcknowledgement,
} from '../../services/platform/src/box-health';

/**
 * **Round 28 · OB-103 "A" (owner, 13 Oct 2026, in writing, "You/HO acknowledge") — the rule, by hand.** The "said unused,
 * but head office has the bill" line for a (store, prefix) is silenced only by an acknowledgement given with ALL-STORES
 * business authority whose numbers are EXACTLY the set head office finds now; a new number (any change of the set) shows
 * the line again. An acknowledgement kept without that authority is never honoured.
 */

const ack = (numbers: [number, number][], over: Partial<UnusedReceivedAcknowledgement> = {}): UnusedReceivedAcknowledgement => ({
  storeId: 'S1', prefix: 'S1L1-', numbers, count: numbers.reduce((n, [a, z]) => n + z - a + 1, 0), reason: 'support checked it', by: 'u-owner', at: '2026-10-13T10:00:00.000Z', authority: 'all_stores', ...over,
});
const held = (n: number): UnusedReceived => ({ prefix: 'S1L1-', number: n, heldAs: 'sale', heldAt: '2026-10-13T06:00:00.000Z', lastSaidUnusedAt: '2026-10-13T09:00:00.000Z' });
const lines = (unusedReceived: UnusedReceived[], unusedAcknowledged: UnusedReceivedAcknowledgement[]) =>
  billNumberFindingsFor({ storeId: 'S1', records: [], at: '2026-10-13T11:00:00.000Z', unreceived: [], unusedReceived, unusedAcknowledged }).filter((f) => f.kind === 'unused_number_received');

describe('round 28 · OB-103: the "said unused, but held" acknowledgement, by hand', () => {
  it('holds for exactly the set acknowledged — not a larger one, not a smaller one, not another store or prefix', () => {
    expect(unusedReceivedAcknowledgementStands('S1', 'S1L1-', [[105, 105]], [ack([[105, 105]])])).toBe(true);
    // The same numbers written as touching ranges are the same set.
    expect(unusedReceivedAcknowledgementStands('S1', 'S1L1-', [[105, 106]], [ack([[105, 105], [106, 106]])])).toBe(true);
    expect(unusedReceivedAcknowledgementStands('S1', 'S1L1-', [[105, 105], [107, 107]], [ack([[105, 105]])])).toBe(false); // a new number
    expect(unusedReceivedAcknowledgementStands('S1', 'S1L1-', [[105, 105]], [ack([[105, 105], [107, 107]])])).toBe(false); // a changed set
    expect(unusedReceivedAcknowledgementStands('S2', 'S1L1-', [[105, 105]], [ack([[105, 105]])])).toBe(false);
    expect(unusedReceivedAcknowledgementStands('S1', 'S1L2-', [[105, 105]], [ack([[105, 105]])])).toBe(false);
    expect(unusedReceivedAcknowledgementStands('S1', 'S1L1-', [], [ack([[105, 105]])])).toBe(false);
  });

  it('an acknowledgement kept without all-stores authority is never honoured', () => {
    const { authority: _a, ...without } = ack([[105, 105]]);
    void _a;
    expect(unusedReceivedAcknowledgementStands('S1', 'S1L1-', [[105, 105]], [without])).toBe(false);
    expect(lines([held(105)], [without])).toHaveLength(1);
  });

  it('the finding: said with how it stays; silenced by the acknowledgement; back, naming every number, when a new one comes', () => {
    const before = lines([held(105)], []);
    expect(before.map((f) => [f.prefix, f.ranges, f.count])).toEqual([['S1L1-', [[105, 105]], 1]]);
    expect(before[0]!.detail.endsWith(UNUSED_RECEIVED_STAYS_WORDS)).toBe(true);
    expect(UNUSED_RECEIVED_STAYS_WORDS).toMatch(/owner or head office staff \(all-stores authority/);
    expect(lines([held(105)], [ack([[105, 105]])])).toEqual([]);
    expect(lines([held(105), held(107)], [ack([[105, 105]])]).map((f) => [f.ranges, f.count])).toEqual([[[[105, 105], [107, 107]], 2]]);
    expect(lines([held(105), held(107)], [ack([[105, 105]]), ack([[105, 105], [107, 107]], { by: 'u-ho' })])).toEqual([]);
  });
});
