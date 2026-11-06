// Accounts and Tally names (Round 4d · M23-FR-01) — the accountant's page over head office's posting map and Tally ledger
// names. The session (apps/web-erp/src/posting-map-session.ts, in the bundle as window.postingMap) does every call and every
// rule; this page lays out what it is told in the shared office parts (window.sreOffice: summary cards, registers with a
// record drawer, form fields, states). It reads both maps as it opens; changes are kept on this page until the accountant
// saves them, each save a new version in their name. Every word has a Tamil twin; head office's own sentences stay English.

const $ = (id) => document.getElementById(id);
const api = window.postingMap ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, configure: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
const both = (k) => ({ en: api === null ? k : api.words('en', k), ta: api === null ? k : api.words('ta', k) });
const kindBoth = (k) => ({ en: api.kindWords('en', k), ta: api.kindWords('ta', k) });
const office = () => window.sreOffice ?? null;
function el(tag, text, cls) { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; }

let setup = null; // head office's answer
let readOut = null; // a failed read, said in the registers
/** The accountant's changes not yet saved: kind → legs, or null to leave the kind out. */
const changes = new Map();
/** Tally names typed and kept, not yet saved: account → name. */
const nameEdits = new Map();
let mapRegister = null;
let namesRegister = null;

const legsNow = (row) => (changes.has(row.kind) ? (changes.get(row.kind) ?? []) : row.legs);
const accountsOn = (row, side) => legsNow(row).filter((l) => l.side === side).map((l) => l.account || '—').join(', ');
const stateKey = (row) => (changes.has(row.kind) ? (changes.get(row.kind) === null ? 'leftOut' : 'changed') : row.state);
const toneOf = (key) => (key === 'in_force' ? 'ok' : key === 'to_map' ? 'degraded' : 'pending');
const inForceRules = () => (setup?.rows ?? []).filter((r) => r.inForce !== null).map((r) => ({ kind: r.kind, legs: r.inForce }));

function paintCards() {
  const o = office(); if (o === null) return;
  const s = setup;
  const waiting = s === null ? null : s.rows.filter((r) => r.state !== 'in_force').length;
  const unnamed = s === null ? null : s.accounts.filter((a) => a.tallyName === null).length;
  o.cards($('cards'), [
    { label: both('cardVersion'), value: s === null ? null : (s.mapVersion === 0 ? t('noteNone') : `${t('noteVersion')} ${s.mapVersion}`), tone: s !== null && s.mapVersion === 0 ? 'degraded' : undefined, note: s?.mapBy ? `${t('by')} ${s.mapBy} · ${t('at')} ${api.moment(s.mapAt)}` : undefined },
    { label: both('cardKinds'), value: s === null ? null : s.rows.filter((r) => r.state === 'in_force').length },
    { label: both('cardWaiting'), value: waiting, note: both('noteWaiting'), tone: waiting ? 'pending' : undefined },
    { label: both('cardUnnamed'), value: unnamed, note: both('noteUnnamed'), tone: unnamed ? 'pending' : undefined },
    { label: both('cardNames'), value: s === null ? null : (s.names === null ? t('noteNone') : `${t('noteVersion')} ${s.names.version}`), tone: s !== null && s.names === null ? 'degraded' : undefined },
  ]);
}

