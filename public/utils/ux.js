/**
 * Modul: UX Utilities
 * Zweck: Wiederverwendbare Animationshelfer (Stagger, Vibration)
 * Abhängigkeiten: keine
 */

/**
 * Gestaffeltes Einblenden einer NodeList oder eines Arrays von Elementen.
 * Maximal MAX_STAGGER Elemente werden verzögert, der Rest sofort eingeblendet.
 *
 * @param {NodeList|Element[]} elements
 * @param {Object} [opts]
 * @param {number} [opts.delay=30]     - ms zwischen jedem Element
 * @param {number} [opts.duration=180] - ms pro Element
 * @param {number} [opts.max=5]        - Maximale Anzahl gestaffelter Elemente
 */
export function stagger(elements, { delay = 30, duration = 180, max = 5 } = {}) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const els = Array.from(elements);
  els.forEach((el, i) => {
    const itemDelay = i < max ? i * delay : max * delay;
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    el.style.transition = `opacity ${duration}ms ease, transform ${duration}ms ease`;
    // Zurückgelesen statt als Literal verglichen: der Browser serialisiert
    // Inline-Werte selbst, und nur so erkennt das Aufräumen seine eigenen.
    const own = { opacity: el.style.opacity, transform: el.style.transform, transition: el.style.transition };
    setTimeout(() => {
      // DAS EINBLENDEN ENDET AUF DEM STYLESHEET, NICHT AUF EINEM INLINE-WERT
      // (#1230). Hier stand `opacity = '1'`, und das blieb inline stehen: es
      // schlug jede Zustandsregel der Zeile selbst - `.shopping-item--checked`
      // griff nur unter prefers-reduced-motion, die Drag-Geister
      // (`.sortable-ghost`) blieben deckend. Das Leeren blendet über die noch
      // stehende Transition auf den Wert des Stylesheets ein. Geräumt wird nur,
      // was noch der eigene Wert ist - eine Wischgeste kann inzwischen ihr
      // eigenes transform gesetzt haben.
      if (el.style.opacity === own.opacity) el.style.opacity = '';
      if (el.style.transform === own.transform) el.style.transform = '';
      setTimeout(() => {
        if (el.style.transition === own.transition) el.style.transition = '';
      }, duration);
    }, itemDelay);
  });
}

/**
 * Vibrationsmuster abspielen, wenn die API verfügbar ist und
 * keine reduzierte Bewegung gewünscht wird.
 *
 * @param {number|number[]} pattern - ms oder [an, aus, an, ...]-Array
 */
export function vibrate(pattern) {
  if (!navigator.vibrate) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  navigator.vibrate(pattern);
}

/**
 * Wartet, bis eine Quittungs-Animation auf `el` ausgespielt ist.
 *
 * DER ANLASS (Critique 2026-08-28, P0): das Abhaken einer Aufgabe zeigte nie
 * eine Quittung, obwohl `check-pop` an `.task-status-btn--done` verdrahtet ist
 * (tasks.css:703). Gemessen feuerte sie in 0 von 6 Versuchen. Der Grund war
 * kein fehlendes Bauteil, sondern ein WETTLAUF: die Klasse wurde gesetzt, und
 * der Re-Render der Liste ersetzte das Element, bevor die 200ms einen Frame
 * bekamen. Eine gebaute Animation, die nie zu sehen ist, ist teurer als keine -
 * sie sieht im Stylesheet nach erledigter Arbeit aus.
 *
 * DER FALLBACK IST PFLICHT, NICHT VORSICHT: unter `prefers-reduced-motion`
 * feuert `animationend` NIE, weil es gar keine Animation gibt (dieselbe Lehre
 * wie bei `transitionend` in detail-view.js:250 und router.js:1554). Ohne den
 * Timer bliebe der Aufrufer dort für immer hängen.
 *
 * Der Rückgabewert ist bewusst ein Promise und kein Callback: der Aufrufer
 * startet ihn VOR seinem Server-Roundtrip und wartet danach auf beides. So
 * kostet die Quittung keine zusätzliche Zeit, solange das Netz langsamer ist
 * als sie - und sie bleibt sichtbar, wenn es schneller ist.
 *
 * @param {Element} el                 - Element, das die Animation trägt
 * @param {Object} [opts]
 * @param {number} [opts.fallback=260] - ms, nach denen ohne Event aufgelöst wird
 * @returns {Promise<void>}
 */
export function animationSettled(el, { fallback = 260 } = {}) {
  if (!el) return Promise.resolve();
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      el.removeEventListener('animationend', finish);
      resolve();
    };
    el.addEventListener('animationend', finish, { once: true });
    setTimeout(finish, fallback);
  });
}

