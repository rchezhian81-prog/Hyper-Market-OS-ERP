import { describe, it, expect } from 'vitest';
import * as s from '../../apps/web-erp/src/w5-platform-session';
import { W5_PAGES, wireW5Platform } from '../../apps/web-erp/src/w5-platform-browser-wiring';
import { createApprovalRulesSession } from '../../apps/web-erp/src/approval-rules-session';

// W5 — the platform, access, approvals and data-import sections on the office pages. Each section asks ONLY its route's
// own permission (OB-572), refuses blank input before any call, never writes on open, sends exactly head office's body,
// and shows head office's refusal in its words. Requirements cited, one block each:
//   OB-87 · OB-54 (store computers' registers) · M02-FR-03 (aged approvals; effective authority) · M01-FR-03 (rule history,
//   preview, rollback) · OB-165 · OB-167 (Internal Committee change) · SEC-11 (token revocation) · M33-FR-02 (remote
//   sessions, version policy, remote kill) · M33-FR-04 (licences; service requests) · M32-FR-03 (secrets — never a value)
//   · M35-FR-04 (link an alert) · M33-FR-03 (support-access review) · PA-09 (audited reprint) · M29-FR-04 (schedule runs)
//   · M29-FR-02 (drill audits) · OB-82 (legacy till placement) · OB-315 (dry runs) · M30-FR-04 (import quality).

type Call = { method: string; url: string; body?: unknown; key?: string };
const recorder = (answers: Record<string, { status?: number; body: unknown }> = {}) => {
  const calls: Call[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url); const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method, url: u, ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }), ...(headers['idempotency-key'] === undefined ? {} : { key: headers['idempotency-key'] }) });
    const a = answers[`${method} ${u}`] ?? answers[u] ?? { body: {} };
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200 });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
};
const who = (...permissions: string[]) => ({ userId: 'u-boss', permissions });
const NOBODY = { permissions: ['platform.health.read'] };

describe('every section refuses before any call when nobody is signed in or the role lacks the route\'s word', () => {
  it('nobody → "nobody"; no word → "cannot"; nothing reaches head office', async () => {
    const r = recorder();
    const reg = s.createStoreComputerRegistersSession({ viewer: NOBODY, fetch: r.fetch });
    expect(await reg.conflicts()).toEqual({ result: 'invalid', why: 'nobody' });
    const aged = s.createAgedApprovalsSession({ viewer: who('platform.health.read'), fetch: r.fetch });
    expect(aged.may.read).toBe(false);
    expect(await aged.read()).toEqual({ result: 'invalid', why: 'cannot' });
    const kill = s.createFleetControlSession({ viewer: who('platform.health.read'), fetch: r.fetch });
    expect(kill.may).toEqual({ read: true, manage: false });
    expect(await kill.kill('1.2.0', true)).toEqual({ result: 'invalid', why: 'cannot' });
    expect(r.calls).toEqual([]);
    expect(s.w5OutcomeWords('en', { result: 'invalid', why: 'cannot' })).toBe('Your role cannot do this.');
    expect(s.w5OutcomeWords('ta', { result: 'invalid', why: 'nobody' })).toMatch(/உள்நுழையவில்லை/);
  });

  it('head office\'s refusal is shown in its own words; a lost link says nothing changed', async () => {
    const r = recorder({ '/v1/idempotency-conflicts': { status: 403, body: { error: { code: 'forbidden', whatHappened: 'This role may not read it.' } } } });
    const reg = s.createStoreComputerRegistersSession({ viewer: who('platform.health.read'), fetch: r.fetch });
    const out = await reg.conflicts();
    expect(s.w5OutcomeWords('en', out)).toBe('Head office refused: This role may not read it.');
    const lost = s.createAgedApprovalsSession({ viewer: who('approvals.rules.read'), fetch: (async () => { throw new Error('down'); }) as typeof fetch });
    expect(s.w5OutcomeWords('en', await lost.read())).toBe('Head office cannot be reached — nothing was changed.');
  });

  it('every English word has a Tamil twin', () => {
    expect(Object.keys(s.W5_WORDS.ta).sort()).toEqual(Object.keys(s.W5_WORDS.en).sort());
  });
});

