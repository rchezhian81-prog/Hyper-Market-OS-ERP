// THE GST RETURNS PAGE BY JOB, WITH A MONTH PICKER — fix batch 5 · daily-work defect D-051 · P-07.
//
// The walkthrough found one page of 19 sections (GSTR-1, 3B, 9, 9C, reverse charge, TDS 26Q, challans) and every month
// typed as "MMYYYY" (052026). The accountant does three different jobs there: the MONTHLY GST (the filing list, this
// month's GSTR-3B against the till, GSTR-1 and the reverse-charge register), the YEARLY returns (GSTR-9 / 9C and the
// three-year window) and income-tax TDS (the CA's list, challans, the 26Q). The page now shows one job at a time, and every
// month box is the browser's own month picker (`<input type="month">`, value YYYY-MM).
//
// Head office still speaks MMYYYY, so the page converts at the edge: `mmyyyyOf` reads what the box holds (YYYY-MM from
// the picker, or MMYYYY typed where a browser has no picker) and `monthInputOf` turns head office's MMYYYY into the
// picker's YYYY-MM. No figure, no rule and no route changes. Pure and tested.

export type GstJob = 'monthly' | 'yearly' | 'tds';
export const GST_JOBS: readonly GstJob[] = Object.freeze(['monthly', 'yearly', 'tds']);

/** Which parts of the page belong to which job (element ids on gst-returns.html). Every part is in exactly one job. */
export const GST_JOB_PARTS: Readonly<Record<GstJob, readonly string[]>> = Object.freeze({
  monthly: Object.freeze(['summary', 'live-line', 'unsent-line', 'act-result', 'prepare', 'register', 'state', 'ho', 'd-g1', 'd-rcm']),
  yearly: Object.freeze(['ho-yearly', 'd-timebar', 'd-9c']),
  tds: Object.freeze(['d-tds']),
});

export const GST_JOB_WORDS = Object.freeze({
  en: Object.freeze({
    jobsLabel: 'Which job', monthly: 'Monthly GST', yearly: 'Yearly returns', tds: 'TDS',
    monthlyLead: 'The month\'s filings, GSTR-3B against the till, GSTR-1 and reverse charge.',
    yearlyLead: 'GSTR-9 and GSTR-9C for the year, and the three-year window.',
    tdsLead: 'Income-tax TDS on supplier payments: the CA\'s list, challans and the 26Q.',
  }),
  ta: Object.freeze({
    jobsLabel: 'எந்த வேலை', monthly: 'மாதாந்திர GST', yearly: 'ஆண்டு வருமானங்கள்', tds: 'TDS',
    monthlyLead: 'மாதத்தின் தாக்கல்கள், கல்லாவுடன் GSTR-3B, GSTR-1 மற்றும் தலைகீழ் கட்டணம்.',
    yearlyLead: 'ஆண்டுக்கான GSTR-9, GSTR-9C மற்றும் மூன்றாண்டுச் சாளரம்.',
    tdsLead: 'சப்ளையர் செலுத்தல்களில் வருமான வரி TDS: CA-வின் பட்டியல், சலான்கள் மற்றும் 26Q.',
  }),
});

/** The ids to hide for the job chosen: every part of every other job. Pure. */
export function partsHiddenFor(job: GstJob): readonly string[] {
  return GST_JOBS.filter((j) => j !== job).flatMap((j) => GST_JOB_PARTS[j]);
}

/** A job named in a link or a remembered choice, or `monthly` (the everyday job) for anything else. Pure. */
export const gstJobOf = (v: unknown): GstJob => (typeof v === 'string' && (GST_JOBS as readonly string[]).includes(v) ? v as GstJob : 'monthly');

const MMYYYY = /^(0[1-9]|1[0-2])(\d{4})$/;
const YYYY_MM = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** What a month box holds, as head office's MMYYYY — from the picker's YYYY-MM or a typed MMYYYY; null for anything else. Pure. */
export function mmyyyyOf(value: unknown): string | null {
  const v = typeof value === 'string' ? value.trim() : '';
  const picked = YYYY_MM.exec(v);
  if (picked !== null) return `${picked[2]!}${picked[1]!}`;
  return MMYYYY.test(v) ? v : null;
}

/** Head office's MMYYYY (or a YYYY-MM already) as the month picker's YYYY-MM; '' when it is not a month. Pure. */
export function monthInputOf(value: unknown): string {
  const v = typeof value === 'string' ? value.trim() : '';
  if (YYYY_MM.test(v)) return v;
  const m = MMYYYY.exec(v);
  return m === null ? '' : `${m[2]!}-${m[1]!}`;
}
