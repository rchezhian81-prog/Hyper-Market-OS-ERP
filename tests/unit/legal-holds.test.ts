import { describe, it, expect } from 'vitest';
import { projectHolds, type LegalHoldEvent } from '../../services/finance/src/legal-holds';
import type { LegalHold } from '../../packages/audit/src/index';

// The legal-hold FOLD — place / lift folded latest-per-hold, and a hold is NEVER erased (a lift is a new
// state on the same hold). This is the durable half of M34-FR-02.

const placed = (holdId: string, over: Partial<LegalHold> = {}): LegalHoldEvent => ({
  holdId, change: 'placed', by: 'u-owner', at: '2026-09-01T00:00:00Z',
  hold: { holdId, reason: 'a dispute', placedBy: 'u-owner', placedAt: '2026-09-01T00:00:00Z', ...over },
});
const lifted = (holdId: string, at = '2026-09-05T00:00:00Z'): LegalHoldEvent => ({ holdId, change: 'lifted', by: 'u-legal', at });

describe('projectHolds folds the append-only legal-hold log', () => {
  it('places a hold, then a lift records a new state without erasing the hold', () => {
    const holds = projectHolds([placed('h1', { objectType: 'invoice' }), lifted('h1')]);
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({ holdId: 'h1', objectType: 'invoice', reason: 'a dispute', liftedBy: 'u-legal', liftedAt: '2026-09-05T00:00:00Z' });
  });

  it('ignores a lift for a hold nobody placed, and a re-place keeps the original', () => {
    const holds = projectHolds([
      { holdId: 'ghost', change: 'lifted', by: 'x', at: '2026-09-05T00:00:00Z' },
      placed('h1', { reason: 'first' }),
      placed('h1', { reason: 'second attempt' }), // re-place of a known id is ignored
    ]);
    expect(holds).toHaveLength(1);
    expect(holds[0]!.reason).toBe('first');
  });

  it('a second lift after a lift changes nothing (the hold is lifted once)', () => {
    const holds = projectHolds([placed('h1'), lifted('h1', '2026-09-05T00:00:00Z'), lifted('h1', '2026-09-09T00:00:00Z')]);
    expect(holds[0]!.liftedAt).toBe('2026-09-05T00:00:00Z'); // the first lift stands
  });
});