describe('OB-87 · OB-54: the store computers\' registers are read, never written', () => {
  it('reads the conflicts, the refusals (with claims overruled) and the stamps — GETs only — and says each in a line', async () => {
    const r = recorder({
      '/v1/idempotency-conflicts': { body: { conflicts: [{ conflictId: 'c1', userId: 'box-1', branchId: 'store-1', method: 'POST', path: '/v1/sales', idempotencyKey: 'k', receiptNumber: 'S1-0007', at: '2026-11-03T05:00:00Z', detail: 'the same key came back with a different bill' }] } },
      '/v1/store-computers/refusals': { body: { refusals: [{ refusalId: 'r1', userId: 'box-2', credentialStore: 'store-2', reason: 'record_names_another_store', namedStore: 'store-1', field: 'storeId', method: 'POST', path: '/v1/sales', at: '2026-11-03T05:01:00Z' }], overruledClaims: [] } },
      '/v1/store-computers/stamps': { body: { stamps: [{ stampId: 's1', userId: 'box-1', store: 'store-1', field: null, method: 'POST', path: '/v1/cash', at: '2026-11-03T05:02:00Z' }] } },
    });
    const reg = s.createStoreComputerRegistersSession({ viewer: who('platform.health.read'), fetch: r.fetch });
    const c = await reg.conflicts(); const f = await reg.refusals(); const st = await reg.stamps();
    expect(r.calls.map((x) => `${x.method} ${x.url}`)).toEqual(['GET /v1/idempotency-conflicts', 'GET /v1/store-computers/refusals', 'GET /v1/store-computers/stamps']);
    if (c.result !== 'ok' || f.result !== 'ok' || st.result !== 'ok') throw new Error('not ok');
    expect(s.conflictLine('en', c.value[0]!)).toBe('2026-11-03T05:00:00Z · box-1 · store-1 · POST /v1/sales · bill S1-0007 — the same key came back with a different bill');
    expect(s.refusalLine('en', f.value.refusals[0]!)).toContain('its sign-in is for store store-2 · it named store store-1 (storeId)');
    expect(s.stampLine('en', st.value[0]!)).toBe('2026-11-03T05:02:00Z · box-1 → store-1 · POST /v1/cash');
  });
});

describe('M02-FR-03: the aged approvals report', () => {
  it('lists what still waits, longest first, with when it goes to the owner — and an unset wait is said, never invented', async () => {
    const r = recorder({ '/v1/approvals/escalations': { body: { asAt: 'now', waiting: [
      { requestId: 'a', kind: 'refund', requestedBy: 'u-c', requestedAt: 'x', valueMinor: 50000, summary: 'Refund bill 7', waitMinutes: 30, waitedMinutes: 12, escalatesAt: '2026-11-03T06:00:00Z', escalated: false },
      { requestId: 'b', kind: 'stock_adjustment', requestedBy: 'u-d', requestedAt: 'x', valueMinor: null, summary: 'Write off 3 milk', waitedMinutes: 90, escalatesAt: null, escalated: true },
    ], escalations: [] } } });
    const out = await s.createAgedApprovalsSession({ viewer: who('approvals.rules.read'), fetch: r.fetch }).read();
    if (out.result !== 'ok') throw new Error('not ok');
    expect(out.value.waiting.map((x) => x.requestId)).toEqual(['b', 'a']);
    expect(s.waitingLine('en', out.value.waiting[1]!)).toBe('Refund bill 7 · ₹500.00 · u-c · waited 12 minutes (the wait is 30 minutes) · goes to the owner at 2026-11-03T06:00:00Z');
    expect(s.waitingLine('en', out.value.waiting[0]!)).toBe('Write off 3 milk · u-d · waited 90 minutes (no wait set) · already sent to the owner');
  });
});

