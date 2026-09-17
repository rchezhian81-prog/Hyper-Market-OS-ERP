import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  DATA_IO_COPY, COPY_KEYS, createDataIoSession,
  type DataIoPorts, type ExportDomainView, type ImportTemplateView,
} from '../../apps/web-erp/src/data-io-session';
import { bilingualGaps } from '../../packages/ui/src/index';

/**
 * **The data import/export console is usable, bilingual, and governed (M30-FR-01/02/03, API-03, §28).**
 *
 * The store is in Tamil Nadu and the roadmap mandates both languages, so the tripwire binds to the session's
 * single `BilingualCopy`. It also holds the screen to the usability rules every screen carries — no browser
 * dialogs, defers to the tested session, colour never the only signal — and pins what THIS screen guarantees:
 * export is offered only with permission; the write actions (export / validate / commit) run ONLY on an explicit
 * click; and the screen itself issues no write verbs (the audited POSTs live in the injected ports).
 */

const DOMAINS: readonly ExportDomainView[] = [
  { domain: 'products', requires: 'catalogue.pack.read', columns: [{ name: 'sku', type: 'text', sensitive: false }, { name: 'cost', type: 'money_minor', sensitive: true }] },
];
const TEMPLATES: readonly ImportTemplateView[] = [{ id: 'products-basic', domain: 'products', label: 'Products', financial: false }];
const ports = (over: Partial<DataIoPorts> = {}): DataIoPorts => ({
  exportDomains: () => DOMAINS, recentExports: () => [], importTemplates: () => TEMPLATES,
  mayExport: () => true, mayImport: () => true, mayCommitImport: () => true,
  runExport: async () => 'exported', validate: async () => 'refused', commit: async () => 'committed', ...over,
});
const session = (over: Partial<DataIoPorts> = {}) => createDataIoSession({ userId: 'u-op' }, ports(over));

describe('the import/export copy is complete in both languages', () => {
  it('has no gap in either language across the whole vocabulary', () => {
    const gaps = bilingualGaps(DATA_IO_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });
  it('tripwire — the detector fires on a key genuinely absent', () => {
    const holey = { en: { ...DATA_IO_COPY.en }, ta: { ...DATA_IO_COPY.ta, exportBtn: '' } };
    expect(bilingualGaps(holey, COPY_KEYS).ta).toContain('exportBtn');
  });
});

describe('the export panel is gated and flags sensitive columns', () => {
  it('offers export with permission (and flags the sensitive column), locks it without', () => {
    const on = session().exportPanel('en');
    expect(on.mayExport).toBe(true);
    expect(on.domains[0]!.sensitiveCount).toBe(1);
    const off = session({ mayExport: () => false }).exportPanel('en');
    expect(off.mayExport).toBe(false);
    expect(off.domains).toEqual([]);
  });
});

describe('the view defers to the model, uses no browser dialogs, and only writes on an explicit click', () => {
  const RAW = readFileSync('apps/web-erp/web/data-io.js', 'utf8');
  const VIEW = RAW.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  it('never calls alert / confirm / prompt', () => {
    expect(/\b(alert|confirm|prompt)\s*\(/.test(VIEW)).toBe(false);
  });
  it('renders from the bundled session rather than re-deciding what to show', () => {
    expect(VIEW).toMatch(/window\.dataIoSession/);
    expect(VIEW).toMatch(/session\.exportPanel\(/);
    expect(VIEW).toMatch(/session\.importPanel\(/);
  });
  it('the write actions run ONLY from an explicit click, never at load', () => {
    const clickIdx = VIEW.indexOf("addEventListener('click'");
    expect(clickIdx, 'no click handler is registered').toBeGreaterThan(-1);
    for (const call of ['session.runExport(', 'session.commit(']) {
      const idx = VIEW.indexOf(call);
      expect(idx, `${call} is not present`).toBeGreaterThan(-1);
      expect(idx, `${call} runs before/outside a click handler (would write on load)`).toBeGreaterThan(clickIdx);
    }
    // The screen issues no write verbs itself — the audited POSTs live in the injected ports (browser-entry).
    const writes = VIEW.match(/method:\s*'(POST|PUT|PATCH|DELETE)'/g) ?? [];
    expect(writes).toEqual([]);
  });
  it('the shell loads the shared bundle, carries the data marker, and labels the toggle and the lists', () => {
    const HTML = readFileSync('apps/web-erp/web/data-io.html', 'utf8');
    expect(HTML).toMatch(/web-erp\.bundle\.js/);
    expect(HTML).toContain('<!--SCREEN-DATA-->');
    expect(HTML).toMatch(/id="lang"[^>]*aria-label=/);
    expect(HTML).toMatch(/id="export-domains"[^>]*aria-label=/);
  });
});
