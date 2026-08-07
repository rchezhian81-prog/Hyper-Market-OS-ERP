import { describe, it, expect } from 'vitest';
import { apiHarness } from '../support/api-harness';

// The store-setup surface, end to end through the REAL pipeline (M33-FR-01, API-11) — real token
// verifier, real per-tenant authorization, real durable settings. This is M33's INTEGRATION-TESTED
// evidence, and it exercises the store-setup endpoints that were 403-for-everyone until the
// permission reconciliation (they now require platform.setup.read/write, which the owner holds).

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
interface SetupItem { key: string; value: unknown; version: number; isDefault: boolean }
interface SetupStatus { items: SetupItem[]; complete: boolean; blocking: string[] }

const item = (s: SetupStatus, key: string): SetupItem => {
  const found = s.items.find((i) => i.key === key);
  if (found === undefined) throw new Error(`no setup item ${key}`);
  return found;
};

describe('store-setup surface end to end (M33-FR-01, API-11)', () => {
  it('an owner reads setup, answers a setting, and the change persists with a new version', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    const read = await h.request({ method: 'GET', path: '/v1/platform/setup', userId: 'u-owner', tenantId: A });
    expect(read.status).toBe(200);
    const before = read.body as SetupStatus;
    expect(before.items.length).toBeGreaterThan(0);
    expect(item(before, 'tax.default_bps').isDefault).toBe(true);

    const put = await h.request({
      method: 'PUT', path: '/v1/platform/setup/tax.default_bps', userId: 'u-owner', tenantId: A,
      idempotencyKey: 'setup-tax-1', body: { value: 1800, ifVersion: item(before, 'tax.default_bps').version },
    });
    expect(put.status).toBe(200);

    const after = (await h.request({ method: 'GET', path: '/v1/platform/setup', userId: 'u-owner', tenantId: A })).body as SetupStatus;
    const tax = item(after, 'tax.default_bps');
    expect(tax.value).toBe(1800);
    expect(tax.version).toBe(1);
    expect(tax.isDefault).toBe(false);
  });

  it('refuses a stale write (409) and an unknown setting (404)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    const stale = await h.request({
      method: 'PUT', path: '/v1/platform/setup/tax.default_bps', userId: 'u-owner', tenantId: A,
      idempotencyKey: 'setup-stale', body: { value: 1200, ifVersion: 5 },
    });
    expect(stale.status).toBe(409);

    const unknown = await h.request({
      method: 'PUT', path: '/v1/platform/setup/no.such.key', userId: 'u-owner', tenantId: A,
      idempotencyKey: 'setup-unknown', body: { value: 1 },
    });
    expect(unknown.status).toBe(404);
  });

  it('is authorized: a cashier cannot read or write setup (403)', async () => {
    const h = apiHarness();
    await h.provisionOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');

    expect((await h.request({ method: 'GET', path: '/v1/platform/setup', userId: 'u-cash', tenantId: A })).status).toBe(403);
    expect((await h.request({
      method: 'PUT', path: '/v1/platform/setup/tax.default_bps', userId: 'u-cash', tenantId: A,
      idempotencyKey: 'cash-write', body: { value: 1 },
    })).status).toBe(403);
  });
});
