import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { HEAD_OFFICE_PAGE_SCREENS } from '../../edge/store-edge/src/head-office-pages';
import { ERP_NAVIGATION } from '../../apps/web-erp/src/navigation';

/**
 * **OB-391 (owner, 26 Oct 2026): the company report shows head office's own company and branches — never a practice name —
 * and the store computer serves it, from the menu.**
 *
 * Before OB-391 the page drew three practice branch names and a fixed company node, so it was kept off the box. This fails
 * when a branch name, a branch id or a company node is written into the page again, when it stops reading the company
 * structure from head office (`GET /v1/org/nodes`), or when the box or the menu stop offering it.
 */

const JS = readFileSync('apps/web-erp/web/company-report.js', 'utf8');
const HTML = readFileSync('apps/web-erp/web/company-report.html', 'utf8');

describe('OB-391: the company report names only head office\'s branches', () => {
  it('no practice branch name, branch id or fixed company node is written into the page', () => {
    for (const src of [JS, HTML]) {
      for (const name of ['Anna Nagar', 'T. Nagar', 'Velachery']) expect(src).not.toContain(name);
      expect(src).not.toMatch(/['"`]br-\d+['"`]|value="br-/);
      expect(src).not.toMatch(/['"`]co-\d+['"`]/);
      expect(src).not.toMatch(/BRANCH_NAMES/);
    }
  });

  it('it reads the company and its branches from head office, on the same origin, under the person\'s own session', () => {
    expect(JS).toContain("getJson('/v1/org/nodes')");
    expect(JS).toMatch(/credentials: 'same-origin'/);
  });

  it('the store computer serves it and the menu offers it, gated on the report read', () => {
    expect(HEAD_OFFICE_PAGE_SCREENS).toContain('company-report');
    expect(HTML).toContain('<!--SCREEN-DATA-->');
    const item = ERP_NAVIGATION.find((i) => i.id === 'company-report');
    expect(item).toMatchObject({ path: '/company-report', requires: 'reporting.report.read' });
    expect(item!.served ?? 'box').toBe('box');
  });
});
