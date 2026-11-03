// Dispatch office (M19-FR-01/03/04 · WF-14 · WF-15 · D09-FR-05/06 · OB-294 · OB-300 · OB-313). The session
// (apps/web-erp/src/dispatch-session.ts, in the bundle as window.dispatch) asks head office on a click; this page draws the
// answers: the orders waiting for a wave and the ones held for a manager, each wave's progress, the day's planned routes
// and the ones not on a route (each with its reason), every door's proof (the code's verdict, where the phone was, the
// pictures kept) and the cash, the contribution rule, the owner's numbers ("not set" until he enters them), and the
// own-fleet settlement. Every state is a mark AND words. Every word has a Tamil twin.

// OB-607: a time of day is the SHOP's clock (its zone, as the store computer told the page) — never this device's.
const shopTimeOf = (value) => window.sreShopDay?.timeOf(value) ?? '';
const $ = (id) => document.getElementById(id);
const api = window.dispatch ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, waves: false, dispatch: false, decide: false, setNumbers: false, approveSettlement: false, readPacks: false, sendOrders: false };

let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
const store = () => $('store').value;
const runDate = () => $('run-date').value;

const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
for (const [id, name] of [['show-orders', 'search'], ['show-waves', 'list-checks'], ['build', 'package'], ['plan', 'navigation'], ['off-road', 'rotate-ccw'],
  ['show-board', 'truck'], ['show-held', 'percent'], ['show-controls', 'sliders'], ['show-tolerance', 'wallet'], ['confirm-tolerance', 'check'], ['propose', 'wallet'], ['approve-settle', 'badge-check'], ['paid', 'receipt'], ['show-pack', 'package'], ['dispatch-order', 'truck'], ['show-manifest', 'clipboard-list']]) {
  const i = icon(name); if (i !== null) $(id).prepend(i, ' ');
}

function say(where, out) { $(where).className = 'status err'; $(where).textContent = api.outcomeWords(lang, out); }
function good(where, words) { $(where).className = 'status good'; $(where).textContent = `✓ ${words}`; }
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
function button(words, iconName, onClick, cls) {
  const b = document.createElement('button'); b.type = 'button'; if (cls) b.className = cls;
  const i = icon(iconName); if (i !== null) b.append(i, ' ');
  b.append(text('span', words)); b.addEventListener('click', onClick); return b;
}
const clock = (iso) => (iso ? shopTimeOf(iso) : '—');

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
  $('ready').replaceChildren(...(c.ready.length === 0 ? [text('li', `○ ${t('noneReady')}`, 'row')] : c.ready.map((x) => candidateRow(x, true))));
  $('held-orders').replaceChildren(...c.held.map((x) => candidateRow(x, false)));
  $('on-wave').replaceChildren(...c.onWave.map((x) => candidateRow(x, false)));
  $('waves-status').className = 'status'; $('waves-status').textContent = '';
}
async function build() {
  const orderIds = [...document.querySelectorAll('#ready input.choose:checked')].map((b) => b.value);
  const out = await session.buildWave({ waveId: $('wave-id').value, storeId: store(), pickerId: $('picker').value, orderIds });
  if (out.result !== 'ok') { say('waves-status', out); return; }
  const w = out.value;
  const kept = w.refused.length === 0 ? '' : ` · ⚠ ${t('refusedK')}: ${w.refused.map((r) => `${r.orderId} (${r.detail})`).join('; ')}`;
  await showOrders();
  good('waves-status', `${t('built')} ${w.waveId} · ${w.pickerId} · ${w.lineCount} ${t('lines')}${kept}`);
}
async function showWaves() {
  const out = await session.waves(store());
  if (out.result !== 'ok') { say('waves-status', out); return; }
  $('waves').hidden = false;
  $('waves').replaceChildren(...out.value.waves.map((w) => {
    const li = document.createElement('li');
    li.className = `row tone-${w.stage === 'packed' ? 'ok' : w.short + w.qualityFailed > 0 ? 'error' : 'degraded'}`;
    li.dataset.wave = w.waveId; li.dataset.stage = w.stage;
    li.append(text('strong', `${w.stage === 'packed' ? '✓' : '⏱'} ${w.waveId} · ${w.pickerId} — ${t(`stage_${w.stage}`)}`));
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
    li.append(text('strong', `⏱ ${r.routeId} · ${r.driverId} · ${r.stops.length} · ${(r.totalMetres / 1000).toFixed(1)} km (${plan.distancesAre === 'straight_line' ? 'straight line' : plan.distancesAre}) · ${api.rupees(r.totalCodMinor)}`));
    const stops = document.createElement('ol'); stops.className = 'stops';
    for (const s of r.stops) stops.append(text('li', `${s.sequence}. ${s.orderId} · ${s.area} · ~${clock(s.estimatedArrivalAt)}${s.missesTheWindow ? ' · ⚠ misses the window' : ''}${s.codMinor > 0 ? ` · ${api.rupees(s.codMinor)}` : ''}`));
    li.append(stops);
    if (may.dispatch) li.append(button(t('assign'), 'send', () => { void assign(r.routeId, li); }));
    return li;
  }));
  const notOn = [...plan.unplanned.map((u) => `⚠ ${u.orderId} — ${u.detail}`), ...result.held.map((h) => `⚠ ${h.orderId} — ${t(`st_${h.standing}`)}`)];
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
  good('plan-status', `${t('withdrawnK')} ${(out.value.withdrawn ?? []).join(', ') || '—'} · ${t('planned')} ${out.value.plan.routes.length} ${t('routesK')}`);
  drawPlan(out.value);
}

