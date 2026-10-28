// The browser wiring for two head-office pages (round 7 · R7-C): Shelf tags (OB-505 · B3) and Quotations (OB-506 ·
// M12-FR-02) — kept in its own file so the shared bundle entry (browser-entry.ts) carries one import and one call. Each page's
// tested session is attached to `window.<page>` from the viewer the front door injected (`window.<page>Data`, identity only).
// Nothing is read or written here: every call is a click.

import { createShelfTagsSession, shelfTagsWords, shelfTagsOutcomeWords, tagWords, rupees as tagRupees, SHELF_TAG_TEMPLATES, TAG_LANGUAGES, PRINT_MODES, shelfTagPrintCss, tagsThatOverflow, overflowWords, printHint } from './shelf-tags-session';
import { createQuotationsSession, quotationsWords, quotationsOutcomeWords, rupees as quoteRupees, defaultValidUntil, QUOTATION_STATES } from './quotations-session';

type Viewer = { readonly userId?: string; readonly permissions: readonly string[] };

export function wireShelfTagsAndQuotations(win: Record<string, unknown>, viewerIdentity: (raw: unknown) => Viewer | undefined): void {
  if (win['shelfTagsData'] !== undefined) {
    win['shelfTags'] = { session: createShelfTagsSession({ viewer: viewerIdentity(win['shelfTagsData']) }), words: shelfTagsWords, outcomeWords: shelfTagsOutcomeWords, tagWords, rupees: tagRupees, templates: SHELF_TAG_TEMPLATES, languages: TAG_LANGUAGES, printModes: PRINT_MODES, printCss: shelfTagPrintCss, tagsThatOverflow, overflowWords, printHint };
  }
  if (win['quotationsData'] !== undefined) {
    win['quotations'] = { session: createQuotationsSession({ viewer: viewerIdentity(win['quotationsData']) }), words: quotationsWords, outcomeWords: quotationsOutcomeWords, rupees: quoteRupees, validUntil: defaultValidUntil, states: QUOTATION_STATES };
  }
}
