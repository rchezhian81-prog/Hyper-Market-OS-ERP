import { describe, it, expect } from 'vitest';
import {
  CHECKLIST_COPY, COPY_KEYS, createChecklistSession,
  type ChecklistPorts, type ChecklistData, type StoredChecklist, type SubmitResult,
} from '../../apps/web-erp/src/checklist-session';
import { bilingualGaps } from '../../packages/ui/src/index';
import type { ChecklistItem } from '../../packages/workforce/src/workforce';

// The manager checklist screen (M25-FR-02 · API-11 · P-03 · P-04 · P-05 · P-08). It shows every opening/closing/
// handover checklist the day has — worst first (a BLOCKING item still outstanding outranks an unsigned one, which
// outranks one merely carrying non-blocking items, which outranks a done one), each reading as attention (never a
// bare colour); the one action from here is to SIGN AND SUBMIT a checklist (a human write in the manager's name).
// It refuses locally before any POST without the manage permission, when nobody is named, or for a checklist it
// does not hold.

const item = (over: Partial<ChecklistItem> & Pick<ChecklistItem, 'itemId'>): ChecklistItem => ({
  description: `do ${over.itemId}`, done: false, blocking: false, ...over,
});
const list = (over: Partial<StoredChecklist> & Pick<StoredChecklist, 'checklistId'>): StoredChecklist => ({
  kind: 'opening', items: [item({ itemId: 'i1', done: true })], ...over,
});
const data = (over: Partial<ChecklistData> = {}): ChecklistData => ({ checklists: [], ...over });

const session = (
  d: ChecklistData,
  ports: Partial<ChecklistPorts> = {},
  userId: string | null = 'u-manager',
) =>
  createChecklistSession({ userId }, {
    worklist: () => d,
    mayRead: () => true,
    mayManage: () => true,
    submitPort: () => ({ post: async () => 'recorded' as SubmitResult }),
    ...ports,
  });