// ── The day's routes ─────────────────────────────────────────────────────────
const CODE_MARK = { matched: '✓', wrong: '⚠', not_issued: '⚠', not_given: '○' };
const FENCE_MARK = { inside: '✓', outside: '⚠', radius_not_set: '○', no_device_location: '○', no_address_location: '○' };
async function showBoard() {
  const out = await session.board(runDate(), store());
  if (out.result !== 'ok') { say('board-status', out); return; }
  $('board-status').className = 'status'; $('board-status').textContent = '';
  $('board').hidden = false;
  // OB-676: the limit the cash differences below are judged against, said "not confirmed by the owner" until he confirms it.
  const tolWords = api.toleranceNote(lang, out.value.handoverTolerance);
  $('board-tolerance').hidden = tolWords === '';
  $('board-tolerance').className = 'status err';
  $('board-tolerance').textContent = tolWords === '' ? '' : `⚠ ${tolWords}`;
  $('board-tolerance').dataset.state = out.value.handoverTolerance?.state ?? 'not_told';
  const tolConfirmed = out.value.handoverTolerance?.state === 'confirmed';
  $('board').replaceChildren(...out.value.routes.map((r) => {
    const li = document.createElement('li');
    const flagged = r.flags.length > 0 || (r.cash.handover !== null && r.cash.handover.material);
    li.className = `row tone-${flagged ? 'error' : r.status === 'settled' ? 'ok' : 'degraded'}`;
    li.dataset.route = r.routeId; li.dataset.status = r.status;
    li.append(text('strong', `${r.status === 'settled' ? '✓' : r.status === 'withdrawn' ? '↺' : '⏱'} ${r.routeId} · ${r.driverId ?? '—'} — ${t(`s_${r.status}`)}`));
    const stops = document.createElement('ol'); stops.className = 'stops';
    for (const s of r.stops) {
      const item = document.createElement('li'); item.dataset.stop = s.stopId; item.dataset.order = s.orderRef; item.dataset.state = s.state;
      if (s.flags.length > 0) item.className = 'flagged';
      const proof = s.proofCheck === null ? t('noProofYet')
        : `${t('codeK')}: ${CODE_MARK[s.proofCheck.code] ?? '○'} ${t(`code_${s.proofCheck.code}`)} · ${t('fenceK')}: ${FENCE_MARK[s.proofCheck.fence.result] ?? '○'} ${t(`fence_${s.proofCheck.fence.result}`)}${s.proofCheck.fence.distanceMetres === undefined ? '' : ` (${s.proofCheck.fence.distanceMetres} m)`}`;
      item.textContent = `${s.sequence}. ${s.orderRef} · ${s.state.replace(/_/g, ' ')} · ${proof} · ${t('photoK')}: ${s.imagesKept}`;
      // OB-343 · OB-344: a wrong code or a hand-over away from the address is a visible flag, in words — never refused.
      if (s.flags.length > 0) {
        const look = document.createElement('span'); look.className = 'flag-words'; look.dataset.flags = s.flags.join(' ');
        look.textContent = ` · ⚠ ${t('needsLook')} ${api.flagWords(lang, s.flags).join('; ')}`;
        item.append(look);
      }
      stops.append(item);
    }
    li.append(stops);
    const h = r.cash.handover;
    li.append(text('span', `${t('expectedK')} ${api.rupees(r.cash.fromStops.expectedMinor)} · ${t('collectedK')} ${api.rupees(r.cash.fromStops.collectedMinor)}${h === null ? '' : ` · ${t('countedK')} ${api.rupees(h.countedMinor)} · ${t('varianceK')} ${api.rupees(h.varianceMinor)}${h.material ? ` · ⚠ ${t('cashOffice')}` : ''}${tolConfirmed ? '' : ` · ⚠ ${t('tolNotConfirmedShort')}`}`}`, 'facts cash'));
    return li;
  }));
}

