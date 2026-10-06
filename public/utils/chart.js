/**
 * Geteilte Geometrie einer Auswertungsfläche
 * Zweck: EIN Koordinatensystem für jede Zeitreihe mit Werteachse
 *
 * EXTRAHIERT, NICHT ENTWORFEN. Diese Geometrie stand in health.js und löste den
 * Fall dort für drei Charts (Vitalwerte, Laborwerte, Aktivität) - mit einer
 * Begründung, die für die ganze App gilt: sie sollen „als EIN lesbares System
 * wirken statt als drei verschiedene Kurven-Kästen". Genau dieselbe Aufgabe
 * stellten sich der Budget-Trend und das Abo-Flächenchart, und beide haben sie
 * je eigen und je falscher beantwortet:
 *
 *   health.js          role="img", proportional      Achse IM SVG (5 Ticks)
 *   budget-stats.js    preserveAspectRatio="none"    Achse als Spans daneben
 *   subscriptions.js   preserveAspectRatio="none"    Achse als DIV daneben
 *
 * Beide Fehler hängen zusammen: ohne feste Ränder gibt es keinen Platz für eine
 * Achse im Bild, also wandert sie nach draußen - und dort verschiebt sie sich
 * gegen ihre eigenen Gitterlinien, sobald das Diagramm skaliert. `PAD_L` ist die
 * Antwort auf beides.
 *
 * WAS HIER NICHT HINEINGEHÖRT: die Formatierung eines Achsenwerts. Ob an der
 * Y-Achse „8:24", „125" oder „1.240,00 €" steht, weiß nur das Modul - deshalb
 * nimmt `chartGridMarkup` einen `formatTick`-Callback statt einer Metrik.
 * Geometrie ist geteilt, Vokabular nicht.
 *
 * NICHT FÜR: Anteilsbalken (die brauchen eine Bahn, keine Achse - siehe die
 * vier Zusagen in DESIGN.md) und nicht für den Verteilungs-Donut. Das sind
 * andere Formen, keine anderen Fassungen dieser Form.
 */

import { esc } from '/utils/html.js';

/**
 * Der linke Gutter trägt die Y-Wert-Labels, der untere die X-Labels.
 *
 * PAD_L IST 56, NICHT 40. Bei 40 trug er die Vokabeln der Gesundheit („125",
 * „8:24") und schnitt die des Budgets ab: „5.050,00 €" stand als „3,00 €" da,
 * weil die linke Hälfte aus dem Bild lief. Gezeigt hat das ein Screenshot, nicht
 * die Messung - `getComputedStyle` kennt keinen abgeschnittenen SVG-Text. 56
 * trägt beide Vokabulare; die Kurve verliert dafür 16 von 548 Einheiten. Das ist
 * der Preis dafür, EINE Geometrie zu haben statt einer pro Modul.
 * 600x200 ist ein Seitenverhältnis, kein Pixelmaß: das SVG skaliert
 * proportional (kein `preserveAspectRatio="none"`), die Strichstärken hält
 * `vector-effect="non-scaling-stroke"` konstant, die Achsenschrift die Klasse
 * `.chart` am SVG (panel.css) - jedes SVG dieser Geometrie traegt sie.
 */
export const CHART = Object.freeze({ W: 600, H: 200, PAD_L: 56, PAD_R: 12, PAD_T: 14, PAD_B: 26 });

/** Abstand zwischen dem rechten Ende eines Y-Werts und der Plotkante, in
 *  viewBox-Einheiten. Die Werte stehen rechtsbuendig bei PAD_L - AXIS_GAP;
 *  `.chart-host` (panel.css) rechnet mit derselben Zahl, test-chart-gutter.js
 *  haelt beide Stellen gleich. */
export const AXIS_GAP = 6;

/** Die vier Plotgrenzen im viewBox-Koordinatensystem.
 *  `geo` ist eine andere Flaeche mit DENSELBEN Raendern (`{ ...CHART, H }`),
 *  etwa das hoehere Diagramm im mobilen Vitalwerte-Blatt (health.js). */
