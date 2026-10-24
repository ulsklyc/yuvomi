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

   Since S2 it also switches the one back-to-top link and sizes the room the
   code plates keep for their copy button (both at the end), and since S3 it
   arms the arrivals below the first screen (ARRIVALS, the last block).

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

  /* BACK TO TOP (assets/site.css, "Back to top"). Every page carries the
     link (#toTop); it shows once the first screen has scrolled away. One
     threshold for all five pages instead of 600px here and 800px there. */
  var top = document.getElementById('toTop');
  if (top) {
    var syncTop = function () { top.classList.toggle('show', window.scrollY > Math.max(600, window.innerHeight)); };
    addEventListener('scroll', syncTop, { passive: true });
    addEventListener('resize', syncTop);
    syncTop();
  }

  /* COPY BUTTON ROOM. The plate's text flows around an empty float the size
     of its copy button (assets/site.css, the code plate). The button's width
     changes with the language and with its Copied/failed state, so each
     wrapper carries it as --copy-w. Without ResizeObserver the CSS fallback
     holds. */
  if ('ResizeObserver' in window) {
    var ro = new ResizeObserver(function (entries) {
      entries.forEach(function (e) {
        var w = e.target.offsetWidth;
        if (w) e.target.parentElement.style.setProperty('--copy-w', w + 'px');
      });
    });
    document.querySelectorAll('.code-wrap > .copy-btn').forEach(function (b) { ro.observe(b); });
  }

  /* ARRIVALS (assets/site.css, "Arrivals"). A .reveal candidate is armed
     (.rv) only if it starts below the first screen: what the visitor sees on
     arrival is never held back (S3 - the install guide's LCP paragraph used
     to wait 600-750ms for this). Runs once, here at the end of the body,
     before the page scrolls anywhere; rects are read before the first class
     is written. Under reduced motion nothing is armed. With scroll-driven
     animations the CSS plays the arrival on the scroll position; otherwise
     an observer adds .vis once. With neither, nothing is armed, since
     nothing would show it again.
     A candidate inside a section the page defers (content-visibility: auto,
     index.html) is NOT measured: its rect would force the very layout the
     deferral saves. The section's own box stands in for it, and the row
     columns (--i) are counted when the section starts to render. */
  (function () {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var sda = !!(window.CSS && CSS.supports && CSS.supports('(animation-timeline: view()) and (animation-range: entry)'));
    if (!sda && !('IntersectionObserver' in window)) return;
    var fold = window.innerHeight, seen = new Map(), later = new Map(), armed = [];
    function deferredBy(n) {
      for (var p = n.parentElement; p && p !== document.body; p = p.parentElement) {
        if (!seen.has(p)) seen.set(p, getComputedStyle(p).contentVisibility === 'auto');
        if (seen.get(p)) return p;
      }
      return null;
    }
    /* Column in its row: earlier candidate siblings on the same line. A
       single-column list stays at 0 - no wave down a list. */
    function columns(list) {
      var rects = list.map(function (n) { return n.getBoundingClientRect(); });
      list.forEach(function (n, k) {
        var col = 0;
        for (var p = n.previousElementSibling; p; p = p.previousElementSibling) {
          var j = list.indexOf(p);
          if (j >= 0 && Math.abs(rects[j].top - rects[k].top) < 4) col++;
        }
        if (col) n.style.setProperty('--i', Math.min(col, 5));
      });
    }
    var direct = [];
    Array.prototype.forEach.call(document.querySelectorAll('.reveal'), function (n) {
      var host = deferredBy(n);
      if (!host) { direct.push(n); return; }
      if (!later.has(host)) later.set(host, []);
      later.get(host).push(n);
    });
    var rects = direct.map(function (n) { return n.getBoundingClientRect(); });
    var hostTop = new Map();
    later.forEach(function (list, host) { hostTop.set(host, host.getBoundingClientRect().top); });
    var below = direct.filter(function (n, k) { return rects[k].height && rects[k].top >= fold; });
    armed.push.apply(armed, below);
    later.forEach(function (list, host) {
      if (hostTop.get(host) < fold) return;
      armed.push.apply(armed, list);
      host.addEventListener('contentvisibilityautostatechange', function once(e) {
        if (e.skipped) return;
        host.removeEventListener('contentvisibilityautostatechange', once);
        columns(list);
      });
    });
    columns(below);
    armed.forEach(function (n) {
      n.classList.add('rv');
      if (n.matches('.gal-item, .fam-shot')) n.classList.add('rv-media');
    });
    if (sda || !armed.length) return;
    var obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('vis'); obs.unobserve(e.target); }
      });
    }, { threshold: 0.08, rootMargin: '0px 0px -40px 0px' });
    armed.forEach(function (n) { obs.observe(n); });
  })();
})();
