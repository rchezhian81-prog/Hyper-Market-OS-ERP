import { describe, it, expect } from 'vitest';
import { citationsOf, classify, evidenceFor, labelHolds, namedTests, parseRegister } from '../../scripts/evidence-ledger.mjs';

/** The pure parts of scripts/evidence-ledger.mjs (GT-08 · PF-15): how a citation, a kind and a label verdict are derived. */

describe('citations', () => {
  it('reads module, extension, workflow, gate, agent and migration IDs; an FR counts for its module', () => {
    expect([...citationsOf('proves M12-FR-02 and M14 · D04 · WF-10 · QG-05 · A06 · MG-04; not m12 or M1 or WF10')].sort())
      .toEqual(['A06', 'D04', 'M12', 'M14', 'MG-04', 'QG-05', 'WF-10']);
  });

  it('names only test files that exist', () => {
    const exists = (p: string) => p === 'tests/e2e/a.e2e.ts';
    expect([...namedTests('see tests/e2e/a.e2e.ts and tests/unit/gone.test.ts', exists)]).toEqual(['tests/e2e/a.e2e.ts']);
  });
});

describe('kinds', () => {
  it('classifies by where a file lives and whether it needs a database; guardrails and performance are no kind', () => {
    expect(classify('tests/unit/x.test.ts', '')).toEqual({ family: 'unit', realDb: false });
    expect(classify('tests/integration/x.test.ts', "const url = process.env['DATABASE_URL']")).toEqual({ family: 'integration', realDb: true });
    expect(classify('tests/migration/x.test.ts', '')).toEqual({ family: 'integration', realDb: false });
    expect(classify('tests/e2e/x.e2e.ts', 'DATABASE_URL')).toEqual({ family: 'browser', realDb: true });
    expect(classify('tests/guardrails/x.test.ts', 'DATABASE_URL')).toEqual({ family: null, realDb: true });
    expect(classify('tests/performance/x.test.ts', '')).toEqual({ family: null, realDb: false });
  });

  it('collects an item\'s evidence from citations, from files its prose names, and from PASS sessions', () => {
    const tests = new Map([
      ['tests/unit/u.test.ts', { citations: new Set(['M12']), family: 'unit', realDb: false }],
      ['tests/integration/i.test.ts', { citations: new Set(['M12']), family: 'integration', realDb: false }],
      ['tests/integration/db.test.ts', { citations: new Set(['W10']), family: 'integration', realDb: true }],
      ['tests/e2e/b.e2e.ts', { citations: new Set(['SP-4b']), family: 'browser', realDb: false }],
      ['tests/e2e/c.e2e.ts', { citations: new Set(['M12']), family: 'browser', realDb: true }],
    ]);
    const sessions = parseRegister('### UAT-S-1 — 2026-10-20 — x\n**Covers:** M12\n**Device:** Posiflex PC\n**Outcome:** PASS\n### UAT-S-2 — 2026-10-21 — x\n**Covers:** M12\n**Device:** none\n**Outcome:** PASS\n### UAT-S-3 — 2026-10-22 — x\n**Covers:** M12\n**Device:** phone\n**Outcome:** FAIL\n');
    const ev = evidenceFor({ id: 'M12', evidence: 'proved by tests/integration/db.test.ts and tests/e2e/b.e2e.ts' }, tests, sessions, (p) => tests.has(p));
    expect(ev['unit']).toEqual(['tests/unit/u.test.ts']);
    expect(ev['integration']).toEqual(['tests/integration/db.test.ts', 'tests/integration/i.test.ts']);
    expect(ev['realDb']).toEqual(['tests/integration/db.test.ts']);
    expect(ev['browser']).toEqual(['tests/e2e/b.e2e.ts', 'tests/e2e/c.e2e.ts']);
    expect(ev['connected']).toEqual(['tests/e2e/c.e2e.ts']);
    expect(ev['uat']).toEqual(['UAT-S-1', 'UAT-S-2']);
    expect(ev['device']).toEqual(['UAT-S-1 (Posiflex PC)']);
  });
});

describe('the label rule', () => {
  const ev = (over: Partial<Record<string, string[]>>) => ({ unit: [], integration: [], realDb: [], browser: [], connected: [], device: [], uat: [], ...over });

  it('asks nothing below INTEGRATION_TESTED', () => {
    for (const label of ['NOT_STARTED', 'ENGINE_ONLY', 'PARTIALLY_WIRED', 'WIRED']) expect(labelHolds(label, ev({})).holds, label).toBe(true);
  });

  it('INTEGRATION_TESTED needs an integration test', () => {
    expect(labelHolds('INTEGRATION_TESTED', ev({})).holds).toBe(false);
    expect(labelHolds('INTEGRATION_TESTED', ev({ integration: ['i'] })).holds).toBe(true);
  });

  it('E2E_VERIFIED needs the user boundary AND the cloud effect, and says whether one run proved both', () => {
    expect(labelHolds('E2E_VERIFIED', ev({ integration: ['i'], browser: ['b'] }))).toMatchObject({ holds: false, why: expect.stringContaining('cloud effect') });
    expect(labelHolds('E2E_VERIFIED', ev({ integration: ['i'], realDb: ['d'] }))).toMatchObject({ holds: false, why: expect.stringContaining('browser test') });
    expect(labelHolds('E2E_VERIFIED', ev({ integration: ['i'], browser: ['b'], realDb: ['d'] }))).toMatchObject({ holds: true, why: expect.stringContaining('separate runs') });
    expect(labelHolds('E2E_VERIFIED', ev({ integration: ['i'], browser: ['b'], connected: ['b'] }))).toMatchObject({ holds: true, why: expect.stringContaining('ONE connected run') });
  });

  it('UAT_VERIFIED needs a PASS session on top; PRODUCTION_VERIFIED cannot be claimed under v1', () => {
    const e2e = ev({ integration: ['i'], browser: ['b'], realDb: ['d'] });
    expect(labelHolds('UAT_VERIFIED', e2e).holds).toBe(false);
    expect(labelHolds('UAT_VERIFIED', { ...e2e, uat: ['UAT-S-1'] }).holds).toBe(true);
    expect(labelHolds('PRODUCTION_VERIFIED', { ...e2e, uat: ['UAT-S-1'] })).toMatchObject({ holds: false, why: expect.stringContaining('no production evidence kind') });
  });
});
