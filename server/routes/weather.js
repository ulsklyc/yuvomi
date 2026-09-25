/**
 * Modul: Wetter-Proxy (Weather)
 * Zweck: Serverseitiger Proxy für Open-Meteo (Default, kein API-Key) und
 *        OpenWeatherMap (Legacy, via .env). Provider-Auflösung: DB-Präferenzen
 *        zuerst, dann Env-Vars.
 * Abhängigkeiten: express, db (sync_config), natives global fetch (Node >=22)
 */

import { createLogger } from '../logger.js';
import express from 'express';
import * as db from '../db.js';
import { utcDateKey } from '../utils/timezone.js';

const log = createLogger('Weather');

// Cache: keyed by provider + coords/city + units — TTL 30 min, max 50 entries.
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX_ENTRIES = 50;

// ----------------------------------------------------------------
// WMO Weather Interpretation Code → Lucide icon name
// ----------------------------------------------------------------
function wmoIcon(code, isDay = true) {
  if (code === 0)               return isDay ? 'sun' : 'moon';
  if (code <= 2)                return isDay ? 'cloud-sun' : 'cloud-moon';
  if (code === 3)               return 'cloud';
  if (code <= 48)               return 'cloud';        // fog variants
  if (code <= 55)               return 'cloud-drizzle';
  if (code <= 65)               return 'cloud-rain';
  if (code <= 77)               return 'cloud-snow';
  if (code <= 82)               return 'cloud-rain';   // showers
  if (code <= 86)               return 'cloud-snow';   // snow showers
  return 'cloud-lightning';                            // 95–99 thunderstorm
}

