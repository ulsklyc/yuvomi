import { op, jsonBody, idParam } from '../helpers.js';

export function pantryPaths() {
  return {
    '/api/v1/pantry': {
      get: op({ summary: 'List pantry items with storage locations and categories', tag: 'Pantry' }),
      post: op({ summary: 'Create pantry item', tag: 'Pantry', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/pantry/locations': {
      get: op({ summary: 'List storage locations', tag: 'Pantry' }),
      post: op({ summary: 'Create storage location', tag: 'Pantry', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/pantry/locations/reorder': {
      patch: op({ summary: 'Reorder storage locations', tag: 'Pantry', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/pantry/locations/{locId}': {
      put: op({ summary: 'Update storage location', tag: 'Pantry', params: [idParam('locId', 'Storage location ID')], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({
        summary: 'Delete storage location',
        description: 'Items keep their stock and become location-less; the last remaining location cannot be deleted.',
        tag: 'Pantry',
        params: [idParam('locId', 'Storage location ID')],
        stateChanging: true,
      }),
    },
    '/api/v1/pantry/import-shopping': {
      post: op({
        summary: 'Take checked shopping items into the pantry',
        description: 'Creates or increments pantry items from the checked items of a shopping list. Does not modify the shopping list itself - clear it separately via DELETE /api/v1/shopping/{listId}/items/checked. '
          + 'Reads the shopping list, so it requires read access to the `shopping` module in addition to `pantry` - a credential without it is refused with 403.',
        tag: 'Pantry',
        stateChanging: true,
        requestBody: jsonBody(null),
      }),
    },
    '/api/v1/pantry/{itemId}': {
      put: op({ summary: 'Replace pantry item', tag: 'Pantry', params: [idParam('itemId', 'Item ID')], stateChanging: true, requestBody: jsonBody(null) }),
      patch: op({ summary: 'Partially update pantry item', tag: 'Pantry', params: [idParam('itemId', 'Item ID')], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete pantry item', tag: 'Pantry', params: [idParam('itemId', 'Item ID')], stateChanging: true }),
    },
  };
}
