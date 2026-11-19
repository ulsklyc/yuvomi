import { op, idParam, withCaseReasons, withValidationRefusal } from '../helpers.js';
import { MAX_SHORT, MAX_TEXT, MAX_TITLE } from '../../middleware/validate.js';
import { OPTIONAL_DATE_PATTERN } from '../../utils/datetime-pattern.js';
import { PANTRY_UNITS, MAX_PANTRY_QUANTITY } from '../../../public/utils/pantry-units.js';

/**
 * `min_quantity` on a pantry item since #1448, step 3: the product's value,
 * written through to the product. Deprecated; the CHANGELOG names the version
 * in which the batch field goes.
 */
const MIN_QUANTITY_MIRROR = '`min_quantity` on a pantry item is deprecated: it returns the minimum of the product the item belongs to, and a write of it on a batch '
  + '(create with a number, replace or partial update when the field is sent; null clears) is written through to the product, so it applies to all its batches. '
  + 'A replace or create without the field leaves the minimum of the product alone. Read the minimum from `products` instead.';

/** @param {string} description */
const apiError = (description) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
});

/**
 * The answers of an operation with its real success status (#2810).
 * @param {number} status
 * @param {string} description
 * @param {Record<string, unknown>} [extra]
 */
const answers = (status, description, extra = {}) => ({
  [status]: { description },
  400: { $ref: '#/components/responses/BadRequest' },
  401: { $ref: '#/components/responses/Unauthorized' },
  500: { $ref: '#/components/responses/InternalServerError' },
  ...extra,
});

/**
 * A JSON body that must be sent.
 * @param {Record<string, unknown>} schema
 */
const body = (schema) => ({
  required: true,
  description: 'JSON request body',
  content: { 'application/json': { schema } },
});

// Ziffern-Text ist eine Altform (#2810): Service Worker aelterer App-Staende
// schicken die Lagerort-ID als Text. Die App schickt heute Zahlen.
const LOCATION_ID = {
  anyOf: [{ type: 'integer' }, { type: 'string', pattern: '^[0-9]+$' }, { type: 'null' }],
  description: 'The storage location, a whole number; `null` means none. Digit text is accepted as a legacy form (older app versions send it).',
};

/**
 * The fields of a pantry item (#2810). `unit` is the one list of
 * public/utils/pantry-units.js; with `keepUnit`, `null` keeps the stored unit
 * (PUT and PATCH read it so). The category is a row of the shopping
 * categories and stays the route's check.
 * @param {{ keepUnit: boolean, partial: boolean }} options
 */
function itemProperties({ keepUnit, partial }) {
  return {
    name: { type: 'string', maxLength: MAX_TITLE, description: `At most ${MAX_TITLE} characters as sent; empty after trimming spaces is refused.` },
    quantity: {
      type: 'number',
      minimum: 0,
      description: partial
        ? 'Rounded to two decimals, at most 1,000,000.'
        : 'Rounded to two decimals, at most 1,000,000. Left out, 1.',
    },
    unit: keepUnit
      ? { type: ['string', 'null'], enum: [...PANTRY_UNITS, null], description: '`null` or left out keeps the stored unit.' }
      : { type: 'string', enum: [...PANTRY_UNITS], description: 'Left out, `pcs`.' },
    location_id: LOCATION_ID,
    category: { type: ['string', 'null'], description: 'A shopping category name; empty or `null` keeps the stored one or takes the last category.' },
    expires_on: {
      type: ['string', 'null'],
      pattern: OPTIONAL_DATE_PATTERN,
      description: 'Best-before day `YYYY-MM-DD`; a day that does not exist is refused. `""` or `null` means none.',
    },
    min_quantity: { type: ['number', 'null'], minimum: 0, description: 'Deprecated, see the operation. `null` clears the product minimum.' },
    notes: { type: ['string', 'null'], maxLength: MAX_TEXT, description: `At most ${MAX_TEXT} characters. \`null\` or \`""\` means none.` },
  };
}

/**
 * The body of a take and of its undo (#1891): one amount in the unit of the
 * item, at least 0.01 (the smallest step a quantity keeps) and at most
 * MAX_PANTRY_QUANTITY.
 * @param {string} description
 */
const TAKE_BODY = (description) => ({
  type: 'object',
  required: ['amount'],
  properties: {
    amount: { type: 'number', minimum: 0.01, maximum: MAX_PANTRY_QUANTITY, description },
  },
});

