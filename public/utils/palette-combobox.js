/**
 * Modul: Das Suchfeld der Befehlspalette als Combobox (Re-Critique 2026-09-28,
 *        A1 P1-1)
 * Zweck: Enter oeffnet den markierten Treffer, Pfeiltasten bewegen nur die
 *        Markierung, der Fokus bleibt im Feld.
 *
 * ANLASS: ⌘K, "kal", Enter - der Pfad blieb `/`, die Palette offen, der Fokus
 * im Feld. Der Tastenhandler kannte nur Pfeiltasten, und die schoben den
 * Fokus in die Treffer; Enter im Feld tat nichts, mobil ebenso die
 * Tastaturtaste "Suchen". Die "Direkt oeffnen"-Kacheln des Leerzustands
 * erreichte kein Pfeil, weil nur `.search-result` zaehlte.
 *
 * DAS MUSTER IST DIE ARIA-1.2-COMBOBOX MIT LISTBOX (APG "Combobox with
 * Listbox Popup"): das Feld traegt `role="combobox"`, `aria-controls` auf die
 * Trefferliste, `aria-expanded` und `aria-activedescendant` auf die markierte
 * Zeile; die Zeilen sind `role="option"` mit `aria-selected`. Der Fokus
 * verlaesst das Feld nie - wer weitertippt, tippt weiter ins Feld. Die Zeilen
 * bleiben Knoepfe: ein Klick oder Tipp oeffnet sie wie bisher, und Enter ruft
 * genau diesen Klick auf, statt einen zweiten Weg zum Ziel zu bauen.
 *
 * VORGEWAEHLT ist der erste Treffer, sobald es Treffer gibt - wie Spotlight
 * und Raycast. Im Leerzustand (Kacheln, kein Suchwort) ist nichts
 * vorgewaehlt: Enter auf ein leeres Feld soll nicht die Uebersicht oeffnen.
 * Der erste Pfeil markiert dann die erste Kachel.
 *
 * Die Gruppen (Gehe zu, Neu anlegen, je Datenart) werden `role="group"` mit
 * ihrer Ueberschrift als Namen; was sonst in der Liste steht (der Hinweis,
 * eine Fehlerzeile), traegt `role="none"` - eine Listbox besitzt nur Gruppen
 * und Optionen. Ohne Zeile verliert die Liste ihre Rolle ganz: eine leere
 * Listbox ist fuer die assistive Technik ein Fehler, kein Zustand.
 *
 * Die DOM-Wege sind bewusst schmal (`querySelectorAll`, `setAttribute`,
 * `classList`, `click`, `scrollIntoView`), damit test:search-palette die
 * echten Handler mit einem kleinen Stub faehrt.
 */

const OPTION_SELECTOR = '.search-result, .search-scope';
const GROUP_SELECTOR = '.search-section, .search-scopes';
const HEADING_SELECTOR = '.search-section__heading';

let idCounter = 0;

/**
 * @param {object} opts
 * @param {HTMLInputElement} opts.input   das Suchfeld
 * @param {HTMLElement} opts.listbox      der Traeger der Treffer (mit `id`)
 * @returns {{ refresh: (opts?: {keep?: boolean, preselect?: boolean}) => void,
 *   clear: () => void, active: () => (HTMLElement|null) }}
 */
export function wirePaletteCombobox({ input, listbox }) {
  let options = [];
  let index = -1;

  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', listbox.id);
  input.setAttribute('aria-expanded', 'false');

  function mark(next, { scroll = false } = {}) {
    options.forEach((opt, i) => opt.setAttribute('aria-selected', i === next ? 'true' : 'false'));
    index = next;
    const opt = options[next];
    if (opt) {
      input.setAttribute('aria-activedescendant', opt.id);
      if (scroll) opt.scrollIntoView?.({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  /**
   * Liest die Zeilen nach jedem Rendern neu ein. `keep` haelt die Markierung
   * an ihrer Stelle (die Datentreffer kommen unter die schon markierten Orte),
   * sonst steht sie wieder auf dem ersten Treffer - oder, mit
   * `preselect: false` (Leerzustand), auf keinem.
   */
  function refresh({ keep = false, preselect = true } = {}) {
    options = [...listbox.querySelectorAll(OPTION_SELECTOR)];
    for (const opt of options) {
      if (!opt.id) opt.id = `palette-option-${++idCounter}`;
      opt.setAttribute('role', 'option');
      opt.tabIndex = -1;
    }
    for (const group of listbox.querySelectorAll(GROUP_SELECTOR)) {
      group.setAttribute('role', 'group');
      const heading = group.querySelector(HEADING_SELECTOR);
      if (heading) {
        if (!heading.id) heading.id = `palette-group-${++idCounter}`;
        group.setAttribute('aria-labelledby', heading.id);
      }
    }
    for (const child of listbox.children ?? []) {
      if (!child.matches?.(GROUP_SELECTOR)) child.setAttribute('role', 'none');
    }
    if (options.length) listbox.setAttribute('role', 'listbox');
    else listbox.removeAttribute('role');
    input.setAttribute('aria-expanded', options.length ? 'true' : 'false');

    let next = -1;
    if (keep && index >= 0) next = Math.min(index, options.length - 1);
    else if (preselect && options.length) next = 0;
    mark(next);
  }

  function clear() {
    options = [];
    index = -1;
    listbox.removeAttribute('role');
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  input.addEventListener('keydown', (e) => {
    // Waehrend einer IME-Eingabe gehoert Enter der Komposition.
    if (e.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!options.length) return;
      e.preventDefault();
      const last = options.length - 1;
      const next = e.key === 'ArrowDown'
        ? (index < 0 ? 0 : Math.min(index + 1, last))
        : (index <= 0 ? 0 : index - 1);
      mark(next, { scroll: true });
      return;
    }
    if (e.key === 'Enter') {
      const opt = options[index];
      if (!opt) return;
      e.preventDefault();
      opt.click();
    }
  });

  // Der Zeiger nimmt die Markierung mit, wie in Spotlight: sonst stuenden
  // eine Zeile unter der Maus und eine andere unter Enter.
  listbox.addEventListener('pointermove', (e) => {
    const opt = e.target?.closest?.(OPTION_SELECTOR);
    const i = opt ? options.indexOf(opt) : -1;
    if (i >= 0 && i !== index) mark(i);
  });

  return { refresh, clear, active: () => options[index] ?? null };
}
