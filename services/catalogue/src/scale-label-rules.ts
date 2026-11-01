// API-02 scale-label rules (M03-FR-02 "configure variable-weight barcode parsing" · OB-570 "A") — head office's register
// of how a weighing scale's label is read: the prefix, where the item code sits, where the weight (or price, or use-by
// date) sits. The rules in force ride the signed catalogue pack (`catalogue-preview.ts` `embeddedRules`), so every till
// reads a weight label and prices it with the network cable out (§31). The rules are the tested `scaleRuleProblems` in
// `@sre/catalogue`; an ambiguous pattern (a prefix equal to, or starting, another rule's) is refused by name.
//
//   GET  /v1/catalogue/scale-label-rules                    the rules in force, with who set each and when
//   POST /v1/catalogue/scale-label-rules/:prefix            { itemStart, itemLength, valueStart, valueLength, valueKind, reason? }
//   POST /v1/catalogue/scale-label-rules/:prefix/withdrawal { reason } — the prefix's rule stops (a reason is required,
//                                                           OB-574); a new event, never a delete
//
// Append-only (hard rule #2): setting a prefix that already has a rule is its next version; a re-send of the same rule is no
// new version. Positions are 0-based (what the till reads). Setting and withdrawing are `catalogue.pack.publish` — the
// permission the barcode register writes under, since a rule decides what the shop can scan; reading `catalogue.pack.read`.
// Every change is sealed in the audit trail.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import {
  scaleRuleProblems, activeScaleRuleEvents, activeScaleRules, lastScaleRuleVersion, sameScaleRule,
  type ScaleLabelRuleEvent,
} from '../../../packages/catalogue/src/scale-label-rules';
import type { EmbeddedBarcodeRule } from '../../../packages/catalogue/src/catalogue';

