import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  SUPPLIERS_COPY, COPY_KEYS, createSuppliersSession,
  type SuppliersData, type SuppliersPorts,
} from '../../apps/web-erp/src/suppliers-session';
import { bilingualGaps } from '../../packages/ui/src/index';

// The Suppliers screen (M06-FR-01 · M23-FR-01 · §28 · P-02 · P-03 · P-08) shows every supplier with ONE balance and
// lets a purchase user PROPOSE and a different person APPROVE. These are static checks on the shipped view + shell —
// that it reads from the tested session (never re-deciding), that its only writes are the two governed acts on an
// explicit click, that every row is a word+icon (never colour alone), and that it is offered in both languages. They
// cannot prove the screen is good — a buyer and an accountant with a real shop do that — only that the decisions made
// deliberately are still there.

const RAW = readFileSync('apps/web-erp/web/suppliers.js', 'utf8');
const VIEW = RAW.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'); // comments discuss on purpose
const HTML = readFileSync('apps/web-erp/web/suppliers.html', 'utf8');

const data: SuppliersData = {
  asAt: '2026-09-30T10:00:00.000Z', owedMinor: 9000,
  suppliers: [{
    supplierId: 's-4', name: 'Blocked Bros', status: 'active', blocked: true, proposedBy: 'u-buyer', bankAccountRef: '****1234',
    owedMinor: 9000, withheldMinor: 2000, paidMinor: 0, unmatchedInvoices: 0, blockedInvoices: 1, pendingReturns: 0, currency: 'INR',
    needsAttention: true, attention: ['blocked', 'blocked_invoices', 'withheld'],
  }],
};
const ports = (over: Partial<SuppliersPorts> = {}): SuppliersPorts => ({
  snapshot: () => data, mayRead: () => true, mayPropose: () => true, mayApprove: () => true,
  approvePort: () => ({ post: async () => ({ result: 'approved' }) }), proposePort: () => ({ post: async () => ({ result: 'proposed', possibleDuplicates: [] }) }),
  ...over,
});

describe('the suppliers screen is offered in both languages', () => {
  it('has no gap in either language across the whole vocabulary', () => {
    const gaps = bilingualGaps(SUPPLIERS_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });

  it('tripwire — the detector fires on a key genuinely absent', () => {
    const holey = { en: { ...SUPPLIERS_COPY.en }, ta: { ...SUPPLIERS_COPY.ta, title: '' } };
    expect(bilingualGaps(holey, COPY_KEYS).ta).toContain('title');
  });
});

describe('every supplier reads as a state, never colour alone', () => {
  it('a supplier under a hold carries a tone AND a non-blank icon AND a non-blank word, and every reason as words', () => {
    const s = createSuppliersSession({ userId: 'u-acct' }, ports()).view('en').suppliers[0]!;
    expect(s.status.tone).toBe('error');
    expect(s.status.needsAttention).toBe(true);
    expect(s.status.label.length).toBeGreaterThan(0);
    expect(s.status.icon.trim().length).toBeGreaterThan(0);
    expect((s.status.announcement ?? '').length).toBeGreaterThan(0);
    expect(s.reasons.map((r) => r.label.length > 0)).toEqual([true, true, true]);
  });
});

describe('the view renders from the tested session and re-decides nothing', () => {
  it('reads window.suppliersSession and calls session.view()', () => {
    expect(VIEW).toMatch(/window\.suppliersSession/);
    expect(VIEW).toMatch(/session\.view\(/);
  });

  it('issues NO write of its own — the two writes go through the session (approve, propose), never a fetch in the view', () => {
    const writes = VIEW.match(/method:\s*'(POST|PUT|PATCH|DELETE)'/g) ?? [];
    expect(writes).toEqual([]);
    expect(VIEW).not.toMatch(/\bfetch\(/);
    expect(VIEW).toMatch(/session\.approve\(/);
    expect(VIEW).toMatch(/session\.propose\(/);
  });

  it('the writes run only on an explicit click — never on load, never on a timer', () => {
    expect(VIEW).toMatch(/el\('approve'\)\.addEventListener\('click'/);
    expect(VIEW).toMatch(/el\('propose'\)\.addEventListener\('click'/);
    expect(VIEW).not.toMatch(/setInterval\(/);
    expect(VIEW).not.toMatch(/setTimeout\(/);
  });

  it('never asks its questions with a browser dialog', () => {
    expect(/\b(alert|confirm|prompt)\s*\(/.test(VIEW)).toBe(false);
  });

  it('labels each status for a screen reader and hides the decorative icon', () => {
    expect(VIEW).toMatch(/status\.setAttribute\('aria-label'/);
    expect(VIEW).toMatch(/icon\.setAttribute\('aria-hidden', 'true'\)/);
  });

  it('shows the cloud\'s verdict on a write through the session\'s presenter — the view invents no wording of its own', () => {
    expect(VIEW).toMatch(/session\.presentApproveOutcome\(lang, outcome\)/);
    expect(VIEW).toMatch(/session\.presentProposeOutcome\(lang, outcome\)/);
  });
});

describe('the session refuses before the wire (§28)', () => {
  it('the proposer of a supplier is never offered its approval, and a self-approval is refused with nothing sent', async () => {
    let posted = 0;
    const own: SuppliersData = { suppliers: [{ ...data.suppliers![0]!, supplierId: 's-2', status: 'proposed', blocked: false, proposedBy: 'u-acct', attention: ['awaiting_approval'] }] };
    const s = createSuppliersSession({ userId: 'u-acct' }, ports({ snapshot: () => own, approvePort: () => ({ post: async () => { posted += 1; return { result: 'approved' }; } }) }));
    expect(s.view('en').approvable).toEqual([]);
    expect(await s.approve('s-2', 'why')).toEqual({ outcome: 'self_approval' });
    expect(posted).toBe(0);
  });

  it('a reader without the approve right is offered no approve control; without the manage right, no propose form', () => {
    expect(createSuppliersSession({ userId: 'u-x' }, ports({ mayApprove: () => false })).view('en').canApprove).toBe(false);
    expect(createSuppliersSession({ userId: 'u-x' }, ports({ mayPropose: () => false })).view('en').canPropose).toBe(false);
    expect(HTML).toMatch(/<section class="form" id="approver" hidden/);
    expect(HTML).toMatch(/<section class="form" id="proposer" hidden/);
  });
});

describe('the shell is wired to the bundle and the injected data, and is accessible', () => {
  it('loads the shared bundle and carries the data marker', () => {
    expect(HTML).toMatch(/web-erp\.bundle\.js/);
    expect(HTML).toContain('<!--SCREEN-DATA-->');
  });

  it('labels the language toggle, the list and both forms; every field has a label', () => {
    expect(HTML).toMatch(/id="lang"[^>]*aria-label=/);
    expect(HTML).toMatch(/id="rows"[^>]*aria-label=/);
    expect(HTML).toMatch(/id="approver"[^>]*aria-label=/);
    expect(HTML).toMatch(/id="proposer"[^>]*aria-label=/);
    for (const id of ['approve-supplier', 'approve-reason', 'propose-code', 'propose-name', 'propose-gstin', 'propose-phone', 'propose-email', 'propose-terms']) {
      expect(HTML, `${id} has no label`).toMatch(new RegExp(`<label for="${id}"`));
    }
  });
});
