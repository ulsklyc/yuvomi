import { op, jsonBody, idParam } from '../helpers.js';

const apiError = (description) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
});

// Antwort des Stornos (#1309): die Zahlung, wie sie in `settlements` steht,
// plus wann und von wem sie storniert wurde. Beides kommt aus der Gegenbuchung
// im Ledger, nicht aus einer eigenen Spalte.
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
        proof_document_id: { type: ['integer', 'null'], description: 'Kept as is - a reversal does not detach the payment proof.' },
        status: { type: 'string', enum: ['active', 'deleted'], description: 'Unchanged by a reversal.' },
        paid_at: { type: 'string', format: 'date-time' },
        created_by: { type: 'integer' },
        created_at: { type: 'string', format: 'date-time' },
        updated_at: { type: 'string', format: 'date-time' },
        reversed_at: { type: 'string', format: 'date-time' },
        reversed_by: { type: 'integer' },
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
      post: op({ summary: 'Add member to group', tag: 'SplitExpenses', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/split-expenses/groups/{id}/member-candidates': {
      get: op({ summary: 'List users and contacts that can be added to a group', tag: 'SplitExpenses', params: [idParam()] }),
    },
    '/api/v1/split-expenses/groups/{id}/members/{userId}': {
      delete: op({ summary: 'Remove member from group', tag: 'SplitExpenses', params: [idParam(), { name: 'userId', in: 'path', required: true, schema: { type: 'integer' } }], stateChanging: true }),
    },
    '/api/v1/split-expenses/groups/{id}/guests': {
      post: op({ summary: 'Create a guest user and add them to a group', tag: 'SplitExpenses', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/split-expenses/groups/{id}/expenses': {
      get: op({ summary: 'List group expenses', tag: 'SplitExpenses', params: [idParam()] }),
      post: op({ summary: 'Create expense in group (optional `attachment_document_ids`: receipts from the documents module, filtered by document visibility)', tag: 'SplitExpenses', params: [idParam()], stateChanging: true, documentDeleteConflict: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/split-expenses/groups/{id}/balances': {
      get: op({ summary: 'Get group balances', tag: 'SplitExpenses', params: [idParam()] }),
    },
    '/api/v1/split-expenses/groups/{id}/settlements': {
      post: op({ summary: 'Record settlement (optional `proof_document_id`: one payment proof, ignored when the document is not visible to the caller)', tag: 'SplitExpenses', params: [idParam()], stateChanging: true, documentDeleteConflict: true, requestBody: jsonBody(null) }),
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
      get: op({ summary: 'Get group activity feed', description: 'Entries of type `payment_registered` carry a `settlement` object: payer, payee, amount, `reversed_at` (null while active) and `can_reverse` for the caller.', tag: 'SplitExpenses', params: [idParam()] }),
    },
    '/api/v1/split-expenses/groups/{id}/recurring': {
      get: op({ summary: 'List recurring expenses in group', tag: 'SplitExpenses', params: [idParam()] }),
      post: op({ summary: 'Create recurring expense in group', tag: 'SplitExpenses', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/split-expenses/expenses/{id}': {
      put: op({ summary: 'Update expense (`attachment_document_ids` replaces the receipt links; omit the field to leave them untouched)', tag: 'SplitExpenses', params: [idParam()], stateChanging: true, documentDeleteConflict: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete expense', tag: 'SplitExpenses', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/split-expenses/expenses/{id}/comments': {
      post: op({ summary: 'Add expense comment', tag: 'SplitExpenses', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/split-expenses/recurring/{id}/pause': {
      post: op({ summary: 'Pause or resume recurring expense', tag: 'SplitExpenses', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/split-expenses/search': {
      get: op({ summary: 'Search split-expense groups, expenses, and people', tag: 'SplitExpenses' }),
    },
  };
}
