// Feature switches and high-impact settings, governed (M01-FR-02 · M01-FR-03 · §28 · P-04 · P-08 · hard rules #2, #6).
//
// M01-FR-03: "Edit config/flag → preview effect → submit → approve → activate … (if needed) roll back to a named prior
// version"; "every configuration change is a new immutable version with author, reason and effective date; rollback
// restores a prior version as a new version"; "high-impact flags (payments, pricing, offline limits) require owner
// approval"; acceptance "a maker cannot approve their own high-impact flag". M01-FR-02: "owner approval for
// currency/precision and trading-day changes".
//
// Before this the switch route took one person, no reason, no preview and no approval; and a trading-day cut-off, currency
// or time zone changed with nobody else looking. Now:
//   • every switch change carries a REASON and becomes a numbered version (on the same ledger the switch board folds);
//   • a PREVIEW says, before anything is asked, what would change and whether a second person must approve it;
//   • a HIGH-IMPACT switch (payments, pricing, offline limits) or setting needs the OWNER's approval through the engine
//     (kinds `flag_change`, `config_change`) — never the maker's own;
//   • a ROLLBACK restores an older version's state as a new version, in one step, approved the same way, and shows in the
//     history as its own event;
//   • the approval rules' own config keys (money limits, waits, price-check size) cannot be rolled back through the
//     generic settings route at all — they change only on the approval-rules route, by two people.

import type { Route, RequestContext, HandlerResult } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { actionDetails, openApproval, type ApprovalPort } from '../../identity/src/approval-requests';
import { FLOOR_DEVICE_SWITCH } from '../../../packages/integration/src/floor-devices';

/**
 * Settings whose change needs the owner's approval. M01-FR-02 names "owner approval for currency/precision and trading-day
 * changes"; OB-336 (owner, 23 Oct 2026, in writing) adds the time zone, the till's offline loyalty spend cap and the
 * bulk-publish threshold. Each needs the OWNER's approval of exactly the answer being saved — never the maker's own.
 * (M01-FR-03's high-impact list of SWITCHES — payments, pricing, offline limits — is below.)
 */
export const HIGH_IMPACT_SETTINGS: Readonly<Record<string, string>> = Object.freeze({
  'trading_day.cutoff': 'decides which day every sale, day close and tax period falls in',
  'locale.currency': 'the currency every amount is held in',
  'locale.time_zone': 'the shop\'s clock — which day "today" is for every report, close and alert (OB-336)',
  'loyalty.till_spend_cap_paise': 'the most a member may spend at the till per day, offline too — an offline limit (OB-336)',
  'catalogue.bulk_publish_threshold': 'how many products one catalogue publish may change before it needs a fresh second-factor sign-in (OB-336)',
  // OB-354 (owner, 24 Oct 2026): there is no shop-state setting — each store's state is read from its GSTIN, which is the
  // organisation record's (OB-348's liquor rule follows it).
});

/** Switches whose name begins with one of these are high-impact (M01-FR-03: payments, pricing, offline limits). */
export const HIGH_IMPACT_FLAG_PREFIXES: readonly string[] = Object.freeze(['payments.', 'payment.', 'pricing.', 'price.', 'offline.']);
export const isHighImpactFlag = (key: string): boolean => HIGH_IMPACT_FLAG_PREFIXES.some((p) => key.startsWith(p));

/**
 * OB-407 (owner, 27 Oct 2026, in writing — option B · D14-FR-05 · R8-7 · §8.2): the four FLOOR-DEVICE rollout switches —
 * shelf labels (`esl`), RFID readers (`rfid`), sensors (`iot`) and cameras (`cctv`), the switch each kind of floor device
 * sits behind (`FLOOR_DEVICE_SWITCH`) — are high-impact. Switching one ON for a place needs the owner's approval (kind
 * `flag_change`) AND the named security reviewer's signature (kind `floor_device_review`, OB-330 / OB-405), each in their own
 * session, never the person switching. Switching one OFF stays one person with a reason: turning a camera off must never be
 * harder than turning it on. These are ROLLOUT keys (services/platform/src/rollout.ts), not the shop's feature flags.
 */