export interface ScaleLabelRuleDeps {
  /** Every event on the register, oldest first. */
  readonly history: (tenantId: string) => Promise<readonly ScaleLabelRuleEvent[]>;
  /**
   * The register's write version, read BEFORE `history` when a change is decided. `record` lands only while it still holds,
   * so two people changing rules at the same moment never both "succeed" (hard rule #10): the second is told, by name.
   */
  readonly registerVersion: (tenantId: string) => Promise<number>;
  /** 'conflict' when the register moved since `expectedVersion` was read — nothing was written. */
  readonly record: (tenantId: string, e: ScaleLabelRuleEvent, expectedVersion: number) => Promise<'recorded' | 'conflict'>;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

const reasonOf = (b: Record<string, unknown>): { reason?: string } =>
  typeof b['reason'] === 'string' && b['reason'].trim() !== '' ? { reason: b['reason'].trim() } : {};

/** The rule as the audit trail keeps it — flat text, readable on its own. */
const flat = (r: EmbeddedBarcodeRule): Record<string, string> => ({
  prefix: r.prefix, item: `${r.itemStart}+${r.itemLength}`, value: `${r.valueStart}+${r.valueLength}`, valueKind: r.valueKind,
});

/** Another change to the register landed between this one being read and written: refused, never silently dropped. */
const changedMeanwhile = (prefix: string): Error => apiError(409, {
  code: 'scale_label_rules_changed_meanwhile',
  whatHappened: `Someone else changed the scale-label rules while the change for prefix "${prefix}" was being made, so it was not applied over theirs.`,
  wasItSaved: 'not_saved',
  nextSafeAction: 'Reload the rules, check what is now in force, and make the change again if it is still needed. Nothing of this change was saved.',
});

export function scaleLabelRuleRoutes(deps: ScaleLabelRuleDeps): readonly Route[] {
  const audit = async (tenantId: string, ctx: { userId: string; branchId?: string | null }, e: ScaleLabelRuleEvent, before: ScaleLabelRuleEvent | undefined): Promise<void> => {
    await deps.recordAudit?.(tenantId, {
      actorId: ctx.userId, action: e.state === 'active' ? 'catalogue.scale_label_rule.set' : 'catalogue.scale_label_rule.withdraw',
      objectType: 'scale_label_rule', objectId: e.prefix, at: e.at,
      origin: { tenantId, branchId: ctx.branchId ?? null },
      before: before === undefined ? null : flat(before.rule),
      after: e.state === 'active' ? flat(e.rule) : null,
      ...(e.reason === undefined ? {} : { reason: e.reason }), correlationId: `scale-label-rule:${e.prefix}:v${e.version}`,
    });
  };
  return [
    {
      api: 'API-02', method: 'GET', path: '/v1/catalogue/scale-label-rules',
      permission: 'catalogue.pack.read',
      handler: async (ctx) => {
        const history = await deps.history(ctx.tenantId);
        const rules = activeScaleRuleEvents(history);
        return { status: 200, body: { rules, count: rules.length, asAt: deps.now() } };
      },
    },
    {
      api: 'API-02', method: 'POST', path: '/v1/catalogue/scale-label-rules/:prefix',
      permission: 'catalogue.pack.publish', idempotent: true,
      handler: async (ctx) => {
        const prefix = (ctx.params['prefix'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const num = (k: string): unknown => b[k];
        if (prefix === '' || ['itemStart', 'itemLength', 'valueStart', 'valueLength'].some((k) => typeof num(k) !== 'number') || typeof b['valueKind'] !== 'string') {
          throw apiError(400, {
            code: 'not_readable_as_a_scale_label_rule',
            whatHappened: 'A scale-label rule needs the label prefix in the path and { itemStart, itemLength, valueStart, valueLength, valueKind } in the body — where the item code and the value sit on the 13-digit label (counting from 0) and whether the value is a weight, a price or an expiry date.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the positions as numbers and valueKind as weight, price or expiry. Nothing was saved.',
          });
        }
        const rule: EmbeddedBarcodeRule = {
          prefix, itemStart: num('itemStart') as number, itemLength: num('itemLength') as number,
          valueStart: num('valueStart') as number, valueLength: num('valueLength') as number, valueKind: b['valueKind'] as EmbeddedBarcodeRule['valueKind'],
        };
        const version = await deps.registerVersion(ctx.tenantId); // read first: the write holds only while this does
        const history = await deps.history(ctx.tenantId);
        const problems = scaleRuleProblems(rule, activeScaleRules(history));
        if (problems.length > 0) {
          throw apiError(422, {
            code: problems[0]!.refusal,
            whatHappened: `The scale-label rule for prefix "${prefix}" cannot be set: ${problems.map((p) => p.detail).join('; ')}.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Correct the rule and send again. If another rule is in the way, withdraw it first. Nothing was saved.',
          });
        }
        const standing = activeScaleRuleEvents(history).find((e) => e.prefix === prefix);
        if (standing !== undefined && sameScaleRule(standing.rule, rule)) {
          return { status: 200, body: { rule: standing, unchanged: true } };
        }
        const event: ScaleLabelRuleEvent = {
          prefix, version: lastScaleRuleVersion(history, prefix) + 1, state: 'active', rule, ...reasonOf(b), by: ctx.userId, at: deps.now(),
        };
        if (await deps.record(ctx.tenantId, event, version) === 'conflict') throw changedMeanwhile(prefix);
        await audit(ctx.tenantId, ctx, event, standing);
        return { status: 201, body: { rule: event } };
      },
    },
    {
      api: 'API-02', method: 'POST', path: '/v1/catalogue/scale-label-rules/:prefix/withdrawal',
      permission: 'catalogue.pack.publish', idempotent: true,
      handler: async (ctx) => {
        const prefix = (ctx.params['prefix'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        // OB-574 (owner, 1 Nov 2026, "A"): stopping a rule always says why — so there is a written reason for taking a way
        // of reading labels away from every till. (Setting one may say why; it need not.)
        if (reasonOf(b).reason === undefined) {
          throw apiError(400, {
            code: 'withdrawal_reason_required',
            whatHappened: `The scale-label rule for prefix "${prefix}" was not stopped: stopping a rule needs a reason, and none was given.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send { reason } saying why the tills should stop reading these labels. Nothing was changed.',
          });
        }
        const version = await deps.registerVersion(ctx.tenantId);
        const history = await deps.history(ctx.tenantId);
        const standing = activeScaleRuleEvents(history).find((e) => e.prefix === prefix);
        if (standing === undefined) throw notFound(`scale-label rule in force for prefix ${prefix}`);
        const event: ScaleLabelRuleEvent = {
          prefix, version: lastScaleRuleVersion(history, prefix) + 1, state: 'withdrawn', rule: standing.rule, ...reasonOf(b), by: ctx.userId, at: deps.now(),
        };
        if (await deps.record(ctx.tenantId, event, version) === 'conflict') throw changedMeanwhile(prefix);
        await audit(ctx.tenantId, ctx, event, standing);
        return { status: 201, body: { rule: event } };
      },
    },
  ];
}
