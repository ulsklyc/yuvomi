/**
 * Modul: Gleitender Auswahl-Indikator (geteilt) - EINE Auswahl-Bewegung fuer
 *        jede Segment- und Tab-Leiste.
 * Zweck: Eine Kapsel HINTER den Labels, die vom alten zum neuen Eintrag
 *        gleitet, waehrend die Worte stehen - Apples Segmented Control.
 *
 * WARUM GETEILT (Re-Critique 2026-09-27, A1 P2-2 / P1 #2): die Kueche hatte
 * die gleitende Kapsel (utils/kitchen-tabs.js), Gesundheit und Schichtplan
 * nutzen dieselbe `.sub-tabs-bar` und sprangen nur per Farbwechsel, ebenso
 * Budget-Tabs, Kalender-Ansicht, Aufgaben Liste/Kanban und `.segmented`. Drei
 * Auswahl-Bewegungen in einer App. Der Baustein ist hier herausgeloest; die
 * Kueche ist sein erster Nutzer.
 *
 * WIE: `attachSegmentIndicator(bar)` einmal nach dem Rendern. Danach folgt
 * die Kapsel von selbst:
 *   - ein MutationObserver sieht, wenn der aktive Eintrag wechselt (Klasse
 *     oder `aria-selected`/`aria-pressed`/`aria-checked`/`aria-current`) -
 *     `wireTablist().setActive`, `selectSubTab` und handgeschriebene
 *     Klassenwechsel brauchen keinen eigenen Aufruf; die Kapsel gleitet;
 *   - ein ResizeObserver (Leiste als BORDER-Box, Eintraege, Elternteil)
 *     zieht sie nach Schrift, Badge, Breakpoint oder Seitenleiste nach.
 *     Die Border-Box ist der Punkt: beim Ein-/Ausklappen der Seitenleiste
 *     waechst die Leiste um ihr Polster (`--page-inline-pad` zentriert die
 *     Spalte), ihre Content-Box bleibt 1280px, und ein Beobachter der
 *     Content-Box meldete nichts - die Kuechen-Kapsel stand danach 16-20px
 *     neben ihrem Tab (A1 P2-1, gemessen 417 gegen 437).
 * Baut ein Modul seine Leiste bei jedem Wechsel NEU, gibt es `key` mit: die
 * neue Kapsel gleitet dann von der Stelle, an der die alte zuletzt stand.
 *
 * BEWEGUNG: `--duration-lg` + `--ease-out` (tokens.css), per Web Animations
 * (eine CSS-Transition bricht ab, wenn die Leiste beim Seitentausch neu
 * eingehaengt wird). Animiert wird `transform`; Breite und Hoehe nur, wenn sie
 * sich wirklich aendern (gleich breite Segmente gleiten rein per transform).
 * Reduzierte Bewegung: die Kapsel springt.
 *
 * CSS (sub-tabs.css, global): `.seg-indicator` ist die Kapsel, die Leiste
 * bekommt `.has-seg-indicator`, der aktive Eintrag `[data-seg-active]` und
 * gibt dort seine eigene Flaeche ab - ohne JS bleibt alles wie vorher.
 */

export const SEGMENT_INDICATOR_CLASS = 'seg-indicator';

const DEFAULT_ACTIVE = [
  '.sub-tab--active',
  '.is-active',
  '[aria-selected="true"]',
  '[aria-pressed="true"]',
  '[aria-checked="true"]',
  '[aria-current="page"]',
].join(', ');

const WATCHED_ATTRS = ['class', 'aria-selected', 'aria-pressed', 'aria-checked', 'aria-current', 'hidden'];

/** Letzter Stand je `key` - fuer Leisten, die ein Modul bei jedem Wechsel neu baut. */
const _lastBoxByKey = new Map();

