import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM } from '../../services/api/src/adapters';
import { createFindingsSession, findingsWords, flagWords, shopMomentOf, FINDINGS_COPY, ATTENDANCE_FLAGS } from '../../apps/web-erp/src/findings-session';
import { ERP_NAVIGATION } from '../../apps/web-erp/src/navigation';
import { HEAD_OFFICE_PAGE_SCREENS } from '../../edge/store-edge/src/head-office-pages';

// OB-609 (owner, 29 Oct 2026) · P-03 · P-08 · M29-FR-03 · M25-FR-01: the Bill findings and attendance flags page reads what head
// office already kept and no screen showed. Driven here against head office's REAL routes (the pipeline, its permission
// checks and its pairing rule), the page's session calling them as the signed-in person.

const T = randomUUID();
const OWNER = 'u-owner'; const MGR = 'u-mgr'; const CASHIER = 'u-cash'; const ANU = 'u-anu'; const RAVI = 'u-ravi';
const STORE = 'S1';
const DAY = '2026-10-28';
const at = (hhmm: string): string => new Date(Date.parse(`${DAY}T${hhmm}:00+05:30`)).toISOString();

let h: ApiHarness;
/** The page's fetch: every same-origin call reaches head office as `who`. */
const fetchAs = (who: string): typeof globalThis.fetch => (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input), 'http://box.local');
  const res = await h.request({
    method: (init?.method ?? 'GET') as 'GET', path: url.pathname, userId: who, tenantId: T, ...(who === OWNER ? {} : { branchId: STORE }),
    ...(url.search === '' ? {} : { query: Object.fromEntries(url.searchParams) }),
  });
  return new Response(JSON.stringify(res.body ?? {}), { status: res.status, headers: { 'content-type': 'application/json' } });
}) as typeof globalThis.fetch;
const sessionAs = (who: string, permissions: string[]) => createFindingsSession({ viewer: { userId: who, permissions }, fetch: fetchAs(who), now: () => at('12:00') });
const BOTH = ['pos.exception.read', 'workforce.roster.read'];

