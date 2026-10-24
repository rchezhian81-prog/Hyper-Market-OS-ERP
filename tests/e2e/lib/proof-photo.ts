// OB-294 · M19-FR-03 e2e support: a real picture for the driver phone's camera input — a small, valid PNG made here (no
// file on disk, nothing real in it), handed to `<input type="file" capture>` exactly as the camera would hand it over.

import { deflateSync } from 'node:zlib';
import type { Page } from 'playwright-core';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (b: Buffer): number => { let c = 0xffffffff; for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type: string, data: Buffer): Buffer => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

/** A `size`×`size` PNG of a parcel-brown square on white — a synthetic "doorstep photo". */
export function syntheticPhoto(size = 96): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const rows: Buffer[] = [];
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x += 1) {
      const inBox = x > size / 4 && x < (3 * size) / 4 && y > size / 3 && y < (5 * size) / 6;
      row[1 + x * 3] = inBox ? 150 : 250; row[2 + x * 3] = inBox ? 100 : 250; row[3 + x * 3] = inBox ? 50 : 250;
    }
    rows.push(row);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

/** On the photo panel: the camera hands over the picture (its own "use this photo?" already answered) and the panel closes. */
export async function takeThePhoto(page: Page): Promise<void> {
  await page.waitForSelector('#photo:not([hidden])');
  await page.setInputFiles('#photo-input', { name: 'door.png', mimeType: 'image/png', buffer: syntheticPhoto() });
  await page.waitForSelector('#photo', { state: 'hidden', timeout: 10_000 });
}
