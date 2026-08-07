// API-04 Waste & sustainability reporting (M28-FR-04). Sustainability reporting has a failure mode
// worth naming: a store reports "waste down 18%" and waste is not down, RECORDING is down — the one
// manager who logged every damaged crate went on leave. Six months on, the shop believes it controls a
// problem it has stopped measuring. So the rule is absolute: **a fall in recorded waste is not a fall
// in waste, and this surface says so.** Coverage — how much of the estate actually reported — sits on
// the FACE of the report, and below 80% the figure is `not_comparable` in those words, the silent
// departments named; a period comparison REFUSES to call a fall an improvement when coverage moved.
// The rule is the pure `buildSustainabilityReport` / `compareWaste` in `packages/waste/src/sustainability.ts`.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  buildSustainabilityReport, compareWaste,
  type WasteRecord, type WasteSource, type CoverageInput,
} from '../../../packages/waste/src/index';

export type { WasteRecord } from '../../../packages/waste/src/index';

/** The coverage expectation plus the human names for departments — folded latest-wins. */
export interface WasteCoverage {
  readonly expected: CoverageInput['expected'];
  readonly departmentNames: Readonly<Record<string, string>>;
}

const SOURCES: readonly WasteSource[] = ['expiry', 'damage', 'shrinkage', 'preparation', 'customer_return', 'recall'];
const DISPOSALS: readonly WasteRecord['disposal'][] = ['landfill', 'recycled', 'donated', 'composted', 'destroyed'];

