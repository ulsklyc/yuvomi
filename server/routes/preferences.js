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

const log = createLogger('Preferences');

const router = express.Router();

const VALID_MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'];
const DEFAULT_MEAL_TYPES = VALID_MEAL_TYPES.join(',');

const VALID_CURRENCIES = ['AED', 'AUD', 'BRL', 'CAD', 'CHF', 'CNY', 'CZK', 'DKK', 'EUR', 'GBP', 'HUF', 'INR', 'JPY', 'KZT', 'NOK', 'PLN', 'RUB', 'SAR', 'SEK', 'TRY', 'UAH', 'USD'];
const DEFAULT_CURRENCY = 'EUR';
const DEFAULT_APP_NAME = 'Yuvomi';

const VALID_DATE_FORMATS = ['mdy', 'dmy', 'ymd', 'mdy_dot', 'dmy_dot', 'dmy_slash', 'ymd_dot', 'ymd_slash'];
const DEFAULT_DATE_FORMAT = 'mdy';
const VALID_TIME_FORMATS = ['24h', '12h'];
const DEFAULT_TIME_FORMAT = '24h';

const VALID_WEATHER_PROVIDERS = ['open-meteo', 'openweathermap'];
const VALID_WEATHER_UNITS = ['metric', 'imperial'];

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const COUNTRY_ISO_RE = /^[A-Z]{2}$/;
const SUBDIVISION_RE = /^[A-Z]{2}-[A-Z0-9-]{1,10}$/;

// Order defines the default dashboard layout (weather first, then primary content).
// Must stay in sync with WIDGET_IDS in public/pages/dashboard.js.
const VALID_WIDGET_IDS = ['weather', 'tasks', 'calendar', 'meals', 'shopping', 'birthdays', 'budget', 'family', 'notes'];
const VALID_WIDGET_SIZES = ['1x1', '1x2', '1x3', '1x4', '2x1', '2x2', '2x3', '2x4', '3x1', '3x2', '3x3', '3x4', '4x1', '4x2', '4x3', '4x4'];

// Modul-Slugs, die per Settings deaktiviert werden können.
// Dashboard und Settings sind absichtlich nicht enthalten — sie sind essentiell.
const TOGGLEABLE_MODULES = [
  'tasks', 'calendar', 'meals', 'recipes', 'shopping',
  'birthdays', 'notes', 'contacts', 'budget', 'documents',
  'housekeeping',
];
const MODULE_ORDER_RE = /^(dashboard|tasks|calendar|meals|recipes|shopping|birthdays|notes|contacts|budget|documents|housekeeping|third-party-[a-z0-9][a-z0-9-]{1,62}[a-z0-9])$/;
const MOBILE_NAV_ORDER_RE = /^(tasks|calendar|kitchen|meals|recipes|shopping|birthdays|notes|contacts|budget|documents|housekeeping|third-party-[a-z0-9][a-z0-9-]{1,62}[a-z0-9])$/;
const KITCHEN_NAV_IDS = new Set(['kitchen', 'meals', 'recipes', 'shopping']);

function defaultWidgetSize(id) {
  if (['tasks', 'calendar'].includes(id)) return '2x2';
  if (['weather', 'shopping', 'notes'].includes(id)) return '2x1';
  return '1x1';
}

const DEFAULT_WIDGET_CONFIG = JSON.stringify(VALID_WIDGET_IDS.map((id, order) => ({
  id,
  visible: true,
  order,
  size: defaultWidgetSize(id),
})));

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

// --------------------------------------------------------
// Widget-Hilfsfunktionen
// --------------------------------------------------------

function parseWidgetConfig(raw) {
  try {
    const parsed = JSON.parse(raw ?? DEFAULT_WIDGET_CONFIG);
    return normalizeWidgetConfig(parsed);
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
  const valid = Array.isArray(input)
    ? input
      .filter((w) => w && typeof w === 'object' && VALID_WIDGET_IDS.includes(w.id))
      .map((w, order) => ({
        id: w.id,
        visible: w.visible !== false,
        order: Number.isFinite(Number(w.order)) ? Number(w.order) : order,
        size: VALID_WIDGET_SIZES.includes(w.size) ? w.size : defaultWidgetSize(w.id),
      }))
    : [];

  // Fehlende Widget-IDs am Ende ergänzen
  const presentIds = new Set(valid.map((w) => w.id));
  for (const id of VALID_WIDGET_IDS) {
    if (!presentIds.has(id)) {
      valid.push({ id, visible: true, order: valid.length, size: defaultWidgetSize(id) });
    }
  }
  return valid
    .sort((a, b) => a.order - b.order)
    .map((w, order) => ({ ...w, order }));
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
        app_name: appName,
        dashboard_widgets: dashboardWidgets,
        disabled_modules: disabledModules,
        module_order: moduleOrder,
        mobile_nav_order: mobileNavOrder,
        housekeeping_payment_tasks: cfgGet('housekeeping_payment_tasks') === '1',
        weather_provider: cfgGet('weather_provider') ?? null,
        weather_lat:      cfgGet('weather_lat')      ?? null,
        weather_lon:      cfgGet('weather_lon')      ?? null,
        weather_city:     cfgGet('weather_city')     ?? '',
        weather_units:    cfgGet('weather_units')    ?? 'metric',
        weather_auto_locate: cfgGet('weather_auto_locate') === '1',
        holiday_country:       cfgGet('holiday_country')       ?? null,
        holiday_subdivision:   cfgGet('holiday_subdivision')   ?? null,
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
    const { visible_meal_types, currency, date_format, time_format, app_name, dashboard_widgets, disabled_modules, module_order, mobile_nav_order, housekeeping_payment_tasks, weather_provider, weather_lat, weather_lon, weather_city, weather_units, weather_auto_locate, holiday_country, holiday_subdivision, holiday_show_public, holiday_show_school, holiday_public_color, holiday_school_color } = req.body;

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

    // Holiday configuration — admin only
    if (
      holiday_country      !== undefined ||
      holiday_subdivision  !== undefined ||
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
        } else {
          cfgSet('holiday_country', holiday_country);
        }
      }
      if (holiday_subdivision !== undefined) {
        if (holiday_subdivision !== null && !SUBDIVISION_RE.test(holiday_subdivision)) {
          return res.status(400).json({ error: 'Ungültiger Regionscode (z. B. DE-BY).', code: 400 });
        }
        if (holiday_subdivision === null) cfgDelete('holiday_subdivision');
        else cfgSet('holiday_subdivision', holiday_subdivision);
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
        app_name: savedAppName,
        dashboard_widgets: savedWidgets,
        disabled_modules: savedDisabledModules,
        module_order: savedModuleOrder,
        mobile_nav_order: savedMobileNavOrder,
        housekeeping_payment_tasks: savedHousekeepingPaymentTasks,
        weather_provider: cfgGet('weather_provider') ?? null,
        weather_lat:      cfgGet('weather_lat')      ?? null,
        weather_lon:      cfgGet('weather_lon')      ?? null,
        weather_city:     cfgGet('weather_city')     ?? '',
        weather_units:    cfgGet('weather_units')    ?? 'metric',
        weather_auto_locate: cfgGet('weather_auto_locate') === '1',
        holiday_country:       cfgGet('holiday_country')       ?? null,
        holiday_subdivision:   cfgGet('holiday_subdivision')   ?? null,
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
