// Durable version-policy store (M33-FR-02/04 remote kill · A-10 · §35) — the write path behind the fleet's
// version decisions. Until now the version policy the fleet is judged against was supplied in the request
// BODY on every call and folded nowhere; this keeps the shop's REAL policy on the system, append-only, so the
// fleet is judged against the policy an authorised admin actually set. Withdrawing a broken release
// (the "remote kill") is a durable, audited change: a device on a killed version is then told to move BACK to
// the previous good build — at the next safe moment, never mid-basket (the engine's `deferUntilIdle`).
//
//   • SET the policy — current / previous / minimum-supported versions and the withdrawn (killed) list. A
//     policy that would itself brick the fleet (nothing could trade, or no rollback path) is refused BEFORE
//     anything is stored (A-10). Append-only: each set is a new event; the latest is effective; the history
//     stays and explains every past state.
//   • KILL a release — the remote-kill verb: read the current policy, add the version to the withdrawn list,
//     and store the result. The CURRENT version can never be killed (there would be nothing to move devices
//     onto), and there must be a policy to withdraw from.
//   • READ the policy — the current effective policy the fleet-health/evaluate reads judge against.
//
// Writes are gated platform.device.manage; the read platform.health.read. No AI writes anything (hard rule #5).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  validateVersionPolicy, InvalidVersionError, UnsafeVersionPolicyError, type VersionPolicy,
} from '../../../packages/platform-admin/src/devices';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const strArray = (v: unknown): readonly string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;

/** One append-only change to the shop's version policy. The WHOLE policy is carried each time (latest wins),
 *  so the fold is trivial and every past state is on the record. */
export interface VersionPolicyEvent {
  readonly policy: VersionPolicy;
  /** Who set it — the authorised admin, for the audit trail (P-04). */
  readonly by: string;
  readonly at: string;
}

/** Fold the append-only log to the CURRENT policy — the latest set wins; none set yet reads as `undefined`. */
export function projectVersionPolicy(events: readonly VersionPolicyEvent[]): VersionPolicy | undefined {
  return events.length === 0 ? undefined : events[events.length - 1]?.policy;
}

export interface VersionPolicyDeps {
  /** The current effective policy, projected from the append-only log (survives restart). */
  readonly policy: (tenantId: string) => Promise<VersionPolicy | undefined> | VersionPolicy | undefined;
  /** Append one policy change. Idempotent on the key. */
  readonly recordPolicyEvent: (tenantId: string, event: VersionPolicyEvent, key: string) => Promise<void> | void;
  readonly now: () => string;
}

/** Read a version policy off a request value — the same shape the stateless routes accept. */
function readPolicy(v: unknown): VersionPolicy | undefined {
  if (!isObj(v) || !isStr(v['currentVersion']) || !isStr(v['minimumSupportedVersion'])) return undefined;
  if (v['previousVersion'] !== undefined && !isStr(v['previousVersion'])) return undefined;
  const killed = v['killedVersions'] === undefined ? undefined : strArray(v['killedVersions']);
  if (v['killedVersions'] !== undefined && killed === undefined) return undefined;
  return {
    currentVersion: v['currentVersion'] as string, minimumSupportedVersion: v['minimumSupportedVersion'] as string,
    ...(isStr(v['previousVersion']) ? { previousVersion: v['previousVersion'] } : {}),
    ...(killed !== undefined ? { killedVersions: killed } : {}),
  };
}

// A policy that would brick the fleet, or a version this system cannot compare, is refused before any change
// is stored (A-10) — the same guard the stateless routes and fleet-health use.
const guardPolicy = (policy: VersionPolicy): void => {
  try {
    validateVersionPolicy(policy);
  } catch (e) {
    if (e instanceof UnsafeVersionPolicyError) throw apiError(422, { code: 'unsafe_version_policy', whatHappened: e.message, wasItSaved: 'not_saved', nextSafeAction: 'Fix the policy so current and previous keep a rollback path, then send it again.' });
    if (e instanceof InvalidVersionError) throw apiError(422, { code: 'version_not_comparable', whatHappened: e.message, wasItSaved: 'not_saved', nextSafeAction: 'Send versions as numbers like 1.4.2.' });
    throw e;
  }
};

export function versionPolicyRoutes(deps: VersionPolicyDeps): readonly Route[] {
  return [
    {
      // The current version policy the fleet is judged against. `null` when none has been set yet — not-set is
      // reported as not-set, never as an empty "all clear" (P-08).
      api: 'API-10', method: 'GET', path: '/v1/platform/version-policy',
      permission: 'platform.health.read',
      handler: async (ctx) => {
        const policy = await deps.policy(ctx.tenantId);
        return { status: 200, body: { policy: policy ?? null, asAt: deps.now() } };
      },
    },
    {
      // Set the whole version policy. Refuses one that would brick the fleet FIRST (A-10), then stores it.
      api: 'API-10', method: 'POST', path: '/v1/platform/version-policy',
      permission: 'platform.device.manage', idempotent: true,
      handler: async (ctx) => {
        const policy = readPolicy(isObj(ctx.body) ? ctx.body['policy'] : undefined);
        if (policy === undefined) {
          throw apiError(400, { code: 'not_readable_as_a_version_policy', whatHappened: 'A version policy needs { currentVersion, minimumSupportedVersion, and optional previousVersion, killedVersions[] }.', wasItSaved: 'not_saved', nextSafeAction: 'Send the versions the fleet should run.' });
        }
        guardPolicy(policy);
        const at = deps.now();
        await deps.recordPolicyEvent(ctx.tenantId, { policy, by: ctx.userId, at }, ctx.idempotencyKey ?? `set-${at}`);
        return { status: 200, body: { policy, at } };
      },
    },
    {
      // REMOTE KILL — withdraw a broken release. Reads the current policy, adds the version to the withdrawn
      // list, and stores the result (validated: the current version can never be killed — A-10). There must be
      // a policy to withdraw from. Idempotent: re-killing an already-withdrawn version stores the same policy.
      api: 'API-10', method: 'POST', path: '/v1/platform/version-policy/kill',
      permission: 'platform.device.manage', idempotent: true,
      handler: async (ctx) => {
        const b = ctx.body;
        if (!isObj(b) || !isStr(b['version'])) {
          throw apiError(400, { code: 'not_readable_as_a_kill', whatHappened: 'Withdrawing a release needs { version }.', wasItSaved: 'not_saved', nextSafeAction: 'Send which version to withdraw.' });
        }
        const version = (b['version'] as string).trim();
        const current = await deps.policy(ctx.tenantId);
        if (current === undefined) {
          throw apiError(409, { code: 'no_version_policy', whatHappened: 'There is no version policy yet, so a release cannot be withdrawn from one.', wasItSaved: 'not_saved', nextSafeAction: 'Set the version policy first, then withdraw a release.' });
        }
        const killed = current.killedVersions ?? [];
        const next: VersionPolicy = killed.includes(version) ? current : { ...current, killedVersions: [...killed, version] };
        guardPolicy(next); // the current version cannot be withdrawn (nothing to move onto) → 422
        const at = deps.now();
        await deps.recordPolicyEvent(ctx.tenantId, { policy: next, by: ctx.userId, at }, ctx.idempotencyKey ?? `kill-${version}-${at}`);
        return { status: 200, body: { policy: next, at } };
      },
    },
  ];
}
