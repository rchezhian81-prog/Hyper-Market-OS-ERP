// Plan production and trace a batch (W4 · M11-FR-01 · M11-FR-03) — two sections of the Production page. The session
// (apps/web-erp/src/production-plan-session.ts, in the bundle as window.productionPlan) does every call and every rule;
// this draws what head office answered. The plan is ADVICE: its one button only copies a recipe and a batch count into
// the run form below — a person still records the run. Nothing is read on open and nothing is written from here. Every
// word has a Tamil twin; head office's own sentences stay English.

const $ = (id) => document.getElementById(id);
// U5 · G17: the chrome's shared parts (window.sreOffice) may load after this page — each part is drawn once it is there,
// and the page keeps its words meanwhile. States are the chrome's chips and state boxes, never a ✓/⚠ character.
const sreO = () => window.sreOffice ?? null;
/** A state as the chrome's chip (the tone's shape and the words) — never a ✓/⚠ character; the words alone until the chrome is there. */
function fillStatus(holder, tone, label) { const o = sreO(); holder.replaceChildren(o ? o.chip(tone, label) : label); }
/** A line that begins with a state chip and goes on in words: "[Done] Wave given to the picker …". */
function withChip(node, state) { const o = sreO(); if (o) node.prepend(o.recordChip(state), ' '); return node; }
const api = window.productionPlan ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, trace: false };
const lang = () => (document.documentElement.lang === 'ta' ? 'ta' : 'en');
const t = (k) => (api === null ? k : api.words(lang(), k));
const amount = (q, uom) => (api === null ? `${q} ${uom}` : api.amount(lang(), q, uom));
function el(tag, text, cls) { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; }

let plan = null; let planOut = null;
let trace = null; // { kind: 'inputs' | 'forward', value } | { kind: 'said', out }

// U3 · OB-699 (and U2b · G14): the plan's day is the chrome's shared date field — dd/mm/yyyy as the shop writes it, ISO
// sent — and its label and hint follow the language toggle. Until the chrome is there the plain box stays (ISO typed).
function planDayField() {
  const office = window.sreOffice; const input = $('plan-day');
  if (!office || typeof office.dateField !== 'function' || !input || api === null) return;
  const words = { en: api.words('en', 'forDay'), ta: api.words('ta', 'forDay') };
  if (input.closest('.sre-date')) {
    const l = lang(); const wrap = input.closest('.sre-field');
    const lab = wrap.querySelector('.sre-field-label'); if (lab && lab.firstChild) lab.firstChild.textContent = words[l];
    const hint = wrap.querySelector('.sre-field-hint'); if (hint && typeof office.words === 'function') hint.textContent = office.words('dateHint');
    return;
  }
  const typed = input.value.trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(typed) ? typed : (typeof office.parseShopDate === 'function' ? office.parseShopDate(typed) : null);
  const field = office.dateField({ id: 'plan-day', label: words, required: false, ...(iso ? { value: iso } : {}) });
  (input.closest('div') ?? input).replaceWith(field);
}
const dayOf = (id) => { const f = $(id); const office = window.sreOffice; return f && f.closest('.sre-date') && office && typeof office.dateValue === 'function' ? (office.dateValue(id) ?? '') : (f?.value ?? ''); };

function paintWords() {
  planDayField();
  for (const [id, key] of [['plan-h', 'planH'], ['plan-lead', 'planLead'], ['plan-location-label', 'location'], ['plan-day-label', 'forDay'], ['plan-go-text', 'showPlan'],
    ['trace-h', 'traceH'], ['trace-lead', 'traceLead'], ['trace-batch-label', 'batch'], ['trace-inputs-text', 'showInputs'], ['trace-forward-text', 'traceForward']]) if ($(id)) $(id).textContent = t(key);
}

function planLine(l) {
  const li = el('li', undefined, `row tone-${l.state === 'proposed' ? 'ok' : l.state === 'nothing_needed' ? 'idle' : 'degraded'}`);
  li.dataset.recipe = l.recipeId; li.dataset.state = l.state;
  const head = el('div', undefined, 'head');
  const status = el('span', '', 'status');
  fillStatus(status, l.state === 'proposed' ? 'ok' : l.state === 'nothing_needed' ? 'idle' : 'degraded', api.stateWords(lang(), l.state));
  head.append(el('span', `${l.recipeId} — ${l.outputProductId}`, 'headline'), status);
  li.append(head);
  const facts = el('div', undefined, 'facts');
  facts.append(
    el('span', `${t('colBatches')}: ${l.proposedBatches}`, 'batches'),
    el('span', `${t('colMakes')}: ${amount(l.proposedOutputMinor, l.outputUom)}`),
    el('span', `${t('colDemand')}: ${amount(l.demandMinor, l.outputUom)} (${l.windowFrom} ${t('to')} ${l.windowTo})`),
    el('span', `${t('colOnHand')}: ${amount(l.onHandUsableMinor, l.outputUom)}`),
  );
  if (l.unmetMinor > 0) facts.append(el('span', `${amount(l.unmetMinor, l.outputUom)} ${t('unmet')}`, 'warnc'));
  if (l.oneMoreBatchUnsoldMinor > 0) facts.append(el('span', `${t('oneMore')}: ${amount(l.oneMoreBatchUnsoldMinor, l.outputUom)}`));
  li.append(facts);
  if ($('runner') !== null) {
    const b = el('button', t('useInForm'), 'act hold'); b.type = 'button'; b.dataset.useRecipe = l.recipeId;
    b.addEventListener('click', () => {
      if ($('run-recipe')) $('run-recipe').value = l.recipeId;
      if ($('run-batches') && l.proposedBatches > 0) $('run-batches').value = String(l.proposedBatches);
      if ($('run-location') && $('run-location').value.trim() === '') $('run-location').value = plan?.locationId ?? '';
      $('plan-status').textContent = t('putInForm');
      $('run-recipe')?.focus();
    });
    li.append(b);
  }
  return li;
}

