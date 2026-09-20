import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  WRITE_OFF_CAPTURE_COPY, COPY_KEYS, LOSS_TYPES, createWriteOffCaptureSession,
  type WriteOffCapturePorts, type WriteOffDraft, type CaptureResult,
} from '../../apps/web-erp/src/write-off-capture-session';
import { bilingualGaps } from '../../packages/ui/src/index';

/**
 * **The shop-floor write-off CAPTURE screen is usable, bilingual, and governed (M28-FR-01, API-04, §28).**
 *
 * The store is in Tamil Nadu and the roadmap mandates both languages, so the tripwire binds to the session's
 * single `BilingualCopy` via the shared `packages/ui` check. It also holds the screen to the usability rules
 * every screen carries — no browser dialogs, defers to the tested session, colour is never the only signal —
 * and pins the things THIS screen exists to guarantee: the loss type is a CHOSEN chip (never free text, M15); a
 * MATERIAL loss reads as attention and is refused locally before any POST unless it carries evidence AND a
 * SEPARATE approver (the raiser can never approve their own, §28); the only write is a RECORD that runs ONLY on
 * an explicit click (never on load); and the screen itself issues no write verbs and opens no socket — the
 * audited POST to `/v1/inventory/write-off/:id` lives in the injected port (browser-entry).
 */

const THRESHOLD = 50_000; // ₹500 in paise — the material line, mirroring the engine default
const ports = (over: Partial<WriteOffCapturePorts> = {}): WriteOffCapturePorts => ({
  mayCapture: () => true,
  capturePort: () => ({ post: async () => 'recorded' as CaptureResult }),
  ...over,
});
const session = (over: Partial<WriteOffCapturePorts> = {}) =>
  createWriteOffCaptureSession({ userId: 'u-floor', materialThresholdMinor: THRESHOLD }, ports(over));

const draft = (over: Partial<WriteOffDraft> = {}): WriteOffDraft => ({
  writeOffId: 'wo-1', productId: 'RICE-5', locationId: 'AISLE-3', qty: 4, uom: 'ea',
  lossType: 'damage', valueMinor: 10_000, ...over,
});

