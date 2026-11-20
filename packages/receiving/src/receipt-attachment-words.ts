// Batch 20e · R6 (M07-FR-04) — the words for photos and scans kept with a goods receipt, in English and Tamil, one language
// at a time. One table for Receive on the store computer, the warehouse handheld and Goods receipt review, so a file is
// called the same thing wherever it is seen. A guardrail-style unit test binds the kinds and refusal codes to these words.

import { RECEIPT_ATTACHMENT_KINDS, type ReceiptAttachmentKind } from './receipt-attachments';

export type AttachmentLang = 'en' | 'ta';

const EN = {
  heading: 'Photos and scans with this delivery',
  lead: 'A photo of the delivery note, the supplier\'s challan or damage — a JPEG or PNG photo, or a PDF scan of up to 150 KB. A photo is made smaller by itself. The files go with the delivery when you save it; the delivery never waits for them.',
  kindLabel: 'What is it?',
  delivery_note: 'Delivery note', supplier_challan: 'Supplier\'s challan', damage_photo: 'Damage photo',
  itemLabel: 'Which item (for a damage photo)', wholeDelivery: 'The whole delivery',
  pick: 'Choose a photo or scan', takePhoto: 'Take a photo of the delivery note, challan or damage',
  remove: 'Remove', reading: 'Reading the file…',
  picked: '{n} file(s) will go with this delivery when you save it.',
  savedWith: '{n} photo(s) or scan(s) kept with the delivery.',
  notKept: 'The delivery is saved. These files could not be kept: {why}',
  pendingHeading: 'Photos and scans',
  pendingLead: 'Each file and where it has got to. The delivery itself is saved on its own; it never waits for its photos.',
  waitingCount: '{n} photo(s) or scan(s) not yet at head office.',
  file_type_not_allowed: 'Only a JPEG or PNG photo, or a PDF scan, can be kept.',
  file_too_large: 'The file is larger than 150 KB. For a paper, take a photo of it instead — a photo is made smaller by itself.',
  could_not_shrink: 'The photo could not be made small enough. Take it again, closer to the paper.',
  could_not_read: 'The file could not be read. Choose it again.',
  not_base64: 'The file could not be read. Choose it again.', file_empty: 'The file is empty. Choose it again.',
  checksum_mismatch: 'The file changed on the way. Choose it again.',
  too_many_files: 'At most 10 files go with one delivery.', kind_not_known: 'Say what the file is first.',
  nobody_named: 'Nobody is signed in on this screen, so nobody can attach a file.', no_receipt: 'Choose the delivery first.',
  forItem: 'for {item}',
  // Goods receipt review (head office)
  filesHeading: 'Photos and scans', showFiles: 'Photos and scans ({n})', showFilesNone: 'Photos and scans',
  none: 'No photo or scan is kept with this delivery.', open: 'Open', attachedBy: 'Attached by {who} · {when}',
  fromStore: 'from the store computer', fromHandheld: 'from the warehouse handheld', fromHeadOffice: 'at head office',
  mistake: 'Attached by mistake', mistakeReason: 'Why was it attached by mistake? (The file stays kept.)',
  mistakeNeedsReason: 'Type why it was attached by mistake (a few words). The file is unchanged.',
  mistakeMarked: 'Marked attached by mistake by {who} on {when}: {reason}. Kept.',
  mistakeDone: 'Marked attached by mistake. The file stays kept with the delivery.',
  add: 'Add a photo or scan', added: 'Kept with the delivery.', alreadyKept: 'This file was already kept with the delivery.',
  needLink: 'Head office could not be reached. Try again when the line is up. Nothing was changed.',
  refused: 'Head office refused it:', mayNotChange: 'You may look at the files; adding one or marking a mistake needs the right to handle this delivery\'s stock.',
  flagUnknown: 'Head office does not know the person named.', flagNoAuthority: 'The person named does not hold the right to receive goods.',
  kb: '{n} KB',
} as const;

