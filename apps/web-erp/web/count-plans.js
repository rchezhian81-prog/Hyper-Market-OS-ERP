// Count plans — the view layer (WF-08 · D05-FR-05 · M09-FR-04). Every rule lives at head office; every word and every
// request lives in the TESTED session model (apps/web-erp/src/count-plans-session.ts), attached as
// window.countPlansSession. This file only draws what the session hands it and sends a person's click through it —
// each act once, in their own session — then reads head office again, so what is shown is what head office kept.

/** OB-31: a held quantity (the unit's smallest step) as a person reads it — 2500 of a kg product reads "2.500 kg". */
const qtyText = (n, uom) => (window.sreQuantity?.label ? window.sreQuantity.label(n, uom ?? '') : `${n} ${uom ?? ''}`.trim());
const $ = (id) => document.getElementById(id);
const session = window.countPlansSession ?? null;
let lang = 'en';
const t = (k) => (session === null ? k : session.text(lang, k));

// ── U2 · G5: pick a thing, never type its code ──────────────────────────────
// A "Choose…" button beside an id field opens the shared picker (sreOffice.pick, the chrome); the pick writes the id into
// the field and names it beside, so the page still sends exactly the id it always sent. The field stays typeable: when the
// list cannot be read (head office down, no right) typing the id is the fallback, never a dead end (P-01, P-08).
const pickers = [];
function pickerBeside(input, kind, titleKey, extra = {}) {
  const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'sre-btn pick-btn'; btn.id = `${input.id}-pick`;
  const name = document.createElement('small'); name.className = 'pick-name'; name.id = `${input.id}-name`;
  const host = input.closest('label') ?? input; // beside the field, never inside its label (the label names the input, not the button)
  host.after(btn, name);
  btn.addEventListener('click', async () => {
    const office = window.sreOffice;
    if (!office || typeof office.pick !== 'function') { name.textContent = t('pickUnavailable'); return; }
    const picked = await office.pick({ kind, title: { en: session.text('en', titleKey), ta: session.text('ta', titleKey) }, allowCode: true, ...(typeof extra === 'function' ? extra() : extra) });
    if (!picked || picked.ok !== true) return;
    input.value = picked.id;
    name.textContent = picked.name && picked.name !== picked.id ? `${picked.name} (${picked.id})` : '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  input.addEventListener('input', (e) => { if (e.isTrusted) name.textContent = ''; });
  pickers.push(btn);
  btn.textContent = t('choose'); // named from the first paint, however early the page mounts it
  return btn;
}
const paintPickers = () => { for (const b of pickers) b.textContent = t('choose'); };
/** The signed-in person's own store, from the chrome (sreOffice.me) or the store computer's directory — '' when not known. */
function myStore() {
  const office = window.sreOffice;
  const me = office && typeof office.me === 'function' ? office.me() : null;
  return (me && me.storeId) || (window.sreDirectory && window.sreDirectory.store && window.sreDirectory.store.id) || '';
}
/** The products chosen one by one with the picker: { id, name }. The bulk box (ids, one per line) stays the second path. */
let pickedProducts = [];
function paintPickedProducts() {
  const list = $('product-list');
  if (list === null) return;
  list.replaceChildren(...(pickedProducts.length === 0 ? [node('li', { className: 'muted', textContent: t('noProductsYet') })] : pickedProducts.map((p) => {
    const li = node('li', {}); li.dataset.product = p.id;
    const remove = node('button', { type: 'button', className: 'sre-btn sre-btn-quiet', textContent: t('remove') });
    remove.setAttribute('aria-label', `${t('remove')} ${p.name}`);
    remove.addEventListener('click', () => { pickedProducts = pickedProducts.filter((x) => x.id !== p.id); paintPickedProducts(); });
    li.append(node('span', { textContent: p.name === p.id ? p.id : `${p.name} (${p.id})` }), remove);
    return li;
  })));
}
/** Every product to count: the ones picked, then whatever the bulk box holds — one id per line for the session. */
const productsText = () => [...pickedProducts.map((p) => p.id), $('products').value].join('\n');
// U1 · OB-691 (design system §1.3, §27.1): a money/stock click asks the shared consequence-and-confirm sheet first.
// `null` = the person went back (nothing is sent); 'unavailable' = the sheet could not open (said, never silent).
async function confirmFirst(spec) {
  const office = window.sreOffice;
  if (!office || typeof office.confirm !== 'function') return 'unavailable';
  const answer = await office.confirm(spec);
  return answer && answer.ok === true ? answer : null;
}


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
    const qty = node('input', { className: 'qty', inputMode: 'decimal', 'aria-label': `${t('qty')}: ${line.productId}`, placeholder: t('qty'), autocomplete: 'off' });
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
    : view.heldWriteOffs.map((h) => { const x = session.heldView(lang, h); return node('li', { className: x.state === 'applied' ? 'tone-ok' : 'tone-degraded', dataset: { held: x.heldId, state: x.state } }, node('b', { textContent: `${x.productId} — ${qtyText(x.quantityMinor, x.uom)} · ${x.value}` }), node('span', { className: 'muted', textContent: `${x.stateWord}${x.applied === null ? '' : ` · ${x.applied.writeOffId}`}` })); })));
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

