import { describe, it, expect } from 'vitest';
import { apiHarness } from '../support/api-harness';
import type { SetupStatus } from '../../packages/tenant/src/setup';

/**
 * **Config version history + rollback — every setting change is versioned and reversible (M33-FR-01, API-11).**
 *
 * Setup answers already write through the versioned config engine (each setting key is a config key). This
 * exposes the missing surface: an admin can VIEW a setting's full audited history and ROLL BACK to a prior
 * version — which restores that version's value as a NEW append-only version (the history is never rewritten),
 * and the rollback flows straight back to the live setting because history and settings share one store.
 */

const TENANT = 't-sre';
const KEY = 'tax.default_bps';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const setSetting = (h: ReturnType<typeof apiHarness>, u: string, value: number, ifVersion: number, key: string) =>
  h.request({ method: 'PUT', path: `/v1/platform/setup/${KEY}`, userId: u, tenantId: TENANT, idempotencyKey: key, body: { value, ifVersion } });
const history = (h: ReturnType<typeof apiHarness>, u: string) =>
  h.request({ method: 'GET', path: `/v1/platform/config/${KEY}/history`, userId: u, tenantId: TENANT });
const currentConfig = (h: ReturnType<typeof apiHarness>, u: string) =>
  h.request({ method: 'GET', path: `/v1/platform/config/${KEY}`, userId: u, tenantId: TENANT });
const rollback = (h: ReturnType<typeof apiHarness>, u: string, toVersion: unknown, key: string, reason = 'the new rate was a typo') =>
  h.request({ method: 'POST', path: `/v1/platform/config/${KEY}/rollback`, userId: u, tenantId: TENANT, idempotencyKey: key, body: { toVersion, reason } });
const setupStatus = (h: ReturnType<typeof apiHarness>, u: string) =>
  h.request({ method: 'GET', path: '/v1/platform/setup', userId: u, tenantId: TENANT });
const taxItem = (s: SetupStatus): { value: unknown; version: number } => s.items.find((i) => i.key === KEY)!;

describe('config version history + rollback (M33-FR-01)', () => {
  it('records each setting change as a version, shows the history, and rolls back to a prior version', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');

    expect((await setSetting(h, 'u-owner', 1800, 0, 's-1')).status).toBe(200); // v1
    expect((await setSetting(h, 'u-owner', 2000, 1, 's-2')).status).toBe(200); // v2

    const hist = (await history(h, 'u-owner')).body as { versions: { version: number; value: unknown; author: string; reason: string; rolledBackFrom: number | null }[] };
    expect(hist.versions.map((v) => [v.version, v.value])).toEqual([[1, 1800], [2, 2000]]);
    expect((await currentConfig(h, 'u-owner')).body).toMatchObject({ current: { version: 2, value: 2000 } });

    // Roll back to v1 → a NEW version (v3) restoring 1800, marked as a rollback of v1. The history keeps v2.
    const rb = await rollback(h, 'u-owner', 1, 'rb-1');
    expect(rb.status).toBe(200);
    expect((rb.body as { restored: { version: number; value: unknown; rolledBackFrom: number | null } }).restored).toMatchObject({ version: 3, value: 1800, rolledBackFrom: 1 });

    // The rollback flows back to the live setting (shared store): the tax rate reads 1800 again.
    expect(taxItem((await setupStatus(h, 'u-owner')).body as SetupStatus).value).toBe(1800);
    // ...and the whole history is retained, never rewritten.
    expect(((await history(h, 'u-owner')).body as { versions: unknown[] }).versions).toHaveLength(3);
  });

  it('refuses a rollback to a version that does not exist, and a malformed request', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    await setSetting(h, 'u-owner', 1800, 0, 's-1');

    const missing = await rollback(h, 'u-owner', 99, 'rb-missing');
    expect(missing.status).toBe(404);
    expect(codeOf(missing)).toBe('config_version_not_found');

    const bad = await rollback(h, 'u-owner', 'first', 'rb-bad');
    expect(bad.status).toBe(400);
    expect(codeOf(bad)).toBe('not_readable_as_a_rollback');
  });

  it('is gated — a health-only reader cannot roll a setting back', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    await setSetting(h, 'u-owner', 1800, 0, 's-1');
    await h.provisionRole(TENANT, 'u-cash', 'cashier'); // no platform.setup.* at all

    expect((await history(h, 'u-cash')).status).toBe(403);
    expect((await rollback(h, 'u-cash', 1, 'rb-cash')).status).toBe(403);
    // A no-role user authorises nothing.
    expect((await currentConfig(h, 'u-nobody')).status).toBe(403);
  });
});
