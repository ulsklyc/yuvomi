/**
 * Modul: Geteilte Detail-/Vorschauansicht
 * Zweck: Eine bestehende Entität ansehen, ohne im Formular zu landen. Antippen
 *        öffnet eine reine Leseansicht ohne ein einziges Eingabefeld - damit
 *        kann die Bildschirmtastatur strukturell nicht aufgehen. „Bearbeiten"
 *        im Kopf ist eine benannte Absicht und mountet das Formular erst dann.
 * Abhängigkeiten: modal.js (Sheet-Präsentation, Fußzeilen-Umzug, Dirty-Basis),
 *                 i18n.js (t), detail-view.css
 *
 * API:
 *   openDetailView({ title, accentColor, anchor, sections, actions, edit, size, onClose })
 *   closeDetailView({ force, fokus }) → Promise<void>
 *
 * Zwei Präsentationen, eine Aufrufer-API: ab 768px UND mit Anker erscheint die
 * Ansicht als verankertes Popover am Auslöser, sonst als Bottom-Sheet über
 * openModal(). Der Inhalt kommt in beiden Fällen aus demselben Renderer.
 */

import { t } from '/i18n.js';
import {
  openModal, closeModal, mountFooter, refreshDirtySnapshot, forgetRestore,
  focusFirstField, updateHeaderAction, rememberFocus, restoreFocusAfterClose,
} from '/components/modal.js';
import { pushOverlay, dropOverlay } from '/utils/overlay-history.js';

// Ab dieser Breite ist ein Popover am Auslöser die bessere Präsentation: Der
// Auslöser bleibt sichtbar, der Weg ist kurz. Darunter deckt ein 320px-Kärtchen
// den halben Bildschirm ab, ohne die Verankerung lesbar zu machen - dort ist
// das Sheet vom unteren Rand die Bewegung, die der Rest der App ohnehin macht.
const POPOVER_MIN_WIDTH = 768;

// Abstand des Popovers zum Auslöser und zum Viewport-Rand.
const POPOVER_GAP = 8;
const POPOVER_MARGIN = 8;

let activePopover = null;

// Jede geöffnete Ansicht bekommt eine Nummer; nur die zuletzt geöffnete nimmt
// nachgereichte Zeilen an. Sonst schriebe eine verspätete Serverantwort in die
// Ansicht, die der Nutzer inzwischen geöffnet hat.
let viewSeq = 0;
let activeViewToken = 0;

function reduceMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function renderIcons(el) {
  if (window.lucide) window.lucide.createIcons({ el });
}

// --------------------------------------------------------
// Renderer
// --------------------------------------------------------

/**
 * Eine Metazeile: Icon links, darüber/daneben das Label, darunter der Wert.
 *
 * `value` wird als Text gesetzt, nie als Markup - dafür braucht der Aufrufer
 * keine Escaping-Disziplin. Wer mehr als Text braucht (Chips, Badges, Bild),
 * übergibt ein fertiges Element als `node`; dieser Pfad hängt den Knoten
 * ungeprüft ein, die Garantie gilt dort also nur so weit, wie der Aufrufer ihn
 * selbst über createElement/textContent gebaut hat.
 *
 * @param {{icon?: string, label: string, value?: string, node?: HTMLElement, multiline?: boolean}} row
 * @returns {HTMLElement|null}
 */
export function detailRowEl({ icon, label, value, node, multiline = false } = {}) {
  const hasContent = node instanceof HTMLElement || (typeof value === 'string' && value.trim().length > 0);
  if (!hasContent) return null;

  const row = document.createElement('div');
  row.className = multiline ? 'detail-row detail-row--multiline' : 'detail-row';

  if (icon) {
    const i = document.createElement('i');
    i.className = 'detail-row__icon';
    i.dataset.lucide = icon;
    i.setAttribute('aria-hidden', 'true');
    row.appendChild(i);
  }

  const text = document.createElement('div');
  text.className = 'detail-row__text';

  if (label) {
    const lab = document.createElement('span');
    lab.className = 'detail-row__label';
    lab.textContent = label;
    text.appendChild(lab);
  }

  if (node instanceof HTMLElement) {
    node.classList.add('detail-row__value');
    text.appendChild(node);
  } else {
    const val = document.createElement('span');
    val.className = 'detail-row__value';
    val.textContent = value;
    text.appendChild(val);
  }

  row.appendChild(text);
  return row;
}

