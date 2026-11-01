// PRODUCT SETUP — the tab on the Products and prices page where the product people set up what the product master holds
// beyond one item's own card (M03-FR-01 · M03-FR-02 · M03-FR-04 · WF-01 · audit G-1 · P-04 · P-07 · P-08):
//
//   • CATEGORIES (M03-FR-01, OB-24 "A") — head office's own list (`GET /v1/catalogue/categories`) and adding or changing one
//     (`POST /v1/catalogue/categories/:categoryId`). The owner (`catalogue.category.approve`) saves directly — their act IS
//     the approval. A manager (`catalogue.category.propose` only) first ASKS the owner for exactly this definition
//     (`POST /v1/approvals/requests`, kind `category_define`), the owner decides it on the Approvals page in their own
//     session, and the manager then saves it naming that approval. The screen never offers a shortcut around that.
//   • THE VARIANT REPORT (M03-FR-01) — `GET /v1/catalogue/reports/variants?categoryId=`: each variant under its parent, with
//     the brand, the manufacturer ("not recorded" when nobody said) and a count per manufacturer.
//   • A BUNDLE (M03-FR-02, OB-306) — what one own-barcode bundle holds (`POST /v1/catalogue/bundles/:bundleProductId`).
//   • PACK SIZES (M03-FR-02) — a product's pack hierarchy (`POST /v1/catalogue/products/:productId/pack`); an inexact pack is
//     refused by head office and its refusal is shown in its own words.
//   • APPROVED SUBSTITUTES (M03-FR-04) — `POST /v1/catalogue/products/:productId/substitutes`, in the order to try them.
//   • MERGING A DUPLICATE (M03-FR-04, §28) — one person PROPOSES (`POST /v1/catalogue/merges/:mergeId`), a DIFFERENT person
//     approves or rejects (`POST /v1/catalogue/merges/:mergeId/decision`). The screen never offers the proposer an approve
//     button on their own proposal, and head office refuses it anyway.
//
// A THIN client: every rule is head office's, every refusal is shown in head office's own words, and when head office cannot
// be reached the panel says nothing was saved — never a success it did not get. Each action is offered only to a viewer who
// holds the permission the route itself checks.

