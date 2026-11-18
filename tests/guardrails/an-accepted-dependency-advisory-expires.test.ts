// OB-843 (owner, 18 Nov 2026, in writing: "OB-843 A — Sivakumar agrees"), under OB-330's two signatures (the owner and the
// named security reviewer, OB-405). The dependency gate (`pnpm audit --audit-level=high`) may ignore ONE advisory —
// picomatch GHSA-fc5q-39xc-vjpf / CVE-2026-112366, a ReDoS with no fixed version released — and only:
//   • for the development tools: picomatch reaches no shipped image (the images install production dependencies only,
//     tests/guardrails/the-shipped-images-carry-no-build-tooling.test.ts) and not the store PC (it ships pg alone);
//   • for 30 days at most: from 19 Dec 2026 this test fails and the acceptance must be removed or signed again;
//   • until a fixed picomatch exists: the moment the lockfile holds a picomatch above 4.0.7, this test fails and the
//     acceptance must be removed.
// Nothing else may be added to the ignore list without its own two-signature decision and its own expiry here.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');

/** Every accepted advisory: its id, the decision, the last day it may be ignored, and the last affected version. */
const ACCEPTED = [
  { ghsa: 'GHSA-fc5q-39xc-vjpf', decision: 'OB-843', lastDay: '2026-12-18', pkg: 'picomatch', lastAffected: [4, 0, 7] },
] as const;

const ignored = (): readonly string[] => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { pnpm?: { auditConfig?: { ignoreGhsas?: string[] } } };
  return pkg.pnpm?.auditConfig?.ignoreGhsas ?? [];
};

describe('an accepted dependency advisory is narrow and expires', () => {
  it('the gate ignores only advisories accepted under two signatures', () => {
    expect([...ignored()].sort()).toEqual(ACCEPTED.map((a) => a.ghsa).sort());
  });

  for (const a of ACCEPTED) {
    it(`${a.ghsa} (${a.decision}) is still within its 30 days`, () => {
      const today = new Date().toISOString().slice(0, 10);
      expect(today <= a.lastDay, `${a.decision} expired on ${a.lastDay}: remove ${a.ghsa} from package.json pnpm.auditConfig.ignoreGhsas, or ask the owner and the security reviewer to sign again`).toBe(true);
    });

    it(`${a.ghsa} (${a.decision}) is removed as soon as a fixed ${a.pkg} is in the lockfile`, () => {
      const lock = readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8');
      const versions = [...lock.matchAll(new RegExp(`\\n {2}${a.pkg}@(\\d+)\\.(\\d+)\\.(\\d+):`, 'g'))].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
      expect(versions.length).toBeGreaterThan(0);
      const above = (v: number[]) => v[0]! !== a.lastAffected[0] ? v[0]! > a.lastAffected[0] : v[1]! !== a.lastAffected[1] ? v[1]! > a.lastAffected[1] : v[2]! > a.lastAffected[2];
      const fixed = versions.filter(above);
      expect(fixed, `a fixed ${a.pkg} (${fixed.map((v) => v.join('.')).join(', ')}) is in the lockfile: remove ${a.ghsa} from the ignore list`).toEqual([]);
    });
  }
});
