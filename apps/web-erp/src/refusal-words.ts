// U0 · G10 of the UI/UX gap audit (1 Nov 2026) — design system §1 rule 5: every error says WHAT HAPPENED, whether data
// was SAVED, and the NEXT SAFE ACTION. The office pages said the first part only — "Head office refused: <its sentence>"
// — and when head office sent no sentence they showed the raw code ("Head office refused: unreadable_answer",
// "Head office refused: status 404"), which tells a shop person nothing. This is the one place that turns a refusal into
// the three parts, in both languages. Head office's own sentence, when it gave one, is kept word for word (rewording it
// here would put a second, untested version of that sentence in the product); the plain words below stand in only when
// head office gave none.

export type RefusalLang = 'en' | 'ta';

/** The shape every session's refused outcome shares (status and code from the answer; the sentence, when there is one). */
export interface RefusalShape {
  readonly status?: number;
  readonly code?: string;
  readonly whatHappened?: string;
  /** Some newer routes already say the next safe action; it is used as given. */
  readonly nextSafeAction?: string;
}

export type RefusalCause = 'no_permission' | 'not_found' | 'changed_since_read' | 'not_accepted' | 'unreadable_answer' | 'not_answering' | 'unknown';

const CODES: Readonly<Record<string, RefusalCause>> = Object.freeze({
  permission_denied: 'no_permission', forbidden: 'no_permission', not_permitted: 'no_permission', no_permission: 'no_permission',
  insufficient_permission: 'no_permission', not_allowed: 'no_permission', not_your_store: 'no_permission',
  not_found: 'not_found', unknown_record: 'not_found',
  conflict: 'changed_since_read', stale: 'changed_since_read', version_conflict: 'changed_since_read', changed_since_read: 'changed_since_read',
  invalid: 'not_accepted', validation_failed: 'not_accepted', bad_request: 'not_accepted',
  unreadable_answer: 'unreadable_answer', pack_not_readable: 'unreadable_answer',
});

/** What kind of refusal this is, from the code head office gave or, failing that, the HTTP status. */
export function causeOf(out: RefusalShape): RefusalCause {
  const code = (out.code ?? '').trim();
  if (code !== '' && CODES[code] !== undefined) return CODES[code]!;
  const status = out.status ?? Number(code);
  if (status === 401 || status === 403) return 'no_permission';
  if (status === 404) return 'not_found';
  if (status === 409 || status === 412) return 'changed_since_read';
  if (status === 400 || status === 422) return 'not_accepted';
  if (status >= 500 && status < 600) return 'not_answering';
  return 'unknown';
}

/** A sentence head office really wrote, as opposed to nothing, a bare "status 404" or the stand-in "Head office answered 404." (U1). */
export function headOfficeSaid(out: RefusalShape): string | null {
  const said = (out.whatHappened ?? '').trim();
  if (said === '' || /^status \d{3}$/i.test(said) || /^Head office answered \d{3}\.?$/i.test(said) || said === (out.code ?? '')) return null;
  return said;
}

