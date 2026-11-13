// U7 (OB-726) · M17-FR-01 "tiers, expiry" · §27 "Customer: Loyalty" — the two lines under "My points": my tier (and what
// the next tier needs) and when my points expire, from head office's `GET /v1/me/loyalty` (`tier`, `expiry`). Read, never
// moved from the app. Not set is said as not set (OB-295); the expiry day is the SHOP's day; a reply without the fields
// (an older head office) or with a shape this cannot read shows no line — never a guess.
import { shopDateIn } from '../../../packages/calendar/src/shop-clock';
import { servedShopZone } from '../../../packages/calendar/src/shop-day';

export const STANDING_WORDS = {
  en: {
    tierIs: 'Your tier: {tier}.', topTier: 'Your tier: {tier} — the top tier.', noTierYet: 'No tier yet.',
    toReach: 'Spend {amount} more to reach {tier}.', tiersNotSet: 'The shop has not set up tiers.',
    expireOn: '{points} point(s) expire on {day}.', noneDue: 'No points are due to expire.',
    lastMonths: 'Points last {months} months.', expiryNotSet: 'The shop has not set when points expire.',
  },
  ta: {
    tierIs: 'உங்கள் நிலை: {tier}.', topTier: 'உங்கள் நிலை: {tier} — உயர்ந்த நிலை.', noTierYet: 'இன்னும் நிலை இல்லை.',
    toReach: '{tier} நிலையை அடைய இன்னும் {amount} வாங்குங்கள்.', tiersNotSet: 'கடை இன்னும் நிலைகளை அமைக்கவில்லை.',
    expireOn: '{points} புள்ளி(கள்) {day} அன்று காலாவதியாகும்.', noneDue: 'காலாவதியாகும் புள்ளிகள் எதுவும் இல்லை.',
    lastMonths: 'புள்ளிகள் {months} மாதங்கள் நீடிக்கும்.', expiryNotSet: 'புள்ளிகள் எப்போது காலாவதியாகும் என்பதைக் கடை இன்னும் அமைக்கவில்லை.',
  },
} as const;

type Lang = 'en' | 'ta';
type Words = { [K in keyof typeof STANDING_WORDS.en]: string };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const fill = (s: string, vars: Record<string, string>): string => s.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? `{${k}}`);
const rupees = (minor: number): string => `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const nameIn = (lang: Lang, r: Record<string, unknown>): string | null =>
  lang === 'ta' && isText(r['nameTa']) ? r['nameTa'] : isText(r['name']) ? r['name'] : null;

function shopDay(iso: string, timeZone: string): string | null {
  if (Number.isNaN(Date.parse(iso))) return null;
  const [y, m, d] = shopDateIn(iso, timeZone).split('-').map(Number);
  return y === undefined || m === undefined || d === undefined ? null : `${d} ${MONTHS[m - 1]} ${y}`;
}

function tierLine(w: Words, lang: Lang, t: unknown): string | undefined {
  if (!isRec(t)) return undefined;
  if (t['state'] === 'not_set') return w.tiersNotSet;
  if (t['state'] !== 'set') return undefined;
  const mine = t['name'] === null ? null : nameIn(lang, t);
  if (mine === null && t['name'] !== null) return undefined;
  const next = t['next'];
  if (next === undefined) return mine === null ? w.noTierYet : fill(w.topTier, { tier: mine });
  if (!isRec(next) || typeof next['moreSpendMinor'] !== 'number' || !Number.isFinite(next['moreSpendMinor'])) return undefined;
  const nextName = nameIn(lang, next);
  if (nextName === null) return undefined;
  const head = mine === null ? w.noTierYet : fill(w.tierIs, { tier: mine });
  return `${head} ${fill(w.toReach, { amount: rupees(next['moreSpendMinor']), tier: nextName })}`;
}

function expiryLine(w: Words, e: unknown, timeZone: string): string | undefined {
  if (!isRec(e)) return undefined;
  if (e['state'] === 'not_set') return w.expiryNotSet;
  if (e['state'] !== 'set' || typeof e['months'] !== 'number' || !Number.isInteger(e['months']) || e['months'] <= 0) return undefined;
  const last = fill(w.lastMonths, { months: String(e['months']) });
  const next = e['next'];
  if (next === null) return `${w.noneDue} ${last}`;
  if (!isRec(next) || typeof next['points'] !== 'number' || typeof next['expiresAt'] !== 'string') return undefined;
  const day = shopDay(next['expiresAt'], timeZone);
  return day === null ? undefined : `${fill(w.expireOn, { points: String(next['points']), day })} ${last}`;
}

/** The tier and expiry lines for the points card, in the reader's language; a missing or unreadable field gives no line. */
export function standingLines(lang: Lang, reply: { readonly tier?: unknown; readonly expiry?: unknown }, timeZone: string = servedShopZone()): { tier?: string; lapse?: string } {
  const w: Words = STANDING_WORDS[lang];
  const tier = tierLine(w, lang, reply.tier);
  const lapse = expiryLine(w, reply.expiry, timeZone);
  return { ...(tier === undefined ? {} : { tier }), ...(lapse === undefined ? {} : { lapse }) };
}
