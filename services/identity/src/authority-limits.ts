// The owner's approval rules on head office's server (M02-FR-02 · M02-FR-03 · M05-FR-01 · M01-FR-03 · §28 · P-04 · P-08 ·
// owner decisions OB-290, OB-291, OB-292 of 23 Oct 2026).
//
// Three rules, each held centrally as a versioned value in `config_versions` (append-only — a change is a new version, a
// rollback restores an older value as a new version, nothing is overwritten):
//
//   • `limits`            — how much each role may approve per kind (refund, purchase order, stock adjustment);
//   • `escalation-waits`  — how long an approval of each kind may wait before it goes to the owner;
//   • `price-check`       — the size of price change (more than N% or more than ₹N a unit) that needs a second person.
//
// Until the owner changes one, the figures he decided on 23 Oct 2026 are in force (version 0, said so on every read).
// Every change goes through the maker-checker engine: the maker asks (`POST /v1/approvals/requests`, kind
// `approval_rule_change`, with exactly the change), the OWNER approves it in his own session, and the maker then applies it
// here naming the approval. Nobody changes a rule alone, and §28's "Store Manager … cannot modify … own approval limits"
// holds: a change that touches a role the maker holds is refused by name.
//
// `authorityOf(tenant, user, subjectType)` is the one answer every decide path reads — never a figure in a request body.
// A stored version that no longer reads as a valid rule (a bad write, an older format) is never believed: the rule holds at
// the last version that does, and every read says so (M01-FR-03 "a failed activation auto-holds at the last-known-good").

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import type { ConfigVersionStore, ConfigVersionRecord } from '../../../packages/persistence/src/config-store';
import type { AuditEntry } from '../../../packages/audit/src/index';
import {
  AUTHORITY_RULES, DECIDED_VALUES, LIMITED_SUBJECTS, authorityFrom, isAuthorityRule, readRule, rolesTouched,
  type Authority, type AuthorityLimits, type AuthorityRule, type EscalationWaits, type PriceCheckThresholds,
} from '../../../packages/approvals/src/authority-rules';
import { actionDetails, openApproval, type ApprovalPort } from './approval-requests';

/** Where each rule lives in `config_versions`. */
export const RULE_KEYS: Readonly<Record<AuthorityRule, string>> = Object.freeze({
  limits: 'approvals.authority_limits',
  'escalation-waits': 'approvals.escalation_waits',
  'price-check': 'pricing.second_person_threshold',
});
export const RULE_CONFIG_KEYS: ReadonlySet<string> = new Set(Object.values(RULE_KEYS));

/** The engine kind every rule change is approved under. */
export const RULE_CHANGE_KIND = 'approval_rule_change';

/** A rule as it stands: the value in force, and where it came from. */
export interface RuleInForce<T = unknown> {
  readonly rule: AuthorityRule;
  readonly value: T;
  /** 0 = the owner's decided figures (23 Oct 2026), never changed since. */
  readonly version: number;
  readonly source: 'owner_decision_23_oct_2026' | 'changed';
  readonly changedBy: string | null;
  readonly changedAt: string | null;
  readonly reason: string | null;
  /** Set when the newest stored version did not read as a valid rule and an older one is in force instead (P-08). */
  readonly heldAtLastKnownGood?: { readonly unreadableVersion: number; readonly why: string };
}

/** Read a rule in force from its versions: the newest that reads as valid; the decided figures when none was stored. */
export function ruleInForce<T>(rule: AuthorityRule, history: readonly ConfigVersionRecord[], knownRoles?: readonly string[]): RuleInForce<T> {
  let unreadable: { unreadableVersion: number; why: string } | undefined;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const v = history[i]!;
    const read = readRule(rule, v.value, knownRoles);
    if (read.ok) {
      return {
        rule, value: read.value as T, version: v.version, source: 'changed', changedBy: v.author, changedAt: v.effectiveAt, reason: v.reason,
        ...(unreadable === undefined ? {} : { heldAtLastKnownGood: unreadable }),
      };
    }
    unreadable ??= { unreadableVersion: v.version, why: read.why };
  }
  return {
    rule, value: DECIDED_VALUES[rule] as T, version: 0, source: 'owner_decision_23_oct_2026', changedBy: null, changedAt: null, reason: null,
    ...(unreadable === undefined ? {} : { heldAtLastKnownGood: unreadable }),
  };
}

export interface AuthorityRulesStore {
  readonly versions: ConfigVersionStore;
  /** The role ids this product defines (a limits row for an unknown role is refused). */
  readonly roleIds: () => readonly string[];
  /** The roles a person holds now — their grants and any live emergency grant; [] for an unknown name. */
  readonly rolesOf: (tenantId: string, userId: string) => Promise<readonly string[]> | readonly string[];
}