beforeAll(async () => {
  h = apiHarness();
  await h.seedOwner(T, OWNER);
  await h.provisionRole(T, MGR, 'store_manager', [STORE]);
  await h.provisionRole(T, CASHIER, 'cashier', [STORE]);
  for (const who of [ANU, RAVI]) await h.provisionRole(T, who, 'cashier', [STORE]);
  const post = async (path: string, body: unknown, as: string): Promise<void> => {
    const r = await h.request({ method: 'POST', path, userId: as, tenantId: T, branchId: STORE, idempotencyKey: `k-${randomUUID()}`, body });
    expect(r.status, `${path}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
  };
  await post(`/v1/hr/workforce/employees/${ANU}`, { name: 'Anu', branchId: STORE, roles: ['cashier'], active: true }, MGR);
  await post(`/v1/hr/workforce/employees/${RAVI}`, { name: 'Ravi', branchId: STORE, roles: ['cashier'], active: true }, MGR);
  // Anu marks in and out: a pair, no flag. Ravi marks only an "out": head office flags it.
  await post('/v1/hr/workforce/attendance-marks/m-anu-in', { employeeId: ANU, kind: 'in', method: 'pin', at: at('09:00') }, ANU);
  await post('/v1/hr/workforce/attendance-marks/m-anu-out', { employeeId: ANU, kind: 'out', method: 'pin', at: at('17:00') }, ANU);
  await post('/v1/hr/workforce/attendance-marks/m-ravi-out', { employeeId: RAVI, kind: 'out', method: 'pin', at: at('18:30') }, RAVI);
  // Head office's sale intake keeps its findings as SaleExceptionRaised events (services/api/src/adapters.ts).
  const raise = async (ex: Record<string, unknown>): Promise<void> => {
    await h.store.append(T, STREAM.saleExceptions, makeEvent({
      id: `saleex-${String(ex['saleId'])}-${String(ex['kind'])}`, type: 'SaleExceptionRaised', occurredAt: at('11:00'),
      idempotencyKey: `saleex-${T}-${String(ex['saleId'])}-${String(ex['kind'])}`, source: 'api/pos', payload: ex,
    }));
  };
  await raise({ kind: 'price_cut_above_approver_limit', severity: 'material', saleId: 'S-101', productId: 'p-ghee', differenceMinor: 6_000, detail: 'p-ghee was lowered at the till by ₹160.00 with u-mgr\'s approval; u-mgr\'s price-cut limit is ₹100.00', ownerAction: 'Ask the manager. The sale stands.' });
  await raise({ kind: 'sold_a_recalled_product', severity: 'critical', saleId: 'S-102', productId: 'p-milk', detail: 'p-milk is under recall and was sold', ownerAction: 'ACT NOW: contact the customer.' });
  await raise({ kind: 'price_differs_from_catalogue', severity: 'informational', saleId: 'S-103', productId: 'p-oil', differenceMinor: -2_000, detail: 'the price quotation Q-7 promised', ownerAction: 'Nothing to do.' });
});

describe('OB-609 — bill findings: what head office raised on till bills, critical first', () => {
  it('lists every critical and material finding with head office\'s own words; informational ones only as a count', async () => {
    const out = await sessionAs(MGR, BOTH).bills();
    expect(out.result).toBe('ok');
    if (out.result !== 'ok') return;
    expect([out.value.critical, out.value.material, out.value.informational]).toEqual([1, 1, 1]);
    expect(out.value.findings.map((f) => [f.severity, f.saleId, f.kind])).toEqual([
      ['critical', 'S-102', 'sold_a_recalled_product'],
      ['material', 'S-101', 'price_cut_above_approver_limit'],
    ]);
    expect(out.value.findings[1]).toMatchObject({ productId: 'p-ghee', differenceMinor: 6_000, ownerAction: 'Ask the manager. The sale stands.' });
  });

  it('a cashier is refused by head office, said in its words; the page offers nothing without the word', async () => {
    const refused = await sessionAs(CASHIER, BOTH).bills();
    expect(refused.result).toBe('refused');
    const none = await sessionAs(CASHIER, []).bills();
    expect(none).toEqual({ result: 'invalid', why: 'cannotSales' });
    expect(await createFindingsSession({ viewer: undefined }).bills()).toEqual({ result: 'invalid', why: 'nobody' });
  });
});

describe('OB-609 — attendance flags: the marks of a shop day that do not pair up', () => {
  it('shows only the flagged mark, with the person\'s name from the roster and head office\'s flag', async () => {
    const out = await sessionAs(MGR, BOTH).attendance(DAY);
    expect(out.result).toBe('ok');
    if (out.result !== 'ok') return;
    expect(out.value.marksRead).toBe(3);
    expect(out.value.flagged.map((m) => [m.name, m.kind, m.flags])).toEqual([['Ravi', 'out', ['out_without_in']]]);
  });

  it('a day with no marks has no flags; a missing day is refused before any call', async () => {
    const out = await sessionAs(MGR, BOTH).attendance('2026-10-01');
    expect(out).toEqual({ result: 'ok', value: { date: '2026-10-01', marksRead: 0, flagged: [] } });
    expect(await sessionAs(MGR, BOTH).attendance('')).toEqual({ result: 'invalid', why: 'needDay' });
    expect(await sessionAs(MGR, ['pos.exception.read']).attendance(DAY)).toEqual({ result: 'invalid', why: 'cannotAttendance' });
  });

  it('the shop\'s day and time, never the device\'s: 18:30 in the shop is 13:00 UTC', () => {
    expect(shopMomentOf(at('18:30'))).toBe('2026-10-28 18:30');
    expect(sessionAs(MGR, BOTH).today()).toBe(DAY);
  });
});

describe('OB-609 — the page is reachable and speaks both languages', () => {
  it('is in the Reports menu for either word, and the store computer serves it', () => {
    const item = ERP_NAVIGATION.find((i) => i.id === 'findings');
    expect(item).toMatchObject({ path: '/findings', requires: 'pos.exception.read', alsoOpenedWith: ['workforce.roster.read'], group: 'Reports' });
    expect(HEAD_OFFICE_PAGE_SCREENS).toContain('findings');
  });

  it('every word the page adds has a Tamil twin, and every flag has words in both languages', () => {
    expect(Object.keys(FINDINGS_COPY.ta).sort()).toEqual(Object.keys(FINDINGS_COPY.en).sort());
    for (const f of ATTENDANCE_FLAGS) {
      expect(flagWords('en', f)).not.toBe(f);
      expect(flagWords('ta', f)).not.toBe(flagWords('en', f));
    }
    expect(flagWords('en', 'a_new_flag')).toBe('a_new_flag');
    expect(findingsWords('ta', 'title')).toBe(FINDINGS_COPY.ta.title);
  });
});
