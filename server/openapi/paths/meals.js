import { op, jsonBody, idParam } from '../helpers.js';

export function mealsPaths() {
  return {
    '/api/v1/meals': {
      get: op({ summary: 'List meal plan entries', tag: 'Meals' }),
      post: op({ summary: 'Create meal plan entry', tag: 'Meals', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/meals/suggestions': { get: op({ summary: 'Get meal suggestions', tag: 'Meals' }) },
    '/api/v1/meals/{id}': {
      put: op({ summary: 'Update meal plan entry', tag: 'Meals', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete meal plan entry', tag: 'Meals', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/meals/{id}/ingredients': {
      post: op({ summary: 'Add meal ingredient', tag: 'Meals', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/meals/ingredients/{ingId}': {
      patch: op({ summary: 'Update meal ingredient', tag: 'Meals', params: [idParam('ingId', 'Ingredient ID')], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete meal ingredient', tag: 'Meals', params: [idParam('ingId', 'Ingredient ID')], stateChanging: true }),
    },
    // Der Pfad sagt `meals`, geschrieben wird in den Einkauf - also steht auch
    // die 403 ausgeschrieben, wie bei /birthdays/import (#1290).
    '/api/v1/meals/{id}/to-shopping-list': {
      post: op({
        summary: 'Transfer meal ingredients to shopping list',
        tag: 'Meals',
        description: 'Creates shopping items, so it requires write access to the `shopping` module in addition to `meals` - a credential scoped to the meal plan alone is refused with 403.',
        params: [idParam()],
        stateChanging: true,
        requestBody: jsonBody(null),
        responses: {
          200: { description: 'Successful response' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/meals/week-to-shopping-list': {
      post: op({
        summary: 'Transfer weekly meal ingredients to shopping list',
        tag: 'Meals',
        description: 'Creates shopping items, so it requires write access to the `shopping` module in addition to `meals` - a credential scoped to the meal plan alone is refused with 403.',
        stateChanging: true,
        requestBody: jsonBody(null),
        responses: {
          200: { description: 'Successful response' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/meals/apply-plan': {
      post: op({ summary: 'Apply a set of planned meals at once', tag: 'Meals', stateChanging: true, requestBody: jsonBody(null), description: 'Body: { assignments, replace_existing? }. Writes several day/meal-type assignments in one call; `replace_existing: true` overwrites what is already planned on those slots instead of skipping them.' }),
    },
  };
}
