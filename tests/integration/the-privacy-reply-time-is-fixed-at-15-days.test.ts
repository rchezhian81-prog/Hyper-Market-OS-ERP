import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ApiHarness } from '../support/api-harness';
import { r3OpsBackings, tenantClient } from '../support/r3-ops-backings';
import { STREAM, streamName } from '../../services/api/src/adapters';
import { makeEvent } from '../../packages/contracts/src/event';
import { fixedPrivacySlaDays, PUBLISHED_RESPONSE_SLA_DAYS } from '../../packages/customer/src/data-rights';

/**
 * **R3 · C5 · OB-195 "A" (owner, 18 Oct 2026, in writing, "Lock to 15 days")** — on the real API, in memory and on real
 * PostgreSQL, with a cold restart: a store's privacy reply time is fixed at the published 15 days. Any other value is
 * refused when set; the store's setup pack carries 15; a value already stored before the lock is read as 15 and flagged.
 */
const backings = r3OpsBackings();
const SETTINGS = { tradingDayCutoff: '02:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 5_000, cashVarianceToleranceMinor: 5_000, warehouseId: null };

describe('the pure read (OB-195)', () => {
  it('15 is read as 15 with no flag; anything else (or nothing) is read as 15 and flagged with what was stored', () => {
    expect(PUBLISHED_RESPONSE_SLA_DAYS).toBe(15);
    expect(fixedPrivacySlaDays(15)).toEqual({ days: 15, flag: null, storedDays: null });
    expect(fixedPrivacySlaDays(30)).toEqual({ days: 15, flag: 'privacy_sla_stored_value_read_as_15', storedDays: 30 });
    expect(fixedPrivacySlaDays(1)).toMatchObject({ days: 15, flag: 'privacy_sla_stored_value_read_as_15' });
    expect(fixedPrivacySlaDays(undefined)).toEqual({ days: 15, flag: 'privacy_sla_stored_value_read_as_15', storedDays: null });
  });
});

describe.each(backings)('the privacy reply time is fixed at 15 days — on $name (C5 · OB-195)', ({ harness, restart }) => {
  it('30 refused by name; 15 set; the pack carries 15; a stored 30 is read as 15 and flagged; only the owner sets it', async () => {
    let h: ApiHarness = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager', ['S1']);
    await h.provisionRole(T, 'u-box', 'store_computer', ['S1']);
    const { req, ok, code } = tenantClient(() => h, T);
    await ok(req('POST', '/v1/org/nodes/C1', { kind: 'company', name: 'Synthetic Retail' }), 'company');
    await ok(req('POST', '/v1/org/nodes/S1', { kind: 'branch', name: 'Store 1', parentId: 'C1', companyId: 'C1' }), 'store');

    // ── any other value is refused when set, by name; nothing is saved ──
    for (const days of [30, 14, 0]) {
      const r = await req('POST', '/v1/stores/S1/settings', { ...SETTINGS, privacySlaDays: days });
      expect([r.status, code(r)]).toEqual([422, 'privacy_sla_fixed_at_15_days']);
    }
    expect((await req('GET', '/v1/stores/S1/settings')).status).toBe(404);
    // A manager may not set store settings at all (the owner's).
    expect((await req('POST', '/v1/stores/S1/settings', { ...SETTINGS, privacySlaDays: 15 }, 'u-mgr')).status).toBe(403);
    // Missing is not readable, as before.
    expect(code(await req('POST', '/v1/stores/S1/settings', SETTINGS))).toBe('not_readable_as_store_settings');

    const set = (await ok(req('POST', '/v1/stores/S1/settings', { ...SETTINGS, privacySlaDays: 15 }), 'settings')).body as { settings: { privacySlaDays: number; version: number } };
    expect(set.settings).toMatchObject({ privacySlaDays: 15, version: 1 });
    const read1 = (await ok(req('GET', '/v1/stores/S1/settings'), 'read')).body as { settings: Record<string, unknown> };
    expect(read1.settings).toMatchObject({ privacySlaDays: 15 });
    expect(read1.settings['flags']).toBeUndefined();

    // ── a version stored BEFORE the lock with 30 (synthetic: appended as the old route would have) ──
    await h.store.append(T, streamName(STREAM.org, 'store-settings'), makeEvent({
      id: 'store-settings-S1-v2', type: 'StoreSettingsSet', occurredAt: '2026-10-10T00:00:00.000Z',
      idempotencyKey: `store-settings-${T}-S1-v2`, source: 'api/platform',
      payload: { storeId: 'S1', ...SETTINGS, privacySlaDays: 30, version: 2, setBy: 'u-owner', setAt: '2026-10-10T00:00:00.000Z' },
    }));

    h = restart(h); // ── COLD RESTART ──

    const read2 = (await ok(req('GET', '/v1/stores/S1/settings'), 'read old')).body as { settings: Record<string, unknown> };
    expect(read2.settings).toMatchObject({ version: 2, privacySlaDays: 15, flags: ['privacy_sla_stored_value_read_as_15'], storedPrivacySlaDays: 30 });
    // The store's setup pack carries 15, never the stored 30.
    const pack = (await ok(h.request({ method: 'GET', path: '/v1/store-packs/S1', userId: 'u-box', tenantId: T, branchId: 'S1' }), 'pack')).body as { sections: { policies: { privacySlaDays: number } } };
    expect(pack.sections.policies.privacySlaDays).toBe(15);
    // Setting it again with 15 clears the flag on the new version; the old version stays on the record (append-only).
    const v3 = (await ok(req('POST', '/v1/stores/S1/settings', { ...SETTINGS, privacySlaDays: 15 }), 'settings again')).body as { settings: { version: number } };
    expect(v3.settings.version).toBe(3);
    const read3 = (await ok(req('GET', '/v1/stores/S1/settings'), 'read new')).body as { settings: Record<string, unknown> };
    expect(read3.settings['flags']).toBeUndefined();
    expect((await h.store.readStream(T, streamName(STREAM.org, 'store-settings'), { type: 'StoreSettingsSet' })).map((e) => (e.event.payload as { privacySlaDays: number }).privacySlaDays)).toEqual([15, 30, 15]);
  }, 60_000);
});
