import { op, jsonBody, idParam, DOCUMENT_LINKS_READ_NOTE } from '../helpers.js';

// Betraege im Request (#1607): eine Regel fuer Ausgabe, Genau-Anteil und Zahlung,
// durchgesetzt in parseMoneyToMinor().
const AMOUNT_NOTE = 'Amounts are decimal strings with a dot (`"12.50"`, not a number), with at most the currency\'s decimal places, and must be greater than zero: `0`, `-0` and negative values are answered with `400`.';
const EXACT_SPLIT_NOTE = 'With `split_method: "exact"`, every participant needs a `splits[].amount` under the same rule, and the shares must add up to the expense amount.';
const RECURRING_SPLIT_NOTE = 'The split is checked when the recurring expense is created, by the same rule as a single expense: `payer_id` and every entry of `participants` must be members of the group, `exact` amounts must add up to the amount, `percentage` values to 100, and `shares` must be positive integers. Anything else is answered with `400` and nothing is stored.';
const RECURRING_ANCHOR_NOTE = 'Every recurring expense carries `anchor_day`, the day of the month it is meant for (1-31), taken from the first `next_run_date` when it is created; it cannot be set directly. Monthly and yearly steps clamp to the last day of a shorter month and return to the anchor where the month has it: a series on the 31st books on 28 or 29 February and on 31 March, a yearly one from 29 February books on 28 February and on 29 February again in a leap year. Weekly series step by seven days.';

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

