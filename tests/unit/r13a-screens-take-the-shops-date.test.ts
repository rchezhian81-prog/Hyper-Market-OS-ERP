import { describe, it, expect, afterEach, vi } from 'vitest';
import { shopDay, shopDateOf, shopZoneOr, servedShopZone, monthBefore } from '../../packages/calendar/src/shop-day';
import { startOfToday, endOfTodayField, deadlineInstant, createStoreOpsSession, todayAtShop as wasteToday } from '../../apps/web-erp/src/store-ops-session';
import { createMigrationSession, type MigrationConfig, type MigrationPorts } from '../../apps/web-erp/src/migration-session';
import { createCountPlansSession } from '../../apps/web-erp/src/count-plans-session';
import type { HeadOfficeHttp, HttpAnswer } from '../../apps/web-erp/src/head-office-http';
import { createIncidentsSession } from '../../apps/web-erp/src/incidents-session';
import { createB2BDeskSession } from '../../apps/web-erp/src/b2b-desk-session';
import { raiseRequest } from '../../apps/customer-app/src/privacy-centre';
import { createB2BPortalSession, type B2BPortalData } from '../../apps/b2b-app/src/b2b-portal-session';
import { laneHealth, type ScreenInput } from '../../edge/store-edge/src/screen-data';
// The till's plain pages carry no bundle: their shop date is a small module of its own (apps/pos/web/shop-date.js).
// @ts-expect-error — a plain browser module with no types, imported here to test the rule it holds
import { shopDateIn as tillShopDate, shopZoneOf as tillShopZone } from '../../apps/pos/web/shop-date.js';
import { SyncOutbox } from '../../packages/sync/src/index';

/**
 * **OB-606 (owner, 29 Oct 2026) — every screen takes the SHOP's date, never the device's own (M01-FR-02 · P-08 · R13-A).**
 *
 * The moment used throughout: 19:30 UTC on 28 Oct 2026 — 01:00 on the 29th in the shop (Asia/Kolkata), while a device on
 * UTC, in London (UTC+0 after 25 Oct) or in New York (UTC−4) still reads the 28th. Each case below failed before round 13
 * on this machine (UTC): the screen gave the 28th, or the device's own month, or the machine's wall clock.
 */

const EVENING = '2026-10-28T19:30:00.000Z';
const SHOP_DAY = '2026-10-29';
const SHOP = 'Asia/Kolkata';
const pin = (at: string = EVENING): void => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(at)); };

describe('the shop\'s day on a screen (packages/calendar/src/shop-day.ts)', () => {
  afterEach(() => { vi.useRealTimers(); delete (globalThis as { shopTimeZone?: unknown }).shopTimeZone; });

  it('today, yesterday, this month and last month are the shop\'s at 01:00 shop time — not the device\'s 28th', () => {
    const d = shopDay(SHOP, () => EVENING);
    expect([d.today(), d.daysAgo(1), d.thisMonth(), d.lastMonth()]).toEqual([SHOP_DAY, '2026-10-28', '2026-10', '2026-09']);
    // The month boundary: 19:30 UTC on 30 Sep is already 1 Oct in the shop, so "this month" is October and last is September.
    const monthEnd = shopDay(SHOP, () => '2026-09-30T19:30:00.000Z');
    expect([monthEnd.today(), monthEnd.thisMonth(), monthEnd.lastMonth()]).toEqual(['2026-10-01', '2026-10', '2026-09']);
    // And the year: 31 Dec 19:30 UTC is New Year's Day in the shop.
    const yearEnd = shopDay(SHOP, () => '2026-12-31T19:30:00.000Z');
    expect([yearEnd.today(), yearEnd.lastMonth()]).toEqual(['2027-01-01', '2026-12']);
    expect(monthBefore('2027-01')).toBe('2026-12');
  });

  it('the wall clock, the start of today and a deadline field are all the shop\'s clock', () => {
    const d = shopDay(SHOP, () => EVENING);
    expect(d.wallClock()).toBe('2026-10-29T01:00');
    expect(d.startOfToday()).toBe('2026-10-28T18:30:00.000Z'); // the shop's midnight
    expect(d.endOfTodayField()).toBe('2026-10-29T23:59');
    expect(d.instantOfField('2026-10-29T23:59')).toBe('2026-10-29T18:29:00.000Z');
    expect(d.instantOfField('not a time')).toBe('');
  });

  it('a shown date: an instant on the shop\'s date, a plain date kept, anything else nothing (never made up)', () => {
    expect(shopDateOf(EVENING, SHOP)).toBe(SHOP_DAY);
    expect(shopDateOf('2026-10-28', SHOP)).toBe('2026-10-28'); // a plain date (a due-on day) is not moved by any zone
    expect(shopDateOf('', SHOP)).toBe('');
    expect(shopDateOf('soon', SHOP)).toBe('');
    expect(shopDateOf(undefined, SHOP)).toBe('');
  });

  it('a date in words, English and Tamil, on the shop\'s day', () => {
    const d = shopDay(SHOP, () => EVENING);
    expect(d.dayWords(EVENING, 'en')).toMatch(/Thursday.*29.*October.*2026/);
    expect(d.dayWords(EVENING, 'ta')).toMatch(/29/);
    expect(d.dayWords(EVENING, 'ta')).not.toBe(d.dayWords(EVENING, 'en'));
  });

  it('the zone is the one the store computer told the page; none (or a made-up name) is the shop default, never the device\'s', () => {
    expect(servedShopZone()).toBe(SHOP);
    (globalThis as { shopTimeZone?: unknown }).shopTimeZone = 'Asia/Dubai';
    expect(servedShopZone()).toBe('Asia/Dubai');
    expect(shopDay().zone).toBe('Asia/Dubai');
    (globalThis as { shopTimeZone?: unknown }).shopTimeZone = 'Mars/Olympus';
    expect(servedShopZone()).toBe(SHOP);
    expect(shopZoneOr(undefined)).toBe(SHOP);
    expect(shopZoneOr('America/New_York')).toBe('America/New_York');
  });

  it('with no moment given each reads the clock — pinned to the evening, the shop\'s date', () => {
    pin();
    expect(shopDay().today()).toBe(SHOP_DAY);
    expect(wasteToday()).toBe(SHOP_DAY);
  });
});

