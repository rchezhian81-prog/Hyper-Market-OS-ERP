import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
// @ts-expect-error — plain .mjs script module, imported for its pure helpers.
import { parseArgs as tillArgs, planTillSettings } from '../../scripts/install-till.mjs';
// @ts-expect-error — plain .mjs operator script, imported for its pure helpers.
import { parseArgs as tokenArgs, settingsFileFor } from '../../scripts/issue-store-token.mjs';

/**
 * Gap G-RD-3 (docs/runbooks/store-computer-real-data-environment.md): the till installer and `token:store` read the
 * store computer's REAL-data settings file when told `--settings infra/compose/.env.real` — the same flag every newer
 * command takes — and a file named on purpose that cannot be read is an error, never a silent fall-back to another file
 * (P-08). Plus: `pnpm install` works on a Windows PC with no git, from a downloaded ZIP (OB-244).
 */

const KEY = 'k'.repeat(64);

describe('the till installer takes --settings (G-RD-3)', () => {
  it('--settings names the cloud settings file, exactly like --from-compose-env, and marks it as named on purpose', () => {
    expect(tillArgs(['--settings', 'infra/compose/.env.real', '--lane', 'lane-1'])).toMatchObject({ composeEnv: 'infra/compose/.env.real', settingsNamed: true, lane: 'lane-1', unknown: [] });
    expect(tillArgs(['--from-compose-env', 'x'])).toMatchObject({ composeEnv: 'x', settingsNamed: false });
  });

  it('takes the tenant and the pack key from the file it was pointed at', () => {
    const flags = { ...tillArgs(['--settings', '/x/.env.real', '--lane', 'lane-1']) };
    const p = planTillSettings({ flags, installDir: '/t', appsDir: '/a', composeEnv: { EDGE_TENANT_ID: '0b1c2d3e-4f50-4617-8899-aabbccddeeff', PACK_SIGNING_KEY: KEY } });
    expect(p.ok).toBe(true);
    expect(p.settings).toMatchObject({ EDGE_TENANT_ID: '0b1c2d3e-4f50-4617-8899-aabbccddeeff', PACK_SIGNING_KEY: KEY });
  });

  it('a --settings file that cannot be read is a problem — even with --generate-key, it never invents a key instead', () => {
    const flags = { ...tillArgs(['--settings', '/no/such/.env.real', '--lane', 'lane-1', '--tenant', 't', '--generate-key']) };
    const p = planTillSettings({ flags, installDir: '/t', appsDir: '/a', composeEnv: undefined });
    expect(p.ok).toBe(false);
    expect(p.problems).toEqual([expect.stringMatching(/the settings file named with --settings could not be read \(\/no\/such\/\.env\.real\)/)]);
  });
});

describe('token:store takes --settings (G-RD-3)', () => {
  it('--settings wins over STANDUP_ENV_FILE and the default, and is marked as named on purpose', () => {
    expect(settingsFileFor({ settings: 'infra/compose/.env.real' }, { STANDUP_ENV_FILE: '/other' }, '/repo')).toEqual({ path: resolve('infra/compose/.env.real'), explicit: true });
    expect(settingsFileFor({}, { STANDUP_ENV_FILE: '/other' }, '/repo')).toEqual({ path: '/other', explicit: false });
    expect(settingsFileFor({}, {}, '/repo')).toEqual({ path: join('/repo', 'infra', 'compose', '.env'), explicit: false });
  });

  it('a flag never swallows the next flag: --no-store --settings <file> keeps the file', () => {
    expect(tokenArgs(['--no-store', '--settings', 'f', '--tenant', 't'])).toEqual({ 'no-store': '', settings: 'f', tenant: 't' });
  });

  const run = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, ['scripts/issue-store-token.mjs', ...args], { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', ...env } });

  it('issues a token from the file named with --settings (its issuer and audience, not the default file\'s)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sre-token-settings-'));
    const file = join(dir, '.env.real');
    writeFileSync(file, `IDP_SIGNING_KEY=${'s'.repeat(48)}\nIDP_ISSUER=sre-real-store-computer-test\nIDP_AUDIENCE=sre-real-api\nEDGE_TENANT_ID=0b1c2d3e-4f50-4617-8899-aabbccddeeff\n`);
    const r = run(['--settings', file, '--user', 'store-edge', '--store', 'store-1', '--ttl-hours', '1'], { STANDUP_ENV_FILE: join(dir, 'not-this-one') });
    expect(r.status).toBe(0);
    const token = r.stdout.split('\n').find((l) => /^[\w-]+\.[\w-]+\.[\w-]+$/.test(l.trim()))!.trim();
    const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
    expect(payload).toMatchObject({ iss: 'sre-real-store-computer-test', aud: 'sre-real-api', tenant_id: '0b1c2d3e-4f50-4617-8899-aabbccddeeff', branch_id: 'store-1' });
    expect(r.stdout).not.toContain('s'.repeat(48));
  });

  it('a --settings file that cannot be read stops it, saying so — it never falls back to another settings file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sre-token-settings-'));
    const fallback = join(dir, 'fallback.env');
    writeFileSync(fallback, `IDP_SIGNING_KEY=${'f'.repeat(48)}\nIDP_ISSUER=fallback\nIDP_AUDIENCE=a\nEDGE_TENANT_ID=t\nEDGE_STORE_ID=s\n`);
    const r = run(['--settings', join(dir, 'missing.env')], { STANDUP_ENV_FILE: fallback });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/the settings file named with --settings could not be read: .*missing\.env\. Check the path\./);
    expect(r.stdout).toBe('');
    const bare = run(['--settings'], { STANDUP_ENV_FILE: fallback });
    expect(bare.status).toBe(1);
    expect(bare.stderr).toMatch(/no file was named after it/);
  });
});

describe('pnpm install works on a Windows PC from a downloaded ZIP (no git, no Unix shell)', () => {
  const prepareScript = (JSON.parse(spawnSync(process.execPath, ['-p', 'JSON.stringify(require("./package.json").scripts)'], { encoding: 'utf8' }).stdout) as Record<string, string>)['prepare']!;

  it('the install hook is plain node — no "|| true", which Windows cmd does not have', () => {
    expect(prepareScript.startsWith('node -e ')).toBe(true);
    expect(prepareScript).not.toMatch(/\|\||&&|\btrue\b|\/dev\/null/);
  });

  it('succeeds in a folder that is not a git checkout, and with no git on the PATH', () => {
    const code = JSON.parse(`"${prepareScript.slice('node -e "'.length, -1).replace(/\\"/g, '"').replace(/"/g, '\\"')}"`) as string;
    const dir = mkdtempSync(join(tmpdir(), 'sre-zip-'));
    expect(spawnSync(process.execPath, ['-e', code], { cwd: dir, encoding: 'utf8' }).status).toBe(0);
    expect(spawnSync(process.execPath, ['-e', code], { cwd: dir, encoding: 'utf8', env: { PATH: '' } }).status).toBe(0);
  });

  it('still points git at the repository\'s hooks in a real checkout', () => {
    const code = JSON.parse(`"${prepareScript.slice('node -e "'.length, -1).replace(/\\"/g, '"').replace(/"/g, '\\"')}"`) as string;
    const dir = mkdtempSync(join(tmpdir(), 'sre-checkout-'));
    expect(spawnSync('git', ['init', '-q', dir]).status).toBe(0);
    expect(spawnSync(process.execPath, ['-e', code], { cwd: dir }).status).toBe(0);
    expect(spawnSync('git', ['-C', dir, 'config', 'core.hooksPath'], { encoding: 'utf8' }).stdout.trim()).toBe('.githooks');
  });
});
