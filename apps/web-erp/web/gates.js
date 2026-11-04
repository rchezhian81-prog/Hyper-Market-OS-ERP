// Quality gates — the page over head office's gate register (QG-12 · roadmap §22 · §36 · OB-288 gates lane). The session
// (apps/web-erp/src/gates-session.ts, in the bundle as window.gates) asks head office; this page shows every gate's
// standing for the release the person chooses, each with an icon AND words, and records the owner's decision on an
// explicit click. A gate nobody decided says "Not decided — silence is not approval". Every word has a Tamil twin.
// OB-423: the QG-10 row also lists the release script's own QG-10 notes — evidence for the decision, never a decision; a
// read that fails says so ("not the same as none"), never an empty list. Owner's answer (c): EVERY attempt of every release
// is listed, newest first, each with its outcome, box, run and attempt — nothing hidden or collapsed into "latest".

const $ = (id) => document.getElementById(id);
const api = window.gates ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, decide: false };

let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
let register = null;
let evidence = null; // OB-423: the last read of the release script's QG-10 notes (an Outcome)
let outside = null; // W3: the last read of the outside evidence (an Outcome)
let qg01 = null; // W7: the last read of the CI's QG-01 requirement-records reading (an Outcome)

const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
for (const [id, name] of [['show', 'search'], ['record', 'badge-check']]) { const i = icon(name); if (i !== null) $(id).prepend(i, ' '); }

function say(id, out) { $(id).className = 'status err'; $(id).textContent = api.outcomeWords(lang, out); }
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }

function paintReleases() {
  const sel = $('release');
  const chosen = sel.value;
  sel.replaceChildren(text('option', t('chooseRelease')), ...(api?.releases ?? []).map((r) => { const o = text('option', r); o.value = r; return o; }));
  sel.firstChild.value = '';
  sel.value = chosen;
  const g = $('decide-gate');
  const gate = g.value;
  g.replaceChildren(...Object.keys(api?.names ?? {}).map((id) => { const o = text('option', `${id} · ${api.names[id][lang]}`); o.value = id; return o; }));
  if (gate) g.value = gate;
}

function gateRow(g) {
  const view = api.stateView(lang, g.state);
  const li = document.createElement('li');
  li.className = `row tone-${view.tone}`;
  li.dataset.gate = g.gate;
  li.dataset.state = g.state;
  const head = document.createElement('div');
  head.className = 'head';
  head.append(text('span', `${g.gate} · ${api.names[g.gate]?.[lang] ?? g.name}`, 'gate'));
  const state = document.createElement('span');
  state.className = 'state';
  state.append(text('span', view.icon, 'icon'), text('span', view.words, 'words'));
  head.append(state);
  li.append(head);
  const facts = document.createElement('div');
  facts.className = 'facts';
  facts.append(text('span', `${t('passK')}: ${g.passCondition}`));
  if (g.decidedBy) facts.append(text('span', `${t('decidedByK')}: ${g.decidedBy} · ${g.decidedAt ?? ''}`));
  if (g.rationale) facts.append(text('span', `${t('becauseK')}: “${g.rationale}”`));
  for (const e of g.evidence ?? []) facts.append(text('span', `${t('evidenceK')}: ${e.label} — ${e.ref}`));
  li.append(facts);
  if (g.blockers.length === 0) li.append(text('p', t('noBlockers'), 'facts'));
  else {
    li.append(text('span', `${t('blockersK')}:`, 'facts'));
    const ul = document.createElement('ul');
    ul.className = 'blockers';
    for (const b of g.blockers) { const item = text('li', `⚠ ${t(`k_${b.kind}`)} — ${b.reason}`); item.dataset.kind = b.kind; ul.append(item); }
    li.append(ul);
  }
  if (g.gate === 'QG-10') li.append(qg10Notes());
  if (g.gate === 'QG-01') li.append(qg01Reading());
  return li;
}

