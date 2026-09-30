import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { INDENTS_COPY, COPY_KEYS, createIndentsSession, type IndentsData, type IndentsPorts } from '../../apps/web-erp/src/indents-session';
import { bilingualGaps } from '../../packages/ui/src/index';
import { DEVICE_ITEM_STATES, RELAYABLE_DEVICE_EVENTS } from '../../packages/sync/src/device-relay';
import { openIndentsOutbox, indentsPortsFromData } from '../../apps/web-erp/src/browser-entry';

// The Floor indents screen (SP-8b · F08 · M09-FR-03 · M08-FR-02 · §28 · §31 · P-01 · P-03 · P-08) lets the floor RAISE an
// indent and COUNT IN what the back store sent, a different person APPROVE, and everyone see where each ask is. These are
// static checks on the shipped view + shell — that it reads from the tested session (never re-deciding), that its writes
// go through the session (the ask and the count onto the DURABLE device queue; the approval through the session's port),
// only on an explicit click, that it says the five shared device states in words in both languages, that every row is a
// word+icon (never colour alone), and that the relay is nudged after every save and when the page comes back — never on a
// timer. They cannot prove the screen is good — a floor person and a manager with a real shop do that — only that the
// decisions made deliberately are still there.

const RAW = readFileSync('apps/web-erp/web/indents.js', 'utf8');
const VIEW = RAW.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'); // comments discuss on purpose
const HTML = readFileSync('apps/web-erp/web/indents.html', 'utf8');

const data: IndentsData = {
  asAt: '2026-09-30T10:00:00.000Z',
  indents: [
    { indentId: 'ind-1', state: 'requested', requestedBy: 'u-floor', requestedAt: '2026-09-30T08:00:00.000Z', approvedBy: null, fromLocationId: 'S1-BACK', toLocationId: 'S1', reason: null, flags: [], attention: ['awaiting_approval'], needsAttention: true,
      lines: [{ productId: 'RICE', uom: 'EA', requestedMinor: 20, allocatedMinor: 0, issuedMinor: 0, receivedMinor: 0, inTransitMinor: 0, shortfallMinor: 0, outstandingMinor: 0 }], issues: [] },
    { indentId: 'ind-2', state: 'issuing', requestedBy: 'u-floor', requestedAt: '2026-09-30T07:00:00.000Z', approvedBy: 'u-mgr', fromLocationId: 'S1-BACK', toLocationId: 'S1', reason: null, flags: ['partial_issue'], attention: ['on_the_trolley'], needsAttention: true,
      lines: [{ productId: 'RICE', uom: 'EA', requestedMinor: 20, allocatedMinor: 20, issuedMinor: 12, receivedMinor: 0, inTransitMinor: 12, shortfallMinor: 0, outstandingMinor: 8 }],
      issues: [{ issueId: 'is-1', issuedBy: 'u-back', issuedAt: '2026-09-30T07:30:00.000Z', state: 'in_transit', lines: [{ productId: 'RICE', batchId: null, quantityMinor: 12 }] }] },
  ],
};
const ports = (over: Partial<IndentsPorts> = {}): IndentsPorts => ({
  snapshot: () => data, mayRead: () => true, mayRequest: () => true, mayApprove: () => true, mayReceive: () => true,
  approvePort: () => ({ post: async () => ({ result: 'approved' }) }), ...over,
});
const config = (userId: string | null) => ({ userId, storeId: 'S1', backStoreId: 'S1-BACK', products: [], now: () => '2026-09-30T10:05:00.000Z' });
const memory = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } }; };
const outboxOn = () => openIndentsOutbox('S1', memory());

