import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';

import { SUPPORTED_LOCALES } from '../tools/installer/i18n-mini.js';

const HTML_PATH = new URL('../tools/installer/install.html', import.meta.url);
const LOCALES_DIR = new URL('../tools/installer/locales/', import.meta.url);
const html = readFileSync(HTML_PATH, 'utf8');

function loadLocale(locale) {
  return JSON.parse(readFileSync(new URL(`${locale}.json`, LOCALES_DIR), 'utf8'));
}

// ── 1.2 Accordion-Trigger sind tastaturbedienbare Buttons ─────────────────────

test('kein toggle-header ist mehr ein <div> (alle sind <button>)', () => {
  assert.doesNotMatch(html, /<div[^>]*class="toggle-head"/,
    'toggle-head darf kein <div> mehr sein');
});

test('jeder data-toggle-Trigger ist ein <button> mit type, aria-expanded und aria-controls', () => {
  const allToggles = [...html.matchAll(/\bdata-toggle="([^"]+)"/g)].map(m => m[1]);
  assert.ok(allToggles.length >= 4, 'erwartet mindestens vier Accordion-Trigger');

  const buttonToggles = [...html.matchAll(/<button[^>]*\bdata-toggle="([^"]+)"[^>]*>/g)];
  assert.equal(buttonToggles.length, allToggles.length,
    'jeder data-toggle muss auf einem <button> sitzen');

  for (const m of buttonToggles) {
    const tag = m[0];
    const target = m[1];
    assert.match(tag, /type="button"/, `Trigger für ${target} braucht type="button"`);
    assert.match(tag, /aria-expanded="false"/, `Trigger für ${target} braucht aria-expanded`);
    assert.match(tag, new RegExp(`aria-controls="${target}"`),
      `Trigger für ${target} braucht aria-controls="${target}"`);
  }
});

