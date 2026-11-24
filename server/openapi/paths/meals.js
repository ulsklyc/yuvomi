import { op, idParam, withCaseReasons, withValidationRefusal } from '../helpers.js';
import { OPTIONAL_DATE_PATTERN } from '../../utils/datetime-pattern.js';
import { MEAL_DELETE_SCOPES, MEAL_TYPES, MEAL_UPDATE_SCOPES } from '../../services/meals-fields.js';
import { HANDOVER_LIMIT_NOTE, MAX_INGREDIENTS, MAX_MEAL_ASSIGNMENTS } from '../array-limits.js';

// ---------------------------------------------------------------------------
// Bausteine der Anfrage-Schemata (#2810, Gruppe 7). Die Wertelisten kommen aus
// derselben Quelle, aus der die Route prueft (server/services/meals-fields.js),
// nie als Abschrift. Laengen bleiben im Handler: er zaehlt nach dem Trimmen.
// ---------------------------------------------------------------------------

/**
 * A JSON body. `{}` sent on purpose counts as sent; a call without a body is 400.
 * @param {Record<string, unknown>} schema
 */
const body = (schema) => ({
  required: true,
  description: 'JSON request body. Fields the schema does not name are ignored.',
  content: { 'application/json': { schema: { type: 'object', additionalProperties: true, ...schema } } },
});

const LEGACY_NOTE = 'Digit text is accepted as a legacy form.';

/**
 * The recipe a meal is planned from: a whole number, digit text as the legacy
 * form, `null` for none. Whether the recipe exists is the route's check
 * (`meals_selected_recipe_not_found`).
 */
const RECIPE_ID = {
  anyOf: [{ type: 'integer' }, { type: 'string', pattern: '^0*[1-9][0-9]*$' }, { type: 'null' }],
  description: `The recipe this meal is planned from, or \`null\` for none. ${LEGACY_NOTE} Until #2810 any number form was read (\`"0x10"\` as 16, \`true\` as 1).`,
};

