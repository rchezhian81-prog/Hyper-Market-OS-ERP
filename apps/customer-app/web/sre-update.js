// The "new version" strip for every screen outside the back office — the till, the handhelds, the portals (UX-1b, OB-13).
//
// Each screen's service worker serves the shell cache-first under a name that is a digest of the shell (RL-1). When a
// deploy changes the shell, the next visit installs the new worker, which takes over the open page: `controllerchange`.
// That must never be a silent swap (a cashier mid-sale) and never a silent stale (P-08) — so this says it, once, with a
// Reload button, in the reader's language, and leaves the choice to the person. The very first install is not news.
//
// Source of truth: packages/ui/web/sre-update.js. Each `apps/<app>/web/` outside the back office gets a byte-identical,
// TRACKED copy from scripts/sync-ui-foundation.mjs (the same way as sre-foundation.css) and precaches it in its
// worker's SHELL, so the strip itself opens with no network. The back office draws the same strip from sre-chrome.js.
(() => {
  const WORDS = {
    en: { newVersion: 'A newer version of this screen has arrived. Reload when you are ready.', reload: 'Reload' },
    ta: { newVersion: 'இந்தத் திரையின் புதிய பதிப்பு வந்துள்ளது. தயாரானதும் மீண்டும் ஏற்றவும்.', reload: 'மீண்டும் ஏற்று' },
  };
  const lang = () => (document.documentElement.lang === 'ta' ? 'ta' : 'en');
  const t = (key) => WORDS[lang()][key] ?? WORDS.en[key];
  let updateReady = false;

  function paint() {
    let strip = document.getElementById('sre-update');
    if (!updateReady) { if (strip) strip.remove(); return; }
    if (!strip) {
      strip = document.createElement('p');
      strip.id = 'sre-update';
      strip.className = 'stale sre-update';
      strip.setAttribute('role', 'status');
      const words = document.createElement('span');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sre-btn';
      button.addEventListener('click', () => window.location.reload());
      strip.append(words, button);
      document.body.prepend(strip);
    }
    strip.firstElementChild.textContent = t('newVersion');
    strip.lastElementChild.textContent = t('reload');
  }

  if ('serviceWorker' in navigator) {
    let hadController = navigator.serviceWorker.controller !== null;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) { updateReady = true; paint(); }
      hadController = true;
    });
  }
  // The language switch on every shell flips <html lang>; the strip follows it.
  new MutationObserver(paint).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });

  window.sreUpdate = { ready: () => updateReady, paint };
})();
