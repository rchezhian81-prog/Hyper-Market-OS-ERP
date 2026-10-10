// WHO IS AT THE TILL — verified by this store computer, offline (ADR-0020 · Wave 2b · audit PF-02 · M02-FR-01 · §28 ·
// hard rules #1, #4, #6).
//
// Before this, the till wrote whatever staff code was typed as the cashier on every sale, and this box committed it.
// Now a person signs in at the till with their staff ID and their own six-digit till PIN; THIS register decides:
//
//   • the person must be known to the store pack and hold till authority (`pos.sale.sync`) in its role register — a
//     pack with no role register signs nobody in (fail closed);
//   • a credential must have been issued to them on this box and not revoked; the PIN must match its verifier
//     (`packages/identity/src/till-pin.ts`, constant time). A wrong ID and a wrong PIN get the SAME answer;
//   • five wrong PINs for one staff ID in fifteen minutes lock that ID for fifteen minutes; twenty refusals on one lane
//     lock that lane's sign-in for fifteen minutes;
//   • success opens a SHIFT SESSION bound to the lane: 32 random bytes the till keeps for its tab, of which this box
//     keeps only the hash, ending after twelve hours or at sign-out.
//
// Every money write the till makes is then checked here (`check`): a live session, on this lane, for a person who STILL
// holds till authority in the current pack — a leaver or a removed role ends the session at the next write.
//
// Every sign-in, refusal, lock and sign-out is appended to an fsync'd log (`till-operators.log`) and folded at start,
// so a restart signs nobody out and every attempt can be read later. Neither a PIN nor a token is ever written to it.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { OpenFileLog } from './file-log';
import { openFileLog, readLog } from './file-log';
import { isTillPin, tillPinMatches, type TillCredential } from '../../../packages/identity/src/till-pin';

/** The permission that makes a person a till operator — the same one head office re-checks on every synced sale. */
export const TILL_AUTHORITY = 'pos.sale.sync';
export const SESSION_HOURS = 12;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_WRONG_PER_PERSON = 5;
const MAX_REFUSED_PER_LANE = 20;
const HEADER = 'x-sre-operator';
export const OPERATOR_HEADER = HEADER;

/** How the session was opened: the person's own PIN at this till, or the hosted copy's verified sign-in (ADR-0020 §6). */
export type SignInVia = 'pin' | 'verified_sign_in';

export type SignInRefusal = 'wrong_staff_id_or_pin' | 'locked' | 'no_till_authority' | 'no_approval_authority' | 'no_handheld_authority' | 'no_people_register' | 'lane_locked' | 'not_readable' | 'no_lane';

/**
 * The phones (DF-3-c · OB-30 "A"): a person signs in on the warehouse, picker or driver phone with the SAME personal PIN as
 * the till. Such a session belongs to the phone, not to a till: its "lane" is the device, under this prefix, so a phone's
 * session can never take money at a till and a till's session can never post a phone's work.
 */
export const DEVICE_LANE_PREFIX = 'device:';
export const deviceLaneOf = (deviceId: string): string => `${DEVICE_LANE_PREFIX}${deviceId}`;

/** The words a cashier reads, per refusal — the screen shows these as they are. */
const WORDS: Readonly<Record<SignInRefusal, string>> = {
  wrong_staff_id_or_pin: 'That staff ID and PIN do not match. Try again, or ask the manager to reissue your till PIN.',
  locked: 'Too many wrong PINs for this staff ID. Wait fifteen minutes, or ask the manager.',
  no_till_authority: 'This person is not allowed to work a till in this shop. Ask the manager.',
  no_approval_authority: 'This person is not allowed to approve refunds in this shop. Ask a manager who is.',
  no_handheld_authority: 'This person is not allowed to do this job on this phone. Ask the manager.',
  no_people_register: 'This store computer has not been told who works here, so nobody can sign in at the till. Ask the manager.',
  lane_locked: 'Too many failed sign-ins on this till. Wait fifteen minutes, or ask the manager.',
  not_readable: 'Scan your staff badge or key your staff ID, then key your six-digit till PIN.',
  no_lane: 'This store computer has not been told which till it is, so nobody can sign in here. Tell the manager.',
};

export type SignInOutcome =
  | { readonly signedIn: true; readonly token: string; readonly userId: string; readonly displayName: string; readonly expiresAt: string; readonly via: SignInVia }
  | { readonly signedIn: false; readonly refusedBecause: SignInRefusal; readonly laneMessage: string };

