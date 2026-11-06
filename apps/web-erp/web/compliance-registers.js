// Licences, controls and findings (W5 · M34-FR-03 · M34-FR-04 · OB-331) — the page over head office's compliance registers.
// The session (apps/web-erp/src/compliance-registers-session.ts, in the bundle as window.complianceRegisters) does every
// call and every rule; this page lays out what it is told. It reads as it opens; every record is an explicit press, offered
// only to a person who may. Every word this page adds has a Tamil twin; head office's own sentences (a refusal) stay in
// English (OB-553). Nothing here deletes anything.

const $ = (id) => document.getElementById(id);
const api = window.complianceRegisters ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
const when = (iso) => (api === null || iso === '' || iso === undefined ? (iso ?? '') : api.moment(iso));
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
function option(value, words) { const o = document.createElement('option'); o.value = value; o.textContent = words; return o; }
function fill(sel, options) { const was = sel.value; sel.replaceChildren(...options.map(([v, w]) => option(v, w))); if (options.some(([v]) => v === was)) sel.value = was; }
const say = (id, out, okWords) => { $(id).textContent = out.result === 'ok' ? okWords : api.outcomeWords(lang, out); };

let lic = null; let ctl = null; let fnd = null;

// ── Licences and certificates ─────────────────────────────────────────────────────────────────────────────────────────
function paintLicences() {
  for (const id of ['lic-alerts', 'lic-gaps', 'lic-list']) $(id).replaceChildren();
  if (lic === null) return;
  $('lic-alerts').append(...(lic.alerts.length === 0 ? [text('li', t('noAlerts'), 'meta')] : lic.alerts.map((a) => {
    const li = document.createElement('li'); li.dataset.alert = a.obligationId; li.dataset.level = a.level;
    li.className = a.level === 'expired' || a.level === 'urgent' ? 'tone-error' : 'tone-degraded';
    const days = a.daysRemaining < 0 ? `${-a.daysRemaining} ${t('expiredAgo')}` : `${a.daysRemaining} ${t('daysLeft')}`;
    li.append(text('h4', `${t(`level_${a.level}`)} — ${a.name}`), text('p', `${t('expires')} ${a.expiresOn} · ${days}`, 'meta'),
      text('p', `${t('who')}: ${a.responsible.name} (${a.responsible.userId})${a.escalatedToUserId === undefined ? '' : ` · ${t('escalated')}: ${a.escalatedToUserId}`}`, 'meta'));
    if (a.evidenceMissing) li.append(text('p', t('noEvidence'), 'meta'));
    return li;
  })));
  const byId = new Map(lic.obligations.map((o) => [o.obligationId, o]));
  $('lic-gaps').append(...(lic.gaps.length === 0 ? [text('li', t('noGaps'), 'meta')] : lic.gaps.map((id) => {
    const li = text('li', `⚠ ${byId.get(id)?.name ?? id}`, 'tone-degraded'); li.dataset.gap = id; return li;
  })));
  $('lic-list').append(...(lic.obligations.length === 0 ? [text('li', t('noObligations'), 'meta')] : lic.obligations.map((o) => {
    const li = document.createElement('li'); li.dataset.obligation = o.obligationId; li.dataset.status = o.status;
    li.className = o.status === 'closed' ? '' : o.evidence.length === 0 ? 'tone-degraded' : 'tone-ok';
    li.append(text('h4', `${o.name} · ${t(`kind_${o.kind}`)} · ${o.status === 'closed' ? t('closed') : t('active')}`),
      text('p', `${t('authority')}: ${o.authority}${o.reference === undefined ? '' : ` · ${t('reference')}: ${o.reference}`} · ${o.validFrom} → ${o.expiresOn ?? t('noExpiry')}${o.branchId === null ? '' : ` · ${o.branchId}`}`, 'meta'),
      text('p', `${t('who')}: ${o.responsible.name} (${o.responsible.userId})`, 'meta'));
    if (o.status === 'closed') li.append(text('p', `${t('reason')}: ${o.closedReason ?? ''} · ${when(o.closedAt)}`, 'meta'));
    if (o.evidence.length === 0) li.append(text('p', t('noEvidence'), 'meta'));
    else { const ul = document.createElement('ul'); ul.className = 'sub'; ul.append(...o.evidence.map((e) => text('li', `${t('evidence')}: ${e.evidenceId} — ${e.description} · ${when(e.recordedAt)}`))); li.append(ul); }
    return li;
  })));
  const active = lic.obligations.filter((o) => o.status !== 'closed');
  fill($('lic-which'), [['', t('newOne')], ...lic.obligations.map((o) => [o.obligationId, o.name])]);
  fill($('ev-which'), active.map((o) => [o.obligationId, o.name]));
  fill($('cl-which'), active.map((o) => [o.obligationId, o.name]));
}

