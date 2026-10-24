// API-11 Facilities — the OFFICE screen's reads and the store computer's readings (OB-288 · audit-3 package 5 ·
// M26-FR-01 "an AMC nearing expiry alerts; a service log ties to the asset" · M26-FR-02 "readings cache/queue offline" ·
// M26-FR-04 "downtime/energy report computes; a safety incident is tracked with evidence").
//
//   • `GET /v1/facilities/office?branchId&asOf` — everything the facilities page shows for a branch in ONE read, each part
//     from the facilities engines head office already runs: the asset register (each asset's warranty, AMC and last
//     service), the health alerts (critical first), every monitored room or cabinet with its range, its last reading and
//     its state (a quiet probe is a fault, never a pass), the downtime summary, the energy over the last 30 days with its
//     estimated share, and the facility incidents (open first).
//   • `GET /v1/facilities/equipment-feed?branchId` — the monitored equipment of a store and its ranges, for the store
//     computer: the facilities page it serves offers a manual reading for each with the line down.
//   • `POST /v1/facilities/equipment/:assetId/readings/:readingId/synced` — a manual reading taken on that page and carried
//     by the store computer. The person is re-checked from THEIR grants; the reading is then recorded by the SAME route
//     a head-office reading uses (the breach places the quality holds in the same write), timed by when it was taken.
//
// Reads only, apart from the relayed reading. Nothing here clears an alert or closes an incident (P-05).

import type { Route, RequestContext, HandlerResult } from '../../kernel/src/index';
import { apiError, assertBranchInScope, ApiError } from '../../kernel/src/index';
import {
  assessAssets, summariseDowntime, reportEnergy, assessEquipment,
  type Asset, type ServiceLog, type DowntimeEvent, type EnergyReading, type EquipmentReading,
} from '../../../packages/facilities/src/index';
import type { SafetyIncident } from '../../../packages/facilities/src/schedules';
import type { EquipmentRangeReg, EquipmentContents } from './facilities-monitoring';

export interface FacilitiesOfficeDeps {
  readonly assets: (tenantId: string) => Promise<readonly Asset[]>;
  readonly services: (tenantId: string) => Promise<readonly ServiceLog[]>;
  readonly downtime: (tenantId: string) => Promise<readonly DowntimeEvent[]>;
  readonly energyReadings: (tenantId: string) => Promise<readonly EnergyReading[]>;
  readonly ranges: (tenantId: string) => Promise<readonly EquipmentRangeReg[]>;
  readonly readings: (tenantId: string) => Promise<readonly EquipmentReading[]>;
  readonly contents: (tenantId: string) => Promise<readonly EquipmentContents[]>;
  readonly incidents: (tenantId: string) => Promise<readonly SafetyIncident[]>;
  readonly permissionsOf: (tenantId: string, userId: string) => Promise<readonly string[] | undefined>;
  /** The head-office reading route's own handler — the relayed reading goes through exactly it. */
  readonly recordReadingAs: (ctx: RequestContext) => Promise<HandlerResult>;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const isTime = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(v));
const DAY_MS = 86_400_000;
const SOURCES = ['manual_probe', 'log_sheet'] as const;

