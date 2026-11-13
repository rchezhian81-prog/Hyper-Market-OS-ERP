// Electronic shelf labels (U6 · UI/UX gap audit §27 "Product — label/ESL" · D14-FR-05 · D06-FR-06 · M05 "one price truth
// that reaches the shelf" · P-02 · P-03 · P-08 · hard rules #2 and #5). A tested, DOM-free session over head office's
// label routes for the PRODUCT person's question — did the shelf take the price the till charges? — kept apart from the
// administrator's device fleet (the Shelf labels and floor devices page registers, blocks and retires):
//   • PRICE PUSHES — `GET /v1/devices/esl/pushes?branchId=` (`price.integrity.audit`): every price head office sent to
//     this store's labels after a price change, and which labels have echoed it back. A shelf is known to match the till
//     only once EVERY label has shown the price back (`safeToChangeAtTill`); until then the push is not confirmed.
//   • SEND AGAIN — `POST /v1/devices/esl/pushes/:pushId/retry` (`price.integrity.audit`): the SAME price again to the labels
//     that have not confirmed — never a new price (a price changes only through the price routes, hard rule #5).
//   • THE LABELS — `GET /v1/devices/floor?branchId=` (`platform.health.read`): how many labels this store has, how many
//     are working and how many were never heard from. A person without that word reads "Not known" and why.
// Head office re-checks every permission; `may` only shapes what is offered. Head office's own sentences stay in English
// (OB-553, OB-699); every word this page adds has a Tamil twin. No vendor is connected: every answer is a stand-in.

import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';
import { pagedQuery, pagedAnswer, type RegisterAsk } from './register-paging';

export type Lang = 'en' | 'ta';

export type PushState = 'confirmed' | 'partial' | 'unconfirmed' | 'no_labels';

export interface EslPushRow {
  readonly pushId: string;
  readonly productId: string;
  readonly priceMinor: number;
  readonly because: 'price_change' | 'retry' | string;
  readonly at: string;
  readonly retryOf?: string;
  readonly labels: number;
  readonly confirmed: readonly string[];
  readonly unconfirmed: readonly string[];
  readonly state: PushState;
  /** Head office's sentence about this push (English). */
  readonly detail: string;
}

export interface EslPushes {
  readonly rows: readonly EslPushRow[];
  readonly notConfirmed: number;
  readonly rule: string;
  readonly hardware: string;
  readonly asAt: string | null;
}

/** U7 (OB-725): head office's summary of the WHOLE store's pushes — what the cards and "Send all again" read. */
export interface EslOverview {
  readonly sent: number;
  readonly confirmed: number;
  readonly waiting: number;
  readonly noLabels: number;
  /** The pushes not yet shown by every label — what "Send all again" sends (the same price, never a new one). */
  readonly waitingPushes: readonly { readonly pushId: string; readonly productId: string; readonly priceMinor: number; readonly unconfirmed: number }[];
  readonly asAt: string | null;
}

export interface EslLabels {
  readonly total: number;
  readonly active: number;
  readonly blocked: number;
  readonly retired: number;
  readonly neverHeard: number;
  readonly hardware: string;
  readonly asAt: string | null;
}

export type Why = 'nobody' | 'cannotRead' | 'cannotLabels';