async function loadLicences() {
  const out = await session.licences();
  lic = out.result === 'ok' ? out.value : null;
  if (out.result !== 'ok') $('lic-status').textContent = api.outcomeWords(lang, out);
  paintLicences();
}

function prefillLicence() {
  const o = lic?.obligations.find((x) => x.obligationId === $('lic-which').value);
  if (o === undefined) return;
  $('lic-kind').value = o.kind; $('lic-name').value = o.name; $('lic-authority').value = o.authority; $('lic-reference').value = o.reference ?? '';
  $('lic-from').value = o.validFrom; $('lic-expires').value = o.expiresOn ?? ''; $('lic-branch').value = o.branchId ?? '';
  $('lic-person').value = o.responsible.userId; $('lic-person-name').value = o.responsible.name; $('lic-escalate').value = o.responsible.escalatesToUserId ?? '';
}

// ── Controls and their checks ─────────────────────────────────────────────────────────────────────────────────────────
function paintControls() {
  $('ctl-list').replaceChildren(); $('ctl-overdue').replaceChildren();
  if (ctl === null) return;
  const health = new Map(ctl.health.map((h) => [h.controlId, h]));
  const late = new Set(ctl.overdue);
  const remRow = (r) => {
    const li = text('li', `${r.action} · ${t('owner')} ${r.ownerUserId} · ${r.completedAt === undefined ? `${t('due')} ${r.dueOn}${late.has(r.remediationId) ? ` · ${t('late')}` : ''}` : `${t('done')} ${when(r.completedAt)}`}`);
    li.dataset.remediation = r.remediationId;
    if (r.completedAt === undefined && may.write_controls) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'quiet sre-btn sre-btn-quiet'; b.textContent = t('doneGo');
      b.addEventListener('click', async () => { b.disabled = true; const out = await session.markDone(r); say('ctl-status', out, t('remediationDone')); if (out.result === 'ok') await loadControls(); else b.disabled = false; });
      li.append(' ', b);
    }
    return li;
  };
  $('ctl-list').append(...(ctl.controls.length === 0 ? [text('li', t('noControls'), 'meta')] : ctl.controls.map((c) => {
    const h = health.get(c.controlId);
    const li = document.createElement('li'); li.dataset.control = c.controlId;
    li.className = h === undefined || h.lastAttestedAt === undefined || h.overdueRemediations > 0 ? 'tone-degraded' : 'tone-ok';
    li.append(text('h4', c.title), text('p', `${t('implementsL')}: ${c.implements} · ${t('owner')}: ${c.ownerUserId}`, 'meta'),
      text('p', `${h?.incidentCount ?? 0} ${t('incidents')} · ${h?.overdueRemediations ?? 0} ${t('overdueCount')} · ${h?.lastAttestedAt === undefined ? t('neverChecked') : `${t('lastChecked')} ${when(h.lastAttestedAt)}`}`, 'meta'));
    const sub = document.createElement('ul'); sub.className = 'sub';
    for (const i of ctl.incidents.filter((x) => x.controlId === c.controlId)) {
      const ii = text('li', `⚠ ${i.title} · ${t(i.severity)} · ${when(i.occurredAt)}`); ii.dataset.incident = i.incidentId; sub.append(ii);
      for (const r of ctl.remediations.filter((x) => x.incidentId === i.incidentId)) sub.append(remRow(r));
    }
    for (const a of ctl.attestations.filter((x) => x.controlId === c.controlId)) {
      const ai = text('li', `✓ ${a.statement} · ${t('checkedBy')} ${a.attestedBy} · ${when(a.attestedAt)}`); ai.dataset.attestation = a.attestationId; sub.append(ai);
    }
    if (sub.childElementCount > 0) li.append(sub);
    return li;
  })));
  const overdue = ctl.remediations.filter((r) => late.has(r.remediationId));
  $('ctl-overdue').append(...(overdue.length === 0 ? [text('li', t('noOverdue'), 'meta')] : overdue.map((r) => { const li = remRow(r); li.className = 'tone-error'; return li; })));
  const controls = ctl.controls.map((c) => [c.controlId, c.title]);
  fill($('ctl-which'), [['', t('newOne')], ...controls]);
  fill($('inc-ctl'), controls); fill($('att-ctl'), controls);
  fill($('rem-inc'), ctl.incidents.map((i) => [i.incidentId, i.title]));
}

