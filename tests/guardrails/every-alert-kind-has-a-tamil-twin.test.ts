import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ALERT_TEMPLATES, ALERT_KINDS, renderAlert } from '../../packages/ops/src/alert-words';
import { renderWith, isAlertText, type AlertParam, type AlertTemplate, type AlertTemplates } from '../../packages/ops/src/alert-text';

/**
 * **Every alert sentence has a Tamil twin, and none is blank (owner decisions OB-435 and OB-439).**
 *
 * The owner decided (28 Oct 2026, in writing) that every alert message is in English AND Tamil, as the screens are, and
 * that a text message about an alert goes in the recipient's own language. An alert's words are structured — a kind and
 * its parameters — and each kind has an English and a Tamil template (`packages/ops/src/alert-words*.ts`). So:
 *
 *   1. every kind has both templates; each renders its own sample in Tamil to words that are not empty, are written in
 *      Tamil script, and are not simply the English again; every nested sentence a sample names is itself a kind;
 *   2. the places that compose an alert's words no longer write an English sentence straight into `detail` — they go
 *      through `told(...)` (or `toldOr(...)`, which keeps an English sentence made elsewhere and adds its Tamil twin only
 *      when the two agree word for word), so a new alert cannot be added in English only;
 *   3. a tripwire: the detector fires on a kind with no Tamil and on one whose Tamil is blank.
 *
 * NOTE: this checks presence and completeness, not translation quality — the Tamil wording is for the owner and a
 * native-speaker reviewer to read before go-live, as the screens' Tamil is.
 */

const TAMIL = /[஀-௿]/;

function nestedKinds(v: AlertParam | undefined, out: string[]): void {
  if (isAlertText(v)) {
    out.push(v.kind);
    for (const p of Object.values(v.params ?? {})) nestedKinds(p, out);
  } else if (Array.isArray(v)) {
    for (const x of v as readonly AlertParam[]) nestedKinds(x, out);
  }
}

/** The problems with one set of templates (empty: none). */
function problemsOf(templates: AlertTemplates): string[] {
  const problems: string[] = [];
  for (const [kind, t] of Object.entries(templates) as [string, Partial<AlertTemplate>][]) {
    if (typeof t.en !== 'function') { problems.push(`${kind}: no English template`); continue; }
    if (typeof t.ta !== 'function') { problems.push(`${kind}: no Tamil twin`); continue; }
    const nested: string[] = [];
    for (const p of Object.values(t.sample ?? {})) nestedKinds(p, nested);
    for (const k of nested) if (templates[k] === undefined) problems.push(`${kind}: its sample names ${k}, which has no words`);
    if (nested.some((k) => templates[k] === undefined)) continue;
    const text = { kind, params: t.sample ?? {} };
    let en = ''; let ta = '';
    try {
      en = renderWith(templates, text, 'en');
      // With this kind's English blanked, so the renderer's English fallback cannot hide a blank Tamil twin.
      ta = renderWith({ ...templates, [kind]: { ...t, en: () => '' } as AlertTemplate }, text, 'ta');
    } catch (e) {
      problems.push(`${kind}: does not render its own sample (${e instanceof Error ? e.message : String(e)})`);
      continue;
    }
    if (en.trim() === '') problems.push(`${kind}: English renders blank`);
    if (ta.trim() === '') problems.push(`${kind}: Tamil twin is blank`);
    else if (!TAMIL.test(ta)) problems.push(`${kind}: Tamil twin has no Tamil in it: "${ta}"`);
    else if (ta === en) problems.push(`${kind}: Tamil twin is the English again`);
    if (TAMIL.test(en)) problems.push(`${kind}: the English has Tamil in it`);
  }
  return problems;
}

