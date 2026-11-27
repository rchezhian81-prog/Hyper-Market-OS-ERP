import { describe, it, expect } from 'vitest';
import {
  qg11EvaluationBlockers, qg11EvaluationState, decideGate, GoWhileBlockedError, type EvaluationRunView,
} from '../../packages/compliance/src/index';

/**
 * QG-11 (OB-935 — owner decided A, 27 Nov 2026): the gate register's AI evaluations rule. Every assistant in the evaluation set
 * needs a COMPLETE, PASSING latest run; anything else — none, not complete, unsafe, failing, or records that could not be
 * read — is a blocker by name, and GO is refused while one stands. HOLD and REWORK are not refused.
 */

const AGENTS = [{ agentId: 'A03', name: 'Replenishment' }, { agentId: 'A05', name: 'Pricing' }];
const run = (agent: string, over: Partial<EvaluationRunView> = {}): EvaluationRunView => ({
  runId: `evr-${agent}-1`, agent, at: '2026-11-27T10:00:00.000Z', total: 4, passed: 4, unsafe: 0, complete: true, fitToFacePeople: true, ...over,
});

describe('QG-11: the AI evaluations rule of the gate register', () => {
  it('names every assistant with no run on record, and says no model is connected', () => {
    const b = qg11EvaluationBlockers({ agents: AGENTS, runs: [] });
    expect(b.map((x) => x.ref)).toEqual(['ai-evaluation:A03:not_run', 'ai-evaluation:A05:not_run']);
    expect(b.every((x) => x.gate === 'QG-11' && x.kind === 'check' && x.releases === undefined)).toBe(true); // every release
    expect(b[0]!.reason).toBe('A03 · Replenishment has no evaluation on record — it needs a complete, passing evaluation against a live model (no model is connected yet — EX-12, OB-296; live models are due at R8, OB-382)');
  });

  it('judges the LATEST run per assistant: not complete, unsafe and failing all block; complete and passing clears', () => {
    expect(qg11EvaluationState(undefined)).toBe('not_run');
    expect(qg11EvaluationState(run('A03', { complete: false, fitToFacePeople: false, passed: 0 }))).toBe('not_complete');
    expect(qg11EvaluationState(run('A03', { unsafe: 1, passed: 3, fitToFacePeople: false }))).toBe('unsafe');
    expect(qg11EvaluationState(run('A03', { passed: 3, fitToFacePeople: false }))).toBe('failed');
    expect(qg11EvaluationState(run('A03'))).toBe('passed');

    const b = qg11EvaluationBlockers({ agents: AGENTS, runs: [run('A03', { complete: false, runId: 'r0' }), run('A03', { runId: 'r1' }), run('A05', { runId: 'r2' }), run('A05', { runId: 'r3', unsafe: 1, passed: 3 })] });
    expect(b.map((x) => x.ref)).toEqual(['ai-evaluation:A05:unsafe']); // A03's latest passes; A05's latest is unsafe
    expect(b[0]!.reason).toBe('A05 · Pricing\'s latest evaluation (run r3) had 1 UNSAFE case(s) — it must not face anybody until a complete run passes');
    const failing = qg11EvaluationBlockers({ agents: AGENTS, runs: [run('A03'), run('A05', { passed: 2, fitToFacePeople: false })] });
    expect(failing[0]!.reason).toBe('A05 · Pricing\'s latest evaluation (run evr-A05-1) failed — 2 of 4 passed; it needs a complete, passing evaluation against a live model');
    const incomplete = qg11EvaluationBlockers({ agents: AGENTS, runs: [run('A03'), run('A05', { complete: false })] });
    expect(incomplete[0]!.reason).toMatch(/^A05 · Pricing's latest evaluation \(run evr-A05-1\) is NOT COMPLETE — it never reached a model, so it proves nothing/);
    expect(qg11EvaluationBlockers({ agents: AGENTS, runs: [run('A03'), run('A05')] })).toEqual([]);
  });

  it('silence is never a pass: unreadable records, or an empty set, block', () => {
    const unread = qg11EvaluationBlockers({ agents: AGENTS, runs: null });
    expect(unread).toHaveLength(1);
    expect(unread[0]).toMatchObject({ gate: 'QG-11', ref: 'ai-evaluations:unreadable' });
    expect(unread[0]!.reason).toContain('could not be read — this is not the same as "none"');
    expect(qg11EvaluationBlockers({ agents: [], runs: [] })[0]).toMatchObject({ gate: 'QG-11', ref: 'ai-evaluations:empty-set' });
  });

  it('GO is refused while a blocker stands, naming the assistants; HOLD and REWORK are recorded', () => {
    const blockers = qg11EvaluationBlockers({ agents: AGENTS, runs: [] });
    const input = (decision: string) => ({
      gate: 'QG-11', release: 'R8', decision, evidence: [{ label: 'reading', ref: 'QG-11 row' }], rationale: 'read it',
      decidedBy: 'u-owner', decidedAt: '2026-11-27T10:00:00.000Z', decisionId: `d-${decision}`, blockers,
    });
    expect(() => decideGate(input('GO'))).toThrow(GoWhileBlockedError);
    try { decideGate(input('GO')); } catch (e) { expect((e as Error).message).toMatch(/QG-11 cannot be GO while 2 thing\(s\) block it: A03 · Replenishment has no evaluation .*; A05 · Pricing has no evaluation/); }
    expect(decideGate(input('HOLD')).decision).toBe('HOLD');
    expect(decideGate(input('REWORK')).decision).toBe('REWORK');
  });
});
