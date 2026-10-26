import { describe, it, expect } from 'vitest';
import {
  createPayrollLiveSession, payrollLiveOutcome, payrollLiveWords, payRunRows, holdWords, rupees, PAYROLL_LIVE_COPY,
} from '../../apps/web-erp/src/payroll-live-session';
import { servedByStoreComputer, payrollLiveKit, loadSetupLive, SETUP_LIVE_WORDS } from '../../apps/web-erp/src/browser-entry';
import { headOfficePagePayload } from '../../edge/store-edge/src/head-office-pages';

/**
 * **Payroll, My payslip and Store setup as the STORE COMPUTER serves them (OB-380 · OB-209 · OB-228 · P-04 · P-08).**
 *
 * The box carries only who is looking for these pages. Before OB-380 the payroll pages, with nothing injected, showed a
 * stamped DEMO — and with only an identity they would have shown an empty run reading "no run drafted, ₹0.00", which is
 * not head office's answer. Store setup showed its sample. Proven here, against a stand-in for head office:
 *   • the pages know they were served by the box (and only then switch to the live view);
 *   • Payroll reads only: the pay-release switch and one pay run by its number — GET, and nothing else; a person nobody
 *     named, or a role without the payroll read, reads nothing; a malformed number is refused before any call;
 *   • My payslip reads the person's OWN payslip through the self-scoped route only; "none issued" is head office's answer;
 *   • unreachable → "nothing was read, nothing shown is current"; refused → head office's words; a missing run → its words;
 *   • Store setup reads head office's setup before it draws anything; unreachable or refused → no setting at all.
 * English and Tamil. Synthetic data only.
 */

interface Call { readonly url: string; readonly method: string }
function headOffice(answer: (url: string) => { status: number; body: unknown } | 'throw'): { fetch: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET' });
    const a = answer(url);
    if (a === 'throw') throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}
const RUN = { payRunId: 'PR-2026-10', payPeriod: '2026-10', state: 'submitted', submittedBy: 'u-hr', netTotalMinor: 4_63_000_00, employeeCount: 23, detail: 'submitted' };
const HOLD = { on: false, state: 'Pay release is switched OFF: approving or locking a pay run and building the salary bank file are refused until the owner switches release on.', setBy: null, setAt: null, reason: null };
const OWN = { issued: true, period: '2026-09', view: { employeeId: 'u-staff', payPeriod: '2026-09-30', earnings: [{ code: 'BASIC', amountMinor: 20_000_00 }], grossMinor: 20_000_00, deductions: [], totalDeductionsMinor: 0, netPayMinor: 20_000_00, employerContributions: { note: 'n', totalMinor: 0, lines: [] }, confirmWithCa: true } };
const answers = (url: string) => (url === '/v1/hr/payroll/release-switch' ? { status: 200, body: HOLD }
  : url === '/v1/hr/payroll/pay-run/PR-2026-10' ? { status: 200, body: RUN }
    : url === '/v1/hr/payroll/my-payslip' ? { status: 200, body: OWN }
      : { status: 404, body: { error: { code: 'not_found', whatHappened: 'Not found: a pay run X.' } } });
const accountant = { userId: 'u-acct', permissions: ['payroll.statutory.read'] };

describe('the box tells these pages they are its own, and nothing more', () => {
  it('the payload is identity only, marked as served by the store computer', () => {
    expect(headOfficePagePayload()).toEqual({ permissions: [], servedBy: 'store_computer' });
    expect(servedByStoreComputer(headOfficePagePayload())).toBe(true);
    expect(servedByStoreComputer({ permissions: [], servedBy: 'head_office' })).toBe(false);
    expect(servedByStoreComputer(undefined)).toBe(false);
    expect(servedByStoreComputer([])).toBe(false);
    const kit = payrollLiveKit({ ...headOfficePagePayload(), userId: 'u-acct', permissions: ['payroll.statutory.read'] });
    expect(kit.session.may).toEqual({ named: true, readRun: true, readOwn: false });
  });
});

