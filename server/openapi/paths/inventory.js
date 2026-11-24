import {
  op, idParam, stringPathParam, DOCUMENT_LINKS_READ_NOTE, BUDGET_LINKS_READ_NOTE, withCaseReasons, withValidationRefusal,
} from '../helpers.js';
import { MAX_SHORT, MAX_TEXT, MAX_TITLE } from '../../api/formats.ts';
import { DATE_PATTERN, OPTIONAL_DATE_PATTERN } from '../../utils/datetime-pattern.js';
import {
  CONDITIONS, STATUSES, ODOMETER_UNITS, ROLES, MAX_PHOTO_LENGTH, MAX_TRACKED_DATES_PER_ITEM, MAX_LABEL,
} from '../../routes/inventory/fields.js';

// R23 (D5): Kaufpreise folgen einem eigenen Recht.
const PRICES_NOTE = 'Without the `inventory_view_prices` capability (new child accounts start without it) `purchase_price` and `currency` '
  + 'are missing from every item in the response, and a write keeps the stored price: a create stores none, a replace leaves it as it is. '
  + 'Linked bookings follow the Budget rights as before.';

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

/** @param {string} name @param {string} what */
const pathId = (name, what) => idParam(name, `${what}, plain decimal digits.`);

// Ziffern-Text ist eine Altform (#2810): Service Worker aelterer App-Staende
// schicken Lagerort-IDs als Text. Die App schickt heute Zahlen.
const DIGIT_TEXT = { type: 'string', pattern: '^[0-9]+$' };
const LEGACY_NOTE = 'Digit text is accepted as a legacy form (older app versions send it).';

/**
 * A text field the route trims. The length counts the text as sent; the
 * route keeps its own check after trimming. `nullable`: `null` and `""`
 * mean none.
 * @param {number} max
 * @param {boolean} nullable
 * @param {string} [description]
 */
const text = (max, nullable, description = '') => ({
  type: nullable ? ['string', 'null'] : 'string',
  maxLength: max,
  description: `${description ? `${description} ` : ''}At most ${max} characters as sent${nullable ? '; `null` or `""` means none' : '; empty after trimming spaces is refused'}.`,
});

/**
 * A value of a fixed list, or `null`/`""` for its default. `false` and `0`
 * are not read as the default any more (#2810).
 * @param {string[]} values
 * @param {string} fallback
 */
const listed = (values, fallback) => ({
  type: ['string', 'null'],
  enum: [...values, '', null],
  description: `One of ${values.map((v) => `\`${v}\``).join(', ')}; \`null\`, \`""\` or left out is \`${fallback}\`.`,
});

const LOCATION_BODY = body({
  type: 'object',
  required: ['name'],
  properties: {
    name: text(MAX_SHORT, false),
    icon: {
      type: ['string', 'null'],
      maxLength: MAX_SHORT,
      description: `A Lucide icon name, at most ${MAX_SHORT} characters as sent; \`null\`, \`""\` or left out keeps the stored one (on create: \`package\`).`,
    },
  },
});

/**
 * The order of locations: ids as whole numbers, digit text as the legacy form.
 * @param {number} minItems
 */
const locationOrder = (minItems) => ({
  type: 'array',
  ...(minItems ? { minItems } : {}),
  items: { anyOf: [{ type: 'integer' }, DIGIT_TEXT] },
  description: `Location ids in the wanted order, as whole numbers. ${LEGACY_NOTE} Ids that do not exist (or are not at this level) are skipped.`,
});

const TRACKED_DATE = {
  type: 'object',
  required: ['label', 'date'],
  properties: {
    label: text(MAX_LABEL, false),
    date: { type: 'string', pattern: DATE_PATTERN, description: 'The day `YYYY-MM-DD`; a day that does not exist is refused.' },
    reminder_offset_days: { type: ['integer', 'null'], minimum: 0, maximum: 365, description: 'Days before the date for the reminder, 0 to 365; `null` or left out is 30.' },
    interval_months: { type: ['integer', 'null'], minimum: 1, maximum: 600, description: 'Rolls the date forward by this many months on completion, 1 to 600; `null` or left out: once.' },
    interval_distance: { type: ['integer', 'null'], minimum: 1, description: 'A distance hint (never a reminder), a positive whole number; `null` or left out: none.' },
  },
};

