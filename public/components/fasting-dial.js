/** Recorded fasting days as bounded, separated SVG traces. */
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { fastingDialModel } from '/utils/health-fasting.js';

export function fastingDialMarkup(elapsedMinutes, goalMinutes, zoneMode = 'timer') {
  const model = fastingDialModel({ elapsedMinutes, goalMinutes, zoneMode });
  const count = model.visibleDaySegments.length;
  const gap = count > 1 ? 3 : 0;
  const arc = 100 / count - gap;
  const traces = model.visibleDaySegments.map((day, i) => {
    const offset = -i * 100 / count;
    return `<circle class="fasting-dial__track" cx="60" cy="60" r="52" pathLength="100" stroke-dasharray="${arc} ${100 - arc}" stroke-dashoffset="${offset}"/><circle class="fasting-dial__trace" data-fasting-day="${day.day}" cx="60" cy="60" r="52" pathLength="100" stroke-dasharray="${arc * day.progress} ${100 - arc * day.progress}" stroke-dashoffset="${offset}"/>`;
  }).join('');
  const goal = goalMinutes ? Math.min(1, goalMinutes / (count * 1440)) : null;
  const marker = goal === null ? '' : `<circle class="fasting-dial__goal" data-fasting-goal-marker cx="60" cy="60" r="52" pathLength="100" stroke-dasharray="0.8 99.2" stroke-dashoffset="${-goal * 100}"/>`;
  const zones = model.zones.map((zone, i) => `<circle class="fasting-dial__zone fasting-dial__zone--${i}" cx="60" cy="60" r="${46 - i * 3}" pathLength="100" stroke-dasharray="${(zone.endMinute - zone.startMinute) / 1440 / count * 100} 100" stroke-dashoffset="${-zone.startMinute / 1440 / count * 100}"/>`).join('');
  return `<svg class="fasting-dial__svg" viewBox="0 0 120 120" aria-hidden="true"><g transform="rotate(-90 60 60)">${traces}${zones}${marker}</g>${count === 1 ? '<g class="fasting-dial__landmarks"><text x="60" y="6">0</text><text x="117" y="62">6</text><text x="60" y="118">12</text><text x="3" y="62">18</text></g>' : ''}</svg>${model.additionalDays ? `<span class="fasting-dial__extra">${esc(t('health.fasting.extraDays', { days: model.additionalDays }))}</span>` : ''}`;
}

export function fastingEducationMarkup() {
  return `<div class="fasting-education"><button class="btn btn--ghost fasting-help__button" type="button" data-fasting-education aria-haspopup="dialog" aria-label="${esc(t('health.fasting.zoneDetails'))}"><i data-lucide="info" aria-hidden="true"></i></button></div>`;
}
