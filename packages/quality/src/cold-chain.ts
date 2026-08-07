// Quality status, sampling and cold-chain evidence (M10-FR-02 / D05-FR-04 / FSSAI).
//
// Cold chain is the one control where the damage is invisible. Frozen goods that sat
// at 9°C for three hours look exactly like frozen goods that did not. Nobody can tell
// by looking, the customer certainly cannot, and the consequence lands on whoever ate
// it. So the EVIDENCE decides, not an opinion at the counter:
//
//   • a breach **quarantines the batch automatically** — it is not a warning for
//     someone to consider while unloading a van in the rain;
//   • the excursion is judged on **duration as well as peak**. A freezer door open
//     for ninety seconds is not a breach; the same reading for four hours is. Judging
//     on peak alone either condemns good stock or clears bad stock, depending on
//     which threshold you happen to pick;
//   • evidence is **retained and retrievable** for an inspection (M34-FR-03), because
//     "we checked it" is not evidence — the reading, the time and the person are;
//   • a held batch is **not sellable until released by a named person**, and release
//     is refused for a failed or outstanding sample, or an expired batch.
//
// A MISSING reading is treated as a FAILED reading. A cold-chain item with no
// temperature recorded is a cold-chain item nobody checked, and assuming it was fine
// is exactly the assumption that makes people ill.
//
// Temperatures are stored in tenths of a degree as integers — the same discipline as
// money, for the same reason: 8.3 is not representable and a rounding error at the
// threshold decides whether stock is condemned.
//
// Pure and deterministic: the timestamp is injected, there is no clock.

export type QualityStatus = 'pending' | 'sampling' | 'passed' | 'held' | 'failed' | 'released';

export interface TemperatureReading {
  readonly readingId: string;
  readonly batchId: string;
  readonly productId: string;
  /** Degrees Celsius in tenths, as an integer: 83 is 8.3°C. */
  readonly tenthsC: number;
  readonly at: string;
  /** Where it was taken: the probe, the vehicle, the display case. */
  readonly source: string;
  readonly recordedBy: string;
}

/** Per-product cold-chain requirement, from the product master (M03). */
export interface ColdChainRule {
  readonly productId: string;
  readonly minTenthsC: number;
  readonly maxTenthsC: number;
  /**
   * How long a reading may sit outside the range before it is a breach. A freezer
   * door open for ninety seconds is not a breach; four hours is.
   */
  readonly graceMinutes: number;
}

export type ExcursionSeverity = 'within_range' | 'brief_excursion' | 'breach';

export interface ColdChainAssessment {
  readonly batchId: string;
  readonly productId: string;
  readonly severity: ExcursionSeverity;
  /** The worst reading seen, in tenths of a degree. */
  readonly peakTenthsC: number | null;
  /** Total minutes spent outside the permitted range. */
  readonly minutesOutOfRange: number;
  /** True when the batch must be quarantined — automatically, not on request. */
  readonly quarantine: boolean;
  readonly detail: string;
  /** The readings that justify the verdict — retained for inspection. */
  readonly evidence: readonly TemperatureReading[];
}

/**
 * Assess a batch's cold chain from its readings. Duration matters as much as peak,
 * and a cold-chain item with **no readings at all** fails rather than passes.
 */
export function assessColdChain(input: {
  readonly batchId: string;
  readonly productId: string;
  readonly rule: ColdChainRule;
  readonly readings: readonly TemperatureReading[];
}): ColdChainAssessment {
  const readings = [...input.readings]
    .filter((r) => r.batchId === input.batchId)
    .sort((a, b) => a.at.localeCompare(b.at));

  if (readings.length === 0) {
    // Absence of evidence is not evidence of a cold chain.
    return {
      batchId: input.batchId,
      productId: input.productId,
      severity: 'breach',
      peakTenthsC: null,
      minutesOutOfRange: 0,
      quarantine: true,
      detail:
        'no temperature was recorded for a cold-chain batch — an unmeasured cold chain is an unproven one, so it is held rather than assumed good',
      evidence: [],
    };
  }

  const outOfRange = (r: TemperatureReading): boolean =>
    r.tenthsC < input.rule.minTenthsC || r.tenthsC > input.rule.maxTenthsC;

  // Time out of range: each out-of-range reading represents the period until the next
  // reading — the interval it was actually observed over. A trailing out-of-range
  // reading still counts as an observation rather than as zero.
  let minutesOut = 0;
  for (let i = 0; i < readings.length; i += 1) {
    const reading = readings[i]!;
    if (!outOfRange(reading)) continue;
    const next = readings[i + 1];
    minutesOut +=
      next === undefined
        ? 1
        : Math.max(0, (Date.parse(next.at) - Date.parse(reading.at)) / 60_000);
  }

  const excursions = readings.filter(outOfRange);
  const peak = excursions.reduce<number | null>((worst, r) => {
    if (worst === null) return r.tenthsC;
    const distance = (t: number): number =>
      t > input.rule.maxTenthsC ? t - input.rule.maxTenthsC : input.rule.minTenthsC - t;
    return distance(r.tenthsC) > distance(worst) ? r.tenthsC : worst;
  }, null);

  if (excursions.length === 0) {
    return {
      batchId: input.batchId,
      productId: input.productId,
      severity: 'within_range',
      peakTenthsC: null,
      minutesOutOfRange: 0,
      quarantine: false,
      detail: `${readings.length} reading(s), all within ${input.rule.minTenthsC / 10}°C to ${input.rule.maxTenthsC / 10}°C`,
      evidence: readings,
    };
  }

  const breach = minutesOut > input.rule.graceMinutes;
  return {
    batchId: input.batchId,
    productId: input.productId,
    severity: breach ? 'breach' : 'brief_excursion',
    peakTenthsC: peak,
    minutesOutOfRange: minutesOut,
    // Automatic. Not a warning for someone to consider while unloading.
    quarantine: breach,
    detail: breach
      ? `${(peak ?? 0) / 10}°C for ${minutesOut} minutes, beyond the ${input.rule.graceMinutes}-minute grace — the batch is quarantined and the excursion recorded`
      : `${(peak ?? 0) / 10}°C for ${minutesOut} minutes, within the ${input.rule.graceMinutes}-minute grace — noted, not a breach`,
    evidence: excursions,
  };
}