// --------------------------------------------------------
// Verzögertes Löschen mit Undo-Fenster (kanonisches Muster, Audit F-13)
// --------------------------------------------------------

const _pendingDeletes = new Set();
let _deleteFlushBound = false;

function bindDeleteFlush() {
  if (_deleteFlushBound) return;
  _deleteFlushBound = true;
  // Tab-Schließen/Reload innerhalb des Undo-Fensters: offene Löschungen sofort
  // mit keepalive-Fetch abschicken, statt sie stillschweigend zu verlieren —
  // sonst „kam der Eintrag zurück", obwohl die UI ihn längst entfernt hatte.
  window.addEventListener('pagehide', () => {
    for (const entry of [..._pendingDeletes]) entry.flush();
  });
}

/**
 * Kanonisches Undo-Löschmuster: UI sofort aktualisieren (macht der Aufrufer),
 * Server-Delete erst nach Ablauf des Undo-Fensters. Deckt die Lücke des
 * bisherigen Inline-Musters: bei Reload/Tab-Schließen im Fenster wird der
 * Delete jetzt per keepalive nachgereicht statt verloren.
 *
 * @param {Object} opts
 * @param {(ctx: { keepalive: boolean }) => Promise<void>} opts.commit
 *        Führt den Server-Delete aus; ctx.keepalive an api.delete durchreichen.
 * @param {(err?: Error) => void} [opts.restore]
 *        Stellt die UI wieder her — bei Undo (ohne err) und bei fehl-
 *        geschlagenem Commit (mit err; dort auch Fehlermeldung zeigen).
 * @param {string} opts.message  - Toast-Text
 * @param {number} [opts.duration=5000] - Undo-Fenster in ms
 * @param {boolean} [opts.restoreOnKeepaliveError=false]
 *        Stellt auch nach einem fehlgeschlagenen pagehide-Commit wieder her.
 *        Nur für Zustände verwenden, die aus der Browser-Cache zurückkehren
 *        können und deren Restore keine abgehängte Ansicht voraussetzt.
 */
export function scheduleUndoableDelete({
  commit,
  restore,
  message,
  duration = 5000,
  restoreOnKeepaliveError = false,
}) {
  bindDeleteFlush();
  let settled = false;
  const entry = {};
  const finish = async ({ keepalive = false } = {}) => {
    if (settled) return;
    settled = true;
    _pendingDeletes.delete(entry);
    clearTimeout(entry.timer);
    try {
      await commit({ keepalive });
    } catch (err) {
      // Die meisten Ansichten sind bei pagehide weg. Zustände, die aus der
      // Browser-Cache zurückkehren können, dürfen das Restore gezielt erlauben.
      if (!keepalive || restoreOnKeepaliveError) restore?.(err);
    }
  };
  entry.flush = () => { finish({ keepalive: true }); };
  entry.timer = setTimeout(() => finish(), duration);
  _pendingDeletes.add(entry);
  window.yuvomi?.showToast(message, 'default', duration, () => {
    if (settled) return;
    settled = true;
    _pendingDeletes.delete(entry);
    clearTimeout(entry.timer);
    restore?.();
  });
}

/**
 * Scroll-Affordanz für überlaufende Leisten und Listen (Audit F-01/F-06):
 * setzt `has-fade-start`/`has-fade-end` auf dem Element, solange in der
 * jeweiligen Richtung verborgener Inhalt liegt. Die zugehörigen Masken liegen
 * im CSS des Aufrufers (z. B. budget.css Tabs, layout.css Sidebar).
 *
 * Reagiert auf Scroll, Größenänderungen (ResizeObserver: Viewport-Resize,
 * Ein-/Ausklappen, Font-Nachladen) UND Inhaltswechsel (MutationObserver:
 * Re-Render via replaceChildren/insertAdjacentHTML ändert scrollWidth, ohne
 * dass sich die Elementgröße ändert — der RO allein sähe das nicht).
 *
 * @param {HTMLElement} el
 * @param {Object} [opts]
 * @param {'x'|'y'} [opts.axis='x']
 * @returns {{ update: () => void, destroy: () => void }}
 */
