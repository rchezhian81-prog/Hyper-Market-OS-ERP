// API-09 Finance — GST pulled out of a tax-inclusive MRP (roadmap v2.1 A9 + A8).
//
// In Indian retail the printed price IS the MRP, tax already inside it. The back office needs the tax
// pulled BACK OUT — to render a manual tax invoice, to print a shelf/label price breakdown, to verify a
// supplier's inclusive figure — and it must be the SAME extraction everywhere, computed once on the
// server, not re-implemented per screen. This is that one authoritative calculator, thin over the tested
// `extractInclusiveGst` engine: taxable + tax reconcile to the MRP to the paisa, split CGST+SGST for an
// intra-State supply or IGST for an inter-State one.
//
// It is a STATELESS read — it folds no ledger, so it needs no deps and no store. The offline till does
// NOT call this (a sale never depends on the network, hard rule #1); it has its own copy of the same
// rule. This surface is the back office's, so it is gated on a finance read (`finance.period.read`:
// owner / manager / accountant), not the cashier's till permissions.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  extractInclusiveGst, roundToNearestRupee, assessDiscountEligibility,
  bogoTreatment, freeSampleTreatment, voucherTimeOfSupply, resolveGstRate,
  InvalidInclusiveTaxInput, InvalidPromoTaxInput, InvalidRateSchedule,
  type PlaceOfSupply, type GstRatePeriod,
} from '../../../packages/finance/src/index';

const isIntString = (s: unknown): s is string => typeof s === 'string' && /^\d+$/.test(s);
const isBool = (s: unknown): boolean => s === 'true'; // an explicit 'true'; anything else is false