export type CheckRefusal = 'operator_not_signed_in' | 'operator_session_ended' | 'operator_on_another_lane' | 'operator_lost_till_authority' | 'operator_lost_handheld_authority';
const CHECK_WORDS: Readonly<Record<CheckRefusal, string>> = {
  operator_not_signed_in: 'Nobody is signed in at this till. Sign in with your staff ID and till PIN before taking payment.',
  operator_session_ended: 'Your till sign-in has ended. Sign in again with your staff ID and till PIN.',
  operator_on_another_lane: 'This sign-in belongs to another till. Sign in again on this one.',
  operator_lost_till_authority: 'You are no longer allowed to work a till in this shop. Ask the manager. Nothing was saved.',
  operator_lost_handheld_authority: 'You are no longer allowed to do this job on this phone. Ask the manager. Nothing was saved.',
};

export type CheckOutcome =
  | { readonly ok: true; readonly userId: string; readonly displayName: string; readonly via: SignInVia; readonly expiresAt: string; readonly authority: string }
  | { readonly ok: false; readonly refusedBecause: CheckRefusal; readonly laneMessage: string };

/** What the register needs to know about the shop, read from the CURRENT pack at each decision. */
export interface TillOperatorPack {
  /** The people the pack names, or `null` when it carries no people register. */
  people(): readonly { readonly userId: string; readonly displayName: string }[] | null;
  /** The permissions the pack's role register gives this person, or `null` when it carries no role register. */
  permissionsOf(userId: string): readonly string[] | null;
}

/** `authority` is what the session was opened for: till authority for a till, the phone's job for a phone (DF-3-c). */
interface Session { readonly tokenHash: string; readonly userId: string; readonly laneId: string; readonly via: SignInVia; readonly at: string; readonly expiresAt: string; readonly authority: string }
/** Every session this box ever opened, with when it ended — so work done on a phone is judged against who was signed in then. */
interface SessionSpan { readonly userId: string; readonly laneId: string; readonly at: string; readonly expiresAt: string; endedAt: string | null }

type LogRecord =
  // `authority` is absent on records written before the phones signed in (DF-3-c): those were till sessions.
  | { readonly kind: 'signed_in'; readonly at: string; readonly userId: string; readonly laneId: string; readonly via: SignInVia; readonly tokenHash: string; readonly expiresAt: string; readonly authority?: string }
  // `why`: 'replaced' when the next person signed in on the same phone (DF-3-c); absent for a sign-out.
  | { readonly kind: 'signed_out'; readonly at: string; readonly tokenHash: string; readonly userId: string; readonly why?: 'replaced' }
  | { readonly kind: 'refused'; readonly at: string; readonly staffId: string; readonly laneId: string; readonly reason: SignInRefusal };

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Read the box's till-credentials file: `{ version: 1, credentials: [...] }`, appended in issue order. The LATEST entry
 * per person wins (a reissue replaces, a revocation ends). An entry this box cannot read is left out, never repaired.
 */
export function readTillCredentials(raw: unknown): ReadonlyMap<string, TillCredential> {
  const out = new Map<string, TillCredential>();
  const list = isObj(raw) && Array.isArray(raw['credentials']) ? (raw['credentials'] as unknown[]) : [];
  for (const c of list) {
    if (!isObj(c) || !isStr(c['userId']) || !isStr(c['issuedAt']) || !isStr(c['issuedBy'])) continue;
    if (c['revoked'] === true) { out.set(c['userId'], { userId: c['userId'], salt: '', verifier: '', issuedAt: c['issuedAt'], issuedBy: c['issuedBy'], revoked: true }); continue; }
    if (!isStr(c['salt']) || !isStr(c['verifier'])) continue;
    out.set(c['userId'], { userId: c['userId'], salt: c['salt'], verifier: c['verifier'], issuedAt: c['issuedAt'], issuedBy: c['issuedBy'] });
  }
  return out;
}

/** Read the credentials file from disk; a missing or unreadable file is "no credentials" (nobody can sign in). */
export async function loadTillCredentials(path: string): Promise<ReadonlyMap<string, TillCredential>> {
  try { return readTillCredentials(JSON.parse(await readFile(path, 'utf8')) as unknown); } catch { return new Map(); }
}

export class TillOperators {
  private readonly sessions = new Map<string, Session>();
  private readonly spans = new Map<string, SessionSpan>();
  private readonly wrongByPerson = new Map<string, number[]>();
  private readonly refusedByLane = new Map<string, number[]>();
  /** Records on the disk that could not be read whole — surfaced, never repaired (hard rule #6). */
  readonly unreadableRecords: number;

