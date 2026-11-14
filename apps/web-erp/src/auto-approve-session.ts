// Auto-approve limits (CR-01 OI-12 · OB-712 · P-05 · hard rule 5) — the owner's page over head office's auto-approve routes
// (services/ai/src/auto-approve.ts). It reads ONE thing (`GET /v1/ai/auto-approve`) and sends five acts, each of which head
// office checks again and decides:
//   • ask for a limit, or to remove one, or to start auto-approval        `ai.autoapprove.propose` (the owner)
//   • confirm or refuse what SOMEBODY ELSE asked                           `ai.autoapprove.confirm` (the owner, the accountant)
//   • stop ALL auto-approval at once, with a reason                        `ai.autoapprove.stop`    (the owner, the manager)
// The page holds no figure of its own (P-08) and commits nothing: a limit only ever lets a RULE approve an assistant's draft,
// and a permission change, a refund or a payment to a new payee can never have one. Every word this page adds has a Tamil
// twin; head office's own sentences stay in English (OB-553). Synthetic examples only.

import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';
import { paiseOf } from './message-queue-session';

export type Lang = 'en' | 'ta';

export const AUTO_APPROVE_COPY = {
  en: {
    title: 'Auto-approve limits',
    lead: 'The assistants only ever draft. Here you set, for each kind of act, a limit within which a fixed rule approves an assistant\'s draft for you. Anything above the limit, unusual, or outside its rule waits for a person. Every limit needs two people: one asks, a different person confirms.',
    switchH: 'Auto-approval', running: 'Running — drafts inside a limit are approved by the rule.', stopped: 'Stopped — every draft waits for a person.',
    neverStarted: 'It has never been started.', stoppedBy: 'Stopped by', because: 'because',
    startedBy: 'Started by', confirmedBy: 'confirmed by',
    stopReason: 'Why are you stopping it?', stop: 'Stop all auto-approval now', stoppedNow: 'Stopped. Every draft now waits for a person.',
    startReason: 'Why start it?', askStart: 'Ask to start auto-approval', startAsked: 'Asked. A different person must confirm before it starts.',
    limitsH: 'Limits', noLimit: 'No limit — every draft of this kind waits for a person.', limitIs: 'Limit:', setBy: 'Asked by', usual: 'Usual means:',
    newLimitRupees: 'New limit (₹)', newLimitPercent: 'New limit (% off)', why: 'Why?', askLimit: 'Ask for this limit', askRemove: 'Ask to remove this limit',
    limitAsked: 'Asked. Nothing changes until a different person confirms it.',
    pendingH: 'Waiting for a second person', nonePending: 'Nothing is waiting.', askedBy: 'Asked by', confirm: 'Confirm', refuse: 'Refuse', refuseReason: 'Why refuse?',
    yours: 'You asked for this — a different person must confirm it.', confirmed: 'Confirmed. It is in force now.', refusedDone: 'Refused. Nothing changed.',
    actSet: 'Set the limit for', actRemove: 'Remove the limit for', actResume: 'Start auto-approval',
    neverH: 'Never auto-approved', neverLead: 'No limit can ever be set for these. They always wait for a person:',
    never_permission_change: 'A change to anybody\'s permissions', never_refund: 'A refund', never_payment_to_new_payee: 'A payment to a new payee',
    decisionsH: 'What the rule decided recently', noDecisions: 'Nothing yet.', approvedByRule: 'Approved by rule', waits: 'Waits for a person',
    historyH: 'Every change, kept', noHistory: 'No change yet.', wasConfirmed: 'confirmed', wasRefused: 'refused',
    confirmTitle: 'Confirm this change?', confirmDetail: 'From now on the rule approves an assistant\'s drafts inside this limit, in the name of the two of you. Anything above it still waits for a person.',
    confirmAuthority: 'You are the second person. Your name is recorded with the rule.', confirmLabel: 'Confirm',
    confirmUnavailable: 'The confirm step could not open, so nothing was sent. Reload the page and try again.',
    needReason: 'Write a short reason first.', needLimit: 'Type the limit first.', needRupees: 'A limit is an amount in rupees, like 5000.',
    needPercent: 'A markdown limit is a whole percentage from 1 to 100, like 30.',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot see the auto-approve limits.',
    readOnly: 'You can see the limits. Only the owner asks for a change; the owner or the accountant confirms one.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or changed.', reading: 'Reading from head office…',
  },
  ta: {
    title: 'தானியங்கு ஒப்புதல் வரம்புகள்',
    lead: 'உதவியாளர்கள் வரைவு மட்டுமே செய்கின்றனர். ஒவ்வொரு வகைச் செயலுக்கும் ஒரு வரம்பை இங்கே அமைக்கிறீர்கள்; அதற்குள் உள்ள உதவியாளரின் வரைவை ஒரு நிலையான விதி உங்களுக்காக ஒப்புதல் அளிக்கும். வரம்புக்கு மேல், வழக்கத்திற்கு மாறானது அல்லது விதிக்கு வெளியே உள்ளது ஒரு நபருக்காகக் காத்திருக்கும். ஒவ்வொரு வரம்புக்கும் இருவர் தேவை: ஒருவர் கேட்கிறார், வேறொருவர் உறுதிப்படுத்துகிறார்.',
    switchH: 'தானியங்கு ஒப்புதல்', running: 'இயங்குகிறது — வரம்புக்குள் உள்ள வரைவுகளை விதி ஒப்புதல் அளிக்கிறது.', stopped: 'நிறுத்தப்பட்டது — ஒவ்வொரு வரைவும் ஒரு நபருக்காகக் காத்திருக்கிறது.',
    neverStarted: 'இது இதுவரை தொடங்கப்படவில்லை.', stoppedBy: 'நிறுத்தியவர்', because: 'காரணம்',
    startedBy: 'தொடங்கியவர்', confirmedBy: 'உறுதிப்படுத்தியவர்',
    stopReason: 'ஏன் நிறுத்துகிறீர்கள்?', stop: 'அனைத்து தானியங்கு ஒப்புதலையும் இப்போதே நிறுத்து', stoppedNow: 'நிறுத்தப்பட்டது. இனி ஒவ்வொரு வரைவும் ஒரு நபருக்காகக் காத்திருக்கும்.',
    startReason: 'ஏன் தொடங்க வேண்டும்?', askStart: 'தானியங்கு ஒப்புதலைத் தொடங்கக் கேள்', startAsked: 'கேட்கப்பட்டது. தொடங்கும் முன் வேறொருவர் உறுதிப்படுத்த வேண்டும்.',
    limitsH: 'வரம்புகள்', noLimit: 'வரம்பு இல்லை — இந்த வகையின் ஒவ்வொரு வரைவும் ஒரு நபருக்காகக் காத்திருக்கும்.', limitIs: 'வரம்பு:', setBy: 'கேட்டவர்', usual: 'வழக்கம் என்றால்:',
    newLimitRupees: 'புதிய வரம்பு (₹)', newLimitPercent: 'புதிய வரம்பு (% குறைப்பு)', why: 'ஏன்?', askLimit: 'இந்த வரம்பைக் கேள்', askRemove: 'இந்த வரம்பை நீக்கக் கேள்',
    limitAsked: 'கேட்கப்பட்டது. வேறொருவர் உறுதிப்படுத்தும் வரை எதுவும் மாறாது.',
    pendingH: 'இரண்டாவது நபருக்காகக் காத்திருப்பவை', nonePending: 'எதுவும் காத்திருக்கவில்லை.', askedBy: 'கேட்டவர்', confirm: 'உறுதிப்படுத்து', refuse: 'மறு', refuseReason: 'ஏன் மறுக்கிறீர்கள்?',
    yours: 'இதை நீங்கள் கேட்டீர்கள் — வேறொருவர் உறுதிப்படுத்த வேண்டும்.', confirmed: 'உறுதிப்படுத்தப்பட்டது. இப்போது நடைமுறையில் உள்ளது.', refusedDone: 'மறுக்கப்பட்டது. எதுவும் மாறவில்லை.',
    actSet: 'வரம்பை அமை:', actRemove: 'வரம்பை நீக்கு:', actResume: 'தானியங்கு ஒப்புதலைத் தொடங்கு',
    neverH: 'ஒருபோதும் தானியங்கு ஒப்புதல் இல்லை', neverLead: 'இவற்றுக்கு ஒருபோதும் வரம்பு அமைக்க முடியாது. இவை எப்போதும் ஒரு நபருக்காகக் காத்திருக்கும்:',
    never_permission_change: 'யாருடைய அனுமதிகளிலும் மாற்றம்', never_refund: 'பணத்தைத் திருப்பித் தருதல்', never_payment_to_new_payee: 'புதிய பெறுநருக்குப் பணம் செலுத்துதல்',
    decisionsH: 'விதி சமீபத்தில் முடிவு செய்தவை', noDecisions: 'இன்னும் எதுவும் இல்லை.', approvedByRule: 'விதியால் ஒப்புதல்', waits: 'ஒரு நபருக்காகக் காத்திருக்கிறது',
    historyH: 'ஒவ்வொரு மாற்றமும், பதிவில்', noHistory: 'இன்னும் மாற்றம் இல்லை.', wasConfirmed: 'உறுதிப்படுத்தப்பட்டது', wasRefused: 'மறுக்கப்பட்டது',
    confirmTitle: 'இந்த மாற்றத்தை உறுதிப்படுத்தவா?', confirmDetail: 'இனி இந்த வரம்புக்குள் உள்ள உதவியாளரின் வரைவுகளை உங்கள் இருவரின் பெயரில் விதி ஒப்புதல் அளிக்கும். அதற்கு மேல் உள்ளவை இன்னும் ஒரு நபருக்காகக் காத்திருக்கும்.',
    confirmAuthority: 'நீங்கள் இரண்டாவது நபர். உங்கள் பெயர் விதியுடன் பதிவு செய்யப்படும்.', confirmLabel: 'உறுதிப்படுத்து',
    confirmUnavailable: 'உறுதிப்படுத்தும் படி திறக்கவில்லை, எனவே எதுவும் அனுப்பப்படவில்லை. பக்கத்தை மீண்டும் ஏற்றி முயலுங்கள்.',
    needReason: 'முதலில் ஒரு சிறு காரணம் எழுதுங்கள்.', needLimit: 'முதலில் வரம்பைத் தட்டச்சு செய்யுங்கள்.', needRupees: 'வரம்பு ரூபாயில் ஒரு தொகை, எ.கா. 5000.',
    needPercent: 'விலைக் குறைப்பு வரம்பு 1 முதல் 100 வரை ஒரு முழு சதவீதம், எ.கா. 30.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பங்கு தானியங்கு ஒப்புதல் வரம்புகளைப் பார்க்க முடியாது.',
    readOnly: 'வரம்புகளைப் பார்க்கலாம். மாற்றத்தை உரிமையாளர் மட்டுமே கேட்கிறார்; உரிமையாளர் அல்லது கணக்காளர் உறுதிப்படுத்துகிறார்.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை, மாற்றப்படவில்லை.', reading: 'தலைமை அலுவலகத்திலிருந்து படிக்கிறது…',
  },
} as const;

