// The Approval rules page — the owner's money limits, escalation waits and price-check size (OB-290 · OB-291 · OB-292 ·
// M02-FR-02 · M02-FR-03 · M05-FR-01 · §28 · P-04 · P-07 · P-08). A tested, DOM-free session model.
//
// It reads head office's three rules (GET /v1/approvals/rules) and the rule changes this person has asked for (their own
// part of GET /v1/approvals/requests). A change is never made by one person: the person ASKS here (POST
// /v1/approvals/requests, kind approval_rule_change, with exactly the new figures and a reason); the OWNER approves it on
// the Approvals page in his own session; the person then APPLIES the approved change here (PUT /v1/approvals/rules/:rule).
// A role with no figure reads "Not set" — never ₹0 and never a guess. The owner's own limit stays unlimited. Nothing is
// written on open or on a timer; the screen refuses only cheap things locally (no reason, a figure that is not money).

import type { ViewerIdentity } from './browser-entry';
import type { Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';
export type RuleName = 'limits' | 'escalation-waits' | 'price-check';
export const KINDS = Object.freeze(['refund', 'purchase_order', 'stock_adjustment'] as const);
export type LimitKind = (typeof KINDS)[number];

export interface RuleView<T> {
  readonly rule: RuleName; readonly value: T; readonly version: number;
  readonly source: 'owner_decision_23_oct_2026' | 'changed';
  readonly changedBy: string | null; readonly changedAt: string | null; readonly reason: string | null;
  readonly heldAtLastKnownGood?: { readonly unreadableVersion: number; readonly why: string };
}
export interface LimitsValue { readonly byRole: Readonly<Record<string, Readonly<Partial<Record<LimitKind, number | null>>>>> }
export type WaitsValue = Readonly<Record<LimitKind, number>>;
export interface PriceCheckValue { readonly percentBps: number; readonly amountMinor: number }

/** A change this person asked for, with where it stands. */
export interface AskedChange {
  readonly requestId: string; readonly rule: RuleName; readonly status: string;
  readonly details: { readonly rule: RuleName; readonly value: unknown; readonly basedOnVersion: number; readonly reason: string };
  readonly decidedBy?: string; readonly decisionReason?: string;
}

export interface RulesRead {
  readonly limits: RuleView<LimitsValue>;
  readonly waits: RuleView<WaitsValue>;
  readonly priceCheck: RuleView<PriceCheckValue>;
  readonly asked: readonly AskedChange[];
}

/** The people's roles a limit row is shown for (machines and outside parties approve nothing). */
export const ROLES_SHOWN: readonly string[] = Object.freeze(['owner', 'store_manager', 'cashier', 'accountant']);

export const APPROVAL_RULES_COPY = {
  en: {
    lang: 'தமிழ்', title: 'Approval rules',
    lead: 'How much each role may approve, how long an approval may wait before it comes to the owner, and how big a price change one person may make. Nobody changes these alone: you ask for a change here, the owner approves it on the Approvals page, then you apply it here.',
    read: 'Show the rules', refresh: 'Show the rules again',
    version: 'Version', decided: 'The owner\'s figures of 23 Oct 2026 — not changed since', changedBy: 'Changed by',
    held: 'The newest saved version could not be read; the last good one is in force:',
    limitsH: 'Money limits', limitsLead: 'The most each role may approve, in rupees. Anything above a person\'s limit goes to the owner. A role with no figure has no money authority until a figure is set.',
    role: 'Role', k_refund: 'Refund', k_purchase_order: 'Purchase order', k_stock_adjustment: 'Stock adjustment',
    notSet: 'Not set', unlimited: 'Unlimited',
    r_owner: 'Owner', r_store_manager: 'Store manager', r_cashier: 'Cashier', r_accountant: 'Accountant',
    waitsH: 'Escalation waits', waitsLead: 'How long an approval may wait for a decision before it is sent to the owner, in minutes.',
    minutes: 'minutes', hour: 'hour', hours: 'hours',
    priceH: 'Price-check size', priceLead: 'A price change needs a second person when it moves the price by more than this share, OR by more than this many rupees a unit. A price below the margin floor always needs one.',
    percentL: 'More than (per cent)', amountL: 'More than (rupees a unit)',
    reasonL: 'Why this change (it goes on the record)', ask: 'Ask the owner to approve this change',
    asked: 'Asked. It waits for the owner\'s approval on the Approvals page.',
    askedH: 'Changes you asked for', st_waiting: 'Waiting for the owner', st_approved: 'Approved — apply it now', st_rejected: 'Rejected', st_expired: 'The approval expired — ask again', st_used: 'Applied',
    apply: 'Apply the approved change', applied: 'Applied. The new figures are in force now.',
    approvedByK: 'Approved by', rejectedByK: 'Rejected by',
    nobody: 'Nobody is signed in on this screen — you can read nothing and change nothing.', cannotRead: 'Your role cannot read the approval rules.',
    cannotPropose: 'Your role can read these rules but not ask for a change.', noReason: 'Say, in writing, why.', notMoney: 'Each figure must be rupees (for example 5000 or 5000.50), or left empty for "Not set".',
    notMinutes: 'Each wait must be a whole number of minutes, at least 1.', notPercent: 'The share must be a number above 0 and up to 100.', noChange: 'Nothing is different from the rules in force.',
    readFirst: 'Show the rules first.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was changed.',
  },
  ta: {
    lang: 'English', title: 'ஒப்புதல் விதிகள்',
    lead: 'ஒவ்வொரு பங்கும் எவ்வளவு வரை ஒப்புதல் தரலாம், ஒரு ஒப்புதல் உரிமையாளருக்குச் செல்லும் முன் எவ்வளவு நேரம் காத்திருக்கலாம், ஒருவர் தனியாக எவ்வளவு விலை மாற்றம் செய்யலாம். இவற்றை யாரும் தனியாக மாற்ற முடியாது: இங்கே மாற்றத்தைக் கேளுங்கள், உரிமையாளர் ஒப்புதல்கள் பக்கத்தில் ஒப்புதல் தருவார், பிறகு இங்கே செயல்படுத்துங்கள்.',
    read: 'விதிகளைக் காட்டு', refresh: 'விதிகளை மீண்டும் காட்டு',
    version: 'பதிப்பு', decided: '23 அக் 2026 அன்று உரிமையாளர் கொடுத்த அளவுகள் — அதன்பின் மாற்றப்படவில்லை', changedBy: 'மாற்றியவர்',
    held: 'புதிதாகச் சேமித்த பதிப்பைப் படிக்க முடியவில்லை; கடைசியாகச் சரியாக இருந்தது நடைமுறையில் உள்ளது:',
    limitsH: 'பண வரம்புகள்', limitsLead: 'ஒவ்வொரு பங்கும் ஒப்புதல் தரக்கூடிய அதிகபட்சம், ரூபாயில். ஒருவரின் வரம்புக்கு மேல் உள்ளது உரிமையாளரிடம் செல்லும். அளவு இல்லாத பங்குக்கு, அளவு வைக்கும் வரை பண அதிகாரம் இல்லை.',
    role: 'பங்கு', k_refund: 'பணத்திருப்பம்', k_purchase_order: 'கொள்முதல் ஆணை', k_stock_adjustment: 'சரக்குத் திருத்தம்',
    notSet: 'அமைக்கப்படவில்லை', unlimited: 'வரம்பு இல்லை',
    r_owner: 'உரிமையாளர்', r_store_manager: 'கடை மேலாளர்', r_cashier: 'காசாளர்', r_accountant: 'கணக்காளர்',
    waitsH: 'மேல்நிலைக்கு அனுப்பும் காத்திருப்பு', waitsLead: 'ஒரு ஒப்புதல் முடிவுக்காக, உரிமையாளருக்கு அனுப்பப்படும் முன் எவ்வளவு நேரம் காத்திருக்கலாம் — நிமிடங்களில்.',
    minutes: 'நிமிடங்கள்', hour: 'மணி நேரம்', hours: 'மணி நேரம்',
    priceH: 'விலைச் சோதனை அளவு', priceLead: 'விலையை இந்தப் பங்கை விட அதிகமாக, அல்லது ஒரு அலகுக்கு இத்தனை ரூபாய்க்கு மேல் மாற்றும்போது இரண்டாம் நபர் தேவை. இலாப வரம்புக்குக் கீழான விலைக்கு எப்போதும் தேவை.',
    percentL: 'இதை விட அதிகம் (சதவீதம்)', amountL: 'இதை விட அதிகம் (ஒரு அலகுக்கு ரூபாய்)',
    reasonL: 'இந்த மாற்றம் ஏன் (இது பதிவில் சேரும்)', ask: 'இந்த மாற்றத்துக்கு உரிமையாளரின் ஒப்புதலைக் கேள்',
    asked: 'கேட்கப்பட்டது. ஒப்புதல்கள் பக்கத்தில் உரிமையாளரின் ஒப்புதலுக்காகக் காத்திருக்கிறது.',
    askedH: 'நீங்கள் கேட்ட மாற்றங்கள்', st_waiting: 'உரிமையாளருக்காகக் காத்திருக்கிறது', st_approved: 'ஒப்புதல் பெற்றது — இப்போது செயல்படுத்துங்கள்', st_rejected: 'மறுக்கப்பட்டது', st_expired: 'ஒப்புதல் காலாவதியானது — மீண்டும் கேளுங்கள்', st_used: 'செயல்படுத்தப்பட்டது',
    apply: 'ஒப்புதல் பெற்ற மாற்றத்தைச் செயல்படுத்து', applied: 'செயல்படுத்தப்பட்டது. புதிய அளவுகள் இப்போது நடைமுறையில் உள்ளன.',
    approvedByK: 'ஒப்புதல் தந்தவர்', rejectedByK: 'மறுத்தவர்',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை — எதையும் படிக்கவோ மாற்றவோ முடியாது.', cannotRead: 'உங்கள் பங்கு ஒப்புதல் விதிகளைப் படிக்க முடியாது.',
    cannotPropose: 'உங்கள் பங்கு இந்த விதிகளைப் படிக்கலாம், ஆனால் மாற்றம் கேட்க முடியாது.', noReason: 'ஏன் என்று எழுத்தில் சொல்லவும்.', notMoney: 'ஒவ்வொரு அளவும் ரூபாயில் இருக்க வேண்டும் (எ.கா. 5000 அல்லது 5000.50), அல்லது "அமைக்கப்படவில்லை" என்பதற்குக் காலியாக விடவும்.',
    notMinutes: 'ஒவ்வொரு காத்திருப்பும் குறைந்தது 1 முழு நிமிடமாக இருக்க வேண்டும்.', notPercent: 'பங்கு 0 க்கு மேலும் 100 வரையும் உள்ள எண்ணாக இருக்க வேண்டும்.', noChange: 'நடைமுறையில் உள்ள விதிகளிலிருந்து எதுவும் மாறவில்லை.',
    readFirst: 'முதலில் விதிகளைக் காட்டவும்.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் மாற்றப்படவில்லை.',
  },
} as const;
export type ApprovalRulesCopyKey = keyof typeof APPROVAL_RULES_COPY.en;
export const approvalRulesWords = (lang: Lang, key: string): string => (APPROVAL_RULES_COPY[lang] as Record<string, string>)[key] ?? (APPROVAL_RULES_COPY.en as Record<string, string>)[key] ?? key;
export function approvalRulesOutcomeWords(lang: Lang, out: Outcome<unknown>): string {
  if (out.result === 'refused') return `${approvalRulesWords(lang, 'refused')} ${out.whatHappened}`;
  if (out.result === 'invalid') return approvalRulesWords(lang, out.why);
  if (out.result === 'lost_link') return approvalRulesWords(lang, 'unreachable');
  return '';
}

/** Rupees as the person typed them → paise; '' → undefined (Not set); anything else → 'invalid'. */
export function paiseFromRupees(text: string): number | undefined | 'invalid' {
  const t = text.trim().replace(/[₹,\s]/g, '');
  if (t === '') return undefined;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return 'invalid';
  const [whole, frac = ''] = t.split('.');
  const paise = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return Number.isSafeInteger(paise) ? paise : 'invalid';
}

/** Paise → "₹5,000.00" (en-IN grouping). */
export const rupees = (paise: number): string => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** A limit as the page shows it — the figure, Unlimited, or Not set: never a blank, never a fake ₹0. */
export function limitWords(lang: Lang, v: number | null | undefined): string {
  if (v === undefined) return approvalRulesWords(lang, 'notSet');
  if (v === null) return approvalRulesWords(lang, 'unlimited');
  return rupees(v);
}

/** A wait in words: "60 minutes (1 hour)". */
export function waitWords(lang: Lang, minutes: number): string {
  const w = (k: string) => approvalRulesWords(lang, k);
  if (minutes % 60 !== 0) return `${minutes} ${w('minutes')}`;
  const h = minutes / 60;
  return `${minutes} ${w('minutes')} (${h} ${h === 1 ? w('hour') : w('hours')})`;
}

/** The limits as the person edited them: role → kind → rupees text. The owner's row is not editable (always unlimited). */
export function limitsFromForm(current: LimitsValue, typed: Readonly<Record<string, Readonly<Partial<Record<LimitKind, string>>>>>): LimitsValue | 'invalid' {
  const byRole: Record<string, Partial<Record<LimitKind, number | null>>> = {};
  for (const roleId of [...new Set([...Object.keys(current.byRole), ...Object.keys(typed)])]) {
    if (roleId === 'owner') { byRole[roleId] = { ...current.byRole[roleId] }; continue; }
    const row: Partial<Record<LimitKind, number | null>> = {};
    for (const k of KINDS) {
      const t = typed[roleId]?.[k];
      if (t === undefined) { const cur = current.byRole[roleId]?.[k]; if (cur !== undefined) row[k] = cur; continue; }
      const p = paiseFromRupees(t);
      if (p === 'invalid') return 'invalid';
      if (p !== undefined) row[k] = p;
    }
    if (Object.keys(row).length > 0 || current.byRole[roleId] !== undefined) byRole[roleId] = row;
  }
  return { byRole };
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const canon = (v: unknown): unknown => (v === null || typeof v !== 'object' ? v : Array.isArray(v) ? v.map(canon)
  : Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])));