// ----------------------------------------------------------------
// Read a sync_config key from DB (safe — returns null on any error)
// ----------------------------------------------------------------
function cfgGet(key) {
  try {
    const row = db.get().prepare('SELECT value FROM sync_config WHERE key = ?').get(key);
    return row ? row.value : null;
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------
// OWM city param: "q=Berlin" or "id=12345"
// (Ortsnamen mit Ländercode disambiguieren, z.B. "Wellington,NZ".)
// ----------------------------------------------------------------
function cityParam(city) {
  const c = String(city).trim();
  return /^\d+$/.test(c) ? `id=${encodeURIComponent(c)}` : `q=${encodeURIComponent(c)}`;
}

// ----------------------------------------------------------------
// Factory used by tests to inject a custom fetch function and cfgGet.
// The router exported as default uses real global fetch + real DB.
// ----------------------------------------------------------------
export function buildRouter({ cfgGet: cfgGetFn = cfgGet, fetchFn = null } = {}) {
  const router = express.Router();
  // Der Cache haengt am Router, nicht am Modul. Im Betrieb ist das derselbe eine
  // Cache wie zuvor (es gibt genau einen Router), in Tests aber der Unterschied
  // zwischen isoliert und nicht: ein modulweiter Cache reichte die Antwort des
  // einen Falls an den naechsten mit gleichen Koordinaten weiter, und der pruefte
  // dann stillschweigend das Ergebnis seines Vorgaengers.
  const cache = new Map();

  // Per-User-Wert vor Haushalt: liest '{key}:user:{id}' über denselben cfgGet.
  function effective(key, userId) {
    if (userId) {
      const u = cfgGetFn(`${key}:user:${userId}`);
      if (u !== null && u !== undefined) return u;
    }
    return cfgGetFn(key);
  }

  async function doFetch(url, opts) {
    // Node 22+ ships a global fetch — no node-fetch import needed.
    if (fetchFn) return fetchFn(url, opts);
    return fetch(url, opts);
  }

  // ---------------------------------------------------------------
  // GET /api/v1/weather
  // Response: { data: { provider, city, units, current, today, forecast } } | { data: null }
  // `today` traegt den Kalendertag AM WETTERORT samt Hoch/Tief; `forecast` sind
  // die Folgetage. Die Anzeige benennt ihre Tage an `today.date`, nicht am Index.
  // ---------------------------------------------------------------
  router.get('/', async (req, res) => {
    try {
      // ── 1. Resolve provider ──────────────────────────────────
      const userId = req.authUserId;
      const dbProvider = cfgGetFn('weather_provider');
      const dbLat      = effective('weather_lat', userId);
      const dbLon      = effective('weather_lon', userId);
      const dbCity     = effective('weather_city', userId) ?? '';
      const dbUnits    = effective('weather_units', userId) ?? 'metric';

      const envLat   = process.env.WEATHER_LAT;
      const envLon   = process.env.WEATHER_LON;
      const envCity  = process.env.WEATHER_CITY ?? '';
      const envUnits = process.env.WEATHER_UNITS ?? 'metric';
      const owmKey   = process.env.OPENWEATHER_API_KEY;
      const owmCity  = String(req.query.city || process.env.OPENWEATHER_CITY || 'Berlin');
      const owmLang  = String(req.query.lang  || process.env.OPENWEATHER_LANG || 'en');

      let provider, lat, lon, city, units;

      if (dbProvider === 'open-meteo' && dbLat && dbLon) {
        provider = 'open-meteo';
        lat = dbLat; lon = dbLon; city = dbCity; units = dbUnits;
      } else if (dbProvider === 'openweathermap' && owmKey) {
        provider = 'openweathermap';
        units = dbUnits !== 'metric' ? dbUnits : (process.env.OPENWEATHER_UNITS ?? 'metric');
      } else if (!dbProvider && dbLat && dbLon) {
        provider = 'open-meteo';
        lat = dbLat; lon = dbLon; city = dbCity; units = dbUnits;
      } else if (!dbProvider && envLat && envLon) {
        provider = 'open-meteo';
        lat = envLat; lon = envLon; city = envCity; units = envUnits;
      } else if (!dbProvider && owmKey) {
        provider = 'openweathermap';
        units = process.env.OPENWEATHER_UNITS ?? 'metric';
      } else {
        return res.json({ data: null });
      }

      // ── 2. Cache check ───────────────────────────────────────
      const cacheKey = provider === 'open-meteo'
        ? `om:${lat}|${lon}|${units}`
        : `owm:${owmCity}|${units}|${owmLang}`;

      // Die halbe Stunde ist die eine Grenze, der ORTSTAG die andere. Eine kurz
      // vor Mitternacht abgelegte Antwort wuerde sonst noch eine halbe Stunde
      // danach ausgeliefert - mit `today.date` auf gestern: der erste
      // Vorhersagetag ist dann in Wahrheit heute, traegt aber nur seinen
      // Wochentag, und im Hauptblock steht das Hoch/Tief von gestern. Deshalb
      // liegt der Ortsoffset mit im Eintrag - nur damit laesst sich fragen, ob
      // der Tag, den die Antwort meint, ueberhaupt noch laeuft.
      const cached = cache.get(cacheKey);
      if (cached
        && Date.now() - cached.ts < CACHE_TTL_MS
        && cached.dayKey === utcDateKey(new Date(Date.now() + cached.offsetMs))) {
        return res.json({ data: cached.data });
      }

      // ── 3. Fetch ─────────────────────────────────────────────
      let data;
      // Der Offset des Wetterorts, gesetzt vom jeweiligen Zweig. Gebraucht wird er
      // nur fuer die Tagesgrenze des Caches oben.
      let locationOffsetMs = 0;

      if (provider === 'open-meteo') {
        const tempUnit  = units === 'imperial' ? 'fahrenheit' : 'celsius';
        const windUnit  = units === 'imperial' ? 'mph' : 'kmh';
        const url = [
          'https://api.open-meteo.com/v1/forecast',
          `?latitude=${encodeURIComponent(lat)}`,
          `&longitude=${encodeURIComponent(lon)}`,
          '&current=temperature_2m,apparent_temperature,relative_humidity_2m,is_day,weather_code,wind_speed_10m',
          '&daily=weather_code,temperature_2m_max,temperature_2m_min',
          '&timezone=auto',
          '&forecast_days=6',
          `&temperature_unit=${tempUnit}`,
          `&wind_speed_unit=${windUnit}`,
        ].join('');

        const omRes = await doFetch(url, { signal: AbortSignal.timeout(8000) });
        if (!omRes.ok) {
          log.warn(`Open-Meteo API error: ${omRes.status}`);
          return res.json({ data: null });
        }
        const om = await omRes.json();
        const cur = om.current;
        const isDay = cur.is_day === 1;

        // Open-Meteo wird mit `timezone=auto` abgefragt, `daily.time` traegt also
        // die Kalendertage DES ORTES - der erste davon ist heute. Der Rueckfall
        // greift nur, wenn `daily` ganz fehlt; dann sind `today` und `forecast`
        // ohnehin leer.
        const days = (om.daily?.time ?? []).map((date, i) => ({
          date,
          temp_min: Math.round(om.daily.temperature_2m_min[i]),
          temp_max: Math.round(om.daily.temperature_2m_max[i]),
          icon: wmoIcon(om.daily.weather_code[i], true),
          desc: `wmo.${om.daily.weather_code[i]}`,
        }));
        const omToday = days[0]?.date ?? utcDateKey();
        // Open-Meteo gibt den Offset des Ortes mit heraus - Folge von
        // `timezone=auto`, die Antwort ist ohnehin in Ortszeit geschluesselt.
        locationOffsetMs = (Number(om.utc_offset_seconds) || 0) * 1000;

        data = {
          provider: 'open-meteo',
          city: city || `${lat}, ${lon}`,
          units,
          current: {
            temp:       Math.round(cur.temperature_2m),
            feels_like: Math.round(cur.apparent_temperature),
            humidity:   cur.relative_humidity_2m,
            icon:       wmoIcon(cur.weather_code, isDay),
            desc:       `wmo.${cur.weather_code}`,
            wind_speed: Math.round(cur.wind_speed_10m),
          },
          today: days.find((d) => d.date === omToday) ?? null,
          forecast: days.filter((d) => d.date > omToday).slice(0, 5),
        };
      } else {
        // OWM legacy path
        const currentUrl = `https://api.openweathermap.org/data/2.5/weather?${cityParam(owmCity)}&appid=${owmKey}&units=${units}&lang=${owmLang}`;
        const currentRes = await doFetch(currentUrl, { signal: AbortSignal.timeout(8000) });
        if (!currentRes.ok) {
          log.warn(`OWM API error: ${currentRes.status}`);
          return res.json({ data: null });
        }
        const currentJson = await currentRes.json();

        const forecastUrl = `https://api.openweathermap.org/data/2.5/forecast?${cityParam(owmCity)}&appid=${owmKey}&units=${units}&lang=${owmLang}&cnt=40`;
        const forecastRes = await doFetch(forecastUrl, { signal: AbortSignal.timeout(8000) });

        // Die Drei-Stunden-Schritte tragen UTC-Zeitstempel (`dt_txt`), geschluesselt
        // wird hier aber nach ORTSTAG. Bisher war der Schluessel der UTC-Tag, und
        // das ging nur nahe des Nullmeridians gut: weit westlich davon warf der
        // Filter abends den falschen Tag weg und die Vorhersage begann bei
        // uebermorgen (#851), weit oestlich davon fiel ein UTC-Tag quer durch zwei
        // Ortstage und mischte deren Werte zu einem Hoch/Tief zusammen, das es
        // nirgends gab. `timezone` ist der Ortsoffset in Sekunden; fehlt er, ist
        // der Offset 0 und alles bleibt beim bisherigen UTC-Tag.
        const owmOffsetMs = (Number(currentJson.timezone) || 0) * 1000;
        const owmLocal = (dtTxt) => new Date(new Date(`${String(dtTxt).replace(' ', 'T')}Z`).getTime() + owmOffsetMs);
        const owmToday = utcDateKey(new Date(Date.now() + owmOffsetMs));
        locationOffsetMs = owmOffsetMs;
        let todayDay = null;
        let forecastDays = [];

        if (forecastRes.ok) {
          const forecastJson = await forecastRes.json();
          const list = forecastJson.list ?? [];
          const dayMap = new Map();
          for (const item of list) {
            const local = owmLocal(item.dt_txt);
            if (Number.isNaN(local.getTime())) continue;
            const dateStr = utcDateKey(local);
            if (!dayMap.has(dateStr)) dayMap.set(dateStr, { temps: [], items: [] });
            const day = dayMap.get(dateStr);
            day.temps.push(item.main.temp);
            day.items.push({ item, hour: local.getUTCHours() });
          }
          // Erst alle Tage bauen, dann heute heraustrennen - nicht waehrend des
          // Laufs deckeln: sonst haengt es an der Schluesselreihenfolge, ob der
          // laufende Tag ueberhaupt noch gesehen wird.
          const days = [];
          for (const [dateStr, { temps, items }] of dayMap) {
            // Der Schritt, der dem ORTSMITTAG am naechsten liegt. Ein fester
            // Griff nach '12:00:00' waere der UTC-Mittag, und bei einem Offset
            // wie +05:30 gaebe es ihn im Ortstag ueberhaupt nicht.
            const noon = items.reduce((best, cur) =>
              Math.abs(cur.hour - 12) < Math.abs(best.hour - 12) ? cur : best, items[0]).item;
            days.push({
              date:     dateStr,
              temp_min: Math.round(Math.min(...temps)),
              temp_max: Math.round(Math.max(...temps)),
              icon:     noon.weather[0]?.icon,
              desc:     noon.weather[0]?.description,
            });
          }
          todayDay = days.find((d) => d.date === owmToday) ?? null;
          // `>` und nicht `!==`: die Liste kann mit einem bereits vergangenen
          // Ortstag beginnen, und der gehoert nicht an die Spitze einer
          // VORhersage.
          forecastDays = days.filter((d) => d.date > owmToday).slice(0, 5);
        }

        // DIESER PROVIDER KENNT KEINE TAGESSPANNE, also gibt er auch keine aus.
        //
        // Die Drei-Stunden-Liste beginnt beim naechsten Schritt, nicht bei
        // Mitternacht: nachmittags fehlen dem heutigen Bucket die Morgenwerte,
        // sein Maximum ist dann nicht das Tagesmaximum und kann sogar unter der
        // Ist-Temperatur daneben liegen. `main.temp_min`/`temp_max` taugen als
        // Ersatz ebenso wenig - das ist die momentane Streuung ueber das
        // Stadtgebiet, fuer die meisten Orte identisch mit `temp`, also zwei
        // gleiche Zahlen mit dem Anschein einer Auskunft.
        //
        // Open-Meteo liefert dagegen echte Tagesaggregate und behaelt sein
        // Hoch/Tief. `date` steht auch hier: es ist die Bezugsgroesse, an der die
        // Anzeige ihre Tage benennt, und die stimmt unabhaengig davon.
        todayDay = {
          date:     owmToday,
          temp_min: null,
          temp_max: null,
          icon:     todayDay?.icon ?? currentJson.weather[0]?.icon,
          desc:     todayDay?.desc ?? currentJson.weather[0]?.description,
        };

        data = {
          provider: 'openweathermap',
          city: currentJson.name,
          units,
          current: {
            temp:       Math.round(currentJson.main.temp),
            feels_like: Math.round(currentJson.main.feels_like),
            humidity:   currentJson.main.humidity,
            icon:       currentJson.weather[0]?.icon,
            desc:       currentJson.weather[0]?.description,
            // metric/standard: m/s → km/h; imperial: already mph
            wind_speed: units === 'imperial'
              ? Math.round(currentJson.wind?.speed ?? 0)
              : Math.round((currentJson.wind?.speed ?? 0) * 3.6),
          },
          today: todayDay,
          forecast: forecastDays,
        };
      }

      // ── 4. Cache store ───────────────────────────────────────
      if (cache.size >= CACHE_MAX_ENTRIES) {
        for (const k of cache.keys()) {
          if (cache.size < CACHE_MAX_ENTRIES) break;
          cache.delete(k);
        }
      }
      cache.set(cacheKey, {
        data,
        ts: Date.now(),
        offsetMs: locationOffsetMs,
        dayKey: data.today?.date ?? utcDateKey(new Date(Date.now() + locationOffsetMs)),
      });
      res.json({ data });
    } catch (err) {
      log.warn('Error:', err.message);
      res.json({ data: null }); // Fallback: Widget ausblenden, kein Error-Screen
    }
  });

  // ---------------------------------------------------------------
  // GET /api/v1/weather/icon/:code  (OWM icon proxy — kept for legacy)
  // Proxy für OpenWeatherMap-Icons - vermeidet externe Bild-Requests
  // im PWA-Standalone-Modus (CORS/CSP-Probleme auf Android Chrome).
  // ---------------------------------------------------------------
  router.get('/icon/:code', async (req, res) => {
    const { code } = req.params;
    if (!/^[a-zA-Z0-9]{2,4}$/.test(code)) {
      return res.status(400).json({ error: 'Ungültiger Icon-Code.', code: 400 });
    }
    try {
      const url = `https://openweathermap.org/img/wn/${code}@2x.png`;
      const upstream = await doFetch(url, { signal: AbortSignal.timeout(5000) });
      if (!upstream.ok) {
        return res.status(502).json({ error: 'Icon nicht verfügbar.', code: 502 });
      }
      res.setHeader('Content-Type', 'image/png');
      // no-store wie jede Medienroute: die Antwort liegt hinter der Anmeldung,
      // und eine oeffentlich cachebare Fassung nahm dort einen Set-Cookie-Kopf mit
      // in fremde Caches (services/display-accounts.js).
      res.setHeader('Cache-Control', 'no-store');
      // Natives fetch liefert einen Web-Stream; einmalig puffern und senden (Icons
      // sind wenige KB). Kein body.pipe wie bei node-fetch (dessen Node-Stream fehlt).
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (err) {
      log.warn('Icon proxy error:', err.message);
      res.status(502).json({ error: 'Icon proxy failed.', code: 502 });
    }
  });

  return router;
}

export default buildRouter();
