import { describe, it, expect } from 'vitest';
import {
  decideGate, gateRegister, summariseGateRegister, undecidedGateBlockers, readEvidence, QUALITY_GATES, RELEASES,
  UnknownGateError, UnknownReleaseError, DecisionNotReadableError, GoWhileBlockedError,
  type GateDecision, type GateBlocker,
} from '../../packages/compliance/src/index';

// QG-12 (roadmap §22): "Every gate ends GO, HOLD or REWORK with evidence; silence is not approval." §36: the owner is
// accountable for GO/HOLD/REWORK. These prove the engine: no default decision, evidence and a reason on every
// decision, no GO over a blocker, append-only history, and a later problem is never hidden behind an earlier GO.

const EVIDENCE = [{ label: 'CI run 812 — every scan green', ref: 'https://github.com/example/actions/runs/812' }];
const at = (h: number): string => `2026-10-23T${String(h).padStart(2, '0')}:00:00.000Z`;
const decide = (over: Partial<Parameters<typeof decideGate>[0]> = {}): GateDecision => decideGate({
  decisionId: `d-${Math.random()}`, gate: 'QG-03', release: 'R5', decision: 'GO', evidence: EVIDENCE,
  rationale: 'scans, tests and SBOM all green on the release commit', decidedBy: 'u-owner', decidedAt: at(9), blockers: [], ...over,
});
const blocker = (gate: string, ref = 'r1'): GateBlocker => ({ gate, kind: 'risk', ref, reason: `open high risk "${ref}"` });

