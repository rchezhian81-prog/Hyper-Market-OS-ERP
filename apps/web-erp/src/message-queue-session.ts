// Message queue (W3 · M31-FR-04 · P-08 · hard rule #6) — the page over head office's notification queue and messaging budget
// (services/customer/src/notification-queue.ts), which no screen reached. Only per-campaign counts were shown, so an order
// notice or a receipt that could not be sent was visible to nobody, and the owner could not set the budget the queue enforces.
//   • the BUDGET — `GET /v1/notifications/budget`: the cap in force this month, what has been spent, what is left, and the
//     messages HELD waiting for room; `POST /v1/notifications/budget` { capMinor, costMinorByChannel } (the owner's word
//     `notification.budget.set`) — a new version each time, the earlier kept. No number is invented: until the owner enters
//     the cap and the cost of one message on a channel, it says "not set" and head office holds the messages;
//   • WAITING — `GET /v1/notifications/queue/pending`: what still has to go out, and why it is waiting;
//   • NOT SENT — `GET /v1/notifications/queue/withheld`: held back because the customer withdrew consent or asked not to be
//     contacted after it was queued; kept, never sent;
//   • GAVE UP — `GET /v1/notifications/queue/dead-letters`: could not be delivered after every try; kept for a person, never
//     dropped.
// Reading needs `notification.send.check`. Head office's own sentences stay in English (OB-553); every word this page adds has
// a Tamil twin.

import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

/** The channels head office prices a message on (`notification-queue.ts` CHANNELS). */
export const MESSAGE_CHANNELS = ['sms', 'whatsapp', 'email', 'push'] as const;

export const MESSAGE_QUEUE_COPY = {
  en: {
    title: 'Message queue',
    lead: 'Every message the shop sends to customers — order notices, receipts and campaigns — that is waiting, was held back, or could not be delivered, and the monthly messaging budget. Nothing here is dropped: a message that cannot go stays on this page with the reason.',
    budgetH: 'Monthly messaging budget', period: 'Month', cap: 'Monthly cap (₹)', spent: 'Spent this month', left: 'Left this month', heldForBudget: 'held waiting for budget',
    notSet: 'Not set — messages are held until the owner sets the budget.', costOf: 'Cost of one message (₹)', version: 'version', setBy: 'set by',
    saveBudget: 'Save the budget', savedBudget: 'Saved. The earlier budget stays on record.', cannotSet: 'Only the owner can change the budget.',
    needCap: 'Type the monthly cap in rupees.', needCost: 'Type the cost of one message for at least one channel.', needMoney: 'Type amounts in rupees, like 0.25 or 500.',
    pendingH: 'Waiting to go out', withheldH: 'Held back — not sent', deadH: 'Could not be delivered', noneWaiting: 'Nothing is waiting.', noneWithheld: 'Nothing was held back.', noneDead: 'Every message was delivered or is still being tried.',
    tries: 'tries', why: 'why', channel: 'channel',
    ch_sms: 'SMS', ch_whatsapp: 'WhatsApp', ch_email: 'email', ch_push: 'app notification',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot see the message queue.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or changed.', reading: 'Reading from head office…',
  },
  ta: {
    title: 'செய்தி வரிசை',
    lead: 'கடை வாடிக்கையாளர்களுக்கு அனுப்பும் ஒவ்வொரு செய்தியும் — ஆர்டர் அறிவிப்புகள், ரசீதுகள், பிரச்சாரங்கள் — காத்திருப்பவை, நிறுத்தப்பட்டவை, அனுப்ப முடியாதவை, மற்றும் மாதச் செய்திச் செலவு வரம்பு. இங்கே எதுவும் கைவிடப்படாது: அனுப்ப முடியாத செய்தி காரணத்துடன் இந்தப் பக்கத்தில் இருக்கும்.',
    budgetH: 'மாதச் செய்திச் செலவு வரம்பு', period: 'மாதம்', cap: 'மாத வரம்பு (₹)', spent: 'இந்த மாதம் செலவானது', left: 'இந்த மாதம் மீதம்', heldForBudget: 'வரம்புக்காகக் காத்திருப்பவை',
    notSet: 'அமைக்கப்படவில்லை — உரிமையாளர் வரம்பை அமைக்கும் வரை செய்திகள் நிறுத்தி வைக்கப்படும்.', costOf: 'ஒரு செய்தியின் செலவு (₹)', version: 'பதிப்பு', setBy: 'அமைத்தவர்',
    saveBudget: 'வரம்பைச் சேமி', savedBudget: 'சேமிக்கப்பட்டது. முந்தைய வரம்பு பதிவில் உள்ளது.', cannotSet: 'உரிமையாளர் மட்டுமே வரம்பை மாற்ற முடியும்.',
    needCap: 'மாத வரம்பை ரூபாயில் தட்டச்சு செய்யுங்கள்.', needCost: 'குறைந்தது ஒரு வழிக்கு ஒரு செய்தியின் செலவைத் தட்டச்சு செய்யுங்கள்.', needMoney: 'தொகையை ரூபாயில் தட்டச்சு செய்யுங்கள், எ.கா. 0.25 அல்லது 500.',
    pendingH: 'அனுப்பக் காத்திருப்பவை', withheldH: 'நிறுத்தப்பட்டவை — அனுப்பப்படவில்லை', deadH: 'அனுப்ப முடியாதவை', noneWaiting: 'எதுவும் காத்திருக்கவில்லை.', noneWithheld: 'எதுவும் நிறுத்தப்படவில்லை.', noneDead: 'ஒவ்வொரு செய்தியும் அனுப்பப்பட்டது அல்லது இன்னும் முயற்சிக்கப்படுகிறது.',
    tries: 'முயற்சிகள்', why: 'காரணம்', channel: 'வழி',
    ch_sms: 'எஸ்எம்எஸ்', ch_whatsapp: 'வாட்ஸ்அப்', ch_email: 'மின்னஞ்சல்', ch_push: 'செயலி அறிவிப்பு',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பங்கு செய்தி வரிசையைப் பார்க்க முடியாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை, மாற்றப்படவில்லை.', reading: 'தலைமை அலுவலகத்திலிருந்து படிக்கிறது…',
  },
} as const;

