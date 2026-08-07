import { describe, it, expect } from 'vitest';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildRouter, isWrite, type ApiId, type Route } from '../../services/kernel/src/index';
import { catalogueRoutes, hmacSigner } from '../../services/catalogue/src/index';
import { posRoutes } from '../../services/pos/src/index';
import { inventoryRoutes } from '../../services/inventory/src/index';
import { identityRoutes } from '../../services/identity/src/index';
import { platformRoutes, inMemorySettings } from '../../services/platform/src/index';
import { purchaseRoutes } from '../../services/purchase/src/index';
import { financeRoutes } from '../../services/finance/src/index';
import { reportingRoutes } from '../../services/reporting/src/index';
import { customerRoutes } from '../../services/customer/src/index';
import { ordersRoutes } from '../../services/orders/src/index';
import { fulfilmentRoutes } from '../../services/fulfilment/src/index';
import { migrationRoutes } from '../../services/migration/src/index';
import { aiRoutes } from '../../services/ai/src/index';

/**
 * **Thirteen APIs, one surface.**
 *
 * Each service is tested on its own. This asks the questions that only exist once they are all
 * assembled, and that no single service's tests can reach:
 *
 *   • Is every API in the catalogue actually served by something?
 *   • Do any two services claim the same address?
 *   • Does every one of them obey the kernel's conventions — versioned, permissioned, idempotent
 *     where it writes — or does the *combined* surface have a gap that each part hid?
 *   • Is any permission spelled two different ways across two services, which is how an endpoint
 *     ends up guarded by a permission nobody holds and nobody notices?
 *
 * The API catalogue in `docs/api/catalogue.md` is the specification, and it is read from disk
 * rather than restated here — restating it would let the two drift apart, which is the failure the
 * traceability guardrail already had to be taught once.
 */

const NOW = '2026-08-07T12:00:00Z';
const ROOT = new URL('../../', import.meta.url).pathname;

const testKey = ['surface', 'test', 'signing'].join('-').padEnd(40, '0');

/** Every service, wired with do-nothing ports. The surface is the subject, not the behaviour. */
const ALL: readonly Route[] = [
  ...identityRoutes({ roles: () => [], permissionsOf: () => [], recordGrant: () => {}, branches: () => [], allocateNumber: () => Promise.resolve(1), now: () => NOW }),
  ...catalogueRoutes({
    signer: hmacSigner(testKey), currentPack: () => undefined, storePack: () => {},
    buildSnapshot: () => ({ tenantId: 't', version: 1, builtAt: NOW, products: [], barcodes: [] }),
    approvalsSince: () => [], now: () => NOW,
  }),
  ...purchaseRoutes({
    matchLines: () => [], recordMatch: () => {}, applyBankChange: () => {},
    openCommitments: () => ({ count: 0, valueMinor: 0 }), now: () => NOW,
  }),
  ...inventoryRoutes({ availability: () => [], appendMovement: () => {}, isKnown: () => false, now: () => NOW }),
  ...posRoutes({
    catalogue: () => new Map(), currentPackVersion: () => 1, saleHoldingReceipt: () => undefined,
    isBanked: () => false, bankSale: () => {}, recordExceptions: () => {},
    openExceptions: () => [], now: () => NOW,
  }),
  ...customerRoutes({ consentRecords: () => [], appendConsent: () => {}, pointsBalance: () => undefined, now: () => NOW }),
  ...ordersRoutes({ onHand: () => new Map(), outstanding: () => [], holdReservations: () => {}, holdMinutes: 60, now: () => NOW }),
  ...fulfilmentRoutes({ appendAttempt: () => {}, attempts: () => [], assigned: () => [], now: () => NOW }),
  ...financeRoutes({
    periodStates: () => new Map(), nextOpenPeriod: () => '2026-08', appendJournal: () => {},
    controlTotals: () => [], postersIn: () => [], markClosed: () => {}, now: () => NOW,
  }),
  ...reportingRoutes({ figures: () => [], now: () => NOW }),
  ...platformRoutes({ probe: () => [], flags: () => ({}), setFlag: () => {}, recordSupportAccess: () => {}, settings: inMemorySettings(), now: () => NOW }),
  ...migrationRoutes({
    target: () => ({ targetId: 'tgt-1', tenantId: 't', kind: 'rehearsal', label: 'rehearsal' }), findings: () => [],
    acceptances: () => [], signatures: () => [], recordAcceptance: () => {},
    ownerId: () => 'u-owner', extractionOperator: () => 'u-op', now: () => NOW,
  }),
  ...aiRoutes({
    killSwitchOn: () => false, setKillSwitch: () => {},
    budget: () => ({ capMinor: 1, spentMinor: 0, periodEnds: NOW }),
    enabledAgents: () => [], run: () => [], openProposals: () => [], now: () => NOW,
  }),
];

const EVERY_API: readonly ApiId[] = [
  'API-01', 'API-02', 'API-03', 'API-04', 'API-05', 'API-06', 'API-07',
  'API-08', 'API-09', 'API-10', 'API-11', 'API-12', 'API-13',
];