export function wireScrollFade(el, { axis = 'x' } = {}) {
  if (!el) return { update: () => {}, destroy: () => {} };
  // Marker für die geteilte Scroll-Affordanz-Regel (filter-chip.css): die Maske
  // allein reicht nicht, die Leiste braucht auch ein Scroll-Polster, damit ein
  // per scrollIntoView angesteuertes Element nicht bündig an der Kante klebt
  // und den Nachbarn wortmittig abschneidet. Der Marker sitzt hier statt in
  // jedem Modul-CSS, damit die Regel jede Leiste erfasst, die diesen Helfer
  // nutzt - auch die, die es noch nicht gibt.
  el.classList.add('u-scroll-fade');
  // Toleranz gegen Sub-Pixel und DPR-Rundung. Sie stand auf 8 und schluckte
  // damit ECHTE 1-8px-Ueberlaeufe: das Kalender-Segment lief in `uk` bei
  // 375px 4px ueber - vom letzten Wort war der Abschluss weg, und die Leiste
  // trug trotzdem keinen End-Fade (Sonde 20). 2px decken Rundung; ein
  // Ueberlauf darueber ist Inhalt, kein Offset.
  const eps = 2;
  // Sub-Pixel-Schwelle fuer die POSITION. Sie ist bewusst kleiner als `eps`:
  // siehe die Trennung der beiden Fragen im `update` darunter.
  const posEps = 0.5;
  const update = () => {
    // `Math.abs` wegen RTL: in `ar` und `fa` setzt die App `dir=rtl`, und dort
    // steht `scrollLeft` nach CSSOM am Anfang auf 0 und laeuft beim Scrollen ins
    // NEGATIVE. Ohne den Betrag waere `pos > eps` nie wahr und `pos < max - eps`
    // immer - der Anfangs-Fade kaeme nie, der End-Fade ginge nie weg. Die
    // Klassennamen sind schon logisch (start/end), die Messung war es nicht.
    const pos = axis === 'y' ? el.scrollTop : Math.abs(el.scrollLeft);
    const max = axis === 'y'
      ? el.scrollHeight - el.clientHeight
      : el.scrollWidth - el.clientWidth;

    // ZWEI FRAGEN, ZWEI SCHWELLEN - und die Vermischung war der Fehler.
    //
    // `eps` beantwortet „laeuft die Leiste UEBERHAUPT ueber?"; das ist die
    // Frage, fuer die eine Rundungstoleranz gedacht ist. Wurde sie mit Ja
    // beantwortet, entscheidet die POSITION, welche Seite noch etwas verbirgt -
    // und dort ist dieselbe Toleranz falsch, weil sie von BEIDEN Seiten
    // abgezogen wird.
    //
    // GEMESSEN, und der Fall stand schon einmal im Kommentar darueber, ohne
    // behoben zu sein: das Kalender-Segment laeuft in `uk` bei 375px 4px ueber
    // und stand bei `scrollLeft` 2 (die Tablist scrollt ihr aktives Element in
    // den Blick). Damit war `pos > eps` falsch (2 > 2) UND `pos < max - eps`
    // falsch (2 < 2) - die Leiste galt gleichzeitig als „am Anfang" und „am
    // Ende" und trug keinen einzigen Fade, obwohl links wie rechts je 2px
    // verborgen waren. Bei jedem Ueberlauf bis 2*eps passiert das; die
    // Korrektur von 8 auf 2 hat das Fenster nur verkleinert, nicht geschlossen.
    //
    // Sonde 20 verlangt genau diese Invariante: laeuft eine Kopf-Leiste ueber,
    // traegt sie mindestens einen Fade.
    if (max <= eps) {
      el.classList.remove('has-fade-start', 'has-fade-end');
      return;
    }
    el.classList.toggle('has-fade-start', pos > posEps);
    el.classList.toggle('has-fade-end', max - pos > posEps);
  };
  el.addEventListener('scroll', update, { passive: true });
  const ro = new ResizeObserver(update);
  ro.observe(el);
  const mo = new MutationObserver(update);
  mo.observe(el, { childList: true, subtree: true });
  update();
  return {
    update,
    destroy: () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
      mo.disconnect();
    },
  };
}

