// API-02 Compensation-cess schedule per HSN (roadmap v2.1 A7 · GST (Compensation to States) Act 2017 · GST 2.0 holdover).
//
// Tobacco and pan-masala are held over on 28% GST PLUS a compensation cess (ad-valorem, specific, or both). The cess a
// product carries is decided by its HSN and the date — so, like the GST rate (`tax-classes.ts`), it is an effective-dated
// SCHEDULE per HSN, and the rates are DATA the owner enters as the CA confirms them (§4 of the full-roadmap audit), never
// code. The catalogue pack carries the cess in force on its build date to every till, signed; the till charges it inside
// the MRP and the bill and the GST return carry it.
//
// Append-only (hard rule #2): a change is a new period from a later date; a different rate on a date that already has one is
// refused as ambiguous; an identical re-send is a no-op. Setting is `catalogue.pack.publish`; reading `catalogue.pack.read`.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { cessRateOn, type CessRatePeriod } from '../../../packages/finance/src/cess';

export interface CessRateDeps {
  readonly setCess: (tenantId: string, hsnCode: string, period: CessRatePeriod, key: string) => Promise<void> | void;
  readonly schedule: (tenantId: string, hsnCode: string) => Promise<readonly CessRatePeriod[]> | readonly CessRatePeriod[];
}

const isDate = (s: unknown): s is string =>
  typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00.000Z`).toISOString().slice(0, 10) === s;
const isWholeNonNeg = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const HSN = /^\d{4,8}$/;

const same = (a: CessRatePeriod, b: CessRatePeriod): boolean =>
  a.advaloremBps === b.advaloremBps && a.specificPerQuantityMinor === b.specificPerQuantityMinor && a.perQuantity === b.perQuantity;

export function cessRateRoutes(deps: CessRateDeps): readonly Route[] {
  return [
    {
      // Set the compensation cess for an HSN from a date. Body: { advaloremBps, specificPerQuantityMinor, perQuantity }.
      // A cess of 0 / 0 from a date is how a cess ENDS — a later period, never a deletion.
      api: 'API-02', method: 'POST', path: '/v1/catalogue/tax-classes/:hsnCode/cess/:effectiveFrom',
      permission: 'catalogue.pack.publish', idempotent: true,
      handler: async (ctx) => {
        const hsnCode = (ctx.params['hsnCode'] ?? '').trim();
        const effectiveFrom = (ctx.params['effectiveFrom'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const specific = b['specificPerQuantityMinor'] ?? 0;
        const block = b['perQuantity'] ?? 1;
        if (!HSN.test(hsnCode) || !isDate(effectiveFrom) || !isWholeNonNeg(b['advaloremBps']) || !isWholeNonNeg(specific)
          || !(Number.isInteger(block) && (block as number) > 0)) {
          throw apiError(400, {
            code: 'not_readable_as_a_cess_rate',
            whatHappened: 'Setting a compensation cess needs an HSN (4–8 digits) and a valid YYYY-MM-DD date in the path, and in the body a whole advaloremBps (basis points of the taxable value, e.g. 3600 for 36%), a whole specificPerQuantityMinor (paisa per block, 0 for none) and a positive whole perQuantity (the block, e.g. 1000 sticks).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send { advaloremBps, specificPerQuantityMinor, perQuantity } with the HSN and date in the URL. Use the rates the CA confirmed. Nothing was saved.',
          });
        }
        const period: CessRatePeriod = { effectiveFrom, advaloremBps: b['advaloremBps'], specificPerQuantityMinor: specific, perQuantity: block as number };
        const existing = (await deps.schedule(ctx.tenantId, hsnCode)).find((p) => p.effectiveFrom === effectiveFrom);
        if (existing !== undefined) {
          if (!same(existing, period)) {
            throw apiError(409, {
              code: 'cess_already_set_on_that_date',
              whatHappened: `HSN "${hsnCode}" already has a compensation cess from ${effectiveFrom}; a different cess cannot also start that day — a sale that day could be taxed two ways.`,
              wasItSaved: 'not_saved',
              nextSafeAction: 'To change the cess, set the new rate from a LATER date. Nothing was changed.',
            });
          }
          return { status: 201, body: { cess: existing } };
        }
        await deps.setCess(ctx.tenantId, hsnCode, period, ctx.idempotencyKey ?? `${hsnCode}:${effectiveFrom}`);
        return { status: 201, body: { cess: period } };
      },
    },
    {
      // The schedule for an HSN, and the cess in force on a date (?on=YYYY-MM-DD) — "none" when not cess-liable then.
      api: 'API-02', method: 'GET', path: '/v1/catalogue/tax-classes/:hsnCode/cess',
      permission: 'catalogue.pack.read',
      handler: async (ctx) => {
        const hsnCode = (ctx.params['hsnCode'] ?? '').trim();
        const on = ctx.query['on'];
        if (!HSN.test(hsnCode) || (on !== undefined && !isDate(on))) {
          throw apiError(400, {
            code: 'not_readable_as_a_cess_rate',
            whatHappened: 'Reading a compensation cess needs an HSN (4–8 digits) in the path, and ?on=YYYY-MM-DD when you ask for the rate on a day.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the HSN, and a valid date if you want the rate in force on it.',
          });
        }
        const schedule = [...await deps.schedule(ctx.tenantId, hsnCode)].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
        const inForce = on === undefined ? undefined : cessRateOn(schedule, on);
        return { status: 200, body: { hsnCode, schedule, ...(on === undefined ? {} : { on, inForce: inForce ?? null, cessLiable: inForce !== undefined }) } };
      },
    },
  ];
}
