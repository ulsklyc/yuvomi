/**
 * Modul: Symbol auswählen (#873)
 * Zweck: Ein Dialog, der die Symbole zeigt, die die App ohnehin schon mitbringt -
 *        durchsuchbar, tastaturbedienbar, ohne einen einzigen Byte Nachschub.
 * Abhängigkeiten: /i18n.js, /utils/html.js, /utils/lucide-icons.js,
 *                 /utils/overlay-history.js
 *
 * WARUM LUCIDE UND NICHT EINE SAMMLUNG VON DIENST-LOGOS. Der Wunsch in #873
 * nannte selfh.st/icons: ein paar tausend Marken-SVGs für selbstgehostete
 * Dienste. Eingebaut wären sie ein zweistelliger Megabyte-Zuwachs im Repo für
 * eine Kachelreihe mit höchstens zwei Dutzend Plätzen, jede Marke mit eigener
 * Lizenzlage, und von Hand aktuell zu halten (public/vendor/README.md) - für
 * einen Vorrat, in dem der eine Dienst, den jemand sucht, trotzdem fehlen kann.
 *
 * Lucide dagegen LIEGT SCHON DA: public/lucide.min.js, 1743 Symbole, auf jeder
 * Seite geladen, weil die ganze App damit zeichnet. Ein Symbol kostet hier
 * deshalb nichts als die Länge seines Namens - und es bleibt scharf, färbt mit
 * und folgt dem Hell/Dunkel-Wechsel, was ein hochgeladenes Rasterbild nicht kann.
 *
 * DER ZWEITE VORSCHLAG AUS #873 - das Favicon der verlinkten Adresse holen -
 * ist bewusst nicht umgesetzt. Ihn holen könnte nur der Server: der Browser
 * darf ein fremdes Bild anzeigen, aber nicht auslesen (CORS), und ohne
 * Auslesen gibt es nichts zu speichern. Ein Schnellzugriff darf aber JEDES
 * Haushaltsmitglied anlegen (server/routes/quick-links.js kennt hier keine
 * Admin-Schranke), und er zeigt typischerweise ins eigene Netz. Ein Server, den
 * jedes Mitglied auf jede interne Adresse schicken kann, ist ein Werkzeug zum
 * Abtasten des Heimnetzes - der Preis wäre höher als der gesparte Handgriff.
 */

import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { iconNames, iconElement } from '/utils/lucide-icons.js';
import { attachOverlay, dropOverlay } from '/utils/overlay-history.js';

/**
 * So viele Treffer zeigt das Raster auf einmal.
 *
 * NICHT ALLE 1743: jedes Symbol ist ein `<svg>` mit mehreren Pfaden, und der
 * ganze Vorrat auf einmal sind über zehntausend DOM-Knoten - auf dem Telefon
 * eine Sekunde Standbild, bevor der Dialog erscheint. 120 füllen den Ausschnitt
 * mehrfach; wer weiter unten sucht, sucht schneller über das Suchfeld.
 */
const MAX_RESULTS = 120;

/**
 * Was ohne Suchbegriff im Raster steht.
 *
 * EINE STARTHILFE, KEIN VORRAT. Wer den Dialog öffnet, hat meist einen Dienst
 * im Kopf und keinen Symbolnamen - die Reihe beantwortet den häufigen Fall
 * (Medien, Datei-Ablage, Steuerung im Haus) sofort und macht nebenbei sichtbar,
 * dass hier Symbole und nicht Bilder gewählt werden. Alles andere findet die
 * Suche.
 *
 * Die Namen sind bewusst hier und nicht in einer Locale-Datei: es sind
 * Bezeichner aus einer Fremdbibliothek, keine Oberflächentexte.
 *
 * DIESE REIHE IST DIE ALLGEMEINE - sie stammt aus dem ersten Aufrufer
 * (Schnellzugriffe: selbstgehostete Dienste) und passt überall dort, wo ein
 * Symbol für „irgendetwas" gesucht wird. Ein Aufrufer mit engerem Thema gibt
 * über `openIconPicker(current, { suggestions })` seine eigene Starthilfe mit;
 * die Suche dahinter bleibt in jedem Fall der volle Vorrat.
 */