/**
 * The fields of an item (#2810), the same for create and replace (a replace
 * is a full replace). The types hold for every category; whether a reading
 * is kept depends on the category (`tracks_odometer`), and its bounds stay
 * the route's. `purchase_price` has no bound here: without the price right
 * the route ignores it.
 * @param {{ create: boolean }} options
 */
function itemProperties({ create }) {
  return {
    name: text(MAX_TITLE, false),
    brand: text(MAX_SHORT, true),
    model: text(MAX_SHORT, true),
    serial_number: text(MAX_SHORT, true),
    vendor: text(MAX_SHORT, true),
    account_username: text(MAX_SHORT, true, 'The account the item is registered under (an address or user name, never a password).'),
    notes: text(MAX_TEXT, true),
    category: { type: ['string', 'null'], description: 'A category key (`GET /api/v1/inventory/categories`); `null`, `""` or left out is `other`. An unknown key is refused.' },
    location_id: {
      anyOf: [{ type: 'integer' }, DIGIT_TEXT, { type: 'null' }],
      description: `The location, a whole number; \`null\` or left out means none. ${LEGACY_NOTE} A location that does not exist is refused with \`inventory_selected_location_not_found\`.`,
    },
    purchase_date: { type: ['string', 'null'], pattern: OPTIONAL_DATE_PATTERN, description: 'The day `YYYY-MM-DD`; a day that does not exist is refused. `""` or `null` means none.' },
    purchase_price: { type: ['number', 'null'], description: 'Not negative; `null` or left out means none. Ignored without the `inventory_view_prices` capability.' },
    currency: { type: ['string', 'null'], description: 'A three-letter ISO code, any case; `null`, `""` or left out is the household currency. Ignored without the `inventory_view_prices` capability.' },
    warranty_months: { type: ['integer', 'null'], minimum: 0, maximum: 600, description: 'Warranty in months, 0 to 600; `null` or left out means none.' },
    condition: listed(CONDITIONS, 'good'),
    status: listed(STATUSES, 'active'),
    photo_data: {
      type: ['string', 'null'],
      maxLength: MAX_PHOTO_LENGTH,
      description: `The item photo as a data URL (PNG, JPEG, WebP or GIF in base64), at most ${MAX_PHOTO_LENGTH} characters as sent; its content must match the declared type. \`null\`, \`""\` or left out means none.`,
    },
    odometer: { type: ['integer', 'null'], description: 'A manual odometer reading, a whole number of at least 0; `null` or left out means none. Cleared (and not checked further) unless `category` has `tracks_odometer` set.' },
    odometer_unit: {
      type: ['string', 'null'],
      enum: [...ODOMETER_UNITS, '', null],
      description: `${ODOMETER_UNITS.map((u) => `\`${u}\``).join(' or ')}; \`null\`, \`""\` or left out is \`km\` when a reading is given.`,
    },
    odometer_on: { type: ['string', 'null'], pattern: OPTIONAL_DATE_PATTERN, description: 'The day of the reading `YYYY-MM-DD`; `""`, `null` or left out with a reading is today in the household zone.' },
    tracked_dates: {
      type: 'array',
      maxItems: MAX_TRACKED_DATES_PER_ITEM,
      items: TRACKED_DATE,
      description: create
        ? `Custom tracked dates, at most ${MAX_TRACKED_DATES_PER_ITEM}. Left out: none. Not \`null\`.`
        : `Replaces the whole set of custom tracked dates, at most ${MAX_TRACKED_DATES_PER_ITEM}; \`[]\` removes them all. Left out: untouched. Not \`null\`.`,
    },
    attachment_document_ids: {
      type: 'array',
      items: { type: 'integer' },
      description: create
        ? 'Documents of the Documents module to link. Left out: none. Not `null`.'
        : 'Replaces the document links; `[]` removes them all. Left out: untouched. Not `null`.',
    },
    ...(create ? {
      entry_id: { type: ['integer', 'null'], description: 'A budget booking to link as the purchase; prefills `purchase_price` when it is left out and the booking has no other link. `null` or left out: none.' },
    } : {}),
  };
}

