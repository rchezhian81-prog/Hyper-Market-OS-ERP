// W5 — the sections this wave adds to existing office pages (platform, access, approvals and data import). Every rule lives in
// the TESTED sessions (apps/web-erp/src/w5-platform-session.ts, in the bundle as window.w5Platform). This file only draws
// whichever `[data-w5]` sections the page carries and passes each click through: a section asks its route's own permission
// before it offers anything (OB-572), reads only when the person presses "Show", writes only on an explicit button, and shows
// every refusal in head office's words. A secret's VALUE is never read or shown (hard rule 4). No prompt/confirm/alert.
// The words follow the page's one language toggle (the page sets <html lang>).

const w5 = window.w5Platform ?? null;
const S = w5?.sessions ?? {};
const H = w5?.helpers ?? null;
let lang = document.documentElement.lang === 'ta' ? 'ta' : 'en';
const w = (k) => (H === null ? k : H.w5Words(lang, k));
const when = (iso) => (typeof iso === 'string' ? window.sreShopDay?.dateTimeOf(iso) ?? iso : '');
const painters = [];

function el(tag, words, attrs) {
  const n = document.createElement(tag);
  if (words !== undefined && words !== null) n.textContent = words;
  for (const [k, v] of Object.entries(attrs ?? {})) { if (k === 'class') n.className = v; else n.setAttribute(k, v); }
  // Every control a section draws wears the foundation's class, so it is a 44px target with the one look (U0/U1 rules).
  if (tag === 'button') n.classList.add('sre-btn');
  else if (tag === 'select') n.classList.add('sre-select');
  else if (tag === 'textarea' || (tag === 'input' && !['checkbox', 'radio', 'hidden'].includes(n.getAttribute('type') ?? 'text'))) n.classList.add('sre-input');
  return n;
}
function input(id, attrs) { return el('input', null, { id, autocomplete: 'off', ...(attrs ?? {}) }); }
function select(id, options) { const s = el('select', null, { id }); for (const [v, words] of options) { const o = el('option', words); o.value = v; s.append(o); } return s; }
function labelled(words, control) {
  const l = el('label'); l.append(el('span', words), control);
  // a tick box's wrapping label is the target a thumb hits — 44px, the control beside its words
  if (control.getAttribute('type') === 'checkbox') { l.style.display = 'flex'; l.style.alignItems = 'center'; l.style.gap = '8px'; l.style.minHeight = 'var(--tap)'; }
  return l;
}
function button(id, words, onClick) { const b = el('button', words, { id, type: 'button' }); b.addEventListener('click', onClick); return b; }
function say(node, out, good) { node.textContent = H.w5OutcomeWords(lang, out, good); node.dataset.result = out.result; }
function lines(ul, items, line, attr) {
  ul.replaceChildren();
  if (items.length === 0) { ul.append(el('li', w('none'), { class: 'meta' })); return; }
  for (const it of items) { const li = el('li', line(it)); if (attr !== undefined) li.dataset.id = attr(it); ul.append(li); }
}
/** One section: its heading, lead, an optional form, a status line and what was read. `build` fills the rest. */
function section(root, key, build) {
  const status = el('p', null, { id: `w5-${key}-status`, class: 'status', role: 'status' });
  const paint = () => {
    root.replaceChildren();
    build(root, status);
    root.append(status);
  };
  painters.push(paint);
  paint();
}
const gateWords = (may) => (window.w5Platform === undefined ? '' : may ? '' : w('cannot'));

// ── Store computers — OB-87 · OB-54 ─────────────────────────────────────────────────────────────────────────────────────
function registers(root) {
  const s = S.registers; if (s === undefined) return;
  section(root, 'reg', (r, status) => {
    r.append(el('h2', w('regH'), { id: 'w5-reg-h' }), el('p', w('regLead'), { class: 'lede' }));
    if (!s.may.read) { status.textContent = gateWords(false); return; }
    const conflicts = el('ul', null, { id: 'w5-conflicts' }); const refusals = el('ul', null, { id: 'w5-refusals' });
    const overruled = el('ul', null, { id: 'w5-overruled' }); const stamps = el('ul', null, { id: 'w5-stamps' });
    r.append(button('w5-reg-show', w('show'), async () => {
      status.textContent = w('reading');
      const [c, f, st] = await Promise.all([s.conflicts(), s.refusals(), s.stamps()]);
      for (const out of [c, f, st]) if (out.result !== 'ok') { say(status, out, ''); return; }
      lines(conflicts, c.value, (x) => H.conflictLine(lang, x, when), (x) => x.conflictId);
      lines(refusals, f.value.refusals, (x) => H.refusalLine(lang, x, when), (x) => x.refusalId);
      lines(overruled, f.value.overruled, (x) => `${when(x.at)} · ${Object.entries(x).filter(([k]) => k !== 'at').map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ')}`);
      lines(stamps, st.value, (x) => H.stampLine(lang, x, when), (x) => x.stampId);
      status.textContent = '';
    }));
    r.append(el('h3', w('conflictsH')), conflicts, el('h3', w('refusalsH')), refusals, el('h3', w('overruledH')), overruled, el('h3', w('stampsH')), stamps);
  });
}

