/* ============================================================================
   Yuvomi - shared script of the GitHub Pages site (yuvomi.cloud)
   ============================================================================

   Loaded by all five pages with `defer` (S7; before, it blocked the parser
   at the end of the body). It therefore runs AFTER the page's own inline
   script, once the document is parsed: a page script must not need
   window.YuvomiSite at its first run (index.html reads <html data-theme>,
   which the head script sets, until it exists), and a "yuvomi:lang" fired
   before this file ran is not missed - syncLabels() reads <html lang> when
   this script starts. The theme itself never waits for this file: the head
   script of every page sets data-theme before the first paint. It owns the
   two controls the bar shares (assets/site.css, "The bar's controls"):

   THEME. One button cycling System -> Light -> Dark -> System. Until this
   round every page toggled light/dark only, so one click lost "follow my
   system" for good. "System" removes the stored key (and the old oikos-
   one, which lsGet() on the pages still falls back to); light and dark are
   stored as before under yuvomi-theme, which the head script of every page
   reads before the first paint. A page that draws theme-dependent images
   (index.html's screenshots) listens for the "yuvomi:theme" event.

   LANGUAGE SEGMENT. On the translated pages (index, install) the page switches
   the language itself and then fires "yuvomi:lang"; this script moves
   aria-pressed to the segment of the language now read (#langSeg, two
   buttons since S7). Text, name and lang of each segment never change. The
   legal pages' segment is a link plus plain text and is left alone. The
   theme button's name follows the same event.

   Since S2 it also switches the one back-to-top link and sizes the room the
   code plates keep for their copy button (both at the end), since S3 it
   arms the arrivals below the first screen (ARRIVALS, the last block), and
   since S7 it hands focus to the target of an in-page link (IN-PAGE TARGETS).

   No innerHTML anywhere: only attributes and textContent change. */
