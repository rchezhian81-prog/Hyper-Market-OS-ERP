import { describe, it, expect } from 'vitest';
import { blockingOpen, checklistBodiesOf, dayTheBoxCloses, foldClosingChecklist, tickRecord, cutoffWords } from '../../edge/store-edge/src/closing-checklist';
import { createManagerSession, BLOCKER_KINDS, blockerSentence, disconnectedPorts } from '../../apps/web-erp/src/manager-session';
import { makeTradingDayRule } from '../../packages/calendar/src/trading-day';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/ledger';
import { SyncOutbox } from '../../packages/sync/src/outbox';

/**
 * Fix batch 3 (D-008 · D-011 · D-012): the store rules' closing checklist folded with the ticks the store computer recorded
 * — one source for Today, the Checklists page and the day close — and the day the box closes named by one rule.
 */
const RULES = [
  { itemId: 'safe', description: 'Lock the cash safe', done: false, blocking: true },
  { itemId: 'lights', description: 'Switch off the lights', done: false, blocking: false },
];

describe('the closing checklist on the store computer (fix batch 3)', () => {
  it('the box closes the most recently ENDED trading day — the day before the running one', () => {
    expect(dayTheBoxCloses('2026-11-15')).toBe('2026-11-14');
    expect(dayTheBoxCloses('2026-03-01')).toBe('2026-02-28');
    expect(cutoffWords(0)).toBe('00:00');
    expect(cutoffWords(150)).toBe('02:30');
  });

  it('an item is done only by a tick for THAT day; the first tick names who did it; nothing else is read as a tick', () => {
    const tick = tickRecord(foldClosingChecklist(RULES, undefined, '2026-11-14'), 'safe', 'u-mgr', '2026-11-14T21:00:00Z', 'S1');
    const later = tickRecord(foldClosingChecklist(RULES, [tick], '2026-11-14'), 'safe', 'u-other', '2026-11-14T22:00:00Z', 'S1');
    const bodies = checklistBodiesOf([
      { completionKind: 'checklist', completionId: '2026-11-14-closing~safe', body: tick },
      { completionKind: 'checklist', body: later },
      { completionKind: 'task', body: { checklistId: '2026-11-14-closing', items: [{ itemId: 'lights', done: true }] } },
      'not json at all',
    ]);
    const day = foldClosingChecklist(RULES, bodies, '2026-11-14');
    expect(day.checklistId).toBe('2026-11-14-closing');
    expect(day.items.find((i) => i.itemId === 'safe')).toEqual(expect.objectContaining({ done: true, doneBy: 'u-mgr' }));
    expect(day.items.find((i) => i.itemId === 'lights')?.done).toBe(false);
    expect(blockingOpen(day)).toEqual([]);
    // Another day's checklist is untouched by those ticks.
    expect(blockingOpen(foldClosingChecklist(RULES, bodies, '2026-11-15')).map((i) => i.itemId)).toEqual(['safe']);
  });
});

describe('the manager screen holds the close on an open closing-checklist item (D-011)', () => {
  const session = (open: readonly { id: string; what: string }[]) => createManagerSession(
    {
      storeId: 'S1', branchId: 'S1', tradingDay: '2026-11-15', tradingDayRule: makeTradingDayRule('00:00'),
      manager: { userId: 'u-mgr', branchScope: ['S1'], authorityLimit: null }, currency: 'INR', warehouseId: 'S1',
    },
    {
      ...disconnectedPorts('n/a'),
      openExceptions: () => ({ known: true, items: [] }), unsentItems: () => ({ known: true, items: [] }), tasks: () => ({ known: true, items: [] }),
      approvals: () => ({ known: true, requests: [] }),
      closingChecklist: () => ({ known: true, items: open }),
      requestDayClose: async () => ({ closed: true, tradingDay: '2026-11-14' }),
    },
    new Ledger(new InMemoryLedgerStore()),
    new SyncOutbox(),
  );

  it('lists each open blocking item, and has words for the new kind', () => {
    const blockers = session([{ id: 'safe', what: 'Lock the cash safe' }]).blockersForClose('2026-11-15T22:48');
    expect(blockers).toEqual([expect.objectContaining({ kind: 'checklist_open', count: 1, items: [{ id: 'safe', what: 'Lock the cash safe' }] })]);
    expect(BLOCKER_KINDS).toContain('checklist_open');
    expect(blockerSentence(blockers[0]!)).toBe('1 closing-checklist item(s) must be done before the day closes and are not done.');
  });

  it('nothing open, nothing held', () => {
    expect(session([]).blockersForClose('2026-11-15T22:48')).toEqual([]);
  });
});
