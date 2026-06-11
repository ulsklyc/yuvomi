function authSecurity() {
  return [{ bearerAuth: [] }, { apiKeyAuth: [] }, { cookieAuth: [] }];
}

function csrfHeaderParam() {
  return {
    name: 'X-CSRF-Token',
    in: 'header',
    required: false,
    description: 'Required for state-changing requests when using session/cookie authentication. Not required for API-token authentication.',
    schema: { type: 'string' },
  };
}

function jsonBody(schemaRef, description = 'JSON request body') {
  return {
    required: true,
    description,
    content: {
      'application/json': {
        schema: schemaRef ? { $ref: schemaRef } : { type: 'object', additionalProperties: true },
      },
    },
  };
}

function op({
  summary,
  tag,
  description,
  auth = true,
  admin = false,
  params = [],
  requestBody = null,
  responses = null,
  stateChanging = false,
}) {
  const operation = {
    tags: [tag],
    summary,
    responses: responses ?? {
      200: { description: 'Successful response' },
      401: { $ref: '#/components/responses/Unauthorized' },
      500: { $ref: '#/components/responses/InternalServerError' },
    },
  };

  if (description) operation.description = description;
  if (auth) operation.security = authSecurity();
  if (admin) {
    operation.description = `${operation.description ? `${operation.description}\n\n` : ''}Admin-only endpoint.`;
    operation.responses[403] = { $ref: '#/components/responses/Forbidden' };
  }
  if (params.length || stateChanging) {
    operation.parameters = [...params];
    if (stateChanging) operation.parameters.push(csrfHeaderParam());
  }
  if (requestBody) operation.requestBody = requestBody;
  return operation;
}

function idParam(name = 'id', description = 'Resource ID') {
  return {
    name,
    in: 'path',
    required: true,
    description,
    schema: { type: 'integer' },
  };
}

function langParam() {
  return {
    name: 'lang',
    in: 'query',
    required: false,
    description: 'Language code for localized labels. Supported values: ar, de, el, en, es, fr, hi, it, ja, pt, ru, sv, tr, uk, zh. Defaults to en.',
    schema: {
      type: 'string',
      default: 'en',
      enum: ['ar', 'de', 'el', 'en', 'es', 'fr', 'hi', 'it', 'ja', 'pt', 'ru', 'sv', 'tr', 'uk', 'zh'],
    },
  };
}

