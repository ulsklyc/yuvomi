import { op, jsonBody, idParam, stringPathParam, langParam, DOCUMENT_LINKS_READ_NOTE, withCaseReasons } from '../helpers.js';

export function budgetPaths() {
  return withCaseReasons('budget', CASE_REASONS, {
    '/api/v1/budget/transfers': {
      post: op({
        summary: 'Transfer money between two budget accounts', tag: 'Budget', stateChanging: true,
        requestBody: jsonBody(null, 'Required: title, positive amount matching the account currency precision (no silent rounding), date (YYYY-MM-DD), from_account_id and to_account_id (two different active accounts). Optional: outgoing expense category and subcategory (Financials / Savings when present, otherwise the first remaining expense category and its default subcategory), visibility, is_recurring, recurrence_interval, recurrence_interval_count and recurrence_confirm. Virtual recurrence and recurrence_rule are not supported; transfer_entry_id is read-only.'),
        description: 'Creates linked outgoing and incoming entries atomically. New transfers and account changes require active accounts (400 transfer_account_archived); existing bookings on archived accounts remain editable. Both accounts must have the same effective currency (account currency or household currency); currency exchange is not supported. This also applies when changing accounts through transfer, generic entry or series updates: a mismatch returns 400 with reason transfer_currency_mismatch. Existing bookings remain editable after account or household currency changes when their account assignments stay the same. Returns the outgoing entry in data, including from_account_id, to_account_id and transfer_entry_id. Transfers affect account balances but are excluded from income and expense totals.',
        responses: {
          201: { description: 'Transfer created' },
          400: { description: 'Different effective account currencies: transfer_currency_mismatch. Archived account assignment: transfer_account_archived. Off-grid amount: entry_amount_invalid. Other invalid transfer fields: transfer_invalid.' },
          401: { $ref: '#/components/responses/Unauthorized' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/budget/transfers/{id}': {
      get: op({ summary: 'Get a transfer by either linked entry ID', tag: 'Budget', params: [idParam()], description: 'Returns the outgoing entry in data with from_account_id and to_account_id. For recurring transfers, series holds the current outgoing definition, both current account IDs, its start date, recurrence interval/count and confirmation flag, including when reading a generated occurrence. Requires edit permission for both linked entries; otherwise returns 403. An unknown or non-transfer entry returns 404.' }),
      put: op({ summary: 'Update both entries of a transfer', tag: 'Budget', params: [idParam()], stateChanging: true, requestBody: jsonBody(null, 'Transfer fields as for POST /budget/transfers; omitted fields retain their stored values.'), description: 'Updates both linked entries atomically. Requires edit permission for both. Changing recurrence fields here returns 400 with reason transfer_series_required; use the series endpoint. Invalid fields return 400 with reason transfer_invalid; an unknown transfer returns 404.' }),
    },
    '/api/v1/budget/transfers/{id}/series': {
      put: op({ summary: 'Update a recurring transfer series', tag: 'Budget', params: [idParam()], stateChanging: true, requestBody: jsonBody(null, 'Transfer fields as for POST /budget/transfers; date is the series start date. Omitted fields retain their current series values from both linked definitions, including the destination account.'), description: 'Updates both series definitions and their future bookings atomically, preserving past bookings when the schedule changes. Visibility applies to the entire series, including its past. Requires edit permission for both linked entries. Returns the outgoing anchor in data. Returns 400 for a non-recurring transfer, invalid fields, an invalid start date, or is_recurring set to false; delete the series to end it. An unknown transfer returns 404.' }),
    },
    '/api/v1/budget/summary': { get: op({ summary: 'Get budget summary', tag: 'Budget', description: '`byCategory` uses the reserved `__saving__` bucket for Financials / Savings; pass it as the entry-list category filter to drill down without colliding with a household category named `saving`. `transfers` is the sum of booked transfer outflows for the month, regardless of category; linked transfers are excluded from income, expenses and balance. With `account_id`, `transfers_in` is the sum of booked transfers arriving on that account; it is absent without the filter, where both halves of a transfer cancel out. `pending` (`count`, `income`, `expenses`) reports what is expected and in no total: expected bookings and the subscription payments projected for the month (see `GET /api/v1/budget`). `pending.expected_omitted: true` appears only when the projection hit its limit of 5000 lines; the figures then contain no subscription payment.', params: [{
      name: 'account_id',
      in: 'query',
      required: false,
      description: 'Only entries booked to this account, the same filter as `GET /api/v1/budget`: income, expenses, balance, `byCategory` and `pending` all count that account alone, and no projected subscription payment is included because it is not booked to any account. A value that is not a positive whole number is ignored.',
      schema: { type: 'integer', minimum: 1 },
    }] }) },
    '/api/v1/budget/plans': {
      get: op({ summary: 'Get planned budget vs. actual for a month (category caps + savings goal)', tag: 'Budget', description: 'In personal budget mode the actual figures count what you can see, like the summary: `scope` (`mine`|`household`, default `mine`) picks the view, private entries of others do not count, and the amount of an entry of someone else whose details are hidden (`shared_amount`) counts only toward income and balance of the savings goal, never toward a category. Shared mode counts every entry.' }),
    },
    '/api/v1/budget/plans/{category}': {
      put: op({ summary: 'Set planned monthly amount for a category or the savings goal (__savings__)', tag: 'Budget', params: [stringPathParam('category', 'Expense category key or __savings__')], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Remove a category budget or the savings goal', tag: 'Budget', params: [stringPathParam('category', 'Expense category key or __savings__')], stateChanging: true }),
    },
    '/api/v1/budget/export': { get: op({ summary: 'Export budget entries as CSV', tag: 'Budget', description: 'Expected bookings and projected subscription payments are included with `Expected` in the `Status` column. Subscription payments are projected for at most 366 days from the later of `from` and the first day of the household\'s current month; a wider range sets the response header `X-Budget-Expected-Until` (`YYYY-MM-DD`, last projected day). `X-Budget-Expected-Omitted: true` is set when the projection hit its limit of 5000 lines and the file contains none.' }) },
    '/api/v1/budget/meta': { get: op({ summary: 'Get budget categories and subcategories', tag: 'Budget' }) },
    '/api/v1/budget/categories': {
      get: op({ summary: 'List budget categories', tag: 'Budget', params: [langParam({ fallback: 'household' })] }),
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
      get: op({ summary: 'List subcategories for a budget category', tag: 'Budget', params: [{ name: 'categoryKey', in: 'path', required: true, schema: { type: 'string' } }, langParam({ fallback: 'household' })] }),
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
      get: op({ summary: 'List accounts with starting and running balance, net worth, and available limit on credit cards', tag: 'Budget', description: 'Balances and amounts of an account are in its `currency` (the budget currency when `null`). `net_worth` adds the active accounts in the budget currency. When some are in another currency it is converted with the cached exchange rates: then `net_worth_approx: true`, `net_worth_rates_at` (the oldest rate used) and `net_worth_by_currency` (`[{ currency, amount }]`) are added. When a rate is missing, `net_worth` is `null` and only `net_worth_by_currency` is given.' }),
      post: op({ summary: 'Create account (name, type, starting balance; credit cards also take credit_bank and credit_limit)', tag: 'Budget', stateChanging: true, requestBody: jsonBody(null), description: '`currency` is one of the supported ISO 4217 codes (case is ignored) or empty/`null` for the budget currency; anything else is refused with 400 and `reason: account_currency_invalid`.' }),
    },
    '/api/v1/budget/accounts/{id}': {
      put: op({ summary: 'Update account (credit cards also take credit_bank and credit_limit)', tag: 'Budget', params: [idParam()], stateChanging: true, requestBody: jsonBody(null), description: '`currency` is one of the supported ISO 4217 codes (case is ignored) or empty/`null` for the budget currency; anything else is refused with 400 and `reason: account_currency_invalid`. An unchanged stored code is accepted as sent.' }),
      delete: op({ summary: 'Delete account without linked transfers (ordinary entries are kept, account_id cleared)', tag: 'Budget', description: 'Returns 409 with reason account_has_transfers while linked transfers reference this account. Entries the caller cannot see (private entries of other members in personal mode) keep the account: it then stays for them as an archived account, while the caller gets the same 204 and no longer sees it. Archive it with PUT instead.', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/budget/loans': {
      get: op({ summary: 'List loans and repayment summary', tag: 'Budget', description: 'Each loan carries `due_day` (1 to 31, or `null`), `next_due_month` (`YYYY-MM`) and `next_due_date` (`YYYY-MM-DD`): the due day in the month the next installment is due, clamped to the last day of a shorter month. For a loan without a due day, `next_due_date` is the 1st of `next_due_month` when that month lies before the household\'s current month (a booking date, not a due date), and `null` for an installment due in the current or a later month. Both are `null` once the loan is settled. `projected_end_month` (`YYYY-MM`) is the month of the last installment: the remaining installments counted from the later of `next_due_month` and the household\'s current month, following the payments actually booked for a loan with interest; `null` once settled and for a loan whose installment does not cover its interest. A loan with interest carries `interest.current_rate`, the rate that applies today: that of the installment due in the household\'s current month, at least the next unrecorded one (the fixed rate during the fixed-rate period, the follow-up rate after it). `summary.by_direction.borrowed` and `summary.by_direction.lent` carry the summary figures per direction (`count`, `active_count`, `has_interest`, `total_amount`, `paid_amount`, `remaining_amount`, `remaining_principal`, `remaining_installments`): a borrowed balance is owed by the household, a lent one is owed to it. The top-level figures add both directions.' }),
      post: op({ summary: 'Create loan', tag: 'Budget', stateChanging: true, requestBody: jsonBody(null), description: 'Optional `due_day`: a whole number from 1 to 31, the day of the month an installment is due; `null`, an empty string or leaving it out means none. Anything else is refused with 400 and `reason: loan_due_day_invalid`. With a due day, the installments recorded through `paid_installments` are dated on that day instead of the 1st. The response carries `due_day`, `next_due_month` and `next_due_date`.' }),
    },
    '/api/v1/budget/loans/{id}': {
      put: op({ summary: 'Update loan', tag: 'Budget', params: [idParam()], stateChanging: true, requestBody: jsonBody(null), description: 'Optional `due_day`: a whole number from 1 to 31, or `null` to remove it; leaving the field out keeps the stored day. Anything else is refused with 400 and `reason: loan_due_day_invalid`. Changing the day never moves installments that are already recorded. The response carries `due_day`, `next_due_month` and `next_due_date`.' }),
      delete: op({ summary: 'Delete loan and linked repayment entries', tag: 'Budget', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/budget/loans/preview': {
      post: op({ summary: 'Preview a loan without saving it', tag: 'Budget', stateChanging: true, requestBody: jsonBody(null), description: 'Computes the monthly instalment, term, total interest and remaining debt for the values in the dialog, without writing anything. The server stays the single source of the interest maths - duplicating the formula in the client would give two answers that drift.' }),
    },
    '/api/v1/budget/loans/{id}/payments': {
      post: op({ summary: 'Record loan repayment', tag: 'Budget', params: [idParam()], stateChanging: true, requestBody: jsonBody(null), description: '`paid_date` (`YYYY-MM-DD`) is required and stored as sent, on the installment and on its budget entry. To date an installment the way the loan card does, send the loan\'s `next_due_date`: the due day, or for a loan without one the 1st of a due month that is already over. It is `null` for a loan without a due day whose next installment is due in the current or a later month; send the household\'s today then. The budget entry is in the currency of the loan\'s account, or the budget currency without one: the same currency as the loan books unconverted, the budget currency uses the loan\'s fixed `exchange_rate`, any other goes through that rate and the cached exchange rate to the account currency. Without a cached rate the payment is refused with 409 and `reason: loan_payment_rate_unavailable`.' }),
    },
    '/api/v1/budget/loans/{id}/payments/{paymentId}': {
      delete: op({ summary: 'Delete loan repayment', tag: 'Budget', params: [idParam(), idParam('paymentId', 'Loan payment ID')], stateChanging: true }),
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
          schema: { type: 'string', enum: ['mine', 'household'], default: 'mine' },
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
        }],
      }),
      post: op({ summary: 'Create budget entry (optional `visibility`: private|shared; owner is the creator; optional `attachment_document_ids`: receipts from the documents module)', tag: 'Budget', description: DOCUMENT_LINKS_READ_NOTE, stateChanging: true, documentDeleteConflict: true, documentLinkRefusal: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/budget/{id}': {
      put: op({ summary: 'Update budget entry (`attachment_document_ids` replaces the receipt links; omit the field to leave them untouched)', tag: 'Budget', params: [idParam()], description: `${DOCUMENT_LINKS_READ_NOTE} On the first entry of a running series, a changed rhythm (\`recurrence_interval\`, \`recurrence_interval_count\`, \`recurrence_virtual\`, \`recurrence_rule\`) applies to the whole series: missing past occurrences are created on the old grid, occurrences from today on are rebuilt, and none is generated before today on the new grid. The entry's \`date\` is that booking's date only; the series keeps its start day. An amount is in the currency of the entry's account (the budget currency without one); changing the amount of a loan repayment converts it back to the loan currency the same way the repayment was booked, and is refused with 409 and \`reason: loan_payment_rate_unavailable\` when no rate is known.`, stateChanging: true, documentDeleteConflict: true, documentLinkRefusal: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete budget entry', tag: 'Budget', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/budget/{id}/confirm': {
      patch: op({ summary: 'Confirm a booked entry, correcting amount and date', tag: 'Budget', params: [idParam()], stateChanging: true, requestBody: jsonBody(null), description: 'Body: { amount?, date? }, both optional. Amount and date are editable here precisely because their deviation is the occasion: services rarely debit on the day and to the cent a series predicts. A plain "confirmed" tick would have left the very discrepancy against the bank statement that this is about.' }),
    },
    '/api/v1/budget/{id}/series': {
      put: op({ summary: 'Update recurring budget entry series (receipts stay with the single entry and are not part of the series)', tag: 'Budget', params: [idParam()], stateChanging: true, requestBody: jsonBody(null), description: 'Changes a series "for all future occurrences": its own definition and every entry of the series dated today or later (household time zone). Entries already booked keep their values, the first entry included - it is an ordinary entry that anchors the series. Visibility is the deliberate exception and applies to every entry of the series. The response is the anchor entry with the resulting definition as `series` (null once the series has ended). A series edit never ends the series: `is_recurring: false` is answered with 400. End a series with PUT /api/v1/budget/{id} and `is_recurring: false` on its first entry, or with DELETE. Addressed through a generated occurrence of a virtual series, `amount` is that occurrence\'s amount (the monthly share), and the period amount is derived from it. The start day belongs to the definition: `start_date` (YYYY-MM-DD) moves it and rebuilds the occurrences from today on like a rhythm change; the first entry moves along only while it lies ahead. Once it is booked, a start day in an earlier month than the first entry is answered with 400. Before a start day or rhythm change, every missing past occurrence is created on the old grid; afterwards no occurrence is generated before the day of that change. `date` is ignored here, it is the date of a single entry, and correcting the first entry\'s date with PUT /api/v1/budget/{id} leaves the start day as it is.' }),
      delete: op({ summary: 'Delete recurring budget entry series', tag: 'Budget', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/budget/stats': {
      get: op({ summary: 'Get budget statistics for week, month, or year', tag: 'Budget' }),
    },
    '/api/v1/budget/subscriptions': {
      get: op({ summary: 'List subscriptions with normalized costs and analytics', tag: 'Budget', description: 'The `by_category` and `by_payment_method` breakdowns group by ROW, not by display text: each entry is `{ id, name, label_key, amount }`. `id` is `null` for the catch-all bucket of subscriptions without a category or payment method, and `name`/`label_key` are then `null` too - the caller supplies the wording. A seeded row carries `label_key` (an i18n key such as `subscriptions.paymentMethodCreditCard`) and a `name` of its original English wording; a row the household created or renamed carries only `name`. Resolve as `label_key ? t(label_key) : name`. Subscription objects include boolean `reminder_enabled` (default true). When false, no payment reminder is scheduled, including after edits and renewals; subscription status and costs are unaffected. `reminder_days: 0` still means a reminder on the payment date when enabled. Subscription objects carry the same pair denormalized as `category_label_key` / `category_name` and `payment_method_label_key` / `payment_method_name`. `account_id` is the budget account every booking of the subscription goes to (null: none), with `account_name`; `account_archived: true` means that account is archived and the subscription books without an account until another one is chosen.' }),
      post: op({ summary: 'Create subscription', description: 'Optional boolean `reminder_enabled` defaults to true. Set false to create an active subscription without a payment reminder. `reminder_days` remains a lead time of 0-365 days; zero means the payment date. Optional `visibility` (`private`|`shared`; default `private` in the personal budget mode, `shared` otherwise; the owner is the creator) and `account_id` (a budget account, null for none): the booking of the next payment inherits both. A booking on an archived account goes without an account. The booking is in the account\'s currency (the budget currency without one), converted with the cached exchange rate. An account that does not exist is 400 with `reason: "subscriptions_account_not_found"`.', tag: 'Budget', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/budget/subscriptions/meta': {
      get: op({ summary: 'Get subscription categories, payment methods, and billing cycles', tag: 'Budget', description: 'Categories and payment methods each carry `label_key` (an i18n key) when they are one of the seeded defaults and `null` once the household renamed them - resolve as `label_key ? t(label_key) : name`. Also `budget_mode` (`shared`|`personal`; a subscription visibility only applies in `personal`) and `accounts`: the budget accounts to choose from as `{ id, name, archived }`.' }),
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
      post: op({ summary: 'Advance a subscription to its next renewal date, or complete it when its end condition is reached', description: 'Preserves `reminder_enabled`. A renewed subscription with reminders disabled has no reminder row. Besides `data` the answer carries `undo: { token }`; the state before the payment stays on the server, and POST /renew/undo with that token takes the payment back (R23).', tag: 'Budget', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/budget/subscriptions/{id}/renew/undo': {
      post: op({ summary: 'Take a payment back (undo a renewal)', description: 'Body: { token } from the `undo` block of POST /renew. Valid for the latest payment only, for the account that paid, within 10 minutes; the bookings involved come from what the renewal recorded on the server, never from the request. Due date and payment count go back, a completion is lifted, the booking of the next payment that the renewal created is deleted, and the paid booking is the linked next-payment booking again (rewritten from the subscription). Only valid while the subscription is exactly what ONE renewal made of the recorded state; otherwise (or with an unknown, used or expired token) 409 with `reason: "subscriptions_renew_undo_stale"`. Same write rule as PUT.', tag: 'Budget', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/budget/subscriptions/{id}': {
      put: op({ summary: 'Update subscription', description: 'Optional boolean `reminder_enabled`: false removes the payment reminder; true schedules it using `reminder_days`. Omitting the field preserves its current value. Changing it does not pause the subscription or remove its budget expense. Optional `visibility` (`private`|`shared`; the owner stays) and `account_id` (null clears it); omitted, both stay. They apply to the booking of the next payment, never to payments already booked.', tag: 'Budget', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete subscription', tag: 'Budget', params: [idParam()], stateChanging: true }),
    },
  });
}

// #1909: die Faelle, die ein Nutzer bei den Abos erreicht, tragen einen
// `reason` neben dem englischen `error` - je Operation der Satz, der sie nennt.
const SUBSCRIPTION_GONE = '`subscriptions_subscription_not_found` (404, the subscription does not exist)';
const SELECTED_META_GONE = '`subscriptions_selected_category_not_found`, `subscriptions_selected_payment_method_not_found` (400, the chosen category or payment method does not exist), `subscriptions_account_not_found` (400, the chosen budget account does not exist)';
const SUBSCRIPTION_CHECKS = '`subscriptions_end_before_next_payment`, `subscriptions_occurrence_count_too_low`, `subscriptions_logo_content_mismatch` (400, only when it is the single finding)';
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
    put: '`category_exists` (409, a category with this name already exists)',
    delete: '`category_in_use` (409, budget entries or split expenses and their recurring series still use the category; `count` carries how many), `category_last` (409, the last category cannot be deleted)',
  },
  '/api/v1/budget/categories/{categoryKey}/subcategories': { post: '`subcategory_exists` (409, a subcategory with this name already exists)' },
  '/api/v1/budget/categories/{key}/subcategories/{subKey}': {
    put: '`subcategory_exists` (409, a subcategory with this name already exists)',
    delete: '`subcategory_in_use` (409, entries still use the subcategory; `count` carries how many), `subcategory_last` (409, the last subcategory cannot be deleted)',
  },
};
