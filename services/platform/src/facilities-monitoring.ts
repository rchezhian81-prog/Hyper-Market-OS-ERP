// API-11 Facilities — equipment & power monitoring (M26-FR-02 / D14 / M10 / P-08). M10 assesses the
// cold chain of a BATCH; this assesses the EQUIPMENT, which is a different question with a different
// answer: a batch assessment says this crate of chicken is compromised, an equipment assessment says
// the cold room has been drifting for six hours and **everything in it is compromised, including the
// batches nobody probed**. So a breach names the stock it exposes and holds all of it; **a sensor that
// has gone quiet is a fault, not a pass** (`no_data` / `stale` both hold — the probe that fell out of
// the room three weeks ago has read as "no alerts" ever since); IoT is readiness not a dependency, so a
// hand-written log sheet and a sensor feed are assessed identically with the source recorded; and
// **power is assessed by what it protects**, with unprotected minutes counted from the mains failure
// rather than the generator attempt. The rules are the pure `assessEquipment` / `assessPower`.
//
// PA-07: the assessment's `holdStock` is no longer only a word in a GET. Recording a reading that puts
// a room in breach (or a hold check run on a room gone quiet) PLACES the M10 quality hold on every
// batch the room holds, in the same write as the reading — each hold carrying the room, the excursion
// and the reading ids as its evidence. Held stock is then refused by everything that reads the
// quality-hold register (dispatch, transfers) until authorised QC releases it. Idempotent per
// excursion: the same excursion never holds a batch twice, a later separate one holds it again.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  assessEquipment, assessPower, equipmentHoldDecision,
  type EquipmentRange, type EquipmentReading, type ReadingSource, type ExposedBatch,
  type PowerEvent, type PowerEventKind,
} from '../../../packages/facilities/src/index';

import type { QualityHold } from '../../../packages/quality/src/index';

export type { EquipmentReading, ExposedBatch, PowerEvent } from '../../../packages/facilities/src/index';

/** An equipment range as registered on the cloud, carrying the branch and power-protection facts the
 *  pure engine does not model but the power assessment needs. */
export interface EquipmentRangeReg {
  readonly assetId: string;
  readonly branchId: string;
  readonly name: string;
  /** Is this asset wired to a generator/UPS? Feeds `assessPower`'s "what it protects". */
  readonly onBackup: boolean;
  readonly range: EquipmentRange;
}

export interface EquipmentContents {
  readonly assetId: string;
  readonly contents: readonly ExposedBatch[];
}

const SOURCES: readonly ReadingSource[] = ['sensor', 'manual_probe', 'log_sheet'];
const POWER_KINDS: readonly PowerEventKind[] = ['mains_failed', 'mains_restored', 'dg_started', 'dg_failed_to_start', 'ups_on_battery', 'ups_depleted'];

const isDateTime = (s: unknown): s is string => typeof s === 'string' && s.trim() !== '' && !Number.isNaN(Date.parse(s));
const isStr = (s: unknown): s is string => typeof s === 'string' && s.trim() !== '';
const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n);
const isNonNegInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;
const isPosInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;

const readBatches = (v: unknown): ExposedBatch[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const out: ExposedBatch[] = [];
  for (const raw of v) {
    const b = raw as Record<string, unknown>;
    if (!isStr(b['batchId']) || !isStr(b['productId']) || !isNonNegInt(b['valueMinor'])) return undefined;
    out.push({ batchId: b['batchId'] as string, productId: b['productId'] as string, valueMinor: b['valueMinor'] as number });
  }
  return out;
};

