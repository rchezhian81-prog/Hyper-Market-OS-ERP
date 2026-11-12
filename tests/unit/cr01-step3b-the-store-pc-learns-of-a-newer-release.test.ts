import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Deps } from '../../scripts/lib/store-computer.mjs';
import { main } from '../../scripts/lib/store-computer.mjs';
import { LATEST_RELEASE_URL, checkForUpdate, keptKey, updateKeyCommand } from '../../scripts/lib/store-pc-update-check.mjs';
import { sha256Of, signUpdate, updateRecord } from '../../scripts/lib/store-pc-update.mjs';

/**
 * **CR-01 step 3b · OI-05 · OB-717 · OB-721 "C": the store PC learns of a newer release.**
 *
 *   `store-computer check-update` asks GitHub for this project's newest store PC release, downloads only its small
 *   update.json, checks the signature over its version, commit and fingerprint with the release public key the running
 *   release carries, and answers in plain words — up to date · a newer version is ready · a newer version exists but
 *   cannot be installed (and why) · could not check (and why) — keeping the answer in status\update-check.json for the
 *   Office page (step 3c). Nothing is installed. OB-721 "C": while the project is public no key is needed; a kept
 *   read-only key (`update-key`, pasted with nothing shown, kept in the shop's data folder) is sent when present, and
 *   never said or written anywhere else.
 */

const keys = () => {
  const k = generateKeyPairSync('ed25519');
  return { priv: k.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, pub: k.publicKey.export({ type: 'spki', format: 'pem' }) as string };
};
const KEYS = keys();
const COMMIT = 'c'.repeat(40);
const SETUP = Buffer.from('pretend SRE-Setup.exe');
const ASSET_URL = 'https://api.github.com/repos/x/y/releases/assets/42';
const TOKEN = `github_pat_${'A1b2C3d4'.repeat(10)}`;

type Served = { status: number; body: string } | 'offline';
interface Pc { deps: Deps; said: string[]; asked: { url: string; headers: Record<string, string> }[]; L: { dataRoot: string; statusDir: string }; root: string }