async function loadControls() {
  const out = await session.controls();
  ctl = out.result === 'ok' ? out.value : null;
  if (out.result !== 'ok') $('ctl-status').textContent = api.outcomeWords(lang, out);
  paintControls();
}

function prefillControl() {
  const c = ctl?.controls.find((x) => x.controlId === $('ctl-which').value);
  if (c === undefined) return;
  $('ctl-title').value = c.title; $('ctl-impl').value = c.implements; $('ctl-owner').value = c.ownerUserId;
}

// ── Findings people raise ─────────────────────────────────────────────────────────────────────────────────────────────
function paintFindings() {
  $('fnd-list').replaceChildren();
  if (fnd === null) return;
  $('fnd-list').append(...(fnd.findings.length === 0 ? [text('li', t('noFindings'), 'meta')] : fnd.findings.map((f) => {
    const li = document.createElement('li'); li.dataset.finding = f.findingId; li.dataset.status = f.status;
    li.className = f.status === 'fixed' ? 'tone-ok' : f.overdue || f.severity === 'critical' || f.severity === 'high' ? 'tone-error' : 'tone-degraded';
    const from = f.byPerson ? t(`source_${f.source}`) : `${t('scanner')} (${f.source})`;
    li.append(text('h4', `${f.status === 'fixed' ? '✓' : '⚠'} ${t(`severity_${f.severity}`)} · ${f.title}`),
      text('p', `${from} · ${t('where')}: ${f.location} · ${f.status === 'fixed' ? t('fixed') : t('open')}${f.overdue ? ` · ${t('overdue')}` : ''}${f.fixDueBy === undefined ? '' : ` · ${t('fixBy')} ${when(f.fixDueBy)}`}`, 'meta'),
      text('p', `${t('owner')}: ${f.ownerUserId ?? t('noOwner')}`, 'meta'));
    if (f.status === 'fixed' && f.fixedBy !== undefined) li.append(text('p', `${t('fixedBy')} ${f.fixedBy}: ${f.fixedEvidence ?? ''}`, 'meta'));
    if (f.status === 'open' && may.write_findings) {
      const status = text('p', '', 'status'); status.setAttribute('role', 'status');
      const acts = document.createElement('div'); acts.className = 'acts';
      const ownerIn = document.createElement('input'); ownerIn.setAttribute('aria-label', t('nameOwner')); ownerIn.placeholder = t('nameOwner'); ownerIn.className = 'owner-in';
      const ownerGo = document.createElement('button'); ownerGo.type = 'button'; ownerGo.className = 'quiet owner-go sre-btn sre-btn-quiet'; ownerGo.textContent = t('ownerGo');
      ownerGo.addEventListener('click', async () => { ownerGo.disabled = true; const out = await session.nameOwner(f.findingId, ownerIn.value); say('fnd-status', out, t('ownerNamed')); status.textContent = out.result === 'ok' ? '' : api.outcomeWords(lang, out); if (out.result === 'ok') await loadFindings(); else ownerGo.disabled = false; });
      acts.append(ownerIn, ownerGo);
      if (f.byPerson) {
        const fixIn = document.createElement('input'); fixIn.setAttribute('aria-label', t('fixEvidence')); fixIn.placeholder = t('fixEvidence'); fixIn.className = 'fix-in';
        const fixGo = document.createElement('button'); fixGo.type = 'button'; fixGo.className = 'fix-go sre-btn'; fixGo.textContent = t('fixGo');
        fixGo.addEventListener('click', async () => { fixGo.disabled = true; const out = await session.markFixed(f.findingId, fixIn.value); say('fnd-status', out, t('findingFixed')); status.textContent = out.result === 'ok' ? '' : api.outcomeWords(lang, out); if (out.result === 'ok') await loadFindings(); else fixGo.disabled = false; });
        acts.append(fixIn, fixGo);
      }
      li.append(acts, status);
    }
    return li;
  })));
}

async function loadFindings() {
  const out = await session.findings();
  fnd = out.result === 'ok' ? out.value : null;
  if (out.result !== 'ok') $('fnd-status').textContent = api.outcomeWords(lang, out);
  paintFindings();
}

// ── The frame ─────────────────────────────────────────────────────────────────────────────────────────────────────────
function paint() {
  document.title = `SRE ${t('title')}`;
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  for (const n of document.querySelectorAll('[data-w]')) n.textContent = t(n.dataset.w);
  if (api !== null) {
    fill($('lic-kind'), api.kinds.map((k) => [k, t(`kind_${k}`)]));
    fill($('inc-sev'), api.incidentSeverities.map((s) => [s, t(s)]));
    fill($('fnd-source'), api.findingSources.map((s) => [s, t(`source_${s}`)]));
    fill($('fnd-sev'), api.findingSeverities.map((s) => [s, t(`severity_${s}`)]));
  }
  paintLicences(); paintControls(); paintFindings();
}

