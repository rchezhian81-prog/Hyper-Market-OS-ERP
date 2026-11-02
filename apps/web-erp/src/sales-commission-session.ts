// Sales commission (W3 · M22-FR-03 · FUL-09 · §28) — a tested, DOM-free session over head office's commission rules and
// earnings (services/finance/src/b2b-commission.ts), which no screen reached: a business salesperson's commission rate could
// not be proposed or approved, nor what they had earned be seen, without a programmer.
//   • a salesperson's RULES — every rate proposed and approved, and the one in force
//     (`GET /v1/b2b/commissions/:salespersonId/rules`);
//   • PROPOSE — a new rate (and an optional cap on any one invoice's commission) under a new rule id
//     (`POST …/rules/:ruleId` { rateBps, capMinor? }); NOT in force until someone else approves it;
//   • APPROVE — by someone other than the person who proposed it (`POST …/rules/:ruleId/approve`; head office refuses the
//     same person, §28). The latest approved rule is in force; head office then works out commission from each tax invoice;
//   • EARNED — what the salesperson has earned so far, invoice by invoice (`GET /v1/b2b/commissions/:salespersonId`).
// Reading needs `b2b.commission.read`; proposing `b2b.commission.record` (the owner, the accountant); approving
// `b2b.commission.approve` (the owner). Head office re-checks each. Money is whole paise; the rate is in hundredths of a
// per cent. Every word this page adds has a Tamil twin; head office's own sentences stay in English (OB-553).

import { makeCaller, newId, outcomeIn, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

export const COMMISSION_COPY = {
  en: {
    title: 'Sales commission',
    lead: 'The commission rate each business salesperson earns, and what they have earned. A rate is proposed by one person and is in force only once a different person approves it. Commission is then worked out by head office from each tax invoice, at the rate in force — never typed.',
    salesperson: 'Salesperson (staff id)', look: 'Show', rulesH: 'Rates', noRules: 'No rate has been proposed for this salesperson.', inForce: 'in force', waiting: 'waiting for approval', approvedOld: 'approved earlier',
    rate: 'Rate (%)', cap: 'Most commission on one invoice (₹, optional)', noCap: 'no cap', proposedBy: 'proposed by', approvedBy: 'approved by', propose: 'Propose this rate', approve: 'Approve this rate',
    earnedH: 'Earned so far', noEarned: 'Nothing earned yet.', total: 'Total', on: 'on sales of', invoices: 'invoices',
    proposed: 'Proposed. It is in force only once someone else approves it.', approved: 'Approved. It is now in force.',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot see sales commission.', cannotPropose: 'Your role cannot propose a commission rate.', cannotApprove: 'Your role cannot approve a commission rate.',
    needSalesperson: 'Type the salesperson\'s staff id.', needRate: 'Type the rate as a per cent between 0 and 100, e.g. 2.5.', needCap: 'Type the cap in rupees, e.g. 500, or leave it empty.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or changed.', reading: 'Asking head office…',
  },
  ta: {
    title: 'விற்பனைக் கமிஷன்',
    lead: 'ஒவ்வொரு வணிக விற்பனையாளரும் பெறும் கமிஷன் விகிதமும், அவர் பெற்றதும். ஒருவர் விகிதத்தை முன்மொழிகிறார்; வேறொருவர் ஏற்ற பிறகே அது நடைமுறைக்கு வரும். பிறகு ஒவ்வொரு வரி விலைப்பட்டியலிலிருந்தும் நடைமுறை விகிதத்தில் தலைமை அலுவலகம் கமிஷனைக் கணக்கிடும் — ஒருபோதும் தட்டச்சு செய்யப்படாது.',
    salesperson: 'விற்பனையாளர் (பணியாளர் அடையாளம்)', look: 'காட்டு', rulesH: 'விகிதங்கள்', noRules: 'இந்த விற்பனையாளருக்கு எந்த விகிதமும் முன்மொழியப்படவில்லை.', inForce: 'நடைமுறையில்', waiting: 'ஒப்புதலுக்குக் காத்திருக்கிறது', approvedOld: 'முன்பு ஏற்கப்பட்டது',
    rate: 'விகிதம் (%)', cap: 'ஒரு விலைப்பட்டியலில் அதிகபட்ச கமிஷன் (₹, விருப்பம்)', noCap: 'உச்சவரம்பு இல்லை', proposedBy: 'முன்மொழிந்தவர்', approvedBy: 'ஏற்றவர்', propose: 'இந்த விகிதத்தை முன்மொழி', approve: 'இந்த விகிதத்தை ஏற்கவும்',
    earnedH: 'இதுவரை பெற்றது', noEarned: 'இன்னும் எதுவும் பெறவில்லை.', total: 'மொத்தம்', on: 'விற்பனை மதிப்பு', invoices: 'விலைப்பட்டியல்கள்',
    proposed: 'முன்மொழியப்பட்டது. வேறொருவர் ஏற்ற பிறகே நடைமுறைக்கு வரும்.', approved: 'ஏற்கப்பட்டது. இப்போது நடைமுறையில் உள்ளது.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பங்கு விற்பனைக் கமிஷனைப் பார்க்க முடியாது.', cannotPropose: 'உங்கள் பங்கு கமிஷன் விகிதத்தை முன்மொழிய முடியாது.', cannotApprove: 'உங்கள் பங்கு கமிஷன் விகிதத்தை ஏற்க முடியாது.',
    needSalesperson: 'விற்பனையாளரின் பணியாளர் அடையாளத்தைத் தட்டச்சு செய்யுங்கள்.', needRate: 'விகிதத்தை 0 முதல் 100 வரையிலான சதவீதமாகத் தட்டச்சு செய்யுங்கள், எ.கா. 2.5.', needCap: 'உச்சவரம்பை ரூபாயில் தட்டச்சு செய்யுங்கள், எ.கா. 500, அல்லது காலியாக விடுங்கள்.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை, மாற்றப்படவில்லை.', reading: 'தலைமை அலுவலகத்திடம் கேட்கிறது…',
  },
} as const;

export const commissionWords = (lang: Lang, key: string): string =>
  (COMMISSION_COPY[lang] as Record<string, string>)[key] ?? (COMMISSION_COPY.en as Record<string, string>)[key] ?? key;
export const commissionOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => commissionWords(lang, k), out);