// ── Approvals — M02-FR-03 aged approvals ────────────────────────────────────────────────────────────────────────────────
function aged(root) {
  const s = S.aged; if (s === undefined) return;
  section(root, 'aged', (r, status) => {
    r.append(el('h2', w('agedH'), { id: 'w5-aged-h' }), el('p', w('agedLead'), { class: 'lede' }));
    if (!s.may.read) { status.textContent = gateWords(false); return; }
    const waiting = el('ul', null, { id: 'w5-aged-waiting' }); const escalated = el('ul', null, { id: 'w5-aged-escalated' });
    r.append(button('w5-aged-show', w('show'), async () => {
      status.textContent = w('reading');
      const out = await s.read();
      if (out.result !== 'ok') { say(status, out, ''); return; }
      lines(waiting, out.value.waiting, (x) => H.waitingLine(lang, x, when), (x) => x.requestId);
      lines(escalated, out.value.escalations, (x) => H.escalationLine(lang, x, when), (x) => x.requestId);
      status.textContent = '';
    }), el('h3', w('waitingH')), waiting, el('h3', w('escalatedH')), escalated);
  });
}

// ── Approval rules — M01-FR-03 history, preview, rollback ───────────────────────────────────────────────────────────────
function ruleHistory(root) {
  const s = S.ruleHistory; if (s === undefined) return;
  let picked = 'limits';
  section(root, 'hist', (r, status) => {
    r.append(el('h2', w('histH'), { id: 'w5-hist-h' }), el('p', w('histLead'), { class: 'lede' }));
    if (!s.may.read) { status.textContent = gateWords(false); return; }
    const rule = select('w5-hist-rule', H.RULES.map((x) => [x, w(`r_${x}`)])); rule.value = picked;
    rule.addEventListener('change', () => { picked = rule.value; });
    const versions = el('ul', null, { id: 'w5-hist-versions' }); const preview = el('ul', null, { id: 'w5-hist-preview' });
    const reason = input('w5-hist-reason');
    const asked = el('ul', null, { id: 'w5-hist-asked' });
    const showAsked = async () => {
      if (!s.may.propose) return;
      const out = await s.asked();
      if (out.result !== 'ok') { say(status, out, ''); return; }
      asked.replaceChildren();
      if (out.value.length === 0) asked.append(el('li', w('none'), { class: 'meta' }));
      for (const a of out.value) {
        const li = el('li', `${w(`r_${a.rule}`)} · ${w('toVersion')} ${a.toVersion} · ${w(`st_${a.status}`)}${a.decidedBy === undefined ? '' : ` · ${a.decidedBy}`} · ${a.reason}`);
        li.dataset.request = a.requestId;
        if (a.status === 'approved') li.append(button(`w5-hist-apply-${a.requestId}`, w('applyBack'), async () => { const o = await s.apply(a); if (o.result === 'ok') await show(); say(status, o, w('appliedBack')); }));
        asked.append(li);
      }
    };
    const show = async () => {
      status.textContent = w('reading');
      const out = await s.history(picked);
      if (out.result !== 'ok') { say(status, out, ''); return; }
      const h = out.value;
      versions.replaceChildren(el('li', `${w('inForce')} ${h.inForce.version}`, { class: 'meta' }));
      if (h.versions.length === 0) versions.append(el('li', w('noVersions'), { class: 'meta' }));
      for (const v of h.versions) {
        const li = el('li', H.versionLine(lang, v, when)); li.dataset.version = String(v.version);
        if (v.version !== h.inForce.version) {
          li.append(button(`w5-hist-preview-${v.version}`, w('preview'), async () => { const p = await s.preview(picked, v); if (p.result !== 'ok') { say(status, p, ''); return; } lines(preview, H.previewLines(lang, p.value), (x) => x); }));
          if (s.may.propose) li.append(button(`w5-hist-ask-${v.version}`, w('askBack'), async () => { const o = await s.askRollback(picked, v.version, h.inForce.version, reason.value); say(status, o, w('askedBack')); if (o.result === 'ok') { reason.value = ''; await showAsked(); } }));
        }
        versions.append(li);
      }
      status.textContent = '';
      await showAsked();
    };
    r.append(labelled(w('ruleL'), rule), button('w5-hist-show', w('show'), show), versions, preview);
    if (s.may.propose) r.append(labelled(w('reason'), reason), el('h3', w('askedBackH')), asked);
  });
}

