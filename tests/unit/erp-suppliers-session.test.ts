import { describe, it, expect } from 'vitest';
import {
  createSuppliersSession, SUPPLIERS_COPY, COPY_KEYS,
  type SuppliersData, type SuppliersPorts, type SupplierRowView, type SupplierApprovePort, type SupplierProposePort,
} from '../../apps/web-erp/src/suppliers-session';
import { bilingualGaps } from '../../packages/ui/src/index';

/**
 * SP-7d (M06-FR-01 · M23-FR-01 · §28 · P-02 · P-03 · P-08): the Suppliers screen's DOM-free session model. It orders
 * the list needing-a-person first, says every reason in words, shows the cloud's balance and never its own, offers the
 * two writes only where the reader holds the right AND the page can reach head office, and refuses a self-approval
 * before anything is sent. The ports are stubs; the real ones are proven in the browser e2e.
 */

const row = (over: Partial<SupplierRowView> = {}): SupplierRowView => ({
  supplierId: 's-1', name: 'Amma Traders', status: 'active', blocked: false, proposedBy: 'u-buyer', bankAccountRef: '****1234',
  owedMinor: 4000, withheldMinor: 0, paidMinor: 0, unmatchedInvoices: 0, blockedInvoices: 0, pendingReturns: 0, currency: 'INR',
  needsAttention: false, attention: [], ...over,
});

const DATA: SuppliersData = {
  asAt: '2026-09-30T10:00:00.000Z', owedMinor: 15_000,
  suppliers: [
    row(),                                                                                                             // clean
    row({ supplierId: 's-2', name: 'Kaveri Foods', status: 'proposed', owedMinor: 0, bankAccountRef: null, needsAttention: true, attention: ['awaiting_approval'] }),
    row({ supplierId: 's-3', name: 'Ghost & Co', status: 'proposed', proposedBy: 'u-acct', owedMinor: 0, bankAccountRef: null, needsAttention: true, attention: ['awaiting_approval', 'possible_duplicate'] }),
    row({ supplierId: 's-4', name: 'Blocked Bros', blocked: true, owedMinor: 9000, needsAttention: true, attention: ['blocked', 'withheld'], withheldMinor: 2000 }),
    row({ supplierId: 's-5', name: null, status: 'no_master_record', proposedBy: null, owedMinor: 2000, bankAccountRef: null, needsAttention: true, attention: ['no_master_record', 'no_verified_bank_account'] }),
  ],
};

interface Calls { approve: { supplierId: string; reason: string }[]; propose: unknown[] }
const ports = (over: Partial<SuppliersPorts> & { data?: SuppliersData; calls?: Calls } = {}): { ports: SuppliersPorts; calls: Calls } => {
  const calls: Calls = over.calls ?? { approve: [], propose: [] };
  const approvePort: SupplierApprovePort = { post: async (i) => { calls.approve.push(i); return { result: 'approved' }; } };
  const proposePort: SupplierProposePort = { post: async (i) => { calls.propose.push(i); return { result: 'proposed', possibleDuplicates: [] }; } };
  return {
    calls,
    ports: {
      snapshot: () => over.data ?? DATA,
      mayRead: () => true, mayPropose: () => true, mayApprove: () => true,
      approvePort: () => approvePort, proposePort: () => proposePort,
      ...over,
    },
  };
};

describe('the copy is complete in both languages', () => {
  it('has no gap in either language across the whole vocabulary', () => {
    const gaps = bilingualGaps(SUPPLIERS_COPY, COPY_KEYS);
    expect(gaps.en).toEqual([]);
    expect(gaps.ta).toEqual([]);
  });
});

