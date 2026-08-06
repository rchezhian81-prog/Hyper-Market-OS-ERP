import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { GRANT_REFUSAL_KINDS } from '../../apps/web-erp/src/admin-session';
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
 * Four things must stay true:
 *
 *   1. **one implementation**, and the service maps HTTP to it and nothing else;
 *   2. **blanket access cannot be granted**, and the screen cannot ask for it;
 *   3. **liveness is computed from the clock**, never stored;
 *   4. absent policy is reported as **unenforced**, never as compliant.
 */

const SERVICE = readFileSync('services/platform/src/index.ts', 'utf8');
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
    expect(code(SERVICE)).toMatch(/grantSupportAccess\(body\.request, body\.approval\)/);
  });

  it('the screen uses the same one, not a third', () => {
    expect(code(MODEL)).toMatch(/from '\.\.\/\.\.\/\.\.\/packages\/platform-admin\/src\/index'/);
    expect(code(MODEL)).toMatch(/grantSupportAccess\(input\.request, input\.approval\)/);
    expect(code(MODEL), 'the screen re-decides the rules itself')
      .not.toMatch(/minutes > |scopes\.length === 0/);
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

  it('has nowhere on the screen to ask for everything', () => {
    // The scopes box is not optional decoration: an empty one is refused by the rule.
    expect(HTML).toMatch(/id="scopes"/);
    const grant = code(VIEW).slice(code(VIEW).indexOf("el('grant').addEventListener"));
    expect(grant).toMatch(/\.split\('\\n'\)\.map\(\(s\) => s\.trim\(\)\)\.filter\(\(s\) => s !== ''\)/);
    expect(grant, 'the screen defaults the scopes to everything').not.toMatch(/scopes: \['\*'\]|scopes: \[\]/);
  });

  it('grants nothing under a name nobody holds', () => {
    expect(code(MODEL)).toMatch(/readonly userId: string \| null/);
    const grant = code(MODEL).slice(code(MODEL).indexOf('grant: (input)'));
    expect(grant.indexOf('config.userId === null')).toBeLessThan(grant.indexOf('grantSupportAccess('));
    expect(code(ENTRY)).toMatch(/userId: data\.userId === undefined \? null : data\.userId/);
    expect(HTML).toMatch(/id="nobody"/);
  });

  it('has words for every refusal, in both languages', () => {
    expectWordsFor(GRANT_REFUSAL_KINDS, 'GRANT_REFUSAL_WORDS');
  });
});

// ── 3. Liveness from the clock, never stored ────────────────────────────────

describe('a grant that has expired is not access', () => {
  it('computes it from the clock every time it is read', () => {
    // A stored flag has to be turned off by something, and that something is exactly what did
    // not exist for as long as this control has been in the codebase.
    expect(code(MODEL)).toMatch(/supportSessionActive\(session, config\.now\)/);
    expect(code(MODEL), 'liveness became a stored flag').not.toMatch(/session\.active\b/);
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

  it('shows what a session may touch, and what it did', () => {
    const render = code(VIEW).slice(code(VIEW).indexOf('function renderSupport'));
    expect(render).toMatch(/view\.scopes\.join/);
    expect(render).toMatch(/view\.actionCount/);
    expect(render).toMatch(/session\.reason/);
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
    expect(code(VIEW)).toMatch(/window\.shellCachedAt/);
  });

  it('never interrupts anybody with a browser dialog', () => {
    expect(code(VIEW)).not.toMatch(/\b(prompt|confirm|alert)\s*\(/);
    expect(code(VIEW)).toMatch(/function tell\(/);
  });

  it('says every state in words, not by colour alone', () => {
    expectWordsFor(['ok', 'upgrade_available', 'upgrade_required', 'blocked', 'unknown'], 'VERDICT_WORDS');
    expect(code(VIEW)).toMatch(/account\.flags\.join/);
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
