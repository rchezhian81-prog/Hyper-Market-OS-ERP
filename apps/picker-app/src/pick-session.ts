// Picker/packer handheld session (M19 / M18 / D09) — the model behind the picker
// screens (`docs/design/screens/picker-packer.md`). It runs on a low-spec Android
// handheld in the aisles, so it is **synchronous and local by construction**: the
// assigned wave is cached, every scan is recorded locally, and nothing here awaits
// the network (§31 picking row). PII is minimised — a pick line carries the order
// reference, never customer details.
//
// The rules the spec insists on, enforced here rather than trusted to the picker:
//   • EVERY PICK IS A SCAN, in order — scan the bin, then scan the item, then
//     confirm. Confirming without those scans is refused, and scanning the wrong
//     item for the bin is refused;
//   • A SUBSTITUTION IS NEVER THE PICKER'S SILENT CHOICE — it commits only with the
//     customer's confirmation (A04), delegated to `packages/fulfilment`;
//   • A WEIGHED ITEM CAPTURES ITS FINAL PRICE AT PICK (D09), so the bill matches
//     what was actually put in the crate;
//   • THE MANIFEST MATCHES WHAT WAS PACKED — it is derived from the picked lines,
//     never typed, and packing is blocked while any line is unresolved.

import { money, multiplyByInteger, scaleMoney, type Money, type CurrencyCode } from '../../../packages/contracts/src/money';
import { precisionOf, type Uom } from '../../../packages/contracts/src/quantity';
import { confirmSubstitution } from '../../../packages/fulfilment/src/delivery';

export type LineState = 'pending' | 'picked' | 'short' | 'substituted' | 'quality_failed';

/** One line of assigned work. `bin` is where the picker must scan first. */
export interface PickLineInput {
  readonly lineId: string;
  readonly orderRef: string;
  readonly productId: string;
  readonly description: string;
  readonly bin: string;
  /** Required quantity in the UOM's smallest unit. */
  readonly requiredQty: number;
  readonly uom: Uom;
  /** Price per UOM unit — used to capture a weighed line's final price (D09). */
  readonly unitPrice: Money;
}

export interface PickLine extends PickLineInput {
  readonly state: LineState;
  /** What was actually picked (may be less than required on a short pick). */
  readonly pickedQty: number;
  /** Final line price captured at pick — exact for weighed goods (D09). */
  readonly finalPrice: Money;
  readonly substituteProductId?: string;
  readonly note?: string;
}

export interface WaveProgress {
  readonly total: number;
  readonly resolved: number;
  readonly pending: number;
  readonly complete: boolean;
}

/** Cold-chain / tamper evidence recorded at packing (M19-FR-02). */
export interface PackEvidence {
  readonly temperatureC?: number;
  readonly tamperSealRef?: string;
  readonly packedBy: string;
  readonly at: string;
}

export interface ManifestLine {
  readonly lineId: string;
  readonly orderRef: string;
  readonly productId: string;
  readonly description: string;
  readonly qty: number;
  readonly uom: Uom;
  readonly finalPrice: Money;
  readonly substituted: boolean;
}

export interface DispatchManifest {
  readonly waveId: string;
  readonly packedBy: string;
  readonly at: string;
  readonly lines: readonly ManifestLine[];
  readonly totalValue: Money;
  readonly evidence: PackEvidence;
}

export class NoSuchLineError extends Error {
  constructor(lineId: string) {
    super(`No pick line "${lineId}" in this wave.`);
    this.name = 'NoSuchLineError';
  }
}

export class BinNotScannedError extends Error {
  constructor(bin: string) {
    super(`Scan bin ${bin} before picking from it.`);
    this.name = 'BinNotScannedError';
  }
}

export class WrongItemError extends Error {
  constructor(expected: string, scanned: string) {
    super(`Wrong item: expected ${expected}, scanned ${scanned}.`);
    this.name = 'WrongItemError';
  }
}

export class LineAlreadyResolvedError extends Error {
  constructor(lineId: string, state: LineState) {
    super(`Line "${lineId}" is already ${state}.`);
    this.name = 'LineAlreadyResolvedError';
  }
}

export class WaveNotCompleteError extends Error {
  constructor(pending: number) {
    super(`Cannot pack: ${pending} line(s) still unresolved.`);
    this.name = 'WaveNotCompleteError';
  }
}

export class ReasonRequiredError extends Error {
  constructor(what: string) {
    super(`A ${what} needs a reason — it is recorded against the order.`);
    this.name = 'ReasonRequiredError';
  }
}

/**
 * A picker's assigned wave. Everything is local and synchronous — the handheld
 * works with no signal and the scans queue for sync afterwards.
 */
export class PickSession {
  private readonly lines: PickLine[];
  private scannedBin: string | null = null;
  private packed: DispatchManifest | null = null;

  constructor(
    readonly waveId: string,
    assigned: readonly PickLineInput[],
    private readonly currency: CurrencyCode = 'INR',
  ) {
    this.lines = assigned.map((l) => ({
      ...l,
      state: 'pending' as LineState,
      pickedQty: 0,
      finalPrice: money(0, currency),
    }));
  }

  /** The assigned work, as the handheld lists it. */
  work(): readonly PickLine[] {
    return this.lines.slice();
  }

  progress(): WaveProgress {
    const pending = this.lines.filter((l) => l.state === 'pending').length;
    return {
      total: this.lines.length,
      resolved: this.lines.length - pending,
      pending,
      complete: pending === 0,
    };
  }

  /** Step 1 of every pick: scan the bin the picker is standing at. */
  scanBin(bin: string): void {
    this.scannedBin = bin.trim();
  }

