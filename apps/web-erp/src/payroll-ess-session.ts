// Payroll — the EMPLOYEE self-service payslip (owner directive; WP3 inc8; P-04). This is the OTHER side of
// payroll from the admin screen: an ordinary employee seeing THEIR OWN payslip and, if they are leaving,
// their own final settlement — and nothing about anyone else.
//
// It is a SEPARATE surface on purpose: a different permission (`payroll.ess.self`, which a shop manager or a
// cashier may hold for THEMSELVES — it is own-record only), a different session model, a different shell. The
// two controls that make it safe both live in the tested `packages/payroll/src/ess.ts`, and this model uses
// them without weakening either:
//
//   • **Self-scope, forge-proof.** The requester identity comes from `config.requesterEmployeeId` — the
//     AUTHENTICATED principal the box was told, NEVER a value the page could change. `assertSelfScope` inside
//     `employeeSelfView` refuses unless the requester is the subject, so even holding the permission does not
//     let a person name a colleague. A refusal leaks NOTHING (no name, no figure).
//   • **Redaction.** `employeeSelfView` returns a purpose-shaped view — own earnings, own deductions, own
//     net, the employer's contribution shown separately as a company cost — with no approver, no cost-centre,
//     no bank detail and no other employee in the shape at all.
//
// Same security posture as the admin screen: online-first, no service worker, nothing sensitive stored on the
// device, DEMO data flagged, English/Tamil, accessible. DOM-free and tested; the shell only renders this.