describe('Payroll on the box: read only', () => {
  it('reads the switch and one pay run by number — GET only, the two routes only', async () => {
    const ho = headOffice(answers);
    const s = createPayrollLiveSession({ viewer: accountant, fetch: ho.fetch });
    expect(await s.readHold()).toEqual({ result: 'ok', value: HOLD });
    expect(await s.readRun(' PR-2026-10 ')).toEqual({ result: 'ok', value: RUN });
    expect(ho.calls).toEqual([{ url: '/v1/hr/payroll/release-switch', method: 'GET' }, { url: '/v1/hr/payroll/pay-run/PR-2026-10', method: 'GET' }]);
    expect(Object.keys(s).sort(), 'the session offers reads and nothing else').toEqual(['may', 'readHold', 'readOwn', 'readRun']);
  });

  it('nobody named, or a role without the payroll read, reads nothing; a malformed number is refused before any call', async () => {
    const ho = headOffice(answers);
    const nobody = createPayrollLiveSession({ viewer: { permissions: ['payroll.statutory.read'] }, fetch: ho.fetch });
    expect(await nobody.readHold()).toEqual({ result: 'invalid', why: 'nobody' });
    expect(await nobody.readRun('PR-2026-10')).toEqual({ result: 'invalid', why: 'nobody' });
    const cashier = createPayrollLiveSession({ viewer: { userId: 'u-cash', permissions: ['payroll.ess.self'] }, fetch: ho.fetch });
    expect(await cashier.readHold()).toEqual({ result: 'invalid', why: 'cannotRead' });
    expect(await cashier.readRun('PR-2026-10')).toEqual({ result: 'invalid', why: 'cannotRead' });
    const s = createPayrollLiveSession({ viewer: accountant, fetch: ho.fetch });
    for (const bad of ['', '   ', '../hr/payroll/bank-file', 'PR 1', 'x'.repeat(65)]) expect(await s.readRun(bad), bad).toEqual({ result: 'invalid', why: 'noRunNumber' });
    expect(ho.calls).toEqual([]);
  });

  it('head office unreachable, refusing, or holding no such run — each said in words', async () => {
    const down = createPayrollLiveSession({ viewer: accountant, fetch: headOffice(() => 'throw').fetch });
    const lost = await down.readHold();
    expect(lost).toEqual({ result: 'lost_link' });
    expect(payrollLiveOutcome('en', lost)).toBe('Head office cannot be reached — nothing was read, and nothing shown is current.');
    expect(payrollLiveOutcome('ta', lost)).toMatch(/தலைமை அலுவலகத்தை அடைய முடியவில்லை/);
    const s = createPayrollLiveSession({ viewer: accountant, fetch: headOffice(answers).fetch });
    expect(payrollLiveOutcome('en', await s.readRun('PR-NONE'))).toBe('Head office has no pay run with that number.');
    const refusing = createPayrollLiveSession({ viewer: accountant, fetch: headOffice(() => ({ status: 403, body: { error: { code: 'forbidden', whatHappened: 'Not your branch.' } } })).fetch });
    expect(payrollLiveOutcome('en', await refusing.readHold())).toBe('Head office refused: Not your branch.');
    expect(payrollLiveOutcome('en', { result: 'invalid', why: 'noRunNumber' })).toBe('Type the pay run number head office gave it.');
  });

  it('a pay run reads as words; a fact head office did not give is "not given", never a zero', () => {
    expect(payRunRows('en', RUN as never)).toEqual([
      { label: 'Month', value: '2026-10' }, { label: 'Stage', value: 'Awaiting approval' }, { label: 'Submitted by', value: 'u-hr' },
      { label: 'Approved by', value: 'not given' }, { label: 'People paid', value: '23' }, { label: 'Net pay, all staff', value: '₹4,63,000.00' },
    ]);
    const bare = payRunRows('en', { payRunId: 'P', payPeriod: '2026-10', state: 'draft', detail: '' });
    expect(bare.find((r) => r.label === 'People paid')?.value).toBe('not given');
    expect(bare.find((r) => r.label === 'Net pay, all staff')?.value).toBe('not given');
    expect(payRunRows('ta', RUN as never)[1]).toEqual({ label: 'நிலை', value: 'அனுமதிக்காகக் காத்திருக்கிறது' });
    const locked = payRunRows('en', { ...RUN, state: 'reversed', lockedAt: '2026-10-31T10:00:00.000Z', reversedReason: 'wrong PF rate' } as never);
    expect(locked.slice(-2)).toEqual([{ label: 'Locked at', value: '2026-10-31T10:00:00.000Z' }, { label: 'Reversed because', value: 'wrong PF rate' }]);
    expect(rupees(-500_00)).toBe('-₹500.00');
  });

  it('the switch is said as head office says it: held while off (OB-228), with who set it and why when it was set', () => {
    expect(holdWords('en', HOLD)).toEqual({ headline: 'Pay release: Held — switched off', detail: HOLD.state, on: false });
    const on = holdWords('en', { on: true, state: 'Pay release is switched ON by the owner.', setBy: 'u-owner', setAt: '2026-11-01T09:00:00.000Z', reason: 'GO in writing' });
    expect(on.headline).toBe('Pay release: Switched on by the owner');
    expect(on.detail).toBe('Pay release is switched ON by the owner. Set by: u-owner · 2026-11-01T09:00:00.000Z · Why: GO in writing');
    expect(holdWords('ta', HOLD).headline).toBe('சம்பள வெளியீடு: நிறுத்தி வைக்கப்பட்டுள்ளது — அணைக்கப்பட்டது');
  });
});

