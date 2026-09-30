import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceEnrolments, readPackDevices, ENROL_REFUSALS, AUTH_REFUSALS, type PackDevice } from '../../edge/store-edge/src/device-enrolments';
import { enrolmentCodeHash, mintEnrolmentCode, normalizeEnrolmentCode, deviceTokenHash } from '../../packages/platform-admin/src/device-enrolment';
import { readLog } from '../../edge/store-edge/src/file-log';

/**
 * **The store box enrols a handheld once, with head office's one-time code, and holds only hashes (SP-3a · ADR-0019 ·
 * hard rules #4/#6).**
 *
 * The register is the whole of the device socket's trust: a code is one-time, a token is never stored, a block at head
 * office (the pack) refuses the device at its next request, a revocation is never forgotten across a restart, and a
 * brute force is bounded. Everything below is proven against the real fsync'd log in a temp dir.
 */

const NOW = '2026-09-30T10:00:00.000Z';
const LATER = '2026-09-30T12:00:00.000Z';
const CODE = 'ABCDE-FGHJK-LMNPQ-RSTUV';
const device = (over: Partial<PackDevice> = {}): PackDevice => ({
  deviceId: 'hh-01', kind: 'handheld', status: 'registered', label: 'Racking handheld 1',
  enrolment: { codeHash: enrolmentCodeHash(CODE), expiresAt: '2026-10-01T10:00:00.000Z' }, ...over,
});

describe('the enrolment code helper (shared by head office and the box)', () => {
  it('mints a 20-letter code in 4 groups from an alphabet a person can read back, and hashes it in its normalized form', () => {
    const code = mintEnrolmentCode();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
    expect(normalizeEnrolmentCode(' abcde-fghjk lmnpq_rstuv ')).toBe('ABCDEFGHJKLMNPQRSTUV');
    expect(enrolmentCodeHash('abcde fghjk lmnpq rstuv')).toBe(enrolmentCodeHash(CODE));
    expect(enrolmentCodeHash(CODE)).toHaveLength(64);
    expect(mintEnrolmentCode()).not.toBe(mintEnrolmentCode());
  });

  it('reads the pack\'s devices register strictly — an entry it cannot read is left out, never repaired', () => {
    expect(readPackDevices([device(), { deviceId: 'x' }, 'nope', { deviceId: 'till-1', kind: 'pos_lane', status: 'registered', enrolment: { codeHash: 'h' } }]))
      .toEqual([device(), { deviceId: 'till-1', kind: 'pos_lane', status: 'registered' }]);
    expect(readPackDevices(undefined)).toEqual([]);
  });
});

