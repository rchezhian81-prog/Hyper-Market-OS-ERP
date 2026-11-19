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
//     accountant, chartered accountant — and, OB-406, the security reviewer). A cashier's PIN opens the till and nothing
//     else (OB-259: "a cashier can then use only the till"); a role that is not on this list is refused, never guessed into
//     an office;
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
import { SIGN_IN_CSS, signInFontFaces } from '../../../packages/ui/src/sign-in-style';

/** CR-01 batch 16: the path the screen server serves the sign-in page's own fonts from, before anyone signs in. */
export const SIGN_IN_FONTS_PATH = '/fonts/';

/** The cookie the browser keeps for an office sign-in (HttpOnly, SameSite=Strict, this PC's loopback only). */
export const OFFICE_COOKIE = 'sre_office';
/** How long an office sign-in lasts: a short life (OB-259 brief). Then the person types their PIN again. */
export const OFFICE_SESSION_MINUTES = 30;
/** The "lane" office sign-ins are judged on in the till's register: its own lock, never a till's. */
export const OFFICE_LANE = 'office-screens';
/**
 * The roles that open office screens. A cashier, the store computer and every outside party do not (OB-259). OB-406 (owner,
 * 27 Oct 2026): the named security reviewer's own role opens them too — only so they can reach the Risk acceptance screen
 * and sign; every screen still checks its own permission, so that role opens that screen (and the approvals inbox) only.
 * OB-622 (owner, 1 Nov 2026): the four roadmap §28 buying and stock roles open them too — the purchasing, receiving and
 * warehouse pages are their work (OB-615). Each screen still checks its own permission. The Picker and the Delivery driver
 * (OB-571) work on their handhelds only, so they do not open office screens.
 */
export const OFFICE_ROLE_IDS: readonly string[] = Object.freeze([
  'owner', 'store_manager', 'accountant', 'chartered_accountant', 'security_reviewer',
  'purchase_user', 'purchase_approver', 'receiver_qc', 'warehouse_user',
]);
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

/**
 * CR-01 step 4f · OB-795 "A for login" (owner, 15 Nov 2026, in writing): the store PC's one front door for everybody —
 * owner, manager and staff. `http://127.0.0.1:<screen port>/` and `/office/` always ask for a staff ID and PIN (a session
 * already open on this shared PC is ended first), and a correct one lands the person on their own first permitted page.
 * As a sign-in `next`, this path means "wherever this person's work starts".
 */
export const FRONT_DOOR = '/office/';

