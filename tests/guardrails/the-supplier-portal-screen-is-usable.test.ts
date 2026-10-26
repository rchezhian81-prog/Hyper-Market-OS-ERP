import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  SUPPLIER_PORTAL_COPY, COPY_KEYS, createSupplierPortalSession, readDeliveryUpdate, readTopUpProposal,
  type SupplierPortalData, type SupplierVmiFeed,
} from '../../apps/supplier-app/src/supplier-portal-session';
import { bilingualGaps } from '../../packages/ui/src/index';

// The supplier portal (M24-FR-01 · API-03 · §35 · P-03 · P-04) is the one PUBLIC-ish surface a party outside the
// business uses, and it is READ-ONLY: a supplier reads its OWN submissions and statement and changes nothing —
// with ONE exception the owner decided in writing (OB-362, 24–25 Oct 2026): the "Delivery update" form, for the
// supplier's own open orders only, which sends the existing `delivery_status` submission — and ONE more (OB-389, 26 Oct
// 2026): the vendor-managed-inventory "Top-up proposal" form, for the supplier's own VMI items only, which sends a
// replenishment proposal that waits for a buyer. The guardrail allows exactly those two writes, from the bundle, and
// nothing else.
// These are static checks on the shipped view + shell — that it reads from the tested session (never
// re-deciding), issues NO write verb, shows every state as a word+icon (never colour alone), and is offered in
// both languages. They cannot prove the screen is good — a real supplier does that — only that the deliberate
// decisions are still there.

const RAW = readFileSync('apps/supplier-app/web/app.js', 'utf8');
const VIEW = RAW.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'); // comments discuss on purpose
const HTML = readFileSync('apps/supplier-app/web/index.html', 'utf8');
const ENTRY_RAW = readFileSync('apps/supplier-app/src/browser-entry.ts', 'utf8');
const ENTRY = ENTRY_RAW.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');

const withAwaiting: SupplierPortalData = {
  submissions: [{ submissionId: 'sub-1', kind: 'invoice', requiresReview: true, receivedAt: '2026-09-21T09:00:00Z' }],
  statement: { partnerId: 'p-1', accessible: true, openingMinor: 0, invoicedMinor: 500000, debitedMinor: 0, creditedMinor: 0, paidMinor: 200000, closingMinor: 300000, disputedMinor: 0, reconciles: true, detail: '300000 outstanding' },
  asAt: '2026-09-22T10:00:00Z',
};
const session = (data: SupplierPortalData, mayRead = true) =>
  createSupplierPortalSession({ userId: 'u-supplier' }, { portal: () => data, mayRead: () => mayRead });

