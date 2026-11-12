// Dispatch office (M19-FR-01/03/04 · WF-14 · WF-15 · D09-FR-05/06 · OB-294 · OB-300 · OB-313). The session
// (apps/web-erp/src/dispatch-session.ts, in the bundle as window.dispatch) asks head office on a click; this page draws the
// answers: the orders waiting for a wave and the ones held for a manager, each wave's progress, the day's planned routes
// and the ones not on a route (each with its reason), every door's proof (the code's verdict, where the phone was, the
// pictures kept) and the cash, the contribution rule, the owner's numbers ("not set" until he enters them), and the
// own-fleet settlement. Every state is a mark AND words. Every word has a Tamil twin.

// OB-607: a time of day is the SHOP's clock (its zone, as the store computer told the page) — never this device's.
const shopTimeOf = (value) => window.sreShopDay?.timeOf(value) ?? '';
const $ = (id) => document.getElementById(id);
// U5 · G17: the chrome's shared parts (window.sreOffice) may load after this page — each part is drawn once it is there,
// and the page keeps its words meanwhile. States are the chrome's chips and state boxes, never a ✓/⚠ character.
const sreO = () => window.sreOffice ?? null;
/** The chrome's "Not known" in the reader's language — never a dash. */
const notKnownWord = () => { const o = sreO(); return o && typeof o.words === 'function' ? o.words('notKnown') : 'Not known'; };
/** A state as the chrome's chip (the tone's shape and the words) — never a ✓/⚠ character; the words alone until the chrome is there. */
function fillStatus(holder, tone, label) { const o = sreO(); holder.replaceChildren(o ? o.chip(tone, label) : label); }
/** A line that begins with a state chip and goes on in words: "[Done] Wave given to the picker …". */
function withChip(node, state) { const o = sreO(); if (o) node.prepend(o.recordChip(state), ' '); return node; }
/** A status line said with a chip and words: the state's chip first, then the words (in their own span when it has an id). */
function sayWith(holder, state, words, textId) {
  const o = sreO(); const s = document.createElement('span'); if (textId) s.id = textId; s.textContent = words;
  holder.replaceChildren(...(o && state !== null ? [o.recordChip(state), ' '] : []), s);
}
// ── U2b (UI/UX gap audit G5 · G14 · P-07): a thing is PICKED by name through the chrome's picker, never typed as a code,
// and a date is written as the shop writes it (dd/mm/yyyy) through the chrome's shared field. The field keeps the id the
// page sends (the typed code stays possible when the list cannot be read — head office down, no right — so the form is
// never a dead end, P-01 · P-08); the chrome's sheet finds the thing by name, code or barcode and the name is shown beside
// the field. Mounted when the chrome is there (a page that paints first listens for `sre:chrome`); off the box nothing
// changes. The same six-line pattern as the U2 pages (store-tasks, delegation, floor-heat-map).
const u2bWords = Object.freeze({ en: { choose: 'Choose…', pickProduct: 'Which product?', pickPlace: 'Which place in the store?', pickPerson: 'Which person?', pickStore: 'Which store?', pickCustomer: 'Which customer?', pickApproval: 'Which approval?', pickSupplier: 'Which supplier?', yourStore: 'your store' }, ta: { choose: 'தேர்ந்தெடு…', pickProduct: 'எந்தப் பொருள்?', pickPlace: 'கடையில் எந்த இடம்?', pickPerson: 'எந்த நபர்?', pickStore: 'எந்தக் கடை?', pickCustomer: 'எந்த வாடிக்கையாளர்?', pickApproval: 'எந்த அனுமதி?', pickSupplier: 'எந்த விநியோகஸ்தர்?', yourStore: 'உங்கள் கடை' } }); // one line on purpose: a page's own word tables start a line with `en: {`
const u2bTitle = (titleKey) => ({ en: u2bWords.en[titleKey], ta: u2bWords.ta[titleKey] });
/** U5 · G17: the chrome's own picker beside the field (sreOffice.pickable) — the page keeps its titles; the button and the name
 *  it shows follow the language toggle inside the chrome. Mounted once the chrome is there; off the box nothing changes. */
function pickableEl(input, kind, titleKey, extra = {}) {
  if (!input || input.dataset.pickable === 'on') return;
  const o = sreO();
  if (!o || typeof o.pickable !== 'function') { document.addEventListener('sre:chrome', () => pickableEl(input, kind, titleKey, extra), { once: true }); return; }
  o.pickable(input, kind, u2bTitle(titleKey), { ...extra, ...(typeof extra.titleOf === 'function' ? { titleOf: () => u2bTitle(extra.titleOf()) } : {}) });
}
function pickable(inputId, kind, titleKey, extra = {}) { pickableEl(document.getElementById(inputId), kind, titleKey, extra); }
new MutationObserver(() => { if (typeof ownStores !== 'undefined') for (const id of ownStores) ownStore(id); }).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
// ── U2b end
const api = window.dispatch ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, waves: false, dispatch: false, decide: false, setNumbers: false, approveSettlement: false, readPacks: false, sendOrders: false };

let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));

