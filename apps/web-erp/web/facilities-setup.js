// Facilities set-up (Round 4d · M26-FR-01/02/03 · D-6) — the store manager's page for the machines, spare parts, cold rooms,
// schedules and food-safety checks the Facilities and Food-safety checks pages work from. The session
// (apps/web-erp/src/facilities-setup-session.ts, in the bundle as window.facilitiesSetup) does every call and every rule;
// this page lays out what it is told in the shared office parts (window.sreOffice: summary cards, registers with a record
// drawer, form fields, states). It reads as it opens; every change is an explicit press. Every word has a Tamil twin.

const $ = (id) => document.getElementById(id);
const api = window.facilitiesSetup ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, store: false, readAssets: false, manageAssets: false, readSchedules: false, manageSchedules: false, raiseTasks: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
const both = (k) => ({ en: api === null ? k : api.words('en', k), ta: api === null ? k : api.words('ta', k) });
const office = () => window.sreOffice ?? null;
function el(tag, text, cls) { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; }
const say = (id, out, good) => { $(id).textContent = out.result === 'ok' ? good : api.outcomeWords(lang, out); };
const today = () => api.today();

let data = null; // the last read: { assets, rooms, spares, schedules, checks }, each an outcome
const registers = {};
const TABS = ['assets', 'spares', 'rooms', 'schedules', 'checks'];
let shown = 'assets';
/** The record each form is changing (null: a new one). */
const editing = { asset: null, spare: null, schedule: null, check: null };

const ok = (part) => (data !== null && data[part].result === 'ok' ? data[part].value : null);
const assetsList = () => ok('assets') ?? [];
const assetName = (id) => assetsList().find((a) => a.assetId === id)?.name ?? id;
const yesNo = (b) => both(b ? 'yes' : 'no');
const opt = (values, prefix) => values.map((v) => ({ value: v, label: both(`${prefix}${v}`) }));

