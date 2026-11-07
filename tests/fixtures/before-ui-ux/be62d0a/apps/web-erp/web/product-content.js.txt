// The product content editor (R4 · D01-FR-06 · OB-74 · OB-215): one page to edit what the customer app shows for a
// product — the Tamil name, the description in each language and the synonyms — each change a new version, every version
// listed with who made it; the completeness score naming what is missing; and the product's image, kept on the shop's
// own server and replaced as a new version. Head office checks everything (an image's type and size included) and the
// page shows exactly what it answered. No prompt/confirm/alert; nothing on a timer.

const el = (id) => document.getElementById(id);
let lang = document.documentElement.lang === 'ta' ? 'ta' : 'en';

const WORDS = {
  en: {
    title: 'App content', langName: 'தமிழ்', lead: 'What the customer app shows and searches for a product. Each change is a new version and reaches the app on the next publish.',
    product: 'Product id', show: 'Show', nameTa: 'Tamil name', descriptionEn: 'Description (English)', descriptionTa: 'Description (Tamil)', synonyms: 'Other words customers use (comma between)',
    reason: 'Why (needed)', save: 'Save as a new version', score: 'App content complete', missing: 'Missing:', nothingMissing: 'Nothing is missing.', record: 'Product record complete',
    reaches: 'Reaches the customer app on the next store publish.', hImage: 'Image', image: 'Photo (JPEG, PNG or WebP, at most 700 KB)', upload: 'Upload as a new version',
    noImage: 'No image — the app shows the product without one.', imageVersion: 'Image version', hHistory: 'Versions', version: 'Version', by: 'by',
    needReason: 'Write the reason first.', noFile: 'Choose a photo first.', done: 'Saved', refused: 'Not saved',
    unreachable: 'Head office could not be reached. Nothing was saved — try again.', cannotRead: 'This product could not be read from head office.',
    'm:Tamil name': 'Tamil name', 'm:English description': 'English description', 'm:Tamil description': 'Tamil description', 'm:synonyms': 'synonyms', 'm:image': 'image',
  },
  ta: {
    title: 'செயலி உள்ளடக்கம்', langName: 'English', lead: 'ஒரு பொருளுக்காக வாடிக்கையாளர் செயலி காட்டுவதும் தேடுவதும். ஒவ்வொரு மாற்றமும் புதிய பதிப்பு; அடுத்த வெளியீட்டில் செயலியை அடையும்.',
    product: 'பொருள் எண்', show: 'காட்டு', nameTa: 'தமிழ்ப் பெயர்', descriptionEn: 'விளக்கம் (ஆங்கிலம்)', descriptionTa: 'விளக்கம் (தமிழ்)', synonyms: 'வாடிக்கையாளர்கள் பயன்படுத்தும் மற்ற சொற்கள் (காற்புள்ளியால் பிரிக்கவும்)',
    reason: 'ஏன் (தேவை)', save: 'புதிய பதிப்பாகச் சேமி', score: 'செயலி உள்ளடக்கம் முழுமை', missing: 'இல்லாதவை:', nothingMissing: 'எதுவும் குறையவில்லை.', record: 'பொருள் பதிவு முழுமை',
    reaches: 'அடுத்த கடை வெளியீட்டில் வாடிக்கையாளர் செயலியை அடையும்.', hImage: 'படம்', image: 'புகைப்படம் (JPEG, PNG அல்லது WebP, அதிகபட்சம் 700 KB)', upload: 'புதிய பதிப்பாகப் பதிவேற்று',
    noImage: 'படம் இல்லை — செயலி படம் இல்லாமல் பொருளைக் காட்டும்.', imageVersion: 'படப் பதிப்பு', hHistory: 'பதிப்புகள்', version: 'பதிப்பு', by: 'செய்தவர்',
    needReason: 'முதலில் காரணத்தை எழுதுங்கள்.', noFile: 'முதலில் ஒரு புகைப்படத்தைத் தேர்ந்தெடுங்கள்.', done: 'சேமிக்கப்பட்டது', refused: 'சேமிக்கப்படவில்லை',
    unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை. எதுவும் சேமிக்கப்படவில்லை — மீண்டும் முயலவும்.', cannotRead: 'இந்தப் பொருளைத் தலைமை அலுவலகத்திலிருந்து படிக்க முடியவில்லை.',
    'm:Tamil name': 'தமிழ்ப் பெயர்', 'm:English description': 'ஆங்கில விளக்கம்', 'm:Tamil description': 'தமிழ் விளக்கம்', 'm:synonyms': 'மற்ற சொற்கள்', 'm:image': 'படம்',
  },
};
const t = (key) => WORDS[lang]?.[key] ?? WORDS.en[key] ?? key;