/** Read one rule in force for a tenant. */
export async function readRuleInForce<T>(s: Pick<AuthorityRulesStore, 'versions' | 'roleIds'>, tenantId: string, rule: AuthorityRule): Promise<RuleInForce<T>> {
  return ruleInForce<T>(rule, await s.versions.history(tenantId, RULE_KEYS[rule]), rule === 'limits' ? s.roleIds() : undefined);
}

/** THE port (handed to procure-to-pay for the PO limit): a person's money authority for a kind of decision, from the server. */
export type AuthorityOf = (tenantId: string, userId: string, subjectType: string) => Promise<Authority>;

export function authorityOfPort(s: AuthorityRulesStore): AuthorityOf {
  return async (tenantId, userId, subjectType) => {
    const limits = await readRuleInForce<AuthorityLimits>(s, tenantId, 'limits');
    return authorityFrom({ limits: limits.value, rulesVersion: limits.version, userId, roleIds: await s.rolesOf(tenantId, userId), subjectType });
  };
}

/** The escalation waits in force (OB-292). */
export async function escalationWaitsOf(s: Pick<AuthorityRulesStore, 'versions' | 'roleIds'>, tenantId: string): Promise<RuleInForce<EscalationWaits>> {
  return readRuleInForce<EscalationWaits>(s, tenantId, 'escalation-waits');
}

/** The price-check thresholds in force (OB-291). */
export async function priceCheckOf(s: Pick<AuthorityRulesStore, 'versions' | 'roleIds'>, tenantId: string): Promise<RuleInForce<PriceCheckThresholds>> {
  return readRuleInForce<PriceCheckThresholds>(s, tenantId, 'price-check');
}

