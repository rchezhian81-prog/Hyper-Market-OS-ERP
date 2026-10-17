import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { containsCardNumber } from '../../packages/tender/src/card-token';
import { withoutCardData, cardDataRemovalWords, holdsCardNumber, TENDER_FIELDS } from '../../packages/tender/src/tender-card-data';
import { checkLegacyCardPurge } from '../../packages/tender/src/legacy-card-purge';
import { startLaneServer, cleanTenders, type LaneServer } from '../../edge/store-edge/src/lane-server';
import { createEdgeNode } from '../../edge/store-edge/src/index';
import { openFileLog } from '../../edge/store-edge/src/file-log';
import { toCloudSale } from '../../edge/store-edge/src/cloud-sale';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { hmacSigner } from '../../services/catalogue/src/index';
import { acceptSale, posRoutes, type IncomingSale, type SaleException } from '../../services/pos/src/index';
import { money } from '../../packages/contracts/src/money';

/**
 * **NEW-3 (C10 · hard rule #3): card data never reaches a disk, an event or a log — on the real paths.**
 *
 * The verifier found `readCardTokenReference` called by nothing but its own tests, and a card number sent in a tender
 * banked as sent. It is now run where a tender is KEPT: the till's commit, the store computer's sale and refund routes
 * before the disk, and head office's sale intake before the event store.
 *
 * **Removed and raised, not refused.** By the time a sale reaches any of these it has happened — the card machine said yes
 * and the customer has the goods — and a refusal would lose a real sale (hard rule #1: "the server does not get to say
 * no"; the box refusing would leave the till re-sending the same record for ever). So the forbidden part is REMOVED, the
 * sale is kept, and the removal is a CRITICAL finding at head office, named by field only: the value is never repeated.
 * Synthetic data only: the numbers below are the public test card numbers card networks publish for testing.
 */

const PAN = ['4111', '1111', '1111', '1111'].join('');
const AMEX = ['3782', '822463', '10005'].join('');
const noCardIn = (text: string): void => {
  expect(text.includes(PAN), 'the card number is in it').toBe(false);
  expect(text.includes(AMEX), 'the card number is in it').toBe(false);
  expect(containsCardNumber(text), 'something card-shaped is in it').toBe(false);
};
const HOSTILE_TENDER = { kind: 'card', amountMinor: 70_00, ref: PAN, card: { tokenRef: `ntok_${PAN}`, last4: '1111', network: 'visa', pan: PAN, cvv: '123', expiry: '12/29' } };