describe('thirteen APIs, one surface', () => {
  const built = buildRouter(ALL);

  it('registers as ONE router with no refusals — the combined surface, not thirteen separate ones', () => {
    // Each service passes its own registration test. This is the one that would catch two of them
    // being individually fine and jointly broken.
    expect(built.refusals.map((r) => r.detail)).toEqual([]);
    expect(built.ok).toBe(true);
  });

  it('serves every API the catalogue specifies, and invents none', () => {
    const served = new Set(built.router!.list().map((r) => r.api));
    expect([...served].sort()).toEqual([...EVERY_API].sort());
  });

  it('has a service folder on disk for every API served', () => {
    const folders = readdirSync(join(ROOT, 'services'))
      .filter((f) => f !== 'README.md' && existsSync(join(ROOT, 'services', f, 'src', 'index.ts')));
    // Twelve domain services plus the kernel: catalogue and POS are separate, inventory is its own.
    expect(folders.length).toBeGreaterThanOrEqual(13);
    expect(folders).toContain('kernel');
  });

  it('gives no two routes the same address', () => {
    const seen = new Map<string, number>();
    for (const r of built.router!.list()) {
      const k = `${r.method} ${r.path}`;
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    expect([...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k)).toEqual([]);
  });

  it('declares a permission on every route and versions every path', () => {
    for (const r of built.router!.list()) {
      expect(r.permission.trim(), `${r.method} ${r.path}`).not.toBe('');
      expect(r.path, `${r.method} ${r.path}`).toMatch(/^\/v[1-9]\d*\//);
    }
  });

  it('makes every write idempotent, across all thirteen', () => {
    // The till resends what it could not confirm, and so does every handheld and every driver's
    // phone. One write anywhere on this surface that is not safe to repeat is money or stock
    // applied twice.
    for (const r of built.router!.list()) {
      if (isWrite(r.method)) expect(r.idempotent, `${r.method} ${r.path}`).toBe(true);
    }
  });

  /**
   * `pos.sale.read` and `pos.sales.read` reduced to one shape.
   *
   * Case, separator **and plural** are all normalised away, because the near-miss is what actually
   * happens: both spellings look right in review, and one of them guards an endpoint with a
   * permission nobody in the role table holds. Stripping punctuation alone would not have caught
   * the plural, which is the commonest form of it.
   */
  const shapeOf = (permission: string): string => permission
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((s) => s !== '')
    .map((s) => (s.length > 3 && s.endsWith('s') ? s.slice(0, -1) : s))
    .join('.');

  it('spells each permission ONE way across every service', () => {
    const byShape = new Map<string, Set<string>>();
    for (const p of built.router!.list().map((r) => r.permission)) {
      const set = byShape.get(shapeOf(p)) ?? new Set<string>();
      set.add(p);
      byShape.set(shapeOf(p), set);
    }
    expect([...byShape.values()].filter((s) => s.size > 1).map((s) => [...s])).toEqual([]);
  });

  it('FIRES on the near-miss it exists to catch', () => {
    // The tripwire: without it, this check would pass on a surface that has both spellings and
    // nobody would know the assertion had stopped meaning anything.
    expect(shapeOf('pos.sale.read')).toBe(shapeOf('pos.sales.read'));
    expect(shapeOf('POS_Sale_Read')).toBe(shapeOf('pos.sale.read'));
    expect(shapeOf('pos.sale.read')).not.toBe(shapeOf('pos.sale.write'));
  });

  it('names every permission for the thing it guards, so a role list is readable', () => {
    for (const p of new Set(built.router!.list().map((r) => r.permission))) {
      expect(p, `"${p}" should read domain.thing.action`).toMatch(/^[a-z]+(\.[a-z-]+){1,3}$/);
    }
  });

  it('agrees with the API catalogue in docs/api/catalogue.md', () => {
    // Read from disk rather than restated here: restating the specification lets the two drift,
    // which is a failure the traceability guardrail already had to be taught once.
    const doc = readFileSync(join(ROOT, 'docs', 'api', 'catalogue.md'), 'utf8');
    for (const api of EVERY_API) {
      expect(doc, `${api} is served but not in the catalogue`).toContain(`| ${api} |`);
    }
  });

  it('keeps reporting read-only while everything else may write', () => {
    const list = built.router!.list();
    expect(list.filter((r) => r.api === 'API-10').every((r) => !isWrite(r.method))).toBe(true);
    expect(list.some((r) => isWrite(r.method))).toBe(true);
  });

  it('exposes no endpoint anywhere that would let an agent commit, or a sale be edited', async () => {
    // The two absences the whole product rests on, checked across the assembled surface rather
    // than one module at a time (hard rules #2 and #5).
    for (const r of built.router!.list()) {
      expect(`${r.method} ${r.path}`).not.toMatch(/ai\/.*\/(apply|commit|execute)/i);
      if (r.path.startsWith('/v1/sales')) expect(isWrite(r.method) && r.method !== 'POST').toBe(false);
    }
  });
});
