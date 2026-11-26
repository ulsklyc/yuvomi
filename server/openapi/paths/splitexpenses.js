import { op, idParam, DOCUMENT_LINKS_READ_NOTE, withCaseReasons, withValidationRefusal } from '../helpers.js';
import { MAX_TEXT, MAX_TITLE } from '../../api/formats.ts';
import { CURRENCY_CODES } from '../../../public/utils/currency-codes.js';
import {
  CATEGORIES, FAMILY_ROLES, FREQUENCIES, GROUP_ROLES, GROUP_STATUSES, GROUP_TYPES, MAX_CURSOR_TEXT, MAX_GUEST_EMAIL, MAX_GUEST_NAME,
  MAX_GUEST_PHONE, MISSED_MODES, SPLIT_METHODS,
} from '../../services/split-expense-fields.js';
import { MAX_ATTACHMENTS, MAX_MEMBER_IDS } from '../array-limits.js';

// Betraege im Request (#1607): eine Regel fuer Ausgabe, Genau-Anteil und Zahlung,
// durchgesetzt in parseMoneyToMinor().
const BUDGET_CATEGORY_NOTE = '`budget_category` is a key from `GET /api/v1/budget/categories` of type `expense`, or `null` for none; an unknown key answers 400. On an update an omitted `budget_category` stays as it is, and so does the key the row already carries even when that category no longer exists. A budget category that split expenses or series still use cannot be deleted. `category` is the older split-expense category and is kept as it was.';
const AMOUNT_NOTE = 'Amounts are decimal strings with a dot (`"12.50"`, not a number), with at most the currency\'s decimal places, and must be greater than zero: `0`, `-0` and negative values are answered with `400`.';
const EXACT_SPLIT_NOTE = 'With `split_method: "exact"`, every participant needs a `splits[].amount` under the same rule, and the shares must add up to the expense amount.';
const RECURRING_SPLIT_NOTE = 'The split is checked when the recurring expense is created, by the same rule as a single expense: `payer_id` and every entry of `participants` must be members of the group, `exact` amounts must add up to the amount, `percentage` values to 100, and `shares` must be positive integers. Anything else is answered with `400` and nothing is stored.';
const RECURRING_VIEW_NOTE = 'Active ones first, then by `next_run_date`. Besides its columns every recurring expense carries: `payer_name`; `participants` and `splits`, the stored split as input (what `split_snapshot` holds; a legacy snapshot that is a list of finished shares gives its people as `participants`); `blocked_reason`, why the hourly run would pause it on its next date (`split_invalid`: the stored split cannot be booked, `not_a_member`: the payer or a participant is no longer a member of the group) or null, measured against the current state with the run\'s own check; `can_edit`, whether the caller may update, delete, pause and resume it (group owner/admin or whoever created it); `failed_at`, when the hourly run first failed to book it for an unexpected reason (an ISO timestamp, or null): such a recurring expense is not paused and is retried every hour; a booking, an update or a pause for a known reason clears it; and, on a paused one, `missed_count` and `resume_date`: how many dates a resume without `missed: "book"` skips and the date it lands on (0 and null while it is active).';
const RECURRING_PAST_DATE_NOTE = 'A `next_run_date` before today can be answered with `missed` (#1748), the same choice a resume takes: `skip` stores the first date of the series that is not before today, counted from the given date in whole intervals exactly as the hourly run counts (with the `anchor_day` of the given date), so nothing is booked for the past; `book` keeps the date, and the hourly run then books every missed date, one per run, each with its original date. Without `missed` the date is kept, as before this option existed. "Today" is the day in the household time zone; a date that is today is not missed. On an update `missed` only applies when the call changes `next_run_date`. Anything other than `skip` or `book` is refused with 400 and `reason: "invalid_missed"`, and nothing is stored.';
const RECURRING_ANCHOR_NOTE = 'Every recurring expense carries `anchor_day`, the day of the month it is meant for (1-31), taken from the first `next_run_date` when it is created and again whenever an update changes `next_run_date` or `frequency`; it cannot be set directly. Monthly and yearly steps clamp to the last day of a shorter month and return to the anchor where the month has it: a series on the 31st books on 28 or 29 February and on 31 March, a yearly one from 29 February books on 28 February and on 29 February again in a leap year. Weekly series step by seven days.';

const apiError = (description) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
});

// Antwort des Stornos (#1309): die Zahlung, wie sie in `settlements` steht,
// plus wann und von wem sie storniert wurde. `reversed_at` kommt aus der
// Gegenbuchung im Ledger, `reversed_by` aus dem Verlauf (`payment_reversed`) -
// die Gegenbuchung traegt den `created_by` der Originalzeile, nicht die
// stornierende Person. Keine eigene Spalte.
const settlementReversalResponse = {
  type: 'object',
  required: ['data'],
  properties: {
    data: {
      type: 'object',
      required: ['id', 'group_id', 'payer_id', 'payee_id', 'amount_minor', 'amount', 'currency', 'created_by', 'reversed_at', 'reversed_by'],
      properties: {
        id: { type: 'integer' },
        group_id: { type: 'integer' },
        payer_id: { type: 'integer' },
        payee_id: { type: 'integer' },
        amount_minor: { type: 'integer', minimum: 1, description: 'Amount in the minor unit of `currency`.' },
        amount: { type: 'string', description: 'Decimal amount, e.g. `20.00`.' },
        currency: { type: 'string', description: 'ISO 4217 code.' },
        notes: { type: ['string', 'null'] },
        proof_document_id: { type: ['integer', 'null'], description: 'Kept as is - a reversal does not detach the payment proof. `null` in the response unless the caller may read that document (access to the Documents module, for API tokens a `documents:read` scope, and the document\'s own visibility).' },
        status: { type: 'string', enum: ['active', 'deleted'], description: 'Unchanged by a reversal.' },
        paid_at: { type: 'string', format: 'date-time' },
        created_by: { type: 'integer' },
        created_at: { type: 'string', format: 'date-time' },
        updated_at: { type: 'string', format: 'date-time' },
        reversed_at: { type: 'string', format: 'date-time' },
        reversed_by: { type: ['integer', 'null'], description: 'Who reversed the payment, from the `payment_reversed` activity; `null` when that account no longer exists. The counter-entries themselves keep the `created_by` of the rows they reverse.' },
      },
    },
  },
};

