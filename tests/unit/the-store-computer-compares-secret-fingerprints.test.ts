import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  check, demoFingerprintVerdict, fingerprintMatches, fingerprintOf, fingerprints, fingerprintsOf, main, parseCommandLine, prepare, readFingerprintFile,
  FINGERPRINT_KEYS, FINGERPRINT_LABEL,
} from '../../scripts/lib/store-computer.mjs';
import { settingsOf, world, type World } from '../support/store-computer-world';

/**
 * OB-245 — G4 check 3 ("this copy's secrets are not the demo's") signed off by comparing short one-way fingerprints
 * (closes gap G-RD-8). The demo box and the store computer each run `store-computer fingerprints`; the store computer's
 * `check --demo-fingerprints <file>` passes check 3 only when every one of its fingerprints differs from every one of the
 * demo's. A matching fingerprint fails and names the setting; a malformed or empty file is refused, never a pass.
 */

const SECRETS = ['POSTGRES_PASSWORD', 'DATABASE_URL', 'PACK_SIGNING_KEY', 'BOX_HISTORY_SEAL_KEY', 'IDP_SIGNING_KEY'];
const records = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')) : []);

/** The demo box: a Linux checkout with infra/compose/.env.pilot (docs/runbooks/demo-deployment-handover.md) and no .env.real. */
function demoBox(values: Record<string, string>): World {
  const w = world();
  writeFileSync(join(w.root, 'infra', 'compose', '.env.pilot'), `${Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n')}\n`);
  return w;
}
const DEMO = {
  POSTGRES_DB: 'sre_pilot', POSTGRES_PASSWORD: 'd'.repeat(10) + 'e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7', DATABASE_URL: 'postgres://sre_app:demo-password-0123456789abcdef0123@db:5432/sre_pilot',
  PACK_SIGNING_KEY: 'demoPackKey_0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN', BOX_HISTORY_SEAL_KEY: 'demoSealKey_0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN',
  IDP_SIGNING_KEY: 'demoIdpKey_0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO', MIGRATION_TARGET_KIND: 'rehearsal', EDGE_TENANT_ID: '11111111-2222-4333-8444-555555555555',
};

/** Run `fingerprints` on the demo box and return the file it wrote, plus everything it said. */
async function demoFile(values: Record<string, string> = DEMO): Promise<{ file: string; said: string; text: string; w: World }> {
  const w = demoBox(values);
  const out = join(w.root, 'out');
  expect(await main(['fingerprints', '--out', out], w.deps)).toBe(0);
  const [name] = readdirSync(out);
  const file = join(out, name!);
  return { file, said: w.said.join('\n'), text: readFileSync(file, 'utf8'), w };
}

