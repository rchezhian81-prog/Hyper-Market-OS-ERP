// THE OFFICE SCREENS ASK FOR THE PERSON'S OWN PIN — OB-259 (owner, 20 Oct 2026, "Ask PIN for office screens") · W-7 ·
// hard rules #1, #4, #6 · P-04 · P-07.
//
// On the store PC the screen socket serves the till AND the office screens (manager, migration, owner, …) to every
// Windows account on the PC, on loopback. Before this, an office screen opened as whoever the store setup named for it,
// with no sign-in, so a cashier in the Till account could type an office screen's address. Now, when the till's settings
// say so (`EDGE_OFFICE_SIGN_IN=pin`, which the installer writes):
//
//   • every screen but the till asks "Enter your PIN" (English and Tamil) before it opens: the person's staff ID and
//     their OWN till PIN, checked by THIS box, offline, by the very register the till signs people in with
//     (`TillOperators.verifyPerson` — the same verifiers, the same five-wrong-PINs lock, the same refusals log);
//   • the person must hold an OFFICE role at this store in the store setup the box holds (owner, store manager,
//     accountant, chartered accountant). A cashier's PIN opens the till and nothing else (OB-259: "a cashier can then use
//     only the till"); a role that is not on this list is refused, never guessed into an office;
//   • a sign-in lasts 30 minutes from the moment the PIN was typed, or until Sign out; the box keeps only the HASH of
//     the session's random token, in an fsync'd log folded at start, so a restart neither signs anybody out early nor
//     lets an ended session back in. Neither a PIN nor a token is ever written;
//   • every office page then runs AS that person — their id, their permissions from the store setup, their menu — and a
//     screen whose own permission they do not hold is refused (403) with the screens they may open.
//
// The till is untouched: its page is served exactly as before, and nothing here is on the sale path (hard rule #1).

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { OpenFileLog } from './file-log';
import { openFileLog, readLog } from './file-log';
import type { StorePack } from './store-pack';
import { assignmentsFrom, peopleFrom } from './screen-navigation';

/** The cookie the browser keeps for an office sign-in (HttpOnly, SameSite=Strict, this PC's loopback only). */
export const OFFICE_COOKIE = 'sre_office';
/** How long an office sign-in lasts: a short life (OB-259 brief). Then the person types their PIN again. */
export const OFFICE_SESSION_MINUTES = 30;
/** The "lane" office sign-ins are judged on in the till's register: its own lock, never a till's. */
export const OFFICE_LANE = 'office-screens';
/** The roles that open office screens. A cashier, the store computer and every outside party do not (OB-259). */
export const OFFICE_ROLE_IDS: readonly string[] = Object.freeze(['owner', 'store_manager', 'accountant', 'chartered_accountant']);
/** Every person holds this; the PIN check needs a permission to ask for, and the office rule is the role list above. */
const ANY_PERSON = 'identity.self.read';

/** The till's register, as this gate uses it: the ONE place a PIN is checked (edge/store-edge/src/till-operators.ts). */
export interface PinCheck {
  verifyPerson(input: { readonly staffId: string; readonly pin: string; readonly laneId: string; readonly authority: string }): Promise<
    | { readonly ok: true; readonly userId: string; readonly displayName: string }
    | { readonly ok: false; readonly refusedBecause: string; readonly laneMessage: string }
  >;
}

export type OfficeRefusal = 'wrong_staff_id_or_pin' | 'not_an_office_role' | 'locked' | 'no_people_register' | 'not_readable' | 'session_ended' | 'not_signed_in';

