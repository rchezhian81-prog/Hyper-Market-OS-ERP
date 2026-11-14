import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, parseEnvText, planSettings, SECRET_KEYS, type Deps } from '../../scripts/lib/store-computer.mjs';
import { API_KEYS } from '../../scripts/lib/store-computer-services.mjs';
// @ts-expect-error — plain .mjs script module.
import { addPrivilegeSealKey, planTillSettings, renderTillEnv, tillEnvChangesFor, updateTillEnv } from '../../scripts/install-till.mjs';
import { world, type World } from '../support/store-computer-world';
import { settingsIn, storePc } from '../support/store-pc-windows';
import { startApi } from '../../services/api/src/main';
import { CLOUD_API_CONFIG, STORE_EDGE_CONFIG } from '../../services/kernel/src/config';

/**
 * **CR-01 step 4a · ADR-0033 · OB-732 "B" (owner, 14 Nov 2026): the dedicated privilege-seal key.**
 *
 *   `prepare` makes BOX_PRIVILEGE_SEAL_KEY with every other secret — its own value; a copy set up before it existed gets
 *   it ADDED ONCE by `setup` (or `till:install`), every other setting byte-for-byte the same; the till's till.env gets the
 *   same value; the API refuses to start when it equals PACK_SIGNING_KEY, IDP_SIGNING_KEY or BOX_HISTORY_SEAL_KEY; and
 *   the value is in no line any of them says.
 */

const said = (w: World): string => w.said.join('\n');
const tillIn = (d: Deps): Record<string, string> => parseEnvText(d.fs.readFileSync('F:\\SRE-data\\till\\till.env', 'utf8')) as Record<string, string>;
const example = { APP_DB_USER: 'sre_app' };
const ids = { random: (n: number) => randomBytes(n), uuid: () => '7b1e8a2c-1f3d-4e5a-9b6c-0d1e2f3a4b5c' };

function installedRelease(): { w: World; d: Deps } {
  const w = world();
  const { d } = storePc(w);
  const fs = d.fs;
  for (const dir of ['C:\\SRE\\runtime\\pgsql\\bin', 'C:\\SRE\\runtime\\winsw', 'C:\\SRE\\scripts', 'C:\\SRE\\services\\api\\dist', 'C:\\SRE\\edge\\store-edge\\dist']) fs.mkdirSync(dir, { recursive: true });
  for (const exe of ['initdb.exe', 'pg_ctl.exe', 'postgres.exe', 'psql.exe', 'pg_isready.exe']) fs.writeFileSync(`C:\\SRE\\runtime\\pgsql\\bin\\${exe}`, 'pretend');
  fs.writeFileSync('C:\\SRE\\runtime\\winsw\\WinSW-x64.exe', 'pretend service host');
  fs.writeFileSync('C:\\SRE\\scripts\\store-computer-service.mjs', '// launcher');
  fs.writeFileSync('C:\\SRE\\services\\api\\dist\\start.js', '// api');
  fs.writeFileSync('C:\\SRE\\edge\\store-edge\\dist\\start.js', '// edge');
  fs.writeFileSync('C:\\SRE\\release.json', JSON.stringify({ kind: 'sre-store-pc-release', version: '1.0.0', commit: 'abcdef1234567890' }));
  return { w, d };
}

describe('prepare makes the privilege-seal key — its own secret', () => {
  it('planned with the other secrets, never equal to any of them, named as a new secret', () => {
    const { planned, secretNames } = planSettings(example, ids);
    const key = planned['BOX_PRIVILEGE_SEAL_KEY'];
    expect(key).toMatch(/^[A-Za-z0-9_-]{64}$/);
    for (const k of ['PACK_SIGNING_KEY', 'BOX_HISTORY_SEAL_KEY', 'IDP_SIGNING_KEY', 'POSTGRES_PASSWORD']) expect(planned[k]).not.toBe(key);
    expect(secretNames).toContain('BOX_PRIVILEGE_SEAL_KEY');
    expect(SECRET_KEYS).toContain('BOX_PRIVILEGE_SEAL_KEY');
    // The office service on the store PC is handed it; the API and the till's configuration know it (optional, 32+).
    expect(API_KEYS).toContain('BOX_PRIVILEGE_SEAL_KEY');
    expect(CLOUD_API_CONFIG.find((s) => s.key === 'BOX_PRIVILEGE_SEAL_KEY')).toEqual({ key: 'BOX_PRIVILEGE_SEAL_KEY', secret: true, optional: true, minLength: 32 });
    expect(STORE_EDGE_CONFIG.find((s) => s.key === 'BOX_PRIVILEGE_SEAL_KEY')).toEqual({ key: 'BOX_PRIVILEGE_SEAL_KEY', secret: true, minLength: 32, optional: true });
  });

  it('setup on a new PC: the settings and the till hold the SAME key; it is never said or logged', async () => {
    const { w, d } = installedRelease();
    expect(await main(['setup', '--data-drive', 'F:'], d)).toBe(0);
    const s = settingsIn(d.fs, 'F:\\SRE-data');
    const till = tillIn(d);
    expect(s['BOX_PRIVILEGE_SEAL_KEY']).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(till['BOX_PRIVILEGE_SEAL_KEY']).toBe(s['BOX_PRIVILEGE_SEAL_KEY']);
    expect(said(w)).not.toContain(s['BOX_PRIVILEGE_SEAL_KEY']!);
    expect(d.fs.readFileSync('C:\\ProgramData\\SRE\\setup.log', 'utf8')).not.toContain(s['BOX_PRIVILEGE_SEAL_KEY']!);
  });
});

