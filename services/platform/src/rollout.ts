// Rollout switches per branch and per till lane — head office's routes (R8-9 · OB-316 · M01-FR-03 · §28 · P-04 · P-08 ·
// hard rules #2, #6 and #10).
//
// The identity lane's governed-switch pattern (governed-config.ts), one level finer: a switch is set FOR A BRANCH, or for
// ONE TILL LANE in a branch.
//   • PREVIEW says, before anything is asked, what the switch is there now, what it would become, which places it would
//     change (a branch setting reaches every lane without its own), and whether the owner must approve it.
//   • CHANGE carries a reason and becomes a numbered version for that place; a HIGH-IMPACT switch (payments, pricing,
//     offline limits — the same list as the shop's other switches) needs the owner's approval of exactly this change
//     (approvals kind `flag_change`), never the maker's own.
//   • ROLLBACK restores an older version's state as a NEW version, approved the same way, shown in the history.
//   • A branch must be one head office knows (and not closed); a lane must be a till registered at that branch (not
//     retired) — a switch for a place that does not exist would "work" silently and do nothing (P-08), so it is refused.
//   • The caller must hold the switch permission AT that branch (their grants' branch scope).
//
// The store pack carries each store's section (`rolloutSection`), so the till reads its lane's switch offline.

import type { Route, RequestContext, HandlerResult } from '../../kernel/src/index';
import { apiError, notFound, assertBranchInScope } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { actionDetails, openApproval, type ApprovalPort } from '../../identity/src/approval-requests';
import { isHighImpactFlag } from './governed-config';
import {
  rolloutHistory, rolloutBoard, decideRollout, ROLLOUT_KEY, ROLLOUT_PLACE_ID,
  type RolloutChange, type RolloutPlace,
} from '../../../packages/platform/src/rollout';

