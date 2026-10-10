import { describe, it, expect } from 'vitest';
import { branchOfLocationIn, stockReadScope, assertLocationInScope, locationIsItsOwnBranch } from '../../services/inventory/src/location-scope';

// PA-01-r1: a stock location belongs to the branch the org hierarchy puts it under; reads narrow, writes refuse by name.
const nodes = [
  { nodeId: 'C1', kind: 'company', parentId: null },
  { nodeId: 'br-1', kind: 'branch', parentId: 'C1' },
  { nodeId: 'bs-1', kind: 'warehouse', parentId: 'br-1' },
  { nodeId: 'dept-1', kind: 'department', parentId: 'bs-1' },
  { nodeId: 'WH', kind: 'warehouse', parentId: 'C1' },
  { nodeId: 'loop-a', kind: 'warehouse', parentId: 'loop-b' },
  { nodeId: 'loop-b', kind: 'warehouse', parentId: 'loop-a' },
];
const rejectsWith = async (p: Promise<unknown>): Promise<string | undefined> => {
  try { await p; return undefined; } catch (e) { return (e as { body?: { code?: string } }).body?.code ?? String(e); }
};

describe('a stock location is placed under its branch (PA-01-r1)', () => {
  const branchOf = branchOfLocationIn(nodes);
  it('a branch is its own; a back store and its department belong to the branch above; a company-level or unknown location is its own key', () => {
    expect(branchOf('br-1')).toBe('br-1');
    expect(branchOf('bs-1')).toBe('br-1');
    expect(branchOf('dept-1')).toBe('br-1');
    expect(branchOf('WH')).toBe('WH');
    expect(branchOf('L1')).toBe('L1');
    expect(branchOf('loop-a')).toBe('loop-a'); // a malformed cycle terminates, and places nothing
  });

  it('a read with no branch named narrows to what is held; a branch not held is refused by name; all-scope reads everything', async () => {
    const branches = () => branchOf;
    const mine = await stockReadScope({ scope: ['br-1'], tenantId: 't', query: {} }, branches);
    expect([mine.covers('bs-1'), mine.covers('WH'), mine.everything]).toEqual([true, false, false]);
    expect(await rejectsWith(stockReadScope({ scope: ['br-1'], tenantId: 't', query: { branchId: 'WH' } }, branches))).toBe('scope_not_held');
    const owner = await stockReadScope({ scope: 'all', tenantId: 't', query: {} }, branches);
    expect([owner.everything, owner.covers('anything')]).toEqual([true, true]);
    // outside the pipeline nothing is held: fail closed
    expect((await stockReadScope({ tenantId: 't', query: {} })).covers('br-1')).toBe(false);
  });

  it('a write outside the caller\'s branches is refused by name; inside, and for the owner, it passes', async () => {
    const branches = () => branchOf;
    expect(await rejectsWith(assertLocationInScope({ scope: ['br-1'], tenantId: 't' }, 'WH', branches))).toBe('outside_your_branch_scope');
    expect(await rejectsWith(assertLocationInScope({ scope: ['br-1'], tenantId: 't' }, 'dept-1', branches))).toBeUndefined();
    expect(await rejectsWith(assertLocationInScope({ scope: 'all', tenantId: 't' }, 'WH', branches))).toBeUndefined();
    expect(await rejectsWith(assertLocationInScope({ tenantId: 't' }, 'br-1', locationIsItsOwnBranch))).toBe('outside_your_branch_scope');
  });
});
