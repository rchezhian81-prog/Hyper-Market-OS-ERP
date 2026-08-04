// Equipment monitoring — cold rooms, refrigeration and power (M26-FR-02 / D14 / M10 / P-08).
//
// M10 already assesses the cold chain of a **batch**. This module watches the **equipment**,
// which is a different question with a different answer: a batch assessment tells you that
// this crate of chicken is compromised; an equipment assessment tells you the cold room has
// been drifting for six hours and *everything in it* is compromised, including the batches
// nobody has probed.
//
// That is the whole reason this exists separately. The store's habit is to probe a few
// batches; the room is what actually fails.
//
//   • **A BREACH NAMES THE STOCK IT EXPOSES.** An equipment alert that says "cold room 2 out
//     of range" gets acknowledged and forgotten. One that says *"cold room 2 has been above
//     8°C for 4 hours and there are 11 batches worth ₹1,84,000 in it"* gets acted on, and
//     the batches go to M10 as a quality hold rather than being discovered at the count.
//   • **A SENSOR THAT HAS GONE QUIET IS A FAULT, NOT A PASS.** The dangerous failure is not
//     a high reading, it is no reading — the probe that fell out of the room three weeks ago
//     and has been silently "fine" ever since. Silence is reported as `no_data`, loudly.
//   • **IoT IS READINESS, NOT A DEPENDENCY** (D14). Readings arrive from a probe, a manual
//     log sheet or a sensor feed; the assessment is identical, and the source is recorded so
//     nobody mistakes a hand-written 4°C for a metered one.
//   • **POWER IS ASSESSED BY WHAT IT PROTECTS.** A DG that failed to start is not an
//     equipment note, it is the cold room's clock starting.
//
// Pure and deterministic: the clock is injected, no I/O.

export type ReadingSource = 'sensor' | 'manual_probe' | 'log_sheet';

export interface EquipmentReading {
  readonly readingId: string;
  readonly assetId: string;
  /** Degrees Celsius in tenths, as an integer: 83 is 8.3°C. Same convention as M10. */
  readonly tenthsC: number;
  readonly at: string;
  readonly source: ReadingSource;
  readonly recordedBy: string;
}

export interface EquipmentRange {
  readonly assetId: string;
  readonly minTenthsC: number;
  readonly maxTenthsC: number;
  /** How long it may sit outside the range before it is a breach. A door open for 90
   *  seconds is not a breach; four hours is. */
  readonly graceMinutes: number;
  /** How long a silence before the monitoring itself is treated as failed. Default 120. */
  readonly expectEveryMinutes?: number;
}

export type EquipmentState = 'within_range' | 'drifting' | 'breach' | 'no_data' | 'stale';

export interface ExposedBatch {
  readonly batchId: string;
  readonly productId: string;
  readonly valueMinor: number;
}

export interface EquipmentAssessment {
  readonly assetId: string;
  readonly state: EquipmentState;
  readonly peakTenthsC: number | null;
  readonly minutesOutOfRange: number;
  readonly minutesSinceLastReading: number | null;
  readonly source: ReadingSource | 'none';
  /** Batches sitting in this equipment right now — what the breach actually costs. */
  readonly exposedBatches: readonly ExposedBatch[];
  readonly exposedValueMinor: number;
  /** True when the stock in here must go to M10 as a quality hold, not be assumed good. */
  readonly holdStock: boolean;
  readonly evidence: readonly EquipmentReading[];
  readonly detail: string;
}

const MINUTE_MS = 60_000;

/**
 * Assess one piece of equipment from its readings, and **name the stock it exposes**.
 *
 * Silence is the failure people miss: a probe that fell out of the room three weeks ago has
 * been reporting nothing and reading as "no alerts" ever since. `no_data` and `stale` are
 * therefore states in their own right, and both hold the stock — an unmeasured cold chain is
 * an unproven one, which is the same rule the goods-in door and the packing bench apply.
 */
