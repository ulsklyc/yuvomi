/**
 * Test: Inventar-Garantiestatus (Stufe 4)
 * Zweck: Die reine Ableitung, an der Listen-Icon und Formular-Statuszeile hängen -
 *        analog test/test-pantry-status.js. Fester Bezugstag, damit die
 *        Zusicherungen nicht mit dem Kalender kippen.
 * Ausführen: node --loader ./test/test-browser-loader.mjs --test test/test-inventory-warranty-status.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  WARRANTY_ALERT_DAYS, warrantyEndDateKey, warrantyStatus, hasWarrantyAlert,
  dateStatus, hasUpcomingDeadline, countUpcomingDeadlines,
} = await import('../public/utils/inventory-warranty.js');

const TODAY = '2026-07-29';
const item = (over = {}) => ({ purchase_date: null, warranty_months: null, ...over });

test('ohne Kaufdatum oder Garantiemonate gibt es kein Enddatum', () => {
  assert.equal(warrantyEndDateKey(item()), null);
  assert.equal(warrantyEndDateKey(item({ purchase_date: '2026-01-01' })), null);
  assert.equal(warrantyEndDateKey(item({ warranty_months: 12 })), null);
});

test('warrantyEndDateKey addiert Monate mit Tages-Klemmung', () => {
  assert.equal(warrantyEndDateKey(item({ purchase_date: '2026-01-15', warranty_months: 24 })), '2028-01-15');
  assert.equal(warrantyEndDateKey(item({ purchase_date: '2026-01-31', warranty_months: 1 })), '2026-02-28');
});

test('warrantyStatus ohne Garantiedaten ist null', () => {
  assert.equal(warrantyStatus(item(), TODAY), null);
});

test('WARRANTY_ALERT_DAYS ist 30', () => {
  assert.equal(WARRANTY_ALERT_DAYS, 30);
});

test('warrantyStatus: valid weit in der Zukunft, expiring innerhalb 30 Tagen, expired in der Vergangenheit', () => {
  assert.equal(warrantyStatus(item({ purchase_date: '2026-01-01', warranty_months: 24 }), TODAY).state, 'valid');
  assert.equal(warrantyStatus(item({ purchase_date: '2026-07-01', warranty_months: 1 }), TODAY).state, 'expiring');
  assert.equal(warrantyStatus(item({ purchase_date: '2020-01-01', warranty_months: 12 }), TODAY).state, 'expired');
});

test('die expiring-Schwelle ist inklusiv und endet exakt nach WARRANTY_ALERT_DAYS', () => {
  // TODAY + 30 Tage = 2026-08-28 -> noch "expiring" (inklusive Grenze).
  const atThreshold = warrantyStatus(item({ purchase_date: '2026-02-28', warranty_months: 6 }), TODAY);
  assert.equal(atThreshold.endDateKey, '2026-08-28');
  assert.equal(atThreshold.days, 30);
  assert.equal(atThreshold.state, 'expiring');

  // TODAY + 31 Tage = 2026-08-29 -> schon "valid" (einen Tag jenseits der Grenze).
  const pastThreshold = warrantyStatus(item({ purchase_date: '2026-01-29', warranty_months: 7 }), TODAY);
  assert.equal(pastThreshold.endDateKey, '2026-08-29');
  assert.equal(pastThreshold.days, 31);
  assert.equal(pastThreshold.state, 'valid');
});

test('hasWarrantyAlert ist false für valid, true für expiring/expired', () => {
  assert.equal(hasWarrantyAlert(item({ purchase_date: '2026-01-01', warranty_months: 24 }), TODAY), false);
  assert.equal(hasWarrantyAlert(item({ purchase_date: '2026-07-01', warranty_months: 1 }), TODAY), true);
  assert.equal(hasWarrantyAlert(item({ purchase_date: '2020-01-01', warranty_months: 12 }), TODAY), true);
  assert.equal(hasWarrantyAlert(item(), TODAY), false);
});

test('dateStatus ohne Datum ist null', () => {
  assert.equal(dateStatus(null), null);
  assert.equal(dateStatus(''), null);
});

test('dateStatus: valid weit in der Zukunft, expiring innerhalb 30 Tagen, expired in der Vergangenheit', () => {
  assert.equal(dateStatus('2026-12-01', TODAY).state, 'valid');
  assert.equal(dateStatus('2026-08-10', TODAY).state, 'expiring');
  assert.equal(dateStatus('2020-01-01', TODAY).state, 'expired');
});

test('dateStatus: die expiring-Schwelle liegt exakt wie bei warrantyStatus', () => {
  // dateStatus dupliziert die Zustands-Formel von warrantyStatus bewusst (es
  // braucht dessen Monats-Arithmetik nicht). Diese Grenzfaelle sind das
  // Gegenstueck zum warrantyStatus-Test oben und wuerden ein Auseinanderdriften
  // der beiden Formeln sichtbar machen.
  // TODAY + 30 Tage = 2026-08-28 -> noch "expiring" (inklusive Grenze).
  const atThreshold = dateStatus('2026-08-28', TODAY);
  assert.equal(atThreshold.days, 30);
  assert.equal(atThreshold.state, 'expiring');

  // TODAY + 31 Tage = 2026-08-29 -> schon "valid" (einen Tag jenseits der Grenze).
  const pastThreshold = dateStatus('2026-08-29', TODAY);
  assert.equal(pastThreshold.days, 31);
  assert.equal(pastThreshold.state, 'valid');
});

test('hasUpcomingDeadline: false ohne jede Frist', () => {
  assert.equal(hasUpcomingDeadline(item(), TODAY), false);
});

test('hasUpcomingDeadline: true wenn die Garantie bald ablaeuft, auch ohne getrackte Fristen', () => {
  const withWarranty = item({ purchase_date: '2026-07-01', warranty_months: 1 });
  assert.equal(hasUpcomingDeadline(withWarranty, TODAY), true);
});

test('hasUpcomingDeadline: true wenn eine getrackte Frist bald ansteht, auch ohne Garantie', () => {
  const withTrackedDate = { ...item(), tracked_dates: [{ date: '2026-08-01' }] };
  assert.equal(hasUpcomingDeadline(withTrackedDate, TODAY), true);
});

test('hasUpcomingDeadline: false wenn alle Fristen weit in der Zukunft liegen', () => {
  const farFuture = { ...item(), tracked_dates: [{ date: '2030-01-01' }] };
  assert.equal(hasUpcomingDeadline(farFuture, TODAY), false);
});

test('countUpcomingDeadlines: 0 bei leerer Liste', () => {
  assert.equal(countUpcomingDeadlines([], TODAY), 0);
});

test('countUpcomingDeadlines: zaehlt nur Items mit hasUpcomingDeadline', () => {
  const items = [
    item({ purchase_date: '2026-07-01', warranty_months: 1 }),   // bald ablaufend
    item({ purchase_date: '2020-01-01', warranty_months: 12 }),  // laengst abgelaufen - zaehlt nicht mehr (Nachlauf vorbei)
    item({ purchase_date: '2026-01-01', warranty_months: 24 }),  // valid, weit in der Zukunft
    { ...item(), tracked_dates: [{ date: '2026-08-01' }] },      // Frist bald faellig
    item(),                                                       // keine Garantie, keine Fristen
  ];
  assert.equal(countUpcomingDeadlines(items, TODAY), 2);
});

test('countUpcomingDeadlines: 0 wenn alles valid oder leer ist', () => {
  const items = [item({ purchase_date: '2026-01-01', warranty_months: 24 }), item()];
  assert.equal(countUpcomingDeadlines(items, TODAY), 0);
});

test('countUpcomingDeadlines: alle Items brauchen Aufmerksamkeit', () => {
  const items = [
    item({ purchase_date: '2026-07-01', warranty_months: 1 }),
    { ...item(), tracked_dates: [{ date: '2026-08-01' }] },
  ];
  assert.equal(countUpcomingDeadlines(items, TODAY), 2);
});

// Critique 2026-09-26: eine abgelaufene Garantie, gegen die man nichts mehr tun
// kann, hielt "Braucht Aufmerksamkeit" und das Nav-Badge dauerhaft an
// ("Familienauto", seit 17 Monaten abgelaufen). Sie zaehlt nur noch fuer einen
// benannten Nachlauf; handelbare Fristen (TUeV, Service) bleiben, bis sie
// erledigt sind.
const { WARRANTY_EXPIRED_ATTENTION_DAYS, deadlineChipSpec } = await import('../public/utils/inventory-warranty.js');

test('WARRANTY_EXPIRED_ATTENTION_DAYS ist 30', () => {
  assert.equal(WARRANTY_EXPIRED_ATTENTION_DAYS, 30);
});

test('hasUpcomingDeadline: eine abgelaufene Garantie zaehlt nur im Nachlauf, inklusive Grenze', () => {
  // Ende 2026-06-29 = 30 Tage vor TODAY -> noch im Nachlauf.
  assert.equal(hasUpcomingDeadline(item({ purchase_date: '2025-06-29', warranty_months: 12 }), TODAY), true);
  // Ende 2026-06-28 = 31 Tage vor TODAY -> vorbei.
  assert.equal(hasUpcomingDeadline(item({ purchase_date: '2025-06-28', warranty_months: 12 }), TODAY), false);
  assert.equal(hasUpcomingDeadline(item({ purchase_date: '2020-01-01', warranty_months: 12 }), TODAY), false);
});

test('hasUpcomingDeadline: eine ueberfaellige getrackte Frist bleibt ohne Nachlaufgrenze, bis sie erledigt ist', () => {
  const overdue = { ...item({ purchase_date: '2020-01-01', warranty_months: 12 }), tracked_dates: [{ label: 'TÜV', date: '2024-01-01' }] };
  assert.equal(hasUpcomingDeadline(overdue, TODAY), true);
});

test('deadlineChipSpec: null ohne faellige Frist, auch fuer eine laengst abgelaufene Garantie', () => {
  assert.equal(deadlineChipSpec(item(), TODAY), null);
  assert.equal(deadlineChipSpec(item({ purchase_date: '2026-01-01', warranty_months: 24 }), TODAY), null);
  assert.equal(deadlineChipSpec(item({ purchase_date: '2020-01-01', warranty_months: 12 }), TODAY), null);
});

test('deadlineChipSpec: Garantie bald ab nennt ihr Enddatum, Ton expiring', () => {
  const spec = deadlineChipSpec(item({ purchase_date: '2026-07-01', warranty_months: 1 }), TODAY);
  assert.deepEqual(spec, { kind: 'warranty', label: null, state: 'expiring', endDateKey: '2026-08-01', days: 3, tone: 'expiring' });
});

test('deadlineChipSpec: Garantie im Nachlauf ist expired im Gefahr-Ton', () => {
  const spec = deadlineChipSpec(item({ purchase_date: '2025-07-20', warranty_months: 12 }), TODAY);
  assert.equal(spec.kind, 'warranty');
  assert.equal(spec.state, 'expired');
  assert.equal(spec.tone, 'unavailable');
});

test('deadlineChipSpec: die dringendste Frist gewinnt - ueberfaellig und handelbar vor bald faellig vor abgelaufener Garantie', () => {
  const expiredWarranty = { purchase_date: '2025-07-20', warranty_months: 12 };
  const soon = { label: 'Service', date: '2026-08-10' };
  const sooner = { label: 'TÜV', date: '2026-08-05' };
  const overdue = { label: 'Inspektion', date: '2026-07-01' };
  assert.equal(deadlineChipSpec({ ...item(expiredWarranty), tracked_dates: [soon, sooner] }, TODAY).label, 'TÜV');
  assert.equal(deadlineChipSpec({ ...item(expiredWarranty), tracked_dates: [soon, overdue] }, TODAY).label, 'Inspektion');
  const tracked = deadlineChipSpec({ ...item(), tracked_dates: [sooner] }, TODAY);
  assert.deepEqual(tracked, { kind: 'tracked', label: 'TÜV', state: 'expiring', endDateKey: '2026-08-05', days: 7, tone: 'expiring' });
});

test('hasUpcomingDeadline und der Chip sprechen aus derselben Regel', () => {
  const cases = [
    item(),
    item({ purchase_date: '2026-07-01', warranty_months: 1 }),
    item({ purchase_date: '2025-06-29', warranty_months: 12 }),
    item({ purchase_date: '2025-06-28', warranty_months: 12 }),
    { ...item(), tracked_dates: [{ label: 'TÜV', date: '2020-01-01' }] },
    { ...item(), tracked_dates: [{ label: 'TÜV', date: '2030-01-01' }] },
  ];
  for (const c of cases) assert.equal(hasUpcomingDeadline(c, TODAY), deadlineChipSpec(c, TODAY) !== null);
});

test('die Inventarzeile zeigt die Frist als sichtbaren Chip statt eines stummen 12px-Icons', async () => {
  const { readFileSync } = await import('node:fs');
  const page = readFileSync(new URL('../public/pages/inventory.js', import.meta.url), 'utf8');
  const row = page.slice(page.indexOf('function renderItemRow'), page.indexOf('function renderCategoryRow'));
  assert.doesNotMatch(row, /shield-alert/, 'das stumme Icon mit sr-only-Satz ohne Frist und Datum ist weg');
  assert.match(row, /deadlineChipHtml\(item\)/);
  const chip = page.slice(page.indexOf('function deadlineChipHtml'), page.indexOf('function renderItemRow'));
  assert.match(chip, /deadlineChipSpec\(item\)/);
  assert.match(chip, /class="doc-badge doc-badge--\$\{spec\.tone\}"/, 'derselbe Chip wie in Dokumente');
  // Der Chip muss auf der Inventarseite auch GESTALTET sein: der Router laedt je
  // Seite genau ein Modul-Stylesheet, documents.css ist dort nicht geladen.
  const index = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const { eachRule } = await import('./css-rules.js');
  const global = [...index.matchAll(/<link rel="stylesheet" href="\/styles\/([\w-]+\.css)"/g)].map((m) => m[1]);
  const defined = (selector) => global.some((file) => [...eachRule(readFileSync(new URL(`../public/styles/${file}`, import.meta.url), 'utf8'))]
    .some((rule) => rule.at.length === 0 && rule.selector.split(',').map((x) => x.trim()).includes(selector)));
  for (const selector of ['.doc-badge', '.doc-badge--expiring', '.doc-badge--unavailable']) {
    assert.ok(defined(selector), `${selector} muss in einem global geladenen Stylesheet stehen`);
  }
});
