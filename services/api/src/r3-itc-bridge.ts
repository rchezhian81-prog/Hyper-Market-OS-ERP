// The seam between the two R3 GST lanes: GSTR-3B Table 4 (lane 1, `packages/finance/src/itc-port.ts`) reads the A17
// GSTR-2B / IMS reconciliation (lane 2, `itcForPeriodAdapter` in `r3-tax-pay-adapters.ts`).
//
// The two lanes speak slightly different shapes, and this file is the only place that translates between them:
//   • the period — GSTR-3B asks for MMYYYY (e.g. 102026); the reconciliation keys its months YYYY-MM (2026-10);
//   • the "no figure yet" field — lane 1 calls it `detail`, lane 2 `reason`;
//   • the accepted figure gets a `detail` saying what it is made of (how many lines were accepted).
//
// Reversals (Rule 37 / 42 / 43, free samples) are GSTR-3B Table 4(B) "ITC reversed". Lane 1's 3B has no 4(B) slot, so
// the reversal is STATED in the detail — the amounts by head and how many reversals — and never netted off the 4(A)
// figure: 4(A) is the accepted credit as the 2B shows it, 4(B) what is reversed out of it, and the accountant enters
// both on the portal. A reversal is never hidden (P-08).
//
// A period that is not a month is "not reconciled" with the reason — never a zero claim.

import type { EventStore } from '../../../packages/persistence/src/event-store';
import { parseMonthlyPeriod, InvalidGstPeriod, type ItcPort, type ItcForPeriod as Table4Itc } from '../../../packages/finance/src/index';
import type { ItcForPeriod as ReconciledItc, ItcReview, TaxComponents } from '../../../packages/input-tax/src/index';
import { loadItcReview } from '../../finance/src/itc-store';
import { itcForPeriodAdapter, itcStoreAdapter } from './r3-tax-pay-adapters';

/** GSTR-3B's MMYYYY → the reconciliation's YYYY-MM. Throws `InvalidGstPeriod` for anything that is not a month. */
export function reconciliationPeriodOf(mmyyyy: string): string {
  const p = parseMonthlyPeriod(mmyyyy);
  return `${p.year}-${String(p.month).padStart(2, '0')}`;
}

/** What the month's reversals add up to (Table 4(B)), as the reconciliation's review holds them. */
export interface MonthReversals {
  readonly reversed: TaxComponents;
  readonly count: number;
  readonly acceptedLines: number;
}

const rupees = (minor: number): string => `₹${(minor / 100).toFixed(2)}`;
const total = (t: TaxComponents): number => t.igstMinor + t.cgstMinor + t.sgstMinor + t.cessMinor;
const byHead = (t: TaxComponents): string =>
  ([['IGST', t.igstMinor], ['CGST', t.cgstMinor], ['SGST', t.sgstMinor], ['cess', t.cessMinor]] as const)
    .filter(([, v]) => v !== 0).map(([k, v]) => `${k} ${rupees(v)}`).join(', ');

/** The reversal sentence for a month — said whether or not there were any, so a reader never wonders. */
export function reversalDetail(r: MonthReversals): string {
  if (r.count === 0 || total(r.reversed) === 0) return 'Table 4(B) ITC reversed: none recorded for this month';
  return `Table 4(B) ITC reversed: ${byHead(r.reversed)} (${rupees(total(r.reversed))} in ${r.count} reversal(s)) — reported on its own, NOT netted off 4(A); enter it in 4(B) on the portal`;
}

/**
 * The bridge: the reconciliation's `itcForPeriod` (YYYY-MM, `reason`) as GSTR-3B's `ItcPort` (MMYYYY, `detail`).
 * `reversals` reads the month's 4(B) figure and accepted-line count; without it the detail says only what was accepted.
 */
export function itcPortFrom(input: {
  readonly itcForPeriod: ReconciledItc;
  readonly reversals?: (tenantId: string, yyyyMm: string) => Promise<MonthReversals>;
}): ItcPort {
  return {
    itcForPeriod: async (tenantId, period): Promise<Table4Itc> => {
      let ym: string;
      try { ym = reconciliationPeriodOf(period); } catch (e) {
        if (e instanceof InvalidGstPeriod) return { status: 'not_reconciled', detail: `ITC not reconciled — ${e.message}` };
        throw e;
      }
      const claim = await input.itcForPeriod(tenantId, ym);
      const rev = input.reversals === undefined ? undefined : await input.reversals(tenantId, ym);
      if (claim.status !== 'reconciled') {
        // Not reconciled: the reason, word for word, and any reversal already recorded — still never a zero.
        return { status: 'not_reconciled', detail: `ITC not reconciled for ${period} — ${claim.reason}${rev === undefined ? '' : `. ${reversalDetail(rev)}`}` };
      }
      const accepted = { igstMinor: claim.igstMinor, cgstMinor: claim.cgstMinor, sgstMinor: claim.sgstMinor, cessMinor: claim.cessMinor };
      const lines = rev === undefined ? '' : ` from ${rev.acceptedLines} accepted line(s)`;
      return {
        status: 'reconciled', ...accepted,
        detail: `Table 4(A)(5) is the GSTR-2B / IMS reconciliation of ${ym}: ${rupees(total(accepted))} accepted${lines}${total(accepted) === 0 ? '' : ` (${byHead(accepted)})`}${rev === undefined ? '' : `. ${reversalDetail(rev)}`}`,
      };
    },
  };
}

const reversalsOfReview = (r: ItcReview): MonthReversals => ({
  reversed: r.totals.reversed, count: r.reversals.length, acceptedLines: r.lines.filter((l) => l.state === 'accepted').length,
});

/** The A17 reconciliation over a store, as GSTR-3B Table 4's port — what `main.ts` wires into `r3GstRoutes`. */
export function itcPortForStore(input: { readonly store: EventStore; readonly now: () => string }): ItcPort {
  const deps = itcStoreAdapter(input);
  return itcPortFrom({
    itcForPeriod: itcForPeriodAdapter(input),
    reversals: async (tenantId, ym) => reversalsOfReview(await loadItcReview(deps, tenantId, ym)),
  });
}
