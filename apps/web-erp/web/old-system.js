// Old system checks — the office page over head office's migration controls (W3 · MG-01 · MG-03 · MG-07 · MG-08 · MG-09 ·
// MG-11 · MG-12). The session (apps/web-erp/src/old-system-session.ts, in the bundle as window.oldSystem) asks head
// office; this page holds only what the person is typing (the source list, the mapping draft) and shows every answer in
// head office's words — each state an icon AND words. Nothing is read on open and nothing on a timer. Every word has a
// Tamil twin. No prompt, confirm or alert.

const $ = (id) => document.getElementById(id);
const api = window.oldSystem ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false };

let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
const sources = [];
const entries = [];
const seen = [];
let domains = [];
let exclusions = [];

function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
function item(tone, head, ...lines) {
  const li = document.createElement('li');
  li.className = `tone-${tone}`;
  li.append(text('div', head, 'verdict'), ...lines.filter((l) => l !== '').map((l) => text('div', l, 'facts')));
  return li;
}
function say(id, out) { $(id).className = 'status err'; $(id).textContent = api.outcomeWords(lang, out); }
function good(id, words) { $(id).className = 'status good'; $(id).textContent = `✓ ${words}`; }
function options(sel, values, wordOf) {
  const chosen = sel.value;
  sel.replaceChildren(text('option', ''), ...values.map((v) => { const o = text('option', wordOf(v)); o.value = v; return o; }));
  sel.firstChild.value = '';
  sel.value = chosen;
}

// ── painting ──────────────────────────────────────────────────────────────────────────────────────────────
function paintLists() {
  $('src-list').replaceChildren(...(sources.length === 0 ? [text('li', t('sourcesNone'), 'facts')] : sources.map((s) => {
    const li = item('idle', `${s.sourceId} · ${s.name}`, `${t(`k_${s.kind}`)} · ${s.ownerUserId ?? '—'} · ${s.rowCount ?? '—'} ${t(`b_${s.volumeBasis}`)} · ${s.retentionYears ?? '—'} · ${s.extractable ? '✓' : '✗'}`);
    li.dataset.source = s.sourceId;
    return li;
  })));
  $('map-list').replaceChildren(...(entries.length === 0 ? [text('li', t('entriesNone'), 'facts')] : entries.map((e) => item('idle', `${t(`d_${e.domain}`)}: ${e.legacyValue} → ${e.targetValue}`, e.rationale))));
  $('seen-list').replaceChildren(...(seen.length === 0 ? [text('li', t('seenNone'), 'facts')] : seen.map((o) => item('idle', `${t(`d_${o.domain}`)}: ${o.value}`, `${o.rows}`))));
}

function paintExclusions() {
  $('excl-list').replaceChildren(...(exclusions.length === 0 ? [text('li', t('exclNone'), 'facts')] : exclusions.map((x) => {
    const tone = x.status === 'approved' ? 'ok' : x.status === 'rejected' ? 'error' : 'degraded';
    const icon = x.status === 'approved' ? '✓' : x.status === 'rejected' ? '✗' : '⏸';
    const li = item(tone, `${icon} ${x.exclusionId} · ${t(`st_${x.status}`)}`,
      `${t(`s_${x.scope}`)} · ${x.description} · ${x.recordCount} · ${api.rupees(x.valueMinor)}`,
      `${t('proposedByK')}: ${x.proposedBy} — “${x.reason}”`,
      x.status === 'proposed' ? '' : `${t('decidedByK')}: ${x.approvedBy ?? ''} — “${x.ownerStatement ?? ''}”`);
    li.dataset.exclusion = x.exclusionId;
    li.dataset.status = x.status;
    return li;
  })));
  options($('excl-which'), exclusions.filter((x) => x.status === 'proposed').map((x) => x.exclusionId), (v) => v);
}

