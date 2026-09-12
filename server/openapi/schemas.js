const noteInputProperties = {
  title: { type: ['string', 'null'] },
  content: { type: 'string' },
  color: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
  pinned: {
    oneOf: [
      { type: 'integer', enum: [0, 1] },
      { type: 'boolean' },
    ],
  },
  category_ids: { type: 'array', maxItems: 50, uniqueItems: true, items: { type: 'integer', minimum: 1 } },
};

const calendarOccurrenceProperties = {
  series_id: { type: 'integer', minimum: 1 },
  recurrence_id: { type: 'string', format: 'date' },
  is_occurrence_override: { type: 'boolean' },
  is_local_recurring_series: { type: 'boolean' },
  can_override_occurrence: { type: 'boolean' },
  can_detach_occurrence: { type: 'boolean', description: 'Legacy occurrence scopes for locally owned series that cannot use linked overrides, including outbound-synced and generated series.' },
  assignment_owner_id: { type: 'integer', minimum: 1 },
  attachment_owner_id: { type: 'integer', minimum: 1 },
  reminder_owner_id: { type: 'integer', minimum: 1 },
  reminder_anchor_start: { $ref: '#/components/schemas/CalendarDateOrDateTime' },
};

const calendarOccurrenceMutationProperties = {
  title: { type: 'string', maxLength: 200 },
  description: { type: ['string', 'null'], maxLength: 5000 },
  start_datetime: { $ref: '#/components/schemas/CalendarDateOrDateTime' },
  end_datetime: {
    oneOf: [
      { $ref: '#/components/schemas/CalendarDateOrDateTime' },
      { type: 'null' },
    ],
  },
  all_day: { type: 'boolean' },
  location: { type: ['string', 'null'], maxLength: 200 },
  color: { type: ['string', 'null'], pattern: '^#[0-9A-Fa-f]{6}$' },
  icon: { type: 'string' },
  assigned_to: {
    oneOf: [
      { type: 'integer', minimum: 1 },
      {
        type: 'array',
        uniqueItems: true,
        items: { type: 'integer', minimum: 1 },
      },
      { type: 'null' },
    ],
  },
  visibility: { type: 'string', enum: ['all', 'assignees', 'private'] },
  countdown: { type: 'boolean' },
  attachment_name: { type: ['string', 'null'] },
  attachment_data: {
    type: ['string', 'null'],
    description: 'A base64 data URL for a replacement attachment, or null to remove it.',
  },
  remove_attachment: { type: 'boolean' },
  document_folder_name: { type: 'string' },
  document_name: { type: 'string' },
  document_description: { type: ['string', 'null'] },
  reminder_offsets: {
    type: 'array',
    maxItems: 5,
    uniqueItems: true,
    items: { type: 'integer', minimum: 0 },
  },
};

const calendarProviderTargetProperties = {
  target_google_calendar_id: { type: ['string', 'null'], maxLength: 2048 },
  target_caldav_account_id: { type: ['integer', 'null'], minimum: 1 },
  target_caldav_calendar_url: { type: ['string', 'null'], maxLength: 2048 },
  target_outlook_account_id: { type: ['integer', 'null'], minimum: 1 },
  target_outlook_calendar_id: { type: ['string', 'null'], maxLength: 2048 },
};