/** What the person reads, in both languages, for each refusal. Said as it is; never which part was wrong. */
export const OFFICE_WORDS: Readonly<Record<OfficeRefusal, { readonly en: string; readonly ta: string }>> = Object.freeze({
  wrong_staff_id_or_pin: { en: 'That staff ID and PIN do not match. Try again.', ta: 'அந்தப் பணியாளர் எண்ணும் PIN-உம் பொருந்தவில்லை. மீண்டும் முயலுங்கள்.' },
  not_an_office_role: { en: 'This PIN opens the till only. The office screens are for the owner, the manager and the accountant.', ta: 'இந்த PIN விற்பனை முனையத்தை மட்டுமே திறக்கும். அலுவலகத் திரைகள் உரிமையாளர், மேலாளர், கணக்காளருக்கு மட்டும்.' },
  locked: { en: 'Too many wrong PINs. Wait fifteen minutes, then try again.', ta: 'பல முறை தவறான PIN. பதினைந்து நிமிடம் காத்திருந்து மீண்டும் முயலுங்கள்.' },
  no_people_register: { en: 'This store computer has not been told who works here yet, so nobody can open the office screens.', ta: 'இங்கு யார் வேலை செய்கிறார்கள் என்று இந்தக் கடை கணினிக்கு இன்னும் சொல்லப்படவில்லை; அதனால் அலுவலகத் திரைகளை யாரும் திறக்க முடியாது.' },
  not_readable: { en: 'Type your staff ID and your six-digit PIN.', ta: 'உங்கள் பணியாளர் எண்ணையும் ஆறு இலக்க PIN-ஐயும் உள்ளிடுங்கள்.' },
  session_ended: { en: 'Your office sign-in has ended. Enter your PIN again.', ta: 'உங்கள் அலுவலக உள்நுழைவு முடிந்தது. மீண்டும் உங்கள் PIN-ஐ உள்ளிடுங்கள்.' },
  not_signed_in: { en: 'Enter your PIN to open the office screens.', ta: 'அலுவலகத் திரைகளைத் திறக்க உங்கள் PIN-ஐ உள்ளிடுங்கள்.' },
});

export type OfficeSignIn =
  | { readonly ok: true; readonly token: string; readonly userId: string; readonly displayName: string; readonly expiresAt: string }
  | { readonly ok: false; readonly refusedBecause: OfficeRefusal };

export type OfficeCheck =
  | { readonly ok: true; readonly userId: string; readonly displayName: string; readonly expiresAt: string }
  | { readonly ok: false; readonly refusedBecause: OfficeRefusal };

/**
 * OB-259 completeness (round 4): why the till's LANE socket refused an office job — a write an office screen makes on the
 * store box (the manager's day close, a reopen, the office screens' decisions), never one the till makes. Said in both
 * languages, and kept on this log (who, which door, why — never a token or a PIN).
 */
export type OfficeActRefusal = 'office_sign_in_needed' | 'office_sign_in_ended' | 'not_an_office_sign_in' | 'lacks_permission' | 'not_the_signed_in_person';

export const OFFICE_ACT_WORDS: Readonly<Record<OfficeActRefusal, { readonly en: string; readonly ta: string }>> = Object.freeze({
  office_sign_in_needed: {
    en: 'Sign in to the office screens first, with your own staff ID and PIN. Nothing was done.',
    ta: 'முதலில் உங்கள் சொந்தப் பணியாளர் எண்ணாலும் PIN-ஆலும் அலுவலகத் திரைகளில் உள்நுழையுங்கள். எதுவும் செய்யப்படவில்லை.',
  },
  office_sign_in_ended: {
    en: 'Your office sign-in has ended. Enter your PIN again. Nothing was done.',
    ta: 'உங்கள் அலுவலக உள்நுழைவு முடிந்தது. மீண்டும் உங்கள் PIN-ஐ உள்ளிடுங்கள். எதுவும் செய்யப்படவில்லை.',
  },
  not_an_office_sign_in: {
    en: 'A till sign-in opens the till only. This is an office job: the owner, the manager or the accountant does it, signed in to the office screens with their own PIN. Nothing was done.',
    ta: 'விற்பனை முனைய உள்நுழைவு விற்பனை முனையத்தை மட்டுமே திறக்கும். இது அலுவலக வேலை: உரிமையாளர், மேலாளர் அல்லது கணக்காளர் தங்கள் சொந்த PIN-ஆல் அலுவலகத் திரைகளில் உள்நுழைந்து செய்வார். எதுவும் செய்யப்படவில்லை.',
  },
  lacks_permission: {
    en: 'Your role does not include this. Nothing was done.',
    ta: 'உங்கள் பணிக்கு இது இல்லை. எதுவும் செய்யப்படவில்லை.',
  },
  not_the_signed_in_person: {
    en: 'This can only be done in the name of the person signed in to the office screens. Nothing was done.',
    ta: 'அலுவலகத் திரைகளில் உள்நுழைந்தவரின் பெயரில் மட்டுமே இதைச் செய்ய முடியும். எதுவும் செய்யப்படவில்லை.',
  },
});