function paintDomains() {
  options($('diff-domain'), domains.map((d) => d.domain), (v) => domains.find((d) => d.domain === v)?.words[lang] ?? v);
  const spec = domains.find((d) => d.domain === $('diff-domain').value);
  const held = Object.fromEntries([...$('diff-columns').querySelectorAll('input')].map((i) => [i.dataset.field, i.value]));
  $('diff-columns').replaceChildren(...(spec?.fields ?? []).map((f) => {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'text'; input.autocomplete = 'off'; input.dataset.field = f.key; input.id = `diff-col-${f.key}`; input.value = held[f.key] ?? '';
    label.htmlFor = input.id;
    label.append(text('span', `${t('diffColumn')} ${f.words[lang]}${f.required ? ' *' : ''}`), input);
    return label;
  }));
}

function paint() {
  document.title = `SRE ${t('title')}`;
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  for (const [id, k] of [['disc-h', 'discH'], ['disc-lead', 'discLead'], ['map-h', 'mapH'], ['map-lead', 'mapLead'], ['excl-h', 'exclH'], ['excl-lead', 'exclLead'], ['diff-h', 'diffH'], ['diff-lead', 'diffLead'], ['night-h', 'nightH'], ['night-lead', 'nightLead'], ['retire-h', 'retireH'], ['retire-lead', 'retireLead']]) $(id).textContent = t(k);
  for (const n of document.querySelectorAll('[data-w]')) n.textContent = t(n.dataset.w);
  $('lang').textContent = t('lang');
  $('whoami').textContent = window.oldSystemData?.userId ?? '';
  $('nobody').hidden = may.named; $('nobody').textContent = t('nobody');
  options($('src-kind'), api?.sourceKinds ?? [], (v) => t(`k_${v}`));
  options($('src-basis'), api?.volumeBases ?? [], (v) => t(`b_${v}`));
  options($('map-domain'), api?.mappingDomains ?? [], (v) => t(`d_${v}`));
  options($('seen-domain'), api?.mappingDomains ?? [], (v) => t(`d_${v}`));
  options($('excl-scope'), api?.exclusionScopes ?? [], (v) => t(`s_${v}`));
  // Each section offers only what this person may do — head office re-checks every act.
  $('disc').hidden = !may.discover;
  $('map').hidden = !may.mapRead && !may.mapApprove;
  $('map-approve').hidden = !may.mapApprove;
  $('map-coverage').hidden = !may.mapRead;
  $('excl').hidden = !may.exclusionsRead;
  $('excl-propose').hidden = !may.propose;
  $('excl-decide').hidden = !may.decideExclusion;
  $('diff').hidden = !may.diffRead;
  $('diff-form').hidden = !may.diffRun;
  $('night').hidden = !may.windowRead;
  for (const id of ['night-check', 'reverse-ask', 'reverse-approve']) $(id).hidden = !may.cutoverDecide;
  $('retire').hidden = !may.retire;
  paintLists();
  paintExclusions();
  paintDomains();
}

// ── MG-01 ─────────────────────────────────────────────────────────────────────────────────────────────────
function addSource() {
  const s = api.readSource({ sourceId: $('src-id').value, name: $('src-name').value, kind: $('src-kind').value, ownerUserId: $('src-owner').value, rowCount: $('src-rows').value, volumeBasis: $('src-basis').value, retentionYears: $('src-retention').value, extractable: $('src-extract').checked });
  if ('result' in s) { say('disc-status', s); return; }
  if (sources.some((x) => x.sourceId === s.sourceId)) { say('disc-status', { result: 'invalid', why: 'sameSource' }); return; }
  sources.push(s);
  for (const id of ['src-id', 'src-name', 'src-owner', 'src-rows', 'src-retention']) $(id).value = '';
  $('disc-status').textContent = '';
  paintLists();
}
async function checkSources() {
  const out = await session.discover(sources);
  if (out.result !== 'ok') { say('disc-status', out); $('disc-result').replaceChildren(); return; }
  const r = out.value;
  $('disc-status').textContent = '';
  const head = item(r.complete ? 'ok' : 'error', r.complete ? `✓ ${t('discComplete')}` : `⚠ ${r.gaps.length} ${t('discGaps')}`, `${r.countedRows} ${t('countedRowsK')}`, r.detail);
  head.dataset.complete = String(r.complete);
  $('disc-result').replaceChildren(head, ...r.gaps.map((g) => { const li = item('error', `⚠ ${g.name}`, g.detail); li.dataset.gap = g.kind; li.dataset.source = g.sourceId; return li; }));
}