// M08-FR-03: the corrections the handhelds asked for. Each is decided once, by a person who did not ask for it; head office
// posts the one compensating movement on approval. The list is read again after every decision, so it shows what was kept.
let adjustments = null;
function adjustmentNode(r) {
  const v = session.adjustmentView(lang, r);
  const li = node('li', { className: `tone-${v.tone}`, dataset: { request: v.requestId, status: v.status } });
  li.append(node('b', { textContent: v.heading }));
  li.append(node('span', { className: 'muted', textContent: v.where }));
  li.append(node('span', { className: 'muted', textContent: v.value }));
  if (v.note !== null && v.note !== '') li.append(node('span', { className: 'muted', textContent: v.note }));
  for (const f of v.flags) li.append(node('span', { className: 'finding', textContent: `⚠ ${f}` }));
  li.append(node('span', { className: 'state', textContent: v.stateWord }));
  if (v.status === 'pending' && v.yours) li.append(node('span', { className: 'muted yours', textContent: t('adjYours') }));
  if (v.canDecide) {
    const why = node('input', { className: 'adj-reason', 'aria-label': `${t('adjReason')}: ${v.requestId}`, placeholder: t('adjReason'), autocomplete: 'off' });
    const status = node('p', { className: 'status', role: 'status' });
    const decide = (decision) => async () => {
      const out = await session.decideAdjustment(v.requestId, decision, why.value);
      if (out.result === 'ok') {
        await loadAdjustments();
        const good = out.body?.alreadyDecided === true ? 'adjAlready' : decision === 'approved' ? 'adjApprovedNow' : 'adjRejectedNow';
        say($('adj-status'), out, good);
        return;
      }
      say(status, out);
    };
    const yes = node('button', { type: 'button', textContent: t('adjApprove'), dataset: { act: 'approve' } });
    const no = node('button', { type: 'button', className: 'quiet', textContent: t('adjReject'), dataset: { act: 'reject' } });
    yes.addEventListener('click', decide('approved'));
    no.addEventListener('click', decide('rejected'));
    li.append(node('div', { className: 'inline' }, why, yes, no), status);
  }
  return li;
}
function paintAdjustments() {
  if (adjustments === null) { $('adj-rows').replaceChildren(); return; }
  $('adj-rows').replaceChildren(...(adjustments.length === 0 ? [node('li', { className: 'muted', textContent: t('adjEmpty') })] : adjustments.map(adjustmentNode)));
}
async function loadAdjustments() {
  const out = await session.adjustments($('adj-all').checked);
  if (out.result === 'ok') { adjustments = out.requests; $('adj-status').textContent = `${out.pending} ${t('adjPending')}`; $('adj-status').className = 'status'; }
  else { adjustments = null; say($('adj-status'), out); }
  paintAdjustments();
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
  const map = [['who', 'title'], ['title', 'title'], ['lede', 'lede'], ['new-h', 'newH'], ['new-lede', 'newLede'], ['l-place', 'place'], ['l-products-bulk', 'productsBulk'], ['add-product', 'addProduct'], ['l-threshold', 'threshold'], ['l-products', 'products'],
    ['l-freeze', 'freezeLegend'], ['f-default', 'freezeDefault'], ['f-custom', 'freezeCustom'], ['f-none', 'freezeNone'], ['l-note', 'note'], ['create', 'create'],
    ['reg-h', 'registerH'], ['reg-lede', 'registerLede'], ['c-plan', 'colPlan'], ['c-place', 'colPlace'], ['c-products', 'colProducts'], ['c-state', 'colState'], ['c-freeze', 'colFreeze'],
    ['d-open', 'open'], ['l-d-reason', 'reason'], ['d-approve', 'approve'], ['d-cancel', 'cancel'], ['d-sheet-h', 'sheetH'], ['d-sheet-lede', 'sheetLede'], ['d-lines-h', 'linesH'],
    ['d-breaches-h', 'breachesH'], ['d-breaches-lede', 'breachesLede'], ['d-held-h', 'heldH'], ['d-held-lede', 'heldLede'],
    ['adj-h', 'adjH'], ['adj-lede', 'adjLede'], ['adj-show', 'adjShow'], ['l-adj-all', 'adjAll']];
  for (const [id, k] of map) { const el = $(id); if (el) el.textContent = t(k); }
  $('d-close').setAttribute('aria-label', t('close'));
  if (session !== null && !session.nobody && !session.may.read) { $('list-status').className = 'status'; $('list-status').textContent = t('cannotRead'); }
  $('new-section').hidden = session === null || session.nobody || !session.may.plan;
  $('adj-section').hidden = session === null || session.nobody || !session.may.readAdjustments;
  const nobody = $('nobody');
  nobody.hidden = !(session === null || session.nobody);
  nobody.textContent = t('nobody');
  paintKinds();
}

