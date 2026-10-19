import { op, jsonBody, idParam } from '../helpers.js';

const apiError = (description) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
});

const schemaResponse = (schema, description = 'Successful response', status = 200, extra = {}) => ({
  [status]: {
    description,
    content: { 'application/json': { schema: { $ref: `#/components/schemas/${schema}` } } },
  },
  400: { $ref: '#/components/responses/BadRequest' },
  401: { $ref: '#/components/responses/Unauthorized' },
  403: { $ref: '#/components/responses/Forbidden' },
  500: { $ref: '#/components/responses/InternalServerError' },
  ...extra,
});

const noContentResponse = (description, extra = {}) => ({
  204: { description },
  400: { $ref: '#/components/responses/BadRequest' },
  401: { $ref: '#/components/responses/Unauthorized' },
  403: { $ref: '#/components/responses/Forbidden' },
  500: { $ref: '#/components/responses/InternalServerError' },
  ...extra,
});

export function notesPaths() {
  return withCaseReasons({
    '/api/v1/notes': {
      get: op({ summary: 'List notes', tag: 'Notes', responses: schemaResponse('NoteListResponse') }),
      post: op({ summary: 'Create note', tag: 'Notes', stateChanging: true, requestBody: jsonBody('#/components/schemas/NoteCreateInput'), responses: schemaResponse('NoteResponse', 'Note created', 201, { 409: apiError('A selected category changed concurrently') }) }),
    },
    '/api/v1/notes/{id}': {
      put: op({ summary: 'Update note', tag: 'Notes', params: [idParam()], stateChanging: true, requestBody: jsonBody('#/components/schemas/NoteUpdateInput'), responses: schemaResponse('NoteResponse', 'Note updated', 200, { 404: apiError('Note not found'), 409: apiError('A selected category changed concurrently') }) }),
      delete: op({ summary: 'Delete note', tag: 'Notes', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/notes/{id}/pin': {
      patch: op({ summary: 'Toggle note pin state', tag: 'Notes', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/notes/{id}/check': {
      patch: op({
        summary: 'Tick one checklist item, addressed by its source line',
        tag: 'Notes',
        params: [idParam()],
        stateChanging: true,
        requestBody: jsonBody(null),
      }),
    },
    '/api/v1/notes/categories': {
      get: op({ summary: 'List visible note categories', tag: 'Notes', responses: schemaResponse('NoteCategoryListResponse') }),
      post: op({ summary: 'Create a personal or household note category', tag: 'Notes', stateChanging: true, requestBody: jsonBody('#/components/schemas/NoteCategoryInput'), responses: schemaResponse('NoteCategoryResponse', 'Category created', 201, { 409: apiError('A category with this name already exists') }) }),
    },
    '/api/v1/notes/categories/reorder': {
      patch: op({ summary: 'Reorder editable note categories within one scope', tag: 'Notes', stateChanging: true, requestBody: jsonBody('#/components/schemas/NoteCategoryReorderInput'), responses: schemaResponse('NoteCategoryListResponse', 'Categories reordered', 200, { 404: apiError('Category not found') }) }),
    },
    '/api/v1/notes/categories/{id}': {
      put: op({ summary: 'Rename a note category', tag: 'Notes', params: [idParam()], stateChanging: true, requestBody: jsonBody('#/components/schemas/NoteCategoryRenameInput'), responses: schemaResponse('NoteCategoryResponse', 'Category renamed', 200, { 404: apiError('Category not found'), 409: apiError('A category with this name already exists') }) }),
      delete: op({ summary: 'Delete a note category and its assignments', tag: 'Notes', params: [idParam()], stateChanging: true, responses: noContentResponse('Category deleted', { 404: apiError('Category not found') }) }),
    },
  });
}

// #1909: die Faelle, die ein Nutzer erreicht, tragen einen `reason` neben dem
// englischen `error` - je Operation der Satz, der sie nennt.
const NOTE_GONE = '`notes_note_not_found` (404, the note does not exist - deleted)';
const CATEGORY_GONE = '`notes_selected_category_not_found` (400 or 409, a category in `category_ids` does not exist or is not available to you)';
const CASE_REASONS = {
  '/api/v1/notes': { post: CATEGORY_GONE },
  '/api/v1/notes/{id}': { put: `${NOTE_GONE}, ${CATEGORY_GONE}`, delete: NOTE_GONE },
  '/api/v1/notes/{id}/pin': { patch: NOTE_GONE },
  '/api/v1/notes/{id}/check': { patch: NOTE_GONE },
  '/api/v1/notes/categories': { post: '`category_exists` (409, a category with this name already exists)' },
  '/api/v1/notes/categories/{id}': { put: '`category_exists` (409, a category with this name already exists)' },
};

function withCaseReasons(paths) {
  for (const [path, operations] of Object.entries(CASE_REASONS)) {
    for (const [method, reasons] of Object.entries(operations)) {
      const operation = paths[path]?.[method];
      if (!operation) throw new Error(`openapi notes: ${method} ${path} is not documented`);
      const note = `A refusal a user can reach carries a \`reason\` next to \`error\` (#1909): ${reasons}.`;
      operation.description = operation.description ? `${operation.description}\n\n${note}` : note;
    }
  }
  return paths;
}