describe('the rule: a tender keeps a token, the last four and the network — nothing else', () => {
  it('a hostile tender: the card-shaped ref, the card object that is not clean and any extra field are removed, by name', () => {
    const { tenders, removed } = withoutCardData([{ ...HOSTILE_TENDER, cardNumber: PAN }]);
    expect(tenders).toEqual([{ kind: 'card', amountMinor: 70_00 }]);
    expect(removed).toEqual([{ tender: 0, kind: 'card', fields: ['card.cvv', 'card.expiry', 'card.last4', 'card.network', 'card.pan', 'card.tokenRef', 'cardNumber', 'ref'] }]);
    noCardIn(JSON.stringify(removed));
    noCardIn(cardDataRemovalWords(removed));
  });

  it('a clean card tender and every ordinary tender pass untouched — the same objects', () => {
    const clean = [
      { kind: 'card', amount: { minor: 500, currency: 'INR' }, status: 'authorized', ref: 'att-2026-0001', card: { tokenRef: 'ntok_9f2c', last4: '4242', network: 'mastercard' } },
      { kind: 'cash', amountMinor: 100 },
      { kind: 'upi', amountMinor: 100, ref: 'UTR2026101100042' },
      { kind: 'loyalty_points', amountMinor: 50, points: 50 },
    ];
    const out = withoutCardData(clean);
    expect(out.removed).toEqual([]);
    expect(out.tenders).toBe(clean);
  });

  it('a card number hidden anywhere in a tender, in any grouping, is found; a field NAMED like one is not repeated', () => {
    for (const v of [PAN, `${PAN.slice(0, 4)} ${PAN.slice(4, 8)} ${PAN.slice(8, 12)} ${PAN.slice(12)}`, PAN.replace(/(\d{4})(?=\d)/g, '$1.'), PAN.replace(/(\d{4})(?=\d)/g, '$1/'), PAN.replace(/(\d{4})(?=\d)/g, '$1_'), `tok_${AMEX}`]) {
      expect(withoutCardData([{ kind: 'upi', amountMinor: 1, ref: v }]).removed[0]?.fields, v).toEqual(['ref']);
    }
    const named = withoutCardData([{ kind: 'cash', amountMinor: 1, [PAN]: 'x' }]);
    expect(named.removed[0]?.fields).toEqual(['(a field named like a card number)']);
    noCardIn(JSON.stringify(named.removed));
    // L4: the legacy purge check reads the same detector, so dotted / slashed / underscored numbers no longer pass it.
    for (const v of ['4111.1111.1111.1111', '4111/1111/1111/1111', '4111_1111_1111_1111']) {
      expect(checkLegacyCardPurge([{ source: 's', rowRef: '1', fields: { remarks: v } }]).passed, v).toBe(false);
    }
  });

  it('the allowlist is closed and short', () => {
    expect([...TENDER_FIELDS]).toEqual(['kind', 'amount', 'amountMinor', 'status', 'ref', 'points', 'card', 'cardDataRemoved']);
  });
});

// Coordinator note (F2's `containsGroupedCardNumber`): card numbers grouped with dots, slashes or underscores, and one
// followed by its expiry in the same run, are found on the SALE path too — by the store computer and by head office.
const GROUPED = [
  PAN.replace(/(\d{4})(?=\d)/g, '$1.'), PAN.replace(/(\d{4})(?=\d)/g, '$1/'), PAN.replace(/(\d{4})(?=\d)/g, '$1_'),
  `${PAN.replace(/(\d{4})(?=\d)/g, '$1.')}/12-29`, `paid ${AMEX.slice(0, 4)}.${AMEX.slice(4, 10)}.${AMEX.slice(10)} ok`,
];
const digitsOf = (v: string): string => v.replace(/\D/g, '');