/**
 * Die Sichtbarkeitszeile für das all/assignees/private-Modell, das Kalender und
 * Aufgaben teilen: „Alle" ist der Normalfall und schweigt, alles andere benennt
 * sich.
 *
 * Bewusst NICHT allgemeingültig: Dokumente (family/restricted/private plus
 * Mitgliederliste), Budget (shared/private als Boolean) und Gesundheit (eigener
 * i18n-Namespace je Bereich) haben je ein anderes Modell. Ein drittes Modul mit
 * abweichendem Modell baut seine Zeile über detailRowEl selbst, statt diese
 * Funktion um Sonderfälle zu erweitern.
 *
 * @param {string} visibility - 'all' | 'assignees' | 'private'
 * @returns {{icon: string, label: string, value: string}}
 */
export function visibilityRow(visibility) {
  const restricted = visibility && visibility !== 'all';
  return {
    icon: visibility === 'private' ? 'lock' : 'users',
    label: t('common.visibility.label'),
    value: restricted
      ? (visibility === 'private' ? t('common.visibility.private') : t('common.visibility.assignees'))
      : '',
  };
}

/**
 * Die Zeile „Zugewiesen". Das Icon folgt der Anzahl (eine Person vs. mehrere),
 * und genau diese Kopplung stand in beiden Modulen wortgleich.
 *
 * @param {Array<{display_name?: string}>} users
 * @param {string} label            - modul-eigene Beschriftung
 * @param {string} [fallbackName]   - Anzeigename, wenn keine Nutzer verknüpft
 *                                    sind (der Kalender führt freie Namen)
 * @returns {{icon: string, label: string, value: string}}
 */
export function assignedRow(users, label, fallbackName = '') {
  const names = (users ?? []).map((u) => u.display_name).filter(Boolean);
  return {
    icon: names.length > 1 ? 'users' : 'user',
    label,
    value: names.length ? names.join(', ') : fallbackName,
  };
}

/**
 * Der Lese-Körper: optionaler Farbstreifen plus die sichtbaren Metazeilen.
 * Zeilen ohne Inhalt fallen weg, statt als leere Zeile dazustehen - eine
 * Detailansicht zeigt, was da ist, und schweigt über den Rest.
 */
function detailBodyEl({ accentColor, sections = [] }) {
  const view = document.createElement('div');
  view.className = 'detail-view';

  if (accentColor) {
    const accent = document.createElement('div');
    accent.className = 'detail-view__accent';
    accent.style.setProperty('--detail-accent', accentColor);
    view.appendChild(accent);
  }

  const rows = document.createElement('div');
  rows.className = 'detail-view__rows';
  sections
    .filter((s) => s && !s.hidden)
    .map(detailRowEl)
    .filter(Boolean)
    .forEach((row) => rows.appendChild(row));
  view.appendChild(rows);

  return view;
}

/**
 * Fußzeile mit den Objektaktionen. Bewusst `.modal-panel__footer`, damit sie im
 * Sheet-Modus vom Fußzeilen-Umzug in modal.js erfasst wird und unter der Falz
 * stehen bleibt statt mitzuscrollen.
 */