export interface FacilitiesMonitoringDeps {
  readonly ranges: (tenantId: string) => Promise<readonly EquipmentRangeReg[]> | readonly EquipmentRangeReg[];
  readonly readings: (tenantId: string) => Promise<readonly EquipmentReading[]> | readonly EquipmentReading[];
  readonly contents: (tenantId: string) => Promise<readonly EquipmentContents[]> | readonly EquipmentContents[];
  readonly powerEvents: (tenantId: string) => Promise<readonly PowerEvent[]> | readonly PowerEvent[];
  readonly recordRange: (tenantId: string, reg: EquipmentRangeReg) => Promise<void> | void;
  /** Record a reading and, in the SAME write, the quality holds it causes (PA-07). */
  readonly recordReading: (tenantId: string, reading: EquipmentReading, holds?: readonly QualityHold[]) => Promise<void> | void;
  /** The current M10 quality hold of a batch — absent where no quality-hold register is wired. */
  readonly qualityHold?: (tenantId: string, batchId: string) => Promise<QualityHold | undefined> | QualityHold | undefined;
  /** Place quality holds found by a hold check (PA-07). */
  readonly recordHolds?: (tenantId: string, holds: readonly QualityHold[]) => Promise<void> | void;
  readonly recordContents: (tenantId: string, contents: EquipmentContents) => Promise<void> | void;
  readonly recordPowerEvent: (tenantId: string, event: PowerEvent) => Promise<void> | void;
  readonly now: () => string;
}

/** The holds a room's current state calls for, skipping a batch already held or already held (and
 *  released) for this same excursion. `extra` is a reading not yet recorded, judged with the rest. */
async function holdsCalledFor(
  deps: FacilitiesMonitoringDeps, tenantId: string, reg: EquipmentRangeReg, heldBy: string, extra?: EquipmentReading,
): Promise<{ readonly decision: ReturnType<typeof equipmentHoldDecision>; readonly holds: readonly QualityHold[] }> {
  const byId = new Map<string, EquipmentReading>();
  for (const r of await deps.readings(tenantId)) byId.set(r.readingId, r);
  if (extra !== undefined) byId.set(extra.readingId, extra);
  const contents = (await deps.contents(tenantId)).find((c) => c.assetId === reg.assetId)?.contents ?? [];
  const at = deps.now();
  const decision = equipmentHoldDecision({ assetId: reg.assetId, range: reg.range, readings: [...byId.values()], contents, asAt: at });
  if (decision.episodeId === null || deps.qualityHold === undefined) return { decision, holds: [] };
  const holds: QualityHold[] = [];
  for (const b of decision.batches) {
    const existing = await deps.qualityHold(tenantId, b.batchId);
    if (existing !== undefined && existing.status !== 'released') continue; // already held — the block is in force
    if (existing?.equipment?.assetId === reg.assetId && existing.equipment.episodeId === decision.episodeId) continue; // released after THIS excursion
    holds.push({
      batchId: b.batchId,
      productId: b.productId,
      status: 'held',
      reason: `${reg.name}: ${decision.detail}`,
      heldAt: at,
      heldBy,
      equipment: {
        assetId: reg.assetId,
        episodeId: decision.episodeId,
        state: decision.state as 'breach' | 'no_data' | 'stale',
        peakTenthsC: decision.peakTenthsC,
        minutesOutOfRange: decision.minutesOutOfRange,
        readingIds: decision.readingIds,
      },
    });
  }
  return { decision, holds };
}