import { translator, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { outcomeOf, type HttpAnswer, type Outcome } from './finance-close-session';

export interface ProductSetupHttp {
  get(path: string): Promise<HttpAnswer>;
  post(path: string, body: unknown): Promise<HttpAnswer>;
}

/** The route permissions — the same codes head office checks. */
export const PRODUCT_SETUP_PERMISSIONS = Object.freeze({
  read: 'catalogue.pack.read',
  publish: 'catalogue.pack.publish',
  categoryPropose: 'catalogue.category.propose',
  categoryApprove: 'catalogue.category.approve',
  mergePropose: 'catalogue.merge.propose',
  mergeApprove: 'catalogue.merge.approve',
});

/** The regulated kinds head office knows for a category (services/catalogue/src/categories.ts REGULATED_KINDS). */
export const CATEGORY_REGULATED_KINDS = Object.freeze(['food', 'packed', 'weighed', 'age_restricted', 'drug', 'hazardous', 'bis_controlled', 'liquor'] as const);
export const CATEGORY_ATTRIBUTE_TYPES = Object.freeze(['text', 'number', 'boolean', 'enum', 'date'] as const);

// ── Head office's answers, as the routes give them ───────────────────────────────────────────────────────────────

export interface CategoryAttribute { readonly key: string; readonly label: string; readonly type: string }
/** A category exactly as head office judges it (the engine shape — what an approval is asked for). */
export interface CategoryDefinition {
  readonly categoryId: string; readonly name: string; readonly parentId: string | null;
  readonly regulated?: readonly string[]; readonly attributes?: readonly CategoryAttribute[];
}
export interface StoredCategoryView extends CategoryDefinition {
  readonly version: number; readonly definedBy: string; readonly approvedBy: string; readonly definedAt: string; readonly source: string;
}
export interface CategoryList { readonly categories: readonly StoredCategoryView[]; readonly count: number }
/** One of MY category requests on head office's approval engine. */
export interface AskedCategory {
  readonly requestId: string; readonly subjectRef: string; readonly status: string;
  readonly details: CategoryDefinition; readonly decidedBy?: string; readonly decisionReason?: string;
}

export interface VariantReport {
  readonly families: readonly {
    readonly productId: string; readonly sku: string; readonly name: string; readonly brand: string | null; readonly manufacturer: string | null;
    readonly variantCount: number;
    readonly variants: readonly { readonly productId: string; readonly name: string; readonly attributes: Readonly<Record<string, string>> }[];
  }[];
  readonly familyCount: number; readonly productCount: number;
  readonly byManufacturer: readonly { readonly manufacturer: string; readonly recorded: boolean; readonly families: number; readonly products: number }[];
  readonly categoryId: string | null;
}

export interface BundleComponentView { readonly productId: string; readonly quantityMinor: number }
export interface BundleView { readonly bundleProductId: string; readonly version: number; readonly components: readonly BundleComponentView[]; readonly reason: string; readonly definedBy: string; readonly definedAt: string }
export interface PackLevelView { readonly level: string; readonly containsMinor: number; readonly barcode?: string }
export interface PackView { readonly productId: string; readonly baseUom: string; readonly levels: readonly PackLevelView[] }
export interface SubstituteListView { readonly productId: string; readonly version: number; readonly substitutes: readonly string[]; readonly reason: string; readonly setBy: string; readonly setAt: string }

export type MergeStatus = 'pending' | 'approved' | 'rejected' | 'reversed';
export interface MergeRow {
  readonly request: { readonly mergeId: string; readonly keepProductId: string; readonly supersedeProductId: string; readonly requestedBy: string; readonly reason: string };
  readonly status: MergeStatus; readonly decidedBy?: string; readonly decidedAt?: string;
}
export interface MergeList { readonly merges: readonly MergeRow[]; readonly count: number; readonly pendingCount: number }

// ── What the person types ────────────────────────────────────────────────────────────────────────────────────────

export interface CategoryInput {
  readonly categoryId: string; readonly name: string; readonly parentId: string;
  readonly regulated: readonly string[];
  /** One attribute a line: "key, label, type" (type one of CATEGORY_ATTRIBUTE_TYPES). */
  readonly attributes: string;
}

/**
 * The category exactly as head office will read it (trimmed; regulated de-duplicated and sorted; no parent → null) — the
 * same shape an approval is asked for, so the owner approves precisely what is later saved. Undefined when a needed field
 * is blank or an attribute line cannot be read. Pure.
 */
export function categoryFromInput(input: CategoryInput): CategoryDefinition | undefined {
  const categoryId = input.categoryId.trim();
  const name = input.name.trim();
  if (categoryId === '' || name === '') return undefined;
  const parent = input.parentId.trim();
  const regulated = [...new Set(input.regulated.map((r) => r.trim()).filter((r) => r !== ''))].sort();
  if (regulated.some((r) => !(CATEGORY_REGULATED_KINDS as readonly string[]).includes(r))) return undefined;
  const lines = input.attributes.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  const attributes: CategoryAttribute[] = [];
  for (const line of lines) {
    const [key = '', label = '', type = ''] = line.split(',').map((s) => s.trim());
    if (key === '' || label === '' || !(CATEGORY_ATTRIBUTE_TYPES as readonly string[]).includes(type)) return undefined;
    attributes.push({ key, label, type });
  }
  return {
    categoryId, name, parentId: parent === '' ? null : parent,
    ...(regulated.length === 0 ? {} : { regulated }),
    ...(attributes.length === 0 ? {} : { attributes }),
  };
}

/** Bundle components typed one a line, "productId quantity" (quantity in the component's base unit). Pure. */
export function componentsFromInput(text: string): readonly BundleComponentView[] | undefined {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  if (lines.length === 0) return undefined;
  const out: BundleComponentView[] = [];
  for (const line of lines) {
    const m = /^(\S+)\s+(\d+)$/.exec(line);
    if (m === null) return undefined;
    out.push({ productId: m[1]!, quantityMinor: Number(m[2]) });
  }
  return out;
}

/**
 * Pack levels typed one a line, smallest first, "level count" — how many of the level below one of these holds. The count
 * is passed as the person typed it (a decimal too): EXACTNESS is head office's to judge, and its refusal is shown. Pure.
 */
export function packLevelsFromInput(text: string): readonly PackLevelView[] | undefined {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  if (lines.length === 0) return undefined;
  const out: PackLevelView[] = [];
  for (const line of lines) {
    const m = /^(.+?)\s+(\d+(?:\.\d+)?)$/.exec(line);
    if (m === null) return undefined;
    out.push({ level: m[1]!.trim(), containsMinor: Number(m[2]) });
  }
  return out;
}

/** Substitute product ids typed in order, one a line or comma-separated. An empty list is a decision (it clears). Pure. */
export function substitutesFromInput(text: string): readonly string[] {
  return text.split(/[\n,]/).map((s) => s.trim()).filter((s) => s !== '');
}

// ── Words ────────────────────────────────────────────────────────────────────────────────────────────────────────

export type ProductSetupCopyKey =
  | 'tab' | 'h' | 'lede' | 'productId'
  | 'catH' | 'catLede' | 'catNone' | 'catId' | 'catName' | 'catParent' | 'catRegulated' | 'catAttributes' | 'catSave' | 'catAsk' | 'catAskReason'
  | 'catSaved' | 'catUnchanged' | 'catAsked' | 'catNeedApproval' | 'catMine' | 'catUseApproval' | 'catWaiting' | 'catApproved' | 'catRejected' | 'catUsed' | 'catExpired'
  | 'catLine' | 'catBy' | 'catProposeOnly'
  | 'food' | 'packed' | 'weighed' | 'age_restricted' | 'drug' | 'hazardous' | 'bis_controlled' | 'liquor'
  | 'repH' | 'repCategory' | 'repShow' | 'repTotals' | 'repFamily' | 'repNoVariants' | 'repMaker' | 'repEmpty'
  | 'bunH' | 'bunLede' | 'bunProduct' | 'bunComponents' | 'bunReason' | 'bunSave' | 'bunRead' | 'bunSaved' | 'bunUnchanged' | 'bunNone' | 'bunLine'
  | 'packH' | 'packLede' | 'packProduct' | 'packBase' | 'packLevels' | 'packSave' | 'packRead' | 'packSaved' | 'packNone' | 'packLine'
  | 'subH' | 'subLede' | 'subProduct' | 'subList' | 'subReason' | 'subSave' | 'subRead' | 'subSaved' | 'subUnchanged' | 'subCleared' | 'subNone' | 'subNotSet' | 'subLine'
  | 'mrgH' | 'mrgLede' | 'mrgKeep' | 'mrgSupersede' | 'mrgReason' | 'mrgPropose' | 'mrgProposed' | 'mrgNone' | 'mrgApprove' | 'mrgReject'
  | 'mrgApproved' | 'mrgRejected' | 'mrgOwn' | 'mrgLine' | 'mrgPending' | 'mrgDone' | 'mrgReversed' | 'mrgRejectedState'
  | 'refused' | 'unreachable' | 'unreadable' | 'notAllowed' | 'cannotRead' | 'needFields' | 'needReason' | 'notConnected' | 'readOnly' | 'warning';

export const PRODUCT_SETUP_COPY: BilingualCopy<ProductSetupCopyKey> = {
  en: {
    tab: 'Product setup', h: 'Product setup',
    lede: 'The parts of the product list kept at head office: categories, the variant report, bundles, pack sizes, approved substitutes and merging a duplicate.',
    productId: 'Item code',
    catH: 'Categories', catLede: 'Head office’s one list of categories. The owner adds or changes a category; a manager asks the owner first.',
    catNone: 'No category is on head office’s list yet.', catId: 'Category code', catName: 'Name', catParent: 'Sits under (category code, blank for top level)',
    catRegulated: 'Rules that apply to everything in it', catAttributes: 'Details each item in it carries (one a line: key, label, type)',
    catSave: 'Save this category at head office', catAsk: 'Ask the owner to approve this category', catAskReason: 'Why this category is needed',
    catSaved: 'Saved at head office.', catUnchanged: 'Already on the list exactly so — nothing new was saved.',
    catAsked: 'Asked. The owner decides it on the Approvals page; once approved, save it here with that approval.',
    catNeedApproval: 'A new category is approved by the owner. Ask for approval first; nothing was saved.',
    catMine: 'Categories I asked for', catUseApproval: 'Save it with this approval', catWaiting: 'waiting for the owner', catApproved: 'approved',
    catRejected: 'rejected', catUsed: 'already saved', catExpired: 'approval ran out',
    catLine: '{id} — {name} (under {parent})', catBy: 'version {version}, saved by {by}, approved by {approver}',
    catProposeOnly: 'You can ask the owner for a new category; the owner’s approval is needed before it is saved.',
    food: 'food', packed: 'packed goods', weighed: 'sold by weight', age_restricted: 'age limit', drug: 'medicine', hazardous: 'hazardous', bis_controlled: 'BIS mark needed', liquor: 'liquor (never sold)',
    repH: 'Variant report', repCategory: 'Category (blank for every item)', repShow: 'Show the report',
    repTotals: '{families} families, {products} items', repFamily: '{name} — {brand}, made by {maker}', repNoVariants: 'no variants',
    repMaker: '{maker}: {families} families, {products} items', repEmpty: 'No item is in this category.',
    bunH: 'Bundle', bunLede: 'What one own-barcode bundle holds. Selling one takes stock off each part.',
    bunProduct: 'Bundle item code', bunComponents: 'Parts (one a line: item code and how many, in pieces, grams or millilitres)', bunReason: 'Why',
    bunSave: 'Save this bundle at head office', bunRead: 'Show this bundle', bunSaved: 'Saved at head office as a new version.',
    bunUnchanged: 'Already set exactly so — nothing new was saved.', bunNone: 'No bundle is defined for this item.', bunLine: 'Version {version}: {parts}',
    packH: 'Pack sizes', packLede: 'How a case becomes singles. A pack must hold a whole number of the size below, or head office refuses it.',
    packProduct: 'Item code', packBase: 'Smallest unit (for example each)', packLevels: 'Sizes, smallest first (one a line: name and how many of the size below)',
    packSave: 'Save these pack sizes at head office', packRead: 'Show the pack sizes', packSaved: 'Saved at head office.', packNone: 'No pack sizes are set for this item.',
    packLine: '{level}: holds {count} of the size below',
    subH: 'Approved substitutes', subLede: 'What may be offered when this item is out of stock, in the order to try. The customer still chooses.',
    subProduct: 'Item code', subList: 'Substitutes in order (item codes, one a line)', subReason: 'Why',
    subSave: 'Save the substitutes at head office', subRead: 'Show the substitutes', subSaved: 'Saved at head office as a new version.',
    subUnchanged: 'Already set exactly so — nothing new was saved.', subCleared: 'Saved at head office: this item now has no substitutes.',
    subNone: 'Set to none.', subNotSet: 'No substitutes have been set for this item.', subLine: 'Version {version}: {list}',
    mrgH: 'Merge a duplicate', mrgLede: 'Two records for one product. One person proposes the merge; a different person approves it. The old record keeps its history.',
    mrgKeep: 'Item code to keep', mrgSupersede: 'Duplicate item code', mrgReason: 'Why they are the same product',
    mrgPropose: 'Propose this merge', mrgProposed: 'Proposed. A different person must approve it.', mrgNone: 'No merge has been proposed.',
    mrgApprove: 'Approve merge', mrgReject: 'Reject merge', mrgApproved: 'Approved at head office. The duplicate now points to the kept item.',
    mrgRejected: 'Rejected at head office. Nothing was merged.', mrgOwn: 'You proposed this merge — a different person must decide it.',
    mrgLine: 'Keep {keep}, merge {supersede} into it — proposed by {by}: {reason}', mrgPending: 'waiting for a second person', mrgDone: 'approved by {by}',
    mrgReversed: 'reversed', mrgRejectedState: 'rejected by {by}',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was saved. Try again when the connection is back.',
    unreadable: 'Head office cannot be reached — this could not be read, so nothing is shown.',
    notAllowed: 'Your role cannot do this.', cannotRead: 'Your role cannot read the product setup.',
    needFields: 'Fill in every box in the form shown, then press the button again. Nothing was sent.',
    needReason: 'Write why, then press the button again. Nothing was sent.',
    notConnected: 'Product setup is kept at head office. Open Products and prices from head office to see or change it.',
    readOnly: 'You can read the product setup; changing it needs the product role.', warning: 'Head office notes:',
  },
  ta: {
    tab: 'பொருள் அமைப்பு', h: 'பொருள் அமைப்பு',
    lede: 'தலைமை அலுவலகத்தில் வைக்கப்படும் பொருள் பட்டியலின் பகுதிகள்: வகைகள், வகை மாறுபாடு அறிக்கை, தொகுப்புகள், பேக் அளவுகள், அனுமதிக்கப்பட்ட மாற்றுப் பொருட்கள், இரட்டைப் பதிவை இணைத்தல்.',
    productId: 'பொருள் குறியீடு',
    catH: 'வகைகள்', catLede: 'தலைமை அலுவலகத்தின் ஒரே வகைப் பட்டியல். உரிமையாளர் வகையைச் சேர்க்கிறார் அல்லது மாற்றுகிறார்; மேலாளர் முதலில் உரிமையாளரிடம் கேட்கிறார்.',
    catNone: 'தலைமை அலுவலகப் பட்டியலில் இன்னும் எந்த வகையும் இல்லை.', catId: 'வகைக் குறியீடு', catName: 'பெயர்', catParent: 'இதன் கீழ் உள்ளது (வகைக் குறியீடு; மேல் நிலைக்கு காலியாக விடவும்)',
    catRegulated: 'இதிலுள்ள அனைத்துக்கும் பொருந்தும் விதிகள்', catAttributes: 'இதிலுள்ள ஒவ்வொரு பொருளும் கொண்டிருக்கும் விவரங்கள் (ஒரு வரிக்கு ஒன்று: குறியீடு, பெயர், வகை)',
    catSave: 'இந்த வகையைத் தலைமை அலுவலகத்தில் சேமி', catAsk: 'இந்த வகைக்கு உரிமையாளரின் அனுமதி கேள்', catAskReason: 'இந்த வகை ஏன் தேவை',
    catSaved: 'தலைமை அலுவலகத்தில் சேமிக்கப்பட்டது.', catUnchanged: 'ஏற்கனவே பட்டியலில் இப்படியே உள்ளது — புதிதாக எதுவும் சேமிக்கப்படவில்லை.',
    catAsked: 'கேட்கப்பட்டது. உரிமையாளர் அனுமதிகள் திரையில் முடிவு செய்வார்; அனுமதி கிடைத்ததும் அதனுடன் இங்கே சேமிக்கவும்.',
    catNeedApproval: 'புதிய வகைக்கு உரிமையாளரின் அனுமதி தேவை. முதலில் அனுமதி கேளுங்கள்; எதுவும் சேமிக்கப்படவில்லை.',
    catMine: 'நான் கேட்ட வகைகள்', catUseApproval: 'இந்த அனுமதியுடன் சேமி', catWaiting: 'உரிமையாளருக்காகக் காத்திருக்கிறது', catApproved: 'அனுமதிக்கப்பட்டது',
    catRejected: 'மறுக்கப்பட்டது', catUsed: 'ஏற்கனவே சேமிக்கப்பட்டது', catExpired: 'அனுமதி காலாவதியானது',
    catLine: '{id} — {name} ({parent} இன் கீழ்)', catBy: 'பதிப்பு {version}, {by} சேமித்தார், {approver} அனுமதித்தார்',
    catProposeOnly: 'புதிய வகைக்கு நீங்கள் உரிமையாளரிடம் கேட்கலாம்; சேமிக்கும் முன் உரிமையாளரின் அனுமதி தேவை.',
    food: 'உணவு', packed: 'பேக் செய்த பொருட்கள்', weighed: 'எடைக்கு விற்பது', age_restricted: 'வயது வரம்பு', drug: 'மருந்து', hazardous: 'அபாயகரமானது', bis_controlled: 'BIS முத்திரை தேவை', liquor: 'மது (ஒருபோதும் விற்கப்படாது)',
    repH: 'வகை மாறுபாடு அறிக்கை', repCategory: 'வகை (எல்லாப் பொருட்களுக்கும் காலியாக விடவும்)', repShow: 'அறிக்கையைக் காட்டு',
    repTotals: '{families} குடும்பங்கள், {products} பொருட்கள்', repFamily: '{name} — {brand}, தயாரிப்பாளர் {maker}', repNoVariants: 'மாறுபாடுகள் இல்லை',
    repMaker: '{maker}: {families} குடும்பங்கள், {products} பொருட்கள்', repEmpty: 'இந்த வகையில் எந்தப் பொருளும் இல்லை.',
    bunH: 'தொகுப்பு', bunLede: 'சொந்த பார்கோடு கொண்ட ஒரு தொகுப்பில் என்ன உள்ளது. ஒன்றை விற்றால் ஒவ்வொரு பகுதியின் இருப்பும் குறையும்.',
    bunProduct: 'தொகுப்பின் பொருள் குறியீடு', bunComponents: 'பகுதிகள் (ஒரு வரிக்கு ஒன்று: பொருள் குறியீடும் எண்ணிக்கையும், துண்டு, கிராம் அல்லது மில்லிலிட்டரில்)', bunReason: 'ஏன்',
    bunSave: 'இந்தத் தொகுப்பைத் தலைமை அலுவலகத்தில் சேமி', bunRead: 'இந்தத் தொகுப்பைக் காட்டு', bunSaved: 'புதிய பதிப்பாகத் தலைமை அலுவலகத்தில் சேமிக்கப்பட்டது.',
    bunUnchanged: 'ஏற்கனவே இப்படியே அமைக்கப்பட்டுள்ளது — புதிதாக எதுவும் சேமிக்கப்படவில்லை.', bunNone: 'இந்தப் பொருளுக்கு எந்தத் தொகுப்பும் வரையறுக்கப்படவில்லை.', bunLine: 'பதிப்பு {version}: {parts}',
    packH: 'பேக் அளவுகள்', packLede: 'ஒரு பெட்டி எப்படித் தனிப் பொருட்களாகிறது. ஒரு பேக் கீழ் அளவின் முழு எண்ணிக்கையைக் கொண்டிருக்க வேண்டும், இல்லையெனில் தலைமை அலுவலகம் மறுக்கும்.',
    packProduct: 'பொருள் குறியீடு', packBase: 'மிகச் சிறிய அலகு (உதாரணமாக ஒன்று)', packLevels: 'அளவுகள், சிறியது முதலில் (ஒரு வரிக்கு ஒன்று: பெயரும் கீழ் அளவின் எண்ணிக்கையும்)',
    packSave: 'இந்தப் பேக் அளவுகளைத் தலைமை அலுவலகத்தில் சேமி', packRead: 'பேக் அளவுகளைக் காட்டு', packSaved: 'தலைமை அலுவலகத்தில் சேமிக்கப்பட்டது.', packNone: 'இந்தப் பொருளுக்கு பேக் அளவுகள் அமைக்கப்படவில்லை.',
    packLine: '{level}: கீழ் அளவில் {count} கொண்டது',
    subH: 'அனுமதிக்கப்பட்ட மாற்றுப் பொருட்கள்', subLede: 'இந்தப் பொருள் இருப்பில் இல்லாதபோது வழங்கக்கூடியவை, முயல வேண்டிய வரிசையில். வாடிக்கையாளரே தேர்வு செய்வார்.',
    subProduct: 'பொருள் குறியீடு', subList: 'வரிசைப்படி மாற்றுப் பொருட்கள் (பொருள் குறியீடுகள், ஒரு வரிக்கு ஒன்று)', subReason: 'ஏன்',
    subSave: 'மாற்றுப் பொருட்களைத் தலைமை அலுவலகத்தில் சேமி', subRead: 'மாற்றுப் பொருட்களைக் காட்டு', subSaved: 'புதிய பதிப்பாகத் தலைமை அலுவலகத்தில் சேமிக்கப்பட்டது.',
    subUnchanged: 'ஏற்கனவே இப்படியே அமைக்கப்பட்டுள்ளது — புதிதாக எதுவும் சேமிக்கப்படவில்லை.', subCleared: 'தலைமை அலுவலகத்தில் சேமிக்கப்பட்டது: இந்தப் பொருளுக்கு இப்போது மாற்றுப் பொருள் இல்லை.',
    subNone: 'எதுவுமில்லை என அமைக்கப்பட்டது.', subNotSet: 'இந்தப் பொருளுக்கு மாற்றுப் பொருட்கள் அமைக்கப்படவில்லை.', subLine: 'பதிப்பு {version}: {list}',
    mrgH: 'இரட்டைப் பதிவை இணை', mrgLede: 'ஒரே பொருளுக்கு இரண்டு பதிவுகள். ஒருவர் இணைப்பை முன்மொழிகிறார்; வேறொருவர் அனுமதிக்கிறார். பழைய பதிவு அதன் வரலாற்றை வைத்திருக்கும்.',
    mrgKeep: 'வைத்திருக்க வேண்டிய பொருள் குறியீடு', mrgSupersede: 'இரட்டைப் பொருள் குறியீடு', mrgReason: 'இவை ஏன் ஒரே பொருள்',
    mrgPropose: 'இந்த இணைப்பை முன்மொழி', mrgProposed: 'முன்மொழியப்பட்டது. வேறொருவர் அனுமதிக்க வேண்டும்.', mrgNone: 'எந்த இணைப்பும் முன்மொழியப்படவில்லை.',
    mrgApprove: 'இணைப்பை அனுமதி', mrgReject: 'இணைப்பை மறு', mrgApproved: 'தலைமை அலுவலகத்தில் அனுமதிக்கப்பட்டது. இரட்டைப் பதிவு இப்போது வைத்திருக்கும் பொருளைக் குறிக்கிறது.',
    mrgRejected: 'தலைமை அலுவலகத்தில் மறுக்கப்பட்டது. எதுவும் இணைக்கப்படவில்லை.', mrgOwn: 'இந்த இணைப்பை நீங்கள் முன்மொழிந்தீர்கள் — வேறொருவர் முடிவு செய்ய வேண்டும்.',
    mrgLine: '{keep} ஐ வைத்து, {supersede} ஐ அதனுடன் இணை — {by} முன்மொழிந்தார்: {reason}', mrgPending: 'இரண்டாவது நபருக்காகக் காத்திருக்கிறது', mrgDone: '{by} அனுமதித்தார்',
    mrgReversed: 'திரும்பப் பெறப்பட்டது', mrgRejectedState: '{by} மறுத்தார்',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் சேமிக்கப்படவில்லை. இணைப்பு திரும்பியதும் மீண்டும் முயலுங்கள்.',
    unreadable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — இதைப் படிக்க முடியவில்லை, அதனால் எதுவும் காட்டப்படவில்லை.',
    notAllowed: 'உங்கள் பங்கால் இதைச் செய்ய முடியாது.', cannotRead: 'உங்கள் பங்கால் பொருள் அமைப்பைப் படிக்க முடியாது.',
    needFields: 'காட்டப்பட்ட படிவத்தின் ஒவ்வொரு பெட்டியையும் நிரப்பி, பொத்தானை மீண்டும் அழுத்துங்கள். எதுவும் அனுப்பப்படவில்லை.',
    needReason: 'ஏன் என்று எழுதி, பொத்தானை மீண்டும் அழுத்துங்கள். எதுவும் அனுப்பப்படவில்லை.',
    notConnected: 'பொருள் அமைப்பு தலைமை அலுவலகத்தில் வைக்கப்படுகிறது. அதைப் பார்க்க அல்லது மாற்ற, தலைமை அலுவலகத்திலிருந்து பொருட்களும் விலைகளும் திரையைத் திறக்கவும்.',
    readOnly: 'நீங்கள் பொருள் அமைப்பைப் படிக்கலாம்; மாற்றுவதற்குப் பொருள் பங்கு தேவை.', warning: 'தலைமை அலுவலகக் குறிப்பு:',
  },
};
export const PRODUCT_SETUP_COPY_KEYS: readonly ProductSetupCopyKey[] = Object.freeze(Object.keys(PRODUCT_SETUP_COPY.en) as ProductSetupCopyKey[]);

export function productSetupWords(lang: Lang): (key: ProductSetupCopyKey, fill?: Readonly<Record<string, string | number>>) => string {
  const t = translator(PRODUCT_SETUP_COPY, lang);
  return (key, fill) => Object.entries(fill ?? {}).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), t(key));
}

