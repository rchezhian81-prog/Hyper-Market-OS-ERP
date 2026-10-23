// A QR Code encoder (ISO/IEC 18004) for the bill — byte mode, any version 1–40, error-correction level M by default.
//
// Why it is here: the B2C dynamic QR (roadmap v2.1 A22 · Notification 14/2020-CT · OB-326) prints on the till's bill, and
// the till prints offline (hard rule #1). No QR library is in the repository and the till must not fetch one, so this is
// the standard algorithm, written out: encode the bytes, add Reed–Solomon error correction per block and interleave, lay
// the finder, timing and alignment patterns, place the codewords in the zig-zag, and choose the mask with the lowest
// penalty. Pure and deterministic: the same text always gives the same symbol. Cross-checked module for module against
// an independent implementation in `tests/unit/a22-the-b2c-dynamic-qr.test.ts`.

export type QrErrorCorrection = 'L' | 'M' | 'Q' | 'H';

/** A QR symbol: `size` × `size` modules, `dark[y][x]` true for a dark module. No quiet zone (the renderer adds it). */
export interface QrSymbol {
  readonly version: number;
  readonly errorCorrection: QrErrorCorrection;
  readonly mask: number;
  readonly size: number;
  readonly dark: readonly (readonly boolean[])[];
}

export class QrTooLongError extends Error {
  constructor(bytes: number, ecl: QrErrorCorrection) {
    super(`${bytes} bytes do not fit in a QR code at error-correction level ${ecl}.`);
    this.name = 'QrTooLongError';
  }
}

const ECL_INDEX: Readonly<Record<QrErrorCorrection, number>> = { L: 0, M: 1, Q: 2, H: 3 };
const ECL_FORMAT_BITS: Readonly<Record<QrErrorCorrection, number>> = { L: 1, M: 0, Q: 3, H: 2 };

// Per version (index 0 unused): error-correction codewords per block, and the number of blocks — ISO/IEC 18004 Table 9.
const ECC_CODEWORDS_PER_BLOCK: readonly (readonly number[])[] = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const NUM_ERROR_CORRECTION_BLOCKS: readonly (readonly number[])[] = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

/** Modules available for data and error correction in a version (everything but the function patterns). */
function rawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

function dataCodewords(ver: number, ecl: QrErrorCorrection): number {
  const e = ECL_INDEX[ecl];
  return Math.floor(rawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK[e]![ver]! * NUM_ERROR_CORRECTION_BLOCKS[e]![ver]!;
}

// ── GF(2^8) Reed–Solomon (primitive polynomial x^8 + x^4 + x^3 + x^2 + 1) ─────────────────────────────────────────────
function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      result[j] = gfMultiply(result[j]!, root);
      if (j + 1 < degree) result[j] = result[j]! ^ result[j + 1]!;
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    divisor.forEach((coef, i) => { result[i] = result[i]! ^ gfMultiply(coef, factor); });
  }
  return result;
}

function withEccInterleaved(data: readonly number[], ver: number, ecl: QrErrorCorrection): number[] {
  const e = ECL_INDEX[ecl];
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[e]![ver]!;
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[e]![ver]!;
  const rawCodewords = Math.floor(rawDataModules(ver) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const divisor = rsDivisor(blockEccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i += 1) {
    const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < numShortBlocks) dat.push(0);
    blocks.push([...dat, ...ecc]);
  }
  const result: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i += 1) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]!);
    });
  }
  return result;
}

// ── Bits ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
function appendBits(out: number[], value: number, len: number): void {
  for (let i = len - 1; i >= 0; i -= 1) out.push((value >>> i) & 1);
}
const bit = (x: number, i: number): boolean => ((x >>> i) & 1) !== 0;

/** The data codewords for `bytes` in byte mode, padded to the version's capacity. */
function dataCodewordsFor(bytes: Uint8Array, ver: number, ecl: QrErrorCorrection): number[] {
  const bits: number[] = [];
  appendBits(bits, 0x4, 4); // byte mode
  appendBits(bits, bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) appendBits(bits, b, 8);
  const capacityBits = dataCodewords(ver, ecl) * 8;
  appendBits(bits, 0, Math.min(4, capacityBits - bits.length)); // terminator
  appendBits(bits, 0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) appendBits(bits, pad, 8);
  const words: number[] = new Array<number>(bits.length / 8).fill(0);
  bits.forEach((b, i) => { words[i >>> 3] = words[i >>> 3]! | (b << (7 - (i & 7))); });
  return words;
}

