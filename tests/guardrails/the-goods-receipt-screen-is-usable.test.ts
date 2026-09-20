import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  GOODS_RECEIPT_COPY, COPY_KEYS, createGoodsReceiptSession,
  type GoodsReceiptData,
} from '../../apps/web-erp/src/goods-receipt-session';
import { bilingualGaps } from '../../packages/ui/src/index';

// The goods-receipt review screen (M07-FR-02/03 · API-04 · P-03 · P-08) is READ-ONLY: it shows what came in the
// back door and changes nothing (receiving is captured on the handheld). These are static checks on the shipped
// view + shell — that it reads from the tested session (never re-deciding), issues NO write verb, shows every
// delivery as a word+icon (never colour alone), and is offered in both languages. They cannot prove the screen is
// good — a manager with a real shop does that — only that the decisions made deliberately are still there.

const RAW = readFileSync('apps/web-erp/web/goods-receipt.js', 'utf8');
const VIEW = RAW.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'); // comments discuss on purpose
const HTML = readFileSync('apps/web-erp/web/goods-receipt.html', 'utf8');

const needsApproval: GoodsReceiptData = {
  receipts: [{
    grnId: 'g1', number: 'GRN-1', poId: 'po-1', warehouseId: 'W1', receivedBy: 'u-recv',
    receivedAt: '2026-09-20T08:00:00.000Z', requiresApproval: true, discrepancyValueMinor: 50_00, currency: 'INR',
    sellableMinor: 90_00, quarantinedMinor: 10_00, rejectedMinor: 0,
    discrepancies: [{ kind: 'excess', productId: 'p1', quantityMinor: 10_00, valueMinor: 50_00, currency: 'INR', requiresApproval: true, detail: 'more than ordered' }],
  }],
};
const session = (data: GoodsReceiptData, mayRead = true) =>
  createGoodsReceiptSession({ userId: 'u-mgr' }, { snapshot: () => data, mayRead: () => mayRead });

describe('the goods-receipt screen is offered in both languages', () => {
  it('has no gap in either language across the whole vocabulary', () => {
    const gaps = bilingualGaps(GOODS_RECEIPT_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });

  it('tripwire — the detector fires on a key genuinely absent', () => {
    const holey = { en: { ...GOODS_RECEIPT_COPY.en }, ta: { ...GOODS_RECEIPT_COPY.ta, title: '' } };
    expect(bilingualGaps(holey, COPY_KEYS).ta).toContain('title');
  });
});

describe('every delivery reads as a state, never colour alone', () => {
  it('a delivery needing a second person carries a tone AND a non-blank icon AND a non-blank word', () => {
    const r = session(needsApproval).view('en').receipts[0]!;
    expect(r.status.tone).toBe('error');
    expect(r.status.needsAttention).toBe(true);
    expect(r.status.label.length).toBeGreaterThan(0);
    expect(r.status.icon.trim().length).toBeGreaterThan(0);
    expect((r.status.announcement ?? '').length).toBeGreaterThan(0);
  });
});

describe('the view renders from the tested session and re-decides nothing', () => {
  it('reads window.goodsReceiptSession and calls session.view()', () => {
    expect(VIEW).toMatch(/window\.goodsReceiptSession/);
    expect(VIEW).toMatch(/session\.view\(/);
  });

  it('issues NO write verb — this screen is read-only (it receives nothing; the handheld does)', () => {
    const writes = VIEW.match(/method:\s*'(POST|PUT|PATCH|DELETE)'/g) ?? [];
    expect(writes).toEqual([]);
  });

  it('never asks its questions with a browser dialog', () => {
    expect(/\b(alert|confirm|prompt)\s*\(/.test(VIEW)).toBe(false);
  });

  it('labels each status for a screen reader and hides the decorative icon', () => {
    expect(VIEW).toMatch(/status\.setAttribute\('aria-label'/);
    expect(VIEW).toMatch(/icon\.setAttribute\('aria-hidden', 'true'\)/);
  });
});

describe('the shell is wired to the bundle and the injected data, and is accessible', () => {
  it('loads the shared bundle and carries the data marker', () => {
    expect(HTML).toMatch(/web-erp\.bundle\.js/);
    expect(HTML).toContain('<!--SCREEN-DATA-->');
  });

  it('labels the language toggle and the deliveries list', () => {
    expect(HTML).toMatch(/id="lang"[^>]*aria-label=/);
    expect(HTML).toMatch(/id="rows"[^>]*aria-label=/);
  });
});
