// Voice search (round 8 · D08-FR-02 "voice/barcode search") — the PORT and a FAKE, nothing more.
//
// Turning speech into words needs a speech engine: a phone's own recogniser, a browser service (which in most browsers
// sends the customer's voice to a third party) or a provider the shop contracts. Which one is the owner's decision —
// it moves a customer's voice out of the shop — so no engine is built here. What is built is the shape every engine
// must fit and the one rule the app keeps whichever is chosen: what was HEARD is shown and becomes an ordinary search
// the customer can see and change; nothing is ever added to the basket by voice.
//
// The fake stands in for an engine in tests and in the browser test, deterministically.

export type VoiceLanguage = 'en' | 'ta';

export type VoiceResult =
  | { readonly heard: true; readonly transcript: string }
  | { readonly heard: false; readonly why: 'not_supported' | 'permission_denied' | 'nothing_heard' | 'engine_failed' };

/** The one shape a speech engine must fit. */
export interface VoiceSearchPort {
  /** A name for the screen and the logs; never a brand in this codebase until the owner chooses one. */
  readonly name: string;
  /** Whether this device can listen at all — the microphone button is shown only when it can. */
  available(): boolean;
  /** Listen once, in the customer's chosen language. */
  listen(language: VoiceLanguage): Promise<VoiceResult>;
}

/** What the app does with a result: the search words to put in the box, or why there are none (worded by the view). */
export type VoiceQuery = { readonly query: string } | { readonly nothing: 'not_supported' | 'permission_denied' | 'nothing_heard' | 'engine_failed' };

/** At most this many characters become the search — a long monologue is not a product name. */
export const MAX_VOICE_QUERY = 60;

/**
 * Turn what was heard into search words: trimmed, punctuation and filler dropped, lower-cased (Latin only — Tamil script
 * has no case), cut to `MAX_VOICE_QUERY`. Empty after that is "nothing heard", never an empty search that lists everything.
 */
export function voiceQuery(result: VoiceResult): VoiceQuery {
  if (!result.heard) return { nothing: result.why };
  const cleaned = result.transcript
    .normalize('NFC')
    .replace(/[.,!?;:"'()[\]{}]/g, ' ')
    .replace(/\b(please|i want|i need|add|search for|show me)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, MAX_VOICE_QUERY)
    .trim();
  return cleaned === '' ? { nothing: 'nothing_heard' } : { query: cleaned };
}

/** A deterministic engine for tests: answers each `listen` with the next scripted result (then `nothing_heard`). */
export function fakeVoiceSearch(script: readonly VoiceResult[], available = true): VoiceSearchPort & { readonly asked: VoiceLanguage[] } {
  let i = 0;
  const asked: VoiceLanguage[] = [];
  return {
    name: 'fake voice engine (tests)',
    asked,
    available: () => available,
    listen: (language) => {
      asked.push(language);
      const next = script[i] ?? { heard: false, why: 'nothing_heard' as const };
      i += 1;
      return Promise.resolve(next);
    },
  };
}
