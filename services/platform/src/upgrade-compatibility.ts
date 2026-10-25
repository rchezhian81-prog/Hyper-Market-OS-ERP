// Upgrade compatibility, checked at release time (M36-FR-03 "upgrades are backward-compatible … no breaking a live
// tenant" · M36-FR-04 "an unversioned/breaking change is rejected (deprecation window required)" · P-06 · R8-2).
//
// The released surface is written down in `docs/api/released-contract.json`: every endpoint (method and path, with the
// path's parameter names dropped — renaming `:id` to `:productId` breaks nobody) and every event published to partners
// as a signed webhook. A store computer on last month's version, a partner's integration and the shop's own apps all
// call that surface; an upgrade that takes any of it away breaks them on the day it deploys.
//
// So a new build is judged against it with the tested `assessCompatibility` engine (packages/platform/src/lifecycle.ts):
//   • ADDING is always safe (an endpoint or event nobody calls yet breaks nobody);
//   • REMOVING (or renaming) a released endpoint or event is BREAKING — unless it was deprecated, by date, in the
//     contract file, and the deprecation window (the engine's 180 days) has actually elapsed. The announcement is not the
//     mitigation; the elapsed time is.
// The guardrail `tests/guardrails/an-upgrade-never-breaks-a-live-shop.test.ts` runs it in CI on every change, and a
// release only deploys a commit that passed CI (infra/deploy/release.sh refuses one that is not on main).
//
// Pure: the routes and the event list are handed in; no clock (today is passed).

import type { Route } from '../../kernel/src/index';
import { assessCompatibility, type CompatibilityResult } from '../../../packages/platform/src/lifecycle';

export const RELEASED_CONTRACT_FORMAT = 'sre-released-contract/1';

export interface ReleasedContract {
  readonly format: typeof RELEASED_CONTRACT_FORMAT;
  readonly apiVersion: string;
  /** Every released endpoint: "METHOD /path/{}" (path parameters unnamed). */
  readonly operations: readonly string[];
  /** Every event released to partners as a signed webhook. */
  readonly partnerEvents: readonly string[];
  /** A surface that is on its way out: announced on a date, with what replaces it. */
  readonly deprecations: readonly { readonly surface: string; readonly deprecatedOn: string; readonly replacement?: string }[];
}

/** One endpoint as the released contract names it. */
export const operationOf = (r: Pick<Route, 'method' | 'path'>): string => `${r.method} ${r.path.replace(/:[A-Za-z0-9_]+/g, '{}')}`;

export interface CurrentSurface {
  readonly operations: readonly string[];
  readonly partnerEvents: readonly string[];
}

export function currentSurfaceOf(routes: readonly Pick<Route, 'method' | 'path'>[], partnerEvents: readonly string[]): CurrentSurface {
  return { operations: [...new Set(routes.map(operationOf))].sort(), partnerEvents: [...new Set(partnerEvents)].sort() };
}

export interface UpgradeVerdict {
  readonly safeToDeploy: boolean;
  /** Each removed surface item, judged on its own (its own deprecation date). */
  readonly removed: readonly CompatibilityResult[];
  readonly added: { readonly operations: number; readonly partnerEvents: number };
  readonly detail: string;
}

/** Judge a build's surface against the released contract. */
export function assessUpgrade(input: { readonly released: ReleasedContract; readonly current: CurrentSurface; readonly today: string; readonly deprecationDays?: number }): UpgradeVerdict {
  const servedOps = new Set(input.current.operations);
  const servedEvents = new Set(input.current.partnerEvents);
  const removedSurface = [
    ...input.released.operations.filter((o) => !servedOps.has(o)),
    ...input.released.partnerEvents.filter((e) => !servedEvents.has(e)).map((e) => `webhook ${e}`),
  ];
  const removed = removedSurface.map((surface) => {
    const deprecation = input.released.deprecations.find((d) => d.surface === surface);
    return assessCompatibility({
      change: { contract: surface, fromVersion: input.released.apiVersion, toVersion: input.released.apiVersion, removed: [surface], added: [], ...(deprecation === undefined ? {} : { deprecatedOn: deprecation.deprecatedOn }) },
      // Who still calls a released surface is not measured per endpoint, so nobody is assumed gone: the full window applies.
      liveUsage: [],
      ...(input.deprecationDays === undefined ? {} : { deprecationDays: input.deprecationDays }),
      today: input.today,
    });
  });
  const releasedOps = new Set(input.released.operations);
  const releasedEvents = new Set(input.released.partnerEvents);
  const added = { operations: input.current.operations.filter((o) => !releasedOps.has(o)).length, partnerEvents: input.current.partnerEvents.filter((e) => !releasedEvents.has(e)).length };
  const blocked = removed.filter((r) => !r.safeToDeploy);
  return {
    safeToDeploy: blocked.length === 0,
    removed,
    added,
    detail: blocked.length === 0
      ? `${added.operations} endpoint(s) and ${added.partnerEvents} partner event(s) added; nothing released was taken away${removed.length === 0 ? '' : ` except ${removed.length} item(s) whose deprecation window has run`}`
      : `${blocked.length} released item(s) would be taken away without an elapsed deprecation window: ${blocked.map((b) => b.contract).join('; ')}`,
  };
}

/** The contract after a release: everything released stays released (a deprecation removes it only once its window ran). */
export function releaseContract(input: { readonly released: ReleasedContract | undefined; readonly current: CurrentSurface; readonly apiVersion: string; readonly today: string; readonly deprecationDays?: number }): ReleasedContract {
  const before = input.released;
  const days = input.deprecationDays ?? 180;
  const runOut = (surface: string): boolean => {
    const d = before?.deprecations.find((x) => x.surface === surface);
    return d !== undefined && (Date.parse(`${input.today}T00:00:00Z`) - Date.parse(`${d.deprecatedOn}T00:00:00Z`)) / 86_400_000 >= days;
  };
  const ops = new Set([...(before?.operations ?? []).filter((o) => input.current.operations.includes(o) || !runOut(o)), ...input.current.operations]);
  const events = new Set([...(before?.partnerEvents ?? []).filter((e) => input.current.partnerEvents.includes(e) || !runOut(`webhook ${e}`)), ...input.current.partnerEvents]);
  return {
    format: RELEASED_CONTRACT_FORMAT,
    apiVersion: input.apiVersion,
    operations: [...ops].sort(),
    partnerEvents: [...events].sort(),
    deprecations: (before?.deprecations ?? []).filter((d) => !runOut(d.surface) || ops.has(d.surface) || events.has(d.surface.replace(/^webhook /, ''))),
  };
}
