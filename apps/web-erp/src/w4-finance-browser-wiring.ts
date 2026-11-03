// W4 (finance) — the browser wiring for the WF-05 after-match steps, kept in one file so the shared bundle entry
// (browser-entry.ts) carries one import and one call. Each section's tested session is attached to its own window global
// from the viewer the front door injected for that page (identity only). Nothing is read or written here.

import {
  createBillCheckSession, createPayablesBooksSession, createApTallySession, supplierBooksWords, supplierBooksOutcomeWords, rupees,
} from './supplier-bills-to-the-books-session';
import { typedCaptureBody } from './supplier-bills-session';

type Viewer = { readonly userId?: string; readonly permissions: readonly string[] };

export function wireW4Finance(win: Record<string, unknown>, viewerIdentity: (raw: unknown) => Viewer | undefined): void {
  const common = { words: supplierBooksWords, outcomeWords: supplierBooksOutcomeWords, rupees };
  // WF-05: Supplier bills — the second person's check of a typed bill, and debit notes for goods sent back.
  if (win['supplierBillsData'] !== undefined) {
    win['billCheck'] = { session: createBillCheckSession({ viewer: viewerIdentity(win['supplierBillsData']) }), typedBody: typedCaptureBody, ...common };
  }
  // WF-05 · M23-FR-01: Day book — supplier bills in the books.
  if (win['dayBookData'] !== undefined) {
    win['payablesBooks'] = { session: createPayablesBooksSession({ viewer: viewerIdentity(win['dayBookData']) }), ...common };
  }
  // WF-05 · M23-FR-04: Tally files — the month's supplier-bill file.
  if (win['tallyFilesData'] !== undefined) {
    win['apTally'] = { session: createApTallySession({ viewer: viewerIdentity(win['tallyFilesData']) }), ...common };
  }
}
