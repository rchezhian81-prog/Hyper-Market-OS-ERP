import { describe, it, expect } from 'vitest';
import { runInNewContext } from 'node:vm';
import {
  FORGET_KEPT_PAGES_SCRIPT, SIGN_IN_ENDED_MESSAGE, phoneHolderStrip, phoneSignInPage, signInLockOf,
} from '../../edge/store-edge/src/handheld-sign-in';
import { PHONE_SIGN_IN_ROUTE } from '../../edge/store-edge/src/device-server';
import { makeEvent } from '../../packages/contracts/src/event';
import { stamperForPage } from '../../packages/sync/src/sign-in-stamp';

/**
 * **OB-186 "A" (owner, 17 Oct 2026, "Lock the screen"): when a handheld's 4-hour sign-in (OB-184) ends, the phone's screen
 * locks — it goes to the phone's sign-in page by itself, even with no box in reach.** Work already queued stays queued
 * (nothing here touches the phone's storage) and is handed over under the next sign-in (OB-180).
 *
 * The strip's own script, run as the phone runs it (a sandbox with the phone's clock, its network, its address bar and its
 * page): it locks exactly when the phone's stamper stops stamping — the same reading of the clock (`window.phoneSignIn`
 * and, for a kept page, `window.shellCachedAt`); it puts up the sign-in page the box packed (the page the box serves there,
 * which forgets the kept handheld pages) without asking the network; it locks once; a strip with nothing to lock to does
 * not. The real box is tests/integration/ob186-*.test.ts; a real browser, tests/e2e/ob186-*.e2e.ts. Synthetic data only.
 */

const T0 = Date.parse('2026-10-17T08:00:00.000Z');
const H = 3_600_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const KEY = 'ab'.repeat(32);

interface Phone {
  now: number;
  readonly asked: string[];
  readonly address: string[];
  readonly written: string[];
  opened: number;
  tick: (() => void) | null;
  readonly strip: { textContent: string; readonly attrs: Record<string, string>; readonly style: Record<string, string> };
}

/** The script inside a strip (the lock's copy of the sign-in page has every `<` escaped, so the first `</script>` ends it). */
const scriptOf = (strip: string): string => {
  const start = strip.indexOf('<script>') + '<script>'.length;
  return strip.slice(start, strip.indexOf('</script>', start));
};

/** Run the strip's script on a pretend phone whose clock reads `now`. */
function phoneRunning(strip: string, win: { phoneSignIn: unknown; shellCachedAt?: string }, now: number): Phone {
  const el = { textContent: '', attrs: {} as Record<string, string>, style: {} as Record<string, string>, setAttribute(k: string, v: string) { this.attrs[k] = v; } };
  const phone: Phone = { now, asked: [], address: [], written: [], opened: 0, tick: null, strip: el };
  const window = {
    ...win,
    // The network: the lock must never need it.
    fetch: (url: string) => { phone.asked.push(url); return Promise.reject(new Error('no network')); },
    location: { replace: (url: string) => { phone.asked.push(url); }, assign: (url: string) => { phone.asked.push(url); } },
    history: { replaceState: (_s: unknown, _t: string, url: string) => { phone.address.push(url); } },
  };
  const document = {
    readyState: 'complete',
    querySelector: (sel: string) => (sel === '[data-sign-in-left]' ? el : null),
    open: () => { phone.opened += 1; },
    write: (html: string) => { phone.written.push(html); },
    close: () => undefined,
  };
  runInNewContext(scriptOf(strip), {
    window, document, isFinite, Math,
    Date: { now: () => phone.now, parse: (s: string) => Date.parse(s) },
    setInterval: (fn: () => void) => { phone.tick = fn; return 1; },
  });
  return phone;
}

const signIn = (boxNow: number) => ({ ref: 'r-1', userId: 'u-a', signedInAt: iso(T0), expiresAt: iso(T0 + 4 * H), key: KEY, boxNow: iso(boxNow) });
const lock = signInLockOf('warehouse', PHONE_SIGN_IN_ROUTE);
const stripFor = (lockTo: typeof lock | undefined): string => phoneHolderStrip({ displayName: 'A', signOutAction: '/device/sign-out?screen=warehouse', expiresAt: iso(T0 + 4 * H), now: iso(T0), ...(lockTo === undefined ? {} : { lockTo }) });
const scan = makeEvent({ id: 'e-1', type: 'ReceivingScanned', occurredAt: iso(T0), idempotencyKey: 'k-1', source: 'A-1', payload: { grnId: 'g', receivedBy: 'u-a' } });

