import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

// The guard on the guard, for the browser (GT-01 · hard rule #9 · P-08) — the twin of tests/migration/db-required-in-ci.test.ts.
//
// Every browser suite (`describe.skipIf(!HAVE_BROWSER)` across tests/e2e) skips itself when no Chromium is present.
// Right for a laptop; exactly wrong for a required CI job, which would skip all sixty-two files and go GREEN having
// proven nothing about any screen. The independent audit of 4 Oct 2026 found precisely that: the automatic build ran
// no browser suite at all. So the required browser job sets `BROWSER_TESTS_REQUIRED=1`, and when it does this test
// refuses to let the suite skip silently: the Chromium must exist AND launch, and the database the one connected
// browser suite needs must be configured. Locally (the flag unset) this asserts nothing and passes.

const REQUIRED = process.env['BROWSER_TESTS_REQUIRED'] === '1' || process.env['BROWSER_TESTS_REQUIRED'] === 'true';
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';

describe('the required browser suites are not allowed to silently skip', () => {
  it('has a real Chromium that launches, and a database for the connected suite, whenever BROWSER_TESTS_REQUIRED is set', async () => {
    if (!REQUIRED) {
      expect(REQUIRED).toBe(false);
      return;
    }
    expect(existsSync(CHROMIUM), `BROWSER_TESTS_REQUIRED is set but there is no Chromium at ${CHROMIUM} — every browser suite would skip`).toBe(true);
    const browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    const version = browser.version();
    await browser.close();
    expect(version, 'Chromium launched and reported a version').toMatch(/^\d+\./);
    expect(process.env['DATABASE_URL'], 'the connected browser suite (the store trades a day) needs DATABASE_URL, or it skips').toBeTruthy();
  });
});
