// Data-protection officer's erasure console — the THIN CLIENT (M20-FR-04 / DPDP, owner decision).
//
// It holds no erasure logic. It reads the located PII for a verified request, and drives the two-person
// control: a checker approves, then a different maker executes. The backend runs the production
// @sre/customer engines and returns the outcome. In production that backend is the cloud privacy API; in the
// browser E2E it is a local Node server running the same engines.
//
// Every word on this page has a Tamil twin and follows the one language toggle (Stage G slice 5c · NFR-08); the
// data the backend answers with (categories, counts, staff ids) is shown as it is.

const $ = (id) => document.getElementById(id);
const CUSTOMER = 'cust-1';

const WORDS = {
  en: {
    title: 'Erasure console', lede: 'Carry out a verified "delete my data" request under the two-person rule.',
    legal: 'Development workflow — legal confirmation required before go-live.', actingAs: 'Acting as (staff id)',
    actingFoot: 'The person who approves an erasure cannot be the one who runs it. Change this id between approving and executing.',
    held: 'Personal data we hold', category: 'Category', records: 'Records', status: 'Status', refresh: 'Refresh',
    twoPerson: 'Two-person erasure', approve: 'Approve as checker', execute: 'Execute as maker',
    tombstone: 'Erasure record (tombstone)', noneYet: 'No erasure has been carried out yet.',
    deleted: 'Deleted', minimised: 'Kept but anonymised', retained: 'Kept in full (required by law)', people: 'Approved by / carried out by',
    tombFoot: 'The tombstone holds no name, phone or address — only what was done. It is how we prove the erasure happened without keeping the person.',
    preventRestore: 'Prevent restore', restoreLede: 'A late import must not quietly bring an erased person back.',
    tryReadd: 'Try to re-add marketing data',
    unreachable: 'Head office cannot be reached from here — nothing shown is current.',
    approvedBy: 'Approved by', nowDifferent: 'Now a DIFFERENT person must execute.', couldNotApprove: 'Could not approve.',
    carriedOut: 'Erasure carried out', notified: 'processor(s) notified.',
    checkerMissing: 'A second, authorised officer must approve first — an erasure needs two people.',
    makerIsChecker: 'The person who approved cannot also run it. Change the acting-as id to a different officer.',
    couldNotExecute: 'Could not execute.', reAdded: 'Re-added (no erasure on record).',
    refusedErased: 'Refused — this person was erased. Re-creating their data needs a new lawful basis, not a silent restore.',
    refused: 'Refused.', none: '—',
  },
  ta: {
    title: 'அழிப்பு பலகை', lede: 'சரிபார்க்கப்பட்ட "என் தரவை நீக்கு" கோரிக்கையை இரு-நபர் விதியின் கீழ் நிறைவேற்றுங்கள்.',
    legal: 'மேம்பாட்டு நடைமுறை — செயல்படுத்தும் முன் சட்ட உறுதிப்பாடு தேவை.', actingAs: 'செயல்படுவது (பணியாளர் அடையாளம்)',
    actingFoot: 'அழிப்பை ஒப்புதல் அளிப்பவர் அதை நடத்தக் கூடாது. ஒப்புதலுக்கும் செயல்படுத்தலுக்கும் இடையில் இந்த அடையாளத்தை மாற்றுங்கள்.',
    held: 'நாங்கள் வைத்துள்ள தனிப்பட்ட தரவு', category: 'வகை', records: 'பதிவுகள்', status: 'நிலை', refresh: 'புதுப்பி',
    twoPerson: 'இரு-நபர் அழிப்பு', approve: 'சரிபார்ப்பவராக ஒப்புதல்', execute: 'செயல்படுத்துபவராக நடத்து',
    tombstone: 'அழிப்புப் பதிவு', noneYet: 'இதுவரை எந்த அழிப்பும் நடத்தப்படவில்லை.',
    deleted: 'நீக்கப்பட்டது', minimised: 'வைக்கப்பட்டது, ஆனால் அடையாளம் நீக்கப்பட்டது', retained: 'முழுமையாக வைக்கப்பட்டது (சட்டப்படி தேவை)', people: 'ஒப்புதல் அளித்தவர் / நடத்தியவர்',
    tombFoot: 'இந்தப் பதிவில் பெயர், தொலைபேசி அல்லது முகவரி இல்லை — என்ன செய்யப்பட்டது என்பது மட்டுமே. நபரை வைத்துக்கொள்ளாமல் அழிப்பு நடந்ததை நிரூபிப்பது இதுதான்.',
    preventRestore: 'மீட்பைத் தடு', restoreLede: 'தாமதமான இறக்குமதி, அழிக்கப்பட்ட நபரை அமைதியாக மீண்டும் கொண்டுவரக் கூடாது.',
    tryReadd: 'சந்தைப்படுத்தல் தரவை மீண்டும் சேர்க்க முயற்சி',
    unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — காட்டப்படுவது எதுவும் தற்போதையது அல்ல.',
    approvedBy: 'ஒப்புதல் அளித்தவர்', nowDifferent: 'இப்போது வேறு ஒருவர் செயல்படுத்த வேண்டும்.', couldNotApprove: 'ஒப்புதல் அளிக்க முடியவில்லை.',
    carriedOut: 'அழிப்பு நடத்தப்பட்டது', notified: 'செயலாக்குநர்(கள்) அறிவிக்கப்பட்டனர்.',
    checkerMissing: 'முதலில் இரண்டாவது அங்கீகரிக்கப்பட்ட அதிகாரி ஒப்புதல் அளிக்க வேண்டும் — அழிப்புக்கு இருவர் தேவை.',
    makerIsChecker: 'ஒப்புதல் அளித்தவர் அதை நடத்த முடியாது. செயல்படுவது அடையாளத்தை வேறு அதிகாரிக்கு மாற்றுங்கள்.',
    couldNotExecute: 'செயல்படுத்த முடியவில்லை.', reAdded: 'மீண்டும் சேர்க்கப்பட்டது (பதிவில் அழிப்பு இல்லை).',
    refusedErased: 'மறுக்கப்பட்டது — இந்த நபர் அழிக்கப்பட்டார். அவரின் தரவை மீண்டும் உருவாக்க புதிய சட்ட அடிப்படை தேவை, அமைதியான மீட்பு அல்ல.',
    refused: 'மறுக்கப்பட்டது.', none: '—',
  },
};
let lang = 'en';
const t = (key) => WORDS[lang][key] ?? WORDS.en[key];