describe('grouped card numbers on the sale path (dotted, slashed, underscored, with an expiry)', () => {
  it('both detectors are read: a number followed by its expiry is found though the plain run is not a card', () => {
    const withExpiry = `${PAN.replace(/(\d{4})(?=\d)/g, '$1.')}/12-29`;
    expect(containsCardNumber(withExpiry)).toBe(false);
    expect(holdsCardNumber(withExpiry)).toBe(true);
    for (const v of ['2026-10-16', '9876543210', '8901030865278', 'UTR2026101100042']) expect(holdsCardNumber(v), v).toBe(false);
  });

  it('the store computer keeps each sale with the grouped number removed — its disk never holds the digits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-f1-grouped-'));
    const log = await openFileLog({ dataDir: dir, capacityBytes: 50_000_000 });
    const outbox = new SyncOutbox();
    const node = createEdgeNode({ tenantId: 't-f1', log, signer: hmacSigner(['f1', 'edge', 'key'].join('-').padEnd(40, '0')), outbox });
    const server = await startLaneServer({ node, port: 0 });
    try {
      for (const [i, v] of GROUPED.entries()) {
        const res = await fetch(`http://127.0.0.1:${server.port}/lane/sales`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:8080' }, body: JSON.stringify({
          id: `S-G${i}`, number: `R-G${i}`, laneId: 'lane-1', cashierId: 'u', committedAt: new Date().toISOString(), total: 100,
          lines: [{ productId: 'P', quantityMinor: 1, uom: 'ea', unitPriceMinor: 100, lineTotalMinor: 100 }],
          tenders: [{ kind: 'upi', amount: { minor: 100 }, ref: v }],
        }) });
        expect((await res.json() as { committed: boolean }).committed, v).toBe(true);
      }
      const kept = await readFile(join(dir, 'sales.log'), 'utf8');
      for (const v of GROUPED) {
        expect(kept, v).not.toContain(v);
        expect(kept.replace(/\D/g, ''), v).not.toContain(digitsOf(v).slice(0, 15));
      }
      expect(kept.match(/"cardDataRemoved":\{"fields":\["ref"\]\}/g)).toHaveLength(GROUPED.length);
      for (const p of outbox.pending()) expect(holdsCardNumber(JSON.stringify(p))).toBe(false);
    } finally { await server.stop(); await log.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it('head office raises each one critical and banks the sale without it', async () => {
    for (const v of GROUPED) {
      const banked: IncomingSale[] = [];
      const route = posRoutes({
        catalogue: () => new Map(), currentPackVersion: () => 1, saleHoldingReceipt: () => undefined, isBanked: () => false,
        bankSale: (_t, s) => { banked.push(s); }, recordExceptions: () => {}, openExceptions: () => [], now: () => '2026-10-16T05:01:00Z',
      }).find((r) => r.path === '/v1/sales')!;
      const out = await route.handler({ tenantId: 't', userId: 'u-box', params: {}, query: {}, body: {
        saleId: 'S-G', receiptNumber: 'R-G', laneId: 'lane-1', cashierId: 'u', tradingDay: '2026-10-16', committedAt: '2026-10-16T05:00:00Z',
        totalMinor: 100, currency: 'INR', packVersion: 1, lines: [], tenders: [{ kind: 'upi', amountMinor: 100, ref: v }],
      } } as never);
      expect((out.body as { exceptions: { kind: string; severity: string }[] }).exceptions.filter((e) => e.kind === 'card_data_in_tender').map((e) => e.severity), v).toEqual(['critical']);
      expect(banked[0]!.tenders, v).toEqual([{ kind: 'upi', amountMinor: 100 }]);
      expect(JSON.stringify(out.body), v).not.toContain(v);
    }
  });
});

describe('the till: what it hands its store computer holds nothing card-like', () => {
  it('a card tender carrying more than the three facts leaves the till with them removed', async () => {
    const written: string[] = [];
    // The session's own commit, given a tender as a third-party card-machine link might build it.
    const { PosSession } = await import('../../apps/pos/src/session');
    const { Ledger, InMemoryLedgerStore } = await import('../../packages/ledger/src/ledger');
    const { rate } = await import('../../packages/contracts/src/rate');
    const s = new PosSession({ laneId: 'lane-1', cashierId: 'u', currency: 'INR', defaultTaxRate: rate(0) }, new Ledger(new InMemoryLedgerStore()), new SyncOutbox(), async (_id, r) => { written.push(r); return { committed: true, durable: true, detail: 'd', laneMessage: 'ok' }; });
    s.scan({ productId: 'P-RICE', description: 'Rice', unitPrice: money(70_00, 'INR'), quantityMinor: 1, uom: 'ea' } as never);
    await s.commit('S-C', 'R-C', new Date().toISOString(), [{ kind: 'card', amount: money(70_00, 'INR'), status: 'authorized', ref: 'att-1', card: { tokenRef: 'ntok_1', last4: '1111', network: 'visa', pan: PAN, cvv: '123' } as never }]);
    const record = written.at(-1)!;
    noCardIn(record);
    expect((JSON.parse(record) as { tenders: unknown[] }).tenders).toEqual([{ kind: 'card', amount: { minor: 70_00, currency: 'INR' }, status: 'authorized', ref: 'att-1' }]);
  });
});