/** "2.5" → 250 hundredths of a per cent; undefined when it is not a rate between 0 and 100 with at most two decimals. */
export function bpsOf(raw: string): number | undefined {
  const s = raw.trim().replace(',', '.');
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(s)) return undefined;
  const [whole, frac = ''] = s.split('.') as [string, string?];
  const bps = Number(whole) * 100 + Number((frac ?? '').padEnd(2, '0'));
  return bps <= 10_000 ? bps : undefined;
}
/** "500" or "500.50" → whole paise; undefined when it is not an amount. */
export function paiseOf(raw: string): number | undefined {
  const s = raw.trim().replace(/,/g, '');
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(s)) return undefined;
  const [whole, frac = ''] = s.split('.') as [string, string?];
  return Number(whole) * 100 + Number((frac ?? '').padEnd(2, '0'));
}
export const percentOf = (bps: number): string => `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
export const rupeesOf = (minor: number): string => `₹${(minor / 100).toFixed(2)}`;

export interface CommissionRuleRow { readonly ruleId: string; readonly rateBps: number; readonly capMinor: number | null; readonly proposedBy: string; readonly proposedAt: string; readonly approvedBy?: string; readonly approvedAt?: string; readonly inForce: boolean }
export interface CommissionEarned { readonly totalCommissionMinor: number; readonly totalBaseMinor: number; readonly count: number; readonly accruals: readonly { readonly accrualId: string; readonly baseMinor: number; readonly rateBps: number; readonly commissionMinor: number; readonly ref: string; readonly at: string }[] }
export interface CommissionView { readonly salespersonId: string; readonly rules: readonly CommissionRuleRow[]; readonly earned: CommissionEarned | null }

type Why = 'nobody' | 'cannotRead' | 'cannotPropose' | 'cannotApprove' | 'needSalesperson' | 'needRate' | 'needCap';
type Done<T> = Promise<Outcome<T, Why>>;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

export interface SalesCommissionSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly propose: boolean; readonly approve: boolean };
  look(salespersonId: string): Done<CommissionView>;
  propose(salespersonId: string, rate: string, cap: string): Done<{ readonly ruleId: string }>;
  approve(salespersonId: string, ruleId: string): Done<{ readonly inForce: boolean }>;
}

export function createSalesCommissionSession(input: { readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined; readonly fetch?: typeof globalThis.fetch; readonly newRuleId?: () => string }): SalesCommissionSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, read: named && held.has('b2b.commission.read'), propose: named && held.has('b2b.commission.record'), approve: named && held.has('b2b.commission.approve') };
  const call = makeCaller({ keyPrefix: 'commission', ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
  const ruleIdOf = input.newRuleId ?? (() => newId('cr'));
  const no = (why: Why): { result: 'invalid'; why: Why } => ({ result: 'invalid', why });
  const WHY: Record<'read' | 'propose' | 'approve', Why> = { read: 'cannotRead', propose: 'cannotPropose', approve: 'cannotApprove' };
  const gate = (need: 'read' | 'propose' | 'approve') => (!named ? no('nobody') : !may[need] ? no(WHY[need]) : undefined);
  const sp = (id: string): string => encodeURIComponent(id.trim());
  return {
    may,
    look: async (salespersonId) => {
      const g = gate('read'); if (g) return g;
      if (salespersonId.trim() === '') return no('needSalesperson');
      const rules = await call<{ rules?: unknown[]; inForce?: unknown }>('GET', `/v1/b2b/commissions/${sp(salespersonId)}/rules`);
      if (rules.result !== 'ok') return rules;
      const inForceId = isObj(rules.value.inForce) ? str(rules.value.inForce['ruleId']) : '';
      // The rules are an append-only record: the latest fact per rule id is what it is now.
      const latest = new Map<string, Record<string, unknown>>();
      for (const r of rules.value.rules ?? []) if (isObj(r) && typeof r['ruleId'] === 'string') latest.set(r['ruleId'], r);
      const rows = [...latest.values()].map((r): CommissionRuleRow => ({
        ruleId: str(r['ruleId']), rateBps: num(r['rateBps']), capMinor: typeof r['capMinor'] === 'number' ? r['capMinor'] : null, proposedBy: str(r['proposedBy']), proposedAt: str(r['proposedAt']),
        ...(typeof r['approvedBy'] === 'string' ? { approvedBy: r['approvedBy'] } : {}), ...(typeof r['approvedAt'] === 'string' ? { approvedAt: r['approvedAt'] } : {}),
        inForce: str(r['ruleId']) === inForceId,
      })).reverse();
      const earned = await call<{ totalCommissionMinor?: unknown; totalBaseMinor?: unknown; count?: unknown; accruals?: unknown[] }>('GET', `/v1/b2b/commissions/${sp(salespersonId)}`);
      // Head office says nothing has been earned yet (404): that is "nothing yet", never a made-up nought.
      if (earned.result === 'refused' && earned.status === 404) return { result: 'ok', value: { salespersonId: salespersonId.trim(), rules: rows, earned: null } };
      if (earned.result !== 'ok') return earned;
      return {
        result: 'ok',
        value: {
          salespersonId: salespersonId.trim(), rules: rows,
          earned: {
            totalCommissionMinor: num(earned.value.totalCommissionMinor), totalBaseMinor: num(earned.value.totalBaseMinor), count: num(earned.value.count),
            accruals: (earned.value.accruals ?? []).flatMap((a) => (isObj(a) && typeof a['accrualId'] === 'string'
              ? [{ accrualId: a['accrualId'], baseMinor: num(a['baseMinor']), rateBps: num(a['rateBps']), commissionMinor: num(a['commissionMinor']), ref: str(a['ref']), at: str(a['at']) }] : [])),
          },
        },
      };
    },
    propose: async (salespersonId, rate, cap) => {
      const g = gate('propose'); if (g) return g;
      if (salespersonId.trim() === '') return no('needSalesperson');
      const rateBps = bpsOf(rate);
      if (rateBps === undefined) return no('needRate');
      const capMinor = cap.trim() === '' ? undefined : paiseOf(cap);
      if (cap.trim() !== '' && capMinor === undefined) return no('needCap');
      const ruleId = ruleIdOf();
      const out = await call('POST', `/v1/b2b/commissions/${sp(salespersonId)}/rules/${encodeURIComponent(ruleId)}`, { rateBps, ...(capMinor === undefined ? {} : { capMinor }) });
      return out.result === 'ok' ? { result: 'ok', value: { ruleId } } : out;
    },
    approve: async (salespersonId, ruleId) => {
      const g = gate('approve'); if (g) return g;
      const out = await call<{ inForce?: unknown }>('POST', `/v1/b2b/commissions/${sp(salespersonId)}/rules/${encodeURIComponent(ruleId)}/approve`, {});
      return out.result === 'ok' ? { result: 'ok', value: { inForce: out.value.inForce === true } } : out;
    },
  };
}
