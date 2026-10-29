/**
 * EIN FARBWAEHLER (Critique R24, E6 - Fortschreibung von R23-D8).
 *
 * Die App fragte eine Farbe auf drei Arten ab: als nacktes `<input
 * type="color">` (ein violetter Balken im Schichtplan, der Haushaltshilfe,
 * den Abos und im Kalender-Import), als runden `settings-color-button` im
 * Konto und als Swatch-Reihe in Entsorgung, Notizen, Kalender, Budget und den
 * Schnellzugriffen - fuenf Handschriften derselben Reihe. Entschieden ist die
 * Swatch-Reihe: eine benannte Auswahl aus den Familientoenen (`USER_COLORS`,
 * jeder Ton >= 3:1 auf beiden Kartengruenden), dahinter "Eigene" fuer den
 * Rest. Wer eine Farbe sucht, die er beim Namen nennen kann ("Blau"),
 * findet sie in der Reihe; wer die Markenfarbe eines Abos braucht, tippt
 * "Eigene" und bekommt den Systemwaehler.
 *
 * BAUART: eine `radiogroup` aus echten Knoepfen (Roving Tabindex, Pfeile,
 * Pos1/Ende), der Wert steht in EINEM versteckten Feld mit `id`/`name` des
 * Aufrufers. Damit liest jeder Aufrufer wie vorher `#id.value` bzw.
 * `FormData`, und der Verwerfen-Schutz des Dialogs (modal.js
 * `serializeForm`) sieht die Wahl. Das Feld meldet jede Wahl als `input` und
 * `change` (bubbelnd) - Einstellungen, die beim Aendern speichern, horchen
 * darauf wie zuvor am nackten Farbfeld.
 *
 * EINE FARBE AUSSERHALB DER REIHE WIRD NIE STILL ERSETZT. Eine Bestandsfarbe
 * oder eine eigene Wahl steht als eigener Swatch ("Eigene Farbe") vor dem
 * "Eigene"-Knopf und ist gewaehlt; der Vergleich ignoriert die Schreibweise,
 * weil `<input type="color">` immer klein schreibt.
 *
 * Guard: `test:control-dialect` "native-color" - ein `type="color"` gibt es
 * nur noch in dieser Datei.
 */
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { USER_COLORS } from '/utils/color.js';

const HEX = /^#[0-9a-f]{6}$/i;

/** Gleiche Farbe, egal wie geschrieben. */
export function sameColor(a, b) {
  return String(a ?? '').toUpperCase() === String(b ?? '').toUpperCase();
}

/** Die Namen der Familientoene - in der Reihenfolge von `USER_COLORS`. */
export function familyColorOptions() {
  const names = [
    'colorPicker.gray', 'colorPicker.blue', 'colorPicker.green', 'colorPicker.ocher', 'colorPicker.emerald',
    'colorPicker.fuchsia', 'colorPicker.red', 'colorPicker.cyan', 'colorPicker.orange', 'colorPicker.pink',
  ];
  return USER_COLORS.map((value, i) => ({ value, label: t(names[i]) }));
}

function swatchHtml({ value, paint, label, title = '', className = '', custom = false }, active) {
  const fill = paint ?? value;
  return `<button type="button" class="color-swatch${className ? ` ${className}` : ''}${active ? ' color-swatch--active' : ''}"`
    + ` role="radio" aria-checked="${active}" tabindex="${active ? '0' : '-1'}"`
    + ` data-color="${esc(value)}"${custom ? ' data-color-custom=""' : ''}`
    + (fill ? ` style="--swatch:${esc(fill)}"` : '')
    + ` aria-label="${esc(label)}"${title ? ` title="${esc(title)}"` : ''}></button>`;
}

/**
 * Das Markup des Waehlers.
 *
 * @param {object} opts
 * @param {string} [opts.id]          id des versteckten Wertfelds (der Aufrufer liest `#id.value`)
 * @param {string} [opts.name]        name des Wertfelds (FormData)
 * @param {string} [opts.value]       gewaehlte Farbe
 * @param {string} [opts.labelledBy]  id der sichtbaren Beschriftung
 * @param {string} [opts.label]       Name der Gruppe, wo keine sichtbare Beschriftung steht
 * @param {Array<{value: string, label: string, paint?: string, title?: string, className?: string}>} [opts.options]
 *        die Reihe; ohne Angabe die Familientoene
 * @param {boolean} [opts.custom=true] "Eigene" anbieten - nicht bei kuratierten Toenen
 *        (Token-Werte, die eine feste Tinte tragen; DESIGN.md Vollton-Regel)
 * @param {string} [opts.className]   Zusatzklasse am Traeger
 * @param {string} [opts.inputClass]  Klasse am Wertfeld (Aufrufer, die per Klasse lesen)
 * @returns {string}
 */
