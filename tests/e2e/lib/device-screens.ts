// UI-2 (1 Nov 2026): the till, the handhelds and the kiosks, opened in real Chromium the way the store computer serves them —
// the shell's own files, the screen's data injected where the box puts it (`<!--SCREEN-DATA-->`), and for the till a
// stand-in store computer on its loopback socket. One place, so the redesign's browser test and its screenshots open
// exactly the same screens. Synthetic data only; nothing here reaches a real box or head office.

import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import type { BrowserContext } from 'playwright-core';

export interface Served { readonly base: string; readonly stop: () => Promise<void> }

/** Serve `apps/<app>/web` with `globals` injected as `window.<name> = …` where the box puts its screen data. */
export async function serveShell(app: string, globals: Record<string, unknown>): Promise<Served> {
  const dir = join('apps', app, 'web');
  const server: Server = createServer((req, res) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      const file = path === '/' || path === '/index.html' ? 'index.html' : path.replace(/^\//, '');
      if (file === 'favicon.ico') { res.writeHead(204); res.end(); return; }
      try {
        let text = (await readFile(join(dir, file))).toString('utf8');
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.webmanifest') ? 'application/manifest+json' : 'application/octet-stream';
        if (file.endsWith('.html')) {
          const tags = Object.entries(globals).map(([name, value]) => `<script>window.${name} = ${JSON.stringify(value).replace(/</g, '\\u003c')};</script>`).join('');
          text = text.replace('<!--SCREEN-DATA-->', tags);
        }
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
        res.end(text);
      } catch {
        res.writeHead(404); res.end('not found');
      }
    })();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve({ base: `http://127.0.0.1:${port}`, stop: () => new Promise((done) => { server.close(() => { done(); }); server.closeAllConnections(); }) });
    });
  });
}

/**
 * The till's store computer on its loopback socket (127.0.0.1:8090), inside this browser only: head office out of reach
 * and two sales waiting, nobody held, a float out. `gone` refuses every call (the box is down).
 */
export async function tillStoreComputer(context: BrowserContext, gone = false): Promise<void> {
  const at = new Date(Date.now() - 60_000).toISOString();
  await context.route('http://127.0.0.1:8090/**', async (route) => {
    if (gone) { await route.abort('connectionrefused'); return; }
    const path = new URL(route.request().url()).pathname;
    const body = path === '/lane/sync-status' ? { cloud: 'offline', unsent: 2, deadLettered: 0, lastSentAt: at, lastContactAt: at, now: new Date().toISOString(), staffMessage: '' }
      : path === '/lane/operator' ? { signInBy: 'pin' }
        : path === '/lane/held-bills' ? { held: [] }
          : path === '/lane/till-cash' ? { shiftOpen: true }
            : {};
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  });
}

/** A small signed-list stand-in for the till and the price kiosk: three products with barcodes, one weighed. */
export function tillCatalogue(builtAt = new Date().toISOString()): Record<string, unknown> {
  return {
    tenantId: 't-sre', version: 7, builtAt,
    products: [
      { productId: 'P-RICE', sku: 'RICE-1', name: 'Ponni rice 1kg', baseUom: 'ea', unitPriceMinor: 70_00, taxBps: 0, status: 'active' },
      { productId: 'P-DAL', sku: 'DAL-1', name: 'Toor dal 1kg', baseUom: 'ea', unitPriceMinor: 145_00, taxBps: 500, status: 'active' },
      { productId: 'P-BAN', sku: '000123', name: 'Banana (loose)', baseUom: 'kg', unitPriceMinor: 60_00, taxBps: 0, status: 'active' },
    ],
    barcodes: [
      { code: '8900000000707', productId: 'P-RICE', kind: 'standard' },
      { code: '8901234567890', productId: 'P-DAL', kind: 'standard' },
      { code: '8900000000999', productId: 'P-BAN', kind: 'standard' },
    ],
  };
}

const RECEIVING = {
  checks: [{ checkId: 'dock-receiving', branchId: 'store-1', title: 'Chilled and frozen delivery', kind: 'receiving', graceMinutes: 0, active: true,
    assignedRole: 'store_manager', escalatesTo: 'u-owner', items: [{ itemId: 'temp', label: 'Temperature taken' }, { itemId: 'pack', label: 'Packaging intact' }, { itemId: 'seal', label: 'Seal unbroken' }] }],
  coldChainProductIds: ['p-icecream'],
};

export interface Handheld { readonly app: string; readonly global: string; readonly ready: string; readonly data: () => Record<string, unknown> }

