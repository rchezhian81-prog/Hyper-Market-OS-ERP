// Repeat online orders on a schedule (M17-FR-02 "subscriptions" · owner decision OB-303, 23 Oct 2026: "repeat online
// orders on a schedule, placed automatically into M18; the customer can pause or cancel any time").
//
// A subscription is the customer's own plan — what, where, and on which days. Head office places each occurrence as an
// ordinary online order (the same promise, the same reservation, the same price as any order — nothing special-cased),
// the day before it is due or on the day, ONCE (the order's id is the subscription and the day). It never takes money by
// itself: no card is kept (hard rule #3), so each repeat order waits for the customer to pay in the app. Pausing and
// cancelling are one tap each and are facts on the record, never edits; a day the shop could not place is said, never
// skipped silently (P-08).
//
// Pure and deterministic: days are YYYY-MM-DD in the shop's own calendar, passed in.

export type SubscriptionSchedule =
  | { readonly kind: 'every_days'; readonly days: number }
  | { readonly kind: 'weekdays'; readonly weekdays: readonly number[] };

export interface SubscriptionPlan {
  readonly subscriptionId: string;
  readonly customerRef: string;
  readonly lines: readonly { readonly productId: string; readonly quantityMinor: number }[];
  readonly locationId: string;
  readonly schedule: SubscriptionSchedule;
  /** The first day it may repeat on. */
  readonly startsOn: string;
  readonly fulfilment: 'pickup' | 'delivery';
  /** For a delivery: where, and the slot start the customer prefers ("HH:MM", shop time). */
  readonly delivery?: { readonly location: { readonly lat: number; readonly lon: number }; readonly slotTime: string };
  readonly createdAt: string;
}

export interface SubscriptionChange {
  readonly subscriptionId: string;
  readonly change: 'paused' | 'resumed' | 'cancelled';
  readonly at: string;
  readonly by: string;
  readonly reason?: string;
}

export type SubscriptionState = 'active' | 'paused' | 'cancelled';

export const MAX_SUBSCRIPTION_LINES = 30;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Read a plan from the customer's request (their own ref and the server's clock are added by the caller). */
export function readSubscriptionPlan(raw: unknown): { readonly ok: true; readonly plan: Omit<SubscriptionPlan, 'subscriptionId' | 'customerRef' | 'createdAt'> } | { readonly ok: false; readonly detail: string } {
  const b = (raw ?? {}) as Record<string, unknown>;
  const lines = b['lines'];
  if (!Array.isArray(lines) || lines.length === 0 || lines.length > MAX_SUBSCRIPTION_LINES
    || !lines.every((l) => l !== null && typeof l === 'object' && typeof (l as Record<string, unknown>)['productId'] === 'string' && ((l as Record<string, unknown>)['productId'] as string).trim() !== ''
      && Number.isSafeInteger((l as Record<string, unknown>)['quantityMinor']) && ((l as Record<string, unknown>)['quantityMinor'] as number) > 0)) {
    return { ok: false, detail: `A repeat order needs 1 to ${MAX_SUBSCRIPTION_LINES} lines, each { productId, quantityMinor > 0 }.` };
  }
  if (new Set(lines.map((l) => (l as { productId: string }).productId)).size !== lines.length) return { ok: false, detail: 'Each product appears once in a repeat order.' };
  if (typeof b['locationId'] !== 'string' || b['locationId'].trim() === '') return { ok: false, detail: 'A repeat order names the store that fulfils it (locationId).' };
  const s = (b['schedule'] ?? {}) as Record<string, unknown>;
  let schedule: SubscriptionSchedule;
  if (s['kind'] === 'every_days' && Number.isSafeInteger(s['days']) && (s['days'] as number) >= 1 && (s['days'] as number) <= 31) schedule = { kind: 'every_days', days: s['days'] as number };
  else if (s['kind'] === 'weekdays' && Array.isArray(s['weekdays']) && s['weekdays'].length > 0 && s['weekdays'].every((d) => Number.isSafeInteger(d) && (d as number) >= 0 && (d as number) <= 6)) {
    schedule = { kind: 'weekdays', weekdays: [...new Set(s['weekdays'] as number[])].sort() };
  } else return { ok: false, detail: 'The schedule is { kind: "every_days", days: 1–31 } or { kind: "weekdays", weekdays: [0 (Sunday) … 6] }.' };
  if (typeof b['startsOn'] !== 'string' || !DAY.test(b['startsOn'])) return { ok: false, detail: 'startsOn is the first day, YYYY-MM-DD.' };
  if (b['fulfilment'] !== 'pickup' && b['fulfilment'] !== 'delivery') return { ok: false, detail: 'fulfilment is "pickup" or "delivery".' };
  let delivery: SubscriptionPlan['delivery'];
  if (b['fulfilment'] === 'delivery') {
    const d = (b['delivery'] ?? {}) as Record<string, unknown>;
    const loc = (d['location'] ?? {}) as Record<string, unknown>;
    if (typeof loc['lat'] !== 'number' || typeof loc['lon'] !== 'number' || Math.abs(loc['lat']) > 90 || Math.abs(loc['lon']) > 180 || typeof d['slotTime'] !== 'string' || !TIME.test(d['slotTime'])) {
      return { ok: false, detail: 'A delivered repeat order needs delivery: { location: { lat, lon }, slotTime: "HH:MM" }.' };
    }
    // Minimised: the location kept to about 100 m (three decimals), enough to find the door's slot radius.
    delivery = { location: { lat: Math.round((loc['lat'] as number) * 1000) / 1000, lon: Math.round((loc['lon'] as number) * 1000) / 1000 }, slotTime: d['slotTime'] as string };
  }
  return {
    ok: true,
    plan: {
      lines: (lines as { productId: string; quantityMinor: number }[]).map((l) => ({ productId: l.productId.trim(), quantityMinor: l.quantityMinor })),
      locationId: (b['locationId'] as string).trim(), schedule, startsOn: b['startsOn'] as string, fulfilment: b['fulfilment'],
      ...(delivery === undefined ? {} : { delivery }),
    },
  };
}