test('der Toggle-Handler aktualisiert aria-expanded', () => {
  assert.match(html, /setAttribute\(\s*'aria-expanded'/,
    'Klick-Handler muss aria-expanded synchron halten');
});

// ── 1.3 ARIA-Live-Regionen ────────────────────────────────────────────────────

test('jedes error-banner trägt role="alert"', () => {
  const banners = [...html.matchAll(/<div[^>]*class="error-banner"[^>]*>/g)];
  assert.ok(banners.length >= 6, 'erwartet mindestens sechs Fehler-Banner');
  for (const m of banners) {
    assert.match(m[0], /role="alert"/, `Fehler-Banner ohne role="alert": ${m[0]}`);
  }
});

test('die Docker-Statuszeile ist eine Live-Region', () => {
  // Seit der Phasen-Checkliste ist sie visuell versteckt (class="vh status-row"):
  // sichtbar steht dasselbe in der Liste, die Region traegt nur die Ansage.
  const row = html.match(/<div[^>]*class="[^"]*\bstatus-row\b[^"]*"[^>]*>/);
  assert.ok(row, 'status-row nicht gefunden');
  assert.match(row[0], /role="status"/, 'status-row braucht role="status"');
  assert.match(row[0], /aria-live="polite"/, 'status-row braucht aria-live="polite"');
});

// Der Spinner ist seit der Phasen-Checkliste das Zeichen der laufenden Phase.
// Regel wie vorher: jedes Zustandszeichen ist reine Grafik und fuer
// Screenreader ausgeblendet - der Zustand steht als Text daneben.
test('die Zustandszeichen des Docker-Schirms sind für Screenreader ausgeblendet', () => {
  const marks = [...html.matchAll(/<span[^>]*class="phase__mark"[^>]*>/g)];
  assert.equal(marks.length, 3, `erwartet drei Phasenzeichen, gefunden ${marks.length}`);
  for (const m of marks) assert.match(m[0], /aria-hidden="true"/, `Phasenzeichen ohne aria-hidden: ${m[0]}`);
});

// ── 1.4 Fokus-Management bei Schrittwechsel ───────────────────────────────────

test('jede Schritt-Überschrift ist per Skript fokussierbar (tabindex="-1")', () => {
  // Die persistente, visuell versteckte Seiten-<h1 class="vh"> ist der einzige
  // dauerhafte Landmark-Titel und wird NICHT per Skript fokussiert — ausnehmen.
  const headings = [...html.matchAll(/<h[12][^>]*>/g)].filter(m => !/class="vh"/.test(m[0]));
  assert.ok(headings.length > 0, 'keine Schritt-Überschriften gefunden');
  for (const m of headings) {
    assert.match(m[0], /tabindex="-1"/, `Schritt-Überschrift ohne tabindex="-1": ${m[0]}`);
  }
});

test('genau eine <h1> (persistenter Seitentitel) plus <main>-Landmark', () => {
  const h1s = [...html.matchAll(/<h1[^>]*>/g)];
  assert.equal(h1s.length, 1, `genau eine <h1> erwartet, gefunden: ${h1s.length}`);
  assert.match(h1s[0][0], /class="vh"/, 'die einzige <h1> ist der versteckte Seitentitel');
  assert.match(html, /<main\b/, 'die Karte braucht einen <main>-Landmark');
});

test('showStep setzt den Fokus auf die aktive Überschrift', () => {
  assert.match(html, /\.focus\(\s*\{\s*preventScroll:\s*true\s*\}\s*\)/,
    'showStep muss den Fokus (ohne Scroll-Sprung) auf die Überschrift setzen');
});

// ── 1.5 Augen-Buttons haben ein zugängliches Label ────────────────────────────

test('jeder Augen-Button hat aria-label und data-i18n-aria', () => {
  const eyeButtons = [...html.matchAll(/<button[^>]*\bdata-eye="[^"]+"[^>]*>/g)];
  assert.ok(eyeButtons.length >= 3, 'erwartet mindestens drei Augen-Buttons');
  for (const m of eyeButtons) {
    assert.match(m[0], /aria-label="/, `Augen-Button ohne aria-label: ${m[0]}`);
    assert.match(m[0], /data-i18n-aria="/, `Augen-Button ohne data-i18n-aria: ${m[0]}`);
  }
});

// ── 1.6 Schritt 1 nutzt dasselbe Fehler-Rendering wie alle anderen ────────────

test('kein veraltetes class="error" mehr (vereinheitlicht auf error-banner)', () => {
  assert.doesNotMatch(html, /class="error"/, 'class="error" existiert nicht im CSS');
});

test('cfg-err ist ein error-banner', () => {
  assert.match(html, /<div[^>]*id="cfg-err"[^>]*class="error-banner"|<div[^>]*class="error-banner"[^>]*id="cfg-err"/,
    'cfg-err muss ein error-banner sein');
});

// ── 1.7 Schrittzähler aus den Schritten abgeleitet, nicht hartcodiert ─────────

test('keine hartcodierten "Step N of 7"-Zähler im Markup', () => {
  assert.doesNotMatch(html, /Step .* of 7/, 'hartcodierter "of 7"-Zähler gefunden');
});

test('Schrittzähler wird im Skript aus den Schritten berechnet', () => {
  assert.match(html, /common\.stepCounter/, 'stepCounter-Schlüssel wird nicht verwendet');
});

test('common.stepCounter existiert in jeder Locale mit {{n}}/{{total}}', () => {
  for (const locale of SUPPORTED_LOCALES) {
    const data = loadLocale(locale);
    const tpl = data.common && data.common.stepCounter;
    assert.ok(tpl, `${locale}.json fehlt common.stepCounter`);
    assert.match(tpl, /\{\{n\}\}/, `${locale}: stepCounter ohne {{n}}`);
    assert.match(tpl, /\{\{total\}\}/, `${locale}: stepCounter ohne {{total}}`);
  }
});

/* advanced.tag ("Erweitert · optional") durfte einmal bleiben, als der
 * Erweitert-Schritt keine Nummer trug. Seit er nummeriert ist, schrieb
 * applyStepCounters() den Zaehler darueber - der Text stand tot im Markup und
 * in 24 Locales. Regel jetzt: keine Schrittmarke traegt einen eigenen Text,
 * den der Zaehler ueberschreibt, und kein Schritt fuehrt einen *.tag-Schluessel. */
test('keine Schrittmarke traegt einen Text, den der Zaehler ueberschreibt', () => {
  for (const locale of SUPPORTED_LOCALES) {
    const data = loadLocale(locale);
    const tagged = Object.keys(data).filter(section => typeof data[section]?.tag === 'string');
    assert.deepEqual(tagged, [], `${locale}: tote *.tag-Schluessel ${tagged}`);
  }
  const steps = [...html.matchAll(/<div class="step-tag"([^>]*)>([^<]*)<\/div>/g)];
  assert.ok(steps.length >= 9, `nur ${steps.length} Schrittmarken gefunden - der Leser greift nicht`);
  for (const [tag, attrs, text] of steps) {
    assert.doesNotMatch(attrs, /data-i18n/, `Schrittmarke mit data-i18n: ${tag}`);
    assert.equal(text.trim(), '', `Schrittmarke mit totem Text: ${tag}`);
  }
});

// ── 1.8 Mobile Wirkung: Schlüsselbreite, Schriftgrössen, Zielgrössen ─────────
//
// Der Vorgänger dieses Blocks prüfte, ob `flex-wrap: wrap` im Stylesheet STEHT.
// Er war grün, während `#sec-db` bei 390px auf 102px für einen 64-Zeichen-
// Schlüssel zusammenfiel - direkt unter der Aufforderung „Speichere diese
// Schlüssel jetzt". Die Regel stand da, sie wirkte nur nicht: `flex: 1` setzt
// die Basis auf 0, das Feld schrumpfte also, statt umzubrechen.
//
// Gemessen wird deshalb die Wirkung, nicht die Schreibweise: die Breite in px,
// die das Feld am Ende bekommt. Kein Browser, sondern dieselbe Rechnung, die
// der Browser für diese eine Zeile anstellt - eine flexible Box neben festen
// Buttons. Bekannte Grenze: das Modell kennt nur `flex-direction: row`; ein
// Umbau auf `column` müsste hier mitgezogen werden.

const MOBILE_VIEWPORT = 390;   // iPhone-Klasse, dieselbe Breite wie im Critique

/** Alle <style>-Blöcke der Datei, ohne Kommentare. */
function stylesheet(source) {
  return [...source.matchAll(/<style>([\s\S]*?)<\/style>/g)]
    .map(m => m[1]).join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Flache Regelliste { selector, body, media }; @media wird eine Ebene tief aufgelöst. */
function collectRules(css) {
  const out = [];
  const walk = (text, media) => {
    let idx = 0;
    while (idx < text.length) {
      const brace = text.indexOf('{', idx);
      if (brace === -1) break;
      const prelude = text.slice(idx, brace).trim();
      let depth = 1;
      let end = brace + 1;
      while (end < text.length && depth > 0) {
        if (text[end] === '{') depth++;
        else if (text[end] === '}') depth--;
        end++;
      }
      const body = text.slice(brace + 1, end - 1);
      if (prelude.startsWith('@')) {
        // Nur Media-Queries tragen hier Regeln, die uns interessieren.
        if (/^@media/i.test(prelude)) walk(body, prelude);
      } else {
        for (const sel of prelude.split(',')) out.push({ selector: sel.trim(), body, media });
      }
      idx = end;
    }
  };
  walk(css, null);
  return out;
}

const RULES = collectRules(stylesheet(html));

/**
 * Wirksamer Wert einer Eigenschaft. Später deklariert gewinnt, wie in der
 * Kaskade bei gleicher Spezifität. `mediaMatch` entscheidet, welche
 * Media-Blöcke bei der geprüften Breite überhaupt gelten.
 */
function declared(selectorMatches, prop, mediaMatches = media => media === null) {
  let value = null;
  for (const rule of RULES) {
    if (!mediaMatches(rule.media)) continue;
    if (!selectorMatches(rule.selector)) continue;
    const found = rule.body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'i'));
    if (found) value = found[1].trim();
  }
  return value;
}

/** Gilt der Media-Block bei `width`? Deckt die hier benutzte max-width-Form ab. */
function appliesAt(width) {
  return media => {
    if (media === null) return true;
    const max = media.match(/max-width:\s*(\d+)px/i);
    if (max) return width <= Number(max[1]);
    // Alles andere (prefers-color-scheme, prefers-reduced-motion) ist für die
    // Breitenrechnung kein Faktor und bleibt bewusst draussen.
    return false;
  };
}

/** :root-Custom-Properties des Inline-Fallbacks, für var()-Auflösung. */
const ROOT_VARS = (() => {
  const map = new Map();
  for (const rule of RULES) {
    if (rule.selector !== ':root' || rule.media !== null) continue;
    for (const [, name, value] of rule.body.matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) {
      map.set(name, value.trim());
    }
  }
  return map;
})();

/** Längenwert in px; löst var() und rem auf, gibt bei Prozent den Anteil zurück. */
function toPx(value, base = null) {
  if (value == null) return null;
  let raw = value.trim();
  const variable = raw.match(/^var\(\s*(--[\w-]+)/);
  if (variable) raw = ROOT_VARS.get(variable[1]) ?? raw;
  const rem = raw.match(/^(-?[\d.]+)rem/);
  if (rem) return Number(rem[1]) * 16;
  const px = raw.match(/^(-?[\d.]+)px/);
  if (px) return Number(px[1]);
  const pct = raw.match(/^(-?[\d.]+)%/);
  if (pct && base !== null) return (Number(pct[1]) / 100) * base;
  return null;
}

/** Horizontales Padding aus einem padding-Shorthand (1 bis 4 Werte). */
function paddingX(shorthand) {
  const parts = shorthand.trim().split(/\s+/);
  const right = parts.length === 1 ? parts[0] : parts[1];
  const left = parts.length >= 4 ? parts[3] : right;
  return { left: toPx(left) ?? 0, right: toPx(right) ?? 0 };
}

/** Innenbreite der Karte bei `viewport`, so wie der Browser sie ausrechnet. */
function cardContentWidth(viewport) {
  const media = appliesAt(viewport);
  const body = paddingX(declared(sel => sel === 'body', 'padding', media));
  const cardMax = toPx(declared(sel => sel === '.card', 'max-width', media));
  const cardBody = paddingX(declared(sel => sel === '.card-body', 'padding', media));
  const cardWidth = Math.min(cardMax, viewport - body.left - body.right);
  return cardWidth - cardBody.left - cardBody.right;
}

/**
 * Innenbreite einer Zeile in einer Inset-Gruppe. Seit die Felder in Gruppen
 * stehen (Critique 2026-09-29), liegt zwischen Kartenkante und Feld noch das
 * Zeilenpolster - ohne es rechnete das Modell mit 32px zu viel Platz.
 */
function rowContentWidth(viewport, rowSelector) {
  const pad = paddingX(declared(sel => sel === rowSelector, 'padding', appliesAt(viewport)) || '0');
  return cardContentWidth(viewport) - pad.left - pad.right;
}

/** flex-Shorthand in { grow, shrink, basis } zerlegen. */
function flexParts(shorthand) {
  const parts = shorthand.trim().split(/\s+/);
  if (parts.length === 1) {
    // `flex: 1` heisst 1 1 0% - genau die Basis 0, die das Feld schrumpfen liess.
    return /^[\d.]+$/.test(parts[0])
      ? { grow: Number(parts[0]), shrink: 1, basis: '0%' }
      : { grow: 1, shrink: 1, basis: parts[0] };
  }
  if (parts.length === 2) return { grow: Number(parts[0]), shrink: Number(parts[1]), basis: '0%' };
  return { grow: Number(parts[0]), shrink: Number(parts[1]), basis: parts[2] };
}

/**
 * Breite, die das Secret-Feld in der längsten Secret-Zeile bekommt.
 * Modelliert eine Flex-Zeile: eine flexible Box plus N unflexible Buttons.
 */
function secretFieldWidth(viewport) {
  const media = appliesAt(viewport);
  const available = rowContentWidth(viewport, '.inset-group .field');
  const gap = toPx(declared(sel => sel === '.secret-row', 'gap', media)) ?? 0;
  const wraps = (declared(sel => sel === '.secret-row', 'flex-wrap', media) || 'nowrap') === 'wrap';

  const flex = flexParts(declared(sel => sel === '.secret-row input', 'flex', media) || '0 1 auto');
  const basis = toPx(flex.basis, available) ?? 0;
  const minWidth = toPx(declared(sel => sel === '.secret-row input', 'min-width', media)) ?? 0;

  // Die längste Zeile im Markup bestimmt die Rechnung: der DB-Schlüssel trägt
  // Auge, Kopieren und Generieren. Aus dem Markup gezählt, nicht angenommen.
  const rows = [...html.matchAll(/<div class="secret-row">([\s\S]*?)<\/div>\s*<\/div>/g)];
  const buttons = Math.max(...rows.map(m => (m[1].match(/<button/g) || []).length), 1);
  const buttonWidth = toPx(declared(sel => sel === '.btn-sm', 'min-width', media)) ?? 44;
  const buttonsBlock = buttons * buttonWidth + buttons * gap;

  // Passt die Basis nicht neben die Buttons und ist Umbruch erlaubt, bekommt
  // das Feld eine eigene Zeile und damit die volle Breite.
  if (wraps && basis + buttonsBlock > available) return available;
  return Math.max(minWidth, available - buttonsBlock);
}

test('das Secret-Feld bekommt auf dem Handy die volle Zeile, nicht den Rest', () => {
  const breite = secretFieldWidth(MOBILE_VIEWPORT);
  const voll = rowContentWidth(MOBILE_VIEWPORT, '.inset-group .field');
  assert.ok(breite >= voll * 0.95,
    `#sec-db misst bei ${MOBILE_VIEWPORT}px nur ${breite.toFixed(0)}px von ${voll.toFixed(0)}px verfügbarer Breite. `
    + 'Ein 64-Zeichen-Schlüssel gehört auf eine eigene Zeile, die Buttons darunter.');
});

/* Die Pruefseite traegt unzerbrechliche Maschinenwerte (BASE_URL mit DDNS-Host,
 * Nextcloud-WebDAV-URL) in Zeilen mit fester Schluesselspalte. Gemessen
 * 2026-08-31: 534px body-scrollWidth bei 375px Viewport - die GANZE Seite
 * scrollte seitlich, inklusive Sticky-Footer (WCAG 1.4.10), ausgerechnet auf
 * dem Kontrollschirm vor dem irreversiblen Klick. Die damalige Suite mass nur
 * die .secret-row; dieselbe Luecke gab es hier ohne Guard.
 *
 * Seit 2026-09-29 ist die Pruefseite nach Schritten gruppiert, und jede Zeile
 * (.rv-row) ist ihr eigenes Zwei-Spalten-Raster statt eines Rasters ueber die
 * ganze Seite. Die Regel ist dieselbe geblieben, deshalb misst der Guard sie
 * jetzt dort: in der Zeile, abzueglich ihres Polsters.
 *
 * Modelliert wird die WIRKUNG, nicht die Regel: wie breit wird die Seite mit
 * einem 500px-Wert in der Wertspalte? `overflow-wrap: anywhere` senkt dessen
 * min-content auf ~0 (anders als break-word, das die Messung nicht aendert),
 * minmax(0, ...) erlaubt der Spur, unter min-content zu schrumpfen. */
function reviewRowNeed(viewport, unbreakable) {
  const media = appliesAt(viewport);
  const columns = declared(sel => sel === '.rv-row', 'grid-template-columns', media) || '160px 1fr';
  const tracks = columns.match(/minmax\([^)]*\)|\S+/g) || [];
  const gapParts = (declared(sel => sel === '.rv-row', 'gap', media) || '0').trim().split(/\s+/);
  const gapX = toPx(gapParts[1] ?? gapParts[0]) ?? 0;

  const trackMin = track => {
    const m = track.match(/minmax\(\s*([^,]+),/);
    if (m) return toPx(m[1]) ?? 0;
    if (/fr$/.test(track)) return null;   // auto-Minimum: der Inhalt bestimmt
    return toPx(track) ?? 0;
  };
  const keyMin = trackMin(tracks[0] ?? '160px') ?? 0;

  const wrap = (declared(sel => sel === '.rv-row dd', 'overflow-wrap', media) || 'normal').trim();
  // Nur `anywhere` geht in die min-content-Rechnung ein (CSS Text 3, §5.2).
  const valueContentMin = wrap === 'anywhere' ? 0 : unbreakable;
  const valueTrackMin = trackMin(tracks[1] ?? '1fr');
  // Spur mindestens so breit wie ihr Minimum; Inhalt, der nicht umbricht,
  // blutet ueber die Spur hinaus und verbreitert die Seite trotzdem.
  return keyMin + gapX + Math.max(valueTrackMin ?? valueContentMin, valueContentMin);
}

test('ein unzerbrechlicher Wert verbreitert die Pruefseite nicht (WCAG 1.4.10)', () => {
  assert.ok(html.includes('class="rv-row"'), 'keine .rv-row im Markup - der Guard misst ins Leere');
  const need = reviewRowNeed(MOBILE_VIEWPORT, 500);
  const available = rowContentWidth(MOBILE_VIEWPORT, '.rv-row');
  assert.ok(need <= available,
    `Eine Pruefzeile braucht mit einem 500px-Wert ${need.toFixed(0)}px von ${available.toFixed(0)}px `
    + 'verfuegbarer Breite. Wertspalte minmax(0, ...) plus overflow-wrap: anywhere '
    + 'auf den Wertzellen halten lange URLs in der Gruppe.');
});

test('Redirect-URIs in Hints brechen um, statt an der Kartenkante zu clippen', () => {
  // Die drei Redirect-<code>-Knoten stehen in .hint-Absaetzen innerhalb von
  // toggle-cards mit overflow: hidden - ohne Umbruch wird der zeichengenau zu
  // kopierende Wert kommentarlos abgeschnitten (gemessen 472px Inhalt in einer
  // 343px-Karte). word-break: break-all senkt die min-content-Breite auf ~0.
  const rule = declared(sel => sel === '.hint code', 'word-break');
  const breaks = rule === 'break-all'
    || (declared(sel => sel === '.hint code', 'overflow-wrap') === 'anywhere');
  assert.ok(breaks,
    'Redirect-URIs (<code> in .hint) brauchen word-break: break-all oder '
    + 'overflow-wrap: anywhere - sonst clippt overflow:hidden der Toggle-Card sie mobil.');
});

test('das Secret-Feld ist mindestens 14px gross (12px war unlesbar)', () => {
  const size = toPx(declared(sel => sel === '.secret-row input', 'font-size'));
  assert.ok(size >= 14, `Secret-Felder stehen auf ${size}px, mindestens 14px sind nötig`);
});

test('Textfelder stehen auf mindestens 16px (sonst zoomt iOS Safari bei jedem Fokus)', () => {
  // Unter 16px zoomt iOS Safari beim Fokus in ein Feld und verschiebt das
  // Layout. Der Befund stand seit dem Juni-Critique offen. Die Secret-Zeile ist
  // die bewusste Ausnahme: monospace, 64 Zeichen, dort wiegt Lesbarkeit mehr.
  const size = toPx(declared(sel => /^input\[type=text\]/.test(sel), 'font-size'));
  assert.ok(size >= 16, `Textfelder stehen auf ${size}px, iOS zoomt unter 16px`);
});

test('Bedienelemente erfüllen die Zielgrössen (44px Höhe, 24px Schalterbahn)', () => {
  const media = appliesAt(MOBILE_VIEWPORT);
  const buttonHeight = toPx(declared(sel => sel === '.btn', 'min-height', media));
  assert.ok(buttonHeight >= 44, `.btn ist ${buttonHeight}px hoch, 44px sind das Touch-Minimum`);

  const selectHeight = toPx(declared(sel => /(^|,)\s*select$/.test(sel) || sel === 'select', 'min-height', media));
  assert.ok(selectHeight >= 44, `select ist ${selectHeight}px hoch, 44px sind das Touch-Minimum`);

  // WCAG 2.2 SC 2.5.8 verlangt 24x24 CSS-Pixel, in jeder Breite. Die Kästchen
  // waren 13x13 neben einem 16px hohen Label. Seit den Schaltern der App ist
  // das sichtbare Ziel die Bahn (die ganze Zeile nimmt den Tipp ohnehin an,
  // siehe "Schalterzeile" unten).
  for (const prop of ['width', 'height']) {
    const size = toPx(declared(sel => sel === '.toggle__track', prop));
    assert.ok(size >= 24, `Schalterbahn-${prop} ist ${size}px, WCAG 2.2 verlangt 24px`);
  }
});

/* Der Test darueber fragt drei bekannte Selektoren ab - und war deshalb gruen,
 * waehrend der Browser 36px am Sprachumschalter und 43px an den sieben
 * Akkordeon-Koepfen mass (Critique 2026-08-15). Zwei verschiedene Luecken, eine
 * Ursache: er prueft die REGEL, die er kennt, nicht die WIRKUNG am Element.
 *
 *   - `.lang-switch select` (0,1,1) schlaegt das nackte `select` (0,0,1) aus der
 *     mobilen Haertung, und eine Media-Query hebt die Spezifitaet nicht an.
 *     Die 44px-Regel galt fuer dieses Element nie.
 *   - `.toggle-head` ist ein <button> OHNE .btn-Klasse und fiel durch beide
 *     Netze - weder `.btn` noch `.btn-sm` erfassen ihn.
 *
 * Dieser Guard dreht die Frage um: er sucht JEDE min-height unter 44px auf einem
 * Bedienelement und verlangt, dass eine spaetere Regel mit demselben Selektor sie
 * wieder anhebt. Ein neues Bedienelement kann so nicht mehr unbemerkt darunter
 * rutschen, egal wie es heisst. */
const CONTROL_SELECTOR = /(?:^|[\s>+~])(?:button|select|textarea|input\b[^\s]*|a)$|\.(?:btn|btn-sm|toggle-head|link-btn|mode-card|open-link)\b[^\s]*$/;

test('keine Regel druckt ein Bedienelement unter 44px, ohne es wieder anzuheben', () => {
  const mobile = appliesAt(MOBILE_VIEWPORT);
  const offenders = [];

  RULES.forEach((rule, i) => {
    if (!mobile(rule.media)) return;
    if (!CONTROL_SELECTOR.test(rule.selector)) return;
    const found = rule.body.match(/(?:^|;)\s*min-height\s*:\s*([^;]+)/i);
    if (!found) return;
    const px = toPx(found[1].trim());
    if (!(px < 44)) return;

    // Hebt eine spaetere Regel mit demselben Selektor den Wert wieder an? Nur
    // dann ist die niedrige Deklaration folgenlos.
    const lifted = RULES.some((later, j) =>
      j > i && later.selector === rule.selector && mobile(later.media) &&
      toPx((later.body.match(/(?:^|;)\s*min-height\s*:\s*([^;]+)/i) || [])[1]?.trim()) >= 44);
    if (!lifted) offenders.push(`${rule.selector} = ${px}px`);
  });

  assert.deepEqual(offenders, [],
    `Bedienelemente unter der 44px-Zielgroesse, ohne spaetere Anhebung: ${offenders.join(', ')}`);
});

/* Die zweite Haelfte derselben Luecke: .toggle-head stand bei 43px, OHNE eine
 * min-height zu deklarieren - die Hoehe kam aus 13px Padding plus 17px Inhalt.
 * Der Guard darueber sieht nur Deklarationen und konnte das prinzipiell nicht
 * fangen. Geprueft wird deshalb die Gruppe, nicht die Klasse: jeder
 * data-toggle-Trigger sichert seine Hoehe ausdruecklich. Ein achter Akkordeon-
 * Kopf ist damit automatisch mit erfasst.
 *
 * Bewusst NICHT enthalten ist .link-btn (34px, "Mehr Optionen noetig?"): das ist
 * ein Textlink im Fliesstext, fuer den WCAG 2.5.8 die Inline-Ausnahme vorsieht -
 * dieselbe Abwaegung, die das Projekt schon bei den Sammelaktions-Pillen
 * getroffen hat. Er bleibt ueber 24x24 und damit im gruenen Bereich. */
test('die Akkordeon-Koepfe sichern ihre Zielgroesse ausdruecklich', () => {
  const triggers = [...html.matchAll(/<button[^>]*\bdata-toggle="[^"]+"[^>]*>/g)];
  assert.ok(triggers.length >= 4, 'erwartet mindestens vier Akkordeon-Trigger');

  // Alle tragen dieselbe Klasse; ueber sie laeuft die Zusicherung.
  for (const m of triggers) {
    assert.match(m[0], /class="[^"]*\btoggle-head\b/,
      `Akkordeon-Trigger ohne .toggle-head-Klasse: ${m[0]}`);
  }
  const height = toPx(declared(sel => sel === '.toggle-head', 'min-height', appliesAt(MOBILE_VIEWPORT)));
  assert.ok(height >= 44,
    `.toggle-head sichert keine Zielgroesse (min-height ${height}px) - ${triggers.length} Koepfe stehen im Erweitert-Schritt untereinander`);
});

// ── 1.9 Tinte auf Akzentflächen erfüllt AA, in beiden Themes ──────────────────
//
// Der Installer hatte hier weißen Text auf --color-accent stehen. Im Light-Mode
// stimmt das (6,0:1), im Dark-Mode hellt der Akzent auf #A78BFA auf und weiß
// fällt auf 2,72:1. Betroffen war die Primäraktion JEDES Schritts.
//
// Der Guard rechnet den echten WCAG-Kontrast, statt auf einen Token-Namen zu
// matchen: ein Textmatch würde grün bleiben, sobald jemand die Hex-Werte ändert.
// Geprüft werden beide Quellen, weil beide real ausgeliefert werden: der
// Inline-Fallback in install.html und tokens.css, das ihn überschreibt.

const tokensCss = readFileSync(new URL('../public/styles/tokens.css', import.meta.url), 'utf8');

function srgbToLinear(channel) {
  const v = channel / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
  const raw = hex.replace('#', '');
  const full = raw.length === 3 ? [...raw].map(c => c + c).join('') : raw.slice(0, 6);
  const [r, g, b] = [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16));
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

function contrastRatio(fg, bg) {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

/** Erster Hex-Wert von `name` ab Position `from`. */
function cssVar(css, name, from = 0) {
  const re = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,8})`, 'g');
  re.lastIndex = from;
  const match = re.exec(css);
  assert.ok(match, `${name} nicht gefunden (ab Offset ${from})`);
  return match[1];
}

/* Platzhaltertext erfüllt AA auf dem Feldgrund, in beiden Themes.
 *
 * Der Installer stylte ::placeholder NIRGENDS und fiel damit auf Chromes
 * UA-Default #757575 zurück, der im Dark Mode nicht mitkippt: gemessen 3.36:1
 * auf #262422, über alle 25 Felder mit placeholder-Attribut (Critique
 * 2026-08-15). Ein Textscan über Elementfarben kann das prinzipiell nicht sehen,
 * weil ein Pseudo-Element keinen eigenen Knoten hat.
 *
 * Dieselbe Falle hatte die App an ihren Quick-Add-Feldern (Critique 2026-07-29,
 * layout.css:4225) und dort einen Elementselektor dagegen gesetzt. Der Installer
 * hat diese Lehre nie bekommen, weil test-frontend-audit.js nur public/ scannt -
 * deshalb steht der Guard hier, nicht dort. */
test('Platzhaltertext erfüllt AA auf dem Feldgrund, in beiden Themes', () => {
  // Die Regel muss überhaupt existieren, sonst gewinnt der UA-Default.
  assert.match(html, /input::placeholder/,
    'ohne eigene ::placeholder-Regel gilt Chromes #757575, das dem Theme nicht folgt');
  assert.match(html, /::placeholder[\s\S]{0,200}?opacity:\s*1/,
    'Firefox setzt ::placeholder sonst auf opacity < 1 und senkt den Kontrast erneut');

  const htmlDark = html.indexOf('@media (prefers-color-scheme: dark)');
  const tokensDark = tokensCss.indexOf('@media (prefers-color-scheme: dark)');

  const paare = [
    ['Inline-Fallback hell', cssVar(html, '--color-text-placeholder'), cssVar(html, '--color-surface')],
    ['Inline-Fallback dunkel', cssVar(html, '--color-text-placeholder', htmlDark), cssVar(html, '--color-surface', htmlDark)],
    // tokens.css leitet --color-text-placeholder aus --color-text-tertiary ab.
    ['tokens.css hell', cssVar(tokensCss, '--_color-text-tertiary'), cssVar(tokensCss, '--_color-surface')],
    ['tokens.css dunkel', cssVar(tokensCss, '--_color-text-tertiary', tokensDark), cssVar(tokensCss, '--_color-surface', tokensDark)],
  ];

  for (const [label, fg, bg] of paare) {
    const ratio = contrastRatio(fg, bg);
    assert.ok(ratio >= 4.5,
      `${label}: Platzhalter ${fg} auf ${bg} erreicht nur ${ratio.toFixed(2)}:1, WCAG 1.4.3 verlangt 4.5:1`);
  }
});

test('Primäraktionen des Installers erfüllen AA auf Akzentgrund, in beiden Themes', () => {
  // Inline-Fallback: :root ist Light, der prefers-color-scheme-Block ist Dark.
  const htmlDark = html.indexOf('@media (prefers-color-scheme: dark)');
  assert.ok(htmlDark > 0, 'Dark-Block im Inline-Fallback nicht gefunden');

  // tokens.css setzt die Basiswerte auf --_-Variablen; --color-* verweist darauf.
  const tokensDark = tokensCss.indexOf('@media (prefers-color-scheme: dark)');
  assert.ok(tokensDark > 0, 'Dark-Block in tokens.css nicht gefunden');

  const paare = [
    ['Inline-Fallback, Light', cssVar(html, '--color-ink-on-vivid'), cssVar(html, '--color-accent')],
    ['Inline-Fallback, Dark', cssVar(html, '--color-ink-on-vivid', htmlDark), cssVar(html, '--color-accent', htmlDark)],
    ['tokens.css, Light', cssVar(tokensCss, '--_color-ink-on-vivid'), cssVar(tokensCss, '--_color-accent')],
    ['tokens.css, Dark', cssVar(tokensCss, '--_color-ink-on-vivid', tokensDark), cssVar(tokensCss, '--_color-accent', tokensDark)],
  ];

  for (const [quelle, ink, accent] of paare) {
    const ratio = contrastRatio(ink, accent);
    assert.ok(ratio >= 4.5,
      `${quelle}: ${ink} auf ${accent} ergibt ${ratio.toFixed(2)}:1, AA verlangt 4.5:1`);
  }
});

/* Die ausgeschaltete Schalterbahn haelt 3:1, in beiden Themes (#1572).
 *
 * Die Bahn stand wie in der App auf --neutral-300 und lag bei 1,65:1 auf der
 * Karte - ein Schalter, der aus war, war kaum zu sehen (WCAG 1.4.11). Die App
 * haelt das in test-frontend-audit.js ueber ihre Regeln; der Installer ist eine
 * Einzeldatei mit eigenem Fallback und braucht die Zusicherung hier. Dass die
 * Werte zu tokens.css passen, haelt "der Inline-Fallback stimmt Wert fuer Wert". */
test('die ausgeschaltete Schalterbahn des Installers haelt 3:1, in beiden Themes', () => {
  assert.match(html, /\.toggle__track\s*\{[^}]*background-color:\s*var\(--color-switch-off\)/,
    'die Bahn (.toggle__track) muss --color-switch-off tragen, sonst misst dieser Guard eine Farbe, die keiner zeigt');
  const htmlDark = html.indexOf('@media (prefers-color-scheme: dark)');
  assert.ok(htmlDark > 0, 'Dark-Block im Inline-Fallback nicht gefunden');

  const paare = [];
  for (const [theme, from] of [['hell', 0], ['dunkel', htmlDark]]) {
    const track = cssVar(html, '--color-switch-off', from);
    // Karte (--color-surface) und Buehne (--color-bg); der Knopf traegt --color-surface.
    for (const ground of ['--color-surface', '--color-bg']) paare.push([theme, track, ground, cssVar(html, ground, from)]);
  }
  for (const [theme, track, ground, bg] of paare) {
    const ratio = contrastRatio(track, bg);
    assert.ok(ratio >= 3,
      `Inline-Fallback ${theme}: Schalterbahn ${track} auf ${ground} (${bg}) erreicht nur ${ratio.toFixed(2)}:1, WCAG 1.4.11 verlangt 3:1`);
  }
});

test('der Installer nutzt kein --color-text-on-accent (folgt dem Theme nicht)', () => {
  // tokens.css definiert --color-text-on-accent als statisches Weiß und
  // redefiniert es in KEINEM Dark-Block. Auf einer Fläche, die im Dark-Mode
  // aufhellt, ist es deshalb immer ein Kontrastfehler. Richtig ist
  // --color-ink-on-vivid, das dem Theme folgt.
  assert.doesNotMatch(html, /var\(--color-text-on-accent/,
    'auf Akzentflächen gehört --color-ink-on-vivid, nicht --color-text-on-accent');
});

/* Der Inline-Fallback spiegelt tokens.css - Wert fuer Wert, in beiden Themes.
 *
 * install.html und tools/installer/README.md sagen beide zu, der Fallback zeige
 * "die aktuellen Tokens, weil ein Fallback, der den vorherigen Release zeigt,
 * die Diagnose in die falsche Richtung schickt". Genau dort war er falsch:
 * --color-ink-on-vivid stand im Dark Mode auf #191816, tokens.css auf #0A0A0C
 * (Critique 2026-08-15). Wirksam wird der Fallback nur, wenn tokens.css fehlt -
 * also in exakt dem Stoerfall, fuer den er gebaut wurde.
 *
 * Nichts hat das geprueft: die Werte sind zwei Kopien ohne Naht dazwischen.
 * Dieser Guard ist die Naht. Er prueft nur Tokens, die BEIDE Seiten fuehren -
 * der Fallback darf bewusst kleiner sein als tokens.css. */
test('der Inline-Fallback stimmt Wert fuer Wert mit tokens.css ueberein', () => {
  const darkHtml = html.indexOf('@media (prefers-color-scheme: dark)');
  const darkTokens = tokensCss.indexOf('@media (prefers-color-scheme: dark)');
  assert.ok(darkHtml > 0 && darkTokens > 0, 'Dark-Block nicht gefunden');

  // Die :root-Deklarationen des Fallbacks, je Theme.
  const fallbackVars = (from, to) => {
    const map = new Map();
    // Nicht nur Hex: auch Werte, die mit einer Zahl beginnen (Schatten, Radien,
    // Typo-Stufen), driften sonst stumm. Gemessen 2026-08-31: der Dark-
    // Kantenring aus tokens.css (0 0 0 1px rgba(255,255,255,.06)) fehlte im
    // Fallback, und dieser Guard blieb gruen, weil er nur Hex verglich - Guard
    // prueft Schreibweise, nicht Sache. Verglichen wird weiterhin nur, was
    // tokens.css als privates --_-Token fuehrt.
    for (const [, name, value] of html.slice(from, to).matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8}|[\d.][^;]*)/g)) {
      map.set(name, value.replace(/\s+/g, ' ').trim().toLowerCase());
    }
    return map;
  };
  const light = fallbackVars(0, darkHtml);
  const dark = fallbackVars(darkHtml, html.indexOf('</style>', darkHtml));

  const drift = [];
  for (const [theme, vars, tokensFrom] of [['light', light, 0], ['dark', dark, darkTokens]]) {
    for (const [name, value] of vars) {
      // tokens.css fuehrt die Basiswerte auf privaten --_-Variablen.
      const privateName = name.replace(/^--/, '--_');
      const re = new RegExp(`${privateName}:\\s*([^;]+);`, 'g');
      re.lastIndex = tokensFrom;
      const hit = re.exec(tokensCss);
      if (!hit) continue; // Token nur im Fallback - erlaubt
      const tokensValue = hit[1].replace(/\s+/g, ' ').trim().toLowerCase();
      if (tokensValue !== value) {
        drift.push(`${theme}: ${name} = ${value}, tokens.css = ${tokensValue}`);
      }
    }
  }
  assert.deepEqual(drift, [],
    `Fallback-Tokens weichen von tokens.css ab (der Fallback greift nur, wenn tokens.css fehlt - dort waere die Abweichung dann sichtbar): ${drift.join(' | ')}`);
});

/* Kein Schritt sammelt wieder alles ein.
 *
 * Der Erweitert-Schritt trug 18 Entscheidungspunkte auf einem Bildschirm, der
 * zweitgroesste 12 (Critique 2026-08-15). Er ist entlang einer Frage geteilt
 * worden - wo liegen Daten (Speicher) gegen womit verbindet sich Yuvomi
 * (Erweitert).
 *
 * Gezaehlt werden ENTSCHEIDUNGSPUNKTE, nicht Eingabefelder: ein Akkordeon-Kopf
 * ist eine eigene Frage ("brauche ich das?"), sein Inhalt zaehlt erst, wenn er
 * offen ist. Die erste Fassung zaehlte nur sichtbare inputs und war gegen den
 * Vorzustand gruen, weil die Felder ja in zugeklappten Akkordeons lagen - die
 * Last steckte aber gerade in den Koepfen.
 *
 * Die zugeklappten Inhalte werden per KLAMMERZAEHLUNG ausgeschnitten, nicht per
 * Regex: ein non-greedy Muster endete am ersten passenden Doppel-</div> und
 * liess damit Felder aus der Mitte eines Akkordeons durchrutschen - der Guard
 * meldete 6 Felder auf einem Schritt, der genau eines hat. */
test('kein Wizard-Schritt sammelt wieder alle Entscheidungen auf einem Bildschirm', () => {
  const steps = [...html.matchAll(/<div class="step" id="step-([a-z-]+)">/g)].map(m => m[1]);
  assert.ok(steps.length >= 10, `nur ${steps.length} Schritte gefunden - der Scanner greift nicht`);

  /** Bereiche aller toggle-body-Blocks (Start/Ende) per div-Klammerzaehlung. */
  const hiddenRanges = (seg) => {
    const out = [];
    let at = 0;
    while ((at = seg.indexOf('<div class="toggle-body"', at)) !== -1) {
      let depth = 0, close = -1;
      for (let k = at; k < seg.length; k++) {
        if (seg.startsWith('<div', k)) depth++;
        else if (seg.startsWith('</div>', k)) {
          depth--;
          if (depth === 0) { close = k; break; }
        }
      }
      if (close === -1) break;
      out.push([at, close]);
      at = close;
    }
    return out;
  };

  const LIMIT = 10;
  const oversized = [];

  for (const name of steps) {
    const from = html.indexOf(`<div class="step" id="step-${name}">`);
    const nextStep = html.indexOf('<div class="step" id="step-', from + 10);
    const seg = html.slice(from, nextStep === -1 ? html.indexOf('</main>') : nextStep);

    const hidden = hiddenRanges(seg);
    const isHidden = (i) => hidden.some(([a, b]) => i > a && i < b);

    const heads = (seg.match(/data-toggle="/g) || []).length;
    let fields = 0;
    for (const m of seg.matchAll(/<(?:input|select|textarea)\b/g)) {
      if (!isHidden(m.index)) fields++;
    }

    const points = heads + fields;
    if (points > LIMIT) oversized.push(`step-${name}: ${points} (${heads} Akkordeons + ${fields} Felder)`);
  }

  assert.deepEqual(oversized, [],
    `Diese Schritte stellen beim Betreten mehr als ${LIMIT} Entscheidungen auf einmal: ${oversized.join(', ')}. `
    + 'Entweder hinter Akkordeons legen oder entlang einer Frage in zwei Schritte teilen.');
});

/* Die Ruhekante jedes Formularfelds ist --color-border-control (3:1).
 *
 * Felder und Selects trugen --color-border, die Kartenkante: gemessen rund
 * 1,3:1 auf der Feldflaeche (Critique 2026-09-29). Ein leeres Feld war damit
 * kaum als Feld zu erkennen - WCAG 1.4.11 verlangt fuer die Kante eines
 * Bedienelements 3:1. Lighthouse meldete 100, weil es Nicht-Text-Kontrast
 * nicht misst. Die App hat dafuer seit langem ein eigenes Token.
 *
 * Geprueft wird jede Regel, die ein Feld im RUHEZUSTAND faerbt (kein :focus,
 * kein aria-invalid): ein neues Feld mit eigener Regel faellt so mit auf. Dazu
 * der Kontrast des Tokens selbst in beiden Quellen und beiden Themes - ein
 * Textmatch allein bliebe gruen, wenn jemand den Wert daneben aendert.
 * Checkboxen zeichnet der Browser (accent-color, color-scheme), sie tragen
 * keine eigene Kante und stehen deshalb nicht in der Liste. */
test('Formularfelder tragen im Ruhezustand die 3:1-Kante --color-border-control', () => {
  const FIELD = /(?:^|[\s>+~])(?:input(?:\[type=(?!checkbox)[\w-]+\])?|select|textarea)$/;
  const STATE = /:|\[aria-invalid/;
  const checked = [];
  const offenders = [];
  for (const rule of RULES) {
    if (!FIELD.test(rule.selector) || STATE.test(rule.selector)) continue;
    const decl = rule.body.match(/(?:^|;)\s*border(?:-color)?\s*:\s*([^;]+)/i);
    if (!decl) continue;
    checked.push(rule.selector);
    if (!/var\(--color-border-control\)/.test(decl[1]) && !/^(?:none|0)$/.test(decl[1].trim())) {
      offenders.push(`${rule.selector} { ${decl[0].trim().replace(/^;\s*/, '')} }`);
    }
  }
  // Die beiden bekannten Traeger muessen dabei sein - sonst greift der Scanner nicht.
  for (const must of ['input[type=text]', '.lang-switch select']) {
    assert.ok(checked.includes(must), `${must} setzt keine eigene Kante - der Scanner greift nicht oder die Regel fehlt`);
  }
  assert.deepEqual(offenders, [],
    `Feldkanten unter 3:1 (Kartenkante statt --color-border-control): ${offenders.join(' | ')}`);

  // Das Token zeigt in beiden Quellen auf dieselbe Rampenstufe ...
  assert.match(html, /--color-border-control:\s*var\(--neutral-500\)/, 'Fallback: --color-border-control fehlt');
  assert.match(tokensCss, /--color-border-control:\s*var\(--neutral-500\)/, 'tokens.css: --color-border-control zeigt nicht mehr auf --neutral-500');

  // ... und diese Stufe haelt 3:1 auf der Feldflaeche, hell und dunkel.
  const htmlDark = html.indexOf('@media (prefers-color-scheme: dark)');
  const tokensDark = tokensCss.indexOf('@media (prefers-color-scheme: dark)');
  const paare = [
    ['Inline-Fallback hell', cssVar(html, '--neutral-500'), cssVar(html, '--color-surface')],
    ['Inline-Fallback dunkel', cssVar(html, '--neutral-500', htmlDark), cssVar(html, '--color-surface', htmlDark)],
    ['tokens.css hell', cssVar(tokensCss, '--_neutral-500'), cssVar(tokensCss, '--_color-surface')],
    ['tokens.css dunkel', cssVar(tokensCss, '--_neutral-500', tokensDark), cssVar(tokensCss, '--_color-surface', tokensDark)],
  ];
  for (const [label, edge, field] of paare) {
    const ratio = contrastRatio(edge, field);
    assert.ok(ratio >= 3, `${label}: Feldkante ${edge} auf ${field} = ${ratio.toFixed(2)}:1, WCAG 1.4.11 verlangt 3:1`);
  }
});

// ── Kanten der Aktionen (Critique 2026-09-29) ──────────────────────────────────

/* Die Fussleiste ist in JEDER Breite sticky. Sie war es nur in der Mobil-Query,
 * und bei 1440x900 lag sie in Schritt 1 bei y=901 - die Primaeraktion stand auf
 * dem Desktop unter dem Falz. Geprueft wird die Basisregel ausserhalb jeder
 * Media-Query, denn genau dort fehlte sie. */
test('die Fussleiste mit der Primaeraktion ist in jeder Breite sticky', () => {
  const base = media => media === null;
  assert.equal(declared(sel => sel === '.card-foot', 'position', base), 'sticky',
    '.card-foot ist ausserhalb der Mobil-Query nicht sticky - auf dem Desktop rutscht die Primaeraktion unter den Falz');
  assert.match(declared(sel => sel === '.card-foot', 'bottom', base) ?? '', /^0(?:px)?$/, '.card-foot braucht bottom: 0');
  // Eine sticky Leiste ohne eigene Flaeche laesst den Inhalt durch die Knoepfe laufen.
  assert.ok(declared(sel => sel === '.card-foot', 'background', base), '.card-foot hat keine opake Grundflaeche');
});

/* 48px wie .btn der App (DESIGN.md), und der Abschluss-CTA spricht dieselbe
 * Sprache wie jeder Primaerknopf davor: gleiche Hoehe, gleiches Gewicht,
 * gleiche Flaeche. Er trug 700/16px auf reinem Akzent. */
test('Buttons stehen auf 48px, und .open-link gleicht .btn-primary', () => {
  const base = media => media === null;
  for (const sel of ['.btn', '.open-link']) {
    const h = toPx(declared(s => s === sel, 'min-height', base));
    assert.ok(h >= 48, `${sel} ist ${h}px hoch, DESIGN.md verlangt 48px`);
  }
  assert.equal(declared(s => s === '.open-link', 'font-weight', base), declared(s => s === '.btn', 'font-weight', base),
    '.open-link und .btn tragen verschiedene Schriftgewichte');
  assert.equal(declared(s => s === '.open-link', 'font-size', base), declared(s => s === '.btn', 'font-size', base),
    '.open-link und .btn tragen verschiedene Schriftgroessen - der Download-Tausch springt');
  assert.equal(declared(s => s === '.open-link', 'background', base), declared(s => s === '.btn-primary', 'background', base),
    '.open-link hat eine andere Primaerflaeche als .btn-primary');
});

/* Der Klassentausch am Abschluss animierte die Flaeche, die Schriftfarbe sprang
 * sofort: 120ms Violett auf Violett. setDoneEmphasis() muss die Transition fuer
 * den Tausch abschalten, den Stil festschreiben und sie danach zurueckgeben -
 * in dieser Reihenfolge, sonst wirkt einer der drei Schritte nicht. */
test('der Tausch der Abschlussknoepfe blendet keine Farbe ueber', () => {
  const fn = html.match(/function setDoneEmphasis\(\) \{([\s\S]*?)\n\}/);
  assert.ok(fn, 'setDoneEmphasis nicht gefunden');
  const body = fn[1];
  const off = body.indexOf("style.transition = 'none'");
  const swap = body.indexOf('dl.className');
  const reflow = body.search(/void \w+\.offsetWidth/);
  const back = body.indexOf("style.transition = ''");
  assert.ok(off !== -1 && swap !== -1 && reflow !== -1 && back !== -1,
    'setDoneEmphasis schaltet die Transition fuer den Klassentausch nicht ab und wieder an');
  assert.ok(off < swap && swap < reflow && reflow < back,
    'Reihenfolge muss sein: Transition aus, Klassen tauschen, Reflow, Transition zurueck');
});

/* Der Zurueck-Knopf stand auf --color-surface-2, das im Dark Mode TIEFER liegt
 * als die Karte (#0F0E0D auf #2B2825) - er sah aus wie ein Loch in der Leiste.
 * Die App fuehrt ihre sekundaeren Knoepfe transparent mit Kante (.btn--secondary). */
test('der Ghost-Button ist transparent wie .btn--secondary der App, kein Loch im Dark Mode', () => {
  const base = media => media === null;
  assert.equal(declared(s => s === '.btn-ghost', 'background', base), 'transparent',
    '.btn-ghost braucht die Flaeche von .btn--secondary (transparent), nicht --color-surface-2');
  const hover = declared(s => s === '.btn-ghost:hover:not(:disabled)', 'background', base);
  assert.doesNotMatch(hover, /--color-surface-2|--color-border\)/, `.btn-ghost:hover faerbt wieder mit ${hover}`);
});

/* Ein Fehler-Banner, das fail() unter ein Feld zieht, klebte ohne Abstand am
 * naechsten Label. */
test('das Fehler-Banner haelt Abstand zum naechsten Feld', () => {
  const mb = toPx(declared(s => s === '.error-banner', 'margin-bottom'));
  assert.ok(mb >= 12, `.error-banner hat margin-bottom ${mb}px - es klebt am naechsten Feld`);
});

/* aria-invalid klebte bis zum naechsten Absenden: wer das Feld korrigierte,
 * sah weiter den roten Rahmen und hoerte weiter "ungueltig". Die Funktion wird
 * hier AUSGEFUEHRT, nicht nur gesucht - und ihre Verdrahtung an input UND
 * change (Selects feuern kein input in jedem Browser) gleich mit. */
test('die Feldmarkierung faellt, sobald der Nutzer das Feld korrigiert', () => {
  const src = html.match(/function clearFieldInvalid\(e\) \{[\s\S]*?\n\}/);
  assert.ok(src, 'clearFieldInvalid nicht gefunden');
  assert.match(html, /document\.addEventListener\('input', clearFieldInvalid\)/, 'input-Ereignis nicht verdrahtet');
  assert.match(html, /document\.addEventListener\('change', clearFieldInvalid\)/, 'change-Ereignis nicht verdrahtet');

  const clearFieldInvalid = new Function(`${src[0]}; return clearFieldInvalid;`)();
  const fakeField = (attrs) => ({
    attrs: { ...attrs },
    getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; },
    removeAttribute(n) { delete this.attrs[n]; },
  });

  const marked = fakeField({ 'aria-invalid': 'true', 'aria-describedby': 'cfg-err' });
  clearFieldInvalid({ target: marked });
  assert.equal(marked.getAttribute('aria-invalid'), null, 'aria-invalid bleibt nach der Eingabe stehen');
  assert.equal(marked.getAttribute('aria-describedby'), null, 'die Bindung an das Banner bleibt nach der Eingabe stehen');

  // Ein unmarkiertes Feld behaelt seine eigene Beschreibung.
  const clean = fakeField({ 'aria-describedby': 'own-hint' });
  clearFieldInvalid({ target: clean });
  assert.equal(clean.getAttribute('aria-describedby'), 'own-hint', 'ein unmarkiertes Feld verliert seine Beschreibung');
});

// ── Typo, Layout, Gruppen und Pruefseite (Critique 2026-09-29) ─────────────────

/** Quelltext einer Funktion aus dem Modul-Script (bis zur schliessenden Klammer in Spalte 0). */
function fnSource(name) {
  const m = html.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  assert.ok(m, `function ${name} nicht gefunden`);
  return m[0];
}

/** Ein Objekt-/Array-Literal aus dem Modul-Script auswerten (`const NAME = ...;`). */
function literal(name) {
  const m = html.match(new RegExp(`const ${name} = ([\\s\\S]*?);\\n`));
  assert.ok(m, `const ${name} nicht gefunden`);
  return new Function(`return (${m[1]});`)();
}

/** Abschnitt eines Elements per div-/section-/dl-Klammerzaehlung ab `from`. */
function elementRange(source, from) {
  const tag = source.slice(from + 1).match(/^[a-z0-9]+/)[0];
  let depth = 0;
  const open = new RegExp(`<${tag}[\\s>]`, 'y');
  const close = `</${tag}>`;
  for (let k = from; k < source.length; k++) {
    open.lastIndex = k;
    if (open.test(source)) depth++;
    else if (source.startsWith(close, k)) {
      depth--;
      if (depth === 0) return [from, k + close.length];
    }
  }
  return [from, source.length];
}

/** Markup eines Schritts. */
function stepSource(name) {
  const from = html.indexOf(`<div class="step" id="step-${name}">`);
  assert.ok(from !== -1, `step-${name} nicht gefunden`);
  const [a, b] = elementRange(html, from);
  return html.slice(a, b);
}

const resolveVar = (value) => {
  const v = (value ?? '').trim().match(/^var\(\s*(--[\w-]+)/);
  return v ? (ROOT_VARS.get(v[1]) ?? value).trim() : (value ?? '').trim();
};

/* Die Schritt-H2 stand auf 20px/700 - auf derselben Stufe wie die Wortmarke
 * darueber, zwei gleich laute Titel und keiner fuehrte. Jetzt Title 1 der App
 * (28px, bold, -0.015em, 1.21), die Wortmarke eine klare Stufe darunter, und
 * Untertitel/Hinweise auf Subheadline/Footnote. Geprueft wird die Wirkung in px
 * ueber den Fallback, nicht der Tokenname - ein var(), das auf die falsche
 * Stufe zeigt, faellt so mit auf. */
test('Typo-Hierarchie: die Schritt-H2 ist Title 1, die Wortmarke eine Stufe darunter', () => {
  const base = m => m === null;
  const h2 = sel => sel === '.card-head h2';
  assert.equal(toPx(declared(h2, 'font-size', base)), 28, '.card-head h2 ist nicht Title 1 (28px)');
  assert.equal(declared(h2, 'font-weight', base), '700');
  assert.equal(resolveVar(declared(h2, 'letter-spacing', base)), '-0.015em');
  assert.equal(resolveVar(declared(h2, 'line-height', base)), '1.21');

  const word = sel => sel === '.brand__word';
  const wordPx = toPx(declared(word, 'font-size', base));
  assert.ok(wordPx <= 17, `die Wortmarke steht auf ${wordPx}px und konkurriert mit der H2`);
  assert.ok(Number(declared(word, 'font-weight', base)) <= 600, 'die Wortmarke ist fetter als 600');

  assert.equal(toPx(declared(sel => sel === '.card-head p', 'font-size', base)), 15, 'Untertitel ist nicht Subheadline (15px)');
  assert.equal(toPx(declared(sel => sel === '.hint', 'font-size', base)), 13, 'Hinweis ist nicht Footnote (13px)');

  // Das Gruppen-Label ist das Versal-Mikro-Label der App.
  const label = sel => sel === '.group-label';
  assert.equal(declared(label, 'text-transform', base), 'uppercase');
  assert.equal(resolveVar(declared(label, 'letter-spacing', base)), '0.05em');
  assert.equal(toPx(declared(label, 'font-size', base)), 12);
});

/* Desktop ab 1024px: zweispaltig, Inhalt oben verankert. `safe center` liess die
 * Ueberschrift bei jedem Schrittwechsel springen (77px gemessen), und die
 * 560px-Karte stand auf 1440px allein in der Mitte. */
test('Layout: oben verankert, ab 1024px Schrittliste links und Inhaltsspalte rechts', () => {
  const base = m => m === null;
  const desktop = m => m !== null && /min-width:\s*1024px/.test(m);
  assert.doesNotMatch(declared(sel => sel === 'body', 'justify-content', base) ?? '', /center/,
    'body zentriert den Schritt vertikal - die Ueberschrift springt zwischen den Schritten');
  assert.doesNotMatch(stylesheet(html), /safe\s+center/, 'safe center steht wieder im Stylesheet');

  const shell = sel => sel === '.shell:not(.shell--solo)';
  assert.equal(declared(shell, 'display', desktop), 'grid', 'ab 1024px ist die Buehne nicht zweispaltig');
  const tracks = (declared(shell, 'grid-template-columns', desktop) || '').match(/minmax\([^)]*\)|\S+/g) || [];
  assert.equal(tracks.length, 2, `erwartet zwei Spalten, gefunden: ${tracks.join(' ')}`);
  const content = toPx((tracks[1].match(/,\s*([^)]+)\)/) || [])[1] ?? tracks[1]);
  assert.ok(content >= 640 && content <= 680, `Inhaltsspalte ${content}px statt 640-680px`);
  assert.equal(declared(sel => sel === '.shell:not(.shell--solo) .rail', 'position', desktop), 'sticky',
    'die Schrittliste scrollt mit dem Inhalt weg');
  assert.equal(declared(sel => sel === '.shell:not(.shell--solo) .steps-nav', 'display', desktop), 'block');
  assert.equal(declared(sel => sel === '.steps-nav', 'display', base), 'none', 'die Liste steht auch unter 1024px');
  // Der Zaehler bleibt als aria-describedby im Dokument, sichtbar traegt die Liste.
  assert.equal(declared(sel => sel === '.shell:not(.shell--solo) .step-tag', 'position', desktop), 'absolute');
  assert.notEqual(declared(sel => sel === '.shell:not(.shell--solo) .step-tag', 'display', desktop), 'none',
    'display:none nimmt dem aria-describedby der H2 seinen Text');
});

/** Nachbau der Listeneintraege fuer renderStepNav: der Docker-Eintrag ist ein <span>. */
function navFakes(names) {
  return names.map(name => {
    const button = {
      tagName: name === 'docker' ? 'SPAN' : 'BUTTON', disabled: true, attrs: {},
      setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; },
    };
    const mark = { textContent: '?' };
    return {
      name, button, mark, hidden: true, dataset: { navStep: name },
      querySelector: sel => (sel === '.steps-nav__link' ? button : mark),
    };
  });
}

/* Die Schrittliste zeigt genau die nummerierten Schritte beider Wege. Die
 * Funktion wird AUSGEFUEHRT: erledigt heisst anklickbar, aktuell heisst
 * aria-current="step", kommend heisst gesperrt, und ab dem Container-Start ist
 * kein Weg zurueck mehr offen (die .env steht dann schon). */
test('die Schrittliste folgt dem Weg: erledigt anklickbar, aktuell markiert, kommend gesperrt', () => {
  const FLOWS = literal('FLOWS');
  const UNNUMBERED = literal('UNNUMBERED');
  const numbered = new Set([...FLOWS.simple, ...FLOWS.advanced].filter(s => !UNNUMBERED.has(s)));
  const navItems = [...html.matchAll(/<li class="steps-nav__item" data-nav-step="([a-z]+)"[^>]*>(.*?)<\/li>/g)];
  // Dazu der Containerstart: ohne Nummer, aber mit Platz (eigener Test unten).
  assert.deepEqual(new Set(navItems.map(m => m[1])), new Set([...numbered, 'docker']), 'die Liste fuehrt andere Schritte als die Wege');
  for (const m of navItems.filter(i => numbered.has(i[1]))) {
    assert.match(m[2], new RegExp(`<button type="button" class="steps-nav__link" data-goto="${m[1]}"`),
      `Eintrag ${m[1]} ist kein Knopf mit data-goto`);
  }
  assert.match(html, /<nav class="steps-nav"[^>]*aria-label=[^>]*>\s*<ol/, 'die Liste ist kein <nav> mit <ol>');
  // showStep zeichnet ueber renderStep (seit dem Schrittwechsel mit Richtung
  // auch aus dem Rueckruf einer View Transition) - der Weg muss durchgehen.
  assert.match(fnSource('showStep'), /renderStep\(\)/, 'showStep zeichnet den Schritt nicht');
  assert.match(fnSource('renderStep'), /renderStepNav\(\)/, 'renderStep aktualisiert die Liste nicht');

  const run = (flow, currentStep, dockerOutcome = null) => {
    const items = navFakes([...numbered, 'docker']);
    const document = { querySelectorAll: () => items };
    new Function('flow', 'currentStep', 'UNNUMBERED', 'dockerOutcome', 'document', `${fnSource('renderStepNav')}; renderStepNav();`)(
      flow, currentStep, UNNUMBERED, dockerOutcome, document);
    return Object.fromEntries(items.map(i => [i.name, i]));
  };

  const adv = FLOWS.advanced;
  let r = run(adv, adv.indexOf('calendar'));
  assert.equal(r.simple.hidden, true, 'der Einfach-Schritt steht in der Liste des erweiterten Wegs');
  assert.equal(r.config.mark.textContent, '1');
  assert.equal(r.admin.mark.textContent, String(adv.filter(s => !UNNUMBERED.has(s)).length));
  for (const done of ['config', 'secrets', 'weather']) {
    assert.equal(r[done].dataset.state, 'done');
    assert.equal(r[done].button.disabled, false, `${done} ist erledigt und trotzdem nicht anklickbar`);
  }
  assert.equal(r.calendar.dataset.state, 'current');
  assert.equal(r.calendar.button.attrs['aria-current'], 'step');
  for (const next of ['email', 'storage', 'advanced', 'review', 'admin']) {
    assert.equal(r[next].button.disabled, true, `${next} kommt erst noch und ist trotzdem anklickbar`);
    assert.equal(r[next].button.attrs['aria-current'], undefined);
  }

  r = run(adv, adv.indexOf('docker'));
  assert.equal(r.review.dataset.state, 'done');
  assert.equal(r.review.button.disabled, true, 'nach dem Container-Start fuehrt die Liste noch zurueck vor die .env');

  r = run(FLOWS.simple, FLOWS.simple.indexOf('simple'));
  assert.equal(r.simple.dataset.state, 'current');
  assert.equal(r.config.hidden, true, 'der erweiterte Weg steht in der Liste des Einfach-Wegs');
  assert.equal(r.admin.hidden, false);
});

/* "Aendern" auf der Pruefseite fuehrt zum Schritt, "Weiter" von dort zurueck -
 * OHNE dass ein Schritt dazwischen seine Pruefung verliert. Die Schritte haengen
 * aneinander (Host -> Redirect-URIs in adv-next, Google-Zugang -> Drive-Pruefung
 * in storage-next); ein direkter Sprung liesse diese Werte veraltet stehen.
 * next() drueckt deshalb das "Weiter" jedes Schritts dazwischen. Ausgefuehrt
 * gegen einen Nachbau von showStep und den Primaerknoepfen. */
test('der Rueckweg zur Pruefseite prueft jeden Schritt dazwischen erneut', () => {
  const FLOWS = literal('FLOWS');
  const harness = new Function('flow', 'failAt', `
    let currentStep = flow.indexOf('review');
    let reviewReturn = null;
    const entered = [];
    const validated = [];
    function showStep(n) {
      currentStep = n;
      entered.push(flow[n]);
      if (flow[n] === 'review') reviewReturn = null;   // wie onEnterStep('review')
    }
    const $ = (id) => ({
      querySelector: () => ({ click: () => {
        const name = id.replace('step-', '');
        validated.push(name);
        if (name !== failAt) next();
      } }),
    });
    ${fnSource('next')}
    ${fnSource('jumpBack')}
    return {
      next, jumpBack,
      get step() { return flow[currentStep]; },
      get reviewReturn() { return reviewReturn; },
      entered, validated,
      setFail(v) { failAt = v; },
    };
  `);

  const flow = FLOWS.advanced;
  let h = harness(flow, null);
  h.jumpBack('weather', 'email');
  assert.equal(h.step, 'weather', 'Aendern landet nicht im ersten Schritt der Gruppe');
  h.next();
  assert.equal(h.step, 'calendar', 'innerhalb der Gruppe fuehrt Weiter zum naechsten Schritt der Gruppe');
  h.next();
  assert.equal(h.step, 'email');
  h.next();
  assert.equal(h.step, 'review', 'nach dem letzten Schritt der Gruppe fuehrt Weiter nicht zur Pruefseite');
  assert.deepEqual(h.validated, ['storage', 'advanced'], 'die Schritte zwischen Gruppe und Pruefseite wurden nicht erneut geprueft');
  assert.equal(h.reviewReturn, null);

  // Scheitert eine Pruefung unterwegs, bleibt der Nutzer genau dort stehen.
  h = harness(flow, 'storage');
  h.jumpBack('config');
  h.next();
  assert.equal(h.step, 'storage', 'eine gescheiterte Pruefung wurde uebersprungen');
  h.setFail(null);
  h.next();
  assert.equal(h.step, 'review', 'nach der Korrektur fuehrt Weiter nicht weiter zur Pruefseite');

  // Vorwaerts springt niemand, und ausserhalb der Pruefseite gibt es keinen Rueckweg.
  h = harness(flow, null);
  h.jumpBack('admin');
  assert.equal(h.step, 'review', 'jumpBack springt vorwaerts');
  h.jumpBack('config');
  h.next();
  assert.equal(h.step, 'review', 'Aendern ueber die Liste fuehrt nach dem Schritt nicht zurueck');

  // Die Verdrahtung: Liste und Aendern-Knoepfe laufen ueber jumpBack.
  assert.match(html, /closest\('\[data-goto\]'\)[\s\S]{0,120}jumpBack\(goto\.dataset\.goto\)/);
  assert.match(html, /closest\('\[data-edit\]'\)[\s\S]{0,120}jumpBack\(edit\.dataset\.edit, edit\.dataset\.editUntil/);
});

/* Die Pruefseite: nach Schritten gruppiert, jede Gruppe mit "Aendern", und KEINE
 * nackte "-"-Zeile mehr. Vorher 20 ungegliederte Zeilen, 11 davon mit Strich
 * (Critique 2026-09-29). renderReview wird mit leerem und mit vollem Zustand
 * AUSGEFUEHRT: jede sichtbare Zeile traegt einen Wert, was fehlt, steht je
 * Gruppe in EINER Zeile "Nicht eingerichtet". */
test('die Pruefseite hat Gruppen mit Aendern-Link und keine Strich-Zeile', () => {
  const FLOWS = literal('FLOWS');
  const review = stepSource('review');
  const reviewAt = FLOWS.advanced.indexOf('review');

  const groups = [...review.matchAll(/<section class="rv-group"/g)];
  assert.ok(groups.length >= 5, `nur ${groups.length} Gruppen auf der Pruefseite`);
  for (const g of groups) {
    const [a, b] = elementRange(review, g.index);
    const section = review.slice(a, b);
    const edit = section.match(/<button[^>]*class="group-edit"[^>]*>/);
    assert.ok(edit, `Gruppe ohne Aendern-Knopf: ${section.slice(0, 80)}`);
    const target = edit[0].match(/data-edit="([a-z]+)"/)?.[1];
    const until = edit[0].match(/data-edit-until="([a-z]+)"/)?.[1] ?? target;
    const ti = FLOWS.advanced.indexOf(target);
    const ui = FLOWS.advanced.indexOf(until);
    assert.ok(ti > 0 && ti < reviewAt, `Aendern zielt auf ${target}, keinen Schritt vor der Pruefseite`);
    assert.ok(ui >= ti && ui < reviewAt, `data-edit-until=${until} liegt nicht zwischen Ziel und Pruefseite`);
    assert.match(edit[0], /aria-labelledby="[^"]+ [^"]+"/, 'Aendern ist ohne Gruppennamen nicht unterscheidbar');
    assert.match(section, /<dl class="inset-group">/, 'Gruppe ohne Inset-Traeger');
  }

  // Zellen aus dem Markup: id -> Beschriftung.
  const cells = new Map();
  for (const m of review.matchAll(/<dt data-i18n="([^"]+)">[^<]*<\/dt><dd id="([^"]+)"><\/dd>/g)) {
    cells.set(m[2], { key: m[1], textContent: 'VORHER', parentElement: { hidden: false }, previousElementSibling: { textContent: m[1] } });
  }
  assert.ok(cells.size >= 20, `nur ${cells.size} Zellen gefunden - der Scanner greift nicht`);

  const run = (overrides) => {
    for (const c of cells.values()) { c.textContent = 'VORHER'; c.parentElement.hidden = false; }
    const S = { ...literal('S'), ...overrides };
    new Function('S', '$', 't', 'preservedKeys', 'deriveBaseUrl',
      `${fnSource('fillReviewGroup')}; ${fnSource('renderReview')}; renderReview();`)(
      S, id => cells.get(id), key => `T:${key}`, new Set(), () => 'http://localhost:3000');
    return cells;
  };

  const check = (label) => {
    for (const [id, c] of cells) {
      if (c.parentElement.hidden) continue;
      assert.ok(c.textContent.trim() !== '', `${label}: sichtbare Zeile ${id} ohne Wert`);
      assert.doesNotMatch(c.textContent, /^\s*[-\u2013\u2014]\s*$/, `${label}: ${id} zeigt einen nackten Strich`);
    }
  };

  // Frischer Zustand: nichts eingerichtet.
  run({ host: 'localhost', port: '3000', tz: 'Europe/Berlin' });
  check('leer');
  const unset = cells.get('rv-integrations-unset');
  assert.equal(unset.parentElement.hidden, false, 'nichts eingerichtet, aber keine Zeile "Nicht eingerichtet"');
  // Reihenfolge wie im Kalenderschritt: Apple (Legacy) steht nach Outlook.
  assert.equal(unset.textContent, 'review.weather, review.google, review.outlook, review.apple, review.email',
    'die Zeile "Nicht eingerichtet" nennt nicht alles, was fehlt');
  for (const id of ['rv-weather', 'rv-google', 'rv-outlook', 'rv-apple', 'rv-email']) {
    assert.equal(cells.get(id).parentElement.hidden, true, `${id} steht leer als eigene Zeile`);
  }

  // Voller Zustand: alles eingerichtet, keine "Nicht eingerichtet"-Zeile.
  run({
    host: 'nas.local', port: '3000', tz: 'Europe/Berlin', BASE_URL: 'https://yuvomi.example.com',
    WEATHER_LAT: '52.5', WEATHER_LON: '13.4', GOOGLE_CLIENT_ID: 'id', APPLE_USERNAME: 'a@b.c',
    MS_CLIENT_ID: 'ms', EMAIL_SMTP_HOST: 'smtp', EMAIL_FROM_ADDRESS: 'x@y.z',
    WEBDAV_BACKUP_ENABLED: 'true', DOCUMENT_STORAGE_LOCAL_ENABLED: 'true',
    DOCUMENT_STORAGE_WEBDAV_ENABLED: 'true', GOOGLE_DRIVE_REDIRECT_URI: 'https://x/cb', OIDC_ISSUER: 'https://idp',
  });
  check('voll');
  for (const id of ['rv-integrations-unset', 'rv-storage-unset', 'rv-advanced-unset']) {
    assert.equal(cells.get(id).parentElement.hidden, true, `${id} steht, obwohl alles eingerichtet ist`);
  }
});

/* Die Akkordeon-Abzeichen standen fuer immer auf "Optional" - gcal-badge und
 * Geschwister wurden nie beschrieben. Jetzt setzt EINE Funktion sie aus der
 * data-setup-Regel ihrer Karte. Ausgefuehrt, nicht gesucht. */
test('die Akkordeon-Abzeichen zeigen "Eingerichtet", sobald ihre Felder stehen', () => {
  const cards = [...html.matchAll(/<div class="toggle-card"([^>]*)>/g)];
  assert.ok(cards.length >= 9, `nur ${cards.length} Akkordeon-Karten`);
  for (const c of cards) {
    const setup = c[1].match(/data-setup="([^"]+)"/)?.[1];
    assert.ok(setup, `Akkordeon ohne data-setup: ${c[0]}`);
    for (const id of setup.split(/\s+/)) assert.match(html, new RegExp(`id="${id}"`), `data-setup nennt unbekanntes Feld ${id}`);
  }
  // Ein data-i18n am Abzeichen setzte es bei jedem Sprachwechsel auf "Optional" zurueck.
  assert.doesNotMatch(html, /class="toggle-badge"[^>]*data-i18n=/, 'ein Abzeichen traegt data-i18n und verliert beim Sprachwechsel seinen Zustand');
  assert.match(html, /document\.addEventListener\('input', refreshBadges\)/);
  assert.match(html, /document\.addEventListener\('change', refreshBadges\)/);
  assert.match(fnSource('localize'), /refreshBadges\(\)/, 'localize() uebersetzt die Abzeichen nicht');

  const fields = {
    'gcal-id': { type: 'text', value: '' }, 'gcal-secret': { type: 'password', value: '' },
    'adv-backup-enable': { type: 'checkbox', checked: false },
  };
  const badge = () => ({ textContent: 'Optional', dataset: {} });
  const mk = (setup) => { const b = badge(); return { b, card: { dataset: { setup }, querySelector: () => b } }; };
  const gcal = mk('gcal-id gcal-secret');
  const backup = mk('adv-backup-enable');
  const refresh = new Function('document', '$', 't', `${fnSource('refreshBadges')}; return refreshBadges;`)(
    { querySelectorAll: () => [gcal.card, backup.card] }, id => fields[id], key => key);

  refresh();
  assert.equal(gcal.b.textContent, 'common.optional');
  assert.equal(backup.b.textContent, 'common.optional');
  fields['gcal-id'].value = 'abc';
  refresh();
  assert.equal(gcal.b.textContent, 'common.optional', 'halb ausgefuellt ist noch nicht eingerichtet');
  fields['gcal-secret'].value = 'geheim';
  fields['adv-backup-enable'].checked = true;
  refresh();
  assert.equal(gcal.b.textContent, 'common.setUp');
  assert.equal(gcal.b.dataset.state, 'set');
  assert.equal(backup.b.textContent, 'common.setUp', 'ein angehakter Schalter richtet seine Karte nicht ein');
});

/* Einstellungen als Inset-Gruppen wie in der App: kein Feld und kein Akkordeon
 * steht mehr lose auf der Buehne. Bracket-gezaehlt, nicht per Regex - ein
 * vergessener Wrapper faellt so auch in der Mitte eines Schritts auf. */
test('jedes Feld und jedes Akkordeon steht in einer Inset-Gruppe', () => {
  const loose = [];
  for (const name of ['config', 'secrets', 'weather', 'calendar', 'email', 'storage', 'advanced', 'admin']) {
    const seg = stepSource(name);
    const groups = [...seg.matchAll(/<(?:div|dl) class="inset-group">/g)].map(m => elementRange(seg, m.index));
    assert.ok(groups.length > 0, `step-${name} hat keine Inset-Gruppe`);
    const inside = i => groups.some(([a, b]) => i > a && i < b);
    for (const m of seg.matchAll(/<div class="(field|toggle-card)"/g)) {
      if (!inside(m.index)) loose.push(`step-${name}: ${m[1]} bei Offset ${m.index}`);
    }
  }
  assert.deepEqual(loose, [], `lose auf der Buehne statt in einer Gruppe: ${loose.join(', ')}`);

  // Die Gruppe selbst ist der weisse Traeger der App: Surface, 16px, Schatten.
  const base = m => m === null;
  const g = sel => sel === '.inset-group';
  assert.equal(declared(g, 'background', base), 'var(--color-surface)');
  assert.equal(declared(g, 'border-radius', base), 'var(--radius-lg)');
  assert.equal(declared(g, 'box-shadow', base), 'var(--shadow-sm)');
});

// ── Mobil (Critique 2026-09-29, adapt) ────────────────────────────────────────

/**
 * Laengsseite einer Box aus der Kaskade: Longhand (`padding-top`) und
 * Shorthand (`padding: 48px 16px 80px`) in Deklarationsreihenfolge, wie der
 * Browser sie bei gleicher Spezifitaet verrechnet. `side` = top|right|bottom|left.
 */
function boxSide(selectorMatches, prop, side, mediaMatches) {
  const index = { top: 0, right: 1, bottom: 2, left: 3 }[side];
  let value = null;
  for (const rule of RULES) {
    if (!mediaMatches(rule.media) || !selectorMatches(rule.selector)) continue;
    for (const [, name, raw] of rule.body.matchAll(/(?:^|;)\s*([\w-]+)\s*:\s*([^;]+)/g)) {
      if (name === `${prop}-${side}`) value = toPx(raw.trim());
      else if (name === prop) {
        const parts = raw.trim().split(/\s+/);
        const pick = [parts[0], parts[1] ?? parts[0], parts[2] ?? parts[0], parts[3] ?? parts[1] ?? parts[0]][index];
        value = toPx(pick);
      } else if (name === `${prop}-block` && (side === 'top' || side === 'bottom')) {
        const parts = raw.trim().split(/\s+/);
        value = toPx(side === 'top' ? parts[0] : (parts[1] ?? parts[0]));
      } else if (name === `${prop}-inline` && (side === 'left' || side === 'right')) {
        const parts = raw.trim().split(/\s+/);
        value = toPx(side === 'left' ? parts[0] : (parts[1] ?? parts[0]));
      }
    }
  }
  return value;
}

const PHONE = 360;   // die schmalste Breite, die der Installer zusagt

/* Schalterzeilen: das Label war 24px hoch und endete am letzten Buchstaben,
 * die restliche Zeile nahm keinen Tipp an. Geprueft wird die WIRKUNG: jeder
 * Schalter sitzt in einem label.toggle-row direkt in einem .field (sonst greift
 * die Regel nicht), das Feld gibt sein Polster ab (sonst endet das Label vor der
 * Zeilenkante), und das Label ist mit Polster und Bahn mindestens 44px hoch.
 * Ein neuer Schalter ohne diese Form faellt ueber die Markup-Pruefung auf.
 * (Seit den Schaltern der App ist das Kaestchen eine 26px hohe Bahn in
 * .toggle; die Regel ist dieselbe.) */
test('jede Schalterzeile ist als ganze Zeile tippbar, mindestens 44px hoch', () => {
  const boxes = [...html.matchAll(/<input type="checkbox"[^>]*>/g)];
  assert.ok(boxes.length >= 10, `erwartet mindestens zehn Schalter, gefunden ${boxes.length}`);
  const wrapped = [...html.matchAll(/<div class="field">\s*<label class="toggle-row">(?:(?!<\/label>)[\s\S])*?<input type="checkbox"[^>]*>/g)];
  assert.equal(wrapped.length, boxes.length,
    'ein Schalter sitzt nicht in <div class="field"><label class="toggle-row"> - die Zeilenregel greift fuer ihn nicht');

  const phone = appliesAt(PHONE);
  const fieldSel = sel => /\.field:has\(\s*>\s*\.toggle-row\s*\)$/.test(sel);
  const labelSel = sel => sel === 'label.toggle-row';
  // Ohne eigene Regel gilt fuer das Feld das Zeilenpolster aller Felder.
  const rowField = sel => sel === '.inset-group .field' || fieldSel(sel);
  for (const side of ['top', 'right', 'bottom', 'left']) {
    const pad = boxSide(rowField, 'padding', side, phone) ?? 0;
    assert.equal(pad, 0, `die Schalterzeile behaelt ${pad}px Polster ${side} - dort nimmt sie keinen Tipp an`);
  }
  const box = toPx(declared(sel => sel === '.toggle__track', 'height')) ?? 0;
  const padY = (boxSide(labelSel, 'padding', 'top', phone) ?? 0) + (boxSide(labelSel, 'padding', 'bottom', phone) ?? 0);
  const minH = toPx(declared(labelSel, 'min-height', phone)) ?? 0;
  const tap = Math.max(minH, box + padY);
  assert.ok(tap >= 44, `eine Schalterzeile ist nur ${tap}px hoch tippbar, 44px sind das Minimum`);
  // Die Zeile sieht aus wie vorher: das Label traegt das Zeilenpolster der Felder.
  const rowPad = boxSide(sel => sel === '.inset-group .field', 'padding', 'left', phone);
  assert.equal(boxSide(labelSel, 'padding', 'left', phone), rowPad,
    'das Schalter-Label fluchtet nicht mit den Feldern der Gruppe');
});

/* Kompakte Kopfzeile: bis zum ersten Schritt-Inhalt vergingen auf dem Handy
 * 191px (Critique 2026-09-29) - Rand fuer den Sprachumschalter, 64px-Tile,
 * Wortmarke darunter. Gerechnet wird der Inhaltsbeginn aus der Kaskade bei
 * 360px: Seitenrand oben + eine Zeile (Tile ODER Mindesthoehe) + Abstand. Der
 * Sprachumschalter muss in DIESER Zeile enden, sonst ragt er in den Inhalt;
 * Einstieg und Abschluss behalten das grosse Tile UNTER dem Umschalter. */
test('ab Schritt 1 steht auf dem Handy eine einzeilige Kopfzeile, der Inhalt beginnt vor 90px', () => {
  const phone = appliesAt(PHONE);
  const compact = sel => sel === '.brand' || sel === '.shell:not(.shell--solo) .brand';
  const mark = sel => sel === '.brand__mark' || sel === '.shell:not(.shell--solo) .brand__mark';

  assert.equal(declared(compact, 'display', phone), 'flex', 'Tile und Wortmarke stehen nicht in einer Zeile');
  const tile = toPx(declared(mark, 'height', phone));
  assert.ok(tile <= 40, `das Tile der Kopfzeile ist ${tile}px hoch, 40px sind das Mass der App-Zeile`);

  const top = boxSide(sel => sel === 'body', 'padding', 'top', phone);
  const rowH = Math.max(tile, toPx(declared(compact, 'min-height', phone)) ?? 0);
  const gap = boxSide(compact, 'margin', 'bottom', phone) ?? 0;
  const start = top + rowH + gap;
  assert.ok(start <= 90, `der Schritt beginnt auf dem Handy erst bei ${start}px (Ziel <= 90px)`);

  const lang = sel => sel === '.lang-switch';
  const langTop = toPx(declared(lang, 'top', phone));
  const langH = toPx(declared(sel => sel === '.lang-switch select', 'min-height', phone));
  assert.ok(langTop + langH <= top + rowH,
    `der Sprachumschalter endet bei ${langTop + langH}px, die Kopfzeile bei ${top + rowH}px - er ragt in den Inhalt`);

  // Einstieg/Abschluss: das grosse Tile beginnt unter dem Umschalter.
  const soloTop = top + (boxSide(sel => sel === '.shell--solo .brand', 'padding', 'top', phone) ?? 0);
  assert.ok(soloTop >= langTop + langH,
    `das Tile des Einstiegs beginnt bei ${soloTop}px, unter dem Umschalter (${langTop + langH}px) waere noetig`);

  // Fortschritt bleibt: Balken sichtbar, Zaehler nicht versteckt.
  assert.notEqual(declared(sel => sel === '.progress-track', 'display', phone), 'none', 'der Fortschrittsbalken fehlt mobil');
  assert.notEqual(declared(sel => sel === '.step-tag', 'display', phone), 'none', 'der Schrittzaehler fehlt mobil');
});

/* Fussleiste bei 360px: Zurueck und Primaeraktion nebeneinander, ohne Umbruch.
 * Gemessen im Browser (14px/600, Systemschrift): die laengsten Beschriftungen
 * sind el review.save 229px und fr review.confirm 228px; ru/uk review.confirm
 * und uk simple.start sind dafuer gekuerzt worden. Die Rechnung hier haelt das
 * Budget, das die Leiste der Primaeraktion laesst: Zeile minus Zurueck minus
 * Abstand minus Polster. Ein Zurueck mit Textbreite (auto) ist nicht rechenbar
 * und zaehlt als Verstoss - genau so lief es vorher auf 209px zusammen. */
test('die Primaeraktion hat bei 360px Platz fuer die laengste Beschriftung', () => {
  const phone = appliesAt(PHONE);
  const LONGEST_LABEL = 229;
  const row = PHONE - (boxSide(sel => sel === 'body', 'padding', 'left', phone) ?? 0)
    - (boxSide(sel => sel === 'body', 'padding', 'right', phone) ?? 0);
  const back = sel => sel === '.card-foot .btn-ghost[data-back]';
  const backW = toPx(declared(back, 'width', phone));
  assert.ok(backW !== null, 'Zurueck hat in der Fussleiste keine feste Breite - die Primaeraktion bekommt den Rest, der uebrig bleibt');
  assert.ok(backW >= 44, `Zurueck ist nur ${backW}px breit, 44px sind das Minimum`);
  const gap = toPx(declared(sel => sel === '.card-foot', 'gap', phone)) ?? 0;
  const primary = sel => sel === '.btn' || sel === '.card-foot .btn-primary';
  const padL = boxSide(primary, 'padding', 'left', phone) ?? 0;
  const padR = boxSide(primary, 'padding', 'right', phone) ?? 0;
  const budget = row - backW - gap - padL - padR;
  assert.ok(budget >= LONGEST_LABEL + 8,
    `der Primaeraktion bleiben ${budget}px fuer ihre Beschriftung, die laengste braucht ${LONGEST_LABEL}px (plus Reserve)`);
  const grow = flexParts(declared(sel => sel === '.card-foot .btn-primary', 'flex', phone) || '0 1 auto').grow;
  assert.ok(grow >= 1, 'die Primaeraktion waechst nicht in die freie Breite der Leiste');
});

/* Sanft und nur so weit wie noetig: `block: 'center'` riss die Seite bei jedem
 * Fehler um einen halben Bildschirm. reveal() wird AUSGEFUEHRT, mit und ohne
 * reduced-motion; alle Aufrufer gehen ueber reveal(). */
test('Fehler und Akkordeons scrollen nur so weit wie noetig, unter reduced-motion ohne Gleiten', () => {
  const src = fnSource('reveal');
  const calls = [];
  for (const reduce of [false, true]) {
    const reveal = new Function('matchMedia', `${src}; return reveal;`)(q => ({ matches: reduce && /reduce/.test(q) }));
    reveal({ scrollIntoView: opts => calls.push(opts) });
    reveal(null);   // ohne Ziel kein Wurf
  }
  assert.deepEqual(calls, [
    { block: 'nearest', behavior: 'smooth' },
    { block: 'nearest', behavior: 'auto' },
  ]);
  const script = html.slice(html.indexOf('<script type="module">'));
  const direct = [...script.matchAll(/\.scrollIntoView\(/g)].length;
  assert.equal(direct, 1, `scrollIntoView steht ${direct}x im Skript - nur reveal() darf es rufen`);
  assert.match(fnSource('fail'), /reveal\(/, 'fail() holt Feld und Grund nicht per reveal() in Sicht');
  // Die schwebende Fussleiste verdeckt sonst, was nearest fuer sichtbar haelt.
  const pad = boxSide(sel => sel === 'html', 'scroll-padding', 'bottom', m => m === null);
  assert.ok(pad >= 73, `scroll-padding unten ist ${pad}px, die Fussleiste ist 73px hoch`);
});

// ── Bewegung (Critique 2026-09-29, animate) ───────────────────────────────────

/** Werteliste einer Deklaration an Kommas der obersten Ebene (var()/calc() bleiben ganz). */
function splitTop(value, sep = ',') {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of value) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (depth === 0 && (sep === ',' ? ch === ',' : /\s/.test(ch))) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Alle transition-/animation-Deklarationen der <style>-Bloecke, auch in @supports. */
function motionDeclarations() {
  const css = stylesheet(html);
  return [...css.matchAll(/(?:^|[;{\s])((?:transition|animation)(?:-[a-z-]+)?)\s*:\s*([^;{}]+)/g)]
    .map(m => ({ prop: m[1], value: m[2].trim() }))
    // Custom Properties (--ease-out) und view-transition-name sind keine Bewegung.
    .filter(d => !/^(?:transition|animation)-(?:behavior|property|name|iteration-count|direction|fill-mode|play-state|composition)$/.test(d.prop));
}

const TIME = /^-?[\d.]+m?s$/;
const isTokenTime = v => /^var\(--duration-[\w-]+\)$/.test(v) || (/^calc\(/.test(v) && /var\(--duration-/.test(v) && !/[\d.]+m?s\b/.test(v));
const isZero = v => /^0(?:\.0+)?m?s?$/.test(v);
const isTimeLike = v => TIME.test(v) || /^var\(--duration-/.test(v) || /^calc\(.*--duration-/.test(v);
const EASING_KEYWORD = /^(?:ease|ease-in|ease-out|ease-in-out|step-start|step-end)$/;
const isTokenEasing = v => /^var\(--ease-[\w-]+\)$/.test(v) || v === 'linear' || /^steps\(/.test(v);

/* Eine Bewegungssprache: Dauer aus --duration-*, Kurve aus --ease-* (linear nur
 * fuer Endlosdrehung und diskrete Schalter). Die Materialkurve am Balken und
 * nackte `.15s` hatten jede Stelle anders klingen lassen. Geprueft wird die
 * WIRKUNG: eine Transition ohne Kurve laeuft mit `ease` (Browser-Vorgabe), das
 * zaehlt genauso wie ein ausgeschriebenes `ease`. */
test('jede Transition und Animation rechnet mit den Motion-Tokens der App', () => {
  const decls = motionDeclarations();
  assert.ok(decls.length >= 15, `nur ${decls.length} Bewegungs-Deklarationen gefunden - der Scanner greift nicht`);
  const bad = [];
  for (const { prop, value } of decls) {
    if (value === 'none') continue;
    if (/-(?:duration|delay)$/.test(prop)) {
      for (const v of splitTop(value)) if (!isTokenTime(v) && !isZero(v)) bad.push(`${prop}: ${value}`);
      continue;
    }
    if (/-timing-function$/.test(prop)) {
      for (const v of splitTop(value)) if (!isTokenEasing(v)) bad.push(`${prop}: ${value}`);
      continue;
    }
    for (const item of splitTop(value)) {
      if (item === 'none') continue;
      const parts = splitTop(item, ' ');
      const times = parts.filter(isTimeLike);
      const easing = parts.filter(p => EASING_KEYWORD.test(p) || /^cubic-bezier\(/.test(p) || isTokenEasing(p));
      if (!times.length) { bad.push(`${prop}: ${item} (ohne Dauer)`); continue; }
      for (const tm of times) if (!isTokenTime(tm) && !isZero(tm)) bad.push(`${prop}: ${item} (Dauer ${tm})`);
      const moving = !isZero(times[0]);
      if (easing.some(e => !isTokenEasing(e))) bad.push(`${prop}: ${item} (Kurve)`);
      else if (moving && !easing.length) bad.push(`${prop}: ${item} (ohne Kurve = ease)`);
    }
  }
  assert.deepEqual(bad, [], `Bewegung ausserhalb der Motion-Tokens:\n  ${bad.join('\n  ')}`);
});

/** @keyframes-Bloecke der <style>-Bloecke: Name -> Rumpf. */
function keyframes() {
  const css = stylesheet(html);
  const map = new Map();
  for (const m of css.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {
    let depth = 1, k = m.index + m[0].length;
    while (k < css.length && depth > 0) { if (css[k] === '{') depth++; else if (css[k] === '}') depth--; k++; }
    map.set(m[1], css.slice(m.index + m[0].length, k - 1));
  }
  return map;
}

const MOVING = /\b(?:transform|translate|rotate|scale|grid-template-rows|block-size|inline-size|height|width|margin[\w-]*|top|left|right|bottom)\b/;

/* Reduced-Motion ist ein eigener Zweig, kein Nebeneffekt: jede Animation und
 * jede Transition, die etwas BEWEGT (Gleiten, Drehen, Aufziehen), bekommt unter
 * `prefers-reduced-motion: reduce` eine Regel fuer denselben Selektor - und die
 * darf selbst nichts mehr bewegen (Blende, Puls, sofort). Vorher stand der
 * Spinner dort einfach still und der Schirm wirkte, als haenge er. */
test('jede Animation und jede bewegte Transition hat einen reduced-motion-Zweig ohne Bewegung', () => {
  const frames = keyframes();
  const isReduce = media => media !== null && /prefers-reduced-motion:\s*reduce/.test(media);
  const reduceRules = RULES.filter(r => isReduce(r.media));
  assert.ok(reduceRules.length >= 8, 'der reduced-motion-Block fehlt oder ist leer');
  const value = (body, prop) => body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`))?.[1].trim() ?? null;

  const missing = [];
  for (const rule of RULES) {
    if (isReduce(rule.media)) continue;
    const anim = value(rule.body, 'animation') ?? value(rule.body, 'animation-name');
    const names = anim && anim !== 'none' ? splitTop(anim).map(i => splitTop(i, ' ').find(p => frames.has(p))).filter(Boolean) : [];
    const trans = value(rule.body, 'transition');
    const moves = trans && trans !== 'none' && splitTop(trans).some(i => MOVING.test(splitTop(i, ' ')[0]));
    if (!names.length && !moves) continue;
    const branch = reduceRules.filter(r => r.selector === rule.selector);
    if (names.length && !branch.some(r => value(r.body, 'animation') ?? value(r.body, 'animation-name'))) {
      missing.push(`${rule.selector}: Animation ${names.join(', ')} ohne reduced-motion-Zweig`);
    }
    if (moves && !branch.some(r => value(r.body, 'transition'))) {
      missing.push(`${rule.selector}: bewegte Transition (${trans}) ohne reduced-motion-Zweig`);
    }
  }
  assert.deepEqual(missing, [], missing.join('\n'));

  // Und der Zweig selbst bewegt nichts.
  const still = [];
  for (const r of reduceRules) {
    const anim = value(r.body, 'animation');
    for (const item of anim && anim !== 'none' ? splitTop(anim) : []) {
      const name = splitTop(item, ' ').find(p => frames.has(p));
      if (name && MOVING.test(frames.get(name))) still.push(`${r.selector}: ${name} bewegt (${frames.get(name).trim()})`);
    }
    const trans = value(r.body, 'transition');
    for (const item of trans && trans !== 'none' ? splitTop(trans) : []) {
      if (MOVING.test(splitTop(item, ' ')[0])) still.push(`${r.selector}: transition ${item}`);
    }
  }
  assert.deepEqual(still, [], `reduced-motion bewegt weiter:\n  ${still.join('\n  ')}`);

  // Der Spinner steht dort nicht still, er pulsiert (Deckkraft).
  const pulse = reduceRules.find(r => /\.phase\[data-state="active"\] \.phase__mark::after/.test(r.selector));
  const pulseName = pulse && splitTop(value(pulse.body, 'animation') ?? '', ' ').find(p => frames.has(p));
  assert.ok(pulseName && /opacity/.test(frames.get(pulseName)) && /infinite/.test(value(pulse.body, 'animation')),
    'die laufende Phase zeigt unter reduced-motion keine Bewegung-freie Aktivitaet (Puls)');
  // Der Schrittwechsel blendet dort hoechstens 150ms.
  const fade = reduceRules.find(r => r.selector.startsWith('html:not(.step-vt)[data-step-dir]'));
  const fadeDur = fade && splitTop(value(fade.body, 'animation'), ' ').find(isTimeLike);
  assert.ok(fadeDur && toPx(resolveVar(fadeDur).replace('ms', 'px')) <= 150,
    `der Schrittwechsel unter reduced-motion dauert ${fadeDur} (hoechstens 150ms)`);
});

