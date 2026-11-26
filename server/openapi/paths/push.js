import { op, jsonBody, withValidationRefusal } from '../helpers.js';

const UNAUTHORIZED = { $ref: '#/components/responses/Unauthorized' };
const SERVER_ERROR = { $ref: '#/components/responses/InternalServerError' };

/**
 * The answers of an operation (#2810, group 11b): its success and the refusals
 * of the route itself. The 400 of validateRequest() is added to every
 * operation with a body at the end of pushPaths().
 * @param {number} status @param {string} description
 * @returns {Record<string, unknown>}
 */
const answers = (status, description) => ({
  [status]: { description },
  401: UNAUTHORIZED,
  500: SERVER_ERROR,
});

/** The operations with a body. */
const WITH_INPUT = [
  ['/api/v1/push/subscribe', 'post'],
  ['/api/v1/push/unsubscribe', 'post'],
  ['/api/v1/push/wall-mode', 'put'],
  ['/api/v1/push/test', 'post'],
];

export function pushPaths() {
  /** @type {Record<string, Record<string, any>>} */
  const paths = {
    '/api/v1/push/vapid-public-key': { get: op({ summary: 'Get VAPID public key', tag: 'Push' }) },
    '/api/v1/push/subscribe': { post: op({ summary: 'Register a push subscription', tag: 'Push', stateChanging: true, requestBody: jsonBody('#/components/schemas/PushSubscribeInput'), responses: answers(201, 'Subscription stored for the caller, `{ data: { id } }`. Subscribing an endpoint again updates its keys; an endpoint taken over from another account loses its wall pause.'), description: 'Body: the browser\'s `PushSubscription.toJSON()`, `{ endpoint, keys: { p256dh, auth } }`; further fields such as `expirationTime` are ignored. `endpoint` must be a public https address (no private or local host, no credentials, at most 2048 characters), otherwise 400.' }) },
    '/api/v1/push/unsubscribe': { post: op({ summary: 'Remove a push subscription', tag: 'Push', stateChanging: true, requestBody: jsonBody('#/components/schemas/PushUnsubscribeInput'), responses: answers(204, 'Removed, or there was no such subscription of the caller') }) },
    '/api/v1/push/wall-mode': { put: op({ summary: 'Pause or resume push delivery for the current device while it shows the wall', tag: 'Push', stateChanging: true, requestBody: jsonBody('#/components/schemas/PushWallModeInput'), responses: answers(204, 'Pause set or cleared, or there was no such subscription of the caller') }) },
    '/api/v1/push/test': { post: op({ summary: 'Send a test push to the current user', tag: 'Push', stateChanging: true, requestBody: { ...jsonBody('#/components/schemas/PushTestInput'), required: false }, responses: answers(200, '`{ data: { sent, devices } }`: how many subscriptions received the push, and how many the caller had before sending (a subscription the push service reports as gone is removed while sending).') }) },
  };
  for (const [path, method] of WITH_INPUT) withValidationRefusal(paths[path][method]);
  return paths;
}
