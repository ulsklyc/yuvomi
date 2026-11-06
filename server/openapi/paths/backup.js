import { op, jsonBody } from '../helpers.js';

export function backupPaths() {
  return {
    '/api/v1/backup/status': {
      get: op({
        summary: 'Get backup status',
        tag: 'Backup',
        admin: true,
        description: '`database_key` (see DatabaseKeyStatus) says where the database key comes from, never its value; `GET /api/v1/backup/database-key` returns a generated one. `scheduler.lastError` is `{ timestamp, message, reason }` for the last failed scheduled run and `null` once a run succeeds again, so a client can tell a stale success from a fresh failure. `reason` is `backup_dir_not_writable` when the directory is inaccessible and `null` for other failures.',
      }),
    },
    '/api/v1/backup/database': {
      get: op({
        summary: 'Download database backup',
        tag: 'Backup',
        admin: true,
        responses: {
          200: {
            description: 'Database backup file',
            content: {
              'application/octet-stream': {
                schema: { type: 'string', format: 'binary' },
              },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/backup/database-key': {
      get: op({
        summary: 'Show the generated database key',
        operationId: 'getDatabaseKey',
        tag: 'Backup',
        admin: true,
        description: 'Returns the DB_ENCRYPTION_KEY that Yuvomi generated on the first start of a new installation and stores in `.secrets/DB_ENCRYPTION_KEY` next to the database (`origin` `stored` or `generated`), so the administrator can keep a copy with the backups: without it, no backup opens once that volume is lost. A key from DB_ENCRYPTION_KEY or DB_ENCRYPTION_KEY_FILE is never returned, it is already in the configuration; then only `origin` and `encrypted` come back. Not available on a signed-in device (403, reason `device_credential`). Every response is `Cache-Control: no-store`, each view is logged with the administrator\'s id and never the key, and an administrator gets 10 views per 10 minutes.',
        responses: {
          200: {
            description: 'Origin of the key, and the key itself when Yuvomi generated it',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/DatabaseKeyResponse' } } },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          429: { description: 'More than 10 views in 10 minutes' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/backup/restore': {
      post: op({
        summary: 'Restore database backup',
        tag: 'Backup',
        admin: true,
        stateChanging: true,
        description: 'A backup carries the encryption of the installation that wrote it. To restore an encrypted backup from ANOTHER installation, send that installation\'s DB_ENCRYPTION_KEY in `X-Backup-Key`: the backup is re-encrypted with this installation\'s own key, and the sent key is used only for this request and never stored. The key is accepted only in this header, never in the URL. If this installation\'s own key already opens the backup, the header is ignored. An installation without a DB_ENCRYPTION_KEY of its own refuses a backup key rather than storing the backup decrypted. Every 400 response may carry a machine-readable `reason`: `backup_key_required` (the backup does not open with this installation\'s key - send `X-Backup-Key`), `backup_key_wrong`, `backup_key_invalid` (header is not base64), `own_key_missing`, `backup_damaged`, `backup_unreadable`, `backup_corrupt` (the integrity check found damage in the backup file), `backup_file_empty` (the request body is empty), `backup_not_yuvomi` (a readable SQLite file without the Yuvomi schema), `backup_newer_version` (written by a newer Yuvomi - update first). A second restore while one is still running is refused with 409 and reason `restore_in_progress`. If syncs, backups or requests are still running after 60 seconds, the restore gives up without changing anything: 503 with reason `restore_busy`. A body larger than BACKUP_UPLOAD_LIMIT is refused with 413, reason `backup_file_too_large` and the limit as `params.limit` (e.g. `"100mb"`). A failed restore leaves this installation unchanged.',
        params: [{
          name: 'X-Backup-Key',
          in: 'header',
          required: false,
          description: 'DB_ENCRYPTION_KEY of the installation that wrote the backup, as base64 of its UTF-8 bytes (for example `printf %s "$OLD_KEY" | base64`). Only for an encrypted backup from another installation. Sent in plain text over HTTP - use HTTPS.',
          schema: { type: 'string', format: 'byte', maxLength: 4096 },
        }],
        requestBody: {
          required: true,
          description: 'Raw database backup file.',
          content: {
            'application/octet-stream': {
              schema: { type: 'string', format: 'binary' },
            },
          },
        },
        responses: {
          200: { description: 'Database restored' },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          409: { description: 'Another restore is still running on this instance (reason `restore_in_progress`); nothing was changed' },
          503: { description: 'Still busy after the wait limit (reason `restore_busy`); nothing was changed' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/backup/trigger': {
      post: op({
        summary: 'Run a manual local backup',
        tag: 'Backup',
        admin: true,
        stateChanging: true,
      }),
    },
    '/api/v1/backup/webdav/config': {
      get: op({
        summary: 'Get WebDAV backup configuration',
        tag: 'Backup',
        admin: true,
        description: 'Returns the scheduler WebDAV backup target status with the password masked/omitted.',
      }),
      put: op({
        summary: 'Update WebDAV backup configuration',
        tag: 'Backup',
        admin: true,
        description: 'An omitted or empty `password` (or the mask `****`) keeps the stored one, but only while the server (scheme, host and port) and the `username` stay the same. A different server or username without a new password is refused with 400 and `errorCode: password_required`, and nothing is saved. A different path on the same server needs no password.',
        stateChanging: true,
        requestBody: jsonBody(null),
      }),
    },
    '/api/v1/backup/webdav/test': {
      post: op({
        summary: 'Test WebDAV backup connection',
        tag: 'Backup',
        admin: true,
        description: 'Optional overrides `url`, `username`, `password`, `remotePath`; missing fields fall back to the stored configuration. An override with a different server (scheme, host and port) or username but no new password is refused with 400 and `errorCode: password_required` before any request is made, so the stored password never reaches a server it was not entered for.',
        stateChanging: true,
        requestBody: jsonBody(null),
      }),
    },
    '/api/v1/backup/webdav/files': {
      get: op({
        summary: 'List remote WebDAV backup files',
        tag: 'Backup',
        admin: true,
      }),
    },
    '/api/v1/backup/webdav/trigger': {
      post: op({
        summary: 'Create and upload a WebDAV backup',
        tag: 'Backup',
        admin: true,
        stateChanging: true,
      }),
    },
  };
}
