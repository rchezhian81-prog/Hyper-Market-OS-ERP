// Store computers — the screen's tested, DOM-free session (round 26 · OB-99 "A" · OB-97 · OB-98 · M35-FR-03 · P-03 · P-08).
//
// Head office binds each till's bill-number prefix to ONE store computer (its own sign-in — OB-94); this page shows those
// bindings (`GET /v1/store-computers/prefix-bindings`), the store computers' findings that only a person can clear (a
// refused report, numbers not checked — read from head office's observed health), and the "store computer replaced" act:
//
//   1. head office business staff (all stores, never IT — OB-91/OB-95) ASK the owner's approval on the maker-checker engine
//      (`POST /v1/approvals/requests`, kind `store_computer_replaced`, details exactly what the act will send);
//   2. the owner approves on his own Approvals page, in his own session (never his own request);
//   3. the same person SENDS the act with that approval (`POST /v1/store-computers/replacements`).
// The owner or head office staff acknowledge a refused report or a not-checked line with a reason.
//
// Round 27 · OB-100 "A": the numbers each store computer took and never used are shown too — per store, till prefix and day
// (count and numbers), as information, never as something to look for — and a sale head office holds under a number the
// store computer kept calling unused is a finding that needs a person (support checks the store computer).
// Round 28 · OB-103 "A" (owner, 13 Oct 2026, in writing, "You/HO acknowledge"): that line is acknowledged here too, by the
// owner or head office staff (all stores, never IT), with a reason, once support has checked the store computer. Head office
// keeps who, why and when; the acknowledgement holds while it finds the same set of numbers — a new number shows the line
// again (`POST /v1/store-computers/unused-numbers-received/acknowledgements`). Round 29 · verifier r28 NEW-5: an acknowledgement
// sends the EXACT numbers the page showed (not only how many); head office refuses it (409) if the line has changed since.
//
// Every rule is head office's: what this person may do comes from head office's own answer (`you` on the bindings read —
// the same rule the acts use), never from the page; each act is re-checked there and a refusal is shown in its own words.
// The session refuses only the cheap things before a POST (a blank field, a short reason) and never writes on open. The
// act's idempotency key is made from its approval, so a retried click is the same act.

import type { ViewerIdentity } from './browser-entry';

export type Lang = 'en' | 'ta';

export interface Binding { readonly storeId: string; readonly prefix: string; readonly computer: string; readonly since: string; readonly via: 'first_report' | 'replacement'; readonly replacementId?: string }
export interface Replacement {
  readonly replacementId: string; readonly storeId: string; readonly prefix: string; readonly from: string; readonly to: string;
  readonly reason: string; readonly requestedBy: string; readonly approvedBy: string; readonly approvalId: string; readonly at: string;
}
/** A store computer's finding a person must clear (from head office's observed health). */
export interface Finding {
  readonly storeId: string; readonly kind: 'report_refused' | 'at_risk_not_checked' | 'unused_number_received'; readonly prefix: string;
  readonly through?: number; readonly count?: number; readonly ranges?: readonly (readonly [number, number])[]; readonly since: string; readonly detail: string;
}
/** One of this person's "store computer replaced" requests on the approvals engine. */
export interface ReplacementRequest {
  readonly requestId: string; readonly status: 'waiting' | 'approved' | 'rejected' | 'expired' | 'used';
  readonly details: { readonly storeId: string; readonly prefix: string; readonly fromComputer: string; readonly toComputer: string; readonly reason: string };
  readonly requestedAt: string; readonly decidedBy?: string; readonly decisionReason?: string;
}
/** Round 27 · OB-100: one till's numbers taken and never used on one day (the store's calendar), from head office's observed health. */
export interface UnusedRow {
  readonly storeId: string; readonly prefix: string; readonly day: string; readonly count: number;
  readonly ranges: readonly (readonly [number, number])[]; readonly moreRanges: number;
}
export interface Board {
  readonly bindings: readonly Binding[];
  /** Round 27 · OB-100: numbers taken and never used, newest day first. */
  readonly unused: readonly UnusedRow[];
  readonly replacements: readonly Replacement[];
  readonly findings: readonly Finding[];
  readonly requests: readonly ReplacementRequest[];
  /** Head office's own answer: what this person may do here. */
  readonly you: { readonly mayReplace: boolean; readonly mayAcknowledge: boolean };
}

