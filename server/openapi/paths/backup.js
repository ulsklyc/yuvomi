import { op, jsonBody } from '../helpers.js';

export function backupPaths() {
  return {
    '/api/v1/backup/status': {
      get: op({
        summary: 'Get backup status',
        tag: 'Backup',
        admin: true,
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
    '/api/v1/backup/restore': {
      post: op({
        summary: 'Restore database backup',
        tag: 'Backup',
        admin: true,
        stateChanging: true,
        description: 'A backup carries the encryption of the installation that wrote it. To restore an encrypted backup from ANOTHER installation, send that installation\'s DB_ENCRYPTION_KEY in `X-Backup-Key`: the backup is re-encrypted with this installation\'s own key, and the sent key is used only for this request and never stored. The key is accepted only in this header, never in the URL. If this installation\'s own key already opens the backup, the header is ignored. An installation without a DB_ENCRYPTION_KEY of its own refuses a backup key rather than storing the backup decrypted. Every 400 response may carry a machine-readable `reason`: `backup_key_required` (the backup does not open with this installation\'s key - send `X-Backup-Key`), `backup_key_wrong`, `backup_key_invalid` (header is not base64), `own_key_missing`, `backup_damaged`, `backup_unreadable`, `backup_corrupt` (the integrity check found damage in the backup file). A second restore while one is still running is refused with 409 and reason `restore_in_progress`. If syncs, backups or requests are still running after 60 seconds, the restore gives up without changing anything: 503 with reason `restore_busy`. A failed restore leaves this installation unchanged.',
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
        stateChanging: true,
        requestBody: jsonBody(null),
      }),
    },
    '/api/v1/backup/webdav/test': {
      post: op({
        summary: 'Test WebDAV backup connection',
        tag: 'Backup',
        admin: true,
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