// ── MG-03 ─────────────────────────────────────────────────────────────────────────────────────────────────
function addEntry() {
  const e = api.readEntry({ domain: $('map-domain').value, legacyValue: $('map-old').value, targetValue: $('map-new').value, rationale: $('map-why').value });
  if ('result' in e) { say('map-status', e); return; }
  entries.push(e);
  for (const id of ['map-old', 'map-new', 'map-why']) $(id).value = '';
  $('map-status').textContent = '';
  paintLists();
}
function addSeen() {
  const o = api.readSeen({ domain: $('seen-domain').value, value: $('seen-value').value, rows: $('seen-rows').value });
  if ('result' in o) { say('map-status', o); return; }
  seen.push(o);
  for (const id of ['seen-value', 'seen-rows']) $(id).value = '';
  $('map-status').textContent = '';
  paintLists();
}
const draft = () => ({ mappingId: $('map-id').value, version: $('map-version').value, entries });
async function coverage() {
  const out = await session.coverage(seen);
  if (out.result !== 'ok') { say('map-status', out); return; }
  const r = out.value;
  $('map-status').textContent = '';
  const head = item(r.fullyCovered ? 'ok' : 'error', r.fullyCovered ? `✓ ${t('coverageFull')}` : `⚠ ${r.totalAffectedRows} ${t('coverageGaps')}`, r.detail);
  head.dataset.covered = String(r.fullyCovered);
  $('map-result').replaceChildren(head, ...r.byDomain.filter((d) => d.uncovered.length > 0).map((d) => { const li = item('error', `${t(`d_${d.domain}`)}: ${d.uncovered.join(', ')}`, `${d.affectedRows}`); li.dataset.uncovered = d.domain; return li; }));
}
async function approve() {
  const out = await session.approveMapping(draft());
  $('map-save').hidden = true;
  if (out.result !== 'ok') { say('map-status', out); return; }
  const tbl = out.value;
  good('map-status', t('recorded'));
  const li = item('ok', `✓ ${tbl.mappingId} v${tbl.version}`, `${t('approvedBy')}: ${tbl.approvedBy} · ${t('approvedAt')}: ${tbl.approvedAt}`);
  li.dataset.approved = 'true';
  $('map-result').replaceChildren(li);
  const file = api.approvedTableFile(tbl);
  $('map-save').href = file.href; $('map-save').download = file.name; $('map-save').textContent = t('saveTable'); $('map-save').hidden = false;
}

// ── MG-07 ─────────────────────────────────────────────────────────────────────────────────────────────────
async function showExclusions() {
  const out = await session.exclusions();
  if (out.result !== 'ok') { say('excl-status', out); return; }
  exclusions = out.value.exclusions;
  paintExclusions();
}
async function proposeExclusion() {
  const out = await session.proposeExclusion({ exclusionId: $('excl-id').value, scope: $('excl-scope').value, description: $('excl-desc').value, recordCount: $('excl-count').value, value: $('excl-value').value, reason: $('excl-reason').value });
  if (out.result !== 'ok') { say('excl-status', out); return; }
  good('excl-status', t('recorded'));
  await showExclusions();
}
async function decideExclusion() {
  const out = await session.decideExclusion($('excl-which').value, $('excl-choice').value, $('excl-statement').value);
  if (out.result !== 'ok') { say('excl-status', out); return; }
  good('excl-status', t('recorded'));
  await showExclusions();
}