export function assessEquipment(input: {
  readonly assetId: string;
  readonly range: EquipmentRange;
  readonly readings: readonly EquipmentReading[];
  /** What is physically in this equipment now. */
  readonly contents?: readonly ExposedBatch[];
  readonly asAt: string;
}): EquipmentAssessment {
  const readings = input.readings
    .filter((r) => r.assetId === input.assetId)
    .sort((a, b) => a.at.localeCompare(b.at));

  const exposedBatches = input.contents ?? [];
  const exposedValueMinor = exposedBatches.reduce((s, b) => s + b.valueMinor, 0);
  const contentsPhrase =
    exposedBatches.length === 0
      ? 'nothing is in it'
      : `${exposedBatches.length} batch(es) worth ${exposedValueMinor} are in it`;

  const base = {
    assetId: input.assetId,
    exposedBatches,
    exposedValueMinor,
    evidence: readings,
  };

  if (readings.length === 0) {
    return {
      ...base,
      state: 'no_data',
      peakTenthsC: null,
      minutesOutOfRange: 0,
      minutesSinceLastReading: null,
      source: 'none',
      holdStock: exposedBatches.length > 0,
      detail: `NO reading has ever been taken from ${input.assetId} — silence is not a pass, and ${contentsPhrase}`,
    };
  }

  const last = readings[readings.length - 1]!;
  const minutesSinceLastReading = Math.max(
    0,
    Math.round((Date.parse(input.asAt) - Date.parse(last.at)) / MINUTE_MS),
  );
  const expectEvery = input.range.expectEveryMinutes ?? 120;

  if (minutesSinceLastReading > expectEvery) {
    return {
      ...base,
      state: 'stale',
      peakTenthsC: last.tenthsC,
      minutesOutOfRange: 0,
      minutesSinceLastReading,
      source: last.source,
      holdStock: exposedBatches.length > 0,
      detail: `${input.assetId} has not reported for ${minutesSinceLastReading} minute(s) against a ${expectEvery}-minute expectation — a probe that has gone quiet reads as "no alerts" forever, and ${contentsPhrase}`,
    };
  }

  const outOfRange = (r: EquipmentReading): boolean =>
    r.tenthsC < input.range.minTenthsC || r.tenthsC > input.range.maxTenthsC;

  // Each out-of-range reading stands for the interval it was observed over — the same
  // method M10 uses on a batch, so the two numbers can be compared.
  let minutesOutOfRange = 0;
  for (let i = 0; i < readings.length; i += 1) {
    const reading = readings[i]!;
    if (!outOfRange(reading)) continue;
    const next = readings[i + 1];
    const endMs = next === undefined ? Date.parse(input.asAt) : Date.parse(next.at);
    minutesOutOfRange += Math.max(0, Math.round((endMs - Date.parse(reading.at)) / MINUTE_MS));
  }

  const excursions = readings.filter(outOfRange);
  const peakTenthsC =
    excursions.length === 0
      ? readings.reduce((p, r) => (Math.abs(r.tenthsC) > Math.abs(p) ? r.tenthsC : p), readings[0]!.tenthsC)
      : excursions.reduce(
          (p, r) =>
            Math.abs(r.tenthsC - input.range.maxTenthsC) > Math.abs(p - input.range.maxTenthsC) ? r.tenthsC : p,
          excursions[0]!.tenthsC,
        );

  if (minutesOutOfRange === 0) {
    return {
      ...base,
      state: 'within_range',
      peakTenthsC,
      minutesOutOfRange: 0,
      minutesSinceLastReading,
      source: last.source,
      holdStock: false,
      detail: `${input.assetId} in range, last read ${minutesSinceLastReading} minute(s) ago by ${last.source.replace(/_/g, ' ')}`,
    };
  }

  if (minutesOutOfRange <= input.range.graceMinutes) {
    return {
      ...base,
      state: 'drifting',
      peakTenthsC,
      minutesOutOfRange,
      minutesSinceLastReading,
      source: last.source,
      holdStock: false,
      detail: `${input.assetId} was out of range for ${minutesOutOfRange} minute(s), inside its ${input.range.graceMinutes}-minute grace — worth a look at the door seal, not a hold`,
    };
  }

  return {
    ...base,
    state: 'breach',
    peakTenthsC,
    minutesOutOfRange,
    minutesSinceLastReading,
    source: last.source,
    holdStock: exposedBatches.length > 0,
    detail: `${input.assetId} has been out of range for ${minutesOutOfRange} minute(s), peaking at ${(peakTenthsC / 10).toFixed(1)}°C — ${contentsPhrase} and every one of them is held, including the ones nobody probed`,
  };
}

