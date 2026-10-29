/**
 * Modul: Der EINE Farbwaehler (public/utils/color-picker.js, Critique R24 E6)
 * Zweck: Markup und Verdrahtung des geteilten Bausteins - Familientoene als
 *        radiogroup, "Eigene" dahinter, eine Farbe ausserhalb der Reihe als
 *        eigener, gewaehlter Swatch (nie still ersetzt), das Wertfeld traegt
 *        id/name des Aufrufers und meldet jede Wahl als input + change. Dazu
 *        die Namen der Toene (Farbton-Sektor, #1507/#1723, vorher in
 *        test-waste-ui.js an `waste.color*`) und die Form in layout.css.
 *        Dass es kein nacktes `type="color"` mehr gibt, haelt
 *        `test:control-dialect` ("native-color").
 * Ausführen: node --loader ./test/test-browser-loader.mjs --test test/test-color-picker.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { eachRule } from './css-rules.js';

const { colorPickerHtml, familyColorOptions, wireColorPicker, setColorPickerValue, colorPickerValue, sameColor } = await import('../public/utils/color-picker.js');
const { USER_COLORS } = await import('../public/utils/color.js');
const SRC = readFileSync(new URL('../public/utils/color-picker.js', import.meta.url), 'utf8');
const LAYOUT = readFileSync(new URL('../public/styles/layout.css', import.meta.url), 'utf8');

/**
 * DER FARBNAME NENNT DEN FARBTON (#1507).
 *
 * Die Swatches tragen ihren Namen als `aria-label` und `title` - wer die Farbe
 * nicht sieht, hat nur ihn. Nach dem Wechsel auf die geteilte Palette hiess
 * #D946EF (Fuchsia, Farbton 292) weiter "Violett" und #059669 (Smaragd, 161)
 * weiter "Tuerkis": die Hex-Werte waren gewandert, die Namen nicht.
 *
 * Gemessen wird der Farbton des Hex-Werts gegen den Sektor, den der
 * Schluesselname behauptet. Die Sektoren sind grob und ueberlappen nicht; sie
 * sollen einen vertauschten Namen fangen, keine Nuance.
 *
 * Eine Ausnahme vom Nicht-Ueberlappen (#1723): Magenta und Fuchsia teilen
 * sich einen Sektor, weil sie derselbe Farbton sind (300 Grad, in CSS sogar
 * derselbe Wert). #EC4899 liegt bei 330 und hiess trotzdem "Magenta" - der
 * Sektor stand hier zu weit und hat den Namen gedeckt, statt ihn zu pruefen.
 * 310 bis 345 ist Pink.
 */
const HUE_SECTORS = {
  colorRed: [345, 15],
  colorOrange: [15, 28],
  colorOcher: [28, 50],
  colorGreen: [90, 150],
  colorEmerald: [150, 170],
  colorTeal: [170, 185],
  colorCyan: [185, 200],
  colorBlue: [200, 250],
  colorViolet: [250, 280],
  colorFuchsia: [280, 310],
  colorMagenta: [280, 310],
  colorPink: [310, 345],
};

function hueAndSaturation(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let hue = 0;
  if (delta > 0) {
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue = (hue * 60 + 360) % 360;
  }
  return { hue, saturation: max === 0 ? 0 : delta / max };
}


test('Familientoene: jeder Name liegt im Farbton seines Hex-Werts (#1507, aus test-waste-ui)', () => {
  const keys = [...SRC.matchAll(/'colorPicker\.(\w+)'/g)].map((m) => m[1]).filter((k) => !['custom', 'chooseCustom', 'standard'].includes(k));
  assert.equal(keys.length, USER_COLORS.length, 'nicht jede Palettenfarbe hat einen Namen');
  const failures = [];
  keys.forEach((name, i) => {
    const hex = USER_COLORS[i];
    const key = `color${name[0].toUpperCase()}${name.slice(1)}`;
    const { hue, saturation } = hueAndSaturation(hex);
    if (key === 'colorGray') {
      if (saturation > 0.2) failures.push(`${hex} heisst ${key}, ist aber bunt`);
      return;
    }
    const sector = HUE_SECTORS[key];
    assert.ok(sector, `${key}: kein Farbton-Sektor hinterlegt`);
    const [from, to] = sector;
    const inside = from < to ? hue >= from && hue < to : hue >= from || hue < to;
    if (!inside) failures.push(`${hex} heisst ${key}, liegt aber bei Farbton ${Math.round(hue)}`);
  });
  assert.deepEqual(failures, []);
  // Und die Reihe, die der Baustein baut, ist genau diese.
  assert.deepEqual(familyColorOptions().map((o) => o.value), USER_COLORS);
  assert.deepEqual(familyColorOptions().map((o) => o.label), keys.map((k) => `colorPicker.${k}`));
});