  private lineOrThrow(lineId: string): PickLine {
    const line = this.lines.find((l) => l.lineId === lineId);
    if (line === undefined) throw new NoSuchLineError(lineId);
    return line;
  }

  private replace(next: PickLine): void {
    const index = this.lines.findIndex((l) => l.lineId === next.lineId);
    this.lines[index] = next;
  }

  private assertPickable(line: PickLine): void {
    if (line.state !== 'pending') {
      throw new LineAlreadyResolvedError(line.lineId, line.state);
    }
    // Step 1 must have happened, at the right bin.
    if (this.scannedBin !== line.bin) {
      throw new BinNotScannedError(line.bin);
    }
  }

  /** The exact line price for a quantity — weighed goods price to the paisa (D09). */
  private priceFor(line: PickLine, qty: number): Money {
    const denominator = 10 ** precisionOf(line.uom);
    return denominator === 1
      ? multiplyByInteger(line.unitPrice, qty)
      : scaleMoney(line.unitPrice, qty, denominator, 'half_up');
  }

  /**
   * Steps 2 and 3: scan the item, then confirm the quantity. Refuses a wrong item
   * and refuses picking before the bin was scanned. Captures the final price —
   * exact for a weighed line (D09). Picking less than required is a SHORT pick, so
   * the order is updated honestly (M19-FR-01) rather than silently completed.
   */
  pick(lineId: string, scannedProductId: string, qty: number): PickLine {
    const line = this.lineOrThrow(lineId);
    this.assertPickable(line);
    if (scannedProductId.trim() !== line.productId) {
      throw new WrongItemError(line.productId, scannedProductId.trim());
    }
    if (!Number.isSafeInteger(qty) || qty <= 0) {
      throw new RangeError(`Picked quantity must be a positive integer, got ${qty}.`);
    }
    if (qty > line.requiredQty) {
      throw new RangeError(`Cannot pick more than the ${line.requiredQty} required.`);
    }

    const next: PickLine = {
      ...line,
      state: qty < line.requiredQty ? 'short' : 'picked',
      pickedQty: qty,
      finalPrice: this.priceFor(line, qty),
    };
    this.replace(next);
    return next;
  }

  /**
   * Record a substitution for a short line. It commits ONLY with the customer's
   * confirmation (A04) — delegated to `packages/fulfilment`, which refuses an
   * unconfirmed swap. Never the picker's silent choice.
   */
  substitute(
    lineId: string,
    substituteProductId: string,
    customerConfirmed: boolean,
    qty: number,
    substituteUnitPrice: Money,
  ): PickLine {
    const line = this.lineOrThrow(lineId);
    if (line.state === 'picked' || line.state === 'substituted') {
      throw new LineAlreadyResolvedError(lineId, line.state);
    }
    // Throws SubstitutionNotConfirmedError when the customer has not agreed.
    confirmSubstitution({
      orderLineId: lineId,
      originalProductId: line.productId,
      substituteProductId,
      customerConfirmed,
    });

    const priced: PickLine = { ...line, unitPrice: substituteUnitPrice };
    const next: PickLine = {
      ...priced,
      state: 'substituted',
      pickedQty: qty,
      finalPrice: this.priceFor(priced, qty),
      substituteProductId,
    };
    this.replace(next);
    return next;
  }

  /** Flag a quality failure — the line is excluded from the pack, with a reason. */
  failQuality(lineId: string, reason: string): PickLine {
    const line = this.lineOrThrow(lineId);
    if (reason.trim() === '') throw new ReasonRequiredError('quality failure');
    const next: PickLine = {
      ...line,
      state: 'quality_failed',
      pickedQty: 0,
      finalPrice: money(0, this.currency),
      note: reason,
    };
    this.replace(next);
    return next;
  }

  /** Mark a line short with nothing picked (item unavailable, no substitute accepted). */
  markUnavailable(lineId: string, reason: string): PickLine {
    const line = this.lineOrThrow(lineId);
    if (reason.trim() === '') throw new ReasonRequiredError('short pick');
    const next: PickLine = { ...line, state: 'short', pickedQty: 0, finalPrice: money(0, this.currency), note: reason };
    this.replace(next);
    return next;
  }

  /**
   * Pack the wave and produce the dispatch manifest. Blocked while any line is
   * unresolved. The manifest is DERIVED from what was actually picked — quality
   * failures and zero-pick shorts are excluded — so it matches the crate exactly
   * (M19-FR-02 acceptance).
   */
  pack(evidence: PackEvidence): DispatchManifest {
    const progress = this.progress();
    if (!progress.complete) {
      throw new WaveNotCompleteError(progress.pending);
    }

    const packedLines = this.lines.filter((l) => l.pickedQty > 0 && l.state !== 'quality_failed');
    let totalValue = money(0, this.currency);
    const lines: ManifestLine[] = packedLines.map((l) => {
      totalValue = money(totalValue.minor + l.finalPrice.minor, this.currency);
      return {
        lineId: l.lineId,
        orderRef: l.orderRef,
        productId: l.substituteProductId ?? l.productId,
        description: l.description,
        qty: l.pickedQty,
        uom: l.uom,
        finalPrice: l.finalPrice,
        substituted: l.state === 'substituted',
      };
    });

    this.packed = {
      waveId: this.waveId,
      packedBy: evidence.packedBy,
      at: evidence.at,
      lines,
      totalValue,
      evidence,
    };
    return this.packed;
  }

  /** The manifest once packed, or null before. */
  manifest(): DispatchManifest | null {
    return this.packed;
  }
}
