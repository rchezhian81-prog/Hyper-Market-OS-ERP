// Production quality-release — the view layer (M11-FR-03, API-04). Every rule lives in the TESTED session model
// (apps/web-erp/src/production-session.ts), attached as window.productionSession, built on packages/ui over the
// cloud's production board. This file only draws what the session hands it: the finished batches still in
// quarantine (worst first, each with its product, batch, quantity, use-by, cost, yield and any exception), and
// two buttons per batch — Release for sale, or Hold on a failed check. Releasing is a HUMAN decision that runs
// ONLY on an explicit click, never on load; on success the board is re-read (a GET) so a released batch drops
// off. No prompt/confirm/alert.

const el = (id) => document.getElementById(id);
let lang = 'en';

/** A stand-in with the same surface as the bundled session, so the shell always opens (and says so). */
function sampleSession() {
  const CHROME = {
    en: {
      title: 'Release for sale', langName: 'தமிழ்',
      lead: 'Sample batches. Connect the store computer to see the finished batches waiting for release in your own shop.',
      listHeading: 'To release', toReleaseCount: 'to release', allReleased: 'Nothing waiting — every finished batch has been released or held.',
      notKnown: 'This store computer has not been told the production runs yet.',
      productLabel: 'Product', batchLabel: 'Batch', qtyLabel: 'Quantity', expiryLabel: 'Use by', costLabel: 'Unit cost', costNotKnown: 'cost not known', yieldLabel: 'Yield', departmentLabel: 'Department',
      yieldAsExpected: 'as expected', yieldLow: 'below standard', yieldHigh: 'above standard', yieldNotMeasured: 'not measured',
      exceptionWord: 'Exception', costUnknownWord: 'Cost not known', yieldOffWord: 'Yield off', awaitingWord: 'Awaiting',
      releaseBtn: 'Release for sale', holdBtn: 'Hold — check failed', releaseHint: 'Release makes the batch sellable in your name; hold keeps it in quarantine.',
      releaseRecorded: 'Released for sale.', releaseHeld: 'Held in quarantine — check failed.', releaseRefused: 'Could not release — the batch may be expired or already released, or you do not have permission.', releaseLostLink: 'No connection — not saved. Try again.',
      scrReady: 'Showing the batches to release', scrEmpty: 'Nothing waiting — every finished batch has been released or held.',
      stateNotPermitted: 'You do not have permission to see production.', noRelease: 'You can see the batches, but releasing one needs quality-release permission.',
      nobodyNamed: 'This store computer has not been told who is using this screen.',
      sampleData: 'Sample data — this is not your shop.',
    },
    ta: {
      title: 'விற்பனைக்கு விடுவி', langName: 'English',
      lead: 'மாதிரி தொகுதிகள். உங்கள் கடையில் விடுவிக்கக் காத்திருக்கும் தொகுதிகளைப் பார்க்க கடை கணினியை இணைக்கவும்.',
      listHeading: 'விடுவிக்க வேண்டியவை', toReleaseCount: 'விடுவிக்க', allReleased: 'காத்திருப்பது எதுவும் இல்லை — ஒவ்வொரு தொகுதியும் விடுவிக்கப்பட்டது அல்லது தடுத்து வைக்கப்பட்டது.',
      notKnown: 'உற்பத்தி இயக்கங்கள் இன்னும் கடைக் கணினிக்குச் சொல்லப்படவில்லை.',
      productLabel: 'பொருள்', batchLabel: 'தொகுதி', qtyLabel: 'அளவு', expiryLabel: 'காலாவதி', costLabel: 'அலகு விலை', costNotKnown: 'விலை தெரியாது', yieldLabel: 'விளைச்சல்', departmentLabel: 'துறை',
      yieldAsExpected: 'எதிர்பார்த்தபடி', yieldLow: 'தரத்திற்குக் கீழே', yieldHigh: 'தரத்திற்கு மேலே', yieldNotMeasured: 'அளக்கப்படவில்லை',
      exceptionWord: 'விதிவிலக்கு', costUnknownWord: 'விலை தெரியாது', yieldOffWord: 'விளைச்சல் மாறுபாடு', awaitingWord: 'காத்திருக்கிறது',
      releaseBtn: 'விற்பனைக்கு விடுவி', holdBtn: 'தடு — சோதனை தோல்வி', releaseHint: 'விடுவித்தல் தொகுதியை உங்கள் பெயரில் விற்பனைக்கு ஆக்குகிறது; தடுத்தல் தனிமைப்படுத்தலில் வைக்கிறது.',
      releaseRecorded: 'விற்பனைக்கு விடுவிக்கப்பட்டது.', releaseHeld: 'தனிமைப்படுத்தலில் வைக்கப்பட்டது — சோதனை தோல்வி.', releaseRefused: 'விடுவிக்க முடியவில்லை — தொகுதி காலாவதியாகியிருக்கலாம் அல்லது ஏற்கனவே விடுவிக்கப்பட்டிருக்கலாம், அல்லது அனுமதி இல்லை.', releaseLostLink: 'இணைப்பு இல்லை — சேமிக்கப்படவில்லை. மீண்டும் முயற்சிக்கவும்.',
      scrReady: 'விடுவிக்க வேண்டிய தொகுதிகளைக் காட்டுகிறது', scrEmpty: 'காத்திருப்பது எதுவும் இல்லை — ஒவ்வொரு தொகுதியும் விடுவிக்கப்பட்டது அல்லது தடுத்து வைக்கப்பட்டது.',
      stateNotPermitted: 'உற்பத்தியைப் பார்க்க உங்களுக்கு அனுமதி இல்லை.', noRelease: 'தொகுதிகளைப் பார்க்கலாம், ஆனால் விடுவிக்க தரக் கட்டுப்பாட்டு அனுமதி தேவை.',
      nobodyNamed: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை.',
      sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
    },
  };
  const sampleRun = (l) => ({
    runId: 'run-loaf', departmentId: 'bakery', productId: 'p-loaf', batchId: 'B-run-loaf',
    quantity: '12000 ea', expiresAt: '2026-09-28T00:00:00.000Z',
    cost: '₹250.00', yieldWord: l === 'ta' ? 'எதிர்பார்த்தபடி' : 'as expected',
    exceptionDetails: [], severityWord: l === 'ta' ? 'காத்திருக்கிறது' : 'Awaiting',
    status: { tone: 'idle', icon: '•', label: (l === 'ta' ? 'காத்திருக்கிறது' : 'Awaiting') + ' · p-loaf', announcement: 'awaiting', needsAttention: true },
    needsAttention: true,
  });
  return {
    text: (l, key) => CHROME[l]?.[key] ?? CHROME.en[key] ?? key,
    view: (l) => ({
      screenState: { tone: 'idle', icon: '•', label: '', announcement: '', needsAttention: true },
      runs: [sampleRun(l)], toReleaseCount: 1, nobodyNamed: false, mayRelease: true,
    }),
    release: async () => 'lost_link',
    presentReleaseResult: (l, result) => ({ tone: result === 'released' ? 'ok' : result === 'refused' ? 'error' : 'degraded', icon: result === 'released' ? '✓' : result === 'refused' ? '✕' : '⚠', label: '', announcement: '', needsAttention: result !== 'released' }),
  };
}

