// Product details (Round 4a · M03-FR-01/02/03/04 · WF-01 · re-audit G-1): a THIN CLIENT over head office's product master.
// One product at a time: its record (a new version on each save, through the same publish route and the same tested rules
// as every other door; once published, its safety, label and nutrition facts save on their own route naming the version
// the page opened — owner 2A: someone else's newer save is refused by head office, never overwritten), its barcodes and pack hierarchy, the bundle it is sold as and the products that may stand in for
// it. Head office answers every question and makes every refusal; the page shows its words. A change that needs a second
// person (a published product's tax class, a new age limit or tobacco) is asked for here, decided by that person on their
// own Approvals page, and then saved naming that approval. Every word has a Tamil twin; nothing is written on open.

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
const who = window.productDetailsData && typeof window.productDetailsData === 'object' ? window.productDetailsData : null;
const perms = new Set(Array.isArray(who?.permissions) ? who.permissions : []);
const named = typeof who?.userId === 'string' && who.userId !== '';
const mayRead = perms.has('catalogue.pack.read');
const mayEdit = perms.has('catalogue.pack.publish');
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

const NUTRIENTS = [['energyKcal', 'energy (kcal)', 'ஆற்றல் (கிலோ கலோரி)'], ['proteinG', 'protein (g)', 'புரதம் (கி)'], ['carbohydrateG', 'carbohydrate (g)', 'கார்போஹைட்ரேட் (கி)'],
  ['totalSugarsG', 'total sugars (g)', 'மொத்த சர்க்கரை (கி)'], ['addedSugarsG', 'added sugars (g)', 'சேர்க்கப்பட்ட சர்க்கரை (கி)'], ['totalFatG', 'total fat (g)', 'மொத்த கொழுப்பு (கி)'],
  ['saturatedFatG', 'saturated fat (g)', 'நிறைவுற்ற கொழுப்பு (கி)'], ['transFatG', 'trans fat (g)', 'டிரான்ஸ் கொழுப்பு (கி)'], ['cholesterolMg', 'cholesterol (mg)', 'கொலஸ்ட்ரால் (மி.கி)'], ['sodiumMg', 'sodium (mg)', 'சோடியம் (மி.கி)']];