// ── The contribution rule ────────────────────────────────────────────────────
async function showHeld() {
  const out = await session.contribution(store());
  if (out.result !== 'ok') { say('contribution-status', out); return; }
  const c = out.value;
  $('threshold').hidden = false;
  $('threshold').textContent = `${t('thresholdK')}: ${c.thresholdMinor === null ? `○ ${t('notSet')}` : api.rupees(c.thresholdMinor)}`;
  $('contribution').hidden = false;
  $('contribution').replaceChildren(...c.orders.map((o) => {
    const li = document.createElement('li');
    li.className = `row tone-${o.standing === 'held' || o.standing === 'declined' ? 'error' : o.standing === 'flag_only' || o.standing === 'not_assessed' ? 'degraded' : 'ok'}`;
    li.dataset.order = o.orderId; li.dataset.standing = o.standing;
    li.append(text('strong', `${o.standing === 'held' ? '⚠' : o.standing === 'clear' || o.standing === 'approved' ? '✓' : '○'} ${o.orderId} — ${t(`st_${o.standing}`)}`));
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
  if (n.state === 'not_set') return `○ ${t('notSet').split(' — ')[0]}`;
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
  state.textContent = `${v.state === 'confirmed' ? '✓' : '⚠'} ${t('toleranceInForce')} ${inForce} — ${t(`tol_${v.state}`)}${who}.${v.changedSinceConfirmed ? ` ${t('tolChangedSince')}` : ''}`
    + (v.state === 'confirmed' ? '' : ` ${t('toleranceSuggested')} ${api.rupees(v.suggestedMinor)}.`);
  $('tolerance-form').hidden = !may.setNumbers;
  if (may.setNumbers) $('tolerance-value').value = (v.suggestedMinor / 100).toFixed(2).replace(/\.00$/, '');
  $('tolerance-history-h').hidden = v.history.length === 0;
  $('tolerance-history').replaceChildren(...[...v.history].reverse().map((c) => {
    const li = document.createElement('li'); li.className = 'row tone-ok'; li.dataset.version = String(c.version); li.dataset.kind = c.kind;
    const what = c.kind === 'changed' ? `${t('tolKind_changed')} ${c.previousMinor === null ? '—' : api.rupees(c.previousMinor)}` : t('tolKind_as_suggested');
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
      const li = text('li', `${l.shortMinor > 0 ? '⚠' : '✓'} ${l.name} (${l.productId}) · ${l.packedMinor} ${t('packedK')}${l.shortMinor > 0 ? ` · ${l.shortMinor} ${t('shortK')}` : ''} · ${t('crateK')} ${l.crateId} · ${api.rupees(l.finalPriceMinor)}`, `row tone-${l.shortMinor > 0 ? 'error' : 'ok'}`);
      li.dataset.line = l.lineId; li.dataset.crate = l.crateId;
      if (l.shortMinor > 0) li.append(toldBox(l.lineId));
      return li;
    }),
    ...p.refused.map((r) => { const li = text('li', `⚠ ${t('refusedLineK')}: ${r.lineId} — ${r.detail}`, 'row tone-error'); li.dataset.line = r.lineId; li.append(toldBox(r.lineId)); return li; }),
  );
  // One tamper seal per crate, typed (or scanned) from the crate itself — never filled in by the page.
  $('crate-seals').replaceChildren(...[...new Set(p.lines.map((l) => l.crateId))].sort().map((crate) => {
    const label = document.createElement('label'); const input = document.createElement('input');
    input.className = 'seal'; input.dataset.crate = crate; input.autocomplete = 'off';
    label.append(text('span', `${t('sealL')} — ${t('crateK')} ${crate}`), input);
    return label;
  }));
  $('dispatch-order').disabled = !may.sendOrders;
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
  good('settle-status', `${s.routeId} · ${t('stage')}: ${s.stage}${s.proposed ? ` · ${api.rupees(s.proposed.amountMinor)} (${s.proposed.drops} ${t('drops')})` : ''}${s.differenceMinor !== null && s.differenceMinor !== 0 ? ` · ⚠ ${t('varianceK')} ${api.rupees(s.differenceMinor)}` : ''} · ${t('settleBooks')}: ${s.books}`);
}

function paint() {
  document.title = `SRE ${t('title')}`;
  for (const [id, k] of [['title-text', 'title'], ['page-h', 'title'], ['lead', 'lead'], ['store-l', 'storeL'], ['date-l', 'dateL'], ['waves-h', 'wavesH'],
    ['show-orders-text', 'showOrders'], ['show-waves-text', 'boardWaves'], ['ready-h', 'readyK'], ['held-orders-h', 'heldK'], ['on-wave-h', 'onWaveK'], ['wave-id-l', 'waveIdL'],
    ['picker-l', 'pickerL'], ['build-text', 'build'], ['routes-h', 'routesH'], ['drivers-l', 'driversL'], ['speed-l', 'speedL'], ['minutes-l', 'minutesL'], ['plan-text', 'plan'],
    ['off-driver-l', 'pickerL'], ['off-reason-l', 'reasonL'], ['off-road-text', 'offRoad'], ['board-h', 'boardH'], ['show-board-text', 'showBoard'], ['contribution-h', 'heldH'],
    ['show-held-text', 'showHeld'], ['controls-h', 'controlsH'], ['show-controls-text', 'showControls'],
    ['tolerance-h', 'toleranceH'], ['show-tolerance-text', 'showTolerance'], ['tolerance-value-l', 'toleranceL'], ['tolerance-note-l', 'toleranceReasonL'], ['confirm-tolerance-text', 'confirmTolerance'], ['tolerance-history-h', 'tolHistoryH'], ['settle-h', 'settleH'], ['settle-route-l', 'routeIdL'],
    ['send-h', 'sendH'], ['send-order-l', 'orderL'], ['show-pack-text', 'showPack'], ['dispatch-order-text', 'dispatchOrder'], ['show-manifest-text', 'showManifest'],
    ['propose-text', 'propose'], ['approve-settle-text', 'approveSettle'], ['paid-amount-l', 'amountL'], ['voucher-l', 'voucherL'], ['paid-text', 'paid']]) $(id).textContent = t(k);
  $('off-driver-l').textContent = lang === 'ta' ? 'டிரைவர்' : 'Driver';
  $('lang').textContent = t('lang');
  $('whoami').textContent = window.dispatchData?.userId ?? '';
  $('nobody').hidden = may.named; $('nobody').textContent = t('nobody');
  $('show-orders').disabled = !may.waves; $('show-waves').disabled = !may.waves; $('build').disabled = !may.waves;
  $('plan').disabled = !may.dispatch; $('off-road').disabled = !may.dispatch; $('propose').disabled = !may.dispatch;
  $('show-board').disabled = !may.read; $('show-held').disabled = !may.read; $('show-controls').disabled = !may.read; $('show-tolerance').disabled = !may.read;
  $('approve-settle').disabled = !may.approveSettlement; $('paid').disabled = !may.approveSettlement;
  $('show-pack').disabled = !may.readPacks; $('show-manifest').disabled = !may.readPacks; $('dispatch-order').disabled = !may.sendOrders;
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
    const mark = j.status === 'booked' ? '✓' : j.status === 'waiting_for_delivery_desk' ? '⚠' : '•';
    li.append(text('strong', `${dk('job')} ${j.orderId} · ${dk('bill')} ${j.receiptNumber}`), text('span', `${mark} ${dk(j.status)}`, 'state'));
    if (j.given !== null) {
      const why = j.given.forAppCustomer === undefined ? '' : ` · ${dk('forApp')} ${dk(j.given.forAppCustomer.because)}${j.given.forAppCustomer.note ? `: ${j.given.forAppCustomer.note}` : ''}`;
      li.append(text('span', `${dk('slotL')}: ${when(j.given.slotStartsAt)}–${when(j.given.slotEndsAt).slice(11)} · ${j.given.by === 'customer_app' ? dk('byApp') : `${dk('byDesk')} ${j.given.personId}`}${why}`, 'facts'));
    }
    // OB-369: an app customer who has not chosen — the owner's wait said, and the desk may enter it after a call or the wait.
    const appJob = j.status === 'waiting_for_customer_app' && j.deskMayEnter !== undefined;
    if (appJob) {
      const m = j.deskMayEnter;
      const w = text('span', m.waitEndsAt === null ? `○ ${dk('waitNotSet')}` : m.afterWait ? `⏱ ${dk('waitPassed')}` : `⏱ ${dk('waitEnds')} ${when(m.waitEndsAt)}`, 'facts wait');
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
  const out = await desk.session.jobs(store(), $('till-day').value);
  if (out.result !== 'ok') { deskSay(out); return; }
  tillJobs = out.value;
  if (say) { $('till-jobs-status').className = 'status'; $('till-jobs-status').textContent = `${tillJobs.waitingForDesk} ${dk('waitingDesk')} · ${tillJobs.waitingForCustomer} ${dk('waitingApp')}`; }
  paintTillJobs();
}
function paintDesk() {
  for (const [id, k] of [['till-jobs-h', 'tillJobsH'], ['till-jobs-lead', 'tillJobsLead'], ['till-day-l', 'dayL'], ['show-till-jobs-text', 'showTillJobs']]) $(id).textContent = dk(k);
  $('show-till-jobs').disabled = desk === null || !desk.session.may.read;
  paintTillJobs();
}
{ const i = icon('truck'); if (i !== null) $('show-till-jobs').prepend(i, ' '); }
$('show-till-jobs').addEventListener('click', () => { void showTillJobs(); });

$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); paintDesk(); });
if (api !== null) paint();
paintDesk();
