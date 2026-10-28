import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';

/**
 * **The customer sign-in PROGRAM, built and started for real, as the compose service runs it (M20-FR-01 · OB-222 ·
 * ADR-0031 · P-08).**
 *
 * `pnpm run build:customer-sign-in` bundles the service; `node services/identity/dist/customer-sign-in.mjs` is exactly
 * the compose `customer-sign-in` command. This proves the shipped program: refuses to start without its settings (exit
 * 78, said by name); started, it says in its first line that NO SMS provider is connected; asked for a code it answers
 * 503 `sms_provider_not_configured` in plain words and sends nothing; a request from another site is refused; and the
 * number typed never reaches its output. Nothing about a customer is stored, so there is nothing to survive a restart:
 * a restart is a fresh program that refuses the same way (proved by starting it twice).
 */

const OUT = 'services/identity/dist/customer-sign-in.mjs';
const ORIGIN = 'https://shop.example.test';
const NUMBER = '9123456780';

const freePort = (): Promise<number> => new Promise((resolve) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
});

async function start(port: number): Promise<{ proc: ChildProcess; output: () => string }> {
  let output = '';
  const proc = spawn('node', [OUT], { env: { PATH: process.env['PATH'] ?? '', CUSTOMER_SIGN_IN_ORIGIN: ORIGIN, CUSTOMER_SIGN_IN_TENANT_ID: 't-sre', PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout!.on('data', (c) => { output += String(c); });
  proc.stderr!.on('data', (c) => { output += String(c); });
  for (let i = 0; i < 100 && !output.includes('customer sign-in on :'); i += 1) await new Promise((r) => setTimeout(r, 50));
  return { proc, output: () => output };
}

const begin = (port: number, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${port}/auth/otp/begin`, {
  method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers }, body: JSON.stringify({ phoneNumber: NUMBER }),
});

describe('the customer sign-in program (built, started as compose starts it)', () => {
  const running: ChildProcess[] = [];
  beforeAll(() => { execFileSync('node', ['scripts/build-service.mjs', 'customer-sign-in', '--quiet'], { stdio: 'pipe' }); }, 120_000);
  afterAll(() => { for (const p of running) p.kill('SIGTERM'); rmSync('services/identity/dist/customer-sign-in.mjs', { force: true }); rmSync('services/identity/dist/customer-sign-in.mjs.map', { force: true }); });

  it('is built to the file the compose service runs', () => { expect(existsSync(OUT)).toBe(true); });

  it('refuses to start without its settings, by name (exit 78)', () => {
    const r = spawnSync('node', [OUT], { env: { PATH: process.env['PATH'] ?? '' }, encoding: 'utf8', timeout: 20_000 });
    expect(r.status).toBe(78);
    expect(r.stderr).toContain('customer sign-in REFUSED to start — CUSTOMER_SIGN_IN_ORIGIN is not set');
    expect(r.stderr).toContain('CUSTOMER_SIGN_IN_TENANT_ID is not set');
  });

  it('started, says no SMS provider is connected, refuses every code in plain words — and the same after a restart', async () => {
    for (const round of [1, 2]) {
      const port = await freePort();
      const svc = await start(port);
      running.push(svc.proc);
      expect(svc.output(), `round ${round}`).toContain('NO PROVIDER CONNECTED (OB-222)');
      const out = await begin(port);
      expect(out.status).toBe(503);
      const body = await out.json() as { ok: boolean; error: { code: string; whatHappened: string } };
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('sms_provider_not_configured');
      expect(body.error.whatHappened).toContain('No code was sent');
      expect((await begin(port, { origin: 'https://evil.example' })).status).toBe(403);
      expect(svc.output()).not.toContain(NUMBER);
      svc.proc.kill('SIGTERM');
      await new Promise((r) => svc.proc.once('exit', r));
    }
  }, 60_000);
});