import { employeeSelfView, EssAccessDenied, InvalidEssInput, type EmployeeSelfView, type Payslip, type Settlement } from '../../../packages/payroll/src/index';
import { translator, presentScreenState, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import type { StatusPresentation } from '../../../packages/a11y/src/signals';

export interface PayrollEssPorts {
  /** Whether this user holds the self-service permission (`payroll.ess.self`). */
  mayView(): boolean;
  /** The subject's own payslip (the box looked it up), or undefined when none is available. */
  payslip(): Payslip | undefined;
  /** The subject's own final settlement, if they are a leaver. */
  settlement(): Settlement | undefined;
  /** Live connectivity — offline blocks the export, and the payslip is never stored on the device. */
  online(): boolean;
  /** Seconds since the last MFA re-auth, or undefined if never — the export needs a fresh one. */
  reauthAgeSeconds(): number | undefined;
}

export interface PayrollEssConfig {
  /**
   * WHO IS ASKING — the authenticated principal, set by the box from the signed-in session. This is the
   * forge-proof control: it is NEVER read from the page or a request body, so holding the permission still
   * cannot read a colleague's record. `null` means the box was not told who is signed in.
   */
  readonly requesterEmployeeId: string | null;
  /** WHOSE record is being asked for. Own-record only: a mismatch with the requester is refused. */
  readonly subjectEmployeeId: string;
  readonly demo: boolean;
  readonly reauthFreshWithinSeconds: number;
}

/** The one sensitive action on this screen — a print/export of the payslip, audited, behind a fresh re-auth. */
export type EssAction = 'exportOwnPayslip';
export const ESS_SENSITIVE_ACTIONS: readonly EssAction[] = ['exportOwnPayslip'];

export type EssRefusal = 'not_permitted' | 'nobody_named' | 'not_your_record' | 'unavailable' | 'offline' | 'needs_reauth';

export type EssCopyKey =
  | 'title' | 'lead' | 'langName' | 'demoBanner' | 'offlineBanner'
  | 'earningsTitle' | 'gross' | 'deductionsTitle' | 'totalDeductions' | 'net'
  | 'employerTitle' | 'settlementTitle' | 'settlementEarnings' | 'settlementRecoveries' | 'settlementNet'
  | 'settlementPayable' | 'settlementRecoverable' | 'confirmWithCa' | 'actExport' | 'reauthNeeded' | 'reauthFresh'
  | 'stateReady' | 'stateUnavailable' | 'stateNotPermitted' | 'stateNotYours' | 'nobodyNamed'
  | 'rNotPermitted' | 'rNobodyNamed' | 'rNotYourRecord' | 'rUnavailable' | 'rOffline' | 'rNeedsReauth';

export const PAYROLL_ESS_COPY: BilingualCopy<EssCopyKey> = {
  en: {
    title: 'My payslip', langName: 'தமிழ்',
    lead: 'Your own payslip, and your final settlement if you are leaving. Only you can see this — it is not stored on this device.',
    demoBanner: 'DEMO DATA — NOT REAL PAYROLL', offlineBanner: 'You are offline. Your payslip is not stored on this device; connect to see it, and you cannot export while offline.',
    earningsTitle: 'What you earned', gross: 'Gross pay', deductionsTitle: 'Taken from you', totalDeductions: 'Total deductions', net: 'Net pay',
    employerTitle: 'Paid by your employer (not deducted from you)',
    settlementTitle: 'Your final settlement', settlementEarnings: 'Owed to you', settlementRecoveries: 'Recovered', settlementNet: 'Net settlement',
    settlementPayable: 'Payable to you', settlementRecoverable: 'Recoverable from you',
    confirmWithCa: 'Figures are to be confirmed with the company’s CA.', actExport: 'Print / export my payslip',
    reauthNeeded: 'Confirm your identity (MFA) to export', reauthFresh: 'Identity confirmed',
    stateReady: 'Your payslip', stateUnavailable: 'Your payslip is not available yet.',
    stateNotPermitted: 'You do not have access to self-service payslips.', stateNotYours: 'You can only see your own payslip.',
    nobodyNamed: 'This screen has not been told who is signed in, so it cannot show your payslip.',
    rNotPermitted: 'You do not have access to self-service payslips.', rNobodyNamed: 'This screen has not been told who is signed in.',
    rNotYourRecord: 'You can only see and export your OWN payslip.', rUnavailable: 'Your payslip is not available.',
    rOffline: 'You are offline — you cannot export until you are back online.', rNeedsReauth: 'Confirm your identity (MFA) again before exporting.',
  },
  ta: {
    title: 'எனது ஊதியச் சீட்டு', langName: 'English',
    lead: 'உங்கள் சொந்த ஊதியச் சீட்டு, நீங்கள் விலகினால் உங்கள் இறுதித் தீர்வு. இதை நீங்கள் மட்டுமே பார்க்க முடியும் — இது இந்தச் சாதனத்தில் சேமிக்கப்படவில்லை.',
    demoBanner: 'மாதிரித் தகவல் — உண்மையான ஊதியம் அல்ல', offlineBanner: 'நீங்கள் ஆஃப்லைனில் உள்ளீர்கள். உங்கள் ஊதியச் சீட்டு இந்தச் சாதனத்தில் சேமிக்கப்படவில்லை; பார்க்க இணைக்கவும், ஆஃப்லைனில் ஏற்றுமதி செய்ய முடியாது.',
    earningsTitle: 'நீங்கள் சம்பாதித்தது', gross: 'மொத்த ஊதியம்', deductionsTitle: 'உங்களிடமிருந்து பிடித்தம்', totalDeductions: 'மொத்தப் பிடித்தம்', net: 'நிகர ஊதியம்',
    employerTitle: 'உங்கள் முதலாளியால் செலுத்தப்பட்டது (உங்களிடமிருந்து பிடிக்கப்படவில்லை)',
    settlementTitle: 'உங்கள் இறுதித் தீர்வு', settlementEarnings: 'உங்களுக்குச் செலுத்த வேண்டியது', settlementRecoveries: 'மீட்கப்பட்டது', settlementNet: 'நிகரத் தீர்வு',
    settlementPayable: 'உங்களுக்குச் செலுத்த வேண்டியது', settlementRecoverable: 'உங்களிடமிருந்து மீட்க வேண்டியது',
    confirmWithCa: 'எண்கள் நிறுவனத்தின் CA உடன் உறுதிப்படுத்தப்பட வேண்டும்.', actExport: 'எனது ஊதியச் சீட்டை அச்சிடு / ஏற்றுமதி செய்',
    reauthNeeded: 'ஏற்றுமதி செய்ய உங்கள் அடையாளத்தை உறுதிப்படுத்தவும் (MFA)', reauthFresh: 'அடையாளம் உறுதிப்படுத்தப்பட்டது',
    stateReady: 'உங்கள் ஊதியச் சீட்டு', stateUnavailable: 'உங்கள் ஊதியச் சீட்டு இன்னும் கிடைக்கவில்லை.',
    stateNotPermitted: 'சுய-சேவை ஊதியச் சீட்டுகளுக்கு உங்களுக்கு அணுகல் இல்லை.', stateNotYours: 'உங்கள் சொந்த ஊதியச் சீட்டை மட்டுமே பார்க்க முடியும்.',
    nobodyNamed: 'யார் உள்நுழைந்துள்ளார்கள் என்று இந்தத் திரைக்குத் தெரியவில்லை, எனவே உங்கள் ஊதியச் சீட்டைக் காட்ட முடியாது.',
    rNotPermitted: 'சுய-சேவை ஊதியச் சீட்டுகளுக்கு உங்களுக்கு அணுகல் இல்லை.', rNobodyNamed: 'யார் உள்நுழைந்துள்ளார்கள் என்று இந்தத் திரைக்குத் தெரியவில்லை.',
    rNotYourRecord: 'உங்கள் சொந்த ஊதியச் சீட்டை மட்டுமே பார்க்கவும் ஏற்றுமதி செய்யவும் முடியும்.', rUnavailable: 'உங்கள் ஊதியச் சீட்டு கிடைக்கவில்லை.',
    rOffline: 'நீங்கள் ஆஃப்லைனில் உள்ளீர்கள் — மீண்டும் ஆன்லைனில் வரும் வரை ஏற்றுமதி செய்ய முடியாது.', rNeedsReauth: 'ஏற்றுமதி செய்வதற்கு முன் உங்கள் அடையாளத்தை (MFA) மீண்டும் உறுதிப்படுத்தவும்.',
  },
};

export const ESS_COPY_KEYS: readonly EssCopyKey[] = Object.freeze(Object.keys(PAYROLL_ESS_COPY.en) as EssCopyKey[]);

const REFUSAL_LABEL: Readonly<Record<EssRefusal, EssCopyKey>> = {
  not_permitted: 'rNotPermitted', nobody_named: 'rNobodyNamed', not_your_record: 'rNotYourRecord',
  unavailable: 'rUnavailable', offline: 'rOffline', needs_reauth: 'rNeedsReauth',
};

export interface EssView {
  readonly demo: boolean;
  readonly online: boolean;
  readonly mayView: boolean;
  readonly nobodyNamed: boolean;
  /** True when the requester asked for a record that is not their own — NO figures are shown. */
  readonly notYourRecord: boolean;
  /** True when the redacted own-payslip view is present. */
  readonly available: boolean;
  readonly reauthFresh: boolean;
  /** The employee's own redacted view — present only when `available`. Never contains anyone else's data. */
  readonly payslip?: EmployeeSelfView;
  readonly screenState: StatusPresentation;
}

export interface EssActionOutcome {
  readonly ok: boolean;
  readonly detail: string;
  readonly refusal?: EssRefusal;
  readonly refusalLabelKey?: EssCopyKey;
}

export interface PayrollEssSession {
  text(lang: Lang, key: EssCopyKey): string;
  view(lang: Lang): EssView;
  can(action: EssAction): EssActionOutcome;
}

export function createPayrollEssSession(config: PayrollEssConfig, ports: PayrollEssPorts): PayrollEssSession {
  const text = (lang: Lang, key: EssCopyKey): string => translator(PAYROLL_ESS_COPY, lang)(key);

  const reauthFresh = (): boolean => {
    const age = ports.reauthAgeSeconds();
    return age !== undefined && age >= 0 && age <= config.reauthFreshWithinSeconds;
  };

  /**
   * Resolve the own-record view, or the reason it cannot be shown. The requester is ALWAYS
   * `config.requesterEmployeeId` (the authenticated principal) — never a value from the page.
   */
  const resolve = (): { readonly kind: 'ok'; readonly view: EmployeeSelfView }
    | { readonly kind: 'refused'; readonly refusal: EssRefusal } => {
    if (!ports.mayView()) return { kind: 'refused', refusal: 'not_permitted' };
    if (config.requesterEmployeeId === null || config.requesterEmployeeId === '') return { kind: 'refused', refusal: 'nobody_named' };
    const payslip = ports.payslip();
    if (payslip === undefined) return { kind: 'refused', refusal: 'unavailable' };
    try {
      const view = employeeSelfView({
        requesterEmployeeId: config.requesterEmployeeId,
        subjectEmployeeId: config.subjectEmployeeId,
        payslip,
        ...(ports.settlement() === undefined ? {} : { settlement: ports.settlement()! }),
      });
      return { kind: 'ok', view };
    } catch (err) {
      // A cross-employee request is refused HERE — the engine threw, so nothing is presented.
      if (err instanceof EssAccessDenied) return { kind: 'refused', refusal: 'not_your_record' };
      if (err instanceof InvalidEssInput) return { kind: 'refused', refusal: 'unavailable' };
      return { kind: 'refused', refusal: 'unavailable' };
    }
  };

  return {
    text,

    view: (lang) => {
      const t = translator(PAYROLL_ESS_COPY, lang);
      const resolved = resolve();
      const base = {
        demo: config.demo, online: ports.online(),
        mayView: ports.mayView(), nobodyNamed: config.requesterEmployeeId === null || config.requesterEmployeeId === '',
        reauthFresh: reauthFresh(),
      };
      if (resolved.kind === 'ok') {
        return { ...base, notYourRecord: false, available: true, payslip: resolved.view, screenState: presentScreenState({ state: 'ready', label: t('stateReady') }) };
      }
      const stateLabel = resolved.refusal === 'not_permitted' ? 'stateNotPermitted'
        : resolved.refusal === 'not_your_record' ? 'stateNotYours'
        : resolved.refusal === 'nobody_named' ? 'nobodyNamed' : 'stateUnavailable';
      return {
        ...base,
        notYourRecord: resolved.refusal === 'not_your_record',
        available: false,
        screenState: presentScreenState({ state: resolved.refusal === 'unavailable' ? 'empty' : 'error', label: t(stateLabel) }),
      };
    },

    can: (action) => {
      const refuse = (refusal: EssRefusal, detail: string): EssActionOutcome =>
        ({ ok: false, refusal, refusalLabelKey: REFUSAL_LABEL[refusal], detail });
      const resolved = resolve();
      if (resolved.kind === 'refused') return refuse(resolved.refusal, `cannot ${action}: ${resolved.refusal}`);
      if (!ports.online()) return refuse('offline', 'the screen is offline; the export needs a live connection.');
      // The export is the one sensitive action — it needs a fresh MFA re-auth, and it is audited server-side.
      if (ESS_SENSITIVE_ACTIONS.includes(action) && !reauthFresh()) return refuse('needs_reauth', 'a fresh identity confirmation (MFA) is required to export.');
      return { ok: true, detail: 'export your own payslip (audited)' };
    },
  };
}
