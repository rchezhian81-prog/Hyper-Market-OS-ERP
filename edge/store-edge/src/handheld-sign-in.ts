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
import { DRIVER_PHONE_AUTHORITY, PHONE_LATE_ARRIVAL_MS, deviceLaneOf, type TillOperators } from './till-operators';
import { PHONE_CLOCK_MARKS_KEY, PHONE_CLOCK_TOLERANCE_MS } from '../../../packages/sync/src/sign-in-stamp';
import type { PhoneOperators } from './device-server';

/** The permission each phone's job needs — exactly the one head office re-verifies on that job's records. */
export const HANDHELD_AUTHORITY: Readonly<Record<HandheldSource, string>> = Object.freeze({
  // services/inventory/src/warehouse-synced.ts MOVE_PERMISSION
  warehouse: 'inventory.movement.append',
  // services/fulfilment/src/waves.ts PICK_PERMISSION
  picker: 'fulfilment.pack.record',
  // services/fulfilment/src/driver-runs.ts DRIVE_PERMISSION — the job whose sign-in lasts the shift (OB-187)
  driver: DRIVER_PHONE_AUTHORITY,
});

/** Where each phone record names the person who did it. A record type not listed here is not a phone's to send. */
export const HANDHELD_PERSON_FIELD: Readonly<Record<string, string>> = Object.freeze({
  StockCounted: 'counterId',
  AdjustmentRequested: 'requestedBy',
  WarehouseMovementApplied: 'movedBy',
  ReceivingScanned: 'receivedBy',
  ReceivingCompleted: 'completedBy',
  DsdCheckInClosed: 'receivedBy',
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
export const PHONE_HANDOVER_WINDOW_MS = PHONE_LATE_ARRIVAL_MS;

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
  *{box-sizing:border-box}
  body{margin:0;font:17px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans","Noto Sans Tamil","Nirmala UI","Latha",sans-serif;background:#f5f7f2;color:#193b31;display:grid;place-items:start center;min-height:100dvh;-webkit-text-size-adjust:100%}
  main{width:min(451px,100%);margin:16px 0;padding:24px 20px 28px;display:grid;gap:18px;background:#fff;border:1px solid #dce4d9;border-top:3px solid #17654f;border-radius:12px;box-shadow:0 1px 2px rgba(25,47,39,.06),0 6px 16px rgba(25,47,39,.08)}
  @media (max-width:500px){main{margin:0;min-height:100dvh;border-radius:0;border-left:0;border-right:0;align-content:start}}
  .job{justify-self:start;margin:0;padding:4px 12px;border-radius:999px;background:#eaf0e1;color:#143f32;font-size:14px;font-weight:600;line-height:1.4}
  h1{font-size:24px;line-height:1.25;letter-spacing:-.01em;margin:0}h1 small{display:block;margin-top:6px;font-size:16px;color:#586e61;font-weight:400;letter-spacing:0;line-height:1.5}
  form{display:grid;gap:18px}
  label{display:grid;gap:6px;font-weight:600;font-size:17px}label small{color:#586e61;font-weight:400;font-size:15px}
  input{font:inherit;font-size:20px;letter-spacing:.02em;padding:0 16px;border-radius:8px;border:1px solid #819483;background:#fcfdfb;color:#193b31;min-height:56px;width:100%}
  input:focus-visible,button:focus-visible{outline:3px solid #17654f;outline-offset:2px}
  input:focus-visible{box-shadow:0 0 0 4px rgba(23,101,79,.18)}
  button{font:inherit;font-weight:700;font-size:19px;min-height:60px;width:100%;margin-top:4px;border:1px solid #17654f;border-radius:8px;background:#17654f;color:#fff;box-shadow:0 1px 2px rgba(25,47,39,.12);cursor:pointer}
  button:active{background:#0f4636;border-color:#0f4636}
  .notice{margin:0;padding:12px 14px 12px 12px;border-radius:8px;background:#fcf0ec;color:#a13932;border:1px solid #f3d6cf;border-left:4px solid #a13932;font-weight:600;font-size:16px;line-height:1.5}
</style></head><body><main>
  <p class="job">${escapeHtml(JOB_WORDS[input.screen])}</p>
  <h1>Sign in on this phone<small>உங்கள் பணியாளர் எண் மற்றும் PIN</small></h1>
  ${notice}
  <form method="post" action="${escapeHtml(input.action)}">
    <label>Staff ID <small>பணியாளர் எண் — scan your badge or key it</small><input name="staffId" autocomplete="off" autocapitalize="none" required></label>
    <label>PIN <small>உங்கள் PIN — the same six digits as the till</small><input name="pin" type="password" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="off" required></label>
    <button type="submit">Sign in · உள்நுழை</button>
  </form>
</main>${FORGET_KEPT_PAGES_SCRIPT}</body></html>`;
}

/** The strip's words once the sign-in has ended (OB-184), and once the phone's clock was turned back (verifier hh NEW-1). */
const SIGN_IN_ENDED_WORDS = 'Your sign-in has ended. Sign out and sign in again. · உங்கள் உள்நுழைவு முடிந்தது. வெளியேறி மீண்டும் உள்நுழைக.';
const SIGN_IN_CLOCK_WORDS = 'This phone\'s clock was turned back: your sign-in has ended. Sign in again. · கைபேசியின் நேரம் பின்னோக்கி மாற்றப்பட்டது: உங்கள் உள்நுழைவு முடிந்தது. மீண்டும் உள்நுழைக.';

/**
 * OB-184: how long a phone sign-in has left, in the strip's words — English and Tamil — or that it has ended. The same
 * words the page's own script writes as the minutes pass (`SIGN_IN_LEFT_SCRIPT` mirrors this; a test binds the two).
 */
export function signInLeftWords(remainingMs: number): { readonly ended: boolean; readonly text: string } {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return { ended: true, text: SIGN_IN_ENDED_WORDS };
  const minutes = Math.ceil(remainingMs / 60_000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return { ended: false, text: `Sign-in ends in ${h} h ${m} min · உள்நுழைவு முடிய ${h} மணி ${m} நிமிடம்` };
}

/**
 * The strip's own script: re-says the time left every half minute (and whenever the screen comes back into view) from
 * what the box injected (`window.phoneSignIn`, on the box's clock) and, for a page kept for offline use, when it was kept
 * (`window.shellCachedAt`) — the same reading of the clock the phone stamps by (`signInClock` in
 * packages/sync/src/sign-in-stamp.ts: the same marks under `PHONE_CLOCK_MARKS_KEY`, the same tolerance, the same
 * stopwatch check), so the strip says "ended" exactly when the phone stops stamping. A clock turned back — earlier than the
 * latest time this sign-in's pages have seen, earlier than when the page was served, or running slower than the page's
 * stopwatch — ends the sign-in too (verifier hh NEW-1), and for good: the mark remembers it.
 *
 * OB-186 "A" (owner, 17 Oct 2026, "Lock the screen"): when the sign-in has ended the screen LOCKS — it goes to the phone's
 * sign-in page by itself (`lock`). It never asks the network: it replaces the whole screen with the sign-in page the box
 * packed into this strip (`L.page`, byte for byte the page the box serves at `L.url`; `L.clock` for a clock turned back)
 * and the address becomes the sign-in page's — so it works the same on a page opened from the phone's own cache with the
 * wifi down as on a live one, and a box that drops out at that very moment cannot leave the phone on an error page.
 * Replacing the document removes the old screen with its buttons and key listeners, so nothing more can be scanned. Before
 * it does, the lock runs the page's own lock hooks (`window.phoneSignInOnLock`: the screen's sync timers stop and the stamp
 * key is dropped from memory) and forgets `window.phoneSignIn` (verifier hh L3). The page's queue calls `lock` itself
 * (`window.phoneSignInLock`) the moment a record finds the sign-in ended, rather than at the next tick (L2). The sign-in
 * page forgets the kept handheld pages (OB-180), and nothing in the phone's queue is touched: it stays queued and is
 * handed over under the next sign-in. `L` is `null` for a strip with nothing to lock to (it then only says "ended").
 */
const signInLeftScript = (lock: string): string => '<script>(function(){var d=document,w=window,t0=Date.now(),L=' + lock + ',locked=false,tk=null,mem=null,K=' + JSON.stringify(PHONE_CLOCK_MARKS_KEY) + ',TOL=' + String(PHONE_CLOCK_TOLERANCE_MS) + ';'
  + 'function P(){try{return typeof performance!=="undefined"&&performance&&typeof performance.now==="function"?performance.now():NaN;}catch(e){return NaN;}}var p0=P();'
  + 'function num(v){return typeof v==="number"&&isFinite(v);}'
  + 'function ls(){try{return w.localStorage||null;}catch(e){return null;}}'
  + 'function all(){var s=ls(),raw=null;try{raw=s?s.getItem(K):null;}catch(e){}if(raw===null)raw=mem;try{var v=raw===null?null:JSON.parse(raw);if(v&&typeof v==="object"&&!(v instanceof Array))return v;}catch(e){}return {};}'
  + 'function save(ref,m){var a=all();a[ref]=m;var t=JSON.stringify(a);mem=t;var s=ls();try{if(s)s.setItem(K,t);}catch(e){}}'
  + 'function lock(why){if(L===null||locked)return;locked=true;var hs=w.phoneSignInOnLock;if(hs&&hs.length)for(var i=0;i<hs.length;i++){try{hs[i]();}catch(e){}}'
  + 'try{w.phoneSignIn=undefined;}catch(e){}if(tk!==null){try{clearInterval(tk);}catch(e){}}var pg=why==="clock_set_back"&&L.clock?L.clock:L;'
  + 'try{w.history.replaceState(null,"",pg.url);}catch(e){}d.open();d.write(pg.page);d.close();}'
  + 'w.phoneSignInLock=function(why){lock(why==="clock_set_back"?why:"expired");};'
  + 'function say(){if(locked)return;var el=d.querySelector("[data-sign-in-left]");var s=w.phoneSignIn;if(!el||!s)return;'
  + 'var at=typeof w.shellCachedAt==="string"&&isFinite(Date.parse(w.shellCachedAt))?Date.parse(w.shellCachedAt):t0;var served=Date.parse(s.boxNow),exp=Date.parse(s.expiresAt),off=served-at;if(!isFinite(off))off=0;'
  + 'var m=all()[s.ref];if(!m||typeof m!=="object")m={};var why=null,left=NaN;'
  + 'if(m.e){why=m.e==="expired"?"expired":"clock_set_back";}else{var wall=Date.now(),est=wall+(num(m.o)?m.o:off),fl=Math.max(num(m.m)?m.m:-Infinity,num(served)?served:-Infinity),ran=P()-p0;'
  + 'var back=!isFinite(est)||est<fl-TOL||(num(ran)&&wall-t0<ran-TOL),now=Math.max(est,fl);'
  + 'if(back||!(now<exp)){why=back?"clock_set_back":"expired";m.e=why;m.x=exp;save(s.ref,m);}else{m.m=now;m.x=exp;save(s.ref,m);left=exp-now;}}'
  + 'var txt;if(why!==null){txt=why==="clock_set_back"?' + JSON.stringify(SIGN_IN_CLOCK_WORDS) + ':' + JSON.stringify(SIGN_IN_ENDED_WORDS) + ';el.setAttribute("data-ended","");el.setAttribute("role","alert");el.style.background="#7f1d1d";el.style.color="#fee2e2";}'
  + 'else{var mins=Math.ceil(left/60000),h=Math.floor(mins/60),mm=mins%60;txt="Sign-in ends in "+h+" h "+mm+" min · உள்நுழைவு முடிய "+h+" மணி "+mm+" நிமிடம்";}if(el.textContent!==txt)el.textContent=txt;if(why!==null)lock(why);}'
  + 'if(d.readyState==="loading")d.addEventListener("DOMContentLoaded",say);else say();tk=setInterval(say,30000);'
  + 'if(typeof d.addEventListener==="function")d.addEventListener("visibilitychange",say);if(typeof w.addEventListener==="function"){w.addEventListener("pageshow",say);w.addEventListener("focus",say);}})();</script>';

/** OB-186: the words on the sign-in page a warehouse or picker screen locks to (four hours, OB-184). */
export const SIGN_IN_ENDED_MESSAGE = 'Your sign-in has ended (4 hours). Sign in again — your saved work is kept. · உங்கள் உள்நுழைவு முடிந்தது (4 மணி). மீண்டும் உள்நுழைக — சேமித்த பணி பாதுகாப்பாக உள்ளது.';
/** OB-187: the words on the sign-in page the driver screen locks to (twelve hours). */
export const DRIVER_SIGN_IN_ENDED_MESSAGE = 'Your sign-in has ended (12 hours). Sign in again at the shop — your saved work is kept. · உங்கள் உள்நுழைவு முடிந்தது (12 மணி). கடையில் மீண்டும் உள்நுழைக — சேமித்த பணி பாதுகாப்பாக உள்ளது.';
/** Verifier hh NEW-1: the words on the sign-in page a screen locks to when the phone's clock was turned back. */
export const SIGN_IN_CLOCK_MESSAGE = 'This phone\'s clock was turned back, so your sign-in has ended. Sign in again — your saved work is kept. Do not change the phone\'s date or time. · கைபேசியின் நேரம் பின்னோக்கி மாற்றப்பட்டதால் உங்கள் உள்நுழைவு முடிந்தது. மீண்டும் உள்நுழைக — சேமித்த பணி பாதுகாப்பாக உள்ளது. கைபேசியின் தேதி, நேரத்தை மாற்ற வேண்டாம்.';

/** The words on the sign-in page a screen locks to, for this job (`ended=1`) or for a clock turned back (`ended=clock`). */
export function signInEndedMessageFor(screen: HandheldSource, why: 'ended' | 'clock' = 'ended'): string {
  if (why === 'clock') return SIGN_IN_CLOCK_MESSAGE;
  return screen === 'driver' ? DRIVER_SIGN_IN_ENDED_MESSAGE : SIGN_IN_ENDED_MESSAGE;
}

/** What a locked screen shows: the sign-in page's address and the page itself. */
export interface SignInLockPage { readonly url: string; readonly page: string }
/** What the strip locks to: at the sign-in's end, and (`clock`) when the phone's clock was turned back. */
export interface SignInLock extends SignInLockPage { readonly clock: SignInLockPage }

/**
 * OB-186: what the strip locks to — the sign-in page's address for this job (marked `ended=1`, or `ended=clock` for a
 * clock turned back, so the box says why), and the sign-in page itself, exactly as the box serves it there, packed so it
 * can be shown with no box in reach.
 */
export function signInLockOf(screen: HandheldSource, signInRoute: string): SignInLock {
  const action = `${signInRoute}?screen=${screen}`;
  return {
    url: `${action}&ended=1`, page: phoneSignInPage({ screen, action, message: signInEndedMessageFor(screen) }),
    clock: { url: `${action}&ended=clock`, page: phoneSignInPage({ screen, action, message: SIGN_IN_CLOCK_MESSAGE }) },
  };
}

/** The lock as a script literal that cannot end the script it sits in (`<` and the two JS line breaks escaped). */
const lockLiteral = (lock: (SignInLockPage & { readonly clock?: SignInLockPage }) | undefined): string =>
  lock === undefined ? 'null' : JSON.stringify(lock).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

const LEFT_STYLE = 'margin:0;min-width:0';
const ENDED_STYLE = `${LEFT_STYLE};background:var(--error-surface,#fbe9e7);color:var(--danger-text,#a03e36)`;

/**
 * OB-205: the strip's look — the handheld's own tokens (the page it is put on carries the shared foundation), each with
 * the light set's value as a fallback. The signed-in person and the time left are chips: an icon from the one set beside
 * the words (the screen's own script puts the icon in each `data-sre-icon` slot; with no icon set the words stand alone),
 * a clock while the sign-in runs, a lock once it has ended — so the state is never told by colour alone. The ended words
 * are written by the strip's script as an inline dark red; the rule below keeps them on the readable red tint instead.
 */
const STRIP_STYLE = '<style>'
  + '[data-phone-holder]{margin:0;display:flex;flex-wrap:wrap;gap:8px 10px;align-items:center;justify-content:space-between;padding:10px 16px;background:var(--panel,#fff);color:var(--ink,#25362e);border-bottom:1px solid var(--line,#dce3de);font:15px/1.35 var(--font,system-ui,sans-serif)}'
  + '[data-phone-holder] .hh-chip{display:inline-flex;align-items:center;gap:8px;min-width:0;padding:6px 12px 6px 10px;border-radius:999px;background:var(--panel-2,#eef2ef);border:1px solid var(--line,#dce3de);font-size:15px}'
  + '[data-phone-holder] .hh-who{flex:1 1 12em;border-radius:8px;min-height:44px}'
  + '[data-phone-holder] .hh-who strong{font-weight:700;overflow-wrap:break-word}'
  + '[data-phone-holder] [data-sre-icon]{display:inline-flex;flex:none}[data-phone-holder] [data-sre-icon]:empty{display:none}'
  + '[data-phone-holder] [data-sre-icon] svg{width:18px;height:18px}'
  + '[data-phone-holder] .hh-out{flex:1 0 auto;font:inherit;font-size:16px;font-weight:700;min-height:56px;padding:0 16px;border:1px solid var(--field-line,#7f8d86);border-radius:8px;background:var(--panel,#fff);color:var(--ink,#25362e);cursor:pointer;box-shadow:var(--shadow-xs,none)}'
  + '[data-phone-holder] .hh-out:focus-visible{outline:3px solid var(--focus,#0f4c3a);outline-offset:2px}'
  + '[data-phone-holder] .hh-left{flex:1 1 100%;border-radius:8px;padding:8px 12px 8px 10px;align-items:flex-start;background:var(--ok-surface,#e3f1ea);color:var(--on-ok-surface,#0f4c3a);border-color:var(--ok-surface,#e3f1ea);border-left:4px solid var(--ok,#16614d);font-weight:600}'
  + '[data-phone-holder] .hh-left [data-sre-icon]{margin-top:1px}'
  // The ended look twice over: once for the strip the box drew ended (`is-ended`), once for the moment the script ends it
  // (`:has`) — separate rules, so a phone whose browser lacks `:has` still keeps the first.
  + '[data-phone-holder] .hh-left [data-sre-icon="lock"]{display:none}'
  + '[data-phone-holder] .hh-left.is-ended [data-sre-icon="clock"]{display:none}'
  + '[data-phone-holder] .hh-left.is-ended [data-sre-icon="lock"]:not(:empty){display:inline-flex}'
  + '[data-phone-holder] .hh-left.is-ended{background:var(--error-surface,#fbe9e7);color:var(--danger-text,#a03e36);border-color:var(--error-surface,#fbe9e7);border-left-color:var(--danger-text,#a03e36)}'
  + '[data-phone-holder] .hh-left:has([data-ended]) [data-sre-icon="clock"]{display:none}'
  + '[data-phone-holder] .hh-left:has([data-ended]) [data-sre-icon="lock"]:not(:empty){display:inline-flex}'
  + '[data-phone-holder] .hh-left:has([data-ended]){background:var(--error-surface,#fbe9e7);color:var(--danger-text,#a03e36);border-color:var(--error-surface,#fbe9e7);border-left-color:var(--danger-text,#a03e36)}'
  + '[data-phone-holder] .hh-left p[data-ended]{background:transparent!important;color:var(--danger-text,#a03e36)!important}'
  + '</style>';

/**
 * The strip at the top of a phone screen: who is signed in, the one button to hand the phone over, and (OB-184) how long
 * the sign-in has left — or, once it has ended, that it has; and (OB-186, `lockTo` from `signInLockOf`) at the end the
 * screen locks to the sign-in page by itself.
 */
export function phoneHolderStrip(input: { readonly displayName: string; readonly signOutAction: string; readonly expiresAt?: string; readonly now?: string; readonly lockTo?: SignInLockPage & { readonly clock?: SignInLockPage } }): string {
  const left = input.expiresAt === undefined ? null : signInLeftWords(Date.parse(input.expiresAt) - Date.parse(input.now ?? new Date().toISOString()));
  return `${STRIP_STYLE}<form method="post" action="${escapeHtml(input.signOutAction)}" data-phone-holder>`
    + `<span class="hh-chip hh-who sre-with-icon"><span data-sre-icon="user-round" aria-hidden="true"></span><span>Signed in: <strong>${escapeHtml(input.displayName)}</strong></span></span>`
    + `<button type="submit" class="hh-out">Sign out · வெளியேறு</button>`
    + (left === null ? '' : `<div class="hh-chip hh-left sre-with-icon${left.ended ? ' is-ended' : ''}"><span data-sre-icon="clock" aria-hidden="true"></span><span data-sre-icon="lock" aria-hidden="true"></span><p data-sign-in-left${left.ended ? ' data-ended role="alert"' : ''} style="${left.ended ? ENDED_STYLE : LEFT_STYLE}">${escapeHtml(left.text)}</p></div>${signInLeftScript(lockLiteral(input.lockTo))}`)
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
