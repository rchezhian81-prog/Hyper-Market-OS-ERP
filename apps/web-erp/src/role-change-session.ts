// CHANGE WHAT A ROLE MAY DO, ON THE USERS & ROLES PAGE — CR-01 step 4c-2 · OI-06 · ADR-0034 · ADR-0033 §2 · OB-730 "A" ·
// OB-740 "B" · OB-741 "A" · OB-809 · §28 · P-07 · P-08 · hard rules #2, #5.
//
// A tested, DOM-free session. One permission of one role is switched on or off at a time, from the product's existing list
// only, by TWO PEOPLE — the owner always one of them, never his own (OB-740 "B"):
//
//   • READ — `GET /v1/identity/role-permissions` (identity.role.adjust): every role with what it holds now, what the shop
//     changed from the built-in role, whether it is locked, the owner's reserved powers and the never-from-a-screen areas.
//   • CHECK — `POST /v1/identity/role-permissions/check`: is it allowed, who it reaches, who must approve. Changes nothing.
//   • ASK — on the STORE PC (head-office link off) through the store computer's door, the asker's PIN typed again
//     (`role_permission_request`, ADR-0033 §2); at head office, the person's own approval request (kind
//     `role_permission_change`, exactly the change and its request id).
//   • DECIDE — on the Approvals page. On the store PC a role change is decided through the store computer's door, the
//     approver's PIN typed again (`role_permission_decision`); approved, it is applied at once as the asker
//     (`storePcRoleDecide`). At head office the approver decides as for any request, and the asker then applies it here
//     (`apply`, `POST /v1/identity/role-permissions/:requestId`, a recent second-factor sign-in).
//
// The never-from-a-screen list is not offered here; head office refuses it anyway, whoever asks. No AI and no automated path
// makes a change: every write is a person's explicit press, and the store PC seals each one with that person's own PIN.