describe('the box\'s enrolment register', () => {
  const dirs: string[] = [];
  const open = async (dir?: string) => {
    const d = dir ?? await mkdtemp(join(tmpdir(), 'sre-enrol-'));
    if (dir === undefined) dirs.push(d);
    return { dir: d, register: await DeviceEnrolments.open({ dataDir: d, capacityBytes: 10 * 1024 * 1024 }) };
  };
  afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

  it('enrols a registered handheld with the right code, mints a token it does not keep, and the token then authenticates', async () => {
    const { dir, register } = await open();
    const outcome = await register.enrol({ deviceId: 'hh-01', code: 'abcde fghjk lmnpq rstuv', devices: [device()], now: NOW });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.token).toMatch(/^[0-9a-f]{64}$/);
    // On the disk: the token's HASH and the code's hash — never the token, never the code.
    const records = (await readLog(join(dir, 'device-enrolments.log'))).map((r) => (r.ok ? r.record : ''));
    expect(records).toHaveLength(1);
    expect(records[0]).toContain(deviceTokenHash(outcome.token));
    expect(records[0]).not.toContain(outcome.token);
    expect(records[0]).not.toContain(normalizeEnrolmentCode(CODE));
    expect(register.authenticate(`hh-01.${outcome.token}`, [device()])).toEqual({ ok: true, deviceId: 'hh-01', kind: 'handheld' });
    expect(register.enrolled()).toEqual([{ deviceId: 'hh-01', enrolledAt: NOW, revokedAt: null }]);
    await register.close();
  });

  it('refuses, each with its reason: no register, unknown device, a till, a blocked device, no code, an expired code, a wrong code, and a used code', async () => {
    const { register } = await open();
    const refusal = async (devices: PackDevice[] | undefined, code = CODE, deviceId = 'hh-01', now = NOW) => {
      const o = await register.enrol({ deviceId, code, devices, now });
      return o.ok ? 'OK' : o.refusal;
    };
    expect(await refusal(undefined)).toBe('no_devices_register');
    expect(await refusal([device()], CODE, 'hh-99')).toBe('device_unknown');
    expect(await refusal([device({ kind: 'pos_lane' })])).toBe('device_not_a_handheld');
    expect(await refusal([device({ status: 'blocked' })])).toBe('device_not_active');
    expect(await refusal([{ deviceId: 'hh-01', kind: 'handheld', status: 'registered' }])).toBe('no_code_issued');
    expect(await refusal([device()], CODE, 'hh-01', '2026-10-02T00:00:00.000Z')).toBe('code_expired');
    expect(await refusal([device()], 'ABCDE-FGHJK-LMNPQ-RSTUW')).toBe('code_wrong');
    expect(await refusal([device()], '')).toBe('code_wrong');
    expect(await refusal([device()])).toBe('OK');
    // The same code again — even for a second enrolment of the same device — is spent.
    expect(await refusal([device()])).toBe('code_used');
    for (const r of ['no_devices_register', 'device_unknown', 'device_not_a_handheld', 'device_not_active', 'no_code_issued', 'code_expired', 'code_wrong', 'code_used']) expect(ENROL_REFUSALS).toContain(r);
    await register.close();
  });

  it('bounds a brute force: five wrong codes for one device in fifteen minutes and the sixth try waits — a right code later still works', async () => {
    const { register } = await open();
    for (let i = 0; i < 5; i += 1) {
      expect((await register.enrol({ deviceId: 'hh-01', code: `WRONG-${i}`, devices: [device()], now: NOW })).ok).toBe(false);
    }
    const sixth = await register.enrol({ deviceId: 'hh-01', code: CODE, devices: [device()], now: NOW });
    expect(sixth).toMatchObject({ ok: false, refusal: 'too_many_attempts' });
    // Fifteen minutes on, the right code enrols.
    expect((await register.enrol({ deviceId: 'hh-01', code: CODE, devices: [device()], now: LATER })).ok).toBe(true);
    await register.close();
  });

  it('authenticates only a live credential of a device the pack still lists as registered — a block at head office refuses at the next request', async () => {
    const { register } = await open();
    const o = await register.enrol({ deviceId: 'hh-01', code: CODE, devices: [device()], now: NOW });
    if (!o.ok) throw new Error('enrol failed');
    const cred = `hh-01.${o.token}`;
    const refusal = (c: string | undefined, devices: PackDevice[] | undefined = [device()]) => { const a = register.authenticate(c, devices); return a.ok ? 'OK' : a.refusal; };
    expect(refusal(cred)).toBe('OK');
    expect(refusal(undefined)).toBe('no_credential');
    expect(refusal('')).toBe('no_credential');
    expect(refusal('hh-01')).toBe('credential_malformed');
    expect(refusal(`hh-02.${o.token}`)).toBe('not_enrolled');
    expect(refusal(`hh-01.${'0'.repeat(64)}`)).toBe('token_wrong');
    expect(register.authenticate(cred, undefined)).toMatchObject({ ok: false, refusal: 'no_devices_register' });
    expect(refusal(cred, [])).toBe('device_unknown');
    expect(refusal(cred, [device({ status: 'blocked' })])).toBe('device_not_active');
    expect(refusal(cred, [device({ status: 'retired' })])).toBe('device_not_active');
    // A revocation on the box itself.
    expect(await register.revoke('hh-01', 'handheld reported lost', LATER)).toBe(true);
    expect(refusal(cred)).toBe('revoked');
    expect(await register.revoke('hh-99', 'nobody', LATER)).toBe(false);
    for (const r of ['no_credential', 'credential_malformed', 'not_enrolled', 'token_wrong', 'revoked', 'no_devices_register', 'device_unknown', 'device_not_active']) expect(AUTH_REFUSALS).toContain(r);
    await register.close();
  });

  it('survives a restart: the enrolment, the spent code and the revocation are all folded back from the log', async () => {
    const first = await open();
    const o = await first.register.enrol({ deviceId: 'hh-01', code: CODE, devices: [device()], now: NOW });
    if (!o.ok) throw new Error('enrol failed');
    const second = device({ deviceId: 'hh-02', enrolment: { codeHash: enrolmentCodeHash('ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ'), expiresAt: '2026-10-01T10:00:00.000Z' } });
    const o2 = await first.register.enrol({ deviceId: 'hh-02', code: 'ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ', devices: [device(), second], now: NOW });
    if (!o2.ok) throw new Error('enrol 2 failed');
    await first.register.revoke('hh-02', 'lost', LATER);
    await first.register.close();

    const { register } = await open(first.dir);
    expect(register.unreadableRecords).toBe(0);
    expect(register.authenticate(`hh-01.${o.token}`, [device(), second])).toMatchObject({ ok: true, deviceId: 'hh-01' });
    expect(register.authenticate(`hh-02.${o2.token}`, [device(), second])).toMatchObject({ ok: false, refusal: 'revoked' });
    // The code is still spent after the restart — a replay enrols nothing.
    expect(await register.enrol({ deviceId: 'hh-01', code: CODE, devices: [device()], now: LATER })).toMatchObject({ ok: false, refusal: 'code_used' });
    expect(register.enrolled().map((e) => [e.deviceId, e.revokedAt !== null])).toEqual([['hh-01', false], ['hh-02', true]]);
    await register.close();
  });
});
