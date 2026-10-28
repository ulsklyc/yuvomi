/**
 * Modul: Zeitraster (time-grid)
 * Zweck: DAS EINE Wochenraster der App - Tageskopf („MO 19", Heute-Kreis),
 *        Stundenachse, Stundenlinien, Jetzt-Linie und der Scroll zur
 *        laufenden Stunde. Kalender (Woche) und Schichtplan (Uebersicht)
 *        bauen ihr Raster daraus; das Aussehen steht in styles/time-grid.css,
 *        das beide Seitenblaetter einbinden.
 * Abhaengigkeiten: /utils/html.js
 *
 * WARUM (Critique R22, a3 P2 "zwei Wochenraster", D6): der Schichtplan baute
 * sein Raster selbst - Kopf "Mo 19.10." linksbuendig, eine verdichtete
 * Stundenskala ohne die leeren Stunden, keine Jetzt-Linie, die Woche begann
 * um 00:00 statt bei jetzt. Wer zwischen Kalender und Schichtplan wechselte,
 * las dieselbe Woche in zwei Grammatiken. Jetzt gilt EINE Rasterregel: was
 * hier steht, gilt in beiden Modulen.
 *
 * DIE STUNDENHOEHE STEHT IN tokens.css UND NUR DORT (`--cal-hour-height`).
 * Positionen sind calc() gegen den Token-Namen; wer die Hoehe in Pixeln
 * braucht (Scroll zur Stunde), misst sie am Element.
 *
 * Die Klassen bleiben die des Kalenders (`week-view__*`): Tests, Sonden und
 * Tastaturwege des Kalenders haengen an ihnen, und ein Baustein, der beim
 * Teilen seinen Namen wechselt, waere ein zweiter.
 */
import { esc } from '/utils/html.js';
import { formatTime } from '/i18n.js';

/** Der Name der Stundenhoehe (tokens.css). */
export const HOUR_VAR = '--cal-hour-height';

/** Vertikaler Versatz einer Minutenzahl als calc() gegen die Stundenhoehe. */
export function hourOffset(minutes) {
  return `calc(var(${HOUR_VAR}) * ${Math.round((minutes / 60) * 1e4) / 1e4})`;
}

/** Ab dieser Stunde zeigt das Zeitraster den Tag, wenn jetzt dabei Platz hat. */
export const MORNING_HOUR = 7;
/** Ab dieser Stunde ist es frueher Morgen, nicht mehr Nacht: das Raster zeigt
 * schon den kommenden Tag ab MORNING_HOUR (Re-Kritik 2026-10-17). */
export const EARLY_HOUR = MORNING_HOUR - 2;

/**
 * DIE ERSTE SICHTBARE STUNDE STEHT GANZ DA (R19, Critique 2026-10-16). Der
 * Raster-Scroller sprang auf "jetzt minus 80px" - mitten in eine Stunde, und
 * am Abend auf das Scrollende, das genauso mitten in einer Stunde liegt: mobil
 * stand die Reihe 14/15 Uhr halb unter der Ganztagszone, ihre Uhrzeit und
 * Terminkoepfe angeschnitten. Jetzt rundet der Startpunkt auf die volle
 * Stunde ab, auch dort, wo das Scrollende ihn deckelt.
 *
 * DER MORGEN STEHT DA, WO JETZT DANEBEN PLATZ HAT (R19, Critique 2026-10-16).
 * "Eine gute Stunde vor jetzt" liess am Desktop den Vormittag unsichtbar: um
 * 15 Uhr begann die Woche bei 13 Uhr, obwohl das Raster 18 Stunden fasst.
 * Mit `visible` (Hoehe des Scrollers) beginnt die Ansicht um MORNING_HOUR,
 * solange die laufende Stunde darunter noch ganz hineinpasst; sonst so spaet
 * wie noetig, damit sie unten steht. Ohne `visible` bleibt es bei "eine gute
 * Stunde vor jetzt".
 *
 * FRUEH AM MORGEN ZEIGT SIE DEN TAG, NICHT DIE NACHT (Re-Kritik 2026-10-17):
 * um 05:49 begann die Woche bei 04:00 und zeigte bis 15:30 - drei Stunden
 * leere Nacht vor dem ersten Termin. Ab EARLY_HOUR (zwei Stunden vor dem
 * Morgen) beginnt sie um MORNING_HOUR; die laufende Stunde liegt dann knapp
 * darueber, der Tag, der gleich beginnt, steht ganz da. Tief in der Nacht
 * (Nachtschicht, Wickeln) bleibt es bei einer Stunde vor jetzt.
 *
 * DER MORGEN DARF FRUEHER BEGINNEN (R22, D6): `morning` verschiebt den Beginn
 * des Tages nach vorn - der Schichtplan uebergibt die erste Schicht der
 * sichtbaren Tage, wenn sie vor 07:00 beginnt (Fruehschicht 06:00). Sonst
 * begann die Woche um 07:00, und der Titel jeder Fruehschicht stand eine
 * Stunde ueber dem Bild. Nie spaeter als MORNING_HOUR.
 * @param {{hour: number, hourHeight: number, max: number, visible?: number, morning?: number}} opts
 * @returns {number} scrollTop in px, ein Vielfaches der Stundenhoehe
 */
