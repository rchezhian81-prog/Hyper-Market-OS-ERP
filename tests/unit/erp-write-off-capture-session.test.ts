import { describe, it, expect } from 'vitest';
import {
  createWriteOffCaptureSession, WRITE_OFF_CAPTURE_COPY, COPY_KEYS, LOSS_TYPES, formatRupees,
  type WriteOffCapturePorts, type WriteOffCapturePort, type WriteOffDraft, type CaptureResult,
} from '../../apps/web-erp/src/write-off-capture-session';
import { bilingualGaps } from '../../packages/ui/src/index';

// The write-off CAPTURE screen's DOM-free session model (M28-FR-01). Every money/stock rule is server-side
// (threshold, evidence, §28 approver, authority); this proves the screen shapes the request and refuses the
// wrong cases BEFORE any POST — no permission, an incomplete form, or a MATERIAL loss with no evidence / no
// separate approver / the raiser approving their own — and maps every outcome to one glanceable state.

const THRESHOLD = 500_00; // ₹500 — the tenant's material-loss line (injected policy)

/** A stub port that records what it was posted and answers with a scripted result. */
function stubPort(result: CaptureResult = 'recorded'): WriteOffCapturePort & { posted: unknown } {
  const p = {
    posted: undefined as unknown,
    async post(input: unknown) { p.posted = input; return result; },
  };
  return p;
}

function session(over: {
  userId?: string | null;
  mayCapture?: boolean;
  port?: WriteOffCapturePort;
  thresholdMinor?: number;
} = {}) {
  const port = over.port ?? stubPort();
  const ports: WriteOffCapturePorts = {
    mayCapture: () => over.mayCapture ?? true,
    capturePort: () => port,
  };
  const s = createWriteOffCaptureSession(
    { userId: over.userId === undefined ? 'u-raiser' : over.userId, materialThresholdMinor: over.thresholdMinor ?? THRESHOLD },
    ports,
  );
  return { s, port };
}

const draft = (over: Partial<WriteOffDraft> = {}): WriteOffDraft => ({
  writeOffId: 'WO-1', productId: 'P1', locationId: 'L1', qty: 2, uom: 'ea',
  lossType: 'damage', valueMinor: 100_00, ...over,
});

describe('write-off capture: bilingual + the view', () => {
  it('has no bilingual gaps — every key in English and Tamil', () => {
    const gaps = bilingualGaps(WRITE_OFF_CAPTURE_COPY, COPY_KEYS);
    expect(gaps.en).toEqual([]);
    expect(gaps.ta).toEqual([]);
  });

  it('offers the five loss types as chosen chips (never free text), in the engine order', () => {
    const { s } = session();
    const v = s.view('en');
    expect(v.mayCapture).toBe(true);
    expect(v.lossTypes.map((c) => c.lossType)).toEqual([...LOSS_TYPES]);
    expect(v.lossTypes.find((c) => c.lossType === 'damage')?.label).toBe('Damage');
    // The Tamil view carries the Tamil labels.
    expect(s.view('ta').lossTypes.find((c) => c.lossType === 'damage')?.label).toBe('சேதம்');
  });

  it('shows the material-loss threshold, and surfaces when nobody is named', () => {
    const { s } = session({ userId: null, thresholdMinor: 500_00 });
    const v = s.view('en');
    expect(v.thresholdMinor).toBe(500_00);
    expect(v.thresholdText).toBe('₹500.00');
    expect(v.nobodyNamed).toBe(true);
  });

  it('shows a not-permitted state to a user who cannot record a loss', () => {
    const { s } = session({ mayCapture: false });
    const v = s.view('en');
    expect(v.mayCapture).toBe(false);
    expect(v.lossTypes).toEqual([]);
    expect(v.screenState.label).toBe(WRITE_OFF_CAPTURE_COPY.en.stateNotPermitted);
  });

  it('formatRupees renders paise as ₹', () => {
    expect(formatRupees(500_00)).toBe('₹500.00');
    expect(formatRupees(0)).toBe('₹0.00');
    expect(formatRupees(12_34)).toBe('₹12.34');
  });
});

describe('write-off capture: materiality', () => {
  it('is material at or above the threshold, immaterial below', () => {
    const { s } = session({ thresholdMinor: 500_00 });
    expect(s.isMaterial(499_99)).toBe(false);
    expect(s.isMaterial(500_00)).toBe(true); // boundary is material
    expect(s.isMaterial(500_01)).toBe(true);
  });
});

