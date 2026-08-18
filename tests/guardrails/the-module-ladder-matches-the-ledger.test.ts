import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Phase 1 — requirements/traceability closure.
//
// docs/traceability.md carries an ASSEMBLY/WIRING "module ladder" — one maturity rung per module
// M01–M36 — AND a module-level summary count. docs/completion-status.json carries the authoritative
// per-module maturity label the completion % is computed from. Until now NOTHING held the two together,
// and they silently drifted: the ladder claimed M18 substitution and M28 write-off were "engine-only"
// long after both were wired, while the ledger had moved on. The family table is already
// derive-and-checked; this does the same for the module ladder, so a rung stated in the RTM can never
// again contradict the number the owner is shown.
//
// Scope note: this checks the module ladder's *rung* and the summary *counts* against the ledger. The
// free-text detail inside each ladder cell is human prose and is not machine-policed here; keeping the
// rung locked is what prevents the completion-% surface from drifting.

const ROOT = process.cwd();
const RTM = readFileSync(join(ROOT, 'docs', 'traceability.md'), 'utf8');
const LEDGER = JSON.parse(readFileSync(join(ROOT, 'docs', 'completion-status.json'), 'utf8')) as {
  items: readonly { id: string; label: string }[];
};

// Spaced ladder phrase -> underscored ledger label. Ordered longest/most-specific first so a
// `startsWith` test matches "PARTIALLY WIRED" before the bare "WIRED".
const RUNGS: readonly (readonly [string, string])[] = [
  ['PRODUCTION VERIFIED', 'PRODUCTION_VERIFIED'],
  ['UAT VERIFIED', 'UAT_VERIFIED'],
  ['E2E VERIFIED', 'E2E_VERIFIED'],
  ['INTEGRATION TESTED', 'INTEGRATION_TESTED'],
  ['PARTIALLY WIRED', 'PARTIALLY_WIRED'],
  ['ENGINE ONLY', 'ENGINE_ONLY'],
  ['NOT STARTED', 'NOT_STARTED'],
  ['WIRED', 'WIRED'],
];

// Reduce a ladder status cell (which may be bold and carry a parenthetical) to its ledger label.
const rungOf = (cell: string): string | undefined => {
  const head = cell.replace(/\*/g, '').split('(')[0]!.trim(); // strip bold, drop the "(detail)"
  const hit = RUNGS.find(([phrase]) => head.startsWith(phrase));
  return hit?.[1];
};

// Parse the module ladder into { M## -> rung }. The table header is
// `| M | Domain | Status | M | Domain | Status |` — two module entries per row.
const parseLadder = (): Map<string, string> => {
  const lines = RTM.split('\n');
  const header = lines.findIndex((l) => /^\|\s*M\s*\|\s*Domain\s*\|\s*Status\s*\|\s*M\s*\|\s*Domain\s*\|\s*Status\s*\|/.test(l));
  expect(header, 'the module-ladder table header must exist in docs/traceability.md').toBeGreaterThan(-1);
  const out = new Map<string, string>();
  for (let i = header + 2; i < lines.length; i++) { // +2 skips the |---| separator row
    const line = lines[i]!;
    if (!line.trimStart().startsWith('|')) break; // table ended
    const cells = line.split('|').map((c) => c.trim());
    // cells[0] and last are the empty edges; module entries are (1,3) and (4,6).
    for (const [idIdx, statusIdx] of [[1, 3], [4, 6]] as const) {
      const id = cells[idIdx];
      if (!id || !/^M\d\d$/.test(id)) continue;
      const rung = rungOf(cells[statusIdx] ?? '');
      expect(rung, `module ${id}: ladder status "${cells[statusIdx]}" is not a recognised maturity rung`).toBeDefined();
      expect(out.has(id), `module ${id} appears more than once in the ladder`).toBe(false);
      out.set(id, rung!);
    }
  }
  return out;
};

const ladderByModule = parseLadder();
const ledgerByModule = new Map(
  LEDGER.items.filter((i) => /^M\d\d$/.test(i.id)).map((i) => [i.id, i.label] as const),
);

describe('the module ladder matches the ledger (no silent drift)', () => {
  it('the ladder carries every module M01–M36 exactly once', () => {
    const expected = Array.from({ length: 36 }, (_, i) => `M${String(i + 1).padStart(2, '0')}`);
    expect([...ladderByModule.keys()].sort()).toEqual(expected);
  });

  it('every module ladder rung equals its completion-status.json label', () => {
    const mismatches: string[] = [];
    for (const [id, rung] of ladderByModule) {
      const label = ledgerByModule.get(id);
      if (label !== rung) mismatches.push(`${id}: ladder=${rung} ledger=${label}`);
    }
    expect(mismatches).toEqual([]);
  });

  it('the module-level summary line states the counts derived from the ladder', () => {
    // Derive the rung distribution from the ladder itself.
    const derived = new Map<string, number>();
    for (const rung of ladderByModule.values()) derived.set(rung, (derived.get(rung) ?? 0) + 1);

    const summaryLine = RTM.split('\n').find((l) => l.includes('**Summary (module level, 36):**'));
    expect(summaryLine, 'the module ladder must carry a "**Summary (module level, 36):**" line').toBeDefined();

    // Read "<n> <PHRASE>" pairs off the summary; PARTIALLY WIRED is matched before WIRED.
    const stated = new Map<string, number>();
    const re = /(\d+)\s+(PRODUCTION VERIFIED|UAT VERIFIED|E2E VERIFIED|INTEGRATION TESTED|PARTIALLY WIRED|ENGINE ONLY|NOT STARTED|WIRED)/g;
    for (const m of summaryLine!.matchAll(re)) {
      const label = RUNGS.find(([phrase]) => phrase === m[2])![1];
      stated.set(label, Number(m[1]));
    }

    // The summary must state a count for every rung the ladder actually uses, and the numbers must match.
    for (const [rung, count] of derived) {
      expect(stated.get(rung), `summary omits or miscounts ${rung}`).toBe(count);
    }
    // And the stated counts must sum to 36 (no phantom rungs inflating the total).
    expect([...stated.values()].reduce((a, b) => a + b, 0)).toBe(36);
  });
});
