import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { BUILT_IN_SOPS } from '../../packages/workforce/src/sop-library.generated';

// M25-FR-04 · OB-320: the help library and the role curriculum are built from the shop's OWN SOP sheets (docs/sop). A
// sheet changed without regenerating would put old words on the help page — and an acknowledgement of words nobody
// reads any more. This fails until `node scripts/sync-sop-library.mjs` is run, and checks the library is the sheets.

describe('guardrail: the built-in help library is the SOP sheets, word for word', () => {
  it('the generated library is not behind docs/sop', () => {
    expect(() => execFileSync('node', ['scripts/sync-sop-library.mjs', '--check'], { stdio: 'pipe' })).not.toThrow();
  });

  it('each built-in sheet carries both languages, its own "For:" line and the roles that line names', () => {
    expect(BUILT_IN_SOPS.map((s) => s.sopId)).toEqual(['SOP-01', 'SOP-02', 'SOP-03', 'SOP-04']);
    for (const s of BUILT_IN_SOPS) {
      expect(s.bodyEn, s.sopId).toBe(readFileSync(s.sourceFiles[0]!, 'utf8'));
      expect(s.bodyTa, s.sopId).toBe(readFileSync(s.sourceFiles[1]!, 'utf8'));
      expect(s.forLine.length, s.sopId).toBeGreaterThan(0);
      expect(s.forRoles.length, s.sopId).toBeGreaterThan(0);
      expect(s.version, s.sopId).toBeGreaterThanOrEqual(1);
    }
  });
});
