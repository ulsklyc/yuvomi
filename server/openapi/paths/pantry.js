import { op, jsonBody, idParam } from '../helpers.js';

export function pantryPaths() {
  return {
    '/api/v1/pantry': {
      get: op({
        summary: 'List pantry items with storage locations and categories',
        description: 'Each pantry item is one batch (a quantity with its own location and best-before date). `product_id` names the household product the batch belongs to: '
          + 'batches with the same name, compared trimmed, case-insensitive and with collapsed whitespace, and the same unit share one product. '
          + 'The server sets it on every write that changes the name, unit or category, and moves the batch to another product when the name or unit no longer matches; '
          + 'a `product_id` in a request body is ignored. Every pantry item response carries it. '
          + '`products` lists the household products (`id`, `name`, `unit`, `category`, `batch_count`), including products whose last batch is gone (`batch_count` 0).',
        tag: 'Pantry',
      }),
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
          + 'An item joins an existing batch when the name (trimmed, whitespace collapsed, case-insensitive), the storage location and the unit fit - the same unit, or one that converts (g/kg, ml/l; the amount is converted into the unit of the batch) - and the best-before dates are equal or one of them is empty. '
          + 'The response lists `changes` per item (`added`, or `merged` with `quantity_added` and `expires_set`), which `POST /api/v1/pantry/import-shopping/undo` takes back. '
          + 'Reads the shopping list, so it requires read access to the `shopping` module in addition to `pantry` - a credential without it is refused with 403 and `reason: "cross_module_access"`.',
        tag: 'Pantry',
        stateChanging: true,
        requestBody: jsonBody(null),
      }),
    },
    '/api/v1/pantry/import-shopping/undo': {
      post: op({
        summary: 'Undo a take-over from a shopping list',
        description: 'Body: `{ changes }`, the `changes` of one `POST /api/v1/pantry/import-shopping` response. A batch the take-over created is deleted; a batch it topped up is reduced by exactly the amount it added, and a best-before date the take-over set is cleared again. '
          + 'The amount is subtracted, not written back, so a change someone made to the batch in the meantime stays. Batches that are gone are skipped; `removed` and `reduced` report what actually went back.',
        tag: 'Pantry',
        stateChanging: true,
        requestBody: jsonBody(null),
      }),
    },
    '/api/v1/pantry/products/{productId}': {
      delete: op({
        summary: 'Delete pantry product without batches',
        description: 'Deletes a household product whose last batch is gone (`batch_count` 0 in `GET /api/v1/pantry`). '
          + 'A product that still has batches is refused with 409 and `reason` `pantry_product_has_batches`; its batches are never deleted along with it.',
        tag: 'Pantry',
        params: [idParam('productId', 'Product ID')],
        stateChanging: true,
        responses: {
          204: { description: 'Product deleted' },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { description: 'Product not found' },
          409: { description: 'The product still has batches. The response body reason is `pantry_product_has_batches`, `count` the number of batches.' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/pantry/{itemId}': {
      put: op({ summary: 'Replace pantry item', tag: 'Pantry', params: [idParam('itemId', 'Item ID')], stateChanging: true, requestBody: jsonBody(null) }),
      patch: op({ summary: 'Partially update pantry item', tag: 'Pantry', params: [idParam('itemId', 'Item ID')], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete pantry item', tag: 'Pantry', params: [idParam('itemId', 'Item ID')], stateChanging: true }),
    },
  };
}
