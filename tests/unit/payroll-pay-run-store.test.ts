import { describe, it, expect } from 'vitest';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';
import { payRunAdapter } from '../../services/api/src/adapters';
import type { PayRunEvent } from '../../packages/payroll/src/index';

// The durable pay-run store (WP3 inc9): lifecycle events append to the shared event log (one stream per
// run) and fold to the current state — so a run survives a restart. Maker ≠ checker holds on the read fold.

const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const now = () => '2026-08-28T12:00:00.000Z';

const drafted: PayRunEvent = { kind: 'drafted', payPeriod: '2026-08', by: 'maker', at: '2026-08-28T10:00:00Z' };
const submitted: PayRunEvent = { kind: 'submitted', by: 'maker', at: '2026-08-28T10:05:00Z' };

describe('payRunAdapter — durable, append-only, folds to current state', () => {
  it('appends the lifecycle and folds it back to the current state', async () => {
    const store = new InMemoryEventStore();
    const a = payRunAdapter({ store, now });
    await a.append(T, 'pr1', drafted);
    await a.append(T, 'pr1', submitted);
    await a.append(T, 'pr1', { kind: 'approved', by: 'checker', at: '2026-08-28T10:10:00Z' });
    await a.append(T, 'pr1', { kind: 'locked', at: '2026-08-28T10:15:00Z' });
    const run = await a.load(T, 'pr1');
    expect(run?.state).toBe('locked');
    expect(run?.submittedBy).toBe('maker');
    expect(run?.approvedBy).toBe('checker');
  });

  it('survives a restart — a fresh adapter over the same store folds the same state', async () => {
    const store = new InMemoryEventStore();
    await payRunAdapter({ store, now }).append(T, 'pr2', drafted);
    await payRunAdapter({ store, now }).append(T, 'pr2', submitted);
    // A brand-new adapter instance (the "restart") reads the persisted events and folds them.
    const afterRestart = await payRunAdapter({ store, now }).load(T, 'pr2');
    expect(afterRestart?.state).toBe('submitted');
    expect(afterRestart?.payPeriod).toBe('2026-08');
  });

  it('never lets a self-approval take effect — the fold ignores it (maker not checker)', async () => {
    const store = new InMemoryEventStore();
    const a = payRunAdapter({ store, now });
    await a.append(T, 'pr3', drafted);
    await a.append(T, 'pr3', submitted);
    await a.append(T, 'pr3', { kind: 'approved', by: 'maker', at: '2026-08-28T10:10:00Z' }); // submitter self-approving
    const run = await a.load(T, 'pr3');
    expect(run?.state).toBe('submitted'); // still submitted — the self-approval was not applied
    expect(run?.approvedBy).toBeUndefined();
  });

  it('is idempotent — re-appending the same step collapses to one fact', async () => {
    const store = new InMemoryEventStore();
    const a = payRunAdapter({ store, now });
    await a.append(T, 'pr4', drafted);
    await a.append(T, 'pr4', drafted); // retry of the same draft
    const all = await store.exportTenant(T);
    expect(all).toHaveLength(1); // one fact, not two
    expect((await a.load(T, 'pr4'))?.state).toBe('draft');
  });

  it('keeps each run in its own stream — one run never sees another', async () => {
    const store = new InMemoryEventStore();
    const a = payRunAdapter({ store, now });
    await a.append(T, 'pr-a', drafted);
    await a.append(T, 'pr-b', { kind: 'drafted', payPeriod: '2026-09', by: 'maker', at: '2026-09-28T10:00:00Z' });
    expect((await a.load(T, 'pr-a'))?.payPeriod).toBe('2026-08');
    expect((await a.load(T, 'pr-b'))?.payPeriod).toBe('2026-09');
    expect(await a.load(T, 'pr-missing')).toBeUndefined();
  });
});