  private constructor(
    private readonly log: OpenFileLog,
    private readonly deps: {
      readonly key: Buffer;
      readonly credentials: () => Promise<ReadonlyMap<string, TillCredential>>;
      readonly pack: TillOperatorPack;
      readonly now: () => string;
    },
    restored: readonly LogRecord[],
    unreadable: number,
  ) {
    this.unreadableRecords = unreadable;
    for (const r of restored) this.fold(r);
  }

  static async open(input: {
    readonly dataDir: string;
    readonly capacityBytes: number;
    readonly key: Buffer;
    readonly credentials: () => Promise<ReadonlyMap<string, TillCredential>>;
    readonly pack: TillOperatorPack;
    readonly now?: () => string;
    readonly fileName?: string;
  }): Promise<TillOperators> {
    const log = await openFileLog({ dataDir: input.dataDir, capacityBytes: input.capacityBytes, fileName: input.fileName ?? 'till-operators.log' });
    const restored: LogRecord[] = [];
    let unreadable = 0;
    for (const v of await readLog(log.path)) {
      if (!v.ok) { unreadable += 1; continue; }
      try {
        const r = JSON.parse(v.record) as unknown;
        if (isObj(r) && (r['kind'] === 'signed_in' || r['kind'] === 'signed_out' || r['kind'] === 'refused') && isStr(r['at'])) restored.push(r as unknown as LogRecord);
        else unreadable += 1;
      } catch { unreadable += 1; }
    }
    return new TillOperators(log, { key: input.key, credentials: input.credentials, pack: input.pack, now: input.now ?? (() => new Date().toISOString()) }, restored, unreadable);
  }

  private fold(r: LogRecord): void {
    if (r.kind === 'signed_in') {
      this.sessions.set(r.tokenHash, { tokenHash: r.tokenHash, userId: r.userId, laneId: r.laneId, via: r.via, at: r.at, expiresAt: r.expiresAt, authority: r.authority ?? TILL_AUTHORITY });
      this.spans.set(r.tokenHash, { userId: r.userId, laneId: r.laneId, at: r.at, expiresAt: r.expiresAt, endedAt: null });
    } else if (r.kind === 'signed_out') {
      this.sessions.delete(r.tokenHash);
      const span = this.spans.get(r.tokenHash);
      if (span !== undefined && span.endedAt === null) span.endedAt = r.at;
    }
  }

  private async record(r: LogRecord): Promise<void> {
    await this.log.append(JSON.stringify(r));
    this.fold(r);
  }

  private recent(map: Map<string, number[]>, key: string, nowMs: number): number[] {
    const kept = (map.get(key) ?? []).filter((t) => nowMs - t < WINDOW_MS);
    map.set(key, kept);
    return kept;
  }

  private async refuse(staffId: string, laneId: string, reason: SignInRefusal, nowMs: number, wrongPin = false): Promise<SignInOutcome> {
    const at = new Date(nowMs).toISOString();
    if (wrongPin) this.wrongByPerson.set(staffId, [...this.recent(this.wrongByPerson, staffId, nowMs), nowMs]);
    this.refusedByLane.set(laneId, [...this.recent(this.refusedByLane, laneId, nowMs), nowMs]);
    await this.record({ kind: 'refused', at, staffId: staffId.slice(0, 64), laneId, reason });
    return { signedIn: false, refusedBecause: reason, laneMessage: WORDS[reason] };
  }

  private displayNameOf(userId: string): string {
    return this.deps.pack.people()?.find((p) => p.userId === userId)?.displayName ?? userId;
  }

  private holdsTillAuthority(userId: string, authority: string = TILL_AUTHORITY): boolean | null {
    const permissions = this.deps.pack.permissionsOf(userId);
    if (permissions === null) return null;
    return permissions.includes(authority);
  }