// ── Delegation — M02-FR-03 effective authority ──────────────────────────────────────────────────────────────────────────
function effective(root) {
  const s = S.effective; if (s === undefined) return;
  section(root, 'eff', (r, status) => {
    r.append(el('h2', w('effH'), { id: 'w5-eff-h' }), el('p', w('effLead'), { class: 'lede' }));
    if (!s.may.read) { status.textContent = gateWords(false); return; }
    const who = input('w5-eff-who'); const kind = select('w5-eff-kind', H.DECISION_KINDS.map((k) => [k, w(`k_${k}`)])); const on = input('w5-eff-on', { placeholder: 'YYYY-MM-DD' });
    const answer = el('p', null, { id: 'w5-eff-answer' });
    r.append(labelled(w('whoL'), who), labelled(w('kindL'), kind), labelled(w('onL'), on), button('w5-eff-ask', w('ask'), async () => {
      const out = await s.ask(who.value, kind.value, on.value);
      if (out.result !== 'ok') { answer.textContent = ''; say(status, out, ''); return; }
      status.textContent = ''; answer.textContent = H.effectiveLine(lang, out.value); answer.dataset.source = out.value.source;
    }), answer);
  });
}

// ── Users — OB-165/167 committee changes · SEC-11 token revocation ──────────────────────────────────────────────────────
function committee(root) {
  const s = S.committee; if (s === undefined) return;
  section(root, 'ic', (r, status) => {
    r.append(el('h2', w('icH'), { id: 'w5-ic-h' }), el('p', w('icLead'), { class: 'lede' }));
    if (!s.may.manage) { status.textContent = gateWords(false); return; }
    const who = input('w5-ic-who'); const action = select('w5-ic-action', [['add', w('icAdd')], ['remove', w('icRemove')]]); const reason = input('w5-ic-reason');
    const asked = el('ul', null, { id: 'w5-ic-asked' });
    const showAsked = async () => {
      const out = await s.asked();
      if (out.result !== 'ok') { say(status, out, ''); return; }
      asked.replaceChildren();
      if (out.value.length === 0) asked.append(el('li', w('none'), { class: 'meta' }));
      for (const a of out.value) {
        const li = el('li', `${a.action === 'add' ? w('icAdd') : w('icRemove')}: ${a.userId} · ${w(`st_${a.status}`)}${a.decidedBy === undefined ? '' : ` · ${a.decidedBy}`} · ${a.reason}`);
        li.dataset.request = a.requestId;
        if (a.status === 'approved') li.append(button(`w5-ic-apply-${a.requestId}`, w('icApply'), async () => {
          const o = await s.apply(a);
          say(status, o, o.result === 'ok' && o.value.alreadyMember === true ? w('icAlready') : o.result === 'ok' && o.value.notAMember === true ? w('icNotMember') : w('icApplied'));
          if (o.result === 'ok') await showAsked();
        }));
        asked.append(li);
      }
    };
    r.append(labelled(w('icWho'), who), labelled(w('icAction'), action), labelled(w('reason'), reason), button('w5-ic-ask', w('icAsk'), async () => {
      const o = await s.ask(action.value, who.value, reason.value); say(status, o, w('icAsked'));
      if (o.result === 'ok') { who.value = ''; reason.value = ''; await showAsked(); }
    }), el('h3', w('icAskedH')), button('w5-ic-show', w('show'), showAsked), asked);
  });
}
// OB-681 · OB-143: the chartered accountant's role — the owner asks, the IT custodian approves, the owner applies.
function caGrant(root) {
  const s = S.caGrant; if (s === undefined) return;
  section(root, 'ca', (r, status) => {
    r.append(el('h2', w('caH'), { id: 'w5-ca-h' }), el('p', w('caLead'), { class: 'lede' }));
    if (!s.may.ask) { status.textContent = gateWords(false); return; }
    const who = input('w5-ca-who'); const reason = input('w5-ca-reason'); const asked = el('ul', null, { id: 'w5-ca-asked' });
    const showAsked = async () => {
      const out = await s.asked();
      if (out.result !== 'ok') { say(status, out, ''); return; }
      asked.replaceChildren();
      if (out.value.length === 0) asked.append(el('li', w('none'), { class: 'meta' }));
      for (const a of out.value) {
        const li = el('li', `${a.userId} · ${w(`st_${a.status}`)}${a.decidedBy === undefined ? '' : ` · ${a.decidedBy}`} · ${a.reason}`);
        li.dataset.request = a.requestId;
        if (a.status === 'approved') li.append(button(`w5-ca-apply-${a.requestId}`, w('caApply'), async () => {
          const o = await s.apply(a);
          if (o.result === 'ok') await showAsked();
          say(status, o, o.result === 'ok' && o.value.alreadyHeld === true ? w('caAlready') : w('caApplied'));
        }));
        asked.append(li);
      }
    };
    r.append(labelled(w('caWho'), who), labelled(w('reason'), reason), button('w5-ca-ask', w('caAsk'), async () => {
      const o = await s.ask(who.value, reason.value);
      if (o.result === 'ok') { who.value = ''; reason.value = ''; await showAsked(); }
      say(status, o, w('caAsked'));
    }), el('h3', w('caAskedH')), button('w5-ca-show', w('show'), showAsked), asked);
  });
}
function revocations(root) {
  const s = S.revocations; if (s === undefined) return;
  section(root, 'rev', (r, status) => {
    r.append(el('h2', w('revH'), { id: 'w5-rev-h' }), el('p', w('revLead'), { class: 'lede' }));
    if (!s.may.revoke) { status.textContent = gateWords(false); return; }
    const target = select('w5-rev-target', [['user', w('revUser')], ['token', w('revToken')]]); const id = input('w5-rev-id');
    const why = select('w5-rev-why', H.REVOCATION_REASONS.map((x) => [x, w(`rr_${x}`)]));
    const list = el('ul', null, { id: 'w5-rev-list' });
    const show = async () => { const out = await s.list(); if (out.result !== 'ok') { say(status, out, ''); return; } lines(list, out.value, (x) => H.revocationLine(lang, x, when), (x) => x.id); };
    r.append(labelled(w('revTarget'), target), labelled(w('revId'), id), labelled(w('revWhy'), why), button('w5-rev-go', w('revGo'), async () => {
      const o = await s.revoke(target.value, id.value, why.value); say(status, o, w('revDone'));
      if (o.result === 'ok') { id.value = ''; await show(); }
    }), el('h3', w('revListH')), button('w5-rev-show', w('show'), show), list);
  });
}

