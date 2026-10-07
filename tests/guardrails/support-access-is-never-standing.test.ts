import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { SUPPORT_ACCESS_COPY, SUPPORT_COPY_KEYS } from '../../apps/web-erp/src/admin-session';
import { bilingualGaps } from '../../packages/ui/src/index';
import { grantSupportAccess, supportSessionActive } from '../../packages/platform-admin/src/index';

/**
 * **Support access, guarded — and the copy that enforced less.**
 *
 * The design bar for this surface is one line: *time-bound, audited support access — never standing
 * god-mode.* Two things stood between that sentence and the running system.
 *
 * **There were two implementations of this control.** `services/platform` carried its own
 * `grantSupportAccess`, and it was the one wired to the API. Its request had **no `scopes` field at
 * all**, so access granted over the wire could not state least privilege, could not be refused for
 * holding a scope support may never hold, and had no rule stopping an approval lengthening the
 * window that was asked for. A second, simpler copy of a security control is the one that drifts,
 * and it drifts in the direction of letting more through.
 *
 * **And the expiry was never checked.** `supportSessionActive` decides liveness from the clock —
 * *"expiry is a fact about time, not an event someone triggers"* — and nothing outside its own unit
 * test ever asked it. A session was granted with an `expiresAt` in a response body and no code
 * anywhere read it again, which is standing access wearing a time limit's clothes.
 *
 * **And the screen granted access on a typed name** (audit PA-03, register "the admin support grant", slice c-2). The
 * admin page carried a local form — who needs access, the scopes, the minutes, and "who approves it (not them)" — and
 * ran the engine in the browser. A name typed into a box is not anybody's approval. The page now reads head office's
 * own lifecycle and the OWNER decides there, in their own session; the decider is the signed-in person, never a field.
 *
 * Five things must stay true:
 *
 *   1. **one implementation**, and the service maps HTTP to it and nothing else — the screen grants nothing itself;
 *   2. **blanket access cannot be granted**, and the screen cannot ask for anything at all;
 *   3. **liveness is computed from the clock**, never stored;
 *   4. absent policy is reported as **unenforced**, never as compliant;
 *   5. **no approver box, and no decider sent**: the page has no typed requester, scope list or approver, and neither
 *      the view nor the browser port puts a `decidedBy` / `approvedBy` in anything it sends.
 */

const SERVICE = readFileSync('services/platform/src/index.ts', 'utf8');
const LIFECYCLE = readFileSync('services/platform/src/support-access-lifecycle.ts', 'utf8');
const PACKAGE = readFileSync('packages/platform-admin/src/support-access.ts', 'utf8');
const MODEL = readFileSync('apps/web-erp/src/admin-session.ts', 'utf8');
const VIEW = readFileSync('apps/web-erp/web/admin.js', 'utf8');
const HTML = readFileSync('apps/web-erp/web/admin.html', 'utf8');
const ENTRY = readFileSync('apps/web-erp/src/browser-entry.ts', 'utf8');
const SCREEN_DATA = readFileSync('edge/store-edge/src/screen-data.ts', 'utf8');

const code = (source: string): string => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

const expectWordsFor = (vocabulary: readonly string[], mapName: string): void => {
  const from = code(VIEW).indexOf(`const ${mapName}`);
  expect(from, `${mapName} is missing from the view`).toBeGreaterThan(-1);
  const words = code(VIEW).slice(from);
  expect(vocabulary.length, `${mapName} guards nothing`).toBeGreaterThan(1);
  for (const member of vocabulary) {
    const at = words.indexOf(`${member}: {`);
    expect(at, `"${member}" has no words in ${mapName}`).toBeGreaterThan(-1);
    const entry = words.slice(at, words.indexOf('\n  },', at));
    expect(entry, `"${member}" has no English`).toMatch(/\ben:/);
    expect(entry, `"${member}" has no Tamil`).toMatch(/\bta:/);
  }
};

const NOW = '2026-08-06T14:00:00.000Z';
const request = (over: Record<string, unknown> = {}) => ({
  requestId: 'R-1', requesterId: 'u-eng', requesterName: 'Engineer',
  reason: 'investigating the duplicate settlement raised in ticket 4471',
  scopes: ['read:settlements'], tenantId: 't1', minutes: 60, at: NOW, ...over,
}) as never;
const approval = (over: Record<string, unknown> = {}) =>
  ({ subjectRef: 'R-1', status: 'approved', decidedBy: 'u-owner', ...over }) as never;