function paintPlan() {
  if (plan === null) { $('plan-rows').replaceChildren(); $('plan-not-operated').hidden = true; if (planOut !== null) $('plan-status').textContent = api.outcomeWords(lang(), planOut); return; }
  $('plan-status').textContent = `${t('planFor')} ${plan.forDay} · ${t('historyFrom')} ${plan.historyFrom} ${t('to')} ${plan.historyTo}${plan.lines.length === 0 ? ` — ${t('noLines')}` : ''}`;
  $('plan-rows').replaceChildren(...plan.lines.map(planLine));
  $('plan-not-operated').hidden = plan.notOperated.length === 0;
  $('plan-not-operated').textContent = `${t('notOperated')} ${plan.notOperated.map((n) => `${n.recipeId} (${n.departmentId})`).join(', ')}`;
}

function inputsRows(v) {
  return v.runs.map((r) => {
    const li = el('li', undefined, `row tone-${r.inputsRecorded ? 'idle' : 'degraded'}`); li.dataset.run = r.runId;
    li.append(el('div', `${t('inputsOf')} ${v.outputBatchId} (${r.outputProductId})`, 'headline'));
    if (!r.inputsRecorded) { li.append(withChip(el('p', t('inputsNotRecorded'), 'exc'), 'warning')); return li; }
    if (r.inputBatches.length === 0) { li.append(el('p', t('noInputs'), 'note')); return li; }
    const ul = el('ul', undefined, 'inputs');
    for (const i of r.inputBatches) {
      const row = el('li', `${i.productId} — ${i.batchId ?? t('batchNotKnown')} — ${amount(i.quantityMinor, i.uom)} (${t(`src_${i.source}`)})`);
      row.dataset.inputBatch = i.batchId ?? ''; ul.append(row);
    }
    li.append(ul);
    return li;
  });
}
function forwardRows(v) {
  const rows = v.outputs.map((o) => {
    const li = el('li', undefined, 'row tone-idle'); li.dataset.outputBatch = o.outputBatchId;
    li.append(el('div', `${v.batchId} ${t('went')} ${o.outputBatchId} (${o.outputProductId}) · ${api.moment(o.at)}`, 'headline'));
    const facts = el('div', undefined, 'facts');
    for (const u of o.inputUsed) facts.append(el('span', `${u.productId}: ${amount(u.quantityMinor, u.uom)}`));
    facts.append(el('span', `${t('colMakes')}: ${o.outputQuantityMinor}`), el('span', `${t('sold')}: ${o.soldCount}`, 'sold'));
    li.append(facts);
    return li;
  });
  if (v.outputs.length === 0) rows.push(el('li', t('none'), 'row tone-idle'));
  if (v.runsWithoutRecordedInputs > 0) rows.push(withChip(el('li', `${v.runsWithoutRecordedInputs} ${t('withoutInputs')}`, 'row tone-degraded'), 'warning'));
  return rows;
}
function paintTrace() {
  if (trace === null) { $('trace-rows').replaceChildren(); return; }
  if (trace.kind === 'said') { $('trace-rows').replaceChildren(); $('trace-status').textContent = api.outcomeWords(lang(), trace.out); return; }
  $('trace-status').textContent = '';
  $('trace-rows').replaceChildren(...(trace.kind === 'inputs' ? inputsRows(trace.value) : forwardRows(trace.value)));
}

function build() {
  if (session === null) return;
  paintWords();
  if (!may.read) return;
  $('planner').hidden = false; $('tracer').hidden = false;
  $('trace-forward').hidden = !may.trace;
  if ($('plan-location').value === '' && typeof api.locationId === 'string') $('plan-location').value = api.locationId;
  paintPlan(); paintTrace();
}

$('plan-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  $('plan-status').textContent = t('reading');
  const out = await session.plan({ locationId: $('plan-location').value, forDay: dayOf('plan-day') });
  if (out.result === 'ok') { plan = out.value; planOut = null; } else { plan = null; planOut = out; }
  paintPlan();
});
async function runTrace(kind) {
  $('trace-status').textContent = t('reading');
  const id = $('trace-batch').value;
  const out = kind === 'inputs' ? await session.inputsOf(id) : await session.traceForward(id);
  trace = out.result === 'ok' ? { kind, value: out.value } : { kind: 'said', out };
  paintTrace();
}
$('trace-form')?.addEventListener('submit', (e) => { e.preventDefault(); void runTrace('inputs'); });
$('trace-forward')?.addEventListener('click', () => { void runTrace('forward'); });
document.addEventListener('sre:chrome', build);
new MutationObserver(build).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
build();