export function chartScales(geo = CHART) {
  const { W, H, PAD_L, PAD_R, PAD_T, PAD_B } = geo;
  return { left: PAD_L, right: W - PAD_R, top: PAD_T, bottom: H - PAD_B };
}

/**
 * Horizontale Gitterlinien (Voreinstellung fuenf) mit Y-Wert-Beschriftung links - eine
 * echte Werteachse statt zweier frei schwebender Min-/Max-Zahlen.
 *
 * @param {number} min  unterster Wert der Skala
 * @param {number} max  oberster Wert der Skala
 * @param {(value: number, wholeTicks: boolean) => string} formatTick
 *        Formatiert einen Achsenwert. `wholeTicks` meldet, dass die Spanne groß
 *        genug für ganzzahlige Labels ist: bei Spannen ab 4 Einheiten sind
 *        Nachkommastellen Pseudo-Präzision („125,9 mmHg", Audit A2-21), bei
 *        kleinen Spannen (Laborwerte 0,5-1,2) sind sie die eigentliche Auskunft.
 * @param {number} [steps=4]  Zahl der Schritte, `niceDomain().steps`
 */
export function chartGridMarkup(min, max, formatTick, geo = CHART, steps = 4) {
  const { W, PAD_L, PAD_R } = geo;
  const { top, bottom } = chartScales(geo);
  const out = [];
  const step = (max - min) / steps;
  // Eine runde Skala (niceDomain) zeigt Nachkommastellen genau dann, wenn ihr
  // Schritt oder ihre Unterkante welche hat - 2,5 bleibt 2,5 und wird nicht 3.
  // Eine freie Skala (feste Grenzen) behaelt die Spannen-Regel.
  const whole = (v) => Math.abs(v - Math.round(v)) < 1e-9;
  const wholeTicks = isNiceStep(step) ? whole(step) && whole(min) : (max - min) >= 4;
  for (let k = 0; k <= steps; k++) {
    const gy = top + (k * (bottom - top)) / steps;
    const val = max - k * step;
    out.push(`<line class="chart__grid" x1="${PAD_L}" y1="${gy.toFixed(1)}" x2="${W - PAD_R}" y2="${gy.toFixed(1)}" vector-effect="non-scaling-stroke" />`);
    // y = die Gitterlinie selbst: `.chart__axis--y` zentriert per
    // dominant-baseline. Der fruehere Versatz (+3.5 Einheiten) passte nur zu
    // einer Schrift, die mit dem Diagramm skaliert (panel.css, `.chart`).
    // DER UNTERSTE WERT SITZT AUF SEINER LINIE, NICHT MITTIG DARAUF (Critique
    // 2026-10-05, R16). Die Achsenschrift ist fest 12px, die Geometrie skaliert:
    // bei 358px Breite ist PAD_B nur noch 14px hoch, und "0 €" stand mittig auf
    // der Grundlinie halb in der Zeile der X-Beschriftung - 3px neben
    // "01.10.2026", gelesen als ein Wort. Um eine halbe Schrifthoehe gehoben
    // (`dy` in em, also in Bildschirmpixeln) steht er ueber der Linie, das
    // Datum darunter. Gilt fuer jedes Diagramm dieser Geometrie (Budget-Verlauf
    // und die Kurven der Gesundheit).
    const base = k === steps ? ' dy="-0.6em"' : '';
    out.push(`<text x="${PAD_L - AXIS_GAP}" y="${gy.toFixed(1)}" class="chart__axis chart__axis--y" text-anchor="end"${base}>${esc(formatTick(val, wholeTicks))}</text>`);
  }
  return out.join('');
}

