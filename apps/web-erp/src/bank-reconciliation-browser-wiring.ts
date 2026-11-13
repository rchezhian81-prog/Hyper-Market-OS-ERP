// The browser wiring for the Bank reconciliation page (U6 · M23-FR-03) — one import and one call in browser-entry.ts.
// The page's tested session is attached to `window.bankReconciliation` from the viewer the front door injected
// (`window.bankReconciliationData`, identity only). Nothing is read or written here.

import { createBankReconciliationSession, bankReconciliationWords, bankReconciliationOutcomeWords, EXCEPTION_OUTCOMES } from './bank-reconciliation-session';

type Viewer = { readonly userId?: string; readonly permissions: readonly string[] };

export function wireBankReconciliation(win: Record<string, unknown>, viewerIdentity: (raw: unknown) => Viewer | undefined): void {
  if (win['bankReconciliationData'] === undefined) return;
  win['bankReconciliation'] = {
    session: createBankReconciliationSession({ viewer: viewerIdentity(win['bankReconciliationData']) }),
    words: bankReconciliationWords, outcomeWords: bankReconciliationOutcomeWords, outcomes: EXCEPTION_OUTCOMES,
    rupees: (minor: number): string => `${minor < 0 ? '−' : ''}₹${(Math.abs(minor) / 100).toFixed(2)}`,
  };
}
