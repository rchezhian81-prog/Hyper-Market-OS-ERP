// W4 (M11-FR-01 · M11-FR-02 · M11-FR-03) — the browser wiring for the Production page's plan and batch-trace sections and
// the Production costs page, kept in one file so the shared bundle entry (browser-entry.ts) carries one import and one
// call. Each tested session is attached to its window global from the viewer the front door injected (identity only).
// Nothing is read or written here.

import { createProductionPlanSession, productionPlanWords, productionPlanOutcomeWords, planAmount, planStateWords } from './production-plan-session';
import { createProductionCostsSession, productionCostsWords, productionCostsOutcomeWords, presentCostRun } from './production-costs-session';
import { shopMomentOf } from './findings-session';

type Viewer = { readonly userId?: string; readonly permissions: readonly string[] };

export function wireW4Production(win: Record<string, unknown>, viewerIdentity: (raw: unknown) => Viewer | undefined): void {
  if (win['productionData'] !== undefined) {
    const raw = win['productionData'] as { productionLocationId?: unknown } | null;
    win['productionPlan'] = {
      session: createProductionPlanSession({ viewer: viewerIdentity(win['productionData']) }), words: productionPlanWords, outcomeWords: productionPlanOutcomeWords,
      amount: planAmount, stateWords: planStateWords, moment: shopMomentOf, ...(typeof raw?.productionLocationId === 'string' ? { locationId: raw.productionLocationId } : {}),
    };
  }
  if (win['productionCostsData'] !== undefined) {
    win['productionCosts'] = { session: createProductionCostsSession({ viewer: viewerIdentity(win['productionCostsData']) }), words: productionCostsWords, outcomeWords: productionCostsOutcomeWords, present: presentCostRun, moment: shopMomentOf };
  }
}