export const messageQueueWords = (lang: Lang, key: string): string =>
  (MESSAGE_QUEUE_COPY[lang] as Record<string, string>)[key] ?? (MESSAGE_QUEUE_COPY.en as Record<string, string>)[key] ?? key;
export const messageQueueOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => messageQueueWords(lang, k), out);

export interface MessageItem { readonly id: string; readonly channel: string; readonly attempts: number; readonly reason: string | null }
export interface BudgetView {
  readonly period: string;
  /** null when the owner has not set one — shown as "not set", never a made-up number. */
  readonly budget: { readonly capMinor: number; readonly costMinorByChannel: Readonly<Record<string, number>>; readonly version: number; readonly setBy: string; readonly setAt: string } | null;
  readonly spentMinor: number; readonly remainingMinor: number; readonly held: readonly MessageItem[];
}
export interface QueueView { readonly pending: readonly MessageItem[]; readonly withheld: readonly MessageItem[]; readonly deadLetters: readonly MessageItem[] }

type Why = 'nobody' | 'cannotRead' | 'cannotSet' | 'needCap' | 'needCost' | 'needMoney';
type Done<T> = Promise<Outcome<T, Why>>;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const itemsOf = (v: unknown): MessageItem[] => (Array.isArray(v) ? v : []).flatMap((i): MessageItem[] => (isObj(i) && typeof i['id'] === 'string'
  ? [{ id: i['id'], channel: typeof i['channel'] === 'string' ? i['channel'] : '', attempts: num(i['attempts']), reason: typeof i['reason'] === 'string' ? i['reason'] : null }]
  : []));

/** Rupees as typed (e.g. "0.25", "500") → paise; undefined when it is not an amount. Never rounds a typed fraction of a paisa. */
export function paiseOf(typed: string): number | undefined {
  const s = typed.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return undefined;
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

export interface MessageQueueSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly setBudget: boolean };
  budget(): Done<BudgetView>;
  queue(): Done<QueueView>;
  setBudget(typed: { readonly cap: string; readonly costs: Readonly<Record<string, string>> }): Done<BudgetView>;
}

export function createMessageQueueSession(input: {
  readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined;
  readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string;
}): MessageQueueSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, read: named && held.has('notification.send.check'), setBudget: named && held.has('notification.budget.set') };
  const call = makeCaller({ keyPrefix: 'msgq', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const no = (why: Why): { result: 'invalid'; why: Why } => ({ result: 'invalid', why });
  const gate = (need: 'read' | 'setBudget') => (!named ? no('nobody') : !may[need] ? no(need === 'read' ? 'cannotRead' : 'cannotSet') : undefined);
  const readBudget = async (): Done<BudgetView> => {
    const out = await call<Record<string, unknown>>('GET', '/v1/notifications/budget');
    if (out.result !== 'ok') return out;
    const b = out.value['budget'];
    const budget = isObj(b) && typeof b['capMinor'] === 'number'
      ? { capMinor: b['capMinor'], costMinorByChannel: isObj(b['costMinorByChannel']) ? Object.fromEntries(Object.entries(b['costMinorByChannel']).map(([k, v]) => [k, num(v)])) : {}, version: num(b['version']), setBy: String(b['setBy'] ?? ''), setAt: String(b['setAt'] ?? '') }
      : null;
    return { result: 'ok', value: { period: String(out.value['period'] ?? ''), budget, spentMinor: num(out.value['spentMinor']), remainingMinor: num(out.value['remainingMinor']), held: itemsOf(out.value['held']) } };
  };
  return {
    may,
    budget: async () => gate('read') ?? readBudget(),
    queue: async () => {
      const g = gate('read'); if (g) return g;
      const [p, w, d] = await Promise.all([
        call<{ pending?: unknown }>('GET', '/v1/notifications/queue/pending'),
        call<{ withheld?: unknown }>('GET', '/v1/notifications/queue/withheld'),
        call<{ deadLetters?: unknown }>('GET', '/v1/notifications/queue/dead-letters'),
      ]);
      if (p.result !== 'ok') return p;
      if (w.result !== 'ok') return w;
      if (d.result !== 'ok') return d;
      return { result: 'ok', value: { pending: itemsOf(p.value.pending), withheld: itemsOf(w.value.withheld), deadLetters: itemsOf(d.value.deadLetters) } };
    },
    setBudget: async (typed) => {
      const g = gate('setBudget'); if (g) return g;
      if (typed.cap.trim() === '') return no('needCap');
      const capMinor = paiseOf(typed.cap);
      if (capMinor === undefined) return no('needMoney');
      const costMinorByChannel: Record<string, number> = {};
      for (const ch of MESSAGE_CHANNELS) {
        const raw = (typed.costs[ch] ?? '').trim();
        if (raw === '') continue;
        const p = paiseOf(raw);
        if (p === undefined) return no('needMoney');
        costMinorByChannel[ch] = p;
      }
      if (Object.keys(costMinorByChannel).length === 0) return no('needCost');
      const out = await call('POST', '/v1/notifications/budget', { capMinor, costMinorByChannel });
      return out.result === 'ok' ? readBudget() : out;
    },
  };
}