describe('fingerprints — a one-way fingerprint of each secret, never the secret', () => {
  it('is the first 12 hex of SHA-256 over the fixed label, a NUL and the value', () => {
    const v = 'x'.repeat(40);
    expect(fingerprintOf(v)).toBe(createHash('sha256').update(`${FINGERPRINT_LABEL}\0${v}`).digest('hex').slice(0, 12));
    expect(fingerprintOf(v)).toMatch(/^[0-9a-f]{12}$/);
    // Not a plain hash of the value: the label makes it match no hash of the same value made anywhere else.
    expect(createHash('sha256').update(v).digest('hex').startsWith(fingerprintOf(v))).toBe(false);
    expect(FINGERPRINT_KEYS).toEqual(SECRETS);
  });

  it('on the demo box: reads infra/compose/.env.pilot by default, shows names and fingerprints only, and writes a file with no secret', async () => {
    const { said, text } = await demoFile();
    expect(said).toMatch(/^Secret fingerprints from \.env\.pilot on this computer \(Linux\)/m);
    for (const k of SECRETS) expect(said).toMatch(new RegExp(`^ {2}${k} +[0-9a-f]{12}$`, 'm'));
    expect(said).toMatch(/Fingerprint file written: .*fingerprints-2026-10-20T04-30-00-000Z\.json/);
    expect(said).toMatch(/It holds no secret — it is safe to copy to the store computer/);
    const f = JSON.parse(text) as { kind: string; settingsFile: string; fingerprints: Record<string, string> };
    expect(f).toMatchObject({ kind: 'sre-secret-fingerprints', version: 1, label: FINGERPRINT_LABEL, settingsFile: '.env.pilot', computer: 'Linux' });
    expect(Object.keys(f.fingerprints).sort()).toEqual([...SECRETS].sort());
    // The guardrail, on captured output: no value, nor any 12-character piece of one, is anywhere the owner sees or keeps.
    for (const k of SECRETS) {
      const v = DEMO[k as keyof typeof DEMO];
      for (const seen of [said, text]) {
        expect(seen.includes(v), k).toBe(false);
        for (let i = 0; i + 12 <= v.length; i += 4) expect(seen.includes(v.slice(i, i + 12)), `${k} piece`).toBe(false);
      }
    }
  });

  it('on the store computer: reads .env.real by default; never prints a secret prepare made', async () => {
    const w = world();
    expect(await prepare(w.deps)).toBe(0);
    w.said.length = 0;
    expect(await fingerprints(w.deps, {})).toBe(0);
    const s = settingsOf(w);
    const all = [...w.said, ...records(join(w.root, 'infra', 'compose', 'records'))].join('\n');
    expect(all).toMatch(/from \.env\.real/);
    for (const k of SECRETS) {
      expect(all.includes(s[k]!), k).toBe(false);
      expect(all.includes(s[k]!.slice(0, 12)), `${k} start`).toBe(false);
      expect(all).toContain(fingerprintOf(s[k]!));
    }
  });

  it('a value shorter than 32 characters is never fingerprinted (it could be guessed): the file says "too short"', () => {
    const fp = fingerprintsOf({ POSTGRES_PASSWORD: 'short-one', PACK_SIGNING_KEY: 'k'.repeat(32), IDP_SIGNING_KEY: 'REPLACE_WITH_A_GENERATED_VALUE' });
    expect(fp.notFingerprinted).toEqual({ POSTGRES_PASSWORD: 'too short', DATABASE_URL: 'not set', BOX_HISTORY_SEAL_KEY: 'not set', IDP_SIGNING_KEY: 'not set' });
    expect(Object.keys(fp.fingerprints)).toEqual(['PACK_SIGNING_KEY']);
  });

  it('refuses: no settings file; both .env.real and .env.pilot here; a production box; a file with none of the secrets', async () => {
    const none = world();
    expect(await fingerprints(none.deps, {})).toBe(2);
    expect(none.said[0]).toMatch(/REFUSED — there is no \.env\.real .* or \.env\.pilot/);
    const both = demoBox(DEMO);
    writeFileSync(join(both.root, 'infra', 'compose', '.env.real'), 'POSTGRES_DB=sre_real\n');
    expect(await fingerprints(both.deps, {})).toBe(2);
    expect(both.said[0]).toMatch(/both \.env\.real and \.env\.pilot/);
    const prod = demoBox({ ...DEMO, MIGRATION_TARGET_KIND: 'production' });
    expect(await fingerprints(prod.deps, {})).toBe(2);
    expect(prod.said[0]).toMatch(/never works on a production box/);
    const empty = demoBox({ POSTGRES_DB: 'x' });
    expect(await fingerprints(empty.deps, {})).toBe(2);
    expect(empty.said[0]).toMatch(/holds none of the secrets/);
    for (const w of [none, both, prod, empty]) expect(existsSync(join(w.root, 'infra', 'compose', 'records'))).toBe(false);
  });

  it('--settings names the file; every run writes a NEW file, never overwriting one', async () => {
    const w = demoBox(DEMO);
    const other = join(w.root, 'elsewhere.env');
    writeFileSync(other, `PACK_SIGNING_KEY=${'p'.repeat(40)}\n`);
    const out = join(w.root, 'fp');
    expect(await fingerprints(w.deps, { settings: other, out })).toBe(0);
    expect(await fingerprints(w.deps, { settings: other, out })).toBe(0);
    expect(readdirSync(out).sort()).toEqual(['fingerprints-2026-10-20T04-30-00-000Z-2.json', 'fingerprints-2026-10-20T04-30-00-000Z.json']);
    expect(w.said.join('\n')).toMatch(/from elsewhere\.env/);
    expect(parseCommandLine(['fingerprints', '--settings', 'x', '--out', 'y'])).toMatchObject({ command: 'fingerprints', settings: 'x', out: 'y', problems: [] });
  });
});

