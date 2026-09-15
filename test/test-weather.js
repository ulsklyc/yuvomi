import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const BASE_ENV_KEYS = ['OPENWEATHER_API_KEY', 'OPENWEATHER_CITY', 'WEATHER_LAT', 'WEATHER_LON', 'WEATHER_CITY', 'WEATHER_UNITS'];

// Spin up the weather router with injected cfgGet (DB) + fetchFn (upstream).
// Returns { baseUrl, close }.
async function startApp({ env = {}, db = {}, fetchFn, userId } = {}) {
  for (const k of BASE_ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);

  const { buildRouter } = await import('../server/routes/weather.js');
  const router = buildRouter({
    cfgGet: (key) => (key in db ? db[key] : null),
    fetchFn,
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (userId) req.authUserId = userId; next(); });
  app.use('/', router);

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

const OM_FETCH = async (url) => {
  if (new URL(String(url)).hostname !== 'api.open-meteo.com') throw new Error('unexpected URL: ' + url);
  return {
    ok: true,
    json: async () => ({
      current: { temperature_2m: 18.5, apparent_temperature: 16.0, relative_humidity_2m: 65,
        is_day: 1, weather_code: 2, wind_speed_10m: 14.4 },
      daily: {
        time: ['2026-06-05', '2026-06-06', '2026-06-07', '2026-06-08', '2026-06-09'],
        weather_code: [2, 61, 3, 0, 80],
        temperature_2m_max: [22, 18, 20, 25, 17],
        temperature_2m_min: [14, 12, 13, 16, 11],
      },
    }),
  };
};

const OM_FETCH_NIGHT = async () => ({
  ok: true,
  json: async () => ({
    current: { temperature_2m: 10, apparent_temperature: 8, relative_humidity_2m: 70,
      is_day: 0, weather_code: 0, wind_speed_10m: 5 },
    daily: { time: ['2026-06-05'], weather_code: [0], temperature_2m_max: [12], temperature_2m_min: [8] },
  }),
});

const OWM_FETCH = async (url) => {
  if (String(url).includes('/weather?')) {
    return { ok: true, json: async () => ({
      name: 'Hamburg', main: { temp: 15, feels_like: 13, humidity: 80 },
      weather: [{ icon: '04d', description: 'bedeckt' }], wind: { speed: 4 } }) };
  }
  if (String(url).includes('/forecast?')) {
    return { ok: true, json: async () => ({
      list: [{ dt_txt: '2026-06-06 12:00:00', main: { temp: 16 },
        weather: [{ icon: '10d', description: 'leichter Regen' }] }] }) };
  }
  throw new Error('unexpected URL: ' + url);
};

async function getJson(baseUrl) {
  const res = await fetch(`${baseUrl}/`);
  return { status: res.status, body: await res.json() };
}

test('no provider configured → { data: null }', async () => {
  const { baseUrl, close } = await startApp({});
  try {
    const { status, body } = await getJson(baseUrl);
    assert.equal(status, 200);
    assert.deepEqual(body, { data: null });
  } finally { await close(); }
});

test('Open-Meteo via env: provider + city + cloud-sun icon + wmo desc + forecast shape', async () => {
  const { baseUrl, close } = await startApp({
    env: { WEATHER_LAT: '52.52', WEATHER_LON: '13.41', WEATHER_CITY: 'Berlin' },
    fetchFn: OM_FETCH,
  });
  try {
    const { body } = await getJson(baseUrl);
    assert.equal(body.data.provider, 'open-meteo');
    assert.equal(body.data.city, 'Berlin');
    assert.equal(body.data.current.icon, 'cloud-sun');
    assert.equal(body.data.current.desc, 'wmo.2');
    const fc = body.data.forecast;
    assert.ok(Array.isArray(fc) && fc.length > 0);
    for (const k of ['date', 'temp_min', 'temp_max', 'icon', 'desc']) assert.ok(k in fc[0]);
  } finally { await close(); }
});

test('DB provider=open-meteo overrides env OPENWEATHER_API_KEY; night → moon', async () => {
  const { baseUrl, close } = await startApp({
    env: { OPENWEATHER_API_KEY: 'old-key' },
    db: { weather_provider: 'open-meteo', weather_lat: '48.14', weather_lon: '11.58', weather_city: 'München' },
    fetchFn: OM_FETCH_NIGHT,
  });
  try {
    const { body } = await getJson(baseUrl);
    assert.equal(body.data.provider, 'open-meteo');
    assert.equal(body.data.city, 'München');
    assert.equal(body.data.current.icon, 'moon');
  } finally { await close(); }
});

test('OWM legacy via env: provider + raw OWM icon code', async () => {
  const { baseUrl, close } = await startApp({
    env: { OPENWEATHER_API_KEY: 'key123', OPENWEATHER_CITY: 'Hamburg' },
    fetchFn: OWM_FETCH,
  });
  try {
    const { body } = await getJson(baseUrl);
    assert.equal(body.data.provider, 'openweathermap');
    assert.equal(body.data.city, 'Hamburg');
    assert.equal(body.data.current.icon, '04d');
  } finally { await close(); }
});

test('per-user override beats household coords', async () => {
  const { baseUrl, close } = await startApp({
    db: {
      weather_provider: 'open-meteo',
      weather_lat: '48.14', weather_lon: '11.58', weather_city: 'München',
      'weather_lat:user:7': '52.52', 'weather_lon:user:7': '13.41', 'weather_city:user:7': 'Berlin',
    },
    fetchFn: OM_FETCH,
    userId: 7,
  });
  try {
    const { body } = await getJson(baseUrl);
    assert.equal(body.data.provider, 'open-meteo');
    assert.equal(body.data.city, 'Berlin');
  } finally { await close(); }
});

test('per-user Open-Meteo coords work without household provider', async () => {
  const { baseUrl, close } = await startApp({
    db: {
      'weather_lat:user:7': '52.52',
      'weather_lon:user:7': '13.41',
      'weather_city:user:7': 'Berlin',
      'weather_units:user:7': 'imperial',
    },
    fetchFn: OM_FETCH,
    userId: 7,
  });
  try {
    const { body } = await getJson(baseUrl);
    assert.equal(body.data.provider, 'open-meteo');
    assert.equal(body.data.city, 'Berlin');
    assert.equal(body.data.units, 'imperial');
  } finally { await close(); }
});

test('falls back to household coords when user has no override', async () => {
  const { baseUrl, close } = await startApp({
    db: { weather_provider: 'open-meteo', weather_lat: '48.14', weather_lon: '11.58', weather_city: 'München' },
    fetchFn: OM_FETCH,
    userId: 7,
  });
  try {
    const { body } = await getJson(baseUrl);
    assert.equal(body.data.city, 'München');
  } finally { await close(); }
});

// ── Der laufende Tag (#851) ─────────────────────────────────────────────────
// Die Vorhersage trennt heute heraus, damit die Anzeige ihn nicht doppelt zeigt.
// Genau diese Trennung war die Falle: die Anzeige beschriftete `forecast[0]`
// weiter als „Heute", obwohl dort schon morgen stand - die Reihe sah aus, als
// fehle ein Tag. Ab hier trägt der Payload den laufenden Tag als eigenes Feld,
// und daran benennt die Anzeige ihre Tage.
//
// Die Fixtures oben datieren bewusst auf 2026-06-05 und liefen damit an dieser
// Falle vorbei: der Filter griff nie, weil kein Mock-Tag je „heute" war.

test('Open-Meteo: der erste daily-Tag wird zu `today`, nicht zum ersten Vorhersagetag', async () => {
  const days = ['2026-06-05', '2026-06-06', '2026-06-07', '2026-06-08', '2026-06-09'];
  const { baseUrl, close } = await startApp({
    env: { WEATHER_LAT: '52.52', WEATHER_LON: '13.41', WEATHER_CITY: 'Berlin' },
    fetchFn: OM_FETCH,
  });
  try {
    const { body } = await getJson(baseUrl);
    const { today, forecast } = body.data;

    // `daily.time[0]` ist mit `timezone=auto` der laufende Tag AM ORT.
    assert.equal(today.date, days[0]);
    assert.equal(today.temp_max, 22);
    assert.equal(today.temp_min, 14);
    assert.equal(today.icon, 'cloud-sun');
    assert.equal(today.desc, 'wmo.2');

    // Und er steht kein zweites Mal in der Reihe darunter.
    assert.deepEqual(forecast.map((d) => d.date), days.slice(1));
  } finally { await close(); }
});

test('Open-Meteo: die Reihe überspringt keinen Tag zwischen heute und ihrem ersten Eintrag', async () => {
  const { baseUrl, close } = await startApp({
    env: { WEATHER_LAT: '52.52', WEATHER_LON: '13.41', WEATHER_CITY: 'Berlin' },
    fetchFn: OM_FETCH,
  });
  try {
    const { body } = await getJson(baseUrl);
    const { today, forecast } = body.data;
    const nextDay = new Date(`${today.date}T00:00:00Z`);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    assert.equal(forecast[0].date, nextDay.toISOString().slice(0, 10));
  } finally { await close(); }
});

test('Open-Meteo ohne daily-Block: kein `today`, keine Reihe - und kein Absturz', async () => {
  const { baseUrl, close } = await startApp({
    env: { WEATHER_LAT: '52.52', WEATHER_LON: '13.41' },
    fetchFn: async () => ({
      ok: true,
      json: async () => ({
        current: { temperature_2m: 18, apparent_temperature: 17, relative_humidity_2m: 60,
          is_day: 1, weather_code: 0, wind_speed_10m: 9 },
      }),
    }),
  });
  try {
    const { body } = await getJson(baseUrl);
    assert.equal(body.data.today, null);
    assert.deepEqual(body.data.forecast, []);
  } finally { await close(); }
});

// OWM ist der Legacy-Pfad und schlüsselt seine Drei-Stunden-Schritte in UTC.
// Der laufende Tag war deshalb der UTC-Tag - weit westlich davon wirft der
// abends den falschen Tag weg. Der Ortstag liegt im selben Schlüsselraum
// (derselbe Kalender, nur verschoben) und ist der Tag, den der Nutzer meint.
const OWM_TZ_FETCH = (timezone, dates) => async (url) => {
  if (String(url).includes('/weather?')) {
    return { ok: true, json: async () => ({
      name: 'Honolulu', timezone,
      main: { temp: 26, feels_like: 27, humidity: 70, temp_min: 22, temp_max: 29 },
      weather: [{ icon: '01d', description: 'klar' }], wind: { speed: 3 } }) };
  }
  if (String(url).includes('/forecast?')) {
    return { ok: true, json: async () => ({
      list: dates.map((d) => ({ dt_txt: `${d} 12:00:00`, main: { temp: 25 },
        weather: [{ icon: '02d', description: 'leicht bewoelkt' }] })) }) };
  }
  throw new Error('unexpected URL: ' + url);
};

test('OWM: `today` folgt dem Ortstag, nicht dem UTC-Tag', async () => {
  // UTC-10 (Pazifik/Honolulu): um 06:00 UTC ist dort noch der Vortag.
  const utcToday = new Date().toISOString().slice(0, 10);
  const localToday = new Date(Date.now() - 10 * 3600 * 1000).toISOString().slice(0, 10);
  const { baseUrl, close } = await startApp({
    env: { OPENWEATHER_API_KEY: 'key123', OPENWEATHER_CITY: 'Honolulu' },
    fetchFn: OWM_TZ_FETCH(-36000, [localToday, utcToday]),
  });
  try {
    const { body } = await getJson(baseUrl);
    assert.equal(body.data.today.date, localToday);
    // Der Ortstag ist heraus, alles danach bleibt - auch dann, wenn er in UTC
    // schon gestern heisst.
    assert.equal(body.data.forecast.some((d) => d.date === localToday), false);
    if (localToday !== utcToday) {
      assert.equal(body.data.forecast[0].date, utcToday);
    }
  } finally { await close(); }
});

test('OWM ohne timezone-Feld: der UTC-Tag bleibt die Bezugsgroesse', async () => {
  const utcToday = new Date().toISOString().slice(0, 10);
  const { baseUrl, close } = await startApp({
    env: { OPENWEATHER_API_KEY: 'key123', OPENWEATHER_CITY: 'Hamburg' },
    fetchFn: OWM_FETCH,
  });
  try {
    const { body } = await getJson(baseUrl);
    assert.equal(body.data.today.date, utcToday);
  } finally { await close(); }
});

test('OWM gibt NIE eine Tagesspanne aus - auch nicht, wenn heute in der Liste steht', async () => {
  // Zwei Quellen kaemen in Frage und beide taugen nicht. Die Drei-Stunden-Liste
  // beginnt beim naechsten Schritt: nachmittags fehlen ihrem heutigen Bucket die
  // Morgenwerte, sein Maximum kann sogar unter der Ist-Temperatur liegen.
  // `main.temp_min`/`temp_max` sind die momentane Streuung ueber das Stadtgebiet,
  // fuer die meisten Orte identisch mit `temp`. Der Bezugstag steht trotzdem -
  // an ihm benennt die Anzeige ihre Tage.
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  for (const [label, dates] of [['ohne heutigen Bucket', [tomorrow]], ['mit heutigem Bucket', [today, tomorrow]]]) {
    const { baseUrl, close } = await startApp({
      env: { OPENWEATHER_API_KEY: 'key123', OPENWEATHER_CITY: `Honolulu-${label}` },
      fetchFn: OWM_TZ_FETCH(0, dates),
    });
    try {
      const { body } = await getJson(baseUrl);
      assert.equal(body.data.today.date, today, label);
      assert.equal(body.data.today.temp_max, null, `${label}: keine erfundene Hoechsttemperatur`);
      assert.equal(body.data.today.temp_min, null, `${label}: keine erfundene Tiefsttemperatur`);
      assert.equal(body.data.forecast[0].date, tomorrow, label);
    } finally { await close(); }
  }
});

test('Open-Meteo behaelt sein Hoch/Tief - dort sind es echte Tagesaggregate', async () => {
  const { baseUrl, close } = await startApp({
    env: { WEATHER_LAT: '52.52', WEATHER_LON: '13.41' },
    fetchFn: OM_FETCH,
  });
  try {
    const { body } = await getJson(baseUrl);
    assert.equal(body.data.today.temp_max, 22);
    assert.equal(body.data.today.temp_min, 14);
  } finally { await close(); }
});

test('der Cache haelt nicht ueber die Ortsmitternacht hinweg', async () => {
  // Eine kurz vor Mitternacht abgelegte Antwort haette sonst bis zu eine halbe
  // Stunde danach `today.date` auf gestern stehen - der erste Vorhersagetag ist
  // dann in Wahrheit heute, traegt aber nur seinen Wochentag.
  let served = 0;
  const daily = (start) => {
    const days = [0, 1, 2].map((i) =>
      new Date(new Date(`${start}T00:00:00Z`).getTime() + i * 86400000).toISOString().slice(0, 10));
    return { time: days, weather_code: [0, 1, 2], temperature_2m_max: [20, 21, 22], temperature_2m_min: [10, 11, 12] };
  };
  // Erst der 24., nach dem "Tageswechsel" der 25. - der Aufrufzaehler steht fuer
  // die verstrichene Zeit, denn Date.now() laesst sich hier nicht anhalten.
  const fetchFn = async () => ({
    ok: true,
    json: async () => ({
      utc_offset_seconds: 0,
      current: { temperature_2m: 18, apparent_temperature: 17, relative_humidity_2m: 60,
        is_day: 1, weather_code: 0, wind_speed_10m: 9 },
      daily: daily(served++ === 0 ? '2026-06-05' : '2026-06-06'),
    }),
  });

  const { baseUrl, close } = await startApp({
    env: { WEATHER_LAT: '1.11', WEATHER_LON: '2.22' },
    fetchFn,
  });
  try {
    const first = await getJson(baseUrl);
    assert.equal(first.body.data.today.date, '2026-06-05');

    // Zweiter Abruf: der Eintrag ist keine 30 Minuten alt, sein Tag aber ein
    // anderer als der laufende - beide Fixture-Tage liegen in der Vergangenheit,
    // also trifft `dayKey === heute` in keinem Fall zu und der Cache muss weichen.
    const second = await getJson(baseUrl);
    assert.equal(served, 2, 'der Cache haette eine Antwort von gestern weitergereicht');
    assert.equal(second.body.data.today.date, '2026-06-06');
  } finally { await close(); }
});

test('der Cache greift innerhalb desselben Ortstags', async () => {
  // Die Gegenprobe zum Test darueber: liegt der Tag der Antwort noch richtig,
  // darf kein zweiter Abruf hinausgehen.
  let served = 0;
  const today = new Date().toISOString().slice(0, 10);
  const next = (i) => new Date(Date.now() + i * 86400000).toISOString().slice(0, 10);
  const fetchFn = async () => {
    served += 1;
    return { ok: true, json: async () => ({
      utc_offset_seconds: 0,
      current: { temperature_2m: 18, apparent_temperature: 17, relative_humidity_2m: 60,
        is_day: 1, weather_code: 0, wind_speed_10m: 9 },
      daily: { time: [today, next(1), next(2)], weather_code: [0, 1, 2],
        temperature_2m_max: [20, 21, 22], temperature_2m_min: [10, 11, 12] },
    }) };
  };

  const { baseUrl, close } = await startApp({
    env: { WEATHER_LAT: '3.33', WEATHER_LON: '4.44' },
    fetchFn,
  });
  try {
    await getJson(baseUrl);
    await getJson(baseUrl);
    assert.equal(served, 1, 'derselbe Ortstag: der Cache muss halten');
  } finally { await close(); }
});

test('OWM: oestlich von UTC steht kein bereits vergangener Ortstag an der Spitze', async () => {
  // Kiritimati (UTC+14): der UTC-Tag deckt dort zwei Ortstage ab. Bis hierher
  // trennte der Filter nur den einen laufenden Tag heraus - ein davorliegender
  // blieb stehen und fuehrte die VORhersage an.
  const offsetSec = 14 * 3600;
  const localToday = new Date(Date.now() + offsetSec * 1000).toISOString().slice(0, 10);
  const dayBefore = new Date(Date.now() + offsetSec * 1000 - 86400000).toISOString().slice(0, 10);
  const dayAfter = new Date(Date.now() + offsetSec * 1000 + 86400000).toISOString().slice(0, 10);
  // In UTC ausgedrueckt, denn so kommen die Schritte von OWM herein.
  const asUtcStamp = (localDay, hour) =>
    new Date(new Date(`${localDay}T${String(hour).padStart(2, '0')}:00:00Z`).getTime() - offsetSec * 1000)
      .toISOString().replace('T', ' ').slice(0, 19);

  const { baseUrl, close } = await startApp({
    env: { OPENWEATHER_API_KEY: 'key123', OPENWEATHER_CITY: 'Kiritimati' },
    fetchFn: async (url) => {
      if (String(url).includes('/weather?')) {
        return { ok: true, json: async () => ({
          name: 'Kiritimati', timezone: offsetSec, main: { temp: 28, feels_like: 30, humidity: 75 },
          weather: [{ icon: '01d', description: 'klar' }], wind: { speed: 5 } }) };
      }
      return { ok: true, json: async () => ({ list: [
        { dt_txt: asUtcStamp(dayBefore, 21), main: { temp: 24 }, weather: [{ icon: '01n', description: 'klar' }] },
        { dt_txt: asUtcStamp(localToday, 12), main: { temp: 29 }, weather: [{ icon: '01d', description: 'klar' }] },
        { dt_txt: asUtcStamp(dayAfter, 12), main: { temp: 30 }, weather: [{ icon: '02d', description: 'leicht bewoelkt' }] },
      ] }) };
    },
  });
  try {
    const { body } = await getJson(baseUrl);
    assert.equal(body.data.today.date, localToday);
    assert.equal(body.data.forecast.some((d) => d.date <= localToday), false,
      'ein vergangener oder laufender Ortstag darf nicht in der Vorhersage stehen');
    assert.equal(body.data.forecast[0].date, dayAfter);
  } finally { await close(); }
});

test('OWM: die Tagesbuckets folgen dem Ortstag, nicht dem UTC-Tag', async () => {
  // Los Angeles (UTC-7): 00:00 UTC gehoert dort noch zum Vortag. Wird nach
  // UTC-Tagen gebuendelt, mischen sich Abend- und Folgetagswerte zu einem
  // Hoch/Tief, das es an keinem Ortstag gab.
  const offsetSec = -7 * 3600;
  const day = new Date(Date.now() + offsetSec * 1000 + 86400000).toISOString().slice(0, 10);
  const asUtcStamp = (localDay, hour) =>
    new Date(new Date(`${localDay}T${String(hour).padStart(2, '0')}:00:00Z`).getTime() - offsetSec * 1000)
      .toISOString().replace('T', ' ').slice(0, 19);

  const { baseUrl, close } = await startApp({
    env: { OPENWEATHER_API_KEY: 'key123', OPENWEATHER_CITY: 'Los Angeles' },
    fetchFn: async (url) => {
      if (String(url).includes('/weather?')) {
        return { ok: true, json: async () => ({
          name: 'Los Angeles', timezone: offsetSec, main: { temp: 21, feels_like: 20, humidity: 60 },
          weather: [{ icon: '01d', description: 'klar' }], wind: { speed: 4 } }) };
      }
      return { ok: true, json: async () => ({ list: [
        // Alle drei Schritte liegen am selben ORTSTAG, verteilen sich in UTC aber
        // ueber zwei Kalendertage.
        { dt_txt: asUtcStamp(day, 6),  main: { temp: 14 }, weather: [{ icon: '01d', description: 'klar' }] },
        { dt_txt: asUtcStamp(day, 12), main: { temp: 26 }, weather: [{ icon: '02d', description: 'sonnig' }] },
        { dt_txt: asUtcStamp(day, 21), main: { temp: 18 }, weather: [{ icon: '01n', description: 'klar' }] },
      ] }) };
    },
  });
  try {
    const { body } = await getJson(baseUrl);
    const entry = body.data.forecast.find((d) => d.date === day);
    assert.ok(entry, `${day} sollte als EIN Tag in der Vorhersage stehen`);
    assert.equal(body.data.forecast.length, 1, 'ein Ortstag, ein Eintrag');
    assert.equal(entry.temp_min, 14);
    assert.equal(entry.temp_max, 26);
    // Das Symbol kommt vom Schritt, der dem ORTSMITTAG am naechsten liegt.
    assert.equal(entry.desc, 'sonnig');
  } finally { await close(); }
});
