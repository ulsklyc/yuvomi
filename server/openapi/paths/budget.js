import { op, idParam, stringPathParam, langParam, DOCUMENT_LINKS_READ_NOTE, withCaseReasons, withValidationRefusal } from '../helpers.js';
import { DATE_PATTERN } from '../../utils/datetime-pattern.js';
import {
  ACCOUNT_TYPE_KEYS, CATEGORY_TYPES, RECURRENCE_INTERVAL_KEYS, LOAN_DIRECTIONS, INTEREST_MODES,
  BUDGET_SCOPES, STATS_RANGES, ENTRY_VISIBILITIES, OBJECT_VISIBILITIES, BILLING_CYCLES, END_TYPES,
  SUBSCRIPTION_STATUSES,
} from '../../services/budget-fields.js';
import { MAX_ATTACHMENTS, MAX_MEMBER_IDS, MAX_ORDER_ROWS } from '../array-limits.js';

// ---------------------------------------------------------------------------
// Bausteine der Anfrage-Schemata (#2810, Gruppe 9). Das Schema traegt Typ und
// Gestalt (Typ, Werteliste, Muster); jede Pruefung mit eigenem Grund - Laengen,
// Bereiche, `max`, Pflicht mit Grund, Datenbank, Kalenderlauf - bleibt samt
// Satz im Handler (kein `x-reason`): test:budget-ui liest die Gruende aus dem
// Quelltext der Routen. Unbekannte Felder bleiben ignoriert (kein
// `additionalProperties: false`).
// ---------------------------------------------------------------------------

const json = (/** @type {string} */ name) => ({ 'application/json': { schema: { $ref: `#/components/schemas/${name}` } } });
const apiError = (/** @type {string} */ description) => ({ description, content: json('ApiError') });
const BAD_REQUEST = { $ref: '#/components/responses/BadRequest' };

/**
 * A JSON body. `{}` sent on purpose counts as sent; a call without a body is
 * 400, except where `optional` says the route has a meaning for none.
 * @param {Record<string, unknown>} properties
 * @param {{ required?: string[], anyOf?: Array<Record<string, unknown>>, optional?: boolean, description?: string }} [options]
 */
const body = (properties, { required = [], anyOf, optional = false, description } = {}) => ({
  required: !optional,
  description: description ?? 'JSON request body. Fields the schema does not name are ignored.',
  content: {
    'application/json': {
      schema: { type: 'object', properties, ...(required.length ? { required } : {}), ...(anyOf ? { anyOf } : {}) },
    },
  },
});

/**
 * The answers of an operation, with the 400 of validateRequest() (#2810).
 * @param {Record<string, unknown>} own
 */
const answers = (own) => ({
  ...own,
  400: own[400] ?? BAD_REQUEST,
  401: { $ref: '#/components/responses/Unauthorized' },
  500: { $ref: '#/components/responses/InternalServerError' },
});
const OK = { 200: { description: 'Successful response' } };
const CREATED = { 201: { description: 'Created' } };
const NO_CONTENT = { 204: { description: 'Deleted, no body' } };

const TEXT = { type: 'string', description: 'Text; whether it may be empty and how long it may be is the route\'s check.' };
const TEXT_OR_NULL = { type: ['string', 'null'] };
/** A sum in the main unit of its currency (not cents); its range and precision are the route's check. */
const AMOUNT = { type: 'number' };
const AMOUNT_OR_NULL = { type: ['number', 'null'] };
/** A count or a rate; whole number and range are the route's check, with its own reason. */
const NUMBER = { type: 'number' };
/** A row id in a request body: a positive integer. */
const ROW_ID = { type: 'integer', minimum: 1 };
const ROW_ID_OR_NULL = { type: ['integer', 'null'], minimum: 1 };
const ROW_IDS = { type: 'array', items: ROW_ID };
/** A day key `YYYY-MM-DD`; whether the day exists is the route's check. */
const DAY = { type: 'string', pattern: DATE_PATTERN };
const DAY_OR_NULL = { type: ['string', 'null'], pattern: DATE_PATTERN };
/** A month key `YYYY-MM` with a month 01-12. */
const MONTH_PATTERN = '^\\d{4}-(0[1-9]|1[0-2])$';
const MONTH = { type: 'string', pattern: MONTH_PATTERN };
/** A switch: a boolean, or 0/1 as the budget page sends it. */
const FLAG = { anyOf: [{ type: 'boolean' }, { type: 'integer', enum: [0, 1] }] };
const ENTRY_VISIBILITY = { type: 'string', enum: [...ENTRY_VISIBILITIES], description: '`private`, `shared` or `shared_amount` (others see amount, date and account only); only read in the personal budget mode.' };
const OBJECT_VISIBILITY = { type: 'string', enum: [...OBJECT_VISIBILITIES] };
const HEX_COLOR = { type: ['string', 'null'], pattern: '^#[0-9A-Fa-f]{6}$' };
/** A database key (category, subcategory): free text from the household's own lists. */
const KEY = { type: 'string' };
const KEY_OR_NULL = { type: ['string', 'null'], description: 'Empty or `null`: the default of the category.' };

/** @param {string} name @param {Record<string, unknown>} schema @param {string} description */
const query = (name, schema, description) => ({ name, in: 'query', required: false, description, schema });
const SCOPE = query('scope', { type: 'string', enum: [...BUDGET_SCOPES] }, 'View filter when the household runs in personal budget mode (preference `budget_mode=personal`): `mine` (default) shows entries you own, `household` shows the shared pot. Ignored in shared mode.');
const MONTH_QUERY = (/** @type {string} */ fallback) => query('month', MONTH, `The month \`YYYY-MM\`; without it ${fallback}.`);
const ACCOUNT_QUERY = query('account_id', ROW_ID, 'Only entries booked to this account: a positive whole number.');

const accountId = () => idParam('id', 'Account ID, plain decimal digits.');
const entryId = () => idParam('id', 'Entry ID, plain decimal digits.');
const loanId = () => idParam('id', 'Loan ID, plain decimal digits.');
const transferId = () => idParam('id', 'ID of either linked entry of the transfer, plain decimal digits.');
const subscriptionId = () => idParam('id', 'Subscription ID, plain decimal digits.');
const categoryKey = (/** @type {string} */ name = 'key') => stringPathParam(name, 'Category key');
const subKey = () => stringPathParam('subKey', 'Subcategory key');
const planKey = () => stringPathParam('category', 'Expense category key or __savings__');