export const ESL_COPY = {
  en: {
    title: 'Electronic shelf labels', lang: 'தமிழ்',
    lead: 'Every price head office sent to this store\'s electronic shelf labels after a price change, and whether each label has shown it back. The shelf is known to match the till only once every label has echoed the price; until then the push is not confirmed and the price-mismatch check treats it as such.',
    standin: 'No label maker is connected yet: every label here works through a stand-in, not verified on real hardware.',
    nobody: 'Nobody is signed in on this screen.',
    cannotRead: 'Your role does not read the shelf labels\' prices. Ask the owner or the store manager.',
    cannotLabels: 'Head office keeps the list of label devices to the platform administrator; the counts of labels are not known here.',
    unreachable: 'Head office cannot be reached. Nothing was changed. Try again once the link is back.',
    refused: 'Head office refused:',
    loading: 'Reading the labels\' prices…', notRead: 'The labels\' prices could not be read.', notReadDetail: 'Nothing is shown rather than a guess. Try again, or ask the owner.',
    cSent: 'Prices sent', cConfirmed: 'Shown on every label', cNotConfirmed: 'Not yet on every label', cLabels: 'Labels at this store', cActive: 'Working', cNever: 'Never heard from',
    pushesH: 'Prices sent to the labels', pushesLead: 'Newest first. A price not yet shown by every label can be sent again — the same price, never a new one.',
    noPushes: 'No price has been sent to a label at this store yet.', noPushesDetail: 'A push is made by head office after a price change, for every product that has an electronic label here.',
    product: 'Product', price: 'Price on the shelf', sentWhen: 'Sent', why: 'Why', labelsCol: 'Labels', state: 'State', action: 'Action',
    because_price_change: 'price change', because_retry: 'sent again',
    st_confirmed: 'Shown on every label', st_partial: 'Not on {n} label(s)', st_unconfirmed: 'Not shown by any label', st_no_labels: 'No label to send to',
    sendAgain: 'Send again', sendAll: 'Send the unconfirmed prices again', sendAllN: 'Send the {n} unconfirmed price(s) again', nothingToSend: 'Every price sent is shown on every label — nothing to send again.',
    confirmTitle: 'Send this price to the labels again?', confirmDetail: '{price} for {product} will be sent again to the {n} label(s) that have not shown it. The same price — nothing changes at the till.',
    confirmAllTitle: 'Send every unconfirmed price again?', confirmAllDetail: '{n} price(s) will be sent again to the labels that have not shown them. The same prices — nothing changes at the till.',
    confirmLabel: 'Send again', authority: 'In your name, recorded by head office.',
    sentAgain: 'Sent again to {n} label(s). The shelf is known to match once each has shown the price back.', sentAgainAll: 'Sent again: {done} of {all} price(s). {failed}',
    alreadyShown: 'Every label already shows this price — nothing was sent.', retryRefused: 'Not sent: {why}',
    readAt: 'Read at {time} · this store', mismatches: 'Price mismatches', devices: 'Register or block a label', refresh: 'Refresh',
    findingsEnglish: 'Head office\'s own sentences are in English.',
  },
  ta: {
    title: 'மின்னணு அலமாரி லேபிள்கள்', lang: 'English',
    lead: 'விலை மாற்றத்துக்குப் பிறகு தலைமை அலுவலகம் இந்தக் கடையின் மின்னணு அலமாரி லேபிள்களுக்கு அனுப்பிய ஒவ்வொரு விலையும், அதை ஒவ்வொரு லேபிளும் திருப்பிக் காட்டியதா என்பதும். ஒவ்வொரு லேபிளும் விலையைத் திருப்பிக் காட்டிய பிறகே அலமாரி கல்லாவுடன் பொருந்துவது உறுதி; அதுவரை அனுப்பல் உறுதி செய்யப்படவில்லை.',
    standin: 'லேபிள் தயாரிப்பாளர் யாரும் இன்னும் இணைக்கப்படவில்லை: இங்குள்ள ஒவ்வொரு லேபிளும் ஒரு மாற்று வழியாகச் செயல்படுகிறது; உண்மையான சாதனத்தில் சரிபார்க்கப்படவில்லை.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.',
    cannotRead: 'உங்கள் பங்கு அலமாரி லேபிள்களின் விலைகளைப் படிக்காது. உரிமையாளரையோ கடை மேலாளரையோ கேளுங்கள்.',
    cannotLabels: 'லேபிள் சாதனங்களின் பட்டியலைத் தலைமை அலுவலகம் தள நிர்வாகியிடம் மட்டுமே வைத்துள்ளது; லேபிள்களின் எண்ணிக்கை இங்கு தெரியாது.',
    unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை. எதுவும் மாற்றப்படவில்லை. இணைப்பு திரும்பியதும் மீண்டும் முயலுங்கள்.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:',
    loading: 'லேபிள்களின் விலைகளைப் படிக்கிறது…', notRead: 'லேபிள்களின் விலைகளைப் படிக்க முடியவில்லை.', notReadDetail: 'ஊகத்துக்குப் பதிலாக எதுவும் காட்டப்படவில்லை. மீண்டும் முயலுங்கள், அல்லது உரிமையாளரைக் கேளுங்கள்.',
    cSent: 'அனுப்பிய விலைகள்', cConfirmed: 'எல்லா லேபிள்களிலும் காட்டப்பட்டது', cNotConfirmed: 'இன்னும் எல்லா லேபிள்களிலும் இல்லை', cLabels: 'இந்தக் கடையின் லேபிள்கள்', cActive: 'வேலை செய்கிறது', cNever: 'ஒருபோதும் கேட்கப்படவில்லை',
    pushesH: 'லேபிள்களுக்கு அனுப்பிய விலைகள்', pushesLead: 'புதியது முதலில். எல்லா லேபிள்களும் இன்னும் காட்டாத விலையை மீண்டும் அனுப்பலாம் — அதே விலை, புதிய விலை அல்ல.',
    noPushes: 'இந்தக் கடையில் எந்த லேபிளுக்கும் இன்னும் விலை அனுப்பப்படவில்லை.', noPushesDetail: 'விலை மாற்றத்துக்குப் பிறகு, இங்கு மின்னணு லேபிள் உள்ள ஒவ்வொரு பொருளுக்கும் தலைமை அலுவலகம் அனுப்புகிறது.',
    product: 'பொருள்', price: 'அலமாரியில் விலை', sentWhen: 'அனுப்பியது', why: 'ஏன்', labelsCol: 'லேபிள்கள்', state: 'நிலை', action: 'செயல்',
    because_price_change: 'விலை மாற்றம்', because_retry: 'மீண்டும் அனுப்பியது',
    st_confirmed: 'எல்லா லேபிள்களிலும் காட்டப்பட்டது', st_partial: '{n} லேபிளில் இல்லை', st_unconfirmed: 'எந்த லேபிளும் காட்டவில்லை', st_no_labels: 'அனுப்ப லேபிள் இல்லை',
    sendAgain: 'மீண்டும் அனுப்பு', sendAll: 'உறுதி செய்யப்படாத விலைகளை மீண்டும் அனுப்பு', sendAllN: 'உறுதி செய்யப்படாத {n} விலை(களை) மீண்டும் அனுப்பு', nothingToSend: 'அனுப்பிய ஒவ்வொரு விலையும் எல்லா லேபிள்களிலும் காட்டப்படுகிறது — மீண்டும் அனுப்ப எதுவும் இல்லை.',
    confirmTitle: 'இந்த விலையை லேபிள்களுக்கு மீண்டும் அனுப்பவா?', confirmDetail: '{product}க்கான {price} அதைக் காட்டாத {n} லேபிளுக்கு மீண்டும் அனுப்பப்படும். அதே விலை — கல்லாவில் எதுவும் மாறாது.',
    confirmAllTitle: 'உறுதி செய்யப்படாத ஒவ்வொரு விலையையும் மீண்டும் அனுப்பவா?', confirmAllDetail: '{n} விலை(கள்) அவற்றைக் காட்டாத லேபிள்களுக்கு மீண்டும் அனுப்பப்படும். அதே விலைகள் — கல்லாவில் எதுவும் மாறாது.',
    confirmLabel: 'மீண்டும் அனுப்பு', authority: 'உங்கள் பெயரில், தலைமை அலுவலகத்தால் பதிவு செய்யப்படும்.',
    sentAgain: '{n} லேபிளுக்கு மீண்டும் அனுப்பப்பட்டது. ஒவ்வொன்றும் விலையைத் திருப்பிக் காட்டிய பிறகே அலமாரி பொருந்துவது உறுதி.', sentAgainAll: 'மீண்டும் அனுப்பியது: {all}இல் {done} விலை(கள்). {failed}',
    alreadyShown: 'எல்லா லேபிள்களும் ஏற்கனவே இந்த விலையைக் காட்டுகின்றன — எதுவும் அனுப்பப்படவில்லை.', retryRefused: 'அனுப்பப்படவில்லை: {why}',
    readAt: '{time} மணிக்குப் படிக்கப்பட்டது · இந்தக் கடை', mismatches: 'விலை முரண்பாடுகள்', devices: 'லேபிளைப் பதிவு செய் அல்லது தடு', refresh: 'புதுப்பி',
    findingsEnglish: 'தலைமை அலுவலகத்தின் சொந்த வாக்கியங்கள் ஆங்கிலத்தில் உள்ளன.',
  },
} as const;

