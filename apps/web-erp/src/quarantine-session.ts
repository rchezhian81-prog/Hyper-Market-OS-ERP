// The Quarantine page's session model (U6 of the UI/UX gap audit, 7 Nov 2026 · §27 Inventory "Quarantine" · M07-FR-03 ·
// M08-FR-02 · M10-FR-02 · §28 · P-03 · P-08). DOM-free and tested.
//
// One register of everything in quarantine right now: the batches on quality hold (head office's quality register) and
// the goods-receipt lines a receiver quarantined at the door that no second person has disposed of yet. The page places a
// hold (quality.hold.manage) and releases one for sale (quality.hold.release — the dedicated QC right, so the person who
// holds and the person who releases can differ); head office judges every release on the samples RECORDED on the hold,
// never on anything this page sends. A receipt line is disposed of on the Goods receipt review page — this page says which
// receipt, and the menu is the way there. Every word has a Tamil twin; head office's reasons stay as written.

import type { HeadOfficeHttp, HttpAnswer } from './head-office-http';
import { refusalWords } from './refusal-words';
import { quantityLabel } from '../../../packages/contracts/src/quantity';
import { shopMomentOf } from './stock-ledger-session';

export type Lang = 'en' | 'ta';
export interface QuarantineViewer { readonly userId?: string; readonly permissions: readonly string[] }

export interface HoldRow {
  readonly batchId: string; readonly productId: string; readonly status: string; readonly reason: string;
  readonly heldAt: string; readonly heldBy: string; readonly releasedAt?: string; readonly releasedBy?: string;
  readonly equipment?: { readonly assetId: string; readonly state: string };
}
export interface QuarantinedLineRow {
  readonly grnId: string; readonly number: string; readonly lineId: string; readonly productId: string; readonly warehouseId: string;
  readonly quantityMinor: number; readonly uom: string; readonly batchId: string | null; readonly expiry: string | null;
  readonly receivedBy: string; readonly receivedAt: string; readonly condition: string;
}
export interface QuarantineRead {
  readonly holds: readonly HoldRow[]; readonly released: readonly HoldRow[]; readonly lines: readonly QuarantinedLineRow[];
  readonly counts: { readonly batchesHeld: number; readonly batchesFailed: number; readonly receiptLines: number; readonly released: number };
  readonly asAt: string;
}

export type Refused = { readonly result: 'refused'; readonly status: number; readonly code: string; readonly whatHappened: string };
export type Outcome<T> = ({ readonly result: 'ok' } & T) | Refused | { readonly result: 'lost_link' } | { readonly result: 'invalid'; readonly key: string };

