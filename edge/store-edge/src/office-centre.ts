// THE OFFICE CENTRE ON THE STORE PC — CR-01 step 4: Users & roles (OI-06) and the Import & export centre (OI-07), with
// Tamil for every word they add (OI-09). ADR-0032 · ADR-0033 · M02-FR-01/02/03/04 · M30-FR-02 · §28 · OB-95 · OB-704 …
// OB-706 · P-04 · P-07 · P-08 · hard rules #2, #4, #5, #6.
//
// Served by the till's screen server on this PC only (loopback), behind the office PIN sign-in (OB-259), with no head-office
// internet sign-in (OB-388 is not needed here): the shop's own API runs on this PC (ADR-0032) and each call is made AS the
// signed-in person (this-pc-api.ts). Three places, reached from the Office menu:
//
//   /people/         USERS & ROLES. See who holds which role at this store; give a role (the first role of a NEW person
//                    adds them); approve or reject a role somebody else asked for; take a role back or record that a
//                    person has left; decide and apply those changes; and let a new person set their own first till PIN.
//                    Every one of those asks the person's OWN PIN again, at that moment — so the API's step-up check sees a
//                    PIN typed seconds ago, never a sign-in from half an hour back. The RULES are head office's own and are
//                    not repeated or loosened here: the two-person rule (§28 — the person who asks never approves; the
//                    approver must already hold everything the role carries), OB-95 (never the IT role and a business
//                    role on one person), OB-615 (roles waiting for the owner), the store-computer and machine rules. This
//                    page only carries the person's act and shows head office's answer in its own words.
//   /import-export/  IMPORT & EXPORT. The old-system import (OB-704 … OB-706, unchanged rules — opened at /import/) and the
//                    exports of every domain the person may take out (M30-FR-02: head office decides which, which store's
//                    rows, and which columns are hidden; every export is logged there). Each file is made Excel-safe here: a
//                    byte-order mark so Tamil and ₹ open correctly, Windows line ends, and any cell that Excel would run as
//                    a formula (=, +, @, a tab, a return, or a "-" that is not a number) starts with an apostrophe.
//
// Every act and every refusal is ALSO written, before the answer, to this PC's own append-only log
// (office-centre.log in the till's data folder — never rewritten or deleted, hard rule #6). Never a PIN, never a token.
// No AI can reach any of it (hard rule #5): every act needs a person's own PIN typed on this page.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createUsersSession, type Grant, type Holder, type MyChange, type PendingGrant, type RoleRow } from '../../../apps/web-erp/src/users-session';
import { callAs, personFetch, wordsOf, type ThisPcApiSettings } from './this-pc-api';

export const OFFICE_CENTRE_PATHS = Object.freeze({
  people: '/people/', peopleState: '/people/state', peopleAct: '/people/act',
  io: '/import-export/', ioState: '/import-export/state', ioExport: '/import-export/export',
  importPrefix: '/import/',
});
/** The old menu addresses on the store PC open the office centre instead (they need the internet sign-in otherwise). */
export const OFFICE_CENTRE_REDIRECTS: Readonly<Record<string, string>> = Object.freeze({
  '/users': OFFICE_CENTRE_PATHS.people, '/users/': OFFICE_CENTRE_PATHS.people,
  '/data-io': OFFICE_CENTRE_PATHS.io, '/data-io/': OFFICE_CENTRE_PATHS.io,
});
/** Who may open each place: the same words the menu uses for Users & roles and Import & export. */
export const PEOPLE_WORDS = Object.freeze(['identity.role.read', 'identity.role.request', 'identity.role.grant']);
export const EXPORT_WORD = 'export.read';
/** The old-system import is the migration lead's and the owner's work (head office re-checks every step). */
export const IMPORT_WORDS = Object.freeze(['migration.cleaning.read', 'migration.import.read']);
export const OFFICE_CENTRE_LOG = 'office-centre.log';
const WRONG_PIN_LIMIT = 5;
const LOCK_MS = 15 * 60_000;
/** A staff ID as this shop writes them (owner-01, cashier-02 …). */
const STAFF_ID = /^[a-z][a-z0-9._-]{2,39}$/;