/**
 * DER GUTTER FOLGT DEM BREITESTEN ACHSENWERT (#1607).
 *
 * `--chart-inset` (panel.css) haelt dem Gutter eine Mindestbreite frei, und die
 * war eine feste Zahl: var(--space-16), bemessen an "5.550 €". Die Achsenschrift
 * ist aber fest 12px, und wie breit ein Wert darin steht, entscheiden Region
 * und Waehrung des Haushalts. Gemessen in koreanischer Region mit Won:
 * "₩6,000,000" ist 67px breit und stand bei 375px Fensterbreite 6px, bei 1280px
 * 13px links ausserhalb seines Scrollports - ohne Waehrungszeichen und ohne den
 * Anfang der Zahl. Eine groessere feste Zahl haette denselben Fehler eine
 * Groessenordnung weiter wieder ("CHF 125'000'000" ist 100px breit) und naehme
 * jedem Diagramm mit kurzen Werten die Breite; eine Kurzschreibweise traegt
 * auch nicht ueberall ("1,25 Mio. €" ist 62px breit, "600.000 €" hat gar keine).
 *
 * Deshalb wird gemessen statt geschaetzt: die Breite des breitesten Werts der
 * Werteachse geht als `--chart-label-width` an das Elternelement des SVG, und
 * `.chart-host` (panel.css) rechnet das Polster daraus. Das Elternelement, weil
 * dort auch steht, was UEBER der Flaeche liegt und gegen dieselbe Zeichenbreite
 * rechnet (die Punkte des Budget-Verlaufs). Einmal je Aufbau genuegt: die
 * Schrift skaliert nicht mit, die Breite eines Werts haengt also nicht an der
 * des Fensters.
 *
 * NACH dem Einsetzen ins Dokument aufrufen: ein Wert, der nicht im Bild steht,
 * hat keine Breite, und dann bleibt es bei der Mindestbreite. Ein Diagramm ohne
 * diesen Aufruf verliert nichts - es behaelt den Gutter, den es hatte.
 *
 * @param {ParentNode} root  enthaelt die eben eingesetzten `svg.chart`
 */
export function fitChartGutter(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  const widest = new Map();
  for (const label of root.querySelectorAll('svg.chart .chart__axis--y')) {
    const host = label.closest('svg.chart')?.parentElement;
    if (!host) continue;
    widest.set(host, Math.max(widest.get(host) ?? 0, label.getBoundingClientRect().width));
  }
  for (const [host, width] of widest) {
    if (!(width > 0)) continue;
    host.classList.add('chart-host');
    host.style.setProperty('--chart-label-width', `${Math.ceil(width)}px`);
  }
}

/**
 * X-Achsen-Labels (erstes, mittleres, letztes) unter dem Plot, an den
 * Plotgrenzen ausgerichtet: das erste linksbündig, das letzte rechtsbündig.
 * Drei Marken statt einer pro Datenpunkt - eine Zeitachse muss nicht jeden
 * Punkt benennen, sie muss ihre Spanne benennen.
 *
 * @param {string[]} labels  bereits formatierte Beschriftungen
 */
export function chartXLabelsMarkup(labels, geo = CHART) {
  if (!labels.length) return '';
  const { H, W, PAD_L, PAD_R } = geo;
  const y = H - 7;
  const picks = labels.length <= 2
    ? labels.slice()
    : [labels[0], labels[Math.floor((labels.length - 1) / 2)], labels[labels.length - 1]];
  return picks.map((label, idx) => {
    const anchor = idx === 0 ? 'start' : idx === picks.length - 1 ? 'end' : 'middle';
    const px = anchor === 'start' ? PAD_L : anchor === 'end' ? W - PAD_R : (PAD_L + (W - PAD_R)) / 2;
    return `<text x="${px.toFixed(1)}" y="${y}" class="chart__axis" text-anchor="${anchor}">${esc(label)}</text>`;
  }).join('');
}

/**
 * Rechnet einen Wert auf seine Y-Koordinate im Plot. Steht hier, weil jede
 * Zeitreihe sie braucht und drei Module sie bisher je eigen geschrieben haben.
 */
export function chartY(value, min, max, geo = CHART) {
  const { top, bottom } = chartScales(geo);
  if (max === min) return (top + bottom) / 2;
  return bottom - ((value - min) / (max - min)) * (bottom - top);
}

