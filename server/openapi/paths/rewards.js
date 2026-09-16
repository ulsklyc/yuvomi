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
      post: op({ summary: 'Create reward', tag: 'Rewards', admin: true, stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/rewards/catalog/{id}': {
      patch: op({ summary: 'Update / (de)activate reward', tag: 'Rewards', admin: true, params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete reward', tag: 'Rewards', admin: true, params: [idParam()], stateChanging: true }),
    },
    '/api/v1/rewards/ledger': {
      get: op({ summary: 'Point transaction history (filter by user_id)', tag: 'Rewards' }),
    },
    '/api/v1/rewards/redemptions': {
      get: op({ summary: 'List redemption requests (filter by status)', tag: 'Rewards' }),
      post: op({ summary: 'Request a redemption (reserves points)', tag: 'Rewards', stateChanging: true, requestBody: jsonBody(null), description: 'Body: { catalog_id, user_id?, note? }. Points are reserved immediately; whether anyone has to approve stays with the household setting. `user_id` redeems on behalf of someone else and is otherwise ignored: an administrator may do it for any member, and a paired wall display must do it, naming the person chosen on the device (#1209). For a display the person is required rather than optional, because the display account takes no part in rewards itself, and it has to be a household member who may write this module. The request is booked as the display having asked and the person having received.' }),
    },
    '/api/v1/rewards/redemptions/{id}': {
      patch: op({ summary: 'Decide a redemption (fulfill/reject/cancel)', tag: 'Rewards', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/rewards/bonus': {
      post: op({ summary: 'Grant manual bonus / correction points', tag: 'Rewards', admin: true, stateChanging: true, requestBody: jsonBody(null) }),
    },
  };
}
