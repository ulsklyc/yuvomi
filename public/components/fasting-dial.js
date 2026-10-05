/** Recorded fasting days as bounded, separated SVG traces. */
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { fastingDialModel } from '/utils/health-fasting.js';

/* EIN RING, DER SICH BEWEGT, STATT JEDE MINUTE NEU GEZEICHNET ZU WERDEN
 * (Critique 2026-09-26, A6 P2-3). Frueher schrieb der Takt das ganze SVG neu:
 * eine Transition auf `stroke-dasharray` konnte so nie greifen, und der Strich
 * war mit 3/120 eine Haarlinie (7px bei 288px). Jetzt entsteht das SVG nur,
 * wenn sich seine FORM aendert (Zahl der Tagessegmente, Ziel, Zonenmodus,
 * "+N Tage"); sonst setzt updateFastingDial() nur die Laenge der Spuren, und
 * die CSS-Transition in fasting-controls.css laesst sie dorthin laufen.
 *
 * Geometrie im 120er-Raster: Ring r=48 mit Strich 10 (43..53) und runden
 * Enden, die Stundenmarken bleiben aussen (54..59), die Zonenboegen liegen
 * innen (41/38/35). Runde Enden ragen je halbe Strichbreite ueber das Segment
 * hinaus - die Luecke zwischen Tagen rechnet das ein, sonst stiessen die
 * Segmente aneinander. */
const RADIUS = 48;
const STROKE = 10;
const VISIBLE_GAP = 3;
const CAP = (STROKE / 2) / (2 * Math.PI * RADIUS / 100);
const ZONE_RADIUS = 41;

function dialGeometry(count) {
  const gap = count > 1 ? VISIBLE_GAP + 2 * CAP : 0;
  return { gap, arc: 100 / count - gap };
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function traceDash(arc, progress) {
  const length = round(Math.max(0, arc * progress));
  return { dash: `${length} ${round(100 - length)}`, empty: length === 0 };
}

function dialShape(model, goalMinutes, zoneMode) {
  return `${model.visibleDaySegments.length}|${goalMinutes ?? ''}|${zoneMode}|${model.additionalDays}`;
}

export function fastingDialMarkup(elapsedMinutes, goalMinutes, zoneMode = 'timer') {
  const model = fastingDialModel({ elapsedMinutes, goalMinutes, zoneMode });
  const count = model.visibleDaySegments.length;
  const { arc } = dialGeometry(count);
  const traces = model.visibleDaySegments.map((day, i) => {
    const offset = round(-i * 100 / count);
    const { dash, empty } = traceDash(arc, day.progress);
    return `<circle class="fasting-dial__track" cx="60" cy="60" r="${RADIUS}" pathLength="100" stroke-dasharray="${round(arc)} ${round(100 - arc)}" stroke-dashoffset="${offset}"/><circle class="fasting-dial__trace${empty ? ' fasting-dial__trace--empty' : ''}" data-fasting-day="${day.day}" cx="60" cy="60" r="${RADIUS}" pathLength="100" stroke-dasharray="${dash}" stroke-dashoffset="${offset}"/>`;
  }).join('');
  const goal = goalMinutes ? Math.min(1, goalMinutes / (count * 1440)) : null;
  const marker = goal === null ? '' : `<circle class="fasting-dial__goal" data-fasting-goal-marker cx="60" cy="60" r="${RADIUS}" pathLength="100" stroke-dasharray="0.8 99.2" stroke-dashoffset="${-goal * 100}"/>`;
  const zones = model.zones.map((zone, i) => `<circle class="fasting-dial__zone fasting-dial__zone--${i}" cx="60" cy="60" r="${ZONE_RADIUS - i * 3}" pathLength="100" stroke-dasharray="${(zone.endMinute - zone.startMinute) / 1440 / count * 100} 100" stroke-dashoffset="${-zone.startMinute / 1440 / count * 100}"/>`).join('');
  return `<svg class="fasting-dial__svg" viewBox="0 0 120 120" aria-hidden="true"><g transform="rotate(-90 60 60)">${traces}${zones}${marker}</g>${count === 1 ? '<g class="fasting-dial__landmarks"><text x="60" y="6">0</text><text x="117" y="62">6</text><text x="60" y="118">12</text><text x="3" y="62">18</text></g>' : ''}</svg>${model.additionalDays ? `<span class="fasting-dial__extra">${esc(t('health.fasting.extraDays', { count: model.additionalDays }))}</span>` : ''}`;
}

/**
 * Den Ring in `host` auf den Stand bringen: neu gebaut wird nur bei neuer
 * Form, sonst wandert nur `stroke-dasharray` der Spuren - und nur, wenn sich
 * der Wert wirklich aendert (der Takt ruft sekuendlich). Gibt zurueck, ob neu
 * gebaut wurde.
 */
export function updateFastingDial(host, elapsedMinutes, goalMinutes, zoneMode = 'timer') {
  const model = fastingDialModel({ elapsedMinutes, goalMinutes, zoneMode });
  const shape = dialShape(model, goalMinutes, zoneMode);
  if (host.dataset.fastingDialShape !== shape) {
    host.dataset.fastingDialShape = shape;
    host.replaceChildren();
    host.insertAdjacentHTML('beforeend', fastingDialMarkup(elapsedMinutes, goalMinutes, zoneMode));
    return true;
  }
  const { arc } = dialGeometry(model.visibleDaySegments.length);
  host.querySelectorAll('.fasting-dial__trace').forEach((trace, i) => {
    const day = model.visibleDaySegments[i];
    if (!day) return;
    const { dash, empty } = traceDash(arc, day.progress);
    if (trace.getAttribute('stroke-dasharray') !== dash) trace.setAttribute('stroke-dasharray', dash);
    trace.classList.toggle('fasting-dial__trace--empty', empty);
  });
  return false;
}

export function fastingEducationMarkup() {
  return `<div class="fasting-education"><button class="btn btn--ghost fasting-help__button" type="button" data-fasting-education aria-haspopup="dialog" aria-label="${esc(t('health.fasting.zoneDetails'))}"><i data-lucide="info" aria-hidden="true"></i></button></div>`;
}