export type PinVerdict = 'ok' | 'wrong' | 'locked' | 'cannot_check';

/** The person signed in to the office screens, and when their PIN was checked for that sign-in. */
export interface OfficePerson { readonly userId: string; readonly signedInAt: string }

export interface OfficeCentreDeps {
  readonly api: ThisPcApiSettings;
  readonly fetch: typeof globalThis.fetch;
  readonly now: () => number;
  /** This store (the till's EDGE_STORE_ID): a role given here is given at this store only. */
  readonly storeId: string;
  /** The till's own PIN register — the one check (OB-257). */
  readonly verifyPin: (userId: string, pin: string) => Promise<PinVerdict>;
  /** The staff IDs that hold a live till PIN on this PC (names only). */
  readonly pinHolders: () => Promise<ReadonlySet<string>>;
  /** A new person's own first PIN, typed by them on this page (the till-pin command's own code, OB-257). */
  readonly setPin: (userId: string, pin: string, by: string) => Promise<{ readonly ok: boolean; readonly lines: readonly string[] }>;
  /** What the person may do at this store, from the signed store setup the box holds. */
  readonly permissionsOf: (userId: string) => readonly string[];
  /** Ask the till to read its store setup again now (a new role reaches the till at once). */
  readonly refreshPack?: () => Promise<unknown>;
  /** The append-only log on this PC. A failure to write stops the act (nothing is done unrecorded). */
  readonly append: (entry: Record<string, unknown>) => Promise<void>;
  readonly newId: (prefix: string) => string;
  /** The old-system import (scripts/lib/import-app.ts), held to the same office sign-in. Absent: not on this PC. */
  readonly importApp?: (req: IncomingMessage, res: ServerResponse, path: string, person: OfficePerson) => Promise<void>;
  readonly importPageHtml?: () => string;
}

/** An answer: status and JSON, words in both languages. */
export interface Answer { readonly status: number; readonly json: Record<string, unknown> }

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const iso = (ms: number): string => new Date(ms).toISOString();