// ── The symbol ────────────────────────────────────────────────────────────────────────────────────────────────────────
class Grid {
  readonly modules: boolean[][];
  readonly isFunction: boolean[][];
  constructor(readonly size: number) {
    this.modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    this.isFunction = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  }
  setFunction(x: number, y: number, dark: boolean): void {
    this.modules[y]![x] = dark;
    this.isFunction[y]![x] = true;
  }
}

function alignmentPositions(ver: number, size: number): number[] {
  if (ver === 1) return [];
  const numAlign = Math.floor(ver / 7) + 2;
  const step = Math.floor((ver * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

function drawFormatBits(g: Grid, ecl: QrErrorCorrection, mask: number): void {
  const data = (ECL_FORMAT_BITS[ecl] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  for (let i = 0; i <= 5; i += 1) g.setFunction(8, i, bit(bits, i));
  g.setFunction(8, 7, bit(bits, 6));
  g.setFunction(8, 8, bit(bits, 7));
  g.setFunction(7, 8, bit(bits, 8));
  for (let i = 9; i < 15; i += 1) g.setFunction(14 - i, 8, bit(bits, i));
  for (let i = 0; i < 8; i += 1) g.setFunction(g.size - 1 - i, 8, bit(bits, i));
  for (let i = 8; i < 15; i += 1) g.setFunction(8, g.size - 15 + i, bit(bits, i));
  g.setFunction(8, g.size - 8, true); // the dark module
}

function drawVersion(g: Grid, ver: number): void {
  if (ver < 7) return;
  let rem = ver;
  for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (ver << 12) | rem;
  for (let i = 0; i < 18; i += 1) {
    const color = bit(bits, i);
    const a = g.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    g.setFunction(a, b, color);
    g.setFunction(b, a, color);
  }
}

function drawFunctionPatterns(g: Grid, ver: number, ecl: QrErrorCorrection): void {
  for (let i = 0; i < g.size; i += 1) {
    g.setFunction(6, i, i % 2 === 0);
    g.setFunction(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [g.size - 4, 3], [3, g.size - 4]] as const) {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < g.size && y >= 0 && y < g.size) g.setFunction(x, y, dist !== 2 && dist !== 4);
      }
    }
  }
  const align = alignmentPositions(ver, g.size);
  const n = align.length;
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) g.setFunction(align[i]! + dx, align[j]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }
  drawFormatBits(g, ecl, 0); // a placeholder, overwritten once the mask is chosen
  drawVersion(g, ver);
}

function drawCodewords(g: Grid, data: readonly number[]): void {
  let i = 0;
  for (let right = g.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < g.size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? g.size - 1 - vert : vert;
        if (!g.isFunction[y]![x] && i < data.length * 8) {
          g.modules[y]![x] = bit(data[i >>> 3]!, 7 - (i & 7));
          i += 1;
        }
      }
    }
  }
}

