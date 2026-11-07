import { describe, it, expect } from 'vitest';
import { refusalWords, whatHappenedWords, nextSafeActionWords, causeOf, headOfficeSaid, langOfWords } from '../../apps/web-erp/src/refusal-words';
import { outcomeIn } from '../../apps/web-erp/src/r4-insight-call';
import { createCountPlansSession } from '../../apps/web-erp/src/count-plans-session';
import { createTransfersSession } from '../../apps/web-erp/src/transfers-session';
import type { HeadOfficeHttp, HttpAnswer } from '../../apps/web-erp/src/head-office-http';

/**
 * **U0 · G10 (UI/UX gap audit, 1 Nov 2026 · design system §1 rule 5): a refusal says what happened, that nothing was
 * changed, and the next safe action — and never a raw code.** Before: "Head office refused: unreadable_answer",
 * "Head office refused: status 404". Head office's own sentence, when it gave one, is kept word for word.
 */

const fakeHttp = (answer: HttpAnswer): HeadOfficeHttp => ({ get: async () => answer, post: async () => answer });
const MGR = { userId: 'u-mgr', permissions: ['inventory.count.plan', 'inventory.movement.append', 'inventory.adjustment.approve', 'inventory.availability.read'] };
const IDS = { plan: () => 'cp-1', count: (p: string, x: string) => `${p}-${x}-k` };

describe('the shared refusal words', () => {
  it('keeps head office\'s own sentence, adds "nothing was changed" and the next safe action', () => {
    const out = { status: 422, code: 'self_approval', whatHappened: 'u-mgr counted P1 and cannot approve their own variance (§28).' };
    expect(refusalWords('en', out)).toBe('Head office refused: u-mgr counted P1 and cannot approve their own variance (§28). Nothing was changed. Check what you typed and try again.');
    expect(refusalWords('ta', out)).toBe('தலைமை அலுவலகம் மறுத்தது: u-mgr counted P1 and cannot approve their own variance (§28). எதுவும் மாற்றப்படவில்லை. தட்டச்சு செய்ததைச் சரிபார்த்து மீண்டும் முயற்சிக்கவும்.');
  });

  it('a raw code or a bare status becomes plain words for its cause, in both languages', () => {
    expect(refusalWords('en', { status: 200, code: 'unreadable_answer', whatHappened: '' })).toBe('Head office refused: head office\'s answer could not be read. Nothing was changed. Try again; if it repeats, tell the office.');
    expect(refusalWords('en', { status: 404, code: '404', whatHappened: 'status 404' })).toBe('Head office refused: head office does not know this record. Nothing was changed. Refresh the page and check the number.');
    expect(refusalWords('en', { status: 403, code: 'permission_denied', whatHappened: '' })).toMatch(/you do not hold the right for this\. Nothing was changed\. Ask a person who holds that right\.$/);
    expect(refusalWords('en', { status: 409, code: 'conflict', whatHappened: '' })).toMatch(/it changed since this page read it\. Nothing was changed\. Refresh the page and try again\.$/);
    expect(refusalWords('en', { status: 503, code: '503', whatHappened: 'status 503' })).toMatch(/head office is not answering\./);
    expect(refusalWords('ta', { status: 404, code: '404', whatHappened: 'status 404' })).toBe('தலைமை அலுவலகம் மறுத்தது: இந்தப் பதிவு தலைமை அலுவலகத்திற்குத் தெரியவில்லை. எதுவும் மாற்றப்படவில்லை. பக்கத்தைப் புதுப்பித்து எண்ணைச் சரிபார்க்கவும்.');
  });

  it('an unknown code is named as such, with the code, and the next step is to tell the office', () => {
    const words = refusalWords('en', { status: 418, code: 'teapot_mode', whatHappened: '' });
    expect(words).toBe('Head office refused: head office gave a reason this screen does not know (code teapot_mode). Nothing was changed. Tell the office the code.');
    expect(causeOf({ status: 418, code: 'teapot_mode' })).toBe('unknown');
    expect(headOfficeSaid({ code: 'x', whatHappened: 'x' })).toBeNull();
    expect(headOfficeSaid({ whatHappened: 'The lines add up to 90000.' })).toBe('The lines add up to 90000.');
    expect(whatHappenedWords('en', { status: 500 })).toBe('head office is not answering.');
    expect(nextSafeActionWords('en', { nextSafeAction: 'Ask the owner.' })).toBe('Ask the owner.');
    expect(langOfWords('தலைமை அலுவலகம் மறுத்தது:')).toBe('ta');
    expect(langOfWords('Head office refused:')).toBe('en');
  });

  it('the shared caller\'s outcome words never show a bare status — a sentence from head office is kept exactly as before', () => {
    const en = (key: string): string => ({ refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was changed.' } as Record<string, string>)[key] ?? key;
    expect(outcomeIn(en, { result: 'refused', status: 404, code: '404', whatHappened: 'status 404' })).toBe('Head office refused: head office does not know this record.');
    expect(outcomeIn(en, { result: 'refused', status: 422, code: 'x', whatHappened: 'The lines add up to 90000.' })).toBe('Head office refused: The lines add up to 90000.');
    const ta = (key: string): string => ({ refused: 'தலைமை அலுவலகம் மறுத்தது:' } as Record<string, string>)[key] ?? key;
    expect(outcomeIn(ta, { result: 'refused', status: 403, code: '403', whatHappened: 'status 403' })).toBe('தலைமை அலுவலகம் மறுத்தது: இதற்கான உரிமை உங்களிடம் இல்லை.');
    // with the reader's language named, the three parts
    expect(outcomeIn(en, { result: 'refused', status: 404, code: '404', whatHappened: 'status 404' }, 'en')).toBe('Head office refused: head office does not know this record. Nothing was changed. Refresh the page and check the number.');
  });

  it('count plans and transfers: an answer the page could not read is said in words, with the next step', async () => {
    const plans = createCountPlansSession(MGR, fakeHttp({ result: 'ok', status: 200, body: {} }), IDS);
    const out = { result: 'refused' as const, status: 200, code: 'unreadable_answer', whatHappened: '' };
    expect(plans.say('en', out).words).toBe('Head office refused: head office\'s answer could not be read. Nothing was changed. Try again; if it repeats, tell the office.');
    expect(plans.say('ta', out).words).toMatch(/^தலைமை அலுவலகம் மறுத்தது: தலைமை அலுவலகத்தின் பதிலைப் படிக்க முடியவில்லை\. எதுவும் மாற்றப்படவில்லை\./);
    const transfers = createTransfersSession(MGR, fakeHttp({ result: 'refused', status: 404, code: 'not_found', whatHappened: '' }));
    expect(transfers.say('en', { result: 'refused', status: 404, code: 'not_found', whatHappened: '' }).words).toBe('Head office refused: head office does not know this record. Nothing was changed. Refresh the page and check the number.');
  });
});