describe('the list: needing a person first, every reason in words, the cloud\'s balance', () => {
  it('orders needing-attention first, a hold before the rest, then the most owed; the clean supplier is last', () => {
    const v = createSuppliersSession({ userId: 'u-acct' }, ports().ports).view('en');
    expect(v.screenState.tone).toBe('ok');
    // s-3 (Ghost & Co) before s-2 (Kaveri Foods): both need a person, neither is held, both owe nothing → by name.
    expect(v.suppliers.map((s) => s.supplierId)).toEqual(['s-4', 's-5', 's-3', 's-2', 's-1']);
    expect(v.count).toBe(5);
    expect(v.needingAttentionCount).toBe(4);
    // The cloud's total, not a re-addition of rows (the rows add to 15_000 here too, but the cloud's figure is the truth).
    expect(v.owedMinor).toBe(15_000);
    expect(v.asOf).toBe('2026-09-30T10:00:00.000Z');
  });

  it('each row reads as a state — tone AND icon AND word — with the reasons and the bank said in words', () => {
    const v = createSuppliersSession({ userId: 'u-acct' }, ports().ports).view('en');
    const blocked = v.suppliers[0]!;
    expect(blocked.status).toMatchObject({ tone: 'error', needsAttention: true });
    expect(blocked.status.icon.trim().length).toBeGreaterThan(0);
    expect(blocked.status.label).toBe('On hold — nothing is paid or ordered');
    expect(blocked.reasons.map((r) => r.label)).toEqual(['Under a hold', 'Money withheld on a bill']);
    const ghost = v.suppliers.find((s) => s.supplierId === 's-5')!;
    expect(ghost.headline).toBe('s-5'); // no name recorded — the code, never a blank
    expect(ghost.masterLabel).toBe('No supplier record yet');
    expect(ghost.bankLabel).toBe('No verified bank account');
    expect(ghost.reasons.map((r) => r.reason)).toEqual(['no_master_record', 'no_verified_bank_account']);
    const clean = v.suppliers.at(-1)!;
    expect(clean.status.tone).toBe('ok');
    expect(clean.bankLabel).toBe('Verified bank account ****1234');
    expect(clean.masterLabel).toBe('Approved supplier');
    // Tamil rides along for every word shown.
    const ta = createSuppliersSession({ userId: 'u-acct' }, ports().ports).view('ta');
    expect(ta.suppliers[0]!.status.label).toMatch(/[஀-௿]/);
    expect(ta.suppliers[0]!.reasons[0]!.label).toMatch(/[஀-௿]/);
  });

  it('not permitted → an error state and no rows; not yet told → empty; an empty list → "no supplier recorded" with the as-of', () => {
    const denied = createSuppliersSession({ userId: 'u-x' }, ports({ mayRead: () => false }).ports).view('en');
    expect(denied.screenState).toMatchObject({ tone: 'error', label: 'You do not have permission to see suppliers.' });
    expect(denied.suppliers).toEqual([]);
    expect(denied.canPropose).toBe(false);
    expect(denied.canApprove).toBe(false);
    const untold = createSuppliersSession({ userId: 'u-x' }, ports({ data: {} }).ports).view('en');
    expect(untold.screenState).toMatchObject({ tone: 'idle', label: 'This screen has not been given the supplier list yet.' });
    const empty = createSuppliersSession({ userId: 'u-x' }, ports({ data: { suppliers: [], asAt: '2026-09-30T10:00:00.000Z' } }).ports).view('en');
    expect(empty.screenState.label).toBe('No supplier is recorded yet.');
    expect(empty.asOf).toBe('2026-09-30T10:00:00.000Z');
  });
});

