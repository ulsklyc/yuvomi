import { op, jsonBody, idParam } from '../helpers.js';

const stepIdParam = {
  name: 'stepId',
  in: 'path',
  required: true,
  description: 'Step ID',
  schema: { type: 'integer' },
};

export function routinesPaths() {
  return {
    '/api/v1/routines': {
      get: op({ summary: 'List routines with today\'s check state', tag: 'Routines' }),
      post: op({
        summary: 'Create a routine',
        description: 'Admin only. Slot must be "morning" or "evening". user_id is optional; omit for a household-wide routine.',
        tag: 'Routines',
        stateChanging: true,
        requestBody: jsonBody(null),
      }),
    },
    '/api/v1/routines/{id}': {
      put: op({
        summary: 'Update a routine',
        description: 'Admin only.',
        tag: 'Routines',
        params: [idParam()],
        stateChanging: true,
        requestBody: jsonBody(null),
      }),
      delete: op({
        summary: 'Delete a routine',
        description: 'Admin only. Cascades to steps and check records.',
        tag: 'Routines',
        params: [idParam()],
        stateChanging: true,
      }),
    },
    '/api/v1/routines/{id}/steps': {
      post: op({
        summary: 'Add a step to a routine',
        description: 'Admin only.',
        tag: 'Routines',
        params: [idParam()],
        stateChanging: true,
        requestBody: jsonBody(null),
      }),
    },
    '/api/v1/routines/{id}/steps/{stepId}': {
      put: op({
        summary: 'Update a step',
        description: 'Admin only.',
        tag: 'Routines',
        params: [idParam(), stepIdParam],
        stateChanging: true,
        requestBody: jsonBody(null),
      }),
      delete: op({
        summary: 'Delete a step',
        description: 'Admin only. Cascades to check records for this step.',
        tag: 'Routines',
        params: [idParam(), stepIdParam],
        stateChanging: true,
      }),
    },
    '/api/v1/routines/{id}/steps/{stepId}/check': {
      post: op({
        summary: 'Check a step for today',
        description: 'Idempotent — checking an already-checked step is a no-op.',
        tag: 'Routines',
        params: [idParam(), stepIdParam],
        stateChanging: true,
      }),
      delete: op({
        summary: 'Uncheck a step for today',
        tag: 'Routines',
        params: [idParam(), stepIdParam],
        stateChanging: true,
      }),
    },
  };
}