// ── Store devices — M33-FR-02 remote sessions, version policy, remote kill ─────────────────────────────────────────────
function fleetControl(root) {
  const s = S.fleetControl; if (s === undefined) return;
  let policy = null;
  section(root, 'fc', (r, status) => {
    r.append(el('h2', w('rsH'), { id: 'w5-rs-h' }), el('p', w('rsLead'), { class: 'lede' }));
    if (!s.may.read) { status.textContent = gateWords(false); return; }
    const sessions = el('ul', null, { id: 'w5-rs-list' });
    const vp = el('ul', null, { id: 'w5-vp-now' });
    const show = async () => {
      status.textContent = w('reading');
      const [a, b] = await Promise.all([s.sessions(), s.policy()]);
      if (a.result !== 'ok') { say(status, a, ''); return; }
      if (b.result !== 'ok') { say(status, b, ''); return; }
      policy = b.value;
      sessions.replaceChildren();
      if (a.value.length === 0) sessions.append(el('li', w('none'), { class: 'meta' }));
      for (const x of a.value) {
        const li = el('li', H.remoteLine(lang, x, when)); li.dataset.session = x.sessionId;
        if (x.active && s.may.manage) {
          const why = input(`w5-rs-why-${x.sessionId}`, { placeholder: w('rsEndWhy'), 'aria-label': w('rsEndWhy') });
          li.append(why, button(`w5-rs-end-${x.sessionId}`, w('rsEnd'), async () => { const o = await s.terminate(x.sessionId, why.value); if (o.result === 'ok') await show(); say(status, o, w('rsEndedOk')); }));
        }
        sessions.append(li);
      }
      lines(vp, H.policyLines(lang, policy), (x) => x);
      status.textContent = '';
    };
    r.append(button('w5-fc-show', w('show'), show), sessions, el('h2', w('vpH'), { id: 'w5-vp-h' }), el('p', w('vpLead'), { class: 'lede' }), vp);
    if (!s.may.manage) return;
    const cur = input('w5-vp-current'); const prev = input('w5-vp-previous'); const min = input('w5-vp-minimum');
    r.append(labelled(w('vpCurrent'), cur), labelled(w('vpPrevious'), prev), labelled(w('vpMinimum'), min), button('w5-vp-set', w('vpSet'), async () => {
      const o = await s.setPolicy({ current: cur.value, previous: prev.value, minimum: min.value }, policy); if (o.result === 'ok') await show();
      say(status, o, w('vpSaved'));
    }));
    const kv = input('w5-kill-version'); const ok = el('input', null, { id: 'w5-kill-confirm', type: 'checkbox' });
    r.append(el('h2', w('killH'), { id: 'w5-kill-h' }), el('p', w('killLead'), { class: 'lede' }), labelled(w('killVersion'), kv), labelled(w('killConfirm'), ok), button('w5-kill-go', w('killGo'), async () => {
      const o = await s.kill(kv.value, ok.checked); if (o.result === 'ok') { kv.value = ''; ok.checked = false; await show(); }
      say(status, o, w('killDone'));
    }));
  });
}

