/**
 * Modul: Test-Infrastruktur - Farbrechnung der Dokument-Guards
 * Zweck: die reine Rechnung hinter Sonde 2 (test-document-guards.js, "jeder
 *        sichtbare Text haelt WCAG AA auf seinem KOMPONIERTEN Untergrund"):
 *        Farben parsen, komponieren, Kontrast und den schlechtesten Untergrund
 *        einer Ebenenkette bestimmen. Kein Browser, kein puppeteer - deshalb
 *        laesst sie sich in `npm test` pruefen (test-text-contrast.js), waehrend
 *        die Sonde selbst nur unter `test:document-guards` laeuft.
 *        document-guards-harness.js reicht die Farbfunktionen weiter, damit
 *        bestehende Importe unveraendert bleiben.
 */

/** @typedef {[number, number, number, number]} Rgba r,g,b in 0..255, alpha 0..1 */
/** @typedef {number[]} Rgb deckende Farbe, r,g,b in 0..255 */
/** @typedef {{ bg: string, image: string }} Layer */
/** @typedef {{ color: string, size: number, weight: number, layers: Layer[] }} TextSample */

/**
 * Farb-Parser fuer BEIDE Notationen, die Chromium liefert.
 *
 * FALLE, die das Architektur-Audit selbst getroffen hat: `color-mix()` rendert
 * als `color(srgb 0.4 0.2 0.8 / 0.16)`, nicht als `rgba()`. Ein naiver
 * rgba-Parser meldet daraufhin Fehltreffer - im ersten Auditlauf zwei falsche
 * AA-Befunde. Wer hier etwas ergaenzt, ergaenzt beide Notationen.
 *
 * @param {string | undefined | null} value
 * @returns {Rgba} r,g,b in 0..255, alpha 0..1
 */
export function parseColor(value) {
  if (!value) return [0, 0, 0, 0];
  const srgbMatch = value.match(/^color\(srgb\s+([^)]+)\)$/i);
  if (srgbMatch) {
    const parts = srgbMatch[1].split('/');
    const rgb = parts[0].trim().split(/\s+/).map(Number);
    const alpha = parts[1] === undefined ? 1 : parseFloat(parts[1]);
    return [rgb[0] * 255, rgb[1] * 255, rgb[2] * 255, Number.isFinite(alpha) ? alpha : 1];
  }
  const rgbMatch = value.match(/^rgba?\(([^)]+)\)$/i);
  if (rgbMatch) {
    const parts = rgbMatch[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return [parts[0], parts[1], parts[2], parts[3] === undefined ? 1 : parts[3]];
  }
  if (value === 'transparent') return [0, 0, 0, 0];
  return [0, 0, 0, 1];
}

/** @param {number} c */
const channel = (c) => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