const WORDS = {
  en: {
    lang: 'தமிழ்', title: 'Product details',
    lead: 'Everything head office holds about one product: its record, its barcodes and packs, the bundle it is sold as and what may stand in for it. Each change is a new version with your name; head office checks it and says exactly what still blocks it.',
    product: 'Product', show: 'Show', kState: 'Where it stands', kCodes: 'Barcodes', kPack: 'Pack', kBundle: 'Bundle', kSubs: 'Substitutes',
    tabRecord: 'Record', tabCodes: 'Barcodes and packs', tabBundle: 'Bundle', tabSubs: 'Substitutes',
    recordLead: 'What the tills, the app and the reports read about this product. A draft keeps whatever you know; head office will not put it on sale until the category, tax class and the safety facts its category needs are there.',
    name: 'Name', sku: 'SKU', baseUom: 'Unit it is counted in', category: 'Category', noCategory: 'Not chosen', brand: 'Brand', manufacturer: 'Manufacturer', parent: 'A variant of (the parent product)',
    taxClass: 'Tax (HSN) class', lifecycle: 'Lifecycle', draft: 'Draft', new: 'New', active: 'Active', clearance: 'Clearance', discontinued: 'Discontinued',
    mrpH: 'MRP', mrpFrom: 'New MRP from (date)', mrpRupees: 'New MRP (₹)', noMrp: 'No MRP on record yet.', mrpLine: 'from',
    safetyH: 'Safety and label', ingredients: 'Ingredients', allergens: 'Allergens it contains (comma between)', none: 'Contains none of the allergens (declared)',
    origin: 'Country of origin', storage: 'Storage conditions', net: 'Net quantity as printed', packer: 'Packer or importer', care: 'Consumer care contact', packedBySre: 'SRE packs or labels it',
    nutritionH: 'Nutrition (per 100 g or 100 ml)', nutritionLead: 'Needed before publishing only for food SRE packs or labels itself (OB-307); recorded when known otherwise. Leave every box empty for no panel; write 0 for a nutrient there is none of.',
    basis: 'Per', per100g: '100 g', per100ml: '100 ml', serving: 'Serving size (g or ml, if printed)',
    why: 'Why (kept with the version)', save: 'Save as a new version', ask: 'Ask for approval',
    codesLead: 'Every code that names this product — one code names exactly one product — and how its cases and inners count down to the single unit.',
    code: 'Barcode', kind: 'Kind', internal: "Shop's own", case: 'Case', embedded: 'Weight or price inside', level: 'Pack level (if not a single)', addBarcode: 'Give this barcode',
    noBarcodes: 'No barcode is on record for this product.', packH: 'Pack hierarchy', packLead: 'Start with the single unit (it holds 1). Each level above holds a whole number of the level below — head office refuses anything inexact.',
    levelName: 'Level', holds: 'Holds (of the level below)', levelCode: 'Barcode on this level (optional)', savePack: 'Save the pack', noPack: 'not defined',
    cvQty: 'How many', cvLevel: 'Of which level', convert: 'Work out the units', converted: '{q} {level} = {n} {uom}',
    bundleLead: 'If this product is a bundle with its own barcode (OB-306), what one bundle holds. Selling one takes stock off each component. (A "3 for ₹199" price offer is made on the Offer tab instead.)',
    notBundle: 'This product is not a bundle.', bundleIs: 'Version {v} in force, set by {by}.', component: 'Component product', compQty: 'How many (in its own unit: pieces, grams or ml)', saveBundle: 'Save what the bundle holds',
    subsLead: 'The products a picker may offer in its place, in the order to try them. No age-limited or unsellable product can be on it. The customer app shows the same list.',
    subsNotSet: 'No list has been set.', subsSetNone: 'Set to none — nothing stands in for it.', subsIs: 'Version {v}, set by {by}: {why}', subsList: 'Product ids, in the order to try them (comma between; empty clears it)', saveSubs: 'Save the list',
    needWhy: 'Write the reason first.', needId: 'Choose the product first.', saved: 'Saved.', refused: 'Head office refused:', unreachable: 'Head office could not be reached. Nothing was saved — try again.',
    cannotRead: 'This product could not be read from head office.', isNew: 'Head office has no product with this id yet. Fill in what you know and save it — it is kept as a draft until it is complete.',
    readOnly: 'You can read this product. Changes are made by the person who keeps the catalogue.', noRight: 'This account may not read the product master.', nobody: 'Nobody is signed in on this computer, so nothing can be shown.',
    needsApproval: 'This needs a second person: {why} Press “Ask for approval”; once they approve it on their Approvals page, press “Save as a new version” again.',
    asked: 'Asked. It waits for the second person on their Approvals page; nothing is saved until then.', waiting: 'Still waiting for the second person to decide. Nothing was saved.',
    rejectedBy: 'The second person rejected it: {why}', usingApproval: 'Saved with the approval of {by}.',
    stateDraft: 'Draft — not on sale', stateNew: 'New — on sale', stateActive: 'On sale', stateClearance: 'Clearance — on sale', stateDiscontinued: 'Discontinued — not sold', stateNotYet: 'Not saved yet',
    safetySaveH: 'Save the safety, label and nutrition facts', safetySaveLead: 'These facts are saved on their own, with the version you opened. If someone else saved this product since, head office refuses and nothing of yours is saved — nobody’s change is ever overwritten.',
    saveSafety: 'Save safety and label', reload: 'Reload', safetyFirst: 'This product is not saved yet: its safety and label facts go with the record the first time — press “Save as a new version”.',
    changedMeanwhile: 'Someone else saved this product after you opened it. Nothing of yours was saved. Press “Reload” to see what is held now, then make your change again.',
    minAge: 'Minimum age to buy it (years — leave empty if none)', keptDraft: 'Kept as a draft — not on sale and not in any pack. Before it can go on sale it still needs: {list}.', draftComplete: 'Kept as a draft — not on sale and not in any pack. It is complete: choose New or Active and save to put it on sale.',
    needsApprovalSafety: 'This needs a second person: {why} Press “Ask for approval”; once they approve it on their Approvals page, press “Save safety and label” again.',
    useSafetySave: 'You changed the safety, label or nutrition facts: save them with “Save safety and label” below. Nothing was saved.', savedVersion: 'Saved — version {v}.',
    yes: 'yes', count: '{n} on record', defined: '{n} levels', subsCount: '{n} in order', notSet: 'not set', notKnown: 'Not known', by: 'by', version: 'Version', attrsFor: 'Attributes of this category',
  },
  ta: {
    lang: 'English', title: 'பொருள் விவரங்கள்',
    lead: 'ஒரு பொருளைப் பற்றி தலைமை அலுவலகம் வைத்திருப்பவை அனைத்தும்: அதன் பதிவு, பார்கோடுகளும் பொதிகளும், அது விற்கப்படும் தொகுப்பு, அதற்குப் பதிலாக வரக்கூடியவை. ஒவ்வொரு மாற்றமும் உங்கள் பெயருடன் புதிய பதிப்பு; தலைமை அலுவலகம் சரிபார்த்து, இன்னும் தடுப்பது என்ன என்று சொல்லும்.',
    product: 'பொருள்', show: 'காட்டு', kState: 'நிலை', kCodes: 'பார்கோடுகள்', kPack: 'பொதி', kBundle: 'தொகுப்பு', kSubs: 'மாற்றுப் பொருட்கள்',
    tabRecord: 'பதிவு', tabCodes: 'பார்கோடுகளும் பொதிகளும்', tabBundle: 'தொகுப்பு', tabSubs: 'மாற்றுப் பொருட்கள்',
    recordLead: 'இந்தப் பொருளைப் பற்றி கவுண்டர்கள், செயலி, அறிக்கைகள் படிப்பது. வரைவு உங்களுக்குத் தெரிந்ததை வைத்துக்கொள்ளும்; வகை, வரி வகுப்பு, அதன் வகைக்குத் தேவையான பாதுகாப்புத் தகவல்கள் இருக்கும் வரை தலைமை அலுவலகம் அதை விற்பனைக்கு வைக்காது.',
    name: 'பெயர்', sku: 'SKU', baseUom: 'எண்ணப்படும் அலகு', category: 'வகை', noCategory: 'தேர்வு செய்யவில்லை', brand: 'பிராண்ட்', manufacturer: 'உற்பத்தியாளர்', parent: 'இதன் வகைமாறு (தாய் பொருள் எண்)',
    taxClass: 'வரி (HSN) வகுப்பு', lifecycle: 'வாழ்க்கைச் சுழற்சி', draft: 'வரைவு', new: 'புதியது', active: 'செயலில்', clearance: 'விற்றுத்தீர்ப்பு', discontinued: 'நிறுத்தப்பட்டது',
    mrpH: 'MRP', mrpFrom: 'புதிய MRP தொடங்கும் தேதி', mrpRupees: 'புதிய MRP (₹)', noMrp: 'இன்னும் MRP பதிவில் இல்லை.', mrpLine: 'முதல்',
    safetyH: 'பாதுகாப்பும் லேபிளும்', ingredients: 'உட்பொருட்கள்', allergens: 'இதில் உள்ள ஒவ்வாமைப் பொருட்கள் (காற்புள்ளியால் பிரிக்கவும்)', none: 'எந்த ஒவ்வாமைப் பொருளும் இல்லை (அறிவிக்கப்பட்டது)',
    origin: 'பிறப்பிட நாடு', storage: 'சேமிப்பு நிலைகள்', net: 'அச்சிட்ட நிகர அளவு', packer: 'பொதி செய்தவர் அல்லது இறக்குமதியாளர்', care: 'வாடிக்கையாளர் தொடர்பு', packedBySre: 'SRE பொதி செய்கிறது அல்லது லேபிள் இடுகிறது',
    nutritionH: 'ஊட்டச்சத்து (100 கி அல்லது 100 மி.லி-க்கு)', nutritionLead: 'SRE தானே பொதி செய்யும் அல்லது லேபிள் இடும் உணவுக்கு மட்டுமே வெளியிடும் முன் தேவை (OB-307); மற்றவற்றுக்குத் தெரிந்தால் பதியப்படும். அட்டவணை இல்லையெனில் எல்லாப் பெட்டிகளையும் காலியாக விடுங்கள்; இல்லாத சத்துக்கு 0 எழுதுங்கள்.',
    basis: 'அளவு', per100g: '100 கி', per100ml: '100 மி.லி', serving: 'ஒரு பரிமாறல் (கி அல்லது மி.லி, அச்சிட்டிருந்தால்)',
    why: 'ஏன் (பதிப்புடன் வைக்கப்படும்)', save: 'புதிய பதிப்பாகச் சேமி', ask: 'ஒப்புதல் கேள்',
    codesLead: 'இந்தப் பொருளைக் குறிக்கும் ஒவ்வொரு குறியீடும் — ஒரு குறியீடு ஒரே ஒரு பொருளைக் குறிக்கும் — அதன் பெட்டிகளும் உள்பொதிகளும் ஒற்றை அலகு வரை எப்படி எண்ணப்படுகின்றன என்பதும்.',
    code: 'பார்கோடு', kind: 'வகை', internal: 'கடையின் சொந்தம்', case: 'பெட்டி', embedded: 'உள்ளே எடை அல்லது விலை', level: 'பொதி நிலை (ஒற்றை அல்லவெனில்)', addBarcode: 'இந்த பார்கோடைக் கொடு',
    noBarcodes: 'இந்தப் பொருளுக்கு எந்த பார்கோடும் பதிவில் இல்லை.', packH: 'பொதி அடுக்கு', packLead: 'ஒற்றை அலகிலிருந்து தொடங்குங்கள் (அது 1 கொண்டது). மேலுள்ள ஒவ்வொரு நிலையும் கீழுள்ள நிலையின் முழு எண்ணிக்கையைக் கொண்டிருக்க வேண்டும் — துல்லியமில்லாததைத் தலைமை அலுவலகம் மறுக்கும்.',
    levelName: 'நிலை', holds: 'கொண்டிருப்பது (கீழுள்ள நிலையில்)', levelCode: 'இந்த நிலையின் பார்கோடு (விருப்பம்)', savePack: 'பொதியைச் சேமி', noPack: 'வரையறுக்கப்படவில்லை',
    cvQty: 'எத்தனை', cvLevel: 'எந்த நிலை', convert: 'அலகுகளைக் கணக்கிடு', converted: '{q} {level} = {n} {uom}',
    bundleLead: 'இந்தப் பொருள் சொந்த பார்கோடு கொண்ட தொகுப்பு எனில் (OB-306), ஒரு தொகுப்பில் இருப்பவை. ஒன்றை விற்றால் ஒவ்வொரு கூறிலிருந்தும் சரக்கு குறையும். ("3 ₹199" விலைச் சலுகை சலுகை தாவலில் செய்யப்படும்.)',
    notBundle: 'இந்தப் பொருள் தொகுப்பு அல்ல.', bundleIs: 'பதிப்பு {v} நடைமுறையில், அமைத்தவர் {by}.', component: 'கூறுப் பொருள்', compQty: 'எத்தனை (அதன் அலகில்: எண்ணிக்கை, கிராம் அல்லது மி.லி)', saveBundle: 'தொகுப்பில் இருப்பதைச் சேமி',
    subsLead: 'இதற்குப் பதிலாக எடுப்பவர் வழங்கக்கூடிய பொருட்கள், முயற்சிக்க வேண்டிய வரிசையில். வயது வரம்புள்ள அல்லது விற்க முடியாத பொருள் இதில் இருக்க முடியாது. வாடிக்கையாளர் செயலியும் இதே பட்டியலைக் காட்டும்.',
    subsNotSet: 'பட்டியல் அமைக்கப்படவில்லை.', subsSetNone: 'எதுவுமில்லை என அமைக்கப்பட்டது — இதற்குப் பதில் எதுவும் வராது.', subsIs: 'பதிப்பு {v}, அமைத்தவர் {by}: {why}', subsList: 'பொருள் எண்கள், முயற்சிக்கும் வரிசையில் (காற்புள்ளியால் பிரிக்கவும்; காலியெனில் அழிக்கும்)', saveSubs: 'பட்டியலைச் சேமி',
    needWhy: 'முதலில் காரணத்தை எழுதுங்கள்.', needId: 'முதலில் பொருளைத் தேர்ந்தெடுங்கள்.', saved: 'சேமிக்கப்பட்டது.', refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை. எதுவும் சேமிக்கப்படவில்லை — மீண்டும் முயலவும்.',
    cannotRead: 'இந்தப் பொருளைத் தலைமை அலுவலகத்திலிருந்து படிக்க முடியவில்லை.', isNew: 'இந்த எண்ணில் தலைமை அலுவலகத்தில் இன்னும் பொருள் இல்லை. தெரிந்ததை நிரப்பிச் சேமியுங்கள் — முழுமையாகும் வரை வரைவாக வைக்கப்படும்.',
    readOnly: 'இந்தப் பொருளை நீங்கள் படிக்கலாம். பட்டியலைப் பராமரிப்பவர் மாற்றங்களைச் செய்வார்.', noRight: 'இந்தக் கணக்கு பொருள் பதிவேட்டைப் படிக்க முடியாது.', nobody: 'இந்தக் கணினியில் யாரும் உள்நுழையவில்லை, எனவே எதையும் காட்ட முடியாது.',
    needsApproval: 'இதற்கு இரண்டாம் நபர் தேவை: {why} “ஒப்புதல் கேள்” அழுத்துங்கள்; அவர் தனது ஒப்புதல்கள் பக்கத்தில் ஒப்புக்கொண்டதும், மீண்டும் “புதிய பதிப்பாகச் சேமி” அழுத்துங்கள்.',
    asked: 'கேட்கப்பட்டது. இரண்டாம் நபரின் ஒப்புதல்கள் பக்கத்தில் காத்திருக்கிறது; அதுவரை எதுவும் சேமிக்கப்படாது.', waiting: 'இரண்டாம் நபர் இன்னும் முடிவு செய்யவில்லை. எதுவும் சேமிக்கப்படவில்லை.',
    rejectedBy: 'இரண்டாம் நபர் நிராகரித்தார்: {why}', usingApproval: '{by} அவர்களின் ஒப்புதலுடன் சேமிக்கப்பட்டது.',
    stateDraft: 'வரைவு — விற்பனையில் இல்லை', stateNew: 'புதியது — விற்பனையில்', stateActive: 'விற்பனையில்', stateClearance: 'விற்றுத்தீர்ப்பு — விற்பனையில்', stateDiscontinued: 'நிறுத்தப்பட்டது — விற்கப்படாது', stateNotYet: 'இன்னும் சேமிக்கப்படவில்லை',
    safetySaveH: 'பாதுகாப்பு, லேபிள், ஊட்டச்சத்து விவரங்களைச் சேமி', safetySaveLead: 'இந்த விவரங்கள் நீங்கள் திறந்த பதிப்புடன் தனியாகச் சேமிக்கப்படும். அதன் பிறகு வேறொருவர் இந்தப் பொருளைச் சேமித்திருந்தால், தலைமை அலுவலகம் மறுக்கும்; உங்களுடையது எதுவும் சேமிக்கப்படாது — யாருடைய மாற்றமும் அழிக்கப்படாது.',
    saveSafety: 'பாதுகாப்பையும் லேபிளையும் சேமி', reload: 'மீண்டும் ஏற்று', safetyFirst: 'இந்தப் பொருள் இன்னும் சேமிக்கப்படவில்லை: முதல் முறை அதன் பாதுகாப்பு, லேபிள் விவரங்கள் பதிவுடன் சேர்ந்து செல்லும் — “புதிய பதிப்பாகச் சேமி” அழுத்துங்கள்.',
    changedMeanwhile: 'நீங்கள் திறந்த பிறகு வேறொருவர் இந்தப் பொருளைச் சேமித்துவிட்டார். உங்களுடையது எதுவும் சேமிக்கப்படவில்லை. இப்போது உள்ளதைப் பார்க்க “மீண்டும் ஏற்று” அழுத்தி, உங்கள் மாற்றத்தை மீண்டும் செய்யுங்கள்.',
    minAge: 'வாங்கக் குறைந்தபட்ச வயது (ஆண்டுகள் — இல்லையெனில் காலியாக விடுங்கள்)', keptDraft: 'வரைவாக வைக்கப்பட்டது — விற்பனையில் இல்லை, எந்தப் பொதியிலும் இல்லை. விற்பனைக்கு வருவதற்கு முன் இன்னும் தேவை: {list}.', draftComplete: 'வரைவாக வைக்கப்பட்டது — விற்பனையில் இல்லை, எந்தப் பொதியிலும் இல்லை. இது முழுமையானது: விற்பனைக்கு வைக்க புதியது அல்லது செயலில் என்பதைத் தேர்வு செய்து சேமியுங்கள்.',
    needsApprovalSafety: 'இதற்கு இரண்டாம் நபர் தேவை: {why} “ஒப்புதல் கேள்” அழுத்துங்கள்; அவர் தனது ஒப்புதல்கள் பக்கத்தில் ஒப்புக்கொண்டதும், மீண்டும் “பாதுகாப்பையும் லேபிளையும் சேமி” அழுத்துங்கள்.',
    useSafetySave: 'பாதுகாப்பு, லேபிள் அல்லது ஊட்டச்சத்து விவரங்களை மாற்றியுள்ளீர்கள்: கீழே உள்ள “பாதுகாப்பையும் லேபிளையும் சேமி” மூலம் சேமியுங்கள். எதுவும் சேமிக்கப்படவில்லை.', savedVersion: 'சேமிக்கப்பட்டது — பதிப்பு {v}.',
    yes: 'ஆம்', count: '{n} பதிவில்', defined: '{n} நிலைகள்', subsCount: '{n} வரிசையில்', notSet: 'அமைக்கப்படவில்லை', notKnown: 'தெரியவில்லை', by: 'செய்தவர்', version: 'பதிப்பு', attrsFor: 'இந்த வகையின் பண்புகள்',
  },
};
const t = (k) => WORDS[lang]?.[k] ?? WORDS.en[k] ?? k;

