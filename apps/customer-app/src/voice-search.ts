// Voice search (round 8 · D08-FR-02 "voice/barcode search") — the PORT, a FAKE, and (OB-322) the phone's own recogniser.
//
// Turning speech into words needs a speech engine. The owner chose the phone's built-in recogniser, switchable off
// (OB-322, below). The one rule the app keeps: what was HEARD is shown and becomes an ordinary search the customer can
// see and change; nothing is ever added to the basket by voice.
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

// ── OB-322 (owner, 23 Oct 2026): the phone's built-in recogniser, switchable off ──────────────────────────────────────
//
// The owner chose the phone's OWN speech recogniser (the browser's standard speech recognition — on many phones that
// service turns the voice into words online, run by the phone's or the browser's maker, never by this shop), and that it
// can be switched off. The customer switches it off (or back on) on their own phone, one tap, both ways; the choice stays
// on that phone. Off, or on a phone with no recogniser, the microphone button is not shown and nothing listens. Whatever
// is heard becomes an ordinary search the customer can see and change; nothing is ever added to the basket by voice.
// (OB-222 switched voice off for R4; OB-322 replaces that for voice only — the SMS code stays off.)

/** OB-322: voice search is on, through the phone's built-in recogniser, where the phone has one. */
export const VOICE_SEARCH_SWITCHED_ON = true;

export interface VoiceSearchLink extends VoiceSearchPort {
  readonly switchedOn: boolean;
  /** How many times an engine was actually asked to listen through this link — 0 while switched off. */
  readonly listensSent: () => number;
}

/**
 * The link the app is given. Off (the shop's build switch, or the customer's own switch): never available, never
 * listens. On: the engine behind it — the phone's recogniser, or a test's stand-in.
 */
export function voiceSearchLink(input: { readonly switchedOn: boolean; readonly engine?: VoiceSearchPort; readonly offByCustomer?: () => boolean }): VoiceSearchLink {
  let sent = 0;
  const on = (): boolean => input.switchedOn && input.engine !== undefined && input.offByCustomer?.() !== true;
  return {
    name: input.switchedOn && input.engine !== undefined ? input.engine.name : 'voice search (switched off)',
    get switchedOn() { return on(); },
    listensSent: () => sent,
    available: () => on() && input.engine!.available(),
    listen: async (language) => {
      if (!on()) return { heard: false, why: 'not_supported' };
      sent += 1;
      return input.engine!.listen(language);
    },
  };
}

/** The browser's speech recognition, as far as this app uses it (typed without the DOM lib). */
interface Recognition {
  lang: string; interimResults: boolean; maxAlternatives: number; continuous: boolean;
  onresult: ((e: { readonly results: ArrayLike<ArrayLike<{ readonly transcript: string }>> }) => void) | null;
  onerror: ((e: { readonly error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
}
export type RecognitionConstructor = new () => Recognition;

/** What a recogniser's error means for the customer. */
export function recognitionError(error: string): 'permission_denied' | 'nothing_heard' | 'engine_failed' {
  if (error === 'not-allowed' || error === 'service-not-allowed') return 'permission_denied';
  if (error === 'no-speech' || error === 'aborted') return 'nothing_heard';
  return 'engine_failed';
}

/** OB-322: the phone's built-in recogniser, listening once, in Indian English or Tamil. */
export function builtInRecogniser(ctor: RecognitionConstructor | undefined): VoiceSearchPort {
  return {
    name: 'the phone\'s built-in speech recogniser',
    available: () => ctor !== undefined,
    listen: (language) => new Promise<VoiceResult>((resolve) => {
      if (ctor === undefined) { resolve({ heard: false, why: 'not_supported' }); return; }
      let settled = false;
      const done = (r: VoiceResult): void => { if (!settled) { settled = true; resolve(r); } };
      try {
        const r = new ctor();
        r.lang = language === 'ta' ? 'ta-IN' : 'en-IN';
        r.interimResults = false; r.maxAlternatives = 1; r.continuous = false;
        r.onresult = (e) => { const t = e.results[0]?.[0]?.transcript ?? ''; done(t.trim() === '' ? { heard: false, why: 'nothing_heard' } : { heard: true, transcript: t }); };
        r.onerror = (e) => { done({ heard: false, why: recognitionError(e.error) }); };
        r.onend = () => { done({ heard: false, why: 'nothing_heard' }); };
        r.start();
      } catch { done({ heard: false, why: 'engine_failed' }); }
    }),
  };
}

/** The customer's own switch, kept on their phone only. Default ON (OB-322); unreadable storage reads as ON. */
export const VOICE_SWITCH_KEY = 'sre.shop.voice';
export function customerVoiceSwitch(storage: { getItem(k: string): string | null; setItem(k: string, v: string): void } | undefined): { readonly off: () => boolean; readonly set: (on: boolean) => boolean } {
  let memory: boolean | undefined;
  return {
    off: () => {
      if (memory !== undefined) return !memory;
      try { return storage?.getItem(VOICE_SWITCH_KEY) === 'off'; } catch { return false; }
    },
    set: (on) => {
      memory = on;
      try { storage?.setItem(VOICE_SWITCH_KEY, on ? 'on' : 'off'); } catch { /* kept for this visit only */ }
      return on;
    },
  };
}
