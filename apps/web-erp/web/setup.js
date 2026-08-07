// Store setup — the view layer. Every rule lives in the TESTED session model
// (apps/web-erp/src/setup-session.ts), attached as window.setupSession.
//
// The screen a retailer reads to see how far its own setup has come: a one-line headline saying
// whether the store can open, the list of what is still needed, and every setting with the value
// in force and whether it is the tenant's own choice or a safe default. Read-only for now;
// changing a setting is an audited write through the API (the next increment).
//
// No prompt, confirm or alert.

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
    noSetup: 'This screen has not been told this store’s setup yet.',
    changeNote: 'To change a setting, an administrator edits it here — saved changes are audited and reversible.',
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
    noSetup: 'இந்தக் கடையின் அமைப்பு இந்தத் திரைக்கு இன்னும் சொல்லப்படவில்லை.',
    changeNote: 'ஒரு அமைப்பை மாற்ற, நிர்வாகி இங்கே அதைத் திருத்துவார் — சேமித்த மாற்றங்கள் தணிக்கை செய்யப்பட்டு, மீளக்கூடியவை.',
  },
};
let lang = 'en';
const t = (key) => WORDS[lang][key] ?? WORDS.en[key];

/** A value as a person reads it — a list, an on/off, or the plain value. */
function readable(value) {
  if (Array.isArray(value)) return value.length === 0 ? t('none') : value.join(', ');
  if (typeof value === 'boolean') return value ? t('on') : t('off');
  return String(value);
}

/** A stand-in with the same surface as the bundled session, announced whenever it is in use. */
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
          { key: 'tax.default_bps', label: 'Default GST rate', question: 'What default GST rate applies until a category sets its own?', required: true, state: 'blocking', value: 0, isDefault: true },
          { key: 'trading_day.cutoff', label: 'Trading-day cut-off', question: 'When does one trading day end and the next begin?', required: false, state: 'using_default', value: '00:00', isDefault: true },
        ],
      },
    ],
  };
}

const real = window.setupSession;
const session = real ?? sampleSession();

function emptyLine(text) {
  const p = document.createElement('p');
  p.className = 'empty';
  p.textContent = text;
  return p;
}

function render() {
  const h = session.headline();

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

  const groups = session.groups();
  el('groups').replaceChildren(...(groups.length === 0
    ? [emptyLine(t('noSetup'))]
    : groups.map((group) => {
      const wrap = document.createElement('section');
      const heading = document.createElement('h3');
      heading.textContent = t(group.group);
      wrap.append(heading);
      for (const item of group.items) {
        const row = document.createElement('div');
        // Colour is never alone — the tag says it in words too.
        const kind = item.state === 'blocking' ? 'blocked' : item.isDefault ? 'default' : 'answered';
        row.className = `row ${kind}`;
        const what = document.createElement('span');
        what.className = 'what';
        const question = document.createElement('strong');
        question.textContent = item.question;
        const value = document.createElement('small');
        value.textContent = `${t('now')}: ${readable(item.value)}`;
        what.append(question, value);
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = item.state === 'blocking' ? t('needed') : item.isDefault ? t('usingDefault') : t('yourChoice');
        row.append(what, tag);
        wrap.append(row);
      }
      return wrap;
    })));

  el('change-note').textContent = t('changeNote');
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

// ── Boot ────────────────────────────────────────────────────────────────────

el('sample').hidden = real !== undefined;
paintChrome();
paintStale();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the screen still opens; it just will not be there without a network */
  });
}