  private async open(userId: string, laneId: string, via: SignInVia, nowMs: number, authority: string = TILL_AUTHORITY): Promise<SignInOutcome> {
    const token = randomBytes(32).toString('base64url');
    const at = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + SESSION_HOURS * 3_600_000).toISOString();
    await this.record({ kind: 'signed_in', at, userId, laneId, via, tokenHash: sha256(token), expiresAt, ...(authority === TILL_AUTHORITY ? {} : { authority }) });
    return { signedIn: true, token, userId, displayName: this.displayNameOf(userId), expiresAt, via };
  }

  /**
   * Is this the person, by their staff ID and till PIN? The ONE place a PIN is checked — at sign-in and when a manager
   * approves at the till (ADR-0021) — so both doors share the same guess limits and the same log. `authority` is the
   * permission the person must hold in the pack for what they are about to do. The PIN is checked here and forgotten.
   */
  async verifyPerson(input: { readonly staffId: string; readonly pin: string; readonly laneId: string; readonly authority: string; readonly lacking?: SignInRefusal }): Promise<
    | { readonly ok: true; readonly userId: string; readonly displayName: string }
    | { readonly ok: false; readonly refusedBecause: SignInRefusal; readonly laneMessage: string }
  > {
    const nowMs = Date.parse(this.deps.now());
    const staffId = input.staffId.trim();
    const laneId = input.laneId;
    const no = (o: SignInOutcome) => (o.signedIn ? { ok: false as const, refusedBecause: 'not_readable' as const, laneMessage: WORDS.not_readable } : { ok: false as const, refusedBecause: o.refusedBecause, laneMessage: o.laneMessage });
    // A box that was never told which till it is signs nobody in: a session must belong to a lane (ADR-0020 §4).
    if (laneId.trim() === '') return { ok: false, refusedBecause: 'no_lane', laneMessage: WORDS.no_lane };
    if (this.recent(this.refusedByLane, laneId, nowMs).length >= MAX_REFUSED_PER_LANE) {
      return { ok: false, refusedBecause: 'lane_locked', laneMessage: WORDS.lane_locked };
    }
    if (staffId === '' || !isTillPin(input.pin)) return no(await this.refuse(staffId || '(none)', laneId, 'not_readable', nowMs));
    if (this.recent(this.wrongByPerson, staffId, nowMs).length >= MAX_WRONG_PER_PERSON) return no(await this.refuse(staffId, laneId, 'locked', nowMs));
    const people = this.deps.pack.people();
    if (people === null || this.deps.pack.permissionsOf(staffId) === null) return no(await this.refuse(staffId, laneId, 'no_people_register', nowMs));
    const credential = (await this.deps.credentials()).get(staffId);
    // Unknown person, no credential, revoked credential, wrong PIN — ONE answer, so nobody learns which staff IDs exist.
    const known = people.some((p) => p.userId === staffId);
    if (!known || credential === undefined || !tillPinMatches(input.pin, credential, this.deps.key)) {
      return no(await this.refuse(staffId, laneId, 'wrong_staff_id_or_pin', nowMs, true));
    }
    const permissions = this.deps.pack.permissionsOf(staffId) ?? [];
    if (!permissions.includes(input.authority)) {
      const reason: SignInRefusal = input.lacking ?? (input.authority === TILL_AUTHORITY ? 'no_till_authority' : 'no_approval_authority');
      return no(await this.refuse(staffId, laneId, reason, nowMs));
    }
    this.wrongByPerson.delete(staffId);
    return { ok: true, userId: staffId, displayName: this.displayNameOf(staffId) };
  }

  /** Sign a person in at a till with their staff ID and till PIN. The PIN is checked here and forgotten. */
  async signIn(input: { readonly staffId: string; readonly pin: string; readonly laneId: string }): Promise<SignInOutcome> {
    const verified = await this.verifyPerson({ ...input, authority: TILL_AUTHORITY });
    if (!verified.ok) return { signedIn: false, refusedBecause: verified.refusedBecause, laneMessage: verified.laneMessage };
    return this.open(verified.userId, input.laneId, 'pin', Date.parse(this.deps.now()));
  }

  /**
   * Open a session for a person the HOSTED copy's sign-in already verified (ADR-0020 §6). Only ever called when this box
   * runs under the pilot overlay's `EDGE_LANE_TRUST_FORWARDED_USER=1`; the till authority check still applies.
   */
  async signInVerified(input: { readonly userId: string; readonly laneId: string }): Promise<SignInOutcome> {
    const nowMs = Date.parse(this.deps.now());
    const userId = input.userId.trim();
    if (input.laneId.trim() === '') return { signedIn: false, refusedBecause: 'no_lane', laneMessage: WORDS.no_lane };
    if (userId === '') return this.refuse('(none)', input.laneId, 'not_readable', nowMs);
    const authority = this.holdsTillAuthority(userId);
    if (authority === null) return this.refuse(userId, input.laneId, 'no_people_register', nowMs);
    if (!authority) return this.refuse(userId, input.laneId, 'no_till_authority', nowMs);
    return this.open(userId, input.laneId, 'verified_sign_in', nowMs);
  }

  /**
   * Sign a person in on a PHONE (DF-3-c · OB-30 "A") with their staff ID and the same PIN as the till, for the phone's job
   * (`authority`: the permission head office re-checks on that job's records). The same guess limits and log as the till;
   * twenty refusals on one phone lock that phone's sign-in. ONE person per phone at a time: whoever was signed in on it is
   * signed out — said in the log — so the next person's work can never be recorded as theirs.
   */
  async signInOnDevice(input: { readonly staffId: string; readonly pin: string; readonly deviceId: string; readonly authority: string }): Promise<SignInOutcome> {
    const laneId = deviceLaneOf(input.deviceId);
    const verified = await this.verifyPerson({ staffId: input.staffId, pin: input.pin, laneId, authority: input.authority, lacking: 'no_handheld_authority' });
    if (!verified.ok) return { signedIn: false, refusedBecause: verified.refusedBecause, laneMessage: verified.laneMessage };
    const nowMs = Date.parse(this.deps.now());
    for (const s of [...this.sessions.values()].filter((x) => x.laneId === laneId)) {
      await this.record({ kind: 'signed_out', at: new Date(nowMs).toISOString(), tokenHash: s.tokenHash, userId: s.userId, why: 'replaced' });
    }
    return this.open(verified.userId, laneId, 'pin', nowMs, input.authority);
  }

  /**
   * Has this person held this lane (a phone) within `withinMs` of now — signed in now, or signed out / replaced / expired no
   * longer ago than that? A phone's queued work reaches the box after the fact, perhaps after the next person signed in, so
   * it is judged against the box's own log and the box's own clock — never the phone's, which in a shop with no internet
   * can be hours out. Who, where, when — never a token.
   */
  heldRecently(userId: string, laneId: string, withinMs: number): boolean {
    const nowMs = Date.parse(this.deps.now());
    for (const span of this.spans.values()) {
      if (span.userId !== userId || span.laneId !== laneId || Date.parse(span.at) > nowMs) continue;
      const end = Math.min(Date.parse(span.expiresAt), span.endedAt === null ? Number.POSITIVE_INFINITY : Date.parse(span.endedAt));
      if (end + withinMs >= nowMs) return true;
    }
    return false;
  }

  /** Is this token a live session on this lane, for a person who still holds what it was opened for? Checked on EVERY write. */
  check(token: string | undefined, laneId: string): CheckOutcome {
    const fail = (refusedBecause: CheckRefusal): CheckOutcome => ({ ok: false, refusedBecause, laneMessage: CHECK_WORDS[refusedBecause] });
    if (token === undefined || token === '') return fail('operator_not_signed_in');
    const hash = sha256(token);
    const session = [...this.sessions.values()].find((s) => s.tokenHash.length === hash.length && timingSafeEqual(Buffer.from(s.tokenHash), Buffer.from(hash)));
    if (session === undefined) return fail('operator_not_signed_in');
    if (Date.parse(session.expiresAt) <= Date.parse(this.deps.now())) return fail('operator_session_ended');
    if (session.laneId !== laneId) return fail('operator_on_another_lane');
    if (this.holdsTillAuthority(session.userId, session.authority) !== true) return fail(session.authority === TILL_AUTHORITY ? 'operator_lost_till_authority' : 'operator_lost_handheld_authority');
    return { ok: true, userId: session.userId, displayName: this.displayNameOf(session.userId), via: session.via, expiresAt: session.expiresAt, authority: session.authority };
  }

  /** End a session. Unknown tokens are simply not signed in. */
  async signOut(token: string | undefined): Promise<boolean> {
    if (token === undefined || token === '') return false;
    const session = this.sessions.get(sha256(token));
    if (session === undefined) return false;
    await this.record({ kind: 'signed_out', at: this.deps.now(), tokenHash: session.tokenHash, userId: session.userId });
    return true;
  }

  /** The live sessions, for the boot log and the tests — who and where, never a token or its hash. */
  live(): readonly { userId: string; laneId: string; via: SignInVia; expiresAt: string }[] {
    const nowMs = Date.parse(this.deps.now());
    return [...this.sessions.values()].filter((s) => Date.parse(s.expiresAt) > nowMs).map((s) => ({ userId: s.userId, laneId: s.laneId, via: s.via, expiresAt: s.expiresAt }));
  }
}