const isStr = (s: unknown): s is string => typeof s === 'string' && s.trim() !== '';
const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00.000Z`));
const isDateTime = (s: unknown): s is string => typeof s === 'string' && s.trim() !== '' && !Number.isNaN(Date.parse(s));
const isNonNegInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;
const isPosInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;

export interface WasteDeps {
  readonly records: (tenantId: string) => Promise<readonly WasteRecord[]> | readonly WasteRecord[];
  readonly coverage: (tenantId: string) => Promise<WasteCoverage> | WasteCoverage;
  readonly recordWaste: (tenantId: string, record: WasteRecord) => Promise<void> | void;
  readonly recordCoverage: (tenantId: string, coverage: WasteCoverage) => Promise<void> | void;
  readonly now: () => string;
}

export function wasteRoutes(deps: WasteDeps): readonly Route[] {
  return [
    {
      // Record a unit of waste — valued, sourced (expiry/damage/…) and with where it went.
      api: 'API-04', method: 'POST', path: '/v1/waste/records/:wasteId',
      permission: 'inventory.movement.append', idempotent: true,
      handler: async (ctx) => {
        const wasteId = ctx.params['wasteId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isStr(b['branchId']) || !isStr(b['departmentId']) || !isStr(b['productId'])
          || !SOURCES.includes(b['source'] as WasteSource) || !isDateTime(b['at'])
          || !isNonNegInt(b['valueMinor']) || !DISPOSALS.includes(b['disposal'] as WasteRecord['disposal'])
          || (b['grams'] !== undefined && !isPosInt(b['grams']))) {
          throw apiError(400, {
            code: 'not_readable_as_waste',
            whatHappened: 'A waste record needs a branch, a department, a product, a source (expiry/damage/shrinkage/preparation/customer_return/recall), a timestamp, a value in minor units and a disposal (landfill/recycled/donated/composted/destroyed).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the waste fields. Nothing was recorded.',
          });
        }
        const record: WasteRecord = {
          wasteId, branchId: b['branchId'] as string, departmentId: b['departmentId'] as string,
          productId: b['productId'] as string, source: b['source'] as WasteSource, at: b['at'] as string,
          valueMinor: b['valueMinor'] as number, disposal: b['disposal'] as WasteRecord['disposal'],
          ...(isPosInt(b['grams']) ? { grams: b['grams'] } : {}),
        };
        await deps.recordWaste(ctx.tenantId, record);
        return { status: 201, body: { wasteId, source: record.source, valueMinor: record.valueMinor } };
      },
    },
    {
      // Set which branches/departments are EXPECTED to report — the denominator of coverage. Without
      // this, a report cannot tell a quiet department from a clean one. Latest applies.
      api: 'API-04', method: 'POST', path: '/v1/waste/coverage',
      permission: 'inventory.movement.append', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const expectedRaw = b['expected'];
        if (!Array.isArray(expectedRaw) || !expectedRaw.every((e) => isStr((e as Record<string, unknown>)?.['branchId']) && isStr((e as Record<string, unknown>)?.['departmentId']))
          || (b['departmentNames'] !== undefined && (typeof b['departmentNames'] !== 'object' || b['departmentNames'] === null))) {
          throw apiError(400, { code: 'not_readable_as_coverage', whatHappened: 'Coverage needs { expected: [{ branchId, departmentId }] } and optional departmentNames.', wasItSaved: 'not_saved', nextSafeAction: 'Send the expected reporting units. Nothing was set.' });
        }
        const expected = (expectedRaw as { branchId: string; departmentId: string }[]).map((e) => ({ branchId: e.branchId, departmentId: e.departmentId }));
        const namesRaw = (b['departmentNames'] as Record<string, unknown> | undefined) ?? {};
        const departmentNames: Record<string, string> = {};
        for (const [k, v] of Object.entries(namesRaw)) if (typeof v === 'string') departmentNames[k] = v;
        await deps.recordCoverage(ctx.tenantId, { expected, departmentNames });
        return { status: 201, body: { expected: expected.length } };
      },
    },
    {
      // The report — coverage NEXT TO the number, below 80% the total is `not_comparable` and the
      // silent departments are named; a valued breakdown by source and by department.
      api: 'API-04', method: 'GET', path: '/v1/waste/report',
      permission: 'reporting.report.read',
      handler: async (ctx) => {
        const branchId = ctx.query['branchId'];
        const from = ctx.query['from'];
        const to = ctx.query['to'];
        if (!isStr(branchId) || !isDate(from) || !isDate(to)) throw apiError(400, { code: 'report_needs_branch_and_window', whatHappened: 'The waste report needs ?branchId=, ?from=YYYY-MM-DD and ?to=YYYY-MM-DD.', wasItSaved: 'not_saved', nextSafeAction: 'Send all three. A report reads, it never writes.' });
        const cov = await deps.coverage(ctx.tenantId);
        const report = buildSustainabilityReport({
          branchId, from, to, waste: await deps.records(ctx.tenantId),
          coverage: { expected: cov.expected }, departmentNames: cov.departmentNames,
        });
        return { status: 200, body: report };
      },
    },
    {
      // Two windows compared — and it REFUSES to call a fall an improvement when coverage moved. If
      // waste fell but reporting fell with it, the honest answer is "we cannot tell", and it says so.
      api: 'API-04', method: 'GET', path: '/v1/waste/compare',
      permission: 'reporting.report.read',
      handler: async (ctx) => {
        const branchId = ctx.query['branchId'];
        const from1 = ctx.query['from1']; const to1 = ctx.query['to1'];
        const from2 = ctx.query['from2']; const to2 = ctx.query['to2'];
        if (!isStr(branchId) || !isDate(from1) || !isDate(to1) || !isDate(from2) || !isDate(to2)) {
          throw apiError(400, { code: 'compare_needs_two_windows', whatHappened: 'A comparison needs ?branchId= and two windows: ?from1=&to1= and ?from2=&to2= (all YYYY-MM-DD).', wasItSaved: 'not_saved', nextSafeAction: 'Send the branch and both windows. A comparison reads, it never writes.' });
        }
        const cov = await deps.coverage(ctx.tenantId);
        const waste = await deps.records(ctx.tenantId);
        const r1 = buildSustainabilityReport({ branchId, from: from1, to: to1, waste, coverage: { expected: cov.expected }, departmentNames: cov.departmentNames });
        const r2 = buildSustainabilityReport({ branchId, from: from2, to: to2, waste, coverage: { expected: cov.expected }, departmentNames: cov.departmentNames });
        const trend = compareWaste({
          from: { label: `${from1}..${to1}`, valueMinor: r1.totalWasteValueMinor, coverageBps: r1.coverageBps },
          to: { label: `${from2}..${to2}`, valueMinor: r2.totalWasteValueMinor, coverageBps: r2.coverageBps },
        });
        return { status: 200, body: trend };
      },
    },
  ];
}
