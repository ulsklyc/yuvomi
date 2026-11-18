import { buildPaths } from './openapi/paths/index.js';
import { idempotencyHeaderParam } from './openapi/helpers.js';
import { apiTags } from './openapi/tags.js';
import { schemas } from './openapi/schemas.js';

/**
 * Traegt den `Idempotency-Key`-Header an jeder POST-Operation nach, die von der
 * Middleware ueberhaupt erreicht wird (#822).
 *
 * `/api/v1/auth/*` bleibt aussen vor, und das ist keine Feinheit: der
 * Auth-Router haengt in `index.js` VOR `requireAuth`, also vor der Middleware.
 * Ein dort dokumentierter Header waere eine Zusage, die niemand einloest.
 *
 * @param {Record<string, any>} paths
 * @returns {Record<string, any>} dieselben Pfade, POSTs angereichert
 */
function withIdempotency(paths) {
  for (const [path, item] of Object.entries(paths)) {
    if (!item?.post) continue;
    if (!path.startsWith('/api/v1/') || path.startsWith('/api/v1/auth/')) continue;
    item.post.parameters = [...(item.post.parameters ?? []), idempotencyHeaderParam()];
    item.post.responses = {
      ...item.post.responses,
      409: {
        description: 'Idempotency-Key conflict: reused for a different request, or the first attempt is still running',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        ...(item.post.responses?.[409] ?? {}),
      },
    };
  }
  return paths;
}

function buildOpenApiSpec(req, appVersion) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Yuvomi API',
      version: appVersion,
      description: 'OpenAPI documentation for the Yuvomi family organizer backend.',
    },
    servers: [{ url: '/', description: 'Current origin' }],
    tags: apiTags,
    paths: withIdempotency(buildPaths()),
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'API token sent in the Authorization header as `Bearer <token>`.',
        },
        apiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
          description: 'API token sent in the `X-API-Key` header. `API-Key` is also accepted for MCP compatibility.',
        },
        cookieAuth: {
          type: 'apiKey',
          in: 'cookie',
          name: 'yuvomi.sid',
          description: 'Browser session cookie. State-changing requests also require `X-CSRF-Token`.',
        },
      },
      responses: {
        BadRequest: {
          description: 'Bad request. A request outside the schema of its operation carries `fields`; its `reason` is the documented reason of the operation when the failing rule names one, else `validation`.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        },
        Unauthorized: {
          description: 'Authentication required or invalid credentials/token',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        },
        Forbidden: {
          description: 'Permission denied',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        },
        InternalServerError: {
          description: 'Internal server error',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        },
      },
      schemas,
    },
  };
}

export { buildOpenApiSpec };
