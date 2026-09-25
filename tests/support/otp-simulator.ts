// A test/development OTP sender — the SMS provider's stand-in (M02 / M20 / M22).
//
// It "delivers" a code by remembering it in memory, so a test or a local browser session can read
// the code back and complete the login — exactly what a real SMS provider does, minus the SMS.
//
// It lives in tests/support and MUST NEVER reach production: a sender that reveals the code it sent
// would hand every OTP to anyone who can read process memory or a log. That is the same hard-rule-#4
// property the local/test IdP has, and the `no-test-idp-in-production` guardrail (which now scans
// packages/ too) is the backstop — but this file names it plainly so nobody wires it by mistake.

import type { OtpPurpose, OtpSender } from '../../packages/identity/src/index';

export interface OtpSimulator extends OtpSender {
  /** The most recent code "sent" to this phone, or undefined if none. */
  codeFor(phoneNumber: string): string | undefined;
  /** Forget everything sent — call between tests. */
  clear(): void;
}

/** Build an in-memory OTP sender that lets a test read back the code it delivered. */
export function createOtpSimulator(channel = 'sms'): OtpSimulator {
  const lastByPhone = new Map<string, string>();
  return {
    channel,
    send(input: { phoneNumber: string; code: string; purpose: OtpPurpose; tenantId: string }): void {
      lastByPhone.set(input.phoneNumber, input.code);
    },
    codeFor(phoneNumber: string): string | undefined {
      return lastByPhone.get(phoneNumber);
    },
    clear(): void {
      lastByPhone.clear();
    },
  };
}
