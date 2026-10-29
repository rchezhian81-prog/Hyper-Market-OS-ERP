// Count plans — the view layer (WF-08 · D05-FR-05 · M09-FR-04). Every rule lives at head office; every word and every
// request lives in the TESTED session model (apps/web-erp/src/count-plans-session.ts), attached as
// window.countPlansSession. This file only draws what the session hands it and sends a person's click through it —
// each act once, in their own session — then reads head office again, so what is shown is what head office kept.

const $ = (id) => document.getElementById(id);
const session = window.countPlansSession ?? null;
let lang = 'en';
const t = (k) => (session === null ? k : session.text(lang, k));

let plans = null;
let current = null; // { planId, view, sheet }

function say(el, out, good) {
  const s = session.say(lang, out, good);
  el.className = `status ${s.tone}`;
  el.textContent = s.words;
}
const node = (tag, props = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v);
  }
  el.append(...kids.filter((x) => x !== null && x !== undefined));
  return el;
};

function paintPanels() {
  for (const s of ['planned', 'counting', 'approved', 'cancelled']) {
    $(`n-${s}`).textContent = plans === null ? '–' : String(plans.filter((p) => p.state === s).length);
    $(`p-${s}`).textContent = t(s);
  }
}

function paintRegister() {
  const body = $('register').querySelector('tbody');
  body.replaceChildren();
  paintPanels();
  if (plans === null) return;
  if (plans.length === 0) { body.append(node('tr', {}, node('td', { colSpan: 6, className: 'muted', textContent: t('empty') }))); return; }
  for (const p of plans) {
    const look = node('button', { type: 'button', className: 'quiet', textContent: t('view'), dataset: { act: 'view' } });
    look.addEventListener('click', () => { void openDrawer(p.planId); });
    body.append(node('tr', { dataset: { plan: p.planId, state: p.state } },
      node('td', { textContent: p.planId }), node('td', { textContent: p.locationId }), node('td', { textContent: p.productIds.join(', ') }),
      node('td', { textContent: t(p.state) }), node('td', { textContent: session.freezeWords(lang, p) }), node('td', {}, look)));
  }
}

async function loadList() {
  if (session === null || session.nobody) return;
  if (!session.may.read) { $('list-status').className = 'status'; $('list-status').textContent = t('cannotRead'); return; }
  const out = await session.list();
  if (out.result === 'ok') { plans = out.plans; if ($('list-status').textContent === t('reading')) $('list-status').textContent = ''; }
  else { plans = null; say($('list-status'), out); }
  paintRegister();
}

function lineNode(line) {
  const v = session.lineView(lang, line);
  const li = node('li', { className: `tone-${v.tone}`, dataset: { product: v.productId, state: v.state } });
  li.append(node('b', { textContent: `${v.productId} — ${v.stateWord}` }));
  if (v.counted !== null) {
    li.append(node('span', { className: 'muted', textContent: `${t('expected')} ${v.expected} · ${t('countedLbl')} ${v.counted} · ${t('variance')} ${v.variance > 0 ? '+' : ''}${v.variance} · ${t('value')} ${v.value}` }));
  }
  if (v.recountBecause.length > 0) li.append(node('span', { className: 'muted', textContent: v.recountBecause.join('; ') }));
  if (v.cause !== null) li.append(node('span', { className: 'muted', textContent: `${t('cause')}: ${v.cause}` }));
  if (v.needsCause && current.view.plan.state === 'counting' && session.may.plan) {
    const select = node('select', { 'aria-label': `${t('cause')}: ${v.productId}` });
    for (const c of ['damaged', 'expired', 'miscount', 'found', 'theft_suspected', 'other']) select.append(node('option', { value: c, textContent: t(c) }));
    const note = node('input', { 'aria-label': `${t('why')}: ${v.productId}`, placeholder: t('why'), autocomplete: 'off' });
    const set = node('button', { type: 'button', textContent: t('setCause'), dataset: { act: 'cause' } });
    set.addEventListener('click', async () => {
    $('d-status').textContent = ''; $('d-status').className = 'status';
      const out = await session.cause(current.planId, v.finalCountId, select.value, note.value);
      if (out.result === 'ok') await refreshDrawer();
      say($('d-status'), out);
    });
    li.append(node('div', { className: 'inline' }, select, note, set));
  }
  return li;
}

