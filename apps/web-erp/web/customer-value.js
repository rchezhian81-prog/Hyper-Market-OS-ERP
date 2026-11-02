// Customer value (W3 · D07-FR-05 · M16-FR-04) — the page over head office's value ranking and group rules. The session
// (apps/web-erp/src/customer-value-session.ts, in the bundle as window.customerValue) does every call and every rule; this
// page lays out what it is told. It reads the rules as it opens; the ranking and saving are explicit presses. Every word
// this page adds has a Tamil twin; head office's own sentences stay in English (OB-553).

const $ = (id) => document.getElementById(id);
const api = window.customerValue ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, manage: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }

let ranked = null;
let rules = null;

function paintRanking() {
  $('ranked').replaceChildren();
  if (ranked === null) return;
  if (ranked.length === 0) $('ranked').append(text('li', t('none'), 'meta'));
  for (const r of ranked) {
    const li = document.createElement('li'); li.dataset.customer = r.customerRef; li.dataset.rank = String(r.rank);
    const rate = r.marginBps === 'not_meaningful' ? t('notMeaningful') : `${(r.marginBps / 100).toFixed(2)}%`;
    li.append(text('h4', `${r.rank}. ${r.customerRef}`), text('p', `${t('margin')} ${api.rupees(r.marginMinor)} · ${t('spend')} ${api.rupees(r.spendMinor)} · ${t('marginRate')} ${rate}`, 'meta'));
    $('ranked').append(li);
  }
}

function paintRules() {
  const form = $('rules-form'); form.replaceChildren();
  if (rules === null) return;
  $('rules-state').textContent = rules.set ? '' : t('allStandard');
  for (const r of rules.rules) {
    const l = document.createElement('label'); l.htmlFor = `rule-${r.rule}`;
    l.append(text('span', `${t(`rule_${r.rule}`)} (${r.shopsOwn ? t('shopsOwn') : t('standard')}: ${r.value})`));
    const input = document.createElement('input'); input.id = `rule-${r.rule}`; input.dataset.rule = r.rule; input.inputMode = 'numeric'; input.autocomplete = 'off';
    if (r.shopsOwn) input.value = String(r.value);
    input.disabled = !may.manage;
    l.append(input); form.append(l);
  }
  $('rules-save').hidden = !may.manage;
}

function paint() {
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  document.title = `SRE ${t('title')}`;
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  for (const [id, key] of [['rank-h', 'rankH'], ['k-top-l', 'top'], ['k-show-text', 'show'], ['rules-h', 'rulesH'], ['rules-note', 'rulesNote'], ['rules-save-text', 'save']]) $(id).textContent = t(key);
  paintRanking(); paintRules();
}

async function loadRules() {
  $('rules-state').textContent = t('reading');
  const out = await session.rules();
  if (out.result === 'ok') { rules = out.value; } else { rules = null; $('rules-state').textContent = api.outcomeWords(lang, out); }
  paintRules();
}

$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
$('rank-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('rank-status').textContent = t('reading');
  const out = await session.ranking(Number($('k-top').value));
  if (out.result === 'ok') { ranked = out.value; $('rank-status').textContent = ''; } else { ranked = null; $('rank-status').textContent = api.outcomeWords(lang, out); }
  paintRanking();
});
$('rules-save').addEventListener('click', async () => {
  const typed = {};
  for (const input of document.querySelectorAll('#rules-form input')) typed[input.dataset.rule] = input.value;
  $('rules-status').textContent = t('reading');
  const out = await session.saveRules(typed);
  if (out.result === 'ok') { rules = out.value; $('rules-status').textContent = t('saved'); paintRules(); } else $('rules-status').textContent = api.outcomeWords(lang, out);
});
paint();
if (!may.named) $('page-status').textContent = t('nobody');
else if (!may.read) $('page-status').textContent = t('cannotRead');
else { $('rank').hidden = false; $('rules').hidden = false; if (!may.manage) $('page-status').textContent = t('cannotManage'); void loadRules(); }