// OB-423: the release script's QG-10 notes — every attempt, newest first, as head office sent them — each an icon AND words.
function qg10Notes() {
  const box = document.createElement('div');
  box.className = 'qg10';
  box.id = 'qg10-evidence';
  box.append(text('h4', t('qg10H')), text('p', t('qg10Lead'), 'facts'));
  if (evidence === null || evidence.result !== 'ok') {
    const p = text('p', evidence === null ? t('qg10Unread') : `${t('qg10Unread')} ${api.outcomeWords(lang, evidence)}`, 'status err');
    p.dataset.qg10 = 'unread';
    box.append(p);
    return box;
  }
  if (evidence.value.notes.length === 0) { const p = text('p', t('qg10None'), 'facts'); p.dataset.qg10 = 'none'; box.append(p); return box; }
  const ul = document.createElement('ul');
  ul.className = 'qg10-notes';
  for (const n of evidence.value.notes) {
    const v = api.noteView(lang, n);
    const item = document.createElement('li');
    item.className = `tone-${v.tone}`;
    item.dataset.release = n.release;
    item.dataset.box = n.box;
    item.dataset.run = n.run;
    item.dataset.attempt = n.attempt;
    item.dataset.outcome = n.outcome;
    item.dataset.verified = String(n.verified);
    const head = document.createElement('div');
    head.append(text('span', v.icon, 'icon'), ' ', text('span', v.headline, 'words'));
    item.append(head, ...v.lines.map((l) => text('div', l, 'facts')));
    ul.append(item);
  }
  box.append(ul);
  return box;
}

// W7 · QG-01: the CI's reading of the requirement records — the build's own check — an icon AND words. Missing, not
// complete or failing holds the gate; a clean reading is evidence for the owner's decision, never "passed".
function qg01Reading() {
  const box = document.createElement('div');
  box.className = 'qg01';
  box.id = 'qg01-reading';
  box.append(text('h4', t('qg01H')), text('p', t('qg01Lead'), 'facts'));
  const v = api.qg01View(lang, qg01);
  box.dataset.qg01 = v.state;
  const head = document.createElement('p');
  head.className = `tone-${v.tone}`;
  head.append(text('span', v.icon, 'icon'), ' ', text('span', v.headline, 'words'));
  box.append(head, ...v.lines.map((l) => text('div', l, 'facts')));
  return box;
}

// W3 · QG-04 / QG-05 / QG-06: each outside test's standing — an icon AND words; nothing on file is never a pass.
function paintOutside() {
  const kindSel = $('outside-kind');
  const chosen = kindSel.value;
  kindSel.replaceChildren(text('option', ''), ...(api?.outsideKinds ?? []).map((k) => { const o = text('option', t(`ev_${k}`)); o.value = k; return o; }));
  kindSel.firstChild.value = '';
  kindSel.value = chosen;
  const timing = (api?.outsideTimings ?? []).includes(kindSel.value);
  $('outside-ms-wrap').hidden = !timing;
  $('outside-result-wrap').hidden = timing;
  $('outside-opt-passed').textContent = t('outsidePassed');
  $('outside-opt-failed').textContent = t('outsideFailed');
  const ul = $('outside-list');
  if (outside === null || outside.result !== 'ok') {
    const li = text('li', outside === null ? t('outsideUnread') : `${t('outsideUnread')} ${api.outcomeWords(lang, outside)}`, 'status err');
    li.dataset.outside = 'unread';
    ul.replaceChildren(li);
    return;
  }
  ul.replaceChildren(...outside.value.kinds.map((k) => {
    const v = api.outsideView(lang, k);
    const li = document.createElement('li');
    li.className = `tone-${v.tone}`;
    li.dataset.kind = k.kind;
    li.dataset.standing = k.standing;
    li.append(text('span', v.icon, 'icon'), ' ', text('span', v.words, 'words'));
    return li;
  }));
}