describe('approve — only where the reader holds the right, never their own proposal (§28)', () => {
  it('offers the approve action only to a holder with a link, and lists only the proposed suppliers they did not propose', () => {
    const acct = createSuppliersSession({ userId: 'u-acct' }, ports().ports).view('en');
    expect(acct.canApprove).toBe(true);
    // s-2 (proposed by u-buyer) is approvable; s-3 (proposed by u-acct) is theirs — a word on the row, not a button.
    expect(acct.approvable.map((s) => s.supplierId)).toEqual(['s-2']);
    expect(acct.suppliers.find((s) => s.supplierId === 's-3')).toMatchObject({ ownProposal: true, canApproveHere: false });
    expect(acct.suppliers.find((s) => s.supplierId === 's-1')).toMatchObject({ canApproveHere: false }); // active already
    const noRight = createSuppliersSession({ userId: 'u-mgr' }, ports({ mayApprove: () => false }).ports).view('en');
    expect(noRight.canApprove).toBe(false);
    expect(noRight.approvable).toEqual([]);
    const noLink = createSuppliersSession({ userId: 'u-acct' }, ports({ approvePort: () => null }).ports).view('en');
    expect(noLink.canApprove).toBe(false);
    const nobody = createSuppliersSession({ userId: null }, ports().ports).view('en');
    expect(nobody.canApprove).toBe(false);
    expect(nobody.nobodyNamed).toBe(true);
  });

  it('refuses a self-approval, a missing reason, a supplier not waiting, and a reader without the right — with NOTHING sent', async () => {
    const { ports: p, calls } = ports();
    const s = createSuppliersSession({ userId: 'u-acct' }, p);
    expect(await s.approve('s-3', 'checked the GSTIN')).toEqual({ outcome: 'self_approval' });
    expect(await s.approve('s-2', '   ')).toEqual({ outcome: 'needs_reason' });
    expect(await s.approve('s-1', 'why')).toEqual({ outcome: 'not_proposed' });
    expect(await s.approve('s-99', 'why')).toEqual({ outcome: 'not_proposed' });
    expect(calls.approve).toEqual([]);
    const denied = createSuppliersSession({ userId: 'u-mgr' }, ports({ mayApprove: () => false, calls }).ports);
    expect(await denied.approve('s-2', 'why')).toEqual({ outcome: 'not_permitted' });
    const unlinked = createSuppliersSession({ userId: 'u-acct' }, ports({ approvePort: () => null, calls }).ports);
    expect(await unlinked.approve('s-2', 'why')).toEqual({ outcome: 'no_link' });
    expect(calls.approve).toEqual([]);
  });

  it('posts a clean approval once with the trimmed reason, and carries the cloud\'s verdict back verbatim — never a fabricated "approved"', async () => {
    const { ports: p, calls } = ports();
    const s = createSuppliersSession({ userId: 'u-acct' }, p);
    expect(await s.approve('s-2', '  GSTIN and bank letter checked ')).toEqual({ outcome: 'approved' });
    expect(calls.approve).toEqual([{ supplierId: 's-2', reason: 'GSTIN and bank letter checked' }]);
    const refusing: SupplierApprovePort = { post: async () => ({ result: 'refused', reason: 'u-acct proposed this supplier and cannot also approve it' }) };
    const r = createSuppliersSession({ userId: 'u-acct' }, ports({ approvePort: () => refusing }).ports);
    const out = await r.approve('s-2', 'why');
    expect(out).toEqual({ outcome: 'refused', reason: 'u-acct proposed this supplier and cannot also approve it' });
    expect(r.presentApproveOutcome('en', out)).toMatchObject({ tone: 'error', label: 'Head office refused the approval: u-acct proposed this supplier and cannot also approve it' });
    const lost: SupplierApprovePort = { post: async () => ({ result: 'lost_link' }) };
    const l = createSuppliersSession({ userId: 'u-acct' }, ports({ approvePort: () => lost }).ports);
    expect(l.presentApproveOutcome('en', await l.approve('s-2', 'why'))).toMatchObject({ tone: 'degraded', label: 'No connection — not approved. Try again.' });
    expect(s.presentApproveOutcome('en', { outcome: 'approved' })).toMatchObject({ tone: 'ok', label: 'Supplier approved — it is now active.' });
    expect(s.presentApproveOutcome('ta', { outcome: 'self_approval' }).label).toMatch(/[஀-௿]/);
  });
});