describe('the twelve gates and nine releases are the roadmap\'s own', () => {
  it('QG-01 … QG-12 with §22 pass conditions verbatim; R0 … R8', () => {
    expect(QUALITY_GATES.map((g) => g.gate)).toEqual(Array.from({ length: 12 }, (_, i) => `QG-${String(i + 1).padStart(2, '0')}`));
    expect(QUALITY_GATES.find((g) => g.gate === 'QG-12')!.passCondition).toBe('Every gate ends GO, HOLD or REWORK with evidence; silence is not approval.');
    expect(QUALITY_GATES.find((g) => g.gate === 'QG-06')!.passCondition).toBe('Zero open critical/high findings at go-live; independent penetration test before customer launch.');
    expect(RELEASES).toEqual(['R0', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8']);
  });
});

describe('a decision needs evidence, a reason and a named decider — every decision, not only GO', () => {
  it('records GO, HOLD and REWORK with what they rest on', () => {
    for (const decision of ['GO', 'HOLD', 'REWORK'] as const) {
      const d = decide({ decision });
      expect(d).toMatchObject({ gate: 'QG-03', release: 'R5', decision, decidedBy: 'u-owner', evidence: EVIDENCE });
    }
  });

  it('refuses no evidence, empty evidence, a half-filled evidence line, no reason, no decider, no decision word — all named at once', () => {
    for (const evidence of [undefined, [], [{ label: 'x' }], [{ label: '  ', ref: 'y' }], 'see slack']) {
      expect(() => decide({ evidence })).toThrow(DecisionNotReadableError);
    }
    try {
      decide({ decision: 'MAYBE', evidence: [], rationale: ' ', decidedBy: '' });
      expect.unreachable();
    } catch (e) {
      const p = (e as DecisionNotReadableError).problems.join(' | ');
      for (const w of ['GO, HOLD or REWORK', 'evidence', 'rationale', 'named person']) expect(p).toContain(w);
    }
  });

  it('refuses an unknown gate or release', () => {
    expect(() => decide({ gate: 'QG-13' })).toThrow(UnknownGateError);
    expect(() => decide({ release: 'R9' })).toThrow(UnknownReleaseError);
  });

  it('evidence is trimmed and bounded', () => {
    expect(readEvidence([{ label: '  a ', ref: ' b ' }])).toEqual([{ label: 'a', ref: 'b' }]);
    expect(readEvidence({ label: 'a', ref: 'b' })).toBeUndefined();
  });
});

describe('GO is refused while anything blocks the gate; HOLD and REWORK are not', () => {
  it('names every blocker on THIS gate; a blocker on another gate does not stop it', () => {
    try {
      decide({ gate: 'QG-06', blockers: [blocker('QG-06', 'r1'), blocker('QG-06', 'f1'), blocker('QG-08', 'x')] });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(GoWhileBlockedError);
      expect((e as GoWhileBlockedError).blockers.map((b) => b.ref)).toEqual(['r1', 'f1']);
      expect((e as Error).message).toContain('QG-06 cannot be GO while 2 thing(s) block it');
    }
    expect(decide({ gate: 'QG-03', blockers: [blocker('QG-06')] }).decision).toBe('GO');
  });

  it('a HOLD over a blocker is recorded with the blockers it saw', () => {
    const d = decide({ gate: 'QG-06', decision: 'HOLD', blockers: [blocker('QG-06')] });
    expect(d.blockersAtDecision.map((b) => b.ref)).toEqual(['r1']);
  });

  it('QG-12 is blocked while any other gate of the release is undecided', () => {
    const b = undecidedGateBlockers([decide({ gate: 'QG-01' })], 'R5');
    expect(b).toHaveLength(10);
    expect(b.every((x) => x.gate === 'QG-12' && x.kind === 'check')).toBe(true);
    expect(b.map((x) => x.ref)).not.toContain('undecided:QG-01');
    expect(b.map((x) => x.ref)).not.toContain('undecided:QG-12');
    expect(undecidedGateBlockers([decide({ gate: 'QG-01', release: 'R4' })], 'R5')).toHaveLength(11);
  });
});

describe('the register: no default, the latest decision stands, a later problem shows', () => {
  it('a fresh register reads every gate "undecided" with decision null — never GO, never HOLD', () => {
    const reg = gateRegister([], 'R5', []);
    expect(reg).toHaveLength(12);
    expect(reg.every((g) => g.state === 'undecided' && g.decision === null && g.decisionsMade === 0)).toBe(true);
    expect(summariseGateRegister(reg)).toEqual({ undecided: 12, go: 0, hold: 0, rework: 0, goNowBlocked: 0, allGo: false });
  });

  it('the latest decision in time stands, the count keeps the history, other releases do not leak in', () => {
    const decisions = [
      decide({ gate: 'QG-03', decision: 'GO', decidedAt: at(11) }),
      decide({ gate: 'QG-03', decision: 'HOLD', decidedAt: at(10) }),
      decide({ gate: 'QG-03', decision: 'REWORK', release: 'R4', decidedAt: at(12) }),
    ];
    const g = gateRegister(decisions, 'R5', []).find((x) => x.gate === 'QG-03')!;
    expect(g).toMatchObject({ decision: 'GO', state: 'GO', decisionsMade: 2, decidedAt: at(11) });
  });

  it('a GO that something blocks afterwards reads GO_NOW_BLOCKED, with the blocker', () => {
    const reg = gateRegister([decide({ gate: 'QG-06' })], 'R5', [blocker('QG-06', 'f-new')]);
    const g = reg.find((x) => x.gate === 'QG-06')!;
    expect(g.state).toBe('GO_NOW_BLOCKED');
    expect(g.blockers.map((b) => b.ref)).toEqual(['f-new']);
    expect(summariseGateRegister(reg).goNowBlocked).toBe(1);
  });

  it('allGo only when all twelve read GO with nothing blocking', () => {
    const all = QUALITY_GATES.map((q) => decide({ gate: q.gate }));
    expect(summariseGateRegister(gateRegister(all, 'R5', [])).allGo).toBe(true);
    expect(summariseGateRegister(gateRegister(all.slice(1), 'R5', [])).allGo).toBe(false);
    expect(summariseGateRegister(gateRegister(all, 'R5', [blocker('QG-02')])).allGo).toBe(false);
  });
});