// U2 · G14 (UI/UX gap audit): a date a shop person reads — dd/mm/yyyy in the chrome's shared field (`sreOffice.dateField`),
// while the page goes on sending ISO (`dateOf`). Before the chrome has loaded, or off the box, the field stays as it was.
const wordsIn = (l, k) => (api === null ? k : api.words(l, k)); // the page's own words, for either language (null off the box)
// A date a shop person reads — the chrome's shared dd/mm/yyyy field (sreOffice.shopDate), while the page goes on sending ISO (`dateOf`).
function shopDate(id, words, opts = {}) {
  const o = sreO();
  if (!o || typeof o.shopDate !== 'function') { document.addEventListener('sre:chrome', () => shopDate(id, words, opts), { once: true }); return; }
  o.shopDate(id, words, opts);
}
const dateOf = (id) => { const o = sreO(); return o && typeof o.dateOf === 'function' ? (o.dateOf(id) ?? '') : (document.getElementById(id)?.value ?? ''); };
const store = () => $('store').value;
const runDate = () => dateOf('run-date');

const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
for (const [id, name] of [['show-orders', 'search'], ['show-waves', 'list-checks'], ['build', 'package'], ['plan', 'navigation'], ['off-road', 'rotate-ccw'],
  ['show-board', 'truck'], ['show-held', 'percent'], ['show-controls', 'sliders'], ['show-tolerance', 'wallet'], ['confirm-tolerance', 'check'], ['propose', 'wallet'], ['approve-settle', 'badge-check'], ['paid', 'receipt'], ['show-pack', 'package'], ['dispatch-order', 'truck'], ['show-manifest', 'clipboard-list']]) {
  const i = icon(name); if (i !== null) $(id).prepend(i, ' ');
}

function say(where, out) { $(where).className = 'status err'; $(where).textContent = api.outcomeWords(lang, out); }
function good(where, words) { $(where).className = 'status good'; sayWith($(where), 'done', words); }
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
function button(words, iconName, onClick, cls) {
  const b = document.createElement('button'); b.classList.add('sre-btn'); b.type = 'button'; if (cls) b.className = cls;
  const i = icon(iconName); if (i !== null) b.append(i, ' ');
  b.append(text('span', words)); b.addEventListener('click', onClick); return b;
}
const clock = (iso) => (iso ? shopTimeOf(iso) : notKnownWord());

// ── Waves ────────────────────────────────────────────────────────────────────
function candidateRow(c, selectable) {
  const li = document.createElement('li');
  li.className = `row tone-${c.standing === 'held' || c.standing === 'declined' ? 'error' : selectable ? 'ok' : 'degraded'}`;
  li.dataset.order = c.orderId;
  const slot = c.slot === null ? '' : ` · ${clock(c.slot.startsAt)}–${clock(c.slot.endsAt)}`;
  const words = `${c.orderId} · ${t(c.fulfilment === 'delivery' ? 'deliveryK' : 'pickupK')} · ${c.lineCount} ${t('lines')}${slot}${c.waveId ? ` · ${c.waveId}` : ''} · ${t(`st_${c.standing}`)}`;
  if (selectable) {
    const label = document.createElement('label'); label.className = 'pick';
    const box = document.createElement('input'); box.type = 'checkbox'; box.className = 'choose'; box.value = c.orderId;
    label.append(box, text('span', words)); li.append(label);
  } else li.append(text('strong', words));
  return li;
}
async function showOrders() {
  const out = await session.candidates(store());
  if (out.result !== 'ok') { say('waves-status', out); return; }
  const c = out.value;
  $('candidates').hidden = false;
  $('ready').replaceChildren(...(c.ready.length === 0 ? [withChip(text('li', t('noneReady'), 'row'), 'unknown')] : c.ready.map((x) => candidateRow(x, true))));
  $('held-orders').replaceChildren(...c.held.map((x) => candidateRow(x, false)));
  $('on-wave').replaceChildren(...c.onWave.map((x) => candidateRow(x, false)));
  $('waves-status').className = 'status'; $('waves-status').textContent = '';
}
async function build() {
  const orderIds = [...document.querySelectorAll('#ready input.choose:checked')].map((b) => b.value);
  // U2b: the wave's number is given by the page when the person leaves it empty (the run date and the next number)
  if ($('wave-id').value.trim() === '') $('wave-id').value = mintWaveId();
  const out = await session.buildWave({ waveId: $('wave-id').value, storeId: store(), pickerId: $('picker').value, orderIds });
  if (out.result !== 'ok') { say('waves-status', out); return; }
  const w = out.value;
  const kept = w.refused.length === 0 ? '' : ` · ${t('refusedK')}: ${w.refused.map((r) => `${r.orderId} (${r.detail})`).join('; ')}`;
  await showOrders();
  good('waves-status', `${t('built')} ${w.waveId} · ${w.pickerId} · ${w.lineCount} ${t('lines')}${kept}`);
}
async function showWaves() {
  const out = await session.waves(store());
  if (out.result !== 'ok') { say('waves-status', out); return; }
  $('waves').hidden = false;
  wavesKnown = out.value.waves.length;
  $('waves').replaceChildren(...out.value.waves.map((w) => {
    const li = document.createElement('li');
    li.className = `row tone-${w.stage === 'packed' ? 'ok' : w.short + w.qualityFailed > 0 ? 'error' : 'degraded'}`;
    li.dataset.wave = w.waveId; li.dataset.stage = w.stage;
    li.append(withChip(text('strong', `${w.waveId} · ${w.pickerId} — ${t(`stage_${w.stage}`)}`), w.stage === 'packed' ? 'done' : 'pending'));
    li.append(text('span', `${w.orderIds.join(', ')} · ${w.picked} ${t('pickedK')} · ${w.short} ${t('shortK')} · ${w.substituted} ${t('subK')} · ${w.qualityFailed} ${t('qcK')} · ${w.notYet} ${t('notYetK')}`, 'facts'));
    return li;
  }));
}