// ── 1. One implementation ───────────────────────────────────────────────────

describe('support access has exactly one implementation', () => {
  it('is not defined a second time in the service', () => {
    // The copy that used to live here was the WEAKER one, and it was the one wired to the API.
    expect(code(SERVICE), 'the service defines its own grantSupportAccess again')
      .not.toMatch(/export function grantSupportAccess/);
  });

  it('tripwire — the detector fires on the shape it exists to catch', () => {
    expect('export function grantSupportAccess(\n  request: SupportAccessRequest,\n): SupportGrant {')
      .toMatch(/export function grantSupportAccess/);
  });

  it('imports the one implementation, and the request type with it', () => {
    expect(code(SERVICE)).toMatch(/from '\.\.\/\.\.\/\.\.\/packages\/platform-admin\/src\/index'/);
    // The grant runs in ONE place: the owner's decision on a request the support person filed (2b-vi-c-2).
    expect(code(LIFECYCLE)).toMatch(/grantSupportAccess\(\{ \.\.\.rec\.request, at \}, approval, deps\.policy\)/);
  });

  it('the old one-step grant — both people taken from the request — is retired, and says where access went (2b-vi-c-2, PA-03)', () => {
    const oneStep = code(SERVICE).slice(code(SERVICE).indexOf("path: '/v1/platform/support-access',"));
    const handler = oneStep.slice(0, oneStep.indexOf('\n    },'));
    expect(handler).toMatch(/code: 'support_access_moved'/);
    expect(handler, 'the one-step route grants again').not.toMatch(/grantSupportAccess\s*\(/);
    expect(handler, 'the one-step route reads people from the body again').not.toMatch(/body\.request|body\.approval|decidedBy/);
  });

  it('the screen grants nothing itself — not a third copy, and not the one copy run in the browser', () => {
    // It reads liveness from the one package, and a grant happens only at head office, on the owner's decision.
    expect(code(MODEL)).toMatch(/from '\.\.\/\.\.\/\.\.\/packages\/platform-admin\/src\/index'/);
    expect(code(MODEL), 'the screen runs the grant engine itself again').not.toMatch(/grantSupportAccess\s*\(/);
    expect(code(MODEL), 'the screen re-decides the policy rules itself')
      .not.toMatch(/scopes\.length === 0|maxMinutes|forbiddenScopes/);
    // The only window rule it applies is the owner's own cut: never LONGER than asked — said before anything is sent.
    expect(code(MODEL)).toMatch(/if \(minutes > request\.minutes\) return \{ kind: 'longer_than_asked'/);
  });
});

// ── 2. Least privilege, or refused ──────────────────────────────────────────

describe('blanket access cannot be granted, or asked for', () => {
  it('refuses an empty scope list', () => {
    // The rule the API path could not even express, because its request had no scopes.
    expect(() => grantSupportAccess(request({ scopes: [] }), approval()))
      .toThrow(/never blanket admin/);
  });

  it('refuses a scope support may never hold', () => {
    expect(code(PACKAGE)).toMatch(/forbiddenScopes/);
    expect(code(PACKAGE)).toMatch(/do not approve its money/);
  });

  it('refuses an approval that LENGTHENS the window asked for', () => {
    expect(() => grantSupportAccess(request({ minutes: 30 }), approval({ grantedMinutes: 240 })))
      .toThrow(/never extend it/);
  });

  it('refuses a self-approval and an unapproved request', () => {
    expect(() => grantSupportAccess(request(), approval({ decidedBy: 'u-eng' })))
      .toThrow(/cannot approve their own/);
    expect(() => grantSupportAccess(request(), undefined)).toThrow(/has not approved/);
  });

  it('has nowhere on the screen to ask for anything — the support person files their own request', () => {
    // The local form is gone: no requester, no reason, no scope list, no minutes to grant, no "let them in".
    for (const id of ['who-in', 'grant-reason', 'scopes', 'minutes', 'grant', 'approver']) {
      expect(HTML, `the page still has #${id}`).not.toMatch(new RegExp(`id="${id}"`));
    }
    expect(code(VIEW), 'the view still files or grants access locally').not.toMatch(/session\.grant\(|requesterId:|scopes:\s*\[/);
    // Nothing on this page files a request: the request route is the support person's own.
    expect(code(VIEW) + code(ENTRY).slice(code(ENTRY).indexOf('const SUPPORT_ACCESS_PATH'), code(ENTRY).indexOf('export const HEAD_OFFICE_SUPPORT_ACCESS')), 'the page files a support request')
      .not.toMatch(/support-access\/requests'|support-access\/requests`,|\/support-access\/requests['`]\s*,\s*\{\s*method: 'POST'/);
  });

  it('decides nothing under a name nobody holds, without the owner’s authority, or without head office', () => {
    expect(code(MODEL)).toMatch(/readonly userId: string \| null/);
    const refusal = code(MODEL).slice(code(MODEL).indexOf('const localRefusal = ()'));
    expect(refusal.indexOf("config.userId === null")).toBeGreaterThan(-1);
    expect(refusal.indexOf('ports.mayDecideSupport()')).toBeGreaterThan(-1);
    expect(refusal.indexOf('!connected')).toBeGreaterThan(-1);
    // Every press checks it BEFORE the port is reached.
    for (const action of ['decideSupport: async', 'endSupport: async']) {
      const body = code(MODEL).slice(code(MODEL).indexOf(action));
      expect(body.indexOf('localRefusal()'), action).toBeGreaterThan(-1);
      expect(body.indexOf('localRefusal()'), action).toBeLessThan(body.indexOf('await port.'));
    }
    expect(code(ENTRY)).toMatch(/userId: data\.userId === undefined \? null : data\.userId/);
    // Default-deny: the owner's authority is read from what the box says this person holds — never defaulted.
    expect(code(ENTRY)).toMatch(/mayDecideSupport: \(\) => held\.has\(SUPPORT_DECIDE_PERMISSION\)/);
    expect(code(MODEL)).toMatch(/SUPPORT_DECIDE_PERMISSION = 'platform\.support\.grant'/);
    expect(HTML).toMatch(/id="nobody"/);
  });

  it('has words for every refusal and every state, in both languages', () => {
    const gaps = bilingualGaps(SUPPORT_ACCESS_COPY, SUPPORT_COPY_KEYS);
    expect(gaps.en).toEqual([]);
    expect(gaps.ta).toEqual([]);
    for (const key of SUPPORT_COPY_KEYS) expect(SUPPORT_ACCESS_COPY.ta[key], `"${key}" is not Tamil`).toMatch(/[\u0B80-\u0BFF]/);
    // Every word the page asks the session for exists in the session's copy, or in the page's own sample words.
    const asked = [...new Set([...code(VIEW).matchAll(/\bst\('(\w+)'\)/g)].map((m) => m[1]!))];
    expect(asked.length).toBeGreaterThan(15);
    const missing = asked.filter((k) => !(k in SUPPORT_ACCESS_COPY.en));
    expect(missing, `the page asks the session for words it does not have: ${missing.join(', ')}`).toEqual([]);
  });
});

// ── 2b. A second person's approval is that person's own act — never a typed name (PA-03) ──

describe('the owner’s decision is their own signed-in act — no approver box, and no decider sent', () => {
  const PORT = code(ENTRY).slice(code(ENTRY).indexOf('const SUPPORT_ACCESS_PATH'), code(ENTRY).indexOf('export const HEAD_OFFICE_SUPPORT_ACCESS'));
  expect(PORT.length, 'the browser port was not found').toBeGreaterThan(500);

  it('the page has no approver box, and no words for one', () => {
    expect(HTML, 'the typed approver box is back').not.toMatch(/id="approver"|approver-label/);
    expect(code(VIEW), 'the view still reads a typed approver').not.toMatch(/el\('approver'\)|approverLabel/);
    expect(HTML, 'the page still offers to type who approves').not.toMatch(/Who approves it/);
  });

  it('the view sends no decidedBy / approvedBy — it opens no socket and names nobody', () => {
    expect(code(VIEW), 'the view names a decider').not.toMatch(/\b(decidedBy|approvedBy)\s*:/);
    expect(/\bfetch\s*\(/.test(code(VIEW)), 'the view opens a socket itself').toBe(false);
    expect(code(VIEW).match(/method:\s*'(POST|PUT|PATCH|DELETE)'/g) ?? []).toEqual([]);
    // The decision and the end run only from a click, never on load: each session call sits in one function, and that
    // function is reached only from a button's click handler.
    const view = code(VIEW);
    for (const [call, fn] of [['session.decideSupport(', 'async function decideNow('], ['session.endSupport(', 'async function endNow(']] as const) {
      expect(view.split(call).length - 1, `${call} is called more than once`).toBe(1);
      const at = view.indexOf(call);
      expect(view.lastIndexOf('function ', at), `${call} is not inside ${fn}`).toBe(view.indexOf(fn) + 'async '.length);
      const name = fn.replace('async function ', '').replace('(', '');
      const defined = view.indexOf(fn) + 'async function '.length;
      const uses = [...view.matchAll(new RegExp(`\\b${name}\\(`, 'g'))].map((m) => m.index).filter((i) => i !== defined);
      expect(uses.length, `${name} is never called`).toBeGreaterThan(0);
      for (const use of uses) {
        expect(view.slice(view.lastIndexOf('\n', use), use), `${name} is called outside a click handler`).toMatch(/addEventListener\('click'/);
      }
    }
    expect(view).toMatch(/approve\.addEventListener\('click', \(\) => \{ void busy\(\[approve, reject\], \(\) => decideNow\(request\.requestId, 'approved', input\)\); \}\)/);
    expect(code(VIEW)).toMatch(/reject\.addEventListener\('click', \(\) => \{ void busy\(\[approve, reject\], \(\) => decideNow\(request\.requestId, 'rejected', input\)\); \}\)/);
  });

  it('the browser port POSTs only { decision, grantedMinutes? } in the caller’s own session — never a decider', () => {
    expect(PORT).toMatch(/body: JSON\.stringify\(\{ decision: input\.decision, \.\.\.\(input\.grantedMinutes === undefined \? \{\} : \{ grantedMinutes: input\.grantedMinutes \}\) \}\)/);
    expect(PORT, 'the port puts a decider in a body').not.toMatch(/JSON\.stringify\([^)]*\b(decidedBy|approvedBy|requesterId)\b/);
    expect(PORT.match(/credentials: 'same-origin'/g)?.length).toBe(3);
    expect(PORT.match(/'idempotency-key': key/g)?.length).toBe(2);
  });

  it('the model never puts a decider in what it hands the port', () => {
    const decide = code(MODEL).slice(code(MODEL).indexOf('decideSupport: async'), code(MODEL).indexOf('endSupport: async'));
    expect(decide).toMatch(/await port\.decide\(\{ requestId, decision, \.\.\.\(grantedMinutes === undefined \? \{\} : \{ grantedMinutes \}\) \}\)/);
    expect(decide, 'the model sends a decider').not.toMatch(/decidedBy|approvedBy/);
  });

  it('tripwire — the detectors fire on the shapes they exist to catch', () => {
    expect("approval: { decidedBy: el('approver').value }").toMatch(/\b(decidedBy|approvedBy)\s*:/);
    expect('<input id="approver" type="text" />').toMatch(/id="approver"|approver-label/);
    expect("body: JSON.stringify({ decision, decidedBy: me })").toMatch(/JSON\.stringify\([^)]*\b(decidedBy|approvedBy|requesterId)\b/);
  });
});

// ── 3. Liveness from the clock, never stored ────────────────────────────────

describe('a grant that has expired is not access', () => {
  it('computes it from the clock every time it is read', () => {
    // A stored flag has to be turned off by something, and that something is exactly what did
    // not exist for as long as this control has been in the codebase.
    expect(code(MODEL)).toMatch(/supportSessionActive\(session, at\)/);
    // Head office's list against head office's own clock; the store computer's against the store computer's.
    expect(code(MODEL)).toMatch(/state\.sessions\.map\(\(s\) => viewOf\(s, state\.asAt\)\)/);
    expect(code(MODEL)).toMatch(/ports\.supportSessions\(\)\.map\(\(s\) => viewOf\(s, config\.now\)\)/);
    expect(code(MODEL), 'liveness became a stored flag').not.toMatch(/session\.active\b/);
    // Head office's own `active` is not even carried into the page.
    const reader = code(ENTRY).slice(code(ENTRY).indexOf('export function supportSessionOf'), code(ENTRY).indexOf('export function supportRequestOf'));
    expect(reader, 'the browser carries a stored liveness flag').not.toMatch(/active/);
  });

  it('proves it: the same session is live before its expiry and not after', () => {
    const granted = grantSupportAccess(request(), approval());
    expect(supportSessionActive(granted, NOW)).toBe(true);
    expect(supportSessionActive(granted, '2026-08-06T15:01:00.000Z')).toBe(false);
  });

  it('draws a live session as the loudest thing on the screen', () => {
    // Somebody outside the business is in a customer's live data right now.
    expect(code(VIEW)).toMatch(/view\.active \? 'live' : 'over'/);
    expect(HTML).toMatch(/\.row\.live/);
    expect(code(VIEW)).toMatch(/t\('liveNow'\)/);
  });

  it('shows what a session may touch, its window, and what it did', () => {
    const render = code(VIEW).slice(code(VIEW).indexOf('function sessionNode'));
    expect(render).toMatch(/view\.scopes\.join/);
    expect(render).toMatch(/view\.actionCount/);
    expect(render).toMatch(/session\.reason/);
    expect(render).toMatch(/st\('windowWords'\)/);
    // And a waiting request shows who, why, what and for how long before anyone decides it.
    const waiting = code(VIEW).slice(code(VIEW).indexOf('function waitingNode'));
    expect(waiting).toMatch(/request\.requesterName/);
    expect(waiting).toMatch(/request\.reason/);
    expect(waiting).toMatch(/request\.scopes\.join/);
    expect(waiting).toMatch(/request\.askedMinutes/);
  });

  it('keeps every session — somebody outside the business saw live data', () => {
    // Never pruned (hard rule #6). Nothing on this screen can remove one.
    expect(code(VIEW)).not.toMatch(/\b(delete|remove|purge)Session/i);
    expect(code(SCREEN_DATA)).toMatch(/if \(input\.pack\.supportSessions\.known\) payload\['supportSessions'\]/);
  });
});

// ── 4. Absent policy is unenforced, not compliant ───────────────────────────

describe('what the shop has not decided is not reported as decided', () => {
  it('says nothing is being ENFORCED when there is no version policy', () => {
    // Judging a fleet against a minimum nobody set would report it compliant with a rule the
    // shop never made.
    const fleet = code(MODEL).slice(code(MODEL).indexOf('fleet: () =>'));
    expect(fleet).toMatch(/if \(policy === undefined\) return \{ summary: undefined, verdicts: \[\], policyKnown: false \}/);
    expect(code(ENTRY)).toMatch(/versionPolicy: \(\) => data\?\.versionPolicy,/);
    expect(code(VIEW)).toMatch(/noPolicy/);
  });

  it('says nothing has been DECIDED when there is no retention policy', () => {
    const retention = code(MODEL).slice(code(MODEL).indexOf('retention: () =>'));
    expect(retention).toMatch(/if \(policies\.length === 0\) return undefined/);
    expect(code(VIEW)).toMatch(/noRetention/);
    const en = code(VIEW).slice(code(VIEW).indexOf('en: {'), code(VIEW).indexOf('ta: {'));
    expect(en).toMatch(/noRetention:.*not the same as nothing being due/);
  });

  it('lets a legal hold outrank a retention date, and deletes nothing', () => {
    const retention = readFileSync('packages/audit/src/retention.ts', 'utf8');
    expect(code(retention)).toMatch(/outcome: 'legal_hold'/);
    expect(code(retention)).toMatch(/survives the retention date/);
    // The plan reports; it never removes.
    expect(code(retention), 'the retention plan deletes something').not.toMatch(/\.splice\(|delete /);
    expect(code(VIEW), 'the screen deletes a record').not.toMatch(/\bdeleteRecord|\bpurge\b/i);
  });

  it('serves the screen nothing at all without the shop’s own windows', () => {
    const builder = code(SCREEN_DATA).slice(code(SCREEN_DATA).indexOf('export function adminPayload'));
    expect(builder.slice(0, 200)).toMatch(/if \(!input\.pack\.adminPolicy\.known\) return null;/);
    expect(code(MODEL)).toMatch(/readonly dormantAfterDays: number/);
  });
});

// ── The screen ──────────────────────────────────────────────────────────────

describe('the admin and security screen', () => {
  it('is routed, named and served by the box', () => {
    const server = readFileSync('edge/store-edge/src/screen-server.ts', 'utf8');
    expect(server).toMatch(/admin: \{ dir: 'web-erp', file: 'admin\.html' \}/);
    expect(code(SCREEN_DATA)).toMatch(/admin: 'adminData'/);
    expect(code(SCREEN_DATA)).toMatch(/admin: adminPayload/);
  });

  it('puts outside access first, because it is the most serious thing here', () => {
    expect(HTML.indexOf('id="tab-support"')).toBeLessThan(HTML.indexOf('id="tab-people"'));
    expect(code(VIEW)).toMatch(/show\('support'\)/);
  });

  it('opens with no network and says where the page came from', () => {
    expect(HTML).toMatch(/<!--SCREEN-DATA-->/);
    expect(code(VIEW)).toMatch(/navigator\.serviceWorker\.register\('\.\/sw\.js'\)/);
    // The strip is the ERP chrome's (Stage G slice 5a): the page loads it, the chrome reads the stamp.
    expect(HTML).toMatch(/<script type="module" src="\.\/sre-chrome\.js"><\/script>/);
    expect(readFileSync('apps/web-erp/web/sre-chrome.js', 'utf8')).toMatch(/window\.shellCachedAt/);
  });

  it('never interrupts anybody with a browser dialog — answers go to one live status line', () => {
    expect(code(VIEW)).not.toMatch(/\b(prompt|confirm|alert)\s*\(/);
    expect(HTML).toMatch(/<p class="result" id="support-result" hidden role="status" aria-live="polite">/);
    expect(HTML).toMatch(/<p class="source" id="support-source" role="status" aria-live="polite">/);
    expect(code(VIEW)).toMatch(/paintLine\('support-result', present\(lang\)\)/);
  });

  it('every input is labelled, every target is 48px with a visible focus, and no row is a primary action', () => {
    expect(HTML).toMatch(/:root \{ --tap: 48px; \}/);
    expect(HTML).toMatch(/button \{\s*min-height: var\(--tap\)/);
    expect(HTML).toMatch(/input:focus-visible, select:focus-visible, textarea:focus-visible, button:focus-visible \{\s*outline: 3px solid var\(--focus\)/);
    const waiting = code(VIEW).slice(code(VIEW).indexOf('function waitingNode'), code(VIEW).indexOf('function sessionNode'));
    expect(waiting).toMatch(/label\.htmlFor = inputId/);
    expect(waiting).toMatch(/input\.id = inputId/);
    // One primary action at a time: a list of requests is never a list of primary buttons.
    expect(code(VIEW), 'a row button is marked primary').not.toMatch(/className = '[^']*\bprimary\b/);
  });

  it('says every state in words, not by colour alone', () => {
    expectWordsFor(['ok', 'upgrade_available', 'upgrade_required', 'blocked', 'unknown'], 'VERDICT_WORDS');
    expect(code(VIEW)).toMatch(/account\.flags\.join/);
  });

  it('says plainly when it is not connected to head office, and decides nothing (the sample stand-in)', () => {
    const sample = code(VIEW).slice(code(VIEW).indexOf('function sampleSession'), code(VIEW).indexOf('const real = window.adminSession'));
    expect(sample).toMatch(/connected: false/);
    expect(sample).toMatch(/decideSupport: async \(\) => \(\{ kind: 'not_connected' \}\)/);
    expect(sample).toMatch(/endSupport: async \(\) => \(\{ kind: 'not_connected' \}\)/);
    expect(sample).toMatch(/sampleNotConnected/);
    expect(code(VIEW)).toMatch(/el\('support-decisions'\)\.hidden = !view\.connected/);
    // And a list head office never gave is not "nobody is waiting" (P-08).
    expect(code(VIEW)).toMatch(/nothing\.hidden = !view\.waitingKnown \|\| view\.waiting\.length > 0/);
  });

  it('is offered in Tamil everywhere it is offered in English', () => {
    const en = code(VIEW).slice(code(VIEW).indexOf('en: {'), code(VIEW).indexOf('ta: {'));
    const ta = code(VIEW).slice(code(VIEW).indexOf('ta: {'), code(VIEW).indexOf('};'));
    const keys = (block: string): string[] => [...block.matchAll(/(\w+):\s*['"]/g)].map((m) => m[1]!);
    expect(keys(en).length).toBeGreaterThan(30);
    expect(keys(ta).length).toBe(keys(en).length);
    for (const key of keys(en)) expect(ta, `"${key}" has no Tamil`).toMatch(new RegExp(`\\b${key}:`));
  });
});
