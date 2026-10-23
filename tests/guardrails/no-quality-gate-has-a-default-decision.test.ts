import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { apiHarness } from '../support/api-harness';
import { gateRegister, QUALITY_GATES, RELEASES } from '../../packages/compliance/src/index';

/**
 * QG-12 guardrail (roadmap §22): "Every gate ends GO, HOLD or REWORK with evidence; silence is not approval."
 *
 * No gate may ever read GO — or HOLD, or REWORK — because nobody decided it. This fails if:
 *   • the engine gives any gate of any release a decision without a recorded one;
 *   • the live API's register for a brand-new shop shows any gate as anything but "undecided";
 *   • the register's code grows a default decision (a `?? 'GO'`, a `decision: 'GO'` literal, a "default" GO/HOLD).
 */

const SOURCES = ['packages/compliance/src/gate-decisions.ts', 'services/compliance/src/gate-decisions.ts', 'services/api/src/gates-adapters.ts'];

describe('no quality gate has a default decision (QG-12 — silence is not approval)', () => {
  it('the engine: with no recorded decision, every gate of every release is undecided', () => {
    for (const release of RELEASES) {
      const reg = gateRegister([], release, []);
      expect(reg.map((g) => g.gate)).toEqual(QUALITY_GATES.map((g) => g.gate));
      for (const g of reg) expect({ gate: g.gate, release, decision: g.decision, state: g.state }).toEqual({ gate: g.gate, release, decision: null, state: 'undecided' });
    }
  });

  it('the live API: a brand-new shop\'s register reads every gate undecided for every release', async () => {
    const h = apiHarness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    for (const release of RELEASES) {
      const res = await h.request({ method: 'GET', path: '/v1/compliance/gate-register', userId: 'u-owner', tenantId: T, query: { release } });
      expect(res.status).toBe(200);
      const body = res.body as { gates: { gate: string; decision: string | null; state: string }[]; summary: { undecided: number; allGo: boolean } };
      expect(body.gates.filter((g) => g.decision !== null || g.state !== 'undecided').map((g) => `${release} ${g.gate}`)).toEqual([]);
      expect(body.summary).toMatchObject({ undecided: 12, allGo: false });
    }
  });

  it('the register\'s code carries no default decision', () => {
    const DEFAULTS = [
      /\?\?\s*['"](GO|HOLD|REWORK)['"]/, // x ?? 'GO'
      /\|\|\s*['"](GO|HOLD|REWORK)['"]/, // x || 'HOLD'
      /decision\s*[:=]\s*['"](GO|HOLD|REWORK)['"]/, // decision: 'GO'
      /default[A-Za-z]*\s*[:=]\s*['"](GO|HOLD|REWORK)['"]/i,
    ];
    for (const path of SOURCES) {
      const code = readFileSync(path, 'utf8').split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'));
      for (const re of DEFAULTS) {
        const hits = code.filter((l) => re.test(l));
        expect(hits, `${path} must not default a gate decision (${re})`).toEqual([]);
      }
    }
  });
});
