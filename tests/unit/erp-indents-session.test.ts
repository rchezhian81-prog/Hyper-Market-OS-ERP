import { describe, it, expect } from 'vitest';
import {
  createIndentsSession, INDENTS_COPY, COPY_KEYS, FLOOR_INDENT_REQUESTED, FLOOR_INDENT_RECEIVED, indentKeyFor, receiptKeyFor,
  type IndentsData, type IndentsPorts, type IndentsConfig, type IndentRowView, type IndentLineView, type IndentApprovePort, type ApprovePostResult,
  type IndentResolvePort, type ResolvePostResult, type ResolveOutcome,
} from '../../apps/web-erp/src/indents-session';
import { bilingualGaps } from '../../packages/ui/src/index';
import { openDeviceOutbox, guardedStore } from '../../packages/sync/src/device-outbox';
import type { SyncOutbox } from '../../packages/sync/src/index';

/**
 * SP-8b (F08 · WF-06 · WF-07 · M09-FR-03 · M08-FR-02 · §28 · §31 · P-01 · P-03 · P-08): the Floor indents screen's DOM-free
 * session model. It orders the register needing-a-person first and says every state in words; it RAISES an indent and
 * COUNTS IN an issue onto the DURABLE device queue before it says saved (the same queue the manager's and the buyer's
 * screens use — reopened over the same storage, the work is still there); it refuses the requester's own approval and the
 * issuer's own receipt before anything is sent; "posted" is only ever the store computer's word. The ports are stubs; the
 * real ones are proven in the browser e2e and the box → cloud integration test.
 */

const AT = '2026-09-30T10:00:00.000Z';
const NOW = '2026-09-30T10:05:00.000Z';

const line = (over: Partial<IndentLineView> = {}): IndentLineView => ({
  productId: 'RICE', uom: 'EA', requestedMinor: 20, allocatedMinor: 0, issuedMinor: 0, receivedMinor: 0, inTransitMinor: 0, shortfallMinor: 0, outstandingMinor: 0, ...over,
});
const row = (over: Partial<IndentRowView> = {}): IndentRowView => ({
  indentId: 'ind-1', state: 'requested', requestedBy: 'u-floor', requestedAt: '2026-09-30T08:00:00.000Z', approvedBy: null,
  fromLocationId: 'S1-BACK', toLocationId: 'S1', reason: 'shelf 4 empty', flags: [], attention: ['awaiting_approval'], needsAttention: true,
  lines: [line()], issues: [], ...over,
});

/** The cloud's register: a closed indent, one on the trolley (12 of 20 issued by u-back), the manager's own ask, the floor's ask. */
const DATA: IndentsData = {
  asAt: AT, inTransitMinor: 12, outstandingMinor: 8,
  indents: [
    row({ indentId: 'ind-4', state: 'received', requestedAt: '2026-09-29T08:00:00.000Z', approvedBy: 'u-mgr', attention: [], needsAttention: false,
      lines: [line({ allocatedMinor: 20, issuedMinor: 20, receivedMinor: 20 })],
      issues: [{ issueId: 'is-1', issuedBy: 'u-back', issuedAt: '2026-09-29T09:00:00.000Z', state: 'received', lines: [{ productId: 'RICE', batchId: null, quantityMinor: 20 }] }] }),
    row({ indentId: 'ind-2', state: 'issuing', requestedAt: '2026-09-30T07:00:00.000Z', approvedBy: 'u-mgr', flags: ['partial_issue'], attention: ['owed_by_back_store', 'on_the_trolley'],
      lines: [line({ allocatedMinor: 20, issuedMinor: 12, inTransitMinor: 12, outstandingMinor: 8 })],
      issues: [{ issueId: 'is-1', issuedBy: 'u-back', issuedAt: '2026-09-30T07:30:00.000Z', state: 'in_transit', lines: [{ productId: 'RICE', batchId: null, quantityMinor: 12 }] }] }),
    row({ indentId: 'ind-3', requestedBy: 'u-mgr', requestedAt: '2026-09-30T09:00:00.000Z', lines: [line({ productId: 'OIL', requestedMinor: 6 })] }),
    row(),
  ],
};

const memory = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } }; };
const outboxOn = (storage = memory()): SyncOutbox => openDeviceOutbox(guardedStore('sre.indents.outbox.S1', storage, () => {}), () => {});

