import { op, idParam, stringPathParam, withCaseReasons, withValidationRefusal } from '../helpers.js';
import { OPTIONAL_DATE_PATTERN } from '../../utils/datetime-pattern.js';
import { CONTACT_CATEGORY_COLORS } from '../../services/contacts-fields.js';
import { MAX_CONTACT_ENTRIES, MAX_ORDER_ROWS } from '../array-limits.js';

// ---------------------------------------------------------------------------
// Bausteine der Anfrage-Schemata (#2810, Gruppe 7). Das Schema traegt Typ und
// Gestalt; die Laengen bleiben im Handler, weil er nach dem Trimmen zaehlt und
// seine Grenze als `params.limit` neben dem Grund nennt (#1909), was ein
// Schema nicht tragen kann. Die Farbliste kommt aus derselben Quelle, aus der
// die Route prueft (server/services/contacts-fields.js).
// ---------------------------------------------------------------------------

/**
 * A JSON body. `{}` sent on purpose counts as sent; a call without a body is 400.
 * @param {Record<string, unknown>} schema
 */
const body = (schema) => ({
  required: true,
  description: 'JSON request body. Fields the schema does not name are ignored.',
  content: { 'application/json': { schema: { type: 'object', ...schema } } },
});

const LENGTH_NOTE = 'Its length is checked by the route after trimming (the refusal names the field\'s `reason` and `params.limit`).';
/**
 * Free text the route trims; `null` or `""` clears it (on update) or leaves it
 * empty (on create).
 * @param {string} description
 */
const text = (description) => ({ type: ['string', 'null'], description: `${description} \`null\` or \`""\` means none. ${LENGTH_NOTE}` });

/** `YYYY-MM-DD`; whether the day exists is the route's check (with the placeholder year when it is unknown). */
const BIRTHDAY = {
  type: ['string', 'null'],
  pattern: OPTIONAL_DATE_PATTERN,
  'x-reason': { pattern: 'contacts_birthday_invalid' },
  description: '`YYYY-MM-DD`; `null` or `""` means none. A day that does not exist is refused by the route with `contacts_birthday_invalid`, as is any other form.',
};

/** `birthday_year_unknown` (#2095): a switch, `true`/`false` or `1`/`0`; `null` counts as `false`. */
const YEAR_UNKNOWN = {
  anyOf: [{ type: 'boolean' }, { type: 'integer', enum: [0, 1] }, { type: 'null' }],
  description: 'A birthday without a year (#2095): `true`/`false` or `1`/`0`; `null` counts as `false`. Text is refused.',
};

/** The parts of a structured name (#535); `name` is derived from them when any is sent. */
const NAME_PARTS = {
  firstName: text('Given name.'),
  lastName: text('Family name.'),
  middleName: text('Middle name.'),
  namePrefix: text('Title or prefix (kept, not shown in the display name).'),
  nameSuffix: text('Suffix (kept, not shown in the display name).'),
};

const NAME_PART_KEYS = /** @type {Array<keyof typeof NAME_PARTS>} */ (Object.keys(NAME_PARTS));

// Volle Darstellung (#2810, RFC 9110): auf PUT ersetzen die Namensteile alle
// fuenf gespeicherten, sobald einer kommt; ein fehlender wurde bis v2.93 still
// `null` (ein importierter Zweitname, Titel oder Suffix ging verloren). Steht
// einer im Rumpf, sind alle fuenf Pflicht; keiner haelt alle fuenf.
const NAME_GROUP_NOTE = 'One of five name parts (`firstName`, `lastName`, `middleName`, `namePrefix`, `nameSuffix`) that are sent together or not at all (#2810): left out all together, all five stay as they are; when one is sent, all five are required and replace the stored ones, and `name` is derived from them. Up to v2.93 a part left out next to another was cleared.';

/** The name parts on update: each one names the group it belongs to. */
const UPDATE_NAME_PARTS = Object.fromEntries(NAME_PART_KEYS.map((key) => [key, { ...NAME_PARTS[key], description: `${NAME_PARTS[key].description} ${NAME_GROUP_NOTE}` }]));