export function facilitiesMonitoringRoutes(deps: FacilitiesMonitoringDeps): readonly Route[] {
  return [
    {
      // Set the acceptable range for a piece of equipment, and whether it is on backup power.
      api: 'API-11', method: 'POST', path: '/v1/facilities/equipment/:assetId/range',
      permission: 'facilities.asset.manage', idempotent: true,
      handler: async (ctx) => {
        const assetId = ctx.params['assetId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isStr(b['branchId']) || !isStr(b['name'])
          || !isInt(b['minTenthsC']) || !isInt(b['maxTenthsC']) || !isNonNegInt(b['graceMinutes'])
          || (b['expectEveryMinutes'] !== undefined && !isPosInt(b['expectEveryMinutes']))
          || (b['onBackup'] !== undefined && typeof b['onBackup'] !== 'boolean')) {
          throw apiError(400, { code: 'not_readable_as_a_range', whatHappened: 'An equipment range needs a branch, a name, a min and max in tenths of a degree, and a grace in minutes.', wasItSaved: 'not_saved', nextSafeAction: 'Send the range fields. Nothing was set.' });
        }
        if ((b['maxTenthsC'] as number) < (b['minTenthsC'] as number)) {
          throw apiError(422, { code: 'range_is_inverted', whatHappened: 'The maximum temperature is below the minimum.', wasItSaved: 'not_saved', nextSafeAction: 'Correct the range. Nothing was set.' });
        }
        const range: EquipmentRange = {
          assetId, minTenthsC: b['minTenthsC'] as number, maxTenthsC: b['maxTenthsC'] as number,
          graceMinutes: b['graceMinutes'] as number,
          ...(isPosInt(b['expectEveryMinutes']) ? { expectEveryMinutes: b['expectEveryMinutes'] } : {}),
        };
        const reg: EquipmentRangeReg = { assetId, branchId: b['branchId'] as string, name: b['name'] as string, onBackup: b['onBackup'] === true, range };
        await deps.recordRange(ctx.tenantId, reg);
        return { status: 201, body: { assetId, branchId: reg.branchId, onBackup: reg.onBackup } };
      },
    },
    {
      // Record a reading — from a sensor, a manual probe or a log sheet, assessed identically (D14),
      // the source kept so nobody mistakes a hand-written 4°C for a metered one.
      api: 'API-11', method: 'POST', path: '/v1/facilities/equipment/:assetId/readings/:readingId',
      permission: 'facilities.reading.record', idempotent: true,
      handler: async (ctx) => {
        const assetId = ctx.params['assetId'] ?? '';
        const readingId = ctx.params['readingId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isInt(b['tenthsC']) || !isDateTime(b['at']) || !SOURCES.includes(b['source'] as ReadingSource) || !isStr(b['recordedBy'])) {
          throw apiError(400, { code: 'not_readable_as_a_reading', whatHappened: 'A reading needs a temperature in tenths of a degree, a timestamp, a source (sensor/manual_probe/log_sheet) and who recorded it.', wasItSaved: 'not_saved', nextSafeAction: 'Send the reading fields. Nothing was recorded.' });
        }
        const reg = (await deps.ranges(ctx.tenantId)).find((r) => r.assetId === assetId);
        if (reg === undefined) throw notFound(`facilities equipment ${assetId}`);
        const reading: EquipmentReading = {
          readingId, assetId, tenthsC: b['tenthsC'] as number, at: b['at'] as string,
          source: b['source'] as ReadingSource, recordedBy: b['recordedBy'] as string,
        };
        // PA-07: a reading that puts the room in breach holds what is in it — in the same write.
        const { decision, holds } = await holdsCalledFor(deps, ctx.tenantId, reg, ctx.userId, reading);
        await deps.recordReading(ctx.tenantId, reading, holds);
        return {
          status: 201,
          body: { readingId, assetId, tenthsC: reading.tenthsC, source: reading.source, state: decision.state, heldBatches: holds.map((h) => h.batchId) },
        };
      },
    },
    {
      // Set what is physically in the equipment right now — the batches a breach would expose.
      api: 'API-11', method: 'POST', path: '/v1/facilities/equipment/:assetId/contents',
      permission: 'facilities.asset.manage', idempotent: true,
      handler: async (ctx) => {
        const assetId = ctx.params['assetId'] ?? '';
        const batches = readBatches((ctx.body as { contents?: unknown } | null)?.contents);
        if (batches === undefined) {
          throw apiError(400, { code: 'not_readable_as_contents', whatHappened: 'Contents must be a list of { batchId, productId, valueMinor } — valueMinor a whole number of minor units.', wasItSaved: 'not_saved', nextSafeAction: 'Send { "contents": [...] }. Nothing was set.' });
        }
        if (!(await deps.ranges(ctx.tenantId)).some((r) => r.assetId === assetId)) throw notFound(`facilities equipment ${assetId}`);
        await deps.recordContents(ctx.tenantId, { assetId, contents: batches });
        return { status: 201, body: { assetId, batches: batches.length, valueMinor: batches.reduce((s, x) => s + x.valueMinor, 0) } };
      },
    },
    {
      // Assess one piece of equipment — a breach holds every batch in it, and a silent probe is a fault.
      api: 'API-11', method: 'GET', path: '/v1/facilities/equipment/:assetId',
      permission: 'facilities.asset.read',
      handler: async (ctx) => {
        const assetId = ctx.params['assetId'] ?? '';
        const asAt = ctx.query['asOf'];
        if (!isDateTime(asAt)) throw apiError(400, { code: 'assessment_needs_a_time', whatHappened: 'An equipment assessment needs ?asOf= (a timestamp) to measure silence and excursions against.', wasItSaved: 'not_saved', nextSafeAction: 'Send the timestamp. An assessment reads, it never writes.' });
        const reg = (await deps.ranges(ctx.tenantId)).find((r) => r.assetId === assetId);
        if (reg === undefined) throw notFound(`facilities equipment ${assetId}`);
        const contents = (await deps.contents(ctx.tenantId)).find((c) => c.assetId === assetId)?.contents ?? [];
        const assessment = assessEquipment({ assetId, range: reg.range, readings: await deps.readings(ctx.tenantId), contents, asAt });
        return { status: 200, body: assessment };
      },
    },
    {
      // PA-07: apply the room's current verdict now — a breach no new reading has arrived to show yet, or
      // a probe gone quiet, holds what is in it exactly as a breaching reading would. Run by a person on
      // the facilities round or by a schedule; idempotent per excursion.
      api: 'API-11', method: 'POST', path: '/v1/facilities/equipment/:assetId/hold-check',
      permission: 'facilities.reading.record', idempotent: true,
      handler: async (ctx) => {
        const assetId = ctx.params['assetId'] ?? '';
        const reg = (await deps.ranges(ctx.tenantId)).find((r) => r.assetId === assetId);
        if (reg === undefined) throw notFound(`facilities equipment ${assetId}`);
        const { decision, holds } = await holdsCalledFor(deps, ctx.tenantId, reg, ctx.userId);
        if (holds.length > 0 && deps.recordHolds !== undefined) await deps.recordHolds(ctx.tenantId, holds);
        return { status: 200, body: { assetId, state: decision.state, detail: decision.detail, heldBatches: holds.map((h) => h.batchId) } };
      },
    },
    {
      // Record a power event — mains, generator or UPS.
      api: 'API-11', method: 'POST', path: '/v1/facilities/power/:eventId',
      permission: 'facilities.reading.record', idempotent: true,
      handler: async (ctx) => {
        const eventId = ctx.params['eventId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isStr(b['branchId']) || !POWER_KINDS.includes(b['kind'] as PowerEventKind) || !isDateTime(b['at'])
          || (b['note'] !== undefined && !isStr(b['note']))) {
          throw apiError(400, { code: 'not_readable_as_a_power_event', whatHappened: 'A power event needs a branch, a kind (mains_failed/mains_restored/dg_started/dg_failed_to_start/ups_on_battery/ups_depleted) and a timestamp.', wasItSaved: 'not_saved', nextSafeAction: 'Send the event fields. Nothing was recorded.' });
        }
        const event: PowerEvent = {
          eventId, branchId: b['branchId'] as string, kind: b['kind'] as PowerEventKind, at: b['at'] as string,
          ...(isStr(b['note']) ? { note: b['note'] } : {}),
        };
        await deps.recordPowerEvent(ctx.tenantId, event);
        return { status: 201, body: { eventId, branchId: event.branchId, kind: event.kind } };
      },
    },
    {
      // Assess power by WHAT IT PROTECTS — unprotected minutes counted from the mains failure, and the
      // critical assets with no backup behind them named. Critical assets are the equipment on this
      // branch that has a range registered (a cold-chain asset that matters).
      api: 'API-11', method: 'GET', path: '/v1/facilities/power',
      permission: 'facilities.asset.read',
      handler: async (ctx) => {
        const branchId = ctx.query['branchId'];
        const asAt = ctx.query['asOf'];
        if (!isStr(branchId) || !isDateTime(asAt)) throw apiError(400, { code: 'power_needs_branch_and_time', whatHappened: 'A power assessment needs ?branchId= and ?asOf= (a timestamp).', wasItSaved: 'not_saved', nextSafeAction: 'Send both. An assessment reads, it never writes.' });
        const criticalAssets = (await deps.ranges(ctx.tenantId))
          .filter((r) => r.branchId === branchId)
          .map((r) => ({ assetId: r.assetId, name: r.name, onBackup: r.onBackup }));
        const assessment = assessPower({ branchId, events: await deps.powerEvents(ctx.tenantId), criticalAssets, asAt });
        return { status: 200, body: assessment };
      },
    },
  ];
}
