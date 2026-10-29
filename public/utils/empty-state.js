/**
 * Geteilter Leerzustands-Renderer.
 *
 * Die `.empty-state`-CSS-Grammatik (layout.css) ist seit langem vollständig:
 * `__icon`, `__title`, `__description`, `__hint`, `__cta`. Was fehlte, war eine
 * Stelle, die die KOMPOSITION erzwingt. Folge: 18 Seiten setzten die Teile frei
 * zusammen, und allein in der Küche entstanden drei Varianten desselben
 * Zustands - Rezepte mit doppelter Aussage in Description und Hint, Einkaufen
 * ganz ohne Hint und vertikal in 787px zentriert statt oben angesetzt, Vorrat
 * als einziger vollständig (Critique 2026-07-29).
 *
 * Der Renderer bleibt absichtlich i18n-frei: Aufrufer übergeben schon
 * aufgelöste Strings aus ihrem eigenen `t()`. Eine zweite Übersetzungsschicht
 * hier würde nur Key-Namen über Modulgrenzen schleppen. Die eine Ausnahme ist
 * der Fehlerzustand nach einem Ladevorgang (`mountLoadError`): sein Satz kommt
 * aus der Ursache, und die kennt nur der Fehler, nicht der Aufrufer.
 *
 * Die drei Varianten und ihre ARIA-Rollen sind aus `pantry.js` übernommen, das
 * sie als einziges Modul korrekt unterschieden hat:
 *
 *   'empty'      Noch nichts angelegt. Keine Rolle - das ist gewöhnlicher
 *                Seiteninhalt, keine Meldung. Primärer CTA.
 *   'no-results' Filter/Suche ohne Treffer. `role="status"`, weil der Zustand
 *                als Reaktion auf eine Nutzereingabe erscheint und angesagt
 *                werden muss. Sekundärer CTA (Zurücksetzen).
 *   'error'      Laden fehlgeschlagen. `role="alert"`. Primärer CTA (Erneut).
 *
 * Für die Variante 'error' ist `mountLoadError()` der richtige Einstieg, nicht
 * `mountEmptyState({ variant: 'error' })` - siehe dort.
 */

import { esc } from '/utils/html.js';
// Nur fuer `mountLoadError` (Critique R19): der Satz zur Ursache und das Wort
// fuer die Details. Der Rest des Renderers bleibt i18n-frei, siehe oben.
import { t } from '/i18n.js';
import { loadErrorSentence } from '/utils/friendly-error.js';

const VARIANTS = {
  'empty':      { role: null,     icon: 'inbox',          tone: 'primary'   },
  'no-results': { role: 'status', icon: 'search',         tone: 'secondary' },
  'error':      { role: 'alert',  icon: 'triangle-alert', tone: 'primary'   },
};

/**
 * Baut das Leerzustands-Element, ohne es einzuhängen.
 *
 * @param {object}   opts
 * @param {'empty'|'no-results'|'error'} [opts.variant='empty']
 * @param {string}   [opts.icon]         Lucide-Name; Default je Variante.
 * @param {string}    opts.title         Aufgelöster Titel (Pflicht).
 * @param {string}   [opts.description]  Aufgelöster Beschreibungstext.
 * @param {string}   [opts.hint]         Aufgelöster Hinweis. In der Küche nennt
 *                                       er die nächste Station des Kreislaufs.
 * @param {object}   [opts.action]       { label, onClick, icon?, tone?, attrs? }
 *                                       - ein CTA. `icon` ist ein Lucide-Name,
 *                                       der dem Label vorangestellt wird.
 *                                       `attrs` setzt Attribute am Button (id,
 *                                       data-*) fuer Aufrufer, die erst am
 *                                       eingehaengten Knoten verdrahten.
 * @param {object}   [opts.details]      { summary, text } - aufklappbare
 *                                       technische Details (Stack). Text wird
 *                                       als Textknoten gesetzt, nie als Markup.
 * @param {string}   [opts.className]    Zusaetzliche Klassen am Container
 *                                       (Modul-Modifier wie `split-main-empty`).
 *                                       `.empty-state` bleibt immer gesetzt.
 * @returns {HTMLDivElement}
 */
