// Shelves and space — the HEAD-OFFICE setup tabs (Round 4a: re-audit M04-FR-04 · R8-8 · screen gap audit Round D).
//
// The view layer only. Every request, every check of who may, every refusal's wording lives in the TESTED session
// (`apps/web-erp/src/merchandising-setup-session.ts`), attached as `window.merchSetup`. This file lays out three things the
// page could not do before:
//   • record a supplier display contract — Finance approves the money first (ask, then record with THAT approval);
//   • clusters and seasons — list or drop an item in every store of a cluster (a price zone), see a store's range, make a
//     season plan, end the seasons that are over;
//   • the shelf layout — load the shelf map, the planogram and the floor plan head office holds for a store, change the
//     lines, publish each as a new version.
// Nothing is read on open; every read and write is a person's click. A refusal is head office's own words; no answer says
// nothing was saved. Every word has a Tamil twin (the session's copy). No `prompt`, `confirm` or `alert`.

const $ = (id) => document.getElementById(id);
const api = window.merchSetup ?? null;
const session = api?.session ?? null;
const kit = api?.kit ?? null;
const may = session?.may ?? { named: false, contract: false, rangeRead: false, rangeManage: false, publish: false, planRead: false, spaceRead: false };

/** Shown when the bundle gave no setup session at all (this page was told nothing about who is looking). */
const NOT_CONNECTED = {
  en: 'This screen was not told who is looking, so it offers nothing to change.',
  ta: 'யார் பார்க்கிறார்கள் என்று இந்தத் திரைக்குச் சொல்லப்படவில்லை, எனவே மாற்ற எதுவும் வழங்கப்படவில்லை.',
};

let lang = document.documentElement.lang === 'ta' ? 'ta' : 'en';
const w = (key, fill) => (kit === null ? key : kit.words(lang)(key, fill));
const say = (id, text, ok) => { const n = $(id); n.textContent = text; n.className = `status ${ok === true ? 'ok' : ok === false ? 'err' : ''}`.trim(); };
const sayOutcome = (id, out, mode) => say(id, kit.outcomeWords(lang, out, mode), false);
const node = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
const val = (id) => $(id).value;

// ── The editable lines (shelf map, planogram, floor plan) ─────────────────────────────────────────────────────────

const SHELF_COLS = [['locationId', 'text'], ['aisle', 'num'], ['rack', 'num'], ['bay', 'num'], ['shelf', 'num'], ['position', 'num'], ['zone', 'zone'], ['label', 'text']];
const PLAN_COLS = [['productId', 'text'], ['locationId', 'text'], ['capacity', 'num'], ['primary', 'check']];
const AREA_COLS = [['areaId', 'text'], ['name', 'text'], ['nameTa', 'text'], ['x', 'num'], ['y', 'num'], ['width', 'num'], ['depth', 'num'], ['squareFeet', 'num'], ['places', 'text']];
const blank = (cols) => Object.fromEntries(cols.map(([k, type]) => [k, type === 'check' ? false : '']));
const lines = { sm: [], pg: [], fp: [] };
const COLS = { sm: SHELF_COLS, pg: PLAN_COLS, fp: AREA_COLS };

function drawGrid(which) {
  const table = $(`${which}-rows`);
  const cols = COLS[which];
  const head = node('tr');
  head.append(node('th', '#'));
  for (const [key] of cols) head.append(node('th', w(key === 'places' ? 'areaPlaces' : key)));
  head.append(node('th', ''));
  const rows = lines[which].map((row, i) => {
    const tr = node('tr');
    tr.dataset.line = String(i + 1);
    tr.append(node('td', String(i + 1)));
    for (const [key, type] of cols) {
      const td = node('td');
      let input;
      if (type === 'zone') {
        input = node('select');
        input.append(node('option', ''));
        for (const z of kit?.zones ?? []) { const o = node('option', z); o.value = z; input.append(o); }
        input.value = row[key] ?? '';
        input.addEventListener('change', () => { row[key] = input.value; });
      } else if (type === 'check') {
        input = node('input');
        input.type = 'checkbox';
        input.checked = row[key] === true;
        input.addEventListener('change', () => { row[key] = input.checked; });
      } else {
        input = node('input');
        input.type = 'text';
        if (type === 'num') input.inputMode = 'decimal';
        input.autocomplete = 'off';
        input.value = row[key] ?? '';
        input.addEventListener('input', () => { row[key] = input.value; });
      }
      input.dataset.field = key;
      input.setAttribute('aria-label', `${w(key)} ${i + 1}`);
      td.append(input);
      tr.append(td);
    }
    const remove = node('button', w('removeLine'));
    remove.type = 'button';
    remove.className = 'remove';
    remove.addEventListener('click', () => { lines[which].splice(i, 1); drawGrid(which); });
    const td = node('td'); td.append(remove); tr.append(td);
    return tr;
  });
  table.replaceChildren(head, ...rows);
}

