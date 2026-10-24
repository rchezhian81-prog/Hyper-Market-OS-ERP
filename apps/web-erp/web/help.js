// Help and procedures — the role help centre (M25-FR-04) and emergency procedures (D11-FR-06). The session
// (apps/web-erp/src/help-session.ts, in the bundle as window.help) does every call and every save; this page lays out
// what it is told. Served by the store computer it reads the library the box holds and saves an acknowledgement on this
// screen for the box to carry (with the line down too). Every word has a Tamil twin; every button carries an icon.

const $ = (id) => document.getElementById(id);
const api = window.help ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, manage: false, contacts: false, drills: false, onBox: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
function button(words, iconName, cls) { const b = document.createElement('button'); b.type = 'button'; if (cls) b.className = cls; const i = icon(iconName); if (i !== null) b.append(i); b.append(text('span', words)); return b; }
const say = (id, out) => { $(id).textContent = api.outcomeWords(lang, out); };
let view = null; let sheets = null; let drills = null;
const pick = (en, ta) => (lang === 'ta' && ta ? ta : en);

function paintMine() {
  const box = $('sops'); box.replaceChildren();
  if (view === null) return;
  $('as-at').textContent = view.asAtWords;
  $('outstanding').textContent = `${view.outstanding} ${t('outstanding')}`;
  if (view.rows.length === 0) box.append(text('p', view.known ? t('noneForYou') : t('noLibrary')));
  for (const r of view.rows) {
    const card = document.createElement('article'); card.className = 'sop'; card.dataset.sop = r.sopId; card.dataset.category = r.category;
    card.append(text('strong', `${r.category === 'emergency' ? `⚠ ${t('emergency')}` : t('procedure')} · ${pick(r.title, r.titleTa)} (${t('version')} ${r.version})`));
    const words = pick(r.bodyEn, r.bodyTa);
    if (words !== null) card.append(text('p', words, 'words'));
    if (r.saved !== undefined) { const s = text('span', `${r.saved.stateWord}${r.saved.reason ? ` — ${r.saved.reason}` : ''}`, 'meta state'); s.dataset.state = r.saved.state; card.append(s); }
    if (r.upToDate) card.append(text('span', `✓ ${t('upToDate')}`, 'meta done'));
    else if (may.named) {
      const b = button(t('read'), 'book-open'); b.dataset.act = 'ack';
      b.addEventListener('click', async () => {
        b.disabled = true;
        const out = await session.acknowledge(r.sopId, r.version);
        say('ack-status', out);
        if (api.relay !== undefined) await api.relay.syncNow().catch(() => undefined);
        await loadMine();
      });
      card.append(b);
    }
    box.append(card);
  }
  const ul = $('contact-rows'); ul.replaceChildren();
  if (!view.contacts.set) ul.append(text('li', t('contactsNotSet')));
  for (const c of view.contacts.list) ul.append(text('li', `${c.label}: ${c.phone}`));
}
function paintSheets() {
  const ul = $('sheet-rows'); ul.replaceChildren();
  if (sheets === null) return;
  for (const s of sheets.sheets) {
    const li = document.createElement('li'); li.dataset.sheet = s.sopId;
    li.append(text('strong', `${s.sopId} — ${pick(s.title, s.titleTa)} (${t('version')} ${s.version})`));
    li.append(text('span', `${s.state === 'published' ? `✓ ${t('published')}` : s.state === 'behind_the_sheet' ? `⚠ ${t('behind')}` : t('notPublished')} · ${s.forRoles.join(', ')}`, 'meta'));
    if (s.state !== 'published') {
      const b = button(t('publish'), 'upload'); b.dataset.act = 'publish';
      b.addEventListener('click', async () => { say('sheet-status', await session.publishBuiltIn(s.sopId)); await loadSheets(); await loadMine(); });
      li.append(b);
    }
    ul.append(li);
  }
}
function paintDrills() {
  const ul = $('drill-rows'); ul.replaceChildren();
  if (drills === null) return;
  for (const p of drills.procedures) { const li = text('li', `${pick(p.title, p.titleTa)}: ${t('lastHeld')} ${p.lastHeldOn ?? t('never')}`); li.dataset.drill = p.sopId; ul.append(li); }
}

function paint() {
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  for (const [id, key] of [['mine-h', 'forYou'], ['contacts-h', 'contactsH'], ['manage-h', 'manageH'], ['sheets-h', 'sheetsH'], ['write-h', 'writeH'], ['w-id-l', 'sopId'], ['w-version-l', 'versionL'], ['w-cat-l', 'category'], ['w-cat-p', 'procedure'], ['w-cat-e', 'emergency'], ['w-title-l', 'titleEn'], ['w-title-ta-l', 'titleTa'], ['w-roles-l', 'roles'], ['w-en-l', 'bodyEn'], ['w-ta-l', 'bodyTa'], ['w-save-text', 'save'],
    ['sc-h', 'contactsSet'], ['sc-lines-l', 'contactLine'], ['sc-save-text', 'contactsSet'], ['drill-h', 'drillH'], ['d-sop-l', 'drillSop'], ['d-branch-l', 'branch'], ['d-on-l', 'heldOn'], ['d-who-l', 'participants'], ['d-found-l', 'findings'], ['d-save-text', 'record']]) $(id).textContent = t(key);
  paintMine(); paintSheets(); paintDrills();
}
async function loadMine() { const o = await session.view(lang); if (o.result === 'ok') { view = o.value; $('page-status').textContent = ''; } else say('page-status', o); paintMine(); }
async function loadSheets() { const o = await session.builtIn(); if (o.result === 'ok') sheets = o.value; else say('sheet-status', o); paintSheets(); }
async function loadDrills() { const o = await session.drills(); if (o.result === 'ok') drills = o.value; else say('d-status', o); paintDrills(); }

for (const [id, name] of [['w-save', 'file-text'], ['sc-save', 'shield-check'], ['d-save', 'clipboard-check']]) { const i = icon(name); if (i !== null) $(id).prepend(i); }
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); void loadMine(); });
paint();
if (session === null) $('page-status').textContent = t('nobody');
else {
  if (!may.named) $('page-status').textContent = t('nobody');
  if (may.named || may.onBox) { $('mine').hidden = false; $('contacts').hidden = false; void loadMine(); }
  if (may.manage) {
    $('manage').hidden = false; void loadSheets();
    $('w-save').addEventListener('click', async () => {
      const out = await session.write({ sopId: $('w-id').value, title: $('w-title').value, titleTa: $('w-title-ta').value, version: $('w-version').value, roles: $('w-roles').value, category: $('w-cat').value, bodyEn: $('w-en').value, bodyTa: $('w-ta').value });
      say('w-status', out); if (out.result === 'ok') await loadMine();
    });
  }
  if (may.contacts) {
    $('set-contacts').hidden = false;
    $('sc-save').addEventListener('click', async () => { const out = await session.setContacts($('sc-lines').value); say('sc-status', out); if (out.result === 'ok') await loadMine(); });
  }
  if (may.drills) {
    $('drills').hidden = false; void loadDrills();
    $('d-save').addEventListener('click', async () => {
      const out = await session.recordDrill({ sopId: $('d-sop').value, branchId: $('d-branch').value, heldOn: $('d-on').value, participants: $('d-who').value, findings: $('d-found').value });
      say('d-status', out); if (out.result === 'ok') await loadDrills();
    });
  }
}