export function alignedHourScroll({ hour, hourHeight, max, visible, morning = MORNING_HOUR }) {
  if (!(hourHeight > 0)) return 0;
  let wanted;
  if (visible > 0) {
    const fits = Math.floor(visible / hourHeight + 1e-6);
    const dayStart = Math.max(0, Math.min(MORNING_HOUR, morning));
    const night = hour < EARLY_HOUR ? Math.max(0, hour - 1) : dayStart;
    const topHour = Math.max(hour + 1 - fits, Math.min(dayStart, night));
    wanted = Math.max(0, topHour) * hourHeight;
  } else {
    wanted = Math.max(0, hour * hourHeight - 80);
  }
  const capped = Math.min(wanted, Math.max(0, max));
  return Math.floor(capped / hourHeight + 1e-6) * hourHeight;
}

/** Die Bloecke, deren fruehester den Morgen setzt (Kalender: Termine und Schichtbaender). */
export const GRID_BLOCKS = '.week-event, .day-event, .schedule-time-block';

/**
 * DER MORGEN BEGINNT MIT DEM ERSTEN BLOCK (R22 D6 fuer den Schichtplan, R24
 * Critique G1 P1-1 fuer den Kalender). Gemessen wird am Raster: die Oberkante
 * des fruehesten Blocks. Was um 00:00 beginnt, zaehlt nicht - das ist die
 * Fortsetzung von gestern, nicht der Morgen.
 * @returns {number|undefined} Stunde oder undefined (dann MORNING_HOUR)
 */
export function earliestBlockHour(body, bodyTop, hourHeight, blocks = GRID_BLOCKS) {
  if (!(hourHeight > 0)) return undefined;
  let first = Infinity;
  for (const el of body.querySelectorAll?.(blocks) ?? []) {
    const offset = el.getBoundingClientRect().top - bodyTop;
    if (offset >= 1 && offset < first) first = offset;
  }
  return Number.isFinite(first) ? Math.floor(first / hourHeight + 1e-6) : undefined;
}

/**
 * DAS RASTER STEHT AUF JETZT - EIN WEG FUER BEIDE WOCHENRASTER (R24 S7b).
 * Kalender (Woche, Tag) und Schichtplan-Uebersicht scrollen ihr Raster in
 * einem eigenen Port (`#week-scroll`, `.schedule-overview__scroll`), der Kopf
 * des Moduls und die Tageskoepfe stehen darueber. Bis R24 rechnete der
 * Schichtplan das selbst, gegen die Seite und ihre klebende Werkzeugzeile;
 * seit beide dieselbe Bauart haben, rechnet hier EINE Funktion: das Raster
 * (`body`) beginnt oben im Port, die Hoehe einer Stunde wird an ihm gemessen.
 *
 * Unten zieht der Nachlauf der Shell ab (`scroll-padding-block-end` der Rolle
 * `.page-scrollport`, mobil die schwebende Tab-Leiste): sonst stand die
 * laufende Stunde "ganz im Bild" hinter dem Glas.
 * @param {Element|null} scroll  der Port
 * @param {Element|null} body    das 24-Stunden-Raster, oben im Port
 * @param {{ hour: number, blocks?: string }} opts  `hour` = Stunde des Haushalts
 */
