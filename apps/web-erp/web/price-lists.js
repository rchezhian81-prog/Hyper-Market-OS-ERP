// Price lists (Round 4a · M05-FR-01 · D-19 · OB-148/190 · OB-291): a THIN CLIENT over head office's scoped, effective-dated
// price list. A price is for one store, a price zone, a channel or one customer, from a date (and until a date if it ends).
// Before it is sent the page reads head office's own figures for that scope and day — the MRP, the buying cost, the
// margin floor, the price in force and the owner's set size — and shows each one, or "Not known" / "not set" by name; a
// figure head office does not hold is never guessed, and the price is not sent without it. A price below cost or the
// floor, or a move beyond the set size, waits for a second person's approval of EXACTLY that entry. The stores' price zones
// and the channel / zone switches (all off until a second person approves switching one on) are on their own tabs. Every
// word has a Tamil twin; nothing is written on open.

const $ = (id) => document.getElementById(id);
const who = window.priceListsData && typeof window.priceListsData === 'object' ? window.priceListsData : null;
const perms = new Set(Array.isArray(who?.permissions) ? who.permissions : []);
const named = typeof who?.userId === 'string' && who.userId !== '';
const mayPropose = perms.has('price.change.propose');
const mayApprove = perms.has('price.change.approve');
const mayZone = perms.has('price.zone.manage');
const mayRead = perms.has('catalogue.pack.read') || mayPropose;
let lang = document.documentElement.lang === 'ta' ? 'ta' : 'en';