export interface RolloutDeps {
  /** Every rollout change recorded, in append order. */
  readonly changes: (tenantId: string) => Promise<readonly RolloutChange[]>;
  readonly recordChange: (tenantId: string, change: RolloutChange & { readonly version: number }) => Promise<void>;
  /** The branches head office knows, with their state. */
  readonly branches: (tenantId: string) => Promise<readonly { readonly branchId: string; readonly status: string }[]>;
  /** The till lanes registered at each branch (not retired). */
  readonly lanes: (tenantId: string) => Promise<readonly { readonly branchId: string; readonly laneId: string }[]>;
  readonly approvals: ApprovalPort;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** The approval subject for one place's switch — the owner approves exactly this switch at exactly this place. */
export const rolloutSubject = (key: string, place: RolloutPlace): string => `rollout:${key}:${place.branchId}${place.laneId === undefined ? '' : `:${place.laneId}`}`;

const keyOf = (ctx: RequestContext): string => {
  const key = (ctx.params['key'] ?? '').trim();
  if (!ROLLOUT_KEY.test(key)) throw apiError(400, { code: 'not_a_switch_name', whatHappened: `"${key}" is not a switch name (lower-case words joined by dots).`, wasItSaved: 'not_saved', nextSafeAction: 'Name the switch. Nothing changed.' });
  return key;
};

const placeFrom = (src: Record<string, unknown>): RolloutPlace => {
  const branchId = src['branchId'];
  const laneId = src['laneId'];
  if (!isStr(branchId) || !ROLLOUT_PLACE_ID.test(branchId.trim()) || (laneId !== undefined && laneId !== null && laneId !== '' && (!isStr(laneId) || !ROLLOUT_PLACE_ID.test(laneId.trim())))) {
    throw apiError(400, {
      code: 'rollout_place_not_given',
      whatHappened: 'A rollout switch is set for a branch ({ branchId }) or for one till lane in it ({ branchId, laneId }).',
      wasItSaved: 'not_saved', nextSafeAction: 'Say which branch (and lane, if just one). Nothing changed.',
    });
  }
  return { branchId: branchId.trim(), ...(isStr(laneId) ? { laneId: laneId.trim() } : {}) };
};

const placeWords = (p: RolloutPlace): string => (p.laneId === undefined ? `branch ${p.branchId}` : `lane ${p.laneId} of branch ${p.branchId}`);

export function rolloutRoutes(deps: RolloutDeps): readonly Route[] {
  /** The place must exist: a known, open branch; a registered, live lane at it. Refused by name otherwise. */
  const assertPlace = async (ctx: RequestContext, place: RolloutPlace): Promise<void> => {
    assertBranchInScope(ctx, place.branchId);
    const branch = (await deps.branches(ctx.tenantId)).find((b) => b.branchId === place.branchId);
    if (branch === undefined || branch.status === 'closed') {
      throw apiError(404, {
        code: 'unknown_branch', whatHappened: `Head office has no ${branch === undefined ? '' : 'open '}branch "${place.branchId}" — a switch for it would do nothing.`,
        wasItSaved: 'not_saved', nextSafeAction: 'Choose a branch from the organisation register. Nothing changed.',
      });
    }
    if (place.laneId !== undefined && !(await deps.lanes(ctx.tenantId)).some((l) => l.branchId === place.branchId && l.laneId === place.laneId)) {
      throw apiError(404, {
        code: 'unknown_lane', whatHappened: `No till "${place.laneId}" is registered at branch ${place.branchId} — a switch for it would do nothing.`,
        wasItSaved: 'not_saved', nextSafeAction: 'Choose a till lane registered at that branch (the devices register). Nothing changed.',
      });
    }
  };

  /** Record one change (a new state, or a restored one) after every check — the owner's approval spent first when needed. */
  const commit = async (ctx: RequestContext, key: string, place: RolloutPlace, enabled: boolean, reason: string, rolledBackFrom?: number): Promise<HandlerResult> => {
    const all = await deps.changes(ctx.tenantId);
    const history = rolloutHistory(all, key, place);
    const current = history.at(-1);
    const before = decideRollout(all, key, place);
    let approvedBy: string | undefined; let approvalId: string | undefined;
    if (isHighImpactFlag(key)) {
      const b = ctx.body as Record<string, unknown>;
      const subjectRef = rolloutSubject(key, place);
      if (!isStr(b['approvalId'])) {
        throw apiError(422, {
          code: 'high_impact_change_needs_owner_approval',
          whatHappened: `Switch ${key} is high-impact (payments, pricing or offline limits): the owner approves it first for ${placeWords(place)}, and the person who asks can never approve their own (M01-FR-03, §28).`,
          wasItSaved: 'not_saved',
          nextSafeAction: `Ask for approval (POST /v1/approvals/requests, kind flag_change, subjectRef ${subjectRef}, with exactly this change); once the owner approves it, send it again with the approvalId. Nothing was changed.`,
        });
      }
      const approval = await openApproval(deps.approvals, {
        tenantId: ctx.tenantId, approvalId: b['approvalId'].trim(), kind: 'flag_change', subjectRef,
        details: actionDetails(ctx.body, { key, ...(rolledBackFrom === undefined ? {} : { action: 'rollback' }) }), valueMinor: null,
        maker: ctx.userId, usedBy: `${subjectRef}:${history.length + 1}`, now: deps.now(),
      });
      await approval.spend();
      approvedBy = approval.decision.decidedBy; approvalId = approval.decision.requestId;
    }
    const change: RolloutChange & { readonly version: number } = {
      key, branchId: place.branchId, ...(place.laneId === undefined ? {} : { laneId: place.laneId }), enabled, reason,
      changedBy: ctx.userId, changedAt: deps.now(), version: history.length + 1,
      ...(approvedBy === undefined ? {} : { approvedBy, approvalId: approvalId! }),
      ...(rolledBackFrom === undefined ? {} : { rolledBackFrom }),
    };
    // A failed write records nothing: the switch stays at its last version, and the caller is told (P-08).
    await deps.recordChange(ctx.tenantId, change);
    await deps.recordAudit?.(ctx.tenantId, {
      actorId: ctx.userId, action: rolledBackFrom === undefined ? 'platform.rollout.change' : 'platform.rollout.rollback', objectType: 'rollout_switch',
      objectId: rolloutSubject(key, place), at: change.changedAt, origin: { tenantId: ctx.tenantId, branchId: place.branchId },
      before: current === undefined ? null : { enabled: String(current.enabled), version: String(current.version) },
      after: { enabled: String(enabled), version: String(change.version), ...(approvedBy === undefined ? {} : { approvedBy }), ...(rolledBackFrom === undefined ? {} : { restoredVersion: String(rolledBackFrom) }) },
      reason, ...(approvalId === undefined ? {} : { approvalId }), correlationId: `${rolloutSubject(key, place)}:${change.version}`,
    });
    const after = decideRollout([...all, change], key, place);
    return { status: 200, body: { change, highImpact: isHighImpactFlag(key), before: { on: before.on, source: before.source }, now: after } };
  };

  return [
    {
      // Every rollout switch at every place it was ever set — the board — with who set it, why and which version.
      api: 'API-11', method: 'GET', path: '/v1/platform/rollout',
      permission: 'platform.flag.read',
      handler: async (ctx) => {
        const board = rolloutBoard(await deps.changes(ctx.tenantId));
        return { status: 200, body: { switches: board, count: board.length, rule: 'A lane\'s own setting beats its branch\'s; a switch nobody set is off.' } };
      },
    },
    {
      // Is this feature on here? — the most specific setting decides (lane, then branch, else off). For services and screens.
      api: 'API-11', method: 'GET', path: '/v1/platform/rollout/:key/decision',
      permission: 'platform.flag.read',
      handler: async (ctx) => {
        const key = keyOf(ctx);
        const place = placeFrom(ctx.query);
        return { status: 200, body: decideRollout(await deps.changes(ctx.tenantId), key, place) };
      },
    },
    {
      // Preview a change at a place: now, proposed, which lanes it reaches, and whether the owner must approve. Writes nothing.
      api: 'API-11', method: 'POST', path: '/v1/platform/rollout/:key/preview',
      permission: 'platform.flag.read', idempotent: true,
      handler: async (ctx) => {
        const key = keyOf(ctx);
        const b = isObj(ctx.body) ? ctx.body : {};
        const place = placeFrom(b);
        if (typeof b['enabled'] !== 'boolean') throw apiError(400, { code: 'rollout_state_not_given', whatHappened: 'A preview says the state you would set: { branchId, laneId?, enabled: true | false }.', wasItSaved: 'not_saved', nextSafeAction: 'Send the intended state.' });
        await assertPlace(ctx, place);
        const all = await deps.changes(ctx.tenantId);
        const current = rolloutHistory(all, key, place).at(-1);
        const high = isHighImpactFlag(key);
        const proposed: RolloutChange = { key, branchId: place.branchId, ...(place.laneId === undefined ? {} : { laneId: place.laneId }), enabled: b['enabled'], reason: 'preview', changedBy: ctx.userId, changedAt: deps.now() };
        // A branch setting reaches every lane at the branch that has no setting of its own; a lane setting reaches that lane.
        const lanesHere = (await deps.lanes(ctx.tenantId)).filter((l) => l.branchId === place.branchId).map((l) => l.laneId).sort();
        const reached = place.laneId !== undefined ? [place.laneId] : lanesHere.filter((laneId) => rolloutHistory(all, key, { branchId: place.branchId, laneId }).length === 0);
        const changesAt = reached.filter((laneId) => decideRollout(all, key, { branchId: place.branchId, laneId }).on !== decideRollout([...all, proposed], key, { branchId: place.branchId, laneId }).on);
        return {
          status: 200,
          body: {
            key, place: { branchId: place.branchId, laneId: place.laneId ?? null },
            current: current?.enabled ?? null, currentVersion: current?.version ?? 0, proposed: b['enabled'],
            lanesReached: reached, lanesThatChange: changesAt, lanesWithTheirOwnSetting: place.laneId === undefined ? lanesHere.filter((l) => !reached.includes(l)) : [],
            highImpact: high, needsSecondPerson: high, approvedBy: high ? 'the owner' : null,
            ...(high ? { askWith: { kind: 'flag_change', subjectRef: rolloutSubject(key, place), details: { key, branchId: place.branchId, ...(place.laneId === undefined ? {} : { laneId: place.laneId }), enabled: b['enabled'], reason: '<your reason>' } } } : {}),
          },
        };
      },
    },
    {
      // Change a switch at a place. Body: { branchId, laneId?, enabled, reason, approvalId? (required when high-impact) }.
      api: 'API-11', method: 'PUT', path: '/v1/platform/rollout/:key',
      permission: 'platform.flag.write', idempotent: true,
      handler: async (ctx) => {
        const key = keyOf(ctx);
        const b = isObj(ctx.body) ? ctx.body : {};
        const place = placeFrom(b);
        if (typeof b['enabled'] !== 'boolean') throw apiError(400, { code: 'rollout_state_not_given', whatHappened: 'A rollout change must say true or false.', wasItSaved: 'not_saved', nextSafeAction: 'Send { branchId, laneId?, enabled, reason }. Nothing changed.' });
        if (!isStr(b['reason'])) throw apiError(400, { code: 'reason_required', whatHappened: 'Every rollout change carries the reason it was made (OB-316, M01-FR-03).', wasItSaved: 'not_saved', nextSafeAction: 'Send { branchId, laneId?, enabled, reason }. Nothing changed.' });
        await assertPlace(ctx, place);
        return commit(ctx, key, place, b['enabled'], b['reason'].trim().slice(0, 300));
      },
    },
    {
      // One place's versions of a switch, oldest first — changes and rollbacks each their own event. ?branchId=&laneId=
      api: 'API-11', method: 'GET', path: '/v1/platform/rollout/:key/history',
      permission: 'platform.flag.read',
      handler: async (ctx) => {
        const key = keyOf(ctx);
        const place = placeFrom(ctx.query);
        const all = await deps.changes(ctx.tenantId);
        const versions = rolloutHistory(all, key, place);
        return { status: 200, body: { key, place: { branchId: place.branchId, laneId: place.laneId ?? null }, versions, current: versions.at(-1) ?? null, decision: decideRollout(all, key, place), highImpact: isHighImpactFlag(key) } };
      },
    },
    {
      // One-step rollback at a place: restore version N's state as a NEW version. Body: { branchId, laneId?, toVersion, reason, approvalId? }.
      api: 'API-11', method: 'POST', path: '/v1/platform/rollout/:key/rollback',
      permission: 'platform.flag.write', idempotent: true,
      handler: async (ctx) => {
        const key = keyOf(ctx);
        const b = isObj(ctx.body) ? ctx.body : {};
        const place = placeFrom(b);
        if (typeof b['toVersion'] !== 'number' || !Number.isInteger(b['toVersion']) || b['toVersion'] < 1 || !isStr(b['reason'])) {
          throw apiError(400, { code: 'not_readable_as_a_rollback', whatHappened: 'A rollout rollback is { branchId, laneId?, toVersion, reason, approvalId? }.', wasItSaved: 'not_saved', nextSafeAction: 'Pick the version from the switch\'s history at that place. Nothing changed.' });
        }
        await assertPlace(ctx, place);
        const target = rolloutHistory(await deps.changes(ctx.tenantId), key, place).find((v) => v.version === b['toVersion']);
        if (target === undefined) throw notFound(`version ${b['toVersion']} of switch ${key} at ${placeWords(place)}`);
        return commit(ctx, key, place, target.enabled, b['reason'].trim().slice(0, 300), target.version);
      },
    },
  ];
}