function maskApplies(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function applyMask(g: Grid, mask: number): void {
  for (let y = 0; y < g.size; y += 1) {
    for (let x = 0; x < g.size; x += 1) {
      if (!g.isFunction[y]![x] && maskApplies(mask, x, y)) g.modules[y]![x] = !g.modules[y]![x];
    }
  }
}

/** The ISO/IEC 18004 §7.8.3 penalty of a finished symbol (lower is better) — the four rules N1–N4. */
export function qrPenalty(dark: readonly (readonly boolean[])[]): number {
  const size = dark.length;
  const at = (x: number, y: number, byRow: boolean): boolean => (byRow ? dark[y]![x]! : dark[x]![y]!);
  let result = 0;
  for (const byRow of [true, false]) {
    for (let a = 0; a < size; a += 1) {
      // N1: five or more of a colour in a line — 3 + (run − 5).
      let run = 1;
      for (let b = 1; b < size; b += 1) {
        if (at(b, a, byRow) === at(b - 1, a, byRow)) {
          run += 1;
          if (run === 5) result += 3;
          else if (run > 5) result += 1;
        } else run = 1;
      }
      // N3: the finder-like 1:1:3:1:1 pattern with four light modules on either side — 40 each.
      for (let b = 0; b + 6 < size; b += 1) {
        const core = at(b, a, byRow) && !at(b + 1, a, byRow) && at(b + 2, a, byRow) && at(b + 3, a, byRow) && at(b + 4, a, byRow) && !at(b + 5, a, byRow) && at(b + 6, a, byRow);
        if (!core) continue;
        // Outside the symbol is the light quiet zone, so a pattern at the edge counts too.
        const lightBefore = [1, 2, 3, 4].every((k) => b - k < 0 || !at(b - k, a, byRow));
        const lightAfter = [7, 8, 9, 10].every((k) => b + k >= size || !at(b + k, a, byRow));
        if (lightBefore) result += 40;
        if (lightAfter) result += 40;
      }
    }
  }
  // N2: each 2×2 block of one colour — 3.
  for (let y = 0; y + 1 < size; y += 1) {
    for (let x = 0; x + 1 < size; x += 1) {
      const c = dark[y]![x]!;
      if (c === dark[y]![x + 1] && c === dark[y + 1]![x] && c === dark[y + 1]![x + 1]) result += 3;
    }
  }
  // N4: the dark share away from 50%, 10 for each whole 5% step.
  let darkCount = 0;
  for (const row of dark) for (const m of row) if (m) darkCount += 1;
  const total = size * size;
  result += Math.floor(Math.abs(darkCount * 20 - total * 10) / total) * 10;
  return result;
}

/**
 * Encode `text` (UTF-8 bytes) as a QR symbol: the smallest version that holds it at `ecl`, and — unless `mask` is given —
 * the mask with the lowest penalty. Throws `QrTooLongError` when it cannot fit at all.
 */
export function encodeQr(text: string, options: { readonly ecl?: QrErrorCorrection; readonly mask?: number; readonly minVersion?: number } = {}): QrSymbol {
  const ecl = options.ecl ?? 'M';
  const bytes = new TextEncoder().encode(text);
  let ver = Math.max(1, options.minVersion ?? 1);
  for (; ; ver += 1) {
    if (ver > 40) throw new QrTooLongError(bytes.length, ecl);
    const used = 4 + (ver <= 9 ? 8 : 16) + bytes.length * 8;
    if (used <= dataCodewords(ver, ecl) * 8) break;
  }
  const codewords = withEccInterleaved(dataCodewordsFor(bytes, ver, ecl), ver, ecl);
  const size = ver * 4 + 17;
  const build = (mask: number): Grid => {
    const g = new Grid(size);
    drawFunctionPatterns(g, ver, ecl);
    drawCodewords(g, codewords);
    applyMask(g, mask);
    drawFormatBits(g, ecl, mask);
    return g;
  };
  let mask = options.mask;
  if (mask === undefined) {
    let best = Number.POSITIVE_INFINITY;
    for (let m = 0; m < 8; m += 1) {
      const p = qrPenalty(build(m).modules);
      if (p < best) { best = p; mask = m; }
    }
  }
  if (mask === undefined || !Number.isInteger(mask) || mask < 0 || mask > 7) throw new RangeError('A QR mask is 0 to 7.');
  const g = build(mask);
  return { version: ver, errorCorrection: ecl, mask, size, dark: g.modules };
}

/**
 * The symbol as an SVG (one path, crisp at any print size), with the four-module quiet zone the standard requires. Black
 * on white whatever the screen theme — a scanner reads paper.
 */
export function qrSvg(symbol: QrSymbol, options: { readonly moduleSize?: number; readonly title?: string } = {}): string {
  const quiet = 4;
  const m = options.moduleSize ?? 4;
  const side = (symbol.size + quiet * 2) * m;
  let d = '';
  symbol.dark.forEach((row, y) => row.forEach((on, x) => { if (on) d += `M${(x + quiet) * m} ${(y + quiet) * m}h${m}v${m}h-${m}z`; }));
  const title = options.title === undefined ? '' : `<title>${options.title.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!)}</title>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" width="${side}" height="${side}" shape-rendering="crispEdges" role="img">${title}<rect width="${side}" height="${side}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
