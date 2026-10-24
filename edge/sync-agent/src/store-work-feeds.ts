// The store's WORK feeds — OB-288 lane 2 · P2 (§31 · P-01 · P-08 · hard rule #4).
//
// The box relays work done with the line down UP to head office (the device-events queue). For that work to be DONE offline,
// the screens and handhelds need head office's last word on what there is to do, held on the box:
//   • production — the production runs on the board (what waits for a quality release, its batch and use-by) and the
//     registered recipes with the departments the shop operates (so a run captured offline names a real recipe, and a
//     counter label carries a use-by from the recipe's shelf life);
//   • food-safety — the food-safety checks in force for this store (kind, schedule, limits, items) and the slots head office
//     last knew (so the slots due while the line is down are worked out on the box with the same engine);
//   • transfers — the transfers with either end at this store (what is waiting to be sent, what is on the road to be
//     counted in), each with the store at each end so a handheld offers only this store's end;
//   • quality-holds (OB-333) — the batches head office holds on quality hold NOW, so a person who may release one can do so
//     at the store with the line down (the box relays the release; head office re-checks the person). Read under the box's
//     narrow release-only right; the box never places a hold.
//   • equipment (M26-FR-02 "readings cache/queue") — the store's monitored rooms and cabinets and their ranges, so the
//     facilities page offers a manual reading for each with the line down (head office judges the breach on arrival).
//   • help (M25-FR-04 "help works offline") — every published SOP with its English and Tamil words, the store's people and
//     the roles they hold, each one's latest acknowledgements, and the emergency contacts — the box's help page.
// Each is pulled on the box's sync loop under its own credential, shaped like the floor-indents pull (`indents-feed.ts`):
//   • Never put the token in a message (#4).
//   • Unreachable is not rejected: the box keeps the feed it holds and says how old it is (P-08), tries again next pass.
//   • Never go backwards: a feed assembled earlier than the one held is kept out.
//   • Carried whole: the box interprets only what it needs; the screens read the rest as head office wrote it.

export type WorkFeedName = 'production' | 'food-safety' | 'transfers' | 'quality-holds' | 'equipment' | 'help';
export const WORK_FEED_NAMES: readonly WorkFeedName[] = Object.freeze(['production', 'food-safety', 'transfers', 'quality-holds', 'equipment', 'help']);

/** One feed as the box holds it: head office's clock and the body (or bodies) it read. */
export interface WorkFeed {
  readonly name: WorkFeedName;
  /** Head office's clock when the feed was assembled — the screens' "as of". */
  readonly asAt: string;
  readonly body: Readonly<Record<string, unknown>>;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isTime = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(v));

/** The recipe fields the box INTERPRETS (offline capture, the counter label); everything else is carried. */
export interface FeedRecipe {
  readonly recipeId: string;
  readonly departmentId: string;
  readonly outputProductId: string;
  readonly outputUom: string;
  readonly shelfLifeHours: number;
  readonly [k: string]: unknown;
}
/** The run fields the box INTERPRETS. */
export interface FeedRun {
  readonly runId: string;
  readonly departmentId: string;
  readonly outputProductId: string;
  readonly outputBatchId: string;
  readonly expiresAt: string;
  readonly at?: string;
  readonly [k: string]: unknown;
}

/** Read the two production answers (runs, recipes) as the production feed, or say they are not one. */
export function readProductionFeed(runsBody: unknown, recipesBody: unknown): WorkFeed | undefined {
  if (!isObj(runsBody) || !isTime(runsBody['asAt']) || !Array.isArray(runsBody['runs'])) return undefined;
  if (!isObj(recipesBody) || !Array.isArray(recipesBody['recipes']) || !Array.isArray(recipesBody['enabledDepartments'])) return undefined;
  for (const r of runsBody['runs']) {
    if (!isObj(r) || !isStr(r['runId']) || !isStr(r['departmentId']) || !isStr(r['outputProductId']) || !isStr(r['outputBatchId']) || !isTime(r['expiresAt'])) return undefined;
  }
  for (const r of recipesBody['recipes']) {
    if (!isObj(r) || !isStr(r['recipeId']) || !isStr(r['departmentId']) || !isStr(r['outputProductId']) || !isStr(r['outputUom'])
      || typeof r['shelfLifeHours'] !== 'number' || !Number.isFinite(r['shelfLifeHours']) || (r['shelfLifeHours'] as number) <= 0) return undefined;
  }
  if (!(recipesBody['enabledDepartments'] as unknown[]).every(isStr)) return undefined;
  return {
    name: 'production', asAt: runsBody['asAt'] as string,
    body: { runs: runsBody['runs'], recipes: recipesBody['recipes'], enabledDepartments: recipesBody['enabledDepartments'] },
  };
}