// ── Routes ───────────────────────────────────────────────────────────────────
function planInputs() { return { runDate: runDate(), storeId: store(), driversText: $('drivers').value, speed: $('speed').value, minutes: $('minutes').value }; }
function drawPlan(result) {
  const plan = result.plan;
  $('planned').hidden = false;
  $('planned').replaceChildren(...plan.routes.map((r) => {
    const li = document.createElement('li'); li.className = 'row tone-degraded'; li.dataset.route = r.routeId;
    li.append(withChip(text('strong', `${r.routeId} · ${r.driverId} · ${r.stops.length} · ${(r.totalMetres / 1000).toFixed(1)} km (${plan.distancesAre === 'straight_line' ? 'straight line' : plan.distancesAre}) · ${api.rupees(r.totalCodMinor)}`), 'pending'));
    const stops = document.createElement('ol'); stops.className = 'stops';
    for (const s of r.stops) stops.append(text('li', `${s.sequence}. ${s.orderId} · ${s.area} · ~${clock(s.estimatedArrivalAt)}${s.missesTheWindow ? ' · misses the window' : ''}${s.codMinor > 0 ? ` · ${api.rupees(s.codMinor)}` : ''}`));
    li.append(stops);
    if (may.dispatch) li.append(button(t('assign'), 'send', () => { void assign(r.routeId, li); }));
    return li;
  }));
  const notOn = [...plan.unplanned.map((u) => `${u.orderId} — ${u.detail}`), ...result.held.map((h) => `${h.orderId} — ${t(`st_${h.standing}`)}`)];
  $('unplanned').hidden = notOn.length === 0;
  $('unplanned').replaceChildren(text('li', t('unplannedK'), 'row'), ...notOn.map((w) => text('li', w, 'row tone-error')));
}
async function plan() {
  const out = await session.plan(planInputs());
  if (out.result !== 'ok') { say('plan-status', out); return; }
  good('plan-status', `${t('planned')} ${out.value.plan.routes.length} ${t('routesK')}`);
  drawPlan(out.value);
}
async function assign(routeId, li) {
  const out = await session.assign(runDate(), routeId, store());
  if (out.result !== 'ok') { say('plan-status', out); return; }
  li.className = 'row tone-ok';
  good('plan-status', `${t('assigned')} ${out.value.driverId} — ${routeId}`);
}
async function offRoad() {
  const out = await session.offRoad({ ...planInputs(), driverId: $('off-driver').value, reason: $('off-reason').value });
  if (out.result !== 'ok') { say('plan-status', out); return; }
  good('plan-status', `${t('withdrawnK')} ${(out.value.withdrawn ?? []).join(', ') || notKnownWord()} · ${t('planned')} ${out.value.plan.routes.length} ${t('routesK')}`);
  drawPlan(out.value);
}

// ── The day's routes ─────────────────────────────────────────────────────────
async function showBoard() {
  const out = await session.board(runDate(), store());
  if (out.result !== 'ok') { say('board-status', out); return; }
  $('board-status').className = 'status'; $('board-status').textContent = '';
  $('board').hidden = false;
  const routeList = $('route-list'); if (routeList) routeList.replaceChildren(...out.value.routes.map((r) => { const o = document.createElement('option'); o.value = r.routeId; return o; }));
  // OB-676: the limit the cash differences below are judged against, said "not confirmed by the owner" until he confirms it.
  const tolWords = api.toleranceNote(lang, out.value.handoverTolerance);
  $('board-tolerance').hidden = tolWords === '';
  $('board-tolerance').className = 'status err';
  if (tolWords === '') $('board-tolerance').textContent = ''; else sayWith($('board-tolerance'), 'warning', tolWords);
  $('board-tolerance').dataset.state = out.value.handoverTolerance?.state ?? 'not_told';
  const tolConfirmed = out.value.handoverTolerance?.state === 'confirmed';
  $('board').replaceChildren(...out.value.routes.map((r) => {
    const li = document.createElement('li');
    const flagged = r.flags.length > 0 || (r.cash.handover !== null && r.cash.handover.material);
    li.className = `row tone-${flagged ? 'error' : r.status === 'settled' ? 'ok' : 'degraded'}`;
    li.dataset.route = r.routeId; li.dataset.status = r.status;
    li.append(withChip(text('strong', `${r.routeId} · ${r.driverId ?? notKnownWord()} — ${t(`s_${r.status}`)}`), r.status === 'settled' ? 'done' : r.status === 'withdrawn' ? 'cancelled' : 'pending'));
    const stops = document.createElement('ol'); stops.className = 'stops';
    for (const s of r.stops) {
      const item = document.createElement('li'); item.dataset.stop = s.stopId; item.dataset.order = s.orderRef; item.dataset.state = s.state;
      if (s.flags.length > 0) item.className = 'flagged';
      const proof = s.proofCheck === null ? t('noProofYet')
        : `${t('codeK')}: ${t(`code_${s.proofCheck.code}`)} · ${t('fenceK')}: ${t(`fence_${s.proofCheck.fence.result}`)}${s.proofCheck.fence.distanceMetres === undefined ? '' : ` (${s.proofCheck.fence.distanceMetres} m)`}`;
      item.textContent = `${s.sequence}. ${s.orderRef} · ${s.state.replace(/_/g, ' ')} · ${proof} · ${t('photoK')}: ${s.imagesKept}`;
      // OB-343 · OB-344: a wrong code or a hand-over away from the address is a visible flag, in words — never refused.
      if (s.flags.length > 0) {
        const look = document.createElement('span'); look.className = 'flag-words'; look.dataset.flags = s.flags.join(' ');
        look.textContent = ` · ${t('needsLook')} ${api.flagWords(lang, s.flags).join('; ')}`;
        item.append(look);
      }
      stops.append(item);
    }
    li.append(stops);
    const h = r.cash.handover;
    li.append(text('span', `${t('expectedK')} ${api.rupees(r.cash.fromStops.expectedMinor)} · ${t('collectedK')} ${api.rupees(r.cash.fromStops.collectedMinor)}${h === null ? '' : ` · ${t('countedK')} ${api.rupees(h.countedMinor)} · ${t('varianceK')} ${api.rupees(h.varianceMinor)}${h.material ? ` · ${t('cashOffice')}` : ''}${tolConfirmed ? '' : ` · ${t('tolNotConfirmedShort')}`}`}`, 'facts cash'));
    return li;
  }));
}

