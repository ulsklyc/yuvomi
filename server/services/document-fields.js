/**
 * Module: the value lists of the documents input (#2810, group 8)
 * Purpose: ONE source for what a documents request may carry, read by the
 *          sides that must not drift apart: the route handlers in
 *          server/routes/documents.js and server/routes/dms.js, the storage
 *          service server/services/document-storage.js, and the OpenAPI
 *          document (server/openapi/paths/documents.js and
 *          server/openapi/schemas.js), whose schemas validateRequest() checks
 *          before the handler runs. Up to #2810 the category list stood in the
 *          documents route, again in the DMS route and twice in the document,
 *          and an unknown value fell back silently (`visibility: "Private"`
 *          became `family`, visible to the whole household).
 *
 *          The database keeps its own CHECK lists (migrations are history and
 *          never change); public/pages/inventory.js keeps the category list
 *          for its labels.
 *
 *          This file imports nothing: server/openapi.js must load without
 *          node_modules (the packaging contract), and the route files reach
 *          the database.
 */

/** The categories of a document. */
export const DOCUMENT_CATEGORIES = Object.freeze([
  'medical', 'school', 'identity', 'insurance', 'finance', 'home', 'vehicle',
  'legal', 'travel', 'pets', 'warranty', 'taxes', 'work', 'other',
]);

/** Who sees a document: the household, the chosen members, or its creator alone. */
export const DOCUMENT_VISIBILITIES = Object.freeze(['family', 'restricted', 'private']);

/** The state of a document. */
export const DOCUMENT_STATUSES = Object.freeze(['active', 'archived']);

/** The destinations an administrator can choose for new uploads. */
export const DOCUMENT_UPLOAD_BACKENDS = Object.freeze(['local', 'webdav', 'google_drive']);

/**
 * The document management systems an account can connect to. Equal to the
 * adapters of server/services/dms/index.js (test:validate-shopping-documents
 * holds that); the list stands here so the document can read it without
 * loading an adapter.
 */
export const DMS_PROVIDERS = Object.freeze(['paperless', 'papra']);
