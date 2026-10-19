import { op, jsonBody, idParam } from '../helpers.js';

export function quickLinksPaths() {
  return withCaseReasons({
    '/api/v1/quick-links': {
      get: op({
        summary: 'List quick links',
        tag: 'Quick links',
        description: 'Returns the tiles visible to the calling member. A private tile belongs to '
          + 'whoever created it and is not listed for anyone else.',
      }),
      post: op({
        summary: 'Create a quick link',
        tag: 'Quick links',
        stateChanging: true,
        requestBody: jsonBody(null),
        description: 'Body: { name, url, icon_data?, icon_name?, color?, visibility? }. A tile shows '
          + 'one of three faces: an uploaded image (`icon_data`), a built-in Lucide symbol '
          + '(`icon_name`), or the first letter of its name on `color`.',
      }),
    },
    '/api/v1/quick-links/order': {
      put: op({
        summary: 'Set the order of quick links',
        tag: 'Quick links',
        stateChanging: true,
        requestBody: jsonBody(null),
        description: 'Body: { ids }, the complete new order. Only ids the caller can actually see '
          + 'count: slipping someone else\'s private tile into the list does not move it, because it '
          + 'is not there for the caller, and an ordering is not a way to change that.',
      }),
    },
    '/api/v1/quick-links/{id}': {
      put: op({
        summary: 'Update a quick link',
        tag: 'Quick links',
        params: [idParam()],
        stateChanging: true,
        requestBody: jsonBody(null),
      }),
      delete: op({
        summary: 'Delete a quick link',
        tag: 'Quick links',
        params: [idParam()],
        stateChanging: true,
      }),
    },
  });
}

// #1909: die Faelle, die ein Nutzer erreicht, tragen einen `reason` neben dem
// englischen `error` - je Operation der Satz, der sie nennt.
const LINK_GONE = '`quick_links_link_not_found` (404, the tile was deleted or is private to someone else)';
const CASE_REASONS = {
  '/api/v1/quick-links': {
    post: '`quick_links_limit_reached` (400, the household has the maximum number of tiles; `params.limit` names it)',
  },
  '/api/v1/quick-links/{id}': { put: LINK_GONE, delete: LINK_GONE },
};

function withCaseReasons(paths) {
  for (const [path, operations] of Object.entries(CASE_REASONS)) {
    for (const [method, reasons] of Object.entries(operations)) {
      const operation = paths[path]?.[method];
      if (!operation) throw new Error(`openapi quick-links: ${method} ${path} is not documented`);
      const note = `A refusal a user can reach carries a \`reason\` next to \`error\` (#1909): ${reasons}.`;
      operation.description = operation.description ? `${operation.description}\n\n${note}` : note;
    }
  }
  return paths;
}