const SUGGESTIONS = [
  'clapperboard', 'film', 'tv', 'music', 'headphones', 'radio',
  'image', 'camera', 'library', 'book-open', 'newspaper', 'rss',
  'server', 'database', 'hard-drive', 'cloud', 'folder', 'files',
  'house', 'lightbulb', 'thermometer', 'plug', 'wifi', 'router',
  'shield', 'lock', 'key-round', 'user-round', 'users', 'mail',
  'message-circle', 'calendar', 'list-checks', 'shopping-cart', 'wallet', 'chart-line',
  'gamepad-2', 'dumbbell', 'heart-pulse', 'stethoscope', 'car', 'plane',
  'utensils', 'coffee', 'leaf', 'dog', 'graduation-cap', 'wrench',
];

/**
 * Die Treffer zu einem Suchbegriff.
 *
 * ZUERST DIE, DIE DAMIT ANFANGEN. „car" soll `car` und `caravan` vor
 * `shopping-cart` zeigen - eine reine Enthalten-Suche stellt das Gesuchte
 * sonst hinter ein Dutzend zufälliger Zusammensetzungen.
 *
 * Exportiert, weil die Reihenfolge das Einzige an diesem Dialog ist, was man
 * ohne Browser prüfen kann (test/test-quick-link-icons.js).
 */
export function searchIcons(term, vocabulary = iconNames(), suggestions = SUGGESTIONS) {
  const needle = String(term ?? '').trim().toLowerCase().replace(/\s+/g, '-');
  if (!needle) {
    // Nur Vorschläge, die es auch wirklich gibt: ein umbenanntes Symbol soll
    // eine Kachel weniger ergeben, nicht eine leere Lücke in der Reihe.
    const known = new Set(vocabulary);
    return suggestions.filter((name) => known.has(name));
  }

  const starts = [];
  const contains = [];
  for (const name of vocabulary) {
    if (name.startsWith(needle)) starts.push(name);
    else if (contains.length < MAX_RESULTS && name.includes(needle)) contains.push(name);
    if (starts.length >= MAX_RESULTS) break;
  }
  return [...starts, ...contains].slice(0, MAX_RESULTS);
}

/**
 * Eine Kachel im Raster.
 *
 * ALS DOM UND NICHT ALS HTML-ZEICHENKETTE, weil das `<svg>` darin von
 * `iconElement()` kommt - fertig gebaut, statt als Markup zusammengesetzt und
 * wieder geparst.
 */
function tile(name, isCurrent) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `icon-picker__tile${isCurrent ? ' icon-picker__tile--current' : ''}`;
  btn.dataset.icon = name;
  btn.title = name;
  // Der Name IST die Beschriftung: „film", „server" - englische Bezeichner aus
  // dem Vorrat, die es in keiner Locale gibt und die niemand übersetzen sollte.
  btn.setAttribute('aria-label', name);
  btn.setAttribute('aria-pressed', isCurrent ? 'true' : 'false');
  const svg = iconElement(name);
  if (svg) btn.appendChild(svg);
  return btn;
}