// U2 · G14 (UI/UX gap audit): a date a shop person reads — dd/mm/yyyy in the chrome's shared field (`sreOffice.dateField`),
// while the page goes on sending ISO (`dateOf`). Before the chrome has loaded, or off the box, the field stays as it was.
const wordsIn = (l, k) => WORDS[l]?.[k] ?? WORDS.en[k] ?? k;
const shopDates = new Map();
/** The shared fields' labels follow the language toggle like the page's own words do. */
function repaintShopDates() { const l = document.documentElement.lang === 'ta' ? 'ta' : 'en'; for (const [id, words] of shopDates) { const lab = $(id)?.closest('.sre-field')?.querySelector('.sre-field-label'); if (lab && lab.firstChild) lab.firstChild.textContent = words[l] ?? words.en; const hint = $(id)?.closest('.sre-field')?.querySelector('.sre-field-hint'); if (hint && !hint.dataset.own && window.sreOffice && typeof window.sreOffice.words === 'function') hint.textContent = window.sreOffice.words('dateHint'); } }
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

// ── head office, in the person's own session ────────────────────────────────────────────────────────────────────────
const newKey = (what) => `product-${what}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
async function call(method, path, body) {
  try {
    const res = await fetch(path, {
      method, credentials: 'same-origin', cache: 'no-store',
      headers: { accept: 'application/json', ...(method === 'POST' ? { 'content-type': 'application/json', 'idempotency-key': newKey(method) } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
  } catch { return { ok: false, status: 0, body: null }; }
}
function say(el, out, good) {
  el.className = `status ${out.ok ? 'good' : 'err'}`;
  el.textContent = out.ok ? good : out.status === 0 ? t('unreachable') : refusalLine(out.status, out.body?.error);
}
function tell(el, ok, text) { el.className = `status ${ok ? 'good' : 'err'}`; el.textContent = text; }

/** The same canonical form head office fingerprints an approval's details by — so the page finds the request for EXACTLY this. */
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}
/** The caller's own request of `kind` on `subjectRef` for exactly `details`: approved (its id), waiting, rejected, or none. */
async function ownApproval(kind, subjectRef, details) {
  const out = await call('GET', '/v1/approvals/requests');
  if (!out.ok) return {};
  const mine = (Array.isArray(out.body?.mine) ? out.body.mine : []).filter((r) => r.kind === kind && r.subjectRef === subjectRef && canonical(r.details) === canonical(details));
  const newest = (rows) => rows.slice().sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt)))[0];
  const approved = newest(mine.filter((r) => r.status === 'approved'));
  if (approved !== undefined) return { approvalId: approved.requestId, decidedBy: approved.decidedBy };
  if (mine.some((r) => r.status === 'waiting')) return { waiting: true };
  const last = newest(mine);
  return last?.status === 'rejected' ? { rejected: last.decisionReason ?? '' } : {};
}

// ── what the page holds ─────────────────────────────────────────────────────────────────────────────────────────────
let productId = '';
let held = null;          // the product as head office holds it; null for a product not saved yet
let heldVersion;          // owner 2A: the version head office said it holds when the page read it (undefined: not told)
let safetyConflict = false; // owner 2A: the last safety save was refused because someone else saved meanwhile
let readFailed = false;
let categories = [];
let barcodes = null;
let pack = null;
let bundle = null;        // { bundle, history } or null
let subs = null;          // { list, set, history }
let pendingSafetyAsk = null; // W4 · OB-546: the approval the last SAFETY save needed (an age limit newly on a product on sale)
let pendingAsk = null;    // { kind, subjectRef, details, summary } — the approval the last save needed
let tab = 'record';

const APPROVAL_KIND_OF = { tax_class_change_needs_finance_approval: 'hsn_class_change', regulated_product_needs_second_person: 'regulated_product_publish' };

function categoryPath(c) {
  const byId = new Map(categories.map((x) => [x.categoryId, x]));
  const names = [];
  const seen = new Set();
  for (let at = c; at !== undefined && !seen.has(at.categoryId); at = at.parentId === null ? undefined : byId.get(at.parentId)) { names.unshift(at.name); seen.add(at.categoryId); }
  return names.join(' › ');
}

function paintCategories() {
  const sel = $('r-category');
  const was = sel.value;
  sel.replaceChildren();
  const none = document.createElement('option'); none.value = ''; none.textContent = t('noCategory'); sel.append(none);
  for (const c of [...categories].sort((a, b) => categoryPath(a).localeCompare(categoryPath(b)))) {
    const o = document.createElement('option'); o.value = c.categoryId; o.textContent = `${categoryPath(c)} (${c.categoryId})`; sel.append(o);
  }
  sel.value = [...sel.options].some((o) => o.value === was) ? was : '';
}

function paintAttributes() {
  const box = $('attrs');
  const c = categories.find((x) => x.categoryId === $('r-category').value);
  const defs = Array.isArray(c?.attributes) ? c.attributes : [];
  const keep = Object.fromEntries([...box.querySelectorAll('[data-attr]')].map((el) => [el.dataset.attr, el.value]));
  box.replaceChildren();
  for (const a of defs) {
    const label = document.createElement('label');
    const span = document.createElement('span'); span.textContent = `${a.label}${a.required === true ? ' *' : ''}`;
    let input;
    if (a.type === 'enum' && Array.isArray(a.allowed)) {
      input = document.createElement('select');
      for (const v of ['', ...a.allowed]) { const o = document.createElement('option'); o.value = v; o.textContent = v; input.append(o); }
    } else {
      input = document.createElement('input');
      input.type = a.type === 'date' ? 'date' : 'text';
      if (a.type === 'number') input.inputMode = 'decimal';
      input.autocomplete = 'off';
    }
    input.id = `attr-${a.key}`; input.dataset.attr = a.key; label.htmlFor = input.id;
    input.value = keep[a.key] ?? held?.attributes?.[a.key] ?? '';
    label.append(span, input);
    box.append(label);
  }
}

function paintNutritionBoxes() {
  const box = $('nutrition');
  if (box.childElementCount === 0) {
    const basis = document.createElement('label'); basis.htmlFor = 'n-basis';
    const bs = document.createElement('span'); bs.id = 'l-n-basis';
    const sel = document.createElement('select'); sel.id = 'n-basis';
    for (const v of ['per_100g', 'per_100ml']) { const o = document.createElement('option'); o.value = v; o.id = `o-${v}`; sel.append(o); }
    basis.append(bs, sel); box.append(basis);
    for (const [key] of [...NUTRIENTS, ['servingSize']]) {
      const label = document.createElement('label'); label.htmlFor = `n-${key}`;
      const span = document.createElement('span'); span.id = `l-n-${key}`;
      const input = document.createElement('input'); input.id = `n-${key}`; input.inputMode = 'decimal'; input.autocomplete = 'off';
      label.append(span, input); box.append(label);
    }
  }
  $('l-n-basis').textContent = t('basis'); $('o-per_100g').textContent = t('per100g'); $('o-per_100ml').textContent = t('per100ml');
  for (const [key, en, ta] of NUTRIENTS) $(`l-n-${key}`).textContent = lang === 'ta' ? ta : en;
  $('l-n-servingSize').textContent = t('serving');
}

function fillRecord() {
  const p = held ?? {};
  const s = p.safety ?? {};
  $('r-name').value = p.name ?? ''; $('r-sku').value = p.sku ?? ''; $('r-baseUom').value = p.baseUom ?? 'ea';
  $('r-category').value = p.primaryCategoryId ?? ''; $('r-brand').value = p.brand ?? ''; $('r-manufacturer').value = p.manufacturer ?? '';
  $('r-parent').value = p.parentProductId ?? ''; $('r-taxClass').value = p.taxClass ?? ''; $('r-lifecycle').value = p.lifecycle ?? 'draft';
  $('s-ingredients').value = s.ingredients ?? ''; $('s-allergens').value = Array.isArray(s.allergens) ? s.allergens.join(', ') : '';
  $('s-none').checked = Array.isArray(s.allergens) && s.allergens.length === 0;
  $('s-origin').value = s.countryOfOrigin ?? ''; $('s-storage').value = s.storageConditions ?? ''; $('s-net').value = s.netQuantity ?? '';
  $('s-packer').value = s.packerDetails ?? ''; $('s-care').value = s.consumerCareContact ?? ''; $('s-packedBySre').checked = s.packedBySre === true;
  $('s-minage').value = s.minimumAge === undefined ? '' : String(s.minimumAge);
  const n = s.nutrition ?? {};
  $('n-basis').value = n.basis ?? 'per_100g';
  for (const [key] of [...NUTRIENTS, ['servingSize']]) $(`n-${key}`).value = n[key] === undefined ? '' : String(n[key]);
  setShopDate('m-from', ''); $('m-rupees').value = ''; $('r-why').value = ''; $('s-why').value = '';
  if (!safetyConflict) { $('safety-status').className = 'status'; $('safety-status').textContent = held === null && mayEdit ? t('safetyFirst') : ''; }
  paintAttributes();
}

function paintMrp() {
  const list = Array.isArray(held?.mrpHistory) ? [...held.mrpHistory].sort((a, b) => String(a.effectiveFrom).localeCompare(String(b.effectiveFrom))) : [];
  $('mrp-list').replaceChildren(...(list.length === 0 ? [Object.assign(document.createElement('li'), { textContent: t('noMrp') })]
    : list.map((m) => Object.assign(document.createElement('li'), { textContent: `₹${(Number(m.value?.minor) / 100).toFixed(2)} ${t('mrpLine')} ${m.effectiveFrom}` }))));
}

/** The safety facts to send: head office's own copy with this form's edits — safety fields the form does not show are kept. */
function safetyFromForm() {
  const text = (id) => $(id).value.trim();
  const put = (obj, key, v) => { if (v === '') delete obj[key]; else obj[key] = v; };
  const s = JSON.parse(JSON.stringify(held?.safety ?? {}));
  put(s, 'ingredients', text('s-ingredients')); put(s, 'countryOfOrigin', text('s-origin')); put(s, 'storageConditions', text('s-storage'));
  put(s, 'netQuantity', text('s-net')); put(s, 'packerDetails', text('s-packer')); put(s, 'consumerCareContact', text('s-care'));
  const allergens = text('s-allergens').split(',').map((a) => a.trim()).filter((a) => a !== '');
  if (allergens.length > 0) s.allergens = allergens; else if ($('s-none').checked) s.allergens = []; else delete s.allergens;
  if ($('s-packedBySre').checked) s.packedBySre = true; else delete s.packedBySre;
  // W4 · OB-546: an age limit is a whole number of years; one head office cannot read is sent as typed and refused there by name.
  const age = text('s-minage');
  if (age === '') delete s.minimumAge; else s.minimumAge = /^\d+$/.test(age) ? Number(age) : age;
  const boxes = [...NUTRIENTS, ['servingSize']].map(([key]) => [key, text(`n-${key}`)]);
  if (boxes.every(([, v]) => v === '')) delete s.nutrition;
  else {
    const n = { basis: $('n-basis').value };
    // A figure is sent as typed: one head office cannot read is refused by name there, never coerced here.
    for (const [key, v] of boxes) if (v !== '' || key !== 'servingSize') n[key] = v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : v);
    s.nutrition = n;
  }
  return s;
}

/** The record to send: head office's own copy with this form's edits — fields the form does not show are kept as held. */
function recordFromForm(freshSafety) {
  const p = held === null ? {} : JSON.parse(JSON.stringify(held));
  for (const k of ['productId', 'tenantId', 'appContent', 'tobaccoWarning', 'mrpReplacements']) delete p[k];
  const text = (id) => $(id).value.trim();
  const put = (obj, key, v) => { if (v === '') delete obj[key]; else obj[key] = v; };
  p.name = text('r-name'); p.sku = text('r-sku'); p.baseUom = $('r-baseUom').value;
  p.primaryCategoryId = $('r-category').value === '' ? null : $('r-category').value;
  p.taxClass = text('r-taxClass') === '' ? null : text('r-taxClass');
  p.lifecycle = $('r-lifecycle').value;
  put(p, 'brand', text('r-brand')); put(p, 'manufacturer', text('r-manufacturer'));
  if (text('r-parent') === '') delete p.parentProductId; else p.parentProductId = text('r-parent');
  const attrs = { ...(p.attributes ?? {}) };
  for (const el of $('attrs').querySelectorAll('[data-attr]')) { if (el.value.trim() === '') delete attrs[el.dataset.attr]; else attrs[el.dataset.attr] = el.value.trim(); }
  if (Object.keys(attrs).length === 0) delete p.attributes; else p.attributes = attrs;
  // Owner 2A: once published, the safety facts travel on their own save — the record carries head office's own copy as
  // read just before this save (`freshSafety`), never this form's, so a full publish cannot overwrite a newer safety edit.
  const s = held === null ? safetyFromForm() : freshSafety;
  if (s === undefined || Object.keys(s).length === 0) delete p.safety; else p.safety = s;
  const from = dateOf('m-from'); const rupees = text('m-rupees');
  if (from !== '' || rupees !== '') {
    const minor = Math.round(Number(rupees) * 100);
    p.mrpHistory = [...(Array.isArray(p.mrpHistory) ? p.mrpHistory : []), { value: { minor: Number.isFinite(minor) ? minor : rupees, currency: 'INR' }, effectiveFrom: from }];
  }
  return p;
}

function paintPanels() {
  $('panels').hidden = productId === '' || readFailed;
  const state = held === null ? 'stateNotYet' : `state${String(held.lifecycle ?? 'draft').charAt(0).toUpperCase()}${String(held.lifecycle ?? 'draft').slice(1)}`;
  $('v-state').textContent = t(state);
  const unknown = (el, known, text) => { el.textContent = known ? text : t('notKnown'); el.classList.toggle('unknown', !known); };
  unknown($('v-codes'), barcodes !== null, fill(t('count'), { n: barcodes?.length ?? 0 }));
  unknown($('v-pack'), pack !== undefined, pack === null ? t('noPack') : fill(t('defined'), { n: pack?.levels?.length ?? 0 }));
  unknown($('v-bundle'), bundle !== undefined, bundle === null ? t('notBundle') : `${t('version')} ${bundle?.bundle?.version}`);
  unknown($('v-subs'), subs !== undefined && subs !== null, subs?.set === false ? t('notSet') : fill(t('subsCount'), { n: subs?.list?.substitutes?.length ?? 0 }));
}

function paintCodes() {
  $('barcode-list').replaceChildren(...((barcodes ?? []).length === 0 ? [Object.assign(document.createElement('li'), { textContent: t('noBarcodes') })]
    : barcodes.map((b) => { const li = document.createElement('li'); li.dataset.code = b.code; li.textContent = `${b.code} · ${b.kind}${b.level === undefined ? '' : ` · ${b.level}`}`; return li; })));
  const rows = $('pack-rows');
  if (rows.childElementCount === 0) {
    for (let i = 0; i < 4; i += 1) {
      const row = document.createElement('div'); row.className = 'row';
      for (const [part, mode] of [['level', 'text'], ['count', 'numeric'], ['code', 'numeric']]) {
        const label = document.createElement('label'); label.htmlFor = `pk-${part}-${i}`;
        const span = document.createElement('span'); span.dataset.word = part === 'level' ? 'levelName' : part === 'count' ? 'holds' : 'levelCode';
        const input = document.createElement('input'); input.id = `pk-${part}-${i}`; input.autocomplete = 'off'; if (mode === 'numeric') input.inputMode = 'numeric';
        label.append(span, input); row.append(label);
      }
      rows.append(row);
    }
  }
  for (const span of rows.querySelectorAll('[data-word]')) span.textContent = t(span.dataset.word);
  const levels = pack?.levels ?? [{ level: held?.baseUom ?? 'ea', containsMinor: 1 }];
  for (let i = 0; i < 4; i += 1) {
    const l = levels[i];
    $(`pk-level-${i}`).value = l?.level ?? ''; $(`pk-count-${i}`).value = l === undefined ? '' : String(l.containsMinor); $(`pk-code-${i}`).value = l?.barcode ?? '';
  }
  const sel = $('cv-level'); sel.replaceChildren();
  for (const l of pack?.levels ?? []) { const o = document.createElement('option'); o.value = l.level; o.textContent = l.level; sel.append(o); }
}

function paintBundle() {
  const b = bundle?.bundle;
  $('bundle-say').textContent = bundle === undefined ? t('notKnown') : b === undefined ? t('notBundle') : fill(t('bundleIs'), { v: b.version, by: b.definedBy });
  $('bundle-history').replaceChildren(...(bundle?.history ?? []).map((v) => {
    const li = document.createElement('li'); li.dataset.version = String(v.version);
    li.textContent = `${t('version')} ${v.version} — ${v.components.map((c) => `${c.productId} × ${c.quantityMinor}`).join(', ')} — ${t('by')} ${v.definedBy} — ${v.reason}`;
    return li;
  }));
  const rows = $('bundle-rows');
  if (rows.childElementCount === 0) {
    for (let i = 0; i < 6; i += 1) {
      const row = document.createElement('div'); row.className = 'row';
      for (const part of ['prod', 'qty']) {
        const label = document.createElement('label'); label.htmlFor = `bd-${part}-${i}`;
        const span = document.createElement('span'); span.dataset.word = part === 'prod' ? 'component' : 'compQty';
        const input = document.createElement('input'); input.id = `bd-${part}-${i}`; input.autocomplete = 'off';
        if (part === 'prod') input.setAttribute('list', 'product-list'); else input.inputMode = 'numeric';
        label.append(span, input); row.append(label);
      }
      rows.append(row);
    }
  }
  for (const span of rows.querySelectorAll('[data-word]')) span.textContent = t(span.dataset.word);
  for (let i = 0; i < 6; i += 1) pickable(`bd-prod-${i}`, 'product', 'pickProduct');
  const comps = b?.components ?? [];
  for (let i = 0; i < 6; i += 1) { $(`bd-prod-${i}`).value = comps[i]?.productId ?? ''; $(`bd-qty-${i}`).value = comps[i] === undefined ? '' : String(comps[i].quantityMinor); }
}

function paintSubs() {
  const l = subs?.list ?? null;
  $('subs-say').textContent = subs === undefined || subs === null ? t('notKnown') : subs.set === false ? t('subsNotSet') : l.substitutes.length === 0 ? t('subsSetNone') : fill(t('subsIs'), { v: l.version, by: l.setBy, why: l.reason });
  $('subs-list').replaceChildren(...(l?.substitutes ?? []).map((id) => Object.assign(document.createElement('li'), { textContent: id })));
  $('sb-list').value = (l?.substitutes ?? []).join(', ');
}

function paintWords() {
  document.title = `SRE ${t('title')}`;
  const pairs = [['title', 'title'], ['page-h', 'title'], ['lead', 'lead'], ['l-product', 'product'], ['show', 'show'], ['k-state', 'kState'], ['k-codes', 'kCodes'], ['k-pack', 'kPack'], ['k-bundle', 'kBundle'], ['k-subs', 'kSubs'],
    ['tab-record', 'tabRecord'], ['tab-codes', 'tabCodes'], ['tab-bundle', 'tabBundle'], ['tab-subs', 'tabSubs'], ['record-h', 'tabRecord'], ['record-lead', 'recordLead'],
    ['l-r-name', 'name'], ['l-r-sku', 'sku'], ['l-r-baseUom', 'baseUom'], ['l-r-category', 'category'], ['l-r-brand', 'brand'], ['l-r-manufacturer', 'manufacturer'], ['l-r-parent', 'parent'],
    ['l-r-taxClass', 'taxClass'], ['l-r-lifecycle', 'lifecycle'], ['o-draft', 'draft'], ['o-new', 'new'], ['o-active', 'active'], ['o-clearance', 'clearance'], ['o-discontinued', 'discontinued'],
    ['mrp-h', 'mrpH'], ['l-m-from', 'mrpFrom'], ['l-m-rupees', 'mrpRupees'], ['safety-h', 'safetyH'], ['l-s-ingredients', 'ingredients'], ['l-s-allergens', 'allergens'], ['l-s-none', 'none'],
    ['l-s-origin', 'origin'], ['l-s-storage', 'storage'], ['l-s-net', 'net'], ['l-s-packer', 'packer'], ['l-s-care', 'care'], ['l-s-packedBySre', 'packedBySre'], ['l-s-minage', 'minAge'], ['ask-safety-approval', 'ask'],
    ['nutrition-h', 'nutritionH'], ['nutrition-lead', 'nutritionLead'], ['safety-save-h', 'safetySaveH'], ['safety-save-lead', 'safetySaveLead'], ['l-s-why', 'why'], ['save-safety', 'saveSafety'], ['safety-reload', 'reload'], ['l-r-why', 'why'], ['save', 'save'], ['ask-approval', 'ask'],
    ['codes-h', 'tabCodes'], ['codes-lead', 'codesLead'], ['l-b-code', 'code'], ['l-b-kind', 'kind'], ['o-internal', 'internal'], ['o-case', 'case'], ['o-embedded', 'embedded'], ['l-b-level', 'level'], ['add-barcode', 'addBarcode'],
    ['pack-h', 'packH'], ['pack-lead', 'packLead'], ['save-pack', 'savePack'], ['l-cv-qty', 'cvQty'], ['l-cv-level', 'cvLevel'], ['convert', 'convert'],
    ['bundle-h', 'tabBundle'], ['bundle-lead', 'bundleLead'], ['l-bd-why', 'why'], ['save-bundle', 'saveBundle'],
    ['subs-h', 'tabSubs'], ['subs-lead', 'subsLead'], ['l-sb-list', 'subsList'], ['l-sb-why', 'why'], ['save-subs', 'saveSubs']];
  for (const [id, k] of pairs) { const el = $(id); if (el) el.textContent = t(k); }
  $('lang').textContent = t('lang');
  $('nobody').hidden = named; $('nobody').textContent = t('nobody');
  paintNutritionBoxes();
}

function paint() {
  repaintShopDates();
  paintWords();
  const shown = productId !== '' && !readFailed && mayRead;
  $('tabs').hidden = false; // the tiles always say what the page holds; a section opens once a product is shown
  for (const v of ['record', 'codes', 'bundle', 'subs']) $(`view-${v}`).hidden = !shown || tab !== v;
  for (const id of ['record-form', 'attrs', 'm-from', 'm-rupees', 'save', 'r-why', 'barcode-form', 'save-pack', 'bundle-rows', 'save-bundle', 'bd-why', 'sb-list', 'sb-why', 'save-subs', 's-why', 'save-safety']) {
    const el = $(id); if (el === null) continue;
    if (['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(el.tagName)) el.disabled = !mayEdit;
    else for (const c of el.querySelectorAll('input, select, textarea, button')) c.disabled = !mayEdit;
  }
  for (const id of ['save', 'add-barcode', 'save-pack', 'convert', 'save-bundle', 'save-subs']) whyDisabled($(id), mayEdit ? '' : 'role');
  for (const el of document.querySelectorAll('#view-record fieldset input, #view-record fieldset select, #view-record fieldset textarea, #pack-rows input')) el.disabled = !mayEdit;
  $('ask-approval').hidden = pendingAsk === null || !mayEdit;
  $('ask-safety-approval').hidden = pendingSafetyAsk === null || !mayEdit;
  $('save-safety').disabled = !mayEdit || held === null; whyDisabled($('save-safety'), !mayEdit ? 'role' : held === null ? { en: WORDS.en.safetyFirst, ta: WORDS.ta.safetyFirst } : '');
  $('safety-reload').hidden = !safetyConflict;
  if (safetyConflict) tell($('safety-status'), false, t('changedMeanwhile'));
  paintCategories(); paintMrp(); paintPanels();
  if (shown) { paintCodes(); paintBundle(); paintSubs(); }
}

async function loadLists() {
  const [cats, prods] = await Promise.all([call('GET', '/v1/catalogue/categories'), call('GET', '/v1/catalogue/products')]);
  if (cats.ok && Array.isArray(cats.body?.categories)) categories = cats.body.categories;
  // P-08: a list head office could not give is said, never shown as an empty one.
  if (!cats.ok || !prods.ok) { const bad = cats.ok ? prods : cats; tell($('result'), false, bad.status === 0 ? t('unreachable') : t('cannotRead')); }
  if (prods.ok && Array.isArray(prods.body?.products)) {
    $('product-list').replaceChildren(...prods.body.products.map((p) => { const o = document.createElement('option'); o.value = p.productId; o.label = p.name; return o; }));
  }
}

async function load() {
  productId = $('product').value.trim();
  pendingAsk = null;
  if (productId === '') { held = null; paint(); return; }
  const id = encodeURIComponent(productId);
  const [p, b, pk, bd, sb] = await Promise.all([
    call('GET', `/v1/catalogue/products/${id}`), call('GET', `/v1/catalogue/products/${id}/barcodes`), call('GET', `/v1/catalogue/products/${id}/pack`),
    call('GET', `/v1/catalogue/bundles/${id}`), call('GET', `/v1/catalogue/products/${id}/substitutes`),
  ]);
  readFailed = !p.ok && p.status !== 404;
  held = p.ok ? p.body?.product ?? null : null;
  heldVersion = p.ok && Number.isInteger(p.body?.version) ? p.body.version : undefined;
  safetyConflict = false;
  barcodes = b.ok && Array.isArray(b.body?.barcodes) ? b.body.barcodes : null;
  pack = pk.ok ? pk.body?.pack ?? null : pk.status === 404 ? null : undefined;
  bundle = bd.ok ? bd.body : bd.status === 404 ? null : undefined;
  subs = sb.ok ? sb.body : undefined;
  const r = $('result');
  if (readFailed) tell(r, false, p.status === 0 ? t('unreachable') : t('cannotRead'));
  else if (held === null) tell(r, true, mayEdit ? t('isNew') : t('cannotRead'));
  else if (!mayEdit) { r.className = 'status'; r.textContent = t('readOnly'); } else { r.className = 'status'; r.textContent = ''; }
  paint();
  fillRecord();
}

function showTab(which) {
  tab = which;
  for (const v of ['record', 'codes', 'bundle', 'subs']) {
    $(`view-${v}`).hidden = productId === '' || readFailed || v !== which;
    if (v === which) $(`tab-${v}`).setAttribute('aria-current', 'page'); else $(`tab-${v}`).removeAttribute('aria-current');
  }
}

// ── acts (each on a click, in the person's own session) ─────────────────────────────────────────────────────────────
async function saveRecord() {
  const st = $('record-status');
  if (productId === '') { tell(st, false, t('needId')); return; }
  // Owner 2A: safety edits on a published product have their own save — said, never silently dropped (P-08).
  if (held !== null && canonical(safetyFromForm()) !== canonical(held.safety ?? {})) { tell(st, false, t('useSafetySave')); return; }
  let freshSafety;
  if (held !== null) {
    const now = await call('GET', `/v1/catalogue/products/${encodeURIComponent(productId)}`);
    if (!now.ok) { say(st, now, ''); return; }
    freshSafety = now.body?.product?.safety;
  }
  const product = recordFromForm(freshSafety);
  const details = { product, productId };
  // A second person's approval already given for exactly this record is named; else head office says whether one is needed.
  let approval = {};
  for (const kind of ['hsn_class_change', 'regulated_product_publish']) {
    const found = await ownApproval(kind, `product:${productId}`, details);
    if (found.approvalId !== undefined) { approval = found; break; }
    if (found.waiting === true) { tell(st, false, t('waiting')); return; }
  }
  const out = await call('POST', `/v1/catalogue/products/${encodeURIComponent(productId)}/publish`, { product, ...(approval.approvalId === undefined ? {} : { approvalId: approval.approvalId }) });
  const kind = APPROVAL_KIND_OF[out.body?.error?.code];
  if (!out.ok && kind !== undefined) {
    const rejected = await ownApproval(kind, `product:${productId}`, details);
    pendingAsk = { kind, subjectRef: `product:${productId}`, details, summary: `${kind === 'hsn_class_change' ? 'Tax class change' : 'Age-limited or tobacco product'}: ${product.name} (${productId})` };
    tell(st, false, rejected.rejected !== undefined ? fill(t('rejectedBy'), { why: rejected.rejected }) : fill(t('needsApproval'), { why: out.body.error.whatHappened }));
    $('ask-approval').hidden = false;
    return;
  }
  pendingAsk = null;
  if (!out.ok) { say(st, out, ''); return; }
  // Said only once head office's new version is read back into the form — what is shown is what head office kept.
  await loadLists(); await load();
  // W4 · M03-FR-01: kept as a draft — said with what it still needs (head office's words), never shown as on sale.
  const kept = out.body?.draft;
  if (kept?.keptAsDraft === true) { tell($('record-status'), true, (kept.stillNeeded ?? []).length === 0 ? t('draftComplete') : fill(t('keptDraft'), { list: kept.stillNeeded.join('; ') })); return; }
  tell($('record-status'), true, approval.decidedBy === undefined ? t('saved') : fill(t('usingApproval'), { by: approval.decidedBy }));
}

/** Owner 2A: the safety, label and nutrition facts, saved on their own route with the version this page opened. */
async function saveSafety() {
  const st = $('safety-status');
  if (productId === '') { tell(st, false, t('needId')); return; }
  if (held === null) { tell(st, false, t('safetyFirst')); return; }
  const why = $('s-why').value.trim();
  if (why === '') { tell(st, false, t('needWhy')); return; }
  if (heldVersion === undefined) { tell(st, false, t('cannotRead')); return; }
  const body = { expectedVersion: heldVersion, safety: safetyFromForm(), reason: why };
  // W4 · OB-546: an age limit newly on a product on sale needs a second person — the approval given for exactly this save
  // is named; while it waits, nothing is sent.
  const subjectRef = `product:${productId}`;
  const details = { ...body, productId };
  const found = await ownApproval('regulated_product_publish', subjectRef, details);
  if (found.waiting === true) { tell(st, false, t('waiting')); return; }
  const out = await call('POST', `/v1/catalogue/products/${encodeURIComponent(productId)}/safety`, { ...body, ...(found.approvalId === undefined ? {} : { approvalId: found.approvalId }) });
  if (!out.ok && out.body?.error?.code === 'regulated_product_needs_second_person') {
    const rejected = await ownApproval('regulated_product_publish', subjectRef, details);
    pendingSafetyAsk = { kind: 'regulated_product_publish', subjectRef, details, summary: `Age-limited product: ${held?.name ?? productId} (${productId})` };
    tell(st, false, rejected.rejected !== undefined ? fill(t('rejectedBy'), { why: rejected.rejected }) : fill(t('needsApprovalSafety'), { why: out.body.error.whatHappened }));
    $('ask-safety-approval').hidden = false;
    return;
  }
  pendingSafetyAsk = null;
  if (out.status === 409 && out.body?.error?.code === 'product_changed_meanwhile') {
    // Nothing was written. The person's typed facts stay on the form until they press Reload.
    safetyConflict = true; tell(st, false, t('changedMeanwhile')); $('safety-reload').hidden = false;
    return;
  }
  if (!out.ok) { say(st, out, ''); return; }
  // Said only once head office's new version is read back into the form — what is shown is what head office kept.
  await load();
  tell($('safety-status'), true, found.decidedBy === undefined ? fill(t('savedVersion'), { v: heldVersion ?? out.body?.version }) : fill(t('usingApproval'), { by: found.decidedBy }));
}

async function askApproval() {
  const st = $('record-status');
  if (pendingAsk === null) return;
  const why = $('r-why').value.trim();
  if (why === '') { tell(st, false, t('needWhy')); return; }
  const out = await call('POST', '/v1/approvals/requests', { kind: pendingAsk.kind, subjectRef: pendingAsk.subjectRef, details: pendingAsk.details, valueMinor: null, summary: pendingAsk.summary, reason: why });
  if (out.ok) { tell(st, true, t('asked')); $('ask-approval').hidden = true; } else say(st, out, '');
}

$('ask').addEventListener('submit', (e) => { e.preventDefault(); void load(); });
$('r-category').addEventListener('change', paintAttributes);
$('save').addEventListener('click', () => { void saveRecord(); });
$('ask-approval').addEventListener('click', () => { void askApproval(); });
$('ask-safety-approval').addEventListener('click', async () => {
  const st = $('safety-status');
  if (pendingSafetyAsk === null) return;
  const why = $('s-why').value.trim();
  if (why === '') { tell(st, false, t('needWhy')); return; }
  const out = await call('POST', '/v1/approvals/requests', { kind: pendingSafetyAsk.kind, subjectRef: pendingSafetyAsk.subjectRef, details: pendingSafetyAsk.details, valueMinor: null, summary: pendingSafetyAsk.summary, reason: why });
  if (out.ok) { tell(st, true, t('asked')); $('ask-safety-approval').hidden = true; } else say(st, out, '');
});
$('save-safety').addEventListener('click', () => { void saveSafety(); });
$('safety-reload').addEventListener('click', () => { void load(); });
$('barcode-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = $('b-code').value.trim();
  const level = $('b-level').value.trim();
  if (code === '') return;
  const out = await call('POST', `/v1/catalogue/products/${encodeURIComponent(productId)}/barcodes/${encodeURIComponent(code)}`, { kind: $('b-kind').value, ...(level === '' ? {} : { level }) });
  if (!out.ok) { say($('codes-status'), out, ''); return; }
  $('b-code').value = ''; $('b-level').value = ''; await load(); showTab('codes'); tell($('codes-status'), true, t('saved'));
});
$('save-pack').addEventListener('click', async () => {
  const levels = [];
  for (let i = 0; i < 4; i += 1) {
    const level = $(`pk-level-${i}`).value.trim(); const count = $(`pk-count-${i}`).value.trim(); const code = $(`pk-code-${i}`).value.trim();
    if (level === '' && count === '') continue;
    levels.push({ level, containsMinor: Number.isFinite(Number(count)) && count !== '' ? Number(count) : count, ...(code === '' ? {} : { barcode: code }) });
  }
  const out = await call('POST', `/v1/catalogue/products/${encodeURIComponent(productId)}/pack`, { baseUom: held?.baseUom ?? $('r-baseUom').value, levels });
  if (!out.ok) { say($('codes-status'), out, ''); return; }
  await load(); showTab('codes'); tell($('codes-status'), true, t('saved'));
});
$('convert-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('cv-qty').value.trim(); const level = $('cv-level').value;
  const out = await call('GET', `/v1/catalogue/products/${encodeURIComponent(productId)}/pack/convert?${new URLSearchParams({ level, quantity: q, direction: 'to-base' })}`);
  say($('codes-status'), out, out.ok ? fill(t('converted'), { q, level, n: out.body?.baseUnits, uom: pack?.baseUom ?? '' }) : '');
});
$('save-bundle').addEventListener('click', async () => {
  const why = $('bd-why').value.trim();
  if (why === '') { tell($('bundle-status'), false, t('needWhy')); return; }
  const components = [];
  for (let i = 0; i < 6; i += 1) {
    const id = $(`bd-prod-${i}`).value.trim(); const q = $(`bd-qty-${i}`).value.trim();
    if (id === '' && q === '') continue;
    components.push({ productId: id, quantityMinor: Number.isFinite(Number(q)) && q !== '' ? Number(q) : q });
  }
  const out = await call('POST', `/v1/catalogue/bundles/${encodeURIComponent(productId)}`, { components, reason: why });
  if (!out.ok) { say($('bundle-status'), out, ''); return; }
  $('bd-why').value = ''; await load(); showTab('bundle'); tell($('bundle-status'), true, t('saved'));
});
$('save-subs').addEventListener('click', async () => {
  const why = $('sb-why').value.trim();
  if (why === '') { tell($('subs-status'), false, t('needWhy')); return; }
  const list = $('sb-list').value.split(',').map((s) => s.trim()).filter((s) => s !== '');
  const out = await call('POST', `/v1/catalogue/products/${encodeURIComponent(productId)}/substitutes`, { substitutes: list, reason: why });
  const warn = Array.isArray(out.body?.warnings) && out.body.warnings.length > 0 ? ` ${out.body.warnings.map((w) => w.detail ?? String(w)).join('; ')}` : '';
  if (!out.ok) { say($('subs-status'), out, ''); return; }
  $('sb-why').value = ''; await load(); showTab('subs'); tell($('subs-status'), true, `${t('saved')}${warn}`);
});
for (const v of ['record', 'codes', 'bundle', 'subs']) $(`tab-${v}`).addEventListener('click', () => showTab(v));
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); repaintPickers(); });

paint();
if (named && !mayRead) tell($('result'), false, t('noRight'));
if (named && mayRead) {
  const asked = new URLSearchParams(location.search).get('product');
  if (asked !== null && /^[A-Za-z0-9_.:-]{1,64}$/.test(asked)) $('product').value = asked;
  void loadLists().then(() => { paint(); if ($('product').value.trim() !== '') return load(); return undefined; });
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
document.addEventListener('sre:chrome', () => { shopDate('m-from', { en: wordsIn('en', 'mrpFrom'), ta: wordsIn('ta', 'mrpFrom') }); paint(); }, { once: true });

pickable('product', 'product', 'pickProduct');
pickable('r-parent', 'product', 'pickProduct');
