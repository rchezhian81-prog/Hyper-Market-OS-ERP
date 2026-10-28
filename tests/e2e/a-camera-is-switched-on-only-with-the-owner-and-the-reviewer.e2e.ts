import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { decide } from '../support/approval-request';
import { ROLE_CATALOGUE } from '../../services/api/src/roles';

/**
 * **OB-407 (owner, 27 Oct 2026, in writing) on the "Trial switches" page, in a real browser, over the real API.** The IT
 * administrator types "cctv" for branch B1, previews it — the page says switching cameras on needs the owner AND the named
 * security reviewer (or, with nobody named, that it cannot go on) — presses "Ask for approval", which sends exactly the
 * two asks head office's preview hands over; the owner approves one, the security reviewer signs the other, each in their
 * own session; "Save the change" then uses those approvals (found, never typed) and the board names all three people.
 * Switching it off is one person with a reason. English and Tamil; every button its icon.
 *
 * The page is served by a small stand-in for the ERP host that forwards every `/v1/*` call to head office's real
 * pipeline (the in-memory API harness), as the signed-in person in the cookie. Where no Chromium is present it SKIPS.
 * Synthetic data only.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const WEB_DIR = 'apps/web-erp/web';
const T = randomUUID();

const permissionsOf = (roleId: string): readonly string[] => ROLE_CATALOGUE.find((r) => r.id === roleId)?.permissions ?? [];

async function startHost(h: ApiHarness, roles: Readonly<Record<string, string>>): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const who = /(?:^|;\s*)who=([A-Za-z0-9-]+)/.exec(req.headers.cookie ?? '')?.[1] ?? '';
      if (url.pathname.startsWith('/v1/')) {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8');
        const method = (req.method ?? 'GET') as 'GET' | 'POST' | 'PUT';
        const key = req.headers['idempotency-key'];
        const r = await h.request({
          method, path: url.pathname, userId: who, tenantId: T, query: Object.fromEntries(url.searchParams),
          ...(raw === '' ? {} : { body: JSON.parse(raw) as unknown }), ...(typeof key === 'string' ? { idempotencyKey: key } : {}),
        });
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r.body ?? {}));
        return;
      }
      const file = url.pathname === '/rollout' ? 'rollout.html' : url.pathname.replace(/^\//, '');
      try {
        let body = (await readFile(join(WEB_DIR, file))).toString('utf8');
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
        if (file.endsWith('.html')) body = body.replace('<!--SCREEN-DATA-->', `<script>window.rolloutData = ${JSON.stringify({ userId: who, permissions: permissionsOf(roles[who] ?? '') })};</script>`);
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
        res.end(body);
      } catch { res.writeHead(404); res.end('not found'); }
    })();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve({ base: `http://127.0.0.1:${port}`, stop: () => new Promise((done) => { server.close(() => { done(); }); server.closeAllConnections(); }) });
    });
  });
}

describe.skipIf(!existsSync(CHROMIUM))('OB-407 — a camera is switched on only with the owner and the named security reviewer, on the Trial switches page', () => {
  let browser: Browser;
  let host: { base: string; stop: () => Promise<void> };
  const h = apiHarness();
  const roles = { 'u-it': 'platform_admin', 'u-owner': 'owner', 'u-siva': 'security_reviewer' };
  const api = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown) =>
    h.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-it', 'platform_admin');
    await h.provisionRole(T, 'u-siva', 'security_reviewer');
    expect((await api('POST', '/v1/org/nodes/C1', 'u-it', { kind: 'company', name: 'SRE Retail' })).status).toBeLessThan(300);
    expect((await api('POST', '/v1/org/nodes/B1', 'u-it', { kind: 'branch', name: 'Main store', parentId: 'C1', companyId: 'C1' })).status).toBeLessThan(300);
    host = await startHost(h, roles);
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await host?.stop(); });

  const open = async (who: string): Promise<{ page: Page; errors: string[]; close: () => Promise<void> }> => {
    const context = await browser.newContext();
    await context.addCookies([{ name: 'who', value: who, url: host.base }]);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${host.base}/rollout`, { waitUntil: 'load' });
    return { page, errors, close: () => context.close() };
  };
  const waitText = (page: Page, selector: string, text: string) => page.waitForFunction(([sel, want]) => {
    const node = (globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector(sel!);
    return (node?.textContent ?? '').includes(want!);
  }, [selector, text], { timeout: 15_000 });

  it('no reviewer named → cannot go on; named → Ask for approval, owner + reviewer approve, Save uses them; off by one person', async () => {
    const { page, errors, close } = await open('u-it');
    await page.waitForSelector('#change:not([hidden])');
    for (const id of ['#ch-preview', '#ch-ask', '#ch-save']) expect(await page.locator(`${id} svg`).count(), id).toBe(1);
    expect((await page.textContent('#ch-ask')) ?? '').toContain('Ask for approval');
    await page.fill('#ch-key', 'cctv'); await page.fill('#ch-branch', 'B1'); await page.fill('#ch-reason', 'camera events trial in B1');

    // Nobody named yet: the preview says so, and asking is refused before anything is sent.
    await page.click('#ch-preview');
    await waitText(page, '#ch-said', 'No security reviewer is named');
    await page.click('#ch-ask');
    await waitText(page, '#ch-status', 'No security reviewer is named');
    expect(((await api('GET', '/v1/approvals/requests', 'u-it')).body as { mine: unknown[] }).mine).toEqual([]);

    // The owner names Mr Sivakumar (OB-405) on head office.
    expect((await api('PUT', '/v1/compliance/security-reviewer', 'u-owner', { userId: 'u-siva', displayName: 'Mr Sivakumar', reason: 'OB-405 interim reviewer' })).status).toBe(200);
    await page.click('#ch-preview');
    await waitText(page, '#ch-said', 'switching on also needs the security reviewer\'s signature — Mr Sivakumar');
    expect(await page.getAttribute('#ch-said', 'data-needs-reviewer')).toBe('true');
    // Saving before anyone approved: head office refuses by name, nothing changes.
    await page.click('#ch-save');
    await waitText(page, '#ch-status', 'Head office refused:');
    // Ask: exactly two requests, one for the owner and one for the reviewer.
    await page.click('#ch-ask');
    await waitText(page, '#ch-status', 'Asked.');
    const mine = ((await api('GET', '/v1/approvals/requests', 'u-it')).body as { mine: { requestId: string; kind: string; subjectRef: string; status: string }[] }).mine;
    expect(mine.map((r) => [r.kind, r.subjectRef, r.status]).sort()).toEqual([['flag_change', 'rollout:cctv:B1', 'waiting'], ['floor_device_review', 'rollout:cctv:B1', 'waiting']]);
    // The owner approves his; only then is the reviewer's still missing.
    expect((await decide(h, T, 'u-owner', mine.find((r) => r.kind === 'flag_change')!.requestId)).status).toBe(201);
    // Wait for head office's REFUSAL, not just the words "security reviewer": the "Asked." line above already holds them,
    // so matching them alone moved on before this save was answered, and the next Save raced it (OB-436).
    await page.click('#ch-save');
    await waitText(page, '#ch-status', 'Head office refused:');
    expect((await page.textContent('#ch-status')) ?? '').toContain('security reviewer');
    // The reviewer signs in his own session; Save now goes through with both.
    expect((await decide(h, T, 'u-siva', mine.find((r) => r.kind === 'floor_device_review')!.requestId)).status).toBe(201);
    await page.click('#ch-save');
    await waitText(page, '#ch-status', 'Saved.');
    await waitText(page, '#board-rows', 'u-it · u-owner · u-siva');
    expect((await h.request({ method: 'GET', path: '/v1/platform/rollout/cctv/decision', userId: 'u-it', tenantId: T, query: { branchId: 'B1' } })).body).toMatchObject({ on: true, source: 'branch' });

    // Tamil: the reviewer's words have their Tamil twin.
    await page.click('#lang');
    await page.click('#ch-preview');
    await waitText(page, '#ch-said', 'பாதுகாப்புச் சரிபார்ப்பாளரின் கையொப்பமும் தேவை');
    expect((await page.textContent('#ch-ask')) ?? '').toContain('ஒப்புதல் கேள்');
    await page.click('#lang');

    // OFF: one person and a reason, nothing to ask.
    await page.selectOption('#ch-state', 'off'); await page.fill('#ch-reason', 'privacy notice not up yet');
    await page.click('#ch-ask');
    await waitText(page, '#ch-status', 'needs nobody else');
    await page.click('#ch-save');
    await waitText(page, '#ch-status', 'Saved.');
    const board = (await api('GET', '/v1/platform/rollout', 'u-owner')).body as { switches: { key: string; enabled: boolean; version: number; approvedBy: string | null; reviewedBy: string | null }[] };
    expect(board.switches).toEqual([expect.objectContaining({ key: 'cctv', enabled: false, version: 2, approvedBy: null, reviewedBy: null })]);
    expect(errors).toEqual([]);
    await close();
  }, 120_000);
});