export function splitexpensesPaths() {
  return {
    '/api/v1/split-expenses/meta': { get: op({ summary: 'Get split expenses metadata', tag: 'SplitExpenses' }) },
    '/api/v1/split-expenses/dashboard': { get: op({ summary: 'Get split expenses dashboard summary', tag: 'SplitExpenses' }) },
    '/api/v1/split-expenses/groups': {
      get: op({ summary: 'List expense groups', tag: 'SplitExpenses' }),
      post: op({ summary: 'Create expense group', tag: 'SplitExpenses', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/split-expenses/groups/{id}': {
      patch: op({ summary: 'Update expense group', tag: 'SplitExpenses', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete expense group', tag: 'SplitExpenses', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/split-expenses/groups/{id}/archive': {
      post: op({ summary: 'Archive expense group', tag: 'SplitExpenses', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/split-expenses/groups/{id}/unarchive': {
      post: op({ summary: 'Restore an archived expense group', tag: 'SplitExpenses', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/split-expenses/groups/{id}/members': {
      get: op({ summary: 'List group members', tag: 'SplitExpenses', params: [idParam()] }),
      post: op({ summary: 'Add member to group', description: 'Takes a `user_id`, or a `contact_id` that is turned into a guest user when the contact has none yet. A `contact_id` needs read access to the Contacts module (for API tokens `contacts:read`); without it, and for an unknown contact, the answer is the same 404 and nothing is created. A contact without an account is linked to the new guest and needs write access to Contacts (`contacts:write`); without it the answer is 403 and nothing is written. If that contact carries an address that already belongs to another account (split-expense guests excluded), a caller who is not an admin gets 409 with `reason: "email_in_use"` and nothing is created.', tag: 'SplitExpenses', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/split-expenses/groups/{id}/member-candidates': {
      get: op({ summary: 'List users and contacts that can be added to a group', description: 'Phone and email come only with read access to the Contacts module, a member\'s birthday only with read access to the Calendar module (for API tokens `contacts:read` and `calendar:read`); otherwise they are null. Contacts without an account are offered as candidates only with write access to Contacts (`contacts:write`), because adding one links it to the new guest.', tag: 'SplitExpenses', params: [idParam()] }),
    },
    '/api/v1/split-expenses/groups/{id}/members/{userId}': {
      delete: op({ summary: 'Remove member from group', tag: 'SplitExpenses', params: [idParam(), { name: 'userId', in: 'path', required: true, schema: { type: 'integer' } }], stateChanging: true }),
    },
    '/api/v1/split-expenses/groups/{id}/guests': {
      post: op({ summary: 'Create a guest user and add them to a group', description: 'An `email` that already belongs to another account (split-expense guests excluded) is refused with 409 and `reason: "email_in_use"` unless the caller is an admin; a guest is never linked to SSO through its address.', tag: 'SplitExpenses', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/split-expenses/groups/{id}/expenses': {
      get: op({ summary: 'List group expenses', description: `Each expense carries \`attachments\`. ${DOCUMENT_LINKS_READ_NOTE}`, tag: 'SplitExpenses', params: [idParam()] }),
      post: op({ summary: 'Create expense in group (optional `attachment_document_ids`: receipts from the documents module, filtered by document visibility)', tag: 'SplitExpenses', params: [idParam()], description: `${AMOUNT_NOTE} ${EXACT_SPLIT_NOTE} ${DOCUMENT_LINKS_READ_NOTE}`, stateChanging: true, documentDeleteConflict: true, documentLinkRefusal: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/split-expenses/groups/{id}/balances': {
      get: op({ summary: 'Get group balances', tag: 'SplitExpenses', params: [idParam()] }),
    },
    '/api/v1/split-expenses/groups/{id}/settlements': {
      post: op({ summary: 'Record settlement (optional `proof_document_id`: one payment proof, ignored when the document is not visible to the caller)', tag: 'SplitExpenses', params: [idParam()], description: AMOUNT_NOTE + ' The response carries `proof_document_id` only when the caller may read that document (access to the Documents module, for API tokens a `documents:read` scope, and the document\'s own visibility), else `null`.', stateChanging: true, documentDeleteConflict: true, documentLinkRefusal: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/split-expenses/groups/{id}/settlements/{settlementId}/reverse': {
      post: op({
        summary: 'Reverse a recorded settlement',
        tag: 'SplitExpenses',
        description: 'Books an exact counter-entry (`settlement_reversal`) for every ledger row the payment booked, so balances return to where they were before it. Nothing is deleted: the settlement, its settlement entries and its payment proof stay, and the activity feed records `payment_reversed` next to `payment_registered`. Takes no request body. Allowed for group owners/admins and for whoever recorded the payment - the same rule as editing an expense - and needs write access to the `budget` module. A reversal has no id of its own and cannot be reversed; to correct a payment, reverse it and record it again.',
        params: [idParam('id', 'Expense group ID'), idParam('settlementId', 'Settlement ID')],
        stateChanging: true,
        responses: {
          200: {
            description: 'Settlement reversed',
            content: { 'application/json': { schema: settlementReversalResponse } },
          },
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
          idParam(),
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 30 }, description: 'Page size. Values above 100 are capped at 100.' },
          { name: 'before_at', in: 'query', required: false, schema: { type: 'string', maxLength: 64 }, description: 'Cursor, taken from `pagination.next_cursor.before_at`. Only together with `before_id`, because several entries can share a second.' },
          { name: 'before_id', in: 'query', required: false, schema: { type: 'integer', minimum: 1 }, description: 'Cursor, taken from `pagination.next_cursor.before_id`.' },
          { name: 'offset', in: 'query', required: false, schema: { type: 'integer', minimum: 0, default: 0 }, description: 'Offset paging as before the cursor existed. Entries added while paging shift the pages; prefer the cursor.' },
        ],
        responses: {
          200: {
            description: 'One page of the activity feed',
            content: { 'application/json': { schema: activityPageResponse } },
          },
          400: apiError('Only one of `before_at`/`before_id` given, or a cursor combined with a non-zero `offset`'),
          401: { $ref: '#/components/responses/Unauthorized' },
          404: apiError('Group not found or not visible to the caller'),
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/split-expenses/groups/{id}/recurring': {
      get: op({ summary: 'List recurring expenses in group', description: RECURRING_ANCHOR_NOTE, tag: 'SplitExpenses', params: [idParam()] }),
      post: op({ summary: 'Create recurring expense in group', description: `${AMOUNT_NOTE} ${EXACT_SPLIT_NOTE} ${RECURRING_SPLIT_NOTE} ${RECURRING_ANCHOR_NOTE}`, tag: 'SplitExpenses', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/split-expenses/expenses/{id}': {
      put: op({ summary: 'Update expense (`attachment_document_ids` replaces the receipt links; omit the field to leave them untouched)', tag: 'SplitExpenses', params: [idParam()], description: `${AMOUNT_NOTE} ${EXACT_SPLIT_NOTE} ${DOCUMENT_LINKS_READ_NOTE}`, stateChanging: true, documentDeleteConflict: true, documentLinkRefusal: true, requestBody: jsonBody(null) }),
      delete: op({
        summary: 'Delete expense',
        tag: 'SplitExpenses',
        description: 'Marks the expense deleted and books an exact counter-entry (`expense_reversal`) for every ledger row it booked, in the currency it was booked in, so balances end up where they would be without it. The original ledger rows stay; each counter-entry carries the `created_by` of the row it cancels, and who deleted is the actor of the `expense_deleted` activity entry. Settlements are not tied to expenses and stay untouched. Allowed for group owners/admins and for whoever created the expense, with write access to the `budget` module. A second delete answers 404; the activity feed records `expense_deleted`.',
        params: [idParam()],
        stateChanging: true,
      }),
    },
    '/api/v1/split-expenses/expenses/{id}/comments': {
      post: op({ summary: 'Add expense comment', tag: 'SplitExpenses', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/split-expenses/recurring/{id}/pause': {
      post: op({
        summary: 'Pause or resume recurring expense',
        description: 'A toggle: an active recurring expense is paused, a paused one is resumed. Allowed for group owners/admins and for whoever created it. Resuming skips the dates that fell due during the pause: `next_run_date` moves to the first date of the series that is not before today, counted from the old `next_run_date` in whole intervals exactly as the hourly run counts (with the same `anchor_day`, so a series on the 31st resumes on the 31st or the last day of the month), and nothing is booked for the past. "Today" is the day in the household time zone; a date that is today is not missed and is booked by the next run. A resume that skipped dates writes `metadata.skipped` (their number) into its `recurring_resumed` activity entry. Send `missed: "book"` to keep `next_run_date` instead: the hourly run then books every missed date, one per run, each with its original date (the behaviour before this option existed). When the call pauses, `missed` changes nothing about the pause, but its value is checked on every call: anything other than `skip` or `book` is refused with 400 and the recurring expense stays as it was.',
        tag: 'SplitExpenses',
        params: [idParam()],
        stateChanging: true,
        requestBody: {
          required: false,
          description: 'Optional. Without a body the missed dates are skipped.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  missed: { type: 'string', enum: ['skip', 'book'], default: 'skip', description: 'What a resume does with the dates that fell due during the pause. `skip`: continue from the next date that is not in the past. `book`: leave `next_run_date` and let the hourly run book each missed date.' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'The recurring expense after the toggle, with its `paused_at` and `next_run_date`' },
          400: apiError('`missed` is neither `skip` nor `book` (`reason: "invalid_missed"`)'),
          401: { $ref: '#/components/responses/Unauthorized' },
          403: apiError('Neither a manager of the group nor the creator of the recurring expense'),
          404: apiError('Recurring expense not found or not visible to the caller'),
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/split-expenses/search': {
      get: op({ summary: 'Search split-expense groups, expenses, and people', tag: 'SplitExpenses' }),
    },
  };
}