/** Read head office's food-safety status for the store as the food-safety feed. */
export function readFoodSafetyFeed(body: unknown, asAt: string): WorkFeed | undefined {
  if (!isObj(body) || !Array.isArray(body['slots']) || !Array.isArray(body['checks'])) return undefined;
  for (const c of body['checks']) {
    if (!isObj(c) || !isStr(c['checkId']) || !isStr(c['kind']) || !isStr(c['branchId']) || !Array.isArray(c['items'])) return undefined;
  }
  for (const s of body['slots']) if (!isObj(s) || !isStr(s['checkId']) || !isTime(s['slotDueAt']) || !isStr(s['state'])) return undefined;
  const at = isTime(body['asAt']) ? body['asAt'] as string : asAt;
  return { name: 'food-safety', asAt: at, body: { slots: body['slots'], checks: body['checks'], receiving: Array.isArray(body['receiving']) ? body['receiving'] : [] } };
}

/** Read head office's transfers register (either end at this store) as the transfers feed. */
export function readTransfersFeed(body: unknown): WorkFeed | undefined {
  if (!isObj(body) || !isTime(body['asAt']) || !Array.isArray(body['transfers'])) return undefined;
  for (const row of body['transfers']) {
    if (!isObj(row) || !isObj(row['transfer'])) return undefined;
    const t = row['transfer'];
    if (!isStr(t['transferId']) || !isStr(t['state']) || !isStr(t['fromLocationId']) || !isStr(t['toLocationId']) || !Array.isArray(t['lines'])) return undefined;
    for (const l of t['lines'] as unknown[]) if (!isObj(l) || !isStr(l['productId']) || !Number.isInteger(l['quantityMinor'])) return undefined;
  }
  return { name: 'transfers', asAt: body['asAt'] as string, body: { transfers: body['transfers'] } };
}

/** OB-333: read head office's held batches (GET /v1/quality/holds-for-release) as the quality-holds feed. */
export function readQualityHoldsFeed(body: unknown): WorkFeed | undefined {
  if (!isObj(body) || !isTime(body['asAt']) || !Array.isArray(body['holds'])) return undefined;
  for (const h of body['holds']) if (!isObj(h) || !isStr(h['batchId']) || !isStr(h['productId']) || !isStr(h['reason']) || !isTime(h['heldAt'])) return undefined;
  return { name: 'quality-holds', asAt: body['asAt'] as string, body: { holds: body['holds'] } };
}

/** M26-FR-02: read the store's monitored equipment (GET /v1/facilities/equipment-feed) as the equipment feed. */
export function readEquipmentFeed(body: unknown): WorkFeed | undefined {
  if (!isObj(body) || !isTime(body['asAt']) || !Array.isArray(body['equipment'])) return undefined;
  for (const e of body['equipment']) {
    if (!isObj(e) || !isStr(e['assetId']) || !isStr(e['name']) || !isObj(e['range']) || !Number.isInteger(e['range']['minTenthsC']) || !Number.isInteger(e['range']['maxTenthsC'])) return undefined;
  }
  return { name: 'equipment', asAt: body['asAt'] as string, body: { equipment: body['equipment'] } };
}

