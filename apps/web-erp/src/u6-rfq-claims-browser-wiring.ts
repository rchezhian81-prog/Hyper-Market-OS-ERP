// The browser wiring for the Requests for quotation page and the Supplier claims page (U6 · M06-FR-02 · M07-FR-03 ·
// M24-FR-01/02) — kept in its own file so the shared bundle entry (browser-entry.ts) carries one import and one call. Each
// page's tested session is attached from the viewer the front door injected (`window.rfqData`, `window.supplierClaimsData`,
// identity only). Nothing is read or written here.

import { createRfqSession, rfqWords, rfqOutcomeWords, rfqStateTone, requisitionLinesText, addSupplier } from './rfq-session';
import { createSupplierClaimsSession, supplierClaimsWords, supplierClaimsOutcomeWords, claimStateTone, rupees, supplierLabel, creditStateTone, disputeTone, disputeStateKey, DISPUTE_OUTCOMES } from './supplier-claims-session';

type Viewer = { readonly userId?: string; readonly permissions: readonly string[] };

export function wireRfqAndClaims(win: Record<string, unknown>, viewerIdentity: (raw: unknown) => Viewer | undefined): void {
  if (win['rfqData'] !== undefined) {
    win['rfq'] = { session: createRfqSession({ viewer: viewerIdentity(win['rfqData']) }), words: rfqWords, outcomeWords: rfqOutcomeWords, stateTone: rfqStateTone, linesText: requisitionLinesText, addSupplier };
  }
  if (win['supplierClaimsData'] !== undefined) {
    win['supplierClaims'] = { session: createSupplierClaimsSession({ viewer: viewerIdentity(win['supplierClaimsData']) }), words: supplierClaimsWords, outcomeWords: supplierClaimsOutcomeWords, stateTone: claimStateTone, rupees, supplierLabel,
      // U7 · OB-725 · M24-FR-02 alt
      creditTone: creditStateTone, disputeTone, disputeStateKey, disputeOutcomes: DISPUTE_OUTCOMES };
  }
}
