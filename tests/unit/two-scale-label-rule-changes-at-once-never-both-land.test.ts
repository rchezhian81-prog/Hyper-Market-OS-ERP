// OB-570 "A" · M03-FR-02 · hard rule #10: two people changing head office's scale-label rules at the same moment never both
// "succeed". Each change reads the register's write version before it decides; the store lands it only while that version
// still holds. A racing change to the SAME prefix (one would be silently swallowed as a duplicate) or a racing rule whose
// prefix overlaps (both would pass the ambiguity check and the till could read a label two ways) is refused by name — 409,
// nothing saved — never a second writer told "saved".

import { describe, it, expect } from 'vitest';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';
import { scaleLabelRuleStore } from '../../services/api/src/scale-label-rule-store';
import { scaleLabelRuleRoutes } from '../../services/catalogue/src/scale-label-rules';
import type { ScaleLabelRuleEvent } from '../../packages/catalogue/src/scale-label-rules';
import type { EmbeddedBarcodeRule } from '../../packages/catalogue/src/catalogue';

const T = 'tenant-a';
const rule = (prefix: string, itemStart = prefix.length): EmbeddedBarcodeRule => ({ prefix, itemStart, itemLength: 5, valueStart: 7, valueLength: 5, valueKind: 'weight' });
const ev = (r: EmbeddedBarcodeRule, by: string): ScaleLabelRuleEvent => ({ prefix: r.prefix, version: 1, state: 'active', rule: r, by, at: '2026-11-01T09:00:00.000Z' });

describe('two scale-label rule changes at once never both land', () => {
  it('the store: two writers who read the same register version — the first lands, the second is a conflict, nothing of it kept', async () => {
    const store = scaleLabelRuleStore({ store: new InMemoryEventStore() });
    const seen = await store.registerVersion(T);
    expect(await store.record(T, ev(rule('2'), 'u-asha'), seen)).toBe('recorded');
    expect(await store.record(T, ev({ ...rule('2'), valueLength: 4 }, 'u-ravi'), seen)).toBe('conflict'); // same prefix
    expect(await store.record(T, ev(rule('21'), 'u-ravi'), seen)).toBe('conflict'); // an overlapping prefix
    expect((await store.history(T)).map((e) => [e.prefix, e.by])).toEqual([['2', 'u-asha']]);
    expect(await store.inForce(T)).toEqual([rule('2')]);
    // A writer who reads afresh is not blocked.
    expect(await store.record(T, { ...ev(rule('3'), 'u-ravi') }, await store.registerVersion(T))).toBe('recorded');
  });

  it('the route: a change that loses the race is refused 409 by name, with "not saved"', async () => {
    const routes = scaleLabelRuleRoutes({
      history: async () => [], registerVersion: async () => 0, record: async () => 'conflict', now: () => '2026-11-01T09:00:00.000Z',
    });
    const set = routes.find((r) => r.method === 'POST' && r.path === '/v1/catalogue/scale-label-rules/:prefix')!;
    const ctx = { tenantId: T, userId: 'u-ravi', params: { prefix: '2' }, body: { itemStart: 1, itemLength: 6, valueStart: 7, valueLength: 5, valueKind: 'weight' } };
    await expect(set.handler(ctx as never)).rejects.toMatchObject({ status: 409, body: { code: 'scale_label_rules_changed_meanwhile', wasItSaved: 'not_saved' } });
  });
});
