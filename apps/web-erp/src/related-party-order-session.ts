// Buying · "Related-party check" (W5 · M15-FR-03 · OB-301, owner, 23 Oct 2026, in writing: "a supplier matching that list by
// GSTIN, phone or bank account needs the owner's approval before a purchase order" · §28 · P-04) — a tested, DOM-free
// session over the two head-office routes no screen reached:
//   • CHECK an order (`GET /v1/purchase/orders/:poId/related-party`) — whether its supplier matches the owner's related-party
//     list, on WHICH fact (GSTIN / phone / bank account — never the related person's name or relation), and whether the owner
//     has approved this order for these facts;
//   • THE OWNER APPROVES (`POST /v1/purchase/orders/:poId/related-party-approval`, body { reason }) — only the owner (head
//     office checks his grants, never the page); his written reason is the approval. The order is still ISSUED by the usual
//     second person on the open-to-buy panel (nobody issues their own order).
// Nothing is read on open.

import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

export const RELATED_PARTY_ORDER_COPY = {
  en: {
    rpH: 'Related-party check', rpLede: 'An order with a supplier on the owner\'s related-party list (matched by GSTIN, phone or bank account) is issued only after the owner approves it in writing. Check an order here; the owner approves it here; it is then issued as usual by someone other than the person who raised it.',
    po: 'Order number', check: 'Check this order', reason: 'The owner\'s written reason', approve: 'Approve as the owner',
    noMatch: 'Supplier {supplier} matches nothing on the related-party list — this order needs no owner approval.', match: 'Supplier {supplier} matches the related-party list on: {facts}.',
    approved: 'The owner approved this order ({who}, {at}): {reason}', notApproved: 'Not approved by the owner yet — it cannot be issued until he does.', approvedNow: 'Approved. The order can now be issued by someone other than the person who raised it.', alreadyApproved: 'Already approved for these facts — nothing was written twice.',
    onlyOwner: 'Only the owner approves an order with a related party.',
    needPo: 'Type the order number.', needReason: 'Write the reason for approving.',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot see purchase orders.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or approved.',
  },
  ta: {
    rpH: 'தொடர்புடைய நபர் சோதனை', rpLede: 'உரிமையாளரின் தொடர்புடைய நபர் பட்டியலில் உள்ள சப்ளையருடன் (GSTIN, தொலைபேசி அல்லது வங்கிக் கணக்கு மூலம் பொருந்தியது) ஆர்டர், உரிமையாளர் எழுத்தில் ஒப்புதல் அளித்த பின்னரே வழங்கப்படும். இங்கே ஒரு ஆர்டரைச் சரிபார்க்கவும்; உரிமையாளர் இங்கே ஒப்புதல் அளிக்கிறார்; பின்னர் அதை உருவாக்கியவர் அல்லாத ஒருவர் வழக்கம் போல வழங்குகிறார்.',
    po: 'ஆர்டர் எண்', check: 'இந்த ஆர்டரைச் சரிபார்', reason: 'உரிமையாளரின் எழுத்துக் காரணம்', approve: 'உரிமையாளராக ஒப்புதல் அளி',
    noMatch: 'சப்ளையர் {supplier} தொடர்புடைய நபர் பட்டியலில் எதனுடனும் பொருந்தவில்லை — இந்த ஆர்டருக்கு உரிமையாளர் ஒப்புதல் தேவையில்லை.', match: 'சப்ளையர் {supplier} தொடர்புடைய நபர் பட்டியலுடன் பொருந்துவது: {facts}.',
    approved: 'உரிமையாளர் இந்த ஆர்டருக்கு ஒப்புதல் அளித்தார் ({who}, {at}): {reason}', notApproved: 'உரிமையாளர் இன்னும் ஒப்புதல் அளிக்கவில்லை — அவர் அளிக்கும் வரை வழங்க முடியாது.', approvedNow: 'ஒப்புதல் அளிக்கப்பட்டது. இப்போது ஆர்டரை உருவாக்கியவர் அல்லாத ஒருவர் வழங்கலாம்.', alreadyApproved: 'இந்த விவரங்களுக்கு ஏற்கனவே ஒப்புதல் உள்ளது — இருமுறை எழுதப்படவில்லை.',
    onlyOwner: 'தொடர்புடைய நபருடனான ஆர்டருக்கு உரிமையாளர் மட்டுமே ஒப்புதல் அளிக்கிறார்.',
    needPo: 'ஆர்டர் எண்ணைத் தட்டச்சு செய்யவும்.', needReason: 'ஒப்புதலுக்கான காரணத்தை எழுதவும்.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பங்கு கொள்முதல் ஆர்டர்களைப் பார்க்க முடியாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை, ஒப்புதல் அளிக்கப்படவில்லை.',
  },
} as const;

export function relatedPartyOrderWords(lang: Lang, key: string, fill?: Readonly<Record<string, string | number>>): string {
  const raw = (RELATED_PARTY_ORDER_COPY[lang] as Record<string, string>)[key] ?? (RELATED_PARTY_ORDER_COPY.en as Record<string, string>)[key] ?? key;
  return fill === undefined ? raw : raw.replace(/\{(\w+)\}/g, (_, k: string) => String(fill[k] ?? `{${k}}`));
}
export const relatedPartyOrderOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => relatedPartyOrderWords(lang, k), out);

export interface RelatedPartyCheck {
  readonly poId: string; readonly supplierId: string; readonly needed: boolean; readonly matchedOn: string | null; readonly approved: boolean;
  readonly approval: { readonly approvedBy: string; readonly reason: string; readonly at: string } | null;
}

type Why = 'nobody' | 'cannotRead' | 'onlyOwner' | 'needPo' | 'needReason';

export interface RelatedPartyOrderSession {
  /** `approve` is offered only to a person who holds the owner's approval permission; head office still checks he is the owner. */
  readonly may: { readonly named: boolean; readonly read: boolean; readonly approve: boolean };
  check(poId: string): Promise<Outcome<RelatedPartyCheck, Why>>;
  approve(poId: string, reason: string): Promise<Outcome<{ readonly needed: boolean; readonly alreadyApproved?: boolean }, Why>>;
}

export function createRelatedPartyOrderSession(input: { readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined; readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string }): RelatedPartyOrderSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, read: named && held.has('purchase.commitment.read'), approve: named && held.has('purchase.relatedparty.approve') };
  const call = makeCaller({ keyPrefix: 'related-party-order', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const no = (why: Why): { result: 'invalid'; why: Why } => ({ result: 'invalid', why });
  const enc = (s: string): string => encodeURIComponent(s.trim());
  return {
    may,
    check: async (poId) => (!named ? no('nobody') : !may.read ? no('cannotRead') : poId.trim() === '' ? no('needPo') : call<RelatedPartyCheck>('GET', `/v1/purchase/orders/${enc(poId)}/related-party`)),
    approve: async (poId, reason) => {
      if (!named) return no('nobody');
      if (!may.approve) return no('onlyOwner');
      if (poId.trim() === '') return no('needPo');
      if (reason.trim() === '') return no('needReason');
      return call('POST', `/v1/purchase/orders/${enc(poId)}/related-party-approval`, { reason: reason.trim() });
    },
  };
}