// Salden und Summen einer Gruppe (#1888, #1941). Betraege wie ueberall im
// Modul doppelt: `*_minor` in der kleinsten Einheit, daneben die Dezimalzahl.
const balancesResponse = {
  type: 'object',
  required: ['data'],
  properties: {
    data: {
      type: 'object',
      required: ['balances', 'simplified_debts', 'member_totals', 'category_totals', 'budget_category_totals'],
      properties: {
        balances: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Net balance per member and currency (`net_minor`, `net`); members at zero are left out.' },
        simplified_debts: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'The fewest payments that settle the balances, per currency.' },
        member_totals: {
          type: 'array',
          items: {
            type: 'object',
            required: ['currency', 'user_id', 'display_name', 'paid_minor', 'paid', 'share_minor', 'share'],
            properties: {
              currency: { type: 'string', description: 'ISO 4217 code, the `converted_currency` of the expenses.' },
              user_id: { type: 'integer' },
              display_name: { type: ['string', 'null'] },
              paid_minor: { type: 'integer', minimum: 0, description: 'What the member paid, in the minor unit of `currency`.' },
              paid: { type: 'string', description: 'Decimal amount, e.g. `120.00`.' },
              share_minor: { type: 'integer', minimum: 0, description: 'The member\'s own share of the expenses, in the minor unit of `currency`.' },
              share: { type: 'string', description: 'Decimal amount, e.g. `80.00`.' },
            },
          },
        },
        category_totals: {
          type: 'array',
          items: {
            type: 'object',
            required: ['category', 'currency', 'total_minor', 'total'],
            properties: {
              category: { type: 'string', description: 'One of the categories from `GET /api/v1/split-expenses/meta`.' },
              currency: { type: 'string', description: 'ISO 4217 code, the `converted_currency` of the expenses.' },
              total_minor: { type: 'integer', minimum: 1 },
              total: { type: 'string', description: 'Decimal amount, e.g. `130.00`.' },
            },
          },
        },
        budget_category_totals: {
          type: 'array',
          description: 'The same sums per budget category (`budget_category`, a key from `GET /api/v1/budget/categories` of type `expense`); `null` collects the expenses without one.',
          items: {
            type: 'object',
            required: ['budget_category', 'currency', 'total_minor', 'total'],
            properties: {
              budget_category: { type: ['string', 'null'] },
              currency: { type: 'string', description: 'ISO 4217 code, the `converted_currency` of the expenses.' },
              total_minor: { type: 'integer', minimum: 1 },
              total: { type: 'string', description: 'Decimal amount, e.g. `130.00`.' },
            },
          },
        },
      },
    },
  },
};

// Eine Seite des Verlaufs (#1309). `offset` steht nur in der Antwort ohne
// Cursor - dort, wo es auch in der Anfrage etwas bedeutet.
const activityPageResponse = {
  type: 'object',
  required: ['data', 'pagination'],
  properties: {
    data: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        properties: {
          metadata: {
            type: ['object', 'null'],
            additionalProperties: true,
            description: 'What the entry recorded when it was written - it does not follow later edits. `expense_created`, `expense_edited` and `expense_deleted` carry `title`, `amount_minor`, `amount` (decimal) and `currency` as they were at that moment; entries written before this was recorded carry the `title` only. `comment_added` carries the `title` of its expense.',
          },
        },
      },
    },
    pagination: {
      type: 'object',
      required: ['limit', 'has_more', 'next_cursor'],
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        offset: { type: 'integer', minimum: 0, description: 'Only in answers to a request without cursor.' },
        has_more: { type: 'boolean', description: 'Exact: true only when at least one older entry exists.' },
        next_cursor: {
          type: ['object', 'null'],
          required: ['before_at', 'before_id'],
          properties: {
            before_at: { type: 'string', format: 'date-time' },
            before_id: { type: 'integer' },
          },
        },
      },
    },
  },
};

// Archivierte Gruppe (#1747): jede Schreibroute der Gruppe antwortet 409 mit
// `reason: "group_archived"`, nachdem 404 und 403 geprueft sind. Eine Liste
// statt eines Textes je Operation: Archivieren, Wiederherstellen und Loeschen
// der Gruppe stehen bewusst nicht darin.
const ARCHIVED_NOTE = 'While the group is archived this is refused with `409` and `reason: "group_archived"` (checked after `404` and `403`); restore the group first.';
const ARCHIVED_REFUSAL = 'The group is archived (`reason: "group_archived"`); nothing was changed';
const ARCHIVE_REFUSING = [
  ['/api/v1/split-expenses/groups/{id}', 'patch'],
  ['/api/v1/split-expenses/groups/{id}/members', 'post'],
  ['/api/v1/split-expenses/groups/{id}/members/{userId}', 'delete'],
  ['/api/v1/split-expenses/groups/{id}/guests', 'post'],
  ['/api/v1/split-expenses/groups/{id}/expenses', 'post'],
  ['/api/v1/split-expenses/groups/{id}/settlements', 'post'],
  ['/api/v1/split-expenses/groups/{id}/settlements/{settlementId}/reverse', 'post'],
  ['/api/v1/split-expenses/groups/{id}/recurring', 'post'],
  ['/api/v1/split-expenses/expenses/{id}', 'put'],
  ['/api/v1/split-expenses/expenses/{id}', 'delete'],
  ['/api/v1/split-expenses/expenses/{id}/comments', 'post'],
  ['/api/v1/split-expenses/recurring/{id}', 'put'],
  ['/api/v1/split-expenses/recurring/{id}', 'delete'],
  ['/api/v1/split-expenses/recurring/{id}/pause', 'post'],
];

function refuseWhenArchived(paths) {
  for (const [path, method] of ARCHIVE_REFUSING) {
    const operation = paths[path][method];
    operation.description = operation.description ? `${operation.description} ${ARCHIVED_NOTE}` : ARCHIVED_NOTE;
    const known = operation.responses[409];
    operation.responses[409] = known
      ? { ...known, description: `${known.description} Or: ${ARCHIVED_REFUSAL}` }
      : apiError(ARCHIVED_REFUSAL);
  }
  return paths;
}

/**
 * The answers of an operation with its real success status (#2810).
 * @param {number} status
 * @param {string | Record<string, unknown>} success description, or the whole answer
 * @param {Record<string, unknown>} [extra]
 */
