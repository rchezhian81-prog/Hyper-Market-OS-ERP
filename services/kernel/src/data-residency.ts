// C12 (v2.1 addendum · M32/M35 · ADR-0002 "India region") — payment data is pinned to India, and a configuration that
// puts it anywhere else does not start.
//
// Where the shop's payment data lives is a deployment fact, so it is a SETTING, checked at boot like every other setting
// (`loadConfig`): the head-office API refuses to start when the region its payment data is kept in — or the region its
// off-site copies of it go to — is not India. Not a warning at boot, not a note in a runbook: the process does not start.
//
// The setting names a COUNTRY (and optionally a state), not a cloud vendor's region code: the vendor is still the owner's
// commercial choice (ADR-0002 is Proposed), and a check written against one vendor's region names would pass a vendor
// it had never heard of, or fail one it had. ISO 3166 says India is `IN`, and a state is `IN-` plus its two-letter code
// (`IN-MH` Maharashtra, `IN-TN` Tamil Nadu, `IN-KA` Karnataka, …). Anything else — `SG`, `US-VA`, a vendor code, a
// blank, a typo — is refused by name. No hostnames are involved, and none are read.
//
// The same check is used by the payment-adapter registry (`packages/integration/src/adapters.ts`): a payment provider
// that declares it processes the shop's payment data outside India is refused registration.

/** The settings that say where payment data is kept. Read at boot by `CLOUD_API_CONFIG`. */
export const PAYMENT_DATA_REGION_KEY = 'PAYMENT_DATA_REGION';
export const PAYMENT_BACKUP_REGION_KEY = 'PAYMENT_BACKUP_REGION';

/** India, or an Indian state, in ISO 3166 form. */
const INDIA = /^IN(-[A-Z]{2})?$/;

/** True when the region is India (`IN`) or a state of India (`IN-XX`). Case-insensitive; surrounding spaces ignored. */
export function isIndiaRegion(region: string): boolean {
  return INDIA.test(region.trim().toUpperCase());
}

/**
 * Why a region is refused for payment data, or `undefined` when it is India. The words are the boot error, so they say
 * what to set — and they repeat the configured region (a place name, never a secret).
 */
export function indiaRegionProblem(key: string, region: string): string | undefined {
  if (isIndiaRegion(region)) return undefined;
  return `${key} is "${region.trim()}", which is not India. The shop's payment data must stay in an India region (C12 · ADR-0002): `
    + 'set it to IN, or IN-<state> (for example IN-MH or IN-TN). Nothing starts while payment data would be kept elsewhere';
}

export interface ResidencyFinding {
  readonly key: string;
  readonly region: string;
  readonly detail: string;
}

/**
 * Check a whole set of settings for payment-data residency at once. The payment-data region is required (with the India
 * default that `CLOUD_API_CONFIG` gives it); the backup region is checked only when set. Every problem at once.
 */
export function checkPaymentDataResidency(settings: Readonly<Record<string, string | undefined>>): {
  readonly ok: boolean;
  readonly findings: readonly ResidencyFinding[];
  readonly detail: string;
} {
  const findings: ResidencyFinding[] = [];
  const primary = settings[PAYMENT_DATA_REGION_KEY];
  if (primary === undefined || primary.trim() === '') {
    findings.push({ key: PAYMENT_DATA_REGION_KEY, region: '', detail: `${PAYMENT_DATA_REGION_KEY} is not set — where payment data is kept must be said, and must be India` });
  } else {
    const p = indiaRegionProblem(PAYMENT_DATA_REGION_KEY, primary);
    if (p !== undefined) findings.push({ key: PAYMENT_DATA_REGION_KEY, region: primary.trim(), detail: p });
  }
  const backup = settings[PAYMENT_BACKUP_REGION_KEY];
  if (backup !== undefined && backup.trim() !== '') {
    const p = indiaRegionProblem(PAYMENT_BACKUP_REGION_KEY, backup);
    if (p !== undefined) findings.push({ key: PAYMENT_BACKUP_REGION_KEY, region: backup.trim(), detail: p });
  }
  return {
    ok: findings.length === 0,
    findings,
    detail: findings.length === 0
      ? `payment data is kept in ${primary!.trim().toUpperCase()}${backup === undefined || backup.trim() === '' ? '' : `, its off-site copies in ${backup.trim().toUpperCase()}`} — India`
      : findings.map((f) => f.detail).join('; '),
  };
}
