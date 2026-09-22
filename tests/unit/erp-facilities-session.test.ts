import { describe, it, expect } from 'vitest';
import {
  createFacilitiesSession, FACILITIES_COPY, COPY_KEYS,
  type FacilitiesPorts, type FacilitiesData, type OverdueTask, type CompleteResult,
} from '../../apps/web-erp/src/facilities-session';
import { bilingualGaps } from '../../packages/ui/src/index';

/**
 * The facilities maintenance & compliance session model (M26-FR-03, API-11, §28, P-03/P-04/P-05/P-08).
 *
 * The rules live here, DOM-free: worst-first ordering with a compliance risk shouting loudest, a word beside
 * every colour, a completion that refuses locally before any POST without the record permission / a named user /
 * a task the board holds, and the completion POSTed in the completer's own name with any evidence + second
 * verifier attached (the server re-checks and refuses a self-verified safety check — §28).
 */

const task = (over: Partial<OverdueTask> & Pick<OverdueTask, 'taskId'>): OverdueTask => ({
  scheduleId: `s-${over.taskId}`, title: `Check ${over.taskId}`, category: 'cleaning',
  dueOn: '2026-09-20', daysOverdue: 2, level: 'overdue', complianceLinked: false,
  detail: `"Check ${over.taskId}" is 2 day(s) late`, ...over,
});

const board: FacilitiesData = {
  overdue: [
    task({ taskId: 't-clean', level: 'overdue', category: 'cleaning', complianceLinked: false, daysOverdue: 2 }),
    task({ taskId: 't-fire', level: 'compliance_risk', category: 'fire_safety', complianceLinked: true, daysOverdue: 9, escalateTo: 'owner', detail: '"Fire check" is 9 day(s) overdue and a regulator would care — escalated to owner' }),
    task({ taskId: 't-due', level: 'due', category: 'maintenance', complianceLinked: false, daysOverdue: 0, detail: '"AC service" is due today' }),
  ],
};

let lastPost: Parameters<ReturnType<FacilitiesPorts['completePort']>['post']>[0] | undefined;

const session = (ports: Partial<FacilitiesPorts> = {}, userId: string | null = 'u-fm') => {
  lastPost = undefined;
  return createFacilitiesSession({ userId }, {
    worklist: () => board, mayRead: () => true, mayComplete: () => true,
    completePort: () => ({ post: async (input) => { lastPost = input; return 'completed' as CompleteResult; } }),
    ...ports,
  });
};

