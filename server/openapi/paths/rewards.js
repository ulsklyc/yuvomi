import { op, idParam, withCaseReasons, withValidationRefusal } from '../helpers.js';
import {
  ALLOWANCE_FREQUENCIES, MAX_BONUS, MAX_COST, MAX_QUANTITY, MONEY_DIRECTIONS, MONEY_KINDS,
  REDEMPTION_ACTIONS, REDEMPTION_KIND_FILTERS, REDEMPTION_STATUSES,
} from '../../services/reward-fields.js';

/**
 * The answers of an operation with its real success status (#2810).
 * @param {number} status
 * @param {string} description
 * @param {Record<string, unknown>} [extra]
 */
const answers = (status, description, extra = {}) => ({
  [status]: { description },
  400: { $ref: '#/components/responses/BadRequest' },
  401: { $ref: '#/components/responses/Unauthorized' },
  500: { $ref: '#/components/responses/InternalServerError' },
  ...extra,
});

/**
 * A JSON body that must be sent.
 * @param {Record<string, unknown>} schema
 */
const body = (schema) => ({
  required: true,
  description: 'JSON request body',
  content: { 'application/json': { schema: { type: 'object', ...schema } } },
});

/** @param {string} name @param {string} what */
const pathId = (name, what) => idParam(name, `${what}, plain decimal digits.`);

/** The bare `{ ok: true }` of the three deletes - not wrapped in `data`, as it always was. */
const OK_ANSWER = {
  description: 'Deleted. The answer is `{ ok: true }` - not wrapped in `data`.',
  content: {
    'application/json': {
      schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean', const: true } } },
    },
  },
};

// Ziffern-Text ist eine Altform (#2810): die App schickt Zahlen, aeltere
// Clients die IDs ihrer Formularfelder als Text.
const DIGIT_TEXT = { type: 'string', pattern: '^[0-9]+$' };
const LEGACY_NOTE = 'Digit text is accepted as a legacy form.';

/**
 * A person or record id in the body: a whole number, digit text as the legacy
 * form. Never `null`.
 * @param {string} description
 */
const bodyId = (description) => ({
  anyOf: [{ type: 'integer' }, DIGIT_TEXT],
  description: `${description} ${LEGACY_NOTE}`,
});

/**
 * A free text the route cuts to a length without refusing it.
 * @param {number} cut
 * @param {string} description
 */
const cutText = (cut, description) => ({
  type: ['string', 'null'],
  description: `${description} Trimmed and cut to ${cut} characters by the route (not refused); \`null\`, \`""\` or left out means none.`,
});

const MONEY_AMOUNT = {
  type: 'string',
  description: 'A decimal STRING in the currency of the account (`"5.00"`; whole units for a currency without decimals). A number is refused.',
};
const MONEY_CURRENCY = {
  type: ['string', 'null'],
  description: 'Optional: the currency code of the account. Any other code is 400 with `reason: "currency_mismatch"`; `null` or left out means the account\'s.',
};

const CATALOG_COST = { minimum: 1, maximum: MAX_COST, description: `The price in points, a whole number from 1 to ${MAX_COST}.` };
const CATALOG_QUANTITY = {
  type: ['integer', 'null'],
  minimum: 1,
  maximum: MAX_QUANTITY,
  description: `How many units the household has, a whole number from 1 to ${MAX_QUANTITY}; \`null\` means unlimited.`,
};
const CATALOG_TEXTS = {
  icon: cutText(8, 'An emoji or short icon text.'),
  description: { type: ['string', 'null'], description: 'Free text, no length limit; trimmed, `null` or `""` means none.' },
  sort_order: { type: 'integer', description: 'Position in the list; left out is 0 (create) or unchanged (update).' },
};

const LIST_QUERY = [
  { name: 'user_id', in: 'query', required: false, description: 'Only this person, plain decimal digits; empty or 0 means everybody.', schema: { type: 'integer' } },
  { name: 'limit', in: 'query', required: false, description: 'At most this many entries, plain decimal digits; the route keeps it within 1 to 500 (left out, empty or 0: 100).', schema: { type: 'integer' } },
];

const BODY_ORDER_NOTE = ' A body outside the schema (a value that is not of its type, a number as text, a value outside its list) answers 400 '
  + 'with `fields` before anything is looked up, so it comes before the 404, 403 and 409 of the route.';

