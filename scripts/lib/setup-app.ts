// The FIRST-RUN SCREENS' engine — CR-01 step 2b (OI-02), decisions OB-715 (two people at first setup) and OB-716 (the
// shop's data on a second disk inside the PC, never the system disk). The second person is the store's ACCOUNTANT: only the
// owner (or a platform administrator) may record a company and a store (`platform.setup.write`), and when the owner raises
// that change himself the accountant approves it (OB-613 · OB-659) — exactly how the owner's own shop was set up.
//
// The screens (scripts/setup-page/index.html, served by scripts/setup-server.ts on this PC only) ask:
//   the data drive · the shop's name, legal name, GSTIN and short code · the owner's name and PIN · the accountant's name
//   and PIN.
// Every answer is checked by the SAME rules the commands use (the GSTIN's check digit — validateGstin; a code as the
// owner setup step takes it; a six-digit PIN — isTillPin), and nothing is done until everything is right.
//
// Then, in order, each step said on the screen as it happens:
//   1. this PC: settings with a new tenant id, the till, the three Windows services (store-computer `setup`);
//   2. the first two people, laid down once (owner-01, the owner; accountant-01, the accountant — the logins OB-277 fixed),
//      exactly as tenant:bootstrap does;
//   3. each person's OWN till PIN, as till:pin sets it (only a fingerprint is kept; the PIN is never written or shown);
//   4. the shop: the company, its GST registration and the store — PREPARED by the owner with his own PIN and APPROVED by
//      the accountant with theirs (M01-FR-01, §28 maker-checker; OB-715 "A", OB-659) — the same owner setup step `shop`.
// Running again on a PC already set up changes nothing that is there: each step says it was already done.
//
// PINs live only in this process's memory for the length of one install, and are dropped at the end. No line said, no
// record and no error carries a PIN, a token or a key (hard rule #4).

import { validateGstin } from '../../packages/org/src/hierarchy';
import { isTillPin, TILL_PIN_LENGTH } from '../../packages/identity/src/till-pin';

/** The logins of the first two people (OB-277). Each belongs to one person only. */
export const OWNER_LOGIN = 'owner-01';
export const ACCOUNTANT_LOGIN = 'accountant-01';
export const ACCOUNTANT_ROLE = 'accountant';

/** A short code as the owner setup step takes it (`--company`, `--store`). */
const CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
/** The shop's short code here: 2 to 10 letters or digits, so the store's code (`<CODE>-MAIN`) stays short and plain. */
const SHOP_CODE = /^[A-Z0-9]{2,10}$/;

export interface Person { readonly name: string; readonly pin: string; readonly pinAgain: string }
export interface SetupAnswers {
  readonly dataDrive: string;
  readonly shopName: string;
  readonly legalName: string;
  readonly gstin: string;
  readonly shopCode: string;
  readonly owner: Person;
  readonly accountant: Person;
}

/** A drive the screens offer: its letter, whether it may hold the shop's data, and why not. */
export interface DriveChoice { readonly letter: string; readonly ok: boolean; readonly why?: string; readonly note?: string }

/** Field name → what is wrong, in plain words. Empty when everything may go ahead. */
export type Problems = Record<string, string>;

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Read the screens' answers from the posted JSON, keeping only the fields this knows. */
export function answersFrom(body: unknown): SetupAnswers {
  const b = (body ?? {}) as Record<string, unknown>;
  const person = (p: unknown): Person => {
    const o = (p ?? {}) as Record<string, unknown>;
    return { name: text(o['name']), pin: typeof o['pin'] === 'string' ? o['pin'] : '', pinAgain: typeof o['pinAgain'] === 'string' ? o['pinAgain'] : '' };
  };
  return {
    dataDrive: text(b['dataDrive']).toUpperCase(),
    shopName: text(b['shopName']),
    legalName: text(b['legalName']),
    gstin: text(b['gstin']).toUpperCase(),
    shopCode: text(b['shopCode']).toUpperCase(),
    owner: person(b['owner']),
    accountant: person(b['accountant']),
  };
}

