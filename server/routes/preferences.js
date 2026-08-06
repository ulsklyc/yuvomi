/**
 * Modul: Haushalt-Einstellungen (Preferences)
 * Zweck: REST-API fuer haushaltweite Praeferenzen (via sync_config-Tabelle)
 * Abhängigkeiten: express, server/db.js
 */

import { createLogger } from '../logger.js';
import express from 'express';
import * as db from '../db.js';
import * as holidays from '../services/holidays.js';
import { str, MAX_SHORT } from '../middleware/validate.js';
import { getSupportedLocales, isSupportedLocale, resolveHouseholdLocale } from '../utils/i18n.js';
import { retitleBirthdayEvents } from '../services/birthdays.js';
// Geteilte isomorphe Util (#620, Allowlist in test/test-layer-boundary.js):
// dasselbe Kennungsformat, das Event-Modal und Einstellungen verwenden.
import { parseSyncTargetValue } from '../../public/utils/sync-target.js';

const log = createLogger('Preferences');

const router = express.Router();

const VALID_MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'];
const DEFAULT_MEAL_TYPES = VALID_MEAL_TYPES.join(',');

const VALID_CURRENCIES = ['AED', 'ARS', 'AUD', 'BBD', 'BOB', 'BRL', 'BSD', 'BZD', 'CAD', 'CHF', 'CLP', 'CNY', 'COP', 'CRC', 'CUP', 'CZK', 'DKK', 'DOP', 'EUR', 'GBP', 'GTQ', 'GYD', 'HNL', 'HTG', 'HUF', 'IDR', 'INR', 'IRR', 'JMD', 'JPY', 'KRW', 'KZT', 'MXN', 'MYR', 'NIO', 'NOK', 'NZD', 'PAB', 'PEN', 'PHP', 'PLN', 'PYG', 'RUB', 'SAR', 'SEK', 'SRD', 'TRY', 'TTD', 'UAH', 'USD', 'UYU', 'VES', 'XCD', 'ZAR'];
const DEFAULT_CURRENCY = 'EUR';
const DEFAULT_APP_NAME = 'Yuvomi';

const VALID_DATE_FORMATS = ['mdy', 'dmy', 'ymd', 'mdy_dot', 'dmy_dot', 'dmy_slash', 'ymd_dot', 'ymd_slash'];
// Default an die übrigen europäischen Defaults (EUR, 24h) und den Client-i18n-
// Default (dmy) angeglichen: ein nicht konfigurierter Account zeigt 30.06.2026
// statt 06/30/2026. US-Nutzer können in den Einstellungen weiterhin mdy wählen.
const DEFAULT_DATE_FORMAT = 'dmy';
const VALID_TIME_FORMATS = ['24h', '12h'];

// Wochenstart (haushaltweit): mit welchem Wochentag Kalender-Ansichten beginnen.
// Montag = bisheriges Fixverhalten; Sonntag/Samstag auf mehrfachen Nutzerwunsch
// (#484, #465). Als Klartext gespeichert – der Client mappt auf den getDay()-Index.
const VALID_WEEK_STARTS = ['monday', 'sunday', 'saturday'];
const DEFAULT_WEEK_START = 'monday';
// Budget-Modus (#476/#505): 'shared' = ein Haushaltsbudget (Altverhalten),
// 'personal' = persönliche/geteilte Einträge mit Mein/Haushalt-Ansicht.
const VALID_BUDGET_MODES = ['shared', 'personal'];
const DEFAULT_BUDGET_MODE = 'shared';

// Datensprache des Haushalts (#631, #632): in welcher Sprache der Server Inhalte
// *speichert*, die er selbst erzeugt - heute die Titel und Beschreibungen der
// Geburtstags-Termine. Anders als die UI-Sprache (per-user im localStorage) muss
// das haushaltweit sein: eine calendar_events-Zeile hat genau einen Titel, und
// den lesen REST-API, ICS-Feed, CalDAV-/Google-Outbound und die Suche.
// Nicht gesetzt = aus der Region abgeleitet, sonst Englisch (resolveHouseholdLocale).
const VALID_LANGUAGES = getSupportedLocales();

// Region ist nur ein Anzeige-Hinweis (Locale-Code wie "fr-FR" oder "custom").
// Der Client fällt bei unbekanntem Wert ohnehin auf detectRegion() zurück, daher
// genügt eine Formprüfung statt einer festen Liste.
//
// Der Sprachteil darf zwei oder drei Buchstaben haben: BCP-47 kennt beides und
// "fil-PH" (Filipino) wäre mit der alten {2}-Prüfung als ungültige Region
// abgewiesen worden, obwohl der Client sie anbietet.
const VALID_REGION = /^(custom|[a-z]{2,3}-[A-Z]{2})$/;
const DEFAULT_TIME_FORMAT = '24h';

// Standard-Termindauer (Minuten): setzt das Ende neuer Kalender-Termine relativ
// zum Start und dient dem Modal als Ausgangs-Dauer. Grenzen: 5 Min bis 24 h.
const DEFAULT_CALENDAR_DURATION = 60;
const MIN_CALENDAR_DURATION = 5;
const MAX_CALENDAR_DURATION = 1440;

// Standard-Erinnerungen für neue Termine (#497, per-user): erlaubte Offsets in
// Minuten vor Terminbeginn (deckt sich mit den Presets im Event-Modal). Cap = 5,
// analog MAX_REMINDERS_PER_ENTITY in server/routes/reminders.js.
const VALID_REMINDER_OFFSETS = [0, 15, 60, 1440, 2880, 10080, 20160];
const MAX_DEFAULT_REMINDERS = 5;

