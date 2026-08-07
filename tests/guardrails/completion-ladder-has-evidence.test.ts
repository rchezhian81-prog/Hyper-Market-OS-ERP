import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

// The completion gate (recovery Phase 2). "Engine implemented and unit-tested" is not "module
// complete." This parses the ASSEMBLY/WIRING module ladder in docs/traceability.md and FAILS the
// build if a module claims WIRED or higher without registered evidence that exists on disk — and
// INTEGRATION TESTED or higher must point at a real integration/e2e test. So an engine-only module
// cannot be labelled complete, and moving a module up the ladder forces adding its proof here.

// Detection order: most-specific first, so "PARTIALLY WIRED" is never mis-read as "WIRED".
const DETECT = [
  'PRODUCTION VERIFIED', 'UAT VERIFIED', 'E2E VERIFIED', 'INTEGRATION TESTED',
  'EXTERNALLY BLOCKED', 'PARTIALLY WIRED', 'ENGINE ONLY', 'NOT STARTED', 'WIRED',
] as const;
const HIGH = new Set<string>(['WIRED', 'INTEGRATION TESTED', 'E2E VERIFIED', 'UAT VERIFIED', 'PRODUCTION VERIFIED']);
const INTEGRATION_PLUS = new Set<string>(['INTEGRATION TESTED', 'E2E VERIFIED', 'UAT VERIFIED', 'PRODUCTION VERIFIED']);

// A module reaches WIRED+ only with registered, existing evidence. INTEGRATION TESTED+ needs a real
// integration/e2e test. Adding a module at a high rung without adding its evidence here fails the gate.
const EVIDENCE: Record<string, string> = {
  M02: 'tests/integration/authorization-is-enforced.test.ts',
  M08: 'tests/integration/inventory-availability.test.ts',
  M12: 'tests/integration/the-shop-reaches-the-cloud.test.ts',
  M26: 'tests/integration/facilities-incidents.test.ts',
  M33: 'tests/integration/setup-surface.test.ts',
};

function statusOf(cell: string): string | undefined {
  const c = cell.replace(/\*/g, '').toUpperCase();
  return DETECT.find((rung) => c.includes(rung));
}

/** Parse the two-modules-per-row ladder into {module, status} pairs. */
export function parseLadder(md: string): { module: string; status: string }[] {
  const lines = md.split('\n');
  const header = lines.findIndex((l) => /^\|\s*M\s*\|\s*Domain\s*\|\s*Status\s*\|\s*M\s*\|/.test(l));
  if (header === -1) return [];
  const out: { module: string; status: string }[] = [];
  for (let i = header + 2; i < lines.length; i++) { // +2 skips the header and the |---| separator
    const line = lines[i] ?? '';
    if (!line.startsWith('| M')) break;
    const cells = line.split('|').map((c) => c.trim());
    for (const [mIdx, sIdx] of [[1, 3], [4, 6]] as const) {
      const module = cells[mIdx] ?? '';
      if (/^M\d+$/.test(module)) {
        const status = statusOf(cells[sIdx] ?? '');
        if (status !== undefined) out.push({ module, status });
      }
    }
  }
  return out;
}

const LADDER = parseLadder(readFileSync('docs/traceability.md', 'utf8'));

describe('the completion ladder cannot claim a rung it has no evidence for', () => {
  it('parses the whole module ladder (sanity: all 36 modules present)', () => {
    expect(new Set(LADDER.map((r) => r.module)).size).toBe(36);
  });

  it('every module at WIRED or higher has registered evidence that exists, integration-grade where the rung demands it', () => {
    const problems: string[] = [];
    for (const { module, status } of LADDER) {
      if (!HIGH.has(status)) continue;
      const evidence = EVIDENCE[module];
      if (evidence === undefined) {
        problems.push(`${module} is "${status}" but registers no evidence in completion-ladder-has-evidence.test.ts`);
        continue;
      }
      if (!existsSync(evidence)) {
        problems.push(`${module} "${status}" points at ${evidence}, which does not exist`);
        continue;
      }
      if (INTEGRATION_PLUS.has(status) && !/^tests\/(integration|e2e)\//.test(evidence)) {
        problems.push(`${module} "${status}" needs an integration/e2e test as evidence; ${evidence} is not one`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('every registered evidence file exists (no stale registry entry)', () => {
    const missing = Object.entries(EVIDENCE).filter(([, file]) => !existsSync(file)).map(([m, f]) => `${m} → ${f}`);
    expect(missing).toEqual([]);
  });

  it('FIRES for a module marked complete with no evidence (tripwire)', () => {
    const md = [
      '| M | Domain | Status | M | Domain | Status |',
      '|---|---|---|---|---|---|',
      '| M99 | Fake | **E2E VERIFIED** | M98 | Fake2 | ENGINE ONLY |',
    ].join('\n');
    const parsed = parseLadder(md);
    expect(parsed.find((p) => p.module === 'M99')?.status).toBe('E2E VERIFIED');
    expect(parsed.find((p) => p.module === 'M98')?.status).toBe('ENGINE ONLY');
    expect(EVIDENCE['M99']).toBeUndefined(); // a real run would flag M99 as unproven
  });
});
