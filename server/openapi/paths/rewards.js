import { op, jsonBody, idParam } from '../helpers.js';

export function rewardsPaths() {
  return {
    '/api/v1/rewards/overview': {
      get: op({ summary: 'Reward overview (balances, catalog, pending count)', tag: 'Rewards' }),
    },
    '/api/v1/rewards/participants': {
      get: op({ summary: 'List members with participation flag and balance', tag: 'Rewards', admin: true }),
    },
    '/api/v1/rewards/participants/{userId}': {
      put: op({ summary: 'Enable/disable a member in the reward system', tag: 'Rewards', admin: true, params: [idParam('userId', 'User ID')], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/rewards/catalog': {
      get: op({ summary: 'List rewards (admin sees inactive with ?all=1)', tag: 'Rewards' }),
      post: op({ summary: 'Create reward', tag: 'Rewards', admin: true, stateChanging: true, requestBody: jsonBody(null), description: 'Body: { name, cost, icon?, description?, sort_order?, quantity? }. `quantity` is how many units the HOUSEHOLD has of this reward; omitted or `null` means unlimited, which is what every reward created before #1310 is. A listed reward also carries `remaining` - the units left, derived from the fulfilled redemptions, `null` when there is no limit.' }),
    },
    '/api/v1/rewards/catalog/{id}': {
      patch: op({ summary: 'Update / (de)activate reward', tag: 'Rewards', admin: true, params: [idParam()], stateChanging: true, requestBody: jsonBody(null), description: '`quantity` follows the same field vocabulary as `icon` and `description`: an absent field leaves it alone, `null` lifts the limit. Lowering it below what is already fulfilled is allowed - a household can lose an item - and `remaining` then reads 0.' }),
      delete: op({ summary: 'Delete reward', tag: 'Rewards', admin: true, params: [idParam()], stateChanging: true }),
    },
    '/api/v1/rewards/ledger': {
      get: op({ summary: 'Point transaction history (filter by user_id)', tag: 'Rewards' }),
    },
    '/api/v1/rewards/redemptions': {
      get: op({ summary: 'List redemption requests (filter by status)', tag: 'Rewards' }),
      post: op({ summary: 'Request a redemption (reserves points)', tag: 'Rewards', stateChanging: true, requestBody: jsonBody(null), description: 'Body: { catalog_id, user_id?, note? }. Points are reserved immediately; whether anyone has to approve stays with the household setting. `user_id` redeems on behalf of someone else and is otherwise ignored: an administrator may do it for any member, and a paired wall display must do it, naming the person chosen on the device (#1209). For a display the person is required rather than optional, because the display account takes no part in rewards itself, and it has to be a household member who may write this module. The request is booked as the display having asked and the person having received. A reward whose units are all fulfilled answers 409 with `reason: "out_of_stock"`; nothing is booked, so no points are taken.' }),
    },
    '/api/v1/rewards/redemptions/{id}': {
      patch: op({ summary: 'Decide a redemption (fulfill/reject/cancel)', tag: 'Rewards', params: [idParam()], stateChanging: true, requestBody: jsonBody(null), description: 'Body: { action: "fulfill" | "reject" | "cancel" }. Fulfilling a request whose reward has no units left does not fail silently: the request is REJECTED with `decision_reason: "out_of_stock"`, the reserved points go back through the usual `reversal`, and the answer is 409 with `reason: "out_of_stock"` and the decided row in `data`. Rejecting and cancelling stay untouched - sold out means only that fulfilling finds no unit.' }),
    },
    '/api/v1/rewards/bonus': {
      post: op({ summary: 'Grant manual bonus / correction points', tag: 'Rewards', admin: true, stateChanging: true, requestBody: jsonBody(null) }),
    },
  };
}