describe('the store computer: removed before its disk, marked by name, and carried to head office as a mark', () => {
  const servers: LaneServer[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await s.stop();
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('a hostile sale and refund: the sale is SAVED, nothing card-like is on the disk, in the queue for head office, or in the logs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-f1-card-'));
    dirs.push(dir);
    const log = await openFileLog({ dataDir: dir, capacityBytes: 50_000_000 });
    const returnsLog = await openFileLog({ dataDir: dir, capacityBytes: 50_000_000, fileName: 'returns.log' });
    const outbox = new SyncOutbox();
    const returnsOutbox = new SyncOutbox();
    const node = createEdgeNode({ tenantId: 't-f1', log, signer: hmacSigner(['f1', 'edge', 'key'].join('-').padEnd(40, '0')), outbox, returnsLog, returnsOutbox });
    const said: string[] = [];
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { said.push(a.map(String).join(' ')); });
    const server = await startLaneServer({ node, port: 0 });
    servers.push(server);
    const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${server.port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:8080' }, body: JSON.stringify(body) });

    const saleRes = await post('/lane/sales', {
      id: 'S-HOSTILE', number: 'R-1', laneId: 'lane-1', cashierId: 'u', committedAt: new Date().toISOString(), total: 70_00,
      lines: [{ productId: 'P-RICE', quantityMinor: 1, uom: 'ea', unitPriceMinor: 70_00, lineTotalMinor: 70_00 }],
      // A till cannot claim the mark either: it is dropped and rewritten from what THIS box removed.
      tenders: [{ ...HOSTILE_TENDER, amount: { minor: 70_00 }, cardDataRemoved: { fields: [] } }],
    });
    const answer = await saleRes.json() as Record<string, unknown>;
    expect(answer['committed']).toBe(true);
    expect(answer['cardDataNotice']).toMatch(/were NOT kept/);
    noCardIn(JSON.stringify(answer));

    const refundRes = await post('/lane/returns', {
      returnId: 'RET-HOSTILE', number: 'RF-1', originalSaleId: 'S-HOSTILE', laneId: 'lane-1', processedBy: 'u', processedAt: new Date().toISOString(),
      reasonCode: 'damaged', refundMinor: 0, refundTender: 'exchange', lines: [{ productId: 'P-RICE', quantityMinor: 1 }],
      exchange: { replacementSaleId: 'S-REPL', replacementTotalMinor: 80_00, appliedMinor: 70_00, balance: 'top_up', balanceMinor: 10_00, topUpTenders: [{ kind: 'card', amountMinor: 10_00, ref: PAN, cvv: '123' }] },
    });
    noCardIn(JSON.stringify(await refundRes.json()));

    for (const f of await readdir(dir)) noCardIn(await readFile(join(dir, f), 'utf8'));
    const kept = await readFile(join(dir, 'sales.log'), 'utf8');
    expect(kept).toContain('S-HOSTILE'); // the sale is on the disk — kept, not lost
    expect(kept).toContain('"cardDataRemoved":{"fields":["card.cvv","card.expiry","card.last4","card.network","card.pan","card.tokenRef","ref"]}');
    noCardIn(JSON.stringify(outbox.pending()));
    noCardIn(JSON.stringify(returnsOutbox.pending()));
    noCardIn(said.join('\n'));

    // What the box sends head office carries the mark, so head office raises it.
    const sent = outbox.pending()[0]!.event.payload as IncomingSale;
    expect(sent.tenders[0]).toEqual({ kind: 'card', amountMinor: 70_00, cardDataRemoved: { fields: ['card.cvv', 'card.expiry', 'card.last4', 'card.network', 'card.pan', 'card.tokenRef', 'ref'] } });
    const findings = acceptSale(sent, { catalogue: new Map(), currentPackVersion: 1, saleHoldingThisReceipt: undefined, alreadyBanked: false, now: new Date(Date.now() + 60_000).toISOString() });
    const raised = findings.exceptions.filter((e) => e.kind === 'card_data_in_tender');
    expect(raised.map((e) => e.severity)).toEqual(['critical']);
    expect(raised[0]!.detail).toMatch(/the store computer removed card data the till sent, before its disk/);
    await log.close(); await returnsLog.close();
  });

  it('cleanTenders is deterministic (a re-sent sale is the same record) and leaves a clean record as it was', () => {
    const rec = { id: 'S', tenders: [HOSTILE_TENDER] };
    expect(JSON.stringify(cleanTenders(rec, false))).toBe(JSON.stringify(cleanTenders(JSON.parse(JSON.stringify(rec)) as Record<string, unknown>, false)));
    const ok = { id: 'S', tenders: [{ kind: 'cash', amount: { minor: 1 } }] };
    expect(cleanTenders(ok, false)).toEqual({ record: ok, removed: [] });
  });

  it('a clean card tender\'s three facts travel to head office; anything else about a card does not', () => {
    const cloud = toCloudSale({ id: 'S', total: 1, tenders: [{ kind: 'card', amount: { minor: 1 }, ref: 'att-1', card: { tokenRef: 'ntok_1', last4: '4242', network: 'rupay' } }] }, 1);
    expect(cloud.tenders).toEqual([{ kind: 'card', amountMinor: 1, ref: 'att-1', card: { tokenRef: 'ntok_1', last4: '4242', network: 'rupay' } }]);
    const dirty = toCloudSale({ id: 'S', total: 1, tenders: [{ kind: 'card', amount: { minor: 1 }, card: { tokenRef: 'ntok_1', last4: '4242', network: 'rupay', cvv: '123' } }] }, 1);
    expect(dirty.tenders).toEqual([{ kind: 'card', amountMinor: 1 }]);
  });
});

