// ESC/POS encoding and the printer port (M31-FR-02 / hard rule #1). ESC/POS is the
// command language essentially every thermal receipt printer speaks, so encoding to
// it here keeps the lane independent of any one printer vendor (P-06).
//
// The encoder is PURE — text lines in, bytes out — so a receipt's exact output is
// asserted in tests without a printer attached. The `PrinterPort` is the only place
// I/O happens, and the POS depends on that port, never on a driver: a lane with a
// dead printer still commits the sale (hard rule #1) and reports the failure.

/** ESC/POS control sequences used here (each is a printer command, not text). */
const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

export interface EncodeOptions {
  /** Feed this many blank lines before cutting, so the tear-off clears the head. */
  readonly feedLines?: number;
  /** Cut the paper at the end (a printer without a cutter ignores it). */
  readonly cut?: boolean;
  /** Kick the cash drawer — only meaningful for a cash tender. */
  readonly openDrawer?: boolean;
}

function ascii(text: string): number[] {
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0x3f;
    // The printer's default code page is ASCII; anything outside prints as '?'
    // rather than as mojibake, so a receipt is never silently garbled.
    bytes.push(code <= 0x7f ? code : 0x3f);
  }
  return bytes;
}

/**
 * Encode rendered receipt lines into ESC/POS bytes: initialise, print each line,
 * feed, optionally cut, and optionally kick the drawer. Pure and deterministic.
 */
export function encodeEscPos(lines: readonly string[], options: EncodeOptions = {}): Uint8Array {
  const bytes: number[] = [];

  bytes.push(ESC, 0x40); // ESC @ — initialise (clears any previous state)

  for (const line of lines) {
    bytes.push(...ascii(line), LF);
  }

  const feed = options.feedLines ?? 3;
  for (let i = 0; i < feed; i += 1) bytes.push(LF);

  if (options.cut !== false) {
    bytes.push(GS, 0x56, 0x42, 0x00); // GS V B 0 — partial cut with feed
  }
  if (options.openDrawer) {
    bytes.push(ESC, 0x70, 0x00, 0x19, 0xfa); // ESC p — pulse drawer pin 2
  }

  return Uint8Array.from(bytes);
}

/** The port a lane writes bytes through — a USB/serial/network printer adapter. */
export interface PrinterPort {
  write(bytes: Uint8Array): Promise<void>;
}

export type PrintOutcome =
  | { readonly status: 'printed' }
  | { readonly status: 'failed'; readonly reason: string };

/**
 * Print rendered lines. A printer failure is RETURNED, never thrown into the sale
 * path: the sale is already committed and must stay committed (hard rule #1), so the
 * lane shows "sale saved — printer failed, reprint from the bill list" rather than
 * losing the transaction.
 */
export async function printReceipt(
  printer: PrinterPort,
  lines: readonly string[],
  options: EncodeOptions = {},
): Promise<PrintOutcome> {
  try {
    await printer.write(encodeEscPos(lines, options));
    return { status: 'printed' };
  } catch (err) {
    return { status: 'failed', reason: err instanceof Error ? err.message : 'printer error' };
  }
}
