import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  WRITE_OFF_CAPTURE_COPY, COPY_KEYS, LOSS_TYPES, createWriteOffCaptureSession,
  type WriteOffCapturePorts, type WriteOffDraft, type WriteOffRecordOutcome,
} from '../../apps/web-erp/src/write-off-capture-session';
import { bilingualGaps } from '../../packages/ui/src/index';

/**
 * **The shop-floor write-off CAPTURE screen is usable, bilingual, and governed (M28-FR-01, API-04, §28, ADR-0024).**
 *
 * The store is in Tamil Nadu and the roadmap mandates both languages, so the tripwire binds to the session's
 * single `BilingualCopy` via the shared `packages/ui` check — and to every word the page asks the session for. It also
 * holds the screen to the usability rules every screen carries — no browser dialogs, defers to the tested session,
 * colour is never the only signal — and pins the things THIS screen exists to guarantee: the loss type is a CHOSEN chip
 * (never free text, M15); a MATERIAL loss reads as attention and is never sent on a typed name — there is no approver
 * box at all; it is sent only naming the raiser's own approved request, and with no head office behind the page it is
 * not sent at all; the only writes (ask, record) run ONLY on an explicit click (never on load); and the screen itself
 * issues no write verbs and opens no socket — the audited POSTs live in the injected ports (browser-entry).
 */

const THRESHOLD = 50_000; // ₹500 in paise — the material line, mirroring the engine default
const ports = (over: Partial<WriteOffCapturePorts> = {}): WriteOffCapturePorts => ({
  mayCapture: () => true,
  capturePort: () => ({ post: async () => ({ result: 'recorded' as const }) }),
  ...over,
});
const session = (over: Partial<WriteOffCapturePorts> = {}) =>
  createWriteOffCaptureSession({ userId: 'u-floor', materialThresholdMinor: THRESHOLD }, ports(over));

const draft = (over: Partial<WriteOffDraft> = {}): WriteOffDraft => ({
  writeOffId: 'wo-1', productId: 'RICE-5', locationId: 'AISLE-3', qty: 4, uom: 'ea',
  lossType: 'damage', valueMinor: 10_000, ...over,
});

const RAW = readFileSync('apps/web-erp/web/write-off-capture.js', 'utf8');
const VIEW = RAW.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const HTML = readFileSync('apps/web-erp/web/write-off-capture.html', 'utf8');

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

  it('every word the page asks the session for exists in the session’s copy — never a raw key on screen', () => {
    const asked = [...VIEW.matchAll(/\bt\('(\w+)'\)/g)].map((m) => m[1]!);
    expect(asked.length).toBeGreaterThan(10);
    const missing = [...new Set(asked)].filter((k) => !(k in WRITE_OFF_CAPTURE_COPY.en));
    expect(missing, `the page asks the session for words it does not have: ${missing.join(', ')}`).toEqual([]);
  });
});

describe('a material loss reads as attention, never colour alone', () => {
  it('judges materiality on the injected threshold — the same line the server enforces', () => {
    const s = session();
    expect(s.isMaterial(THRESHOLD)).toBe(true);
    expect(s.isMaterial(THRESHOLD - 1)).toBe(false);
  });

  it('a big-loss refusal is attention with a word and an icon; a record is ok', () => {
    const s = session();
    const outcomes: WriteOffRecordOutcome[] = [
      { kind: 'needs_evidence' }, { kind: 'not_asked' }, { kind: 'waiting' }, { kind: 'changed' }, { kind: 'expired' },
      { kind: 'used' }, { kind: 'not_connected' }, { kind: 'rejected', decidedBy: 'u-mgr', reason: 'recount' },
    ];
    for (const outcome of outcomes) {
      const p = s.presentRecordOutcome('en', outcome);
      expect(p.needsAttention, outcome.kind).toBe(true);
      expect(['degraded', 'error'], outcome.kind).toContain(p.tone);
      expect(p.label.length, outcome.kind).toBeGreaterThan(0);
      expect(p.icon.trim().length, outcome.kind).toBeGreaterThan(0);
    }
    const recorded = s.presentRecordOutcome('en', { kind: 'recorded', approvedBy: null });
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
    let sent = 0;
    const noPerm = session({ mayCapture: () => false, capturePort: () => ({ post: async () => { sent += 1; return { result: 'recorded' as const }; } }) });
    expect(noPerm.view('en').mayCapture).toBe(false);
    expect((await noPerm.record(draft())).kind).toBe('not_permitted');
    expect(sent).toBe(0);
  });

  it('refuses an incomplete draft locally (the server also refuses 400)', async () => {
    expect((await session().record(draft({ productId: '   ' }))).kind).toBe('incomplete');
    expect((await session().record(draft({ qty: 0 }))).kind).toBe('incomplete');
    expect((await session().record(draft({ lossType: 'not-a-loss' as unknown as WriteOffDraft['lossType'] }))).kind).toBe('incomplete');
  });

  it('a MATERIAL loss is never sent on a typed name: no evidence, not connected, or not approved — nothing leaves', async () => {
    let sent = 0;
    const counting = { capturePort: () => ({ post: async () => { sent += 1; return { result: 'recorded' as const }; } }) };
    // Not wired to head office's approval engine: a big loss is not recorded at all.
    expect((await session(counting).record(draft({ valueMinor: 60_000, evidenceRef: 'photo-9' }))).kind).toBe('not_connected');
    // Wired, but nobody asked — and no evidence.
    const wired = { ...counting, askApproval: async () => ({ result: 'lost_link' as const }), approvalInbox: async () => ({ result: 'read' as const, inbox: { waitingForMe: [], mine: [], asAt: null } }) };
    expect((await session(wired).record(draft({ valueMinor: 60_000 }))).kind).toBe('needs_evidence');
    expect((await session(wired).record(draft({ valueMinor: 60_000, evidenceRef: 'photo-9' }))).kind).toBe('not_asked');
    expect(sent).toBe(0);
    // A small loss still reaches the port on the raiser's own.
    expect((await session(counting).record(draft())).kind).toBe('recorded');
    expect(sent).toBe(1);
  });
});