describe('M01-FR-03: a rule\'s history, a preview of an older version, and a rollback asked, approved and applied', () => {
  const versions = [
    { version: 1, value: { refund: 30, purchase_order: 60, stock_adjustment: 60 }, author: 'u-owner', reason: 'first', effectiveAt: 'e1', rolledBackFrom: null },
    { version: 2, value: { refund: 45, purchase_order: 60, stock_adjustment: 60 }, author: 'u-owner', reason: 'longer refunds', effectiveAt: 'e2', rolledBackFrom: null },
  ];
  it('reads the history and previews going back (the older value against the rule in force) — nothing written', async () => {
    const r = recorder({
      '/v1/approvals/rules/escalation-waits/history': { body: { rule: 'escalation-waits', versions, inForce: { version: 2 } } },
      'POST /v1/approvals/rules/escalation-waits/preview': { body: { valid: true, changes: [{ field: 'refund', from: 45, to: 30 }], needsSecondPerson: true } },
    });
    const h = s.createRuleHistorySession({ viewer: who('approvals.rules.read'), fetch: r.fetch });
    expect(h.may).toEqual({ read: true, propose: false });
    const hist = await h.history('escalation-waits');
    if (hist.result !== 'ok') throw new Error('not ok');
    expect(s.versionLine('en', hist.value.versions[1]!)).toBe('Version 2 · u-owner · e2 · longer refunds');
    const p = await h.preview('escalation-waits', versions[0]!);
    expect(r.calls[1]).toMatchObject({ method: 'POST', url: '/v1/approvals/rules/escalation-waits/preview', body: { value: versions[0]!.value } });
    if (p.result !== 'ok') throw new Error('not ok');
    expect(s.previewLines('en', p.value)).toEqual(['It would change:', 'refund: 45 → 30', 'It needs a second person\'s approval.']);
    expect(s.previewLines('en', { valid: false, why: 'unknown role' })).toEqual(['This version would not be valid now: unknown role']);
    expect(s.previewLines('en', { valid: true, changes: [] })).toEqual(['Going back to this version changes nothing.']);
    expect(await h.askRollback('escalation-waits', 1, 2, 'x')).toEqual({ result: 'invalid', why: 'cannot' });
  });

  it('asks with exactly the rollback route\'s body, lists only rollbacks, and applies an approved one through the rollback route', async () => {
    const r = recorder({ '/v1/approvals/requests': { body: { mine: [
      { requestId: 'q1', kind: 'approval_rule_change', status: 'approved', decidedBy: 'u-acct', details: { rule: 'escalation-waits', toVersion: 1, basedOnVersion: 2, reason: 'too long' } },
      { requestId: 'q2', kind: 'approval_rule_change', status: 'pending', details: { rule: 'limits', value: {}, basedOnVersion: 3, reason: 'figures' } },
    ] } } });
    const h = s.createRuleHistorySession({ viewer: who('approvals.rules.read', 'approvals.rules.propose'), fetch: r.fetch });
    expect(await h.askRollback('escalation-waits', 1, 2, '  ')).toEqual({ result: 'invalid', why: 'needReason' });
    expect(r.calls).toEqual([]);
    await h.askRollback('escalation-waits', 1, 2, ' too long ');
    expect(r.calls[0]).toMatchObject({ method: 'POST', url: '/v1/approvals/requests', body: { kind: 'approval_rule_change', subjectRef: 'rule:escalation-waits', details: { rule: 'escalation-waits', toVersion: 1, basedOnVersion: 2, reason: 'too long' } } });
    expect(r.calls[0]!.key).toMatch(/^rule-history-/);
    const asked = await h.asked();
    if (asked.result !== 'ok') throw new Error('not ok');
    expect(asked.value.map((a) => a.requestId)).toEqual(['q1']);
    await h.apply(asked.value[0]!);
    expect(r.calls.at(-1)).toMatchObject({ method: 'POST', url: '/v1/approvals/rules/escalation-waits/rollback', body: { toVersion: 1, basedOnVersion: 2, reason: 'too long', approvalId: 'q1' } });
    // The figure-change list on the same page no longer offers a rollback for its PUT.
    const page = createApprovalRulesSession({ viewer: who('approvals.rules.read', 'approvals.rules.propose'), fetch: recorder({ '/v1/approvals/rules': { body: { rules: { limits: {}, 'escalation-waits': {}, 'price-check': {} } } }, '/v1/approvals/requests': { body: { mine: [
      { requestId: 'q1', kind: 'approval_rule_change', status: 'approved', details: { rule: 'escalation-waits', toVersion: 1, basedOnVersion: 2, reason: 'too long' } },
      { requestId: 'q2', kind: 'approval_rule_change', status: 'pending', details: { rule: 'limits', value: {}, basedOnVersion: 3, reason: 'figures' } },
    ] } } }).fetch });
    const read = await page.read();
    if (read.result !== 'ok') throw new Error('not ok');
    expect(read.value.asked.map((a) => a.requestId)).toEqual(['q2']);
  });
});

