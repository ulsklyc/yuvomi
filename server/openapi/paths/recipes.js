import { op, jsonBody, idParam } from '../helpers.js';

export function recipesPaths() {
  return {
    '/api/v1/recipes': {
      get: op({ summary: 'List recipes', tag: 'Recipes' }),
      post: op({ summary: 'Create recipe', tag: 'Recipes', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/recipes/{id}': {
      put: op({ summary: 'Update recipe', tag: 'Recipes', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
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
    '/api/v1/recipes/{id}/image': {
      get: op({ summary: "Fetch a recipe's own uploaded image", tag: 'Recipes', params: [idParam()], description: "Returns the image stored on the recipe itself, for recipes typed into Yuvomi rather than mirrored from a provider. It is a route and not a field on the recipe: the column holds a data URL of up to 5 MB, and shipping that with every row of a recipe list or a week of meals would dwarf the rest of the response for a 32-pixel preview. The lists carry a `has_own_image` flag instead. 404 when the recipe has no image of its own." }),
    },
    '/api/v1/recipes/{id}/provider-thumbnail': {
      get: op({ summary: 'Fetch the image of an imported recipe', tag: 'Recipes', params: [idParam()], description: 'Proxies the bytes from the recipe provider. A direct <img src> to the provider is not possible: its media route wants the same bearer token as every other endpoint, and that token must never reach the client. Same arrangement as the DMS preview proxy.' }),
    },
  };
}
