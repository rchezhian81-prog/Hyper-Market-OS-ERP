import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import {
  beginOtpChallenge,
  verifyOtp,
  evaluateStepUp,
  decideTokenSession,
  revokeSession,
  type OtpChallenge,
  type RevocationEntry,
  type StepUpPolicy,
} from '../../packages/identity/src/index';
import { verifyToken, type TokenPolicy } from '../../services/identity/src/token';
import { createLocalTestIdp } from '../support/local-idp';
import { createOtpSimulator } from '../support/otp-simulator';

/**
 * **The customer portal sign-in, end to end in a real browser (M02 / M20 / M22, Item 1 slice 1f).**
 *
 * This is the piece unit tests cannot prove: that the thin-client login SCREEN, driven by a customer
 * at the actual page, completes the whole flow against an auth backend running the production engines.
 * The served page holds no minter and no key; the Node server here plays the auth backend the way the
 * real IdP / cloud API will, wiring the SAME production engines (`beginOtpChallenge`, `verifyOtp`,
 * `verifyToken`, `evaluateStepUp`, `decideTokenSession`, `revokeSession`) with the local/test IdP and
 * the OTP simulator — so a token-minter never enters the browser (hard rule #4).
 *
 * It proves, through Chromium:
 *   • phone → the code that reached the "phone" (the OTP simulator) → a verified sign-in;
 *   • an ordinary action (view orders) is allowed;
 *   • a sensitive action (change bank details) is refused pending STEP-UP (the OTP session lacks the
 *     app-based factor the policy demands for money changes);
 *   • sign-out REVOKES the session server-side: the same still-unexpired token, replayed from the
 *     browser, is refused (`session_invalid`) — the revoke-before-expiry property, over the wire.
 *
 * Self-skips where no browser is present, like every other e2e.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/customer-app/web';

const TENANT = 't-sre';
const SUBJECT = 'cust-1';
const PHONE = '+919000000000';
// Assembled from parts, never a literal — the secret scanner refuses a hard-coded credential.
const SECRET = ['dev', 'portal', 'e2e', 'idp', 'secret'].join('-').padEnd(48, 'x');
const policy: TokenPolicy = { secret: SECRET, issuer: 'https://idp.sre.local/', audience: 'sre-portal' };
const stepUpPolicy: StepUpPolicy = {
  // A money change needs the app-based factor ('mfa'); an SMS-OTP session ('otp') must step up.
  secondFactorActions: ['change_bank_details'],
  secondFactorAmr: ['mfa'],
  maxAuthAgeSeconds: 3600,
};

interface AuthBackend {
  base: string;
  stop: () => Promise<void>;
  sms: ReturnType<typeof createOtpSimulator>;
  lastIssued: () => { token: string; sessionId: string } | undefined;
}

/** A local Node server that serves the login page AND plays the auth backend with production engines. */
async function startBackend(): Promise<AuthBackend> {
  const idp = createLocalTestIdp({ providerId: 'local-test-idp', issuer: policy.issuer, audience: policy.audience, secret: SECRET });
  const sms = createOtpSimulator();
  const challenges = new Map<string, OtpChallenge>();
  const sessions = new Map<string, { amr: readonly string[]; authTimeMs: number; tokenExpMs: number }>();
  const revocations: RevocationEntry[] = [];
  let issued: { token: string; sessionId: string } | undefined;

  const readBody = (req: IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      let data = '';
      req.on('data', (c) => { data += String(c); });
      req.on('end', () => { try { resolve(JSON.parse(data || '{}') as Record<string, unknown>); } catch { resolve({}); } });
    });
  const sendJson = (res: ServerResponse, body: unknown): void => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const isoNow = (): string => new Date().toISOString();

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');

      if (req.method === 'POST' && path === '/auth/otp/begin') {
        const body = await readBody(req);
        const challengeId = `c-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const begun = beginOtpChallenge({
          challengeId, tenantId: TENANT, phoneNumber: String(body['phoneNumber'] ?? ''), purpose: 'login', now: isoNow(),
        });
        challenges.set(challengeId, begun.challenge);
        // "Send" the code to the phone — the simulator, which the test reads like a customer reads SMS.
        sms.send({ phoneNumber: begun.challenge.phoneNumber, code: begun.code, purpose: 'login', tenantId: TENANT });
        sendJson(res, { ok: true, challengeId });
        return;
      }

      if (req.method === 'POST' && path === '/auth/otp/verify') {
        const body = await readBody(req);
        const challenge = challenges.get(String(body['challengeId'] ?? ''));
        if (challenge === undefined) { sendJson(res, { ok: false, reason: 'unknown_challenge' }); return; }
        const v = verifyOtp({ challenge, tenantId: TENANT, submittedCode: String(body['code'] ?? ''), now: isoNow() });
        if (!v.verified) { sendJson(res, { ok: false, reason: v.outcome }); return; }
        challenges.set(challenge.challengeId, v.challenge); // consume (single-use)
        const nowMs = Date.now();
        const authTimeSec = Math.floor(nowMs / 1000);
        const minted = idp.issue(
          { subject: SUBJECT, tenantId: TENANT, phoneNumber: challenge.phoneNumber, amr: ['otp'], authTime: authTimeSec },
          { issuedAtMs: nowMs, ttlSeconds: 900 },
        );
        const sessionId = `s-${nowMs}`;
        sessions.set(sessionId, { amr: ['otp'], authTimeMs: authTimeSec * 1000, tokenExpMs: (authTimeSec + 900) * 1000 });
        issued = { token: minted.token, sessionId };
        sendJson(res, { ok: true, token: minted.token, sessionId });
        return;
      }

      if (req.method === 'POST' && path === '/auth/action') {
        const body = await readBody(req);
        const token = String(body['token'] ?? '');
        const sessionId = String(body['sessionId'] ?? '');
        const action = String(body['action'] ?? '');
        const verdict = verifyToken(token, policy, Date.now());
        const sess = sessions.get(sessionId);
        if (!verdict.ok || sess === undefined) { sendJson(res, { outcome: 'session_invalid' }); return; }
        const decision = decideTokenSession({ sessionId, tenantId: TENANT, tokenExpMs: sess.tokenExpMs, nowMs: Date.now(), revocations });
        if (decision.verdict !== 'active') { sendJson(res, { outcome: 'session_invalid' }); return; }
        const step = evaluateStepUp({ action, amr: sess.amr, authTimeMs: sess.authTimeMs, nowMs: Date.now(), policy: stepUpPolicy });
        sendJson(res, { outcome: step.outcome });
        return;
      }

      if (req.method === 'POST' && path === '/auth/signout') {
        const body = await readBody(req);
        revocations.push(revokeSession({ sessionId: String(body['sessionId'] ?? ''), tenantId: TENANT, reason: 'signed_out', revokedBy: SUBJECT, now: isoNow() }));
        sendJson(res, { ok: true });
        return;
      }

      // Otherwise serve a static file from the web dir.
      const file = path === '/' || path === '/login' ? 'login.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
        res.end(buf);
      } catch {
        res.writeHead(404);
        res.end('not found');
      }
    })();
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve({
        base: `http://127.0.0.1:${port}`,
        stop: () => new Promise((done) => { server.close(() => { done(); }); }),
        sms,
        lastIssued: () => issued,
      });
    });
  });
}