export type Outcome<T> =
  | { readonly result: 'ok'; readonly value: T }
  | { readonly result: 'refused'; readonly status: number; readonly code: string; readonly whatHappened: string }
  | { readonly result: 'invalid'; readonly why: CopyKey }
  | { readonly result: 'lost_link' };

export type CopyKey = keyof typeof STORE_COMPUTERS_COPY.en;

export const KIND = 'store_computer_replaced';
export const BINDINGS_PATH = '/v1/store-computers/prefix-bindings';
export const REPLACE_PATH = '/v1/store-computers/replacements';
export const REFUSAL_ACK_PATH = '/v1/store-computers/bill-number-refusals/acknowledgements';
export const NOT_CHECKED_ACK_PATH = '/v1/store-computers/at-risk-not-checked/acknowledgements';
export const UNUSED_RECEIVED_ACK_PATH = '/v1/store-computers/unused-numbers-received/acknowledgements';

export const STORE_COMPUTERS_COPY = {
  en: {
    title: 'Store computers', lang: 'தமிழ்',
    lead: 'Which store computer each till\'s bill numbers belong to, what needs a person, and moving a till to a replacement store computer with the owner\'s approval.',
    replace: 'Record a replaced store computer',
    sumBindings: 'Tills with a store computer', sumReplaced: 'Moved by a replaced act', sumNeeds: 'Needs a person', sumWaiting: 'Your requests waiting',
    tabBindings: 'Bill numbers', tabFindings: 'Needs a person', tabRequests: 'Replacements',
    bindingsLead: 'Each till\'s bill-number prefix and the one store computer head office takes its word from.',
    findingsLead: 'Store computer reports head office refused, older numbers it did not check, and numbers a store computer called unused after head office received the bill. Each stays until a person acknowledges it with a reason.',
    requestsLead: 'Your "store computer replaced" requests, and every act already done. Once the owner approves a request, send the move.',
    colStore: 'Store', colPrefix: 'Till prefix', colComputer: 'Store computer (sign-in)', colVia: 'How', colSince: 'Since',
    viaFirst: 'first to report it', viaReplaced: 'replaced store computer (owner approved)',
    noBindings: 'No store computer has reported bill numbers yet.', noFindings: 'Nothing needs a person.', noRequests: 'No replacement asked for or done yet.',
    kindRefused: 'Report refused', kindNotChecked: 'Numbers not checked', kindUnusedReceived: 'Said unused, but head office has the bill',
    unusedH: 'Taken but never used', unusedLead: 'Bill numbers each store computer says it took and never put on a bill — an abandoned bill, a card declined after the number was taken. Information only: nothing to look for. If one day shows many, ask the store why.',
    colDay: 'Day', colCount: 'How many', colNumbers: 'Numbers', noUnused: 'No store computer has said it took a number and never used it.', moreRanges: 'and {n} more',
    notAcknowledgeable: 'This one is not acknowledged here — support checks the store computer. Nothing was sent.', sumUnused: 'Taken but never used',
    ackReason: 'Why it can be acknowledged', acknowledge: 'Acknowledge with this reason', acknowledged: 'Acknowledged in your name.',
    fStore: 'Store', fPrefix: 'Till bill-number prefix', fFrom: 'Old store computer (its sign-in)', fTo: 'New store computer (its sign-in)', fReason: 'Why',
    ask: 'Ask the owner\'s approval', cancel: 'Close', asked: 'Asked — the owner approves it on his Approvals page. Then send the move here.',
    stWaiting: 'Waiting for the owner', stApproved: 'Approved by {by} — ready to send', stRejected: 'Rejected by {by}: {why}', stExpired: 'Approval expired — ask again', stUsed: 'Done',
    send: 'Move the bill numbers now', sent: 'Moved — head office now takes {prefix}\'s bill numbers from {to}.',
    actLine: '{prefix} at {store}: {from} → {to} — asked by {by}, approved by {approver}, {at}',
    needAll: 'Fill in every field first. Nothing was sent.', shortReason: 'Write a reason of at least 5 characters. Nothing was sent.', sameComputer: 'The new store computer must be a different sign-in. Nothing was sent.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was changed.',
    reading: 'Reading from head office…', cannotRead: 'Your role cannot read the store computers.',
    notYours: 'You can read this. Moving bill numbers and acknowledging findings are for the owner and head office staff who cover all stores.',
    nobody: 'Nobody is signed in on this screen — you can read nothing and change nothing.',
  },
  ta: {
    title: 'கடை கணினிகள்', lang: 'English',
    lead: 'ஒவ்வொரு கவுண்டரின் பில் எண்களும் எந்தக் கடை கணினிக்குச் சொந்தம், எதற்கு ஒருவர் தேவை, உரிமையாளர் அனுமதியுடன் கவுண்டரை மாற்றுக் கடை கணினிக்கு நகர்த்துதல்.',
    replace: 'மாற்றப்பட்ட கடை கணினியைப் பதிவு செய்',
    sumBindings: 'கடை கணினி உள்ள கவுண்டர்கள்', sumReplaced: 'மாற்றுச் செயலால் நகர்த்தப்பட்டவை', sumNeeds: 'ஒருவர் தேவை', sumWaiting: 'காத்திருக்கும் உங்கள் கோரிக்கைகள்',
    tabBindings: 'பில் எண்கள்', tabFindings: 'ஒருவர் தேவை', tabRequests: 'மாற்றங்கள்',
    bindingsLead: 'ஒவ்வொரு கவுண்டரின் பில் எண் முன்னொட்டும், தலைமை அலுவலகம் நம்பும் ஒரே கடை கணினியும்.',
    findingsLead: 'தலைமை அலுவலகம் மறுத்த கடை கணினி அறிக்கைகள், சரிபார்க்காத பழைய எண்கள், தலைமை அலுவலகம் பில்லைப் பெற்ற பிறகும் கடை கணினி பயன்படாதது என்று சொன்ன எண்கள். காரணத்துடன் ஒருவர் ஒப்புக்கொள்ளும் வரை ஒவ்வொன்றும் இருக்கும்.',
    requestsLead: 'உங்கள் "கடை கணினி மாற்றப்பட்டது" கோரிக்கைகளும் ஏற்கனவே செய்த செயல்களும். உரிமையாளர் அனுமதித்ததும் நகர்வை அனுப்புங்கள்.',
    colStore: 'கடை', colPrefix: 'கவுண்டர் முன்னொட்டு', colComputer: 'கடை கணினி (உள்நுழைவு)', colVia: 'எப்படி', colSince: 'முதல்',
    viaFirst: 'முதலில் அறிவித்தது', viaReplaced: 'மாற்றப்பட்ட கடை கணினி (உரிமையாளர் அனுமதி)',
    noBindings: 'எந்தக் கடை கணினியும் இன்னும் பில் எண்களை அறிவிக்கவில்லை.', noFindings: 'எதற்கும் ஒருவர் தேவையில்லை.', noRequests: 'இன்னும் மாற்றம் கேட்கப்படவில்லை, செய்யப்படவில்லை.',
    kindRefused: 'அறிக்கை மறுக்கப்பட்டது', kindNotChecked: 'சரிபார்க்காத எண்கள்', kindUnusedReceived: 'பயன்படாதது எனச் சொன்னது, ஆனால் பில் தலைமை அலுவலகத்தில் உள்ளது',
    unusedH: 'எடுத்தும் பயன்படுத்தாதவை', unusedLead: 'ஒவ்வொரு கடை கணினியும் எடுத்து எந்தப் பில்லிலும் போடாததாகச் சொல்லும் பில் எண்கள் — கைவிடப்பட்ட பில், எண் எடுத்த பின் மறுக்கப்பட்ட அட்டை. தகவலுக்கு மட்டும்: தேட எதுவும் இல்லை. ஒரு நாளில் அதிகம் இருந்தால், கடையிடம் காரணம் கேளுங்கள்.',
    colDay: 'நாள்', colCount: 'எத்தனை', colNumbers: 'எண்கள்', noUnused: 'எந்தக் கடை கணினியும் எண்ணை எடுத்துப் பயன்படுத்தவில்லை என்று சொல்லவில்லை.', moreRanges: 'மேலும் {n}',
    notAcknowledgeable: 'இதை இங்கே ஒப்புக்கொள்ள முடியாது — உதவிக் குழு கடை கணினியைச் சரிபார்க்கும். எதுவும் அனுப்பப்படவில்லை.', sumUnused: 'எடுத்தும் பயன்படுத்தாதவை',
    ackReason: 'ஒப்புக்கொள்ளக் காரணம்', acknowledge: 'இந்தக் காரணத்துடன் ஒப்புக்கொள்', acknowledged: 'உங்கள் பெயரில் ஒப்புக்கொள்ளப்பட்டது.',
    fStore: 'கடை', fPrefix: 'கவுண்டர் பில் எண் முன்னொட்டு', fFrom: 'பழைய கடை கணினி (உள்நுழைவு)', fTo: 'புதிய கடை கணினி (உள்நுழைவு)', fReason: 'ஏன்',
    ask: 'உரிமையாளர் அனுமதி கேள்', cancel: 'மூடு', asked: 'கேட்கப்பட்டது — உரிமையாளர் தன் அனுமதிகள் பக்கத்தில் அனுமதிப்பார். பிறகு இங்கே நகர்வை அனுப்புங்கள்.',
    stWaiting: 'உரிமையாளருக்காகக் காத்திருக்கிறது', stApproved: '{by} அனுமதித்தார் — அனுப்பத் தயார்', stRejected: '{by} மறுத்தார்: {why}', stExpired: 'அனுமதி காலாவதியானது — மீண்டும் கேளுங்கள்', stUsed: 'முடிந்தது',
    send: 'பில் எண்களை இப்போது நகர்த்து', sent: 'நகர்த்தப்பட்டது — இனி {prefix} பில் எண்களைத் தலைமை அலுவலகம் {to} இடமிருந்து எடுக்கும்.',
    actLine: '{store} இல் {prefix}: {from} → {to} — கேட்டவர் {by}, அனுமதித்தவர் {approver}, {at}',
    needAll: 'முதலில் எல்லாப் புலங்களையும் நிரப்புங்கள். எதுவும் அனுப்பப்படவில்லை.', shortReason: 'குறைந்தது 5 எழுத்துகளில் காரணம் எழுதுங்கள். எதுவும் அனுப்பப்படவில்லை.', sameComputer: 'புதிய கடை கணினி வேறு உள்நுழைவாக இருக்க வேண்டும். எதுவும் அனுப்பப்படவில்லை.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் மாற்றப்படவில்லை.',
    reading: 'தலைமை அலுவலகத்திலிருந்து படிக்கிறது…', cannotRead: 'உங்கள் பங்கால் கடை கணினிகளைப் படிக்க முடியாது.',
    notYours: 'நீங்கள் படிக்கலாம். பில் எண்களை நகர்த்துவதும் கண்டுபிடிப்புகளை ஒப்புக்கொள்வதும் எல்லாக் கடைகளுக்கும் பொறுப்பான உரிமையாளர், தலைமை அலுவலகப் பணியாளர்களுக்கு மட்டும்.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை — எதையும் படிக்கவோ மாற்றவோ முடியாது.',
  },
} as const;