export interface AuthorityRulesDeps extends AuthorityRulesStore {
  readonly approvals: ApprovalPort;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isWhole = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

const unknownRule = (rule: string) => notFound(`approval rule "${rule}" (there are: ${AUTHORITY_RULES.join(', ')})`);

/** What a change would do — the preview a person reads before they ask (M01-FR-03 "preview effect → submit"). */
function previewOf(rule: AuthorityRule, current: RuleInForce, proposed: unknown): Record<string, unknown> {
  if (rule === 'limits') {
    const before = current.value as AuthorityLimits; const after = proposed as AuthorityLimits;
    const touched = rolesTouched(before, after);
    return {
      rolesChanged: touched.map((roleId) => ({
        roleId,
        changes: LIMITED_SUBJECTS.map((s) => ({ kind: s, from: before.byRole[roleId]?.[s] ?? 'not_set', to: after.byRole[roleId]?.[s] ?? 'not_set' }))
          .filter((c) => c.from !== c.to),
      })),
    };
  }
  const before = current.value as Record<string, number>; const after = proposed as Record<string, number>;
  return { changes: Object.keys(after).filter((k) => before[k] !== after[k]).map((k) => ({ field: k, from: before[k] ?? null, to: after[k] })) };
}

export function authorityRulesRoutes(deps: AuthorityRulesDeps): readonly Route[] {
  const read = (tenantId: string, rule: AuthorityRule) => readRuleInForce(deps, tenantId, rule);
  const authorityOf = authorityOfPort(deps);

  /** Apply an approved change (a new value, or an older version restored): every check, then the one use, then the write. */
  const apply = async (ctx: Parameters<Route['handler']>[0], rule: AuthorityRule, value: unknown, basedOn: number, reason: string, rolledBackFrom: number | null) => {
    const current = await read(ctx.tenantId, rule);
    if (current.version !== basedOn) {
      throw apiError(409, {
        code: 'rule_changed_since',
        whatHappened: `The ${rule} rule is at version ${current.version} now; this change was asked against version ${basedOn}. Two changes cannot both be made blind to each other.`,
        wasItSaved: 'not_saved',
        nextSafeAction: 'Read the rule again, then ask for the change against what is in force now. Nothing was changed.',
      });
    }
    if (rule === 'limits') {
      // §28: "Store Manager … cannot modify … own approval limits" — nobody changes the limits of a role they hold.
      const held = new Set(await deps.rolesOf(ctx.tenantId, ctx.userId));
      const own = rolesTouched(current.value as AuthorityLimits, value as AuthorityLimits).filter((r) => held.has(r));
      if (own.length > 0) {
        throw apiError(422, {
          code: 'cannot_change_own_limits',
          whatHappened: `${ctx.userId} holds the ${own.join(', ')} role${own.length === 1 ? '' : 's'}, whose limits this change touches — nobody changes their own approval limits (§28).`,
          wasItSaved: 'not_saved',
          nextSafeAction: 'Someone who does not hold that role asks for the change; the owner approves it. Nothing was changed.',
        });
      }
    }
    const approval = await openApproval(deps.approvals, {
      tenantId: ctx.tenantId, approvalId: isStr((ctx.body as Record<string, unknown>)['approvalId']) ? ((ctx.body as Record<string, unknown>)['approvalId'] as string).trim() : '',
      kind: RULE_CHANGE_KIND, subjectRef: `rule:${rule}`, details: actionDetails(ctx.body, { rule }), valueMinor: null,
      maker: ctx.userId, usedBy: `approval-rule:${rule}:${basedOn + 1}`, now: deps.now(),
    });
    await approval.spend();
    const at = deps.now();
    const words = `${reason} — approved by ${approval.decision.decidedBy}`;
    const stored = rolledBackFrom === null
      ? await deps.versions.set(ctx.tenantId, RULE_KEYS[rule], value, ctx.userId, words, at)
      : await deps.versions.rollback(ctx.tenantId, RULE_KEYS[rule], rolledBackFrom, ctx.userId, words, at);
    await deps.recordAudit?.(ctx.tenantId, {
      actorId: ctx.userId, action: rolledBackFrom === null ? 'approval.rule.change' : 'approval.rule.rollback', objectType: 'approval_rule', objectId: rule, at,
      origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
      before: { version: String(current.version), value: JSON.stringify(current.value) },
      after: { version: String(stored.version), value: JSON.stringify(value), approvedBy: approval.decision.decidedBy, ...(rolledBackFrom === null ? {} : { restoredVersion: String(rolledBackFrom) }) },
      reason, approvalId: approval.decision.requestId, correlationId: `rule:${rule}:${stored.version}`,
    });
    return { status: 200, body: { rule, version: stored.version, value, changedBy: ctx.userId, approvedBy: approval.decision.decidedBy, effectiveAt: at, ...(rolledBackFrom === null ? {} : { restoredVersion: rolledBackFrom }) } };
  };

  return [
    {
      // The three rules as they stand — each with its version, who changed it and when, or "the owner's decided figures".
      api: 'API-01', method: 'GET', path: '/v1/approvals/rules',
      permission: 'approvals.rules.read',
      handler: async (ctx) => {
        const rules = await Promise.all(AUTHORITY_RULES.map((r) => read(ctx.tenantId, r)));
        return { status: 200, body: { rules: Object.fromEntries(rules.map((r) => [r.rule, r])), roles: deps.roleIds(), kinds: LIMITED_SUBJECTS, changeKind: RULE_CHANGE_KIND } };
      },
    },
    {
      // Every version of one rule, oldest first — the change and the rollback each their own event (M01-FR-03).
      api: 'API-01', method: 'GET', path: '/v1/approvals/rules/:rule/history',
      permission: 'approvals.rules.read',
      handler: async (ctx) => {
        const rule = ctx.params['rule'] ?? '';
        if (!isAuthorityRule(rule)) throw unknownRule(rule);
        return { status: 200, body: { rule, versions: await deps.versions.history(ctx.tenantId, RULE_KEYS[rule]), inForce: await read(ctx.tenantId, rule) } };
      },
    },
    {
      // Preview a change before asking for it: is it a valid rule, and exactly what would it change? Writes nothing.
      api: 'API-01', method: 'POST', path: '/v1/approvals/rules/:rule/preview',
      permission: 'approvals.rules.read',
      handler: async (ctx) => {
        const rule = ctx.params['rule'] ?? '';
        if (!isAuthorityRule(rule)) throw unknownRule(rule);
        const b = isObj(ctx.body) ? ctx.body : {};
        const r = readRule(rule, b['value'], rule === 'limits' ? deps.roleIds() : undefined);
        const current = await read(ctx.tenantId, rule);
        if (!r.ok) return { status: 200, body: { rule, valid: false, why: r.why, basedOnVersion: current.version } };
        const held = new Set(await deps.rolesOf(ctx.tenantId, ctx.userId));
        const own = rule === 'limits' ? rolesTouched(current.value as AuthorityLimits, r.value as AuthorityLimits).filter((x) => held.has(x)) : [];
        return {
          status: 200,
          body: {
            rule, valid: true, basedOnVersion: current.version, ...previewOf(rule, current, r.value),
            needsSecondPerson: true, approvedBy: 'the owner', touchesYourOwnRole: own,
            askWith: { kind: RULE_CHANGE_KIND, subjectRef: `rule:${rule}`, details: { rule, value: r.value, basedOnVersion: current.version, reason: '<your reason>' } },
          },
        };
      },
    },
    {
      // Apply an APPROVED change. Body: { value, basedOnVersion, reason, approvalId } — the maker asked for exactly this
      // (kind approval_rule_change, subjectRef rule:<rule>, details = this body without approvalId, plus `rule`), and the
      // owner approved it in his own session.
      api: 'API-01', method: 'PUT', path: '/v1/approvals/rules/:rule',
      permission: 'approvals.rules.propose', idempotent: true,
      handler: async (ctx) => {
        const rule = ctx.params['rule'] ?? '';
        if (!isAuthorityRule(rule)) throw unknownRule(rule);
        const b = isObj(ctx.body) ? ctx.body : {};
        if (!isWhole(b['basedOnVersion']) || !isStr(b['reason']) || !isStr(b['approvalId'])) {
          throw apiError(400, {
            code: 'not_readable_as_a_rule_change',
            whatHappened: 'A rule change is { value, basedOnVersion (the version you read), reason, approvalId (the owner\'s approval of exactly this change) }.',
            wasItSaved: 'not_saved',
            nextSafeAction: `Ask for approval first (POST /v1/approvals/requests, kind ${RULE_CHANGE_KIND}, subjectRef rule:${rule}); once the owner approves, send the change with its approvalId. Nothing was changed.`,
          });
        }
        const r = readRule(rule, b['value'], rule === 'limits' ? deps.roleIds() : undefined);
        if (!r.ok) throw apiError(422, { code: 'rule_not_valid', whatHappened: r.why, wasItSaved: 'not_saved', nextSafeAction: 'Correct the figures. Nothing was changed.' });
        return apply(ctx, rule, r.value, b['basedOnVersion'] as number, (b['reason'] as string).trim().slice(0, 300), null);
      },
    },
    {
      // One-step rollback, approved like any change: an older version's value restored as a NEW version (append-only).
      api: 'API-01', method: 'POST', path: '/v1/approvals/rules/:rule/rollback',
      permission: 'approvals.rules.propose', idempotent: true,
      handler: async (ctx) => {
        const rule = ctx.params['rule'] ?? '';
        if (!isAuthorityRule(rule)) throw unknownRule(rule);
        const b = isObj(ctx.body) ? ctx.body : {};
        if (!isWhole(b['toVersion']) || (b['toVersion'] as number) < 1 || !isWhole(b['basedOnVersion']) || !isStr(b['reason']) || !isStr(b['approvalId'])) {
          throw apiError(400, {
            code: 'not_readable_as_a_rule_rollback',
            whatHappened: 'A rollback is { toVersion (a stored version), basedOnVersion, reason, approvalId }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Pick the version from the rule\'s history and ask for approval of exactly this rollback. Nothing was changed.',
          });
        }
        const target = (await deps.versions.history(ctx.tenantId, RULE_KEYS[rule])).find((v) => v.version === b['toVersion']);
        if (target === undefined) throw notFound(`version ${b['toVersion'] as number} of the ${rule} rule`);
        const r = readRule(rule, target.value, rule === 'limits' ? deps.roleIds() : undefined);
        if (!r.ok) throw apiError(422, { code: 'rule_version_not_valid', whatHappened: `Version ${target.version} does not read as a valid rule now: ${r.why}`, wasItSaved: 'not_saved', nextSafeAction: 'Restore a different version, or set the figures afresh. Nothing was changed.' });
        return apply(ctx, rule, r.value, b['basedOnVersion'] as number, (b['reason'] as string).trim().slice(0, 300), target.version);
      },
    },
    {
      // What may I approve? The caller's own money authority for each kind — the server's figure, never the screen's.
      api: 'API-01', method: 'GET', path: '/v1/approvals/authority/me',
      permission: 'identity.self.read',
      handler: async (ctx) => ({ status: 200, body: { userId: ctx.userId, authority: await Promise.all(LIMITED_SUBJECTS.map((s) => authorityOf(ctx.tenantId, ctx.userId, s))) } }),
    },
    {
      // One person's money authority (for the owner and the access review).
      api: 'API-01', method: 'GET', path: '/v1/approvals/authority/:userId',
      permission: 'approvals.rules.read',
      handler: async (ctx) => {
        const userId = (ctx.params['userId'] ?? '').trim();
        return { status: 200, body: { userId, roles: await deps.rolesOf(ctx.tenantId, userId), authority: await Promise.all(LIMITED_SUBJECTS.map((s) => authorityOf(ctx.tenantId, userId, s))) } };
      },
    },
  ];
}
