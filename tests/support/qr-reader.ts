// A small QR Code READER for tests (ISO/IEC 18004), written separately from the encoder in
// packages/receipt/src/qr-code.ts so a test can prove what a symbol actually carries — the way a phone's camera would
// read it — rather than trusting the encoder to have done what it was asked.
//
// It reads a clean, error-free symbol only (a symbol drawn by this product, read off its own SVG): it reads the format
// bits, removes the mask, walks the codewords in the standard zig-zag, de-interleaves the blocks, drops the error
// correction, and decodes BYTE mode. It does not correct errors — a test symbol has none — and refuses anything else.

const ECL_OF_FORMAT: Readonly<Record<number, 'L' | 'M' | 'Q' | 'H'>> = { 1: 'L', 0: 'M', 3: 'Q', 2: 'H' };
const ECL_ROW = { L: 0, M: 1, Q: 2, H: 3 } as const;

// Error-correction codewords per block, and number of blocks, per level (L, M, Q, H) and version (index 1–40).
const ECC_PER_BLOCK: readonly (readonly number[])[] = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const BLOCKS: readonly (readonly number[])[] = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

function alignmentPositions(ver: number): number[] {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const size = ver * 4 + 17;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
  const out = [6];
  for (let pos = size - 7; out.length < n; pos -= step) out.splice(1, 0, pos);
  return out;
}

function rawCodewords(ver: number): number {
  let bits = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const n = Math.floor(ver / 7) + 2;
    bits -= (25 * n - 10) * n - 55;
    if (ver >= 7) bits -= 36;
  }
  return Math.floor(bits / 8);
}

const MASKS: readonly ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
  (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0,
  (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0,
];

/** Read a clean symbol, `dark[y][x]`, to the bytes it carries (byte mode). Throws on anything it cannot read. */
export function readQr(dark: readonly (readonly boolean[])[]): { readonly version: number; readonly ecl: 'L' | 'M' | 'Q' | 'H'; readonly bytes: Buffer } {
  const size = dark.length;
  const ver = (size - 17) / 4;
  if (!Number.isInteger(ver) || ver < 1 || ver > 40 || dark.some((r) => r.length !== size)) throw new Error(`not a QR symbol: ${size} modules a side`);
  const at = (x: number, y: number): boolean => dark[y]![x]!;
  // Format bits, the copy beside the top-left finder.
  let format = 0;
  for (let i = 0; i <= 5; i += 1) if (at(8, i)) format |= 1 << i;
  if (at(8, 7)) format |= 1 << 6;
  if (at(8, 8)) format |= 1 << 7;
  if (at(7, 8)) format |= 1 << 8;
  for (let i = 9; i < 15; i += 1) if (at(14 - i, 8)) format |= 1 << i;
  const data5 = ((format ^ 0x5412) >> 10) & 0x1f;
  const ecl = ECL_OF_FORMAT[data5 >> 3]!;
  const mask = MASKS[data5 & 7]!;

  // Which modules are function patterns (never data).
  const fn = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const mark = (x0: number, y0: number, w: number, h: number): void => {
    for (let y = y0; y < y0 + h; y += 1) for (let x = x0; x < x0 + w; x += 1) if (x >= 0 && y >= 0 && x < size && y < size) fn[y]![x] = true;
  };
  mark(0, 0, 9, 9); mark(size - 8, 0, 8, 9); mark(0, size - 8, 9, 8);
  mark(6, 0, 1, size); mark(0, 6, size, 1);
  const align = alignmentPositions(ver);
  for (let i = 0; i < align.length; i += 1) {
    for (let j = 0; j < align.length; j += 1) {
      if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) continue;
      mark(align[i]! - 2, align[j]! - 2, 5, 5);
    }
  }
  if (ver >= 7) { mark(size - 11, 0, 3, 6); mark(0, size - 11, 6, 3); }

  // Zig-zag, two columns at a time from the right, skipping the vertical timing column.
  const bits: number[] = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fn[y]![x]) bits.push((at(x, y) !== mask(x, y)) ? 1 : 0);
      }
    }
  }
  const raw = rawCodewords(ver);
  const codewords: number[] = [];
  for (let i = 0; i < raw; i += 1) {
    let b = 0;
    for (let k = 0; k < 8; k += 1) b = (b << 1) | (bits[i * 8 + k] ?? 0);
    codewords.push(b);
  }
  // De-interleave: short blocks first, each with one data codeword fewer than the long ones.
  const nBlocks = BLOCKS[ECL_ROW[ecl]]![ver]!;
  const ecc = ECC_PER_BLOCK[ECL_ROW[ecl]]![ver]!;
  const shortLen = Math.floor(raw / nBlocks);
  const nShort = nBlocks - (raw % nBlocks);
  const blocks: number[][] = Array.from({ length: nBlocks }, () => []);
  let k = 0;
  for (let i = 0; i <= shortLen; i += 1) {
    for (let j = 0; j < nBlocks; j += 1) {
      if (i === shortLen - ecc && j < nShort) continue; // the short blocks have no codeword here
      blocks[j]!.push(codewords[k++]!);
    }
  }
  const data = blocks.flatMap((b, j) => b.slice(0, (j < nShort ? shortLen : shortLen + 1) - ecc));
  // Byte mode only: 0100, a count, the bytes.
  const dataBits = data.flatMap((b) => Array.from({ length: 8 }, (_, i) => (b >> (7 - i)) & 1));
  let p = 0;
  const take = (n: number): number => { let v = 0; for (let i = 0; i < n; i += 1) v = (v << 1) | dataBits[p++]!; return v; };
  const mode = take(4);
  if (mode !== 0b0100) throw new Error(`not byte mode (mode ${mode.toString(2)})`);
  const count = take(ver <= 9 ? 8 : 16);
  const out = Buffer.alloc(count);
  for (let i = 0; i < count; i += 1) out[i] = take(8);
  return { version: ver, ecl, bytes: out };
}

/** The module grid back out of an SVG drawn by `qrSvg` (one path of unit squares, a four-module quiet zone). */
export function matrixFromQrSvg(svg: string): boolean[][] {
  const side = Number(/viewBox="0 0 (\d+) \d+"/.exec(svg)?.[1]);
  const d = /<path d="([^"]*)"/.exec(svg)?.[1] ?? '';
  const squares = [...d.matchAll(/M(\d+) (\d+)h(\d+)v\d+h-\d+z/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]), m: Number(m[3]) }));
  const m = squares[0]?.m;
  if (m === undefined || !Number.isFinite(side)) throw new Error('not a QR SVG drawn by qrSvg');
  const size = side / m - 8;
  const grid = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  for (const s of squares) grid[s.y / m - 4]![s.x / m - 4] = true;
  return grid;
}