export function emptyStateEl({
  variant = 'empty', icon, title, description, hint, action, actions, details,
  className, compact = false, terms,
} = {}) {
  const spec = VARIANTS[variant] ?? VARIANTS.empty;

  // Alle Textfelder laufen durch plainText(). `esc()` würde ein durchgereichtes
  // Objekt klaglos als „[object Object]" darstellen - genau das stand im
  // Fehlerzustand des Vorrats auf dem Bildschirm, weil ein Aufrufer den rohen
  // Fehler statt einer Meldung übergab (Critique P0, 2026-07-30). Ein Nicht-Text
  // hier ist immer ein Aufruferfehler; ihn zu verschlucken ist besser, als ihn
  // dem Nutzer zu zeigen.
  title       = plainText(title);
  description = plainText(description);
  hint        = plainText(hint);

  const box = document.createElement('div');
  // `className` traegt ausschliesslich Modul- und Modifier-Klassen NEBEN der
  // Grammatik-Klasse; `.empty-state` selbst setzt der Renderer, damit keine
  // Aufrufstelle sie versehentlich ersetzt (dann faellt das gesamte Layout weg).
  box.className = [
    'empty-state',
    ...(compact ? ['empty-state--compact'] : []),
    ...String(className ?? '').split(/\s+/).filter(Boolean),
  ].join(' ');
  if (spec.role) box.setAttribute('role', spec.role);
  // NICHT UNTER DER SEITENBLENDE (Critique 2026-10-16, A5) - dieselbe Regel wie
  // `stagger` (utils/ux.js). Entsteht der Leerzustand, waehrend der Router die
  // Seite ueberblendet (`html.page-swapping`), IST die Blende sein Einblenden;
  // `empty-state-in` lief sonst zusaetzlich darin (Aufgaben-Detailspalte: zwei
  // Blenden und 6px Versatz uebereinander). Inline und nur am Namen: der
  // Knoten steht danach einfach, ein spaeter entstehender blendet wie gehabt.
  if (typeof document !== 'undefined' && document.documentElement?.classList?.contains('page-swapping')) {
    box.style.animationName = 'none';
  }

  // Feste Reihenfolge Icon → Titel → Beschreibung → Hinweis. Genau die
  // Freiheit, hier umzusortieren oder Teile zu überspringen, hat die vier
  // Küchen-Grammatiken erzeugt.
  // Die kompakte Form steht in einem Abschnitt, dessen Kopf den Kontext schon
  // nennt: dort ist ein Icon die Ausnahme und wird nur auf Wunsch gesetzt. Die
  // Flaechenform fuehrt immer eins, notfalls das der Variante.
  const iconName = icon || (compact ? null : spec.icon);
  const parts = [];
  if (iconName) {
    parts.push(`<i data-lucide="${esc(iconName)}" class="empty-state__icon" aria-hidden="true"></i>`);
  }
  // <h2>, nicht <div>: der Leerzustand ist auf einer leeren Seite der einzige
  // Inhalt, und ohne Überschriften-Semantik ist der erste Bildschirm des
  // Moduls für einen Screenreader strukturlos (Critique 2026-07-30). h2, weil
  // jede Seite ihr h1 schon als sr-only-Modultitel führt.
  //
  // Fehlt der Titel, entfaellt das Element: ein leeres <h2> waere eine
  // Ueberschrift ohne Text und damit fuer den Screenreader schlechter als gar
  // keine. Titellos ist ausschliesslich die kompakte Form (`emptyHintEl`) - der
  // Guard haelt das an den Aufrufstellen fest.
  if (title) parts.push(`<h2 class="empty-state__title">${esc(title)}</h2>`);
  // <p>, nicht <div>: die Beschreibung ist ein Satz Fliesstext, und der Hinweis
  // darunter ist es laengst. Ein UA-Margin entsteht dadurch nicht - reset.css
  // nullt ihn fuer alles. (Die kompakte Form fuehrte ihre Beschreibung schon
  // immer als <p>; bis sie hierher delegierte, war das der einzige Unterschied
  // zwischen den beiden Fassungen.)
  if (description) parts.push(`<p class="empty-state__description">${esc(description)}</p>`);
  // Die Begriffe einer leeren Suche als Chips (searchEmptyOptions): WAS gesucht
  // wurde, steht als Gegenstand da, nicht in Anfuehrungszeichen im Satz.
  const chips = (Array.isArray(terms) ? terms : [])
    .map((term) => ({ text: plainText(term?.text), icon: plainText(term?.icon) }))
    .filter((term) => term.text);
  if (chips.length) {
    parts.push(`<p class="empty-state__terms">${chips.map((term) => `<span class="empty-state__term">${
      term.icon ? `<i data-lucide="${esc(term.icon)}" class="empty-state__term-icon" aria-hidden="true"></i>` : ''
    }<span class="empty-state__term-text">${esc(term.text)}</span></span>`).join('')}</p>`);
  }
  if (hint) parts.push(`<p class="empty-state__hint">${esc(hint)}</p>`);
  box.insertAdjacentHTML('beforeend', parts.join(''));

  // Aufklappbare technische Details: der Stack im globalen Fehlerbildschirm
  // des Routers, der Statuscode im Ladefehler (`mountLoadError`) und im
  // Fehlerzustand der Sitzungspruefung. Zugeklappt stoeren sie niemanden,
  // aufgeklappt sind sie das, was ein Bugreport braucht. Als Textknoten
  // gesetzt, nie als Markup - der Inhalt ist eine rohe Fehlermeldung.
  if (plainText(details?.text)) {
    const box2 = document.createElement('details');
    box2.className = 'empty-state__details';
    const summary = document.createElement('summary');
    summary.textContent = plainText(details.summary) ?? '';
    const pre = document.createElement('pre');
    pre.textContent = plainText(details.text);
    box2.append(summary, pre);
    box.appendChild(box2);
  }

  // `action` (Einzahl) ist die Kurzform fuer den Regelfall. `actions` traegt
  // den selteneren Zustand mit zwei Wegen - Dokumente etwa bietet bei einer
  // leeren Suche „Suche loeschen" UND „Filter zuruecksetzen" an, weil beide die
  // Ursache sein koennen. Mehr als der erste Weg bleibt sekundaer.
  const list = (actions ?? (action ? [action] : [])).filter((a) => plainText(a?.label));
  if (list.length) {
    const buttons = list.map((entry, index) => ctaEl(entry, index === 0 ? spec.tone : 'secondary'));
    if (buttons.length === 1) {
      box.appendChild(buttons[0]);
    } else {
      // Zwei nebeneinander brauchen eine Reihe; einzeln untereinander waeren sie
      // zwei gleich starke Angebote in einer Spalte und damit keine Rangfolge.
      const row = document.createElement('div');
      row.className = 'empty-state__actions';
      row.append(...buttons);
      box.appendChild(row);
    }
  }

  return box;
}