export const FLOOR_DEVICE_ROLLOUT_KEYS: readonly string[] = Object.freeze([...new Set(Object.values(FLOOR_DEVICE_SWITCH))].sort());
export const isFloorDeviceSwitch = (key: string): boolean => FLOOR_DEVICE_ROLLOUT_KEYS.includes(key);
/** Is this rollout switch high-impact — the shop's high-impact list (payments, pricing, offline limits) or a floor device? */
export const isHighImpactRolloutKey = (key: string): boolean => isHighImpactFlag(key) || isFloorDeviceSwitch(key);

/** One switch change as recorded — the same `FeatureFlagSet` fact the switch board folds, with its version and reason. */
export interface GovernedFlagChange {
  readonly key: string;
  readonly enabled: boolean;
  readonly changedBy: string;
  readonly changedAt: string;
  readonly reason?: string;
  readonly version?: number;
  readonly approvedBy?: string;
  readonly approvalId?: string;
  readonly rolledBackFrom?: number;
}

export interface GovernedConfigDeps {
  /** Every switch change recorded, in append order. */
  readonly flagChanges: (tenantId: string) => Promise<readonly GovernedFlagChange[]>;
  readonly recordFlagChange: (tenantId: string, change: GovernedFlagChange) => Promise<void>;
  readonly approvals: ApprovalPort;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const KEY = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/;

/** A switch's history with each change numbered (changes recorded before versions existed are numbered by position). */
export function flagHistory(changes: readonly GovernedFlagChange[], key: string): readonly (GovernedFlagChange & { readonly version: number })[] {
  return changes.filter((c) => c.key === key).map((c, i) => ({ ...c, version: i + 1 }));
}

const needsOwner = (what: string, kind: string, subjectRef: string): Error => apiError(422, {
  code: 'high_impact_change_needs_owner_approval',
  whatHappened: `${what} is high-impact: the owner approves it first, and the person who asks can never approve their own (M01-FR-03, §28).`,
  wasItSaved: 'not_saved',
  nextSafeAction: `Ask for approval (POST /v1/approvals/requests, kind ${kind}, subjectRef ${subjectRef}, with exactly this change); once the owner approves it, send it again with the approvalId. Nothing was changed.`,
});

export function governedFlagRoutes(deps: GovernedConfigDeps): readonly Route[] {
  const keyOf = (ctx: RequestContext): string => {
    const key = (ctx.params['key'] ?? '').trim();
    if (!KEY.test(key)) throw apiError(400, { code: 'not_a_switch_name', whatHappened: `"${key}" is not a switch name (lower-case words joined by dots).`, wasItSaved: 'not_saved', nextSafeAction: 'Name the switch. Nothing changed.' });
    return key;
  };
  /** Record one switch change (a new state or a restored one) after every check — approval spent first when needed. */
  const commit = async (ctx: RequestContext, key: string, enabled: boolean, reason: string, rolledBackFrom?: number): Promise<HandlerResult> => {
    const history = flagHistory(await deps.flagChanges(ctx.tenantId), key);
    const current = history.at(-1);
    let approvedBy: string | undefined; let approvalId: string | undefined;
    if (isHighImpactFlag(key)) {
      const b = ctx.body as Record<string, unknown>;
      if (!isStr(b['approvalId'])) throw needsOwner(`Switch ${key}`, 'flag_change', `flag:${key}`);
      const approval = await openApproval(deps.approvals, {
        tenantId: ctx.tenantId, approvalId: b['approvalId'].trim(), kind: 'flag_change', subjectRef: `flag:${key}`,
        details: actionDetails(ctx.body, { key, ...(rolledBackFrom === undefined ? {} : { action: 'rollback' }) }), valueMinor: null,
        maker: ctx.userId, usedBy: `flag:${key}:${history.length + 1}`, now: deps.now(),
      });
      await approval.spend();
      approvedBy = approval.decision.decidedBy; approvalId = approval.decision.requestId;
    }
    const change: GovernedFlagChange = {
      key, enabled, changedBy: ctx.userId, changedAt: deps.now(), reason, version: history.length + 1,
      ...(approvedBy === undefined ? {} : { approvedBy, approvalId: approvalId! }),
      ...(rolledBackFrom === undefined ? {} : { rolledBackFrom }),
    };
    // A failed write records nothing: the switch stays at its last version (the last-known-good), and the caller is told.
    await deps.recordFlagChange(ctx.tenantId, change);
    await deps.recordAudit?.(ctx.tenantId, {
      actorId: ctx.userId, action: rolledBackFrom === undefined ? 'platform.flag.change' : 'platform.flag.rollback', objectType: 'feature_flag', objectId: key,
      at: change.changedAt, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
      before: current === undefined ? null : { enabled: String(current.enabled), version: String(current.version) },
      after: { enabled: String(enabled), version: String(change.version), ...(approvedBy === undefined ? {} : { approvedBy }), ...(rolledBackFrom === undefined ? {} : { restoredVersion: String(rolledBackFrom) }) },
      reason, ...(approvalId === undefined ? {} : { approvalId }), correlationId: `flag:${key}:${change.version}`,
    });
    return { status: 200, body: { ...change, highImpact: isHighImpactFlag(key) } };
  };

  return [
    {
      // Preview a switch change: what it is now, what it would be, and whether the owner must approve it. Writes nothing.
      api: 'API-11', method: 'POST', path: '/v1/platform/flags/:key/preview',
      permission: 'platform.flag.read', idempotent: true,
      handler: async (ctx) => {
        const key = keyOf(ctx);
        const b = isObj(ctx.body) ? ctx.body : {};
        if (typeof b['enabled'] !== 'boolean') throw apiError(400, { code: 'flag_state_not_given', whatHappened: 'A preview says the state you would set: { enabled: true | false }.', wasItSaved: 'not_saved', nextSafeAction: 'Send the intended state.' });
        const current = flagHistory(await deps.flagChanges(ctx.tenantId), key).at(-1);
        const high = isHighImpactFlag(key);
        return {
          status: 200,
          body: {
            key, current: current?.enabled ?? null, currentVersion: current?.version ?? 0, proposed: b['enabled'],
            changes: current?.enabled !== b['enabled'], highImpact: high, needsSecondPerson: high, approvedBy: high ? 'the owner' : null,
            ...(high ? { askWith: { kind: 'flag_change', subjectRef: `flag:${key}`, details: { key, enabled: b['enabled'], reason: '<your reason>' } } } : {}),
          },
        };
      },
    },
    {
      // Change a switch. Body: { enabled, reason, approvalId? (required for a high-impact switch) }.
      api: 'API-11', method: 'PUT', path: '/v1/platform/flags/:key',
      permission: 'platform.flag.write', idempotent: true,
      handler: async (ctx) => {
        const key = keyOf(ctx);
        const b = isObj(ctx.body) ? ctx.body : {};
        if (typeof b['enabled'] !== 'boolean') {
          throw apiError(400, { code: 'flag_state_not_given', whatHappened: 'A feature flag change must say true or false.', wasItSaved: 'not_saved', nextSafeAction: 'Send the intended state. Nothing changed.' });
        }
        if (!isStr(b['reason'])) {
          throw apiError(400, { code: 'reason_required', whatHappened: 'Every switch change carries the reason it was made (M01-FR-03).', wasItSaved: 'not_saved', nextSafeAction: 'Send { enabled, reason }. Nothing changed.' });
        }
        return commit(ctx, key, b['enabled'], b['reason'].trim().slice(0, 300));
      },
    },
    {
      // Every version of a switch, oldest first — changes and rollbacks each their own event.
      api: 'API-11', method: 'GET', path: '/v1/platform/flags/:key/history',
      permission: 'platform.flag.read',
      handler: async (ctx) => {
        const key = keyOf(ctx);
        const versions = flagHistory(await deps.flagChanges(ctx.tenantId), key);
        return { status: 200, body: { key, versions, current: versions.at(-1) ?? null, highImpact: isHighImpactFlag(key) } };
      },
    },
    {
      // One-step rollback: restore version N's state as a NEW version. Body: { toVersion, reason, approvalId? }.
      api: 'API-11', method: 'POST', path: '/v1/platform/flags/:key/rollback',
      permission: 'platform.flag.write', idempotent: true,
      handler: async (ctx) => {
        const key = keyOf(ctx);
        const b = isObj(ctx.body) ? ctx.body : {};
        if (typeof b['toVersion'] !== 'number' || !Number.isInteger(b['toVersion']) || b['toVersion'] < 1 || !isStr(b['reason'])) {
          throw apiError(400, { code: 'not_readable_as_a_rollback', whatHappened: 'A switch rollback is { toVersion, reason, approvalId? }.', wasItSaved: 'not_saved', nextSafeAction: 'Pick the version from the switch\'s history. Nothing changed.' });
        }
        const target = flagHistory(await deps.flagChanges(ctx.tenantId), key).find((v) => v.version === b['toVersion']);
        if (target === undefined) throw notFound(`version ${b['toVersion']} of switch ${key}`);
        return commit(ctx, key, target.enabled, b['reason'].trim().slice(0, 300), target.version);
      },
    },
  ];
}

/**
 * The setup-answer route, governed: a high-impact setting needs the owner's approval of exactly this answer (kind
 * `config_change`, subjectRef `setting:<key>`) before the route's own validation and versioned write run. `validate`
 * judges the answer first, so an invalid answer never spends an approval.
 */
export function governSetupWrite(inner: Route['handler'], deps: { readonly approvals: ApprovalPort; readonly now: () => string; readonly validate: (key: string, value: unknown) => string | undefined }): Route['handler'] {
  return async (ctx) => {
    const key = (ctx.params['key'] ?? '').trim();
    if (HIGH_IMPACT_SETTINGS[key] === undefined) return inner(ctx);
    const b = isObj(ctx.body) ? ctx.body : {};
    const invalid = b['value'] === undefined ? undefined : deps.validate(key, b['value']);
    if (b['value'] === undefined || invalid !== undefined) return inner(ctx); // the route's own refusal, nothing spent
    if (!isStr(b['approvalId'])) throw needsOwner(`The ${key} setting (${HIGH_IMPACT_SETTINGS[key]})`, 'config_change', `setting:${key}`);
    const approval = await openApproval(deps.approvals, {
      tenantId: ctx.tenantId, approvalId: b['approvalId'].trim(), kind: 'config_change', subjectRef: `setting:${key}`,
      details: actionDetails(ctx.body, { key }), valueMinor: null, maker: ctx.userId, usedBy: `setting:${key}:${ctx.idempotencyKey ?? deps.now()}`, now: deps.now(),
    });
    await approval.spend();
    return inner(ctx);
  };
}

/**
 * The generic config rollback, governed: an approval rule's key is refused (it changes only on its own route, by two
 * people); a high-impact setting's rollback needs the owner's approval like any change to it.
 */
export function governConfigRollback(inner: Route['handler'], deps: { readonly approvals: ApprovalPort; readonly now: () => string; readonly ruleKeys: ReadonlySet<string> }): Route['handler'] {
  return async (ctx) => {
    const key = (ctx.params['key'] ?? '').trim();
    if (deps.ruleKeys.has(key)) {
      throw apiError(409, {
        code: 'approval_rule_has_its_own_route',
        whatHappened: `${key} is one of the owner's approval rules; it is changed or rolled back only on the approval-rules route, by two people.`,
        wasItSaved: 'not_saved', nextSafeAction: 'Use POST /v1/approvals/rules/:rule/rollback with the owner\'s approval. Nothing changed.',
      });
    }
    if (HIGH_IMPACT_SETTINGS[key] === undefined) return inner(ctx);
    const b = isObj(ctx.body) ? ctx.body : {};
    if (!isStr(b['approvalId'])) throw needsOwner(`Rolling back ${key}`, 'config_change', `setting:${key}`);
    const approval = await openApproval(deps.approvals, {
      tenantId: ctx.tenantId, approvalId: b['approvalId'].trim(), kind: 'config_change', subjectRef: `setting:${key}`,
      details: actionDetails(ctx.body, { key, action: 'rollback' }), valueMinor: null, maker: ctx.userId, usedBy: `setting:${key}:rollback:${ctx.idempotencyKey ?? deps.now()}`, now: deps.now(),
    });
    await approval.spend();
    return inner(ctx);
  };
}
