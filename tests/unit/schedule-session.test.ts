import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createScheduleSession, SCHEDULE_COPY } from '../../apps/web-erp/src/schedule-session';

/** D-9 (R3): the Staff schedule page's session, and the guardrails "cost is reported, not capped" and "a manager commits". */
describe('D-9 schedule session', () => {
  const seen: { method: string; url: string }[] = [];
  const fakeFetch = (async (url: string, init?: { method?: string }) => { seen.push({ method: init?.method ?? 'GET', url }); return new Response(JSON.stringify({ ok: true }), { status: 200 }); }) as unknown as typeof fetch;
  it('refuses the cheap things before sending, and writes nothing on open', async () => {
    const s = createScheduleSession({ viewer: { userId: 'u-mgr', permissions: ['workforce.roster.read', 'workforce.schedule.draft'] }, fetch: fakeFetch });
    expect(seen).toEqual([]);
    expect(await s.demand('S1', '2026-10-06')).toEqual({ result: 'invalid', why: 'notMonday' });
    expect(await s.demand('', '2026-10-05')).toEqual({ result: 'invalid', why: 'needAll' });
    expect(await s.commit('d-1')).toEqual({ result: 'invalid', why: 'cannotCommit' }); // no workforce.roster.manage
    expect(seen).toEqual([]);
    await s.demand('S1', '2026-10-05');
    expect(seen).toEqual([{ method: 'GET', url: '/v1/hr/workforce/labour-demand?branchId=S1&weekStart=2026-10-05' }]);
    expect(await createScheduleSession({ viewer: undefined, fetch: fakeFetch }).demand('S1', '2026-10-05')).toEqual({ result: 'invalid', why: 'nobody' });
  });
  it('every English word has a Tamil twin', () => {
    expect(Object.keys(SCHEDULE_COPY.ta).sort()).toEqual(Object.keys(SCHEDULE_COPY.en).sort());
  });
});

describe('D-9 guardrails', () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  it('labour cost never refuses or trims a roster (OB-142: reported, not capped)', () => {
    const engine = strip(readFileSync('packages/workforce/src/schedule.ts', 'utf8'));
    expect(engine).toContain('capped: false');
    expect(engine).not.toMatch(/costMinor\s*[><]=?|budget|knownMinor\s*[><]/);
    const store = strip(readFileSync('services/finance/src/schedule-store.ts', 'utf8'));
    expect(store).not.toMatch(/cost\.knownMinor\s*[><]|budget/);
  });
  it('only the commit route writes the roster, and it needs workforce.roster.manage (P-05)', () => {
    const store = strip(readFileSync('services/finance/src/schedule-store.ts', 'utf8'));
    expect(store).toMatch(/schedule-drafts\/:draftId\/commit',\s*permission: 'workforce\.roster\.manage'/);
    const writes = [...store.matchAll(/deps\.put(Shift|Assignment)\(/g)].length;
    expect(writes).toBe(2);
    const commitAt = store.indexOf("schedule-drafts/:draftId/commit'");
    expect(store.indexOf('deps.putShift(')).toBeGreaterThan(commitAt);
  });
  it('the week is fixed Monday–Sunday: no week-start setting exists', () => {
    const store = strip(readFileSync('services/finance/src/schedule-store.ts', 'utf8'));
    expect(store).toContain('isRosterWeekStart(weekStart)');
    expect(store).not.toMatch(/weekStartsOn|week-start'/);
  });
});