test('#EC4899 heisst in jeder Sprache Pink, kein Name doppelt (#1723, aus test-waste-ui)', () => {
  const dir = new URL('../public/locales/', import.meta.url);
  const files = readdirSync(dir).filter((file) => file.endsWith('.json'));
  assert.ok(files.length >= 20, 'zu wenige Locale-Dateien gelesen');
  for (const file of files) {
    const { colorPicker } = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
    assert.equal(typeof colorPicker?.pink, 'string', `${file}: colorPicker.pink fehlt`);
    const names = Object.entries(colorPicker).filter(([key]) => !['custom', 'chooseCustom', 'standard'].includes(key)).map(([, v]) => v);
    assert.equal(names.length, USER_COLORS.length, `${file}: ${names.length} Farbnamen`);
    assert.equal(new Set(names).size, names.length, `${file}: zwei Farben heissen gleich (${names.join(', ')})`);
    assert.equal(colorPicker.magenta, undefined);
  }
});

const checkedOf = (html) => [...html.matchAll(/<button[^>]*class="color-swatch[^"]*"[^>]*aria-checked="true"[^>]*>/g)];

test('Markup: radiogroup mit Namen, Wertfeld mit id/name, genau ein gewaehlter Swatch', () => {
  const html = colorPickerHtml({ id: 'x-color', name: 'color', value: '#3B82F6', labelledBy: 'x-label' });
  assert.match(html, /role="radiogroup" aria-labelledby="x-label"/);
  assert.match(html, /<input type="hidden" id="x-color" name="color" value="#3B82F6">/);
  assert.equal((html.match(/role="radio"/g) ?? []).length, USER_COLORS.length);
  const checked = checkedOf(html);
  assert.equal(checked.length, 1);
  assert.match(checked[0][0], /data-color="#3B82F6"/);
  assert.match(checked[0][0], /tabindex="0"/);
  assert.equal((html.match(/tabindex="0"/g) ?? []).length, 1, 'ein Tab-Stopp in der Reihe');
  // "Eigene": der Systemwaehler, ausserhalb des Verwerfen-Vergleichs (das Wertfeld zaehlt).
  assert.match(html, /<input type="color" class="color-picker__native" data-dirty-ignore value="#3b82f6" aria-label="colorPicker\.chooseCustom"/);
});

test('Markup: kleingeschriebener Bestandswert trifft seinen Swatch, kein elfter', () => {
  const html = colorPickerHtml({ value: '#16a34a', label: 'Farbe' });
  assert.equal((html.match(/role="radio"/g) ?? []).length, USER_COLORS.length);
  assert.match(checkedOf(html)[0][0], /data-color="#16A34A"/);
  assert.match(html, /role="radiogroup" aria-label="Farbe"/);
});

test('Markup: eine Farbe ausserhalb der Reihe wird nie still ersetzt - eigener, gewaehlter Swatch', () => {
  const html = colorPickerHtml({ value: '#123456', label: 'Farbe' });
  assert.equal((html.match(/role="radio"/g) ?? []).length, USER_COLORS.length + 1);
  const [checked] = checkedOf(html);
  assert.match(checked[0], /data-color="#123456"/);
  assert.match(checked[0], /data-color-custom=""/);
  assert.match(checked[0], /aria-label="colorPicker\.custom"/);
  assert.match(checked[0], /style="--swatch:#123456"/);
});

test('Markup: ohne Wert bekommt der erste Swatch den Tab-Stopp; kuratierte Reihen ohne "Eigene"', () => {
  const html = colorPickerHtml({ value: '', label: 'Farbe', custom: false, options: [{ value: 'a', paint: 'var(--x)', label: 'A' }, { value: 'b', label: 'B<' }] });
  assert.equal(checkedOf(html).length, 0);
  assert.equal((html.match(/tabindex="0"/g) ?? []).length, 1);
  assert.match(html, /data-color="a" style="--swatch:var\(--x\)" aria-label="A"/);
  assert.match(html, /aria-label="B&lt;"/, 'Namen laufen durch esc()');
  assert.doesNotMatch(html, /type="color"/);
});

// --- Verdrahtung an einem kleinen Stand-in (kein jsdom im Repo) -----------

function fakePicker(colors, value) {
  const listeners = {};
  const hiddenEvents = [];
  const hidden = { value, dispatchEvent: (e) => hiddenEvents.push(e.type) };
  let focused = null;
  const swatches = colors.map((c) => {
    const attrs = new Map([['aria-checked', String(c === value)], ['tabindex', c === value ? '0' : '-1']]);
    const cls = new Set(['color-swatch', ...(c === value ? ['color-swatch--active'] : [])]);
    const sw = {
      dataset: { color: c }, style: { setProperty() {} },
      classList: { toggle: (k, on) => (on ? cls.add(k) : cls.delete(k)), contains: (k) => cls.has(k) },
      setAttribute: (k, v) => attrs.set(k, String(v)), getAttribute: (k) => attrs.get(k) ?? null,
      hasAttribute: () => false, focus() { focused = sw; },
      closest: (sel) => (sel === '.color-swatch' ? sw : sel === '[data-color-picker]' ? picker : null),
    };
    return sw;
  });
  const picker = {
    _colorPickerWired: false,
    querySelectorAll: (sel) => (sel === '.color-swatch' ? swatches : sel === '[data-color-picker]' ? [picker] : []),
    querySelector: (sel) => (sel.includes('hidden') ? hidden : null),
    addEventListener: (type, fn) => { listeners[type] = fn; },
    contains: () => true, closest: (sel) => (sel === '[data-color-picker]' ? picker : null),
  };
  globalThis.getComputedStyle = () => ({ direction: 'ltr' });
  return { picker, swatches, hidden, hiddenEvents, listeners, focused: () => focused };
}

test('Verdrahtung: Tipp waehlt, schreibt das Wertfeld und meldet input + change', () => {
  const f = fakePicker(['#111111', '#222222', '#333333'], '#111111');
  wireColorPicker(f.picker);
  f.listeners.click({ target: f.swatches[2] });
  assert.equal(f.hidden.value, '#333333');
  assert.deepEqual(f.hiddenEvents, ['input', 'change']);
  assert.equal(f.swatches[2].getAttribute('aria-checked'), 'true');
  assert.equal(f.swatches[0].getAttribute('aria-checked'), 'false');
  assert.equal(f.swatches[2].getAttribute('tabindex'), '0');
  assert.equal(f.swatches[0].getAttribute('tabindex'), '-1');
  assert.equal(colorPickerValue(f.picker), '#333333');
  // Ein zweiter Aufruf verdrahtet nicht doppelt.
  const before = f.listeners.click;
  wireColorPicker(f.picker);
  assert.equal(f.listeners.click, before);
});

test('Verdrahtung: Pfeile wandern mit Umlauf, Pos1/Ende springen, die Wahl folgt dem Fokus', () => {
  const f = fakePicker(['#111111', '#222222', '#333333'], '#111111');
  wireColorPicker(f.picker);
  const key = (k, target) => { let prevented = false; f.listeners.keydown({ key: k, target, preventDefault: () => { prevented = true; } }); return prevented; };
  assert.ok(key('ArrowLeft', f.swatches[0]));
  assert.equal(f.hidden.value, '#333333', 'links vom ersten ist der letzte');
  assert.equal(f.focused(), f.swatches[2]);
  key('Home', f.swatches[2]);
  assert.equal(f.hidden.value, '#111111');
  key('ArrowDown', f.swatches[0]);
  assert.equal(f.hidden.value, '#222222');
  assert.equal(key('Tab', f.swatches[1]), false, 'Tab bleibt beim Browser');
});

test('setColorPickerValue: von aussen ohne Ereignis, Schreibweise egal', () => {
  const f = fakePicker(['#111111', '#AABBCC'], '#111111');
  setColorPickerValue(f.picker, '#aabbcc');
  assert.equal(f.hidden.value, '#AABBCC');
  assert.deepEqual(f.hiddenEvents, [], 'wie ein zugewiesenes .value - kein Ereignis');
  assert.ok(sameColor('#aabbcc', '#AABBCC'));
});

test('Form in layout.css (global): Swatch + Abstand = Zielgroesse, Innenkante, Ring in Textfarbe', () => {
  const rules = [...eachRule(LAYOUT)].filter((r) => !r.at.length);
  const base = rules.find((r) => r.selector.trim() === '.color-swatch');
  assert.ok(base, '.color-swatch fehlt in layout.css');
  assert.match(base.body, /box-shadow:\s*inset 0 0 0 1px var\(--color-border\)/, 'Innenkante, sonst laeuft der Swatch im Dark in den Kartengrund');
  // R24 S15: DIE TREFFERFLAECHEN STOSSEN ANEINANDER, KEINE UEBERLAPPT. Bis
  // dahin stand ein fester Ueberstand von 10px bei 12px/8px Abstand - je zwei
  // Nachbarflaechen ueberlappten, und ein Tipp neben einem Swatch traf den
  // naechsten (gemessen 40x36 statt 48). Gehalten wird die Rechnung, nicht
  // eine Zahl: Swatch = Zielgroesse - Abstand, ein Abstand fuer beide Achsen,
  // der Ueberstand die halbe Differenz abzueglich des Rings (`inset` zaehlt ab
  // der Innenkante des Rings).
  const picker = rules.find((r) => r.selector.trim() === '.color-picker');
  assert.match(picker?.body ?? '', /--swatch-hit:\s*var\(--target-base\)/, 'die Trefferflaeche ist die Zielgroesse');
  assert.match(picker?.body ?? '', /--swatch-size:\s*calc\(var\(--swatch-hit\) - var\(--swatch-gap\)\)/, 'Swatch = Zielgroesse - Abstand');
  assert.match(picker?.body ?? '', /gap:\s*var\(--swatch-gap\)/, 'Abstand zu "Eigene" ist derselbe');
  const row = rules.find((r) => r.selector.trim() === '.color-picker__swatches');
  assert.match(row?.body ?? '', /gap:\s*var\(--swatch-gap\);/, 'EIN Abstand fuer Reihe und Umbruch - laengs enger hiesse wieder Ueberlappung');
  assert.match(base.body, /border:\s*var\(--space-0h\) solid transparent/);
  const hit = rules.find((r) => r.selector.trim() === '.color-swatch::before');
  assert.match(hit?.body ?? '', /inset:\s*calc\(\(var\(--swatch-size\) - var\(--swatch-hit\)\) \/ 2 - var\(--space-0h\)\)/);
  const active = rules.find((r) => r.selector.trim() === '.color-swatch.color-swatch--active');
  assert.match(active?.body ?? '', /border-color:\s*var\(--color-text-primary\)/);
  const native = rules.find((r) => r.selector.trim() === '.color-picker .color-picker__native');
  assert.match(native?.body ?? '', /opacity:\s*0/);
  assert.match(native?.body ?? '', /inset:\s*calc\(\(var\(--swatch-size\) - var\(--swatch-hit\)\) \/ 2\)/, '"Eigene" hat keinen Ring, sonst dieselbe Flaeche');
  assert.match(native?.body ?? '', /inline-size:\s*var\(--swatch-hit\)/);
  for (const sheet of ['calendar', 'waste']) {
    const css = readFileSync(new URL(`../public/styles/${sheet}.css`, import.meta.url), 'utf8');
    assert.ok(![...eachRule(css)].some((r) => /^\.(?:waste-)?color-swatch$|^\.color-picker$/.test(r.selector.trim())), `${sheet}.css fuehrt eine eigene Fassung`);
  }
});
