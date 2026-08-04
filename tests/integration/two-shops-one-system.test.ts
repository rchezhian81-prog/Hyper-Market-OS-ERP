import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { pgClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { makeEvent } from '../../packages/contracts/src/event';

import { Entitlements } from '../../packages/tenant/src/tenant';
import {
  checkEntitlement, meterUsage, assessPlanChange, assertTenantIsolation,
  type Plan, type TenantSubscription,
} from '../../packages/platform/src/plans';
import { resolveBrand, validateBranding, applyTerminology, type TenantBranding } from '../../packages/platform/src/branding';
import { buildTenantExport, closeTenant, assessCompatibility } from '../../packages/platform/src/lifecycle';
import { checkPartnerAccess, certificationStatus, seedSandbox, type ApiVersion, type PartnerCredential } from '../../packages/platform/src/partner';
import { assessSelfCheckout, decideScanAndGo, quotePrice, type ScannedLine } from '../../packages/self-checkout/src/self-checkout';
import { auditPriceIntegrity, pushEslPrice, type DisplayedPrice } from '../../packages/self-checkout/src/price-integrity';

/**
 * STAGE 18 — multi-tenant platform and the innovation wave.
 *
 * Gate (roadmap §21): **two shops, one system — and neither can see the other.**
 *
 * SRE Hyper Market and Kumar Stores run on the same deployment, the same binary and the same
 * database. They see different brands, different features, different bills. Nothing either of
 * them does can reach the other, and nothing the vendor does can stop either of them trading.
 *
 * Then the R8 innovation wave on top: a self-checkout lane that helps rather than accuses, a
 * scan-and-go trip, a price kiosk that admits its own staleness, and electronic shelf labels
 * that must confirm a price before the till is allowed to charge it.
 *
 * Executed against a REAL PostgreSQL, with both tenants' events in one append-only ledger the
 * database itself refuses to delete from.
 *
 * Set DATABASE_URL to run; without it the suite skips rather than passing quietly.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const SRE = '77777777-7777-7777-7777-777777777777';
const KUMAR = '88888888-8888-8888-8888-888888888888';
const RUN = `t${Date.now().toString(36)}`;

const STANDARD: Plan = {
  planId: 'standard', name: 'Standard',
  grants: ['loyalty', 'delivery'],
  limits: { lanes: 4, branches: 1, transactions_per_month: 60_000 },
  monthlyPriceMinor: 1_500_000,
  overageMinor: { lanes: 300_000 },
};

const GROWTH: Plan = {
  planId: 'growth', name: 'Growth',
  grants: ['loyalty', 'delivery', 'customer_app', 'b2b', 'dept.concession'],
  limits: { lanes: 12, branches: 5, transactions_per_month: 250_000 },
  monthlyPriceMinor: 4_000_000,
  overageMinor: { lanes: 250_000 },
};

const SRE_SUB: TenantSubscription = { tenantId: SRE, planId: 'growth', startedOn: '2026-01-01' };
const KUMAR_SUB: TenantSubscription = { tenantId: KUMAR, planId: 'standard', startedOn: '2026-04-01' };

const SRE_BRAND: TenantBranding = {
  tenantId: SRE, productName: 'SRE Hyper', legalName: 'SRE Hyper Market Pvt Ltd',
  logoRef: 'assets/sre-logo.svg', colours: { primary: '#1a4d2e', onPrimary: '#ffffff' },
  terminology: { branch: 'store' }, templateSetId: 'tpl-sre',
};

const KUMAR_BRAND: TenantBranding = {
  tenantId: KUMAR, productName: 'Kumar Stores', legalName: 'Kumar Retail LLP',
  logoRef: 'assets/kumar-logo.svg', colours: { primary: '#5b2333', onPrimary: '#ffffff' },
  terminology: { branch: 'showroom' }, templateSetId: 'tpl-kumar',
};

const VERSIONS: readonly ApiVersion[] = [
  { contract: 'API-06 orders', version: 'v3', status: 'current' },
  { contract: 'API-06 orders', version: 'v2', status: 'deprecated' },
  { contract: 'API-06 orders', version: 'v1', status: 'retired', retiredOn: '2026-01-31' },
];

const DECLARED_DOMAINS = ['sales', 'stock', 'customers', 'suppliers', 'finance', 'audit'];

describe.skipIf(!DATABASE_URL)('Stage 18 — two shops, one system (real PostgreSQL)', () => {
  let client: Client;
  let store: SqlEventStore;

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    const sql = pgClient(client);
    const dir = 'db/migrations';
    await runMigrations(
      sql,
      readdirSync(dir)
        .filter((f) => f.endsWith('.sql'))
        .sort()
        .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })),
    );
    store = new SqlEventStore(sql);
  });

  afterAll(async () => {
    await client.end();
  });

  // ─── 1. TWO TENANTS IN ONE DATABASE ─────────────────────────────────────────

  it('banks both shops\' trading in ONE ledger and each reads back only its own', async () => {
    for (const [tenant, label, valueMinor] of [
      [SRE, 'SRE', 412_000],
      [KUMAR, 'Kumar', 96_500],
    ] as const) {
      await store.append(
        tenant,
        `daysummary/${RUN}`,
        makeEvent({
          id: `${RUN}-${label}-day`,
          type: 'TradingDayClosed',
          occurredAt: '2026-08-04T22:00:00Z',
          idempotencyKey: `${RUN}:${label}:day`,
          source: 'web-erp',
          payload: { tenant: label, valueMinor },
        }),
      );
    }

    const sre = await store.readStream(SRE, `daysummary/${RUN}`);
    const kumar = await store.readStream(KUMAR, `daysummary/${RUN}`);

    expect(sre).toHaveLength(1);
    expect(kumar).toHaveLength(1);
    expect((sre[0]!.event.payload as { tenant: string }).tenant).toBe('SRE');
    expect((kumar[0]!.event.payload as { tenant: string }).tenant).toBe('Kumar');

    // The stream NAME is identical. Only the tenant column separates them, which is
    // exactly the isolation being tested.
    expect(sre[0]!.event.id).not.toBe(kumar[0]!.event.id);
  });

  it('treats a cross-tenant row as a CRITICAL DEFECT, not a row to filter out', async () => {
    const sreRows = (await store.readStream(SRE, `daysummary/${RUN}`)).map((r) => ({
      id: r.event.id, tenantId: SRE,
    }));
    const clean = assertTenantIsolation({ tenantId: SRE, rows: sreRows, what: 'day summaries' });
    expect(clean.allowed).toBe(true);

    // If a query ever did leak, the whole result set is refused rather than trimmed —
    // the silently-trimmed version is the one nobody ever investigates.
    const leaked = assertTenantIsolation({
      tenantId: SRE, rows: [...sreRows, { id: 'x', tenantId: KUMAR }], what: 'day summaries',
    });
    expect(leaked.allowed).toBe(false);
    expect(leaked.criticalDefect).toBe(true);
    expect(leaked.rows).toEqual([]);

    expect(assertTenantIsolation({ rows: sreRows, what: 'day summaries' }).outcome).toBe('no_tenant_context');
  });

  it('gives each shop only the features it bought, and says WHY when it does not', () => {
    // SRE is on Growth and runs a concession counter (Stage 16). Kumar is not.
    expect(checkEntitlement({ subscription: SRE_SUB, plan: GROWTH, feature: 'dept.concession' }).entitled).toBe(true);

    const kumar = checkEntitlement({ subscription: KUMAR_SUB, plan: STANDARD, feature: 'dept.concession' });
    expect(kumar.entitled).toBe(false);
    expect(kumar.source).toBe('not_entitled');
    expect(kumar.detail).toContain('a sales conversation');

    // Suspended for non-payment is a different answer, and support must be able to tell.
    const suspended = checkEntitlement({
      subscription: { ...KUMAR_SUB, extraGrants: ['b2b'], suspendedGrants: ['b2b'] },
      plan: STANDARD, feature: 'b2b',
    });
    expect(suspended.source).toBe('suspended');
    expect(suspended.detail).toContain('a billing conversation');

    // The Stage-5 entitlements engine agrees, per tenant, with no bleed.
    const entitlements = new Entitlements();
    entitlements.enable(SRE, 'dept.concession');
    expect(entitlements.isEnabled(SRE, 'dept.concession')).toBe(true);
    expect(entitlements.isEnabled(KUMAR, 'dept.concession')).toBe(false);
  });

  // ─── 2. NOTHING WE DO STOPS EITHER SHOP TRADING ─────────────────────────────

  it('INVOICES a shop that outgrew its plan and never stops it selling', () => {
    // Kumar opened two extra tills for the Diwali week and blew through a 4-lane plan.
    const result = meterUsage({
      subscription: KUMAR_SUB, plan: STANDARD, from: '2026-07-01', to: '2026-07-31',
      usage: [
        { tenantId: KUMAR, dimension: 'lanes', units: 4, onDate: '2026-07-01' },
        { tenantId: KUMAR, dimension: 'lanes', units: 7, onDate: '2026-07-18' },
        { tenantId: KUMAR, dimension: 'lanes', units: 4, onDate: '2026-07-25' },
        { tenantId: KUMAR, dimension: 'transactions_per_month', units: 58_000, onDate: '2026-07-31' },
        // SRE's usage sits in the same table and must not touch this invoice.
        { tenantId: SRE, dimension: 'lanes', units: 11, onDate: '2026-07-18' },
      ],
    });

    // A peak dimension meters at its peak: 7 tills, not 15.
    expect(result.dimensions.find((d) => d.dimension === 'lanes')?.used).toBe(7);
    expect(result.dimensions.find((d) => d.dimension === 'lanes')?.overageMinor).toBe(900_000);
    expect(result.totalMinor).toBe(2_400_000);

    // The point of the whole module.
    expect(result.mayContinueTrading).toBe(true);
    expect(result.detail).toContain('the shop keeps trading');

    // And they were told before the invoice was.
    expect(result.dimensions.find((d) => d.dimension === 'transactions_per_month')?.notify).toBe(true);
  });

  it('lets a shop downgrade, names what goes dark, and DELETES NOTHING', () => {
    const result = assessPlanChange({
      subscription: SRE_SUB, current: GROWTH, target: STANDARD,
      currentUsage: [
        { tenantId: SRE, dimension: 'lanes', units: 11, onDate: '2026-07-18' },
        { tenantId: SRE, dimension: 'branches', units: 2, onDate: '2026-07-18' },
      ],
      asAt: '2026-08-04',
    });
    expect(result.allowed).toBe(true);
    expect(result.featuresLost).toEqual(['b2b', 'customer_app', 'dept.concession']);
    expect(result.wouldExceed.map((w) => w.dimension)).toEqual(['branches', 'lanes']);
    expect(result.detail).toContain('**No data is deleted**');
  });

  // ─── 3. ONE DEPLOYMENT, TWO BRANDS ──────────────────────────────────────────

  it('SHOWS TWO DIFFERENT SHOPS FROM ONE BINARY, and never leaks one brand into the other', () => {
    const sre = resolveBrand({ tenantId: SRE, branding: SRE_BRAND });
    const kumar = resolveBrand({ tenantId: KUMAR, branding: KUMAR_BRAND });

    expect(sre.productName).toBe('SRE Hyper');
    expect(kumar.productName).toBe('Kumar Stores');
    expect(sre.colours.primary).not.toBe(kumar.colours.primary);
    expect(sre.templateSetId).not.toBe(kumar.templateSetId);

    // The failure this prevents: a loosely-keyed cache, and Kumar invoicing under SRE's mark.
    const crossed = resolveBrand({ tenantId: SRE, branding: KUMAR_BRAND });
    expect(crossed.productName).toBe('Retail OS');
    expect(crossed.detail).toContain('was IGNORED');

    // A brand-new tenant gets neutral, never the last tenant rendered.
    const fresh = resolveBrand({ tenantId: 'tenant-brand-new' });
    expect(fresh.logoRef).toBe('builtin:neutral-mark');

    // Each shop's own word for a branch.
    expect(applyTerminology({ phrase: 'Branch closing time', terminology: SRE_BRAND.terminology }))
      .toBe('Store closing time');
    expect(applyTerminology({ phrase: 'Branch closing time', terminology: KUMAR_BRAND.terminology }))
      .toBe('Showroom closing time');
  });

  it('REFUSES a brand that renames a word the law names, or that nobody could read', () => {
    const illegal = validateBranding({
      branding: { ...KUMAR_BRAND, terminology: { 'tax invoice': 'bill' } }, tenantId: KUMAR,
    });
    expect(illegal.valid).toBe(false);
    expect(illegal.issues[0]?.kind).toBe('protected_term');

    const unreadable = validateBranding({
      branding: { ...KUMAR_BRAND, colours: { primary: '#cccccc', onPrimary: '#ffffff' } },
      tenantId: KUMAR,
    });
    expect(unreadable.issues[0]?.kind).toBe('low_contrast');

    // And even if one got through validation, rendering refuses it a second time.
    expect(applyTerminology({ phrase: 'Tax invoice enclosed', terminology: { 'tax invoice': 'bill' } }))
      .toBe('Tax invoice enclosed');
  });

  // ─── 4. A SHOP CAN LEAVE ────────────────────────────────────────────────────

  it('EXPORTS EVERYTHING OR REFUSES TO CALL IT AN EXPORT', () => {
    const short = buildTenantExport({
      exportId: `x-${RUN}-1`, tenantId: KUMAR, requestedBy: 'u-kumar-owner',
      domains: DECLARED_DOMAINS.filter((d) => d !== 'finance').map((domain) => ({
        domain, rows: 100, format: 'jsonl' as const, checksum: `sha256:${domain}`, bytes: 10_000,
      })),
      declaredDomains: DECLARED_DOMAINS, at: '2026-08-04T09:00:00Z',
    });
    expect(short.complete).toBe(false);
    expect(short.missing).toEqual(['finance']);
    expect(short.detail).toContain('the customer finds out months later');

    const full = buildTenantExport({
      exportId: `x-${RUN}-2`, tenantId: KUMAR, requestedBy: 'u-kumar-owner',
      domains: DECLARED_DOMAINS.map((domain) => ({
        domain, rows: domain === 'suppliers' ? 0 : 100, format: 'jsonl' as const,
        checksum: `sha256:${domain}`, bytes: 10_000,
      })),
      declaredDomains: DECLARED_DOMAINS, at: '2026-08-04T09:00:00Z',
    });
    expect(full.complete).toBe(true);
    // A domain with no rows is PRESENT and zero. Absence and emptiness are different facts.
    expect(full.domains.find((d) => d.domain === 'suppliers')?.rows).toBe(0);

    // Another tenant's file in the bundle refuses the whole export.
    const contaminated = buildTenantExport({
      exportId: `x-${RUN}-3`, tenantId: KUMAR, requestedBy: 'u-kumar-owner',
      domains: [
        ...DECLARED_DOMAINS.map((domain) => ({
          domain, rows: 1, format: 'jsonl' as const, checksum: `sha256:${domain}`, bytes: 10,
        })),
        { domain: 'sales', rows: 5, format: 'jsonl' as const, checksum: 'sha256:x', bytes: 10, tenantId: SRE },
      ],
      declaredDomains: DECLARED_DOMAINS, at: '2026-08-04T09:00:00Z',
    });
    expect(contaminated.outcome).toBe('wrong_tenant');
  });

  it('closes a shop, keeps what the LAW wants, and never touches the audit trail', () => {
    const complete = buildTenantExport({
      exportId: `x-${RUN}-2`, tenantId: KUMAR, requestedBy: 'u-kumar-owner',
      domains: DECLARED_DOMAINS.map((domain) => ({
        domain, rows: 100, format: 'jsonl' as const, checksum: `sha256:${domain}`, bytes: 10_000,
      })),
      declaredDomains: DECLARED_DOMAINS, at: '2026-08-04T09:00:00Z',
    });
    const obligations = [{
      obligationId: `ob-${RUN}`, tenantId: KUMAR, what: 'sales and tax records',
      law: 'Income Tax Act 1961 s.44AA', keepUntil: '2034-03-31',
    }];

    // Not before they have their data — this is the last easy moment to get it.
    expect(closeTenant({
      tenantId: KUMAR, state: 'active', obligations, approvedBy: 'u-platform-admin', today: '2026-08-04',
    }).outcome).toBe('export_not_taken');

    // Not without a name against it.
    expect(closeTenant({
      tenantId: KUMAR, state: 'active', obligations, exportTaken: complete, today: '2026-08-04',
    }).outcome).toBe('not_approved');

    const closed = closeTenant({
      tenantId: KUMAR, state: 'active', obligations, exportTaken: complete,
      approvedBy: 'u-platform-admin', today: '2026-08-04',
    });
    expect(closed.closed).toBe(true);
    expect(closed.accessRevoked).toBe(true);
    expect(closed.retained.map((r) => r.what)).toEqual(['sales and tax records', 'audit evidence']);
    expect(closed.retained[1]?.untilDate).toBe('indefinitely');
    expect(closed.detail).toContain('Income Tax Act 1961');
  });

  it('will not ship an upgrade that breaks a LIVE tenant, and names who it would break', () => {
    const liveUsage = [
      { tenantId: SRE, uses: ['orders.list', 'orders.legacyStatus'] },
      { tenantId: KUMAR, uses: ['orders.list'] },
    ];

    const additive = assessCompatibility({
      change: { contract: 'API-06 orders', fromVersion: 'v3', toVersion: 'v4', removed: [], added: ['orders.slot'] },
      liveUsage, today: '2026-08-04',
    });
    expect(additive.safeToDeploy).toBe(true);

    const announcedYesterday = assessCompatibility({
      change: {
        contract: 'API-06 orders', fromVersion: 'v3', toVersion: 'v4',
        removed: ['orders.legacyStatus'], added: [], deprecatedOn: '2026-08-03',
      },
      liveUsage, today: '2026-08-04',
    });
    expect(announcedYesterday.verdict).toBe('deprecation_pending');
    expect(announcedYesterday.detail).toContain('the announcement is not the mitigation');

    const windowElapsed = assessCompatibility({
      change: {
        contract: 'API-06 orders', fromVersion: 'v3', toVersion: 'v4',
        removed: ['orders.legacyStatus'], added: [], deprecatedOn: '2025-06-01',
      },
      liveUsage, today: '2026-08-04',
    });
    // The window ran out and SRE is STILL calling it. Named, not counted.
    expect(windowElapsed.verdict).toBe('breaking');
    expect(windowElapsed.tenantsAffected).toEqual([SRE]);
  });

  // ─── 5. A PARTNER BUILDS ON THE SANDBOX ─────────────────────────────────────

  const sandboxCred: PartnerCredential = {
    credentialId: `pc-${RUN}-sandbox`, partnerId: 'p-integrator', environment: 'sandbox',
    scopedTenantIds: ['t-sandbox-1'], scopes: ['orders.read'],
    issuedOn: '2026-07-01', expiresOn: '2027-07-01',
  };
  const prodCred: PartnerCredential = {
    ...sandboxCred, credentialId: `pc-${RUN}-prod`, environment: 'production', scopedTenantIds: [SRE],
  };

  it('lets a partner build in the sandbox and run UNCHANGED against a real shop', () => {
    const inSandbox = checkPartnerAccess({
      credential: sandboxCred, environment: 'sandbox', tenantId: 't-sandbox-1',
      requiredScope: 'orders.read', contract: 'API-06 orders', requestedVersion: 'v3',
      versions: VERSIONS, today: '2026-08-04',
    });
    expect(inSandbox.allowed).toBe(true);

    // The same call, the same version, a real shop — no SRE code change in between.
    const inProduction = checkPartnerAccess({
      credential: prodCred, environment: 'production', tenantId: SRE,
      requiredScope: 'orders.read', contract: 'API-06 orders', requestedVersion: 'v3',
      versions: VERSIONS, today: '2026-08-04',
    });
    expect(inProduction.allowed).toBe(true);
  });

  it('REFUSES a sandbox key against a real shop, and a real shop\'s data into a sandbox', () => {
    const wrongWay = checkPartnerAccess({
      credential: sandboxCred, environment: 'production', tenantId: SRE,
      requiredScope: 'orders.read', contract: 'API-06 orders', requestedVersion: 'v3',
      versions: VERSIONS, today: '2026-08-04',
    });
    expect(wrongWay.allowed).toBe(false);
    expect(wrongWay.securityEvent).toBe(true);

    // And production data into a sandbox is refused whatever reason is given.
    const seed = seedSandbox({
      sandbox: { tenantId: 't-sandbox-1', partnerId: 'p-integrator', createdOn: '2026-07-01', expiresOn: '2026-12-31', syntheticDataOnly: true },
      records: [{ recordId: 'r-1', origin: 'generated' }, { recordId: 'r-2', origin: 'production' }],
      today: '2026-08-04',
    });
    expect(seed.seeded).toBe(false);
    expect(seed.detail).toContain('whatever the reason given');
  });

  it('scopes a partner to the shops that engaged them, and refuses an unversioned call', () => {
    const otherShop = checkPartnerAccess({
      credential: prodCred, environment: 'production', tenantId: KUMAR,
      requiredScope: 'orders.read', contract: 'API-06 orders', requestedVersion: 'v3',
      versions: VERSIONS, today: '2026-08-04',
    });
    expect(otherShop.outcome).toBe('tenant_not_in_scope');
    expect(otherShop.securityEvent).toBe(true);

    const unversioned = checkPartnerAccess({
      credential: prodCred, environment: 'production', tenantId: SRE,
      requiredScope: 'orders.read', contract: 'API-06 orders',
      versions: VERSIONS, today: '2026-08-04',
    });
    expect(unversioned.outcome).toBe('unversioned');

    const retired = checkPartnerAccess({
      credential: prodCred, environment: 'production', tenantId: SRE,
      requiredScope: 'orders.read', contract: 'API-06 orders', requestedVersion: 'v1',
      versions: VERSIONS, today: '2026-08-04',
    });
    expect(retired.outcome).toBe('version_retired');
  });

  it('calls a connector certified against an old contract what it is', () => {
    const stale = certificationStatus({
      connectorId: 'conn-tally', partnerId: 'p-integrator',
      certification: {
        certificationId: `cert-${RUN}`, partnerId: 'p-integrator', connectorId: 'conn-tally',
        certifiedOn: '2026-02-01', againstVersions: [{ contract: 'API-06 orders', version: 'v2' }],
        certifiedBy: 'u-platform-admin',
      },
      currentVersions: VERSIONS, today: '2026-08-04',
    });
    expect(stale.verdict).toBe('stale_version');
    expect(stale.mayRunInProduction).toBe(true);
    expect(stale.detail).toContain('old with a badge');

    const never = certificationStatus({
      connectorId: 'conn-rogue', partnerId: 'p-integrator',
      currentVersions: VERSIONS, today: '2026-08-04',
    });
    expect(never.mayRunInProduction).toBe(false);
  });

  // ─── 6. THE INNOVATION WAVE ON THE SHOP FLOOR ───────────────────────────────

  const line = (over: Partial<ScannedLine>): ScannedLine => ({
    lineId: `l-${RUN}-1`, productId: 'p-bread', name: 'Bread 400g', qty: 1,
    unitPriceMinor: 4_500, scannedAt: '2026-08-04T18:00:00Z', ...over,
  });

  it('HELPS at the self-checkout instead of accusing, and always sends a human for age', () => {
    const plain = assessSelfCheckout({
      basketId: `b-${RUN}`, laneId: 'sco-1', mode: 'self_checkout',
      lines: [line({}), line({ lineId: `l-${RUN}-2`, productId: 'p-milk', name: 'Milk 1L', unitPriceMinor: 6_200 })],
      at: '2026-08-04T18:00:00Z',
    });
    expect(plain.canCompleteUnattended).toBe(true);

    const heavy = assessSelfCheckout({
      basketId: `b-${RUN}-2`, laneId: 'sco-1', mode: 'self_checkout',
      lines: [line({ observedGrams: 900, expectedGrams: 400 })], at: '2026-08-04T18:05:00Z',
    });
    expect(heavy.interventions[0]?.customerMessage).toBe('Please wait — a colleague will be with you.');
    expect(heavy.interventions[0]?.attendantDetail).toContain('check, do not accuse');

    const beer = assessSelfCheckout({
      basketId: `b-${RUN}-3`, laneId: 'sco-1', mode: 'self_checkout',
      lines: [line({ name: 'Beer 650ml', ageRestricted: true })], at: '2026-08-04T18:10:00Z',
    });
    expect(beer.canCompleteUnattended).toBe(false);
    expect(beer.interventions[0]?.attendantDetail).toContain('never will');

    // The banana trick: five loose-produce lines. Watched, scored, and NOT held up.
    const produce = assessSelfCheckout({
      basketId: `b-${RUN}-4`, laneId: 'sco-1', mode: 'self_checkout',
      lines: Array.from({ length: 5 }, (_, n) =>
        line({ lineId: `l-${RUN}-p${n}`, productId: 'p-loose', name: 'Loose onions', looseProduce: true })),
      at: '2026-08-04T18:15:00Z',
    });
    expect(produce.canCompleteUnattended).toBe(true);
    expect(produce.riskBps).toBeGreaterThan(0);
    expect(produce.interventions[0]?.attendantDetail).toContain('say nothing about it');
  });

  it('releases a trusted scan-and-go trip and ends one that has an age-restricted item', () => {
    expect(decideScanAndGo({
      basketId: `b-${RUN}-5`, customerId: 'c-1', lines: [line({})],
      tripsCompleted: 30, discrepanciesFound: 0, selectedForAudit: false,
    }).released).toBe(true);

    expect(decideScanAndGo({
      basketId: `b-${RUN}-6`, customerId: 'c-1', lines: [line({ ageRestricted: true })],
      tripsCompleted: 30, discrepanciesFound: 0, selectedForAudit: false,
    }).outcome).toBe('age_restricted_present');

    const withdrawn = decideScanAndGo({
      basketId: `b-${RUN}-7`, customerId: 'c-2', lines: [line({})],
      tripsCompleted: 12, discrepanciesFound: 2, selectedForAudit: false,
    });
    expect(withdrawn.released).toBe(false);
    expect(withdrawn.detail).toContain('loses them for good');
  });

  it('makes the kiosk admit when its list is old rather than quote a stale promotion', () => {
    const pack = [{ productId: 'p-atta', name: 'Atta 5kg', priceMinor: 26_500 }];

    const fresh = quotePrice({
      productId: 'p-atta', pack, packBuiltAt: '2026-08-04T17:00:00Z', at: '2026-08-04T18:00:00Z',
    });
    expect(fresh.priceMinor).toBe(26_500);
    expect(fresh.minutesSincePack).toBe(60);

    const old = quotePrice({
      productId: 'p-atta', pack, packBuiltAt: '2026-08-03T09:00:00Z', at: '2026-08-04T18:00:00Z',
    });
    expect(old.outcome).toBe('stale');
    expect(old.detail).toContain('check the price at the counter');
  });

  it('puts a ₹4 SHELF UNDERSTATEMENT above a ₹5,000 margin leak, because one is the law', () => {
    const displayed: readonly DisplayedPrice[] = [
      // The shelf says ₹261.00 and the till charges ₹265.00. Small money, legal exposure.
      { surface: 'shelf_label', productId: 'p-atta', branchId: 'b-main', priceMinor: 26_100, lastConfirmedAt: '2026-08-04T08:00:00Z', shelfAddress: 'A-04-3' },
      // The shelf says ₹190.00 and the till charges ₹140.00 across 100 units. ₹5,000.
      { surface: 'shelf_label', productId: 'p-oil', branchId: 'b-main', priceMinor: 19_000, lastConfirmedAt: '2026-08-04T08:00:00Z', shelfAddress: 'B-02-1' },
      // And an electronic label that has not been heard from in nine days.
      { surface: 'esl', productId: 'p-rice', branchId: 'b-main', priceMinor: 145_000, lastConfirmedAt: '2026-07-26T08:00:00Z', deviceId: 'esl-118', shelfAddress: 'C-01-2' },
    ];

    const report = auditPriceIntegrity({
      branchId: 'b-main',
      products: [
        { productId: 'p-atta', name: 'Atta 5kg', posPriceMinor: 26_500 },
        { productId: 'p-oil', name: 'Sunflower oil 1L', posPriceMinor: 14_000 },
        { productId: 'p-rice', name: 'Sona Masoori 25kg', posPriceMinor: 152_000 },
      ],
      displayed, unitsSold: { 'p-atta': 2, 'p-oil': 100 },
      requiredSurfaces: ['shelf_label'], asAt: '2026-08-04T12:00:00Z',
    });

    expect(report.overchargeRisks).toHaveLength(1);
    expect(report.overchargeRisks[0]?.productId).toBe('p-atta');
    expect(report.overchargeRisks[0]?.detail).toContain('what the customer was offered');
    // The bigger number is deliberately second.
    expect(report.undercharedExposureMinor).toBe(500_000);
    expect(report.other.some((f) => f.kind === 'esl_unreachable')).toBe(true);
    expect(report.other.find((f) => f.kind === 'esl_unreachable')?.detail).toContain('esl-118');
    // Rice has no shelf label at all.
    expect(report.other.some((f) => f.kind === 'surface_missing')).toBe(true);
  });

  it('HOLDS THE TILL PRICE until every electronic label has confirmed it', () => {
    const devices = [
      { deviceId: 'esl-1', shelfAddress: 'A-04-3', batteryPercent: 80 },
      { deviceId: 'esl-2', shelfAddress: 'A-04-4', batteryPercent: 75 },
    ];

    const partial = pushEslPrice({
      productId: 'p-atta', branchId: 'b-main', priceMinor: 27_500, devices, confirmedBy: ['esl-1'],
    });
    expect(partial.safeToChangeAtTill).toBe(false);
    // Fire-and-forget would CREATE the overcharge risk the audit above exists to catch.
    expect(partial.detail).toContain('exactly the problem this system exists to prevent');

    const confirmed = pushEslPrice({
      productId: 'p-atta', branchId: 'b-main', priceMinor: 27_500, devices, confirmedBy: ['esl-1', 'esl-2'],
    });
    expect(confirmed.safeToChangeAtTill).toBe(true);
  });

  // ─── 7. IT IS ALL BANKED, FOR BOTH SHOPS ────────────────────────────────────

  it('banks both tenants and the database refuses to unpick either', async () => {
    for (const [tenant, label] of [[SRE, 'SRE'], [KUMAR, 'Kumar']] as const) {
      await store.append(
        tenant,
        `stage18/${RUN}`,
        makeEvent({
          id: `${RUN}-${label}-platform`,
          type: 'PlanMetered',
          occurredAt: '2026-08-04T23:00:00Z',
          idempotencyKey: `${RUN}:${label}:metered`,
          source: 'web-erp',
          payload: { tenant: label, mayContinueTrading: true },
        }),
      );
    }

    expect(await store.readStream(SRE, `stage18/${RUN}`)).toHaveLength(1);
    expect(await store.readStream(KUMAR, `stage18/${RUN}`)).toHaveLength(1);

    const refusalFor = async (sql: string, tenant: string): Promise<string> => {
      try {
        await client.query(sql, [tenant]);
        return 'THE DATABASE ALLOWED IT';
      } catch (error) {
        return (error as Error).message;
      }
    };
    expect(await refusalFor('DELETE FROM event_ledger WHERE tenant_id = $1', KUMAR)).toMatch(/append-only/i);
    expect(await refusalFor("UPDATE event_ledger SET type = 'x' WHERE tenant_id = $1", SRE)).toMatch(/append-only/i);

    // Closing a tenant revokes access. It does not, and cannot, delete the ledger.
    expect(await store.readStream(KUMAR, `stage18/${RUN}`)).toHaveLength(1);
  });
});
