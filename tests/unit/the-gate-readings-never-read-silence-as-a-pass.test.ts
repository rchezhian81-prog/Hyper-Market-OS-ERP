import { describe, it, expect } from 'vitest';
import {
  gateEvidenceBlockers, readGateEvidence, blockersForRelease, latestEvidence, qg07Blockers, qg10Blockers, qg04SyncBlockers,
  NotGateEvidenceError, CUSTOMER_FACING_RELEASES, type GateEvidenceRecord,
} from '../../packages/compliance/src/index';

/**
 * W3 · QG-04 · QG-05 · QG-06 · QG-07 · QG-10 (roadmap §22, §32, §35.1) — the pure readings behind the gate register's new
 * machine checks. Nothing on record is a blocker by name, never a pass (P-08); a p95 is worked out from the measured figure.
 */

const rec = (over: Partial<GateEvidenceRecord> & Pick<GateEvidenceRecord, 'evidenceId' | 'kind'>): GateEvidenceRecord => ({
  gate: 'QG-04', result: 'passed', where: 'store PC', reportRef: 'r', testedOn: '2026-11-01', statement: 's', recordedBy: 'u-owner', recordedAt: '2026-11-01T10:00:00.000Z', ...over,
});

describe('the outside evidence (QG-04 · QG-05 · QG-06)', () => {
  it('an empty register blocks every kind, by name; the pen test only from R4', () => {
    const b = gateEvidenceBlockers([]);
    expect(b.map((x) => `${x.gate} ${x.ref}`)).toEqual([
      'QG-04 evidence:offline_72h_simulation', 'QG-04 evidence:power_process_chaos', 'QG-05 evidence:scan_to_line_p95', 'QG-05 evidence:total_tender_p95', 'QG-06 evidence:independent_pentest',
    ]);
    expect(CUSTOMER_FACING_RELEASES).toEqual(['R4', 'R5', 'R6', 'R7', 'R8']);
    expect(blockersForRelease(b, 'R2').map((x) => x.gate)).toEqual(['QG-04', 'QG-04', 'QG-05', 'QG-05']);
    expect(blockersForRelease(b, 'R4').map((x) => x.gate)).toContain('QG-06');
  });

  it('a timing is worked out against the fixed §32 target — 300 ms passes, 301 ms fails, a typed result is refused', () => {
    const read = (body: Record<string, unknown>) => readGateEvidence({ evidenceId: 'e-1', body: { where: 'lane 1', reportRef: 'r', testedOn: '2026-11-01', statement: 's', ...body }, recordedBy: 'u-owner', recordedAt: '2026-11-01T10:00:00.000Z' });
    expect(read({ kind: 'scan_to_line_p95', measuredMs: 300 }).result).toBe('passed');
    expect(read({ kind: 'scan_to_line_p95', measuredMs: 301 }).result).toBe('failed');
    expect(read({ kind: 'total_tender_p95', measuredMs: 501 }).result).toBe('failed');
    expect(() => read({ kind: 'scan_to_line_p95', measuredMs: 200, result: 'passed' })).toThrow(NotGateEvidenceError);
    expect(() => read({ kind: 'offline_72h_simulation', result: 'passed', measuredMs: 10 })).toThrow(NotGateEvidenceError);
    expect(() => read({ kind: 'offline_72h_simulation', result: 'maybe' })).toThrow(NotGateEvidenceError);
    expect(() => read({ kind: 'offline_72h_simulation', result: 'passed', testedOn: '1 Nov' })).toThrow(NotGateEvidenceError);
    expect(() => readGateEvidence({ evidenceId: 'e-1', body: { kind: 'offline_72h_simulation', result: 'passed', where: 'w', reportRef: 'r', testedOn: '2026-11-01', statement: 's' }, recordedBy: '', recordedAt: 'x' })).toThrow(NotGateEvidenceError);
  });

  it('the latest test decides — by the day tested, then when recorded; a failed latest blocks with its figure', () => {
    const old = rec({ evidenceId: 'a', kind: 'scan_to_line_p95', gate: 'QG-05', measuredMs: 250, testedOn: '2026-10-01' });
    const bad = rec({ evidenceId: 'b', kind: 'scan_to_line_p95', gate: 'QG-05', result: 'failed', measuredMs: 420, testedOn: '2026-11-01' });
    expect(latestEvidence([bad, old], 'scan_to_line_p95')!.evidenceId).toBe('b');
    const blk = gateEvidenceBlockers([old, bad]).find((x) => x.ref.startsWith('evidence:scan_to_line_p95'))!;
    expect(blk.reason).toMatch(/FAILED — p95 420 ms against the 300 ms target/);
  });
});

describe('QG-07 — the five domains\' control totals, signed', () => {
  it('names each domain with no total, and each unsigned total; clears a domain only when all of it is signed', () => {
    expect(qg07Blockers([]).map((b) => b.ref)).toEqual(['control-totals:migration', 'control-totals:stock', 'control-totals:financial', 'control-totals:tax', 'control-totals:loyalty']);
    const totals = [
      { totalId: 'S1', kind: 'stock', name: 'Units', signature: { signedBy: 'u-2' } },
      { totalId: 'S2', kind: 'stock', name: 'Value' },
      ...['migration', 'financial', 'tax', 'loyalty'].map((k) => ({ totalId: k, kind: k, name: k, signature: { signedBy: 'u-ca' } })),
    ];
    expect(qg07Blockers(totals).map((b) => b.reason)).toEqual(['1 of 2 stock control total(s) not signed: Value (S2)']);
    expect(qg07Blockers(totals.map((t) => ({ ...t, signature: { signedBy: 'u-2' } })))).toEqual([]);
  });
});

describe('QG-10 — each computer\'s newest release attempt, verified', () => {
  const note = (box: string, at: string, verified: boolean, notVerified: string[] = []) => ({ release: 'd'.repeat(40), box, at, run: '8', attempt: '1', outcome: 'deployed' as const, verified, notVerified: notVerified as never[] });
  it('no note at all blocks; a computer\'s newest unverified attempt blocks, naming what was not verified; an older failure behind a newer pass does not', () => {
    expect(qg10Blockers([]).map((b) => b.ref)).toEqual(['qg10:no-release-note']);
    expect(qg10Blockers([note('demo-box', '2026-10-27T05:00:00.000Z', false, ['reconciliation']), note('demo-box', '2026-10-27T06:00:00.000Z', true)])).toEqual([]);
    const b = qg10Blockers([note('canary-box', '2026-10-27T04:00:00.000Z', true), note('demo-box', '2026-10-27T06:00:00.000Z', false, ['monitoring'])]);
    expect(b).toHaveLength(1);
    expect(b[0]!.reason).toMatch(/the newest release on demo-box .* was not verified: monitoring/);
  });
});

describe('QG-04 — the store computers\' own sync reports', () => {
  it('no report blocks; a dead letter blocks by store and queue; a clean report clears', () => {
    expect(qg04SyncBlockers([]).map((b) => b.ref)).toEqual(['sync:no-store-report']);
    expect(qg04SyncBlockers([{ storeId: 'S1', domains: [{ domain: 'sales', deadLettered: 3 }, { domain: 'returns', deadLettered: 0 }] }]).map((b) => b.ref)).toEqual(['sync:S1:sales:dead-letter']);
    expect(qg04SyncBlockers([{ storeId: 'S1', domains: [{ domain: 'sales', deadLettered: 0 }] }])).toEqual([]);
  });
});
