import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Phase 1 — requirements/traceability closure.
//
// The completion denominator is 104 controlling items: 36 modules + 68 non-module items
// (D01–D14, A01–A10, WF-01..20, QG-01..12, MG-01..12). The module FRs are traced in detail in
// docs/traceability.md; the 68 non-module items had NO presence there — 20 of them appeared nowhere
// in the file at all — so a reader of the RTM could not see two-thirds of the denominator. The RTM now
// carries a "Non-module controlling requirements" section mirroring the ledger. This guardrail keeps
// that mirror honest: the section must list EXACTLY the 68 non-module controlling IDs, each with a
// status that equals its docs/completion-status.json label. It can never silently drift from the number
// the owner is shown.

const ROOT = process.cwd();
const RTM = readFileSync(join(ROOT, 'docs', 'traceability.md'), 'utf8');
const LEDGER = JSON.parse(readFileSync(join(ROOT, 'docs', 'completion-status.json'), 'utf8')) as {
  items: readonly { id: string; label: string }[];
};

const SPACED_TO_LABEL: Record<string, string> = {
  'PRODUCTION VERIFIED': 'PRODUCTION_VERIFIED',
  'UAT VERIFIED': 'UAT_VERIFIED',
  'E2E VERIFIED': 'E2E_VERIFIED',
  'INTEGRATION TESTED': 'INTEGRATION_TESTED',
  'PARTIALLY WIRED': 'PARTIALLY_WIRED',
  'ENGINE ONLY': 'ENGINE_ONLY',
  'NOT STARTED': 'NOT_STARTED',
  WIRED: 'WIRED',
};

// The fixed set of non-module controlling IDs (the 68 that are NOT M01–M36).
const EXPECTED_IDS: string[] = [
  ...Array.from({ length: 14 }, (_, i) => `D${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 10 }, (_, i) => `A${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 20 }, (_, i) => `WF-${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 12 }, (_, i) => `QG-${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 12 }, (_, i) => `MG-${String(i + 1).padStart(2, '0')}`),
];

// Extract the mirror section (from its header to the next "## ") and parse its "| ID | name | status |" rows.
const parseMirror = (): Map<string, string> => {
  const start = RTM.indexOf('## Non-module controlling requirements');
  expect(start, 'the RTM must carry a "## Non-module controlling requirements" section').toBeGreaterThan(-1);
  const rest = RTM.slice(start + 1);
  const end = rest.indexOf('\n## ');
  const section = end === -1 ? rest : rest.slice(0, end);

  const out = new Map<string, string>();
  for (const line of section.split('\n')) {
    const m = /^\|\s*(D\d\d|A\d\d|WF-\d\d|QG-\d\d|MG-\d\d)\s*\|[^|]*\|\s*([^|]+?)\s*\|/.exec(line);
    if (!m) continue;
    const id = m[1]!;
    const spaced = m[2]!.replace(/\*/g, '').trim();
    const label = SPACED_TO_LABEL[spaced];
    expect(label, `${id}: "${spaced}" is not a recognised maturity rung`).toBeDefined();
    expect(out.has(id), `${id} appears more than once in the mirror`).toBe(false);
    out.set(id, label!);
  }
  return out;
};

const mirror = parseMirror();
const ledgerLabel = new Map(LEDGER.items.map((i) => [i.id, i.label] as const));

describe('the non-module requirements mirror the ledger (no silent gap, no drift)', () => {
  it('lists exactly the 68 non-module controlling IDs — the 20 once-invisible ones included', () => {
    expect([...mirror.keys()].sort()).toEqual([...EXPECTED_IDS].sort());
  });

  it('every mirrored status equals its completion-status.json label', () => {
    const mismatches: string[] = [];
    for (const [id, rung] of mirror) {
      const label = ledgerLabel.get(id);
      if (label !== rung) mismatches.push(`${id}: RTM=${rung} ledger=${label}`);
    }
    expect(mismatches).toEqual([]);
  });
});