describe('OB-186: what the screen locks to', () => {
  it('the sign-in page for this job — the page the box serves there, saying why, forgetting the kept pages', () => {
    for (const screen of ['warehouse', 'picker', 'driver'] as const) {
      const l = signInLockOf(screen, PHONE_SIGN_IN_ROUTE);
      expect(l.url).toBe(`/device/sign-in?screen=${screen}&ended=1`);
      expect(l.page).toBe(phoneSignInPage({ screen, action: `/device/sign-in?screen=${screen}`, message: SIGN_IN_ENDED_MESSAGE }));
      expect(l.page).toContain(`<form method="post" action="/device/sign-in?screen=${screen}">`);
      expect(l.page).toContain(FORGET_KEPT_PAGES_SCRIPT);
      expect(l.page).toContain('role="alert"');
    }
    expect(SIGN_IN_ENDED_MESSAGE).toContain('your saved work is kept');
  });

  it('the strip carries it inside its script, unable to close the script early', () => {
    const strip = stripFor(lock);
    expect(strip.match(/<script>/g)).toHaveLength(1);
    expect(strip.match(/<\/script>/g)).toHaveLength(1);
    expect(strip).toContain('\\u003cform method=\\"post\\" action=\\"/device/sign-in?screen=warehouse\\"');
    expect(strip).not.toContain('<form method="post" action="/device/sign-in');
    // A strip with nothing to lock to still only counts down (OB-184 as it was).
    expect(stripFor(undefined)).toContain(',L=null,');
  });
});

describe('OB-186: the strip\'s own script locks the screen at the end of the sign-in', () => {
  it('a live page: nothing at 3 h 59 m; at 4 h the sign-in page replaces the screen and the address is the sign-in page\'s — once', () => {
    const phone = phoneRunning(stripFor(lock), { phoneSignIn: signIn(T0) }, T0);
    expect(phone.strip.textContent).toBe('Sign-in ends in 4 h 0 min · உள்நுழைவு முடிய 4 மணி 0 நிமிடம்');
    phone.now = T0 + 4 * H - 60_000;
    phone.tick!();
    expect([phone.opened, phone.written, phone.address]).toEqual([0, [], []]);
    phone.now = T0 + 4 * H;
    phone.tick!();
    expect(phone.strip.attrs).toMatchObject({ role: 'alert' });
    expect(phone.opened).toBe(1);
    expect(phone.written).toEqual([lock.page]);
    expect(phone.address).toEqual([lock.url]);
    phone.now = T0 + 5 * H;
    phone.tick!();
    expect(phone.written).toHaveLength(1); // it locks once
    expect(phone.asked).toEqual([]); // and never needed the network
  });

  it('a page opened from the phone\'s cache locks exactly where the phone\'s stamper stops — the same clock reading', () => {
    // The box served the page at 09:00 on its clock; the phone's clock read 08:30 when its service worker kept it (it runs
    // half an hour slow). The page is opened from the cache much later, with no box in reach.
    const win = { phoneSignIn: signIn(T0 + H), shellCachedAt: iso(T0 + H / 2) };
    const phone = phoneRunning(stripFor(lock), win, T0 + 3 * H);
    const stamper = stamperForPage(win, () => iso(phone.now))!;
    // 11:29:59 on the phone = 11:59:59 on the box: still stamping, still unlocked.
    phone.now = T0 + 3.5 * H - 1000;
    phone.tick!();
    expect(stamper(scan)).toMatchObject({ userId: 'u-a' });
    expect(phone.opened).toBe(0);
    // 11:30 on the phone = 12:00 on the box, the end: the stamper stops and the screen locks at the same moment.
    phone.now = T0 + 3.5 * H;
    expect(stamper(scan)).toBeUndefined();
    phone.tick!();
    expect(phone.written).toEqual([lock.page]);
    expect(phone.address).toEqual([lock.url]);
    expect(phone.asked).toEqual([]);
  });

  it('a kept page already past its end when it opens locks at once', () => {
    const phone = phoneRunning(stripFor(lock), { phoneSignIn: signIn(T0), shellCachedAt: iso(T0) }, T0 + 5 * H);
    expect(phone.written).toEqual([lock.page]);
  });

  it('a live page is judged on the box\'s clock: opened late on a fast phone, it still has its four hours', () => {
    const phone = phoneRunning(stripFor(lock), { phoneSignIn: signIn(T0) }, T0 + 5 * H);
    expect(phone.strip.textContent).toContain('Sign-in ends in 4 h 0 min');
    expect(phone.written).toEqual([]);
  });

  it('a strip with nothing to lock to only says "ended"; a page with no sign-in does nothing', () => {
    const plain = phoneRunning(stripFor(undefined), { phoneSignIn: signIn(T0), shellCachedAt: iso(T0) }, T0 + 5 * H);
    expect(plain.strip.attrs).toMatchObject({ role: 'alert' });
    expect([plain.opened, plain.written]).toEqual([0, []]);
    const none = phoneRunning(stripFor(lock), { phoneSignIn: undefined, shellCachedAt: iso(T0) }, T0 + 5 * H);
    expect([none.opened, none.written]).toEqual([0, []]);
  });
});
