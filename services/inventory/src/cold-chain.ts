// API-04 Cold-chain assessment (M10-FR-02) — the food-safety verdict on a perishable batch, run on the
// tested `packages/quality` engine. A hypermarket lives or dies on its chilled/frozen/dairy/meat, and the
// rule is subtle: **duration counts as much as peak** (a freezer door open ninety seconds is not a breach;
// four hours is), and a cold-chain batch with **no reading at all fails rather than passes** — an
// unmeasured cold chain is an unproven one. A breach quarantines **automatically**, not as a warning
// somebody weighs while unloading.
//
// Deliberately STATELESS and deliberately NOT a second store of temperatures. `services/platform`'s
// facilities-monitoring already holds equipment readings — one temperature truth, not two (P-02). This
// endpoint takes the batch's readings and the product's cold-chain rule (both held by the caller) and
// returns the verdict; it wires the engine that nothing on the cloud could reach.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { assessColdChain, type ColdChainRule, type TemperatureReading } from '../../../packages/quality/src/index';

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

export function coldChainRoutes(): readonly Route[] {
  return [
    {
      // A read masquerading as POST because the readings are an array — idempotent, writes nothing.
      api: 'API-04', method: 'POST', path: '/v1/quality/cold-chain/assess',
      permission: 'quality.coldchain.assess', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const rule = (b['rule'] ?? {}) as Record<string, unknown>;
        if (typeof b['batchId'] !== 'string' || typeof b['productId'] !== 'string' || !isInt(rule['minTenthsC']) || !isInt(rule['maxTenthsC']) || !isInt(rule['graceMinutes'])) {
          throw apiError(400, {
            code: 'coldchain_needs_batch_and_rule',
            whatHappened: 'A cold-chain assessment needs batchId, productId and a rule (minTenthsC, maxTenthsC, graceMinutes — integer tenths of a degree and minutes).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the batch, its product and that product’s cold-chain rule with the batch’s temperature readings.',
          });
        }
        if ((rule['minTenthsC'] as number) > (rule['maxTenthsC'] as number)) {
          throw apiError(400, { code: 'coldchain_rule_inverted', whatHappened: 'The rule’s minTenthsC is above its maxTenthsC.', wasItSaved: 'not_saved', nextSafeAction: 'Send min ≤ max (tenths of a degree).' });
        }
        const readings = Array.isArray(b['readings']) ? (b['readings'] as TemperatureReading[]) : [];
        const coldRule: ColdChainRule = {
          productId: b['productId'] as string,
          minTenthsC: rule['minTenthsC'] as number,
          maxTenthsC: rule['maxTenthsC'] as number,
          graceMinutes: rule['graceMinutes'] as number,
        };
        const assessment = assessColdChain({ batchId: b['batchId'] as string, productId: b['productId'] as string, rule: coldRule, readings });
        // 200, not 201 — nothing was created; the automatic quarantine is on the verdict itself.
        return { status: 200, body: assessment };
      },
    },
  ];
}
