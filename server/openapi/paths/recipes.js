import { op, idParam, withCaseReasons, withValidationRefusal } from '../helpers.js';
import { MAX_SHORT, MAX_TEXT, MAX_TITLE } from '../../middleware/validate.js';

// Dieselbe Form wie in paths/family.js.
const apiError = (description) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
});

// Die echten Statuscodes (#2810): POST antwortet 201, DELETE 204.
const CREATED = {
  201: { description: 'Recipe created' },
  400: { $ref: '#/components/responses/BadRequest' },
  401: { $ref: '#/components/responses/Unauthorized' },
  500: { $ref: '#/components/responses/InternalServerError' },
};
const NO_CONTENT = {
  204: { description: 'Recipe deleted' },
  400: { $ref: '#/components/responses/BadRequest' },
  401: { $ref: '#/components/responses/Unauthorized' },
  403: { $ref: '#/components/responses/Forbidden' },
  404: apiError('No such recipe'),
  500: { $ref: '#/components/responses/InternalServerError' },
};

const RECIPE_ID = 'Recipe ID, plain decimal digits.';

// Die Grenze von validateRecipeImage() in server/routes/recipes.js (~5 MB Rohbild in base64).
const MAX_RECIPE_IMAGE_LENGTH = 6_990_507;

/**
 * The request body of POST /recipes and PUT /recipes/{id} (#2810): what the
 * route lives with - null for "no value" where it reads it so, `meal_types` as
 * a list or as comma text. The ingredient texts carry no length: the route
 * cuts them to 200/100/100 characters, and the app's forms have no limit there.
 * @param {{ replace: boolean }} options
 */
function recipeInput({ replace }) {
  return {
    required: true,
    description: 'JSON request body',
    content: {
      'application/json': {
        schema: {
          type: 'object',
          required: ['title'],
          properties: {
            title: {
              type: 'string',
              maxLength: MAX_TITLE,
              description: `At most ${MAX_TITLE} characters as sent; empty after trimming spaces is refused.`,
            },
            notes: {
              type: ['string', 'null'],
              maxLength: MAX_TEXT,
              description: `Free text, at most ${MAX_TEXT} characters. \`null\` or \`""\` means none.${replace ? ' Left out, it is cleared.' : ''}`,
            },
            recipe_url: {
              type: ['string', 'null'],
              maxLength: MAX_TEXT,
              description: `A link to the source, at most ${MAX_TEXT} characters; not checked as an address. \`null\` or \`""\` means none.${replace ? ' Left out, it is cleared.' : ''}`,
            },
            // Strict mode refuses a union type with `items`: one branch per shape.
            meal_types: {
              anyOf: [
                { type: 'array', items: { type: 'string' } },
                { type: 'string' },
                { type: 'null' },
              ],
              description: 'The meals the recipe suits (`breakfast`, `lunch`, `dinner`, `snack`), as a list or as comma-separated text. Unknown entries are dropped; an empty list or `""` means none. '
                + (replace ? 'Left out, the stored choice stays; `null` means all four.' : 'Left out or `null`, all four.'),
            },
            image_data: {
              type: ['string', 'null'],
              maxLength: MAX_RECIPE_IMAGE_LENGTH,
              description: `The recipe's own image as a data URL (PNG, JPEG, WebP or GIF in base64), at most ${MAX_RECIPE_IMAGE_LENGTH} characters; its content must match the declared type. Left out, the stored image stays; \`null\` or \`""\` removes it.`,
            },
            servings: {
              type: ['integer', 'null'],
              minimum: 1,
              maximum: 99,
              description: `How many portions the quantities are for, a whole number from 1 to 99; \`null\` means not stated.${replace ? ' Left out, the stored value stays.' : ''}`,
            },
            ingredients: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'Trimmed and cut to 200 characters; a row without a name is skipped.' },
                  quantity: { type: ['string', 'null'], description: 'Free text such as "200 g", cut to 100 characters; `null` or `""` means none.' },
                  category: { type: ['string', 'null'], description: 'A shopping category name, cut to 100 characters; empty means `Sonstiges`.' },
                },
              },
              description: replace
                ? 'The whole ingredient list, a list of objects. Left out, the recipe has no ingredients afterwards: this is a full replace.'
                : 'The ingredient list, a list of objects; left out, the recipe has none.',
            },
          },
        },
      },
    },
  };
}

