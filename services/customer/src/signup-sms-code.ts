// The SMS one-time code at loyalty sign-up — built SWITCHED OFF (R4 · M16-FR-01 · OB-222 · OB-29 · hard rule #4).
//
// OB-29 "A" put the SMS code at sign-up off until a provider is chosen; OB-222 (owner, 19 Oct 2026) keeps SMS, WhatsApp
// and voice OFF in R4: nothing is sent. So the code path is built as a LINK with a test stand-in and nothing more:
//
//   • while switched off (the only state this product ships in), asking for a code sends NOTHING and says so; sign-up
//     keeps working with the desk check that already exists — the person at the desk sees the number on the customer's own
//     phone ("seen on phone", OB-29) and enrols through `POST /v1/loyalty/members`;
//   • a test may put its stand-in sender behind the link; then a code is "sent" to the stand-in, kept only as a salted hash
//     (the shared OTP engine — the code is a credential and is never stored), and checked once.
//
// No provider is called, no number is kept by this file beyond the life of a stand-in challenge in memory.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { beginOtpChallenge, verifyOtp, type OtpChallenge } from '../../../packages/identity/src/index';
import { normaliseMobile } from '../../../packages/loyalty/src/index';

/** OB-222: the SMS code at sign-up is switched off. There is no setting that turns it on in this build. */
export const SIGNUP_SMS_CODE_SWITCHED_ON = false;

export const SMS_SWITCHED_OFF_SAY = 'The SMS code is switched off — nothing was sent. Check the number on the customer\'s own phone at the desk ("seen on phone") and enrol as usual.';

/** The one shape an SMS sender must fit. Only a test stand-in exists. */
export interface SignupSmsSender {
  readonly name: string;
  send(input: { readonly tenantId: string; readonly mobile: string; readonly code: string }): Promise<void>;
}

export interface SignupSmsCodeDeps {
  /** Absent, or `switchedOn: false` — the product: nothing is ever sent. */
  readonly link?: { readonly switchedOn: boolean; readonly sender?: SignupSmsSender };
  readonly now: () => string;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function signupSmsCodeRoutes(deps: SignupSmsCodeDeps): readonly Route[] {
  const on = deps.link?.switchedOn === true && deps.link.sender !== undefined;
  /** Stand-in challenges, in memory only — never written anywhere (the number is personal data, the code a credential). */
  const challenges = new Map<string, OtpChallenge>();
  const status = { switchedOn: on, deskCheck: 'seen_on_phone', say: on ? `SMS code through ${deps.link!.sender!.name}.` : SMS_SWITCHED_OFF_SAY };
  return [
    {
      // Whether the SMS code at sign-up is on — it is not, and the desk check is how sign-up works.
      api: 'API-06', method: 'GET', path: '/v1/loyalty/sign-up/sms-code',
      permission: 'loyalty.member.enrol',
      handler: async () => ({ status: 200, body: status }),
    },
    {
      // Ask for a code to be sent to the customer's number. Body: { mobile }. While switched off: refused, nothing sent.
      api: 'API-06', method: 'POST', path: '/v1/loyalty/sign-up/sms-code/:challengeId',
      permission: 'loyalty.member.enrol', idempotent: true,
      handler: async (ctx) => {
        if (!on) throw apiError(409, { code: 'sms_code_switched_off', whatHappened: SMS_SWITCHED_OFF_SAY, wasItSaved: 'not_saved', nextSafeAction: 'Use the desk check: look at the number on the customer\'s phone, then enrol with verifiedHow "seen_on_phone".' });
        const challengeId = ctx.params['challengeId'] ?? '';
        const mobile = normaliseMobile(String(((ctx.body ?? {}) as Record<string, unknown>)['mobile'] ?? ''));
        if (!ID.test(challengeId) || mobile === undefined) throw apiError(400, { code: 'not_a_mobile_number', whatHappened: 'A code needs a reference and a 10-digit Indian mobile number.', wasItSaved: 'not_saved', nextSafeAction: 'Key the number again.' });
        const begun = beginOtpChallenge({ challengeId, tenantId: ctx.tenantId, phoneNumber: mobile, purpose: 'enrolment', now: deps.now() });
        challenges.set(`${ctx.tenantId}/${challengeId}`, begun.challenge);
        await deps.link!.sender!.send({ tenantId: ctx.tenantId, mobile, code: begun.code });
        return { status: 201, body: { challengeId, sent: true, expiresAt: begun.challenge.expiresAt } };
      },
    },
    {
      // Check the code the customer read out. Body: { code }.
      api: 'API-06', method: 'POST', path: '/v1/loyalty/sign-up/sms-code/:challengeId/verify',
      permission: 'loyalty.member.enrol', idempotent: true,
      handler: async (ctx) => {
        if (!on) throw apiError(409, { code: 'sms_code_switched_off', whatHappened: SMS_SWITCHED_OFF_SAY, wasItSaved: 'not_saved', nextSafeAction: 'Use the desk check ("seen on phone").' });
        const key = `${ctx.tenantId}/${ctx.params['challengeId'] ?? ''}`;
        const held = challenges.get(key);
        if (held === undefined) throw apiError(404, { code: 'no_such_code', whatHappened: 'No code was sent under that reference.', wasItSaved: 'not_saved', nextSafeAction: 'Ask for a new code.' });
        const v = verifyOtp({ challenge: held, tenantId: ctx.tenantId, submittedCode: String(((ctx.body ?? {}) as Record<string, unknown>)['code'] ?? ''), now: deps.now() });
        challenges.set(key, v.challenge);
        return { status: 200, body: { verified: v.verified, outcome: v.outcome } };
      },
    },
  ];
}