const WORDS: Readonly<Record<RefusalLang, Readonly<Record<string, string>>>> = Object.freeze({
  en: {
    refused: 'Head office refused:',
    nothingChanged: 'Nothing was changed.',
    no_permission: 'you do not hold the right for this.',
    not_found: 'head office does not know this record.',
    changed_since_read: 'it changed since this page read it.',
    not_accepted: 'head office did not accept what was sent.',
    unreadable_answer: 'head office\'s answer could not be read.',
    not_answering: 'head office is not answering.',
    unknown: 'head office gave a reason this screen does not know (code {code}).',
    next_no_permission: 'Ask a person who holds that right.',
    next_not_found: 'Refresh the page and check the number.',
    next_changed_since_read: 'Refresh the page and try again.',
    next_not_accepted: 'Check what you typed and try again.',
    next_unreadable_answer: 'Try again; if it repeats, tell the office.',
    next_not_answering: 'Try again in a minute; if it repeats, tell the office.',
    next_unknown: 'Tell the office the code.',
  },
  ta: {
    refused: 'தலைமை அலுவலகம் மறுத்தது:',
    nothingChanged: 'எதுவும் மாற்றப்படவில்லை.',
    no_permission: 'இதற்கான உரிமை உங்களிடம் இல்லை.',
    not_found: 'இந்தப் பதிவு தலைமை அலுவலகத்திற்குத் தெரியவில்லை.',
    changed_since_read: 'இந்தப் பக்கம் படித்த பிறகு அது மாறிவிட்டது.',
    not_accepted: 'அனுப்பியதைத் தலைமை அலுவலகம் ஏற்கவில்லை.',
    unreadable_answer: 'தலைமை அலுவலகத்தின் பதிலைப் படிக்க முடியவில்லை.',
    not_answering: 'தலைமை அலுவலகம் பதிலளிக்கவில்லை.',
    unknown: 'இந்தத் திரைக்குத் தெரியாத ஒரு காரணத்தைத் தலைமை அலுவலகம் தந்தது (குறியீடு {code}).',
    next_no_permission: 'அந்த உரிமை உள்ள ஒருவரிடம் கேளுங்கள்.',
    next_not_found: 'பக்கத்தைப் புதுப்பித்து எண்ணைச் சரிபார்க்கவும்.',
    next_changed_since_read: 'பக்கத்தைப் புதுப்பித்து மீண்டும் முயற்சிக்கவும்.',
    next_not_accepted: 'தட்டச்சு செய்ததைச் சரிபார்த்து மீண்டும் முயற்சிக்கவும்.',
    next_unreadable_answer: 'மீண்டும் முயற்சிக்கவும்; மீண்டும் நடந்தால் அலுவலகத்திடம் சொல்லுங்கள்.',
    next_not_answering: 'ஒரு நிமிடம் கழித்து மீண்டும் முயற்சிக்கவும்; மீண்டும் நடந்தால் அலுவலகத்திடம் சொல்லுங்கள்.',
    next_unknown: 'குறியீட்டை அலுவலகத்திடம் சொல்லுங்கள்.',
  },
});

const w = (lang: RefusalLang, key: string): string => WORDS[lang][key] ?? WORDS.en[key] ?? key;

/** The reader's language, judged from a page's own "refused" word — for callers that carry no `lang` of their own. */
export const langOfWords = (sample: string): RefusalLang => (/[஀-௿]/.test(sample) ? 'ta' : 'en');

/** What happened: head office's sentence when it gave one, otherwise plain words for the cause — never a raw code alone. */
export function whatHappenedWords(lang: RefusalLang, out: RefusalShape): string {
  const said = headOfficeSaid(out);
  if (said !== null) return said;
  const cause = causeOf(out);
  return w(lang, cause).replace('{code}', (out.code ?? '').trim() === '' ? String(out.status ?? '?') : String(out.code));
}

/** The next safe action for the cause, or the one head office named. */
export function nextSafeActionWords(lang: RefusalLang, out: RefusalShape): string {
  const given = (out.nextSafeAction ?? '').trim();
  if (given !== '') return given;
  return w(lang, `next_${causeOf(out)}`);
}

/** "Head office refused: <what happened> Nothing was changed. <next safe action>" — the three parts, in one line. */
export function refusalWords(lang: RefusalLang, out: RefusalShape): string {
  const said = whatHappenedWords(lang, out);
  const stop = /[.!?।]$/.test(said) ? '' : '.';
  const next = nextSafeActionWords(lang, out);
  // When head office's own next-step sentence already says nothing was saved or changed, the middle part is not said
  // twice ("Nothing was changed. Nothing was saved.").
  const alreadySaysNothingChanged = /\bnothing (?:was|has been|is) (?:saved|changed|sent|recorded|posted)\b|எதுவும் (?:சேமிக்கப்படவில்லை|மாற்றப்படவில்லை|அனுப்பப்படவில்லை)/i.test(next);
  return `${w(lang, 'refused')} ${said}${stop} ${alreadySaysNothingChanged ? '' : `${w(lang, 'nothingChanged')} `}${next}`;
}
