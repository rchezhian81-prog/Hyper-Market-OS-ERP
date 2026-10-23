// Camera barcode search (D08-FR-02 "voice/barcode search") — the tested rule, DOM-free.
//
// The phone's camera reads the barcode with the browser's own barcode reader (the standard `BarcodeDetector`, which
// works on the phone itself — no picture leaves the phone). What it read becomes an ORDINARY search the customer sees and
// can change, exactly like typing the number under the barcode; nothing is ever added to the basket by scanning. A phone
// without a reader, or without a camera allowed, is told to type the number instead — the typed field is always there.

/** One thing the reader saw. */
export interface DetectedCode { readonly rawValue: string; readonly format?: string }

/** The shape of a barcode reader (the browser's `BarcodeDetector`, or a test's stand-in). */
export interface BarcodeReader { detect(frame: unknown): Promise<readonly DetectedCode[]> }

/** The product barcodes a shop shelf carries — EAN-13, EAN-8, UPC-A (12), ITF-14 — and only those. */
export const RETAIL_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'itf'] as const;

/** A GTIN (8, 12, 13 or 14 digits) whose last digit is the right check digit. */
export function gtinValid(code: string): boolean {
  if (!/^(\d{8}|\d{12,14})$/.test(code)) return false;
  const digits = [...code].map(Number);
  const check = digits.pop()!;
  // From the right, the digits next to the check digit are weighted 3, then 1, alternately.
  const sum = digits.reverse().reduce((t, d, i) => t + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

/** The first retail barcode in what the reader saw, or undefined — a QR code, a misread or a partial code is not one. */
export function readScan(seen: readonly DetectedCode[]): string | undefined {
  for (const s of seen) {
    const code = String(s.rawValue ?? '').trim();
    if (gtinValid(code)) return code;
  }
  return undefined;
}

export type ScanResult =
  | { readonly found: true; readonly code: string }
  | { readonly found: false; readonly why: 'not_supported' | 'camera_denied' | 'nothing_found' | 'stopped' };

/**
 * Look at frames until a retail barcode is read, the customer stops, or `maxFrames` frames have shown nothing. Each
 * frame is the caller's (a video element); the wait between frames is the caller's too, so this stays testable.
 */
export async function scanFrames(input: {
  readonly reader: BarcodeReader;
  readonly frame: () => unknown;
  readonly nextFrame: () => Promise<void>;
  readonly stopped: () => boolean;
  readonly maxFrames: number;
}): Promise<ScanResult> {
  for (let i = 0; i < input.maxFrames; i += 1) {
    if (input.stopped()) return { found: false, why: 'stopped' };
    let seen: readonly DetectedCode[] = [];
    try { seen = await input.reader.detect(input.frame()); } catch { seen = []; }
    const code = readScan(seen);
    if (code !== undefined) return { found: true, code };
    await input.nextFrame();
  }
  return { found: false, why: 'nothing_found' };
}

/** Whether this phone can scan at all: a barcode reader that knows a retail format, and a camera to ask for. */
export async function scanSupported(win: { readonly BarcodeDetector?: { getSupportedFormats?: () => Promise<readonly string[]> }; readonly navigator?: { readonly mediaDevices?: { readonly getUserMedia?: unknown } } }): Promise<boolean> {
  if (win.BarcodeDetector === undefined || typeof win.navigator?.mediaDevices?.getUserMedia !== 'function') return false;
  try {
    const formats = (await win.BarcodeDetector.getSupportedFormats?.()) ?? [];
    return formats.some((f) => (RETAIL_FORMATS as readonly string[]).includes(f));
  } catch { return false; }
}
