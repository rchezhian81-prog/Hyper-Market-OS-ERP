// WHO IS HOLDING THE PHONE — verified by this store computer, offline (Wave 4 · PA-06 = DF-3-c · OB-28 "A" · ADR-0019 ·
// ADR-0020 · §28 · hard rules #1, #4, #10).
//
// The warehouse, picker and driver phones used to record every scan, pick and stop under the ONE person the store setup
// named for the job (`workerId`, the wave's `pickerId`, the route's `driverId`). Two people sharing a phone were recorded
// as one, and a phone left on a shelf worked for whoever picked it up. The owner's decision (OB-28 "A"): each person signs
// in on the phone with the SAME personal PIN as the till, and their work is recorded as theirs.
//
//   • The PIN is checked HERE, on the box, by the till's own register (`TillOperators.signInOnDevice`) — same verifiers,
//     same guess limits, same fsync'd log. No network: the phones and the box keep working with head office unreachable.
//   • The person must hold the job's permission in the CURRENT store setup — the same permission head office re-checks on
//     that job's records — so a leaver or a removed role is refused at sign-in and at the next record.
//   • One person per phone at a time. Signing in ends whoever was signed in on that phone.
//   • The served screen is readdressed to the signed-in person, so the phone stamps THEM on every record it makes.
//   • Every record a phone hands over must name a person who held THAT phone — signed in now, or within the last shift (the
//     box's own log and clock decide; never the phone's clock). Anything else is REFUSED with the reason — visible on the
//     phone as a record a person must look at, never quietly re-stamped (hard rule #10).
//
// Neither the PIN nor the session token is ever written anywhere but the session's hash in the box's log (#4).

import type { DomainEvent } from '../../../packages/contracts/src/event';
import type { HandheldSource } from '../../../packages/sync/src/device-relay';
import { deviceLaneOf, type TillOperators } from './till-operators';
import type { PhoneOperators } from './device-server';

/** The permission each phone's job needs — exactly the one head office re-verifies on that job's records. */
export const HANDHELD_AUTHORITY: Readonly<Record<HandheldSource, string>> = Object.freeze({
  // services/inventory/src/warehouse-synced.ts MOVE_PERMISSION
  warehouse: 'inventory.movement.append',
  // services/fulfilment/src/waves.ts PICK_PERMISSION
  picker: 'fulfilment.pack.record',
  // services/fulfilment/src/driver-runs.ts DRIVE_PERMISSION
  driver: 'delivery.attempt.record',
});

/** Where each phone record names the person who did it. A record type not listed here is not a phone's to send. */
export const HANDHELD_PERSON_FIELD: Readonly<Record<string, string>> = Object.freeze({
  StockCounted: 'counterId',
  AdjustmentRequested: 'requestedBy',
  WarehouseMovementApplied: 'movedBy',
  ReceivingScanned: 'receivedBy',
  ReceivingCompleted: 'completedBy',
  FloorIndentIssued: 'issuedBy',
  PickLineResolved: 'pickedBy',
  WavePacked: 'packedBy',
  DeliveryStopUpdated: 'driverId',
  RouteSettled: 'driverId',
  DriverCashHandedOver: 'driverId',
});

/**
 * How long after a person stops holding a phone their queued work is still taken from it: a shift. Work done offline on
 * the phone reaches the box when the wifi comes back — perhaps after the next person signed in — and is still theirs.
 */
export const PHONE_HANDOVER_WINDOW_MS = 12 * 3_600_000;

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The person a phone record names — or the reason it names nobody the box can hold to account. A put-away also names the
 * mover inside its command; the two must agree, or the record says two different things about who did it.
 */
export function personNamedBy(event: DomainEvent): { readonly ok: true; readonly userId: string } | { readonly ok: false; readonly reason: string } {
  const field = HANDHELD_PERSON_FIELD[event.type];
  if (field === undefined) return { ok: false, reason: `${event.type} is not a phone record` };
  const payload = isObj(event.payload) ? event.payload : {};
  const named = payload[field];
  if (typeof named !== 'string' || named.trim() === '') return { ok: false, reason: `the record does not say who did it (${field})` };
  const command = payload['command'];
  if (event.type === 'WarehouseMovementApplied' && isObj(command) && command['movedBy'] !== undefined && command['movedBy'] !== named) {
    return { ok: false, reason: 'the record names two different people as the mover' };
  }
  return { ok: true, userId: named };
}

/** The screen's own field naming the person doing the job. */
const PERSON_KEY: Readonly<Record<HandheldSource, string>> = Object.freeze({ warehouse: 'workerId', picker: 'pickerId', driver: 'driverId' });

