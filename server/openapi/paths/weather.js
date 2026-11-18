import { op, withValidationRefusal } from '../helpers.js';
import { DEFAULT_LOCALE, getSupportedLocales } from '../../utils/i18n.js';

// validateRequest() checks these (#2810). Both routes read `lang` leniently -
// a region tag (`de-AT`) or an unknown code falls back - so it is plain text.
/** @param {string} description */
function langText(description) {
  return { name: 'lang', in: 'query', required: false, description, schema: { type: 'string' } };
}

export function weatherPaths() {
  return {
    '/api/v1/weather': { get: withValidationRefusal(op({
      summary: 'Get weather data',
      tag: 'Weather',
      params: [
        langText('Language of `desc` for the legacy `openweathermap` provider: an app locale, an OpenWeatherMap code or a region tag such as `de-AT`. Anything else falls back to the server setting, then English. Not read for `open-meteo`.'),
        { name: 'city', in: 'query', required: false, description: 'Place for the legacy `openweathermap` provider instead of the configured one. Not read for `open-meteo`.', schema: { type: 'string' } },
      ],
      description: 'Returns `{ data: { provider, city, units, current, today, forecast } }` or `{ data: null, reason }` when there is no weather: `reason` is `not_configured` (no provider set up, or the chosen one is incomplete - no coordinates, no API key) or `upstream_error` (a provider is set up but the request to it failed; the server logs the cause). `city` is the configured place name, or `null` when none is set (the coordinates are never sent in its place). `today` carries the calendar day at the weather location plus its high/low; `forecast` holds the following days only. `provider` is `open-meteo` (icon fields are Lucide icon names, `desc` is a `wmo.<code>` i18n key) or `openweathermap` (legacy; icon fields are OWM icon codes, `desc` is localized text).',
    })) },
    '/api/v1/weather/geocode': {
      get: withValidationRefusal(op({
        summary: 'Search a place for the weather location',
        tag: 'Weather',
        description: 'Looks up places by name through the Open-Meteo Geocoding API (server-side; only the name and the result language are sent). Returns `{ data: [{ name, admin1, admin2, country, country_code, latitude, longitude, timezone }] }` with up to 8 places, an empty list when nothing matches, or `{ data: null, reason: \'upstream_error\' }` when the request to the provider failed or timed out. A name shorter than 2 characters answers 400 with `reason: \'name_too_short\'`, one longer than 100 characters 400 with `reason: \'name_too_long\'`. Results are cached for 30 minutes per name and language.',
        params: [
          {
            name: 'name',
            in: 'query',
            required: true,
            description: 'The place name, 2 to 100 characters after trimming surrounding spaces (counted in UTF-16 code units). Missing, empty or given twice answers 400 `name_too_short`.',
            // Only what agrees with the route on every input: the exact 2..100
            // is counted after trim in UTF-16 units and stays in the handler.
            schema: { type: 'string', minLength: 1, 'x-reason': 'name_too_short' },
          },
          langText(`Language of the results. Supported values: ${getSupportedLocales().join(', ')}. A region tag such as \`de-AT\` uses its language; anything else, and no value, means ${DEFAULT_LOCALE}.`),
        ],
      })),
    },
    '/api/v1/weather/icon/{code}': {
      get: withValidationRefusal(op({
        summary: 'Get weather icon asset',
        tag: 'Weather',
        params: [{ name: 'code', in: 'path', required: true, description: 'An OpenWeatherMap icon code such as `10d`.', schema: { type: 'string', pattern: '^[a-zA-Z0-9]{2,4}$' } }],
      })),
    },
  };
}
