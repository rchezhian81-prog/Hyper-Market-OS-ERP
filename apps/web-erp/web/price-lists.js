// Price lists (Round 4a · M05-FR-01 · D-19 · OB-148/190 · OB-291): a THIN CLIENT over head office's scoped, effective-dated
// price list. A price is for one store, a price zone, a channel or one customer, from a date (and until a date if it ends).
// Before it is sent the page reads head office's own figures for that scope and day — the MRP, the buying cost, the
// margin floor, the price in force and the owner's set size — and shows each one, or "Not known" / "not set" by name; a
// figure head office does not hold is never guessed, and the price is not sent without it. A price below cost or the
// floor, or a move beyond the set size, waits for a second person's approval of EXACTLY that entry. The stores' price zones
// and the channel / zone switches (all off until a second person approves switching one on) are on their own tabs. Every
// word has a Tamil twin; nothing is written on open.

const $ = (id) => document.getElementById(id);

// ── U2b (UI/UX gap audit G5 · P-07): a thing is PICKED by name through the chrome's picker, never typed as a code ───────
// The field keeps the id the page sends (the typed code stays possible when the list cannot be read — head office down,
// no right — so the form is never a dead end, P-01 · P-08); the chrome's sheet finds it by name, code or barcode and the
// name is shown beside the field. Mounted when the chrome is there (a page that paints first listens for `sre:chrome`).
// (one line on purpose: the page's own `  en: {` / `  ta: {` blocks stay the first ones the screen guardrails find)
const pickWords = { en: { choose: 'Choose…', pickProduct: 'Which product?', pickSupplier: 'Which supplier?', pickStore: 'Which store?', pickCustomer: 'Which customer?' }, ta: { choose: 'தேர்ந்தெடு…', pickProduct: 'எந்தப் பொருள்?', pickSupplier: 'எந்த விநியோகஸ்தர்?', pickStore: 'எந்தக் கடை?', pickCustomer: 'எந்த வாடிக்கையாளர்?' } };
const pw = (k) => pickWords[document.documentElement.lang === 'ta' ? 'ta' : 'en'][k] ?? pickWords.en[k];
const pickRepaints = [];
const repaintPickers = () => { for (const f of pickRepaints) f(); };
function pickable(inputId, kind, titleKey, extra = {}) {
  const input = document.getElementById(inputId);
  if (!input || input.dataset.pickable === 'on') return;
  const office = window.sreOffice;
  if (!office || typeof office.pick !== 'function') { document.addEventListener('sre:chrome', () => pickable(inputId, kind, titleKey, extra), { once: true }); return; }
  input.dataset.pickable = 'on';
  const row = document.createElement('div'); row.className = 'pick-row';
  input.replaceWith(row); row.append(input);
  const btn = document.createElement('button'); btn.type = 'button'; btn.id = `${inputId}-pick`; btn.className = 'sre-btn sre-btn-quiet pick';
  const name = document.createElement('span'); name.id = `${inputId}-name`; name.className = 'pick-name';
  row.append(btn, name);
  // the kind may depend on the form (a store price picks a store, a customer price a customer); null = no list exists, so no button
  const kindNow = () => (typeof kind === 'function' ? kind() : kind);
  const titleNow = () => (typeof titleKey === 'function' ? titleKey() : titleKey);
  const paint = () => { btn.hidden = kindNow() === null; btn.textContent = pw('choose'); btn.setAttribute('aria-label', `${pw('choose')} ${pw(titleNow())}`); };
  paint(); pickRepaints.push(paint);
  btn.addEventListener('click', async () => {
    const k = kindNow(); if (k === null) return;
    const tk = titleNow();
    const picked = await office.pick({ kind: k, title: { en: pickWords.en[tk], ta: pickWords.ta[tk] }, allowCode: true, ...(typeof extra.scope === 'function' ? { scope: extra.scope() } : {}), ...(typeof extra.filter === 'function' ? { filter: extra.filter } : {}) });
    if (!picked || picked.ok !== true) return;
    input.value = typeof extra.idOf === 'function' ? extra.idOf(picked) : String(picked.id ?? '');
    name.textContent = typeof picked.name === 'string' && picked.name !== input.value ? picked.name : '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    if (typeof extra.onPick === 'function') extra.onPick(picked);
  });
  input.addEventListener('input', (e) => { if (e.isTrusted) name.textContent = ''; });
}
const who = window.priceListsData && typeof window.priceListsData === 'object' ? window.priceListsData : null;
const perms = new Set(Array.isArray(who?.permissions) ? who.permissions : []);
const named = typeof who?.userId === 'string' && who.userId !== '';
const mayPropose = perms.has('price.change.propose');
const mayApprove = perms.has('price.change.approve');
const mayZone = perms.has('price.zone.manage');
const mayRead = perms.has('catalogue.pack.read') || mayPropose;
// W4 · OB-546 · ADR-0013: sending the signed pack is the catalogue keeper's own act — its own permission, and head office's step-up.
const mayPublishPack = perms.has('catalogue.pack.publish');
let lang = document.documentElement.lang === 'ta' ? 'ta' : 'en';