// ── The contribution rule ────────────────────────────────────────────────────
async function showHeld() {
  const out = await session.contribution(store());
  if (out.result !== 'ok') { say('contribution-status', out); return; }
  const c = out.value;
  $('threshold').hidden = false;
  $('threshold').textContent = `${t('thresholdK')}: ${c.thresholdMinor === null ? t('notSet') : api.rupees(c.thresholdMinor)}`;
  $('contribution').hidden = false;
  $('contribution').replaceChildren(...c.orders.map((o) => {
    const li = document.createElement('li');
    li.className = `row tone-${o.standing === 'held' || o.standing === 'declined' ? 'error' : o.standing === 'flag_only' || o.standing === 'not_assessed' ? 'degraded' : 'ok'}`;
    li.dataset.order = o.orderId; li.dataset.standing = o.standing;
    li.append(withChip(text('strong', `${o.orderId} — ${t(`st_${o.standing}`)}`), o.standing === 'held' ? 'warning' : o.standing === 'clear' || o.standing === 'approved' ? 'done' : 'unknown'));
    li.append(text('span', o.gate.detail, 'facts'));
    if (o.standing === 'held' && may.decide) {
      const actions = document.createElement('div'); actions.className = 'actions';
      const label = document.createElement('label'); const input = document.createElement('input'); input.className = 'reason'; input.autocomplete = 'off';
      label.append(text('span', t('decisionL')), input);
      actions.append(label, button(t('approve'), 'badge-check', () => { void decide(o.orderId, 'approve', input.value); }), button(t('decline'), 'x', () => { void decide(o.orderId, 'decline', input.value); }, 'quiet'));
      li.append(actions);
    }
    return li;
  }));
}
async function decide(orderId, decision, reason) {
  const out = await session.decide(orderId, decision, reason);
  if (out.result !== 'ok') { say('contribution-status', out); return; }
  await showHeld();
  good('contribution-status', `${t('decided')} ${orderId} — ${t(`st_${out.value.standing}`)}`);
}

// ── The owner's numbers ──────────────────────────────────────────────────────
function controlValue(n) {
  if (n.state === 'not_set') return t('notSet').split(' — ')[0];
  if (n.key === 'fleetRate') return `${n.value.basis} ${api.rupees(n.value.rateMinor)}`;
  const v = n.key.endsWith('Minor') ? api.rupees(n.value) : `${n.value}`;
  // OB-343: a number the owner decided in writing reads as the shop's default, with the decision named.
  return n.state === 'default' ? `${v} (${t('defaultK')}, ${n.decidedBy})` : v;
}
function drawControls(c) {
  $('controls').hidden = false;
  $('controls').replaceChildren(...c.numbers.map((n) => {
    const li = document.createElement('li'); li.className = `row tone-${n.state === 'set' ? 'ok' : 'degraded'}`; li.dataset.key = n.key; li.dataset.state = n.state;
    li.append(text('strong', `${n.words[lang] ?? n.words.en}: ${controlValue(n)}`));
    if (may.setNumbers) {
      const actions = document.createElement('div'); actions.className = 'actions';
      const label = document.createElement('label'); const input = document.createElement('input'); input.className = 'value'; input.autocomplete = 'off';
      input.placeholder = n.key === 'fleetRate' ? 'per_drop 4000' : '';
      label.append(text('span', n.words[lang] ?? n.words.en), input);
      actions.append(label, button(t('save'), 'check', () => { void setNumber(n.key, input.value); }));
      li.append(actions);
    }
    return li;
  }));
}
async function showControls() {
  const out = await session.controls();
  if (out.result !== 'ok') { say('controls-status', out); return; }
  $('controls-status').className = 'status'; $('controls-status').textContent = '';
  drawControls(out.value);
}
async function setNumber(key, value) {
  const out = await session.setNumber(key, value);
  if (out.result !== 'ok') { say('controls-status', out); return; }
  good('controls-status', t('saved'));
  drawControls(out.value);
}

