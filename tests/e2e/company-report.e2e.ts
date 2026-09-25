import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import {
  consolidate,
  consolidationExportRows,
  type BranchContribution,
  type BranchMembership,
  type ReportScope,
  type MetricFamily,
} from '../../packages/reporting/src/index';
import { exportDomain, type ExportSpec } from '../../packages/export/src/index';
import { AccessControl, type Role, type RoleAssignment } from '../../packages/rbac/src/index';

/**
 * **Company-wide report drill-down, end to end in a real browser (M01 / M29 / D13, Item 4 slice 4c).**
 *
 * The piece a unit test cannot prove: that the head-office SCREEN shows the consolidated truth honestly and
 * lets an owner drill and export — against a backend running the production `@sre/reporting` `consolidate`
 * and `@sre/export` `exportDomain`. The served page holds no money maths; the Node server here plays the
 * reporting API the way the cloud will, wiring the SAME engines over synthetic multi-branch fixtures — so no
 * consolidation or export logic ever enters the browser.
 *
 * It proves, through Chromium:
 *   • a company total across the branches that reported (Anna Nagar + T. Nagar), shown in rupees;
 *   • the total is shown HONESTLY — a stale branch drops the freshness badge to "stale", a branch that never
 *     reported (Velachery) is NAMED as missing and the node does not reconcile (P-08, never stale-as-fresh);
 *   • drill from the company total down to the per-branch contributors, worst-first;
 *   • a branch-scoped view RECOMPUTES the total to that branch and NAMES what was withheld (§28);
 *   • export takes the numbers out as an open CSV through the authorised path — a branch view exports only
 *     its own branch, the company view exports them all (M30-FR-02 / NFR-12).
 *
 * Self-skips where no browser is present, like every other e2e.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/web-erp/web';

// ── Synthetic fixtures: three branches under company co-1 for September 2026 ──────────────────────────────
const AS_OF = '2026-09-25T10:00:00.000Z';
const STALE_AFTER = 86_400; // one day

const MEMBERSHIPS: BranchMembership[] = [
  { branchId: 'br-1', parentId: 'co-1', from: '2026-01-01', to: null }, // Anna Nagar
  { branchId: 'br-2', parentId: 'co-1', from: '2026-01-01', to: null }, // T. Nagar
  { branchId: 'br-3', parentId: 'co-1', from: '2026-01-01', to: null }, // Velachery — open but silent
];

// br-1 reported 30 min ago (fresh); br-2 reported two days ago (stale); br-3 never reported (missing).
const SALES: BranchContribution[] = [
  { branchId: 'br-1', period: '2026-09', family: 'sales', measures: { grossMinor: 100_000, netMinor: 90_000, marginMinor: 30_000 }, lastRefreshAt: '2026-09-25T09:30:00.000Z', revision: 1 },
  { branchId: 'br-2', period: '2026-09', family: 'sales', measures: { grossMinor: 250_000, netMinor: 225_000, marginMinor: 60_000 }, lastRefreshAt: '2026-09-23T09:00:00.000Z', revision: 1 },
];

// The one authorised export path applies to the consolidation too — permission + branch scope + audit.
const EXPORT_SPEC: ExportSpec = {
  domain: 'reporting.consolidation',
  requires: 'reporting.report.read',
  branchColumn: 'branch_id',
  columns: [
    { name: 'branch_id', type: 'text' },
    { name: 'family', type: 'enum' },
    { name: 'period', type: 'text' },
    { name: 'gross_minor', type: 'money_minor' },
    { name: 'net_minor', type: 'money_minor' },
    { name: 'commission_minor', type: 'money_minor' },
  ],
};
const ROLES: Role[] = [{ id: 'reader', name: 'Report reader', permissions: ['reporting.report.read'] }];
const ASSIGNMENTS: RoleAssignment[] = [
  { userId: 'owner-1', roleId: 'reader', branchScope: 'all' },
  { userId: 'mgr-1', roleId: 'reader', branchScope: ['br-1'] },
  { userId: 'mgr-2', roleId: 'reader', branchScope: ['br-2'] },
];
const ACCESS = new AccessControl(ROLES, ASSIGNMENTS);

// A scope choice from the screen → the engine's ReportScope and the export identity/branch.
function viewer(scope: string): { reportScope: ReportScope; userId: string; branchId: string | null } {
  if (scope === 'all') return { reportScope: { userId: 'owner-1', branchScope: 'all' }, userId: 'owner-1', branchId: null };
  const userId = scope === 'br-2' ? 'mgr-2' : 'mgr-1';
  return { reportScope: { userId, branchScope: [scope] }, userId, branchId: scope };
}

function buildReport(family: string, scope: string) {
  const { reportScope } = viewer(scope);
  return consolidate({
    nodeId: 'co-1', family: family as MetricFamily, period: '2026-09',
    contributions: family === 'sales' ? SALES : [],
    memberships: MEMBERSHIPS, scope: reportScope, asOf: AS_OF, staleAfterSeconds: STALE_AFTER,
  });
}

interface Backend {
  base: string;
  stop: () => Promise<void>;
}

/** A local Node server that serves the report page AND plays the reporting API with the production engines. */
async function startBackend(): Promise<Backend> {
  const sendJson = (res: ServerResponse, body: unknown): void => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const path = url.pathname;

      if (req.method === 'GET' && path === '/consolidation') {
        const family = url.searchParams.get('family') ?? 'sales';
        const scope = url.searchParams.get('scope') ?? 'all';
        sendJson(res, buildReport(family, scope));
        return;
      }

      if (req.method === 'GET' && path === '/consolidation/export') {
        const family = url.searchParams.get('family') ?? 'sales';
        const scope = url.searchParams.get('scope') ?? 'all';
        const { userId, branchId } = viewer(scope);
        const rows = consolidationExportRows(buildReport(family, scope));
        try {
          const out = exportDomain(EXPORT_SPEC, rows, ACCESS, { userId, branchId, at: AS_OF });
          res.writeHead(200, {
            'content-type': 'text/csv; charset=utf-8',
            'x-export-rows': String(out.audit.rowCount),
          });
          res.end(out.csv);
        } catch {
          res.writeHead(403);
          res.end('forbidden');
        }
        return;
      }

      // Otherwise serve a static file from the web-erp web dir.
      const file = path === '/' || path === '/company-report' ? 'company-report.html' : path.replace(/^\//, '');
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
      });
    });
  });
}