describe('M02-FR-03: what may this person approve today (effective authority)', () => {
  it('asks head office with who, which kind and an optional day; a malformed day is refused before any call', async () => {
    const r = recorder({ 'POST /v1/access/delegations/effective-authority': { body: { userId: 'u-asst', source: 'delegated', branchScope: ['store-1'], authorityLimit: { minor: 200000, currency: 'INR' }, onBehalfOf: 'u-mgr', detail: 'u-asst may decide refund under u-mgr' } } });
    const e = s.createEffectiveAuthoritySession({ viewer: who('approvals.delegation.read'), fetch: r.fetch });
    expect(await e.ask('u-asst', 'refund', '3/11/2026')).toEqual({ result: 'invalid', why: 'notDate' });
    expect(await e.ask(' ', 'refund', '')).toEqual({ result: 'invalid', why: 'needAll' });
    const out = await e.ask(' u-asst ', 'refund', '');
    expect(r.calls).toEqual([expect.objectContaining({ method: 'POST', url: '/v1/access/delegations/effective-authority', body: { userId: 'u-asst', subjectType: 'refund' } })]);
    if (out.result !== 'ok') throw new Error('not ok');
    expect(s.effectiveLine('en', out.value)).toBe('Lent to them (on behalf of u-mgr) · up to ₹2,000.00 · stores store-1 — u-asst may decide refund under u-mgr');
    expect(s.effectiveLine('en', { userId: 'x', source: 'none', branchScope: [], authorityLimit: null, detail: 'x has no authority over refund' })).toBe('No authority — x has no authority over refund');
  });
});

describe('OB-165 · OB-167: an Internal Committee member change is asked, approved by a second person, then applied', () => {
  it('asks with exactly the change route\'s body plus its change id, and applies an approved one naming that approval', async () => {
    const r = recorder({ '/v1/approvals/requests': { body: { mine: [{ requestId: 'ap-1', kind: 'posh_committee_change', status: 'approved', decidedBy: 'u-mgr', details: { action: 'add', userId: 'u-hr', reason: 'new member', changeId: 'ic-1' } }] } } });
    const c = s.createCommitteeChangeSession({ viewer: who('posh.committee.manage'), fetch: r.fetch, newChangeId: () => 'ic-1' });
    expect(await c.ask('add', '', 'x')).toEqual({ result: 'invalid', why: 'needAll' });
    expect(await c.ask('add', 'u-hr', '')).toEqual({ result: 'invalid', why: 'needReason' });
    await c.ask('add', ' u-hr ', ' new member ');
    expect(r.calls[0]).toMatchObject({ method: 'POST', url: '/v1/approvals/requests', body: { kind: 'posh_committee_change', subjectRef: 'ic-1', details: { action: 'add', userId: 'u-hr', reason: 'new member', changeId: 'ic-1' }, valueMinor: null } });
    const asked = await c.asked();
    if (asked.result !== 'ok') throw new Error('not ok');
    await c.apply(asked.value[0]!);
    expect(r.calls.at(-1)).toMatchObject({ method: 'POST', url: '/v1/identity/internal-committee/changes/ic-1', body: { action: 'add', userId: 'u-hr', reason: 'new member', approvalId: 'ap-1' } });
    expect(s.createCommitteeChangeSession({ viewer: who('identity.role.request') }).may.manage).toBe(false);
  });
});

describe('SEC-11: revoke a person\'s sign-ins now, or one sign-in', () => {
  it('sends exactly one target with a listed reason, and reads the record newest first', async () => {
    const r = recorder({ '/v1/identity/token-revocations': { body: { revocations: [
      { id: 'rev-1', userId: 'u-old', issuedBefore: 1793000000, reason: 'security', revokedBy: 'u-owner', revokedAt: '2026-11-01T00:00:00Z' },
      { id: 'rev-2', jti: 'tok-9', reason: 'admin_revoked', revokedBy: 'u-owner', revokedAt: '2026-11-02T00:00:00Z' },
    ] } } });
    const v = s.createTokenRevocationSession({ viewer: who('identity.session.revoke'), fetch: r.fetch });
    expect(await v.revoke('user', 'u-old', 'because')).toEqual({ result: 'invalid', why: 'needAll' });
    await v.revoke('user', ' u-old ', 'security');
    await v.revoke('token', 'tok-9', 'admin_revoked');
    expect(r.calls.map((c) => c.body)).toEqual([{ userId: 'u-old', reason: 'security' }, { jti: 'tok-9', reason: 'admin_revoked' }]);
    const list = await v.list();
    if (list.result !== 'ok') throw new Error('not ok');
    expect(list.value.map((x) => x.id)).toEqual(['rev-2', 'rev-1']);
    expect(s.revocationLine('en', list.value[0]!)).toBe('2026-11-02T00:00:00Z · token tok-9 · Taken off by an administrator · by u-owner');
  });
});