/** Check every answer at once (the screens show each problem beside its field). */
export function checkAnswers(a: SetupAnswers, drives: readonly DriveChoice[]): Problems {
  const p: Problems = {};
  const drive = drives.find((d) => `${d.letter}:` === a.dataDrive);
  if (a.dataDrive === '') p['dataDrive'] = 'Choose the disk the shop\'s data will be kept on.';
  else if (drive === undefined) p['dataDrive'] = `There is no drive ${a.dataDrive} on this PC to choose.`;
  else if (!drive.ok) p['dataDrive'] = drive.why ?? `Drive ${a.dataDrive} cannot hold the shop's data.`;
  if (a.shopName.length < 2) p['shopName'] = 'Type the shop\'s name, as customers know it.';
  if (a.legalName.length < 3) p['legalName'] = 'Type the legal name exactly as it is on the GST certificate.';
  if (a.gstin === '') p['gstin'] = 'Type the 15-character GSTIN.';
  else {
    try { validateGstin(a.gstin); } catch (e) { p['gstin'] = `This GSTIN is not right: ${e instanceof Error ? e.message.replace(/^.*?: /, '') : 'it does not check out'}.`; }
  }
  if (!SHOP_CODE.test(a.shopCode)) p['shopCode'] = 'Type a short code for the shop: 2 to 10 capital letters or digits, for example SRE.';
  else if (!CODE.test(storeCodeOf(a.shopCode))) p['shopCode'] = 'This code cannot be used.';
  for (const [key, who] of [['owner', a.owner], ['accountant', a.accountant]] as const) {
    if (who.name.length < 2) p[`${key}.name`] = key === 'owner' ? 'Type your name.' : 'Type the accountant\'s name.';
    if (!isTillPin(who.pin)) p[`${key}.pin`] = `A PIN is ${TILL_PIN_LENGTH} digits, 0 to 9, nothing else.`;
    else if (who.pinAgain !== who.pin) p[`${key}.pinAgain`] = 'The two PINs are not the same. Type it again.';
  }
  if (a.owner.name !== '' && a.owner.name.toLowerCase() === a.accountant.name.toLowerCase()) {
    p['accountant.name'] = 'The accountant must be a different person from the owner: you prepare the shop, the accountant approves it.';
  }
  if (isTillPin(a.owner.pin) && a.owner.pin === a.accountant.pin) p['accountant.pin'] = 'Each person chooses their own PIN; these two are the same.';
  return p;
}

/** The store's code, from the shop's: one store, called MAIN (as the owner's own shop is, SRE-MAIN). */
export const storeCodeOf = (shopCode: string): string => `${shopCode}-MAIN`;

/** The values the owner setup step `shop` is given (packages/migration/src/owner-steps-command.ts). */
export function shopStepValues(a: SetupAnswers): Record<string, string> {
  return {
    as: OWNER_LOGIN, approver: ACCOUNTANT_LOGIN, company: a.shopCode, 'legal-name': a.legalName, gstin: a.gstin,
    store: storeCodeOf(a.shopCode), 'store-name': a.shopName,
  };
}

// ── The install, step by step ────────────────────────────────────────────────────────────────────────────────────

/** What the install needs from the world. Each returns whether it was done, and says its own lines. */
export interface InstallSteps {
  /** store-computer `setup` on the chosen drive: 0 done · 1 not done · 2 refused. */
  setUpThisPc(dataDrive: string, say: (line: string) => void): Promise<number>;
  /** The first two people, once. 'seeded' · 'already' (this shop has people already) · a reason it could not. */
  seedPeople(owner: { login: string; name: string }, second: { login: string; name: string; role: string }, say: (line: string) => void): Promise<'seeded' | 'already' | { problem: string }>;
  /** A person's own till PIN, as till:pin sets it. */
  setPin(login: string, pin: string, by: string, say: (line: string) => void): Promise<boolean>;
  /** The owner setup step `shop`, the PIN of each person given when asked. */
  shop(values: Record<string, string>, pinOf: (login: string) => string | undefined, say: (line: string) => void): Promise<boolean>;
}