// ── OB-676: the driver cash hand-over limit ─────────────────────────────────
function drawTolerance(v) {
  $('tolerance').hidden = false;
  const state = $('tolerance-state');
  state.dataset.state = v.state;
  state.className = `status ${v.state === 'confirmed' ? 'good' : 'err'}`;
  const inForce = v.valueMinor === null ? t('toleranceNoSettings') : api.rupees(v.valueMinor);
  const who = v.confirmed === null ? '' : ` (${t('tolConfirmedBy')} ${v.confirmed.by}, ${window.sreShopDay?.dateTimeOf(v.confirmed.at) ?? v.confirmed.at})`;
  sayWith(state, v.state === 'confirmed' ? 'done' : 'warning', `${t('toleranceInForce')} ${inForce} — ${t(`tol_${v.state}`)}${who}.${v.changedSinceConfirmed ? ` ${t('tolChangedSince')}` : ''}`
    + (v.state === 'confirmed' ? '' : ` ${t('toleranceSuggested')} ${api.rupees(v.suggestedMinor)}.`));
  $('tolerance-form').hidden = !may.setNumbers;
  if (may.setNumbers) $('tolerance-value').value = (v.suggestedMinor / 100).toFixed(2).replace(/\.00$/, '');
  $('tolerance-history-h').hidden = v.history.length === 0;
  $('tolerance-history').replaceChildren(...[...v.history].reverse().map((c) => {
    const li = document.createElement('li'); li.className = 'row tone-ok'; li.dataset.version = String(c.version); li.dataset.kind = c.kind;
    const what = c.kind === 'changed' ? `${t('tolKind_changed')} ${c.previousMinor === null ? notKnownWord() : api.rupees(c.previousMinor)}` : t('tolKind_as_suggested');
    li.append(text('strong', `v${c.version} · ${api.rupees(c.valueMinor)} — ${what}`), text('span', `${c.by} · ${window.sreShopDay?.dateTimeOf(c.at) ?? c.at}${c.reason ? ` · ${c.reason}` : ''}`, 'facts'));
    return li;
  }));
}
async function showTolerance() {
  const out = await session.tolerance(store());
  if (out.result !== 'ok') { say('tolerance-status', out); return; }
  $('tolerance-status').className = 'status'; $('tolerance-status').textContent = '';
  drawTolerance(out.value);
}
async function confirmTolerance() {
  const out = await session.confirmTolerance(store(), $('tolerance-value').value, $('tolerance-note').value);
  if (out.result !== 'ok') { say('tolerance-status', out); return; }
  good('tolerance-status', `${t('confirmed')} ${api.rupees(out.value.valueMinor ?? 0)}`);
  $('tolerance-note').value = '';
  drawTolerance(out.value);
}

// ── W4 · M19-FR-02: dispatch a packed order — the manifest is head office's, built from the recorded pack ──────────
const sendOrder = () => $('send-order').value.trim();
async function showPack() {
  $('manifest').hidden = true;
  const out = await session.orderPack(sendOrder());
  if (out.result !== 'ok') { $('send-pack').hidden = true; say('send-status', out); return; }
  const p = out.value;
  $('send-status').className = 'status'; $('send-status').textContent = '';
  $('send-pack').hidden = false;
  $('pack-lines').replaceChildren(
    ...p.lines.map((l) => {
      const li = withChip(text('li', `${l.name} (${l.productId}) · ${l.packedMinor} ${t('packedK')}${l.shortMinor > 0 ? ` · ${l.shortMinor} ${t('shortK')}` : ''} · ${t('crateK')} ${l.crateId} · ${api.rupees(l.finalPriceMinor)}`, `row tone-${l.shortMinor > 0 ? 'error' : 'ok'}`), l.shortMinor > 0 ? 'warning' : 'done');
      li.dataset.line = l.lineId; li.dataset.crate = l.crateId;
      if (l.shortMinor > 0) li.append(toldBox(l.lineId));
      return li;
    }),
    ...p.refused.map((r) => { const li = withChip(text('li', `${t('refusedLineK')}: ${r.lineId} — ${r.detail}`, 'row tone-error'), 'warning'); li.dataset.line = r.lineId; li.append(toldBox(r.lineId)); return li; }),
  );
  // One tamper seal per crate, typed (or scanned) from the crate itself — never filled in by the page.
  $('crate-seals').replaceChildren(...[...new Set(p.lines.map((l) => l.crateId))].sort().map((crate) => {
    const label = document.createElement('label'); const input = document.createElement('input');
    input.className = 'seal'; input.dataset.crate = crate; input.autocomplete = 'off';
    label.append(text('span', `${t('sealL')} — ${t('crateK')} ${crate}`), input);
    return label;
  }));
  $('dispatch-order').disabled = !may.sendOrders; whyDisabled($('dispatch-order'), may.sendOrders ? '' : 'role');
}
function toldBox(lineId) {
  const label = document.createElement('label'); label.className = 'pick';
  const box = document.createElement('input'); box.type = 'checkbox'; box.className = 'told'; box.value = lineId;
  label.append(box, text('span', t('customerToldL')));
  return label;
}
async function dispatchOrder() {
  const seals = Object.fromEntries([...document.querySelectorAll('#crate-seals input.seal')].map((i) => [i.dataset.crate, i.value]));
  const resolvedLineIds = [...document.querySelectorAll('#pack-lines input.told:checked')].map((b) => b.value);
  const out = await session.dispatchOrder({ orderId: sendOrder(), storeId: store(), seals, resolvedLineIds });
  if (out.result !== 'ok') { say('send-status', out); return; }
  good('send-status', `${t('dispatchedK')} ${out.value.manifest?.manifestId ?? ''} · ${out.value.detail}`);
  await showManifest();
}
async function showManifest() {
  const out = await session.manifest(sendOrder());
  if (out.result !== 'ok') { $('manifest').hidden = true; say('send-status', out); return; }
  const m = out.value;
  $('manifest').hidden = false;
  $('manifest').dataset.manifest = m.manifestId;
  const head = text('li', `${t('manifestK')} ${m.manifestId} · ${m.orderId} · ${m.crates.length} ${t('cratesK')} · ${api.rupees(m.totalMinor)} · ${t('dispatchedByK')} ${m.dispatchedBy}`, 'row tone-ok');
  head.dataset.kind = 'head';
  const seals = text('li', `${t('sealsK')}: ${Object.entries(m.seals).map(([c, v]) => `${c} → ${v}`).join(' · ')}${m.temperatureReadings.length === 0 ? '' : ` · ${t('tempK')}: ${m.temperatureReadings.map((r) => `${(r.tenthsC / 10).toFixed(1)} °C`).join(', ')}`}`, 'row');
  seals.dataset.kind = 'seals';
  $('manifest').replaceChildren(head, ...m.lines.map((l) => { const li = text('li', `${l.name} (${l.productId}) · ${l.quantityMinor} · ${t('crateK')} ${l.crateId}`, 'row'); li.dataset.line = l.lineId; li.dataset.kind = 'line'; return li; }), seals);
}