/** Ein CTA der Grammatik. `fallbackTone` gilt, solange die Aktion keinen nennt. */
function ctaEl(action, fallbackTone) {
  const cta = document.createElement('button');
  cta.type = 'button';
  cta.className = [
    'btn', `btn--${action.tone || fallbackTone}`, 'empty-state__cta',
    ...String(action.className ?? '').split(/\s+/).filter(Boolean),
  ].join(' ');
  if (action.icon) {
    cta.insertAdjacentHTML('afterbegin',
      `<i data-lucide="${esc(action.icon)}" aria-hidden="true" class="icon-md"></i>`);
  }
  // Label als Textknoten, nicht via textContent: sonst würde ein schon
  // eingefügtes Icon wieder entfernt.
  cta.append(document.createTextNode(plainText(action.label)));
  // `attrs` ist der Weg fuer Aufrufer, die den CTA nicht hier verdrahten
  // koennen - allen voran die String-Ausgabe (`emptyStateHTML`), deren
  // Listener die Serialisierung nicht ueberleben wuerde. Sie geben dem Button
  // stattdessen eine `id` oder ein `data-action` und binden am eingehaengten
  // Knoten. Werte laufen ueber setAttribute, das Escaping uebernimmt der DOM.
  for (const [name, value] of Object.entries(action.attrs ?? {})) {
    if (value != null) cta.setAttribute(name, String(value));
  }
  if (typeof action.onClick === 'function') cta.addEventListener('click', action.onClick);
  return cta;
}

/**
 * Baut den Leerzustand und ersetzt damit den Inhalt von `target`.
 *
 * `lucide.createIcons` muss NACH dem Einhängen laufen, sonst findet es die
 * `<i data-lucide>`-Platzhalter nicht - deshalb dieser Weg statt eines
 * Aufrufs in `emptyStateEl`.
 *
 * @param {HTMLElement} target
 * @param {object} opts  wie `emptyStateEl`
 * @returns {HTMLDivElement|null}
 */
