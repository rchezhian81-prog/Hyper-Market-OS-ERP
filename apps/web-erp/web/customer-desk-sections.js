// W5 (customers, privacy, service desk and online orders) — the sections this wave adds to twelve office pages, over
// head-office routes no screen called before. A page names the sections it carries with `<section data-desk="…" hidden>`;
// this script fills each one. The session (apps/web-erp/src/customer-desk-sections-session.ts, in the bundle as
// window.customerDesk) does every call and every rule; this lays out what head office answered. Nothing is read or written
// on open — every read and every write is an explicit press. A section is offered only to a person whose role head office
// would answer for it. Every word has a Tamil twin and follows the page's one language toggle (<html lang>).

const api = window.customerDesk ?? null;
const s = api?.session ?? null;
const lang = () => (document.documentElement.lang === 'ta' ? 'ta' : 'en');
const t = (k) => (api === null ? k : api.words(lang(), k));
const say = (out) => api.outcomeWords(lang(), out);
const when = (iso) => (typeof iso === 'string' && iso !== '' ? api.moment(iso) : '');

const words = []; // [node, key] — repainted on a language switch
const repaints = []; // a section's results, repainted on a language switch
function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) { if (k === 'key') { words.push([n, v]); n.textContent = t(v); } else if (k === 'text') n.textContent = v; else n.setAttribute(k, v); }
  // Every control a section draws wears the foundation's class, so it is a 44px target with the one look (U0/U1 rules).
  if (tag === 'button') n.classList.add('sre-btn', ...(n.classList.contains('quiet') ? ['sre-btn-quiet'] : []));
  else if (tag === 'select') n.classList.add('sre-select');
  else if (tag === 'textarea' || (tag === 'input' && !['checkbox', 'radio', 'hidden'].includes(n.getAttribute('type') ?? 'text'))) n.classList.add('sre-input');
  n.append(...kids);
  return n;
}
function field(id, key, attrs) {
  const input = el(attrs?.tag ?? 'input', { id, autocomplete: 'off', ...(attrs?.type ? { type: attrs.type } : {}) });
  return { label: el('label', { for: id }, el('span', { key }), input), input };
}
function choose(id, key, options) {
  const sel = el('select', { id });
  for (const [value, k] of options) sel.append(el('option', { value, key: k }));
  return { label: el('label', { for: id }, el('span', { key }), sel), input: sel };
}
// U7 · the shared parts (UI/UX audit G6): "Reading…", a refusal and an empty list are the chrome's state part.
const office = () => (window.sreOffice && typeof window.sreOffice.state === 'function' ? window.sreOffice : null);
/** A status line that keeps what it said as a key or an outcome, so it is said again in the other language. */
function statusLine(id) {
  const p = el('div', { id, class: 'status', role: 'status', 'aria-live': 'polite' });
  let said = null;
  const set = (v) => {
    said = v;
    const o = office();
    if (v === null) { p.replaceChildren(); return; }
    if (o !== null && v === 'reading') { o.state(p, 'loading', { title: t('reading'), detail: '' }); return; }
    if (o !== null && typeof v !== 'string' && v.result !== 'ok') { o.state(p, o.stateOf(v), { title: say(v), detail: '' }); return; }
    p.textContent = typeof v === 'string' ? t(v) : say(v);
  };
  repaints.push(() => set(said));
  return { node: p, set };
}
function form(id, kids, submitKey, onSubmit) {
  const f = el('form', { id, class: 'row-form' }, ...kids, el('button', { type: 'submit', id: `${id}-go`, key: submitKey }));
  f.addEventListener('submit', (e) => { e.preventDefault(); void onSubmit(); });
  return f;
}
const li = (text, data) => { const n = el('li', { text }); for (const [k, v] of Object.entries(data ?? {})) n.dataset[k] = v; return n; };
const listOf = (id, rows, emptyKey) => {
  const ul = el('ul', { id, class: 'rows' });
  if (rows.length > 0) { ul.append(...rows); return ul; }
  const item = el('li', { class: 'cd-none' });
  const o = office();
  if (o !== null) o.state(item, 'empty', { title: t(emptyKey), detail: '' }); else item.textContent = t(emptyKey);
  ul.append(item);
  return ul;
};
/** One result area: `paint(value)` draws it now and again after a language switch. */
function resultArea(id, draw) {
  const box = el('div', { id });
  let last = null;
  const paint = (v) => { last = v; box.replaceChildren(...(v === null ? [] : draw(v))); };
  repaints.push(() => { if (last !== null) paint(last); });
  return { node: box, paint };
}
/** Read or write, and say what happened: on success `then(value)`, else the refusal in words. */
async function act(status, run, then, goodKey) {
  status.set('reading');
  const out = await run();
  if (out.result !== 'ok') { status.set(out); return out; }
  status.set(goodKey ?? null);
  then?.(out.value);
  return out;
}
function head(sec, key, leadKey) { sec.append(el('h3', { id: `${sec.id}-h`, key }), el('p', { class: 'meta', key: leadKey })); sec.setAttribute('aria-labelledby', `${sec.id}-h`); }

