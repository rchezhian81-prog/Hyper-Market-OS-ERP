import { describe, it, expect } from 'vitest';
import {
  assessColdChain,
  releaseFromQualityHold,
  raiseColdChainIncident,
  type ColdChainRule,
  type QualityHold,
  type QualitySample,
  type TemperatureReading,
} from '../../packages/quality/src/index';

// M10-FR-02 — cold chain is the one control where the damage is invisible. Frozen
// goods that sat at 9°C for three hours look exactly like frozen goods that did not.

const RULE: ColdChainRule = { productId: 'p-milk', minTenthsC: 0, maxTenthsC: 50, graceMinutes: 15 };

function reading(over: Partial<TemperatureReading> = {}): TemperatureReading {
  return {
    readingId: 'r-1',
    batchId: 'B1',
    productId: 'p-milk',
    tenthsC: 40,
    at: '2026-08-06T08:00:00Z',
    source: 'chiller-probe',
    recordedBy: 'staff-1',
    ...over,
  };
}

function assess(readings: readonly TemperatureReading[]) {
  return assessColdChain({ batchId: 'B1', productId: 'p-milk', rule: RULE, readings });
}

describe('assessColdChain — evidence decides, not an opinion at the counter', () => {
  it('passes a batch that stayed in range, and keeps the readings as evidence', () => {
    const result = assess([reading(), reading({ readingId: 'r-2', at: '2026-08-06T09:00:00Z', tenthsC: 45 })]);
    expect(result.severity).toBe('within_range');
    expect(result.quarantine).toBe(false);
    expect(result.evidence).toHaveLength(2);
  });

  it('treats a MISSING reading as a failure, not a pass', () => {
    // A cold-chain item with no temperature recorded is one nobody checked.
    const result = assess([]);
    expect(result.severity).toBe('breach');
    expect(result.quarantine).toBe(true);
    expect(result.detail).toContain('an unmeasured cold chain is an unproven one');
  });

  it('does not condemn a freezer door opened for ninety seconds', () => {
    const result = assess([
      reading({ readingId: 'r-1', at: '2026-08-06T08:00:00Z', tenthsC: 40 }),
      reading({ readingId: 'r-2', at: '2026-08-06T08:05:00Z', tenthsC: 90 }),
      reading({ readingId: 'r-3', at: '2026-08-06T08:10:00Z', tenthsC: 42 }),
    ]);
    expect(result.severity).toBe('brief_excursion');
    expect(result.minutesOutOfRange).toBe(5);
    expect(result.quarantine).toBe(false);
    expect(result.detail).toContain('noted, not a breach');
  });

  it('quarantines the SAME temperature held for hours — duration is the difference', () => {
    const result = assess([
      reading({ readingId: 'r-1', at: '2026-08-06T08:00:00Z', tenthsC: 40 }),
      reading({ readingId: 'r-2', at: '2026-08-06T08:05:00Z', tenthsC: 90 }),
      reading({ readingId: 'r-3', at: '2026-08-06T12:05:00Z', tenthsC: 42 }),
    ]);
    // Same 9.0°C peak as the test above; four hours instead of five minutes.
    expect(result.peakTenthsC).toBe(90);
    expect(result.minutesOutOfRange).toBe(240);
    expect(result.severity).toBe('breach');
    // Automatic — not a warning for someone to consider while unloading.
    expect(result.quarantine).toBe(true);
    expect(result.detail).toContain('the batch is quarantined');
  });

  it('catches a breach on the cold side as well as the warm side', () => {
    const result = assess([
      reading({ readingId: 'r-1', at: '2026-08-06T08:00:00Z', tenthsC: -30 }),
      reading({ readingId: 'r-2', at: '2026-08-06T09:00:00Z', tenthsC: 20 }),
    ]);
    expect(result.severity).toBe('breach');
    expect(result.peakTenthsC).toBe(-30);
  });

  it('keeps only the offending readings as the excursion evidence', () => {
    const result = assess([
      reading({ readingId: 'r-1', tenthsC: 40 }),
      reading({ readingId: 'r-2', at: '2026-08-06T08:05:00Z', tenthsC: 90 }),
      reading({ readingId: 'r-3', at: '2026-08-06T12:05:00Z', tenthsC: 42 }),
    ]);
    expect(result.evidence.map((r) => r.readingId)).toEqual(['r-2']);
    expect(result.evidence[0]?.recordedBy).toBe('staff-1');
  });

  it('counts a trailing out-of-range reading rather than treating it as zero', () => {
    const result = assess([reading({ tenthsC: 40 }), reading({ readingId: 'r-2', at: '2026-08-06T09:00:00Z', tenthsC: 95 })]);
    expect(result.minutesOutOfRange).toBe(1);
    expect(result.severity).toBe('brief_excursion');
  });
});

