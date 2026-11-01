// Do not contact (Round 4c · M31-FR-04) — the page over head office's suppression register. The session
// (apps/web-erp/src/do-not-contact-session.ts, in the bundle as window.doNotContact) does every call and every rule; this page
// lays out what it is told. It reads the list as it opens; adding and lifting are explicit presses with a reason. Every word
// this page adds has a Tamil twin; head office's own sentences stay in English (OB-553).

const $ = (id) => document.getElementById(id);
const api = window.doNotContact ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, manage: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }

let list = null;

function paintOptions() {
  for (const [id, values, prefix] of [['a-channel', api?.channels ?? [], 'ch_'], ['a-source', api?.sources ?? [], 'src_']]) {
    const sel = $(id); const was = sel.value;
    sel.replaceChildren(...values.map((v) => { const o = document.createElement('option'); o.value = v; o.textContent = t(`${prefix}${v}`); return o; }));
    if (was !== '') sel.value = was;
  }
}

function paintList() {
  $('rows').replaceChildren(); $('history').replaceChildren();
  if (list === null) return;
  if (list.entries.length === 0) $('rows').append(text('li', t('none'), 'meta'));
  for (const e of list.entries) {
    const li = document.createElement('li'); li.dataset.customer = e.customerId;
    li.append(text('h4', `${e.customerId} — ${t('suppressed')}: ${e.channels.map((c) => t(`ch_${c}`)).join(', ')}`));
    if (may.manage) {
      for (const ch of e.channels) {
        const acts = document.createElement('div'); acts.className = 'acts'; acts.dataset.channel = ch;
        const l = document.createElement('label'); const id = `lift-${e.customerId}-${ch}`; l.htmlFor = id; l.append(text('span', `${t('reason')} (${t(`ch_${ch}`)})`));
        const why = document.createElement('input'); why.id = id; why.autocomplete = 'off'; l.append(why);
        const status = text('p', '', 'status'); status.setAttribute('role', 'status');
        const b = document.createElement('button'); b.type = 'button'; b.className = 'quiet'; b.textContent = t('lift');
        b.addEventListener('click', async () => {
          status.textContent = t('reading');
          const out = await session.lift(e.customerId, ch, why.value);
          status.textContent = out.result === 'ok' ? t('liftedNow') : api.outcomeWords(lang, out);
          if (out.result === 'ok') void load();
        });
        acts.append(l, b, status);
        li.append(acts);
      }
    }
    $('rows').append(li);
  }
  for (const f of list.facts) {
    const li = document.createElement('li'); li.dataset.change = f.change;
    li.append(text('p', `${f.customerId} · ${t(`ch_${f.channel}`)} · ${t(f.change)}${f.source === undefined ? '' : ` (${t(`src_${f.source}`)})`}`),
      text('p', `${t('by')} ${f.by} · ${t('at')} ${api.moment(f.at)} · ${t('reason')}: ${f.reason}`, 'meta'));
    $('history').append(li);
  }
}

function paint() {
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  document.title = `SRE ${t('title')}`;
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  for (const [id, key] of [['add-h', 'addH'], ['a-customer-l', 'customer'], ['a-channel-l', 'channel'], ['a-source-l', 'source'], ['a-reason-l', 'reason'], ['a-add-text', 'add'], ['list-h', 'listH'], ['history-h', 'historyH']]) $(id).textContent = t(key);
  paintOptions(); paintList();
}

async function load() {
  $('list-status').textContent = t('reading');
  const out = await session.list();
  if (out.result === 'ok') { list = out.value; $('list-status').textContent = ''; } else { list = null; $('list-status').textContent = api.outcomeWords(lang, out); }
  paintList();
}

$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
$('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('add-status').textContent = t('reading');
  const out = await session.add({ customerId: $('a-customer').value, channel: $('a-channel').value, source: $('a-source').value, reason: $('a-reason').value });
  $('add-status').textContent = out.result === 'ok' ? (out.value.already ? t('already') : t('added')) : api.outcomeWords(lang, out);
  if (out.result === 'ok') void load();
});
paint();
if (!may.named) $('page-status').textContent = t('nobody');
else if (!may.read) $('page-status').textContent = t('cannotRead');
else { $('list').hidden = false; if (may.manage) $('add').hidden = false; else $('page-status').textContent = t('cannotManage'); void load(); }