/** The words this centre adds, English and Tamil (OI-09). */
export const CENTRE_WORDS = Object.freeze({
  needPin: { en: 'Type your own six-digit PIN to confirm. Nothing was done.', ta: 'உறுதிசெய்ய உங்கள் ஆறு இலக்க PIN-ஐ உள்ளிடுங்கள். எதுவும் செய்யப்படவில்லை.' },
  wrongPin: { en: 'That is not your PIN. Nothing was done.', ta: 'அது உங்கள் PIN அல்ல. எதுவும் செய்யப்படவில்லை.' },
  locked: { en: 'Too many wrong PINs. Wait fifteen minutes. Nothing was done.', ta: 'பல முறை தவறான PIN. பதினைந்து நிமிடம் காத்திருங்கள். எதுவும் செய்யப்படவில்லை.' },
  cannotCheck: { en: 'This PC cannot check PINs right now. Nothing was done.', ta: 'இந்தக் கணினியால் இப்போது PIN-ஐச் சரிபார்க்க முடியவில்லை. எதுவும் செய்யப்படவில்லை.' },
  notAllowed: { en: 'Your role cannot do this here. Nothing was done.', ta: 'உங்கள் பங்கால் இதை இங்கே செய்ய முடியாது. எதுவும் செய்யப்படவில்லை.' },
  notRecorded: { en: 'This PC could not write it down, so nothing was done. Try again; if it stays, call for help.', ta: 'இந்தக் கணினியால் பதிவு செய்ய முடியவில்லை; எதுவும் செய்யப்படவில்லை.' },
  notReadable: { en: 'The request could not be read. Nothing was done.', ta: 'கோரிக்கையைப் படிக்க முடியவில்லை. எதுவும் செய்யப்படவில்லை.' },
  needStaffId: { en: 'Type the staff ID: small letters and digits, for example cashier-02.', ta: 'பணியாளர் எண்ணை உள்ளிடுங்கள்: சிறிய எழுத்துகளும் எண்களும், உதாரணம் cashier-02.' },
  needName: { en: 'Type the person\'s full name (one person, one staff ID).', ta: 'அந்த நபரின் முழுப் பெயரை உள்ளிடுங்கள் (ஒருவருக்கு ஒரு பணியாளர் எண்).' },
  needRole: { en: 'Choose a role.', ta: 'ஒரு பங்கைத் தேர்ந்தெடுங்கள்.' },
  needReason: { en: 'Say why.', ta: 'ஏன் என்று சொல்லுங்கள்.' },
  yourself: { en: 'Nobody changes their own access. Ask somebody else to do it.', ta: 'யாரும் தங்கள் சொந்த அணுகலை மாற்றுவதில்லை. வேறொருவரிடம் கேளுங்கள்.' },
  asked: { en: 'Asked, in your name. It is given only when a second person approves it.', ta: 'உங்கள் பெயரில் கேட்கப்பட்டது. இரண்டாவது நபர் அனுமதித்தால் மட்டுமே வழங்கப்படும்.' },
  approved: { en: 'Approved — the role is given. The till learns it within a minute.', ta: 'அனுமதிக்கப்பட்டது — பங்கு வழங்கப்பட்டது. ஒரு நிமிடத்தில் கல்லாவுக்குத் தெரியும்.' },
  rejected: { en: 'Rejected. Nothing was given.', ta: 'நிராகரிக்கப்பட்டது. எதுவும் வழங்கப்படவில்லை.' },
  askedChange: { en: 'Asked. A second person approves it on this page (or the Approvals page); then you apply it here.', ta: 'கேட்கப்பட்டது. இரண்டாவது நபர் அனுமதித்த பின் இங்கே செயல்படுத்துங்கள்.' },
  decided: { en: 'Decided, in your name.', ta: 'உங்கள் பெயரில் முடிவு செய்யப்பட்டது.' },
  applied: { en: 'Done — recorded. Their sessions close so it takes effect now.', ta: 'முடிந்தது — பதிவு செய்யப்பட்டது.' },
  notReady: { en: 'That change is not approved yet.', ta: 'அந்த மாற்றம் இன்னும் அனுமதிக்கப்படவில்லை.' },
  onlyRole: { en: 'This is their only role. Taking it back means they have left — use "They have left".', ta: 'இது அவர்களின் ஒரே பங்கு. "அவர் விலகிவிட்டார்" என்பதைப் பயன்படுத்துங்கள்.' },
  pinSet: { en: 'Their own PIN is set. Only a fingerprint of it is kept on this PC.', ta: 'அவர்களின் சொந்த PIN அமைக்கப்பட்டது. அதன் கைரேகை மட்டும் இந்தக் கணினியில் வைக்கப்படுகிறது.' },
  pinNotSame: { en: 'The two PINs are not the same, or not six digits. Nothing was set.', ta: 'இரண்டு PIN-களும் ஒன்றாக இல்லை, அல்லது ஆறு இலக்கம் இல்லை. எதுவும் அமைக்கப்படவில்லை.' },
  pinAlready: { en: 'This person already has a PIN on this PC. A PIN is changed only with the till-pin command, with them there — never from this page.', ta: 'இந்த நபருக்கு ஏற்கனவே PIN உள்ளது. அதை இந்தப் பக்கத்திலிருந்து மாற்ற முடியாது.' },
  pinNoRole: { en: 'Give this person a role here first (asked or given); then they set their PIN.', ta: 'முதலில் இந்த நபருக்கு இங்கே ஒரு பங்கைக் கேளுங்கள்; பிறகு அவர் PIN அமைப்பார்.' },
  pinSameAsYours: { en: 'Each person chooses their own PIN; that is yours. Nothing was set.', ta: 'ஒவ்வொருவரும் தங்கள் சொந்த PIN-ஐத் தேர்ந்தெடுப்பார்; அது உங்களுடையது.' },
  exported: { en: 'Exported, in your name, and logged.', ta: 'உங்கள் பெயரில் ஏற்றுமதி செய்யப்பட்டு பதிவு செய்யப்பட்டது.' },
  needDomain: { en: 'Choose what to export.', ta: 'எதை ஏற்றுமதி செய்வது என்று தேர்ந்தெடுங்கள்.' },
  refused: { en: 'The shop\'s system refused:', ta: 'கடையின் அமைப்பு மறுத்தது:' },
  lostLink: { en: 'This PC\'s own system did not answer. Nothing was done.', ta: 'இந்தக் கணினியின் அமைப்பு பதிலளிக்கவில்லை. எதுவும் செய்யப்படவில்லை.' },
});
type WordKey = keyof typeof CENTRE_WORDS;
const say = (status: number, ok: boolean, key: WordKey, extra: Record<string, unknown> = {}): Answer => ({ status, json: { ok, en: CENTRE_WORDS[key].en, ta: CENTRE_WORDS[key].ta, ...extra } });