/** A store PC: an install folder (release.json, optionally release-signing.pub) and a data folder; GitHub pretended. */
function pc(opts: { running?: string; publicKey?: string | null; latest?: Served; record?: Served; typed?: string } = {}): Pc {
  const root = mkdtempSync(join(tmpdir(), 'cr01-3b-'));
  const install = join(root, 'install');
  const dataRoot = join(root, 'data');
  fs.mkdirSync(install, { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  writeFileSync(join(install, 'release.json'), JSON.stringify({ kind: 'sre-store-pc-release', version: opts.running ?? '1.0.2005' }));
  if (opts.publicKey !== null) writeFileSync(join(install, 'release-signing.pub'), opts.publicKey ?? KEYS.pub);
  const said: string[] = [];
  const asked: Pc['asked'] = [];
  const latest = opts.latest ?? { status: 200, body: JSON.stringify({ tag_name: 'store-pc-v1.0.2010', assets: [{ name: 'SRE-Setup.exe', url: `${ASSET_URL}0` }, { name: 'update.json', url: ASSET_URL }] }) };
  const record = opts.record ?? signedRecord('1.0.2010');
  const deps = {
    repoRoot: install, platform: 'linux', env: {}, fs, dataRoot,
    now: () => new Date('2026-11-11T05:00:00Z'),
    say: (l: string) => { said.push(l); },
    askSecret: opts.typed === undefined ? undefined : async () => opts.typed,
    web: async (url: string, headers: Record<string, string>) => {
      asked.push({ url, headers });
      const s = url === LATEST_RELEASE_URL ? latest : url === ASSET_URL ? record : { status: 404, body: '' };
      if (s === 'offline') throw new Error('getaddrinfo ENOTFOUND api.github.com');
      return { status: s.status, text: async () => s.body };
    },
    random: (n: number) => randomBytes(n), uuid: () => randomUUID(),
  } as unknown as Deps;
  return { deps, said, asked, L: { dataRoot, statusDir: join(dataRoot, 'status') }, root };
}

function signedRecord(version: string, signWith = KEYS.priv): Served {
  const fields = { version, commit: COMMIT, sha256: sha256Of(SETUP) };
  return { status: 200, body: JSON.stringify(updateRecord({ ...fields, signature: signUpdate(fields, signWith) })) };
}
const kept = (p: Pc) => JSON.parse(readFileSync(join(p.L.statusDir, 'update-check.json'), 'utf8'));

describe('the four answers, in plain words, kept for the Office page', () => {
  it('a newer, signed release that verifies: READY — and only update.json was downloaded, nothing installed', async () => {
    const p = pc();
    const r = await checkForUpdate(p.deps, p.L);
    expect(r.code).toBe(0);
    expect(r.state).toMatchObject({ state: 'available', running: '1.0.2005', latest: '1.0.2010', tag: 'store-pc-v1.0.2010', commit: COMMIT, sha256: sha256Of(SETUP), withKey: false });
    expect(p.said.join('\n')).toMatch(/^A NEWER VERSION IS READY — version 1\.0\.2010 \(this PC runs 1\.0\.2005\)/);
    expect(kept(p)).toEqual(r.state);
    expect(p.asked.map((a) => a.url)).toEqual([LATEST_RELEASE_URL, ASSET_URL]); // never the setup program here
  });

  it.each([['the same version', '1.0.2010'], ['an older one', '1.0.3000']])('UP TO DATE when GitHub\'s newest is %s', async (_n, running) => {
    const p = pc({ running });
    const r = await checkForUpdate(p.deps, p.L);
    expect(r.code).toBe(0);
    expect(r.state.state).toBe('up-to-date');
    expect(p.said.join('\n')).toMatch(/^UP TO DATE/);
  });

  it('a PC on a test build (0.0.0-ci.N) sees any signed release as newer', async () => {
    const p = pc({ running: '0.0.0-ci.77' });
    expect((await checkForUpdate(p.deps, p.L)).state.state).toBe('available');
  });

  it.each([
    ['NOT SIGNED', { record: { status: 200, body: JSON.stringify(updateRecord({ version: '1.0.2010', commit: COMMIT, sha256: sha256Of(SETUP), signature: null })) } }, /version 1\.0\.2010 is NOT SIGNED/],
    ['signed with another key', { record: signedRecord('1.0.2010', keys().priv) }, /does not verify with this PC's release public key/],
    ['this PC carries no public key (1.0.1996)', { publicKey: null, running: '1.0.1996' }, /carries no release public key .* install version 1\.0\.2005 or newer by hand once/],
  ])('CANNOT BE INSTALLED: %s', async (_n, opts, why) => {
    const p = pc(opts as Parameters<typeof pc>[0]);
    const r = await checkForUpdate(p.deps, p.L);
    expect(r.code).toBe(0);
    expect(r.state.state).toBe('not-installable');
    expect(r.state.said).toMatch(why);
    expect(p.said.join('\n')).toMatch(/^A NEWER VERSION EXISTS BUT CANNOT BE INSTALLED — /);
  });

  it('a record whose version was changed after signing does not verify', async () => {
    const good = JSON.parse((signedRecord('1.0.2010') as { body: string }).body);
    const p = pc({ record: { status: 200, body: JSON.stringify({ ...good, version: '1.0.2099' }) } });
    expect((await checkForUpdate(p.deps, p.L)).state.state).toBe('not-installable');
  });

  it.each([
    ['no internet', { latest: 'offline' as const }, /GitHub did not answer \(no internet/],
    ['GitHub limits the questions', { latest: { status: 403, body: '' } }, /refused the question \(403\)/],
    ['the project went private and no key is kept', { latest: { status: 404, body: '' } }, /if the project was made private, keep a download key with: store-computer update-key/],
    ['GitHub is broken', { latest: { status: 502, body: '' } }, /GitHub answered 502/],
    ['the newest release has no update record', { latest: { status: 200, body: JSON.stringify({ tag_name: 'store-pc-v1.0.2010', assets: [] }) } }, /has no update\.json/],
    ['the update record cannot be downloaded', { record: { status: 500, body: '' } }, /could not be downloaded \(500\)/],
    ['the update record is not one this PC understands', { record: { status: 200, body: '{"kind":"other"}' } }, /not one this PC understands/],
  ])('COULD NOT CHECK (never silent, never fatal): %s', async (_n, opts, why) => {
    const p = pc(opts as Parameters<typeof pc>[0]);
    const r = await checkForUpdate(p.deps, p.L);
    expect(r.code).toBe(1);
    expect(r.state).toMatchObject({ state: 'could-not-check', latest: null });
    expect(r.state.said).toMatch(why);
    expect(p.said.join('\n')).toMatch(/^COULD NOT CHECK — .* The shop keeps working as it is; try again later\.$/);
    expect(kept(p).state).toBe('could-not-check');
  });
});

describe('OB-721 "C": no key while public; a kept key is sent, never said', () => {
  it('without a key, no Authorization header is sent', async () => {
    const p = pc();
    await checkForUpdate(p.deps, p.L);
    for (const a of p.asked) expect(a.headers.authorization).toBeUndefined();
    expect(p.asked[0]!.headers.accept).toBe('application/vnd.github+json');
    expect(p.asked[1]!.headers.accept).toBe('application/octet-stream');
  });

  it('update-key: pasted with nothing shown, kept in the data folder only, sent as a Bearer key, never said or kept elsewhere', async () => {
    const p = pc({ typed: `  ${TOKEN}  ` });
    expect(await updateKeyCommand(p.deps, p.L)).toBe(0);
    const file = join(p.L.dataRoot, 'update-key');
    expect(readFileSync(file, 'utf8')).toBe(`${TOKEN}\n`);
    expect(statSync(file).mode & 0o077).toBe(0); // only this PC's owner account (the data folder is locked by Windows too)
    expect(keptKey(p.deps, p.L)).toBe(TOKEN);
    for (const a of p.asked) expect(a.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(p.said.join('\n')).not.toContain(TOKEN);
    expect(readFileSync(join(p.L.statusDir, 'update-check.json'), 'utf8')).not.toContain(TOKEN);
    expect(kept(p).withKey).toBe(true);
  });

  it('a refused key says so and how to replace it', async () => {
    const p = pc({ typed: TOKEN, latest: { status: 401, body: '' } });
    expect(await updateKeyCommand(p.deps, p.L)).toBe(1);
    expect(p.said.join('\n')).toMatch(/refused the download key \(401\) — it may have expired; make a new one/);
    expect(p.said.join('\n')).not.toContain(TOKEN);
  });

  it('refuses anything that is not a GitHub key, and keeps nothing', async () => {
    const p = pc({ typed: 'my password 1234' });
    expect(await updateKeyCommand(p.deps, p.L)).toBe(2);
    expect(fs.existsSync(join(p.L.dataRoot, 'update-key'))).toBe(false);
    expect(p.said.join('\n')).not.toContain('1234');
  });

  it('refuses with no keyboard, and --remove forgets the key', async () => {
    const p = pc();
    expect(await updateKeyCommand(p.deps, p.L)).toBe(2);
    writeFileSync(join(p.L.dataRoot, 'update-key'), `${TOKEN}\n`);
    expect(await updateKeyCommand(p.deps, p.L, { remove: true })).toBe(0);
    expect(fs.existsSync(join(p.L.dataRoot, 'update-key'))).toBe(false);
  });

  it('a key file holding something else is ignored, never sent', async () => {
    const p = pc();
    writeFileSync(join(p.L.dataRoot, 'update-key'), 'not a key\n');
    await checkForUpdate(p.deps, p.L);
    for (const a of p.asked) expect(a.headers.authorization).toBeUndefined();
  });
});

describe('the store-computer tool knows the two commands', () => {
  it('check-update and update-key are listed in its help, and --remove is understood', async () => {
    const said: string[] = [];
    expect(await main(['help-me'], { say: (l: string) => said.push(l) } as unknown as Deps)).toBe(2);
    const help = said.join('\n');
    expect(help).toContain('check-update');
    expect(help).toContain('update-key [--remove]');
  });
});