// ── Own-fleet settlement ─────────────────────────────────────────────────────
function settled(out) {
  if (out.result !== 'ok') { say('settle-status', out); return; }
  const s = out.value;
  good('settle-status', `${s.routeId} · ${t('stage')}: ${s.stage}${s.proposed ? ` · ${api.rupees(s.proposed.amountMinor)} (${s.proposed.drops} ${t('drops')})` : ''}${s.differenceMinor !== null && s.differenceMinor !== 0 ? ` · ${t('varianceK')} ${api.rupees(s.differenceMinor)}` : ''} · ${t('settleBooks')}: ${s.books}`);
}


// U2 · G5 (UI/UX gap audit): the signed-in person's own store is filled in from the store computer (`sreOffice.me`) —
// the id stays what the page sends, the store's NAME is said beside it, and a person who may hold more than one store can
// still change it. Off the box, or before the chrome has loaded, nothing is filled in.
const ownStores = new Set();
function ownStore(inputId) {
  ownStores.add(inputId);
  const me = window.sreOffice?.me?.() ?? null;
  const input = $(inputId);
  if (me === null || !me.storeId || input === null) return;
  if (input.value.trim() === '') input.value = me.storeId;
  let note = document.getElementById(`${inputId}-own`);
  if (note === null) { note = document.createElement('small'); note.id = `${inputId}-own`; note.className = 'sre-why own-store'; input.after(note); }
  note.textContent = `${me.storeName ?? me.storeId} — ${t('yourStore')}`;
}
function paint() {
  ownStore('store');
  document.title = `SRE ${t('title')}`;
  for (const [id, k] of [['title-text', 'title'], ['page-h', 'title'], ['lead', 'lead'], ['store-l', 'storeL'], ['date-l', 'dateL'], ['waves-h', 'wavesH'],
    ['show-orders-text', 'showOrders'], ['show-waves-text', 'boardWaves'], ['ready-h', 'readyK'], ['held-orders-h', 'heldK'], ['on-wave-h', 'onWaveK'], ['wave-id-l', 'waveIdL'],
    ['picker-l', 'pickerL'], ['build-text', 'build'], ['routes-h', 'routesH'], ['drivers-l', 'driversL'], ['speed-l', 'speedL'], ['minutes-l', 'minutesL'], ['plan-text', 'plan'],
    ['off-driver-l', 'pickerL'], ['off-reason-l', 'reasonL'], ['off-road-text', 'offRoad'], ['board-h', 'boardH'], ['show-board-text', 'showBoard'], ['contribution-h', 'heldH'],
    ['show-held-text', 'showHeld'], ['controls-h', 'controlsH'], ['show-controls-text', 'showControls'],
    ['tolerance-h', 'toleranceH'], ['show-tolerance-text', 'showTolerance'], ['tolerance-value-l', 'toleranceL'], ['tolerance-note-l', 'toleranceReasonL'], ['confirm-tolerance-text', 'confirmTolerance'], ['tolerance-history-h', 'tolHistoryH'], ['settle-h', 'settleH'], ['settle-route-l', 'routeIdL'],
    ['send-h', 'sendH'], ['send-order-l', 'orderL'], ['show-pack-text', 'showPack'], ['dispatch-order-text', 'dispatchOrder'], ['show-manifest-text', 'showManifest'],
    ['propose-text', 'propose'], ['approve-settle-text', 'approveSettle'], ['paid-amount-l', 'amountL'], ['voucher-l', 'voucherL'], ['paid-text', 'paid']]) { const n = $(id); if (n) n.textContent = t(k); } // a label the shared date field now owns (U2) is not on the page
  $('off-driver-l').textContent = lang === 'ta' ? 'டிரைவர்' : 'Driver';
  $('lang').textContent = t('lang');
  $('whoami').textContent = window.dispatchData?.userId ?? '';
  $('nobody').hidden = may.named; $('nobody').textContent = t('nobody');
  $('show-orders').disabled = !may.waves; $('show-waves').disabled = !may.waves; $('build').disabled = !may.waves;
  for (const id of ['show-orders', 'show-waves', 'build']) whyDisabled($(id), may.waves ? '' : 'role');
  $('plan').disabled = !may.dispatch; $('off-road').disabled = !may.dispatch; $('propose').disabled = !may.dispatch;
  for (const id of ['plan', 'off-road', 'propose']) whyDisabled($(id), may.dispatch ? '' : 'role');
  $('show-board').disabled = !may.read; $('show-held').disabled = !may.read; $('show-controls').disabled = !may.read; $('show-tolerance').disabled = !may.read;
  for (const id of ['show-board', 'show-held', 'show-controls', 'show-tolerance']) whyDisabled($(id), may.read ? '' : 'role');
  $('approve-settle').disabled = !may.approveSettlement; $('paid').disabled = !may.approveSettlement;
  whyDisabled($('approve-settle'), may.approveSettlement ? '' : 'role'); whyDisabled($('paid'), may.approveSettlement ? '' : 'role');
  $('show-pack').disabled = !may.readPacks; $('show-manifest').disabled = !may.readPacks; $('dispatch-order').disabled = !may.sendOrders;
  whyDisabled($('show-pack'), may.readPacks ? '' : 'role'); whyDisabled($('show-manifest'), may.readPacks ? '' : 'role'); whyDisabled($('dispatch-order'), may.sendOrders ? '' : 'role');
  for (const id of ['plan', 'off-road', 'propose']) whyDisabled($(id), may.dispatch ? '' : 'role');
  for (const id of ['show-board', 'show-held', 'show-controls', 'show-tolerance']) whyDisabled($(id), may.read ? '' : 'role');
  for (const id of ['approve-settle', 'paid']) whyDisabled($(id), may.approveSettlement ? '' : 'role');
  for (const id of ['show-pack', 'show-manifest']) whyDisabled($(id), may.readPacks ? '' : 'role');
  whyDisabled($('dispatch-order'), may.sendOrders ? '' : 'role');
}