let session = window.productionSession ?? sampleSession();
const t = (key) => session.text(lang, key);
let canReleaseNow = false;

function fact(label, value, warn) {
  const span = document.createElement('span');
  if (warn) span.className = 'warnc';
  span.textContent = `${label}: ${value}`;
  return span;
}

function rowNode(r) {
  const li = document.createElement('li');
  li.className = `row tone-${r.status.tone}`;
  li.dataset.runId = r.runId;

  const head = document.createElement('div');
  head.className = 'head';
  const headline = document.createElement('span'); headline.className = 'headline'; headline.textContent = r.productId;
  const status = document.createElement('span');
  status.className = 'status';
  const icon = document.createElement('span'); icon.className = 'icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = r.status.icon;
  const slabel = document.createElement('span'); slabel.textContent = r.severityWord;
  status.append(icon, slabel);
  status.setAttribute('aria-label', r.status.announcement || r.status.label);
  head.append(headline, status);

  const facts = document.createElement('div'); facts.className = 'facts';
  facts.append(
    fact(t('batchLabel'), r.batchId),
    fact(t('qtyLabel'), r.quantity),
    fact(t('expiryLabel'), new Date(r.expiresAt).toLocaleDateString()),
    fact(t('costLabel'), r.cost ?? t('costNotKnown'), r.cost === null),
    fact(t('yieldLabel'), r.yieldWord),
    fact(t('departmentLabel'), r.departmentId),
  );

  li.append(head, facts);

  for (const detail of r.exceptionDetails) {
    const ex = document.createElement('div'); ex.className = 'exc'; ex.textContent = `${t('exceptionWord')}: ${detail}`;
    li.append(ex);
  }

  // The two decisions — only for an operator who holds production.release.
  if (canReleaseNow) {
    const actions = document.createElement('div'); actions.className = 'actions';
    const release = document.createElement('button'); release.className = 'act release'; release.type = 'button'; release.dataset.runId = r.runId; release.textContent = t('releaseBtn');
    const hold = document.createElement('button'); hold.className = 'act hold'; hold.type = 'button'; hold.dataset.runId = r.runId; hold.textContent = t('holdBtn');
    actions.append(release, hold);
    li.append(actions);
  }
  return li;
}