const answers = (status, success, extra = {}) => ({
  [status]: typeof success === 'string' ? { description: success } : success,
  400: { $ref: '#/components/responses/BadRequest' },
  401: { $ref: '#/components/responses/Unauthorized' },
  500: { $ref: '#/components/responses/InternalServerError' },
  ...extra,
});

/** `{ data: { ok: true } }`, the answer of a delete, an archive and a restore. */
const OK_ANSWER = {
  description: 'Done. The answer is `{ data: { ok: true } }`.',
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required: ['data'],
        properties: { data: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean', const: true } } } },
      },
    },
  },
};

/**
 * A JSON body that must be sent (`{}` sent on purpose counts as sent).
 * @param {Record<string, unknown>} schema
 */
const body = (schema) => ({
  required: true,
  description: 'JSON request body. Fields the schema does not name are ignored.',
  content: { 'application/json': { schema: { type: 'object', ...schema } } },
});

const GROUP_ID = idParam('id', 'Expense group ID, plain decimal digits.');
const EXPENSE_ID = idParam('id', 'Expense ID, plain decimal digits.');
const RECURRING_ID = idParam('id', 'Recurring expense ID, plain decimal digits.');
const MEMBER_ID = idParam('userId', 'User ID of the member, plain decimal digits.');
const SETTLEMENT_ID = idParam('settlementId', 'Settlement ID, plain decimal digits.');

// Ziffern-Text ist eine Altform (#2810): die App schickt Zahlen, aeltere
// Clients die IDs ihrer Formularfelder als Text.
const DIGIT_TEXT = { type: 'string', pattern: '^[0-9]+$' };
const LEGACY_NOTE = 'Digit text is accepted as a legacy form.';

/**
 * A person or record id in the body: a whole number, digit text as the legacy
 * form.
 * @param {string} description
 */
const bodyId = (description) => ({ anyOf: [{ type: 'integer' }, DIGIT_TEXT], description: `${description} ${LEGACY_NOTE}` });

/**
 * A value from one of the lists of the module. Unknown values are a 400;
 * until #2810 the route replaced them silently with a default.
 * @param {readonly string[]} values
 * @param {string} description
 * @param {{ nullable?: boolean }} [options]
 */
const oneOf = (values, description, { nullable = false } = {}) => (nullable
  ? { type: ['string', 'null'], enum: [...values, null], description }
  : { type: 'string', enum: [...values], description });

/** @param {string} description */
const currency = (description) => oneOf(CURRENCY_CODES, `ISO 4217 code from \`GET /api/v1/split-expenses/meta\` (\`currencies\`). ${description}`);
const TITLE = { type: 'string', maxLength: MAX_TITLE, description: `Required, at most ${MAX_TITLE} characters; empty after trimming is refused.` };
/** @param {string} what */
const noteText = (what) => ({ type: ['string', 'null'], maxLength: MAX_TEXT, description: `${what}, at most ${MAX_TEXT} characters; \`null\` or \`""\` means none.` });
const AMOUNT = { type: 'string', description: 'A decimal STRING with a dot (`"12.50"`). A number is refused.' };
const BUDGET_CATEGORY = {
  type: ['string', 'null'],
  description: 'A key from `GET /api/v1/budget/categories` of type `expense`, `null` or `""` for none. An unknown key answers 400 with `reason: "unknown_budget_category"`.',
};

/** One entry of `splits`: the person and the one value its split method reads. */
const SPLIT_ENTRY = {
  type: 'object',
  properties: {
    user_id: bodyId('The participant.'),
    amount: { type: 'string', description: 'With `exact`: the share as a decimal string.' },
    percentage: { type: 'string', description: 'With `percentage`: up to two decimals as a string (`"33.33"`); all add up to 100.' },
    shares: { type: 'integer', description: 'With `shares`: a positive whole number.' },
  },
};

/**
 * The fields of an expense on update that replace stored state when left out
 * (#2810): PUT /expenses/{id} is a full replacement, so they are required
 * there. `null` stays allowed wherever it was (`description`,
 * `converted_amount`, `exchange_snapshot`), and `expense_date: ""` stays
 * today; only the absence is refused. The fields that keep their stored value
 * when left out (`payer_id`, `participants`, `category`, `budget_category`,
 * `attachment_document_ids`) and `splits` (left out with a method that reads
 * values: a 400 of the handler, ignored with `equal`) stay optional.
 */
const EXPENSE_REPLACE_REQUIRED = ['title', 'amount', 'description', 'currency', 'converted_amount', 'converted_currency', 'exchange_snapshot', 'split_method', 'expense_date'];

/**
 * Why a field is required on update: what leaving it out did up to v2.93.
 * @param {string} what
 */
const wasReset = (what) => `Required on update (#2810); up to v2.93 leaving it out ${what}.`;

/**
 * The fields of an expense, for create and update.
 * @param {{ update?: boolean }} [options]
 */