function buildDialog(current, resolve, suggestions) {
  const dialog = document.createElement('dialog');
  dialog.className = 'icon-picker';
  dialog.setAttribute('aria-label', t('iconPicker.title'));

  dialog.insertAdjacentHTML('afterbegin', `
    <div class="icon-picker__body">
      <header class="icon-picker__header">
        <h2 class="icon-picker__title">${esc(t('iconPicker.title'))}</h2>
      </header>
      <div class="icon-picker__search">
        <label class="sr-only" for="icon-picker-search">${esc(t('iconPicker.searchLabel'))}</label>
        <input type="search" class="form-input" id="icon-picker-search"
               placeholder="${esc(t('iconPicker.searchPlaceholder'))}" autocomplete="off">
      </div>
      <div class="icon-picker__results" id="icon-picker-results" role="group"
           aria-label="${esc(t('iconPicker.resultsLabel'))}"></div>
      <p class="icon-picker__empty" id="icon-picker-empty" hidden>${esc(t('iconPicker.noResults'))}</p>
      <footer class="icon-picker__footer">
        <button type="button" class="btn btn--ghost" id="icon-picker-clear">${esc(t('iconPicker.clear'))}</button>
        <button type="button" class="btn btn--secondary" id="icon-picker-cancel">${esc(t('common.cancel'))}</button>
      </footer>
    </div>`);

  const results = dialog.querySelector('#icon-picker-results');
  const empty = dialog.querySelector('#icon-picker-empty');
  const input = dialog.querySelector('#icon-picker-search');

  let token = null;
  let settled = false;
  let debounce = null;

  function finish(value) {
    if (settled) return;
    settled = true;
    clearTimeout(debounce);
    if (token !== null) dropOverlay(token);
    dialog.remove();
    resolve(value);
  }

  /* Ein Ergebnis ist EIN Zustand und wird als Ganzes neu gezeichnet. Einzelne
   * Kacheln nachzuführen hiesse, die Reihenfolge zweimal zu kennen - einmal in
   * `searchIcons()` und einmal im Abgleich. */
  const paint = (term) => {
    const names = searchIcons(term, iconNames(), suggestions);
    results.replaceChildren(...names.map((n) => tile(n, n === current)));
    empty.hidden = names.length > 0;
  };

  paint('');

  input.addEventListener('input', () => {
    /* Ein Tastendruck zeichnet bis zu 120 Symbole neu. Ohne die kurze Pause
     * geriet das Tippen auf dem Telefon ins Stocken - gemessen an „calendar",
     * wo jeder der acht Buchstaben ein volles Raster kostet. */
    clearTimeout(debounce);
    debounce = setTimeout(() => paint(input.value), 120);
  });

  results.addEventListener('click', (e) => {
    const chosen = e.target.closest('.icon-picker__tile');
    if (chosen) finish(chosen.dataset.icon);
  });

  dialog.querySelector('#icon-picker-clear').addEventListener('click', () => finish(null));
  dialog.querySelector('#icon-picker-cancel').addEventListener('click', () => finish(undefined));

  /* Escape sagt dasselbe wie „Abbrechen": nichts ändern. `undefined` ist
   * deshalb nicht dasselbe wie `null` - `null` ist die ausdrückliche Wahl
   * „kein Symbol". */
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    finish(undefined);
  });

  return {
    dialog,
    register() {
      // Wie der Zuschnitt-Dialog: ein natives `<dialog>` liegt in der Top-Layer
      // über dem Formular-Modal und muss sich anmelden, sonst nimmt die
      // Zurueck-Geste den Eintrag darunter (#871).
      token = attachOverlay(dialog, () => finish(undefined));
    },
    focus() {
      input.focus();
    },
  };
}

/**
 * Öffnet die Symbolauswahl.
 *
 * @param {string|null} [current] der bisher gewählte Name, wird hervorgehoben
 * @param {Object} [opts]
 * @param {string[]} [opts.suggestions] eigene Starthilfe statt der allgemeinen
 *   Reihe (siehe SUGGESTIONS). Ändert NUR, was ohne Suchbegriff im Raster
 *   steht - gesucht wird weiterhin im ganzen Vorrat.
 * @returns {Promise<string|null|undefined>} Name, `null` für „kein Symbol",
 *   `undefined` bei Abbruch - drei Ausgänge, weil „entfernen" und „nichts
 *   ändern" verschiedene Dinge sind.
 */
export function openIconPicker(current = null, { suggestions = SUGGESTIONS } = {}) {
  return new Promise((resolve) => {
    if (!iconNames().length) {
      // Lucide ist noch nicht da (oder ausgefallen): ein leerer Dialog wäre die
      // schlechtere Antwort als keiner.
      window.yuvomi?.showToast(t('iconPicker.unavailable'), 'danger');
      resolve(undefined);
      return;
    }

    const picker = buildDialog(current, resolve, suggestions);
    document.body.appendChild(picker.dialog);
    picker.dialog.showModal();
    picker.register();
    picker.focus();
  });
}