/** Rechnet einen Index auf seine X-Koordinate im Plot. */
export function chartX(index, count, geo = CHART) {
  const { left, right } = chartScales(geo);
  if (count <= 1) return left;
  return left + (index * (right - left)) / (count - 1);
}

/* RUNDE ACHSENWERTE (Re-Critique 2026-09-27, C4).
 *
 * Das Gitter teilte die rohe Spanne in Viertel: die Blutdruck-Achse stand bei
 * 126/108/91/73/55, die Budget-Achse bei 5.550/4.163/2.775/1.388. Solche Werte
 * liest niemand ab - man rechnet sie nach. Die Spanne wird deshalb auf drei
 * bis sechs Schritte von 1, 2, 2,5 oder 5 mal einer Zehnerpotenz gelegt, und
 * die Unterkante auf ein Vielfaches davon. Genommen wird die knappste Skala,
 * die die Daten ganz enthaelt; bei Gleichstand die mit vier Schritten, dann
 * fuenf, drei, sechs. Der Preis ist etwas Luft ueber und unter der Kurve.
 *
 * Wer eine feste Skala hat (Stimmung 1-5, Schweregrad 1-3), ruft das nicht:
 * dort SIND die Grenzen die Aussage. */
const NICE_FACTORS = [1, 2, 2.5, 5];
const STEP_COUNTS = [4, 5, 3, 6];

/** Ist `step` ein runder Schritt (1, 2, 2,5 oder 5 mal 10^n)? */
function isNiceStep(step) {
  if (!(step > 0)) return false;
  const f = step / 10 ** Math.floor(Math.log10(step) + 1e-9);
  return NICE_FACTORS.some((n) => Math.abs(f - n) < 1e-6);
}

/**
 * Legt [min, max] auf eine Skala mit runden Schritten.
 * @param {number} min  kleinster Datenwert
 * @param {number} max  groesster Datenwert
 * @param {{ integer?: boolean }} [opts]  `integer`: nur ganzzahlige Schritte -
 *        fuer eine Achse, die ohne Nachkommastellen beschriftet (Geldachse:
 *        2,5 stuende dort als "3 €").
 * @returns {{ min: number, max: number, step: number, steps: number }}
 *          `steps` geht an `chartGridMarkup` als Zahl der Schritte.
 */
export function niceDomain(min, max, { integer = false } = {}) {
  let lo = Number(min);
  let hi = Number(max);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { min: 0, max: 4, step: 1, steps: 4 };
  if (lo > hi) [lo, hi] = [hi, lo];
  if (lo === hi) {
    // Ein einzelner Wert braucht eine Spanne; unter 0 wird keine erfunden.
    const pad = lo !== 0 ? Math.abs(lo) * 0.1 : 1;
    hi += pad;
    lo = lo >= 0 && lo - pad < 0 ? 0 : lo - pad;
  }
  // Gleitkomma-Reste (0.1 + 0.2) bleiben aus den Labels: jeder Wert wird auf
  // die Stellen seines Schritts gerundet.
  const fix = (v, step) => Number(v.toFixed(Math.max(0, 2 - Math.floor(Math.log10(step)))));
  let best = null;
  for (const steps of STEP_COUNTS) {
    const mag = 10 ** Math.floor(Math.log10((hi - lo) / steps));
    const step = [...NICE_FACTORS.map((f) => f * mag), 10 * mag, 20 * mag].find((s) =>
      (!integer || Math.abs(s - Math.round(s)) < 1e-9)
      && Math.floor(lo / s + 1e-9) * s + steps * s >= hi - 1e-9);
    if (step === undefined) continue;
    const start = fix(Math.floor(lo / step + 1e-9) * step, step);
    const cand = { min: start, max: fix(start + steps * step, step), step, steps };
    // STEP_COUNTS steht in Vorzugsreihenfolge: nur eine echt knappere Skala
    // verdraengt die fruehere.
    if (!best || cand.max - cand.min < best.max - best.min - 1e-9) best = cand;
  }
  return best;
}

