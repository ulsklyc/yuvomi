import { op, jsonBody, idParam, withCaseReasons } from '../helpers.js';
import { DATE_PATTERN } from '../../utils/datetime-pattern.js';
import { HANDOVER_LIMIT_NOTE, MAX_ORDER_ROWS, MAX_SHOPPING_ITEMS } from '../array-limits.js';

const schema = (name) => ({ 'application/json': { schema: { $ref: `#/components/schemas/${name}` } } });
const apiError = (description) => ({ description, content: schema('ApiError') });
const BAD_REQUEST = { $ref: '#/components/responses/BadRequest' };
const LIST_NOT_FOUND = apiError('The list does not exist.');
const ITEM_NOT_FOUND = apiError('The item does not exist.');
const CATEGORY_NOT_FOUND = apiError('The category does not exist.');
const STORE_NOT_FOUND = apiError('The shop does not exist.');

// ---------------------------------------------------------------------------
// Bausteine der Anfrage-Schemata (#2810, Gruppe 8). Das Schema traegt Typ und
// Gestalt; Laengen und Leere bleiben im Handler, weil er nach dem Trimmen
// zaehlt. Unbekannte Felder bleiben ignoriert (kein `additionalProperties:
// false`).
// ---------------------------------------------------------------------------

/**
 * A JSON body. `{}` sent on purpose counts as sent; a call without a body is 400.
 * @param {Record<string, unknown>} properties
 * @param {string[]} [required]
 */
const body = (properties, required = []) => ({
  required: true,
  description: 'JSON request body. Fields the schema does not name are ignored.',
  content: { 'application/json': { schema: { type: 'object', properties, ...(required.length ? { required } : {}) } } },
});

const NAME = { type: 'string', description: 'Trimmed before it is stored; empty after trimming or too long is the route\'s 400.' };
const NAME_BODY = body({ name: NAME }, ['name']);
/** A row id in a request body: a positive integer. */
const ROW_ID = { type: 'integer', minimum: 1 };
/** A day key `YYYY-MM-DD`; whether the day exists is the route's check. */
const DAY = { type: 'string', pattern: DATE_PATTERN };

/**
 * The answers of an operation outside the client contract, with the 400 of
 * validateRequest() (#2810).
 * @param {Record<string, unknown>} own
 */
const answers = (own) => ({
  ...own,
  400: BAD_REQUEST,
  401: { $ref: '#/components/responses/Unauthorized' },
  500: { $ref: '#/components/responses/InternalServerError' },
});

const listId = () => idParam('listId', 'List ID, plain decimal digits.');
const itemId = () => idParam('itemId', 'Item ID, plain decimal digits.');
const catId = () => idParam('catId', 'Category ID, plain decimal digits.');
const storeId = () => idParam('id', 'Shop ID, plain decimal digits; `0` is the route\'s 400 `Invalid store ID.`.');

/** Die Antworten einer Operation des Client-Vertrags: Erfolg mit Schema, dazu die Absagen. */
function typed(status, name, refusals = {}) {
  return {
    [status]: { description: status === 201 ? 'Created' : 'Successful response', content: schema(name) },
    ...refusals,
    401: { $ref: '#/components/responses/Unauthorized' },
    403: { $ref: '#/components/responses/Forbidden' },
    500: { $ref: '#/components/responses/InternalServerError' },
  };
}

