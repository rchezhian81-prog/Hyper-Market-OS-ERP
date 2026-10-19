// D-18 (R4, OB-216) — competitor prices draft a price change for a person to approve; nothing here changes a price.
//
//   GET  /v1/prices/competitor-rule              the gap and the sighting age in force (the owner's, else OB-216's 5% / 14 days)
//   POST /v1/prices/competitor-rule              the owner changes them — a new version, the old ones kept (hard rule #2)
//   GET  /v1/prices/competitor-drafts?storeId=   each product whose competitor is far enough below, freshly seen, drafted to
//                                                the competitor's price within MRP, cost and the store's margin floor — and
//                                                every product NOT drafted, by name ("sighting too old", "draft refused:
//                                                below margin floor", MRP / cost / floor not known)
//
// The drafts are computed on read by the tested engine (`draftFromCompetitors`, packages/pricing/src/competitor-rule.ts)
// over what head office holds: the competitor sightings, the shop's own price at the store, the MRP in force on the product
// master, the store's average buying cost (OB-39) and the margin floor the owner set in the store's rules. The read writes
// nothing and every draft is `advisoryOnly`. A person commits a draft through the EXISTING price route
// (`POST /v1/prices/changes`), which judges it again against the MRP, the cost and the store's floor and asks for its
// second-person approval where the rules want one. No rule here — and no AI — makes or commits the change (hard rule #5).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import {
  COMPETITOR_RULE_DEFAULTS, competitorRuleProblem, draftFromCompetitors,
  type CompetitorRule, type ProductPriceFacts, type PriceDraft, type NotDrafted,
} from '../../../packages/pricing/src/competitor-rule';

export interface StoredCompetitorRule extends CompetitorRule {
  readonly version: number;
  readonly reason: string;
  readonly setBy: string;
  readonly setAt: string;
}

export interface CompetitorDraftDeps {
  readonly now: () => string;
  /** Every version of the owner's rule, oldest first. */
  readonly rules: (tenantId: string) => Promise<readonly StoredCompetitorRule[]>;
  readonly recordRule: (tenantId: string, rule: StoredCompetitorRule) => Promise<void>;
  /** What head office holds for each product a competitor was seen selling, at one store. Read only. */
  readonly productFacts: (tenantId: string, storeId: string) => Promise<readonly ProductPriceFacts[]>;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}

const COMMIT_VIA = 'POST /v1/prices/changes — a person, with the price route\'s MRP, cost and margin-floor checks and its approval';

export function competitorDraftRoutes(deps: CompetitorDraftDeps): readonly Route[] {
  const inForce = async (tenantId: string): Promise<{ rule: CompetitorRule; source: 'owner_setting' | 'owner_decision_OB-216'; version: number | null; setBy: string | null }> => {
    const last = (await deps.rules(tenantId)).at(-1);
    return last === undefined
      ? { rule: COMPETITOR_RULE_DEFAULTS, source: 'owner_decision_OB-216', version: null, setBy: null }
      : { rule: { gapBps: last.gapBps, maxAgeDays: last.maxAgeDays }, source: 'owner_setting', version: last.version, setBy: last.setBy };
  };
  return [
    {
      api: 'API-02', method: 'GET', path: '/v1/prices/competitor-rule',
      permission: 'price.change.propose',
      handler: async (ctx) => ({ status: 200, body: { ...(await inForce(ctx.tenantId)), history: await deps.rules(ctx.tenantId) } }),
    },
    {
      // The owner changes the gap or the age. Body: { gapBps, maxAgeDays, reason }. A new version; nothing is repriced.
      api: 'API-02', method: 'POST', path: '/v1/prices/competitor-rule',
      permission: 'price.change.approve', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const problem = competitorRuleProblem(b);
        if (problem !== undefined || typeof b['reason'] !== 'string' || b['reason'].trim() === '') {
          throw apiError(400, {
            code: 'not_readable_as_a_competitor_rule',
            whatHappened: `The competitor rule needs { gapBps, maxAgeDays, reason }: ${problem ?? 'a reason saying why it changes'}.`,
            wasItSaved: 'not_saved', nextSafeAction: 'Send the gap in basis points (500 = 5%), the age in days and a reason. Nothing was changed.',
          });
        }
        const prior = await deps.rules(ctx.tenantId);
        const last = prior.at(-1);
        if (last !== undefined && last.gapBps === b['gapBps'] && last.maxAgeDays === b['maxAgeDays']) {
          return { status: 200, body: { rule: last, alreadyInForce: true, pricesChanged: false } };
        }
        const rec: StoredCompetitorRule = {
          gapBps: b['gapBps'] as number, maxAgeDays: b['maxAgeDays'] as number, reason: (b['reason'] as string).trim(),
          version: (last?.version ?? 0) + 1, setBy: ctx.userId, setAt: deps.now(),
        };
        await deps.recordRule(ctx.tenantId, rec);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'pricing.competitor_rule.set', objectType: 'competitor_rule', objectId: `v${rec.version}`, at: rec.setAt,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: last === undefined ? null : { gapBps: String(last.gapBps), maxAgeDays: String(last.maxAgeDays) },
          after: { gapBps: String(rec.gapBps), maxAgeDays: String(rec.maxAgeDays) }, reason: rec.reason, correlationId: `competitor-rule-v${rec.version}`,
        });
        return { status: 201, body: { rule: rec, pricesChanged: false } };
      },
    },
    {
      // The drafts for a store. Read-only: it records nothing and changes no price.
      api: 'API-02', method: 'GET', path: '/v1/prices/competitor-drafts',
      permission: 'price.change.propose',
      handler: async (ctx) => {
        const storeId = (ctx.query['storeId'] ?? '').trim();
        if (storeId === '') {
          throw apiError(400, { code: 'store_required', whatHappened: 'Competitor drafts are per store: send ?storeId=….', wasItSaved: 'not_saved', nextSafeAction: 'Name the store. Nothing was changed; this only reads.' });
        }
        const now = deps.now();
        const { rule, source, version } = await inForce(ctx.tenantId);
        const drafts: PriceDraft[] = [];
        const notDrafted: NotDrafted[] = [];
        for (const facts of await deps.productFacts(ctx.tenantId, storeId)) {
          const out = draftFromCompetitors(facts, rule, now);
          if (out.draft !== undefined) drafts.push(out.draft);
          notDrafted.push(...out.notDrafted);
        }
        return {
          status: 200,
          body: {
            storeId, asAt: now, rule: { ...rule, source, version },
            drafts: drafts.map((d) => ({ ...d, advisoryOnly: true, commitVia: COMMIT_VIA })),
            notDrafted, advisoryOnly: true, pricesChanged: false, decidedBy: 'nobody — a person commits a draft on the price route',
          },
        };
      },
    },
  ];
}