function sheetNode(line) {
  const li = node('li', { dataset: { product: line.productId, todo: line.toDo } });
  const word = line.toDo === 'count' ? t('count') : line.toDo === 'recount' ? `${t('recount')} (${t('recountOfCount')} ${line.recountOf})` : t('done');
  li.append(node('b', { textContent: `${line.productId} — ${word}` }));
  if (line.toDo !== 'done' && current.sheet.state === 'counting' && session.may.count) {
    const qty = node('input', { className: 'qty', inputMode: 'numeric', 'aria-label': `${t('qty')}: ${line.productId}`, placeholder: t('qty'), autocomplete: 'off' });
    const uom = node('input', { className: 'uom', value: 'EA', 'aria-label': `${t('uom')}: ${line.productId}`, autocomplete: 'off' });
    const go = node('button', { type: 'button', textContent: line.toDo === 'count' ? t('countIt') : t('recountIt'), dataset: { act: 'count' } });
    go.addEventListener('click', async () => {
    $('d-status').textContent = ''; $('d-status').className = 'status';
      const out = await session.count(current.planId, { productId: line.productId, locationId: current.sheet.locationId, uom: uom.value, countedText: qty.value, recountOf: line.recountOf });
      // Head office's answer is said once the drawer shows what it now holds, so nothing is typed into a row being redrawn.
      if (out.result === 'ok') await refreshDrawer();
      say($('d-status'), out);
    });
    li.append(node('div', { className: 'inline' }, qty, uom, go));
  }
  return li;
}

function paintDrawer() {
  if (current === null) return;
  const view = current.view;
  $('d-title').textContent = current.planId;
  if (view === null) { $('d-state').textContent = ''; for (const id of ['d-lines', 'd-sheet', 'd-breaches', 'd-held']) $(id).replaceChildren(); return; }
  const p = view.plan;
  const by = p.state === 'approved' ? ` · ${t('approvedBy')} ${p.approvedBy}` : p.state === 'cancelled' ? ` · ${t('cancelledBy')} ${p.cancelledBy}` : '';
  $('d-state').textContent = `${t(p.state)} · ${p.locationId} · ${t('plannedBy')} ${p.plannedBy}${by}`;
  $('d-state').dataset.state = p.state;
  $('d-freeze').textContent = session.freezeWords(lang, p);
  const tt = view.totals;
  $('d-totals').textContent = `${tt.counted} ${t('of')} ${tt.products} ${t('countedOf')} · ${tt.recountRequired} ${t('recountNeeded')} · ${tt.causeRequired} ${t('causeNeeded')} · ${t('loss')} ${session.rupees(tt.lossMinor)} · ${t('gain')} ${session.rupees(tt.gainMinor)}`;
  $('d-open').hidden = !(p.state === 'planned' && session.may.plan);
  $('d-approve').hidden = !(p.state === 'counting' && session.may.approve);
  $('d-cancel').hidden = !((p.state === 'planned' || p.state === 'counting') && session.may.plan);
  $('d-reason').parentElement.hidden = $('d-approve').hidden && $('d-cancel').hidden;
  $('d-lines').replaceChildren(...view.lines.map(lineNode));
  const sheet = current.sheet;
  $('d-sheet').replaceChildren(...(sheet === null ? [] : sheet.lines.map(sheetNode)));
  $('d-breaches').replaceChildren(...(view.freezeBreaches.length === 0
    ? [node('li', { className: 'muted', textContent: t('noBreaches') })]
    : view.freezeBreaches.map((b) => { const x = session.breachView(lang, b); return node('li', { className: 'tone-error', dataset: { movement: x.movementId } }, node('b', { textContent: `${x.productId} — ${x.kindWord} (${x.effectMinor > 0 ? '+' : ''}${x.effectMinor})` }), node('span', { className: 'muted', textContent: `${x.movementId} · ${window.sreShopDay?.dateTimeOf(x.occurredAt) ?? ''}` })); })));
  $('d-held').replaceChildren(...(view.heldWriteOffs.length === 0
    ? [node('li', { className: 'muted', textContent: t('noHeld') })]
    : view.heldWriteOffs.map((h) => { const x = session.heldView(lang, h); return node('li', { className: x.state === 'applied' ? 'tone-ok' : 'tone-degraded', dataset: { held: x.heldId, state: x.state } }, node('b', { textContent: `${x.productId} — ${x.quantityMinor} ${x.uom} · ${x.value}` }), node('span', { className: 'muted', textContent: `${x.stateWord}${x.applied === null ? '' : ` · ${x.applied.writeOffId}`}` })); })));
}

async function refreshDrawer() {
  if (current === null) return;
  const [view, sheet] = await Promise.all([session.read(current.planId), session.may.count ? session.sheet(current.planId) : Promise.resolve(null)]);
  if (view.result === 'ok') current.view = view.view; else { current.view = null; say($('d-status'), view); }
  current.sheet = sheet !== null && sheet.result === 'ok' ? sheet.sheet : null;
  paintDrawer();
  await loadList();
}

