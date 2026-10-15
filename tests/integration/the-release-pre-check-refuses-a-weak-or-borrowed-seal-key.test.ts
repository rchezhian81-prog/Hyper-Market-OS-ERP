import { describe, it, expect, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
// @ts-expect-error — plain .mjs script module, imported for its pure helpers (no types file needed).
import { findUnsetSettings, SEAL_KEY_MIN_LENGTH } from '../../scripts/standup-check.mjs';

/**
 * **Round 33 (verifier r32 notes 2a, 2b — Low)** — the release's pre-check (`node scripts/standup-check.mjs --settings-only`,
 * run by infra/deploy/release.sh before anything is rebuilt) refuses the same BOX_HISTORY_SEAL_KEY the API refuses at start:
 * missing, the placeholder, shorter than 32 characters, or the same as PACK_SIGNING_KEY, PII_KEY_ENCRYPTION_KEY or
 * IDP_SIGNING_KEY — naming the setting, NEVER printing a value. A box with only a till's settings file and no head-office one is
 * refused too, naming the missing head-office file. The real script is run on synthetic settings files; every key is made at
 * run time.
 */

const dir = mkdtempSync(join(tmpdir(), 'sre-r33-precheck-'));
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
const key = (): string => randomBytes(36).toString('base64');
const P = key();
const I = key();
const X = key();
const H = key();
const base = { POSTGRES_PASSWORD: key(), DATABASE_URL: 'postgres://app@db/sre', PACK_SIGNING_KEY: P, IDP_SIGNING_KEY: I, PII_KEY_ENCRYPTION_KEY: X, IDP_ISSUER: 'https://idp.example', EDGE_TENANT_ID: 't-sre' };
const file = (name: string, env: Record<string, string>): string => {
  const f = join(dir, name);
  writeFileSync(f, Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  return f;
};
const run = (envFile: string, tillFile = join(dir, 'no-till.env')) => {
  const r = spawnSync('node', ['scripts/standup-check.mjs', '--settings-only'], { env: { ...process.env, STANDUP_ENV_FILE: envFile, TILL_ENV_FILE: tillFile }, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};
const secrets = [P, I, X, H];

describe('round 33: the release pre-check refuses a weak or borrowed seal key, and a box with only a till', () => {
  it('names each refusal (never a value); a good key passes', () => {
    const short = randomBytes(12).toString('hex').slice(0, SEAL_KEY_MIN_LENGTH - 1);
    const cases: [string, Record<string, string>, RegExp | null][] = [
      ['ok', { ...base, BOX_HISTORY_SEAL_KEY: H }, null],
      ['short', { ...base, BOX_HISTORY_SEAL_KEY: short }, /BOX_HISTORY_SEAL_KEY \(it is shorter than 32 characters/],
      ['same-as-idp', { ...base, BOX_HISTORY_SEAL_KEY: I }, /BOX_HISTORY_SEAL_KEY \(it is the same as IDP_SIGNING_KEY/],
      ['same-as-pii', { ...base, BOX_HISTORY_SEAL_KEY: X }, /BOX_HISTORY_SEAL_KEY \(it is the same as PII_KEY_ENCRYPTION_KEY/],
      ['same-as-pack', { ...base, BOX_HISTORY_SEAL_KEY: P }, /BOX_HISTORY_SEAL_KEY \(it is the same as PACK_SIGNING_KEY, which every store computer holds/],
      ['missing', { ...base }, /BOX_HISTORY_SEAL_KEY \(head office would refuse to start/],
    ];
    for (const [name, env, refusal] of cases) {
      const r = run(file(`env.${name}`, env));
      expect(r.status, `${name}: ${r.out}`).toBe(refusal === null ? 0 : 1);
      if (refusal !== null) expect(r.out, name).toMatch(refusal);
      for (const s of [...secrets, short]) expect(r.out.includes(s), `${name} printed a value`).toBe(false);
    }
  });

  it('the pure check agrees with the API\'s own refusals (length and the three other keys)', () => {
    expect(findUnsetSettings({ ...base, BOX_HISTORY_SEAL_KEY: H })).toEqual([]);
    expect(findUnsetSettings({ ...base, BOX_HISTORY_SEAL_KEY: 'x'.repeat(SEAL_KEY_MIN_LENGTH) })).toEqual([]);
    expect(findUnsetSettings({ ...base, BOX_HISTORY_SEAL_KEY: 'x'.repeat(SEAL_KEY_MIN_LENGTH - 1) }).map((f: { key: string }) => f.key)).toEqual(['BOX_HISTORY_SEAL_KEY']);
  });

  it('a box with only a till\'s settings file is refused for a release, naming the missing head-office file', () => {
    mkdirSync(join(dir, 'till'), { recursive: true });
    const till = join(dir, 'till', 'till.env');
    writeFileSync(till, 'EDGE_TENANT_ID=t-sre\n');
    const missing = join(dir, 'no-head-office.env');
    const r = run(missing, till);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/no head-office settings file at .*no-head-office\.env — this box has only a till's settings file/);
    // With neither file it is refused as before.
    expect(run(missing).status).toBe(1);
  });
});
