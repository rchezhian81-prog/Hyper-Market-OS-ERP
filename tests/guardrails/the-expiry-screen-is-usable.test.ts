import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  createExpirySession,
  type ExpiryConfig, type ExpiryPorts, type RecallCloudPort,
} from '../../apps/web-erp/src/expiry-session';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/index';
import type { Batch } from '../../packages/fefo/src/index';

/**
 * **The expiry & recall screen is usable, bilingual, and its recall write is honest (M10-FR-04, P-08).**
 *
 * The recalled-tin guardrail pins the recall BLOCK and the local refusal words; this one pins the thing
 * slice 1 added — the recall RECORD now goes to head office — and holds the screen to the usability rules
 * every back-office screen carries. The load-bearing checks:
 *
 *   • the screen reports a recall started/closed ONLY when head office saved it, and an honest "not sent"
 *     when the link is down — never a false "done" (P-08);
 *   • the VIEW issues NO write verb of its own — the authenticated POST lives in the injected cloud port;
 *   • a recall is started or closed ONLY on an explicit click, never at load;
 *   • it defers to the tested session, never re-deciding what to show, and never a browser dialog;
 *   • the "not sent" message exists in both languages (the store is in Tamil Nadu).
 */

const RAW = readFileSync('apps/web-erp/web/expiry.js', 'utf8');
const VIEW = RAW.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const HTML = readFileSync('apps/web-erp/web/expiry.html', 'utf8');

// ── The governed write, exercised through the tested session ─────────────────

const BATCHES: Batch[] = [{ batchId: 'B-1', productId: 'p1', qty: 10, expiry: '2026-08-09' }];
const CONFIG: ExpiryConfig = {
  tenantId: 't', storeId: 's', userId: 'u-qc', now: '2026-08-06T14:00:00.000Z', nearExpiryDays: 7,
};

/** A head-office stub that records what it was asked and saves. */
function recordingCloud(): { readonly initiated: unknown[]; readonly port: RecallCloudPort } {
  const initiated: unknown[] = [];
  return {
    initiated,
    port: {
      initiate: async (input) => { initiated.push(input); return { recorded: true }; },
      close: async () => ({ recorded: true }),
    },
  };
}
/** A head office that cannot be reached — the cable-out case. */
const lostLinkCloud = (): RecallCloudPort => ({
  initiate: async () => ({ recorded: false, reason: 'no connection to head office — the recall was not recorded' }),
  close: async () => ({ recorded: false, reason: 'no connection to head office — the closure was not recorded' }),
});

const desk = (cloud: RecallCloudPort, over: Partial<ExpiryPorts> = {}, config: Partial<ExpiryConfig> = {}) =>
  createExpirySession({ ...CONFIG, ...config }, {
    batches: () => BATCHES,
    ledger: () => new Ledger(new InMemoryLedgerStore()),
    recalls: () => [],
    productNames: () => ({ p1: 'Toor dal 1kg' }),
    recallCloud: cloud,
    ...over,
  });

describe('the recall write reaches head office, and a dropped link is never a false success (P-08)', () => {
  it('a well-formed start is recorded at head office before it is reported done', async () => {
    const cloud = recordingCloud();
    const outcome = await desk(cloud.port).start({ recallId: 'RC-1', batchId: 'B-1', reason: 'supplier notice: glass' });
    expect(outcome.ok).toBe(true);
    // The batch and the reason reached head office — the durable record, not a note on one screen.
    expect(cloud.initiated).toEqual([{ batchId: 'B-1', reason: 'supplier notice: glass' }]);
  });

  it('a start with the link down is reported as NOT sent, never as done', async () => {
    const outcome = await desk(lostLinkCloud()).start({ recallId: 'RC-1', batchId: 'B-1', reason: 'glass' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok || !('notSent' in outcome)) return;
    expect(outcome.notSent).toBe(true);
    expect(outcome.reason).toContain('no connection');
  });

  it('a malformed start never troubles head office — the guards run first', async () => {
    const cloud = recordingCloud();
    const outcome = await desk(cloud.port).start({ recallId: 'RC-1', batchId: 'B-1', reason: '   ' });
    expect(outcome.ok).toBe(false);
    expect(cloud.initiated).toEqual([]);
  });
});

// ── The view defers to the model, issues no write verb, writes only on a click ─

describe('the view defers to the session and issues no write verb of its own', () => {
  it('never calls alert / confirm / prompt (the reason/evidence are text inputs, not dialogs)', () => {
    expect(/\b(alert|confirm|prompt)\s*\(/.test(VIEW)).toBe(false);
  });

  it('renders from the bundled session rather than re-deciding what to show', () => {
    expect(VIEW).toMatch(/window\.expirySession/);
  });

  it('starts and closes ONLY from an explicit click — never at load', () => {
    const firstClick = VIEW.indexOf("addEventListener('click'");
    expect(firstClick, 'no click handler is registered').toBeGreaterThan(-1);
    for (const call of ['session.start(', 'session.close(']) {
      const at = VIEW.indexOf(call);
      expect(at, `${call} is not present`).toBeGreaterThan(-1);
      expect(at, `${call} runs before/outside a click handler (would write on load)`).toBeGreaterThan(firstClick);
    }
  });

  it('issues no write verb itself — the audited POST lives in the injected cloud port', () => {
    const writes = VIEW.match(/method:\s*'(POST|PUT|PATCH|DELETE)'/g) ?? [];
    expect(writes).toEqual([]);
  });

  it('surfaces an honest "not sent" when head office was not reached (P-08)', () => {
    // Both handlers must branch on the not-sent outcome and show the words, never a false "done".
    expect(VIEW).toMatch(/outcome\.notSent/);
    expect(VIEW).toMatch(/t\('notSent'\)/);
  });
});

// ── Bilingual, and the shell opens ───────────────────────────────────────────

describe('the not-sent message and the shell', () => {
  it('has the not-sent message in BOTH languages (the store is in Tamil Nadu)', () => {
    const en = VIEW.slice(VIEW.indexOf('en: {'), VIEW.indexOf('ta: {'));
    const ta = VIEW.slice(VIEW.indexOf('ta: {'), VIEW.indexOf('};'));
    expect(en, 'English "notSent" is missing').toMatch(/notSent:/);
    expect(ta, 'Tamil "notSent" is missing').toMatch(/notSent:/);
  });

  it('loads the shared bundle, carries the data marker, labels the toggle and the start form', () => {
    expect(HTML).toMatch(/web-erp\.bundle\.js/);
    expect(HTML).toContain('<!--SCREEN-DATA-->');
    expect(HTML).toMatch(/id="lang"[^>]*aria-label=/);
    expect(HTML).toMatch(/id="batch"/);
    expect(HTML).toMatch(/id="reason"/);
    expect(HTML).toMatch(/id="start"/);
    // Opens with no network and says where the page came from.
    expect(VIEW).toMatch(/navigator\.serviceWorker\.register\('\.\/sw\.js'\)/);
    expect(HTML).toMatch(/id="stale"/);
  });
});
