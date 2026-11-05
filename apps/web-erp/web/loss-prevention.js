// Loss-prevention investigations inbox — the view layer (M15-FR-04, API-05). Every rule lives in the TESTED
// session model (apps/web-erp/src/loss-prevention-inbox-session.ts), attached as window.lossPreventionInboxSession,
// built on packages/ui over the tested buildOpenCaseWorklist. This file only draws what the session hands it: the
// OPEN investigations (biggest money at stake first, each with the subject reference — never a name — the value,
// evidence count and who it is assigned to), then a "close a case" form. Closing is a HUMAN decision that runs
// ONLY on an explicit click, never on load; on success the worklist is re-read (a GET) so the closed case drops
// off. No prompt/confirm/alert.

const el = (id) => document.getElementById(id);
// ── U2b (UI/UX gap audit G5 · G14 · P-07): a thing is PICKED by name through the chrome's picker, never typed as a code,
// and a date is written as the shop writes it (dd/mm/yyyy) through the chrome's shared field. The field keeps the id the
// page sends (the typed code stays possible when the list cannot be read — head office down, no right — so the form is
// never a dead end, P-01 · P-08); the chrome's sheet finds the thing by name, code or barcode and the name is shown beside
// the field. Mounted when the chrome is there (a page that paints first listens for `sre:chrome`); off the box nothing
// changes. The same six-line pattern as the U2 pages (store-tasks, delegation, floor-heat-map).
const u2bWords = Object.freeze({ en: { choose: 'Choose…', pickProduct: 'Which product?', pickPlace: 'Which place in the store?', pickPerson: 'Which person?', pickStore: 'Which store?', pickCustomer: 'Which customer?', pickApproval: 'Which approval?', pickSupplier: 'Which supplier?', yourStore: 'your store' }, ta: { choose: 'தேர்ந்தெடு…', pickProduct: 'எந்தப் பொருள்?', pickPlace: 'கடையில் எந்த இடம்?', pickPerson: 'எந்த நபர்?', pickStore: 'எந்தக் கடை?', pickCustomer: 'எந்த வாடிக்கையாளர்?', pickApproval: 'எந்த அனுமதி?', pickSupplier: 'எந்த விநியோகஸ்தர்?', yourStore: 'உங்கள் கடை' } }); // one line on purpose: a page's own word tables start a line with `en: {`
const u2bLang = () => (document.documentElement.lang === 'ta' ? 'ta' : 'en');
const u2bWord = (k) => u2bWords[u2bLang()][k] ?? u2bWords.en[k];
const u2bRepaints = [];
const repaintPickers = () => { for (const f of u2bRepaints) f(); };
/** Mount the picker on an input the page built itself (no id needed); the id a pick gives lands in the input. */
function pickableEl(input, kind, titleKey, extra = {}) {
  if (!input || input.dataset.pickable === 'on') return;
  const office = window.sreOffice;
  if (!office || typeof office.pick !== 'function') { document.addEventListener('sre:chrome', () => pickableEl(input, kind, titleKey, extra), { once: true }); return; }
  input.dataset.pickable = 'on';
  const row = document.createElement('div'); row.className = 'pick-row';
  input.replaceWith(row); row.append(input);
  const btn = document.createElement('button'); btn.type = 'button'; if (input.id) btn.id = `${input.id}-pick`; btn.className = 'sre-btn sre-btn-quiet pick';
  const name = document.createElement('span'); if (input.id) name.id = `${input.id}-name`; name.className = 'pick-name';
  row.append(btn, name);
  const paint = () => { btn.textContent = u2bWord('choose'); btn.setAttribute('aria-label', `${u2bWord('choose')} ${u2bWord(titleKey)}`); };
  paint(); u2bRepaints.push(paint);
  btn.addEventListener('click', async () => {
    const k = typeof extra.kindOf === 'function' ? extra.kindOf() : kind;
    const tk = typeof extra.titleOf === 'function' ? extra.titleOf() : titleKey;
    const picked = await office.pick({ kind: k, title: { en: u2bWords.en[tk], ta: u2bWords.ta[tk] }, allowCode: true, ...(typeof extra.scope === 'function' ? { scope: extra.scope() } : {}), ...(typeof extra.filter === 'function' ? { filter: extra.filter } : {}) });
    if (!picked || picked.ok !== true) return;
    const id = typeof extra.idOf === 'function' ? extra.idOf(picked) : String(picked.id ?? '');
    if (typeof extra.append === 'function') extra.append(input, id); else input.value = id;
    name.textContent = typeof picked.name === 'string' && picked.name !== id ? picked.name : '';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    if (typeof extra.onPick === 'function') extra.onPick(picked);
  });
  input.addEventListener('input', () => { name.textContent = ''; });
}
function pickable(inputId, kind, titleKey, extra = {}) {
  const input = document.getElementById(inputId);
  if (!input) return;
  if (!window.sreOffice || typeof window.sreOffice.pick !== 'function') { document.addEventListener('sre:chrome', () => pickable(inputId, kind, titleKey, extra), { once: true }); return; }
  pickableEl(input, kind, titleKey, extra);
}
// A date a shop person reads — dd/mm/yyyy in the chrome's shared field, while the page goes on sending ISO (`dateOf`).
const shopDates = new Map();
function repaintShopDates() { const l = u2bLang(); for (const [id, words] of shopDates) { const lab = document.getElementById(id)?.closest('.sre-field')?.querySelector('.sre-field-label'); if (lab && lab.firstChild) lab.firstChild.textContent = words[l] ?? words.en; } }
function shopDate(id, words, opts = {}) {
  const office = window.sreOffice; const input = document.getElementById(id);
  if (!office || typeof office.dateField !== 'function') { document.addEventListener('sre:chrome', () => shopDate(id, words, opts), { once: true }); return; }
  if (input === null || shopDates.has(id)) return;
  const typed = input.value.trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(typed) ? typed : (typeof office.parseShopDate === 'function' ? office.parseShopDate(typed) : null);
  const field = office.dateField({ id, label: words, required: opts.required === true, ...(iso ? { value: iso } : {}), ...(opts.hint ? { hint: opts.hint } : {}) });
  const ownLabel = document.querySelector(`label[for="${id}"]`);
  if (ownLabel && !ownLabel.contains(input)) ownLabel.hidden = true; // the page's own label stays (its paint still writes it); the shared field carries the visible one
  (input.closest('label') ?? input).replaceWith(field);
  shopDates.set(id, words);
}
const dateOf = (id) => (shopDates.has(id) ? (window.sreOffice.dateValue(id) ?? '') : (document.getElementById(id)?.value ?? ''));
// the pickers' words and the shared fields' labels follow the language toggle like the page's own words
new MutationObserver(() => { repaintPickers(); if (typeof repaintShopDates === 'function') repaintShopDates(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
// ── U2b end
let lang = 'en';

/** A stand-in with the same surface as the bundled session, so the shell always opens (and says so). */
function sampleSession() {
  const CHROME = {
    en: { title: 'Investigations', langName: 'தமிழ்',
      lead: 'Sample investigations. Connect the store computer to see the open cases for your own shop.',
      openHeading: 'To investigate', openCount: 'to investigate', exposureLabel: 'Total at stake', allClear: 'No open investigations — nothing outstanding.',
      subjectLabel: 'Subject', valueLabel: 'Value at stake', evidenceLabel: 'Evidence on file', assignedLabel: 'Assigned to',
      closeHeading: 'Close an investigation', caseLabel: 'Which case', outcomeLabel: 'Outcome', noteLabel: 'What you concluded (this is the record)',
      notePlaceholder: 'What did you find, and why this outcome?', closeBtn: 'Close the case',
      closeRecorded: 'Case closed.', closeRefused: 'Could not close — check the outcome, note and your permission.', closeLostLink: 'No connection — not saved. Try again.',
      sampleData: 'Sample data — this is not your shop.', nobodyNamed: '' },
    ta: { title: 'விசாரணைகள்', langName: 'English',
      lead: 'மாதிரி விசாரணைகள். உங்கள் கடையின் திறந்த வழக்குகளைப் பார்க்க கடை கணினியை இணைக்கவும்.',
      openHeading: 'விசாரிக்க வேண்டியவை', openCount: 'விசாரிக்க வேண்டியவை', exposureLabel: 'மொத்த ஆபத்து', allClear: 'திறந்த விசாரணைகள் இல்லை — நிலுவையில் எதுவும் இல்லை.',
      subjectLabel: 'பொருள்', valueLabel: 'ஆபத்தில் உள்ள மதிப்பு', evidenceLabel: 'கோப்பில் ஆதாரம்', assignedLabel: 'ஒப்படைக்கப்பட்டவர்',
      closeHeading: 'ஒரு விசாரணையை மூடு', caseLabel: 'எந்த வழக்கு', outcomeLabel: 'முடிவு', noteLabel: 'நீங்கள் முடிவு செய்தது (இதுவே பதிவு)',
      notePlaceholder: 'என்ன கண்டீர்கள், ஏன் இந்த முடிவு?', closeBtn: 'வழக்கை மூடு',
      closeRecorded: 'வழக்கு மூடப்பட்டது.', closeRefused: 'மூட முடியவில்லை — முடிவு, குறிப்பு, அனுமதியைச் சரிபார்க்கவும்.', closeLostLink: 'இணைப்பு இல்லை — சேமிக்கப்படவில்லை. மீண்டும் முயற்சிக்கவும்.',
      sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.', nobodyNamed: '' },
  };
  const sampleRow = (l) => ({
    caseId: 'sample-till-3', subjectRef: 'SUBJ-till-3', needsAttention: true,
    summary: l === 'ta' ? 'பணப்பெட்டி 3 மூடும்போது ₹1,200 குறைவு' : 'Till 3 came up ₹1,200 short at close',
    value: '₹1,200.00', valueMinor: 120000, assignedTo: 'manager', raisedFromRef: 'shift-close:till-3', openedBy: 'system', openedAt: '', evidenceCount: 0,
    status: { tone: 'degraded', icon: '⚠', label: l === 'ta' ? 'திறந்தது' : 'Open', announcement: 'open', needsAttention: true },
    // ── R4 integration · OB-235 — begin (the sample case was opened by the till-shortage rule)
    openedByRule: l === 'ta'
      ? { label: 'விதியால் திறக்கப்பட்டது', say: 'பணப்பெட்டி குறைவு விதியால் தானாகத் திறக்கப்பட்டது — யாரும் யாரையும் குற்றம் சாட்டவில்லை.' }
      : { label: 'Opened by rule', say: 'Opened automatically by the till-shortage rule — no person has accused anyone.' },
    // ── R4 integration · OB-235 — end
  });
  const OUTCOMES = [
    { value: 'proven', label: { en: 'Proven', ta: 'நிரூபிக்கப்பட்டது' } },
    { value: 'unfounded', label: { en: 'Unfounded', ta: 'ஆதாரமற்றது' } },
    { value: 'inconclusive', label: { en: 'Inconclusive', ta: 'முடிவில்லாதது' } },
    { value: 'process_failure', label: { en: 'A process failed (not a person)', ta: 'ஒரு செயல்முறை தோல்வி (நபர் அல்ல)' } },
    { value: 'referred_to_police', label: { en: 'Referred to the police', ta: 'காவல்துறைக்கு அனுப்பப்பட்டது' } },
  ];
  return {
    text: (l, key) => CHROME[l]?.[key] ?? CHROME.en[key] ?? key,
    view: (l) => ({
      screenState: { tone: 'ok', icon: '✓', label: '', announcement: '', needsAttention: false },
      open: [sampleRow(l)], openCount: 1, totalValue: '₹1,200.00', totalValueMinor: 120000, nobodyNamed: false, mayManage: true,
    }),
    outcomeOptions: (l) => OUTCOMES.map((o) => ({ value: o.value, label: o.label[l] ?? o.label.en })),
    close: async () => 'lost_link',
    presentCloseResult: (l, outcome) => ({ tone: outcome === 'closed' ? 'ok' : outcome === 'lost_link' ? 'degraded' : 'error', icon: outcome === 'closed' ? '✓' : outcome === 'lost_link' ? '⚠' : '✕', label: '', announcement: '', needsAttention: outcome !== 'closed' }),
  };
}

let session = window.lossPreventionInboxSession ?? sampleSession();
const t = (key) => session.text(lang, key);

function rowNode(r) {
  const li = document.createElement('li');
  li.className = `row tone-${r.status.tone}`;

  const head = document.createElement('div');
  head.className = 'head';
  const headline = document.createElement('span'); headline.className = 'headline'; headline.textContent = r.summary;
  const value = document.createElement('span'); value.className = 'value'; value.textContent = r.value;
  head.append(headline, value);

  const status = document.createElement('span');
  status.className = 'status';
  const icon = document.createElement('span'); icon.className = 'icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = r.status.icon;
  const slabel = document.createElement('span'); slabel.textContent = r.status.label;
  status.append(icon, slabel);
  status.setAttribute('aria-label', r.status.announcement || r.status.label);

  const facts = document.createElement('div'); facts.className = 'facts';
  const subj = document.createElement('span'); subj.textContent = `${t('subjectLabel')}: ${r.subjectRef}`;
  const ev = document.createElement('span'); ev.textContent = `${t('evidenceLabel')}: ${r.evidenceCount}`;
  const asg = document.createElement('span'); asg.textContent = `${t('assignedLabel')}: ${r.assignedTo}`;
  facts.append(subj, ev, asg);

  li.append(head, status, facts);
  // ── R4 integration · OB-235 — begin: a case a RULE opened (a material till shortage) carries a chip with an icon and
  //    a word, so nobody reads it as a person accusing someone. The words come from the tested session (English/Tamil).
  if (r.openedByRule) li.append(ruleChip(r.openedByRule));
  // ── R4 integration · OB-235 — end
  return li;
}

// ── R4 integration · OB-235 — begin
function ruleChip(rule) {
  const chip = window.sreIcon?.chip
    ? window.sreIcon.chip({ tone: 'idle', label: rule.label, icon: 'list-checks' })
    : Object.assign(document.createElement('span'), { className: 'sre-chip', textContent: rule.label });
  chip.classList.add('opened-by-rule');
  chip.title = rule.say;
  chip.setAttribute('aria-label', rule.say);
  return chip;
}
// ── R4 integration · OB-235 — end

function raisedNode(r) {
  const li = document.createElement('li');
  li.className = `row tone-${r.status.tone}`;
  li.dataset.exceptionId = r.exceptionId;
  const head = document.createElement('div');
  head.className = 'head';
  const headline = document.createElement('span'); headline.className = 'headline'; headline.textContent = `${r.what} — ${r.cashierId}`;
  const status = document.createElement('span'); status.className = 'status';
  const icon = document.createElement('span'); icon.className = 'icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = r.status.icon;
  const slabel = document.createElement('span'); slabel.textContent = r.status.label;
  status.append(icon, slabel);
  status.setAttribute('aria-label', r.status.announcement || r.status.label);
  head.append(headline, status);
  const facts = document.createElement('div'); facts.className = 'facts';
  const breach = document.createElement('span'); breach.className = 'breach'; breach.textContent = r.breach;
  const linked = document.createElement('span'); linked.textContent = `${t('raisedLinked')}: ${r.linkedTxnIds.length}`;
  const cs = document.createElement('span'); cs.textContent = r.caseLabel;
  facts.append(breach, linked, cs);
  li.append(head, facts);
  return li;
}

function paint() {
  const view = session.view(lang);

  el('title').textContent = t('title');
  el('lead').textContent = t('lead');
  el('whoami').textContent = window.lossPreventionInboxData?.userId ?? '';
  el('lang').textContent = t('langName');

  el('open-count').textContent = view.openCount === 0 ? t('allClear') : `${view.openCount} ${t('openCount')}`;
  el('exposure').textContent = view.openCount === 0 ? '' : `${t('exposureLabel')}: ${view.totalValue}`;

  const nobody = el('nobody');
  nobody.hidden = !view.nobodyNamed;
  nobody.textContent = view.nobodyNamed ? t('nobodyNamed') : '';

  el('open-heading').hidden = view.open.length === 0;
  el('open-heading').textContent = t('openHeading');
  el('rows').replaceChildren(...view.open.map((r) => rowNode(r)));

  // PF-07: what the store's rules raised today on head office's own record — voids, drawer opened with no sale, price
  // overrides, refunds — each with how far over the rule, the cashier (an id), the linked bills and whether a case is open.
  const raised = view.raised ?? [];
  el('raised-heading').hidden = raised.length === 0;
  el('raised-heading').textContent = t('raisedHeading');
  el('raised-rows').replaceChildren(...raised.map((r) => raisedNode(r)));

  // The close form — only for a manager who holds lp.case.manage, and only when there is a case to close.
  const closer = el('closer');
  const canClose = view.mayManage && view.open.length > 0 && !view.nobodyNamed;
  closer.hidden = !canClose;
  if (canClose) {
    el('close-heading').textContent = t('closeHeading');
    el('close-case-label').textContent = t('caseLabel');
    el('close-outcome-label').textContent = t('outcomeLabel');
    el('close-note-label').textContent = t('noteLabel');
    el('close-note').setAttribute('aria-label', t('noteLabel'));
    el('close-note').placeholder = t('notePlaceholder');
    el('close').textContent = t('closeBtn');
    const caseList = el('case-list'); if (caseList) caseList.replaceChildren(...view.open.map((r) => { const o = document.createElement('option'); o.value = r.caseId; return o; }));
    el('close-case').replaceChildren(...view.open.map((r) => {
      const o = document.createElement('option'); o.value = r.caseId; o.textContent = `${r.summary} (${r.value})`; return o;
    }));
    el('close-outcome').replaceChildren(...session.outcomeOptions(lang).map((opt) => {
      const o = document.createElement('option'); o.value = opt.value; o.textContent = opt.label; return o;
    }));
  }

  const state = el('state');
  if (view.open.length === 0) {
    state.hidden = false;
    state.className = `state tone-${view.screenState.tone}`;
    el('state-icon').textContent = view.screenState.icon;
    el('state-text').textContent = view.screenState.label;
  } else {
    state.hidden = true;
  }
}

function paintResult(presentation) {
  const result = el('result');
  if (!result) return;
  result.hidden = false;
  result.className = `result tone-${presentation.tone}`;
  el('result-icon').textContent = presentation.icon;
  el('result-text').textContent = presentation.label;
  result.setAttribute('aria-label', presentation.announcement || presentation.label);
}

// The manager's close — a HUMAN write that runs ONLY on this explicit click, never on load. On success the
// worklist is re-read (a GET) so the closed case drops off. The server enforces §28/evidence for a "proven"
// outcome; the screen never fakes it.
el('close').addEventListener('click', () => {
  void (async () => {
    const caseId = el('close-case').value;
    const outcome = el('close-outcome').value;
    const note = el('close-note').value;
    const result = await session.close(caseId, outcome, note);
    paintResult(session.presentCloseResult(lang, result));
    if (result === 'closed') { el('close-note').value = ''; await refresh(); }
  })();
});
el('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });

el('sample').hidden = window.lossPreventionInboxSession !== undefined;
el('sample').textContent = t('sampleData');
paint();

// Read the live worklist (a GET — read-only). Offline or refused, the screen keeps its current view and the
// stale strip already says the page is what the box last told it.
async function refresh() {
  const api = window.lossPreventionInbox;
  if (!api || typeof api.refresh !== 'function') return;
  const data = await api.refresh();
  if (data) { session = api.present(data); paint(); }
}
refresh();

// ── R4 Lane 4 · D-21 (OB-217) — begin: "Seen together" ─────────────────────────────────────────────────────────────
// The tested session (apps/web-erp/src/lp-correlation-session.ts, in the bundle as window.lpCorrelation) asks head office
// for the view and the proposed case; this block only draws them. Nothing is opened on read: a case is opened only on
// the explicit "Open this case" click, naming the investigator. A CCTV clip is a reference (camera, from–to, who collected
// it); there is no field for video.
const together = window.lpCorrelation ?? null;
let togetherView = null;
const tw = (key) => (together === null ? key : together.words(lang, key));

function factRow(text, attrs) {
  const li = document.createElement('li');
  li.className = 'row tone-idle';
  li.textContent = text;
  for (const [k, v] of Object.entries(attrs)) li.dataset[k] = v;
  return li;
}

function paintTogether() {
  const box = el('together');
  box.hidden = together === null || !together.session.may.read;
  if (box.hidden) return;
  for (const [id, k] of [['together-heading', 'heading'], ['together-lead', 'lead'], ['together-kind-label', 'subjectKind'], ['together-id-label', 'subjectId'], ['together-from-label', 'from'], ['together-to-label', 'to'], ['together-show', 'show'],
    ['till-heading', 'tillH'], ['shrink-heading', 'shrinkH'], ['counts-heading', 'countsH'], ['open-case-id-label', 'caseId'], ['open-assignee-label', 'investigator'], ['open-case', 'open'],
    ['cctv-heading', 'cctvH'], ['cctv-case-label', 'caseId'], ['cctv-camera-label', 'camera'], ['cctv-from-label', 'clipFrom'], ['cctv-to-label', 'clipTo'], ['cctv-by-label', 'collectedBy'], ['cctv-add', 'addCctv']]) el(id).textContent = tw(k);
  const kinds = el('together-kind').options;
  kinds[0].textContent = tw('product'); kinds[1].textContent = tw('cashier');
  el('cctv-form').hidden = !together.session.may.manage;
  const v = togetherView;
  el('together-result').hidden = v === null;
  if (v === null) return;
  const none = (list) => (list.length === 0 ? [factRow(tw('none'), { none: 'true' })] : list);
  el('till-rows').replaceChildren(...none(v.tillExceptions.map((x) => factRow(`${x.day} · ${tw(x.kind)} · ${x.cashierId}${x.productIds.length === 0 ? '' : ` · ${x.productIds.join(', ')}`} · ${together.rupees(x.valueMinor)}`, { ref: x.ref, kind: x.kind }))));
  el('shrink-rows').replaceChildren(...none(v.shrink.map((x) => factRow(`${x.day} · ${x.productId} · ${x.lossType} (${x.reasonCode}) · ${x.quantityMinor} · ${together.rupees(x.valueMinor)}`, { ref: x.ref }))));
  el('count-rows').replaceChildren(...none(v.countDifferences.map((x) => factRow(`${x.day} · ${x.productId} · ${x.varianceMinor > 0 ? '+' : ''}${x.varianceMinor} · ${together.rupees(Math.abs(x.valueMinor))}`, { ref: x.ref, variance: String(x.varianceMinor) }))));
  el('joined').hidden = v.subject.kind !== 'cashier';
  el('joined').textContent = `${tw('joined')} ${v.productsJoined.join(', ')}`;
  el('proposal').dataset.propose = String(v.proposal.propose);
  el('proposal').textContent = `${v.proposal.propose ? tw('proposed') : tw('notProposed')} ${v.proposal.propose ? v.proposal.summary : v.proposal.because}`;
  el('open-form').hidden = !v.proposal.propose || !together.session.may.manage;
  // U2b: the new case's number is GIVEN by the page (the shop's day and the next free number), never invented at the desk
  if (!el('open-form').hidden && el('open-case-id').value.trim() === '') el('open-case-id').value = proposeCaseId();
}

if (together !== null) {
  el('together-show').addEventListener('click', () => {
    void (async () => {
      const out = await together.session.view(el('together-kind').value, el('together-id').value, dateOf('together-from'), dateOf('together-to'));
      togetherView = out.result === 'ok' ? out.value : null;
      el('together-status').textContent = out.result === 'ok' ? '' : together.outcomeWords(lang, out);
      paintTogether();
    })();
  });
  el('open-case').addEventListener('click', () => {
    void (async () => {
      if (togetherView === null) return;
      const out = await together.session.open(el('open-case-id').value, togetherView.proposal, el('open-assignee').value);
      el('together-status').textContent = out.result === 'ok' ? tw('opened') : together.outcomeWords(lang, out);
      if (out.result === 'ok') { el('cctv-case').value = el('open-case-id').value; await refresh(); }
    })();
  });
  el('cctv-add').addEventListener('click', () => {
    void (async () => {
      const out = await together.session.cctv(el('cctv-case').value, { cameraId: el('cctv-camera').value, from: el('cctv-from').value, to: el('cctv-to').value, collectedBy: el('cctv-by').value });
      el('cctv-status').textContent = out.result === 'ok' ? tw('cctvAdded') : together.outcomeWords(lang, out);
    })();
  });
  el('lang').addEventListener('click', () => { paintTogether(); });
}
paintTogether();
// ── U2b (G5 · G14): pick by name, never type a code; dates as the shop writes them ────────────────────────────────
function proposeCaseId() {
  const day = (window.sreShopDay?.today?.() ?? '').replace(/-/g, '');
  const n = (el('case-list')?.options.length ?? 0) + 1;
  return day === '' ? '' : `LP-${day}-${String(n).padStart(3, '0')}`;
}
if (together !== null) {
  const lpWords = (k) => ({ en: together.words('en', k), ta: together.words('ta', k) });
  pickable('together-id', 'product', 'pickProduct', { kindOf: () => (el('together-kind').value === 'cashier' ? 'person' : 'product'), titleOf: () => (el('together-kind').value === 'cashier' ? 'pickPerson' : 'pickProduct') });
  pickable('open-assignee', 'person', 'pickPerson');
  pickable('cctv-by', 'person', 'pickPerson');
  shopDate('together-from', lpWords('from'));
  shopDate('together-to', lpWords('to'));
}
// ── R4 Lane 4 · D-21 — end

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the screen still opens; it just will not be there without a network */
  });
}
