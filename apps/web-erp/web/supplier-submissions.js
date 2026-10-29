// Supplier submissions — the page over head office's review queue (M24-FR-01/02 · OB-288 package 3). The session
// (apps/web-erp/src/supplier-submissions-session.ts, in the bundle as window.supplierSubmissions) does every call; this
// page lays out what it is told. Only a person whose role may review sees the queue; every decision is a click with a
// reason. Every word has a Tamil twin; every button carries an icon beside its word.

// OB-606: a moment is shown on the SHOP's date (its zone, as the store computer told the page) — never this device's own date.
const shopDayOf = (value) => window.sreShopDay?.dateOf(value) ?? '';
// OB-607: a moment is shown at the SHOP's clock (its zone, as the store computer told the page) — never the UTC clock.
const shopWhen = (value) => window.sreShopDay?.dateTimeOf(value) ?? '';
const $ = (id) => document.getElementById(id);
const api = window.supplierSubmissions ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, review: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
function button(words, iconName, act, quiet) { const b = document.createElement('button'); b.type = 'button'; if (quiet) b.className = 'quiet'; if (act) b.dataset.act = act; const i = icon(iconName); if (i !== null) b.append(i); b.append(text('span', words)); return b; }
const say = (id, out) => { $(id).textContent = api.outcomeWords(lang, out); };
let queue = null; let looked = null;

function deliveryWords(d) { return `PO ${d.poId} · ${d.partnerId} · ${t(`status_${d.status}`)} · ${t('expected')} ${d.expectedOn}${d.note ? ` — ${d.note}` : ''}`; }

function paintQueue() {
  const ul = $('q-rows'); ul.replaceChildren();
  if (queue === null) return;
  if (queue.waiting.length === 0) ul.append(text('li', t('queueNone')));
  for (const row of queue.waiting) {
    const li = document.createElement('li'); li.dataset.submission = row.submissionId; li.dataset.partner = row.partnerId;
    li.append(text('strong', `${t(`kind_${row.kind}`)} — ${row.partnerId}`));
    li.append(text('span', `${row.submissionId} · ${t('received')} ${shopWhen(row.receivedAt)}${row.submittedBy ? ` · ${t('from')} ${row.submittedBy}` : ''}`, 'meta'));
    const line = api.documentLine(row);
    if (line !== '') li.append(text('span', line, 'meta'));
    if (row.feeds) li.append(text('span', `${t('feeds')}: ${row.feeds}`, 'meta'));
    const why = document.createElement('label'); why.append(text('span', t('reason'))); const reason = document.createElement('input'); reason.autocomplete = 'off'; reason.className = 'reason'; why.append(reason);
    const yes = button(t('accept'), 'circle-check', 'accept');
    const no = button(t('reject'), 'circle-alert', 'reject', true);
    const decide = async (d) => { const out = await session.decide(row, d, reason.value); say('q-status', out); if (out.result === 'ok') await load(); };
    yes.addEventListener('click', () => { void decide('accept'); });
    no.addEventListener('click', () => { void decide('reject'); });
    const acts = document.createElement('div'); acts.className = 'actions'; acts.append(yes, no);
    li.append(why, acts); ul.append(li);
  }
  const dl = $('dl-rows'); dl.replaceChildren();
  if (queue.deliveries.length === 0) dl.append(text('li', t('deliveriesNone')));
  for (const d of queue.deliveries) { const li = text('li', `${d.status === 'delayed' ? '⚠ ' : ''}${deliveryWords(d)}`); li.dataset.po = d.poId; dl.append(li); }
  const dc = $('dc-rows'); dc.replaceChildren();
  if (queue.decided.length === 0) dc.append(text('li', t('decidedNone')));
  for (const row of queue.decided) {
    const li = document.createElement('li'); li.dataset.submission = row.submissionId;
    li.append(text('strong', `${t(`kind_${row.kind}`)} — ${row.partnerId}: ${t(row.review.decision)}`), text('span', `${row.review.reason} · ${t('by')} ${row.review.reviewedBy}`, 'meta'));
    dc.append(li);
  }
}
function paintLookup() {
  const ul = $('po-rows'); ul.replaceChildren();
  if (looked === null) return;
  if (looked.updates.length === 0) { ul.append(text('li', t('noWord'))); return; }
  for (const d of looked.updates) ul.append(text('li', `${deliveryWords(d)} · ${t('received')} ${shopDayOf(d.receivedAt)}`));
}

function paint() {
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  for (const [id, key] of [['refresh-text', 'refresh'], ['queue-h', 'queueH'], ['deliveries-h', 'deliveriesH'], ['lookup-h', 'lookupH'], ['po-id-l', 'poId'], ['po-look-text', 'lookup'], ['decided-h', 'decidedH']]) $(id).textContent = t(key);
  paintQueue(); paintLookup();
}

async function load() { const o = await session.readQueue(); if (o.result === 'ok') queue = o.value; else say('page-status', o); paintQueue(); }

for (const [id, name] of [['refresh', 'refresh-cw'], ['po-look', 'search']]) { const i = icon(name); if (i !== null) $(id).prepend(i); }
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
if (!may.named) { $('page-status').textContent = t('nobody'); }
else if (!may.review) { $('page-status').textContent = t('cannotRead'); }
else {
  for (const id of ['queue', 'deliveries', 'decided', 'refresh']) $(id).hidden = false;
  void load();
  $('refresh').addEventListener('click', () => { void load(); });
  $('po-look').addEventListener('click', async () => { const o = await session.readDelivery($('po-id').value); if (o.result === 'ok') { looked = o.value; $('po-status').textContent = ''; } else { looked = null; say('po-status', o); } paintLookup(); });
}