interface Calls { approve: { indentId: string; reason: string }[] }
const ports = (over: Partial<IndentsPorts> & { data?: IndentsData; answer?: ApprovePostResult } = {}): { ports: IndentsPorts; calls: Calls } => {
  const calls: Calls = { approve: [] };
  const approvePort: IndentApprovePort = { post: async (i) => { calls.approve.push(i); return over.answer ?? { result: 'approved' }; } };
  const { data, answer, ...rest } = over;
  void answer;
  return {
    calls,
    ports: { snapshot: () => data ?? DATA, mayRead: () => true, mayRequest: () => true, mayApprove: () => true, mayReceive: () => true, approvePort: () => approvePort, ...rest },
  };
};
const config = (over: Partial<IndentsConfig> = {}): IndentsConfig => ({
  userId: 'u-mgr', storeId: 'S1', backStoreId: 'S1-BACK', products: [{ productId: 'RICE', name: 'Rice 5kg', uom: 'EA' }, { productId: 'OIL', name: 'Oil 1l', uom: 'LTR' }], now: () => NOW, ...over,
});

describe('the copy is complete in both languages', () => {
  it('has no gap in either language across the whole vocabulary', () => {
    const gaps = bilingualGaps(INDENTS_COPY, COPY_KEYS);
    expect(gaps.en).toEqual([]);
    expect(gaps.ta).toEqual([]);
  });
});

describe('the register: needing a person first, every state in words, four figures per line (P-03 · P-08)', () => {
  it('orders the undecided asks first (oldest first), then what needs a person, the closed ones last; the figures are head office\'s', () => {
    const v = createIndentsSession(config(), ports().ports, outboxOn()).view('en');
    expect(v.screenState.tone).toBe('ok');
    expect(v.indents.map((i) => i.indentId)).toEqual(['ind-1', 'ind-3', 'ind-2', 'ind-4']);
    expect(v.count).toBe(4);
    expect(v.needingAttentionCount).toBe(3);
    expect(v.inTransitMinor).toBe(12);
    expect(v.outstandingMinor).toBe(8);
    expect(v.asOf).toBe(AT);
    const trolley = v.indents.find((i) => i.indentId === 'ind-2')!;
    expect(trolley.lines[0]).toMatchObject({ requestedMinor: 20, allocatedMinor: 20, issuedMinor: 12, inTransitMinor: 12, receivedMinor: 0, outstandingMinor: 8 });
    expect(trolley.flags).toEqual([{ flag: 'partial_issue', label: INDENTS_COPY.en.flagPartialIssue }]);
  });

  it('every row is a tone AND an icon AND a word, never colour alone — in both languages', () => {
    for (const lang of ['en', 'ta'] as const) {
      const v = createIndentsSession(config(), ports().ports, outboxOn()).view(lang);
      const by = (id: string) => v.indents.find((i) => i.indentId === id)!;
      expect(by('ind-1').status).toMatchObject({ tone: 'degraded', needsAttention: true });
      expect(by('ind-2').status).toMatchObject({ tone: 'degraded', needsAttention: true });
      expect(by('ind-4').status).toMatchObject({ tone: 'ok', needsAttention: false });
      for (const i of v.indents) {
        expect(i.status.icon.trim().length).toBeGreaterThan(0);
        expect(i.status.label.length).toBeGreaterThan(0);
        expect((i.status.announcement ?? '').length).toBeGreaterThan(0);
        expect(i.stateLabel.length).toBeGreaterThan(0);
      }
    }
  });

  it('a reader without the read right sees a plain not-permitted state and no control; an empty register says so', () => {
    const denied = createIndentsSession(config(), ports({ mayRead: () => false }).ports, outboxOn()).view('en');
    expect(denied.screenState.label).toBe(INDENTS_COPY.en.stateNotPermitted);
    expect(denied.indents).toEqual([]);
    expect([denied.canRequest, denied.canApprove, denied.canReceive]).toEqual([false, false, false]);
    const none = createIndentsSession(config(), ports({ data: { asAt: AT, indents: [] } }).ports, outboxOn()).view('en');
    expect(none.screenState.label).toBe(INDENTS_COPY.en.scrNoIndents);
    expect(none.canRequest).toBe(true); // nothing to see yet, but the floor may still ask
    const unread = createIndentsSession(config(), ports({ data: {} }).ports, outboxOn()).view('en');
    expect(unread.screenState.label).toBe(INDENTS_COPY.en.scrEmpty);
  });
});

