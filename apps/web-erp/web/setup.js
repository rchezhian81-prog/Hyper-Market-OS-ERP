// Store setup — the view layer. Every RULE lives in tested code: the read model
// (apps/web-erp/src/setup-session.ts, window.setupSession) and the editing logic
// (apps/web-erp/src/setup-editing.ts, window.setupEditing). This file only renders and wires.
//
// A retailer edits and saves its own configuration from this one page. Each field validates as the
// engine would, saves against its version (so a stale save is refused, not silently overwritten),
// queues offline, and shows loading / saved / queued / failed / conflict. Completeness recomputes
// after a save. No setup value is a secret; none is logged. No prompt/confirm/alert.

const el = (id) => document.getElementById(id);

const WORDS = {
  en: {
    title: 'Store setup',
    staleShell: 'No connection to the store computer. This page is what it was last told, at',
    sampleData: 'Sample data — this is not your shop.',
    ready: 'Setup is complete — the store can open.',
    notReady: 'Almost there — a few settings are still needed before the store can open.',
    progress: 'settings chosen; the rest run on safe defaults',
    stillNeeded: 'Still needed to open:',
    give_now: 'Set these for your store',
    check_default: 'These have safe defaults — change only if you want',
    already_set: 'Already decided',
    yourChoice: 'your choice',
    usingDefault: 'default',
    needed: 'needed to open',
    now: 'Now',
    none: '(none)',
    on: 'on',
    off: 'off',
    save: 'Save',
    saving: 'Saving…',
    saved: 'Saved ✓',
    queued: 'Saved here — it will sync when the line is back.',
    failed: 'Could not save:',
    retry: 'Try again',
    conflict: 'Someone changed this since you opened the page.',
    reload: 'Reload',
    unsaved: 'Unsaved change',
    unsavedWarn: 'You have unsaved changes. Leave the page and lose them?',
    changedBy: 'last set by',
    readOnly: 'You are viewing this — an administrator can change it.',
    noSetup: 'This screen has not been told this store’s setup yet.',
  },
  ta: {
    title: 'கடை அமைப்பு',
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:',
    sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
    ready: 'அமைப்பு முடிந்தது — கடையைத் திறக்கலாம்.',
    notReady: 'கிட்டத்தட்ட முடிந்துவிட்டது — கடையைத் திறக்க முன் சில அமைப்புகள் தேவை.',
    progress: 'அமைப்புகள் தேர்ந்தெடுக்கப்பட்டன; மற்றவை பாதுகாப்பான இயல்புநிலையில் இயங்கும்',
    stillNeeded: 'திறக்கத் தேவையானவை:',
    give_now: 'உங்கள் கடைக்கு இவற்றை அமைக்கவும்',
    check_default: 'இவற்றுக்குப் பாதுகாப்பான இயல்புநிலை உள்ளது — விரும்பினால் மட்டும் மாற்றவும்',
    already_set: 'ஏற்கனவே முடிவு செய்யப்பட்டது',
    yourChoice: 'உங்கள் தேர்வு',
    usingDefault: 'இயல்புநிலை',
    needed: 'திறக்கத் தேவை',
    now: 'இப்போது',
    none: '(எதுவும் இல்லை)',
    on: 'இயக்கம்',
    off: 'அணைப்பு',
    save: 'சேமி',
    saving: 'சேமிக்கிறது…',
    saved: 'சேமிக்கப்பட்டது ✓',
    queued: 'இங்கே சேமிக்கப்பட்டது — இணைப்பு வந்தவுடன் ஒத்திசைக்கும்.',
    failed: 'சேமிக்க முடியவில்லை:',
    retry: 'மீண்டும் முயற்சி',
    conflict: 'நீங்கள் பக்கத்தைத் திறந்த பிறகு யாரோ இதை மாற்றியுள்ளனர்.',
    reload: 'மீண்டும் ஏற்று',
    unsaved: 'சேமிக்கப்படாத மாற்றம்',
    unsavedWarn: 'சேமிக்கப்படாத மாற்றங்கள் உள்ளன. பக்கத்தை விட்டு அவற்றை இழக்கவா?',
    changedBy: 'கடைசியாக அமைத்தவர்',
    readOnly: 'நீங்கள் இதைப் பார்க்கிறீர்கள் — ஒரு நிர்வாகி இதை மாற்றலாம்.',
    noSetup: 'இந்தக் கடையின் அமைப்பு இந்தத் திரைக்கு இன்னும் சொல்லப்படவில்லை.',
  },
};
let lang = 'en';
const t = (key) => WORDS[lang][key] ?? WORDS.en[key];

function readable(value) {
  if (Array.isArray(value)) return value.length === 0 ? t('none') : value.join(', ');
  if (typeof value === 'boolean') return value ? t('on') : t('off');
  return String(value);
}

