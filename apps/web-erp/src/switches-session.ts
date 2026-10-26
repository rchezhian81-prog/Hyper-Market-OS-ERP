// The Feature switches page — feature-flag governance (M01-FR-03 "Feature flags and configuration versioning with rollback";
// acceptance "a maker cannot approve their own high-impact flag" · QG-02). A tested, DOM-free session over head office's
// own routes (services/platform/src/governed-config.ts) — it reads and writes `/v1/platform/flags*` and nothing else:
//   • THE BOARD — every switch the shop has, on or off (a switch nobody set is off);
//   • PREVIEW — what a change would do, and whether it is HIGH-IMPACT (payments, pricing, offline limits): such a change
//     needs the owner's approval of exactly that change, which the person who asks can never give themselves;
//   • CHANGE — with a reason, every time; a high-impact one names the owner's approval number (never a typed name);
//   • HISTORY and ROLLBACK — every version numbered; going back restores an old state as a NEW version (nothing rewritten).
// Head office re-checks every permission and approval; `may` only shapes what is offered. Nothing is read on open.

import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

export const SWITCHES_COPY = {
  en: {
    title: 'Feature switches', lead: 'Each switch turns one feature on or off for the whole shop. Every change carries its reason and a version; a payments, pricing or offline switch needs the owner\'s approval first, and going back is one step.',
    show: 'Show the switches', boardH: 'Switches', none: 'No switch has been set. A switch nobody set is off.', on: 'On', off: 'Off', key: 'Switch name', state: 'Turn it', reason: 'Why (needed)',
    approvalId: 'Owner\'s approval number (payments, pricing or offline switches)', preview: 'Preview', save: 'Save the change', history: 'History', back: 'Go back to this version', backWhy: 'Why go back?',
    changeH: 'Change a switch', now: 'Now:', becomes: 'becomes', notSetYet: 'not set (off)', noChange: 'That is already its state — nothing would change.', highImpact: 'High-impact: the owner must approve exactly this change first, and you cannot approve your own.',
    ordinary: 'An ordinary switch — no second person needed.', version: 'version', restored: 'restored version', approvedBy: 'approved by', by: 'by',
    saved: 'Saved — a new version.', needKey: 'Type the switch name: lower-case words joined by dots (e.g. offers.festive_banner).', needReason: 'Write why first — every change keeps its reason.',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot read the switches.', cannotChange: 'Your role cannot change a switch.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or saved.',
  },
  ta: {
    title: 'அம்சச் சுவிட்சுகள்', lead: 'ஒவ்வொரு சுவிட்சும் முழுக் கடைக்கும் ஒரு அம்சத்தை இயக்குகிறது அல்லது அணைக்கிறது. ஒவ்வொரு மாற்றமும் காரணமும் பதிப்பும் கொண்டது; பணம், விலை அல்லது ஆஃப்லைன் சுவிட்சுக்கு முதலில் உரிமையாளர் ஒப்புதல் தேவை; திரும்பிச் செல்வது ஒரே படி.',
    show: 'சுவிட்சுகளைக் காட்டு', boardH: 'சுவிட்சுகள்', none: 'எந்தச் சுவிட்சும் அமைக்கப்படவில்லை. யாரும் அமைக்காத சுவிட்ச் அணைந்திருக்கும்.', on: 'இயக்கம்', off: 'அணைப்பு', key: 'சுவிட்ச் பெயர்', state: 'நிலை', reason: 'ஏன் (தேவை)',
    approvalId: 'உரிமையாளர் ஒப்புதல் எண் (பணம், விலை அல்லது ஆஃப்லைன் சுவிட்சுகள்)', preview: 'முன்னோட்டம்', save: 'மாற்றத்தைச் சேமி', history: 'வரலாறு', back: 'இந்தப் பதிப்புக்குத் திரும்பு', backWhy: 'ஏன் திரும்புகிறீர்கள்?',
    changeH: 'சுவிட்சை மாற்று', now: 'இப்போது:', becomes: 'ஆகிறது', notSetYet: 'அமைக்கப்படவில்லை (அணைப்பு)', noChange: 'அதுவே ஏற்கனவே அதன் நிலை — எதுவும் மாறாது.', highImpact: 'அதிக தாக்கம்: இந்த மாற்றத்தை முதலில் உரிமையாளர் ஒப்புக்கொள்ள வேண்டும்; உங்கள் சொந்தக் கோரிக்கையை நீங்கள் அனுமதிக்க முடியாது.',
    ordinary: 'சாதாரண சுவிட்ச் — இரண்டாவது நபர் தேவையில்லை.', version: 'பதிப்பு', restored: 'மீட்டெடுத்த பதிப்பு', approvedBy: 'அனுமதித்தவர்', by: 'செய்தவர்',
    saved: 'சேமிக்கப்பட்டது — புதிய பதிப்பு.', needKey: 'சுவிட்ச் பெயரை உள்ளிடுங்கள்: புள்ளிகளால் இணைந்த சிறிய எழுத்துச் சொற்கள் (எ.கா. offers.festive_banner).', needReason: 'முதலில் காரணத்தை எழுதுங்கள் — ஒவ்வொரு மாற்றமும் அதன் காரணத்தை வைத்திருக்கும்.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பணி சுவிட்சுகளைப் படிக்க முடியாது.', cannotChange: 'உங்கள் பணி சுவிட்சை மாற்ற முடியாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கவோ சேமிக்கவோ இல்லை.',
  },
} as const;

