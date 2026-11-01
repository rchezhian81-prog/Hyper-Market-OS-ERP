// The browser wiring for Round 4b (buying and stock): the sessions the Buying page's "Open orders" and "Reorder" tabs use,
// kept in its own file so the shared bundle entry (browser-entry.ts) carries one import and one call. Each tested session is
// attached to `window.<name>` from the person the store computer injected; nothing is read or written here — every call is
// a person's click.

import { createOpenOrdersSession, openOrdersWords, openOrdersOutcomeWords, rupees, lineQty, editableQty, editablePrice } from './open-orders-session';
import { createSupplierTermsSession, supplierTermsWords, supplierTermsOutcomeWords } from './supplier-terms-session';
import { createReplenishmentSession, replenishmentWords, replenishmentOutcomeWords, qtyIn, editable } from './replenishment-session';
import { createExpiredRegisterSession, expiredWords, expiredOutcomeWords, expiredRowView } from './expired-register-session';
import { createRepeatOrdersSession, repeatWords, repeatOutcomeWords, planWords, occurrenceWords } from './repeat-orders-session';
import { createSupplierAdvancesSession, advancesWords, advancesOutcomeWords, rupees as advanceRupees } from './supplier-advances-session';

import { typedQuantityMinor, toDecimalString, normaliseUom } from '../../../packages/contracts/src/quantity';

type Viewer = { readonly userId?: string; readonly permissions: readonly string[] };

/** The Buying page's viewer: its payload names the signed-in person as `buyerId` (PA-06), with what they hold. */
function buyerOf(raw: unknown): Viewer | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const permissions = Array.isArray(r['permissions']) ? r['permissions'].filter((p): p is string => typeof p === 'string') : [];
  const id = typeof r['buyerId'] === 'string' && r['buyerId'].trim() !== '' ? r['buyerId'] : typeof r['userId'] === 'string' && r['userId'].trim() !== '' ? r['userId'] : undefined;
  return { ...(id === undefined ? {} : { userId: id }), permissions };
}

/**
 * OB-31 at the office forms that typed whole numbers (Record a write-off, Count plans): a quantity a person types in the item's
 * OWN unit ("2.5" kg) as the smallest steps stored (2500 g), through the ONE shared reading — NaN when it does not read, so the
 * form's own check refuses it; and back again for a form restored from a draft.
 */
export const typedQuantity = Object.freeze({
  minor: (typed: string, uom: string, allowZero = false): number => typedQuantityMinor(typed, uom, { allowZero }) ?? Number.NaN,
  typed: (minor: number, uom: string): string => { const u = normaliseUom(uom); return u === undefined || !Number.isSafeInteger(minor) ? String(minor) : toDecimalString({ minor, uom: u }); },
});

export function wireBuyingAndStockScreens(win: Record<string, unknown>, viewerIdentity: (raw: unknown) => Viewer | undefined): void {
  win['sreTypedQuantity'] = typedQuantity;
  if (win['buyingData'] !== undefined) {
    // M06-FR-04: the open-commitment report, and changing or cancelling an issued order.
    // M09-FR-02 · WF-03: the stored reorder settings, head office's proposal on them, and a requisition raised from it.
    const raw = win['buyingData'] as { productUoms?: unknown } | null;
    const uoms = raw !== null && typeof raw === 'object' && raw.productUoms !== null && typeof raw.productUoms === 'object' ? raw.productUoms as Record<string, string> : undefined;
    win['buyingReorder'] = { session: createReplenishmentSession({ viewer: buyerOf(win['buyingData']), ...(uoms === undefined ? {} : { productUoms: uoms }) }), words: replenishmentWords, outcomeWords: replenishmentOutcomeWords, qtyIn, editable };
    win['buyingOpenOrders'] = { session: createOpenOrdersSession({ viewer: buyerOf(win['buyingData']) }), words: openOrdersWords, outcomeWords: openOrdersOutcomeWords, rupees, lineQty, editableQty, editablePrice };
  }
  // M06-FR-03: supplier contracts (with the agreed lead time) on the Supplier scorecard page, rebate schemes on the Supplier
  // rebates page — the same tested session, each page's own viewer.
  for (const data of ['supplierScorecardData', 'rebatesData']) {
    if (win[data] !== undefined && win['supplierTerms'] === undefined) {
      win['supplierTerms'] = { session: createSupplierTermsSession({ viewer: viewerIdentity(win[data]) }), words: supplierTermsWords, outcomeWords: supplierTermsOutcomeWords };
    }
  }
  // D10-FR-01: supplier advances on the Supplier bills page — pay (asked for and approved by a second person), use against a
  // matched bill, undo a use.
  if (win['supplierBillsData'] !== undefined) {
    win['supplierAdvances'] = { session: createSupplierAdvancesSession({ viewer: viewerIdentity(win['supplierBillsData']) }), words: advancesWords, outcomeWords: advancesOutcomeWords, rupees: advanceRupees };
  }
  // M10-FR-01 (the re-audit's "read by no screen"): head office's expired register on the Expiry page's "Taken off sale" tab.
  if (win['expiryData'] !== undefined) {
    const raw = (win['expiryData'] ?? {}) as { productNames?: Record<string, string>; productUnits?: Record<string, string> };
    win['expiredRegister'] = {
      session: createExpiredRegisterSession({ viewer: viewerIdentity(win['expiryData']) }), words: expiredWords, outcomeWords: expiredOutcomeWords,
      rowView: (lang: 'en' | 'ta', row: Parameters<typeof expiredRowView>[1]) => expiredRowView(lang, row, raw.productNames ?? {}, raw.productUnits ?? {}),
    };
  }
  // M17-FR-02 · OB-303 (the re-audit's "no screen reads repeat orders"): repeat orders on the Delivery exceptions page.
  if (win['substitutionExceptionInboxData'] !== undefined) {
    win['repeatOrders'] = { session: createRepeatOrdersSession({ viewer: viewerIdentity(win['substitutionExceptionInboxData']) }), words: repeatWords, outcomeWords: repeatOutcomeWords, planWords, occurrenceWords };
  }
}
