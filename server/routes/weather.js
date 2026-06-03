/**
 * Modul: Wetter-Proxy (Weather)
 * Zweck: Serverseitiger Proxy für OpenWeatherMap API (API-Key nie im Frontend)
 * Abhängigkeiten: express, node-fetch, dotenv
 */

import { createLogger } from '../logger.js';
import express from 'express';

const log = createLogger('Weather');

const router  = express.Router();

// Cache: Daten für 30 Minuten halten - pro Stadt/Einheit/Sprache, damit ein
// Wechsel von Stadt/Sprache/Einheit nicht 30 Minuten lang veraltete (oder
// falschsprachige) Daten ausliefert.
const cache = new Map(); // key `${city}|${units}|${lang}` → { data, ts }
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX_ENTRIES = 50; // Schutz gegen unbegrenztes Wachstum bei variablen Query-Params

// OpenWeatherMap erwartet bei einem Ortsnamen `q=`, bei einer numerischen
// City-ID aber `id=`. Ortsnamen lassen sich mit Ländercode disambiguieren,
// z.B. "Wellington,NZ" (sonst kann OWM die falsche Stadt zurückgeben).
function cityParam(city) {
  const c = String(city).trim();
  return /^\d+$/.test(c) ? `id=${encodeURIComponent(c)}` : `q=${encodeURIComponent(c)}`;
}

// --------------------------------------------------------
// GET /api/v1/weather
// Gibt aktuelles Wetter + 5-Tage-Vorschau zurück.
// Erfordert OPENWEATHER_API_KEY + OPENWEATHER_CITY in .env
// Response: { data: { current, forecast } } | { data: null }
// --------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const apiKey = process.env.OPENWEATHER_API_KEY;
    const city   = String(req.query.city  || process.env.OPENWEATHER_CITY  || 'Berlin');
    const units  = String(req.query.units || process.env.OPENWEATHER_UNITS || 'metric');
    // Sprache folgt der App-Locale (vom Frontend via ?lang= übergeben),
    // dann OPENWEATHER_LANG, dann Englisch als neutraler Default.
    const lang   = String(req.query.lang  || process.env.OPENWEATHER_LANG  || 'en');

    // Kein API-Key → leere Antwort (Widget wird ausgeblendet)
    if (!apiKey) {
      return res.json({ data: null });
    }

    // Cache prüfen (pro Stadt/Einheit/Sprache)
    const cacheKey = `${city}|${units}|${lang}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      return res.json({ data: cached.data });
    }

    // Dynamischer Import für node-fetch (ESM)
    const { default: fetch } = await import('node-fetch');

    // Aktuelles Wetter
    const currentUrl = `https://api.openweathermap.org/data/2.5/weather?${cityParam(city)}&appid=${apiKey}&units=${units}&lang=${lang}`;
    const currentRes = await fetch(currentUrl, { signal: AbortSignal.timeout(8000) });
    if (!currentRes.ok) {
      log.warn(`API error: ${currentRes.status}`);
      return res.json({ data: null });
    }
    const currentJson = await currentRes.json();

    // 5-Tage-Forecast (3h-Intervalle → aggregiert zu Tageswerten)
    const forecastUrl = `https://api.openweathermap.org/data/2.5/forecast?${cityParam(city)}&appid=${apiKey}&units=${units}&lang=${lang}&cnt=40`;
    const forecastRes = await fetch(forecastUrl, { signal: AbortSignal.timeout(8000) });
    let forecastDays = [];

    if (forecastRes.ok) {
      const forecastJson = await forecastRes.json();
      const list = forecastJson.list ?? [];

      // Alle Einträge nach Tag gruppieren
      const dayMap = new Map(); // "YYYY-MM-DD" → { temps: [], items: [] }

      for (const item of list) {
        const dateStr = item.dt_txt.slice(0, 10);
        if (!dayMap.has(dateStr)) {
          dayMap.set(dateStr, { temps: [], items: [] });
        }
        const day = dayMap.get(dateStr);
        day.temps.push(item.main.temp);
        day.items.push(item);
      }

      // Heute überspringen (Forecast),
      const today = new Date().toISOString().slice(0, 10);

      for (const [dateStr, { temps, items }] of dayMap) {
        if (dateStr === today) continue; // optional

        // Mittags-Wert (12:00) für Icon/Desc nutzen, falls nicht vorhanden Fallback auf 15:00 / mitte des Tages
        const noonItem =
          items.find(i => i.dt_txt.includes("12:00:00")) ??
          items.find(i => i.dt_txt.includes("15:00:00")) ??
          items[Math.floor(items.length / 2)];

        forecastDays.push({
          date:     dateStr,
          temp_min: Math.round(Math.min(...temps)),
          temp_max: Math.round(Math.max(...temps)),
          icon:     noonItem.weather[0]?.icon,
          desc:     noonItem.weather[0]?.description,
        });

        if (forecastDays.length >= 5) break;
      }
    }

    const data = {
      city:  currentJson.name,
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
      forecast: forecastDays,
    };

    // Älteste Einträge entfernen, falls der Cache zu groß wird (Map bewahrt Insertionsreihenfolge)
    if (cache.size >= CACHE_MAX_ENTRIES) {
      for (const k of cache.keys()) {
        if (cache.size < CACHE_MAX_ENTRIES) break;
        cache.delete(k);
      }
    }
    cache.set(cacheKey, { data, ts: Date.now() });
    res.json({ data });
  } catch (err) {
    log.warn('Error:', err.message);
    res.json({ data: null }); // Fallback: Widget ausblenden, kein Error-Screen
  }
});

// --------------------------------------------------------
// GET /api/v1/weather/icon/:code
// Proxy für OpenWeatherMap-Icons - vermeidet externe Bild-Requests
// im PWA-Standalone-Modus (CORS/CSP-Probleme auf Android Chrome).
// Erlaubte Codes: 2–4 alphanumerische Zeichen (z.B. "01d", "10n").
// Response: PNG-Bild mit 24h-Cache
// --------------------------------------------------------
router.get('/icon/:code', async (req, res) => {
  const { code } = req.params;
  if (!/^[a-zA-Z0-9]{2,4}$/.test(code)) {
    return res.status(400).json({ error: 'Ungültiger Icon-Code.', code: 400 });
  }

  try {
    const { default: fetch } = await import('node-fetch');
    const url = `https://openweathermap.org/img/wn/${code}@2x.png`;
    const upstream = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!upstream.ok) {
      return res.status(502).json({ error: 'Icon nicht verfügbar.', code: 502 });
    }
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400'); // 24 Stunden
    upstream.body.pipe(res);
  } catch (err) {
    log.warn('Icon proxy error:', err.message);
    res.status(502).json({ error: 'Icon proxy failed.', code: 502 });
  }
});

export default router;