const WORDS = {
  en: {
    lang: 'தமிழ்', title: 'Price lists',
    lead: 'Prices set ahead and for a scope: one store from a date, a price zone, a channel or one customer. Head office judges each on its own MRP, buying cost and margin floor, and a big move or a loss needs a second person.',
    kSame: 'One price everywhere?', kPending: 'Switch requests waiting', kZoned: 'Stores in a price zone', yes: 'Yes — every channel charges the shelf price', no: 'No — {list} on',
    tabPrices: 'Dated prices', tabZones: 'Price zones', tabChannels: 'Channel prices',
    pricesLead: 'Choose the product, which price and from when, then read head office\'s figures. The price is saved only when head office accepts it; the till charges it from the next store pack on or after its date.',
    product: 'Product id', scope: 'Which price', store: 'One store\'s shelf price', zone: 'A price zone', channel: 'A channel (app, delivery)', customer: 'One customer',
    ref: 'Store, zone, channel or customer id', from: 'From (date)', to: 'Until (date, if it ends)', price: 'Price (₹)',
    kMrp: 'MRP that day', kCost: 'Buying cost', kFloor: 'Margin floor', kNow: 'Price for this scope now', kSize: 'A second person checks a move of more than',
    readBasis: 'Read head office\'s figures', save: 'Save the price', why: 'Why (for the approver, if one is needed)', ask: 'Ask for approval',
    notKnown: 'Not known', notSet: 'not set', none: 'none yet', size: '{pct}% or ₹{amt}', stores: 'Judged at: {list}.',
    noMrp: 'Head office holds no MRP for this product on that day, so a price cannot be checked against it. Add the MRP on the Product details page first.',
    noCost: 'Head office knows no buying cost at {list} (nothing received at a cost yet), so the price cannot be checked against cost. It is not sent.',
    noFloor: 'No margin floor is set for {list} in the store rules, so the price cannot be checked against it. The owner sets it in Store setup first.',
    noStores: 'This scope reaches no store yet (a zone with no store in it).',
    needAll: 'Choose the product, which price, the id and the date, and write the price.', needBasis: 'Read head office\'s figures first.', needWhy: 'Write the reason first.',
    saved: 'Saved. {price} from {from} for {scope} {ref}.', savedWith: 'Saved with the approval of {by}.',
    needsApproval: 'This needs a second person: {why} Write why and press “Ask for approval”; once they approve it on their Approvals page, press “Save the price” again.',
    asked: 'Asked. It waits on the approver\'s Approvals page; nothing is saved until then.', waiting: 'Still waiting for the second person. Nothing was saved.', rejected: 'The second person rejected it: {why}',
    historyH: 'Every price on record for this product', cScope: 'Which price', cRef: 'For', cPrice: 'Price', cFrom: 'From', cTo: 'Until', cVer: 'Version', open: 'open-ended', noHistory: 'No price is on record for this product.',
    zonesLead: 'A price zone groups stores that may share a zone price. Zone prices count only once the zone switch is on (Channel prices tab).',
    cZStore: 'Store', cZone: 'Zone', cZBy: 'Set by', cZAt: 'When', zStore: 'Store', zZone: 'Zone', zSave: 'Put the store in this zone', noZones: 'No store is in a price zone.', zSaved: 'Saved.',
    channelsLead: 'The owner decided one price everywhere (OB-148): the till, the app and delivery charge the shelf price. A channel or zone price counts only after a second person approves switching it on; switching off is at once.',
    on: 'On', off: 'Off', askOn: 'Ask to switch on', switchOff: 'Switch off', approveOn: 'Approve switching on', reasonFor: 'Why', pendingH: 'Waiting for a second person', noPending: 'Nothing waits.',
    pendingLine: '{subject} → {to}, asked by {by}: {why}', dStore: 'Compare the channels with the shelf at store', dRun: 'Show the differences',
    noDiff: 'No channel price differs from the shelf at this store.', diffLine: '{product} on {channel}: ₹{ch} against a shelf price of {shelf}', dormant: '{product}: a {scope} price of ₹{price} for {ref} is on file but not charged — its switch ({sw}) is off.',
    switched: 'Done.', askedOn: 'Asked. A second person who approves prices decides it here.',
    refused: 'Head office refused:', unreachable: 'Head office could not be reached. Nothing was saved — try again.',
    readOnly: 'You can read the prices. Setting a price is for those who may propose prices.', noRight: 'This account may not read or set prices.', nobody: 'Nobody is signed in on this computer, so nothing can be shown.',
    'subject:zone': 'Zone prices', 'subject:channel:app': 'App prices', 'subject:channel:delivery': 'Delivery prices',
  },
  ta: {
    lang: 'English', title: 'விலைப் பட்டியல்கள்',
    lead: 'முன்கூட்டியும் ஒரு வரம்புக்கும் அமைக்கப்படும் விலைகள்: ஒரு தேதியிலிருந்து ஒரு கடை, ஒரு விலை மண்டலம், ஒரு வழி அல்லது ஒரு வாடிக்கையாளர். தலைமை அலுவலகம் ஒவ்வொன்றையும் அதன் MRP, வாங்கும் விலை, லாப வரம்பு கொண்டு மதிப்பிடுகிறது; பெரிய மாற்றம் அல்லது நஷ்டத்திற்கு இரண்டாம் நபர் தேவை.',
    kSame: 'எல்லா இடத்திலும் ஒரே விலையா?', kPending: 'காத்திருக்கும் மாற்றக் கோரிக்கைகள்', kZoned: 'விலை மண்டலத்தில் உள்ள கடைகள்', yes: 'ஆம் — ஒவ்வொரு வழியும் அலமாரி விலையை வசூலிக்கிறது', no: 'இல்லை — {list} இயக்கத்தில்',
    tabPrices: 'தேதியிட்ட விலைகள்', tabZones: 'விலை மண்டலங்கள்', tabChannels: 'வழி விலைகள்',
    pricesLead: 'பொருள், எந்த விலை, எப்போதிலிருந்து என்பதைத் தேர்வு செய்து, தலைமை அலுவலக எண்களைப் படியுங்கள். தலைமை அலுவலகம் ஏற்றால் மட்டுமே விலை சேமிக்கப்படும்; அதன் தேதியிலோ பிறகோ வரும் அடுத்த கடைப் பொதியிலிருந்து கவுண்டர் அதை வசூலிக்கும்.',
    product: 'பொருள் எண்', scope: 'எந்த விலை', store: 'ஒரு கடையின் அலமாரி விலை', zone: 'ஒரு விலை மண்டலம்', channel: 'ஒரு வழி (செயலி, டெலிவரி)', customer: 'ஒரு வாடிக்கையாளர்',
    ref: 'கடை, மண்டலம், வழி அல்லது வாடிக்கையாளர் எண்', from: 'தொடங்கும் தேதி', to: 'முடியும் தேதி (முடிந்தால்)', price: 'விலை (₹)',
    kMrp: 'அன்றைய MRP', kCost: 'வாங்கும் விலை', kFloor: 'லாப வரம்பு', kNow: 'இந்த வரம்பின் இப்போதைய விலை', kSize: 'இதைவிட அதிக மாற்றத்தை இரண்டாம் நபர் சரிபார்ப்பார்',
    readBasis: 'தலைமை அலுவலக எண்களைப் படி', save: 'விலையைச் சேமி', why: 'ஏன் (ஒப்புதலாளருக்கு, தேவைப்பட்டால்)', ask: 'ஒப்புதல் கேள்',
    notKnown: 'தெரியவில்லை', notSet: 'அமைக்கப்படவில்லை', none: 'இன்னும் இல்லை', size: '{pct}% அல்லது ₹{amt}', stores: 'மதிப்பிடப்பட்ட கடைகள்: {list}.',
    noMrp: 'அந்த நாளுக்கு இந்தப் பொருளுக்கு MRP தலைமை அலுவலகத்தில் இல்லை, எனவே விலையை அதனுடன் சரிபார்க்க முடியாது. முதலில் பொருள் விவரங்கள் பக்கத்தில் MRP சேருங்கள்.',
    noCost: '{list}-இல் வாங்கும் விலை தலைமை அலுவலகத்திற்குத் தெரியாது (இன்னும் விலையுடன் எதுவும் பெறப்படவில்லை), எனவே விலையை அதனுடன் சரிபார்க்க முடியாது. அனுப்பப்படவில்லை.',
    noFloor: 'கடை விதிகளில் {list}-க்கு லாப வரம்பு அமைக்கப்படவில்லை, எனவே விலையை அதனுடன் சரிபார்க்க முடியாது. உரிமையாளர் முதலில் கடை அமைப்பில் அதை அமைக்கிறார்.',
    noStores: 'இந்த வரம்பு இன்னும் எந்தக் கடையையும் அடையவில்லை (கடை இல்லாத மண்டலம்).',
    needAll: 'பொருள், எந்த விலை, எண், தேதி ஆகியவற்றைத் தேர்வு செய்து விலையை எழுதுங்கள்.', needBasis: 'முதலில் தலைமை அலுவலக எண்களைப் படியுங்கள்.', needWhy: 'முதலில் காரணத்தை எழுதுங்கள்.',
    saved: 'சேமிக்கப்பட்டது. {from} முதல் {scope} {ref}-க்கு {price}.', savedWith: '{by} அவர்களின் ஒப்புதலுடன் சேமிக்கப்பட்டது.',
    needsApproval: 'இதற்கு இரண்டாம் நபர் தேவை: {why} ஏன் என்று எழுதி “ஒப்புதல் கேள்” அழுத்துங்கள்; அவர் தனது ஒப்புதல்கள் பக்கத்தில் ஒப்புக்கொண்டதும் மீண்டும் “விலையைச் சேமி” அழுத்துங்கள்.',
    asked: 'கேட்கப்பட்டது. ஒப்புதலாளரின் ஒப்புதல்கள் பக்கத்தில் காத்திருக்கிறது; அதுவரை எதுவும் சேமிக்கப்படாது.', waiting: 'இரண்டாம் நபர் இன்னும் முடிவு செய்யவில்லை. எதுவும் சேமிக்கப்படவில்லை.', rejected: 'இரண்டாம் நபர் நிராகரித்தார்: {why}',
    historyH: 'இந்தப் பொருளுக்குப் பதிவில் உள்ள ஒவ்வொரு விலையும்', cScope: 'எந்த விலை', cRef: 'யாருக்கு', cPrice: 'விலை', cFrom: 'முதல்', cTo: 'வரை', cVer: 'பதிப்பு', open: 'முடிவில்லை', noHistory: 'இந்தப் பொருளுக்கு எந்த விலையும் பதிவில் இல்லை.',
    zonesLead: 'ஒரு விலை மண்டலம் மண்டல விலையைப் பகிரக்கூடிய கடைகளைக் குழுவாக்குகிறது. மண்டல சுவிட்ச் இயக்கப்பட்ட பின்னரே மண்டல விலைகள் கணக்கில் வரும் (வழி விலைகள் தாவல்).',
    cZStore: 'கடை', cZone: 'மண்டலம்', cZBy: 'அமைத்தவர்', cZAt: 'எப்போது', zStore: 'கடை', zZone: 'மண்டலம்', zSave: 'கடையை இந்த மண்டலத்தில் வை', noZones: 'எந்தக் கடையும் விலை மண்டலத்தில் இல்லை.', zSaved: 'சேமிக்கப்பட்டது.',
    channelsLead: 'உரிமையாளர் எல்லா இடத்திலும் ஒரே விலை என முடிவு செய்தார் (OB-148): கவுண்டர், செயலி, டெலிவரி அலமாரி விலையை வசூலிக்கின்றன. இரண்டாம் நபர் இயக்க ஒப்புக்கொண்ட பின்னரே வழி அல்லது மண்டல விலை கணக்கில் வரும்; அணைப்பது உடனே.',
    on: 'இயக்கத்தில்', off: 'அணைக்கப்பட்டது', askOn: 'இயக்கக் கேள்', switchOff: 'அணை', approveOn: 'இயக்க ஒப்புக்கொள்', reasonFor: 'ஏன்', pendingH: 'இரண்டாம் நபருக்குக் காத்திருக்கிறது', noPending: 'எதுவும் காத்திருக்கவில்லை.',
    pendingLine: '{subject} → {to}, கேட்டவர் {by}: {why}', dStore: 'இந்தக் கடையில் வழிகளை அலமாரியுடன் ஒப்பிடு', dRun: 'வேறுபாடுகளைக் காட்டு',
    noDiff: 'இந்தக் கடையில் எந்த வழி விலையும் அலமாரியிலிருந்து வேறுபடவில்லை.', diffLine: '{channel}-இல் {product}: அலமாரி விலை {shelf}-க்கு எதிராக ₹{ch}', dormant: '{product}: {ref}-க்கு ₹{price} {scope} விலை பதிவில் உள்ளது ஆனால் வசூலிக்கப்படவில்லை — அதன் சுவிட்ச் ({sw}) அணைக்கப்பட்டுள்ளது.',
    switched: 'முடிந்தது.', askedOn: 'கேட்கப்பட்டது. விலைகளை ஒப்புக்கொள்ளும் இரண்டாம் நபர் இங்கே முடிவு செய்வார்.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை. எதுவும் சேமிக்கப்படவில்லை — மீண்டும் முயலவும்.',
    readOnly: 'விலைகளை நீங்கள் படிக்கலாம். விலை அமைப்பது விலைகளை முன்மொழியக்கூடியவர்களுக்கு.', noRight: 'இந்தக் கணக்கு விலைகளைப் படிக்கவோ அமைக்கவோ முடியாது.', nobody: 'இந்தக் கணினியில் யாரும் உள்நுழையவில்லை, எனவே எதையும் காட்ட முடியாது.',
    'subject:zone': 'மண்டல விலைகள்', 'subject:channel:app': 'செயலி விலைகள்', 'subject:channel:delivery': 'டெலிவரி விலைகள்',
  },
};
const t = (k) => WORDS[lang]?.[k] ?? WORDS.en[k] ?? k;
const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
const rupees = (minor) => `₹${(minor / 100).toFixed(2)}`;
const subjectWords = (s) => WORDS[lang][`subject:${s}`] ?? s;
// A date as the shop reads it: a calendar date stays as written; an instant is read on the shop's own clock (India), never its UTC date.
const shopDay = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(v)));
const shopTime = (v) => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(v));
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

