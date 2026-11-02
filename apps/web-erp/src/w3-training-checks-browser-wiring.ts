// Wave 3 (OB-675 · QG-02) — the browser wiring for the Training checks page, kept in one file so the shared bundle entry
// (browser-entry.ts) carries one import and one call. The page's tested session is attached to its window global from the
// viewer the front door injected (identity only). Nothing is read or written here.

import { createTrainingChecksSession, trainingChecksWords, trainingChecksOutcomeWords } from './training-checks-session';
import { shopMomentOf } from './findings-session';

type Viewer = { readonly userId?: string; readonly permissions: readonly string[] };

export function wireW3TrainingChecks(win: Record<string, unknown>, viewerIdentity: (raw: unknown) => Viewer | undefined): void {
  if (win['trainingChecksData'] !== undefined) {
    win['trainingChecks'] = { session: createTrainingChecksSession({ viewer: viewerIdentity(win['trainingChecksData']) }), words: trainingChecksWords, outcomeWords: trainingChecksOutcomeWords, moment: shopMomentOf };
  }
}
