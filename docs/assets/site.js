/* ============================================================================
   Yuvomi - shared script of the GitHub Pages site (yuvomi.cloud)
   ============================================================================

   Loaded by all five pages, right after the footer and before the page's own
   script, so window.YuvomiSite exists when that script runs. It owns the two
   controls the bar shares (assets/site.css, "The bar's controls"):

   THEME. One button cycling System -> Light -> Dark -> System. Until this
   round every page toggled light/dark only, so one click lost "follow my
   system" for good. "System" removes the stored key (and the old oikos-
   one, which lsGet() on the pages still falls back to); light and dark are
   stored as before under yuvomi-theme, which the head script of every page
   reads before the first paint. A page that draws theme-dependent images
   (index.html's screenshots) listens for the "yuvomi:theme" event.

   LANGUAGE BUTTON. On the translated pages (index, install) the page switches
   the language itself and then fires "yuvomi:lang"; this script rewrites the
   button: visible text is the target language, the name starts with it
   (SC 2.5.3). The legal pages' language control is a plain link with static
   text and is left alone. The theme button's name follows the same event.

   No innerHTML anywhere: only attributes and textContent change. */
(function () {
  'use strict';

  var KEY = 'yuvomi-theme', LEGACY = 'oikos-theme';
  var ORDER = ['system', 'light', 'dark'];
  var TEXT = {
    en: { mode: { system: 'system', light: 'light', dark: 'dark' }, label: 'Theme: {cur} - switch to {next}' },
    de: { mode: { system: 'System', light: 'Hell', dark: 'Dunkel' }, label: 'Design: {cur} - zu {next} wechseln' }
  };
  var LANG_NAME = { de: 'DE - Auf Deutsch lesen', en: 'EN - Read in English' };

  var root = document.documentElement;
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function read() {
    try {
      var t = localStorage.getItem(KEY) || localStorage.getItem(LEGACY);
      return t === 'light' || t === 'dark' ? t : 'system';
    } catch (e) { return 'system'; }
  }
  function write(m) {
    try {
      if (m === 'system') { localStorage.removeItem(KEY); localStorage.removeItem(LEGACY); }
      else localStorage.setItem(KEY, m);
    } catch (e) {}
  }

  var mode = read();
  function isDark() { return mode === 'dark' || (mode === 'system' && !!mq && mq.matches); }
  function pageLang() { return (root.lang || 'en').toLowerCase().indexOf('de') === 0 ? 'de' : 'en'; }

  function syncLabels() {
    var s = TEXT[pageLang()];
    var btn = document.getElementById('themeBtn');
    if (btn) {
      var next = ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length];
      var name = s.label.replace('{cur}', s.mode[mode]).replace('{next}', s.mode[next]);
      btn.setAttribute('data-mode', mode);
      btn.setAttribute('aria-label', name);
      btn.setAttribute('title', name);
    }
    var lb = document.getElementById('langBtn');
    if (lb && lb.tagName === 'BUTTON') {
      var target = pageLang() === 'de' ? 'en' : 'de';
      var lbl = lb.querySelector('.nav-lang-label');
      if (lbl) lbl.textContent = target.toUpperCase();
      lb.setAttribute('lang', target);
      lb.setAttribute('aria-label', LANG_NAME[target]);
      lb.setAttribute('title', LANG_NAME[target]);
    }
  }

  function apply() {
    if (mode === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', mode);
    syncLabels();
    document.dispatchEvent(new CustomEvent('yuvomi:theme', { detail: { mode: mode, dark: isDark() } }));
  }

  var btn = document.getElementById('themeBtn');
  if (btn) {
    btn.addEventListener('click', function () {
      mode = ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length];
      write(mode);
      apply();
    });
  }
  /* Following the system means following it live, too. */
  if (mq && mq.addEventListener) {
    mq.addEventListener('change', function () { if (mode === 'system') apply(); });
  }
  document.addEventListener('yuvomi:lang', syncLabels);

  window.YuvomiSite = { isDark: isDark, mode: function () { return mode; } };
  apply();
})();