type LogRecord =
  | { readonly kind: 'office_signed_in'; readonly at: string; readonly userId: string; readonly tokenHash: string; readonly expiresAt: string }
  | { readonly kind: 'office_signed_out'; readonly at: string; readonly userId: string; readonly tokenHash: string; readonly why: 'sign_out' | 'no_longer_office' }
  | { readonly kind: 'office_refused'; readonly at: string; readonly staffId: string; readonly reason: OfficeRefusal }
  | { readonly kind: 'office_act_refused'; readonly at: string; readonly route: string; readonly userId: string; readonly reason: OfficeActRefusal };

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The till register's refusal, in this gate's words. */
function refusalOf(reason: string): OfficeRefusal {
  if (reason === 'locked' || reason === 'lane_locked') return 'locked';
  if (reason === 'no_people_register') return 'no_people_register';
  if (reason === 'not_readable' || reason === 'no_lane') return 'not_readable';
  if (reason === 'wrong_staff_id_or_pin') return 'wrong_staff_id_or_pin';
  return 'not_an_office_role';
}

interface Session { readonly tokenHash: string; readonly userId: string; readonly at: string; readonly expiresAt: string }

export class OfficeSessions {
  private readonly sessions = new Map<string, Session>();
  /** Records on the disk that could not be read whole — surfaced, never repaired (hard rule #6). */
  readonly unreadableRecords: number;

  private constructor(
    private readonly log: OpenFileLog,
    private readonly deps: {
      readonly pins: PinCheck;
      /** The office roles this person holds at this store in the CURRENT store setup — read at every decision. */
      readonly officeRolesOf: (userId: string) => readonly string[] | null;
      readonly displayNameOf: (userId: string) => string;
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
    readonly pins: PinCheck;
    readonly officeRolesOf: (userId: string) => readonly string[] | null;
    readonly displayNameOf: (userId: string) => string;
    readonly now?: () => string;
  }): Promise<OfficeSessions> {
    const log = await openFileLog({ dataDir: input.dataDir, capacityBytes: input.capacityBytes, fileName: 'office-sign-ins.log' });
    const restored: LogRecord[] = [];
    let unreadable = 0;
    for (const v of await readLog(log.path)) {
      if (!v.ok) { unreadable += 1; continue; }
      try {
        const r = JSON.parse(v.record) as unknown;
        if (isObj(r) && typeof r['kind'] === 'string' && typeof r['at'] === 'string') restored.push(r as unknown as LogRecord);
        else unreadable += 1;
      } catch { unreadable += 1; }
    }
    return new OfficeSessions(log, { pins: input.pins, officeRolesOf: input.officeRolesOf, displayNameOf: input.displayNameOf, now: input.now ?? (() => new Date().toISOString()) }, restored, unreadable);
  }

  private fold(r: LogRecord): void {
    if (r.kind === 'office_signed_in') this.sessions.set(r.tokenHash, { tokenHash: r.tokenHash, userId: r.userId, at: r.at, expiresAt: r.expiresAt });
    else if (r.kind === 'office_signed_out') this.sessions.delete(r.tokenHash);
  }

  private async record(r: LogRecord): Promise<void> {
    await this.log.append(JSON.stringify(r));
    this.fold(r);
  }

  private holdsOfficeRole(userId: string): boolean | null {
    const roles = this.deps.officeRolesOf(userId);
    if (roles === null) return null;
    return roles.some((r) => OFFICE_ROLE_IDS.includes(r));
  }

