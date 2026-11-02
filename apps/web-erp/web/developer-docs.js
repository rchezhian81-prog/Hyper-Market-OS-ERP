// Developer guide (W3 · M36-FR-04 · P-06): every API call, read from `developer-docs.bundle.js` — which every office build
// GENERATES from the published contract docs/api/openapi.json (scripts/developer-docs.mjs). Nothing here is written by
// hand, so the guide cannot promise what the API does not do. A plain word finds a call (its path, permission or a field);
// a group narrows it. Read-only: no head-office route is called and nothing is changed. Every word has a Tamil twin.

const $ = (id) => document.getElementById(id);
const who = window.developerDocsData && typeof window.developerDocsData === 'object' ? window.developerDocsData : null;
const perms = new Set(Array.isArray(who?.permissions) ? who.permissions : []);
const named = typeof who?.userId === 'string' && who.userId !== '';
const mayRead = perms.has('platform.partner.read');
let lang = document.documentElement.lang === 'ta' ? 'ta' : 'en';
const SHOWN = 60;

const WORDS = {
  en: {
    lang: 'தமிழ்', title: 'Developer guide',
    lead: 'Every call a partner\'s system can make to the shop\'s system, read straight from the published contract. A partner builds against these — first in a sandbox, then unchanged against the real shop.',
    version: 'Contract {version} — {n} calls, from {source}.', howH: 'How every call works',
    how1: 'Every path starts with the version (/v1/). Within a version calls are only ever added to, never broken.',
    how2: 'Every call carries the partner credential\'s access token; the permission shown is checked by head office, and a shop sees only its own records.',
    how3: 'A write marked “send an Idempotency-Key” takes that header: the same key sent again returns the first answer, so a retry is never a second sale or payment.',
    how4: 'Every refusal says what happened, whether anything was saved, and the next safe thing to do (code, whatHappened, wasItSaved, nextSafeAction).',
    findH: 'Find a call', q: 'A word (a path, a permission, a field)', group: 'API group', all: 'Every group',
    count: '{n} call(s) match.', more: 'Showing the first {shown} — type a word to narrow it.',
    needs: 'Needs the permission: {p}', feature: 'Only where the shop has the feature: {f}', idem: 'Send an Idempotency-Key header (a retry is safe).', noIdem: 'A read: changes nothing.',
    params: 'In the address: {v}', request: 'Send: {v}', reply: 'Answer ({status}): {v}', none: 'nothing', shownOnce: 'Shown once, never again: {v}', required: ' (required)',
    missing: 'This computer has no copy of the guide yet. It is made when the office pages are built — ask the IT person to rebuild them.',
    noRight: 'This account may not read the developer guide.', nobody: 'Nobody is signed in on this computer, so nothing can be shown.',
  },
  ta: {
    lang: 'English', title: 'உருவாக்குநர் வழிகாட்டி',
    lead: 'கூட்டாளரின் அமைப்பு கடையின் அமைப்புக்குச் செய்யக்கூடிய ஒவ்வொரு அழைப்பும், வெளியிட்ட ஒப்பந்தத்திலிருந்து நேரடியாக. கூட்டாளர் இவற்றை வைத்து முதலில் சோதனைத் தளத்தில், பிறகு மாற்றமின்றி உண்மையான கடையில் உருவாக்குகிறார்.',
    version: 'ஒப்பந்தம் {version} — {n} அழைப்புகள், {source} இலிருந்து.', howH: 'ஒவ்வொரு அழைப்பும் எப்படி வேலை செய்கிறது',
    how1: 'ஒவ்வொரு பாதையும் பதிப்புடன் தொடங்குகிறது (/v1/). ஒரு பதிப்புக்குள் அழைப்புகள் சேர்க்கப்படும், ஒருபோதும் உடைக்கப்படாது.',
    how2: 'ஒவ்வொரு அழைப்பும் கூட்டாளர் சான்றின் அணுகல் குறியீட்டைக் கொண்டு செல்கிறது; காட்டிய அனுமதியைத் தலைமை அலுவலகம் சரிபார்க்கிறது; ஒரு கடை தன் பதிவுகளை மட்டுமே பார்க்கும்.',
    how3: '“Idempotency-Key அனுப்பு” எனக் குறித்த எழுதுதல் அந்தத் தலைப்பை எடுக்கும்: அதே குறியீட்டை மீண்டும் அனுப்பினால் முதல் பதிலே வரும், எனவே மறுமுயற்சி இரண்டாவது விற்பனையோ கட்டணமோ ஆகாது.',
    how4: 'ஒவ்வொரு மறுப்பும் என்ன நடந்தது, ஏதாவது சேமிக்கப்பட்டதா, அடுத்த பாதுகாப்பான செயல் எது என்று சொல்லும் (code, whatHappened, wasItSaved, nextSafeAction).',
    findH: 'அழைப்பைத் தேடு', q: 'ஒரு சொல் (பாதை, அனுமதி, புலம்)', group: 'API குழு', all: 'எல்லாக் குழுக்களும்',
    count: '{n} அழைப்புகள் பொருந்துகின்றன.', more: 'முதல் {shown} மட்டும் — சுருக்க ஒரு சொல்லை எழுதுங்கள்.',
    needs: 'தேவையான அனுமதி: {p}', feature: 'கடையில் இந்த அம்சம் இருந்தால் மட்டும்: {f}', idem: 'Idempotency-Key தலைப்பை அனுப்பு (மறுமுயற்சி பாதுகாப்பானது).', noIdem: 'படித்தல்: எதையும் மாற்றாது.',
    params: 'முகவரியில்: {v}', request: 'அனுப்ப: {v}', reply: 'பதில் ({status}): {v}', none: 'எதுவும் இல்லை', shownOnce: 'ஒருமுறை மட்டும் காட்டப்படும்: {v}', required: ' (கட்டாயம்)',
    missing: 'இந்தக் கணினியில் இன்னும் வழிகாட்டியின் நகல் இல்லை. அலுவலகப் பக்கங்கள் கட்டப்படும்போது அது உருவாகும் — IT நபரை மீண்டும் கட்டச் சொல்லுங்கள்.',
    noRight: 'இந்தக் கணக்கு உருவாக்குநர் வழிகாட்டியைப் படிக்க முடியாது.', nobody: 'இந்தக் கணினியில் யாரும் உள்நுழையவில்லை, எனவே எதையும் காட்ட முடியாது.',
  },
};
const t = (k) => WORDS[lang]?.[k] ?? WORDS.en[k] ?? k;
const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));

