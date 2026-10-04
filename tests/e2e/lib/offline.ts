import { expect, type Page } from './harness-types';

/**
 * Prove the network is CUT for this page's world — by trying it, not by trusting `navigator.onLine`.
 *
 * `navigator.onLine` under Playwright's offline emulation is true on some runners (the first run of the required
 * browser job on GitHub, 4 Oct 2026, failed 26 tests on exactly that flag while every page still opened from its
 * cache). The flag is a hint about the OS, not proof about the page. This asks the page's own world to make a request
 * that no service worker will answer for it: a WRITE to the page's own address. Every screen's worker refuses to
 * intercept a write (tests/guardrails/every-screen-opens-without-a-network.test.ts, "still refuses to intercept a
 * write"), so the request goes to the network — and with the network cut it fails; online, the server answers with
 * some status. "cut" is the only acceptable outcome.
 */
export async function expectNetworkCut(page: Page, label = 'the page'): Promise<void> {
  const outcome = await page.evaluate(
    "fetch(location.href, { method: 'POST', cache: 'no-store', headers: { 'content-type': 'text/plain' }, body: 'probe' }).then((r) => 'reached ' + r.status, () => 'cut')",
  ) as string;
  expect(outcome, `${label} still reaches the network (a write to its own address was ${outcome})`).toBe('cut');
}