  /** The person's staff ID and their own PIN, checked by the till's register, then their office role. */
  async signIn(input: { readonly staffId: string; readonly pin: string }): Promise<OfficeSignIn> {
    const at = this.deps.now();
    const staffId = input.staffId.trim();
    const verified = await this.deps.pins.verifyPerson({ staffId, pin: input.pin, laneId: OFFICE_LANE, authority: ANY_PERSON });
    const refuse = async (reason: OfficeRefusal): Promise<OfficeSignIn> => {
      await this.record({ kind: 'office_refused', at, staffId: staffId.slice(0, 64) || '(none)', reason });
      return { ok: false, refusedBecause: reason };
    };
    if (!verified.ok) {
      const reason = refusalOf(verified.refusedBecause);
      // The till's register already logged a wrong PIN, a lock or an unreadable entry; only the office's own refusal is new.
      if (reason === 'not_an_office_role') return refuse(reason);
      return { ok: false, refusedBecause: reason };
    }
    const office = this.holdsOfficeRole(verified.userId);
    if (office === null) return refuse('no_people_register');
    if (!office) return refuse('not_an_office_role');
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.parse(at) + OFFICE_SESSION_MINUTES * 60_000).toISOString();
    await this.record({ kind: 'office_signed_in', at, userId: verified.userId, tokenHash: sha256(token), expiresAt });
    return { ok: true, token, userId: verified.userId, displayName: verified.displayName, expiresAt };
  }

  /** Is this cookie a live office sign-in, for a person who STILL holds an office role here? Checked on every page. */
  async check(token: string | undefined): Promise<OfficeCheck> {
    if (token === undefined || token === '') return { ok: false, refusedBecause: 'not_signed_in' };
    const hash = sha256(token);
    const session = [...this.sessions.values()].find((s) => timingSafeEqual(Buffer.from(s.tokenHash), Buffer.from(hash)));
    if (session === undefined) return { ok: false, refusedBecause: 'not_signed_in' };
    if (Date.parse(session.expiresAt) <= Date.parse(this.deps.now())) return { ok: false, refusedBecause: 'session_ended' };
    if (this.holdsOfficeRole(session.userId) !== true) {
      await this.record({ kind: 'office_signed_out', at: this.deps.now(), userId: session.userId, tokenHash: session.tokenHash, why: 'no_longer_office' });
      return { ok: false, refusedBecause: 'not_an_office_role' };
    }
    return { ok: true, userId: session.userId, displayName: this.deps.displayNameOf(session.userId), expiresAt: session.expiresAt };
  }

  /** End an office sign-in. An unknown token is simply not signed in. */
  async signOut(token: string | undefined): Promise<boolean> {
    if (token === undefined || token === '') return false;
    const session = this.sessions.get(sha256(token));
    if (session === undefined) return false;
    await this.record({ kind: 'office_signed_out', at: this.deps.now(), userId: session.userId, tokenHash: session.tokenHash, why: 'sign_out' });
    return true;
  }

  /**
   * An office job the till's lane socket refused (OB-259 completeness): kept on this log — the door, who (the person the
   * box verified, if anybody) and why — so the owner can see a cashier's attempt at the day close. Never a token or a PIN.
   */
  async noteRefusedAct(input: { readonly route: string; readonly userId: string | null; readonly reason: OfficeActRefusal }): Promise<void> {
    await this.record({ kind: 'office_act_refused', at: this.deps.now(), route: input.route.slice(0, 64), userId: (input.userId ?? '(nobody)').slice(0, 64), reason: input.reason });
  }

  /** Who is signed in to the office screens now — who and until when, never a token or its hash. */
  live(): readonly { readonly userId: string; readonly expiresAt: string }[] {
    const nowMs = Date.parse(this.deps.now());
    return [...this.sessions.values()].filter((s) => Date.parse(s.expiresAt) > nowMs).map((s) => ({ userId: s.userId, expiresAt: s.expiresAt }));
  }
}

/** The roles the CURRENT store setup gives a person at this store — null when the box holds no role register. */
export function rolesAtThisStore(userId: string, pack: StorePack): readonly string[] | null {
  if (!pack.roleAssignments.known) return null;
  const branchId = pack.policies.known ? pack.policies.value.branchId : null;
  return assignmentsFrom(pack.roleAssignments.value)
    .filter((a) => a.userId === userId && (a.branchScope === 'all' || (branchId !== null && a.branchScope.includes(branchId))))
    .map((a) => a.roleId);
}

/**
 * The gate the store box starts when its settings say `EDGE_OFFICE_SIGN_IN=pin`: the till's own PIN register (or, on a
 * box with no till and no phones, one that signs nobody in — the gate fails closed), and the store setup read at every
 * decision through `pack()`.
 */
export function openOfficeGate(input: { readonly dataDir: string; readonly capacityBytes: number; readonly pins: PinCheck | null; readonly pack: () => StorePack; readonly now?: () => string }): Promise<OfficeSessions> {
  const nobody: PinCheck = { verifyPerson: async () => ({ ok: false, refusedBecause: 'no_people_register', laneMessage: '' }) };
  return OfficeSessions.open({
    dataDir: input.dataDir, capacityBytes: input.capacityBytes, pins: input.pins ?? nobody,
    officeRolesOf: (userId) => rolesAtThisStore(userId, input.pack()),
    displayNameOf: (userId) => { const p = input.pack(); return (p.people.known ? peopleFrom(p.people.value).find((x) => x.userId === userId)?.displayName : undefined) ?? userId; },
    ...(input.now === undefined ? {} : { now: input.now }),
  });
}

