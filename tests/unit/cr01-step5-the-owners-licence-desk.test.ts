import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { gstinOk, readLicence } from '../../scripts/lib/licence.mjs';
import { KEY_FILE, ISSUED_LOG, PUBLIC_FILE, issueCommand, keyFromPaper, makeKeyCommand, paperBackupText, showCommand, type DeskDeps } from '../../scripts/lib/licence-desk.mjs';

/**
 * **CR-01 step 5 · OI-10 · OB-710: the owner's licence desk — the master key made once, licences issued from it.**
 *
 *   The master key is made on the OWNER'S OWN computer: refused inside a code repository (it must never be committed) and
 *   refused on a shop's PC (it must never be there). Its private half is encrypted with a passphrase the program never
 *   writes down; a printable paper backup carries the encrypted key with a check per line, never the passphrase. A licence
 *   is issued from the key, checked against the public half before it is written, and listed in an append-only register of
 *   what was issued. Synthetic data only.
 */

const TENANT = '0b6f1c2e-6a57-4f0a-9d3b-2f4a1e7c9d10';
const GSTIN = ((): string => { for (const c of '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ') { const g = `33ABCDE1234F1Z${c}`; if (gstinOk(g)) return g; } throw new Error('x'); })();
const PASS = 'correct horse battery staple';

function desk(answers: string[] = [], over: Partial<DeskDeps> = {}) {
  const said: string[] = [];
  const asked: { q: string; hidden: boolean }[] = [];
  const queue = [...answers];
  const d: DeskDeps = {
    fs, path, env: {}, platform: 'linux',
    say: (l) => { said.push(l); },
    ask: async (q, hidden) => { asked.push({ q, hidden: hidden === true }); return queue.shift() ?? ''; },
    now: () => new Date('2026-11-14T06:00:00Z'),
    ...over,
  };
  return { d, said, asked, text: () => said.join('\n') };
}
const ownerFolder = (): string => mkdtempSync(path.join(tmpdir(), 'owner-usb-'));