/**
 * Kollabierende Large-Title-Leiste (HIG, Redesign Runde 4 / C-1).
 *
 * Der Modulkopf steht mobil in mehreren Zeilen: Large Title, darunter der
 * Center-Slot (Suche oder Zeitraum-Navigation), zuunterst die Bar-Zeile mit
 * den Aktionen. Beim Scrollen verliert der Kopf seine Large-Title-Zeile; der
 * Titel steht danach im Inline-Schnitt in der Bar-Zeile - genau Apples
 * Verhalten, wo der Large Title in die Navigationsleiste hineinschrumpft und
 * die Leiste dabei ihre Trennlinie bekommt.
 *
 * DIE APP HAT ZWEI SCROLLPORT-ARCHITEKTUREN, und der Kopf braucht in jeder
 * einen anderen Mechanismus. Gemessen, nicht vermutet:
 *
 *   (1) DIE SEITE SCROLLT (Aufgaben, Geburtstage, Dokumente, Belohnungen,
 *       Haushaltshilfe): der Kopf liegt IM Scrollport. Er dockt per NEGATIVEM
 *       `top` an - `--page-toolbar-lead` ist die Höhe der Zeilen über der
 *       letzten, also klebt er erst, wenn diese aus dem Bild gewandert sind.
 *       Seine Höhe ändert sich dabei NIE. Das ist wichtig: ein Klassen-
 *       Umschalter, der Zeilen ausblendet, verkürzt ein Element im Fluss, der
 *       Inhalt darunter rutscht nach, der Scroll-Offset verschiebt sich, die
 *       Schwelle wird wieder unterschritten - und der Kopf oszilliert.
 *       Was in der Lead-Zone steht, wandert mit aus dem Bild; bei diesen fünf
 *       Modulen ist das die Suche, also genau Apples
 *       `hidesSearchBarWhenScrolling`.
 *
 *   (2) EINE INNERE LISTE SCROLLT (Budget, Kalender, Notizen, Kontakte): der
 *       Modul-Root ist `overflow: hidden`, der Kopf liegt AUSSERHALB des
 *       Scrollports und bewegt sich nie. Dort wirkt kein `top` - hier ist der
 *       Klassen-Umschalter richtig, und zwar gefahrlos: der Höhenwechsel
 *       verlängert nur den inneren Port, ohne dessen Scroll-Offset anzufassen.
 *       Es kollabiert allein die Large-Title-Zeile; der Center-Slot bleibt,
 *       weil er hier den Zeitraum der Seite trägt (Monat, Datum) und nicht
 *       eine Suche.
 *
 * Gehalten wird der Zustand über einen ResizeObserver (Umbruch, Fenstergröße,
 * Font-Nachladen) und einen MutationObserver (Modul rendert seinen Kopfinhalt
 * neu). `is-docked` trägt allein die Trennlinie und ändert keine Geometrie.
 *
 * DAS ABSENDER-SIEGEL GEHÖRT AUS DEMSELBEN GRUND HIERHER wie der angedockte
 * Titel: es ist Teil der Kopf-STRUKTUR, nicht des Modulinhalts. Die
 * Herkunfts-Regel (Block 2) gibt jedem Kopf genau EIN Siegel als Absender -
 * eine Zusage, die nur halten kann, wer das Siegel selbst anlegt. Setzte jedes
 * Modul es in sein eigenes Markup, wäre „genau eines" eine Bitte an siebzehn
 * Dateien; hier ist es eine Eigenschaft des Bauteils. Wo kein Seitentitel steht
 * (die Gruppen-Variante der Küche), steht auch kein Absender: der Kopf benennt
 * dort nichts, was einen Absender hätte.
 *
 * @param {HTMLElement} toolbar - eine `.page-toolbar`
 * @param {{ sealIcon?: () => SVGElement|null }} [opts] - `sealIcon` liefert das
 *   Icon des Absender-Siegels (Fabrik über moduleIconEl). Ohne die Angabe bleibt
 *   der Kopf siegellos.
 * @returns {{ update: () => void, destroy: () => void }|null}
 */