/* EINE ZEITACHSE RECHNET NACH DEM DATUM, NICHT NACH DER NUMMER (C4).
 *
 * `chartX(index, count)` setzt Punkte in gleichen Abstaenden - richtig fuer
 * luekenlose Buckets (jeder Tag des Monats, jeder Monat des Jahres), falsch
 * fuer Befunde vom Januar, Februar und Dezember: dort stand der Februar in der
 * Mitte und der Trend war verzerrt. `chartTimeX` rechnet einen Tagesschluessel
 * auf seine Lage in [from, to]. Reine Schluessel-Arithmetik (UTC-Tage), keine
 * Zone: die Schluessel sind schon lokale Kalendertage. */
function dayNumber(dateKey) {
  const [y, m, d] = String(dateKey).slice(0, 10).split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
}

/** X-Koordinate eines Tagesschluessels (YYYY-MM-DD) auf der Zeitachse [fromKey, toKey].
 *  Bewusst nicht exportiert: bei Nullspanne liefert sie fuer JEDEN Punkt die
 *  linke Kante - Datenreihen gehen ueber `chartTimePositions`. */
function chartTimeX(dateKey, fromKey, toKey, geo = CHART) {
  const { left, right } = chartScales(geo);
  const span = dayNumber(toKey) - dayNumber(fromKey);
  if (!(span > 0)) return left;
  return left + ((dayNumber(dateKey) - dayNumber(fromKey)) / span) * (right - left);
}

/**
 * X-Koordinaten einer nach Datum sortierten Reihe auf der Zeitachse
 * [erster, letzter Tag]. Liegen ALLE Punkte am selben Tag, hat die Achse keine
 * Spanne - dann verteilt der Index sie gleichmaessig (`chartX`), statt sie
 * uebereinander auf die linke Kante zu legen: zwei Wartungen oder zwei
 * Laborbefunde vom selben Tag waren sonst ein einziger Punkt ohne Linie
 * (Review R11). Die Regel steht hier, damit kein Aufrufer sie vergessen kann.
 * @param {string[]} dateKeys  YYYY-MM-DD, aufsteigend
 * @returns {number[]}
 */
export function chartTimePositions(dateKeys, geo = CHART) {
  const n = dateKeys.length;
  if (!n) return [];
  const from = dateKeys[0];
  const to = dateKeys[n - 1];
  if (!(dayNumber(to) - dayNumber(from) > 0)) return dateKeys.map((_, i) => chartX(i, n, geo));
  return dateKeys.map((key) => chartTimeX(key, from, to, geo));
}

/**
 * Beschriftung einer Zeitachse: Anfang, Mitte und Ende des ZEITRAUMS, jede an
 * ihrer wahren Stelle. Die Mitte ist ein Datum, kein Datenpunkt - auf einer
 * Zeitachse steht sie genau dort, wo sie hingehoert.
 * @param {string} fromKey
 * @param {string} toKey
 * @param {(dateKey: string) => string} formatDate
 */
export function chartTimeLabelsMarkup(fromKey, toKey, formatDate, geo = CHART) {
  const { H } = geo;
  const y = H - 7;
  const a = dayNumber(fromKey);
  const b = dayNumber(toKey);
  const keys = [fromKey];
  if (b - a >= 2) {
    const mid = new Date((a + Math.round((b - a) / 2)) * 86400000);
    keys.push(`${mid.getUTCFullYear()}-${String(mid.getUTCMonth() + 1).padStart(2, '0')}-${String(mid.getUTCDate()).padStart(2, '0')}`);
  }
  if (b > a) keys.push(toKey);
  return keys.map((key, idx) => {
    const anchor = idx === 0 ? 'start' : idx === keys.length - 1 ? 'end' : 'middle';
    const px = chartTimeX(key, fromKey, toKey, geo);
    return `<text x="${px.toFixed(1)}" y="${y}" class="chart__axis" text-anchor="${anchor}">${esc(formatDate(key))}</text>`;
  }).join('');
}
