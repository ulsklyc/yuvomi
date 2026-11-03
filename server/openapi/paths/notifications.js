import { op, jsonBody, idParam } from '../helpers.js';

export function notificationsPaths() {
  return {
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
        requestBody: jsonBody('#/components/schemas/NotificationChannelInput'),
        responses: {
          200: { description: 'Successful response' },
          401: { $ref: '#/components/responses/Unauthorized' },
          409: { description: 'Not a household channel; it stays unchanged and can only be deleted here' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
      delete: op({
        summary: 'Delete a household notification channel',
        tag: 'Notifications',
        admin: true,
        stateChanging: true,
        params: [idParam()],
      }),
    },
    '/api/v1/notifications/channels/{id}/test': {
      post: op({
        summary: 'Send a test notification through a channel',
        tag: 'Notifications',
        admin: true,
        stateChanging: true,
        params: [idParam()],
      }),
    },

    // --- Health module ---
  };
}