// ── Painting the words and what this person may do ────────────────────────────────────────────────────────────

function paint() {
  for (const n of document.querySelectorAll('[data-w]')) n.textContent = w(n.dataset.w);
  const reason = $('cl-reason');
  const chosen = reason.value;
  reason.replaceChildren(...(kit?.reasons ?? []).map((r) => { const o = node('option', w(r)); o.value = r; return o; }));
  if (chosen !== '') reason.value = chosen;
  const note = (id, text) => { $(id).hidden = text === ''; $(id).textContent = text; };
  if (session === null) {
    for (const id of ['contract-note', 'clusters-note', 'layout-note']) note(id, NOT_CONNECTED[lang]);
  } else if (!may.named) {
    for (const id of ['contract-note', 'clusters-note', 'layout-note']) note(id, w('nobody'));
  } else {
    note('contract-note', may.contract ? '' : w('cannotContract'));
    note('clusters-note', may.rangeManage ? '' : may.rangeRead ? w('cannotRangeManage') : w('cannotRangeRead'));
    note('layout-note', may.publish ? '' : may.planRead || may.spaceRead ? w('cannotPublish') : w('cannotPlanRead'));
  }
  // An action is offered only to a viewer who holds its permission; head office re-checks every act.
  for (const id of ['ct-ask', 'ct-record']) $(id).disabled = !may.contract;
  $('ct-asks-show').disabled = !may.contract;
  for (const id of ['cl-show', 'sr-show', 'se-show']) $(id).disabled = !may.rangeRead;
  for (const id of ['cl-list-btn', 'cl-drop-btn', 'se-make', 'se-sweep']) $(id).disabled = !may.rangeManage;
  $('ly-load').disabled = !(may.planRead || may.spaceRead);
  for (const id of ['sm-add', 'sm-publish', 'pg-add', 'pg-publish', 'fp-add', 'fp-publish']) $(id).disabled = !may.publish;
  for (const which of ['sm', 'pg', 'fp']) drawGrid(which);
  drawAsks(); drawClusters(); drawSeasons(); drawMeta();
}

// ── Display contract (M04-FR-04 · D02-FR-06) ──────────────────────────────────────────────────────────────────

const contractForm = () => ({
  contractId: val('ct-id'), storeId: val('ct-store'), supplierId: val('ct-supplier'), description: val('ct-description'),
  fundingRupees: val('ct-funding'), startsOn: val('ct-starts'), endsOn: val('ct-ends'), places: val('ct-places'), areaId: val('ct-area'),
});
let asks = null;
function drawAsks() {
  $('ct-asks-h').hidden = asks === null;
  if (asks === null) { $('ct-asks').replaceChildren(); return; }
  if (asks.length === 0) { $('ct-asks').replaceChildren(node('li', w('noAsks'), 'saved')); return; }
  $('ct-asks').replaceChildren(...asks.map((a) => {
    const li = node('li', undefined, 'saved');
    li.dataset.ask = a.requestId;
    li.append(node('span', `${a.subjectRef} — ${a.summary}`, 'what'), node('span', kit.askWords(lang, a), 'pill'));
    if (a.status === 'approved' && may.contract) {
      const b = node('button', w('recordApproved'));
      b.type = 'button';
      b.className = 'primary';
      b.addEventListener('click', () => { void recordApproved(a); });
      li.append(b);
    }
    return li;
  }));
}
async function refreshAsks() {
  const out = await session.contractAsks();
  if (out.kind === 'done') asks = out.body; else sayOutcome('ct-status', out, 'read');
  drawAsks();
}
async function recordApproved(ask) {
  const out = await session.recordApprovedContract(ask);
  if (out.kind === 'done') say('ct-status', out.body.approved ? w('contractRecordedApproved') : w('contractRecordedUnapproved'), out.body.approved);
  else sayOutcome('ct-status', out);
  await refreshAsks();
}
$('ct-ask').addEventListener('click', async () => {
  const out = await session.askContractApproval(contractForm(), val('ct-reason'));
  if (out.kind === 'done') { say('ct-status', w('askSent'), true); await refreshAsks(); } else sayOutcome('ct-status', out);
});
$('ct-record').addEventListener('click', async () => {
  const out = await session.recordContract(contractForm());
  if (out.kind === 'done') say('ct-status', out.body.approved ? w('contractRecordedApproved') : w('contractRecordedUnapproved'), true);
  else sayOutcome('ct-status', out);
});
$('ct-asks-show').addEventListener('click', () => { void refreshAsks(); });

