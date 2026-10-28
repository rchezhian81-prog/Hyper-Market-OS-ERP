import { describe, it, expect } from 'vitest';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';
import { platformAdapter } from '../../services/api/src/adapters';
import { tenantEntitlementResolver } from '../../services/api/src/access';

/**
 * **A module switch turned OFF and back ON within the same millisecond ends ON — no change is silently dropped
 * (P-08 · hard rules #2 #10).**
 *
 * Each switch change was keyed by its moment alone, so an "on" recorded in the same millisecond as the "off" before it
 * collapsed into the "off" as a duplicate and vanished: the module stayed off with nothing said. On a fast machine the
 * B2B recurring-order journey (b2b off → on) failed this way. Every change is now its own fact.
 */
describe('a feature switch changed twice in one millisecond keeps both changes', () => {
  it('off then on at the same moment → on, with every change on record', async () => {
    const store = new InMemoryEventStore();
    const NOW = '2026-10-28T05:00:00.000Z';
    const platform = platformAdapter({ store, now: () => NOW, probes: async () => [] });
    const T = 'tenant-switch';
    await platform.setEntitlement(T, 'b2b', true, 'u-owner');
    await platform.setEntitlement(T, 'b2b', false, 'u-owner');
    await platform.setEntitlement(T, 'b2b', true, 'u-owner');
    expect(await platform.entitlements(T)).toEqual(['b2b']);
    expect(await tenantEntitlementResolver(store)(T)).toEqual(['b2b']);
    expect(await store.readStream(T, 'platform', { type: 'TenantEntitlementSet' })).toHaveLength(3);
  });
});