function expenseProperties({ update = false } = {}) {
  return {
    title: TITLE,
    amount: AMOUNT,
    description: update
      ? { ...noteText('Note'), description: `Note, at most ${MAX_TEXT} characters; \`null\` or \`""\` means none. ${wasReset('cleared the stored note')}` }
      : noteText('Note'),
    currency: currency(update ? wasReset('read the amount in the converted currency of the expense') : 'Without it: the currency of the group.'),
    converted_amount: {
      type: ['string', 'null'],
      description: update
        ? `The amount in \`converted_currency\`, a decimal string; \`null\` or \`""\`: the amount. ${wasReset('replaced it with the amount')}`
        : 'The amount in `converted_currency`, a decimal string. `null`, `""` or left out: the amount.',
    },
    converted_currency: currency(update
      ? `The currency the splits and the ledger are kept in. ${wasReset('replaced it with `currency`')}`
      : 'The currency the splits and the ledger are kept in. Without it: `currency`.'),
    exchange_snapshot: {
      type: ['object', 'null'],
      description: update
        ? `An object the client wants kept with the expense (exchange rate and source); stored as sent, \`null\` for none. Any other JSON value (\`false\`, \`0\`, \`""\`, a string, a number, an array) is refused since v2.94 (#2810); up to v2.93 it was stored as sent, and \`false\`, \`0\` and \`""\` as none. ${wasReset('cleared the stored one')}`
        : 'An object the client wants kept with the expense (exchange rate and source); stored as sent. `null` or left out: none. Any other JSON value (`false`, `0`, `""`, a string, a number, an array) is refused since v2.94 (#2810); up to v2.93 it was stored as sent, and `false`, `0` and `""` as none.',
    },
    payer_id: bodyId(update ? 'Who paid; left out: the stored payer.' : 'Who paid; left out: the caller.'),
    split_method: oneOf(SPLIT_METHODS, update ? `How the amount is split. ${wasReset('split it `equal`')}` : 'How the amount is split; left out: `equal`.'),
    participants: {
      type: 'array',
      maxItems: MAX_MEMBER_IDS,
      items: bodyId('A member of the group.'),
      description: update ? 'Who shares the amount; left out: the stored participants.' : 'Who shares the amount; left out: the payer.',
    },
    splits: {
      type: 'array',
      maxItems: MAX_MEMBER_IDS,
      items: SPLIT_ENTRY,
      description: 'The value per participant for `exact`, `percentage` and `shares`; ignored with `equal`. Left out with a method that reads values: 400.',
    },
    category: update
      ? oneOf(CATEGORIES, 'The older split-expense category. Left out or `null`: the stored one.', { nullable: true })
      : oneOf(CATEGORIES, 'The older split-expense category; left out: `general`.'),
    budget_category: update ? { ...BUDGET_CATEGORY, description: `${BUDGET_CATEGORY.description} Left out: the stored one.` } : BUDGET_CATEGORY,
    expense_date: {
      type: 'string',
      description: update
        ? `\`YYYY-MM-DD\`; \`""\`: today in the household time zone. ${wasReset('moved the expense to today')}`
        : '`YYYY-MM-DD`; left out or `""`: today in the household time zone.',
    },
    attachment_document_ids: {
      type: 'array',
      maxItems: MAX_ATTACHMENTS,
      items: bodyId('A document of the Documents module.'),
      description: update
        ? 'Replaces the receipt links; `[]` removes them all. Left out: untouched. Not `null` and not a single id: until #2810 any value that was not a list removed every receipt.'
        : 'Receipts to link. Left out: none. Not `null`.',
    },
  };
}

/** `missed`: what happens to a date before today (#1748). */
const MISSED = {
  type: ['string', 'null'],
  enum: [...MISSED_MODES, null],
  'x-reason': 'invalid_missed',
  description: '`skip` or `book`; `null` or left out means no choice. Anything else is 400 with `reason: "invalid_missed"`.',
};

const RECURRING_CREATE = {
  required: ['title', 'amount', 'frequency'],
  properties: {
    title: TITLE,
    amount: AMOUNT,
    description: noteText('Note'),
    currency: currency('Without it: the currency of the group.'),
    payer_id: bodyId('Who pays; left out: the caller.'),
    split_method: oneOf(SPLIT_METHODS, 'How the amount is split; left out: `equal`.'),
    participants: { type: 'array', maxItems: MAX_MEMBER_IDS, items: bodyId('A member of the group.'), description: 'Who shares the amount; left out: the payer.' },
    splits: { type: 'array', maxItems: MAX_MEMBER_IDS, items: SPLIT_ENTRY, description: 'The value per participant for `exact`, `percentage` and `shares`.' },
    category: oneOf(CATEGORIES, 'The older split-expense category; left out: `general`.'),
    budget_category: BUDGET_CATEGORY,
    frequency: oneOf(FREQUENCIES, 'The rhythm of the series.'),
    next_run_date: { type: 'string', description: '`YYYY-MM-DD` of the first date; left out or `""`: today in the household time zone.' },
    missed: MISSED,
  },
};

const RECURRING_UPDATE = {
  properties: {
    title: { type: 'string', maxLength: MAX_TITLE, description: `At most ${MAX_TITLE} characters; empty after trimming is refused.` },
    amount: AMOUNT,
    description: noteText('Note; `null` or `""` clears it'),
    currency: currency('Without it the amount is read in the currency of the recurring expense.'),
    payer_id: bodyId('Who pays.'),
    split_method: oneOf(SPLIT_METHODS, 'How the amount is split.'),
    participants: { type: 'array', maxItems: MAX_MEMBER_IDS, items: bodyId('A member of the group.') },
    splits: { type: 'array', maxItems: MAX_MEMBER_IDS, items: SPLIT_ENTRY },
    category: oneOf(CATEGORIES, 'The older split-expense category.'),
    budget_category: BUDGET_CATEGORY,
    frequency: oneOf(FREQUENCIES, 'The rhythm of the recurring expense.'),
    next_run_date: { type: 'string', description: '`YYYY-MM-DD`.' },
    missed: MISSED,
  },
};

const GROUP_FIELDS = {
  name: { type: 'string', maxLength: MAX_TITLE, description: `At most ${MAX_TITLE} characters; empty after trimming is refused.` },
  description: noteText('Description'),
  type: oneOf(GROUP_TYPES, 'The kind of group; left out: `general` (on an update: the stored one).'),
  default_currency: currency('Left out: the household currency (on an update: the stored one).'),
  default_split_method: oneOf(SPLIT_METHODS, 'Preset for new expenses; left out: `equal` (on an update: the stored one).'),
};

/** The preset values per member (#517), read for `percentage` and `shares`. */
const DEFAULT_SPLIT_CONFIG = {
  type: ['array', 'null'],
  maxItems: MAX_MEMBER_IDS,
  description: 'Preset values per member for `percentage` and `shares`. Entries for non-members, doubles and values outside the rule of the method are dropped, not refused; an empty result, `[]` or `null` clears the preset.',
  items: {
    type: 'object',
    properties: {
      user_id: bodyId('A member of the group.'),
      percentage: { type: 'string', description: 'With `percentage`: 0 to 100, up to two decimals as a string.' },
      shares: { type: 'integer', description: 'With `shares`: a positive whole number.' },
    },
  },
};