describe('the food-safety board and the task deadline (store-ops-session.ts)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('"today" on the board starts at the SHOP\'s midnight, and the default deadline is the end of the shop\'s today', () => {
    expect(startOfToday(new Date(EVENING), SHOP)).toBe('2026-10-28T18:30:00.000Z');
    expect(endOfTodayField(new Date(EVENING), SHOP)).toBe('2026-10-29T23:59');
    // Mid-afternoon in the shop it is still the same shop day.
    expect(startOfToday(new Date('2026-10-29T09:30:00.000Z'), SHOP)).toBe('2026-10-28T18:30:00.000Z');
  });

  it('a deadline typed in the field is the SHOP\'s wall clock; one that names its zone is kept', () => {
    expect(deadlineInstant('2026-10-29T23:59', SHOP)).toBe('2026-10-29T18:29:00.000Z');
    expect(deadlineInstant('2026-10-29T23:59:00Z', SHOP)).toBe('2026-10-29T23:59:00.000Z');
    expect(deadlineInstant('', SHOP)).toBe('');
  });

  it('the board asks head office from the shop\'s midnight; a task is sent with its shop-clock deadline and a shop-dated name', async () => {
    const sent: { path: string; body?: unknown }[] = [];
    const fetch = (async (path: string, init?: { body?: string }) => {
      sent.push({ path, ...(init?.body === undefined ? {} : { body: JSON.parse(init.body) as unknown }) });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof globalThis.fetch;
    const s = createStoreOpsSession({
      viewer: { userId: 'u-mgr', permissions: ['facilities.overdue.read', 'workforce.roster.manage'] }, fetch, timeZone: SHOP,
      now: () => new Date(EVENING), newKey: () => 'k',
    });
    await s.foodSafetyToday();
    expect(sent[0]!.path).toBe(`/v1/facilities/food-safety/status?from=${encodeURIComponent('2026-10-28T18:30:00.000Z')}`);
    const out = await s.assignTask({ branchId: 'br-1', title: 'Face up aisle 4', assignedTo: 'u-ravi', dueAt: '2026-10-29T23:59', critical: false, evidenceRequired: false, steps: '' });
    expect(out.result).toBe('ok');
    expect(sent[1]!.path).toMatch(/^\/v1\/hr\/workforce\/assigned-tasks\/task-20261029-/);
    expect(sent[1]!.body).toMatchObject({ dueAt: '2026-10-29T18:29:00.000Z' });
    expect(await s.assignTask({ branchId: 'br-1', title: 'x', assignedTo: 'u', dueAt: 'tomorrow', critical: false, evidenceRequired: false, steps: '' })).toEqual({ result: 'invalid', why: 'needAll' });
  });
});

