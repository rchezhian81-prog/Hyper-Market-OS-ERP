// Pack hierarchy, unit conversion and barcode uniqueness (M03-FR-02).
//
// A case of 24 arrives at the back door; 24 singles must appear on the shelf. If
// that conversion is ever approximate, the stock figure is wrong from the first
// delivery and every count afterwards inherits the error. So conversions here are
// **exact integers and reversible** — a case converts to units and back to exactly
// one case, or the pack is rejected at definition time rather than corrupting stock
// at receiving time.
//
// The other half is the barcode rule the whole till depends on:
//
//     A BARCODE MAPS TO EXACTLY ONE SELLABLE ITEM.
//
// If the same code sits on two products, the till has to guess, and it will guess
// wrong at the worst moment. The registry refuses the second one and names the
// product that already owns it.
//
// Pure and deterministic: no clock, no I/O.

/** A level in the pack hierarchy: unit → inner → case → pallet. */
export interface PackLevel {
  readonly level: string;
  /** How many of the level BELOW fit in one of this level. Exact integer > 0. */
  readonly containsMinor: number;
  /** Barcode on this pack level, where it carries its own. */
  readonly barcode?: string;
}

export interface PackHierarchy {
  readonly productId: string;
  readonly baseUom: string;
  /** Ordered from the smallest level upward; the first is the base unit. */
  readonly levels: readonly PackLevel[];
}

export class InvalidPackError extends Error {
  constructor(
    public readonly productId: string,
    reason: string,
  ) {
    super(`Pack hierarchy for "${productId}" is invalid: ${reason}`);
    this.name = 'InvalidPackError';
  }
}

export class UnknownPackLevelError extends Error {
  constructor(
    public readonly productId: string,
    public readonly level: string,
  ) {
    super(`Product "${productId}" has no pack level "${level}"`);
    this.name = 'UnknownPackLevelError';
  }
}

/** Validate a pack hierarchy — an inexact pack is refused before it can do harm. */
export function validatePack(pack: PackHierarchy): PackHierarchy {
  if (pack.levels.length === 0) {
    throw new InvalidPackError(pack.productId, 'it has no levels');
  }
  const base = pack.levels[0];
  if (base === undefined || base.containsMinor !== 1) {
    throw new InvalidPackError(pack.productId, 'the base level must contain exactly 1 base unit');
  }
  for (const level of pack.levels) {
    if (!Number.isSafeInteger(level.containsMinor) || level.containsMinor < 1) {
      throw new InvalidPackError(
        pack.productId,
        `"${level.level}" contains ${level.containsMinor} — a pack must hold a whole number of the level below`,
      );
    }
  }
  const names = pack.levels.map((l) => l.level);
  if (new Set(names).size !== names.length) {
    throw new InvalidPackError(pack.productId, 'two levels share a name');
  }
  return pack;
}

/** How many base units one of `level` holds — the product of every level up to it. */
export function unitsPerLevel(pack: PackHierarchy, level: string): number {
  const index = pack.levels.findIndex((l) => l.level === level);
  if (index === -1) {
    throw new UnknownPackLevelError(pack.productId, level);
  }
  return pack.levels.slice(0, index + 1).reduce((factor, l) => factor * l.containsMinor, 1);
}

/** Convert a quantity at one pack level into base units. Exact, always. */
export function toBaseUnits(pack: PackHierarchy, quantity: number, level: string): number {
  return quantity * unitsPerLevel(validatePack(pack), level);
}

/**
 * Convert base units back to a pack level. Returns whole packs and the remainder in
 * base units — never a fraction of a case, because half a case is not a thing you
 * can put on a shelf or return to a supplier.
 */
export function fromBaseUnits(
  pack: PackHierarchy,
  baseUnits: number,
  level: string,
): { readonly packs: number; readonly remainderBaseUnits: number } {
  const factor = unitsPerLevel(validatePack(pack), level);
  const packs = Math.trunc(baseUnits / factor);
  return { packs, remainderBaseUnits: baseUnits - packs * factor };
}

/** True when converting up and back down returns exactly what went in. */
export function conversionIsReversible(pack: PackHierarchy, level: string): boolean {
  const factor = unitsPerLevel(pack, level);
  const there = toBaseUnits(pack, 1, level);
  const back = fromBaseUnits(pack, there, level);
  return there === factor && back.packs === 1 && back.remainderBaseUnits === 0;
}

// --- barcode uniqueness ------------------------------------------------------

export type BarcodeKind = 'gtin' | 'ean' | 'upc' | 'internal' | 'case' | 'embedded';

export interface BarcodeAssignment {
  readonly code: string;
  readonly productId: string;
  readonly kind: BarcodeKind;
  /** The pack level this code identifies; defaults to the base unit. */
  readonly level?: string;
}

export class DuplicateBarcodeError extends Error {
  constructor(
    public readonly code: string,
    public readonly ownedBy: string,
    public readonly attemptedBy: string,
  ) {
    super(
      `Barcode "${code}" already belongs to product "${ownedBy}" — it cannot also belong to "${attemptedBy}"`,
    );
    this.name = 'DuplicateBarcodeError';
  }
}

/**
 * The barcode register. Enforces the rule the till depends on: one code, one item.
 * Re-registering the SAME code to the SAME product is a harmless no-op (an import
 * re-run must not fail); registering it to a different product is refused.
 */
export class BarcodeRegistry {
  private readonly byCode = new Map<string, BarcodeAssignment>();

  constructor(existing: readonly BarcodeAssignment[] = []) {
    for (const assignment of existing) {
      this.register(assignment);
    }
  }

  register(assignment: BarcodeAssignment): BarcodeAssignment {
    const code = assignment.code.trim();
    if (code === '') {
      throw new DuplicateBarcodeError('', '(empty)', assignment.productId);
    }
    const existing = this.byCode.get(code);
    if (existing && existing.productId !== assignment.productId) {
      throw new DuplicateBarcodeError(code, existing.productId, assignment.productId);
    }
    const stored = { ...assignment, code };
    this.byCode.set(code, stored);
    return stored;
  }

  lookup(code: string): BarcodeAssignment | undefined {
    return this.byCode.get(code.trim());
  }

  /** Every code for one product — the coverage report's raw material. */
  forProduct(productId: string): readonly BarcodeAssignment[] {
    return [...this.byCode.values()].filter((a) => a.productId === productId);
  }

  size(): number {
    return this.byCode.size;
  }
}

/**
 * Find products with no barcode at all — they cannot be scanned, so every sale of
 * them is a manual search that slows the lane down (M03-FR-02 coverage report).
 */
export function barcodeCoverageGaps(
  productIds: readonly string[],
  registry: BarcodeRegistry,
): readonly string[] {
  return productIds.filter((id) => registry.forProduct(id).length === 0);
}