// ── forms: built from a spec with the shared field; a language switch rebuilds them and keeps what was typed ──────────
const FORMS = {
  'asset-form': () => [
    { id: 'a-name', label: 'assetName', required: true }, { id: 'a-kind', label: 'assetKind', type: 'select', options: opt(api.assetKinds, 'k_') },
    { id: 'a-criticality', label: 'criticality', type: 'select', options: opt(api.criticalities, 'c_') }, { id: 'a-installed', label: 'installedOn', type: 'date', required: true },
    { id: 'a-warranty', label: 'warrantyUntil', type: 'date' }, { id: 'a-amc', label: 'amcUntil', type: 'date' }, { id: 'a-vendor', label: 'amcVendor' },
    { id: 'a-every', label: 'serviceEveryDays', inputmode: 'numeric' }, { id: 'a-protects', label: 'protectsValue', inputmode: 'decimal' }, { id: 'a-active', label: 'active', type: 'checkbox' },
    { button: 'a-save', label: 'saveAsset' },
  ],
  'spare-form': () => [
    { id: 'p-name', label: 'spareName', required: true }, { id: 'p-unit', label: 'unit', value: 'each' }, { id: 'p-minimum', label: 'minimumLevel', inputmode: 'numeric', required: true, value: '0' },
    { id: 'p-active', label: 'active', type: 'checkbox' }, { fits: 'p-fits' }, { button: 'p-save', label: 'saveSpare' },
  ],
  'room-form': () => [
    { id: 'r-asset', label: 'roomAsset', type: 'select', options: assetsList().map((a) => ({ value: a.assetId, label: a.name })) }, { id: 'r-name', label: 'roomName', required: true },
    { id: 'r-min', label: 'minC', required: true, inputmode: 'decimal' }, { id: 'r-max', label: 'maxC', required: true, inputmode: 'decimal' },
    { id: 'r-grace', label: 'graceMinutes', required: true, inputmode: 'numeric', value: '15' }, { id: 'r-every', label: 'expectEvery', inputmode: 'numeric' }, { id: 'r-backup', label: 'onBackup', type: 'checkbox' },
    { button: 'r-save', label: 'saveRoom' },
  ],
  'schedule-form': () => [
    { id: 's-title', label: 'scheduleTitle', required: true }, { id: 's-category', label: 'category', type: 'select', options: opt(api.categories, 'cat_') },
    { id: 's-frequency', label: 'frequency', type: 'select', options: opt(api.frequencies, 'f_') }, { id: 's-role', label: 'assignedRole', required: true, value: 'store_manager' },
    { id: 's-escalates', label: 'escalatesTo', required: true }, { id: 's-after', label: 'escalateAfterDays', inputmode: 'numeric' },
    { id: 's-asset', label: 'scheduleAsset', type: 'select', options: [{ value: '', label: both('none') }, ...assetsList().map((a) => ({ value: a.assetId, label: a.name }))] },
    { id: 's-evidence', label: 'evidenceRequired', type: 'checkbox' }, { id: 's-verify', label: 'verificationRequired', type: 'checkbox' }, { id: 's-active', label: 'active', type: 'checkbox' },
    { button: 's-save', label: 'saveSchedule' },
  ],
  'check-form': () => [
    { id: 'c-title', label: 'checkTitle', required: true }, { id: 'c-kind', label: 'checkKind', type: 'select', options: opt(api.checkKinds, 'ck_') },
    { id: 'c-every', label: 'everyMinutes', inputmode: 'numeric', value: '240' }, { id: 'c-starts', label: 'startsAt', type: 'datetime-local' },
    { id: 'c-grace', label: 'checkGrace', required: true, inputmode: 'numeric', value: '30' }, { id: 'c-min', label: 'minC', inputmode: 'decimal' }, { id: 'c-max', label: 'maxC', inputmode: 'decimal' },
    { id: 'c-equipment', label: 'equipment', type: 'select', options: [{ value: '', label: both('none') }, ...(ok('rooms') ?? []).map((r) => ({ value: r.assetId, label: r.name }))] },
    { id: 'c-role', label: 'assignedRole', required: true, value: 'store_manager' }, { id: 'c-escalates', label: 'escalatesTo', required: true },
    { id: 'c-items', label: 'items', type: 'textarea' }, { id: 'c-active', label: 'active', type: 'checkbox' }, { button: 'c-save', label: 'saveCheck' },
  ],
};
const CHECKED_BY_DEFAULT = new Set(['a-active', 'p-active', 's-active', 'c-active']);

function buildForm(formId) {
  const o = office(); if (o === null || api === null) return;
  const form = $(formId);
  const kept = new Map([...form.querySelectorAll('input, select, textarea')].map((i) => [i.id, i.type === 'checkbox' ? i.checked : i.value]));
  form.replaceChildren();
  for (const f of FORMS[formId]()) {
    if (f.button) { const b = el('button', t(f.label)); b.type = 'submit'; b.id = f.button; form.append(b); continue; }
    if (f.fits) {
      const fs = el('fieldset', undefined, 'fits'); fs.id = f.fits; fs.append(el('legend', t('fits')));
      for (const a of assetsList()) { const l = el('label'); const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = a.assetId; cb.id = `fit-${a.assetId}`; cb.checked = kept.get(cb.id) === true; l.append(cb, document.createTextNode(a.name)); fs.append(l); }
      form.append(fs); continue;
    }
    const field = o.field({ id: f.id, label: both(f.label), type: f.type ?? 'text', required: f.required === true, options: f.options, value: f.value, inputmode: f.inputmode });
    form.append(field);
    const input = $(f.id);
    if (f.type === 'checkbox') input.checked = kept.has(f.id) ? kept.get(f.id) : CHECKED_BY_DEFAULT.has(f.id);
    // a choice is kept only while it is still offered (a list read again may now hold what was not there before)
    else if (kept.has(f.id) && (f.type !== 'select' || [...input.options].some((o) => o.value === kept.get(f.id) && o.value !== ''))) input.value = kept.get(f.id);
  }
}
const v = (id) => $(id)?.value ?? '';
const on = (id) => $(id)?.checked === true;
const set = (id, value) => { const i = $(id); if (!i) return; if (i.type === 'checkbox') i.checked = value === true; else i.value = value ?? ''; };