describe('the facilities copy is complete in both languages', () => {
  it('has no gap in either language across the whole vocabulary', () => {
    const gaps = bilingualGaps(FACILITIES_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });

  it('tripwire — the detector fires on a key that is genuinely absent', () => {
    const holey = { en: { ...FACILITIES_COPY.en }, ta: { ...FACILITIES_COPY.ta, scrReady: '' } };
    expect(bilingualGaps(holey, COPY_KEYS).ta).toContain('scrReady');
  });
});

describe('the overdue list reads worst-first, with a word beside every colour', () => {
  it('a compliance risk comes first as an error tone; a due-today task last as idle', () => {
    const view = session().view('en');
    expect(view.tasks.map((t) => t.taskId)).toEqual(['t-fire', 't-clean', 't-due']);
    const fire = view.tasks[0]!;
    expect(fire.status.tone).toBe('error');
    expect(fire.severityWord).toBe(FACILITIES_COPY.en.complianceWord);
    expect(fire.status.icon.trim().length).toBeGreaterThan(0);
    expect(fire.needsAttention).toBe(true);
    expect(fire.escalateTo).toBe('owner');
    expect(view.tasks[1]!.status.tone).toBe('degraded'); // plain overdue
    expect(view.tasks[2]!.status.tone).toBe('idle'); // due today
    expect(view.tasks[2]!.lateWord).toBe(FACILITIES_COPY.en.dueTodayText);
  });

  it('counts the overdue tasks and the compliance risks the manager acts on first', () => {
    const view = session().view('en');
    expect(view.overdueCount).toBe(3);
    expect(view.complianceRiskCount).toBe(1);
  });

  it('a task that is not escalated carries no escalate-to name', () => {
    const view = session().view('en');
    expect(view.tasks.find((t) => t.taskId === 't-clean')!.escalateTo).toBeNull();
  });

  it('renders the category and lateness in words, in Tamil too', () => {
    const view = session().view('ta');
    const fire = view.tasks[0]!;
    expect(fire.categoryWord).toBe(FACILITIES_COPY.ta.catFireSafety);
    expect(fire.lateWord).toBe(`9 ${FACILITIES_COPY.ta.daysLateText}`);
  });
});

describe('a viewer without the record permission is offered no completion', () => {
  it('the view withholds mayComplete, and the model refuses even if called', async () => {
    const noPerm = session({ mayComplete: () => false });
    expect(noPerm.view('en').mayComplete).toBe(false);
    expect(await noPerm.complete('t-fire')).toBe('refused');
    expect(lastPost, 'no POST may be attempted without the permission').toBeUndefined();
  });

  it('but such a viewer can still SEE the overdue list', () => {
    expect(session({ mayComplete: () => false }).view('en').tasks.length).toBe(3);
  });
});

describe('completion refuses locally before any POST, then reaches the port in the completer name', () => {
  it('a box never told who is at the screen records nothing', async () => {
    const s = session({}, null);
    expect(s.view('en').nobodyNamed).toBe(true);
    expect(await s.complete('t-fire')).toBe('refused');
    expect(lastPost).toBeUndefined();
  });

  it('a task the board does not hold is refused locally', async () => {
    expect(await session().complete('t-nope')).toBe('refused');
    expect(lastPost).toBeUndefined();
  });

  it('a permitted manager marking a held task done reaches the port with their own name + evidence + verifier', async () => {
    const s = session();
    expect(await s.complete('t-fire', { evidenceRef: 'photo-123', verifiedBy: 'u-manager', note: '  extinguisher swapped  ' })).toBe('completed');
    expect(lastPost).toEqual({ taskId: 't-fire', completedBy: 'u-fm', evidenceRefs: ['photo-123'], verifiedBy: 'u-manager', note: 'extinguisher swapped' });
  });

  it('omits empty optional fields rather than sending blanks', async () => {
    await session().complete('t-clean', { evidenceRef: '   ', verifiedBy: '' });
    expect(lastPost).toEqual({ taskId: 't-clean', completedBy: 'u-fm' });
  });

  it('surfaces a server refusal (no evidence / self-verified) and a lost link honestly', async () => {
    const refuse = session({ completePort: () => ({ post: async () => 'refused' as CompleteResult }) });
    expect(await refuse.complete('t-fire')).toBe('refused');
    const lost = session({ completePort: () => ({ post: async () => 'lost_link' as CompleteResult }) });
    expect(await lost.complete('t-fire')).toBe('lost_link');
  });
});

describe('the completion outcome presents as one glanceable status', () => {
  it('completed is ok, refused is error, a lost link is a degraded not-saved', () => {
    const s = session();
    expect(s.presentCompleteResult('en', 'completed').tone).toBe('ok');
    expect(s.presentCompleteResult('en', 'completed').needsAttention).toBe(false);
    expect(s.presentCompleteResult('en', 'refused').tone).toBe('error');
    expect(s.presentCompleteResult('en', 'lost_link').tone).toBe('degraded');
    expect(s.presentCompleteResult('en', 'lost_link').needsAttention).toBe(true);
  });
});

describe('an unpermitted-to-read viewer sees the not-permitted state, no list', () => {
  it('mayRead false yields the error screen state and no tasks', () => {
    const view = session({ mayRead: () => false }).view('en');
    expect(view.tasks).toEqual([]);
    expect(view.screenState.tone).toBe('error');
    expect(view.screenState.label).toBe(FACILITIES_COPY.en.stateNotPermitted);
  });
});