// Der Koch einer Mahlzeit (#1679). EINE Beschreibung fuer jede Stelle, die ihn
// annimmt - anlegen, bearbeiten, apply-plan. Die Form ist die von `cookField()`
// (server/services/meal-cook.js): eine positive ganze Zahl oder dieselbe als
// Ziffernfolge ohne fuehrende Null.
const COOK_PROPERTY = {
  anyOf: [
    { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    { type: 'string', pattern: '^[1-9][0-9]*$' },
    { type: 'null' },
  ],
  description: `The household member who cooks this meal, or \`null\` for nobody. The id is a positive integer; ${LEGACY_NOTE} An empty string, a fraction or any other form is refused with 400. Only a household member can be chosen: housekeeping staff, split-expense guests, wall tablets and deactivated accounts are refused with 400, and an id that belongs to no account gets the same answer. A cook that is already stored on the meal stays valid; for \`scope=series\` that is the cook stored on the series.`,
};

const COOK_READ_NOTE = 'A meal carries its cook next to `created_by`: `cook_user_id` (or `null`), `cook_name` and `cook_color`. The picture of the cook is not repeated on every meal; it is on the member (`GET /api/v1/family/members`; a scoped token needs `family:read` for it, `meals:read` alone is refused there with 403). A meal of a weekly series also names the cook stored on the series as `recurrence_cook_user_id`, which can differ from its own.';

const MEAL_TYPE = { type: 'string', enum: [...MEAL_TYPES] };
const TITLE = { type: 'string', description: 'Checked by the route after trimming.' };
const NOTES = { type: ['string', 'null'], description: '`null` or `""` means none.' };
const RECIPE_URL = { type: ['string', 'null'], description: '`null` or `""` means none.' };
/** The last day of a weekly series; empty or `null` means it never ends. Whether the day exists is the route's check. */
const REPEAT_UNTIL = { type: ['string', 'null'], pattern: OPTIONAL_DATE_PATTERN };

/**
 * One ingredient of a meal. The route reads `name`, `quantity` and `category`
 * one by one; `id` is what the page keeps of a stored row and is ignored.
 * @param {{ nameRequired?: boolean }} [options]
 */
const ingredient = ({ nameRequired = false } = {}) => ({
  type: 'object',
  additionalProperties: true,
  ...(nameRequired ? { required: ['name'] } : {}),
  properties: {
    name: { type: 'string', description: 'Checked by the route after trimming; an ingredient without a name is left out.' },
    quantity: { type: ['string', 'null'] },
    category: { type: ['string', 'null'], description: 'A shopping category name; empty or `null`: the default one.' },
    id: { anyOf: [{ type: 'integer' }, { type: 'string' }, { type: 'null' }], description: 'Ignored.' },
  },
});
const INGREDIENTS = { type: 'array', maxItems: MAX_INGREDIENTS, items: ingredient() };

// Anlegen und Bearbeiten nehmen dieselben Felder; nur was Pflicht ist und was
// die Serie betrifft, unterscheidet sie. `repeat_weekly` gibt es nur beim
// Anlegen; `repeat_until` und `ingredients` nimmt PUT ebenfalls, aber allein
// mit `scope=series` - ohne den Umfang liest die Route sie nicht.
function mealBody({ required = [], create = false } = {}) {
  return body({
    ...(required.length ? { required } : {}),
    properties: {
      date: { type: 'string', format: 'date' },
      meal_type: MEAL_TYPE,
      title: TITLE,
      notes: NOTES,
      recipe_url: RECIPE_URL,
      recipe_id: RECIPE_ID,
      cook_user_id: COOK_PROPERTY,
      ...(create ? {
        repeat_weekly: { type: 'boolean', default: false, description: 'Create a weekly series from this meal. The series stores the cook as well, and every meal created from it starts with that cook.' },
        repeat_until: { ...REPEAT_UNTIL, description: 'Last date of the series as `YYYY-MM-DD`; empty, `null` or missing means it never ends. Read only with `repeat_weekly: true`.' },
        ingredients: INGREDIENTS,
      } : {
        repeat_until: { ...REPEAT_UNTIL, description: 'Only with `scope=series`: the last date of the series as `YYYY-MM-DD`. An empty string (or `null`) removes the end, a missing field leaves it as it is. Meals of the series after the new end are deleted. A date before the start of the series is refused with 400.' },
        ingredients: { ...INGREDIENTS, description: 'Only with `scope=series`: replaces the ingredients of the series and of every meal created from it. Without `scope` the field is ignored; the ingredients of a single meal are changed through `/api/v1/meals/{id}/ingredients` and `/api/v1/meals/ingredients/{ingId}`.' },
      }),
    },
  });
}

const QUERY_NOTE = 'A doubled value or a value outside its type is 400.';
const mealId = () => idParam('id', 'Meal ID, plain decimal digits.');
const ingredientId = () => idParam('ingId', 'Ingredient ID, plain decimal digits.');
/** The target list of a transfer: a whole number (until #2810 also text, `true` or an object, the last two answering 500). */
const LIST_ID = { type: 'integer', minimum: 1, description: 'The shopping list (GET /api/v1/shopping), a whole number.' };
/**
 * `?scope=` of PUT and DELETE. Until #2810 an unknown value fell back
 * silently to "this meal only" - on DELETE it removed a meal.
 * @param {readonly string[]} values
 * @param {string} description
 */
const scopeQuery = (values, description) => ({
  name: 'scope', in: 'query', required: false, schema: { type: 'string', enum: [...values] },
  description: `${description} ${QUERY_NOTE}`,
});

// Der Transfer schreibt in den Einkauf: Recht vor jeder Pruefung der Anfrage,
// dann das Schema, dann die Zeilen.
const TRANSFER_ORDER = 'The shopping write right is checked first (403, also for a malformed request); then a request outside the schema is a 400 before the meal or the list is looked up.';
const transferResponses = () => ({
  200: { description: 'Successful response' },
  400: { $ref: '#/components/responses/BadRequest' },
  401: { $ref: '#/components/responses/Unauthorized' },
  403: { $ref: '#/components/responses/Forbidden' },
  404: { description: 'The meal or the shopping list does not exist.' },
  500: { $ref: '#/components/responses/InternalServerError' },
});

export function mealsPaths() {
  return withCaseReasons('meals', CASE_REASONS, {
    '/api/v1/meals': {
      get: withValidationRefusal(op({
        summary: 'List meal plan entries',
        tag: 'Meals',
        description: `Returns the meals of one week (\`?week=YYYY-MM-DD\`, any date of that week; default: the current week) with their ingredients. ${COOK_READ_NOTE}`,
        params: [{
          name: 'week', in: 'query', required: false, schema: { type: 'string', format: 'date' },
          description: `Any day of the wanted week, \`YYYY-MM-DD\`; left out: the current week of the household. A day that does not exist (\`2026-02-30\`, \`2026-13-45\`), another form or an empty value is 400; until #2810 another form fell back silently to the current week, a month or day out of range answered 500, and \`2026-02-30\` rolled over into March. ${QUERY_NOTE}`,
        }],
      })),
      post: withValidationRefusal(op({
        summary: 'Create meal plan entry',
        tag: 'Meals',
        description: `Creates one meal and returns it. ${COOK_READ_NOTE}`,
        stateChanging: true,
        requestBody: mealBody({ required: ['date', 'meal_type', 'title'], create: true }),
      })),
    },
    '/api/v1/meals/suggestions': {
      get: withValidationRefusal(op({
        summary: 'Get meal suggestions',
        tag: 'Meals',
        params: [{ name: 'q', in: 'query', required: false, schema: { type: 'string' }, description: `The start of a title; empty or left out: no suggestions. ${QUERY_NOTE}` }],
      })),
    },
    '/api/v1/meals/{id}': {
      put: withValidationRefusal(op({
        summary: 'Update meal plan entry',
        tag: 'Meals',
        description: 'Every field is optional: a field left out stays as it is. Changes this meal alone. With `?scope=series` on a meal of a weekly series, the content fields are written to the series and to every meal created from it. `cook_user_id` follows the same choice: without `scope` it changes the cook of this meal and leaves the series untouched; with `scope=series` it reaches the series and all its meals. A missing `cook_user_id` leaves every cook as it is - in a series edit as well, so a meal whose cook was changed on its own keeps it. `repeat_until` and `ingredients` are read with `scope=series` only; there `ingredients`, when sent, replaces the whole list. A request outside the schema is a 400 before the meal is looked up, so it comes before a 404.',
        params: [mealId(), scopeQuery(MEAL_UPDATE_SCOPES, '`single` (this meal; the same as leaving it out) or `series` (the whole weekly series; on a meal outside a series it changes this meal alone).')],
        stateChanging: true,
        requestBody: mealBody(),
      })),
      delete: withValidationRefusal(op({
        summary: 'Delete meal plan entry',
        tag: 'Meals',
        description: 'On a meal of a weekly series, `scope` says how much goes: `single` (this meal; the series skips this date), `future` (this meal and every later one; the series ends the day before) or `series` (the whole series). On a meal outside a series every scope deletes this meal. Until #2810 an unknown `scope` deleted this meal as well.',
        params: [mealId(), scopeQuery(MEAL_DELETE_SCOPES, '`single` (the same as leaving it out), `future` or `series`.')],
        stateChanging: true,
      })),
    },
    '/api/v1/meals/{id}/ingredients': {
      post: withValidationRefusal(op({
        summary: 'Add meal ingredient',
        tag: 'Meals',
        params: [mealId()],
        stateChanging: true,
        requestBody: body({ required: ['name'], properties: ingredient().properties }),
      })),
    },
    '/api/v1/meals/ingredients/{ingId}': {
      patch: withValidationRefusal(op({
        summary: 'Update meal ingredient',
        tag: 'Meals',
        description: 'Every field is optional: a field left out stays as it is.',
        params: [ingredientId()],
        stateChanging: true,
        requestBody: body({
          properties: {
            name: { type: ['string', 'null'], description: 'Checked by the route after trimming; `null` keeps the stored name.' },
            quantity: { type: ['string', 'null'], description: '`null` or `""` means none.' },
            category: { type: ['string', 'null'], description: 'A shopping category name; empty or `null`: the default one.' },
            on_shopping_list: { anyOf: [{ type: 'boolean' }, { type: 'integer', enum: [0, 1] }], description: 'Whether the ingredient is on the shopping list: `true`/`false` or `1`/`0`.' },
          },
        }),
      })),
      delete: withValidationRefusal(op({ summary: 'Delete meal ingredient', tag: 'Meals', params: [ingredientId()], stateChanging: true })),
    },
    // Der Pfad sagt `meals`, geschrieben wird in den Einkauf - also steht auch
    // die 403 ausgeschrieben, wie bei /birthdays/import (#1290).
    '/api/v1/meals/{id}/to-shopping-list': {
      post: op({
        summary: 'Transfer meal ingredients to shopping list',
        tag: 'Meals',
        description: 'An open (unchecked) item of the same name on the list - compared trimmed, with whitespace collapsed and case-insensitive - means the ingredient is skipped and counted in `skipped` instead of being added twice; rows of one name in one transfer become one item. This is the one rule of every kitchen path to the shopping list (recipe, meal, meal-plan import, pantry). A meal planned from a recipe gets the recipe ingredients as its own on the first transfer. The response carries `added_ids` and `ingredient_ids` for POST /api/v1/shopping/items/undo-transfer. ' + 'Creates shopping items, so it requires write access to the `shopping` module in addition to `meals` - a credential scoped to the meal plan alone is refused with 403. ' + TRANSFER_ORDER + HANDOVER_LIMIT_NOTE,
        params: [mealId()],
        stateChanging: true,
        requestBody: body({ required: ['listId'], properties: { listId: LIST_ID } }),
        responses: transferResponses(),
      }),
    },
    '/api/v1/meals/week-to-shopping-list': {
      post: op({
        summary: 'Transfer weekly meal ingredients to shopping list',
        tag: 'Meals',
        description: 'An open (unchecked) item of the same name on the list - compared trimmed, with whitespace collapsed and case-insensitive - means the ingredient is skipped and counted in `skipped` instead of being added twice; rows of one name in one transfer become one item. This is the one rule of every kitchen path to the shopping list (recipe, meal, meal-plan import, pantry). Meals planned from a recipe are included (their recipe ingredients become their own). ' + 'Creates shopping items, so it requires write access to the `shopping` module in addition to `meals` - a credential scoped to the meal plan alone is refused with 403. ' + TRANSFER_ORDER + HANDOVER_LIMIT_NOTE,
        stateChanging: true,
        requestBody: body({
          required: ['listId', 'week'],
          properties: {
            listId: LIST_ID,
            week: { type: 'string', format: 'date', description: 'Any day of the week, `YYYY-MM-DD`. A day that does not exist is 400 (until #2810 a month or day out of range answered 500).' },
          },
        }),
        responses: transferResponses(),
      }),
    },
    '/api/v1/meals/apply-plan': {
      post: op({
        summary: 'Apply a set of planned meals at once',
        tag: 'Meals',
        description: 'Body: { assignments, replace_existing?, skip_occupied? }. Creates one meal per assignment (`date`, `meal_type`, `title`, optional `notes`, `recipe_url`, `recipe_id`, `cook_user_id`, `ingredients`) in a single transaction and returns them. Without `replace_existing` or `skip_occupied`, nothing is skipped or overwritten: the new meals are added next to any meal already planned for the same date and meal type. With `replace_existing: true`, every meal already planned for a date and meal type pair named in `assignments` is deleted first (an occurrence of a weekly series is excepted from the series, so it does not come back); other slots stay untouched. With `skip_occupied: true`, an assignment whose date and meal type pair already holds a meal before the call is not created and is listed in `skipped` instead, with its position in `assignments` as `index`; an occurrence of a weekly series counts as a meal even if its week was never opened, a deleted occurrence does not. Several assignments for the same pair that was empty before the call are all created. `skip_occupied` and `replace_existing` together are refused with 400. If any assignment is invalid or names an unknown recipe, the request is refused with 400 and nothing is written.',
        stateChanging: true,
        requestBody: body({
          required: ['assignments'],
          properties: {
            assignments: {
              type: 'array',
              minItems: 1,
              maxItems: MAX_MEAL_ASSIGNMENTS,
              items: {
                type: 'object',
                additionalProperties: true,
                required: ['date', 'meal_type', 'title'],
                properties: {
                  date: { type: 'string', format: 'date' },
                  meal_type: MEAL_TYPE,
                  title: TITLE,
                  notes: NOTES,
                  recipe_url: RECIPE_URL,
                  recipe_id: RECIPE_ID,
                  cook_user_id: COOK_PROPERTY,
                  ingredients: INGREDIENTS,
                },
              },
            },
            replace_existing: { type: 'boolean', default: false, description: 'Delete the meals of every named date and meal type pair first.' },
            skip_occupied: { type: 'boolean', default: false, description: 'Only fill pairs that are empty before the call; the others come back in `skipped`. Must be a JSON boolean (anything else is refused with 400). Cannot be combined with `replace_existing`.' },
          },
        }),
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
                          meal_type: MEAL_TYPE,
                          reason: { type: 'string', enum: ['occupied'] },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          400: { description: 'Missing or invalid assignments, an unknown recipe_id, a `cook_user_id` that is not a household member, `skip_occupied` that is not a boolean, or `skip_occupied` together with `replace_existing`. Nothing is written. A body outside the schema carries `reason: "validation"` and `fields`.' },
          401: { $ref: '#/components/responses/Unauthorized' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
  });
}

// #1909: die Faelle, die ein Nutzer erreicht, tragen einen `reason` neben dem
// englischen `error` - je Operation der Satz, der sie nennt.
const SELECTED_RECIPE_GONE = '`meals_selected_recipe_not_found` (400, the chosen `recipe_id` does not exist)';
const SHOPPING_WRITE_REQUIRED = '`cross_module_access` (403, the caller has no write access to the shopping module - for API tokens a `shopping:write` scope)';
const CASE_REASONS = {
  '/api/v1/meals': { post: SELECTED_RECIPE_GONE },
  '/api/v1/meals/{id}': { put: SELECTED_RECIPE_GONE },
  '/api/v1/meals/apply-plan': { post: SELECTED_RECIPE_GONE },
  '/api/v1/meals/{id}/to-shopping-list': { post: SHOPPING_WRITE_REQUIRED },
  '/api/v1/meals/week-to-shopping-list': { post: SHOPPING_WRITE_REQUIRED },
};
