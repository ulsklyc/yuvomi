export const schemas = {
        ApiError: {
          type: 'object',
          properties: {
            error: { type: 'string' },
            code: { type: 'integer' },
            storage_code: { $ref: '#/components/schemas/DocumentStorageErrorCode' },
          },
        },
        NotificationChannel: {
          type: 'object',
          description: 'A Gotify or ntfy notification channel. Secrets are write-only and never returned.',
          properties: {
            id: { type: 'integer' },
            provider: { type: 'string', enum: ['gotify', 'ntfy'] },
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
            provider: { type: 'string', enum: ['gotify', 'ntfy'] },
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
        CalendarEvent: {
          type: 'object',
          description: 'Calendar event. New attachments use document URLs; attachment_data remains available for legacy stored blobs.',
          properties: {
            id: { type: 'integer' },
            title: { type: 'string' },
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
                + '(SMTP configured AND BASE_URL set). The login page gates the "forgot password" '
                + 'link on this flag so it is never a dead end.',
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
            password: { type: 'string' },
            avatar_color: { type: 'string' },
            avatar_data: { type: ['string', 'null'], description: 'PNG, JPEG, or WebP data URL.' },
            family_role: { type: 'string', enum: ['dad', 'mom', 'parent', 'child', 'grandparent', 'relative', 'other'] },
            system_admin: { type: 'boolean' },
            phone: { type: ['string', 'null'] },
            email: { type: ['string', 'null'] },
            birth_date: { type: ['string', 'null'], format: 'date' },
          },
          required: ['username', 'display_name', 'password'],
        },
        UserUpdateRequest: {
          type: 'object',
          properties: {
            username: { type: 'string' },
            display_name: { type: 'string' },
            password: { type: 'string', description: 'Write-only. Omit or leave empty to keep the current password.' },
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
};