function tokenValue(name, fallback) {
  if (typeof getComputedStyle !== 'function' || typeof document === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function tokenMs(name, fallback) {
  const value = parseFloat(tokenValue(name, ''));
  return Number.isFinite(value) ? value : fallback;
}

function reducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const sameBox = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

/**
 * Die Keyframes einer Gleitbewegung: immer `transform`, Breite/Hoehe nur,
 * wenn sie sich aendern. Rein, damit der Test die Regel pruefen kann.
 * @param {{x:number,y:number,w:number,h:number}} from
 * @param {{x:number,y:number,w:number,h:number}} to
 */
export function glideKeyframes(from, to) {
  const frame = (b) => {
    const f = { transform: `translate(${b.x}px, ${b.y}px)` };
    if (from.w !== to.w) f.width = `${b.w}px`;
    if (from.h !== to.h) f.height = `${b.h}px`;
    return f;
  };
  return [frame(from), frame(to)];
}

/**
 * Haengt die gleitende Kapsel an eine Leiste.
 *
 * @param {HTMLElement} bar  die Leiste; sie muss positioniert sein (sticky
 *   oder relative) - sonst setzt der Helfer `position: relative` per Klasse.
 * @param {object} [opts]
 * @param {string} [opts.itemSelector]   die Eintraege (Standard: direkte
 *   Kinder ausser der Kapsel)
 * @param {string} [opts.activeSelector] woran der aktive Eintrag zu erkennen ist
 * @param {string} [opts.className]      zusaetzliche Klasse der Kapsel
 *   (z. B. `kitchen-tabs-bar__indicator` fuer bestehende Regeln)
 * @param {string} [opts.key]            Leisten gleichen Schluessels gleiten
 *   ineinander ueber, auch wenn der Knoten neu ist
 * @returns {{ place: (o?: {glide?: boolean}) => void, destroy: () => void, indicator: HTMLElement }}
 */
export function attachSegmentIndicator(bar, {
  itemSelector = null,
  activeSelector = DEFAULT_ACTIVE,
  className = '',
  key = '',
} = {}) {
  // Wie wireTablist/wireScrollFade: eine fehlende Leiste ist ein No-op, damit
  // die Verdrahtung dahinter (Riegel, Scroll-Fade, Inhalt) nicht mitreisst.
  if (!bar) return { place() {}, destroy() {}, indicator: null };
  const existing = bar.querySelector(`:scope > .${SEGMENT_INDICATOR_CLASS}`);
  if (existing?._segHandle) return existing._segHandle;

  const indicator = document.createElement('span');
  indicator.className = [SEGMENT_INDICATOR_CLASS, className].filter(Boolean).join(' ');
  indicator.setAttribute('aria-hidden', 'true');
  bar.prepend(indicator);
  bar.classList.add('has-seg-indicator');

  const items = () => {
    const list = itemSelector
      ? [...bar.querySelectorAll(itemSelector)]
      : [...bar.children].filter((el) => el !== indicator);
    return list.filter((el) => !el.hidden);
  };
  const activeItem = () => items().find((el) => el.matches(activeSelector)) ?? null;

  let marked = null;
  let glide = null;
  let box = null;
  let destroyed = false;
  let wasConnected = false;

  const measure = (el) => (el && el.offsetWidth
    ? { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight }
    : null);

  /** Wo die Kapsel GERADE zu sehen ist - mitten in einer Bewegung nicht ihr Ziel. */
  const visibleBox = () => {
    if (!box) return key ? _lastBoxByKey.get(key) ?? null : null;
    if (glide?.playState !== 'running') return box;
    const style = getComputedStyle(indicator);
    const matrix = new DOMMatrixReadOnly(style.transform === 'none' ? undefined : style.transform);
    return { x: matrix.m41, y: matrix.m42, w: parseFloat(style.width), h: parseFloat(style.height) };
  };

  function place({ glide: wantGlide = false } = {}) {
    // DIE LEISTE RAEUMT SICH SELBST AB, sobald sie aus dem Dokument ist
    // (Codex an #1483; dasselbe Muster wie `wireScrollFade` in utils/ux.js).
    // Kein Aufrufer mit wiederholtem Rendern haelt den Handle fest -
    // `schedule.renderPage()`, `renderVitalsShell()`, `wireHistoryPeople()`
    // bauen die Leiste neu und verwerfen ihn. Der ResizeObserver beobachtet
    // aber auch den STABILEN Elternknoten: ohne diesen Riegel blieb jede
    // ersetzte Leiste lebendig, hielt ihren abgehaengten Baum und rechnete bei
    // jedem Resize weiter - einer mehr je Neuaufbau. Ein Resize des Elternteils
    // oder der Leiste selbst (sie faellt beim Abhaengen auf 0x0) landet hier.
    // NUR NACH DEM ERSTEN EINHAENGEN: wer die Leiste vor dem Einfuegen
    // verdrahtet, bekaeme sonst gar keine Kapsel.
    if (destroyed) return;
    if (bar.isConnected) wasConnected = true;
    else if (wasConnected) { destroy(); return; }
    const el = activeItem();
    if (marked !== el) {
      marked?.removeAttribute('data-seg-active');
      el?.setAttribute('data-seg-active', '');
      marked = el;
      // Die Kapsel traegt die Form des Eintrags (Kapsel an Sub-Tabs,
      // Segment-Ecke an `.segmented__item`), nicht eine eigene.
      if (el && typeof getComputedStyle === 'function') indicator.style.borderRadius = getComputedStyle(el).borderRadius;
    }
    const to = measure(el);
    indicator.hidden = !to;
    if (!to || sameBox(box, to)) return;

    const from = visibleBox();
    glide?.cancel();
    glide = null;
    indicator.style.transform = `translate(${to.x}px, ${to.y}px)`;
    indicator.style.width = `${to.w}px`;
    indicator.style.height = `${to.h}px`;
    box = to;
    if (key) _lastBoxByKey.set(key, to);

    if (!wantGlide || !from || sameBox(from, to) || reducedMotion() || typeof indicator.animate !== 'function') return;
    glide = indicator.animate(glideKeyframes(from, to), {
      duration: tokenMs('--duration-lg', 250),
      easing: tokenValue('--ease-out', 'ease-out'),
    });
  }

  // Aktiver Eintrag gewechselt: gleiten. Die Kapsel selbst zu beobachten
  // waere eine Schleife (sie schreibt ihren eigenen Stil).
  const mo = typeof MutationObserver === 'function'
    ? new MutationObserver((records) => {
      if (records.every((r) => r.target === indicator)) return;
      place({ glide: true });
    })
    : null;
  mo?.observe(bar, { subtree: true, childList: true, attributes: true, attributeFilter: WATCHED_ATTRS });

  // Lage oder Groesse geaendert: nachziehen - mitten in einer Bewegung
  // gleitend, sonst ohne.
  const ro = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => place({ glide: glide?.playState === 'running' }))
    : null;
  if (ro) {
    ro.observe(bar, { box: 'border-box' });
    if (bar.parentElement) ro.observe(bar.parentElement, { box: 'border-box' });
    for (const el of items()) ro.observe(el);
  }

  // Beim Anhaengen: eine Leiste mit Vorgaenger gleichen Schluessels gleitet
  // von dessen letzter Stelle, eine frische steht sofort.
  place({ glide: !!(key && _lastBoxByKey.has(key)) });

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    mo?.disconnect();
    ro?.disconnect();
    glide?.cancel();
    marked?.removeAttribute('data-seg-active');
    indicator.remove();
    bar.classList.remove('has-seg-indicator');
  }

  const handle = { indicator, place, destroy };
  indicator._segHandle = handle;
  return handle;
}
