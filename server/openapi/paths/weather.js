import { op } from '../helpers.js';

export function weatherPaths() {
  return {
    '/api/v1/weather': { get: op({ summary: 'Get weather data', tag: 'Weather', description: 'Returns `{ data: { provider, city, units, current, today, forecast } }` or `{ data: null, reason }` when there is no weather: `reason` is `not_configured` (no provider set up, or the chosen one is incomplete - no coordinates, no API key) or `upstream_error` (a provider is set up but the request to it failed; the server logs the cause). `today` carries the calendar day at the weather location plus its high/low; `forecast` holds the following days only. `provider` is `open-meteo` (icon fields are Lucide icon names, `desc` is a `wmo.<code>` i18n key) or `openweathermap` (legacy; icon fields are OWM icon codes, `desc` is localized text).' }) },
    '/api/v1/weather/icon/{code}': {
      get: op({ summary: 'Get weather icon asset', tag: 'Weather', params: [{ name: 'code', in: 'path', required: true, schema: { type: 'string' } }] }),
    },
  };
}
