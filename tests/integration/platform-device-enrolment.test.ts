import { describe, it, expect } from 'vitest';
import { apiHarness } from '../support/api-harness';
import { enrolmentCodeHash } from '../../packages/platform-admin/src/device-enrolment';

/**
 * **Head office issues a one-time enrolment code for a registered handheld, and keeps only its hash (SP-3a · ADR-0019 ·
 * M33 · hard rule #4, API-10).**
 *
 * The code is the start of a handheld's trust on the store box's device socket. It is returned once, to the admin who
 * holds `platform.device.manage`; the fleet register carries its hash and expiry (the pack carries the same); a
 * re-issue supersedes; a till, a blocked device or an unknown device gets none; and a caller without the permission is
 * refused. Synthetic data (hard rule #7).
 */

const TENANT = 't-sre';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const register = (h: ReturnType<typeof apiHarness>, id: string, kind: string, key: string) =>
  h.request({ method: 'POST', path: `/v1/platform/devices/${id}/register`, userId: 'u-owner', tenantId: TENANT, idempotencyKey: key, body: { branchId: 'b-main', kind, label: `Device ${id}` } });
const issue = (h: ReturnType<typeof apiHarness>, id: string, key: string, body: Record<string, unknown> = {}, user = 'u-owner') =>
  h.request({ method: 'POST', path: `/v1/platform/devices/${id}/enrolment`, userId: user, tenantId: TENANT, idempotencyKey: key, body });

interface Issued { deviceId: string; code: string; expiresAt: string; issuedAt: string }
interface Fleet { devices: { deviceId: string; enrolment?: { codeHash: string; expiresAt: string; issuedAt: string } }[] }

describe('enrolment codes for handhelds (SP-3a)', () => {
  it('issues a code once, keeps only its hash on the fleet register, and a re-issue supersedes', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    await register(h, 'hh-01', 'handheld', 'r-1');

    const res = await issue(h, 'hh-01', 'e-1');
    expect(res.status).toBe(201);
    const issued = res.body as Issued;
    expect(issued.deviceId).toBe('hh-01');
    expect(issued.code).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
    // A day by default.
    expect(Date.parse(issued.expiresAt) - Date.parse(issued.issuedAt)).toBe(24 * 60 * 60_000);

    const fleet = (await h.request({ method: 'GET', path: '/v1/platform/devices', userId: 'u-owner', tenantId: TENANT })).body as Fleet;
    const device = fleet.devices.find((d) => d.deviceId === 'hh-01')!;
    expect(device.enrolment).toEqual({ codeHash: enrolmentCodeHash(issued.code), expiresAt: issued.expiresAt, issuedAt: issued.issuedAt });
    // The code itself is nowhere on the register.
    expect(JSON.stringify(fleet)).not.toContain(issued.code);

    // Re-issue (a lost code): a new code, the old hash gone — the store box will only accept the new one.
    const again = (await issue(h, 'hh-01', 'e-2', { validForMinutes: 60 })).body as Issued;
    expect(again.code).not.toBe(issued.code);
    expect(Date.parse(again.expiresAt) - Date.parse(again.issuedAt)).toBe(60 * 60_000);
    const after = (await h.request({ method: 'GET', path: '/v1/platform/devices', userId: 'u-owner', tenantId: TENANT })).body as Fleet;
    expect(after.devices.find((d) => d.deviceId === 'hh-01')?.enrolment?.codeHash).toBe(enrolmentCodeHash(again.code));
  });

  it('refuses a device nobody registered, a till, a blocked handheld, a bad validity, and a caller without the permission', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    await h.provisionRole(TENANT, 'u-cust', 'customer'); // no platform authority at all
    await register(h, 'till-1', 'pos_lane', 'r-t');
    await register(h, 'hh-02', 'handheld', 'r-2');

    const unknown = await issue(h, 'hh-99', 'e-u');
    expect(unknown.status).toBe(404);
    expect(codeOf(unknown)).toBe('device_not_registered');

    const till = await issue(h, 'till-1', 'e-t');
    expect(till.status).toBe(422);
    expect(codeOf(till)).toBe('device_kind_cannot_enrol');

    await h.request({ method: 'POST', path: '/v1/platform/devices/hh-02/status', userId: 'u-owner', tenantId: TENANT, idempotencyKey: 'b-2', body: { status: 'blocked', reason: 'lost' } });
    const blocked = await issue(h, 'hh-02', 'e-b');
    expect(blocked.status).toBe(409);
    expect(codeOf(blocked)).toBe('device_not_active');

    await register(h, 'hh-03', 'mobile', 'r-3');
    expect((await issue(h, 'hh-03', 'e-bad', { validForMinutes: 1 })).status).toBe(400);
    expect((await issue(h, 'hh-03', 'e-bad2', { validForMinutes: 99_999 })).status).toBe(400);
    expect((await issue(h, 'hh-03', 'e-cust', {}, 'u-cust')).status).toBe(403);
    // A mobile may enrol (the picker's and driver's phones).
    expect((await issue(h, 'hh-03', 'e-ok')).status).toBe(201);
  });
});
