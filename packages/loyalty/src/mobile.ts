// An Indian mobile number as people write it (PF-09 · OB-28 "1"). Kept apart from the member-code maths so the till's
// browser bundle can check a number without pulling in a hash library — the till never makes the code, the store
// computer does.

/**
 * An Indian mobile number as ten digits, or undefined when it is not one. Spaces, dashes, a leading +91, 91 or 0 are
 * accepted as people write them; the number itself must be ten digits starting 6–9.
 */
export function normaliseMobile(raw: string): string | undefined {
  let digits = raw.replace(/[\s\-()]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  if (!/^\d+$/.test(digits)) return undefined;
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? digits : undefined;
}
