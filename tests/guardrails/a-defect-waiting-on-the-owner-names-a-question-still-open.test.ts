import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The defects register says when a defect waits on an owner question. Once the owner has answered (the decision's row in
 * docs/registers/decisions.md says ANSWERED / "Owner answered"), the defect must no longer say it is waiting — otherwise
 * the owner is asked again for something he already decided (D-078 and D-110 did exactly that, 27 Nov 2026).
 */
const defects = readFileSync('docs/registers/daily-work-defects.md', 'utf8').split('\n').filter((l) => /^\| D-\d{3} \|/.test(l));
const decisions = readFileSync('docs/registers/decisions.md', 'utf8').split('\n');
const decisionRow = (ob: string): string => decisions.find((l) => l.startsWith(`| ${ob} |`)) ?? '';
const answered = (ob: string): boolean => /\banswered\b/i.test(decisionRow(ob));
const statusOf = (row: string): string => { const cells = row.split(' | '); return (cells[cells.length - 1] ?? '').replace(/\|\s*$/, ''); };
const waitsOnOwner = (status: string): boolean => /question (asked|open)|owner question open|waiting for the owner/i.test(status);

describe('a defect that waits on the owner names a question still open', () => {
  it('the register has defect rows and decision rows to compare', () => {
    expect(defects.length).toBeGreaterThan(100);
    expect(decisions.some((l) => l.startsWith('| OB-866 |'))).toBe(true);
  });

  it('no defect still says it waits on an owner question the owner has already answered', () => {
    const stale: string[] = [];
    for (const row of defects) {
      if (!waitsOnOwner(statusOf(row))) continue;
      const obs = [...new Set(row.match(/\bOB-\d{3,4}\b/g) ?? [])];
      const done = obs.filter(answered);
      if (done.length > 0) stale.push(`${row.slice(2, 7)} still waits on ${done.join(', ')}, which the owner answered`);
    }
    expect(stale).toEqual([]);
  });
});