function legDrawer(row) {
  const o = office();
  const box = el('div');
  const legs = legsNow(row).length > 0 ? legsNow(row) : row.legs;
  box.append(o.facts([[both('colKind'), row.kind], [both('colState'), o.chip(toneOf(stateKey(row)), t(stateKey(row)))]]));
  box.append(el('h3', t('legsH')));
  const form = el('form'); form.noValidate = true; form.id = 'legs-form';
  legs.forEach((l, i) => {
    form.append(o.field({ id: `leg-${i}`, label: `${t(l.side)} — ${api.componentWords(lang, l.component)}`, required: true, value: l.account, hint: row.suggested?.[i] && row.suggested[i].account !== l.account ? `${t('suggestion')}: ${row.suggested[i].account}` : undefined }));
  });
  box.append(form);
  if (!may.configure) { form.querySelectorAll('input').forEach((i) => { i.readOnly = true; }); return box; }
  const acts = el('div', undefined, 'acts');
  const keep = el('button', t('keep')); keep.type = 'button'; keep.id = 'keep-legs';
  keep.addEventListener('click', () => {
    if (!o.check(form)) return;
    const next = legs.map((l, i) => ({ account: $(`leg-${i}`).value.trim(), side: l.side, component: l.component }));
    const same = row.inForce !== null && JSON.stringify(next) === JSON.stringify(row.inForce.map((l) => ({ account: l.account, side: l.side, component: l.component })));
    if (same) changes.delete(row.kind); else changes.set(row.kind, next);
    o.closeDrawer(); paintAll();
  });
  acts.append(keep);
  if (row.suggested !== null) {
    const sugg = el('button', t('useSuggested'), 'quiet'); sugg.type = 'button'; sugg.id = 'use-suggested';
    sugg.addEventListener('click', () => { row.suggested.forEach((l, i) => { const input = $(`leg-${i}`); if (input) input.value = l.account; }); });
    acts.append(sugg);
  }
  if (row.inForce !== null) {
    const out = el('button', t('leaveOut'), 'quiet'); out.type = 'button'; out.id = 'leave-out';
    out.addEventListener('click', () => { changes.set(row.kind, null); o.closeDrawer(); paintAll(); });
    acts.append(out);
  }
  if (changes.has(row.kind)) {
    const undo = el('button', t('undo'), 'quiet'); undo.type = 'button'; undo.id = 'undo-kind';
    undo.addEventListener('click', () => { changes.delete(row.kind); o.closeDrawer(); paintAll(); });
    acts.append(undo);
  }
  box.append(acts);
  return box;
}

function nameDrawer(a) {
  const o = office();
  const box = el('div');
  box.append(o.facts([[both('colAccount'), a.account], [both('colUsedBy'), a.kinds.map((k) => api.kindWords(lang, k)).join('; ')]]));
  const form = el('form'); form.noValidate = true;
  form.append(o.field({ id: 'tally-name', label: both('tallyName'), required: true, value: nameEdits.get(a.account) ?? a.tallyName ?? '' }));
  box.append(form);
  if (!may.configure) { form.querySelector('input').readOnly = true; return box; }
  const keep = el('button', t('keep')); keep.type = 'button'; keep.id = 'keep-name';
  keep.addEventListener('click', () => { if (!o.check(form)) return; nameEdits.set(a.account, $('tally-name').value.trim()); o.closeDrawer(); paintAll(); });
  box.append(keep);
  return box;
}