describe('RAISE: queued on the durable device queue before it is called saved (P-01 · §31)', () => {
  it('a good ask is on the queue as a FloorIndentRequested from the back store to the floor, in the reader\'s name, with whole-number lines and the catalogue\'s unit', () => {
    const outbox = outboxOn();
    const s = createIndentsSession(config(), ports().ports, outbox);
    const out = s.raise({ lines: [{ productId: 'RICE', quantityMinor: '20', uom: '' }, { productId: ' OIL ', quantityMinor: '6', uom: 'ltr' }], reason: '  shelf 4 empty ' });
    expect(out.ok).toBe(true);
    const indentId = out.ok ? out.indentId : '';
    expect(indentId).toMatch(/^ind-/);
    const [item] = outbox.pending();
    expect(item?.key).toBe(indentKeyFor(indentId));
    expect(item?.event.type).toBe(FLOOR_INDENT_REQUESTED);
    expect(item?.event.idempotencyKey).toBe(indentKeyFor(indentId));
    expect(item?.event.payload).toEqual({
      indentId, fromLocationId: 'S1-BACK', toLocationId: 'S1',
      lines: [{ productId: 'RICE', quantityMinor: 20, uom: 'EA' }, { productId: 'OIL', quantityMinor: 6, uom: 'LTR' }],
      reason: 'shelf 4 empty', requestedBy: 'u-mgr', at: NOW, storeId: 'S1', source: 'indents-screen',
    });
    expect(s.savedWork()).toEqual([expect.objectContaining({ kind: 'request', id: indentId, what: indentId, detail: 'RICE × 20 · OIL × 6', state: 'saved_here', attempts: 0 })]);
    expect(s.handedKeys()).toEqual([]);
  });

  it('a given id is kept (the same ask again is the same record), and the work is still there when the screen is reopened over the same storage', () => {
    const storage = memory();
    const first = createIndentsSession(config(), ports().ports, outboxOn(storage));
    expect(first.raise({ lines: [{ productId: 'RICE', quantityMinor: '5', uom: 'EA' }], reason: '', indentId: 'ind-9' })).toEqual({ ok: true, indentId: 'ind-9' });
    expect(first.savedWork()[0]).toMatchObject({ id: 'ind-9', state: 'saved_here' });
    // A reload: a new session over the same device storage.
    const again = createIndentsSession(config(), ports().ports, outboxOn(storage));
    expect(again.savedWork()).toEqual([expect.objectContaining({ kind: 'request', id: 'ind-9', state: 'saved_here' })]);
  });

  it('refuses — with nothing queued — the reader who lacks the right, a nameless reader, a box that named no places, no lines, a bad line, a repeated product', () => {
    const cases: [IndentsConfig, IndentsPorts, Parameters<ReturnType<typeof createIndentsSession>['raise']>[0], string][] = [
      [config(), ports({ mayRequest: () => false }).ports, { lines: [{ productId: 'RICE', quantityMinor: '1', uom: 'EA' }], reason: '' }, 'not_permitted'],
      [config({ userId: null }), ports().ports, { lines: [{ productId: 'RICE', quantityMinor: '1', uom: 'EA' }], reason: '' }, 'nobody_named'],
      [config({ backStoreId: null }), ports().ports, { lines: [{ productId: 'RICE', quantityMinor: '1', uom: 'EA' }], reason: '' }, 'no_places'],
      [config(), ports().ports, { lines: [], reason: '' }, 'no_lines'],
      [config(), ports().ports, { lines: [{ productId: 'RICE', quantityMinor: '0', uom: 'EA' }], reason: '' }, 'bad_line'],
      [config(), ports().ports, { lines: [{ productId: 'RICE', quantityMinor: 'ten', uom: 'EA' }], reason: '' }, 'bad_line'],
      [config(), ports().ports, { lines: [{ productId: '', quantityMinor: '1', uom: 'EA' }], reason: '' }, 'bad_line'],
      [config(), ports().ports, { lines: [{ productId: 'RICE', quantityMinor: '1', uom: 'EA' }, { productId: 'RICE', quantityMinor: '2', uom: 'EA' }], reason: '' }, 'duplicate_product'],
    ];
    for (const [cfg, p, input, refusal] of cases) {
      const outbox = outboxOn();
      const s = createIndentsSession(cfg, p, outbox);
      expect(s.raise(input), refusal).toEqual({ ok: false, refusal });
      expect(outbox.all(), refusal).toEqual([]);
      for (const lang of ['en', 'ta'] as const) expect(s.raiseRefusalWords(lang, refusal as never).length).toBeGreaterThan(0);
    }
    // A nameless reader or a box that named no places is offered no raise form at all.
    expect(createIndentsSession(config({ userId: null }), ports().ports, outboxOn()).view('en')).toMatchObject({ canRequest: false, nobodyNamed: true });
    expect(createIndentsSession(config({ storeId: null }), ports().ports, outboxOn()).view('en').canRequest).toBe(false);
  });
});