// ── FG-4 · D03-FR-04: supplier-managed stock (VMI). The session (window.vmiDesk) does every call; this lays out its answer. ──
const vmi = window.vmiDesk ?? null;
const vmiMay = vmi?.session?.may ?? { named: false, read: false, decide: false };
const vt = (k) => (vmi === null ? k : vmi.words(lang, k));
const vsay = (id, out) => { $(id).textContent = vmi.outcomeWords(lang, out); };
let vmiItems = null; let vmiQueue = null;

function paintVmi() {
  if (vmi === null) return;
  for (const [id, key] of [['vmi-h', 'vmiH'], ['vmi-lead', 'vmiLead'], ['vmi-supplier-l', 'supplier'], ['vmi-show-text', 'show'], ['vmi-store-l', 'store'], ['vmi-product-l', 'product'], ['vmi-min-l', 'min'], ['vmi-max-l', 'max'], ['vmi-uom-l', 'uom'], ['vmi-set-text', 'setLimit'], ['vmi-q-h', 'proposalsH']]) $(id).textContent = vt(key);
  for (const [id, name] of [['vmi-h', 'package'], ['vmi-q-h', 'list-checks']]) { const i = icon(name); if (i !== null) $(id).prepend(i, ' '); } // the text was just reset: one icon each
  $('vmi-set').disabled = !vmiMay.decide;
  const items = $('vmi-items'); items.replaceChildren();
  if (vmiItems !== null) {
    if (vmiItems.length === 0) items.append(text('li', vt('itemsNone')));
    for (const i of vmiItems) { const li = text('li', `${i.belowMinimum ? '⚠ ' : ''}${vmi.itemWords(lang, i)}`); li.dataset.product = i.productId; li.dataset.store = i.storeId; items.append(li); }
  }
  const ul = $('vmi-q-rows'); ul.replaceChildren();
  if (vmiQueue === null) return;
  if (vmiQueue.length === 0) ul.append(text('li', vt('proposalsNone')));
  for (const p of vmiQueue) {
    const li = document.createElement('li'); li.dataset.proposal = p.proposalId;
    li.append(text('strong', `${p.supplierId} → ${p.storeId}: ${p.lines.map((l) => `${l.quantity} × ${l.productId}`).join(', ')}`));
    li.append(text('span', `${p.proposalId} · ${vt('proposed')} ${shopWhen(p.proposedAt)}${p.note ? ` — ${p.note}` : ''}`, 'meta'));
    const costs = {};
    const form = document.createElement('div'); form.className = 'row-form';
    for (const l of p.lines) {
      const lab = document.createElement('label'); lab.append(text('span', `${vt('unitCost')} — ${l.productId}`));
      const inp = document.createElement('input'); inp.inputMode = 'decimal'; inp.autocomplete = 'off'; inp.dataset.cost = l.productId; costs[l.productId] = inp; lab.append(inp); form.append(lab);
    }
    const poLab = document.createElement('label'); poLab.append(text('span', vt('poId'))); const po = document.createElement('input'); po.autocomplete = 'off'; po.className = 'po'; poLab.append(po); form.append(poLab);
    const whyLab = document.createElement('label'); whyLab.append(text('span', vt('reason'))); const reason = document.createElement('input'); reason.autocomplete = 'off'; reason.className = 'reason'; whyLab.append(reason); form.append(whyLab);
    const yes = button(vt('accept'), 'circle-check', 'vmi-accept');
    const no = button(vt('reject'), 'circle-alert', 'vmi-reject', true);
    yes.disabled = !vmiMay.decide; no.disabled = !vmiMay.decide;
    const decide = async (d) => {
      const typed = Object.fromEntries(Object.entries(costs).map(([k, v]) => [k, v.value]));
      const out = await vmi.session.decide(p, d, reason.value, po.value, typed);
      vsay('vmi-q-status', out);
      if (out.result === 'ok') await loadVmi();
    };
    yes.addEventListener('click', () => { void decide('accept'); });
    no.addEventListener('click', () => { void decide('reject'); });
    const acts = document.createElement('div'); acts.className = 'actions'; acts.append(yes, no);
    li.append(form, acts); ul.append(li);
  }
}

async function showVmiItems() {
  const out = await vmi.session.items($('vmi-supplier').value);
  if (out.result === 'ok') { vmiItems = out.value.items; $('vmi-status').textContent = ''; } else { vmiItems = null; vsay('vmi-status', out); }
  paintVmi();
}
async function loadVmi() {
  const out = await vmi.session.queue();
  if (out.result === 'ok') vmiQueue = out.value.proposals; else vsay('vmi-q-status', out);
  if (vmiItems !== null && $('vmi-supplier').value.trim() !== '') await showVmiItems(); else paintVmi();
}

if (vmi !== null && vmiMay.read) {
  $('vmi').hidden = false;
  for (const [id, name] of [['vmi-show', 'boxes'], ['vmi-set', 'sliders']]) { const i = icon(name); if (i !== null) $(id).prepend(i); }
  $('vmi-show').addEventListener('click', () => { void showVmiItems(); });
  $('vmi-set').addEventListener('click', async () => {
    const out = await vmi.session.setLimit({ supplierId: $('vmi-supplier').value, storeId: $('vmi-store').value, productId: $('vmi-product').value, min: $('vmi-min').value, max: $('vmi-max').value, uom: $('vmi-uom').value });
    vsay('vmi-status', out);
    if (out.result === 'ok') await showVmiItems();
  });
  $('lang').addEventListener('click', () => { paintVmi(); });
  paintVmi();
  void loadVmi();
}
