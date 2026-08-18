// API-02 Product duplicate DETECTION route (M03-FR-04) — the review list that keeps a catalogue from
// rotting. The same item entered twice ("Aashirvaad Atta 5kg" and "AASHIRVAAD ATTA 5 KG") splits the
// stock across two records, orders both, and reports two half-truths. This returns, for a supplied set of
// products, every SUSPECTED duplicate pair with its signal (shared barcode / same name+brand / similar
// name), a confidence, and the plain-English evidence a person needs to decide.
//
// It DETECTS, it never merges — a wrong auto-merge destroys a product's history with nothing left to
// compare against, so the roadmap rule is "suspected duplicates are queued for review, never auto-merged"
// (M03-FR-04). The merge itself is a §28-gated, reversible write path that belongs with the product-master
// store (a follow-on); this surface is the review list.
//
// Stateless over the tested `@sre/product` `detectDuplicateProducts` engine (the `services-run-on-their-
// tested-engine` guardrail): the caller supplies the product candidates, the route shapes input and calls
// the engine, and commits nothing. Gated `catalogue.pack.read` — the same permission the catalogue is read
// and previewed under.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { detectDuplicateProducts, type DuplicateCandidate, type DuplicateConfidence } from '../../../packages/product/src/index';

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isStrArray = (v: unknown): v is readonly string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** A candidate is enough to compare when it names itself and carries a name; barcodes/brand/packSize are
 * optional evidence the engine uses when present. */
const isCandidate = (v: unknown): v is DuplicateCandidate => {
  if (v === null || typeof v !== 'object') return false;
  const c = v as Record<string, unknown>;
  return isStr(c['productId']) && isStr(c['name'])
    && (c['barcodes'] === undefined || isStrArray(c['barcodes']))
    && (c['brand'] === undefined || typeof c['brand'] === 'string')
    && (c['packSize'] === undefined || typeof c['packSize'] === 'string');
};

const isPosInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

export function productDuplicateRoutes(): readonly Route[] {
  return [
    {
      // A read masquerading as POST because the products are an array — idempotent, writes nothing.
      // Body: { products: DuplicateCandidate[], similarityThresholdBp?: number }
      api: 'API-02', method: 'POST', path: '/v1/catalogue/products/duplicates',
      permission: 'catalogue.pack.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const products = b['products'];
        const threshold = b['similarityThresholdBp'];
        if (!Array.isArray(products) || !products.every(isCandidate) || (threshold !== undefined && !isPosInt(threshold))) {
          throw apiError(400, {
            code: 'not_readable_as_a_duplicate_check',
            whatHappened: 'A duplicate check needs products[] (each with a productId and a name; barcodes/brand/packSize optional) and an optional whole similarityThresholdBp > 0.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the catalogue records to compare; a shared barcode is the strongest signal, so include barcodes where you have them.',
          });
        }
        const pairs = detectDuplicateProducts(products as DuplicateCandidate[], threshold as number | undefined);
        const byConfidence = (c: DuplicateConfidence) => pairs.filter((p) => p.confidence === c).length;
        // 200, not 201 — nothing was created; this is the review list, and a merge is a separate §28 step.
        return {
          status: 200,
          body: {
            pairs,
            pairCount: pairs.length,
            // The near-certain ones (a shared barcode) are the ones to look at first.
            nearCertainCount: byConfidence('near_certain'),
            likelyCount: byConfidence('likely'),
            possibleCount: byConfidence('possible'),
          },
        };
      },
    },
  ];
}