export type EslKey = keyof typeof ESL_COPY.en;

export function eslWords(lang: Lang, key: EslKey | string): string {
  const table = ESL_COPY[lang] as Readonly<Record<string, string>>;
  return table[key] ?? (ESL_COPY.en as Readonly<Record<string, string>>)[key] ?? key;
}

export function fill(words: string, values: Readonly<Record<string, string | number>>): string {
  return words.replace(/\{(\w+)\}/g, (_, k: string) => (values[k] === undefined ? `{${k}}` : String(values[k])));
}

export function eslOutcomeWords(lang: Lang, out: Outcome<unknown>): string {
  return outcomeIn((k) => eslWords(lang, k), out, lang);
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** The state of one push, from what head office said about its labels. */
export function pushStateOf(labels: number, confirmed: number): PushState {
  if (labels === 0) return 'no_labels';
  if (confirmed >= labels) return 'confirmed';
  return confirmed === 0 ? 'unconfirmed' : 'partial';
}

/** Head office's answer to `GET /v1/devices/esl/pushes`, read into rows — newest first, as head office sorts them. */
export function readPushes(body: unknown): EslPushes {
  const b = isObj(body) ? body : {};
  const rows: EslPushRow[] = (Array.isArray(b['pushes']) ? b['pushes'] : []).flatMap((j): EslPushRow[] => {
    if (!isObj(j) || !isObj(j['push'])) return [];
    const p = j['push'];
    const confirmed = strs(j['confirmed']); const unconfirmed = strs(j['unconfirmed']);
    const labels = Array.isArray(p['commands']) ? p['commands'].length : confirmed.length + unconfirmed.length;
    const pushId = str(p['pushId']); if (pushId === '') return [];
    return [{
      pushId, productId: str(p['productId']), priceMinor: num(p['priceMinor']), because: str(p['because']) || 'price_change', at: str(p['at']),
      ...(str(p['retryOf']) === '' ? {} : { retryOf: str(p['retryOf']) }),
      labels, confirmed, unconfirmed, state: pushStateOf(labels, confirmed.length), detail: str(j['detail']),
    }];
  });
  return { rows, notConfirmed: num(b['notConfirmed']), rule: str(b['rule']), hardware: str(b['hardware']), asAt: str(b['asAt']) || null };
}

/** Head office's answer to `GET /v1/devices/floor`, counted for the labels only. */
export function readLabels(body: unknown): EslLabels {
  const b = isObj(body) ? body : {};
  const labels = (Array.isArray(b['devices']) ? b['devices'] : []).filter((d): d is Record<string, unknown> => isObj(d) && d['kind'] === 'esl_label');
  const count = (status: string): number => labels.filter((d) => d['status'] === status).length;
  return {
    total: labels.length, active: count('active'), blocked: count('blocked'), retired: count('retired'),
    neverHeard: labels.filter((d) => d['status'] === 'active' && (d['lastHeardAt'] === null || d['lastHeardAt'] === undefined)).length,
    hardware: str(b['hardware']), asAt: str(b['asAt']) || null,
  };
}

export interface RetryAnswer { readonly pushId: string; readonly retried: boolean; readonly sentTo: readonly string[]; readonly detail: string }

export interface EslSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly labels: boolean };
  readonly store: string;
  pushes(): Promise<Outcome<EslPushes> | { result: 'invalid'; why: Why }>;
  /** U7: ONE page of the pushes, searched (product name or code) and sorted (time, product) by head office. */
  page(ask: RegisterAsk): Promise<Outcome<{ readonly rows: readonly EslPushRow[]; readonly total: number }> | { result: 'invalid'; why: Why }>;
  /** U7: the whole store's summary (sent, shown everywhere, waiting, no label) — without reading every row. */
  overview(): Promise<Outcome<EslOverview> | { result: 'invalid'; why: Why }>;
  labels(): Promise<Outcome<EslLabels> | { result: 'invalid'; why: Why }>;
  /** The SAME price again to the labels that have not confirmed it — never a new price. */
  retry(pushId: string): Promise<Outcome<RetryAnswer> | { result: 'invalid'; why: Why }>;
}