describe('the write-off capture copy is complete in both languages', () => {
  it('has no gap in either language across the whole vocabulary', () => {
    const gaps = bilingualGaps(WRITE_OFF_CAPTURE_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });

  it('tripwire — the detector fires on a key that is genuinely absent', () => {
    const holey = { en: { ...WRITE_OFF_CAPTURE_COPY.en }, ta: { ...WRITE_OFF_CAPTURE_COPY.ta, scrReady: '' } };
    expect(bilingualGaps(holey, COPY_KEYS).ta).toContain('scrReady');
  });
});

describe('a material loss reads as attention, never colour alone', () => {
  it('judges materiality on the injected threshold — the same line the server enforces', () => {
    const s = session();
    expect(s.isMaterial(THRESHOLD)).toBe(true);
    expect(s.isMaterial(THRESHOLD - 1)).toBe(false);
  });

  it('a material-loss refusal is attention (degraded) with a word and an icon; a record is ok', () => {
    const s = session();
    for (const outcome of ['needs_evidence', 'needs_approval'] as const) {
      const p = s.presentResult('en', outcome);
      expect(p.needsAttention, outcome).toBe(true);
      expect(p.tone, outcome).toBe('degraded');
      expect(p.label.length, outcome).toBeGreaterThan(0);
      expect(p.icon.trim().length, outcome).toBeGreaterThan(0);
    }
    const authorised = s.presentResult('en', 'approver_not_authorised');
    expect(authorised.tone).toBe('error');
    expect(authorised.icon.trim().length).toBeGreaterThan(0);
    const recorded = s.presentResult('en', 'recorded');
    expect(recorded.tone).toBe('ok');
    expect(recorded.label.length).toBeGreaterThan(0);
  });

  it('offers the loss types as words in the tested engine order — a chosen chip, not a colour', () => {
    const view = session().view('en');
    expect(view.lossTypes.map((c) => c.lossType)).toEqual([...LOSS_TYPES]);
    for (const c of view.lossTypes) expect(c.label.trim().length).toBeGreaterThan(0);
  });
});

describe('an unpermitted user is offered no capture action, and the model refuses before any POST', () => {
  it('withholds mayCapture without inventory.movement.append, and records nothing', async () => {
    const noPerm = session({ mayCapture: () => false });
    expect(noPerm.view('en').mayCapture).toBe(false);
    expect(await noPerm.record(draft())).toBe('refused');
  });

  it('refuses an incomplete draft locally (the server also refuses 400)', async () => {
    expect(await session().record(draft({ productId: '   ' }))).toBe('refused');
    expect(await session().record(draft({ qty: 0 }))).toBe('refused');
    expect(await session().record(draft({ lossType: 'not-a-loss' as unknown as WriteOffDraft['lossType'] }))).toBe('refused');
  });

  it('refuses a MATERIAL loss with no evidence, and one with no SEPARATE approver (§28)', async () => {
    // No evidence → needs_evidence, before any POST.
    expect(await session().record(draft({ valueMinor: 60_000 }))).toBe('needs_evidence');
    // Evidence but no approver → needs_approval.
    expect(await session().record(draft({ valueMinor: 60_000, evidenceRef: 'photo-9' }))).toBe('needs_approval');
    // Evidence but the raiser approving their OWN loss → needs_approval (the screen never fakes a second person).
    expect(await session().record(draft({ valueMinor: 60_000, evidenceRef: 'photo-9', approval: { by: 'u-floor' } }))).toBe('needs_approval');
  });

  it('reaches the port for an immaterial loss, and for a material loss with evidence and a different approver', async () => {
    expect(await session().record(draft())).toBe('recorded'); // immaterial
    expect(await session().record(draft({ valueMinor: 60_000, evidenceRef: 'photo-9', approval: { by: 'u-mgr' } }))).toBe('recorded');
  });
});

describe('the view defers to the model, uses no browser dialogs, and only writes on an explicit click', () => {
  const RAW = readFileSync('apps/web-erp/web/write-off-capture.js', 'utf8');
  const VIEW = RAW.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  it('never calls alert / confirm / prompt (the fields are inputs, not browser dialogs)', () => {
    expect(/\b(alert|confirm|prompt)\s*\(/.test(VIEW)).toBe(false);
  });

  it('renders from the bundled session rather than re-deciding what to show', () => {
    expect(VIEW).toMatch(/window\.writeOffCaptureSession/);
    expect(VIEW).toMatch(/session\.view\(/);
  });

  it('records ONLY from an explicit click — session.record never runs at load', () => {
    const callIdx = VIEW.indexOf('session.record(');
    expect(callIdx, 'session.record( is not present').toBeGreaterThan(-1);
    const clickIdx = VIEW.indexOf("addEventListener('click'");
    expect(clickIdx, 'no click handler is registered').toBeGreaterThan(-1);
    expect(callIdx, 'session.record( runs before/outside a click handler (would write on load)').toBeGreaterThan(clickIdx);
  });

  it('issues no write verbs and opens no socket itself — the audited POST lives in the injected port', () => {
    const writes = VIEW.match(/method:\s*'(POST|PUT|PATCH|DELETE)'/g) ?? [];
    expect(writes).toEqual([]);
    expect(/\bfetch\s*\(/.test(VIEW), 'the view opens a socket itself').toBe(false);
    expect(/XMLHttpRequest/.test(VIEW), 'the view opens an XHR itself').toBe(false);
  });

  it('the loss type is a CHOSEN chip, never a free-text field (M15)', () => {
    expect(VIEW).toMatch(/view\.lossTypes/);
    expect(VIEW).toMatch(/selectedLossType/);
    expect(VIEW).toMatch(/aria-pressed/);
    // No text/free input is bound to the loss type — the vocabulary is the engine's, picked not typed.
    const HTML = readFileSync('apps/web-erp/web/write-off-capture.html', 'utf8');
    expect(HTML).not.toMatch(/id="wo-loss-?type"/);
  });

  it('every result carries a screen-reader announcement, and its icon is aria-hidden', () => {
    expect(VIEW).toMatch(/setAttribute\('aria-label'/);
    const HTML = readFileSync('apps/web-erp/web/write-off-capture.html', 'utf8');
    expect(HTML).toMatch(/aria-hidden="true"/);
  });

  it('the shell loads the shared bundle, carries the data marker, and labels the toggle and the loss-type group', () => {
    const HTML = readFileSync('apps/web-erp/web/write-off-capture.html', 'utf8');
    expect(HTML).toMatch(/web-erp\.bundle\.js/);
    expect(HTML).toContain('<!--SCREEN-DATA-->');
    expect(HTML).toMatch(/id="lang"[^>]*aria-label=/);
    expect(HTML).toMatch(/id="loss-types"[^>]*aria-label=/);
  });
});
