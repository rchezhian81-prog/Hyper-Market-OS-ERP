// The deployed-workflow SMOKE TEST — run ON the demo box against the API that is actually live there (owner direction,
// 1 October 2026: "a green workflow with a skipped deployment is not success"; "prove the deployed workflow").
//
//   pnpm run demo:smoke -- [--env-file infra/compose/.env.pilot] [--api http://127.0.0.1:8081]
//                          [--tenant <uuid>] [--run <label>] [--report <file.json>] [--apps-dir apps]
//
// It drives the SAME connected loop the repository's own proofs drive (`tests/integration/the-store-buys-what-it-sells.test.ts`
// and `…/the-store-trades-a-day.test.ts`), but against whatever API the box is serving, through the real routes, as named
// synthetic people, with a real store box started in this process against that API and the till's own session model:
//
//   supplier (proposed, approved by a second person) → purchase order (proposed, issued by a second person) → delivery at
//   the back store with two damaged tins QUARANTINED → QC sends them back → floor indent → manager approval against real
//   stock → back-store issue (in transit, NOT received) → independent floor receipt → the till pulls head office's pack
//   and SELLS one by barcode → the sale banks and the shelf falls by ONE → an eligible resale RETURN puts it back →
//   float, pickup, blind close → the cash office sees the chain and no over/short → invoice matched, debit note, payables
//   and the day book posted and balanced → the dashboard shows the day → the same sale re-sent banks once.
//
// Every step is reported PASS / FAIL with what was seen; the exit code is 0 only when every step passed. It writes nothing
// but a report file you ask for. It never prints a token or a key. Synthetic data only: it runs in its OWN tenant (a fresh
// UUID it creates through the same bootstrap the operator tool uses — refused on a production box, refused on the demo
// tenant) or in a tenant you name; every id it writes carries the run label so re-runs never collide.
//
// It lives under scripts/ on purpose: it mints the synthetic people's tokens with the pilot's stand-in identity provider
// key, which production code never does (hard rule #4; guardrail `no-test-idp-in-production`).

import { randomUUID, createHmac } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Pool } from 'pg';
import { startEdge, type EdgeProcess } from '../edge/store-edge/src/main';
import { bootPos } from '../apps/pos/src/browser-entry';
import type { CatalogueSnapshot } from '../packages/catalogue/src/catalogue';
import { DEFAULT_RETAIL_POSTING_MAP } from '../packages/finance/src/index';
import { makeTradingDayRule, tradingDateOf } from '../packages/calendar/src/trading-day';
import { SqlEventStore } from '../packages/persistence/src/event-store';
import { pgPoolClient } from '../packages/persistence/src/pg-client';
import { databaseUrlFromTheHost } from './lib/database-url-from-the-host';
import { seedInitialAdmins } from '../services/api/src/access';
import { OWNER_ROLE_ID, ROLE_CATALOGUE } from '../services/api/src/roles';
import { planTenantBootstrap } from '../packages/migration/src/tenant-bootstrap';
import { parseEnvText, parseFlags, demoTenantIds, tokenPolicyFromEnv, type TokenPolicy } from './lib/operator-env';

export interface SmokeCast {
  readonly owner: string; readonly buyer: string; readonly receiver: string; readonly checker: string; readonly manager: string;
  readonly backstore: string; readonly shelf: string; readonly cashier: string; readonly acct: string; readonly box: string;
}

/** The synthetic people of one run — every id carries the run label, so two runs in one tenant never meet. */
export function castFor(run: string): SmokeCast {
  const p = `smoke-${run}`;
  return {
    owner: `${p}-owner`, buyer: `${p}-buyer`, receiver: `${p}-receiver`, checker: `${p}-checker`, manager: `${p}-manager`,
    backstore: `${p}-backstore`, shelf: `${p}-shelf`, cashier: `${p}-cashier`, acct: `${p}-accountant`, box: `${p}-box`,
  };
}

/** The roles each person must hold — what the bootstrap lays down for a fresh smoke tenant. */
export function rolesFor(cast: SmokeCast): readonly { readonly userId: string; readonly roleId: string }[] {
  return [
    ...[cast.buyer, cast.receiver, cast.checker, cast.manager, cast.backstore, cast.shelf].map((userId) => ({ userId, roleId: 'store_manager' })),
    { userId: cast.cashier, roleId: 'cashier' }, { userId: cast.box, roleId: 'cashier' }, { userId: cast.acct, roleId: 'accountant' },
  ];
}

export interface SmokeInput {
  readonly apiBaseUrl: string;
  readonly policy: TokenPolicy;
  readonly packSigningKey: string;
  readonly tenantId: string;
  readonly run: string;
  /** Where the app shells live, relative to the working directory (the box serves the till from here). */
  readonly appsDir?: string;
  readonly say?: (line: string) => void;
}