describe('M33-FR-02: remote sessions, the version policy and the remote kill of a broken release', () => {
  it('ends a session only with a reason; a policy keeps the releases already withdrawn; a kill needs a version and a tick', async () => {
    const r = recorder();
    const f = s.createFleetControlSession({ viewer: who('platform.health.read', 'platform.device.manage'), fetch: r.fetch });
    expect(await f.terminate('rs-1', ' ')).toEqual({ result: 'invalid', why: 'needReason' });
    await f.terminate('rs-1', ' work done ');
    expect(r.calls[0]).toMatchObject({ method: 'POST', url: '/v1/platform/remote-sessions/rs-1/terminate', body: { reason: 'work done' } });
    expect(await f.setPolicy({ current: '1.4', previous: '', minimum: 'one' }, null)).toEqual({ result: 'invalid', why: 'notVersion' });
    await f.setPolicy({ current: '1.5.0', previous: '1.4.0', minimum: '1.3.0' }, { currentVersion: '1.4.0', minimumSupportedVersion: '1.3.0', killedVersions: ['1.4.1'] });
    expect(r.calls[1]).toMatchObject({ url: '/v1/platform/version-policy', body: { policy: { currentVersion: '1.5.0', previousVersion: '1.4.0', minimumSupportedVersion: '1.3.0', killedVersions: ['1.4.1'] } } });
    expect(await f.kill('1.4.1', false)).toEqual({ result: 'invalid', why: 'confirmKill' });
    await f.kill(' 1.4.1 ', true);
    expect(r.calls[2]).toMatchObject({ url: '/v1/platform/version-policy/kill', body: { version: '1.4.1' } });
    expect(s.policyLines('en', null)).toEqual(['No version policy is set yet.']);
    expect(s.policyLines('en', { currentVersion: '1.5.0', minimumSupportedVersion: '1.3.0' })).toEqual(['Current version: 1.5.0', 'Previous version (optional): Not set', 'Oldest version still allowed: 1.3.0', 'Withdrawn releases: —']);
    expect(s.remoteLine('en', { sessionId: 'rs-1', deviceId: 'pos-2', userId: 'u-sup', kind: 'remote', openedAt: 'o', lastSeenAt: 'l', active: false, terminatedBy: 'u-owner', terminatedReason: 'work done' }))
      .toBe('rs-1 · for u-sup · on pos-2 · remote · opened o · last seen l · ended by u-owner — work done');
  });
});

describe('M33-FR-04: licences with a named owner, and the platform\'s service requests', () => {
  it('records a licence only with a named owner and a real date; the expiry is optional (never invented)', async () => {
    const r = recorder();
    const l = s.createLicencesSession({ viewer: who('platform.entitlement.read', 'platform.entitlement.manage'), fetch: r.fetch });
    const f = { moduleId: 'm-tally', name: 'Tally link', enabled: true, expiresOn: '', ownerUserId: 'u-owner', ownerName: '' };
    expect(await l.record(f)).toEqual({ result: 'invalid', why: 'needAll' });
    expect(await l.record({ ...f, ownerName: 'Owner', expiresOn: '31/03/2027' })).toEqual({ result: 'invalid', why: 'notDate' });
    await l.record({ ...f, ownerName: 'Owner' });
    expect(r.calls[0]).toMatchObject({ url: '/v1/platform/licences/m-tally', body: { name: 'Tally link', enabled: true, ownerUserId: 'u-owner', ownerName: 'Owner' } });
    expect((r.calls[0]!.body as Record<string, unknown>)['expiresOn']).toBeUndefined();
    expect(s.licenceLine('en', { moduleId: 'm-tally', name: 'Tally link', enabled: true, ownerUserId: 'u-owner', ownerName: 'Owner' })).toBe('Tally link (m-tally) · on · no end date · renewed by Owner (u-owner)');
  });

  it('raises, assigns and moves a service request; resolving needs a note', async () => {
    const r = recorder();
    const sr = s.createServiceRequestsSession({ viewer: who('platform.service.read', 'platform.service.manage'), fetch: r.fetch, newRequestId: () => 'sr-1' });
    expect(await sr.raise({ title: 'x', detail: '', category: '', priority: 'high' })).toEqual({ result: 'invalid', why: 'needAll' });
    await sr.raise({ title: ' Printer driver ', detail: ' lane 3 prints blank ', category: '', priority: 'high' });
    expect(r.calls[0]).toMatchObject({ url: '/v1/platform/service-requests', body: { requestId: 'sr-1', title: 'Printer driver', detail: 'lane 3 prints blank', priority: 'high' } });
    await sr.assign('sr-1', 'u-it');
    expect(await sr.move('sr-1', 'resolved', '')).toEqual({ result: 'invalid', why: 'needReason' });
    await sr.move('sr-1', 'resolved', 'driver reinstalled');
    expect(r.calls.slice(1).map((c) => [c.url, c.body])).toEqual([
      ['/v1/platform/service-requests/sr-1/assign', { assignedTo: 'u-it' }],
      ['/v1/platform/service-requests/sr-1/status', { status: 'resolved', note: 'driver reinstalled' }],
    ]);
  });
});

