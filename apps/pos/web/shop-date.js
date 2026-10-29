// The SHOP's date on the till's plain pages (OB-606 · M01-FR-02) — never the till device's own date or zone.
//
// The store computer tells every page it serves the shop's zone from its SIGNED store pack (`window.shopTimeZone`; the
// till's own `posLane.timeZone` says the same), so this works with the cable out: no network call. A page served without
// either (an older box) takes the shop default, Asia/Kolkata — never the device's zone and never UTC. The same rule as
// packages/calendar/src/shop-day.ts, for a page that carries no bundle.

export const DEFAULT_SHOP_ZONE = 'Asia/Kolkata';

/** True when this runtime knows the IANA zone name. */
function knownZone(zone) {
  if (typeof zone !== 'string' || zone.trim() === '') return false;
  try { new Intl.DateTimeFormat('en-CA', { timeZone: zone }); return true; } catch { return false; }
}

/** The shop's zone the store computer told this page (`shopTimeZone`, else the lane's), else the shop default. */
export function shopZoneOf(win) {
  if (knownZone(win?.shopTimeZone)) return win.shopTimeZone;
  if (knownZone(win?.posLane?.timeZone)) return win.posLane.timeZone;
  return DEFAULT_SHOP_ZONE;
}

/** The shop's calendar date (YYYY-MM-DD) of an instant (ms or ISO), in the shop's zone. */
export function shopDateIn(at, zone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: knownZone(zone) ? zone : DEFAULT_SHOP_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(at));
  const part = (type) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}
