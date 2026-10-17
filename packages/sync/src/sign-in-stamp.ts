// THE SIGN-IN A HANDHELD RECORD WAS MADE UNDER (OB-180 "A", owner 17 Oct 2026 · verifier r2final NEW-4 · OB-172 · hard
// rules #1, #4, #10).
//
// A phone records offline. Before the wifi comes back, somebody else may sign in on that same phone; the work the first
// person did then reaches the store computer under the second person's sign-in. Until OB-180 the box could only vouch for
// whoever held the phone NOW, so the first person's receipt travelled unsealed and head office flagged its checklist as
// not accepted. The owner's decision: the phone STAMPS each record with the sign-in it was made under, and the box seals
// it for the person whose sign-in made it — provided that sign-in was valid on that phone when the record was made.
//
// ── What a stamp is ────────────────────────────────────────────────────────
//
// When a person signs in on a phone, the box hands the served page that sign-in's REFERENCE (a public name for it) and
// a STAMP KEY that only that sign-in's page ever sees. Both are derived on the box from the session and the box's own
// secret, never written anywhere. Each record the phone makes is stamped, at the moment it is queued, with:
//
//   ref     — which sign-in it was made under
//   userId  — whose sign-in that was
//   madeAt  — when it was made, on the box's clock as the page last learnt it (the phone's own clock can be hours out)
//   mac     — HMAC-SHA256 under the stamp key over all of the above AND the whole record (type, key, payload, …)
//
// The box re-derives the key from its own log and checks the mac, that the sign-in was made on THIS phone, that it was
// that person's, and that `madeAt` falls inside that sign-in (from signing in to signing out / being replaced / expiry).
// A stamp that fails any of these is refused by name — never quietly sealed for somebody, never re-stamped (#10).
//
// A later sign-in by somebody else cannot make a record that seals as the first person: the first sign-in's key is not
// in the second person's page, and without it no mac can be made. A stamp copied onto another record, an altered record,
// a stamp replayed from another phone, or a stamp naming a person who never signed in there, all fail.
//
// Pure TypeScript (no `crypto.subtle`): the phones open the box over plain http on the shop wifi, where a browser offers
// no Web Crypto at all. The box checks with node's own HMAC; a test binds the two together.

import type { DomainEvent } from '../../contracts/src/event';

/** The stamp a handheld puts on each record it queues (OB-180). */
export interface SignInStamp {
  readonly v: 1;
  readonly ref: string;
  readonly userId: string;
  readonly madeAt: string;
  readonly mac: string;
}