function on(form, run) {
  $(form).addEventListener('submit', (e) => { e.preventDefault(); void run(); });
}

$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
if (!may.named) $('page-status').textContent = t('nobody');
else if (!may.read_licences && !may.read_controls && !may.read_findings) $('page-status').textContent = t('cannotRead');
else {
  if (may.read_licences) {
    $('lic-s').hidden = false;
    for (const id of ['lic-form', 'ev-form', 'cl-form']) $(id).hidden = !may.write_licences;
    if (!may.write_licences) $('lic-status').textContent = t('cannotWrite');
    $('lic-which').addEventListener('change', prefillLicence);
    on('lic-form', async () => {
      const out = await session.register({
        obligationId: $('lic-which').value, kind: $('lic-kind').value, name: $('lic-name').value, authority: $('lic-authority').value, reference: $('lic-reference').value,
        validFrom: $('lic-from').value, expiresOn: $('lic-expires').value, branchId: $('lic-branch').value,
        personId: $('lic-person').value, personName: $('lic-person-name').value, escalatesTo: $('lic-escalate').value,
      });
      say('lic-status', out, t('registered'));
      if (out.result === 'ok') { $('lic-form').reset(); await loadLicences(); }
    });
    on('ev-form', async () => {
      const out = await session.fileEvidence($('ev-which').value, $('ev-ref').value, $('ev-what').value);
      say('lic-status', out, out.result === 'ok' && out.value.alreadyOnFile ? t('alreadyFiled') : t('filed'));
      if (out.result === 'ok') { $('ev-ref').value = ''; $('ev-what').value = ''; await loadLicences(); }
    });
    on('cl-form', async () => {
      const out = await session.close($('cl-which').value, $('cl-why').value);
      say('lic-status', out, t('closedDone'));
      if (out.result === 'ok') { $('cl-why').value = ''; await loadLicences(); }
    });
    void loadLicences();
  }
  if (may.read_controls) {
    $('ctl-s').hidden = false;
    for (const id of ['ctl-form', 'inc-form', 'rem-form', 'att-form']) $(id).hidden = !may.write_controls;
    if (!may.write_controls) $('ctl-status').textContent = t('cannotWrite');
    $('ctl-which').addEventListener('change', prefillControl);
    on('ctl-form', async () => {
      const out = await session.saveControl({ controlId: $('ctl-which').value, title: $('ctl-title').value, implements: $('ctl-impl').value, ownerUserId: $('ctl-owner').value });
      say('ctl-status', out, t('controlSaved'));
      if (out.result === 'ok') { $('ctl-form').reset(); await loadControls(); }
    });
    on('inc-form', async () => {
      const out = await session.recordIncident({ title: $('inc-title').value, severity: $('inc-sev').value, occurredAt: $('inc-occ').value, detectedAt: $('inc-det').value, controlId: $('inc-ctl').value });
      say('ctl-status', out, t('incidentSaved'));
      if (out.result === 'ok') { $('inc-title').value = ''; await loadControls(); }
    });
    on('rem-form', async () => {
      const out = await session.planRemediation({ incidentId: $('rem-inc').value, action: $('rem-action').value, ownerUserId: $('rem-owner').value, dueOn: $('rem-due').value });
      say('ctl-status', out, t('remediationSaved'));
      if (out.result === 'ok') { $('rem-action').value = ''; await loadControls(); }
    });
    on('att-form', async () => {
      const out = await session.attest($('att-ctl').value, $('att-stmt').value);
      say('ctl-status', out, t('attested'));
      if (out.result === 'ok') { $('att-stmt').value = ''; await loadControls(); }
    });
    void loadControls();
  }
  if (may.read_findings) {
    $('fnd-s').hidden = false;
    $('fnd-form').hidden = !may.write_findings;
    if (!may.write_findings) $('fnd-status').textContent = t('cannotWrite');
    on('fnd-form', async () => {
      const out = await session.raiseFinding({ source: $('fnd-source').value, severity: $('fnd-sev').value, title: $('fnd-title').value, location: $('fnd-loc').value, ownerUserId: $('fnd-owner').value });
      say('fnd-status', out, t('findingSaved'));
      if (out.result === 'ok') { $('fnd-form').reset(); paint(); await loadFindings(); }
    });
    void loadFindings();
  }
}
