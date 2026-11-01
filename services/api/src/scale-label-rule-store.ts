// Scale-label rules (M03-FR-02 · OB-570 "A") — head office's durable register of them, on the shared append-only event
// store (hard rule #2): one `ScaleLabelRuleRecorded` event per set or withdrawal on `catalogue␟scale-label-rules`.
// Self-contained (it imports nothing from `adapters.ts`), so `adapters.ts` — the pack assembly reads the rules in force —
// and the route registration can both import it without an import cycle. Same unit separator as `adapters.ts` `streamName`.

import { makeEvent } from '../../../packages/contracts/src/event';
import { ConcurrencyConflictError, type EventStore } from '../../../packages/persistence/src/event-store';
import { activeScaleRules, sameScaleRule, type ScaleLabelRuleEvent } from '../../../packages/catalogue/src/scale-label-rules';
import type { EmbeddedBarcodeRule } from '../../../packages/catalogue/src/catalogue';

export const SCALE_LABEL_RULES_STREAM = ['catalogue', 'scale-label-rules'].join('\u001f');
const TYPE = 'ScaleLabelRuleRecorded';
/** One write guard for the whole register: every set and withdrawal bumps it, so any two racing changes cannot both land. */
const SCALE_LABEL_RULES_GUARD = 'scale-label-rules';

/** Field by field (PostgreSQL's jsonb keeps no key order): the same person's same change at the same moment. */
const sameChange = (a: ScaleLabelRuleEvent, b: ScaleLabelRuleEvent): boolean =>
  a.state === b.state && a.by === b.by && a.at === b.at && a.reason === b.reason && sameScaleRule(a.rule, b.rule);

export function scaleLabelRuleStore(input: { readonly store: EventStore }): {
  readonly history: (tenantId: string) => Promise<readonly ScaleLabelRuleEvent[]>;
  readonly registerVersion: (tenantId: string) => Promise<number>;
  readonly record: (tenantId: string, e: ScaleLabelRuleEvent, expectedVersion: number) => Promise<'recorded' | 'conflict'>;
  /** The rules in force, in prefix order — what the catalogue pack carries to every till. */
  readonly inForce: (tenantId: string) => Promise<readonly EmbeddedBarcodeRule[]>;
} {
  const history = async (tenantId: string): Promise<readonly ScaleLabelRuleEvent[]> =>
    (await input.store.readStream(tenantId, SCALE_LABEL_RULES_STREAM, { type: TYPE })).map((e) => e.event.payload as ScaleLabelRuleEvent);
  return {
    history,
    registerVersion: (tenantId) => input.store.guardVersion(tenantId, SCALE_LABEL_RULES_GUARD),
    record: async (tenantId, e, expectedVersion) => {
      try {
        const [landed] = await input.store.appendBatch(tenantId, [{ stream: SCALE_LABEL_RULES_STREAM, event: makeEvent({
          id: `scale-label-rule-${e.prefix}-v${e.version}`,
          type: TYPE,
          occurredAt: e.at,
          idempotencyKey: `scale-label-rule-${tenantId}-${e.prefix}-v${e.version}`,
          source: 'api/catalogue',
          payload: e,
        }) }], { guard: { key: SCALE_LABEL_RULES_GUARD, expectedVersion } });
        // The same prefix's same version already on the register: a true re-send only if it is this very change; another
        // person's change that took the version first is a conflict, never this writer's "saved".
        if (landed?.deduped === true && !sameChange(landed.record.event.payload as ScaleLabelRuleEvent, e)) return 'conflict';
        return 'recorded';
      } catch (err) {
        // One guard for the whole register: a racing change to the SAME prefix, or a racing rule whose prefix would overlap
        // this one, moved it — refused by name, never a second writer told "saved" over the first (hard rule #10).
        if (err instanceof ConcurrencyConflictError && err.key === SCALE_LABEL_RULES_GUARD) return 'conflict';
        throw err;
      }
    },
    inForce: async (tenantId) => activeScaleRules(await history(tenantId)),
  };
}
