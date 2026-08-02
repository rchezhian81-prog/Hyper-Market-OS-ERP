// Gap-free number series (M01-FR-02) — document numbers (receipt, invoice, PO,
// GRN, statement) are gap-free and unique per type. Offline lanes draw from
// pre-allocated RESERVED RANGES so two lanes offline for a day never collide;
// ranges are reconciled on sync. Pure, deterministic domain logic.

/** How a sequence number is rendered, e.g. { prefix: "INV", padTo: 6 } → "INV000042". */
export interface NumberFormat {
  readonly prefix: string;
  readonly padTo: number;
}

/** A contiguous, inclusive block of reserved sequence numbers. */
export interface ReservedRange {
  readonly start: number;
  readonly end: number;
}

/** An allocated number: the raw sequence and its formatted string. */
export interface AllocatedNumber {
  readonly seq: number;
  readonly formatted: string;
}

export function formatNumber(format: NumberFormat, seq: number): string {
  return `${format.prefix}${String(seq).padStart(format.padTo, '0')}`;
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer, got ${value}.`);
  }
}

/**
 * The authoritative, gap-free series for one document type (held in the cloud).
 * `allocate` hands out the next number; `reserve` carves off a contiguous block
 * for an offline lane so the blocks never overlap.
 */
export class NumberSeries {
  private next: number;

  constructor(
    private readonly format: NumberFormat,
    start = 1,
  ) {
    assertPositiveInteger('start', start);
    this.next = start;
  }

  /** Allocate the next number (gap-free, sequential). */
  allocate(): AllocatedNumber {
    const seq = this.next;
    this.next += 1;
    return { seq, formatted: formatNumber(this.format, seq) };
  }

  /** Reserve a contiguous block of `size` numbers for an offline lane. */
  reserve(size: number): ReservedRange {
    assertPositiveInteger('size', size);
    const start = this.next;
    this.next += size;
    return { start, end: start + size - 1 };
  }

  /** The next number that would be allocated (for inspection). */
  peekNext(): number {
    return this.next;
  }
}

/**
 * Allocates numbers within a single reserved range — used by an offline lane.
 * Gap-free within the range; throws when exhausted (the lane must obtain a fresh
 * range on the next sync).
 */
export class ReservedRangeAllocator {
  private next: number;

  constructor(
    private readonly format: NumberFormat,
    private readonly range: ReservedRange,
  ) {
    this.next = range.start;
  }

  /** Allocate the next number within the range; throws when exhausted. */
  allocate(): AllocatedNumber {
    if (this.next > this.range.end) {
      throw new RangeError('Reserved number range exhausted — obtain a new range on sync.');
    }
    const seq = this.next;
    this.next += 1;
    return { seq, formatted: formatNumber(this.format, seq) };
  }

  /** How many numbers remain in the range. */
  remaining(): number {
    return Math.max(0, this.range.end - this.next + 1);
  }
}
