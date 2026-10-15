import { op, jsonBody } from '../helpers.js';

export function pushPaths() {
  return {
    '/api/v1/push/vapid-public-key': { get: op({ summary: 'Get VAPID public key', tag: 'Push' }) },
    '/api/v1/push/subscribe': { post: op({ summary: 'Register a push subscription', tag: 'Push', stateChanging: true, requestBody: jsonBody(null) }) },
    '/api/v1/push/unsubscribe': { post: op({ summary: 'Remove a push subscription', tag: 'Push', stateChanging: true, requestBody: jsonBody(null) }) },
    '/api/v1/push/wall-mode': { put: op({ summary: 'Pause or resume push delivery for the current device while it shows the wall', tag: 'Push', stateChanging: true, requestBody: jsonBody(null) }) },
    '/api/v1/push/test': { post: op({ summary: 'Send a test push to the current user', tag: 'Push', stateChanging: true }) },
  };
}
