import { op, jsonBody, idParam, stringPathParam } from '../helpers.js';

export function inventoryPaths() {
  return {
    '/api/v1/inventory/locations': {
      get: op({ summary: 'List inventory locations (two-level tree)', tag: 'Inventory' }),
      post: op({ summary: 'Create a top-level inventory location', tag: 'Inventory', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/inventory/locations/reorder': {
      patch: op({ summary: 'Reorder top-level inventory locations', tag: 'Inventory', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/inventory/locations/{id}': {
      put: op({ summary: 'Update an inventory location', tag: 'Inventory', params: [idParam('id', 'Location ID')], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({
        summary: 'Delete an inventory location',
        description: 'Never blocked. Items and child locations become location-less/parent-less instead of moving.',
        tag: 'Inventory',
        params: [idParam('id', 'Location ID')],
        stateChanging: true,
      }),
    },
    '/api/v1/inventory/locations/{parentId}/subcategories': {
      post: op({ summary: 'Create a child inventory location', tag: 'Inventory', params: [idParam('parentId', 'Parent location ID')], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/inventory/locations/{parentId}/subcategories/reorder': {
      patch: op({ summary: 'Reorder child inventory locations', tag: 'Inventory', params: [idParam('parentId', 'Parent location ID')], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/inventory/locations/{parentId}/subcategories/{id}': {
      put: op({ summary: 'Update a child inventory location', tag: 'Inventory', params: [idParam('parentId', 'Parent location ID'), idParam('id', 'Location ID')], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete a child inventory location', tag: 'Inventory', params: [idParam('parentId', 'Parent location ID'), idParam('id', 'Location ID')], stateChanging: true }),
    },
    '/api/v1/inventory/categories': {
      get: op({ summary: 'List inventory categories', tag: 'Inventory' }),
      post: op({ summary: 'Create an inventory category', tag: 'Inventory', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/inventory/categories/reorder': {
      patch: op({ summary: 'Reorder inventory categories', tag: 'Inventory', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/inventory/categories/{key}': {
      put: op({ summary: 'Update an inventory category', tag: 'Inventory', params: [stringPathParam('key', 'Category key')], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({
        summary: 'Delete an inventory category',
        description: "Never blocked, except the protected 'other' category. Affected items are reassigned to 'other'.",
        tag: 'Inventory',
        params: [stringPathParam('key', 'Category key')],
        stateChanging: true,
      }),
    },
    '/api/v1/inventory/items': {
      get: op({ summary: 'List inventory items', description: 'Filters: category, location_id, status, q.', tag: 'Inventory' }),
      post: op({ summary: 'Create an inventory item (optional `attachment_document_ids`: documents from the documents module; optional `entry_id`: prefills purchase_price from that booking if it has no existing links; optional `tracked_dates`: array of custom {label, date, reminder_offset_days, interval_months, interval_distance} entries, where `interval_months` recurs the date on completion and `interval_distance` is a distance hint only, never a reminder; optional `odometer`/`odometer_unit`/`odometer_on` for a manual reading, silently cleared unless `category` has `tracks_odometer` set)', tag: 'Inventory', stateChanging: true, documentDeleteConflict: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/inventory/items/{id}': {
      get: op({ summary: 'Get an inventory item', tag: 'Inventory', params: [idParam('id', 'Item ID')] }),
      put: op({ summary: 'Replace an inventory item (`attachment_document_ids` replaces the document links, omit to leave untouched; `tracked_dates` replaces the whole set of custom tracked dates, omit to leave untouched; `odometer`/`odometer_unit`/`odometer_on` are a full replace like every other field - omitting them clears the reading, as does switching to a `category` without `tracks_odometer` set)', tag: 'Inventory', params: [idParam('id', 'Item ID')], stateChanging: true, documentDeleteConflict: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete an inventory item', tag: 'Inventory', params: [idParam('id', 'Item ID')], stateChanging: true }),
    },
    '/api/v1/inventory/items/{id}/entries': {
      post: op({
        summary: "Link a budget entry to an inventory item (role defaults to 'purchase')",
        tag: 'Inventory',
        params: [idParam('id', 'Item ID')],
        stateChanging: true,
        requestBody: jsonBody(null),
      }),
    },
    '/api/v1/inventory/items/{id}/entries/{entryId}': {
      delete: op({
        summary: 'Unlink a budget entry from an inventory item (removes all roles for this pair)',
        tag: 'Inventory',
        params: [idParam('id', 'Item ID'), idParam('entryId', 'Budget entry ID')],
        stateChanging: true,
      }),
    },
    '/api/v1/inventory/items/{id}/dates/{dateId}/complete': {
      post: op({
        summary: 'Mark a tracked date as done',
        description: "Writes a service-log entry (label/date snapshot, optional odometer/vendor/note). If the date carries `interval_months`, it rolls forward by that many months (same id, so its reminder and ICS UID stay stable) and its reminder re-syncs; otherwise the date and its reminder are removed and the completion lives on only in the service log.",
        tag: 'Inventory',
        params: [idParam('id', 'Item ID'), idParam('dateId', 'Tracked date ID')],
        stateChanging: true,
        requestBody: jsonBody(null),
      }),
    },
    '/api/v1/inventory/items/{id}/service-log': {
      get: op({ summary: 'List an item\'s service-log entries', tag: 'Inventory', params: [idParam('id', 'Item ID')] }),
      post: op({
        summary: 'Add a service-log entry (e.g. an unscheduled repair, not tied to a tracked date)',
        description: 'An odometer reading on the entry advances `inventory_items.odometer`/`odometer_on` only when it is the newest reading - a backdated entry never rewinds the current mileage.',
        tag: 'Inventory',
        params: [idParam('id', 'Item ID')],
        stateChanging: true,
        requestBody: jsonBody(null),
      }),
    },
    '/api/v1/inventory/items/{id}/service-log/{logId}': {
      put: op({ summary: 'Replace a service-log entry', description: 'Full replace, not a partial update: label and performed_on are required, and any omitted optional field (odometer/vendor/note) is cleared.', tag: 'Inventory', params: [idParam('id', 'Item ID'), idParam('logId', 'Service-log entry ID')], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete a service-log entry', tag: 'Inventory', params: [idParam('id', 'Item ID'), idParam('logId', 'Service-log entry ID')], stateChanging: true }),
    },
    '/api/v1/inventory/items/{id}/history': {
      get: op({
        summary: "Get an item's service history",
        description: 'Read-only aggregation of service-log entries, linked budget entries (maintenance/accessory roles) and linked documents into one dated timeline, with a cost total - no separate store. Budget-entry and document visibility follow their existing rules (personal/shared budget mode, document sharing) with no admin bypass.',
        tag: 'Inventory',
        params: [idParam('id', 'Item ID')],
      }),
    },
    '/api/v1/inventory/entries/{entryId}/items': {
      get: op({
        summary: 'List inventory items linked to a budget entry',
        tag: 'Inventory',
        params: [idParam('entryId', 'Budget entry ID')],
      }),
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
