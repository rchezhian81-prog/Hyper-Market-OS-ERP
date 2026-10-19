import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ApiHarness } from '../support/api-harness';
import { backings, openDatabase, closeDatabase, caller } from '../support/r4-lane1';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM } from '../../services/api/src/adapters';
import { assessShiftClose } from '../../packages/till/src/index';
import { createLpInboxSession, type LpWorklistData, type CloseResult } from '../../apps/web-erp/src/loss-prevention-inbox-session';

/**
 * **OB-235 (owner, 19 Oct 2026) — a material till cash shortage still opens a loss-prevention case automatically, and
 * every such case is marked "opened by rule" on the case record (the real API, in memory and on real PostgreSQL, with a
 * cold restart).** The Investigations screen shows it as a chip with an icon and a word, in English and Tamil, so
 * nobody reads it as a person accusing someone. A case a PERSON opened carries no such mark. A shortage case recorded
 * before the mark existed (opened by the same rule's system actor) reads as opened by rule too; nothing stored is
 * rewritten. Synthetic data only.
 */

beforeAll(openDatabase);
afterAll(closeDatabase);

/** A ₹1,000 short (material: tolerance ₹5) as the store box relays it, decided by the same rule. */
function shortClose(): Record<string, unknown> {
  const figures = { openingFloatMinor: 50_000, cashSalesMinor: 100_000, pickupsMinor: 30_000, cashRefundsMinor: 5_000, countedCashMinor: 114_000, toleranceMinor: 500 };
  const d = assessShiftClose({ ...figures, reasonCode: 'short' });
  const { countedCashMinor, ...rest } = figures;
  return {
    ...rest, tillId: 'T1', laneId: 'T1', cashierId: 'cashier-1', tradingDay: '2026-08-07', reasonCode: 'short',
    openedAt: '2026-08-07T03:00:00Z', closedAt: '2026-08-07T20:00:00Z',
    countedMinor: countedCashMinor, expectedMinor: d.expectedMinor, varianceMinor: d.varianceMinor, exceptionRaised: d.exceptionRaised,
  };
}

type Case = { caseId: string; openedBy: string; openedByRule?: boolean };

describe.each(backings())('a shortage case is marked "opened by rule" — on $name (OB-235)', ({ harness, restart }) => {
  it('the rule\'s case carries the mark on its record and on the worklist; a person\'s does not; the screen says it in both languages', async () => {
    let h: ApiHarness = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-sm', 'store_manager');
    const { req, ok } = caller(() => h, T);

    // A material short: the rule opens the case, as before.
    const closed = await ok(req('POST', '/v1/shifts/S1/close/synced', shortClose()), 'close short');
    expect((closed.body as { investigation: { opened: boolean; caseId: string } }).investigation).toMatchObject({ opened: true, caseId: 'shortage-S1' });
    // A person opens a case from a raised signal.
    await ok(req('POST', '/v1/loss-prevention/cases/c-person', { raisedFromRef: 'voidabuse:till-1', subjectRef: 'staff-9', summary: 'repeated post-void refunds (synthetic)', valueMinor: 50_000, assignedTo: 'u-sm' }), 'person opens');
    // A shortage case recorded before the mark existed — the old shape, the rule's system actor, no mark.
    await h.store.append(T, STREAM.lossPrevention, makeEvent({
      id: 'lp-case-open-shortage-OLD', type: 'LpCaseOpened', occurredAt: '2026-08-01T20:00:00.000Z', idempotencyKey: `lp-case-open-${T}-shortage-OLD`, source: 'test/legacy',
      payload: { caseId: 'shortage-OLD', tenantId: T, raisedFromRef: 'shift-shortage:OLD', subjectRef: 'cashier-2', summary: 'Till 2 closed short (synthetic, before OB-235)', valueMinor: 20_000, openedBy: 'system:till-shortage-rule', openedAt: '2026-08-01T20:00:00.000Z', assignedTo: 'u-sm', state: 'open', evidence: [] },
    }));

    // ── On the record: the rule's case carries the field; a person's does not ──────────────────────────────────────
    const stored = (await h.store.readStream(T, STREAM.lossPrevention, { type: 'LpCaseOpened' })).map((e) => e.event.payload as Case);
    expect(stored.find((c) => c.caseId === 'shortage-S1')).toMatchObject({ openedBy: 'system:till-shortage-rule', openedByRule: true });
    expect(stored.find((c) => c.caseId === 'c-person')!.openedByRule).toBeUndefined();
    expect(stored.find((c) => c.caseId === 'shortage-OLD')!.openedByRule).toBeUndefined(); // never rewritten

    // ── A COLD RESTART: the reads fold the same record ──────────────────────────────────────────────────────────────
    h = restart(h);
    expect(((await ok(req('GET', '/v1/loss-prevention/cases/shortage-S1'), 'rule case')).body as Case).openedByRule).toBe(true);
    expect(((await ok(req('GET', '/v1/loss-prevention/cases/shortage-OLD'), 'old rule case')).body as Case).openedByRule).toBe(true);
    expect(((await ok(req('GET', '/v1/loss-prevention/cases/c-person'), 'person case')).body as Case).openedByRule).toBeUndefined();
    const worklist = (await ok(req('GET', '/v1/loss-prevention/cases'), 'worklist')).body as LpWorklistData;
    const mark = Object.fromEntries(worklist.cases.map((c) => [c.caseId, c.openedByRule === true]));
    expect(mark).toEqual({ 'shortage-S1': true, 'shortage-OLD': true, 'c-person': false });

    // ── The Investigations screen's session over that worklist: a chip word in English and Tamil, only on the rule's ─
    const session = createLpInboxSession({ userId: 'u-sm' }, {
      worklist: () => worklist, mayRead: () => true, mayManage: () => true, closePort: () => ({ post: async () => 'closed' as CloseResult }),
    });
    const chips = (lang: 'en' | 'ta') => Object.fromEntries(session.view(lang).open.map((c) => [c.caseId, c.openedByRule?.label ?? null]));
    expect(chips('en')).toEqual({ 'shortage-S1': 'Opened by rule', 'shortage-OLD': 'Opened by rule', 'c-person': null });
    expect(chips('ta')).toEqual({ 'shortage-S1': 'விதியால் திறக்கப்பட்டது', 'shortage-OLD': 'விதியால் திறக்கப்பட்டது', 'c-person': null });
    expect(session.view('en').open.find((c) => c.caseId === 'shortage-S1')!.openedByRule!.say).toMatch(/no person has accused anyone/);
  });
});