function sampleSession() {
  return {
    headline: () => ({
      complete: false, answered: 0, total: 2, progressBp: 0,
      blocking: [{ key: 'tax.default_bps', question: 'What default GST rate applies until a category sets its own?' }],
      sentence: '',
    }),
    groups: () => [
      {
        group: 'give_now',
        items: [
          { key: 'tax.default_bps', label: 'Default GST rate', question: 'What default GST rate applies until a category sets its own?', required: true, state: 'blocking', value: 0, isDefault: true, version: 0 },
          { key: 'trading_day.cutoff', label: 'Trading-day cut-off', question: 'When does one trading day end and the next begin?', required: false, state: 'using_default', value: '00:00', isDefault: true, version: 0 },
        ],
      },
    ],
    canEdit: () => false,
  };
}

const editing = window.setupEditing || null;
let session = window.setupSession || sampleSession();
const canEdit = Boolean(editing) && session.canEdit();

function emptyLine(text) {
  const p = document.createElement('p');
  p.className = 'empty';
  p.textContent = text;
  return p;
}

// ── Per-field editing ─────────────────────────────────────────────────────────

function rawOf(control, kind) {
  return kind === 'toggle' ? control.checked : control.value;
}

function initialValue(control, kind, value) {
  if (kind === 'toggle') control.checked = value === true;
  else if (kind === 'list') control.value = Array.isArray(value) ? value.join('\n') : '';
  else control.value = String(value);
}

function makeControl(item) {
  const spec = editing.editorFor(item.key);
  let control;
  if (spec.kind === 'select') {
    control = document.createElement('select');
    for (const opt of spec.options || []) {
      const o = document.createElement('option');
      o.value = opt.id;
      o.textContent = opt.label;
      control.append(o);
    }
  } else if (spec.kind === 'list') {
    control = document.createElement('textarea');
    control.rows = 2;
  } else if (spec.kind === 'toggle') {
    control = document.createElement('input');
    control.type = 'checkbox';
    control.className = 'toggle';
  } else {
    control = document.createElement('input');
    control.type = spec.kind === 'number' || spec.kind === 'decimal' ? 'number'
      : spec.kind === 'time' ? 'time' : 'text';
    if (spec.kind === 'decimal') control.step = 'any';
  }
  control.id = `f-${item.key}`;
  control.setAttribute('aria-labelledby', `q-${item.key}`);
  initialValue(control, spec.kind, item.value);
  return { control, kind: spec.kind };
}

function paintField(key) {
  const fs = editing.controller.state(key);
  const msg = el(`m-${key}`);
  const saveBtn = el(`s-${key}`);
  const retryBtn = el(`r-${key}`);
  if (!msg || !saveBtn) return;

  msg.className = 'fieldmsg';
  retryBtn.hidden = true;
  if (fs.error) {
    msg.textContent = fs.error;
    msg.classList.add('bad');
  } else if (fs.status === 'saving') {
    msg.textContent = t('saving');
  } else if (fs.status === 'saved') {
    msg.textContent = t('saved');
    msg.classList.add('good');
  } else if (fs.status === 'queued') {
    msg.textContent = t('queued');
    msg.classList.add('good');
  } else if (fs.status === 'failed') {
    msg.textContent = `${t('failed')} ${fs.message || ''}`;
    msg.classList.add('bad');
    retryBtn.hidden = false;
    retryBtn.textContent = t('retry');
  } else if (fs.status === 'conflict') {
    msg.textContent = t('conflict');
    msg.classList.add('bad');
    retryBtn.hidden = false;
    retryBtn.textContent = t('reload');
  } else if (fs.dirty) {
    msg.textContent = t('unsaved');
  } else {
    msg.textContent = '';
  }
  // Save is possible only for a clean, changed, not-in-flight draft.
  saveBtn.disabled = fs.status === 'saving' || !fs.dirty || Boolean(fs.error);
  saveBtn.textContent = t('save');
}

function onSave(key) {
  const begun = editing.controller.beginSave(key);
  paintField(key);
  if (!begun.ok) return;
  editing.save(key, begun.value, begun.ifVersion).then((result) => {
    editing.controller.onResult(key, result);
    paintField(key);
    if (result.kind === 'saved' || result.kind === 'queued') {
      editing.reload().then((fresh) => {
        if (fresh) updateReadouts(editing.present(fresh));
      });
    }
  });
}

function onRetry(key) {
  const fs = editing.controller.state(key);
  editing.controller.retry(key);
  if (fs.status === 'conflict') {
    editing.reload().then((fresh) => {
      if (fresh) { session = editing.present(fresh); render(); }
    });
  } else {
    paintField(key);
  }
}

// ── Rendering ──────────────────────────────────────────────────────────────────

function renderHeadline(h) {
  const box = el('headline');
  box.className = `headline ${h.complete ? 'good' : 'warn'}`;
  el('headline-text').textContent = h.complete ? t('ready') : t('notReady');
  el('headline-sub').textContent = `${h.answered} / ${h.total} ${t('progress')}`;
  el('bar-fill').style.width = `${Math.round(h.progressBp / 100)}%`;

  const blocking = el('blocking');
  if (h.blocking.length === 0) {
    blocking.hidden = true;
    el('blocking-list').replaceChildren();
  } else {
    blocking.hidden = false;
    el('blocking-title').textContent = t('stillNeeded');
    el('blocking-list').replaceChildren(...h.blocking.map((b) => {
      const li = document.createElement('li');
      li.textContent = b.question;
      return li;
    }));
  }
}

