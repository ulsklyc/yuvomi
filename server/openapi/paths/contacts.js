import { op, jsonBody, idParam, stringPathParam } from '../helpers.js';

export function contactsPaths() {
  return withCaseReasons({
    '/api/v1/contacts': {
      get: op({ summary: 'List contacts', tag: 'Contacts' }),
      post: op({ summary: 'Create contact with multi-value fields', tag: 'Contacts', description: '`birthday_year_unknown` (boolean or 0/1) marks a birthday without a year (#2095): `birthday` then carries the placeholder year 2000 whatever year is sent, and responses carry the flag as 0 or 1.', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/contacts/meta': { get: op({ summary: 'Get contact metadata', tag: 'Contacts' }) },
    '/api/v1/contacts/categories': {
      get: op({ summary: 'List contact categories', tag: 'Contacts' }),
      post: op({ summary: 'Create contact category', tag: 'Contacts', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/contacts/categories/reorder': {
      patch: op({ summary: 'Reorder contact categories', tag: 'Contacts', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/contacts/categories/{key}': {
      put: op({ summary: 'Rename or recolor contact category', tag: 'Contacts', params: [stringPathParam('key', 'Category key')], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete contact category', tag: 'Contacts', params: [stringPathParam('key', 'Category key')], stateChanging: true }),
    },
    '/api/v1/contacts/cardav/accounts': {
      get: op({ summary: 'List CardDAV accounts', tag: 'Contacts', admin: true }),
      post: op({ summary: 'Add CardDAV account', tag: 'Contacts', admin: true, stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/contacts/cardav/accounts/{id}': {
      put: op({
        summary: 'Update CardDAV account credentials',
        tag: 'Contacts',
        admin: true,
        description: 'An empty `password` keeps the stored one, but only while the server (scheme, host and port) and the `username` stay the same. A different server or username without a new password is refused with 400 and `errorCode: password_required`, and nothing is saved. A different path on the same server needs no password.',
        params: [idParam()],
        stateChanging: true,
        requestBody: jsonBody(null),
      }),
      delete: op({ summary: 'Delete CardDAV account', tag: 'Contacts', admin: true, params: [idParam()], stateChanging: true }),
    },
    '/api/v1/contacts/cardav/accounts/{id}/test': {
      post: op({ summary: 'Test CardDAV connection', tag: 'Contacts', admin: true, params: [idParam()] }),
    },
    '/api/v1/contacts/cardav/accounts/{id}/addressbooks': {
      get: op({ summary: 'List addressbooks for account', tag: 'Contacts', admin: true, params: [idParam()] }),
    },
    '/api/v1/contacts/cardav/accounts/{id}/addressbooks/refresh': {
      post: op({ summary: 'Refresh addressbooks for account', tag: 'Contacts', admin: true, params: [idParam()], stateChanging: true }),
    },
    '/api/v1/contacts/cardav/addressbooks/{id}': {
      put: op({ summary: 'Toggle addressbook enabled state', tag: 'Contacts', admin: true, params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/contacts/cardav/accounts/{id}/sync': {
      post: op({ summary: 'Sync CardDAV account', tag: 'Contacts', admin: true, params: [idParam()], stateChanging: true }),
    },
    '/api/v1/contacts/{id}': {
      get: op({ summary: 'Get contact with multi-value fields', tag: 'Contacts', params: [idParam()] }),
      put: op({
        summary: 'Update contact with multi-value fields',
        tag: 'Contacts',
        description: 'On a contact linked to an account (`family_user_id`), `email` and `emails` can only be changed by that member or an admin, in a session or with an unscoped token; anyone else, and any token scoped to modules, is refused with 403. Addresses are compared without regard to letter case; sending them unchanged or only in another case is not a change, and the stored spelling is kept. When the member edits their own linked contact, a newly added address that already belongs to another account (split-expense guests excluded) is refused with 409 and `reason: "email_in_use"`; an admin may assign it. All other fields stay editable for anyone with write access to contacts. `birthday_year_unknown` (boolean or 0/1) marks a birthday without a year (#2095): `birthday` then carries the placeholder year 2000 whatever year is sent, and responses carry the flag as 0 or 1. Omitted, the stored flag stays; turning it off needs a `birthday` with its real year in the same request.',
        params: [idParam()],
        stateChanging: true,
        requestBody: jsonBody(null),
        responses: {
          200: { description: 'Successful response' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          409: { description: 'A newly added email address already belongs to another account (`reason: "email_in_use"`)' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
      delete: op({ summary: 'Delete contact', tag: 'Contacts', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/contacts/{id}/vcard': { get: op({ summary: 'Download contact as vCard', tag: 'Contacts', description: 'vCard 3.0. A birthday without a year is written the way Apple and sabre/vobject write it in 3.0, `BDAY;X-APPLE-OMIT-YEAR=1604:1604-MM-DD`.', params: [idParam()] }) },
  });
}

// #1909: die Faelle, die ein Nutzer erreicht, tragen einen `reason` neben dem
// englischen `error` - je Operation der Satz, der sie nennt.
const CONTACT_GONE = '`contacts_contact_not_found` (404, the contact does not exist - deleted)';
const CATEGORY_GONE = '`contacts_selected_category_not_found` (400, the chosen `category` does not exist - deleted; only when it is the sole finding)';
// Ein zu langes Feld oder ein ungueltiger Geburtstag: das ERSTE Feld, das so
// scheitert, mit der Grenze als Zahl (vor allem der vCard-Import erreicht sie).
const FIELD_CASES = '`contacts_name_too_long`, `contacts_phone_too_long`, `contacts_email_too_long`, '
  + '`contacts_address_too_long`, `contacts_notes_too_long` (400, the first field that is too long; '
  + '`params.limit` carries its maximum length), `contacts_birthday_invalid` (400, `birthday` is not a valid date)';
// Die Mehrfachfelder: erst nach den Einzelfeldern geprueft, in der Reihenfolge
// phones, emails, addresses, und je Liste der ERSTE Eintrag, der scheitert.
const MULTI_CASES = 'for `phones`, `emails` and `addresses`, checked after the fields above and in this order, '
  + 'naming the first entry that fails: `contacts_phones_too_many`, `contacts_emails_too_many`, `contacts_addresses_too_many` '
  + '(400, more than `params.limit` entries), `contacts_phone_too_long`, `contacts_email_too_long` (400, an entry\'s `value` '
  + 'is longer than `params.limit`), `contacts_phone_label_too_long`, `contacts_email_label_too_long`, '
  + '`contacts_address_label_too_long` (400, an entry\'s `label` is longer than `params.limit`), '
  + '`contacts_address_part_too_long` (400, `street`, `city`, `state`, `postalCode` or `country` is longer than `params.limit`), '
  + '`contacts_email_invalid` (400, an email `value` has no `@` with text on both sides), '
  + '`contacts_phone_entry_invalid`, `contacts_email_entry_invalid`, `contacts_address_entry_invalid` (400, the field is not '
  + 'a list, or an entry is not an object, lacks its `label` or `value`, carries one that is not text, or an `isPrimary` that is not a boolean)';
const CASE_REASONS = {
  '/api/v1/contacts': { post: `${CATEGORY_GONE}, ${FIELD_CASES}; ${MULTI_CASES}` },
  '/api/v1/contacts/{id}': { get: CONTACT_GONE, put: `${CONTACT_GONE}, ${CATEGORY_GONE}, ${FIELD_CASES}; ${MULTI_CASES}`, delete: CONTACT_GONE },
};

function withCaseReasons(paths) {
  for (const [path, operations] of Object.entries(CASE_REASONS)) {
    for (const [method, reasons] of Object.entries(operations)) {
      const operation = paths[path]?.[method];
      if (!operation) throw new Error(`openapi contacts: ${method} ${path} is not documented`);
      const note = `A refusal a user can reach carries a \`reason\` next to \`error\` (#1909): ${reasons}.`;
      operation.description = operation.description ? `${operation.description}\n\n${note}` : note;
    }
  }
  return paths;
}