describe('COUNT IN: the floor\'s independent receipt, queued durably; the issuer refused before the wire (§28)', () => {
  it('is offered only for issues on the trolley that somebody else issued; a good count is on the queue as a FloorIndentReceived carrying only what was counted', () => {
    const outbox = outboxOn();
    const s = createIndentsSession(config(), ports().ports, outbox);
    expect(s.view('en').receivable.map((r) => [r.indentId, r.issue.issueId])).toEqual([['ind-2', 'is-1']]);
    const out = s.receive({ indentId: 'ind-2', issueId: 'is-1', counted: [{ productId: 'RICE', batchId: null, quantityMinor: '10' }] });
    expect(out).toEqual({ ok: true, indentId: 'ind-2', issueId: 'is-1' });
    const [item] = outbox.pending();
    expect(item?.key).toBe(receiptKeyFor('ind-2', 'is-1'));
    expect(item?.event.type).toBe(FLOOR_INDENT_RECEIVED);
    expect(item?.event.payload).toEqual({ indentId: 'ind-2', issueId: 'is-1', counted: [{ productId: 'RICE', batchId: null, quantityMinor: 10 }], receivedBy: 'u-mgr', at: NOW, storeId: 'S1', source: 'indents-screen' });
    expect(s.savedWork()[0]).toMatchObject({ kind: 'receipt', id: 'ind-2:is-1', what: 'ind-2 · is-1', detail: 'RICE × 10', state: 'saved_here' });
    // Saved once: the issue is no longer offered, and a second count of it is refused here.
    expect(s.view('en').receivable).toEqual([]);
    expect(s.receive({ indentId: 'ind-2', issueId: 'is-1', counted: [{ productId: 'RICE', batchId: null, quantityMinor: '10' }] })).toEqual({ ok: false, refusal: 'already_saved' });
    expect(outbox.all()).toHaveLength(1);
  });

  it('refuses — with nothing queued — the issuer, an unknown issue, one already received, a bad count, a reader without the right', () => {
    const count = [{ productId: 'RICE', batchId: null, quantityMinor: '12' }];
    const cases: [IndentsConfig, IndentsPorts, { indentId: string; issueId: string; counted: typeof count }, string][] = [
      [config({ userId: 'u-back' }), ports().ports, { indentId: 'ind-2', issueId: 'is-1', counted: count }, 'issuer_cannot_receive'],
      [config(), ports().ports, { indentId: 'ind-2', issueId: 'is-9', counted: count }, 'issue_unknown'],
      [config(), ports().ports, { indentId: 'ind-9', issueId: 'is-1', counted: count }, 'issue_unknown'],
      [config(), ports().ports, { indentId: 'ind-4', issueId: 'is-1', counted: count }, 'not_in_transit'],
      [config(), ports().ports, { indentId: 'ind-2', issueId: 'is-1', counted: [{ productId: 'RICE', batchId: null, quantityMinor: '-1' }] }, 'bad_count'],
      [config(), ports().ports, { indentId: 'ind-2', issueId: 'is-1', counted: [{ productId: 'RICE', batchId: null, quantityMinor: '1.5' }] }, 'bad_count'],
      [config(), ports({ mayReceive: () => false }).ports, { indentId: 'ind-2', issueId: 'is-1', counted: count }, 'not_permitted'],
      [config({ userId: null }), ports().ports, { indentId: 'ind-2', issueId: 'is-1', counted: count }, 'nobody_named'],
    ];
    for (const [cfg, p, input, refusal] of cases) {
      const outbox = outboxOn();
      const s = createIndentsSession(cfg, p, outbox);
      expect(s.receive(input), refusal).toEqual({ ok: false, refusal });
      expect(outbox.all(), refusal).toEqual([]);
      for (const lang of ['en', 'ta'] as const) expect(s.receiveRefusalWords(lang, refusal as never).length).toBeGreaterThan(0);
    }
    // The issuer is never even offered their own issue.
    expect(createIndentsSession(config({ userId: 'u-back' }), ports().ports, outboxOn()).view('en').receivable).toEqual([]);
  });
});

