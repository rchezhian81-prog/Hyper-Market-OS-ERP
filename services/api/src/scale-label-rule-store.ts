// Scale-label rules (M03-FR-02 · OB-570 "A") — head office's durable register of them, on the shared append-only event
// store (hard rule #2): one `ScaleLabelRuleRecorded` event per set or withdrawal on `catalogue␟scale-label-rules`.
// Self-contained (it imports nothing from `adapters.ts`), so `adapters.ts` — the pack assembly reads the rules in force —
// and the route registration can both import it without an import cycle. Same unit separator as `adapters.ts` `streamName`.

import { makeEvent } from '../../../packages/contracts/src/event';
import type { EventStore } from '../../../packages/persistence/src/event-store';
import { activeScaleRules, type ScaleLabelRuleEvent } from '../../../packages/catalogue/src/scale-label-rules';
import type { EmbeddedBarcodeRule } from '../../../packages/catalogue/src/catalogue';

export const SCALE_LABEL_RULES_STREAM = ['catalogue', 'scale-label-rules'].join('\u001f');
const TYPE = 'ScaleLabelRuleRecorded';

export function scaleLabelRuleStore(input: { readonly store: EventStore }): {
  readonly history: (tenantId: string) => Promise<readonly ScaleLabelRuleEvent[]>;
  readonly record: (tenantId: string, e: ScaleLabelRuleEvent) => Promise<void>;
  /** The rules in force, in prefix order — what the catalogue pack carries to every till. */
  readonly inForce: (tenantId: string) => Promise<readonly EmbeddedBarcodeRule[]>;
} {
  const history = async (tenantId: string): Promise<readonly ScaleLabelRuleEvent[]> =>
    (await input.store.readStream(tenantId, SCALE_LABEL_RULES_STREAM, { type: TYPE })).map((e) => e.event.payload as ScaleLabelRuleEvent);
  return {
    history,
    record: async (tenantId, e) => {
      await input.store.append(tenantId, SCALE_LABEL_RULES_STREAM, makeEvent({
        id: `scale-label-rule-${e.prefix}-v${e.version}`,
        type: TYPE,
        occurredAt: e.at,
        // Version-scoped: two writers racing for the same next version land once, never as two versions.
        idempotencyKey: `scale-label-rule-${tenantId}-${e.prefix}-v${e.version}`,
        source: 'api/catalogue',
        payload: e,
      }));
    },
    inForce: async (tenantId) => activeScaleRules(await history(tenantId)),
  };
}
