// Customers — the page over head office's M16 routes (R4 · OB-74 · signed OB-227). The session (apps/web-erp/src/customers-
// session.ts, in the bundle as window.customers) asks head office; this page only shows its answers: every customer with
// its segment ("not profiled" listed, never left out), the records that may be the same person (a suggestion — nothing
// merges by itself), and the merges waiting for a second person, in force, and undone. Nothing is written on open.
// Every word has a Tamil twin.

const $ = (id) => document.getElementById(id);
const api = window.customers ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, propose: false, approve: false };

let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
let overview = null;
let matches = null;

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
function row(cells, attrs = {}) {
  const tr = document.createElement('tr');
  for (const c of cells) { const td = document.createElement('td'); td.textContent = c; tr.append(td); }
  for (const [k, v] of Object.entries(attrs)) tr.dataset[k] = v;
  return tr;
}
function say(id, out, good) { $(id).className = `status ${good ? 'good' : 'err'}`; $(id).textContent = good ? out : api.outcomeWords(lang, out); }
const segmentWords = (s) => t(`segment_${s}`);

function mergeLine(m) { return `${m.mergedRef} ${t('into')} ${m.survivorRef} — ${m.reason} (${t('by')} ${m.proposedBy}${m.approvedBy ? `, ${m.approvedBy}` : ''})`; }

function paint() {
  document.title = `SRE ${t('title')}`;
  for (const [id, k] of [['title-text', 'title'], ['page-h', 'title'], ['lead', 'lead'], ['refresh', 'refresh'], ['segments-h', 'segmentsH'], ['duplicates-h', 'duplicatesH'], ['l-candidates', 'candidates'], ['check', 'check'], ['pending-h', 'pendingH'], ['inforce-h', 'inForceH'], ['reversed-h', 'reversedH']]) $(id).textContent = t(k);
  $('lang').textContent = t('lang');
  $('whoami').textContent = window.customersData?.userId ?? '';
  $('nobody').hidden = may.named; $('nobody').textContent = t('nobody');
  $('check').disabled = !may.read; $('refresh').disabled = !may.read;

  const counts = overview?.counts ?? {};
  $('counts').replaceChildren(...Object.entries(counts).map(([s, n]) => {
    const p = el('div', `panel${s === 'not_profiled' && n > 0 ? ' attention' : ''}`); p.dataset.segment = s;
    p.append(el('span', 'k', segmentWords(s)), el('span', 'v', String(n)));
    return p;
  }));
  $('customer-rows').replaceChildren(...(overview?.customers ?? []).map((c) => row(
    [c.customerRef, segmentWords(c.segment), `${c.orders} ${t('orders')}`, c.lastOrderAt === null ? t('noOrder') : `${t('lastOrder')} ${c.lastOrderAt.slice(0, 10)}`],
    { customer: c.customerRef, segment: c.segment, profiled: String(c.profiled) },
  )));

  $('matches').replaceChildren(...(matches === null ? [] : matches.length === 0 ? [el('li', 'row', t('noDuplicates'))] : matches.map((m) => {
    const li = el('li', `row ${m.disposition === 'merge_candidate' ? 'tone-degraded' : ''}`);
    li.dataset.pair = `${m.customerIds[0]}+${m.customerIds[1]}`; li.dataset.disposition = m.disposition;
    li.append(el('span', '', `${m.customerIds[0]} · ${m.customerIds[1]} — ${t(m.disposition)}`));
    if (may.propose) {
      const f = el('form'); const label = el('label'); const input = el('input'); input.className = 'reason'; input.autocomplete = 'off';
      label.append(el('span', '', t('reason')), input);
      const b = el('button', 'propose', t('propose')); b.type = 'submit';
      f.append(label, b);
      f.addEventListener('submit', (e) => { e.preventDefault(); void propose(m.customerIds[0], m.customerIds[1], input.value); });
      li.append(f);
    }
    return li;
  })));

  const merges = overview?.merges ?? { waitingForSecondPerson: [], inForce: [], reversed: [] };
  $('pending').replaceChildren(...(merges.waitingForSecondPerson.length === 0 ? [el('li', 'row', t('none'))] : merges.waitingForSecondPerson.map((m) => {
    const li = el('li', 'row tone-degraded', ''); li.dataset.merge = m.mergeId;
    li.append(el('span', '', mergeLine(m)));
    if (may.approve) { const b = el('button', 'approve', t('approve')); b.type = 'button'; b.addEventListener('click', () => { void approve(m.mergeId); }); li.append(b); }
    return li;
  })));
  $('inforce').replaceChildren(...(merges.inForce.length === 0 ? [el('li', 'row', t('none'))] : merges.inForce.map((m) => {
    const li = el('li', 'row tone-ok'); li.dataset.merge = m.mergeId;
    li.append(el('span', '', mergeLine(m)));
    if (may.approve) {
      const f = el('form'); const label = el('label'); const input = el('input'); input.className = 'undo-reason'; input.autocomplete = 'off';
      label.append(el('span', '', t('undoReason')), input);
      const b = el('button', 'undo', t('undo')); b.type = 'submit';
      f.append(label, b);
      f.addEventListener('submit', (e) => { e.preventDefault(); void undo(m.mergeId, input.value); });
      li.append(f);
    }
    return li;
  })));
  $('reversed').replaceChildren(...(merges.reversed.length === 0 ? [el('li', 'row', t('none'))] : merges.reversed.map((m) => {
    const li = el('li', 'row'); li.dataset.merge = m.mergeId;
    li.append(el('span', '', `${mergeLine(m)} — ${m.reversalReason ?? ''}`));
    return li;
  })));
}

async function load() {
  const out = await session.overview();
  if (out.result === 'ok') { overview = out.value; $('page-status').className = 'status'; $('page-status').textContent = ''; } else { overview = null; say('page-status', out, false); }
  paint();
}
async function check(event) {
  event?.preventDefault();
  const out = await session.duplicates($('candidates').value);
  if (out.result === 'ok') { matches = out.value.matches; $('dup-status').className = 'status'; $('dup-status').textContent = ''; } else { matches = null; say('dup-status', out, false); }
  paint();
}
async function propose(survivor, merged, reason) {
  const out = await session.propose(survivor, merged, reason);
  if (out.result === 'ok') { say('merge-status', t('proposed'), true); await load(); } else say('merge-status', out, false);
}
async function approve(mergeId) {
  const out = await session.approve(mergeId);
  if (out.result === 'ok') { say('merge-status', t('approved'), true); await load(); } else say('merge-status', out, false);
}
async function undo(mergeId, reason) {
  const out = await session.undo(mergeId, reason);
  if (out.result === 'ok') { say('merge-status', t('undone'), true); await load(); } else say('merge-status', out, false);
}

$('dup-form').addEventListener('submit', (e) => { void check(e); });
$('refresh').addEventListener('click', () => { void load(); });
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
if (may.named && !may.read) { $('page-status').className = 'status err'; $('page-status').textContent = t('cannotRead'); }
else if (may.read) void load();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // No offline copy this time; the screen still works online.
  });
}
