import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startW4Shop, openAs, says, type W4Shop } from './lib/w4-office-shop';

/**
 * **W5 · access and approvals, connected: the new sections on six office pages, in a real browser, on the production API
 * surface over real PostgreSQL (DATABASE_URL).** Each page asks its own route's permission; reading is a click; every write is
 * exactly one POST of head office's own route; refusals are head office's words.
 *   • OB-87 · OB-54 — Store computers: the conflicts register lists a write head office refused for reusing a key with
 *     different content; the refusals and stamps lists read (GETs only);
 *   • M02-FR-03 — Approvals: the aged-approvals report lists what waits; Delegation: "what may this person approve today";
 *   • M01-FR-03 — Approval rules: a rule's history, the preview of an older version, the rollback ASKED by the owner, APPROVED
 *     by the accountant in her own session (OB-613), and APPLIED by the owner — a new version, nothing overwritten;
 *   • OB-165 · OB-167 — Users: an Internal Committee change asked by the owner, approved by the store manager, and
 *     applied by the owner (the route checks the second person's approval of exactly that change and a fresh two-step sign-in);
 *   • SEC-11 — Users: the owner signs a person out everywhere; the revocation is on the record;
 *   • OB-681 · OB-143 — Users: the owner asks for the chartered accountant's role, the IT custodian (the named security
 *     reviewer) approves it in his own session, the owner applies it; the CA holds the role, the owner gains none of its
 *     settings permissions;
 *   • M33-FR-03 — Administration: the support-access review reads;
 *   • a cashier is told his role cannot see the registers; the sections read in Tamil.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER = 'u-owner'; const MGR = 'u-mgr'; const ACCT = 'u-acct'; const CASHIER = 'u-cashier'; const HR = 'u-hr'; const SIVA = 'u-siva'; const CA = 'u-ca';
const PAGES = {
  '/store-computers': { html: 'store-computers.html', dataGlobal: 'storeComputersData' },
  '/approvals': { html: 'approvals.html', dataGlobal: 'approvalsData' },
  '/approval-rules': { html: 'approval-rules.html', dataGlobal: 'approvalRulesData' },
  '/delegation': { html: 'delegation.html', dataGlobal: 'delegationData' },
  '/users': { html: 'users.html', dataGlobal: 'usersData' },
  '/admin': { html: 'admin.html', dataGlobal: 'adminData' },
};

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('W5 access and approvals sections, connected on PostgreSQL', () => {
  let browser: Browser;
  let shop: W4Shop;
  const T = randomUUID();
  const as = (userId: string, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, key = `seed-${randomUUID()}`) =>
    shop.ho().request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: key }), ...(body === undefined ? {} : { body }) });
  const decide = async (who: string, requestId: string) => {
    const r = await as(who, 'POST', `/v1/approvals/requests/${requestId}/decide`, { decision: 'approved', reason: 'checked, agreed' });
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
  };
  const changeWaits = async (refund: number) => {
    const rules = (await as(OWNER, 'GET', '/v1/approvals/rules')).body as { rules: Record<string, { version: number; value: Record<string, number> }> };
    const cur = rules.rules['escalation-waits']!;
    const details = { rule: 'escalation-waits', value: { ...cur.value, refund }, basedOnVersion: cur.version, reason: `refunds wait ${refund} minutes` };
    const ask = await as(OWNER, 'POST', '/v1/approvals/requests', { kind: 'approval_rule_change', subjectRef: 'rule:escalation-waits', details, valueMinor: null, summary: 'waits', reason: details.reason });
    expect(ask.status, JSON.stringify(ask.body)).toBeLessThan(300);
    const requestId = (ask.body as { requestId: string }).requestId;
    await decide(ACCT, requestId);
    const { rule: _r, ...body } = details;
    const put = await as(OWNER, 'PUT', '/v1/approvals/rules/escalation-waits', { ...body, approvalId: requestId });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
  };

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startW4Shop({ tenantId: T, databaseUrl: DATABASE_URL, pages: PAGES });
    await shop.ho().seedOwner(T, OWNER);
    await shop.ho().provisionRole(T, MGR, 'store_manager');
    await shop.ho().provisionRole(T, ACCT, 'accountant');
    await shop.ho().provisionRole(T, CASHIER, 'cashier', ['store-1']);
    await shop.ho().provisionRole(T, HR, 'cashier', ['store-1']);
    await shop.ho().provisionRole(T, SIVA, 'security_reviewer');
    // Two changes to the escalation waits, each asked by the owner and approved by the accountant (versions 1 and 2).
    await changeWaits(45);
    await changeWaits(60);
    // OB-87: the same key sent back with different content — head office refuses it and keeps it on the register.
    const key = `same-key-${randomUUID()}`;
    expect((await as(OWNER, 'POST', '/v1/platform/service-requests', { requestId: 'sr-a', title: 'A', detail: 'first' }, key)).status).toBe(201);
    expect((await as(OWNER, 'POST', '/v1/platform/service-requests', { requestId: 'sr-a', title: 'B', detail: 'different' }, key)).status).toBe(409);
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  it('OB-87 · OB-54: the owner reads the registers on Store computers — the refused same-key write is listed; nothing is written', async () => {
    expect(shop.backing).toBe('PostgreSQL');
    const s = await openAs(shop, browser, OWNER, '/store-computers');
    try {
      await says(s.page, '#w5-reg-h', /^Records head office kept aside$/);
      await s.page.click('#w5-reg-show');
      await says(s.page, '#w5-conflicts', /u-owner · POST \/v1\/platform\/service-requests — /);
      await says(s.page, '#w5-refusals', /Nothing to show\./);
      await says(s.page, '#w5-stamps', /Nothing to show\./);
      expect(s.writes, 'reading the registers writes nothing').toEqual([]);
      await s.page.click('#lang');
      await says(s.page, '#w5-reg-h', /^தலைமை அலுவலகம் தனியாக வைத்த பதிவுகள்$/);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  }, 120_000);

  it('a cashier is told his role cannot read the registers — no button, nothing sent', async () => {
    const s = await openAs(shop, browser, CASHIER, '/store-computers', 'store-1');
    try {
      await says(s.page, '#w5-reg-status', /^Your role cannot do this\.$/);
      expect(await s.page.locator('#w5-reg-show').count()).toBe(0);
      expect(s.writes).toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  }, 120_000);

  it('M02-FR-03: the aged-approvals report reads on Approvals; Delegation answers what a person may approve today', async () => {
    let s = await openAs(shop, browser, OWNER, '/approvals');
    try {
      await says(s.page, '#w5-aged-h', /^Aged approvals$/);
      await s.page.click('#w5-aged-show');
      await says(s.page, '#w5-aged-waiting', /Nothing to show\./);
      await says(s.page, '#w5-aged-escalated', /Nothing to show\./);
      expect(s.writes).toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    s = await openAs(shop, browser, OWNER, '/delegation');
    try {
      await s.page.fill('#w5-eff-who', MGR);
      await s.page.selectOption('#w5-eff-kind', 'refund');
      await s.page.fill('#w5-eff-on', '3/11/2026');
      await s.page.click('#w5-eff-ask');
      await says(s.page, '#w5-eff-status', /^Write the date as YYYY-MM-DD\.$/);
      expect(s.writes, 'a malformed day is refused on the page').toEqual([]);
      await s.page.fill('#w5-eff-on', '');
      await s.page.click('#w5-eff-ask');
      await says(s.page, '#w5-eff-answer', /^No authority — u-mgr has no authority over refund$/);
      expect(s.writes).toEqual(['POST /v1/access/delegations/effective-authority']);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  }, 120_000);

  it('M01-FR-03: the owner previews going back to version 1, asks for it, the accountant approves, the owner applies it — version 3 restores 1', async () => {
    let s = await openAs(shop, browser, OWNER, '/approval-rules');
    try {
      await s.page.selectOption('#w5-hist-rule', 'escalation-waits');
      await s.page.click('#w5-hist-show');
      await says(s.page, '#w5-hist-versions', /In force: version 2/);
      await says(s.page, '#w5-hist-versions li[data-version="1"]', /Version 1 · u-owner · .* · refunds wait 45 minutes — approved by u-acct/);
      await s.page.click('#w5-hist-preview-1');
      await says(s.page, '#w5-hist-preview', /refund: 60 → 45/);
      await s.page.click('#w5-hist-ask-1');
      await says(s.page, '#w5-hist-status', /^Say, in writing, why\.$/);
      await s.page.fill('#w5-hist-reason', 'sixty minutes was too long for a refund');
      await s.page.click('#w5-hist-ask-1');
      await says(s.page, '#w5-hist-status', /^Asked\. It waits for approval on the Approvals page\.$/);
      await says(s.page, '#w5-hist-asked', /Escalation waits · back to version 1 · Waiting for approval/);
      expect(s.writes).toEqual(['POST /v1/approvals/rules/escalation-waits/preview', 'POST /v1/approvals/requests']);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    // The accountant approves exactly that rollback in her own session (OB-613: the owner asked it).
    const mine = (await as(OWNER, 'GET', '/v1/approvals/requests')).body as { mine: { requestId: string; details?: { toVersion?: number } }[] };
    const asked = mine.mine.find((r) => r.details?.toVersion === 1)!;
    await decide(ACCT, asked.requestId);

    s = await openAs(shop, browser, OWNER, '/approval-rules');
    try {
      await s.page.selectOption('#w5-hist-rule', 'escalation-waits');
      await s.page.click('#w5-hist-show');
      await says(s.page, '#w5-hist-asked', /back to version 1 · Approved — apply it now · u-acct/);
      await s.page.click(`#w5-hist-apply-${asked.requestId}`);
      await says(s.page, '#w5-hist-status', /^Applied\. The older figures are in force as a new version\.$/);
      await says(s.page, '#w5-hist-versions', /In force: version 3/);
      await says(s.page, '#w5-hist-versions li[data-version="3"]', /restored version 1/);
      expect(s.writes).toEqual([`POST /v1/approvals/rules/escalation-waits/rollback`]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    const rules = (await as(OWNER, 'GET', '/v1/approvals/rules')).body as { rules: Record<string, { version: number; value: Record<string, number> }> };
    expect(rules.rules['escalation-waits']).toMatchObject({ version: 3, value: { refund: 45 } });
  });

  it('OB-165 · SEC-11: on Users the owner asks a committee change (a second person approves it, then the owner applies it) and signs a person out everywhere', async () => {
    let s = await openAs(shop, browser, OWNER, '/users');
    try {
      await s.page.fill('#w5-ic-who', HR);
      await s.page.selectOption('#w5-ic-action', 'add');
      await s.page.fill('#w5-ic-reason', 'joins the Internal Committee');
      await s.page.click('#w5-ic-ask');
      await says(s.page, '#w5-ic-status', /^Asked\. A second person approves it on the Approvals page\.$/);
      await says(s.page, '#w5-ic-asked', /Add to the committee: u-hr · Waiting for approval/);
      // SEC-11: sign the cashier out everywhere.
      await s.page.selectOption('#w5-rev-target', 'user');
      await s.page.fill('#w5-rev-id', CASHIER);
      await s.page.selectOption('#w5-rev-why', 'security');
      await s.page.click('#w5-rev-go');
      await says(s.page, '#w5-rev-status', /^Done\. Their sign-ins up to now no longer work\.$/);
      await says(s.page, '#w5-rev-list', /every sign-in of u-cashier .*Security worry \(lost or stolen\) · by u-owner/);
      expect(s.writes).toEqual(['POST /v1/approvals/requests', 'POST /v1/identity/token-revocations']);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    const rev = (await as(OWNER, 'GET', '/v1/identity/token-revocations')).body as { revocations: { userId?: string; reason: string; revokedBy: string }[] };
    expect(rev.revocations).toEqual([expect.objectContaining({ userId: CASHIER, reason: 'security', revokedBy: OWNER })]);

    const mine = (await as(OWNER, 'GET', '/v1/approvals/requests')).body as { mine: { requestId: string; kind: string }[] };
    const ic = mine.mine.find((r) => r.kind === 'posh_committee_change')!;
    await decide(MGR, ic.requestId);
    s = await openAs(shop, browser, OWNER, '/users');
    try {
      await s.page.click('#w5-ic-show');
      await says(s.page, '#w5-ic-asked', /u-hr · Approved — apply it now · u-mgr/);
      await s.page.click(`#w5-ic-apply-${ic.requestId}`);
      await says(s.page, '#w5-ic-status', /^Applied\. The committee changed\.$/);
      await says(s.page, '#w5-ic-asked', /u-hr · Applied/);
      expect(s.writes).toEqual([expect.stringMatching(/^POST \/v1\/identity\/internal-committee\/changes\/ic-/)]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    const roles = (await as(OWNER, 'GET', '/v1/identity/grants')).body as { grants?: { userId: string; roleId: string }[] };
    expect((roles.grants ?? []).some((g) => g.userId === HR && g.roleId === 'internal_committee'), 'u-hr is on the committee now').toBe(true);
  });

  it('OB-681 · OB-143: on Users the owner asks for the chartered accountant\'s role, the IT custodian approves, the owner applies it', async () => {
    const named = await as(OWNER, 'PUT', '/v1/compliance/security-reviewer', { userId: SIVA, displayName: 'Mr Sivakumar', reason: 'OB-405: the IT custodian' });
    expect(named.status, JSON.stringify(named.body)).toBe(200);
    let s = await openAs(shop, browser, OWNER, '/users');
    try {
      await says(s.page, '#w5-ca-h', /^Give the chartered accountant's role$/);
      await s.page.fill('#w5-ca-who', CA);
      await s.page.fill('#w5-ca-reason', 'the CA fills the reverse-charge and TDS lists');
      await s.page.click('#w5-ca-ask');
      await says(s.page, '#w5-ca-status', /^Asked\. The IT custodian approves it on the Approvals page\.$/);
      await says(s.page, '#w5-ca-asked', /u-ca · Waiting for approval/);
      expect(s.writes).toEqual(['POST /v1/approvals/requests']);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    const mine = (await as(OWNER, 'GET', '/v1/approvals/requests')).body as { mine: { requestId: string; kind: string }[] };
    const ask = mine.mine.find((r) => r.kind === 'ca_role_grant')!;
    expect((await as(MGR, 'POST', `/v1/approvals/requests/${ask.requestId}/decide`, { decision: 'approved', reason: 'x' })).status, 'a store manager cannot decide it').toBeGreaterThanOrEqual(400);
    await decide(SIVA, ask.requestId);
    s = await openAs(shop, browser, OWNER, '/users');
    try {
      await s.page.click('#w5-ca-show');
      await says(s.page, '#w5-ca-asked', /u-ca · Approved — apply it now · u-siva/);
      await s.page.click(`#w5-ca-apply-${ask.requestId}`);
      await says(s.page, '#w5-ca-status', /^Applied\. They hold the chartered accountant's role now\.$/);
      expect(s.writes).toEqual([expect.stringMatching(/^POST \/v1\/identity\/chartered-accountant\/grants\/ca-/)]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    const ca = (await as(CA, 'GET', '/v1/identity/me')).body as { permissions: string[] };
    expect(ca.permissions).toEqual(expect.arrayContaining(['finance.rcm.configure', 'finance.tds.configure', 'privacy.volume.threshold.set']));
    const owner = (await as(OWNER, 'GET', '/v1/identity/me')).body as { permissions: string[] };
    expect(owner.permissions.filter((p) => ['finance.rcm.configure', 'finance.tds.configure', 'privacy.volume.threshold.set'].includes(p))).toEqual([]);
  }, 120_000);

  it('M33-FR-03: the support-access review reads on Administration', async () => {
    const s = await openAs(shop, browser, OWNER, '/admin');
    try {
      await says(s.page, '#w5-sup-h', /^Support access — who had it$/);
      await s.page.click('#w5-sup-show');
      await says(s.page, '#w5-sup-list', /Nothing to show\./);
      expect(s.writes).toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  }, 120_000);
});