import { makeCaller, newId, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';
export type RoleChange = 'add' | 'remove';

/** The store computer's two doors for a role change, and the PIN box (null = the person cancelled). */
export interface RoleChangeDoors {
  /** `/office/privilege/role-permissions` — ask, by PIN. */
  readonly rolePermissions: string;
  /** `/office/privilege/role-permissions/{approvalId}/decide` — approve or reject, by PIN. */
  readonly roleDecide: string;
  readonly askPin: (what: 'roleChange' | 'roleDecide') => Promise<string | null>;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** The doors from the page's injected global (`window.sreOfficePrivilege`), or undefined (head office, or an older box). */
export function roleChangeDoorsFrom(raw: unknown, askPin: RoleChangeDoors['askPin']): RoleChangeDoors | undefined {
  if (!isObj(raw) || !isStr(raw['rolePermissions']) || !isStr(raw['roleDecide'])) return undefined;
  const ask = raw['rolePermissions'] as string;
  const decide = raw['roleDecide'] as string;
  if (!ask.startsWith('/office/') || !decide.startsWith('/office/') || !decide.includes('{approvalId}')) return undefined;
  return { rolePermissions: ask, roleDecide: decide, askPin };
}

// ── Plain words for a permission ────────────────────────────────────────────────────────────────────────────────────────
// Every permission is named in plain English and Tamil, its code shown small beside it. The most used ones carry their own
// words; the rest are put together from what the code says: the area, the thing, and the act.

const NAMED: Readonly<Record<string, { readonly en: string; readonly ta: string }>> = Object.freeze({
  'inventory.indent.read': { en: 'See floor indents (the shelf asking the back store for stock)', ta: 'தளக் கோரிக்கைகளைப் பார்த்தல் (அலமாரி பின்புறக் கிடங்கிடம் சரக்கு கேட்பது)' },
  'inventory.indent.request': { en: 'Ask the back store for stock (a floor indent)', ta: 'பின்புறக் கிடங்கிடம் சரக்கு கேட்டல் (தளக் கோரிக்கை)' },
  'inventory.indent.approve': { en: 'Approve a floor indent', ta: 'தளக் கோரிக்கைக்கு ஒப்புதல் அளித்தல்' },
  'inventory.goodsreceipt.read': { en: 'See goods receipts (Goods receipt review)', ta: 'சரக்கு வரவுகளைப் பார்த்தல் (சரக்கு வரவு ஆய்வு)' },
  'inventory.availability.read': { en: 'See stock on hand and availability', ta: 'கையிருப்பு மற்றும் கிடைப்பைப் பார்த்தல்' },
  'purchase.invoice.read': { en: 'See supplier bills (view only)', ta: 'சப்ளையர் பில்களைப் பார்த்தல் (பார்வைக்கு மட்டும்)' },
  'purchase.invoice.match': { en: 'Match supplier bills for payment (Supplier bills)', ta: 'பணம் செலுத்த சப்ளையர் பில்களைப் பொருத்துதல் (சப்ளையர் பில்கள்)' },
  'purchase.invoice.capture': { en: 'Enter a supplier bill', ta: 'சப்ளையர் பில்லை உள்ளிடுதல்' },
  'pos.return.approve': { en: 'Approve a return at the till', ta: 'கவுண்டரில் திருப்பியளிப்புக்கு ஒப்புதல் அளித்தல்' },
  'price.change.propose': { en: 'Propose a price change', ta: 'விலை மாற்றத்தை முன்மொழிதல்' },
  'count.view': { en: 'See stock counts', ta: 'சரக்கு எண்ணிக்கைகளைப் பார்த்தல்' },
});

const AREA: Readonly<Record<string, { readonly en: string; readonly ta: string }>> = Object.freeze({
  ai: { en: 'Assistants (AI)', ta: 'உதவியாளர்கள் (AI)' }, approvals: { en: 'Approvals', ta: 'ஒப்புதல்கள்' }, audit: { en: 'Audit', ta: 'தணிக்கை' },
  b2b: { en: 'Business customers', ta: 'வணிக வாடிக்கையாளர்கள்' }, backup: { en: 'Backups', ta: 'காப்பு நகல்கள்' }, branch: { en: 'Stores', ta: 'கடைகள்' },
  cash: { en: 'Cash office', ta: 'பண அலுவலகம்' }, catalogue: { en: 'Items', ta: 'பொருட்கள்' }, compliance: { en: 'Compliance', ta: 'இணக்கம்' },
  concession: { en: 'Concessions', ta: 'சலுகைக் கடைகள்' }, count: { en: 'Stock counts', ta: 'சரக்கு எண்ணிக்கை' }, customer: { en: 'Customers', ta: 'வாடிக்கையாளர்கள்' },
  delivery: { en: 'Deliveries', ta: 'டெலிவரிகள்' }, device: { en: 'Devices', ta: 'கருவிகள்' }, document: { en: 'Documents', ta: 'ஆவணங்கள்' },
  documents: { en: 'Documents', ta: 'ஆவணங்கள்' }, epr: { en: 'Packaging (EPR)', ta: 'பேக்கேஜிங் (EPR)' }, export: { en: 'Exports', ta: 'ஏற்றுமதிகள்' },
  facilities: { en: 'Facilities', ta: 'வசதிகள்' }, finance: { en: 'Accounts', ta: 'கணக்குகள்' }, floor: { en: 'Shop floor', ta: 'கடைத் தளம்' },
  fulfilment: { en: 'Order picking', ta: 'ஆர்டர் எடுத்தல்' }, hr: { en: 'Staff (HR)', ta: 'பணியாளர்கள் (HR)' }, identity: { en: 'People and roles', ta: 'நபர்களும் பணிகளும்' },
  integration: { en: 'Connections', ta: 'இணைப்புகள்' }, inventory: { en: 'Stock', ta: 'சரக்கு' }, loyalty: { en: 'Loyalty', ta: 'விசுவாசத் திட்டம்' },
  lp: { en: 'Loss prevention', ta: 'இழப்புத் தடுப்பு' }, merchandising: { en: 'Merchandising', ta: 'வணிகக் காட்சிப்படுத்தல்' }, migration: { en: 'Moving from Bpal', ta: 'Bpal-இலிருந்து மாற்றம்' },
  notification: { en: 'Messages', ta: 'செய்திகள்' }, online: { en: 'Online orders', ta: 'ஆன்லைன் ஆர்டர்கள்' }, order: { en: 'Orders', ta: 'ஆர்டர்கள்' },
  org: { en: 'Shop set-up', ta: 'கடை அமைப்பு' }, owner: { en: 'Owner', ta: 'உரிமையாளர்' }, payment: { en: 'Payments', ta: 'கட்டணங்கள்' },
  payroll: { en: 'Payroll', ta: 'சம்பளம்' }, planogram: { en: 'Shelf plans', ta: 'அலமாரித் திட்டங்கள்' }, platform: { en: 'IT administration', ta: 'IT நிர்வாகம்' },
  pos: { en: 'Tills', ta: 'கவுண்டர்கள்' }, posh: { en: 'POSH committee', ta: 'POSH குழு' }, price: { en: 'Prices', ta: 'விலைகள்' },
  privacy: { en: 'Privacy', ta: 'தனியுரிமை' }, production: { en: 'Kitchen and bakery', ta: 'சமையல் மற்றும் பேக்கரி' }, promotion: { en: 'Offers', ta: 'சலுகைகள்' },
  purchase: { en: 'Buying', ta: 'கொள்முதல்' }, quality: { en: 'Quality', ta: 'தரம்' }, refund: { en: 'Refunds', ta: 'பணத் திருப்பம்' },
  reporting: { en: 'Reports', ta: 'அறிக்கைகள்' }, scrap: { en: 'Scrap', ta: 'கழிவுப் பொருள்' }, selfcheckout: { en: 'Self-checkout', ta: 'சுய-பில்லிங்' },
  service: { en: 'Service desk', ta: 'சேவை மேசை' }, settlement: { en: 'Settlements', ta: 'தீர்வுகள்' }, shelf: { en: 'Shelves', ta: 'அலமாரிகள்' },
  store: { en: 'Store', ta: 'கடை' }, storefront: { en: 'Online shop', ta: 'ஆன்லைன் கடை' }, supplier: { en: 'Suppliers', ta: 'சப்ளையர்கள்' },
  till: { en: 'Tills', ta: 'கவுண்டர்கள்' }, waste: { en: 'Waste', ta: 'கழிவு' }, workforce: { en: 'Rosters and tasks', ta: 'பணி அட்டவணைகளும் வேலைகளும்' },
});

const ACT: Readonly<Record<string, { readonly en: string; readonly ta: string }>> = Object.freeze({
  read: { en: 'see', ta: 'பார்த்தல்' }, view: { en: 'see', ta: 'பார்த்தல்' }, write: { en: 'change', ta: 'மாற்றுதல்' }, manage: { en: 'manage', ta: 'நிர்வகித்தல்' },
  approve: { en: 'approve', ta: 'ஒப்புதல் அளித்தல்' }, request: { en: 'ask for', ta: 'கேட்டல்' }, propose: { en: 'propose', ta: 'முன்மொழிதல்' },
  create: { en: 'create', ta: 'உருவாக்குதல்' }, record: { en: 'record', ta: 'பதிவு செய்தல்' }, capture: { en: 'enter', ta: 'உள்ளிடுதல்' },
  apply: { en: 'apply', ta: 'செயல்படுத்துதல்' }, decide: { en: 'decide', ta: 'முடிவு செய்தல்' }, review: { en: 'review', ta: 'மதிப்பாய்வு செய்தல்' },
  export: { en: 'export', ta: 'ஏற்றுமதி செய்தல்' }, import: { en: 'import', ta: 'இறக்குமதி செய்தல்' }, issue: { en: 'issue', ta: 'வழங்குதல்' },
  receive: { en: 'receive', ta: 'பெறுதல்' }, close: { en: 'close', ta: 'மூடுதல்' }, post: { en: 'post', ta: 'பதிவேற்றுதல்' }, pay: { en: 'pay', ta: 'பணம் செலுத்துதல்' },
  publish: { en: 'publish', ta: 'வெளியிடுதல்' }, match: { en: 'match', ta: 'பொருத்துதல்' }, set: { en: 'set', ta: 'அமைத்தல்' }, adjust: { en: 'adjust', ta: 'சரிசெய்தல்' },
  assign: { en: 'assign', ta: 'ஒதுக்குதல்' }, run: { en: 'run', ta: 'இயக்குதல்' }, operate: { en: 'operate', ta: 'இயக்குதல்' }, override: { en: 'override', ta: 'மீறுதல்' },
  grant: { en: 'give', ta: 'வழங்குதல்' }, revoke: { en: 'take back', ta: 'திரும்பப் பெறுதல்' }, report: { en: 'report', ta: 'அறிவித்தல்' }, sync: { en: 'pass on (the store computer)', ta: 'அனுப்புதல் (கடைக் கணினி)' },
  submit: { en: 'submit', ta: 'சமர்ப்பித்தல்' }, schedule: { en: 'schedule', ta: 'திட்டமிடுதல்' }, configure: { en: 'set up', ta: 'அமைத்தல்' }, raise: { en: 'raise', ta: 'எழுப்புதல்' },
  release: { en: 'release', ta: 'விடுவித்தல்' }, resolve: { en: 'resolve', ta: 'தீர்த்தல்' }, settle: { en: 'settle', ta: 'தீர்வு செய்தல்' }, verify: { en: 'verify', ta: 'சரிபார்த்தல்' },
  check: { en: 'check', ta: 'சரிபார்த்தல்' }, confirm: { en: 'confirm', ta: 'உறுதிப்படுத்துதல்' }, cancel: { en: 'cancel', ta: 'ரத்து செய்தல்' }, dispose: { en: 'dispose of', ta: 'அப்புறப்படுத்துதல்' },
  plan: { en: 'plan', ta: 'திட்டமிடுதல்' }, launch: { en: 'launch', ta: 'தொடங்குதல்' }, draft: { en: 'draft', ta: 'வரைவு செய்தல்' }, send: { en: 'send', ta: 'அனுப்புதல்' },
  sign: { en: 'sign', ta: 'கையொப்பமிடுதல்' }, file: { en: 'file', ta: 'தாக்கல் செய்தல்' }, enable: { en: 'switch on', ta: 'இயக்குதல்' }, switch: { en: 'switch', ta: 'மாற்றுதல்' },
  acknowledge: { en: 'acknowledge', ta: 'ஏற்றுக்கொள்ளுதல்' }, accept: { en: 'accept', ta: 'ஏற்றல்' }, block: { en: 'block', ta: 'தடுத்தல்' }, stop: { en: 'stop', ta: 'நிறுத்துதல்' },
  generate: { en: 'make', ta: 'உருவாக்குதல்' }, mark: { en: 'mark', ta: 'குறித்தல்' }, place: { en: 'place', ta: 'வைத்தல்' }, pull: { en: 'take in', ta: 'பெறுதல்' }, push: { en: 'send out', ta: 'அனுப்புதல்' },
  self: { en: 'their own', ta: 'தங்களுடையது' }, own: { en: 'their own', ta: 'தங்களுடையது' }, work: { en: 'work on', ta: 'பணியாற்றுதல்' }, load: { en: 'load', ta: 'ஏற்றுதல்' },
});

const words = (seg: string): string => seg.replace(/_/g, ' ');

/** A permission in plain words, in the reader's language (the code is shown beside it by the page). */
export function permissionWords(code: string, lang: Lang): string {
  const named = NAMED[code];
  if (named !== undefined) return named[lang];
  const parts = code.split('.');
  if (parts.length < 2) return code;
  const area = AREA[parts[0]!]?.[lang] ?? words(parts[0]!);
  const last = parts[parts.length - 1]!;
  const act = ACT[last]?.[lang] ?? words(last);
  const thing = parts.slice(1, -1).map(words).join(' ');
  return thing === '' ? `${area}: ${act}` : `${area} — ${thing}: ${act}`;
}

// ── The page's words ──────────────────────────────────────────────────────────────────────────────────────────────────

export const ROLE_CHANGE_COPY = {
  en: {
    h: 'Change what a role may do', lead: 'Switch one permission of a role on or off. Two people do it: one asks, the other approves on the Approvals page — the owner is always one of the two, and nobody approves their own. Every change is recorded and can be undone the same way.',
    role: 'Role', permission: 'Permission', change: 'Switch it', on: 'on (give it)', off: 'off (take it away)', reason: 'Why',
    check: 'Check first', ask: 'Ask for this change', apply: 'Apply now', undo: 'Undo (switch it back)',
    holdsNow: 'What this role may do now', changedH: 'Changes made in this shop', builtIn: 'as built', added: 'switched on here', removed: 'switched off here',
    locked: 'This role cannot be changed from a screen:', lockedPerm: 'Not offered: it can never be changed from a screen.',
    allowed: 'Allowed. It reaches {n} person(s). It must be approved by {who}.', notAllowed: 'Not allowed:', reachesNobody: 'Nobody holds this role yet.',
    asked: 'Asked. A second person approves it on the Approvals page; nobody\'s access has changed yet.',
    askedStorePc: 'Asked. A second person approves it on the Approvals page, with their PIN; then it is done at once.',
    applied: 'Done — recorded. It applies at head office now and reaches the tills and screens on the store computer\'s next pull.',
    nobody: 'Nobody is signed in on this screen, so nothing can be done here.', cannot: 'Your role cannot change what a role may do.',
    needRole: 'Choose a role.', needPermission: 'Choose a permission.', needReason: 'Say why.', pinNeeded: 'Type your own PIN again to confirm. Nothing was changed.',
    pinAskChange: 'Type your own PIN again to ask for this role change.', pinAskDecide: 'Type your own PIN again to decide this role change.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or sent.', reading: 'Reading from head office…',
    history: 'Recorded changes', by: 'asked by', approvedBy: 'approved by', none: 'No change has been made to any role in this shop.',
    mineH: 'Role changes you asked for', st_waiting: 'waiting for the second person', st_approved: 'approved — apply it now', st_rejected: 'rejected', st_expired: 'approval ran out — ask again', st_used: 'done',
  },
  ta: {
    h: 'ஒரு பணி செய்யக்கூடியதை மாற்றுதல்', lead: 'ஒரு பணியின் ஒரு அனுமதியை இயக்கவோ நிறுத்தவோ. இருவர் செய்வார்கள்: ஒருவர் கேட்பார், மற்றவர் ஒப்புதல்கள் பக்கத்தில் ஒப்புதல் தருவார் — உரிமையாளர் எப்போதும் இருவரில் ஒருவர், யாரும் தங்கள் சொந்தக் கோரிக்கைக்கு ஒப்புதல் தர மாட்டார்கள். ஒவ்வொரு மாற்றமும் பதிவு செய்யப்படும், அதே வழியில் திரும்பப் பெறலாம்.',
    role: 'பணி', permission: 'அனுமதி', change: 'மாற்றம்', on: 'இயக்கு (வழங்கு)', off: 'நிறுத்து (நீக்கு)', reason: 'ஏன்',
    check: 'முதலில் சரிபார்', ask: 'இந்த மாற்றத்தைக் கேள்', apply: 'இப்போது செயல்படுத்து', undo: 'திரும்பப் பெறு (பழையபடி மாற்று)',
    holdsNow: 'இந்தப் பணி இப்போது செய்யக்கூடியது', changedH: 'இந்தக் கடையில் செய்த மாற்றங்கள்', builtIn: 'அமைப்பின்படி', added: 'இங்கே இயக்கப்பட்டது', removed: 'இங்கே நிறுத்தப்பட்டது',
    locked: 'இந்தப் பணியைத் திரையிலிருந்து மாற்ற முடியாது:', lockedPerm: 'வழங்கப்படவில்லை: இதைத் திரையிலிருந்து ஒருபோதும் மாற்ற முடியாது.',
    allowed: 'அனுமதிக்கப்பட்டது. இது {n} நபரை அடையும். {who} ஒப்புதல் தர வேண்டும்.', notAllowed: 'அனுமதிக்கப்படவில்லை:', reachesNobody: 'இந்தப் பணியை இன்னும் யாரும் வைத்திருக்கவில்லை.',
    asked: 'கேட்கப்பட்டது. இரண்டாவது நபர் ஒப்புதல்கள் பக்கத்தில் ஒப்புதல் தருவார்; இன்னும் யாருடைய அணுகலும் மாறவில்லை.',
    askedStorePc: 'கேட்கப்பட்டது. இரண்டாவது நபர் ஒப்புதல்கள் பக்கத்தில் தன் PIN-உடன் ஒப்புதல் தருவார்; பிறகு உடனே நடக்கும்.',
    applied: 'முடிந்தது — பதிவு செய்யப்பட்டது. தலைமை அலுவலகத்தில் இப்போதே பொருந்தும்; கடைக் கணினியின் அடுத்த இழுப்பில் கவுண்டர்களுக்கும் திரைகளுக்கும் வரும்.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை, எனவே இங்கே எதுவும் செய்ய முடியாது.', cannot: 'உங்கள் பணியால் ஒரு பணி செய்யக்கூடியதை மாற்ற முடியாது.',
    needRole: 'ஒரு பணியைத் தேர்வு செய்யுங்கள்.', needPermission: 'ஒரு அனுமதியைத் தேர்வு செய்யுங்கள்.', needReason: 'ஏன் என்று சொல்லுங்கள்.', pinNeeded: 'உறுதிப்படுத்த உங்கள் PIN-ஐ மீண்டும் உள்ளிடுங்கள். எதுவும் மாற்றப்படவில்லை.',
    pinAskChange: 'இந்தப் பணி மாற்றத்தைக் கேட்க உங்கள் PIN-ஐ மீண்டும் உள்ளிடுங்கள்.', pinAskDecide: 'இந்தப் பணி மாற்றத்தை முடிவு செய்ய உங்கள் PIN-ஐ மீண்டும் உள்ளிடுங்கள்.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவோ அனுப்பப்படவோ இல்லை.', reading: 'தலைமை அலுவலகத்திலிருந்து படிக்கிறது…',
    history: 'பதிவான மாற்றங்கள்', by: 'கேட்டவர்', approvedBy: 'ஒப்புதல் தந்தவர்', none: 'இந்தக் கடையில் எந்தப் பணியிலும் மாற்றம் செய்யப்படவில்லை.',
    mineH: 'நீங்கள் கேட்ட பணி மாற்றங்கள்', st_waiting: 'இரண்டாவது நபருக்காகக் காத்திருக்கிறது', st_approved: 'ஒப்புதல் கிடைத்தது — இப்போது செயல்படுத்துங்கள்', st_rejected: 'மறுக்கப்பட்டது', st_expired: 'ஒப்புதல் காலாவதியானது — மீண்டும் கேளுங்கள்', st_used: 'முடிந்தது',
  },
} as const;
export type RoleChangeWordKey = keyof (typeof ROLE_CHANGE_COPY)['en'];
export const roleChangeWords = (lang: Lang, key: RoleChangeWordKey): string => ROLE_CHANGE_COPY[lang][key];

// ── The session ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** The permission both people act under (services/identity/src/role-adjustments.ts `ROLE_ADJUST_PERMISSION`). */
export const ROLE_ADJUST_PERMISSION = 'identity.role.adjust';

export interface RoleView {
  readonly roleId: string;
  readonly name: string;
  readonly nameTa?: string;
  /** Why the role cannot be changed from a screen, in head office's words — or null. */
  readonly locked: string | null;
  readonly permissions: readonly string[];
  readonly added: readonly string[];
  readonly removed: readonly string[];
}
export interface RoleChangeRecord {
  readonly requestId: string; readonly roleId: string; readonly permission: string; readonly change: RoleChange;
  readonly reason: string; readonly requestedBy: string; readonly approvedBy: string; readonly at: string;
}
export interface RolesView {
  readonly roles: readonly RoleView[];
  /** Every permission of the product (what any built-in role holds) — the only ones that can be switched on. */
  readonly productPermissions: readonly string[];
  readonly ownerReserved: readonly string[];
  readonly lockedAreas: readonly { readonly match: string; readonly words: string }[];
  readonly history: readonly RoleChangeRecord[];
}
/** A role change this person asked for, and where it stands (the approval engine's own status). */
export interface MyRoleChange {
  readonly approvalId: string;
  readonly requestId: string;
  readonly roleId: string;
  readonly permission: string;
  readonly change: RoleChange;
  readonly reason: string;
  readonly status: 'waiting' | 'approved' | 'rejected' | 'expired' | 'used';
  readonly requestedAt: string;
}
export type CheckResult =
  | { readonly allowed: true; readonly affectedPeople: readonly string[]; readonly approvedBy: string }
  | { readonly allowed: false; readonly why: string; readonly affectedPeople: readonly string[] };

type Why = 'nobody' | 'cannot' | 'needRole' | 'needPermission' | 'needReason' | 'pinNeeded';
type Done<T> = Promise<Outcome<T, Why>>;

export interface RoleChangeSession {
  readonly may: { readonly adjust: boolean };
  readonly onStorePc: boolean;
  view(): Done<RolesView>;
  check(input: { readonly roleId: string; readonly permission: string; readonly change: RoleChange }): Done<CheckResult>;
  /** Ask. On the store PC through its door, by PIN; at head office the person's own approval request. Changes nobody's access. */
  ask(input: { readonly roleId: string; readonly permission: string; readonly change: RoleChange; readonly reason: string }): Done<{ readonly requestId: string; readonly approvalId: string; readonly words: string }>;
  /** Head office only: the asker applies a change the other person approved (a recent second-factor sign-in). */
  apply(input: { readonly requestId: string; readonly approvalId: string; readonly roleId: string; readonly permission: string; readonly change: RoleChange; readonly reason: string }): Done<{ readonly approvedBy: string }>;
  /** The role changes this person asked for — waiting, approved (apply it, at head office), done, rejected or run out. */
  mine(): Done<readonly MyRoleChange[]>;
  /** Is this permission offered for this role (not locked, not the owner's reserved, of the product)? */
  offered(view: RolesView, roleId: string, permission: string): boolean;
}

/** Does a locked area (an exact code, or a prefix ending in '.') cover this permission? */
const inArea = (areas: RolesView['lockedAreas'], permission: string): boolean =>
  areas.some((a) => (a.match.endsWith('.') ? permission.startsWith(a.match) : permission === a.match));

export function createRoleChangeSession(input: {
  readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined;
  readonly fetch?: typeof globalThis.fetch;
  readonly newId?: (prefix: string) => string;
  /** Present on the store PC with the head-office link off — asking goes through its door, by PIN. */
  readonly doors?: RoleChangeDoors;
}): RoleChangeSession {
  const named = input.viewer?.userId !== undefined;
  const adjust = named && (input.viewer?.permissions ?? []).includes(ROLE_ADJUST_PERMISSION);
  const call = makeCaller({ keyPrefix: 'role-change', ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
  const http = input.fetch ?? ((...a: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...a));
  const id = input.newId ?? newId;
  const no = (why: Why): { result: 'invalid'; why: Why } => ({ result: 'invalid', why });
  const gate = (): { result: 'invalid'; why: Why } | undefined => (!named ? no('nobody') : !adjust ? no('cannot') : undefined);

  return {
    may: { adjust }, onStorePc: input.doors !== undefined,
    view: async () => {
      const g = gate(); if (g) return g;
      const out = await call<Record<string, unknown>>('GET', '/v1/identity/role-permissions');
      if (out.result !== 'ok') return out;
      const v = out.value;
      const roles = (Array.isArray(v['roles']) ? v['roles'] : []).flatMap((r): RoleView[] => {
        if (!isObj(r) || !isStr(r['roleId']) || !isStr(r['name'])) return [];
        const list = (k: string): string[] => (Array.isArray(r[k]) ? (r[k] as unknown[]).filter(isStr) : []);
        const locked = isObj(r['locked']) && isStr(r['locked']['words']) ? r['locked']['words'] : null;
        return [{ roleId: r['roleId'], name: r['name'], ...(isStr(r['nameTa']) ? { nameTa: r['nameTa'] } : {}), locked, permissions: list('permissions'), added: list('added'), removed: list('removed') }];
      });
      // The product's list: everything a role holds now or held as built (an adjustment only ever adds a product permission).
      const builtInHeld = new Set<string>();
      for (const r of roles) { for (const p of r.permissions) builtInHeld.add(p); for (const p of r.removed) builtInHeld.add(p); }
      const history = (Array.isArray(v['history']) ? v['history'] : []).flatMap((h): RoleChangeRecord[] =>
        isObj(h) && isStr(h['requestId']) && isStr(h['roleId']) && isStr(h['permission']) && (h['change'] === 'add' || h['change'] === 'remove')
          ? [{ requestId: h['requestId'], roleId: h['roleId'], permission: h['permission'], change: h['change'], reason: isStr(h['reason']) ? h['reason'] : '',
            requestedBy: isStr(h['requestedBy']) ? h['requestedBy'] : '', approvedBy: isStr(h['approvedBy']) ? h['approvedBy'] : '', at: isStr(h['at']) ? h['at'] : '' }]
          : []);
      return {
        result: 'ok',
        value: {
          roles, productPermissions: [...builtInHeld].sort(),
          ownerReserved: Array.isArray(v['ownerReserved']) ? (v['ownerReserved'] as unknown[]).filter(isStr) : [],
          lockedAreas: (Array.isArray(v['lockedPermissions']) ? v['lockedPermissions'] : []).flatMap((l) => (isObj(l) && isStr(l['match']) ? [{ match: l['match'], words: isStr(l['words']) ? l['words'] : '' }] : [])),
          history,
        },
      };
    },
    check: async ({ roleId, permission, change }) => {
      const g = gate(); if (g) return g;
      if (roleId.trim() === '') return no('needRole');
      if (permission.trim() === '') return no('needPermission');
      const out = await call<Record<string, unknown>>('POST', '/v1/identity/role-permissions/check', { roleId: roleId.trim(), permission: permission.trim(), change });
      if (out.result !== 'ok') return out;
      const v = out.value;
      const affectedPeople = (Array.isArray(v['affectedPeople']) ? v['affectedPeople'] : []).flatMap((p) => (isObj(p) && isStr(p['userId']) ? [p['userId']] : []));
      if (v['allowed'] === true) return { result: 'ok', value: { allowed: true, affectedPeople, approvedBy: isStr(v['approvedBy']) ? v['approvedBy'] : '' } };
      const r = isObj(v['refusal']) ? v['refusal'] : {};
      return { result: 'ok', value: { allowed: false, why: isStr(r['whatHappened']) ? r['whatHappened'] : '', affectedPeople } };
    },
    ask: async ({ roleId, permission, change, reason }) => {
      const g = gate(); if (g) return g;
      if (roleId.trim() === '') return no('needRole');
      if (permission.trim() === '') return no('needPermission');
      if (reason.trim() === '') return no('needReason');
      const requestId = id('rpc');
      const change1 = { roleId: roleId.trim(), permission: permission.trim(), change, reason: reason.trim() };
      if (input.doors !== undefined) {
        const pin = await input.doors.askPin('roleChange');
        if (pin === null || pin.trim() === '') return no('pinNeeded');
        try {
          const res = await http(input.doors.rolePermissions, { method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ pin, request: { requestId, ...change1 } }) });
          const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
          if (!res.ok || json['ok'] !== true) {
            return { result: 'refused', status: res.status, code: isStr(json['code']) ? json['code'] : isStr(json['refusedBecause']) ? json['refusedBecause'] : String(res.status), whatHappened: isStr(json['en']) ? json['en'] : `status ${res.status}` };
          }
          const result = isObj(json['result']) ? json['result'] : {};
          return { result: 'ok', value: { requestId, approvalId: isStr(result['requestId']) ? result['requestId'] : '', words: isStr(json['en']) ? json['en'] : '' } };
        } catch { return { result: 'lost_link' }; }
      }
      // Head office: the person's own approval request for exactly this change.
      const summary = `${change === 'add' ? 'Switch on' : 'Switch off'} "${change1.permission}" for the role ${change1.roleId}`;
      const out = await call<{ requestId?: unknown }>('POST', '/v1/approvals/requests', {
        kind: 'role_permission_change', subjectRef: requestId, details: { ...change1, requestId }, valueMinor: null, summary, reason: change1.reason,
      });
      if (out.result !== 'ok') return out;
      return { result: 'ok', value: { requestId, approvalId: isStr(out.value.requestId) ? out.value.requestId : '', words: '' } };
    },
    apply: async ({ requestId, approvalId, roleId, permission, change, reason }) => {
      const g = gate(); if (g) return g;
      const out = await call<{ approvedBy?: unknown }>('POST', `/v1/identity/role-permissions/${encodeURIComponent(requestId)}`, { roleId, permission, change, reason, approvalId });
      if (out.result !== 'ok') return out;
      return { result: 'ok', value: { approvedBy: isStr(out.value.approvedBy) ? out.value.approvedBy : '' } };
    },
    mine: async () => {
      const g = gate(); if (g) return g;
      const out = await call<{ mine?: unknown[] }>('GET', '/v1/approvals/requests');
      if (out.result !== 'ok') return out;
      const rows = (out.value.mine ?? []).flatMap((r): MyRoleChange[] => {
        if (!isObj(r) || r['kind'] !== 'role_permission_change' || !isStr(r['requestId']) || !isObj(r['details'])) return [];
        const d = r['details'];
        if (!isStr(d['roleId']) || !isStr(d['permission']) || (d['change'] !== 'add' && d['change'] !== 'remove')) return [];
        const status = (['waiting', 'approved', 'rejected', 'expired', 'used'] as const).find((x) => x === r['status']) ?? 'waiting';
        return [{ approvalId: r['requestId'], requestId: isStr(d['requestId']) ? d['requestId'] : isStr(r['subjectRef']) ? r['subjectRef'] : '', roleId: d['roleId'], permission: d['permission'],
          change: d['change'], reason: isStr(d['reason']) ? d['reason'] : '', status, requestedAt: isStr(r['requestedAt']) ? r['requestedAt'] : '' }];
      });
      rows.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
      return { result: 'ok', value: rows };
    },
    offered: (view, roleId, permission) => {
      const role = view.roles.find((r) => r.roleId === roleId);
      if (role === undefined || role.locked !== null) return false;
      if (!view.productPermissions.includes(permission) && !role.permissions.includes(permission)) return false;
      if (inArea(view.lockedAreas, permission)) return false;
      if (roleId !== 'owner' && view.ownerReserved.includes(permission) && !role.permissions.includes(permission)) return false;
      return true;
    },
  };
}

/**
 * The Approvals page's decide on the STORE PC (CR-01 step 4c-2): a role change goes through the store computer's door, the
 * approver's PIN typed again; approved, head office applies it at once as the asker and says whether it did. Every other
 * request goes the ordinary way (`fallback`).
 */
export function storePcRoleDecide<I extends { readonly requestId: string; readonly decision: 'approved' | 'rejected'; readonly reason: string; readonly kind?: string }, R>(
  doors: RoleChangeDoors,
  fallback: (input: I) => Promise<R>,
  fetchFn?: typeof globalThis.fetch,
): (input: I) => Promise<R | { readonly result: 'decided'; readonly decision: 'approved' | 'rejected'; readonly decidedBy: string; readonly roleChange?: { readonly applied: boolean; readonly reason?: string } } | { readonly result: 'refused'; readonly status: number; readonly code: string; readonly whatHappened: string } | { readonly result: 'lost_link' }> {
  const http = fetchFn ?? ((...a: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...a));
  return async (input) => {
    if (input.kind !== 'role_permission_change') return fallback(input);
    const pin = await doors.askPin('roleDecide');
    if (pin === null || pin.trim() === '') {
      return { result: 'refused', status: 400, code: 'pin_needed', whatHappened: ROLE_CHANGE_COPY.en.pinNeeded };
    }
    try {
      const res = await http(doors.roleDecide.replace('{approvalId}', encodeURIComponent(input.requestId)), {
        method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ pin, request: { decision: input.decision, reason: input.reason } }),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || json['ok'] !== true) {
        return { result: 'refused', status: res.status, code: isStr(json['code']) ? json['code'] : isStr(json['refusedBecause']) ? json['refusedBecause'] : String(res.status), whatHappened: isStr(json['en']) ? json['en'] : `status ${res.status}` };
      }
      const result = isObj(json['result']) ? json['result'] : {};
      if (input.decision === 'rejected') return { result: 'decided', decision: 'rejected', decidedBy: '' };
      const applied = result['applied'] === true;
      return { result: 'decided', decision: 'approved', decidedBy: '', roleChange: applied ? { applied: true } : { applied: false, reason: isStr(json['en']) ? json['en'] : '' } };
    } catch { return { result: 'lost_link' }; }
  };
}
