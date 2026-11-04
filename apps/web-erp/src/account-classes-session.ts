// Accounts and Tally names · "Account classes" (W5 · M23-FR-01 "map operational events to accounting ledgers … trial
// balance and AP/AR reports" · WF-18 "→ P&L" · P-08) — a tested, DOM-free session over the two head-office routes no screen
// reached:
//   • GET /v1/finance/account-classes — the classes the accountant set (income / expense / asset / liability / equity),
//     or `defined: false` with head office's SUGGESTED set beside it. The profit and loss, the trial balance and the centres
//     read these classes; until the accountant sets them the profit and loss is refused by name.
//   • PUT /v1/finance/account-classes — the accountant (finance.journal.post) saves the classes, each account given one.
// The suggested set is only ever SHOWN as head office's suggestion; nothing is saved until the accountant chooses each
// account's class and presses save. An account left "not set" is not sent. Head office re-checks every permission.

import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';
export const ACCOUNT_CLASSES = ['income', 'expense', 'asset', 'liability', 'equity'] as const;
export type AccountClass = (typeof ACCOUNT_CLASSES)[number];

export const ACCOUNT_CLASSES_COPY = {
  en: {
    classesH: 'Account classes', classesLede: 'Which accounts are income, expenses, assets, liabilities or equity. The month\'s profit and loss and the cost centres read these. Head office suggests a set for the suggested map; nothing is saved until the accountant chooses and saves.',
    show: 'Read the account classes', save: 'Save the account classes', saved: 'Account classes saved by {who}.',
    defined: 'Set by the accountant', notDefined: 'Not set yet — the profit and loss cannot be read until the accountant sets these.', suggested: 'Head office suggests', notSet: 'Not set',
    income: 'Income', expense: 'Expense', asset: 'Asset', liability: 'Liability', equity: 'Equity', account: 'Account', addAccount: 'Another account (code)', add: 'Add this account',
    needOne: 'Give at least one account its class.', needCode: 'Type the account code first.',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot see the account classes.', cannotSave: 'You can read the classes; setting them needs the accountant\'s permission.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or saved.',
  },
  ta: {
    classesH: 'கணக்கு வகைகள்', classesLede: 'எந்தக் கணக்குகள் வருமானம், செலவு, சொத்து, பொறுப்பு அல்லது பங்கு மூலதனம். மாத இலாப நட்டமும் செலவு மையங்களும் இவற்றைப் படிக்கின்றன. பரிந்துரை வரைபடத்துக்கு தலைமை அலுவலகம் ஒரு தொகுப்பைப் பரிந்துரைக்கிறது; கணக்காளர் தேர்ந்தெடுத்துச் சேமிக்கும் வரை எதுவும் சேமிக்கப்படாது.',
    show: 'கணக்கு வகைகளைப் படி', save: 'கணக்கு வகைகளைச் சேமி', saved: 'கணக்கு வகைகள் {who} ஆல் சேமிக்கப்பட்டன.',
    defined: 'கணக்காளர் அமைத்தது', notDefined: 'இன்னும் அமைக்கப்படவில்லை — கணக்காளர் அமைக்கும் வரை இலாப நட்டத்தைப் படிக்க முடியாது.', suggested: 'தலைமை அலுவலகம் பரிந்துரைப்பது', notSet: 'அமைக்கப்படவில்லை',
    income: 'வருமானம்', expense: 'செலவு', asset: 'சொத்து', liability: 'பொறுப்பு', equity: 'பங்கு மூலதனம்', account: 'கணக்கு', addAccount: 'இன்னொரு கணக்கு (குறியீடு)', add: 'இந்தக் கணக்கைச் சேர்',
    needOne: 'குறைந்தது ஒரு கணக்குக்கு அதன் வகையைக் கொடுக்கவும்.', needCode: 'முதலில் கணக்குக் குறியீட்டைத் தட்டச்சு செய்யவும்.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பங்கு கணக்கு வகைகளைப் பார்க்க முடியாது.', cannotSave: 'நீங்கள் வகைகளைப் படிக்கலாம்; அமைக்கக் கணக்காளரின் அனுமதி தேவை.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை, சேமிக்கப்படவில்லை.',
  },
} as const;

export function accountClassesWords(lang: Lang, key: string, fill?: Readonly<Record<string, string | number>>): string {
  const raw = (ACCOUNT_CLASSES_COPY[lang] as Record<string, string>)[key] ?? (ACCOUNT_CLASSES_COPY.en as Record<string, string>)[key] ?? key;
  return fill === undefined ? raw : raw.replace(/\{(\w+)\}/g, (_, k: string) => String(fill[k] ?? `{${k}}`));
}
export const accountClassesOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => accountClassesWords(lang, k), out);

export interface AccountClassesView { readonly defined: boolean; readonly classes: Readonly<Record<string, AccountClass>>; readonly suggested: Readonly<Record<string, AccountClass>> }
/** One account on the screen: what the accountant set (or nothing), and what head office suggests (or nothing). */
export interface ClassRow { readonly account: string; readonly set: AccountClass | null; readonly suggested: AccountClass | null }

/** Every account either side names, sorted; the set class only when the accountant set one. Pure. */
export function classRows(v: AccountClassesView): readonly ClassRow[] {
  const accounts = [...new Set([...Object.keys(v.classes), ...Object.keys(v.suggested)])].sort();
  return accounts.map((account) => ({ account, set: v.classes[account] ?? null, suggested: v.suggested[account] ?? null }));
}

type Why = 'nobody' | 'cannotRead' | 'cannotSave' | 'needOne';

export interface AccountClassesSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly save: boolean };
  read(): Promise<Outcome<AccountClassesView, Why>>;
  /** `chosen`: account → class, or '' for "not set" (left out). */
  save(chosen: Readonly<Record<string, string>>): Promise<Outcome<{ readonly definedBy: string }, Why>>;
}

export function createAccountClassesSession(input: { readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined; readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string }): AccountClassesSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, read: named && held.has('finance.period.read'), save: named && held.has('finance.journal.post') };
  const call = makeCaller({ keyPrefix: 'account-classes', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const no = (why: Why): { result: 'invalid'; why: Why } => ({ result: 'invalid', why });
  return {
    may,
    read: async () => (!named ? no('nobody') : !may.read ? no('cannotRead') : call<AccountClassesView>('GET', '/v1/finance/account-classes')),
    save: async (chosen) => {
      if (!named) return no('nobody');
      if (!may.save) return no('cannotSave');
      const classes: Record<string, AccountClass> = {};
      for (const [k, v] of Object.entries(chosen)) if (k.trim() !== '' && (ACCOUNT_CLASSES as readonly string[]).includes(v)) classes[k.trim()] = v as AccountClass;
      if (Object.keys(classes).length === 0) return no('needOne');
      return call('PUT', '/v1/finance/account-classes', { classes });
    },
  };
}