const WORDS: Readonly<Record<Lang, Readonly<Record<string, string>>>> = Object.freeze({
  en: {
    title: 'Quarantine',
    lede: 'Stock that is counted but must not be sold: batches on quality hold, and delivery lines held at the door until a second person decides what happens to them. Quarantined stock is never available to the till or to an order.',
    batchesHeld: 'Batches on hold', batchesFailed: 'Failed a test', receiptLines: 'Delivery lines held', releasedN: 'Released (record kept)',
    holdsH: 'Batches on quality hold', holdsLede: 'Held by quality or by a cold-chain reading. A release is judged by head office on the samples recorded on the hold.',
    linesH: 'Delivery lines in quarantine', linesLede: 'Quarantined at the door (damaged, temperature breach). Decide each one on the Goods receipt review page — open it from the menu.',
    releasedH: 'Released batches', releasedLede: 'The record is kept: who released each batch and when.',
    newH: 'Put a batch in quarantine', newLede: 'Name the batch, the product and the reason. The batch stops being sellable the moment head office records the hold.',
    batch: 'Batch', product: 'Product', reason: 'Reason', place: 'Place', quantity: 'Quantity', condition: 'What was found', since: 'Since', heldBy: 'Held by', receivedBy: 'Received by', expiry: 'Expiry', receipt: 'Delivery', state: 'State', releasedBy: 'Released by', releasedAt: 'Released at', equipment: 'Equipment',
    hold: 'Put in quarantine', release: 'Release for sale', whichProduct: 'Which product?', choose: 'Choose…',
    held: 'On hold', failed: 'Failed a test', sampling: 'Sample being tested', pending: 'Waiting for a sample', released: 'Released', passed: 'Passed',
    damaged: 'Damaged', temperature_breach: 'Temperature breach', quarantine: 'Quarantined', good: 'Good',
    noBatch: '—', noExpiry: '—',
    confirmHoldTitle: 'Put batch {batch} in quarantine?', confirmHoldDetail: 'Batch {batch} of {product} stops being sellable at every till and for every order the moment head office records it, in your name. Releasing it later needs the samples recorded on the hold.',
    confirmReleaseTitle: 'Release batch {batch} for sale?', confirmReleaseDetail: 'Head office checks the samples recorded on this hold, the cold-chain reading and the expiry before it releases anything. If it releases the batch, it becomes sellable again in your name.',
    authorityHold: 'Your role may place a quality hold.', authorityRelease: 'Your role may release a batch from quarantine; the person who held it may be somebody else.',
    heldNow: 'Head office recorded the hold. The batch is not sellable.', alreadyHeld: 'That batch was already on hold — nothing new was recorded.', releasedNow: 'Head office released the batch for sale.',
    reading: 'Reading from head office…', unreachable: 'Head office cannot be reached — nothing was read.', refused: 'Head office refused:',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot read the quarantine register.', cannotHold: 'Your role cannot place a quality hold.', cannotRelease: 'Your role cannot release a batch from quarantine.',
    needBatch: 'Type the batch id first.', needProduct: 'Choose the product first.', needReason: 'Write the reason first.',
    confirmUnavailable: 'The confirm step could not open — nothing was sent.',
    emptyHolds: 'No batch is on quality hold.', emptyHoldsDetail: 'Head office holds no batch for quality right now. A cold-chain breach or a failed sample would appear here.',
    emptyLines: 'No delivery line is in quarantine.', emptyLinesDetail: 'Every quarantined line at your places has been decided on the Goods receipt review page.',
    emptyReleased: 'No batch has been released yet.', emptyReleasedDetail: 'A released batch stays on record here with who released it.',
    asAt: 'Read from head office at', covers: 'This register covers the places your role may see.',
  },
  ta: {
    title: 'தனிமைப்படுத்தல்',
    lede: 'எண்ணப்பட்ட ஆனால் விற்கக்கூடாத சரக்கு: தரக் காத்திருப்பில் உள்ள தொகுதிகள், மற்றும் இரண்டாவது நபர் முடிவு செய்யும் வரை வாசலில் நிறுத்தப்பட்ட விநியோக வரிகள். தனிமைப்படுத்தப்பட்ட சரக்கு கல்லாவுக்கோ ஆர்டருக்கோ ஒருபோதும் கிடைக்காது.',
    batchesHeld: 'காத்திருப்பில் உள்ள தொகுதிகள்', batchesFailed: 'சோதனையில் தோல்வி', receiptLines: 'நிறுத்தப்பட்ட விநியோக வரிகள்', releasedN: 'விடுவிக்கப்பட்டவை (பதிவு உள்ளது)',
    holdsH: 'தரக் காத்திருப்பில் உள்ள தொகுதிகள்', holdsLede: 'தரத்தால் அல்லது குளிர்ச்சங்கிலி அளவீட்டால் நிறுத்தப்பட்டவை. விடுவிப்பை தலைமை அலுவலகம் காத்திருப்பில் பதிவான மாதிரிகளைக் கொண்டு முடிவு செய்கிறது.',
    linesH: 'தனிமைப்படுத்தலில் உள்ள விநியோக வரிகள்', linesLede: 'வாசலில் தனிமைப்படுத்தப்பட்டவை (சேதம், வெப்பநிலை மீறல்). ஒவ்வொன்றையும் சரக்கு வரவு ஆய்வுப் பக்கத்தில் முடிவு செய்யவும் — மெனுவிலிருந்து திறக்கவும்.',
    releasedH: 'விடுவிக்கப்பட்ட தொகுதிகள்', releasedLede: 'பதிவு வைக்கப்படுகிறது: ஒவ்வொரு தொகுதியையும் யார், எப்போது விடுவித்தார்.',
    newH: 'ஒரு தொகுதியைத் தனிமைப்படுத்து', newLede: 'தொகுதி, பொருள், காரணத்தைக் கூறவும். தலைமை அலுவலகம் காத்திருப்பைப் பதிவு செய்த உடனே தொகுதி விற்கக்கூடியதாக இருக்காது.',
    batch: 'தொகுதி', product: 'பொருள்', reason: 'காரணம்', place: 'இடம்', quantity: 'அளவு', condition: 'கண்டறியப்பட்டது', since: 'முதல்', heldBy: 'நிறுத்தியவர்', receivedBy: 'பெற்றவர்', expiry: 'காலாவதி', receipt: 'விநியோகம்', state: 'நிலை', releasedBy: 'விடுவித்தவர்', releasedAt: 'விடுவித்த நேரம்', equipment: 'சாதனம்',
    hold: 'தனிமைப்படுத்து', release: 'விற்பனைக்கு விடுவி', whichProduct: 'எந்தப் பொருள்?', choose: 'தேர்வு…',
    held: 'காத்திருப்பில்', failed: 'சோதனையில் தோல்வி', sampling: 'மாதிரி சோதனையில்', pending: 'மாதிரிக்குக் காத்திருப்பு', released: 'விடுவிக்கப்பட்டது', passed: 'தேர்ச்சி',
    damaged: 'சேதம்', temperature_breach: 'வெப்பநிலை மீறல்', quarantine: 'தனிமைப்படுத்தப்பட்டது', good: 'நல்லது',
    noBatch: '—', noExpiry: '—',
    confirmHoldTitle: 'தொகுதி {batch}-ஐத் தனிமைப்படுத்தவா?', confirmHoldDetail: '{product}-இன் தொகுதி {batch}, தலைமை அலுவலகம் பதிவு செய்த உடனே, உங்கள் பெயரில், ஒவ்வொரு கல்லாவிலும் ஒவ்வொரு ஆர்டருக்கும் விற்கக்கூடியதாக இருக்காது. பின்னர் விடுவிக்க காத்திருப்பில் பதிவான மாதிரிகள் தேவை.',
    confirmReleaseTitle: 'தொகுதி {batch}-ஐ விற்பனைக்கு விடுவிக்கவா?', confirmReleaseDetail: 'தலைமை அலுவலகம் இந்தக் காத்திருப்பில் பதிவான மாதிரிகள், குளிர்ச்சங்கிலி அளவீடு, காலாவதியைச் சரிபார்த்த பின்னரே விடுவிக்கும். விடுவித்தால், தொகுதி உங்கள் பெயரில் மீண்டும் விற்கக்கூடியதாகும்.',
    authorityHold: 'உங்கள் பங்கு தரக் காத்திருப்பை வைக்கலாம்.', authorityRelease: 'உங்கள் பங்கு தனிமைப்படுத்தலிலிருந்து தொகுதியை விடுவிக்கலாம்; நிறுத்தியவர் வேறு நபராக இருக்கலாம்.',
    heldNow: 'தலைமை அலுவலகம் காத்திருப்பைப் பதிவு செய்தது. தொகுதி விற்கக்கூடியதல்ல.', alreadyHeld: 'அந்தத் தொகுதி ஏற்கனவே காத்திருப்பில் இருந்தது — புதிதாக எதுவும் பதிவாகவில்லை.', releasedNow: 'தலைமை அலுவலகம் தொகுதியை விற்பனைக்கு விடுவித்தது.',
    reading: 'தலைமை அலுவலகத்திலிருந்து படிக்கிறது…', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை.', refused: 'தலைமை அலுவலகம் மறுத்தது:',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பங்கு தனிமைப்படுத்தல் பதிவேட்டைப் படிக்க முடியாது.', cannotHold: 'உங்கள் பங்கு தரக் காத்திருப்பை வைக்க முடியாது.', cannotRelease: 'உங்கள் பங்கு தொகுதியைத் தனிமைப்படுத்தலிலிருந்து விடுவிக்க முடியாது.',
    needBatch: 'முதலில் தொகுதி எண்ணைத் தட்டச்சு செய்யவும்.', needProduct: 'முதலில் பொருளைத் தேர்ந்தெடுக்கவும்.', needReason: 'முதலில் காரணத்தை எழுதவும்.',
    confirmUnavailable: 'உறுதிப்படுத்தும் படி திறக்கவில்லை — எதுவும் அனுப்பப்படவில்லை.',
    emptyHolds: 'எந்தத் தொகுதியும் தரக் காத்திருப்பில் இல்லை.', emptyHoldsDetail: 'தலைமை அலுவலகம் இப்போது எந்தத் தொகுதியையும் தரத்திற்காக நிறுத்தவில்லை. குளிர்ச்சங்கிலி மீறல் அல்லது தோல்வியடைந்த மாதிரி இங்கே தோன்றும்.',
    emptyLines: 'எந்த விநியோக வரியும் தனிமைப்படுத்தலில் இல்லை.', emptyLinesDetail: 'உங்கள் இடங்களில் தனிமைப்படுத்தப்பட்ட ஒவ்வொரு வரியும் சரக்கு வரவு ஆய்வுப் பக்கத்தில் முடிவு செய்யப்பட்டுவிட்டது.',
    emptyReleased: 'இன்னும் எந்தத் தொகுதியும் விடுவிக்கப்படவில்லை.', emptyReleasedDetail: 'விடுவிக்கப்பட்ட தொகுதி யார் விடுவித்தார் என்பதுடன் இங்கே பதிவில் இருக்கும்.',
    asAt: 'தலைமை அலுவலகத்திலிருந்து படித்த நேரம்', covers: 'இந்தப் பதிவேடு உங்கள் பங்கு பார்க்கக்கூடிய இடங்களை உள்ளடக்கியது.',
  },
});
export const QUARANTINE_WORD_KEYS: readonly string[] = Object.freeze(Object.keys(WORDS.en));
export const text = (lang: Lang, key: string): string => WORDS[lang][key] ?? WORDS.en[key] ?? key;
/** A word with its {batch} / {product} filled in. */
export const fill = (lang: Lang, key: string, values: Readonly<Record<string, string>>): string => Object.entries(values).reduce((s, [k, v]) => s.split(`{${k}}`).join(v), text(lang, key));

