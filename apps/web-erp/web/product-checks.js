// Product checks (Wave 2 · OB-625): a READ-ONLY thin client over head office's three product-master checks. The summary
// cards and the three registers are the shared office parts (window.sreOffice); every count is head office's answer or
// "Not known", and each register's empty words say how many products were checked, so a nought never reads as "not
// looked". A gap is fixed on the product's own page (Product details); this page writes nothing. Tamil for every word.

const $ = (id) => document.getElementById(id);
const who = window.productChecksData && typeof window.productChecksData === 'object' ? window.productChecksData : null;
const perms = new Set(Array.isArray(who?.permissions) ? who.permissions : []);
const named = typeof who?.userId === 'string' && who.userId !== '';
const mayRead = named && perms.has('reporting.report.read');
const mayOpenProduct = named && perms.has('catalogue.pack.read');
let lang = document.documentElement.lang === 'ta' ? 'ta' : 'en';

const WORDS = {
  en: {
    lang: 'தமிழ்', title: 'Product checks', refresh: 'Check the products again',
    lead: 'Three checks on every product that can be sold, from head office\'s own records: products with no tax mapping, products missing allergen or ingredient details their category needs, and products with no barcode. Read-only — fix a product on its own page and it leaves the list.',
    kChecked: 'Products checked', kTax: 'No tax mapping', kAllergens: 'Allergen or ingredient details missing', kBarcode: 'No barcode',
    nChecked: 'of {n} on the product master — the ones that can be sold', nTax: 'a bill would have no GST rate', nAllergens: 'where the category needs them', nBarcode: 'cannot be scanned at the till',
    taxH: '1. No tax mapping', taxLead: 'No HSN code, or an HSN code with no GST rate recorded for today. Ask the accountant to record the rate on "GST and cess rates", or give the product its HSN code.',
    allergensH: '2. Allergen or ingredient details missing', allergensLead: 'A product in a food category must declare its allergens ("none" counts); one in a packed-food category must also list its ingredients. A product whose category is not on the list cannot be judged and is listed so.',
    barcodeH: '3. No barcode', barcodeLead: 'No barcode at any pack size. A product sold by weight is rung from its scale label, so it is marked.',
    cProduct: 'Product', cSku: 'Item code', cName: 'Name', cCategory: 'Category', cHsn: 'HSN', cWhy: 'What is missing', cWeight: 'Sold by weight',
    no_hsn_code: 'No HSN code', no_gst_rate_today: 'No GST rate for this HSN today', gst_rate_not_read: 'The GST rate could not be read', no_allergen_declaration: 'No allergen declaration', no_ingredient_list: 'No ingredient list', category_not_on_the_list: 'Category not on the list — cannot be judged', no_barcode: 'No barcode',
    yes: 'Yes — rung from a scale label', no: 'No', emptyTitle: 'None found', emptyDetail: 'Head office checked {n} product(s) that can be sold and found none for this check.',
    openProduct: 'Open this product', notKnown: 'Not known',
    noRight: 'This account may not read reports.', nobody: 'Nobody is signed in on this computer, so nothing can be shown.',
    refused: 'Head office refused:', unreachable: 'Head office could not be reached. Nothing here is current — try again.', asAt: 'Checked by head office for the shop day {day}.',
  },
  ta: {
    lang: 'English', title: 'பொருள் சரிபார்ப்புகள்', refresh: 'பொருட்களை மீண்டும் சரிபார்',
    lead: 'விற்கக்கூடிய ஒவ்வொரு பொருளுக்கும் மூன்று சரிபார்ப்புகள், தலைமை அலுவலகத்தின் சொந்தப் பதிவுகளிலிருந்து: வரி இணைப்பு இல்லாத பொருட்கள், வகைக்குத் தேவையான ஒவ்வாமை அல்லது உட்பொருள் விவரம் இல்லாதவை, பார்கோடு இல்லாதவை. படிக்க மட்டும் — பொருளை அதன் சொந்தப் பக்கத்தில் சரிசெய்தால் பட்டியலிலிருந்து நீங்கும்.',
    kChecked: 'சரிபார்த்த பொருட்கள்', kTax: 'வரி இணைப்பு இல்லை', kAllergens: 'ஒவ்வாமை அல்லது உட்பொருள் விவரம் இல்லை', kBarcode: 'பார்கோடு இல்லை',
    nChecked: 'பொருள் பட்டியலில் உள்ள {n} இல் — விற்கக்கூடியவை', nTax: 'பில்லுக்கு GST விகிதம் இருக்காது', nAllergens: 'வகைக்குத் தேவைப்படும் இடங்களில்', nBarcode: 'கல்லாவில் ஸ்கேன் செய்ய முடியாது',
    taxH: '1. வரி இணைப்பு இல்லை', taxLead: 'HSN குறியீடு இல்லை, அல்லது இன்றைக்கு GST விகிதம் பதியப்படாத HSN குறியீடு. "GST மற்றும் செஸ் விகிதங்கள்" பக்கத்தில் விகிதத்தைப் பதியக் கணக்காளரிடம் கேளுங்கள், அல்லது பொருளுக்கு HSN குறியீடு கொடுங்கள்.',
    allergensH: '2. ஒவ்வாமை அல்லது உட்பொருள் விவரம் இல்லை', allergensLead: 'உணவு வகையில் உள்ள பொருள் அதன் ஒவ்வாமைகளை அறிவிக்க வேண்டும் ("இல்லை" என்பதும் சரி); பொதி உணவு வகையில் உள்ளது உட்பொருட்களையும் பட்டியலிட வேண்டும். வகை பட்டியலில் இல்லாத பொருளை மதிப்பிட முடியாது; அது அவ்வாறே பட்டியலிடப்படும்.',
    barcodeH: '3. பார்கோடு இல்லை', barcodeLead: 'எந்தப் பொதி அளவிலும் பார்கோடு இல்லை. எடைக்கு விற்கப்படும் பொருள் தராசு லேபிளில் இருந்து பில் செய்யப்படுவதால், அது குறிக்கப்படுகிறது.',
    cProduct: 'பொருள்', cSku: 'பொருள் குறியீடு', cName: 'பெயர்', cCategory: 'வகை', cHsn: 'HSN', cWhy: 'எது இல்லை', cWeight: 'எடைக்கு விற்பனை',
    no_hsn_code: 'HSN குறியீடு இல்லை', no_gst_rate_today: 'இந்த HSN க்கு இன்று GST விகிதம் இல்லை', gst_rate_not_read: 'GST விகிதத்தைப் படிக்க முடியவில்லை', no_allergen_declaration: 'ஒவ்வாமை அறிவிப்பு இல்லை', no_ingredient_list: 'உட்பொருள் பட்டியல் இல்லை', category_not_on_the_list: 'வகை பட்டியலில் இல்லை — மதிப்பிட முடியாது', no_barcode: 'பார்கோடு இல்லை',
    yes: 'ஆம் — தராசு லேபிளில் இருந்து', no: 'இல்லை', emptyTitle: 'எதுவும் இல்லை', emptyDetail: 'தலைமை அலுவலகம் விற்கக்கூடிய {n} பொருட்களைச் சரிபார்த்தது; இந்தச் சரிபார்ப்பில் எதுவும் கிடைக்கவில்லை.',
    openProduct: 'இந்தப் பொருளைத் திற', notKnown: 'தெரியவில்லை',
    noRight: 'இந்தக் கணக்கு அறிக்கைகளைப் படிக்க முடியாது.', nobody: 'இந்தக் கணினியில் யாரும் உள்நுழையவில்லை, எனவே எதையும் காட்ட முடியாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை. இங்குள்ளவை தற்போதையவை அல்ல — மீண்டும் முயலவும்.', asAt: 'கடை நாள் {day} க்குத் தலைமை அலுவலகம் சரிபார்த்தது.',
  },
};
const t = (k) => WORDS[lang]?.[k] ?? WORDS.en[k] ?? k;
const both = (k) => ({ en: WORDS.en[k] ?? k, ta: WORDS.ta[k] ?? WORDS.en[k] ?? k });
const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
const bothFill = (k, vars) => ({ en: fill(WORDS.en[k], vars), ta: fill(WORDS.ta[k] ?? WORDS.en[k], vars) });
const office = () => window.sreOffice ?? null;
const REPORTS = ['tax', 'allergens', 'barcode'];

