// Duplicates and merges (Round 4a · M03-FR-04 · re-audit G-1): a THIN CLIENT over head office's duplicate check and its
// merge register. The duplicate check reads head office's own product master and lists the pairs it suspects, with the
// evidence; a person proposes that one record replaces the other (catalogue.merge.propose), and a DIFFERENT person
// approves or rejects it (catalogue.merge.approve) — head office refuses the proposer by name. An approved merge is a
// reversible link, never a deletion. Every word has a Tamil twin; nothing is written on open.

const $ = (id) => document.getElementById(id);
const who = window.productMergesData && typeof window.productMergesData === 'object' ? window.productMergesData : null;
const perms = new Set(Array.isArray(who?.permissions) ? who.permissions : []);
const named = typeof who?.userId === 'string' && who.userId !== '';
const mayRead = perms.has('catalogue.pack.read');
const mayPropose = perms.has('catalogue.merge.propose');
const mayDecide = perms.has('catalogue.merge.approve');
let lang = document.documentElement.lang === 'ta' ? 'ta' : 'en';

const WORDS = {
  en: {
    lang: 'தமிழ்', title: 'Duplicates and merges',
    lead: 'The same item entered twice splits its stock and its sales. Head office lists the records it suspects; a person proposes which one to keep, and a different person approves it. A merge never deletes anything and can be reversed.',
    kPairs: 'Possible duplicates', kPending: 'Merges waiting for a decision', kMerged: 'Merged and in force',
    tabDupes: 'Possible duplicates', tabMerges: 'Merges',
    dupesLead: 'Each pair with what head office matched. Nothing is merged by itself — choose “Keep the first” or “Keep the second” to fill in a proposal.',
    noPairs: 'Head office suspects no duplicates in the product master.', keepA: 'Keep the first', keepB: 'Keep the second',
    near_certain: 'Almost certainly the same', likely: 'Likely the same', possible: 'Possibly the same',
    proposeH: 'Propose a merge', keep: 'Keep this record', drop: 'It replaces this one', why: 'Why', propose: 'Propose the merge',
    mergesLead: 'Waiting ones first. The person who proposed a merge can never approve it.',
    noMerges: 'No merge has been proposed.', mergeLine: '{keep} is kept; {drop} points to it — proposed by {by}: {why}',
    pending: 'Waiting for a second person', approved: 'Merged', rejected: 'Rejected', reversed: 'Reversed',
    decidedBy: 'decided by {by}', approve: 'Approve the merge', reject: 'Reject', reverse: 'Reverse the merge',
    proposed: 'Proposed. A second person decides it on this page.', approvedOk: 'Merged. The old record now points to the one kept.', rejectedOk: 'Rejected. Nothing was merged.', reversedOk: 'Reversed. Both records stand on their own again.',
    needAll: 'Name both records and write why.', refused: 'Head office refused:', unreachable: 'Head office could not be reached. Nothing was saved — try again.',
    readOnly: 'You can read the duplicates and merges. Proposing and deciding a merge is for those who keep the catalogue.', noRight: 'This account may not read the product master.',
    nobody: 'Nobody is signed in on this computer, so nothing can be shown.', notKnown: 'Not known',
  },
  ta: {
    lang: 'English', title: 'நகல்களும் இணைப்புகளும்',
    lead: 'ஒரே பொருள் இருமுறை பதியப்பட்டால் அதன் சரக்கும் விற்பனையும் பிரிகின்றன. தலைமை அலுவலகம் சந்தேகிக்கும் பதிவுகளைப் பட்டியலிடுகிறது; எதை வைத்திருப்பது என்று ஒருவர் முன்மொழிகிறார், வேறொருவர் ஒப்புக்கொள்கிறார். இணைப்பு எதையும் நீக்காது, திரும்பப் பெறலாம்.',
    kPairs: 'சாத்தியமான நகல்கள்', kPending: 'முடிவுக்குக் காத்திருக்கும் இணைப்புகள்', kMerged: 'இணைக்கப்பட்டு நடைமுறையில்',
    tabDupes: 'சாத்தியமான நகல்கள்', tabMerges: 'இணைப்புகள்',
    dupesLead: 'தலைமை அலுவலகம் பொருத்தியதுடன் ஒவ்வொரு ஜோடியும். எதுவும் தானாக இணைக்கப்படாது — முன்மொழிவை நிரப்ப “முதலாவதை வை” அல்லது “இரண்டாவதை வை” தேர்வு செய்யுங்கள்.',
    noPairs: 'பொருள் பதிவேட்டில் தலைமை அலுவலகம் எந்த நகலையும் சந்தேகிக்கவில்லை.', keepA: 'முதலாவதை வை', keepB: 'இரண்டாவதை வை',
    near_certain: 'கிட்டத்தட்ட நிச்சயமாக ஒன்றே', likely: 'ஒன்றாக இருக்கலாம்', possible: 'ஒருவேளை ஒன்றே',
    proposeH: 'இணைப்பை முன்மொழி', keep: 'இந்தப் பதிவை வை', drop: 'இது இதற்குப் பதிலாக', why: 'ஏன்', propose: 'இணைப்பை முன்மொழி',
    mergesLead: 'காத்திருப்பவை முதலில். இணைப்பை முன்மொழிந்தவர் அதை ஒருபோதும் ஒப்புக்கொள்ள முடியாது.',
    noMerges: 'எந்த இணைப்பும் முன்மொழியப்படவில்லை.', mergeLine: '{keep} வைக்கப்படுகிறது; {drop} அதைச் சுட்டுகிறது — முன்மொழிந்தவர் {by}: {why}',
    pending: 'இரண்டாம் நபருக்குக் காத்திருக்கிறது', approved: 'இணைக்கப்பட்டது', rejected: 'நிராகரிக்கப்பட்டது', reversed: 'திரும்பப் பெறப்பட்டது',
    decidedBy: 'முடிவு செய்தவர் {by}', approve: 'இணைப்பை ஒப்புக்கொள்', reject: 'நிராகரி', reverse: 'இணைப்பைத் திரும்பப் பெறு',
    proposed: 'முன்மொழியப்பட்டது. இரண்டாம் நபர் இந்தப் பக்கத்தில் முடிவு செய்வார்.', approvedOk: 'இணைக்கப்பட்டது. பழைய பதிவு இப்போது வைக்கப்பட்டதைச் சுட்டுகிறது.', rejectedOk: 'நிராகரிக்கப்பட்டது. எதுவும் இணைக்கப்படவில்லை.', reversedOk: 'திரும்பப் பெறப்பட்டது. இரண்டு பதிவுகளும் மீண்டும் தனித்தனி.',
    needAll: 'இரண்டு பதிவுகளையும் குறிப்பிட்டு ஏன் என்று எழுதுங்கள்.', refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை. எதுவும் சேமிக்கப்படவில்லை — மீண்டும் முயலவும்.',
    readOnly: 'நகல்களையும் இணைப்புகளையும் நீங்கள் படிக்கலாம். இணைப்பை முன்மொழிவதும் முடிவு செய்வதும் பட்டியலைப் பராமரிப்பவர்களுக்கு.', noRight: 'இந்தக் கணக்கு பொருள் பதிவேட்டைப் படிக்க முடியாது.',
    nobody: 'இந்தக் கணினியில் யாரும் உள்நுழையவில்லை, எனவே எதையும் காட்ட முடியாது.', notKnown: 'தெரியவில்லை',
  },
};
const t = (k) => WORDS[lang]?.[k] ?? WORDS.en[k] ?? k;
const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));

