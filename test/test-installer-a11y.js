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
  const available = cardContentWidth(viewport);
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
  const voll = cardContentWidth(MOBILE_VIEWPORT);
  assert.ok(breite >= voll * 0.95,
    `#sec-db misst bei ${MOBILE_VIEWPORT}px nur ${breite.toFixed(0)}px von ${voll.toFixed(0)}px verfügbarer Breite. `
    + 'Ein 64-Zeichen-Schlüssel gehört auf eine eigene Zeile, die Buttons darunter.');
});

/* Die Pruefseite traegt unzerbrechliche Maschinenwerte (BASE_URL mit DDNS-Host,
 * Nextcloud-WebDAV-URL) in einem Grid mit fester Schluesselspalte. Gemessen
 * 2026-08-31: 534px body-scrollWidth bei 375px Viewport - die GANZE Seite
 * scrollte seitlich, inklusive Sticky-Footer (WCAG 1.4.10), ausgerechnet auf
 * dem Kontrollschirm vor dem irreversiblen Klick. Die damalige Suite mass nur
 * die .secret-row; dieselbe Luecke gab es hier ohne Guard.
 *
 * Modelliert wird die WIRKUNG, nicht die Regel: wie breit wird die Seite mit
 * einem 500px-Wert in der Wertspalte? `overflow-wrap: anywhere` senkt dessen
 * min-content auf ~0 (anders als break-word, das die Messung nicht aendert),
 * minmax(0, ...) erlaubt der Spur, unter min-content zu schrumpfen. */
function reviewGridNeed(viewport, unbreakable) {
  const media = appliesAt(viewport);
  const columns = declared(sel => sel === '.review-grid', 'grid-template-columns', media) || '160px 1fr';
  const tracks = columns.match(/minmax\([^)]*\)|\S+/g) || [];
  const gapParts = (declared(sel => sel === '.review-grid', 'gap', media) || '0').trim().split(/\s+/);
  const gapX = toPx(gapParts[1] ?? gapParts[0]) ?? 0;

  const trackMin = track => {
    const m = track.match(/minmax\(\s*([^,]+),/);
    if (m) return toPx(m[1]) ?? 0;
    if (/fr$/.test(track)) return null;   // auto-Minimum: der Inhalt bestimmt
    return toPx(track) ?? 0;
  };
  const keyMin = trackMin(tracks[0] ?? '160px') ?? 0;

  const wrap = (declared(sel => sel === '.review-grid > :not(.review-key)', 'overflow-wrap', media) || 'normal').trim();
  // Nur `anywhere` geht in die min-content-Rechnung ein (CSS Text 3, §5.2).
  const valueContentMin = wrap === 'anywhere' ? 0 : unbreakable;
  const valueTrackMin = trackMin(tracks[1] ?? '1fr');
  // Spur mindestens so breit wie ihr Minimum; Inhalt, der nicht umbricht,
  // blutet ueber die Spur hinaus und verbreitert die Seite trotzdem.
  return keyMin + gapX + Math.max(valueTrackMin ?? valueContentMin, valueContentMin);
}

test('ein unzerbrechlicher Wert verbreitert die Pruefseite nicht (WCAG 1.4.10)', () => {
  const need = reviewGridNeed(MOBILE_VIEWPORT, 500);
  const available = cardContentWidth(MOBILE_VIEWPORT);
  assert.ok(need <= available,
    `Das Review-Grid braucht mit einem 500px-Wert ${need.toFixed(0)}px von ${available.toFixed(0)}px `
    + 'verfuegbarer Breite. Wertspalte minmax(0, ...) plus overflow-wrap: anywhere '
    + 'auf den Wertzellen halten lange URLs in der Karte.');
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