describe('the indents screen is offered in both languages', () => {
  it('has no gap in either language across the whole vocabulary', () => {
    const gaps = bilingualGaps(INDENTS_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });

  it('says each of the five SHARED device states in words, in both languages — the same states as the manager\'s and the buyer\'s screens', () => {
    const from = VIEW.indexOf('const STATE_WORDS = {');
    expect(from).toBeGreaterThan(-1);
    const block = VIEW.slice(from, VIEW.indexOf('\n};', from));
    for (const state of DEVICE_ITEM_STATES) {
      const line = block.split('\n').find((l) => l.trim().startsWith(`${state}: {`));
      expect(line, `"${state}" has no words on the screen`).toBeDefined();
      expect(line, `"${state}" has no English`).toMatch(/\ben: '/);
      expect(line, `"${state}" has no Tamil`).toMatch(/\bta: '/);
    }
    expect(VIEW).toMatch(/words\(STATE_WORDS, w\.state\)/);
  });
});

describe('every indent reads as a state, never colour alone', () => {
  it('an ask awaiting approval and an issue on the trolley each carry a tone AND a non-blank icon AND a non-blank word, and every flag as words', () => {
    const v = createIndentsSession(config('u-mgr'), ports(), outboxOn()).view('en');
    for (const i of v.indents) {
      expect(i.status.needsAttention).toBe(true);
      expect(i.status.tone).toBe('degraded');
      expect(i.status.label.length).toBeGreaterThan(0);
      expect(i.status.icon.trim().length).toBeGreaterThan(0);
      expect((i.status.announcement ?? '').length).toBeGreaterThan(0);
    }
    expect(v.indents.find((i) => i.indentId === 'ind-2')!.flags.map((f) => f.label.length > 0)).toEqual([true]);
  });
});

describe('the view renders from the tested session and re-decides nothing', () => {
  it('reads window.indentsSession and calls session.view()', () => {
    expect(VIEW).toMatch(/window\.indentsSession/);
    expect(VIEW).toMatch(/session\.view\(/);
  });

  it('issues NO write of its own — the ask and the count go onto the queue through the session, the approval through the session\'s port; never a fetch in the view', () => {
    expect(VIEW.match(/method:\s*'(POST|PUT|PATCH|DELETE)'/g) ?? []).toEqual([]);
    expect(VIEW).not.toMatch(/\bfetch\(/);
    expect(VIEW).not.toMatch(/localStorage/);
    expect(VIEW).toMatch(/session\.raise\(/);
    expect(VIEW).toMatch(/session\.receive\(/);
    expect(VIEW).toMatch(/session\.approve\(/);
  });

  it('the writes run only on an explicit click — never on load, never on a timer', () => {
    expect(VIEW).toMatch(/el\('raise'\)\.addEventListener\('click'/);
    expect(VIEW).toMatch(/el\('approve'\)\.addEventListener\('click'/);
    expect(VIEW).toMatch(/el\('receive'\)\.addEventListener\('click'/);
    expect(VIEW).not.toMatch(/setInterval\(/);
    expect(VIEW).not.toMatch(/setTimeout\(/);
  });

  it('nudges the shared relay after every save and whenever the page comes back (online · focus · pageshow · visible) — the queue, not this file, is the record', () => {
    expect(VIEW).toMatch(/window\.indentsRelay/);
    expect(VIEW).toMatch(/relay\.syncNow\(\)/);
    expect((VIEW.match(/void syncToBox\(\)/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(VIEW).toMatch(/\['online', 'focus', 'pageshow'\]/);
    expect(VIEW).toMatch(/visibilitychange/);
  });

  it('never asks its questions with a browser dialog', () => {
    expect(/\b(alert|confirm|prompt)\s*\(/.test(VIEW)).toBe(false);
  });

  it('labels each status for a screen reader and hides the decorative icon', () => {
    expect(VIEW).toMatch(/status\.setAttribute\('aria-label'/);
    expect(VIEW).toMatch(/icon\.setAttribute\('aria-hidden', 'true'\)/);
  });

  it('shows every verdict and refusal through the session\'s own words — the view invents no wording', () => {
    expect(VIEW).toMatch(/session\.presentApproveOutcome\(lang, outcome\)/);
    expect(VIEW).toMatch(/session\.raiseRefusalWords\(lang, outcome\.refusal\)/);
    expect(VIEW).toMatch(/session\.receiveRefusalWords\(lang, outcome\.refusal\)/);
  });

  it('after the live read, the live session becomes THE session on the window, so what is shown and what is asked agree', () => {
    expect(VIEW).toMatch(/window\.indentsSession = session/);
  });
});

describe('the session refuses before the wire (§28), and the composition root default-denies', () => {
  it('the requester of an indent is never offered its approval, and a self-approval is refused with nothing sent', async () => {
    let posted = 0;
    const s = createIndentsSession(config('u-floor'), ports({ approvePort: () => ({ post: async () => { posted += 1; return { result: 'approved' }; } }) }), outboxOn());
    expect(s.view('en').approvable).toEqual([]);
    expect(await s.approve('ind-1', 'why')).toEqual({ outcome: 'self_approval' });
    expect(posted).toBe(0);
  });

  it('the issuer is never offered their own issue to count in, and is refused with nothing queued', () => {
    const outbox = openIndentsOutbox('S1', memory());
    const s = createIndentsSession(config('u-back'), ports(), outbox);
    expect(s.view('en').receivable).toEqual([]);
    expect(s.receive({ indentId: 'ind-2', issueId: 'is-1', counted: [{ productId: 'RICE', batchId: null, quantityMinor: '12' }] })).toEqual({ ok: false, refusal: 'issuer_cannot_receive' });
    expect(outbox.all()).toEqual([]);
  });

  it('a reader without a right is offered no control for it; every form is hidden until the session says otherwise', () => {
    expect(createIndentsSession(config('u-x'), ports({ mayRequest: () => false }), outboxOn()).view('en').canRequest).toBe(false);
    expect(createIndentsSession(config('u-x'), ports({ mayApprove: () => false }), outboxOn()).view('en').canApprove).toBe(false);
    expect(createIndentsSession(config('u-x'), ports({ mayReceive: () => false }), outboxOn()).view('en').canReceive).toBe(false);
    expect(HTML).toMatch(/<section class="form" id="raiser" hidden/);
    expect(HTML).toMatch(/<section class="form" id="approver" hidden/);
    expect(HTML).toMatch(/<section class="form" id="receiver" hidden/);
  });

  it('the browser\'s ports default-deny: no permission list means nothing may be read or written; each right is its own gate', () => {
    const none = indentsPortsFromData(undefined);
    expect([none.mayRead(), none.mayRequest(), none.mayApprove(), none.mayReceive()]).toEqual([false, false, false, false]);
    const floor = indentsPortsFromData({ userId: 'u-floor', permissions: ['inventory.indent.read', 'inventory.indent.request', 'inventory.movement.append'] });
    expect([floor.mayRead(), floor.mayRequest(), floor.mayApprove(), floor.mayReceive()]).toEqual([true, true, false, true]);
    expect(indentsPortsFromData({ permissions: ['inventory.indent.approve'] }).mayApprove()).toBe(true);
    expect(floor.approvePort()).toBeNull();
  });

  it('the queue is the shared durable device queue keyed per store, and both of its events are on the box\'s allow-list as the ERP surface', () => {
    const storage = memory();
    const outbox = openIndentsOutbox('S1', storage);
    createIndentsSession(config('u-floor'), ports(), outbox).raise({ lines: [{ productId: 'RICE', quantityMinor: '1', uom: 'EA' }], reason: '', indentId: 'ind-k' });
    expect(storage.getItem('sre.indents.outbox.S1')).toContain('FloorIndentRequested');
    expect(RELAYABLE_DEVICE_EVENTS['FloorIndentRequested']?.surfaces).toEqual(['manager']);
    expect(RELAYABLE_DEVICE_EVENTS['FloorIndentReceived']?.surfaces).toEqual(['manager']);
  });
});

describe('the shell is wired to the bundle and the injected data, and is accessible', () => {
  it('loads the shared bundle and carries the data marker', () => {
    expect(HTML).toMatch(/web-erp\.bundle\.js/);
    expect(HTML).toContain('<!--SCREEN-DATA-->');
  });

  it('labels the language toggle, the list and the three forms; every field has a label', () => {
    expect(HTML).toMatch(/id="lang"[^>]*aria-label=/);
    expect(HTML).toMatch(/id="rows"[^>]*aria-label=/);
    expect(HTML).toMatch(/id="raiser"[^>]*aria-label=/);
    expect(HTML).toMatch(/id="approver"[^>]*aria-label=/);
    expect(HTML).toMatch(/id="receiver"[^>]*aria-label=/);
    for (const id of ['raise-product', 'raise-qty', 'raise-uom', 'raise-reason', 'approve-indent', 'approve-reason', 'receive-issue']) {
      expect(HTML, `${id} has no label`).toMatch(new RegExp(`<label for="${id}"`));
    }
  });
});
