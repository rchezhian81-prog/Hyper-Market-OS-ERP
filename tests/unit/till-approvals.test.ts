import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TillOperators, TILL_AUTHORITY } from '../../edge/store-edge/src/till-operators';
import { TillApprovals, approvalSubjectOf, APPROVAL_AUTHORITY, APPROVAL_MINUTES } from '../../edge/store-edge/src/till-approvals';
import { issueTillCredential, tillPinKey, type TillCredential } from '../../packages/identity/src/till-pin';
import { testPin } from '../support/till-operator';

/**
 * **A manager's approval at the till is the manager's own act, bound to one refund, used once (ADR-0021 · audit PF-02).**
 *
 * Before this, whatever staff code was typed as "manager" went onto the refund. These drive the store computer's approval
 * register: the manager's own PIN through the same check (and the same guess limits) as sign-in; never the person at the
 * till; only a manager with `pos.return.approve`; an approval bound to the kind, bill, amount, cashier and till, five
 * minutes, spent once by the refund it was for; a typed approver with nothing behind it refused; a restart keeps it all.
 */

const KEY = tillPinKey(['till', 'approvals', 'unit', 'key'].join('-').padEnd(48, '0'));
const PIN = { meena: testPin(11), ravi: testPin(22), mgr: testPin(33) };
const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

interface World { now: string; permissions: Record<string, string[]>; threshold: number | null }
const world = (): World => ({
  now: '2026-10-06T10:00:00.000Z',
  permissions: { 'u-meena': [TILL_AUTHORITY], 'u-ravi': [TILL_AUTHORITY], 'u-mgr': [TILL_AUTHORITY, APPROVAL_AUTHORITY] },
  threshold: 10_000,
});
const credentials = new Map<string, TillCredential>([
  ['u-meena', issueTillCredential({ userId: 'u-meena', pin: PIN.meena, key: KEY, issuedAt: '2026-10-06T07:00:00.000Z', issuedBy: 'Store admin' })],
  ['u-ravi', issueTillCredential({ userId: 'u-ravi', pin: PIN.ravi, key: KEY, issuedAt: '2026-10-06T07:00:00.000Z', issuedBy: 'Store admin' })],
  ['u-mgr', issueTillCredential({ userId: 'u-mgr', pin: PIN.mgr, key: KEY, issuedAt: '2026-10-06T07:00:00.000Z', issuedBy: 'Store admin' })],
]);

const open = async (w: World, dir?: string) => {
  const d = dir ?? await mkdtemp(join(tmpdir(), 'sre-till-approvals-'));
  if (dir === undefined) dirs.push(d);
  const operators = await TillOperators.open({
    dataDir: d, capacityBytes: 10_485_760, key: KEY, credentials: async () => credentials,
    pack: {
      people: () => [{ userId: 'u-meena', displayName: 'Meena' }, { userId: 'u-ravi', displayName: 'Ravi' }, { userId: 'u-mgr', displayName: 'Manager' }],
      permissionsOf: (u) => w.permissions[u] ?? [],
    },
    now: () => w.now,
  });
  const approvals = await TillApprovals.open({ dataDir: d, capacityBytes: 10_485_760, operators, approvalThresholdMinor: () => w.threshold, now: () => w.now });
  return { operators, approvals, dir: d };
};
const signIn = async (operators: TillOperators, who: 'u-meena' | 'u-ravi' | 'u-mgr', laneId = 'lane-1'): Promise<string> => {
  const out = await operators.signIn({ staffId: who, pin: PIN[who === 'u-meena' ? 'meena' : who === 'u-ravi' ? 'ravi' : 'mgr'], laneId });
  if (!out.signedIn) throw new Error(out.laneMessage);
  return out.token;
};
const later = (w: World, minutes: number) => { w.now = new Date(Date.parse(w.now) + minutes * 60_000).toISOString(); };
const refundRecord = (over: Record<string, unknown> = {}) => ({
  returnId: 'RT-1', originalSaleId: 'S-1', noReceipt: false, processedBy: 'u-meena', refundMinor: 25_000, refundTender: 'cash', ...over,
});