export function mountEmptyState(target, opts) {
  if (!target) return null;
  const box = emptyStateEl(opts);
  target.replaceChildren(box);
  if (window.lucide) window.lucide.createIcons({ el: box });
  return box;
}

/**
 * Fehlerzustand nach einem fehlgeschlagenen Ladevorgang.
 *
 * Der vierte Zustand jeder Liste. Für „leer", „gefüllt" und „ladend" gab es je
 * einen geteilten Renderer, für „fehlgeschlagen" keinen - mit dem Ergebnis, dass
 * die vier Küchen-Tabs bei HTTP 500 vier verschiedene Dinge taten: Einkauf und
 * Essensplan zeigten ihren LEERZUSTAND samt anlegendem CTA (bei 31 vorhandenen
 * Artikeln bzw. 28 geplanten Mahlzeiten), der Vorrat einen korrekten Fehler mit
 * „[object Object]" als Erklärung, die Rezepte rissen die App in den globalen
 * Fehlerbildschirm (Critique P0, 2026-07-30).
 *
 * Ein Leerzustand ist die schädlichste der vier Antworten: er behauptet
 * Datenverlust und bietet als einzige Handlung eine an, die den Zustand
 * tatsächlich verändert. Deshalb ist die Regel an den Aufrufstellen: den
 * Leerzustand nur rendern, wenn die Antwort erfolgreich UND leer war.
 *
 * Diese Funktion erzwingt gegenüber `mountEmptyState({ variant: 'error' })` zwei
 * Dinge, die einzeln immer wieder vergessen wurden:
 *
 *   1. **Einen Ausweg.** Ohne `onRetry` + `retryLabel` gibt es keinen CTA und
 *      damit eine Sackgasse; der Aufruf ist dann unvollständig.
 *   2. **Die technische Zeile.** Sie kommt aus dem Fehlerobjekt, nie aus einem
 *      Servertext: `data.error` ist bei allen Routen ein unlokalisiertes
 *      englisches „Internal server error." und hätte in einer deutschen
 *      Oberfläche nichts verloren. Der Statuscode dagegen ist sprachneutral und
 *      für den Selbsthoster - der hier oft der Nutzer selbst ist - die einzig
 *      brauchbare Information.
 *
 *   3. **Die Ursache, nicht eine Vermutung** (Critique R19, 2026-10-16). Bis
 *      hierher sagte jeder Ladefehler, was der Aufrufer fest mitgab - an 17
 *      Stellen "Bitte pruefe die Verbindung", auch bei einer Bremse (429) oder
 *      einem Serverfehler -, und darunter stand ein roher Chip "HTTP 429".
 *      Jetzt kommt der Satz aus dem Fehler (`loadErrorSentence`, dieselbe
 *      Zuordnung wie unhandledErrorSentence). Die
 *      `description` des Aufrufers ist nur noch der Rueckfall fuer eine
 *      Ursache ohne eigenen Satz. Der Statuscode wandert in die aufklappbaren
 *      Details - fuer den Selbsthoster da, fuer alle anderen kein Raetsel.
 *
 * Die einzige Stelle der Datei mit `t()`: der Satz zur Ursache und das Wort
 * "Technische Details" gehoeren dem Fehlerzustand, nicht dem Aufrufer.
 *
 * Einen Toast zum selben Fehler gibt es nicht: der Zustand steht, bis jemand
 * handelt, ein Toast daneben sagte dasselbe ein zweites Mal und verginge.
 *
 * @param {HTMLElement} target
 * @param {object}      opts
 * @param {string}      opts.title        Aufgelöst, modulspezifisch („Vorrat
 *                                        konnte nicht geladen werden").
 * @param {string}      [opts.description] Aufgelöster Rueckfall, wenn die
 *                                        Ursache keinen eigenen Satz hat.
 * @param {unknown}     [opts.error]      Das gefangene Fehlerobjekt.
 * @param {string}      [opts.retryLabel] Aufgelöstes CTA-Label; Vorgabe
 *                                        "Erneut versuchen".
 * @param {Function}    opts.onRetry      Wiederholt den Ladevorgang.
 * @returns {HTMLDivElement|null}
 */
