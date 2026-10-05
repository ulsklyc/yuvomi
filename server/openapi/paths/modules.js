import { jsonBody, op, stringPathParam } from '../helpers.js';
import { ZIP_LIMITS } from '../../services/zip-reader.js';

// Aus dem ZIP-Leser statt aus module-install.js: der zieht die Datenbank nach,
// und die Spec wird auch ohne sie gebaut (test:openapi-*).
const MAX_ZIP_MB = ZIP_LIMITS.maxCompressed / (1024 * 1024);

const SESSION_NOTE = 'Only from a signed-in browser session: an API token (and therefore the MCP bridge) gets 403 `module_session_required`, and the operation is not offered as an MCP tool.';

const INSTALL_NOTE = `A module is same-origin JavaScript that runs with the session of every member who opens it; installing one is equivalent to copying its folder onto the server. A new module is installed DISABLED and must be enabled with PATCH /api/v1/modules/{id}. Replacing an installed module from GitHub with the same repository and folder keeps its enabled state. Every replace from a ZIP, and every replace from a different source, leaves the module disabled for review; the response says \`disabledForReview: true\` with \`disabledReason\` \`zip_replace\` or \`source_changed\`. Only the module folder is copied, files other than web assets are skipped and listed in \`skipped\`, and nothing from the archive runs on the server. Limited to 10 install requests per 10 minutes per user; the 409 \`exists\` and 422 \`multiple\` answers that ask back do not count. Errors carry a stable \`reason\`. ${SESSION_NOTE}`;

// The MCP bridge (server/mcp/tools.js) leaves operations with this flag out of
// list_api_operations and refuses them in call_api_operation. The route would
// refuse a token anyway (module_session_required); hiding them keeps an assistant from
// planning around a step it can never take.
const MCP_EXCLUDE = 'x-mcp-exclude';

function sessionOnly(operation) {
  operation.responses[403] = {
    description: 'Not an admin, or not a browser session (`module_session_required`)',
    content: errorContent(),
  };
  operation[MCP_EXCLUDE] = true;
  return operation;
}

function errorContent() {
  return { 'application/json': { schema: { $ref: '#/components/schemas/ModuleInstallError' } } };
}

function installResponses(extra = {}) {
  return {
    201: {
      description: 'Module installed (or replaced). `data` is the module as listed by GET /api/v1/modules?admin=1.',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ModuleInstallResponse' } } },
    },
    400: { description: 'Invalid archive or manifest. `reason` is one of `bad_url`, `not_zip`, `unsafe_path`, `symlink`, `encrypted`, `zip64`, `method`, `crc`, `duplicate`, `corrupt` (also for an incomplete upload), `bad_manifest`, `no_manifest`, `path_not_found`.', content: errorContent() },
    401: { $ref: '#/components/responses/Unauthorized' },
    403: { $ref: '#/components/responses/Forbidden' },
    409: { description: 'A module with this id is installed (`exists`, with `existing: { id, name, version, install }`, `incoming: { id, name, version }`, `sourceChanged` and `replaceDisabledReason`; retry with overwrite), `modules/<id>` is a symbolic link or a file (`not_a_module`, cannot be replaced from here), or another install/delete is running (`busy`).', content: errorContent() },
    413: { description: `Archive larger than ${MAX_ZIP_MB} MB (\`too_large\`), too many entries (\`too_many_entries\`) or suspicious compression (\`bomb\`).`, content: errorContent() },
    422: { description: 'The archive holds several modules (`multiple`, with `candidates: [{ path, id, name, version }]`), or `path` names a folder that holds several; retry with `path` set to one candidate (`""` is the archive root).', content: errorContent() },
    429: { description: 'Install rate limit reached (`install_rate_limited`)', content: errorContent() },
    503: { description: 'The modules folder on the server is not writable (`not_writable`).', content: errorContent() },
    500: { $ref: '#/components/responses/InternalServerError' },
    ...extra,
  };
}