/** The handhelds' work, as the OB-205 polish test serves it (the same synthetic shift). */
export const WAREHOUSE: Handheld = {
  app: 'warehouse-app', global: 'warehouseData', ready: 'warehouseSession',
  data: () => ({
    assignmentId: 'A-1', workerId: 'u-worker', storeId: 'store-1', poId: 'po-1', grnId: 'grn-1',
    bins: [{ binId: 'BIN-A', storeId: 'store-1', capacityMinor: 1000, pickable: true, zone: 'ambient' }],
    ordered: [{ productId: 'p-rice', quantityMinor: 100, unitCost: { minor: 4000, currency: 'INR' } }, { productId: 'p-icecream', quantityMinor: 20, unitCost: { minor: 9000, currency: 'INR' } }],
    barcodes: [{ barcode: '890RICE', productId: 'p-rice', level: 'unit' }, { barcode: '890ICE', productId: 'p-icecream', level: 'unit' }],
    packs: [{ productId: 'p-rice', baseUom: 'ea', levels: [{ level: 'unit', containsMinor: 1, barcode: '890RICE' }] }, { productId: 'p-icecream', baseUom: 'ea', levels: [{ level: 'unit', containsMinor: 1, barcode: '890ICE' }] }],
    productNames: { 'p-rice': 'Ponni rice 25kg sack', 'p-icecream': 'Vanilla ice cream 1L' },
    goodsIn: [
      { productId: 'p-good', batchId: null, quantityMinor: 6, uom: 'EA', state: 'good', expiry: null, recalled: false },
      { productId: 'p-recalled', batchId: 'b-9', quantityMinor: 3, uom: 'EA', state: 'good', expiry: null, recalled: true },
    ],
    recalledProductIds: ['p-recalled'],
    contents: { 'BIN-A|p-rice|': 40 },
    pickLines: [{ lineId: 'pl-1', orderRef: 'ORD-77', productId: 'p-rice', batchId: null, binId: 'BIN-A', quantityMinor: 12, uom: 'EA' }],
    indentLines: [{ indentId: 'ind-1', productId: 'p-rice', uom: 'EA', outstandingMinor: 6, requestedBy: 'u-floor', toLocationId: 'store-1' }],
    openDeliveries: [{ poId: 'po-1', number: 'PO-0042', supplierId: 'sup-aavin', ordered: [{ productId: 'p-rice', quantityMinor: 100, unitCost: { minor: 4000 } }, { productId: 'p-icecream', quantityMinor: 20, unitCost: { minor: 9000 } }] }],
    receivingChecklist: RECEIVING,
  }),
};
export const PICKER: Handheld = {
  app: 'picker-app', global: 'pickerData', ready: 'pickSession',
  data: () => ({
    waveId: 'W-1', pickerId: 'u-picker', orderedBy: 'shelf order',
    lines: [
      { lineId: 'l1', orderRef: 'ORD-1', productId: 'MILK', description: 'Aavin Milk 1L', bin: 'A-01', requiredQty: 2, uom: 'ea', unitPrice: { minor: 6000, currency: 'INR' } },
      { lineId: 'l2', orderRef: 'ORD-1', productId: 'DAL', description: 'Toor dal 1kg', bin: 'B-04', requiredQty: 1, uom: 'ea', unitPrice: { minor: 16000, currency: 'INR' } },
      { lineId: 'l3', orderRef: 'ORD-2', productId: 'TOMATO', description: 'Tomato', bin: 'C-02', requiredQty: 500, uom: 'kg', unitPrice: { minor: 4000, currency: 'INR' } },
    ],
  }),
};
export const DRIVER: Handheld = {
  app: 'delivery-app', global: 'driverData', ready: 'routeSession',
  data: () => ({
    routeId: 'R-1', driverId: 'u-driver',
    stops: [
      { stopId: 's1', orderRef: 'ORD-1041', area: 'Anna Nagar, 3rd St', codMinor: 250_00 },
      { stopId: 's2', orderRef: 'ORD-1044', area: 'Gandhipuram', codMinor: 0 },
    ],
  }),
};

/**
 * What sticks out at a phone's width: an element past the screen's edge, a box whose words overflow it without a scroll
 * of its own, and the page scrolling sideways (WCAG 1.4.10). Hidden things are not counted.
 */
export const SIDEWAYS = `(() => {
  const vw = document.documentElement.clientWidth;
  const out = [];
  const name = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).join('.') : '');
  for (const el of document.body.querySelectorAll('*')) {
    if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue;
    if (el.closest('[hidden]')) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.position === 'fixed' && el.getBoundingClientRect().width === 0) continue;
    if (el.classList.contains('sr-only')) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.left < -0.5 || r.right > vw + 0.5) out.push(name(el) + ' past the screen edge (' + Math.round(r.left) + '..' + Math.round(r.right) + ' of ' + vw + ')');
  }
  if (document.documentElement.scrollWidth > vw + 0.5) out.push('the page scrolls sideways (' + document.documentElement.scrollWidth + ' > ' + vw + ')');
  return out;
})()`;

/** Every visible, enabled control (button, link, input, select, [role=button]) smaller than `min` px in either direction. */
export function smallTargets(min: number): string {
  return `(() => {
    const out = [];
    for (const el of document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, [role=button]')) {
      if (el.closest('[hidden]') || el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      // a tick box or radio is measured by its wrapping label (WCAG 2.5.8's own rule, as the audit does)
      const box = (el.type === 'checkbox' || el.type === 'radio') && el.closest('label') ? el.closest('label').getBoundingClientRect() : r;
      if (box.height < ${min} - 0.5 || box.width < ${min} - 0.5) out.push((el.id || el.tagName.toLowerCase()) + ' ' + Math.round(box.width) + '×' + Math.round(box.height) + ' "' + (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30) + '"');
    }
    return out;
  })()`;
}
