// The store box's register of ENROLLED handhelds (SP-3a · ADR-0019 · M33 · hard rules #4/#6).
//
// A handheld on the shop wifi is a device on the shop LAN — and so is a guest's phone (ADR-0004). The device socket
// therefore serves nothing to a device that has not proven, once, that head office registered it: head office issues
// a one-time enrolment code for the handheld (`POST /v1/platform/devices/:id/enrolment`) and the pack carries only the
// code's HASH with its expiry; the person setting the handheld up types the code into the box's enrolment page; this
// register compares hashes and mints the device its own session token — 32 random bytes the device keeps in an
// HttpOnly cookie and this register keeps only as a hash (hard rule #4: no shared login, no secret at rest here).
//
//   • The code is one-time: a hash that has enrolled once is refused after (a replayed code enrols nothing).
//   • Revocation is head office's: a device the pack now says is blocked or retired fails every request, and a device
//     the pack no longer lists is refused — the box never widens the fleet on its own.
//   • The register is an append-only, fsync'd log (`device-enrolments.log`), folded latest-per-device at start, so an
//     enrolled handheld is still enrolled after the box restarts and a revocation is never forgotten (hard rule #6).
//   • Brute force is bounded: five wrong codes for one device in fifteen minutes and the device waits.

import type { OpenFileLog } from './file-log';
import { openFileLog, readLog } from './file-log';
import {
  enrolmentCodeMatches, deviceTokenHash, mintDeviceToken, normalizeEnrolmentCode,
} from '../../../packages/platform-admin/src/device-enrolment';

/** A device as the pack's `devices` register describes it (the cloud fleet register, delivered in the signed pack). */
export interface PackDevice {
  readonly deviceId: string;
  readonly kind: string;
  readonly status: string;
  readonly label?: string;
  readonly branchId?: string;
  readonly enrolment?: { readonly codeHash: string; readonly expiresAt: string };
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Read the pack's `devices` register strictly: an entry this box cannot read is left out, never repaired. */
export function readPackDevices(raw: unknown): readonly PackDevice[] {
  if (!Array.isArray(raw)) return [];
  const out: PackDevice[] = [];
  for (const d of raw as unknown[]) {
    if (!isObj(d) || !isStr(d['deviceId']) || !isStr(d['kind']) || !isStr(d['status'])) continue;
    const e = d['enrolment'];
    out.push({
      deviceId: d['deviceId'], kind: d['kind'], status: d['status'],
      ...(isStr(d['label']) ? { label: d['label'] } : {}),
      ...(isStr(d['branchId']) ? { branchId: d['branchId'] } : {}),
      ...(isObj(e) && isStr(e['codeHash']) && isStr(e['expiresAt']) ? { enrolment: { codeHash: e['codeHash'], expiresAt: e['expiresAt'] } } : {}),
    });
  }
  return out;
}

/** The kinds a person carries onto the floor — the only kinds this register enrols (mirrors the cloud's ENROLLABLE_KINDS). */
export const ENROLLABLE_DEVICE_KINDS: readonly string[] = ['handheld', 'mobile'];

export const ENROL_REFUSALS = Object.freeze([
  'no_devices_register', 'device_unknown', 'device_not_a_handheld', 'device_not_active', 'no_code_issued',
  'code_expired', 'code_wrong', 'code_used', 'too_many_attempts',
] as const);
export type EnrolRefusal = (typeof ENROL_REFUSALS)[number];

export type EnrolOutcome =
  | { readonly ok: true; readonly deviceId: string; readonly token: string }
  | { readonly ok: false; readonly refusal: EnrolRefusal; readonly why: string };

export const AUTH_REFUSALS = Object.freeze([
  'no_credential', 'credential_malformed', 'not_enrolled', 'token_wrong', 'revoked', 'no_devices_register',
  'device_unknown', 'device_not_active',
] as const);
export type AuthRefusal = (typeof AUTH_REFUSALS)[number];

export type AuthOutcome =
  | { readonly ok: true; readonly deviceId: string; readonly kind: string }
  | { readonly ok: false; readonly refusal: AuthRefusal; readonly why: string };

/** One append-only line of the register. */
interface EnrolmentRecord {
  readonly kind: 'enrolled' | 'revoked';
  readonly deviceId: string;
  readonly at: string;
  readonly tokenHash?: string;
  readonly codeHash?: string;
  readonly reason?: string;
}

interface Enrolled {
  readonly deviceId: string;
  readonly tokenHash: string;
  readonly enrolledAt: string;
  readonly revokedAt: string | null;
  readonly revokedReason: string | null;
}

const MAX_FAILED = 5;
const FAILED_WINDOW_MS = 15 * 60_000;

export class DeviceEnrolments {
  private readonly byDevice = new Map<string, Enrolled>();
  private readonly usedCodeHashes = new Set<string>();
  private readonly failures = new Map<string, number[]>();
  /** Records on the disk that could not be read whole — surfaced, never repaired (hard rule #6). */
  readonly unreadableRecords: number;

