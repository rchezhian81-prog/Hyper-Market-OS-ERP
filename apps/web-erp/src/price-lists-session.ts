// PRICE LISTS — the panel on the Products and prices page where a pricing person sets a DATED price for one store, a zone,
// a channel or a customer, sees every price a product has had and which one is in force on a date, keeps the price zones
// (which stores are in each) and asks for a channel's own prices to be switched on (M05-FR-01 · D-19 · OB-148/OB-190 ·
// OB-291 · P-07 · P-08).
//
// A THIN client over head office's own routes, with their permissions and approval paths exactly as they are:
//   POST /v1/prices/list/:productId/entries/:entryId   price.change.propose — above MRP refused (no approval lifts it);
//        below cost / below the margin floor / a move larger than the owner's set size (OB-291: more than 10% or ₹50)
//        refused unless a SECOND person who may approve prices approved exactly this entry in their own session
//        (kind `price_list_entry`, ADR-0024); a date before today refused; a zone or channel price refused while that
//        switch is off (OB-148 "same price everywhere").
//   GET  /v1/prices/list/:productId/history | /resolve  catalogue.pack.read
//   GET  /v1/prices/zones · POST /v1/prices/zones/:zoneId/stores/:storeId (price.zone.manage)
//   GET  /v1/prices/channel-pricing · POST …/requests/:id (price.change.propose) · POST …/requests/:id/approve
//        (price.change.approve; never the person who asked — head office refuses that by name)
//   GET  /v1/prices/channel-differences?storeId=        the OB-190 report: any price that differs from the shelf
//
// The MRP, the cost and the margin floor sent with an entry are the SAME figures the "Change a price" tab sends (the MRP
// in force on the entry's first day, the cost the store computer was told, the store's own floor) — never typed here, and
// when one is missing nothing is sent and the panel says which (P-08). A sale already in progress is never repriced: an
// entry only changes what later sales resolve, and the till locks each line to the entry it referenced (§31.1).

