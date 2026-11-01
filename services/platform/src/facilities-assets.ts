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
import { apiError, notFound, assertBranchInScope } from '../../kernel/src/index';
import {
  assessAssets, summariseDowntime, reportEnergy, drawProblem, onHandOf, sparesView,
  type Asset, type AssetKind, type AssetCriticality,
  type ServiceLog, type DowntimeEvent, type EnergyReading, type SparePart, type SpareMovement, type DrawProblem,
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
  /** Round 4d (M26-FR-01): the spare-parts register — the latest definition of each part. Absent: no spares are kept. */
  readonly spareParts?: (tenantId: string) => Promise<readonly SparePart[]>;
  /** Every spare-part movement (append-only; on hand is their sum). */
  readonly spareMovements?: (tenantId: string) => Promise<readonly SpareMovement[]>;
  readonly recordSparePart?: (tenantId: string, part: SparePart) => Promise<void>;
  /**
   * Append movements only while `check` holds against the ledger as it then stands — the read and the append guarded as one
   * step, so two services drawing the last part at once cannot both have it (the loser is told, never silently negative).
   * Movements already on the ledger under the same ids are not appended again (a re-sent service draws nothing twice).
   */
  readonly appendSpareMovements?: (tenantId: string, movements: readonly SpareMovement[], check: (parts: readonly SparePart[], movements: readonly SpareMovement[]) => DrawProblem | null) => Promise<DrawProblem | null>;
}

/** A spare-part draw that cannot stand, said by name (nothing was logged). */
function spareRefusal(p: DrawProblem): never {
  const what = p.problem === 'unknown_part' ? `there is no spare part "${p.sparePartId}" in the register`
    : p.problem === 'part_inactive' ? `spare part "${p.sparePartId}" is no longer in use`
      : p.problem === 'not_compatible' ? `spare part "${p.sparePartId}" is not listed as fitting asset ${p.assetId}`
        : `only ${p.onHand} of spare part "${p.sparePartId}" on hand, not ${p.wanted}`;
  const next = p.problem === 'not_enough' ? 'Record the stock received first, or draw what is on hand. Nothing was logged.'
    : p.problem === 'not_compatible' ? 'Add the asset to the assets the part fits, or choose the right part. Nothing was logged.'
      : 'Choose a part from the register. Nothing was logged.';
  throw apiError(p.problem === 'unknown_part' ? 404 : 409, { code: `spare_${p.problem}`, whatHappened: `The spares could not be drawn: ${what}.`, wasItSaved: 'not_saved', nextSafeAction: next });
}

export function facilitiesAssetsRoutes(deps: FacilitiesAssetsDeps): readonly Route[] {
  return [
    ...spareRoutes(deps),
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
        assertBranchInScope(ctx, b['branchId'] as string); // PA-01-r1: only at a branch the caller holds
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
          || (b['notes'] !== undefined && !isStr(b['notes']))
          || (b['sparesUsed'] !== undefined && (!Array.isArray(b['sparesUsed']) || !(b['sparesUsed'] as unknown[]).every(isSpareLine)))) {
          throw apiError(400, { code: 'not_readable_as_a_service', whatHappened: 'A service log needs a date, who did it, and a kind (preventive/breakdown/inspection); spares used, when sent, are [{ sparePartId, qty (a whole number above 0) }].', wasItSaved: 'not_saved', nextSafeAction: 'Send the service fields. Nothing was logged.' });
        }
        const asset = (await deps.assets(ctx.tenantId)).find((a) => a.assetId === assetId);
        if (asset === undefined) throw notFound(`facilities asset ${assetId}`);
        assertBranchInScope(ctx, asset.branchId); // Round 4d: a service is logged only at a branch the caller holds
        const sparesUsed = ((b['sparesUsed'] as { sparePartId: string; qty: number }[] | undefined) ?? []).map((s) => ({ sparePartId: s.sparePartId.trim(), qty: s.qty }));
        // Round 4d (M26-FR-01): the spares a service used are drawn from the register FIRST — refused by name when a part is
        // unknown, does not fit this asset, or is not on hand — and the service is logged only once they are drawn.
        if (sparesUsed.length > 0) {
          if (deps.appendSpareMovements === undefined) throw apiError(409, { code: 'spares_not_kept', whatHappened: 'This shop keeps no spare-parts register, so spares used cannot be drawn.', wasItSaved: 'not_saved', nextSafeAction: 'Log the service without spares. Nothing was logged.' });
          const at = deps.now();
          const draws: SpareMovement[] = [...new Set(sparesUsed.map((s) => s.sparePartId))].map((sparePartId) => ({
            movementId: `used-${serviceId}-${sparePartId}`, sparePartId, kind: 'used' as const,
            qty: -sparesUsed.filter((s) => s.sparePartId === sparePartId).reduce((n, s) => n + s.qty, 0),
            on: b['performedOn'] as string, by: ctx.userId, at, assetId, serviceId,
          }));
          const problem = await deps.appendSpareMovements(ctx.tenantId, draws, (parts, movements) => drawProblem(sparesUsed, assetId, parts, movements));
          if (problem !== null) spareRefusal(problem);
        }
        const service: ServiceLog = {
          serviceId, assetId, performedOn: b['performedOn'] as string, performedBy: b['performedBy'] as string,
          kind: b['kind'] as ServiceLog['kind'],
          ...(isStr(b['notes']) ? { notes: b['notes'] } : {}),
          ...(isNonNegInt(b['costMinor']) ? { costMinor: b['costMinor'] } : {}),
          ...(sparesUsed.length === 0 ? {} : { sparesUsed }),
        };
        await deps.recordService(ctx.tenantId, service);
        return { status: 201, body: { serviceId, assetId, kind: service.kind, performedOn: service.performedOn, sparesUsed } };
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
        assertBranchInScope(ctx, branchId); // PA-01-r1
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
        assertBranchInScope(ctx, b['branchId'] as string); // PA-01-r1: only at a branch the caller holds
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
        assertBranchInScope(ctx, branchId); // PA-01-r1
        const report = reportEnergy({ branchId, readings: await deps.energyReadings(ctx.tenantId), from, to });
        return { status: 200, body: report };
      },
    },
  ];
}