describe('giving an approval', () => {
  it('the manager\'s own PIN, for exactly this kind, bill and amount — the box issues a five-minute approval', async () => {
    const w = world();
    const { operators, approvals } = await open(w);
    const token = await signIn(operators, 'u-meena');
    const out = await approvals.grant({ token, laneId: 'lane-1', managerId: 'u-mgr', pin: PIN.mgr, kind: 'refund', billRef: 'S-1', valueMinor: 25_000, reason: 'damaged' });
    expect(out).toMatchObject({ approved: true, approvedBy: 'u-mgr', displayName: 'Manager', expiresAt: '2026-10-06T10:05:00.000Z' });
    if (!out.approved) throw new Error('refused');
    expect(out.approvalId).toMatch(/^apr-[0-9a-f]{24}$/);
    expect(APPROVAL_MINUTES).toBe(5);
  });

  it('is refused with nobody signed in at the till, to the cashier themselves, to a wrong PIN, and to someone without approval authority', async () => {
    const w = world();
    const { operators, approvals } = await open(w);
    const ask = (token: string | undefined, managerId: string, pin: string) => approvals.grant({ token, laneId: 'lane-1', managerId, pin, kind: 'refund', billRef: 'S-1', valueMinor: 25_000, reason: 'damaged' });
    expect(await ask(undefined, 'u-mgr', PIN.mgr)).toMatchObject({ approved: false, refusedBecause: 'operator_not_signed_in' });
    const token = await signIn(operators, 'u-meena');
    expect(await ask(token, 'u-meena', PIN.meena)).toMatchObject({ approved: false, refusedBecause: 'self_approval' });
    expect(await ask(token, 'u-mgr', PIN.ravi)).toMatchObject({ approved: false, refusedBecause: 'wrong_staff_id_or_pin' });
    expect(await ask(token, 'u-ravi', PIN.ravi)).toMatchObject({ approved: false, refusedBecause: 'no_approval_authority', laneMessage: expect.stringMatching(/not allowed to approve refunds/) });
  });

  it('shares sign-in\'s guess limits: five wrong manager PINs lock that staff ID for sign-in too', async () => {
    const w = world();
    const { operators, approvals } = await open(w);
    const token = await signIn(operators, 'u-meena');
    for (let i = 0; i < 5; i += 1) await approvals.grant({ token, laneId: 'lane-1', managerId: 'u-mgr', pin: PIN.ravi, kind: 'refund', billRef: 'S-1', valueMinor: 25_000, reason: 'x' });
    expect(await approvals.grant({ token, laneId: 'lane-1', managerId: 'u-mgr', pin: PIN.mgr, kind: 'refund', billRef: 'S-1', valueMinor: 25_000, reason: 'x' })).toMatchObject({ approved: false, refusedBecause: 'locked' });
    expect(await operators.signIn({ staffId: 'u-mgr', pin: PIN.mgr, laneId: 'lane-1' })).toMatchObject({ signedIn: false, refusedBecause: 'locked' });
  });

  it('must say what it is for: the kind, the bill (except a no-receipt return), a positive amount and a reason', async () => {
    const w = world();
    const { operators, approvals } = await open(w);
    const token = await signIn(operators, 'u-meena');
    const base = { token, laneId: 'lane-1', managerId: 'u-mgr', pin: PIN.mgr, kind: 'refund', billRef: 'S-1', valueMinor: 25_000, reason: 'damaged' };
    for (const bad of [{ kind: 'gift' }, { billRef: '' }, { valueMinor: 0 }, { valueMinor: 1.5 }, { reason: '' }]) {
      expect(await approvals.grant({ ...base, ...bad }), JSON.stringify(bad)).toMatchObject({ approved: false, refusedBecause: 'approval_not_readable' });
    }
    expect(await approvals.grant({ ...base, kind: 'no_receipt_return', billRef: undefined })).toMatchObject({ approved: true });
  });
});

