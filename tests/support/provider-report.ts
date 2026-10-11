// A message provider's signed delivery report, as the provider would send it (PF-10 round 6) — for tests only.
//
// The secret is built at run time (never a literal in the repo, hard rule #4); production reads each provider's secret
// from the API's environment (DELIVERY_REPORT_SECRET__<PROVIDER>) and never signs anything itself.

import { createHmac, randomUUID } from 'node:crypto';
import { deliveryReportMaterial } from '../../services/customer/src/provider-reports';

/** The recording test adapter's provider name (its transport name). */
export const TEST_PROVIDER = 'recording-test-adapter';

/** A provider callback secret for this test run. */
export const testProviderSecret = (): string => ['provider', 'callback', randomUUID()].join('-').padEnd(48, 'x');

/** The provider's report for `path`: the fields, its provider name, a report id, the time sent, and its signature. */
export function signedReport(path: string, fields: Record<string, unknown>, secret: string, opts: { provider?: string; reportId?: string; sentAt?: string } = {}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ...fields,
    provider: opts.provider ?? TEST_PROVIDER,
    reportId: opts.reportId ?? `rep-${randomUUID()}`,
    sentAt: opts.sentAt ?? new Date().toISOString(),
  };
  return { ...body, signature: createHmac('sha256', secret).update(deliveryReportMaterial(path, body)).digest('hex') };
}
