// Shop name, logo and colours (W3 · M36-FR-02 · OB-321 · P-06 · P-08): a THIN CLIENT over head office's white-label brand.
// It reads the brand head office resolves (an unset field is the neutral default, never another shop's) and saves a new
// one — the name, the legal name, the logo reference and the colours ONLY (OB-321); head office refuses a bad colour or an
// unreadable pair, in its own words, and keeps each change as a new version. The brand rides the SIGNED catalogue pack to
// this store computer and its tills (`window.sreBrand`, injected by the box from the pack it holds), so the bill prints the
// name with no network at the sale. Both are shown side by side: a brand head office has that the tills do not yet print is
// SAID (it reaches them with the next pack), never hidden. Every word has a Tamil twin; nothing is written on open.

const $ = (id) => document.getElementById(id);
const who = window.brandingData && typeof window.brandingData === 'object' ? window.brandingData : null;
const perms = new Set(Array.isArray(who?.permissions) ? who.permissions : []);
const named = typeof who?.userId === 'string' && who.userId !== '';
const mayRead = perms.has('platform.branding.read');
const mayEdit = perms.has('platform.branding.write');
const boxBrand = window.sreBrand && typeof window.sreBrand === 'object' ? window.sreBrand : null;
let lang = document.documentElement.lang === 'ta' ? 'ta' : 'en';

const WORDS = {
  en: {
    lang: 'தமிழ்', title: 'Shop name and colours',
    lead: 'The name, logo and colours this shop shows on its screens and prints on its bills. The same system serves every shop; only these settings differ. Tax words such as "Tax invoice" and "GST" can never be renamed.',
    kHo: 'Head office says', kBox: 'This store computer and its tills print', neutral: 'Nothing set — the neutral words are used', fromTenant: 'Set by this shop: {fields}',
    boxNone: 'No shop name in the pack this store computer holds — the bills print without one.', boxPack: 'From catalogue pack v{v}, which this store computer holds.',
    differs: 'Head office\'s brand is not yet on the tills. It reaches them with the next catalogue pack head office publishes.', same: 'The tills print what head office says.',
    editH: 'Change the brand', editLead: 'The colours must be readable together — head office refuses a pair that is hard to read. Every change is kept as a new version.',
    bName: 'Shop name (as customers see it)', bLegal: 'Legal name', bLogo: 'Logo (the stored file\'s reference)', bPrimary: 'Main colour', bOn: 'Writing on the main colour', save: 'Save the brand',
    saved: 'Saved. It reaches the tills with the next catalogue pack.', needName: 'Write the shop name first.',
    refused: 'Head office refused:', unreachable: 'Head office could not be reached. Nothing was saved — try again.', readOnly: 'You can read the brand. Changing it needs the branding right.',
    noRight: 'This account may not read the brand.', nobody: 'Nobody is signed in on this computer, so nothing can be shown.', notKnown: 'Not known',
  },
  ta: {
    lang: 'English', title: 'கடைப் பெயரும் வண்ணங்களும்',
    lead: 'இந்தக் கடை தன் திரைகளில் காட்டி பில்களில் அச்சிடும் பெயர், சின்னம், வண்ணங்கள். ஒரே அமைப்பு எல்லாக் கடைகளுக்கும் சேவை செய்கிறது; இந்த அமைப்புகள் மட்டுமே வேறுபடும். "வரி விலைப்பட்டியல்", "GST" போன்ற வரிச் சொற்களை ஒருபோதும் மாற்ற முடியாது.',
    kHo: 'தலைமை அலுவலகம் சொல்வது', kBox: 'இந்தக் கடைக் கணினியும் கல்லாக்களும் அச்சிடுவது', neutral: 'எதுவும் அமைக்கப்படவில்லை — பொதுவான சொற்கள் பயன்படும்', fromTenant: 'இந்தக் கடை அமைத்தவை: {fields}',
    boxNone: 'இந்தக் கடைக் கணினியிடமுள்ள தொகுப்பில் கடைப் பெயர் இல்லை — பில்கள் பெயரின்றி அச்சாகும்.', boxPack: 'இந்தக் கடைக் கணினியிடமுள்ள பொருள் தொகுப்பு v{v} இலிருந்து.',
    differs: 'தலைமை அலுவலகத்தின் பெயர் இன்னும் கல்லாக்களுக்கு வரவில்லை. அடுத்த பொருள் தொகுப்புடன் வரும்.', same: 'தலைமை அலுவலகம் சொல்வதையே கல்லாக்கள் அச்சிடுகின்றன.',
    editH: 'பெயரை மாற்று', editLead: 'வண்ணங்கள் ஒன்றாகப் படிக்கக்கூடியதாக இருக்க வேண்டும் — படிக்கக் கடினமான இணையைத் தலைமை அலுவலகம் மறுக்கும். ஒவ்வொரு மாற்றமும் புதிய பதிப்பாக வைக்கப்படும்.',
    bName: 'கடைப் பெயர் (வாடிக்கையாளர் பார்ப்பது)', bLegal: 'சட்டப் பெயர்', bLogo: 'சின்னம் (சேமித்த கோப்பின் குறிப்பு)', bPrimary: 'முதன்மை வண்ணம்', bOn: 'முதன்மை வண்ணத்தின் மேல் எழுத்து', save: 'பெயரைச் சேமி',
    saved: 'சேமிக்கப்பட்டது. அடுத்த பொருள் தொகுப்புடன் கல்லாக்களுக்கு வரும்.', needName: 'முதலில் கடைப் பெயரை எழுதுங்கள்.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை. எதுவும் சேமிக்கப்படவில்லை — மீண்டும் முயலவும்.', readOnly: 'பெயரை நீங்கள் படிக்கலாம். மாற்ற வணிகப்பெயர் உரிமை தேவை.',
    noRight: 'இந்தக் கணக்கு கடைப் பெயரைப் படிக்க முடியாது.', nobody: 'இந்தக் கணினியில் யாரும் உள்நுழையவில்லை, எனவே எதையும் காட்ட முடியாது.', notKnown: 'தெரியவில்லை',
  },
};
const t = (k) => WORDS[lang]?.[k] ?? WORDS.en[k] ?? k;
const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
const hex = (v) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : null);

