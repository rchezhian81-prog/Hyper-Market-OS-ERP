// Product duplicate detection and merge (M03-FR-04).
//
// Duplicate products are how a catalogue rots. The same item gets entered twice —
// once as "Aashirvaad Atta 5kg" and once as "AASHIRVAAD ATTA 5 KG" — and from then
// on the stock is split across two records, neither of which is right, replenishment
// orders both, and the margin report shows two half-truths.
//
// The rule the roadmap sets, and the one this module keeps:
//
//     SUSPECTED DUPLICATES ARE QUEUED FOR REVIEW, NEVER AUTO-MERGED.
//
// Automatic merging is worse than the duplicate. A wrong merge destroys a product's
// history and there is nothing left to compare against. So detection produces a
// REVIEW LIST with the evidence for each pair, a human decides, and the merge is
// recorded as a reversible link rather than by deleting anything (hard rule #2).
//
// A shared barcode is the one signal strong enough to be near-certain — a barcode
// maps to exactly one item, so two records holding it are the same thing or one of
// them is wrong. Everything else (name, brand, pack size) is a suspicion, and is
// labelled as one.
//
// Pure and deterministic: no clock, no I/O.

export interface DuplicateCandidate {
  readonly productId: string;
  readonly name: string;
  readonly brand?: string;
  readonly barcodes?: readonly string[];
  /** Pack size as entered, e.g. "5 kg" — normalised before comparison. */
  readonly packSize?: string;
}

export type DuplicateSignal = 'shared_barcode' | 'same_name_and_brand' | 'similar_name';
export type DuplicateConfidence = 'near_certain' | 'likely' | 'possible';

export interface DuplicatePair {
  readonly productIds: readonly [string, string];
  readonly signal: DuplicateSignal;
  readonly confidence: DuplicateConfidence;
  /** What was actually matched — shown to the reviewer, never hidden. */
  readonly evidence: string;
}

/**
 * Normalise for comparison only — the stored name is never changed by this.
 * Digits are split from letters ("5kg" → "5 kg") because the commonest real
 * duplicate is the same item typed once with a space and once without.
 */
export function normaliseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalise a pack size so "5 kg", "5KG" and "5 Kg" compare equal. */
export function normalisePackSize(size: string): string {
  return size.toLowerCase().replace(/\s+/g, '');
}

/** Token overlap as a fraction of the shorter name, in basis points. */
function nameOverlapBp(a: string, b: string): number {
  const left = new Set(normaliseName(a).split(' ').filter(Boolean));
  const right = new Set(normaliseName(b).split(' ').filter(Boolean));
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return Math.round((shared * 10_000) / Math.min(left.size, right.size));
}

/**
 * Find suspected duplicates. Returns a REVIEW LIST — this function never merges
 * anything, and there is deliberately no option to make it do so.
 *
 * `similarityThresholdBp` is per-tenant: a catalogue of 60,000 SKUs with long
 * descriptive names needs a different threshold from one with 3,000 short ones.
 */
export function detectDuplicateProducts(
  products: readonly DuplicateCandidate[],
  similarityThresholdBp = 7_500,
): readonly DuplicatePair[] {
  const pairs: DuplicatePair[] = [];

  for (let i = 0; i < products.length; i += 1) {
    for (let j = i + 1; j < products.length; j += 1) {
      const a = products[i];
      const b = products[j];
      if (!a || !b) continue;

      const sharedBarcode = (a.barcodes ?? []).find((code) => (b.barcodes ?? []).includes(code));
      if (sharedBarcode !== undefined) {
        // A barcode maps to exactly one item, so this is as strong as evidence gets.
        pairs.push({
          productIds: [a.productId, b.productId],
          signal: 'shared_barcode',
          confidence: 'near_certain',
          evidence: `both carry barcode ${sharedBarcode}`,
        });
        continue;
      }

      const sameName = normaliseName(a.name) === normaliseName(b.name);
      const sameBrand =
        a.brand !== undefined && b.brand !== undefined
          ? normaliseName(a.brand) === normaliseName(b.brand)
          : false;
      const samePack =
        a.packSize !== undefined && b.packSize !== undefined
          ? normalisePackSize(a.packSize) === normalisePackSize(b.packSize)
          : false;

      if (sameName && sameBrand) {
        pairs.push({
          productIds: [a.productId, b.productId],
          signal: 'same_name_and_brand',
          confidence: samePack ? 'likely' : 'possible',
          evidence: samePack
            ? `same name, brand and pack size ("${a.name}", ${a.packSize ?? ''})`
            : `same name and brand ("${a.name}"), but different pack size`,
        });
        continue;
      }

      const overlap = nameOverlapBp(a.name, b.name);
      if (overlap >= similarityThresholdBp && (sameBrand || a.brand === undefined || b.brand === undefined)) {
        pairs.push({
          productIds: [a.productId, b.productId],
          signal: 'similar_name',
          confidence: 'possible',
          evidence: `names overlap ${(overlap / 100).toFixed(0)}% ("${a.name}" / "${b.name}")`,
        });
      }
    }
  }

  return pairs;
}

