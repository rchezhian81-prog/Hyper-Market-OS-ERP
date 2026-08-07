// Packing, labels, shelf life, quality release and repacking (M11-FR-03).
//
// A freshly made item is not sellable because it exists. It is sellable when
// somebody has looked at it and said so, and when it carries a label that tells the
// customer what it is, how much of it there is, and when it stops being safe to eat.
//
// So two gates, both enforced rather than remembered:
//
//   1. THE LABEL MUST BE COMPLETE. A label missing its net quantity, its packer
//      details, or its use-by date is refused before it prints. A wrong label is not
//      a printing problem — it is a Legal Metrology offence and, on a use-by date, a
//      food-safety one (§9.3).
//
//   2. THE STOCK MUST BE RELEASED. Production output lands in QUARANTINE (see
//      `recipe.ts`), and only a quality release moves it to sellable. Release is
//      refused for a batch that has already expired, or that failed its check — you
//      cannot release your way past a use-by date.
//
// Repacking is traceable by construction: a repack records the batch it came from,
// so a recall on the source reaches everything made out of it (M10-FR-03).
//
// Permission to release belongs to `packages/rbac` — this module enforces the
// *rules*, not who may invoke them, which is the split used everywhere else here.
//
// Pure and deterministic: the timestamp is injected, there is no clock.

import type { Money } from '../../contracts/src/money';
import type { StockMovement } from '../../stock/src/position';
import type { ProductionDepartment } from './departments';

/** What must appear on a pack label. Some of it is the law, not a preference. */
export interface PackLabel {
  readonly productId: string;
  readonly productName: string;
  readonly batchId: string;
  /** Net quantity as declared, e.g. "180 g" — a Legal Metrology field (§9.3). */
  readonly netQuantity: string;
  /** Name and address of the packer — a Legal Metrology field. */
  readonly packerDetails: string;
  /** ISO-8601 UTC — when it stops being safe to sell or eat. */
  readonly useBy: string;
  readonly price: Money;
  /** Weight in the UOM's smallest unit, for a weighed item. */
  readonly weightMinor?: number;
  /** The barcode the till scans. Embedded weight/price where the item is weighed. */
  readonly barcode?: string;
  /** Allergens, where the department produces food (M03-FR-03). */
  readonly allergens?: readonly string[];
  readonly producedAt: string;
}

export class IncompleteLabelError extends Error {
  constructor(
    public readonly batchId: string,
    public readonly missing: string,
  ) {
    super(
      `The label for batch "${batchId}" cannot print without ${missing} — a wrong label is a legal problem, not a printing one (§9.3)`,
    );
    this.name = 'IncompleteLabelError';
  }
}

/**
 * Build a pack label, refusing anything that would print an unlawful one. What is
 * mandatory depends on the DEPARTMENT: a cafe sandwich needs its net quantity and
 * allergens; only a weighed department needs a weight on the label.
 */
export function buildPackLabel(
  label: PackLabel,
  department: ProductionDepartment,
): PackLabel {
  if (label.productName.trim() === '') {
    throw new IncompleteLabelError(label.batchId, 'the product name');
  }
  if (label.useBy.trim() === '') {
    throw new IncompleteLabelError(label.batchId, 'a use-by date');
  }
  if (department.legalMetrology) {
    if (label.netQuantity.trim() === '') {
      throw new IncompleteLabelError(label.batchId, 'the net quantity (Legal Metrology)');
    }
    if (label.packerDetails.trim() === '') {
      throw new IncompleteLabelError(label.batchId, 'the packer’s name and address (Legal Metrology)');
    }
  }
  if (department.foodSafety && label.allergens === undefined) {
    // The same rule as the product master: an empty list is a declaration of
    // "none"; saying nothing is not.
    throw new IncompleteLabelError(
      label.batchId,
      'an allergen declaration — state the allergens, or state explicitly that there are none',
    );
  }
  if (department.weighedOutput && label.weightMinor === undefined) {
    throw new IncompleteLabelError(label.batchId, 'the weight (this department sells by weight)');
  }
  return label;
}

/**
 * Render a label as text lines — the same shape the receipt renderer uses, so a
 * counter printer needs no new plumbing.
 */
export function renderLabel(label: PackLabel): readonly string[] {
  const lines = [
    label.productName,
    `Batch ${label.batchId}`,
    label.netQuantity === '' ? '' : `Net ${label.netQuantity}`,
    label.weightMinor === undefined ? '' : `Weight ${(label.weightMinor / 1000).toFixed(3)} kg`,
    `USE BY ${label.useBy.slice(0, 16).replace('T', ' ')}`,
    label.allergens === undefined || label.allergens.length === 0
      ? 'Allergens: none declared'
      : `Contains: ${label.allergens.join(', ')}`,
    label.packerDetails === '' ? '' : `Packed by ${label.packerDetails}`,
    `${label.price.currency} ${(label.price.minor / 100).toFixed(2)}`,
    label.barcode === undefined ? '' : label.barcode,
  ];
  return lines.filter((line) => line !== '');
}

// --- quality release -----------------------------------------------------------

