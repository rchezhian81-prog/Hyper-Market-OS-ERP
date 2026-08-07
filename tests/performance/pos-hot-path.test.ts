import { describe, it, expect } from 'vitest';
import { CatalogueCache, type CatalogueSnapshot, type CatalogueProduct, type CatalogueBarcode } from '../../packages/catalogue/src/catalogue';
import { priceLine, sumLines } from '../../packages/pricing/src/pricing';
import { commitSale } from '../../packages/sale/src/sale';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/ledger';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { money } from '../../packages/contracts/src/money';
import { quantity } from '../../packages/contracts/src/quantity';
import { rate } from '../../packages/contracts/src/rate';
import { measure, measureComplexity, againstBudget, certifiedHardwareGate, TARGETS } from './harness';

// §32 — the POS hot path. NFR-02, QG-05, hard rule #1.
//
// What is being asserted here is SHAPE, not speed. §32's targets are stated "on certified pilot
// hardware", which is EX-09 and does not exist — so a green tick against 300 ms in CI would be
// the evidence somebody quotes at the pilot when the lane is slow. The regression that actually
// reaches production is a `Map.get` becoming an `Array.find` in a refactor, and that is visible
// in the growth curve on any machine at all.

const product = (i: number): CatalogueProduct => ({
  productId: `p-${i}`, sku: `SKU${i}`, name: `Product ${i}`, baseUom: 'ea',
  unitPriceMinor: 2_500 + (i % 900), taxBps: [0, 500, 1_200, 1_800][i % 4]!,
  status: 'active',
});

const barcode = (i: number): CatalogueBarcode => ({
  code: `890${String(i).padStart(10, '0')}`, productId: `p-${i}`, kind: 'standard',
});

function snapshot(n: number): CatalogueSnapshot {
  const products: CatalogueProduct[] = new Array<CatalogueProduct>(n);
  const barcodes: CatalogueBarcode[] = new Array<CatalogueBarcode>(n);
  for (let i = 0; i < n; i += 1) {
    products[i] = product(i);
    barcodes[i] = barcode(i);
  }
  return {
    tenantId: 't-perf', version: 1, builtAt: '2026-08-05T06:00:00Z',
    products, barcodes,
    embeddedRules: [{ prefix: '2', itemStart: 1, itemLength: 6, valueStart: 7, valueLength: 5, valueKind: 'weight' }],
  };
}

const code = (i: number): string => `890${String(i).padStart(10, '0')}`;

/**
 * Spread lookups across the WHOLE catalogue, using a stride coprime with any size used here.
 *
 * The obvious `i % n` is wrong, and wrong in the direction that hides regressions: with 300
 * iterations against 50,000 products it only ever asks for the first 300, so a linear scan finds
 * its match at the same absolute position whatever the catalogue size and never gets slower. The
 * tripwire below caught exactly that. A prime stride keeps the working set proportional to the
 * data, which is also the honest cache behaviour for the Map.
 */
const spread = (i: number, n: number): number => (i * 7_919) % n;

describe('a scan costs the same at 500 products and at 50,000', () => {
  it('does NOT grow with the catalogue — the regression a fast machine hides', () => {
    const r = measureComplexity({
      label: 'scan-to-line',
      sizes: [500, 5_000, 50_000],
      setup: (n) => ({ cache: new CatalogueCache(snapshot(n)), n }),
      operation: (fixture, i) => {
        const { cache, n } = fixture as { cache: CatalogueCache; n: number };
        cache.scan(code(spread(i, n)));
      },
      runsPerSize: 5_000,
    });

    // 100× the data. If the cost tracked it, this is an Array.find wearing a Map's name.
    expect(r.sizeRatio).toBe(100);
    expect(r.verdict, r.detail).toBe('flat');
    // Measured separation on this class of machine: a Map grows ~1.9×, a linear scan ~136×.
    expect(r.growthFactor).toBeLessThan(5);
  });

  it('and the harness FIRES on a linear scan — otherwise the test above proves nothing', () => {
    // A performance assertion nobody has seen fail is an assertion nobody should trust. This is
    // the same tripwire pattern the guardrails use: assert the codebase is clean AND that the
    // detector catches a known-bad sample. Without it, `measureComplexity` could return 'flat'
    // unconditionally and every test in this file would still pass.
    const r = measureComplexity({
      label: 'deliberate-linear-scan',
      sizes: [500, 5_000, 50_000],
      setup: (n) => ({
        rows: Array.from({ length: n }, (_, i) => ({ code: code(i), productId: `p-${i}` })),
        n,
      }),
      operation: (fixture, i) => {
        const { rows, n } = fixture as { rows: { code: string }[]; n: number };
        const wanted = code(spread(i, n));
        rows.find((r2) => r2.code === wanted);
      },
      runsPerSize: 300,
    });
    expect(r.verdict, r.detail).toBe('linear');
    expect(r.growthFactor).toBeGreaterThan(20);
  });

  it('builds the lane cache in one pass — indexing is startup cost, not scan cost', () => {
    const r = measureComplexity({
      label: 'catalogue-cache-build',
      sizes: [5_000, 50_000],
      setup: (n) => snapshot(n),
      operation: (fixture) => { new CatalogueCache(fixture as CatalogueSnapshot); },
      runsPerSize: 60,
    });
    // Building IS linear in the catalogue, and should be — it happens once, at lane start, and
    // the lane can wait a moment. What would matter is quadratic, which over 10× the data costs
    // 100× and turns a two-second start into three minutes on a real snapshot.
    expect(r.verdict, r.detail).not.toBe('worse_than_linear');
  });

  it('finds an unknown barcode as fast as a known one — a miss must not scan the catalogue', () => {
    const cache = new CatalogueCache(snapshot(50_000));
    const hit = measure({ label: 'hit', runs: 20_000, operation: (i) => { cache.scan(code(spread(i, 50_000))); } });
    const miss = measure({
      label: 'miss', runs: 20_000,
      operation: (i) => { try { cache.scan(`999${String(i).padStart(10, '0')}`); } catch { /* expected */ } },
    });

    // A miss that walks the catalogue is how a mis-scan freezes a queue on a Saturday. Errors
    // cost more than a hit (construction and a stack), so the bar is generous — what it catches
    // is a miss that is HUNDREDS of times slower, which is what a linear fallback looks like.
    expect(miss.p50Ms).toBeLessThan(Math.max(hit.p50Ms, 1e-4) * 100);
  });
});