/** Each name part requires the other four (`dependentRequired`). */
const NAME_GROUP = Object.fromEntries(NAME_PART_KEYS.map((key) => [key, NAME_PART_KEYS.filter((other) => other !== key)]));

/**
 * One entry of `phones` or `emails`. Its label and value are text; that they
 * are not empty, their length and the form of an email address are the
 * route's checks (with their own `reason`).
 * @param {string} what
 */
const valueEntry = (what) => ({
  type: 'object',
  required: ['label', 'value'],
  properties: {
    label: { type: 'string', description: 'A label such as `mobile`, `work` or `other` (free text, not a list).' },
    value: { type: 'string', description: `The ${what}.` },
    isPrimary: { type: 'boolean' },
  },
});

const ADDRESS_ENTRY = {
  type: 'object',
  required: ['label'],
  properties: {
    label: { type: 'string', description: 'A label such as `home` or `work` (free text, not a list).' },
    street: { type: 'string' },
    city: { type: 'string' },
    state: { type: 'string' },
    postalCode: { type: 'string' },
    country: { type: 'string' },
    isPrimary: { type: 'boolean' },
  },
};

/**
 * A multi-value field: a list of entries. The answer to a value that is not a
 * list carries the field's own `*_entry_invalid` - the reason the route gives
 * for it as well. An entry out of shape is a 400 with `reason: "validation"`.
 * The reason names `type` alone: more than MAX_CONTACT_ENTRIES entries is a
 * 400 with `reason: "validation"` too (#2810). The route's own cap of 20 per
 * kind, with its `*_too_many` reason and `params.limit`, answers below that.
 * @param {string} reason
 * @param {Record<string, unknown>} entry
 * @param {string} description
 */
const multi = (reason, entry, description) => ({
  type: 'array', maxItems: MAX_CONTACT_ENTRIES, 'x-reason': { type: reason }, items: entry, description,
});

/** The fields of a contact; create and update take the same ones. */
const CONTACT_PROPERTIES = {
  name: { type: ['string', 'null'], description: `The display name; with name parts it is derived from them. Required on create unless a name part is sent. ${LENGTH_NOTE}` },
  ...NAME_PARTS,
  category: { type: ['string', 'null'], description: 'A key of GET /api/v1/contacts/categories; `null` or `""`: `misc` on create, unchanged on update.' },
  phone: text('The main phone number.'),
  email: text('The main email address.'),
  address: text('The address as one text.'),
  notes: text('Free note.'),
  birthday: BIRTHDAY,
  birthday_year_unknown: YEAR_UNKNOWN,
  phones: multi('contacts_phone_entry_invalid', valueEntry('phone number'), 'Phone numbers. On update the list replaces all stored ones.'),
  emails: multi('contacts_email_entry_invalid', valueEntry('email address'), 'Email addresses. On update the list replaces all stored ones.'),
  addresses: multi('contacts_address_entry_invalid', ADDRESS_ENTRY, 'Postal addresses. On update the list replaces all stored ones.'),
};

/** A category colour: one of the curated tones, `null` or `""` for neutral. */
const CATEGORY_COLOR = {
  type: ['string', 'null'],
  enum: [...CONTACT_CATEGORY_COLORS, '', null],
  description: 'One of the curated tones (`categoryColors` of GET /api/v1/contacts/meta); `null` or `""` is neutral.',
};
const CATEGORY_NAME = { type: 'string', description: 'The category name; checked by the route after trimming.' };

const QUERY_NOTE = 'A doubled value or a value outside its type is 400.';
const contactId = () => idParam('id', 'Contact ID, plain decimal digits.');
const accountId = () => idParam('id', 'CardDAV account ID, plain decimal digits; `0` or below is the route\'s own 400 with `errorCode: invalid_id`.');
// CardDAV spricht seinen eigenen Dialekt (`errorCode`); die Absage des Schemas
// traegt ihn nicht, die Einstellungsseite liest dafuer `reason: validation`.
const CARDDAV_ORDER_NOTE = 'A request outside the schema (a path id that is not plain decimal digits, a body value that is not of its type) answers 400 with `reason: "validation"` and `fields`, without `errorCode`.';
const ACCOUNT_FIELDS = {
  name: { type: 'string', description: 'A name for the account; checked by the route after trimming.' },
  cardavUrl: { type: 'string', description: 'The CardDAV address; checked by the route after trimming.' },
  username: { type: 'string', description: 'The user name at the server.' },
};