const newKey = () => `brd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
async function call(method, path, body) {
  try {
    const res = await fetch(path, {
      method, credentials: 'same-origin', cache: 'no-store',
      headers: { accept: 'application/json', ...(method === 'GET' ? {} : { 'content-type': 'application/json', 'idempotency-key': newKey() }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
  } catch { return { ok: false, status: 0, body: null }; }
}
const tell = (el, ok, text) => { el.className = `status ${ok ? 'good' : 'err'}`; el.textContent = text; };
const say = (el, out, good) => tell(el, out.ok, out.ok ? good : out.status === 0 ? t('unreachable') : `${t('refused')} ${out.body?.error?.whatHappened ?? out.status}`);

let brand = null; // GET /v1/platform/branding (resolved)
const tenantSet = (f) => Array.isArray(brand?.fromTenant) && brand.fromTenant.includes(f);

function paint() {
  document.title = `SRE ${t('title')}`;
  for (const [id, k] of [['title', 'title'], ['page-h', 'title'], ['lead', 'lead'], ['k-ho', 'kHo'], ['k-box', 'kBox'], ['edit-h', 'editH'], ['edit-lead', 'editLead'],
    ['l-b-name', 'bName'], ['l-b-legal', 'bLegal'], ['l-b-logo', 'bLogo'], ['l-b-primary', 'bPrimary'], ['l-b-on', 'bOn'], ['save', 'save']]) { const el = $(id); if (el) el.textContent = t(k); }
  $('lang').textContent = t('lang');
  $('nobody').hidden = named; $('nobody').textContent = t('nobody');
  $('edit').hidden = !mayEdit;
  const hoName = brand === null ? null : tenantSet('productName') ? brand.productName : '';
  $('v-ho').textContent = brand === null ? t('notKnown') : hoName === '' ? t('neutral') : hoName;
  $('v-ho-more').textContent = brand === null ? '' : brand.fromTenant.length === 0 ? '' : fill(t('fromTenant'), { fields: brand.fromTenant.join(', ') });
  const boxName = typeof boxBrand?.productName === 'string' ? boxBrand.productName : '';
  $('v-box').textContent = boxName === '' ? t('boxNone') : boxName;
  const differs = brand !== null && (hoName ?? '') !== boxName;
  $('v-box').classList.toggle('warn', differs);
  $('v-box-more').textContent = `${boxBrand === null ? '' : `${fill(t('boxPack'), { v: boxBrand.packVersion ?? '' })} `}${brand === null ? '' : differs ? t('differs') : t('same')}`;
  const sw = $('swatch');
  const p = hex(brand?.colours?.primary); const on = hex(brand?.colours?.onPrimary);
  sw.textContent = brand === null ? '' : `${brand.productName}${brand.legalName && brand.legalName !== brand.productName ? ` · ${brand.legalName}` : ''}`;
  sw.style.background = p ?? ''; sw.style.color = on ?? '';
}

async function load() {
  const out = await call('GET', '/v1/platform/branding');
  const st = $('page-status');
  if (!out.ok) { brand = null; say(st, out, ''); paint(); return; }
  brand = out.body;
  if (!mayEdit) { st.className = 'status'; st.textContent = t('readOnly'); } else st.textContent = '';
  $('b-name').value = tenantSet('productName') ? brand.productName : '';
  $('b-legal').value = tenantSet('legalName') ? brand.legalName : '';
  $('b-logo').value = tenantSet('logoRef') ? brand.logoRef : '';
  if (hex(brand.colours?.primary)) $('b-primary').value = brand.colours.primary;
  if (hex(brand.colours?.onPrimary)) $('b-on').value = brand.colours.onPrimary;
  paint();
}

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const st = $('edit-status');
  const productName = $('b-name').value.trim(); const legalName = $('b-legal').value.trim(); const logoRef = $('b-logo').value.trim();
  if (productName === '') { tell(st, false, t('needName')); return; }
  const out = await call('PUT', '/v1/platform/branding', {
    productName, ...(legalName === '' ? {} : { legalName }), ...(logoRef === '' ? {} : { logoRef }),
    colours: { primary: $('b-primary').value, onPrimary: $('b-on').value },
  });
  if (!out.ok) { say(st, out, ''); return; }
  await load();
  tell(st, true, t('saved'));
});
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });

paint();
if (named && !mayRead) tell($('page-status'), false, t('noRight'));
if (named && mayRead) void load();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => { /* the page still opens; it is not kept for offline use */ });
}