// Standard-Sync-Ziel für eigene neue Termine (#620, per-user). Gespeichert wird
// exakt die Kennung, die das Event-Modal ohnehin führt: '' (lokal speichern),
// 'google:<calendarId>' oder 'caldav:<accountId>|<calendarUrl>'. Geprüft wird mit
// parseSyncTargetValue aus dem geteilten Util - dieselbe Funktion, mit der das
// Frontend die Kennung baut und liest, damit Server und Client nicht getrennte
// Vorstellungen vom Format entwickeln.
//
// Geprüft wird nur die FORM, nicht die Existenz. Ein Kalender kann deaktiviert,
// gelöscht oder auf nur-lesend gestellt werden, lange nachdem jemand ihn hier
// gewählt hat; eine Existenzprüfung beim Speichern würde das nicht verhindern,
// aber einen Google-API-Aufruf in jeden Einstellungs-Save ziehen. Stattdessen
// entscheidet das Modal beim Öffnen: steht das Ziel nicht mehr in der Liste,
// bleibt die Vorauswahl auf "Lokal" (siehe applyDefaultSyncTarget).
//
// Per-user, kein Admin-Gate: die Nachbarschlüssel calendar_default_reminders und
// calendar_default_assign_me liegen aus demselben Grund pro Nutzer (#497/#498) -
// wer welchen Kalender bespielt, ist eine persönliche Entscheidung.
const MAX_CALENDAR_TARGET_LENGTH = 500;

// Standard-Punktwert für neue Aufgaben (#578, haushaltweit). 0 = kein Standard,
// das Punktefeld bleibt wie bisher leer. Obergrenze spiegelt MAX_POINTS in
// server/routes/tasks.js.
const DEFAULT_TASK_POINTS = 0;
const MAX_TASK_POINTS = 10000;

// Persistierte Default-Reminder als sortiertes Zahlen-Array lesen (leer = keine).
function parseDefaultReminders(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return [...new Set(arr.map(Number).filter((n) => VALID_REMINDER_OFFSETS.includes(n)))]
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/** Persistierten Standard-Punktwert als ganze Zahl im gültigen Bereich lesen. */
function parseTaskDefaultPoints(raw) {
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TASK_POINTS;
  return Math.min(n, MAX_TASK_POINTS);
}

const VALID_WEATHER_PROVIDERS = ['open-meteo', 'openweathermap'];
const VALID_WEATHER_UNITS = ['metric', 'imperial'];

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const COUNTRY_ISO_RE = /^[A-Z]{2}$/;
const SUBDIVISION_RE = /^[A-Z]{2}-[A-Z0-9-]{1,10}$/;

// Widget identifiers are client-owned. The server validates only a safe storage shape,
// so adding or removing dashboard widgets never requires a matching backend registry change.
const WIDGET_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_DASHBOARD_WIDGETS = 64;
const VALID_WIDGET_SIZES = ['1x1', '1x2', '1x3', '1x4', '2x1', '2x2', '2x3', '2x4', '3x1', '3x2', '3x3', '3x4', '4x1', '4x2', '4x3', '4x4'];
const DEFAULT_WIDGET_CONFIG = '[]';

// Modul-Slugs, die per Settings deaktiviert werden können.
// Dashboard und Settings sind absichtlich nicht enthalten — sie sind essentiell.
const TOGGLEABLE_MODULES = [
  'tasks', 'calendar', 'meals', 'recipes', 'shopping', 'pantry',
  'birthdays', 'notes', 'contacts', 'budget', 'documents',
  'housekeeping', 'rewards', 'health',
];
const MODULE_ORDER_RE = /^(dashboard|tasks|calendar|meals|recipes|shopping|pantry|birthdays|notes|contacts|budget|documents|housekeeping|rewards|health|third-party-[a-z0-9][a-z0-9-]{1,62}[a-z0-9])$/;
const MOBILE_NAV_ORDER_RE = /^(tasks|calendar|kitchen|meals|recipes|shopping|pantry|birthdays|notes|contacts|budget|documents|housekeeping|rewards|health|third-party-[a-z0-9][a-z0-9-]{1,62}[a-z0-9])$/;
const KITCHEN_NAV_IDS = new Set(['kitchen', 'meals', 'recipes', 'shopping', 'pantry']);

// --------------------------------------------------------
// Hilfsfunktionen
// --------------------------------------------------------

function cfgGet(key) {
  const row = db.get().prepare('SELECT value FROM sync_config WHERE key = ?').get(key);
  return row ? row.value : null;
}

function cfgSet(key, value) {
  db.get().prepare(`
    INSERT INTO sync_config (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                   updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  `).run(key, value);
}

function cfgDelete(key) {
  db.get().prepare('DELETE FROM sync_config WHERE key = ?').run(key);
}

function userCfgKey(key, userId) {
  return `${key}:user:${Number(userId)}`;
}

function cfgUserGet(key, userId) {
  if (!userId) return null;
  return cfgGet(userCfgKey(key, userId));
}

function cfgUserSet(key, userId, value) {
  if (!userId) return;
  cfgSet(userCfgKey(key, userId), value);
}

// Per-User-Wetter-Override lesen (null je Feld = erbt Haushalt).
function weatherUserOverride(userId) {
  const autoRaw = cfgUserGet('weather_auto_locate', userId);
  return {
    lat:   cfgUserGet('weather_lat', userId),
    lon:   cfgUserGet('weather_lon', userId),
    city:  cfgUserGet('weather_city', userId),
    units: cfgUserGet('weather_units', userId),
    auto_locate: autoRaw === null ? null : autoRaw === '1',
  };
}

// --------------------------------------------------------
// Widget-Hilfsfunktionen
// --------------------------------------------------------

function parseWidgetConfig(raw) {
  try {
    const parsed = JSON.parse(raw ?? DEFAULT_WIDGET_CONFIG);
    return normalizeWidgetConfig(parsed) ?? [];
  } catch {
    return JSON.parse(DEFAULT_WIDGET_CONFIG);
  }
}

function parseDisabledModules(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((m) => typeof m === 'string' && TOGGLEABLE_MODULES.includes(m));
  } catch {
    return [];
  }
}

function parseModuleOrder(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((id) => typeof id === 'string' && MODULE_ORDER_RE.test(id)))];
  } catch {
    return [];
  }
}