// A status is kept as WHAT happened (a key and its facts), so a language change repaints it rather than losing it.
const shown = { status: null, restore: null, tomb: null, unreachable: false };

const setStatus = (el, text, kind = '') => { el.textContent = text; el.className = `status ${kind}`.trim(); };

async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  return { status: res.status, body: await res.json() };
}
async function getJson(path) {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`head office answered ${res.status}`);
  return res.json();
}

function paintWords() {
  const set = (id, key) => { $(id).textContent = t(key); };
  set('title', 'title'); set('lede', 'lede'); set('legal', 'legal'); set('actor-label', 'actingAs'); set('acting-foot', 'actingFoot');
  set('pii-h', 'held'); set('th-category', 'category'); set('th-records', 'records'); set('th-status', 'status'); set('locate', 'refresh');
  set('act-h', 'twoPerson'); set('approve', 'approve'); set('execute', 'execute');
  set('tomb-h', 'tombstone'); set('tomb-empty', 'noneYet'); set('dt-erased', 'deleted'); set('dt-minimised', 'minimised');
  set('dt-retained', 'retained'); set('dt-people', 'people'); set('tomb-foot', 'tombFoot');
  set('restore-h', 'preventRestore'); set('restore-lede', 'restoreLede'); set('restore', 'tryReadd');
}

