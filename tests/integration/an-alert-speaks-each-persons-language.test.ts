import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { recordingTransport } from '../../packages/notifications/src/index';
import { alertLifecycleAdapter } from '../../services/api/src/adapters';
import { deliverAlerts, OPS_ALERT_WORKER } from '../../services/platform/src/ops-alert-worker';

/**
 * **OB-435 · OB-439 (owner, 28 Oct 2026, in writing): every alert is in English AND Tamil, and an alert TEXT MESSAGE goes in
 * the recipient's own language — through the real API, in memory and (with DATABASE_URL) on real PostgreSQL, across a
 * cold restart.**
 *
 *   • each staff member has an English/Tamil choice on their staff record, English unless set; the owner or a manager
 *     with `workforce.roster.manage` sets it (`POST /v1/hr/workforce/employees/:employeeId/language`), sealed on the audit
 *     trail with what it was before; a cashier is refused; an ordinary staff-record update keeps it;
 *   • an alert raised to three people sends ONE message to each, in that person's language — Tamil to the person who
 *     chose Tamil, English to the person who chose English and to the person with no choice;
 *   • the board and each inbox carry every alert's words in both languages, for the screens' language button;
 *   • an alert recorded before OB-435 (English only, no structured words) still reads — in English, said so — and is sent
 *     to a Tamil reader in the Tamil frame with its English words, never an error and never blank;
 *   • nothing is sent twice: one delivery per alert × occurrence × stage × person, exactly as before, across a restart.
 *
 * Synthetic people and stores only (hard rule #7).
 */

const backings = useRestartableBackings();
type Res = { status: number; body: unknown };
const TAMIL = /[஀-௿]/;
const STORE = 'store-1';
const TA = 'u-mgr-ta';
const EN = 'u-mgr-en';
const UNSET = 'u-mgr-unset';

interface Words { component: string; status: string; detail: string }
interface Live { alert: { alertId: string; detail: string }; words: { en: Words; ta: Words; englishOnly?: true } }