export const autoApproveWords = (lang: Lang, key: string): string =>
  (AUTO_APPROVE_COPY[lang] as Record<string, string>)[key] ?? (AUTO_APPROVE_COPY.en as Record<string, string>)[key] ?? key;
export const autoApproveOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => autoApproveWords(lang, k), out);

export type Measure = 'value_minor' | 'percent_bps';
export interface KindView {
  readonly kind: string; readonly nameEn: string; readonly nameTa: string; readonly usualEn: string; readonly usualTa: string;
  readonly measure: Measure; readonly version: number;
  readonly rule: { readonly ruleId: string; readonly limit: number; readonly askedBy: string; readonly confirmedBy: string; readonly confirmedAt: string; readonly reason: string } | null;
}
export interface PendingView {
  readonly requestId: string; readonly action: 'set_limit' | 'remove_limit' | 'resume'; readonly kind?: string; readonly limit?: number;
  readonly reason: string; readonly requestedBy: string; readonly requestedAt: string; readonly mine: boolean;
}
export interface AutoApproveView {
  readonly running: boolean; readonly switchVersion: number;
  readonly stoppedBy: { readonly by: string; readonly at: string; readonly reason: string } | null;
  readonly startedBy: { readonly askedBy: string; readonly confirmedBy: string; readonly at: string } | null;
  readonly kinds: readonly KindView[];
  readonly pending: readonly PendingView[];
  readonly never: readonly string[];
  readonly decisions: readonly { readonly proposalId: string; readonly outcome: string; readonly because?: string; readonly approvedBy?: string; readonly detail: string; readonly at: string }[];
  readonly history: readonly { readonly requestId: string; readonly action: string; readonly kind?: string; readonly limit?: number; readonly decision: string; readonly askedBy: string; readonly decidedBy: string; readonly decidedAt: string; readonly reason: string }[];
}

