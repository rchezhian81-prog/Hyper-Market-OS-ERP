import { describe, it, expect } from 'vitest';
import {
  applyMovement,
  suggestPutAway,
  binKey,
  binOccupancy,
  type Bin,
  type BinContents,
  type MovementCommand,
} from '../../packages/warehouse/src/index';

// M09-FR-01 — the warehouse handheld. A movement command that is not uniquely
// identified is a movement that can happen twice, and a bin moved twice from stock
// it held once goes negative.

const AT = '2026-08-06T09:00:00Z';

const BINS: Bin[] = [
  { binId: 'A-01', storeId: 'store-1', capacityMinor: 100, pickable: true },
  { binId: 'A-02', storeId: 'store-1', capacityMinor: 50, pickable: true }, // nearly full, for the bin-full case
  { binId: 'B-01', storeId: 'store-1', capacityMinor: 100, pickable: true }, // has room
  { binId: 'Q-01', storeId: 'store-1', capacityMinor: 200, pickable: false, zone: 'quarantine' },
  { binId: 'X-00', storeId: 'store-1', capacityMinor: 0, pickable: false },
];

const CONTENTS: BinContents = {
  [binKey('A-01', 'p-rice', null)]: 40,
  [binKey('A-02', 'p-oil', null)]: 45,
};

function command(over: Partial<MovementCommand> = {}): MovementCommand {
  return {
    commandId: 'mv-1',
    kind: 'bin_to_bin',
    storeId: 'store-1',
    productId: 'p-rice',
    batchId: null,
    quantityMinor: 10,
    uom: 'ea',
    fromBinId: 'A-01',
    toBinId: 'B-01',
    movedBy: 'wh-1',
    at: AT,
    ...over,
  };
}

function move(over: Partial<Parameters<typeof applyMovement>[0]> = {}) {
  return applyMovement({
    command: command(),
    appliedCommandIds: [],
    bins: BINS,
    contents: CONTENTS,
    ...over,
  });
}

describe('the double scan and the ledger', () => {
  it('moves stock and produces exactly one out and one in', () => {
    const result = move();
    expect(result.accepted).toBe(true);
    expect(result.movements).toHaveLength(2);
    expect(result.movements[0]?.locationId).toBe('A-01');
    expect(result.movements[0]?.to).toBeNull();
    expect(result.movements[1]?.locationId).toBe('B-01');
    expect(result.movements[1]?.to).toBe('on_hand');
  });

  it('makes a repeated command a no-op that says so (§31.1)', () => {
    const result = move({ appliedCommandIds: ['mv-1'] });
    expect(result.outcome).toBe('duplicate_ignored');
    expect(result.movements).toEqual([]);
  });

  it('records who moved it and when, on every movement', () => {
    const result = move();
    expect(result.movements[0]?.reason).toContain('bin_to_bin by wh-1');
    expect(result.movements[0]?.at).toBe(AT);
  });

  it('puts away from goods-in with no source bin, and dispatches with no destination', () => {
    const putAway = move({ command: command({ kind: 'put_away', fromBinId: null, toBinId: 'A-01' }) });
    expect(putAway.movements).toHaveLength(1);
    expect(putAway.movements[0]?.from).toBeNull();

    const dispatch = move({
      command: command({ kind: 'dispatch', fromBinId: 'A-01', toBinId: null, quantityMinor: 5 }),
    });
    expect(dispatch.movements).toHaveLength(1);
    expect(dispatch.movements[0]?.to).toBeNull();
  });
});

describe('the three refusals that protect the count', () => {
  it('queues an unknown bin rather than inventing one', () => {
    const result = move({ command: command({ toBinId: 'Z-99' }) });
    expect(result.outcome).toBe('unknown_bin');
    expect(result.resolutionRequired).toBe(true);
    expect(result.detail).toContain('how stock becomes unfindable');
  });

  it('blocks a bin that cannot hold the quantity', () => {
    // A-02 holds 50 and already has 45.
    const result = move({ command: command({ quantityMinor: 10, toBinId: 'A-02' }) });
    expect(result.outcome).toBe('bin_full');
    expect(result.detail).toContain('the overflow ends up on the floor');
    expect(move({ command: command({ toBinId: 'X-00' }) }).outcome).toBe('bin_full');
  });

  it('refuses to take more out of a bin than it holds — no negative bins', () => {
    const result = move({ command: command({ quantityMinor: 400 }) });
    expect(result.outcome).toBe('insufficient_in_bin');
    expect(result.detail).toContain('would make the bin negative');
  });

  it('refuses a movement of nothing, or from nowhere to nowhere', () => {
    expect(move({ command: command({ quantityMinor: 0 }) }).outcome).toBe('invalid_command');
    expect(move({ command: command({ fromBinId: null, toBinId: null }) }).outcome).toBe(
      'invalid_command',
    );
  });
});

describe('bad stock never reaches a pickable bin', () => {
  it('refuses to put quarantined stock where someone will pick it', () => {
    const result = move({
      command: command({ fromBinId: null, toBinId: 'A-01', stockState: 'quarantine' }),
    });
    expect(result.outcome).toBe('not_pickable_state');
    expect(result.detail).toContain('put it in a holding or quarantine bin');
  });

  it('allows it into a holding bin', () => {
    const result = move({
      command: command({ fromBinId: null, toBinId: 'Q-01', stockState: 'quarantine' }),
    });
    expect(result.accepted).toBe(true);
    expect(result.movements[0]?.to).toBe('quarantine');
  });

  it('refuses expired and damaged stock into a pickable bin too', () => {
    for (const state of ['expired', 'damaged'] as const) {
      expect(
        move({ command: command({ fromBinId: null, toBinId: 'A-01', stockState: state }) }).outcome,
      ).toBe('not_pickable_state');
    }
  });
});

describe('suggestPutAway — keep one product in one place', () => {
  it('prefers a bin that already holds the same product', () => {
    const suggestion = suggestPutAway({
      productId: 'p-rice',
      batchId: null,
      quantityMinor: 20,
      bins: BINS,
      contents: CONTENTS,
    });
    expect('binId' in suggestion && suggestion.binId).toBe('A-01');
    expect(suggestion.detail).toContain('keeping it in one place');
  });

  it('never suggests a pickable bin for stock that is not sellable', () => {
    const suggestion = suggestPutAway({
      productId: 'p-rice',
      batchId: null,
      quantityMinor: 20,
      state: 'quarantine',
      bins: BINS,
      contents: CONTENTS,
    });
    expect('binId' in suggestion && suggestion.binId).toBe('Q-01');
  });

  it('says so when nothing has room, rather than picking a bin that does not fit', () => {
    const suggestion = suggestPutAway({
      productId: 'p-rice',
      batchId: null,
      quantityMinor: 5_000,
      bins: BINS,
      contents: CONTENTS,
    });
    expect('binId' in suggestion).toBe(false);
    expect(suggestion.detail).toContain('no bin has room');
  });

  it('refuses to free space by putting held stock somewhere pickable', () => {
    const full: BinContents = { ...CONTENTS, [binKey('Q-01', 'other', null)]: 200 };
    const suggestion = suggestPutAway({
      productId: 'p-rice',
      batchId: null,
      quantityMinor: 20,
      state: 'quarantine',
      bins: BINS,
      contents: full,
    });
    expect('binId' in suggestion).toBe(false);
    expect(suggestion.detail).toContain('must not be put in a pickable bin to make space');
  });

  it('counts everything in a bin, not just one product', () => {
    expect(binOccupancy('A-01', CONTENTS)).toBe(40);
    expect(binOccupancy('EMPTY', CONTENTS)).toBe(0);
  });
});