/** The state at an instant: the latest change at or before it. */
export function subscriptionStateAt(changes: readonly SubscriptionChange[], at: string): SubscriptionState {
  let state: SubscriptionState = 'active';
  for (const c of [...changes].sort((a, b) => a.at.localeCompare(b.at))) {
    if (c.at > at) break;
    if (state === 'cancelled') break;
    state = c.change === 'paused' ? 'paused' : c.change === 'resumed' ? 'active' : 'cancelled';
  }
  return state;
}

const dayNumber = (day: string): number => Math.floor(Date.parse(`${day}T00:00:00.000Z`) / 86_400_000);
export const addDays = (day: string, n: number): string => new Date((dayNumber(day) + n) * 86_400_000).toISOString().slice(0, 10);
const weekdayOf = (day: string): number => new Date(`${day}T00:00:00.000Z`).getUTCDay();

/** Whether the plan repeats on a day. */
export function occursOn(plan: Pick<SubscriptionPlan, 'schedule' | 'startsOn'>, day: string): boolean {
  if (day < plan.startsOn) return false;
  return plan.schedule.kind === 'every_days'
    ? (dayNumber(day) - dayNumber(plan.startsOn)) % plan.schedule.days === 0
    : plan.schedule.weekdays.includes(weekdayOf(day));
}

/** The next `count` days the plan repeats on, from `fromDay` (inclusive). */
export function nextOccurrences(plan: Pick<SubscriptionPlan, 'schedule' | 'startsOn'>, fromDay: string, count: number): readonly string[] {
  const out: string[] = [];
  for (let d = fromDay < plan.startsOn ? plan.startsOn : fromDay, i = 0; out.length < count && i < 400; d = addDays(d, 1), i += 1) if (occursOn(plan, d)) out.push(d);
  return out;
}

/** The order an occurrence becomes — the same id however many times the run comes round. */
export const occurrenceOrderId = (subscriptionId: string, day: string): string => `SUB-${subscriptionId}-${day}`.slice(0, 64);

/**
 * What a run should do for one plan today: PLACE the occurrences due today or tomorrow (while the plan is active now), and
 * name as MISSED any earlier occurrence within the last week that was never placed while the plan was active then.
 * Already placed or already said missed → nothing.
 */
export function dueToPlace(input: {
  readonly plan: SubscriptionPlan;
  readonly changes: readonly SubscriptionChange[];
  /** Days already placed, or already recorded as not placed. */
  readonly done: ReadonlySet<string>;
  readonly today: string;
  readonly now: string;
}): { readonly place: readonly string[]; readonly missed: readonly string[] } {
  const { plan, changes, done, today, now } = input;
  if (subscriptionStateAt(changes, now) === 'cancelled') return { place: [], missed: [] };
  const created = plan.createdAt.slice(0, 10);
  const place: string[] = [];
  const missed: string[] = [];
  for (let d = addDays(today, -7); d <= addDays(today, 1); d = addDays(d, 1)) {
    if (!occursOn(plan, d) || done.has(d) || d < created) continue;
    if (d >= today) { if (subscriptionStateAt(changes, now) === 'active') place.push(d); continue; }
    // A past day: missed only if the plan was active through that day.
    if (subscriptionStateAt(changes, `${d}T23:59:59.999Z`) === 'active' && subscriptionStateAt(changes, `${d}T00:00:00.000Z`) === 'active') missed.push(d);
  }
  return { place, missed };
}
