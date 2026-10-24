// API-11 Platform — the CAPACITY REPORT (M35-FR-04 "capacity planning" · roadmap §32 "Capacity — size after audit for 2×
// expected peak, with 12-month headroom — Capacity report" · "Stage 1 must replace 'audited scale/peak' with MEASURED …
// volumes" · P-08 — OB-288 P5).
//
// What the system is sized for is only meaningful against what the shop actually does. So the report MEASURES the shop's
// own peaks from head office's records (bills per day and per busiest hour, online orders per day, products, tills,
// people with access), doubles each (§32: 2× the peak), carries it 12 months forward at the growth the owner expects, and
// sets it against what the operator says the installation is provisioned for:
//
//   • a measure the records cannot yet show (no sales in the window) is NOT KNOWN — never a zero;
//   • the growth rate and the provisioned capacity are a person's numbers, entered on the plan (`PUT
//     /v1/platform/capacity-plan`) — until entered each is "not set" and the verdict for that measure is not known;
//   • a measure whose 12-month target exceeds what is provisioned is SHORT, named — the owner decides what to do.
//
// The plan is versioned and append-only. Pure fold below; the adapter measures.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';

export const CAPACITY_MEASURES = ['bills_per_day', 'bills_per_peak_hour', 'online_orders_per_day', 'products', 'lanes', 'people_with_access'] as const;
export type CapacityMeasure = (typeof CAPACITY_MEASURES)[number];

export const CAPACITY_WORDS: Readonly<Record<CapacityMeasure, { readonly en: string; readonly ta: string }>> = Object.freeze({
  bills_per_day: { en: 'Bills on the busiest day', ta: 'அதிக வேலை நாளின் பில்கள்' },
  bills_per_peak_hour: { en: 'Bills in the busiest hour', ta: 'அதிக வேலை நேரத்தின் பில்கள்' },
  online_orders_per_day: { en: 'Online orders on the busiest day', ta: 'அதிக வேலை நாளின் இணைய ஆர்டர்கள்' },
  products: { en: 'Products in the catalogue', ta: 'பட்டியலில் உள்ள பொருட்கள்' },
  lanes: { en: 'Tills (lanes) trading', ta: 'விற்பனை செய்யும் கவுண்டர்கள்' },
  people_with_access: { en: 'People with a sign-in', ta: 'உள்நுழைவு உள்ளவர்கள்' },
});

/** The headroom multiple §32 names: size for twice the measured peak. */
export const PEAK_MULTIPLE = 2;

export interface CapacityPlan {
  /** The growth the owner expects over the next 12 months, in whole percent. Null: not set. */
  readonly growthPercentPerYear: number | null;
  /** What the installation is provisioned for, per measure. A measure left out, or null: not set. */
  readonly provisioned: Readonly<Partial<Record<CapacityMeasure, number | null>>>;
  readonly version: number;
  readonly setBy: string;
  readonly setAt: string;
}

export interface MeasuredVolume {
  /** The measured peak, or null when the records cannot show it yet. */
  readonly peak: number | null;
  /** Where it was measured from, in words. */
  readonly basis: string;
}

export interface CapacityRow {
  readonly measure: CapacityMeasure;
  readonly words: { readonly en: string; readonly ta: string };
  readonly measuredPeak: number | null;
  readonly basis: string;
  /** 2 × the measured peak (§32). */
  readonly twicePeak: number | null;
  /** 2 × the peak carried 12 months forward at the owner's growth rate. */
  readonly target12Months: number | null;
  readonly provisioned: number | null;
  readonly verdict: 'ok' | 'short' | 'not_known';
  readonly why: string;
}