async function openDrawer(planId) {
  current = { planId, view: null, sheet: null };
  $('d-status').textContent = '';
  $('d-reason').value = '';
  $('drawer').hidden = false;
  await refreshDrawer();
  $('d-close').focus();
}

function paintKinds() {
  const box = $('kinds');
  const was = new Set([...box.querySelectorAll('input:checked')].map((i) => i.value));
  box.replaceChildren(node('legend', { textContent: t('freezeLegend') }));
  const kinds = ['adjusted', 'wasted', 'received', 'transferred_in', 'transferred_out', 'returned_to_supplier', 'produced', 'consumed_in_production', 'counted'];
  for (const k of kinds) {
    const input = node('input', { type: 'checkbox', name: 'kind', value: k });
    input.checked = was.size === 0 ? (k === 'adjusted' || k === 'wasted') : was.has(k);
    box.append(node('label', {}, input, node('span', { textContent: t(k) })));
  }
  box.hidden = document.querySelector('input[name="freeze"]:checked')?.value !== 'custom';
}

function paintWords() {
  document.title = `SRE ${t('title')}`;
  const map = [['who', 'title'], ['title', 'title'], ['lede', 'lede'], ['new-h', 'newH'], ['new-lede', 'newLede'], ['l-place', 'place'], ['l-threshold', 'threshold'], ['l-products', 'products'],
    ['l-freeze', 'freezeLegend'], ['f-default', 'freezeDefault'], ['f-custom', 'freezeCustom'], ['f-none', 'freezeNone'], ['l-note', 'note'], ['create', 'create'],
    ['reg-h', 'registerH'], ['reg-lede', 'registerLede'], ['c-plan', 'colPlan'], ['c-place', 'colPlace'], ['c-products', 'colProducts'], ['c-state', 'colState'], ['c-freeze', 'colFreeze'],
    ['d-open', 'open'], ['l-d-reason', 'reason'], ['d-approve', 'approve'], ['d-cancel', 'cancel'], ['d-sheet-h', 'sheetH'], ['d-sheet-lede', 'sheetLede'], ['d-lines-h', 'linesH'],
    ['d-breaches-h', 'breachesH'], ['d-breaches-lede', 'breachesLede'], ['d-held-h', 'heldH'], ['d-held-lede', 'heldLede']];
  for (const [id, k] of map) { const el = $(id); if (el) el.textContent = t(k); }
  $('d-close').setAttribute('aria-label', t('close'));
  if (session !== null && !session.nobody && !session.may.read) { $('list-status').className = 'status'; $('list-status').textContent = t('cannotRead'); }
  $('new-section').hidden = session === null || session.nobody || !session.may.plan;
  const nobody = $('nobody');
  nobody.hidden = !(session === null || session.nobody);
  nobody.textContent = t('nobody');
  paintKinds();
}

if (session !== null) {
  for (const r of document.querySelectorAll('input[name="freeze"]')) r.addEventListener('change', paintKinds);
  $('create').addEventListener('click', async () => {
    $('d-status').textContent = ''; $('d-status').className = 'status';
    const freeze = document.querySelector('input[name="freeze"]:checked')?.value ?? 'default';
    const out = await session.create({
      locationId: $('place').value, productsText: $('products').value, thresholdRupees: $('threshold').value, freeze,
      kinds: [...document.querySelectorAll('#kinds input:checked')].map((i) => i.value), note: $('note').value,
    });
    say($('create-status'), out);
    if (out.result === 'ok') { $('products').value = ''; $('note').value = ''; await loadList(); await openDrawer(out.planId); }
  });
  $('d-open').addEventListener('click', async () => {
    $('d-status').textContent = ''; $('d-status').className = 'status'; const out = await session.open(current.planId); await refreshDrawer(); say($('d-status'), out); });
  $('d-approve').addEventListener('click', async () => {
    $('d-status').textContent = ''; $('d-status').className = 'status'; const out = await session.approve(current.planId, $('d-reason').value); await refreshDrawer(); say($('d-status'), out); });
  $('d-cancel').addEventListener('click', async () => {
    $('d-status').textContent = ''; $('d-status').className = 'status'; const out = await session.cancel(current.planId, $('d-reason').value); await refreshDrawer(); say($('d-status'), out); });
  $('d-close').addEventListener('click', () => { $('drawer').hidden = true; current = null; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('drawer').hidden) { $('drawer').hidden = true; current = null; } });
  $('lang').addEventListener('click', () => {
    lang = lang === 'en' ? 'ta' : 'en';
    document.documentElement.lang = lang;
    paintWords();
    paintRegister();
    paintDrawer();
  });
}

paintWords();
paintPanels();
if (session !== null && !session.nobody) { $('list-status').textContent = t('reading'); void loadList(); }

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // No offline copy this time; the screen still works online.
  });
}