// ── Clusters and seasons (R8-8 · OB-318) ──────────────────────────────────────────────────────────────────────

let clusters = null;
function drawClusters() {
  if (clusters === null) { $('cl-list').replaceChildren(); return; }
  if (clusters.length === 0) { $('cl-list').replaceChildren(node('p', w('noClusters'), 'empty')); return; }
  const table = node('table');
  const head = node('tr'); head.append(node('th', w('cluster')), node('th', w('storesIn'))); table.append(head);
  for (const c of clusters) { const tr = node('tr'); tr.dataset.zone = c.zoneId; tr.append(node('td', c.zoneId), node('td', c.stores.join(', '))); table.append(tr); }
  $('cl-list').replaceChildren(table);
  $('cl-zones').replaceChildren(...clusters.map((c) => { const o = node('option'); o.value = c.zoneId; return o; }));
}
$('cl-show').addEventListener('click', async () => {
  const out = await session.clusters();
  if (out.kind === 'done') { clusters = out.body.clusters; say('cl-read-status', ''); } else { clusters = null; sayOutcome('cl-read-status', out, 'read'); }
  drawClusters();
});
$('cl-list-btn').addEventListener('click', async () => {
  const out = await session.listForCluster(val('cl-zone'), val('cl-product'), val('cl-from'));
  if (out.kind === 'done') say('cl-status', `${w('listedInCluster')} ${out.body.stores.join(', ')}`, true); else sayOutcome('cl-status', out);
});
$('cl-drop-btn').addEventListener('click', async () => {
  const out = await session.dropForCluster(val('cl-zone'), val('cl-product'), { reason: val('cl-reason'), effectiveFrom: val('cl-from'), reasonNote: val('cl-note'), replacedByProductId: val('cl-replaced') });
  if (out.kind === 'done') say('cl-status', `${w('dropOutcome')} ${out.body.decisions.map((d) => `${d.storeId} — ${w(d.outcome)}`).join('; ')}`, true);
  else sayOutcome('cl-status', out);
});
$('sr-show').addEventListener('click', async () => {
  const out = await session.storeRange(val('sr-store'), val('sr-date'));
  if (out.kind === 'done') say('sr-status', out.body.listed.length === 0 ? w('rangeEmpty') : `${out.body.storeId} · ${out.body.onDate}: ${out.body.listed.join(' · ')}`, out.body.listed.length === 0 ? undefined : true);
  else sayOutcome('sr-status', out, 'read');
});

let seasons = null;
function drawSeasons() {
  if (seasons === null) { $('se-list').replaceChildren(); return; }
  if (seasons.length === 0) { $('se-list').replaceChildren(node('p', w('noSeasons'), 'empty')); return; }
  const table = node('table');
  const head = node('tr');
  for (const k of ['planId', 'scopeId', 'products', 'listFrom', 'listTo', 'scope']) head.append(node('th', k === 'scope' ? '' : w(k)));
  table.append(head);
  for (const p of seasons) {
    const tr = node('tr'); tr.dataset.plan = p.planId;
    tr.append(node('td', p.planId), node('td', `${p.zoneId ?? p.storeId ?? ''} (${p.storeIds.join(', ')})`), node('td', p.productIds.join(', ')), node('td', p.listFrom), node('td', p.listTo), node('td', w(p.standing), 'standing'));
    table.append(tr);
  }
  $('se-list').replaceChildren(table);
}
async function refreshSeasons() {
  const out = await session.seasonPlans();
  if (out.kind === 'done') { seasons = out.body.plans; say('se-read-status', ''); } else { seasons = null; sayOutcome('se-read-status', out, 'read'); }
  drawSeasons();
}
$('se-show').addEventListener('click', () => { void refreshSeasons(); });
$('se-make').addEventListener('click', async () => {
  const out = await session.makeSeasonPlan({ planId: val('se-plan'), scope: val('se-scope'), scopeId: val('se-scope-id'), products: val('se-products'), listFrom: val('se-from'), listTo: val('se-to'), reason: val('se-reason') });
  if (out.kind === 'done') { say('se-status', `${w('seasonMade')} ${out.body.plan.storeIds.join(', ')}`, true); await refreshSeasons(); } else sayOutcome('se-status', out);
});
$('se-sweep').addEventListener('click', async () => {
  const out = await session.sweepSeasons();
  if (out.kind === 'done') { say('se-status', `${w('swept')} ${out.body.count}`, true); await refreshSeasons(); } else sayOutcome('se-status', out);
});

// ── Shelf layout (Round D: shelf map, planogram, floor plan) ───────────────────────────────────────────────────