// --- sampling and quality release ------------------------------------------------

export interface QualitySample {
  readonly sampleId: string;
  readonly batchId: string;
  readonly takenBy: string;
  readonly takenAt: string;
  readonly test: string;
  readonly result: 'pass' | 'fail' | 'pending';
  readonly notes?: string;
}

export interface QualityHold {
  readonly batchId: string;
  readonly productId: string;
  readonly status: QualityStatus;
  readonly reason: string;
  readonly heldAt: string;
  readonly heldBy: string;
  readonly releasedAt?: string;
  readonly releasedBy?: string;
}

export type ReleaseRefusal =
  | 'released'
  | 'sample_failed'
  | 'sample_pending'
  | 'cold_chain_breach'
  | 'expired'
  | 'no_releaser'
  | 'not_held';

export interface QualityReleaseResult {
  readonly batchId: string;
  readonly released: boolean;
  readonly outcome: ReleaseRefusal;
  readonly detail: string;
  readonly hold: QualityHold;
}

/**
 * Release a batch for sale. Refused for a failed or outstanding sample, a cold-chain
 * breach, an expired batch, or an unnamed releaser — "it was checked" is not
 * evidence; a name and a time are.
 */
export function releaseFromQualityHold(input: {
  readonly hold: QualityHold;
  readonly samples: readonly QualitySample[];
  readonly coldChain?: ColdChainAssessment;
  readonly expiresOn?: string;
  readonly releasedBy: string;
  readonly at: string;
}): QualityReleaseResult {
  const { hold } = input;
  const base = { batchId: hold.batchId, hold };

  if (hold.status === 'released') {
    return { ...base, released: false, outcome: 'not_held', detail: 'this batch has already been released' };
  }
  if (input.releasedBy.trim() === '') {
    return {
      ...base,
      released: false,
      outcome: 'no_releaser',
      detail: 'a release must be made by a named person — "it was checked" is not evidence',
    };
  }

  const samples = input.samples.filter((s) => s.batchId === hold.batchId);
  const failed = samples.find((s) => s.result === 'fail');
  if (failed) {
    return {
      ...base,
      released: false,
      outcome: 'sample_failed',
      detail: `sample "${failed.test}" failed${failed.notes === undefined ? '' : ` — ${failed.notes}`}; the batch stays held`,
    };
  }
  const pending = samples.find((s) => s.result === 'pending');
  if (pending) {
    return {
      ...base,
      released: false,
      outcome: 'sample_pending',
      detail: `sample "${pending.test}" has not come back yet — releasing now would be a guess`,
    };
  }
  if (input.coldChain?.quarantine === true) {
    return { ...base, released: false, outcome: 'cold_chain_breach', detail: input.coldChain.detail };
  }
  if (input.expiresOn !== undefined && input.expiresOn <= input.at.slice(0, 10)) {
    return {
      ...base,
      released: false,
      outcome: 'expired',
      detail: `the batch expired on ${input.expiresOn} and can never be released`,
    };
  }

  return {
    ...base,
    released: true,
    outcome: 'released',
    detail: `released for sale by ${input.releasedBy}`,
    hold: { ...hold, status: 'released', releasedAt: input.at, releasedBy: input.releasedBy },
  };
}

export interface ColdChainIncident {
  readonly batchId: string;
  readonly productId: string;
  readonly detectedAt: string;
  readonly peakTenthsC: number | null;
  readonly minutesOutOfRange: number;
  /** Kept for an inspection — never deleted (M34-FR-03, hard rule #6). */
  readonly evidence: readonly TemperatureReading[];
  readonly controlId: string;
  readonly detail: string;
}

/**
 * Turn a breach into an incident linked to the control it defeated, so it reaches
 * the compliance register rather than a conversation (M34-FR-04).
 */
export function raiseColdChainIncident(
  assessment: ColdChainAssessment,
  at: string,
  controlId = 'c-cold-chain',
): ColdChainIncident | undefined {
  if (!assessment.quarantine) return undefined;
  return {
    batchId: assessment.batchId,
    productId: assessment.productId,
    detectedAt: at,
    peakTenthsC: assessment.peakTenthsC,
    minutesOutOfRange: assessment.minutesOutOfRange,
    evidence: assessment.evidence,
    controlId,
    detail: assessment.detail,
  };
}
