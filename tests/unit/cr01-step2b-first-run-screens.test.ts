import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { main } from '../../scripts/lib/store-computer.mjs';
import { driveChoices, newDataDriveRefusal } from '../../scripts/lib/store-computer-setup.mjs';
import {
  ACCOUNTANT_LOGIN, OWNER_LOGIN, answersFrom, checkAnswers, createSetupDoor, install, shopStepValues, storeCodeOf,
  type DriveChoice, type InstallSteps, type Progress, type SetupAnswers,
} from '../../scripts/lib/setup-app';
import { world, type World } from '../support/store-computer-world';
import { settingsIn, storePc } from '../support/store-pc-windows';

/**
 * **CR-01 step 2b · OI-02 — the first-run screens.** Decisions OB-715 "A" (two people at first setup: the owner prepares
 * the shop, the accountant approves it, each with their own PIN — M01-FR-01, §28, OB-613 · OB-659) and OB-716 "A" (a new shop's data
 * on a second disk inside the PC, never the disk Windows is on).
 *
 * Every answer is checked by the rules the commands use (the GSTIN's check digit, a six-digit PIN, a code the owner setup
 * step takes), nothing happens until all are right, and the install runs in order: this PC → the two people → each
 * person's own PIN → the shop, prepared and approved. No PIN is said, kept in a line, or handed to any step but the one
 * that checks it. The screens' door answers on this PC only and only with the one-time key.
 */

const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** A GSTIN with its right check character (validateGstin's own sum), for a made-up PAN. */
function gstinFor(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i += 1) { const p = GSTIN_CHARS.indexOf(first14[i]!) * (i % 2 === 0 ? 1 : 2); sum += Math.floor(p / 36) + (p % 36); }
  return first14 + GSTIN_CHARS[(36 - (sum % 36)) % 36];
}
const GSTIN = gstinFor('33ABCDE1234F1Z');
const DRIVES: DriveChoice[] = [{ letter: 'C', ok: false, why: 'C: is the disk Windows is on; the shop\'s data goes on a second disk inside this PC.' }, { letter: 'D', ok: true, note: 'D: is a disk inside this computer (SATA)' }];
const good = (over: Partial<SetupAnswers> = {}): SetupAnswers => ({
  dataDrive: 'D:', shopName: 'SRE Hyper Market', legalName: 'SRE Hyper Market Private Limited', gstin: GSTIN, shopCode: 'SRE',
  owner: { name: 'Elanchezhian', pin: '482915', pinAgain: '482915' }, accountant: { name: 'Ravi', pin: '730264', pinAgain: '730264' }, ...over,
});