export function scrollGridToNow(scroll, body, { hour, blocks = GRID_BLOCKS }) {
  if (!scroll || !body) return;
  const bodyRect = body.getBoundingClientRect();
  const hourHeight = bodyRect.height / 24;
  let covered = 0;
  try {
    covered = parseFloat(getComputedStyle(scroll).scrollPaddingBlockEnd) || 0;
  } catch { /* ohne Stilauskunft (Tests): nichts verdeckt */ }
  scroll.scrollTop = alignedHourScroll({
    hour,
    hourHeight,
    max: scroll.scrollHeight - scroll.clientHeight,
    visible: scroll.clientHeight - covered,
    morning: earliestBlockHour(body, bodyRect.top, hourHeight, blocks),
  });
}

function attrsHtml(attrs = {}) {
  return Object.entries(attrs)
    .filter(([, value]) => value !== undefined && value !== null && value !== false)
    .map(([name, value]) => (value === true ? ` ${name}` : ` ${name}="${esc(String(value))}"`))
    .join('');
}

/**
 * Der Kopf EINES Tages: Wochentag-Kuerzel und Ziffer nebeneinander, mittig,
 * die Ziffer des heutigen Tages im Akzentkreis.
 * @param {object} o
 * @param {string} o.dayName   „MO" (Klartext, wird escaped)
 * @param {string|number} o.dayNum  „19"
 * @param {boolean} [o.isToday]
 * @param {string} [o.className]  weitere Klassen am Kopf
 * @param {object} [o.attrs]      weitere Attribute (data-date, role, aria-label …)
 * @returns {string}
 */
export function timeGridDayHeadHtml({ dayName, dayNum, isToday = false, className = '', attrs = {} }) {
  return `<div class="week-view__day-header${className ? ` ${esc(className)}` : ''}"${attrsHtml({
    ...attrs,
    'aria-current': isToday ? 'date' : undefined,
  })}>
            <div class="week-view__day-name">${esc(dayName)}</div>
            <div class="week-view__day-num${isToday ? ' week-view__day-num--today' : ''}">${esc(String(dayNum))}</div>
          </div>`;
}

/**
 * Die Beschriftung der Stundenspalte - volle Stunden, also ohne „:00" im
 * 12-Stunden-Format („8 AM" statt „8:00 AM").
 *
 * Die Spalte ist mobil 44px breit (--cal-gutter-width, Critique 2026-09-24:
 * 64px von 375 waren ein Sechstel der Breite fuer eine Beschriftung).
 * „12:00 PM" braucht bei 12px rund 50px und passt dort nicht hinein; „12 PM"
 * ist die Form, die Apple Kalender und Fantastical in ihrer Stundenleiste
 * fuehren. Im 24-Stunden-Format bleibt es bei formatTime: „08:00" passt, und
 * die Schreibweise der Locale (Punkt in `id`, persische Ziffern in `fa`)
 * kommt nur von dort.
 */
export function hourGutterLabel(hour) {
  return compactHourLabel(formatTime(`${String(hour).padStart(2, '0')}:00`));
}

/** „8:00 AM" -> „8 AM"; alles andere (24-Stunden-Schreibweisen) bleibt. */
export function compactHourLabel(full) {
  const twelve = String(full).match(/^(\d{1,2}):00 ([AP]M)$/);
  return twelve ? `${twelve[1]} ${twelve[2]}` : full;
}

/**
 * Die Stundenachse: 24 Zeilen, die erste ohne Beschriftung (00:00 steht an
 * der Oberkante des Rasters, wo sie niemand sucht).
 * @param {(hour: number) => string} labelFor  Beschriftung einer Stunde (Klartext)
 * @returns {string}
 */
export function timeGridHoursHtml(labelFor = hourGutterLabel) {
  return Array.from({ length: 24 }, (_, h) => `
              <div class="week-view__time-slot">
                <span class="week-view__time-label">${h === 0 ? '' : esc(labelFor(h))}</span>
              </div>`).join('');
}

/** Die 24 Stundenlinien einer Spalte. */
export function timeGridHourLinesHtml() {
  return Array.from({ length: 24 }, (_, h) => `
                  <div class="week-view__hour-line" style="top:${hourOffset(h * 60)};"></div>`).join('');
}

/**
 * Die Jetzt-Linie an einer Minute des Tages.
 * @param {number} minutes  Minuten seit Mitternacht (Haushaltsuhr)
 * @param {object} [attrs]
 */
export function timeGridNowLineHtml(minutes, attrs = {}) {
  return `<div class="week-view__now-line"${attrsHtml({ 'aria-hidden': 'true', ...attrs })} style="top:${hourOffset(minutes)};"></div>`;
}
