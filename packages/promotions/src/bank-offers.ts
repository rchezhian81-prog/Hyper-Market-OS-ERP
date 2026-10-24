// OB-305 (owner, 23 Oct 2026, in writing): bank-card offers (M05-FR-03 · D06-FR-03) are BUILT and switched OFF until an
// integrated card machine exists. The bank-supplied standalone terminals SRE uses (OWNER_DECISIONS D5) never tell the till
// which bank a card is from, so an offer "10% off with Bank X cards" cannot be judged at the till without trusting a
// cashier's guess — and money given on a guess is the opposite of hard rule #5's spirit and P-04.
//
// The engine computes a `bank_offer` (`promotions.ts`) only when the till passes BOTH `bankOffersOn` and the issuer an
// integrated machine reported; no till passes either today. Head office refuses to DEFINE one while this switch is off, so
// none can reach a signed pack. Turning it on is a release decision, not a setting: it needs the integrated card machine
// (and its certified provider, EX-03) first.

/**
 * The release that brings integrated card terminals — the one that turns bank offers on (OB-305). OB-349 (owner, 24 Oct
 * 2026, in writing): bank offers are turned on in R4, with the certified payment / terminal integrations — not before.
 */
export const BANK_OFFERS_RELEASE = 'R4';

export interface BankOffersSwitch {
  readonly on: boolean;
  readonly release: string;
  readonly why: string;
}

/** Bank offers are OFF. The switch is code, not configuration: nothing at runtime may turn it on (OB-305). */
export const BANK_OFFERS: BankOffersSwitch = Object.freeze({
  on: false,
  release: BANK_OFFERS_RELEASE,
  why: 'Bank-card offers stay switched off until an integrated card machine can tell the till which bank a card is from (owner decision OB-305). Today\'s bank-supplied card machines do not, so the till could only guess.',
});
