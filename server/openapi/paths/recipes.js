import { op, jsonBody, idParam, withCaseReasons } from '../helpers.js';

// Dieselbe Form wie in paths/family.js.
const apiError = (description) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
});

export function recipesPaths() {
  return withCaseReasons('recipes', CASE_REASONS, {
    '/api/v1/recipes': {
      get: op({ summary: 'List recipes', tag: 'Recipes', description: 'Every ingredient carries `pantry_item_id` and `pantry_item_name`, the household\'s own confirmed match to one row of its pantry, both `null` when there is none. They name a row of the `pantry` module although this path belongs to `meals`, so they are also `null` for a member whose pantry access is `none` and for a token that carries no pantry scope - the ingredient itself stays, simply unmatched.' }),
      post: op({ summary: 'Create recipe', tag: 'Recipes', stateChanging: true, requestBody: jsonBody(null), description: '`servings` (optional, a whole number from 1 to 99, or `null`) says how many portions the ingredient quantities are for; `null` means not stated. The app scales the quantities from it and never invents a number for a recipe that has none.' }),
    },
    '/api/v1/recipes/{id}': {
      put: op({
        summary: 'Update recipe',
        tag: 'Recipes',
        description: 'Replaces the recipe including its whole ingredient list - the ingredient rows are deleted and reinserted, so their ids change on every save. Confirmed pantry matches are keyed by the ingredient name and survive that; a match whose ingredient is no longer in the recipe is deleted in the same transaction rather than left behind, so renaming an ingredient really drops its match instead of hiding one that could come back. The response follows the same pantry-access rule as the list. `servings` behaves like the image: left out it stays as stored, `null` clears it, otherwise a whole number from 1 to 99.',
        params: [idParam()],
        stateChanging: true,
        requestBody: jsonBody(null),
      }),
      delete: op({ summary: 'Delete recipe', tag: 'Recipes', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/recipes/{id}/to-shopping-list': {
      post: op({
        summary: 'Transfer recipe ingredients to shopping list',
        tag: 'Recipes',
        description: 'An open (unchecked) item of the same name on the list - compared trimmed, with whitespace collapsed and case-insensitive - means the ingredient is skipped and counted in `skipped` instead of being added twice; rows of one name in one transfer become one item. This is the one rule of every kitchen path to the shopping list (recipe, meal, meal-plan import, pantry). ' + 'An optional `quantities` array - one text (or `null`) per ingredient - replaces the stored quantities for this transfer, so a recipe viewed for another number of servings hands over the scaled amounts; names and categories stay the recipe\'s. With `quantities`, `ingredientIds` is required: the `id` of each ingredient as `GET /recipes` returned it, one per quantity in the same order; a missing or malformed list answers 400. Saving a recipe or syncing it from a provider recreates its ingredient rows, so when the ids no longer match the recipe as it is now, nothing is transferred and the answer is 409 `recipes_ingredients_changed` with the current recipe in `recipe`, instead of putting amounts on the wrong ingredients. Without `quantities` the stored amounts are used and `ingredientIds` is ignored. ' + 'Creates shopping items, so it requires write access to the `shopping` module in addition to `meals` (which owns `/recipes`) - a credential scoped to the recipes alone is refused with 403.',
        params: [idParam()],
        stateChanging: true,
        requestBody: jsonBody(null),
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
        description: 'Stores the household\'s own confirmed match between one ingredient of this recipe and one row of its pantry, or clears it with `pantryItemId: null`. Body: `{ name, pantryItemId }`. Nothing else in Yuvomi ever writes this link - no import, no recipe save, and no name similarity: a guessed identity would be a product catalogue built one inference at a time, which is declined (see #714). The match is keyed by the ingredient name, not by its row id, because saving a recipe replaces all of its ingredient rows. It requires write access to the `pantry` module in addition to `meals` (which owns `/recipes`) - a credential scoped to the recipes alone is refused with 403. 404 when the recipe, the ingredient or the stock row does not exist.',
        params: [idParam()],
        stateChanging: true,
        requestBody: jsonBody(null),
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
      get: op({ summary: "Fetch a recipe's own uploaded image", tag: 'Recipes', params: [idParam()], description: "Returns the image stored on the recipe itself, for recipes typed into Yuvomi rather than mirrored from a provider. It is a route and not a field on the recipe: the column holds a data URL of up to 5 MB, and shipping that with every row of a recipe list or a week of meals would dwarf the rest of the response for a 32-pixel preview. The lists carry a `has_own_image` flag instead. 404 when the recipe has no image of its own." }),
    },
    '/api/v1/recipes/{id}/provider-thumbnail': {
      get: op({
        summary: 'Fetch the image of an imported recipe',
        tag: 'Recipes',
        params: [
          idParam(),
          {
            name: 'v',
            in: 'query',
            required: false,
            schema: { type: 'string' },
            description: 'The image version: `provider_updated_at` of the recipe (meal rows carry it as `recipe_image_version`). Keeps the address unique per version; the response is the same with or without it.',
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
          400: apiError('Invalid recipe ID'),
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