function detailFooterEl(actions = []) {
  const visible = actions.filter((a) => a && !a.hidden);
  if (!visible.length) return null;

  const footer = document.createElement('div');
  footer.className = 'modal-panel__footer modal-panel__footer--plain detail-view__footer';

  visible.forEach((action) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn btn--${action.variant ?? 'secondary'}`;
    if (action.id) btn.id = action.id;
    if (action.align === 'start') btn.classList.add('detail-view__action--start');
    if (action.icon) {
      const i = document.createElement('i');
      i.className = 'icon-md';
      i.dataset.lucide = action.icon;
      i.setAttribute('aria-hidden', 'true');
      btn.appendChild(i);
    }
    btn.append(document.createTextNode(action.label ?? ''));
    if (typeof action.onClick === 'function') {
      btn.addEventListener('click', () => action.onClick({ close: closeDetailView, button: btn }));
    }
    footer.appendChild(btn);
  });

  return footer;
}

// --------------------------------------------------------
// Pane-Wechsel: Detailansicht → Formular
// --------------------------------------------------------

/**
 * Der animierte Höhenübergang. Das Sheet steht auf Inhaltshöhe (der „medium"-
 * Detent) und wächst beim Wechsel auf Formularhöhe. Ohne diesen Übergang
 * springt es, was den Wechsel wie einen Seitenwechsel aussehen lässt statt wie
 * einen Moduswechsel derselben Karte.
 *
 * Gemessen wird vor und nach dem Tausch; dazwischen liegt der Aufruf, der den
 * Inhalt austauscht. Unter `prefers-reduced-motion` läuft nur der Tausch.
 */
function withHeightTransition(panel, swap) {
  if (reduceMotion() || typeof panel.getBoundingClientRect !== 'function') {
    swap();
    return;
  }

  const from = panel.getBoundingClientRect().height;
  swap();
  const to = panel.getBoundingClientRect().height;
  if (!from || !to || Math.abs(to - from) < 2) return;

  // Die Starthöhe steht synchron, noch ohne Übergang - sonst würde schon dieser
  // erste Schreibvorgang animiert. Danach zwei Frames: der erste schaltet den
  // Übergang scharf, der zweite schreibt das Ziel. In einem Frame fasste der
  // Browser Scharfschalten und Zielwert in denselben Style-Recalc und animierte
  // gar nicht.
  panel.style.height = `${from}px`;
  panel.style.overflow = 'hidden';
  requestAnimationFrame(() => {
    panel.classList.add('modal-panel--resizing');
    requestAnimationFrame(() => { panel.style.height = `${to}px`; });
  });

  // Sicherung: bleibt das transitionend aus (unterbrochener Übergang, Tab im
  // Hintergrund), darf die feste Höhe nicht stehen bleiben. Im Normalfall kommt
  // das Ereignis nach ~200ms und räumt den Timer ab, sonst liefe er nach jedem
  // Wechsel noch einmal ins Leere.
  let fallback = null;
  const done = () => {
    if (fallback) { clearTimeout(fallback); fallback = null; }
    panel.classList.remove('modal-panel--resizing');
    panel.style.height = '';
    panel.style.overflow = '';
  };
  panel.addEventListener('transitionend', (e) => {
    if (e.propertyName === 'height') done();
  }, { once: true });
  fallback = setTimeout(done, 400);
}

function crossFade(el) {
  if (!el || reduceMotion()) return;
  el.classList.remove('detail-pane--enter');
  void el.offsetWidth; // Reflow: Animation bei jedem Wechsel neu starten
  el.classList.add('detail-pane--enter');
}

/** Die Kopfzeile benennt die Ansicht und wechselt mit ihr. */
function setPanelTitle(panel, text) {
  const el = panel.querySelector('.modal-panel__title');
  if (el) el.textContent = text;
}

/**
 * Nimmt die aktuell am Panel hängende Fußzeile ab und gibt sie zurück.
 *
 * Jede Ansicht hat ihre eigene Fußzeile - die Detailansicht führt Objektaktionen,
 * das Formular Abbrechen/Speichern. Beim Wechsel wird die eine abgehängt und
 * aufbewahrt, statt sie zu verwerfen: `mountFooter` räumt konkurrierende
 * Fußzeilen weg, und ein verworfener Knoten wäre beim Zurückwechseln fort.
 */
function detachFooter(panel) {
  const footer = [...panel.children].find((el) => el.classList?.contains('modal-panel__footer'));
  footer?.remove();
  return footer ?? null;
}

/**
 * Wechsel in den Bearbeitungsmodus.
 *
 * Beim ERSTEN Wechsel ist die Reihenfolge nicht beliebig - sie löst die drei
 * Fallen aus 4.3 des Plans in genau dieser Folge:
 *   1. mount()               - das Formular entsteht erst jetzt
 *   2. mountFooter()         - sonst bliebe die Formular-Fußzeile im
 *                              scrollenden Body und „Speichern" löste kein
 *                              submit aus (#543)
 *   3. refreshDirtySnapshot()- sonst meldet das Schließen „Änderungen
 *                              verwerfen?", obwohl niemand etwas geändert hat
 *   4. focusFirstField()     - sonst bleibt der Fokus auf dem verschwundenen
 *                              „Bearbeiten"-Button
 *
 * Ab dem zweiten Wechsel laufen 1 bis 3 bewusst NICHT mehr: Das Formular steht
 * samt Eingaben, seine Fußzeile trägt die form-Attribute aus dem ersten
 * mountFooter dauerhaft am Knoten, und ein erneuter Snapshot würde genau die
 * ungespeicherten Eingaben als Ausgangsstand einfrieren. Wer die Fußzeilen-
 * Verwaltung hier ändert, muss #543 für diesen Pfad neu prüfen - das
 * Wiederanhängen verlässt sich auf den Zustand vom ersten Mal.
 *
 * Vor dem Mount wird auf `edit.ready` gewartet, falls der Aufrufer es mitgibt.
 * Das ist die Sperre für Daten, die die Leseansicht nachlädt, das Formular aber
 * VOLLSTÄNDIG braucht: Baut es ohne sie auf, hält es die fehlenden Felder für
 * geleert und schreibt diese Leere beim Speichern fest. In aller Regel ist das
 * Promise längst erfüllt (man liest erst, dann bearbeitet man), der Wechsel
 * kostet dann nur einen Microtask.
 */
async function switchToForm(panel, opts, state) {
  const body = panel.querySelector('.modal-panel__body');
  if (!body || state.mode !== 'detail') return;

  // Zwischenzustand VOR dem await: Ohne ihn baute ein zweiter Klick auf
  // „Bearbeiten" das Formular ein zweites Mal auf und verwürfe die Eingaben des
  // ersten Aufbaus.
  state.mode = 'switching';
  if (opts.edit?.ready) {
    try {
      await opts.edit.ready;
    } catch {
      // Die Sperre darf den Wechsel nicht verhindern - scheitert das Nachladen,
      // versorgt sich das Formular aus dem, was der Aufrufer sonst hat.
    }
    // Zwischenzeitlich geschlossen oder schon wieder zurückgewechselt.
    if (state.mode !== 'switching' || !panel.isConnected) return;
  }

  let firstMount = false;

  withHeightTransition(panel, () => {
    state.detailPane.hidden = true;
    state.detailFooter = detachFooter(panel) ?? state.detailFooter;

    if (!state.formPane) {
      firstMount = true;
      const pane = document.createElement('div');
      pane.className = 'detail-view__form';
      body.appendChild(pane);
      state.formPane = pane;
      opts.edit.mount(panel, pane);
      // mount() fuegt sein Markup erst jetzt ein - lange nach dem createIcons-
      // Lauf, der beim ersten Oeffnen der Leseansicht (renderIcons(panel) oben)
      // durchlief. Ohne diesen zweiten Lauf bleiben `data-lucide`-Platzhalter im
      // Formular leer, z. B. die 13 Knoepfe der Markdown-Formatierungsleiste
      // (#1141).
      renderIcons(pane);
      // Die Formular-Fußzeile entstand gerade erst im Body und muss ans Panel,
      // sonst scrollt die Primäraktion weg und ein „Speichern" mit
      // type="submit" löst außerhalb seines Formulars kein submit aus (#543).
      state.formFooter = mountFooter(panel);
    } else {
      // Zweiter Besuch: das Formular steht noch, samt allem, was der Nutzer
      // hineingeschrieben hat. Ein Neuaufbau würde diese Eingaben verwerfen.
      state.formPane.hidden = false;
      if (state.formFooter) panel.appendChild(state.formFooter);
    }
  });

  // Nur beim ersten Mount. Da sind die Felder frisch aus den Serverwerten
  // befüllt, also der unveränderte Ausgangsstand - genau die Basis, gegen die
  // der Dirty-Check vergleichen soll. Beim zweiten Besuch stehen dort die
  // Eingaben des Nutzers; ein Snapshot würde sie als „unverändert" einfrieren,
  // und das Schließen ginge ohne Verwerfen-Frage durch. Die Eingaben wären still
  // verloren - dieselbe Klasse Fehler, gegen die refreshDirtySnapshot antritt.
  if (firstMount) refreshDirtySnapshot();

  crossFade(state.formPane);
  // Der Titel wechselt VOR dem Fokus: Auf Fingergeräten landet focusFirstField
  // genau auf dieser Überschrift, und sie soll die Ansicht nennen, in die man
  // gerade wechselt - nicht die, aus der man kommt.
  if (opts.edit.title) setPanelTitle(panel, opts.edit.title);
  focusFirstField(panel);

  updateHeaderAction(panel, {
    // „Zurück", nicht „Fertig": Der Knopf wechselt die Ansicht, er übernimmt
    // nichts. „Fertig" heißt auf jeder Plattform, die der Nutzer kennt,
    // „übernehmen" - und weil die Leseansicht danach wieder den gespeicherten
    // Stand zeigt, läse sich das Versprechen wie ein Datenverlust. Gespeichert
    // wird ausschließlich über „Speichern" in der Formular-Fußzeile.
    label: t('common.back'),
    onClick: () => switchToDetail(panel, opts, state),
  });
  state.mode = 'form';
}

/**
 * Zurück in die Leseansicht. Das Formular bleibt im DOM: „Zurück" ist ein
 * Ansichtswechsel, kein Verwerfen. Wer danach erneut „Bearbeiten" drückt, findet
 * seine Eingaben vor, und wer das Modal schließt, bekommt weiterhin die
 * Verwerfen-Frage - der Dirty-Check sieht die Felder ja weiterhin.
 *
 * Die Leseansicht zeigt dabei bewusst wieder den GESPEICHERTEN Stand, nicht die
 * offenen Eingaben: Sie aus den Live-Feldern nachzuziehen würde ungesicherte
 * Werte wie gesicherte aussehen lassen. Deshalb heißt der Knopf „Zurück".
 */
function switchToDetail(panel, opts, state) {
  // Nur aus einem fertig aufgebauten Formular zurück. Während `switching` steht
  // noch kein Formular, und der Kopf-Button trägt dort weiterhin „Bearbeiten".
  if (state.mode !== 'form') return;

  withHeightTransition(panel, () => {
    if (state.formPane) state.formPane.hidden = true;
    state.formFooter = detachFooter(panel) ?? state.formFooter;
    state.detailPane.hidden = false;
    if (state.detailFooter) panel.appendChild(state.detailFooter);
  });

  crossFade(state.detailPane);

  setPanelTitle(panel, opts.title ?? '');
  const btn = updateHeaderAction(panel, {
    label: opts.edit.label ?? t('common.edit'),
    onClick: () => switchToForm(panel, opts, state),
  });
  btn?.focus();
  state.mode = 'detail';
}

// --------------------------------------------------------
// Präsentation: Sheet
// --------------------------------------------------------

function openAsSheet(opts, token) {
  const state = {
    mode: 'detail',
    detailPane: null, formPane: null,
    detailFooter: null, formFooter: null,
  };
  let panelRef = null;

  openModal({
    title: opts.title,
    content: '',
    size: opts.size ?? 'md',
    // Kein Autofokus: Die Leseansicht hat kein Eingabefeld, und der Fokus
    // gehört auf die Aktion, die man als Nächstes will.
    initialFocus: 'none',
    onClose() {
      // Auch das X, Escape, der Backdrop und die Wischgeste enden hier - nur so
      // weiß ein nachgereichtes update(), dass seine Ansicht fort ist.
      if (activeViewToken === token) activeViewToken = 0;
      opts.onClose?.();
    },
    headerAction: opts.edit ? { label: opts.edit.label ?? t('common.edit'), id: 'detail-view-edit' } : null,
    onSave(panel) {
      panelRef = panel;
      const body = panel.querySelector('.modal-panel__body');

      const pane = document.createElement('div');
      pane.className = 'detail-view__pane';
      pane.appendChild(detailBodyEl(opts));
      body.replaceChildren(pane);
      state.detailPane = pane;

      const footer = detailFooterEl(opts.actions);
      if (footer) {
        body.appendChild(footer);
        // Die Fußzeile entstand erst jetzt, nach dem Umzug in openModal - also
        // ein zweites Mal anheben.
        state.detailFooter = mountFooter(panel);
      }

      renderIcons(panel);

      if (opts.edit) {
        updateHeaderAction(panel, { onClick: () => switchToForm(panel, opts, state) });
        panel.querySelector('.modal-panel__action')?.focus();
      } else {
        panel.querySelector('.modal-panel__close')?.focus();
      }
    },
  });

  return (sections) => {
    if (!state.detailPane || !panelRef) return;
    state.detailPane.replaceChildren(detailBodyEl({ ...opts, sections }));
    renderIcons(state.detailPane);
  };
}

// --------------------------------------------------------
// Präsentation: Popover
// --------------------------------------------------------

/**
 * Positioniert das Popover am Auslöser: erst messen, dann im Viewport halten.
 * Übernommen aus der erprobten Logik des Termin-Popups und hierher gezogen,
 * damit jedes Modul dieselbe Verankerung bekommt.
 */
function positionPopover(popover, anchor) {
  const rect = anchor.getBoundingClientRect();
  const popRect = popover.getBoundingClientRect();
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = document.documentElement.clientHeight;

  const fitsBelow = rect.bottom + POPOVER_GAP + popRect.height <= viewportHeight - POPOVER_MARGIN;
  const top = fitsBelow
    ? rect.bottom + POPOVER_GAP
    : Math.max(POPOVER_MARGIN, rect.top - POPOVER_GAP - popRect.height);
  const left = Math.min(
    Math.max(POPOVER_MARGIN, rect.left),
    Math.max(POPOVER_MARGIN, viewportWidth - popRect.width - POPOVER_MARGIN),
  );
  const maxTop = Math.max(POPOVER_MARGIN, viewportHeight - popRect.height - POPOVER_MARGIN);

  popover.style.top = `${Math.min(Math.max(POPOVER_MARGIN, top), maxTop)}px`;
  popover.style.left = `${left}px`;
}

function openAsPopover(opts) {
  // Ein vorheriges Popover hat openDetailView bereits abgeräumt. Hier erneut zu
  // schließen nähme dieser Ansicht ihre gerade vergebene Nummer, und alles
  // Nachgereichte fiele stillschweigend auf den Boden.
  const popover = document.createElement('div');
  popover.id = 'detail-view-popover';
  popover.className = 'detail-popover';
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-modal', 'false');
  popover.tabIndex = -1;

  const heading = document.createElement('h2');
  heading.className = 'detail-popover__title';
  heading.id = 'detail-popover-title';
  heading.textContent = opts.title ?? '';
  popover.setAttribute('aria-labelledby', heading.id);
  popover.appendChild(heading);

  let bodyEl = detailBodyEl(opts);
  popover.appendChild(bodyEl);

  // Im Popover führt „Bearbeiten" ins reguläre Formular-Modal statt in einen
  // Pane-Wechsel: ein 320px-Kärtchen ist kein Ort für sieben Selects, und der
  // Weg ist derselbe, den der Desktop schon immer ging.
  const actions = [];
  if (opts.edit?.standalone) {
    actions.push({
      label: opts.edit.label ?? t('common.edit'),
      variant: 'secondary',
      id: 'detail-popover-edit',
      onClick: () => { closeDetailView(); opts.edit.standalone(); },
    });
  }
  (opts.actions ?? []).forEach((a) => actions.push(a));

  const footer = detailFooterEl(actions);
  if (footer) {
    footer.classList.add('detail-popover__footer');
    popover.appendChild(footer);
  }

  document.body.appendChild(popover);
  renderIcons(popover);
  positionPopover(popover, opts.anchor);

  const onKeydown = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      // Den Fokus gibt closeDetailView() an den Ausloeser zurueck (#1083).
      closeDetailView();
      return;
    }
    if (e.key !== 'Tab') return;
    // Fokus im Popover halten: Es liegt am Ende des Body, ein durchlaufender
    // Tab würde sonst hinter dem Auslöser landen und den Bezug verlieren.
    const focusable = popover.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])');
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const onOutsideClick = (e) => {
    // Ohne Fokus-Rueckgabe: wer daneben klickt, wollte woanders hin, und ein
    // Sprung zurueck zum Ausloeser naehme ihm das Ziel weg.
    if (!popover.isConnected || !popover.contains(e.target)) closeDetailView({ fokus: false });
  };

  activePopover = {
    el: popover,
    anchor: opts.anchor,
    // Wie `openModal` den Ausloeser merkt - damit das Schliessen ihn auch nach
    // einem Neuaufbau wiederfindet (#1083).
    merker: rememberFocus(opts.anchor),
    onClose: opts.onClose,
    // Die Sheet-Praesentation erbt den Marker der Zurueck-Geste von modal.js;
    // das Popover ist der zweite Weg dieser API und braucht deshalb seinen
    // eigenen (#871). Es hat keinen Dirty-Guard - eine Leseansicht kann nichts
    // zu verwerfen haben -, also geht es immer zu.
    overlayToken: pushOverlay(() => { closeDetailView(); }),
    teardown() {
      document.removeEventListener('keydown', onKeydown);
      document.removeEventListener('click', onOutsideClick);
    },
  };

  document.addEventListener('keydown', onKeydown);
  // Erst im nächsten Tick binden, sonst schließt der Klick, der das Popover
  // geöffnet hat, es sofort wieder.
  setTimeout(() => document.addEventListener('click', onOutsideClick), 0);
  popover.focus();

  return (sections) => {
    if (!popover.isConnected) return;
    const next = detailBodyEl({ ...opts, sections });
    popover.replaceChild(next, bodyEl);
    bodyEl = next;
    renderIcons(next);
    // Die Karte ist gewachsen oder geschrumpft; sonst hinge sie schief am Anker
    // oder ragte unten heraus.
    positionPopover(popover, opts.anchor);
  };
}

// --------------------------------------------------------
// Öffentliche API
// --------------------------------------------------------

/**
 * Öffnet die Detailansicht einer bestehenden Entität.
 *
 * @param {Object} opts
 * @param {string} opts.title            - Kopfzeile (Titel der Entität)
 * @param {string} [opts.accentColor]    - Farbstreifen oben (Kalenderfarbe o. Ä.)
 * @param {HTMLElement} [opts.anchor]    - Auslöser; ab 768px wird daran verankert
 * @param {Array}  [opts.sections]       - Metazeilen, siehe detailRowEl
 * @param {Array}  [opts.actions]        - Objektaktionen in der Fußzeile
 * @param {Object} [opts.edit]           - { label?, title?, ready?, mount(panel, pane), standalone() }
 *                                         `ready` ist ein Promise, auf das der
 *                                         Wechsel ins Formular wartet
 * @param {string} [opts.size]           - Panel-Breite wie bei openModal
 * @param {Function} [opts.onClose]
 * @returns {{update: (sections: Array) => boolean, isOpen: () => boolean}}
 *          Handle zum Nachreichen von Zeilen, die beim Öffnen noch nicht da
 *          waren. Siehe `update`.
 */
export function openDetailView(opts = {}) {
  const usePopover = window.innerWidth >= POPOVER_MIN_WIDTH && !!opts.anchor;

  // Ein offenes Popover weicht zuerst - auch wenn die neue Ansicht ein Sheet
  // wird, denn openModal räumt nur Modals weg, kein Popover. Das muss VOR der
  // Nummernvergabe passieren: closeDetailView() setzt den aktiven Token auf 0
  // und löschte sonst gerade den, den wir eben ausgegeben haben.
  // Ohne activePopover-Prüfung würde closeDetailView() blind closeModal()
  // rufen und ein fremdes, offenes Modal schließen.
  // Ohne Fokus-Rueckgabe: die neue Ansicht nimmt den Fokus selbst.
  if (activePopover) closeDetailView({ fokus: false });

  const token = ++viewSeq;
  activeViewToken = token;

  const applySections = usePopover ? openAsPopover(opts, token) : openAsSheet(opts, token);

  return {
    isOpen: () => activeViewToken === token,
    /**
     * Ersetzt die Metazeilen der Leseansicht.
     *
     * Für Angaben, die einen eigenen Serveraufruf kosten: Die Ansicht erscheint
     * sofort mit dem, was die Entität schon trägt, und die nachgeladene Zeile
     * kommt hinterher. Der Aufrufer übergibt die VOLLE Zeilenliste, nicht ein
     * Delta - so bleibt der Renderer die einzige Stelle, die ihre Reihenfolge
     * kennt.
     *
     * Tut nichts, wenn diese Ansicht nicht mehr die aktive ist. Ohne diese
     * Prüfung schriebe eine verspätete Antwort in die Ansicht, die der Nutzer
     * inzwischen geöffnet hat - der Termin von eben in die Karte von jetzt.
     *
     * @returns {boolean} ob die Aktualisierung angekommen ist
     */
    update(sections) {
      if (activeViewToken !== token) return false;
      applySections(sections);
      return true;
    },
  };
}

/**
 * Schließt die Detailansicht in beiden Präsentationen.
 *
 * `force: true` übergeht die „Änderungen verwerfen?"-Frage. Nötig für jede
 * Aktion, nach der es nichts mehr zu verwerfen gibt: ein erledigter
 * Schreibvorgang (#625) oder ein Löschen, das die Eingaben ohnehin mitnimmt
 * (Geburtstage, 2931a76b). Das Formular bleibt beim Zurückwechseln bewusst im
 * DOM (`hidden`), also zählt es weiter in den Dirty-Check hinein - ohne `force`
 * fragt eine Fußzeilen-Aktion nach dem Verwerfen von Feldern, über die der
 * Nutzer längst entschieden hat.
 *
 * Gibt ein Promise zurück, damit Aufrufer das Abräumen abwarten können, bevor
 * sie den Overlay-Slot erneut belegen: Das Shared-Modal kennt kein Stacking,
 * und ein nicht abgewartetes Schließen ließ das Löschen bereits laufen, während
 * die Rückfrage noch im Slot hing.
 *
 * `fokus: false` gibt den Fokus im Popover NICHT an den Auslöser zurück - für
 * den Klick daneben und für eine neue Ansicht, die ihn selbst nimmt. Das Sheet
 * läuft über `closeModal()` und dessen eigenen Restore.
 *
 * @param {{force?: boolean, fokus?: boolean}} [opts]
 * @returns {Promise<void>}
 */
export function closeDetailView({ force = false, fokus = true } = {}) {
  activeViewToken = 0;
  if (activePopover) {
    const { el, teardown, onClose, overlayToken, merker } = activePopover;
    activePopover = null;
    teardown();
    el.remove();
    dropOverlay(overlayToken);
    if (typeof onClose === 'function') onClose();
    // Hier wurde AN modal.js VORBEI geschlossen. Der Fokus geht an den Ausloeser
    // zurueck, mit einem eigenen Merker, damit ein `refocusAfterRender()` nach
    // dem Neuaufbau ihn wiederfindet (#1083). Ohne Rueckgabe wird der Merker nur
    // verworfen - der des vorigen Dialogs setzte den Fokus sonst in einen
    // fremden Zusammenhang.
    if (fokus && merker) restoreFocusAfterClose(merker);
    else forgetRestore();
    return Promise.resolve();
  }
  return closeModal({ force });
}