/** What a done/refused/unreachable answer says — `doneKey` for a success, head office's own words for a refusal. Pure. */
export function setupOutcomeWords(lang: Lang, o: Outcome<unknown>, doneKey: ProductSetupCopyKey): { readonly ok: boolean; readonly text: string } {
  const w = productSetupWords(lang);
  switch (o.kind) {
    case 'done': return { ok: true, text: w(doneKey) };
    case 'refused': return { ok: false, text: `${w('refused')} ${o.whatHappened}${o.nextSafeAction === '' ? '' : ` ${o.nextSafeAction}`}` };
    case 'not_allowed': return { ok: false, text: w('notAllowed') };
    case 'invalid': return { ok: false, text: o.detail === 'reason' ? w('needReason') : o.detail === 'approval' ? w('catNeedApproval') : o.detail === 'own' ? w('mrgOwn') : w('needFields') };
    case 'unreachable': return { ok: false, text: w('unreachable') };
  }
}

/** A merge in plain words, with where it stands. Pure. */
export function describeMerge(lang: Lang, m: MergeRow): string {
  const w = productSetupWords(lang);
  const state = m.status === 'pending' ? w('mrgPending') : m.status === 'approved' ? w('mrgDone', { by: m.decidedBy ?? '' })
    : m.status === 'rejected' ? w('mrgRejectedState', { by: m.decidedBy ?? '' }) : w('mrgReversed');
  return `${w('mrgLine', { keep: m.request.keepProductId, supersede: m.request.supersedeProductId, by: m.request.requestedBy, reason: m.request.reason })} · ${state}`;
}