function paintStatuses() {
  const s = shown.status;
  if (shown.unreachable) setStatus($('status'), t('unreachable'), 'err');
  else if (s === null) setStatus($('status'), '');
  else if (s.kind === 'approved') setStatus($('status'), `${t('approvedBy')} ${s.who}. ${t('nowDifferent')}`, 'good');
  else if (s.kind === 'carried_out') setStatus($('status'), `${t('carriedOut')} (${s.state}). ${s.notices} ${t('notified')}`, 'good');
  else if (s.kind === 'checker_missing') setStatus($('status'), t('checkerMissing'), 'err');
  else if (s.kind === 'maker_is_checker') setStatus($('status'), t('makerIsChecker'), 'err');
  else if (s.kind === 'detail') setStatus($('status'), s.detail, 'err');
  else if (s.kind === 'could_not_approve') setStatus($('status'), t('couldNotApprove'), 'err');
  else if (s.kind === 'could_not_execute') setStatus($('status'), t('couldNotExecute'), 'err');

  const r = shown.restore;
  if (r === null) setStatus($('restore-status'), '');
  else if (r.kind === 're_added') setStatus($('restore-status'), t('reAdded'), 'warn');
  else if (r.kind === 'refused_erased') setStatus($('restore-status'), t('refusedErased'), 'good');
  else if (r.kind === 'detail') setStatus($('restore-status'), r.detail, 'err');
  else setStatus($('restore-status'), t('refused'), 'err');

  if (shown.tomb !== null) renderTombstone(shown.tomb);
}

function renderPii(categories) {
  const rows = $('rows');
  rows.textContent = '';
  for (const c of categories) {
    const tr = document.createElement('tr');
    tr.dataset['category'] = c.category;
    const name = document.createElement('td'); name.textContent = c.category;
    const count = document.createElement('td'); count.textContent = String(c.recordCount);
    const st = document.createElement('td');
    const pill = document.createElement('span');
    pill.className = `pill ${c.state}`;
    pill.textContent = c.state;
    pill.dataset['state'] = c.state;
    st.appendChild(pill);
    tr.append(name, count, st);
    rows.appendChild(tr);
  }
}

async function refresh() {
  try {
    const data = await getJson(`/pii/${CUSTOMER}`);
    shown.unreachable = false;
    renderPii(data.categories ?? []);
  } catch {
    // Said, rather than a thrown error nobody sees: this console works only with head office reachable.
    shown.unreachable = true;
  }
  paintStatuses();
}

function renderTombstone(tomb) {
  shown.tomb = tomb;
  $('tomb-empty').hidden = true;
  $('tomb').hidden = false;
  $('t-erased').textContent = tomb.categoriesErased.length ? tomb.categoriesErased.join(', ') : t('none');
  $('t-minimised').textContent = tomb.categoriesMinimised.length ? tomb.categoriesMinimised.join(', ') : t('none');
  $('t-retained').textContent = tomb.categoriesRetained.length ? tomb.categoriesRetained.map((c) => c.category).join(', ') : t('none');
  $('t-people').textContent = `${tomb.checker} → ${tomb.maker}`;
}

$('locate').addEventListener('click', () => { void refresh(); });

$('approve').addEventListener('click', async () => {
  const who = $('actor').value.trim();
  const out = await post(`/approve`, { approver: who });
  shown.status = out.status === 200 ? { kind: 'approved', who } : out.body.detail ? { kind: 'detail', detail: out.body.detail } : { kind: 'could_not_approve' };
  paintStatuses();
});

$('execute').addEventListener('click', async () => {
  const out = await post(`/execute`, { maker: $('actor').value.trim() });
  if (out.status === 200) {
    shown.status = { kind: 'carried_out', state: out.body.state, notices: out.body.notices.length };
    renderTombstone(out.body.tombstone);
    await refresh();
  } else if (out.body.code === 'checker_missing') {
    shown.status = { kind: 'checker_missing' };
  } else if (out.body.code === 'maker_is_checker') {
    shown.status = { kind: 'maker_is_checker' };
  } else {
    shown.status = out.body.detail ? { kind: 'detail', detail: out.body.detail } : { kind: 'could_not_execute' };
  }
  paintStatuses();
});

$('restore').addEventListener('click', async () => {
  const out = await post(`/pii/${CUSTOMER}/marketing_profile`, { recordCount: 1 });
  if (out.status === 200 || out.status === 201) {
    shown.restore = { kind: 're_added' };
    await refresh();
  } else if (out.body.code === 'subject_was_erased') {
    shown.restore = { kind: 'refused_erased' };
  } else {
    shown.restore = out.body.detail ? { kind: 'detail', detail: out.body.detail } : { kind: 'refused' };
  }
  paintStatuses();
});

// The one language toggle (the chrome paints its label): every word on the page follows, the data does not change.
$('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ta' : 'en';
  document.documentElement.lang = lang;
  paintWords();
  paintStatuses();
});

paintWords();
void refresh();