describe('My payslip on the box: the person\'s own, read only', () => {
  it('reads the self-scoped route only; a role without the self-service word reads nothing', async () => {
    const ho = headOffice(answers);
    const s = createPayrollLiveSession({ viewer: { userId: 'u-staff', permissions: ['payroll.ess.self'] }, fetch: ho.fetch });
    expect(await s.readOwn()).toEqual({ result: 'ok', value: OWN });
    expect(ho.calls).toEqual([{ url: '/v1/hr/payroll/my-payslip', method: 'GET' }]);
    const other = createPayrollLiveSession({ viewer: { userId: 'u-x', permissions: [] }, fetch: ho.fetch });
    expect(await other.readOwn()).toEqual({ result: 'invalid', why: 'cannotReadOwn' });
    expect(payrollLiveWords('en', 'noneIssued')).toBe('Head office has not issued you a payslip yet.');
  });
});

describe('the words', () => {
  it('every English word has a Tamil twin in Tamil script', () => {
    const en = Object.keys(PAYROLL_LIVE_COPY.en).sort();
    expect(Object.keys(PAYROLL_LIVE_COPY.ta).sort()).toEqual(en);
    for (const k of en) expect((PAYROLL_LIVE_COPY.ta as Record<string, string>)[k], k).toMatch(/[஀-௿]/);
    for (const k of Object.keys(SETUP_LIVE_WORDS.en)) expect((SETUP_LIVE_WORDS.ta as Record<string, string>)[k], k).toMatch(/[஀-௿]/);
  });
});

describe('Store setup on the box: head office\'s setup before anything is drawn', () => {
  const STATUS = { ready: false, items: [{ key: 'tax.default_bps', label: 'Default GST rate', question: 'What default GST rate?', required: true, state: 'blocking', value: 500, isDefault: false, version: 3, group: 'give_now' }], groups: [] };
  it('reads the setup and the till prefixes in the person\'s session, and builds the page from head office\'s answer', async () => {
    const ho = headOffice((url) => (url === '/v1/platform/setup' ? { status: 200, body: STATUS } : { status: 200, body: { tills: [], stores: [] } }));
    const out = await loadSetupLive({ ...headOfficePagePayload(), userId: 'u-owner', permissions: ['platform.setup.read'] }, ho.fetch);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data).toMatchObject({ userId: 'u-owner', status: STATUS });
    expect(ho.calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET /v1/platform/setup', 'GET /v1/receipt-prefixes']);
  });

  it('nobody named, unreachable, or refused: nothing to draw — said, never a sample', async () => {
    expect(await loadSetupLive({ permissions: [] }, headOffice(() => ({ status: 200, body: STATUS })).fetch)).toEqual({ ok: false, why: 'nobody' });
    expect(await loadSetupLive({ userId: 'u', permissions: [] }, headOffice(() => 'throw').fetch)).toEqual({ ok: false, why: 'unreachable' });
    expect(await loadSetupLive({ userId: 'u', permissions: [] }, headOffice(() => ({ status: 403, body: { error: { whatHappened: 'Your role cannot read the setup.' } } })).fetch))
      .toEqual({ ok: false, why: 'refused', detail: 'Your role cannot read the setup.' });
    expect(SETUP_LIVE_WORDS.en.unreachable).toBe('Head office cannot be reached — no setting is shown, because none of it would be current.');
  });

  it('a prefix list head office would not give leaves the panel out — never an empty "no tills"', async () => {
    const ho = headOffice((url) => (url === '/v1/platform/setup' ? { status: 200, body: STATUS } : 'throw'));
    const out = await loadSetupLive({ userId: 'u-owner', permissions: [] }, ho.fetch);
    expect(out.ok && out.prefixes).toBe(null);
    expect(out.ok && out.data.receiptPrefixes).toBeUndefined();
  });
});
