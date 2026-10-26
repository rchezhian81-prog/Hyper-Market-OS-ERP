import { describe, it, expect } from 'vitest';
import { journalBodyProblem, financeRoutes, type FinanceDeps } from '../../services/finance/src/index';
import type { RequestContext } from '../../services/kernel/src/index';

// P-08: an empty, malformed or half-sent journal or period-close body is a NAMED refusal (400), never a 500.

const good = { entryId: 'j-1', period: '2026-09', documentDate: '2026-09-12', narrative: 'synthetic accrual for rent', lines: [{ accountCode: 'rent', debitMinor: 100, creditMinor: 0 }, { accountCode: 'cash', debitMinor: 0, creditMinor: 100 }] };

describe('the journal body is read before any rule uses it (P-08)', () => {
  it('a readable journal has no problem; every unreadable shape says what is wrong', () => {
    expect(journalBodyProblem(good)).toBeUndefined();
    expect(journalBodyProblem({ ...good, postedBy: 'u-acct' })).toBeUndefined();
    for (const bad of [undefined, null, [], 'text', 7]) expect(journalBodyProblem(bad)).toMatch(/not a journal/);
    expect(journalBodyProblem({})).toMatch(/entryId, period \(YYYY-MM\), documentDate \(YYYY-MM-DD\), narrative/);
    expect(journalBodyProblem({ ...good, period: '2026-13' })).toMatch(/period/);
    expect(journalBodyProblem({ ...good, lines: 'x' })).toMatch(/at least two/);
    expect(journalBodyProblem({ ...good, lines: [good.lines[0]] })).toMatch(/at least two/);
    expect(journalBodyProblem({ ...good, lines: [good.lines[0], {}] })).toMatch(/line 2/);
    expect(journalBodyProblem({ ...good, lines: [good.lines[0], { accountCode: 'cash', debitMinor: -1, creditMinor: 0 }] })).toMatch(/line 2/);
    expect(journalBodyProblem({ ...good, postedBy: 5 })).toMatch(/postedBy/);
  });

  it('the routes refuse by name before reading the store: a journal, a period that is not a month, a body that is not an object', async () => {
    const touched: string[] = [];
    const deps = {
      periodStates: () => { touched.push('periodStates'); return new Map(); }, nextOpenPeriod: () => '2026-10', appendJournal: () => { touched.push('append'); },
      controlTotals: () => { touched.push('controlTotals'); return []; }, postersIn: () => [], markClosed: () => {}, markReopened: () => {}, now: () => '2026-10-26T00:00:00Z',
    } as unknown as FinanceDeps;
    const routes = financeRoutes(deps);
    const run = async (path: string, params: Record<string, string>, body: unknown) => {
      try {
        await routes.find((r) => r.method === 'POST' && r.path === path)!.handler({ tenantId: 'T', userId: 'u', branchId: null, scope: 'all', params, query: {}, body, traceId: 't', idempotencyKey: 'k' } as RequestContext);
        return 'accepted';
      } catch (e) { return `${(e as { status?: number }).status} ${(e as { body?: { code?: string } }).body?.code}`; }
    };
    for (const body of [undefined, null, {}, [], 'text']) expect(await run('/v1/finance/journals', {}, body)).toBe('400 not_readable_as_a_journal');
    expect(await run('/v1/finance/periods/:period/close', { period: 'p08-x' }, {})).toBe('400 not_a_period');
    expect(await run('/v1/finance/periods/:period/close', { period: '2026-09' }, [])).toBe('400 not_readable_as_a_request');
    expect(await run('/v1/finance/periods/:period/close', { period: '2026-09' }, 'text')).toBe('400 not_readable_as_a_request');
    expect(touched).toEqual([]);
    // An empty body on a real month reaches the close rules and is refused by THEIR name (nothing was checked), never 500.
    expect(await run('/v1/finance/periods/:period/close', { period: '2026-09' }, {})).toBe('422 nothing_was_checked');
  });
});