// ── the summary cards ────────────────────────────────────────────────────────────────────────────────────────────────
function paintCards() {
  const o = office(); if (o === null) return;
  const assets = ok('assets'); const spares = ok('spares'); const rooms = ok('rooms'); const schedules = ok('schedules'); const checks = ok('checks');
  const lowCount = spares === null ? null : spares.rows.filter((p) => p.low).length;
  o.cards($('cards'), [
    { label: both('cardAssets'), value: assets === null ? null : assets.length },
    { label: both('cardCritical'), value: assets === null ? null : assets.filter((a) => a.criticality === 'critical').length },
    { label: both('cardLow'), value: spares === null || !spares.kept ? null : lowCount, note: spares !== null && !spares.kept ? both('noteNotKept') : both('noteLow'), tone: lowCount ? 'pending' : undefined },
    { label: both('cardRooms'), value: rooms === null ? null : rooms.length },
    { label: both('cardSchedules'), value: schedules === null ? null : schedules.length },
    { label: both('cardChecks'), value: checks === null ? null : checks.filter((c) => c.active).length },
  ]);
}

// ── the registers ────────────────────────────────────────────────────────────────────────────────────────────────────
function register(part, opts) {
  const o = office(); if (o === null) return;
  const host = $(`${part}-register`);
  if (registers[part] === undefined || !host.contains($(`${part}-table`))) registers[part] = o.table(host, { id: part, pageSize: 10, rows: null, ...opts });
  const r = registers[part];
  const out = data === null ? null : data[part];
  if (out === null) r.setRows(null);
  else if (out.result === 'ok') r.setRows(part === 'spares' ? out.value.rows : out.value);
  else if (out.result === 'invalid') r.setState('denied', { detail: api.outcomeWords(lang, out) });
  else r.setState(o.stateOf(out), { detail: api.outcomeWords(lang, out) });
}

function drawerActions(box, ...buttons) { const acts = el('div'); acts.style.display = 'flex'; acts.style.gap = '8px'; acts.style.flexWrap = 'wrap'; acts.append(...buttons); box.append(acts); }
function editButton(onClick) { const b = el('button', t('editThis'), 'quiet'); b.type = 'button'; b.id = 'edit-this'; b.addEventListener('click', () => { office().closeDrawer(); onClick(); }); return b; }

