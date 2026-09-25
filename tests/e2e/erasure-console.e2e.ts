import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import {
  planErasure, authoriseErasureExecution, executeErasurePlan, sealTombstone, guardAgainstRestore,
  planProcessorErasureNotices,
  type DataSubjectRequest, type DataCategory, type ErasableSource, type PrivacyTombstone, type ProcessorRegistryEntry,
} from '../../packages/customer/src/index';

/**
 * **The DPO erasure console, end to end in a real browser (M20-FR-04 / DPDP, Item 5 slice 5d — completes
 * Item 5).** DEVELOPMENT-APPROVED; LEGAL CONFIRMATION REQUIRED — this proves the technical workflow, not
 * legal compliance.
 *
 * The piece a unit test cannot prove: that a data-protection officer at the actual SCREEN carries out a
 * verified erasure under the two-person rule, against a backend running the production @sre/customer engines
 * (plan / authorise / execute / tombstone / prevent-restore). The served page holds no erasure logic; the
 * Node server here plays the privacy API the way the cloud will, wiring the SAME engines over an in-memory
 * simulated PII holding — so no erasure maths ever enters the browser.
 *
 * Through Chromium it proves: the located PII is shown; an execution with no second approver is refused; the
 * same officer approving and executing is refused (SoD §28); a DIFFERENT maker completes it — the marketing
 * profile erased, the audit record minimised, the tax invoice RETAINED and untouched (#6); and a later
 * attempt to re-add the erased person's data is refused (prevent-restore, #10). Self-skips with no browser.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/web-erp/web';

const SMS: ProcessorRegistryEntry = { processorId: 'sms-gw', name: 'SMS gateway', connectorId: 'conn-sms', connectorVersion: 'v1', categoriesShared: ['marketing_profile'] };

interface Holding { category: string; recordCount: number; retentionBasis?: DataCategory['retentionBasis']; retainUntil?: string; minimisable?: boolean; state: 'held' | 'erased' | 'minimised'; }

interface Backend { base: string; stop: () => Promise<void>; }

/** A local Node server that serves the console AND plays the privacy API with the production engines. */
async function startBackend(): Promise<Backend> {
  const request: DataSubjectRequest = { requestId: 'dsr-1', tenantId: 't-1', customerRef: 'cust-1', kind: 'erasure', raisedAt: '2026-09-20T00:00:00.000Z', verifiedBy: 'passport+otp', verifiedAt: '2026-09-21T00:00:00.000Z', state: 'verified', dueBy: '2026-10-20' };
  const pii = new Map<string, Holding>([
    ['marketing_profile', { category: 'marketing_profile', recordCount: 3, state: 'held' }],
    ['order_history', { category: 'order_history', recordCount: 5, retentionBasis: 'audit_evidence', minimisable: true, state: 'held' }],
    ['tax_invoice', { category: 'tax_invoice', recordCount: 4, retentionBasis: 'tax_invoice', retainUntil: '2034-03-31', state: 'held' }],
  ]);
  let approvedBy: string | undefined;
  let tombstone: PrivacyTombstone | undefined;

  const readBody = (req: IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((resolve) => { let d = ''; req.on('data', (c) => { d += String(c); }); req.on('end', () => { try { resolve(JSON.parse(d || '{}') as Record<string, unknown>); } catch { resolve({}); } }); });
  const send = (res: ServerResponse, status: number, body: unknown): void => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const now = (): string => '2026-09-25T10:00:00.000Z';
  const toCategory = (h: Holding): DataCategory => ({ category: h.category, recordCount: h.recordCount, ...(h.retentionBasis ? { retentionBasis: h.retentionBasis } : {}), ...(h.retainUntil ? { retainUntil: h.retainUntil } : {}), ...(h.minimisable === undefined ? {} : { minimisable: h.minimisable }) });

  const server: Server = createServer((req, res) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');

      if (req.method === 'GET' && path.startsWith('/pii/') && path.split('/').length === 3) {
        send(res, 200, { customerRef: 'cust-1', categories: [...pii.values()].sort((a, b) => a.category.localeCompare(b.category)) });
        return;
      }
      if (req.method === 'POST' && path.startsWith('/pii/')) {
        const [, , , category = ''] = path.split('/');
        const b = await readBody(req);
        const guard = guardAgainstRestore({ attempt: { customerRef: 'cust-1', carriesPii: true, source: `re-import:${category}` }, tombstones: tombstone ? [tombstone] : [], at: now() });
        if (guard.decision === 'refused_erased_subject') { send(res, 409, { code: 'subject_was_erased', detail: guard.detail }); return; }
        pii.set(category, { category, recordCount: Number(b['recordCount'] ?? 1), state: 'held' });
        send(res, 201, { category, state: 'held' });
        return;
      }
      if (req.method === 'POST' && path === '/approve') {
        approvedBy = String((await readBody(req))['approver'] ?? '');
        send(res, 200, { approvedBy });
        return;
      }
      if (req.method === 'POST' && path === '/execute') {
        const maker = String((await readBody(req))['maker'] ?? '');
        const held = [...pii.values()].filter((h) => h.state === 'held');
        const plan = planErasure({ request, categories: held.map(toCategory), at: now() });
        const auth = authoriseErasureExecution({ request, plan, maker, checker: approvedBy ?? '', at: now() });
        if (!auth.authorised) { send(res, 409, { code: auth.outcome, detail: auth.detail }); return; }
        const sources: ErasableSource[] = held.map((h): ErasableSource => ({
          category: h.category,
          erase: () => { pii.set(h.category, { ...h, recordCount: 0, state: 'erased' }); return { recordsAffected: h.recordCount }; },
          minimise: () => { pii.set(h.category, { ...h, state: 'minimised' }); return { recordsAffected: h.recordCount }; },
        }));
        const report = await executeErasurePlan({ plan, sources, at: now() });
        tombstone = sealTombstone({ authorisation: auth.authorisation, report, at: now() });
        const notices = planProcessorErasureNotices({ tombstone, processors: [SMS], at: now() });
        send(res, 200, { state: plan.partial ? 'partially_fulfilled' : 'fulfilled', tombstone, notices: notices.map((n) => ({ processorId: n.processor.processorId })) });
        return;
      }

      const file = path === '/' || path === '/erasure-console' ? 'erasure-console.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
        res.end(buf);
      } catch { res.writeHead(404); res.end('not found'); }
    })();
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve({ base: `http://127.0.0.1:${port}`, stop: () => new Promise((done) => { server.close(() => { done(); }); }) });
    });
  });
}

