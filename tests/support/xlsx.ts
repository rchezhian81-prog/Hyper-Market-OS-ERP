import { deflateRawSync } from 'node:zlib';

// ── a tiny .xlsx writer (the export's shape: shop name, address, then the header row) ──────────────────────────────
/** A minimal .xlsx (one sheet, inline strings) — the shape the old ERP's reports have — for tests with made-up data. */
export function xlsx(rows: readonly (readonly string[])[]): Buffer {
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const col = (i: number): string => String.fromCharCode(65 + i);
  const sheet = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${
    rows.map((r, ri) => `<row r="${ri + 1}">${r.map((c, ci) => (/^-?\d+(\.\d+)?$/.test(c) && !/^0\d/.test(c)
      ? `<c r="${col(ci)}${ri + 1}"><v>${c}</v></c>` : `<c r="${col(ci)}${ri + 1}" t="inlineStr"><is><t>${esc(c)}</t></is></c>`)).join('')}</row>`).join('')
  }</sheetData></worksheet>`;
  const parts: [string, Buffer][] = [['[Content_Types].xml', Buffer.from('<Types/>')], ['xl/worksheets/sheet1.xml', Buffer.from(sheet)]];
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0;
  for (const [name, data] of parts) {
    const z = deflateRawSync(data); const n = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(z.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(z.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, z); centrals.push(ch, n); offset += 30 + n.length + z.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(parts.length, 8); end.writeUInt16LE(parts.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