$('show-orders').addEventListener('click', () => { void showOrders(); });
$('build').addEventListener('click', () => { void build(); });
$('show-waves').addEventListener('click', () => { void showWaves(); });
$('plan').addEventListener('click', () => { void plan(); });
$('off-road').addEventListener('click', () => { void offRoad(); });
$('show-board').addEventListener('click', () => { void showBoard(); });
$('show-held').addEventListener('click', () => { void showHeld(); });
$('show-controls').addEventListener('click', () => { void showControls(); });
$('show-tolerance').addEventListener('click', () => { void showTolerance(); });
$('confirm-tolerance').addEventListener('click', () => { void confirmTolerance(); });
$('show-pack').addEventListener('click', () => { void showPack(); });
$('dispatch-order').addEventListener('click', () => { void dispatchOrder(); });
$('show-manifest').addEventListener('click', () => { void showManifest(); });
$('propose').addEventListener('click', async () => settled(await session.propose($('settle-route').value.trim())));
$('approve-settle').addEventListener('click', async () => settled(await session.approveSettlement($('settle-route').value.trim())));
$('paid').addEventListener('click', async () => settled(await session.recordPaid($('settle-route').value.trim(), $('paid-amount').value, $('voucher').value)));
// ── OB-352: deliveries from the till ────────────────────────────────────────
const desk = window.tillDeliveryDesk ?? null;
const dk = (k) => (desk === null ? k : desk.words(lang, k));
let tillJobs = null;
// OB-607: a moment is shown at the SHOP's clock (its zone, as the store computer told the page) — never the UTC clock.
const when = (iso) => (typeof iso === 'string' ? window.sreShopDay?.dateTimeOf(iso) ?? '' : '');
function deskSay(out) { $('till-jobs-status').className = `status ${out.result === 'ok' ? 'good' : 'err'}`; $('till-jobs-status').textContent = desk.outcomeWords(lang, out); }
function paintTillJobs() {
  const ul = $('till-jobs');
  if (tillJobs === null) { ul.hidden = true; return; }
  ul.hidden = false;
  if (tillJobs.jobs.length === 0) { ul.replaceChildren(text('li', dk('none'), 'muted')); return; }
  ul.replaceChildren(...tillJobs.jobs.map((j) => {
    const li = document.createElement('li'); li.className = `row tone-${j.status === 'booked' ? 'ok' : j.status === 'waiting_for_delivery_desk' ? 'degraded' : 'idle'}`;
    li.dataset.order = j.orderId; li.dataset.status = j.status;
    const st = text('span', '', 'state'); fillStatus(st, j.status === 'booked' ? 'ok' : j.status === 'waiting_for_delivery_desk' ? 'degraded' : 'idle', dk(j.status));
    li.append(text('strong', `${dk('job')} ${j.orderId} · ${dk('bill')} ${j.receiptNumber}`), st);
    if (j.given !== null) {
      const why = j.given.forAppCustomer === undefined ? '' : ` · ${dk('forApp')} ${dk(j.given.forAppCustomer.because)}${j.given.forAppCustomer.note ? `: ${j.given.forAppCustomer.note}` : ''}`;
      li.append(text('span', `${dk('slotL')}: ${when(j.given.slotStartsAt)}–${when(j.given.slotEndsAt).slice(11)} · ${j.given.by === 'customer_app' ? dk('byApp') : `${dk('byDesk')} ${j.given.personId}`}${why}`, 'facts'));
    }
    // OB-369: an app customer who has not chosen — the owner's wait said, and the desk may enter it after a call or the wait.
    const appJob = j.status === 'waiting_for_customer_app' && j.deskMayEnter !== undefined;
    if (appJob) {
      const m = j.deskMayEnter;
      const w = text('span', m.waitEndsAt === null ? dk('waitNotSet') : m.afterWait ? dk('waitPassed') : `${dk('waitEnds')} ${when(m.waitEndsAt)}`, 'facts wait');
      if (m.waitEndsAt !== null) withChip(w, 'pending'); // "not set" says itself in words
      w.dataset.afterWait = String(m.afterWait); li.append(w);
    }
    if ((j.status === 'waiting_for_delivery_desk' || appJob) && desk.session.may.enter) {
      const form = document.createElement('div'); form.className = 'row-form';
      const field = (label, control) => { const l = document.createElement('label'); l.append(text('span', label), control); return l; };
      const slot = document.createElement('select'); slot.className = 'tj-slot';
      if (tillJobs.openSlots.length === 0) { const o = document.createElement('option'); o.value = ''; o.textContent = dk('noSlots'); slot.append(o); }
      for (const s of tillJobs.openSlots) { const o = document.createElement('option'); o.value = s.startsAt; o.textContent = `${when(s.startsAt)}–${when(s.endsAt).slice(11)} (${s.remaining})`; slot.append(o); }
      const lat = document.createElement('input'); lat.className = 'tj-lat'; lat.inputMode = 'decimal'; lat.autocomplete = 'off';
      const lon = document.createElement('input'); lon.className = 'tj-lon'; lon.inputMode = 'decimal'; lon.autocomplete = 'off';
      const landmark = document.createElement('input'); landmark.className = 'tj-landmark'; landmark.autocomplete = 'off'; landmark.maxLength = 80;
      let why = null; let note = null;
      if (appJob) {
        form.append(text('strong', dk('appEnterH'), 'tj-app-h'));
        why = document.createElement('select'); why.className = 'tj-why';
        for (const r of ['customer_phoned', 'wait_passed']) {
          const o = document.createElement('option'); o.value = r; o.textContent = dk(r);
          if (r === 'wait_passed' && !j.deskMayEnter.afterWait) o.disabled = true;
          why.append(o);
        }
        note = document.createElement('input'); note.className = 'tj-note'; note.autocomplete = 'off'; note.maxLength = 200;
        form.append(field(dk('whyL'), why), field(dk('noteL'), note));
      }
      form.append(field(dk('slotL'), slot), field(dk('latL'), lat), field(dk('lonL'), lon), field(dk('landmarkL'), landmark),
        button(dk('enter'), 'truck', async () => {
          const out = await desk.session.enter(j.orderId, { slotStartsAt: slot.value, lat: lat.value, lon: lon.value, landmark: landmark.value, ...(why === null ? {} : { appCustomer: { because: why.value, note: note.value } }) });
          deskSay(out);
          if (out.result === 'ok') await showTillJobs(false);
        }));
      li.append(form);
    }
    return li;
  }));
}
async function showTillJobs(say = true) {
  if (desk === null || !desk.session.may.read) { $('till-jobs-status').className = 'status err'; $('till-jobs-status').textContent = dk('cannotRead'); return; }
  const out = await desk.session.jobs(store(), dateOf('till-day'));
  if (out.result !== 'ok') { deskSay(out); return; }
  tillJobs = out.value;
  if (say) { $('till-jobs-status').className = 'status'; $('till-jobs-status').textContent = `${tillJobs.waitingForDesk} ${dk('waitingDesk')} · ${tillJobs.waitingForCustomer} ${dk('waitingApp')}`; }
  paintTillJobs();
}
function paintDesk() {
  for (const [id, k] of [['till-jobs-h', 'tillJobsH'], ['till-jobs-lead', 'tillJobsLead'], ['till-day-l', 'dayL'], ['show-till-jobs-text', 'showTillJobs']]) { const n = $(id); if (n) n.textContent = dk(k); }
  $('show-till-jobs').disabled = desk === null || !desk.session.may.read; whyDisabled($('show-till-jobs'), desk === null ? 'offline' : desk.session.may.read ? '' : 'role');
  paintTillJobs();
}
{ const i = icon('truck'); if (i !== null) $('show-till-jobs').prepend(i, ' '); }
$('show-till-jobs').addEventListener('click', () => { void showTillJobs(); });