  private constructor(private readonly log: OpenFileLog, restored: readonly EnrolmentRecord[], unreadable: number) {
    this.unreadableRecords = unreadable;
    for (const r of restored) this.fold(r);
  }

  /** Open (or create) the register on the box's disk and fold what is already there. */
  static async open(input: { readonly dataDir: string; readonly capacityBytes: number; readonly fileName?: string }): Promise<DeviceEnrolments> {
    const fileName = input.fileName ?? 'device-enrolments.log';
    const log = await openFileLog({ dataDir: input.dataDir, capacityBytes: input.capacityBytes, fileName });
    const verdicts = await readLog(log.path);
    const restored: EnrolmentRecord[] = [];
    let unreadable = 0;
    for (const v of verdicts) {
      if (!v.ok) { unreadable += 1; continue; }
      try {
        const parsed = JSON.parse(v.record) as unknown;
        if (isObj(parsed) && (parsed['kind'] === 'enrolled' || parsed['kind'] === 'revoked') && isStr(parsed['deviceId']) && isStr(parsed['at'])) {
          restored.push(parsed as unknown as EnrolmentRecord);
        } else unreadable += 1;
      } catch { unreadable += 1; }
    }
    return new DeviceEnrolments(log, restored, unreadable);
  }

  private fold(r: EnrolmentRecord): void {
    if (r.kind === 'enrolled' && r.tokenHash !== undefined) {
      this.byDevice.set(r.deviceId, { deviceId: r.deviceId, tokenHash: r.tokenHash, enrolledAt: r.at, revokedAt: null, revokedReason: null });
      if (r.codeHash !== undefined) this.usedCodeHashes.add(r.codeHash);
    } else if (r.kind === 'revoked') {
      const cur = this.byDevice.get(r.deviceId);
      if (cur !== undefined) this.byDevice.set(r.deviceId, { ...cur, revokedAt: r.at, revokedReason: r.reason ?? null });
    }
  }

  private async record(r: EnrolmentRecord): Promise<void> {
    await this.log.append(JSON.stringify(r));
    this.fold(r);
  }

  /** The devices this box has enrolled, with whether each is still live — for the boot log and the tests. Never a token. */
  enrolled(): readonly { deviceId: string; enrolledAt: string; revokedAt: string | null }[] {
    return [...this.byDevice.values()].map((e) => ({ deviceId: e.deviceId, enrolledAt: e.enrolledAt, revokedAt: e.revokedAt }));
  }

  private tooManyAttempts(deviceId: string, nowMs: number): boolean {
    const recent = (this.failures.get(deviceId) ?? []).filter((t) => nowMs - t < FAILED_WINDOW_MS);
    this.failures.set(deviceId, recent);
    return recent.length >= MAX_FAILED;
  }

  private noteFailure(deviceId: string, nowMs: number): void {
    this.failures.set(deviceId, [...(this.failures.get(deviceId) ?? []), nowMs]);
  }