type Why = 'nobody' | 'cannotRead' | 'readOnly' | 'needReason' | 'needLimit' | 'needRupees' | 'needPercent';
type Done<T> = Promise<Outcome<T, Why>>;
const arr = (v: unknown): readonly Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** A limit as typed: rupees for money, a whole percentage for a markdown. Undefined when it is not one. */
export function limitOf(measure: Measure, typed: string): number | undefined {
  const s = typed.trim();
  if (measure === 'percent_bps') {
    if (!/^\d{1,3}$/.test(s)) return undefined;
    const pct = Number(s);
    return pct >= 1 && pct <= 100 ? pct * 100 : undefined;
  }
  const minor = paiseOf(s);
  return minor === undefined || minor <= 0 ? undefined : minor;
}

/** Shape head office's one read into what the page shows — nothing added, nothing remembered. */
export function shapeAutoApprove(raw: Record<string, unknown>, viewerId: string | undefined): AutoApproveView {
  const rules = arr(raw['rules']);
  const versionOf = (raw['versionOf'] ?? {}) as Record<string, unknown>;
  const stopped = raw['stoppedBy'] as Record<string, unknown> | undefined;
  const started = raw['startedBy'] as Record<string, unknown> | undefined;
  return {
    running: raw['running'] === true, switchVersion: num(raw['switchVersion']),
    stoppedBy: stopped === undefined ? null : { by: str(stopped['by']), at: str(stopped['at']), reason: str(stopped['reason']) },
    startedBy: started === undefined ? null : { askedBy: str(started['askedBy']), confirmedBy: str(started['confirmedBy']), at: str(started['at']) },
    kinds: arr(raw['kinds']).map((k): KindView => {
      const r = rules.find((x) => x['kind'] === k['kind']);
      return {
        kind: str(k['kind']), nameEn: str(k['nameEn']), nameTa: str(k['nameTa']), usualEn: str(k['usualEn']), usualTa: str(k['usualTa']),
        measure: k['measure'] === 'percent_bps' ? 'percent_bps' : 'value_minor', version: num(versionOf[str(k['kind'])]),
        rule: r === undefined ? null : { ruleId: str(r['ruleId']), limit: num(r['limit']), askedBy: str(r['askedBy']), confirmedBy: str(r['confirmedBy']), confirmedAt: str(r['confirmedAt']), reason: str(r['reason']) },
      };
    }),
    pending: arr(raw['pending']).map((p): PendingView => ({
      requestId: str(p['requestId']), action: (p['action'] === 'remove_limit' || p['action'] === 'resume' ? p['action'] : 'set_limit'),
      ...(typeof p['kind'] === 'string' ? { kind: p['kind'] } : {}), ...(typeof p['limit'] === 'number' ? { limit: p['limit'] } : {}),
      reason: str(p['reason']), requestedBy: str(p['requestedBy']), requestedAt: str(p['requestedAt']), mine: viewerId !== undefined && p['requestedBy'] === viewerId,
    })),
    never: Array.isArray(raw['neverAutoApproved']) ? (raw['neverAutoApproved'] as unknown[]).map(str) : [],
    decisions: arr(raw['decisions']).map((d) => ({
      proposalId: str(d['proposalId']), outcome: str(d['outcome']), ...(typeof d['because'] === 'string' ? { because: d['because'] } : {}),
      ...(typeof d['approvedBy'] === 'string' ? { approvedBy: d['approvedBy'] } : {}), detail: str(d['detail']), at: str(d['at']),
    })),
    history: arr(raw['history']).map((x) => ({
      requestId: str(x['requestId']), action: str(x['action']), ...(typeof x['kind'] === 'string' ? { kind: x['kind'] } : {}),
      ...(typeof x['limit'] === 'number' ? { limit: x['limit'] } : {}), decision: str(x['decision']), askedBy: str(x['askedBy']),
      decidedBy: str(x['decidedBy']), decidedAt: str(x['decidedAt']), reason: str(x['reason']),
    })),
  };
}

