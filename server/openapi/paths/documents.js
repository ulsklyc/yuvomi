import { op, jsonBody, idParam } from '../helpers.js';

export function documentsPaths() {
  return {
    '/api/v1/documents/meta/options': {
      get: op({
        summary: 'Get family document options',
        tag: 'Documents',
        description: 'Returns supported categories, visibility modes, statuses, legacy storage providers, the active upload backend, file size limit and MIME types.',
        responses: {
          200: {
            description: 'Document metadata options',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/DocumentOptionsResponse' } } },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/documents/storage/config': {
      get: op({
        summary: 'Get document-storage configuration',
        tag: 'Documents',
        admin: true,
        description: 'Returns the selected and effective upload destinations, local-folder override, WebDAV configuration and secret-free Google Drive status. Environment-controlled WebDAV fields are reported individually. Passwords and OAuth tokens are never returned.',
        responses: {
          200: {
            description: 'Effective document-storage status',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/DocumentStorageStatusResponse' } } },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
      put: op({
        summary: 'Update document-storage configuration',
        tag: 'Documents',
        admin: true,
        stateChanging: true,
        description: 'Updates the explicit upload destination and any DB-backed WebDAV fields not controlled by environment variables. Sending only `selected_upload_backend` leaves WebDAV fields unchanged. Google Drive must be connected before selection, and a successful OAuth callback never changes the selector. When WebDAV documents exist, connection changes require `confirm_existing_access: true` and a successful read check against an existing object. Use `clear_password: true` to explicitly remove a stored password.',
        requestBody: jsonBody('#/components/schemas/DocumentStorageConfigRequest'),
        responses: {
          200: {
            description: 'Updated effective document-storage status',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/DocumentStorageStatusResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          409: { description: 'Protected configuration change rejected', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/documents/storage/test': {
      post: op({
        summary: 'Test WebDAV document storage',
        tag: 'Documents',
        admin: true,
        stateChanging: true,
        description: 'Tests the effective hybrid configuration with a temporary PUT/GET/DELETE roundtrip in the target folder without persisting supplied connection fields.',
        requestBody: jsonBody('#/components/schemas/DocumentStorageTestRequest'),
        responses: {
          200: {
            description: 'Connection roundtrip succeeded',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/DocumentStorageTestResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          502: { description: 'Connection roundtrip failed', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/documents/storage/google-drive/auth': {
      get: op({
        summary: 'Start Google Drive document-storage OAuth',
        tag: 'Documents',
        admin: true,
        description: 'Creates a Drive-specific OAuth state value and redirects to Google with the least-privilege `drive.file` scope. Calendar OAuth state and tokens are not reused.',
        responses: {
          302: { description: 'Redirect to Google OAuth consent' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          502: { description: 'Google Drive OAuth is not configured' },
        },
      }),
    },
    '/api/v1/documents/storage/google-drive/callback': {
      get: op({
        summary: 'Complete Google Drive document-storage OAuth',
        tag: 'Documents',
        admin: true,
        stateChanging: true,
        description: 'Validates Drive-specific OAuth state and candidate credentials before replacing stored Drive tokens, then redirects to the Documents storage settings. A successful callback does not select Drive for uploads.',
        responses: {
          302: { description: 'Redirect to Documents storage settings with drive_ok or drive_error' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
        },
      }),
    },
    '/api/v1/documents/storage/google-drive/test': {
      post: op({
        summary: 'Test Google Drive document storage',
        tag: 'Documents',
        admin: true,
        stateChanging: true,
        description: 'Runs a temporary create, read, verify and delete roundtrip in the private Yuvomi/Documents folder.',
        responses: {
          200: {
            description: 'Connection roundtrip succeeded',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/DocumentStorageTestResponse' } } },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          502: { description: 'Connection roundtrip failed', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        },
      }),
    },
    '/api/v1/documents/storage/google-drive/disconnect': {
      delete: op({
        summary: 'Disconnect Google Drive document storage',
        tag: 'Documents',
        admin: true,
        stateChanging: true,
        description: 'Deletes only Yuvomi\'s local Drive token state. It does not revoke shared Google credentials. Disconnection is blocked while Drive is selected or Drive-backed documents exist.',
        responses: {
          200: {
            description: 'Google Drive disconnected',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/GoogleDriveStorageStatusResponse' } } },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          409: { description: 'Drive is selected or Drive-backed documents still exist', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        },
      }),
    },
    '/api/v1/documents/folders': {
      get: op({ summary: 'List document folders', tag: 'Documents' }),
      post: op({ summary: 'Create document folder', tag: 'Documents', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/documents/folders/{id}': {
      put: op({ summary: 'Rename document folder', tag: 'Documents', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete document folder (documents keep their row, folder link is cleared)', tag: 'Documents', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/documents': {
      get: op({
        summary: 'List family documents',
        tag: 'Documents',
        params: [
          {
            name: 'status',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['active', 'archived'], default: 'active' },
          },
          {
            name: 'category',
            in: 'query',
            required: false,
            schema: {
              type: 'string',
              enum: ['medical', 'school', 'identity', 'insurance', 'finance', 'home', 'vehicle', 'legal', 'travel', 'pets', 'warranty', 'taxes', 'work', 'other'],
            },
          },
        ],
        responses: {
          200: {
            description: 'Visible family documents',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/FamilyDocumentsResponse' } } },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
      post: op({
        summary: 'Upload family document',
        tag: 'Documents',
        stateChanging: true,
        description: 'Stores a document using the active upload backend (`local`, `webdav`, or `google_drive`) with family, restricted, or private visibility. File content is sent as a base64 data URL in `content_data`. An environment-managed local folder may override the selected destination.',
        requestBody: jsonBody(null),
        responses: {
          201: {
            description: 'Document created',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/FamilyDocumentResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          502: { description: 'Document-storage operation failed', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/documents/{id}': {
      put: op({
        summary: 'Update family document metadata',
        tag: 'Documents',
        params: [idParam()],
        stateChanging: true,
        description: 'Updates name, description, category, status, visibility and allowed member IDs. Only the owner or an admin can update a document.',
        requestBody: jsonBody(null),
        responses: {
          200: {
            description: 'Document metadata updated',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/FamilyDocumentResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { description: 'Document not found' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
      delete: op({
        summary: 'Delete family document',
        tag: 'Documents',
        params: [idParam()],
        stateChanging: true,
        description: 'Deletes a document. Only the owner or an admin can delete it.',
        responses: {
          204: { description: 'Document deleted' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { description: 'Document not found' },
          502: { description: 'Remote document deletion failed; the database row remains', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/documents/{id}/archive': {
      patch: op({
        summary: 'Archive or restore family document',
        tag: 'Documents',
        params: [idParam()],
        stateChanging: true,
        description: 'Archives the document by default. Send `{ "archived": false }` to restore it to active status.',
        requestBody: jsonBody(null),
      }),
    },
    '/api/v1/documents/{id}/preview': {
      get: op({
        summary: 'Preview family document file',
        tag: 'Documents',
        params: [idParam()],
        description: 'Returns inline bytes for supported previewable document types.',
        responses: {
          200: {
            description: 'Document preview bytes',
            content: {
              'application/octet-stream': {
                schema: { type: 'string', format: 'binary' },
              },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { description: 'Document not found' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/documents/{id}/download': {
      get: op({
        summary: 'Download family document file',
        tag: 'Documents',
        params: [idParam()],
        responses: {
          200: {
            description: 'Document file bytes',
            content: {
              'application/octet-stream': {
                schema: { type: 'string', format: 'binary' },
              },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { description: 'Document not found' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/documents/dms/accounts': {
      get: op({
        summary: 'List DMS accounts',
        tag: 'Documents',
        admin: true,
        description: 'Returns configured DMS accounts without the api_token. Each item includes `has_token` to indicate whether a token is stored.',
        responses: {
          200: {
            description: 'DMS accounts',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/DmsAccountsResponse' } } },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
      post: op({
        summary: 'Create DMS account',
        tag: 'Documents',
        admin: true,
        stateChanging: true,
        requestBody: jsonBody('#/components/schemas/DmsAccountCreateRequest'),
        responses: {
          201: {
            description: 'DMS account created',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/DmsAccountResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          409: { description: 'An account with this base_url already exists' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/documents/dms/accounts/{id}': {
      delete: op({
        summary: 'Delete DMS account',
        tag: 'Documents',
        admin: true,
        stateChanging: true,
        params: [idParam('id', 'DMS account ID')],
        responses: {
          204: { description: 'DMS account deleted' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { description: 'DMS account not found' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/documents/dms/accounts/{id}/test': {
      post: op({
        summary: 'Test DMS account connection',
        tag: 'Documents',
        admin: true,
        stateChanging: true,
        params: [idParam('id', 'DMS account ID')],
        responses: {
          200: {
            description: 'Connection test result',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/DmsTestResponse' } } },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/documents/dms/search': {
      get: op({
        summary: 'Search documents in a DMS account',
        tag: 'Documents',
        admin: true,
        params: [
          {
            name: 'account_id',
            in: 'query',
            required: true,
            schema: { type: 'integer' },
            description: 'DMS account ID to search in',
          },
          {
            name: 'q',
            in: 'query',
            required: false,
            schema: { type: 'string' },
            description: 'Search query string. When empty, all documents in the DMS account are listed.',
          },
        ],
        responses: {
          200: {
            description: 'DMS search results',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/DmsSearchResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { description: 'DMS account not found' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/documents/dms/link': {
      post: op({
        summary: 'Link a DMS document to the family document library',
        tag: 'Documents',
        admin: true,
        stateChanging: true,
        description: 'Creates a family_documents entry with legacy storage_provider `external` and storage_backend `dms`, pointing to a document already stored in the DMS.',
        requestBody: jsonBody('#/components/schemas/DmsLinkRequest'),
        responses: {
          201: {
            description: 'Document linked',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/DmsLinkResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { description: 'DMS document not found in the remote system' },
          409: { description: 'Document is already linked' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/documents/dms/push': {
      post: op({
        summary: 'Push a document to a DMS account',
        tag: 'Documents',
        admin: true,
        stateChanging: true,
        description: 'Uploads a document with storage_backend `local`, `webdav`, or `google_drive` to the specified DMS account. Only storage_backend `dms` means the document is already stored in the DMS. Returns a task ID for async tracking.',
        requestBody: jsonBody('#/components/schemas/DmsPushRequest'),
        responses: {
          202: {
            description: 'Push task accepted',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/DmsPushResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { description: 'Document or DMS account not found' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
  };
}
