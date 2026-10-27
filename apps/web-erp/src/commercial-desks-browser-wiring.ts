// The browser wiring for the commercial desks (OB-288 package 3): Business customers (M22), Supplier submissions (M24) and
// Concessions (M27). Kept in its own file so the shared bundle entry (browser-entry.ts) carries one import and one call.
// Each page's tested session is attached to `window` under the name its page script reads, from the viewer data injected
// for it. Nothing is read or written here: every call is a person's click on the page.

import { createB2BDeskSession, b2bDeskWords, b2bDeskOutcomeWords, rupees as b2bRupees, deliveryStatePrefillOf } from './b2b-desk-session';
import { createSupplierSubmissionsSession, supplierSubmissionsWords, supplierSubmissionsOutcomeWords, documentLine } from './supplier-submissions-session';
import { createConcessionSession, concessionWords, concessionOutcomeWords, rupees as concessionRupees } from './concession-session';
import { createVmiDeskSession, vmiDeskWords, vmiDeskOutcomeWords, itemWords as vmiItemWords } from './vmi-desk-session'; // FG-4 · D03-FR-04

type Viewer = { readonly userId?: string; readonly permissions: readonly string[] };

export function wireCommercialDeskPages(win: Record<string, unknown>, viewerIdentity: (raw: unknown) => Viewer | undefined): void {
  if (win['b2bDeskData'] !== undefined) {
    win['b2bDesk'] = { session: createB2BDeskSession({ viewer: viewerIdentity(win['b2bDeskData']) }), words: b2bDeskWords, outcomeWords: b2bDeskOutcomeWords, rupees: b2bRupees, deliveryStatePrefill: deliveryStatePrefillOf };
  }
  if (win['supplierSubmissionsData'] !== undefined) {
    win['supplierSubmissions'] = { session: createSupplierSubmissionsSession({ viewer: viewerIdentity(win['supplierSubmissionsData']) }), words: supplierSubmissionsWords, outcomeWords: supplierSubmissionsOutcomeWords, documentLine };
    // FG-4 · D03-FR-04: the supplier-managed stock (VMI) desk on the same page.
    win['vmiDesk'] = { session: createVmiDeskSession({ viewer: viewerIdentity(win['supplierSubmissionsData']) }), words: vmiDeskWords, outcomeWords: vmiDeskOutcomeWords, itemWords: vmiItemWords };
  }
  if (win['concessionsData'] !== undefined) {
    win['concessions'] = { session: createConcessionSession({ viewer: viewerIdentity(win['concessionsData']) }), words: concessionWords, outcomeWords: concessionOutcomeWords, rupees: concessionRupees };
  }
}