function paintRegisters() {
  const o = office(); if (o === null) return;
  if (mapRegister === null || !$('map-register').contains($('kinds-table'))) {
    mapRegister = o.table($('map-register'), {
      id: 'kinds', label: both('mapRegister'), bodyId: 'kind-rows', pageSize: 10, rows: null,
      rowKey: (r) => r.kind, rowData: (r) => ({ state: stateKey(r) }),
      empty: { title: both('emptyTitle'), detail: both('emptyDetail') },
      columns: [
        { key: 'what', label: both('colWhat'), sort: 'text', value: (r) => kindBoth(r.kind) },
        { key: 'kind', label: both('colKind'), sort: 'text', hidden: true },
        { key: 'state', label: both('colState'), filter: true, value: (r) => both(stateKey(r)), render: (r) => o.chip(toneOf(stateKey(r)), t(stateKey(r))) },
        { key: 'debit', label: both('colDebit'), value: (r) => accountsOn(r, 'debit') },
        { key: 'credit', label: both('colCredit'), value: (r) => accountsOn(r, 'credit') },
      ],
      drawer: { title: (r) => api.kindWords(lang, r.kind), body: legDrawer },
    });
  }
  if (namesRegister === null || !$('names-register').contains($('accounts-table'))) {
    namesRegister = o.table($('names-register'), {
      id: 'accounts', label: both('namesRegister'), bodyId: 'account-rows', pageSize: 10, rows: null,
      rowKey: (a) => a.account,
      empty: { title: both('namesNone'), detail: both('emptyDetail') },
      columns: [
        { key: 'account', label: both('colAccount'), sort: 'text' },
        { key: 'tally', label: both('colTally'), sort: 'text', value: (a) => nameEdits.get(a.account) ?? a.tallyName ?? both('notNamed'), render: (a) => { const n = nameEdits.get(a.account) ?? a.tallyName; return n === null ? o.chip('pending', t('notNamed')) : n; } },
        { key: 'usedBy', label: both('colUsedBy'), value: (a) => a.kinds.map((k) => api.kindWords(lang, k)).join('; ') },
      ],
      drawer: { title: (a) => a.account, body: nameDrawer },
    });
  }
  if (setup !== null) { mapRegister.setRows(setup.rows); namesRegister.setRows(setup.accounts); } else if (readOut !== null) {
    for (const r of [mapRegister, namesRegister]) r.setState(o.stateOf(readOut), { detail: api.outcomeWords(lang, readOut) });
  } else if (!may.read) { for (const r of [mapRegister, namesRegister]) r.setState('denied', { detail: t(may.named ? 'cannotRead' : 'nobody') }); } else { mapRegister.setRows(null); namesRegister.setRows(null); }
}

function paintForms() {
  const o = office(); if (o === null) return;
  if (!$('draft-note').firstChild) $('draft-note').append(o.field({ id: 'map-note', label: both('note'), type: 'textarea' }));
  if (!$('names-company').firstChild) $('names-company').append(o.field({ id: 'company', label: both('company'), required: true, value: setup?.names?.companyName ?? '' }));
  if (!$('names-note').firstChild) $('names-note').append(o.field({ id: 'names-note-text', label: both('note'), type: 'textarea' }));
  if (setup !== null && !$('voucher-fields').firstChild) {
    for (const f of setup.families) $('voucher-fields').append(o.field({ id: `vt-${f.family}`, label: f.words, value: setup.names?.voucherTypes?.[f.family] ?? '' }));
  }
}

function paintDraft() {
  $('draft-summary').textContent = changes.size === 0 ? t('draftNone') : `${changes.size} ${t('draftCount')}`;
  $('draft-kinds').replaceChildren(...[...changes.entries()].map(([kind, legs]) => {
    const li = el('li'); li.dataset.kind = kind;
    li.append(el('p', `${api.kindWords(lang, kind)} — ${legs === null ? t('leftOut') : legs.map((l) => `${t(l.side)} ${l.account}`).join(' · ')}`));
    return li;
  }));
}

function paintHistory() {
  const line = (text, meta) => { const li = el('li'); li.append(el('p', text), el('p', meta, 'meta')); return li; };
  const list = (v, keys) => keys.filter(([, xs]) => xs.length > 0).map(([k, xs]) => `${t(k)}: ${xs.join(', ')}`).join(' · ');
  const mh = setup?.mapHistory ?? [];
  $('map-history').replaceChildren(...(mh.length === 0 ? [line(t('historyNone'), '')] : mh.map((v) => {
    const li = line(`${t('noteVersion')} ${v.version} · ${v.rules} ${t('rules')} · ${list(v, [['added', v.added], ['changedKinds', v.changed], ['dropped', v.dropped]])}`, `${t('by')} ${v.definedBy} · ${t('at')} ${api.moment(v.definedAt)}${v.note ? ` · ${v.note}` : ''}`);
    li.dataset.version = String(v.version); return li;
  })));
  const nh = setup?.namesHistory ?? [];
  $('names-history').replaceChildren(...(nh.length === 0 ? [line(t('historyNone'), '')] : nh.map((v) => {
    const li = line(`${t('noteVersion')} ${v.version} · ${v.companyName} · ${v.accounts} ${t('accounts')} · ${list(v, [['added', v.added], ['renamed', v.renamed], ['dropped', v.dropped]])}`, `${t('by')} ${v.setBy} · ${t('at')} ${api.moment(v.setAt)}${v.note ? ` · ${v.note}` : ''}`);
    li.dataset.version = String(v.version); return li;
  })));
}