describe('M32-FR-03: secrets — which exist, their age and rotation state; NEVER a value', () => {
  it('keeps only the named fields of each secret (anything else is dropped) and reviews without writing', async () => {
    const r = recorder({
      '/v1/integration/secrets': { body: { secrets: [{ secretId: 'pay', kind: 'payment_provider', vaultRef: 'vault://payments/live#v4', version: 4, state: 'active', createdOn: '2026-01-01', owner: 'u-it', protects: 'card payments', rotateEveryDays: 90, environment: 'production', value: 'SHOULD-NEVER-SHOW', secret: 'NOPE' }] } },
      'POST /v1/integration/secrets/review': { body: { issues: [{ secretId: 'pay', kind: 'payment_provider', finding: 'overdue_rotation', owner: 'u-it', blocking: false, detail: 'card payments: rotation overdue by 30 days' }], detail: '1 needs attention' } },
    });
    const sec = s.createSecretsSession({ viewer: who('platform.setup.read'), fetch: r.fetch });
    const inv = await sec.inventory();
    if (inv.result !== 'ok') throw new Error('not ok');
    expect(JSON.stringify(inv.value)).not.toMatch(/SHOULD-NEVER-SHOW|NOPE/);
    const line = s.secretLine('en', inv.value[0]!);
    expect(line).toContain('kept at vault://payments/live#v4');
    expect(line).toContain('made 2026-01-01 · never changed · change every 90 days · state: in use');
    const rev = await sec.review();
    expect(r.calls[1]).toMatchObject({ method: 'POST', url: '/v1/integration/secrets/review', body: {} });
    if (rev.result !== 'ok') throw new Error('not ok');
    expect(rev.value.issues).toEqual([{ secretId: 'pay', finding: 'overdue_rotation', blocking: false, detail: 'card payments: rotation overdue by 30 days' }]);
    // The section offers no way to register, rotate or revoke: those are not in its session at all.
    // W6 · OB-688: the one addition is the read-only 30-day use list — still no register, rotate or revoke.
    expect(Object.keys(sec)).toEqual(['may', 'inventory', 'review', 'usage']);
  });
});

describe('M35-FR-04: link a raised alert to an open incident', () => {
  it('offers only open incidents and raised alerts, and links one', async () => {
    const r = recorder({
      '/v1/platform/incidents': { body: { incidents: [{ incidentId: 'inc-1', title: 'Tills slow', state: 'open', alertIds: [] }, { incidentId: 'inc-0', title: 'Old', state: 'closed', alertIds: [] }] } },
      '/v1/platform/alerts': { body: { alerts: [{ alert: { alertId: 'al-1', component: 'sync', status: 'degraded', detail: 'lagging' }, state: 'open' }] } },
    });
    const a = s.createIncidentAlertSession({ viewer: who('platform.health.read', 'platform.alert.manage'), fetch: r.fetch });
    const ch = await a.choices();
    if (ch.result !== 'ok') throw new Error('not ok');
    expect(ch.value.incidents.map((i) => i.incidentId)).toEqual(['inc-1']);
    expect(ch.value.alerts).toEqual([{ alertId: 'al-1', component: 'sync', status: 'degraded', detail: 'lagging' }]);
    await a.link('inc-1', 'al-1');
    expect(r.calls.at(-1)).toMatchObject({ method: 'POST', url: '/v1/platform/incidents/inc-1/alerts', body: { alertId: 'al-1' } });
  });
});

