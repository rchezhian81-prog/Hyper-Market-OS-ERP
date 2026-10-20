import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SECRET_KEYS } from '../../scripts/lib/store-computer.mjs';

/**
 * Hard rule #4 and OB-244 · OB-245 · OB-246 — the owner's guided store-computer setup (scripts/store-computer.mjs and its
 * engine scripts/lib/store-computer.mjs, with the backup, restore-check and drill in scripts/lib/store-computer-recovery.mjs)
 * never shows a secret, runs no shell, never restores into the real database, and its settings file and check records
 * never reach the repository.
 *
 *   • no line that says something (say / console / stdout / stderr) names a variable that holds a secret, a secret setting
 *     read from a settings file, or the random source — the tripwire; the unit and integration tests capture every line
 *     and every record and look for each secret in them — the proof;
 *   • no program is started through a shell (`shell: true`), so no value is ever interpolated into a command line;
 *   • infra/compose/.env.real and infra/compose/records/ are git-ignored.
 */

const FILES = ['scripts/store-computer.mjs', 'scripts/lib/store-computer.mjs', 'scripts/lib/store-computer-recovery.mjs'];
const OUTPUT = /\b(?:say|console\.\w+|process\.std(?:out|err)\.write|deps\.say)\s*\(/;

/** Lines that output something AND name a secret holder. String contents are blanked first, so prose cannot trip it. */
export function secretOutputLines(source: string): string[] {
  const holders = new RegExp(`\\b(?:planned|secretValues|secrets?)\\b|\\.random\\(|randomBytes|\\b(?:settings|s|copied|values|env)(?:\\.|\\[['"])(?:${SECRET_KEYS.join('|')})\\b`);
  return source.split('\n').filter((line) => {
    if (!OUTPUT.test(line)) return false;
    // Blank quoted text but keep template-literal ${…} expressions, which is where a value would be interpolated.
    const code = line
      .replace(/\[['"]([A-Z_]+)['"]\]/g, '.$1') // settings['KEY'] reads as settings.KEY
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/`(?:[^`\\]|\\.)*`/g, (t) => (t.match(/\$\{[^}]*\}/g) ?? []).join(' '));
    return holders.test(code);
  });
}

/** A shell, or child_process's shell-running helpers (`exec`, `execSync` — not a RegExp's `.exec(`). */
const shellLines = (source: string): string[] => source.split('\n').filter((l) => /\bshell\s*:\s*true\b/.test(l) || /(?<![.\w])exec(?:Sync)?\s*\(/.test(l));

describe('the store-computer setup never shows a secret (hard rule #4 · OB-244)', () => {
  it('no output line names a secret holder, a secret setting or the random source', () => {
    for (const f of FILES) expect(secretOutputLines(readFileSync(f, 'utf8')), f).toEqual([]);
  });

  it('the tripwire fires on known-bad lines (so a green result means it looked)', () => {
    const bad = [
      "  say(`Your key: ${planned.PACK_SIGNING_KEY}`);",
      '  console.log(settings.IDP_SIGNING_KEY);',
      "  deps.say('password ' + settings['POSTGRES_PASSWORD']);",
      '  process.stdout.write(randomBytes(32).toString("hex"));',
      '  say(`${secretValues}`);',
    ].join('\n');
    expect(secretOutputLines(bad)).toHaveLength(5);
    // Prose about secrets, and the names of the settings, are fine.
    expect(secretOutputLines("  say('Filled in (names only — the values are never shown):');\n  say(`  ${key}`);")).toEqual([]);
  });

  it('starts every program with an argument array and no shell', () => {
    for (const f of FILES) {
      const src = readFileSync(f, 'utf8');
      expect(shellLines(src), f).toEqual([]);
      // Only the engine starts programs (through deps.spawn); the command-line shell and the recovery module never do.
      expect(src.includes('child_process'), f).toBe(f === 'scripts/lib/store-computer.mjs');
    }
    expect(readFileSync('scripts/lib/store-computer.mjs', 'utf8')).toMatch(/\.\.\.opts, shell: false \}\)/);
    expect(shellLines("spawnSync('docker', args, { shell: true })")).toHaveLength(1);
  });

  it('the settings file and the check records are git-ignored', () => {
    for (const p of ['infra/compose/.env.real', 'infra/compose/records/g4-check-2026-10-20T04-30-00-000Z.json']) {
      const r = spawnSync('git', ['check-ignore', '-q', p], { encoding: 'utf8' });
      expect(r.status, `${p} must be git-ignored`).toBe(0);
    }
    // And the example the copy is made from is NOT ignored (it is the committed template).
    expect(spawnSync('git', ['check-ignore', '-q', 'infra/compose/.env.example']).status).toBe(1);
  });

  it('the owner\'s Windows guide holds no address and no secret, warns about the settings file, and is linked from the OB-240 runbook', () => {
    const guide = readFileSync('docs/runbooks/store-computer-owner-guide-windows.md', 'utf8');
    expect(guide).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/); // no IP address
    expect(guide).not.toMatch(/https?:\/\//); // no URL to ping or paste — official sites are named, not linked
    expect(guide).not.toMatch(/[A-Za-z0-9_-]{40,}/); // nothing shaped like a key or a token
    expect(guide).toMatch(/Never send a photo of the file `\.env\.real`/);
    expect(guide).toMatch(/A Tamil version can come later/);
    for (const step of ['doctor', 'prepare', 'up', 'check --by "Your Name"', '--offline-confirmed', 'fingerprints', '--demo-fingerprints', 'backup --to', 'restore-check --from', 'drill --by "Your Name"', '--run', '--backup-record']) expect(guide).toContain(step);
    // The demo box steps: signed in with the owner's own login, run as the deploy user, never an address or a key.
    expect(guide).toMatch(/sudo -u deploy node scripts\/store-computer\.mjs fingerprints/);
    expect(guide).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY|ssh-rsa|ssh-ed25519 AAAA/);
    // The old Windows backup by hand (PostgreSQL tools on the PC, addresses read into PowerShell) is gone.
    expect(guide).not.toMatch(/RESTORE_TARGET_URL|ConvertFrom-StringData|Command Line Tools/);
    expect(readFileSync('docs/runbooks/store-computer-real-data-environment.md', 'utf8')).toContain('docs/runbooks/store-computer-owner-guide-windows.md');
  });

  it('the package script runs the CLI with node — no shell syntax that only works on one system', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['store-computer']).toBe('node scripts/store-computer.mjs');
  });

  it('the fingerprint output never contains a secret — captured from the real command, run as a separate program', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sre-fp-guardrail-'));
    const values = {
      POSTGRES_PASSWORD: '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a6978', DATABASE_URL: 'postgres://sre_app:0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a6978@db:5432/sre_pilot',
      PACK_SIGNING_KEY: 'Zx9_PackKeyValueThatMustNeverBeShown_0123456789abcdefABCDEFGHIJ', BOX_HISTORY_SEAL_KEY: 'Qw8-SealKeyValueThatMustNeverBeShown_0123456789abcdefABCDEFGHIJ',
      IDP_SIGNING_KEY: 'Er7_IdpKeyValueThatMustNeverBeShown__0123456789abcdefABCDEFGHIJ',
    };
    const settings = join(dir, '.env.pilot');
    writeFileSync(settings, `${Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n')}\nMIGRATION_TARGET_KIND=rehearsal\n`);
    const out = join(dir, 'out');
    const r = spawnSync(process.execPath, ['scripts/store-computer.mjs', 'fingerprints', '--settings', settings, '--out', out], { encoding: 'utf8', shell: false });
    expect(r.status, r.stderr).toBe(0);
    const files = readdirSync(out);
    expect(files).toHaveLength(1);
    const everything = [r.stdout, r.stderr, readFileSync(join(out, files[0]!), 'utf8')].join('\n');
    expect(everything).toMatch(/PACK_SIGNING_KEY +[0-9a-f]{12}/);
    for (const [k, v] of Object.entries(values)) {
      expect(everything.includes(v), k).toBe(false);
      // Not even a 10-character piece of a value (the hex fingerprints are 12 characters of a hash, not of the value).
      for (let i = 0; i + 10 <= v.length; i += 1) expect(everything.includes(v.slice(i, i + 10)), `${k} piece ${v.slice(i, i + 10)}`).toBe(false);
    }
  });

  it('restore-check never targets the real database: every restore, CREATE and DROP goes through assertScratch', () => {
    const src = readFileSync('scripts/lib/store-computer-recovery.mjs', 'utf8');
    const risky = src.split('\n').filter((l) => /'pg_restore'|CREATE DATABASE|DROP DATABASE/.test(l) && !/^\s*(\/\/|\*)/.test(l));
    expect(risky.length).toBeGreaterThanOrEqual(3);
    for (const l of risky) expect(l, l).toMatch(/assertScratch\(scratch, ctx\.settings\)/);
    // The scratch rule itself: only sre_restore_check_<14 digits>, never the copy's own database.
    expect(src).toMatch(/const SCRATCH = \/\^sre_restore_check_\\d\{14\}/);
    expect(src).not.toMatch(/--clean|--if-exists|DROP DATABASE IF EXISTS|WITH \(FORCE\)/);
    // pg_restore runs only inside this copy's own db container, through dbExec (never a bare pg_restore on the computer).
    expect(src).toMatch(/dbExec\('pg_restore'/);
  });
});
