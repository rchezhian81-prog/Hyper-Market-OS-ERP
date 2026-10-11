import { describe, it, expect } from 'vitest';
import { voiceQuery, fakeVoiceSearch, MAX_VOICE_QUERY } from '../../apps/customer-app/src/voice-search';

/**
 * D08-FR-02 voice search (round 8) — the PORT and its rule, with a fake engine. No speech engine is built (which one moves
 * a customer's voice out of the shop is the owner's decision); whatever is chosen must fit this port, and what was heard
 * only ever becomes a visible search — never a basket change.
 */
describe('what was heard becomes an ordinary search', () => {
  it('drops filler and punctuation, lower-cases Latin, keeps Tamil, caps the length', () => {
    expect(voiceQuery({ heard: true, transcript: 'Please, add Aavin MILK!' })).toEqual({ query: 'aavin milk' });
    expect(voiceQuery({ heard: true, transcript: 'பால் ' })).toEqual({ query: 'பால்' });
    const long = voiceQuery({ heard: true, transcript: 'rice '.repeat(40) });
    expect('query' in long && long.query.length).toBeLessThanOrEqual(MAX_VOICE_QUERY);
  });

  it('says why when nothing usable was heard — never an empty search that lists everything', () => {
    expect(voiceQuery({ heard: true, transcript: '  please. ' })).toEqual({ nothing: 'nothing_heard' });
    expect(voiceQuery({ heard: false, why: 'permission_denied' })).toEqual({ nothing: 'permission_denied' });
    expect(voiceQuery({ heard: false, why: 'not_supported' })).toEqual({ nothing: 'not_supported' });
  });

  it('the fake engine answers its script in order, records the language asked, then hears nothing', async () => {
    const fake = fakeVoiceSearch([{ heard: true, transcript: 'milk' }]);
    expect(fake.available()).toBe(true);
    expect(await fake.listen('ta')).toEqual({ heard: true, transcript: 'milk' });
    expect(await fake.listen('en')).toEqual({ heard: false, why: 'nothing_heard' });
    expect(fake.asked).toEqual(['ta', 'en']);
    expect(fakeVoiceSearch([], false).available()).toBe(false);
  });
});