export function shoppingPaths() {
  return withCaseReasons('shopping', CASE_REASONS, {
    '/api/v1/shopping': {
      get: op({ summary: 'List shopping lists', operationId: 'listShoppingLists', tag: 'Shopping', responses: typed(200, 'ShoppingListsResponse'), description: 'Each list carries `item_total`, `item_checked` and `accepts_new_items` (1 or 0). `accepts_new_items` is 0 when the list mirrors a CalDAV reminder list that is read-only for its account: such a list is not offered as the target of a move, and moving an item there is refused.' }),
      post: op({ summary: 'Create shopping list', operationId: 'createShoppingList', tag: 'Shopping', stateChanging: true, requestBody: jsonBody('#/components/schemas/ShoppingListCreateInput'), responses: typed(201, 'ShoppingListResponse', { 400: BAD_REQUEST }) }),
    },
    '/api/v1/shopping/categories': {
      get: op({ summary: 'List shopping categories', operationId: 'listShoppingCategories', tag: 'Shopping', description: 'In shop order, the order of `sort_order`.', responses: typed(200, 'ShoppingCategoriesResponse') }),
      post: op({
        summary: 'Create shopping category', tag: 'Shopping', stateChanging: true, requestBody: NAME_BODY,
        description: 'Body: { name }. A name that is already taken is refused with 409 and `reason: "category_exists"`.',
        responses: answers({ 201: { description: 'Created' }, 409: apiError('A category with this name exists.') }),
      }),
    },
    '/api/v1/shopping/stores': {
      get: op({ summary: 'List the shops a price can be recorded against', tag: 'Shopping', description: 'A managed list rather than free text on the item: a household visits few enough shops that maintaining them is cheap, and free text is messy from the first week ("REWE", "Rewe", "rewe City" would be three).' }),
      post: op({
        summary: 'Add a shop', tag: 'Shopping', stateChanging: true, requestBody: NAME_BODY,
        description: 'Body: { name }. Adding a shop that already exists returns the existing row with 200 rather than a conflict - that is not a mistake, it is already there.',
        responses: answers({ 200: { description: 'The shop already existed' }, 201: { description: 'Created' } }),
      }),
    },
    '/api/v1/shopping/stores/{id}': {
      put: op({
        summary: 'Rename a shop', tag: 'Shopping', params: [storeId()], stateChanging: true, requestBody: NAME_BODY,
        description: 'Body: { name }. Renaming rather than re-creating, so a typo does not split the purchase history away from the shop it belongs to. 409 with `reason: "shopping_store_exists"` when another shop already carries that name, 404 with `reason: "shopping_store_not_found"` when the shop is gone.',
        responses: answers({ 200: { description: 'Successful response' }, 404: STORE_NOT_FOUND, 409: apiError('Another shop carries this name.') }),
      }),
      delete: op({
        summary: 'Remove a shop', tag: 'Shopping', params: [storeId()], stateChanging: true,
        description: 'Prices recorded against it keep their value and lose only the shop reference: what was once paid stays true even when the shop leaves the list. 404 with `reason: "shopping_store_not_found"` when the shop is already gone.',
        responses: answers({ 204: { description: 'Removed' }, 404: STORE_NOT_FOUND }),
      }),
    },
    '/api/v1/shopping/categories/{catId}': {
      put: op({
        summary: 'Update shopping category', tag: 'Shopping', params: [catId()], stateChanging: true, requestBody: NAME_BODY,
        description: 'Body: { name }. 409 with `reason: "category_exists"` when another category carries that name, 404 with `reason: "shopping_category_not_found"` when the category is gone.',
        responses: answers({ 200: { description: 'Successful response' }, 404: CATEGORY_NOT_FOUND, 409: apiError('Another category carries this name.') }),
      }),
      delete: op({
        summary: 'Delete shopping category', tag: 'Shopping', params: [catId()], stateChanging: true,
        description: 'Items of the category move to the next one. The last category is kept: 400 with `reason: "category_last"`. 404 with `reason: "shopping_category_not_found"` when the category is already gone.',
        responses: answers({ 200: { description: 'Successful response' }, 404: CATEGORY_NOT_FOUND }),
      }),
    },
    '/api/v1/shopping/categories/reorder': {
      patch: op({
        summary: 'Reorder shopping categories', tag: 'Shopping', stateChanging: true,
        description: 'Body: { order } - the category ids in their new shop order. An id that does not exist changes nothing.',
        requestBody: body({
          order: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_ORDER_ROWS,
            items: { anyOf: [ROW_ID, { type: 'string', pattern: '^0*[1-9][0-9]*$' }] },
            description: 'Category ids: positive integers. A string of decimal digits is read as the same id (the older form the app sent until v2.93).',
          },
        }, ['order']),
        responses: answers({ 200: { description: 'All categories in their new order' } }),
      }),
    },
    '/api/v1/shopping/price-history': {
      get: op({
        summary: 'Get purchase price history for an item',
        description: 'Returns recorded purchase history facts (item_name, price_cents, store_name, purchased_at) matching item name case-insensitively, ordered by purchased_at DESC.',
        tag: 'Shopping',
        params: [
          {
            name: 'name',
            in: 'query',
            required: true,
            description: 'Item name to look up purchases for (matched case-insensitively). Empty or only spaces: an empty list.',
            schema: { type: 'string' },
          },
          {
            name: 'limit',
            in: 'query',
            required: false,
            description: 'Maximum number of recorded purchases to return (1-50, defaults to 10). Outside that range, or not a whole number, is a 400.',
            schema: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
          },
          {
            name: 'exclude_item_id',
            in: 'query',
            required: false,
            description: 'Optional shopping item ID to exclude its current purchase from results. A value that is not a positive integer (plain decimal digits without a leading zero) is a 400.',
            schema: { type: 'integer', minimum: 1 },
          },
        ],
        responses: answers({ 200: { description: 'Successful response' } }),
      }),
    },
    '/api/v1/shopping/suggestions': {
      get: op({
        summary: 'Get shopping suggestions',
        operationId: 'listShoppingSuggestions',
        description: 'Contract change (#1103): response items are now objects { name, category, quantity } instead of '
          + 'plain name strings (string[] before), and the list is ordered by most recently used first instead of alphabetically. '
          + 'Category and quantity come from the most recent item row with that name - the latest statement about '
          + 'how the household files the article today.',
        tag: 'Shopping',
        params: [{
          name: 'q',
          in: 'query',
          required: false,
          description: 'The start of the name, without regard to case for ASCII letters. At most 8 names come back. Without it, or with nothing but spaces, the list is empty.',
          schema: { type: 'string' },
        }],
        responses: typed(200, 'ShoppingSuggestionsResponse', { 400: BAD_REQUEST }),
      }),
    },
    '/api/v1/shopping/versions': {
      get: op({
        summary: 'Change counter of every shopping list',
        operationId: 'listShoppingListVersions',
        description: 'One `{ list_id, version }` per list. The counter says *that* a list changed, never *what*: '
          + 'it moves whenever the list was renamed or its items were inserted, updated, moved or deleted by anyone '
          + '- a household member, a meal-plan import, the CalDAV sync - and the row disappears with the list. '
          + 'Database triggers keep it, so no writer has to announce itself. A client polls this while a list is '
          + 'open and reloads a list through the same items request it used to open it; the write routes on items '
          + 'return `list_change: { list_id, before, after }` so the writer can tell its own change apart.',
        tag: 'Shopping',
        responses: typed(200, 'ShoppingListVersionsResponse'),
      }),
    },
    '/api/v1/shopping/items/undo-transfer': {
      post: op({
        summary: 'Undo a kitchen transfer to a shopping list',
        description: 'Removes the items created by one transfer (the `added_ids` of the response) and clears the `on_shopping_list` flag on the meal ingredients they came from - exactly the `ingredient_ids` of the response when they are sent, including ingredients the transfer skipped because an open item of the same name was already on the list. Unknown ids are skipped; `removed` reports what actually went back. Clearing that flag writes meal-plan data, so as soon as one of the named items came from a meal, write access to the `meals` module is required as well and a credential without it is refused with 403. A transfer from the pantry or from a recipe carries no meal, and taking it back needs `shopping` alone.',
        tag: 'Shopping',
        stateChanging: true,
        requestBody: body({
          ids: { type: 'array', maxItems: MAX_SHOPPING_ITEMS, items: ROW_ID, description: 'The `added_ids` of the transfer. Without it, or empty, nothing is removed.' },
          ingredient_ids: { type: 'array', maxItems: MAX_SHOPPING_ITEMS, items: ROW_ID, description: 'The `ingredient_ids` of the transfer.' },
        }),
        responses: answers({ 200: { description: 'Successful response' }, 403: { $ref: '#/components/responses/Forbidden' } }),
      }),
    },
    '/api/v1/shopping/items/{itemId}': {
      patch: op({
        summary: 'Update shopping item',
        operationId: 'updateShoppingItem',
        description: 'Body: { is_checked?, name?, quantity?, category?, notes?, url?, price_cents?, store_id?, list_id? } - '
          + 'a field that is not sent stays as it is. `list_id` moves the item to another list: it keeps its name, quantity, '
          + 'category, note, link, price and shop, and goes to the end of its category on the list it lands on. `list_id` and '
          + '`store_id` are positive integers, as a number or a string of digits; anything else and an unknown '
          + '`list_id` are refused with 400 and nothing changes, as is a move to a list with `accepts_new_items: 0`. If the item is mirrored from a CalDAV list and the target '
          + 'list is mirrored too, its object on the server moves along after the response, unchanged and under the same UID; '
          + 'if the target list is not mirrored, the object is removed on the server and its mirrored tags are dropped. '
          + '`list_change` in the response names the list the item came from. A case a household member can run into carries a '
          + 'machine-readable `reason` next to `error`: `shopping_item_not_found` (404, the item is gone), '
          + '`shopping_list_not_found` (400, unknown `list_id`), `shopping_store_not_found` (400, unknown `store_id`), '
          + '`shopping_category_not_found` (400, unknown `category`). Every shopping route that works on a list answers a '
          + 'missing list with 404 and `reason: "shopping_list_not_found"`. Validation errors carry no `reason`.',
        tag: 'Shopping',
        params: [itemId()],
        stateChanging: true,
        requestBody: jsonBody('#/components/schemas/ShoppingItemUpdateInput'),
        responses: typed(200, 'ShoppingItemResponse', { 400: BAD_REQUEST, 404: ITEM_NOT_FOUND }),
      }),
      delete: op({ summary: 'Delete shopping item', operationId: 'deleteShoppingItem', tag: 'Shopping', params: [itemId()], stateChanging: true, responses: typed(200, 'ShoppingItemDeleteResponse', { 400: BAD_REQUEST, 404: ITEM_NOT_FOUND }) }),
    },
    '/api/v1/shopping/{listId}': {
      put: op({ summary: 'Rename shopping list', tag: 'Shopping', params: [listId()], stateChanging: true, requestBody: NAME_BODY, responses: answers({ 200: { description: 'Successful response' }, 404: LIST_NOT_FOUND }) }),
      delete: op({ summary: 'Delete shopping list', tag: 'Shopping', params: [listId()], stateChanging: true, responses: answers({ 200: { description: 'Successful response' }, 404: LIST_NOT_FOUND }) }),
    },
    '/api/v1/shopping/{listId}/duplicate': {
      post: op({
        summary: 'Duplicate a shopping list',
        description: 'Body: { name, resetChecked?, keepQuantities?, keepNotes? } - the three flags default to true. '
          + 'Category assignment and manual per-category order are always carried over, since preserving them is '
          + 'the point of duplicating. CalDAV sync fields, the meal-plan origin, the recorded price and the shop '
          + 'are never copied: each is a fact about the ORIGINAL item (a synced remote object, a specific meal, a '
          + 'price actually paid in a specific shop) that is not true of a fresh copy.',
        tag: 'Shopping',
        params: [listId()],
        stateChanging: true,
        requestBody: body({
          name: NAME,
          resetChecked: { type: 'boolean' },
          keepQuantities: { type: 'boolean' },
          keepNotes: { type: 'boolean' },
        }, ['name']),
        responses: answers({ 201: { description: 'Created' }, 404: LIST_NOT_FOUND }),
      }),
    },
    '/api/v1/shopping/{listId}/items': {
      get: op({
        summary: 'List items in shopping list',
        operationId: 'listShoppingItems',
        description: 'Returns the items with the list, the categories and `version`, the list\'s change counter read in the same '
          + 'synchronous step as the items, so a client that polls `/shopping/versions` knows exactly which state it holds.',
        tag: 'Shopping',
        params: [listId()],
        responses: typed(200, 'ShoppingItemsResponse', { 400: BAD_REQUEST, 404: LIST_NOT_FOUND }),
      }),
      post: op({ summary: 'Add item to shopping list', operationId: 'createShoppingItem', tag: 'Shopping', params: [listId()], stateChanging: true, requestBody: jsonBody('#/components/schemas/ShoppingItemCreateInput'), responses: typed(201, 'ShoppingItemResponse', { 400: BAD_REQUEST, 404: LIST_NOT_FOUND }) }),
    },
    '/api/v1/shopping/{listId}/import-pantry': {
      post: op({
        summary: 'Add pantry items to a shopping list',
        description: 'Adds low or empty pantry items to the list. ' + 'An open (unchecked) item of the same name on the list - compared trimmed, with whitespace collapsed and case-insensitive - means the ingredient is skipped and counted in `skipped` instead of being added twice; rows of one name in one transfer become one item. This is the one rule of every kitchen path to the shopping list (recipe, meal, meal-plan import, pantry). '
          + 'An entry is `{ pantry_item_id, quantity? }` for a batch, or `{ pantry_product_id, quantity? }` for a household product, which goes over with its name and category; `quantity` is display text, such as the shortfall to the minimum of the product. '
          + 'Reads the pantry, so it requires read access to the `pantry` module in addition to `shopping` - a credential without it is refused with 403.',
        tag: 'Shopping',
        params: [listId()],
        stateChanging: true,
        requestBody: body({
          items: {
            type: 'array',
            maxItems: MAX_SHOPPING_ITEMS,
            description: 'The entries to add; an empty list adds nothing. An entry whose batch or product does not exist counts in `skipped`.',
            items: {
              type: 'object',
              properties: {
                pantry_item_id: ROW_ID,
                pantry_product_id: ROW_ID,
                quantity: { type: ['string', 'null'], description: 'Display text, such as the shortfall to the minimum of the product.' },
              },
              anyOf: [
                { properties: { pantry_item_id: ROW_ID }, required: ['pantry_item_id'] },
                { properties: { pantry_product_id: ROW_ID }, required: ['pantry_product_id'] },
              ],
            },
          },
        }, ['items']),
        responses: answers({ 200: { description: 'Successful response' }, 403: { $ref: '#/components/responses/Forbidden' }, 404: LIST_NOT_FOUND }),
      }),
    },
    '/api/v1/shopping/send-recipients': {
      get: op({
        summary: 'Household members who can receive a shopping list by email',
        description: 'Names only, no addresses - the picker needs a name, and what is not handed out cannot be shown by accident. '
          + 'Deliberately not `/family/members`: that lists every account except housekeeping staff, so it includes '
          + 'shared-expense guests, who are external. This endpoint and the send route ask the same function, so the '
          + 'picker cannot offer a recipient the server rejects, nor hide one it accepts.',
        tag: 'Shopping',
      }),
    },
    '/api/v1/shopping/{listId}/send': {
      post: op({
        summary: 'Email the open items of a list to a household member',
        description: 'Sends the list as it stands to one household member. The recipient is a `userId`; '
          + 'the server resolves the address from that member\'s contact, the same source the password reset uses. '
          + 'An address in the request body is ignored - accepting one would make the instance an open mail relay '
          + 'for any signed-in user. Only unchecked items are included, grouped by category in shop order. '
          + 'Requires SMTP to be configured. Rate limited to 10 requests per minute per IP, separately from the '
          + 'general API limit. Fails with 422 when the member has no address, SMTP is unset, or nothing is open.',
        tag: 'Shopping',
        params: [listId()],
        stateChanging: true,
        requestBody: body({
          userId: { type: 'integer', minimum: 1, description: 'The household member to send the list to.' },
        }, ['userId']),
        responses: answers({
          200: { description: 'Successful response' },
          404: apiError('The list or the recipient does not exist.'),
          422: apiError('The member has no address, SMTP is unset, or nothing is open.'),
          429: { description: 'More than 10 requests per minute from this IP.' },
          502: apiError('The email could not be sent.'),
        }),
      }),
    },
    '/api/v1/shopping/{listId}/items/checked': {
      delete: op({
        summary: 'Delete checked shopping items',
        operationId: 'deleteCheckedShoppingItems',
        description: 'Without a body, every item that is checked when the request arrives. With `{ ids }`, only those '
          + 'ids, and of them only the ones that are checked and belong to this list - a client that removed rows '
          + 'optimistically names exactly what it removed, so a row someone else ticked in the meantime stays. '
          + '`deleted` reports what actually went.',
        tag: 'Shopping',
        params: [listId()],
        stateChanging: true,
        requestBody: { ...jsonBody('#/components/schemas/ShoppingCheckedDeleteInput', 'Optional: `{ ids: number[] }`'), required: false },
        responses: typed(200, 'ShoppingCheckedDeleteResponse', { 400: BAD_REQUEST, 404: LIST_NOT_FOUND }),
      }),
    },
    '/api/v1/shopping/{listId}/items/reorder': {
      patch: op({
        summary: 'Reorder the items of one category', tag: 'Shopping', stateChanging: true, params: [listId()],
        requestBody: body({
          category: { type: 'string', description: 'The name of an existing category.' },
          order: { type: 'array', minItems: 1, maxItems: MAX_SHOPPING_ITEMS, items: ROW_ID, description: 'Every item id of the category, in the new order.' },
        }, ['order']),
        responses: answers({ 200: { description: 'Successful response' }, 404: LIST_NOT_FOUND }),
        description: 'Per category rather than across the whole list: the category order is already its own handle and models the route through the shop; a second, list-wide rank beside it would make two statements about the same order. The request must name EVERY item of the category - a subset would let the ranks of the omitted ones collide with the newly assigned ones, and creation time would decide again.' }),
    },
    '/api/v1/shopping/{listId}/import-meal-plan': {
      post: op({
        summary: 'Import ingredients from the meal plan into a list',
        tag: 'Shopping',
        stateChanging: true,
        params: [listId()],
        requestBody: body({
          from: DAY,
          to: DAY,
          preview: { type: 'boolean', description: 'With `true` nothing is written. Up to v2.93 the text `"true"` ran the real import; it is a 400 now.' },
        }, ['from', 'to']),
        description: 'An open (unchecked) item of the same name on the list - compared trimmed, with whitespace collapsed and case-insensitive - means the ingredient is skipped and counted in `skipped` instead of being added twice; rows of one name in one transfer become one item. This is the one rule of every kitchen path to the shopping list (recipe, meal, meal-plan import, pantry). Meals planned from a recipe are included. ' + 'Body: { from, to, preview? }. With `preview: true` nothing is written - it only counts (`added` new items, `skipped` already on the list), for the "X ingredients from Y meals" line in the import dialog; meals planned from a recipe are read from it there instead of being copied. The import answers `added_ids` and `ingredient_ids` for POST /api/v1/shopping/items/undo-transfer. Marks the imported ingredients as transferred, which is meal-plan data, so it requires write access to the `meals` module in addition to `shopping` - a credential scoped to the shopping list alone is refused with 403, for the preview as well.' + HANDOVER_LIMIT_NOTE,
        responses: answers({ 200: { description: 'Successful response' }, 403: { $ref: '#/components/responses/Forbidden' }, 404: LIST_NOT_FOUND }),
      }),
    },
  });
}