// ── Roll-out — M33-FR-04 licences ───────────────────────────────────────────────────────────────────────────────────────
function licences(root) {
  const s = S.licences; if (s === undefined) return;
  section(root, 'lic', (r, status) => {
    r.append(el('h2', w('licH'), { id: 'w5-lic-h' }), el('p', w('licLead'), { class: 'lede' }));
    if (!s.may.read) { status.textContent = gateWords(false); return; }
    const alerts = el('ul', null, { id: 'w5-lic-alerts' }); const list = el('ul', null, { id: 'w5-lic-list' });
    const show = async () => {
      status.textContent = w('reading');
      const [a, l] = await Promise.all([s.alerts(), s.list()]);
      for (const out of [a, l]) if (out.result !== 'ok') { say(status, out, ''); return; }
      alerts.replaceChildren();
      if (a.value.length === 0) alerts.append(el('li', w('licNoAlerts'), { class: 'meta' }));
      for (const x of a.value) { const li = el('li', x.message, { class: x.level === 'expired' || x.level === 'critical' ? 'attention' : '' }); li.dataset.module = x.moduleId; li.dataset.level = x.level; alerts.append(li); }
      lines(list, l.value, (x) => H.licenceLine(lang, x), (x) => x.moduleId);
      status.textContent = '';
    };
    r.append(button('w5-lic-show', w('show'), show), el('h3', w('licAlertsH')), alerts, list);
    if (!s.may.manage) return;
    const f = { moduleId: input('w5-lic-module'), name: input('w5-lic-name'), expiresOn: input('w5-lic-expires', { placeholder: 'YYYY-MM-DD' }), ownerUserId: input('w5-lic-owner-id'), ownerName: input('w5-lic-owner-name') };
    const on = el('input', null, { id: 'w5-lic-enabled', type: 'checkbox' }); on.checked = true;
    r.append(labelled(w('licModule'), f.moduleId), labelled(w('licName'), f.name), labelled(w('licEnabled'), on), labelled(w('licExpires'), f.expiresOn), labelled(w('licOwnerId'), f.ownerUserId), labelled(w('licOwnerName'), f.ownerName),
      button('w5-lic-save', w('licSave'), async () => {
        const o = await s.record({ moduleId: f.moduleId.value, name: f.name.value, enabled: on.checked, expiresOn: f.expiresOn.value, ownerUserId: f.ownerUserId.value, ownerName: f.ownerName.value });
        if (o.result === 'ok') await show();
        say(status, o, w('licSaved'));
      }));
  });
}

// ── Integration health — M32-FR-03 secrets (which exist, age, rotation state; NEVER a value) ──────────────────────────
function secrets(root) {
  const s = S.secrets; if (s === undefined) return;
  section(root, 'sec', (r, status) => {
    r.append(el('h2', w('secH'), { id: 'w5-sec-h' }), el('p', w('secLead'), { class: 'lede' }));
    if (!s.may.read) { status.textContent = gateWords(false); return; }
    const list = el('ul', null, { id: 'w5-sec-list' }); const found = el('ul', null, { id: 'w5-sec-review' });
    // W6 · M32-FR-03 · OB-688: each machine credential's use over the last 30 days, and what the nightly check found.
    const uses = el('ul', null, { id: 'w5-sec-use' }); const checked = el('p', null, { id: 'w5-sec-checked', class: 'meta' });
    const unusual = el('ul', null, { id: 'w5-sec-unusual' });
    r.append(button('w5-sec-show', w('show'), async () => {
      status.textContent = w('reading');
      const [out, use] = await Promise.all([s.inventory(), s.usage()]);
      if (out.result !== 'ok') { say(status, out, ''); return; }
      if (use.result !== 'ok') { say(status, use, ''); return; }
      lines(list, out.value, (x) => `${H.secretLine(lang, x)} · ${H.secretUseOf(lang, x.secretId, use.value.uses)}`, (x) => x.secretId);
      uses.replaceChildren();
      if (use.value.uses.length === 0) uses.append(el('li', w('secUseNone'), { class: 'meta' }));
      for (const u of use.value.uses) { const li = el('li', H.secretUseLine(lang, u)); li.dataset.ref = u.credentialRef; li.dataset.caller = u.callerId; uses.append(li); }
      checked.textContent = use.value.lastRolledUpDay === null ? w('secNotChecked') : `${w('secChecked')}: ${use.value.lastRolledUpDay}${use.value.notJudged.length === 0 ? '' : ` · ${w('secNotJudged')}: ${use.value.notJudged.join(', ')}`}`;
      unusual.replaceChildren();
      if (use.value.findings.length === 0) unusual.append(el('li', w('secUnusualNone'), { class: 'meta' }));
      for (const f of use.value.findings) { const li = el('li', H.secretUseFindingLine(lang, f), { class: 'attention' }); li.dataset.signal = f.signal; unusual.append(li); }
      status.textContent = '';
    }), list, el('h3', w('secUseH'), { id: 'w5-sec-use-h' }), el('p', w('secUseLead'), { class: 'lede' }), uses, checked, el('h3', w('secUnusualH')), el('p', w('secRule'), { class: 'lede', id: 'w5-sec-rule' }), unusual, button('w5-sec-review-go', w('secReview'), async () => {
      const out = await s.review(); if (out.result !== 'ok') { say(status, out, ''); return; }
      found.replaceChildren(el('li', out.value.issues.length === 0 ? w('secClean') : out.value.detail, { class: 'meta' }));
      for (const i of out.value.issues) { const li = el('li', `${i.blocking ? w('secBlocking') : w('secAttention')} · ${i.secretId} — ${i.detail}`, { class: i.blocking ? 'attention' : '' }); li.dataset.finding = i.finding; found.append(li); }
    }), el('h3', w('secReviewH')), found);
  });
}