/**
 * The body of a service-log entry (`label` only with `withLabel`) and of a completion.
 * @param {{ withLabel: boolean }} options
 */
function serviceLogProperties({ withLabel }) {
  return {
    ...(withLabel ? { label: text(MAX_LABEL, false) } : {}),
    performed_on: { type: 'string', pattern: DATE_PATTERN, description: 'The day `YYYY-MM-DD`; a day that does not exist is refused.' },
    odometer: { type: ['integer', 'null'], minimum: 0, description: 'The odometer reading, a whole number of at least 0, not below the current reading; `null` or left out means none.' },
    vendor: text(MAX_SHORT, true),
    note: text(MAX_TEXT, true),
  };
}

const ITEM_BODY_NOTE = 'A body outside the schema (a text field that is not text, a number as text, a value outside its list, '
  + '`tracked_dates` or `attachment_document_ids` that is not a list) answers 400 with `fields` before anything is looked up.';
const NOT_OWNER_ORDER = 'Without the `inventory_edit_others` capability a valid request on an item you did not create is refused with 403 `not_owner`; '
  + 'a request outside the schema is a 400 first.';

/** The locations and the categories: the two managers of the inventory page. */
function placePaths() {
  return {
    '/api/v1/inventory/locations': {
      get: op({ summary: 'List inventory locations (two-level tree)', tag: 'Inventory' }),
      post: op({
        summary: 'Create a top-level inventory location',
        tag: 'Inventory',
        stateChanging: true,
        requestBody: LOCATION_BODY,
        responses: answers(201, 'Location created'),
      }),
    },
    '/api/v1/inventory/locations/reorder': {
      patch: withValidationRefusal(op({
        summary: 'Reorder top-level inventory locations',
        description: 'Body: `{ order }`, the top-level location ids in the wanted order, at least one.',
        tag: 'Inventory',
        stateChanging: true,
        requestBody: body({ type: 'object', required: ['order'], properties: { order: locationOrder(1) } }),
      })),
    },
    '/api/v1/inventory/locations/{id}': {
      put: withValidationRefusal(op({
        summary: 'Update an inventory location',
        description: 'Renames a location: `name` is required, `icon` optional (left out keeps the stored one). The body is checked against the schema before the location is looked up.',
        tag: 'Inventory',
        params: [pathId('id', 'Location ID')],
        stateChanging: true,
        requestBody: LOCATION_BODY,
      })),
      delete: op({
        summary: 'Delete an inventory location',
        description: 'Never blocked. Items and child locations become location-less/parent-less instead of moving. The answer is `{ ok: true, orphanedItems, orphanedChildren }` - not wrapped in `data`.',
        tag: 'Inventory',
        params: [pathId('id', 'Location ID')],
        stateChanging: true,
        responses: answers(200, 'Location deleted', {
          200: {
            description: 'Location deleted',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['ok', 'orphanedItems', 'orphanedChildren'],
                  properties: {
                    ok: { type: 'boolean' },
                    orphanedItems: { type: 'integer', description: 'How many items lost their location.' },
                    orphanedChildren: { type: 'integer', description: 'How many child locations lost their parent.' },
                  },
                },
              },
            },
          },
        }),
      }),
    },
    '/api/v1/inventory/locations/{parentId}/subcategories': {
      post: op({
        summary: 'Create a child inventory location',
        tag: 'Inventory',
        params: [pathId('parentId', 'Parent location ID')],
        stateChanging: true,
        requestBody: LOCATION_BODY,
        responses: answers(201, 'Child location created'),
      }),
    },
    '/api/v1/inventory/locations/{parentId}/subcategories/reorder': {
      patch: withValidationRefusal(op({
        summary: 'Reorder child inventory locations',
        description: 'Body: `{ order }`, the child location ids of this parent in the wanted order; `[]` changes nothing.',
        tag: 'Inventory',
        params: [pathId('parentId', 'Parent location ID')],
        stateChanging: true,
        requestBody: body({ type: 'object', required: ['order'], properties: { order: locationOrder(0) } }),
      })),
    },
    '/api/v1/inventory/locations/{parentId}/subcategories/{id}': {
      put: withValidationRefusal(op({
        summary: 'Update a child inventory location',
        description: 'Renames a child location: `name` is required, `icon` optional (left out keeps the stored one).',
        tag: 'Inventory',
        params: [pathId('parentId', 'Parent location ID'), pathId('id', 'Location ID')],
        stateChanging: true,
        requestBody: LOCATION_BODY,
      })),
      delete: withValidationRefusal(op({
        summary: 'Delete a child inventory location',
        description: 'Items become location-less. The answer is `{ ok: true, orphanedItems }` - not wrapped in `data`.',
        tag: 'Inventory',
        params: [pathId('parentId', 'Parent location ID'), pathId('id', 'Location ID')],
        stateChanging: true,
      })),
    },
    '/api/v1/inventory/categories': {
      get: op({ summary: 'List inventory categories', tag: 'Inventory' }),
      post: op({
        summary: 'Create an inventory category',
        tag: 'Inventory',
        stateChanging: true,
        requestBody: LOCATION_BODY,
        responses: answers(201, 'Category created'),
      }),
    },
    '/api/v1/inventory/categories/reorder': {
      patch: withValidationRefusal(op({
        summary: 'Reorder inventory categories',
        description: 'Body: `{ order }`, the category keys in the wanted order, at least one. An unknown key refuses the whole order.',
        tag: 'Inventory',
        stateChanging: true,
        requestBody: body({
          type: 'object',
          required: ['order'],
          properties: { order: { type: 'array', minItems: 1, items: { type: 'string' }, description: 'Category keys.' } },
        }),
      })),
    },
    '/api/v1/inventory/categories/{key}': {
      put: withValidationRefusal(op({
        summary: 'Update an inventory category',
        description: 'Renames a category: `name` is required, `icon` optional (left out keeps the stored one). A renamed seed category is no longer translated.',
        tag: 'Inventory',
        params: [stringPathParam('key', 'Category key')],
        stateChanging: true,
        requestBody: LOCATION_BODY,
      })),
      delete: withValidationRefusal(op({
        summary: 'Delete an inventory category',
        description: "Never blocked, except the protected 'other' category (400). Affected items are reassigned to 'other'. The answer is `{ ok: true, reassigned }` - not wrapped in `data`.",
        tag: 'Inventory',
        params: [stringPathParam('key', 'Category key')],
        stateChanging: true,
      })),
    },
  };
}

