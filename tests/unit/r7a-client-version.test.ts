import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { APP_BUILD_VERSION, judgeClientVersion, readPackVersionPolicy } from '../../packages/platform-admin/src/client-version';
import { PosSession, NewBillRefusedError, type ScanInput } from '../../apps/pos/src/session';
import { money } from '../../packages/contracts/src/money';
import { rate } from '../../packages/contracts/src/rate';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/index';
import { SyncOutbox } from '../../packages/sync/src/index';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { acceptSale, type IncomingSale, type IntakeContext } from '../../services/pos/src/index';
import { toCloudSale } from '../../edge/store-edge/src/cloud-sale';
import { canonicalHash, stampTakenAt, stampVersionCheck } from '../../edge/store-edge/src/idempotency';

// OB-501 (R7-A · M33-FR-02 · D12-FR-03): a till on a withdrawn or too-old build finishes the bill in progress, then refuses
// to START a new one (English and Tamil); the store computer marks such a bill; head office raises it. Never mid-sale.

const POLICY = { currentVersion: '2.1.0', previousVersion: '2.0.0', minimumSupportedVersion: '2.0.0', killedVersions: ['2.0.3'] };
const AT = '2026-10-28T09:30:00.000Z';
const item = (productId: string, priceMinor: number): ScanInput => ({ productId, description: productId, unitPrice: money(priceMinor, 'INR'), quantityMinor: 1, uom: 'ea' });
const cash = (minor: number) => [{ kind: 'cash' as const, amount: money(minor, 'INR'), status: 'settled' as const }];