/** Update the headline, block list and each row's read-outs after a save — without dropping editors. */
function updateReadouts(freshSession) {
  renderHeadline(freshSession.headline());
  for (const group of freshSession.groups()) {
    for (const item of group.items) {
      const valueEl = el(`v-${item.key}`);
      const tagEl = el(`t-${item.key}`);
      if (valueEl) valueEl.textContent = `${t('now')}: ${readable(item.value)}`;
      if (tagEl) tagEl.textContent = item.state === 'blocking' ? t('needed') : item.isDefault ? t('usingDefault') : t('yourChoice');
    }
  }
}

function itemRow(item) {
  const row = document.createElement('div');
  const kind = item.state === 'blocking' ? 'blocked' : item.isDefault ? 'default' : 'answered';
  row.className = `row ${kind}`;

  const what = document.createElement('div');
  what.className = 'what';
  const question = document.createElement('strong');
  question.id = `q-${item.key}`;
  question.textContent = item.question;
  const value = document.createElement('small');
  value.id = `v-${item.key}`;
  value.textContent = `${t('now')}: ${readable(item.value)}`;
  what.append(question, value);
  if (item.changedBy) {
    const audit = document.createElement('small');
    audit.textContent = `${t('changedBy')} ${item.changedBy}${item.changedAt ? ` · ${new Date(item.changedAt).toLocaleString()}` : ''}`;
    what.append(audit);
  }

  const side = document.createElement('div');
  side.className = 'side';
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.id = `t-${item.key}`;
  tag.textContent = item.state === 'blocking' ? t('needed') : item.isDefault ? t('usingDefault') : t('yourChoice');
  side.append(tag);

  if (canEdit) {
    editing.controller.seed(item.key, item.version);
    const { control, kind: editorKind } = makeControl(item);
    const edit = document.createElement('div');
    edit.className = 'edit';

    const saveBtn = document.createElement('button');
    saveBtn.id = `s-${item.key}`;
    saveBtn.type = 'button';
    saveBtn.className = 'primary';
    saveBtn.textContent = t('save');
    saveBtn.disabled = true;

    const retryBtn = document.createElement('button');
    retryBtn.id = `r-${item.key}`;
    retryBtn.type = 'button';
    retryBtn.hidden = true;

    const msg = document.createElement('small');
    msg.id = `m-${item.key}`;
    msg.className = 'fieldmsg';
    msg.setAttribute('role', 'status');
    msg.setAttribute('aria-live', 'polite');

    const onInput = () => { editing.controller.edit(item.key, rawOf(control, editorKind)); paintField(item.key); };
    control.addEventListener('input', onInput);
    control.addEventListener('change', onInput);
    if (editorKind !== 'list' && editorKind !== 'toggle') {
      control.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); onSave(item.key); } });
    }
    saveBtn.addEventListener('click', () => onSave(item.key));
    retryBtn.addEventListener('click', () => onRetry(item.key));

    edit.append(control, saveBtn, retryBtn, msg);
    what.append(edit);
  } else {
    const ro = document.createElement('small');
    ro.className = 'fieldmsg';
    ro.textContent = t('readOnly');
    what.append(ro);
  }

  row.append(what, side);
  return row;
}

function render() {
  renderHeadline(session.headline());
  const groups = session.groups();
  el('groups').replaceChildren(...(groups.length === 0
    ? [emptyLine(t('noSetup'))]
    : groups.map((group) => {
      const wrap = document.createElement('section');
      const heading = document.createElement('h3');
      heading.textContent = t(group.group);
      wrap.append(heading);
      for (const item of group.items) wrap.append(itemRow(item));
      return wrap;
    })));
  // Repaint any field state (e.g. after a language switch re-render).
  if (canEdit) for (const group of groups) for (const item of group.items) paintField(item.key);
}

function paintStale() {
  const at = window.shellCachedAt;
  const strip = el('stale');
  if (!strip) return;
  strip.hidden = at === undefined;
  if (at === undefined) return;
  strip.textContent = `${t('staleShell')} ${new Date(at).toLocaleString()}`;
}

function paintChrome() {
  el('who').firstChild.textContent = `${t('title')} `;
  el('whoami').textContent = window.setupData?.userId ?? '';
  el('sample').textContent = t('sampleData');
  render();
}

el('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ta' : 'en';
  document.documentElement.lang = lang;
  paintChrome();
});
// The stale strip is its own concern, repainted in the reader's new language on a switch.
el('lang').addEventListener('click', paintStale);

// Nothing is lost silently: warn before leaving with an unsaved edit.
window.addEventListener('beforeunload', (e) => {
  if (canEdit && editing.controller.hasUnsavedChanges()) {
    e.preventDefault();
    e.returnValue = t('unsavedWarn');
  }
});

// ── Boot ────────────────────────────────────────────────────────────────────

el('sample').hidden = window.setupSession !== undefined;
paintChrome();
paintStale();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the screen still opens; it just will not be there without a network */
  });
}