if (session !== null) {
  for (const r of document.querySelectorAll('input[name="freeze"]')) r.addEventListener('change', paintKinds);
  pickerBeside($('place'), 'place', 'whichPlace', () => ({ scope: { storeId: myStore() } }));
  $('add-product').addEventListener('click', async () => {
    const office = window.sreOffice;
    if (!office || typeof office.pick !== 'function') { $('create-status').className = 'status err'; $('create-status').textContent = t('pickUnavailable'); return; }
    const picked = await office.pick({ kind: 'product', title: { en: session.text('en', 'whichProduct'), ta: session.text('ta', 'whichProduct') }, allowCode: true });
    if (!picked || picked.ok !== true) return;
    if (!pickedProducts.some((p) => p.id === picked.id)) pickedProducts.push({ id: picked.id, name: picked.name || picked.id });
    paintPickedProducts();
  });
  paintPickers(); paintPickedProducts();
  $('create').addEventListener('click', async () => {
    $('d-status').textContent = ''; $('d-status').className = 'status';
    const freeze = document.querySelector('input[name="freeze"]:checked')?.value ?? 'default';
    const out = await session.create({
      locationId: $('place').value, productsText: productsText(), thresholdRupees: $('threshold').value, freeze,
      kinds: [...document.querySelectorAll('#kinds input:checked')].map((i) => i.value), note: $('note').value,
    });
    say($('create-status'), out);
    if (out.result === 'ok') { $('products').value = ''; pickedProducts = []; paintPickedProducts(); $('note').value = ''; await loadList(); await openDrawer(out.planId); }
  });
  $('d-open').addEventListener('click', async () => {
    $('d-status').textContent = ''; $('d-status').className = 'status'; const out = await session.open(current.planId); await refreshDrawer(); say($('d-status'), out); });
  $('d-approve').addEventListener('click', async () => {
    $('d-status').textContent = ''; $('d-status').className = 'status';
    // U1 · OB-691: the consequence-and-confirm sheet before the corrections are posted — Go back sends nothing.
    const tt = current?.view?.totals;
    const sub = (l, key) => String(session.text(l, key)).replace('{plan}', current.planId).replace('{place}', current.view?.plan?.locationId ?? '').replace('{counted}', String(tt?.counted ?? '?')).replace('{products}', String(tt?.products ?? '?')).replace('{loss}', tt ? session.rupees(tt.lossMinor) : '—').replace('{gain}', tt ? session.rupees(tt.gainMinor) : '—');
    // With no reason written the session says so, and nothing is sent — no sheet for that.
    const answer = $('d-reason').value.trim() === '' ? { ok: true } : await confirmFirst({ title: { en: sub('en', 'confirmTitle'), ta: sub('ta', 'confirmTitle') }, detail: { en: sub('en', 'confirmDetail'), ta: sub('ta', 'confirmDetail') }, authority: { en: sub('en', 'confirmAuthority'), ta: sub('ta', 'confirmAuthority') }, confirmLabel: { en: sub('en', 'confirmLabel'), ta: sub('ta', 'confirmLabel') }, tone: 'primary' });
    if (answer === 'unavailable') { $('d-status').className = 'status err'; $('d-status').textContent = t('confirmUnavailable'); return; }
    if (answer === null) return;
    const out = await session.approve(current.planId, $('d-reason').value); await refreshDrawer(); say($('d-status'), out); });
  $('d-cancel').addEventListener('click', async () => {
    $('d-status').textContent = ''; $('d-status').className = 'status'; const out = await session.cancel(current.planId, $('d-reason').value); await refreshDrawer(); say($('d-status'), out); });
  $('adj-show').addEventListener('click', () => { void loadAdjustments(); });
  $('adj-all').addEventListener('change', () => { if (adjustments !== null) void loadAdjustments(); });
  $('d-close').addEventListener('click', () => { $('drawer').hidden = true; current = null; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('drawer').hidden) { $('drawer').hidden = true; current = null; } });
  $('lang').addEventListener('click', () => {
    lang = lang === 'en' ? 'ta' : 'en';
    document.documentElement.lang = lang;
    paintWords();
    paintPickers();
    paintPickedProducts();
    paintRegister();
    paintDrawer();
    paintAdjustments();
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