export function mountLoadError(target, opts = {}) {
  if (!target) return null;
  const box = loadErrorEl(opts);
  target.replaceChildren(box);
  if (window.lucide) window.lucide.createIcons({ el: box });
  return box;
}

/**
 * Der Fehlerzustand als Element, ohne ihn einzuhaengen - fuer Aufrufer, die
 * ihn in ein Template setzen (`loadErrorHTML`). Dieselben Optionen wie
 * `mountLoadError`.
 *
 * @returns {HTMLDivElement}
 */
export function loadErrorEl({ title, description, error, retryLabel, onRetry, attrs } = {}) {
  const detail = errorDetail(error);
  const label = retryLabel || t('common.retry');
  return emptyStateEl({
    variant: 'error',
    title,
    description: loadErrorSentence(error) ?? description ?? t('common.loadErrorDescription'),
    details: detail ? { summary: t('common.errorDetails'), text: detail } : undefined,
    action: typeof onRetry === 'function' || attrs
      ? {
        label,
        icon: 'refresh-cw',
        ...(typeof onRetry === 'function' ? { onClick: onRetry } : {}),
        ...(attrs ? { attrs } : {}),
      }
      : undefined,
  });
}

/**
 * `loadErrorEl` als HTML-String, fuer Template-Literale - dieselbe Begruendung
 * wie `emptyStateHTML`. Der Knopf wird ueber `attrs` (`data-action`)
 * verdrahtet, ein `onRetry` ueberlebte die Serialisierung nicht.
 *
 * @returns {string}
 */
export function loadErrorHTML(opts = {}) {
  if (typeof opts.onRetry === 'function') {
    throw new TypeError('loadErrorHTML(): onRetry ueberlebt die String-Ausgabe nicht. attrs setzen.');
  }
  return loadErrorEl(opts).outerHTML;
}

/**
 * Kompakter Leerzustand: die --compact-Form der geteilten Grammatik ohne Titel,
 * für Abschnitte, deren Kopf den Kontext schon nennt (Suchhinweis, leere
 * Kontenliste). Ein Satz, zentriert, Sekundärtext - mehr Grammatik wäre dort
 * Lärm, weniger wäre wieder eine eigene Klasse.
 *
 * @param {string} text     Aufgelöster Hinweistext.
 * @param {object} [opts]
 * @param {string} [opts.icon]       Lucide-Name. Ohne Angabe bleibt die Form
 *                                   icon-los; das Dashboard setzt hier eins,
 *                                   weil sein Hinweis eine ganze leere Flaeche
 *                                   fuellt.
 * @param {string} [opts.className]  Zusaetzliche Klassen (z. B.
 *                                   `health-chart-empty` fuer die Hoehe der
 *                                   Diagrammflaeche).
 * @returns {HTMLDivElement}
 */
export function emptyHintEl(text, { icon, className } = {}) {
  // Delegiert bewusst an `emptyStateEl`: die kompakte Form ist dieselbe
  // Grammatik mit weniger Teilen, kein eigener Bau. Als die Funktion ihr Markup
  // noch selbst zusammensetzte, war sie die einzige Stelle, an der ein
  // `.empty-state` ohne die Reihenfolge des Renderers entstehen konnte.
  return emptyStateEl({ compact: true, icon, className, description: text });
}

/**
 * Die Grammatik als HTML-String, fuer Aufrufstellen in Template-Literalen.
 *
 * Bewusst `emptyStateEl(...).outerHTML` statt einer zweiten Komposition: eine
 * parallele String-Fassung waere genau der Mechanismus, der die Leerzustaende
 * ueberhaupt auseinanderlaufen liess. So kann die Ausgabe per Konstruktion
 * nicht von der Element-Fassung abweichen.
 *
 * Ein `onClick` ueberlebt die Serialisierung nicht - er waere still wirkungslos
 * und der CTA damit tot. Deshalb ist er hier ein harter Aufruferfehler; der Weg
 * fuer diese Aufrufer ist `action.attrs` plus ein Listener am eingehaengten
 * Knoten (oder ein Delegierter am Container).
 *
 * Wie bei `mountEmptyState` muss `lucide.createIcons` NACH dem Einhaengen des
 * Strings laufen, sonst bleiben die `<i data-lucide>`-Platzhalter stehen.
 *
 * @param {object} opts  wie `emptyStateEl`
 * @returns {string}
 */
