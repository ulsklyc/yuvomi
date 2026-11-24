/**
 * Modul: Haushalt-Einstellungen (Preferences)
 * Zweck: REST-API fuer haushaltweite und persoenliche Praeferenzen. Welche
 *        Einstellungen es gibt, wo sie liegen, wer sie schreiben darf, ihre
 *        Vorgaben und Pruefungen stehen im Register server/settings/registry.ts
 *        (Phase 2, C3); diese Route haelt die Transaktion, die Abbildung einer
 *        Absage auf HTTP, die Display-Allowlist, die Sichten mit Dienstbezug und
 *        die Feiertags-Unterrouten.
 *        Jede Route prueft die Anfrage vor dem Handler gegen ihre Operation im
 *        OpenAPI-Dokument (`validateRequest()`, #2810 Gruppe 11b). Den Rumpf
 *        von PUT / prueft das Dokument nur als Objekt: Form, Bereich und
 *        Schreibrecht jedes Felds bleiben im Register, damit ein Mitglied auf
 *        ein Admin-Feld weiter 403 bekommt und keine zweite Regelkopie entsteht.
 *        Die Muster der Laender- und Regionscodes in den Feiertagspfaden prueft
 *        allein das Dokument (#2810 Gruppe 11b, Schritt b). Ein unerwarteter
 *        Fehler geht an den zentralen Fehlerhandler
 *        (server/middleware/error-handler.js); eigene Antworten behalten nur die
 *        Feiertagslisten (502) und der Feiertags-Sync (502 mit Fehlerklasse).
 * Abhängigkeiten: express, server/db.js, server/settings/registry.ts
 */

import { createLogger } from '../logger.js';
import { pickDisplayPreferences } from '../display-scopes.js';
import express from 'express';
import * as db from '../db.js';
import * as holidays from '../services/holidays.js';
import { refuseAdmin, isAdminRequest } from '../middleware/require-admin.js';
import { actorFromRequest } from '../authorize/index.ts';
import { supportedLocaleFor } from '../utils/i18n.js';
import { retitleBirthdayEvents } from '../services/birthdays.js';
import { resolveWeatherSource } from '../services/weather-source.js';
import { listVisibleCategories } from '../services/note-categories.js';
import { syncPreventionRemindersForSubject } from '../services/prevention-reminders.js';
import { syncAllFastingReminders } from '../services/fasting-reminders.js';
import { isScreensaverEnabled } from './screensaver.js';
import { rekeyForHouseholdZoneChange } from '../services/calendar-occurrence-overrides.js';
import { readSetting, readSettings, writeSettings } from '../settings/registry.ts';
import { remoteFailure } from '../utils/http.js';
import { validateRequest } from '../api/validate-request.ts';

const log = createLogger('Preferences');

const router = express.Router();

// --------------------------------------------------------
// Sichten mit Dienstbezug - sie bleiben in der Route, weil sie einen Dienst
// brauchen, den das Register (ein Blatt unter den Diensten) nicht kennt.
// --------------------------------------------------------

function sanitizeNoteCategoryOptions(config, visibleCategories) {
  return config.map((widget) => {
    if (widget.id !== 'notes' || !Array.isArray(widget.options?.categories)) return widget;
    const categories = widget.options.categories.filter((id) => visibleCategories().has(String(id)));
    const options = { ...widget.options };
    if (categories.length) options.categories = categories;
    else delete options.categories;
    const next = { ...widget };
    if (Object.keys(options).length) next.options = options;
    else delete next.options;
    return next;
  });
}

/**
 * Die Kategorie-Filter der Notiz-Kachel auf das, was diese Person sieht - in
 * der eigenen Anordnung und in der Vorgabe des Haushalts. Die Anordnungen
 * selbst (eigene, sonst die des Haushalts, #585/#827) liest das Register.
 *
 * Request-lokal und faul: keine Katalog-Abfrage fuer fehlende oder leere
 * Filter, und ein gemeinsamer Sichtbarkeits-Schnappschuss fuer beide.
 */
function withVisibleNoteCategories(settings, database, userId) {
  let visible;
  const visibleCategories = () => (visible ??= new Set(
    listVisibleCategories(database, userId).map((category) => String(category.id)),
  ));
  settings.dashboard_widgets = sanitizeNoteCategoryOptions(settings.dashboard_widgets, visibleCategories);
  if (settings.dashboard_widgets_default !== null) {
    settings.dashboard_widgets_default = sanitizeNoteCategoryOptions(settings.dashboard_widgets_default, visibleCategories);
  }
  return settings;
}