// ── The HTTP side: the cookie, the form, the page ─────────────────────────────────────────────────────────────────

/** The office cookie's value from a Cookie header, or undefined. */
export function officeTokenOf(cookieHeader: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(cookieHeader) ? cookieHeader.join('; ') : cookieHeader;
  if (raw === undefined) return undefined;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === OFFICE_COOKIE) {
      const v = part.slice(eq + 1).trim();
      return /^[A-Za-z0-9_-]{20,100}$/.test(v) ? v : undefined;
    }
  }
  return undefined;
}

/** The Set-Cookie for a new sign-in, or (no token) the one that ends it. Loopback HTTP: HttpOnly, SameSite=Strict. */
export function officeCookie(token: string | undefined): string {
  return token === undefined
    ? `${OFFICE_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`
    : `${OFFICE_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${OFFICE_SESSION_MINUTES * 60}`;
}

/** Where to go after signing in: a plain path on this box, never another site; else the office home. */
export function safeNext(next: string | undefined): string {
  if (next === undefined) return '/manager/';
  return /^\/[A-Za-z0-9/_.?=&%-]*$/.test(next) && !next.startsWith('//') && !next.includes('..') ? next : '/manager/';
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const PAGE_STYLE = [
  'body{font-family:system-ui,"Segoe UI",sans-serif;margin:0;background:#f4f6f8;color:#14202b}',
  'main{max-width:30rem;margin:4rem auto;background:#fff;border:1px solid #c9d2da;border-radius:8px;padding:2rem}',
  'h1{font-size:1.5rem;margin:0 0 .25rem}',
  'p.ta,h1 .ta{display:block;font-size:1.05rem;color:#33424f;margin-top:.25rem}',
  'label{display:block;margin-top:1rem;font-weight:600}',
  'input{display:block;width:100%;box-sizing:border-box;min-height:48px;font-size:1.25rem;padding:.5rem;margin-top:.25rem;border:1px solid #6b7a88;border-radius:4px}',
  'button{margin-top:1.5rem;min-height:48px;min-width:48px;font-size:1.1rem;padding:.6rem 1.2rem;border:0;border-radius:4px;background:#0b5394;color:#fff;cursor:pointer}',
  'a{display:inline-block;min-height:44px;line-height:44px;color:#0b5394}',
  '.problem{border-left:4px solid #b3261e;background:#fdecea;padding:.75rem;margin-top:1rem}',
  'ul{padding-left:1.25rem}',
].join('');

/** The page that asks for the PIN — English and Tamil together, so whoever is at the PC can read it. */
export function signInPage(input: { readonly next: string; readonly problem?: OfficeRefusal }): string {
  const problem = input.problem === undefined || input.problem === 'not_signed_in' ? '' : `<div class="problem" role="alert" id="office-problem"><p lang="en">${esc(OFFICE_WORDS[input.problem].en)}</p><p lang="ta" class="ta">${esc(OFFICE_WORDS[input.problem].ta)}</p></div>`;
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Enter your PIN — office screens</title>', `<style>${PAGE_STYLE}</style></head><body><main>`,
    '<h1 id="office-heading"><span lang="en">Enter your PIN</span><span lang="ta" class="ta">உங்கள் PIN-ஐ உள்ளிடுங்கள்</span></h1>',
    '<p lang="en">The office screens open with your own staff ID and your own till PIN. Never use anyone else\'s.</p>',
    '<p lang="ta" class="ta">அலுவலகத் திரைகள் உங்கள் சொந்தப் பணியாளர் எண்ணாலும் உங்கள் சொந்த PIN-ஆலும் மட்டுமே திறக்கும். வேறொருவருடையதை ஒருபோதும் பயன்படுத்த வேண்டாம்.</p>',
    problem,
    '<form method="post" action="/office/sign-in" id="office-sign-in">',
    `<input type="hidden" name="next" value="${esc(input.next)}">`,
    '<label for="office-staff">Staff ID <span lang="ta">· பணியாளர் எண்</span></label>',
    '<input id="office-staff" name="staffId" autocomplete="username" required maxlength="64" autofocus>',
    '<label for="office-pin">PIN <span lang="ta">· PIN</span></label>',
    '<input id="office-pin" name="pin" type="password" inputmode="numeric" autocomplete="current-password" pattern="[0-9]{6}" maxlength="6" required>',
    '<button type="submit" id="office-submit">Sign in <span lang="ta">· உள்நுழை</span></button>',
    '</form></main></body></html>',
  ].join('');
}

