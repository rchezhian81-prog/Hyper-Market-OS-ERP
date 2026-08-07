// API-11 Facilities — assets, downtime & energy (M26-FR-01 / M26-FR-04 / §35). A hypermarket is a
// building full of machines that lose money quietly: the chiller that runs two degrees warm does not
// stop, it shortens the life of everything inside it, and the shop finds out at the shrinkage count.
// So this surface refuses to flatten the story. **Criticality is a property of the asset, not of the
// alert** — the cold room comes back in its own list, never sorted in beside a shelf trolley where it
// gets missed. **An expired AMC is reported against what it protects in money**, because "AMC-14
// expired" gets ignored and "₹8,00,000 of stock depends on it" gets renewed. And **downtime is
// measured from when it BROKE, not from when it was reported** — an hour reported four hours late is a
// five-hour cold-chain exposure, and the unreported minutes are a number of their own. The rules are
// the pure `assessAssets` / `summariseDowntime` / `reportEnergy` in `packages/facilities`.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  assessAssets, summariseDowntime, reportEnergy,
  type Asset, type AssetKind, type AssetCriticality,
  type ServiceLog, type DowntimeEvent, type EnergyReading,
} from '../../../packages/facilities/src/index';

export type { Asset, ServiceLog, DowntimeEvent, EnergyReading } from '../../../packages/facilities/src/index';

const KINDS: readonly AssetKind[] = ['refrigeration', 'cold_room', 'freezer', 'power_ups', 'power_dg', 'pos_hardware', 'weighing', 'fire_safety', 'handling', 'other'];
const CRITICALITIES: readonly AssetCriticality[] = ['critical', 'important', 'routine'];
const SERVICE_KINDS: readonly ServiceLog['kind'][] = ['preventive', 'breakdown', 'inspection'];
const ENERGY_SOURCES: readonly EnergyReading['source'][] = ['meter', 'bill', 'estimate'];