/** M25-FR-04: read the help library (GET /v1/hr/workforce/help-library) as the help feed. */
export function readHelpFeed(body: unknown): WorkFeed | undefined {
  if (!isObj(body) || !isTime(body['asAt']) || !Array.isArray(body['sops']) || !Array.isArray(body['people']) || !Array.isArray(body['acknowledgements'])) return undefined;
  for (const s of body['sops']) if (!isObj(s) || !isStr(s['sopId']) || !isStr(s['title']) || !Number.isInteger(s['version']) || !Array.isArray(s['forRoles'])) return undefined;
  for (const p of body['people']) if (!isObj(p) || !isStr(p['employeeId']) || !Array.isArray(p['roles'])) return undefined;
  return {
    name: 'help', asAt: body['asAt'] as string,
    body: { sops: body['sops'], people: body['people'], acknowledgements: body['acknowledgements'], emergencyContacts: Array.isArray(body['emergencyContacts']) ? body['emergencyContacts'] : [], contactsSet: body['contactsSet'] === true },
  };
}

/** Read a held feed back (from the box's disk), by its own name. */
export function readWorkFeed(v: unknown): WorkFeed | undefined {
  if (!isObj(v) || !isStr(v['name']) || !(WORK_FEED_NAMES as readonly string[]).includes(v['name']) || !isTime(v['asAt']) || !isObj(v['body'])) return undefined;
  const name = v['name'] as WorkFeedName;
  const b = v['body'];
  const again = name === 'production'
    ? readProductionFeed({ asAt: v['asAt'], runs: b['runs'] }, { recipes: b['recipes'], enabledDepartments: b['enabledDepartments'] })
    : name === 'food-safety' ? readFoodSafetyFeed({ ...b, asAt: v['asAt'] }, v['asAt'] as string)
      : name === 'quality-holds' ? readQualityHoldsFeed({ asAt: v['asAt'], holds: b['holds'] })
        : name === 'equipment' ? readEquipmentFeed({ asAt: v['asAt'], equipment: b['equipment'] })
          : name === 'help' ? readHelpFeed({ ...b, asAt: v['asAt'] }) : readTransfersFeed({ asAt: v['asAt'], transfers: b['transfers'] });
  return again === undefined ? undefined : { ...again, asAt: v['asAt'] as string };
}

export type WorkFeedFetch =
  | { readonly status: 'fetched'; readonly feed: WorkFeed }
  /** Offline, timed out, a 5xx, an expired token, a body that is not the feed — keep what is held, try again. */
  | { readonly status: 'unreachable'; readonly reason: string };

export interface WorkFeedSource {
  readonly name: WorkFeedName;
  fetch(): Promise<WorkFeedFetch>;
}

export interface HttpWorkFeedOptions {
  readonly baseUrl: string;
  /** Bearer token for this store. Read from configuration; never logged (hard rule #4). */
  readonly token: string;
  /** The store this box is — the food-safety status is asked for it by name. */
  readonly storeId?: string;
  readonly timeoutMs?: number;
  /** Injected so the source stays testable without a network. */
  readonly fetch: typeof globalThis.fetch;
  readonly now?: () => string;
}

/** The head-office reads each feed is made of — under the store computer's own credential, never a person's. */
export const WORK_FEED_PATHS: Readonly<Record<WorkFeedName, (storeId: string | undefined) => readonly string[]>> = Object.freeze({
  production: () => ['/v1/production/runs', '/v1/production/recipes'],
  'food-safety': (storeId) => [storeId === undefined ? '/v1/facilities/food-safety/status' : `/v1/facilities/food-safety/status?branchId=${encodeURIComponent(storeId)}`],
  transfers: () => ['/v1/warehouse/transfers'],
  'quality-holds': () => ['/v1/quality/holds-for-release'],
  // Asked for this store by name; a box that has not been told its store reads nothing (the route refuses, said).
  equipment: (storeId) => [`/v1/facilities/equipment-feed?branchId=${encodeURIComponent(storeId ?? '')}`],
  help: (storeId) => [storeId === undefined ? '/v1/hr/workforce/help-library' : `/v1/hr/workforce/help-library?storeId=${encodeURIComponent(storeId)}`],
});

const WHAT: Readonly<Record<WorkFeedName, string>> = Object.freeze({ production: 'the production board', 'food-safety': 'the food-safety checks', transfers: 'the transfers', 'quality-holds': 'the batches on quality hold', equipment: 'the monitored equipment', help: 'the help library' });