// ── Incidents — M35-FR-04 link an alert · M33-FR-04 service requests ───────────────────────────────────────────────────
function incidentAlert(root) {
  const s = S.incidentAlert; if (s === undefined) return;
  section(root, 'link', (r, status) => {
    r.append(el('h2', w('linkH'), { id: 'w5-link-h' }), el('p', w('linkLead'), { class: 'lede' }));
    if (!s.may.manage) { status.textContent = gateWords(false); return; }
    const inc = select('w5-link-incident', []); const al = select('w5-link-alert', []);
    r.append(button('w5-link-show', w('show'), async () => {
      const out = await s.choices(); if (out.result !== 'ok') { say(status, out, ''); return; }
      inc.replaceChildren(...out.value.incidents.map((i) => { const o = el('option', `${i.title} (${i.incidentId}) · ${i.alertIds.length}`); o.value = i.incidentId; return o; }));
      al.replaceChildren(...out.value.alerts.map((a) => { const o = el('option', `${a.component} · ${a.status} · ${a.alertId}`); o.value = a.alertId; return o; }));
      status.textContent = out.value.incidents.length === 0 ? w('noOpen') : out.value.alerts.length === 0 ? w('noAlerts') : '';
    }), labelled(w('linkIncident'), inc), labelled(w('linkAlert'), al), button('w5-link-go', w('linkGo'), async () => {
      const o = await s.link(inc.value, al.value);
      say(status, o, o.result === 'ok' && o.value.alreadyLinked === true ? w('alreadyLinked') : w('linked'));
    }));
  });
}
function serviceRequests(root) {
  const s = S.serviceRequests; if (s === undefined) return;
  section(root, 'sr', (r, status) => {
    r.append(el('h2', w('srH'), { id: 'w5-sr-h' }), el('p', w('srLead'), { class: 'lede' }));
    if (!s.may.read) { status.textContent = gateWords(false); return; }
    const list = el('ul', null, { id: 'w5-sr-list' }); const count = el('p', null, { id: 'w5-sr-count', class: 'meta' });
    const show = async () => {
      const out = await s.list(); if (out.result !== 'ok') { say(status, out, ''); return; }
      count.textContent = `${out.value.open} ${w('srOpenCount')}`;
      list.replaceChildren();
      if (out.value.requests.length === 0) list.append(el('li', w('none'), { class: 'meta' }));
      for (const x of out.value.requests) {
        const li = el('li', H.serviceRequestLine(lang, x, when)); li.dataset.request = x.requestId; li.dataset.title = x.title;
        if (s.may.manage && x.status !== 'closed') {
          const to = input(`w5-sr-to-${x.requestId}`, { 'aria-label': w('srAssignTo'), placeholder: w('srAssignTo') });
          const st = select(`w5-sr-status-${x.requestId}`, H.SR_STATUSES.map((k) => [k, w(`s_${k}`)])); st.value = x.status;
          const note = input(`w5-sr-note-${x.requestId}`, { 'aria-label': w('srNote'), placeholder: w('srNote') });
          li.append(to, button(`w5-sr-assign-${x.requestId}`, w('srAssign'), async () => { const o = await s.assign(x.requestId, to.value); say(status, o, w('srAssigned')); if (o.result === 'ok') await show(); }),
            st, note, button(`w5-sr-move-${x.requestId}`, w('srMove'), async () => { const o = await s.move(x.requestId, st.value, note.value); say(status, o, w('srMoved')); if (o.result === 'ok') await show(); }));
        }
        list.append(li);
      }
    };
    r.append(button('w5-sr-show', w('show'), show), count, list);
    if (!s.may.manage) return;
    const title = input('w5-sr-title'); const detail = input('w5-sr-detail'); const cat = input('w5-sr-category');
    const pr = select('w5-sr-priority', H.SR_PRIORITIES.map((k) => [k, w(`p_${k}`)])); pr.value = 'normal';
    r.append(labelled(w('srTitle'), title), labelled(w('srDetail'), detail), labelled(w('srCategory'), cat), labelled(w('srPriority'), pr), button('w5-sr-raise', w('srRaise'), async () => {
      const o = await s.raise({ title: title.value, detail: detail.value, category: cat.value, priority: pr.value }); say(status, o, w('srRaised'));
      if (o.result === 'ok') { title.value = ''; detail.value = ''; cat.value = ''; await show(); }
    }));
  });
}

