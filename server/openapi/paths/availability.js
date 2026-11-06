import { jsonBody, op } from '../helpers.js';

export function availabilityPaths() {
  return {
    '/api/v1/availability': {
      get: op({
        summary: 'List household availability statuses',
        tag: 'Family',
        description: 'Returns the active (non-expired) availability statuses for all household members. '
          + 'Rows whose `expires_at` is in the past are omitted. Ordered by `set_at` descending.',
        responses: {
          200: {
            description: 'Active availability statuses',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['data'],
                  properties: {
                    data: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/AvailabilityStatus' },
                    },
                  },
                },
              },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
      put: op({
        summary: 'Set or update own availability status',
        tag: 'Family',
        stateChanging: true,
        requestBody: jsonBody('#/components/schemas/AvailabilityInput'),
        description: 'Sets or updates the calling user\'s availability status. '
          + 'Only one status row exists per user (UPSERT). '
          + '`state` must be one of `available`, `busy`, `do_not_disturb`, `away`. '
          + '`note` is optional free text up to 200 characters. '
          + '`expires_at` is a required ISO-8601 UTC timestamp (`YYYY-MM-DDTHH:MM:SSZ`) that must be in the future.',
        responses: {
          200: {
            description: 'The stored status',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['data'],
                  properties: {
                    data: { $ref: '#/components/schemas/AvailabilityStatus' },
                  },
                },
              },
            },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
      delete: op({
        summary: 'Clear own availability status',
        tag: 'Family',
        stateChanging: true,
        description: 'Removes the calling user\'s availability status row. '
          + 'Idempotent — if no row exists the response is still 200.',
        responses: {
          200: {
            description: 'Status cleared',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['data'],
                  properties: { data: { type: 'null' } },
                },
              },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
  };
}