// ── MG-09 ─────────────────────────────────────────────────────────────────────────────────────────────────
async function showDiffs() {
  const out = await session.exportDiffs();
  if (out.result !== 'ok') { say('diff-status', out); return; }
  domains = out.value.domains;
  $('diff-runs').replaceChildren(...(out.value.runs.length === 0 ? [text('li', t('diffsNone'), 'facts')] : out.value.runs.map((r) => {
    const open = r.undecided ?? 0;
    const li = item(open > 0 ? 'degraded' : 'ok', `${open > 0 ? '⏸' : '✓'} ${r.diffId} · ${domains.find((d) => d.domain === r.domain)?.words[lang] ?? r.domain}`,
      `${r.counts.added} ${t('addedK')} · ${r.counts.changed} ${t('changedK')} · ${r.counts.removed} ${t('removedK')} · ${r.counts.unchanged} ${t('unchangedK')} · ${open} ${t('undecidedK')}`,
      `${r.baselineLabel} → ${r.latestLabel} · ${r.by} · ${r.at}`);
    li.dataset.diff = r.diffId;
    return li;
  })));
  paintDomains();
}
const readFile = async (input) => { const f = input.files?.[0]; return f === undefined ? null : { csv: await f.text(), label: f.name }; };
async function runDiff() {
  const columns = Object.fromEntries([...$('diff-columns').querySelectorAll('input')].map((i) => [i.dataset.field, i.value]));
  const out = await session.runExportDiff({ diffId: $('diff-id').value, domain: $('diff-domain').value, columns, baseline: await readFile($('diff-baseline')), latest: await readFile($('diff-latest')) }, domains);
  if (out.result !== 'ok') { say('diff-status', out); return; }
  good('diff-status', out.value.detail ?? t('done'));
  await showDiffs();
}

// ── the night, the window and the reversal ────────────────────────────────────────────────────────────────
async function showWindow() {
  const out = await session.window($('cutover-id').value);
  if (out.result !== 'ok') { say('night-status', out); return; }
  const w = out.value;
  $('night-status').textContent = '';
  let li;
  if (w.window !== null) li = item(w.openNow ? 'ok' : 'idle', `${w.openNow ? '●' : '○'} ${t(w.openNow ? 'windowOpen' : 'windowClosed')}`, `${t('opensK')}: ${w.window.opensAt} · ${t('closesK')}: ${w.window.closesAt} · ${t('goByK')}: ${w.window.goBy}`);
  else if (w.theCutover !== undefined) li = item('error', `⚠ ${t('notTheCutover')} ${w.theCutover.cutoverId}`, `${t('opensK')}: ${w.theCutover.opensAt} · ${t('closesK')}: ${w.theCutover.closesAt}`);
  else li = item('idle', `○ ${t('noGo')}`);
  li.dataset.window = w.window === null ? (w.theCutover === undefined ? 'no_go' : 'not_the_cutover') : (w.openNow ? 'open' : 'closed');
  $('night-result').replaceChildren(li);
}
async function nightCheck() {
  const out = await session.nightCheck();
  if (out.result !== 'ok') { say('night-status', out); return; }
  const n = out.value;
  $('night-status').textContent = '';
  const head = item(n.rollBackNow ? 'error' : 'ok', n.rollBackNow ? `⚠ ${t('rollBackNow')}` : `✓ ${t('limitsHold')}`, n.detail);
  head.dataset.rollBack = String(n.rollBackNow);
  $('night-result').replaceChildren(head, ...n.crossed.map((c) => item('error', `⚠ ${c.detail}`)), ...n.notKnown.map((k) => { const li = item('idle', `○ ${t('notJudged')}: ${k}`); li.dataset.notKnown = 'true'; return li; }));
}
function paintReversal(r) {
  const head = item(r.reversedToZero ? 'ok' : 'degraded', r.reversedToZero ? `✓ ${t('reversedZero')}` : `⏸ ${t('notYetReversed')}`,
    `${r.request.loadId} · ${r.request.cutoverId} · ${t('requestedByK')}: ${r.request.requestedBy} — “${r.request.reason}”`,
    r.approval === null ? '' : `${t('approvedByK')}: ${r.approval.approvedBy} · ${r.approval.approvedAt}`);
  head.dataset.reversed = String(r.reversedToZero);
  head.dataset.approved = String(r.approval !== null);
  $('reverse-result').replaceChildren(head, ...r.position.map((l) => item(l.netMinor === 0 ? 'ok' : 'error', `${l.domain} · ${l.key}`, `${t('openedK')} ${l.openedMinor} · ${t('reversedK')} ${l.reversedMinor} · ${t('netK')} ${l.netMinor}`)));
}
async function showReversal() {
  const out = await session.reversal($('load-id').value);
  if (out.result !== 'ok') { say('night-status', out); $('reverse-result').replaceChildren(); return; }
  $('night-status').textContent = '';
  paintReversal(out.value);
}
async function askReversal() {
  const out = await session.askReversal($('load-id').value, $('cutover-id').value, $('reverse-reason').value);
  if (out.result !== 'ok') { say('night-status', out); return; }
  await showReversal();
  good('night-status', t('recorded'));
}
async function approveReversal() {
  const out = await session.approveReversal($('load-id').value);
  if (out.result !== 'ok') { say('night-status', out); return; }
  await showReversal();
  good('night-status', t('recorded'));
}