describe('propose — only where the reader holds the right; a look-alike is SAID, never hidden', () => {
  it('offers the form only to a holder with a link', () => {
    expect(createSuppliersSession({ userId: 'u-mgr' }, ports().ports).view('en').canPropose).toBe(true);
    expect(createSuppliersSession({ userId: 'u-mgr' }, ports({ mayPropose: () => false }).ports).view('en').canPropose).toBe(false);
    expect(createSuppliersSession({ userId: 'u-mgr' }, ports({ proposePort: () => null }).ports).view('en').canPropose).toBe(false);
    expect(createSuppliersSession({ userId: null }, ports().ports).view('en').canPropose).toBe(false);
  });

  it('refuses an incomplete form (no code, no name, terms not whole days) and a reader without the right — nothing sent', async () => {
    const { ports: p, calls } = ports();
    const s = createSuppliersSession({ userId: 'u-mgr' }, p);
    const form = { supplierId: 'SUP-9', name: 'New Traders', gstin: '', phone: '', email: '', paymentTermsDays: '' };
    expect(await s.propose({ ...form, supplierId: ' ' })).toEqual({ outcome: 'incomplete' });
    expect(await s.propose({ ...form, name: '' })).toEqual({ outcome: 'incomplete' });
    expect(await s.propose({ ...form, paymentTermsDays: '30 days' })).toEqual({ outcome: 'incomplete' });
    expect(await s.propose({ ...form, paymentTermsDays: '-1' })).toEqual({ outcome: 'incomplete' });
    expect(calls.propose).toEqual([]);
    const denied = createSuppliersSession({ userId: 'u-x' }, ports({ mayPropose: () => false, calls }).ports);
    expect(await denied.propose(form)).toEqual({ outcome: 'not_permitted' });
    expect(calls.propose).toEqual([]);
  });

  it('posts the trimmed fields with blanks as null and terms as a number; says the duplicates the cloud named on the success line', async () => {
    const { ports: p, calls } = ports();
    const s = createSuppliersSession({ userId: 'u-mgr' }, p);
    const out = await s.propose({ supplierId: ' SUP-9 ', name: ' New Traders ', gstin: ' 33ABCDE1234F1Z5 ', phone: '', email: 'a@b.in', paymentTermsDays: ' 30 ' });
    expect(out).toEqual({ outcome: 'proposed', possibleDuplicates: [] });
    expect(calls.propose).toEqual([{ supplierId: 'SUP-9', name: 'New Traders', gstin: '33ABCDE1234F1Z5', phone: null, email: 'a@b.in', paymentTermsDays: 30 }]);
    expect(s.presentProposeOutcome('en', out)).toMatchObject({ tone: 'ok', label: 'Supplier proposed — a different person must approve it before it counts.' });
    const dupes: SupplierProposePort = { post: async () => ({ result: 'updated', possibleDuplicates: ['s-1', 's-7'] }) };
    const d = createSuppliersSession({ userId: 'u-mgr' }, ports({ proposePort: () => dupes }).ports);
    const said = await d.propose({ supplierId: 'SUP-9', name: 'Amma Traders', gstin: '', phone: '', email: '', paymentTermsDays: '' });
    expect(said).toEqual({ outcome: 'updated', possibleDuplicates: ['s-1', 's-7'] });
    expect(d.presentProposeOutcome('en', said)).toMatchObject({ tone: 'degraded', needsAttention: true, label: 'Supplier record updated. Looks like another supplier: s-1, s-7' });
    const refusing: SupplierProposePort = { post: async () => ({ result: 'refused', reason: 'A supplier needs a supplierId in the path and a name' }) };
    const r = createSuppliersSession({ userId: 'u-mgr' }, ports({ proposePort: () => refusing }).ports);
    expect(r.presentProposeOutcome('en', await r.propose({ supplierId: 'SUP-9', name: 'x', gstin: '', phone: '', email: '', paymentTermsDays: '' })))
      .toMatchObject({ tone: 'error', label: 'Head office refused it: A supplier needs a supplierId in the path and a name' });
  });
});
