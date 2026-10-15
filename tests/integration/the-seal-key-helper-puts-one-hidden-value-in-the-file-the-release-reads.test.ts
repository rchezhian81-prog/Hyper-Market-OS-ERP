import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

// Round 32 · OB-116 — infra/deploy/set-box-history-seal-key.sh, run against a throwaway box layout (deploy.conf + the
// settings file under <app>/infra/compose). Every key here is made at run time; none is ever written to the repo.
const SCRIPT = join(__dirname, '..', '..', 'infra', 'deploy', 'set-box-history-seal-key.sh');
const key = (): string => randomBytes(36).toString('base64');

let root: string;
let file: string;
let conf: string;
const run = (): { code: number; out: string } => {
  const r = spawnSync('bash', [SCRIPT], { env: { ...process.env, SRE_DEPLOY_CONF: conf }, encoding: 'utf8' });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
};
const lines = (): string[] => readFileSync(file, 'utf8').split('\n').filter((l) => /BOX_HISTORY_SEAL_KEY/.test(l));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'seal-key-'));
  const app = join(root, 'app');
  mkdirSync(join(app, 'infra', 'compose'), { recursive: true });
  file = join(app, 'infra', 'compose', '.env.demo');
  conf = join(root, 'deploy.conf');
  writeFileSync(conf, `SRE_APP_DIR=${app}\nSRE_ENV_FILE=.env.demo\n`);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('the seal-key helper (round 32 · OB-116)', () => {
  it('writes exactly one hidden value into the file deploy.conf names, keeping everything else, owner and permissions', () => {
    const pack = key();
    writeFileSync(file, `PACK_SIGNING_KEY=${pack}\nOTHER=1`); // no trailing newline: the new line must not be glued on
    chmodSync(file, 0o600);
    const { code, out } = run();
    expect(code, out).toBe(0);
    expect(out).toMatch(/CHECK PASSED/);
    expect(out).not.toContain(pack);
    const text = readFileSync(file, 'utf8');
    expect(text).toMatch(/^PACK_SIGNING_KEY=.+\nOTHER=1\nBOX_HISTORY_SEAL_KEY=.{32,}\n$/);
    const seal = lines()[0]!.split('=').slice(1).join('=');
    expect(out).not.toContain(seal); // the value is never printed
    expect(seal).not.toBe(pack);
    expect((statSync(file).mode & 0o777).toString(8)).toBe('600');
  });

  it('replaces an empty, placeholder, exported or duplicated line with one fresh value', () => {
    writeFileSync(file, `BOX_HISTORY_SEAL_KEY=\nexport BOX_HISTORY_SEAL_KEY=REPLACE_WITH_x\nA=2\n  BOX_HISTORY_SEAL_KEY=${key()}\n`);
    const { code, out } = run();
    expect(code, out).toBe(0);
    expect(out).toMatch(/removed 3 old/);
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatch(/^BOX_HISTORY_SEAL_KEY=.{32,}$/);
    expect(readFileSync(file, 'utf8')).toContain('A=2\n');
  });

  it('stops, changing nothing, when the name is glued into another line', () => {
    const before = `A=xyzBOX_HISTORY_SEAL_KEY=${key()}\n`;
    writeFileSync(file, before);
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toMatch(/STOPPED — .*glued/);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('says NOT FOUND (exit 78) when the file the release reads does not exist', () => {
    const { code, out } = run();
    expect(code).toBe(78);
    expect(out).toMatch(/NOT FOUND — the release reads .*\.env\.demo/);
  });
});