describe('make-key: once, on the owner\'s own computer', () => {
  it('writes the encrypted private key, the public key and a paper backup — the passphrase asked hidden, twice, and kept nowhere', async () => {
    const dir = ownerFolder();
    const { d, asked, text } = desk([PASS, PASS]);
    expect(await makeKeyCommand(d, { folder: dir })).toBe(0);
    expect(asked.every((a) => a.hidden)).toBe(true);
    expect(asked).toHaveLength(2);
    const key = readFileSync(path.join(dir, KEY_FILE), 'utf8');
    expect(key).toMatch(/BEGIN ENCRYPTED PRIVATE KEY/);
    expect(readFileSync(path.join(dir, PUBLIC_FILE), 'utf8')).toMatch(/BEGIN PUBLIC KEY/);
    const paper = readdirSync(dir).find((f) => f.startsWith('PAPER-BACKUP'));
    expect(paper).toBeDefined();
    const all = readdirSync(dir).map((f) => readFileSync(path.join(dir, f), 'utf8')).join('\n');
    expect(all).not.toContain(PASS);
    expect(text()).not.toContain(PASS);
    expect(text()).toMatch(/KEY MADE/);
    if (process.platform !== 'win32') expect(statSync(path.join(dir, KEY_FILE)).mode & 0o077).toBe(0);
  });

  it('is REFUSED inside a code repository — the key must never be committed', async () => {
    const repo = ownerFolder(); mkdirSync(path.join(repo, '.git')); const inside = path.join(repo, 'keys'); mkdirSync(inside);
    const { d, text } = desk([PASS, PASS]);
    expect(await makeKeyCommand(d, { folder: inside })).toBe(2);
    expect(text()).toMatch(/REFUSED .*code repository/);
    expect(existsSync(path.join(inside, KEY_FILE))).toBe(false);
  });

  it('is REFUSED on a shop\'s PC (SRE Retail OS installed) — the master key is never on a shop\'s PC', async () => {
    const programData = ownerFolder(); mkdirSync(path.join(programData, 'SRE'));
    const { d, text } = desk([PASS, PASS], { env: { ProgramData: programData }, platform: 'win32' });
    expect(await makeKeyCommand(d, { folder: ownerFolder() })).toBe(2);
    expect(text()).toMatch(/REFUSED .*shop's PC/);
  });

  it('never replaces a key already made; refuses two different passphrases, or a short one', async () => {
    const dir = ownerFolder();
    expect(await makeKeyCommand(desk([PASS, PASS]).d, { folder: dir })).toBe(0);
    const again = desk([PASS, PASS]);
    expect(await makeKeyCommand(again.d, { folder: dir })).toBe(2);
    expect(again.text()).toMatch(/already holds a seller key/);
    const differ = desk([PASS, `${PASS}!`]);
    expect(await makeKeyCommand(differ.d, { folder: ownerFolder() })).toBe(2);
    expect(differ.text()).toMatch(/not the same/);
    const short = desk(['short', 'short']);
    expect(await makeKeyCommand(short.d, { folder: ownerFolder() })).toBe(2);
  });

  it('the paper backup brings the key back exactly, and a mistyped line is found by its check', () => {
    const pem = '-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIGbMFcGCSqGSIb3DQEFDTBKMCkGCSqGSIb3DQEFDDAcBAhKq\n-----END ENCRYPTED PRIVATE KEY-----\n';
    const paper = paperBackupText({ privatePem: pem, keyId: 'abcd1234abcd1234', madeOn: '2026-11-14' });
    expect(paper).toMatch(/passphrase is NOT on this paper/i);
    const typed = paper.split('\n').filter((l) => /^\d\d /.test(l)).join('\n');
    expect(keyFromPaper(typed)).toEqual({ ok: true, privatePem: pem });
    const wrong = typed.replace('MIGbMFcG', 'MIGbMFcH');
    expect(keyFromPaper(wrong)).toMatchObject({ ok: false });
  });
});

describe('issue: a licence from the key, checked before it is written', () => {
  async function madeKey(): Promise<string> { const dir = ownerFolder(); await makeKeyCommand(desk([PASS, PASS]).d, { folder: dir }); return dir; }

  it('issues a shop licence from the shop\'s request file, checks it with the public key, and registers it', async () => {
    const keyDir = await madeKey();
    const out = ownerFolder();
    const req = path.join(out, 'request.json');
    writeFileSync(req, JSON.stringify({ kind: 'sre-retail-os-licence-request-v1', tenantId: TENANT, shopName: 'Test Shop Two', gstin: GSTIN, release: '1.0.3', madeAt: '2026-11-14T05:00:00Z' }));
    const { d, text } = desk([PASS]);
    expect(await issueCommand(d, { key: path.join(keyDir, KEY_FILE), request: req, tills: '3', stores: '1', modules: 'all', expires: '2027-11-13', out })).toBe(0);
    const file = readdirSync(out).find((f) => f.startsWith('licence-'))!;
    const read = readLicence(readFileSync(path.join(out, file), 'utf8'), [readFileSync(path.join(keyDir, PUBLIC_FILE), 'utf8')]);
    expect(read).toMatchObject({ ok: true, licence: { kind: 'shop', tenantId: TENANT, shopName: 'Test Shop Two', gstin: GSTIN, tills: 3, stores: 1, modules: ['all'], issuedOn: '2026-11-14', expiresOn: '2027-11-13' } });
    expect(text()).toMatch(/LICENCE ISSUED/);
    const reg = readFileSync(path.join(keyDir, ISSUED_LOG), 'utf8').trim().split('\n');
    expect(reg).toHaveLength(1);
    expect(JSON.parse(reg[0]!)).toMatchObject({ tenantId: TENANT, shopName: 'Test Shop Two', expiresOn: '2027-11-13' });
  });

  it('the owner\'s own licence: kind owner, no end date', async () => {
    const keyDir = await madeKey();
    const out = ownerFolder();
    const { d } = desk([PASS]);
    expect(await issueCommand(d, { key: path.join(keyDir, KEY_FILE), owner: true, tenant: TENANT, shop: 'SRE Hyper Market (test)', gstin: GSTIN, tills: '6', stores: '1', modules: 'all', out })).toBe(0);
    const file = readdirSync(out).find((f) => f.startsWith('licence-'))!;
    expect(JSON.parse(readFileSync(path.join(out, file), 'utf8')).terms).toMatchObject({ kind: 'owner', expiresOn: null });
  });

  it('asks for what is missing; refuses a wrong passphrase, a wrong GSTIN, or a shop licence with no end', async () => {
    const keyDir = await madeKey();
    const wrong = desk(['not the passphrase']);
    expect(await issueCommand(wrong.d, { key: path.join(keyDir, KEY_FILE), tenant: TENANT, shop: 'X Shop', gstin: GSTIN, tills: '1', stores: '1', modules: 'all', expires: '2027-01-01', out: ownerFolder() })).toBe(2);
    expect(wrong.text()).toMatch(/passphrase is not right/);
    const badGst = desk([PASS]);
    expect(await issueCommand(badGst.d, { key: path.join(keyDir, KEY_FILE), tenant: TENANT, shop: 'X Shop', gstin: '33ABCDE1234F1ZZ', tills: '1', stores: '1', modules: 'all', expires: '2027-01-01', out: ownerFolder() })).toBe(2);
    expect(badGst.text()).toMatch(/GSTIN/);
    const asks = desk([TENANT, 'Asked Shop', GSTIN, '2', '1', 'M01,M02', '', PASS]);
    expect(await issueCommand(asks.d, { key: path.join(keyDir, KEY_FILE), out: ownerFolder() })).toBe(2);
    expect(asks.text()).toMatch(/only the owner's own licence may have no end date/);
  });

  it('show: reads a licence and says whether the public key checks it', async () => {
    const keyDir = await madeKey();
    const out = ownerFolder();
    await issueCommand(desk([PASS]).d, { key: path.join(keyDir, KEY_FILE), tenant: TENANT, shop: 'Shown Shop', gstin: GSTIN, tills: '1', stores: '1', modules: 'all', expires: '2027-01-01', out });
    const file = path.join(out, readdirSync(out).find((f) => f.startsWith('licence-'))!);
    const ok = desk();
    expect(await showCommand(ok.d, { file, publicKey: path.join(keyDir, PUBLIC_FILE) })).toBe(0);
    expect(ok.text()).toMatch(/SIGNATURE CHECKS/);
    writeFileSync(file, readFileSync(file, 'utf8').replace('Shown Shop', 'Shawn Shop'));
    const bad = desk();
    expect(await showCommand(bad.d, { file, publicKey: path.join(keyDir, PUBLIC_FILE) })).toBe(1);
    expect(bad.text()).toMatch(/FORGED or was EDITED/);
  });
});