/** The page for a signed-in person who may not open THIS screen: the screens they may open, and Sign out. */
export function notAllowedPage(input: { readonly displayName: string; readonly links: readonly { readonly path: string; readonly label: { readonly en: string; readonly ta: string } }[] }): string {
  const links = input.links.length === 0 ? '' : `<ul id="office-allowed">${input.links.map((l) => `<li><a href="${esc(l.path)}">${esc(l.label.en)} <span lang="ta">· ${esc(l.label.ta)}</span></a></li>`).join('')}</ul>`;
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Not your screen — office screens</title>', `<style>${PAGE_STYLE}</style></head><body><main>`,
    `<h1 id="office-heading"><span lang="en">${esc(input.displayName)} may not open this screen</span><span lang="ta" class="ta">${esc(input.displayName)} இந்தத் திரையைத் திறக்க அனுமதி இல்லை</span></h1>`,
    '<p lang="en">Your role does not include it. These are the screens you may open:</p><p lang="ta" class="ta">உங்கள் பணிக்கு இது இல்லை. நீங்கள் திறக்கக்கூடிய திரைகள்:</p>',
    links, signOutForm(), '</main></body></html>',
  ].join('');
}

/** The Sign out button — a POST, so a link or a preview can never sign anybody out. */
export function signOutForm(): string {
  return '<form method="post" action="/office/sign-out" id="office-sign-out"><button type="submit">Sign out <span lang="ta">· வெளியேறு</span></button></form>';
}

/**
 * What every office page gets once signed in: who is signed in and until when (for the page), and a small Sign out bar
 * fixed at the bottom right of every office page — the same on every app, drawn by the box, so no page can leave it out.
 */
export function signedInGlobals(session: { readonly userId: string; readonly displayName: string; readonly expiresAt: string }): { readonly sreOfficeSession: { readonly userId: string; readonly displayName: string; readonly expiresAt: string } } {
  return { sreOfficeSession: { userId: session.userId, displayName: session.displayName, expiresAt: session.expiresAt } };
}

/** The bar's script: placed after the payload, it draws "<name> · Sign out" from `window.sreOfficeSession`. */
export const SIGN_OUT_BAR = [
  '<script>(function(){var s=window.sreOfficeSession;if(!s)return;function draw(){if(document.getElementById("sre-office-bar"))return;',
  'var f=document.createElement("form");f.method="post";f.action="/office/sign-out";f.id="sre-office-bar";',
  'f.setAttribute("style","position:fixed;right:12px;bottom:12px;z-index:2147483000;background:#14202b;color:#fff;padding:6px 10px;border-radius:6px;font:14px system-ui,sans-serif;display:flex;gap:8px;align-items:center");',
  'var n=document.createElement("span");n.textContent=s.displayName;f.appendChild(n);',
  'var b=document.createElement("button");b.type="submit";b.id="sre-office-sign-out";b.textContent="Sign out \\u00b7 \\u0bb5\\u0bc6\\u0bb3\\u0bbf\\u0baf\\u0bc7\\u0bb1\\u0bc1";',
  'b.setAttribute("style","font:inherit;min-height:44px;min-width:44px;padding:4px 10px;border:0;border-radius:4px;background:#fff;color:#14202b;cursor:pointer");f.appendChild(b);',
  'document.body.appendChild(f);}if(document.body)draw();else document.addEventListener("DOMContentLoaded",draw);})();</script>',
].join('');

/** Read a small form body (staff ID, PIN, where next). Anything over 4 KB, or not a form, reads as nothing. */
export function readSignInForm(body: string): { readonly staffId: string; readonly pin: string; readonly next: string | undefined } {
  if (body.length > 4096) return { staffId: '', pin: '', next: undefined };
  const form = new URLSearchParams(body);
  return { staffId: (form.get('staffId') ?? '').trim(), pin: (form.get('pin') ?? '').trim(), next: form.get('next') ?? undefined };
}
