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
  const row = html.match(/<div[^>]*class="status-row"[^>]*>/);
  assert.ok(row, 'status-row nicht gefunden');
  assert.match(row[0], /role="status"/, 'status-row braucht role="status"');
  assert.match(row[0], /aria-live="polite"/, 'status-row braucht aria-live="polite"');
});

test('der Spinner ist für Screenreader ausgeblendet', () => {
  const spinner = html.match(/<div[^>]*class="spinner"[^>]*>/);
  assert.ok(spinner, 'spinner nicht gefunden');
  assert.match(spinner[0], /aria-hidden="true"/, 'Spinner braucht aria-hidden="true"');
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

test('die nummerierten *.tag-Schlüssel sind entfernt, advanced.tag bleibt', () => {
  for (const locale of SUPPORTED_LOCALES) {
    const data = loadLocale(locale);
    for (const step of ['config', 'secrets', 'weather', 'calendar', 'review', 'docker', 'admin']) {
      assert.equal(data[step]?.tag, undefined, `${locale}: ${step}.tag sollte entfernt sein`);
    }
    assert.ok(data.advanced?.tag, `${locale}: advanced.tag muss erhalten bleiben`);
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

test('Bedienelemente erfüllen die Zielgrössen (44px Höhe, 24px Kästchen)', () => {
  const media = appliesAt(MOBILE_VIEWPORT);
  const buttonHeight = toPx(declared(sel => sel === '.btn', 'min-height', media));
  assert.ok(buttonHeight >= 44, `.btn ist ${buttonHeight}px hoch, 44px sind das Touch-Minimum`);

  const selectHeight = toPx(declared(sel => /(^|,)\s*select$/.test(sel) || sel === 'select', 'min-height', media));
  assert.ok(selectHeight >= 44, `select ist ${selectHeight}px hoch, 44px sind das Touch-Minimum`);

  // WCAG 2.2 SC 2.5.8 verlangt 24x24 CSS-Pixel, in jeder Breite. Die Kästchen
  // waren 13x13 neben einem 16px hohen Label.
  for (const prop of ['inline-size', 'block-size']) {
    const size = toPx(declared(sel => sel === 'input[type=checkbox]', prop));
    assert.ok(size >= 24, `Checkbox-${prop} ist ${size}px, WCAG 2.2 verlangt 24px`);
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

/* Die Schrittliste zeigt genau die nummerierten Schritte beider Wege. Die
 * Funktion wird AUSGEFUEHRT: erledigt heisst anklickbar, aktuell heisst
 * aria-current="step", kommend heisst gesperrt, und ab dem Container-Start ist
 * kein Weg zurueck mehr offen (die .env steht dann schon). */
test('die Schrittliste folgt dem Weg: erledigt anklickbar, aktuell markiert, kommend gesperrt', () => {
  const FLOWS = literal('FLOWS');
  const UNNUMBERED = literal('UNNUMBERED');
  const numbered = new Set([...FLOWS.simple, ...FLOWS.advanced].filter(s => !UNNUMBERED.has(s)));
  const navItems = [...html.matchAll(/<li class="steps-nav__item" data-nav-step="([a-z]+)"[^>]*>(.*?)<\/li>/g)];
  assert.deepEqual(new Set(navItems.map(m => m[1])), numbered, 'die Liste fuehrt andere Schritte als die Wege');
  for (const m of navItems) {
    assert.match(m[2], new RegExp(`<button type="button" class="steps-nav__link" data-goto="${m[1]}"`),
      `Eintrag ${m[1]} ist kein Knopf mit data-goto`);
  }
  assert.match(html, /<nav class="steps-nav"[^>]*aria-label=[^>]*>\s*<ol/, 'die Liste ist kein <nav> mit <ol>');
  assert.match(fnSource('showStep'), /renderStepNav\(\)/, 'showStep aktualisiert die Liste nicht');

  const make = () => [...numbered].map(name => {
    const button = {
      disabled: true, attrs: {},
      setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; },
    };
    const mark = { textContent: '' };
    return {
      name, button, mark, hidden: true, dataset: { navStep: name },
      querySelector: sel => (sel === 'button' ? button : mark),
    };
  });
  const run = (flow, currentStep) => {
    const items = make();
    const document = { querySelectorAll: () => items };
    new Function('flow', 'currentStep', 'UNNUMBERED', 'document', `${fnSource('renderStepNav')}; renderStepNav();`)(
      flow, currentStep, UNNUMBERED, document);
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
  assert.equal(unset.textContent, 'review.weather, review.google, review.apple, review.outlook, review.email',
    'die Zeile "Nicht eingerichtet" nennt nicht alles, was fehlt');
  for (const id of ['rv-weather', 'rv-google', 'rv-apple', 'rv-outlook', 'rv-email']) {
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
 * die restliche Zeile nahm keinen Tipp an. Geprueft wird die WIRKUNG: jedes
 * Kaestchen sitzt direkt in einem Label direkt in einem .field (sonst greift die
 * Regel nicht), das Feld gibt sein Polster ab (sonst endet das Label vor der
 * Zeilenkante), und das Label ist mit Polster und Kaestchen mindestens 44px
 * hoch. Ein neuer Schalter ohne diese Form faellt ueber die Markup-Pruefung auf. */
test('jede Schalterzeile ist als ganze Zeile tippbar, mindestens 44px hoch', () => {
  const boxes = [...html.matchAll(/<input type="checkbox"[^>]*>/g)];
  assert.ok(boxes.length >= 10, `erwartet mindestens zehn Schalter, gefunden ${boxes.length}`);
  const wrapped = [...html.matchAll(/<div class="field">\s*<label><input type="checkbox"[^>]*>/g)];
  assert.equal(wrapped.length, boxes.length,
    'ein Schalter sitzt nicht direkt in <div class="field"><label> - die Zeilenregel greift fuer ihn nicht');

  const phone = appliesAt(PHONE);
  const fieldSel = sel => /\.field:has\(\s*>\s*label\s*>\s*input\[type=checkbox\]\s*\)$/.test(sel);
  const labelSel = sel => /\.field\s*>\s*label:has\(\s*>\s*input\[type=checkbox\]\s*\)$/.test(sel);
  // Ohne eigene Regel gilt fuer das Feld das Zeilenpolster aller Felder.
  const rowField = sel => sel === '.inset-group .field' || fieldSel(sel);
  for (const side of ['top', 'right', 'bottom', 'left']) {
    const pad = boxSide(rowField, 'padding', side, phone) ?? 0;
    assert.equal(pad, 0, `die Schalterzeile behaelt ${pad}px Polster ${side} - dort nimmt sie keinen Tipp an`);
  }
  const box = toPx(declared(sel => sel === 'input[type=checkbox]', 'block-size')) ?? 0;
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
