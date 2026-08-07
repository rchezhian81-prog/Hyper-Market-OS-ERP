import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCodeEntries, isBuildArtifact, CODE_DIRS } from './lib/scan.js';

// Hard rule #8 (CLAUDE.md): nothing merges except through a pull request. A pull
// request is only a control if a human can actually READ the diff.
//
// A source file containing a raw control byte — most easily a NUL written straight
// into a template literal as a key separator — is classified as *binary* by git,
// grep, ripgrep, GitHub's diff view and every line-oriented review tool. The file
// still compiles and still runs, but its diff renders as "Binary files differ".
// Anything can then change inside it without a reviewer seeing a single line: a
// price rule, a tenant check, an audit write. That is a silent hole straight
// through the review gate, and it is invisible precisely because everything looks
// green.
//
// This guardrail is therefore not about style. It keeps every shipped source file
// reviewable. The fix is always the same and costs nothing: write the ESCAPE
// (U+0000) instead of the byte.
//
// The scanners in `lib/scan.ts` read files as UTF-8, so a NUL never blinded them —
// this closes the review-visibility hole, not a detection hole.
//
// Unlike the other guardrails this one also polices `tests/` and `scripts/`. Those
// are not shipped, but an unreadable diff in a TEST is worse than one in a module:
// a test is the thing that proves a hard rule still holds, and a weakened assertion
// hidden inside a binary diff would take the proof with it while staying green.

/** Bytes that make a text file read as binary. Tab, LF and CR are text. */
const FORBIDDEN = new Set([...Array(32).keys()].filter((b) => b !== 9 && b !== 10 && b !== 13));

interface Offence {
  readonly file: string;
  readonly line: number;
  readonly byte: string;
}

function findControlBytes(files: readonly string[]): Offence[] {
  const offences: Offence[] = [];
  for (const file of files) {
    const buffer = readFileSync(file);
    for (let i = 0; i < buffer.length; i += 1) {
      const byte = buffer[i]!;
      if (!FORBIDDEN.has(byte)) continue;
      const line = buffer.subarray(0, i).toString('utf8').split('\n').length;
      offences.push({ file, line, byte: `0x${byte.toString(16).padStart(2, '0')}` });
    }
  }
  return offences;
}

/** A fixture written OUTSIDE the repo tree, so the real scan above never sees it. */
function withFixture(name: string, content: string, assert: (path: string) => void): void {
  const path = join(tmpdir(), `sre-guardrail-${name}-${process.pid}.ts`);
  writeFileSync(path, content, 'utf8');
  try {
    assert(path);
  } finally {
    rmSync(path, { force: true });
  }
}

describe('guardrail: shipped source stays reviewable plain text (hard rule #8)', () => {
  it('no source file contains a raw control byte that would make its diff binary', () => {
    const files = loadCodeEntries([...CODE_DIRS, 'tests', 'scripts']).map((e) => e.file);
    // Sanity: the scan surface is real, so a green result is not an empty list —
    // and it reaches the tests as well as the shipped modules.
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.startsWith('tests/'))).toBe(true);
    expect(files.some((f) => f.startsWith('scripts/'))).toBe(true);

    const offences = findControlBytes(files);
    expect(
      offences,
      `${offences.length} raw control byte(s) found. Write the escape instead of the byte, ` +
        `e.g. \\u0000 rather than a literal NUL:\n${JSON.stringify(offences, null, 2)}`,
    ).toEqual([]);
  });

  it('the tripwire fires on a file that does contain one', () => {
    const nul = String.fromCharCode(0);
    withFixture('nul', `const key = \`\${a}${nul}\${b}\`;\n`, (path) => {
      const offences = findControlBytes([path]);
      expect(offences).toHaveLength(1);
      expect(offences[0]?.byte).toBe('0x00');
      expect(offences[0]?.line).toBe(1);
    });
  });

  it('accepts the escape that replaces it, so the rule has a cost-free fix', () => {
    withFixture('escaped', 'const key = `${a}\\u0000${b}`;\n', (path) => {
      expect(findControlBytes([path])).toEqual([]);
    });
  });

  describe('the one exclusion, and how narrow it is', () => {
    // A generated bundle is not source: git-ignored, machine-written, never diffed. Scanning it
    // reports on esbuild's output — it failed this very rule because esbuild emitted a unit-separator
    // ESCAPE, from a reviewed source file, as a literal byte in its own output. It also made the
    // whole suite pass or fail depending on whether somebody had run a build, which is the one
    // thing a guardrail may never do.
    //
    // The exclusion must stay exactly this narrow, so it is pinned here rather than trusted.

    it('excludes a generated bundle and its map', () => {
      expect(isBuildArtifact('pos.bundle.js')).toBe(true);
      expect(isBuildArtifact('web-erp.bundle.js.map')).toBe(true);
    });

    it('still scans the hand-written shell sitting right beside it', () => {
      // `apps/<app>/web/app.js` is source, is reviewed, and is where the interesting rules live.
      expect(isBuildArtifact('app.js')).toBe(false);
      expect(isBuildArtifact('index.html')).toBe(false);
      expect(isBuildArtifact('sw.js')).toBe(false);
      expect(isBuildArtifact('bundle.js')).toBe(false); // not `*.bundle.js`
      expect(isBuildArtifact('my.bundle.js.ts')).toBe(false);
    });

    it('proves it by finding the real shells in the scanned surface', () => {
      // The exclusion is only safe if the files next to it are demonstrably still being read.
      const files = loadCodeEntries(['apps']).map((e) => e.file);
      expect(files).toContain('apps/pos/web/app.js');
      expect(files).toContain('apps/owner-app/web/app.js');
      expect(files).toContain('apps/web-erp/web/app.js');
      expect(files.filter((f) => f.endsWith('.bundle.js'))).toEqual([]);
    });
  });
});