function paintAll() { paintCards(); paintRegisters(); paintForms(); paintDraft(); paintHistory(); }

function paintWords() {
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  document.title = `SRE ${t('title')}`;
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  for (const [id, key] of [['map-h', 'mapH'], ['draft-h', 'draftH'], ['save-map-text', 'save'], ['adopt-all-text', 'adoptAll'], ['names-h', 'namesH'], ['voucher-h', 'voucherH'], ['save-names-text', 'saveNames'], ['history-h', 'historyH'], ['map-history-h', 'mapHistoryH'], ['names-history-h', 'namesHistoryH']]) $(id).textContent = t(key);
}

async function load() {
  $('page-status').textContent = t('reading');
  const out = await session.read();
  if (out.result === 'ok') { setup = out.value; readOut = null; $('page-status').textContent = may.configure ? '' : t('cannotConfigure'); } else { setup = null; readOut = out; $('page-status').textContent = api.outcomeWords(lang, out); }
  // the forms are drawn again from what head office now holds
  for (const id of ['names-company', 'voucher-fields']) $(id).replaceChildren();
  paintAll();
}

$('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang;
  for (const id of ['draft-note', 'names-company', 'names-note', 'voucher-fields']) { const keep = [...$(id).querySelectorAll('input, textarea')].map((i) => [i.id, i.value]); $(id).replaceChildren(); paintForms(); for (const [i, v] of keep) if ($(i)) $(i).value = v; }
  paintWords(); paintAll();
});
$('draft-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (setup === null) return;
  $('map-status').textContent = t('saving');
  const out = await session.saveMap({ basedOn: setup.mapVersion, inForce: inForceRules(), changes, note: $('map-note')?.value ?? '' });
  if (out.result === 'ok') { changes.clear(); if ($('map-note')) $('map-note').value = ''; $('map-status').textContent = `${t('saved')} ${out.value.version}.`; await load(); } else $('map-status').textContent = api.outcomeWords(lang, out);
});
// Every suggested rule not yet in force (and not already changed) goes into the change — still the accountant's to look at
// and save; nothing is saved by this press.
$('adopt-all').addEventListener('click', () => {
  let n = 0;
  for (const r of setup?.rows ?? []) if (r.state === 'suggested' && !changes.has(r.kind)) { changes.set(r.kind, r.suggested); n += 1; }
  $('map-status').textContent = `${n} ${t('adopted')}`;
  paintAll();
});
$('names-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (setup === null) return;
  const o = office(); if (o !== null && !o.check($('names-form'))) return;
  const names = { ...(setup.names?.names ?? {}), ...Object.fromEntries(nameEdits) };
  const voucherTypes = Object.fromEntries(setup.families.map((f) => [f.family, $(`vt-${f.family}`)?.value ?? '']));
  $('names-status').textContent = t('saving');
  const out = await session.saveNames({ basedOn: setup.names?.version ?? 0, companyName: $('company')?.value ?? '', names, voucherTypes, note: $('names-note-text')?.value ?? '' });
  if (out.result === 'ok') { nameEdits.clear(); if ($('names-note-text')) $('names-note-text').value = ''; $('names-status').textContent = `${t('namesSaved')} ${out.value.version}.`; await load(); } else $('names-status').textContent = api.outcomeWords(lang, out);
});
document.addEventListener('sre:chrome', () => paintAll());

paintWords();
if (!may.named) $('page-status').textContent = t('nobody');
else if (!may.read) $('page-status').textContent = t('cannotRead');
else {
  for (const id of ['map', 'names', 'history']) $(id).hidden = false;
  if (may.configure) $('draft').hidden = false; else $('page-status').textContent = t('cannotConfigure');
  $('names-form').hidden = !may.configure;
  paintAll(); void load();
}