function paint() {
  const view = session.view(lang);
  canReleaseNow = view.mayRelease && !view.nobodyNamed;

  el('title').textContent = t('title');
  el('lead').textContent = t('lead');
  el('whoami').textContent = window.productionData?.userId ?? '';
  el('lang').textContent = t('langName');

  el('release-count').textContent = view.toReleaseCount === 0 ? t('allReleased') : `${view.toReleaseCount} ${t('toReleaseCount')}`;

  const nobody = el('nobody');
  nobody.hidden = !view.nobodyNamed;
  nobody.textContent = view.nobodyNamed ? t('nobodyNamed') : '';

  el('list-heading').hidden = view.runs.length === 0;
  el('list-heading').textContent = t('listHeading');
  el('rows').replaceChildren(...view.runs.map((r) => rowNode(r)));

  const state = el('state');
  if (view.runs.length === 0) {
    state.hidden = false;
    state.className = `state tone-${view.screenState.tone}`;
    el('state-icon').textContent = view.screenState.icon;
    el('state-text').textContent = view.screenState.label;
  } else {
    state.hidden = true;
  }
  paintTasks();
}

// ── FUL-13: the staff's task paths — record a run, print the label (window.productionTasks) ─────────────

let tasks = window.productionTasks ?? null;
const tt = (key) => (tasks === null ? key : tasks.text(lang, key));

function paintTasks() {
  const runner = el('runner'); const labeller = el('labeller');
  el('no-run').hidden = true; el('no-label').hidden = true;
  if (tasks === null) { runner.hidden = true; labeller.hidden = true; return; }
  const v = tasks.view(lang);
  runner.hidden = !v.canRecordRun;
  if (!v.canRecordRun && !v.nobodyNamed) { el('no-run').hidden = false; el('no-run').textContent = tt('noRun'); }
  el('run-heading').textContent = tt('runHeading'); el('run-hint').textContent = tt('runHint');
  for (const [id, key] of [['run-recipe-label', 'runRecipeLabel'], ['run-batches-label', 'runBatchesLabel'], ['run-output-label', 'runOutputLabel'], ['run-batch-label', 'runBatchIdLabel'], ['run-location-label', 'runLocationLabel']]) el(id).textContent = tt(key);
  el('run').textContent = tt('runBtn');
  if (el('run-location').value === '' && v.defaultLocationId) el('run-location').value = v.defaultLocationId;

  labeller.hidden = !v.canLabel;
  if (!v.canLabel && !v.nobodyNamed) { el('no-label').hidden = false; el('no-label').textContent = tt('noLabel'); }
  el('label-heading').textContent = tt('labelHeading');
  for (const [id, key] of [['label-run-label', 'labelRunLabel'], ['label-name-label', 'labelNameLabel'], ['label-net-label', 'labelNetLabel'], ['label-packer-label', 'labelPackerLabel'], ['label-price-label', 'labelPriceLabel'], ['label-allergens-label', 'labelAllergensLabel']]) el(id).textContent = tt(key);
  el('label-allergens').placeholder = tt('labelAllergensHint');
  el('label').textContent = tt('labelBtn');
  const select = el('label-run'); const chosen = select.value;
  select.replaceChildren(...v.labelRuns.map((r) => { const o = document.createElement('option'); o.value = r.runId; o.textContent = r.label; return o; }));
  if (chosen && v.labelRuns.some((r) => r.runId === chosen)) select.value = chosen;
  const none = v.labelRuns.length === 0;
  el('label-none').hidden = !none; el('label-none').textContent = none ? tt('labelNoRuns') : '';
  el('label-fields').hidden = none;
}

