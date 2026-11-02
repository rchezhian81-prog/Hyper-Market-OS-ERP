// Compensation limits (W3 · M21-FR-03 · §28) — the page over head office's compensation authority limits
// (services/customer/src/service-cases.ts), which no screen could set: what one desk agent may give a customer alone, and the
// desk's absolute ceiling whoever signs. `GET /v1/service/compensation-policy` (`service.case.read`) shows the limits the desk
// works to — head office's standard limits until the owner sets the shop's own, and says which; `POST …` { agentAuthorityMinor,
// deskCeilingMinor } is the owner's decision (`service.compensation.approve`), recorded append-only, the earlier kept. An
// agent's own limit can never be above the ceiling (head office refuses it). Every word this page adds has a Tamil twin; head
// office's own sentences stay in English (OB-553).

import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';
import { paiseOf } from './message-queue-session';

export type Lang = 'en' | 'ta';

export const COMPENSATION_LIMITS_COPY = {
  en: {
    title: 'Compensation limits',
    lead: 'How much goodwill money or store credit the service desk may give a customer. Up to the agent\'s own limit, one person may give it; above that a second person must sign; nobody at the desk may give more than the ceiling.',
    nowH: 'Limits in force', agent: 'One agent alone, up to (₹)', ceiling: 'Desk ceiling, whoever signs (₹)', standard: 'Head office\'s standard limits — the owner has not set the shop\'s own.', shopsOwn: 'Set by the owner',
    setH: 'Change the limits', save: 'Save the limits', saved: 'Saved. The desk works to these limits from now on; the earlier limits stay on record.',
    needBoth: 'Type both limits in rupees.', needMoney: 'Type amounts in rupees, like 500 or 5000.', needOrder: 'An agent\'s own limit cannot be above the desk ceiling.',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot see the compensation limits.', cannotSet: 'You can see the limits; only the owner can change them.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or changed.', reading: 'Reading from head office…',
  },
  ta: {
    title: 'இழப்பீட்டு வரம்புகள்',
    lead: 'சேவை மேசை ஒரு வாடிக்கையாளருக்கு எவ்வளவு நல்லெண்ணப் பணம் அல்லது கடை வரவு கொடுக்கலாம். முகவரின் சொந்த வரம்பு வரை ஒருவர் கொடுக்கலாம்; அதற்கு மேல் இரண்டாவது நபர் கையொப்பமிட வேண்டும்; மேசையில் யாரும் உச்ச வரம்புக்கு மேல் கொடுக்க முடியாது.',
    nowH: 'நடைமுறையில் உள்ள வரம்புகள்', agent: 'ஒரு முகவர் தனியாக, வரை (₹)', ceiling: 'மேசை உச்ச வரம்பு, யார் கையொப்பமிட்டாலும் (₹)', standard: 'தலைமை அலுவலகத்தின் வழக்கமான வரம்புகள் — உரிமையாளர் கடையின் சொந்த வரம்பை அமைக்கவில்லை.', shopsOwn: 'உரிமையாளர் அமைத்தது',
    setH: 'வரம்புகளை மாற்று', save: 'வரம்புகளைச் சேமி', saved: 'சேமிக்கப்பட்டது. இனி மேசை இந்த வரம்புகளின்படி செயல்படும்; முந்தைய வரம்புகள் பதிவில் உள்ளன.',
    needBoth: 'இரண்டு வரம்புகளையும் ரூபாயில் தட்டச்சு செய்யுங்கள்.', needMoney: 'தொகையை ரூபாயில் தட்டச்சு செய்யுங்கள், எ.கா. 500 அல்லது 5000.', needOrder: 'முகவரின் சொந்த வரம்பு மேசை உச்ச வரம்புக்கு மேல் இருக்க முடியாது.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பங்கு இழப்பீட்டு வரம்புகளைப் பார்க்க முடியாது.', cannotSet: 'வரம்புகளைப் பார்க்கலாம்; உரிமையாளர் மட்டுமே மாற்ற முடியும்.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை, மாற்றப்படவில்லை.', reading: 'தலைமை அலுவலகத்திலிருந்து படிக்கிறது…',
  },
} as const;

export const compensationLimitsWords = (lang: Lang, key: string): string =>
  (COMPENSATION_LIMITS_COPY[lang] as Record<string, string>)[key] ?? (COMPENSATION_LIMITS_COPY.en as Record<string, string>)[key] ?? key;
export const compensationLimitsOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => compensationLimitsWords(lang, k), out);

export interface LimitsView { readonly agentAuthorityMinor: number; readonly deskCeilingMinor: number; readonly isStandard: boolean }

type Why = 'nobody' | 'cannotRead' | 'cannotSet' | 'needBoth' | 'needMoney' | 'needOrder';
type Done<T> = Promise<Outcome<T, Why>>;
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export interface CompensationLimitsSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly set: boolean };
  limits(): Done<LimitsView>;
  save(typed: { readonly agent: string; readonly ceiling: string }): Done<LimitsView>;
}

export function createCompensationLimitsSession(input: {
  readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined;
  readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string;
}): CompensationLimitsSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, read: named && held.has('service.case.read'), set: named && held.has('service.compensation.approve') };
  const call = makeCaller({ keyPrefix: 'complim', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const no = (why: Why): { result: 'invalid'; why: Why } => ({ result: 'invalid', why });
  const read = async (): Done<LimitsView> => {
    const out = await call<Record<string, unknown>>('GET', '/v1/service/compensation-policy');
    return out.result === 'ok'
      ? { result: 'ok', value: { agentAuthorityMinor: num(out.value['agentAuthorityMinor']), deskCeilingMinor: num(out.value['deskCeilingMinor']), isStandard: out.value['isDefault'] === true } }
      : out;
  };
  return {
    may,
    limits: async () => (!named ? no('nobody') : !may.read ? no('cannotRead') : read()),
    save: async (typed) => {
      if (!named) return no('nobody');
      if (!may.set) return no('cannotSet');
      if (typed.agent.trim() === '' || typed.ceiling.trim() === '') return no('needBoth');
      const agentAuthorityMinor = paiseOf(typed.agent); const deskCeilingMinor = paiseOf(typed.ceiling);
      if (agentAuthorityMinor === undefined || deskCeilingMinor === undefined) return no('needMoney');
      // Head office's own rule, said before the request: the agent's limit is never above the ceiling.
      if (agentAuthorityMinor > deskCeilingMinor) return no('needOrder');
      const out = await call('POST', '/v1/service/compensation-policy', { agentAuthorityMinor, deskCeilingMinor });
      return out.result === 'ok' ? read() : out;
    },
  };
}