const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00.000Z`));
const isDateTime = (s: unknown): s is string => typeof s === 'string' && s.trim() !== '' && !Number.isNaN(Date.parse(s));
const isStr = (s: unknown): s is string => typeof s === 'string' && s.trim() !== '';
const isNonNegInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;
const isPosInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;
const isNonNegNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

export interface FacilitiesAssetsDeps {
  readonly assets: (tenantId: string) => Promise<readonly Asset[]> | readonly Asset[];
  readonly services: (tenantId: string) => Promise<readonly ServiceLog[]> | readonly ServiceLog[];
  readonly downtime: (tenantId: string) => Promise<readonly DowntimeEvent[]> | readonly DowntimeEvent[];
  readonly energyReadings: (tenantId: string) => Promise<readonly EnergyReading[]> | readonly EnergyReading[];
  readonly recordAsset: (tenantId: string, asset: Asset) => Promise<void> | void;
  readonly recordService: (tenantId: string, service: ServiceLog) => Promise<void> | void;
  readonly recordDowntime: (tenantId: string, event: DowntimeEvent) => Promise<void> | void;
  readonly recordEnergy: (tenantId: string, readingId: string, reading: EnergyReading) => Promise<void> | void;
  readonly now: () => string;
}

export function facilitiesAssetsRoutes(deps: FacilitiesAssetsDeps): readonly Route[] {
  return [
    {
      // Register (or restate) an asset — what it is, how critical, and what value depends on it.
      api: 'API-11', method: 'POST', path: '/v1/facilities/assets/:assetId',
      permission: 'facilities.asset.manage', idempotent: true,
      handler: async (ctx) => {
        const assetId = ctx.params['assetId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isStr(b['branchId']) || !isStr(b['name'])
          || !KINDS.includes(b['kind'] as AssetKind) || !CRITICALITIES.includes(b['criticality'] as AssetCriticality)
          || !isDate(b['installedOn'])
          || (b['warrantyUntil'] !== undefined && !isDate(b['warrantyUntil']))
          || (b['amcUntil'] !== undefined && !isDate(b['amcUntil']))
          || (b['amcVendor'] !== undefined && !isStr(b['amcVendor']))
          || (b['serviceEveryDays'] !== undefined && !isPosInt(b['serviceEveryDays']))
          || (b['protectsValueMinor'] !== undefined && !isNonNegInt(b['protectsValueMinor']))) {
          throw apiError(400, {
            code: 'not_readable_as_an_asset',
            whatHappened: 'An asset needs a branch, a name, a kind, a criticality (critical/important/routine) and an install date; AMC, warranty, service interval and protected value are optional but must be well formed.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the asset fields. Nothing was registered.',
          });
        }
        const asset: Asset = {
          assetId, tenantId: ctx.tenantId, branchId: b['branchId'] as string, name: b['name'] as string,
          kind: b['kind'] as AssetKind, criticality: b['criticality'] as AssetCriticality,
          installedOn: b['installedOn'] as string, active: b['active'] !== false,
          ...(isDate(b['warrantyUntil']) ? { warrantyUntil: b['warrantyUntil'] } : {}),
          ...(isDate(b['amcUntil']) ? { amcUntil: b['amcUntil'] } : {}),
          ...(isStr(b['amcVendor']) ? { amcVendor: b['amcVendor'] } : {}),
          ...(isPosInt(b['serviceEveryDays']) ? { serviceEveryDays: b['serviceEveryDays'] } : {}),
          ...(isNonNegInt(b['protectsValueMinor']) ? { protectsValueMinor: b['protectsValueMinor'] } : {}),
        };
        await deps.recordAsset(ctx.tenantId, asset);
        return { status: 201, body: { assetId, kind: asset.kind, criticality: asset.criticality, active: asset.active } };
      },
    },
    {
      // Record a service. **A breakdown call is not preventive maintenance** — the kind is recorded
      // and only preventive/inspection reset the service clock, so a chiller nursed through breakdowns
      // still reads as overdue for the service it never actually had.
      api: 'API-11', method: 'POST', path: '/v1/facilities/assets/:assetId/services/:serviceId',
      permission: 'facilities.asset.manage', idempotent: true,
      handler: async (ctx) => {
        const assetId = ctx.params['assetId'] ?? '';
        const serviceId = ctx.params['serviceId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isDate(b['performedOn']) || !isStr(b['performedBy']) || !SERVICE_KINDS.includes(b['kind'] as ServiceLog['kind'])
          || (b['costMinor'] !== undefined && !isNonNegInt(b['costMinor']))
          || (b['notes'] !== undefined && !isStr(b['notes']))) {
          throw apiError(400, { code: 'not_readable_as_a_service', whatHappened: 'A service log needs a date, who did it, and a kind (preventive/breakdown/inspection).', wasItSaved: 'not_saved', nextSafeAction: 'Send the service fields. Nothing was logged.' });
        }
        if (!(await deps.assets(ctx.tenantId)).some((a) => a.assetId === assetId)) throw notFound(`facilities asset ${assetId}`);
        const service: ServiceLog = {
          serviceId, assetId, performedOn: b['performedOn'] as string, performedBy: b['performedBy'] as string,
          kind: b['kind'] as ServiceLog['kind'],
          ...(isStr(b['notes']) ? { notes: b['notes'] } : {}),
          ...(isNonNegInt(b['costMinor']) ? { costMinor: b['costMinor'] } : {}),
        };
        await deps.recordService(ctx.tenantId, service);
        return { status: 201, body: { serviceId, assetId, kind: service.kind, performedOn: service.performedOn } };
      },
    },
    {
      // Record (or close out) a downtime event. **Measured from when it FAILED, not from when it was
      // reported** — so failedAt and reportedAt are both required and the gap between them is kept.
      api: 'API-11', method: 'POST', path: '/v1/facilities/assets/:assetId/downtime/:eventId',
      permission: 'facilities.asset.manage', idempotent: true,
      handler: async (ctx) => {
        const assetId = ctx.params['assetId'] ?? '';
        const eventId = ctx.params['eventId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isDateTime(b['failedAt']) || !isDateTime(b['reportedAt'])
          || (b['restoredAt'] !== undefined && !isDateTime(b['restoredAt']))
          || (b['cause'] !== undefined && !isStr(b['cause']))) {
          throw apiError(400, { code: 'not_readable_as_downtime', whatHappened: 'A downtime event needs when it failed and when it was reported (both timestamps); restore time and cause are optional.', wasItSaved: 'not_saved', nextSafeAction: 'Send failedAt and reportedAt. Nothing was recorded.' });
        }
        if (b['restoredAt'] !== undefined && Date.parse(b['restoredAt'] as string) < Date.parse(b['failedAt'] as string)) {
          throw apiError(422, { code: 'restored_before_it_failed', whatHappened: 'The restore time is earlier than the failure time, which cannot be right.', wasItSaved: 'not_saved', nextSafeAction: 'Correct the timestamps. Nothing was recorded.' });
        }
        if (!(await deps.assets(ctx.tenantId)).some((a) => a.assetId === assetId)) throw notFound(`facilities asset ${assetId}`);
        const event: DowntimeEvent = {
          eventId, assetId, failedAt: b['failedAt'] as string, reportedAt: b['reportedAt'] as string,
          ...(isDateTime(b['restoredAt']) ? { restoredAt: b['restoredAt'] } : {}),
          ...(isStr(b['cause']) ? { cause: b['cause'] } : {}),
        };
        await deps.recordDowntime(ctx.tenantId, event);
        return { status: 201, body: { eventId, assetId, stillDown: event.restoredAt === undefined } };
      },
    },
    {
      // Asset health on a date — critical assets in their OWN list, never sorted in beside the trolley.
      api: 'API-11', method: 'GET', path: '/v1/facilities/assets/health',
      permission: 'facilities.asset.read',
      handler: async (ctx) => {
        const branchId = ctx.query['branchId'];
        const asAt = ctx.query['asOf'];
        if (!isStr(branchId) || !isDate(asAt)) throw apiError(400, { code: 'health_needs_branch_and_date', whatHappened: 'Asset health needs ?branchId= and ?asOf=YYYY-MM-DD.', wasItSaved: 'not_saved', nextSafeAction: 'Send both. A report reads, it never writes.' });
        const warnRaw = ctx.query['warnWithinDays'];
        const warnWithinDays = warnRaw !== undefined && /^\d+$/.test(warnRaw) ? Number(warnRaw) : undefined;
        const health = assessAssets({ branchId, assets: await deps.assets(ctx.tenantId), services: await deps.services(ctx.tenantId), asAt, ...(warnWithinDays !== undefined ? { warnWithinDays } : {}) });
        return { status: 200, body: health };
      },
    },
    {
      // Downtime summarised from failure, with unreported minutes stated on the face of it.
      api: 'API-11', method: 'GET', path: '/v1/facilities/assets/downtime',
      permission: 'facilities.asset.read',
      handler: async (ctx) => {
        const asAt = ctx.query['asOf'];
        if (!isDateTime(asAt)) throw apiError(400, { code: 'downtime_needs_a_time', whatHappened: 'The downtime summary needs ?asOf= (a timestamp) to close open events against.', wasItSaved: 'not_saved', nextSafeAction: 'Send the timestamp. A summary reads, it never writes.' });
        const summaries = summariseDowntime({ assets: await deps.assets(ctx.tenantId), events: await deps.downtime(ctx.tenantId), asAt });
        return { status: 200, body: { summaries, stillDown: summaries.filter((s) => s.stillDown).length, asOf: asAt } };
      },
    },
    {
      // Record an energy reading, keeping its source (meter/bill/estimate) so the report can say how
      // much of the total was GUESSED — because the figure will be quoted in a decision about a chiller.
      api: 'API-11', method: 'POST', path: '/v1/facilities/energy/:readingId',
      permission: 'facilities.asset.manage', idempotent: true,
      handler: async (ctx) => {
        const readingId = ctx.params['readingId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isStr(b['branchId']) || !isDate(b['onDate']) || !isNonNegNum(b['kilowattHours']) || !isNonNegInt(b['costMinor'])
          || !ENERGY_SOURCES.includes(b['source'] as EnergyReading['source'])
          || (b['assetId'] !== undefined && !isStr(b['assetId']))) {
          throw apiError(400, { code: 'not_readable_as_a_reading', whatHappened: 'An energy reading needs a branch, a date, kilowatt-hours, a cost in minor units, and a source (meter/bill/estimate).', wasItSaved: 'not_saved', nextSafeAction: 'Send the reading fields. Nothing was recorded.' });
        }
        const reading: EnergyReading = {
          branchId: b['branchId'] as string, onDate: b['onDate'] as string,
          kilowattHours: b['kilowattHours'] as number, costMinor: b['costMinor'] as number,
          source: b['source'] as EnergyReading['source'],
          ...(isStr(b['assetId']) ? { assetId: b['assetId'] } : {}),
        };
        await deps.recordEnergy(ctx.tenantId, readingId, reading);
        return { status: 201, body: { readingId, branchId: reading.branchId, onDate: reading.onDate, source: reading.source } };
      },
    },
    {
      // Energy over a window, with the ESTIMATED share on the face of it.
      api: 'API-11', method: 'GET', path: '/v1/facilities/energy',
      permission: 'facilities.asset.read',
      handler: async (ctx) => {
        const branchId = ctx.query['branchId'];
        const from = ctx.query['from'];
        const to = ctx.query['to'];
        if (!isStr(branchId) || !isDate(from) || !isDate(to)) throw apiError(400, { code: 'energy_needs_branch_and_window', whatHappened: 'The energy report needs ?branchId=, ?from=YYYY-MM-DD and ?to=YYYY-MM-DD.', wasItSaved: 'not_saved', nextSafeAction: 'Send all three. A report reads, it never writes.' });
        const report = reportEnergy({ branchId, readings: await deps.energyReadings(ctx.tenantId), from, to });
        return { status: 200, body: report };
      },
    },
  ];
}