/** The items with their bookings, dates and service log, and the deadlines feed. */
function itemPaths() {
  return {
    '/api/v1/inventory/items': {
      get: withValidationRefusal(op({
        summary: 'List inventory items',
        description: `Each item carries \`attachments\` and \`linked_entries\`. A filter given twice is refused. ${DOCUMENT_LINKS_READ_NOTE} ${BUDGET_LINKS_READ_NOTE} ${PRICES_NOTE}`,
        tag: 'Inventory',
        params: [
          { name: 'category', in: 'query', required: false, description: 'Only items of this category key; empty means all.', schema: { type: 'string' } },
          { name: 'location_id', in: 'query', required: false, description: 'Only items at this location (not its child locations), plain decimal digits; 0 or below is refused.', schema: { type: 'integer' } },
          { name: 'status', in: 'query', required: false, description: 'Only items with this status.', schema: { type: 'string', enum: [...STATUSES] } },
          { name: 'q', in: 'query', required: false, description: 'Search text over name, brand, model, serial number and account; trimmed, and only its first 100 characters are searched.', schema: { type: 'string' } },
        ],
      })),
      post: op({
        summary: 'Create an inventory item (optional `attachment_document_ids`: documents from the documents module; optional `entry_id`: prefills purchase_price from that booking if it has no existing links; optional `tracked_dates`: array of custom {label, date, reminder_offset_days, interval_months, interval_distance} entries, where `interval_months` recurs the date on completion and `interval_distance` is a distance hint only, never a reminder; optional `odometer`/`odometer_unit`/`odometer_on` for a manual reading, silently cleared unless `category` has `tracks_odometer` set)',
        tag: 'Inventory',
        description: `${DOCUMENT_LINKS_READ_NOTE} ${BUDGET_LINKS_READ_NOTE} This includes \`entry_id\`. ${ITEM_BODY_NOTE}`,
        stateChanging: true,
        documentDeleteConflict: true,
        documentLinkRefusal: true,
        requestBody: body({ type: 'object', required: ['name'], properties: itemProperties({ create: true }) }),
        responses: answers(201, 'Item created'),
      }),
    },
    '/api/v1/inventory/items/{id}': {
      get: withValidationRefusal(op({ summary: 'Get an inventory item', description: `The item carries \`attachments\` and \`linked_entries\`. ${DOCUMENT_LINKS_READ_NOTE} ${BUDGET_LINKS_READ_NOTE} ${PRICES_NOTE}`, tag: 'Inventory', params: [pathId('id', 'Item ID')] })),
      put: withValidationRefusal(op({
        summary: 'Replace an inventory item (`attachment_document_ids` replaces the document links, omit to leave untouched; `tracked_dates` replaces the whole set of custom tracked dates, omit to leave untouched; `odometer`/`odometer_unit`/`odometer_on` are a full replace like every other field - omitting them clears the reading, as does switching to a `category` without `tracks_odometer` set)',
        tag: 'Inventory',
        params: [pathId('id', 'Item ID')],
        description: `A full replace: only \`name\` is required; every other field left out is cleared or takes its default (\`category\` \`other\`, \`condition\` \`good\`, \`status\` \`active\`), except \`tracked_dates\` and \`attachment_document_ids\`, which stay untouched when left out. ${ITEM_BODY_NOTE} ${NOT_OWNER_ORDER} ${DOCUMENT_LINKS_READ_NOTE} ${BUDGET_LINKS_READ_NOTE} ${PRICES_NOTE}`,
        stateChanging: true,
        documentDeleteConflict: true,
        documentLinkRefusal: true,
        requestBody: body({ type: 'object', required: ['name'], properties: itemProperties({ create: false }) }),
      })),
      delete: op({
        summary: 'Delete an inventory item',
        description: NOT_OWNER_ORDER,
        tag: 'Inventory',
        params: [pathId('id', 'Item ID')],
        stateChanging: true,
        responses: answers(204, 'Item deleted'),
      }),
    },
    '/api/v1/inventory/items/{id}/entries': {
      post: op({
        summary: "Link a budget entry to an inventory item (role defaults to 'purchase')",
        description: `${BUDGET_LINKS_READ_NOTE} ${NOT_OWNER_ORDER}`,
        tag: 'Inventory',
        params: [pathId('id', 'Item ID')],
        stateChanging: true,
        requestBody: body({
          type: 'object',
          required: ['entry_id'],
          properties: {
            entry_id: { type: 'integer', description: 'The budget booking to link.' },
            role: listed(ROLES, 'purchase'),
            amount_share: { type: ['number', 'null'], minimum: 0, description: 'The part of the booking that belongs to this item, not negative; `null` or left out: none.' },
          },
        }),
        responses: answers(201, 'Booking linked; the answer is the updated item'),
      }),
    },
    '/api/v1/inventory/items/{id}/entries/{entryId}': {
      delete: withValidationRefusal(op({
        summary: 'Unlink a budget entry from an inventory item (removes all roles for this pair)',
        description: `${BUDGET_LINKS_READ_NOTE} ${NOT_OWNER_ORDER}`,
        tag: 'Inventory',
        params: [pathId('id', 'Item ID'), pathId('entryId', 'Budget entry ID')],
        stateChanging: true,
      })),
    },
    '/api/v1/inventory/items/{id}/dates/{dateId}/complete': {
      post: op({
        summary: 'Mark a tracked date as done',
        description: `Writes a service-log entry (label/date snapshot, optional odometer/vendor/note). If the date carries \`interval_months\`, it rolls forward by that many months (same id, so its reminder and ICS UID stay stable) and its reminder re-syncs; otherwise the date and its reminder are removed and the completion lives on only in the service log. Answers with the updated item. ${BUDGET_LINKS_READ_NOTE} ${NOT_OWNER_ORDER}`,
        tag: 'Inventory',
        params: [pathId('id', 'Item ID'), pathId('dateId', 'Tracked date ID')],
        stateChanging: true,
        requestBody: body({ type: 'object', required: ['performed_on'], properties: serviceLogProperties({ withLabel: false }) }),
        responses: answers(201, 'Done; the answer is the updated item'),
      }),
    },
    '/api/v1/inventory/items/{id}/service-log': {
      get: withValidationRefusal(op({ summary: 'List an item\'s service-log entries', tag: 'Inventory', params: [pathId('id', 'Item ID')] })),
      post: op({
        summary: 'Add a service-log entry (e.g. an unscheduled repair, not tied to a tracked date)',
        description: `An odometer reading on the entry advances \`inventory_items.odometer\`/\`odometer_on\` only when it is the newest reading - a backdated entry never rewinds the current mileage. ${NOT_OWNER_ORDER}`,
        tag: 'Inventory',
        params: [pathId('id', 'Item ID')],
        stateChanging: true,
        requestBody: body({ type: 'object', required: ['label', 'performed_on'], properties: serviceLogProperties({ withLabel: true }) }),
        responses: answers(201, 'Service-log entry created'),
      }),
    },
    '/api/v1/inventory/items/{id}/service-log/{logId}': {
      put: withValidationRefusal(op({
        summary: 'Replace a service-log entry',
        description: `Full replace, not a partial update: label and performed_on are required, and any omitted optional field (odometer/vendor/note) is cleared. If this entry currently supplies \`inventory_items.odometer\`/\`odometer_on\`, they are recomputed from whatever remains after the write - the cached reading can move down or clear to \`null\` here, not just advance. ${NOT_OWNER_ORDER}`,
        tag: 'Inventory',
        params: [pathId('id', 'Item ID'), pathId('logId', 'Service-log entry ID')],
        stateChanging: true,
        requestBody: body({ type: 'object', required: ['label', 'performed_on'], properties: serviceLogProperties({ withLabel: true }) }),
      })),
      delete: op({
        summary: 'Delete a service-log entry',
        description: `If this entry currently supplies \`inventory_items.odometer\`/\`odometer_on\`, they are recomputed from whatever remains - deleting the source entry can move the cached reading down or clear it to \`null\`, not just leave it standing. ${NOT_OWNER_ORDER}`,
        tag: 'Inventory',
        params: [pathId('id', 'Item ID'), pathId('logId', 'Service-log entry ID')],
        stateChanging: true,
        responses: answers(204, 'Service-log entry deleted'),
      }),
    },
    '/api/v1/inventory/items/{id}/history': {
      get: withValidationRefusal(op({
        summary: "Get an item's service history",
        description: 'Read-only aggregation of service-log entries, linked budget entries (maintenance/accessory roles) and linked documents into one dated timeline, with a cost total - no separate store. Budget-entry and document visibility follow their existing rules (personal/shared budget mode, document sharing) with no admin bypass. Without access to the Documents module (for API tokens a `documents:read` scope) linked documents are left out of the timeline, and without access to the Budget module (for API tokens a `budget:read` scope) linked budget entries are left out as well and the total is 0.',
        tag: 'Inventory',
        params: [pathId('id', 'Item ID')],
      })),
    },
    '/api/v1/inventory/entries/{entryId}/items': {
      get: withValidationRefusal(op({
        summary: 'List inventory items linked to a budget entry',
        description: 'Needs read access to the Budget module (for API tokens a `budget:read` scope); without it the entry answers 404 like an unknown one.',
        tag: 'Inventory',
        params: [pathId('entryId', 'Budget entry ID')],
      })),
    },
    '/api/v1/inventory/deadlines-feed': {
      get: op({ summary: 'Get own inventory deadlines ICS feed status', tag: 'Inventory' }),
      delete: op({ summary: 'Disable own inventory deadlines ICS feed', tag: 'Inventory', stateChanging: true }),
    },
    '/api/v1/inventory/deadlines-feed/regenerate': {
      post: op({ summary: 'Regenerate own inventory deadlines ICS feed token', tag: 'Inventory', stateChanging: true }),
    },
  };
}