/* Schrittwechsel mit Richtung: vorwaerts von der Leserichtung her, zurueck von
 * der Gegenseite, in RTL gespiegelt. Nur die Inhaltsspalte traegt waehrend der
 * View Transition einen Namen, die Fussleiste steht unter eigenem Namen still,
 * und der CSS-Rueckfall laesst sie ebenfalls aus. */
test('der Schrittwechsel gleitet in Leserichtung, RTL gespiegelt, ohne die Fussleiste', () => {
  const shift = sel => toPx(declared(s => s === sel, '--step-shift'));
  assert.ok(shift('html[data-step-dir="forward"]') > 0, 'vorwaerts kommt der Schritt nicht von rechts');
  assert.ok(shift('html[data-step-dir="back"]') < 0, 'zurueck kommt der Schritt nicht von links');
  assert.ok(shift('html[dir="rtl"][data-step-dir="forward"]') < 0, 'RTL vorwaerts ist nicht gespiegelt');
  assert.ok(shift('html[dir="rtl"][data-step-dir="back"]') > 0, 'RTL zurueck ist nicht gespiegelt');
  for (const sel of ['html[data-step-dir="forward"]', 'html[data-step-dir="back"]']) {
    const px = Math.abs(shift(sel));
    assert.ok(px >= 8 && px <= 16, `der Weg ist ${px}px (8-16px)`);
  }
  const frames = keyframes();
  assert.match(frames.get('step-in'), /translateX\(var\(--step-shift/, 'step-in nutzt die Richtung nicht');

  // CSS-Rueckfall: der neue Schritt faehrt ein, die Fussleiste nicht.
  const fallback = RULES.find(r => r.media === null && /\[data-step-dir\] \.step\.active > /.test(r.selector) && /animation:\s*step-in/.test(r.body));
  assert.ok(fallback, 'der CSS-Rueckfall fuer den Schrittwechsel fehlt');
  assert.match(fallback.selector, /:not\(\.card-foot\)/, 'der CSS-Rueckfall bewegt die Fussleiste mit');
  assert.match(fallback.selector, /html:not\(\.step-vt\)/, 'der CSS-Rueckfall laeuft auch waehrend der View Transition');

  // View Transition: Namen nur waehrend des Wechsels, Wurzel lebend, Fussleiste still.
  const vtName = sel => declared(s => s === sel, 'view-transition-name');
  assert.equal(vtName('html.step-vt .card'), 'step', 'die Inhaltsspalte traegt waehrend des Wechsels keinen Namen');
  assert.equal(vtName('.card'), null, 'die Inhaltsspalte traegt dauerhaft einen Namen (Backdrop Root, Glas der Fussleiste)');
  assert.equal(vtName('html.step-vt .step.active > .card-foot'), 'step-foot', 'die Fussleiste gleitet mit der Spalte');
  assert.equal(declared(s => s === '::view-transition-old(step-foot)', 'display'), 'none');
  assert.equal(declared(s => s === '::view-transition-new(step-foot)', 'animation'), 'none');
  assert.equal(declared(s => s === '::view-transition-old(root)', 'display'), 'none', 'die Wurzel blendet mit - Schrittliste und Balken wuerden doppelt gezeichnet');
  assert.equal(declared(s => s === '::view-transition-new(root)', 'animation'), 'none');
  assert.match(declared(s => s === '::view-transition-new(step)', 'animation'), /^step-in\b/);
  assert.match(declared(s => s === '::view-transition-old(step)', 'animation'), /^step-out\b/);
});

/** Ein kleines Element-Double fuer die ausgefuehrten Pruefungen. */
function fakeEl(extra = {}) {
  const classes = new Set();
  const attrs = {};
  return {
    style: {}, dataset: {}, textContent: '', focused: 0,
    classList: {
      add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c),
      toggle: (c, on) => { const v = on ?? !classes.has(c); if (v) classes.add(c); else classes.delete(c); return v; },
    },
    setAttribute(k, v) { attrs[k] = String(v); }, getAttribute(k) { return attrs[k] ?? null; },
    removeAttribute(k) { delete attrs[k]; }, focus() { this.focused++; },
    attrs, classes, ...extra,
  };
}

/* swapStep wird AUSGEFUEHRT: ohne API, verdeckt oder unter reduced-motion
 * sofort und mit Richtung am <html> (CSS-Rueckfall); sonst als View
 * Transition, deren Rueckruf den Tausch macht, und danach sind Klasse und
 * Richtung wieder weg - sonst startete die CSS-Animation am stehenden Schritt
 * ein zweites Mal. */
test('swapStep: View Transition mit Richtung, sonst sofort mit CSS-Rueckfall', async () => {
  const src = `${fnSource('canViewTransition')}\nlet stepTransition = null;\n${fnSource('swapStep')}\nreturn swapStep;`;
  const make = ({ api = true, hidden = false, reduce = false } = {}) => {
    const root = fakeEl();
    const listeners = [];
    const doc = {
      documentElement: root, visibilityState: hidden ? 'hidden' : 'visible',
      addEventListener: (...a) => listeners.push(a), removeEventListener() {},
      transitions: [],
    };
    if (api) {
      doc.startViewTransition = cb => {
        let resolve;
        const vt = {
          cb, skipped: false, ready: Promise.resolve(),
          finished: new Promise(r => { resolve = r; }),
          skipTransition() { this.skipped = true; },
          end() { resolve(); },
        };
        doc.transitions.push(vt);
        return vt;
      };
    }
    const swapStep = new Function('document', 'matchMedia', src)(doc, q => ({ matches: reduce && /reduce/.test(q) }));
    return { swapStep, doc, root };
  };

  // Rueckfall: sofort, Richtung gesetzt, kein step-vt.
  for (const opts of [{ api: false }, { hidden: true }, { reduce: true }]) {
    const { swapStep, doc, root } = make(opts);
    let ran = 0;
    swapStep(() => ran++, 'back', true);
    assert.equal(ran, 1, `${JSON.stringify(opts)}: der Tausch lief nicht sofort`);
    assert.equal(root.dataset.stepDir, 'back', `${JSON.stringify(opts)}: die Richtung fehlt fuer den CSS-Rueckfall`);
    assert.equal(root.classes.has('step-vt'), false);
    assert.equal(doc.transitions.length, 0, `${JSON.stringify(opts)}: es lief trotzdem eine View Transition`);
  }
  // Ohne Animation (Kette, erster Aufruf): sofort und ohne Richtung.
  {
    const { swapStep, doc, root } = make();
    let ran = 0;
    swapStep(() => ran++, '', false);
    assert.equal(ran, 1);
    assert.equal(root.dataset.stepDir, undefined);
    assert.equal(doc.transitions.length, 0);
  }
  // View Transition: Tausch im Rueckruf, Klasse waehrenddessen, danach aufgeraeumt.
  {
    const { swapStep, doc, root } = make();
    let ran = 0;
    swapStep(() => ran++, 'forward', true);
    assert.equal(ran, 0, 'der Tausch lief vor der Aufnahme des alten Bildes');
    assert.equal(doc.transitions.length, 1);
    assert.equal(root.classes.has('step-vt'), true, 'die Namen stehen nicht waehrend des Wechsels');
    assert.equal(root.dataset.stepDir, 'forward');
    doc.transitions[0].cb();
    assert.equal(ran, 1);
    doc.transitions[0].end();
    await new Promise(r => setTimeout(r, 0));
    assert.equal(root.classes.has('step-vt'), false, 'step-vt bleibt nach dem Wechsel stehen');
    assert.equal(root.dataset.stepDir, undefined, 'die Richtung bleibt stehen - die CSS-Animation liefe ein zweites Mal');
  }
  // Ein sofortiger Wechsel mitten in einer Transition bricht sie ab, und ihr
  // spaetes Ende raeumt den neuen Stand nicht ab.
  {
    const { swapStep, doc, root } = make();
    swapStep(() => {}, 'forward', true);
    swapStep(() => {}, 'back', false);
    assert.equal(doc.transitions[0].skipped, true, 'die ueberholte Transition laeuft weiter');
    assert.equal(root.dataset.stepDir, 'back');
    doc.transitions[0].end();
    await new Promise(r => setTimeout(r, 0));
    assert.equal(root.dataset.stepDir, 'back', 'das Ende der alten Transition loeschte die neue Richtung');
  }
});

/* showStep bestimmt die Richtung aus dem Zustand, und ein ueberholter Rueckruf
 * zeichnet nicht mehr (er risse Fokus und Scrollstand an sich). next() wechselt
 * auf dem Rueckweg zur Pruefseite ohne Bildwechsel, weil sofort der naechste
 * Klick folgt und dessen Pruefung den Schritt sichtbar braucht. */
test('showStep: Richtung aus dem Zustand, nur der juengste Wechsel zeichnet, Ketten ohne Bildwechsel', () => {
  const calls = [];
  const h = new Function('swapStep', 'renderStep', 'onEnterStep', `
    let currentStep = 2, stepSwap = 0;
    const flow = ['welcome', 'config', 'secrets', 'weather', 'review'];
    const clearInvalid = () => {}, setProgress = () => {};
    ${fnSource('showStep')}
    return { showStep, get step() { return currentStep; } };
  `)((update, dir, animate) => calls.push({ update, dir, animate }), () => calls.push('render'), () => {});
  h.showStep(3);
  h.showStep(1);
  h.showStep(1);
  h.showStep(4, { animate: false });
  assert.deepEqual(calls.map(c => [c.dir, c.animate]), [['forward', true], ['back', true], ['', false], ['forward', false]]);
  // Nur der juengste Rueckruf zeichnet.
  calls[0].update();
  assert.equal(calls.includes('render'), false, 'ein ueberholter Wechsel zeichnete noch');
  calls[3].update();
  assert.equal(calls.filter(c => c === 'render').length, 1);

  const next = fnSource('next');
  assert.match(next, /showStep\(target, \{ animate: !\(reviewReturn !== null && target > reviewReturn\) \}\)/,
    'next() wechselt in der Kette zur Pruefseite mit Bildwechsel');
  assert.match(fnSource('renderStep'), /\.focus\(\{ preventScroll: true \}\)/, 'renderStep fokussiert die H2 nicht');
});

/* Akkordeons gleiten auf und zu (Rasterzeile 0fr -> 1fr, --ease-in-out wie jede
 * Hoehe der App) und bleiben zugeklappt fuer Tastatur und Screenreader
 * unerreichbar: visibility hidden, und beim Zuklappen erst NACH dem Gleiten. */
test('Akkordeons gleiten, bleiben zugeklappt unerreichbar und holen sich erst danach in Sicht', () => {
  const base = m => m === null;
  const get = (sel, prop) => declared(s => s === sel, prop, base);
  assert.equal(get('.toggle-card', 'display'), 'grid');
  assert.equal(get('.toggle-card', 'grid-template-rows'), 'auto 0fr', 'zugeklappt ist die Inhaltszeile nicht 0');
  assert.equal(get('.toggle-card:has(> .toggle-body.open)', 'grid-template-rows'), 'auto 1fr');
  assert.match(get('.toggle-card', 'transition'), /^grid-template-rows var\(--duration-[\w-]+\) var\(--ease-in-out\)/);

  const hiddenClosed = get('.toggle-body', 'visibility') === 'hidden' || get('.toggle-body', 'display') === 'none';
  assert.ok(hiddenClosed, 'ein zugeklapptes Akkordeon ist fuer Tastatur und Screenreader erreichbar');
  assert.notEqual(get('.toggle-body.open', 'visibility'), 'hidden');
  assert.notEqual(get('.toggle-body.open', 'display'), 'none');
  // Zuklappen: Sichtbarkeit erst nach der Dauer der Zeile; aufklappen: sofort.
  const dur = v => toPx(resolveVar(v).replace('ms', 'px'));
  const rowDur = dur(splitTop(get('.toggle-card', 'transition'), ' ')[1]);
  const vis = splitTop(get('.toggle-body', 'transition'), ' ');
  assert.equal(vis[0], 'visibility');
  assert.ok(dur(vis[vis.length - 1]) >= rowDur, 'der Inhalt verschwindet, bevor die Zeile zugeglitten ist');
  assert.ok(isZero(get('.toggle-body.open', 'transition-delay') ?? ''), 'beim Aufklappen wartet die Sichtbarkeit');
  // Auf 0 kommt die Zeile nur ohne eigenes Mass: kein Polster, keine Kante.
  for (const side of ['top', 'bottom']) {
    assert.equal(boxSide(s => s === '.toggle-body', 'padding', side, base) ?? 0, 0, `.toggle-body traegt Polster ${side}`);
  }
  assert.equal(get('.toggle-body', 'border-top'), null, '.toggle-body traegt eine Kante, zugeklappt bliebe 1px stehen');
  assert.equal(get('.toggle-body', 'overflow'), 'hidden');

  // <details> "Mehr erfahren" gleitet, wo ::details-content existiert.
  assert.equal(get('.hint-more::details-content', 'block-size'), '0');
  assert.equal(get('.hint-more[open]::details-content', 'block-size'), 'auto');
  assert.equal(get('.hint-more', 'interpolate-size'), 'allow-keywords');
  assert.match(get('.hint-more::details-content', 'transition'), /content-visibility [^,]*allow-discrete/,
    'zugeklappt bliebe der Text sichtbar/erreichbar, bis die Hoehe 0 ist - content-visibility muss mitschalten');

  // In Sicht erst nach dem Aufziehen.
  assert.match(html, /afterTransition\(card, \(\) => reveal\(card \|\| toggleBtn\)\)/, 'das Akkordeon holt sich vor dem Aufziehen in Sicht');
  const after = new Function('getComputedStyle', 'setTimeout', `${fnSource('afterTransition')}; return afterTransition;`);
  let ran = 0;
  after(() => ({ transitionDuration: '0s' }), () => {})({}, () => ran++);
  assert.equal(ran, 1, 'ohne Transition (reduced-motion) wartet afterTransition');
  const listeners = {};
  let timer = null;
  const el = { addEventListener: (n, f) => { listeners[n] = f; }, removeEventListener: n => { delete listeners[n]; } };
  after(() => ({ transitionDuration: '0.25s, 0s' }), (f, ms) => { timer = { f, ms }; })(el, () => ran++);
  assert.equal(ran, 1, 'afterTransition lief vor dem Ende');
  assert.ok(timer.ms >= 250, `der Rueckfall-Zeitgeber (${timer.ms}ms) ist kuerzer als die Transition`);
  listeners.transitionend({ target: {} });
  assert.equal(ran, 1, 'das Ende einer Kind-Transition zaehlte');
  listeners.transitionend({ target: el });
  timer.f();
  assert.equal(ran, 2, 'afterTransition lief nicht genau einmal');
});

/* Docker-Schirm: drei Phasen als Checkliste. Ausgefuehrt: der Stand zaehlt nur
 * vorwaerts, erledigte Phasen haben ihren Haken, die laufende aria-current,
 * nach dem Erfolg ist alles fertig, Titel und Zaehler sagen es, der Fokus geht
 * auf den neuen Titel. Im Fehler wird die Phase markiert, in der es stand. */
test('Docker-Schirm: Phasen-Checkliste, Erfolg mit neuem Titel und Fokus, Fehler an der richtigen Phase', () => {
  const ids = ['dkr-title', 'dkr-subtitle', 'dkr-elapsed', 'dkr-expect', 'dkr-stalled', 'dkr-logs-toggle', 'dkr-log', 'dkr-foot', 'dkr-text'];
  const make = () => {
    const els = Object.fromEntries(ids.map(id => [id, fakeEl()]));
    const rows = ['pull', 'boot', 'health'].map(p => {
      const note = fakeEl();
      return fakeEl({ dataset: { phase: p }, note, querySelector: () => note });
    });
    const doc = { querySelectorAll: () => rows };
    const h = new Function('document', '$', 't', `
      const PHASE_KEYS = { pull: 'docker.phasePull', boot: 'docker.phaseBoot', health: 'docker.phaseHealth' };
      const PHASE_ORDER = ${JSON.stringify(literal('PHASE_ORDER'))};
      let phaseReached = 0, dockerOutcome = null, dockerDoneSecs = null, dockerTextKey = 'docker.phasePull';
      let dockerDone = false, pollInterval = null, dockerStart = Date.now() - 34_000;
      let flow = ['review', 'docker'], currentStep = 1;
      const clearInterval = () => {}, setDockerPrimary = () => {}, next = () => {}, restartDocker = () => {};
      const renderStepNav = () => {};   // eigener Test: "Docker in der Schrittliste"
      ${fnSource('setDockerText')}
      ${fnSource('reachPhase')}
      ${fnSource('setPhase')}
      ${fnSource('renderPhases')}
      ${fnSource('setDockerHead')}
      ${fnSource('dockerSucceeded')}
      ${fnSource('dockerFailed')}
      return { setPhase, reachPhase, dockerSucceeded, dockerFailed };
    `)(doc, id => els[id], (k, p) => (p ? `${k}:${p.n}` : k));
    return { h, els, rows };
  };
  const states = rows => rows.map(r => r.dataset.state).join(' ');

  {
    const { h, els, rows } = make();
    h.setPhase('pull');
    assert.equal(states(rows), 'active waiting waiting');
    assert.equal(rows[0].getAttribute('aria-current'), 'step');
    h.setPhase('health');
    assert.equal(states(rows), 'done done active');
    assert.equal(rows[0].note.textContent, 'common.stepDone', 'eine erledigte Phase sagt es dem Screenreader nicht');
    h.setPhase('boot');
    assert.equal(states(rows), 'done done active', 'ein Rueckfall des Servers nahm einen Haken weg');
    assert.equal(els['dkr-text'].textContent, 'docker.phaseHealth');
    h.dockerSucceeded();
    assert.equal(states(rows), 'done done done');
    assert.equal(rows[2].getAttribute('aria-current'), null);
    assert.equal(els['dkr-title'].dataset.i18n, 'docker.doneTitle', 'der Titel nennt den Erfolg nicht');
    assert.equal(els['dkr-title'].textContent, 'docker.doneTitle');
    assert.equal(els['dkr-subtitle'].dataset.i18n, 'docker.doneSubtitle');
    assert.equal(els['dkr-elapsed'].textContent, 'docker.doneIn:34', 'der Zaehler friert nicht als "fertig in N s" ein');
    assert.equal(els['dkr-title'].focused, 1, 'der Fokus geht nicht auf den neuen Titel');
    assert.equal(els['dkr-text'].textContent, 'docker.running', 'die Live-Region sagt den Erfolg nicht an');
  }
  {
    const { h, els, rows } = make();
    h.setPhase('pull');
    h.reachPhase('boot');   // wie pollDocker bei status: error, phase: boot
    h.dockerFailed('log');
    assert.equal(states(rows), 'done failed waiting', 'die gescheiterte Phase ist nicht markiert');
    assert.equal(rows[1].note.textContent, 'docker.stepFailed');
    assert.equal(els['dkr-title'].dataset.i18n, 'docker.failed');
    assert.equal(els['dkr-log'].style.display, 'block', 'das Protokoll bleibt im Fehler nicht stehen');
    assert.equal(els['dkr-foot'].style.display, 'flex', 'Erneut versuchen fehlt im Fehler');
    assert.equal(els['dkr-title'].focused, 0, 'der Fehler reisst den Fokus an sich');
  }
  {
    const { h, rows } = make();
    h.setPhase('pull');
    h.reachPhase('engine');   // keine Engine: nichts ist gestartet
    h.dockerFailed('Missing: docker');
    assert.equal(states(rows), 'failed waiting waiting');
  }
  // pollDocker rueckt die gemeldete Phase vor, bevor es scheitert.
  assert.match(fnSource('pollDocker'), /reachPhase\(d\.phase\);\s*dockerFailed/, 'pollDocker markiert die vom Server gemeldete Phase nicht');
  // Ein Neustart setzt Titel, Stand und Zaehler zurueck.
  assert.match(fnSource('restartDocker'), /setDockerHead\('docker\.title', 'docker\.subtitle'\)/);
  assert.match(html, /async function startDocker\(\) \{[\s\S]*?phaseReached = 0;[\s\S]*?dockerOutcome = null;/, 'startDocker setzt den Phasenstand nicht zurueck');
  // Sprachwechsel zeichnet Liste und Endwert neu.
  const localize = fnSource('localize');
  assert.match(localize, /renderPhases\(\)/, 'ein Sprachwechsel laesst die Zustandstexte der Liste in der alten Sprache');
  assert.match(localize, /docker\.doneIn/, 'ein Sprachwechsel verliert "fertig in N s"');
});

// ── Polish (Critique 2026-09-29, Restliste) ─────────────────────────────────

/** Markup eines Schritts (vom Oeffnen bis zum naechsten Schritt-Kommentar). */
function stepMarkup(name) {
  const start = html.indexOf(`<div class="step" id="step-${name}">`);
  assert.ok(start >= 0, `Schritt ${name} nicht gefunden`);
  const end = html.indexOf('<!-- Step', start + 1);
  return html.slice(start, end > start ? end : undefined);
}

/* Passwortzeilen: ein Auge neben einem gewoehnlichen Passwort. Mit der Basis
 * 100 % der Schluesselzeile rutschte es auch auf dem Desktop allein unter das
 * Feld. Gemessen wird die Flex-Rechnung bei 1440px, nicht die Klasse: passt
 * die Basis des Feldes plus Knopf in die Zeile, oder bricht sie um? */
test('das Auge einer Passwortzeile bleibt neben dem Feld, auch auf dem Desktop', () => {
  const rows = [...html.matchAll(/<div class="secret-row([^"]*)">([\s\S]*?)<\/div>/g)];
  const pwRows = rows.filter(([, , body]) => /data-eye=/.test(body) && !/data-(copy|gen)/.test(body));
  assert.ok(pwRows.length >= 6, `nur ${pwRows.length} Passwortzeilen gefunden`);
  for (const [, cls, body] of pwRows) {
    const id = body.match(/id="([^"]+)"/)[1];
    assert.match(cls, /\bpw-row\b/, `${id}: Passwortzeile ohne .pw-row - das Auge rutscht unter das Feld`);
  }
  for (const width of [1440, MOBILE_VIEWPORT]) {
    const media = appliesAt(width);
    const wrap = (declared(s => s === '.pw-row' || s === '.secret-row', 'flex-wrap', media) || 'nowrap');
    const flex = flexParts(declared(s => s === '.pw-row input' || s === '.secret-row input', 'flex', media) || '0 1 auto');
    const basisIsFullLine = /^100%$/.test(flex.basis);
    assert.ok(wrap === 'nowrap' || !basisIsFullLine,
      `bei ${width}px bricht die Passwortzeile um (flex-wrap ${wrap}, Basis ${flex.basis})`);
  }
  // Die 64-Zeichen-Schluessel behalten ihre eigene Zeile (Guard oben).
  const fontSize = toPx(declared(s => s === '.pw-row input' || s === '.secret-row input', 'font-size'));
  assert.ok(fontSize >= 16, `Passwortfelder stehen auf ${fontSize}px - iOS zoomt beim Fokus`);
  assert.match(stepMarkup('admin'), /data-eye="adm-conf"/, '"Passwort bestaetigen" hat kein Auge');
});

/* Mindestlaenge: ein Hinweis unter dem Feld statt eines Platzhalters, der beim
 * ersten Zeichen verschwand; beim Tippen schaltet er leise um. Ausgefuehrt:
 * renderPassHint und passLongEnough (NFC wie der Server), die Bindung per
 * aria-describedby, und dass ein Fehler die eigene Beschreibung nicht wegraeumt. */
test('Admin-Passwort: Mindestlaenge als Hinweis, beim Tippen umgeschaltet, per describedby gebunden', () => {
  const admin = stepMarkup('admin');
  const input = admin.match(/<input[^>]*id="adm-pass"[^>]*>/)[0];
  assert.doesNotMatch(input, /placeholder=/, 'die Mindestlaenge steht wieder als Platzhalter im Feld');
  assert.match(input, /aria-describedby="adm-pass-hint"/, 'der Hinweis ist nicht ans Feld gebunden');
  assert.match(input, /data-describedby="adm-pass-hint"/, 'die eigene Beschreibung ist nicht gemerkt');
  const hint = admin.match(/<div class="hint pass-hint" id="adm-pass-hint"[^>]*>([\s\S]*?)<\/div>/);
  assert.ok(hint, 'kein #adm-pass-hint');
  assert.match(hint[0], /aria-live="polite"/);
  assert.match(hint[1], /data-i18n="admin\.passHint"/);
  assert.match(hint[1], /data-i18n="admin\.passOk"[^>]*hidden/);
  for (const locale of SUPPORTED_LOCALES) {
    const a = loadLocale(locale).admin;
    assert.ok(a.passHint && a.passOk, `${locale}: admin.passHint/passOk fehlen`);
    assert.equal(a.passPlaceholder, undefined, `${locale}: admin.passPlaceholder ist tot`);
  }

  const src = html.match(/const ADMIN_PASS_MIN = (\d+);\nconst passLongEnough = [^\n]+/);
  assert.ok(src, 'ADMIN_PASS_MIN/passLongEnough nicht gefunden');
  assert.equal(Number(src[1]), 8, 'die Mindestlaenge weicht vom Server ab (8)');
  const spans = ['short', 'ok'].map(state => fakeEl({ dataset: { passState: state }, hidden: state === 'ok' }));
  const hintEl = fakeEl({ dataset: { state: 'short' }, querySelectorAll: () => spans });
  const pass = { value: '' };
  const { renderPassHint, passLongEnough } = new Function('$', `
    ${src[0]}
    ${fnSource('renderPassHint')}
    return { renderPassHint, passLongEnough };
  `)(id => (id === 'adm-pass' ? pass : hintEl));
  pass.value = 'abc'; renderPassHint();
  assert.equal(hintEl.dataset.state, 'short');
  pass.value = 'abcdefgh'; renderPassHint();
  assert.equal(hintEl.dataset.state, 'ok', 'acht Zeichen reichen dem Hinweis nicht');
  assert.deepEqual(spans.map(s => s.hidden), [true, false], 'der Satz wechselt nicht mit dem Zustand');
  pass.value = 'abcdefg'; renderPassHint();
  assert.deepEqual(spans.map(s => s.hidden), [false, true], 'der Rueckweg unter 8 schaltet nicht zurueck');
  // "u" + kombinierendes Trema: 8 Codeeinheiten roh, 7 nach NFC - der Server sagt nein.
  assert.equal(passLongEnough('abcdefü'), false, 'passLongEnough zaehlt nicht wie der Server (NFC)');
  assert.match(html, /\$\('adm-pass'\)\.addEventListener\('input', renderPassHint\)/, 'der Hinweis ist nicht verdrahtet');
  assert.match(html, /if \(!passLongEnough\(p\)\) \{ fail\('adm-err'/, 'createAdmin prueft anders als der Hinweis');

  // Ein Fehler haengt das Banner VOR die eigene Beschreibung; die Korrektur gibt sie zurueck.
  assert.match(fnSource('fail'), /\[bannerId, el\.dataset\.describedby\]\.filter\(Boolean\)\.join\(' '\)/,
    'fail() ersetzt die eigene Beschreibung, statt das Banner davorzuhaengen');
  const clearFieldInvalid = new Function(`${fnSource('clearFieldInvalid')}; return clearFieldInvalid;`)();
  const field = fakeEl({ dataset: { describedby: 'adm-pass-hint' } });
  field.setAttribute('aria-invalid', 'true');
  field.setAttribute('aria-describedby', 'adm-err adm-pass-hint');
  clearFieldInvalid({ target: field });
  assert.equal(field.getAttribute('aria-describedby'), 'adm-pass-hint', 'die Korrektur raeumt den eigenen Hinweis mit weg');
  assert.match(fnSource('clearInvalid'), /dataset\?\.describedby/, 'clearInvalid raeumt den eigenen Hinweis mit weg');
});

/* Vor dem Admin-Schritt liegt nur der erledigte Docker-Schirm; zurueck hinter
 * den Container-Start fuehrt kein Weg. "Zurueck" fuehrte auf einen Schirm
 * ohne Aufgabe. */
test('der Admin-Schritt hat kein "Zurueck" auf den erledigten Docker-Schirm', () => {
  const flows = literal('FLOWS');
  for (const [name, steps] of Object.entries(flows)) {
    assert.equal(steps[steps.indexOf('admin') - 1], 'docker', `${name}: vor admin liegt nicht mehr docker - Regel pruefen`);
  }
  assert.doesNotMatch(stepMarkup('admin'), /data-back/, 'admin traegt wieder einen Zurueck-Knopf');
});

/* Die Fussleiste des Docker-Schirms trug "Protokoll ausblenden" neben
 * "Erneut versuchen" und brach bei 360px auf Deutsch zweizeilig um. Der
 * Umschalter steht jetzt beim Protokoll und sagt seinen Zustand an. */
test('Docker: der Protokoll-Umschalter steht beim Protokoll, die Fussleiste traegt nur die Primaeraktion', () => {
  const docker = stepMarkup('docker');
  const foot = docker.match(/<div class="card-foot" id="dkr-foot"[^>]*>([\s\S]*?)<\/div>/);
  assert.ok(foot, 'keine Docker-Fussleiste');
  assert.deepEqual([...foot[1].matchAll(/<button[^>]*id="([^"]+)"/g)].map(m => m[1]), ['dkr-next'],
    'in der Docker-Fussleiste steht mehr als die Primaeraktion');
  const toggle = docker.match(/<button[^>]*id="dkr-logs-toggle"[^>]*>/);
  assert.ok(toggle && docker.indexOf(toggle[0]) < docker.indexOf('id="dkr-foot"'), 'der Umschalter steht nicht im Inhalt');
  assert.match(toggle[0], /aria-controls="dkr-log"/);
  assert.match(toggle[0], /aria-expanded="false"/);
  assert.match(html, /\$\('dkr-logs-toggle'\)\.setAttribute\('aria-expanded', String\(open\)\)/, 'der Umschalter sagt seinen Zustand nicht an');
  assert.match(fnSource('restartDocker'), /setAttribute\('aria-expanded', 'false'\)/, 'ein Neustart laesst den Umschalter "offen" stehen');
});

test('die Protokollbox hat den Radius ihrer Nachbarn, keinen 4px-Sonderfall', () => {
  const radius = declared(s => s === '.log-box', 'border-radius');
  assert.equal(radius, declared(s => s === '.warn-banner', 'border-radius'),
    `.log-box hat ${radius}, das Warnbanner darueber einen anderen Radius`);
});

test('die Einfach-Karte zeigt keinen Haken, der wie "schon ausgewaehlt" liest', () => {
  const card = html.match(/<button type="button" class="mode-card is-primary" id="mode-simple">([\s\S]*?)<\/button>/);
  assert.ok(card, 'keine Einfach-Karte');
  const icon = card[1].match(/<span class="mode-card__icon"[^>]*>([\s\S]*?)<\/span>/)[1];
  assert.doesNotMatch(icon, /m5 12 5 5L20 7|M20 6 9 17l-5-5|circle-check/, 'das Icon ist wieder ein Haken');
});

test('Warnbanner tragen ein Lucide-SVG, kein Unicode-Glyph', () => {
  assert.doesNotMatch(html, /&#x26A0;|⚠/, 'U+26A0 steht wieder als Icon im Markup');
  const icons = [...html.matchAll(/<span class="warn-icon"[^>]*>([\s\S]*?)<\/span>/g)];
  assert.ok(icons.length >= 5, `nur ${icons.length} Warn-Icons gefunden`);
  for (const [, inner] of icons) assert.match(inner, /^<svg viewBox="0 0 24 24">/, 'Warn-Icon ohne SVG');
});

test('der Kopf traegt eine Meta-Beschreibung (Lighthouse SEO)', () => {
  const head = html.slice(0, html.indexOf('</head>'));
  const meta = head.match(/<meta name="description" content="([^"]+)">/);
  assert.ok(meta && meta[1].length >= 50, 'keine oder eine leere <meta name="description">');
});

/* Der erste Frame malte bis zum Laden der Uebersetzungen das Desktop-Raster
 * mit Schrittliste, dann sprang die Marke in die Mitte (CLS). Das Markup
 * steht deshalb schon im Layout des Einstiegs. */
test('der erste Frame steht schon im Layout des Einstiegs (keine Verschiebung beim Laden)', () => {
  const shell = html.match(/<div class="([^"]*)" id="shell">/);
  assert.ok(shell, 'kein #shell');
  const solo = literal('SOLO_STEPS');
  const first = literal('FLOWS').advanced[0];
  assert.ok([...solo].includes(first), `SOLO_STEPS ohne ${first} - Regel pruefen`);
  assert.match(shell[1], /\bshell--solo\b/, 'das Markup beginnt im Zwei-Spalten-Raster, renderStep() springt dann auf solo');
});

// ── Runde 2 (Critique 2026-09-29 17:21, zwei P1) ────────────────────────────

/* Echte Zustimmungs-Haken ("Ich habe die .env gesichert") sind keine
 * Einstellung und blieben eine Checkbox. Der Installer hat heute keinen - die
 * Karte ist leer und steht hier, damit ein kuenftiger Haken seinen Grund
 * nennen muss, statt still als nackte Checkbox durchzurutschen. id -> Grund. */
const CONSENT_CHECKBOXES = new Map();

/* Komponenten-Kanon (DESIGN.md, "Boolean in den Einstellungen"): Schalter mit
 * .toggle-Bahn und role="switch", Label links, Zustand rechts - die native
 * Checkbox steht dort unter "Nicht mehr". Geprueft wird die Grammatik von
 * toggleRowHtml({ control: 'switch' }) im Markup (auch Skript-Vorlagen stehen
 * in derselben Datei) und die Masse, Farben und Bewegung der App-Bahn. */
test('jede Boolean-Einstellung ist ein Schalter der App, keine nackte Checkbox', () => {
  const boxes = [...html.matchAll(/<input\b[^>]*\btype="checkbox"[^>]*>/g)].map(m => m[0]);
  assert.ok(boxes.length >= 14, `erwartet mindestens 14 Schalter, gefunden ${boxes.length} - der Scanner greift nicht`);
  assert.doesNotMatch(html, /\.type\s*=\s*['"]checkbox['"]|setAttribute\(\s*['"]type['"]\s*,\s*['"]checkbox['"]/,
    'das Skript baut eine Checkbox am Markup vorbei');
  const naked = boxes.filter(tag => !/\brole="switch"/.test(tag) && !CONSENT_CHECKBOXES.has(tag.match(/\bid="([^"]+)"/)?.[1]));
  assert.deepEqual(naked, [], 'Boolean-Einstellung als nackte Checkbox (role="switch" fehlt, keine begruendete Zustimmung)');

  // Label links, Bahn rechts, Bahn nur Grafik - in jeder Zeile gleich.
  const ROW = /^<span class="toggle-row__label" data-i18n="[\w.]+">[^<]+<\/span><span class="toggle"><input type="checkbox" role="switch" id="[\w-]+"(?: checked)?><span class="toggle__track" aria-hidden="true"><\/span><\/span>$/;
  const rows = [...html.matchAll(/<label class="toggle-row">([\s\S]*?)<\/label>/g)].map(m => m[1]);
  assert.equal(rows.length, boxes.length - CONSENT_CHECKBOXES.size, 'ein Schalter steht nicht in einer label.toggle-row');
  for (const row of rows) assert.match(row, ROW, `Schalterzeile weicht von der Grammatik der App ab: ${row}`);

  // Kein Rest der Kaestchen-Optik.
  const legacy = RULES.filter(r => /input\[type=checkbox\]/.test(r.selector)).map(r => r.selector);
  assert.deepEqual(legacy, [], 'eine Regel stylt noch die native Checkbox');

  const base = m => m === null;
  const val = (sel, prop) => declared(s => s === sel, prop, base);
  // Das Kaestchen ist versteckt, aber fokussierbar (Space schaltet).
  assert.equal(val('.toggle input', 'position'), 'absolute');
  assert.equal(toPx(val('.toggle input', 'width')), 1);
  assert.equal(val('.toggle input', 'display'), null, 'display am Kaestchen nimmt es aus dem Fokus-Weg');
  assert.equal(val('.toggle input', 'visibility'), null);
  // Rechts, in RTL gespiegelt: logische Eigenschaft, kein margin-left.
  assert.equal(val('.toggle', 'margin-inline-start'), 'auto', 'der Schalter steht nicht am Zeilenende');
  assert.equal(val('.toggle-row__label', 'flex'), '1');
  // Masse der App (layout.css .toggle__track): 44x26, Knopf 20px, Weg 18px.
  assert.equal(toPx(val('.toggle__track', 'width')), 44);
  assert.equal(toPx(val('.toggle__track', 'height')), 26);
  assert.equal(val('.toggle__track', 'border-radius'), 'var(--radius-full)');
  assert.equal(toPx(val('.toggle__track::after', 'width')), 20);
  assert.equal(val('.toggle__track::after', 'inset-inline-start'), '3px', 'der Knopf spiegelt sich in RTL nicht mit');
  assert.equal(val('.toggle input:checked + .toggle__track::after', 'transform'), 'translateX(18px)');
  assert.equal(val('html[dir="rtl"] .toggle input:checked + .toggle__track::after', 'transform'), 'translateX(-18px)',
    'in RTL laeuft der Knopf aus der Bahn');
  // Farben aus Tokens: aus = --color-switch-off (#1572), an = Akzent, Knopf = Flaeche.
  assert.equal(val('.toggle__track', 'background-color'), 'var(--color-switch-off)');
  assert.equal(val('.toggle input:checked + .toggle__track', 'background-color'), 'var(--color-accent)');
  assert.equal(val('.toggle__track::after', 'background'), 'var(--color-surface)');
  // Bewegung wie die App: aus ruhig, an federnd.
  assert.equal(val('.toggle__track::after', 'transition'), 'transform var(--duration-sm) var(--ease-out)');
  assert.equal(val('.toggle input:checked + .toggle__track::after', 'transition'), 'transform var(--duration-xl) var(--ease-glass)');
  // Fokusring an der Zeile, nur bei Tastaturfokus; gesperrt gedaempft.
  assert.match(val('label.toggle-row:has(input:focus-visible)', 'box-shadow') ?? '', /var\(--color-accent\)/,
    'der Schalter zeigt keinen Tastaturfokus');
  assert.ok(Number(val('.toggle input:disabled + .toggle__track', 'opacity')) < 1, 'ein gesperrter Schalter sieht aus wie ein freier');
  // Jedes neue Token steht im Fallback, --color-switch-off in beiden Themes.
  for (const name of ['--color-switch-off', '--ease-glass', '--glass-inset-thumb']) {
    assert.ok(ROOT_VARS.has(name), `${name} fehlt im Inline-Fallback`);
  }
  const dark = html.slice(html.indexOf('@media (prefers-color-scheme: dark)'), html.indexOf('</style>'));
  assert.match(dark, /--color-switch-off:\s*#/, '--color-switch-off fehlt im Dunkel-Fallback');
});

/* Der Docker-Schritt hatte in der Liste keinen Eintrag: waehrend des laengsten
 * Wartens stand sie ohne aktuellen Schritt und ohne aria-current da. Jetzt ein
 * unnummerierter Eintrag zwischen Pruefung/Einfach-Start und Admin, kein Knopf,
 * mit dem Ausgang des Starts. renderStepNav wird AUSGEFUEHRT. */
test('Docker in der Schrittliste: eigener Eintrag ohne Nummer, genau ein aria-current, Ausgang sichtbar', () => {
  const FLOWS = literal('FLOWS');
  const UNNUMBERED = literal('UNNUMBERED');
  assert.ok(UNNUMBERED.has('docker'), 'der Docker-Schritt traegt eine Nummer - Regel pruefen');

  const li = html.match(/<li class="steps-nav__item" data-nav-step="docker"[^>]*>(.*?)<\/li>/);
  assert.ok(li, 'kein Listeneintrag fuer den Docker-Schritt');
  assert.doesNotMatch(li[1], /<button|data-goto/, 'zurueck auf den Docker-Schirm fuehrt nichts - kein Knopf');
  assert.match(li[1], /data-i18n="docker\.navLabel"/);
  assert.match(li[1], /class="vh steps-nav__failed" data-i18n="docker\.stepFailed"/, 'der Fehler hat keinen Text fuer Screenreader');
  const at = name => html.indexOf(`data-nav-step="${name}"`);
  assert.ok(at('simple') < at('docker') && at('review') < at('docker') && at('docker') < at('admin'),
    'der Eintrag steht nicht zwischen Pruefung/Einfach-Start und Admin');
  for (const locale of SUPPORTED_LOCALES) {
    assert.ok(loadLocale(locale).docker?.navLabel, `${locale}: docker.navLabel fehlt`);
  }

  const names = ['simple', 'config', 'secrets', 'weather', 'calendar', 'email', 'storage', 'advanced', 'review', 'docker', 'admin'];
  const run = (flow, currentStep, dockerOutcome) => {
    const items = navFakes(names);
    new Function('flow', 'currentStep', 'UNNUMBERED', 'dockerOutcome', 'document', `${fnSource('renderStepNav')}; renderStepNav();`)(
      flow, currentStep, UNNUMBERED, dockerOutcome, { querySelectorAll: () => items });
    return Object.fromEntries(items.map(i => [i.name, i]));
  };
  const currentOf = r => Object.values(r).filter(i => !i.hidden && i.button.attrs['aria-current'] === 'step').map(i => i.name);

  for (const flow of [FLOWS.simple, FLOWS.advanced]) {
    const d = flow.indexOf('docker');
    let r = run(flow, d - 1, null);
    assert.equal(r.docker.hidden, false, 'der Docker-Eintrag fehlt im Weg');
    assert.equal(r.docker.dataset.state, 'upcoming');
    assert.equal(r.docker.dataset.run, undefined);
    assert.equal(r.docker.mark.textContent, '', 'der Docker-Eintrag traegt eine Ziffer');
    for (const [outcome, shown] of [[null, 'running'], ['running', 'ok'], ['failed', 'failed']]) {
      r = run(flow, d, outcome);
      assert.deepEqual(currentOf(r), ['docker'], `waehrend Docker (${shown}) traegt nicht genau der Docker-Eintrag aria-current`);
      assert.equal(r.docker.dataset.state, 'current');
      assert.equal(r.docker.dataset.run, shown, `der Ausgang ${shown} erscheint nicht in der Liste`);
      assert.equal(r.docker.button.disabled, true, 'der Docker-Eintrag wurde anklickbar');
    }
    r = run(flow, d + 1, 'running');
    assert.equal(r.docker.dataset.state, 'done');
    assert.equal(r.docker.dataset.run, undefined, 'der Laufzustand bleibt nach dem Docker-Schirm stehen');
    assert.deepEqual(currentOf(r), ['admin']);
    // Die Nummern bleiben die des Zaehlers: Admin ist der letzte nummerierte.
    assert.equal(r.admin.mark.textContent, String(flow.filter(s => !UNNUMBERED.has(s)).length));
  }

  // Jeder Wechsel des Docker-Zustands zieht die Liste nach.
  assert.match(fnSource('renderPhases'), /renderStepNav\(\)/, 'Erfolg/Fehler erreichen die Schrittliste nicht');
  // Zeichen wie die Checkliste daneben: Bogen (reduced-motion: Puls), Haken, Kreuz.
  const sel = s => r => r === s;
  assert.match(declared(sel('.steps-nav__item[data-run="running"] .steps-nav__mark::after'), 'animation') ?? '', /^phase-spin /);
  assert.match(declared(sel('.steps-nav__item[data-run="running"] .steps-nav__mark::after'), 'animation',
    m => m !== null && /prefers-reduced-motion/.test(m)) ?? '', /^phase-pulse /);
  assert.equal(declared(sel('.steps-nav__item[data-run="failed"] .steps-nav__mark::before'), 'background'), 'var(--color-danger)');
  assert.ok(RULES.some(r => r.selector === '.steps-nav__item[data-run="ok"] .steps-nav__mark::before'), 'Erfolg zeigt keinen Haken');
  assert.equal(declared(sel('.steps-nav__item:not([data-run="failed"]) .steps-nav__failed'), 'display'), 'none',
    '"fehlgeschlagen" steht auch ohne Fehler im Namen');
});

/* Balken und Zaehler rechneten mit verschiedenen Nennern: der Balken durch alle
 * Schirme, der Zaehler durch die nummerierten - "Schritt 1 von 9" bei 9 %,
 * "2 von 2" bei 75 %. Jetzt EINE Funktion (stepPosition) fuer beide; der
 * Docker-Schirm liegt zwischen seinen Nachbarn. Beide Wege werden AUSGEFUEHRT. */
test('Balken und Zaehler folgen derselben Rechnung, der Docker-Schirm liegt zwischen seinen Nachbarn', () => {
  const FLOWS = literal('FLOWS');
  const UNNUMBERED = literal('UNNUMBERED');
  assert.match(fnSource('setProgress'), /stepPosition\(/, 'der Balken rechnet an stepPosition vorbei');
  assert.match(fnSource('applyStepCounters'), /stepPosition\(/, 'der Zaehler rechnet an stepPosition vorbei');
  assert.match(fnSource('showStep'), /setProgress\(n\)/);

  for (const flow of [FLOWS.simple, FLOWS.advanced]) {
    const tags = {};
    const prog = { style: {} };
    const h = new Function('flow', 'UNNUMBERED', 'document', '$', 't', `
      ${fnSource('stepPosition')}
      ${fnSource('applyStepCounters')}
      ${fnSource('setProgress')}
      return { applyStepCounters, setProgress };
    `)(flow, UNNUMBERED,
      { querySelector: q => (tags[q.match(/#step-(\w+)/)[1]] ??= { textContent: '' }) },
      () => prog, (k, p) => `${p.n}/${p.total}`);
    h.applyStepCounters();
    const bar = flow.map((_, i) => { h.setProgress(i); return Number(prog.style.transform.match(/^scaleX\(([\d.]+)\)$/)[1]); });
    const numbered = flow.filter(s => !UNNUMBERED.has(s));

    flow.forEach((name, i) => {
      if (UNNUMBERED.has(name)) {
        assert.equal(tags[name], undefined, `${name} bekommt einen Zaehler`);
        return;
      }
      const [n, total] = tags[name].textContent.split('/').map(Number);
      assert.equal(total, numbered.length);
      assert.ok(Math.abs(bar[i] - n / total) < 1e-9, `${name}: Zaehler ${n}/${total}, Balken ${bar[i]} - verschiedene Rechnung`);
    });
    assert.equal(bar[0], 0, 'der Einstieg zeigt schon Fortschritt');
    assert.equal(bar[flow.length - 1], 1, 'der Abschluss fuellt den Balken nicht');
    const d = flow.indexOf('docker');
    assert.ok(bar[d - 1] < bar[d] && bar[d] < bar[d + 1],
      `der Balken steht waehrend Docker nicht zwischen den Nachbarn (${bar[d - 1]} / ${bar[d]} / ${bar[d + 1]})`);
    for (let i = 1; i < flow.length; i++) assert.ok(bar[i] >= bar[i - 1], `der Balken laeuft bei ${flow[i]} zurueck`);
  }
});
