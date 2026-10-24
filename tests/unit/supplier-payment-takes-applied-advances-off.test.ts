// OB-341 (owner, 24 Oct 2026, in writing): the supplier payment route takes what the supplier's advances already settled off
// what is owed automatically. This is the hook it reads: every application of an advance to the supplier's bills, net of
// reversals, from the ledger's own supplier-advance journals — another supplier's never counts. Synthetic figures only.
import { describe, it, expect } from 'vitest';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM } from '../../services/api/src/adapters';
import { finBridgePaymentHooks } from '../../services/api/src/finance-bridge-adapters';

const T = 'tenant-ob341';
const journal = (entryId: string, supplierId: string, change: 'paid' | 'applied', amountMinor: number, extra: Record<string, unknown> = {}) => makeEvent({
  id: entryId, type: 'JournalPosted', occurredAt: '2026-10-24T06:00:00.000Z', idempotencyKey: `j-${entryId}`, source: 'test/ob-341',
  payload: {
    entryId, period: '2026-10', documentDate: '2026-10-24', narrative: 'synthetic', postedBy: 'u-acct', lines: [],
    supplierAdvance: { change, advanceId: `adv-${supplierId}`, supplierId, amountMinor, on: '2026-10-24', ...extra },
  },
});

describe('what advances already settled, for the payment route (OB-341)', () => {
  it('is the applications net of reversals, per supplier; a paid advance not yet set against a bill settles nothing', async () => {
    const store = new InMemoryEventStore();
    for (const e of [
      journal('p1', 'sup-1', 'paid', 50_000),
      journal('a1', 'sup-1', 'applied', 30_000, { applicationId: 'app-1', invoiceId: 'inv-a' }),
      journal('a2', 'sup-1', 'applied', 10_000, { applicationId: 'rev-1', reverses: 'app-1' }),
      journal('p2', 'sup-2', 'paid', 7_000),
      journal('a3', 'sup-2', 'applied', 7_000, { applicationId: 'app-9', invoiceId: 'inv-z' }),
      journal('p3', 'sup-3', 'paid', 9_000),
    ]) await store.append(T, STREAM.finance, e);
    const { advancesApplied } = finBridgePaymentHooks({ store, now: () => '2026-10-24T07:00:00.000Z' });
    expect(await advancesApplied(T, 'sup-1')).toBe(20_000);
    expect(await advancesApplied(T, 'sup-2')).toBe(7_000);
    expect(await advancesApplied(T, 'sup-3')).toBe(0);
    expect(await advancesApplied(T, 'nobody')).toBe(0);
  });
});