describe('APPROVE: an online write by a different person; the requester refused before the wire (§28)', () => {
  it('offers only the asks somebody else raised; approving one POSTs { indentId, reason } through the port and reports the cloud\'s word', async () => {
    const { ports: p, calls } = ports();
    const s = createIndentsSession(config(), p, outboxOn());
    const v = s.view('en');
    expect(v.canApprove).toBe(true);
    expect(v.approvable.map((i) => i.indentId)).toEqual(['ind-1']);
    expect(v.indents.find((i) => i.indentId === 'ind-3')).toMatchObject({ ownAsk: true, canApproveHere: false });
    expect(await s.approve(' ind-1 ', ' counted the shelf ')).toEqual({ outcome: 'approved' });
    expect(calls.approve).toEqual([{ indentId: 'ind-1', reason: 'counted the shelf' }]);
  });

  it('refuses the reader\'s own ask, an indent not awaiting approval, a reader without the right, and a page with no link — with nothing sent', async () => {
    const { ports: p, calls } = ports();
    const s = createIndentsSession(config(), p, outboxOn());
    expect(await s.approve('ind-3', 'mine')).toEqual({ outcome: 'self_approval' });
    expect(await s.approve('ind-2', 'late')).toEqual({ outcome: 'not_requested' });
    expect(await s.approve('ind-9', 'ghost')).toEqual({ outcome: 'not_requested' });
    expect(calls.approve).toEqual([]);
    expect(await createIndentsSession(config(), ports({ mayApprove: () => false }).ports, outboxOn()).approve('ind-1', 'x')).toEqual({ outcome: 'not_permitted' });
    expect(await createIndentsSession(config({ userId: null }), ports().ports, outboxOn()).approve('ind-1', 'x')).toEqual({ outcome: 'not_permitted' });
    const unlinked = createIndentsSession(config(), ports({ approvePort: () => null }).ports, outboxOn());
    expect(await unlinked.approve('ind-1', 'x')).toEqual({ outcome: 'no_link' });
    expect(unlinked.view('en').canApprove).toBe(false);
  });

  it('passes the cloud\'s verdict on verbatim — refused with its reason, already approved, a lost link — and presents each as a tone + icon + words in both languages', async () => {
    expect(await createIndentsSession(config(), ports({ answer: { result: 'refused', reason: 'OIL is not stocked at S1-BACK' } }).ports, outboxOn()).approve('ind-1', 'x')).toEqual({ outcome: 'refused', reason: 'OIL is not stocked at S1-BACK' });
    expect(await createIndentsSession(config(), ports({ answer: { result: 'already_approved' } }).ports, outboxOn()).approve('ind-1', 'x')).toEqual({ outcome: 'already_approved' });
    expect(await createIndentsSession(config(), ports({ answer: { result: 'lost_link' } }).ports, outboxOn()).approve('ind-1', 'x')).toEqual({ outcome: 'lost_link' });
    const s = createIndentsSession(config(), ports().ports, outboxOn());
    for (const lang of ['en', 'ta'] as const) {
      expect(s.presentApproveOutcome(lang, { outcome: 'approved' })).toMatchObject({ tone: 'ok', needsAttention: false });
      expect(s.presentApproveOutcome(lang, { outcome: 'already_approved' })).toMatchObject({ tone: 'ok', needsAttention: false });
      const refused = s.presentApproveOutcome(lang, { outcome: 'refused', reason: 'OIL is not stocked' });
      expect(refused).toMatchObject({ tone: 'error', needsAttention: true });
      expect(refused.label).toContain('OIL is not stocked');
      expect(s.presentApproveOutcome(lang, { outcome: 'self_approval' })).toMatchObject({ tone: 'error', needsAttention: true });
      expect(s.presentApproveOutcome(lang, { outcome: 'lost_link' })).toMatchObject({ tone: 'degraded', needsAttention: true });
      for (const outcome of ['not_permitted', 'not_requested', 'no_link'] as const) expect(s.presentApproveOutcome(lang, { outcome }).label.length).toBeGreaterThan(0);
    }
  });
});