// RECORD A RUN — a human write on this click only; head office takes the ingredients off the shelf and holds the batch.
el('run').addEventListener('click', () => {
  void (async () => {
    if (tasks === null) return;
    const o = await tasks.recordRun({ recipeId: el('run-recipe').value, batches: el('run-batches').value, actualOutput: el('run-output').value, batchId: el('run-batch').value, locationId: el('run-location').value });
    paintResult(tasks.presentRun(lang, o));
    if (o.outcome === 'recorded') { for (const id of ['run-recipe', 'run-batches', 'run-output', 'run-batch']) el(id).value = ''; await refresh(); }
  })();
});

// PRINT THE LABEL — the use-by and batch are the run's own; head office refuses a label missing a required field.
el('label').addEventListener('click', () => {
  void (async () => {
    if (tasks === null) return;
    const o = await tasks.printLabel({ runId: el('label-run').value, productName: el('label-name').value, netQuantity: el('label-net').value, packerDetails: el('label-packer').value, price: el('label-price').value, allergens: el('label-allergens').value });
    paintResult(tasks.presentLabel(lang, o));
    const out = el('label-out');
    out.hidden = o.outcome !== 'printed';
    out.textContent = o.outcome === 'printed' ? o.lines.join('\n') : '';
  })();
});

function paintResult(presentation) {
  const result = el('result');
  if (!result) return;
  result.hidden = false;
  result.className = `result tone-${presentation.tone}`;
  el('result-icon').textContent = presentation.icon;
  el('result-text').textContent = presentation.label;
  result.setAttribute('aria-label', presentation.announcement || presentation.label);
}

// The operator's release/hold — a HUMAN write that runs ONLY on this explicit click, never on load. Delegated
// from the list so there is one handler; on success the board is re-read (a GET) so a released batch drops off.
// The server enforces the expiry/qc rules; the screen never fakes a success it did not get (P-08).
el('rows').addEventListener('click', (ev) => {
  const btn = ev.target instanceof Element ? ev.target.closest('button.release, button.hold') : null;
  if (!btn) return;
  const runId = btn.dataset.runId;
  const qcPassed = btn.classList.contains('release');
  void (async () => {
    const result = await session.release(runId, qcPassed);
    paintResult(session.presentReleaseResult(lang, result));
    if (result === 'released' || result === 'held') { await refresh(); }
  })();
});
el('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });

el('sample').hidden = window.productionSession !== undefined;
el('sample').textContent = t('sampleData');
paint();

// Read the live production board (a GET — read-only). Offline or refused, the screen keeps its current view and
// the stale strip already says the page is what the box last told it.
async function refresh() {
  const api = window.production;
  if (!api || typeof api.refresh !== 'function') return;
  const board = await api.refresh();
  if (board) {
    session = api.present(board);
    // FUL-13: the task paths read the same board (the batches a label may be printed for).
    if (typeof window.productionTasksFor === 'function') { tasks = window.productionTasksFor(board) ?? tasks; window.productionTasks = tasks; }
    paint();
  }
}
refresh();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the screen still opens; it just will not be there without a network */
  });
}
