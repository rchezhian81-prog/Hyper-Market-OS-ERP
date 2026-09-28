// Hosted demo — authenticated BROWSER workflow check (runbook §9.1). Non-production, synthetic data.
//
// Drives a real headless Chromium against the live demo URL, through the real HTTPS front and the
// real DEMO-ONLY sign-in, as each seeded demo role:
//   sign in on /login/ → lands on that role's screen → session cookie is HttpOnly+Secure+SameSite=Strict
//   → the DEMO banner is visible → the screen's own /v1 calls carry the session (status recorded)
//   → the role is REFUSED an out-of-role action (403) → sign-out → the API answers 401 again.
// Plus: no session → 401; wrong password → refused with no cookie.
//
// Credentials: for any role with no demo login yet, a TEMPORARY `check.<role>` login is added with a
// random password held only in this process's memory, and removed again at the end (even on failure).
// No password is ever printed or written anywhere but the hashed login file.
//
//   pnpm run check:browser -- --base https://<demo-host> [--out DIR]

import { mkdirSync, readFileSync, writeFileSync, renameSync, chownSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type BrowserContext } from 'playwright-core';
import { addLogin, generatePassword, loginFileProblems, COOKIE_NAME, type DemoLoginFile } from '../demo-login/login';

const arg = (name: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

interface RoleCase {
  readonly userId: string;
  /** The screen this role works in. */
  readonly screen: string;
  /** An API read this role must NOT be allowed (expect 403). */
  readonly forbidden?: string;
  /** An API read this role MUST be allowed (expect 200). */
  readonly allowed?: string;
}

// Role → screen → a refused and an allowed read, drawn from demo-uat.test.ts's role matrix.
const CASES: readonly RoleCase[] = [
  { userId: 'pilot-owner', screen: '/owner/', allowed: '/v1/platform/entitlements' },
  { userId: 'pilot-manager', screen: '/erp/', forbidden: '/v1/platform/entitlements' },
  { userId: 'pilot-cashier', screen: '/pos/', forbidden: '/v1/platform/entitlements' },
  { userId: 'pilot-accountant', screen: '/erp/finance.html', forbidden: '/v1/platform/entitlements' },
  { userId: 'pilot-ca', screen: '/erp/', forbidden: '/v1/platform/entitlements' },
  { userId: 'pilot-platform-admin', screen: '/erp/admin.html' },
  { userId: 'pilot-supplier', screen: '/supplier/', forbidden: '/v1/platform/entitlements' },
];

function readFile(path: string): DemoLoginFile {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  const problems = loginFileProblems(parsed);
  if (problems.length > 0) throw new Error(`login file unusable: ${problems.join('; ')}`);
  return parsed as DemoLoginFile;
}

function writeFileAtomic(path: string, file: DemoLoginFile): void {
  const { uid, gid } = statSync(path);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  try { chownSync(tmp, uid, gid); } catch { /* not root */ }
  renameSync(tmp, path);
}

interface Result {
  userId: string;
  login: string;
  temporaryLogin: boolean;
  signedIn: boolean;
  landedOn: string;
  cookie: { httpOnly: boolean; secure: boolean; sameSite: string } | null;
  bannerVisible: boolean;
  me: { status: number; permissions: number };
  screenApiCalls: Array<{ path: string; status: number }>;
  screenSays: string;
  forbidden?: { path: string; status: number };
  allowed?: { path: string; status: number };
  afterSignOut: number;
  screenshot: string;
  browserNotes?: string[];
}

async function main(): Promise<number> {
  const base = (arg('base') ?? '').replace(/\/+$/, '');
  const loginFile = arg('login-file', '/etc/sre-pilot/demo-login/logins.json')!;
  const out = arg('out', '/var/lib/sre-pilot/evidence/browser-check')!;
  if (!base.startsWith('https://')) {
    console.error('Usage: pnpm run check:browser -- --base https://<demo-host> [--out DIR]');
    return 2;
  }
  mkdirSync(out, { recursive: true });

  // Temporary logins for roles that have none, passwords in memory only.
  const original = readFile(loginFile);
  const passwords = new Map<string, { login: string; password: string; temporary: boolean }>();
  let working = original;
  for (const c of CASES) {
    if (working.logins.some((l) => l.userId === c.userId)) continue;
    const login = `check.${c.userId.replace(/^pilot-/, '')}`;
    const password = generatePassword();
    working = addLogin(working, { login, userId: c.userId, password, createdBy: 'browser-check (temporary)', now: new Date() });
    passwords.set(c.userId, { login, password, temporary: true });
  }
  writeFileAtomic(loginFile, working);

  const results: Result[] = [];
  const general: Record<string, unknown> = {};
  const browser = await chromium.launch();
  try {
    // The certificate is self-signed by owner choice; its fingerprint is verified separately.
    const newContext = (): Promise<BrowserContext> => browser.newContext({ ignoreHTTPSErrors: true, locale: 'en-IN' });

    // No session → the API refuses; wrong password → refused, no cookie.
    {
      const ctx = await newContext();
      const page = await ctx.newPage();
      await page.goto(`${base}/erp/`);
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
      general['noSessionApiStatus'] = await page.evaluate(async () => (await fetch('/v1/identity/me', { credentials: 'same-origin' })).status);
      await page.goto(`${base}/login/`);
      await page.fill('#login', 'check.nobody');
      await page.fill('#password', 'definitely-wrong');
      const [resp] = await Promise.all([page.waitForResponse((r) => r.url().endsWith('/login/') && r.request().method() === 'POST'), page.click('button[type=submit]')]);
      general['wrongPasswordStatus'] = resp.status();
      general['wrongPasswordCookie'] = (await ctx.cookies()).some((c) => c.name === COOKIE_NAME);
      await ctx.close();
    }

    for (const c of CASES) {
      const cred = passwords.get(c.userId);
      if (cred === undefined) {
        // The role already has a real person's login; we never learn its password, so it is skipped here.
        results.push({
          userId: c.userId, login: '(personal login exists — not used by the check)', temporaryLogin: false, signedIn: false,
          landedOn: '', cookie: null, bannerVisible: false, me: { status: 0, permissions: 0 }, screenApiCalls: [],
          screenSays: 'skipped', afterSignOut: 0, screenshot: '',
        });
        continue;
      }
      const ctx = await newContext();
      const page = await ctx.newPage();
      const apiCalls: Array<{ path: string; status: number }> = [];
      const problems: string[] = [];
      page.on('requestfailed', (r) => { problems.push(`request failed: ${new URL(r.url()).pathname} (${r.failure()?.errorText ?? '?'})`); });
      page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text().slice(0, 160)}`); });
      page.on('framenavigated', (f) => { if (f === page.mainFrame()) problems.push(`navigated: ${new URL(f.url()).pathname}`); });
      page.on('response', (r) => {
        const u = new URL(r.url());
        if (u.pathname.startsWith('/v1/')) apiCalls.push({ path: u.pathname, status: r.status() });
      });

      await page.goto(`${base}/login/?next=${encodeURIComponent(c.screen)}`);
      await page.fill('#login', cred.login);
      await page.fill('#password', cred.password);
      await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15_000 }).catch(() => undefined), page.click('button[type=submit]')]);
      const landedOn = new URL(page.url()).pathname;
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);

      const cookie = (await ctx.cookies()).find((k) => k.name === COOKIE_NAME);
      const bannerVisible = await page.locator('#demo-pilot-banner').isVisible().catch(() => false);
      const me = await page.evaluate(async () => {
        try {
          const r = await fetch('/v1/identity/me', { credentials: 'same-origin' });
          const body = r.ok ? await r.json() as { permissions?: unknown[] } : {};
          return { status: r.status, permissions: Array.isArray(body.permissions) ? body.permissions.length : 0 };
        } catch { return { status: -1, permissions: 0 }; } // -1 = the browser could not complete the call
      });
      const status = (path: string) => page.evaluate(async (p) => {
        try { return (await fetch(p, { credentials: 'same-origin' })).status; } catch { return -1; }
      }, path);
      const screenSays = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 240);
      const screenshot = join(out, `${c.userId}.png`);
      await page.screenshot({ path: screenshot, fullPage: false });

      const result: Result = {
        userId: c.userId, login: cred.login, temporaryLogin: cred.temporary, signedIn: landedOn === new URL(c.screen, base).pathname,
        landedOn, cookie: cookie === undefined ? null : { httpOnly: cookie.httpOnly, secure: cookie.secure, sameSite: cookie.sameSite },
        bannerVisible, me, screenApiCalls: apiCalls.filter((a) => a.path !== '/v1/identity/me'), screenSays,
        ...(c.forbidden === undefined ? {} : { forbidden: { path: c.forbidden, status: await status(c.forbidden) } }),
        ...(c.allowed === undefined ? {} : { allowed: { path: c.allowed, status: await status(c.allowed) } }),
        afterSignOut: 0, screenshot, browserNotes: problems,
      };

      // Sign out from the sign-in page's own button, then the API must refuse again.
      await page.goto(`${base}/login/`);
      await Promise.all([page.waitForURL((u) => u.pathname.startsWith('/login'), { timeout: 15_000 }), page.click('form[action="/login/logout"] button')]);
      // Ask from a screen, not the sign-in page: the sign-in page's CSP (default-src 'none') forbids fetch.
      await page.goto(`${base}${c.screen}`);
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
      result.afterSignOut = await status('/v1/identity/me');
      results.push(result);
      await ctx.close();
    }
  } finally {
    await browser.close();
    // Remove ONLY the temporary logins this run added; anything a person added meanwhile is kept.
    const temp = new Set([...passwords.values()].filter((p) => p.temporary).map((p) => p.login));
    const now = readFile(loginFile);
    writeFileAtomic(loginFile, { version: 1, logins: now.logins.filter((l) => !temp.has(l.login)) });
    passwords.clear();
  }

  const report = { at: new Date().toISOString(), base, general, results };
  writeFileSync(join(out, 'browser-check.json'), `${JSON.stringify(report, null, 2)}\n`);

  console.log(`No session → /v1/identity/me: ${String(general['noSessionApiStatus'])} (expect 401)`);
  console.log(`Wrong password → ${String(general['wrongPasswordStatus'])}, cookie set: ${String(general['wrongPasswordCookie'])} (expect 401, false)`);
  for (const r of results) {
    if (r.screenSays === 'skipped') { console.log(`- ${r.userId}: skipped (a personal login exists)`); continue; }
    console.log(`- ${r.userId} → ${r.landedOn} | signed in ${r.signedIn ? '✓' : '✗'} | cookie ${r.cookie === null ? '✗' : `HttpOnly=${r.cookie.httpOnly} Secure=${r.cookie.secure} SameSite=${r.cookie.sameSite}`} | banner ${r.bannerVisible ? '✓' : '✗'} | me ${r.me.status} (${r.me.permissions} perms)`
      + `${r.forbidden === undefined ? '' : ` | out-of-role ${r.forbidden.status}`}${r.allowed === undefined ? '' : ` | in-role ${r.allowed.status}`}`
      + ` | after sign-out ${r.afterSignOut} | screen /v1 calls: ${r.screenApiCalls.map((a) => `${a.path} ${a.status}`).join(', ') || 'none'}`);
    console.log(`    screen says: "${r.screenSays.slice(0, 160)}"`);
    for (const n of r.browserNotes ?? []) console.log(`    note: ${n}`);
  }
  console.log(`Evidence: ${join(out, 'browser-check.json')} + screenshots`);
  return 0;
}

process.exitCode = await main();
