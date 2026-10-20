import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { SECRET_KEYS } from '../../scripts/lib/store-computer.mjs';

/**
 * Hard rule #4 and OB-244 — the owner's guided store-computer setup (scripts/store-computer.mjs and its engine
 * scripts/lib/store-computer.mjs) never shows a secret, runs no shell, and its settings file and check records never
 * reach the repository.
 *
 *   • no line that says something (say / console / stdout / stderr) names a variable that holds a secret, a secret setting
 *     read from a settings file, or the random source — the tripwire; the unit and integration tests capture every line
 *     and every record and look for each secret in them — the proof;
 *   • no program is started through a shell (`shell: true`), so no value is ever interpolated into a command line;
 *   • infra/compose/.env.real and infra/compose/records/ are git-ignored.
 */

const FILES = ['scripts/store-computer.mjs', 'scripts/lib/store-computer.mjs'];
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
      expect(src.includes('child_process'), f).toBe(f.includes('/lib/'));
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
    for (const step of ['doctor', 'prepare', 'up', 'check --by "Your Name"', '--offline-confirmed', 'recovery-rehearsal.mjs', 'rollback-drill.mjs']) expect(guide).toContain(step);
    expect(readFileSync('docs/runbooks/store-computer-real-data-environment.md', 'utf8')).toContain('docs/runbooks/store-computer-owner-guide-windows.md');
  });

  it('the package script runs the CLI with node — no shell syntax that only works on one system', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['store-computer']).toBe('node scripts/store-computer.mjs');
  });
});