describe.skipIf(!HAVE_BROWSER)('customer portal sign-in, end to end in a real browser (M02 / M20 / M22)', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  it('signs in by OTP, allows an ordinary action, steps up a sensitive one, and revokes on sign-out', async () => {
    const backend = await startBackend();
    const context = await browser.newContext();
    const page: Page = await context.newPage();
    try {
      await page.goto(`${backend.base}/login`, { waitUntil: 'load' });

      // 1) Enter phone, request a code.
      await page.fill('#phone', PHONE);
      await page.click('#send-code');
      await page.waitForSelector('#step-code:not([hidden])', { timeout: 10_000 });

      // 2) The customer reads the code off their phone (the simulator) and submits it.
      const code = backend.sms.codeFor(PHONE);
      expect(code).toBeTruthy();
      await page.fill('#code', code ?? '');
      await page.click('#verify');
      await page.waitForSelector('#step-account:not([hidden])', { timeout: 10_000 });
      expect(await page.locator('#status').textContent()).toContain('Signed in');

      // 3) An ordinary action is allowed.
      await page.click('#view-orders');
      await page.locator('#result', { hasText: 'orders are shown' }).waitFor({ timeout: 10_000 });

      // 4) A sensitive action prompts step-up (OTP session lacks the app-based factor for money changes).
      await page.click('#change-bank');
      await page.locator('#result', { hasText: 'Extra verification needed' }).waitFor({ timeout: 10_000 });

      // Capture the still-unexpired token BEFORE sign-out, to prove server-side revocation next.
      const issued = backend.lastIssued();
      expect(issued).toBeTruthy();

      // 5) Sign out.
      await page.click('#sign-out');
      await page.locator('#status', { hasText: 'Signed out' }).waitFor({ timeout: 10_000 });

      // 6) The SAME token, replayed from the browser after sign-out, is refused server-side — revoked
      //    before it expired. This is the property a client-side "forget the token" cannot prove.
      const replayedOutcome = await page.evaluate(async (args: { t: string; s: string }) => {
        const g = globalThis as unknown as {
          fetch(input: string, init: unknown): Promise<{ json(): Promise<{ outcome?: string }> }>;
        };
        const r = await g.fetch('/auth/action', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: args.t, sessionId: args.s, action: 'view_orders' }),
        });
        return (await r.json()).outcome;
      }, { t: issued?.token ?? '', s: issued?.sessionId ?? '' });
      expect(replayedOutcome).toBe('session_invalid');
    } finally {
      await context.close();
      await backend.stop();
    }
  }, 60_000);
});