export function recipesPaths() {
  return withCaseReasons('recipes', CASE_REASONS, {
    '/api/v1/recipes': {
      get: op({ summary: 'List recipes', tag: 'Recipes', description: 'Every ingredient carries `pantry_item_id` and `pantry_item_name`, the household\'s own confirmed match to one row of its pantry, both `null` when there is none. They name a row of the `pantry` module although this path belongs to `meals`, so they are also `null` for a member whose pantry access is `none` and for a token that carries no pantry scope - the ingredient itself stays, simply unmatched.' }),
      post: op({
        summary: 'Create recipe',
        tag: 'Recipes',
        stateChanging: true,
        requestBody: recipeInput({ replace: false }),
        description: '`servings` (optional, a whole number from 1 to 99, or `null`) says how many portions the ingredient quantities are for; `null` means not stated. The app scales the quantities from it and never invents a number for a recipe that has none. '
          + 'A body outside the schema (a text field that is not text, `ingredients` that is not a list of objects, `servings` as text) answers 400 with `fields`. Unknown fields are ignored.',
        responses: CREATED,
      }),
    },
    '/api/v1/recipes/{id}': {
      put: withValidationRefusal(op({
        summary: 'Update recipe',
        tag: 'Recipes',
        description: 'Replaces the recipe including its whole ingredient list - the ingredient rows are deleted and reinserted, so their ids change on every save. Confirmed pantry matches are keyed by the ingredient name and survive that; a match whose ingredient is no longer in the recipe is deleted in the same transaction rather than left behind, so renaming an ingredient really drops its match instead of hiding one that could come back. The response follows the same pantry-access rule as the list. `servings` behaves like the image: left out it stays as stored, `null` clears it, otherwise a whole number from 1 to 99. '
          + 'A full replace: only `title` is required, and `notes`, `recipe_url` and `ingredients` left out are cleared; `image_data`, `servings` and `meal_types` left out stay. '
          + 'The body is checked against the schema before the recipe is looked up, so a malformed body for a missing or mirrored recipe answers 400, not 404 or 403.',
        params: [idParam('id', RECIPE_ID)],
        stateChanging: true,
        requestBody: recipeInput({ replace: true }),
      })),
      delete: op({ summary: 'Delete recipe', tag: 'Recipes', params: [idParam('id', RECIPE_ID)], stateChanging: true, responses: NO_CONTENT }),
    },
    '/api/v1/recipes/{id}/to-shopping-list': {
      post: op({
        summary: 'Transfer recipe ingredients to shopping list',
        tag: 'Recipes',
        description: 'An open (unchecked) item of the same name on the list - compared trimmed, with whitespace collapsed and case-insensitive - means the ingredient is skipped and counted in `skipped` instead of being added twice; rows of one name in one transfer become one item. This is the one rule of every kitchen path to the shopping list (recipe, meal, meal-plan import, pantry). ' + 'An optional `quantities` array - one text (or `null`) per ingredient - replaces the stored quantities for this transfer, so a recipe viewed for another number of servings hands over the scaled amounts; names and categories stay the recipe\'s. With `quantities`, `ingredientIds` is required: the `id` of each ingredient as `GET /recipes` returned it, one per quantity in the same order; a missing or malformed list answers 400. Saving a recipe or syncing it from a provider recreates its ingredient rows, so when the ids no longer match the recipe as it is now, nothing is transferred and the answer is 409 `recipes_ingredients_changed` with the current recipe in `recipe`, instead of putting amounts on the wrong ingredients. Without `quantities` the stored amounts are used and `ingredientIds` is ignored (when sent it must still be a list of whole numbers from 1). ' + 'Creates shopping items, so it requires write access to the `shopping` module in addition to `meals` (which owns `/recipes`) - a credential scoped to the recipes alone is refused with 403, for any body. Then the body is checked against the schema (`listId` a whole number, `quantities` a list of texts or null, `ingredientIds` a list of whole numbers), before the recipe and the list are looked up.',
        params: [idParam('id', RECIPE_ID)],
        stateChanging: true,
        requestBody: {
          required: true,
          description: 'JSON request body',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['listId'],
                properties: {
                  listId: { type: 'integer', description: 'The shopping list to add to.' },
                  quantities: {
                    type: 'array',
                    items: { type: ['string', 'null'], maxLength: MAX_SHORT },
                    description: `One text (at most ${MAX_SHORT} characters) or \`null\` per ingredient, in the order of \`ingredientIds\`.`,
                  },
                  ingredientIds: {
                    type: 'array',
                    items: { type: 'integer', minimum: 1 },
                    description: 'The ingredient row ids the quantities belong to; required with `quantities`, ignored without.',
                  },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Successful response' },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          409: { description: 'The recipe\'s ingredients changed since `ingredientIds` were loaded; `recipe` carries the current recipe' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/recipes/{id}/ingredient-match': {
      put: op({
        summary: 'Confirm which stock row a recipe ingredient means',
        tag: 'Recipes',
        description: 'Stores the household\'s own confirmed match between one ingredient of this recipe and one row of its pantry, or clears it with `pantryItemId: null`. Body: `{ name, pantryItemId }`. Nothing else in Yuvomi ever writes this link - no import, no recipe save, and no name similarity: a guessed identity would be a product catalogue built one inference at a time, which is declined (see #714). The match is keyed by the ingredient name, not by its row id, because saving a recipe replaces all of its ingredient rows. It requires write access to the `pantry` module in addition to `meals` (which owns `/recipes`) - a credential scoped to the recipes alone is refused with 403, for any body. Then the body is checked against the schema (`name` text of at most 200 characters, `pantryItemId` a whole number or null), before the recipe is looked up. `pantryItemId` left out clears the match like `null`. 404 when the recipe, the ingredient or the stock row does not exist.',
        params: [idParam('id', RECIPE_ID)],
        stateChanging: true,
        requestBody: {
          required: true,
          description: 'JSON request body',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: {
                  name: { type: 'string', maxLength: MAX_TITLE, description: 'The ingredient as named in the recipe; compared trimmed, case-insensitive, with collapsed spaces.' },
                  pantryItemId: { type: ['integer', 'null'], description: 'The pantry item; `null` or left out clears the match.' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Successful response' },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { description: 'No such recipe, no such ingredient in it, or no such pantry item' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/recipes/{id}/image': {
      get: withValidationRefusal(op({ summary: "Fetch a recipe's own uploaded image", tag: 'Recipes', params: [idParam('id', RECIPE_ID)], description: "Returns the image stored on the recipe itself, for recipes typed into Yuvomi rather than mirrored from a provider. It is a route and not a field on the recipe: the column holds a data URL of up to 5 MB, and shipping that with every row of a recipe list or a week of meals would dwarf the rest of the response for a 32-pixel preview. The lists carry a `has_own_image` flag instead. 404 when the recipe has no image of its own." })),
    },
    '/api/v1/recipes/{id}/provider-thumbnail': {
      get: op({
        summary: 'Fetch the image of an imported recipe',
        tag: 'Recipes',
        params: [
          idParam('id', RECIPE_ID),
          {
            name: 'v',
            in: 'query',
            required: false,
            schema: { type: 'string' },
            description: 'The image version: `provider_updated_at` of the recipe (meal rows carry it as `recipe_image_version`). Keeps the address unique per version; the response is the same with or without it. Given at most once.',
          },
        ],
        description: 'Proxies the bytes from the recipe provider. A direct <img src> to the provider is not possible: its media route wants the same bearer token as every other endpoint, and that token must never reach the client. Same arrangement as the DMS preview proxy. '
          + 'The response carries `Cache-Control: private, no-cache` and an `ETag` derived from the image version, so a client revalidates on every use (through authentication and the module gate) and `If-None-Match` answers `304` without a request to the provider. Errors stay `no-store`.',
        responses: {
          200: {
            description: 'The image',
            content: {
              'image/png': { schema: { type: 'string', format: 'binary' } },
              'image/jpeg': { schema: { type: 'string', format: 'binary' } },
              'image/webp': { schema: { type: 'string', format: 'binary' } },
            },
          },
          304: { description: 'Unchanged since the given ETag; no request to the provider' },
          400: apiError('The recipe ID is not plain decimal digits, or `v` is given twice (`fields` names it, `reason: \'validation\'`)'),
          401: { $ref: '#/components/responses/Unauthorized' },
          404: apiError('Not an imported recipe, or no image at the provider'),
          415: apiError('The provider returned no image or a type outside PNG, JPEG and WebP'),
          502: apiError('The provider could not be reached'),
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
  });
}

// #1909: die Faelle, die ein Nutzer erreicht, tragen einen `reason` neben dem
// englischen `error` - je Operation der Satz, der sie nennt.
const RECIPE_GONE = '`recipes_recipe_not_found` (404, the recipe does not exist - deleted, or removed by the sync with its recipe provider)';
const MIRRORED = '`recipe_mirrored` (403, the recipe comes from a connected recipe provider and is changed there)';
const SHOPPING_WRITE_REQUIRED = '`cross_module_access` (403, the caller has no write access to the shopping module - for API tokens a `shopping:write` scope)';
const PANTRY_WRITE_REQUIRED = '`cross_module_access` (403, the caller has no write access to the pantry module - for API tokens a `pantry:write` scope)';
const CASE_REASONS = {
  '/api/v1/recipes/{id}': { put: `${RECIPE_GONE}, ${MIRRORED}`, delete: `${RECIPE_GONE}, ${MIRRORED}` },
  '/api/v1/recipes/{id}/to-shopping-list': {
    post: `${RECIPE_GONE}, \`shopping_list_not_found\` (404, the chosen shopping list does not exist), \`recipes_ingredients_changed\` (409, the ingredients changed since \`ingredientIds\` were loaded; \`recipe\` carries the current recipe), ${SHOPPING_WRITE_REQUIRED}`,
  },
  '/api/v1/recipes/{id}/ingredient-match': {
    put: `${RECIPE_GONE}, \`recipes_ingredient_not_found\` (404, the recipe no longer has this ingredient), \`recipes_selected_pantry_item_not_found\` (404, the chosen pantry item does not exist), ${PANTRY_WRITE_REQUIRED}`,
  },
};