// ── Administration — M33-FR-03 support-access review ────────────────────────────────────────────────────────────────────
function supportReview(root) {
  const s = S.supportReview; if (s === undefined) return;
  section(root, 'sup', (r, status) => {
    r.append(el('h2', w('supH'), { id: 'w5-sup-h' }), el('p', w('supLead'), { class: 'lede' }));
    if (!s.may.read) { status.textContent = gateWords(false); return; }
    const list = el('ul', null, { id: 'w5-sup-list' });
    r.append(button('w5-sup-show', w('show'), async () => {
      const out = await s.review(); if (out.result !== 'ok') { say(status, out, ''); return; }
      lines(list, out.value, (x) => H.supportReviewLine(lang, x, when), (x) => x.sessionId); status.textContent = '';
    }), list);
  });
}

// ── Document templates — PA-09 audited reprint ─────────────────────────────────────────────────────────────────────────
function reprint(root) {
  const s = S.reprint; if (s === undefined) return;
  section(root, 'doc', (r, status) => {
    r.append(el('h2', w('docH'), { id: 'w5-doc-h' }), el('p', w('docLead'), { class: 'lede' }));
    if (!s.may.read) { status.textContent = gateWords(false); return; }
    const id = input('w5-doc-id'); const about = el('p', null, { id: 'w5-doc-about' }); const body = el('pre', null, { id: 'w5-doc-content' });
    const why = input('w5-doc-why'); const marking = el('p', null, { id: 'w5-doc-marking' });
    let found = null;
    const find = async () => {
      const out = await s.find(id.value); if (out.result !== 'ok') { found = null; about.textContent = ''; body.textContent = ''; say(status, out, ''); return; }
      found = out.value; about.textContent = H.documentLine(lang, found, when); body.textContent = found.content; status.textContent = '';
    };
    r.append(labelled(w('docId'), id), button('w5-doc-find', w('docFind'), find), about, body);
    if (!s.may.reprint) return;
    r.append(labelled(w('docWhy'), why), button('w5-doc-reprint', w('docReprint'), async () => {
      if (found === null) { status.textContent = w('needAll'); return; }
      const o = await s.reprint(found.documentId, why.value); if (o.result === 'ok') { why.value = ''; await find(); marking.textContent = o.value.marking; body.textContent = o.value.content; }
      say(status, o, w('docReprinted'));
    }), marking);
  });
}

// ── Owner alerts — M29-FR-04 schedule runs · Compare stores — M29-FR-02 drill audits ───────────────────────────────────
function scheduleRuns(root) {
  const s = S.scheduleRuns; if (s === undefined) return;
  section(root, 'runs', (r, status) => {
    r.append(el('h2', w('runsH'), { id: 'w5-runs-h' }), el('p', w('runsLead'), { class: 'lede' }));
    if (!s.may.read) { status.textContent = gateWords(false); return; }
    const pick = select('w5-runs-schedule', []); const list = el('ul', null, { id: 'w5-runs-list' });
    r.append(button('w5-runs-load', w('show'), async () => {
      const out = await s.schedules(); if (out.result !== 'ok') { say(status, out, ''); return; }
      pick.replaceChildren(...out.value.map((id) => { const o = el('option', id); o.value = id; return o; }));
      status.textContent = out.value.length === 0 ? w('runsNone') : '';
    }), labelled(w('runsSchedule'), pick), button('w5-runs-show', w('showAgain'), async () => {
      if (pick.value === '') { status.textContent = w('runsNone'); return; }
      const out = await s.runs(pick.value); if (out.result !== 'ok') { say(status, out, ''); return; }
      list.replaceChildren();
      if (out.value.length === 0) list.append(el('li', w('runsNoRuns'), { class: 'meta' }));
      for (const x of out.value) { const li = el('li', H.scheduleRunLine(lang, x, when)); li.dataset.day = x.tradingDay; list.append(li); }
      status.textContent = '';
    }), list);
  });
}
function drillAudits(root) {
  const s = S.drillAudits; if (s === undefined) return;
  section(root, 'drill', (r, status) => {
    r.append(el('h2', w('drillH'), { id: 'w5-drill-h' }), el('p', w('drillLead'), { class: 'lede' }));
    if (!s.may.read) { status.textContent = gateWords(false); return; }
    const list = el('ul', null, { id: 'w5-drill-list' });
    r.append(button('w5-drill-show', w('show'), async () => {
      const out = await s.read(); if (out.result !== 'ok') { say(status, out, ''); return; }
      lines(list, out.value, (x) => H.drillAuditLine(lang, x, when)); status.textContent = '';
    }), list);
  });
}