/** The sources that compose an alert's words (raise, update, clear, escalate, deliver). */
const SOURCES = [
  'packages/ops/src/health.ts',
  'services/platform/src/observed-health.ts',
  'services/platform/src/alert-lifecycle.ts',
  'services/platform/src/ops-alert-worker.ts',
  'services/platform/src/box-health.ts',
  'services/api/src/owner-reporting-adapters.ts',
  'services/api/src/finance-bridge-adapters.ts',
  'services/api/src/lane2-recall-adapters.ts',
  'services/api/src/p1-identity-adapters.ts',
  'services/api/src/r3-gst-adapters.ts',
  'services/api/src/r4-pay-epr-adapters.ts',
  'services/api/src/saas-rollout-adapters.ts',
  'services/api/src/fg4-buying-adapters.ts',
  'services/api/src/r6b-quality-scale-adapters.ts',
  'services/api/src/commercial-desks-adapters.ts',
  'services/api/src/ops-messaging-adapters.ts',
  'services/orders/src/exception-ownership.ts',
];

/**
 * An English sentence written straight into an alert: `detail: '…'` / `detail: \`…\`` (or `text: \`…\`` for the delivery
 * message), outside `told(…)`. A line may say why it is not an alert's words with `alert-words: not an alert`.
 */
function englishOnlyLines(file: string, source: string): string[] {
  return source.split('\n').flatMap((line, i) => {
    if (line.includes('alert-words: not an alert')) return [];
    return /\b(detail|text):\s*(['`])/.test(line) && !/^\s*(\/\/|\*)/.test(line) ? [`${file}:${i + 1}: ${line.trim().slice(0, 140)}`] : [];
  });
}

describe('every alert sentence has a Tamil twin (OB-435, OB-439)', () => {
  it('every kind renders its sample in both languages: Tamil not blank, in Tamil script, not the English again', () => {
    expect(ALERT_KINDS.length).toBeGreaterThan(100);
    expect(problemsOf(ALERT_TEMPLATES)).toEqual([]);
  });

  it('the English of the frame and of the health engine is word for word what it always was', () => {
    expect(renderAlert({ kind: 'alert.sms.raised', params: { updated: false, component: 'backup', status: 'down', detail: 'x', ackDueBy: 'T' } }, 'en'))
      .toBe('backup is down — x. Please acknowledge by T.');
    expect(renderAlert({ kind: 'alert.sms.escalated', params: { component: 'backup', status: 'down', detail: 'x', ownerName: 'M' } }, 'en'))
      .toBe('ESCALATED to you: backup is down — x. M has not acknowledged it.');
    expect(renderAlert({ kind: 'health.sync.behind', params: { lagSeconds: 3_700 } }, 'en'))
      .toBe('nothing has reached the cloud for 1h 1m — the store is still trading, but head-office figures are that old');
  });

  it('no place that composes an alert writes an English sentence straight into it', () => {
    const found = SOURCES.flatMap((f) => englishOnlyLines(f, readFileSync(f, 'utf8')));
    expect(found).toEqual([]);
  });

  it('tripwire — a kind with no Tamil, or a blank one, is caught', () => {
    const base = ALERT_TEMPLATES as unknown as AlertTemplates;
    const noTamil = { ...base, 'test.noTamil': { en: () => 'an English sentence', sample: {} } as unknown as AlertTemplate };
    expect(problemsOf(noTamil)).toEqual(['test.noTamil: no Tamil twin']);
    const blank = { ...base, 'test.blank': { en: () => 'an English sentence', ta: () => '  ', sample: {} } };
    expect(problemsOf(blank)).toEqual(['test.blank: Tamil twin is blank']);
    const english = { ...base, 'test.english': { en: () => 'an English sentence', ta: () => 'an English sentence', sample: {} } };
    expect(problemsOf(english)).toEqual(['test.english: Tamil twin has no Tamil in it: "an English sentence"']);
    expect(englishOnlyLines('x.ts', "  components.push({ name: 'x', status: 'ok', detail: 'all fine' });")).toHaveLength(1);
  });
});