describe('check 3 by fingerprints — --demo-fingerprints <file>', () => {
  const prepared = async (): Promise<World> => { const w = world(); expect(await prepare(w.deps)).toBe(0); w.said.length = 0; w.calls.length = 0; return w; };
  const result3 = (w: World, dir = join(w.root, 'infra', 'compose', 'records')): { result: string; detail: string } => {
    const rec = JSON.parse(records(dir).at(-1)!) as { results: { n: number; result: string; detail: string }[] };
    return rec.results.find((r) => r.n === 3)!;
  };

  it('with no file it stays NEEDS-YOU, and now says how to sign it off', async () => {
    const w = await prepared();
    await check(w.deps, { by: 'Owner' });
    expect(result3(w)).toMatchObject({ result: 'NEEDS-YOU', detail: expect.stringMatching(/--demo-fingerprints/) });
  });

  it('PASSES when every one of this copy\'s fingerprints differs from every one of the demo\'s — and the record names the file', async () => {
    const { file } = await demoFile();
    const w = await prepared();
    await check(w.deps, { by: 'Owner', demoFingerprints: file });
    expect(result3(w)).toMatchObject({ result: 'PASS', detail: expect.stringMatching(/^all 5 of this copy's secret fingerprints differ from all 5 of the demo's/) });
    const rec = JSON.parse(records(join(w.root, 'infra', 'compose', 'records')).at(-1)!) as Record<string, unknown>;
    expect(rec['demoFingerprintFile']).toMatch(/^fingerprints-.*\.json$/);
  });

  it('FAILS and names the setting when one fingerprint matches — even across names (the demo\'s pack key reused as this copy\'s seal key)', async () => {
    const w = await prepared();
    const s = settingsOf(w);
    const { file } = await demoFile({ ...DEMO, PACK_SIGNING_KEY: s['BOX_HISTORY_SEAL_KEY']! });
    await check(w.deps, { by: 'Owner', demoFingerprints: file });
    const r = result3(w);
    expect(r.result).toBe('FAIL');
    expect(r.detail).toMatch(/this copy's BOX_HISTORY_SEAL_KEY has the same fingerprint as the demo's PACK_SIGNING_KEY/);
    expect(w.said.join('\n').includes(s['BOX_HISTORY_SEAL_KEY']!)).toBe(false);
    // The pure comparison: any of ours against any of theirs.
    expect(fingerprintMatches({ A: 'aaaaaaaaaaaa', B: 'bbbbbbbbbbbb' }, { X: 'bbbbbbbbbbbb' })).toEqual([{ own: 'B', demo: 'X' }]);
  });

  it('a malformed, empty, cut-short or foreign file is REFUSED — never a pass', () => {
    const s = { POSTGRES_PASSWORD: 'a'.repeat(48), DATABASE_URL: `postgres://u:${'a'.repeat(48)}@db/x`, PACK_SIGNING_KEY: 'b'.repeat(64), BOX_HISTORY_SEAL_KEY: 'c'.repeat(64), IDP_SIGNING_KEY: 'd'.repeat(64) };
    const good = { kind: 'sre-secret-fingerprints', version: 1, label: FINGERPRINT_LABEL, settingsFile: '.env.pilot', fingerprints: Object.fromEntries(SECRETS.map((k, i) => [k, `${i}`.repeat(12)])), notFingerprinted: {} };
    expect(demoFingerprintVerdict(s, JSON.stringify(good)).status).toBe('PASS');
    const bad: [string, RegExp][] = [
      ['', /could not be read as one/],
      ['not json at all', /could not be read as one/],
      ['[]', /not a fingerprint file/],
      ['{}', /not a fingerprint file written by/],
      [JSON.stringify({ ...good, label: 'other' }), /different fingerprint label/],
      [JSON.stringify({ ...good, fingerprints: {}, notFingerprinted: Object.fromEntries(SECRETS.map((k) => [k, 'not set'])) }), /holds no fingerprint at all/],
      [JSON.stringify({ ...good, fingerprints: { ...good.fingerprints, POSTGRES_PASSWORD: 'XYZ' } }), /not 12 hex characters/],
      [JSON.stringify({ ...good, fingerprints: { PACK_SIGNING_KEY: 'abcdefabcdef' } }), /says nothing about .* cut short/],
      [JSON.stringify({ ...good, fingerprints: { ...good.fingerprints, OTHER: 'abcdefabcdef' } }), /does not know \(OTHER\)/],
      [JSON.stringify({ ...good, notFingerprinted: { PACK_SIGNING_KEY: 'too short' } }), /malformed/],
      [JSON.stringify({ ...good, settingsFile: '.env.real' }), /made from a store computer's \.env\.real/],
    ];
    for (const [text, why] of bad) {
      const v = demoFingerprintVerdict(s, text);
      expect(v.status, text).toBe('FAIL');
      expect(v.detail, text).toMatch(/^REFUSED the demo fingerprint file — /);
      expect(v.detail, text).toMatch(why);
    }
    expect(readFingerprintFile(JSON.stringify(good)).ok).toBe(true);
  });

  it('a file that cannot be read fails check 3; a demo value "too short" cannot equal this copy\'s (all 32+) and is said so', async () => {
    const w = await prepared();
    await check(w.deps, { by: 'Owner', demoFingerprints: join(w.root, 'no-such-file.json') });
    expect(result3(w)).toMatchObject({ result: 'FAIL', detail: expect.stringMatching(/could not be read/) });
    const { file } = await demoFile({ ...DEMO, POSTGRES_PASSWORD: 'demo-pw' });
    const second = join(w.root, 'second');
    await check(w.deps, { by: 'Owner', demoFingerprints: file, out: second });
    expect(result3(w, second)).toMatchObject({ result: 'PASS', detail: expect.stringMatching(/the demo's POSTGRES_PASSWORD is shorter than any of this copy's/) });
  });

  it('with the cable unplugged, a restore-checked backup on the owner\'s drive and the demo\'s fingerprints, the tool alone reports G4 PASSED', async () => {
    const { file } = await demoFile();
    const w = await prepared();
    const drive = join(w.root, '..', `drive-${Date.now()}`);
    mkdirSync(drive, { recursive: true });
    const record = join(drive, 'restore-check-x.json');
    writeFileSync(record, JSON.stringify({ kind: 'store-computer-restore-check', outcome: 'restored_and_reconciled', offsiteDir: 'ignored-the-real-folder-is-used' }));
    expect(await check(w.deps, { by: 'Owner', offlineConfirmed: true, demoFingerprints: file, backupRecord: record })).toBe(0);
    expect(w.said.join('\n')).toMatch(/^G4 PASSED — all ten isolation checks pass\.$/m);
  });

  it('the command line takes --demo-fingerprints', () => {
    expect(parseCommandLine(['check', '--by', 'O', '--demo-fingerprints', 'C:\\SRE-demo\\f.json'])).toMatchObject({ demoFingerprints: 'C:\\SRE-demo\\f.json', problems: [] });
    expect(parseCommandLine(['check', '--demo-fingerprints'])).toMatchObject({ problems: ['--demo-fingerprints needs a value'] });
  });
});