export type PowerEventKind = 'mains_failed' | 'mains_restored' | 'dg_started' | 'dg_failed_to_start' | 'ups_on_battery' | 'ups_depleted';

export interface PowerEvent {
  readonly eventId: string;
  readonly branchId: string;
  readonly kind: PowerEventKind;
  readonly at: string;
  readonly note?: string;
}

export interface PowerAssessment {
  readonly branchId: string;
  readonly onBackup: boolean;
  readonly unprotectedMinutes: number;
  /** Assets that lost power with no backup behind them. */
  readonly assetsAtRisk: readonly string[];
  readonly severity: 'normal' | 'on_backup' | 'unprotected';
  readonly detail: string;
}

/**
 * Assess the power position **by what it protects**, not by what the generator did.
 *
 * "DG failed to start" is an equipment note. *"The cold room has had no power for 47
 * minutes"* is the sentence that gets somebody into the store. Unprotected minutes are
 * counted from the mains failure, not from when the DG was tried, because the stock does not
 * care which piece of equipment let it down.
 */
export function assessPower(input: {
  readonly branchId: string;
  readonly events: readonly PowerEvent[];
  readonly criticalAssets: readonly { readonly assetId: string; readonly name: string; readonly onBackup: boolean }[];
  readonly asAt: string;
}): PowerAssessment {
  const events = input.events
    .filter((e) => e.branchId === input.branchId)
    .sort((a, b) => a.at.localeCompare(b.at));

  let outageStartedAt: string | undefined;
  let backupHolding = false;
  let unprotectedMinutes = 0;

  const closeOutage = (untilIso: string): void => {
    if (outageStartedAt === undefined) return;
    if (!backupHolding) {
      unprotectedMinutes += Math.max(
        0,
        Math.round((Date.parse(untilIso) - Date.parse(outageStartedAt)) / MINUTE_MS),
      );
    }
    outageStartedAt = undefined;
    backupHolding = false;
  };

  for (const event of events) {
    switch (event.kind) {
      case 'mains_failed':
        outageStartedAt ??= event.at;
        break;
      case 'dg_started':
      case 'ups_on_battery':
        if (outageStartedAt !== undefined && !backupHolding) {
          unprotectedMinutes += Math.max(
            0,
            Math.round((Date.parse(event.at) - Date.parse(outageStartedAt)) / MINUTE_MS),
          );
          // The clock stops here, so restart it from this instant if backup later fails.
          outageStartedAt = event.at;
          backupHolding = true;
        }
        break;
      case 'dg_failed_to_start':
      case 'ups_depleted':
        backupHolding = false;
        outageStartedAt ??= event.at;
        break;
      case 'mains_restored':
        closeOutage(event.at);
        break;
    }
  }

  const live = outageStartedAt !== undefined;
  if (live && !backupHolding) closeOutage(input.asAt);

  const assetsAtRisk = live && !backupHolding ? input.criticalAssets.filter((a) => !a.onBackup).map((a) => a.name) : [];

  const severity: PowerAssessment['severity'] = !live ? 'normal' : backupHolding ? 'on_backup' : 'unprotected';

  return {
    branchId: input.branchId,
    onBackup: backupHolding,
    unprotectedMinutes,
    assetsAtRisk,
    severity,
    detail:
      severity === 'normal'
        ? unprotectedMinutes === 0
          ? 'mains normal, nothing lost'
          : `mains normal now; ${unprotectedMinutes} minute(s) were spent with no power and no backup during this window`
        : severity === 'on_backup'
          ? `running on backup${unprotectedMinutes === 0 ? '' : ` after ${unprotectedMinutes} unprotected minute(s)`} — check fuel before it becomes the other kind of problem`
          : `NO power and NO backup for ${unprotectedMinutes} minute(s)${assetsAtRisk.length === 0 ? '' : `: ${assetsAtRisk.join(', ')}`} — the stock does not care which piece of equipment let it down`,
  };
}