describe('the answers are checked by the commands\' own rules, all at once', () => {
  it('right answers: nothing to fix', () => {
    expect(checkAnswers(good(), DRIVES)).toEqual({});
  });
  it('each wrong answer is named beside its field', () => {
    const p = checkAnswers(good({
      dataDrive: 'C:', shopName: '', legalName: 'X', gstin: `${GSTIN.slice(0, 14)}${GSTIN[14] === 'A' ? 'B' : 'A'}`, shopCode: 'sre shop',
      owner: { name: 'E', pin: '12345', pinAgain: '12345' }, accountant: { name: 'Ravi', pin: '730264', pinAgain: '730265' },
    }), DRIVES);
    expect(p['dataDrive']).toMatch(/disk Windows is on/);
    expect(p['shopName']).toMatch(/shop's name/);
    expect(p['legalName']).toMatch(/GST certificate/);
    expect(p['gstin']).toMatch(/check character does not match — a digit is mistyped/);
    expect(p['shopCode']).toMatch(/2 to 10 capital letters or digits/);
    expect(p['owner.name']).toBeDefined();
    expect(p['owner.pin']).toBe('A PIN is 6 digits, 0 to 9, nothing else.');
    expect(p['accountant.pinAgain']).toMatch(/not the same/);
  });
  it('two different people with two different PINs (OB-715): the same name or the same PIN is refused', () => {
    const p = checkAnswers(good({ accountant: { name: 'elanchezhian', pin: '482915', pinAgain: '482915' } }), DRIVES);
    expect(p['accountant.name']).toMatch(/different person from the owner/);
    expect(p['accountant.pin']).toMatch(/own PIN/);
  });
  it('the posted form is read field by field; anything else is ignored', () => {
    const a = answersFrom({ dataDrive: 'd:', gstin: ` ${GSTIN.toLowerCase()} `, shopCode: 'sre', extra: 'x', owner: { name: ' E ', pin: '1', pinAgain: '1' } });
    expect(a).toMatchObject({ dataDrive: 'D:', gstin: GSTIN, shopCode: 'SRE', owner: { name: 'E' }, accountant: { name: '', pin: '' } });
    expect(Object.keys(a)).not.toContain('extra');
  });
});

describe('the install, in order — and the shop is prepared by the owner and approved by the accountant (OB-715, OB-659)', () => {
  const fakeSteps = (fail?: 'pc' | 'people' | 'pin' | 'shop') => {
    const calls: string[] = [];
    const shopSeen: { values?: Record<string, string>; pins?: Record<string, string | undefined> } = {};
    const steps: InstallSteps = {
      setUpThisPc: async (drive, say) => { calls.push(`pc ${drive}`); say('SETUP DONE.'); return fail === 'pc' ? 1 : 0; },
      seedPeople: async (o, m) => { calls.push(`people ${o.login} ${m.login}:${m.role}`); return fail === 'people' ? { problem: 'no database' } : 'seeded'; },
      setPin: async (login) => { calls.push(`pin ${login}`); return fail !== 'pin'; },
      shop: async (values, pinOf) => { calls.push('shop'); shopSeen.values = values; shopSeen.pins = { [OWNER_LOGIN]: pinOf(OWNER_LOGIN), [ACCOUNTANT_LOGIN]: pinOf(ACCOUNTANT_LOGIN), other: pinOf('someone-else') }; return fail !== 'shop'; },
    };
    return { steps, calls, shopSeen };
  };

  it('this PC, the two people, each one\'s own PIN, then the shop — SETUP DONE', async () => {
    const f = fakeSteps();
    const progress: Progress = { lines: [], done: false, ok: false };
    expect(await install(good(), f.steps, progress)).toBe(true);
    expect(f.calls).toEqual(['pc D:', `people ${OWNER_LOGIN} ${ACCOUNTANT_LOGIN}:accountant`, `pin ${OWNER_LOGIN}`, `pin ${ACCOUNTANT_LOGIN}`, 'shop']);
    expect(f.shopSeen.values).toEqual({ as: OWNER_LOGIN, approver: ACCOUNTANT_LOGIN, company: 'SRE', 'legal-name': 'SRE Hyper Market Private Limited', gstin: GSTIN, store: 'SRE-MAIN', 'store-name': 'SRE Hyper Market' });
    expect(f.shopSeen.pins).toEqual({ [OWNER_LOGIN]: '482915', [ACCOUNTANT_LOGIN]: '730264', other: undefined });
    expect(progress).toMatchObject({ done: true, ok: true });
    expect(progress.lines.at(-1)).toMatch(/^SETUP DONE — this PC is ready\./);
    // No PIN in anything said.
    for (const l of progress.lines) { expect(l).not.toContain('482915'); expect(l).not.toContain('730264'); }
  });

  it('stops at the first step that is not done, says which, and does nothing after it', async () => {
    for (const [fail, last, stopped] of [['pc', 'pc D:', /STOPPED at step 1/], ['people', `people ${OWNER_LOGIN} ${ACCOUNTANT_LOGIN}:accountant`, /STOPPED at step 2: no database/], ['pin', `pin ${OWNER_LOGIN}`, /STOPPED at step 3/], ['shop', 'shop', /STOPPED at step 4/]] as const) {
      const f = fakeSteps(fail);
      const progress: Progress = { lines: [], done: false, ok: false };
      expect(await install(good(), f.steps, progress)).toBe(false);
      expect(f.calls.at(-1)).toBe(last);
      expect(progress.lines.join('\n')).toMatch(stopped);
      expect(progress).toMatchObject({ done: true, ok: false });
    }
  });

  it('the store\'s code is the shop\'s code and MAIN, as the owner\'s own store is (SRE-MAIN)', () => {
    expect(storeCodeOf('SRE')).toBe('SRE-MAIN');
    expect(shopStepValues(good()).store).toBe('SRE-MAIN');
  });
});

describe('the screens\' door: this PC only, the one-time key, one install', () => {
  const door = (setUp = false) => {
    const runs: string[] = [];
    const handle = createSetupDoor({
      key: 'k-123', page: '<html>setup</html>',
      state: () => ({ setUp, drives: DRIVES, ...(setUp ? { tenantId: 't-1', dataRoot: 'D:\\SRE-data' } : {}) }),
      install: async (_a, p) => { runs.push('install'); p.done = true; p.ok = true; return true; },
      keep: async (p) => { runs.push('keep'); p.done = true; p.ok = true; return true; },
    });
    return { handle, runs };
  };
  const key = { 'x-setup-key': 'k-123' };

  it('the page is served; every call without the key is refused', async () => {
    const { handle } = door();
    expect((await handle({ method: 'GET', path: '/setup/', headers: {} })).body).toBe('<html>setup</html>');
    expect((await handle({ method: 'GET', path: '/setup/api/state', headers: {} })).status).toBe(403);
    expect((await handle({ method: 'GET', path: '/setup/api/state', headers: { 'x-setup-key': 'wrong' } })).status).toBe(403);
    expect(JSON.parse((await handle({ method: 'GET', path: '/setup/api/state', headers: key })).body)).toMatchObject({ setUp: false });
  });

  it('install: refused with problems until every answer is right; then started once — a second is refused', async () => {
    const { handle, runs } = door();
    const bad = await handle({ method: 'POST', path: '/setup/api/install', headers: key, body: { ...good(), gstin: 'X' } });
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.body).problems.gstin).toBeDefined();
    expect(runs).toEqual([]);
    expect((await handle({ method: 'POST', path: '/setup/api/install', headers: key, body: good() })).status).toBe(202);
    expect((await handle({ method: 'POST', path: '/setup/api/install', headers: key, body: good() })).status).toBe(409);
    expect(runs).toEqual(['install']);
    expect(JSON.parse((await handle({ method: 'GET', path: '/setup/api/progress', headers: key })).body)).toMatchObject({ done: true, ok: true });
  });

  it('a PC already set up: no shop details are taken; "keep" brings its programs up to date and changes nothing else', async () => {
    const { handle, runs } = door(true);
    expect((await handle({ method: 'POST', path: '/setup/api/install', headers: key, body: good() })).status).toBe(409);
    expect((await handle({ method: 'POST', path: '/setup/api/check', headers: key, body: good() })).status).toBe(409);
    expect((await handle({ method: 'POST', path: '/setup/api/keep', headers: key })).status).toBe(202);
    expect(runs).toEqual(['keep']);
  });
});