describe.skipIf(!HAVE_BROWSER)('DPO erasure console, end to end in a real browser (M20-FR-04)', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true, executablePath: CHROMIUM }); }, 60_000);
  afterAll(async () => { await browser?.close(); });

  it('shows the located PII, enforces the two-person rule, erases/keeps honestly, and prevents restore', async () => {
    const backend = await startBackend();
    const context = await browser.newContext();
    const page: Page = await context.newPage();
    try {
      await page.goto(`${backend.base}/erasure-console`, { waitUntil: 'load' });

      // 1) The located PII is shown, all held.
      await page.locator('#rows tr[data-category="marketing_profile"] .pill[data-state="held"]').waitFor({ timeout: 10_000 });
      expect(await page.locator('#rows tr').count()).toBe(3);

      // 2) Execute with no second approver → refused (maker-checker needs two).
      await page.click('#execute');
      await page.locator('#status', { hasText: /second, authorised officer must approve/i }).waitFor({ timeout: 10_000 });

      // 3) Approve as dpo-ravi, then execute as dpo-ravi → refused (the approver cannot also run it).
      await page.click('#approve');
      await page.locator('#status', { hasText: /Approved by dpo-ravi/ }).waitFor({ timeout: 10_000 });
      await page.click('#execute');
      await page.locator('#status', { hasText: /person who approved cannot also run/i }).waitFor({ timeout: 10_000 });

      // 4) A DIFFERENT maker completes it — the tombstone shows the honest split.
      await page.fill('#actor', 'officer-mala');
      await page.click('#execute');
      await page.locator('#status', { hasText: /Erasure carried out/ }).waitFor({ timeout: 10_000 });
      expect(await page.locator('#t-erased').textContent()).toBe('marketing_profile');
      expect(await page.locator('#t-minimised').textContent()).toBe('order_history');
      expect(await page.locator('#t-retained').textContent()).toBe('tax_invoice');
      expect(await page.locator('#t-people').textContent()).toBe('dpo-ravi → officer-mala');
      // The holdings now read honestly: marketing erased, order_history minimised, tax invoice untouched.
      await page.locator('#rows tr[data-category="marketing_profile"] .pill[data-state="erased"]').waitFor({ timeout: 10_000 });
      await page.locator('#rows tr[data-category="order_history"] .pill[data-state="minimised"]').waitFor({ timeout: 10_000 });
      await page.locator('#rows tr[data-category="tax_invoice"] .pill[data-state="held"]').waitFor({ timeout: 10_000 });

      // 5) A late re-import of the erased person's data is refused (prevent-restore).
      await page.click('#restore');
      await page.locator('#restore-status', { hasText: /Refused — this person was erased/i }).waitFor({ timeout: 10_000 });
    } finally {
      await context.close();
      await backend.stop();
    }
  }, 60_000);
});
