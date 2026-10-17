// WHO IS HOLDING THE PHONE — verified by this store computer, offline (Wave 4 · PA-06 = DF-3-c · OB-30 "A" · ADR-0019 ·
// ADR-0020 · §28 · hard rules #1, #4, #10).
//
// The warehouse, picker and driver phones used to record every scan, pick and stop under the ONE person the store setup
// named for the job (`workerId`, the wave's `pickerId`, the route's `driverId`). Two people sharing a phone were recorded
// as one, and a phone left on a shelf worked for whoever picked it up. The owner's decision (OB-30 "A"): each person signs
// in on the phone with the SAME personal PIN as the till, and their work is recorded as theirs.
//
//   • The PIN is checked HERE, on the box, by the till's own register (`TillOperators.signInOnDevice`) — same verifiers,
//     same guess limits, same fsync'd log. No network: the phones and the box keep working with head office unreachable.
//   • The person must hold the job's permission in the CURRENT store setup — the same permission head office re-checks on
//     that job's records — so a leaver or a removed role is refused at sign-in and at the next record.
//   • One person per phone at a time. Signing in ends whoever was signed in on that phone. A phone sign-in ends by
//     itself after four hours (OB-184); the bar at the top of the screen says how long it has left, and when it has ended.
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
 * How long after a person stops holding a phone their queued work is still taken from it: a shift (OB-185 "A", owner, 17
 * Oct 2026, "12 hours"). Work done offline on the phone reaches the box when the wifi comes back — perhaps after the next
 * person signed in — and is still theirs. Counted from when the sign-in ENDED (signed out, replaced, or its four-hour
 * limit, OB-184), so the two rules never meet: the four hours bound when work may be MADE under a sign-in, the twelve
 * hours how late it may still ARRIVE. Later than that it is refused with the reason, never silently lost.
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
 * OB-180: the sign-in page forgets every handheld page the phone's service workers kept. A kept page carries the last
 * person's sign-in stamp key; once this page shows, nobody is signed in on this phone (signed out, replaced, or ended), so
 * that page must never open again offline and let somebody else stamp records as them. The queued work is in the phone's
 * own storage, not in these caches, and is untouched.
 */
export const FORGET_KEPT_PAGES_SCRIPT = '<script>(function(){try{if(!self.caches)return;caches.keys().then(function(ks){ks.forEach(function(k){caches.open(k).then(function(c){c.keys().then(function(rs){rs.forEach(function(r){var p=new URL(r.url).pathname;if(/^[/](warehouse|picker|driver)[/](index[.]html)?$/.test(p))c.delete(r);});});});});});}catch(e){}})();</script>';

/**
 * The phone's sign-in page: staff ID and PIN, one button, English and Tamil. A plain form post, so it works on the
 * cheapest phone and nothing on the page can read the session (it comes back as an HttpOnly cookie). Its one script only
 * forgets the kept handheld pages (OB-180).
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
</main>${FORGET_KEPT_PAGES_SCRIPT}</body></html>`;
}

/**
 * OB-184: how long a phone sign-in has left, in the strip's words — English and Tamil — or that it has ended. The same
 * words the page's own script writes as the minutes pass (`SIGN_IN_LEFT_SCRIPT` mirrors this; a test binds the two).
 */
export function signInLeftWords(remainingMs: number): { readonly ended: boolean; readonly text: string } {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    return { ended: true, text: 'Your sign-in has ended. Sign out and sign in again. · உங்கள் உள்நுழைவு முடிந்தது. வெளியேறி மீண்டும் உள்நுழைக.' };
  }
  const minutes = Math.ceil(remainingMs / 60_000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return { ended: false, text: `Sign-in ends in ${h} h ${m} min · உள்நுழைவு முடிய ${h} மணி ${m} நிமிடம்` };
}

/**
 * The strip's own script: re-says the time left every half minute from what the box injected (`window.phoneSignIn`,
 * on the box's clock) and, for a page kept for offline use, when it was kept (`window.shellCachedAt`) — the same reading
 * of the clock the phone stamps by, so the strip says "ended" exactly when the phone stops stamping.
 *
 * OB-186 "A" (owner, 17 Oct 2026, "Lock the screen"): when the sign-in has ended the screen LOCKS — it goes to the phone's
 * sign-in page by itself (`lock`). It never asks the network: it replaces the whole screen with the sign-in page the box
 * packed into this strip (`L.page`, byte for byte the page the box serves at `L.url`) and the address becomes the sign-in
 * page's — so it works the same on a page opened from the phone's own cache with the wifi down as on a live one, and a
 * box that drops out at that very moment cannot leave the phone on an error page. Replacing the document removes the old
 * screen with its buttons and key listeners, so nothing more can be scanned. The sign-in page forgets the kept handheld
 * pages (OB-180), and nothing in the phone's queue is touched: it stays queued and is handed over under the next sign-in
 * (signing in there is an ordinary form post to the box, which then opens the screen afresh). `L` is `null` for a strip
 * with nothing to lock to (it then only says "ended", as before).
 */