(function () {
  'use strict';

  var KEY = 'yuvomi-theme', LEGACY = 'oikos-theme';
  var ORDER = ['system', 'light', 'dark'];
  var TEXT = {
    en: { mode: { system: 'system', light: 'light', dark: 'dark' }, label: 'Theme: {cur} - switch to {next}',
      shown: { system: 'System', light: 'Light', dark: 'Dark' } },
    de: { mode: { system: 'System', light: 'Hell', dark: 'Dunkel' }, label: 'Design: {cur} - zu {next} wechseln',
      shown: { system: 'System', light: 'Hell', dark: 'Dunkel' } }
  };

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
      /* The visible word on a wide screen (S4): the mode you are in, which
         the name already starts with after its prefix. */
      var shown = btn.querySelector('.nav-theme-label');
      if (shown) shown.textContent = s.shown[mode];
    }
    var seg = document.querySelectorAll('#langSeg > button[data-lang]');
    for (var i = 0; i < seg.length; i++) {
      seg[i].setAttribute('aria-pressed', String(seg[i].getAttribute('data-lang') === pageLang()));
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
     threshold for all five pages instead of 600px here and 800px there
     (since S4 of the 2026-10-30 critique: half the page, see below).
     Two observers, no scroll handler (S8):
     - a sentinel as tall as max(600px, the first screen) at the top of the
       page: once it has left the viewport, the pill shows;
     - every control of the page, watched through a root shrunk to the
       pill's corner (rootMargin): while one of them lies there, the pill
       yields (.yield). On a phone it covered copy buttons, tabs, the Podman
       switch and summary rows in 17 of 104 scroll positions of the install
       guide. The corner is re-measured when the pill's size changes
       (language) and on resize. */
  var top = document.getElementById('toTop');
  if (top && 'IntersectionObserver' in window) {
    var sentinel = document.createElement('div');
    sentinel.setAttribute('aria-hidden', 'true');
    sentinel.style.cssText = 'position:absolute;top:0;left:0;width:1px;height:max(600px,100vh);pointer-events:none;visibility:hidden';
    document.body.prepend(sentinel);
    /* Late, not after the first screen (S4, Critique 2026-10-30): the pill
       floated over text and cards from the proof line on, on a page the bar's
       jump menu already covers. It comes once half the page lies behind -
       the point where the way back is the longer one. The page grows as
       deferred sections render and with the language, so the half is
       re-read when the body's size changes. */
    var half = function () {
      sentinel.style.height = Math.round(Math.max(600, innerHeight, document.documentElement.scrollHeight * 0.5)) + 'px';
    };
    half();
    addEventListener('resize', half);
    if ('ResizeObserver' in window) new ResizeObserver(half).observe(document.body);
    new IntersectionObserver(function (entries) {
      top.classList.toggle('show', !entries[entries.length - 1].isIntersecting);
    }).observe(sentinel);

    var under = new Set(), cornerObs = null, cornerKey = '';
    var CONTROLS = 'a[href], button, summary, input, select, textarea, [tabindex="0"]';
    var watchCorner = function () {
      var r = top.getBoundingClientRect();
      if (!r.width) return;
      /* The pill's box plus air, measured from the viewport edges: 16px
         above (hidden, it sits 8px lower - translateY), 8px to the left. */
      var key = Math.round(innerHeight - r.top) + '|' + Math.round(innerWidth - r.left);
      if (key === cornerKey) return;
      cornerKey = key;
      if (cornerObs) cornerObs.disconnect();
      under.clear();
      top.classList.remove('yield');
      cornerObs = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) { if (e.isIntersecting) under.add(e.target); else under.delete(e.target); });
        top.classList.toggle('yield', under.size > 0);
      }, { rootMargin: -Math.max(0, Math.round(r.top - 16)) + 'px 0px 0px ' + -Math.max(0, Math.round(r.left - 8)) + 'px' });
      /* The landing page's install pill floats in the same band; it is the
         other capsule, not something underneath to press (they take turns,
         index.html: html.pill-end). */
      Array.prototype.forEach.call(document.querySelectorAll(CONTROLS), function (el) {
        if (el !== top && !top.contains(el) && !el.classList.contains('mobile-cta')) cornerObs.observe(el);
      });
    };
    watchCorner();
    addEventListener('resize', watchCorner);
    if ('ResizeObserver' in window) new ResizeObserver(watchCorner).observe(top);
  } else if (top) {
    top.classList.add('show');
  }

  /* IN-PAGE TARGETS (S7). A link to an anchor on the same page (skip link,
     jump menu, back to top, "See it in action") scrolled, but focus stayed
     on BODY: the next Tab started from the top of the page again, and a
     screen reader announced nothing. The target takes focus now - with
     tabindex=-1 if it is not focusable itself, and preventScroll, because
     the browser's own fragment scroll (scroll-padding included) is the one
     that should run. The ring follows :focus-visible: a mouse click leaves
     none, a keyboard user sees it inside the section (site.css,
     [tabindex="-1"]). Links whose page handles the click itself
     (preventDefault, e.g. install.html's tabs) are left alone. */
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target.closest ? e.target.closest('a[href^="#"]') : null;
    if (!a) return;
    var id = a.getAttribute('href').slice(1);
    var target = null;
    try { target = id && document.getElementById(decodeURIComponent(id)); } catch (err) {}
    if (!target) return;
    if (!target.matches('a[href], button, input, select, textarea, [tabindex]')) target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
  });

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
     to wait 600-750ms for this). Runs once, as a deferred script on the parsed document,
     before the page scrolls anywhere; rects are read before the first class
     is written. Under reduced motion nothing is armed. An observer adds .vis
     once, and the arrival never plays backwards (S6: a scroll-bound timeline
     faded text out again at the bottom edge when the reader scrolled up).
     Without IntersectionObserver nothing is armed, since nothing would show
     it again.
     A candidate inside a section the page defers (content-visibility: auto,
     index.html) is NOT measured: its rect would force the very layout the
     deferral saves. The section's own box stands in for it, and the row
     columns (--i) are counted when the section starts to render. */
  (function () {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (!('IntersectionObserver' in window)) return;
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
      if (n.matches('.gal-item, .fam-phone')) n.classList.add('rv-media');
    });
    if (!armed.length) return;
    var obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('vis'); obs.unobserve(e.target); }
      });
    }, { threshold: 0.08, rootMargin: '0px 0px -40px 0px' });
    armed.forEach(function (n) { obs.observe(n); });
  })();
})();
