// The customer's "when will it come?" — the driver's last stamped stop and an ETA from the route (D08-FR-05 · M20-FR-03 ·
// WF-15 · P-08).
//
// There is no live map here (the maps provider is EXTERNAL), so the app is told only what head office actually knows:
// how many stops the driver has finished on the run that carries this order, when the last one was stamped, how many are
// still ahead of this customer, and an ESTIMATE of arrival — the route's planned arrival for this stop moved later by
// however late the driver was at the last stop he stamped. It is labelled an estimate on straight-line distances, and it
// is never earlier than the plan said. Nothing about any other customer's stop is given — no area, no order, no time of
// theirs — only counts.
//
// Pure and deterministic: the route, the stamps and the clock are supplied.

export interface EtaStop {
  readonly stopId: string;
  readonly orderId: string;
  /** 1-based position on the run. */
  readonly sequence: number;
  /** When the plan expected the driver there (straight-line estimate). */
  readonly plannedArrivalAt: string;
}

/** A stop the driver finished (delivered, partly delivered, failed, returned) and when the phone stamped it. */
export interface EtaStamp {
  readonly stopId: string;
  readonly at: string;
}

export type EtaState =
  /** The order is on no route head office assigned. */
  | 'not_on_a_route'
  /** On a route; the driver has not stamped any stop yet. */
  | 'not_started'
  /** The driver is on the way; some stops are done, this one is not. */
  | 'on_the_way'
  /** The driver has stamped this customer's own stop. */
  | 'reached';

export interface CustomerEta {
  readonly orderId: string;
  readonly state: EtaState;
  readonly stopsOnRun: number;
  readonly stopsDone: number;
  /** Stops still to be done before this customer's. */
  readonly stopsBeforeYou: number;
  /** When the driver stamped his most recent stop, if any. */
  readonly lastStopStampedAt: string | null;
  /** The estimate. Null when not on a route, and after this stop is reached. */
  readonly estimatedArrivalAt: string | null;
  /** How many minutes behind the plan the driver is, from his last stamp (never negative). */
  readonly behindPlanMinutes: number;
  readonly estimateIs: 'straight_line_estimate';
}

const MINUTE = 60_000;

export function customerEta(input: {
  readonly orderId: string;
  readonly stops: readonly EtaStop[];
  readonly stamps: readonly EtaStamp[];
}): CustomerEta {
  const base = { orderId: input.orderId, estimateIs: 'straight_line_estimate' as const };
  const mine = input.stops.find((s) => s.orderId === input.orderId);
  if (mine === undefined) {
    return { ...base, state: 'not_on_a_route', stopsOnRun: 0, stopsDone: 0, stopsBeforeYou: 0, lastStopStampedAt: null, estimatedArrivalAt: null, behindPlanMinutes: 0 };
  }
  const onRun = new Map(input.stops.map((s) => [s.stopId, s] as const));
  // The first stamp per stop is when it was finished; a later re-send is the same fact.
  const finished = new Map<string, string>();
  for (const s of input.stamps) {
    if (!onRun.has(s.stopId) || Number.isNaN(Date.parse(s.at))) continue;
    const prior = finished.get(s.stopId);
    if (prior === undefined || Date.parse(s.at) < Date.parse(prior)) finished.set(s.stopId, s.at);
  }
  const stopsDone = finished.size;
  const stopsBeforeYou = input.stops.filter((s) => s.sequence < mine.sequence && !finished.has(s.stopId)).length;
  let last: { stop: EtaStop; at: string } | undefined;
  for (const [stopId, at] of finished) {
    if (last === undefined || Date.parse(at) > Date.parse(last.at)) last = { stop: onRun.get(stopId)!, at };
  }
  const lastStopStampedAt = last?.at ?? null;
  if (finished.has(mine.stopId)) {
    return { ...base, state: 'reached', stopsOnRun: input.stops.length, stopsDone, stopsBeforeYou: 0, lastStopStampedAt, estimatedArrivalAt: null, behindPlanMinutes: 0 };
  }
  const behindMs = last === undefined ? 0 : Math.max(0, Date.parse(last.at) - Date.parse(last.stop.plannedArrivalAt));
  const behindPlanMinutes = Math.round(behindMs / MINUTE);
  return {
    ...base,
    state: last === undefined ? 'not_started' : 'on_the_way',
    stopsOnRun: input.stops.length, stopsDone, stopsBeforeYou, lastStopStampedAt,
    estimatedArrivalAt: new Date(Date.parse(mine.plannedArrivalAt) + behindMs).toISOString(),
    behindPlanMinutes,
  };
}
