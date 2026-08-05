import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { pgClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { buildRouter, handle, MemoryIdempotencyStore, type HttpRequest } from '../../services/kernel/src/index';
import { AccessControl } from '../../packages/rbac/src/rbac';
import { buildSurface } from '../../services/api/src/main';
import {
  catalogueAdapter, posAdapter, financeAdapter, customerAdapter, ordersAdapter,
  fulfilmentAdapter, purchaseAdapter, identityAdapter, platformAdapter, reportingAdapter,
  migrationAdapter, aiAdapter, addMonths, STREAM,
} from '../../services/api/src/adapters';
import { ROLE_CATALOGUE, OWNER_ROLE_ID } from '../../services/api/src/roles';
import { hmacSigner, publishPack } from '../../services/catalogue/src/index';
import { project } from '../../services/inventory/src/index';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';

/**
 * **It remembers.**
 *
 * Until this test the API booted, answered, and forgot everything — every service was wired to a
 * stub. This drives the real surface, against real PostgreSQL, through the path the shop actually
 * uses: publish a price list, sell against it, resend the sale the way a till does, and read back
 * what was banked.
 *
 * The property it exists to prove is the one everything else rests on: **the answer comes from
 * the history, not from a field somebody kept up to date.** There is no products table, no sales
 * table, no "current pack" column — the current anything is a fold over an append-only stream, so
 * nothing can disagree with the history about what happened.
 *
 * Set DATABASE_URL to run; without it the suite skips rather than passing quietly.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const RUN = `r${Date.now().toString(36)}`;

/**
 * A tenant of this run's own.
 *
 * The first version reused one fixed tenant, and the catalogue append **deduped against the
 * previous run's pack** — `catalogue-<tenant>-v1` is the same key every time — so the read
 * returned an older pack with an older signature. That was the store being exactly right and the
 * test being wrong, and it is the same run-scoping every other integration suite here uses,
 * because an append-only database keeps what earlier runs put in it.
 */
const TENANT = `9${Date.now().toString(16).slice(-7)}-9999-4999-8999-${'9'.repeat(12)}`;
const KEY = ['it', 'remembers', 'signing', 'key'].join('-').padEnd(48, '0');
const NOW = '2026-08-07T12:00:00Z';

/**
 * A minute ago, by the real clock.
 *
 * The first version dated the sale 2026-08-07 and the POS service raised
 * `committed_in_the_future` against the machine's actual clock — the check doing exactly its job,
 * on a fixture that was wrong. A sale cannot be committed later than the server has reached.
 */
const COMMITTED = new Date(Date.now() - 60_000).toISOString();

const ACCESS = new AccessControl(
  [{
    id: 'all', name: 'All', permissions: [
      'catalogue.pack.read', 'catalogue.pack.publish',
      'pos.sale.sync', 'pos.sale.read', 'pos.exception.read',
      'inventory.movement.append', 'inventory.availability.read',
      'purchase.invoice.match', 'purchase.commitment.read',
      'finance.journal.post', 'finance.period.close', 'finance.period.read',
      'customer.consent.read', 'customer.consent.write', 'loyalty.points.read',
      'order.promise', 'order.reservation.read',
      'delivery.attempt.record', 'delivery.run.read',
      'platform.health.read', 'platform.flag.write',
      'reporting.dashboard.read',
      'migration.verification.read', 'migration.exception.accept',
      'ai.agent.run', 'ai.proposal.read',
    ],
  }],
  [{ userId: 'u-manager', roleId: 'all', branchScope: 'all' }],
);

describe.skipIf(!DATABASE_URL)('the API remembers (real PostgreSQL)', () => {
  let client: Client;
  let store: SqlEventStore;
  let kernel: Parameters<typeof handle>[0];

  const req = (over: Partial<HttpRequest>): HttpRequest => ({
    method: 'GET', path: '/', headers: { authorization: 'Bearer good' }, ...over,
  });
  const post = (path: string, body: unknown, key: string): HttpRequest =>
    req({ method: 'POST', path, body, headers: { authorization: 'Bearer good', 'idempotency-key': key } });

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    const sql = pgClient(client);
    const dir = 'db/migrations';
    await runMigrations(sql, readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
    store = new SqlEventStore(sql);

    const built = buildRouter(buildSurface({
      signingKey: KEY, migrationTargetKind: 'rehearsal', store,
    }));
    expect(built.ok, built.refusals.map((r) => r.detail).join('; ')).toBe(true);

    kernel = {
      router: built.router!,
      authenticate: () => ({ tenantId: TENANT, userId: 'u-manager', branchId: 'b-main' }),
      access: ACCESS, idempotency: new MemoryIdempotencyStore(),
      newTraceId: () => `trace-${RUN}`,
    };
  });

  afterAll(async () => { await client.end(); });

  // ─── 1. A price list, published and read back ───────────────────────────────

  const snapshot: CatalogueSnapshot = {
    tenantId: TENANT, version: 1, builtAt: NOW,
    products: [
      { productId: `${RUN}-P1`, sku: 'GHEE-1L', name: 'Amul Ghee Gold 1L', baseUom: 'each', unitPriceMinor: 64_000, taxBps: 500, mrpMinor: 70_000, status: 'active' },
      { productId: `${RUN}-P2`, sku: 'OIL-5L', name: 'Sunflower Oil 5L', baseUom: 'each', unitPriceMinor: 30_000, taxBps: 500, mrpMinor: 35_000, status: 'active' },
    ],
    barcodes: [{ code: '8901234567890', productId: `${RUN}-P1`, kind: 'standard' }],
  };

  it('publishes a price list and reads back the SAME one', async () => {
    const signer = hmacSigner(KEY);
    const pack = publishPack({
      snapshot, approvals: [], signer, publishedBy: 'u-manager', publishedAt: NOW,
    }).pack!;

    const adapter = catalogueAdapter({ store, signer, now: () => NOW });
    await adapter.storePack(TENANT, pack);

    const back = await adapter.currentPack(TENANT);
    expect(back?.snapshot.version).toBe(1);
    expect(back?.snapshot.products).toHaveLength(2);
    // Round-tripped through PostgreSQL and still verifies against its signature.
    expect(back?.signature).toBe(pack.signature);
  });

  it('serves that pack over the API, to a caller with the permission', async () => {
    const res = await handle(kernel, req({ path: '/v1/catalogue/pack' }));
    expect(res.status).toBe(200);
    expect((res.body as { snapshot: { products: unknown[] } }).snapshot.products).toHaveLength(2);
  });

  // ─── 2. A sale, banked and remembered ───────────────────────────────────────

  const sale = {
    saleId: `${RUN}-S1`, receiptNumber: `${RUN}-R1`, laneId: 'lane-1', cashierId: 'u-meena',
    tradingDay: COMMITTED.slice(0, 10), committedAt: COMMITTED, totalMinor: 64_000, currency: 'INR',
    packVersion: 1,
    lines: [{ productId: `${RUN}-P1`, quantityMinor: 1, uom: 'each', unitPriceMinor: 64_000, lineTotalMinor: 64_000 }],
    tenders: [{ kind: 'cash', amountMinor: 64_000 }],
  };

  it('banks a sale and finds it afterwards', async () => {
    const res = await handle(kernel, post('/v1/sales', sale, `k-${RUN}-1`));
    expect(res.status).toBe(202);
    expect((res.body as { banked: boolean; exceptions: unknown[] }).banked).toBe(true);
    expect((res.body as { exceptions: unknown[] }).exceptions).toEqual([]);

    const found = await handle(kernel, req({ path: `/v1/sales/${sale.saleId}` }));
    expect(found.status).toBe(200);
  });

  it('collapses a RESEND to one sale, the way a till actually behaves', async () => {
    // The till resends what it could not confirm. Three arrivals, one sale — and the collapse
    // happens on the sale's own id, so it holds even if the transport used a different key.
    await handle(kernel, post('/v1/sales', sale, `k-${RUN}-1`));
    await handle(kernel, post('/v1/sales', sale, `k-${RUN}-DIFFERENT`));

    const banked = await posAdapter({ store, now: () => NOW }).bankedSaleIds(TENANT);
    expect([...banked].filter((id) => id === sale.saleId)).toHaveLength(1);

    const stream = await store.readStream(TENANT, STREAM.sales);
    expect(stream.filter((e) => (e.event.payload as { saleId: string }).saleId === sale.saleId)).toHaveLength(1);
  });

  it('prices the sale against the pack the SHOP published, not a stub', async () => {
    // The catalogue the POS service checks against comes from the stream, so a price that
    // disagrees is a real finding rather than an artefact of an empty stub map.
    const wrongPrice = {
      ...sale, saleId: `${RUN}-S2`, receiptNumber: `${RUN}-R2`,
      totalMinor: 50_000,
      lines: [{ productId: `${RUN}-P1`, quantityMinor: 1, uom: 'each', unitPriceMinor: 50_000, lineTotalMinor: 50_000 }],
      tenders: [{ kind: 'cash', amountMinor: 50_000 }],
    };
    const res = await handle(kernel, post('/v1/sales', wrongPrice, `k-${RUN}-2`));
    expect(res.status).toBe(202); // banked regardless — the money is in the drawer

    const kinds = (res.body as { exceptions: { kind: string }[] }).exceptions.map((e) => e.kind);
    expect(kinds).toContain('price_differs_from_catalogue');
  });

  it('remembers the exception too, and serves it', async () => {
    const res = await handle(kernel, req({ path: '/v1/sales/exceptions' }));
    expect(res.status).toBe(200);
    const body = res.body as { material: unknown[]; informational: number };
    expect(body.material.length + body.informational).toBeGreaterThan(0);
  });

  // ─── 3. Stock, projected rather than stored ─────────────────────────────────

  it('projects a stock balance from movements, in any arrival order', async () => {
    const move = (id: string, kind: string, qty: number) => ({
      movementId: `${RUN}-${id}`, productId: `${RUN}-P1`, locationId: 'L1', kind,
      quantityMinor: qty, uom: 'each', occurredAt: COMMITTED, enteredBy: 'u-warehouse',
    });

    // Deliberately out of order — a handheld back from the chiller sends them like this.
    for (const [i, m] of [move('M3', 'sold', 20), move('M1', 'received', 100), move('M2', 'sold', 30)].entries()) {
      const res = await handle(kernel, post('/v1/inventory/movements', m, `k-${RUN}-mv${i}`));
      expect(res.status).toBe(202);
    }

    // The query goes in its own field. Putting it in the path made the router fail to match, and
    // the 404 body has no `rows` — which is how the first version of this failed.
    const res = await handle(kernel, req({
      path: '/v1/inventory/availability', query: { productId: `${RUN}-P1` },
    }));
    expect(res.status).toBe(200);
    const rows = (res.body as { rows: { onHandMinor: number }[] }).rows;
    expect(rows[0]?.onHandMinor).toBe(50);
  });

  it('gives the same balance whichever way the stream is read', async () => {
    const ms = await store.readStream(TENANT, STREAM.inventory);
    const payloads = ms.map((e) => e.event.payload as never);
    const forward = project(payloads, NOW);
    const backward = project([...payloads].reverse(), NOW);
    expect(backward).toEqual(forward);
  });

  // ─── 5. The five services that were still stubs ─────────────────────────────

  it('remembers consent, and both directions of it', async () => {
    // Given, withdrawn, given again is three facts about one customer, and the middle one is the
    // one a regulator asks about. A key without the timestamp would keep the first and call the
    // rest replays.
    const adapter = customerAdapter({ store, now: () => NOW });
    const record = (given: boolean, at: string) => ({
      customerId: `${RUN}-C1`, purpose: 'marketing' as const, channel: 'sms' as const,
      given, recordedAt: at, evidence: given ? 'signed at the counter' : 'said no on the phone',
    });
    await adapter.appendConsent(TENANT, record(true, '2026-01-01T00:00:00Z'));
    await adapter.appendConsent(TENANT, record(false, '2026-03-01T00:00:00Z'));
    await adapter.appendConsent(TENANT, record(true, '2026-06-01T00:00:00Z'));

    const back = await adapter.consentRecords(TENANT, `${RUN}-C1`);
    expect(back).toHaveLength(3);
    expect(back.map((r) => r.given)).toEqual([true, false, true]);
    // And nobody else's consent came back with it.
    expect(await adapter.consentRecords(TENANT, `${RUN}-C-other`)).toEqual([]);
  });

  it('answers loyalty points as NOT KNOWN rather than as zero', async () => {
    const res = await handle(kernel, req({ path: `/v1/customers/${RUN}-C1/points` }));
    expect(res.status).toBe(200);
    const body = res.body as { known: boolean; pointsBalance?: number };
    expect(body.known).toBe(false);
    // A zero balance and an unknown one are different answers to a customer at the counter.
    expect(body.pointsBalance).toBeUndefined();
  });

  it('answers what is on order as NOT KNOWN rather than as nothing on order', async () => {
    const res = await handle(kernel, req({ path: '/v1/purchase/commitments' }));
    expect(res.status).toBe(200);
    expect((res.body as { known: boolean }).known).toBe(false);
  });

  it('promises against stock the INVENTORY ledger projects, not a second count', async () => {
    // 50 on hand at L1 from the movements above. Two functions that both compute stock are two
    // answers waiting to disagree, and the one that promises to a customer is not the one you
    // want drifting from the one that counts.
    const onHand = await ordersAdapter({ store, now: () => NOW, holdMinutes: 60 }).onHand(TENANT, 'L1');
    expect(onHand.get(`${RUN}-P1`)).toBe(50);
  });

  it('holds a reservation, remembers it, and lets it lapse', async () => {
    const adapter = ordersAdapter({ store, now: () => NOW, holdMinutes: 60 });
    await adapter.holdReservations(TENANT, [
      { reservationId: `${RUN}-RES1`, orderId: `${RUN}-O1`, productId: `${RUN}-P1`, quantityMinor: 2, locationId: 'L1', heldUntil: '2026-08-07T13:00:00Z' },
      { reservationId: `${RUN}-RES2`, orderId: `${RUN}-O2`, productId: `${RUN}-P1`, quantityMinor: 3, locationId: 'L1', heldUntil: '2026-08-07T11:00:00Z' },
    ]);

    // At 12:00 the second has lapsed. An expired hold is stock on the shelf, not stock spoken for.
    const live = await adapter.outstanding(TENANT, 'L1');
    expect(live.map((r) => r.reservationId)).toEqual([`${RUN}-RES1`]);
    // ...and it is gone from the answer without being gone from the record.
    expect((await store.readStream(TENANT, STREAM.reservations)).length).toBe(2);
  });

  it('will not close a month that nothing checked', async () => {
    // No control total can be built from this system alone — everything it holds for a period came
    // down one path. `controlTotals` returns nothing and the close refuses, which is the honest
    // answer. A month that closes because nobody checked it is the outcome worth refusing.
    const entry = {
      entryId: `${RUN}-JE1`, period: '2026-08', documentDate: '2026-08-03',
      narrative: 'August rent paid to the landlord',
      lines: [
        { accountCode: '5100', debitMinor: 150_000, creditMinor: 0 },
        { accountCode: '1100', debitMinor: 0, creditMinor: 150_000 },
      ],
      postedBy: 'u-accounts',
    };
    expect((await handle(kernel, post('/v1/finance/journals', entry, `k-${RUN}-je1`))).status).toBe(201);

    const close = await handle(kernel, post('/v1/finance/periods/2026-08/close', { signedBy: 'u-manager' }, `k-${RUN}-cl`));
    expect(close.status).toBe(422);
    // The kernel wraps every refusal as `{ error: { code, whatHappened, wasItSaved, ... } }` —
    // one envelope, so a caller reads a refusal the same way whichever service raised it.
    const refusal = (close.body as { error: { code: string; whatHappened: string; wasItSaved: string } }).error;
    expect(refusal.code).toBe('nothing_was_checked');
    expect(refusal.wasItSaved).toBe('not_saved');
    expect(refusal.whatHappened).toContain('nothing has checked');
  });

  it('knows who posted into a month, which is what the second signature rests on', async () => {
    const posters = await financeAdapter({ store, now: () => NOW }).postersIn(TENANT, '2026-08');
    expect(posters).toEqual(['u-accounts']);
    expect(await financeAdapter({ store, now: () => NOW }).postersIn(TENANT, '2026-07')).toEqual([]);
  });

  it('shows the month as open because nothing closed it, not because a flag says so', async () => {
    const states = await financeAdapter({ store, now: () => NOW }).periodStates(TENANT);
    expect(states.get('2026-08')).toBe('open');

    // Close it directly, and the same fold now reads closed. Open is the absence of a close, so no
    // period can be open and closed at once.
    await financeAdapter({ store, now: () => NOW }).markClosed(TENANT, '2026-08', 'u-manager');
    expect((await financeAdapter({ store, now: () => NOW }).periodStates(TENANT)).get('2026-08')).toBe('closed');

    // And a late document is now routed forward rather than into signed figures.
    expect(await financeAdapter({ store, now: () => '2026-08-20T00:00:00Z' }).nextOpenPeriod(TENANT)).toBe('2026-09');
  });

  it('steps months without a Date round-trip a timezone could move', () => {
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-08', 12)).toBe('2027-08');
  });

  it('records a delivery attempt and settles the run against the driver', async () => {
    const adapter = fulfilmentAdapter({ store, now: () => NOW });
    await adapter.appendAttempt(TENANT, {
      attemptId: `${RUN}-A1`, orderId: `${RUN}-O1`, driverId: 'd-ravi',
      attemptedAt: '2026-08-07T09:30:00Z', outcome: 'delivered', proofRef: 'sig-1',
      cashCollectedMinor: 64_000,
    });
    await adapter.appendAttempt(TENANT, {
      attemptId: `${RUN}-A2`, orderId: `${RUN}-O2`, driverId: 'd-other',
      attemptedAt: '2026-08-07T09:40:00Z', outcome: 'delivered', proofRef: 'sig-2',
    });

    const mine = await adapter.attempts(TENANT, 'd-ravi', '2026-08-07');
    expect(mine.map((a) => a.attemptId)).toEqual([`${RUN}-A1`]);
    // A different day is a different run.
    expect(await adapter.attempts(TENANT, 'd-ravi', '2026-08-06')).toEqual([]);
  });

  it('does not call a run reconciled when nothing dispatched it', async () => {
    // `assigned` folds a stream nothing writes to yet. With only the assigned-minus-attempted
    // check, this run — a delivery and ₹640 of cash — reported "the run reconciles and every
    // order has an outcome".
    const res = await handle(kernel, req({
      path: '/v1/delivery/runs/d-ravi',
      query: { runDate: '2026-08-07', cashHandedInMinor: '64000' },
    }));
    expect(res.status).toBe(200);
    const body = res.body as { unassigned: string[]; ownerAction: string };
    expect(body.unassigned).toEqual([`${RUN}-O1`]);
    expect(body.ownerAction).not.toContain('the run reconciles');
  });

  it('will not call an invoice it holds no lines for a match', async () => {
    const res = await handle(kernel, post(`/v1/purchase/invoices/${RUN}-INV1/match`, {}, `k-${RUN}-m1`));
    expect(res.status).toBe(200);
    const body = res.body as { blocked: boolean; payableMinor: number; ownerAction: string };
    expect(body.blocked).toBe(true);
    expect(body.payableMinor).toBe(0);
    expect(body.ownerAction).toContain('not because a difference was found');

    // And the outcome is on the record, keyed on what it decided rather than on the invoice alone.
    const matched = (await store.readStream(TENANT, STREAM.purchase))
      .filter((e) => e.event.type === 'InvoiceMatched');
    expect(matched).toHaveLength(1);
  });

  it('records a supplier bank change as an event, never as an overwrite', async () => {
    const adapter = purchaseAdapter({ store, now: () => NOW });
    await adapter.applyBankChange(TENANT, {
      supplierId: `${RUN}-SUP1`, newAccount: 'ACC-NEW-1', requestedVia: 'phone_call_we_made',
      calledBackOn: '+91 44 1234 5678', numberWeAlreadyHeld: '+91 44 1234 5678',
      requestedBy: 'u-accounts', approvedBy: 'u-manager', requestedAt: '2026-08-01T09:00:00Z',
    });
    await adapter.applyBankChange(TENANT, {
      supplierId: `${RUN}-SUP1`, newAccount: 'ACC-NEW-2', requestedVia: 'phone_call_we_made',
      calledBackOn: '+91 44 1234 5678', numberWeAlreadyHeld: '+91 44 1234 5678',
      requestedBy: 'u-accounts', approvedBy: 'u-manager', requestedAt: '2026-08-04T09:00:00Z',
    });

    const changes = (await store.readStream(TENANT, STREAM.purchase))
      .filter((e) => e.event.type === 'SupplierBankChanged');
    // Two changes, both kept. The first account is still readable, which is what an investigation
    // into a payment that went to the wrong place actually needs.
    expect(changes).toHaveLength(2);
    expect(changes.map((e) => (e.event.payload as { newAccount: string }).newAccount))
      .toEqual(['ACC-NEW-1', 'ACC-NEW-2']);
  });
  // ─── 6. The last five ───────────────────────────────────────────────────────

  it('grants a role, and the permissions follow from who holds it', async () => {
    const adapter = identityAdapter({ store, now: () => NOW, roleCatalogue: ROLE_CATALOGUE });
    expect(await adapter.permissionsOf(TENANT, 'u-meena')).toEqual([]);

    await adapter.recordGrant(
      TENANT,
      { userId: 'u-meena', roleId: 'cashier', branchScope: 'all' },
      {
        grantId: `${RUN}-G1`, userId: 'u-meena', roleId: 'cashier', branchScope: 'all',
        requestedBy: 'u-manager', approvedBy: 'u-owner', requestedAt: NOW,
      },
    );

    const perms = await adapter.permissionsOf(TENANT, 'u-meena');
    expect(perms).toContain('pos.sale.sync');
    // The narrowest role in the product: no finance, no grants, no flags.
    expect(perms).not.toContain('finance.journal.post');
    expect(perms).not.toContain('identity.role.grant');
  });

  it('keeps WHO ASKED and WHO APPROVED, not just the resulting access', async () => {
    // An access review a year later is about the second pair, not the first.
    const granted = (await store.readStream(TENANT, STREAM.identity))
      .filter((e) => e.event.type === 'RoleGranted')
      .map((e) => e.event.payload as { request: { requestedBy: string; approvedBy: string } });
    expect(granted[0]?.request.requestedBy).toBe('u-manager');
    expect(granted[0]?.request.approvedBy).toBe('u-owner');
  });

  it('reports health as UNKNOWN when nothing was probed, and healthy when something was', async () => {
    const nothing = platformAdapter({ store, now: () => NOW, probes: async () => [] });
    const health = await handle(
      { ...kernel, router: buildRouter(buildSurface({ signingKey: KEY, migrationTargetKind: 'rehearsal', store })).router! },
      req({ path: '/v1/platform/health' }),
    );
    expect((health.body as { state: string }).state).toBe('unknown');
    expect(await nothing.probe()).toEqual([]);

    const real = platformAdapter({
      store, now: () => NOW,
      probes: async () => [{ name: 'postgres', criticality: 'shop_cannot_trade_without_it', reachable: true }],
    });
    expect((await real.probe())[0]?.reachable).toBe(true);
  });

  it('remembers a feature flag being turned off and back on, as two facts', async () => {
    const adapter = platformAdapter({ store, now: () => NOW, probes: async () => [] });
    await adapter.setFlag(TENANT, { key: `${RUN}.self_checkout`, enabled: true, changedBy: 'u-owner', changedAt: '2026-08-01T10:00:00Z' });
    await adapter.setFlag(TENANT, { key: `${RUN}.self_checkout`, enabled: false, changedBy: 'u-manager', changedAt: '2026-08-02T10:00:00Z' });
    await adapter.setFlag(TENANT, { key: `${RUN}.self_checkout`, enabled: true, changedBy: 'u-manager', changedAt: '2026-08-03T10:00:00Z' });

    // The last change wins for "is it on"...
    expect((await adapter.flags(TENANT))[`${RUN}.self_checkout`]).toBe(true);
    // ...and all three are kept, because "who turned this back on, and when" is the whole point.
    const changes = (await store.readStream(TENANT, STREAM.platform))
      .filter((e) => e.event.type === 'FeatureFlagSet');
    expect(changes).toHaveLength(3);
  });

  it('keeps a support access grant, which is never deleted (#6)', async () => {
    const adapter = platformAdapter({ store, now: () => NOW, probes: async () => [] });
    await adapter.recordSupportAccess({
      accessId: `${RUN}-SUP`, tenantId: TENANT, engineerId: 'e-1', approvedBy: 'u-owner',
      reason: 'investigating a sync backlog reported this morning', grantedAt: NOW, minutes: 60,
    }, '2026-08-07T13:00:00Z');

    const kept = (await store.readStream(TENANT, STREAM.platform))
      .filter((e) => e.event.type === 'SupportAccessGranted');
    expect(kept).toHaveLength(1);
    await expect(client.query('DELETE FROM event_ledger WHERE id = $1', [kept[0]!.event.id]))
      .rejects.toThrow(/append-only/i);
  });

  it('reports today\'s sales from the sales stream, not from a stored total', async () => {
    const figures = await reportingAdapter({ store, now: () => new Date().toISOString() })
      .figures(TENANT, 'dashboard');
    const sales = figures.find((f) => f.name === 'Sales today');
    // Two sales banked earlier in this file, on today's trading day: 64,000 + 50,000.
    expect(sales?.valueMinor).toBe(114_000);
    expect(sales?.staleness).toBe('live');
    expect(figures.find((f) => f.name === 'Sales today — receipts')?.valueMinor).toBe(2);
  });

  it('will not produce the signed migration page while it cannot name the people on it', async () => {
    const adapter = migrationAdapter({
      store, now: () => NOW, targetKind: 'rehearsal', ownerRoleId: OWNER_ROLE_ID,
    });
    // Nobody holds the owner role and no extraction has been recorded.
    expect(await adapter.ownerId(TENANT)).toBeUndefined();
    expect(await adapter.extractionOperator(TENANT)).toBeUndefined();

    const res = await handle(kernel, req({ path: '/v1/migration/verification' }));
    expect(res.status).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe('the_page_would_name_nobody');
  });

  it('finds the owner once somebody actually holds the owner role', async () => {
    const identity = identityAdapter({ store, now: () => NOW, roleCatalogue: ROLE_CATALOGUE });
    await identity.recordGrant(
      TENANT,
      { userId: 'u-chezhian', roleId: OWNER_ROLE_ID, branchScope: 'all' },
      {
        grantId: `${RUN}-G2`, userId: 'u-chezhian', roleId: OWNER_ROLE_ID, branchScope: 'all',
        requestedBy: 'u-manager', approvedBy: 'u-manager', requestedAt: NOW,
      },
    );
    const adapter = migrationAdapter({
      store, now: () => NOW, targetKind: 'rehearsal', ownerRoleId: OWNER_ROLE_ID,
    });
    expect(await adapter.ownerId(TENANT)).toBe('u-chezhian');
  });

  it('has the AI kill switch ON before anybody has said anything', async () => {
    // The one place in this file where the absence of a record does NOT mean "we cannot say". A
    // kill switch that defaults off is an agent running because nobody has told it not to.
    const adapter = aiAdapter({ store, now: () => NOW });
    expect(await adapter.killSwitchOn(TENANT)).toBe(true);
    expect(await adapter.enabledAgents(TENANT)).toEqual([]);
    expect(await adapter.budget(TENANT)).toMatchObject({ capMinor: 0, spentMinor: 0 });

    const res = await handle(kernel, post(`/v1/ai/agents/A01/runs`, { estimatedCostMinor: 100 }, `k-${RUN}-ai`));
    expect(res.status).toBe(503);
    expect((res.body as { error: { code: string } }).error.code).toBe('kill_switch_is_on');
  });

  it('turns the kill switch off only when somebody says so, by name', async () => {
    const adapter = aiAdapter({ store, now: () => NOW });
    await adapter.setKillSwitch(TENANT, false, 'u-chezhian', '2026-08-05T09:00:00Z');
    expect(await adapter.killSwitchOn(TENANT)).toBe(false);
    // Off then on again is two facts, and both are on the record.
    await adapter.setKillSwitch(TENANT, true, 'u-chezhian', '2026-08-05T09:30:00Z');
    expect(await adapter.killSwitchOn(TENANT)).toBe(true);
    expect((await store.readStream(TENANT, STREAM.ai)).filter((e) => e.event.type === 'AiKillSwitchSet'))
      .toHaveLength(2);
  });

  // ─── 4. The property everything rests on ────────────────────────────────────

  it('the database itself refuses to change what was banked (hard rule #2)', async () => {
    const first = (await store.readStream(TENANT, STREAM.sales))[0]!;
    await expect(
      client.query('UPDATE event_ledger SET payload = $1 WHERE id = $2', ['{"x":1}', first.event.id]),
    ).rejects.toThrow(/append-only/i);
    await expect(client.query('DELETE FROM event_ledger WHERE id = $1', [first.event.id]))
      .rejects.toThrow(/append-only/i);
  });

  it('holds no table anyone could overwrite a quantity in', async () => {
    // The reason everything is an event. A table with an UPDATE on it is a quantity somebody can
    // overwrite, and no amount of discipline in the application layer survives one hurried fix.
    const rows = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    const names = rows.rows.map((r) => r.table_name).sort();
    expect(names).toContain('event_ledger');
    for (const forbidden of ['sales', 'products', 'stock', 'stock_balances', 'inventory']) {
      expect(names, `a mutable ${forbidden} table would undo hard rule #2`).not.toContain(forbidden);
    }
  });

  it('keeps one tenant out of another (OB-01)', async () => {
    const other = '11111111-1111-4111-8111-111111111111';
    expect(await store.readStream(other, STREAM.sales)).toEqual([]);
    expect(await catalogueAdapter({
      store, signer: hmacSigner(KEY), now: () => NOW,
    }).currentPack(other)).toBeUndefined();
  });
});
