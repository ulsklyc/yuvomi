import { op, jsonBody, idParam } from '../helpers.js';

// POST und PUT pruefen ihre Felder und antworten mit 400 (validateReminder()
// und die Nachbarn in server/routes/birthdays.js); `op()` fuehrt ohne
// eigene Antwortmenge nur 200/401/500.
function withBadRequest(status, description, extra = {}) {
  return {
    [status]: { description },
    400: { $ref: '#/components/responses/BadRequest' },
    401: { $ref: '#/components/responses/Unauthorized' },
    ...extra,
    500: { $ref: '#/components/responses/InternalServerError' },
  };
}

export function birthdaysPaths() {
  return withCaseReasons({
    '/api/v1/birthdays': {
      get: op({ summary: 'List birthdays', tag: 'Birthdays' }),
      post: op({
        summary: 'Create birthday',
        description: 'Optional `name_day` uses `MM-DD` (month and day only). When set, it creates a separate yearly calendar occurrence and uses the same `reminder_offset` as the birthday. An invalid name, date, photo or reminder field is refused with 400 and nothing is stored.',
        tag: 'Birthdays',
        stateChanging: true,
        requestBody: jsonBody('#/components/schemas/BirthdayCreateInput'),
        responses: withBadRequest(201, 'Birthday created'),
      }),
    },
    '/api/v1/birthdays/upcoming': {
      get: op({
        summary: 'List upcoming birthdays',
        description: 'Ordered by distance to each person’s next birthday; optional name-day fields do not affect ordering. A birthday with `year_unknown` sorts by day and month like any other and carries `next_age: null`.',
        tag: 'Birthdays',
      }),
    },
    '/api/v1/birthdays/feed': {
      get: op({ summary: 'Get own birthday ICS subscription link', tag: 'Birthdays',
        description: 'The independent feed includes all saved birthdays and name days, even with reminders disabled, and excludes unrelated calendar events. Calendar and birthday feed tokens are separate.' }),
      delete: op({ summary: 'Disable own birthday ICS subscription', tag: 'Birthdays', stateChanging: true }),
    },
    '/api/v1/birthdays/feed/regenerate': {
      post: op({ summary: 'Enable or rotate own birthday ICS subscription link', tag: 'Birthdays', stateChanging: true }),
    },
    // BEIDE IMPORT-ROUTEN VERLANGEN KONTAKT-ZUGRIFF, nicht nur Kalender (#1241).
    // Sie lesen aus `contacts`, obwohl ihr Pfad `birthdays` sagt; `op()` haengt
    // ein 403 nur bei `admin: true` an, hier ist es ein Modul-Gate - also
    // ausgeschrieben, sonst behauptet der Katalog eine Antwortmenge, die die
    // Route nicht hat.
    '/api/v1/birthdays/import/candidates': {
      get: op({
        summary: 'List contacts eligible for birthday import',
        tag: 'Birthdays',
        description: 'Reads the contact book, so it requires read access to the `contacts` module in addition to `calendar` - a credential scoped to the calendar alone is refused with 403. Each candidate with a birthday carries `birthday_year_unknown` (boolean); the import takes it over as `year_unknown`.',
        responses: {
          200: { description: 'Successful response' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/birthdays/import': {
      post: op({
        summary: 'Import selected contacts as birthdays',
        tag: 'Birthdays',
        description: 'Body: { contact_ids }. Reads the contact book, so it requires read access to the `contacts` module as well - a credential scoped to the calendar alone is refused with 403.',
        stateChanging: true,
        requestBody: jsonBody(null),
        responses: {
          201: { description: 'Successful response' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/birthdays/meta/options': {
      get: op({ summary: 'Get birthday upload options', tag: 'Birthdays' }),
    },
    '/api/v1/birthdays/{id}': {
      put: op({
        summary: 'Update birthday',
        description: 'Optional `name_day` uses `MM-DD`; send `null` to clear it and remove its generated calendar event and reminder. Omitted fields remain unchanged. A reminder field sent with exactly the value already stored is accepted unchanged, so records written by older versions stay editable; any other invalid value is refused with 400 and nothing is stored.',
        tag: 'Birthdays',
        params: [idParam()],
        stateChanging: true,
        requestBody: jsonBody('#/components/schemas/BirthdayUpdateInput'),
        responses: withBadRequest(200, 'Birthday updated', { 404: { description: 'Birthday not found' } }),
      }),
      delete: op({ summary: 'Delete birthday', tag: 'Birthdays', params: [idParam()], stateChanging: true }),
    },
  });
}

// #1909: die Faelle, die ein Nutzer erreicht, tragen einen `reason` neben dem
// englischen `error` - je Operation der Satz, der sie nennt.
const BIRTHDAY_GONE = '`birthdays_birthday_not_found` (404, the birthday does not exist - deleted)';
const CASE_REASONS = {
  '/api/v1/birthdays/{id}': { put: BIRTHDAY_GONE, delete: BIRTHDAY_GONE },
};

function withCaseReasons(paths) {
  for (const [path, operations] of Object.entries(CASE_REASONS)) {
    for (const [method, reasons] of Object.entries(operations)) {
      const operation = paths[path]?.[method];
      if (!operation) throw new Error(`openapi birthdays: ${method} ${path} is not documented`);
      const note = `A refusal a user can reach carries a \`reason\` next to \`error\` (#1909): ${reasons}.`;
      operation.description = operation.description ? `${operation.description}\n\n${note}` : note;
    }
  }
  return paths;
}
