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
      post: op({
        summary: 'Apply a set of planned meals at once',
        tag: 'Meals',
        description: 'Body: { assignments, replace_existing? }. Creates one meal per assignment (`date`, `meal_type`, `title`, optional `notes`, `recipe_url`, `recipe_id`, `ingredients`) in a single transaction and returns them. Without `replace_existing`, nothing is skipped or overwritten: the new meals are added next to any meal already planned for the same date and meal type. With `replace_existing: true`, every meal already planned for a date and meal type pair named in `assignments` is deleted first (an occurrence of a weekly series is excepted from the series, so it does not come back); other slots stay untouched. If any assignment is invalid or names an unknown recipe, the request is refused with 400 and nothing is written.',
        stateChanging: true,
        requestBody: jsonBody(null),
        responses: {
          201: { description: 'Meals created' },
          400: { description: 'Missing or invalid assignments, or an unknown recipe_id. Nothing is written.' },
          401: { $ref: '#/components/responses/Unauthorized' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
  };
}