  /**
   * Enrol a handheld with the one-time code head office issued for it. Every refusal names its reason; nothing about
   * the code or any token is ever returned except the fresh token on success (once — it is not kept here).
   */
  async enrol(input: { readonly deviceId: string; readonly code: string; readonly devices: readonly PackDevice[] | undefined; readonly now: string }): Promise<EnrolOutcome> {
    const deviceId = input.deviceId.trim();
    const nowMs = Date.parse(input.now);
    if (input.devices === undefined) {
      return { ok: false, refusal: 'no_devices_register', why: 'this store computer has not been told which handhelds belong to the shop, so it can enrol none' };
    }
    if (this.tooManyAttempts(deviceId, nowMs)) {
      return { ok: false, refusal: 'too_many_attempts', why: `too many wrong codes for ${deviceId} — wait fifteen minutes` };
    }
    const device = input.devices.find((d) => d.deviceId === deviceId);
    if (device === undefined) return { ok: false, refusal: 'device_unknown', why: `${deviceId} is not a device head office registered for this shop` };
    if (!ENROLLABLE_DEVICE_KINDS.includes(device.kind)) return { ok: false, refusal: 'device_not_a_handheld', why: `${deviceId} is a ${device.kind}, not a handheld` };
    if (device.status !== 'registered') return { ok: false, refusal: 'device_not_active', why: `${deviceId} is ${device.status} at head office` };
    if (device.enrolment === undefined) return { ok: false, refusal: 'no_code_issued', why: `head office has not issued an enrolment code for ${deviceId}` };
    if (Date.parse(device.enrolment.expiresAt) <= nowMs) return { ok: false, refusal: 'code_expired', why: `the enrolment code for ${deviceId} expired — ask head office for a new one` };
    if (this.usedCodeHashes.has(device.enrolment.codeHash)) return { ok: false, refusal: 'code_used', why: `that enrolment code has already been used — ask head office for a new one` };
    if (normalizeEnrolmentCode(input.code) === '' || !enrolmentCodeMatches(input.code, device.enrolment.codeHash)) {
      this.noteFailure(deviceId, nowMs);
      return { ok: false, refusal: 'code_wrong', why: 'that is not the enrolment code head office issued for this device' };
    }
    const token = mintDeviceToken();
    await this.record({ kind: 'enrolled', deviceId, at: input.now, tokenHash: deviceTokenHash(token), codeHash: device.enrolment.codeHash });
    this.failures.delete(deviceId);
    return { ok: true, deviceId, token };
  }

  /** Withdraw a device's credential on this box (a lost handheld). Head office's block still applies on top. */
  async revoke(deviceId: string, reason: string, now: string): Promise<boolean> {
    if (!this.byDevice.has(deviceId)) return false;
    await this.record({ kind: 'revoked', deviceId, at: now, reason });
    return true;
  }

  /**
   * Is this credential (`<deviceId>.<token>`) a live enrolment of a device head office still lists as active? Checked on
   * EVERY request: the pack is the fleet's truth, so a block at head office takes effect at the next request.
   */
  authenticate(credential: string | undefined, devices: readonly PackDevice[] | undefined): AuthOutcome {
    if (credential === undefined || credential === '') return { ok: false, refusal: 'no_credential', why: 'this handheld has not been enrolled on this store computer' };
    const dot = credential.lastIndexOf('.');
    if (dot <= 0 || dot === credential.length - 1) return { ok: false, refusal: 'credential_malformed', why: 'the device credential could not be read' };
    const deviceId = credential.slice(0, dot);
    const token = credential.slice(dot + 1);
    const enrolled = this.byDevice.get(deviceId);
    if (enrolled === undefined) return { ok: false, refusal: 'not_enrolled', why: `${deviceId} has not been enrolled on this store computer` };
    if (deviceTokenHash(token) !== enrolled.tokenHash) return { ok: false, refusal: 'token_wrong', why: 'the device credential does not match this store computer\'s record — enrol the handheld again' };
    if (enrolled.revokedAt !== null) return { ok: false, refusal: 'revoked', why: `${deviceId}'s enrolment was withdrawn${enrolled.revokedReason ? ` (${enrolled.revokedReason})` : ''}` };
    if (devices === undefined) return { ok: false, refusal: 'no_devices_register', why: 'this store computer has not been told which handhelds belong to the shop' };
    const device = devices.find((d) => d.deviceId === deviceId);
    if (device === undefined) return { ok: false, refusal: 'device_unknown', why: `${deviceId} is no longer a device head office lists for this shop` };
    if (device.status !== 'registered') return { ok: false, refusal: 'device_not_active', why: `${deviceId} is ${device.status} at head office` };
    return { ok: true, deviceId, kind: device.kind };
  }

  close(): Promise<void> {
    return this.log.close();
  }
}
