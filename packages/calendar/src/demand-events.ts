// D-24 (R4, signed OB-227 · OB-220) — the store's own calendar of festivals and local events, entered by a manager, and
// the weather link built SWITCHED OFF. Pure and deterministic.
//
// "A manager records a festival or local event for the store (dates and expected effect). The next forecasts and order
// proposals use it with no extra step, and each figure it changed names the event. … An effect never back-tested shows as
// 'manager's estimate'. The weather feed is built as a switched-off link, and nothing is sent or fetched while switched off."
//
//   • An event is recorded in VERSIONS (append-only, hard rule #2): a change is a new version, a withdrawal is a new fact.
//     The one in force is the latest version of each event that has not been withdrawn.
//   • An event applies to every product, or only to the products / categories the manager named.
//   • It becomes a forecast SIGNAL (packages/demand/src/forecast.ts `DemandSignal`) whose label is the event's own name,
//     so every forecast day it lifts says which event did it.
//   • The weather feed is a PORT. The only one production has is `WEATHER_FEED_SWITCHED_OFF`: it fetches nothing, sends
//     nothing, and says so. A test stand-in in the tests is the only other implementation, and only the owner's
//     choice of a provider would add a real one (OB-220, OB-222).

export type DemandEventKind = 'festival' | 'local_event';

export interface DemandEvent {
  readonly eventId: string;
  readonly version: number;
  readonly storeId: string;
  /** The event's name — what every figure it changes is labelled with (e.g. "Pongal"). */
  readonly label: string;
  readonly kind: DemandEventKind;
  /** YYYY-MM-DD, inclusive. */
  readonly from: string;
  readonly to: string;
  /** The manager's expected effect: 1.5 = half as much again; 0.8 = a fifth less. */
  readonly multiplier: number;
  /** Absent/empty: every product. */
  readonly productIds?: readonly string[];
  readonly categoryIds?: readonly string[];
  readonly recordedBy: string;
  readonly recordedAt: string;
  readonly withdrawn?: { readonly by: string; readonly at: string; readonly reason: string };
}

export class InvalidDemandEventError extends Error {
  constructor(message: string) { super(message); this.name = 'InvalidDemandEventError'; }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const realDay = (d: string): boolean => DAY.test(d) && new Date(`${d}T00:00:00.000Z`).toISOString().slice(0, 10) === d;

/** Check an event a manager entered; throws naming what is wrong. */
export function validateDemandEvent(e: Pick<DemandEvent, 'label' | 'kind' | 'from' | 'to' | 'multiplier'>): void {
  if (e.label.trim() === '' || e.label.length > 80) throw new InvalidDemandEventError('an event needs a name of 1 to 80 characters');
  if (e.kind !== 'festival' && e.kind !== 'local_event') throw new InvalidDemandEventError('an event is a festival or a local_event');
  if (!realDay(e.from) || !realDay(e.to) || e.to < e.from) throw new InvalidDemandEventError('an event needs real from and to days (YYYY-MM-DD), from on or before to');
  if (!Number.isFinite(e.multiplier) || e.multiplier <= 0 || e.multiplier > 20) throw new InvalidDemandEventError('the expected effect must be a number above 0 and at most 20 (1.5 = half as much again)');
}

/** The events in force: the latest version of each, leaving out the withdrawn ones. */
export function eventsInForce(all: readonly DemandEvent[]): DemandEvent[] {
  const latest = new Map<string, DemandEvent>();
  for (const e of all) {
    const held = latest.get(e.eventId);
    if (held === undefined || e.version >= held.version) latest.set(e.eventId, e);
  }
  return [...latest.values()].filter((e) => e.withdrawn === undefined).sort((a, b) => a.from.localeCompare(b.from) || a.eventId.localeCompare(b.eventId));
}

/** Whether an event reaches this product (its own id, or its category or any parent of it). */
export function eventApplies(e: DemandEvent, productId: string, categoryChain: readonly string[] = []): boolean {
  const products = e.productIds ?? [];
  const categories = e.categoryIds ?? [];
  if (products.length === 0 && categories.length === 0) return true;
  return products.includes(productId) || categories.some((c) => categoryChain.includes(c));
}

export interface EventSignal {
  readonly from: string;
  readonly to: string;
  readonly multiplier: number;
  readonly label: string;
  readonly eventId: string;
}

/** The forecast signals for one product: every event in force that reaches it and overlaps [fromDay, toDay]. */
export function signalsFor(events: readonly DemandEvent[], input: { readonly productId: string; readonly categoryChain?: readonly string[]; readonly storeId?: string; readonly fromDay: string; readonly toDay: string }): EventSignal[] {
  return eventsInForce(events)
    .filter((e) => (input.storeId === undefined || e.storeId === input.storeId) && e.to >= input.fromDay && e.from <= input.toDay)
    .filter((e) => eventApplies(e, input.productId, input.categoryChain ?? []))
    .map((e) => ({ from: e.from, to: e.to, multiplier: e.multiplier, label: e.label, eventId: e.eventId }));
}

/**
 * Earlier occurrences of the same event — same name (case and spacing ignored) and store, ending before `beforeDay`. These
 * are what an effect can be back-tested on; with none, the effect is the manager's estimate.
 */
export function earlierOccurrences(events: readonly DemandEvent[], e: DemandEvent, beforeDay: string): DemandEvent[] {
  const key = (x: DemandEvent) => `${x.storeId}\u001f${x.label.trim().toLowerCase().replace(/\s+/g, ' ')}`;
  return eventsInForce(events).filter((x) => x.eventId !== e.eventId && key(x) === key(e) && x.to < beforeDay);
}

// ── the weather link (OB-220: switched off) ─────────────────────────────────────────────────────────────────────────

export interface WeatherSignal { readonly from: string; readonly to: string; readonly multiplier: number; readonly label: string }

export interface WeatherFeedPort {
  readonly name: string;
  /** False in production: no provider is chosen (OB-220). */
  readonly switchedOn: boolean;
  /** Asks the provider. NEVER called while switched off. */
  fetch(storeId: string, fromDay: string, toDay: string): Promise<readonly WeatherSignal[]>;
}

/** The only weather link production has: switched off. It fetches nothing and sends nothing. */
export const WEATHER_FEED_SWITCHED_OFF: WeatherFeedPort = Object.freeze({
  name: 'weather feed (switched off — no provider chosen, OB-220)',
  switchedOn: false,
  fetch: async (): Promise<readonly WeatherSignal[]> => { throw new Error('the weather feed is switched off: nothing is fetched or sent (OB-220)'); },
});

/** What the forecast gets from the weather link: nothing while it is switched off, and it says so. */
export async function weatherSignals(port: WeatherFeedPort, storeId: string, fromDay: string, toDay: string): Promise<{ readonly state: 'switched_off' | 'on'; readonly signals: readonly WeatherSignal[]; readonly detail: string }> {
  if (!port.switchedOn) return { state: 'switched_off', signals: [], detail: 'Weather is switched off (OB-220): no provider is chosen, nothing is fetched or sent, and no forecast uses it.' };
  const signals = await port.fetch(storeId, fromDay, toDay);
  return { state: 'on', signals, detail: `${port.name}: ${signals.length} signal(s)` };
}