// --- merge (approved, reversible, never destructive) -------------------------

export interface MergeRequest {
  readonly mergeId: string;
  /** The record that survives as the single truth. */
  readonly keepProductId: string;
  /** The record that is superseded — NOT deleted. */
  readonly supersedeProductId: string;
  readonly requestedBy: string;
  readonly reason: string;
}

export interface MergeApproval {
  readonly subjectRef: string;
  readonly status: 'approved' | 'rejected' | 'pending';
  readonly decidedBy: string;
}

/** The outcome of a merge: a link, not a deletion. Reversible by design. */
export interface MergeLink {
  readonly mergeId: string;
  readonly keepProductId: string;
  readonly supersedeProductId: string;
  readonly requestedBy: string;
  readonly approvedBy: string;
  readonly reason: string;
  readonly at: string;
  readonly reversed?: boolean;
}

export class MergeApprovalRequiredError extends Error {
  constructor(
    public readonly mergeId: string,
    public readonly why: string,
  ) {
    super(`Merge "${mergeId}" cannot proceed: ${why}`);
    this.name = 'MergeApprovalRequiredError';
  }
}

export class SelfMergeError extends Error {
  constructor(public readonly productId: string) {
    super(`Product "${productId}" cannot be merged into itself`);
    this.name = 'SelfMergeError';
  }
}

/**
 * Merge two product records — only with a second person's approval (§28), and only
 * as a LINK. The superseded record keeps its history and can be restored, because a
 * wrong merge with nothing left to compare against is unrecoverable.
 */
export function mergeProducts(
  request: MergeRequest,
  approval: MergeApproval | undefined,
  at: string,
): MergeLink {
  if (request.keepProductId === request.supersedeProductId) {
    throw new SelfMergeError(request.keepProductId);
  }
  if (request.reason.trim() === '') {
    throw new MergeApprovalRequiredError(request.mergeId, 'no reason was given');
  }
  if (approval === undefined || approval.status !== 'approved') {
    throw new MergeApprovalRequiredError(
      request.mergeId,
      'a merge is never automatic — it needs an approval',
    );
  }
  if (approval.subjectRef !== request.mergeId) {
    throw new MergeApprovalRequiredError(request.mergeId, 'the approval is for a different merge');
  }
  if (approval.decidedBy === request.requestedBy) {
    throw new MergeApprovalRequiredError(
      request.mergeId,
      'the person who proposed the merge cannot approve it (§28)',
    );
  }

  return {
    mergeId: request.mergeId,
    keepProductId: request.keepProductId,
    supersedeProductId: request.supersedeProductId,
    requestedBy: request.requestedBy,
    approvedBy: approval.decidedBy,
    reason: request.reason,
    at,
  };
}

/** Undo a merge — recorded as a reversal, never by erasing the original link. */
export function reverseMerge(link: MergeLink): MergeLink {
  return { ...link, reversed: true };
}

/** Where a product id now points, following any approved, unreversed merge. */
export function resolveProductId(productId: string, links: readonly MergeLink[]): string {
  let current = productId;
  const seen = new Set<string>([current]);
  for (;;) {
    const link = links.find((l) => l.supersedeProductId === current && l.reversed !== true);
    if (!link || seen.has(link.keepProductId)) return current;
    current = link.keepProductId;
    seen.add(current);
  }
}
