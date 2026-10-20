import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/**
 * Gap G-RD-7 (OB-244 · OB-246) — the package scripts the owner's Windows guide leads to (`migration:slice`,
 * `tenant:bootstrap`, `migration:load`, `realm:for-shop`, `shop:*`, `demo:smoke`) used to end their build step with
 * `>/dev/null`, which Windows' command shell (the one pnpm runs scripts with there) cannot run. They now ask the build to
 * be quiet itself (`--quiet`), so the only shell syntax left is `&&`, which cmd.exe, PowerShell 7 and sh all run.
 *
 * The proof here has two halves: (1) every such script, read as a string, is `node … && node …` with nothing else a shell
 * would have to interpret; (2) each part is run the way cmd.exe would run it — split on `&&`, each part started as a
 * program with its arguments and NO shell at all, so no `/dev/null` exists for it to lean on — and the build part
 * really runs, quietly, and succeeds. Linux CI is unchanged: `sh` runs the same strings.
 */

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
const TOOL_SCRIPTS = ['migration:load', 'migration:slice', 'tenant:bootstrap', 'realm:for-shop', 'shop:new', 'shop:list', 'shop:features', 'demo:smoke'];
/** Anything a shell would interpret: redirection, pipes, sequencing other than &&, variables, quoting, globbing. */
const SHELL_SYNTAX = /[<>|;$`'"*?(){}\\]|\/dev\/null|\bNUL\b/;

/**
 * Run a package script as Windows' cmd.exe would for `a && b`: each part in turn, as a program with arguments, with no
 * shell, stopping at the first that fails. Refuses a part that needs a shell to mean what it says.
 */
function runWithoutAShell(script: string, run: 'none' | 'first'): { refused?: string; results: { status: number | null; stdout: string; stderr: string }[] } {
  const parts = script.split(' && ');
  const results: { status: number | null; stdout: string; stderr: string }[] = [];
  for (const part of parts) if (SHELL_SYNTAX.test(part)) return { refused: part, results };
  for (const part of run === 'first' ? parts.slice(0, 1) : []) {
    const [cmd, ...args] = part.trim().split(/\s+/);
    const r = spawnSync(cmd === 'node' ? process.execPath : cmd!, args, { encoding: 'utf8', shell: false, timeout: 120_000 });
    results.push({ status: r.status, stdout: r.stdout, stderr: r.stderr });
    if (r.status !== 0) break;
  }
  return { results };
}

describe('the package tool scripts run on Windows (gap G-RD-7)', () => {
  it('no package script uses /dev/null', () => {
    for (const [name, script] of Object.entries(pkg.scripts)) expect(script.includes('/dev/null'), name).toBe(false);
  });

  it('each tool script is exactly "node scripts/build-service.mjs tools --quiet && node scripts/dist/<tool>.js [word]"', () => {
    for (const name of TOOL_SCRIPTS) {
      expect(pkg.scripts[name], name).toMatch(/^node scripts\/build-service\.mjs tools --quiet && node scripts\/dist\/[a-z-]+\.js(?: [a-z]+)?$/);
      expect(runWithoutAShell(pkg.scripts[name]!, 'none').refused, name).toBeUndefined();
    }
  });

  it('the runner with no shell refuses the old form — so a green result means it looked', () => {
    expect(runWithoutAShell('node scripts/build-service.mjs tools >/dev/null && node scripts/dist/migration-slice.js', 'none').refused).toBe('node scripts/build-service.mjs tools >/dev/null');
  });

  it('the build step really runs with no shell, says nothing on standard output with --quiet, and succeeds', () => {
    const { refused, results } = runWithoutAShell(pkg.scripts['migration:slice']!, 'first');
    expect(refused).toBeUndefined();
    expect(results[0]).toMatchObject({ status: 0, stdout: '' });
    // Without --quiet it still says the line (nothing else about the build changed).
    const loud = spawnSync(process.execPath, ['scripts/build-service.mjs', 'tools'], { encoding: 'utf8', shell: false, timeout: 120_000 });
    expect(loud.status).toBe(0);
    expect(loud.stdout).toMatch(/tools bundle written to scripts\/dist\//);
  }, 240_000);
});