describe('where each saved piece of work has got to: the five shared states, "posted" only on the box\'s word (P-08)', () => {
  it('saved here → retrying after a failed hand-off → with the store computer once acknowledged → posted / refused only as the box says', () => {
    const outbox = outboxOn();
    const s = createIndentsSession(config(), ports().ports, outbox);
    s.raise({ lines: [{ productId: 'RICE', quantityMinor: '20', uom: 'EA' }], reason: '', indentId: 'ind-a' });
    s.receive({ indentId: 'ind-2', issueId: 'is-1', counted: [{ productId: 'RICE', batchId: null, quantityMinor: '12' }] });
    const key = indentKeyFor('ind-a');
    const rkey = receiptKeyFor('ind-2', 'is-1');
    expect(s.savedWork().map((w) => [w.id, w.state])).toEqual([['ind-2:is-1', 'saved_here'], ['ind-a', 'saved_here']]); // newest first
    outbox.recordFailure(key);
    expect(s.savedWork().find((w) => w.id === 'ind-a')).toMatchObject({ state: 'retrying', attempts: 1 });
    outbox.acknowledge(key);
    outbox.acknowledge(rkey);
    expect(s.savedWork().map((w) => w.state)).toEqual(['handed_to_box', 'handed_to_box']);
    expect(s.handedKeys()).toEqual([key, rkey]);
    // The box's word, and only the box's word, makes it posted or refused — with the box's reason.
    s.noteBoxStatus([{ key, state: 'posted', attempts: 1 }, { key: rkey, state: 'refused', attempts: 1, reason: 'issuer_cannot_receive: u-back issued this' }]);
    expect(s.savedWork().find((w) => w.id === 'ind-a')).toMatchObject({ state: 'posted' });
    expect(s.savedWork().find((w) => w.id === 'ind-2:is-1')).toMatchObject({ state: 'refused', reason: 'issuer_cannot_receive: u-back issued this' });
  });

  it('the box\'s word is shared by every session over the same queue — a live re-present after a register read still shows "posted" (P-08)', () => {
    const storage = memory();
    const words = new Map();
    const boot = createIndentsSession(config(), ports().ports, outboxOn(storage), words);
    boot.raise({ lines: [{ productId: 'RICE', quantityMinor: '2', uom: 'EA' }], reason: '', indentId: 'ind-w' });
    const outbox = outboxOn(storage);
    outbox.acknowledge(indentKeyFor('ind-w'));
    boot.noteBoxStatus([{ key: indentKeyFor('ind-w'), state: 'posted', attempts: 1 }]);
    const live = createIndentsSession(config(), ports().ports, outbox, words);
    expect(live.savedWork()[0]).toMatchObject({ id: 'ind-w', state: 'posted' });
    // …and a session with its OWN store knows only what the queue says: with the store computer, not yet posted.
    expect(createIndentsSession(config(), ports().ports, outbox).savedWork()[0]).toMatchObject({ id: 'ind-w', state: 'handed_to_box' });
  });
});