export function rewardsPaths() {
  return withCaseReasons('rewards', CASE_REASONS, {
    '/api/v1/rewards/overview': {
      get: op({ summary: 'Reward overview (balances, catalog, pending count)', tag: 'Rewards', description: '`pendingCount` counts the open REWARD requests, as it always has. Open pocket money requests (#1734) are counted separately in `moneyPendingCount`, and only those the caller may read: all for an administrator, the own for a member, none for a paired display.' }),
    },
    '/api/v1/rewards/participants': {
      get: op({ summary: 'List members with participation flag and balance', tag: 'Rewards', admin: true }),
    },
    '/api/v1/rewards/participants/{userId}': {
      put: withValidationRefusal(op({
        summary: 'Enable/disable a member in the reward system',
        tag: 'Rewards',
        admin: true,
        params: [pathId('userId', 'User ID')],
        stateChanging: true,
        requestBody: body({
          required: ['enabled'],
          properties: { enabled: { type: 'boolean', description: 'Whether the member takes part. Required: until #2810 a missing or mistyped value switched the participation off.' } },
        }),
        description: `Body: { enabled }.${BODY_ORDER_NOTE}`,
      })),
    },
    '/api/v1/rewards/catalog': {
      get: withValidationRefusal(op({
        summary: 'List rewards (admin sees inactive with ?all=1)',
        tag: 'Rewards',
        params: [{ name: 'all', in: 'query', required: false, description: '`1` lists the inactive rewards too, for an administrator; for anybody else it changes nothing.', schema: { type: 'string', enum: ['1'] } }],
      })),
      post: op({
        summary: 'Create reward',
        tag: 'Rewards',
        admin: true,
        stateChanging: true,
        requestBody: body({
          required: ['name', 'cost'],
          properties: {
            name: { type: 'string', description: 'The name, no length limit; empty after trimming is refused.' },
            cost: { type: 'integer', ...CATALOG_COST },
            quantity: CATALOG_QUANTITY,
            ...CATALOG_TEXTS,
          },
        }),
        responses: answers(201, 'Reward created', { 403: { $ref: '#/components/responses/Forbidden' } }),
        description: 'Body: { name, cost, icon?, description?, sort_order?, quantity? }. `quantity` is how many units the HOUSEHOLD has of this reward; omitted or `null` means unlimited, which is what every reward created before #1310 is. A listed reward also carries `remaining` - the units left, derived from the fulfilled redemptions, `null` when there is no limit.',
      }),
    },
    '/api/v1/rewards/catalog/{id}': {
      patch: withValidationRefusal(op({
        summary: 'Update / (de)activate reward',
        tag: 'Rewards',
        admin: true,
        params: [pathId('id', 'Reward ID')],
        stateChanging: true,
        requestBody: body({
          properties: {
            name: { type: ['string', 'null'], description: 'The name; `null` or left out keeps it, empty after trimming is refused.' },
            cost: { type: ['integer', 'null'], ...CATALOG_COST, description: `${CATALOG_COST.description} \`null\` or left out keeps it.` },
            quantity: { ...CATALOG_QUANTITY, description: `${CATALOG_QUANTITY.description} Left out keeps it.` },
            is_active: { type: 'boolean', description: 'Whether the reward is offered; left out keeps it. Until #2810 any value but `true` or `1` switched the reward off.' },
            ...CATALOG_TEXTS,
          },
        }),
        description: `A partial update: a field left out stays as it is. \`quantity\` follows the same field vocabulary as \`icon\` and \`description\`: an absent field leaves it alone, \`null\` lifts the limit. Lowering it below what is already fulfilled is allowed - a household can lose an item - and \`remaining\` then reads 0.${BODY_ORDER_NOTE}`,
      })),
      delete: op({ summary: 'Delete reward', tag: 'Rewards', admin: true, params: [pathId('id', 'Reward ID')], stateChanging: true, responses: answers(200, 'Deleted', { 200: OK_ANSWER, 403: { $ref: '#/components/responses/Forbidden' } }) }),
    },
    '/api/v1/rewards/ledger': {
      get: withValidationRefusal(op({ summary: 'Point transaction history (filter by user_id)', tag: 'Rewards', params: LIST_QUERY, description: 'Every entry carries its person, points and type. `reason` and `task_id` of an entry that belongs to a task are `null` unless the entry is the caller\'s own or the caller can see that task (same rule as GET /tasks, no admin bypass; a paired display sees only tasks with visibility `all`, the wall rule); once the task is deleted they stay with the entry\'s owner. Bonus, adjustment and redemption entries keep their `reason` for everyone. Points only: pocket money entries live in the same ledger but never appear here (see GET /rewards/money/ledger). LATE COMPLETION DECAY (household setting `tasks_late_decay_enabled`, off by default): an earn entry booked after the task\'s due day carries `decay_days` (calendar days past due at booking) and `base_points` (the point value before the reduction, `max(1, base - days)` was booked); both are `null` when nothing was reduced, and both follow the same visibility rule as `reason` and `task_id` - `null` for a task the caller may not see. A filter given twice is refused.' })),
    },
    '/api/v1/rewards/redemptions': {
      get: withValidationRefusal(op({
        summary: 'List redemption requests (filter by status)',
        tag: 'Rewards',
        params: [
          { name: 'status', in: 'query', required: false, description: 'Only requests with this status.', schema: { type: 'string', enum: [...REDEMPTION_STATUSES] } },
          { name: 'kind', in: 'query', required: false, description: 'Which requests: `reward` (left out), `money` (both money sorts), `withdrawal`, `deposit` or `all`.', schema: { type: 'string', enum: Object.keys(REDEMPTION_KIND_FILTERS) } },
        ],
        description: 'An administrator gets every request, everyone else only their own. Each row carries `user_balance`: the current point balance of the member the request is for, summed from the ledger at the time of the call (not the balance when the request was made). It is present for members who no longer take part in rewards as well, which `balances` in the overview is not, and it can be below zero. POCKET MONEY (#1734): without a `kind` query parameter the list is what it was before - reward requests only (`kind: "reward"`), so a client that sums `cost` as points keeps summing points. `?kind=money` answers the pocket money requests, `?kind=withdrawal` or `?kind=deposit` one sort, `?kind=all` both sorts together; any other value is 400. A money request carries the amount in minor units in `cost`, its `currency` and `minor_unit` (those of the account, not of today\'s household setting) and, while it is pending, the MONEY balance in `user_balance` (null once the request is decided: the account may since have been closed and reopened in another currency), and goes to the member it belongs to and to administrators only, never to a paired display. A filter given twice, or a `status` outside its list, is refused.',
      })),
      post: op({
        summary: 'Request a redemption (reserves points)',
        tag: 'Rewards',
        stateChanging: true,
        requestBody: body({
          properties: {
            kind: { type: 'string', enum: ['reward', ...MONEY_KINDS], description: '`reward` (or left out) redeems a catalogue entry; `withdrawal` or `deposit` files a pocket money request.' },
            catalog_id: bodyId('The reward, a whole number (reward requests). Left out, or a reward that does not exist or is inactive, is 404 `rewards_reward_not_found`.'),
            user_id: bodyId('The person the request is for: an administrator may name anybody, a paired display must; ignored otherwise.'),
            note: cutText(500, 'A note to the request.'),
            amount: MONEY_AMOUNT,
            currency: MONEY_CURRENCY,
          },
        }),
        responses: answers(201, 'Request filed'),
        description: 'Body: { catalog_id, user_id?, note? }. Points are reserved immediately; whether anyone has to approve stays with the household setting. `user_id` redeems on behalf of someone else and is otherwise ignored: an administrator may do it for any member, and a paired wall display must do it, naming the person chosen on the device (#1209). For a display the person is required rather than optional, because the display account takes no part in rewards itself, and it has to be a household member who may write this module. The request is booked as the display having asked and the person having received. A reward whose units are all fulfilled answers 409 with `reason: "out_of_stock"`; nothing is booked, so no points are taken. POCKET MONEY (#1734): with `kind: "withdrawal"` or `kind: "deposit"` the body is { kind, amount, note?, user_id? } and no catalogue entry is involved. `amount` is a decimal STRING in the currency of the ACCOUNT ("5.00"; whole units for a currency without decimals); an optional `currency` that is not the account\'s is 400 with `reason: "currency_mismatch"`; a number, an array or an object is 400, and so is a `note` that is not a string. Nothing is booked when the request is filed and it always waits for an administrator, whatever the approval setting says. The person needs a pocket money account (a plan or a money entry), otherwise 400 with `reason: "no_money_account"`. A withdrawal above the balance is 400 with `reason: "insufficient_funds"`. A paired display gets 403 with `reason: "money_not_on_display"`.' + BODY_ORDER_NOTE,
      }),
    },
    '/api/v1/rewards/redemptions/{id}': {
      patch: withValidationRefusal(op({
        summary: 'Decide a redemption (fulfill/reject/cancel) or take the decision back (reopen)',
        tag: 'Rewards',
        params: [pathId('id', 'Redemption ID')],
        stateChanging: true,
        requestBody: body({
          required: ['action'],
          properties: { action: { type: 'string', enum: [...REDEMPTION_ACTIONS], description: 'What to do with the request.' } },
        }),
        description: 'Body: { action: "fulfill" | "reject" | "cancel" | "reopen" }. A missing or unknown `action` is a 400 before the request is looked up (until #2810 an unknown, decided or foreign request answered 404, 409 or 403 first). REOPEN (R23) is the undo of a decision: only the account that decided may send it - for a fulfilment or rejection only an administrator, and never for a request fulfilled automatically at filing (`decided_by` equals `requested_by`; 403 `reason: "rewards_reopen_not_allowed"`), while whoever cancelled may reopen their own cancellation - within 10 minutes of the decision (later 409 `reason: "rewards_reopen_expired"`, an open request 409 `reason: "rewards_redemption_open"`). The request is pending again and the balance stands as before the decision: a fulfilled reward keeps its reserved points, a rejected or cancelled reward takes back exactly its `reversal` entry, a fulfilled money request drops its money entry. If the balance no longer allows that, the decision stays and the answer is 409 with `reason: "insufficient_points"` or `"insufficient_funds"`. Fulfilling a request whose reward has no units left does not fail silently: the request is REJECTED with `decision_reason: "out_of_stock"`, the reserved points go back through the usual `reversal`, and the answer is 409 with `reason: "out_of_stock"` and the decided row in `data`. Rejecting and cancelling stay untouched - sold out means only that fulfilling finds no unit. POCKET MONEY (#1734): fulfilling a withdrawal books the amount off the money balance, fulfilling a deposit credits it; rejecting and cancelling book nothing, because nothing was reserved. The cover is checked again when a withdrawal is fulfilled: if the balance no longer covers it, the answer is 409 with `reason: "insufficient_funds"` and the request STAYS pending. When a member is deactivated, their open money requests are cancelled with `decision_reason: "account_deactivated"`; fulfilling one that is still open for a deactivated member cancels it and answers 409 with `reason: "account_deactivated"`. A money request the caller may not read (somebody else\'s, for a non-administrator) answers 404 for every action, exactly like an id that does not exist.',
      })),
    },
    '/api/v1/rewards/bonus': {
      post: op({
        summary: 'Grant manual bonus / correction points',
        tag: 'Rewards',
        admin: true,
        stateChanging: true,
        requestBody: body({
          required: ['user_id', 'delta'],
          properties: {
            user_id: bodyId('The member, a whole number.'),
            delta: { type: 'integer', minimum: -MAX_BONUS, maximum: MAX_BONUS, description: `Points to add (positive) or take (negative), a whole number from -${MAX_BONUS} to ${MAX_BONUS}; 0 is refused.` },
            reason: cutText(200, 'Why.'),
          },
        }),
        responses: answers(201, 'Points booked', { 403: { $ref: '#/components/responses/Forbidden' } }),
        description: 'Body: { user_id, delta, reason? }.',
      }),
    },
    '/api/v1/rewards/money': {
      get: op({ summary: 'Pocket money accounts the caller may see', tag: 'Rewards', description: 'Answers { currency, minor_unit, accounts, candidates }. An account is { id, display_name, balance_minor, currency, minor_unit, former, closable, plan } with `plan` either null or { amount_minor, currency, minor_unit, frequency, anchor_day, next_run_date, paused }. AN ACCOUNT IS A ROW OF ITS OWN AND HAS EXACTLY ONE CURRENCY: the household currency of the day it was opened. The code is also written on every money entry, every money request and the plan. A later change of the household currency leaves existing accounts as they are - read `currency` and `minor_unit` (decimals per ISO 4217) from the ACCOUNT, not from the top level, which names the household currency a NEW account would be opened in. `closable` is true for an account with no plan, balance zero and nothing pending; only such an account can be closed, and one opened again takes the household currency of then. `former: true` marks the account of a deactivated member that still holds a balance; only administrators get it, it can only be paid out, and it leaves the list at balance zero. WHO SEES WHAT: a member gets their own account or an empty list, an administrator gets every account, a paired display gets none. A scoped API token follows the same rule through its subject and role. Pocket money is separate from points: there is no conversion in either direction. `candidates` lists the members without an account and is filled for administrators only.' }),
    },
    '/api/v1/rewards/money/accounts': {
      post: op({
        summary: 'Open a pocket money account for a member',
        tag: 'Rewards',
        admin: true,
        stateChanging: true,
        requestBody: body({
          required: ['user_id'],
          properties: { user_id: bodyId('The member, a whole number.'), currency: MONEY_CURRENCY },
        }),
        responses: answers(201, 'Account opened', { 403: { $ref: '#/components/responses/Forbidden' } }),
        description: 'Body: { user_id, currency? }. Opens an account without a plan and without an entry, in the household currency of that moment; an optional `currency` that is not the household currency is 400 with `reason: "currency_mismatch"`. Answers 201 with { user_id, balance_minor: 0, currency, minor_unit, plan: null }. The member then sees the account (balance zero) and can file requests. Only household members: 400 otherwise, 409 with `reason: "account_deactivated"` for a deactivated member, 404 for an unknown user, 409 with `reason: "money_account_exists"` if there is one already. A first plan (PUT /rewards/money/plans/{userId}) or a first credit (POST /rewards/money/entries) opens the account as well.' + BODY_ORDER_NOTE,
      }),
    },
    '/api/v1/rewards/money/accounts/{userId}': {
      delete: op({ summary: 'Close an empty pocket money account', tag: 'Rewards', admin: true, params: [pathId('userId', 'User ID')], stateChanging: true, responses: answers(200, 'Closed', { 200: OK_ANSWER, 403: { $ref: '#/components/responses/Forbidden' } }), description: 'Only an EMPTY account can be closed: no plan, balance zero, no open money request (`closable: true` in GET /rewards/money says so). Otherwise 409 with `reason: "money_account_not_empty"`; 404 without an account. Entries and decided requests stay as history. An account opened again takes the household currency of that moment - closing and reopening is the only way an account changes its currency.' }),
    },
    '/api/v1/rewards/money/ledger': {
      get: withValidationRefusal(op({ summary: 'Pocket money history (filter by user_id)', tag: 'Rewards', params: LIST_QUERY, description: 'Money entries only, under the same visibility rule as GET /rewards/money, applied in the query: `user_id` is a filter, not a right, and asking for somebody else answers an empty list. Each entry carries `delta` (minor units, signed) with its own `currency` and `minor_unit`, `type`, `reason`, `allowance_date` (the due date a scheduled credit was booked for, otherwise null) and `request_kind` (`withdrawal` or `deposit` when the entry came from a request). A filter given twice is refused.' })),
    },
    '/api/v1/rewards/money/entries': {
      post: op({
        summary: 'Book pocket money directly (credit or debit)',
        tag: 'Rewards',
        admin: true,
        stateChanging: true,
        requestBody: body({
          required: ['user_id', 'amount', 'direction'],
          properties: {
            user_id: bodyId('The member, a whole number.'),
            amount: MONEY_AMOUNT,
            direction: { type: 'string', enum: [...MONEY_DIRECTIONS], description: '`credit` adds, `debit` takes.' },
            reason: cutText(200, 'Why.'),
            currency: MONEY_CURRENCY,
          },
        }),
        responses: answers(201, 'Booked', { 403: { $ref: '#/components/responses/Forbidden' } }),
        description: 'Body: { user_id, amount, direction: "credit" | "debit", reason? }. `amount` is a decimal string. A first CREDIT opens the account in the household currency of that moment if there is none yet (POST /rewards/money/accounts opens one without booking anything); only household members can have one. An optional `currency` must be the currency of the account, otherwise 400 with `reason: "currency_mismatch"`; `amount` is read in the decimals of the account currency. The answer names `currency` and `minor_unit`. For the account of a DEACTIVATED member only `debit` is allowed (pay out what is left, never below zero); a credit is 409 with `reason: "account_deactivated"`. A debit above the balance is 400 with `reason: "insufficient_funds"` - there is no overdraft. `amount` and `reason` must be strings. A single amount is limited to 10^12 minor units, whatever the currency. No budget entry is created.' + BODY_ORDER_NOTE,
      }),
    },
    '/api/v1/rewards/money/plans/{userId}': {
      put: withValidationRefusal(op({
        summary: 'Create or change the scheduled credit of a member',
        tag: 'Rewards',
        admin: true,
        params: [pathId('userId', 'User ID')],
        stateChanging: true,
        requestBody: body({
          required: ['amount', 'frequency', 'anchor_day'],
          properties: {
            amount: MONEY_AMOUNT,
            frequency: { type: 'string', enum: [...ALLOWANCE_FREQUENCIES], description: 'How often the credit is booked.' },
            anchor_day: { type: 'integer', minimum: 1, maximum: 31, description: 'The day of the month (1 to 31) for a monthly plan, the weekday (1 = Monday to 7 = Sunday) for a weekly one.' },
            paused: { type: 'boolean', description: 'Pause the plan; left out keeps the stored state.' },
            currency: MONEY_CURRENCY,
          },
        }),
        description: 'Body: { amount, frequency: "weekly" | "monthly", anchor_day, paused? }. `anchor_day` is the day of the month (1-31) for a monthly plan and the weekday (1 = Monday to 7 = Sunday) for a weekly one. A month without the anchor day takes its last day and the day comes back afterwards (31 -> 28/29 -> 31). Due dates missed while the server was off are booked afterwards, each exactly once; a paused plan books nothing and skips its missed dates when it is resumed. A plan whose member is no longer part of the household is paused instead of credited. Changing only the amount keeps the next date. Dates that are due when the plan is changed are booked first, with the plan as it was, in the same transaction as the change - a new amount or a new anchor day never reaches back. `paused` left out keeps the stored state: a paused plan stays paused. The plan keeps the currency of the account; an optional `currency` that differs is 400 with `reason: "currency_mismatch"`. The plan of a deactivated member stays paused: changing or resuming it is 409 with `reason: "account_deactivated"`. A single amount is limited to 10^12 minor units.' + BODY_ORDER_NOTE,
      })),
      delete: op({ summary: 'End the scheduled credit of a member', tag: 'Rewards', admin: true, params: [pathId('userId', 'User ID')], stateChanging: true, responses: answers(200, 'Ended', { 200: OK_ANSWER, 403: { $ref: '#/components/responses/Forbidden' } }), description: 'Removes the plan. Balance and history stay.' }),
    },
  });
}