export interface ApprovalRulesSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly propose: boolean };
  read(): Promise<Outcome<RulesRead>>;
  /** Ask the owner to approve a change to one rule. `value` is the whole new rule. */
  ask(rule: RuleName, value: unknown, reason: string, current: RuleView<unknown> | undefined): Promise<Outcome<{ readonly requestId: string }>>;
  /** Apply a change the owner approved. */
  apply(change: AskedChange): Promise<Outcome<{ readonly version: number; readonly approvedBy: string }>>;
}

type Method = 'GET' | 'POST' | 'PUT';
const rand = (): string => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

export function createApprovalRulesSession(input: { readonly viewer: ViewerIdentity | undefined; readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string }): ApprovalRulesSession {
  const perms = new Set(input.viewer?.permissions ?? []);
  const named = input.viewer?.userId !== undefined;
  const may = { named, read: named && perms.has('approvals.rules.read'), propose: named && perms.has('approvals.rules.propose') };
  const http = input.fetch ?? ((...a: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...a));
  const newKey = input.newKey ?? (() => `rules-${rand()}`);
  const call = async <T>(method: Method, path: string, body?: unknown): Promise<Outcome<T, never>> => {
    try {
      const res = await http(path, {
        method, credentials: 'same-origin',
        headers: { accept: 'application/json', ...(method === 'GET' ? {} : { 'content-type': 'application/json', 'idempotency-key': newKey() }) },
        ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        const err = (json['error'] ?? {}) as { code?: string; whatHappened?: string };
        return { result: 'refused', status: res.status, code: err.code ?? String(res.status), whatHappened: err.whatHappened ?? `status ${res.status}` };
      }
      return { result: 'ok', value: json as T };
    } catch { return { result: 'lost_link' }; }
  };
  return {
    may,
    read: async () => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      if (!may.read) return { result: 'invalid', why: 'cannotRead' };
      const rules = await call<{ rules: { limits: RuleView<LimitsValue>; 'escalation-waits': RuleView<WaitsValue>; 'price-check': RuleView<PriceCheckValue> } }>('GET', '/v1/approvals/rules');
      if (rules.result !== 'ok') return rules;
      const inbox = await call<{ mine: { requestId: string; kind: string; status: string; details: AskedChange['details']; decidedBy?: string; decisionReason?: string }[] }>('GET', '/v1/approvals/requests');
      const asked = inbox.result !== 'ok' ? [] : inbox.value.mine
        .filter((r) => r.kind === 'approval_rule_change' && r.details !== undefined && typeof r.details.rule === 'string')
        .map((r): AskedChange => ({ requestId: r.requestId, rule: r.details.rule, status: r.status, details: r.details, ...(r.decidedBy === undefined ? {} : { decidedBy: r.decidedBy }), ...(r.decisionReason === undefined ? {} : { decisionReason: r.decisionReason }) }));
      return { result: 'ok', value: { limits: rules.value.rules.limits, waits: rules.value.rules['escalation-waits'], priceCheck: rules.value.rules['price-check'], asked } };
    },
    ask: async (rule, value, reason, current) => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      if (!may.propose) return { result: 'invalid', why: 'cannotPropose' };
      if (current === undefined) return { result: 'invalid', why: 'readFirst' };
      if (reason.trim() === '') return { result: 'invalid', why: 'noReason' };
      if (same(value, current.value)) return { result: 'invalid', why: 'noChange' };
      const details = { rule, value, basedOnVersion: current.version, reason: reason.trim() };
      return call('POST', '/v1/approvals/requests', {
        kind: 'approval_rule_change', subjectRef: `rule:${rule}`, details, valueMinor: null,
        summary: `Change the ${rule} rule (from version ${current.version})`, reason: reason.trim(),
      });
    },
    apply: async (change) => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      if (!may.propose) return { result: 'invalid', why: 'cannotPropose' };
      // Exactly what was asked — the engine fingerprints it, so the owner approved precisely these figures.
      const { rule, ...body } = change.details;
      return call('PUT', `/v1/approvals/rules/${encodeURIComponent(rule)}`, { ...body, approvalId: change.requestId });
    },
  };
}