const newKey = () => `merge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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

let products = null;
let pairs = null;
let merges = null;
let tab = 'dupes';
const nameOf = (id) => { const p = (products ?? []).find((x) => x.productId === id); return p === undefined ? id : `${p.name} (${id})`; };

function paintPairs() {
  const ul = $('pairs');
  if (pairs !== null && pairs.length === 0) { ul.replaceChildren(Object.assign(document.createElement('li'), { textContent: t('noPairs') })); return; }
  ul.replaceChildren(...(pairs ?? []).map((p) => {
    const li = document.createElement('li'); li.dataset.pair = p.productIds.join('|');
    const head = document.createElement('strong'); head.textContent = `${nameOf(p.productIds[0])} · ${nameOf(p.productIds[1])}`;
    const facts = document.createElement('span'); facts.className = 'muted'; facts.textContent = `${t(p.confidence)} — ${p.evidence}`;
    li.append(head, facts);
    if (mayPropose) {
      const acts = document.createElement('div'); acts.className = 'acts';
      for (const [word, keep, drop] of [['keepA', 0, 1], ['keepB', 1, 0]]) {
        const b = document.createElement('button'); b.type = 'button'; b.textContent = t(word); b.dataset.act = word;
        b.addEventListener('click', () => { $('m-keep').value = p.productIds[keep]; $('m-drop').value = p.productIds[drop]; $('m-why').focus(); });
        acts.append(b);
      }
      li.append(acts);
    }
    return li;
  }));
}

function paintMerges() {
  const ul = $('merges');
  if (merges !== null && merges.length === 0) { ul.replaceChildren(Object.assign(document.createElement('li'), { textContent: t('noMerges') })); return; }
  ul.replaceChildren(...(merges ?? []).map((m) => {
    const r = m.request;
    const li = document.createElement('li'); li.dataset.merge = r.mergeId; li.dataset.status = m.status;
    const head = document.createElement('strong'); head.textContent = `${t(m.status)}${m.decidedBy === undefined ? '' : ` — ${fill(t('decidedBy'), { by: m.decidedBy })}`}`;
    const facts = document.createElement('span'); facts.textContent = fill(t('mergeLine'), { keep: nameOf(r.keepProductId), drop: nameOf(r.supersedeProductId), by: r.requestedBy, why: r.reason });
    li.append(head, facts);
    const acts = document.createElement('div'); acts.className = 'acts';
    const line = document.createElement('p'); line.className = 'status'; line.setAttribute('role', 'status');
    const act = (word, path, body, good) => {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = t(word); b.dataset.act = word;
      b.addEventListener('click', async () => {
        const out = await call('POST', path, body);
        if (out.ok) { await load(); tell($('merges-status'), true, t(good)); } else say(line, out, '');
      });
      acts.append(b);
    };
    const id = encodeURIComponent(r.mergeId);
    if (mayDecide && m.status === 'pending') {
      act('approve', `/v1/catalogue/merges/${id}/decision`, { decision: 'approved' }, 'approvedOk');
      act('reject', `/v1/catalogue/merges/${id}/decision`, { decision: 'rejected' }, 'rejectedOk');
    }
    if (mayDecide && m.status === 'approved') act('reverse', `/v1/catalogue/merges/${id}/reverse`, {}, 'reversedOk');
    if (acts.childElementCount > 0) li.append(acts, line);
    return li;
  }));
}

function paint() {
  document.title = `SRE ${t('title')}`;
  for (const [id, k] of [['title', 'title'], ['page-h', 'title'], ['lead', 'lead'], ['k-pairs', 'kPairs'], ['k-pending', 'kPending'], ['k-merged', 'kMerged'], ['tab-dupes', 'tabDupes'], ['tab-merges', 'tabMerges'],
    ['dupes-h', 'tabDupes'], ['dupes-lead', 'dupesLead'], ['propose-h', 'proposeH'], ['l-m-keep', 'keep'], ['l-m-drop', 'drop'], ['l-m-why', 'why'], ['propose', 'propose'],
    ['merges-h', 'tabMerges'], ['merges-lead', 'mergesLead']]) { const el = $(id); if (el) el.textContent = t(k); }
  $('lang').textContent = t('lang');
  $('nobody').hidden = named; $('nobody').textContent = t('nobody');
  for (const id of ['propose-h', 'm-keep', 'm-drop', 'm-why', 'propose']) { const el = $(id); el.closest('label')?.toggleAttribute('hidden', !mayPropose); el.hidden = !mayPropose; }
  const unknown = (el, known, v) => { el.textContent = known ? String(v) : t('notKnown'); el.classList.toggle('unknown', !known); };
  unknown($('v-pairs'), pairs !== null, pairs?.length ?? 0);
  unknown($('v-pending'), merges !== null, (merges ?? []).filter((m) => m.status === 'pending').length);
  unknown($('v-merged'), merges !== null, (merges ?? []).filter((m) => m.status === 'approved').length);
  paintPairs(); paintMerges();
  $('view-dupes').hidden = tab !== 'dupes'; $('view-merges').hidden = tab !== 'merges';
  for (const v of ['dupes', 'merges']) { if (v === tab) $(`tab-${v}`).setAttribute('aria-current', 'page'); else $(`tab-${v}`).removeAttribute('aria-current'); }
}

async function load() {
  const [p, m] = await Promise.all([call('GET', '/v1/catalogue/products'), call('GET', '/v1/catalogue/merges')]);
  products = p.ok && Array.isArray(p.body?.products) ? p.body.products : null;
  merges = m.ok && Array.isArray(m.body?.merges) ? m.body.merges : null;
  pairs = null;
  if (products !== null) {
    $('product-list').replaceChildren(...products.map((x) => { const o = document.createElement('option'); o.value = x.productId; o.label = x.name; return o; }));
    // Only records still standing on their own are compared: one already merged into another is not a duplicate any more.
    const merged = new Set((merges ?? []).filter((x) => x.status === 'approved').map((x) => x.request.supersedeProductId));
    const candidates = products.filter((x) => !merged.has(x.productId) && typeof x.name === 'string' && x.name.trim() !== '').map((x) => ({
      productId: x.productId, name: x.name, ...(typeof x.brand === 'string' ? { brand: x.brand } : {}), ...(typeof x.safety?.netQuantity === 'string' ? { packSize: x.safety.netQuantity } : {}),
    }));
    const d = await call('POST', '/v1/catalogue/products/duplicates', { products: candidates });
    pairs = d.ok && Array.isArray(d.body?.pairs) ? d.body.pairs : null;
  }
  const st = $('page-status');
  if (!p.ok || !m.ok) say(st, p.ok ? m : p, ''); else if (!mayPropose && !mayDecide) { st.className = 'status'; st.textContent = t('readOnly'); } else st.textContent = '';
  paint();
}

$('propose').addEventListener('click', async () => {
  const st = $('propose-status');
  const keep = $('m-keep').value.trim(); const drop = $('m-drop').value.trim(); const why = $('m-why').value.trim();
  if (keep === '' || drop === '' || why === '') { tell(st, false, t('needAll')); return; }
  const mergeId = `merge-${drop}-into-${keep}-${Date.now().toString(36)}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 100);
  const out = await call('POST', `/v1/catalogue/merges/${encodeURIComponent(mergeId)}`, { keepProductId: keep, supersedeProductId: drop, reason: why });
  if (out.ok) { $('m-keep').value = ''; $('m-drop').value = ''; $('m-why').value = ''; await load(); tell($('propose-status'), true, t('proposed')); } else say(st, out, '');
});
for (const v of ['dupes', 'merges']) $(`tab-${v}`).addEventListener('click', () => { tab = v; paint(); });
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });

paint();
if (named && !mayRead) tell($('page-status'), false, t('noRight'));
if (named && mayRead) void load();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => { /* the page still opens; it is not kept for offline use */ });
}