let docs = null;
const fieldWords = (fields) => (fields === undefined || fields.length === 0 ? t('none') : fields.map((f) => `${f.name}: ${f.type}${f.required ? t('required') : ''}`).join(', '));
const haystack = (op) => [op.method, op.path, op.group, op.operationId, op.permission ?? '', ...(op.request ?? []).map((f) => f.name), ...(op.reply ?? []).map((f) => f.name)].join(' ').toLowerCase();

function opNode(op) {
  const li = document.createElement('li'); li.dataset.op = `${op.method} ${op.path}`;
  const d = document.createElement('details'); const s = document.createElement('summary');
  const verb = document.createElement('span'); verb.className = 'verb'; verb.textContent = op.method;
  const path = document.createElement('span'); path.className = 'path'; path.textContent = op.path;
  s.append(verb, path);
  const body = document.createElement('div'); body.className = 'body';
  const line = (text) => { if (text === '') return; const p = document.createElement('p'); p.className = 'muted'; p.textContent = text; body.append(p); };
  line(op.group);
  if (op.description) line(op.description);
  line(fill(t('needs'), { p: op.permission ?? t('none') }));
  if (op.entitlement) line(fill(t('feature'), { f: op.entitlement }));
  line(op.method === 'GET' ? t('noIdem') : op.idempotent ? t('idem') : '');
  if (op.params.length > 0) line(fill(t('params'), { v: op.params.map((p) => `${p.name}${p.in === 'query' ? '?' : ''}`).join(', ') }));
  if (op.request !== undefined) line(fill(t('request'), { v: fieldWords(op.request) }));
  if (op.reply !== undefined) line(fill(t('reply'), { status: op.replyStatus, v: fieldWords(op.reply) }));
  if (op.shownOnce) line(fill(t('shownOnce'), { v: op.shownOnce.join(', ') }));
  d.append(s, body); li.append(d);
  return li;
}

function paintList() {
  if (docs === null) { $('ops').replaceChildren(); $('count').textContent = ''; return; }
  const q = $('q').value.trim().toLowerCase(); const g = $('group').value;
  const hits = docs.operations.filter((op) => (g === '' || op.group === g) && (q === '' || haystack(op).includes(q)));
  $('count').textContent = `${fill(t('count'), { n: hits.length })}${hits.length > SHOWN ? ` ${fill(t('more'), { shown: SHOWN })}` : ''}`;
  $('ops').replaceChildren(...hits.slice(0, SHOWN).map(opNode));
}

function paint() {
  document.title = `SRE ${t('title')}`;
  for (const [id, k] of [['title', 'title'], ['page-h', 'title'], ['lead', 'lead'], ['how-h', 'howH'], ['find-h', 'findH'], ['l-q', 'q'], ['l-group', 'group']]) { const el = $(id); if (el) el.textContent = t(k); }
  $('lang').textContent = t('lang');
  $('nobody').hidden = named; $('nobody').textContent = t('nobody');
  $('how').replaceChildren(...['how1', 'how2', 'how3', 'how4'].map((k) => Object.assign(document.createElement('li'), { textContent: t(k) })));
  $('version').textContent = docs === null ? '' : fill(t('version'), { version: docs.version, n: docs.operations.length, source: docs.source });
  const keep = $('group').value;
  $('group').replaceChildren(Object.assign(document.createElement('option'), { value: '', textContent: t('all') }),
    ...(docs?.groups ?? []).map((gr) => Object.assign(document.createElement('option'), { value: gr.name, textContent: `${gr.name} (${gr.description})` })));
  $('group').value = keep;
  paintList();
}

function load() {
  const d = window.sreDeveloperDocs;
  docs = d && typeof d === 'object' && Array.isArray(d.operations) ? d : null;
  if (docs === null) { $('page-status').className = 'status err'; $('page-status').textContent = t('missing'); }
  paint();
}

$('find').addEventListener('submit', (e) => { e.preventDefault(); paintList(); });
$('q').addEventListener('input', () => { paintList(); });
$('group').addEventListener('change', () => { paintList(); });
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });

paint();
if (named && !mayRead) { $('page-status').className = 'status err'; $('page-status').textContent = t('noRight'); }
if (named && mayRead) load();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => { /* the page still opens; it is not kept for offline use */ });
}
