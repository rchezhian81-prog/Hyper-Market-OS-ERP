// The browser wiring for the Payables and receivables page (U6 · M23-FR-01) — one import and one call in browser-entry.ts.
// The page's tested session is attached to `window.payablesReceivables` from the viewer the front door injected
// (`window.payablesReceivablesData`, identity only). Nothing is read or written here.

import { createPayablesReceivablesSession, payablesReceivablesWords, payablesReceivablesOutcomeWords, journalAmountMinor } from './payables-receivables-session';

type Viewer = { readonly userId?: string; readonly permissions: readonly string[] };

export function wirePayablesReceivables(win: Record<string, unknown>, viewerIdentity: (raw: unknown) => Viewer | undefined): void {
  if (win['payablesReceivablesData'] === undefined) return;
  win['payablesReceivables'] = {
    session: createPayablesReceivablesSession({ viewer: viewerIdentity(win['payablesReceivablesData']) }),
    words: payablesReceivablesWords, outcomeWords: payablesReceivablesOutcomeWords, journalAmountMinor,
    rupees: (minor: number): string => `${minor < 0 ? '−' : ''}₹${(Math.abs(minor) / 100).toFixed(2)}`,
  };
}
