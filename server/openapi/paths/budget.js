import { op, jsonBody, idParam, stringPathParam, langParam, DOCUMENT_LINKS_READ_NOTE } from '../helpers.js';

export function budgetPaths() {
  return {
    '/api/v1/budget/summary': { get: op({ summary: 'Get budget summary', tag: 'Budget' }) },
    '/api/v1/budget/plans': {
      get: op({ summary: 'Get planned budget vs. actual for a month (category caps + savings goal)', tag: 'Budget' }),
    },
    '/api/v1/budget/plans/{category}': {
      put: op({ summary: 'Set planned monthly amount for a category or the savings goal (__savings__)', tag: 'Budget', params: [stringPathParam('category', 'Expense category key or __savings__')], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Remove a category budget or the savings goal', tag: 'Budget', params: [stringPathParam('category', 'Expense category key or __savings__')], stateChanging: true }),
    },
    '/api/v1/budget/export': { get: op({ summary: 'Export budget entries as CSV', tag: 'Budget' }) },
    '/api/v1/budget/meta': { get: op({ summary: 'Get budget categories and subcategories', tag: 'Budget' }) },
    '/api/v1/budget/categories': {
      get: op({ summary: 'List budget categories', tag: 'Budget', params: [langParam()] }),
      post: op({ summary: 'Create budget category', tag: 'Budget', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/budget/categories/reorder': {
      patch: op({ summary: 'Reorder budget categories', tag: 'Budget', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/budget/categories/{key}': {
      put: op({ summary: 'Rename budget category', tag: 'Budget', params: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete budget category', tag: 'Budget', params: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }], stateChanging: true }),
    },
    '/api/v1/budget/categories/{categoryKey}/subcategories': {
      get: op({ summary: 'List subcategories for a budget category', tag: 'Budget', params: [{ name: 'categoryKey', in: 'path', required: true, schema: { type: 'string' } }, langParam()] }),
      post: op({ summary: 'Create budget subcategory', tag: 'Budget', params: [{ name: 'categoryKey', in: 'path', required: true, schema: { type: 'string' } }], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/budget/categories/{key}/subcategories/reorder': {
      patch: op({ summary: 'Reorder budget subcategories', tag: 'Budget', params: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/budget/categories/{key}/subcategories/{subKey}': {
      put: op({ summary: 'Rename budget subcategory', tag: 'Budget', params: [stringPathParam('key', 'Category key'), stringPathParam('subKey', 'Subcategory key')], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete budget subcategory', tag: 'Budget', params: [stringPathParam('key', 'Category key'), stringPathParam('subKey', 'Subcategory key')], stateChanging: true }),
    },
    '/api/v1/budget/accounts': {
      get: op({ summary: 'List accounts with starting and running balance, net worth, and available limit on credit cards', tag: 'Budget' }),
      post: op({ summary: 'Create account (name, type, starting balance; credit cards also take credit_bank and credit_limit)', tag: 'Budget', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/budget/accounts/{id}': {
      put: op({ summary: 'Update account (credit cards also take credit_bank and credit_limit)', tag: 'Budget', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete account (linked entries are kept, account_id cleared)', tag: 'Budget', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/budget/loans': {
      get: op({ summary: 'List loans and repayment summary', tag: 'Budget' }),
      post: op({ summary: 'Create loan', tag: 'Budget', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/budget/loans/{id}': {
      put: op({ summary: 'Update loan', tag: 'Budget', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete loan and linked repayment entries', tag: 'Budget', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/budget/loans/preview': {
      post: op({ summary: 'Preview a loan without saving it', tag: 'Budget', stateChanging: true, requestBody: jsonBody(null), description: 'Computes the monthly instalment, term, total interest and remaining debt for the values in the dialog, without writing anything. The server stays the single source of the interest maths - duplicating the formula in the client would give two answers that drift.' }),
    },
    '/api/v1/budget/loans/{id}/payments': {
      post: op({ summary: 'Record loan repayment', tag: 'Budget', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/budget/loans/{id}/payments/{paymentId}': {
      delete: op({ summary: 'Delete loan repayment', tag: 'Budget', params: [idParam(), idParam('paymentId', 'Loan payment ID')], stateChanging: true }),
    },
    '/api/v1/budget': {
      get: op({
        summary: 'List budget entries',
        tag: 'Budget',
        description: `Each entry carries \`attachments\`. ${DOCUMENT_LINKS_READ_NOTE}`,
        params: [{
          name: 'scope',
          in: 'query',
          required: false,
          description: "View filter when the household runs in personal budget mode (preference `budget_mode=personal`): `mine` shows entries you own, `household` shows the shared pot. Ignored in shared mode. Entries also carry `owner_id` and `visibility` (`private`|`shared`); private entries are only visible to their owner (no admin bypass). Each entry carries `attachments`: linked documents from the documents module, filtered by document visibility.",
          schema: { type: 'string', enum: ['mine', 'household'], default: 'mine' },
        }],
      }),
      post: op({ summary: 'Create budget entry (optional `visibility`: private|shared; owner is the creator; optional `attachment_document_ids`: receipts from the documents module)', tag: 'Budget', description: DOCUMENT_LINKS_READ_NOTE, stateChanging: true, documentDeleteConflict: true, documentLinkRefusal: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/budget/{id}': {
      put: op({ summary: 'Update budget entry (`attachment_document_ids` replaces the receipt links; omit the field to leave them untouched)', tag: 'Budget', params: [idParam()], description: DOCUMENT_LINKS_READ_NOTE, stateChanging: true, documentDeleteConflict: true, documentLinkRefusal: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete budget entry', tag: 'Budget', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/budget/{id}/confirm': {
      patch: op({ summary: 'Confirm a booked entry, correcting amount and date', tag: 'Budget', params: [idParam()], stateChanging: true, requestBody: jsonBody(null), description: 'Body: { amount?, date? }, both optional. Amount and date are editable here precisely because their deviation is the occasion: services rarely debit on the day and to the cent a series predicts. A plain "confirmed" tick would have left the very discrepancy against the bank statement that this is about.' }),
    },
    '/api/v1/budget/{id}/series': {
      put: op({ summary: 'Update recurring budget entry series (receipts stay with the single entry and are not part of the series)', tag: 'Budget', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete recurring budget entry series', tag: 'Budget', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/budget/stats': {
      get: op({ summary: 'Get budget statistics for week, month, or year', tag: 'Budget' }),
    },
    '/api/v1/budget/subscriptions': {
      get: op({ summary: 'List subscriptions with normalized costs and analytics', tag: 'Budget', description: 'The `by_category` and `by_payment_method` breakdowns group by ROW, not by display text: each entry is `{ id, name, label_key, amount }`. `id` is `null` for the catch-all bucket of subscriptions without a category or payment method, and `name`/`label_key` are then `null` too - the caller supplies the wording. A seeded row carries `label_key` (an i18n key such as `subscriptions.paymentMethodCreditCard`) and a `name` of its original English wording; a row the household created or renamed carries only `name`. Resolve as `label_key ? t(label_key) : name`. Subscription objects carry the same pair denormalized as `category_label_key` / `category_name` and `payment_method_label_key` / `payment_method_name`.' }),
      post: op({ summary: 'Create subscription', tag: 'Budget', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/budget/subscriptions/meta': {
      get: op({ summary: 'Get subscription categories, payment methods, and billing cycles', tag: 'Budget', description: 'Categories and payment methods each carry `label_key` (an i18n key) when they are one of the seeded defaults and `null` once the household renamed them - resolve as `label_key ? t(label_key) : name`.' }),
    },
    '/api/v1/budget/subscriptions/settings': {
      get: op({ summary: 'Get subscription budget and base currency', tag: 'Budget' }),
      put: op({ summary: 'Update subscription budget and base currency', tag: 'Budget', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/budget/subscriptions/categories': {
      post: op({ summary: 'Create subscription category', tag: 'Budget', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/budget/subscriptions/categories/{id}': {
      put: op({ summary: 'Rename a subscription category', tag: 'Budget', params: [idParam()], stateChanging: true, requestBody: jsonBody(null), description: 'Renaming clears `label_key`: the given name applies from then on instead of the translated default.' }),
      delete: op({ summary: 'Delete a subscription category', tag: 'Budget', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/budget/subscriptions/payment-methods': {
      post: op({ summary: 'Create subscription payment method', tag: 'Budget', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/budget/subscriptions/payment-methods/{id}': {
      put: op({ summary: 'Rename a subscription payment method', tag: 'Budget', params: [idParam()], stateChanging: true, requestBody: jsonBody(null), description: 'Renaming clears `label_key`: the given name applies from then on instead of the translated default.' }),
      delete: op({ summary: 'Delete a subscription payment method', tag: 'Budget', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/budget/subscriptions/meta/order': {
      put: op({ summary: 'Reorder subscription categories and payment methods', tag: 'Budget', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/budget/subscriptions/logo-search': {
      post: op({ summary: 'Find selectable logo options from a website URL or service name', tag: 'Budget', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/budget/subscriptions/{id}/renew': {
      post: op({ summary: 'Advance a subscription to its next renewal date, or complete it when its end condition is reached', tag: 'Budget', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/budget/subscriptions/{id}': {
      put: op({ summary: 'Update subscription', tag: 'Budget', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete subscription', tag: 'Budget', params: [idParam()], stateChanging: true }),
    },
  };
}