async function call(path) {
  try {
    const res = await fetch(path, { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
  } catch { return { ok: false, status: 0, body: null }; }
}
const refusal = (out) => (out.status === 0 ? t('unreachable') : `${t('refused')} ${out.body?.error?.whatHappened ?? out.status}`);
const stateOf = (out) => (out.status === 0 ? 'offline' : out.status === 401 || out.status === 403 ? 'denied' : 'error');
const reasonWords = (r) => ({ en: r.reasons.map((x) => WORDS.en[x] ?? x).join('; '), ta: r.reasons.map((x) => WORDS.ta[x] ?? WORDS.en[x] ?? x).join('; ') });

let report = undefined;
let reportOut = null;
const registers = {};

function registerFor(o, kind) {
  const columns = [
    { key: 'productId', label: both('cProduct'), sort: 'text' },
    { key: 'sku', label: both('cSku'), sort: 'text', hidden: true },
    { key: 'name', label: both('cName'), sort: 'text' },
    { key: 'category', label: both('cCategory'), filter: true, value: (r) => r.categoryName ?? r.categoryId ?? '' },
    { key: 'hsnCode', label: both('cHsn'), filter: kind === 'tax', value: (r) => r.hsnCode ?? '' },
    { key: 'why', label: both('cWhy'), filter: true, value: reasonWords },
    ...(kind === 'barcode' ? [{ key: 'soldByWeight', label: both('cWeight'), filter: true, value: (r) => both(r.soldByWeight ? 'yes' : 'no') }] : []),
  ];
  return o.table($(`${kind}-register`), {
    id: `checks-${kind}`, label: both(`${kind}H`), bodyId: `${kind}-rows`, pageSize: 10, rows: null,
    rowKey: (r) => r.productId, rowData: (r) => ({ product: r.productId }),
    empty: { title: both('emptyTitle'), detail: bothFill('emptyDetail', { n: report?.checked ?? '' }) },
    columns,
    drawer: {
      title: (r) => r.name,
      body: (r) => {
        const box = document.createElement('div');
        box.append(o.facts([[both('cProduct'), r.productId], [both('cSku'), r.sku], [both('cCategory'), r.categoryName ?? r.categoryId ?? ''], [both('cHsn'), r.hsnCode ?? ''], [both('cWhy'), lang === 'ta' ? reasonWords(r).ta : reasonWords(r).en]]));
        if (mayOpenProduct) {
          const a = document.createElement('a'); a.className = 'sre-btn sre-btn-primary'; a.href = `../product-details/?product=${encodeURIComponent(r.productId)}`; a.textContent = t('openProduct');
          box.append(a);
        }
        return box;
      },
    },
  });
}

function paintOffice() {
  const o = office(); if (o === null) return;
  const c = report?.counts ?? null;
  o.cards($('cards'), [
    { label: both('kChecked'), value: report === undefined ? null : report.checked, note: report === undefined ? '' : bothFill('nChecked', { n: report.onMaster }), icon: 'clipboard-check' },
    { label: both('kTax'), value: c === null ? null : c.tax, note: both('nTax'), tone: c !== null && c.tax > 0 ? 'degraded' : undefined },
    { label: both('kAllergens'), value: c === null ? null : c.allergens, note: both('nAllergens'), tone: c !== null && c.allergens > 0 ? 'degraded' : undefined },
    { label: both('kBarcode'), value: c === null ? null : c.barcode, note: both('nBarcode'), tone: c !== null && c.barcode > 0 ? 'pending' : undefined },
  ]);
  for (const kind of REPORTS) {
    // A fresh register on every read, so its empty words carry the count head office checked.
    if (registers[kind] === undefined || !document.getElementById(`checks-${kind}-table`) || registers[kind].checked !== report?.checked) {
      registers[kind] = { table: registerFor(o, kind), checked: report?.checked };
    }
    const reg = registers[kind].table;
    if (!mayRead) reg.setState('denied', { detail: t(named ? 'noRight' : 'nobody') });
    else if (report !== undefined) reg.setRows(report.rows.filter((r) => r.report === kind));
    else if (reportOut !== null) reg.setState(stateOf(reportOut), { detail: refusal(reportOut) });
    else reg.setRows(null);
  }
}

function paint() {
  document.title = `SRE ${t('title')}`;
  for (const [id, k] of [['title', 'title'], ['page-h', 'title'], ['lead', 'lead'], ['refresh', 'refresh'], ['tax-h', 'taxH'], ['tax-lead', 'taxLead'], ['allergens-h', 'allergensH'], ['allergens-lead', 'allergensLead'], ['barcode-h', 'barcodeH'], ['barcode-lead', 'barcodeLead']]) $(id).textContent = t(k);
  $('lang').textContent = t('lang');
  $('nobody').hidden = named; $('nobody').textContent = t('nobody');
  $('refresh').disabled = !mayRead;
  const st = $('page-status');
  if (named && !mayRead) { st.className = 'status err'; st.textContent = t('noRight'); }
  else if (report !== undefined) { st.className = 'status'; st.textContent = fill(t('asAt'), { day: report.onDay }); }
  else if (reportOut !== null) { st.className = 'status err'; st.textContent = refusal(reportOut); }
  paintOffice();
}

async function load() {
  const out = await call('/v1/catalogue/reports/product-checks');
  report = out.ok ? out.body : undefined; reportOut = out;
  paint();
}

$('refresh').addEventListener('click', () => { void load(); });
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
document.addEventListener('sre:chrome', () => paintOffice());

paint();
if (mayRead) void load();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => { /* the page still opens; it is not kept for offline use */ });
}