function assetDrawer(a) {
  const o = office(); const box = el('div');
  box.append(o.facts([
    [both('colKind'), t(`k_${a.kind}`)], [both('colCriticality'), t(`c_${a.criticality}`)], [both('installedOn'), a.installedOn], [both('warrantyUntil'), a.warrantyUntil],
    [both('amcUntil'), a.amcUntil], [both('amcVendor'), a.amcVendor], [both('serviceEveryDays'), a.serviceEveryDays === null ? null : String(a.serviceEveryDays)],
    [both('colLastService'), a.lastServicedOn], [both('protectsValue'), a.protectsValueMinor === null ? null : api.rupees(a.protectsValueMinor)], [both('active'), t(a.active ? 'yes' : 'no')],
  ]));
  if (!may.manageAssets) return box;
  drawerActions(box, editButton(() => {
    editing.asset = a.assetId; show('assets');
    for (const [id, value] of [['a-name', a.name], ['a-kind', a.kind], ['a-criticality', a.criticality], ['a-installed', a.installedOn], ['a-warranty', a.warrantyUntil], ['a-amc', a.amcUntil], ['a-vendor', a.amcVendor], ['a-every', a.serviceEveryDays === null ? '' : String(a.serviceEveryDays)], ['a-protects', a.protectsValueMinor === null ? '' : (a.protectsValueMinor / 100).toFixed(2)], ['a-active', a.active]]) set(id, value);
    $('a-name').focus();
  }));
  // log a service, drawing the spare parts it used from the register (M26-FR-01)
  box.append(el('h3', t('serviceH')));
  const form = el('form'); form.noValidate = true; form.id = 'service-form';
  form.append(
    o.field({ id: 'sv-on', label: both('performedOn'), type: 'date', required: true, value: today() }), o.field({ id: 'sv-by', label: both('performedBy'), required: true }),
    o.field({ id: 'sv-kind', label: both('serviceKind'), type: 'select', options: opt(api.serviceKinds, 's_') }), o.field({ id: 'sv-notes', label: both('notes') }),
    o.field({ id: 'sv-cost', label: both('cost'), inputmode: 'decimal' }),
  );
  form.append(el('h4', t('sparesUsedH')));
  const fitting = (ok('spares')?.rows ?? []).filter((p) => p.active && p.compatibleAssetIds.includes(a.assetId));
  if (fitting.length === 0) form.append(el('p', t('noFittingSpares'), 'status'));
  for (const p of fitting) form.append(o.field({ id: `sv-spare-${p.sparePartId}`, label: `${p.name} (${t('colOnHand')}: ${p.onHand} ${p.unit})`, inputmode: 'numeric' }));
  const status = el('p', '', 'status'); status.id = 'service-status'; status.setAttribute('role', 'status');
  const b = el('button', t('logService')); b.type = 'submit'; b.id = 'log-service';
  form.append(b, status);
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); if (!o.check(form)) return;
    status.textContent = t('saving');
    const out = await session.logService(a.assetId, { performedOn: v('sv-on'), performedBy: v('sv-by'), kind: v('sv-kind'), notes: v('sv-notes'), cost: v('sv-cost'), spares: Object.fromEntries(fitting.map((p) => [p.sparePartId, v(`sv-spare-${p.sparePartId}`)])) });
    say('service-status', out, t('serviceLogged'));
    if (out.result === 'ok') void load();
  });
  box.append(form);
  return box;
}

function spareDrawer(p) {
  const o = office(); const box = el('div');
  box.append(o.facts([[both('colOnHand'), `${p.onHand} ${p.unit}`], [both('colMinimum'), String(p.minimumLevel)], [both('colState'), o.chip(p.low ? 'pending' : p.active ? 'ok' : 'idle', t(p.low ? 'low' : p.active ? 'enough' : 'inactive'))], [both('colFits'), p.compatibleAssetIds.map(assetName).join(', ')]]));
  box.append(el('h3', t('movementsH')));
  const ul = el('ul', undefined, 'rows');
  for (const m of p.movements) ul.append(el('li', `${m.on} · ${t(`m_${m.kind}`)} ${m.qty > 0 ? '+' : ''}${m.qty} · ${m.by}${m.serviceId ? ` · ${t('forService')} ${m.serviceId} (${assetName(m.assetId ?? '')})` : ''}${m.reason ? ` · ${m.reason}` : ''}`));
  box.append(ul);
  if (!may.manageAssets) return box;
  drawerActions(box, editButton(() => {
    editing.spare = p.sparePartId; show('spares');
    set('p-name', p.name); set('p-unit', p.unit); set('p-minimum', String(p.minimumLevel)); set('p-active', p.active);
    for (const cb of $('p-fits').querySelectorAll('input')) cb.checked = p.compatibleAssetIds.includes(cb.value);
    $('p-name').focus();
  }));
  const moveForm = (kind) => {
    const f = el('form'); f.noValidate = true; f.id = `${kind}-form`;
    f.append(el('h3', t(kind === 'received' ? 'receivedH' : 'correctionH')),
      o.field({ id: `${kind}-qty`, label: both(kind === 'received' ? 'qty' : 'correctionQty'), required: true, inputmode: kind === 'received' ? 'numeric' : 'text' }),
      o.field({ id: `${kind}-on`, label: both('on'), type: 'date', required: true, value: today() }));
    if (kind === 'correction') f.append(o.field({ id: 'correction-reason', label: both('reason'), required: true }));
    const st = el('p', '', 'status'); st.id = `${kind}-status`; st.setAttribute('role', 'status');
    const b = el('button', t(kind === 'received' ? 'recordReceived' : 'recordCorrection'), kind === 'received' ? '' : 'quiet'); b.type = 'submit'; b.id = `${kind}-save`;
    f.append(b, st);
    f.addEventListener('submit', async (e) => {
      e.preventDefault(); if (!o.check(f)) return;
      st.textContent = t('saving');
      const out = kind === 'received' ? await session.receiveSpare(p.sparePartId, v('received-qty'), v('received-on')) : await session.correctSpare(p.sparePartId, v('correction-qty'), v('correction-on'), v('correction-reason'));
      say(`${kind}-status`, out, t(kind === 'received' ? 'received' : 'corrected'));
      if (out.result === 'ok') void load();
    });
    return f;
  };
  box.append(moveForm('received'), moveForm('correction'));
  return box;
}

