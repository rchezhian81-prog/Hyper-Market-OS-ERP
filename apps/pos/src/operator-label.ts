// OB-638 (owner, 1 Nov 2026, option A): the till, the self-checkout lane and the queue till name the person who signed
// in — their NAME with their staff code beside it, "Ravi (u-ravi)" — never the code alone when the store computer said
// who they are. The name is the one the store computer gave at sign-in (ADR-0020: it checked the staff ID and PIN); a
// screen never makes one up. With no name known (a stand-in sign-in, an older box, a blank name), the code alone, as
// before. Words only: every record a sale, refund or cash movement writes still names the staff CODE.

/** "Ravi (u-ravi)"; the code alone when no usable name is known; undefined when nobody is signed in. */
export function operatorLabel(userId: string | null | undefined, displayName: string | null | undefined): string | undefined {
  if (typeof userId !== 'string' || userId.trim() === '') return undefined;
  const name = typeof displayName === 'string' ? displayName.trim() : '';
  if (name === '' || name === userId) return userId;
  return `${name} (${userId})`;
}