// ── MG-12 ─────────────────────────────────────────────────────────────────────────────────────────────────
async function assess() {
  const out = await session.assessRetirement({
    archiveId: $('ar-id').value, sourceId: $('ar-source').value, digest: $('ar-digest').value, rowCount: $('ar-rows').value, archivedOn: $('ar-on').value,
    retentionYears: $('ar-years').value, earliestRecordDate: $('ar-earliest').value, latestRecordDate: $('ar-latest').value, restoreVerifiedOn: $('ar-restore').value,
    cutoverAccepted: $('ar-accepted').checked, openAssessments: $('ar-open').value,
  });
  if (out.result !== 'ok') { say('retire-status', out); $('retire-result').replaceChildren(); return; }
  const r = out.value;
  $('retire-status').textContent = '';
  const head = item(r.mayRetireSystem ? 'ok' : 'error', r.mayRetireSystem ? `✓ ${t('mayRetire')}` : `⚠ ${t('mayNot')}`, `${t('keepUntil')} ${r.retentionEndsOn}`, r.detail);
  head.dataset.mayRetire = String(r.mayRetireSystem);
  $('retire-result').replaceChildren(head, ...r.blockedBy.map((b) => { const li = item('error', `⚠ ${t(`r_${b}`)}`); li.dataset.blocker = b; return li; }), item('ok', `✓ ${t('neverDeleted')}`));
}

// ── wiring ────────────────────────────────────────────────────────────────────────────────────────────────
const on = (id, fn) => $(id).addEventListener('click', () => { void fn(); });
on('src-add', addSource); on('src-check', checkSources);
on('map-add', addEntry); on('seen-add', addSeen); on('map-coverage', coverage); on('map-approve', approve);
on('excl-show', showExclusions); on('excl-propose-btn', proposeExclusion); on('excl-decide-btn', decideExclusion);
on('diff-show', showDiffs); on('diff-run', runDiff);
$('diff-domain').addEventListener('change', paintDomains);
on('window-show', showWindow); on('night-check', nightCheck); on('reverse-ask', askReversal); on('reverse-approve', approveReversal); on('reverse-show', showReversal);
on('ar-assess', assess);
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // No offline copy this time; the screen still works online.
  });
}