describe('a copy set up before the key existed gets it ADDED ONCE, every other setting unchanged', () => {
  it('setup appends it to .env.real and to till.env; every byte before it is kept; a second setup changes nothing', async () => {
    const { w, d } = installedRelease();
    expect(await main(['setup', '--data-drive', 'F:'], d)).toBe(0);
    // Make it an OLD copy: the key taken out of both files (as they were before step 4a).
    const strip = (file: string): string => {
      const text = d.fs.readFileSync(file, 'utf8').split('\n').filter((l: string) => !l.startsWith('BOX_PRIVILEGE_SEAL_KEY=') && !l.includes('privilege-seal key')).join('\n');
      d.fs.writeFileSync(file, text);
      return text;
    };
    const oldSettings = strip('F:\\SRE-data\\.env.real');
    const oldTill = strip('F:\\SRE-data\\till\\till.env');
    w.said.length = 0;
    expect(await main(['setup'], d)).toBe(0);
    const nowSettings = d.fs.readFileSync('F:\\SRE-data\\.env.real', 'utf8');
    const nowTill = d.fs.readFileSync('F:\\SRE-data\\till\\till.env', 'utf8');
    expect(nowSettings.startsWith(oldSettings)).toBe(true);
    expect(nowTill.startsWith(oldTill)).toBe(true);
    const key = settingsIn(d.fs, 'F:\\SRE-data')['BOX_PRIVILEGE_SEAL_KEY']!;
    expect(key).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(tillIn(d)['BOX_PRIVILEGE_SEAL_KEY']).toBe(key);
    // Only the key was added: every other setting reads back exactly as before.
    const before = Object.fromEntries(oldSettings.split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    const after = settingsIn(d.fs, 'F:\\SRE-data');
    for (const [k, v] of Object.entries(before)) expect(after[k], k).toBe(v);
    expect(Object.keys(after).filter((k) => !(k in before))).toEqual(['BOX_PRIVILEGE_SEAL_KEY']);
    expect(said(w)).toMatch(/Added BOX_PRIVILEGE_SEAL_KEY to this copy's settings \(a new secret, made on this computer; never shown\)\. Every other setting is kept exactly as it was\./);
    expect(said(w)).not.toContain(key);
    // Once: a second setup leaves both files byte-for-byte as they are.
    w.said.length = 0;
    expect(await main(['setup'], d)).toBe(0);
    expect(d.fs.readFileSync('F:\\SRE-data\\.env.real', 'utf8')).toBe(nowSettings);
    expect(d.fs.readFileSync('F:\\SRE-data\\till\\till.env', 'utf8')).toBe(nowTill);
    expect(said(w)).not.toMatch(/BOX_PRIVILEGE_SEAL_KEY/);
  });
});

describe('till:install copies it into till.env', () => {
  const flags = { lane: 'lane-1', lanePort: '8090', screenPort: '8091', settingsNamed: true };
  const compose = { EDGE_TENANT_ID: 't-1', PACK_SIGNING_KEY: 'p'.repeat(48), BOX_PRIVILEGE_SEAL_KEY: 'v'.repeat(64) };

  it('a new till.env carries the store computer\'s key; the plan says so in words without the value', () => {
    const plan = planTillSettings({ flags, installDir: '/till', appsDir: '/apps', composeEnv: compose });
    expect(plan.ok).toBe(true);
    expect(plan.settings.BOX_PRIVILEGE_SEAL_KEY).toBe(compose.BOX_PRIVILEGE_SEAL_KEY);
    expect(renderTillEnv(plan.settings)).toMatch(new RegExp(`^BOX_PRIVILEGE_SEAL_KEY=${compose.BOX_PRIVILEGE_SEAL_KEY}$`, 'm'));
    expect(plan.notes.join('\n')).toContain('copied the privilege-seal key');
    expect(plan.notes.join('\n')).not.toContain(compose.BOX_PRIVILEGE_SEAL_KEY);
    // A key equal to the pack key is refused.
    expect(planTillSettings({ flags, installDir: '/till', appsDir: '/apps', composeEnv: { ...compose, BOX_PRIVILEGE_SEAL_KEY: compose.PACK_SIGNING_KEY } }).ok).toBe(false);
  });

  it('an existing till.env without it: the key is the only change, added once; every other line is kept', () => {
    const existingText = '# my till\nEDGE_TENANT_ID=t-1\nPACK_SIGNING_KEY=' + 'p'.repeat(48) + '\nEDGE_LANE_ID=lane-1\nEDGE_OFFICE_SIGN_IN=pin\nEDGE_GUEST_SALES_ONLY=1\nEDGE_MIRROR_PILOT=1\n';
    const existing = { EDGE_TENANT_ID: 't-1', PACK_SIGNING_KEY: 'p'.repeat(48), EDGE_LANE_ID: 'lane-1', EDGE_OFFICE_SIGN_IN: 'pin', EDGE_GUEST_SALES_ONLY: '1', EDGE_MIRROR_PILOT: '1' };
    const plan = planTillSettings({ flags: { ...flags, lane: undefined }, installDir: '/till', appsDir: '/apps', composeEnv: compose, existing });
    const changes = tillEnvChangesFor({ settings: plan.settings, existing, flags: { ...flags, lane: undefined } });
    expect(changes).toEqual({ BOX_PRIVILEGE_SEAL_KEY: compose.BOX_PRIVILEGE_SEAL_KEY });
    const out = updateTillEnv(existingText, changes);
    expect(out.text.startsWith(existingText)).toBe(true);
    expect(out.changed).toEqual(['BOX_PRIVILEGE_SEAL_KEY']);
    // Run again with the key there: nothing to change.
    const again = tillEnvChangesFor({ settings: plan.settings, existing: { ...existing, BOX_PRIVILEGE_SEAL_KEY: compose.BOX_PRIVILEGE_SEAL_KEY }, flags: { ...flags, lane: undefined } });
    expect(again).toEqual({});
  });

  it('the store computer\'s settings file without it: a new key appended, every other byte kept', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sre-4a-key-'));
    const file = join(dir, '.env.real');
    const text = 'PACK_SIGNING_KEY=' + 'p'.repeat(48) + '\nIDP_SIGNING_KEY=' + 'i'.repeat(48) + '\nEDGE_TENANT_ID=t-1';
    writeFileSync(file, text);
    expect(await addPrivilegeSealKey(file, { PACK_SIGNING_KEY: 'p'.repeat(48), IDP_SIGNING_KEY: 'i'.repeat(48) })).toEqual({ added: true });
    const now = readFileSync(file, 'utf8');
    expect(now.startsWith(`${text}\n`)).toBe(true);
    expect(now).toMatch(/^BOX_PRIVILEGE_SEAL_KEY=[A-Za-z0-9_-]{64}$/m);
  });
});

describe('the API refuses to start when the privilege-seal key equals another secret — never saying the value', () => {
  const fakeDb = ['postgres', '://', 'u', ':', 'p', '@', '127.0.0.1:1/never'].join('');
  const base = (): Record<string, string> => ({
    DATABASE_URL: fakeDb, PACK_SIGNING_KEY: randomBytes(32).toString('hex'), BOX_HISTORY_SEAL_KEY: randomBytes(32).toString('hex'), IDP_SIGNING_KEY: randomBytes(32).toString('hex'),
    IDP_ISSUER: 'https://issuer.test', IDP_AUDIENCE: 'sre', PORT: '0', NODE_ENV: 'test',
  });
  it.each(['PACK_SIGNING_KEY', 'IDP_SIGNING_KEY', 'BOX_HISTORY_SEAL_KEY'])('equal to %s: refused by name', async (other) => {
    const env = base();
    const said: string[] = [];
    const running = await startApi({ ...env, BOX_PRIVILEGE_SEAL_KEY: env[other]! }, (t) => { said.push(t); }, (t) => { said.push(t); });
    if (running !== undefined) { await running.stop(); throw new Error('the API started'); }
    const out = said.join('');
    expect(out).toMatch(new RegExp(`this service will not start: BOX_PRIVILEGE_SEAL_KEY is the same as ${other}\\. It must be its own secret`));
    expect(out).not.toContain(env[other]!);
  });
  it('too short: refused by name, the value never echoed', async () => {
    const said: string[] = [];
    const running = await startApi({ ...base(), BOX_PRIVILEGE_SEAL_KEY: 'shortprivkey12345' }, (t) => { said.push(t); }, (t) => { said.push(t); });
    if (running !== undefined) { await running.stop(); throw new Error('the API started'); }
    expect(said.join('')).toMatch(/BOX_PRIVILEGE_SEAL_KEY is 17 characters and needs at least 32/);
    expect(said.join('')).not.toContain('shortprivkey12345');
  });
});