const ENTRY_NOT_FOUND = apiError('The entry does not exist or is not visible to the caller.');
const NO_RIGHT = apiError('The caller may not change this record (personal budget mode, no admin bypass).');
const LOAN_NOT_FOUND = apiError('The loan does not exist or is not visible to the caller.');
const TRANSFER_NOT_FOUND = apiError('The transfer does not exist, or the entry is no transfer.');
const ACCOUNT_NOT_FOUND = apiError('The account does not exist for the caller.');
const CATEGORY_GONE = apiError('The category or subcategory does not exist.');
const NAME_TAKEN = apiError('The name is already taken, or the record is still in use.');
const SUBSCRIPTION_GONE_ANSWER = apiError('The subscription, category or payment method does not exist.');
const KEEP_RULE = 'Every field is optional: a field left out keeps its stored value.';

// --- request bodies --------------------------------------------------------

const ACCOUNT_FIELDS = {
  name: TEXT,
  type: { type: 'string', enum: [...ACCOUNT_TYPE_KEYS] },
  starting_balance: AMOUNT,
  currency: { type: ['string', 'null'], description: 'A supported ISO 4217 code; empty or `null` for the budget currency.' },
  color: { type: ['string', 'null'], description: '`#RRGGBB` or a chart token `var(--chart-series-N)`; `null` or empty clears it.' },
  credit_bank: TEXT_OR_NULL,
  credit_limit: AMOUNT_OR_NULL,
};

const ENTRY_FIELDS = {
  title: TEXT,
  amount: AMOUNT,
  category: KEY_OR_NULL,
  subcategory: KEY_OR_NULL,
  date: DAY,
  recurrence_rule: TEXT_OR_NULL,
  recurrence_interval: { type: 'string', enum: [...RECURRENCE_INTERVAL_KEYS] },
  recurrence_interval_count: NUMBER,
  is_recurring: FLAG,
  recurrence_virtual: FLAG,
  recurrence_confirm: FLAG,
  end_date: { type: ['string', 'null'], description: 'Recurring entries only: the last date (YYYY-MM-DD) the series may generate an occurrence; checked by the route, not this pattern, because an empty string also clears it. `null` or empty clears it.' },
  account_id: { ...ROW_ID_OR_NULL, description: '`null` books the entry without an account.' },
  responsible_user_ids: { ...ROW_IDS, maxItems: MAX_MEMBER_IDS, description: 'Household members responsible for the entry.' },
  visibility: ENTRY_VISIBILITY,
  attachment_document_ids: { ...ROW_IDS, maxItems: MAX_ATTACHMENTS, description: 'Receipts from the documents module.' },
};
// Datum und Belege gehoeren der einzelnen Buchung, nicht der Serie.
const { date: _date, attachment_document_ids: _receipts, ...SERIES_BASE } = ENTRY_FIELDS;
const SERIES_FIELDS = {
  ...SERIES_BASE,
  start_date: { ...DAY, description: 'Moves the start day of the series.' },
};

// Kein Typ: der Handler prueft jede Eingabe selbst und sagt `loan_due_day_invalid`
// (auch fuer `true`, `[27]` oder ein Objekt), eine Ziffernfolge eines
// Formularfelds (`"27"`) gilt (test:budget-loan-due-day).
const DUE_DAY = {
  description: 'A whole number from 1 to 31 (also as its digits); `null` or an empty string for none. Anything else is the route\'s 400 with `reason: loan_due_day_invalid`.',
};
/** A count of a form field: a number, or `''` for a field left empty. */
const FORM_COUNT = { anyOf: [{ type: 'number' }, { type: 'string', enum: [''] }] };
const LOAN_TERMS = {
  interest_mode: { type: 'string', enum: [...INTEREST_MODES] },
  principal: AMOUNT,
  fixed_rate: NUMBER,
  initial_repayment_rate: NUMBER,
  fixed_period_months: NUMBER,
  followup_rate: NUMBER,
};
const LOAN_FIELDS = {
  title: TEXT,
  borrower: TEXT,
  start_month: MONTH,
  notes: TEXT,
  ...LOAN_TERMS,
  total_amount: AMOUNT,
  installment_count: NUMBER,
  paid_installments: { ...FORM_COUNT, description: 'Installments already paid before the loan was recorded; `\'\'` for none.' },
  currency: TEXT,
  exchange_rate: NUMBER,
  direction: { type: 'string', enum: [...LOAN_DIRECTIONS] },
  account_id: ROW_ID_OR_NULL,
  due_day: DUE_DAY,
  visibility: OBJECT_VISIBILITY,
};

const TRANSFER_FIELDS = {
  title: TEXT,
  amount: AMOUNT,
  date: DAY,
  from_account_id: ROW_ID,
  to_account_id: ROW_ID,
  category: KEY,
  subcategory: KEY_OR_NULL,
  recurrence_interval: { type: 'string', enum: [...RECURRENCE_INTERVAL_KEYS] },
  recurrence_interval_count: NUMBER,
  is_recurring: FLAG,
  recurrence_confirm: FLAG,
  visibility: ENTRY_VISIBILITY,
};

const SUBSCRIPTION_FIELDS = {
  name: TEXT,
  description: TEXT_OR_NULL,
  amount: AMOUNT_OR_NULL,
  currency: TEXT,
  billing_cycle: { type: 'string', enum: [...BILLING_CYCLES] },
  cycle_interval: NUMBER,
  next_payment_date: DAY,
  reminder_days: NUMBER,
  reminder_enabled: { type: 'boolean' },
  enabled: { type: 'boolean' },
  category_id: ROW_ID_OR_NULL,
  payment_method_id: ROW_ID_OR_NULL,
  website_url: TEXT_OR_NULL,
  brand_color: TEXT_OR_NULL,
  logo_data: TEXT_OR_NULL,
  notes: TEXT_OR_NULL,
  account_username: TEXT_OR_NULL,
  end_type: { type: 'string', enum: [...END_TYPES] },
  end_date: DAY_OR_NULL,
  occurrence_count: { type: ['number', 'null'] },
  account_id: ROW_ID_OR_NULL,
  visibility: OBJECT_VISIBILITY,
};

const NAME_BODY = body({ name: TEXT });
const ORDER_KEYS = { type: 'array', minItems: 1, maxItems: MAX_ORDER_ROWS, items: KEY, description: 'The keys in their new order. An unknown key changes nothing.' };
const META_ORDER_IDS = { type: 'array', maxItems: MAX_ORDER_ROWS, items: ROW_ID, description: 'Row ids in their new order.' };