// U2 · G10 (UI/UX gap audit): a refusal says what happened, that nothing was changed, and the next safe action — the
// chrome's shared words (apps/web-erp/src/refusal-words.ts), never a raw code or HTTP status. The page's own prefix with
// head office's sentence stands in only until the chrome has loaded.
const refusalLine = (status, err) => {
  const office = window.sreOffice;
  if (office && typeof office.refusalWords === 'function') return office.refusalWords({ status, code: err?.code, whatHappened: err?.whatHappened, nextSafeAction: err?.nextSafeAction });
  const said = `${err?.whatHappened ?? ''} ${err?.nextSafeAction ?? ''}`.trim();
  return said === '' ? t('refused') : `${t('refused')} ${said}`;
};

const WORDS = {
  en: {
    lang: 'தமிழ்', title: 'Price lists',
    lead: 'Prices set ahead and for a scope: one store from a date, a price zone, a channel or one customer. Head office judges each on its own MRP, buying cost and margin floor, and a big move or a loss needs a second person.',
    kSame: 'One price everywhere?', kPending: 'Switch requests waiting', kZoned: 'Stores in a price zone', yes: 'Yes — every channel charges the shelf price', no: 'No — {list} on',
    tabPrices: 'Dated prices', tabZones: 'Price zones', tabChannels: 'Channel prices', tabPack: 'Send to the tills',
    packLead: 'Head office signs one pack of products and prices for a store; the store computer pulls it and the tills sell from it with no network. Look first at what would go and what is left out, then send it. Drafts, products with no price or no tax rate are never sent.',
    pkStore: 'Store', pkAsOf: 'Prices as of (date)', pkPreview: 'See what would go', pkPublish: 'Send to the tills', pkAck: 'Products you checked are leaving the tills (only if head office asks)',
    pkGoes: '{n} product(s) would go to the tills of {store} as of {day}.', pkLeft: 'Left out: {id} — {why}', pkNoneLeft: 'Nothing is left out.',
    pkSent: 'Sent. Catalogue pack version {v} is signed; each store computer takes it on its next pull.', pkNoRight: 'Only someone who keeps the catalogue may send a pack. You can look at what would go.',
    pkStepUp: 'This pack needs a fresh two-step sign-in, because {why} Sign out, sign in again with the code from your phone, then press “Send to the tills” again. Nothing was sent.',
    pkNeedStore: 'Write the store first.',
    why_draft_not_on_sale: 'a draft, not on sale', why_no_price: 'no price for this store that day', why_no_tax_class: 'no GST rate for its HSN that day', why_price_above_mrp: 'its price is above its MRP',
    why_cess_on_demerit_slab: 'a cess on the 40% slab would tax it twice', why_tobacco_warning_not_confirmed: 'its tobacco warning picture is not confirmed', why_liquor_not_sold: 'liquor is never sold', why_medicine_not_sold: 'medicines are never sold',
    pricesLead: 'Choose the product, which price and from when, then read head office\'s figures. The price is saved only when head office accepts it; the till charges it from the next store pack on or after its date.',
    product: 'Product', scope: 'Which price', store: 'One store\'s shelf price', zone: 'A price zone', channel: 'A channel (app, delivery)', customer: 'One customer',
    ref: 'Store, zone, channel or customer', from: 'From (date)', to: 'Until (date, if it ends)', price: 'Price (₹)',
    kMrp: 'MRP that day', kCost: 'Buying cost', kFloor: 'Margin floor', kNow: 'Price for this scope now', kSize: 'A second person checks a move of more than',
    readBasis: 'Read head office\'s figures', save: 'Save the price', why: 'Why (for the approver, if one is needed)', ask: 'Ask for approval',
    notKnown: 'Not known', notSet: 'not set', none: 'none yet', size: '{pct}% or ₹{amt}', stores: 'Judged at: {list}.',
    noMrp: 'Head office holds no MRP for this product on that day, so a price cannot be checked against it. Add the MRP on the Product details page first.',
    noCost: 'Head office knows no buying cost at {list} (nothing received at a cost yet), so the price cannot be checked against cost. It is not sent.',
    noFloor: 'No margin floor is set for {list} in the store rules, so the price cannot be checked against it. The owner sets it in Store setup first.',
    noStores: 'This scope reaches no store yet (a zone with no store in it).',
    needAll: 'Choose the product, which price, who or where it is for, and the date, and write the price.', needBasis: 'Read head office\'s figures first.', needWhy: 'Write the reason first.',
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
    tabPrices: 'தேதியிட்ட விலைகள்', tabZones: 'விலை மண்டலங்கள்', tabChannels: 'வழி விலைகள்', tabPack: 'கவுண்டர்களுக்கு அனுப்பு',
    packLead: 'தலைமை அலுவலகம் ஒரு கடைக்கான பொருட்களும் விலைகளும் அடங்கிய ஒரு பொதியில் கையொப்பமிடுகிறது; கடைக் கணினி அதை எடுத்துக்கொள்கிறது, கவுண்டர்கள் இணையம் இல்லாமலே அதிலிருந்து விற்கின்றன. முதலில் எது செல்லும், எது விடுபடும் என்று பாருங்கள், பிறகு அனுப்புங்கள். வரைவுகள், விலையோ வரி விகிதமோ இல்லாத பொருட்கள் ஒருபோதும் அனுப்பப்படாது.',
    pkStore: 'கடை', pkAsOf: 'விலைகள் இந்தத் தேதியின்படி', pkPreview: 'எது செல்லும் என்று பார்', pkPublish: 'கவுண்டர்களுக்கு அனுப்பு', pkAck: 'கவுண்டர்களிலிருந்து நீங்குவதாக நீங்கள் சரிபார்த்த பொருட்கள் (தலைமை அலுவலகம் கேட்டால் மட்டும்)',
    pkGoes: '{day} தேதியின்படி {store} கவுண்டர்களுக்கு {n} பொருள்(கள்) செல்லும்.', pkLeft: 'விடுபட்டது: {id} — {why}', pkNoneLeft: 'எதுவும் விடுபடவில்லை.',
    pkSent: 'அனுப்பப்பட்டது. பொருள் பொதி பதிப்பு {v} கையொப்பமிடப்பட்டது; ஒவ்வொரு கடைக் கணினியும் அடுத்த முறை எடுக்கும்போது அதைப் பெறும்.', pkNoRight: 'பொருள் பட்டியலைப் பராமரிப்பவர் மட்டுமே பொதியை அனுப்பலாம். எது செல்லும் என்று நீங்கள் பார்க்கலாம்.',
    pkStepUp: 'இந்தப் பொதிக்கு புதிய இரு-படி உள்நுழைவு தேவை, ஏனெனில் {why} வெளியேறி, உங்கள் தொலைபேசிக் குறியீட்டுடன் மீண்டும் உள்நுழைந்து, மீண்டும் “கவுண்டர்களுக்கு அனுப்பு” அழுத்துங்கள். எதுவும் அனுப்பப்படவில்லை.',
    pkNeedStore: 'முதலில் கடையை எழுதுங்கள்.',
    why_draft_not_on_sale: 'வரைவு, விற்பனையில் இல்லை', why_no_price: 'அன்று இந்தக் கடைக்கு விலை இல்லை', why_no_tax_class: 'அன்று அதன் HSN க்கு GST விகிதம் இல்லை', why_price_above_mrp: 'அதன் விலை MRP ஐ விட அதிகம்',
    why_cess_on_demerit_slab: '40% வரம்பில் செஸ் இருமுறை வரி விதிக்கும்', why_tobacco_warning_not_confirmed: 'அதன் புகையிலை எச்சரிக்கைப் படம் உறுதிசெய்யப்படவில்லை', why_liquor_not_sold: 'மதுபானம் ஒருபோதும் விற்கப்படாது', why_medicine_not_sold: 'மருந்துகள் ஒருபோதும் விற்கப்படாது',
    pricesLead: 'பொருள், எந்த விலை, எப்போதிலிருந்து என்பதைத் தேர்வு செய்து, தலைமை அலுவலக எண்களைப் படியுங்கள். தலைமை அலுவலகம் ஏற்றால் மட்டுமே விலை சேமிக்கப்படும்; அதன் தேதியிலோ பிறகோ வரும் அடுத்த கடைப் பொதியிலிருந்து கவுண்டர் அதை வசூலிக்கும்.',
    product: 'பொருள்', scope: 'எந்த விலை', store: 'ஒரு கடையின் அலமாரி விலை', zone: 'ஒரு விலை மண்டலம்', channel: 'ஒரு வழி (செயலி, டெலிவரி)', customer: 'ஒரு வாடிக்கையாளர்',
    ref: 'கடை, மண்டலம், வழி அல்லது வாடிக்கையாளர்', from: 'தொடங்கும் தேதி', to: 'முடியும் தேதி (முடிந்தால்)', price: 'விலை (₹)',
    kMrp: 'அன்றைய MRP', kCost: 'வாங்கும் விலை', kFloor: 'லாப வரம்பு', kNow: 'இந்த வரம்பின் இப்போதைய விலை', kSize: 'இதைவிட அதிக மாற்றத்தை இரண்டாம் நபர் சரிபார்ப்பார்',
    readBasis: 'தலைமை அலுவலக எண்களைப் படி', save: 'விலையைச் சேமி', why: 'ஏன் (ஒப்புதலாளருக்கு, தேவைப்பட்டால்)', ask: 'ஒப்புதல் கேள்',
    notKnown: 'தெரியவில்லை', notSet: 'அமைக்கப்படவில்லை', none: 'இன்னும் இல்லை', size: '{pct}% அல்லது ₹{amt}', stores: 'மதிப்பிடப்பட்ட கடைகள்: {list}.',
    noMrp: 'அந்த நாளுக்கு இந்தப் பொருளுக்கு MRP தலைமை அலுவலகத்தில் இல்லை, எனவே விலையை அதனுடன் சரிபார்க்க முடியாது. முதலில் பொருள் விவரங்கள் பக்கத்தில் MRP சேருங்கள்.',
    noCost: '{list}-இல் வாங்கும் விலை தலைமை அலுவலகத்திற்குத் தெரியாது (இன்னும் விலையுடன் எதுவும் பெறப்படவில்லை), எனவே விலையை அதனுடன் சரிபார்க்க முடியாது. அனுப்பப்படவில்லை.',
    noFloor: 'கடை விதிகளில் {list}-க்கு லாப வரம்பு அமைக்கப்படவில்லை, எனவே விலையை அதனுடன் சரிபார்க்க முடியாது. உரிமையாளர் முதலில் கடை அமைப்பில் அதை அமைக்கிறார்.',
    noStores: 'இந்த வரம்பு இன்னும் எந்தக் கடையையும் அடையவில்லை (கடை இல்லாத மண்டலம்).',
    needAll: 'பொருள், எந்த விலை, யாருக்கு அல்லது எங்கே, தேதி ஆகியவற்றைத் தேர்வு செய்து விலையை எழுதுங்கள்.', needBasis: 'முதலில் தலைமை அலுவலக எண்களைப் படியுங்கள்.', needWhy: 'முதலில் காரணத்தை எழுதுங்கள்.',
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

// U5 (G17): every list stands on the chrome's register part — built once per host, fed by setRows, repainted on the
// language toggle by the chrome itself (the column words are pairs).
const pair = (k) => ({ en: WORDS.en[k] ?? k, ta: (WORDS.ta ?? {})[k] ?? WORDS.en[k] ?? k });
const tables = {};
function register(host, spec) {
  if (!window.sreOffice) return null; // the chrome's parts arrive after this script
  const have = tables[spec.id];
  if (have && have.connected()) return have;
  tables[spec.id] = window.sreOffice.table(host, spec);
  return tables[spec.id];
}

// U2 · G14 (UI/UX gap audit): a date a shop person reads — dd/mm/yyyy in the chrome's shared field (`sreOffice.dateField`),
// while the page goes on sending ISO (`dateOf`). Before the chrome has loaded, or off the box, the field stays as it was.
const wordsIn = (l, k) => WORDS[l]?.[k] ?? WORDS.en[k] ?? k;
const shopDates = new Map();
/** The shared fields' labels follow the language toggle like the page's own words do. */
function repaintShopDates() { const l = document.documentElement.lang === 'ta' ? 'ta' : 'en'; for (const [id, words] of shopDates) { const lab = $(id)?.closest('.sre-field')?.querySelector('.sre-field-label'); if (lab && lab.firstChild) lab.firstChild.textContent = words[l] ?? words.en; } }
function shopDate(id, words, opts = {}) {
  const office = window.sreOffice; const input = $(id);
  if (!office || typeof office.dateField !== 'function' || input === null || shopDates.has(id)) return;
  // a value already on the plain field is carried over — ISO as the page set it, or dd/mm/yyyy as a person typed it
  const typed = input.value.trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(typed) ? typed : (typeof office.parseShopDate === 'function' ? office.parseShopDate(typed) : null);
  const field = office.dateField({ id, label: words, required: opts.required === true, ...(iso ? { value: iso } : {}), ...(opts.hint ? { hint: opts.hint } : {}) });
  (input.closest('label') ?? input).replaceWith(field);
  shopDates.set(id, words);
}
const dateOf = (id) => (shopDates.has(id) ? (window.sreOffice.dateValue(id) ?? '') : ($(id)?.value ?? ''));
const setShopDate = (id, iso) => { const n = $(id); if (n === null) return; if (shopDates.has(id)) n.closest('.sre-date')?.sreSetDate?.(iso); else n.value = iso; };
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
const say = (el, out, good) => tell(el, out.ok, out.ok ? good : out.status === 0 ? t('unreachable') : refusalLine(out.status, out.body?.error));
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
  const reg = register($('history-host'), {
    id: 'price-history', label: pair('historyH'), pageSize: 10, sortable: true, bodyId: 'history',
    columns: [
      { key: 'scope', label: pair('cScope'), value: (e) => scopeWords(e.scope) },
      { key: 'ref', label: pair('cRef'), value: (e) => `${e.scopeRef}${e.batchId === undefined ? '' : ` · ${e.batchId}`}` },
      { key: 'price', label: pair('cPrice'), value: (e) => rupees(e.price.minor), align: 'end' },
      { key: 'from', label: pair('cFrom'), value: (e) => shopDay(e.effectiveFrom) },
      { key: 'to', label: pair('cTo'), value: (e) => (e.effectiveTo ? shopDay(e.effectiveTo) : t('open')) },
      { key: 'ver', label: pair('cVer'), value: (e) => e.version, sort: 'number', align: 'end' },
    ],
    rowKey: (e) => e.id, rowData: (e) => ({ entry: e.id }),
    empty: { title: pair('noHistory') },
  });
  if (reg === null) return;
  // Before a product is chosen there is no list to read; once chosen, head office's answer or "Not known"
  if (history === null) reg.setState('unknown'); else reg.setRows(history);
}

function paintZones() {
  const reg = register($('zones-host'), {
    id: 'price-zones', label: pair('tabZones'), pageSize: 10, sortable: true, bodyId: 'zones',
    columns: [
      { key: 'store', label: pair('cZStore'), value: (z) => window.sreOffice.nameOf('store', z.storeId) ?? z.storeId },
      { key: 'zone', label: pair('cZone'), value: (z) => z.zoneId },
      { key: 'by', label: pair('cZBy'), value: (z) => window.sreOffice.nameOf('person', z.setBy) ?? z.setBy },
      { key: 'at', label: pair('cZAt'), value: (z) => shopTime(z.setAt) },
    ],
    rowKey: (z) => z.storeId, rowData: (z) => ({ store: z.storeId }),
    empty: { title: pair('noZones') },
  });
  if (reg === null) return;
  if (zones === null) reg.setState('unknown'); else reg.setRows(zones);
  for (const id of ['z-store', 'z-zone', 'z-save']) $(id).disabled = !mayZone;
  whyDisabled($('z-save'), mayZone ? '' : 'role');
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
      const b = document.createElement('button'); b.classList.add('sre-btn'); b.type = 'button'; b.dataset.act = 'approve'; b.textContent = t('approveOn');
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
  repaintShopDates();
  document.title = `SRE ${t('title')}`;
  for (const [id, k] of [['title', 'title'], ['page-h', 'title'], ['lead', 'lead'], ['k-same', 'kSame'], ['k-pending', 'kPending'], ['k-zoned', 'kZoned'],
    ['tab-prices', 'tabPrices'], ['tab-zones', 'tabZones'], ['tab-channels', 'tabChannels'], ['tab-pack', 'tabPack'], ['pack-h', 'tabPack'], ['pack-lead', 'packLead'], ['l-pk-store', 'pkStore'], ['l-pk-asof', 'pkAsOf'], ['pk-preview', 'pkPreview'], ['pk-publish', 'pkPublish'], ['l-pk-ack', 'pkAck'], ['prices-h', 'tabPrices'], ['prices-lead', 'pricesLead'],
    ['l-p-product', 'product'], ['l-p-scope', 'scope'], ['o-store', 'store'], ['o-zone', 'zone'], ['o-channel', 'channel'], ['o-customer', 'customer'], ['l-p-ref', 'ref'], ['l-p-from', 'from'], ['l-p-to', 'to'], ['l-p-price', 'price'],
    ['k-mrp', 'kMrp'], ['k-cost', 'kCost'], ['k-floor', 'kFloor'], ['k-now', 'kNow'], ['k-size', 'kSize'], ['read-basis', 'readBasis'], ['save', 'save'], ['l-p-why', 'why'], ['ask', 'ask'],
    ['history-h', 'historyH'], 
    ['zones-h', 'tabZones'], ['zones-lead', 'zonesLead'],  ['l-z-store', 'zStore'], ['l-z-zone', 'zZone'], ['z-save', 'zSave'],
    ['channels-h', 'tabChannels'], ['channels-lead', 'channelsLead'], ['pending-h', 'pendingH'], ['l-d-store', 'dStore'], ['d-run', 'dRun']]) { const el = $(id); if (el) el.textContent = t(k); }
  $('lang').textContent = t('lang');
  $('nobody').hidden = named; $('nobody').textContent = t('nobody');
  for (const id of ['p-from', 'p-to', 'p-price', 'read-basis', 'save', 'p-why']) $(id).disabled = !mayPropose;
  whyDisabled($('read-basis'), mayPropose ? '' : 'role'); whyDisabled($('save'), mayPropose ? '' : 'role');
  $('ask').hidden = pending === null || !mayPropose;
  $('pk-publish').disabled = !mayPublishPack; $('pk-ack').disabled = !mayPublishPack; whyDisabled($('pk-publish'), mayPublishPack ? '' : 'role');
  $('pk-note').textContent = mayPublishPack ? '' : t('pkNoRight');
  for (const v of ['prices', 'zones', 'channels', 'pack']) {
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
  const id = $('p-product').value.trim(); const scope = $('p-scope').value; const ref = $('p-ref').value.trim(); const from = dateOf('p-from');
  if (id === '' || ref === '' || from === '') { tell(st, false, t('needAll')); return false; }
  const out = await call('GET', `/v1/prices/list/${encodeURIComponent(id)}/basis?${new URLSearchParams({ scope, scopeRef: ref, on: from })}`);
  if (!out.ok) { basis = null; basisFor = ''; say(st, out, ''); paintBasis(); return false; }
  basis = out.body; basisFor = formKey();
  st.textContent = '';
  paintBasis();
  void loadHistory();
  return true;
}

$('p-scope').addEventListener('change', () => { paintRefs(); repaintPickers(); });
for (const id of ['p-product', 'p-scope', 'p-ref', 'p-from', 'p-to', 'p-price']) $(id).addEventListener('change', () => { if (formKey() !== basisFor) { entryId = null; pending = null; $('ask').hidden = true; } });
$('p-product').addEventListener('change', () => { void loadHistory(); });
$('read-basis').addEventListener('click', () => { void readBasis(); });
$('save').addEventListener('click', async () => {
  const st = $('price-status');
  const id = $('p-product').value.trim(); const scope = $('p-scope').value; const ref = $('p-ref').value.trim();
  const from = dateOf('p-from'); const to = dateOf('p-to'); const price = $('p-price').value.trim();
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
for (const v of ['prices', 'zones', 'channels', 'pack']) $(`tab-${v}`).addEventListener('click', () => { tab = v; paint(); });

// ── W4 · Send to the tills: preview head office's pack for a store, then send it (its own permission; head office's step-up) ──
// U2c: the pack's day on the shared dd/mm field (the last native date on this page); ISO goes to head office as before.
const packOf = () => ({ storeId: $('pk-store').value.trim(), asOf: dateOf('pk-asof') || today() });
$('pk-preview').addEventListener('click', async () => {
  const st = $('pk-status'); const { storeId, asOf } = packOf();
  if (storeId === '') { tell(st, false, t('pkNeedStore')); return; }
  const out = await call('GET', `/v1/catalogue/pack/preview?${new URLSearchParams({ storeId, asOf })}`);
  if (!out.ok) { say(st, out, ''); return; }
  st.className = 'status'; st.textContent = fill(t('pkGoes'), { n: out.body.includedCount ?? out.body.snapshot?.products?.length ?? 0, store: storeId, day: asOf });
  const left = [...(out.body.excluded ?? []), ...(out.body.notSold ?? [])];
  $('pk-left').replaceChildren(...(left.length === 0 ? [t('pkNoneLeft')] : left.map((x) => fill(t('pkLeft'), { id: x.productId, why: WORDS[lang][`why_${x.reason}`] ?? x.reason })))
    .map((line) => Object.assign(document.createElement('li'), { textContent: line })));
});
$('pk-publish').addEventListener('click', async () => {
  const st = $('pk-status'); const { storeId, asOf } = packOf();
  if (!mayPublishPack) { tell(st, false, t('pkNoRight')); return; }
  if (storeId === '') { tell(st, false, t('pkNeedStore')); return; }
  const ack = $('pk-ack').value.trim();
  const out = await call('POST', '/v1/catalogue/pack', { storeId, asOf, ...(/^\d+$/.test(ack) && Number(ack) > 0 ? { acknowledgedRemovals: Number(ack) } : {}) });
  if (out.status === 403 && out.body?.error?.code === 'reauthentication_required') { tell(st, false, fill(t('pkStepUp'), { why: out.body.error.whatHappened })); return; }
  say(st, out, fill(t('pkSent'), { v: out.body?.version ?? '' }));
});
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); repaintPickers(); });

paint();
if (named && !mayRead) tell($('page-status'), false, t('noRight'));
if (named && mayRead) {
  setShopDate('p-from', today());
  $('pk-asof').value = today();
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

/** A greyed button says why (U1 · G3 · design system §4 "disabled state explains why"): the reason is the button's tooltip
 *  and the words beside it, in the reader's language. `why` is 'role' (your role may not), 'offline' (head office cannot
 *  be reached), a page's own { en, ta } pair or sentence; '' takes the words away. */
function whyWords() {
  return {
  role: { en: 'Your role may not do this.', ta: 'உங்கள் பங்குக்கு இதைச் செய்ய அனுமதி இல்லை.' },
  offline: { en: 'Head office cannot be reached, so this cannot be done now.', ta: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை, எனவே இப்போது இதைச் செய்ய முடியாது.' },
  };
}
function whyDisabled(btn, why) {
  const tongue = document.documentElement.lang === 'ta' ? 'ta' : 'en';
  const words = why === '' || why === undefined || why === null ? '' : typeof why === 'string' ? (whyWords()[why]?.[tongue] ?? why) : (why[tongue] ?? why.en);
  let note = btn.nextElementSibling;
  if (!(note && note.classList.contains('sre-why'))) {
    note = document.createElement('small'); note.className = 'sre-why';
    note.id = `${btn.id || `b${Math.random().toString(36).slice(2, 7)}`}-why`;
    btn.after(note);
  }
  note.textContent = words; note.hidden = words === '';
  if (words === '') { btn.removeAttribute('title'); btn.removeAttribute('aria-describedby'); } else { btn.title = words; btn.setAttribute('aria-describedby', note.id); }
}
// the chrome loads after this script: its shared date fields replace the plain ones once it is there
document.addEventListener('sre:chrome', () => { shopDate('p-from', { en: wordsIn('en', 'from'), ta: wordsIn('ta', 'from') }); shopDate('p-to', { en: wordsIn('en', 'to'), ta: wordsIn('ta', 'to') }); shopDate('pk-asof', { en: wordsIn('en', 'pkAsOf'), ta: wordsIn('ta', 'pkAsOf') }); paint(); }, { once: true });

pickable('p-product', 'product', 'pickProduct');
// a store price picks a store, a customer price a customer; a zone or a channel has no list to pick from (typed, as before)
pickable('p-ref', () => ({ store: 'store', customer: 'customer' })[$('p-scope').value] ?? null, () => ($('p-scope').value === 'customer' ? 'pickCustomer' : 'pickStore'));
// U5: the chrome's parts arrive after this script (sre-chrome.js is the page's last script) — paint again once they are here.
document.addEventListener('sre:chrome', () => { paint(); }, { once: true });