// ── Excel-safe files (M30-FR-02) ──────────────────────────────────────────────────────────────────────────────────

/** Read an RFC 4180 CSV (quoted cells, doubled quotes, \n or \r\n) into rows. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = []; let cell = ''; let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i += 1; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

const NUMBER = /^-?\d+(\.\d+)?$/;
/** A cell Excel would run as a formula starts with an apostrophe; a plain number stays a number. */
export function excelSafeCell(v: string): string {
  return /^[=+@\t\r]/.test(v) || (v.startsWith('-') && !NUMBER.test(v)) ? `'${v}` : v;
}
const quote = (v: string): string => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** The same table, safe to open in Excel: a byte-order mark, Windows line ends, no cell that runs as a formula. */
export function excelSafeCsv(csvText: string): string {
  const rows = parseCsv(csvText);
  return `\uFEFF${rows.map((r) => r.map((c) => quote(excelSafeCell(c))).join(',')).join('\r\n')}\r\n`;
}

// ── The centre ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface OfficeCentre {
  /** Does this path belong to the centre? */
  owns(path: string): boolean;
  /** Who may open what — the menu and the pages ask this. */
  may(userId: string): { readonly people: boolean; readonly exports: boolean; readonly import: boolean };
  peopleState(person: OfficePerson): Promise<Answer>;
  peopleAct(person: OfficePerson, body: unknown): Promise<Answer>;
  ioState(person: OfficePerson): Promise<Answer>;
  ioExport(person: OfficePerson, body: unknown): Promise<Answer>;
  readonly deps: OfficeCentreDeps;
}