export function wireCollapsingHeader(toolbar, opts = {}) {
  const noop = { update: () => {}, destroy: () => {} };
  if (!toolbar) return null;
  // Idempotent: Router und Modul dürfen beide verdrahten wollen.
  if (toolbar.dataset.collapsingHeader) return noop;
  toolbar.dataset.collapsingHeader = '1';

  const scrollport = (() => {
    let el = toolbar.parentElement;
    while (el && el !== document.body) {
      const oy = getComputedStyle(el).overflowY;
      if (oy === 'auto' || oy === 'scroll') return el;
      el = el.parentElement;
    }
    return null;
  })();

  // Architektur (2): liegt zwischen Kopf und Scrollport ein gedeckelter
  // Container, scrollt der Kopf nicht mit. Der erste solche Vorfahr ist der
  // Modul-Root und trägt den Scroll-Lauscher.
  const capped = (() => {
    let el = toolbar.parentElement;
    while (el && el !== scrollport && el !== document.body) {
      if (getComputedStyle(el).overflowY === 'hidden') return el;
      el = el.parentElement;
    }
    return null;
  })();

  let io = null;
  let lead = 0;
  let dockTitle = null;
  let headSeal = null;

  // DAS ABSENDER-SIEGEL: genau eines, unmittelbar vor dem Seitentitel.
  //
  // Es hängt am TITEL, nicht am Kopf: wo kein Seitentitel steht, hat der Kopf
  // keinen Absender zu führen. Das ist dieselbe Abgrenzung, die die
  // Leisten-Regel zieht - trägt eine Leiste den Modulnamen (Küche), ist SIE die
  // Kopf-Navigation, und der Kopf darunter benennt nur noch die offene Liste.
  //
  // Vor dem Titel und nicht dahinter, weil ein Absender vor dem steht, was er
  // ausweist; in RTL dreht `flex-direction` die Zeile ohnehin mit.
  const syncHeadSeal = () => {
    const heading = toolbar.classList.contains('page-toolbar--in-group')
      ? null
      : toolbar.querySelector(':scope > .page-toolbar__title');
    if (!opts.sealIcon || !heading) {
      headSeal?.remove();
      return;
    }
    if (!headSeal) {
      const icon = opts.sealIcon();
      if (!icon) return;
      headSeal = document.createElement('span');
      headSeal.className = 'module-seal module-seal--head';
      // Dekor im strengen Sinn: den Modulnamen führt der Titel daneben, und
      // die Navigation führt ihn ein zweites Mal. Ein Alternativtext hier wäre
      // die dritte Ansage desselben Wortes.
      headSeal.setAttribute('aria-hidden', 'true');
      headSeal.appendChild(icon);
    }
    // NUR SCHREIBEN, WENN SICH ETWAS ÄNDERT - derselbe Grund wie beim
    // angedockten Titel: der MutationObserver unten beobachtet diesen Teilbaum
    // und ruft `update` erneut auf.
    if (headSeal.parentElement !== toolbar || headSeal.nextElementSibling !== heading) {
      toolbar.insertBefore(headSeal, heading);
    }
  };

  // Hysterese, damit der Kopf nicht um seine eigene Schwelle flattert.
  const onInnerScroll = (e) => {
    const port = e.target;
    if (!(port instanceof Element) || port === toolbar || toolbar.contains(port)) return;
    const reserve = port.scrollHeight - port.clientHeight;
    // EIN WAAGERECHTER STREIFEN IST NICHT DER SCROLLPORT DER SEITE. Der
    // Lauscher haengt in der Capture-Phase am Modul-Root und faengt damit auch
    // die Scroll-Ereignisse der Filterreihen und Listen-Tabs ab. Senkrecht
    // haben die keine Reserve, also landete jeder Filterwisch im Ruecksetzer
    // darunter: der Kopf klappte auf, obwohl die Liste gescrollt blieb, und
    // blieb es bis zum naechsten senkrechten Scroll. Wer waagerecht Reserve
    // hat und senkrecht keine, ist nicht gemeint.
    if (reserve <= 0 && port.scrollWidth > port.clientWidth) return;
    // Nur kollabieren, wenn der Port das Ausklappen danach auch verkraftet -
    // sonst schiebt die zurückkehrende Kopfhöhe den Scroll auf 0, der Kopf
    // klappt wieder aus und beides pendelt gegeneinander.
    if (reserve < lead + 48) { toolbar.classList.remove('is-collapsed', 'is-docked'); return; }
    const top = port.scrollTop;
    if (top > 24) toolbar.classList.add('is-collapsed', 'is-docked');
    else if (top < 8) toolbar.classList.remove('is-collapsed', 'is-docked');
  };
  const update = () => {
    // VOR der Messung: das Siegel steht in der Titelzeile und zählt zu ihr.
    // Danach angehängt, hätte die Zeilenmessung eine Zeile ohne es gesehen.
    syncHeadSeal();
    // Im kollabierten Zustand ist der Kopf einzeilig - eine Messung würde jetzt
    // lead 0 ergeben und dem CSS die Grundlage entziehen, die es zum Ausklappen
    // braucht. Der Wert der ausgeklappten Form bleibt stehen.
    if (toolbar.classList.contains('is-collapsed')) return;
    // EIN KASTEN OHNE HÖHE MACHT KEINE ZEILE AUF. Ein leerer Slot bleibt im
    // Markup stehen (das Modul füllt ihn je nach Zustand) und sitzt als
    // Flex-Item mit Höhe 0 unter seinen Geschwistern - die Zeilenmessung unten
    // vergleicht nur `top` und hielt ihn deshalb für eine zweite Zeile. Bei
    // den Rezepten ergab das 24px Lead-Zone auf einem einzeiligen Kopf, und
    // damit ein `--stacked`, das seine Trennlinie dauerhaft verbarg.
    // Der angedockte Titel ist von der Messung AUSGENOMMEN: er ist ihr
    // Ergebnis, nicht ihr Gegenstand. Zählte er mit, würde die Zeilenordnung
    // davon abhängen, ob der Kopf gerade angedockt ist - und die Schwelle, an
    // der er andockt, hinge an ihm selbst.
    const rows = [...toolbar.children].filter(
      (c) => c !== dockTitle
        && (c.offsetParent !== null || c.getClientRects().length)
        && c.getBoundingClientRect().height > 0,
    );
    const tb = toolbar.getBoundingClientRect();
    const padTop = parseFloat(getComputedStyle(toolbar).paddingBlockStart) || 0;
    // WAS EINE ZEILE IST, ENTSCHEIDET DIE ÜBERLAPPUNG, NICHT DIE OBERKANTE.
    // Ein Vergleich der `top`-Werte hält jeden vertikalen Versatz für einen
    // Umbruch: Flex-Items unterschiedlicher Höhe sitzen mittig ausgerichtet
    // nebeneinander und beginnen dabei bis zu 15px auseinander. Auf Desktop
    // trugen dadurch 11 von 14 Köpfen ein `--stacked`, obwohl ihr Inhalt in
    // EINER Zeile stand - folgenlos nur deshalb, weil jede Regel dazu in der
    // kompakten Grössenklasse steht. Zwei Kästen stehen auf derselben Zeile,
    // wenn sich ihre vertikalen Intervalle überlappen; die Lead-Zone ist die
    // Oberkante der letzten so gebildeten Zeile.
    const boxes = rows
      .map((c) => {
        const r = c.getBoundingClientRect();
        return { el: c, top: r.top - tb.top, bottom: r.bottom - tb.top };
      })
      .sort((a, b) => a.top - b.top);
    const lines = [];
    for (const b of boxes) {
      const line = lines.find((l) => b.top < l.bottom - 1 && b.bottom > l.top + 1);
      if (line) {
        line.top = Math.min(line.top, b.top);
        line.bottom = Math.max(line.bottom, b.bottom);
        line.els.push(b.el);
      } else {
        lines.push({ top: b.top, bottom: b.bottom, els: [b.el] });
      }
    }
    // Die letzte Zeile ist die mit dem grössten Abstand zur Oberkante. Bei
    // einem einzeiligen Kopf ist das die erste - lead wird 0 und die Leiste
    // klebt wie zuvor bei top:0.
    const lastTop = lines.length ? lines[lines.length - 1].top : 0;
    // `firstEl` ist der beobachtete Zeuge der ERSTEN Zeile. Von mehreren
    // Kästen darin trägt der höchste die Kante, an der das Andocken hängt.
    const firstEl = lines.length
      ? lines[0].els.reduce((a, b) => (b.getBoundingClientRect().height > a.getBoundingClientRect().height ? b : a))
      : null;
    lead = Math.max(0, Math.round(lastTop - padTop));
    toolbar.style.setProperty('--page-toolbar-lead', `${lead}px`);
    toolbar.classList.toggle('page-toolbar--stacked', lead > 0);
    toolbar.classList.toggle('page-toolbar--capped', Boolean(capped) && lead > 0);

    // DER ANGEDOCKTE TITEL - nur in der scrollenden Architektur.
    //
    // Dort wandert der Large Title aus dem Bild, statt einzuklappen: die Höhe
    // des Kopfes darf sich nicht ändern (Begründung am negativen `top` oben),
    // und ein schrumpfender Titel wäre genau das. Übrig blieb eine Leiste aus
    // Icons, die nicht mehr beantwortet, wo man ist - der Zweck, für den ein
    // kollabierender Titel überhaupt existiert. In der gedeckelten Architektur
    // stellt sich die Frage nicht; dort klappt der echte Titel ein.
    //
    // Apples Antwort ist der zweite, kleine Titel IN der Leiste. Hier trägt ihn
    // ein eigenes Element, weil das <h1> in der Lead-Zone bleiben muss: es wird
    // nur angedockt sichtbar und macht mit `flex-basis: 0` (layout.css) nie
    // eine eigene Zeile auf - die einmal gemessene Lead-Zone bleibt gültig.
    // `aria-hidden`, denn das <h1> darüber ist und bleibt der Seitentitel; ein
    // zweiter im Baum wäre eine Dublette.
    // WIEVIEL PLATZ DIE BAR-ZEILE ÜBRIG LÄSST, entscheidet, ob er überhaupt
    // hineinpasst. Vier von fünf Modulen lassen ihn stehen (auf 375px zwischen
    // 94px und 343px), aber wo die letzte Zeile eine Tab-Leiste ist, füllt die
    // sie ganz: der Titel begann dort eine SECHSTE Zeile, und mit ihr sprangen
    // Kopfhöhe und Lead-Zone beim Andocken (Belohnungen 110→145px,
    // Haushaltshilfe 122→157px). Das ist exakt die Oszillation, gegen die das
    // negative `top` gewählt wurde - also lieber keinen Titel als einen, der
    // den Kopf um seine eigene Schwelle pendeln lässt. Gemessen statt
    // aufgezählt, damit die Regel auch beim sechsten Modul noch gilt.
    const lastLine = lines.length ? lines[lines.length - 1] : null;
    const tbCS = getComputedStyle(toolbar);
    const innerWidth = toolbar.clientWidth
      - (parseFloat(tbCS.paddingInlineStart) || 0)
      - (parseFloat(tbCS.paddingInlineEnd) || 0);
    const colGap = parseFloat(tbCS.columnGap) || 0;
    const usedWidth = lastLine
      ? lastLine.els.reduce((sum, el) => sum + el.getBoundingClientRect().width, 0)
        + colGap * lastLine.els.length
      : 0;
    // Unter dieser Breite bliebe von jedem Modulnamen nur die Ellipse.
    const roomForDockTitle = innerWidth - usedWidth >= 88;

    const heading = toolbar.querySelector(':scope > .page-toolbar__title');
    if (lead > 0 && !capped && heading && roomForDockTitle) {
      if (!dockTitle) {
        dockTitle = document.createElement('span');
        dockTitle.className = 'page-toolbar__dock-title';
        dockTitle.setAttribute('aria-hidden', 'true');
      }
      // NUR SCHREIBEN, WENN SICH ETWAS ÄNDERT: der MutationObserver unten
      // beobachtet den Teilbaum und ruft `update` erneut auf. Ein
      // bedingungsloses textContent tauscht den Textknoten jedes Mal aus und
      // triggert sich damit selbst.
      const text = heading.textContent.trim();
      if (dockTitle.textContent !== text) dockTitle.textContent = text;
      const anchor = toolbar.querySelector(':scope > .page-toolbar__actions');
      if (dockTitle.parentElement !== toolbar || dockTitle.nextElementSibling !== anchor) {
        toolbar.insertBefore(dockTitle, anchor);
      }
    } else if (dockTitle?.parentElement) {
      dockTitle.remove();
    }

    // Die Trennlinie erscheint, sobald die erste Zeile aus dem Scrollport
    // gewandert ist. Ohne Lead gibt es nichts zu beobachten - dann trägt die
    // Leiste ihre Linie durchgehend (einzeilige Köpfe, Desktop). In der
    // gedeckelten Architektur wandert nichts; dort hängt die Linie am
    // Kollaps-Zustand und wird von onInnerScroll gesetzt.
    io?.disconnect();
    io = null;
    if (!lead || !firstEl || !scrollport || capped) {
      toolbar.classList.toggle('is-docked', !lead);
      return;
    }
    // DER BEOBACHTUNGSRAHMEN IST UM EINEN PIXEL KLEINER ALS DER SCROLLPORT,
    // weil `firstEl` ein Kind des KLEBENDEN Kopfes ist: es wandert nicht frei
    // mit dem Inhalt davon, sondern nur so weit, wie das negative `top` den
    // Kopf hochzieht - und das ist exakt `lead`. Bei einem ZWEIZEILIGEN Kopf
    // ist `lead` genau die Unterkante der ersten Zeile; sie endet bündig auf
    // der Port-Kante, berührt sie also, statt sie zu überschreiten, und der
    // Observer wechselt nie auf `false`. Gemessen an drei Modulen (Gesundheit,
    // Belohnungen, Haushaltshilfe): der Kopf trug mobil NIE eine Trennlinie.
    // Bei drei Zeilen fiel es nicht auf - dort ist `lead` die Höhe von zwei
    // Zeilen und schiebt die erste weit über die Kante hinaus.
    io = new IntersectionObserver(
      ([entry]) => toolbar.classList.toggle('is-docked', !entry.isIntersecting),
      { root: scrollport, threshold: 0, rootMargin: '-1px 0px 0px 0px' },
    );
    io.observe(firstEl);
  };

  const ro = new ResizeObserver(update);
  ro.observe(toolbar);
  const mo = new MutationObserver(update);
  mo.observe(toolbar, { childList: true, subtree: true });
  // Scroll blubbert nicht - in der gedeckelten Architektur wird deshalb in der
  // Capture-Phase am Modul-Root gelauscht. Damit ist jede innere Liste erfasst,
  // auch die eines Tabs, den es beim Verdrahten noch nicht gab.
  capped?.addEventListener('scroll', onInnerScroll, { capture: true, passive: true });
  update();

  return {
    update,
    destroy: () => {
      io?.disconnect();
      ro.disconnect();
      mo.disconnect();
      capped?.removeEventListener('scroll', onInnerScroll, { capture: true });
      dockTitle?.remove();
      dockTitle = null;
      headSeal?.remove();
      headSeal = null;
      delete toolbar.dataset.collapsingHeader;
      toolbar.style.removeProperty('--page-toolbar-lead');
      toolbar.classList.remove('page-toolbar--stacked', 'page-toolbar--capped', 'is-collapsed', 'is-docked');
    },
  };
}

