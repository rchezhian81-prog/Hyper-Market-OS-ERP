import { describe, it, expect } from 'vitest';
import { createLoyaltyDeskSession, readTierRow, multiplierWords, rupees } from '../../apps/web-erp/src/loyalty-desk-session';

// OB-329 · OB-295: the Loyalty page's session refuses the cheap things before any request — no yes, number not seen, a
// name that is not a name, a tier the owner typed wrong, no reason — and sends the number only in a POST body.

const recorder = () => {
  const asked: { method: string; path: string; body?: unknown }[] = [];
  const fetch = (async (path: string, init?: { method?: string; body?: string }) => {
    asked.push({ method: init?.method ?? 'GET', path: String(path), ...(init?.body === undefined ? {} : { body: JSON.parse(init.body) as unknown }) });
    return new Response(JSON.stringify({ member: true, memberRef: 'm-0123456789abcdef01234567', mobileLast4: '7701' }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { asked, fetch };
};
const desk = (perms: string[], fetch: typeof globalThis.fetch) => createLoyaltyDeskSession({ viewer: { userId: 'u-desk', permissions: perms }, fetch });

describe('the Loyalty desk session (OB-329 · OB-295)', () => {
  it('enrols only on the yes and the number seen; the name is optional and must be a name; the number goes in the body', async () => {
    const { asked, fetch } = recorder();
    const s = desk(['loyalty.member.enrol'], fetch);
    expect(await s.enrol({ mobile: '12345', name: '', saidYes: true, seenOnPhone: true })).toEqual({ result: 'invalid', why: 'needMobile' });
    expect(await s.enrol({ mobile: '98400 77701', name: '', saidYes: false, seenOnPhone: true })).toEqual({ result: 'invalid', why: 'needYes' });
    expect(await s.enrol({ mobile: '98400 77701', name: '', saidYes: true, seenOnPhone: false })).toEqual({ result: 'invalid', why: 'needSeen' });
    expect(await s.enrol({ mobile: '98400 77701', name: '123', saidYes: true, seenOnPhone: true })).toEqual({ result: 'invalid', why: 'badName' });
    expect(asked).toEqual([]);
    await s.enrol({ mobile: '+91 98400-77701', name: '  Lakshmi   R ', saidYes: true, seenOnPhone: true });
    expect(asked).toEqual([{ method: 'POST', path: '/v1/loyalty/members', body: { mobile: '9840077701', consent: true, verifiedHow: 'seen_on_phone', name: 'Lakshmi R' } }]);
    await s.enrol({ mobile: '9840077702', name: '', saidYes: true, seenOnPhone: true });
    expect(asked[1]!.body).toEqual({ mobile: '9840077702', consent: true, verifiedHow: 'seen_on_phone' });
  });

  it('a find posts the number, then reads the standing by member code', async () => {
    const { asked, fetch } = recorder();
    await desk(['loyalty.points.read'], fetch).find('98400 77701');
    expect(asked.map((a) => `${a.method} ${a.path}`)).toEqual(['POST /v1/loyalty/members/lookup', 'GET /v1/loyalty/members/m-0123456789abcdef01234567/standing']);
    expect(asked.some((a) => a.path.includes('98400'))).toBe(false);
  });

  it('OB-364: confirming a carried member\'s phone needs the number seen on the phone and the right to enrol; the number in the body', async () => {
    const { asked, fetch } = recorder();
    expect(await desk(['loyalty.points.read'], fetch).confirmPhone('9840077701', true)).toEqual({ result: 'invalid', why: 'cannotEnrol' });
    const s = desk(['loyalty.member.enrol', 'loyalty.points.read'], fetch);
    expect(await s.confirmPhone('12345', true)).toEqual({ result: 'invalid', why: 'needMobile' });
    expect(await s.confirmPhone('98400 77701', false)).toEqual({ result: 'invalid', why: 'needSeenConfirm' });
    expect(asked).toEqual([]);
    await s.confirmPhone('+91 98400-77701', true);
    expect(asked).toEqual([{ method: 'POST', path: '/v1/loyalty/members/confirm-phone', body: { mobile: '9840077701', verifiedHow: 'seen_on_phone' } }]);
    // The find passes on whether the look-up asks for the phone to be confirmed.
    const found = await s.find('9840077701');
    expect(found).toMatchObject({ result: 'ok', value: { member: true, phoneToConfirm: false } });
  });

  it('only the owner saves the programme; tiers in rupees and "1.5" become whole paise and basis points; a reason is needed', async () => {
    const { asked, fetch } = recorder();
    expect(await desk(['loyalty.points.read'], fetch).saveExpiry('12', 'x')).toEqual({ result: 'invalid', why: 'cannotConfigure' });
    const owner = desk(['loyalty.points.read', 'loyalty.programme.configure'], fetch);
    expect(await owner.saveTiers([{ name: 'Silver', spendRupees: '10,000', multiplier: '0.5' }], 'r')).toEqual({ result: 'invalid', why: 'badTier' });
    expect(await owner.saveTiers([{ name: 'Silver', spendRupees: '10,000', multiplier: '1.5' }], ' ')).toEqual({ result: 'invalid', why: 'needReasonFirst' });
    expect(await owner.saveExpiry('0', 'r')).toEqual({ result: 'invalid', why: 'badMonths' });
    expect(asked).toEqual([]);
    await owner.saveTiers([{ name: 'Silver', nameTa: 'வெள்ளி', spendRupees: '₹10,000', multiplier: '1.5' }, { name: '', spendRupees: '', multiplier: '' }], 'OB-295');
    expect(asked[0]).toEqual({ method: 'PUT', path: '/v1/loyalty/programme/tiers', body: { tiers: [{ tierId: 'silver', name: 'Silver', nameTa: 'வெள்ளி', minSpend12mMinor: 1_000_000, multiplierBps: 15_000 }], reason: 'OB-295' } });
    await owner.saveExpiry('', 'off');
    expect(asked[1]).toEqual({ method: 'PUT', path: '/v1/loyalty/programme/expiry', body: { months: null, reason: 'off' } });
  });

  it('words for the screen', () => {
    expect(readTierRow({ name: 'Gold Club', spendRupees: '50000', multiplier: '×2' })).toEqual({ tierId: 'gold-club', name: 'Gold Club', minSpend12mMinor: 5_000_000, multiplierBps: 20_000 });
    expect(multiplierWords(15_000)).toBe('1.5');
    expect(multiplierWords(20_000)).toBe('2');
    expect(rupees(1_000_000)).toBe('₹10,000.00');
  });
});