import { translator, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { instantOfTyped, servedShopZone } from '../../../packages/calendar/src/shop-day';
import { outcomeOf, type HttpAnswer, type Outcome } from './finance-close-session';
import { detailsOfBody, findOwnApproval, sameDetails, useOutcomeOfRefusal, MIN_REASON_LENGTH, type ApprovalAskOutcome, type ApprovalUseOutcome } from './catalogue-session';
import type { ApprovalAsk, AskResult, InboxRead } from './approvals-session';

export const PRICE_SCOPES = Object.freeze(['store', 'zone', 'channel', 'customer'] as const);
export type PriceScopeWord = (typeof PRICE_SCOPES)[number];
/** The channels head office reports against the shelf (D-19); the till's in-store channel IS the shelf price. */
export const PRICE_CHANNELS = Object.freeze(['app', 'delivery'] as const);

export const PRICE_LIST_PERMISSIONS = Object.freeze({
  read: 'catalogue.pack.read', set: 'price.change.propose', zones: 'price.zone.manage', approve: 'price.change.approve',
});
export const PRICE_LIST_APPROVAL_KIND = 'price_list_entry';
/** Head office's refusals that a second person's approval of exactly this entry answers. */
export const NEEDS_SECOND_PERSON = Object.freeze(['price_below_cost', 'price_below_floor', 'price_change_needs_second_person'] as const);

export interface PriceListHttp {
  get(path: string): Promise<HttpAnswer>;
  post(path: string, body: unknown): Promise<HttpAnswer>;
}

/** The figures an entry is judged by, from the same sources the "Change a price" tab uses — or which one is missing. */
export type PriceFigures =
  | { readonly ok: true; readonly mrpMinor: number; readonly costMinor: number; readonly marginFloorBps: number }
  | { readonly ok: false; readonly missing: 'mrp' | 'cost' | 'floor' };
export type PriceFiguresOf = (productId: string, onDay: string) => PriceFigures;

/** What the page was served that the figures come from — the same fields the "Change a price" tab reads. */
export interface PriceFiguresSource {
  readonly products?: readonly { readonly productId: string; readonly mrpHistory?: readonly { readonly effectiveFrom: string; readonly value: { readonly minor: number } }[] }[];
  readonly costsMinor?: Readonly<Record<string, number>>;
  readonly marginFloorBps?: number;
}

/**
 * The figures from the page's own data: the MRP IN FORCE on the entry's first day (a later MRP never lifts an earlier
 * day's ceiling), the cost the store computer was told, the store's margin floor. A missing one is said, never defaulted —
 * a floor of 0 would wave every loss-making price through. Pure.
 */
export function figuresFromPageData(data: PriceFiguresSource | undefined): PriceFiguresOf {
  return (productId, onDay) => {
    const mrp = (data?.products?.find((p) => p.productId === productId)?.mrpHistory ?? [])
      .filter((m) => m.effectiveFrom.slice(0, 10) <= onDay)
      .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
      .at(-1)?.value.minor;
    if (mrp === undefined) return { ok: false, missing: 'mrp' };
    const cost = data?.costsMinor?.[productId];
    if (cost === undefined) return { ok: false, missing: 'cost' };
    const floor = data?.marginFloorBps;
    if (floor === undefined) return { ok: false, missing: 'floor' };
    return { ok: true, mrpMinor: mrp, costMinor: cost, marginFloorBps: floor };
  };
}

export interface PriceListApprovals {
  askApproval?(ask: ApprovalAsk): Promise<AskResult>;
  approvalInbox?(): Promise<InboxRead>;
}

export interface PriceListViewer {
  readonly userId?: string;
  readonly permissions: readonly string[];
  /** The store this page was served for — the default "which store". */
  readonly storeId?: string;
  /** The shop's zone; absent → the zone the store computer served the page in. */
  readonly timeZone?: string;
}

/** What the person typed for a dated price. Money in rupees, days as YYYY-MM-DD in the shop's calendar. */
export interface PriceEntryInput {
  readonly productId: string;
  readonly scope: string;
  readonly scopeRef: string;
  readonly price: string;
  readonly from: string;
  /** The LAST day it applies (blank = until another price replaces it). */
  readonly to?: string;
}

/** One entry as head office's history gives it. */
export interface PriceListEntryView {
  readonly id: string; readonly productId: string; readonly scope: PriceScopeWord; readonly scopeRef: string;
  readonly price: { readonly minor: number; readonly currency: string };
  readonly effectiveFrom: string; readonly effectiveTo?: string | null; readonly status: string; readonly version: number;
  readonly batchId?: string;
}
export interface PriceInForce {
  readonly productId: string; readonly entryId: string; readonly version: number; readonly scope: PriceScopeWord; readonly scopeRef: string;
  readonly priceMinor: number; readonly effectiveFrom: string; readonly effectiveTo: string | null;
}
export interface ZoneMembershipView { readonly storeId: string; readonly zoneId: string; readonly setBy: string; readonly setAt: string }
export interface SwitchRequestView {
  readonly requestId: string; readonly subject: string; readonly to: 'on' | 'off'; readonly reason: string;
  readonly requestedBy: string; readonly requestedAt: string; readonly status: 'pending' | 'applied';
  readonly approvedBy: string | null; readonly approvedAt: string | null;
}
export interface ChannelPricingView {
  readonly switches: readonly { readonly subject: string; readonly state: 'on' | 'off' }[];
  readonly pending: readonly SwitchRequestView[];
  readonly samePriceEverywhere: boolean;
}
export interface ChannelDifferencesView {
  readonly differences: readonly { readonly productId: string; readonly channel: string; readonly shelfPriceMinor: number | null; readonly channelPriceMinor: number }[];
  readonly dormantEntries: readonly { readonly productId: string; readonly scope: string; readonly scopeRef: string; readonly priceMinor: number; readonly switch: string }[];
  readonly samePriceEverywhere: boolean;
}

export type PriceListCopyKey =
  | 'tab' | 'h' | 'lede' | 'notConnected' | 'cannotRead' | 'readOnly'
  | 'entriesH' | 'product' | 'show' | 'noEntries' | 'entryLine' | 'until' | 'openEnded' | 'version' | 'notActive'
  | 'inForceH' | 'onDay' | 'store' | 'channelOpt' | 'customerOpt' | 'check' | 'inForceLine' | 'noneInForce'
  | 'nStore' | 'nZone' | 'nChannel' | 'nCustomer'
  | 'setH' | 'scope' | 'store_s' | 'zone_s' | 'channel_s' | 'customer_s' | 'which' | 'price' | 'from' | 'to' | 'save'
  | 'saved' | 'needsSecond' | 'why' | 'ask' | 'saveApproved' | 'summary'
  | 'zonesH' | 'zonesLede' | 'noZones' | 'zoneLine' | 'zoneId' | 'zoneStore' | 'putInZone' | 'zoneSaved' | 'zonesReadOnly'
  | 'channelH' | 'channelLede' | 'samePrice' | 'notSamePrice' | 'switchOn' | 'switchOff' | 'subjectZone' | 'subjectChannel'
  | 'askOn' | 'turnOff' | 'switchReason' | 'pendingLine' | 'approve' | 'yours' | 'askedOn' | 'turnedOff' | 'approved' | 'noPending'
  | 'diffH' | 'diffLine' | 'dormantLine' | 'noDiff' | 'diffShow'
  | 'refused' | 'unreachable' | 'unreadable' | 'notAllowed' | 'needFields' | 'needReason' | 'noMrp' | 'noCost' | 'noFloor' | 'rupee';

export const PRICE_LIST_COPY: BilingualCopy<PriceListCopyKey> = {
  en: {
    tab: 'Price lists', h: 'Price lists',
    lede: 'A price for one store, a price zone, a channel or a customer, from a date you choose. The most specific price wins: customer, then channel, then zone, then the store’s shelf price. A sale already on the till keeps the price it started with.',
    notConnected: 'Price lists are kept at head office. Open Products and prices from head office to see or change them.',
    cannotRead: 'Your role cannot read the price lists.', readOnly: 'You can read the price lists; setting a price needs the pricing role.',
    entriesH: 'Every price this item has had', product: 'Item code', show: 'Show its prices', noEntries: 'No dated price is on record for this item yet.',
    entryLine: '{price} for {scope} {ref}, from {from}', until: 'until {to}', openEnded: 'until another price replaces it', version: 'version {v}', notActive: '(not in use)',
    inForceH: 'Which price is in force on a date', onDay: 'On', store: 'At store', channelOpt: 'Channel (optional)', customerOpt: 'Customer (optional)', check: 'Check',
    inForceLine: 'In force: {price} — the {scope} price for {ref}, from {from}.', noneInForce: 'No price is in force for this item there on that day.',
    nStore: 'store', nZone: 'zone', nChannel: 'channel', nCustomer: 'customer',
    setH: 'Set a dated price', scope: 'Applies to', store_s: 'one store', zone_s: 'a price zone', channel_s: 'a channel', customer_s: 'a customer',
    which: 'Which one', price: 'Price (in rupees)', from: 'From', to: 'Last day (optional)', save: 'Save this price at head office',
    saved: 'Saved at head office: {price} for {scope} {ref}, from {from}. The tills charge it from that day, after the next price update.',
    needsSecond: 'This price needs a second person. Write why and press “Ask for approval”; once someone else who may approve prices approves it on their Approvals page, press “Save the approved price”.',
    why: 'Why this is needed (the person approving reads it)', ask: 'Ask for approval', saveApproved: 'Save the approved price',
    summary: 'Price of {product} for {scope} {ref} to {price} from {from}',
    zonesH: 'Price zones', zonesLede: 'A zone is a group of stores that share one zone price. Zone prices are charged only while zone pricing is switched on.',
    noZones: 'No store has been put in a zone yet.', zoneLine: 'Zone {zone}: {stores}', zoneId: 'Zone', zoneStore: 'Store', putInZone: 'Put this store in this zone',
    zoneSaved: 'Saved at head office: store {store} is now in zone {zone}.', zonesReadOnly: 'Changing zones needs the zone-manager permission (the owner holds it).',
    channelH: 'Channel prices (app, delivery, zones)', channelLede: 'Switched off, the till, the app and delivery all charge the same shelf price. Switching one on needs a second person’s approval; switching off happens at once.',
    samePrice: 'Same price everywhere: every switch is off.', notSamePrice: 'Some channel prices are switched on — see the differences below.',
    switchOn: 'on', switchOff: 'off', subjectZone: 'Zone prices', subjectChannel: 'The {channel} channel',
    askOn: 'Ask to switch on', turnOff: 'Switch off now', switchReason: 'Why (needed)',
    pendingLine: '{subject}: {who} asked to switch it on — “{reason}”', approve: 'Approve switching on', yours: 'You asked for this — a second person must approve it.',
    askedOn: 'Asked. A second person who may approve prices must approve switching it on. Nothing has changed yet.', turnedOff: 'Switched off at head office — one price everywhere again.', approved: 'Approved: it is switched on.',
    noPending: 'No request is waiting.',
    diffH: 'Prices that differ from the shelf', diffShow: 'Show the differences at this store',
    diffLine: '{product}: {channel} {channelPrice} — shelf {shelfPrice}', dormantLine: '{product}: a {scope} price {price} for {ref} is kept but not charged (switch off)',
    noDiff: 'No price differs from the shelf at this store.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was saved. Try again when the connection is back.',
    unreadable: 'Head office cannot be reached — nothing could be read, so nothing is shown.', notAllowed: 'Your role cannot do this.',
    needFields: 'Give the item code, who it applies to, a price in rupees and the first day.', needReason: 'Write why in the box first. Nothing was sent.',
    noMrp: 'Nothing was sent — no MRP is recorded for this item on that day, so the legal ceiling cannot be checked.',
    noCost: 'Nothing was sent — this screen has not been told what this item cost, so the margin cannot be checked.',
    noFloor: 'Nothing was sent — this screen has not been told the store’s margin floor, so the margin cannot be checked.',
    rupee: '₹{v}',
  },
  ta: {
    tab: 'விலைப் பட்டியல்கள்', h: 'விலைப் பட்டியல்கள்',
    lede: 'ஒரு கடை, ஒரு விலை மண்டலம், ஒரு விற்பனை வழி அல்லது ஒரு வாடிக்கையாளருக்கான விலை, நீங்கள் தேர்ந்தெடுக்கும் தேதியிலிருந்து. மிகக் குறிப்பான விலையே பொருந்தும்: வாடிக்கையாளர், பிறகு விற்பனை வழி, பிறகு மண்டலம், பிறகு கடையின் அலமாரி விலை. பில்லில் ஏற்கனவே தொடங்கிய விற்பனை தொடங்கிய விலையிலேயே இருக்கும்.',
    notConnected: 'விலைப் பட்டியல்கள் தலைமை அலுவலகத்தில் வைக்கப்படுகின்றன. அவற்றைப் பார்க்க அல்லது மாற்ற, தலைமை அலுவலகத்திலிருந்து பொருட்களும் விலைகளும் திரையைத் திறக்கவும்.',
    cannotRead: 'உங்கள் பங்கால் விலைப் பட்டியல்களைப் படிக்க முடியாது.', readOnly: 'நீங்கள் விலைப் பட்டியல்களைப் படிக்கலாம்; விலை அமைக்க விலை நிர்ணயப் பங்கு தேவை.',
    entriesH: 'இந்தப் பொருளுக்கு இருந்த எல்லா விலைகளும்', product: 'பொருள் குறியீடு', show: 'அதன் விலைகளைக் காட்டு', noEntries: 'இந்தப் பொருளுக்கு இன்னும் தேதியிட்ட விலை எதுவும் பதிவில் இல்லை.',
    entryLine: '{scope} {ref} க்கு {price}, {from} முதல்', until: '{to} வரை', openEnded: 'வேறு விலை வரும் வரை', version: 'பதிப்பு {v}', notActive: '(பயன்பாட்டில் இல்லை)',
    inForceH: 'ஒரு தேதியில் எந்த விலை நடைமுறையில் உள்ளது', onDay: 'தேதி', store: 'கடை', channelOpt: 'விற்பனை வழி (விருப்பம்)', customerOpt: 'வாடிக்கையாளர் (விருப்பம்)', check: 'சரிபார்',
    inForceLine: 'நடைமுறையில்: {price} — {ref} க்கான {scope} விலை, {from} முதல்.', noneInForce: 'அந்த நாளில் அங்கே இந்தப் பொருளுக்கு எந்த விலையும் நடைமுறையில் இல்லை.',
    nStore: 'கடை', nZone: 'மண்டலம்', nChannel: 'விற்பனை வழி', nCustomer: 'வாடிக்கையாளர்',
    setH: 'தேதியிட்ட விலையை அமை', scope: 'யாருக்குப் பொருந்தும்', store_s: 'ஒரு கடை', zone_s: 'ஒரு விலை மண்டலம்', channel_s: 'ஒரு விற்பனை வழி', customer_s: 'ஒரு வாடிக்கையாளர்',
    which: 'எது', price: 'விலை (ரூபாயில்)', from: 'தொடங்கும் நாள்', to: 'கடைசி நாள் (விருப்பம்)', save: 'இந்த விலையைத் தலைமை அலுவலகத்தில் சேமி',
    saved: 'தலைமை அலுவலகத்தில் சேமிக்கப்பட்டது: {scope} {ref} க்கு {price}, {from} முதல். அடுத்த விலை புதுப்பிப்புக்குப் பிறகு, அந்த நாளிலிருந்து பில் இயந்திரங்கள் இதை வசூலிக்கும்.',
    needsSecond: 'இந்த விலைக்கு இரண்டாம் நபர் தேவை. ஏன் என்று எழுதி “அனுமதி கேள்” அழுத்தவும்; விலைகளை அனுமதிக்கக்கூடிய வேறொருவர் தனது அனுமதிகள் பக்கத்தில் அனுமதித்ததும், “அனுமதிக்கப்பட்ட விலையைச் சேமி” அழுத்தவும்.',
    why: 'இது ஏன் தேவை (அனுமதிப்பவர் இதைப் படிப்பார்)', ask: 'அனுமதி கேள்', saveApproved: 'அனுமதிக்கப்பட்ட விலையைச் சேமி',
    summary: '{product} விலையை {scope} {ref} க்கு {price} ஆக்குதல், {from} முதல்',
    zonesH: 'விலை மண்டலங்கள்', zonesLede: 'மண்டலம் என்பது ஒரே மண்டல விலையைப் பகிரும் கடைகளின் குழு. மண்டல விலை நிர்ணயம் இயக்கத்தில் இருக்கும்போது மட்டுமே மண்டல விலைகள் வசூலிக்கப்படும்.',
    noZones: 'இன்னும் எந்தக் கடையும் ஒரு மண்டலத்தில் சேர்க்கப்படவில்லை.', zoneLine: 'மண்டலம் {zone}: {stores}', zoneId: 'மண்டலம்', zoneStore: 'கடை', putInZone: 'இந்தக் கடையை இந்த மண்டலத்தில் சேர்',
    zoneSaved: 'தலைமை அலுவலகத்தில் சேமிக்கப்பட்டது: கடை {store} இப்போது மண்டலம் {zone} இல் உள்ளது.', zonesReadOnly: 'மண்டலங்களை மாற்ற மண்டல மேலாளர் அனுமதி தேவை (உரிமையாளரிடம் உள்ளது).',
    channelH: 'விற்பனை வழி விலைகள் (ஆப், டெலிவரி, மண்டலங்கள்)', channelLede: 'நிறுத்தப்பட்டிருக்கும்போது, பில் இயந்திரம், ஆப், டெலிவரி அனைத்தும் ஒரே அலமாரி விலையை வசூலிக்கும். ஒன்றை இயக்க இரண்டாம் நபரின் அனுமதி தேவை; நிறுத்துவது உடனே நடக்கும்.',
    samePrice: 'எல்லா இடத்திலும் ஒரே விலை: எல்லா சுவிட்சுகளும் நிறுத்தத்தில் உள்ளன.', notSamePrice: 'சில விற்பனை வழி விலைகள் இயக்கத்தில் உள்ளன — கீழே உள்ள வேறுபாடுகளைப் பாருங்கள்.',
    switchOn: 'இயக்கத்தில்', switchOff: 'நிறுத்தத்தில்', subjectZone: 'மண்டல விலைகள்', subjectChannel: '{channel} விற்பனை வழி',
    askOn: 'இயக்க அனுமதி கேள்', turnOff: 'இப்போதே நிறுத்து', switchReason: 'ஏன் (அவசியம்)',
    pendingLine: '{subject}: {who} இயக்கக் கேட்டார் — “{reason}”', approve: 'இயக்க அனுமதி கொடு', yours: 'இதை நீங்கள் கேட்டீர்கள் — இரண்டாம் நபர் அனுமதிக்க வேண்டும்.',
    askedOn: 'கேட்கப்பட்டது. விலைகளை அனுமதிக்கக்கூடிய இரண்டாம் நபர் இயக்க அனுமதிக்க வேண்டும். இன்னும் எதுவும் மாறவில்லை.', turnedOff: 'தலைமை அலுவலகத்தில் நிறுத்தப்பட்டது — மீண்டும் எல்லா இடத்திலும் ஒரே விலை.', approved: 'அனுமதிக்கப்பட்டது: இப்போது இயக்கத்தில் உள்ளது.',
    noPending: 'எந்தக் கோரிக்கையும் காத்திருக்கவில்லை.',
    diffH: 'அலமாரி விலையிலிருந்து வேறுபடும் விலைகள்', diffShow: 'இந்தக் கடையில் உள்ள வேறுபாடுகளைக் காட்டு',
    diffLine: '{product}: {channel} {channelPrice} — அலமாரி {shelfPrice}', dormantLine: '{product}: {ref} க்கான {scope} விலை {price} வைக்கப்பட்டுள்ளது, ஆனால் வசூலிக்கப்படவில்லை (சுவிட்ச் நிறுத்தத்தில்)',
    noDiff: 'இந்தக் கடையில் எந்த விலையும் அலமாரி விலையிலிருந்து வேறுபடவில்லை.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் சேமிக்கப்படவில்லை. இணைப்பு திரும்பியதும் மீண்டும் முயலுங்கள்.',
    unreadable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதையும் படிக்க முடியவில்லை, அதனால் எதுவும் காட்டப்படவில்லை.', notAllowed: 'உங்கள் பங்கால் இதைச் செய்ய முடியாது.',
    needFields: 'பொருள் குறியீடு, யாருக்குப் பொருந்தும், ரூபாயில் விலை, முதல் நாள் ஆகியவற்றைக் கொடுங்கள்.', needReason: 'முதலில் பெட்டியில் ஏன் என்று எழுதுங்கள். எதுவும் அனுப்பப்படவில்லை.',
    noMrp: 'எதுவும் அனுப்பப்படவில்லை — அந்த நாளுக்கு இந்தப் பொருளின் MRP பதிவு செய்யப்படவில்லை, எனவே சட்ட வரம்பைச் சரிபார்க்க முடியாது.',
    noCost: 'எதுவும் அனுப்பப்படவில்லை — இந்தப் பொருளின் அடக்க விலை இந்தத் திரைக்குத் தெரியவில்லை, எனவே லாபத்தைச் சரிபார்க்க முடியாது.',
    noFloor: 'எதுவும் அனுப்பப்படவில்லை — கடையின் குறைந்தபட்ச லாப வரம்பு இந்தத் திரைக்குத் தெரியவில்லை, எனவே லாபத்தைச் சரிபார்க்க முடியாது.',
    rupee: '₹{v}',
  },
};
export const PRICE_LIST_COPY_KEYS: readonly PriceListCopyKey[] = Object.freeze(Object.keys(PRICE_LIST_COPY.en) as PriceListCopyKey[]);

export function priceListWords(lang: Lang): (key: PriceListCopyKey, fill?: Readonly<Record<string, string | number>>) => string {
  const t = translator(PRICE_LIST_COPY, lang);
  return (key, fill) => Object.entries(fill ?? {}).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), t(key));
}