/**
 * Führt eine asynchrone Aktion aus und markiert das auslösende Control derweil
 * als beschäftigt: `disabled` gegen Doppelauslösung, `aria-busy` für Screenreader,
 * optional eine Lade-Klasse.
 *
 * Der eigentliche Zweck ist das `finally`: `disabled` entzieht dem fokussierten
 * Element den Fokus (er fällt auf <body>), und ohne Rückgabe landet die Tastatur
 * nach jeder Aktion wieder am Seitenanfang. Der Fokus wird nur zurückgegeben,
 * wenn das Control ihn vorher hatte und noch im Dokument hängt - nach einem
 * Re-Render ist es abgehängt und ein focus() ginge ins Leere.
 *
 * @param {HTMLElement} control                 - Button, Checkbox, Select …
 * @param {() => Promise<any>} task             - Die auszuführende Aktion
 * @param {Object} [opts]
 * @param {string|null} [opts.loadingClass]     - Klasse während der Aktion, z. B. 'btn--loading'
 * @returns {Promise<any>} Rückgabewert von task
 */
export async function withBusy(control, task, { loadingClass = null } = {}) {
  const hadFocus = document.activeElement === control;
  if (loadingClass) control.classList.add(loadingClass);
  control.setAttribute('aria-busy', 'true');
  control.disabled = true;
  try {
    return await task();
  } finally {
    control.disabled = false;
    control.removeAttribute('aria-busy');
    if (loadingClass) control.classList.remove(loadingClass);
    if (hadFocus && control.isConnected && document.activeElement !== control) {
      control.focus({ preventScroll: true });
    }
  }
}