function normalizeMobileNavOrder(order) {
  const normalized = [];

  for (const id of Array.isArray(order) ? order : []) {
    if (typeof id !== 'string' || !MOBILE_NAV_ORDER_RE.test(id)) continue;
    const normalizedId = KITCHEN_NAV_IDS.has(id) ? 'kitchen' : id;
    if (!normalized.includes(normalizedId)) normalized.push(normalizedId);
    if (normalized.length === 3) break;
  }

  return normalized;
}

function parseMobileNavOrder(raw) {
  if (!raw) return [];
  try {
    return normalizeMobileNavOrder(JSON.parse(raw));
  } catch {
    return [];
  }
}

function normalizeWidgetConfig(input) {
  if (!Array.isArray(input) || input.length > MAX_DASHBOARD_WIDGETS) return null;

  const seenIds = new Set();
  const normalized = [];
  for (const [index, widget] of input.entries()) {
    if (!widget || typeof widget !== 'object' || Array.isArray(widget)) return null;
    if (typeof widget.id !== 'string' || !WIDGET_ID_RE.test(widget.id) || seenIds.has(widget.id)) return null;
    if (widget.visible !== undefined && typeof widget.visible !== 'boolean') return null;
    if (widget.order !== undefined && !Number.isFinite(Number(widget.order))) return null;
    if (widget.size !== undefined && !VALID_WIDGET_SIZES.includes(widget.size)) return null;

    seenIds.add(widget.id);
    normalized.push({
      id: widget.id,
      visible: widget.visible !== false,
      order: widget.order === undefined ? index : Number(widget.order),
      size: widget.size ?? '1x1',
    });
  }

  return normalized
    .sort((a, b) => a.order - b.order)
    .map((widget, order) => ({ ...widget, order }));
}

// --------------------------------------------------------
// GET /api/v1/preferences
// Alle Haushalt-Praeferenzen lesen.
// Response: { data: { visible_meal_types: string[] } }
// --------------------------------------------------------