describe('the supplier portal is offered in both languages', () => {
  it('has no gap in either language across the whole vocabulary', () => {
    const gaps = bilingualGaps(SUPPLIER_PORTAL_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });

  it('tripwire — the detector fires on a key genuinely absent', () => {
    const holey = { en: { ...SUPPLIER_PORTAL_COPY.en }, ta: { ...SUPPLIER_PORTAL_COPY.ta, title: '' } };
    expect(bilingualGaps(holey, COPY_KEYS).ta).toContain('title');
  });
});

describe('every state reads as a state, never colour alone', () => {
  it('an awaiting submission carries a tone AND a non-blank icon AND a non-blank word', () => {
    const s = session(withAwaiting).view('en').awaiting[0]!;
    expect(s.status.tone).toBe('degraded');           // waiting on the buyer, never a false "accepted"
    expect(s.status.needsAttention).toBe(true);
    expect(s.status.label.length).toBeGreaterThan(0);
    expect(s.status.icon.trim().length).toBeGreaterThan(0);
  });

  it('a non-supplier login gets a not-permitted state and nothing else', () => {
    const view = session(withAwaiting, false).view('en');
    expect(view.awaiting).toEqual([]);
    expect(view.processed).toEqual([]);
    expect(view.statement).toBeNull();
    expect(view.screenState.tone).toBe('error');
  });
});

describe('the view renders from the tested session and re-decides nothing', () => {
  it('reads window.supplierPortalSession and calls session.view()', () => {
    expect(VIEW).toMatch(/window\.supplierPortalSession/);
    expect(VIEW).toMatch(/session\.view\(/);
  });

  it('the view itself issues NO write verb — the two writes (OB-362, OB-389) go through the bundle', () => {
    const writes = VIEW.match(/method:\s*'(POST|PUT|PATCH|DELETE)'/g) ?? [];
    expect(writes).toEqual([]);
    expect(VIEW).toMatch(/supplierPortal\.sendDeliveryUpdate|api\.sendDeliveryUpdate/);
    expect(VIEW).toMatch(/api\.sendTopUpProposal/);
    expect(VIEW).not.toMatch(/\bfetch\s*\(/);
  });

  it('OB-362 + OB-389: the bundle makes exactly TWO writes — the delivery_status submission and the VMI top-up proposal, each to the supplier\'s own route', () => {
    const writes = ENTRY.match(/method:\s*'(POST|PUT|PATCH|DELETE)'/g) ?? [];
    expect(writes).toEqual(["method: 'POST'", "method: 'POST'"]);
    const posts: string[] = [];
    for (let at = ENTRY.indexOf("method: 'POST'"); at >= 0; at = ENTRY.indexOf("method: 'POST'", at + 1)) posts.push(ENTRY.slice(Math.max(0, at - 1500), at + 600));
    // OB-362: to the supplier's OWN submissions route (no partner id in it), with the kind fixed, after the tested check.
    const delivery = posts.find((p) => p.includes("'/v1/supplier-portal/me/submissions'"));
    expect(delivery, 'the delivery update write').toBeDefined();
    expect(delivery).toContain("kind: 'delivery_status'");
    expect(delivery).toMatch(/readDeliveryUpdate\(input, feed\)/);
    // OB-389: to the supplier's OWN VMI proposal route (no partner id), after the tested check against the room.
    const topUp = posts.find((p) => p.includes('/v1/supplier-portal/me/vmi/proposals/'));
    expect(topUp, 'the VMI top-up proposal write').toBeDefined();
    expect(topUp).toMatch(/readTopUpProposal\(input, feed\)/);
    expect(topUp).not.toMatch(/supplierId|partnerId/);
    expect(ENTRY).not.toMatch(/partners\/:?\w*\/submissions|\/partners\//);
    // No other write route is named anywhere in the bundle.
    const routes = [...ENTRY.matchAll(/['`](\/v1\/[^'`$]+)/g)].map((m) => m[1]);
    expect(routes.filter((r) => !/^\/v1\/supplier-portal\/me\/(submissions|statement|orders|vmi(\/proposals\/)?)$/.test(r ?? ''))).toEqual([]);
  });

  it('OB-389: the top-up form proposes only the supplier\'s own items at one store, within the room, and refuses before sending', () => {
    const feed: SupplierVmiFeed = {
      mayPropose: true, notSet: null, proposals: [],
      items: [
        { storeId: 'br-1', productId: 'DAL', minQty: 10, maxQty: 50, uom: 'ea', onHand: 5, onOrder: 5, room: 40, belowMinimum: false },
        { storeId: 'br-1', productId: 'OIL', minQty: 4, maxQty: 12, uom: 'ea', onHand: 2, onOrder: 0, room: 10, belowMinimum: true },
        { storeId: 'br-2', productId: 'DAL', minQty: 1, maxQty: 5, uom: 'ea', onHand: 5, onOrder: 0, room: 0, belowMinimum: false },
      ],
    };
    expect(readTopUpProposal({ storeId: 'br-1', quantities: { DAL: ' 40 ', OIL: '' }, note: ' by Friday ' }, feed))
      .toEqual({ ok: true, document: { storeId: 'br-1', lines: [{ productId: 'DAL', quantity: 40 }], note: 'by Friday' } });
    expect(readTopUpProposal({ storeId: 'br-1', quantities: { DAL: '41' }, note: '' }, feed)).toEqual({ ok: false, why: 'aboveRoom', productId: 'DAL' });
    expect(readTopUpProposal({ storeId: 'br-2', quantities: { DAL: '1' }, note: '' }, feed)).toEqual({ ok: false, why: 'aboveRoom', productId: 'DAL' });
    expect(readTopUpProposal({ storeId: 'br-1', quantities: { RICE: '3' }, note: '' }, feed)).toEqual({ ok: false, why: 'notYourItem', productId: 'RICE' });
    expect(readTopUpProposal({ storeId: 'br-1', quantities: { DAL: '2.5' }, note: '' }, feed)).toEqual({ ok: false, why: 'badQuantity', productId: 'DAL' });
    expect(readTopUpProposal({ storeId: 'br-1', quantities: { DAL: '0' }, note: '' }, feed)).toEqual({ ok: false, why: 'badQuantity', productId: 'DAL' });
    expect(readTopUpProposal({ storeId: 'br-1', quantities: { DAL: '' }, note: '' }, feed)).toEqual({ ok: false, why: 'needQuantity' });
    expect(readTopUpProposal({ storeId: '', quantities: { DAL: '1' }, note: '' }, feed)).toEqual({ ok: false, why: 'needStore' });
    expect(readTopUpProposal({ storeId: 'br-9', quantities: { DAL: '1' }, note: '' }, feed)).toEqual({ ok: false, why: 'notYourStore' });
    expect(readTopUpProposal({ storeId: 'br-1', quantities: { DAL: '1' }, note: 'x'.repeat(301) }, feed)).toEqual({ ok: false, why: 'noteTooLong' });
    expect(readTopUpProposal({ storeId: 'br-1', quantities: { DAL: '1' }, note: '' }, { ...feed, mayPropose: false })).toEqual({ ok: false, why: 'cannotPropose' });
    expect(readTopUpProposal({ storeId: 'br-1', quantities: { DAL: '1' }, note: '' }, null)).toEqual({ ok: false, why: 'cannotPropose' });
  });

  it('OB-389: the shell carries the top-up form, with a label for its fields and an icon beside the button\'s word', () => {
    for (const id of ['vmi-store', 'vmi-note']) expect(HTML, id).toMatch(new RegExp(`<label for="${id}">`));
    expect(HTML).toMatch(/id="vmi-send"[^>]*>\s*<span id="vmi-send-text">/);
    expect(VIEW).toMatch(/icon\('package'\)/);
    // Each quantity box sits inside its own label.
    expect(VIEW).toMatch(/label\.append\(lw, input\)/);
  });

  it('OB-362: the form names only the supplier\'s own open orders, and refuses before sending', () => {
    const feed = { ordersKnown: true, mayUpdate: true, orders: [{ poId: 'PO-1', number: 'PO-000001', issuedAt: '2026-10-20T09:00:00Z', deliverToLocationId: 'br-1' }] };
    expect(readDeliveryUpdate({ poId: 'PO-1', status: 'in_transit', expectedOn: '2026-10-27', note: ' lorry left at 6 ' }, feed))
      .toEqual({ ok: true, document: { poId: 'PO-1', status: 'in_transit', expectedOn: '2026-10-27', note: 'lorry left at 6' } });
    expect(readDeliveryUpdate({ poId: 'PO-OTHER', status: 'in_transit', expectedOn: '2026-10-27', note: '' }, feed)).toEqual({ ok: false, why: 'notYourOrder' });
    expect(readDeliveryUpdate({ poId: '', status: 'in_transit', expectedOn: '2026-10-27', note: '' }, feed)).toEqual({ ok: false, why: 'needOrder' });
    expect(readDeliveryUpdate({ poId: 'PO-1', status: 'delivered', expectedOn: '2026-10-27', note: '' }, feed)).toEqual({ ok: false, why: 'needStatus' });
    expect(readDeliveryUpdate({ poId: 'PO-1', status: 'delayed', expectedOn: '27/10', note: '' }, feed)).toEqual({ ok: false, why: 'needDate' });
    expect(readDeliveryUpdate({ poId: 'PO-1', status: 'delayed', expectedOn: '2026-10-27', note: 'x'.repeat(301) }, feed)).toEqual({ ok: false, why: 'noteTooLong' });
    expect(readDeliveryUpdate({ poId: 'PO-1', status: 'delayed', expectedOn: '2026-10-27', note: '' }, { ...feed, mayUpdate: false })).toEqual({ ok: false, why: 'cannotUpdate' });
    expect(readDeliveryUpdate({ poId: 'PO-1', status: 'delayed', expectedOn: '2026-10-27', note: '' }, null)).toEqual({ ok: false, why: 'cannotUpdate' });
  });

  it('OB-362: the shell carries the one form, with a label for every field and an icon beside the button\'s word', () => {
    for (const id of ['du-order', 'du-status', 'du-expected', 'du-note']) expect(HTML, id).toMatch(new RegExp(`<label for="${id}">`));
    expect(HTML).toMatch(/id="du-send"[^>]*>\s*<span id="du-send-text">/);
    expect(VIEW).toMatch(/icon\('truck'\)/);
    expect((HTML.match(/<form\b/g) ?? []).length).toBe(0); // no <form> element posts anything by itself
  });

  it('never asks its questions with a browser dialog', () => {
    expect(/\b(alert|confirm|prompt)\s*\(/.test(VIEW)).toBe(false);
  });

  it('labels each status for a screen reader and hides the decorative icon', () => {
    expect(VIEW).toMatch(/setAttribute\('aria-label'/);
    expect(VIEW).toMatch(/icon\.setAttribute\('aria-hidden', 'true'\)/);
  });
});

describe('the shell is wired to the bundle and the injected login, and is accessible', () => {
  it('loads the app bundle and carries the login-data marker', () => {
    expect(HTML).toMatch(/supplier-app\.bundle\.js/);
    expect(HTML).toContain('<!--SCREEN-DATA-->');
  });

  it('labels the language toggle and the submission lists, and offers a skip link', () => {
    expect(HTML).toMatch(/id="lang"[^>]*aria-label=/);
    expect(HTML).toMatch(/id="awaiting"[^>]*aria-label=/);
    expect(HTML).toMatch(/id="processed"[^>]*aria-label=/);
    expect(HTML).toMatch(/class="skip"/);
  });
});
