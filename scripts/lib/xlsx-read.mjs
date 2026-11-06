// Read the first sheet of an Excel .xlsx file (an Office Open XML zip) into rows of text — no library, no network.
//
// Why here: the old ERP's reports reach the store PC as Excel files (6 Nov 2026), and the converter must read them on
// that PC with nothing installed. An .xlsx is a zip of XML parts; this reads the zip's central directory, inflates the
// two parts it needs (the shared strings and the first worksheet) with Node's own zlib, and returns each row as
// header → cell text. A file that is not an .xlsx (an old binary .xls, an HTML page renamed .xls) is refused by name.

import { inflateRawSync } from 'node:zlib';

const decodeXml = (s) => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (m, e) => (
  e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'amp' ? '&' : e === 'quot' ? '"' : e === 'apos' ? "'"
    : e[1] === 'x' ? String.fromCodePoint(parseInt(e.slice(2), 16)) : String.fromCodePoint(Number(e.slice(1)))));

/** The zip's entries: name → its bytes (stored or deflated). */
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i -= 1) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('this is not an .xlsx file (no zip directory) — in Excel, "Save As" → "Excel Workbook (*.xlsx)" and try again');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('the .xlsx file is damaged (zip directory)');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28); const extraLen = buf.readUInt16LE(p + 30); const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    entries.set(name, { method, size, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return (name) => {
    const e = entries.get(name);
    if (e === undefined) return undefined;
    const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
    const data = buf.subarray(start, start + e.size);
    if (e.method === 0) return data.toString('utf8');
    if (e.method === 8) return inflateRawSync(data).toString('utf8');
    throw new Error(`the .xlsx file uses a compression this reader does not know (${e.method})`);
  };
}

const colIndex = (ref) => { let n = 0; for (const c of /^[A-Z]+/.exec(ref)[0]) n = n * 26 + (c.charCodeAt(0) - 64); return n - 1; };
const textOf = (xml) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1])).join('');

/** Every row of the first sheet, as arrays of cell text (blank cells are ''). */
export function readXlsxGrid(buf) {
  const part = unzip(buf);
  const shared = [];
  const ss = part('xl/sharedStrings.xml');
  if (ss !== undefined) for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(textOf(m[1]));
  const sheet = part('xl/worksheets/sheet1.xml');
  if (sheet === undefined) throw new Error('the .xlsx file has no first worksheet');
  const rows = [];
  for (const rm of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1]; const body = cm[2] ?? '';
      const ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1];
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let value = '';
      if (type === 's' && v !== undefined) value = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') value = textOf(body);
      else if (v !== undefined) value = decodeXml(v);
      const at = ref === undefined ? row.length : colIndex(ref);
      while (row.length < at) row.push('');
      row[at] = value;
    }
    rows.push(row);
  }
  return rows;
}

/**
 * The rows under the header row, as header → text. The old ERP's reports open with the shop's name and address, so the
 * header is the first row that holds `mustHave` (e.g. "Item Id"); a sheet without one is refused by name.
 */
export function readXlsxTable(buf, mustHave) {
  const grid = readXlsxGrid(buf);
  const at = grid.findIndex((r) => r.some((c) => c.trim().toLowerCase() === mustHave.toLowerCase()));
  if (at < 0) throw new Error(`no header row with "${mustHave}" in the first sheet — is this the right report?`);
  const head = grid[at].map((h) => h.trim());
  return grid.slice(at + 1)
    .filter((r) => r.some((c) => c.trim() !== ''))
    .map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()]).filter(([h]) => h !== '')));
}