// #1909: die Faelle, die ein Nutzer erreicht, tragen einen `reason` neben dem
// englischen `error` - je Operation der Satz, der sie nennt. Die aelteren
// Gruende ohne Praefix (`out_of_stock`, `insufficient_funds` ...) stehen
// schon in den Beschreibungen oben.
const REWARD_GONE = '`rewards_reward_not_found` (404, the reward was deleted)';
const NOT_PARTICIPATING = '`rewards_not_participating` (400, the person does not take part in rewards)';
const CASE_REASONS = {
  '/api/v1/rewards/catalog/{id}': { patch: REWARD_GONE, delete: REWARD_GONE },
  '/api/v1/rewards/redemptions': {
    post: '`rewards_reward_not_found` (404, the reward was deleted or switched off), '
      + `${NOT_PARTICIPATING}, \`rewards_insufficient_points\` (400, the balance does not cover the cost)`,
  },
  '/api/v1/rewards/redemptions/{id}': {
    patch: '`rewards_redemption_not_found` (404, the request does not exist or is not visible), '
      + '`rewards_redemption_decided` (409, the request was decided already)',
  },
  '/api/v1/rewards/bonus': { post: NOT_PARTICIPATING },
  '/api/v1/rewards/money/accounts/{userId}': { delete: '`rewards_money_account_not_found` (404, there is no account)' },
  '/api/v1/rewards/money/plans/{userId}': { delete: '`rewards_money_plan_not_found` (404, there is no plan)' },
};
