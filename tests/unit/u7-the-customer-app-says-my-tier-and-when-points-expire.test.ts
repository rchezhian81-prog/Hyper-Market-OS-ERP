import { describe, it, expect } from 'vitest';
import { standingLines, STANDING_WORDS } from '../../apps/customer-app/src/points-standing';

/**
 * **U7 (OB-725) · M17-FR-01 "tiers, expiry" · §27 "Customer: Loyalty" — the points card says my tier (and what the next
 * tier needs) and when my points expire, from head office's `GET /v1/me/loyalty` (Group D's `tier`/`expiry`).** Not set is
 * said as not set (OB-295) — never "no expiry" guessed; the expiry day is the SHOP's day (Asia/Kolkata), not the UTC day;
 * a reply without the fields (an older head office) shows no line rather than a guess. Both languages.
 */
describe('the customer app says my tier and when my points expire', () => {
  it('every word has a Tamil twin', () => {
    expect(Object.keys(STANDING_WORDS.ta).sort()).toEqual(Object.keys(STANDING_WORDS.en).sort());
  });

  it('a tier, the next tier and what it needs; the next points to expire on the shop\'s day', () => {
    const l = standingLines('en', {
      tier: { state: 'set', name: 'Silver', nameTa: 'வெள்ளி', next: { name: 'Gold', nameTa: 'தங்கம்', moreSpendMinor: 2_500_00 } },
      // 31 Mar 2027 20:00 UTC is 1 Apr 2027 01:30 at the shop — the shop's day is 1 Apr.
      expiry: { state: 'set', months: 12, next: { expiresAt: '2027-03-31T20:00:00.000Z', points: 40 } },
    });
    expect(l).toEqual({
      tier: 'Your tier: Silver. Spend ₹2,500.00 more to reach Gold.',
      lapse: '40 point(s) expire on 1 Apr 2027. Points last 12 months.',
    });
    const ta = standingLines('ta', {
      tier: { state: 'set', name: 'Silver', nameTa: 'வெள்ளி', next: { name: 'Gold', nameTa: 'தங்கம்', moreSpendMinor: 2_500_00 } },
      expiry: { state: 'set', months: 12, next: { expiresAt: '2027-03-31T20:00:00.000Z', points: 40 } },
    });
    expect(ta.tier).toBe('உங்கள் நிலை: வெள்ளி. தங்கம் நிலையை அடைய இன்னும் ₹2,500.00 வாங்குங்கள்.');
    expect(ta.lapse).toBe('40 புள்ளி(கள்) 1 Apr 2027 அன்று காலாவதியாகும். புள்ளிகள் 12 மாதங்கள் நீடிக்கும்.');
  });

  it('the top tier; no tier yet; tiers not set; nothing due; expiry not set — each said as it is', () => {
    expect(standingLines('en', { tier: { state: 'set', name: 'Gold' }, expiry: { state: 'set', months: 6, next: null } })).toEqual({
      tier: 'Your tier: Gold — the top tier.',
      lapse: 'No points are due to expire. Points last 6 months.',
    });
    expect(standingLines('en', { tier: { state: 'set', name: null, next: { name: 'Silver', moreSpendMinor: 500_00 } }, expiry: { state: 'not_set' } })).toEqual({
      tier: 'No tier yet. Spend ₹500.00 more to reach Silver.',
      lapse: 'The shop has not set when points expire.',
    });
    expect(standingLines('en', { tier: { state: 'not_set' }, expiry: { state: 'not_set' } }).tier).toBe('The shop has not set up tiers.');
    // A Tamil reader with no Tamil tier name sees the English name, never nothing.
    expect(standingLines('ta', { tier: { state: 'set', name: 'Gold' }, expiry: { state: 'not_set' } })).toEqual({
      tier: 'உங்கள் நிலை: Gold — உயர்ந்த நிலை.',
      lapse: 'புள்ளிகள் எப்போது காலாவதியாகும் என்பதைக் கடை இன்னும் அமைக்கவில்லை.',
    });
  });

  it('a reply without the fields, or with a shape it cannot read, shows no line — never a guess', () => {
    expect(standingLines('en', {})).toEqual({});
    expect(standingLines('en', { tier: { state: 'odd' }, expiry: { state: 'set', months: 'x' } })).toEqual({});
  });
});