export function colorPickerHtml({ id = '', name = '', value = '', labelledBy = '', label = '', options = null, custom = true, className = '', inputClass = '' } = {}) {
  const list = options ?? familyColorOptions();
  const inList = list.some((o) => sameColor(o.value, value));
  const swatches = list.map((o) => swatchHtml(o, sameColor(o.value, value)));
  if (!inList && HEX.test(String(value))) {
    swatches.push(swatchHtml({ value, label: t('colorPicker.custom'), custom: true }, true));
  }
  // Ohne Treffer bekommt der erste Swatch den Tab-Stopp (Roving Tabindex).
  if (!swatches.some((s) => s.includes('aria-checked="true"')) && swatches.length) {
    swatches[0] = swatches[0].replace('tabindex="-1"', 'tabindex="0"');
  }
  const customHtml = custom
    ? `<span class="color-picker__custom"><input type="color" class="color-picker__native" data-dirty-ignore`
      + ` value="${esc(HEX.test(String(value)) ? String(value).toLowerCase() : '#000000')}"`
      + ` aria-label="${esc(t('colorPicker.chooseCustom'))}" title="${esc(t('colorPicker.chooseCustom'))}">`
      + `<i data-lucide="plus" class="icon-sm" aria-hidden="true"></i></span>`
    : '';
  return `<div class="color-picker${className ? ` ${className}` : ''}" data-color-picker>`
    + `<div class="color-picker__swatches" role="radiogroup"${labelledBy ? ` aria-labelledby="${esc(labelledBy)}"` : ''}${!labelledBy && label ? ` aria-label="${esc(label)}"` : ''}>${swatches.join('')}</div>`
    + customHtml
    + `<input type="hidden"${inputClass ? ` class="${esc(inputClass)}"` : ''}${id ? ` id="${esc(id)}"` : ''}${name ? ` name="${esc(name)}"` : ''} value="${esc(value ?? '')}">`
    + `</div>`;
}

function hiddenOf(picker) {
  return picker.querySelector(':scope > input[type="hidden"]');
}

function select(picker, swatch, { focus = false, emit = true } = {}) {
  for (const s of picker.querySelectorAll('.color-swatch')) {
    const on = s === swatch;
    s.classList.toggle('color-swatch--active', on);
    s.setAttribute('aria-checked', String(on));
    s.setAttribute('tabindex', on ? '0' : '-1');
  }
  if (focus) swatch.focus();
  const hidden = hiddenOf(picker);
  if (!hidden || hidden.value === swatch.dataset.color) return;
  hidden.value = swatch.dataset.color;
  if (!emit) return;
  hidden.dispatchEvent(new Event('input', { bubbles: true }));
  hidden.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * Setzt den Wert von aussen (Vorlage, Neuladen) - ohne Ereignis, wie ein
 * zugewiesenes `.value`. Eine fremde Farbe bekommt ihren "Eigene Farbe"-Swatch.
 *
 * @param {Element} picker  `.color-picker` oder ein Element darin
 * @param {string} value
 * @param {{ emit?: boolean }} [opts]
 */
export function setColorPickerValue(picker, value, { emit = false } = {}) {
  const root = picker?.closest?.('[data-color-picker]') ?? picker;
  if (!root) return;
  const swatches = [...root.querySelectorAll('.color-swatch')];
  let target = swatches.find((s) => sameColor(s.dataset.color, value));
  if (!target && HEX.test(String(value))) {
    target = swatches.find((s) => s.hasAttribute('data-color-custom'));
    if (!target) {
      root.querySelector('.color-picker__swatches').insertAdjacentHTML('beforeend', swatchHtml({ value, label: t('colorPicker.custom'), custom: true }, false));
      target = root.querySelector('.color-swatch[data-color-custom]');
    }
    target.dataset.color = value;
    target.style.setProperty('--swatch', value);
  }
  if (target) select(root, target, { emit });
  const native = root.querySelector('.color-picker__native');
  if (native && HEX.test(String(value))) native.value = String(value).toLowerCase();
}

/** Der gewaehlte Wert. */
export function colorPickerValue(picker) {
  const root = picker?.closest?.('[data-color-picker]') ?? picker;
  return root ? hiddenOf(root)?.value ?? '' : '';
}

/**
 * Verdrahtet jeden Waehler unter `root` genau einmal.
 * @param {ParentNode} root
 */
export function wireColorPicker(root) {
  for (const picker of root?.querySelectorAll?.('[data-color-picker]') ?? []) {
    if (picker._colorPickerWired) continue;
    picker._colorPickerWired = true;
    picker.addEventListener('click', (e) => {
      const swatch = e.target.closest('.color-swatch');
      if (swatch && picker.contains(swatch)) select(picker, swatch, { focus: true });
    });
    picker.addEventListener('keydown', (e) => {
      const swatch = e.target.closest('.color-swatch');
      if (!swatch) return;
      const all = [...picker.querySelectorAll('.color-swatch')];
      const i = all.indexOf(swatch);
      const rtl = getComputedStyle(picker).direction === 'rtl';
      const step = { ArrowRight: rtl ? -1 : 1, ArrowDown: 1, ArrowLeft: rtl ? 1 : -1, ArrowUp: -1 }[e.key];
      let next = null;
      if (step) next = all[(i + step + all.length) % all.length];
      else if (e.key === 'Home') next = all[0];
      else if (e.key === 'End') next = all[all.length - 1];
      if (!next) return;
      e.preventDefault();
      select(picker, next, { focus: true });
    });
    // "Eigene": der Systemwaehler meldet waehrend des Ziehens `input` - die
    // Wahl gilt erst mit `change`, sonst fuellte jedes Zwischenbild den
    // Verlauf der Einstellungen, die beim Aendern speichern.
    picker.querySelector('.color-picker__native')?.addEventListener('change', (e) => {
      setColorPickerValue(picker, e.target.value, { emit: true });
    });
    // `form.reset()` setzt das Wertfeld auf seinen Ausgangswert zurueck, aber
    // nicht die Reihe - erst nach dem Zuruecksetzen nachziehen.
    picker.closest('form')?.addEventListener('reset', () => {
      setTimeout(() => setColorPickerValue(picker, hiddenOf(picker)?.value ?? ''), 0);
    });
  }
}