router.get('/', (req, res) => {
  try {
    const raw = cfgGet('visible_meal_types') ?? DEFAULT_MEAL_TYPES;
    const visibleMealTypes = raw.split(',').filter((t) => VALID_MEAL_TYPES.includes(t));
    const currency = cfgGet('currency') ?? DEFAULT_CURRENCY;
    const dateFormat = VALID_DATE_FORMATS.includes(cfgGet('date_format')) ? cfgGet('date_format') : DEFAULT_DATE_FORMAT;
    const timeFormat = VALID_TIME_FORMATS.includes(cfgGet('time_format')) ? cfgGet('time_format') : DEFAULT_TIME_FORMAT;
    const weekStart = VALID_WEEK_STARTS.includes(cfgGet('week_start')) ? cfgGet('week_start') : DEFAULT_WEEK_START;
    const appName = cfgGet('app_name') ?? DEFAULT_APP_NAME;
    const dashboardWidgets = parseWidgetConfig(cfgGet('dashboard_widgets'));
    const disabledModules = parseDisabledModules(cfgGet('disabled_modules'));
    const moduleOrder = parseModuleOrder(cfgUserGet('module_order', req.authUserId) ?? cfgGet('module_order'));
    const mobileNavOrder = parseMobileNavOrder(cfgUserGet('mobile_nav_order', req.authUserId));

    res.json({
      data: {
        visible_meal_types: visibleMealTypes,
        currency,
        date_format: dateFormat,
        time_format: timeFormat,
        week_start: weekStart,
        region: cfgGet('region') || null,
        // Drei Sichten auf dieselbe Einstellung, weil drei verschiedene Fragen
        // dahinterstecken: was ist gewählt (Select-Zustand), was gilt gerade
        // (API-Konsument), und was ergäbe die Automatik (Label der ersten Option).
        language: isSupportedLocale(cfgGet('language')) ? cfgGet('language') : null,
        language_effective: resolveHouseholdLocale(db.get()),
        language_auto: resolveHouseholdLocale(db.get(), { ignoreExplicit: true }),
        app_name: appName,
        dashboard_widgets: dashboardWidgets,
        disabled_modules: disabledModules,
        module_order: moduleOrder,
        mobile_nav_order: mobileNavOrder,
        housekeeping_payment_tasks: cfgGet('housekeeping_payment_tasks') === '1',
        budget_mode: VALID_BUDGET_MODES.includes(cfgGet('budget_mode')) ? cfgGet('budget_mode') : DEFAULT_BUDGET_MODE,
        calendar_default_duration: Number(cfgGet('calendar_default_duration')) || DEFAULT_CALENDAR_DURATION,
        // Standardwerte für neue Termine (per-user, #497/#498).
        calendar_default_reminders: parseDefaultReminders(cfgUserGet('calendar_default_reminders', req.authUserId)),
        calendar_default_assign_me: cfgUserGet('calendar_default_assign_me', req.authUserId) === '1',
        calendar_default_target: cfgUserGet('calendar_default_target', req.authUserId) || '',
        // Modul-Feature-Schalter (haushaltweit). Default an: fehlender Wert =>
        // Feature aktiv, damit Bestandshaushalte ihr Verhalten behalten.
        health_cycle_enabled: cfgGet('health_cycle_enabled') !== '0',
        rewards_require_approval: cfgGet('rewards_require_approval') !== '0',
        tasks_subtasks_expanded: cfgGet('tasks_subtasks_expanded') === '1',
        tasks_default_points: parseTaskDefaultPoints(cfgGet('tasks_default_points')),
        weather_provider: cfgGet('weather_provider') ?? null,
        weather_lat:      cfgGet('weather_lat')      ?? null,
        weather_lon:      cfgGet('weather_lon')      ?? null,
        weather_city:     cfgGet('weather_city')     ?? '',
        weather_units:    cfgGet('weather_units')    ?? 'metric',
        weather_auto_locate: cfgGet('weather_auto_locate') === '1',
        weather_user: weatherUserOverride(req.authUserId),
        holiday_country:       cfgGet('holiday_country')       ?? null,
        holiday_subdivision:   cfgGet('holiday_subdivision')   ?? null,
        holiday_group:         cfgGet('holiday_group')         ?? null,
        holiday_show_public:   cfgGet('holiday_show_public')   === '1',
        holiday_show_school:   cfgGet('holiday_show_school')   === '1',
        holiday_public_color:  cfgGet('holiday_public_color')  ?? '#FF3B30',
        holiday_school_color:  cfgGet('holiday_school_color')  ?? '#34C759',
        holiday_last_sync:     cfgGet('holiday_last_sync')     ?? null,
      },
    });
  } catch (err) {
    log.error('GET /', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// --------------------------------------------------------
// PUT /api/v1/preferences
// Haushalt-Praeferenzen aktualisieren.
// Body: { visible_meal_types: string[] }
// Response: { data: { visible_meal_types: string[] } }
// --------------------------------------------------------

router.put('/', (req, res) => {
  try {
    const { visible_meal_types, currency, date_format, time_format, week_start, region, language, app_name, dashboard_widgets, disabled_modules, module_order, mobile_nav_order, housekeeping_payment_tasks, budget_mode, calendar_default_duration, calendar_default_reminders, calendar_default_assign_me, calendar_default_target, health_cycle_enabled, rewards_require_approval, tasks_subtasks_expanded, tasks_default_points, weather_provider, weather_lat, weather_lon, weather_city, weather_units, weather_auto_locate, weather_user, holiday_country, holiday_subdivision, holiday_group, holiday_show_public, holiday_show_school, holiday_public_color, holiday_school_color } = req.body;

    if (visible_meal_types !== undefined) {
      if (!Array.isArray(visible_meal_types)) {
        return res.status(400).json({ error: 'visible_meal_types muss ein Array sein', code: 400 });
      }
      const filtered = visible_meal_types.filter((t) => VALID_MEAL_TYPES.includes(t));
      if (filtered.length === 0) {
        return res.status(400).json({ error: 'Mindestens ein Mahlzeit-Typ muss aktiv sein', code: 400 });
      }
      cfgSet('visible_meal_types', filtered.join(','));
    }

    if (currency !== undefined) {
      if (!VALID_CURRENCIES.includes(currency)) {
        return res.status(400).json({ error: `Ungültige Währung. Erlaubt: ${VALID_CURRENCIES.join(', ')}`, code: 400 });
      }
      cfgSet('currency', currency);
    }

    if (date_format !== undefined) {
      if (!VALID_DATE_FORMATS.includes(date_format)) {
        return res.status(400).json({ error: `Ungültiges Datumsformat. Erlaubt: ${VALID_DATE_FORMATS.join(', ')}`, code: 400 });
      }
      cfgSet('date_format', date_format);
    }

    if (time_format !== undefined) {
      if (!VALID_TIME_FORMATS.includes(time_format)) {
        return res.status(400).json({ error: `Invalid time format. Allowed: ${VALID_TIME_FORMATS.join(', ')}`, code: 400 });
      }
      cfgSet('time_format', time_format);
    }

    // Wochenstart — haushaltweit, von jedem Mitglied änderbar (wie date/time_format).
    if (week_start !== undefined) {
      if (!VALID_WEEK_STARTS.includes(week_start)) {
        return res.status(400).json({ error: `Ungültiger Wochenstart. Erlaubt: ${VALID_WEEK_STARTS.join(', ')}`, code: 400 });
      }
      cfgSet('week_start', week_start);
    }

    // Budget-Modus — haushaltweite Grundsatzentscheidung, nur Admin (#476/#505).
    if (budget_mode !== undefined) {
      if (req.authRole !== 'admin') {
        return res.status(403).json({ error: 'Admin access required.', code: 403 });
      }
      if (!VALID_BUDGET_MODES.includes(budget_mode)) {
        return res.status(400).json({ error: `Ungültiger Budget-Modus. Erlaubt: ${VALID_BUDGET_MODES.join(', ')}`, code: 400 });
      }
      cfgSet('budget_mode', budget_mode);
    }

    // Welche Region-Vorlage der Nutzer gewählt hat. Nötig, weil sich mehrere
    // Regionen dasselbe currency/date/time-Triple teilen und der Dropdown sonst
    // nach dem Speichern auf die falsche Region springt (#486).
    //
    // Seit die Datensprache aus der Region abgeleitet wird, ist das keine reine
    // Anzeige-Hilfe mehr: eine Region schiebt die Sprache, in der Geburtstags-
    // Termine gespeichert werden. Deshalb dasselbe Admin-Gate wie bei `language`
    // - sonst wäre der dortige Schutz über diesen Umweg zu umgehen. Die Oberfläche
    // behandelte die Region ohnehin immer als Admin-Feld, nur die Route nicht.
    if (region !== undefined) {
      if (req.authRole !== 'admin') {
        return res.status(403).json({ error: 'Admin access required.', code: 403 });
      }
      if (region !== null && (typeof region !== 'string' || !VALID_REGION.test(region))) {
        return res.status(400).json({ error: 'Ungültige Region.', code: 400 });
      }
      cfgSet('region', region ?? '');
    }

    // Datensprache — haushaltweite Grundsatzentscheidung wie Region und Währung,
    // deshalb nur Admin. null/'' stellt auf "automatisch" zurück (aus der Region).
    if (language !== undefined) {
      if (req.authRole !== 'admin') {
        return res.status(403).json({ error: 'Admin access required.', code: 403 });
      }
      if (language !== null && language !== '' && !isSupportedLocale(language)) {
        return res.status(400).json({ error: `Ungültige Sprache. Erlaubt: ${VALID_LANGUAGES.join(', ')}`, code: 400 });
      }
      if (language === null || language === '') cfgDelete('language');
      else cfgSet('language', language);
    }

    if (app_name !== undefined) {
      const vAppName = str(app_name, 'Application name', { max: MAX_SHORT, required: false });
      if (vAppName.error) return res.status(400).json({ error: vAppName.error, code: 400 });
      if (vAppName.value) cfgSet('app_name', vAppName.value);
      else cfgDelete('app_name');
    }

    if (dashboard_widgets !== undefined) {
      if (!Array.isArray(dashboard_widgets)) {
        return res.status(400).json({ error: 'dashboard_widgets muss ein Array sein', code: 400 });
      }
      const normalized = normalizeWidgetConfig(dashboard_widgets);
      if (normalized === null) {
        return res.status(400).json({ error: 'dashboard_widgets enthält ungültige Einträge', code: 400 });
      }
      cfgSet('dashboard_widgets', JSON.stringify(normalized));
    }

    if (disabled_modules !== undefined) {
      if (req.authRole !== 'admin') {
        return res.status(403).json({ error: 'Admin access required.', code: 403 });
      }
      if (!Array.isArray(disabled_modules)) {
        return res.status(400).json({ error: 'disabled_modules muss ein Array sein', code: 400 });
      }
      const filtered = disabled_modules
        .filter((m) => typeof m === 'string' && TOGGLEABLE_MODULES.includes(m));
      const unique = [...new Set(filtered)];
      cfgSet('disabled_modules', JSON.stringify(unique));
    }

    if (module_order !== undefined) {
      if (!Array.isArray(module_order)) {
        return res.status(400).json({ error: 'module_order muss ein Array sein', code: 400 });
      }
      const unique = [...new Set(module_order.filter((id) => typeof id === 'string' && MODULE_ORDER_RE.test(id)))];
      cfgUserSet('module_order', req.authUserId, JSON.stringify(unique));
    }

    if (mobile_nav_order !== undefined) {
      if (!Array.isArray(mobile_nav_order)) {
        return res.status(400).json({ error: 'mobile_nav_order muss ein Array sein', code: 400 });
      }
      cfgUserSet(
        'mobile_nav_order',
        req.authUserId,
        JSON.stringify(normalizeMobileNavOrder(mobile_nav_order)),
      );
    }

    if (housekeeping_payment_tasks !== undefined) {
      if (typeof housekeeping_payment_tasks !== 'boolean') {
        return res.status(400).json({ error: 'housekeeping_payment_tasks must be a boolean', code: 400 });
      }
      cfgSet('housekeeping_payment_tasks', housekeeping_payment_tasks ? '1' : '0');
    }

    if (calendar_default_duration !== undefined) {
      const minutes = Number(calendar_default_duration);
      if (!Number.isInteger(minutes) || minutes < MIN_CALENDAR_DURATION || minutes > MAX_CALENDAR_DURATION) {
        return res.status(400).json({ error: `calendar_default_duration must be an integer between ${MIN_CALENDAR_DURATION} and ${MAX_CALENDAR_DURATION}`, code: 400 });
      }
      cfgSet('calendar_default_duration', String(minutes));
    }

    // Standard-Erinnerungen für neue Termine (#497, per-user).
    if (calendar_default_reminders !== undefined) {
      if (!Array.isArray(calendar_default_reminders)) {
        return res.status(400).json({ error: 'calendar_default_reminders muss ein Array sein', code: 400 });
      }
      const nums = calendar_default_reminders.map(Number);
      if (nums.some((n) => !VALID_REMINDER_OFFSETS.includes(n))) {
        return res.status(400).json({ error: `calendar_default_reminders: erlaubte Offsets (Minuten): ${VALID_REMINDER_OFFSETS.join(', ')}`, code: 400 });
      }
      const unique = [...new Set(nums)].sort((a, b) => a - b);
      if (unique.length > MAX_DEFAULT_REMINDERS) {
        return res.status(400).json({ error: `Maximal ${MAX_DEFAULT_REMINDERS} Standard-Erinnerungen.`, code: 400 });
      }
      cfgUserSet('calendar_default_reminders', req.authUserId, JSON.stringify(unique));
    }

    // Neue Termine standardmäßig mir zuweisen (#498, per-user).
    if (calendar_default_assign_me !== undefined) {
      cfgUserSet('calendar_default_assign_me', req.authUserId, calendar_default_assign_me ? '1' : '0');
    }

    // Standard-Sync-Ziel für eigene neue Termine (#620, per-user).
    if (calendar_default_target !== undefined) {
      if (calendar_default_target !== null && typeof calendar_default_target !== 'string') {
        return res.status(400).json({ error: 'calendar_default_target muss ein String sein', code: 400 });
      }
      const target = (calendar_default_target ?? '').trim();
      if (target.length > MAX_CALENDAR_TARGET_LENGTH) {
        return res.status(400).json({ error: `calendar_default_target: maximal ${MAX_CALENDAR_TARGET_LENGTH} Zeichen`, code: 400 });
      }
      // Leer = "Lokal speichern" und damit das ausdrückliche Abwählen eines
      // zuvor gesetzten Ziels. parseSyncTargetValue liefert dafür {kind:'local'},
      // also einen gültigen Wert, und null nur bei echtem Formfehler.
      if (parseSyncTargetValue(target) === null) {
        return res.status(400).json({ error: 'calendar_default_target: erwartet "google:<id>", "caldav:<kontoId>|<url>" oder "outlook:<kontoId>|<kalenderId>"', code: 400 });
      }
      cfgUserSet('calendar_default_target', req.authUserId, target);
    }

    // Haushaltweite Modul-Feature-Schalter — nur Admins.
    if (health_cycle_enabled !== undefined) {
      if (req.authRole !== 'admin') {
        return res.status(403).json({ error: 'Admin access required.', code: 403 });
      }
      if (typeof health_cycle_enabled !== 'boolean') {
        return res.status(400).json({ error: 'health_cycle_enabled must be a boolean', code: 400 });
      }
      cfgSet('health_cycle_enabled', health_cycle_enabled ? '1' : '0');
    }

    if (rewards_require_approval !== undefined) {
      if (req.authRole !== 'admin') {
        return res.status(403).json({ error: 'Admin access required.', code: 403 });
      }
      if (typeof rewards_require_approval !== 'boolean') {
        return res.status(400).json({ error: 'rewards_require_approval must be a boolean', code: 400 });
      }
      cfgSet('rewards_require_approval', rewards_require_approval ? '1' : '0');
    }

    if (tasks_subtasks_expanded !== undefined) {
      if (req.authRole !== 'admin') {
        return res.status(403).json({ error: 'Admin access required.', code: 403 });
      }
      if (typeof tasks_subtasks_expanded !== 'boolean') {
        return res.status(400).json({ error: 'tasks_subtasks_expanded must be a boolean', code: 400 });
      }
      cfgSet('tasks_subtasks_expanded', tasks_subtasks_expanded ? '1' : '0');
    }

    // Standard-Punktwert für neue Aufgaben (#578). 0 schaltet den Standard ab.
    if (tasks_default_points !== undefined) {
      if (req.authRole !== 'admin') {
        return res.status(403).json({ error: 'Admin access required.', code: 403 });
      }
      const points = Number(tasks_default_points);
      if (!Number.isInteger(points) || points < 0 || points > MAX_TASK_POINTS) {
        return res.status(400).json({ error: `tasks_default_points must be an integer between 0 and ${MAX_TASK_POINTS}`, code: 400 });
      }
      cfgSet('tasks_default_points', String(points));
    }

    // Weather configuration — admin only
    if (
      weather_provider !== undefined ||
      weather_lat      !== undefined ||
      weather_lon      !== undefined ||
      weather_city     !== undefined ||
      weather_units    !== undefined ||
      weather_auto_locate !== undefined
    ) {
      if (req.authRole !== 'admin') {
        return res.status(403).json({ error: 'Admin access required.', code: 403 });
      }
      if (weather_provider !== undefined) {
        if (weather_provider !== null && !VALID_WEATHER_PROVIDERS.includes(weather_provider)) {
          return res.status(400).json({ error: `Ungültiger Anbieter. Erlaubt: ${VALID_WEATHER_PROVIDERS.join(', ')}`, code: 400 });
        }
        if (weather_provider === null) cfgDelete('weather_provider');
        else cfgSet('weather_provider', weather_provider);
      }
      if (weather_lat !== undefined) {
        const v = parseFloat(weather_lat);
        if (isNaN(v) || v < -90 || v > 90) {
          return res.status(400).json({ error: 'Ungültiger Breitengrad (–90 bis 90).', code: 400 });
        }
        cfgSet('weather_lat', String(v));
      }
      if (weather_lon !== undefined) {
        const v = parseFloat(weather_lon);
        if (isNaN(v) || v < -180 || v > 180) {
          return res.status(400).json({ error: 'Ungültiger Längengrad (–180 bis 180).', code: 400 });
        }
        cfgSet('weather_lon', String(v));
      }
      if (weather_city !== undefined) {
        const trimmed = String(weather_city).slice(0, 100).trim();
        if (trimmed) cfgSet('weather_city', trimmed);
        else cfgDelete('weather_city');
      }
      if (weather_units !== undefined) {
        if (!VALID_WEATHER_UNITS.includes(weather_units)) {
          return res.status(400).json({ error: `Ungültige Einheit. Erlaubt: ${VALID_WEATHER_UNITS.join(', ')}`, code: 400 });
        }
        cfgSet('weather_units', weather_units);
      }
      if (weather_auto_locate !== undefined) {
        if (typeof weather_auto_locate !== 'boolean') {
          return res.status(400).json({ error: 'weather_auto_locate muss ein Boolean sein.', code: 400 });
        }
        cfgSet('weather_auto_locate', weather_auto_locate ? '1' : '0');
      }
    }

    // Per-User-Wetter-Override — von jedem authentifizierten Nutzer schreibbar.
    if (weather_user !== undefined) {
      if (typeof weather_user !== 'object' || weather_user === null || Array.isArray(weather_user)) {
        return res.status(400).json({ error: 'weather_user muss ein Objekt sein.', code: 400 });
      }
      const uid = req.authUserId;
      if (!uid) {
        return res.status(401).json({ error: 'Authentifizierung erforderlich.', code: 401 });
      }
      const { lat, lon, city, units, auto_locate } = weather_user;

      if (lat !== undefined) {
        if (lat === null) cfgDelete(userCfgKey('weather_lat', uid));
        else {
          const v = parseFloat(lat);
          if (isNaN(v) || v < -90 || v > 90) {
            return res.status(400).json({ error: 'Ungültiger Breitengrad (–90 bis 90).', code: 400 });
          }
          cfgUserSet('weather_lat', uid, String(v));
        }
      }
      if (lon !== undefined) {
        if (lon === null) cfgDelete(userCfgKey('weather_lon', uid));
        else {
          const v = parseFloat(lon);
          if (isNaN(v) || v < -180 || v > 180) {
            return res.status(400).json({ error: 'Ungültiger Längengrad (–180 bis 180).', code: 400 });
          }
          cfgUserSet('weather_lon', uid, String(v));
        }
      }
      if (city !== undefined) {
        const trimmed = city === null ? '' : String(city).slice(0, 100).trim();
        if (trimmed) cfgUserSet('weather_city', uid, trimmed);
        else cfgDelete(userCfgKey('weather_city', uid));
      }
      if (units !== undefined) {
        if (units === null) cfgDelete(userCfgKey('weather_units', uid));
        else {
          if (!VALID_WEATHER_UNITS.includes(units)) {
            return res.status(400).json({ error: `Ungültige Einheit. Erlaubt: ${VALID_WEATHER_UNITS.join(', ')}`, code: 400 });
          }
          cfgUserSet('weather_units', uid, units);
        }
      }
      if (auto_locate !== undefined) {
        if (auto_locate === null) cfgDelete(userCfgKey('weather_auto_locate', uid));
        else {
          if (typeof auto_locate !== 'boolean') {
            return res.status(400).json({ error: 'weather_user.auto_locate muss ein Boolean sein.', code: 400 });
          }
          cfgUserSet('weather_auto_locate', uid, auto_locate ? '1' : '0');
        }
      }
    }

    // Holiday configuration — admin only
    if (
      holiday_country      !== undefined ||
      holiday_subdivision  !== undefined ||
      holiday_group        !== undefined ||
      holiday_show_public  !== undefined ||
      holiday_show_school  !== undefined ||
      holiday_public_color !== undefined ||
      holiday_school_color !== undefined
    ) {
      if (req.authRole !== 'admin') {
        return res.status(403).json({ error: 'Admin access required.', code: 403 });
      }
      if (holiday_country !== undefined) {
        if (holiday_country !== null && !COUNTRY_ISO_RE.test(holiday_country)) {
          return res.status(400).json({ error: 'Ungültiger Ländercode (2 Großbuchstaben, z. B. DE).', code: 400 });
        }
        if (holiday_country === null) {
          cfgDelete('holiday_country');
          cfgDelete('holiday_subdivision');
          cfgDelete('holiday_group');
        } else {
          cfgSet('holiday_country', holiday_country);
        }
      }
      if (holiday_subdivision !== undefined) {
        if (holiday_subdivision !== null && !SUBDIVISION_RE.test(holiday_subdivision)) {
          return res.status(400).json({ error: 'Ungültiger Regionscode (z. B. DE-BY).', code: 400 });
        }
        // Ohne Subdivision gibt es keine Schulferien-Gruppe mehr → mit aufräumen.
        if (holiday_subdivision === null) {
          cfgDelete('holiday_subdivision');
          cfgDelete('holiday_group');
        } else {
          cfgSet('holiday_subdivision', holiday_subdivision);
        }
      }
      // Schulferien-Gruppe (z. B. CH-BE-VS) mehrsprachiger Kantone. Nutzt dieselbe
      // Grammatik wie ein Regionscode. NULL/leer = keine Gruppe gewählt. (#434)
      if (holiday_group !== undefined) {
        if (holiday_group !== null && holiday_group !== '' && !SUBDIVISION_RE.test(holiday_group)) {
          return res.status(400).json({ error: 'Ungültiger Gruppencode (z. B. CH-BE-VS).', code: 400 });
        }
        if (holiday_group === null || holiday_group === '') cfgDelete('holiday_group');
        else cfgSet('holiday_group', holiday_group);
      }
      if (holiday_show_public !== undefined) {
        if (typeof holiday_show_public !== 'boolean') {
          return res.status(400).json({ error: 'holiday_show_public must be a boolean.', code: 400 });
        }
        cfgSet('holiday_show_public', holiday_show_public ? '1' : '0');
      }
      if (holiday_show_school !== undefined) {
        if (typeof holiday_show_school !== 'boolean') {
          return res.status(400).json({ error: 'holiday_show_school must be a boolean.', code: 400 });
        }
        cfgSet('holiday_show_school', holiday_show_school ? '1' : '0');
      }
      if (holiday_public_color !== undefined) {
        if (!HEX_COLOR_RE.test(holiday_public_color)) {
          return res.status(400).json({ error: 'holiday_public_color muss ein gültiger Hex-Farbwert sein (z. B. #FF3B30).', code: 400 });
        }
        cfgSet('holiday_public_color', holiday_public_color);
      }
      if (holiday_school_color !== undefined) {
        if (!HEX_COLOR_RE.test(holiday_school_color)) {
          return res.status(400).json({ error: 'holiday_school_color muss ein gültiger Hex-Farbwert sein (z. B. #34C759).', code: 400 });
        }
        cfgSet('holiday_school_color', holiday_school_color);
      }
    }

    const rawMealTypes = cfgGet('visible_meal_types') ?? DEFAULT_MEAL_TYPES;
    const savedMealTypes = rawMealTypes.split(',').filter((t) => VALID_MEAL_TYPES.includes(t));
    const savedCurrency = cfgGet('currency') ?? DEFAULT_CURRENCY;
    const savedDateFormat = VALID_DATE_FORMATS.includes(cfgGet('date_format')) ? cfgGet('date_format') : DEFAULT_DATE_FORMAT;
    const savedTimeFormat = VALID_TIME_FORMATS.includes(cfgGet('time_format')) ? cfgGet('time_format') : DEFAULT_TIME_FORMAT;
    const savedWeekStart = VALID_WEEK_STARTS.includes(cfgGet('week_start')) ? cfgGet('week_start') : DEFAULT_WEEK_START;
    const savedAppName = cfgGet('app_name') ?? DEFAULT_APP_NAME;
    const savedWidgets = parseWidgetConfig(cfgGet('dashboard_widgets'));
    const savedDisabledModules = parseDisabledModules(cfgGet('disabled_modules'));
    const savedModuleOrder = parseModuleOrder(cfgUserGet('module_order', req.authUserId) ?? cfgGet('module_order'));
    const savedMobileNavOrder = parseMobileNavOrder(cfgUserGet('mobile_nav_order', req.authUserId));
    const savedHousekeepingPaymentTasks = cfgGet('housekeeping_payment_tasks') === '1';

    res.json({
      data: {
        visible_meal_types: savedMealTypes,
        currency: savedCurrency,
        date_format: savedDateFormat,
        time_format: savedTimeFormat,
        week_start: savedWeekStart,
        region: cfgGet('region') || null,
        language: isSupportedLocale(cfgGet('language')) ? cfgGet('language') : null,
        language_effective: resolveHouseholdLocale(db.get()),
        language_auto: resolveHouseholdLocale(db.get(), { ignoreExplicit: true }),
        app_name: savedAppName,
        dashboard_widgets: savedWidgets,
        disabled_modules: savedDisabledModules,
        module_order: savedModuleOrder,
        mobile_nav_order: savedMobileNavOrder,
        housekeeping_payment_tasks: savedHousekeepingPaymentTasks,
        budget_mode: VALID_BUDGET_MODES.includes(cfgGet('budget_mode')) ? cfgGet('budget_mode') : DEFAULT_BUDGET_MODE,
        calendar_default_duration: Number(cfgGet('calendar_default_duration')) || DEFAULT_CALENDAR_DURATION,
        calendar_default_reminders: parseDefaultReminders(cfgUserGet('calendar_default_reminders', req.authUserId)),
        calendar_default_assign_me: cfgUserGet('calendar_default_assign_me', req.authUserId) === '1',
        calendar_default_target: cfgUserGet('calendar_default_target', req.authUserId) || '',
        health_cycle_enabled: cfgGet('health_cycle_enabled') !== '0',
        rewards_require_approval: cfgGet('rewards_require_approval') !== '0',
        tasks_subtasks_expanded: cfgGet('tasks_subtasks_expanded') === '1',
        tasks_default_points: parseTaskDefaultPoints(cfgGet('tasks_default_points')),
        weather_provider: cfgGet('weather_provider') ?? null,
        weather_lat:      cfgGet('weather_lat')      ?? null,
        weather_lon:      cfgGet('weather_lon')      ?? null,
        weather_city:     cfgGet('weather_city')     ?? '',
        weather_units:    cfgGet('weather_units')    ?? 'metric',
        weather_auto_locate: cfgGet('weather_auto_locate') === '1',
        weather_user: weatherUserOverride(req.authUserId),
        holiday_country:       cfgGet('holiday_country')       ?? null,
        holiday_subdivision:   cfgGet('holiday_subdivision')   ?? null,
        holiday_group:         cfgGet('holiday_group')         ?? null,
        holiday_show_public:   cfgGet('holiday_show_public')   === '1',
        holiday_show_school:   cfgGet('holiday_show_school')   === '1',
        holiday_public_color:  cfgGet('holiday_public_color')  ?? '#FF3B30',
        holiday_school_color:  cfgGet('holiday_school_color')  ?? '#34C759',
        holiday_last_sync:     cfgGet('holiday_last_sync')     ?? null,
      },
    });
  } catch (err) {
    log.error('PUT /', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  } finally {
    // Gespeicherte Geburtstags-Termine an die geltende Datensprache angleichen.
    //
    // Unbedingt statt nur bei erkannter Verschiebung: retitleBirthdayEvents
    // vergleicht ohnehin pro Zeile und schreibt nur, was abweicht. Ein Vergleich
    // vorher/nachher wäre ein zweiter Ort, an dem alle Wege zur Datensprache
    // (language, region, date_format) vollständig aufgezählt sein müssten.
    //
    // Im finally, weil der Handler schreibt und validiert, während er durch die
    // Felder läuft: ein Batch aus gültiger `language` und einem später
    // abgelehnten Feld verlässt ihn über ein `return res.status(400)`, hat die
    // Sprache aber schon geschrieben. Am Ende des try-Blocks bliebe der Haushalt
    // dann auf einer neuen Sprache mit alten Titeln sitzen.
    //
    // Fehler beenden die Anfrage nicht: die Antwort ist zu diesem Zeitpunkt
    // längst gesendet, und die Präferenzen sind geschrieben. Der nächste PUT
    // versucht es erneut - der Lauf ist idempotent.
    try {
      db.transaction(() => retitleBirthdayEvents(db.get()));
    } catch (err) {
      log.error('PUT / - Geburtstags-Termine konnten nicht umbenannt werden', err);
    }
  }
});

// GET /api/v1/preferences/holidays/countries
router.get('/holidays/countries', async (_req, res) => {
  try {
    const countries = await holidays.getCountries();
    res.json({ data: countries });
  } catch (err) {
    log.error('GET /holidays/countries', err);
    res.status(502).json({ error: 'Fehler beim Abrufen der Länderliste.', code: 502 });
  }
});

// GET /api/v1/preferences/holidays/subdivisions/:countryCode
router.get('/holidays/subdivisions/:countryCode', async (req, res) => {
  const { countryCode } = req.params;
  if (!COUNTRY_ISO_RE.test(countryCode)) {
    return res.status(400).json({ error: 'Ungültiger Ländercode.', code: 400 });
  }
  try {
    const subdivisions = await holidays.getSubdivisions(countryCode);
    res.json({ data: subdivisions });
  } catch (err) {
    log.error('GET /holidays/subdivisions/:countryCode', err);
    res.status(502).json({ error: 'Fehler beim Abrufen der Regionsliste.', code: 502 });
  }
});

// GET /api/v1/preferences/holidays/groups/:countryCode/:subdivisionCode
// Schulferien-Gruppen einer Subdivision (mehrsprachige Kantone). Leere Liste,
// wenn die Subdivision nur ein Ferien-Regime kennt. (#434)
router.get('/holidays/groups/:countryCode/:subdivisionCode', async (req, res) => {
  const { countryCode, subdivisionCode } = req.params;
  if (!COUNTRY_ISO_RE.test(countryCode)) {
    return res.status(400).json({ error: 'Ungültiger Ländercode.', code: 400 });
  }
  if (!SUBDIVISION_RE.test(subdivisionCode)) {
    return res.status(400).json({ error: 'Ungültiger Regionscode.', code: 400 });
  }
  try {
    const groups = await holidays.getGroups(countryCode, subdivisionCode);
    res.json({ data: groups });
  } catch (err) {
    log.error('GET /holidays/groups/:countryCode/:subdivisionCode', err);
    res.status(502).json({ error: 'Fehler beim Abrufen der Ferien-Gruppen.', code: 502 });
  }
});

// POST /api/v1/preferences/holidays/sync  (admin only)
router.post('/holidays/sync', async (req, res) => {
  if (req.authRole !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.', code: 403 });
  }
  try {
    await holidays.sync(true);
    res.json({ data: { last_sync: cfgGet('holiday_last_sync') ?? null } });
  } catch (err) {
    log.error('POST /holidays/sync', err);
    res.status(502).json({ error: 'Fehler bei der Feiertags-Synchronisierung: ' + err.message, code: 502 });
  }
});

export default router;