// Woher das Wetter des HAUSHALTS kommt: 'db' (hier gespeichert), 'env'
// (`WEATHER_*`/`OPENWEATHER_*` aus der `.env`, z. B. vom Web-Installer) oder
// 'none'. Dieselbe Regel wie im Wetter-Proxy, damit die Admin-Seite nicht
// "Nicht konfiguriert" sagt, waehrend das Dashboard Wetter zeigt. Der
// Standort je Mitglied bleibt bewusst aussen vor - er ist keine
// Haushaltseinstellung. Ein API-Key steht nie in der Antwort.
function householdWeatherSource(settings) {
  return resolveWeatherSource({
    provider: settings.weather_provider,
    lat:      settings.weather_lat,
    lon:      settings.weather_lon,
    city:     settings.weather_city,
    units:    settings.weather_units,
  });
}

/** `extra` hinter `key` einsetzen - die Feldfolge der Antwort bleibt die von vor C3. */
function insertAfter(object, key, extra) {
  const out = {};
  for (const [name, value] of Object.entries(object)) {
    out[name] = value;
    if (name === key) Object.assign(out, extra);
  }
  return out;
}

/** Die Antwort von GET (`withWeatherSource`) und PUT. */
function settingsAnswer(database, userId, { withWeatherSource = false } = {}) {
  const settings = withVisibleNoteCategories(readSettings(database, userId), database, userId);
  return withWeatherSource
    ? insertAfter(settings, 'weather_user', { weather_source: householdWeatherSource(settings) })
    : settings;
}

// Die Seiteneffekte, die das Register beim Schreiben anstoesst - es kennt die
// Dienste nicht, die Route reicht sie hinein.
const SETTINGS_EFFECTS = Object.freeze({
  householdZoneChanged: (database, zoneBefore, zoneAfter) => rekeyForHouseholdZoneChange(database, zoneBefore, zoneAfter),
  healthModuleToggled: (database) => syncAllFastingReminders(database),
  // Der Vorsorge-Sync nach dem Opt-in (D6/Review #1256): ein Fehler wird nur
  // geloggt, die Patch steht trotzdem.
  preventionCaregiversChanged(database, userId) {
    try { syncPreventionRemindersForSubject(database, userId); } catch (err) {
      log.error('Error syncing prevention reminders after notify_caregivers change:', err.message);
    }
  },
});

/** Eine Absage des Registers als HTTP-Antwort - die 403 ist die eine Form aus C2. */
function sendRefusal(req, res, refusal) {
  if (refusal.kind === 'forbidden') return refuseAdmin(req, res);
  if (refusal.kind === 'unauthenticated') return res.status(401).json({ error: 'Not authenticated.', code: 401 });
  return res.status(400).json({ error: refusal.message, code: 400 });
}

// --------------------------------------------------------
// GET /api/v1/preferences
// Alle Praeferenzen lesen (Haushalt und eigene).
// --------------------------------------------------------

router.get('/', validateRequest(), (req, res) => {
  const data = settingsAnswer(db.get(), req.authUserId, { withWeatherSource: true });
  // A derived flag (#1766): true when Immich is configured and, for a
  // paired display, when an admin has switched the screensaver on for it.
  data.screensaver_enabled = isScreensaverEnabled() && (req.authMethod !== 'display' || req.displayShowsScreensaver === true);
  // EIN WANDTABLETT BEKOMMT NUR DEN DARSTELLUNGSTEIL (#1208). Diese Antwort
  // ist die Sammelstelle des ganzen Haushalts - Wohnkoordinaten,
  // Budget-Betriebsart, Zyklus-Einstellungen, Sync-Ziele -, und sie steht dem
  // Display nur offen, weil die App ohne sie nicht startet. Was uebrig
  // bleibt, ist eine Allowlist in display-scopes.js.
  if (req.authMethod === 'display') data.display_device_settings = req.displayDeviceSettings ?? null;
  res.json({ data: req.authMethod === 'display' ? pickDisplayPreferences(data) : data });
});