/** One word in the reader's language, with `{name}` slots filled. */
export function wordsFor(lang: Lang, key: CopyKey, slots: Readonly<Record<string, string | number>> = {}): string {
  let text: string = STORE_COMPUTERS_COPY[lang][key] ?? STORE_COMPUTERS_COPY.en[key];
  for (const [k, v] of Object.entries(slots)) text = text.split(`{${k}}`).join(String(v));
  return text;
}

/** How a refusal or a lost link reads to a person (a success reads its own word). */
export function outcomeWords(lang: Lang, out: Outcome<unknown>): string {
  if (out.result === 'refused') return `${wordsFor(lang, 'refused')} ${out.whatHappened}`;
  if (out.result === 'invalid') return wordsFor(lang, out.why);
  if (out.result === 'lost_link') return wordsFor(lang, 'unreachable');
  return '';
}

/** How a request stands, in the reader's words. */
export function requestWords(lang: Lang, r: ReplacementRequest): string {
  switch (r.status) {
    case 'waiting': return wordsFor(lang, 'stWaiting');
    case 'approved': return wordsFor(lang, 'stApproved', { by: r.decidedBy ?? '' });
    case 'rejected': return wordsFor(lang, 'stRejected', { by: r.decidedBy ?? '', why: r.decisionReason ?? '' });
    case 'expired': return wordsFor(lang, 'stExpired');
    default: return wordsFor(lang, 'stUsed');
  }
}