$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); paintDesk(); });
if (api !== null) paint();
paintDesk();

/** A greyed button says why (U1 · G3 · design system §4 "disabled state explains why"): the reason is the button's tooltip
 *  and the words beside it, in the reader's language. `why` is 'role' (your role may not), 'offline' (head office cannot
 *  be reached), a page's own { en, ta } pair or sentence; '' takes the words away. */
function whyWords() {
  return {
  role: { en: 'Your role may not do this.', ta: 'உங்கள் பங்குக்கு இதைச் செய்ய அனுமதி இல்லை.' },
  offline: { en: 'Head office cannot be reached, so this cannot be done now.', ta: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை, எனவே இப்போது இதைச் செய்ய முடியாது.' },
  };
}
function whyDisabled(btn, why) {
  const tongue = document.documentElement.lang === 'ta' ? 'ta' : 'en';
  const words = why === '' || why === undefined || why === null ? '' : typeof why === 'string' ? (whyWords()[why]?.[tongue] ?? why) : (why[tongue] ?? why.en);
  let note = btn.nextElementSibling;
  if (!(note && note.classList.contains('sre-why'))) {
    note = document.createElement('small'); note.className = 'sre-why';
    note.id = `${btn.id || `b${Math.random().toString(36).slice(2, 7)}`}-why`;
    btn.after(note);
  }
  note.textContent = words; note.hidden = words === '';
  if (words === '') { btn.removeAttribute('title'); btn.removeAttribute('aria-describedby'); } else { btn.title = words; btn.setAttribute('aria-describedby', note.id); }
}
// the chrome (and `sreOffice.me`) loads after this script: fill the store in once it is there
document.addEventListener('sre:chrome', () => { if (desk !== null) shopDate('till-day', { en: desk.words('en', 'dayL'), ta: desk.words('ta', 'dayL') }); shopDate('run-date', { en: wordsIn('en', 'dateL'), ta: wordsIn('ta', 'dateL') }); paint(); }, { once: true });

// ── U2b (G5): pick by name, never type a code
let wavesKnown = 0;
const mintWaveId = () => `W-${(runDate() || '').replace(/-/g, '')}-${String(wavesKnown + 1).padStart(2, '0')}`;
pickable('picker', 'person', 'pickPerson', { scope: () => ({ storeId: store() }) });
pickable('off-driver', 'person', 'pickPerson', { scope: () => ({ storeId: store() }) });
