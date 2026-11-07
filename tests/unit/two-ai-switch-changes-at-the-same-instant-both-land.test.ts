import { describe, it, expect } from 'vitest';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';
import { aiAdapter } from '../../services/api/src/ai-adapters';

/**
 * **Two different changes to the AI switches at the same instant both land — the second is the truth (hard rule #10,
 * P-08).**
 *
 * On 7 November 2026 the browser suite went red on `main` after #867 merged, with every other file green: the fixture
 * switched A06/A08/A10 on, the test switched A01/A02/A03 on as well a few milliseconds later, head office said 200 to
 * both — and A01 was still off. The record of the enabled set was keyed on the tenant and the MOMENT alone, so two
 * different lists written in the same millisecond (the test pins its clock, which moves in 20 ms steps) collapsed onto
 * one row: the second write was deduplicated as "the same change re-sent" and lost, with a 200 that said otherwise.
 * The budget's record was keyed the same way. A re-sent identical change must still collapse (a retry is not a second
 * change); a DIFFERENT change at the same moment must land.
 */
const AT = '2026-11-07T19:30:00.000Z';
const TENANT = '00000000-0000-4000-8000-00000000a1a1';

describe('two different AI switch changes at the same instant', () => {
  it('the second enabled list lands and is read back; an identical re-send still collapses', async () => {
    const store = new InMemoryEventStore();
    const ai = aiAdapter({ store, now: () => AT });
    await ai.setEnabledAgents(TENANT, ['A06', 'A08', 'A10'], 'u-owner', AT);
    await ai.setEnabledAgents(TENANT, ['A01', 'A02', 'A03', 'A06', 'A08', 'A10'], 'u-owner', AT);
    expect([...(await ai.enabledAgents(TENANT))].sort()).toEqual(['A01', 'A02', 'A03', 'A06', 'A08', 'A10']);
    // The same list sent again at the same moment (a retry) is one record, not two.
    await ai.setEnabledAgents(TENANT, ['A01', 'A02', 'A03', 'A06', 'A08', 'A10'], 'u-owner', AT);
    const rows = await store.readStream(TENANT, 'ai', { type: 'AiAgentsEnabled' });
    expect(rows).toHaveLength(2);
  });

  it('the second budget lands and is read back', async () => {
    const store = new InMemoryEventStore();
    const ai = aiAdapter({ store, now: () => AT });
    await ai.setBudget(TENANT, { capMinor: 50_000, periodEnds: '2099-01-31T18:29:00.000Z' }, 'u-owner', AT);
    await ai.setBudget(TENANT, { capMinor: 100_000, periodEnds: '2099-01-31T18:29:00.000Z' }, 'u-owner', AT);
    expect((await ai.budget(TENANT)).capMinor).toBe(100_000);
  });
});
