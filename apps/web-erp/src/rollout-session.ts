// The "Trial switches and shop account" page (OB-288 P4 · R8-9 · OB-316 · M36-FR-01 · OB-321 · C8 · C9 · OB-324). A tested,
// DOM-free session over head office's routes:
//   • TRIAL SWITCHES per branch and per till lane: the board; a change previewed first, then saved with its reason (a
//     high-impact switch names the owner's approval); each place's history, and "go back to this version" in one step.
//   • THE USAGE METER (information only): stores, lanes, people and AI spend this month; the price "not set" (OB-321).
//   • THE CUSTOMER-DATA WATCH (C9): the CA's threshold, or "not set" — it never alerts until set.
//   • THE CONSENT RECORD (C8): download it in the consent-manager layout; bring in a consent manager's file.
// Head office re-checks every permission and approval; `may` only shapes what is shown.

import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

export const ROLLOUT_COPY = {
  en: {
    title: 'Trial switches and shop account', lead: 'Turn a trial feature on for one branch or one till lane, see what the shop uses, and keep the customer-data records.',
    boardH: 'Trial switches', boardNone: 'No trial switch has been set. A switch nobody set is off everywhere.', rule: 'A lane\'s own setting beats its branch\'s. A switch nobody set is off.',
    colSwitch: 'Switch', colPlace: 'Where', colState: 'State', colVersion: 'Version', colWhy: 'Why', colWho: 'Who', on: 'On', off: 'Off', wholeBranch: 'whole branch', lane: 'lane',
    changeH: 'Change a switch', key: 'Switch name', branch: 'Branch', laneOpt: 'Till lane (leave empty for the whole branch)', state: 'Turn it', reason: 'Why (required)', approvalId: 'Owner\'s approval number (high-impact switches only)',
    preview: 'Preview', save: 'Save the change', previewSays: 'Now:', becomes: 'becomes', lanesChange: 'Lanes that change:', none: 'none', needsOwner: 'High-impact: the owner must approve this exact change first.', noOwner: 'No second person needed.',
    history: 'History', back: 'Go back to this version', backWhy: 'Why go back?', restored: 'restored version',
    meterH: 'What the shop uses (for information)', stores: 'Stores', lanes: 'Till lanes', people: 'People', aiSpend: 'AI spend this month', price: 'Price', notSet: 'not set', monthNotRecorded: 'This month is not recorded yet.', peaks: 'This month\'s highest:', infoOnly: 'For information only. Nothing is ever switched off because of these figures.',
    watchH: 'Customer-data watch (DPDP)', threshold: 'Threshold set by the CA', volume: 'Customers whose details the shop holds', crossed: 'Reached — ask the CA and lawyer about a data protection impact assessment.', below: 'Below the threshold.', neverAlerts: 'Not set — the watch never alerts until the CA enters a number.',
    consentH: 'Customer consent record', download: 'Download the consent record', importFile: 'Consent manager\'s file', bringIn: 'Bring in the file', applied: 'applied', exceptions: 'need a person to check', alreadyThere: 'already in the record', downloaded: 'Downloaded:', records: 'records',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role does not open the trial switches.', cannotMeter: 'Your role does not see the usage meter.',
    saved: 'Saved.', needFields: 'Fill in the switch name, the branch and the reason first.', pickFile: 'Choose the file first.', notJson: 'That file is not a consent record.', refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or saved.',
  },
  ta: {
    title: 'சோதனை சுவிட்சுகள் மற்றும் கடை கணக்கு', lead: 'ஒரு கிளைக்கோ ஒரு பில்லிங் வரிசைக்கோ சோதனை வசதியை இயக்கவும், கடை பயன்படுத்துவதைப் பார்க்கவும், வாடிக்கையாளர் தரவு பதிவுகளை வைத்திருக்கவும்.',
    boardH: 'சோதனை சுவிட்சுகள்', boardNone: 'எந்த சோதனை சுவிட்சும் அமைக்கப்படவில்லை. யாரும் அமைக்காத சுவிட்ச் எங்கும் அணைந்தே இருக்கும்.', rule: 'வரிசையின் சொந்த அமைப்பு கிளையின் அமைப்பை விட மேலானது. யாரும் அமைக்காத சுவிட்ச் அணைந்திருக்கும்.',
    colSwitch: 'சுவிட்ச்', colPlace: 'எங்கே', colState: 'நிலை', colVersion: 'பதிப்பு', colWhy: 'ஏன்', colWho: 'யார்', on: 'இயக்கம்', off: 'அணைப்பு', wholeBranch: 'முழு கிளை', lane: 'வரிசை',
    changeH: 'சுவிட்சை மாற்று', key: 'சுவிட்ச் பெயர்', branch: 'கிளை', laneOpt: 'பில்லிங் வரிசை (முழு கிளைக்கு காலியாக விடவும்)', state: 'நிலை', reason: 'ஏன் (தேவை)', approvalId: 'உரிமையாளர் ஒப்புதல் எண் (அதிக தாக்க சுவிட்சுகளுக்கு மட்டும்)',
    preview: 'முன்னோட்டம்', save: 'மாற்றத்தைச் சேமி', previewSays: 'இப்போது:', becomes: 'ஆகிறது', lanesChange: 'மாறும் வரிசைகள்:', none: 'இல்லை', needsOwner: 'அதிக தாக்கம்: இந்த மாற்றத்தை முதலில் உரிமையாளர் ஒப்புக்கொள்ள வேண்டும்.', noOwner: 'இரண்டாவது நபர் தேவையில்லை.',
    history: 'வரலாறு', back: 'இந்தப் பதிப்புக்குத் திரும்பு', backWhy: 'ஏன் திரும்புகிறீர்கள்?', restored: 'மீட்டெடுத்த பதிப்பு',
    meterH: 'கடை பயன்படுத்துவது (தகவலுக்கு மட்டும்)', stores: 'கடைகள்', lanes: 'பில்லிங் வரிசைகள்', people: 'நபர்கள்', aiSpend: 'இந்த மாத AI செலவு', price: 'விலை', notSet: 'அமைக்கப்படவில்லை', monthNotRecorded: 'இந்த மாதம் இன்னும் பதிவாகவில்லை.', peaks: 'இந்த மாத உச்சம்:', infoOnly: 'தகவலுக்கு மட்டும். இந்த எண்களால் எதுவும் ஒருபோதும் நிறுத்தப்படாது.',
    watchH: 'வாடிக்கையாளர் தரவு கண்காணிப்பு (DPDP)', threshold: 'CA அமைத்த வரம்பு', volume: 'கடையிடம் விவரங்கள் உள்ள வாடிக்கையாளர்கள்', crossed: 'எட்டப்பட்டது — தரவு பாதுகாப்பு தாக்க மதிப்பீடு பற்றி CA மற்றும் வழக்கறிஞரிடம் கேளுங்கள்.', below: 'வரம்புக்குக் கீழே.', neverAlerts: 'அமைக்கப்படவில்லை — CA ஒரு எண்ணை உள்ளிடும் வரை கண்காணிப்பு எச்சரிக்காது.',
    consentH: 'வாடிக்கையாளர் ஒப்புதல் பதிவு', download: 'ஒப்புதல் பதிவைப் பதிவிறக்கு', importFile: 'ஒப்புதல் மேலாளரின் கோப்பு', bringIn: 'கோப்பைக் கொண்டு வா', applied: 'பதிவானது', exceptions: 'ஒருவர் சரிபார்க்க வேண்டியவை', alreadyThere: 'ஏற்கனவே பதிவில் உள்ளவை', downloaded: 'பதிவிறக்கப்பட்டது:', records: 'பதிவுகள்',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பணி சோதனை சுவிட்சுகளைத் திறப்பதில்லை.', cannotMeter: 'உங்கள் பணி பயன்பாட்டு அளவீட்டைப் பார்ப்பதில்லை.',
    saved: 'சேமிக்கப்பட்டது.', needFields: 'முதலில் சுவிட்ச் பெயர், கிளை மற்றும் காரணத்தை நிரப்பவும்.', pickFile: 'முதலில் கோப்பைத் தேர்ந்தெடுக்கவும்.', notJson: 'அந்தக் கோப்பு ஒப்புதல் பதிவு அல்ல.', refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கவோ சேமிக்கவோ இல்லை.',
  },
} as const;