export function taxRoutes(): readonly Route[] {
  return [
    {
      // Pull the GST out of a tax-inclusive MRP. ?mrpMinor=&rateBps=&placeOfSupply=intra_state|inter_state
      api: 'API-09', method: 'GET', path: '/v1/finance/tax/from-mrp',
      permission: 'finance.period.read',
      handler: async (ctx) => {
        const mrp = ctx.query['mrpMinor'];
        const rate = ctx.query['rateBps'];
        const place = ctx.query['placeOfSupply'];
        if (!isIntString(mrp) || !isIntString(rate)) {
          throw apiError(400, {
            code: 'tax_from_mrp_needs_figures',
            whatHappened: 'Extracting GST needs ?mrpMinor=<whole paisa> and ?rateBps=<whole basis points> (e.g. 1800 for 18%).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the MRP and rate. A calculation reads, it never writes.',
          });
        }
        if (place !== 'intra_state' && place !== 'inter_state') {
          throw apiError(400, {
            code: 'tax_from_mrp_needs_place_of_supply',
            whatHappened: 'Extracting GST needs ?placeOfSupply=intra_state (CGST+SGST) or inter_state (IGST) — the split turns on it.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the place of supply.',
          });
        }
        try {
          const breakdown = extractInclusiveGst({
            mrpMinor: Number(mrp), rateBps: Number(rate), placeOfSupply: place as PlaceOfSupply,
          });
          // The exact paisa breakdown (A9) plus the whole-rupee, per-component view (A10) with its
          // round-off stated — so an invoice can print either without re-deriving the rounding.
          return { status: 200, body: { ...breakdown, nearestRupee: roundToNearestRupee(breakdown) } };
        } catch (err) {
          if (err instanceof InvalidInclusiveTaxInput) {
            throw apiError(400, {
              code: 'tax_from_mrp_invalid',
              whatHappened: err.message,
              wasItSaved: 'not_saved',
              nextSafeAction: 'Correct the MRP or rate and try again.',
            });
          }
          throw err;
        }
      },
    },
    {
      // Decide whether a discount reduces the GST taxable value (CGST s.15(3), A11). A commercial
      // discount is real money off the price, but the tax only comes off when it is on the invoice, or
      // — post-supply — pre-agreed AND invoice-linked AND the recipient's ITC is reversed. Same
      // back-office finance gate; charging tax on an ineligible discount under-declares output tax.
      // ?discountMinor=&onInvoice=&preAgreed=&invoiceLinked=&itcReversed= (booleans as literal 'true').
      api: 'API-09', method: 'GET', path: '/v1/finance/tax/discount-eligibility',
      permission: 'finance.period.read',
      handler: async (ctx) => {
        const discount = ctx.query['discountMinor'];
        if (!isIntString(discount)) {
          throw apiError(400, {
            code: 'discount_needs_an_amount',
            whatHappened: 'Assessing a discount needs ?discountMinor=<whole minor units>.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the discount amount. A calculation reads, it never writes.',
          });
        }
        const result = assessDiscountEligibility({
          discountMinor: Number(discount),
          onInvoice: isBool(ctx.query['onInvoice']),
          preAgreed: isBool(ctx.query['preAgreed']),
          invoiceLinked: isBool(ctx.query['invoiceLinked']),
          itcReversed: isBool(ctx.query['itcReversed']),
        });
        return { status: 200, body: result };
      },
    },
    {
      // BOGO (A12 / CBIC 92/2019): a single supply for the paid units — the free units add no extra tax,
      // and the ITC on them is not reversed (they were sold, for a price).
      // ?paidUnits=&freeUnits=&unitConsiderationMinor=
      api: 'API-09', method: 'GET', path: '/v1/finance/tax/bogo',
      permission: 'finance.period.read',
      handler: async (ctx) => {
        const paid = ctx.query['paidUnits'];
        const free = ctx.query['freeUnits'];
        const unit = ctx.query['unitConsiderationMinor'];
        if (!isIntString(paid) || !isIntString(free) || !isIntString(unit)) {
          throw apiError(400, { code: 'bogo_needs_figures', whatHappened: 'A BOGO assessment needs ?paidUnits=&freeUnits=&unitConsiderationMinor= (whole numbers).', wasItSaved: 'not_saved', nextSafeAction: 'Send the paid/free unit counts and the unit consideration.' });
        }
        try {
          return { status: 200, body: bogoTreatment({ paidUnits: Number(paid), freeUnits: Number(free), unitConsiderationMinor: Number(unit) }) };
        } catch (err) {
          if (err instanceof InvalidPromoTaxInput) throw apiError(400, { code: 'bogo_invalid', whatHappened: err.message, wasItSaved: 'not_saved', nextSafeAction: 'Correct the figures and try again.' });
          throw err;
        }
      },
    },
    {
      // A genuine free sample (A12 / s.17(5)(h)): not a supply (no output GST), but the ITC on it must
      // be reversed. ?itcClaimedMinor= (optional — states the reversal amount when known).
      api: 'API-09', method: 'GET', path: '/v1/finance/tax/free-sample',
      permission: 'finance.period.read',
      handler: async (ctx) => {
        const itc = ctx.query['itcClaimedMinor'];
        if (itc !== undefined && !isIntString(itc)) {
          throw apiError(400, { code: 'free_sample_itc_invalid', whatHappened: '?itcClaimedMinor=, if given, must be a whole non-negative amount of minor units.', wasItSaved: 'not_saved', nextSafeAction: 'Send a whole ITC amount or omit it.' });
        }
        return { status: 200, body: freeSampleTreatment(itc === undefined ? {} : { itcClaimedMinor: Number(itc) }) };
      },
    },
    {
      // The time of supply of a voucher (A12 / s.12(4)): issue date if the supply is identifiable at
      // issue, else the redemption date. ?supplyIdentifiableAtIssue=&issueDate=&redemptionDate=
      api: 'API-09', method: 'GET', path: '/v1/finance/tax/voucher-timing',
      permission: 'finance.period.read',
      handler: async (ctx) => {
        const issueDate = ctx.query['issueDate'];
        if (issueDate === undefined) {
          throw apiError(400, { code: 'voucher_needs_issue_date', whatHappened: 'A voucher timing needs ?issueDate=YYYY-MM-DD (and ?redemptionDate= when the supply is not identifiable at issue).', wasItSaved: 'not_saved', nextSafeAction: 'Send the issue date.' });
        }
        try {
          const result = voucherTimeOfSupply({
            supplyIdentifiableAtIssue: isBool(ctx.query['supplyIdentifiableAtIssue']),
            issueDate,
            ...(ctx.query['redemptionDate'] === undefined ? {} : { redemptionDate: ctx.query['redemptionDate'] }),
          });
          return { status: 200, body: result };
        } catch (err) {
          if (err instanceof InvalidPromoTaxInput) throw apiError(400, { code: 'voucher_timing_invalid', whatHappened: err.message, wasItSaved: 'not_saved', nextSafeAction: 'Correct the dates, or supply the redemption date.' });
          throw err;
        }
      },
    },
    {
      // The GST rate in force on the TIME OF SUPPLY (A6), from a per-HSN effective-dated schedule. The
      // schedule is a compact `YYYY-MM-DD:bps,YYYY-MM-DD:bps` list; the resolver picks the rate in force
      // on ?supplyDate= (the new rate applies from the day it takes effect, the day before gets the old).
      // ?schedule=2017-07-01:1800,2026-09-01:4000&supplyDate=2026-08-31
      api: 'API-09', method: 'GET', path: '/v1/finance/tax/rate-on-date',
      permission: 'finance.period.read',
      handler: async (ctx) => {
        const scheduleStr = ctx.query['schedule'];
        const supplyDate = ctx.query['supplyDate'];
        if (typeof scheduleStr !== 'string' || scheduleStr.trim() === '' || supplyDate === undefined) {
          throw apiError(400, { code: 'rate_needs_schedule_and_date', whatHappened: 'Resolving a rate needs ?schedule=YYYY-MM-DD:bps,YYYY-MM-DD:bps and ?supplyDate=YYYY-MM-DD.', wasItSaved: 'not_saved', nextSafeAction: 'Send the effective-dated schedule and the supply date.' });
        }
        // Parse the compact schedule; a malformed pair is refused, never quietly dropped.
        const schedule: GstRatePeriod[] = [];
        for (const pair of scheduleStr.split(',')) {
          const parts = pair.split(':');
          if (parts.length !== 2 || !/^\d+$/.test(parts[1]!)) {
            throw apiError(400, { code: 'rate_schedule_malformed', whatHappened: `A schedule entry must be "YYYY-MM-DD:bps"; "${pair}" is not.`, wasItSaved: 'not_saved', nextSafeAction: 'Fix the schedule entry.' });
          }
          schedule.push({ effectiveFrom: parts[0]!, rateBps: Number(parts[1]) });
        }
        try {
          return { status: 200, body: resolveGstRate({ schedule, supplyDate }) };
        } catch (err) {
          if (err instanceof InvalidRateSchedule) throw apiError(400, { code: 'rate_unresolvable', whatHappened: err.message, wasItSaved: 'not_saved', nextSafeAction: 'Correct the schedule or the supply date.' });
          throw err;
        }
      },
    },
  ];
}
