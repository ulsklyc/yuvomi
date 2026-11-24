import { op, jsonBody, withValidationRefusal } from '../helpers.js';
import { SCREENSAVER_PHOTO_ID_PATTERN } from '../../display-scopes.js';

export function screensaverPaths() {
  return {
    '/api/v1/screensaver/config': {
      get: op({
        summary: 'Get screensaver configuration',
        tag: 'Screensaver',
        admin: true,
        description: 'Immich connection settings for the wall-display screensaver. Admin only, '
          + 'because it carries the connection details of an external server.',
      }),
      put: withValidationRefusal(op({
        summary: 'Update screensaver configuration',
        tag: 'Screensaver',
        admin: true,
        stateChanging: true,
        requestBody: jsonBody('#/components/schemas/ScreensaverConfigInput'),
        description: 'A rejected field answers 400 with a `reason` next to the `error` (#1909): '
          + '`immich_url_invalid` (the URL is not text, does not start with http:// or https://, or is longer than 2048 characters), '
          + '`immich_album_id_invalid` (the album ID is not text or not a UUID), `immich_api_key_invalid` (the API key is longer than 1000 characters). '
          + 'A missing body, a body that is no object, an API key that is not text and a `clearApiKey` that is not a boolean answer 400 with `reason: \'validation\'`. '
          + 'A refusal of the request schema carries `fields` and is answered before anything is stored.',
      })),
    },
    '/api/v1/screensaver/test': {
      post: op({
        summary: 'Test the Immich connection',
        tag: 'Screensaver',
        admin: true,
        stateChanging: true,
        description: 'Calls the configured Immich server once and reports how many photos the album '
          + 'holds. Answers 502 if Immich cannot be reached, so a wrong URL or token shows up here '
          + 'rather than as an empty screensaver. Each failure carries a `reason` (#1909): '
          + '`immich_not_configured` (400, URL or API key missing), `immich_api_key_rejected` (502, Immich answered 401 or 403), '
          + '`immich_http_status` (502, any other error status, with `params.status`), `immich_unreachable` (502, no connection or timeout).',
      }),
    },
    '/api/v1/screensaver/photos': {
      get: op({
        summary: 'List screensaver photos',
        tag: 'Screensaver',
        description: 'The asset ids of the configured album. Readable by every member: the wall '
          + 'display shows them, and it does not run as an administrator.',
      }),
    },
    '/api/v1/screensaver/photos/{id}': {
      get: withValidationRefusal(op({
        summary: 'Fetch one screensaver photo',
        tag: 'Screensaver',
        params: [{
          name: 'id',
          in: 'path',
          required: true,
          description: 'Immich asset ID, a UUID (either letter case). Any other shape answers 400, also when Immich is not configured.',
          schema: { type: 'string', pattern: SCREENSAVER_PHOTO_ID_PATTERN },
        }],
        description: 'Proxies the image bytes from Immich. It is fetched through Yuvomi rather than '
          + 'linked directly so the browser never needs the Immich token.',
      })),
    },
  };
}
