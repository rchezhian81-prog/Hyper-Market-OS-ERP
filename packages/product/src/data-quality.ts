// Product data-quality assessment (M03-FR-02/04 · D01 · A08 "Data Quality") — the deterministic
// scan behind the Data Quality agent.
//
// A08's job (§7.1 / P-05) is to "detect duplicates, missing attributes and suspicious mappings" so
// a data steward can act. This module is the DETECTION half: pure, deterministic, and grounded in
// the tenant's real published product master. It answers exactly one question — *which live product
// records have a data-quality gap a person should look at, and what is the evidence?* — and it
// decides nothing. It produces a review list; a human acts through the ordinary catalogue endpoints.
//
// ── It does NOT scan for what the system already refuses at the door ─────────────────────────────
//
// Two "obvious" data-quality checks are deliberately absent, because they can never fire on a live
// master and a check that always comes back empty is worse than no check — it reads as "looked, all
// clear" when in truth it was never possible:
//   • a MISSING HSN/TAX CLASS — `publishProduct` refuses a publish without one, so no published
//     product can lack it;
//   • a BARCODE SHARED across two products — `BarcodeRegistry` enforces one-code-one-item, so the
//     store can never hold one.
//
// ── It scans for what CAN go wrong in a live master and matters ──────────────────────────────────
//
//   • a sellable product with NO barcode — it cannot be scanned, so every sale is a manual search
//     that slows the lane (M03-FR-02 coverage);
//   • two records that look like the SAME item — split stock, double replenishment, two half-true
//     margin lines (M03-FR-04) — surfaced by the tested duplicate engine, and NEVER auto-merged;
//   • a sellable product with NO printed MRP — the shelf label and the bill have no maximum retail
//     price to show, which India's Legal Metrology rules require.
//
// Each finding NAMES the real product(s) as its evidence: an uncited data-quality claim is exactly
// the failure mode A08's own authority (`requiresEvidence`) exists to prevent.
//
// Pure and deterministic: no clock, no I/O. The same master always yields the same findings in the
// same order, so a proposal drafted from a finding has a stable identity.

import { SELLABLE_LIFECYCLE, type ProductLifecycle, type ProductRecord } from './product';
import { BarcodeRegistry, barcodeCoverageGaps } from './pack';
import { detectDuplicateProducts, type DuplicateCandidate } from './duplicates';

export type DataQualityIssueKind = 'missing_barcode' | 'suspected_duplicate' | 'missing_mrp';

/** How sure the scan is. A missing field is measured (certain); a duplicate is inferred. */
export type DataQualityConfidence = 'certain' | 'near_certain' | 'likely' | 'possible';

export interface DataQualityEvidence {
  readonly productId: string;
  readonly sku: string;
  readonly name: string;
  /** What about THIS product is the evidence — plain English, for a steward. */
  readonly note: string;
}

export interface DataQualityFinding {
  /** Stable, deterministic id: the same master yields the same finding id every time. */
  readonly findingId: string;
  readonly kind: DataQualityIssueKind;
  /** The product(s) this concerns — one for a missing-* gap, the pair for a suspected duplicate. */
  readonly productIds: readonly string[];
  readonly confidence: DataQualityConfidence;
  /** One line a data steward reads first. */
  readonly headline: string;
  /** Why it matters and what to check — no jargon; the person fixing it is not a programmer. */
  readonly detail: string;
  /** The real product(s). Always at least one — an uncited finding is refused upstream. */
  readonly evidence: readonly DataQualityEvidence[];
}

/**
 * Scan a tenant's product master for the data-quality gaps a Data Quality steward should review.
 *
 * Read-only and deterministic. Returns a review list ordered stably (missing barcodes, then
 * suspected duplicates, then missing MRP — each by product id), never a set of actions.
 */
export function assessProductDataQuality(input: {
  readonly products: readonly ProductRecord[];
  readonly barcodes: BarcodeRegistry;
  /**
   * Which lifecycles are worth flagging. Default: the sellable ones — a `draft` is expected to be
   * incomplete and a `discontinued` line is not sold, so flagging either would be noise.
   */
  readonly lifecyclesInScope?: readonly ProductLifecycle[];
  /** Passed through to the tested duplicate engine — per-tenant, catalogue-size dependent. */
  readonly similarityThresholdBp?: number;
}): readonly DataQualityFinding[] {
  const inScope = new Set<ProductLifecycle>(input.lifecyclesInScope ?? SELLABLE_LIFECYCLE);
  const products = [...input.products]
    .filter((p) => inScope.has(p.lifecycle))
    .sort((a, b) => a.productId.localeCompare(b.productId));

  const byId = new Map(products.map((p) => [p.productId, p] as const));
  const evidenceOf = (productId: string, note: string): DataQualityEvidence => {
    const p = byId.get(productId);
    return { productId, sku: p?.sku ?? '', name: p?.name ?? productId, note };
  };

  const findings: DataQualityFinding[] = [];

  // 1 — sellable products with no barcode at all (M03-FR-02). The tested coverage engine, verbatim.
  for (const productId of barcodeCoverageGaps(products.map((p) => p.productId), input.barcodes)) {
    const p = byId.get(productId)!;
    findings.push({
      findingId: `dq-missing-barcode:${productId}`,
      kind: 'missing_barcode',
      productIds: [productId],
      confidence: 'certain',
      headline: `"${p.name}" has no barcode and cannot be scanned`,
      detail:
        `Item ${p.sku} is on sale but has no barcode in the register, so a cashier must find it by ` +
        `hand on every sale, which slows the lane. Assign its barcode so it scans at the till.`,
      evidence: [evidenceOf(productId, 'no barcode assigned in the register')],
    });
  }

  // 2 — suspected duplicate records (M03-FR-04). The tested duplicate engine; NEVER auto-merged.
  const candidates: DuplicateCandidate[] = products.map((p) => ({
    productId: p.productId,
    name: p.name,
    ...(p.brand !== undefined ? { brand: p.brand } : {}),
    barcodes: input.barcodes.forProduct(p.productId).map((a) => a.code),
  }));
  for (const pair of detectDuplicateProducts(candidates, input.similarityThresholdBp)) {
    const [a, b] = pair.productIds;
    const pa = byId.get(a);
    const pb = byId.get(b);
    findings.push({
      findingId: `dq-duplicate:${a}:${b}`,
      kind: 'suspected_duplicate',
      productIds: [a, b],
      confidence: pair.confidence,
      headline: `"${pa?.name ?? a}" and "${pb?.name ?? b}" look like the same item`,
      detail:
        `Two separate product records appear to be the same thing — ${pair.evidence}. While both ` +
        `exist, stock and sales are split across them and replenishment can order twice. Review the ` +
        `pair and, if they match, merge them — a second person approves and nothing is deleted.`,
      evidence: [evidenceOf(a, pair.evidence), evidenceOf(b, pair.evidence)],
    });
  }

  // 3 — sellable products with no printed MRP (Legal Metrology). Advisory to publish, but a real gap.
  for (const p of products) {
    if ((p.mrpHistory ?? []).length === 0) {
      findings.push({
        findingId: `dq-missing-mrp:${p.productId}`,
        kind: 'missing_mrp',
        productIds: [p.productId],
        confidence: 'certain',
        headline: `"${p.name}" has no printed MRP`,
        detail:
          `Item ${p.sku} is on sale with no maximum retail price recorded, which the shelf label and ` +
          `the printed bill are both required to show. Add its MRP.`,
        evidence: [evidenceOf(p.productId, 'no MRP recorded on the product')],
      });
    }
  }

  return findings;
}