const signInLeftScript = (lock: string): string => '<script>(function(){var d=document,w=window,t0=Date.now(),L=' + lock + ',locked=false;'
  + 'function lock(){if(L===null||locked)return;locked=true;try{w.history.replaceState(null,"",L.url);}catch(e){}d.open();d.write(L.page);d.close();}'
  + 'function say(){var el=d.querySelector("[data-sign-in-left]");var s=w.phoneSignIn;if(!el||!s)return;'
  + 'var at=typeof w.shellCachedAt==="string"&&isFinite(Date.parse(w.shellCachedAt))?Date.parse(w.shellCachedAt):t0;var off=Date.parse(s.boxNow)-at;if(!isFinite(off))off=0;'
  + 'var left=Date.parse(s.expiresAt)-(Date.now()+off);var txt;if(!isFinite(left)||left<=0){txt="Your sign-in has ended. Sign out and sign in again. \u00b7 உங்கள் உள்நுழைவு முடிந்தது. வெளியேறி மீண்டும் உள்நுழைக.";el.setAttribute("data-ended","");el.setAttribute("role","alert");el.style.background="#7f1d1d";el.style.color="#fee2e2";}'
  + 'else{var mins=Math.ceil(left/60000),h=Math.floor(mins/60),m=mins%60;txt="Sign-in ends in "+h+" h "+m+" min \u00b7 உள்நுழைவு முடிய "+h+" மணி "+m+" நிமிடம்";}if(el.textContent!==txt)el.textContent=txt;if(!isFinite(left)||left<=0)lock();}'
  + 'if(d.readyState==="loading")d.addEventListener("DOMContentLoaded",say);else say();setInterval(say,30000);})();</script>';

/** OB-186: the words on the sign-in page the screen locks to. */
export const SIGN_IN_ENDED_MESSAGE = 'Your sign-in has ended (4 hours). Sign in again — your saved work is kept. · உங்கள் உள்நுழைவு முடிந்தது (4 மணி). மீண்டும் உள்நுழைக — சேமித்த பணி பாதுகாப்பாக உள்ளது.';

/**
 * OB-186: what the strip locks to — the sign-in page's address for this job (marked `ended=1`, so the box says why), and
 * the sign-in page itself, exactly as the box serves it there, packed so it can be shown with no box in reach.
 */
export function signInLockOf(screen: HandheldSource, signInRoute: string): { readonly url: string; readonly page: string } {
  const action = `${signInRoute}?screen=${screen}`;
  return { url: `${action}&ended=1`, page: phoneSignInPage({ screen, action, message: SIGN_IN_ENDED_MESSAGE }) };
}

/** The lock as a script literal that cannot end the script it sits in (`<` and the two JS line breaks escaped). */
const lockLiteral = (lock: { readonly url: string; readonly page: string } | undefined): string =>
  lock === undefined ? 'null' : JSON.stringify(lock).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

const LEFT_STYLE = 'flex-basis:100%;margin:0;padding:4px 8px;border-radius:8px;font-size:14px';
const ENDED_STYLE = `${LEFT_STYLE};background:#7f1d1d;color:#fee2e2`;

/**
 * The strip at the top of a phone screen: who is signed in, the one button to hand the phone over, and (OB-184) how long
 * the sign-in has left — or, once it has ended, that it has; and (OB-186, `lockTo` from `signInLockOf`) at the end the
 * screen locks to the sign-in page by itself.
 */
export function phoneHolderStrip(input: { readonly displayName: string; readonly signOutAction: string; readonly expiresAt?: string; readonly now?: string; readonly lockTo?: { readonly url: string; readonly page: string } }): string {
  const left = input.expiresAt === undefined ? null : signInLeftWords(Date.parse(input.expiresAt) - Date.parse(input.now ?? new Date().toISOString()));
  return `<form method="post" action="${escapeHtml(input.signOutAction)}" data-phone-holder style="margin:0;display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;justify-content:space-between;padding:8px 12px;background:#1e293b;color:#f8fafc;font:15px/1.3 system-ui,sans-serif">`
    + `<span>Signed in: <strong>${escapeHtml(input.displayName)}</strong></span>`
    + `<button type="submit" style="font:inherit;font-weight:700;min-height:48px;padding:0 14px;border:0;border-radius:10px;background:#fbbf24;color:#1c1917">Sign out · வெளியேறு</button>`
    + (left === null ? '' : `<p data-sign-in-left${left.ended ? ' data-ended role="alert"' : ''} style="${left.ended ? ENDED_STYLE : LEFT_STYLE}">${escapeHtml(left.text)}</p>${signInLeftScript(lockLiteral(input.lockTo))}`)
    + `</form>`;
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
    stampFor: (token, deviceId) => register.stampFor(token, deviceLaneOf(deviceId)),
    verifyStamp: (stamp, event, deviceId) => register.verifyStamp(stamp, event, deviceLaneOf(deviceId)),
  };
}