/** The report from what was measured and the plan. Pure; whole numbers, rounded up (a capacity is never rounded down). */
export function capacityReport(measured: Readonly<Record<CapacityMeasure, MeasuredVolume>>, plan: CapacityPlan | undefined): readonly CapacityRow[] {
  const growth = plan?.growthPercentPerYear ?? null;
  return CAPACITY_MEASURES.map((measure) => {
    const m = measured[measure];
    const twice = m.peak === null ? null : m.peak * PEAK_MULTIPLE;
    const target = twice === null || growth === null ? null : Math.ceil((twice * (100 + growth)) / 100);
    const provisioned = plan?.provisioned[measure] ?? null;
    const why = m.peak === null ? `not known yet: ${m.basis}`
      : growth === null ? 'the expected growth over 12 months is not set'
        : provisioned === null ? 'what the installation is provisioned for is not set'
          : target! <= provisioned ? `provisioned for ${provisioned}, the 12-month target is ${target}` : `SHORT: the 12-month target is ${target}, but it is provisioned for ${provisioned}`;
    return {
      measure, words: CAPACITY_WORDS[measure], measuredPeak: m.peak, basis: m.basis, twicePeak: twice, target12Months: target, provisioned,
      verdict: target === null || provisioned === null ? 'not_known' : target <= provisioned ? 'ok' : 'short', why,
    };
  });
}

export interface CapacityDeps {
  readonly measure: (tenantId: string, windowDays: number) => Promise<Readonly<Record<CapacityMeasure, MeasuredVolume>>>;
  readonly plan: (tenantId: string) => Promise<CapacityPlan | undefined>;
  readonly recordPlan: (tenantId: string, plan: CapacityPlan) => Promise<void>;
  readonly now: () => string;
}

const isWhole = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const WINDOW_DAYS = 90;

export function capacityRoutes(deps: CapacityDeps): readonly Route[] {
  return [
    {
      api: 'API-11', method: 'GET', path: '/v1/platform/capacity-report',
      permission: 'platform.health.read',
      handler: async (ctx) => {
        const [measured, plan] = await Promise.all([deps.measure(ctx.tenantId, WINDOW_DAYS), deps.plan(ctx.tenantId)]);
        const rows = capacityReport(measured, plan);
        return {
          status: 200,
          body: {
            rows, windowDays: WINDOW_DAYS, peakMultiple: PEAK_MULTIPLE, plan: plan ?? null,
            short: rows.filter((r) => r.verdict === 'short').map((r) => r.measure),
            notKnown: rows.filter((r) => r.verdict === 'not_known').map((r) => r.measure),
            detail: 'Measured over the last 90 days of head office\'s own records; sized for twice the peak with 12 months of growth (§32).',
            asAt: deps.now(),
          },
        };
      },
    },
    {
      // The plan: { growthPercentPerYear (whole percent or null), provisioned: { <measure>: whole number or null } }.
      api: 'API-11', method: 'PUT', path: '/v1/platform/capacity-plan',
      permission: 'platform.service.manage', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const prov = b['provisioned'];
        const okGrowth = b['growthPercentPerYear'] === null || (isWhole(b['growthPercentPerYear']) && (b['growthPercentPerYear'] as number) <= 1000);
        const okProv = prov !== null && typeof prov === 'object' && !Array.isArray(prov)
          && Object.entries(prov as Record<string, unknown>).every(([k, v]) => (CAPACITY_MEASURES as readonly string[]).includes(k) && (v === null || isWhole(v)));
        if (!okGrowth || !okProv) {
          throw apiError(400, { code: 'not_readable_as_a_capacity_plan', whatHappened: `A capacity plan is { growthPercentPerYear (whole percent, or null for not set), provisioned: { ${CAPACITY_MEASURES.join(' / ')}: a whole number, or null } }.`, wasItSaved: 'not_saved', nextSafeAction: 'Send the expected growth and what the installation is provisioned for. Nothing was changed.' });
        }
        const prior = await deps.plan(ctx.tenantId);
        const plan: CapacityPlan = {
          growthPercentPerYear: b['growthPercentPerYear'] as number | null, provisioned: prov as Partial<Record<CapacityMeasure, number | null>>,
          version: (prior?.version ?? 0) + 1, setBy: ctx.userId, setAt: deps.now(),
        };
        await deps.recordPlan(ctx.tenantId, plan);
        return { status: 200, body: { plan } };
      },
    },
  ];
}