// #2267: die Gruende, die die Routen neben `error` senden.
const LIST_GONE = '`shopping_list_not_found` (404, the list does not exist - deleted)';
const MEALS_WRITE_REQUIRED = '`cross_module_access` (403, the caller has no write access to the meal plan - for API tokens a `meals:write` scope)';
const PANTRY_READ_REQUIRED = '`cross_module_access` (403, the caller has no read access to the pantry - for API tokens a `pantry:read` scope)';
const CASE_REASONS = {
  '/api/v1/shopping/{listId}': { put: LIST_GONE, delete: LIST_GONE },
  '/api/v1/shopping/{listId}/duplicate': { post: LIST_GONE },
  '/api/v1/shopping/{listId}/items': { get: LIST_GONE, post: LIST_GONE },
  '/api/v1/shopping/{listId}/items/checked': { delete: LIST_GONE },
  '/api/v1/shopping/{listId}/items/reorder': { patch: LIST_GONE },
  '/api/v1/shopping/{listId}/import-meal-plan': { post: `${LIST_GONE}, ${MEALS_WRITE_REQUIRED}` },
  '/api/v1/shopping/{listId}/import-pantry': { post: `${LIST_GONE}, ${PANTRY_READ_REQUIRED}` },
  '/api/v1/shopping/{listId}/send': {
    post: `${LIST_GONE}, \`nothing_open\` (422, the list has no open item to send), `
      + '`recipient_no_email` (422, the chosen member has no email address on their contact), '
      + '`smtp_unconfigured` (422, email is not set up for this instance)',
  },
  '/api/v1/shopping/items/{itemId}': { delete: '`shopping_item_not_found` (404, the item does not exist - deleted)' },
  '/api/v1/shopping/items/undo-transfer': { post: `${MEALS_WRITE_REQUIRED}, when the undo touches meal ingredients` },
};