/**
 * The screen's payload as the SIGNED-IN person's: the field naming who does the job becomes them, so every record the phone
 * makes names them. Work head office handed to SOMEBODY ELSE by name (a wave for another picker, a route for another driver)
 * is not theirs to do — it is withheld (null: the phone shows no work), never silently re-assigned.
 */
export function asPhoneHolder(screen: HandheldSource, payload: Record<string, unknown> | null, userId: string): Record<string, unknown> | null {
  if (payload === null) return null;
  const key = PERSON_KEY[screen];
  const named = payload[key];
  if (screen !== 'warehouse' && typeof named === 'string' && named !== '' && named !== userId) return null;
  return { ...payload, [key]: userId };
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));
}

const JOB_WORDS: Readonly<Record<HandheldSource, string>> = Object.freeze({
  warehouse: 'Warehouse · கிடங்கு',
  picker: 'Picking · எடுத்தல்',
  driver: 'Delivery · விநியோகம்',
});

/**
 * The phone's sign-in page: staff ID and PIN, one button, English and Tamil. A plain form post — no script, so it works on
 * the cheapest phone and nothing on the page can read the session (it comes back as an HttpOnly cookie).
 */
export function phoneSignInPage(input: { readonly screen: HandheldSource; readonly action: string; readonly message: string | null }): string {
  const notice = input.message === null ? '' : `<p class="notice" role="alert">${escapeHtml(input.message)}</p>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in on this phone · உள்நுழைக</title>
<style>
  body{margin:0;font:17px/1.45 system-ui,sans-serif;background:#0f172a;color:#f8fafc;display:grid;place-items:center;min-height:100dvh}
  main{width:min(480px,92vw);display:grid;gap:14px;padding:20px}
  h1{font-size:22px;margin:0}h1 small{display:block;font-size:15px;color:#cbd5e1;font-weight:400}
  label{display:grid;gap:6px;font-weight:600}label small{color:#cbd5e1;font-weight:400}
  input{font:inherit;padding:14px;border-radius:12px;border:2px solid #334155;background:#1e293b;color:#f8fafc;min-height:56px}
  input:focus-visible,button:focus-visible{outline:3px solid #fbbf24;outline-offset:2px}
  button{font:inherit;font-weight:700;min-height:64px;border:0;border-radius:14px;background:#22c55e;color:#052e16;font-size:19px}
  .notice{margin:0;padding:12px 14px;border-radius:12px;background:#7f1d1d;color:#fee2e2}
</style></head><body><main>
  <h1>Sign in on this phone<small>${escapeHtml(JOB_WORDS[input.screen])} — உங்கள் பணியாளர் எண் மற்றும் PIN</small></h1>
  ${notice}
  <form method="post" action="${escapeHtml(input.action)}">
    <label>Staff ID <small>பணியாளர் எண் — scan your badge or key it</small><input name="staffId" autocomplete="off" autocapitalize="none" required></label>
    <label>PIN <small>உங்கள் PIN — the same six digits as the till</small><input name="pin" type="password" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="off" required></label>
    <button type="submit">Sign in · உள்நுழை</button>
  </form>
</main></body></html>`;
}

/** The strip at the top of a phone screen: who is signed in, and the one button to hand the phone over. */
export function phoneHolderStrip(input: { readonly displayName: string; readonly signOutAction: string }): string {
  return `<form method="post" action="${escapeHtml(input.signOutAction)}" data-phone-holder style="margin:0;display:flex;gap:12px;align-items:center;justify-content:space-between;padding:8px 12px;background:#1e293b;color:#f8fafc;font:15px/1.3 system-ui,sans-serif">`
    + `<span>Signed in: <strong>${escapeHtml(input.displayName)}</strong></span>`
    + `<button type="submit" style="font:inherit;font-weight:700;min-height:48px;padding:0 14px;border:0;border-radius:10px;background:#fbbf24;color:#1c1917">Sign out · வெளியேறு</button></form>`;
}

/** Put the strip at the top of the page body (after the opening tag). A page with no body tag is served as it is. */
export function withPhoneHolderStrip(html: string, strip: string): string {
  return html.replace(/<body([^>]*)>/i, (m) => `${m}${strip}`);
}

/** The till's register, addressed by the DEVICE: the one way the phones' door asks who is holding a phone. */
export function phoneOperatorsOf(register: TillOperators): PhoneOperators {
  return {
    signIn: (i) => register.signInOnDevice(i),
    check: (token, deviceId) => register.check(token, deviceLaneOf(deviceId)),
    signOut: (token) => register.signOut(token),
    heldRecently: (userId, deviceId) => register.heldRecently(userId, deviceLaneOf(deviceId), PHONE_HANDOVER_WINDOW_MS),
  };
}