/**
 * Wischen zum Verwerfen für eine kurzlebige Fläche (Toast).
 *
 * ZWEI FALLEN STECKEN IN DIESER GESTE, beide an #821 gemessen, und beide waren
 * im Router-Inline-Code offen:
 *
 * 1. `pointermove` feuert auch mit ERHOBENER Taste. Ohne Gedrückt-Prüfung
 *    reichte blosses Drüberfahren mit der Maus: der Startpunkt stand noch auf
 *    0, die gemessene Strecke war damit die halbe Fensterbreite, und die Fläche
 *    lag verschoben bei `opacity: 0` - unsichtbar, bevor der Zeiger den Knopf
 *    darauf erreichte.
 * 2. `setPointerCapture` schon beim `pointerdown` leitet nicht nur die
 *    Zeigerereignisse um, sondern auch den daraus folgenden `click`: der geht
 *    an das einfangende Element statt an den gedrückten Knopf. Der Klick auf
 *    „Rückgängig" erreichte seinen Handler nie - app-weit, in jedem Modul, das
 *    über den Toast zurücknimmt. Per Tastatur und per Touch ging er trotzdem;
 *    deshalb sah die Geste lange heil aus.
 *
 * Der Zeiger wird deshalb erst eingefangen, wenn aus dem Druck wirklich eine
 * Wischbewegung geworden ist. Bis dahin bleibt ein Knopf ein Knopf.
 *
 * Die Fläche braucht ausserdem `touch-action: pan-y` im CSS, sonst hält der
 * Browser sich die Deutung offen, übernimmt die waagerechte Geste als Bildlauf
 * und beendet den Zeiger mit `pointercancel`, bevor die Schwelle fällt.
 *
 * @param {HTMLElement} el
 * @param {Object} opts
 * @param {() => void} opts.onDismiss   - Läuft, wenn über die Schwelle gewischt wurde
 * @param {number} [opts.threshold=40]  - Strecke in px, ab der verworfen wird
 * @param {number} [opts.slop=10]       - Strecke in px, bis zu der es noch ein Klick ist
 * @param {number} [opts.fade=120]      - Strecke in px, über die auf 0 ausgeblendet wird
 */
export function wireSwipeToDismiss(el, { onDismiss, threshold = 40, slop = 10, fade = 120 } = {}) {
  let startX = 0;
  let pressed = false;
  let swiping = false;

  const settle = () => {
    pressed = false;
    swiping = false;
    el.style.transform = '';
    el.style.opacity = '';
  };

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return; // Sekundärtasten sind keine Wischgeste
    startX = e.clientX;
    pressed = true;
    swiping = false;
  });

  el.addEventListener('pointermove', (e) => {
    if (!pressed) return;
    const dx = e.clientX - startX;
    if (!swiping) {
      if (Math.abs(dx) <= slop) return;
      swiping = true;
      el.setPointerCapture(e.pointerId);
    }
    el.style.transform = `translateX(${dx}px)`;
    el.style.opacity = String(Math.max(0, 1 - Math.abs(dx) / fade));
  });

  el.addEventListener('pointerup', (e) => {
    if (!pressed) return;
    const dismissed = swiping && Math.abs(e.clientX - startX) > threshold;
    settle();
    if (dismissed) onDismiss?.();
  });

  el.addEventListener('pointercancel', settle);
}
