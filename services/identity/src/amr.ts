// How a person proved who they are, as the signed token says (RFC 8176 `amr`) — read by the step-up check.

// RFC 8176 method values. A sign-in that used something the person KNOWS and something they HAVE or ARE is a
// multiple-factor one ("mfa") — whether or not the identity server wrote that word. The self-hosted identity server
// records the methods themselves (`pwd`, `otp`), so a password + one-time code reaches the step-up check as
// `pwd otp mfa` (OB-15-c). One method alone, or two of the same kind, never becomes "mfa".
const KNOWS = new Set(['pwd', 'pin', 'kba']);
const HAS_OR_IS = new Set(['otp', 'hwk', 'swk', 'sc', 'sms', 'tel', 'face', 'fpt', 'iris', 'retina', 'vbm', 'pop']);

/** The methods, with `mfa` added when they show a factor the person knows AND one they have or are. */
export function withMultiFactor(amr: readonly string[]): readonly string[] {
  if (amr.includes('mfa')) return amr;
  return amr.some((m) => KNOWS.has(m)) && amr.some((m) => HAS_OR_IS.has(m)) ? [...amr, 'mfa'] : amr;
}