export const switchesWords = (lang: Lang, key: string): string =>
  (SWITCHES_COPY[lang] as Record<string, string>)[key] ?? (SWITCHES_COPY.en as Record<string, string>)[key] ?? key;
export const switchesOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => (out.result === 'ok' ? switchesWords(lang, 'saved') : outcomeIn((k) => switchesWords(lang, k), out));

export interface FlagRow { readonly key: string; readonly enabled: boolean }
export interface FlagVersion { readonly key: string; readonly enabled: boolean; readonly changedBy: string; readonly changedAt: string; readonly reason?: string; readonly version: number; readonly approvedBy?: string; readonly rolledBackFrom?: number }
export interface FlagPreview { readonly key: string; readonly current: boolean | null; readonly currentVersion: number; readonly proposed: boolean; readonly changes: boolean; readonly highImpact: boolean; readonly needsSecondPerson: boolean }

/** The preview in words: "Now: off (version 2) becomes on" and whether a second person (the owner) is needed. */
export function previewWords(lang: Lang, p: FlagPreview): { readonly change: string; readonly who: string } {
  const w = (k: string) => switchesWords(lang, k);
  const now = p.current === null ? w('notSetYet') : `${w(p.current ? 'on' : 'off')} (${w('version')} ${p.currentVersion})`;
  return { change: p.changes ? `${w('now')} ${now} ${w('becomes')} ${w(p.proposed ? 'on' : 'off')}` : w('noChange'), who: w(p.highImpact ? 'highImpact' : 'ordinary') };
}

export interface SwitchesSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly change: boolean };
  board(): Promise<Outcome<{ readonly flags: readonly FlagRow[] }, 'nobody' | 'cannotRead'>>;
  preview(key: string, enabled: boolean): Promise<Outcome<FlagPreview, 'nobody' | 'cannotRead' | 'needKey'>>;
  save(key: string, enabled: boolean, reason: string, approvalId: string): Promise<Outcome<FlagVersion, 'nobody' | 'cannotChange' | 'needKey' | 'needReason'>>;
  history(key: string): Promise<Outcome<{ readonly key: string; readonly versions: readonly FlagVersion[]; readonly highImpact: boolean }, 'nobody' | 'cannotRead' | 'needKey'>>;
  rollback(key: string, toVersion: number, reason: string, approvalId: string): Promise<Outcome<FlagVersion, 'nobody' | 'cannotChange' | 'needKey' | 'needReason'>>;
}

/** Head office's own rule for a switch name: lower-case words joined by dots. */
export const SWITCH_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/;

export function createSwitchesSession(input: { readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined; readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string }): SwitchesSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, read: named && held.has('platform.flag.read'), change: named && held.has('platform.flag.write') };
  const call = makeCaller({ keyPrefix: 'switch', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const gate = (need: 'read' | 'change'): { result: 'invalid'; why: 'nobody' | 'cannotRead' | 'cannotChange' } | null =>
    (!named ? { result: 'invalid', why: 'nobody' } : !may[need] ? { result: 'invalid', why: need === 'read' ? 'cannotRead' : 'cannotChange' } : null);
  const path = (key: string, rest = ''): string => `/v1/platform/flags/${encodeURIComponent(key.trim())}${rest}`;
  const approval = (id: string): Record<string, string> => (id.trim() === '' ? {} : { approvalId: id.trim() });
  return {
    may,
    board: async () => {
      const g = gate('read'); if (g !== null) return g as never;
      // Head office answers the board as { flags: { <name>: on/off } }; the page reads it as rows, in name order.
      const out = await call<{ readonly flags?: Readonly<Record<string, unknown>> }>('GET', '/v1/platform/flags');
      if (out.result !== 'ok') return out;
      const flags = Object.entries(out.value.flags ?? {}).filter((e): e is [string, boolean] => typeof e[1] === 'boolean')
        .map(([key, enabled]) => ({ key, enabled })).sort((a, b) => a.key.localeCompare(b.key));
      return { result: 'ok', value: { flags } };
    },
    preview: async (key, enabled) => {
      const g = gate('read'); if (g !== null) return g as never;
      if (!SWITCH_NAME.test(key.trim())) return { result: 'invalid', why: 'needKey' };
      return call('POST', path(key, '/preview'), { enabled });
    },
    save: async (key, enabled, reason, approvalId) => {
      const g = gate('change'); if (g !== null) return g as never;
      if (!SWITCH_NAME.test(key.trim())) return { result: 'invalid', why: 'needKey' };
      if (reason.trim() === '') return { result: 'invalid', why: 'needReason' };
      return call('PUT', path(key), { enabled, reason: reason.trim(), ...approval(approvalId) });
    },
    history: async (key) => {
      const g = gate('read'); if (g !== null) return g as never;
      if (!SWITCH_NAME.test(key.trim())) return { result: 'invalid', why: 'needKey' };
      return call('GET', path(key, '/history'));
    },
    rollback: async (key, toVersion, reason, approvalId) => {
      const g = gate('change'); if (g !== null) return g as never;
      if (!SWITCH_NAME.test(key.trim())) return { result: 'invalid', why: 'needKey' };
      if (reason.trim() === '') return { result: 'invalid', why: 'needReason' };
      return call('POST', path(key, '/rollback'), { toVersion, reason: reason.trim(), ...approval(approvalId) });
    },
  };
}