/** A finding's short label. */
export const findingKindWords = (lang: Lang, f: Finding): string =>
  wordsFor(lang, f.kind === 'report_refused' ? 'kindRefused' : f.kind === 'unused_number_received' ? 'kindUnusedReceived' : 'kindNotChecked');
/** A finding a person acknowledges HERE: a refused report, a not-checked line, and (round 28 · OB-103) "said unused, but held". */
export const acknowledgeable = (f: Finding): boolean => f.kind === 'report_refused' || f.kind === 'at_risk_not_checked' || f.kind === 'unused_number_received';
/** Round 27 · OB-100: an unused row's numbers as the till prints them (prefix + six digits), ranges joined. */
export function unusedNumbersWords(lang: Lang, row: UnusedRow): string {
  const pad = (n: number): string => String(n).padStart(6, '0');
  const list = row.ranges.map(([a, z]) => (a === z ? `${row.prefix}${pad(a)}` : `${row.prefix}${pad(a)}–${row.prefix}${pad(z)}`)).join(', ');
  return row.moreRanges > 0 ? `${list} ${wordsFor(lang, 'moreRanges', { n: row.moreRanges })}` : list;
}

/** The figures at the top of the page (round 27: and how many numbers were taken and never used in the days shown). */
export function summarise(board: Board | null): { readonly bindings: number | null; readonly replaced: number | null; readonly needs: number | null; readonly waiting: number | null; readonly unused: number | null } {
  if (board === null) return { bindings: null, replaced: null, needs: null, waiting: null, unused: null };
  return {
    bindings: board.bindings.length,
    replaced: board.bindings.filter((b) => b.via === 'replacement').length,
    needs: board.findings.length,
    waiting: board.requests.filter((r) => r.status === 'waiting' || r.status === 'approved').length,
    unused: board.unused.reduce((n, u) => n + u.count, 0),
  };
}

