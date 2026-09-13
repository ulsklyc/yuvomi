import { op, jsonBody, idParam } from '../helpers.js';

export function shoppingPaths() {
  return {
    '/api/v1/shopping': {
      get: op({ summary: 'List shopping lists', tag: 'Shopping' }),
      post: op({ summary: 'Create shopping list', tag: 'Shopping', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/shopping/categories': {
      get: op({ summary: 'List shopping categories', tag: 'Shopping' }),
      post: op({ summary: 'Create shopping category', tag: 'Shopping', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/shopping/stores': {
      get: op({ summary: 'List the shops a price can be recorded against', tag: 'Shopping', description: 'A managed list rather than free text on the item: a household visits few enough shops that maintaining them is cheap, and free text is messy from the first week ("REWE", "Rewe", "rewe City" would be three).' }),
      post: op({ summary: 'Add a shop', tag: 'Shopping', stateChanging: true, requestBody: jsonBody(null), description: 'Body: { name }. Adding a shop that already exists returns the existing row with 200 rather than a conflict - that is not a mistake, it is already there.' }),
    },
    '/api/v1/shopping/stores/{id}': {
      put: op({ summary: 'Rename a shop', tag: 'Shopping', params: [idParam()], stateChanging: true, requestBody: jsonBody(null), description: 'Body: { name }. Renaming rather than re-creating, so a typo does not split the purchase history away from the shop it belongs to. 409 when another shop already carries that name.' }),
      delete: op({ summary: 'Remove a shop', tag: 'Shopping', params: [idParam()], stateChanging: true, description: 'Prices recorded against it keep their value and lose only the shop reference: what was once paid stays true even when the shop leaves the list.' }),
    },
    '/api/v1/shopping/categories/{catId}': {
      put: op({ summary: 'Update shopping category', tag: 'Shopping', params: [idParam('catId', 'Category ID')], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete shopping category', tag: 'Shopping', params: [idParam('catId', 'Category ID')], stateChanging: true }),
    },
    '/api/v1/shopping/categories/reorder': {
      patch: op({ summary: 'Reorder shopping categories', tag: 'Shopping', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/shopping/suggestions': { get: op({ summary: 'Get shopping suggestions', tag: 'Shopping' }) },
    '/api/v1/shopping/versions': {
      get: op({
        summary: 'Change counter of every shopping list',
        description: 'One `{ list_id, version }` per list. The counter says *that* a list changed, never *what*: '
          + 'it moves whenever the list was renamed or its items were inserted, updated, moved or deleted by anyone '
          + '- a household member, a meal-plan import, the CalDAV sync - and the row disappears with the list. '
          + 'Database triggers keep it, so no writer has to announce itself. A client polls this while a list is '
          + 'open and reloads a list through the same items request it used to open it; the write routes on items '
          + 'return `list_change: { list_id, before, after }` so the writer can tell its own change apart.',
        tag: 'Shopping',
      }),
    },
    '/api/v1/shopping/items/undo-transfer': {
      post: op({
        summary: 'Undo a kitchen transfer to a shopping list',
        description: 'Removes the items created by one transfer (the `added_ids` of the response) and clears the `on_shopping_list` flag on the meal ingredients they came from. Unknown ids are skipped; `removed` reports what actually went back.',
        tag: 'Shopping',
        stateChanging: true,
        requestBody: jsonBody(null),
      }),
    },
    '/api/v1/shopping/items/{itemId}': {
      patch: op({ summary: 'Update shopping item', tag: 'Shopping', params: [idParam('itemId', 'Item ID')], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete shopping item', tag: 'Shopping', params: [idParam('itemId', 'Item ID')], stateChanging: true }),
    },
    '/api/v1/shopping/{listId}': {
      put: op({ summary: 'Rename shopping list', tag: 'Shopping', params: [idParam('listId', 'List ID')], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete shopping list', tag: 'Shopping', params: [idParam('listId', 'List ID')], stateChanging: true }),
    },
    '/api/v1/shopping/{listId}/items': {
      get: op({ summary: 'List items in shopping list', tag: 'Shopping', params: [idParam('listId', 'List ID')] }),
      post: op({ summary: 'Add item to shopping list', tag: 'Shopping', params: [idParam('listId', 'List ID')], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/shopping/{listId}/import-pantry': {
      post: op({
        summary: 'Add pantry items to a shopping list',
        description: 'Adds low or empty pantry items to the list. Names already on the list unchecked are skipped instead of duplicated.',
        tag: 'Shopping',
        params: [idParam('listId', 'List ID')],
        stateChanging: true,
        requestBody: jsonBody(null),
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
        params: [idParam('listId', 'List ID')],
        stateChanging: true,
        requestBody: jsonBody(null),
      }),
    },
    '/api/v1/shopping/{listId}/items/checked': {
      delete: op({ summary: 'Delete checked shopping items', tag: 'Shopping', params: [idParam('listId', 'List ID')], stateChanging: true }),
    },
    '/api/v1/shopping/{listId}/items/reorder': {
      patch: op({ summary: 'Reorder the items of one category', tag: 'Shopping', stateChanging: true, params: [idParam('listId', 'Shopping list ID')], requestBody: jsonBody(null), description: 'Per category rather than across the whole list: the category order is already its own handle and models the route through the shop; a second, list-wide rank beside it would make two statements about the same order. The request must name EVERY item of the category - a subset would let the ranks of the omitted ones collide with the newly assigned ones, and creation time would decide again.' }),
    },
    '/api/v1/shopping/{listId}/import-meal-plan': {
      post: op({ summary: 'Import ingredients from the meal plan into a list', tag: 'Shopping', stateChanging: true, params: [idParam('listId', 'Shopping list ID')], requestBody: jsonBody(null), description: 'Body: { from, to, preview? }. With `preview: true` nothing is written - it only counts, for the "X ingredients from Y meals" line in the import dialog.' }),
    },
  };
}