describe('spending it, at the disk', () => {
  it('a refund that needs one and carries none — or carries only a typed name — is refused', async () => {
    const w = world();
    const { approvals } = await open(w);
    expect(await approvals.checkReturn({ record: refundRecord(), requestedBy: 'u-meena', laneId: 'lane-1', returnId: 'RT-1' })).toMatchObject({ ok: false, refusedBecause: 'approval_required' });
    expect(await approvals.checkReturn({ record: refundRecord({ approvedBy: 'u-mgr' }), requestedBy: 'u-meena', laneId: 'lane-1', returnId: 'RT-1' })).toMatchObject({ ok: false, refusedBecause: 'approval_required' });
    // Under the shop's threshold no manager is needed; a no-receipt return always needs one.
    expect(await approvals.checkReturn({ record: refundRecord({ refundMinor: 5_000 }), requestedBy: 'u-meena', laneId: 'lane-1', returnId: 'RT-1' })).toEqual({ ok: true });
    expect(await approvals.checkReturn({ record: refundRecord({ refundMinor: 5_000, noReceipt: true, originalSaleId: null }), requestedBy: 'u-meena', laneId: 'lane-1', returnId: 'RT-1' })).toMatchObject({ ok: false, refusedBecause: 'approval_required' });
  });

  it('a box with no service policy treats every refund as needing a manager, as the till does', async () => {
    const w = world();
    w.threshold = null;
    const { approvals } = await open(w);
    expect(await approvals.checkReturn({ record: refundRecord({ refundMinor: 1 }), requestedBy: 'u-meena', laneId: 'lane-1', returnId: 'RT-1' })).toMatchObject({ ok: false, refusedBecause: 'approval_required' });
  });

  it('spends a matching approval once: the same refund re-sent is the same use; another refund is refused', async () => {
    const w = world();
    const { operators, approvals } = await open(w);
    const token = await signIn(operators, 'u-meena');
    const out = await approvals.grant({ token, laneId: 'lane-1', managerId: 'u-mgr', pin: PIN.mgr, kind: 'refund', billRef: 'S-1', valueMinor: 25_000, reason: 'damaged' });
    if (!out.approved) throw new Error('refused');
    const rec = refundRecord({ approvalId: out.approvalId, approvedBy: 'u-mgr' });
    expect(await approvals.checkReturn({ record: rec, requestedBy: 'u-meena', laneId: 'lane-1', returnId: 'RT-1' })).toEqual({ ok: true, stamp: { approvalId: out.approvalId, approvedBy: 'u-mgr' } });
    expect(await approvals.checkReturn({ record: rec, requestedBy: 'u-meena', laneId: 'lane-1', returnId: 'RT-1' })).toMatchObject({ ok: true });
    expect(await approvals.checkReturn({ record: { ...rec, returnId: 'RT-2' }, requestedBy: 'u-meena', laneId: 'lane-1', returnId: 'RT-2' })).toMatchObject({ ok: false, refusedBecause: 'approval_already_used' });
  });

  it('is bound: another bill, amount, kind, cashier, till or approver name — and an unknown id — is refused', async () => {
    const w = world();
    const { operators, approvals } = await open(w);
    const token = await signIn(operators, 'u-meena');
    const out = await approvals.grant({ token, laneId: 'lane-1', managerId: 'u-mgr', pin: PIN.mgr, kind: 'refund', billRef: 'S-1', valueMinor: 25_000, reason: 'damaged' });
    if (!out.approved) throw new Error('refused');
    const rec = refundRecord({ approvalId: out.approvalId });
    const check = (record: Record<string, unknown>, requestedBy = 'u-meena', laneId = 'lane-1') => approvals.checkReturn({ record, requestedBy, laneId, returnId: 'RT-1' });
    expect(await check({ ...rec, originalSaleId: 'S-2' })).toMatchObject({ refusedBecause: 'approval_does_not_match' });
    expect(await check({ ...rec, refundMinor: 25_001 })).toMatchObject({ refusedBecause: 'approval_does_not_match' });
    expect(await check({ ...rec, noReceipt: true })).toMatchObject({ refusedBecause: 'approval_does_not_match' });
    expect(await check(rec, 'u-ravi')).toMatchObject({ refusedBecause: 'approval_does_not_match' });
    expect(await check(rec, 'u-meena', 'lane-2')).toMatchObject({ refusedBecause: 'approval_does_not_match' });
    expect(await check({ ...rec, approvedBy: 'u-owner' })).toMatchObject({ refusedBecause: 'approval_does_not_match' });
    expect(await check({ ...rec, approvalId: 'apr-000000000000000000000000' })).toMatchObject({ refusedBecause: 'approval_unknown' });
    // None of those spent it: the right refund still goes through.
    expect(await check(rec)).toMatchObject({ ok: true });
  });

  it('expires after five minutes unused', async () => {
    const w = world();
    const { operators, approvals } = await open(w);
    const token = await signIn(operators, 'u-meena');
    const out = await approvals.grant({ token, laneId: 'lane-1', managerId: 'u-mgr', pin: PIN.mgr, kind: 'refund', billRef: 'S-1', valueMinor: 25_000, reason: 'damaged' });
    if (!out.approved) throw new Error('refused');
    later(w, 6);
    expect(await approvals.checkReturn({ record: refundRecord({ approvalId: out.approvalId }), requestedBy: 'u-meena', laneId: 'lane-1', returnId: 'RT-1' })).toMatchObject({ ok: false, refusedBecause: 'approval_expired' });
  });

  it('an exchange is approved for its refunded DIFFERENCE, not the goods coming back; an even exchange needs nobody', () => {
    expect(approvalSubjectOf({ refundTender: 'exchange', originalSaleId: 'S-2', refundMinor: 64_000, exchange: { balance: 'refund', balanceMinor: 4_000 } }, 0))
      .toEqual({ subject: { kind: 'exchange_refund', billRef: 'S-2', valueMinor: 4_000 }, required: true });
    expect(approvalSubjectOf({ refundTender: 'exchange', originalSaleId: 'S-2', refundMinor: 64_000, exchange: { balance: 'top_up', balanceMinor: 6_000 } }, 0))
      .toEqual({ subject: null, required: false });
  });

  it('a restart forgets nothing: a spent approval stays spent; the log holds no PIN', async () => {
    const w = world();
    const first = await open(w);
    const token = await signIn(first.operators, 'u-meena');
    const out = await first.approvals.grant({ token, laneId: 'lane-1', managerId: 'u-mgr', pin: PIN.mgr, kind: 'refund', billRef: 'S-1', valueMinor: 25_000, reason: 'damaged' });
    if (!out.approved) throw new Error('refused');
    await first.approvals.checkReturn({ record: refundRecord({ approvalId: out.approvalId }), requestedBy: 'u-meena', laneId: 'lane-1', returnId: 'RT-1' });
    const again = await open(w, first.dir);
    expect(await again.approvals.checkReturn({ record: refundRecord({ approvalId: out.approvalId, returnId: 'RT-2' }), requestedBy: 'u-meena', laneId: 'lane-1', returnId: 'RT-2' })).toMatchObject({ refusedBecause: 'approval_already_used' });
    expect(again.approvals.unreadableRecords).toBe(0);
    const log = await readFile(join(first.dir, 'till-approvals.log'), 'utf8');
    expect(log).toContain('granted');
    expect(log).toContain('used');
    expect(log).not.toContain(PIN.mgr);
  });
});