/** What the box hands a signed-in phone's page so it can stamp its records (window.phoneSignIn). */
export interface PhoneSignIn {
  readonly ref: string;
  readonly userId: string;
  readonly signedInAt: string;
  readonly expiresAt: string;
  /** The stamp key, hex. Only this sign-in's page ever holds it. */
  readonly key: string;
  /** The box's clock when it served the page — so the phone can say "when" on the box's clock. */
  readonly boxNow: string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/**
 * Read a stamp strictly. `undefined` → the item carried none. A stamp that is there but not whole is a refusal: a forged
 * or damaged stamp must never be read as "no stamp" and fall back to a weaker path.
 */
export function readSignInStamp(v: unknown): { readonly ok: true; readonly stamp: SignInStamp | undefined } | { readonly ok: false; readonly reason: string } {
  if (v === undefined) return { ok: true, stamp: undefined };
  const bad = { ok: false as const, reason: 'the record\'s sign-in stamp could not be read' };
  if (!isObj(v) || v['v'] !== 1 || !isStr(v['ref']) || !isStr(v['userId']) || !isStr(v['madeAt']) || !isStr(v['mac'])) return bad;
  if (!ISO.test(v['madeAt']) || !Number.isFinite(Date.parse(v['madeAt']))) return bad;
  if (!/^[0-9a-f]{64}$/.test(v['mac']) || v['ref'].length > 128 || v['userId'].length > 128) return bad;
  return { ok: true, stamp: { v: 1, ref: v['ref'], userId: v['userId'], madeAt: v['madeAt'], mac: v['mac'] } };
}

/** JSON with every object's keys in order, so the phone and the box hash the same bytes for the same record. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonicalJson(x))).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

/**
 * The exact text a stamp's mac covers: the stamp's own fields and the WHOLE record as the box reads it (the seven fields
 * `readRelayItem` keeps), so neither can be changed or swapped without the key.
 */
export function stampMessage(stamp: Omit<SignInStamp, 'mac'>, event: DomainEvent): string {
  const record = {
    id: event.id, type: event.type, occurredAt: event.occurredAt, idempotencyKey: event.idempotencyKey,
    source: event.source, version: event.version, payload: event.payload,
  };
  return ['sre-handheld-stamp-v1', stamp.ref, stamp.userId, stamp.madeAt, canonicalJson(record)].join('\n');
}

// ── SHA-256 and HMAC, plain (FIPS 180-4, RFC 2104) ─────────────────────────

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256(data: Uint8Array): Uint8Array {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const bitLen = data.length * 8;
  const padded = new Uint8Array(((data.length + 9 + 63) >> 6) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
  view.setUint32(padded.length - 4, bitLen >>> 0);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const a = w[i - 15]!; const b = w[i - 2]!;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!, f = h[5]!, g = h[6]!, hh = h[7]!;
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0; h[1] = (h[1]! + b) >>> 0; h[2] = (h[2]! + c) >>> 0; h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0; h[5] = (h[5]! + f) >>> 0; h[6] = (h[6]! + g) >>> 0; h[7] = (h[7]! + hh) >>> 0;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i += 1) ov.setUint32(i * 4, h[i]!);
  return out;
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const toHex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
export function fromHex(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})+$/.test(hex)) throw new Error('not hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function hmacSha256Hex(key: Uint8Array, message: string): string {
  const block = 64;
  const k = key.length > block ? sha256(key) : key;
  const ipad = new Uint8Array(block); const opad = new Uint8Array(block);
  for (let i = 0; i < block; i += 1) { const kb = k[i] ?? 0; ipad[i] = kb ^ 0x36; opad[i] = kb ^ 0x5c; }
  const msg = utf8(message);
  const inner = new Uint8Array(block + msg.length); inner.set(ipad); inner.set(msg, block);
  const innerHash = sha256(inner);
  const outer = new Uint8Array(block + 32); outer.set(opad); outer.set(innerHash, block);
  return toHex(sha256(outer));
}

/** Read what the box injected as `window.phoneSignIn`; anything not whole is "no sign-in to stamp under". */
export function readPhoneSignIn(v: unknown): PhoneSignIn | undefined {
  if (!isObj(v)) return undefined;
  const { ref, userId, signedInAt, expiresAt, key, boxNow } = v;
  if (!isStr(ref) || !isStr(userId) || !isStr(signedInAt) || !isStr(expiresAt) || !isStr(key) || !isStr(boxNow)) return undefined;
  if (!/^[0-9a-f]{64}$/.test(key)) return undefined;
  return { ref, userId, signedInAt, expiresAt, key, boxNow };
}

// ── The phone's reading of the box's clock only moves forward (verifier hh NEW-1, L1, L2, L3) ──────────────────────
//
// The phone tells "when" on the box's clock: its own clock moved by how far it was from the box when the page was
// served. But a phone's clock is the holder's to change — in Android's settings, offline — so on its own it cannot be
// trusted to say a sign-in has not ended yet. So, for each sign-in, the phone keeps the LATEST box time it has ever seen
// ("the mark"), on the phone beside the queues (`PHONE_CLOCK_MARKS_KEY`), written on every strip tick and every stamp.
// If the clock ever reads earlier than that mark, or earlier than when the page was served, or it ran slower than the
// page's own stopwatch (`performance.now`, which changing the clock does not move), the sign-in is ENDED on this phone:
// nothing more is stamped and the screen locks. It stays ended (the mark says so), so putting the clock right again, or
// reopening the kept page, does not bring it back.
//
// What this cannot see: a clock set back while no page of that sign-in was open, to a time after the last moment the
// phone saw. Then the person gains at most the time from that moment to the sign-in's own end (never past it); the box
// still refuses a stamp that runs backwards against one it already took from that sign-in, and anything arriving more
// than twelve hours after the sign-in's end (OB-185, `verifyStamp`).
//
// When the phone hears the box's own clock (each reply to a hand-over carries it), that replaces the phone's estimate and
// its mark — so a phone clock that jumped forward is put right at the next hand-over, without a reload (L1).