const held = { map: undefined, plans: undefined, floor: undefined };
function drawMeta() {
  const m = held.map;
  $('sm-meta').textContent = m === undefined ? '' : m === null ? w('noShelfMapYet') : `${w('version')} ${m.version} · ${w('by')} ${m.publishedBy} · ${m.publishedAt}`;
  const p = held.plans;
  const inForce = p?.inForce ?? null;
  $('pg-meta').textContent = p === undefined ? '' : p.plans.length === 0 ? w('noPlanogramYet')
    : [inForce === null ? '' : `${w('inForce')}: ${inForce.planogramId} · ${w('version')} ${inForce.version} · ${inForce.effectiveFrom}`,
      p.staleAgainstShelfMap.length === 0 ? '' : `⚠ ${w('staleAgainstMap')} ${p.staleAgainstShelfMap.join(', ')}`].filter((s) => s !== '').join(' — ');
  const f = held.floor;
  $('fp-meta').textContent = f === undefined ? '' : f === null ? w('noFloorPlanYet') : `${w('version')} ${f.version} · ${f.widthFt} × ${f.depthFt} ft · ${w('by')} ${f.publishedBy}`;
}
$('ly-load').addEventListener('click', async () => {
  const store = val('ly-store');
  const problems = [];
  if (may.planRead) {
    const [m, p] = await Promise.all([session.shelfMap(store), session.planograms(store)]);
    if (m.kind === 'done') { held.map = m.body; lines.sm = kit.shelfRowsOf(m.body).map((r) => ({ ...r })); } else problems.push(kit.outcomeWords(lang, m, 'read'));
    if (p.kind === 'done') {
      held.plans = p.body;
      const plan = p.body.inForce ?? p.body.plans[0] ?? null;
      lines.pg = kit.planRowsOf(plan).map((r) => ({ ...r }));
      if (plan !== null) $('pg-id').value = plan.planogramId;
    } else problems.push(kit.outcomeWords(lang, p, 'read'));
  }
  if (may.spaceRead) {
    const f = await session.floorPlan(store);
    if (f.kind === 'done') {
      held.floor = f.body;
      lines.fp = kit.areaRowsOf(f.body).map((r) => ({ ...r }));
      if (f.body !== null) { $('fp-width').value = String(f.body.widthFt); $('fp-depth').value = String(f.body.depthFt); }
    } else problems.push(kit.outcomeWords(lang, f, 'read'));
  }
  if (problems.length === 0) say('ly-status', ''); else say('ly-status', [...new Set(problems)].join(' '), false);
  for (const which of ['sm', 'pg', 'fp']) { if (lines[which].length === 0) lines[which].push(blank(COLS[which])); drawGrid(which); }
  drawMeta();
});
for (const which of ['sm', 'pg', 'fp']) $(`${which}-add`).addEventListener('click', () => { lines[which].push(blank(COLS[which])); drawGrid(which); });
$('sm-publish').addEventListener('click', async () => {
  const out = await session.publishShelfMap(val('ly-store'), lines.sm);
  if (out.kind === 'done') { held.map = out.body.shelfMap; say('sm-status', `${w('shelfMapPublished')} ${out.body.shelfMap.version}`, true); drawMeta(); } else sayOutcome('sm-status', out);
});
$('pg-publish').addEventListener('click', async () => {
  const out = await session.publishPlanogram(val('ly-store'), val('pg-id'), val('pg-from'), lines.pg);
  if (out.kind === 'done') say('pg-status', `${w('planogramPublished')} ${out.body.planogram.version}`, true); else sayOutcome('pg-status', out);
});
$('fp-publish').addEventListener('click', async () => {
  const out = await session.publishFloorPlan(val('ly-store'), val('fp-width'), val('fp-depth'), lines.fp);
  if (out.kind === 'done') { held.floor = out.body.plan; say('fp-status', `${w('floorPlanPublished')} ${out.body.plan.version}`, true); drawMeta(); } else sayOutcome('fp-status', out);
});

// ── Boot ──────────────────────────────────────────────────────────────────────────────────────────────────────

// The shop's own trading day and store, as the store computer told the page — the forms start from them.
for (const id of ['ct-starts', 'cl-from', 'sr-date', 'se-from', 'pg-from']) $(id).value = api?.today ?? '';
for (const id of ['ct-store', 'sr-store', 'ly-store']) $(id).value = api?.storeId ?? '';
for (const which of ['sm', 'pg', 'fp']) lines[which].push(blank(COLS[which]));
// merchandising.js switches the page's language first (its listener was added first); this repaints the setup tabs after it.
$('lang').addEventListener('click', () => { lang = document.documentElement.lang === 'ta' ? 'ta' : 'en'; paint(); });
paint();