export function emptyStateHTML(opts = {}) {
  if (typeof opts.action?.onClick === 'function') {
    throw new TypeError(
      'emptyStateHTML(): action.onClick ueberlebt die String-Ausgabe nicht. '
      + 'action.attrs setzen (id/data-action) und den Listener am eingehaengten Knoten binden.',
    );
  }
  return emptyStateEl(opts).outerHTML;
}

/**
 * DER LEERZUSTAND „SUCHE OHNE TREFFER" - EINER FUER ALLE MODULE (R19).
 *
 * Die Critique vom 2026-10-16 fand ihn in drei Dialekten: „Keine Treffer"
 * ohne Ausweg (Aufgaben-Liste), „Nichts gefunden" mit dem Begriff in
 * Anfuehrungszeichen und „zuruecksetzen" (Vorrat, Inventar, Rezepte) und
 * „Suche leeren" mit dem Begriff im Satz (Aufgaben-Brett, Dokumente). Jeder
 * Modulwechsel hiess neu lesen. Jetzt baut ihn EINE Stelle: Titel „Keine
 * Treffer", ein Satz, der Suchbegriff (und gesetzte Filter) als Chips, und
 * EINE Aktion „Suche zuruecksetzen". Sie setzt alles zurueck, was die Chips
 * nennen - die Chips sind die Auskunft, was der Knopf aufhebt.
 *
 * Deshalb steht hier `t()`: der Text ist in allen Modulen derselbe, und eine
 * Aufrufstelle, die ihn selbst uebersetzt, ist genau die Stelle, an der der
 * naechste Dialekt entsteht.
 *
 * @param {object}   opts
 * @param {string}   [opts.query]        Der rohe Suchbegriff (escapt der Renderer).
 * @param {string[]} [opts.filters]      Aufgeloeste Namen gesetzter Filter.
 * @param {Function} [opts.onReset]      Setzt Suche (und Filter) zurueck.
 * @param {object}   [opts.resetAttrs]   Attribute am Knopf fuer die String-Ausgabe.
 * @param {object[]} [opts.actions]      Weitere, nachrangige Wege (Dokumente:
 *                                       im Archiv suchen).
 * @param {string}   [opts.className]
 * @returns {object} Optionen fuer emptyStateEl / emptyStateHTML / mountEmptyState
 */
export function searchEmptyOptions({ query = '', filters = [], onReset, resetAttrs, actions = [], className } = {}) {
  const term = plainText(query)?.trim();
  const filterNames = (Array.isArray(filters) ? filters : []).map(plainText).filter(Boolean);
  return {
    variant: 'no-results',
    icon: 'search-x',
    title: t('common.searchNoResultsTitle'),
    description: t(filterNames.length ? 'common.searchNoResultsFilteredDescription' : 'common.searchNoResultsDescription'),
    terms: [
      ...(term ? [{ text: term, icon: 'search' }] : []),
      ...filterNames.map((name) => ({ text: name, icon: 'list-filter' })),
    ],
    actions: [
      { label: t('common.searchReset'), icon: 'x', onClick: onReset, attrs: resetAttrs },
      ...(Array.isArray(actions) ? actions : []),
    ],
    className,
  };
}

/** `searchEmptyOptions` als Element. */
export function searchEmptyEl(opts) {
  return emptyStateEl(searchEmptyOptions(opts));
}

/** `searchEmptyOptions` als String - fuer Listen, die als Markup entstehen. */
export function searchEmptyHTML(opts = {}) {
  return emptyStateHTML(searchEmptyOptions(opts));
}

/** `searchEmptyOptions` eingehaengt (ersetzt den Inhalt von `target`). */
export function mountSearchEmpty(target, opts) {
  return mountEmptyState(target, searchEmptyOptions(opts));
}

/**
 * `emptyHintEl` als HTML-String - dieselbe Begruendung wie `emptyStateHTML`.
 *
 * @param {string} text    Aufgeloester Hinweistext.
 * @param {object} [opts]  wie `emptyHintEl` ({ icon, className }).
 * @returns {string}
 */
export function emptyHintHTML(text, opts) {
  return emptyHintEl(text, opts).outerHTML;
}

