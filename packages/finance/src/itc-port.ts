// The input-tax-credit port GSTR-3B Table 4 reads through (R3 · A15 ↔ A17).
//
// GSTR-3B Table 4 is the ITC the shop claims for the month. The ONLY claimable figure is the ITC on supplier lines
// that the GSTR-2B / IMS reconciliation (A17, built in the input-credit lane) has ACCEPTED. That lane implements this
// port; the GST-returns lane only reads it, so neither touches the other's files.
//
// Until A17 runs for a period, the honest answer is "not yet reconciled" — and GSTR-3B shows that as an EXCEPTION,
// never as zero ITC (P-08): a zero would read as "the shop has no input credit this month" and overstate the cash
// to pay, or invite a figure typed in by hand.

/** ITC for one monthly period, as the reconciliation answers it. */
export type ItcForPeriod =
  | {
    readonly status: 'reconciled';
    /** Accepted ITC by tax head, paise. */
    readonly igstMinor: number;
    readonly cgstMinor: number;
    readonly sgstMinor: number;
    readonly cessMinor: number;
    /** What the figure is made of (e.g. "142 lines accepted by u-acct on 2027-06-09"). */
    readonly detail: string;
  }
  | {
    readonly status: 'not_reconciled';
    /** Why there is no figure yet. */
    readonly detail: string;
  };

/** The port: accepted ITC for `period` (MMYYYY) of `tenantId`. */
export interface ItcPort {
  itcForPeriod(tenantId: string, period: string): Promise<ItcForPeriod> | ItcForPeriod;
}

/**
 * The stand-in wired until the input-credit lane (A17) implements the port: every period is "ITC not yet
 * reconciled" — an exception on GSTR-3B, never a zero.
 */
export const ITC_NOT_YET_RECONCILED: ItcPort = Object.freeze({
  itcForPeriod: (): ItcForPeriod => ({
    status: 'not_reconciled',
    detail: 'ITC not yet reconciled — the GSTR-2B / IMS reconciliation (A17) has not been run for this period, so no input credit can be claimed from this system yet',
  }),
});
