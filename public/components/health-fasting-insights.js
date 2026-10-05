/** Completed-record insights, shared by the Health fasting view. */
import { t, formatDayMonth } from '/i18n.js';
import { esc } from '/utils/html.js';
import { formatFastingDuration } from '/utils/health-fasting.js';
import { fastingHelpHtml } from '/components/fasting-help.js';

function goalLabel(bucket) {
  if (bucket.goalMinutes !== null) return `${t('health.fasting.capturedGoal')}: ${formatFastingDuration(bucket.goalMinutes)}`;
  return bucket.hasRecord ? t('health.fasting.noGoal') : '';
}

function goalCoverage(bucket) {
  if (!bucket.goalCount || bucket.goalCount >= bucket.count) return '';
  return t('health.fasting.goalCoverage', { count: bucket.goalCount, records: bucket.goalCount, total: bucket.count });
}

function renderWeeklyBucket(bucket, max) {
  const actual = bucket.hasRecord ? formatFastingDuration(bucket.totalMinutes) : t('health.fasting.noRecord');
  const goalBar = bucket.goalMinutes === null ? '' : `<span class="fasting-week__goal" style="--bar-scale:${bucket.goalMinutes / max}"></span>`;
  const coverage = goalCoverage(bucket);
  return [
    '<div class="fasting-week__day">',
    `<span>${esc(actual)}</span>`,
    '<div class="fasting-week__track">',
    `<span class="fasting-week__bar" style="--bar-scale:${bucket.totalMinutes / max}"></span>${goalBar}`,
    '</div>',
    `<time datetime="${esc(bucket.date)}">${esc(formatDayMonth(bucket.date))}</time>`,
    `<span>${esc(goalLabel(bucket))}</span>`,
    coverage ? `<span>${esc(coverage)}</span>` : '',
    '</div>',
  ].join('');
}

export function renderFastingStats(stats, { error = false } = {}) {
  if (!stats) {
    return error
      ? `<section><h3 class="u-section-title">${esc(t('health.fasting.statsTitle'))}</h3><div class="fasting-card fasting-stats"><p class="form-hint" role="status">${esc(t('health.fasting.loadError'))}</p></div></section>`
      : '';
  }
  const metric = (label, value) => `<div class="fasting-stat"><span>${esc(label)}</span><strong class="metric-card__value">${esc(String(value))}</strong></div>`;
  const summary = (key, data) => `<section class="fasting-stats__period"><h4>${esc(t(`health.fasting.${key}`))}</h4><div class="fasting-stats__grid">${metric(t('health.fasting.statsCount'), data.count)}${metric(t('health.fasting.statsTotal'), formatFastingDuration(data.totalMinutes))}${metric(t('health.fasting.statsAverage'), formatFastingDuration(data.averageMinutes))}</div></section>`;
  const max = Math.max(1, ...(stats.weekly || []).flatMap((bucket) => [bucket.totalMinutes, bucket.goalMinutes || 0]));
  const series = (stats.weekly || []).map((bucket) => renderWeeklyBucket(bucket, max)).join('');
  return `<section><h3 class="u-section-title">${esc(t('health.fasting.statsTitle'))}</h3><div class="fasting-card fasting-stats"><div class="fasting-stats__periods">${summary('allTime', stats.allTime)}${summary('thisYear', stats.year)}${summary('last30Days', stats.last30Days)}</div><div class="fasting-stats__grid">${metric(t('health.fasting.statsCurrentStreak'), stats.currentStreak)}${metric(t('health.fasting.statsLongestStreak'), stats.longestStreak)}</div><div class="fasting-week__title fasting-help-heading"><h4>${esc(t('health.fasting.statsWeekly'))}</h4>${fastingHelpHtml(t('health.fasting.statsWeekly'), [t('health.fasting.chartLegend')], 'data-fasting-goal-legend')}</div><div class="fasting-week">${series}</div></div></section>`;
}