export interface Progress { readonly lines: string[]; done: boolean; ok: boolean }

/** Run the four steps in order; stop at the first that is not done, saying so. PINs are dropped at the end, whatever happens. */
export async function install(a: SetupAnswers, steps: InstallSteps, progress: Progress): Promise<boolean> {
  const say = (line: string): void => { progress.lines.push(line); };
  const pins = new Map<string, string>([[OWNER_LOGIN, a.owner.pin], [ACCOUNTANT_LOGIN, a.accountant.pin]]);
  try {
    say('Step 1 of 4 — this PC: its settings, the till, and the shop database, office and till as Windows services. This takes a few minutes.');
    const pc = await steps.setUpThisPc(a.dataDrive, say);
    if (pc !== 0) { say('STOPPED at step 1. Nothing more was done. The lines above say why.'); return finish(progress, false); }

    say(`Step 2 of 4 — the first two people: ${a.owner.name} (owner, login ${OWNER_LOGIN}) and ${a.accountant.name} (accountant, login ${ACCOUNTANT_LOGIN}).`);
    const seeded = await steps.seedPeople({ login: OWNER_LOGIN, name: a.owner.name }, { login: ACCOUNTANT_LOGIN, name: a.accountant.name, role: ACCOUNTANT_ROLE }, say);
    if (typeof seeded === 'object') { say(`STOPPED at step 2: ${seeded.problem}`); return finish(progress, false); }
    say(seeded === 'seeded' ? 'The two people are recorded. Every later role needs one person to ask and another to approve.' : 'This shop already has its people; they are kept as they are.');

    say('Step 3 of 4 — each person\'s own till PIN (only a fingerprint of it is kept on this PC).');
    for (const [login, who] of [[OWNER_LOGIN, a.owner], [ACCOUNTANT_LOGIN, a.accountant]] as const) {
      if (!(await steps.setPin(login, who.pin, a.owner.name, say))) { say(`STOPPED at step 3: the PIN for ${login} was not set.`); return finish(progress, false); }
    }

    say(`Step 4 of 4 — the shop: ${a.legalName}, GSTIN ${a.gstin}, store ${storeCodeOf(a.shopCode)} "${a.shopName}". Prepared by ${a.owner.name}, approved by ${a.accountant.name}.`);
    if (!(await steps.shop(shopStepValues(a), (login) => pins.get(login), say))) { say('STOPPED at step 4: the shop was not made active. The lines above say why.'); return finish(progress, false); }

    say('SETUP DONE — this PC is ready. Sign in at the till or the office pages with your staff ID and your own PIN.');
    return finish(progress, true);
  } catch (e) {
    say(`STOPPED: ${e instanceof Error ? e.message : 'something went wrong'}. Send a photo of this screen.`);
    return finish(progress, false);
  } finally {
    pins.clear();
  }
}

function finish(progress: Progress, ok: boolean): boolean {
  progress.done = true;
  progress.ok = ok;
  return ok;
}

// ── The screens' web door (this PC only) ──────────────────────────────────────────────────────────────────────────

/** What the screens ask about this PC before anything: is it set up already, which drives may hold the data. */
export interface SetupState {
  readonly setUp: boolean;
  readonly tenantId?: string;
  readonly dataRoot?: string;
  readonly drives: readonly DriveChoice[];
  readonly release?: string;
}

export interface SetupDoor {
  /** The one-time key the setup program put in the page's address; every call must carry it (no other page can call). */
  readonly key: string;
  readonly page: string;
  state(): SetupState;
  /** A new shop: check, then install. */
  install(a: SetupAnswers, progress: Progress): Promise<boolean>;
  /** A PC already set up: keep everything, bring this PC's programs up to date (store-computer `setup`). */
  keep(progress: Progress): Promise<boolean>;
  /** OI-04: the chosen desktop shortcuts (store-computer `shortcuts --only …`). Returns the lines said. */
  shortcuts(chosen: readonly Shortcut[]): Promise<{ ok: boolean; lines: string[] }>;
}