// ── Cash office — OB-82 legacy till placement ───────────────────────────────────────────────────────────────────────────
function legacy(root) {
  const s = S.legacy; if (s === undefined) return;
  section(root, 'leg', (r, status) => {
    r.append(el('h2', w('legH'), { id: 'w5-leg-h' }), el('p', w('legLead'), { class: 'lede' }));
    if (!s.may.read) { status.textContent = gateWords(false); return; }
    const till = input('w5-leg-till'); const store = input('w5-leg-store'); const why = input('w5-leg-why'); const answer = el('p', null, { id: 'w5-leg-answer' });
    const look = async () => { const out = await s.look(till.value, store.value); if (out.result !== 'ok') { answer.textContent = ''; say(status, out, ''); return; } answer.textContent = H.legacyLine(lang, out.value, when); status.textContent = ''; };
    r.append(labelled(w('legTill'), till), labelled(w('legStore'), store), button('w5-leg-look', w('legLook'), look), answer);
    if (!s.may.place) return;
    r.append(labelled(w('legWhy'), why), button('w5-leg-place', w('legPlace'), async () => {
      const o = await s.place(till.value, store.value, why.value); if (o.result === 'ok') { why.value = ''; await look(); }
      say(status, o, w('legDone'));
    }));
  });
}

// ── Data in and out — OB-315 dry runs · M30-FR-04 import quality ───────────────────────────────────────────────────────
function importChecks(root) {
  const s = S.importChecks; if (s === undefined) return;
  section(root, 'dry', (r, status) => {
    r.append(el('h2', w('dryH'), { id: 'w5-dry-h' }), el('p', w('dryLead'), { class: 'lede' }));
    if (!s.may.read) { status.textContent = gateWords(false); return; }
    const tpl = select('w5-dry-template', []); const file = el('textarea', null, { id: 'w5-dry-file', rows: '4' }); const total = input('w5-dry-total', { inputmode: 'numeric' });
    const kept = el('ul', null, { id: 'w5-dry-list' });
    const showKept = async () => { const out = await s.dryRuns(); if (out.result !== 'ok') { say(status, out, ''); return; } lines(kept, out.value, (x) => H.dryRunLine(lang, x, when), (x) => x.runId); };
    r.append(button('w5-dry-load', w('show'), async () => {
      const out = await s.templates(); if (out.result !== 'ok') { say(status, out, ''); return; }
      tpl.replaceChildren(...out.value.map((t) => { const o = el('option', t.label ?? t.id); o.value = t.id; return o; }));
      status.textContent = ''; await showKept();
    }), labelled(w('dryTemplate'), tpl), labelled(w('dryFile'), file), labelled(w('dryTotal'), total), button('w5-dry-keep', w('dryKeep'), async () => {
      const o = await s.keep(tpl.value, file.value, total.value); say(status, o, w('dryKept'));
      if (o.result === 'ok') await showKept();
    }), el('h3', w('dryListH')), kept);
    // M30-FR-04: data quality per source, and every job (refusals included).
    const sources = el('ul', null, { id: 'w5-qual-list' }); const talk = el('p', null, { id: 'w5-qual-talk', class: 'meta' }); const jobs = el('ul', null, { id: 'w5-qual-jobs' });
    r.append(el('h2', w('qualH'), { id: 'w5-qual-h' }), el('p', w('qualLead'), { class: 'lede' }), button('w5-qual-show', w('show'), async () => {
      const [q, j] = await Promise.all([s.quality(), s.jobs()]);
      for (const out of [q, j]) if (out.result !== 'ok') { say(status, out, ''); return; }
      talk.textContent = `${w('qualTalk')}: ${q.value.worthAConversation.length === 0 ? '—' : q.value.worthAConversation.join(', ')} · ${q.value.detail}`;
      lines(sources, q.value.sources, (x) => H.qualityLine(lang, x), (x) => x.sourceId);
      lines(jobs, j.value, (x) => H.jobLine(lang, x, when), (x) => x.jobId);
      status.textContent = '';
    }), talk, sources, el('h3', w('qualJobsH')), jobs);
  });
}

const BUILDERS = { registers, aged, ruleHistory, effective, committee, caGrant, revocations, fleetControl, licences, secrets, incidentAlert, serviceRequests, supportReview, reprint, scheduleRuns, drillAudits, legacy, importChecks };
if (H !== null) {
  for (const root of document.querySelectorAll('[data-w5]')) { const b = BUILDERS[root.dataset.w5]; if (b !== undefined) b(root); }
  // The page's one language toggle sets <html lang>; every section repaints in it.
  new MutationObserver(() => { const next = document.documentElement.lang === 'ta' ? 'ta' : 'en'; if (next !== lang) { lang = next; for (const p of painters) p(); } })
    .observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
}