/** Where one of my category requests stands, in words. Pure. */
export function askedStatusWords(lang: Lang, status: string): string {
  const w = productSetupWords(lang);
  return status === 'waiting' ? w('catWaiting') : status === 'approved' ? w('catApproved') : status === 'rejected' ? w('catRejected')
    : status === 'used' ? w('catUsed') : status === 'expired' ? w('catExpired') : status;
}

// ── The session ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface ProductSetupViewer { readonly userId?: string; readonly permissions: readonly string[] }

export interface ProductSetupSession {
  readonly may: {
    readonly read: boolean; readonly publish: boolean;
    readonly categoryPropose: boolean; readonly categoryApprove: boolean;
    readonly mergePropose: boolean; readonly mergeApprove: boolean;
  };
  readonly userId: string | undefined;
  categories(): Promise<Outcome<CategoryList>>;
  /** The owner saves directly; a manager names the approval the owner gave for exactly this definition. */
  defineCategory(input: CategoryInput, approvalId?: string): Promise<Outcome<{ readonly category: StoredCategoryView; readonly changed: boolean }>>;
  /** A manager asks the owner (kind category_define) for exactly this definition. */
  askCategory(input: CategoryInput, reason: string): Promise<Outcome<{ readonly requestId: string; readonly status: string }>>;
  /** My category_define requests and where each stands. */
  askedCategories(): Promise<Outcome<readonly AskedCategory[]>>;
  /** Save a category the owner approved, exactly as approved. */
  saveApprovedCategory(asked: AskedCategory): Promise<Outcome<{ readonly category: StoredCategoryView; readonly changed: boolean }>>;
  variantReport(categoryId: string): Promise<Outcome<VariantReport>>;
  bundle(bundleProductId: string): Promise<Outcome<{ readonly bundle: BundleView; readonly history: readonly BundleView[] }>>;
  defineBundle(bundleProductId: string, components: string, reason: string): Promise<Outcome<{ readonly bundle: BundleView; readonly unchanged?: boolean }>>;
  pack(productId: string): Promise<Outcome<{ readonly pack: PackView }>>;
  definePack(productId: string, baseUom: string, levels: string): Promise<Outcome<{ readonly pack: PackView }>>;
  substitutes(productId: string): Promise<Outcome<{ readonly productId: string; readonly list: SubstituteListView | null; readonly set: boolean }>>;
  setSubstitutes(productId: string, list: string, reason: string): Promise<Outcome<{ readonly list: SubstituteListView; readonly unchanged?: boolean; readonly warnings?: readonly { readonly detail?: string }[] }>>;
  merges(): Promise<Outcome<MergeList>>;
  proposeMerge(input: { readonly keepProductId: string; readonly supersedeProductId: string; readonly reason: string }): Promise<Outcome<{ readonly merge: MergeRow }>>;
  /** An approval is refused here, with no POST, when the viewer proposed it (§28) — head office refuses it too. */
  decideMerge(row: MergeRow, decision: 'approved' | 'rejected'): Promise<Outcome<{ readonly merge: MergeRow }>>;
}