// --------------------------------------------------------
// PUT /api/v1/preferences
// Praeferenzen aktualisieren (Haushalt und eigene).
//
// GANZE PATCH ODER NICHTS (#1622). Das Register prueft und schreibt Feld fuer
// Feld in seiner Reihenfolge, und das erste abgelehnte Feld beendet den
// Handler mit seiner Absage (400, 401, 403). Damit die Felder davor dann nicht
// stehen bleiben, laeuft die ganze Feldfolge in EINER Transaktion: COMMIT steht
// genau einmal, hinter dem letzten Feld und der fertig gebauten Erfolgsantwort,
// unmittelbar vor dem Senden; jeder andere Ausgang
// (400, 401, 403, geworfener Fehler) findet im finally eine offene Transaktion
// vor und rollt sie zurueck. Ein geworfener Fehler laeuft nach dem finally
// weiter an den zentralen Fehlerhandler (500, #2810 Gruppe 11b). Ein neues
// Feld im Register ist damit von selbst abgedeckt - es muss dafuer nichts nach
// oben gezogen werden.
//
// BEGIN/COMMIT von Hand statt `db.transaction(fn)`: der Helfer committet bei
// jedem normalen Ruecksprung, ein `return res.status(400)` waere fuer ihn ein
// Erfolg. Verschachtelte `transaction()`-Aufrufe im Register bleiben
// richtig - der Treiber macht aus ihnen Savepoints, sobald eine Transaktion
// offen ist. Der Treiber ist synchron und zwischen BEGIN und COMMIT steht kein
// `await`; kaeme eines dazu, laege die offene Transaktion ueber fremden Requests.
// --------------------------------------------------------

router.put('/', validateRequest(), (req, res) => {
  let database = null;
  try {
    database = db.get();
    database.exec('BEGIN');
    const refusal = writeSettings(database, actorFromRequest(req), req.body, SETTINGS_EFFECTS);
    if (refusal) return sendRefusal(req, res, refusal);

    // DIE ANTWORT WIRD NOCH IN DER TRANSAKTION GEBAUT (#1622, Review zu #1627).
    // Sie liest aus der Datenbank zurueck, und manche dieser Lesewege fragen
    // weitere Tabellen ab (der Filter der Notiz-Kachel den Kategorien-Katalog).
    // Wirft einer davon NACH dem COMMIT, sagt die Antwort 500 und die Patch steht
    // trotzdem. Hier oben sieht das Lesen dieselben Werte - dieselbe Verbindung
    // liest ihre eigenen, noch nicht committeten Schreibungen -, und ein Wurf
    // findet die Transaktion noch offen.
    const payload = { data: settingsAnswer(database, req.authUserId) };

    // Alle Felder sind durch und die Antwort steht - erst jetzt wird die Patch
    // wirksam. Hinter dem COMMIT kommt nur noch das Senden: kein Datenbankzugriff
    // und keine Berechnung, die einen 500 ueber eine gespeicherte Patch legen
    // koennte.
    database.exec('COMMIT');
    res.json(payload);
  } finally {
    // Noch offen heisst: der Handler ist NICHT ueber das COMMIT gegangen - ein
    // Feld wurde abgelehnt oder etwas hat geworfen. Dann gilt nichts aus dieser
    // Patch (#1622). Eine Absage ist zu diesem Zeitpunkt schon abgeschickt und
    // bleibt, wie sie ist; ein Fehler erreicht den zentralen Handler erst nach
    // diesem Block, also nach dem Rollback. Dazwischen liegt kein Yield-Punkt,
    // an dem ein anderer Request den halben Stand lesen koennte.
    if (database?.inTransaction) {
      try {
        database.exec('ROLLBACK');
      } catch (err) {
        log.error('PUT / - Rollback fehlgeschlagen', err);
      }
    }

    // Gespeicherte Geburtstags-Termine an die geltende Datensprache angleichen.
    //
    // Unbedingt statt nur bei erkannter Verschiebung: retitleBirthdayEvents
    // vergleicht ohnehin pro Zeile und schreibt nur, was abweicht. Ein Vergleich
    // vorher/nachher wäre ein zweiter Ort, an dem alle Wege zur Datensprache
    // (language, region, date_format) vollständig aufgezählt sein müssten.
    //
    // Im finally und NACH dem Rollback, in einer eigenen Transaktion: der Lauf
    // soll den Stand sehen, der wirklich gilt, und sein eigener Fehler darf die
    // Patch nicht mitreissen. Nach einer abgelehnten Patch hat sich die
    // Datensprache nicht bewegt, dann findet er nichts zu tun.
    //
    // Fehler beenden die Anfrage nicht: die Antwort ist zu diesem Zeitpunkt
    // längst gesendet (oder ein Fehler davor wartet auf den zentralen
    // Handler), und die Präferenzen sind geschrieben. Der nächste PUT
    // versucht es erneut - der Lauf ist idempotent.
    try {
      db.transaction(() => retitleBirthdayEvents(db.get()));
    } catch (err) {
      log.error('PUT / - Geburtstags-Termine konnten nicht umbenannt werden', err);
    }
  }
});