describe('write-off capture: recording refuses the wrong cases BEFORE any POST', () => {
  it('refuses without permission — no POST', async () => {
    const port = stubPort();
    const { s } = session({ mayCapture: false, port });
    expect(await s.record(draft())).toBe('refused');
    expect(port.posted).toBeUndefined();
  });

  it('refuses an incomplete draft — no POST', async () => {
    const port = stubPort();
    const { s } = session({ port });
    expect(await s.record(draft({ productId: '' }))).toBe('refused');
    expect(await s.record(draft({ qty: 0 }))).toBe('refused');
    expect(await s.record(draft({ qty: 1.5 }))).toBe('refused');
    expect(await s.record(draft({ valueMinor: -1 }))).toBe('refused');
    expect(port.posted).toBeUndefined();
  });

  it('records an IMMATERIAL loss on the raiser’s own, with no evidence or approver', async () => {
    const port = stubPort('recorded');
    const { s } = session({ port });
    expect(await s.record(draft({ valueMinor: 100_00 }))).toBe('recorded');
    expect(port.posted).toMatchObject({ writeOffId: 'WO-1', productId: 'P1', lossType: 'damage', valueMinor: 100_00 });
  });

  it('a MATERIAL loss with no evidence is refused locally — needs_evidence, no POST', async () => {
    const port = stubPort();
    const { s } = session({ port });
    expect(await s.record(draft({ valueMinor: 600_00 }))).toBe('needs_evidence');
    expect(port.posted).toBeUndefined();
  });

  it('a MATERIAL loss with evidence but NO approver is refused — needs_approval (§28), no POST', async () => {
    const port = stubPort();
    const { s } = session({ port });
    expect(await s.record(draft({ valueMinor: 600_00, evidenceRef: 'photo-1' }))).toBe('needs_approval');
    expect(port.posted).toBeUndefined();
  });

  it('a MATERIAL loss the raiser tries to approve THEMSELVES is refused — needs_approval (§28), no POST', async () => {
    const port = stubPort();
    const { s } = session({ userId: 'u-raiser', port });
    expect(await s.record(draft({ valueMinor: 600_00, evidenceRef: 'photo-1', approval: { by: 'u-raiser' } }))).toBe('needs_approval');
    expect(port.posted).toBeUndefined();
  });

  it('a MATERIAL loss with evidence AND a separate approver POSTs', async () => {
    const port = stubPort('recorded');
    const { s } = session({ userId: 'u-raiser', port });
    expect(await s.record(draft({ valueMinor: 600_00, evidenceRef: 'photo-1', approval: { by: 'u-manager' } }))).toBe('recorded');
    expect(port.posted).toMatchObject({ valueMinor: 600_00, evidenceRef: 'photo-1', approvedBy: 'u-manager' });
  });

  it('defaults the reasonCode to the loss type, and honours a finer reason when given', async () => {
    const port = stubPort('recorded');
    const { s } = session({ port });
    await s.record(draft({ lossType: 'expiry' }));
    expect(port.posted).toMatchObject({ reasonCode: 'expiry' });
    await s.record(draft({ lossType: 'expiry', reasonCode: 'past use-by on the shelf' }));
    expect(port.posted).toMatchObject({ reasonCode: 'past use-by on the shelf' });
  });

  it('passes the server’s own outcomes straight through', async () => {
    for (const r of ['conflict', 'approver_not_authorised', 'lost_link', 'refused'] as CaptureResult[]) {
      const { s } = session({ port: stubPort(r) });
      // An immaterial loss goes to the port, so the port's answer is what comes back.
      expect(await s.record(draft({ valueMinor: 100_00 }))).toBe(r);
    }
  });
});

describe('write-off capture: outcome presentation', () => {
  it('maps every outcome to a distinct glanceable status', () => {
    const { s } = session();
    expect(s.presentResult('en', 'recorded')).toMatchObject({ tone: 'ok', needsAttention: false });
    expect(s.presentResult('en', 'needs_evidence')).toMatchObject({ tone: 'degraded', needsAttention: true });
    expect(s.presentResult('en', 'needs_approval')).toMatchObject({ tone: 'degraded', needsAttention: true });
    expect(s.presentResult('en', 'approver_not_authorised')).toMatchObject({ tone: 'error', needsAttention: true });
    expect(s.presentResult('en', 'conflict')).toMatchObject({ tone: 'degraded' });
    expect(s.presentResult('en', 'lost_link')).toMatchObject({ tone: 'degraded', needsAttention: true });
    expect(s.presentResult('en', 'refused')).toMatchObject({ tone: 'error', needsAttention: true });
    // Bilingual: the Tamil label is used.
    expect(s.presentResult('ta', 'recorded').label).toBe(WRITE_OFF_CAPTURE_COPY.ta.recorded);
  });
});
