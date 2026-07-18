import { op, jsonBody, idParam } from '../helpers.js';

export function birthdaysPaths() {
  return {
    '/api/v1/birthdays': {
      get: op({ summary: 'List birthdays', tag: 'Birthdays' }),
      post: op({ summary: 'Create birthday', tag: 'Birthdays', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/birthdays/upcoming': {
      get: op({ summary: 'List upcoming birthdays', tag: 'Birthdays' }),
    },
    '/api/v1/birthdays/import/candidates': {
      get: op({ summary: 'List contacts eligible for birthday import', tag: 'Birthdays' }),
    },
    '/api/v1/birthdays/import': {
      post: op({ summary: 'Import selected contacts as birthdays', tag: 'Birthdays', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/birthdays/meta/options': {
      get: op({ summary: 'Get birthday upload options', tag: 'Birthdays' }),
    },
    '/api/v1/birthdays/{id}': {
      put: op({ summary: 'Update birthday', tag: 'Birthdays', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete birthday', tag: 'Birthdays', params: [idParam()], stateChanging: true }),
    },
  };
}
