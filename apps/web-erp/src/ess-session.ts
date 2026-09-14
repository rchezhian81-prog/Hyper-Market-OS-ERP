// Employee self-service (ESS) — the screen a member of staff opens to see their OWN two things: their rota
// (the shifts they are rostered for) and their latest payslip (their pay, their own deductions, and — shown
// separately so nothing looks taken from them — the employer's contributions). M25 · §7 · §29.1 · P-04/P-07.
//
// Like every ERP screen the rules live here in a tested, DOM-free session model on the shared packages/ui
// primitives (colour is never the only signal — an icon and a word ride with every tone); the shell only
// renders what this hands over. The data comes LIVE from the two self-scoped reads (`GET /v1/hr/workforce/
// my-roster`, `GET /v1/hr/payroll/my-payslip`); offline the shell keeps what it was last told and says so.
// Read-only: an employee looks, they do not change anything here.

import { translator, presentScreenState, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { presentStatus, type StatusPresentation } from '../../../packages/a11y/src/signals';

/** A shift the employee is rostered for. */
export interface EssShift {
  readonly shiftId: string;
  readonly role: string;
  readonly branchId: string;
  readonly startsAt: string;
  readonly endsAt: string;
}

/** The employee's own rota, as `GET /v1/hr/workforce/my-roster` returns it. */
export interface EssRoster {
  readonly known: boolean;
  readonly active: boolean;
  readonly shifts: readonly EssShift[];
}

/** One redacted deduction line from the self-service payslip view. */
export interface EssDeduction {
  readonly label: string;
  readonly amountMinor: number;
}

/** The employee's own latest payslip, as `GET /v1/hr/payroll/my-payslip` returns it (already self-redacted). */
export interface EssPayslip {
  readonly issued: boolean;
  readonly period?: string;
  readonly netPayMinor?: number;
  readonly deductions?: readonly EssDeduction[];
  readonly employerTotalMinor?: number;
}

export interface EssPorts {
  /** Whether this user may use employee self-service (`payroll.ess.self`). */
  mayRead(): boolean;
  /** The employee's own rota (null when not loaded yet — offline first paint). */
  roster(): EssRoster | null;
  /** The employee's own latest payslip (null when not loaded yet). */
  payslip(): EssPayslip | null;
}

export interface EssConfig {
  /** Who is looking. `null` means the box was not told. */
  readonly userId: string | null;
}

// ── the copy: ONE bilingual object for the whole screen (a guardrail binds to it) ────────────────────────

export type CopyKey =
  | 'title' | 'lead' | 'langName'
  | 'rotaTitle' | 'payTitle'
  | 'rostered' | 'noShifts' | 'notOnRoster' | 'leaver'
  | 'netPay' | 'deduction' | 'employer' | 'employerNote' | 'noPayslip' | 'period'
  | 'stateReady' | 'stateEmpty' | 'stateNotPermitted'
  | 'nobodyNamed' | 'staleShell' | 'sampleData';

export const ESS_COPY: BilingualCopy<CopyKey> = {
  en: {
    title: 'My self-service', langName: 'தமிழ்',
    lead: 'Your own shifts and your latest payslip. This shows only your records — nobody else’s. To change anything, speak to your manager or HR.',
    rotaTitle: 'My rota', payTitle: 'My payslip',
    rostered: 'Rostered', noShifts: 'No shifts rostered for you yet', notOnRoster: 'You are not on the roster yet — ask your manager', leaver: 'Your record is marked inactive — ask HR',
    netPay: 'Take-home pay', deduction: 'Deducted from you', employer: 'Paid by your employer', employerNote: 'A company cost — not deducted from you.', noPayslip: 'No payslip issued to you yet', period: 'Pay period',
    stateReady: 'Showing your rota and payslip', stateEmpty: 'Nothing to show yet — no rota and no payslip.',
    stateNotPermitted: 'You do not have permission to use self-service.',
    nobodyNamed: 'This store computer has not been told who is using this screen.',
    staleShell: 'No connection to the store computer. This page is what it was last told, at', sampleData: 'Sample data — this is not your record.',
  },
  ta: {
    title: 'எனது சுய-சேவை', langName: 'English',
    lead: 'உங்கள் சொந்த ஷிப்ட்களும் உங்கள் சமீபத்திய ஊதியச் சீட்டும். இது உங்கள் பதிவுகளை மட்டுமே காட்டுகிறது — வேறு யாருடையதும் அல்ல. எதையும் மாற்ற, உங்கள் மேலாளர் அல்லது HR-ஐ அணுகவும்.',
    rotaTitle: 'எனது பணி அட்டவணை', payTitle: 'எனது ஊதியச் சீட்டு',
    rostered: 'பணியில் நியமிக்கப்பட்டது', noShifts: 'உங்களுக்கு இன்னும் ஷிப்ட் எதுவும் இல்லை', notOnRoster: 'நீங்கள் இன்னும் அட்டவணையில் இல்லை — உங்கள் மேலாளரிடம் கேளுங்கள்', leaver: 'உங்கள் பதிவு செயலற்றதாகக் குறிக்கப்பட்டுள்ளது — HR-ஐ அணுகவும்',
    netPay: 'கையில் கிடைக்கும் ஊதியம்', deduction: 'உங்களிடமிருந்து பிடித்தம்', employer: 'உங்கள் முதலாளியால் செலுத்தப்பட்டது', employerNote: 'ஒரு நிறுவனச் செலவு — உங்களிடமிருந்து பிடிக்கப்படவில்லை.', noPayslip: 'உங்களுக்கு இன்னும் ஊதியச் சீட்டு வழங்கப்படவில்லை', period: 'ஊதியக் காலம்',
    stateReady: 'உங்கள் அட்டவணை மற்றும் ஊதியச் சீட்டைக் காட்டுகிறது', stateEmpty: 'இன்னும் காட்ட ஏதுமில்லை — அட்டவணையும் இல்லை, ஊதியச் சீட்டும் இல்லை.',
    stateNotPermitted: 'சுய-சேவையைப் பயன்படுத்த உங்களுக்கு அனுமதி இல்லை.',
    nobodyNamed: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை.',
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:', sampleData: 'மாதிரித் தகவல் — இது உங்கள் பதிவு அல்ல.',
  },
};

export const COPY_KEYS: readonly CopyKey[] = Object.freeze(Object.keys(ESS_COPY.en) as CopyKey[]);

// ── presented shapes ─────────────────────────────────────────────────────────────────────────────────

export interface PresentedRow {
  readonly id: string;
  readonly section: 'rota' | 'pay';
  readonly headline: string;
  readonly detail: string;
  readonly status: StatusPresentation;
}

export interface EssView {
  readonly screenState: StatusPresentation;
  readonly rows: readonly PresentedRow[];
  readonly nobodyNamed: boolean;
}

export interface EssSession {
  text(lang: Lang, key: CopyKey): string;
  view(lang: Lang): EssView;
}

/** Paise → a plain rupee string (₹1,234.50). Presentation only; the money itself is the server's. */
function money(minor: number): string {
  const rupees = (minor / 100).toFixed(2);
  const [whole = '0', paise = '00'] = rupees.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `₹${grouped}.${paise}`;
}

/** Read a start time as "Sun 06:00" (UTC, deterministic — the box's own day, never the browser clock's zone). */
function whenLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()] ?? '';
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${day} ${hh}:${mm}`;
}

export function createEssSession(config: EssConfig, ports: EssPorts): EssSession {
  const text = (lang: Lang, key: CopyKey): string => translator(ESS_COPY, lang)(key);

  return {
    text,
    view: (lang) => {
      const t = translator(ESS_COPY, lang);
      if (!ports.mayRead()) {
        return {
          screenState: presentScreenState({ state: 'error', label: t('stateNotPermitted') }),
          rows: [], nobodyNamed: config.userId === null,
        };
      }
      const rows: PresentedRow[] = [];

      // ── My rota ───────────────────────────────────────────────────────────────────────────────────
      const roster = ports.roster();
      if (roster === null || !roster.known) {
        rows.push({
          id: 'rota-none', section: 'rota', headline: t('rotaTitle'), detail: t('notOnRoster'),
          status: presentStatus({ tone: 'idle', icon: '—', label: t('notOnRoster'), announcement: t('notOnRoster'), needsAttention: false }),
        });
      } else if (!roster.active) {
        rows.push({
          id: 'rota-leaver', section: 'rota', headline: t('rotaTitle'), detail: t('leaver'),
          status: presentStatus({ tone: 'degraded', icon: '⚠', label: t('leaver'), announcement: t('leaver'), needsAttention: true }),
        });
      } else if (roster.shifts.length === 0) {
        rows.push({
          id: 'rota-empty', section: 'rota', headline: t('rotaTitle'), detail: t('noShifts'),
          status: presentStatus({ tone: 'idle', icon: '—', label: t('noShifts'), announcement: t('noShifts'), needsAttention: false }),
        });
      } else {
        for (const s of roster.shifts) {
          const when = `${whenLabel(s.startsAt)}–${whenLabel(s.endsAt).slice(-5)}`;
          rows.push({
            id: `shift-${s.shiftId}`, section: 'rota', headline: s.role, detail: `${when} · ${s.branchId}`,
            status: presentStatus({ tone: 'ok', icon: '✓', label: t('rostered'), announcement: `${t('rostered')}: ${s.role} ${when}`, needsAttention: false }),
          });
        }
      }

      // ── My payslip ────────────────────────────────────────────────────────────────────────────────
      const pay = ports.payslip();
      if (pay === null || !pay.issued) {
        rows.push({
          id: 'pay-none', section: 'pay', headline: t('payTitle'), detail: t('noPayslip'),
          status: presentStatus({ tone: 'idle', icon: '—', label: t('noPayslip'), announcement: t('noPayslip'), needsAttention: false }),
        });
      } else {
        const periodDetail = pay.period === undefined ? '' : `${t('period')} ${pay.period}`;
        rows.push({
          id: 'pay-net', section: 'pay', headline: t('netPay'), detail: periodDetail,
          status: presentStatus({ tone: 'ok', icon: '✓', label: money(pay.netPayMinor ?? 0), announcement: `${t('netPay')} ${money(pay.netPayMinor ?? 0)}`, needsAttention: false }),
        });
        for (const d of pay.deductions ?? []) {
          rows.push({
            id: `ded-${d.label}`, section: 'pay', headline: d.label, detail: t('deduction'),
            status: presentStatus({ tone: 'idle', icon: '−', label: money(d.amountMinor), announcement: `${t('deduction')}: ${d.label} ${money(d.amountMinor)}`, needsAttention: false }),
          });
        }
        if ((pay.employerTotalMinor ?? 0) > 0) {
          rows.push({
            id: 'pay-employer', section: 'pay', headline: t('employer'), detail: t('employerNote'),
            status: presentStatus({ tone: 'idle', icon: 'ℹ', label: money(pay.employerTotalMinor ?? 0), announcement: `${t('employer')} ${money(pay.employerTotalMinor ?? 0)}`, needsAttention: false }),
          });
        }
      }

      // "empty" when the only rows are the not-yet placeholders (no real shift and no issued payslip).
      const onlyEmpties = rows.every((r) => r.id === 'rota-none' || r.id === 'rota-empty' || r.id === 'pay-none' || r.id === 'rota-leaver');
      const state = onlyEmpties ? 'empty' : 'ready';
      return {
        screenState: presentScreenState({ state, label: t(state === 'empty' ? 'stateEmpty' : 'stateReady') }),
        rows,
        nobodyNamed: config.userId === null,
      };
    },
  };
}