export const rolloutWords = (lang: Lang, key: string): string =>
  (ROLLOUT_COPY[lang] as Record<string, string>)[key] ?? (ROLLOUT_COPY.en as Record<string, string>)[key] ?? key;
export const rolloutOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => (out.result === 'ok' ? rolloutWords(lang, 'saved') : outcomeIn((k) => rolloutWords(lang, k), out));
/** Paise as rupees, for the AI spend line. */
export const rupees = (minor: number): string => `₹${(minor / 100).toFixed(2)}`;

export interface BoardRow { readonly key: string; readonly branchId: string; readonly laneId: string | null; readonly enabled: boolean; readonly version: number; readonly reason: string; readonly changedBy: string; readonly changedAt: string; readonly approvedBy: string | null }
export interface Place { readonly branchId: string; readonly laneId?: string }
export interface Change { readonly key: string; readonly branchId: string; readonly laneId: string; readonly enabled: boolean; readonly reason: string; readonly approvalId: string }

export interface RolloutSession {
  readonly may: { readonly named: boolean; readonly open: boolean; readonly change: boolean; readonly meter: boolean; readonly watch: boolean; readonly consent: boolean };
  board(): Promise<Outcome<{ readonly switches: readonly BoardRow[] }>>;
  preview(c: Change): Promise<Outcome<{ readonly current: boolean | null; readonly proposed: boolean; readonly lanesThatChange: readonly string[]; readonly highImpact: boolean }, 'needFields'>>;
  save(c: Change): Promise<Outcome<unknown, 'needFields'>>;
  history(key: string, place: Place): Promise<Outcome<{ readonly versions: readonly (BoardRow & { readonly rolledBackFrom?: number })[] }>>;
  rollback(key: string, place: Place, toVersion: number, reason: string, approvalId?: string): Promise<Outcome<unknown, 'needFields'>>;
  meter(): Promise<Outcome<{ readonly now: { readonly stores: number; readonly lanes: number; readonly users: number; readonly aiSpendMinor: number } | null; readonly price: { readonly words: string }; readonly monthRecorded: { readonly recorded: boolean; readonly peakStores?: number; readonly peakLanes?: number; readonly peakUsers?: number } }>>;
  watch(): Promise<Outcome<{ readonly threshold: { readonly set: boolean; readonly principals?: number; readonly setBy?: string }; readonly volume: { readonly principals: number }; readonly crossed: boolean | null }>>;
  exportConsent(): Promise<Outcome<{ readonly counts: { readonly records: number; readonly dataPrincipals: number } }>>;
  importConsent(text: string | null): Promise<Outcome<{ readonly applied: number; readonly alreadyImported: number; readonly alreadyReflected: number; readonly exceptions: readonly unknown[] }, 'pickFile' | 'notJson'>>;
}

