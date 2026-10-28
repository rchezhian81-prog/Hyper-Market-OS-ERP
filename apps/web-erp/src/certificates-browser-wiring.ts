// The browser wiring for the Staff certificates page (round 8 · R8-C · OB-522) — kept in its own file so the shared bundle
// entry (browser-entry.ts) carries one import and one call. The page's tested session is attached to `window.certificates`
// from the viewer the front door injected (`window.certificatesData`, identity only). Nothing is read or written here.

import { createCertificatesSession, certificatesWords, certificatesOutcomeWords, kindWords, CERTIFICATE_KINDS } from './certificates-session';
import { shopDateIn } from '../../../packages/calendar/src/shop-clock';

type Viewer = { readonly userId?: string; readonly permissions: readonly string[] };

export function wireCertificates(win: Record<string, unknown>, viewerIdentity: (raw: unknown) => Viewer | undefined): void {
  if (win['certificatesData'] === undefined) return;
  win['certificates'] = {
    session: createCertificatesSession({ viewer: viewerIdentity(win['certificatesData']) }),
    words: certificatesWords, outcomeWords: certificatesOutcomeWords, kindWords, kinds: CERTIFICATE_KINDS,
    today: () => shopDateIn(new Date().toISOString()),
  };
}