const LOCATION_FIELDS = {
  name: { type: 'string', maxLength: MAX_SHORT, description: `At most ${MAX_SHORT} characters as sent.` },
  icon: { type: ['string', 'null'], maxLength: MAX_SHORT, description: 'A Lucide icon name; `null` or `""` keeps the stored one (on create: `package`).' },
};

export function pantryPaths() {
  return withCaseReasons('pantry', CASE_REASONS, { ...stockPaths(), ...takePaths() });
}

/** The pantry items, locations, products and the take-over from Shopping. */
function stockPaths() {
  return {
    '/api/v1/pantry': {
      get: op({
        summary: 'List pantry items with storage locations and categories',
        description: 'Each pantry item is one batch (a quantity with its own location and best-before date). `product_id` names the household product the batch belongs to: '
          + 'batches with the same name, compared trimmed, case-insensitive and with collapsed whitespace, and the same unit share one product. '
          + 'The server sets it on every write that changes the name, unit or category, and moves the batch to another product when the name or unit no longer matches; '
          + 'a `product_id` in a request body is ignored. Every pantry item response carries it. '
          + '`products` lists the household products (`id`, `name`, `unit`, `category`, `min_quantity`, `batch_count`, `total_quantity`), including products whose last batch is gone (`batch_count` 0, `total_quantity` 0). '
          + 'The minimum belongs to the product: a product is out of stock when `total_quantity` is 0 and running low when it is at or below `min_quantity`. '
          + MIN_QUANTITY_MIRROR,
        tag: 'Pantry',
      }),
      post: op({
        summary: 'Create pantry item',
        description: `${MIN_QUANTITY_MIRROR} A body outside the schema (a text field that is not text, a quantity as text, a unit outside the list) answers 400 with \`fields\`. An unknown location answers 400 \`Location not found.\`.`,
        tag: 'Pantry',
        stateChanging: true,
        requestBody: body({ type: 'object', required: ['name'], properties: itemProperties({ keepUnit: false, partial: false }) }),
        responses: answers(201, 'Pantry item created'),
      }),
    },
    '/api/v1/pantry/locations': {
      get: op({ summary: 'List storage locations', tag: 'Pantry' }),
      post: op({
        summary: 'Create storage location',
        tag: 'Pantry',
        stateChanging: true,
        requestBody: body({ type: 'object', required: ['name'], properties: LOCATION_FIELDS }),
        responses: answers(201, 'Storage location created', { 409: apiError('A storage location with this name already exists') }),
      }),
    },
    '/api/v1/pantry/locations/reorder': {
      patch: withValidationRefusal(op({
        summary: 'Reorder storage locations',
        description: 'Body: `{ order }`, the location ids in the wanted order. Ids that do not exist are skipped.',
        tag: 'Pantry',
        stateChanging: true,
        requestBody: body({
          type: 'object',
          required: ['order'],
          properties: {
            order: {
              type: 'array',
              minItems: 1,
              items: { anyOf: [{ type: 'integer' }, { type: 'string', pattern: '^[0-9]+$' }] },
              description: 'Location ids as whole numbers. Digit text is accepted as a legacy form (older app versions send it).',
            },
          },
        }),
      })),
    },
    '/api/v1/pantry/locations/{locId}': {
      put: withValidationRefusal(op({
        summary: 'Update storage location',
        description: 'Renames a location: `name` is required, `icon` optional. The body is checked against the schema before the location is looked up.',
        tag: 'Pantry',
        params: [idParam('locId', 'Storage location ID, plain decimal digits.')],
        stateChanging: true,
        requestBody: body({ type: 'object', required: ['name'], properties: LOCATION_FIELDS }),
      })),
      delete: op({
        summary: 'Delete storage location',
        description: 'Items keep their stock and become location-less; the last remaining location cannot be deleted. The answer is `{ ok: true, orphaned }`, the number of items that lost their location - not wrapped in `data`.',
        tag: 'Pantry',
        params: [idParam('locId', 'Storage location ID, plain decimal digits.')],
        stateChanging: true,
        responses: answers(200, 'Location deleted', {
          200: {
            description: 'Location deleted',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['ok', 'orphaned'],
                  properties: {
                    ok: { type: 'boolean' },
                    orphaned: { type: 'integer', description: 'How many items lost their location.' },
                  },
                },
              },
            },
          },
          404: apiError('No such storage location'),
        }),
      }),
    },
    '/api/v1/pantry/import-shopping': {
      post: withValidationRefusal(op({
        summary: 'Take checked shopping items into the pantry',
        description: 'Creates or increments pantry items from the checked items of a shopping list. Does not modify the shopping list itself - clear it separately via DELETE /api/v1/shopping/{listId}/items/checked. '
          + 'An item joins an existing batch when the name (trimmed, whitespace collapsed, case-insensitive), the storage location and the unit fit - the same unit, or one that converts (g/kg, ml/l; the amount is converted into the unit of the batch) - and the best-before dates are equal or one of them is empty. '
          + 'The response lists `changes` per item (`added`, or `merged` with `quantity_added` and `expires_set`), which `POST /api/v1/pantry/import-shopping/undo` takes back. '
          + 'Reads the shopping list, so it requires read access to the `shopping` module in addition to `pantry` - a credential without it is refused with 403 and `reason: "cross_module_access"`, for any body. '
          + 'Then the body is checked against the schema. A row whose shopping item is not checked (or gone) is skipped and counted in `skipped`; a row with a storage location that does not exist answers 400 `Location not found.` and nothing is taken over. '
          + 'An `expires_on` that is not a real day is dropped and the item still arrives.',
        tag: 'Pantry',
        stateChanging: true,
        requestBody: body({
          type: 'object',
          required: ['list_id'],
          properties: {
            list_id: { type: 'integer', description: 'The shopping list the checked items come from.' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  shopping_item_id: { type: 'integer' },
                  quantity: { type: 'number', description: 'Rounded to two decimals, below 0 is 0; left out, 1.' },
                  unit: { type: 'string', enum: [...PANTRY_UNITS], description: 'Left out, `pcs`.' },
                  location_id: LOCATION_ID,
                  expires_on: { type: ['string', 'null'], description: 'Best-before day `YYYY-MM-DD`; anything else is dropped, the item still arrives.' },
                },
              },
              description: 'One entry per shopping item to take over; left out or empty, nothing happens.',
            },
          },
        }),
        responses: answers(200, 'Successful response', {
          403: apiError('No read access to the shopping list (`cross_module_access`)'),
          404: apiError('No such shopping list'),
        }),
      })),
    },
    '/api/v1/pantry/import-shopping/undo': {
      post: withValidationRefusal(op({
        summary: 'Undo a take-over from a shopping list',
        description: 'Body: `{ changes }`, the `changes` of one `POST /api/v1/pantry/import-shopping` response. A batch the take-over created is deleted; a batch it topped up is reduced by exactly the amount it added, and a best-before date the take-over set is cleared again. '
          + 'The amount is subtracted, not written back, so a change someone made to the batch in the meantime stays. Batches that are gone are skipped; `removed` and `reduced` report what actually went back. '
          + 'A `merged` entry without `quantity_added` is skipped.',
        tag: 'Pantry',
        stateChanging: true,
        requestBody: body({
          type: 'object',
          required: ['changes'],
          properties: {
            changes: {
              type: 'array',
              items: {
                type: 'object',
                required: ['pantry_item_id', 'kind'],
                properties: {
                  pantry_item_id: { type: 'integer' },
                  kind: { type: 'string', enum: ['added', 'merged'] },
                  quantity_added: { type: 'number' },
                  expires_set: { type: 'boolean' },
                },
              },
            },
          },
        }),
      })),
    },
    '/api/v1/pantry/products/{productId}': {
      delete: op({
        summary: 'Delete pantry product without batches',
        description: 'Deletes a household product whose last batch is gone (`batch_count` 0 in `GET /api/v1/pantry`). '
          + 'A product that still has batches is refused with 409 and `reason` `pantry_product_has_batches`; its batches are never deleted along with it.',
        tag: 'Pantry',
        params: [idParam('productId', 'Product ID, plain decimal digits.')],
        stateChanging: true,
        responses: {
          204: { description: 'Product deleted' },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { description: 'Product not found' },
          409: { description: 'The product still has batches. The response body reason is `pantry_product_has_batches`, `count` the number of batches.' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/pantry/{itemId}': {
      put: withValidationRefusal(op({
        summary: 'Replace pantry item',
        description: `${MIN_QUANTITY_MIRROR} A full replace: only \`name\` is required; \`quantity\` left out is 1, \`location_id\`, \`expires_on\` and \`notes\` left out are cleared, \`unit\` and \`category\` left out stay. The body is checked against the schema before the item is looked up.`,
        tag: 'Pantry',
        params: [idParam('itemId', 'Item ID, plain decimal digits.')],
        stateChanging: true,
        requestBody: body({ type: 'object', required: ['name'], properties: itemProperties({ keepUnit: true, partial: false }) }),
      })),
      patch: withValidationRefusal(op({
        summary: 'Partially update pantry item',
        description: `${MIN_QUANTITY_MIRROR} Only the fields sent change; \`{}\` changes nothing, a missing body is refused. \`location_id\`, \`expires_on\` and \`notes\` sent as \`null\` clear, \`unit\` and \`category\` sent as \`null\` keep the stored value.`,
        tag: 'Pantry',
        params: [idParam('itemId', 'Item ID, plain decimal digits.')],
        stateChanging: true,
        requestBody: body({ type: 'object', properties: itemProperties({ keepUnit: true, partial: true }) }),
      })),
      delete: op({
        summary: 'Delete pantry item',
        tag: 'Pantry',
        params: [idParam('itemId', 'Item ID, plain decimal digits.')],
        stateChanging: true,
        responses: answers(204, 'Pantry item deleted', { 404: apiError('No such pantry item') }),
      }),
    },
  };
}

/**
 * Taking an amount from a pantry item and its undo (#1891).
 */
function takePaths() {
  return {
    '/api/v1/pantry/{itemId}/take': {
      post: op({
        summary: 'Take an amount from a pantry item',
        description: 'Body: `{ amount }`, how much was taken, in the unit of the item (#1891). An `Idempotency-Key` header makes a repeated request answer with the first take instead of taking again (the app sends one per dialog). '
          + 'The server subtracts it from the quantity stored at that moment, so two takes from the same item both count, whatever quantity each sender last saw. '
          + 'More than the item holds sets it to 0 instead of being refused; `taken` in the answer says how much was really taken (then less than `amount`). '
          + 'The amount is rounded to two decimals like every quantity; 0, a negative amount and one that is not a number answer 400 with `fields` (`reason` `validation`). '
          + 'An item taken to 0 loses its best-before reminder, as with a partial update to 0. '
          + '`PATCH /api/v1/pantry/{itemId}` with `quantity` still sets the quantity as a whole. `POST /api/v1/pantry/{itemId}/take/undo` puts a take back.',
        tag: 'Pantry',
        params: [idParam('itemId', 'Item ID, plain decimal digits.')],
        stateChanging: true,
        requestBody: body(TAKE_BODY('How much was taken, in the unit of the item. Rounded to two decimals.')),
        responses: answers(200, 'Amount taken', {
          200: {
            description: 'Amount taken: the item afterwards and the amount really taken',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['data', 'taken'],
                  properties: {
                    data: { type: 'object', description: 'The pantry item after the take, as in `GET /api/v1/pantry`.' },
                    taken: { type: 'number', description: 'How much was taken: `amount`, or what the item held when that was less.' },
                  },
                },
              },
            },
          },
          404: apiError('No such pantry item'),
        }),
      }),
    },
    '/api/v1/pantry/{itemId}/take/undo': {
      post: op({
        summary: 'Undo a take from a pantry item',
        description: 'Body: `{ amount }`. Adds the given amount to the item, whatever it is: meant for the `taken` of one `POST /api/v1/pantry/{itemId}/take` answer, '
          + 'but it checks no take, so it needs the same pantry write access as `PATCH` with `quantity` and nothing more. '
          + 'The amount is added to the quantity stored at that moment (at most 1,000,000), not written back as the old quantity, so a change someone made in between stays. '
          + 'An item that comes back from 0 gets its best-before reminder again. The answer is `{ data }`, the item afterwards.',
        tag: 'Pantry',
        params: [idParam('itemId', 'Item ID, plain decimal digits.')],
        stateChanging: true,
        requestBody: body(TAKE_BODY('The amount to put back: the `taken` of the take.')),
        responses: answers(200, 'Take undone', {
          200: {
            description: 'Take undone: the item afterwards',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['data'],
                  properties: {
                    data: { type: 'object', description: 'The pantry item after the amount was put back, as in `GET /api/v1/pantry`.' },
                  },
                },
              },
            },
          },
          404: apiError('No such pantry item'),
        }),
      }),
    },
  };
}

// #1909: was der Lagerort-Verwalter erreicht.
const LOCATION_EXISTS = '`pantry_location_exists` (409, a storage location with this name already exists)';
const LOCATION_GONE = '`pantry_location_not_found` (404, the storage location does not exist - deleted)';
const CASE_REASONS = {
  '/api/v1/pantry/locations': { post: LOCATION_EXISTS },
  '/api/v1/pantry/locations/{locId}': {
    put: `${LOCATION_GONE}, ${LOCATION_EXISTS}`,
    delete: `${LOCATION_GONE}, \`pantry_location_last\` (400, the last storage location cannot be deleted)`,
  },
};
