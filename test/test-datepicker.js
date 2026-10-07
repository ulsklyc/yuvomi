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
test('Kalenderraster ist Montag-first', () => {
  assert(/Montag\s*=\s*0/.test(comp) || /getDay\(\)\s*-\s*1/.test(comp), 'Montag-first-Offset nötig');
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

console.log(`\n  ${passed} bestanden, ${failed} fehlgeschlagen\n`);
process.exit(failed > 0 ? 1 : 0);