/** Reach the real endpoints for one feed. Anything but a clean 200 for every read is "could not get it" (the status, never the body). */
export function httpWorkFeedSource(name: WorkFeedName, options: HttpWorkFeedOptions): WorkFeedSource {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const base = options.baseUrl.replace(/\/+$/, '');
  const now = options.now ?? ((): string => new Date().toISOString());
  return {
    name,
    fetch: async (): Promise<WorkFeedFetch> => {
      const bodies: unknown[] = [];
      for (const path of WORK_FEED_PATHS[name](options.storeId)) {
        const controller = new AbortController();
        const timer = setTimeout(() => { controller.abort(); }, timeoutMs);
        try {
          const response = await options.fetch(`${base}${path}`, { method: 'GET', headers: { authorization: `Bearer ${options.token}` }, signal: controller.signal });
          if (response.status < 200 || response.status >= 300) return { status: 'unreachable', reason: `the cloud answered ${response.status} for ${WHAT[name]}` };
          bodies.push(await response.json() as unknown);
        } catch (e) {
          const aborted = e instanceof Error && e.name === 'AbortError';
          return { status: 'unreachable', reason: aborted ? `no answer within ${timeoutMs}ms — the screens keep ${WHAT[name]} this box holds` : `could not reach the cloud — the screens keep ${WHAT[name]} this box holds` };
        } finally {
          clearTimeout(timer);
        }
      }
      const feed = name === 'production' ? readProductionFeed(bodies[0], bodies[1])
        : name === 'food-safety' ? readFoodSafetyFeed(bodies[0], now())
          : name === 'quality-holds' ? readQualityHoldsFeed(bodies[0])
            : name === 'equipment' ? readEquipmentFeed(bodies[0])
              : name === 'help' ? readHelpFeed(bodies[0]) : readTransfersFeed(bodies[0]);
      return feed === undefined ? { status: 'unreachable', reason: `the cloud returned something that is not ${WHAT[name]}` } : { status: 'fetched', feed };
    },
  };
}

export type WorkFeedPullStatus = 'updated' | 'unchanged' | 'kept' | 'offline';
export interface WorkFeedPullOutcome {
  readonly name: WorkFeedName;
  readonly status: WorkFeedPullStatus;
  readonly asAt: string | null;
  readonly ageMinutes: number | null;
  readonly staffMessage: string;
  readonly reason?: string;
}

export const workFeedAgeMinutes = (asAt: string, now: string): number => Math.max(0, Math.floor((Date.parse(now) - Date.parse(asAt)) / 60_000));

/** Pull one feed and, unless it is older than the one held, take it. `now` is injected so the age is deterministic. */
export async function pullWorkFeed(input: {
  readonly source: WorkFeedSource;
  readonly held: () => WorkFeed | undefined;
  readonly take: (feed: WorkFeed, receivedAt: string) => Promise<void> | void;
  readonly now: string;
}): Promise<WorkFeedPullOutcome> {
  const name = input.source.name;
  const shown = (): { asAt: string | null; ageMinutes: number | null } => {
    const h = input.held();
    return h === undefined ? { asAt: null, ageMinutes: null } : { asAt: h.asAt, ageMinutes: workFeedAgeMinutes(h.asAt, input.now) };
  };
  const held = input.held();
  const result = await input.source.fetch();
  if (result.status === 'unreachable') {
    return { name, status: 'offline', ...shown(), reason: result.reason, staffMessage: held === undefined ? `Cloud not reachable — the box has not been told ${WHAT[name]} yet.` : `Cloud not reachable — the box holds ${WHAT[name]} as of ${held.asAt}.` };
  }
  if (held !== undefined && Date.parse(result.feed.asAt) < Date.parse(held.asAt)) {
    return { name, status: 'kept', ...shown(), reason: 'older than held', staffMessage: `The cloud answered with OLDER ${WHAT[name]} than this box holds — ignored.` };
  }
  const changed = held === undefined || JSON.stringify(held.body) !== JSON.stringify(result.feed.body);
  await input.take(result.feed, input.now);
  return { name, status: changed ? 'updated' : 'unchanged', ...shown(), staffMessage: changed ? `${WHAT[name][0]!.toUpperCase()}${WHAT[name].slice(1)} updated from the cloud (as of ${result.feed.asAt}).` : `${WHAT[name][0]!.toUpperCase()}${WHAT[name].slice(1)} re-confirmed by the cloud.` };
}