export function holdView(lang: Lang, h: HoldRow) {
  return {
    ...h, stateWord: text(lang, h.status), since: shopMomentOf(h.heldAt),
    releasedWhen: h.releasedAt === undefined ? null : shopMomentOf(h.releasedAt),
    equipmentWord: h.equipment === undefined ? null : `${h.equipment.assetId} (${h.equipment.state})`,
    inQuarantine: h.status !== 'released' && h.status !== 'passed',
  };
}
export function lineView(lang: Lang, l: QuarantinedLineRow) {
  return {
    ...l, quantity: quantityLabel(l.quantityMinor, l.uom), since: shopMomentOf(l.receivedAt),
    conditionWord: text(lang, l.condition), batchWord: l.batchId === null ? text(lang, 'noBatch') : l.batchId, expiryWord: l.expiry === null ? text(lang, 'noExpiry') : l.expiry,
  };
}

const enc = encodeURIComponent;
const refusedOrLost = (a: HttpAnswer): Refused | { readonly result: 'lost_link' } => (a.result === 'lost_link' ? a : { result: 'refused', status: a.status, code: a.result === 'refused' ? a.code : 'unreadable_answer', whatHappened: a.result === 'refused' ? a.whatHappened : '' });
const isRead = (b: unknown): b is QuarantineRead => b !== null && typeof b === 'object' && Array.isArray((b as { holds?: unknown }).holds) && Array.isArray((b as { lines?: unknown }).lines);