export function modulesPaths() {
  return {
    '/api/v1/modules': {
      get: op({
        summary: 'List installed extension modules',
        tag: 'Modules',
        description: 'Returns discovered third-party modules from the modules directory, including normalized capabilities (widgets, permissions, API prefix) when declared in module.json. Pass `admin=1` as an admin to include disabled and errored modules and the `install` metadata (source, URL, commit); other listings leave `install` out.',
        responses: {
          200: {
            description: 'Extension modules',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ModulesListResponse' } } },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/modules/install/info': {
      get: op({
        summary: 'Module install capabilities',
        tag: 'Modules',
        admin: true,
        description: 'Whether the modules folder on the server is writable (it is not on read-only mounts; then modules can only be copied in by hand), whether it survives an update (`persistent`: false in a container without a volume on the modules folder, null when unknown) and the archive size limit.',
        responses: {
          200: {
            description: 'Install capabilities',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ModuleInstallInfoResponse' } } },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/modules/install/zip': {
      post: sessionOnly(op({
        summary: 'Install an extension module from a ZIP archive',
        tag: 'Modules',
        admin: true,
        stateChanging: true,
        description: `${INSTALL_NOTE} The request body is the raw ZIP file, up to ${MAX_ZIP_MB} MB.`,
        params: [
          { name: 'overwrite', in: 'query', required: false, description: 'Set to `1` to replace an installed module with the same id (after a 409 `exists`).', schema: { type: 'string', enum: ['0', '1'] } },
          { name: 'path', in: 'query', required: false, description: 'Folder inside the archive that holds module.json, relative to the single top folder if there is one (after a 422 `multiple`). Present but empty (`path=`) selects the archive root.', schema: { type: 'string', maxLength: 500 } },
        ],
        requestBody: {
          required: true,
          description: 'ZIP archive containing a module folder with module.json.',
          content: {
            'application/zip': { schema: { type: 'string', format: 'binary' } },
            'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
            'application/x-zip-compressed': { schema: { type: 'string', format: 'binary' } },
          },
        },
        responses: installResponses({
          415: { description: 'Unsupported Content-Encoding (`unsupported_encoding`)', content: errorContent() },
        }),
      })),
    },
    '/api/v1/modules/install/github': {
      post: sessionOnly(op({
        summary: 'Install an extension module from a GitHub repository',
        tag: 'Modules',
        admin: true,
        stateChanging: true,
        description: `${INSTALL_NOTE} Accepted URLs: \`https://github.com/<owner>/<repo>\` (also without \`https://\`), \`.../tree/<ref>[/<path>]\`, \`.../releases/tag/<tag>\`, \`.../releases/latest\` and bare \`<owner>/<repo>\`. If the URL names no tag or branch, the latest release is used, or the default branch when there is no release. A tree URL that points at a folder holding several modules answers 422 \`multiple\`. The archive is downloaded only from api.github.com, github.com and codeload.github.com.`,
        requestBody: jsonBody('#/components/schemas/ModuleInstallGithubRequest'),
        responses: installResponses({
          404: { description: 'Repository (`repo_not_found`) or ref (`ref_not_found`) not found', content: errorContent() },
          429: { description: 'Install rate limit reached (`install_rate_limited`), or the GitHub API rate limit is used up (`rate_limited`, with `resetAt`)', content: errorContent() },
          502: { description: 'GitHub could not be reached or answered unexpectedly (`github_failed`), including a redirect to a non-GitHub host', content: errorContent() },
        }),
      })),
    },
    '/api/v1/modules/{id}': {
      patch: op({
        summary: 'Enable or disable an extension module',
        tag: 'Modules',
        admin: true,
        params: [stringPathParam('id', 'Module ID')],
        stateChanging: true,
        requestBody: jsonBody('#/components/schemas/ModuleEnableRequest'),
        responses: {
          200: {
            description: 'Updated module',
            content: { 'application/json': { schema: { type: 'object', properties: { data: { $ref: '#/components/schemas/ExtensionModule' } }, required: ['data'] } } },
          },
          400: { description: 'Invalid request' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { description: 'Module not found' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
      delete: sessionOnly(op({
        summary: 'Delete an installed extension module',
        tag: 'Modules',
        admin: true,
        description: `Removes the folder modules/<id> from the server. Permission rows (\`ext:<id>\`) and dashboard widget settings are kept: they are ignored while the module is missing and apply again if the same id is reinstalled. A symbolic link or non-folder is refused. ${SESSION_NOTE}`,
        params: [stringPathParam('id', 'Module ID')],
        stateChanging: true,
        responses: {
          200: {
            description: 'Module deleted',
            content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'object', properties: { id: { type: 'string' }, deleted: { type: 'boolean', const: true } }, required: ['id', 'deleted'] } }, required: ['data'] } } },
          },
          400: { description: 'Invalid id (`bad_id`) or not a regular folder (`not_a_module`)', content: errorContent() },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { description: 'Module not found (`not_found`)', content: errorContent() },
          409: { description: 'Another install/delete is running (`busy`)', content: errorContent() },
          503: { description: 'The modules folder on the server is not writable (`not_writable`)', content: errorContent() },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      })),
    },
    '/api/v1/modules/assets/{id}/{assetPath}': {
      get: op({
        summary: 'Get protected extension module asset',
        tag: 'Modules',
        params: [
          stringPathParam('id', 'Module ID'),
          stringPathParam('assetPath', 'Asset path within the module'),
        ],
        description: 'Files whose path has a segment starting with `.` (for example `.yuvomi-install.json`) are never served and answer 404.',
        responses: {
          200: { description: 'Module asset (JavaScript or CSS)' },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { description: 'Module or asset not found' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
  };
}