export function createEslSession(input: {
  readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined;
  readonly fetch?: typeof globalThis.fetch;
  /** The box's own store (from its signed pack); head office keeps the read to the stores the person may see. */
  readonly storeId?: string;
}): EslSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, read: named && held.has('price.integrity.audit'), labels: named && held.has('platform.health.read') };
  const call = makeCaller({ keyPrefix: 'esl', ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
  const store = input.storeId?.trim() ?? '';
  const q = `?branchId=${encodeURIComponent(store)}`;
  const gate = (need: 'read' | 'labels'): { result: 'invalid'; why: Why } | undefined =>
    !named ? { result: 'invalid', why: 'nobody' } : !may[need] ? { result: 'invalid', why: need === 'read' ? 'cannotRead' : 'cannotLabels' } : undefined;
  return {
    may, store,
    pushes: async () => {
      const no = gate('read'); if (no !== undefined) return no;
      const out = await call<unknown>('GET', `/v1/devices/esl/pushes${q}`);
      return out.result === 'ok' ? { result: 'ok', value: readPushes(out.value) } : out;
    },
    page: async (ask) => {
      const no = gate('read'); if (no !== undefined) return no;
      const out = await call<unknown>('GET', `/v1/devices/esl/pushes${q}&${pagedQuery(ask, { at: 'at', productId: 'productId' })}`);
      if (out.result !== 'ok') return out;
      const page = pagedAnswer(out.value, 'pushes');
      return page === undefined ? { result: 'lost_link' } : { result: 'ok', value: { rows: readPushes(out.value).rows, total: page.total } };
    },
    overview: async () => {
      const no = gate('read'); if (no !== undefined) return no;
      const out = await call<unknown>('GET', `/v1/devices/esl/pushes${q}&page=1&size=1`);
      if (out.result !== 'ok') return out;
      const b = isObj(out.value) ? out.value : {};
      const sm = isObj(b['summary']) ? b['summary'] : null;
      if (sm === null) return { result: 'lost_link' };
      const waitingPushes = (Array.isArray(sm['waitingPushes']) ? sm['waitingPushes'] : []).filter(isObj)
        .map((w) => ({ pushId: str(w['pushId']), productId: str(w['productId']), priceMinor: num(w['priceMinor']), unconfirmed: num(w['unconfirmed']) }))
        .filter((w) => w.pushId !== '');
      return { result: 'ok', value: { sent: num(sm['sent']), confirmed: num(sm['confirmed']), waiting: num(sm['waiting']), noLabels: num(sm['noLabels']), waitingPushes, asAt: str(b['asAt']) || null } };
    },
    labels: async () => {
      const no = gate('labels'); if (no !== undefined) return no;
      const out = await call<unknown>('GET', `/v1/devices/floor${q}`);
      return out.result === 'ok' ? { result: 'ok', value: readLabels(out.value) } : out;
    },
    retry: async (pushId) => {
      const no = gate('read'); if (no !== undefined) return no;
      const out = await call<Record<string, unknown>>('POST', `/v1/devices/esl/pushes/${encodeURIComponent(pushId)}/retry`, {});
      if (out.result !== 'ok') return out;
      const v = isObj(out.value) ? out.value : {};
      return { result: 'ok', value: { pushId: str(v['pushId']) || pushId, retried: v['retried'] === true, sentTo: strs(v['sentTo']), detail: str(v['detail']) } };
    },
  };
}