export const schemas = {
        ApiError: {
          type: 'object',
          properties: {
            error: { type: 'string' },
            code: { type: 'integer' },
            reason: { type: 'string' },
            storage_code: { $ref: '#/components/schemas/DocumentStorageErrorCode' },
          },
        },
        CalendarOverrideOrphanConflict: {
          type: 'object',
          required: ['error', 'code', 'conflict', 'orphaned_override_count'],
          properties: {
            error: { type: 'string' },
            code: { type: 'integer', const: 409 },
            conflict: { type: 'string', const: 'calendar_override_orphans' },
            orphaned_override_count: { type: 'integer', minimum: 0 },
          },
        },
        OutlookAutoSyncOverrideConflict: {
          type: 'object',
          required: ['error', 'code', 'conflict', 'linked_override_count'],
          properties: {
            error: { type: 'string' },
            code: { type: 'integer', const: 409 },
            conflict: { type: 'string', const: 'outlook_auto_sync_overrides' },
            linked_override_count: { type: 'integer', minimum: 1 },
          },
        },
        NoteCategory: {
          type: 'object',
          required: ['id', 'name', 'scope', 'sort_order'],
          properties: {
            id: { type: 'integer' },
            name: { type: 'string', minLength: 1, maxLength: 80 },
            scope: { type: 'string', enum: ['personal', 'household'] },
            owner_user_id: { type: ['integer', 'null'] },
            sort_order: { type: 'integer' },
          },
        },
        Note: {
          type: 'object',
          required: ['id', 'content', 'pinned', 'categories'],
          properties: {
            id: { type: 'integer' },
            title: { type: ['string', 'null'] },
            content: { type: 'string' },
            color: { type: 'string' },
            pinned: { type: 'integer', enum: [0, 1] },
            created_by: { type: ['integer', 'null'] },
            creator_name: { type: ['string', 'null'] },
            categories: { type: 'array', items: { $ref: '#/components/schemas/NoteCategory' } },
          },
        },
        NoteCreateInput: {
          type: 'object',
          required: ['content'],
          properties: noteInputProperties,
        },
        NoteUpdateInput: {
          type: 'object',
          properties: noteInputProperties,
        },
        NoteCategoryInput: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 80 },
            scope: { type: 'string', enum: ['personal', 'household'], default: 'personal' },
          },
        },
        NoteCategoryRenameInput: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 80 },
          },
        },
        NoteCategoryReorderInput: {
          type: 'object',
          required: ['order'],
          properties: {
            order: { type: 'array', maxItems: 100, uniqueItems: true, items: { type: 'integer', minimum: 1 } },
          },
        },
        NoteResponse: {
          type: 'object',
          required: ['data'],
          properties: { data: { $ref: '#/components/schemas/Note' } },
        },
        NoteListResponse: {
          type: 'object',
          required: ['data'],
          properties: { data: { type: 'array', items: { $ref: '#/components/schemas/Note' } } },
        },
        NoteCategoryResponse: {
          type: 'object',
          required: ['data'],
          properties: { data: { $ref: '#/components/schemas/NoteCategory' } },
        },
        NoteCategoryListResponse: {
          type: 'object',
          required: ['data', 'meta'],
          properties: {
            data: { type: 'array', items: { $ref: '#/components/schemas/NoteCategory' } },
            meta: {
              type: 'object',
              required: ['can_manage_household'],
              properties: { can_manage_household: { type: 'boolean' } },
            },
          },
        },
        NotificationChannel: {
          type: 'object',
          description: 'A Gotify or ntfy notification channel. Secrets are write-only and never returned.',
          properties: {
            id: { type: 'integer' },
            provider: { type: 'string', enum: ['gotify', 'ntfy', 'webhook', 'email'] },
            name: { type: 'string' },
            enabled: { type: 'boolean' },
            scope: { type: 'string', enum: ['household', 'user'] },
            userId: { type: ['integer', 'null'] },
            config: { type: 'object', additionalProperties: true },
            secretSet: { type: 'boolean' },
            lastTestAt: { type: ['string', 'null'], format: 'date-time' },
            lastSuccessAt: { type: ['string', 'null'], format: 'date-time' },
            lastError: { type: ['string', 'null'] },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        NotificationChannelInput: {
          type: 'object',
          required: ['provider', 'name', 'config'],
          properties: {
            provider: { type: 'string', enum: ['gotify', 'ntfy', 'webhook', 'email'] },
            name: { type: 'string' },
            enabled: { type: 'boolean' },
            config: {
              type: 'object',
              description: 'Provider config. Gotify uses baseUrl and priority. ntfy uses baseUrl, topic, priority, and authType.',
              additionalProperties: true,
            },
            secrets: {
              type: 'object',
              description: 'Write-only provider credentials. Omit fields to keep stored secrets on update.',
              additionalProperties: true,
            },
            clearSecrets: {
              type: 'array',
              items: { type: 'string' },
              description: 'Explicit secret field names to clear.',
            },
          },
        },
        NotificationChannelResponse: {
          type: 'object',
          properties: { data: { $ref: '#/components/schemas/NotificationChannel' } },
        },
        NotificationChannelListResponse: {
          type: 'object',
          properties: {
            data: {
              type: 'array',
              items: { $ref: '#/components/schemas/NotificationChannel' },
            },
          },
        },
        DocumentStorageErrorCode: {
          type: 'string',
          description: 'Stable machine-readable code for document-storage failures.',
          enum: [
            'DOCUMENT_STORAGE_INVALID_CONFIG',
            'DOCUMENT_STORAGE_NOT_CONFIGURED',
            'DOCUMENT_STORAGE_UPLOAD_FAILED',
            'DOCUMENT_STORAGE_READ_FAILED',
            'DOCUMENT_STORAGE_DELETE_FAILED',
            'DOCUMENT_STORAGE_CLEANUP_FAILED',
            'DOCUMENT_STORAGE_TOO_LARGE',
            'DOCUMENT_STORAGE_CONNECTION_TEST_FAILED',
            'DOCUMENT_STORAGE_CONFIG_PROTECTED',
          ],
        },
        FamilyDocument: {
          type: 'object',
          description: 'A family document. storage_backend is authoritative; storage_provider remains for legacy client compatibility.',
          properties: {
            id: { type: 'integer' },
            name: { type: 'string' },
            description: { type: ['string', 'null'] },
            category: { type: ['string', 'null'] },
            status: { type: 'string', enum: ['active', 'archived'] },
            visibility: { type: 'string', enum: ['family', 'restricted', 'private'] },
            original_name: { type: ['string', 'null'] },
            mime_type: { type: ['string', 'null'] },
            file_size: { type: ['integer', 'null'] },
            storage_provider: {
              type: 'string',
              enum: ['local', 'external'],
              description: 'Legacy compatibility field. local pairs with local; external pairs with webdav, google_drive, or dms.',
            },
            storage_backend: {
              type: 'string',
              enum: ['local', 'webdav', 'google_drive', 'dms'],
              description: 'Authoritative location of the document bytes or DMS reference.',
            },
            storage_key: {
              type: ['string', 'null'],
              description: 'Relative path for folder/WebDAV storage, opaque Google Drive file ID, DMS reference, or null for an in-database BLOB.',
            },
            dms_account_id: { type: ['integer', 'null'] },
            external_url: { type: ['string', 'null'], format: 'uri' },
            folder_id: { type: ['integer', 'null'] },
            folder_name: { type: ['string', 'null'] },
            created_by: { type: 'integer' },
            creator_name: { type: ['string', 'null'] },
            creator_color: { type: ['string', 'null'] },
            allowed_member_ids: { type: 'array', items: { type: 'integer' } },
            created_at: { type: 'string', format: 'date-time' },
            updated_at: { type: 'string', format: 'date-time' },
          },
          required: [
            'id',
            'name',
            'status',
            'visibility',
            'storage_provider',
            'storage_backend',
            'allowed_member_ids',
          ],
        },
        FamilyDocumentResponse: {
          type: 'object',
          properties: {
            data: { $ref: '#/components/schemas/FamilyDocument' },
          },
          required: ['data'],
        },
        FamilyDocumentsResponse: {
          type: 'object',
          properties: {
            data: {
              type: 'array',
              items: { $ref: '#/components/schemas/FamilyDocument' },
            },
          },
          required: ['data'],
        },
        DocumentOptionsResponse: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                categories: { type: 'array', items: { type: 'string' } },
                visibilities: {
                  type: 'array',
                  items: { type: 'string', enum: ['family', 'restricted', 'private'] },
                },
                statuses: {
                  type: 'array',
                  items: { type: 'string', enum: ['active', 'archived'] },
                },
                max_file_size: { type: 'integer' },
                allowed_mime_types: { type: 'array', items: { type: 'string' } },
                storage_providers: {
                  type: 'array',
                  description: 'Legacy provider values retained for compatibility.',
                  items: { type: 'string', enum: ['local', 'external'] },
                },
                active_upload_backend: {
                  type: 'string',
                  enum: ['local', 'local_folder', 'webdav', 'google_drive'],
                  description: 'Backend used for newly uploaded document files, including calendar attachments. "local" is the in-DB BLOB default, "local_folder" a mounted host folder, "webdav" a remote server, and "google_drive" the explicitly selected connected Drive account.',
                },
                is_admin: {
                  type: 'boolean',
                  description: 'Whether the current user is an admin. The client uses this to show deep links into the admin-only document settings only when they are actually reachable.',
                },
                dms_accounts: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'integer' },
                      name: { type: 'string' },
                      provider: { type: 'string', enum: ['paperless'] },
                    },
                    required: ['id', 'name', 'provider'],
                  },
                },
              },
              required: [
                'categories',
                'visibilities',
                'statuses',
                'max_file_size',
                'allowed_mime_types',
                'storage_providers',
                'active_upload_backend',
                'dms_accounts',
              ],
            },
          },
          required: ['data'],
        },
        DocumentStorageConfigRequest: {
          type: 'object',
          properties: {
            selected_upload_backend: {
              type: 'string',
              enum: ['local', 'webdav', 'google_drive'],
              description: 'Administrator-selected destination for future uploads. Connecting Google Drive does not change this value.',
            },
            enabled: { type: 'boolean' },
            url: { type: ['string', 'null'], format: 'uri', description: 'HTTP(S) WebDAV server URL.' },
            username: { type: ['string', 'null'] },
            password: {
              type: ['string', 'null'],
              writeOnly: true,
              description: 'WebDAV password. Empty and masked values preserve the stored password.',
            },
            path: { type: ['string', 'null'], description: 'Base path below the WebDAV server URL.' },
            confirm_existing_access: {
              type: 'boolean',
              description: 'Required for connection changes while WebDAV documents exist.',
            },
            clear_password: {
              type: 'boolean',
              description: 'Explicitly remove the stored password. Rejected when existing WebDAV documents require it.',
            },
          },
        },
        DocumentStorageTestRequest: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
            url: { type: ['string', 'null'], format: 'uri' },
            username: { type: ['string', 'null'] },
            password: { type: ['string', 'null'], writeOnly: true },
            path: { type: ['string', 'null'] },
            clear_password: { type: 'boolean' },
          },
        },
        GoogleDriveStorageStatus: {
          type: 'object',
          description: 'Google Drive connection state. OAuth tokens, folder IDs, codes and raw provider payloads are never returned.',
          properties: {
            configured: { type: 'boolean' },
            connected: { type: 'boolean' },
            account_email: { type: ['string', 'null'], format: 'email' },
            account_name: { type: ['string', 'null'] },
            folder_name: { type: 'string' },
            document_count: { type: 'integer', minimum: 0 },
            last_test: { type: ['string', 'null'], format: 'date-time' },
            last_error: { type: ['string', 'null'] },
            can_disconnect: { type: 'boolean' },
          },
          required: [
            'configured',
            'connected',
            'account_email',
            'account_name',
            'folder_name',
            'document_count',
            'last_test',
            'last_error',
            'can_disconnect',
          ],
        },
        GoogleDriveStorageStatusResponse: {
          type: 'object',
          properties: {
            data: { $ref: '#/components/schemas/GoogleDriveStorageStatus' },
          },
          required: ['data'],
        },
        DocumentStorageStatus: {
          type: 'object',
          description: 'Combined document-storage selection, effective target, WebDAV configuration and Google Drive connection status. Secrets are never returned.',
          properties: {
            enabled: { type: 'boolean' },
            configured: { type: 'boolean' },
            selected_upload_backend: {
              type: 'string',
              enum: ['local', 'webdav', 'google_drive'],
              description: 'Administrator-selected destination before the environment-managed local-folder override is applied.',
            },
            active_upload_backend: {
              type: 'string',
              enum: ['local', 'local_folder', 'webdav', 'google_drive'],
            },
            effective_target: {
              type: ['string', 'null'],
              description: 'Effective upload target: WebDAV URL, local folder path, Google Drive folder name, or null for the in-DB default.',
            },
            local_enabled: { type: 'boolean', description: 'Whether the local folder backend is enabled via env.' },
            local_path: { type: 'string', description: 'Container path for the local folder backend.' },
            webdav_document_count: { type: 'integer', minimum: 0 },
            google_drive_document_count: { type: 'integer', minimum: 0 },
            google_drive: { $ref: '#/components/schemas/GoogleDriveStorageStatus' },
            last_test: { type: ['string', 'null'], format: 'date-time' },
            last_error: { type: ['string', 'null'] },
            url: { type: ['string', 'null'], format: 'uri' },
            username: { type: ['string', 'null'] },
            base_path: { type: 'string' },
            password_configured: { type: 'boolean' },
            env_controlled: {
              type: 'object',
              properties: {
                enabled: { type: 'boolean' },
                url: { type: 'boolean' },
                username: { type: 'boolean' },
                password: { type: 'boolean' },
                path: { type: 'boolean' },
              },
              required: ['enabled', 'url', 'username', 'password', 'path'],
            },
          },
          required: [
            'enabled',
            'configured',
            'selected_upload_backend',
            'active_upload_backend',
            'effective_target',
            'local_enabled',
            'local_path',
            'webdav_document_count',
            'google_drive_document_count',
            'google_drive',
            'last_test',
            'last_error',
            'url',
            'username',
            'base_path',
            'password_configured',
            'env_controlled',
          ],
        },
        DocumentStorageStatusResponse: {
          type: 'object',
          properties: {
            data: { $ref: '#/components/schemas/DocumentStorageStatus' },
          },
          required: ['data'],
        },
        DocumentStorageTestResponse: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: { ok: { type: 'boolean', const: true } },
              required: ['ok'],
            },
          },
          required: ['data'],
        },
        CalendarDateOrDateTime: {
          description: 'A calendar date or date-time accepted by calendar mutations.',
          oneOf: [
            {
              type: 'string',
              format: 'date',
              pattern: '^\\d{4}-\\d{2}-\\d{2}$',
              description: 'Date-only value in YYYY-MM-DD form.',
            },
            {
              type: 'string',
              pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?$',
              description: 'Yuvomi local wall-clock value. Seconds and fractional seconds are optional and are normalized to YYYY-MM-DDTHH:MM.',
            },
            {
              type: 'string',
              pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?(?:Z|[+-]\\d{2}:?\\d{2})$',
              description: 'Accepted UTC or numeric-offset input. Seconds, fractional seconds, and the offset are normalized to YYYY-MM-DDTHH:MM.',
            },
          ],
        },
        CalendarEvent: {
          type: 'object',
          description: 'Calendar event. New attachments use document URLs; attachment_data remains available for legacy stored blobs.',
          properties: {
            id: { type: 'integer' },
            title: { type: 'string' },
            color: {
              type: ['string', 'null'],
              description: 'The event\'s own colour as #RRGGBB, or null when it has none. Null is the normal state for an event nobody picked a colour for: it then borrows the colour of the first assigned member, and failing that cal_color. On PUT the field distinguishes two cases - omit it to leave the colour untouched, send null to deliberately clear it.',
            },
            cal_color: {
              type: ['string', 'null'],
              description: 'Inherited colour of the source calendar or ICS subscription, read-only. Applies to every event of that source and therefore says nothing about this one; it is the fallback below color and the assignee.',
            },
            attachment_name: { type: ['string', 'null'] },
            attachment_mime: { type: ['string', 'null'] },
            attachment_size: { type: ['integer', 'null'] },
            attachment_document_id: { type: ['integer', 'null'] },
            attachment_preview_url: { type: ['string', 'null'] },
            attachment_download_url: { type: ['string', 'null'] },
            attachment_data: {
              type: ['string', 'null'],
              description: 'Legacy attachment data URL. Null for attachments linked through attachment_document_id.',
            },
            ...calendarOccurrenceProperties,
          },
          required: [
            'id',
            'title',
            'attachment_document_id',
            'attachment_preview_url',
            'attachment_download_url',
            'attachment_data',
          ],
          additionalProperties: true,
        },
        CalendarEventResponse: {
          type: 'object',
          properties: {
            data: { $ref: '#/components/schemas/CalendarEvent' },
          },
          required: ['data'],
        },
        CalendarOccurrence: {
          allOf: [
            { $ref: '#/components/schemas/CalendarEvent' },
            {
              type: 'object',
              properties: calendarOccurrenceProperties,
              required: [
                'series_id',
                'recurrence_id',
                'is_occurrence_override',
                'is_local_recurring_series',
                'can_override_occurrence',
                'can_detach_occurrence',
                'assignment_owner_id',
                'attachment_owner_id',
                'reminder_owner_id',
                'reminder_anchor_start',
              ],
            },
          ],
        },
        CalendarOccurrenceResponse: {
          type: 'object',
          properties: {
            data: { $ref: '#/components/schemas/CalendarOccurrence' },
          },
          required: ['data'],
        },
        CalendarOccurrenceOnlyMutation: {
          type: 'object',
          description: 'Editable fields for one occurrence. Omitted fields inherit their current or series value.',
          properties: calendarOccurrenceMutationProperties,
        },
        CalendarOccurrenceFollowingMutation: {
          type: 'object',
          description: 'Editable fields for a successor series. Omitted fields inherit from the original series.',
          properties: {
            ...calendarOccurrenceMutationProperties,
            ...calendarProviderTargetProperties,
            recurrence_rule: { type: ['string', 'null'], maxLength: 300 },
            confirmed_orphan_count: { type: 'integer', minimum: 0 },
          },
        },
        CalendarEventsResponse: {
          type: 'object',
          properties: {
            data: {
              type: 'array',
              items: { $ref: '#/components/schemas/CalendarEvent' },
            },
            from: { type: 'string', format: 'date' },
            to: { type: 'string', format: 'date' },
          },
          required: ['data'],
        },
        HealthResponse: {
          type: 'object',
          properties: {
            status: { type: 'string', example: 'ok' },
            timestamp: { type: 'string', format: 'date-time' },
          },
          required: ['status', 'timestamp'],
        },
        VersionResponse: {
          type: 'object',
          properties: {
            version: { type: 'string' },
            app_name: { type: 'string' },
            setup_required: { type: 'boolean' },
            password_reset_enabled: {
              type: 'boolean',
              description: 'True when self-service password reset can actually deliver a mail '
                + '(SMTP configured AND BASE_URL set) and there are passwords to reset at all '
                + '(AUTH_ALLOW_PASSWORD_LOGIN not switched off). The login page gates the '
                + '"forgot password" link on this flag so it is never a dead end.',
            },
          },
          required: ['app_name', 'setup_required', 'password_reset_enabled'],
        },
        User: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            username: { type: 'string' },
            display_name: { type: 'string' },
            avatar_color: { type: 'string' },
            avatar_data: { type: ['string', 'null'], description: 'PNG, JPEG, or WebP data URL.' },
            role: { type: 'string', enum: ['admin', 'member'] },
            family_role: { type: 'string', enum: ['dad', 'mom', 'parent', 'child', 'grandparent', 'relative', 'other'] },
            phone: { type: ['string', 'null'] },
            email: { type: ['string', 'null'] },
            birth_date: { type: ['string', 'null'], format: 'date' },
            onboarding_pending: {
              type: 'boolean',
              description: 'Whether this account still needs the onboarding walkthrough. Derived from '
                + 'the account, not from the browser, so a new device does not repeat it. '
                + 'POST /auth/onboarding-seen clears it.',
            },
            sso_only: {
              type: 'boolean',
              description: 'Only present on GET /auth/users for administrators: the account carries no '
                + 'password and can only be entered through SSO.',
            },
          },
          required: ['id', 'username', 'display_name', 'avatar_color', 'role', 'family_role'],
        },
        FamilyMember: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            display_name: { type: 'string' },
            avatar_color: { type: 'string' },
            avatar_data: { type: ['string', 'null'], description: 'PNG, JPEG, or WebP data URL.' },
            family_role: { type: 'string', enum: ['dad', 'mom', 'parent', 'child', 'grandparent', 'relative', 'other'] },
            phone: { type: ['string', 'null'] },
            email: { type: ['string', 'null'] },
            birth_date: { type: ['string', 'null'], format: 'date' },
            created_at: { type: 'string', format: 'date-time' },
          },
          required: ['id', 'display_name', 'avatar_color', 'family_role'],
        },
        FamilyMembersResponse: {
          type: 'object',
          properties: {
            data: {
              type: 'array',
              items: { $ref: '#/components/schemas/FamilyMember' },
            },
          },
          required: ['data'],
        },
        LoginRequest: {
          type: 'object',
          properties: {
            username: { type: 'string' },
            password: { type: 'string' },
          },
          required: ['username', 'password'],
        },
        LoginResponse: {
          type: 'object',
          properties: {
            user: { $ref: '#/components/schemas/User' },
            csrfToken: { type: 'string' },
          },
          required: ['user', 'csrfToken'],
        },
        MeResponse: {
          type: 'object',
          properties: {
            user: { $ref: '#/components/schemas/User' },
            csrfToken: { type: 'string' },
          },
          required: ['user'],
        },
        SetupRequest: {
          type: 'object',
          properties: {
            username: { type: 'string' },
            display_name: { type: 'string' },
            password: { type: 'string' },
          },
          required: ['username', 'display_name', 'password'],
        },
        PasswordChangeRequest: {
          type: 'object',
          properties: {
            currentPassword: { type: 'string' },
            newPassword: { type: 'string' },
          },
          required: ['currentPassword', 'newPassword'],
        },
        UserCreateRequest: {
          type: 'object',
          properties: {
            username: { type: 'string' },
            display_name: { type: 'string' },
            password: { type: 'string', description: 'Required unless sso_only is true.' },
            sso_only: {
              type: 'boolean',
              description: 'Create the account without a password, so it can only be entered through SSO. '
                + 'Requires OIDC to be configured, and rejects a password sent alongside it. '
                + 'Deliberately explicit rather than inferred from a missing password.',
            },
            avatar_color: { type: 'string' },
            avatar_data: { type: ['string', 'null'], description: 'PNG, JPEG, or WebP data URL.' },
            family_role: { type: 'string', enum: ['dad', 'mom', 'parent', 'child', 'grandparent', 'relative', 'other'] },
            system_admin: { type: 'boolean' },
            phone: { type: ['string', 'null'] },
            email: { type: ['string', 'null'] },
            birth_date: { type: ['string', 'null'], format: 'date' },
          },
          required: ['username', 'display_name'],
        },
        UserUpdateRequest: {
          type: 'object',
          properties: {
            username: { type: 'string' },
            display_name: { type: 'string' },
            password: { type: 'string', description: 'Write-only. Omit or leave empty to keep the current password.' },
            sso_only: {
              type: 'boolean',
              description: 'Switch the account between having a password and entering only through SSO. '
                + 'true clears the password; false requires a password to be sent with it, otherwise the '
                + 'account would be left with no way in at all. Omit to leave unchanged.',
            },
            avatar_color: { type: 'string' },
            avatar_data: { type: ['string', 'null'], description: 'PNG, JPEG, or WebP data URL. Use null to remove.' },
            family_role: { type: 'string', enum: ['dad', 'mom', 'parent', 'child', 'grandparent', 'relative', 'other'] },
            system_admin: { type: 'boolean' },
            phone: { type: ['string', 'null'] },
            email: { type: ['string', 'null'] },
            birth_date: { type: ['string', 'null'], format: 'date' },
          },
        },
        ProfileUpdateRequest: {
          type: 'object',
          properties: {
            display_name: { type: 'string' },
            avatar_color: { type: 'string' },
            avatar_data: { type: ['string', 'null'], description: 'PNG, JPEG, or WebP data URL. Use null to remove.' },
          },
        },
        Invite: {
          type: 'object',
          description: 'A pending invitation. The token hash is never returned.',
          properties: {
            id: { type: 'integer' },
            email: { type: ['string', 'null'] },
            username: { type: ['string', 'null'], description: 'Pre-assigned username. When null, the invited person picks one.' },
            display_name: { type: ['string', 'null'] },
            role: { type: 'string', enum: ['admin', 'member'] },
            family_role: { type: 'string', enum: ['dad', 'mom', 'parent', 'child', 'grandparent', 'relative', 'other'] },
            created_by: { type: ['integer', 'null'] },
            expires_at: { type: 'integer', description: 'Unix epoch milliseconds. Invitations are valid for 7 days.' },
            accepted_at: { type: ['string', 'null'], format: 'date-time' },
            accepted_user_id: { type: ['integer', 'null'] },
            revoked_at: { type: ['string', 'null'], format: 'date-time' },
            created_at: { type: 'string', format: 'date-time' },
          },
          required: ['id', 'role', 'family_role', 'expires_at', 'created_at'],
        },
        InviteCreateRequest: {
          type: 'object',
          properties: {
            username: { type: 'string', description: 'Optional. When set, the invited person cannot choose a different one.' },
            display_name: { type: 'string' },
            email: { type: 'string', description: 'Required when send_email is true.' },
            family_role: { type: 'string', enum: ['dad', 'mom', 'parent', 'child', 'grandparent', 'relative', 'other'] },
            system_admin: { type: 'boolean', description: 'Only true grants the admin role; the value is taken from the invitation, never from the accept request.' },
            send_email: { type: 'boolean', description: 'Send the invitation by email. Requires SMTP and BASE_URL; check email_sent in the response.' },
          },
        },
        InviteCreateResponse: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                invite: { $ref: '#/components/schemas/Invite' },
                token: {
                  type: 'string',
                  description: 'Plaintext invite token. Returned here and only here - the database holds nothing but its hash, so a lost token cannot be recovered, only revoked and reissued.',
                },
                email_sent: {
                  type: 'boolean',
                  description: 'Whether the invitation email actually went out. False when send_email was not requested, SMTP or BASE_URL is missing, or delivery failed - the link must then be passed on by hand.',
                },
              },
              required: ['invite', 'token', 'email_sent'],
            },
          },
          required: ['data'],
        },
        InvitesResponse: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                invites: { type: 'array', items: { $ref: '#/components/schemas/Invite' } },
              },
              required: ['invites'],
            },
          },
          required: ['data'],
        },
        InvitePreviewResponse: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                valid: { type: 'boolean' },
                display_name: { type: ['string', 'null'] },
                username: { type: ['string', 'null'] },
              },
              required: ['valid'],
            },
          },
          required: ['data'],
        },
        InviteAcceptRequest: {
          type: 'object',
          properties: {
            token: { type: 'string' },
            password: { type: 'string', minLength: 8 },
            username: { type: 'string', description: 'Ignored when the invitation already carries one.' },
            display_name: { type: 'string', description: 'Ignored when the invitation already carries one.' },
          },
          required: ['token', 'password'],
        },
        ApiToken: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            name: { type: 'string' },
            token_prefix: { type: 'string' },
            created_by: { type: 'integer' },
            creator_name: { type: 'string' },
            subject_user_id: { type: 'integer', description: 'Family member whose identity, role, permissions, and data ownership apply to token requests.' },
            subject_name: { type: ['string', 'null'] },
            scopes: {
              type: ['array', 'null'],
              items: { type: 'string' },
              description: 'Permission allow-list of "module:read"/"module:write" entries. null means no scoping (full role-based access, e.g. legacy tokens). write implies read.',
            },
            expires_at: { type: ['string', 'null'], format: 'date-time' },
            revoked_at: { type: ['string', 'null'], format: 'date-time' },
            last_used_at: { type: ['string', 'null'], format: 'date-time' },
            created_at: { type: 'string', format: 'date-time' },
          },
          required: ['id', 'name', 'token_prefix', 'created_by', 'subject_user_id', 'created_at'],
        },
        ApiTokenCreateRequest: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            subject_user_id: { type: 'integer', minimum: 1, description: 'Optional family-member subject. Defaults to the administrator creating the token. Split-expense guests are not eligible.' },
            scopes: {
              type: ['array', 'null'],
              items: { type: 'string' },
              description: 'Optional permission allow-list of "module:read"/"module:write" entries (e.g. ["calendar:write","tasks:read"]). Omit or null for a full-access token. When set, must be non-empty and only contain known scopes. Enforced on both REST and MCP; write implies read.',
            },
            expires_at: { type: ['string', 'null'], format: 'date-time' },
          },
          required: ['name'],
        },
        ApiTokenCreateResponse: {
          type: 'object',
          properties: {
            data: { $ref: '#/components/schemas/ApiToken' },
            token: { type: 'string' },
          },
          required: ['data', 'token'],
        },
        DmsAccount: {
          type: 'object',
          description: 'A configured DMS account. The api_token is never returned; use has_token to check whether one is stored.',
          properties: {
            id: { type: 'integer' },
            provider: { type: 'string', enum: ['paperless'], description: 'DMS provider type' },
            name: { type: 'string' },
            base_url: { type: 'string', format: 'uri' },
            created_at: { type: 'string', format: 'date-time' },
            last_check: { type: ['string', 'null'], format: 'date-time' },
            has_token: { type: 'boolean', description: 'Whether an API token is stored for this account' },
          },
          required: ['id', 'provider', 'name', 'base_url', 'created_at', 'has_token'],
        },
        DmsAccountsResponse: {
          type: 'object',
          properties: {
            data: { type: 'array', items: { $ref: '#/components/schemas/DmsAccount' } },
          },
          required: ['data'],
        },
        DmsAccountResponse: {
          type: 'object',
          properties: {
            data: { $ref: '#/components/schemas/DmsAccount' },
          },
          required: ['data'],
        },
        DmsAccountCreateRequest: {
          type: 'object',
          properties: {
            provider: { type: 'string', enum: ['paperless'] },
            name: { type: 'string' },
            base_url: { type: 'string', format: 'uri' },
            api_token: { type: 'string', description: 'API token for authenticating with the DMS. Write-only; never returned in responses.' },
          },
          required: ['provider', 'name', 'base_url', 'api_token'],
        },
        DmsTestResponse: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                ok: { type: 'boolean' },
                status: { type: 'integer' },
              },
              required: ['ok', 'status'],
            },
          },
          required: ['data'],
        },
        DmsSearchResult: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            title: { type: 'string' },
            created: { type: 'string', format: 'date-time' },
            filename: { type: ['string', 'null'] },
            url: { type: 'string', format: 'uri' },
          },
          required: ['id', 'title'],
        },
        DmsSearchResponse: {
          type: 'object',
          properties: {
            data: { type: 'array', items: { $ref: '#/components/schemas/DmsSearchResult' } },
          },
          required: ['data'],
        },
        DmsLinkRequest: {
          type: 'object',
          properties: {
            account_id: { type: 'integer' },
            dms_document_id: { type: 'integer' },
            category: { type: 'string', enum: ['medical', 'school', 'identity', 'insurance', 'finance', 'home', 'vehicle', 'legal', 'travel', 'pets', 'warranty', 'taxes', 'work', 'other'] },
            visibility: { type: 'string', enum: ['family', 'restricted', 'private'] },
          },
          required: ['account_id', 'dms_document_id'],
        },
        DmsLinkResponse: {
          type: 'object',
          description: 'The created family_documents row. storage_provider is `external` and storage_backend is `dms` for linked DMS documents.',
          properties: {
            data: {
              type: 'object',
              properties: {
                id: { type: 'integer' },
                name: { type: 'string' },
                category: { type: ['string', 'null'] },
                visibility: { type: 'string' },
                storage_provider: { type: 'string', enum: ['external'] },
                storage_backend: { type: 'string', enum: ['dms'] },
                dms_account_id: { type: ['integer', 'null'] },
                external_url: { type: ['string', 'null'], format: 'uri' },
                created_at: { type: 'string', format: 'date-time' },
              },
              required: ['id', 'name', 'storage_provider', 'storage_backend'],
            },
          },
          required: ['data'],
        },
        DmsPushRequest: {
          type: 'object',
          properties: {
            account_id: { type: 'integer' },
            document_id: { type: 'integer' },
          },
          required: ['account_id', 'document_id'],
        },
        DmsPushResponse: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                taskId: { type: 'string' },
              },
              required: ['taskId'],
            },
          },
          required: ['data'],
        },
        ExtensionModuleWidget: {
          type: 'object',
          description: 'Dashboard widget declared in a third-party module manifest.',
          properties: {
            id: { type: 'string', description: 'Namespaced widget id `<module-id>:<widget-id>`.' },
            shortId: { type: 'string' },
            entry: { type: 'string', description: 'Protected asset URL for the widget JavaScript entry.' },
            label: { type: 'string' },
            labelKey: { type: 'string', description: 'Short i18n key resolved under extensions.{moduleId}.* (from locales/{locale}.json).' },
            icon: { type: 'string' },
            defaultSize: { type: 'string' },
            defaultVisible: { type: 'boolean' },
            optionsSchema: {
              type: ['object', 'null'],
              additionalProperties: {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: ['boolean', 'number', 'string', 'array'] },
                  title: { type: 'string' },
                  titleKey: { type: 'string', description: 'Short i18n key under extensions.{moduleId}.*' },
                  format: { type: 'string' },
                  enum: { type: 'array', items: { type: 'string' } },
                  default: {},
                },
                required: ['type', 'title'],
              },
            },
            moduleKey: { type: 'string', description: 'Permission module key, typically `ext:<module-id>`.' },
          },
          required: ['id', 'shortId', 'entry', 'label', 'icon', 'defaultSize', 'defaultVisible', 'moduleKey'],
        },
        ExtensionModuleCapabilities: {
          type: ['object', 'null'],
          description: 'Normalized capabilities block from module.json (null when not declared or module errored).',
          properties: {
            permissionModuleKey: { type: 'string' },
            permissionModule: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                icon: { type: 'string' },
                labelKey: { type: 'string' },
              },
              required: ['label', 'icon'],
            },
            widgets: {
              type: 'array',
              items: { $ref: '#/components/schemas/ExtensionModuleWidget' },
            },
            apiPrefix: { type: 'string', description: 'Sidecar API prefix. Must be exactly `/api/extensions/<module-id>`.' },
            scopeKey: { type: 'string', description: 'API token scope module key, typically `ext:<module-id>`.' },
          },
        },
        ExtensionModule: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            version: { type: 'string' },
            description: { type: 'string' },
            icon: { type: 'string' },
            accent: { type: 'string' },
            enabled: { type: 'boolean' },
            status: { type: 'string', enum: ['enabled', 'disabled', 'error'] },
            error: { type: ['string', 'null'] },
            route: {
              type: ['object', 'null'],
              properties: {
                path: { type: 'string' },
                entry: { type: 'string' },
                style: { type: ['string', 'null'] },
              },
            },
            menu: {
              type: 'object',
              properties: {
                show: { type: 'boolean' },
                label: { type: 'string' },
                labelKey: { type: 'string' },
                icon: { type: 'string' },
                order: { type: 'number' },
              },
            },
            i18n: {
              type: 'object',
              description: 'Locale metadata scanned from locales/*.json in the module folder.',
              properties: {
                defaultLocale: { type: 'string', description: 'Fallback locale when the UI language is not shipped (default en).' },
                availableLocales: { type: 'array', items: { type: 'string' }, description: 'Locale files present in the module.' },
                coreLocales: { type: 'array', items: { type: 'string' }, description: 'All locales supported by Yuvomi core.' },
              },
            },
            capabilities: { $ref: '#/components/schemas/ExtensionModuleCapabilities' },
          },
          required: ['id', 'name', 'enabled', 'status'],
        },
        ModulesListResponse: {
          type: 'object',
          properties: {
            data: { type: 'array', items: { $ref: '#/components/schemas/ExtensionModule' } },
          },
          required: ['data'],
        },
        ModuleEnableRequest: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
          },
          required: ['enabled'],
        },
        WasteType: {
          type: 'object',
          required: ['id', 'name', 'icon', 'color', 'archived', 'sort_order'],
          properties: {
            id: { type: 'integer' },
            name: { type: 'string' },
            icon: { type: 'string' },
            color: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
            archived: { type: 'integer', enum: [0, 1] },
            sort_order: { type: 'integer' },
            created_by: { type: ['integer', 'null'] },
            created_at: { type: 'string' },
            updated_at: { type: 'string' },
          },
        },
        WasteTypeInput: {
          type: 'object',
          properties: {
            name: { type: 'string', maxLength: 100 },
            icon: { type: 'string', maxLength: 60 },
            color: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
            archived: { type: 'boolean' },
            sort_order: { type: 'integer' },
          },
        },
        WasteSchedule: {
          type: 'object',
          required: ['id', 'type_id', 'recurrence_kind', 'anchor_date', 'interval', 'active'],
          properties: {
            id: { type: 'integer' },
            type_id: { type: 'integer' },
            recurrence_kind: { type: 'string', enum: ['weekly', 'monthly_fixed_day', 'monthly_ordinal_weekday'] },
            anchor_date: { type: 'string', format: 'date' },
            interval: { type: 'integer', minimum: 1 },
            weekdays: {
              type: ['string', 'null'],
              description: 'Comma-separated RRULE BYDAY codes (e.g. "MO,TH") for recurrence_kind=weekly; exactly ONE code (e.g. "MO") for recurrence_kind=monthly_ordinal_weekday. Null for monthly_fixed_day.',
            },
            month_day: {
              type: ['integer', 'null'],
              description: 'recurrence_kind=monthly_fixed_day: a day-of-month (1-31), or -1 for the last day. recurrence_kind=monthly_ordinal_weekday: the ORDINAL POSITION of the chosen weekday - -1 (last) or 1-4 (nth), reusing this same column for a different meaning (#1063 Phase 9). Null for weekly.',
            },
            valid_until: { type: ['string', 'null'], format: 'date' },
            active: { type: 'integer', enum: [0, 1], description: '0 = paused; contributes no occurrences until reactivated.' },
            created_by: { type: ['integer', 'null'] },
            created_at: { type: 'string' },
            updated_at: { type: 'string' },
          },
        },
        WasteScheduleInput: {
          type: 'object',
          properties: {
            type_id: { type: 'integer' },
            recurrence_kind: { type: 'string', enum: ['weekly', 'monthly_fixed_day', 'monthly_ordinal_weekday'] },
            anchor_date: { type: 'string', format: 'date' },
            interval: { type: 'integer', minimum: 1 },
            weekdays: {
              description: 'weekly: an array of BYDAY codes, e.g. ["MO","TH"]. monthly_ordinal_weekday: a single code string, e.g. "MO".',
              oneOf: [
                { type: 'array', items: { type: 'string', enum: ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] } },
                { type: 'string', enum: ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] },
              ],
            },
            month_day: {
              type: 'integer',
              description: 'monthly_fixed_day: 1-31 or -1. monthly_ordinal_weekday: the ordinal position, -1 (last) or 1-4 (nth).',
            },
            valid_until: { type: ['string', 'null'], format: 'date' },
            active: { type: 'boolean' },
          },
        },
        WasteScheduleOverride: {
          type: 'object',
          required: ['id', 'schedule_id', 'original_date'],
          properties: {
            id: { type: 'integer' },
            schedule_id: { type: 'integer' },
            original_date: { type: 'string', format: 'date' },
            replacement_date: { type: ['string', 'null'], format: 'date', description: 'null means this occurrence is explicitly skipped.' },
            note: { type: ['string', 'null'] },
            created_at: { type: 'string' },
            updated_at: { type: 'string' },
          },
        },
        WasteScheduleOverrideInput: {
          type: 'object',
          properties: {
            replacement_date: { type: ['string', 'null'], format: 'date', description: 'A date to move this occurrence to, or null to skip it.' },
            note: { type: ['string', 'null'] },
          },
        },
        WasteOneOffPickup: {
          type: 'object',
          required: ['id', 'type_id', 'date'],
          properties: {
            id: { type: 'integer' },
            type_id: { type: 'integer' },
            date: { type: 'string', format: 'date' },
            note: { type: ['string', 'null'] },
            created_by: { type: ['integer', 'null'] },
            created_at: { type: 'string' },
            updated_at: { type: 'string' },
          },
        },
        WasteOneOffPickupInput: {
          type: 'object',
          properties: {
            type_id: { type: 'integer' },
            date: { type: 'string', format: 'date' },
            note: { type: ['string', 'null'] },
          },
        },
        WasteOccurrenceOrigin: {
          type: 'object',
          required: ['kind', 'moved'],
          properties: {
            kind: { type: 'string', enum: ['schedule', 'one_off', 'import'] },
            schedule_id: { type: 'integer' },
            one_off_id: { type: 'integer' },
            source_id: { type: 'integer', description: 'Present when kind is "import".' },
            source_name: { type: ['string', 'null'], description: 'Present when kind is "import".' },
            original_summary: { type: ['string', 'null'], description: 'The imported event\'s own SUMMARY text; present when kind is "import".' },
            original_date: { type: ['string', 'null'], format: 'date' },
            moved: { type: 'boolean' },
          },
        },
        WasteOccurrence: {
          type: 'object',
          required: ['key', 'date_key', 'type_id', 'moved', 'coalesced', 'origins', 'deep_link'],
          properties: {
            key: { type: 'string' },
            date_key: { type: 'string', format: 'date' },
            type_id: { type: 'integer' },
            type_name: { type: ['string', 'null'] },
            type_icon: { type: ['string', 'null'] },
            type_color: { type: ['string', 'null'] },
            type_sort_order: { type: 'integer' },
            moved: { type: 'boolean' },
            coalesced: { type: 'boolean', description: 'true when more than one origin (e.g. a schedule and a one-off) supplies this same date.' },
            origins: { type: 'array', items: { $ref: '#/components/schemas/WasteOccurrenceOrigin' } },
            deep_link: { type: 'string', description: 'Stable "?type=<id>&date=<YYYY-MM-DD>" deep-link target.' },
          },
        },
        WasteNextPerTypeEntry: {
          type: 'object',
          required: ['type', 'next'],
          properties: {
            type: { $ref: '#/components/schemas/WasteType' },
            next: {
              oneOf: [{ $ref: '#/components/schemas/WasteOccurrence' }, { type: 'null' }],
            },
          },
        },
        WasteTypeListResponse: {
          type: 'object',
          required: ['data'],
          properties: { data: { type: 'array', items: { $ref: '#/components/schemas/WasteType' } } },
        },
        WasteTypeResponse: {
          type: 'object',
          required: ['data'],
          properties: { data: { $ref: '#/components/schemas/WasteType' } },
        },
        WasteScheduleListResponse: {
          type: 'object',
          required: ['data'],
          properties: { data: { type: 'array', items: { $ref: '#/components/schemas/WasteSchedule' } } },
        },
        WasteScheduleResponse: {
          type: 'object',
          required: ['data'],
          properties: { data: { $ref: '#/components/schemas/WasteSchedule' } },
        },
        WasteScheduleOverrideResponse: {
          type: 'object',
          required: ['data'],
          properties: { data: { $ref: '#/components/schemas/WasteScheduleOverride' } },
        },
        WasteOneOffPickupListResponse: {
          type: 'object',
          required: ['data'],
          properties: { data: { type: 'array', items: { $ref: '#/components/schemas/WasteOneOffPickup' } } },
        },
        WasteOneOffPickupResponse: {
          type: 'object',
          required: ['data'],
          properties: { data: { $ref: '#/components/schemas/WasteOneOffPickup' } },
        },
        WasteOccurrenceListResponse: {
          type: 'object',
          required: ['data'],
          properties: { data: { type: 'array', items: { $ref: '#/components/schemas/WasteOccurrence' } } },
        },
        WasteNextPerTypeResponse: {
          type: 'object',
          required: ['data'],
          properties: { data: { type: 'array', items: { $ref: '#/components/schemas/WasteNextPerTypeEntry' } } },
        },
        WasteSource: {
          type: 'object',
          required: ['id', 'kind', 'name', 'version', 'created_at', 'updated_at'],
          properties: {
            id: { type: 'integer' },
            kind: { type: 'string', enum: ['file', 'url'] },
            name: { type: 'string' },
            content_hash: { type: 'string', description: 'sha256 of the ICS text behind the currently committed snapshot.' },
            version: { type: 'integer', description: 'Bumped on every committed (re)import; the concurrency guard for reimport/commit.' },
            coverage_start: { type: ['string', 'null'], format: 'date' },
            coverage_end: { type: ['string', 'null'], format: 'date' },
            last_import_at: { type: ['string', 'null'], format: 'date-time' },
            last_success_at: { type: ['string', 'null'], format: 'date-time', description: 'Only updated on a successful commit; a failed attempt never clears it.' },
            last_error: { type: ['string', 'null'] },
            needs_refresh: { type: 'boolean', description: 'true when this source has no mapped pickup on or after today (invariant #6) - derived, not stored.' },
            url: { type: 'string', description: 'kind=url only. A credential: omitted entirely for a caller without module write access, never merely masked.' },
            refresh_interval_minutes: { type: 'integer', description: 'kind=url only. Bounded 60-43200 (hourly to monthly).' },
            next_attempt_at: { type: ['string', 'null'], format: 'date-time', description: 'kind=url only. null while needs_mapping is set - the scheduler skips the source until a reviewed refresh.' },
            consecutive_failures: { type: 'integer', description: 'kind=url only. Drives exponential backoff; reset to 0 on any successful fetch.' },
            needs_mapping: { type: 'boolean', description: 'kind=url only. Content changed but could not auto-commit (an unmapped label or unresolved blocking diagnostic); resolved only by a reviewed refresh.' },
            created_at: { type: 'string', format: 'date-time' },
            updated_at: { type: 'string', format: 'date-time' },
          },
        },
        WasteSourceDetail: {
          allOf: [
            { $ref: '#/components/schemas/WasteSource' },
            { type: 'object', properties: { mappings: { type: 'array', items: { $ref: '#/components/schemas/WasteSourceMapping' } } } },
          ],
        },
        WasteSourceRenameInput: {
          type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 150 } },
        },
        WasteSourceMapping: {
          type: 'object',
          required: ['id', 'source_id', 'original_label', 'normalized_label', 'ignored'],
          properties: {
            id: { type: 'integer' },
            source_id: { type: 'integer' },
            original_label: { type: 'string' },
            normalized_label: { type: 'string' },
            type_id: { type: ['integer', 'null'] },
            ignored: { type: 'boolean' },
          },
        },
        WasteSourceMappingUpdateInput: {
          type: 'object',
          properties: {
            type_id: { type: 'integer', description: 'Required unless ignored is true.' },
            ignored: { type: 'boolean', default: false },
          },
        },
        WasteImportDiagnostic: {
          type: 'object',
          required: ['severity', 'code', 'message'],
          properties: {
            severity: { type: 'string', enum: ['info', 'blocking'] },
            code: { type: 'string', enum: ['skipped_unparsable', 'cancelled_excluded', 'missing_uid_fallback', 'duplicate_instance', 'unsupported_rdate', 'unbounded_recurrence'] },
            message: { type: 'string' },
            count: { type: 'integer' },
            event_key: { type: 'string', description: 'Present on a "blocking" diagnostic; pass it back in skip_event_keys on commit to exclude the affected event and unblock the rest of the file.' },
          },
        },
        WasteImportLabel: {
          type: 'object',
          required: ['normalized_label', 'original_label', 'count'],
          properties: {
            normalized_label: { type: 'string' },
            original_label: { type: 'string' },
            count: { type: 'integer' },
            sample_summary: { type: ['string', 'null'] },
            suggested_type_id: { type: ['integer', 'null'], description: 'A same-name (case-insensitive) match against an existing type; a convenience default only, never applied on its own.' },
            remembered_type_id: { type: ['integer', 'null'], description: 'The type this label was mapped to on the source\'s last commit, on a re-import preview.' },
            remembered_ignored: { type: 'boolean' },
          },
        },
        WasteImportPreview: {
          type: 'object',
          required: ['digest', 'coverage', 'counts', 'diagnostics', 'labels'],
          properties: {
            digest: { type: 'string', description: 'sha256 of what this preview shows (candidates/labels/diagnostics), not of the raw ICS bytes; pass it back as preview_digest on commit. A URL source may be re-fetched between preview and commit - this digest still matches as long as the parsed result is unchanged.' },
            source_id: { type: ['integer', 'null'], description: 'null for a fresh import preview.' },
            expected_version: { type: ['integer', 'null'], description: 'The source\'s current version, for a re-import preview; pass it back as expected_version on commit.' },
            coverage: {
              type: 'object',
              properties: { start: { type: ['string', 'null'], format: 'date' }, end: { type: ['string', 'null'], format: 'date' } },
            },
            counts: {
              type: 'object',
              properties: { events: { type: 'integer' }, candidates: { type: 'integer' }, distinct_labels: { type: 'integer' } },
            },
            diagnostics: { type: 'array', items: { $ref: '#/components/schemas/WasteImportDiagnostic' } },
            labels: { type: 'array', items: { $ref: '#/components/schemas/WasteImportLabel' } },
          },
        },
        WasteImportPreviewInput: {
          type: 'object', required: ['ics'],
          properties: { ics: { type: 'string', description: 'The raw ICS file text.' } },
        },
        WasteImportPreviewResponse: {
          type: 'object', required: ['data'], properties: { data: { $ref: '#/components/schemas/WasteImportPreview' } },
        },
        WasteImportMappingDecision: {
          type: 'object',
          required: ['normalized_label'],
          description: 'Exactly one of type_id / new_type / ignored must be set. One decision is required per distinct label reported by the preview.',
          properties: {
            normalized_label: { type: 'string' },
            type_id: { type: 'integer' },
            new_type: { $ref: '#/components/schemas/WasteTypeInput' },
            ignored: { type: 'boolean' },
          },
        },
        WasteImportCommitInput: {
          type: 'object',
          required: ['ics', 'mappings'],
          properties: {
            ics: { type: 'string', description: 'The raw ICS file text (re-parsed on commit; never trusts a client-supplied candidate list).' },
            name: { type: 'string', maxLength: 150, description: 'Required for a fresh import (POST /import/commit); defaults to the existing name on a re-import.' },
            mappings: { type: 'array', items: { $ref: '#/components/schemas/WasteImportMappingDecision' } },
            skip_event_keys: { type: 'array', items: { type: 'string' }, description: 'Blocking-diagnostic event_key values explicitly acknowledged and excluded.' },
            preview_digest: { type: 'string', description: 'The digest returned by the matching preview; a mismatch (the parsed content actually changed since that preview) is refused with 409.' },
            expected_version: { type: 'integer', description: 'Required on a re-import commit; the source\'s version as last seen in a preview (409 on mismatch).' },
          },
        },
        WasteImportDiff: {
          type: 'object',
          required: ['added', 'changed', 'removed', 'coalesced'],
          properties: {
            added: { type: 'integer' }, changed: { type: 'integer' }, removed: { type: 'integer' },
            coalesced: { type: 'integer', description: 'Informational: how many accepted pickups land on a date a manual schedule/one-off (or another source) already provides for the same type.' },
          },
        },
        WasteImportCommitResult: {
          type: 'object',
          required: ['source', 'diff'],
          properties: { source: { $ref: '#/components/schemas/WasteSource' }, diff: { $ref: '#/components/schemas/WasteImportDiff' } },
        },
        WasteImportCommitResponse: {
          type: 'object', required: ['data'], properties: { data: { $ref: '#/components/schemas/WasteImportCommitResult' } },
        },
        WasteSourceListResponse: {
          type: 'object', required: ['data'], properties: { data: { type: 'array', items: { $ref: '#/components/schemas/WasteSource' } } },
        },
        WasteSourceDetailResponse: {
          type: 'object', required: ['data'], properties: { data: { $ref: '#/components/schemas/WasteSourceDetail' } },
        },
        WasteSourceMappingResponse: {
          type: 'object', required: ['data'], properties: { data: { $ref: '#/components/schemas/WasteSourceMapping' } },
        },
        WasteUrlSourceCreateInput: {
          type: 'object',
          required: ['name', 'url'],
          properties: {
            name: { type: 'string', maxLength: 150 },
            url: { type: 'string', description: 'https:// only by default; http:// is accepted only under the operator opt-in WASTE_SOURCE_ALLOW_PRIVATE_NETWORK.' },
            refresh_interval_minutes: { type: 'integer', default: 1440, description: 'Bounded 60-43200 (hourly to monthly).' },
          },
        },
        WasteUrlSourceRefreshResult: {
          type: 'object',
          required: ['source', 'outcome'],
          properties: {
            source: { $ref: '#/components/schemas/WasteSource' },
            outcome: {
              type: 'string',
              enum: ['committed', 'unchanged', 'needs_mapping', 'error'],
              description: 'committed: every label had a remembered decision, applied via the same atomic path as a file re-import. unchanged: a conditional GET reported no change (304). needs_mapping: content changed but at least one label (or blocking diagnostic) has no remembered decision - see source.needs_mapping and the preview field. error: the fetch failed - see source.last_error.',
            },
            diff: { $ref: '#/components/schemas/WasteImportDiff' },
            preview: { $ref: '#/components/schemas/WasteImportPreview' },
          },
        },
        WasteUrlSourceCreateResponse: {
          type: 'object', required: ['data'], properties: { data: { $ref: '#/components/schemas/WasteUrlSourceRefreshResult' } },
        },
        WasteUrlSourceRefreshResponse: {
          type: 'object', required: ['data'], properties: { data: { $ref: '#/components/schemas/WasteUrlSourceRefreshResult' } },
        },
        WasteReminderSetting: {
          type: 'object',
          required: ['type_id', 'enabled', 'offset_days', 'delivery_time'],
          properties: {
            type_id: { type: 'integer' },
            type_name: { type: 'string', description: 'Only present on GET (list); PUT\'s response is scoped to the one type_id already in the URL.' },
            enabled: { type: 'boolean' },
            offset_days: { type: 'integer', description: 'Lead time before the pickup, in days. Bounded 0-14.' },
            delivery_time: { type: 'string', description: 'Household-local HH:MM the reminder is delivered at.' },
          },
        },
        WasteReminderSettingsListResponse: {
          type: 'object', required: ['data'], properties: { data: { type: 'array', items: { $ref: '#/components/schemas/WasteReminderSetting' } } },
        },
        WasteReminderSettingUpdateInput: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean', default: false },
            offset_days: { type: 'integer', default: 1 },
            delivery_time: { type: 'string', default: '08:00' },
          },
        },
        WasteReminderSettingResponse: {
          type: 'object', required: ['data'], properties: { data: { $ref: '#/components/schemas/WasteReminderSetting' } },
        },
        WasteFeedStatus: {
          type: 'object',
          nullable: true,
          properties: {
            token: { type: 'string' },
            url: { type: 'string', description: 'Public, unauthenticated .ics URL. Rotates when regenerated.' },
            type_ids: {
              type: 'array', items: { type: 'integer' }, nullable: true,
              description: 'Optional type selection. null (default) means every active type.',
            },
          },
        },
        WasteFeedStatusResponse: {
          type: 'object', required: ['data'], properties: { data: { $ref: '#/components/schemas/WasteFeedStatus' } },
        },
        WasteFeedTypeSelectionInput: {
          type: 'object',
          required: ['type_ids'],
          properties: {
            type_ids: {
              type: 'array', items: { type: 'integer' }, nullable: true,
              description: 'Waste type ids to include, or null to include every active type again.',
            },
          },
        },
        WasteMappingProfileEntry: {
          type: 'object',
          required: ['pattern', 'type_name'],
          properties: {
            pattern: { type: 'string', description: 'Normalized source label this pattern matches.' },
            type_name: { type: 'string' },
          },
        },
        WasteMappingProfile: {
          type: 'object',
          required: ['version', 'mappings'],
          properties: {
            version: { type: 'integer', enum: [1] },
            source_name: { type: 'string', description: 'Only present on export, informational only.' },
            mappings: { type: 'array', items: { $ref: '#/components/schemas/WasteMappingProfileEntry' } },
          },
        },
        WasteMappingProfileExportResponse: {
          type: 'object', required: ['data'], properties: { data: { $ref: '#/components/schemas/WasteMappingProfile' } },
        },
        WasteMappingProfileImportPreviewInput: {
          type: 'object', required: ['profile'], properties: { profile: { $ref: '#/components/schemas/WasteMappingProfile' } },
        },
        WasteMappingProfilePreviewEntry: {
          type: 'object',
          required: ['pattern', 'type_name', 'status'],
          properties: {
            pattern: { type: 'string' },
            type_name: { type: 'string' },
            mapping_id: { type: 'integer', nullable: true },
            original_label: { type: 'string', nullable: true },
            resolved_type_id: { type: 'integer', nullable: true },
            status: {
              type: 'string',
              enum: ['applicable', 'unchanged', 'unmatched_pattern', 'unmatched_type', 'ambiguous_type'],
              description: 'applicable: will be applied on commit. unchanged: source mapping already matches. unmatched_pattern: no mapping in this source has this pattern. unmatched_type: no waste type in this household has this name. ambiguous_type: more than one waste type shares this name and none of them is the mapping\'s own current type - never guessed at, resolve the name collision (rename one of the types) before this entry can apply.',
            },
          },
        },
        WasteMappingProfilePreview: {
          type: 'object',
          required: ['source_id', 'entries', 'applicable_count', 'profile_digest'],
          properties: {
            source_id: { type: 'integer' },
            entries: { type: 'array', items: { $ref: '#/components/schemas/WasteMappingProfilePreviewEntry' } },
            applicable_count: { type: 'integer' },
            profile_digest: { type: 'string', description: 'Pass back unchanged on commit; a mismatch means the profile changed since this preview.' },
          },
        },
        WasteMappingProfileImportPreviewResponse: {
          type: 'object', required: ['data'], properties: { data: { $ref: '#/components/schemas/WasteMappingProfilePreview' } },
        },
        WasteMappingProfileImportCommitInput: {
          type: 'object',
          required: ['profile', 'profile_digest'],
          properties: {
            profile: { $ref: '#/components/schemas/WasteMappingProfile' },
            profile_digest: { type: 'string' },
          },
        },
        WasteMappingProfileImportCommitResult: {
          type: 'object',
          required: ['applied_count', 'entries'],
          properties: {
            applied_count: { type: 'integer' },
            entries: { type: 'array', items: { $ref: '#/components/schemas/WasteMappingProfilePreviewEntry' } },
          },
        },
        WasteMappingProfileImportCommitResponse: {
          type: 'object', required: ['data'], properties: { data: { $ref: '#/components/schemas/WasteMappingProfileImportCommitResult' } },
        },
};
