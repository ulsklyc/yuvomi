import { op, jsonBody, idParam } from '../helpers.js';

export function recipesPaths() {
  return {
    '/api/v1/recipes': {
      get: op({ summary: 'List recipes', tag: 'Recipes', description: 'Every ingredient carries `pantry_item_id` and `pantry_item_name`, the household\'s own confirmed match to one row of its pantry, both `null` when there is none. They name a row of the `pantry` module although this path belongs to `meals`, so they are also `null` for a member whose pantry access is `none` and for a token that carries no pantry scope - the ingredient itself stays, simply unmatched.' }),
      post: op({ summary: 'Create recipe', tag: 'Recipes', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/recipes/{id}': {
      put: op({
        summary: 'Update recipe',
        tag: 'Recipes',
        description: 'Replaces the recipe including its whole ingredient list - the ingredient rows are deleted and reinserted, so their ids change on every save. Confirmed pantry matches are keyed by the ingredient name and survive that; a match whose ingredient is no longer in the recipe is deleted in the same transaction rather than left behind, so renaming an ingredient really drops its match instead of hiding one that could come back. The response follows the same pantry-access rule as the list.',
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
        description: 'Creates shopping items, so it requires write access to the `shopping` module in addition to `meals` (which owns `/recipes`) - a credential scoped to the recipes alone is refused with 403.',
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
      get: op({ summary: 'Fetch the image of an imported recipe', tag: 'Recipes', params: [idParam()], description: 'Proxies the bytes from the recipe provider. A direct <img src> to the provider is not possible: its media route wants the same bearer token as every other endpoint, and that token must never reach the client. Same arrangement as the DMS preview proxy.' }),
    },
  };
}