/** Where the phone keeps each sign-in's mark (localStorage, beside the queues). The strip's own script reads the same. */
export const PHONE_CLOCK_MARKS_KEY = 'sre.phone-sign-in.marks';
/** How far the clock may step back and still be a clock's own small correction, not a hand on the settings. */
export const PHONE_CLOCK_TOLERANCE_MS = 2 * 60_000;
/** How long a sign-in's mark is kept after its end: twelve hours after it nothing it stamped is taken anyway (OB-185). */
const MARK_KEPT_AFTER_END_MS = 24 * 3_600_000;

/** Why a sign-in ended on the phone. */
export type PhoneEndedWhy = 'expired' | 'clock_set_back' | 'locked';

/** One sign-in's mark: `m` the latest box time seen; `o` the offset last heard from the box; `e` ended, and why; `x` its end. */
interface ClockMark { m?: number; o?: number; e?: PhoneEndedWhy; x?: number }

/** The phone's storage the marks live in (localStorage in a browser). Absent → kept in memory, for this page only. */
export interface MarkStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type SignInClockReading =
  | { readonly ended: false; readonly boxNowMs: number; readonly leftMs: number }
  | { readonly ended: true; readonly why: PhoneEndedWhy };

export interface SignInClock {
  /** The box's time now as the phone reckons it — never earlier than any it read before — or that the sign-in ended. */
  read(): SignInClockReading;
  /** The box said its time was `boxMs` when the phone's clock read `phoneMs`: from now on the phone reckons from that. */
  learn(boxMs: number, phoneMs: number): void;
  /** The screen locked: every later reading is ended. */
  forget(): void;
}

export interface PhoneClockOptions {
  /** Where the marks are kept (the phone's localStorage). Absent → in memory, for this page only. */
  readonly storage?: MarkStorage;
  /** The page's stopwatch (`performance.now`). Absent → the stopwatch check is not made. */
  readonly perfNow?: () => number;
}