const isSpareLine = (s: unknown): boolean =>
  s !== null && typeof s === 'object' && isStr((s as Record<string, unknown>)['sparePartId']) && isPosInt((s as Record<string, unknown>)['qty']);

// ── Round 4d (M26-FR-01): the spare-parts register ──────────────────────────────────────────────────────────────────────
//   • POST /v1/facilities/spares/:sparePartId — define (or restate) a part: { branchId, name, compatibleAssetIds[],
//     minimumLevel, unit?, active? }. The latest definition is in force; every one stays on the ledger.
//   • POST /v1/facilities/spares/:sparePartId/movements/:movementId — { kind: 'received' | 'correction', qty, on, reason? }:
//     stock received (qty above 0) or a counted correction (either way, with a reason). Never below nought on hand. A use
//     is never typed here: it is drawn by the service it was used on (the service route above).
//   • GET  /v1/facilities/spares?branchId= — every part with what is on hand (the sum of its movements), whether it is
//     low, and its movements. facilities.asset.read.
function spareRoutes(deps: FacilitiesAssetsDeps): readonly Route[] {
  const kept = () => {
    const { spareParts, spareMovements, recordSparePart, appendSpareMovements } = deps;
    if (spareParts === undefined || spareMovements === undefined || recordSparePart === undefined || appendSpareMovements === undefined) {
      throw apiError(409, { code: 'spares_not_kept', whatHappened: 'This shop keeps no spare-parts register.', wasItSaved: 'not_saved', nextSafeAction: 'Nothing was changed.' });
    }
    return { spareParts, spareMovements, recordSparePart, appendSpareMovements };
  };
  return [
    {
      api: 'API-11', method: 'POST', path: '/v1/facilities/spares/:sparePartId',
      permission: 'facilities.asset.manage', idempotent: true,
      handler: async (ctx) => {
        const s = kept();
        const sparePartId = (ctx.params['sparePartId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const compatible = b['compatibleAssetIds'];
        if (sparePartId === '' || !isStr(b['branchId']) || !isStr(b['name']) || (b['name'] as string).length > 200 || !isNonNegInt(b['minimumLevel'])
          || !Array.isArray(compatible) || !compatible.every(isStr) || (b['unit'] !== undefined && !isStr(b['unit']))
          || (b['active'] !== undefined && typeof b['active'] !== 'boolean')) {
          throw apiError(400, { code: 'not_readable_as_a_spare_part', whatHappened: 'A spare part needs a branch, a name, the assets it fits (a list, may be empty) and a minimum level (a whole number, 0 or more); a unit is optional.', wasItSaved: 'not_saved', nextSafeAction: 'Send the part fields. Nothing was set.' });
        }
        const branchId = (b['branchId'] as string).trim();
        assertBranchInScope(ctx, branchId);
        const before = (await s.spareParts(ctx.tenantId)).find((p) => p.sparePartId === sparePartId);
        if (before !== undefined) assertBranchInScope(ctx, before.branchId);
        const assets = await deps.assets(ctx.tenantId);
        const ids = [...new Set((compatible as string[]).map((x) => x.trim()))];
        const strangers = ids.filter((id) => !assets.some((a) => a.assetId === id && a.branchId === branchId));
        if (strangers.length > 0) {
          throw apiError(422, { code: 'spare_fits_unknown_asset', whatHappened: `These are not assets of ${branchId}: ${strangers.join(', ')}.`, wasItSaved: 'not_saved', nextSafeAction: 'Name assets from the register of the same store. Nothing was set.' });
        }
        const part: SparePart = {
          sparePartId, branchId, name: (b['name'] as string).trim(), compatibleAssetIds: ids, minimumLevel: b['minimumLevel'] as number,
          unit: isStr(b['unit']) ? (b['unit'] as string).trim() : 'each', active: b['active'] !== false, definedBy: ctx.userId, definedAt: deps.now(),
        };
        await s.recordSparePart(ctx.tenantId, part);
        return { status: 201, body: { sparePart: part, onHand: onHandOf(sparePartId, await s.spareMovements(ctx.tenantId)) } };
      },
    },
    {
      api: 'API-11', method: 'POST', path: '/v1/facilities/spares/:sparePartId/movements/:movementId',
      permission: 'facilities.asset.manage', idempotent: true,
      handler: async (ctx) => {
        const s = kept();
        const sparePartId = (ctx.params['sparePartId'] ?? '').trim();
        const movementId = (ctx.params['movementId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const kind = b['kind'];
        const qty = b['qty'];
        if (movementId === '' || (kind !== 'received' && kind !== 'correction') || !isDate(b['on']) || typeof qty !== 'number' || !Number.isInteger(qty) || qty === 0
          || (kind === 'received' && qty < 0) || (kind === 'correction' && !isStr(b['reason'])) || (b['reason'] !== undefined && !isStr(b['reason']))) {
          throw apiError(400, { code: 'not_readable_as_a_spare_movement', whatHappened: 'A movement is { kind: "received" (qty above 0) or "correction" (qty either way, with a reason), qty (a whole number, not 0), on (YYYY-MM-DD) }. A use is drawn by the service it was used on.', wasItSaved: 'not_saved', nextSafeAction: 'Send the movement fields. Nothing was recorded.' });
        }
        const part = (await s.spareParts(ctx.tenantId)).find((p) => p.sparePartId === sparePartId);
        if (part === undefined) throw notFound(`spare part ${sparePartId}`);
        assertBranchInScope(ctx, part.branchId);
        const movement: SpareMovement = {
          movementId: `${kind}-${movementId}`, sparePartId, kind, qty, on: b['on'] as string, by: ctx.userId, at: deps.now(),
          ...(isStr(b['reason']) ? { reason: (b['reason'] as string).trim() } : {}),
        };
        // a correction may not take what is on hand below nought (it would be a count nobody could have made)
        const problem = await s.appendSpareMovements(ctx.tenantId, [movement], (_parts, movements) => {
          const onHand = onHandOf(sparePartId, movements);
          return onHand + qty < 0 ? { problem: 'not_enough', sparePartId, onHand, wanted: -qty } : null;
        });
        if (problem !== null) spareRefusal(problem);
        return { status: 201, body: { movement, onHand: onHandOf(sparePartId, await s.spareMovements(ctx.tenantId)) } };
      },
    },
    {
      api: 'API-11', method: 'GET', path: '/v1/facilities/spares',
      permission: 'facilities.asset.read',
      handler: async (ctx) => {
        const branchId = ctx.query['branchId'];
        if (!isStr(branchId)) throw apiError(400, { code: 'spares_need_a_branch', whatHappened: 'The spare-parts register needs ?branchId=.', wasItSaved: 'not_saved', nextSafeAction: 'Send the branch. A read changes nothing.' });
        assertBranchInScope(ctx, branchId);
        if (deps.spareParts === undefined || deps.spareMovements === undefined) return { status: 200, body: { branchId, kept: false, spares: [], low: 0, asAt: deps.now() } };
        const spares = sparesView(await deps.spareParts(ctx.tenantId), await deps.spareMovements(ctx.tenantId), branchId);
        return { status: 200, body: { branchId, kept: true, spares, low: spares.filter((p) => p.low).length, asAt: deps.now() } };
      },
    },
  ];
}
