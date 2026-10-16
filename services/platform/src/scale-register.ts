// API-11 Facilities — the weighing-scale register the store pack carries to the lanes (roadmap v2.1 B6 · B7 ·
// Legal Metrology · hard rules #1, #2, #6).
//
// `facilities-metrology.ts` answers "is this stamp current?" for a date someone types. A lane needs that answer for ITS
// scale, with no network (hard rule #1) — so head office keeps the register of the store's weighing scales: the Legal
// Metrology fields B7 names (model-approval number, capacity, last stamping, re-verification due) and the lanes each one
// weighs for. The store pack carries it as `weighingScales` (`services/api/src/r2-till-adapters.ts`), and the till and
// its store computer refuse a weighed line on a lane whose scale stamp has lapsed (`packages/restricted-sales/src/
// till-gate.ts`). Every change is a NEW version (append-only), kept with who set it and when, and written to the audit
// trail. Restating a scale (a re-stamp, a move to another lane) is the only way its date changes.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import { weighingScaleVerification } from '../../../packages/facilities/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { wallClockIn } from '../../../packages/calendar/src/trading-day';

/** One weighing scale on the register, as set at head office. */
export interface WeighingScaleRecord {
  readonly assetId: string;
  readonly storeId: string;
  /** The lanes this scale weighs for (may be empty — a scale that is not at a till). */
  readonly laneIds: readonly string[];
  readonly approvalNo: string;
  readonly capacityGrams: number;
  readonly lastStampedOn: string;
  /** The last day the stamp is valid (YYYY-MM-DD). */
  readonly reverificationDueOn: string;
  readonly version: number;
  readonly setBy: string;
  readonly setAt: string;
}

export interface ScaleRegisterDeps {
  readonly now: () => string;
  /** Every version ever set (the register folds to the latest per scale). */
  readonly scaleVersions: (tenantId: string) => Promise<readonly WeighingScaleRecord[]>;
  readonly recordScale: (tenantId: string, r: WeighingScaleRecord) => Promise<void>;
  /** The stores head office knows (id → name). Absent → not checked. */
  readonly stores?: (tenantId: string) => Promise<ReadonlyMap<string, string>>;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}

/** The latest version of each scale — the register as it stands. */
export function foldScaleRegister(versions: readonly WeighingScaleRecord[]): readonly WeighingScaleRecord[] {
  const latest = new Map<string, WeighingScaleRecord>();
  for (const v of versions) {
    const held = latest.get(v.assetId);
    if (held === undefined || v.version > held.version) latest.set(v.assetId, v);
  }
  return [...latest.values()].sort((a, b) => a.assetId.localeCompare(b.assetId));
}

/** The store pack's `weighingScales` section for one store: what each lane's till is told (B6). */
export function weighingScalesSection(register: readonly WeighingScaleRecord[], storeId: string): readonly Record<string, unknown>[] {
  return register.filter((s) => s.storeId === storeId).map((s) => ({
    assetId: s.assetId, laneIds: [...s.laneIds], approvalNo: s.approvalNo, capacityGrams: s.capacityGrams,
    lastStampedOn: s.lastStampedOn, reverificationDueOn: s.reverificationDueOn, version: s.version,
  }));
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (v: unknown): v is string => typeof v === 'string' && DAY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00.000Z`));
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

export function scaleRegisterRoutes(deps: ScaleRegisterDeps): readonly Route[] {
  return [
    {
      // Put a weighing scale on the register, or restate it — a new version each time (append-only).
      api: 'API-11', method: 'POST', path: '/v1/facilities/scales/:assetId',
      permission: 'facilities.asset.manage', idempotent: true,
      handler: async (ctx) => {
        const assetId = (ctx.params['assetId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const problems: string[] = [];
        if (assetId === '') problems.push('the scale\'s asset id (in the address) is required');
        if (!nonEmpty(b['storeId'])) problems.push('storeId is required');
        if (!nonEmpty(b['approvalNo'])) problems.push('approvalNo (the Legal Metrology model-approval number) is required');
        if (!(typeof b['capacityGrams'] === 'number' && Number.isSafeInteger(b['capacityGrams']) && b['capacityGrams'] > 0)) problems.push('capacityGrams must be a whole number of grams above zero');
        if (!isDay(b['lastStampedOn'])) problems.push('lastStampedOn must be a date YYYY-MM-DD');
        if (!isDay(b['reverificationDueOn'])) problems.push('reverificationDueOn must be a date YYYY-MM-DD');
        if (isDay(b['lastStampedOn']) && isDay(b['reverificationDueOn']) && b['reverificationDueOn'] < b['lastStampedOn']) problems.push('reverificationDueOn cannot be before lastStampedOn');
        const lanes = b['laneIds'];
        if (!Array.isArray(lanes) || !lanes.every(nonEmpty)) problems.push('laneIds must be a list of lane ids (it may be empty)');
        if (problems.length > 0) {
          throw apiError(400, {
            code: 'not_readable_as_a_scale',
            whatHappened: `The scale could not be recorded: ${problems.join('; ')}.`,
            wasItSaved: 'not_saved', nextSafeAction: 'Send every field as described. Nothing was saved.',
          });
        }
        const storeId = (b['storeId'] as string).trim();
        if (deps.stores !== undefined && !(await deps.stores(ctx.tenantId)).has(storeId)) throw notFound(`store ${storeId}`);
        const current = foldScaleRegister(await deps.scaleVersions(ctx.tenantId)).find((s) => s.assetId === assetId);
        const record: WeighingScaleRecord = {
          assetId, storeId, laneIds: [...new Set((lanes as string[]).map((l) => l.trim()))],
          approvalNo: (b['approvalNo'] as string).trim(), capacityGrams: b['capacityGrams'] as number,
          lastStampedOn: b['lastStampedOn'] as string, reverificationDueOn: b['reverificationDueOn'] as string,
          version: (current?.version ?? 0) + 1, setBy: ctx.userId, setAt: deps.now(),
        };
        await deps.recordScale(ctx.tenantId, record);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'facilities.scale.set', objectType: 'weighing_scale', objectId: assetId,
          at: record.setAt, origin: { tenantId: ctx.tenantId, branchId: storeId },
          before: current === undefined ? null : { storeId: current.storeId, reverificationDueOn: current.reverificationDueOn, laneIds: current.laneIds.join(','), version: String(current.version) },
          after: { storeId: record.storeId, reverificationDueOn: record.reverificationDueOn, laneIds: record.laneIds.join(','), version: String(record.version) },
          correlationId: assetId,
        });
        const verification = weighingScaleVerification({ reverificationDueOn: record.reverificationDueOn }, wallClockIn(deps.now()).slice(0, 10));
        return { status: current === undefined ? 201 : 200, body: { scale: record, verification } };
      },
    },
    {
      // The register (for one store, or all), each scale with whether its stamp is current today — what its lanes are told.
      api: 'API-11', method: 'GET', path: '/v1/facilities/scales',
      permission: 'facilities.asset.read',
      handler: async (ctx) => {
        const storeId = typeof ctx.query['storeId'] === 'string' && ctx.query['storeId'] !== '' ? ctx.query['storeId'] : undefined;
        const today = wallClockIn(deps.now()).slice(0, 10);
        const register = foldScaleRegister(await deps.scaleVersions(ctx.tenantId)).filter((s) => storeId === undefined || s.storeId === storeId);
        return {
          status: 200,
          body: { asOf: today, scales: register.map((s) => ({ ...s, verification: weighingScaleVerification({ reverificationDueOn: s.reverificationDueOn }, today) })) },
        };
      },
    },
  ];
}
