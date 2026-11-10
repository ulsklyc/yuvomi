/**
 * Modul: yuvomi-datepicker-Test
 * Zweck: Sichert Struktur, Invarianten und ISO-Wertkontrakt des gemeinsamen
 *        Datum-/Zeit-Components sowie die i18n-Vollständigkeit über alle Locales.
 * Ausführen: node test/test-datepicker.js
 *
 * Ansatz wie test-category-manager.js: Quelltext-Analyse (kein DOM im Node-Lauf)
 * + Locale-Abgleich gegen die deutsche Referenz.
 */
import { readFileSync, readdirSync } from 'node:fs';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}: ${err.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion fehlgeschlagen'); }

console.log('\n[yuvomi-datepicker-Test]\n');

const comp = readFileSync(new URL('../public/components/datepicker.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/styles/datepicker.css', import.meta.url), 'utf8');

// ── Struktur & Registrierung ────────────────────────────────────────────
test('Definiert das Custom Element yuvomi-datepicker', () => {
  assert(/customElements\.define\(\s*'yuvomi-datepicker'/.test(comp), 'Tag-Name muss yuvomi-datepicker sein');
});
test('Registrierung ist idempotent (guard gegen Doppel-Define)', () => {
  assert(/if\s*\(\s*!customElements\.get\(\s*'yuvomi-datepicker'\s*\)\s*\)/.test(comp), 'Define muss geguardet sein');
});
test('Ist form-associated (ElementInternals)', () => {
  assert(/static\s+formAssociated\s*=\s*true/.test(comp), 'formAssociated muss true sein');
  assert(/attachInternals/.test(comp), 'attachInternals muss genutzt werden');
  assert(/setFormValue\(/.test(comp), 'setFormValue muss den Wert an das Formular spiegeln');
});

// ── ISO-Wertkontrakt ────────────────────────────────────────────────────
test('Exponiert value get/set', () => {
  assert(/get value\(\)/.test(comp), 'value-Getter fehlt');
  assert(/set value\(/.test(comp), 'value-Setter fehlt');
});
test('datetime kombiniert Datum und Zeit als YYYY-MM-DDTHH:MM', () => {
  assert(/\$\{d\}T\$\{tm\}/.test(comp), 'datetime-Getter muss d+T+time zusammensetzen');
  assert(/raw\.split\('T'\)/.test(comp), 'datetime-Setter muss auf T splitten');
});
test('Nutzt die zentralen i18n-Parser/Formatter (kein eigenes Datumsparsing)', () => {
  assert(/parseDateInput/.test(comp) && /parseTimeInput/.test(comp), 'Muss parseDateInput/parseTimeInput nutzen');
  assert(/formatDateInput/.test(comp) && /formatTimeInput/.test(comp), 'Muss formatDateInput/formatTimeInput nutzen');
});

// ── Zeit-Spalten und das Feld als Oeffner ────────────────────────────────
// Statt EINER Liste aller Zeiten im 15-Minuten-Raster (96 Zeilen) stehen
// Stunde und Minute nebeneinander; das Feld selbst oeffnet das Blatt, und
// Getipptes zieht es mit. Tippen bleibt der schnelle Pfad.
const inputHandler = comp.match(/sub\.input\.addEventListener\('input',[\s\S]*?\n {4}\}\);/)?.[0] ?? '';
test('Die Zeit-Auswahl hat Spalten statt einer Liste aller Zeiten', () => {
  assert(/_renderTimeColumns\(el, sub\)/.test(comp), 'Zeit-Popover muss die Spalten zeichnen');
  assert(!/mins < 24 \* 60/.test(comp), 'die alte Liste aller Zeiten darf nicht mehr gebaut werden');
  assert(/data-part="\$\{part\}"/.test(comp) && /role="listbox"/.test(comp), 'jede Spalte ist eine Listbox mit data-part');
});
test('Spaltennamen kommen aus Intl (keine eigenen Locale-Keys)', () => {
  assert(/Intl\.DisplayNames\(getLocale\(\), \{ type: 'dateTimeField' \}\)/.test(comp), 'Intl.DisplayNames dateTimeField noetig');
});
test('Ein Klick ins Feld oeffnet das Blatt, mit der Maus bleibt der Fokus im Feld', () => {
  assert(/sub\.input\.addEventListener\('click'[\s\S]*?_openPopover\(sub, \{ fromField: !byTap \}\)/.test(comp),
    'click im Feld muss das Popover oeffnen, aus dem Feld nur ohne Finger');
  assert(/if \(!fromField\) \{[\s\S]*?\?\.focus\(/.test(comp), 'aus dem Feld geoeffnet darf der Fokus nicht ins Blatt springen');
});
test('Am Finger geht das Blatt ohne Tastatur auf (je Tipp entschieden)', () => {
  assert(/e\.pointerType === 'touch' \|\| e\.pointerType === 'pen'/.test(comp), 'Entscheidung nach pointerType');
  assert(/sub\.input\.addEventListener\('pointerdown'[\s\S]*?e\.preventDefault\(\); \/\/ kein Fokus/.test(comp),
    'Finger-Tipp darf das Feld nicht fokussieren');
});
test('Getipptes zieht das offene Blatt mit und das Feld wird nicht umgeschrieben', () => {
  assert(inputHandler, 'input-Handler nicht gefunden');
  assert(/this\._syncPopover\(sub\)/.test(inputHandler), 'input muss das Blatt nachziehen');
  assert(!/sub\.input\.value\s*=/.test(inputHandler), 'input darf das Feld nicht umschreiben');
});
test('Ein Klick ins aus dem Feld geoeffnete Blatt nimmt dem Feld den Fokus nicht', () => {
  assert(/this\._fromField && e\.pointerType === 'mouse'\) e\.preventDefault\(\)/.test(comp), 'pointerdown im Blatt muss den Fokus halten');
});
test('Esc und eine fertige Wahl geben den Fokus dorthin zurueck, woher das Blatt kam', () => {
  // Regression: vorher fragte Esc `_activeSub` erst NACH dem Schliessen ab, und
  // der Fokus blieb auf einer Zeile des verborgenen Blatts.
  assert(/const target = this\._returnTo;\s*this\._closePopover\(\);\s*target\?\.focus\(\);/.test(comp), '_returnFocus muss das Ziel VOR dem Schliessen lesen');
  assert(!/this\._closePopover\(\); this\._activeSub\?\.trigger\.focus\(\)/.test(comp), 'Esc darf _activeSub nicht nach dem Schliessen lesen');
});
test('CSS: Spalten rasten ein und messen ihre Zeilen selbst', () => {
  assert(/\.ydp-time__list\s*\{[^}]*position:\s*relative/.test(css), 'Liste ist offsetParent ihrer Zeilen');
  assert(/\.ydp-time__list\s*\{[^}]*scroll-snap-type:\s*y proximity/.test(css), 'Spalten rasten ein (proximity)');
  assert(/\.ydp-time__opt\s*\{[^}]*scroll-snap-align:\s*center/.test(css), 'Zeilen rasten mittig ein');
});

// ── Interaktion & Plattform ─────────────────────────────────────────────
test('Öffnet Popover über die native Popover-API (Top-Layer)', () => {
  assert(/setAttribute\('popover'/.test(comp), 'Muss popover-Attribut setzen');
  assert(/showPopover\(\)/.test(comp) && /hidePopover\(\)/.test(comp), 'show/hidePopover nötig');
});
test('Touch bevorzugt das DOM-Popover; natives OS-Sheet nur ohne Popover-API', () => {
  assert(/pointer:\s*coarse/.test(comp), 'Coarse-Pointer-Erkennung nötig');
  assert(/showPicker\(\)/.test(comp), 'showPicker() als natives Fallback nötig');
  // Regression #512: auf iOS ist showPicker() bei versteckten Inputs ein stilles
  // No-op → das native Sheet darf nur greifen, wenn die Popover-API fehlt.
  assert(/_supportsPopover/.test(comp), 'Popover-API-Weiche (_supportsPopover) nötig');
  assert(/coarse\s*&&\s*!this\._supportsPopover\(\)/.test(comp),
    'Native nur auf Touch OHNE Popover-API als Fallback');
});
test('Der Wochenstart kommt aus i18n.js, nicht aus einer eigenen Abfrage (#2533)', () => {
  assert(/getWeekStart/.test(comp), 'Picker muss getWeekStart() aus /i18n.js lesen');
  assert(!/\/preferences/.test(comp), 'Picker laedt die Einstellungen nicht selbst');
});
test('Wer week_start frisch vom Server liest, gibt ihn an i18n.js weiter', () => {
  // Der Picker liest den Wochenstart aus dem Browser (#2533), gesetzt beim
  // Start der App. Aendert ein anderes Haushaltsmitglied ihn, sieht der Picker
  // das erst, wenn jemand den frischen Wert weiterreicht: jede Datei, die
  // `week_start` aus einer Antwort liest, ruft auch setWeekStart().
  const root = new URL('../public/', import.meta.url);
  const files = readdirSync(root, { recursive: true })
    .filter((f) => f.endsWith('.js') && !f.startsWith('vendor/') && f !== 'i18n.js');
  const readers = [];
  const silent = [];
  for (const file of files) {
    const src = readFileSync(new URL(file, root), 'utf8');
    if (!/\.week_start\b/.test(src)) continue;
    readers.push(file);
    if (!/\bsetWeekStart\s*\(/.test(src)) silent.push(file);
  }
  assert(readers.length >= 4, `nur ${readers.length} Leser gefunden - der Scan greift nicht mehr`);
  assert(silent.length === 0, `liest week_start, ohne setWeekStart() zu rufen: ${silent.join(', ')}`);
});
test('Regression #515: UTC-gebaute Label-Daten werden auch in UTC formatiert', () => {
  // monthLabel/weekdayLabels bauen ihre Daten via Date.UTC(); ohne timeZone:'UTC'
  // im Formatter rutscht Intl westlich von UTC auf den Vortag/Vormonat zurück
  // (Bug: „Juli" wurde als „Juni" angezeigt, Wochentagskürzel verschoben).
  const utcFormatters = comp.match(/new Intl\.DateTimeFormat\([^)]*\)/g) || [];
  const monthOrWeekday = utcFormatters.filter((f) => /month|weekday/.test(f));
  assert(monthOrWeekday.length >= 2, 'Monats- und Wochentags-Formatter erwartet');
  monthOrWeekday.forEach((f) => {
    assert(/timeZone:\s*'UTC'/.test(f), `Label-Formatter braucht timeZone:'UTC': ${f}`);
  });
});
test('Wochentags-/Monatsnamen kommen aus Intl (keine eigenen Locale-Keys)', () => {
  assert(/Intl\.DateTimeFormat/.test(comp), 'Intl muss für Labels genutzt werden');
});

// ── Sicherheit & Sauberkeit ─────────────────────────────────────────────
test('Nutzt kein innerHTML', () => {
  assert(!/\.innerHTML/.test(comp), 'innerHTML ist verboten (PostToolUse-Hook)');
});
test('Escaped dynamische Werte via esc()', () => {
  assert(/import \{[^}]*esc[^}]*\} from '\/utils\/html\.js'/.test(comp), 'esc muss importiert werden');
  assert(/esc\(/.test(comp), 'esc muss verwendet werden');
});
test('Die Pfeiltasten des Rasters werden einmal je Popover gebunden, nicht je Monat', () => {
  // Das Raster (`.ydp-cal__days`) ueberlebt jeden Monatswechsel. Stand die
  // Bindung in _paintDays(), kam mit jedem Wechsel ein Zuhoerer dazu: nach zwei
  // Wechseln sprang ein Pfeil drei Tage (im Browser gemessen: 01.10. -> 04.10.).
  const paint = comp.slice(comp.indexOf('  _paintDays(el, sub) {'), comp.indexOf('  _bindGridKeys(grid, el, sub) {'));
  assert(paint.length > 0, '_paintDays nicht gefunden - der Guard waere blind');
  assert(!/_bindGridKeys\(/.test(paint), '_paintDays darf die Tasten nicht (erneut) binden');
  assert((comp.match(/this\._bindGridKeys\(/g) ?? []).length === 1, 'genau ein Aufruf von _bindGridKeys');
  const render = comp.slice(comp.indexOf('  _renderCalendar(el, sub) {'), comp.indexOf('  _shiftMonth(el, sub, delta) {'));
  assert(/this\._paintDays\(el, sub\);[\s\S]*this\._bindGridKeys\(el\.querySelector\('\.ydp-cal__days'\), el, sub\);/.test(render), 'gebunden wird beim Aufbau des Kalenders');
});
test('Der Monatswechsel tauscht das Tagesraster gerichtet ueber swapContent', () => {
  assert(/import \{ swapContent \} from '\/utils\/content-swap\.js'/.test(comp), 'swapContent muss importiert werden');
  assert(/_swapDays\(el, sub, direction\) \{\s*swapContent\(el\.querySelector\('\.ydp-cal__days'\), \(\) => this\._paintDays\(el, sub\), \{ direction \}\);/.test(comp), 'das Raster tauscht ueber swapContent');
  assert(/this\._swapDays\(el, sub, delta\);/.test(comp), 'Pfeilknoepfe und Bild-auf/-ab blaettern gerichtet');
  assert(/this\._swapDays\(el, sub, Math\.sign\(step\)\);/.test(comp), 'ein Pfeil ueber die Monatsgrenze blaettert gerichtet');
});
test('Räumt Popover in disconnectedCallback auf', () => {
  assert(/disconnectedCallback\s*\(\)\s*\{[\s\S]*?_popover/.test(comp), 'Popover-Cleanup nötig');
});
test('Räumt globale Listener beim Schließen wieder ab', () => {
  assert(/removeEventListener\('pointerdown'/.test(comp), 'Doc-pointerdown-Listener muss abgeräumt werden');
});

// ── A11y ────────────────────────────────────────────────────────────────
test('Adoptiert zugehöriges <label> als Aria-Namen', () => {
  assert(/label\[for=/.test(comp), 'label[for] muss berücksichtigt werden');
  assert(/closest\('label'\)/.test(comp), 'umschließendes <label> muss berücksichtigt werden');
});
test('Trigger trägt ein aria-label', () => {
  assert(/aria-label="\$\{esc\(triggerLabel\)\}"/.test(comp), 'Trigger braucht aria-label');
});

// ── CSS: nur Tokens, kein Hardcoding von Farben ─────────────────────────
test('CSS nutzt die Stimme der App, nicht den Modulton', () => {
  // Hier stand `var(--active-module-accent, var(--color-accent))`: der
  // ausgewaehlte Tag trug damit in jedem Modul eine andere Farbe. Der
  // Datepicker ist ein GETEILTES Bedienelement und tut ueberall dasselbe -
  // Eine-Stimme-Regel (DESIGN.md, 2026-08-10).
  // Kommentare raus, bevor gesucht wird: sie duerfen die Historie nennen, und
  // ein `includes()` ueber rohes CSS liest sie als Regeln (dieselbe Falle wie
  // im Regelscanner, test/css-rules.js).
  const live = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert(/var\(--color-accent\)/.test(live), 'Akzent-Token nötig');
  assert(!/--active-module-accent|--module-accent/.test(live),
    'der Datepicker darf keinen Modulton mehr lesen (Eine-Stimme-Regel)');
});
test('CSS respektiert prefers-reduced-motion', () => {
  assert(/@media \(prefers-reduced-motion: reduce\)/.test(css), 'Reduced-Motion-Alternative nötig');
});
test('CSS enthält keine Hex-Farben (nur Tokens)', () => {
  const hex = css.match(/#[0-9a-fA-F]{3,8}\b/g);
  assert(!hex, `Hex-Farben gefunden: ${hex && hex.join(', ')}`);
});

// ── i18n-Vollständigkeit über alle Locales ──────────────────────────────
const localesDir = new URL('../public/locales/', import.meta.url);
const localeFiles = readdirSync(localesDir).filter((f) => f.endsWith('.json'));
const REQUIRED_KEYS = ['openCalendar', 'openTimePicker', 'previousMonth', 'nextMonth', 'today', 'clear'];

// Erwartete Anzahl aus SUPPORTED_LOCALES lesen statt sie hier zu doppeln: eine
// fest verdrahtete Zahl bricht bei jeder neuen Sprache, obwohl am Datepicker
// nichts falsch ist.
const supportedCount = readFileSync(new URL('../public/i18n.js', import.meta.url), 'utf8')
  .match(/const SUPPORTED_LOCALES = \[([^\]]+)\]/)[1]
  .match(/'[^']+'/g).length;

test(`Alle ${localeFiles.length} Locales haben den datepicker-Namespace`, () => {
  assert(localeFiles.length === supportedCount,
    `Erwartet ${supportedCount} Locale-Dateien (SUPPORTED_LOCALES), gefunden ${localeFiles.length}`);
  for (const file of localeFiles) {
    const json = JSON.parse(readFileSync(new URL(file, localesDir), 'utf8'));
    assert(json.datepicker, `${file}: datepicker-Namespace fehlt`);
    for (const key of REQUIRED_KEYS) {
      assert(typeof json.datepicker[key] === 'string' && json.datepicker[key].trim(),
        `${file}: datepicker.${key} fehlt oder leer`);
    }
  }
});

test('Keine Locale hat überschüssige datepicker-Keys', () => {
  for (const file of localeFiles) {
    const json = JSON.parse(readFileSync(new URL(file, localesDir), 'utf8'));
    const extra = Object.keys(json.datepicker).filter((k) => !REQUIRED_KEYS.includes(k));
    assert(extra.length === 0, `${file}: unerwartete Keys ${extra.join(', ')}`);
  }
});

// ── Ohne Popover-API (#2107) ────────────────────────────────────────────
// Chrome < 114, Firefox < 125, Safari < 17: reset.css blendet jedes
// `[popover]` aus, das Kalenderblatt ist dort nicht verfuegbar. `_openPopover()`
// darf dann weder ein Panel anlegen noch `aria-expanded="true"` melden - sonst
// hoert ein Screenreader einen offenen Dialog, den niemand sieht. Als Programm,
// nicht als Text: die Klasse laeuft mit einem HTMLElement ohne showPopover.
{
  const { register } = await import('node:module');
  register('./test-browser-loader.mjs', import.meta.url);
  const saved = {};
  for (const k of ['HTMLElement', 'customElements', 'document', 'window']) {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  }
  const fakeEl = () => ({
    style: {}, dataset: {}, children: [], attrs: {},
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] ?? null; },
    addEventListener() {}, appendChild(c) { this.children.push(c); return c; },
    append() {}, replaceChildren() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    insertAdjacentHTML() {}, closest() { return null; }, contains() { return false; },
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  });
  Object.assign(globalThis, {
    HTMLElement: class {},
    customElements: { get: () => undefined, define() {} },
    document: Object.assign(fakeEl(), { body: fakeEl(), documentElement: fakeEl(), createElement: fakeEl, addEventListener() {}, removeEventListener() {} }),
    window: { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false }), innerWidth: 1024, innerHeight: 768 },
  });
  let result;
  try {
    const { YuvomiDatepicker } = await import('../public/components/datepicker.js');
    const picker = new YuvomiDatepicker();
    // Zeichnen und Positionieren sind hier nicht die Frage, nur die Entscheidung
    // davor - so laeuft der Stand vor dem Fix bis zu `aria-expanded="true"`.
    Object.assign(picker, {
      getAttribute: () => null, hasAttribute: () => false, closest: () => null, isConnected: true,
      _renderCalendar() {}, _position() {}, _resolveLabel: () => 'Datum',
    });
    const trigger = fakeEl();
    let error = null;
    try { picker._openPopover({ kind: 'date', trigger, wrap: fakeEl(), iso: '' }); } catch (err) { error = err; }
    result = { error, expanded: trigger.attrs['aria-expanded'] ?? null, panel: picker._popover };
  } finally {
    for (const [k, d] of Object.entries(saved)) {
      if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k];
    }
  }
  test('Ohne Popover-API legt _openPopover() kein Panel an und meldet nichts als offen (#2107)', () => {
    assert(result.error === null, `_openPopover() wirft ohne Popover-API: ${result.error}`);
    assert(result.panel === null, 'ohne Popover-API darf kein Kalenderblatt angelegt werden');
    assert(result.expanded === null, `aria-expanded steht auf ${result.expanded} - ein Dialog, den niemand sieht`);
  });
}

// ── Wochenstart des Haushalts (#2533) ────────────────────────────────────
// Kopfzeile und Raster beginnen am eingestellten Wochenstart, nicht fest am
// Montag. Als Programm: _renderCalendar() laeuft gegen eine Attrappe, die die
// Wochentagskuerzel und die Tage mitschreibt. November 2026 beginnt an einem
// Sonntag - so faellt jeder der drei Starts auf eine andere erste Zelle.
{
  const saved = {};
  for (const k of ['HTMLElement', 'customElements', 'document', 'window']) {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  }
  const node = () => ({
    style: {}, dataset: {}, children: [], attrs: {}, html: [], textContent: '',
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] ?? null; },
    addEventListener() {}, appendChild(c) { this.children.push(c); return c; },
    replaceChildren() { this.children = []; },
    insertAdjacentHTML(_pos, html) { this.html.push(html); },
    querySelector() { return null; },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  });
  const panel = () => {
    const parts = new Map();
    const el = node();
    el.querySelector = (sel) => {
      if (!parts.has(sel)) {
        const part = node();
        if (sel === '.ydp-cal__days') {
          part.querySelector = (q) => (q === '[tabindex="0"]' ? part.children.find((b) => b.tabIndex === 0) ?? null : null);
        }
        parts.set(sel, part);
      }
      return parts.get(sel);
    };
    return el;
  };
  Object.assign(globalThis, {
    HTMLElement: class {},
    customElements: { get: () => undefined, define() {} },
    document: Object.assign(node(), { createElement: () => Object.assign(node(), { tabIndex: -1 }) }),
    window: { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false }) },
  });
  const prevLocale = globalThis.__locale;
  const prevWeekStart = globalThis.__weekStart;
  const runs = {};
  let error = null;
  try {
    globalThis.__locale = 'en';
    const { YuvomiDatepicker } = await import('../public/components/datepicker.js');
    for (const weekStart of ['monday', 'sunday', 'saturday']) {
      globalThis.__weekStart = weekStart;
      const picker = new YuvomiDatepicker();
      Object.assign(picker, { getAttribute: () => null, _dir: () => 'ltr' });
      const el = panel();
      picker._renderCalendar(el, { kind: 'date', trigger: node(), iso: '2026-11-15' });
      // Das Kuerzel aus genau der Form lesen, die der Picker schreibt; eine
      // andere Form liefert null und macht den Vergleich rot.
      const labels = el.querySelector('.ydp-cal__weekdays').html
        .map((h) => /^<span class="ydp-cal__wd">([^<]*)<\/span>$/.exec(h)?.[1] ?? null);
      const days = el.querySelector('.ydp-cal__days').children.map((b) => b.dataset.iso);
      runs[weekStart] = { labels, days };
    }
  } catch (err) {
    error = err;
  } finally {
    globalThis.__locale = prevLocale;
    globalThis.__weekStart = prevWeekStart;
    for (const [k, d] of Object.entries(saved)) {
      if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k];
    }
  }
  const short = (utcDay) => new Intl.DateTimeFormat('en', { weekday: 'short', timeZone: 'UTC' })
    .format(new Date(Date.UTC(2024, 0, utcDay)));
  // 2024-01-07 war ein Sonntag: short(7 + getDay()-Index) ist das Kuerzel des Tages.
  const expected = {
    monday: { first: '2026-10-26', labels: [1, 2, 3, 4, 5, 6, 0] },
    sunday: { first: '2026-11-01', labels: [0, 1, 2, 3, 4, 5, 6] },
    saturday: { first: '2026-10-31', labels: [6, 0, 1, 2, 3, 4, 5] },
  };
  for (const [weekStart, want] of Object.entries(expected)) {
    test(`Wochenstart ${weekStart}: Kopfzeile und Raster beginnen am selben Tag (#2533)`, () => {
      assert(error === null, `_renderCalendar() wirft: ${error}`);
      const run = runs[weekStart];
      assert(run.days.length === 42, `42 Zellen erwartet, ${run.days.length} gezeichnet`);
      assert(run.days[0] === want.first, `erste Zelle ${run.days[0]}, erwartet ${want.first}`);
      assert(run.days.includes('2026-11-01') && run.days.includes('2026-11-30'), 'der ganze Monat steht im Raster');
      const wantLabels = want.labels.map((d) => short(7 + d));
      assert(JSON.stringify(run.labels) === JSON.stringify(wantLabels),
        `Kopfzeile ${run.labels.join(' ')}, erwartet ${wantLabels.join(' ')}`);
    });
  }
}

// ── Zeit-Spalten als Programm ────────────────────────────────────────────
// timeColumns()/pickTime() sind die reine Logik hinter den Spalten: was
// angeboten und markiert wird, und welcher Wert nach einem Tipp gilt.
{
  /** @type {Record<string, PropertyDescriptor|undefined>} */
  const saved = {};
  for (const k of ['HTMLElement', 'customElements', 'document', 'window']) {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  }
  Object.assign(globalThis, {
    HTMLElement: class {},
    customElements: { get: () => undefined, define() {} },
    document: { createElement: () => ({}), addEventListener() {}, removeEventListener() {} },
    window: { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false }) },
  });
  /** @type {any} */
  let mod = null;
  /** @type {unknown} */
  let error = null;
  try { mod = await import('../public/components/datepicker.js'); }
  catch (err) { error = err; }
  finally {
    for (const [k, d] of Object.entries(saved)) {
      if (d) Object.defineProperty(globalThis, k, d); else delete /** @type {any} */ (globalThis)[k];
    }
  }
  /** @param {unknown} a @param {unknown} b @param {string} msg */
  const eq = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg}: ${JSON.stringify(a)} statt ${JSON.stringify(b)}`);
  test('timeColumns: 24h bietet 0-23 und Minuten im 5er-Raster, markiert 18:07 samt 07', () => {
    assert(!error && mod?.timeColumns, `Import fehlgeschlagen: ${error}`);
    const c = mod.timeColumns('18:07');
    eq(c.parts, ['hour', 'minute'], 'Spalten');
    assert(c.values.hour.length === 24 && c.values.hour[0] === 0, '24 Stunden ab 0');
    eq(c.values.minute, [0, 5, 7, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55], 'Minuten mit der getippten 07');
    eq(c.selected, { hour: 18, minute: 7 }, 'Markierung');
    eq(mod.timeColumns('').selected, { hour: null, minute: null }, 'ohne Wert nichts markiert');
    eq(mod.timeColumns('', { step: 15 }).values.minute, [0, 15, 30, 45], 'step 15');
  });
  test('timeColumns: 12h bietet 12, 1-11 und AM/PM', () => {
    const c = mod.timeColumns('18:30', { use12h: true });
    eq(c.parts, ['hour', 'minute', 'period'], 'Spalten');
    eq(c.values.hour, [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 'Stunden');
    eq(c.selected, { hour: 6, minute: 30, period: 1 }, '18:30 = 6 PM');
    eq(mod.timeColumns('00:05', { use12h: true }).selected, { hour: 12, minute: 5, period: 0 }, '00:05 = 12 AM');
  });
  test('pickTime: Stunde und Minute setzen ihren Teil, ohne Wert gilt die laufende Stunde', () => {
    assert(mod.pickTime('', 'hour', 18, { nowHour: 9 }) === '18:00', 'Stunde ohne Wert');
    assert(mod.pickTime('18:00', 'minute', 45) === '18:45', 'Minute');
    assert(mod.pickTime('', 'minute', 15, { nowHour: 9 }) === '09:15', 'Minute ohne Wert: laufende Stunde');
    assert(mod.pickTime('18:07', 'hour', 7) === '07:07', 'Stunde behaelt die Minute');
  });
  test('pickTime: 12h haelt AM/PM beim Stundenwechsel und schaltet es um', () => {
    const o = { use12h: true };
    assert(mod.pickTime('18:00', 'hour', 7, o) === '19:00', '7 am Nachmittag bleibt PM');
    assert(mod.pickTime('06:30', 'period', 1, o) === '18:30', 'AM -> PM');
    assert(mod.pickTime('18:30', 'period', 0, o) === '06:30', 'PM -> AM');
    assert(mod.pickTime('13:00', 'hour', 12, o) === '12:00', '12 PM ist Mittag');
    assert(mod.pickTime('00:10', 'hour', 12, o) === '00:10', '12 AM ist Mitternacht');
  });
}

console.log(`\n  ${passed} bestanden, ${failed} fehlgeschlagen\n`);
process.exit(failed > 0 ? 1 : 0);
