// FG-4 · M04-FR-04 / M06-FR-03 — contract endings, on the Owner alerts page. A tested, DOM-free session over head office's
// GET /v1/reporting/contract-expiry-alerts (the owner's warning window — "not set" until he enters it — and the display
// and supplier contracts due today) and POST …/warning-days (set it, or clear it with a reason). A contract that has
// already ended is raised to the owner whatever the window says; the window only adds the early warning. Nothing is read
// before the person may see it; every write is a click in the owner's own name.

import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

export const CONTRACT_EXPIRY_COPY = {
  en: {
    ceH: 'Contracts ending', ceLead: 'Display-space and supplier contracts. One that has already ended is raised to you at once. Enter how many days ahead you also want to be told.',
    windowNotSet: 'Not set: only contracts that have already ended are raised to you.', windowSet: 'You are told {days} day(s) before a contract ends',
    days: 'Days ahead (1 to 365)', save: 'Save', clear: 'Take it off', clearWhy: 'Why (required to take it off)',
    dueNone: 'No contract has ended or is ending inside your window.', expired: 'ended', expiring: 'ending', display: 'Display contract', supplier: 'Supplier contract', on: 'on',
    needDays: 'Type a whole number of days from 1 to 365. Nothing was sent.', needWhy: 'Write why first. Nothing was sent.',
    saved: 'Saved.', nobody: 'Nobody is signed in on this screen — you can read nothing.', cannotRead: 'Your role cannot read owner alerts.', cannotManage: 'Only the owner sets this.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or saved.',
  },
  ta: {
    ceH: 'முடிவடையும் ஒப்பந்தங்கள்', ceLead: 'காட்சி இட ஒப்பந்தங்களும் சப்ளையர் ஒப்பந்தங்களும். ஏற்கனவே முடிந்த ஒன்று உடனே உங்களுக்குத் தெரிவிக்கப்படும். எத்தனை நாட்களுக்கு முன்பே தெரிய வேண்டும் என்பதை உள்ளிடவும்.',
    windowNotSet: 'அமைக்கப்படவில்லை: ஏற்கனவே முடிந்த ஒப்பந்தங்கள் மட்டுமே தெரிவிக்கப்படும்.', windowSet: 'ஒப்பந்தம் முடிவதற்கு {days} நாள்(கள்) முன் உங்களுக்குத் தெரிவிக்கப்படும்',
    days: 'எத்தனை நாள் முன் (1 முதல் 365)', save: 'சேமி', clear: 'நீக்கு', clearWhy: 'ஏன் (நீக்கத் தேவை)',
    dueNone: 'எந்த ஒப்பந்தமும் முடியவில்லை, உங்கள் காலத்துக்குள் முடியவும் இல்லை.', expired: 'முடிந்தது', expiring: 'முடிகிறது', display: 'காட்சி ஒப்பந்தம்', supplier: 'சப்ளையர் ஒப்பந்தம்', on: 'தேதி',
    needDays: '1 முதல் 365 வரை முழு எண்ணாக நாட்களைத் தட்டச்சு செய்யவும். எதுவும் அனுப்பப்படவில்லை.', needWhy: 'முதலில் காரணத்தை எழுதவும். எதுவும் அனுப்பப்படவில்லை.',
    saved: 'சேமிக்கப்பட்டது.', nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை — எதையும் படிக்க முடியாது.', cannotRead: 'உங்கள் பங்கு உரிமையாளர் எச்சரிக்கைகளைப் படிக்க முடியாது.', cannotManage: 'இதை உரிமையாளர் மட்டுமே அமைப்பார்.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கவோ சேமிக்கவோ இல்லை.',
  },
} as const;

export const contractExpiryWords = (lang: Lang, key: string): string =>
  (CONTRACT_EXPIRY_COPY[lang] as Record<string, string>)[key] ?? (CONTRACT_EXPIRY_COPY.en as Record<string, string>)[key] ?? key;
export const contractExpiryOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => (out.result === 'ok' ? contractExpiryWords(lang, 'saved') : outcomeIn((k) => contractExpiryWords(lang, k), out));

export interface ContractDue { readonly alertId: string; readonly register: 'display' | 'supplier'; readonly contractId: string; readonly supplierId: string; readonly endsOn: string; readonly daysLeft: number; readonly step: 'expired' | 'expiring' }
export interface ContractExpiryRead { readonly today: string; readonly warningDays: { readonly state: 'set' | 'not_set'; readonly days: number | null }; readonly due: readonly ContractDue[] }

/** The window in words: "Not set: …" or "You are told 30 day(s) before a contract ends". */
export function windowWords(lang: Lang, w: ContractExpiryRead['warningDays']): string {
  return w.state === 'not_set' || w.days === null ? contractExpiryWords(lang, 'windowNotSet') : contractExpiryWords(lang, 'windowSet').replace('{days}', String(w.days));
}
/** One due contract in words. */
export function dueWords(lang: Lang, d: ContractDue): string {
  const w = (k: string) => contractExpiryWords(lang, k);
  return `${w(d.register)} ${d.contractId} · ${d.supplierId} · ${w(d.step)} ${w('on')} ${d.endsOn}`;
}

type Why = 'nobody' | 'cannotRead' | 'cannotManage' | 'needDays' | 'needWhy';

export interface ContractExpirySession {
  readonly may: { readonly read: boolean; readonly manage: boolean };
  read(): Promise<Outcome<ContractExpiryRead, Why>>;
  setDays(typed: string): Promise<Outcome<unknown, Why>>;
  clear(reason: string): Promise<Outcome<unknown, Why>>;
}

export function createContractExpirySession(input: { readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined; readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string }): ContractExpirySession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { read: named && held.has('owner.alert.read'), manage: named && held.has('owner.alert.manage') };
  const call = makeCaller({ keyPrefix: 'contract-expiry', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const gate = (need: 'read' | 'manage'): Outcome<never, Why> | undefined => (!named ? { result: 'invalid', why: 'nobody' } : !may[need] ? { result: 'invalid', why: need === 'read' ? 'cannotRead' : 'cannotManage' } : undefined);
  return {
    may,
    read: async () => gate('read') ?? call('GET', '/v1/reporting/contract-expiry-alerts'),
    setDays: async (typed) => {
      const g = gate('manage'); if (g !== undefined) return g;
      const s = typed.trim();
      const days = /^\d+$/.test(s) ? Number(s) : NaN;
      if (!Number.isInteger(days) || days < 1 || days > 365) return { result: 'invalid', why: 'needDays' };
      return call('POST', '/v1/reporting/contract-expiry-alerts/warning-days', { days });
    },
    clear: async (reason) => gate('manage') ?? (reason.trim() === '' ? { result: 'invalid', why: 'needWhy' } : call('POST', '/v1/reporting/contract-expiry-alerts/warning-days', { days: null, reason: reason.trim() })),
  };
}