const QUERY_NOTE = 'A doubled value or a value outside its type is 400.';
const LIMIT_QUERY = {
  name: 'limit', in: 'query', required: false, schema: { type: 'integer', default: 30 },
  description: `Page size, plain decimal digits. The route keeps it within 1 to 100 (left out or 0: 30, above 100: 100). ${QUERY_NOTE}`,
};
/** @param {string} description */
const offsetQuery = (description) => ({
  name: 'offset', in: 'query', required: false, schema: { type: 'integer', default: 0 },
  description: `${description} Plain decimal digits; a negative value counts as 0. ${QUERY_NOTE}`,
});
/** @param {string} description */
const beforeIdQuery = (description) => ({
  name: 'before_id', in: 'query', required: false, schema: { type: 'integer', minimum: 1 },
  description: `${description} Plain decimal digits. ${QUERY_NOTE}`,
});
/** @param {string} name @param {string} description */
const cursorText = (name, description) => ({ name, in: 'query', required: false, schema: { type: 'string', maxLength: MAX_CURSOR_TEXT }, description });
/** @param {string} description */
const searchQuery = (description) => ({ name: 'q', in: 'query', required: false, schema: { type: 'string' }, description: `${description} ${QUERY_NOTE}` });

const ORDER_NOTE = 'A request outside the schema (a value that is not of its type, a number or a list in a text field, a value outside its list, '
  + 'a path id that is not plain decimal digits) answers 400 with `fields` before anything is looked up, so it comes before the 404, 403 and 409 of the route.';

/**
 * @param {string} [text]
 * @returns {string}
 */
const withOrder = (text) => (text ? `${text} ${ORDER_NOTE}` : ORDER_NOTE);