/** @param {number[]} rgb */
export function luminance([r, g, b]) {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/**
 * @param {number[]} fg
 * @param {number[]} bg
 */
export function contrastRatio(fg, bg) {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/**
 * Alpha-Komposition eines Vordergrunds auf einen deckenden Untergrund.
 * @param {number[]} color r,g,b,a
 * @param {number[]} base deckend
 * @returns {Rgb}
 */
export function composite([r, g, b, a], base) {
  if (a >= 1) return [r, g, b];
  return [
    r * a + base[0] * (1 - a),
    g * a + base[1] * (1 - a),
    b * a + base[2] * (1 - a),
  ];
}

/** @param {number[]} rgb */
export function toHex([r, g, b]) {
  /** @param {number} v */
  const h = (v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`.toUpperCase();
}

/**
 * Zerlegt einen `background-image`-Wert in seine Farbstops.
 * @param {string | undefined} image
 * @returns {null|string[]} null, wenn ein echtes Bild im Spiel ist (dann ist
 *          der Untergrund nicht rechenbar), sonst die Stops eines Verlaufs.
 */
export function gradientStops(image) {
  if (!image || image === 'none') return [];
  if (/url\(/i.test(image)) return null;
  return [...image.matchAll(/color\(srgb[^)]*\)|rgba?\([^)]*\)|#[0-9a-f]{3,8}/gi)].map((m) => m[0]);
}

/**
 * Komponiert den effektiven Untergrund eines Textelements und liefert den
 * SCHLECHTESTEN Kontrast, den er dort haben kann.
 *
 * WARUM EIN SCHLECHTESTER FALL UND KEIN EINZELWERT: `.app-shell` traegt
 * radiale Verlaeufe ueber dem Seitengrund. Eine Sonde, die bei einem Verlauf
 * aufgibt, hoert genau dort auf zu messen, wo die meisten Texte stehen - rund
 * dreissig Elemente je Route, also die Haelfte des Dokuments. Deshalb fuehrt
 * die Rechnung eine Menge moeglicher Untergruende (Kandidaten) und es zaehlt
 * der unguenstigste.
 *
 * EBENENGERECHT: von der ersten deckenden Ebene nach oben malt jede Ebene erst
 * ihre `background-color`, dann ihre Verlaufsstops (background-image liegt
 * ueber der Farbe DERSELBEN Ebene) auf alle bisherigen Kandidaten; jeder Stop
 * ergibt neben dem Untergrund ohne Stop einen weiteren Kandidaten. Hoehere
 * Ebenen daempfen danach alle Kandidaten. Bis 2026-11 wurden die Stops auf den
 * FERTIGEN Untergrund gerechnet, also auch ueber Ebenen, die real ueber dem
 * Verlauf liegen: eine Karte mit 86 % Deckung ueber `.app-shell` liess den
 * Verlauf rechnerisch voll durch (4.33:1 statt 5.70:1), und jeder 429 waehrend
 * der Sonde machte sie rot.
 *
 * Die Naeherung bleibt konservativ: jeder Stop wird an seiner hoechsten
 * Deckung genommen, der Untergrund ohne Stop bleibt Kandidat - sie urteilt nie
 * milder als ein einzelner real anliegender Stop. BEKANNTE GRENZEN: Stops
 * mehrerer Verlaeufe derselben Ebene werden nicht uebereinander gestapelt, und
 * `backdrop-filter` (z. B. `saturate(2)` am Glas) rechnet die Sonde nicht.
 *
 * @param {TextSample} sample
 * @param {number[]} pageBase deckender Seitengrund
 * @returns {null|{ratio: number, min: number, bg: number[], fg: number[]}}
 *          null nur bei einem echten Bild (`url(...)`).
 */
export function evaluateSample(sample, pageBase) {
  // Erste deckende Ebene suchen; alles darunter ist wirkungslos.
  let opaqueAt = sample.layers.length - 1;
  for (let i = 0; i < sample.layers.length; i += 1) {
    if (parseColor(sample.layers[i].bg)[3] >= 1) {
      opaqueAt = i;
      break;
    }
  }
  /** @type {Map<string, number[]>} */
  let candidates = new Map();
  /** @param {Map<string, number[]>} into @param {number[]} color */
  const add = (into, color) => {
    const key = color.map((v) => v.toFixed(2)).join(',');
    if (!into.has(key)) into.set(key, color);
  };
  add(candidates, pageBase);
  for (let i = opaqueAt; i >= 0; i -= 1) {
    const layer = parseColor(sample.layers[i].bg);
    if (layer[3] > 0) {
      /** @type {Map<string, number[]>} */
      const next = new Map();
      for (const under of candidates.values()) add(next, composite(layer, under));
      candidates = next;
    }
    const stops = gradientStops(sample.layers[i].image);
    if (stops === null) return null;
    if (stops.length) {
      /** @type {Map<string, number[]>} */
      const next = new Map(candidates);
      for (const stop of stops) {
        const color = parseColor(stop);
        if (color[3] <= 0) continue;
        for (const under of candidates.values()) add(next, composite(color, under));
      }
      candidates = next;
    }
  }

  const fgRaw = parseColor(sample.color);
  const large = sample.size >= 24 || (sample.size >= 18.66 && sample.weight >= 700);
  const min = large ? 3 : 4.5;

  /** @type {{ratio: number, bg: number[], fg: number[]}} */
  let worst = { ratio: Infinity, bg: pageBase, fg: composite(fgRaw, pageBase) };
  for (const under of candidates.values()) {
    const fg = composite(fgRaw, under);
    const ratio = contrastRatio(fg, under);
    if (ratio < worst.ratio) worst = { ratio, bg: under, fg };
  }
  return { ...worst, min };
}