let current = null;
let readFailed = false;
const productId = () => el('product').value.trim();
function tell(ok, text) { const r = el('result'); r.hidden = false; r.className = `result tone-${ok ? 'ok' : 'error'}`; r.textContent = text; }
const newKey = (what) => `content-${what}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
async function post(path, body, what) {
  try {
    const res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'idempotency-key': newKey(what) }, body: JSON.stringify(body) });
    const answer = await res.json().catch(() => ({}));
    if (res.ok) tell(true, t('done')); else tell(false, `${t('refused')}: ${answer?.error?.whatHappened ?? res.status}`);
    return res.ok;
  } catch { tell(false, t('unreachable')); return false; }
}

async function paintImage() {
  const box = el('image-box');
  box.replaceChildren();
  if (current?.image === null || current === null) { el('image-say').textContent = t('noImage'); return; }
  el('image-say').textContent = `${t('imageVersion')} ${current.image.version} · ${current.image.mediaType} · ${current.image.bytes} B`;
  try {
    const res = await fetch(`/v1/catalogue/products/${encodeURIComponent(productId())}/image`, { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) return;
    const b = await res.json();
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(b.mediaType)) return;
    const img = document.createElement('img'); img.className = 'pic'; img.alt = current.name; img.src = `data:${b.mediaType};base64,${b.contentBase64}`;
    box.append(img);
  } catch { /* the version line above still says which image is held */ }
}

function paint() {
  el('title').textContent = t('title'); el('lead').textContent = t('lead'); el('lang').textContent = t('langName');
  el('whoami').textContent = window.productContentData?.userId ?? '';
  el('l-product').textContent = t('product'); el('show').textContent = t('show');
  for (const k of ['nameTa', 'descriptionEn', 'descriptionTa', 'synonyms', 'reason']) el(`l-${k}`).textContent = t(k);
  el('save').textContent = t('save'); el('h-image').textContent = t('hImage'); el('l-image').textContent = t('image'); el('upload').textContent = t('upload'); el('h-history').textContent = t('hHistory');
  el('state').hidden = !readFailed; el('state').textContent = readFailed ? t('cannotRead') : '';
  el('editor').hidden = current === null;
  if (current === null) return;
  const app = current.completeness.app;
  el('score').textContent = `${t('score')}: ${app.scorePercent}%`;
  const rec = current.completeness.record;
  el('missing').textContent = `${app.missing.length === 0 ? t('nothingMissing') : `${t('missing')} ${app.missing.map((m) => t(`m:${m}`)).join(', ')}`}${rec.scorePercent === undefined ? '' : ` · ${t('record')}: ${rec.scorePercent}%${rec.missing.length === 0 ? '' : ` (${rec.missing.join(', ')})`}`}`;
  el('reaches').textContent = t('reaches');
  el('history').replaceChildren(...current.history.map((v) => {
    const li = document.createElement('li'); li.className = 'row'; li.dataset.version = String(v.version);
    const head = document.createElement('span'); head.className = 'headline'; head.textContent = `${t('version')} ${v.version} — ${v.at}${v.by === undefined ? '' : ` — ${t('by')} ${v.by}`}`;
    const f = document.createElement('span'); f.className = 'facts';
    f.textContent = [v.content.nameTa, v.content.descriptionEn, v.content.descriptionTa, (v.content.synonyms ?? []).join(', ')].filter((x) => x !== undefined && x !== '').join(' · ');
    li.append(head, f);
    return li;
  }));
}

async function refresh() {
  const id = productId();
  if (id === '') { current = null; paint(); return; }
  try {
    const res = await fetch(`/v1/catalogue/products/${encodeURIComponent(id)}/app-content`, { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    current = await res.json(); readFailed = false;
    el('c-nameTa').value = current.content.nameTa ?? ''; el('c-descriptionEn').value = current.content.descriptionEn ?? '';
    el('c-descriptionTa').value = current.content.descriptionTa ?? ''; el('c-synonyms').value = (current.content.synonyms ?? []).join(', ');
  } catch { current = null; readFailed = true; }
  paint();
  await paintImage();
}

el('ask').addEventListener('submit', (event) => { event.preventDefault(); void refresh(); });
el('content-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const reason = el('c-reason').value.trim();
  if (reason === '') { tell(false, t('needReason')); return; }
  const text = (id) => { const v = el(id).value.trim(); return v === '' ? null : v; };
  const synonyms = el('c-synonyms').value.split(',').map((s) => s.trim()).filter((s) => s !== '');
  const ok = await post(`/v1/catalogue/products/${encodeURIComponent(productId())}/content`, { nameTa: text('c-nameTa'), descriptionEn: text('c-descriptionEn'), descriptionTa: text('c-descriptionTa'), synonyms: synonyms.length === 0 ? null : synonyms, reason }, 'content');
  if (ok) el('c-reason').value = '';
  await refresh();
});
el('image-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = el('image-file').files?.[0];
  if (file === undefined) { tell(false, t('noFile')); return; }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  await post(`/v1/catalogue/products/${encodeURIComponent(productId())}/images`, { mediaType: file.type, contentBase64: btoa(bin) }, 'image');
  await refresh();
});
el('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
const asked = new URLSearchParams(location.search).get('product');
if (asked !== null && /^[A-Za-z0-9_-]{1,64}$/.test(asked)) el('product').value = asked;
paint();
void refresh();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the screen still opens; it just will not be there without a network */
  });
}