export interface SmokeStep { readonly name: string; readonly ok: boolean; readonly detail: string }
export interface SmokeReport {
  readonly tenantId: string; readonly run: string; readonly apiBaseUrl: string; readonly startedAt: string; readonly finishedAt: string;
  /** The commit of the checkout this script ran from — the software version to record under SP-10. */
  readonly checkoutCommit: string | null;
  readonly steps: readonly SmokeStep[]; readonly ok: boolean;
}

const PRICE = 48_000;   // ₹480.00 shelf price, GST inside (A9)
const COST = 40_000;    // ₹400.00 delivered cost
const ORDERED = 12; const GOOD = 10; const DAMAGED = 2;
const b64url = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');

/** A token the API accepts for one synthetic person — the stand-in identity provider's shape, with the step-up evidence an ordinary sign-in carries. */
function mint(sub: string, tenantId: string, policy: TokenPolicy): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url({ alg: 'HS256', typ: 'JWT' });
  const payload = b64url({ sub, tenant_id: tenantId, auth_time: now, amr: ['pwd', 'mfa'], iss: policy.issuer, aud: policy.audience, iat: now, jti: randomUUID(), exp: now + 3600 });
  const signature = createHmac('sha256', policy.secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

interface Reply { readonly status: number; readonly body: unknown }
class StepFailed extends Error {}

function checkoutCommit(): string | null {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}

export async function runSmoke(input: SmokeInput): Promise<SmokeReport> {
  const say = input.say ?? (() => {});
  const startedAt = new Date().toISOString();
  const cast = castFor(input.run);
  const run = input.run;
  const STORE = `${run}-S1`; const BACK = `${run}-S1-BACK`; const COMPANY = `${run}-C1`; const LANE = `${run}-lane-1`;
  const SUPPLIER = `${run}-s-amma`; const PO = `${run}-po-1`; const GRN = `${run}-grn-1`; const INDENT = `${run}-ind-1`; const PRODUCT = `${run}-p-rice`;
  // A 13-digit numeric barcode unique to the run (the scanner-shaped code the till expects).
  const BARCODE = `890${Math.abs([...run].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)).toString().padStart(10, '0').slice(0, 10)}`;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata';
  const steps: SmokeStep[] = [];
  const edges: EdgeProcess[] = [];
  const dirs: string[] = [];

  const call = async (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown, idempotencyKey?: string): Promise<Reply> => {
    const response = await fetch(`${input.apiBaseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${mint(userId, input.tenantId, input.policy)}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(idempotencyKey === undefined ? {} : { 'idempotency-key': `${run}-${idempotencyKey}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: unknown = text;
    try { parsed = text === '' ? null : JSON.parse(text); } catch { /* text as it came */ }
    return { status: response.status, body: parsed };
  };
  const expectStatus = (r: Reply, allowed: readonly number[], what: string): Record<string, unknown> => {
    if (!allowed.includes(r.status)) throw new StepFailed(`${what}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
    return (r.body ?? {}) as Record<string, unknown>;
  };
  const codeOf = (r: Reply): string | undefined => (r.body as { error?: { code?: string } } | null)?.error?.code;
  const must = (condition: boolean, what: string): void => { if (!condition) throw new StepFailed(what); };
  interface Availability { rows: { locationId: string; onHandMinor: number }[]; inTransit: { transferId: string; locationId: string; fromLocationId: string; quantityMinor: number }[] }
  const availability = async (): Promise<Availability> => expectStatus(await call('GET', `/v1/inventory/availability?productId=${PRODUCT}`, cast.owner), [200], 'availability') as unknown as Availability;
  const onHandAt = async (locationId: string): Promise<number> => (await availability()).rows.find((r) => r.locationId === locationId)?.onHandMinor ?? 0;
  const valuationAt = async (locationId: string): Promise<number> => {
    const v = expectStatus(await call('GET', `/v1/inventory/valuation?productId=${PRODUCT}`, cast.owner), [200], 'valuation') as unknown as { rows: { locationId: string; productId: string; value: { minor: number } }[] };
    return v.rows.filter((r) => r.locationId === locationId && r.productId === PRODUCT).reduce((s, r) => s + r.value.minor, 0);
  };
  const servedTillCatalogue = async (edge: EdgeProcess): Promise<(CatalogueSnapshot & { source?: string }) | undefined> => {
    const html = await (await fetch(`http://127.0.0.1:${edge.screens!.port}/pos/`)).text();
    const match = /<script>window\.posCatalogue = ([\s\S]*?);<\/script>/.exec(html);
    return match === null ? undefined : JSON.parse(match[1]!) as CatalogueSnapshot & { source?: string };
  };
  const startBox = async (): Promise<EdgeProcess> => {
    const dataDir = await mkdtemp(join(tmpdir(), 'sre-demo-smoke-'));
    dirs.push(dataDir);
    const packFile = join(dataDir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify({
      version: 1,
      policies: { storeId: STORE, branchId: STORE, branchName: 'Smoke store', warehouseId: BACK, tradingDayCutoff: '00:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 0 },
      lossPreventionRules: [],
    }), 'utf8');
    const edge = await startEdge({
      EDGE_DATA_DIR: dataDir, EDGE_TENANT_ID: input.tenantId, PACK_SIGNING_KEY: input.packSigningKey, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_LANE_ID: LANE, EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: input.appsDir ?? 'apps', EDGE_PACK_FILE: packFile,
      CLOUD_API_URL: input.apiBaseUrl, CLOUD_API_TOKEN: mint(cast.box, input.tenantId, input.policy),
    }, () => {});
    if (edge === undefined) throw new StepFailed('the store box refused to start in this process');
    edges.push(edge);
    return edge;
  };

  let stopped = false;
  const step = async (name: string, fn: () => Promise<string>): Promise<void> => {
    if (stopped) { steps.push({ name, ok: false, detail: 'not run — an earlier step failed' }); return; }
    try {
      const detail = await fn();
      steps.push({ name, ok: true, detail });
      say(`PASS  ${name} — ${detail}`);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      steps.push({ name, ok: false, detail });
      say(`FAIL  ${name} — ${detail}`);
      stopped = true;
    }
  };

  const today = new Date().toISOString().slice(0, 10);
  const unitCost = { minor: COST, currency: 'INR' };
  let salePayload: Record<string, unknown> | undefined;
  let tradingDay = today;

  try {
    await step('the API answers and is ready', async () => {
      const r = await fetch(`${input.apiBaseUrl}/readyz`);
      const body = (await r.json()) as { ready?: boolean };
      must(r.status === 200 && body.ready === true, `/readyz said ${r.status} ${JSON.stringify(body)}`);
      return `ready at ${input.apiBaseUrl}`;
    });
    await step('store setup: the shop\'s time zone and the receiving tolerances', async () => {
      expectStatus(await call('PUT', '/v1/platform/setup/locale.time_zone', cast.owner, { value: zone }, 'setup-tz'), [200, 201], 'time zone');
      expectStatus(await call('POST', '/v1/inventory/receipt-policy', cast.owner, { excessToleranceBp: 0, shortageToleranceBp: 0, nearExpiryDays: 7 }, 'receipt-policy'), [200, 201], 'receipt policy');
      return `zone ${zone}; nothing short or over is waved through`;
    });
    await step('the places: company, store (floor) and back store', async () => {
      expectStatus(await call('POST', `/v1/org/nodes/${COMPANY}`, cast.owner, { kind: 'company', name: 'Smoke Retail' }, `org-${COMPANY}`), [201], 'company');
      expectStatus(await call('POST', `/v1/org/nodes/${STORE}`, cast.owner, { kind: 'branch', name: 'Smoke store', parentId: COMPANY, companyId: COMPANY }, `org-${STORE}`), [201], 'store');
      expectStatus(await call('POST', `/v1/org/nodes/${BACK}`, cast.owner, { kind: 'warehouse', name: 'Smoke back store', parentId: STORE, companyId: COMPANY }, `org-${BACK}`), [201], 'back store');
      return `${STORE} with back store ${BACK}`;
    });
    await step('head office publishes the catalogue: tax rate, product, store price, barcode, signed pack', async () => {
      const tax = await call('POST', '/v1/catalogue/tax-classes/1006/rates/2017-07-01', cast.owner, { rateBps: 500 }, 'tax-1006');
      must(tax.status < 300 || tax.status === 409, `tax rate: HTTP ${tax.status}`);
      expectStatus(await call('POST', `/v1/catalogue/products/${PRODUCT}/publish`, cast.owner, {
        product: { sku: `${run}-RICE-5KG`, name: 'Smoke Ponni rice 5kg', baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '1006', lifecycle: 'active' },
        categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }],
      }, `publish-${PRODUCT}`), [201], 'product publish');
      expectStatus(await call('POST', `/v1/prices/list/${PRODUCT}/entries/e1`, cast.owner, {
        scope: 'store', scopeRef: STORE, priceMinor: PRICE, mrpMinor: 50_000, costMinor: COST, marginFloorBps: 0, currency: 'INR', effectiveFrom: today,
      }, `price-${PRODUCT}`), [201], 'price');
      expectStatus(await call('POST', `/v1/catalogue/products/${PRODUCT}/barcodes/${BARCODE}`, cast.owner, { kind: 'ean' }, `barcode-${PRODUCT}`), [201], 'barcode');
      expectStatus(await call('POST', '/v1/catalogue/pack', cast.owner, { storeId: STORE, asOf: today }, 'pack-1'), [201], 'pack publish');
      return `${PRODUCT} at ₹${PRICE / 100} (barcode ${BARCODE}), pack published for ${STORE}`;
    });
    await step('supplier proposed by the buyer, approved by a second person; self-approval refused', async () => {
      expectStatus(await call('POST', `/v1/purchase/suppliers/${SUPPLIER}`, cast.buyer, { name: 'Smoke Amma Traders' }, `sup-${SUPPLIER}`), [201], 'supplier');
      must(codeOf(await call('POST', `/v1/purchase/suppliers/${SUPPLIER}/approval`, cast.buyer, { reason: 'mine' }, 'sup-approve-self')) === 'forbidden', 'the buyer approved their own supplier');
      expectStatus(await call('POST', `/v1/purchase/suppliers/${SUPPLIER}/approval`, cast.owner, { reason: 'GST certificate and FSSAI licence checked' }, 'sup-approve'), [200], 'supplier approval');
      return `${SUPPLIER} approved by ${cast.owner}, not by the buyer`;
    });
    await step('purchase order proposed by the buyer, issued by a second person; the commitment shows', async () => {
      expectStatus(await call('POST', `/v1/purchase/orders/${PO}`, cast.buyer, { supplierId: SUPPLIER, lines: [{ productId: PRODUCT, orderedQty: ORDERED, unitCost }] }, `po-${PO}`), [201], 'order');
      must(codeOf(await call('POST', `/v1/purchase/orders/${PO}/approval`, cast.buyer, { reason: 'mine' }, 'po-approve-self')) !== undefined, 'the requisitioner issued their own order');
      const issued = expectStatus(await call('POST', `/v1/purchase/orders/${PO}/approval`, cast.owner, { reason: 'within budget' }, 'po-approve'), [200], 'order issue');
      must((issued['order'] as { status?: string })?.status === 'issued', 'the order is not issued');
      const commitments = expectStatus(await call('GET', '/v1/purchase/commitments', cast.owner), [200], 'commitments');
      must(commitments['valueMinor'] === ORDERED * COST, `commitment is ${String(commitments['valueMinor'])}, expected ${ORDERED * COST}`);
      return `${ORDERED} × ₹${COST / 100} committed`;
    });
    await step('delivery received at the back store: 10 good on hand, 2 damaged quarantined, the order folded', async () => {
      const delivery = {
        warehouseId: BACK, receivedOnDate: today, currency: 'INR', poId: PO,
        lines: [
          { lineId: 'L1', productId: PRODUCT, orderedMinor: ORDERED, countedMinor: GOOD, uom: 'ea', unitCost, condition: 'good' },
          { lineId: 'L2', productId: PRODUCT, orderedMinor: ORDERED, countedMinor: DAMAGED, uom: 'ea', unitCost, condition: 'damaged' },
        ],
      };
      const grn = expectStatus(await call('POST', `/v1/inventory/goods-receipt/${GRN}`, cast.receiver, delivery, GRN), [201], 'goods receipt');
      const record = grn['grn'] as { availableMinor: number; heldMinor: number; poReceipt?: { receivedByProduct: Record<string, number> } | null };
      must(record.availableMinor === GOOD && record.heldMinor === 0, `available ${record.availableMinor}, held ${record.heldMinor}`);
      must(record.poReceipt?.receivedByProduct?.[PRODUCT] === ORDERED, 'the receipt did not fold the whole delivery into the order');
      must((await onHandAt(BACK)) === GOOD, `back store holds ${await onHandAt(BACK)}, expected ${GOOD}`);
      must((await onHandAt(STORE)) === 0, 'the floor holds stock before any issue');
      must((await valuationAt(BACK)) === GOOD * COST, 'back-store valuation is not 10 × cost');
      const commitments = expectStatus(await call('GET', '/v1/purchase/commitments', cast.owner), [200], 'commitments');
      must(commitments['valueMinor'] === 0, `commitment still ${String(commitments['valueMinor'])} after a full delivery`);
      const again = expectStatus(await call('POST', `/v1/inventory/goods-receipt/${GRN}`, cast.receiver, delivery, GRN), [201], 'receipt replay');
      must((again['grn'] as { grnId: string }).grnId === GRN && (await onHandAt(BACK)) === GOOD, 'the same delivery keyed again created stock twice');
      return `back store ${GOOD}, quarantined ${DAMAGED}, order fully received, replay added nothing`;
    });
    await step('QC: a second person sends the damaged tins back; the receiver cannot decide it', async () => {
      must(codeOf(await call('POST', `/v1/inventory/goods-receipt/${GRN}/lines/L2/disposition`, cast.receiver, { disposition: 'return', reason: 'dented' }, 'disp-self')) === 'self_approval', 'the receiver disposed of their own receipt');
      const disposed = expectStatus(await call('POST', `/v1/inventory/goods-receipt/${GRN}/lines/L2/disposition`, cast.checker, { disposition: 'return', reason: 'dented tins, supplier to collect' }, 'disp-L2'), [200], 'disposition');
      must(disposed['quantityMinor'] === DAMAGED && disposed['valueMinor'] === DAMAGED * COST, 'the disposition is not 2 tins at delivered cost');
      must((await onHandAt(BACK)) === GOOD, 'disposing of quarantined tins moved on-hand stock');
      return `${DAMAGED} returned to the supplier at ₹${COST / 100} each, on-hand unchanged`;
    });
    await step('floor indent: requested → approved against real stock → issued (in transit, not received) → received independently', async () => {
      expectStatus(await call('POST', `/v1/floor/indents/${INDENT}`, cast.cashier, { fromLocationId: BACK, toLocationId: STORE, lines: [{ productId: PRODUCT, quantityMinor: GOOD, uom: 'EA' }], reason: 'shelf empty' }, INDENT), [201], 'indent');
      must(codeOf(await call('POST', `/v1/floor/indents/${INDENT}/approval`, cast.cashier, {}, 'ind-ap-self')) === 'forbidden', 'floor staff approved an indent');
      expectStatus(await call('POST', `/v1/floor/indents/${INDENT}/approval`, cast.manager, {}, 'ind-ap'), [200], 'indent approval');
      must(codeOf(await call('POST', `/v1/floor/indents/${INDENT}/issues/is-over`, cast.backstore, { lines: [{ productId: PRODUCT, quantityMinor: GOOD + 1 }] }, 'ind-is-over')) === 'over_issue', 'an over-issue was accepted');
      expectStatus(await call('POST', `/v1/floor/indents/${INDENT}/issues/is-1`, cast.backstore, { lines: [{ productId: PRODUCT, quantityMinor: GOOD }] }, 'ind-is-1'), [201], 'issue');
      let stock = await availability();
      must((stock.rows.find((r) => r.locationId === BACK)?.onHandMinor ?? 0) === 0, 'the back store still holds the issued stock');
      must((stock.rows.find((r) => r.locationId === STORE)?.onHandMinor ?? 0) === 0, 'a dispatch counted as a floor receipt');
      must(stock.inTransit.some((t) => t.transferId === `${INDENT}:is-1` && t.quantityMinor === GOOD), 'the issue is not visible in transit');
      must(codeOf(await call('POST', `/v1/floor/indents/${INDENT}/issues/is-1/receipt`, cast.backstore, { counted: [{ productId: PRODUCT, quantityMinor: GOOD }] }, 'ind-rc-self')) === 'issuer_cannot_receive', 'the issuer received their own issue');
      const received = expectStatus(await call('POST', `/v1/floor/indents/${INDENT}/issues/is-1/receipt`, cast.shelf, { counted: [{ productId: PRODUCT, quantityMinor: GOOD }] }, 'ind-rc-1'), [201], 'floor receipt');
      must(Array.isArray(received['discrepancies']) && (received['discrepancies'] as unknown[]).length === 0, 'the floor receipt reports discrepancies');
      stock = await availability();
      must(stock.inTransit.length === 0 && (await onHandAt(STORE)) === GOOD && (await onHandAt(BACK)) === 0, 'after the floor receipt the stock is not 10 on the floor, 0 in the back store, nothing in transit');
      await call('POST', `/v1/floor/indents/${INDENT}/issues/is-1/receipt`, cast.shelf, { counted: [{ productId: PRODUCT, quantityMinor: GOOD }] }, 'ind-rc-1');
      must((await onHandAt(STORE)) === GOOD, 'the same floor receipt keyed again doubled the shelf');
      return `floor ${GOOD}, back store 0, nothing in transit; issue and receipt never created stock twice`;
    });
    let edge: EdgeProcess | undefined;
    let till: ReturnType<typeof bootPos> | undefined;
    await step('the store box pulls head office\'s pack and the till is built from it', async () => {
      edge = await startBox();
      const pulled = await edge.refreshPack!();
      must(pulled.status === 'updated', `the pull said ${pulled.status}: ${pulled.staffMessage}`);
      const served = await servedTillCatalogue(edge);
      must(served !== undefined && served.source === 'head_office' && served.products.some((p) => p.productId === PRODUCT), 'the served till is not built from head office\'s pack');
      till = bootPos({ laneId: LANE, catalogue: served!, lanePort: edge.lane!.port, tradingDayCutoff: '00:00' });
      return `pack version ${pulled.heldVersion ?? '?'} pulled; the till prices from head office`;
    });
    await step('the cashier takes the float and SELLS one by barcode; the sale is on the box\'s disk, then banks, and the shelf falls by ONE', async () => {
      till!.signIn(cast.cashier);
      const T0 = Date.now();
      const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();
      tradingDay = tradingDateOf(at(0), makeTradingDayRule('00:00'), zone);
      const float = await till!.till.moveCash({ kind: 'float_issue', amountMinor: 200_000, at: at(0), movementId: `${run}-cm-float` });
      must(float.committed === true, 'the float was not committed on the box');
      const scanned = till!.scanBarcode(BARCODE);
      must(scanned !== undefined && (scanned as { amountMinor?: number }).amountMinor === PRICE, `the scan priced ${JSON.stringify(scanned)}`);
      must((await till!.tenderCash(`${run}-S-1`, `${run}-R-S-1`, at(5))) === `${run}-R-S-1`, 'the cash tender did not complete');
      till!.newSale();
      must(edge!.outbox.unsentCount() >= 1, 'nothing is queued for head office after the sale');
      salePayload = edge!.outbox.pending().find((i) => i.event.type === 'SaleCommitted')?.event.payload as Record<string, unknown> | undefined;
      must(salePayload !== undefined && salePayload['saleId'] === `${run}-S-1`, 'the queued sale is not the one rung');
      must((await onHandAt(STORE)) === GOOD, 'stock moved before the sale reached head office');
      const pass = await edge!.syncOnce!();
      must(pass.dead === 0 && pass.remaining === 0, `sync: ${JSON.stringify(pass)}`);
      const banked = expectStatus(await call('GET', `/v1/sales/${run}-S-1`, cast.owner), [200], 'the banked sale');
      must(banked['banked'] === true, 'the sale is not banked');
      must((await onHandAt(STORE)) === GOOD - 1, `the shelf holds ${await onHandAt(STORE)} after one sale, expected ${GOOD - 1}`);
      must((await valuationAt(STORE)) === (GOOD - 1) * COST, 'the valuation did not follow the sale');
      return `₹${PRICE / 100} banked; floor ${GOOD - 1}; valuation ${(GOOD - 1)} × cost`;
    });
    await step('an eligible RESALE return (manager-approved) refunds the cash and puts the unit back on the shelf', async () => {
      const bill = await till!.lookupRefund(`${run}-R-S-1`);
      must(bill !== null && bill.maxRefundMinor === PRICE, 'the bill was not found on the box or allows the wrong refund');
      const refunded = await bill!.submit({
        returnId: `${run}-RT-1`, number: `${run}-RT-0001`, reasonCode: 'changed_mind',
        lines: [{ productId: PRODUCT, uom: 'ea', quantityMinor: 1, disposition: 'resell' }],
        refundMinor: PRICE, refundTender: 'cash', approval: { by: cast.manager, reason: 'checked the goods' },
      });
      must(refunded.kind === 'settled', `the refund was ${refunded.kind}: ${refunded.laneMessage}`);
      const pass = await edge!.syncOnce!();
      must(pass.dead === 0 && pass.remaining === 0, `sync: ${JSON.stringify(pass)}`);
      must((await onHandAt(STORE)) === GOOD, `the shelf holds ${await onHandAt(STORE)} after the resale return, expected ${GOOD}`);
      must((await valuationAt(STORE)) === GOOD * COST, 'the valuation did not follow the return');
      return `₹${PRICE / 100} refunded in cash; floor back to ${GOOD}`;
    });
    await step('pickup and blind till close: the cash office sees the chain and no over/short', async () => {
      const T0 = Date.now();
      must((await till!.till.moveCash({ kind: 'pickup', amountMinor: 100_000, at: new Date(T0 + 30 * 60_000).toISOString(), movementId: `${run}-cm-pick` })).committed === true, 'the pickup was not committed');
      const closed = await till!.till.close({ shiftId: `${run}-sh-1`, closedAt: new Date(T0 + 60 * 60_000).toISOString(), countedMinor: 100_000 });
      must(closed.closed === true && closed.varianceMinor === 0, `close: ${JSON.stringify(closed)}`);
      const pass = await edge!.syncOnce!();
      must(pass.dead === 0 && pass.remaining === 0, `sync: ${JSON.stringify(pass)}`);
      const cash = expectStatus(await call('GET', `/v1/tills/${LANE}/cash`, cast.owner), [200], 'till cash');
      must(cash['balanceMinor'] === 100_000 && Array.isArray(cash['flagged']) && (cash['flagged'] as unknown[]).length === 0, `cash office sees ${JSON.stringify(cash).slice(0, 200)}`);
      const overShort = expectStatus(await call('GET', '/v1/shifts/over-short', cast.owner), [200], 'over/short');
      must(Array.isArray(overShort['overShort']) && !(overShort['overShort'] as { shiftId?: string }[]).some((s) => s.shiftId === `${run}-sh-1`), 'the shift shows an over/short');
      return 'float 2000 + 480 − 480 − pickup 1000 = 1000 counted; no over/short';
    });
    await step('the supplier invoice is captured and matched by a second person; the debit note; the account owes the net', async () => {
      const paper = { supplierId: SUPPLIER, poId: PO, declaredTotalMinor: ORDERED * COST, lines: [{ productId: PRODUCT, quantity: ORDERED, unitPriceMinor: COST, lineTotalMinor: ORDERED * COST }] };
      expectStatus(await call('POST', `/v1/purchase/invoices/${run}-inv-1/capture`, cast.buyer, { ...paper, approvedBy: cast.checker }, 'cap-inv-1'), [201], 'invoice capture');
      const matched = expectStatus(await call('POST', `/v1/purchase/invoices/${run}-inv-1/match`, cast.checker, {}, 'mat-inv-1'), [200], 'invoice match');
      must(matched['blocked'] === false && matched['payableMinor'] === ORDERED * COST, `match: ${JSON.stringify(matched).slice(0, 200)}`);
      expectStatus(await call('POST', `/v1/purchase/suppliers/${SUPPLIER}/debit-notes/DN-${GRN}-L2/issue`, cast.checker, {}, 'dn-1'), [201], 'debit note');
      const account = expectStatus(await call('GET', `/v1/purchase/suppliers/${SUPPLIER}/account`, cast.owner), [200], 'supplier account') as { totals?: Record<string, number> };
      must(account.totals?.['owedMinor'] === GOOD * COST && account.totals?.['debitNotesMinor'] === DAMAGED * COST, `account totals ${JSON.stringify(account.totals)}`);
      return `invoiced ${ORDERED} × cost, debit note ${DAMAGED} × cost, owed ${GOOD} × cost`;
    });
    await step('the books: payables and the day book post balanced; the ledger agrees with the register; the dashboard shows the day', async () => {
      expectStatus(await call('PUT', '/v1/finance/posting-map', cast.acct, DEFAULT_RETAIL_POSTING_MAP, 'map-1'), [200, 201], 'posting map');
      const payables = expectStatus(await call('POST', '/v1/finance/payables/post', cast.acct, {}, 'pay-1'), [201], 'payables post') as { journals?: { kind: string; lines: { debitMinor: number; creditMinor: number }[] }[]; exceptions?: unknown[] };
      must((payables.exceptions ?? []).length === 0, `payables exceptions: ${JSON.stringify(payables.exceptions)}`);
      for (const j of payables.journals ?? []) must(j.lines.reduce((s, l) => s + l.debitMinor, 0) === j.lines.reduce((s, l) => s + l.creditMinor, 0), `journal ${j.kind} does not balance`);
      const ledger = expectStatus(await call('GET', '/v1/finance/payables', cast.acct), [200], 'payables ledger') as { reconciliation?: { agrees: boolean } };
      must(ledger.reconciliation?.agrees === true, `the payables ledger and the register disagree: ${JSON.stringify(ledger.reconciliation)}`);
      const day = expectStatus(await call('POST', `/v1/finance/day-book/${tradingDay}/post`, cast.acct, undefined, `post-${tradingDay}`), [200, 201], 'day book post') as { journals?: { kind: string; lines: { debitMinor: number; creditMinor: number }[] }[]; exceptions?: unknown[] };
      must((day.exceptions ?? []).length === 0, `day-book exceptions: ${JSON.stringify(day.exceptions)}`);
      const kinds = (day.journals ?? []).map((j) => j.kind);
      must(kinds.includes('sale') && kinds.includes('tender:cash') && kinds.some((k) => /return|refund/.test(k)), `day-book journals: ${kinds.join(', ')}`);
      for (const j of day.journals ?? []) must(j.lines.reduce((s, l) => s + l.debitMinor, 0) === j.lines.reduce((s, l) => s + l.creditMinor, 0), `journal ${j.kind} does not balance`);
      const read = expectStatus(await call('GET', `/v1/finance/day-book/${tradingDay}`, cast.acct), [200], 'day book') as { accounts?: { accountCode: string; balanceMinor: number }[]; open?: number };
      must(read.open === 0 && (read.accounts?.find((a) => a.accountCode === 'sales_clearing')?.balanceMinor ?? 0) === 0, 'the day book is not closed out');
      const dash = expectStatus(await call('GET', '/v1/reports/dashboard', cast.owner), [200], 'dashboard') as { figures?: { name: string; valueMinor?: number }[] };
      must(dash.figures?.find((f) => f.name === 'Sales today')?.valueMinor === PRICE, `dashboard "Sales today" is ${String(dash.figures?.find((f) => f.name === 'Sales today')?.valueMinor)}`);
      return `payables + day book balanced; ledger agrees; "Sales today" ₹${PRICE / 100}`;
    });
    await step('the same sale re-sent to head office banks once and moves no stock', async () => {
      const before = await onHandAt(STORE);
      const resent = expectStatus(await call('POST', '/v1/sales', cast.box, salePayload, 'resend-S-1'), [200, 201, 202], 'resend');
      must(resent['alreadyBanked'] === true, 'the re-sent sale was treated as new');
      must((await onHandAt(STORE)) === before, 'the re-sent sale moved stock');
      return 'alreadyBanked, stock unchanged';
    });
  } finally {
    for (const e of edges.splice(0)) await e.stop().catch(() => undefined);
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }).catch(() => undefined);
  }

  return {
    tenantId: input.tenantId, run, apiBaseUrl: input.apiBaseUrl, startedAt, finishedAt: new Date().toISOString(),
    checkoutCommit: checkoutCommit(), steps, ok: steps.length > 0 && steps.every((s) => s.ok),
  };
}