describe('Batch 2 · RESOLVE a shortfall: an online write by someone who neither issued nor counted it (§28 · M09-FR-03)', () => {
  const SHORT: IndentsData = {
    asAt: AT,
    indents: [row({ indentId: 'ind-5', state: 'received', approvedBy: 'u-mgr', attention: ['arrived_short'],
      lines: [line({ allocatedMinor: 20, issuedMinor: 20, receivedMinor: 17, shortfallMinor: 3 })],
      issues: [{ issueId: 'is-1', issuedBy: 'u-back', issuedAt: AT, state: 'received', receivedBy: 'u-floor2', lines: [{ productId: 'RICE', batchId: null, quantityMinor: 20 }],
        shortfall: [{ productId: 'RICE', batchId: null, quantityMinor: 3, valueMinor: 135_000 }] }] })],
  };
  const withResolve = (answer: ResolvePostResult = { result: 'resolved' }, over: Partial<IndentsPorts> = {}) => {
    const sent: unknown[] = [];
    const resolvePort: IndentResolvePort = { post: async (i) => { sent.push(i); return answer; } };
    return { sent, ports: ports({ data: SHORT, mayResolve: () => true, resolvePort: () => resolvePort, ...over }).ports };
  };
  const input = { indentId: 'ind-5', issueId: 'is-1', reasonCode: 'miscount', note: 'searched the back store', found: [{ productId: 'RICE', batchId: null, foundMinor: '1' }] };

  it('offers the open shortfall to a third person, with the adjustment reasons in words; sends only what turned up, no resolver', async () => {
    const { sent, ports: p } = withResolve();
    const s = createIndentsSession(config(), p, outboxOn());
    const v = s.view('en');
    expect(v.canResolve).toBe(true);
    expect(v.resolvable.map((r) => `${r.indentId}|${r.issue.issueId}`)).toEqual(['ind-5|is-1']);
    expect(v.resolveReasons.map((r) => r.code)).toEqual(['damaged', 'expired', 'miscount', 'found', 'theft_suspected', 'other']);
    expect(s.view('ta').resolveReasons[0]!.label).toBe('சேதமடைந்தது');
    expect(await s.resolve(input)).toEqual({ outcome: 'resolved' });
    expect(sent).toEqual([{ indentId: 'ind-5', issueId: 'is-1', reasonCode: 'miscount', note: 'searched the back store', lines: [{ productId: 'RICE', batchId: null, foundMinor: 1 }] }]);
    expect(s.presentResolveOutcome('en', { outcome: 'resolved' })).toMatchObject({ tone: 'ok' });
  });

  it('refuses — with nothing sent — the issuer, the counter, a bad reason, a short note, too much found, a resolved or unknown issue, no right, no link', async () => {
    const resolvedAlready: IndentsData = { indents: [{ ...SHORT.indents![0]!, issues: [{ ...SHORT.indents![0]!.issues[0]!, resolvedBy: 'u-other' }] }] };
    const cases: [IndentsConfig, Partial<IndentsPorts>, typeof input, string][] = [
      [config({ userId: 'u-back' }), {}, input, 'issuer_cannot_resolve'],
      [config({ userId: 'u-floor2' }), {}, input, 'counter_cannot_resolve'],
      [config(), {}, { ...input, reasonCode: 'lost_somewhere' }, 'bad_reason'],
      [config(), {}, { ...input, note: 'no' }, 'note_too_short'],
      [config(), {}, { ...input, found: [{ productId: 'RICE', batchId: null, foundMinor: '4' }] }, 'bad_found'],
      [config(), {}, { ...input, found: [{ productId: 'OIL', batchId: null, foundMinor: '1' }] }, 'bad_found'],
      [config(), {}, { ...input, issueId: 'is-9' }, 'issue_unknown'],
      [config(), { snapshot: () => resolvedAlready }, input, 'not_open'],
      [config(), { mayResolve: () => false }, input, 'not_permitted'],
      [config(), { resolvePort: () => null }, input, 'no_link'],
    ];
    for (const [cfg, over, inp, outcome] of cases) {
      const { sent, ports: p } = withResolve({ result: 'resolved' }, over);
      const s = createIndentsSession(cfg, p, outboxOn());
      expect(await s.resolve(inp), outcome).toEqual({ outcome });
      expect(sent, outcome).toEqual([]);
      expect(s.presentResolveOutcome('ta', { outcome } as ResolveOutcome).label.length, outcome).toBeGreaterThan(0);
    }
    // The issuer and the counter are not even offered it.
    expect(createIndentsSession(config({ userId: 'u-floor2' }), withResolve().ports, outboxOn()).view('en').resolvable).toEqual([]);
    expect(createIndentsSession(config({ userId: 'u-back' }), withResolve().ports, outboxOn()).view('en').resolvable).toEqual([]);
  });

  it('passes the cloud\'s refusal on verbatim and never claims it resolved', async () => {
    const { ports: p } = withResolve({ result: 'refused', reason: 'u-other resolved this shortfall first' });
    const s = createIndentsSession(config(), p, outboxOn());
    const o = await s.resolve(input);
    expect(o).toEqual({ outcome: 'refused', reason: 'u-other resolved this shortfall first' });
    expect(s.presentResolveOutcome('en', o).label).toContain('u-other resolved this shortfall first');
  });
});