export function createOfficeCentre(deps: OfficeCentreDeps): OfficeCentre {
  const wrong = new Map<string, { count: number; until: number }>();
  const holdsAny = (userId: string, words: readonly string[]): boolean => { const held = deps.permissionsOf(userId); return words.some((w) => held.includes(w)); };
  const may = (userId: string) => ({ people: holdsAny(userId, PEOPLE_WORDS), exports: holdsAny(userId, [EXPORT_WORD]), import: deps.importApp !== undefined && holdsAny(userId, IMPORT_WORDS) });

  /** The person's own PIN, typed for THIS act: the till's register, five wrong in a row lock them for fifteen minutes. */
  const confirmPin = async (userId: string, pin: unknown): Promise<WordKey | 'ok'> => {
    const lock = wrong.get(userId);
    if (lock !== undefined && lock.until > deps.now()) return 'locked';
    if (typeof pin !== 'string' || !/^\d{6}$/.test(pin)) return 'needPin';
    const v = await deps.verifyPin(userId, pin);
    if (v === 'cannot_check') return 'cannotCheck';
    if (v === 'locked') return 'locked';
    if (v !== 'ok') {
      const n = (lock?.count ?? 0) + 1;
      wrong.set(userId, { count: n, until: n >= WRONG_PIN_LIMIT ? deps.now() + LOCK_MS : 0 });
      return 'wrongPin';
    }
    wrong.delete(userId);
    return 'ok';
  };
  /** Write first; if the log cannot be written, the act is not done. */
  const record = async (entry: Record<string, unknown>): Promise<boolean> => {
    try { await deps.append({ at: iso(deps.now()), ...entry }); return true; } catch { return false; }
  };
  const sessionAs = (userId: string, pinCheckedAt: string) => {
    const f = personFetch(deps.api, { userId, pinCheckedAt }, { fetch: deps.fetch, now: deps.now });
    return { f, users: createUsersSession({ viewer: { userId, permissions: deps.permissionsOf(userId) }, fetch: f, newId: deps.newId }) };
  };
  /** A grant reaches this store when it is for all stores or names this one. */
  const here = (g: Grant): boolean => g.branchScope === 'all' || g.branchScope.includes(deps.storeId);
  const outcomeAnswer = (out: { result: string; status?: number; whatHappened?: string; why?: string }, okKey: WordKey, extra: Record<string, unknown> = {}): Answer => {
    if (out.result === 'ok') return say(200, true, okKey, extra);
    if (out.result === 'lost_link') return say(503, false, 'lostLink');
    if (out.result === 'invalid') {
      const k = (out.why === 'yourself' || out.why === 'onlyRole' || out.why === 'notReady' || out.why === 'needReason' || out.why === 'needRole') ? out.why as WordKey : 'notAllowed';
      return say(422, false, k);
    }
    return { status: out.status === 403 ? 403 : 422, json: { ok: false, en: `${CENTRE_WORDS.refused.en} ${out.whatHappened ?? ''}`.trim(), ta: CENTRE_WORDS.refused.ta, said: out.whatHappened ?? '' } };
  };

  return {
    deps,
    owns: (path) => path === OFFICE_CENTRE_PATHS.people || path === '/people' || path === OFFICE_CENTRE_PATHS.peopleState || path === OFFICE_CENTRE_PATHS.peopleAct
      || path === OFFICE_CENTRE_PATHS.io || path === '/import-export' || path === OFFICE_CENTRE_PATHS.ioState || path === OFFICE_CENTRE_PATHS.ioExport
      || path === '/import' || path.startsWith(OFFICE_CENTRE_PATHS.importPrefix),
    may,

    async peopleState(person) {
      if (!may(person.userId).people) return say(403, false, 'notAllowed');
      const { f, users } = sessionAs(person.userId, person.signedInAt);
      const [roles, holders, pending, mine, inbox, pins] = await Promise.all([
        users.roles(), users.holders(), users.may.decide ? users.pending() : Promise.resolve({ result: 'ok' as const, value: [] as PendingGrant[] }),
        users.mine(), callAs(f, 'GET', '/v1/approvals/requests'), deps.pinHolders(),
      ]);
      if (holders.result === 'lost_link' || roles.result === 'lost_link') return say(503, false, 'lostLink');
      const live: readonly RoleRow[] = roles.result === 'ok' ? roles.value.live : [];
      const waitingRoles = roles.result === 'ok' ? roles.value.waiting.map((w) => w.id) : [];
      const people = (holders.result === 'ok' ? holders.value : [])
        .map((h: Holder) => ({ userId: h.userId, grants: h.grants.filter(here), hasPin: pins.has(h.userId) }))
        .filter((h) => h.grants.length > 0);
      const pendingHere = (pending.result === 'ok' ? pending.value : []).filter(here).map((p) => ({ ...p, hasPin: pins.has(p.userId) }));
      const kinds = new Set(['access_change', 'department_scope_change', 'role_scope_change']);
      const toDecide = inbox.status === 200 && isObj(inbox.body) && Array.isArray(inbox.body['waitingForMe'])
        ? (inbox.body['waitingForMe'] as unknown[]).filter((r): r is Record<string, unknown> => isObj(r) && kinds.has(String(r['kind'])))
          .map((r) => ({ requestId: String(r['requestId']), kind: String(r['kind']), summary: String(r['summary'] ?? ''), requestedBy: String(r['requestedBy'] ?? ''), reason: String(r['reason'] ?? '') }))
        : [];
      return {
        status: 200,
        json: {
          ok: true, userId: person.userId, storeId: deps.storeId, may: users.may,
          roles: live.map((r) => ({ id: r.id, name: r.name, ...(r.nameTa === undefined ? {} : { nameTa: r.nameTa }) })), waitingRoles,
          people, pending: pendingHere, mine: mine.result === 'ok' ? mine.value : [], toDecide,
          ...(holders.result === 'refused' ? { holdersRefused: holders.whatHappened } : {}),
        },
      };
    },

    async peopleAct(person, body) {
      if (!isObj(body)) return say(400, false, 'notReadable');
      const act = str(body['act']);
      const acts = ['give', 'approve', 'reject', 'take-back', 'leaver', 'decide-change', 'apply', 'set-pin'];
      if (!acts.includes(act)) return say(400, false, 'notReadable');
      const base = { kind: 'people', act, by: person.userId };
      if (!may(person.userId).people) { await record({ ...base, outcome: 'refused:not_allowed' }); return say(403, false, 'notAllowed'); }
      const pin = await confirmPin(person.userId, body['pin']);
      if (pin !== 'ok') { await record({ ...base, outcome: `refused:${pin}` }); return say(pin === 'locked' ? 423 : 401, false, pin); }
      const pinCheckedAt = iso(deps.now());
      const { users } = sessionAs(person.userId, pinCheckedAt);
      const target = str(body['userId']);
      const reason = str(body['reason']);
      const done = async (outcome: string, answer: Answer, more: Record<string, unknown> = {}): Promise<Answer> => {
        // The outcome after the act; the request itself was written before it (below). Never a PIN, never a token.
        await record({ ...base, ...more, outcome });
        return answer;
      };
      const before = async (more: Record<string, unknown>): Promise<boolean> => record({ ...base, ...more, outcome: 'asked' });

      if (act === 'give') {
        const roleId = str(body['roleId']); const name = str(body['name']);
        if (!STAFF_ID.test(target)) return say(422, false, 'needStaffId');
        if (target === person.userId) return done('refused:yourself', say(422, false, 'yourself'), { userId: target });
        if (name.length < 2) return say(422, false, 'needName');
        if (roleId === '') return say(422, false, 'needRole');
        if (reason === '') return say(422, false, 'needReason');
        if (!(await before({ userId: target, roleId, name }))) return say(503, false, 'notRecorded');
        const out = await users.give({ userId: target, roleId, stores: deps.storeId, reason: `${reason} — ${name}` }, []);
        return done(out.result === 'ok' ? 'requested' : `refused:${out.result}`, outcomeAnswer(out, 'asked'), { userId: target, roleId, ...(out.result === 'ok' ? { grantId: out.value.grantId } : {}) });
      }
      if (act === 'approve' || act === 'reject') {
        const grantId = str(body['grantId']);
        if (grantId === '') return say(400, false, 'notReadable');
        if (act === 'reject' && reason === '') return say(422, false, 'needReason');
        if (!(await before({ grantId }))) return say(503, false, 'notRecorded');
        const out = await users.decide(grantId, act, reason);
        if (out.result === 'ok' && act === 'approve') await deps.refreshPack?.().catch(() => undefined);
        return done(out.result === 'ok' ? (act === 'approve' ? 'approved' : 'rejected') : `refused:${out.result}`, outcomeAnswer(out, act === 'approve' ? 'approved' : 'rejected'), { grantId });
      }
      if (act === 'take-back' || act === 'leaver') {
        if (target === '') return say(422, false, 'needStaffId');
        if (target === person.userId) return done('refused:yourself', say(422, false, 'yourself'), { userId: target });
        if (reason === '') return say(422, false, 'needReason');
        const holders = await users.holders();
        if (holders.result !== 'ok') return outcomeAnswer(holders, 'askedChange');
        const holder = holders.value.find((h) => h.userId === target);
        if (holder === undefined) return say(422, false, 'notAllowed');
        const roleId = str(body['roleId']);
        const grant = act === 'leaver' ? 'leaver' as const : holder.grants.find((g) => g.roleId === roleId && here(g));
        if (grant === undefined) return say(422, false, 'needRole');
        if (!(await before({ userId: target, ...(act === 'take-back' ? { roleId } : {}) }))) return say(503, false, 'notRecorded');
        const out = await users.askTakeBack(holder, grant, reason);
        return done(out.result === 'ok' ? 'requested' : `refused:${out.result}`, outcomeAnswer(out, 'askedChange'), { userId: target, ...(out.result === 'ok' ? { requestId: out.value.requestId } : {}) });
      }
      if (act === 'decide-change') {
        const requestId = str(body['requestId']); const decision = str(body['decision']);
        if (requestId === '' || (decision !== 'approved' && decision !== 'rejected')) return say(400, false, 'notReadable');
        if (reason === '') return say(422, false, 'needReason');
        if (!(await before({ requestId, decision }))) return say(503, false, 'notRecorded');
        const r = await callAs(sessionAs(person.userId, pinCheckedAt).f, 'POST', `/v1/approvals/requests/${encodeURIComponent(requestId)}/decide`, { decision, reason }, deps.newId('decide'));
        const ok = r.status >= 200 && r.status < 300;
        return done(ok ? decision : `refused:${r.status}`, ok ? say(200, true, 'decided') : r.status === 0 ? say(503, false, 'lostLink') : { status: r.status === 403 ? 403 : 422, json: { ok: false, en: `${CENTRE_WORDS.refused.en} ${wordsOf(r)}`, ta: CENTRE_WORDS.refused.ta } }, { requestId });
      }
      if (act === 'apply') {
        const requestId = str(body['requestId']);
        const mine = await users.mine();
        if (mine.result !== 'ok') return outcomeAnswer(mine, 'applied');
        const change = mine.value.find((c: MyChange) => c.requestId === requestId);
        if (change === undefined) return say(422, false, 'notReady');
        if (!(await before({ requestId }))) return say(503, false, 'notRecorded');
        const out = await users.apply(change);
        if (out.result === 'ok') await deps.refreshPack?.().catch(() => undefined);
        return done(out.result === 'ok' ? 'applied' : `refused:${out.result}`, outcomeAnswer(out, 'applied'), { requestId });
      }
      // set-pin: a NEW person's own first PIN, typed by them here. Never a reset (that could take over an account), never
      // one's own, only for somebody who holds or awaits a role at this store, only by somebody who may ask for roles.
      const newPin = typeof body['newPin'] === 'string' ? body['newPin'] : '';
      const again = typeof body['newPinAgain'] === 'string' ? body['newPinAgain'] : '';
      if (!STAFF_ID.test(target)) return say(422, false, 'needStaffId');
      if (target === person.userId) return done('refused:yourself', say(422, false, 'yourself'), { userId: target });
      if (!users.may.ask) return done('refused:not_allowed', say(403, false, 'notAllowed'), { userId: target });
      if (!/^\d{6}$/.test(newPin) || newPin !== again) return say(422, false, 'pinNotSame');
      if (newPin === body['pin']) return say(422, false, 'pinSameAsYours');
      if ((await deps.pinHolders()).has(target)) return done('refused:already_has_pin', say(409, false, 'pinAlready'), { userId: target });
      const [holders, pending] = await Promise.all([users.holders(), users.may.decide ? users.pending() : Promise.resolve({ result: 'ok' as const, value: [] as PendingGrant[] })]);
      const known = (holders.result === 'ok' && holders.value.some((h) => h.userId === target && h.grants.some(here)))
        || (pending.result === 'ok' && pending.value.some((p) => p.userId === target && here(p)));
      if (!known && holders.result !== 'ok') return outcomeAnswer(holders, 'pinSet');
      if (!known) return done('refused:no_role_here', say(422, false, 'pinNoRole'), { userId: target });
      if (!(await before({ userId: target }))) return say(503, false, 'notRecorded');
      const set = await deps.setPin(target, newPin, person.userId);
      return done(set.ok ? 'pin_set' : 'refused:pin_not_set', set.ok ? say(200, true, 'pinSet') : { status: 422, json: { ok: false, en: set.lines.join(' '), ta: CENTRE_WORDS.pinNotSame.ta } }, { userId: target });
    },

    async ioState(person) {
      const m = may(person.userId);
      if (!m.exports && !m.import) return say(403, false, 'notAllowed');
      const { f } = sessionAs(person.userId, person.signedInAt);
      const [catalogue, log] = m.exports ? await Promise.all([callAs(f, 'GET', '/v1/export'), callAs(f, 'GET', '/v1/exports')]) : [undefined, undefined];
      if (catalogue !== undefined && catalogue.status === 0) return say(503, false, 'lostLink');
      const domains = catalogue !== undefined && catalogue.status === 200 && isObj(catalogue.body) && Array.isArray(catalogue.body['domains'])
        ? (catalogue.body['domains'] as unknown[]).filter(isObj) : [];
      const exportsLog = log !== undefined && log.status === 200 && isObj(log.body) && Array.isArray(log.body['exports'])
        ? (log.body['exports'] as unknown[]).filter(isObj).slice(0, 25) : [];
      return { status: 200, json: { ok: true, userId: person.userId, may: m, domains, exports: exportsLog, ...(catalogue !== undefined && catalogue.status !== 200 ? { catalogueRefused: wordsOf(catalogue) } : {}) } };
    },

    async ioExport(person, body) {
      if (!isObj(body)) return say(400, false, 'notReadable');
      const domain = str(body['domain']);
      const base = { kind: 'export', by: person.userId, domain };
      if (!may(person.userId).exports) { await record({ ...base, outcome: 'refused:not_allowed' }); return say(403, false, 'notAllowed'); }
      if (!/^[a-z][a-z0-9-]{1,60}$/.test(domain)) return say(422, false, 'needDomain');
      const pin = await confirmPin(person.userId, body['pin']);
      if (pin !== 'ok') { await record({ ...base, outcome: `refused:${pin}` }); return say(pin === 'locked' ? 423 : 401, false, pin); }
      const period = str(body['from']) !== '' && str(body['to']) !== '' ? { from: str(body['from']), to: str(body['to']) } : undefined;
      if (!(await record({ ...base, outcome: 'asked' }))) return say(503, false, 'notRecorded');
      const { f } = sessionAs(person.userId, iso(deps.now()));
      const r = await callAs(f, 'POST', `/v1/export/${encodeURIComponent(domain)}`, period ?? {}, deps.newId('export'));
      if (r.status !== 200 || !isObj(r.body) || typeof r.body['csv'] !== 'string') {
        await record({ ...base, outcome: `refused:${r.status}` });
        return r.status === 0 ? say(503, false, 'lostLink') : { status: r.status === 403 ? 403 : 422, json: { ok: false, en: `${CENTRE_WORDS.refused.en} ${wordsOf(r)}`, ta: CENTRE_WORDS.refused.ta } };
      }
      const audit = isObj(r.body['audit']) ? r.body['audit'] : {};
      const day = iso(deps.now()).slice(0, 10);
      await record({ ...base, outcome: 'exported', rows: audit['rowCount'] ?? null });
      return say(200, true, 'exported', { fileName: `${domain}-${day}.csv`, csv: excelSafeCsv(r.body['csv']), schema: r.body['schema'] ?? null, audit });
    },
  };
}