const newKey = () => `price-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
async function call(method, path, body) {
  try {
    const res = await fetch(path, {
      method, credentials: 'same-origin', cache: 'no-store',
      headers: { accept: 'application/json', ...(method === 'POST' ? { 'content-type': 'application/json', 'idempotency-key': newKey() } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
  } catch { return { ok: false, status: 0, body: null }; }
}
const tell = (el, ok, text) => { el.className = `status ${ok ? 'good' : 'err'}`; el.textContent = text; };
const say = (el, out, good) => tell(el, out.ok, out.ok ? good : out.status === 0 ? t('unreachable') : `${t('refused')} ${out.body?.error?.whatHappened ?? out.status}`);
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}
async function ownApproval(subjectRef, details, valueMinor) {
  const out = await call('GET', '/v1/approvals/requests');
  if (!out.ok) return {};
  const mine = (Array.isArray(out.body?.mine) ? out.body.mine : []).filter((r) => r.kind === 'price_list_entry' && r.subjectRef === subjectRef && r.valueMinor === valueMinor && canonical(r.details) === canonical(details));
  const newest = (rows) => rows.slice().sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt)))[0];
  const approved = newest(mine.filter((r) => r.status === 'approved'));
  if (approved !== undefined) return { approvalId: approved.requestId, decidedBy: approved.decidedBy };
  if (mine.some((r) => r.status === 'waiting')) return { waiting: true };
  const last = newest(mine);
  return last?.status === 'rejected' ? { rejected: last.decisionReason ?? '' } : {};
}

let tab = 'prices';
let basis = null;        // head office's figures for the form as it stood when read
let basisFor = '';       // the form it was read for
let entryId = null;      // the entry the form is about to make — kept while the form is unchanged, so an approval matches
let pending = null;      // { subjectRef, details, valueMinor } the last save needed approval for
let history = null;
let channel = null;
let zones = null;
let stores = [];

const formKey = () => JSON.stringify(['p-product', 'p-scope', 'p-ref', 'p-from', 'p-to', 'p-price'].map((id) => $(id).value.trim()));
const scopeWords = (s) => t(s);

function paintBasis() {
  const unknown = (el, known, text) => { el.textContent = known ? text : t('notKnown'); el.classList.toggle('unknown', !known); };
  const b = basis;
  unknown($('v-mrp'), b !== null && b.mrpMinor !== null, b?.mrpMinor === null || b === null ? '' : rupees(b.mrpMinor));
  unknown($('v-cost'), b !== null && b.costMinor !== null && b.costNotKnownAt.length === 0, b?.costMinor == null ? '' : rupees(b.costMinor));
  if (b !== null && b.marginFloorBps === null) { $('v-floor').textContent = t('notSet'); $('v-floor').classList.add('unknown'); }
  else unknown($('v-floor'), b !== null, b === null ? '' : `${(b.marginFloorBps / 100).toFixed(2)}%`);
  unknown($('v-now'), b !== null, b === null ? '' : b.currentPriceMinor !== null ? rupees(b.currentPriceMinor) : b.shelfPrices.length > 0 ? b.shelfPrices.map((s) => `${s.storeId}: ${rupees(s.priceMinor)}`).join(', ') : t('none'));
  unknown($('v-size'), b !== null, b === null ? '' : fill(t('size'), { pct: (b.secondPersonAbove.percentBps / 100).toFixed(0), amt: (b.secondPersonAbove.amountMinor / 100).toFixed(0) }));
  const notes = [];
  if (b !== null) {
    if (b.stores.length === 0) notes.push(t('noStores')); else notes.push(fill(t('stores'), { list: b.stores.join(', ') }));
    if (b.mrpMinor === null) notes.push(t('noMrp'));
    if (b.costNotKnownAt.length > 0) notes.push(fill(t('noCost'), { list: b.costNotKnownAt.join(', ') }));
    if (b.floorNotSetAt.length > 0) notes.push(fill(t('noFloor'), { list: b.floorNotSetAt.join(', ') }));
  }
  $('basis-say').textContent = notes.join(' ');
}

function paintHistory() {
  const tbody = $('history'); tbody.replaceChildren();
  if (history !== null && history.length === 0) { const tr = document.createElement('tr'); const td = document.createElement('td'); td.colSpan = 6; td.textContent = t('noHistory'); tr.append(td); tbody.append(tr); }
  for (const e of history ?? []) {
    const tr = document.createElement('tr'); tr.dataset.entry = e.id;
    for (const v of [scopeWords(e.scope), `${e.scopeRef}${e.batchId === undefined ? '' : ` · ${e.batchId}`}`, rupees(e.price.minor), shopDay(e.effectiveFrom), e.effectiveTo ? shopDay(e.effectiveTo) : t('open'), String(e.version)]) {
      const td = document.createElement('td'); td.textContent = v; tr.append(td);
    }
    tbody.append(tr);
  }
}

function paintZones() {
  const tbody = $('zones'); tbody.replaceChildren();
  if (zones !== null && zones.length === 0) { const tr = document.createElement('tr'); const td = document.createElement('td'); td.colSpan = 4; td.textContent = t('noZones'); tr.append(td); tbody.append(tr); }
  for (const z of zones ?? []) {
    const tr = document.createElement('tr'); tr.dataset.store = z.storeId;
    for (const v of [z.storeId, z.zoneId, z.setBy, shopTime(z.setAt)]) { const td = document.createElement('td'); td.textContent = v; tr.append(td); }
    tbody.append(tr);
  }
  for (const id of ['z-store', 'z-zone', 'z-save']) $(id).disabled = !mayZone;
  $('zone-form').hidden = !mayZone;
}

function paintChannels() {
  const sw = $('switches');
  sw.replaceChildren(...(channel?.switches ?? []).map((s) => {
    const li = document.createElement('li'); li.dataset.subject = s.subject; li.dataset.state = s.state;
    const head = document.createElement('strong'); head.textContent = `${subjectWords(s.subject)}: ${s.state === 'on' ? t('on') : t('off')}`;
    li.append(head);
    if (mayPropose) {
      const acts = document.createElement('div'); acts.className = 'acts';
      const label = document.createElement('label'); const span = document.createElement('span'); span.textContent = t('reasonFor');
      const input = document.createElement('input'); input.autocomplete = 'off'; input.setAttribute('aria-label', `${t('reasonFor')}: ${subjectWords(s.subject)}`); label.append(span, input);
      const b = document.createElement('button'); b.type = 'button'; b.dataset.act = s.state === 'on' ? 'off' : 'on'; b.textContent = s.state === 'on' ? t('switchOff') : t('askOn');
      const line = document.createElement('p'); line.className = 'status'; line.setAttribute('role', 'status');
      b.addEventListener('click', async () => {
        if (input.value.trim() === '') { tell(line, false, t('needWhy')); return; }
        const requestId = `switch-${s.subject.replace(/[^a-z0-9]/g, '-')}-${Date.now().toString(36)}`;
        const out = await call('POST', `/v1/prices/channel-pricing/requests/${encodeURIComponent(requestId)}`, { subject: s.subject, to: s.state === 'on' ? 'off' : 'on', reason: input.value.trim() });
        if (out.ok) { await loadChannels(); tell($('channel-status'), true, s.state === 'on' ? t('switched') : t('askedOn')); } else say(line, out, '');
      });
      acts.append(label, b); li.append(acts, line);
    }
    return li;
  }));
  const pend = channel?.pending ?? [];
  $('pending').replaceChildren(...(pend.length === 0 ? [Object.assign(document.createElement('li'), { textContent: t('noPending') })] : pend.map((r) => {
    const li = document.createElement('li'); li.dataset.request = r.requestId;
    const facts = document.createElement('span'); facts.textContent = fill(t('pendingLine'), { subject: subjectWords(r.subject), to: r.to === 'on' ? t('on') : t('off'), by: r.requestedBy, why: r.reason });
    li.append(facts);
    if (mayApprove) {
      const acts = document.createElement('div'); acts.className = 'acts';
      const label = document.createElement('label'); const span = document.createElement('span'); span.textContent = t('reasonFor');
      const input = document.createElement('input'); input.autocomplete = 'off'; input.setAttribute('aria-label', `${t('reasonFor')}: ${r.requestId}`); label.append(span, input);
      const b = document.createElement('button'); b.type = 'button'; b.dataset.act = 'approve'; b.textContent = t('approveOn');
      const line = document.createElement('p'); line.className = 'status'; line.setAttribute('role', 'status');
      b.addEventListener('click', async () => {
        if (input.value.trim() === '') { tell(line, false, t('needWhy')); return; }
        const out = await call('POST', `/v1/prices/channel-pricing/requests/${encodeURIComponent(r.requestId)}/approve`, { reason: input.value.trim() });
        if (out.ok) { await loadChannels(); tell($('channel-status'), true, t('switched')); } else say(line, out, '');
      });
      acts.append(label, b); li.append(acts, line);
    }
    return li;
  })));
  const same = $('v-same');
  if (channel === null) { same.textContent = t('notKnown'); same.classList.add('unknown'); }
  else { same.classList.remove('unknown'); same.textContent = channel.samePriceEverywhere ? t('yes') : fill(t('no'), { list: channel.switches.filter((s) => s.state === 'on').map((s) => subjectWords(s.subject)).join(', ') }); }
  const pv = $('v-pending'); pv.textContent = channel === null ? t('notKnown') : String(pend.length); pv.classList.toggle('unknown', channel === null);
  const zv = $('v-zoned'); zv.textContent = zones === null ? t('notKnown') : String(zones.length); zv.classList.toggle('unknown', zones === null);
}

function paint() {
  document.title = `SRE ${t('title')}`;
  for (const [id, k] of [['title', 'title'], ['page-h', 'title'], ['lead', 'lead'], ['k-same', 'kSame'], ['k-pending', 'kPending'], ['k-zoned', 'kZoned'],
    ['tab-prices', 'tabPrices'], ['tab-zones', 'tabZones'], ['tab-channels', 'tabChannels'], ['prices-h', 'tabPrices'], ['prices-lead', 'pricesLead'],
    ['l-p-product', 'product'], ['l-p-scope', 'scope'], ['o-store', 'store'], ['o-zone', 'zone'], ['o-channel', 'channel'], ['o-customer', 'customer'], ['l-p-ref', 'ref'], ['l-p-from', 'from'], ['l-p-to', 'to'], ['l-p-price', 'price'],
    ['k-mrp', 'kMrp'], ['k-cost', 'kCost'], ['k-floor', 'kFloor'], ['k-now', 'kNow'], ['k-size', 'kSize'], ['read-basis', 'readBasis'], ['save', 'save'], ['l-p-why', 'why'], ['ask', 'ask'],
    ['history-h', 'historyH'], ['c-scope', 'cScope'], ['c-ref', 'cRef'], ['c-price', 'cPrice'], ['c-from', 'cFrom'], ['c-to', 'cTo'], ['c-ver', 'cVer'],
    ['zones-h', 'tabZones'], ['zones-lead', 'zonesLead'], ['c-zstore', 'cZStore'], ['c-zone', 'cZone'], ['c-zby', 'cZBy'], ['c-zat', 'cZAt'], ['l-z-store', 'zStore'], ['l-z-zone', 'zZone'], ['z-save', 'zSave'],
    ['channels-h', 'tabChannels'], ['channels-lead', 'channelsLead'], ['pending-h', 'pendingH'], ['l-d-store', 'dStore'], ['d-run', 'dRun']]) { const el = $(id); if (el) el.textContent = t(k); }
  $('lang').textContent = t('lang');
  $('nobody').hidden = named; $('nobody').textContent = t('nobody');
  for (const id of ['p-from', 'p-to', 'p-price', 'read-basis', 'save', 'p-why']) $(id).disabled = !mayPropose;
  $('ask').hidden = pending === null || !mayPropose;
  for (const v of ['prices', 'zones', 'channels']) {
    $(`view-${v}`).hidden = tab !== v;
    if (v === tab) $(`tab-${v}`).setAttribute('aria-current', 'page'); else $(`tab-${v}`).removeAttribute('aria-current');
  }
  paintBasis(); paintHistory(); paintZones(); paintChannels();
}

function paintRefs() {
  const scope = $('p-scope').value;
  const refs = scope === 'store' ? stores : scope === 'zone' ? [...new Set((zones ?? []).map((z) => z.zoneId))] : scope === 'channel' ? ['app', 'delivery'] : [];
  $('ref-list').replaceChildren(...refs.map((r) => Object.assign(document.createElement('option'), { value: r })));
  $('store-list').replaceChildren(...stores.map((r) => Object.assign(document.createElement('option'), { value: r })));
}

async function loadChannels() {
  const [c, z] = await Promise.all([call('GET', '/v1/prices/channel-pricing'), call('GET', '/v1/prices/zones')]);
  channel = c.ok ? c.body : null;
  zones = z.ok && Array.isArray(z.body?.stores) ? z.body.stores : null;
  if (!c.ok) say($('page-status'), c, '');
  paintRefs(); paint();
}

async function loadHistory() {
  const id = $('p-product').value.trim();
  if (id === '') { history = null; paintHistory(); return; }
  const out = await call('GET', `/v1/prices/list/${encodeURIComponent(id)}/history`);
  history = out.ok && Array.isArray(out.body?.entries) ? out.body.entries : out.status === 404 ? [] : null;
  if (!out.ok && out.status !== 404) say($('price-status'), out, '');
  paintHistory();
}

async function readBasis() {
  const st = $('price-status');
  const id = $('p-product').value.trim(); const scope = $('p-scope').value; const ref = $('p-ref').value.trim(); const from = $('p-from').value;
  if (id === '' || ref === '' || from === '') { tell(st, false, t('needAll')); return false; }
  const out = await call('GET', `/v1/prices/list/${encodeURIComponent(id)}/basis?${new URLSearchParams({ scope, scopeRef: ref, on: from })}`);
  if (!out.ok) { basis = null; basisFor = ''; say(st, out, ''); paintBasis(); return false; }
  basis = out.body; basisFor = formKey();
  st.textContent = '';
  paintBasis();
  void loadHistory();
  return true;
}

$('p-scope').addEventListener('change', paintRefs);
for (const id of ['p-product', 'p-scope', 'p-ref', 'p-from', 'p-to', 'p-price']) $(id).addEventListener('change', () => { if (formKey() !== basisFor) { entryId = null; pending = null; $('ask').hidden = true; } });
$('p-product').addEventListener('change', () => { void loadHistory(); });
$('read-basis').addEventListener('click', () => { void readBasis(); });
$('save').addEventListener('click', async () => {
  const st = $('price-status');
  const id = $('p-product').value.trim(); const scope = $('p-scope').value; const ref = $('p-ref').value.trim();
  const from = $('p-from').value; const to = $('p-to').value; const price = $('p-price').value.trim();
  if (id === '' || ref === '' || from === '' || price === '') { tell(st, false, t('needAll')); return; }
  if (basis === null || basisFor !== formKey()) { if (!(await readBasis())) return; }
  if (basis.mrpMinor === null) { tell(st, false, t('noMrp')); return; }
  if (basis.costMinor === null || basis.costNotKnownAt.length > 0) { tell(st, false, fill(t('noCost'), { list: basis.costNotKnownAt.join(', ') })); return; }
  if (basis.marginFloorBps === null || basis.floorNotSetAt.length > 0) { tell(st, false, fill(t('noFloor'), { list: basis.floorNotSetAt.join(', ') })); return; }
  const priceMinor = Math.round(Number(price) * 100);
  if (entryId === null) entryId = `e-${from}-${scope}-${ref}-${Date.now().toString(36)}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 100);
  const body = {
    scope, scopeRef: ref, priceMinor: Number.isFinite(priceMinor) ? priceMinor : price, mrpMinor: basis.mrpMinor, costMinor: basis.costMinor,
    marginFloorBps: basis.marginFloorBps, currency: 'INR', effectiveFrom: from, ...(to === '' ? {} : { effectiveTo: to }),
  };
  const subjectRef = `${id}/${entryId}`;
  const details = { ...body, productId: id, entryId };
  const found = await ownApproval(subjectRef, details, body.priceMinor);
  if (found.waiting === true) { tell(st, false, t('waiting')); return; }
  const out = await call('POST', `/v1/prices/list/${encodeURIComponent(id)}/entries/${encodeURIComponent(entryId)}`, { ...body, ...(found.approvalId === undefined ? {} : { approvalId: found.approvalId }) });
  const code = out.body?.error?.code;
  if (!out.ok && (code === 'price_below_cost' || code === 'price_below_floor' || code === 'price_change_needs_second_person')) {
    pending = { subjectRef, details, valueMinor: body.priceMinor };
    $('ask').hidden = false;
    tell(st, false, found.rejected !== undefined ? fill(t('rejected'), { why: found.rejected }) : fill(t('needsApproval'), { why: out.body.error.whatHappened }));
    return;
  }
  if (!out.ok) { say(st, out, ''); return; }
  pending = null; entryId = null; $('ask').hidden = true;
  await loadHistory(); basisFor = '';
  tell($('price-status'), true, `${fill(t('saved'), { price: rupees(body.priceMinor), from, scope: scopeWords(scope), ref })}${found.decidedBy === undefined ? '' : ` ${fill(t('savedWith'), { by: found.decidedBy })}`}`);
});
$('ask').addEventListener('click', async () => {
  const st = $('price-status');
  const why = $('p-why').value.trim();
  if (why === '') { tell(st, false, t('needWhy')); return; }
  if (pending === null) return;
  const out = await call('POST', '/v1/approvals/requests', { kind: 'price_list_entry', subjectRef: pending.subjectRef, details: pending.details, valueMinor: pending.valueMinor, summary: `Price ${rupees(pending.valueMinor)} for ${pending.details.productId} (${pending.details.scope} ${pending.details.scopeRef}) from ${pending.details.effectiveFrom}`, reason: why });
  if (out.ok) { $('ask').hidden = true; tell(st, true, t('asked')); } else say(st, out, '');
});
$('z-save').addEventListener('click', async () => {
  const st = $('zone-status');
  const store = $('z-store').value.trim(); const zone = $('z-zone').value.trim();
  if (store === '' || zone === '') return;
  const out = await call('POST', `/v1/prices/zones/${encodeURIComponent(zone)}/stores/${encodeURIComponent(store)}`, {});
  if (out.ok) { await loadChannels(); tell($('zone-status'), true, t('zSaved')); } else say(st, out, '');
});
$('d-run').addEventListener('click', async () => {
  const st = $('channel-status');
  const store = $('d-store').value.trim();
  if (store === '') return;
  const out = await call('GET', `/v1/prices/channel-differences?${new URLSearchParams({ storeId: store })}`);
  if (!out.ok) { say(st, out, ''); return; }
  st.textContent = '';
  const lines = [...out.body.differences.map((d) => fill(t('diffLine'), { product: d.productId, channel: d.channel, ch: (d.channelPriceMinor / 100).toFixed(2), shelf: d.shelfPriceMinor === null ? t('notSet') : rupees(d.shelfPriceMinor) })),
    ...out.body.dormantEntries.map((d) => fill(t('dormant'), { product: d.productId, scope: scopeWords(d.scope), price: (d.priceMinor / 100).toFixed(2), ref: d.scopeRef, sw: subjectWords(d.switch) }))];
  $('differences').replaceChildren(...(lines.length === 0 ? [t('noDiff')] : lines).map((l) => Object.assign(document.createElement('li'), { textContent: l })));
});
for (const v of ['prices', 'zones', 'channels']) $(`tab-${v}`).addEventListener('click', () => { tab = v; paint(); });
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });

paint();
if (named && !mayRead) tell($('page-status'), false, t('noRight'));
if (named && mayRead) {
  $('p-from').value = today();
  if (!mayPropose) { $('page-status').className = 'status'; $('page-status').textContent = t('readOnly'); }
  const asked = new URLSearchParams(location.search).get('product');
  if (asked !== null && /^[A-Za-z0-9_.:-]{1,64}$/.test(asked)) $('p-product').value = asked;
  void Promise.all([call('GET', '/v1/catalogue/products'), call('GET', '/v1/org/nodes')]).then(([p, n]) => {
    if (p.ok) $('product-list').replaceChildren(...(p.body?.products ?? []).map((x) => { const o = document.createElement('option'); o.value = x.productId; o.label = x.name; return o; }));
    if (n.ok) stores = (n.body?.nodes ?? []).filter((x) => x.kind === 'branch' && x.status !== 'closed').map((x) => x.nodeId).sort();
    paintRefs();
  });
  void loadChannels();
  void loadHistory();
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => { /* the page still opens; it is not kept for offline use */ });
}