export function budgetPaths() {
  return withCaseReasons('budget', CASE_REASONS, {
    '/api/v1/budget/transfers': {
      post: op({
        summary: 'Transfer money between two budget accounts', tag: 'Budget', stateChanging: true,
        requestBody: body(TRANSFER_FIELDS, { description: 'Required: title, positive amount matching the account currency precision (no silent rounding), date (YYYY-MM-DD), from_account_id and to_account_id (two different active accounts). Optional: outgoing expense category and subcategory (Financials / Savings when present, otherwise the first remaining expense category and its default subcategory), visibility, is_recurring, recurrence_interval, recurrence_interval_count and recurrence_confirm. Virtual recurrence and recurrence_rule are not supported; transfer_entry_id is read-only.' }),
        description: 'Creates linked outgoing and incoming entries atomically. New transfers and account changes require active accounts (400 transfer_account_archived); existing bookings on archived accounts remain editable. Both accounts must have the same effective currency (account currency or household currency); currency exchange is not supported. This also applies when changing accounts through transfer, generic entry or series updates: a mismatch returns 400 with reason transfer_currency_mismatch. Existing bookings remain editable after account or household currency changes when their account assignments stay the same. Returns the outgoing entry in data, including from_account_id, to_account_id and transfer_entry_id. Transfers affect account balances but are excluded from income and expense totals.',
        responses: answers({
          201: { description: 'Transfer created' },
          400: { description: 'A body outside the schema: reason validation. Different effective account currencies: transfer_currency_mismatch. Archived account assignment: transfer_account_archived. Off-grid amount: entry_amount_invalid. Other invalid transfer fields: transfer_invalid.' },
        }),
      }),
    },
    '/api/v1/budget/transfers/{id}': {
      get: op({ summary: 'Get a transfer by either linked entry ID', tag: 'Budget', params: [transferId()], description: 'Returns the outgoing entry in data with from_account_id and to_account_id. For recurring transfers, series holds the current outgoing definition, both current account IDs, its start date, recurrence interval/count and confirmation flag, including when reading a generated occurrence. Requires edit permission for both linked entries; otherwise returns 403. An unknown or non-transfer entry returns 404.', responses: answers({ ...OK, 403: NO_RIGHT, 404: TRANSFER_NOT_FOUND }) }),
      put: op({ summary: 'Update both entries of a transfer', tag: 'Budget', params: [transferId()], stateChanging: true, requestBody: body(TRANSFER_FIELDS, { description: 'Transfer fields as for POST /budget/transfers; omitted fields retain their stored values.' }), description: 'Updates both linked entries atomically. Requires edit permission for both. Changing recurrence fields here returns 400 with reason transfer_series_required; use the series endpoint. Invalid fields return 400 with reason transfer_invalid; an unknown transfer returns 404. A body outside the schema is a 400 with reason validation before the transfer is looked up.', responses: answers({ ...OK, 403: NO_RIGHT, 404: TRANSFER_NOT_FOUND }) }),
    },
    '/api/v1/budget/transfers/{id}/series': {
      put: op({ summary: 'Update a recurring transfer series', tag: 'Budget', params: [transferId()], stateChanging: true, requestBody: body(TRANSFER_FIELDS, { description: 'Transfer fields as for POST /budget/transfers; date is the series start date. Omitted fields retain their current series values from both linked definitions, including the destination account.' }), description: 'Updates both series definitions and their future bookings atomically, preserving past bookings when the schedule changes. Visibility applies to the entire series, including its past. Requires edit permission for both linked entries. Returns the outgoing anchor in data. Returns 400 for a non-recurring transfer, invalid fields, an invalid start date, or is_recurring set to false; delete the series to end it. An unknown transfer returns 404. A body outside the schema is a 400 with reason validation before the transfer is looked up.', responses: answers({ ...OK, 403: NO_RIGHT, 404: TRANSFER_NOT_FOUND }) }),
    },
    '/api/v1/budget/summary': { get: op({ summary: 'Get budget summary', tag: 'Budget', description: '`byCategory` uses the reserved `__saving__` bucket for Financials / Savings; pass it as the entry-list category filter to drill down without colliding with a household category named `saving`. `transfers` is the sum of booked transfer outflows for the month, regardless of category; linked transfers are excluded from income, expenses and balance. With `account_id`, `transfers_in` is the sum of booked transfers arriving on that account; it is absent without the filter, where both halves of a transfer cancel out. `pending` (`count`, `income`, `expenses`) reports what is expected and in no total: expected bookings and the subscription payments projected for the month (see `GET /api/v1/budget`). `pending.expected_omitted: true` appears only when the projection hit its limit of 5000 lines; the figures then contain no subscription payment.', params: [
      MONTH_QUERY('the household\'s current month'),
      query('account_id', ROW_ID, 'Only entries booked to this account, the same filter as `GET /api/v1/budget`: income, expenses, balance, `byCategory` and `pending` all count that account alone, and no projected subscription payment is included because it is not booked to any account. A positive whole number; anything else is refused with 400.'),
      SCOPE,
    ], responses: answers(OK) }) },
    '/api/v1/budget/plans': {
      get: op({ summary: 'Get planned budget vs. actual for a month (category caps + savings goal)', tag: 'Budget', description: 'In personal budget mode the actual figures count what you can see, like the summary: `scope` (`mine`|`household`, default `mine`) picks the view, private entries of others do not count, and the amount of an entry of someone else whose details are hidden (`shared_amount`) counts only toward income and balance of the savings goal, never toward a category. Shared mode counts every entry.', params: [MONTH_QUERY('the current month'), SCOPE], responses: answers(OK) }),
    },
    '/api/v1/budget/plans/{category}': {
      put: op({ summary: 'Set planned monthly amount for a category or the savings goal (__savings__)', tag: 'Budget', params: [planKey()], stateChanging: true, requestBody: body({ amount: AMOUNT }), description: 'Body: { amount }, greater than zero. An unknown expense category is refused with 400.', responses: answers(OK) }),
      delete: op({ summary: 'Remove a category budget or the savings goal', tag: 'Budget', params: [planKey()], stateChanging: true, responses: answers(OK) }),
    },
    '/api/v1/budget/export': { get: op({ summary: 'Export budget entries as CSV', tag: 'Budget', description: 'Expected bookings and projected subscription payments are included with `Expected` in the `Status` column. Subscription payments are projected for at most 366 days from the later of `from` and the first day of the household\'s current month; a wider range sets the response header `X-Budget-Expected-Until` (`YYYY-MM-DD`, last projected day). `X-Budget-Expected-Omitted: true` is set when the projection hit its limit of 5000 lines and the file contains none.', params: [
      MONTH_QUERY('the current month; ignored when both `from` and `to` are given'),
      query('from', DAY, 'First day `YYYY-MM-DD` of a range; used together with `to`.'),
      query('to', DAY, 'Last day `YYYY-MM-DD` of a range; used together with `from`.'),
      SCOPE,
    ], responses: answers({ 200: { description: 'The entries as CSV with a byte order mark', content: { 'text/csv': { schema: { type: 'string' } } } } }) }) },
    '/api/v1/budget/meta': { get: op({ summary: 'Get budget categories and subcategories', tag: 'Budget' }) },
    '/api/v1/budget/categories': {
      get: op({ summary: 'List budget categories', tag: 'Budget', params: [langParam({ fallback: 'household' })], responses: answers(OK) }),
      post: op({ summary: 'Create budget category', tag: 'Budget', stateChanging: true, requestBody: body({ name: TEXT, type: { type: 'string', enum: [...CATEGORY_TYPES] } }), responses: answers({ ...CREATED, 409: NAME_TAKEN }) }),
    },
    '/api/v1/budget/categories/reorder': {
      patch: op({ summary: 'Reorder budget categories', tag: 'Budget', stateChanging: true, requestBody: body({ order: ORDER_KEYS, type: { type: 'string', enum: [...CATEGORY_TYPES] } }, { required: ['order'] }), description: 'Body: { order, type? } - the category keys of one type (`expense` when left out) in their new order.', responses: answers(OK) }),
    },
    '/api/v1/budget/categories/{key}': {
      put: op({ summary: 'Rename budget category', tag: 'Budget', params: [categoryKey()], stateChanging: true, requestBody: NAME_BODY, responses: answers({ ...OK, 404: CATEGORY_GONE, 409: NAME_TAKEN }) }),
      delete: op({ summary: 'Delete budget category', tag: 'Budget', params: [categoryKey()], stateChanging: true, responses: answers({ ...NO_CONTENT, 404: CATEGORY_GONE, 409: NAME_TAKEN }) }),
    },
    '/api/v1/budget/categories/{categoryKey}/subcategories': {
      get: op({ summary: 'List subcategories for a budget category', tag: 'Budget', params: [categoryKey('categoryKey'), langParam({ fallback: 'household' })], responses: answers({ ...OK, 404: CATEGORY_GONE }) }),
      post: op({ summary: 'Create budget subcategory', tag: 'Budget', params: [categoryKey('categoryKey')], stateChanging: true, requestBody: NAME_BODY, responses: answers({ ...CREATED, 404: CATEGORY_GONE, 409: NAME_TAKEN }) }),
    },
    '/api/v1/budget/categories/{key}/subcategories/reorder': {
      patch: op({ summary: 'Reorder budget subcategories', tag: 'Budget', params: [categoryKey()], stateChanging: true, requestBody: body({ order: ORDER_KEYS }, { required: ['order'] }), description: 'Body: { order } - the subcategory keys of the category in their new order.', responses: answers(OK) }),
    },
    '/api/v1/budget/categories/{key}/subcategories/{subKey}': {
      put: op({ summary: 'Rename budget subcategory', tag: 'Budget', params: [categoryKey(), subKey()], stateChanging: true, requestBody: NAME_BODY, responses: answers({ ...OK, 404: CATEGORY_GONE, 409: NAME_TAKEN }) }),
      delete: op({ summary: 'Delete budget subcategory', tag: 'Budget', params: [categoryKey(), subKey()], stateChanging: true, responses: answers({ ...NO_CONTENT, 404: CATEGORY_GONE, 409: NAME_TAKEN }) }),
    },
    '/api/v1/budget/accounts': {
      get: op({ summary: 'List accounts with starting and running balance, net worth, and available limit on credit cards', tag: 'Budget', description: 'Balances and amounts of an account are in its `currency` (the budget currency when `null`). `net_worth` adds the active accounts in the budget currency. When some are in another currency it is converted with the cached exchange rates: then `net_worth_approx: true`, `net_worth_rates_at` (the oldest rate used) and `net_worth_by_currency` (`[{ currency, amount }]`) are added. When a rate is missing, `net_worth` is `null` and only `net_worth_by_currency` is given.', params: [
        query('include_archived', { type: 'string', enum: ['1', 'true', '0', 'false'] }, '`1` or `true` lists archived accounts too; without it only active ones.'),
      ], responses: answers(OK) }),
      post: op({ summary: 'Create account (name, type, starting balance; credit cards also take credit_bank and credit_limit)', tag: 'Budget', stateChanging: true, requestBody: body(ACCOUNT_FIELDS), description: '`currency` is one of the supported ISO 4217 codes (case is ignored) or empty/`null` for the budget currency; anything else is refused with 400 and `reason: account_currency_invalid`.', responses: answers(CREATED) }),
    },
    '/api/v1/budget/accounts/{id}': {
      put: op({ summary: 'Update account (credit cards also take credit_bank and credit_limit)', tag: 'Budget', params: [accountId()], stateChanging: true, requestBody: body({ ...ACCOUNT_FIELDS, archived: { type: 'boolean' } }), description: `\`currency\` is one of the supported ISO 4217 codes (case is ignored) or empty/\`null\` for the budget currency; anything else is refused with 400 and \`reason: account_currency_invalid\`. An unchanged stored code is accepted as sent. ${KEEP_RULE}`, responses: answers({ ...OK, 404: ACCOUNT_NOT_FOUND }) }),
      delete: op({ summary: 'Delete account without linked transfers (ordinary entries are kept, account_id cleared)', tag: 'Budget', description: 'Returns 409 with reason account_has_transfers while linked transfers reference this account. Entries the caller cannot see (private entries of other members in personal mode) keep the account: it then stays for them as an archived account, while the caller gets the same 204 and no longer sees it. Archive it with PUT instead.', params: [accountId()], stateChanging: true, responses: answers({ ...NO_CONTENT, 404: ACCOUNT_NOT_FOUND, 409: apiError('The account has linked transfers.') }) }),
    },
    '/api/v1/budget/loans': {
      get: op({ summary: 'List loans and repayment summary', tag: 'Budget', description: 'Each loan carries `due_day` (1 to 31, or `null`), `next_due_month` (`YYYY-MM`) and `next_due_date` (`YYYY-MM-DD`): the due day in the month the next installment is due, clamped to the last day of a shorter month. For a loan without a due day, `next_due_date` is the 1st of `next_due_month` when that month lies before the household\'s current month (a booking date, not a due date), and `null` for an installment due in the current or a later month. Both are `null` once the loan is settled. `projected_end_month` (`YYYY-MM`) is the month of the last installment: the remaining installments counted from the later of `next_due_month` and the household\'s current month, following the payments actually booked for a loan with interest; `null` once settled and for a loan whose installment does not cover its interest. A loan with interest carries `interest.current_rate`, the rate that applies today: that of the installment due in the household\'s current month, at least the next unrecorded one (the fixed rate during the fixed-rate period, the follow-up rate after it). `summary.by_direction.borrowed` and `summary.by_direction.lent` carry the summary figures per direction (`count`, `active_count`, `has_interest`, `total_amount`, `paid_amount`, `remaining_amount`, `remaining_principal`, `remaining_installments`): a borrowed balance is owed by the household, a lent one is owed to it. The top-level figures add both directions.' }),
      post: op({ summary: 'Create loan', tag: 'Budget', stateChanging: true, requestBody: body(LOAN_FIELDS), description: 'Optional `due_day`: a whole number from 1 to 31, the day of the month an installment is due; `null`, an empty string or leaving it out means none. Anything else is refused with 400 and `reason: loan_due_day_invalid`. With a due day, the installments recorded through `paid_installments` are dated on that day instead of the 1st. The response carries `due_day`, `next_due_month` and `next_due_date`. `interest_mode` left out is a loan without interest (`none`); an unknown mode is refused with 400.', responses: answers(CREATED) }),
    },
    '/api/v1/budget/loans/{id}': {
      put: op({ summary: 'Update loan', tag: 'Budget', params: [loanId()], stateChanging: true, requestBody: body(LOAN_FIELDS), description: `Optional \`due_day\`: a whole number from 1 to 31, or \`null\` to remove it; leaving the field out keeps the stored day. Anything else is refused with 400 and \`reason: loan_due_day_invalid\`. Changing the day never moves installments that are already recorded. The response carries \`due_day\`, \`next_due_month\` and \`next_due_date\`. ${KEEP_RULE} With \`interest_mode\` the terms of that mode are required again. A body outside the schema is a 400 with reason validation before the loan is looked up.`, responses: answers({ ...OK, 403: NO_RIGHT, 404: LOAN_NOT_FOUND }) }),
      delete: op({ summary: 'Delete loan and linked repayment entries', tag: 'Budget', params: [loanId()], stateChanging: true, responses: answers({ ...NO_CONTENT, 403: NO_RIGHT, 404: LOAN_NOT_FOUND }) }),
    },
    '/api/v1/budget/loans/preview': {
      post: op({ summary: 'Preview a loan without saving it', tag: 'Budget', stateChanging: true, requestBody: body(LOAN_TERMS), description: 'Computes the monthly instalment, term, total interest and remaining debt for the values in the dialog, without writing anything. The server stays the single source of the interest maths - duplicating the formula in the client would give two answers that drift. Terms that do not add up are answered with 200 and `{ ok: false, reason }`; only a body outside the schema is a 400.', responses: answers(OK) }),
    },
    '/api/v1/budget/loans/{id}/payments': {
      post: op({ summary: 'Record loan repayment', tag: 'Budget', params: [loanId()], stateChanging: true, requestBody: body({ installment_number: NUMBER, amount: AMOUNT, paid_date: DAY }), description: '`paid_date` (`YYYY-MM-DD`) is required and stored as sent, on the installment and on its budget entry. To date an installment the way the loan card does, send the loan\'s `next_due_date`: the due day, or for a loan without one the 1st of a due month that is already over. It is `null` for a loan without a due day whose next installment is due in the current or a later month; send the household\'s today then. The budget entry is in the currency of the loan\'s account, or the budget currency without one: the same currency as the loan books unconverted, the budget currency uses the loan\'s fixed `exchange_rate`, any other goes through that rate and the cached exchange rate to the account currency. Without a cached rate the payment is refused with 409 and `reason: loan_payment_rate_unavailable`. A body outside the schema is a 400 with reason validation before the loan is looked up.', responses: answers({ ...CREATED, 403: NO_RIGHT, 404: LOAN_NOT_FOUND }) }),
    },
    '/api/v1/budget/loans/{id}/payments/{paymentId}': {
      delete: op({ summary: 'Delete loan repayment', tag: 'Budget', params: [loanId(), idParam('paymentId', 'Loan payment ID, plain decimal digits.')], stateChanging: true, responses: answers({ ...NO_CONTENT, 403: NO_RIGHT, 404: apiError('The loan or the payment does not exist.') }) }),
    },
    '/api/v1/budget': {
      get: op({
        summary: 'List budget entries',
        tag: 'Budget',
        description: `Each entry carries \`attachments\`. ${DOCUMENT_LINKS_READ_NOTE} With \`month\`, the list also carries the subscription payments that follow a subscription's booked entry, worked out from its cycle when the month is read and not stored: \`expected: true\`, \`id: null\`, \`subscription_id\`, \`is_pending: 1\`. They are in no total, cannot be changed, confirmed or deleted through this API, and are left out with \`loan_id\`, \`account_id\` and \`q\`. Months before the household's current month carry none. In personal budget mode they reach only a viewer who sees both the booked entry with its purpose and the subscription; they are never returned masked. \`meta.expected_omitted: true\` appears only when the projection hit its limit of 5000 lines; the list then carries none.`,
        params: [{
          name: 'scope',
          in: 'query',
          required: false,
          description: "View filter when the household runs in personal budget mode (preference `budget_mode=personal`): `mine` shows entries you own, `household` shows the shared pot. Ignored in shared mode. Entries also carry `owner_id` and `visibility` (`private`|`shared`|`shared_amount`); private entries are only visible to their owner (no admin bypass), and on a `shared_amount` entry of someone else only amount, date and account remain (`details_hidden: true`). Each entry carries `attachments`: linked documents from the documents module, filtered by document visibility.",
          schema: { type: 'string', enum: [...BUDGET_SCOPES], default: 'mine' },
        }, {
          name: 'category',
          in: 'query',
          required: false,
          description: 'Only entries of this category key; an unknown key is ignored. The filter sees the same view as the response: in personal budget mode an entry of someone else whose details are hidden from you (`shared_amount`) carries the category `__private__` and matches only that key, like the catch-all bucket in the summary and statistics.',
          schema: { type: 'string' },
        }, {
          name: 'q',
          in: 'query',
          required: false,
          description: 'Search the ledger instead of listing one month: matches the entry title across all months, inside words, ignoring case and accents (`muller` finds `Müller`). `month` and `category` are ignored; `account_id` and `scope` still apply. Newest first, at most 200 hits; `meta.truncated` says whether more matched. An entry whose details are hidden from you (`shared_amount` of someone else) is never a hit. 1-100 characters, otherwise 400.',
          schema: { type: 'string', minLength: 1, maxLength: 100 },
        },
        MONTH_QUERY('the household\'s current month'),
        ACCOUNT_QUERY,
        query('loan_id', ROW_ID, 'The repayment entries of this loan instead of a month; wins over `q` and `month`.'),
        ],
        responses: answers(OK),
      }),
      post: op({ summary: 'Create budget entry (optional `visibility`: private|shared|shared_amount; owner is the creator; optional `attachment_document_ids`: receipts from the documents module)', tag: 'Budget', description: DOCUMENT_LINKS_READ_NOTE, stateChanging: true, documentDeleteConflict: true, documentLinkRefusal: true, requestBody: body(ENTRY_FIELDS), responses: answers(CREATED) }),
    },
    '/api/v1/budget/{id}': {
      put: op({ summary: 'Update budget entry (`attachment_document_ids` replaces the receipt links; omit the field to leave them untouched)', tag: 'Budget', params: [entryId()], description: `${DOCUMENT_LINKS_READ_NOTE} On the first entry of a running series, a changed rhythm (\`recurrence_interval\`, \`recurrence_interval_count\`, \`recurrence_virtual\`, \`recurrence_rule\`) applies to the whole series: missing past occurrences are created on the old grid, occurrences from today on are rebuilt, and none is generated before today on the new grid. The entry's \`date\` is that booking's date only; the series keeps its start day. An amount is in the currency of the entry's account (the budget currency without one); changing the amount of a loan repayment converts it back to the loan currency the same way the repayment was booked, and is refused with 409 and \`reason: loan_payment_rate_unavailable\` when no rate is known. ${KEEP_RULE} A body outside the schema is a 400 with reason validation before the entry is looked up.`, stateChanging: true, documentDeleteConflict: true, documentLinkRefusal: true, requestBody: body(ENTRY_FIELDS), responses: answers({ ...OK, 403: NO_RIGHT, 404: ENTRY_NOT_FOUND }) }),
      delete: op({ summary: 'Delete budget entry', tag: 'Budget', params: [entryId()], stateChanging: true, responses: answers({ ...NO_CONTENT, 403: NO_RIGHT, 404: ENTRY_NOT_FOUND }) }),
    },
    '/api/v1/budget/{id}/confirm': {
      patch: op({ summary: 'Confirm a booked entry, correcting amount and date', tag: 'Budget', params: [entryId()], stateChanging: true, requestBody: body({ amount: AMOUNT, date: DAY }, { optional: true, description: 'Optional JSON body { amount?, date? }; without a body the entry is confirmed as it is.' }), description: 'Body: { amount?, date? }, both optional. Amount and date are editable here precisely because their deviation is the occasion: services rarely debit on the day and to the cent a series predicts. A plain "confirmed" tick would have left the very discrepancy against the bank statement that this is about.', responses: answers({ ...OK, 403: NO_RIGHT, 404: ENTRY_NOT_FOUND }) }),
    },
    '/api/v1/budget/{id}/series': {
      put: op({ summary: 'Update recurring budget entry series (receipts stay with the single entry and are not part of the series)', tag: 'Budget', params: [entryId()], stateChanging: true, requestBody: body(SERIES_FIELDS), description: `Changes a series "for all future occurrences": its own definition and every entry of the series dated today or later (household time zone). Entries already booked keep their values, the first entry included - it is an ordinary entry that anchors the series. Visibility is the deliberate exception and applies to every entry of the series. The response is the anchor entry with the resulting definition as \`series\` (null once the series has ended). A series edit never ends the series: \`is_recurring: false\` is answered with 400. End a series with PUT /api/v1/budget/{id} and \`is_recurring: false\` on its first entry, or with DELETE. Addressed through a generated occurrence of a virtual series, \`amount\` is that occurrence's amount (the monthly share), and the period amount is derived from it. The start day belongs to the definition: \`start_date\` (YYYY-MM-DD) moves it and rebuilds the occurrences from today on like a rhythm change; the first entry moves along only while it lies ahead. Once it is booked, a start day in an earlier month than the first entry is answered with 400. Before a start day or rhythm change, every missing past occurrence is created on the old grid; afterwards no occurrence is generated before the day of that change. \`date\` is ignored here, it is the date of a single entry, and correcting the first entry's date with PUT /api/v1/budget/{id} leaves the start day as it is. Optional \`end_date\` (YYYY-MM-DD or null): sets the last date the series may generate an occurrence; omit to leave it unchanged, send null or empty string to clear it. The end date must not be before the start date. Occurrences after the end date that are dated today or later are deleted; booked entries before today are kept. POST /api/v1/budget also accepts \`end_date\` for new recurring entries. ${KEEP_RULE} A body outside the schema is a 400 with reason validation before the entry is looked up.`, responses: answers({ ...OK, 403: NO_RIGHT, 404: ENTRY_NOT_FOUND }) }),
      delete: op({ summary: 'Delete recurring budget entry series', tag: 'Budget', params: [entryId()], stateChanging: true, responses: answers({ ...NO_CONTENT, 403: NO_RIGHT, 404: ENTRY_NOT_FOUND }) }),
    },
    '/api/v1/budget/stats': {
      get: op({ summary: 'Get budget statistics for week, month, or year', tag: 'Budget', params: [
        query('range', { type: 'string', enum: [...STATS_RANGES] }, 'The period; `month` without it.'),
        query('anchor', DAY, 'A day `YYYY-MM-DD` inside the period; today without it.'),
        SCOPE,
      ], responses: answers(OK) }),
    },
    '/api/v1/budget/subscriptions': {
      get: op({ summary: 'List subscriptions with normalized costs and analytics', tag: 'Budget', description: 'The `by_category` and `by_payment_method` breakdowns group by ROW, not by display text: each entry is `{ id, name, label_key, amount }`. `id` is `null` for the catch-all bucket of subscriptions without a category or payment method, and `name`/`label_key` are then `null` too - the caller supplies the wording. A seeded row carries `label_key` (an i18n key such as `subscriptions.paymentMethodCreditCard`) and a `name` of its original English wording; a row the household created or renamed carries only `name`. Resolve as `label_key ? t(label_key) : name`. Subscription objects include boolean `reminder_enabled` (default true). When false, no payment reminder is scheduled, including after edits and renewals; subscription status and costs are unaffected. `reminder_days: 0` still means a reminder on the payment date when enabled. Subscription objects carry the same pair denormalized as `category_label_key` / `category_name` and `payment_method_label_key` / `payment_method_name`. `account_id` is the budget account every booking of the subscription goes to (null: none), with `account_name`; `account_archived: true` means that account is archived and the subscription books without an account until another one is chosen.', params: [
        query('status', { type: 'string', enum: [...SUBSCRIPTION_STATUSES] }, 'Only `active`, `paused` or `completed` subscriptions; without it all.'),
        query('enabled', { type: 'string', enum: ['true', 'false'] }, 'The older filter on the switch alone; ignored with `status`.'),
        query('category_id', ROW_ID, 'Only subscriptions of this category.'),
        query('payment_method_id', ROW_ID, 'Only subscriptions with this payment method.'),
        query('q', { type: 'string' }, 'Matches name, description and notes; the first 100 characters count.'),
        query('refresh_rates', { type: 'string', enum: ['true', 'false'] }, '`true` fetches an outdated exchange rate before converting.'),
      ], responses: answers(OK) }),
      post: op({ summary: 'Create subscription', description: 'Optional boolean `reminder_enabled` defaults to true. Set false to create an active subscription without a payment reminder. `reminder_days` remains a lead time of 0-365 days; zero means the payment date. Optional `visibility` (`private`|`shared`; default `private` in the personal budget mode, `shared` otherwise; the owner is the creator) and `account_id` (a budget account, null for none): the booking of the next payment inherits both. A booking on an archived account goes without an account. The booking is in the account\'s currency (the budget currency without one), converted with the cached exchange rate. An account that does not exist is 400 with `reason: "subscriptions_account_not_found"`.', tag: 'Budget', stateChanging: true, requestBody: body(SUBSCRIPTION_FIELDS, { required: ['billing_cycle'] }), responses: answers({ ...CREATED, 404: SUBSCRIPTION_GONE_ANSWER }) }),
    },
    '/api/v1/budget/subscriptions/meta': {
      get: op({ summary: 'Get subscription categories, payment methods, and billing cycles', tag: 'Budget', description: 'Categories and payment methods each carry `label_key` (an i18n key) when they are one of the seeded defaults and `null` once the household renamed them - resolve as `label_key ? t(label_key) : name`. Also `budget_mode` (`shared`|`personal`; a subscription visibility only applies in `personal`) and `accounts`: the budget accounts to choose from as `{ id, name, archived }`.' }),
    },
    '/api/v1/budget/subscriptions/settings': {
      get: op({ summary: 'Get subscription budget and base currency', tag: 'Budget' }),
      put: op({ summary: 'Update subscription budget and base currency', tag: 'Budget', stateChanging: true, requestBody: body({ monthly_budget: AMOUNT, base_currency: TEXT }), description: 'Body: { monthly_budget, base_currency }, both required.', responses: answers(OK) }),
    },
    '/api/v1/budget/subscriptions/categories': {
      post: op({ summary: 'Create subscription category', tag: 'Budget', stateChanging: true, requestBody: body({ name: TEXT, color: HEX_COLOR }), responses: answers({ ...CREATED, 409: NAME_TAKEN }) }),
    },
    '/api/v1/budget/subscriptions/categories/{id}': {
      put: op({ summary: 'Rename a subscription category', tag: 'Budget', params: [idParam('id', 'Category ID, plain decimal digits.')], stateChanging: true, requestBody: body({ name: TEXT, color: HEX_COLOR }), description: 'Renaming clears `label_key`: the given name applies from then on instead of the translated default. `color` left out or `null` keeps the stored one.', responses: answers({ ...OK, 404: SUBSCRIPTION_GONE_ANSWER, 409: NAME_TAKEN }) }),
      delete: op({ summary: 'Delete a subscription category', tag: 'Budget', params: [idParam('id', 'Category ID, plain decimal digits.')], stateChanging: true, responses: answers({ ...OK, 404: SUBSCRIPTION_GONE_ANSWER }) }),
    },
    '/api/v1/budget/subscriptions/payment-methods': {
      post: op({ summary: 'Create subscription payment method', tag: 'Budget', stateChanging: true, requestBody: NAME_BODY, responses: answers({ ...CREATED, 409: NAME_TAKEN }) }),
    },
    '/api/v1/budget/subscriptions/payment-methods/{id}': {
      put: op({ summary: 'Rename a subscription payment method', tag: 'Budget', params: [idParam('id', 'Payment method ID, plain decimal digits.')], stateChanging: true, requestBody: NAME_BODY, description: 'Renaming clears `label_key`: the given name applies from then on instead of the translated default.', responses: answers({ ...OK, 404: SUBSCRIPTION_GONE_ANSWER, 409: NAME_TAKEN }) }),
      delete: op({ summary: 'Delete a subscription payment method', tag: 'Budget', params: [idParam('id', 'Payment method ID, plain decimal digits.')], stateChanging: true, responses: answers({ ...OK, 404: SUBSCRIPTION_GONE_ANSWER }) }),
    },
    '/api/v1/budget/subscriptions/meta/order': {
      put: op({ summary: 'Reorder subscription categories and payment methods', tag: 'Budget', stateChanging: true, requestBody: body({ categories: META_ORDER_IDS, payment_methods: META_ORDER_IDS }, { anyOf: [
        { properties: { categories: META_ORDER_IDS }, required: ['categories'] },
        { properties: { payment_methods: META_ORDER_IDS }, required: ['payment_methods'] },
      ] }), description: 'Body: { categories?, payment_methods? } - at least one of the two id lists.', responses: answers(OK) }),
    },
    '/api/v1/budget/subscriptions/logo-search': {
      post: op({ summary: 'Find selectable logo options from a website URL or service name', tag: 'Budget', stateChanging: true, requestBody: body({ query: TEXT, website_url: TEXT }), description: 'Body: { query } (or the older { website_url }): a website address or a service name.', responses: answers({ ...OK, 404: apiError('No supported logo was found.'), 502: apiError('The website could not be reached.') }) }),
    },
    '/api/v1/budget/subscriptions/{id}/renew': {
      post: withValidationRefusal(op({ summary: 'Advance a subscription to its next renewal date, or complete it when its end condition is reached', description: 'Preserves `reminder_enabled`. A renewed subscription with reminders disabled has no reminder row. Besides `data` the answer carries `undo: { token }`; the state before the payment stays on the server, and POST /renew/undo with that token takes the payment back (R23).', tag: 'Budget', params: [subscriptionId()], stateChanging: true, responses: answers({ ...OK, 403: NO_RIGHT, 404: SUBSCRIPTION_GONE_ANSWER, 409: apiError('The subscription is completed.') }) })),
    },
    '/api/v1/budget/subscriptions/{id}/renew/undo': {
      post: op({ summary: 'Take a payment back (undo a renewal)', description: 'Body: { token } from the `undo` block of POST /renew. Valid for the latest payment only, for the account that paid, within 10 minutes; the bookings involved come from what the renewal recorded on the server, never from the request. Due date and payment count go back, a completion is lifted, the booking of the next payment that the renewal created is deleted, and the paid booking is the linked next-payment booking again (rewritten from the subscription). Only valid while the subscription is exactly what ONE renewal made of the recorded state; otherwise (or with an unknown, used or expired token) 409 with `reason: "subscriptions_renew_undo_stale"`. Same write rule as PUT. A body outside the schema is a 400 with reason validation before the subscription is looked up.', tag: 'Budget', params: [subscriptionId()], stateChanging: true, requestBody: body({ token: TEXT }), responses: answers({ ...OK, 403: NO_RIGHT, 404: SUBSCRIPTION_GONE_ANSWER, 409: apiError('The renewal can no longer be taken back.') }) }),
    },
    '/api/v1/budget/subscriptions/{id}': {
      put: op({ summary: 'Update subscription', description: `Optional boolean \`reminder_enabled\`: false removes the payment reminder; true schedules it using \`reminder_days\`. Omitting the field preserves its current value. Changing it does not pause the subscription or remove its budget expense. Optional \`visibility\` (\`private\`|\`shared\`; the owner stays) and \`account_id\` (null clears it); omitted, both stay. They apply to the booking of the next payment, never to payments already booked. ${KEEP_RULE} A body outside the schema is a 400 with reason validation before the subscription is looked up.`, tag: 'Budget', params: [subscriptionId()], stateChanging: true, requestBody: body(SUBSCRIPTION_FIELDS), responses: answers({ ...OK, 403: NO_RIGHT, 404: SUBSCRIPTION_GONE_ANSWER }) }),
      delete: op({ summary: 'Delete subscription', tag: 'Budget', params: [subscriptionId()], stateChanging: true, responses: answers({ ...NO_CONTENT, 403: NO_RIGHT, 404: SUBSCRIPTION_GONE_ANSWER }) }),
    },
  });
}