describe('the checklist copy is complete in both languages', () => {
  it('has no gap in either language across the whole vocabulary', () => {
    const gaps = bilingualGaps(CHECKLIST_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });

  it('tripwire — the detector fires on a key genuinely absent', () => {
    const holey = { en: { ...CHECKLIST_COPY.en }, ta: { ...CHECKLIST_COPY.ta, scrReady: '' } };
    expect(bilingualGaps(holey, COPY_KEYS).ta).toContain('scrReady');
  });
});

describe('the view lists checklists worst first, each as attention (never colour alone)', () => {
  it('orders blocked before unsigned before carried before done', () => {
    const view = session(data({
      checklists: [
        list({ checklistId: 'C-done', kind: 'handover', items: [item({ itemId: 'a', done: true })], signedBy: 'u-x' }),
        list({ checklistId: 'C-carry', kind: 'closing', items: [item({ itemId: 'b', done: true }), item({ itemId: 'c', done: false, blocking: false })], signedBy: 'u-y' }),
        list({ checklistId: 'C-unsigned', kind: 'opening', items: [item({ itemId: 'd', done: true })] }),
        list({ checklistId: 'C-blocked', kind: 'opening', items: [item({ itemId: 'e', done: false, blocking: true })] }),
      ],
    })).view('en');
    expect(view.checklists.map((c) => c.checklistId)).toEqual(['C-blocked', 'C-unsigned', 'C-carry', 'C-done']);
    expect(view.checklists[0]?.outcome).toBe('blocked_item');
    expect(view.checklists[3]?.outcome).toBe('complete');
  });

  it('a blocked checklist is an error tone with an icon and a word; a done one is ok; an unsigned one a warning', () => {
    const view = session(data({
      checklists: [
        list({ checklistId: 'C-blocked', items: [item({ itemId: 'e', done: false, blocking: true })] }),
        list({ checklistId: 'C-unsigned', items: [item({ itemId: 'd', done: true })] }),
        list({ checklistId: 'C-done', items: [item({ itemId: 'a', done: true })], signedBy: 'u-x' }),
      ],
    })).view('en');
    const blocked = view.checklists.find((c) => c.checklistId === 'C-blocked')!;
    const unsigned = view.checklists.find((c) => c.checklistId === 'C-unsigned')!;
    const done = view.checklists.find((c) => c.checklistId === 'C-done')!;
    expect(blocked.status.tone).toBe('error');
    expect(blocked.status.icon.trim().length).toBeGreaterThan(0);
    expect(blocked.severityWord).toBe(CHECKLIST_COPY.en.blockedWord);
    expect(blocked.needsAttention).toBe(true);
    expect(unsigned.status.tone).toBe('degraded');
    expect(unsigned.severityWord).toBe(CHECKLIST_COPY.en.unsignedWord);
    expect(done.status.tone).toBe('ok');
    expect(done.needsAttention).toBe(false);
  });

  it('surfaces the outstanding items, with the blocking one flagged', () => {
    const view = session(data({
      checklists: [list({
        checklistId: 'C-1',
        items: [item({ itemId: 'safe', description: 'lock the safe', done: false, blocking: true }), item({ itemId: 'bins', description: 'take the bins out', done: false, blocking: false }), item({ itemId: 'till', done: true })],
        signedBy: 'u-x',
      })],
    })).view('en');
    const c = view.checklists[0]!;
    expect(c.outstanding.map((i) => i.itemId)).toEqual(['safe', 'bins']);
    expect(c.outstanding.find((i) => i.itemId === 'safe')!.blocking).toBe(true);
    expect(c.outstanding.find((i) => i.itemId === 'bins')!.blocking).toBe(false);
  });

  it('names the kind in the reader\'s language', () => {
    const en = session(data({ checklists: [list({ checklistId: 'C-1', kind: 'closing', items: [item({ itemId: 'a', done: true })], signedBy: 'u' })] })).view('en');
    const ta = session(data({ checklists: [list({ checklistId: 'C-1', kind: 'closing', items: [item({ itemId: 'a', done: true })], signedBy: 'u' })] })).view('ta');
    expect(en.checklists[0]?.kindLabel).toBe(CHECKLIST_COPY.en.kindClosing);
    expect(ta.checklists[0]?.kindLabel).toBe(CHECKLIST_COPY.ta.kindClosing);
  });

  it('a day with everything signed and unblocked reads as done, not as unknown', () => {
    const view = session(data({ checklists: [list({ checklistId: 'C-1', items: [item({ itemId: 'a', done: true })], signedBy: 'u' })] })).view('en');
    expect(view.toWorkCount).toBe(0);
    expect(view.screenState.label).toBe(CHECKLIST_COPY.en.scrEmpty);
  });
});

describe('permission gating (P-04 least privilege)', () => {
  it('a user without read permission sees a not-permitted state and no checklists', () => {
    const view = session(data({ checklists: [list({ checklistId: 'C-1' })] }), { mayRead: () => false }).view('en');
    expect(view.checklists).toHaveLength(0);
    expect(view.screenState.label).toBe(CHECKLIST_COPY.en.stateNotPermitted);
  });

  it('a reader without manage permission sees the checklists but is not offered the sign action', () => {
    const view = session(data({ checklists: [list({ checklistId: 'C-1', items: [item({ itemId: 'e', done: false, blocking: true })] })] }), { mayManage: () => false }).view('en');
    expect(view.checklists).toHaveLength(1);
    expect(view.mayManage).toBe(false);
  });

  it('flags when the box was not told who is at the screen', () => {
    expect(session(data(), {}, null).view('en').nobodyNamed).toBe(true);
    expect(session(data(), {}, 'u-manager').view('en').nobodyNamed).toBe(false);
  });
});

describe('signing is a human write, gated and checked before any POST (§28/P-04/P-05)', () => {
  const filled = () => data({
    checklists: [list({
      checklistId: 'C-close', kind: 'closing',
      items: [item({ itemId: 'safe', description: 'lock the safe', done: false, blocking: true }), item({ itemId: 'lights', done: true })],
    })],
  });

  it('ticks the given items done and signs in the manager\'s name, then POSTs', async () => {
    const calls: { checklistId: string; signedBy: string; items: readonly ChecklistItem[] }[] = [];
    const s = session(filled(), { submitPort: () => ({ post: async (i) => { calls.push(i); return 'recorded'; } }) });
    const out = await s.submit('C-close', ['safe'], true);
    expect(out).toBe('recorded');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.checklistId).toBe('C-close');
    expect(calls[0]!.signedBy).toBe('u-manager');
    // The ticked item is now done; the already-done one stays done.
    expect(calls[0]!.items.find((i) => i.itemId === 'safe')!.done).toBe(true);
    expect(calls[0]!.items.find((i) => i.itemId === 'lights')!.done).toBe(true);
  });

  it('never un-ticks an item a shift already did (done stays done even if omitted)', async () => {
    const calls: { items: readonly ChecklistItem[] }[] = [];
    const s = session(filled(), { submitPort: () => ({ post: async (i) => { calls.push(i); return 'recorded'; } }) });
    await s.submit('C-close', ['safe'], true); // 'lights' omitted from the ticked set
    expect(calls[0]!.items.find((i) => i.itemId === 'lights')!.done).toBe(true);
  });

  it('refuses without the manage permission, before any POST', async () => {
    let posted = false;
    const s = session(filled(), { mayManage: () => false, submitPort: () => ({ post: async () => { posted = true; return 'recorded'; } }) });
    expect(await s.submit('C-close', ['safe'], true)).toBe('refused');
    expect(posted).toBe(false);
  });

  it('refuses to sign when the box was not told who is signing, before any POST', async () => {
    let posted = false;
    const s = session(filled(), { submitPort: () => ({ post: async () => { posted = true; return 'recorded'; } }) }, null);
    expect(await s.submit('C-close', ['safe'], true)).toBe('refused');
    expect(posted).toBe(false);
  });

  it('refuses a checklist the box does not hold, before any POST', async () => {
    let posted = false;
    const s = session(filled(), { submitPort: () => ({ post: async () => { posted = true; return 'recorded'; } }) });
    expect(await s.submit('C-nope', ['safe'], true)).toBe('refused');
    expect(posted).toBe(false);
  });

  it('surfaces a lost link honestly (P-08), not a false recorded', async () => {
    const s = session(filled(), { submitPort: () => ({ post: async () => 'lost_link' as SubmitResult }) });
    const out = await s.submit('C-close', ['safe'], true);
    expect(out).toBe('lost_link');
    expect(s.presentSubmitResult('en', out).needsAttention).toBe(true);
  });

  it('presents each outcome as one glanceable status', () => {
    const s = session(filled());
    expect(s.presentSubmitResult('en', 'recorded').tone).toBe('ok');
    expect(s.presentSubmitResult('en', 'refused').tone).toBe('error');
    expect(s.presentSubmitResult('en', 'lost_link').tone).toBe('degraded');
  });
});
