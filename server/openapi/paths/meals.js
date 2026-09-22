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
        description: 'Body: { assignments, replace_existing?, skip_occupied? }. Creates one meal per assignment (`date`, `meal_type`, `title`, optional `notes`, `recipe_url`, `recipe_id`, `ingredients`) in a single transaction and returns them. Without `replace_existing` or `skip_occupied`, nothing is skipped or overwritten: the new meals are added next to any meal already planned for the same date and meal type. With `replace_existing: true`, every meal already planned for a date and meal type pair named in `assignments` is deleted first (an occurrence of a weekly series is excepted from the series, so it does not come back); other slots stay untouched. With `skip_occupied: true`, an assignment whose date and meal type pair already holds a meal before the call is not created and is listed in `skipped` instead, with its position in `assignments` as `index`; an occurrence of a weekly series counts as a meal even if its week was never opened, a deleted occurrence does not. Several assignments for the same pair that was empty before the call are all created. `skip_occupied` and `replace_existing` together are refused with 400. If any assignment is invalid or names an unknown recipe, the request is refused with 400 and nothing is written.',
        stateChanging: true,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['assignments'],
                properties: {
                  assignments: {
                    type: 'array',
                    minItems: 1,
                    items: {
                      type: 'object',
                      required: ['date', 'meal_type', 'title'],
                      properties: {
                        date: { type: 'string', format: 'date' },
                        meal_type: { type: 'string', enum: ['breakfast', 'lunch', 'dinner', 'snack'] },
                        title: { type: 'string' },
                        notes: { type: ['string', 'null'] },
                        recipe_url: { type: ['string', 'null'] },
                        recipe_id: { type: ['integer', 'null'] },
                        ingredients: { type: 'array', items: { type: 'object', additionalProperties: true } },
                      },
                    },
                  },
                  replace_existing: { type: 'boolean', default: false, description: 'Delete the meals of every named date and meal type pair first.' },
                  skip_occupied: { type: 'boolean', default: false, description: 'Only fill pairs that are empty before the call; the others come back in `skipped`. Must be a JSON boolean (anything else is refused with 400). Cannot be combined with `replace_existing`.' },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Meals created. `data` lists only the meals this call created. `skipped` is present only when `skip_occupied: true` was sent; the status stays 201 even if every assignment was skipped.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['data'],
                  properties: {
                    data: { type: 'array', items: { type: 'object', additionalProperties: true } },
                    skipped: {
                      type: 'array',
                      items: {
                        type: 'object',
                        required: ['index', 'date', 'meal_type', 'reason'],
                        properties: {
                          index: { type: 'integer', minimum: 0, description: 'Position of the skipped assignment in `assignments`.' },
                          date: { type: 'string', format: 'date' },
                          meal_type: { type: 'string', enum: ['breakfast', 'lunch', 'dinner', 'snack'] },
                          reason: { type: 'string', enum: ['occupied'] },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          400: { description: 'Missing or invalid assignments, an unknown recipe_id, `skip_occupied` that is not a boolean, or `skip_occupied` together with `replace_existing`. Nothing is written.' },
          401: { $ref: '#/components/responses/Unauthorized' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
  };
}