/** Paise as rupees, exactly ("₹45.50"). Pure. */
export const rupeesOf = (minor: number): string => `₹${Math.floor(minor / 100)}.${String(Math.abs(minor) % 100).padStart(2, '0')}`;

/** Typed rupees into exact paise — undefined when not a sum of money. Pure. */
export function paiseOf(v: string): number | undefined {
  const t = v.trim().replace(/[₹,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return undefined;
  const [r, p = ''] = t.split('.');
  return Number(r) * 100 + Number(p.padEnd(2, '0'));
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const scopeWord = (lang: Lang, scope: string): string => {
  const w = priceListWords(lang);
  return scope === 'zone' ? w('nZone') : scope === 'channel' ? w('nChannel') : scope === 'customer' ? w('nCustomer') : w('nStore');
};

/** One history entry in plain words (the day only — an instant is shown as its shop day). Pure but for the zone. */
export function entryWords(lang: Lang, e: PriceListEntryView, timeZone?: string): string {
  const w = priceListWords(lang);
  const day = (v: string): string => (DAY.test(v) ? v : shopDayOf(v, timeZone));
  const to = e.effectiveTo === undefined || e.effectiveTo === null ? w('openEnded') : w('until', { to: day(e.effectiveTo) });
  return `${w('entryLine', { price: rupeesOf(e.price.minor), scope: scopeWord(lang, e.scope), ref: e.scopeRef, from: day(e.effectiveFrom) })}, ${to} · ${w('version', { v: e.version })}${e.status === 'active' ? '' : ` ${w('notActive')}`}`;
}

export function inForceWords(lang: Lang, r: PriceInForce | null, timeZone?: string): string {
  const w = priceListWords(lang);
  if (r === null) return w('noneInForce');
  return w('inForceLine', { price: rupeesOf(r.priceMinor), scope: scopeWord(lang, r.scope), ref: r.scopeRef, from: DAY.test(r.effectiveFrom) ? r.effectiveFrom : shopDayOf(r.effectiveFrom, timeZone) });
}

function shopDayOf(instant: string, timeZone?: string): string {
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) return instant;
  return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone ?? servedShopZone(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

/** Zone memberships grouped by zone ("Zone south: store-2, store-3"). Pure. */
export function zonesOf(stores: readonly ZoneMembershipView[]): readonly { readonly zoneId: string; readonly storeIds: readonly string[] }[] {
  const by = new Map<string, string[]>();
  for (const m of stores) by.set(m.zoneId, [...(by.get(m.zoneId) ?? []), m.storeId]);
  return [...by.entries()].map(([zoneId, storeIds]) => ({ zoneId, storeIds: [...storeIds].sort() })).sort((a, b) => a.zoneId.localeCompare(b.zoneId));
}

export function switchSubjectWords(lang: Lang, subject: string): string {
  const w = priceListWords(lang);
  return subject === 'zone' ? w('subjectZone') : w('subjectChannel', { channel: subject.replace(/^channel:/, '') });
}

/** Any outcome in plain words; `done` is said by the caller (it knows what was done). */
export function priceListOutcomeWords(lang: Lang, o: Outcome<unknown>, doneText = ''): { readonly ok: boolean; readonly text: string } {
  const w = priceListWords(lang);
  switch (o.kind) {
    case 'done': return { ok: true, text: doneText };
    case 'refused': return { ok: false, text: `${w('refused')} ${o.whatHappened}${o.nextSafeAction === '' ? '' : ` ${o.nextSafeAction}`}` };
    case 'not_allowed': return { ok: false, text: w('notAllowed') };
    case 'invalid': return { ok: false, text: o.detail === 'reason' ? w('needReason') : o.detail === 'mrp' ? w('noMrp') : o.detail === 'cost' ? w('noCost') : o.detail === 'floor' ? w('noFloor') : w('needFields') };
    case 'unreachable': return { ok: false, text: w('unreachable') };
  }
}

/** Whether head office's refusal is one a second person's approval of exactly this entry answers. */
export const needsSecondPerson = (o: Outcome<unknown>): boolean => o.kind === 'refused' && (NEEDS_SECOND_PERSON as readonly string[]).includes(o.code);

export interface PriceEntrySaved { readonly entryId: string; readonly productId: string; readonly scope: string; readonly scopeRef: string; readonly priceMinor: number; readonly effectiveFrom: string; readonly version: number; readonly approvedBy: string | null }

export interface PriceListSession {
  readonly may: { readonly read: boolean; readonly set: boolean; readonly zones: boolean; readonly approve: boolean };
  readonly userId: string | null;
  readonly storeId: string | null;
  history(productId: string): Promise<Outcome<{ readonly entries: readonly PriceListEntryView[] }>>;
  inForce(productId: string, at: { readonly on: string; readonly storeId: string; readonly channel?: string; readonly customerId?: string }): Promise<Outcome<PriceInForce | null>>;
  setEntry(input: PriceEntryInput): Promise<Outcome<PriceEntrySaved>>;
  /** The MAKER's step (ADR-0024): ask for exactly the entry that will be sent. Nothing is saved by asking. */
  askEntryApproval(lang: Lang, input: PriceEntryInput, why: string): Promise<ApprovalAskOutcome>;
  /** The entry, naming the caller's own APPROVED request for exactly it. Never a typed approver. */
  saveEntryWithApproval(lang: Lang, input: PriceEntryInput): Promise<ApprovalUseOutcome>;
  zones(): Promise<Outcome<{ readonly stores: readonly ZoneMembershipView[] }>>;
  putStoreInZone(zoneId: string, storeId: string): Promise<Outcome<{ readonly zone: ZoneMembershipView }>>;
  channelPricing(): Promise<Outcome<ChannelPricingView>>;
  askSwitch(subject: string, to: 'on' | 'off', reason: string): Promise<Outcome<{ readonly request: SwitchRequestView }>>;
  approveSwitch(requestId: string, reason: string): Promise<Outcome<{ readonly request: SwitchRequestView }>>;
  differences(storeId: string): Promise<Outcome<ChannelDifferencesView>>;
}

const withoutEntryId = (d: Readonly<Record<string, unknown>>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(d).filter(([k]) => k !== 'entryId'));

const SUBJECT = /^(channel:[a-z0-9_-]{1,40}|zone)$/;
const enc = encodeURIComponent;

export function createPriceListSession(
  viewer: PriceListViewer, http: PriceListHttp, figuresOf: PriceFiguresOf, approvals: PriceListApprovals = {},
  newId: () => string = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
): PriceListSession {
  const held = new Set(viewer.permissions);
  const P = PRICE_LIST_PERMISSIONS;
  const may = Object.freeze({ read: held.has(P.read), set: held.has(P.set), zones: held.has(P.zones), approve: held.has(P.approve) });
  const no = (needs: string): Outcome<never> => ({ kind: 'not_allowed', needs });
  const invalid = (detail = ''): Outcome<never> => ({ kind: 'invalid', detail });
  const zone = viewer.timeZone ?? servedShopZone();

  /** The ONE place an entry's body is built — for the plain send, the send naming an approval, and the approval's details. */
  const bodyOf = (input: PriceEntryInput): { ok: true; productId: string; body: Record<string, unknown> } | { ok: false; detail: string } => {
    const productId = input.productId.trim(); const scopeRef = input.scopeRef.trim();
    const priceMinor = paiseOf(input.price); const from = input.from.trim(); const to = (input.to ?? '').trim();
    if (productId === '' || scopeRef === '' || !(PRICE_SCOPES as readonly string[]).includes(input.scope) || priceMinor === undefined || !DAY.test(from)) return { ok: false, detail: '' };
    if (to !== '' && (!DAY.test(to) || to < from)) return { ok: false, detail: '' };
    const f = figuresOf(productId, from);
    if (!f.ok) return { ok: false, detail: f.missing };
    // The last day is a whole SHOP day: it ends at 23:59:59 in the shop's zone (a bare date would end at its midnight).
    const effectiveTo = to === '' ? undefined : instantOfTyped(`${to}T23:59:59`, zone);
    if (effectiveTo === '') return { ok: false, detail: '' };
    return {
      ok: true, productId,
      body: {
        scope: input.scope, scopeRef, priceMinor, currency: 'INR', mrpMinor: f.mrpMinor, costMinor: f.costMinor, marginFloorBps: f.marginFloorBps,
        effectiveFrom: from, ...(effectiveTo === undefined ? {} : { effectiveTo }),
      },
    };
  };
  const post = async <T>(path: string, body: unknown): Promise<Outcome<T>> => outcomeOf<T>(await http.post(path, body));
  const get = async <T>(path: string): Promise<Outcome<T>> => outcomeOf<T>(await http.get(path));
  const connected = approvals.askApproval !== undefined && approvals.approvalInbox !== undefined;
  /** An entry this screen could not build: nothing was sent, and the reason is the screen's own (never "head office refused"). */
  const notBuilt = (lang: Lang, detail: string): ApprovalAskOutcome & ApprovalUseOutcome =>
    (detail === 'mrp' || detail === 'cost' ? { kind: 'cannot_check', missing: detail } : { kind: 'refused', code: detail === 'floor' ? 'no_margin_floor' : 'not_readable', whatHappened: priceListOutcomeWords(lang, invalid(detail)).text });

  return {
    may,
    userId: viewer.userId ?? null,
    storeId: viewer.storeId ?? null,
    history: async (productId) => {
      if (!may.read) return no(P.read);
      if (productId.trim() === '') return invalid();
      const r = await get<{ entries: readonly PriceListEntryView[] }>(`/v1/prices/list/${enc(productId.trim())}/history`);
      // No list yet is an empty list — said as such, never an error.
      return r.kind === 'refused' && r.status === 404 ? { kind: 'done', status: 200, body: { entries: [] } } : r;
    },
    inForce: async (productId, at) => {
      if (!may.read) return no(P.read);
      if (productId.trim() === '' || !DAY.test(at.on.trim()) || at.storeId.trim() === '') return invalid();
      // Midday of the shop's day: a price starting that day is in force; one starting the next day is not.
      const q = new URLSearchParams({ at: instantOfTyped(`${at.on.trim()}T12:00`, zone), storeId: at.storeId.trim() });
      if (at.channel !== undefined && at.channel.trim() !== '') q.set('channel', at.channel.trim());
      if (at.customerId !== undefined && at.customerId.trim() !== '') q.set('customerId', at.customerId.trim());
      const r = await get<PriceInForce>(`/v1/prices/list/${enc(productId.trim())}/resolve?${q.toString()}`);
      return r.kind === 'refused' && r.status === 404 ? { kind: 'done', status: 200, body: null } : r;
    },
    setEntry: async (input) => {
      if (!may.set) return no(P.set);
      const b = bodyOf(input);
      if (!b.ok) return invalid(b.detail);
      return post<PriceEntrySaved>(`/v1/prices/list/${enc(b.productId)}/entries/${enc(`ple-${newId()}`)}`, b.body);
    },
    askEntryApproval: async (lang, input, why) => {
      if (!may.set || !connected) return { kind: 'not_connected' };
      if (why.trim().length < MIN_REASON_LENGTH) return { kind: 'needs_why' };
      const b = bodyOf(input);
      if (!b.ok) return notBuilt(lang, b.detail);
      const entryId = `ple-${newId()}`;
      const w = priceListWords(lang);
      const asked = await approvals.askApproval!({
        kind: PRICE_LIST_APPROVAL_KIND, subjectRef: `${b.productId}/${entryId}`,
        // EXACTLY the body the entry will send, plus the route's path ids — what head office fingerprints.
        details: detailsOfBody(b.body, { productId: b.productId, entryId }), valueMinor: b.body['priceMinor'] as number,
        summary: w('summary', { product: b.productId, scope: scopeWord(lang, input.scope), ref: b.body['scopeRef'] as string, price: rupeesOf(b.body['priceMinor'] as number), from: b.body['effectiveFrom'] as string }),
        reason: why.trim(),
      });
      if (asked.result === 'asked') return { kind: 'asked', request: asked.request };
      if (asked.result === 'lost_link') return { kind: 'lost_link' };
      return { kind: 'refused', code: asked.code, whatHappened: asked.whatHappened };
    },
    saveEntryWithApproval: async (lang, input) => {
      if (!may.set || !connected) return { kind: 'not_connected' };
      const b = bodyOf(input);
      if (!b.ok) return notBuilt(lang, b.detail);
      const read = await approvals.approvalInbox!();
      if (read.result === 'lost_link') return { kind: 'lost_link' };
      if (read.result === 'refused') return { kind: 'refused', code: read.code, whatHappened: read.whatHappened };
      // Which entry was asked for: the caller's own request for EXACTLY this content (its entry id is part of what was approved).
      const content = detailsOfBody(b.body, { productId: b.productId });
      const forProduct = read.inbox.mine.filter((r) => r.kind === PRICE_LIST_APPROVAL_KIND && r.subjectRef.startsWith(`${b.productId}/`));
      const same = forProduct.filter((r) => sameDetails(withoutEntryId(r.details), content));
      const rank = (s: string): number => (s === 'approved' ? 0 : s === 'waiting' ? 1 : 2);
      const pick = [...same].sort((x, y) => rank(x.status) - rank(y.status) || y.requestedAt.localeCompare(x.requestedAt))[0];
      const ofProduct = [...forProduct].sort((x, y) => y.requestedAt.localeCompare(x.requestedAt))[0];
      const subjectRef = pick?.subjectRef ?? ofProduct?.subjectRef;
      if (subjectRef === undefined) return { kind: 'not_asked' };
      const entryId = subjectRef.slice(b.productId.length + 1);
      const details = detailsOfBody(b.body, { productId: b.productId, entryId });
      const found = await findOwnApproval(async () => read, PRICE_LIST_APPROVAL_KIND, subjectRef, details, b.body['priceMinor'] as number);
      if (!('requestId' in found)) return found;
      const r = await http.post(`/v1/prices/list/${enc(b.productId)}/entries/${enc(entryId)}`, { ...b.body, approvalId: found.requestId });
      const o = outcomeOf<PriceEntrySaved>(r);
      if (o.kind === 'done') return { kind: 'done', verdict: 'approved', approvedBy: o.body.approvedBy ?? found.decidedBy };
      if (o.kind === 'unreachable') return { kind: 'lost_link' };
      if (o.kind === 'refused') return useOutcomeOfRefusal(o.code, o.whatHappened);
      return { kind: 'refused', code: 'refused', whatHappened: '' };
    },
    zones: async () => (may.read ? get('/v1/prices/zones') : no(P.read)),
    putStoreInZone: async (zoneId, storeId) => {
      if (!may.zones) return no(P.zones);
      if (zoneId.trim() === '' || storeId.trim() === '') return invalid();
      return post(`/v1/prices/zones/${enc(zoneId.trim())}/stores/${enc(storeId.trim())}`, {});
    },
    channelPricing: async () => (may.read ? get('/v1/prices/channel-pricing') : no(P.read)),
    askSwitch: async (subject, to, reason) => {
      if (!may.set) return no(P.set);
      if (!SUBJECT.test(subject)) return invalid();
      if (reason.trim() === '') return invalid('reason');
      return post(`/v1/prices/channel-pricing/requests/${enc(`switch-${newId()}`)}`, { subject, to, reason: reason.trim() });
    },
    approveSwitch: async (requestId, reason) => {
      if (!may.approve) return no(P.approve);
      if (reason.trim() === '') return invalid('reason');
      return post(`/v1/prices/channel-pricing/requests/${enc(requestId)}/approve`, { reason: reason.trim() });
    },
    differences: async (storeId) => {
      if (!may.read) return no(P.read);
      if (storeId.trim() === '') return invalid();
      return get(`/v1/prices/channel-differences?storeId=${enc(storeId.trim())}`);
    },
  };
}