export interface HoldForm { readonly batchId: string; readonly productId: string; readonly reason: string }
/** The body head office is sent, or what is missing. */
export function holdBody(form: HoldForm): { readonly batchId: string; readonly body: { productId: string; reason: string } } | { readonly key: string } {
  const batchId = form.batchId.trim(); const productId = form.productId.trim(); const reason = form.reason.trim();
  if (batchId === '') return { key: 'needBatch' };
  if (productId === '') return { key: 'needProduct' };
  if (reason === '') return { key: 'needReason' };
  return { batchId, body: { productId, reason } };
}

export function createQuarantineSession(viewer: QuarantineViewer | undefined, http: HeadOfficeHttp) {
  const perms = new Set(viewer?.permissions ?? []);
  const nobody = viewer === undefined;
  const may = { read: perms.has('quality.hold.manage'), hold: perms.has('quality.hold.manage'), release: perms.has('quality.hold.release') };
  const post = async (path: string, body: unknown): Promise<Outcome<{ readonly body: unknown }>> => {
    if (nobody) return { result: 'invalid', key: 'nobody' };
    const a = await http.post(path, body);
    return a.result === 'ok' ? { result: 'ok', body: a.body } : refusedOrLost(a);
  };
  return {
    nobody, userId: viewer?.userId ?? null, may, text, fill, holdView, lineView, shopMomentOf,
    async read(): Promise<Outcome<{ readonly register: QuarantineRead }>> {
      if (nobody) return { result: 'invalid', key: 'nobody' };
      if (!may.read) return { result: 'invalid', key: 'cannotRead' };
      const a = await http.get('/v1/inventory/quarantine');
      if (a.result !== 'ok') return refusedOrLost(a);
      if (!isRead(a.body)) return { result: 'refused', status: a.status, code: 'unreadable_answer', whatHappened: '' };
      return { result: 'ok', register: a.body };
    },
    async hold(form: HoldForm): Promise<Outcome<{ readonly body: unknown; readonly alreadyHeld: boolean }>> {
      if (nobody) return { result: 'invalid', key: 'nobody' };
      if (!may.hold) return { result: 'invalid', key: 'cannotHold' };
      const made = holdBody(form);
      if ('key' in made) return { result: 'invalid', key: made.key };
      const out = await post(`/v1/quality/holds/${enc(made.batchId)}`, made.body);
      if (out.result !== 'ok') return out;
      return { ...out, alreadyHeld: (out.body as { alreadyHeld?: unknown }).alreadyHeld === true };
    },
    async release(batchId: string): Promise<Outcome<{ readonly body: unknown }>> {
      if (nobody) return { result: 'invalid', key: 'nobody' };
      if (!may.release) return { result: 'invalid', key: 'cannotRelease' };
      if (batchId.trim() === '') return { result: 'invalid', key: 'needBatch' };
      // No samples in the body: head office judges the release on the samples RECORDED on the hold (M10-FR-02).
      return post(`/v1/quality/holds/${enc(batchId.trim())}/release`, {});
    },
    say(lang: Lang, out: Outcome<unknown>, good = ''): { readonly tone: 'good' | 'err'; readonly words: string } {
      if (out.result === 'ok') return { tone: 'good', words: good === '' ? '' : text(lang, good) };
      if (out.result === 'lost_link') return { tone: 'err', words: text(lang, 'unreachable') };
      if (out.result === 'invalid') return { tone: 'err', words: text(lang, out.key) };
      return { tone: 'err', words: refusalWords(lang, out) };
    },
  };
}
export type QuarantineSession = ReturnType<typeof createQuarantineSession>;