describe('head office: the intake raises it, and what it banks holds nothing card-like', () => {
  const VERIFIER_SALE = {
    saleId: 'S-1', receiptNumber: 'R-1', laneId: 'lane-1', cashierId: 'u', tradingDay: '2026-10-16', committedAt: '2026-10-16T05:00:00Z',
    totalMinor: 70_00, currency: 'INR', packVersion: 4,
    lines: [{ productId: 'P-RICE', quantityMinor: 1, uom: 'ea', unitPriceMinor: 70_00, lineTotalMinor: 70_00, taxRateBps: 0 }],
    tenders: [HOSTILE_TENDER],
  } as unknown as IncomingSale;
  const catalogue = new Map([['P-RICE', { productId: 'P-RICE', sku: 'RICE', name: 'Rice', baseUom: 'ea', unitPriceMinor: 70_00, taxBps: 0, status: 'active' as const }]]);

  it('the verifier\'s sale: one critical finding, by field name, the value never repeated', () => {
    const res = acceptSale(VERIFIER_SALE, { catalogue, currentPackVersion: 4, saleHoldingThisReceipt: undefined, alreadyBanked: false, now: '2026-10-16T05:01:00Z' });
    expect(res.banked).toBe(true);
    expect(res.exceptions.map((e) => [e.kind, e.severity])).toEqual([['card_data_in_tender', 'critical']]);
    noCardIn(JSON.stringify(res));
  });

  it('POST /v1/sales banks the sale with the card data removed; the finding, the answer and the store hold nothing card-like', async () => {
    const banked: IncomingSale[] = [];
    const recorded: SaleException[] = [];
    const route = posRoutes({
      catalogue: () => catalogue, currentPackVersion: () => 4, saleHoldingReceipt: () => undefined, isBanked: () => false,
      bankSale: (_t, s) => { banked.push(s); }, recordExceptions: (_t, e) => { recorded.push(...e); }, openExceptions: () => [], now: () => '2026-10-16T05:01:00Z',
    }).find((r) => r.path === '/v1/sales')!;
    const out = await route.handler({ tenantId: 't', userId: 'u-box', params: {}, query: {}, body: VERIFIER_SALE } as never);
    expect(out.status).toBe(202);
    expect(banked).toHaveLength(1);
    expect(banked[0]!.tenders).toEqual([{ kind: 'card', amountMinor: 70_00 }]);
    expect(recorded.map((e) => e.kind)).toEqual(['card_data_in_tender']);
    for (const text of [JSON.stringify(banked), JSON.stringify(recorded), JSON.stringify(out.body)]) noCardIn(text);
  });
});