describe.skipIf(!HAVE_BROWSER)('company-wide report drill-down, end to end in a real browser (M01/M29/D13)', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  it('shows the honest company total, drills to branches, recomputes on scope, and exports the right rows', async () => {
    const backend = await startBackend();
    const context = await browser.newContext();
    const page: Page = await context.newPage();
    try {
      await page.goto(`${backend.base}/company-report`, { waitUntil: 'load' });

      // 1) The company total across the branches that reported (₹1,000 + ₹2,500 = ₹3,500.00).
      await page.locator('.kpi .v[data-measure="grossMinor"]', { hasText: /3,500\.00/ }).waitFor({ timeout: 10_000 });

      // 2) Shown HONESTLY: a stale branch drops the badge to "stale"; the silent branch is named missing;
      //    the node does NOT reconcile (P-08 — never stale-as-fresh, never a complete-looking incomplete total).
      await page.locator('#freshness.stale').waitFor({ timeout: 10_000 });
      await page.locator('#missing', { hasText: 'br-3' }).waitFor({ timeout: 10_000 });
      await page.locator('#reconcile', { hasText: /does NOT reconcile/i }).waitFor({ timeout: 10_000 });

      // 3) Drill from the total to the per-branch contributors, worst-first (T. Nagar ₹2,500 before Anna Nagar).
      await page.locator('#rows tr:nth-child(2)').waitFor({ timeout: 10_000 }); // both branch rows present
      const branchRows = page.locator('#rows tr');
      expect(await branchRows.count()).toBe(2);
      expect(await branchRows.first().getAttribute('data-branch')).toBe('br-2');

      // 4) A branch-scoped view RECOMPUTES the total to that branch and NAMES what was withheld (§28).
      await page.selectOption('#scope', 'br-1');
      await page.locator('.kpi .v[data-measure="grossMinor"]', { hasText: /1,000\.00/ }).waitFor({ timeout: 10_000 });
      await page.locator('#withheld', { hasText: 'br-2' }).waitFor({ timeout: 10_000 });
      await page.locator('#withheld', { hasText: 'br-3' }).waitFor({ timeout: 10_000 });

      // 5) Export the branch view — the authorised CSV carries only that branch's row (§28 / M30-FR-02).
      await page.click('#export');
      await page.locator('#export-status', { hasText: /Exported 1 branch/ }).waitFor({ timeout: 10_000 });
      const scopedCsv = await page.locator('#preview').textContent();
      expect(scopedCsv).toContain('br-1');
      expect(scopedCsv).not.toContain('br-2');

      // 6) Back to the whole company — the export now carries both reporting branches.
      await page.selectOption('#scope', 'all');
      await page.locator('.kpi .v[data-measure="grossMinor"]', { hasText: /3,500\.00/ }).waitFor({ timeout: 10_000 });
      await page.click('#export');
      await page.locator('#export-status', { hasText: /Exported 2 branch/ }).waitFor({ timeout: 10_000 });
      const companyCsv = await page.locator('#preview').textContent();
      expect(companyCsv).toContain('br-1');
      expect(companyCsv).toContain('br-2');
    } finally {
      await context.close();
      await backend.stop();
    }
  }, 60_000);
});