/** Where to go after signing in: a plain path on this box, never another site; else the office home. */
export function safeNext(next: string | undefined): string {
  if (next === undefined) return '/manager/';
  return /^\/[A-Za-z0-9/_.?=&%-]*$/.test(next) && !next.startsWith('//') && !next.includes('..') ? next : '/manager/';
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/**
 * Batch 12 (owner, 17 Nov 2026: "like the cloud demo's login page"): the store computer's sign-in wears the owner's approved
 * sign-in design — the SAME stylesheet as the hosted demo's (`packages/ui/src/sign-in-style.ts`, one source): a cream page,
 * the SRE mark and "Your store. / One workspace." on the left, the white "Staff access" card on the right. What it says is
 * the store computer's own truth: a staff ID and a six-digit PIN (never a password), the form posts exactly as before, and
 * nothing here is a sample — there is no practice strip on a store PC.
 *
 * English and Tamil are both in the page; the English / தமிழ் switch at the top right is two radio buttons and CSS, so it
 * works with no script at all (`:has()`, Chromium 105+ — the store PC's browser).
 */
const STORE_SIGN_IN_STYLE = [
  // The switch: the radio inputs stay in the page for the keyboard and a screen reader, out of sight.
  '.sl-lang-radio{position:absolute;opacity:0;width:1px;height:1px;margin:0;pointer-events:none}',
  '#sre-login:has(#sl-lang-en:checked) [lang="ta"]:not(.sl-keep),#sre-login:has(#sl-lang-ta:checked) [lang="en"]:not(.sl-keep){display:none}',
  '#sre-login .sl-language label{display:inline-flex;align-items:center;min-height:44px;padding:7px 16px;font-size:14px;color:var(--sre-muted);border-radius:999px;cursor:pointer}',
  '#sre-login .sl-language label:has(input:checked){background:#fff;color:var(--sre-deep);font-weight:650;box-shadow:0 1px 4px #0e3b2e12}',
  '#sre-login .sl-language label:has(input:focus-visible){outline:3px solid #0e3b2e;outline-offset:2px}',
  // A PIN field is the demo's password field (the same edge, the same 53px), numeric.
  '#sre-login input[inputmode="numeric"]{letter-spacing:.3em}',
  '#sre-login .sl-problem{display:block;font-size:14px;line-height:1.6;border-radius:8px;padding:12px;margin-top:17px;background:var(--sre-red-bg);color:var(--sre-red);border:1px solid #e5c7c1}',
  '#sre-login .sl-problem p{margin:0}',
  '#sre-login .sl-links{display:grid;gap:10px;margin-top:22px}',
  '#sre-login .sl-links a{text-decoration:none}',
  '#sre-login .sl-allowed{list-style:none;margin:18px 0 0;padding:0;display:grid;gap:8px}',
  '#sre-login .sl-allowed a{display:flex;align-items:center;min-height:48px;padding:8px 14px;border:1px solid var(--sre-border);border-radius:12px;background:#f9f5ec;color:var(--sre-ink);text-decoration:none;font-weight:600}',
  '#sre-login form#office-sign-out button{display:flex;align-items:center;justify-content:center;width:100%;min-height:48px;margin-top:18px;border:1px solid var(--sre-green);border-radius:999px;background:#fff;color:var(--sre-green);font-size:14px;font-weight:600}',
  '#sre-login:has(#sl-lang-ta:checked) .sl-hero{font-size:clamp(29px,3.1vw,42px);letter-spacing:-.3px;line-height:1.5}',
  '#sre-login:has(#sl-lang-ta:checked) .sl-eyebrow,#sre-login:has(#sl-lang-ta:checked) .sl-login-kicker{letter-spacing:0;line-height:1.7;font-size:13px}',
].join('');

/** Words in both languages, side by side in the page; the switch shows one. */
const both = (en: string, ta: string): string => `<span lang="en">${esc(en)}</span><span lang="ta">${esc(ta)}</span>`;

const ICON_PATHS: Readonly<Record<string, string>> = {
  store: '<path d="M2 7l1.5-4h17L22 7"/><path d="M2 7a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0"/><path d="M4 10v11h16V10"/><path d="M9 21v-6h6v6"/>',
  cart: '<circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/>',
  boxes: '<path d="M3 21V8l9-4 9 4v13"/><path d="M3 21h18"/><rect x="7" y="13" width="4" height="4"/><rect x="13" y="13" width="4" height="4"/><path d="M10 9h4"/>',
  receipt: '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1z"/><path d="M14 8H8"/><path d="M16 12H8"/><path d="M13 16H8"/>',
  monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
  login: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/>',
  user: '<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>',
  lock: '<circle cx="12" cy="16" r="1"/><rect x="3" y="10" width="18" height="12" rx="2"/><path d="M7 10V7a5 5 0 0 1 10 0v3"/>',
  arrow: '<path d="M5 12h14"/><path d="M12 5l7 7-7 7"/>',
  usercheck: '<path d="M2 21a8 8 0 0 1 13.29-6"/><circle cx="10" cy="8" r="5"/><path d="M16 19l2 2 4-4"/>',
};
const svg = (name: string): string => `<svg class="sl-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICON_PATHS[name] ?? ''}</svg>`;

/** The whole page around a card: the switch, the top bar, the left-hand welcome, the card on the right. */
function signInShell(title: string, storeName: string, card: string): string {
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(title)}</title><style>${signInFontFaces(SIGN_IN_FONTS_PATH)}${SIGN_IN_CSS}${STORE_SIGN_IN_STYLE}</style></head><body>`,
    '<div id="sre-login">',
    '<div class="sl-product">',
    '<header class="sl-topbar"><div class="sl-brand" aria-label="SRE Hyper Market"><div class="sl-mark" aria-hidden="true">S<span>+</span></div><div class="sl-brand-name">SRE<small>HYPER MARKET</small></div></div>',
    '<div class="sl-top-actions"><div class="sl-language" role="group" aria-label="Language · மொழி"><label for="sl-lang-en" lang="en" class="sl-keep"><input type="radio" class="sl-lang-radio" name="sl-lang" id="sl-lang-en" checked>English</label><label for="sl-lang-ta" lang="ta" class="sl-keep"><input type="radio" class="sl-lang-radio" name="sl-lang" id="sl-lang-ta">தமிழ்</label></div></div></header>',
    '<main class="sl-main">',
    '<section class="sl-intro" aria-label="SRE store workspace">',
    `<div class="sl-eyebrow">${both('YOUR EVERYDAY STORE WORKSPACE', 'தினசரி கடைப் பணிகளுக்கான பணித்தளம்')}</div>`,
    `<p class="sl-hero"><span class="sl-hero-ink">${both('Your store.', 'உங்கள் கடை.')}</span><span>${both('One workspace.', 'ஒரே பணித்தளம்.')}</span></p>`,
    `<p class="sl-intro-copy">${both('From the first delivery to the last bill. Bring your team and your store day together.', 'முதல் சரக்கு வரவு முதல் கடைசி விற்பனை வரை. உங்கள் குழுவும் கடைப் பணிகளும் ஒரே இடத்தில்.')}</p>`,
    '<div class="sl-illustration" aria-hidden="true"><div class="sl-workspace">',
    `<div class="sl-workspace-head"><div class="sl-workspace-icon">${svg('store')}</div><div><strong>${esc(storeName)}</strong><small>${both('Store workspace', 'கடைப் பணித்தளம்')}</small></div></div>`,
    `<div class="sl-three"><div>${svg('cart')}<span>${both('Purchase', 'கொள்முதல்')}</span></div><div>${svg('boxes')}<span>${both('Inventory', 'சரக்கு இருப்பு')}</span></div><div>${svg('receipt')}<span>${both('Sales & cash', 'விற்பனை & பணம்')}</span></div></div>`,
    `</div><div class="sl-illustration-label">${svg('monitor')}<span>${both('Store computer', 'கடைக் கணினி')}</span></div></div>`,
    '</section>',
    `<section class="sl-login-area" aria-labelledby="office-heading"><div class="sl-login-card">${card}</div>`,
    `<div class="sl-status"><span class="sl-dot" aria-hidden="true"></span><span>${both('Sign-in works on this computer, even without internet.', 'இணையம் இல்லாவிட்டாலும் இங்கே உள்நுழையலாம்.')}</span></div>`,
    '</section></main></div></div></body></html>',
  ].join('');
}

const kicker = (): string => `<div class="sl-login-kicker">${svg('login')}<span>${both('STAFF ACCESS', 'பணியாளர் உள்நுழைவு')}</span></div>`;
const storeRow = (storeName: string): string =>
  `<div class="sl-store">${svg('store')}<div><strong>${esc(storeName)}</strong><small>${both('On this store computer', 'இந்தக் கடைக் கணினியில்')}</small></div><span class="sl-mode">${both('STORE PC', 'கடைக் கணினி')}</span></div>`;
const personal = (): string => `<div class="sl-personal">${svg('usercheck')}<span>${both('Use your own staff ID and PIN — never anyone else\'s. Sign out when you finish.', 'உங்கள் சொந்தப் பணியாளர் எண்ணையும் PIN-ஐயும் மட்டும் பயன்படுத்துங்கள் — வேறொருவருடையதை ஒருபோதும் வேண்டாம். பணி முடிந்ததும் வெளியேறுங்கள்.')}</span></div>`;

/** The page that asks for the PIN — English and Tamil in the page, the switch at the top right shows one. */
export function signInPage(input: { readonly next: string; readonly problem?: OfficeRefusal; readonly storeName?: string | undefined }): string {
  const problem = input.problem === undefined || input.problem === 'not_signed_in' ? '' : `<div class="sl-problem" role="alert" id="office-problem"><p lang="en">${esc(OFFICE_WORDS[input.problem].en)}</p><p lang="ta">${esc(OFFICE_WORDS[input.problem].ta)}</p></div>`;
  // CR-01 step 4f: the front door is the shop's one sign-in for everybody; a screen's own gate still says "Enter your PIN".
  const front = input.next === FRONT_DOOR;
  const storeName = input.storeName !== undefined && input.storeName.trim() !== '' ? input.storeName.trim() : 'SRE Hyper Market';
  const card = [
    kicker(),
    front
      ? `<h1 id="office-heading">${both('Welcome back.', 'மீண்டும் வருக.')}</h1><p class="sl-subtitle"><span lang="en" id="office-front">Sign in to SRE Hyper Market. One sign-in for everybody — owner, manager and staff. You go straight to your own work.</span><span lang="ta">SRE ஹைப்பர் மார்க்கெட்டில் உள்நுழைக. அனைவருக்கும் ஒரே உள்நுழைவு — உரிமையாளர், மேலாளர், பணியாளர். நீங்கள் நேராக உங்கள் வேலைக்குச் செல்வீர்கள்.</span></p>`
      : `<h1 id="office-heading">${both('Enter your PIN', 'உங்கள் PIN-ஐ உள்ளிடுங்கள்')}</h1><p class="sl-subtitle">${both('The office screens open with your own staff ID and your own till PIN.', 'அலுவலகத் திரைகள் உங்கள் சொந்தப் பணியாளர் எண்ணாலும் உங்கள் சொந்த PIN-ஆலும் மட்டுமே திறக்கும்.')}</p>`,
    storeRow(storeName),
    problem,
    '<form method="post" action="/office/sign-in" id="office-sign-in">',
    `<input type="hidden" name="next" value="${esc(input.next)}">`,
    `<div class="sl-field"><label for="office-staff">${both('Staff ID', 'பணியாளர் எண்')}</label><div class="sl-input-wrap">${svg('user')}<input id="office-staff" name="staffId" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required maxlength="64" autofocus></div></div>`,
    `<div class="sl-field"><label for="office-pin">${both('PIN (6 digits)', 'PIN (6 இலக்கங்கள்)')}</label><div class="sl-input-wrap">${svg('lock')}<input id="office-pin" name="pin" type="password" inputmode="numeric" autocomplete="current-password" pattern="[0-9]{6}" maxlength="6" required></div></div>`,
    `<button type="submit" id="office-submit" class="sl-submit">${both('Sign in', 'உள்நுழைக')}${svg('arrow')}</button>`,
    '</form>',
    personal(),
  ].join('');
  return signInShell(front ? 'Sign in — SRE Hyper Market' : 'Enter your PIN — office screens', storeName, card);
}

/**
 * CR-01 step 4f: the front door's answer to a person whose PIN opens the till only (a cashier) — said plainly, with the
 * way to the till. No office sign-in is made and no office screen opens (the gate's own `not_an_office_role` refusal).
 */
export function tillOnlyPage(): string {
  const card = [
    kicker(),
    `<h1 id="office-heading">${both('Your work is on the till', 'உங்கள் வேலை விற்பனை முனையத்தில்')}</h1>`,
    '<p class="sl-subtitle"><span lang="en" id="office-till-only">Your PIN opens the till, not the office screens. Sign in at the till with the same staff ID and PIN.</span><span lang="ta">உங்கள் PIN விற்பனை முனையத்தைத் திறக்கும், அலுவலகத் திரைகளை அல்ல. அதே பணியாளர் எண்ணாலும் PIN-ஆலும் விற்பனை முனையத்தில் உள்நுழையுங்கள்.</span></p>',
    `<div class="sl-links"><a class="sl-submit" id="office-to-till" href="/pos/">${both('Go to the till', 'விற்பனை முனையத்துக்குச் செல்')}${svg('arrow')}</a>`,
    `<a class="sl-secondary" id="office-back" href="${FRONT_DOOR}">${both('Back to sign-in', 'உள்நுழைவுக்குத் திரும்பு')}</a></div>`,
    personal(),
  ].join('');
  return signInShell('Your work is on the till — SRE Hyper Market', 'SRE Hyper Market', card);
}

/** The page for a signed-in person who may not open THIS screen: the screens they may open, and Sign out. */
export function notAllowedPage(input: { readonly displayName: string; readonly links: readonly { readonly path: string; readonly label: { readonly en: string; readonly ta: string } }[] }): string {
  const links = input.links.length === 0 ? '' : `<ul id="office-allowed" class="sl-allowed">${input.links.map((l) => `<li><a href="${esc(l.path)}">${both(l.label.en, l.label.ta)}</a></li>`).join('')}</ul>`;
  const card = [
    kicker(),
    `<h1 id="office-heading">${both(`${input.displayName} may not open this screen`, `${input.displayName} இந்தத் திரையைத் திறக்க அனுமதி இல்லை`)}</h1>`,
    `<p class="sl-subtitle">${both('Your role does not include it. These are the screens you may open:', 'உங்கள் பணிக்கு இது இல்லை. நீங்கள் திறக்கக்கூடிய திரைகள்:')}</p>`,
    links, signOutForm(),
  ].join('');
  return signInShell('Not your screen — office screens', 'SRE Hyper Market', card);
}

/** The Sign out button — a POST, so a link or a preview can never sign anybody out. */
export function signOutForm(): string {
  return '<form method="post" action="/office/sign-out" id="office-sign-out"><button type="submit"><span lang="en">Sign out</span><span lang="ta">வெளியேறு</span></button></form>';
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
  // Batch 17 · OB-855: the button says "Sign out" OR "வெளியேறு" — the page's one language, following its switch.
  'var b=document.createElement("button");b.type="submit";b.id="sre-office-sign-out";',
  'var say=function(){b.textContent=document.documentElement.lang==="ta"?"\\u0bb5\\u0bc6\\u0bb3\\u0bbf\\u0baf\\u0bc7\\u0bb1\\u0bc1":"Sign out";};say();',
  'new MutationObserver(say).observe(document.documentElement,{attributes:true,attributeFilter:["lang"]});',
  'b.setAttribute("style","font:inherit;min-height:44px;min-width:44px;padding:4px 10px;border:0;border-radius:4px;background:#fff;color:#14202b;cursor:pointer");f.appendChild(b);',
  'document.body.appendChild(f);}if(document.body)draw();else document.addEventListener("DOMContentLoaded",draw);})();</script>',
].join('');

/** Read a small form body (staff ID, PIN, where next). Anything over 4 KB, or not a form, reads as nothing. */
export function readSignInForm(body: string): { readonly staffId: string; readonly pin: string; readonly next: string | undefined } {
  if (body.length > 4096) return { staffId: '', pin: '', next: undefined };
  const form = new URLSearchParams(body);
  return { staffId: (form.get('staffId') ?? '').trim(), pin: (form.get('pin') ?? '').trim(), next: form.get('next') ?? undefined };
}