describe('the other screens that took the device\'s date', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('migration: retirement is judged on the shop\'s today (retention ends on the 29th — elapsed at 01:00 shop time)', () => {
    const config: MigrationConfig = { tenantId: 't-sre', userId: 'u-owner', now: EVENING, cutoverId: 'cut-1', requiredCleanDays: 3, loadOperator: 'u-eng', cutoverAccepted: true };
    const archive = { archiveId: 'AR-1', tenantId: 't-sre', sourceId: 'S-1', digest: 'abc', rowCount: 1, archivedAt: '2026-09-11T00:00:00.000Z', retentionYears: 8, earliestRecordDate: '2014-04-01', latestRecordDate: '2018-10-29', readOnly: true, restoreVerifiedAt: '2026-09-12T00:00:00.000Z' };
    const ports = { archive: () => archive, openAssessments: () => 0, outbox: () => new SyncOutbox() } as unknown as MigrationPorts;
    expect(createMigrationSession(config, ports).retirement()?.blockedBy).not.toContain('retention_not_elapsed');
    // A plain day handed to the page is the day itself.
    expect(createMigrationSession({ ...config, now: '2026-10-28' }, ports).retirement()?.blockedBy).toContain('retention_not_elapsed');
  });

  it('count plans and incidents: a new record\'s name carries the shop\'s date', async () => {
    pin();
    const sent: string[] = [];
    const answer: HttpAnswer = { result: 'ok', status: 200, body: {} };
    const http: HeadOfficeHttp = { get: async (p) => { sent.push(p); return answer; }, post: async (p) => { sent.push(p); return answer; } };
    const plans = createCountPlansSession({ userId: 'u-mgr', permissions: ['inventory.count.plan'] }, http);
    const made = await plans.create({ locationId: 'br-1', productsText: 'P1', thresholdRupees: '20', freeze: 'default', kinds: [], note: '' });
    expect(made.result === 'ok' ? made.planId : '').toMatch(/^cp-20261029-/);
    const paths: string[] = [];
    const fetch = (async (path: string) => { paths.push(path); return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }); }) as unknown as typeof globalThis.fetch;
    const incidents = createIncidentsSession({ viewer: { userId: 'u-owner', permissions: [] }, fetch, newKey: () => 'k' });
    const opened = await incidents.openIncident({ title: 'Sync stopped', severity: 'sev2', summary: 'S1 silent' });
    expect(opened.result === 'ok' ? opened.value.incidentId : '').toMatch(/^inc-20261029-/);
  });

  it('the B2B desk asks for the ageing as at the shop\'s today', async () => {
    pin();
    const paths: string[] = [];
    const fetch = (async (path: string) => { paths.push(path); return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }); }) as unknown as typeof globalThis.fetch;
    const desk = createB2BDeskSession({ viewer: { userId: 'u-acc', permissions: ['b2b.receivable.record'] }, fetch, newKey: () => 'k' });
    await desk.readAgeing('c-caterer');
    expect(paths[0]).toBe(`/v1/b2b/collections/c-caterer/ageing?asOf=${SHOP_DAY}`);
  });

  it('the customer\'s privacy request names the shop\'s date it must be answered by', () => {
    const raised = raiseRequest({ requestId: 'DSR-1', tenantId: 't1', customerRef: 'c1', kind: 'access', at: EVENING, slaDays: 1 });
    expect(raised.tellTheCustomer).toContain('answer by 2026-10-30.'); // 19:30 UTC on the 29th is the 30th in the shop
  });

  it('the B2B portal judges "overdue" by the shop\'s date of the reading', () => {
    const data = { account: null, invoices: [{ invoiceId: 'inv-1', number: 'INV-1', issuedOn: '2026-10-01', dueOn: '2026-10-28', grossMinor: 100, settledMinor: 0, outstandingMinor: 100, disputed: false }], statement: null, documents: [], refusals: {}, asAt: EVENING } as unknown as B2BPortalData;
    const view = createB2BPortalSession({ userId: 'u-caterer' }, { portal: () => data, mayRead: () => true }).view('en');
    expect(view.invoices[0]!.status.tone).toBe('error'); // due on the 28th; it is the 29th in the shop
  });

  it('lane health: a lane\'s last report and the box\'s last send are read on the shop\'s clock from the signed pack', () => {
    const outbox = { pending: () => [] };
    const input = (pack: unknown) => ({ outbox, ownLaneId: 'lane-1', peripheralReports: [{ laneId: 'lane-1', reportedBy: 'u', reportedAt: EVENING, devices: [] }], laneLink: { lastSentAt: EVENING }, pack }) as unknown as ScreenInput;
    const kolkata = laneHealth(input({ policies: { known: true, value: { tradingDayCutoff: '00:00', timeZone: SHOP } } }))!;
    expect([kolkata[0]!.lastReportShop, kolkata[0]!.boxLastSentShop]).toEqual(['2026-10-29T01:00', '2026-10-29T01:00']);
    const dubai = laneHealth(input({ policies: { known: true, value: { tradingDayCutoff: '00:00', timeZone: 'Asia/Dubai' } } }))!;
    expect(dubai[0]!.lastReportShop).toBe('2026-10-28T23:30');
    // A box with no pack yet: the shop default — never the machine's zone.
    expect(laneHealth(input(undefined))![0]!.lastReportShop).toBe('2026-10-29T01:00');
  });

  it('the till\'s concession tag page: the shop\'s date from the zone the store computer told it, offline', () => {
    expect(tillShopDate(EVENING, 'Asia/Kolkata')).toBe(SHOP_DAY);
    expect(tillShopDate(Date.parse(EVENING), 'Asia/Kolkata')).toBe(SHOP_DAY);
    expect(tillShopDate(EVENING, 'nowhere')).toBe(SHOP_DAY); // an unknown name is the shop default, never the device's
    expect(tillShopZone({ shopTimeZone: 'Asia/Dubai' })).toBe('Asia/Dubai');
    expect(tillShopZone({ posLane: { timeZone: 'Asia/Dubai' } })).toBe('Asia/Dubai');
    expect(tillShopZone({})).toBe('Asia/Kolkata');
    expect(tillShopZone(undefined)).toBe('Asia/Kolkata');
  });
});