describe('M33-FR-03 · PA-09 · M29-FR-04 · M29-FR-02 · OB-82 · OB-315 · M30-FR-04: the remaining reads and acts', () => {
  it('support review, drill audits and schedule runs are GETs said in plain lines', async () => {
    const r = recorder({
      '/v1/platform/support-access/review': { body: { review: [{ sessionId: 'sa-1', requesterName: 'Vendor', approvedBy: 'u-owner', reason: 'printer', scopes: ['pos.read'], startedAt: 's', minutes: 30, actionCount: 0, active: false, unused: true }] } },
      '/v1/reporting/drill-audits': { body: { audits: [{ userId: 'u-owner', metric: 'net_sales', at: 'a', transactionsShown: 12, transactionsWithheld: 1, reconciled: true }] } },
      '/v1/reporting/report-schedules/sched-1/runs': { body: { runs: [{ scheduleId: 'sched-1', kind: 'report', tradingDay: '2026-11-02', reason: 'missed_catch_up', ranAt: 'r', outcome: 'prepared', lines: ['Sales ₹1,000'], hasFile: false }] } },
    });
    const sup = await s.createSupportReviewSession({ viewer: who('platform.support.read'), fetch: r.fetch }).review();
    const dr = await s.createDrillAuditsSession({ viewer: who('owner.kpi.read'), fetch: r.fetch }).read();
    const runs = await s.createScheduleRunsSession({ viewer: who('owner.kpi.read'), fetch: r.fetch }).runs('sched-1');
    if (sup.result !== 'ok' || dr.result !== 'ok' || runs.result !== 'ok') throw new Error('not ok');
    expect(s.supportReviewLine('en', sup.value[0]!)).toBe('Vendor · approved by u-owner · printer · pos.read · s · 30 minutes · 0 actions · approved but never used');
    expect(s.drillAuditLine('en', dr.value[0]!)).toBe('a · u-owner · net_sales · 12 shown · 1 kept back · adds up');
    expect(s.scheduleRunLine('en', runs.value[0]!)).toBe('2026-11-02 · prepared · caught up after a miss · r — Sales ₹1,000');
    expect(r.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('PA-09: a document is found as issued and reprinted only with a reason', async () => {
    const r = recorder();
    const d = s.createReprintSession({ viewer: who('document.template.read', 'document.issue'), fetch: r.fetch });
    expect(await d.find(' ')).toEqual({ result: 'invalid', why: 'needAll' });
    await d.find('doc-1');
    expect(await d.reprint('doc-1', '')).toEqual({ result: 'invalid', why: 'needReason' });
    await d.reprint('doc-1', ' customer lost it ');
    expect(r.calls.map((c) => [c.method, c.url, c.body])).toEqual([['GET', '/v1/documents/issued/doc-1', undefined], ['POST', '/v1/documents/issued/doc-1/reprint', { reason: 'customer lost it' }]]);
    expect(s.createReprintSession({ viewer: who('document.template.read') }).may).toEqual({ read: true, reprint: false });
  });

  it('OB-82: a till\'s old records are looked up at a store and placed there once, with a reason', async () => {
    const r = recorder();
    const l = s.createLegacyPlacementSession({ viewer: who('cash.till.read', 'till.overshort.review'), fetch: r.fetch });
    await l.look('till-7', 'store-1');
    expect(await l.place('till-7', 'store-1', '')).toEqual({ result: 'invalid', why: 'needReason' });
    await l.place('till-7', ' store-1 ', ' it was always here ');
    expect(r.calls.map((c) => [c.method, c.url, c.body])).toEqual([['GET', '/v1/tills/till-7/cash?storeId=store-1', undefined], ['POST', '/v1/tills/till-7/legacy-placement', { storeId: 'store-1', reason: 'it was always here' }]]);
    expect(s.legacyLine('en', { tillId: 'till-7', storeId: 'store-1', unplacedLegacy: { movements: 3, balanceMinor: 125000 } })).toBe('Not placed at any store: 3 movements · balance ₹1,250.00');
    expect(s.legacyLine('en', { tillId: 'till-7', storeId: 'store-1' })).toBe('This till has no old records to place.');
  });

  it('OB-315 · M30-FR-04: a dry run is kept with the template id and the file; quality and the job history are read', async () => {
    const r = recorder({ '/v1/purchase/import-quality': { body: { sources: [{ sourceId: 'sup-a', jobs: 4, totalRows: 400, rejectedRows: 40, acceptedBps: 9000, band: 'fair', direction: 'steady', annualFixHours: 12 }], worthAConversation: ['sup-a'], totalAnnualFixHours: 12, detail: '1 source' } } });
    const c = s.createImportChecksSession({ viewer: who('purchase.import.read'), fetch: r.fetch, newRunId: () => 'dry-1' });
    expect(await c.keep('product-v1', ' ', '')).toEqual({ result: 'invalid', why: 'needAll' });
    expect(await c.keep('product-v1', 'sku,name', '12.5')).toEqual({ result: 'invalid', why: 'notMoney' });
    await c.keep('product-v1', 'sku,name\nA,Rice', '');
    expect(r.calls[0]).toMatchObject({ method: 'POST', url: '/v1/import/dry-runs/dry-1', body: { templateId: 'product-v1', text: 'sku,name\nA,Rice' } });
    const q = await c.quality(); await c.jobs(); await c.dryRuns();
    if (q.result !== 'ok') throw new Error('not ok');
    expect(s.qualityLine('en', q.value.sources[0]!)).toBe('sup-a · 4 · 400 rows · 90.0% accepted · fair · steady · 12 hours a year to fix');
    expect(r.calls.slice(1).map((x) => x.url)).toEqual(['/v1/purchase/import-quality', '/v1/purchase/import-jobs', '/v1/import/dry-runs']);
  });
});

describe('the wiring: each page\'s viewer builds only that page\'s sections', () => {
  it('builds the store computers\' registers from its own global, and nothing for a page that is not open', () => {
    const win: Record<string, unknown> = { storeComputersData: { userId: 'u-boss', permissions: ['platform.health.read'] } };
    wireW5Platform(win, (raw) => raw as { userId?: string; permissions: string[] });
    const got = win['w5Platform'] as { sessions: Record<string, { may: unknown }> };
    expect(Object.keys(got.sessions)).toEqual(['registers']);
    expect(got.sessions['registers']!.may).toEqual({ read: true });
    expect(Object.keys(W5_PAGES)).toHaveLength(15);
  });
});

describe('OB-681 · OB-143: the Users page asks for the chartered accountant\'s role, and applies it once the IT custodian approves', () => {
  it('asks with exactly the grant route\'s body plus its change id, lists only CA requests, and applies an approved one', async () => {
    const r = recorder({ '/v1/approvals/requests': { body: { mine: [
      { requestId: 'ap-9', kind: 'ca_role_grant', status: 'approved', decidedBy: 'u-siva', details: { userId: 'u-ca', reason: 'fills the lists', changeId: 'ca-1' } },
      { requestId: 'ap-8', kind: 'posh_committee_change', status: 'approved', details: { action: 'add', userId: 'u-hr', reason: 'x', changeId: 'ic-1' } },
    ] } } });
    const c = s.createCaGrantSession({ viewer: who('identity.ca.grant.request'), fetch: r.fetch, newChangeId: () => 'ca-1' });
    expect(await c.ask(' ', 'x')).toEqual({ result: 'invalid', why: 'needAll' });
    expect(await c.ask('u-ca', ' ')).toEqual({ result: 'invalid', why: 'needReason' });
    await c.ask(' u-ca ', ' fills the lists ');
    expect(r.calls[0]).toMatchObject({ url: '/v1/approvals/requests', body: { kind: 'ca_role_grant', subjectRef: 'ca-1', details: { userId: 'u-ca', reason: 'fills the lists', changeId: 'ca-1' } } });
    const asked = await c.asked();
    if (asked.result !== 'ok') throw new Error('not ok');
    expect(asked.value.map((a) => a.requestId)).toEqual(['ap-9']);
    await c.apply(asked.value[0]!);
    expect(r.calls.at(-1)).toMatchObject({ method: 'POST', url: '/v1/identity/chartered-accountant/grants/ca-1', body: { userId: 'u-ca', reason: 'fills the lists', approvalId: 'ap-9' } });
    expect(s.createCaGrantSession({ viewer: who('identity.role.request') }).may.ask).toBe(false);
  });
});