/** The bindings in the order the register shows them: by store, then prefix. */
export const orderedBindings = (bindings: readonly Binding[]): Binding[] =>
  [...bindings].sort((a, b) => a.storeId.localeCompare(b.storeId) || a.prefix.localeCompare(b.prefix));

export interface StoreComputersSession {
  readonly may: { readonly named: boolean; readonly read: boolean };
  /** Everything the page shows, from head office (nothing is written). */
  load(): Promise<Outcome<Board>>;
  /** Step 1: ask the owner's approval for exactly this move. */
  ask(form: { readonly storeId: string; readonly prefix: string; readonly fromComputer: string; readonly toComputer: string; readonly reason: string }): Promise<Outcome<{ readonly requestId: string }>>;
  /** Step 3: send the move with the owner's approval. */
  send(request: ReplacementRequest): Promise<Outcome<{ readonly replacement: Replacement }>>;
  /** Acknowledge a refused report, a not-checked line or a "said unused, but held" line, with a reason. */
  acknowledge(finding: Finding, reason: string): Promise<Outcome<unknown>>;
}

const blank = (s: string | undefined): boolean => s === undefined || s.trim() === '';
const isFindingKind = (k: unknown): k is Finding['kind'] => k === 'report_refused' || k === 'at_risk_not_checked' || k === 'unused_number_received';
const isWholeCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

