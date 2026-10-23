// Quality gates — the page over head office's gate register (QG-12 · roadmap §22 · §36 · OB-288 gates lane). The session
// (apps/web-erp/src/gates-session.ts, in the bundle as window.gates) asks head office; this page shows every gate's
// standing for the release the person chooses, each with an icon AND words, and records the owner's decision on an
// explicit click. A gate nobody decided says "Not decided — silence is not approval". Every word has a Tamil twin.

const $ = (id) => document.getElementById(id);
const api = window.gates ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, decide: false };

let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
let register = null;

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
  return li;
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
  if (!shown) return;
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
  if (out.result === 'ok') { register = out.value; $('page-status').className = 'status'; $('page-status').textContent = ''; } else { say('page-status', out); }
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

$('show').addEventListener('click', () => { void show(); });
$('record').addEventListener('click', () => { void record(); });
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
if (may.named && !may.read) { $('page-status').className = 'status err'; $('page-status').textContent = t('cannotRead'); }

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // No offline copy this time; the screen still works online.
  });
}