// ── The command ──────────────────────────────────────────────────────────────

const out = (s = ''): void => { process.stdout.write(`${s}\n`); };

function usage(): never {
  out('Usage: pnpm run demo:smoke -- [--env-file infra/compose/.env.pilot] [--api http://127.0.0.1:8081] [--tenant <uuid>] [--run <label>] [--report <file.json>] [--apps-dir apps]');
  out('  Without --tenant a fresh synthetic tenant is created through the operator bootstrap (refused on a production box).');
  process.exit(2);
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (flags['help'] !== undefined) usage();
  const envFile = typeof flags['env-file'] === 'string' ? resolve(flags['env-file']) : join(process.cwd(), 'infra', 'compose', '.env.pilot');
  if (!existsSync(envFile)) { out(`No settings file at ${envFile} (pass --env-file).`); process.exit(2); }
  const env = parseEnvText(readFileSync(envFile, 'utf8'));
  const { policy, missing } = tokenPolicyFromEnv(env);
  const packSigningKey = env['PACK_SIGNING_KEY'] ?? '';
  if (policy === undefined || packSigningKey === '' || packSigningKey.includes('REPLACE_WITH')) {
    out(`Cannot run — missing or unfilled in ${envFile}: ${[...missing, ...(packSigningKey === '' || packSigningKey.includes('REPLACE_WITH') ? ['PACK_SIGNING_KEY'] : [])].join(', ')}.`);
    process.exit(2);
  }
  const apiBaseUrl = (typeof flags['api'] === 'string' ? flags['api'] : 'http://127.0.0.1:8081').replace(/\/$/, '');
  const run = typeof flags['run'] === 'string' ? flags['run'].replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || 'r' : `${new Date().toISOString().slice(5, 16).replace(/[-T:]/g, '')}`;
  const cast = castFor(run);

  let tenantId = typeof flags['tenant'] === 'string' ? flags['tenant'] : undefined;
  if (tenantId === undefined) {
    // A fresh synthetic tenant, laid down exactly as the operator tool does — the same refusals (production box, demo tenant).
    tenantId = randomUUID();
    const plan = planTenantBootstrap({
      tenantId, owner: cast.owner, admins: rolesFor(cast), targetKind: env['MIGRATION_TARGET_KIND'], demoTenantIds: demoTenantIds(env, undefined),
      knownRoleIds: ROLE_CATALOGUE.map((r) => r.id), operator: 'demo-smoke', ownerRoleId: OWNER_ROLE_ID,
    });
    if (!plan.ok) { out(`REFUSED (${plan.refusedBecause}) — ${plan.detail}`); process.exit(1); }
    const databaseUrl = env['DATABASE_URL'];
    if (databaseUrl === undefined || databaseUrl === '') { out(`DATABASE_URL is not in ${envFile} — cannot create the smoke tenant. Pass --tenant <uuid> of a tenant that already holds the smoke people.`); process.exit(2); }
    // Written for the containers, the URL names the database `db`; from this machine it is on loopback.
    const here = databaseUrlFromTheHost(databaseUrl, env);
    if (here.translated) out(`DATABASE_URL names the compose service "db"; from this machine the database is at 127.0.0.1:${env['POSTGRES_PORT'] ?? '5432'} — using that.`);
    const db = new Pool({ connectionString: here.url, max: 2 });
    try {
      const outcome = await seedInitialAdmins(new SqlEventStore(pgPoolClient(db)), plan.tenantId, plan.admins, plan.operator, new Date().toISOString());
      if (outcome.outcome === 'already_bootstrapped') { out(`Tenant ${tenantId} already holds grants — not touched.`); process.exit(1); }
    } finally { await db.end().catch(() => undefined); }
    out(`Smoke tenant ${tenantId} created with ${plan.admins.length} synthetic people (run "${run}").`);
  } else {
    out(`Using tenant ${tenantId} (run "${run}") — it must already hold the smoke people: ${rolesFor(cast).map((r) => `${r.userId}:${r.roleId}`).join(', ')} and the owner ${cast.owner}.`);
  }

  const report = await runSmoke({ apiBaseUrl, policy, packSigningKey, tenantId, run, ...(typeof flags['apps-dir'] === 'string' ? { appsDir: flags['apps-dir'] } : {}), say: out });
  out();
  out(`Deployed-workflow smoke — ${report.ok ? 'ALL STEPS PASSED' : 'FAILED'} (${report.steps.filter((s) => s.ok).length}/${report.steps.length})`);
  out(`API ${report.apiBaseUrl} · tenant ${report.tenantId} · run ${report.run} · checkout ${report.checkoutCommit ?? 'unknown'} · ${report.finishedAt}`);
  if (typeof flags['report'] === 'string') { writeFileSync(resolve(flags['report']), `${JSON.stringify(report, null, 2)}\n`); out(`Report written to ${resolve(flags['report'])}`); }
  process.exit(report.ok ? 0 : 1);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
