// Scale-label barcode generation (M11-FR-03 → M03-FR-02).
//
// The counter prints a label; the till scans it four minutes later. If the two
// disagree about where the weight sits in the barcode, the customer is charged for
// the wrong thing and nobody finds out until the count is wrong at month end.
//
// So the label is generated from the SAME per-tenant `EmbeddedBarcodeRule` the
// catalogue parses with. One definition, both directions — which is why the
// acceptance test for this file prints a label and then scans it through the real
// `CatalogueCache`, rather than asserting the format twice.
//
// The check digit is computed, not assumed. A scale that prints an unchecked
// barcode produces labels that most scanners reject and some accept wrongly.
//
// Pure and deterministic: no clock, no I/O.

import type { EmbeddedBarcodeRule } from '../../catalogue/src/catalogue';
import type { Money } from '../../contracts/src/money';

export class ScaleLabelError extends Error {
  constructor(reason: string) {
    super(`Cannot generate a scale barcode: ${reason}`);
    this.name = 'ScaleLabelError';
  }
}

/** EAN-13 check digit: weights 1,3 from the left across the first 12 digits. */
export function ean13CheckDigit(twelveDigits: string): string {
  if (!/^\d{12}$/.test(twelveDigits)) {
    throw new ScaleLabelError(`"${twelveDigits}" is not 12 digits`);
  }
  let sum = 0;
  for (let i = 0; i < 12; i += 1) {
    sum += Number(twelveDigits[i]) * (i % 2 === 0 ? 1 : 3);
  }
  return String((10 - (sum % 10)) % 10);
}

/**
 * Build the barcode a scale prints, from the tenant's own embedded-barcode rule.
 *
 * `value` is the weight in the UOM's smallest unit for a `weight` rule, or the
 * price in minor units for a `price` rule — exactly what the catalogue will read
 * back out of it.
 */
export function buildScaleBarcode(input: {
  readonly rule: EmbeddedBarcodeRule;
  /** The item code the catalogue knows this product by. */
  readonly itemCode: string;
  readonly value: number;
  /** Total barcode length; 13 (EAN-13) unless the tenant's scales differ. */
  readonly length?: number;
}): string {
  const { rule, itemCode, value } = input;
  const length = input.length ?? 13;

  if (itemCode.length !== rule.itemLength) {
    throw new ScaleLabelError(
      `item code "${itemCode}" is ${itemCode.length} characters, but the rule expects ${rule.itemLength}`,
    );
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ScaleLabelError(`the embedded value must be a whole number, got ${value}`);
  }
  const valueDigits = String(value);
  if (valueDigits.length > rule.valueLength) {
    // Truncating here would silently charge the wrong amount — refuse instead.
    throw new ScaleLabelError(
      `${value} needs ${valueDigits.length} digits but the barcode has room for ${rule.valueLength}` +
        (rule.valueKind === 'weight'
          ? ' — the pack is too heavy for this barcode format'
          : ' — the price is too high for this barcode format'),
    );
  }

  const body = Array.from({ length: length - 1 }, () => '0');
  const place = (start: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) {
      if (start + i >= body.length) {
        throw new ScaleLabelError('the rule places a field beyond the end of the barcode');
      }
      body[start + i] = text[i] ?? '0';
    }
  };

  place(0, rule.prefix);
  place(rule.itemStart, itemCode);
  place(rule.valueStart, valueDigits.padStart(rule.valueLength, '0'));

  const withoutCheck = body.join('');
  return length === 13
    ? `${withoutCheck}${ean13CheckDigit(withoutCheck)}`
    : withoutCheck;
}

/** A weighed pack, ready for its label. */
export interface WeighedPack {
  readonly itemCode: string;
  readonly productName: string;
  readonly batchId: string;
  readonly weightGrams: number;
  readonly pricePerKg: Money;
  readonly useBy: string;
  readonly netQuantity: string;
  readonly packerDetails: string;
  readonly allergens?: readonly string[];
}

export interface ScaleLabelResult {
  readonly barcode: string;
  readonly price: Money;
  readonly weightGrams: number;
  readonly lines: readonly string[];
}

/**
 * Produce the barcode and the printed lines for a weighed pack. The price on the
 * label is computed from the weight, so the sticker and the till agree by
 * construction rather than by coincidence.
 */
export function buildScaleLabel(pack: WeighedPack, rule: EmbeddedBarcodeRule): ScaleLabelResult {
  if (pack.weightGrams <= 0) {
    throw new ScaleLabelError('a weighed pack cannot weigh nothing');
  }
  const price: Money = {
    minor: Math.round((pack.pricePerKg.minor * pack.weightGrams) / 1_000),
    currency: pack.pricePerKg.currency,
  };
  const barcode = buildScaleBarcode({
    rule,
    itemCode: pack.itemCode,
    value: rule.valueKind === 'weight' ? pack.weightGrams : price.minor,
  });

  return {
    barcode,
    price,
    weightGrams: pack.weightGrams,
    lines: [
      pack.productName,
      `Batch ${pack.batchId}`,
      `Net ${pack.netQuantity}`,
      `Weight ${(pack.weightGrams / 1000).toFixed(3)} kg`,
      `${pack.pricePerKg.currency} ${(pack.pricePerKg.minor / 100).toFixed(2)} per kg`,
      `USE BY ${pack.useBy.slice(0, 16).replace('T', ' ')}`,
      pack.allergens === undefined || pack.allergens.length === 0
        ? 'Allergens: none declared'
        : `Contains: ${pack.allergens.join(', ')}`,
      `Packed by ${pack.packerDetails}`,
      `${price.currency} ${(price.minor / 100).toFixed(2)}`,
      barcode,
    ],
  };
}