export function facilitiesOfficeRoutes(deps: FacilitiesOfficeDeps): readonly Route[] {
  return [
    {
      api: 'API-11', method: 'GET', path: '/v1/facilities/office',
      permission: 'facilities.asset.read',
      handler: async (ctx) => {
        const branchId = ctx.query['branchId'];
        if (!isStr(branchId)) throw apiError(400, { code: 'office_needs_a_branch', whatHappened: 'The facilities office read needs ?branchId= (and optionally ?asOf=YYYY-MM-DD).', wasItSaved: 'not_saved', nextSafeAction: 'Send the branch. A read changes nothing.' });
        assertBranchInScope(ctx, branchId);
        const now = deps.now();
        const day = isDay(ctx.query['asOf']) ? ctx.query['asOf']! : now.slice(0, 10);
        const at = isDay(ctx.query['asOf']) ? `${day}T23:59:59.999Z` : now;
        const [assets, services, downtime, energy, ranges, readings, contents, incidents] = await Promise.all([
          deps.assets(ctx.tenantId), deps.services(ctx.tenantId), deps.downtime(ctx.tenantId), deps.energyReadings(ctx.tenantId),
          deps.ranges(ctx.tenantId), deps.readings(ctx.tenantId), deps.contents(ctx.tenantId), deps.incidents(ctx.tenantId),
        ]);
        const mine = assets.filter((a) => a.branchId === branchId);
        const register = mine.map((a) => {
          const last = services.filter((s) => s.assetId === a.assetId).map((s) => s.performedOn).sort().at(-1) ?? null;
          return {
            assetId: a.assetId, name: a.name, kind: a.kind, criticality: a.criticality, installedOn: a.installedOn, active: a.active,
            warrantyUntil: a.warrantyUntil ?? null, amcUntil: a.amcUntil ?? null, amcVendor: a.amcVendor ?? null,
            serviceEveryDays: a.serviceEveryDays ?? null, lastServicedOn: last, protectsValueMinor: a.protectsValueMinor ?? null,
          };
        }).sort((x, y) => (x.criticality === y.criticality ? x.assetId.localeCompare(y.assetId) : x.criticality === 'critical' ? -1 : y.criticality === 'critical' ? 1 : x.criticality === 'important' ? -1 : 1));
        const equipment = ranges.filter((r) => r.branchId === branchId).map((r) => {
          const a = assessEquipment({ assetId: r.assetId, range: r.range, readings, contents: contents.find((c) => c.assetId === r.assetId)?.contents ?? [], asAt: at });
          const last = readings.filter((x) => x.assetId === r.assetId).sort((x, y) => x.at.localeCompare(y.at)).at(-1) ?? null;
          return { assetId: r.assetId, name: r.name, onBackup: r.onBackup, range: r.range, lastReading: last, assessment: a };
        }).sort((x, y) => x.assetId.localeCompare(y.assetId));
        const from = new Date(Date.parse(day) - 29 * DAY_MS).toISOString().slice(0, 10);
        return {
          status: 200,
          body: {
            branchId, asOf: day,
            assets: register,
            health: assessAssets({ branchId, assets, services, asAt: day }),
            equipment,
            downtime: summariseDowntime({ assets: mine, events: downtime.filter((d) => mine.some((a) => a.assetId === d.assetId)), asAt: at }),
            energy: reportEnergy({ branchId, readings: energy, from, to: day }),
            incidents: incidents.filter((i) => i.branchId === branchId)
              .map((i) => ({ incidentId: i.incidentId, kind: i.kind, severity: i.severity, occurredAt: i.occurredAt, reportedBy: i.reportedBy, description: i.description, evidence: i.evidenceRefs?.length ?? 0, assetId: i.assetId ?? null, open: i.closedAt === undefined, actionTaken: i.actionTaken ?? null, closedAt: i.closedAt ?? null }))
              .sort((x, y) => Number(y.open) - Number(x.open) || y.occurredAt.localeCompare(x.occurredAt)),
            asAt: now,
          },
        };
      },
    },
    {
      // The store's monitored equipment and ranges — the store computer's feed for its offline facilities page.
      api: 'API-11', method: 'GET', path: '/v1/facilities/equipment-feed',
      permission: 'facilities.asset.read',
      handler: async (ctx) => {
        const branchId = ctx.query['branchId'];
        if (!isStr(branchId)) throw apiError(400, { code: 'feed_needs_a_branch', whatHappened: 'The equipment feed needs ?branchId=.', wasItSaved: 'not_saved', nextSafeAction: 'Send the branch.' });
        assertBranchInScope(ctx, branchId);
        const [ranges, readings] = await Promise.all([deps.ranges(ctx.tenantId), deps.readings(ctx.tenantId)]);
        const equipment = ranges.filter((r) => r.branchId === branchId).map((r) => ({
          assetId: r.assetId, name: r.name, branchId: r.branchId, range: r.range,
          lastReadingAt: readings.filter((x) => x.assetId === r.assetId).map((x) => x.at).sort().at(-1) ?? null,
        })).sort((x, y) => x.assetId.localeCompare(y.assetId));
        return { status: 200, body: { branchId, equipment, asAt: deps.now() } };
      },
    },
    {
      // A manual reading taken on the store computer's facilities page. Body: { assetId, readingId, tenthsC, at, source,
      // recordedBy, storeId }. The person is re-checked; then the head-office route records it (and any holds).
      api: 'API-11', method: 'POST', path: '/v1/facilities/equipment/:assetId/readings/:readingId/synced',
      permission: 'facilities.reading.sync', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (b['assetId'] !== ctx.params['assetId'] || b['readingId'] !== ctx.params['readingId'] || !Number.isInteger(b['tenthsC']) || !isTime(b['at'])
          || !(SOURCES as readonly unknown[]).includes(b['source']) || !isStr(b['recordedBy'])) {
          throw apiError(400, {
            code: 'not_readable_as_a_relayed_reading',
            whatHappened: 'A relayed reading needs assetId and readingId matching the address, a whole temperature in tenths of a degree, when it was taken (at), its source (manual_probe / log_sheet) and who took it.',
            wasItSaved: 'not_saved', nextSafeAction: 'Do not discard it at the store. Keep it in the queue and raise it.',
          });
        }
        if (Date.parse(b['at'] as string) > Date.parse(deps.now()) + 5 * 60_000) {
          throw apiError(422, { code: 'reading_in_the_future', whatHappened: 'The reading is timed after head office\'s clock — the store computer\'s clock may be wrong.', wasItSaved: 'not_saved', nextSafeAction: 'Check the store computer\'s clock; keep the reading at the store and raise it.' });
        }
        const held = (await deps.permissionsOf(ctx.tenantId, b['recordedBy'] as string)) ?? [];
        if (!held.includes('facilities.reading.record')) {
          throw apiError(403, { code: 'person_may_not_record_readings', whatHappened: `${String(b['recordedBy'])} holds no right to record equipment readings here (re-checked from their own grants).`, wasItSaved: 'not_saved', nextSafeAction: 'Keep it at the store; a person must look. Nothing was recorded.' });
        }
        try {
          return await deps.recordReadingAs({
            ...ctx, userId: b['recordedBy'] as string,
            params: { assetId: b['assetId'] as string, readingId: b['readingId'] as string },
            body: { tenthsC: b['tenthsC'], at: b['at'], source: b['source'], recordedBy: b['recordedBy'] },
          });
        } catch (e) {
          // An equipment head office does not have is a refusal by name (kept at the store), never a lost reading.
          if (e instanceof ApiError && e.status === 404) throw apiError(422, { code: 'equipment_not_known', whatHappened: `Head office has no monitored equipment ${String(b['assetId'])}.`, wasItSaved: 'not_saved', nextSafeAction: 'Keep it at the store; register the equipment\'s range, then it can be recorded.' });
          throw e;
        }
      },
    },
  ];
}