// #1909: die Faelle, die ein Nutzer bei den Abos erreicht, tragen einen
// `reason` neben dem englischen `error` - je Operation der Satz, der sie nennt.
const SUBSCRIPTION_GONE = '`subscriptions_subscription_not_found` (404, the subscription does not exist)';
const SELECTED_META_GONE = '`subscriptions_selected_category_not_found`, `subscriptions_selected_payment_method_not_found` (400, the chosen category or payment method does not exist), `subscriptions_account_not_found` (400, the chosen budget account does not exist)';
const SUBSCRIPTION_CHECKS = '`subscriptions_end_before_next_payment`, `subscriptions_occurrence_count_too_low`, `subscriptions_logo_content_mismatch` (400, only when it is the single finding)';
// #1909: der Kategorie-Verwalter sagt "gibt es nicht mehr" in der Sprache der Oberflaeche.
const BUDGET_CAT_GONE = '`budget_category_not_found` (404, the category does not exist - deleted)';
const BUDGET_SUB_GONE = '`budget_subcategory_not_found` (404, the subcategory does not exist - deleted)';
const CASE_REASONS = {
  // Anlegen nennt den Fall auch: wird das neue Abo geloescht, waehrend seine
  // Buchung den Kurs holt, antwortet es 404 statt eine Buchung ohne Abo zu hinterlassen.
  '/api/v1/budget/subscriptions': { post: `${SELECTED_META_GONE}, ${SUBSCRIPTION_CHECKS}, ${SUBSCRIPTION_GONE}` },
  '/api/v1/budget/subscriptions/{id}': {
    put: `${SUBSCRIPTION_GONE}, ${SELECTED_META_GONE}, ${SUBSCRIPTION_CHECKS}`,
    delete: SUBSCRIPTION_GONE,
  },
  '/api/v1/budget/subscriptions/{id}/renew': { post: `${SUBSCRIPTION_GONE}, \`subscriptions_subscription_completed\` (409, the subscription is completed; reactivate it first)` },
  '/api/v1/budget/subscriptions/{id}/renew/undo': { post: `${SUBSCRIPTION_GONE}, \`subscriptions_renew_undo_stale\` (409, somebody renewed or edited the subscription since)` },
  '/api/v1/budget/subscriptions/categories': { post: '`subscriptions_category_exists` (409)' },
  '/api/v1/budget/subscriptions/categories/{id}': {
    put: '`subscriptions_category_not_found` (404), `subscriptions_category_exists` (409)',
    delete: '`subscriptions_category_not_found` (404)',
  },
  '/api/v1/budget/subscriptions/payment-methods': { post: '`subscriptions_payment_method_exists` (409)' },
  '/api/v1/budget/subscriptions/payment-methods/{id}': {
    put: '`subscriptions_payment_method_not_found` (404), `subscriptions_payment_method_exists` (409)',
    delete: '`subscriptions_payment_method_not_found` (404)',
  },
  '/api/v1/budget/subscriptions/logo-search': { post: '`subscriptions_no_logo_found` (404, no supported logo was found)' },
  '/api/v1/budget/categories': { post: '`category_exists` (409, a category with this name already exists)' },
  '/api/v1/budget/categories/{key}': {
    put: `${BUDGET_CAT_GONE}, \`category_exists\` (409, a category with this name already exists)`,
    delete: `${BUDGET_CAT_GONE}, \`category_in_use\` (409, budget entries or split expenses and their recurring series still use the category; \`count\` carries how many), \`category_last\` (409, the last category cannot be deleted)`,
  },
  '/api/v1/budget/categories/{categoryKey}/subcategories': {
    get: BUDGET_CAT_GONE,
    post: `${BUDGET_CAT_GONE}, \`subcategory_exists\` (409, a subcategory with this name already exists)`,
  },
  '/api/v1/budget/categories/{key}/subcategories/{subKey}': {
    put: `${BUDGET_SUB_GONE}, \`subcategory_exists\` (409, a subcategory with this name already exists)`,
    delete: `${BUDGET_SUB_GONE}, \`subcategory_in_use\` (409, entries still use the subcategory; \`count\` carries how many), \`subcategory_last\` (409, the last subcategory cannot be deleted)`,
  },
};