describe('quality release — a name and a time, not "it was checked"', () => {
  const hold: QualityHold = {
    batchId: 'B1',
    productId: 'p-milk',
    status: 'held',
    reason: 'routine sampling',
    heldAt: '2026-08-06T08:00:00Z',
    heldBy: 'qc-1',
  };
  const passed: QualitySample[] = [
    { sampleId: 's-1', batchId: 'B1', takenBy: 'qc-1', takenAt: '2026-08-06T08:30:00Z', test: 'coliform', result: 'pass' },
  ];
  const AT = '2026-08-06T10:00:00Z';

  it('releases a batch that passed everything', () => {
    const result = releaseFromQualityHold({ hold, samples: passed, releasedBy: 'qc-1', at: AT });
    expect(result.released).toBe(true);
    expect(result.hold.status).toBe('released');
    expect(result.hold.releasedBy).toBe('qc-1');
  });

  it('refuses a failed sample, an outstanding one, and an unnamed releaser', () => {
    const failed = releaseFromQualityHold({
      hold,
      samples: [{ ...passed[0]!, result: 'fail', notes: 'coliform above limit' }],
      releasedBy: 'qc-1',
      at: AT,
    });
    expect(failed.outcome).toBe('sample_failed');
    expect(failed.detail).toContain('coliform above limit');

    const pending = releaseFromQualityHold({
      hold,
      samples: [{ ...passed[0]!, result: 'pending' }],
      releasedBy: 'qc-1',
      at: AT,
    });
    expect(pending.detail).toContain('releasing now would be a guess');

    const anonymous = releaseFromQualityHold({ hold, samples: passed, releasedBy: '  ', at: AT });
    expect(anonymous.detail).toContain('is not evidence');
  });

  it('refuses to release over a cold-chain breach', () => {
    const result = releaseFromQualityHold({
      hold,
      samples: passed,
      coldChain: assess([]),
      releasedBy: 'qc-1',
      at: AT,
    });
    expect(result.outcome).toBe('cold_chain_breach');
    expect(result.released).toBe(false);
  });

  it('never releases an expired batch, however good the samples were', () => {
    const result = releaseFromQualityHold({
      hold,
      samples: passed,
      expiresOn: '2026-08-05',
      releasedBy: 'qc-1',
      at: AT,
    });
    expect(result.outcome).toBe('expired');
    expect(result.detail).toContain('can never be released');
  });

  it('does not release the same batch twice', () => {
    const result = releaseFromQualityHold({
      hold: { ...hold, status: 'released' },
      samples: passed,
      releasedBy: 'qc-1',
      at: AT,
    });
    expect(result.outcome).toBe('not_held');
  });
});

describe('a breach becomes an incident, not a conversation', () => {
  it('links the incident to the control it defeated, with its evidence', () => {
    const breach = assess([
      reading({ readingId: 'r-1', at: '2026-08-06T08:00:00Z', tenthsC: 90 }),
      reading({ readingId: 'r-2', at: '2026-08-06T12:00:00Z', tenthsC: 40 }),
    ]);
    const incident = raiseColdChainIncident(breach, '2026-08-06T12:05:00Z');
    expect(incident?.controlId).toBe('c-cold-chain');
    expect(incident?.minutesOutOfRange).toBe(240);
    expect(incident?.evidence).toHaveLength(1);
  });

  it('raises nothing when there was no breach', () => {
    expect(raiseColdChainIncident(assess([reading()]), '2026-08-06T09:00:00Z')).toBeUndefined();
  });
});