// GET /api/v1/preferences/holidays/countries
router.get('/holidays/countries', validateRequest(), async (_req, res) => {
  try {
    const countries = await holidays.getCountries();
    res.json({ data: countries });
  } catch (err) {
    log.error('GET /holidays/countries', err);
    res.status(502).json({ error: 'The country list could not be loaded.', code: 502 });
  }
});

// GET /api/v1/preferences/holidays/subdivisions/:countryCode?lang=
// `lang` ist die UI-Sprache des Lesers (#1723). Sie geht durch
// supportedLocaleFor(), also durch die Liste der Locale-Dateien: alles andere
// (unbekannter Code, Pfadzeichen) wird zu null und damit zu Englisch - wie bei
// `lang` der Budget-Kategorien, kein 400. Nur ein doppelter Parameter ist kein
// Text und antwortet seit #2810 (Gruppe 11b) 400 aus validateRequest(), ebenso
// ein Laendercode ausserhalb seines Musters (COUNTRY_ISO_RE, im Dokument).
router.get('/holidays/subdivisions/:countryCode', validateRequest(), async (req, res) => {
  const { countryCode } = req.params;
  try {
    const subdivisions = await holidays.getSubdivisions(countryCode, supportedLocaleFor(req.query.lang));
    res.json({ data: subdivisions });
  } catch (err) {
    log.error('GET /holidays/subdivisions/:countryCode', err);
    res.status(502).json({ error: 'The region list could not be loaded.', code: 502 });
  }
});

// GET /api/v1/preferences/holidays/groups/:countryCode
// Schulferien-Gruppen eines Landes ohne Subdivisionen (Belgien, D#1182). Leere
// Liste fuer jedes Land, das Subdivisionen fuehrt - dort gehoeren die Gruppen
// zur Region und kommen ueber die Route darunter.
router.get('/holidays/groups/:countryCode', validateRequest(), async (req, res) => {
  const { countryCode } = req.params;
  try {
    const groups = await holidays.getGroups(countryCode, null);
    res.json({ data: groups });
  } catch (err) {
    log.error('GET /holidays/groups/:countryCode', err);
    res.status(502).json({ error: 'The school holiday groups could not be loaded.', code: 502 });
  }
});

// GET /api/v1/preferences/holidays/groups/:countryCode/:subdivisionCode
// Schulferien-Gruppen einer Subdivision (mehrsprachige Kantone). Leere Liste,
// wenn die Subdivision nur ein Ferien-Regime kennt. (#434)
router.get('/holidays/groups/:countryCode/:subdivisionCode', validateRequest(), async (req, res) => {
  const { countryCode, subdivisionCode } = req.params;
  try {
    const groups = await holidays.getGroups(countryCode, subdivisionCode);
    res.json({ data: groups });
  } catch (err) {
    log.error('GET /holidays/groups/:countryCode/:subdivisionCode', err);
    res.status(502).json({ error: 'The school holiday groups could not be loaded.', code: 502 });
  }
});

// POST /api/v1/preferences/holidays/sync  (admin only)
router.post('/holidays/sync', validateRequest(), async (req, res) => {
  if (!isAdminRequest(req)) {
    return refuseAdmin(req, res);
  }
  try {
    await holidays.sync(true);
    res.json({ data: { last_sync: readSetting(db.get(), 'holiday_last_sync') } });
  } catch (err) {
    // Phase 0 section H: the class of the failure, never the text of the
    // holiday service or of the network stack. A database error is no
    // foreign failure: it goes on to the central error handler (500).
    const failure = remoteFailure(err);
    if (!failure) throw err;
    log.error('POST /holidays/sync', err);
    return res.status(502).json({ error: 'Holiday sync failed.', code: 502, ...failure });
  }
});

export default router;