/**
 * DIE RUHIGE ZEILE EINES LEEREN ABSCHNITTS IN EINER KARTE (R22, D12) - ein
 * Satz und, wo es etwas zu erfassen gibt, EINE Aktion am Zeilenende.
 *
 * Sie lebte bis DW (p7) als `cardEmptyRowHtml` in health.js, waehrend die
 * Kacheln der Uebersicht dieselbe Aussage in drei Formen trugen: Glyphe, Satz
 * und ein Akzent-Textknopf, der je nach Breite rechts in der Zeile stand oder
 * UNTER den Satz umbrach (Entsorgung und Schnellzugriffe am Telefon, die
 * Entsorgung auch bei 1440 und 1920). Eine Karte ist eine Karte, ob sie im
 * Gesundheitsbereich steht oder im Raster der Uebersicht - also EINE Zeile.
 *
 * DIE AKTION BRICHT NIE UM. Der Satz nimmt den Platz, der bleibt, und bricht
 * selbst in eine zweite Zeile; der Knopf behaelt seine Breite am Ende
 * (`.card-empty-row`, layout.css). Sekundaer, nie gefuellt: der eine gefuellte
 * Knopf eines Schirms ist sein Anlegen (FAB bzw. Kopf-Pille).
 *
 * Reine Zeichenkette ohne DOM - die Uebersicht zeichnet ihre Kacheln auch in
 * Modultests unter Node.
 *
 * @param {string} text  Aufgeloester Satz (wird escaped).
 * @param {object} [opts]
 * @param {{ label: string, id?: string, icon?: string, attrs?: Record<string, string> }|null} [opts.action]
 *        `id` wird zu `data-action` (Gesundheit verdrahtet so); `attrs` setzt
 *        weitere Attribute (die Uebersicht: `data-route`, `data-widget-retry`).
 *        `icon` ist ein Lucide-Name, Standard `plus` (Erfassen).
 * @param {string} [opts.className]  Zusaetzliche Klassen am Traeger.
 * @param {string} [opts.id]  Id des Satzes - die Aktion verweist per
 *        `aria-describedby` darauf. Wo die Aktion nur das Verb traegt
 *        ("Hinzufuegen"), nennt der Satz daneben das Objekt; ohne Verweis
 *        hoerte, wer die Knoepfe einer Seite durchgeht, nur das Verb.
 * @returns {string}
 */
export function cardEmptyRowHtml(text, { action = null, className = '', id = '' } = {}) {
  const attrs = action
    ? [
      action.id ? ` data-action="${esc(action.id)}"` : '',
      id ? ` aria-describedby="${esc(id)}"` : '',
      ...Object.entries(action.attrs ?? {}).map(([name, value]) => ` ${esc(name)}="${esc(String(value))}"`),
    ].join('')
    : '';
  const button = action
    ? `<button type="button" class="btn btn--secondary btn--sm card-empty-row__action"${attrs}>
        <i data-lucide="${esc(action.icon ?? 'plus')}" aria-hidden="true"></i>${esc(action.label)}
      </button>`
    : '';
  return `
    <div class="card-empty-row${className ? ` ${esc(className)}` : ''}">
      <span class="card-empty-row__text"${id ? ` id="${esc(id)}"` : ''}>${esc(text)}</span>
      ${button}
    </div>`;
}

/**
 * Sprachneutrale Kurzform der Ursache fuer die Details, oder `null`.
 *
 * `status === 0` ist in `api.js` der Netzfehler ohne Antwort - dafür gibt es
 * keinen Code zu nennen, und „HTTP 0" wäre schlechter als nichts. Ein Fehler
 * ohne Status (Netzabbruch: `TypeError: Failed to fetch`) nennt Name und
 * Meldung - roh, wie im Fehlerbildschirm des Routers: zum Weitergeben gedacht.
 */
function errorDetail(error) {
  const status = Number(error?.status);
  if (Number.isInteger(status) && status > 0) {
    const retry = plainText(error?.retryAfter);
    return retry ? `HTTP ${status} (Retry-After: ${retry})` : `HTTP ${status}`;
  }
  if (error instanceof Error && error.message) return `${error.name}: ${error.message}`;
  return null;
}

/**
 * Lässt nur echten Anzeigetext durch; alles andere wird zu `null`.
 * Zahlen sind erlaubt (Zähler in Hinweisen), Objekte und Fehler nicht.
 */
function plainText(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  return value.trim() ? value : null;
}