const placeQuery = (key: string, p: Place, what: string): string =>
  `/v1/platform/rollout/${encodeURIComponent(key)}/${what}?branchId=${encodeURIComponent(p.branchId)}${p.laneId === undefined ? '' : `&laneId=${encodeURIComponent(p.laneId)}`}`;

export function createRolloutSession(input: { readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined; readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string }): RolloutSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const call = makeCaller({ keyPrefix: 'rollout', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const filled = (c: Change): boolean => /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/.test(c.key.trim()) && c.branchId.trim() !== '';
  const bodyOf = (c: Change): Record<string, unknown> => ({
    branchId: c.branchId.trim(), ...(c.laneId.trim() === '' ? {} : { laneId: c.laneId.trim() }), enabled: c.enabled,
  });
  return {
    may: {
      named, open: named && held.has('platform.flag.read'), change: named && held.has('platform.flag.write'),
      meter: named && held.has('platform.metering.read'), watch: named && held.has('privacy.volume.read'), consent: named && held.has('customer.consent.export'),
    },
    board: () => call('GET', '/v1/platform/rollout'),
    preview: async (c) => (filled(c) ? call('POST', `/v1/platform/rollout/${encodeURIComponent(c.key.trim())}/preview`, bodyOf(c)) : { result: 'invalid', why: 'needFields' }),
    save: async (c) => {
      if (!filled(c) || c.reason.trim() === '') return { result: 'invalid', why: 'needFields' };
      return call('PUT', `/v1/platform/rollout/${encodeURIComponent(c.key.trim())}`, { ...bodyOf(c), reason: c.reason.trim(), ...(c.approvalId.trim() === '' ? {} : { approvalId: c.approvalId.trim() }) });
    },
    history: (key, place) => call('GET', placeQuery(key, place, 'history')),
    rollback: async (key, place, toVersion, reason, approvalId) => {
      if (reason.trim() === '') return { result: 'invalid', why: 'needFields' };
      return call('POST', `/v1/platform/rollout/${encodeURIComponent(key)}/rollback`, { branchId: place.branchId, ...(place.laneId === undefined ? {} : { laneId: place.laneId }), toVersion, reason: reason.trim(), ...(approvalId === undefined || approvalId.trim() === '' ? {} : { approvalId: approvalId.trim() }) });
    },
    meter: () => call('GET', '/v1/platform/metering'),
    watch: () => call('GET', '/v1/privacy/data-volume-watch'),
    exportConsent: () => call('GET', '/v1/privacy/consent-manager/export'),
    importConsent: async (text) => {
      if (text === null || text.trim() === '') return { result: 'invalid', why: 'pickFile' };
      let doc: unknown;
      try { doc = JSON.parse(text); } catch { return { result: 'invalid', why: 'notJson' }; }
      return call('POST', '/v1/privacy/consent-manager/import', doc);
    },
  };
}