describe('OB-501 — the build number and the verdict', () => {
  it('this release reports the root package version (a release bumps both)', () => {
    expect(APP_BUILD_VERSION).toBe((JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version);
  });

  it('below the minimum or withdrawn: may not START a bill, in English and Tamil; behind but supported, current, no policy: may', () => {
    const old = judgeClientVersion('1.9.9', POLICY);
    expect(old).toMatchObject({ verdict: 'upgrade_required', mayStartBill: false, minimumSupportedVersion: '2.0.0' });
    expect(old.words!.en).toMatch(/1\.9\.9.*too old.*2\.0\.0.*Finish the bill on screen/);
    expect(old.words!.ta).toContain('புதிய பில் தொடங்க முடியாது');
    const killed = judgeClientVersion('2.0.3', POLICY);
    expect(killed).toMatchObject({ verdict: 'version_killed', mayStartBill: false });
    expect(killed.words!.en).toContain('withdrawn by head office');
    expect(killed.words!.ta).toContain('திரும்பப் பெறப்பட்டது');
    expect(judgeClientVersion('2.0.1', POLICY)).toMatchObject({ verdict: 'upgrade_available', mayStartBill: true });
    expect(judgeClientVersion('2.10.0', POLICY)).toMatchObject({ verdict: 'ok', mayStartBill: true }); // numeric, not string, comparison
    expect(judgeClientVersion('2.0.1', undefined)).toMatchObject({ verdict: 'no_policy', mayStartBill: true });
    expect(judgeClientVersion(undefined, POLICY)).toMatchObject({ verdict: 'no_version_reported', mayStartBill: true });
    expect(judgeClientVersion('banana', POLICY)).toMatchObject({ verdict: 'not_comparable', mayStartBill: true });
    expect(readPackVersionPolicy({ currentVersion: '1.0.0' })).toBeUndefined();
    expect(readPackVersionPolicy(null)).toBeUndefined();
    expect(readPackVersionPolicy({ ...POLICY, killedVersions: ['2.0.3', 7] })).toEqual(POLICY);
  });
});

describe('OB-501 — the till finishes the bill in progress, then starts no new one', () => {
  const till = (records: string[]) => new PosSession(
    { laneId: 'lane-1', cashierId: 'u-meena', currency: 'INR', defaultTaxRate: rate(500), clock: () => AT, appVersion: '1.9.9' },
    new Ledger(new InMemoryLedgerStore()), new SyncOutbox(),
    async (_id: string, record: string) => { records.push(record); return { committed: true, durable: true, detail: 'ok', laneMessage: 'Saved.' }; },
  );

  it('the bar never interrupts a sale: more lines and the payment go through; the NEXT bill is refused; lifting the bar opens it', async () => {
    const records: string[] = [];
    const s = till(records);
    s.scan(item('p-rice', 10_000));
    const verdict = judgeClientVersion('1.9.9', POLICY);
    s.barNewBills(verdict.words!);
    s.scan(item('p-dal', 5_000)); // the bill on screen is finished
    await s.commit('S-1', 'N-1', AT, cash(15_000));
    expect(JSON.parse(records[0]!)).toMatchObject({ appVersion: '1.9.9' });
    s.newSale();
    let refused: unknown;
    try { s.scan(item('p-rice', 10_000)); } catch (e) { refused = e; }
    expect(refused).toBeInstanceOf(NewBillRefusedError);
    expect((refused as NewBillRefusedError).laneMessageTa).toContain('கல்லா');
    expect(s.basket()).toHaveLength(0);
    s.barNewBills(null);
    s.scan(item('p-rice', 10_000));
    expect(s.basket()).toHaveLength(1);
  });

  it('the served till judges its own build from the pack at boot and from the box\'s status later', () => {
    const t = bootPos({ laneId: 'lane-1', taxPercent: 0, appVersion: '1.9.9', appVersionPolicy: POLICY });
    expect(() => t.scan({ productId: 'p', description: 'Rice', unitPriceMinor: 1_000, qty: 1 })).toThrow(NewBillRefusedError);
    expect(t.applyVersionPolicy({ ...POLICY, minimumSupportedVersion: '1.0.0', previousVersion: '1.0.0' })).toMatchObject({ verdict: 'upgrade_available', mayStartBill: true });
    t.scan({ productId: 'p', description: 'Rice', unitPriceMinor: 1_000, qty: 1 });
    expect(t.basket()).toHaveLength(1);
    // A newer build arriving at the policy mid-bill: the bar returns, the bill on screen is still finished.
    expect(t.applyVersionPolicy({ ...POLICY, killedVersions: ['1.9.9'] })).toMatchObject({ verdict: 'version_killed' });
    t.scan({ productId: 'p', description: 'Rice', unitPriceMinor: 1_000, qty: 1 });
    expect(t.basket()).toHaveLength(2);
    // The real build, with no policy: nothing is enforced.
    expect(bootPos({ laneId: 'lane-1', taxPercent: 0 }).appVersion).toBe(APP_BUILD_VERSION);
  });
});

describe('OB-501 — the store computer marks the bill; head office raises it', () => {
  it('the box\'s mark rides to head office and is never part of the bill\'s identity', () => {
    const record = JSON.stringify({ id: 'S-1', number: 'N-1', laneId: 'lane-1', cashierId: 'u-meena', total: 100, lines: [], tenders: [], appVersion: '1.9.9' });
    const marked = stampVersionCheck(stampTakenAt(record, AT), () => ({ verdict: 'upgrade_required', reported: '1.9.9', minimumSupportedVersion: '2.0.0' }));
    expect(canonicalHash(marked)).toBe(canonicalHash(record));
    expect(stampVersionCheck(record, () => undefined)).toBe(record);
    expect(toCloudSale(JSON.parse(marked), 3)).toMatchObject({ appVersion: '1.9.9', storeComputerVersionCheck: { verdict: 'upgrade_required' } });
  });

  const sale = (over: Partial<IncomingSale> = {}): IncomingSale => ({
    saleId: 'S-1', receiptNumber: 'R-1', laneId: 'lane-1', cashierId: 'u-meena', tradingDay: '2026-10-28', committedAt: '2026-10-28T10:00:00Z',
    totalMinor: 0, currency: 'INR', packVersion: 1, lines: [], tenders: [], ...over,
  });
  const ctx = (over: Partial<IntakeContext> = {}): IntakeContext => ({ catalogue: new Map(), currentPackVersion: 1, saleHoldingThisReceipt: undefined, alreadyBanked: false, now: '2026-10-28T12:00:00Z', ...over });
  const found = (r: ReturnType<typeof acceptSale>) => r.exceptions.filter((e) => e.kind === 'sold_on_an_unsupported_app_version').map((e) => e.severity);

  it('by head office\'s own policy, or the box\'s mark; a supported build, or no policy and no mark, raises nothing', () => {
    expect(found(acceptSale(sale({ appVersion: '1.9.9' }), ctx({ versionPolicy: POLICY })))).toEqual(['material']);
    expect(found(acceptSale(sale({ appVersion: '2.0.3' }), ctx({ versionPolicy: POLICY })))).toEqual(['material']);
    expect(found(acceptSale(sale({ appVersion: '2.0.1' }), ctx({ versionPolicy: POLICY })))).toEqual([]);
    expect(found(acceptSale(sale({ appVersion: '1.9.9' }), ctx({ versionPolicy: null })))).toEqual([]);
    expect(found(acceptSale(sale({ appVersion: '1.9.9', storeComputerVersionCheck: { verdict: 'version_killed' } }), ctx()))).toEqual(['material']);
    expect(found(acceptSale(sale({ storeComputerVersionCheck: { verdict: 'no_version_reported' } }), ctx()))).toEqual(['informational']);
    expect(found(acceptSale(sale(), ctx()))).toEqual([]);
  });
});
