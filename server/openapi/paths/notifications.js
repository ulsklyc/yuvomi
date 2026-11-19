import { op, jsonBody, idParam, withCaseReasons, withValidationRefusal } from '../helpers.js';

// #2837: a channel URL in a private or local network. Saving refuses what is
// decided without DNS (localhost, an internal suffix, an IP literal); a test
// refuses a host name that resolves there. Both name the switch in `error`.
const PRIVATE_NETWORK_ON_SAVE = '`notifications_private_network` (400, the URL points to a private or local network address '
  + 'and NOTIFICATION_ALLOW_PRIVATE_NETWORK is not set)';
const PRIVATE_NETWORK_ON_TEST = '`notifications_private_network` (400, the channel URL resolves to a private or local network address '
  + 'and NOTIFICATION_ALLOW_PRIVATE_NETWORK is not set; nothing was sent to the private address)';
const CASE_REASONS = {
  '/api/v1/notifications/channels': { post: PRIVATE_NETWORK_ON_SAVE },
  '/api/v1/notifications/channels/{id}': { put: PRIVATE_NETWORK_ON_SAVE },
  '/api/v1/notifications/channels/{id}/test': { post: PRIVATE_NETWORK_ON_TEST },
};

export function notificationsPaths() {
  return withCaseReasons('notifications', CASE_REASONS, {
    '/api/v1/notifications/providers': {
      get: op({
        summary: 'List supported notification channel providers',
        tag: 'Notifications',
        admin: true,
      }),
    },
    '/api/v1/notifications/channels': {
      get: op({
        summary: 'List household notification channels',
        tag: 'Notifications',
        admin: true,
        responses: {
          200: {
            description: 'Notification channels with secrets omitted',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/NotificationChannelListResponse' } } },
          },
          403: { $ref: '#/components/responses/Forbidden' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
      post: op({
        summary: 'Create a household notification channel',
        tag: 'Notifications',
        admin: true,
        stateChanging: true,
        requestBody: jsonBody('#/components/schemas/NotificationChannelInput'),
        responses: {
          201: {
            description: 'Notification channel created',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/NotificationChannelResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          403: { $ref: '#/components/responses/Forbidden' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/notifications/channels/{id}': {
      put: op({
        summary: 'Update a household notification channel',
        tag: 'Notifications',
        admin: true,
        stateChanging: true,
        params: [idParam()],
        requestBody: jsonBody('#/components/schemas/NotificationChannelUpdateInput'),
        responses: {
          200: { description: 'Successful response' },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { description: 'No notification channel with this id' },
          409: { description: 'Not a household channel; it stays unchanged and can only be deleted here' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
      delete: withValidationRefusal(op({
        summary: 'Delete a household notification channel',
        tag: 'Notifications',
        admin: true,
        stateChanging: true,
        params: [idParam()],
      })),
    },
    '/api/v1/notifications/channels/{id}/test': {
      post: withValidationRefusal(op({
        summary: 'Send a test notification through a channel',
        tag: 'Notifications',
        admin: true,
        stateChanging: true,
        params: [idParam()],
      })),
    },

    // --- Health module ---
  });
}