describe('OB-716 "A": a new shop\'s data on a second disk inside the PC — never the disk Windows is on', () => {
  it('setup on a new PC refuses C: and refuses no drive at all, having changed nothing', async () => {
    const w: World = world();
    const { d } = storePc(w);
    for (const args of [['setup', '--data-drive', 'C:'], ['setup']]) {
      w.said.length = 0;
      expect(await main(args, d)).toBe(2);
      expect(w.said.join('\n')).toMatch(/REFUSED — .*(disk Windows is on|name the disk).*OB-716/);
      expect(d.fs.existsSync('C:\\SRE-data\\.env.real')).toBe(false);
    }
    expect(newDataDriveRefusal({ env: { SystemDrive: 'E:' } }, 'E:')).toMatch(/E: is the disk Windows is on/);
    expect(newDataDriveRefusal({ env: { SystemDrive: 'C:' } }, 'F:')).toBeUndefined();
  });

  it('the screens\' drive list: C: not offered (Windows), F: offered (inside the PC); a USB drive not offered', () => {
    const w: World = world();
    const { d } = storePc(w);
    d.fs.mkdirSync('E:\\', { recursive: true });
    const list = driveChoices(d);
    expect(list.find((x) => x.letter === 'C')).toMatchObject({ ok: false, why: expect.stringMatching(/disk Windows is on/) });
    expect(list.find((x) => x.letter === 'F')).toMatchObject({ ok: true });
    expect(list.find((x) => x.letter === 'E')).toMatchObject({ ok: false, why: expect.stringMatching(/USB/) });
  });

  it('setup-state says where things are and which drives may be used — never a setting\'s value but the tenant id', async () => {
    const w: World = world();
    const { d } = storePc(w);
    expect(await main(['setup-state'], d)).toBe(0);
    expect(JSON.parse(w.said.at(-1)!)).toMatchObject({ setUp: false, drives: expect.arrayContaining([expect.objectContaining({ letter: 'F', ok: true })]) });
    d.fs.mkdirSync('F:\\', { recursive: true });
    expect(await main(['prepare', '--data-drive', 'F:'], d)).toBe(0);
    w.said.length = 0;
    expect(await main(['setup-state'], d)).toBe(0);
    const st = JSON.parse(w.said.at(-1)!) as Record<string, unknown>;
    const s = settingsIn(d.fs, 'F:\\SRE-data');
    expect(st).toMatchObject({ setUp: true, tenantId: s['EDGE_TENANT_ID'], dataRoot: 'F:\\SRE-data', drives: [] });
    for (const k of ['POSTGRES_PASSWORD', 'PACK_SIGNING_KEY', 'BOX_HISTORY_SEAL_KEY', 'IDP_SIGNING_KEY']) expect(w.said.at(-1)).not.toContain(s[k]!);
  });
});

describe('the screens themselves (scripts/setup-page/index.html)', () => {
  const page = readFileSync('scripts/setup-page/index.html', 'utf8');
  it('English and Tamil; the key is read from the page address and sent as a header; no outside script', () => {
    expect(page).toContain('தமிழ்');
    expect(page).toContain("'x-setup-key': KEY");
    expect(page).toContain("location.hash");
    expect(page).not.toMatch(/<script[^>]+src=/);
    expect(page).toContain('accountant-01');
    expect(page).not.toContain('store-manager-01');
    expect(page).toContain('owner-01');
  });
  it('the PINs are cleared from the page once sent; they are password fields', () => {
    expect(page).toContain("['ownerPin', 'ownerPin2', 'mgrPin', 'mgrPin2'].forEach((id) => { $(id).value = ''; });");
    expect(page.match(/type="password"/g)).toHaveLength(4);
  });
});