export interface AutoApproveSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly propose: boolean; readonly confirm: boolean; readonly stop: boolean };
  read(): Done<AutoApproveView>;
  askLimit(kind: KindView, typed: { readonly limit: string; readonly reason: string }): Done<AutoApproveView>;
  askRemove(kind: KindView, reason: string): Done<AutoApproveView>;
  askStart(view: AutoApproveView, reason: string): Done<AutoApproveView>;
  decide(requestId: string, decision: 'confirmed' | 'refused', reason: string): Done<AutoApproveView>;
  stop(reason: string): Done<AutoApproveView>;
}

export function createAutoApproveSession(input: {
  readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined;
  readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string;
}): AutoApproveSession {
  const userId = input.viewer?.userId;
  const named = userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = {
    named, read: named && held.has('ai.autoapprove.read'), propose: named && held.has('ai.autoapprove.propose'),
    confirm: named && held.has('ai.autoapprove.confirm'), stop: named && held.has('ai.autoapprove.stop'),
  };
  const call = makeCaller({ keyPrefix: 'autoapp', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const no = (why: Why): { result: 'invalid'; why: Why } => ({ result: 'invalid', why });
  const read = async (): Done<AutoApproveView> => {
    const out = await call<Record<string, unknown>>('GET', '/v1/ai/auto-approve');
    return out.result === 'ok' ? { result: 'ok', value: shapeAutoApprove(out.value, userId) } : out;
  };
  const gate = (want: boolean): Why | undefined => (!named ? 'nobody' : !may.read ? 'cannotRead' : !want ? 'readOnly' : undefined);
  const thenRead = async (out: Outcome<unknown, never>): Done<AutoApproveView> => (out.result === 'ok' ? read() : out);
  return {
    may,
    read: async () => (!named ? no('nobody') : !may.read ? no('cannotRead') : read()),
    askLimit: async (kind, typed) => {
      const g = gate(may.propose); if (g !== undefined) return no(g);
      if (typed.limit.trim() === '') return no('needLimit');
      const limit = limitOf(kind.measure, typed.limit);
      if (limit === undefined) return no(kind.measure === 'percent_bps' ? 'needPercent' : 'needRupees');
      if (typed.reason.trim() === '') return no('needReason');
      return thenRead(await call('POST', '/v1/ai/auto-approve/requests', { action: 'set_limit', kind: kind.kind, limit, basedOnVersion: kind.version, reason: typed.reason.trim() }));
    },
    askRemove: async (kind, reason) => {
      const g = gate(may.propose); if (g !== undefined) return no(g);
      if (reason.trim() === '') return no('needReason');
      return thenRead(await call('POST', '/v1/ai/auto-approve/requests', { action: 'remove_limit', kind: kind.kind, basedOnVersion: kind.version, reason: reason.trim() }));
    },
    askStart: async (view, reason) => {
      const g = gate(may.propose); if (g !== undefined) return no(g);
      if (reason.trim() === '') return no('needReason');
      return thenRead(await call('POST', '/v1/ai/auto-approve/requests', { action: 'resume', basedOnVersion: view.switchVersion, reason: reason.trim() }));
    },
    decide: async (requestId, decision, reason) => {
      const g = gate(may.confirm); if (g !== undefined) return no(g);
      if (decision === 'refused' && reason.trim() === '') return no('needReason');
      return thenRead(await call('POST', `/v1/ai/auto-approve/requests/${encodeURIComponent(requestId)}/decision`, { decision, ...(reason.trim() === '' ? {} : { reason: reason.trim() }) }));
    },
    stop: async (reason) => {
      const g = gate(may.stop); if (g !== undefined) return no(g);
      if (reason.trim() === '') return no('needReason');
      return thenRead(await call('POST', '/v1/ai/auto-approve/stop', { reason: reason.trim() }));
    },
  };
}

/** A limit in words: rupees, or a percentage off. */
export function limitWords(measure: Measure, limit: number): string {
  return measure === 'percent_bps'
    ? `${(limit / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}%`
    : `₹${(limit / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