function paint() {
  document.title = `SRE ${t('title')}`;
  for (const [id, k] of [['title-text', 'title'], ['page-h', 'title'], ['lead', 'lead'], ['release-label', 'releaseLabel'], ['show-text', 'show'], ['summary-h', 'summaryH'], ['gates-h', 'gatesH'], ['decide-h', 'decideH'], ['gate-label', 'gateLabel'], ['decision-label', 'decisionLabel'], ['evidence-label-label', 'evidenceLabelLabel'], ['evidence-ref-label', 'evidenceRefLabel'], ['reason-label', 'reasonLabel'], ['record-text', 'record']]) $(id).textContent = t(k);
  $('lang').textContent = t('lang');
  $('whoami').textContent = window.gatesData?.userId ?? '';
  $('nobody').hidden = may.named; $('nobody').textContent = t('nobody');
  $('show').disabled = !may.read;
  paintReleases();
  const shown = register !== null;
  $('summary-section').hidden = !shown;
  $('gates-section').hidden = !shown;
  $('decide-section').hidden = !shown;
  $('decide-form').hidden = !may.decide;
  $('decide-not').textContent = may.decide ? '' : t('decideNot');
  for (const [id, k] of [['outside-h', 'outsideH'], ['outside-lead', 'outsideLead'], ['outside-kind-label', 'outsideKindLabel'], ['outside-result-label', 'outsideResultLabel'], ['outside-ms-label', 'outsideMsLabel'], ['outside-on-label', 'outsideOnLabel'], ['outside-where-label', 'outsideWhereLabel'], ['outside-ref-label', 'outsideRefLabel'], ['outside-statement-label', 'outsideStatementLabel'], ['outside-record-text', 'outsideRecord']]) $(id).textContent = t(k);
  $('outside-section').hidden = !shown;
  $('outside-form').hidden = !may.decide;
  $('outside-not').textContent = may.decide ? '' : t('outsideNot');
  if (!shown) return;
  paintOutside();
  const s = register.summary;
  $('counts').replaceChildren(...[['undecidedK', s.undecided, 'undecided'], ['goK', s.go, 'GO'], ['holdK', s.hold, 'HOLD'], ['reworkK', s.rework, 'REWORK'], ['blockedK', s.goNowBlocked, 'GO_NOW_BLOCKED']].map(([k, n, st]) => {
    const box = document.createElement('div');
    box.dataset.count = st;
    box.append(text('span', `${api.stateView(lang, st).icon} ${t(k)}: `), text('span', String(n)));
    return box;
  }));
  $('gates').replaceChildren(...register.gates.map(gateRow));
}

async function show() {
  const release = $('release').value;
  const out = await session.read(release);
  if (out.result === 'ok') {
    register = out.value; $('page-status').className = 'status'; $('page-status').textContent = '';
    evidence = await session.readEvidence(); // OB-423: the QG-10 notes, read with the register (never on a timer)
    outside = await session.readOutside(); // W3: the outside evidence, read with the register
    qg01 = await session.readQg01(); // W7: the CI's QG-01 reading, read with the register
  } else { say('page-status', out); }
  paint();
}

async function record() {
  const choice = document.querySelector('input[name="decision"]:checked');
  const out = await session.decide({
    gate: $('decide-gate').value, release: $('release').value, decision: choice ? choice.value : '',
    evidenceLabel: $('evidence-label').value, evidenceRef: $('evidence-ref').value, rationale: $('rationale').value,
  });
  if (out.result !== 'ok') { say('decide-status', out); return; }
  $('decide-status').className = 'status good';
  $('decide-status').textContent = `✓ ${t('recorded')}`;
  await show();
}

async function recordOutside() {
  const out = await session.recordOutside({
    kind: $('outside-kind').value, result: $('outside-result').value, measuredMs: $('outside-ms').value, where: $('outside-where').value,
    reportRef: $('outside-ref').value, testedOn: $('outside-on').value, statement: $('outside-statement').value,
  });
  if (out.result !== 'ok') { say('outside-status', out); return; }
  $('outside-status').className = 'status good';
  $('outside-status').textContent = `✓ ${t('outsideRecorded')}`;
  await show();
}

$('show').addEventListener('click', () => { void show(); });
$('outside-record').addEventListener('click', () => { void recordOutside(); });
$('outside-kind').addEventListener('change', () => { if (register !== null) paintOutside(); });
$('record').addEventListener('click', () => { void record(); });
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
if (may.named && !may.read) { $('page-status').className = 'status err'; $('page-status').textContent = t('cannotRead'); }

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // No offline copy this time; the screen still works online.
  });
}