function roomDrawer(r) {
  const o = office(); const box = el('div');
  box.append(o.facts([[both('colRange'), `${api.celsius(r.minTenthsC)} … ${api.celsius(r.maxTenthsC)}`], [both('colGrace'), String(r.graceMinutes)], [both('expectEvery'), r.expectEveryMinutes === null ? null : String(r.expectEveryMinutes)], [both('colBackup'), t(r.onBackup ? 'yes' : 'no')]]));
  if (may.manageAssets) drawerActions(box, editButton(() => {
    show('rooms');
    for (const [id, value] of [['r-asset', r.assetId], ['r-name', r.name], ['r-min', api.celsius(r.minTenthsC)], ['r-max', api.celsius(r.maxTenthsC)], ['r-grace', String(r.graceMinutes)], ['r-every', r.expectEveryMinutes === null ? '' : String(r.expectEveryMinutes)], ['r-backup', r.onBackup]]) set(id, value);
    $('r-min').focus();
  }));
  return box;
}

function scheduleDrawer(s) {
  const o = office(); const box = el('div');
  box.append(o.facts([
    [both('colCategory'), t(`cat_${s.category}`)], [both('colFrequency'), t(`f_${s.frequency}`)], [both('assignedRole'), s.assignedRole], [both('escalatesTo'), s.escalatesTo],
    [both('evidenceRequired'), t(s.evidenceRequired ? 'yes' : 'no')], [both('verificationRequired'), t(s.verificationRequired ? 'yes' : 'no')],
    [both('scheduleAsset'), s.assetId === null ? t('none') : assetName(s.assetId)], [both('colLastDue'), s.lastDueOn], [both('colOpen'), String(s.open)], [both('active'), t(s.active ? 'yes' : 'no')],
  ]));
  const buttons = [];
  if (may.manageSchedules) buttons.push(editButton(() => {
    editing.schedule = s.scheduleId; show('schedules');
    for (const [id, value] of [['s-title', s.title], ['s-category', s.category], ['s-frequency', s.frequency], ['s-role', s.assignedRole], ['s-escalates', s.escalatesTo], ['s-after', s.escalateAfterDays === null ? '' : String(s.escalateAfterDays)], ['s-asset', s.assetId ?? ''], ['s-evidence', s.evidenceRequired], ['s-verify', s.verificationRequired], ['s-active', s.active]]) set(id, value);
    $('s-title').focus();
  }));
  if (buttons.length > 0) drawerActions(box, ...buttons);
  if (may.raiseTasks && s.active) {
    const f = el('form'); f.noValidate = true; f.id = 'raise-form';
    const st = el('p', '', 'status'); st.id = 'raise-status'; st.setAttribute('role', 'status');
    const b = el('button', t('raise')); b.type = 'submit'; b.id = 'raise-task';
    f.append(el('h3', t('raiseH')), o.field({ id: 'raise-due', label: both('dueOn'), type: 'date', required: true, value: today() }), b, st);
    f.addEventListener('submit', async (e) => {
      e.preventDefault(); if (!o.check(f)) return;
      st.textContent = t('saving');
      const out = await session.raiseTask(s.scheduleId, v('raise-due'));
      say('raise-status', out, t('raised'));
      if (out.result === 'ok') void load();
    });
    box.append(f);
  }
  return box;
}

