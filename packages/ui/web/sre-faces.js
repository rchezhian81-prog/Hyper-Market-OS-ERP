// SRE Retail OS — load the two self-hosted faces as a screen opens (OB-728 emerald and gold · P-01 · hard rule #1).
//
// Source of truth: packages/ui/web/sre-faces.js; every store screen carries a byte-identical copy written by
// `node scripts/sync-ui-foundation.mjs`, precached by its service worker, and linked by every page before its own scripts.
//
// Why: a browser asks for a face only when a word first needs it. Without this, the first rupee sign on a till line (Anek
// Tamil) or the first bold word was read from the screen's cache IN THE MIDDLE OF A SCAN — a request during a sale, which
// the till must never make. So every face is asked for here, once, while the screen opens, and a scan asks for nothing.
// The files come from the screen's own folder (its service worker's cache); nothing is fetched from the internet. A shell
// that keeps the phone's own faces (`<html class="sre-system-type">`, the customer app, OB-729) asks for none.
(function warmTheFaces() {
  'use strict';
  try {
    var doc = document;
    if (!doc.fonts || typeof doc.fonts.load !== 'function') return;
    if (doc.documentElement.classList.contains('sre-system-type')) return;
    var faces = [
      ['Plus Jakarta Sans', [400, 500, 600, 700, 800], 'Aa'],
      ['Anek Tamil', [400, 500, 600, 700], '₹த'],
    ];
    faces.forEach(function (face) {
      face[1].forEach(function (weight) {
        doc.fonts.load(weight + ' 16px "' + face[0] + '"', face[2]).catch(function () { /* the system face stays: never an error */ });
      });
    });
  } catch { /* no face is worth a broken screen */ }
})();
