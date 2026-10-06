import { op, jsonBody, idParam } from '../helpers.js';

// Der Koch einer Mahlzeit (#1679). EINE Beschreibung fuer jede Stelle, die ihn
// annimmt - anlegen, bearbeiten, apply-plan.
const COOK_PROPERTY = {
  type: ['integer', 'null'],
  description: 'The household member who cooks this meal, or `null` for nobody. The id is a positive integer; an empty string, a fraction or any other form is refused with 400. Only a household member can be chosen: housekeeping staff, split-expense guests, wall tablets and deactivated accounts are refused with 400, and an id that belongs to no account gets the same answer. A cook that is already stored on the meal stays valid; for `scope=series` that is the cook stored on the series.',
};

const COOK_READ_NOTE = 'A meal carries its cook next to `created_by`: `cook_user_id` (or `null`), `cook_name` and `cook_color`. The picture of the cook is not repeated on every meal; it is on the member (`GET /api/v1/family/members`; a scoped token needs `family:read` for it, `meals:read` alone is refused there with 403). A meal of a weekly series also names the cook stored on the series as `recurrence_cook_user_id`, which can differ from its own.';

// Anlegen und Bearbeiten nehmen dieselben Felder; nur was Pflicht ist und was
// die Serie betrifft, unterscheidet sie. `repeat_weekly` gibt es nur beim
// Anlegen; `repeat_until` und `ingredients` nimmt PUT ebenfalls, aber allein
// mit `scope=series` - ohne den Umfang liest die Route sie nicht.
function mealBody({ required = [], create = false } = {}) {
  return {
    required: true,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          ...(required.length ? { required } : {}),
          additionalProperties: true,
          properties: {
            date: { type: 'string', format: 'date' },
            meal_type: { type: 'string', enum: ['breakfast', 'lunch', 'dinner', 'snack'] },
            title: { type: 'string' },
            notes: { type: ['string', 'null'] },
            recipe_url: { type: ['string', 'null'] },
            recipe_id: { type: ['integer', 'null'] },
            cook_user_id: COOK_PROPERTY,
            ...(create ? {
              repeat_weekly: { type: 'boolean', default: false, description: 'Create a weekly series from this meal. The series stores the cook as well, and every meal created from it starts with that cook.' },
              repeat_until: { type: ['string', 'null'], format: 'date', description: 'Last date of the series; empty or missing means it never ends.' },
              ingredients: { type: 'array', items: { type: 'object', additionalProperties: true } },
            } : {
              repeat_until: { type: 'string', description: 'Only with `scope=series`: the last date of the series as `YYYY-MM-DD`. An empty string removes the end, a missing field leaves it as it is. Meals of the series after the new end are deleted. A date before the start of the series is refused with 400.' },
              ingredients: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Only with `scope=series`: replaces the ingredients of the series and of every meal created from it. Without `scope` the field is ignored; the ingredients of a single meal are changed through `/api/v1/meals/{id}/ingredients` and `/api/v1/meals/ingredients/{ingId}`.' },
            }),
          },
        },
      },
    },
  };
}

export function mealsPaths() {
  return {
    '/api/v1/meals': {
      get: op({
        summary: 'List meal plan entries',
        tag: 'Meals',
        description: `Returns the meals of one week (\`?week=YYYY-MM-DD\`, any date of that week; default: the current week) with their ingredients. ${COOK_READ_NOTE}`,
      }),
      post: op({
        summary: 'Create meal plan entry',
        tag: 'Meals',
        description: `Creates one meal and returns it. ${COOK_READ_NOTE}`,
        stateChanging: true,
        requestBody: mealBody({ required: ['date', 'meal_type', 'title'], create: true }),
      }),
    },
    '/api/v1/meals/suggestions': { get: op({ summary: 'Get meal suggestions', tag: 'Meals' }) },
    '/api/v1/meals/{id}': {
      put: op({
        summary: 'Update meal plan entry',
        tag: 'Meals',
        description: 'Changes this meal alone. With `?scope=series` on a meal of a weekly series, the content fields are written to the series and to every meal created from it. `cook_user_id` follows the same choice: without `scope` it changes the cook of this meal and leaves the series untouched; with `scope=series` it reaches the series and all its meals. A missing `cook_user_id` leaves every cook as it is - in a series edit as well, so a meal whose cook was changed on its own keeps it. `repeat_until` and `ingredients` are read with `scope=series` only.',
        params: [idParam()],
        stateChanging: true,
        requestBody: mealBody(),
      }),
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
        description: 'Body: { assignments, replace_existing?, skip_occupied? }. Creates one meal per assignment (`date`, `meal_type`, `title`, optional `notes`, `recipe_url`, `recipe_id`, `cook_user_id`, `ingredients`) in a single transaction and returns them. Without `replace_existing` or `skip_occupied`, nothing is skipped or overwritten: the new meals are added next to any meal already planned for the same date and meal type. With `replace_existing: true`, every meal already planned for a date and meal type pair named in `assignments` is deleted first (an occurrence of a weekly series is excepted from the series, so it does not come back); other slots stay untouched. With `skip_occupied: true`, an assignment whose date and meal type pair already holds a meal before the call is not created and is listed in `skipped` instead, with its position in `assignments` as `index`; an occurrence of a weekly series counts as a meal even if its week was never opened, a deleted occurrence does not. Several assignments for the same pair that was empty before the call are all created. `skip_occupied` and `replace_existing` together are refused with 400. If any assignment is invalid or names an unknown recipe, the request is refused with 400 and nothing is written.',
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
                        cook_user_id: COOK_PROPERTY,
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
          400: { description: 'Missing or invalid assignments, an unknown recipe_id, a `cook_user_id` that is not a household member, `skip_occupied` that is not a boolean, or `skip_occupied` together with `replace_existing`. Nothing is written.' },
          401: { $ref: '#/components/responses/Unauthorized' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
  };
}