const enc = encodeURIComponent;

export function createProductSetupSession(viewer: ProductSetupViewer, http: ProductSetupHttp, newId: () => string = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}`): ProductSetupSession {
  const held = new Set(viewer.permissions);
  const P = PRODUCT_SETUP_PERMISSIONS;
  const may = Object.freeze({
    read: held.has(P.read), publish: held.has(P.publish),
    categoryPropose: held.has(P.categoryPropose), categoryApprove: held.has(P.categoryApprove),
    mergePropose: held.has(P.mergePropose), mergeApprove: held.has(P.mergeApprove),
  });
  const notAllowed = (needs: string): Outcome<never> => ({ kind: 'not_allowed', needs });
  const invalid = (detail = ''): Outcome<never> => ({ kind: 'invalid', detail });
  const id = (s: string): string => s.trim();
  const userId = viewer.userId === undefined || viewer.userId.trim() === '' ? undefined : viewer.userId.trim();
  const postCategory = async (c: CategoryDefinition, approvalId?: string) => {
    const { categoryId, ...rest } = c;
    return outcomeOf<{ category: StoredCategoryView; changed: boolean }>(await http.post(`/v1/catalogue/categories/${enc(categoryId)}`, { ...rest, ...(approvalId === undefined ? {} : { approvalId }) }));
  };
  return {
    may, userId,
    categories: async () => {
      if (!may.read) return notAllowed(P.read);
      return outcomeOf<CategoryList>(await http.get('/v1/catalogue/categories'));
    },
    defineCategory: async (input, approvalId) => {
      if (!may.categoryPropose) return notAllowed(P.categoryPropose);
      const c = categoryFromInput(input);
      if (c === undefined) return invalid();
      // The owner's act is the approval; anyone else names the owner's approval of exactly this definition.
      if (!may.categoryApprove && (approvalId === undefined || approvalId.trim() === '')) return invalid('approval');
      return postCategory(c, may.categoryApprove ? undefined : approvalId!.trim());
    },
    askCategory: async (input, reason) => {
      if (!may.categoryPropose) return notAllowed(P.categoryPropose);
      const c = categoryFromInput(input);
      if (c === undefined) return invalid();
      if (reason.trim() === '') return invalid('reason');
      return outcomeOf(await http.post('/v1/approvals/requests', {
        kind: 'category_define', subjectRef: c.categoryId, details: c, valueMinor: null,
        summary: `Add or change the product category ${c.categoryId} (${c.name})`, reason: reason.trim(),
      }));
    },
    askedCategories: async () => {
      if (!may.categoryPropose) return notAllowed(P.categoryPropose);
      const r = outcomeOf<{ mine?: readonly (AskedCategory & { readonly kind?: string })[] }>(await http.get('/v1/approvals/requests'));
      if (r.kind !== 'done') return r;
      const mine = r.body.mine ?? [];
      return { kind: 'done', status: r.status, body: mine.filter((m) => m.kind === 'category_define' && m.details !== undefined && typeof m.details.categoryId === 'string') };
    },
    saveApprovedCategory: async (asked) => {
      if (!may.categoryPropose) return notAllowed(P.categoryPropose);
      if (asked.status !== 'approved') return invalid('approval');
      // Exactly what was approved — head office fingerprints it, so the owner approved precisely this definition.
      return postCategory(asked.details, asked.requestId);
    },
    variantReport: async (categoryId) => {
      if (!may.read) return notAllowed(P.read);
      const c = id(categoryId);
      return outcomeOf<VariantReport>(await http.get(`/v1/catalogue/reports/variants${c === '' ? '' : `?categoryId=${enc(c)}`}`));
    },
    bundle: async (bundleProductId) => {
      if (!may.read) return notAllowed(P.read);
      if (id(bundleProductId) === '') return invalid();
      return outcomeOf(await http.get(`/v1/catalogue/bundles/${enc(id(bundleProductId))}`));
    },
    defineBundle: async (bundleProductId, components, reason) => {
      if (!may.publish) return notAllowed(P.publish);
      const parts = componentsFromInput(components);
      if (id(bundleProductId) === '' || parts === undefined) return invalid();
      if (reason.trim() === '') return invalid('reason');
      return outcomeOf(await http.post(`/v1/catalogue/bundles/${enc(id(bundleProductId))}`, { components: parts, reason: reason.trim() }));
    },
    pack: async (productId) => {
      if (!may.read) return notAllowed(P.read);
      if (id(productId) === '') return invalid();
      return outcomeOf(await http.get(`/v1/catalogue/products/${enc(id(productId))}/pack`));
    },
    definePack: async (productId, baseUom, levels) => {
      if (!may.publish) return notAllowed(P.publish);
      const parsed = packLevelsFromInput(levels);
      if (id(productId) === '' || baseUom.trim() === '' || parsed === undefined) return invalid();
      return outcomeOf(await http.post(`/v1/catalogue/products/${enc(id(productId))}/pack`, { baseUom: baseUom.trim(), levels: parsed }));
    },
    substitutes: async (productId) => {
      if (!may.read) return notAllowed(P.read);
      if (id(productId) === '') return invalid();
      return outcomeOf(await http.get(`/v1/catalogue/products/${enc(id(productId))}/substitutes`));
    },
    setSubstitutes: async (productId, list, reason) => {
      if (!may.publish) return notAllowed(P.publish);
      if (id(productId) === '') return invalid();
      if (reason.trim() === '') return invalid('reason');
      return outcomeOf(await http.post(`/v1/catalogue/products/${enc(id(productId))}/substitutes`, { substitutes: substitutesFromInput(list), reason: reason.trim() }));
    },
    merges: async () => {
      if (!may.read) return notAllowed(P.read);
      return outcomeOf<MergeList>(await http.get('/v1/catalogue/merges'));
    },
    proposeMerge: async (input) => {
      if (!may.mergePropose) return notAllowed(P.mergePropose);
      const keep = id(input.keepProductId);
      const supersede = id(input.supersedeProductId);
      if (keep === '' || supersede === '') return invalid();
      if (input.reason.trim() === '') return invalid('reason');
      return outcomeOf(await http.post(`/v1/catalogue/merges/${enc(`merge-${newId()}`)}`, { keepProductId: keep, supersedeProductId: supersede, reason: input.reason.trim() }));
    },
    decideMerge: async (row, decision) => {
      if (!may.mergeApprove) return notAllowed(P.mergeApprove);
      // §28 — never sent: the person who proposed a merge never approves it (head office refuses it too). Rejecting one's
      // own proposal merges nothing, and head office allows it, so the screen does not add a rule of its own there.
      if (decision === 'approved' && userId !== undefined && row.request.requestedBy === userId) return invalid('own');
      return outcomeOf(await http.post(`/v1/catalogue/merges/${enc(row.request.mergeId)}/decision`, { decision }));
    },
  };
}