export interface QualityRelease {
  readonly batchId: string;
  readonly releasedBy: string;
  readonly qcPassed: boolean;
  readonly at: string;
  readonly notes?: string;
}

export type ReleaseRefusal =
  | 'qc_failed'
  | 'already_expired'
  | 'no_releaser'
  | 'nothing_to_release'
  | 'released';

export interface ReleaseResult {
  readonly batchId: string;
  readonly released: boolean;
  readonly outcome: ReleaseRefusal;
  readonly detail: string;
  /** The movement out of quarantine into sellable stock — empty when refused. */
  readonly movements: readonly StockMovement[];
}

/**
 * Release a produced batch for sale. Moves it out of quarantine — and only out of
 * quarantine, so a batch that was never produced cannot be conjured onto the shelf.
 */
export function releaseForSale(input: {
  readonly release: QualityRelease;
  readonly productId: string;
  readonly locationId: string;
  readonly quantityMinor: number;
  readonly uom: string;
  /** When the batch expires, from production. */
  readonly expiresAt: string;
}): ReleaseResult {
  const { release } = input;
  const base = { batchId: release.batchId, movements: [] as readonly StockMovement[] };

  if (release.releasedBy.trim() === '') {
    return {
      ...base,
      released: false,
      outcome: 'no_releaser',
      detail: 'a release must be made by a named person — "it was checked" is not evidence',
    };
  }
  if (input.quantityMinor <= 0) {
    return { ...base, released: false, outcome: 'nothing_to_release', detail: 'there is nothing to release' };
  }
  if (!release.qcPassed) {
    return {
      ...base,
      released: false,
      outcome: 'qc_failed',
      detail: `the quality check failed${release.notes === undefined ? '' : ` — ${release.notes}`}; the batch stays in quarantine`,
    };
  }
  if (input.expiresAt <= release.at) {
    // You cannot release your way past a use-by date.
    return {
      ...base,
      released: false,
      outcome: 'already_expired',
      detail: `the batch expired at ${input.expiresAt} and can never be released`,
    };
  }

  return {
    batchId: release.batchId,
    released: true,
    outcome: 'released',
    detail: `released for sale by ${release.releasedBy}`,
    movements: [
      {
        movementId: `${release.batchId}-release`,
        productId: input.productId,
        locationId: input.locationId,
        batchId: release.batchId,
        from: 'quarantine',
        to: 'on_hand',
        quantityMinor: input.quantityMinor,
        uom: input.uom,
        at: release.at,
        reason: `quality release by ${release.releasedBy}`,
      },
    ],
  };
}

// --- repacking -----------------------------------------------------------------

export interface RepackRequest {
  readonly repackId: string;
  readonly sourceBatchId: string;
  readonly newBatchId: string;
  readonly productId: string;
  readonly locationId: string;
  readonly quantityMinor: number;
  readonly uom: string;
  readonly repackedBy: string;
  readonly at: string;
  /** The source batch's expiry — a repack NEVER extends it. */
  readonly sourceExpiresAt: string;
}

export interface RepackResult {
  readonly repackId: string;
  readonly newBatchId: string;
  readonly sourceBatchId: string;
  /** Inherited, never reset — repacking does not make food younger. */
  readonly expiresAt: string;
  readonly movements: readonly StockMovement[];
}

export class RepackError extends Error {
  constructor(
    public readonly repackId: string,
    reason: string,
  ) {
    super(`Repack "${repackId}" refused: ${reason}`);
    this.name = 'RepackError';
  }
}

/**
 * Repack a batch into a new one. The new batch keeps the SOURCE's expiry — putting
 * food in a fresh wrapper does not make it fresh — and records where it came from,
 * so a recall on the source reaches everything made out of it (M10-FR-03).
 */
export function repack(request: RepackRequest): RepackResult {
  if (request.sourceBatchId === request.newBatchId) {
    throw new RepackError(request.repackId, 'the new batch must be distinguishable from its source');
  }
  if (request.quantityMinor <= 0) {
    throw new RepackError(request.repackId, 'there is nothing to repack');
  }
  if (request.sourceExpiresAt <= request.at) {
    throw new RepackError(
      request.repackId,
      'the source batch has already expired — repacking is not a way to sell it',
    );
  }

  return {
    repackId: request.repackId,
    newBatchId: request.newBatchId,
    sourceBatchId: request.sourceBatchId,
    expiresAt: request.sourceExpiresAt,
    movements: [
      {
        movementId: `${request.repackId}-out`,
        productId: request.productId,
        locationId: request.locationId,
        batchId: request.sourceBatchId,
        from: 'on_hand',
        to: null,
        quantityMinor: request.quantityMinor,
        uom: request.uom,
        at: request.at,
        reason: `repacked into ${request.newBatchId} by ${request.repackedBy}`,
      },
      {
        movementId: `${request.repackId}-in`,
        productId: request.productId,
        locationId: request.locationId,
        batchId: request.newBatchId,
        from: null,
        to: 'quarantine', // a repack is released like any other production output
        quantityMinor: request.quantityMinor,
        uom: request.uom,
        at: request.at,
        reason: `repacked from ${request.sourceBatchId} by ${request.repackedBy}`,
      },
    ],
  };
}
