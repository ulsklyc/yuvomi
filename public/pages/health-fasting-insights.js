/** Completed-record insights; isolated from journal lifecycle controls. */
// Delegated panel composition: dashboard, supplied by the Health page.
// data-composition="dashboard"
import { t, formatDayMonth } from '/i18n.js';
import { esc } from '/utils/html.js';
import { formatFastingDuration } from '/utils/health-fasting.js';
import { fastingHelpHtml } from '/components/fasting-help.js';

export function renderFastingStats(stats) {
  if (!stats) return '';
  const metric = (label, value) => `<div class="fasting-stat"><span>${esc(label)}</span><strong class="metric-card__value">${esc(String(value))}</strong></div>`;
  const summary = (key, data) => `<section class="fasting-stats__period"><h4>${esc(t(`health.fasting.${key}`))}</h4><div class="fasting-stats__grid">${metric(t('health.fasting.statsCount'), data.count)}${metric(t('health.fasting.statsTotal'), formatFastingDuration(data.totalMinutes))}${metric(t('health.fasting.statsAverage'), formatFastingDuration(data.averageMinutes))}</div></section>`;
  const max = Math.max(1, ...(stats.weekly || []).flatMap((bucket) => [bucket.totalMinutes, bucket.goalMinutes || 0]));
  const series = (stats.weekly || []).map((bucket) => `<div class="fasting-week__day"><span>${esc(bucket.hasRecord ? formatFastingDuration(bucket.totalMinutes) : t('health.fasting.noRecord'))}</span><div class="fasting-week__track"><span class="fasting-week__bar" style="--bar-scale:${bucket.totalMinutes / max}"></span>${bucket.goalMinutes === null ? '' : `<span class="fasting-week__goal" style="--bar-scale:${bucket.goalMinutes / max}"></span>`}</div><time datetime="${esc(bucket.date)}">${esc(formatDayMonth(bucket.date))}</time><span>${esc(bucket.goalMinutes === null ? bucket.hasRecord ? t('health.fasting.noGoal') : '' : `${t('health.fasting.capturedGoal')}: ${formatFastingDuration(bucket.goalMinutes)}`)}</span>${bucket.goalCount && bucket.goalCount < bucket.count ? `<span>${esc(t('health.fasting.goalCoverage', { records: bucket.goalCount, total: bucket.count }))}</span>` : ''}</div>`).join('');
  return `<section><h3 class="u-section-title">${esc(t('health.fasting.statsTitle'))}</h3><div class="fasting-card fasting-stats"><div class="fasting-stats__periods">${summary('allTime', stats.allTime)}${summary('thisYear', stats.year)}${summary('last30Days', stats.last30Days)}</div><div class="fasting-stats__grid">${metric(t('health.fasting.statsCurrentStreak'), stats.currentStreak)}${metric(t('health.fasting.statsLongestStreak'), stats.longestStreak)}</div><h4 class="fasting-week__title fasting-help-heading">${esc(t('health.fasting.statsWeekly'))}${fastingHelpHtml(t('health.fasting.statsWeekly'), [t('health.fasting.chartLegend')], 'data-fasting-goal-legend')}</h4><div class="fasting-week">${series}</div></div></section>`;
}
