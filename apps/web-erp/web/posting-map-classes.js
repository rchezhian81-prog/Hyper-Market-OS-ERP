// Accounts and Tally names · "Account classes" (W5 · M23-FR-01 · WF-18). Every rule and word lives in the TESTED session
// (apps/web-erp/src/account-classes-session.ts, window.accountClasses); this file draws the accounts with what the
// accountant set and what head office suggests, and passes the save through. Head office's suggestion is SHOWN, never
// chosen for anyone: each account starts at what the accountant saved (or "not set"). Nothing is read on open.

const $ = (id) => document.getElementById(id);
const api = window.accountClasses ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, save: false };
const lang = () => (document.documentElement.lang === 'ta' ? 'ta' : 'en');
const w = (k, fill) => (api === null ? k : api.words(lang(), k, fill));
const node = (tag, props = {}, ...kids) => { const n = document.createElement(tag); Object.assign(n, props); n.append(...kids); return n; };
function say(id, text, cls = '') { const el = $(id); if (el) { el.className = `status ${cls}`; el.textContent = text; } }

let view = null;
const chosen = new Map();
const added = [];

function paint() {
  for (const [id, k] of [['classes-h', 'classesH'], ['classes-lede', 'classesLede'], ['classes-show-text', 'show'], ['classes-save-text', 'save'], ['classes-new-l', 'addAccount'], ['classes-add-text', 'add']]) $(id).textContent = w(k);
  const list = $('classes-rows'); list.replaceChildren();
  $('classes-save').hidden = view === null || !may.save;
  $('classes-add').hidden = view === null || !may.save;
  if (view === null) { say('classes-state', ''); return; }
  say('classes-state', view.defined ? w('defined') : w('notDefined'), view.defined ? 'good' : 'err');
  const rows = [...api.rows(view), ...added.filter((a) => !(a in view.classes) && !(a in view.suggested)).map((account) => ({ account, set: null, suggested: null }))];
  for (const r of rows) {
    const li = node('li'); li.dataset.account = r.account;
    const select = node('select', { className: 'class-of', disabled: !may.save });
    select.append(node('option', { value: '', textContent: w('notSet') }), ...api.classes.map((c) => node('option', { value: c, textContent: w(c) })));
    select.value = chosen.has(r.account) ? chosen.get(r.account) : (r.set ?? '');
    select.addEventListener('change', () => { chosen.set(r.account, select.value); });
    li.append(node('strong', { textContent: r.account }), ' ',
      node('label', {}, node('span', { textContent: w('account') }), select),
      node('p', { className: 'meta', textContent: `${w('defined')}: ${r.set === null ? w('notSet') : w(r.set)} · ${w('suggested')}: ${r.suggested === null ? '—' : w(r.suggested)}` }));
    list.append(li);
  }
}

async function load() {
  const out = await session.read();
  if (out.result !== 'ok') { view = null; paint(); say('classes-status', api.outcomeWords(lang(), out), 'err'); return; }
  view = out.value; chosen.clear(); paint(); say('classes-status', '');
}

if (api !== null && may.read) {
  $('classes').hidden = false;
  paint();
  new MutationObserver(paint).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  $('classes-show').addEventListener('click', () => { void load(); });
  $('classes-add-go').addEventListener('click', () => {
    const code = $('classes-new').value.trim();
    if (code === '') { say('classes-status', w('needCode'), 'err'); return; }
    if (!added.includes(code)) added.push(code);
    $('classes-new').value = ''; paint();
  });
  $('classes-save').addEventListener('click', async () => {
    const btn = $('classes-save'); btn.disabled = true;
    try {
      // Every account as it stands on the screen: what the accountant saved, changed where a select was changed.
      const all = {};
      for (const li of $('classes-rows').querySelectorAll('li[data-account]')) all[li.dataset.account] = li.querySelector('select.class-of').value;
      const out = await session.save(all);
      if (out.result !== 'ok') { say('classes-status', api.outcomeWords(lang(), out), 'err'); return; }
      await load();
      say('classes-status', w('saved', { who: out.value.definedBy }), 'good');
    } finally { btn.disabled = false; }
  });
}