// ── the sections ──────────────────────────────────────────────────────────────────────────────────────────────────────
const SECTIONS = {
  // Customers — who looked at a record (M16-FR-04 · P-04).
  views: { may: 'views', build(sec) {
    head(sec, 'viewsH', 'viewsLead');
    const c = field('cd-views-customer', 'customer'); const st = statusLine('cd-views-status');
    const out = resultArea('cd-views-out', (v) => [el('p', { class: 'meta', text: `${v.count} ${t('views')}` }),
      listOf('cd-views-list', v.views.map((x) => li(`${x.viewedBy} — ${when(x.at)}`, { by: x.viewedBy })), 'noViews')]);
    sec.append(form('cd-views-form', [c.label], 'viewsShow', () => act(st, () => s.profileViews(c.input.value), out.paint)), st.node, out.node);
  } },

  // Data requests — the customer's nominee, and staff recording that the death or incapacity was checked (C5).
  nominee: { may: 'privacy', build(sec) {
    head(sec, 'nomineeH', 'nomineeLead');
    const c = field('cd-nominee-customer', 'customer'); const st = statusLine('cd-nominee-status');
    let ref = '';
    const out = resultArea('cd-nominee-out', (v) => {
      const parts = [el('p', { id: 'cd-nominee-current', text: v.current === null ? t('noNominee') : `${t('nomineeIs')}: ${v.current.nomineeRef} (${t('relationship')}: ${v.current.relationship})` })];
      parts.push(el('h4', { key: 'history' }), listOf('cd-nominee-history', v.history.map((r) => li(`${t(r.action) || r.action}${r.nomineeRef ? ` — ${r.nomineeRef} (${r.relationship})` : ''} · ${when(r.at)}`, { action: r.action })), 'none'));
      parts.push(el('h4', { key: 'verifications' }), listOf('cd-nominee-verified', v.activations.map((a) => li(`${a.nomineeRef} — ${t(`basis_${a.basis}`)} · ${a.evidenceRef} · ${t('by')} ${a.verifiedBy} · ${when(a.verifiedAt)}`, { nominee: a.nomineeRef })), 'none'));
      if (v.current !== null) {
        const basis = choose('cd-nominee-basis', 'basis', api.bases.map((b) => [b, `basis_${b}`]));
        const ev = field('cd-nominee-evidence', 'evidence'); const st2 = statusLine('cd-nominee-act-status');
        const nominee = v.current.nomineeRef;
        parts.push(form('cd-nominee-act', [basis.label, ev.label], 'activate', () => act(st2, () => s.activateNominee(ref, { nomineeRef: nominee, basis: basis.input.value, evidenceRef: ev.input.value }), () => void show(), 'activated')), st2.node);
      }
      return parts;
    });
    const show = () => act(st, () => s.nomination(c.input.value), (v) => { ref = v.customerRef; out.paint(v); });
    sec.append(form('cd-nominee-form', [c.label], 'nomineeShow', show), st.node, out.node);
  } },

  // Data requests — the sealed record of each finished erasure (M20-FR-04 · hard rule #6).
  sealed: { may: 'privacy', build(sec) {
    head(sec, 'sealedH', 'sealedLead');
    const st = statusLine('cd-sealed-status');
    const out = resultArea('cd-sealed-out', (rows) => [listOf('cd-sealed-list', rows.map((r) => {
      const row = li(`${r.customerRef} · ${r.requestId}`, { request: r.requestId });
      const b = el('button', { type: 'button', class: 'quiet show-sealed', key: 'sealedOne' }); const st2 = statusLine(`cd-sealed-${r.requestId}-status`);
      const box = el('div', { class: 'sealed' });
      b.addEventListener('click', () => void act(st2, () => s.tombstone(r.requestId), (v) => box.replaceChildren(
        el('p', { class: 'meta', text: `${t('erasedAt')} ${when(v.erasedAt)} · ${t('checker')} ${v.checker} · ${t('maker')} ${v.maker}` }),
        el('p', { text: `${t('erased')}: ${v.categoriesErased.join(', ') || '—'}` }),
        el('p', { text: `${t('minimised')}: ${v.categoriesMinimised.join(', ') || '—'}` }),
        el('p', { class: 'kept', text: `${t('kept')}: ${v.categoriesRetained.map((k) => `${k.category}${k.retentionBasis ? ` (${k.retentionBasis}${k.retainUntil ? `, ${k.retainUntil}` : ''})` : ''}`).join(', ') || '—'}` }),
        el('p', { class: 'meta', text: v.complete ? t('complete') : t('partial') }),
      )));
      row.append(b, st2.node, box);
      return row;
    }), 'noErasures')]);
    const b = el('button', { type: 'button', id: 'cd-sealed-go', key: 'sealedShow' });
    b.addEventListener('click', () => void act(st, () => s.finishedErasures(), out.paint));
    sec.append(b, st.node, out.node);
  } },

  // Data requests — the processor-contract register and head office's check of it (M01-FR-02).
  processors: { may: 'privacy', build(sec) {
    head(sec, 'procH', 'procLead');
    const st = statusLine('cd-proc-status');
    const out = resultArea('cd-proc-out', (v) => [
      el('p', { id: 'cd-proc-check', class: 'meta', text: v.check.compliant ? t('procOk') : v.check.detail }),
      ...(v.check.findings.length === 0 ? [] : [el('h4', { key: 'procFindings' }), listOf('cd-proc-findings', v.check.findings.map((f) => li(f.detail, { flag: f.flag })), 'none')]),
      el('h4', { key: 'procEntries' }),
      listOf('cd-proc-list', v.register.map((e) => li(`${e.vendorName} (${e.vendorId}) — ${e.dataCategories.join(', ')} · ${e.purpose} · ${e.contractRef} · ${e.contractFrom} → ${e.contractUntil ?? t('openEnded')}`, { vendor: e.vendorId })), 'none'),
    ]);
    const read = () => act(st, () => s.processors(), out.paint);
    const b = el('button', { type: 'button', id: 'cd-proc-go', key: 'procShow' }); b.addEventListener('click', () => void read());
    const f = Object.fromEntries([['vendorId', 'vendorId'], ['vendorName', 'vendorName'], ['categories', 'categories'], ['purpose', 'purpose'], ['contractRef', 'contractRef']].map(([k, key]) => [k, field(`cd-proc-${k}`, key)]));
    f.contractFrom = field('cd-proc-contractFrom', 'contractFrom', { type: 'date' }); f.contractUntil = field('cd-proc-contractUntil', 'contractUntil', { type: 'date' });
    const st2 = statusLine('cd-proc-record-status');
    sec.append(b, st.node, out.node, form('cd-proc-form', Object.values(f).map((x) => x.label), 'procRecord',
      () => act(st2, () => s.recordProcessor(Object.fromEntries(Object.entries(f).map(([k, x]) => [k, x.input.value]))), () => void read(), 'procRecorded')), st2.node);
  } },

  // Incidents — a personal-data breach: what must be told, to whom, by when (C2 · DPDP s.8(6)). It drafts; a person sends.
  breach: { may: 'breach', build(sec) {
    head(sec, 'breachH', 'breachLead');
    const spec = [['breachId', 'breachRef'], ['discovered', 'discovered', 'datetime-local'], ['categories', 'affectedCats'], ['count', 'affectedCount', 'number'],
      ['description', 'description'], ['likelyConsequences', 'consequences'], ['mitigationMeasures', 'mitigation'], ['remedialMeasures', 'remedial'],
      ['safetyMeasuresForPrincipals', 'safety'], ['contactPoint', 'contact'], ['boardIntimatedAt', 'boardTold', 'datetime-local'],
      ['boardReportFiledAt', 'reportFiled', 'datetime-local'], ['principalsNotifiedAt', 'peopleTold', 'datetime-local']];
    const f = Object.fromEntries(spec.map(([k, key, type]) => [k, field(`cd-breach-${k}`, key, type ? { type } : undefined)]));
    const st = statusLine('cd-breach-status');
    const out = resultArea('cd-breach-out', (v) => [
      el('p', { id: 'cd-breach-deadline', text: `${t('deadline')}: ${when(v.reportDeadline)}` }),
      listOf('cd-breach-obligations', v.obligations.map((o) => li(`${t(`ob_${o.obligation}`)} — ${t(`st_${o.status}`)} · ${o.due === 'immediately' ? t('immediately') : when(o.due)}${o.missingContent.length === 0 ? '' : ` · ${t('missing')}: ${o.missingContent.join(', ')}`}`, { obligation: o.obligation, status: o.status })), 'none'),
      el('p', { class: 'meta', text: v.allSatisfied ? t('allDone') : t('adviceOnly') }),
    ]);
    sec.append(form('cd-breach-form', Object.values(f).map((x) => x.label), 'breachCheck', () => act(st, () => s.assessBreach(Object.fromEntries(Object.entries(f).map(([k, x]) => [k, x.input.value]))), out.paint)), st.node, out.node);
  } },

  // Loyalty — a member leaves the programme at the desk (M16-FR-02).
  leave: { may: 'leave', build(sec) {
    head(sec, 'leaveH', 'leaveLead');
    const m = field('cd-leave-member', 'member'); const r = field('cd-leave-reason', 'reason'); const st = statusLine('cd-leave-status');
    sec.append(form('cd-leave-form', [m.label, r.label], 'leave', async () => {
      st.set('reading');
      const out = await s.leave(m.input.value, r.input.value);
      st.set(out.result !== 'ok' ? out : out.value.alreadyLeft ? 'alreadyLeft' : 'left');
    }), st.node);
  } },

  // Loyalty — W6 (M17-FR-02 · OB-221 · OB-356): a referral reward the shop owes, paid out (how, and the receipt or transfer
  // number) or let lapse (why) by a person holding loyalty.referral.settle. Head office refuses one with nothing owed.
  owed: { may: 'referral', build(sec) {
    head(sec, 'owedH', 'owedLead');
    const st = statusLine('cd-owed-status');
    const out = resultArea('cd-owed-out', (rows) => [listOf('cd-owed-list', rows.map((r) => {
      const who = r.side === null ? '' : ` · ${r.customerRef ?? ''} ${t(`side_${r.side}`)}`;
      const row = li(`${r.referralId}${who} — ${api.rupees(r.outstandingMinor)} ${t('owes')}`, { referral: r.referralId });
      const key = r.referralId.replace(/[^A-Za-z0-9_-]/g, '-');
      const how = choose(`cd-owed-${key}-how`, 'how', api.payoutHows.map((k) => [k, `how_${k}`]));
      const ref = field(`cd-owed-${key}-ref`, 'payRef'); const st2 = statusLine(`cd-owed-${key}-status`);
      const why = field(`cd-owed-${key}-why`, 'lapseReason');
      row.append(
        form(`cd-owed-${key}-pay`, [how.label, ref.label], 'payOut', () => act(st2, () => s.payReferral(r.referralId, how.input.value, ref.input.value), () => void read('paidOut'))),
        form(`cd-owed-${key}-lapse`, [why.label], 'lapse', () => act(st2, () => s.lapseReferral(r.referralId, why.input.value), () => void read('lapsed'))),
        st2.node);
      return row;
    }), 'noOwed')]);
    // A payment or lapse recorded re-reads the list (the settled reward leaves it) and says so on the section's own line; a
    // refusal stays on the row's line.
    const read = async (doneKey) => { const o = await s.owedReferrals(); if (o.result === 'ok') { out.paint(o.value); st.set(doneKey); } else st.set(o); };
    const b = el('button', { type: 'button', id: 'cd-owed-go', key: 'owedShow' }); b.addEventListener('click', () => void act(st, () => s.owedReferrals(), out.paint));
    sec.append(b, st.node, out.node);
  } },

  // Message queue — withdraw an approved message template (PA-08 r6).
  withdraw: { may: 'templates', build(sec) {
    head(sec, 'withdrawH', 'withdrawLead');
    const st = statusLine('cd-withdraw-status');
    const out = resultArea('cd-withdraw-out', (rows) => [listOf('cd-withdraw-list', rows.map((tp) => {
      const row = li(`${tp.templateId} · ${t('version')} ${tp.version} · ${tp.purpose}/${tp.channel} — “${tp.body}”`, { template: tp.templateId, version: String(tp.version) });
      const r = field(`cd-withdraw-${tp.templateId}-${tp.version}-reason`, 'reason'); const st2 = statusLine(`cd-withdraw-${tp.templateId}-${tp.version}-status`);
      row.append(form(`cd-withdraw-${tp.templateId}-${tp.version}`, [r.label], 'withdraw', () => act(st2, () => s.withdrawTemplate(tp.templateId, tp.version, r.input.value), () => void read(), 'withdrawnOk')), st2.node);
      return row;
    }), 'noApproved')]);
    const read = () => act(st, () => s.approvedTemplates(), out.paint);
    const b = el('button', { type: 'button', id: 'cd-withdraw-go', key: 'withdrawShow' }); b.addEventListener('click', () => void read());
    sec.append(b, st.node, out.node);
  } },

  // Campaigns — the decision log (M21-FR-01 · P-08).
  'campaign-log': { may: 'campaignLog', build(sec) {
    head(sec, 'logH', 'logLead');
    const st = statusLine('cd-log-status');
    const out = resultArea('cd-log-out', (rows) => [listOf('cd-log-list', rows.map((p) => li(
      `${p.campaignId} · ${p.purpose}/${p.channel} — ${t('reach')} ${p.sendToCount}, ${t('leftOut')} ${p.excludedCount}${Object.keys(p.excludedByReason ?? {}).length === 0 ? '' : ` (${Object.entries(p.excludedByReason).map(([k, n]) => `${k} ${n}`).join(', ')})`}${p.blocked ? ` · ${t('blocked')}` : ''} · ${t('by')} ${p.plannedBy} · ${when(p.at)}`,
      { campaign: p.campaignId })), 'noPlans')]);
    const b = el('button', { type: 'button', id: 'cd-log-go', key: 'logShow' }); b.addEventListener('click', () => void act(st, () => s.campaignLog(), out.paint));
    sec.append(b, st.node, out.node);
  } },

  // Trial switches and shop account — consent-manager records that could not be applied (OB-324).
  'consent-exceptions': { may: 'consentExceptions', build(sec) {
    head(sec, 'cxH', 'cxLead');
    const st = statusLine('cd-cx-status');
    const out = resultArea('cd-cx-out', (rows) => [listOf('cd-cx-list', rows.map((x) => li(`${x.dataPrincipalRef} · ${x.purpose}/${x.channel} — ${x.detail} · ${when(x.at)}`, { exception: x.exceptionId })), 'noCx')]);
    const b = el('button', { type: 'button', id: 'cd-cx-go', key: 'cxShow' }); b.addEventListener('click', () => void act(st, () => s.consentExceptions(), out.paint));
    sec.append(b, st.node, out.node);
  } },

  // Customer cases — first reply, compensation (and carrying it out again), the customer's rating (M21-FR-04 · PF-11).
  'case-follow-up': { may: 'caseRead', build(sec) {
    head(sec, 'caseH', 'caseLead');
    const c = field('cd-case-no', 'caseNo'); const st = statusLine('cd-case-status');
    let caseId = '';
    const manage = s.may.caseManage;
    const comp = resultArea('cd-case-comp', (v) => [el('h4', { key: 'compH' }), el('p', { class: 'meta', id: 'cd-case-total', text: `${v.count} · ${t('total')} ${api.rupees(v.totalMinor)}` }),
      listOf('cd-case-comp-list', v.compensations.map((x) => {
        const f = x.fulfilment === undefined ? t('notCarried') : `${t(`f_${x.fulfilment.status}`)}${x.fulfilment.detail ? ` (${x.fulfilment.detail})` : ''}`;
        const row = li(`${t(`kind_${x.kind}`)} ${api.rupees(x.amountMinor)} — ${x.reason} · ${t('by')} ${x.grantedBy}${x.approvedBy ? ` / ${x.approvedBy}` : ''} · ${f}`, { compensation: x.compensationId ?? '', state: x.fulfilment?.status ?? 'none' });
        if (manage && x.compensationId !== undefined && x.fulfilment !== undefined && x.fulfilment.status !== 'completed') {
          const b = el('button', { type: 'button', class: 'quiet retry', key: 'retry' }); const st2 = statusLine(`cd-case-retry-${x.compensationId}`);
          b.addEventListener('click', () => void act(st2, () => s.carryOutAgain(caseId, x.compensationId), () => void readComp(), 'done'));
          row.append(b, st2.node);
        }
        return row;
      }), 'noComp')]);
    const readComp = () => act(st, () => s.compensations(caseId), comp.paint);
    const work = el('div', { id: 'cd-case-work', hidden: '' });
    if (manage) {
      const first = el('button', { type: 'button', id: 'cd-case-first', class: 'quiet', key: 'firstReply' }); const stF = statusLine('cd-case-first-status');
      first.addEventListener('click', () => void act(stF, () => s.firstReply(caseId), undefined, 'firstDone'));
      const kind = choose('cd-case-kind', 'compKind', api.compensationKinds.map((k) => [k, `kind_${k}`]));
      const amt = field('cd-case-amount', 'amount'); const why = field('cd-case-reason', 'reason'); const appr = field('cd-case-approval', 'approvalId'); const stG = statusLine('cd-case-grant-status');
      const cust = field('cd-case-customer', 'customer'); const score = choose('cd-case-score', 'score', []);
      for (const n of ['', '1', '2', '3', '4', '5']) score.input.append(el('option', { value: n, text: n === '' ? '—' : n }));
      const note = field('cd-case-comment', 'comment'); const stR = statusLine('cd-case-rate-status');
      const op = office();
      if (op !== null && typeof op.pickable === 'function') {
        op.pickable(appr.input, 'approval', { en: 'Which approval?', ta: 'எந்த ஒப்புதல்?' });
        op.pickable(cust.input, 'customer', { en: 'Which customer?', ta: 'எந்த வாடிக்கையாளர்?' });
      }
      work.append(first, stF.node,
        form('cd-case-grant', [kind.label, amt.label, why.label, appr.label], 'grant', () => act(stG, () => s.grant(caseId, { kind: kind.input.value, rupees: amt.input.value, reason: why.input.value, approvalId: appr.input.value }), () => void readComp(), 'granted')), stG.node,
        el('h4', { key: 'rateH' }),
        form('cd-case-rate', [cust.label, score.label, note.label], 'rate', () => act(stR, () => s.rate(caseId, { customerRef: cust.input.value, score: score.input.value, comment: note.input.value }), undefined, 'rated')), stR.node);
    }
    // U7 (G5): the case, the approval and the customer are PICKED by name (the typed number stays the fallback)
    const o = office();
    if (o !== null && typeof o.pickable === 'function') {
      o.pickable(c.input, 'case', { en: 'Which case?', ta: 'எந்த வழக்கு?' });
    }
    sec.append(form('cd-case-form', [c.label], 'caseOpen', async () => { caseId = c.input.value.trim(); const out = await readComp(); work.hidden = out.result !== 'ok'; }), st.node, comp.node, work);
  } },

  // Store credit and vouchers — one family's pooled balance (M17-FR-04).
  household: { may: 'household', build(sec) {
    head(sec, 'houseH', 'houseLead');
    const c = field('cd-house-customer', 'customer'); const st = statusLine('cd-house-status');
    const out = resultArea('cd-house-out', (v) => [el('p', { id: 'cd-house-balance', text: `${t('houseBal')}: ${api.rupees(v.balanceMinor)} · ${v.instrumentCount} ${t('cards')}` }),
      listOf('cd-house-cards', v.instrumentIds.map((id) => li(id, { card: id })), 'none')]);
    sec.append(form('cd-house-form', [c.label], 'houseShow', () => act(st, () => s.household(c.input.value), out.paint)), st.node, out.node);
  } },

  // Dispatch — the proof of delivery and its images (D09-FR-05 · WF-15).
  proof: { may: 'proof', build(sec) {
    head(sec, 'proofH', 'proofLead');
    const o = field('cd-proof-order', 'orderNo');
    const st = statusLine('cd-proof-status');
    const out = resultArea('cd-proof-out', (v) => [
      el('p', { id: 'cd-proof-code', text: v.codeIssued ? `${t('codeIssued')} · ${when(v.codeIssuedAt)}` : t('noCode') }),
      el('p', { id: 'cd-proof-door', text: v.door === null ? t('noDoor') : `${t('door')}: ${v.door.state}${v.door.proofKind ? ` · ${v.door.proofKind}` : ''}${v.door.proofCheck?.code ? ` · ${v.door.proofCheck.code}` : ''}${v.door.proofCheck?.fence?.result ? ` · ${v.door.proofCheck.fence.result}` : ''}${(v.door.flags ?? []).length === 0 ? '' : ` · ${v.door.flags.join(', ')}`} · ${when(v.door.at)}` }),
      el('h4', { key: 'images' }),
      listOf('cd-proof-images', v.images.map((im) => {
        const row = li(`${t(im.kind) || im.kind} · ${im.driverId} · ${when(im.capturedAt)}${im.governanceFlags.length === 0 ? '' : ` · ${im.governanceFlags.join(', ')}`}`, { image: im.imageId });
        const b = el('button', { type: 'button', class: 'quiet show-image', key: 'showImage' }); const st2 = statusLine(`cd-proof-${im.imageId}-status`); const box = el('div', { class: 'image' });
        b.addEventListener('click', () => void act(st2, () => s.proofImage(im.imageId), (held) => {
          if (!/^image\/(png|jpeg|webp|gif)$/.test(held.mediaType ?? '')) { st2.set('notAnImage'); return; }
          box.replaceChildren(el('img', { src: `data:${held.mediaType};base64,${held.contentBase64}`, alt: t(held.kind) || held.kind, style: 'max-width:100%;max-height:240px' }));
        }));
        row.append(b, st2.node, box);
        return row;
      }), 'noImages'),
    ]);
    sec.append(form('cd-proof-form', [o.label], 'proofShow', () => act(st, () => s.proof(o.input.value), out.paint)), st.node, out.node);
  } },

  // Dispatch — the goods that came back from a part delivery, counted per packed line (M19-FR-02).
  handback: { may: 'handback', build(sec) {
    head(sec, 'backH', 'backLead');
    const o = field('cd-back-order', 'orderNo');
    const st = statusLine('cd-back-status');
    let orderId = '';
    const out = resultArea('cd-back-out', (lines) => {
      if (lines.length === 0) return [el('p', { class: 'meta', key: 'notPacked' })];
      const inputs = {};
      const kids = lines.map((l) => { const f = field(`cd-back-${l.lineId}`, 'backQty', { type: 'number' }); f.label.firstChild.textContent = `${l.name} (${t('packed')} ${l.packedMinor}) — ${t('backQty')}`; inputs[l.lineId] = f.input; return f.label; });
      const st2 = statusLine('cd-back-record-status');
      return [form('cd-back-record', kids, 'backRecord', async () => {
        st2.set('reading');
        const r = await s.handback(orderId, Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value])));
        st2.set(r.result !== 'ok' ? r : r.value.alreadyRecorded ? 'backAlready' : 'backDone');
      }), st2.node];
    });
    sec.append(form('cd-back-form', [o.label], 'backShow', () => act(st, () => { orderId = o.input.value.trim(); return s.packLines(o.input.value); }, out.paint)), st.node, out.node);
  } },

  // Delivery exceptions — move one to another queue, with the reason (M19-FR-01).
  reassign: { may: 'reassign', build(sec) {
    head(sec, 'moveH', 'moveLead');
    const x = field('cd-move-exception', 'exception'); const q = choose('cd-move-to', 'toQueue', api.queues.map((k) => [k, `q_${k}`])); const r = field('cd-move-reason', 'reason');
    const st = statusLine('cd-move-status');
    sec.append(form('cd-move-form', [x.label, q.label, r.label], 'move', () => act(st, () => s.reassign(x.input.value, q.input.value, r.input.value), undefined, 'moved')), st.node);
  } },

  // Online orders — the customer's substitution answer, told to staff (FUL-14).
  'sub-pref': { may: 'subPref', build(sec) {
    head(sec, 'subH', 'subLead');
    const o = field('cd-sub-order', 'orderNo');
    const p = choose('cd-sub-pref', 'pref', api.preferences.map((k) => [k, `pref_${k}`])); const m = choose('cd-sub-method', 'method', api.contactMethods.map((k) => [k, `m_${k}`]));
    const r = field('cd-sub-ref', 'contactRef'); const st = statusLine('cd-sub-status');
    sec.append(form('cd-sub-form', [o.label, p.label, m.label, r.label], 'subRecord', () => act(st, () => s.recordPreference(o.input.value, { preference: p.input.value, method: m.input.value, reference: r.input.value }), undefined, 'subRecorded')), st.node);
  } },

  // Online orders — the messages due to customers about their orders, and what became of each (M20-FR-03).
  notices: { may: 'orderRead', build(sec) {
    head(sec, 'noticesH', 'noticesLead');
    const st = statusLine('cd-notices-status');
    const out = resultArea('cd-notices-out', (v) => [el('p', { class: 'meta', text: v.detail }),
      listOf('cd-notices-list', [...v.notQueued, ...v.notices.filter((n) => n.outcome === 'queued')].map((n) => li(`${n.orderId} · ${n.kind} · ${n.customerRef} — ${n.outcome === 'queued' ? t('queued') : `${t('notQueued')}: ${n.detail}`} · ${when(n.at)}`, { notice: n.noticeId, outcome: n.outcome })), 'noNotices')]);
    const b = el('button', { type: 'button', id: 'cd-notices-go', key: 'noticesShow' }); b.addEventListener('click', () => void act(st, () => s.orderNotices(), out.paint));
    sec.append(b, st.node, out.node);
  } },

  // W6 · OB-687 — the swaps the picker put to the customer on an order, and their yes or no told to staff by phone (it counts
  // the same as the app's). The record form is offered only to a role head office lets record it.
  'swap-answer': { may: 'orderRead', build(sec) {
    head(sec, 'swapsH', 'swapsLead');
    const o = field('cd-swap-order', 'orderNo'); const st = statusLine('cd-swap-status');
    let shown = [];
    const line = choose('cd-swap-line', 'swapLine', []);
    const out = resultArea('cd-swap-out', (v) => [listOf('cd-swap-list', v.map((x) => li(
      `${x.substituteName} ${t('for')} ${x.orderedName}${x.substituteUnitPriceMinor === null ? '' : ` · ${api.rupees(x.substituteUnitPriceMinor)} ${t('each')}`} — ${t(`s_${x.state}`)}`
      + `${x.answeredVia ? ` (${t(`via_${x.answeredVia}`)}${x.contact ? `: ${x.contact.method} ${x.contact.reference}` : ''})` : ''}`
      + `${x.answerBy && x.state === 'waiting' ? ` · ${t('answerBy')} ${when(x.answerBy)}` : ''}${x.refusedBecause ? ` · ${x.refusedBecause}` : ''}`
      + `${x.settled ? ` · ${x.settled.onOrder ? t('onOrder') : t('notOnOrder')}${x.settled.refusal ? `: ${x.settled.refusal.whatHappened}` : ''}` : ''}`,
      { line: x.lineId, state: x.state })), 'noSwaps')]);
    const fill = (v) => {
      shown = v;
      line.input.replaceChildren(...v.filter((x) => x.state === 'waiting').map((x) => el('option', { value: x.lineId, text: `${x.substituteName} ${t('for')} ${x.orderedName}` })));
      out.paint(v);
    };
    const showIt = () => act(st, () => s.swapProposals(o.input.value), fill);
    sec.append(form('cd-swap-form', [o.label], 'swapsShow', showIt), st.node, out.node);
    if (s.may.subPref) {
      const d = choose('cd-swap-decision', 'swapAnswer', api.swapDecisions.map((k) => [k, `d_${k}`]));
      const m = choose('cd-swap-method', 'method', api.contactMethods.map((k) => [k, `m_${k}`]));
      const r = field('cd-swap-ref', 'contactRef'); const st2 = statusLine('cd-swap-answer-status');
      sec.append(form('cd-swap-answer', [line.label, d.label, m.label, r.label], 'swapRecord', async () => {
        const done = await act(st2, () => s.answerSwap(o.input.value, line.input.value, { decision: d.input.value, method: m.input.value, reference: r.input.value }), undefined, 'swapRecorded');
        if (done.result === 'ok') { const again = await s.swapProposals(o.input.value); if (again.result === 'ok') fill(again.value); }
      }), st2.node);
    }
    repaints.push(() => { if (shown.length > 0) fill(shown); });
  } },

  // W6 · OB-687 — how long the picker waits for a customer's answer: the OWNER's number, "not set" until he sets it.
  'swap-wait': { may: 'orderRead', build(sec) {
    head(sec, 'waitH', 'waitLead');
    const st = statusLine('cd-wait-status');
    const out = resultArea('cd-wait-out', (v) => [el('p', { id: 'cd-wait-now', class: v.state === 'set' ? 'meta' : 'meta warn', 'data-state': v.state,
      text: v.state === 'set' ? `${t('waitIs')} ${v.minutes} ${t('minutes')} · ${t('setByOwner')} ${v.setBy ?? ''} · ${when(v.setAt)}` : t('waitNotSet') })]);
    const b = el('button', { type: 'button', id: 'cd-wait-go', key: 'waitShow' }); b.addEventListener('click', () => void act(st, () => s.swapWait(), out.paint));
    sec.append(b, st.node, out.node);
    if (s.may.waitSet) {
      const mi = field('cd-wait-minutes', 'waitMinutes', { type: 'text' }); mi.input.setAttribute('inputmode', 'numeric');
      const re = field('cd-wait-reason', 'waitReason'); const st2 = statusLine('cd-wait-set-status');
      sec.append(form('cd-wait-form', [mi.label, re.label], 'waitSave', () => act(st2, () => s.setSwapWait(mi.input.value, re.input.value), out.paint, 'waitSaved')), st2.node);
    }
  } },

  // Online orders — the refused-access register (P-04 · hard rule #6).
  refusals: { may: 'orderRead', build(sec) {
    head(sec, 'refusalsH', 'refusalsLead');
    const st = statusLine('cd-refusals-status');
    const out = resultArea('cd-refusals-out', (v) => [
      ...(v.probing.length === 0 ? [] : [el('h4', { key: 'probing' }), listOf('cd-refusals-probing', v.probing.map((p) => li(`${p.customerRef} — ${p.distinctOrders} ${t('orders')}`, { customer: p.customerRef })), 'none')]),
      listOf('cd-refusals-list', v.refusals.map((r) => li(`${r.customerRef} ${t(`a_${r.action}`)} ${r.orderId} · ${when(r.at)}`, { customer: r.customerRef })), 'noRefusals')]);
    const b = el('button', { type: 'button', id: 'cd-refusals-go', key: 'refusalsShow' }); b.addEventListener('click', () => void act(st, () => s.accessRefusals(), out.paint));
    sec.append(b, st.node, out.node);
  } },
};

for (const sec of document.querySelectorAll('section[data-desk]')) {
  const spec = SECTIONS[sec.dataset.desk];
  if (spec === undefined || api === null || s === null) continue;
  // Offered only to a person head office would answer for this section; nobody signed in → not offered at all.
  if (!s.may.named || !s.may[spec.may]) continue;
  if (!sec.id) sec.id = `desk-${sec.dataset.desk}`;
  spec.build(sec);
  sec.hidden = false;
}
new MutationObserver(() => { for (const [n, k] of words) n.textContent = t(k); for (const r of repaints) r(); })
  .observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
