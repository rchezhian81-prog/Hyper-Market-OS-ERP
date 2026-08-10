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
import { extractInclusiveGst, roundToNearestRupee, assessDiscountEligibility, InvalidInclusiveTaxInput, type PlaceOfSupply } from '../../../packages/finance/src/index';

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
  ];
}