describe('the view defers to the model, uses no browser dialogs, and only writes on an explicit click', () => {
  it('never calls alert / confirm / prompt (the fields are inputs, not browser dialogs)', () => {
    expect(/\b(alert|confirm|prompt)\s*\(/.test(VIEW)).toBe(false);
  });

  it('renders from the bundled session rather than re-deciding what to show', () => {
    expect(VIEW).toMatch(/window\.writeOffCaptureSession/);
    expect(VIEW).toMatch(/session\.view\(/);
    expect(VIEW).toMatch(/session\.needsApproval\(/);
  });

  it('asks and records ONLY from an explicit click — neither runs at load', () => {
    const firstClick = VIEW.indexOf("addEventListener('click'");
    expect(firstClick, 'no click handler is registered').toBeGreaterThan(-1);
    for (const call of ['session.record(', 'session.askApproval(']) {
      const at = VIEW.indexOf(call);
      expect(at, `${call} is not present`).toBeGreaterThan(-1);
      expect(at, `${call} runs before/outside a click handler (would write on load)`).toBeGreaterThan(firstClick);
      // The call sits inside the handler of its own button.
      const handler = VIEW.lastIndexOf("addEventListener('click'", at);
      expect(VIEW.slice(handler - 30, handler), `${call} is not in a button's click handler`).toMatch(/el\('(ask|record)'\)\.$/);
    }
  });

  it('issues no write verbs and opens no socket itself — the audited POSTs live in the injected ports', () => {
    const writes = VIEW.match(/method:\s*'(POST|PUT|PATCH|DELETE)'/g) ?? [];
    expect(writes).toEqual([]);
    expect(/\bfetch\s*\(/.test(VIEW), 'the view opens a socket itself').toBe(false);
    expect(/XMLHttpRequest/.test(VIEW), 'the view opens an XHR itself').toBe(false);
  });

  it('has no approver box and sends no approver — a name typed on a page is not an approval (ADR-0024)', () => {
    expect(HTML).not.toMatch(/id="wo-approver"/);
    expect(HTML).not.toMatch(/approver-label/);
    expect(VIEW).not.toMatch(/approvedBy|approval:\s*\{\s*by|wo-approver/);
    // The two-person step is on the page instead: a reason box with a label, and the ask button.
    expect(HTML).toMatch(/<label for="wo-why" id="why-label">/);
    expect(HTML).toMatch(/<textarea id="wo-why"/);
    expect(HTML).toMatch(/<button id="ask" class="act" type="button">/);
  });

  it('the loss type is a CHOSEN chip, never a free-text field (M15)', () => {
    expect(VIEW).toMatch(/view\.lossTypes/);
    expect(VIEW).toMatch(/selectedLossType/);
    expect(VIEW).toMatch(/aria-pressed/);
    expect(HTML).not.toMatch(/id="wo-loss-?type"/);
  });

  it('every result carries a screen-reader announcement, and its icon is aria-hidden', () => {
    expect(VIEW).toMatch(/setAttribute\('aria-label'/);
    expect(HTML).toMatch(/aria-hidden="true"/);
    expect(VIEW).toMatch(/setAttribute\('aria-hidden', 'true'\)/);
  });

  it('the shell loads the shared bundle, carries the data marker, labels the toggle, the loss-type group and the list, and shows focus', () => {
    expect(HTML).toMatch(/web-erp\.bundle\.js/);
    expect(HTML).toContain('<!--SCREEN-DATA-->');
    expect(HTML).toMatch(/id="lang"[^>]*aria-label=/);
    expect(HTML).toMatch(/id="loss-types"[^>]*aria-label=/);
    expect(HTML).toMatch(/id="your-losses"[^>]*aria-labelledby="your-losses-title"/);
    expect(HTML).toMatch(/textarea:focus-visible/);
    expect(HTML).toMatch(/button\.act:focus-visible/);
    expect(HTML).toMatch(/button\.carry:focus-visible/);
  });

  it('one primary action at a time: "Record the loss" starts as the primary; the view moves it to "Ask for approval" for a big loss nobody was asked about', () => {
    expect(HTML).toMatch(/<button id="record" class="act primary" type="button">/);
    expect(VIEW).toMatch(/el\('ask'\)\.classList\.toggle\('primary', askFirst\)/);
    expect(VIEW).toMatch(/el\('record'\)\.classList\.toggle\('primary', !askFirst\)/);
  });
});