export type AttachmentWordKey = keyof typeof EN;

const TA: Record<AttachmentWordKey, string> = {
  heading: 'இந்த டெலிவரியுடன் புகைப்படங்கள், ஸ்கேன்கள்',
  lead: 'டெலிவரி குறிப்பு, சப்ளையரின் சலான் அல்லது சேதத்தின் புகைப்படம் — JPEG அல்லது PNG புகைப்படம், அல்லது 150 KB வரையிலான PDF ஸ்கேன். புகைப்படம் தானாகச் சிறியதாக்கப்படும். டெலிவரியைச் சேமிக்கும்போது கோப்புகள் அதனுடன் செல்லும்; டெலிவரி அவற்றுக்காகக் காத்திருக்காது.',
  kindLabel: 'இது என்ன?',
  delivery_note: 'டெலிவரி குறிப்பு', supplier_challan: 'சப்ளையரின் சலான்', damage_photo: 'சேதப் புகைப்படம்',
  itemLabel: 'எந்தப் பொருள் (சேதப் புகைப்படத்திற்கு)', wholeDelivery: 'முழு டெலிவரி',
  pick: 'புகைப்படம் அல்லது ஸ்கேனைத் தேர்ந்தெடு', takePhoto: 'டெலிவரி குறிப்பு, சலான் அல்லது சேதத்தைப் புகைப்படம் எடு',
  remove: 'நீக்கு', reading: 'கோப்பைப் படிக்கிறது…',
  picked: 'சேமிக்கும்போது {n} கோப்பு(கள்) இந்த டெலிவரியுடன் செல்லும்.',
  savedWith: '{n} புகைப்படம்/ஸ்கேன் டெலிவரியுடன் வைக்கப்பட்டது.',
  notKept: 'டெலிவரி சேமிக்கப்பட்டது. இந்தக் கோப்புகளை வைக்க முடியவில்லை: {why}',
  pendingHeading: 'புகைப்படங்கள், ஸ்கேன்கள்',
  pendingLead: 'ஒவ்வொரு கோப்பும் எங்கே உள்ளது. டெலிவரி தனியாகச் சேமிக்கப்படும்; அது புகைப்படங்களுக்காகக் காத்திருக்காது.',
  waitingCount: '{n} புகைப்படம்/ஸ்கேன் இன்னும் தலைமை அலுவலகத்தை அடையவில்லை.',
  file_type_not_allowed: 'JPEG அல்லது PNG புகைப்படம், அல்லது PDF ஸ்கேன் மட்டுமே வைக்கப்படும்.',
  file_too_large: 'கோப்பு 150 KB-க்கு மேல் உள்ளது. காகிதத்தைப் புகைப்படம் எடுக்கவும் — புகைப்படம் தானாகச் சிறியதாக்கப்படும்.',
  could_not_shrink: 'புகைப்படத்தைப் போதுமான அளவு சிறியதாக்க முடியவில்லை. காகிதத்திற்கு அருகில் மீண்டும் எடுக்கவும்.',
  could_not_read: 'கோப்பைப் படிக்க முடியவில்லை. மீண்டும் தேர்ந்தெடுக்கவும்.',
  not_base64: 'கோப்பைப் படிக்க முடியவில்லை. மீண்டும் தேர்ந்தெடுக்கவும்.', file_empty: 'கோப்பு காலியாக உள்ளது. மீண்டும் தேர்ந்தெடுக்கவும்.',
  checksum_mismatch: 'வரும் வழியில் கோப்பு மாறிவிட்டது. மீண்டும் தேர்ந்தெடுக்கவும்.',
  too_many_files: 'ஒரு டெலிவரியுடன் அதிகபட்சம் 10 கோப்புகள்.', kind_not_known: 'முதலில் கோப்பு என்ன என்று சொல்லவும்.',
  nobody_named: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை, எனவே யாரும் கோப்பை இணைக்க முடியாது.', no_receipt: 'முதலில் டெலிவரியைத் தேர்ந்தெடுக்கவும்.',
  forItem: '{item}-க்கு',
  filesHeading: 'புகைப்படங்கள், ஸ்கேன்கள்', showFiles: 'புகைப்படங்கள், ஸ்கேன்கள் ({n})', showFilesNone: 'புகைப்படங்கள், ஸ்கேன்கள்',
  none: 'இந்த டெலிவரியுடன் புகைப்படமோ ஸ்கேனோ இல்லை.', open: 'திற', attachedBy: 'இணைத்தவர் {who} · {when}',
  fromStore: 'கடை கணினியிலிருந்து', fromHandheld: 'கிடங்கு கைக்கருவியிலிருந்து', fromHeadOffice: 'தலைமை அலுவலகத்தில்',
  mistake: 'தவறாக இணைக்கப்பட்டது', mistakeReason: 'ஏன் தவறாக இணைக்கப்பட்டது? (கோப்பு வைக்கப்பட்டிருக்கும்.)',
  mistakeNeedsReason: 'ஏன் தவறாக இணைக்கப்பட்டது என்று சில சொற்களில் தட்டச்சு செய்யவும். கோப்பு மாறவில்லை.',
  mistakeMarked: '{who} {when} அன்று தவறாக இணைக்கப்பட்டது எனக் குறித்தார்: {reason}. வைக்கப்பட்டுள்ளது.',
  mistakeDone: 'தவறாக இணைக்கப்பட்டது எனக் குறிக்கப்பட்டது. கோப்பு டெலிவரியுடன் வைக்கப்பட்டிருக்கும்.',
  add: 'புகைப்படம் அல்லது ஸ்கேனைச் சேர்', added: 'டெலிவரியுடன் வைக்கப்பட்டது.', alreadyKept: 'இந்தக் கோப்பு ஏற்கெனவே டெலிவரியுடன் வைக்கப்பட்டுள்ளது.',
  needLink: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை. இணைப்பு வந்ததும் மீண்டும் முயற்சிக்கவும். எதுவும் மாறவில்லை.',
  refused: 'தலைமை அலுவலகம் மறுத்தது:', mayNotChange: 'நீங்கள் கோப்புகளைப் பார்க்கலாம்; சேர்க்கவோ தவறு எனக் குறிக்கவோ இந்த டெலிவரியின் சரக்கைக் கையாளும் உரிமை தேவை.',
  flagUnknown: 'பெயரிடப்பட்டவரை தலைமை அலுவலகத்திற்குத் தெரியாது.', flagNoAuthority: 'பெயரிடப்பட்டவருக்குச் சரக்கு பெறும் உரிமை இல்லை.',
  kb: '{n} KB',
};

export const RECEIPT_ATTACHMENT_WORDS: Readonly<Record<AttachmentLang, Readonly<Record<AttachmentWordKey, string>>>> = Object.freeze({ en: EN, ta: TA });

/** A word in the reader's language, with `{name}` filled in. */
export function attachmentWord(lang: AttachmentLang, key: AttachmentWordKey | string, fill: Readonly<Record<string, string | number>> = {}): string {
  const table = RECEIPT_ATTACHMENT_WORDS[lang] ?? RECEIPT_ATTACHMENT_WORDS.en;
  const raw = (table as Record<string, string>)[key] ?? (RECEIPT_ATTACHMENT_WORDS.en as Record<string, string>)[key] ?? key;
  return raw.replace(/\{(\w+)\}/g, (_m, name: string) => String(fill[name] ?? `{${name}}`));
}

/** The kinds, in the order the screens offer them, with their words. */
export function attachmentKindChoices(lang: AttachmentLang): readonly { readonly kind: ReceiptAttachmentKind; readonly label: string }[] {
  return RECEIPT_ATTACHMENT_KINDS.map((kind) => ({ kind, label: attachmentWord(lang, kind) }));
}