export function createStoreComputersSession(input: {
  readonly viewer: ViewerIdentity | undefined;
  readonly fetch?: typeof globalThis.fetch;
  readonly newKey?: () => string;
}): StoreComputersSession {
  const perms = new Set(input.viewer?.permissions ?? []);
  const named = input.viewer?.userId !== undefined;
  const may = { named, read: named && perms.has('platform.health.read') };
  const rand = (): string => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
  const newKey = input.newKey ?? (() => `scp-${rand()}`);
  const http = input.fetch ?? ((...a: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...a));

  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown, key?: string): Promise<Outcome<T>> {
    try {
      const res = await http(path, {
        method, credentials: 'same-origin',
        headers: { accept: 'application/json', ...(method === 'POST' ? { 'content-type': 'application/json', 'idempotency-key': key ?? newKey() } : {}) },
        ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        const err = (json['error'] ?? {}) as { code?: string; whatHappened?: string };
        return { result: 'refused', status: res.status, code: err.code ?? String(res.status), whatHappened: err.whatHappened ?? `status ${res.status}` };
      }
      return { result: 'ok', value: json as T };
    } catch {
      return { result: 'lost_link' };
    }
  }
  const nobody = { result: 'invalid', why: 'nobody' } as const;
  const reasonOk = (s: string): boolean => s.trim().length >= 5;

  return {
    may,
    load: async () => {
      if (!named) return nobody;
      const bound = await call<{ bindings: Binding[]; replacements: Replacement[]; you?: Board['you'] }>('GET', BINDINGS_PATH);
      if (bound.result !== 'ok') return bound;
      // The findings a person must clear, from head office's observed health (a failed read shows none, and says so by its status).
      const observed = await call<{ observed?: { boxes?: { storeId: string; billNumberFindings?: Omit<Finding, 'storeId'>[]; unusedNumbers?: Omit<UnusedRow, 'storeId'>[] }[] } }>('GET', '/v1/platform/operational-health/observed');
      const boxes = observed.result !== 'ok' ? [] : observed.value.observed?.boxes ?? [];
      const findings: Finding[] = boxes.flatMap((b) =>
        (b.billNumberFindings ?? []).filter((f) => isFindingKind(f.kind)).map((f) => ({ ...f, storeId: b.storeId })));
      // Round 27 · OB-100: the numbers taken and never used, as head office says them (newest day first).
      const unused: UnusedRow[] = boxes.flatMap((b) => (b.unusedNumbers ?? [])
        .filter((u) => typeof u.prefix === 'string' && typeof u.day === 'string' && isWholeCount(u.count) && Array.isArray(u.ranges))
        .map((u) => ({ storeId: b.storeId, prefix: u.prefix, day: u.day, count: u.count, ranges: u.ranges, moreRanges: isWholeCount(u.moreRanges) ? u.moreRanges : 0 })))
        .sort((a, b) => b.day.localeCompare(a.day) || a.storeId.localeCompare(b.storeId) || a.prefix.localeCompare(b.prefix));
      // This person's own requests on the approvals engine (only the store computer kind).
      const inbox = await call<{ mine?: (ReplacementRequest & { kind: string })[] }>('GET', '/v1/approvals/requests');
      const requests: ReplacementRequest[] = inbox.result !== 'ok' ? [] : (inbox.value.mine ?? []).filter((r) => r.kind === KIND)
        .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
      return {
        result: 'ok',
        value: {
          bindings: orderedBindings(bound.value.bindings ?? []), unused, replacements: bound.value.replacements ?? [], findings, requests,
          you: { mayReplace: bound.value.you?.mayReplace === true, mayAcknowledge: bound.value.you?.mayAcknowledge === true },
        },
      };
    },
    ask: async (f) => {
      if (!named) return nobody;
      if ([f.storeId, f.prefix, f.fromComputer, f.toComputer, f.reason].some(blank)) return { result: 'invalid', why: 'needAll' };
      if (!reasonOk(f.reason)) return { result: 'invalid', why: 'shortReason' };
      if (f.fromComputer.trim() === f.toComputer.trim()) return { result: 'invalid', why: 'sameComputer' };
      // The details are EXACTLY what step 3 will send — the engine fingerprints them.
      const details = { storeId: f.storeId.trim(), prefix: f.prefix.trim(), fromComputer: f.fromComputer.trim(), toComputer: f.toComputer.trim(), reason: f.reason.trim() };
      const out = await call<{ requestId: string }>('POST', '/v1/approvals/requests', {
        kind: KIND, subjectRef: `${details.storeId}/${details.prefix}`, details,
        summary: `Move ${details.prefix} at ${details.storeId} from ${details.fromComputer} to ${details.toComputer}`, reason: details.reason,
      });
      return out.result === 'ok' ? { result: 'ok', value: { requestId: out.value.requestId } } : out;
    },
    send: async (r) => {
      if (!named) return nobody;
      // One approval moves one prefix once: a retried click re-sends the same act under the same key.
      return call('POST', REPLACE_PATH, { ...r.details, approvalId: r.requestId }, `scr-${r.requestId}`);
    },
    acknowledge: async (f, reason) => {
      if (!named) return nobody;
      if (!acknowledgeable(f)) return { result: 'invalid', why: 'notAcknowledgeable' };
      if (blank(reason)) return { result: 'invalid', why: 'needAll' };
      if (!reasonOk(reason)) return { result: 'invalid', why: 'shortReason' };
      return f.kind === 'report_refused'
        ? call('POST', REFUSAL_ACK_PATH, { storeId: f.storeId, prefix: f.prefix, through: f.through, reason: reason.trim() })
        : call('POST', f.kind === 'unused_number_received' ? UNUSED_RECEIVED_ACK_PATH : NOT_CHECKED_ACK_PATH, { storeId: f.storeId, prefix: f.prefix, numbers: f.ranges ?? [], count: f.count, reason: reason.trim() });
    },
  };
}