export function contactsPaths() {
  return withCaseReasons('contacts', CASE_REASONS, {
    '/api/v1/contacts': {
      get: withValidationRefusal(op({
        summary: 'List contacts',
        tag: 'Contacts',
        params: [
          { name: 'category', in: 'query', required: false, schema: { type: 'string' }, description: `Only contacts of this category key; a key that does not exist lists all. ${QUERY_NOTE}` },
          { name: 'q', in: 'query', required: false, schema: { type: 'string' }, description: `Text contained in the name, phone or email. ${QUERY_NOTE}` },
        ],
      })),
      post: withValidationRefusal(op({
        summary: 'Create contact with multi-value fields',
        tag: 'Contacts',
        description: '`birthday_year_unknown` (boolean or 0/1) marks a birthday without a year (#2095): `birthday` then carries the placeholder year 2000 whatever year is sent, and responses carry the flag as 0 or 1. A text field that is not text (a number, a list, an object) is refused with 400 and `reason: "validation"`; until #2810 it was stored as its text (`{}` as `[object Object]`).',
        stateChanging: true,
        requestBody: body({ properties: CONTACT_PROPERTIES }),
      })),
    },
    '/api/v1/contacts/meta': { get: op({ summary: 'Get contact metadata', tag: 'Contacts' }) },
    '/api/v1/contacts/categories': {
      get: op({ summary: 'List contact categories', tag: 'Contacts' }),
      post: withValidationRefusal(op({
        summary: 'Create contact category',
        tag: 'Contacts',
        stateChanging: true,
        requestBody: body({ required: ['name'], properties: { name: CATEGORY_NAME, color: CATEGORY_COLOR } }),
      })),
    },
    '/api/v1/contacts/categories/reorder': {
      patch: withValidationRefusal(op({
        summary: 'Reorder contact categories',
        tag: 'Contacts',
        description: '`order` lists category keys in the wanted order; a key that does not exist is skipped, a category left out keeps its place. A body without `order`, or an `order` that is not a list of text, is refused with 400; until #2810 it was taken as an empty list (200, nothing changed), and an entry that was an object or a truth value answered 500.',
        stateChanging: true,
        requestBody: body({ required: ['order'], properties: { order: { type: 'array', maxItems: MAX_ORDER_ROWS, items: { type: 'string' } } } }),
      })),
    },
    '/api/v1/contacts/categories/{key}': {
      put: withValidationRefusal(op({
        summary: 'Rename or recolor contact category',
        tag: 'Contacts',
        description: 'Takes `name`, `color` or both. `color` alone changes the tone and keeps a translated seed name translated. A body with neither is refused with 400.',
        params: [stringPathParam('key', 'Category key')],
        stateChanging: true,
        requestBody: body({
          properties: { name: CATEGORY_NAME, color: CATEGORY_COLOR },
          anyOf: [
            { properties: { name: CATEGORY_NAME }, required: ['name'] },
            { properties: { color: CATEGORY_COLOR }, required: ['color'] },
          ],
        }),
      })),
      delete: withValidationRefusal(op({ summary: 'Delete contact category', tag: 'Contacts', params: [stringPathParam('key', 'Category key')], stateChanging: true })),
    },
    '/api/v1/contacts/cardav/accounts': {
      get: op({ summary: 'List CardDAV accounts', tag: 'Contacts', admin: true }),
      post: withValidationRefusal(op({
        summary: 'Add CardDAV account',
        tag: 'Contacts',
        admin: true,
        description: `Connects to the server and discovers its address books; a server that refuses or cannot be reached answers 502 with \`errorCode: connection_failed\`. ${CARDDAV_ORDER_NOTE}`,
        stateChanging: true,
        requestBody: body({
          required: ['name', 'cardavUrl', 'username', 'password'],
          properties: { ...ACCOUNT_FIELDS, password: { type: 'string', description: 'The password, as typed: it is not trimmed.' } },
        }),
      })),
    },
    '/api/v1/contacts/cardav/accounts/{id}': {
      put: withValidationRefusal(op({
        summary: 'Update CardDAV account credentials',
        tag: 'Contacts',
        admin: true,
        description: `An empty \`password\` (or \`null\`, or none) keeps the stored one, but only while the server (scheme, host and port) and the \`username\` stay the same. A different server or username without a new password is refused with 400 and \`errorCode: password_required\`, and nothing is saved. A different path on the same server needs no password. ${CARDDAV_ORDER_NOTE}`,
        params: [accountId()],
        stateChanging: true,
        requestBody: body({
          required: ['name', 'cardavUrl', 'username'],
          properties: { ...ACCOUNT_FIELDS, password: { type: ['string', 'null'], description: 'A new password, as typed; empty, `null` or left out keeps the stored one (see above). Until #2810 a value that was not text counted as empty.' } },
        }),
      })),
      delete: withValidationRefusal(op({
        summary: 'Delete CardDAV account',
        tag: 'Contacts',
        admin: true,
        description: `An id that belongs to no account answers 404 with \`errorCode: account_not_found\` (until #2810 it answered 500). ${CARDDAV_ORDER_NOTE}`,
        params: [accountId()],
        stateChanging: true,
      })),
    },
    '/api/v1/contacts/cardav/accounts/{id}/test': {
      post: withValidationRefusal(op({ summary: 'Test CardDAV connection', tag: 'Contacts', admin: true, description: CARDDAV_ORDER_NOTE, params: [accountId()] })),
    },
    '/api/v1/contacts/cardav/accounts/{id}/addressbooks': {
      get: withValidationRefusal(op({ summary: 'List addressbooks for account', tag: 'Contacts', admin: true, description: `An id that belongs to no account answers 200 with an empty list. ${CARDDAV_ORDER_NOTE}`, params: [accountId()] })),
    },
    '/api/v1/contacts/cardav/accounts/{id}/addressbooks/refresh': {
      post: withValidationRefusal(op({ summary: 'Refresh addressbooks for account', tag: 'Contacts', admin: true, description: CARDDAV_ORDER_NOTE, params: [accountId()], stateChanging: true })),
    },
    '/api/v1/contacts/cardav/addressbooks/{id}': {
      put: withValidationRefusal(op({
        summary: 'Toggle addressbook enabled state',
        tag: 'Contacts',
        admin: true,
        description: CARDDAV_ORDER_NOTE,
        params: [idParam('id', 'Address book ID, plain decimal digits; `0` or below is the route\'s own 400 with `errorCode: invalid_id`.')],
        stateChanging: true,
        requestBody: body({ required: ['enabled'], properties: { enabled: { type: 'boolean', description: 'A JSON boolean; text, a number or `null` is refused.' } } }),
      })),
    },
    '/api/v1/contacts/cardav/accounts/{id}/sync': {
      post: withValidationRefusal(op({ summary: 'Sync CardDAV account', tag: 'Contacts', admin: true, description: CARDDAV_ORDER_NOTE, params: [accountId()], stateChanging: true })),
    },
    '/api/v1/contacts/{id}': {
      get: withValidationRefusal(op({ summary: 'Get contact with multi-value fields', tag: 'Contacts', params: [contactId()] })),
      put: withValidationRefusal(op({
        summary: 'Update contact with multi-value fields',
        tag: 'Contacts',
        description: 'Every field is optional: a field left out stays as it is, with one group: the five name parts (`firstName`, `lastName`, `middleName`, `namePrefix`, `nameSuffix`) are sent all together or not at all; one without the others is a 400 with `reason: "validation"` and `fields` naming a missing part (#2810). `phones`, `emails` and `addresses`, when sent, replace the whole stored list (an empty list removes all). On a contact linked to an account (`family_user_id`), `email` and `emails` can only be changed by that member or an admin, in a session or with an unscoped token; anyone else, and any token scoped to modules, is refused with 403. Addresses are compared without regard to letter case; sending them unchanged or only in another case is not a change, and the stored spelling is kept. When the member edits their own linked contact, a newly added address that already belongs to another account (split-expense guests excluded) is refused with 409 and `reason: "email_in_use"`; an admin may assign it. All other fields stay editable for anyone with write access to contacts. `birthday_year_unknown` (boolean or 0/1) marks a birthday without a year (#2095): `birthday` then carries the placeholder year 2000 whatever year is sent, and responses carry the flag as 0 or 1. Omitted, the stored flag stays; turning it off needs a `birthday` with its real year in the same request. A request outside the schema is a 400 before the contact is looked up, so it comes before a 404.',
        params: [contactId()],
        stateChanging: true,
        requestBody: body({ properties: { ...CONTACT_PROPERTIES, ...UPDATE_NAME_PARTS }, dependentRequired: NAME_GROUP }),
        responses: {
          200: { description: 'Successful response' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { description: 'The contact does not exist (`reason: "contacts_contact_not_found"`)' },
          409: { description: 'A newly added email address already belongs to another account (`reason: "email_in_use"`)' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      })),
      delete: withValidationRefusal(op({ summary: 'Delete contact', tag: 'Contacts', params: [contactId()], stateChanging: true })),
    },
    '/api/v1/contacts/{id}/vcard': { get: withValidationRefusal(op({ summary: 'Download contact as vCard', tag: 'Contacts', description: 'vCard 3.0. A birthday without a year is written the way Apple and sabre/vobject write it in 3.0, `BDAY;X-APPLE-OMIT-YEAR=1604:1604-MM-DD`.', params: [contactId()] })) },
    '/api/v1/contacts/{id}/photo': { get: withValidationRefusal(op({ summary: 'Get contact photo', tag: 'Contacts', description: 'Returns the raw image bytes with `Content-Type` and an `ETag` for caching. The ETag is a hash of the image CONTENT, and the answer is `Cache-Control: private, no-cache`: the URL never changes, so the client revalidates and gets a 304 while the photo is the same, instead of keeping a replaced photo for a year. Both stored forms are read - a photo synced before 2.86.0 has no `data:` prefix and its type is determined from the image signature. Responds 404 when the contact has no photo, and 422 when the stored value is not a readable image.', params: [contactId()] })) },
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
  + '`params.limit` carries its maximum length), `contacts_birthday_invalid` (400, `birthday` is not a valid date), '
  + '`contacts_photo_too_large`, `contacts_photo_not_an_image` (400, `photo` is not an image data URL) and '
  + '`contacts_photo_type_mismatch` (400, the bytes do not match the declared image type)';
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
const CAT_GONE_404 = '`contacts_category_not_found` (404, the category does not exist - deleted)';
const CAT_EXISTS = '`category_exists` (409, a category with this name already exists)';
const EMAIL_PROTECTED = '`contact_email_protected` (403, the contact is a household member and only that member or an admin, '
  + 'signed in or with a full-access token, may change its email addresses)';
const FAMILY_MEMBER = '`family_member_contact` (403, the contact is a household member and cannot be deleted from the contact list)';
const CASE_REASONS = {
  '/api/v1/contacts/categories': { post: CAT_EXISTS },
  '/api/v1/contacts/categories/{key}': {
    put: `${CAT_GONE_404}, ${CAT_EXISTS}`,
    delete: `${CAT_GONE_404}, \`category_in_use\` (409, contacts still use the category; \`count\` carries how many), \`category_last\` (409, the last category cannot be deleted)`,
  },
  '/api/v1/contacts': { post: `${CATEGORY_GONE}, ${FIELD_CASES}; ${MULTI_CASES}` },
  '/api/v1/contacts/{id}': {
    get: CONTACT_GONE,
    put: `${CONTACT_GONE}, ${EMAIL_PROTECTED}, ${CATEGORY_GONE}, ${FIELD_CASES}; ${MULTI_CASES}`,
    delete: `${CONTACT_GONE}, ${FAMILY_MEMBER}`,
  },
  '/api/v1/contacts/{id}/vcard': { get: CONTACT_GONE },
  '/api/v1/contacts/{id}/photo': { get: `${CONTACT_GONE}, \`contacts_no_photo\` (404, the contact exists but has no photo), \`contacts_photo_unreadable\` (422, the stored value is not a readable image)` },
};
