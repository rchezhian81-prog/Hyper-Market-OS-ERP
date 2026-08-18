// API-02 Tax-class GST-rate schedule (M03-FR-03 tax side / A6) — the per-HSN, effective-dated GST rate a
// product is taxed at, made durable on the cloud. The product master carries a product's HSN/tax class;
// this store carries what that class attracts and FROM WHEN. It is the last master-data input the catalogue
// pack build needs before an authored product can reach a lane priced and taxed correctly (the snapshot
// builder resolves each product's rate from here at build time).
//
// GST rates change (the 2017 slabs, the GST 2.0 slabs) and the rate that applies is the one in force on the
// TIME OF SUPPLY — so a class is not one rate but an effective-dated SCHEDULE. The rule is the tested
// `resolveGstRate` in `@sre/finance` (the `services-run-on-their-tested-engine` guardrail): it picks the
// latest period on or before a date, and refuses a gap rather than guessing. The slabs are DATA, never
// hard-coded here.
//
// Append-only: a rate change is a new period with a later effective date, never an overwrite (hard rule #2);
// two DIFFERENT rates on the SAME effective date are refused as ambiguous (like the dual-MRP guard). Setting
// a rate is gated `catalogue.pack.publish` — deciding the tax a product carries is catalogue authority;
// reads are `catalogue.pack.read`.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import { resolveGstRate, InvalidRateSchedule, type GstRatePeriod } from '../../../packages/finance/src/rate';

export interface TaxClassRateDeps {
  /** Append a rate period for an HSN/tax class (idempotent on the caller's key). */
  readonly setRate: (tenantId: string, hsnCode: string, period: GstRatePeriod, key: string) => Promise<void> | void;
  readonly schedule: (tenantId: string, hsnCode: string) => Promise<readonly GstRatePeriod[]> | readonly GstRatePeriod[];
}

const isDate = (s: unknown): s is string =>
  typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00.000Z`));
const isWholeNonNeg = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

export function taxClassRoutes(deps: TaxClassRateDeps): readonly Route[] {
  return [
    {
      // Set the GST rate for an HSN/tax class effective from a date. Body: { rateBps: number }.
      api: 'API-02', method: 'POST', path: '/v1/catalogue/tax-classes/:hsnCode/rates/:effectiveFrom',
      permission: 'catalogue.pack.publish', idempotent: true,
      handler: async (ctx) => {
        const hsnCode = (ctx.params['hsnCode'] ?? '').trim();
        const effectiveFrom = (ctx.params['effectiveFrom'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (hsnCode === '' || !isDate(effectiveFrom) || !isWholeNonNeg(b['rateBps'])) {
          throw apiError(400, {
            code: 'not_readable_as_a_tax_rate',
            whatHappened: 'Setting a tax rate needs an HSN/tax class and a valid YYYY-MM-DD effective date in the path, and a whole non-negative rateBps (basis points, e.g. 500 for 5%) in the body.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send { rateBps: 500 } with the HSN and effective date in the URL.',
          });
        }
        const period: GstRatePeriod = { effectiveFrom, rateBps: b['rateBps'] };
        // A rate already recorded for this exact date: a DIFFERENT rate on the same date is a genuine
        // ambiguity (a supply that day could be taxed two ways) and is refused — a change is a NEW period on
        // a LATER date. An IDENTICAL re-send is a harmless no-op: it returns success WITHOUT appending, so
        // the schedule never grows a duplicate effective date (which would itself make resolution ambiguous).
        const existing = (await deps.schedule(ctx.tenantId, hsnCode)).find((p) => p.effectiveFrom === effectiveFrom);
        if (existing !== undefined) {
          if (existing.rateBps !== period.rateBps) {
            throw apiError(409, {
              code: 'rate_already_set_on_that_date',
              whatHappened: `HSN "${hsnCode}" already has a rate of ${existing.rateBps} bps effective ${effectiveFrom}; a different rate (${period.rateBps} bps) cannot also take effect that day — a supply then could be taxed two ways.`,
              wasItSaved: 'not_saved',
              nextSafeAction: 'To change the rate, set the new rate from a LATER effective date. Nothing was changed.',
            });
          }
          return { status: 201, body: { rate: existing } }; // idempotent: already set to this exact rate
        }
        await deps.setRate(ctx.tenantId, hsnCode, period, ctx.idempotencyKey ?? `${hsnCode}:${effectiveFrom}`);
        return { status: 201, body: { rate: period } };
      },
    },
    {
      // Resolve the rate in force for an HSN on a date (?on=YYYY-MM-DD, defaults to none → 400).
      api: 'API-02', method: 'GET', path: '/v1/catalogue/tax-classes/:hsnCode/rate',
      permission: 'catalogue.pack.read',
      handler: async (ctx) => {
        const hsnCode = (ctx.params['hsnCode'] ?? '').trim();
        const on = ctx.query['on'];
        if (!isDate(on)) {
          throw apiError(400, {
            code: 'not_readable_as_a_tax_rate',
            whatHappened: 'Resolving a tax rate needs the supply date as ?on=YYYY-MM-DD — the rate depends on when the supply happens.',
            wasItSaved: 'unknown',
            nextSafeAction: 'Add ?on=2026-08-18 (the supply date) to the request.',
          });
        }
        const schedule = await deps.schedule(ctx.tenantId, hsnCode);
        if (schedule.length === 0) throw notFound(`tax rate schedule for HSN ${hsnCode}`);
        try {
          const resolved = resolveGstRate({ schedule, supplyDate: on });
          return { status: 200, body: { rate: resolved } };
        } catch (err) {
          if (err instanceof InvalidRateSchedule) {
            // A gap (a date before the earliest period) is answered by extending the schedule, never a guess.
            throw apiError(422, {
              code: 'no_rate_in_force',
              whatHappened: `No GST rate is in force for HSN "${hsnCode}" on ${on}: ${err.message}.`,
              wasItSaved: 'unknown',
              nextSafeAction: 'Set a rate effective on or before that date, then resolve again.',
            });
          }
          throw err;
        }
      },
    },
    {
      // The whole effective-dated schedule for an HSN — the history a person curating tax classes reviews.
      api: 'API-02', method: 'GET', path: '/v1/catalogue/tax-classes/:hsnCode/rates',
      permission: 'catalogue.pack.read',
      handler: async (ctx) => {
        const hsnCode = (ctx.params['hsnCode'] ?? '').trim();
        const schedule = [...(await deps.schedule(ctx.tenantId, hsnCode))]
          .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
        return { status: 200, body: { hsnCode, schedule, count: schedule.length } };
      },
    },
  ];
}
