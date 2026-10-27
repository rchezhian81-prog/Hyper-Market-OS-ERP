import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * **B15 (COTPA 2003 s.5 and s.6; owner decision D3, 11 Aug 2026, R2) — the physical tobacco warning board stays on the
 * store's go-live checklist.**
 *
 * The software half of B15 (tobacco is never promoted on any surface) is built and tested. The other half is a board on
 * the shop wall, at least 60 × 30 cm, which no software test can prove. The 27 Oct 2026 re-audit found it on no go-live
 * checklist at all — only in STATUS notes, which roll over. This guardrail keeps it on the walk-through the owner ticks
 * off before the pilot, as an unticked line with its size, its law and a person, so it cannot silently drop off.
 */

const CHECKLIST = readFileSync('docs/runbooks/store-go-live-checklist.md', 'utf8');

/** The checklist line (and its continuation lines) that carries the B15 board. */
function boardLine(): string {
  const lines = CHECKLIST.split('\n');
  const at = lines.findIndex((l) => /^- \[[ x]\] \*\*Tobacco warning board \(B15\)\.\*\*/.test(l));
  if (at < 0) return '';
  const item = [lines[at]!];
  for (let i = at + 1; i < lines.length && /^\s{2,}\S/.test(lines[i]!); i += 1) item.push(lines[i]!);
  return item.join(' ');
}

describe('B15 — the tobacco warning board is on the store go-live checklist', () => {
  it('is a checklist line of its own, not yet ticked, with its minimum size and a responsible person', () => {
    const line = boardLine();
    expect(line, 'the "Tobacco warning board (B15)" line is missing from docs/runbooks/store-go-live-checklist.md').not.toBe('');
    // Unticked: the board is physical, so nobody may tick it in the repository on the shop's behalf.
    expect(line.startsWith('- [ ] ')).toBe(true);
    expect(line).toContain('**at least 60 × 30 cm**');
    expect(line).toMatch(/\*\*Owner\.\*\*/);
  });

  it('names the law it comes from and sits in set-up, before the pilot starts', () => {
    expect(CHECKLIST).toMatch(/B15, COTPA 2003 sections 5 and 6/);
    const board = CHECKLIST.indexOf('**Tobacco warning board (B15).**');
    const phase1 = CHECKLIST.indexOf('## Phase 1');
    const phase2 = CHECKLIST.indexOf('## Phase 2');
    expect(phase1).toBeGreaterThan(-1);
    expect(board).toBeGreaterThan(phase1);
    expect(board).toBeLessThan(phase2);
  });
});