describe('a basket is linear in its own lines, never in the catalogue', () => {
  const cache = new CatalogueCache(snapshot(50_000));

  const ringUp = (lines: number): void => {
    const priced = [];
    for (let i = 0; i < lines; i += 1) {
      const scan = cache.scan(code(i % 50_000));
      priced.push(priceLine({
        quantity: quantity(scan.quantityMinor, scan.product.baseUom as 'ea'),
        unitPrice: money(scan.product.unitPriceMinor, 'INR'),
        taxRate: rate(scan.product.taxBps),
      }));
    }
    sumLines(priced, 'INR');
  };

  it('rings a 200-line basket without going quadratic', () => {
    const r = measureComplexity({
      label: 'basket-ring-up',
      sizes: [25, 200],
      setup: (n) => n,
      operation: (n) => { ringUp(n as number); },
      runsPerSize: 200,
    });
    // 8× the lines must not cost far more than 8× the work. A quadratic total — re-summing every
    // line on every add — is invisible on a 5-item test basket and painful on a trolley shop.
    expect(r.growthFactor, r.detail).toBeLessThan(r.sizeRatio * 1.5);
  });

  it('reports the running total in constant time per line', () => {
    const priced = Array.from({ length: 200 }, (_, i) => {
      const scan = cache.scan(code(i));
      return priceLine({
        quantity: quantity(1, 'ea'),
        unitPrice: money(scan.product.unitPriceMinor, 'INR'),
        taxRate: rate(scan.product.taxBps),
      });
    });
    const small = measure({ label: 'sum-25', runs: 5_000, operation: () => { sumLines(priced.slice(0, 25), 'INR'); } });
    const large = measure({ label: 'sum-200', runs: 5_000, operation: () => { sumLines(priced, 'INR'); } });
    expect(large.p50Ms).toBeLessThan(Math.max(small.p50Ms, 1e-4) * 24);
  });
});