/** The desktop shortcuts the last screen offers (CR-01 step 2d, OI-04). */
export const SHORTCUT_CHOICES = Object.freeze(['till', 'office', 'import'] as const);
export type Shortcut = (typeof SHORTCUT_CHOICES)[number];
/** The shortcuts ticked on the screen, in a fixed order; anything else is ignored. */
export function shortcutsFrom(body: unknown): Shortcut[] {
  const b = (body ?? {}) as Record<string, unknown>;
  return SHORTCUT_CHOICES.filter((k) => b[k] === true);
}

export interface DoorReply { readonly status: number; readonly type: string; readonly body: string }
const json = (status: number, body: unknown): DoorReply => ({ status, type: 'application/json; charset=utf-8', body: JSON.stringify(body) });

/**
 * One request to the screens' door. GET /setup/ is the page; everything under /setup/api/ needs the one-time key in the
 * `x-setup-key` header (a header another web page cannot send without this door's leave, which it never gives). Only one
 * install runs; a second is refused while the first runs or after it finished.
 */
export function createSetupDoor(door: SetupDoor): (req: { method: string; path: string; headers: Record<string, string | undefined>; body?: unknown }) => Promise<DoorReply> {
  let running: Progress | undefined;
  return async (req) => {
    const path = req.path.split('?')[0] ?? '';
    if (req.method === 'GET' && (path === '/setup/' || path === '/setup')) return { status: 200, type: 'text/html; charset=utf-8', body: door.page };
    if (!path.startsWith('/setup/api/')) return json(404, { error: 'not here' });
    if (req.headers['x-setup-key'] !== door.key) return json(403, { error: 'This page was not opened by the setup program on this PC.' });
    const what = path.slice('/setup/api/'.length);
    if (req.method === 'GET' && what === 'state') return json(200, door.state());
    if (req.method === 'GET' && what === 'progress') return json(200, running ?? { lines: [], done: false, ok: false });
    if (req.method !== 'POST') return json(405, { error: 'not allowed' });
    if (what === 'check') {
      const st = door.state();
      if (st.setUp) return json(409, { error: 'This PC is already set up; its shop is kept as it is.' });
      return json(200, { problems: checkAnswers(answersFrom(req.body), st.drives) });
    }
    if (what === 'shortcuts') {
      // Offered only once the setup on this page has finished well (OI-04: "the wizard's last screen offers each").
      if (running === undefined || !running.done || !running.ok) return json(409, { error: 'The shortcuts are offered once the setup has finished.' });
      const chosen = shortcutsFrom(req.body);
      if (chosen.length === 0) return json(200, { ok: true, lines: ['No shortcut was chosen; nothing was put on the desktop.'] });
      return json(200, await door.shortcuts(chosen));
    }
    if (what === 'install' || what === 'keep') {
      if (running !== undefined) return json(409, { error: 'The setup has already run on this page. Close it and open the setup program again to run it once more.' });
      const st = door.state();
      if (what === 'install') {
        if (st.setUp) return json(409, { error: 'This PC is already set up; its shop is kept as it is.' });
        const a = answersFrom(req.body);
        const problems = checkAnswers(a, st.drives);
        if (Object.keys(problems).length > 0) return json(400, { problems });
        running = { lines: [], done: false, ok: false };
        void door.install(a, running);
      } else {
        if (!st.setUp) return json(409, { error: 'This PC is not set up yet. Fill in the shop\'s details first.' });
        running = { lines: [], done: false, ok: false };
        void door.keep(running);
      }
      return json(202, { started: true });
    }
    return json(404, { error: 'not here' });
  };
}