const everyWords = (c) => (c.everyMinutes === null ? t('perDelivery') : `${c.everyMinutes} ${t('minutesShort')}`);
function checkDrawer(c) {
  const o = office(); const box = el('div');
  box.append(o.facts([
    [both('checkKind'), t(`ck_${c.kind}`)], [both('colEvery'), everyWords(c)], [both('startsAt'), c.startsAt === null ? null : api.moment(c.startsAt)], [both('checkGrace'), String(c.graceMinutes)],
    [both('colLimits'), c.minTenthsC === null ? null : `${api.celsius(c.minTenthsC)} … ${api.celsius(c.maxTenthsC)}`], [both('colItems'), c.items.map((i) => i.label).join('; ')],
    [both('equipment'), c.equipmentId === null ? t('none') : assetName(c.equipmentId)], [both('assignedRole'), c.assignedRole], [both('escalatesTo'), c.escalatesTo], [both('active'), t(c.active ? 'yes' : 'no')],
  ]));
  if (may.manageSchedules) drawerActions(box, editButton(() => {
    editing.check = c.checkId; show('checks');
    const local = c.startsAt === null ? '' : new Date(Date.parse(c.startsAt) - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    for (const [id, value] of [['c-title', c.title], ['c-kind', c.kind], ['c-every', c.everyMinutes === null ? '' : String(c.everyMinutes)], ['c-starts', local], ['c-grace', String(c.graceMinutes)], ['c-min', api.celsius(c.minTenthsC)], ['c-max', api.celsius(c.maxTenthsC)], ['c-equipment', c.equipmentId ?? ''], ['c-role', c.assignedRole], ['c-escalates', c.escalatesTo], ['c-items', c.items.map((i) => i.label).join('\n')], ['c-active', c.active]]) set(id, value);
    $('c-title').focus();
  }));
  return box;
}

function paintRegisters() {
  const o = office(); if (o === null || api === null) return;
  register('assets', {
    label: both('assetRegister'), bodyId: 'asset-rows', rowKey: (a) => a.assetId,
    empty: { title: both('emptyAssets'), detail: both('emptyAssetsDetail') },
    columns: [
      { key: 'name', label: both('colName'), sort: 'text' }, { key: 'kind', label: both('colKind'), filter: true, value: (a) => both(`k_${a.kind}`) },
      { key: 'criticality', label: both('colCriticality'), filter: true, value: (a) => both(`c_${a.criticality}`), render: (a) => o.chip(a.criticality === 'critical' ? 'degraded' : 'idle', t(`c_${a.criticality}`)) },
      { key: 'amcUntil', label: both('colAmc'), sort: 'text' }, { key: 'lastServicedOn', label: both('colLastService'), sort: 'text' },
    ],
    drawer: { title: (a) => a.name, body: assetDrawer },
  });
  register('spares', {
    label: both('spareRegister'), bodyId: 'spare-rows', rowKey: (p) => p.sparePartId, rowData: (p) => ({ low: String(p.low) }),
    empty: { title: both('emptySpares'), detail: both('emptySparesDetail') },
    columns: [
      { key: 'name', label: both('spareName'), sort: 'text' }, { key: 'onHand', label: both('colOnHand'), sort: 'number', align: 'end', value: (p) => `${p.onHand} ${p.unit}` },
      { key: 'minimumLevel', label: both('colMinimum'), sort: 'number', align: 'end', value: (p) => String(p.minimumLevel) },
      { key: 'state', label: both('colState'), filter: true, value: (p) => both(p.low ? 'low' : p.active ? 'enough' : 'inactive'), render: (p) => o.chip(p.low ? 'pending' : p.active ? 'ok' : 'idle', t(p.low ? 'low' : p.active ? 'enough' : 'inactive')) },
      { key: 'fits', label: both('colFits'), value: (p) => p.compatibleAssetIds.map(assetName).join(', ') },
    ],
    drawer: { title: (p) => p.name, body: spareDrawer },
  });
  register('rooms', {
    label: both('roomRegister'), bodyId: 'room-rows', rowKey: (r) => r.assetId,
    empty: { title: both('emptyRooms'), detail: both('emptyRoomsDetail') },
    columns: [
      { key: 'name', label: both('colName'), sort: 'text' }, { key: 'range', label: both('colRange'), value: (r) => `${api.celsius(r.minTenthsC)} … ${api.celsius(r.maxTenthsC)}` },
      { key: 'graceMinutes', label: both('colGrace'), sort: 'number', align: 'end', value: (r) => String(r.graceMinutes) }, { key: 'onBackup', label: both('colBackup'), value: (r) => yesNo(r.onBackup) },
    ],
    drawer: { title: (r) => r.name, body: roomDrawer },
  });
  register('schedules', {
    label: both('scheduleRegister'), bodyId: 'schedule-rows', rowKey: (s) => s.scheduleId,
    empty: { title: both('emptySchedules'), detail: both('emptySchedulesDetail') },
    columns: [
      { key: 'title', label: both('colTitle'), sort: 'text' }, { key: 'category', label: both('colCategory'), filter: true, value: (s) => both(`cat_${s.category}`) },
      { key: 'frequency', label: both('colFrequency'), value: (s) => both(`f_${s.frequency}`) }, { key: 'lastDueOn', label: both('colLastDue'), sort: 'text' },
      { key: 'open', label: both('colOpen'), sort: 'number', align: 'end', value: (s) => String(s.open) },
    ],
    drawer: { title: (s) => s.title, body: scheduleDrawer },
  });
  register('checks', {
    label: both('checkRegister'), bodyId: 'check-rows', rowKey: (c) => c.checkId,
    empty: { title: both('emptyChecks'), detail: both('emptyChecksDetail') },
    columns: [
      { key: 'title', label: both('colTitle'), sort: 'text' }, { key: 'kind', label: both('checkKind'), filter: true, value: (c) => both(`ck_${c.kind}`) },
      { key: 'every', label: both('colEvery'), value: everyWords }, { key: 'limits', label: both('colLimits'), value: (c) => (c.minTenthsC === null ? '' : `${api.celsius(c.minTenthsC)} … ${api.celsius(c.maxTenthsC)}`) },
      { key: 'active', label: both('active'), filter: true, value: (c) => yesNo(c.active) },
    ],
    drawer: { title: (c) => c.title, body: checkDrawer },
  });
}

function paintForms() {
  for (const [formId, mayKey, part] of [['asset-form', 'manageAssets', 'assets'], ['spare-form', 'manageAssets', 'spares'], ['room-form', 'manageAssets', 'rooms'], ['schedule-form', 'manageSchedules', 'schedules'], ['check-form', 'manageSchedules', 'checks']]) {
    const allowed = may[mayKey];
    $(formId).hidden = !allowed; $(`${formId}-h`).hidden = !allowed;
    if (allowed && (data === null || data[part].result === 'ok')) buildForm(formId);
  }
}

function paintWords() {
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  document.title = `SRE ${t('title')}`;
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  for (const [id, key] of [['tab-assets', 'tabAssets'], ['tab-spares', 'tabSpares'], ['tab-rooms', 'tabRooms'], ['tab-schedules', 'tabSchedules'], ['tab-checks', 'tabChecks'],
    ['assets-h', 'assetsH'], ['asset-form-h', 'assetFormH'], ['spares-h', 'sparesH'], ['spare-form-h', 'spareFormH'], ['rooms-h', 'roomsH'], ['room-form-h', 'roomFormH'],
    ['schedules-h', 'schedulesH'], ['schedule-form-h', 'scheduleFormH'], ['checks-h', 'checksH'], ['check-form-h', 'checkFormH']]) $(id).textContent = t(key);
}
function paintAll() { paintCards(); paintRegisters(); paintForms(); }

function show(name) {
  shown = name;
  for (const tab of TABS) { $(`view-${tab}`).hidden = tab !== name; $(`tab-${tab}`).setAttribute('aria-current', tab === name ? 'page' : 'false'); }
}

async function load() {
  $('page-status').textContent = t('reading');
  data = await session.read();
  const parts = Object.values(data);
  $('page-status').textContent = parts.every((p) => p.result === 'ok') ? '' : (parts.find((p) => p.result !== 'ok' && p.result !== 'invalid') ? api.outcomeWords(lang, parts.find((p) => p.result !== 'ok' && p.result !== 'invalid')) : '');
  paintAll();
}

async function submit(formId, statusId, work, good, editKey) {
  const o = office(); if (o !== null && !o.check($(formId))) return;
  $(statusId).textContent = t('saving');
  const out = await work();
  say(statusId, out, typeof good === 'function' ? good(out) : t(good));
  if (out.result === 'ok') { if (editKey) editing[editKey] = null; $(formId).replaceChildren(); await load(); }
}
$('asset-form').addEventListener('submit', (e) => { e.preventDefault(); void submit('asset-form', 'asset-status', () => session.saveAsset({ ...(editing.asset ? { assetId: editing.asset } : {}), name: v('a-name'), kind: v('a-kind'), criticality: v('a-criticality'), installedOn: v('a-installed'), warrantyUntil: v('a-warranty'), amcUntil: v('a-amc'), amcVendor: v('a-vendor'), serviceEveryDays: v('a-every'), protectsValue: v('a-protects'), active: on('a-active') }), 'assetSaved', 'asset'); });
$('spare-form').addEventListener('submit', (e) => { e.preventDefault(); void submit('spare-form', 'spare-status', () => session.saveSpare({ ...(editing.spare ? { sparePartId: editing.spare } : {}), name: v('p-name'), unit: v('p-unit'), minimumLevel: v('p-minimum'), active: on('p-active'), compatibleAssetIds: [...$('p-fits').querySelectorAll('input:checked')].map((c) => c.value) }), 'spareSaved', 'spare'); });
$('room-form').addEventListener('submit', (e) => { e.preventDefault(); void submit('room-form', 'room-status', () => session.saveRoom({ assetId: v('r-asset'), name: v('r-name'), minC: v('r-min'), maxC: v('r-max'), graceMinutes: v('r-grace'), expectEvery: v('r-every'), onBackup: on('r-backup') }), 'roomSaved'); });
$('schedule-form').addEventListener('submit', (e) => { e.preventDefault(); void submit('schedule-form', 'schedule-status', () => session.saveSchedule({ ...(editing.schedule ? { scheduleId: editing.schedule } : {}), title: v('s-title'), category: v('s-category'), frequency: v('s-frequency'), assignedRole: v('s-role'), escalatesTo: v('s-escalates'), escalateAfterDays: v('s-after'), assetId: v('s-asset'), evidenceRequired: on('s-evidence'), verificationRequired: on('s-verify'), active: on('s-active') }), 'scheduleSaved', 'schedule'); });
$('check-form').addEventListener('submit', (e) => { e.preventDefault(); void submit('check-form', 'check-status', () => session.saveCheck({ ...(editing.check ? { checkId: editing.check } : {}), title: v('c-title'), kind: v('c-kind'), everyMinutes: v('c-every'), startsAt: v('c-starts'), graceMinutes: v('c-grace'), minC: v('c-min'), maxC: v('c-max'), items: v('c-items'), equipmentId: v('c-equipment'), assignedRole: v('c-role'), escalatesTo: v('c-escalates'), active: on('c-active') }), (out) => t(out.value?.unchanged ? 'checkUnchanged' : 'checkSaved'), 'check'); });
for (const tab of TABS) $(`tab-${tab}`).addEventListener('click', () => show(tab));
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paintWords(); paintAll(); });
document.addEventListener('sre:chrome', () => paintAll());

paintWords();
show(shown);
if (!may.named) $('page-status').textContent = t('nobody');
else if (!may.store) $('page-status').textContent = t('noStore');
else { paintAll(); void load(); }