describe('committing a sale touches no network, at any speed (hard rule #1)', () => {
  const cache = new CatalogueCache(snapshot(5_000));

  const commit = (i: number): void => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    const scan = cache.scan(code(i % 5_000));
    const total = money(scan.product.unitPriceMinor, 'INR');
    commitSale({
      id: `s-${i}`, number: `B${i}`, laneId: 'lane-1', cashierId: 'u-1',
      tradingDay: '2026-08-05', committedAt: '2026-08-05T09:00:00Z',
      total, lines: [{ productId: scan.product.productId, quantityMinor: 1, uom: 'ea' }],
      tenders: [{ kind: 'cash', status: 'settled', amount: total }],
    }, ledger, outbox);
  };

  it('commits with fetch, XHR and WebSocket REMOVED from the runtime', () => {
    // Not a mock that records calls — the globals are gone. A hot path that reaches for one
    // throws rather than quietly succeeding on a machine where the network happens to work.
    const saved = {
      fetch: globalThis.fetch,
      XMLHttpRequest: (globalThis as Record<string, unknown>)['XMLHttpRequest'],
      WebSocket: (globalThis as Record<string, unknown>)['WebSocket'],
    };
    const forbid = (name: string) => () => { throw new Error(`hard rule #1: the POS hot path called ${name}`); };
    try {
      Object.defineProperty(globalThis, 'fetch', { value: forbid('fetch'), configurable: true, writable: true });
      (globalThis as Record<string, unknown>)['XMLHttpRequest'] = forbid('XMLHttpRequest');
      (globalThis as Record<string, unknown>)['WebSocket'] = forbid('WebSocket');

      for (let i = 0; i < 500; i += 1) commit(i);
    } finally {
      Object.defineProperty(globalThis, 'fetch', { value: saved.fetch, configurable: true, writable: true });
      (globalThis as Record<string, unknown>)['XMLHttpRequest'] = saved.XMLHttpRequest;
      (globalThis as Record<string, unknown>)['WebSocket'] = saved.WebSocket;
    }
  });

  it('commits at a cost independent of how much the lane has already sold today', () => {
    // The ledger grows all day. A commit that scans it is fine at 9am and unusable at 7pm —
    // the classic append-only mistake, and the one that only shows up on the busiest evening.
    const r = measureComplexity({
      label: 'commit-into-a-loaded-ledger',
      sizes: [100, 5_000],
      setup: (n) => {
        const ledger = new Ledger(new InMemoryLedgerStore());
        const outbox = new SyncOutbox();
        for (let i = 0; i < n; i += 1) {
          const total = money(2_500, 'INR');
          commitSale({
            id: `seed-${n}-${i}`, number: `B${i}`, laneId: 'lane-1', cashierId: 'u-1',
            tradingDay: '2026-08-05', committedAt: '2026-08-05T09:00:00Z', total,
            lines: [{ productId: `p-${i % 500}`, quantityMinor: 1, uom: 'ea' }],
            tenders: [{ kind: 'cash', status: 'settled', amount: total }],
          }, ledger, outbox);
        }
        return { ledger, outbox, n };
      },
      operation: (fixture, i) => {
        const { ledger, outbox, n } = fixture as { ledger: Ledger; outbox: SyncOutbox; n: number };
        const total = money(2_500, 'INR');
        commitSale({
          id: `live-${n}-${i}`, number: `L${i}`, laneId: 'lane-1', cashierId: 'u-1',
          tradingDay: '2026-08-05', committedAt: '2026-08-05T19:00:00Z', total,
          lines: [{ productId: 'p-1', quantityMinor: 1, uom: 'ea' }],
          tenders: [{ kind: 'cash', status: 'settled', amount: total }],
        }, ledger, outbox);
      },
      runsPerSize: 1_000,
    });
    expect(r.verdict, r.detail).toBe('flat');
  });
});

describe('measured against §32 — with the boundary stated, not blurred', () => {
  const cache = new CatalogueCache(snapshot(50_000));

  it('leaves room on scan-to-line for a till 50× slower than CI', () => {
    const sample = measure({ label: 'scan-to-line', runs: 20_000, operation: (i) => { cache.scan(code(i % 50_000)); } });
    const report = againstBudget({ label: 'scan-to-line', targetMs: TARGETS.posScanToLineMs, sample });
    expect(report.withinHeadroom, report.detail).toBe(true);
  });

  it('leaves room on a full basket total for a till 50× slower than CI', () => {
    const sample = measure({
      label: 'total-and-tender', runs: 2_000,
      operation: () => {
        const priced = [];
        for (let i = 0; i < 40; i += 1) {
          const scan = cache.scan(code(i));
          priced.push(priceLine({
            quantity: quantity(1, 'ea'),
            unitPrice: money(scan.product.unitPriceMinor, 'INR'),
            taxRate: rate(scan.product.taxBps),
          }));
        }
        sumLines(priced, 'INR');
      },
    });
    const report = againstBudget({ label: 'total-and-tender', targetMs: TARGETS.posTotalTenderMs, sample });
    expect(report.withinHeadroom, report.detail).toBe(true);
  });

  it('refuses to call ANY of it a certification', () => {
    const sample = measure({ label: 'scan', runs: 1_000, operation: (i) => { cache.scan(code(i % 50_000)); } });
    const report = againstBudget({ label: 'scan', targetMs: TARGETS.posScanToLineMs, sample });
    // Typed as the literal `false`, for the same reason `shopKeepsTrading` is typed `true`:
    // it is the claim somebody will otherwise make on this test's behalf in eighteen months.
    const certifies: false = report.certifiesTheTarget;
    expect(certifies).toBe(false);
    expect(report.detail).toContain('certified pilot hardware');
  });

  it('records what genuinely needs the hardware, so the boundary cannot be blurred', () => {
    const gate = certifiedHardwareGate();
    expect(gate.length).toBeGreaterThanOrEqual(5);
    for (const item of gate) {
      expect(item.what.length).toBeGreaterThan(15);
      expect(item.why.length).toBeGreaterThan(25);
    }
    expect(gate.some((i) => i.what.includes('300 ms'))).toBe(true);
  });
});