describe.each(backings)('an alert speaks each person\'s language (OB-435, OB-439) — on $name', ({ harness }) => {
  it('sets a person\'s language, sends each message in its recipient\'s language, shows both, and still reads an old English-only alert', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    for (const who of [TA, EN, UNSET]) await h.provisionRole(T, who, 'store_manager');
    await h.provisionRole(T, 'u-cash', 'cashier');
    const call = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown, query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };

    // The three managers on the staff list (synthetic people).
    for (const [id, name] of [[TA, 'Manager Tamil'], [EN, 'Manager English'], [UNSET, 'Manager Unset']] as const) {
      await ok(call('POST', `/v1/hr/workforce/employees/${id}`, 'u-owner', { name, branchId: STORE, roles: ['store_manager'], active: true }), `staff ${id}`);
    }

    // 1 — SETTING THE LANGUAGE. The owner sets Tamil; a manager sets English for a colleague; a cashier is refused.
    const lang = (who: string, language: unknown, by: string) => call('POST', `/v1/hr/workforce/employees/${who}/language`, by, { language });
    const set = (await ok(lang(TA, 'ta', 'u-owner'), 'owner sets Tamil')).body as { employee: { language?: string }; alertMessagesIn: string };
    expect([set.employee.language, set.alertMessagesIn]).toEqual(['ta', 'Tamil']);
    expect((await ok(lang(EN, 'en', TA), 'a manager sets English')).body).toMatchObject({ language: 'en', alertMessagesIn: 'English' });
    const refused = await lang(UNSET, 'ta', 'u-cash');
    expect(refused.status).toBe(403);
    expect((await lang(UNSET, 'hindi', 'u-owner')).status).toBe(400);              // only English or Tamil
    expect((await lang('u-nobody', 'ta', 'u-owner')).status).toBe(404);           // only a person on the staff list
    // An ordinary update of the staff record keeps the language (it is set by its own route only).
    await ok(call('POST', `/v1/hr/workforce/employees/${TA}`, 'u-owner', { name: 'Manager Tamil', branchId: STORE, roles: ['store_manager'], active: true }), 'update keeps it');
    // The audit event: who set which language, and what it was before.
    const trail = (await ok(call('GET', '/v1/audit/trail', 'u-owner', undefined, { action: 'workforce.language.set' }), 'trail')).body as { matches: { actorId: string; objectId: string; after: Record<string, string> }[] };
    expect(trail.matches.map((m) => [m.actorId, m.objectId, m.after['language'], m.after['before']])).toEqual([
      ['u-owner', TA, 'ta', 'not set (English)'],
      [TA, EN, 'en', 'not set (English)'],
    ]);

    // 2 — AN ALERT TO ALL THREE. No backup has ever reported: the backup component is "unknown"; one rule per person.
    const rule = (alertId: string, ownerUserId: string) => ({ alertId, component: 'backup', firesAt: 'unknown', ownerUserId, ownerName: ownerUserId, ackWithinMinutes: 30 });
    await ok(call('PUT', '/v1/platform/alert-rules', 'u-owner', { basedOnVersion: 0, rules: [rule('backup-ta', TA), rule('backup-en', EN), rule('backup-unset', UNSET)] }), 'alert rules');
    await ok(call('POST', '/v1/platform/operational-health/observed/raise', 'u-owner', {}), 'raise');
    const transport = recordingTransport();
    const now = () => new Date().toISOString();
    expect(await deliverAlerts(alertLifecycleAdapter({ store: h.store, now }), T, OPS_ALERT_WORKER, now(), transport)).toBe(6); // 3 inboxes + 3 messages
    const to = (who: string) => transport.sent.filter((m) => m.customerId === who);
    for (const who of [TA, EN, UNSET]) expect(to(who), who).toHaveLength(1);
    // Tamil to the person who chose Tamil — in Tamil only, the backup named in Tamil, no English sentence.
    const tamil = to(TA)[0]!.text;
    expect(tamil).toMatch(TAMIL);
    expect(tamil).toContain('காப்புப் பிரதி');
    expect(tamil).not.toMatch(/Please acknowledge|no backup has ever been reported/);
    // English to the person who chose English, and to the person with no choice — word for word the message as it always was.
    for (const who of [EN, UNSET]) {
      const text = to(who)[0]!.text;
      expect(text).not.toMatch(TAMIL);
      expect(text).toMatch(/^backup is unknown — no backup has ever been reported — this is the one to fix before anything else\. Please acknowledge by \d{4}-/);
    }
    expect(transport.sent.map((m) => m.channel)).toEqual(['sms', 'sms', 'sms']);

    // 3 — THE SCREENS' DATA: the board and each inbox carry both languages.
    const board = ((await ok(call('GET', '/v1/platform/alerts', 'u-owner'), 'board')).body as { alerts: Live[] }).alerts;
    const ta = board.find((a) => a.alert.alertId === 'backup-ta')!;
    expect(ta.words.en).toEqual({ component: 'backup', status: 'unknown', detail: 'no backup has ever been reported — this is the one to fix before anything else' });
    expect(ta.words.ta.detail).toMatch(TAMIL);
    expect(ta.words.ta.component).toBe('காப்புப் பிரதி');
    expect(ta.words.englishOnly).toBeUndefined();
    const inbox = ((await ok(call('GET', '/v1/platform/alerts/inbox', EN), 'inbox')).body as { alerts: Live[] }).alerts;
    expect(inbox.map((a) => a.alert.alertId)).toEqual(['backup-en']);
    expect(inbox[0]!.words.en.detail).toBe(inbox[0]!.alert.detail);
    expect(inbox[0]!.words.ta.detail).toMatch(TAMIL);

    // 4 — AN OLD ALERT, recorded before OB-435 in English only (no structured words): it still reads, in English, said so.
    const life = alertLifecycleAdapter({ store: h.store, now });
    const old = 'the lane CANNOT record a sale — stop selling on this lane (recorded in English only)';
    await life.recordAlertEvent(T, { alertId: 'old-lane', change: 'raised', by: 'u-owner', at: now(), alert: { alertId: 'old-lane', component: 'local_store', status: 'down', ownerUserId: TA, ownerName: TA, detail: old, raisedAt: now(), ackDueBy: now() } }, 'raise-old-lane');
    const oldOne = ((await ok(call('GET', '/v1/platform/alerts/inbox', TA), 'inbox ta')).body as { alerts: Live[] }).alerts.find((a) => a.alert.alertId === 'old-lane')!;
    expect(oldOne.words).toMatchObject({ en: { detail: old }, ta: { detail: old }, englishOnly: true });
    expect(oldOne.words.ta.component).toBe('கவுண்டரின் பதிவு');                    // the frame still reads in Tamil

    // 5 — A RESTART: nothing is sent twice; the old alert goes to the Tamil reader once, its English words in the Tamil frame.
    h = harness(h);
    const again = recordingTransport();
    expect(await deliverAlerts(alertLifecycleAdapter({ store: h.store, now }), T, OPS_ALERT_WORKER, now(), again)).toBe(2); // only the old one: inbox + message
    expect(again.sent.map((m) => m.customerId)).toEqual([TA]);
    expect(again.sent[0]!.text).toContain(old);
    expect(again.sent[0]!.text).toMatch(TAMIL);
    expect(again.sent[0]!.messageId).toBe(`alert-${T}-notify-old-lane-o1-raised-${TA}`); // the same key as ever: alert × occurrence × stage × person
    expect(await deliverAlerts(alertLifecycleAdapter({ store: h.store, now }), T, OPS_ALERT_WORKER, now(), again)).toBe(0);
  }, 60_000);
});