export function inventoryPaths() {
  return withCaseReasons('inventory', CASE_REASONS, { ...placePaths(), ...itemPaths() });
}

// #1909: die Faelle, die ein Nutzer erreicht, tragen einen `reason` neben dem
// englischen `error` - je Operation der Satz, der sie nennt.
const ITEM_GONE = '`inventory_item_not_found` (404, the item does not exist - deleted)';
const BOOKING_GONE = '`inventory_booking_not_found` (404, the booking does not exist or is not visible to you)';
const LOCATION_GONE = '`inventory_selected_location_not_found` (400, the chosen `location_id` does not exist; only when it is the sole finding)';
const LOC_EXISTS = '`inventory_location_exists` (409, a location with this name already exists at this level)';
const LOC_GONE = '`inventory_location_not_found` (404, the location does not exist - deleted)';
const CAT_EXISTS = '`category_exists` (409, a category with this name already exists)';
const CAT_GONE = '`inventory_category_not_found` (404, the category does not exist - deleted)';
const NOT_OWNER = '`not_owner` (403, without the module\'s `*_edit_others` capability only items you created can be changed or deleted - R23)';
const CASE_REASONS = {
  '/api/v1/inventory/locations': { post: LOC_EXISTS },
  '/api/v1/inventory/locations/{id}': { put: `${LOC_GONE}, ${LOC_EXISTS}`, delete: LOC_GONE },
  '/api/v1/inventory/locations/{parentId}/subcategories': { post: `${LOC_GONE} (the parent location), ${LOC_EXISTS}` },
  '/api/v1/inventory/locations/{parentId}/subcategories/{id}': { put: `${LOC_GONE}, ${LOC_EXISTS}`, delete: LOC_GONE },
  '/api/v1/inventory/categories': { post: CAT_EXISTS },
  '/api/v1/inventory/categories/{key}': { put: `${CAT_GONE}, ${CAT_EXISTS}`, delete: CAT_GONE },
  '/api/v1/inventory/items': { post: `${LOCATION_GONE}, ${BOOKING_GONE}` },
  '/api/v1/inventory/items/{id}': { get: ITEM_GONE, put: `${ITEM_GONE}, ${LOCATION_GONE}, ${NOT_OWNER}`, delete: `${ITEM_GONE}, ${NOT_OWNER}` },
  '/api/v1/inventory/items/{id}/entries': {
    post: `${ITEM_GONE}, ${BOOKING_GONE}, \`inventory_booking_already_linked\` (409, the booking is already linked with this role), ${NOT_OWNER}`,
  },
  '/api/v1/inventory/items/{id}/entries/{entryId}': { delete: `${ITEM_GONE}, ${BOOKING_GONE}, ${NOT_OWNER}` },
  '/api/v1/inventory/items/{id}/dates/{dateId}/complete': {
    post: `${ITEM_GONE}, \`inventory_tracked_date_not_found\` (404, the item no longer has this tracked date), ${NOT_OWNER}`,
  },
  '/api/v1/inventory/items/{id}/history': { get: ITEM_GONE },
  '/api/v1/inventory/items/{id}/service-log': { get: ITEM_GONE, post: `${ITEM_GONE}, ${NOT_OWNER}` },
  '/api/v1/inventory/items/{id}/service-log/{logId}': { put: `${ITEM_GONE}, ${NOT_OWNER}`, delete: `${ITEM_GONE}, ${NOT_OWNER}` },
};