function buildPaths() {
  return {
    '/health': {
      get: op({
        summary: 'Health check',
        tag: 'System',
        auth: false,
        responses: {
          200: {
            description: 'Service health status',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/HealthResponse' } } },
          },
        },
      }),
    },
    '/api/v1/version': {
      get: op({
        summary: 'Get application version',
        tag: 'System',
        responses: {
          200: {
            description: 'Application version',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/VersionResponse' } } },
          },
        },
      }),
    },
    '/api/v1/openapi.json': {
      get: op({
        summary: 'Get OpenAPI specification',
        tag: 'System',
        admin: true,
        description: 'Use `?download=1` to receive the OpenAPI document as a downloadable file.',
      }),
    },
    '/openapi.json': {
      get: op({
        summary: 'Get OpenAPI specification',
        tag: 'System',
        admin: true,
        description: 'Alias for `/api/v1/openapi.json`. Use `?download=1` to download the JSON file.',
      }),
    },
    '/docs': {
      get: op({
        summary: 'API documentation',
        tag: 'System',
        admin: true,
        responses: { 200: { description: 'API documentation response' } },
      }),
    },
    '/api/v1/auth/login': {
      post: op({
        summary: 'Login with username and password',
        tag: 'Auth',
        auth: false,
        requestBody: jsonBody('#/components/schemas/LoginRequest'),
        responses: {
          200: {
            description: 'Authenticated user and CSRF token',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginResponse' } } },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
        },
      }),
    },
    '/api/v1/auth/logout': {
      post: op({ summary: 'Logout current session', tag: 'Auth', stateChanging: true }),
    },
    '/api/v1/auth/setup': {
      post: op({
        summary: 'Initial setup: create first admin',
        tag: 'Auth',
        auth: false,
        requestBody: jsonBody('#/components/schemas/SetupRequest'),
        responses: {
          201: { description: 'Admin user created' },
          403: { $ref: '#/components/responses/Forbidden' },
          409: { description: 'Username already taken' },
        },
      }),
    },
    '/api/v1/auth/me': {
      get: op({
        summary: 'Get current authenticated user',
        tag: 'Auth',
        responses: {
          200: {
            description: 'Current user',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/MeResponse' } } },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
        },
      }),
    },
    '/api/v1/auth/me/password': {
      patch: op({
        summary: 'Change current user password',
        tag: 'Auth',
        stateChanging: true,
        requestBody: jsonBody('#/components/schemas/PasswordChangeRequest'),
      }),
    },
    '/api/v1/auth/me/profile': {
      patch: op({
        summary: 'Update current user profile',
        tag: 'Auth',
        stateChanging: true,
        requestBody: jsonBody('#/components/schemas/ProfileUpdateRequest'),
      }),
    },
    '/api/v1/auth/users': {
      get: op({ summary: 'List users', tag: 'Auth', admin: true }),
      post: op({
        summary: 'Create user',
        tag: 'Auth',
        admin: true,
        stateChanging: true,
        requestBody: jsonBody('#/components/schemas/UserCreateRequest'),
        responses: {
          201: { description: 'User created' },
          400: { $ref: '#/components/responses/BadRequest' },
          403: { $ref: '#/components/responses/Forbidden' },
          409: { description: 'Username already taken' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/auth/users/{id}': {
      patch: op({
        summary: 'Update user',
        tag: 'Auth',
        admin: true,
        stateChanging: true,
        params: [idParam('id', 'User ID')],
        requestBody: jsonBody('#/components/schemas/UserUpdateRequest'),
      }),
      delete: op({
        summary: 'Delete user',
        tag: 'Auth',
        admin: true,
        stateChanging: true,
        params: [idParam('id', 'User ID')],
      }),
    },
    '/api/v1/auth/api-tokens': {
      get: op({ summary: 'List API tokens', tag: 'Auth', admin: true }),
      post: op({
        summary: 'Create API token',
        tag: 'Auth',
        admin: true,
        stateChanging: true,
        requestBody: jsonBody('#/components/schemas/ApiTokenCreateRequest'),
        responses: {
          201: {
            description: 'API token created. The plaintext token is returned only once.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiTokenCreateResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          403: { $ref: '#/components/responses/Forbidden' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/auth/api-tokens/{id}': {
      delete: op({
        summary: 'Revoke API token',
        tag: 'Auth',
        admin: true,
        stateChanging: true,
        params: [idParam('id', 'API token ID')],
      }),
    },
    '/api/v1/family/members': {
      get: op({
        summary: 'List family members',
        tag: 'Family',
        description: 'Read-only endpoint for family-member profiles. It does not expose usernames or system access roles and does not support create/update/delete operations.',
        responses: {
          200: {
            description: 'Family members',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/FamilyMembersResponse' } } },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/backup/status': {
      get: op({
        summary: 'Get backup status',
        tag: 'Backup',
        admin: true,
      }),
    },
    '/api/v1/backup/database': {
      get: op({
        summary: 'Download database backup',
        tag: 'Backup',
        admin: true,
        responses: {
          200: {
            description: 'Database backup file',
            content: {
              'application/octet-stream': {
                schema: { type: 'string', format: 'binary' },
              },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/backup/restore': {
      post: op({
        summary: 'Restore database backup',
        tag: 'Backup',
        admin: true,
        stateChanging: true,
        requestBody: {
          required: true,
          description: 'Raw database backup file.',
          content: {
            'application/octet-stream': {
              schema: { type: 'string', format: 'binary' },
            },
          },
        },
        responses: {
          200: { description: 'Database restored' },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/dashboard': { get: op({ summary: 'Get dashboard data', tag: 'Dashboard' }) },
    '/api/v1/tasks': {
      get: op({ summary: 'List tasks', tag: 'Tasks' }),
      post: op({ summary: 'Create task', tag: 'Tasks', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/tasks/meta/options': { get: op({ summary: 'Get task metadata', tag: 'Tasks' }) },
    '/api/v1/tasks/{id}': {
      get: op({ summary: 'Get task', tag: 'Tasks', params: [idParam()] }),
      put: op({ summary: 'Update task', tag: 'Tasks', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete task', tag: 'Tasks', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/tasks/{id}/status': {
      patch: op({ summary: 'Update task status', tag: 'Tasks', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/shopping': {
      get: op({ summary: 'List shopping lists', tag: 'Shopping' }),
      post: op({ summary: 'Create shopping list', tag: 'Shopping', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/shopping/categories': {
      get: op({ summary: 'List shopping categories', tag: 'Shopping' }),
      post: op({ summary: 'Create shopping category', tag: 'Shopping', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/shopping/categories/{catId}': {
      put: op({ summary: 'Update shopping category', tag: 'Shopping', params: [idParam('catId', 'Category ID')], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete shopping category', tag: 'Shopping', params: [idParam('catId', 'Category ID')], stateChanging: true }),
    },
    '/api/v1/shopping/categories/reorder': {
      patch: op({ summary: 'Reorder shopping categories', tag: 'Shopping', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/shopping/suggestions': { get: op({ summary: 'Get shopping suggestions', tag: 'Shopping' }) },
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
    '/api/v1/shopping/{listId}/items/checked': {
      delete: op({ summary: 'Delete checked shopping items', tag: 'Shopping', params: [idParam('listId', 'List ID')], stateChanging: true }),
    },
    '/api/v1/meals': {
      get: op({ summary: 'List meal plan entries', tag: 'Meals' }),
      post: op({ summary: 'Create meal plan entry', tag: 'Meals', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/meals/suggestions': { get: op({ summary: 'Get meal suggestions', tag: 'Meals' }) },
    '/api/v1/meals/{id}': {
      put: op({ summary: 'Update meal plan entry', tag: 'Meals', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete meal plan entry', tag: 'Meals', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/meals/{id}/ingredients': {
      post: op({ summary: 'Add meal ingredient', tag: 'Meals', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/meals/ingredients/{ingId}': {
      patch: op({ summary: 'Update meal ingredient', tag: 'Meals', params: [idParam('ingId', 'Ingredient ID')], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete meal ingredient', tag: 'Meals', params: [idParam('ingId', 'Ingredient ID')], stateChanging: true }),
    },
    '/api/v1/meals/{id}/to-shopping-list': {
      post: op({ summary: 'Transfer meal ingredients to shopping list', tag: 'Meals', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/meals/week-to-shopping-list': {
      post: op({ summary: 'Transfer weekly meal ingredients to shopping list', tag: 'Meals', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/recipes': {
      get: op({ summary: 'List recipes', tag: 'Recipes' }),
      post: op({ summary: 'Create recipe', tag: 'Recipes', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/recipes/{id}': {
      put: op({ summary: 'Update recipe', tag: 'Recipes', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete recipe', tag: 'Recipes', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/calendar': {
      get: op({
        summary: 'List calendar events',
        tag: 'Calendar',
        responses: {
          200: {
            description: 'Calendar events',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/CalendarEventsResponse' } } },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
      post: op({
        summary: 'Create calendar event',
        tag: 'Calendar',
        stateChanging: true,
        description: 'Supports optional document-storage attachments via `attachment_name`, `attachment_mime`, `attachment_size`, and `attachment_data` (base64 data URL). New attachments are linked through `attachment_document_id`; legacy events may still return `attachment_data`. Set `target_caldav_account_id` and `target_caldav_calendar_url` to push the event to a CalDAV calendar (omit or null for a local-only event).',
        requestBody: jsonBody(null),
        responses: {
          201: {
            description: 'Calendar event created',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/CalendarEventResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/calendar/upcoming': { get: op({ summary: 'List upcoming events', tag: 'Calendar' }) },
    '/api/v1/calendar/holidays': { get: op({ summary: 'List public & school holidays in a date range', tag: 'Calendar', description: 'Reads cached OpenHolidays entries that overlap `from`/`to` (both `YYYY-MM-DD`, required). Returns `{ data: [{ id, type (`public`|`school`), start_date, end_date, name, color }] }`. Empty when no holiday country is configured.' }) },
    '/api/v1/calendar/google/auth': { get: op({ summary: 'Start Google Calendar OAuth', tag: 'Calendar', admin: true }) },
    '/api/v1/calendar/google/callback': { get: op({ summary: 'Google Calendar OAuth callback', tag: 'Calendar', auth: false }) },
    '/api/v1/calendar/google/sync': { post: op({ summary: 'Run Google Calendar sync', tag: 'Calendar', admin: true, stateChanging: true }) },
    '/api/v1/calendar/google/status': { get: op({ summary: 'Get Google Calendar status', tag: 'Calendar' }) },
    '/api/v1/calendar/google/calendars': {
      get: op({ summary: 'List available Google calendars', tag: 'Calendar', admin: true }),
      patch: op({ summary: 'Enable/disable a Google calendar to sync', tag: 'Calendar', admin: true, stateChanging: true }),
    },
    '/api/v1/calendar/google/disconnect': { delete: op({ summary: 'Disconnect Google Calendar', tag: 'Calendar', admin: true, stateChanging: true }) },
    '/api/v1/calendar/google/readonly': { put: op({ summary: 'Set Google Calendar read-only mode', tag: 'Calendar', admin: true, stateChanging: true }) },
    '/api/v1/calendar/apple/status': { get: op({ summary: 'Get Apple Calendar status', tag: 'Calendar' }) },
    '/api/v1/calendar/apple/sync': { post: op({ summary: 'Run Apple Calendar sync', tag: 'Calendar', admin: true, stateChanging: true }) },
    '/api/v1/calendar/apple/connect': { post: op({ summary: 'Connect Apple Calendar', tag: 'Calendar', admin: true, stateChanging: true, requestBody: jsonBody(null) }) },
    '/api/v1/calendar/apple/disconnect': { delete: op({ summary: 'Disconnect Apple Calendar', tag: 'Calendar', admin: true, stateChanging: true }) },
    '/api/v1/calendar/subscriptions': {
      get: op({ summary: 'List ICS subscriptions', tag: 'Calendar' }),
      post: op({ summary: 'Create ICS subscription', tag: 'Calendar', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/calendar/subscriptions/{id}': {
      patch: op({ summary: 'Update ICS subscription', tag: 'Calendar', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete ICS subscription', tag: 'Calendar', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/calendar/subscriptions/{id}/sync': {
      post: op({ summary: 'Sync ICS subscription', tag: 'Calendar', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/calendar/{id}': {
      get: op({
        summary: 'Get calendar event',
        tag: 'Calendar',
        params: [idParam()],
        responses: {
          200: {
            description: 'Calendar event',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/CalendarEventResponse' } } },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { description: 'Calendar event not found' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
      put: op({
        summary: 'Update calendar event',
        tag: 'Calendar',
        params: [idParam()],
        stateChanging: true,
        description: 'Supports document-storage attachments. Omit attachment fields to preserve the current attachment, send new `attachment_data` to create and link a document, or set `remove_attachment` to true to unlink it without deleting the library document. Legacy events may still return `attachment_data`.',
        requestBody: jsonBody(null),
        responses: {
          200: {
            description: 'Calendar event updated',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/CalendarEventResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { description: 'Calendar event not found' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
      delete: op({ summary: 'Delete calendar event', tag: 'Calendar', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/calendar/{id}/reset': {
      post: op({ summary: 'Reset external calendar event to source state', tag: 'Calendar', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/notes': {
      get: op({ summary: 'List notes', tag: 'Notes' }),
      post: op({ summary: 'Create note', tag: 'Notes', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/notes/{id}': {
      put: op({ summary: 'Update note', tag: 'Notes', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete note', tag: 'Notes', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/notes/{id}/pin': {
      patch: op({ summary: 'Toggle note pin state', tag: 'Notes', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/contacts': {
      get: op({ summary: 'List contacts', tag: 'Contacts' }),
      post: op({ summary: 'Create contact with multi-value fields', tag: 'Contacts', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/contacts/meta': { get: op({ summary: 'Get contact metadata', tag: 'Contacts' }) },
    '/api/v1/contacts/cardav/accounts': {
      get: op({ summary: 'List CardDAV accounts', tag: 'Contacts' }),
      post: op({ summary: 'Add CardDAV account', tag: 'Contacts', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/contacts/cardav/accounts/{id}': {
      delete: op({ summary: 'Delete CardDAV account', tag: 'Contacts', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/contacts/cardav/accounts/{id}/test': {
      post: op({ summary: 'Test CardDAV connection', tag: 'Contacts', params: [idParam()] }),
    },
    '/api/v1/contacts/cardav/accounts/{id}/addressbooks': {
      get: op({ summary: 'List addressbooks for account', tag: 'Contacts', params: [idParam()] }),
    },
    '/api/v1/contacts/cardav/accounts/{id}/addressbooks/refresh': {
      post: op({ summary: 'Refresh addressbooks for account', tag: 'Contacts', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/contacts/cardav/addressbooks/{id}': {
      put: op({ summary: 'Toggle addressbook enabled state', tag: 'Contacts', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/contacts/cardav/accounts/{id}/sync': {
      post: op({ summary: 'Sync CardDAV account', tag: 'Contacts', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/contacts/{id}': {
      get: op({ summary: 'Get contact with multi-value fields', tag: 'Contacts', params: [idParam()] }),
      put: op({ summary: 'Update contact with multi-value fields', tag: 'Contacts', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete contact', tag: 'Contacts', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/contacts/{id}/vcard': { get: op({ summary: 'Download contact as vCard', tag: 'Contacts', params: [idParam()] }) },
    '/api/v1/birthdays': {
      get: op({ summary: 'List birthdays', tag: 'Birthdays' }),
      post: op({ summary: 'Create birthday', tag: 'Birthdays', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/birthdays/upcoming': {
      get: op({ summary: 'List upcoming birthdays', tag: 'Birthdays' }),
    },
    '/api/v1/birthdays/meta/options': {
      get: op({ summary: 'Get birthday upload options', tag: 'Birthdays' }),
    },
    '/api/v1/birthdays/{id}': {
      put: op({ summary: 'Update birthday', tag: 'Birthdays', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete birthday', tag: 'Birthdays', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/budget/summary': { get: op({ summary: 'Get budget summary', tag: 'Budget' }) },
    '/api/v1/budget/export': { get: op({ summary: 'Export budget entries as CSV', tag: 'Budget' }) },
    '/api/v1/budget/meta': { get: op({ summary: 'Get budget categories and subcategories', tag: 'Budget' }) },
    '/api/v1/budget/categories': {
      get: op({ summary: 'List budget categories', tag: 'Budget', params: [langParam()] }),
      post: op({ summary: 'Create budget category', tag: 'Budget', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/budget/categories/{categoryKey}/subcategories': {
      get: op({ summary: 'List subcategories for a budget category', tag: 'Budget', params: [{ name: 'categoryKey', in: 'path', required: true, schema: { type: 'string' } }, langParam()] }),
      post: op({ summary: 'Create budget subcategory', tag: 'Budget', params: [{ name: 'categoryKey', in: 'path', required: true, schema: { type: 'string' } }], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/budget': {
      get: op({ summary: 'List budget entries', tag: 'Budget' }),
      post: op({ summary: 'Create budget entry', tag: 'Budget', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/budget/{id}': {
      put: op({ summary: 'Update budget entry', tag: 'Budget', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete budget entry', tag: 'Budget', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/documents/meta/options': {
      get: op({
        summary: 'Get family document options',
        tag: 'Documents',
        description: 'Returns supported categories, visibility modes, statuses, legacy storage providers, the active upload backend, file size limit and MIME types.',
        responses: {
          200: {
            description: 'Document metadata options',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/DocumentOptionsResponse' } } },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/documents/storage/config': {
      get: op({
        summary: 'Get WebDAV document-storage configuration',
        tag: 'Documents',
        admin: true,
        description: 'Returns the effective hybrid configuration and status. Environment-controlled fields are reported individually. The WebDAV password is never returned.',
        responses: {
          200: {
            description: 'Effective document-storage status',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/DocumentStorageStatusResponse' } } },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
      put: op({
        summary: 'Update WebDAV document-storage configuration',
        tag: 'Documents',
        admin: true,
        stateChanging: true,
        description: 'Updates DB-backed fields that are not controlled by environment variables. When WebDAV documents exist, connection changes require `confirm_existing_access: true` and a successful read check against an existing object. Use `clear_password: true` to explicitly remove a stored password.',
        requestBody: jsonBody('#/components/schemas/DocumentStorageConfigRequest'),
        responses: {
          200: {
            description: 'Updated effective document-storage status',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/DocumentStorageStatusResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          409: { description: 'Protected configuration change rejected', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/documents/storage/test': {
      post: op({
        summary: 'Test WebDAV document storage',
        tag: 'Documents',
        admin: true,
        stateChanging: true,
        description: 'Tests the effective hybrid configuration with a temporary PUT/GET/DELETE roundtrip in the target folder without persisting supplied connection fields.',
        requestBody: jsonBody('#/components/schemas/DocumentStorageTestRequest'),
        responses: {
          200: {
            description: 'Connection roundtrip succeeded',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/DocumentStorageTestResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          502: { description: 'Connection roundtrip failed', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/documents': {
      get: op({
        summary: 'List family documents',
        tag: 'Documents',
        params: [
          {
            name: 'status',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['active', 'archived'], default: 'active' },
          },
          {
            name: 'category',
            in: 'query',
            required: false,
            schema: {
              type: 'string',
              enum: ['medical', 'school', 'identity', 'insurance', 'finance', 'home', 'vehicle', 'legal', 'travel', 'pets', 'warranty', 'taxes', 'work', 'other'],
            },
          },
        ],
        responses: {
          200: {
            description: 'Visible family documents',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/FamilyDocumentsResponse' } } },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
      post: op({
        summary: 'Upload family document',
        tag: 'Documents',
        stateChanging: true,
        description: 'Stores a document using the active upload backend (`local` or `webdav`) with family, restricted, or private visibility. File content is sent as a base64 data URL in `content_data`.',
        requestBody: jsonBody(null),
        responses: {
          201: {
            description: 'Document created',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/FamilyDocumentResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          502: { description: 'Document-storage operation failed', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/documents/{id}': {
      put: op({
        summary: 'Update family document metadata',
        tag: 'Documents',
        params: [idParam()],
        stateChanging: true,
        description: 'Updates name, description, category, status, visibility and allowed member IDs. Only the owner or an admin can update a document.',
        requestBody: jsonBody(null),
        responses: {
          200: {
            description: 'Document metadata updated',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/FamilyDocumentResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { description: 'Document not found' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
      delete: op({
        summary: 'Delete family document',
        tag: 'Documents',
        params: [idParam()],
        stateChanging: true,
        description: 'Deletes a document. Only the owner or an admin can delete it.',
        responses: {
          204: { description: 'Document deleted' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { description: 'Document not found' },
          502: { description: 'Remote document deletion failed; the database row remains', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/documents/{id}/archive': {
      patch: op({
        summary: 'Archive or restore family document',
        tag: 'Documents',
        params: [idParam()],
        stateChanging: true,
        description: 'Archives the document by default. Send `{ "archived": false }` to restore it to active status.',
        requestBody: jsonBody(null),
      }),
    },
    '/api/v1/documents/{id}/download': {
      get: op({
        summary: 'Download family document file',
        tag: 'Documents',
        params: [idParam()],
        responses: {
          200: {
            description: 'Document file bytes',
            content: {
              'application/octet-stream': {
                schema: { type: 'string', format: 'binary' },
              },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { description: 'Document not found' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/documents/dms/accounts': {
      get: op({
        summary: 'List DMS accounts',
        tag: 'Documents',
        admin: true,
        description: 'Returns configured DMS accounts without the api_token. Each item includes `has_token` to indicate whether a token is stored.',
        responses: {
          200: {
            description: 'DMS accounts',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/DmsAccountsResponse' } } },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
      post: op({
        summary: 'Create DMS account',
        tag: 'Documents',
        admin: true,
        stateChanging: true,
        requestBody: jsonBody('#/components/schemas/DmsAccountCreateRequest'),
        responses: {
          201: {
            description: 'DMS account created',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/DmsAccountResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          409: { description: 'An account with this base_url already exists' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/documents/dms/accounts/{id}': {
      delete: op({
        summary: 'Delete DMS account',
        tag: 'Documents',
        admin: true,
        stateChanging: true,
        params: [idParam('id', 'DMS account ID')],
        responses: {
          204: { description: 'DMS account deleted' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { description: 'DMS account not found' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/documents/dms/accounts/{id}/test': {
      post: op({
        summary: 'Test DMS account connection',
        tag: 'Documents',
        admin: true,
        stateChanging: true,
        params: [idParam('id', 'DMS account ID')],
        responses: {
          200: {
            description: 'Connection test result',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/DmsTestResponse' } } },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/documents/dms/search': {
      get: op({
        summary: 'Search documents in a DMS account',
        tag: 'Documents',
        admin: true,
        params: [
          {
            name: 'account_id',
            in: 'query',
            required: true,
            schema: { type: 'integer' },
            description: 'DMS account ID to search in',
          },
          {
            name: 'q',
            in: 'query',
            required: true,
            schema: { type: 'string' },
            description: 'Search query string',
          },
        ],
        responses: {
          200: {
            description: 'DMS search results',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/DmsSearchResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { description: 'DMS account not found' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/documents/dms/link': {
      post: op({
        summary: 'Link a DMS document to the family document library',
        tag: 'Documents',
        admin: true,
        stateChanging: true,
        description: 'Creates a family_documents entry with legacy storage_provider `external` and storage_backend `dms`, pointing to a document already stored in the DMS.',
        requestBody: jsonBody('#/components/schemas/DmsLinkRequest'),
        responses: {
          201: {
            description: 'Document linked',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/DmsLinkResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { description: 'DMS document not found in the remote system' },
          409: { description: 'Document is already linked' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/documents/dms/push': {
      post: op({
        summary: 'Push a document to a DMS account',
        tag: 'Documents',
        admin: true,
        stateChanging: true,
        description: 'Uploads a document with storage_backend `local` or `webdav` to the specified DMS account. Only storage_backend `dms` means the document is already stored in the DMS. Returns a task ID for async tracking.',
        requestBody: jsonBody('#/components/schemas/DmsPushRequest'),
        responses: {
          202: {
            description: 'Push task accepted',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/DmsPushResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { description: 'Document or DMS account not found' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/weather': { get: op({ summary: 'Get weather data', tag: 'Weather', description: 'Returns `{ data: { provider, city, units, current, forecast } }` or `{ data: null }` when no provider is configured. `provider` is `open-meteo` (icon fields are Lucide icon names, `desc` is a `wmo.<code>` i18n key) or `openweathermap` (legacy; icon fields are OWM icon codes, `desc` is localized text).' }) },
    '/api/v1/weather/icon/{code}': {
      get: op({ summary: 'Get weather icon asset', tag: 'Weather', params: [{ name: 'code', in: 'path', required: true, schema: { type: 'string' } }] }),
    },
    '/api/v1/preferences': {
      get: op({ summary: 'Get user preferences', tag: 'Preferences', description: 'Household preferences. Weather fields: `weather_provider` (`open-meteo` | `openweathermap` | `null` = auto-detect from env), `weather_lat`, `weather_lon`, `weather_city`, `weather_units` (`metric` | `imperial`). Holiday fields: `holiday_country` (ISO-3166 alpha-2 or `null`), `holiday_subdivision` (e.g. `DE-BY` or `null`), `holiday_show_public`, `holiday_show_school` (booleans), `holiday_public_color`, `holiday_school_color` (hex), `holiday_last_sync`.' }),
      put: op({ summary: 'Update user preferences', tag: 'Preferences', description: 'Weather fields (`weather_provider`, `weather_lat`, `weather_lon`, `weather_city`, `weather_units`) and holiday fields (`holiday_country`, `holiday_subdivision`, `holiday_show_public`, `holiday_show_school`, `holiday_public_color`, `holiday_school_color`) are admin-only. `weather_lat`/`weather_lon` are validated to ±90 / ±180; colors must be 6-digit hex.', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/preferences/holidays/countries': { get: op({ summary: 'List countries supported by OpenHolidays', tag: 'Preferences', description: 'Proxies the OpenHolidays API. Returns `{ data: [{ isoCode, name }] }` for the country dropdown.' }) },
    '/api/v1/preferences/holidays/subdivisions/{countryCode}': { get: op({ summary: 'List subdivisions for a country', tag: 'Preferences', params: [{ name: 'countryCode', in: 'path', required: true, schema: { type: 'string', pattern: '^[A-Z]{2}$' } }], description: 'Proxies the OpenHolidays API. Returns `{ data: [{ isoCode, name }] }` for the state/region dropdown.' }) },
    '/api/v1/preferences/holidays/sync': { post: op({ summary: 'Sync holidays for the configured country', tag: 'Preferences', admin: true, stateChanging: true, description: 'Fetches public/school holidays from OpenHolidays for the configured country/subdivision and caches them. Returns `{ data: { last_sync } }`.' }) },
    '/api/v1/reminders/pending': { get: op({ summary: 'List pending reminders', tag: 'Reminders' }) },
    '/api/v1/reminders': {
      get: op({ summary: 'List reminders', tag: 'Reminders' }),
      post: op({ summary: 'Create reminder', tag: 'Reminders', stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete reminders by filter', tag: 'Reminders', stateChanging: true }),
    },
    '/api/v1/reminders/{id}/dismiss': {
      patch: op({ summary: 'Dismiss reminder', tag: 'Reminders', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/reminders/{id}': {
      delete: op({ summary: 'Delete reminder', tag: 'Reminders', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/search': { get: op({ summary: 'Search across modules', tag: 'Search' }) },
    '/api/v1/split-expenses/meta': { get: op({ summary: 'Get split expenses metadata', tag: 'SplitExpenses' }) },
    '/api/v1/split-expenses/dashboard': { get: op({ summary: 'Get split expenses dashboard summary', tag: 'SplitExpenses' }) },
    '/api/v1/split-expenses/groups': {
      get: op({ summary: 'List expense groups', tag: 'SplitExpenses' }),
      post: op({ summary: 'Create expense group', tag: 'SplitExpenses', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/split-expenses/groups/{id}': {
      get: op({ summary: 'Get expense group', tag: 'SplitExpenses', params: [idParam()] }),
      put: op({ summary: 'Update expense group', tag: 'SplitExpenses', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete expense group', tag: 'SplitExpenses', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/split-expenses/groups/{id}/archive': {
      patch: op({ summary: 'Archive or unarchive expense group', tag: 'SplitExpenses', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/split-expenses/groups/{id}/members': {
      get: op({ summary: 'List group members', tag: 'SplitExpenses', params: [idParam()] }),
      post: op({ summary: 'Add member to group', tag: 'SplitExpenses', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/split-expenses/groups/{id}/members/{userId}': {
      delete: op({ summary: 'Remove member from group', tag: 'SplitExpenses', params: [idParam(), { name: 'userId', in: 'path', required: true, schema: { type: 'integer' } }], stateChanging: true }),
    },
    '/api/v1/split-expenses/groups/{id}/expenses': {
      get: op({ summary: 'List group expenses', tag: 'SplitExpenses', params: [idParam()] }),
      post: op({ summary: 'Create expense in group', tag: 'SplitExpenses', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/split-expenses/groups/{id}/balances': {
      get: op({ summary: 'Get group balances', tag: 'SplitExpenses', params: [idParam()] }),
    },
    '/api/v1/split-expenses/groups/{id}/settlements': {
      get: op({ summary: 'List group settlements', tag: 'SplitExpenses', params: [idParam()] }),
      post: op({ summary: 'Record settlement', tag: 'SplitExpenses', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/split-expenses/groups/{id}/activity': {
      get: op({ summary: 'Get group activity feed', tag: 'SplitExpenses', params: [idParam()] }),
    },
    '/api/v1/split-expenses/expenses/{id}': {
      get: op({ summary: 'Get expense detail', tag: 'SplitExpenses', params: [idParam()] }),
      put: op({ summary: 'Update expense', tag: 'SplitExpenses', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete expense', tag: 'SplitExpenses', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/split-expenses/expenses/{id}/pause': {
      patch: op({ summary: 'Pause or resume recurring expense', tag: 'SplitExpenses', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/split-expenses/guests': {
      post: op({ summary: 'Create guest account', tag: 'SplitExpenses', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/split-expenses/guests/{id}': {
      put: op({ summary: 'Update guest account', tag: 'SplitExpenses', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete guest account', tag: 'SplitExpenses', params: [idParam()], stateChanging: true }),
    },
  };
}

function buildOpenApiSpec(req, appVersion) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Yuvomi API',
      version: appVersion,
      description: 'OpenAPI documentation for the Yuvomi family organizer backend.',
    },
    servers: [{ url: '/', description: 'Current origin' }],
    tags: [
      { name: 'System' },
      { name: 'Auth' },
      { name: 'Family' },
      { name: 'Dashboard' },
      { name: 'Tasks' },
      { name: 'Shopping' },
      { name: 'Meals' },
      { name: 'Recipes' },
      { name: 'Calendar' },
      { name: 'Notes' },
      { name: 'Contacts' },
      { name: 'Birthdays' },
      { name: 'Budget' },
      { name: 'SplitExpenses' },
      { name: 'Documents' },
      { name: 'Backup' },
      { name: 'Weather' },
      { name: 'Preferences' },
      { name: 'Reminders' },
      { name: 'Search' },
    ],
    paths: buildPaths(),
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'API token sent in the Authorization header as `Bearer <token>`.',
        },
        apiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
          description: 'API token sent in the `X-API-Key` header.',
        },
        cookieAuth: {
          type: 'apiKey',
          in: 'cookie',
          name: 'oikos.sid',
          description: 'Browser session cookie. State-changing requests also require `X-CSRF-Token`.',
        },
      },
      responses: {
        BadRequest: {
          description: 'Bad request',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        },
        Unauthorized: {
          description: 'Authentication required or invalid credentials/token',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        },
        Forbidden: {
          description: 'Permission denied',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        },
        InternalServerError: {
          description: 'Internal server error',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        },
      },
      schemas: {
        ApiError: {
          type: 'object',
          properties: {
            error: { type: 'string' },
            code: { type: 'integer' },
            storage_code: { $ref: '#/components/schemas/DocumentStorageErrorCode' },
          },
        },
        DocumentStorageErrorCode: {
          type: 'string',
          description: 'Stable machine-readable code for document-storage failures.',
          enum: [
            'DOCUMENT_STORAGE_INVALID_CONFIG',
            'DOCUMENT_STORAGE_NOT_CONFIGURED',
            'DOCUMENT_STORAGE_UPLOAD_FAILED',
            'DOCUMENT_STORAGE_READ_FAILED',
            'DOCUMENT_STORAGE_DELETE_FAILED',
            'DOCUMENT_STORAGE_CLEANUP_FAILED',
            'DOCUMENT_STORAGE_TOO_LARGE',
            'DOCUMENT_STORAGE_CONNECTION_TEST_FAILED',
            'DOCUMENT_STORAGE_CONFIG_PROTECTED',
          ],
        },
        FamilyDocument: {
          type: 'object',
          description: 'A family document. storage_backend is authoritative; storage_provider remains for legacy client compatibility.',
          properties: {
            id: { type: 'integer' },
            name: { type: 'string' },
            description: { type: ['string', 'null'] },
            category: { type: ['string', 'null'] },
            status: { type: 'string', enum: ['active', 'archived'] },
            visibility: { type: 'string', enum: ['family', 'restricted', 'private'] },
            original_name: { type: ['string', 'null'] },
            mime_type: { type: ['string', 'null'] },
            file_size: { type: ['integer', 'null'] },
            storage_provider: {
              type: 'string',
              enum: ['local', 'external'],
              description: 'Legacy compatibility field. local pairs with local; external pairs with webdav or dms.',
            },
            storage_backend: {
              type: 'string',
              enum: ['local', 'webdav', 'dms'],
              description: 'Authoritative location of the document bytes or DMS reference.',
            },
            storage_key: { type: ['string', 'null'] },
            dms_account_id: { type: ['integer', 'null'] },
            external_url: { type: ['string', 'null'], format: 'uri' },
            folder_id: { type: ['integer', 'null'] },
            folder_name: { type: ['string', 'null'] },
            created_by: { type: 'integer' },
            creator_name: { type: ['string', 'null'] },
            creator_color: { type: ['string', 'null'] },
            allowed_member_ids: { type: 'array', items: { type: 'integer' } },
            created_at: { type: 'string', format: 'date-time' },
            updated_at: { type: 'string', format: 'date-time' },
          },
          required: [
            'id',
            'name',
            'status',
            'visibility',
            'storage_provider',
            'storage_backend',
            'allowed_member_ids',
          ],
        },
        FamilyDocumentResponse: {
          type: 'object',
          properties: {
            data: { $ref: '#/components/schemas/FamilyDocument' },
          },
          required: ['data'],
        },
        FamilyDocumentsResponse: {
          type: 'object',
          properties: {
            data: {
              type: 'array',
              items: { $ref: '#/components/schemas/FamilyDocument' },
            },
          },
          required: ['data'],
        },
        DocumentOptionsResponse: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                categories: { type: 'array', items: { type: 'string' } },
                visibilities: {
                  type: 'array',
                  items: { type: 'string', enum: ['family', 'restricted', 'private'] },
                },
                statuses: {
                  type: 'array',
                  items: { type: 'string', enum: ['active', 'archived'] },
                },
                max_file_size: { type: 'integer' },
                allowed_mime_types: { type: 'array', items: { type: 'string' } },
                storage_providers: {
                  type: 'array',
                  description: 'Legacy provider values retained for compatibility.',
                  items: { type: 'string', enum: ['local', 'external'] },
                },
                active_upload_backend: {
                  type: 'string',
                  enum: ['local', 'webdav'],
                  description: 'Backend used for newly uploaded document files, including calendar attachments.',
                },
                dms_accounts: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'integer' },
                      name: { type: 'string' },
                      provider: { type: 'string', enum: ['paperless'] },
                    },
                    required: ['id', 'name', 'provider'],
                  },
                },
              },
              required: [
                'categories',
                'visibilities',
                'statuses',
                'max_file_size',
                'allowed_mime_types',
                'storage_providers',
                'active_upload_backend',
                'dms_accounts',
              ],
            },
          },
          required: ['data'],
        },
        DocumentStorageConfigRequest: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
            url: { type: ['string', 'null'], format: 'uri', description: 'HTTP(S) WebDAV server URL.' },
            username: { type: ['string', 'null'] },
            password: {
              type: ['string', 'null'],
              writeOnly: true,
              description: 'WebDAV password. Empty and masked values preserve the stored password.',
            },
            path: { type: ['string', 'null'], description: 'Base path below the WebDAV server URL.' },
            confirm_existing_access: {
              type: 'boolean',
              description: 'Required for connection changes while WebDAV documents exist.',
            },
            clear_password: {
              type: 'boolean',
              description: 'Explicitly remove the stored password. Rejected when existing WebDAV documents require it.',
            },
          },
        },
        DocumentStorageTestRequest: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
            url: { type: ['string', 'null'], format: 'uri' },
            username: { type: ['string', 'null'] },
            password: { type: ['string', 'null'], writeOnly: true },
            path: { type: ['string', 'null'] },
            clear_password: { type: 'boolean' },
          },
        },
        DocumentStorageStatus: {
          type: 'object',
          description: 'Effective WebDAV document-storage status. The password value is never returned.',
          properties: {
            enabled: { type: 'boolean' },
            configured: { type: 'boolean' },
            active_upload_backend: { type: 'string', enum: ['local', 'webdav'] },
            effective_target: { type: ['string', 'null'], format: 'uri' },
            webdav_document_count: { type: 'integer', minimum: 0 },
            last_test: { type: ['string', 'null'], format: 'date-time' },
            last_error: { type: ['string', 'null'] },
            url: { type: ['string', 'null'], format: 'uri' },
            username: { type: ['string', 'null'] },
            base_path: { type: 'string' },
            password_configured: { type: 'boolean' },
            env_controlled: {
              type: 'object',
              properties: {
                enabled: { type: 'boolean' },
                url: { type: 'boolean' },
                username: { type: 'boolean' },
                password: { type: 'boolean' },
                path: { type: 'boolean' },
              },
              required: ['enabled', 'url', 'username', 'password', 'path'],
            },
          },
          required: [
            'enabled',
            'configured',
            'active_upload_backend',
            'effective_target',
            'webdav_document_count',
            'last_test',
            'last_error',
            'url',
            'username',
            'base_path',
            'password_configured',
            'env_controlled',
          ],
        },
        DocumentStorageStatusResponse: {
          type: 'object',
          properties: {
            data: { $ref: '#/components/schemas/DocumentStorageStatus' },
          },
          required: ['data'],
        },
        DocumentStorageTestResponse: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: { ok: { type: 'boolean', const: true } },
              required: ['ok'],
            },
          },
          required: ['data'],
        },
        CalendarEvent: {
          type: 'object',
          description: 'Calendar event. New attachments use document URLs; attachment_data remains available for legacy stored blobs.',
          properties: {
            id: { type: 'integer' },
            title: { type: 'string' },
            attachment_name: { type: ['string', 'null'] },
            attachment_mime: { type: ['string', 'null'] },
            attachment_size: { type: ['integer', 'null'] },
            attachment_document_id: { type: ['integer', 'null'] },
            attachment_preview_url: { type: ['string', 'null'] },
            attachment_download_url: { type: ['string', 'null'] },
            attachment_data: {
              type: ['string', 'null'],
              description: 'Legacy attachment data URL. Null for attachments linked through attachment_document_id.',
            },
          },
          required: [
            'id',
            'title',
            'attachment_document_id',
            'attachment_preview_url',
            'attachment_download_url',
            'attachment_data',
          ],
          additionalProperties: true,
        },
        CalendarEventResponse: {
          type: 'object',
          properties: {
            data: { $ref: '#/components/schemas/CalendarEvent' },
          },
          required: ['data'],
        },
        CalendarEventsResponse: {
          type: 'object',
          properties: {
            data: {
              type: 'array',
              items: { $ref: '#/components/schemas/CalendarEvent' },
            },
            from: { type: 'string', format: 'date' },
            to: { type: 'string', format: 'date' },
          },
          required: ['data'],
        },
        HealthResponse: {
          type: 'object',
          properties: {
            status: { type: 'string', example: 'ok' },
            timestamp: { type: 'string', format: 'date-time' },
          },
          required: ['status', 'timestamp'],
        },
        VersionResponse: {
          type: 'object',
          properties: {
            version: { type: 'string' },
            app_name: { type: 'string' },
            setup_required: { type: 'boolean' },
          },
          required: ['app_name', 'setup_required'],
        },
        User: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            username: { type: 'string' },
            display_name: { type: 'string' },
            avatar_color: { type: 'string' },
            avatar_data: { type: ['string', 'null'], description: 'PNG, JPEG, or WebP data URL.' },
            role: { type: 'string', enum: ['admin', 'member'] },
            family_role: { type: 'string', enum: ['dad', 'mom', 'parent', 'child', 'grandparent', 'relative', 'other'] },
            phone: { type: ['string', 'null'] },
            email: { type: ['string', 'null'] },
            birth_date: { type: ['string', 'null'], format: 'date' },
          },
          required: ['id', 'username', 'display_name', 'avatar_color', 'role', 'family_role'],
        },
        FamilyMember: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            display_name: { type: 'string' },
            avatar_color: { type: 'string' },
            avatar_data: { type: ['string', 'null'], description: 'PNG, JPEG, or WebP data URL.' },
            family_role: { type: 'string', enum: ['dad', 'mom', 'parent', 'child', 'grandparent', 'relative', 'other'] },
            phone: { type: ['string', 'null'] },
            email: { type: ['string', 'null'] },
            birth_date: { type: ['string', 'null'], format: 'date' },
            created_at: { type: 'string', format: 'date-time' },
          },
          required: ['id', 'display_name', 'avatar_color', 'family_role'],
        },
        FamilyMembersResponse: {
          type: 'object',
          properties: {
            data: {
              type: 'array',
              items: { $ref: '#/components/schemas/FamilyMember' },
            },
          },
          required: ['data'],
        },
        LoginRequest: {
          type: 'object',
          properties: {
            username: { type: 'string' },
            password: { type: 'string' },
          },
          required: ['username', 'password'],
        },
        LoginResponse: {
          type: 'object',
          properties: {
            user: { $ref: '#/components/schemas/User' },
            csrfToken: { type: 'string' },
          },
          required: ['user', 'csrfToken'],
        },
        MeResponse: {
          type: 'object',
          properties: {
            user: { $ref: '#/components/schemas/User' },
            csrfToken: { type: 'string' },
          },
          required: ['user'],
        },
        SetupRequest: {
          type: 'object',
          properties: {
            username: { type: 'string' },
            display_name: { type: 'string' },
            password: { type: 'string' },
          },
          required: ['username', 'display_name', 'password'],
        },
        PasswordChangeRequest: {
          type: 'object',
          properties: {
            currentPassword: { type: 'string' },
            newPassword: { type: 'string' },
          },
          required: ['currentPassword', 'newPassword'],
        },
        UserCreateRequest: {
          type: 'object',
          properties: {
            username: { type: 'string' },
            display_name: { type: 'string' },
            password: { type: 'string' },
            avatar_color: { type: 'string' },
            avatar_data: { type: ['string', 'null'], description: 'PNG, JPEG, or WebP data URL.' },
            family_role: { type: 'string', enum: ['dad', 'mom', 'parent', 'child', 'grandparent', 'relative', 'other'] },
            system_admin: { type: 'boolean' },
            phone: { type: ['string', 'null'] },
            email: { type: ['string', 'null'] },
            birth_date: { type: ['string', 'null'], format: 'date' },
          },
          required: ['username', 'display_name', 'password'],
        },
        UserUpdateRequest: {
          type: 'object',
          properties: {
            username: { type: 'string' },
            display_name: { type: 'string' },
            avatar_color: { type: 'string' },
            avatar_data: { type: ['string', 'null'], description: 'PNG, JPEG, or WebP data URL. Use null to remove.' },
            family_role: { type: 'string', enum: ['dad', 'mom', 'parent', 'child', 'grandparent', 'relative', 'other'] },
            system_admin: { type: 'boolean' },
            phone: { type: ['string', 'null'] },
            email: { type: ['string', 'null'] },
            birth_date: { type: ['string', 'null'], format: 'date' },
          },
        },
        ProfileUpdateRequest: {
          type: 'object',
          properties: {
            display_name: { type: 'string' },
            avatar_color: { type: 'string' },
            avatar_data: { type: ['string', 'null'], description: 'PNG, JPEG, or WebP data URL. Use null to remove.' },
          },
        },
        ApiToken: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            name: { type: 'string' },
            token_prefix: { type: 'string' },
            created_by: { type: 'integer' },
            creator_name: { type: 'string' },
            expires_at: { type: ['string', 'null'], format: 'date-time' },
            revoked_at: { type: ['string', 'null'], format: 'date-time' },
            last_used_at: { type: ['string', 'null'], format: 'date-time' },
            created_at: { type: 'string', format: 'date-time' },
          },
          required: ['id', 'name', 'token_prefix', 'created_by', 'created_at'],
        },
        ApiTokenCreateRequest: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            expires_at: { type: ['string', 'null'], format: 'date-time' },
          },
          required: ['name'],
        },
        ApiTokenCreateResponse: {
          type: 'object',
          properties: {
            data: { $ref: '#/components/schemas/ApiToken' },
            token: { type: 'string' },
          },
          required: ['data', 'token'],
        },
        DmsAccount: {
          type: 'object',
          description: 'A configured DMS account. The api_token is never returned; use has_token to check whether one is stored.',
          properties: {
            id: { type: 'integer' },
            provider: { type: 'string', enum: ['paperless'], description: 'DMS provider type' },
            name: { type: 'string' },
            base_url: { type: 'string', format: 'uri' },
            created_at: { type: 'string', format: 'date-time' },
            last_check: { type: ['string', 'null'], format: 'date-time' },
            has_token: { type: 'boolean', description: 'Whether an API token is stored for this account' },
          },
          required: ['id', 'provider', 'name', 'base_url', 'created_at', 'has_token'],
        },
        DmsAccountsResponse: {
          type: 'object',
          properties: {
            data: { type: 'array', items: { $ref: '#/components/schemas/DmsAccount' } },
          },
          required: ['data'],
        },
        DmsAccountResponse: {
          type: 'object',
          properties: {
            data: { $ref: '#/components/schemas/DmsAccount' },
          },
          required: ['data'],
        },
        DmsAccountCreateRequest: {
          type: 'object',
          properties: {
            provider: { type: 'string', enum: ['paperless'] },
            name: { type: 'string' },
            base_url: { type: 'string', format: 'uri' },
            api_token: { type: 'string', description: 'API token for authenticating with the DMS. Write-only; never returned in responses.' },
          },
          required: ['provider', 'name', 'base_url', 'api_token'],
        },
        DmsTestResponse: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                ok: { type: 'boolean' },
                status: { type: 'integer' },
              },
              required: ['ok', 'status'],
            },
          },
          required: ['data'],
        },
        DmsSearchResult: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            title: { type: 'string' },
            created: { type: 'string', format: 'date-time' },
            filename: { type: ['string', 'null'] },
            url: { type: 'string', format: 'uri' },
          },
          required: ['id', 'title'],
        },
        DmsSearchResponse: {
          type: 'object',
          properties: {
            data: { type: 'array', items: { $ref: '#/components/schemas/DmsSearchResult' } },
          },
          required: ['data'],
        },
        DmsLinkRequest: {
          type: 'object',
          properties: {
            account_id: { type: 'integer' },
            dms_document_id: { type: 'integer' },
            category: { type: 'string', enum: ['medical', 'school', 'identity', 'insurance', 'finance', 'home', 'vehicle', 'legal', 'travel', 'pets', 'warranty', 'taxes', 'work', 'other'] },
            visibility: { type: 'string', enum: ['family', 'restricted', 'private'] },
          },
          required: ['account_id', 'dms_document_id'],
        },
        DmsLinkResponse: {
          type: 'object',
          description: 'The created family_documents row. storage_provider is `external` and storage_backend is `dms` for linked DMS documents.',
          properties: {
            data: {
              type: 'object',
              properties: {
                id: { type: 'integer' },
                name: { type: 'string' },
                category: { type: ['string', 'null'] },
                visibility: { type: 'string' },
                storage_provider: { type: 'string', enum: ['external'] },
                storage_backend: { type: 'string', enum: ['dms'] },
                dms_account_id: { type: ['integer', 'null'] },
                external_url: { type: ['string', 'null'], format: 'uri' },
                created_at: { type: 'string', format: 'date-time' },
              },
              required: ['id', 'name', 'storage_provider', 'storage_backend'],
            },
          },
          required: ['data'],
        },
        DmsPushRequest: {
          type: 'object',
          properties: {
            account_id: { type: 'integer' },
            document_id: { type: 'integer' },
          },
          required: ['account_id', 'document_id'],
        },
        DmsPushResponse: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                taskId: { type: 'string' },
              },
              required: ['taskId'],
            },
          },
          required: ['data'],
        },
      },
    },
  };
}

export { buildOpenApiSpec };
