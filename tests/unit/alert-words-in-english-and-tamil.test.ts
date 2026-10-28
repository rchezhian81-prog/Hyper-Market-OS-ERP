import { describe, it, expect } from 'vitest';
import {
  alertText, alertWords, alertDisplay, alertMessage, renderAlert, told, languageOrEnglish, componentTa, rangeWordsIn, durationWordsIn,
  checkHealth, raiseAlerts, escalateUnacknowledged, recommendOperationsRunbooks, type AlertRule,
} from '../../packages/ops/src/index';
import { recordingTransport } from '../../packages/notifications/src/index';
import { deliverAlerts } from '../../services/platform/src/ops-alert-worker';
import { boxHistoryComponents } from '../../services/platform/src/box-health';
import type { AlertLifecycleDeps, AlertLifecycleEvent, LiveAlert } from '../../services/platform/src/alert-lifecycle';
import { projectAlerts } from '../../services/platform/src/alert-lifecycle';

/**
 * OB-435 · OB-439: the alert words — a kind and its parameters, rendered in English (word for word what the product always
 * said) or Tamil (one language at a time, never blank), with an alert recorded before OB-435 still reading in English.
 */

const TAMIL = /[஀-௿]/;
const NOW = '2026-10-28T10:00:00Z';

describe('alert words in English and Tamil (OB-435)', () => {
  it('renders a sentence in either language; English is the long-standing words, Tamil is in Tamil', () => {
    const t = alertText('health.backup.overdue', { ageSeconds: 200_000 });
    expect(renderAlert(t, 'en')).toBe('the last backup was 2 days ago — a stale backup is a silent disaster');
    expect(renderAlert(t, 'ta')).toBe('கடைசி காப்புப் பிரதி 2 நாள் முன்பு எடுக்கப்பட்டது — பழைய காப்புப் பிரதி சத்தமில்லாத பேரழிவு');
  });

  it('renders a sentence inside a sentence in the same language', () => {
    const t = alertText('backup.latestFailed', { backupId: 'b-2', at: NOW, why: [alertText('backup.why.notCompleted')], then: alertText('health.backup.recent', { ageSeconds: 3_700 }) });
    expect(renderAlert(t, 'en')).toBe(`the latest backup (b-2, ${NOW}) did not complete; last backup 1h 1m ago`);
    const ta = renderAlert(t, 'ta');
    expect(ta).toContain('முடியவில்லை');
    expect(ta).toContain('1 மணி 1 நிமிடம்');
    expect(ta).not.toMatch(/did not complete|last backup/);
  });

  it('keeps a person\'s own words verbatim inside the Tamil frame', () => {
    const t = alertText('recall.cleared.withdrawn', { reason: 'wrong batch typed' });
    expect(renderAlert(t, 'ta')).toContain('wrong batch typed');
    expect(renderAlert(t, 'ta')).toMatch(TAMIL);
  });

  it('told gives the English detail and the structured text it came from', () => {
    const w = told('health.queue.waiting', { depth: 140, notDraining: true });
    expect(w).toEqual({ detail: '140 item(s) waiting to send — the queue is not draining', text: { kind: 'health.queue.waiting', params: { depth: 140, notDraining: true } } });
  });

  it('an alert recorded before OB-435 (no structured words, or an unknown kind) reads in English in both, said so', () => {
    expect(alertWords(undefined, 'an old English sentence')).toEqual({ en: 'an old English sentence', ta: 'an old English sentence', englishOnly: true });
    expect(alertWords({ kind: 'a.kind.nobody.knows', params: {} }, 'old words')).toEqual({ en: 'old words', ta: 'old words', englishOnly: true });
    expect(alertWords('not structured', 'old words')).toMatchObject({ englishOnly: true });
    const shown = alertDisplay({ component: 'backup', status: 'down', detail: 'old words' });
    expect(shown).toEqual({
      en: { component: 'backup', status: 'down', detail: 'old words' },
      ta: { component: 'காப்புப் பிரதி', status: 'செயலிழந்தது', detail: 'old words' },
      englishOnly: true,
    });
  });

  it('names a health component in Tamil, store by store; a name it does not know stays as it is', () => {
    expect(componentTa('box_disk:store-1')).toBe('கடை store-1 கணினியின் வட்டு');
    expect(componentTa('till_devices:store-2')).toBe('கடை store-2 கவுண்டர் கருவிகள்');
    expect(componentTa('integration:sms-gateway')).toBe('இணைப்பு sms-gateway');
    expect(componentTa('Recall of batch B-1')).toBe('Recall of batch B-1');
  });

  it('says bill-number ranges and lengths of time in Tamil', () => {
    expect(rangeWordsIn('ta', 'R-1-', [[12, 15], [20, 20]])).toBe('R-1-000012 முதல் R-1-000015 வரை, R-1-000020');
    expect(rangeWordsIn('en', 'R-1-', [[12, 15]])).toBe('R-1-000012 to R-1-000015');
    expect(durationWordsIn('ta', 9 * 3_600_000 + 20 * 60_000)).toBe('9 மணி 20 நிமிடம்');
    expect(durationWordsIn('en', 9 * 3_600_000 + 20 * 60_000)).toBe('9 hours 20 minutes');
  });

  it('a person\'s language is Tamil only when they chose it; anything else, or nothing, is English (OB-439)', () => {
    expect([languageOrEnglish('ta'), languageOrEnglish('en'), languageOrEnglish(undefined), languageOrEnglish('hi')]).toEqual(['ta', 'en', 'en', 'en']);
  });

  it('the health engine keeps its English and carries the structured words on every component and raised alert', () => {
    const health = checkHealth({ queueDepth: 0, deadLetterCount: 1, databaseReachable: false, localStoreWritable: true, integrations: { tally: false } }, NOW);
    for (const c of health.components) {
      expect(c.text, c.name).toBeDefined();
      expect(renderAlert(c.text!, 'en'), c.name).toBe(c.detail);
      expect(renderAlert(c.text!, 'ta'), c.name).toMatch(TAMIL);
    }
    const rules: AlertRule[] = [{ alertId: 'a1', component: 'dead_letter', firesAt: 'degraded', ownerUserId: 'u-1', ownerName: 'Manager One', ackWithinMinutes: 0 }];
    const [raised] = raiseAlerts(health, rules);
    expect(raised!.text).toEqual({ kind: 'health.deadLetter.some', params: { count: 1 } });
    const [esc] = escalateUnacknowledged([raised!], rules, [], NOW);
    expect(esc!.detail).toBe('nobody is configured above Manager One — this alert has nowhere to escalate to');
    expect(renderAlert(esc!.text, 'ta')).toContain('Manager One');
  });

  it('the Operations page\'s incident reads in either language; its English is as before', () => {
    const health = checkHealth({ deadLetterCount: 2 }, NOW);
    const rules: AlertRule[] = [{ alertId: 'dl', component: 'dead_letter', firesAt: 'degraded', ownerUserId: 'u-1', ownerName: 'Manager One', ackWithinMinutes: 15 }];
    const [f] = recommendOperationsRunbooks(raiseAlerts(health, rules).map((alert) => ({ alert, state: 'open' as const })));
    expect(f!.headline).toBe('dead_letter is down: 2 item(s) could not be sent and are waiting for a person — each one is a real sale, receipt or order');
    expect(f!.words!.en).toEqual({ headline: f!.headline, detail: f!.detail });
    expect(f!.words!.ta.headline).toMatch(/^அனுப்ப முடியாமல் நின்றவை — செயலிழந்தது: 2 பதிவு/);
  });

  it('the store computers\' words keep their English and have a Tamil twin', () => {
    const [c] = boxHistoryComponents({ history: { sizeBytes: 5_000_000, saveHeld: null, lastBuildFailed: null } });
    expect(c!.detail).toMatch(/^the store computers' saved history is 4883 KB — above the 4 MB line/);
    expect(renderAlert(c!.text!, 'en')).toBe(c!.detail);
    expect(renderAlert(c!.text!, 'ta')).toMatch(/^கடை கணினிகளின் சேமித்த வரலாறு 4883 KB/);
  });
});

describe('an alert text message goes in its recipient\'s language (OB-439)', () => {
  const alert = { alertId: 'backup', component: 'backup', status: 'down' as const, ownerUserId: 'u-ta', ownerName: 'Manager Tamil', ...told('health.backup.never'), raisedAt: NOW, ackDueBy: '2026-10-28T10:30:00Z', alsoToUserIds: ['u-en', 'u-none'] };

  it('one language per message: English word for word as before, Tamil in Tamil', () => {
    const en = alertMessage(alert, 'raised', false, 'en', { ackDueBy: alert.ackDueBy, ownerName: alert.ownerName });
    expect(en).toBe('backup is down — no backup has ever been reported — this is the one to fix before anything else. Please acknowledge by 2026-10-28T10:30:00Z.');
    const ta = alertMessage(alert, 'raised', true, 'ta', { ackDueBy: alert.ackDueBy, ownerName: alert.ownerName });
    expect(ta).toMatch(/^புதுப்பிப்பு: காப்புப் பிரதி — செயலிழந்தது: இதுவரை எந்தக் காப்புப் பிரதியும் தெரிவிக்கப்படவில்லை/);
    expect(ta).not.toMatch(/acknowledge|backup is/);
    const up = alertMessage(alert, 'escalated', false, 'ta', { ackDueBy: alert.ackDueBy, ownerName: alert.ownerName });
    expect(up).toMatch(/^உங்களுக்கு மேலே அனுப்பப்பட்டது: /);
    expect(up).toContain('Manager Tamil இதை இன்னும் ஒப்புக்கொள்ளவில்லை');
  });

  it('the worker sends each person their own language; nobody set is English; the delivery key does not change', async () => {
    const events: AlertLifecycleEvent[] = [{ alertId: 'backup', change: 'raised', by: 'w', at: NOW, alert }];
    const languages: Record<string, 'en' | 'ta'> = { 'u-ta': 'ta', 'u-en': 'en' };
    const deps = (withLanguages: boolean): AlertLifecycleDeps => ({
      now: () => NOW,
      alerts: (): readonly LiveAlert[] => projectAlerts(events),
      recordAlertEvent: (_t, e) => { events.push(e); },
      ...(withLanguages ? { alertLanguageOf: (_t: string, u: string) => languages[u] ?? 'en' } : {}),
    });
    const transport = recordingTransport();
    expect(await deliverAlerts(deps(true), 'T', 'w', NOW, transport)).toBe(6);
    const by = Object.fromEntries(transport.sent.map((m) => [m.customerId, m]));
    expect(by['u-ta']!.text).toMatch(TAMIL);
    expect(by['u-en']!.text).not.toMatch(TAMIL);
    expect(by['u-none']!.text).toBe(by['u-en']!.text);
    expect(transport.sent.map((m) => m.messageId)).toEqual(['alert-T-notify-backup-o1-raised-u-ta', 'alert-T-notify-backup-o1-raised-u-en', 'alert-T-notify-backup-o1-raised-u-none']);
    expect(await deliverAlerts(deps(true), 'T', 'w', NOW, transport)).toBe(0);                       // never twice
    // With no language lookup at all, every message is English (as before OB-439).
    events.splice(1);
    const plain = recordingTransport();
    await deliverAlerts(deps(false), 'T', 'w', NOW, plain);
    expect(plain.sent.every((m) => !TAMIL.test(m.text))).toBe(true);
  });
});
