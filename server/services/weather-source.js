/**
 * Modul: Wetter-Quelle
 * Zweck: Die EINE Vorrangregel, welcher Wetteranbieter gilt - Datenbank
 *        (Einstellungen) vor Serverkonfiguration (`.env`). Der Wetter-Proxy
 *        (`routes/weather.js`) holt damit seine Daten, die Preferences-API
 *        meldet damit der Admin-Seite, woher das Wetter auf dem Dashboard kommt.
 *        Vorher stand die Regel nur im Proxy: der Web-Installer schreibt
 *        `WEATHER_*` in die `.env`, das Widget zeigte Wetter, und die
 *        Admin-Seite las nur die Datenbank und sagte "Nicht konfiguriert".
 * Abhängigkeiten: keine (reine Funktion)
 */

/**
 * @param {object} stored  Werte aus der Datenbank: `provider` (Haushalt) sowie
 *   `lat`, `lon`, `city`, `units` - im Proxy bereits um den Standort des
 *   Mitglieds ergaenzt, fuer die Admin-Seite nur die des Haushalts.
 * @param {object} [env=process.env]
 * @returns {{ source: 'db'|'env'|'none', provider: string|null, lat: string|null,
 *   lon: string|null, city: string|null, units: string|null }}
 *   Nie ein API-Key: `OPENWEATHER_API_KEY` entscheidet nur mit, ob der
 *   Legacy-Anbieter greift, und verlaesst diese Funktion nicht.
 */
export function resolveWeatherSource(stored = {}, env = process.env) {
  const provider = stored.provider ?? null;
  const lat = stored.lat ?? null;
  const lon = stored.lon ?? null;
  const city = stored.city ?? '';
  const units = stored.units ?? 'metric';
  const owmKey = env.OPENWEATHER_API_KEY;
  const owmCity = env.OPENWEATHER_CITY || 'Berlin';
  const owmUnits = env.OPENWEATHER_UNITS ?? 'metric';

  // Ein gesetzter Anbieter in der Datenbank schliesst die Serverkonfiguration
  // aus, auch wenn er unvollstaendig ist - dann gibt es gar kein Wetter.
  if (provider === 'open-meteo' && lat && lon) {
    return { source: 'db', provider: 'open-meteo', lat, lon, city, units };
  }
  if (provider === 'openweathermap' && owmKey) {
    return {
      source: 'db',
      provider: 'openweathermap',
      lat: null,
      lon: null,
      city: owmCity,
      units: units !== 'metric' ? units : owmUnits,
    };
  }
  // Ohne Anbieter reichen Koordinaten in der Datenbank - gedacht fuer den
  // Standort je Mitglied (v0.77.5), greift aber ebenso fuer die des Haushalts.
  if (!provider && lat && lon) {
    return { source: 'db', provider: 'open-meteo', lat, lon, city, units };
  }
  if (!provider && env.WEATHER_LAT && env.WEATHER_LON) {
    return {
      source: 'env',
      provider: 'open-meteo',
      lat: env.WEATHER_LAT,
      lon: env.WEATHER_LON,
      city: env.WEATHER_CITY ?? '',
      units: env.WEATHER_UNITS ?? 'metric',
    };
  }
  if (!provider && owmKey) {
    return { source: 'env', provider: 'openweathermap', lat: null, lon: null, city: owmCity, units: owmUnits };
  }
  return { source: 'none', provider: null, lat: null, lon: null, city: null, units: null };
}
