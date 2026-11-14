// CR-01 OI-12 (OB-712) — the browser wiring for the owner's Auto-approve limits page. Its tested session is attached to its
// window global from the viewer the front door injected (identity only). Nothing is read or written here.

import { createAutoApproveSession, autoApproveWords, autoApproveOutcomeWords, limitWords } from './auto-approve-session';

type Viewer = { readonly userId?: string; readonly permissions: readonly string[] };

export function wireAutoApprove(win: Record<string, unknown>, viewerIdentity: (raw: unknown) => Viewer | undefined): void {
  if (win['autoApproveData'] !== undefined) {
    win['autoApprove'] = { session: createAutoApproveSession({ viewer: viewerIdentity(win['autoApproveData']) }), words: autoApproveWords, outcomeWords: autoApproveOutcomeWords, limitWords };
  }
}
