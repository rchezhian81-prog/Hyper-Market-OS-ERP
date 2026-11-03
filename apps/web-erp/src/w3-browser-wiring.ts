// W3 (migration controls) — the browser wiring for the office page this wave adds, kept in one file so the shared bundle
// entry (browser-entry.ts) carries one import and one call. The page's tested session is attached to its own window global
// from the viewer the front door injected (identity only). Nothing is read or written here.

import {
  createOldSystemSession, oldSystemWords, oldSystemOutcomeWords, readSource, readEntry, readSeen, approvedTableFile, rupees,
  SOURCE_KINDS, VOLUME_BASES, MAPPING_DOMAINS, EXCLUSION_SCOPES, RESOLUTION_ACTIONS,
} from './old-system-session';

type Viewer = { readonly userId?: string; readonly permissions: readonly string[] };

export function wireW3Migration(win: Record<string, unknown>, viewerIdentity: (raw: unknown) => Viewer | undefined): void {
  if (win['oldSystemData'] !== undefined) {
    win['oldSystem'] = {
      session: createOldSystemSession({ viewer: viewerIdentity(win['oldSystemData']) }), words: oldSystemWords, outcomeWords: oldSystemOutcomeWords,
      readSource, readEntry, readSeen, approvedTableFile, rupees,
      sourceKinds: SOURCE_KINDS, volumeBases: VOLUME_BASES, mappingDomains: MAPPING_DOMAINS, exclusionScopes: EXCLUSION_SCOPES,
      resolutionActions: RESOLUTION_ACTIONS, // W4 · MG-04
    };
  }
}