/** Groups, members, guests, expenses and balances. */
function groupPaths() {
  return {
    '/api/v1/split-expenses/meta': { get: op({ summary: 'Get split expenses metadata', tag: 'SplitExpenses' }) },
    '/api/v1/split-expenses/dashboard': { get: op({ summary: 'Get split expenses dashboard summary', tag: 'SplitExpenses' }) },
    '/api/v1/split-expenses/groups': {
      get: withValidationRefusal(op({
        summary: 'List expense groups',
        tag: 'SplitExpenses',
        params: [
          { name: 'status', in: 'query', required: false, schema: { type: 'string', enum: [...GROUP_STATUSES], default: 'active' }, description: `\`archived\` lists the archived groups, \`active\` (the default) the others. ${QUERY_NOTE}` },
          searchQuery('Part of the group name.'),
        ],
      })),
      post: op({
        summary: 'Create expense group',
        tag: 'SplitExpenses',
        description: withOrder('A split-expense guest is refused with 403 before the body is read.'),
        stateChanging: true,
        requestBody: body({ required: ['name'], properties: GROUP_FIELDS }),
        responses: answers(201, 'Group created, `{ data: group }`', { 403: { $ref: '#/components/responses/Forbidden' } }),
      }),
    },
    '/api/v1/split-expenses/groups/{id}': {
      patch: op({
        summary: 'Update expense group',
        tag: 'SplitExpenses',
        description: withOrder('A partial update: every field the call omits stays as it is. `{}` changes nothing; a call without a body is 400.'),
        params: [GROUP_ID],
        stateChanging: true,
        requestBody: body({ properties: { ...GROUP_FIELDS, default_split_config: DEFAULT_SPLIT_CONFIG } }),
        responses: answers(200, 'The group after the update'),
      }),
      delete: op({ summary: 'Delete expense group', tag: 'SplitExpenses', params: [GROUP_ID], stateChanging: true, responses: answers(200, OK_ANSWER) }),
    },
    '/api/v1/split-expenses/groups/{id}/archive': {
      post: op({ summary: 'Archive expense group', tag: 'SplitExpenses', params: [GROUP_ID], stateChanging: true, responses: answers(200, OK_ANSWER) }),
    },
    '/api/v1/split-expenses/groups/{id}/unarchive': {
      post: op({ summary: 'Restore an archived expense group', tag: 'SplitExpenses', params: [GROUP_ID], stateChanging: true, responses: answers(200, OK_ANSWER) }),
    },
    '/api/v1/split-expenses/groups/{id}/members': {
      get: withValidationRefusal(op({ summary: 'List group members', tag: 'SplitExpenses', params: [GROUP_ID] })),
      post: op({
        summary: 'Add member to group',
        description: withOrder('Takes a `user_id`, or a `contact_id` that is turned into a guest user when the contact has none yet. A `contact_id` needs read access to the Contacts module (for API tokens `contacts:read`); without it, and for an unknown contact, the answer is the same 404 and nothing is created. A contact without an account is linked to the new guest and needs write access to Contacts (`contacts:write`); without it the answer is 403 and nothing is written. If that contact carries an address that already belongs to another account (split-expense guests excluded), a caller who is not an admin gets 409 with `reason: "email_in_use"` and nothing is created.'),
        tag: 'SplitExpenses',
        params: [GROUP_ID],
        stateChanging: true,
        requestBody: body({
          properties: {
            user_id: bodyId('The account to add.'),
            contact_id: bodyId('A contact to add as a guest.'),
            role: oneOf(GROUP_ROLES, 'Role in the group; left out: `guest`. `owner` is not given away: it is stored as `guest`.'),
          },
        }),
        responses: answers(201, 'Member added, `{ data: { group_id, user_id, role } }`'),
      }),
    },
    '/api/v1/split-expenses/groups/{id}/member-candidates': {
      get: withValidationRefusal(op({ summary: 'List users and contacts that can be added to a group', description: 'Phone and email come only with read access to the Contacts module, a member\'s birthday only with read access to the Calendar module (for API tokens `contacts:read` and `calendar:read`); otherwise they are null. `birth_year_unknown` (boolean) marks a birthday known by day and month only (#2095). Contacts without an account are offered as candidates only with write access to Contacts (`contacts:write`), because adding one links it to the new guest.', tag: 'SplitExpenses', params: [GROUP_ID] })),
    },
    '/api/v1/split-expenses/groups/{id}/members/{userId}': {
      delete: op({ summary: 'Remove member from group', tag: 'SplitExpenses', params: [GROUP_ID, MEMBER_ID], stateChanging: true, responses: answers(200, OK_ANSWER) }),
    },
    '/api/v1/split-expenses/groups/{id}/guests': {
      post: op({
        summary: 'Create a guest user and add them to a group',
        description: withOrder('An `email` that already belongs to another account (split-expense guests excluded) is refused with 409 and `reason: "email_in_use"` unless the caller is an admin; a guest is never linked to SSO through its address.'),
        tag: 'SplitExpenses',
        params: [GROUP_ID],
        stateChanging: true,
        requestBody: body({
          required: ['display_name', 'password'],
          properties: {
            display_name: { type: 'string', maxLength: MAX_GUEST_NAME, description: `At most ${MAX_GUEST_NAME} characters; empty after trimming is refused.` },
            password: { type: 'string', description: 'The first password, at least 8 characters (counted by the route).' },
            username: { type: ['string', 'null'], description: '3 to 64 of `a-z A-Z 0-9 . _ -`; anything else, `null` or `""` lets the route derive one from the name.' },
            phone: { type: ['string', 'null'], maxLength: MAX_GUEST_PHONE, description: `At most ${MAX_GUEST_PHONE} characters; \`null\` or \`""\` means none.` },
            email: { type: ['string', 'null'], maxLength: MAX_GUEST_EMAIL, description: `At most ${MAX_GUEST_EMAIL} characters; \`null\` or \`""\` means none.` },
            birth_date: { type: ['string', 'null'], description: '`YYYY-MM-DD`; `null` or `""` means none.' },
            family_role: oneOf(FAMILY_ROLES, 'Left out: `other`.'),
          },
        }),
        responses: answers(201, 'Guest created and added, `{ data: user }`'),
      }),
    },
    '/api/v1/split-expenses/groups/{id}/expenses': {
      get: withValidationRefusal(op({
        summary: 'List group expenses',
        description: `Active expenses, newest first: \`expense_date\`, then \`created_at\`, then \`id\`, each descending - expenses written in the same second keep a fixed order. Page through every expense with the cursor: pass \`before_date\`, \`before_at\` and \`before_id\` from \`pagination.next_cursor\` of the previous page; an expense added or deleted meanwhile shifts nothing. Without a cursor the endpoint behaves as before (\`limit\`, \`offset\`). \`pagination.has_more\` is exact: false when the page holds the last expense, also when exactly \`limit\` remain; \`pagination.next_cursor\` is null then. A partial cursor, or a cursor together with a non-zero \`offset\`, answers 400. Each expense carries \`attachments\`. ${DOCUMENT_LINKS_READ_NOTE}`,
        tag: 'SplitExpenses',
        params: [
          GROUP_ID,
          LIMIT_QUERY,
          cursorText('before_date', 'Cursor, taken from `pagination.next_cursor.before_date`. Only together with `before_at` and `before_id`.'),
          cursorText('before_at', 'Cursor, taken from `pagination.next_cursor.before_at`.'),
          beforeIdQuery('Cursor, taken from `pagination.next_cursor.before_id`, because several expenses can share a second.'),
          offsetQuery('Offset paging as before the cursor existed. An expense deleted above the current page while paging makes the next offset page skip one; prefer the cursor.'),
          searchQuery('Matches title or description.'),
          { name: 'category', in: 'query', required: false, schema: { type: 'string', enum: [...CATEGORIES] }, description: `Only expenses of this (older split-expense) category. ${QUERY_NOTE}` },
          { name: 'budget_category', in: 'query', required: false, schema: { type: 'string' }, description: `Only expenses of this budget category; \`none\` lists the expenses without one. A key that is not a budget category is ignored. ${QUERY_NOTE}` },
          { name: 'recurring', in: 'query', required: false, schema: { type: 'string', enum: ['1'] }, description: `\`1\` lists only expenses booked from a recurring expense. ${QUERY_NOTE}` },
        ],
      })),
      post: op({
        summary: 'Create expense in group (optional `attachment_document_ids`: receipts from the documents module, filtered by document visibility)',
        tag: 'SplitExpenses',
        params: [GROUP_ID],
        description: withOrder(`${AMOUNT_NOTE} ${BUDGET_CATEGORY_NOTE} ${EXACT_SPLIT_NOTE} ${DOCUMENT_LINKS_READ_NOTE}`),
        stateChanging: true,
        documentDeleteConflict: true,
        documentLinkRefusal: true,
        requestBody: body({ required: ['title', 'amount'], properties: expenseProperties() }),
        responses: answers(201, 'Expense created, `{ data: expense }`'),
      }),
    },
    '/api/v1/split-expenses/groups/{id}/balances': {
      get: op({
        summary: 'Get group balances and totals',
        tag: 'SplitExpenses',
        description: 'Balances per member and currency, the payments that settle them, and two totals over all active expenses of the group (not one page of the expense list). `member_totals`: per member and currency, what the member paid (`paid`, the full amount of every expense with that member as payer) and the member\'s own share (`share`, the sum of that member\'s splits); a member with neither in a currency has no row there. `category_totals`: per category and currency, the sum of the expenses in that category, largest first within a currency; a category without expenses has no row. Both count in `converted_currency` with `converted_amount_minor` - the currency the splits and the ledger are kept in - so `paid` minus `share` is the member\'s balance before any settlement. Deleted expenses and settlements count in neither total, and there is no conversion between currencies.',
        params: [GROUP_ID],
        responses: {
          200: { description: 'Balances and totals', content: { 'application/json': { schema: balancesResponse } } },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: apiError('Group not found or not visible to the caller'),
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/split-expenses/groups/{id}/settlements': {
      post: op({
        summary: 'Record settlement (optional `proof_document_id`: one payment proof, ignored when the document is not visible to the caller)',
        tag: 'SplitExpenses',
        params: [GROUP_ID],
        description: withOrder(`${AMOUNT_NOTE} The response carries \`proof_document_id\` only when the caller may read that document (access to the Documents module, for API tokens a \`documents:read\` scope, and the document's own visibility), else \`null\`.`),
        stateChanging: true,
        documentDeleteConflict: true,
        documentLinkRefusal: true,
        requestBody: body({
          required: ['payer_id', 'payee_id', 'amount'],
          properties: {
            payer_id: bodyId('Who paid, a member of the group.'),
            payee_id: bodyId('Who received, another member of the group.'),
            amount: AMOUNT,
            currency: currency('Without it: the currency of the group.'),
            notes: noteText('Note'),
            proof_document_id: {
              anyOf: [{ type: 'integer' }, DIGIT_TEXT, { type: 'null' }],
              description: `One document of the Documents module as payment proof; \`null\` or left out: none. ${LEGACY_NOTE}`,
            },
          },
        }),
        responses: answers(201, 'Settlement recorded, `{ data: settlement }`'),
      }),
    },
  };
}

/** Settlements, activity, recurring expenses, single expenses and search. */
function movementPaths() {
  return {
    '/api/v1/split-expenses/groups/{id}/settlements/{settlementId}/reverse': {
      post: op({
        summary: 'Reverse a recorded settlement',
        tag: 'SplitExpenses',
        description: 'Books an exact counter-entry (`settlement_reversal`) for every ledger row the payment booked, so balances return to where they were before it. Nothing is deleted: the settlement, its settlement entries and its payment proof stay, and the activity feed records `payment_reversed` next to `payment_registered`. Takes no request body. Allowed for group owners/admins and for whoever recorded the payment - the same rule as editing an expense - and needs write access to the `budget` module. A reversal has no id of its own and cannot be reversed; to correct a payment, reverse it and record it again.',
        params: [GROUP_ID, SETTLEMENT_ID],
        stateChanging: true,
        responses: {
          200: {
            description: 'Settlement reversed',
            content: { 'application/json': { schema: settlementReversalResponse } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: apiError('Neither a group owner/admin nor the person who recorded the payment, or no write access to the `budget` module'),
          404: apiError('Group or settlement not found in this group'),
          409: apiError('Settlement is already reversed, or has no ledger entries to reverse'),
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/split-expenses/groups/{id}/activity': {
      get: op({
        summary: 'Get group activity feed',
        description: 'Newest first (`created_at` descending, `id` ascending within the same second). Page through every entry with the cursor: pass `before_at` and `before_id` from `pagination.next_cursor` of the previous page; entries added meanwhile appear at the top and shift nothing. Without a cursor the endpoint behaves as before (`limit`, `offset`). `pagination.next_cursor` is null when `has_more` is false. Cursor and a non-zero `offset` together answer 400. Entries of type `payment_registered` carry a `settlement` object: payer, payee, amount, `reversed_at` (null while active) and `can_reverse` for the caller. Entries of type `ledger_restored` (migration v226) and `ledger_removed` (migration v227), both without an actor, carry `metadata.title`, `metadata.amount_minor`, `metadata.currency` and the decimal `metadata.amount` (ISO 4217 minor units). Entries of type `expense_created`, `recurring_generated` and `expense_deleted` carry an `expense` object with `id` and `deleted_at` (null while active); title and amount are in `metadata`, as they were when the entry was written.',
        tag: 'SplitExpenses',
        params: [
          GROUP_ID,
          LIMIT_QUERY,
          cursorText('before_at', 'Cursor, taken from `pagination.next_cursor.before_at`. Only together with `before_id`, because several entries can share a second.'),
          beforeIdQuery('Cursor, taken from `pagination.next_cursor.before_id`.'),
          offsetQuery('Offset paging as before the cursor existed. Entries added while paging shift the pages; prefer the cursor.'),
        ],
        responses: {
          200: {
            description: 'One page of the activity feed',
            content: { 'application/json': { schema: activityPageResponse } },
          },
          400: apiError('A parameter outside its schema (`reason: "validation"`, `fields`), only one of `before_at`/`before_id` given, or a cursor combined with a non-zero `offset`'),
          401: { $ref: '#/components/responses/Unauthorized' },
          404: apiError('Group not found or not visible to the caller'),
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/split-expenses/groups/{id}/recurring': {
      get: withValidationRefusal(op({ summary: 'List recurring expenses in group', description: `${RECURRING_VIEW_NOTE} ${RECURRING_ANCHOR_NOTE}`, tag: 'SplitExpenses', params: [GROUP_ID] })),
      post: op({
        summary: 'Create recurring expense in group',
        description: withOrder(`${AMOUNT_NOTE} ${BUDGET_CATEGORY_NOTE} ${EXACT_SPLIT_NOTE} ${RECURRING_SPLIT_NOTE} ${RECURRING_ANCHOR_NOTE} ${RECURRING_PAST_DATE_NOTE}`),
        tag: 'SplitExpenses',
        params: [GROUP_ID],
        stateChanging: true,
        requestBody: body(RECURRING_CREATE),
        responses: answers(201, 'Recurring expense created, in the shape of the list'),
      }),
    },
    '/api/v1/split-expenses/expenses/{id}': {
      put: op({
        summary: 'Update expense (`attachment_document_ids` replaces the receipt links; omit the field to leave them untouched)',
        tag: 'SplitExpenses',
        params: [EXPENSE_ID],
        description: withOrder(`The body is the whole expense (#2810): \`title\`, \`amount\`, \`description\`, \`currency\`, \`converted_amount\`, \`converted_currency\`, \`exchange_snapshot\`, \`split_method\` and \`expense_date\` are required, because leaving one out replaced the stored value (up to v2.93 a missing note or exchange snapshot was cleared, a missing currency, converted amount or converted currency was derived anew, a missing split method became \`equal\` and a missing date became today). \`null\` stays allowed where it was. \`payer_id\`, \`participants\`, \`category\`, \`budget_category\` and \`attachment_document_ids\` left out keep the stored value. ${AMOUNT_NOTE} ${BUDGET_CATEGORY_NOTE} ${EXACT_SPLIT_NOTE} Omit \`category\` (or send \`null\`) to keep the stored category. ${DOCUMENT_LINKS_READ_NOTE}`),
        stateChanging: true,
        documentDeleteConflict: true,
        documentLinkRefusal: true,
        requestBody: body({ required: EXPENSE_REPLACE_REQUIRED, properties: expenseProperties({ update: true }) }),
        responses: answers(200, 'The expense after the update'),
      }),
      delete: op({
        summary: 'Delete expense',
        tag: 'SplitExpenses',
        description: 'Marks the expense deleted and books an exact counter-entry (`expense_reversal`) for every ledger row it booked, in the currency it was booked in, so balances end up where they would be without it. The original ledger rows stay; each counter-entry carries the `created_by` of the row it cancels, and who deleted is the actor of the `expense_deleted` activity entry. Settlements are not tied to expenses and stay untouched. Allowed for group owners/admins and for whoever created the expense, with write access to the `budget` module. A second delete answers 404; the activity feed records `expense_deleted`.',
        params: [EXPENSE_ID],
        stateChanging: true,
        responses: answers(200, OK_ANSWER),
      }),
    },
    '/api/v1/split-expenses/expenses/{id}/comments': {
      post: op({
        summary: 'Add expense comment',
        tag: 'SplitExpenses',
        description: withOrder(),
        params: [EXPENSE_ID],
        stateChanging: true,
        requestBody: body({ required: ['comment'], properties: { comment: { type: 'string', maxLength: MAX_TEXT, description: `At most ${MAX_TEXT} characters; empty after trimming is refused.` } } }),
        responses: answers(201, 'Comment added, `{ data: { id, expense_id, user_id, comment } }`'),
      }),
    },
    '/api/v1/split-expenses/recurring/{id}': {
      put: op({
        summary: 'Update recurring expense',
        description: withOrder(`Allowed for group owners/admins and for whoever created it. A partial update: every field the call omits stays as it is - title, amount, currency, payer, category, description, rhythm, date, split method, participants and \`splits\`. Send \`description\` as \`null\` or \`""\` to clear it. The resulting recurring expense as a whole runs through the same check as creating one, and a refused update changes nothing: changing only the amount of an \`exact\` split is answered with \`400\` because the stored shares no longer add up. ${AMOUNT_NOTE} ${BUDGET_CATEGORY_NOTE} ${EXACT_SPLIT_NOTE} ${RECURRING_SPLIT_NOTE} Without \`currency\` an \`amount\` is read in the currency of the recurring expense. A date that was already booked cannot be triggered again: a \`next_run_date\` that differs from the stored one must lie after the last date booked from this recurring expense (the latest \`expense_date\` of its expenses, deleted ones included); otherwise the answer is \`400\` with \`reason: "next_run_not_after_last_booking"\` and \`last_booked\`. Clients that show an edit form should send only the fields the user changed, so a form opened before the last run does not send its old date back. Expenses already booked keep their values; the next date is booked with the new ones. \`anchor_day\` follows \`next_run_date\` only when the call changes the date or the frequency, so saving a series from the 31st while it stands on 28 February leaves it on the 31st. ${RECURRING_PAST_DATE_NOTE} \`paused_at\` is not touched: a paused recurring expense stays paused until it is resumed. Writes a \`recurring_edited\` activity entry with title and amount. The response has the shape of the list.`),
        tag: 'SplitExpenses',
        params: [RECURRING_ID],
        stateChanging: true,
        requestBody: body(RECURRING_UPDATE),
        responses: {
          200: { description: 'The recurring expense after the update' },
          400: apiError('A request outside its schema (`reason: "validation"`, `fields`; `invalid_missed` for `missed`), refused by the check that also guards creation, or `next_run_date` is not after the last booked date (`reason: "next_run_not_after_last_booking"`, `last_booked`); nothing was changed'),
          401: { $ref: '#/components/responses/Unauthorized' },
          403: apiError('Neither group owner/admin nor the creator'),
          404: apiError('Unknown recurring expense, or its group is not accessible to the caller'),
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
      delete: op({
        summary: 'Delete recurring expense',
        description: 'Allowed for group owners/admins and for whoever created it. Removes the recurring expense; no further dates are booked. Expenses already booked from it stay untouched, with their shares, ledger entries and `recurring_rule_id`. Writes a `recurring_deleted` activity entry with title and amount.',
        tag: 'SplitExpenses',
        params: [RECURRING_ID],
        stateChanging: true,
        responses: answers(200, OK_ANSWER, {
          403: apiError('Neither group owner/admin nor the creator'),
          404: apiError('Unknown recurring expense, or its group is not accessible to the caller'),
        }),
      }),
    },
    '/api/v1/split-expenses/recurring/{id}/pause': {
      post: op({
        summary: 'Pause or resume recurring expense',
        description: withOrder('A toggle: an active recurring expense is paused, a paused one is resumed. Allowed for group owners/admins and for whoever created it. Resuming skips the dates that fell due during the pause: `next_run_date` moves to the first date of the series that is not before today, counted from the old `next_run_date` in whole intervals exactly as the hourly run counts (with the same `anchor_day`, so a series on the 31st resumes on the 31st or the last day of the month), and nothing is booked for the past. "Today" is the day in the household time zone; a date that is today is not missed and is booked by the next run. A resume that skipped dates writes `metadata.skipped` (their number) into its `recurring_resumed` activity entry. Send `missed: "book"` to keep `next_run_date` instead: the hourly run then books every missed date, one per run, each with its original date (the behaviour before this option existed). When the call pauses, `missed` changes nothing about the pause, but its value is checked on every call: anything other than `skip`, `book` or `null` is refused with 400 and the recurring expense stays as it was.'),
        tag: 'SplitExpenses',
        params: [RECURRING_ID],
        stateChanging: true,
        requestBody: {
          required: false,
          description: 'Optional. Without a body the missed dates are skipped.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  missed: { ...MISSED, default: 'skip', description: 'What a resume does with the dates that fell due during the pause. `skip` (also `null` or left out): continue from the next date that is not in the past. `book`: leave `next_run_date` and let the hourly run book each missed date. Anything else is 400 with `reason: "invalid_missed"`.' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'The recurring expense after the toggle, with its `paused_at` and `next_run_date`' },
          400: apiError('`missed` is neither `skip`, `book` nor `null` (`reason: "invalid_missed"`), or the path id is not plain decimal digits (`reason: "validation"`)'),
          401: { $ref: '#/components/responses/Unauthorized' },
          403: apiError('Neither a manager of the group nor the creator of the recurring expense'),
          404: apiError('Recurring expense not found or not visible to the caller'),
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/split-expenses/search': {
      get: withValidationRefusal(op({
        summary: 'Search split-expense groups, expenses, and people',
        tag: 'SplitExpenses',
        params: [searchQuery('Part of a group name, an expense title or description, or a person\'s name; left out or empty: the first ten of each.')],
      })),
    },
  };
}

export function splitexpensesPaths() {
  return withCaseReasons('split-expenses', CASE_REASONS, refuseWhenArchived({ ...groupPaths(), ...movementPaths() }));
}

// #2267: der Grund, den die Route neben `error` sendet.
const CASE_REASONS = {
  '/api/v1/split-expenses/groups/{id}/members': {
    post: '`cross_module_access` (403, adding a person without an account creates a contact and needs write access to contacts - for API tokens a `contacts:write` scope)',
  },
};