function memoryMarks(): MarkStorage {
  const held = new Map<string, string>();
  return { getItem: (k) => held.get(k) ?? null, setItem: (k, v) => { held.set(k, v); } };
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const WHY: readonly PhoneEndedWhy[] = ['expired', 'clock_set_back', 'locked'];

/**
 * The phone's clock for one sign-in. `phoneAtServe` is the phone's clock when the box served the page (the page load, or
 * the service worker's `shellCachedAt`). The strip's own script (`signInLeftScript` in edge/store-edge/src/handheld-
 * sign-in.ts) reads and writes the same marks the same way; a test binds the two.
 */
export function signInClock(
  signIn: PhoneSignIn,
  phoneAtServe: string,
  phoneNow: () => string = () => new Date().toISOString(),
  options: PhoneClockOptions = {},
): SignInClock {
  const storage = options.storage ?? memoryMarks();
  // A copy in memory as well: a phone whose storage throws (private mode, full) still guards THIS page.
  const inMemory = memoryMarks();
  const served = Date.parse(signIn.boxNow);
  const expiry = Date.parse(signIn.expiresAt);
  const baseOffset = served - Date.parse(phoneAtServe);
  const perf = options.perfNow ?? ((): number => Number.NaN);
  const wall0 = Date.parse(phoneNow());
  const perf0 = perf();
  let locked = false;

  const readAll = (): Record<string, ClockMark> => {
    for (const s of [storage, inMemory]) {
      try {
        const raw = s.getItem(PHONE_CLOCK_MARKS_KEY);
        if (raw !== null) {
          const v = JSON.parse(raw) as unknown;
          if (isObj(v)) return v as Record<string, ClockMark>;
        }
      } catch { /* unreadable → the copy in memory, then nothing */ }
    }
    return {};
  };
  const markOf = (): ClockMark => {
    const m = readAll()[signIn.ref];
    return isObj(m) ? m : {};
  };
  const save = (mark: ClockMark, nowMs: number): void => {
    const all = readAll();
    all[signIn.ref] = mark;
    for (const [ref, m] of Object.entries(all)) {
      if (ref !== signIn.ref && (!isObj(m) || (num(m.x) && m.x + MARK_KEPT_AFTER_END_MS < nowMs))) delete all[ref];
    }
    const text = JSON.stringify(all);
    inMemory.setItem(PHONE_CLOCK_MARKS_KEY, text);
    try { storage.setItem(PHONE_CLOCK_MARKS_KEY, text); } catch { /* the copy in memory still guards this page */ }
  };

  return {
    read() {
      if (locked) return { ended: true, why: 'locked' };
      const mark = markOf();
      if (mark.e !== undefined) return { ended: true, why: WHY.includes(mark.e) ? mark.e : 'clock_set_back' };
      const wall = Date.parse(phoneNow());
      const est = wall + (num(mark.o) ? mark.o : num(baseOffset) ? baseOffset : 0);
      const floor = Math.max(num(mark.m) ? mark.m : -Infinity, num(served) ? served : -Infinity);
      const ran = perf() - perf0;
      // Earlier than the mark or the serving, or slower than the stopwatch: the clock was turned back. (A phone asleep only
      // makes the clock run AHEAD of the stopwatch, so an honest phone never trips this.)
      const setBack = !Number.isFinite(est) || est < floor - PHONE_CLOCK_TOLERANCE_MS || (num(ran) && wall - wall0 < ran - PHONE_CLOCK_TOLERANCE_MS);
      const at = Math.max(est, floor);
      if (setBack || !(at < expiry)) {
        const why: PhoneEndedWhy = setBack ? 'clock_set_back' : 'expired';
        save({ ...mark, e: why, x: expiry }, num(at) ? at : Date.now());
        return { ended: true, why };
      }
      save({ ...mark, m: at, x: expiry }, at);
      return { ended: false, boxNowMs: at, leftMs: expiry - at };
    },
    learn(boxMs, phoneMs) {
      if (locked || !num(boxMs) || !num(phoneMs)) return;
      const mark = markOf();
      if (mark.e !== undefined) return;
      // The box's clock is the truth: it replaces the phone's offset AND its mark (a phone clock that had jumped ahead
      // pushed the mark ahead with it).
      save({ ...mark, o: boxMs - phoneMs, m: boxMs, x: expiry }, boxMs);
    },
    forget() { locked = true; },
  };
}

/** A handheld page's stamping: the stamper its queue calls, and the clock it stamps by. */
export interface PageStamping {
  readonly stamp: (event: DomainEvent) => SignInStamp | undefined;
  readonly clock: SignInClock;
}

/**
 * The phone's stamping: `stamp` is called once per record as it is queued. `phoneNow` is the phone's clock; `phoneAtServe`
 * is the phone's clock when the box served the page (the page load, or the service worker's `shellCachedAt` when the page
 * came from the cache), so `madeAt` is told on the box's clock, and never runs backwards (the clock's mark). After the
 * sign-in's end — its expiry, or the clock turned back — the phone stamps nothing and `onEnded` is told AT ONCE, so the
 * screen locks on the very record that found the end rather than at the strip's next tick (L2). That one record is still
 * queued — never lost — unstamped, and the box never seals it for anybody but whoever holds the phone at the time.
 * `forget` (the lock) drops the stamp key from memory (L3).
 */
export function phoneStamping(
  signIn: PhoneSignIn | undefined,
  phoneAtServe: string,
  phoneNow: () => string = () => new Date().toISOString(),
  options: PhoneClockOptions & { readonly onEnded?: (why: PhoneEndedWhy) => void } = {},
): PageStamping | undefined {
  if (signIn === undefined) return undefined;
  const clock = signInClock(signIn, phoneAtServe, phoneNow, options);
  let key: Uint8Array | null = fromHex(signIn.key);
  const signedInAt = Date.parse(signIn.signedInAt);
  return {
    clock: { read: () => clock.read(), learn: (b, p) => clock.learn(b, p), forget: () => { key = null; clock.forget(); } },
    stamp: (event) => {
      const reading = clock.read();
      if (reading.ended || key === null) {
        options.onEnded?.(reading.ended ? reading.why : 'locked');
        return undefined;
      }
      // Never before the sign-in itself: the key only exists after it, so an earlier time can only be a clock slip.
      const madeMs = Math.max(reading.boxNowMs, signedInAt);
      const base = { v: 1 as const, ref: signIn.ref, userId: signIn.userId, madeAt: new Date(madeMs).toISOString() };
      return { ...base, mac: hmacSha256Hex(key, stampMessage(base, event)) };
    },
  };
}

/** The stamper alone (`phoneStamping`'s). */
export function phoneStamper(
  signIn: PhoneSignIn | undefined,
  phoneAtServe: string,
  phoneNow: () => string = () => new Date().toISOString(),
  options: PhoneClockOptions & { readonly onEnded?: (why: PhoneEndedWhy) => void } = {},
): ((event: DomainEvent) => SignInStamp | undefined) | undefined {
  return phoneStamping(signIn, phoneAtServe, phoneNow, options)?.stamp;
}

/**
 * The stamping for a handheld page, from what the box injected (`window.phoneSignIn`) and, when the page came from the
 * service worker's cache, when it was kept (`window.shellCachedAt`). `undefined` → this page stamps nothing (not served
 * by a box with a sign-in): its records go unstamped, and the box never seals them for anybody but the holder at the time.
 *
 * On the page, a stamp that finds the sign-in ended locks the screen at once — through the strip's
 * `window.phoneSignInLock`, once the record that found it is saved — and the lock drops the stamp key from memory through
 * `window.phoneSignInOnLock` (L2, L3).
 */
export function pageStamping(
  win: unknown,
  phoneNow: () => string = () => new Date().toISOString(),
  options: PhoneClockOptions = {},
): PageStamping | undefined {
  if (!isObj(win)) return undefined;
  const signIn = readPhoneSignIn(win['phoneSignIn']);
  const cachedAt = win['shellCachedAt'];
  const onEnded = (why: PhoneEndedWhy): void => {
    // A microtask: the queue saves the record that found the end first; then the lock replaces the page.
    void Promise.resolve().then(() => {
      const lock = win['phoneSignInLock'];
      if (typeof lock === 'function') (lock as (why: PhoneEndedWhy) => void)(why);
    });
  };
  const stamping = phoneStamping(signIn, typeof cachedAt === 'string' && Number.isFinite(Date.parse(cachedAt)) ? cachedAt : phoneNow(), phoneNow, { ...options, onEnded });
  if (stamping !== undefined) {
    if (!Array.isArray(win['phoneSignInOnLock'])) win['phoneSignInOnLock'] = [];
    (win['phoneSignInOnLock'] as (() => void)[]).push(() => stamping.clock.forget());
  }
  return stamping;
}

/** The stamper for a handheld page (`pageStamping`'s). */
export function stamperForPage(
  win: unknown,
  phoneNow: () => string = () => new Date().toISOString(),
  options: PhoneClockOptions = {},
): ((event: DomainEvent) => SignInStamp | undefined) | undefined {
  return pageStamping(win, phoneNow, options)?.stamp;
}
