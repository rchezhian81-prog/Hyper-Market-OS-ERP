// Message queue (W3 · M31-FR-04) — the page over head office's notification queue and messaging budget. The session
// (apps/web-erp/src/message-queue-session.ts, in the bundle as window.messageQueue) does every call and every rule; this page
// lays out what it is told. It reads as it opens; setting the budget is an explicit press. Every word this page adds has a
// Tamil twin; head office's own sentences stay in English (OB-553).

const $ = (id) => document.getElementById(id);
const api = window.messageQueue ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, setBudget: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }

let budget = null;
let queues = null;

function itemRows(host, items, none) {
  host.replaceChildren();
  if (items.length === 0) { host.append(text('li', t(none), 'meta')); return; }
  for (const i of items) {
    const li = document.createElement('li'); li.dataset.id = i.id;
    li.append(text('h4', `${i.id} · ${t(`ch_${i.channel}`)}`), text('p', `${i.attempts} ${t('tries')}${i.reason === null ? '' : ` · ${t('why')}: ${i.reason}`}`, 'meta'));
    host.append(li);
  }
}

function paintBudget() {
  const now = $('budget-now'); now.replaceChildren();
  if (budget === null) return;
  if (budget.budget === null) now.append(text('strong', t('notSet'), 'not-set'));
  else {
    const b = budget.budget;
    now.append(text('span', `${t('period')} ${budget.period} · ${t('cap')} ${api.rupees(b.capMinor)} · ${t('spent')} ${api.rupees(budget.spentMinor)} · ${t('left')} ${api.rupees(budget.remainingMinor)} · ${t('version')} ${b.version}, ${t('setBy')} ${b.setBy}`));
  }
  if (budget.held.length > 0) now.append(text('p', `${budget.held.length} ${t('heldForBudget')}`, 'meta held-count'));
  const costs = $('b-costs');
  if (costs.childElementCount === 0) {
    for (const ch of api?.channels ?? []) {
      const l = document.createElement('label'); l.htmlFor = `b-cost-${ch}`;
      const input = document.createElement('input'); input.id = `b-cost-${ch}`; input.dataset.channel = ch; input.inputMode = 'decimal'; input.autocomplete = 'off';
      l.append(text('span', `${t('costOf')} — ${t(`ch_${ch}`)}`, 'cost-l'), input); costs.append(l);
    }
  } else for (const l of costs.querySelectorAll('label')) l.querySelector('.cost-l').textContent = `${t('costOf')} — ${t(`ch_${l.querySelector('input').dataset.channel}`)}`;
}

function paintQueues() {
  if (queues === null) return;
  itemRows($('dead'), queues.deadLetters, 'noneDead');
  itemRows($('withheld'), queues.withheld, 'noneWithheld');
  itemRows($('pending'), queues.pending, 'noneWaiting');
}

function paint() {
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  document.title = `SRE ${t('title')}`;
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  for (const [id, key] of [['budget-h', 'budgetH'], ['b-cap-l', 'cap'], ['b-save-text', 'saveBudget'], ['dead-h', 'deadH'], ['withheld-h', 'withheldH'], ['pending-h', 'pendingH']]) $(id).textContent = t(key);
  paintBudget(); paintQueues();
}

async function load() {
  $('budget-status').textContent = t('reading'); $('queue-status').textContent = t('reading');
  const [b, q] = await Promise.all([session.budget(), session.queue()]);
  if (b.result === 'ok') { budget = b.value; $('budget-status').textContent = ''; } else { budget = null; $('budget-status').textContent = api.outcomeWords(lang, b); }
  if (q.result === 'ok') { queues = q.value; $('queue-status').textContent = ''; } else { queues = null; $('queue-status').textContent = api.outcomeWords(lang, q); }
  paintBudget(); paintQueues();
}

$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
$('budget-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const costs = {};
  for (const input of document.querySelectorAll('#b-costs input')) costs[input.dataset.channel] = input.value;
  $('budget-save-status').textContent = t('reading');
  const out = await session.setBudget({ cap: $('b-cap').value, costs });
  if (out.result === 'ok') { budget = out.value; $('budget-save-status').textContent = t('savedBudget'); paintBudget(); } else $('budget-save-status').textContent = api.outcomeWords(lang, out);
});
paint();
if (!may.named) $('page-status').textContent = t('nobody');
else if (!may.read) $('page-status').textContent = t('cannotRead');
else { $('budget').hidden = false; $('queues').hidden = false; $('budget-form').hidden = !may.setBudget; if (!may.setBudget) $('budget-save-status').textContent = t('cannotSet'); void load(); }
