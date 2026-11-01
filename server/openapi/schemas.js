import { NOTE_CATEGORY_NAME_MAX_LENGTH } from '../../public/utils/note-category-name.js';

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
  visibility: {
    type: 'string',
    enum: ['all', 'private'],
    description: '`private`: only the creator sees the note, administrators included. Only the creator can change it.',
  },
  locked: {
    oneOf: [
      { type: 'integer', enum: [0, 1] },
      { type: 'boolean' },
    ],
    description: 'Locked notes can only be changed by their creator and administrators - ticking checklist items included. Only they can set or lift the lock.',
  },
};

// Die Erinnerungsfelder spiegeln `validateReminder()` in
// server/routes/birthdays.js; die Obergrenze ist 999 Wochen in Minuten.
const BIRTHDAY_REMINDER_MAX_MINUTES = 999 * 10080;

const birthdayInputProperties = {
  name: { type: 'string', maxLength: 200 },
  birth_date: { type: 'string', format: 'date', description: 'The birth date. With `year_unknown` its year is a placeholder: the server stores 2000 (a leap year, so 29 February stays valid) whatever year is sent.' },
  year_unknown: {
    description: 'The year of birth is unknown (#2095): only day and month of `birth_date` count, and `next_age` is null. Responses carry it as 0 or 1. Omitted on update, the stored value stays; turning it off needs a `birth_date` with its real year in the same request.',
    oneOf: [
      { type: 'boolean' },
      { type: 'integer', enum: [0, 1] },
    ],
  },
  name_day: { type: ['string', 'null'], pattern: '^\\d{2}-\\d{2}$', description: 'Month and day (`MM-DD`), or null to clear it.' },
  notes: { type: ['string', 'null'], maxLength: 5000 },
  photo_data: { type: ['string', 'null'], description: 'A base64 image data URL (png, jpeg, webp, gif), or null to remove it.' },
  reminder_offset: {
    description: 'Lead time before 12:00 on the birthday in the household time zone. Whole minutes as a number or digit string (`"1440"` = one day before), `"custom"` to use `reminder_custom_amount` and `reminder_custom_unit`, `""` for no reminder and no calendar event, or null for the day itself. On update, a value equal to the one already stored is accepted unchanged even if it lies outside these rules, so older records stay editable.',
    oneOf: [
      { type: 'null' },
      { type: 'string', enum: ['', 'custom'] },
      { type: 'string', pattern: '^\\d{1,9}$' },
      { type: 'integer', minimum: 0, maximum: BIRTHDAY_REMINDER_MAX_MINUTES },
    ],
  },
  reminder_custom_amount: {
    description: 'Amount for a custom lead time, 1-999. Empty or null means unset (counted as 1).',
    oneOf: [
      { type: 'null' },
      { type: 'integer', minimum: 1, maximum: 999 },
      { type: 'string', pattern: '^([1-9]\\d{0,2})?$' },
    ],
  },
  reminder_custom_unit: {
    description: 'Unit for a custom lead time. Empty or null means unset (counted as days).',
    type: ['string', 'null'],
    enum: ['minutes', 'hours', 'days', 'weeks', '', null],
  },
  contact_id: {
    type: ['integer', 'null'],
    minimum: 1,
    description: 'Links the birthday to a contact of the household (Critique R22, D7), or null to unlink it. Linking needs read access to the `contacts` module as well (for API tokens `contacts:read`), otherwise 403. A contact can carry one birthday: one already linked elsewhere is refused with 409. Birthdays of household members cannot be linked. Linking does not copy or follow the contact\'s date. Omitted on update, the link stays; the value already stored is accepted unchanged.',
  },
};

// `GET /reminders/pending` und `/upcoming` lesen dieselbe Abfrage, nur `fires_at` kommt bei `/upcoming` dazu.
// Was jede Antwort ueber das angemeldete Konto mitbringt (Login, 2FA, /auth/me).
const accountContextProperties = {
  permissions: { $ref: '#/components/schemas/ClientPermissions' },
  householdSize: { type: 'integer', description: 'How many household members there are.' },
  initialsRoster: {
    type: 'array',
    items: { type: 'string' },
    description: 'The names a client resolves equal initials against. Empty for a split-expense guest.',
  },
  othersCanRead: {
    type: 'array',
    items: { type: 'string' },
    description: 'Modules another account can read too, which is when a privacy control means something.',
  },
};

const reminderProperties = {
  id: { type: 'integer' },
  entity_type: { type: 'string', description: 'The origin of the reminder, for example `task` or `event`.' },
  entity_id: { type: 'integer' },
  entity_title: {
    type: ['string', 'null'],
    description: 'Title of the entity, as far as the origin has one.',
  },
  remind_at: {
    type: 'string',
    description: 'As stored, and the form depends on who wrote the row: UTC without a zone suffix for a reminder set through this API, on rows from up to v2.68.0 possibly with an offset, and on derived types also `YYYY-MM-DDTHH:MM` or a UTC value with `Z` and possibly milliseconds. Parse it leniently; `GET /reminders/upcoming` has `fires_at` for scheduling.',
  },
  dismissed: { type: 'integer', enum: [0] },
  pushed_at: { type: ['string', 'null'] },
  assigned_from: {
    type: ['integer', 'null'],
    description: 'Set on a reminder inherited from the person who created the entity.',
  },
  created_by: { type: 'integer' },
  created_at: { type: 'string', format: 'date-time' },
  cycle_anchor_kind: {
    type: ['string', 'null'],
    description: 'On `cycle_period`: whether this is the caller\'s own cycle or one passed on to a partner.',
  },
  cycle_owner_name: { type: 'string', description: 'Only on a `partner_period` row.' },
  prevention_subject_name: { type: 'string', description: 'Only on an inherited `health_prevention_due` row.' },
  move_notice: { $ref: '#/components/schemas/ReminderMoveNotice', description: 'Only on `shopping_move_returned`.' },
  target_url: { type: 'string', description: 'Only on `shopping_move_returned`, while the list still exists.' },
};

const calendarOccurrenceProperties = {
  series_id: { type: 'integer', minimum: 1 },
  recurrence_id: {
    type: 'string',
    pattern: '^\\d{4}-\\d{2}-\\d{2}(T\\d{2}:\\d{2}:\\d{2}Z?)?$',
    description: 'The original occurrence, as RFC 5545 RECURRENCE-ID (#2034): `YYYY-MM-DD` for an all-day series, `YYYY-MM-DDTHH:MM:SSZ` (the original start in UTC) for a series with a time zone, `YYYY-MM-DDTHH:MM:SS` (floating wall time) for a local series without one. Up to v2.78.0 a timed occurrence was named by a `YYYY-MM-DD` day; linked occurrences stored before the change may still carry that form.',
  },
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
  start_datetime: { $ref: '#/components/schemas/CalendarDateOrDateTimeInput' },
  end_datetime: {
    oneOf: [
      { $ref: '#/components/schemas/CalendarDateOrDateTimeInput' },
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

// Was POST und PUT /calendar nehmen: die Felder eines Vorkommens ohne die
// Erinnerungen, die eine eigene Route haben, dazu Regel und Ziele.
const { reminder_offsets: _occurrenceOnly, ...calendarEventMutationProperties } = {
  ...calendarOccurrenceMutationProperties,
  ...calendarProviderTargetProperties,
  icon: {
    type: 'string',
    description: 'One of the icon names of the event editor; an unknown name answers 400. Omitted, empty or blank means `calendar` on create and leaves it untouched on update.',
  },
  attachment_name: { type: ['string', 'null'], description: 'File name for a new attachment; falls back to `Attachment`. MIME type and size are read from `attachment_data`.' },
  attachment_data: {
    type: ['string', 'null'],
    description: 'A base64 data URL (`data:<mime>;base64,<bytes>`) for a new attachment. PNG, JPEG, WebP, GIF, PDF, plain text, Word and Excel files; the bytes have to match the type.',
  },
  recurrence_rule: {
    type: ['string', 'null'],
    maxLength: 300,
    description: 'RRULE without the `RRULE:` prefix: `FREQ=DAILY|WEEKLY|MONTHLY|YEARLY`, optional `INTERVAL`, `BYDAY`, for MONTHLY `BYMONTHDAY=-1`, and either `UNTIL` or `COUNT`. Null or empty ends the repetition. A value equal to the stored rule is accepted unchecked, so an imported series that carries more stays editable.',
  },
};

const isoDay = (description) => ({ type: ['string', 'null'], format: 'date', description });
const utcStamp = (description) => ({ type: 'string', format: 'date-time', description });
const flag = (description) => ({ type: 'integer', enum: [0, 1], description });
const SYNC_BOOKKEEPING = 'Bookkeeping of the sync; says nothing a client acts on.';

const taskPriority = { type: 'string', enum: ['none', 'low', 'medium', 'high', 'urgent'] };
const taskVisibility = { type: 'string', enum: ['all', 'assignees', 'private'] };

const avatarField = (description) => ({
  type: ['string', 'null'],
  description: `${description} A cookie session gets a path (\`/api/v1/people/{id}/avatar?v=...\`), an API token or a device credential a data URL. Null without a picture.`,
});

// Eine Aufgabe, wie sie die Routen liefern: `t.*`, die Namen der Person und die
// Tags (server/routes/tasks.js). Flach und nicht ueber `allOf`, damit ein
// erzeugtes Modell keine verschachtelten Teile bekommt.
const taskProperties = {
  id: { type: 'integer' },
  title: { type: 'string' },
  description: { type: ['string', 'null'], description: 'Free text. Lines in the form `- [ ]` and `- [x]` are a checklist, see `PATCH /tasks/{id}/check`.' },
  category: { type: 'string', description: 'Key of a task category, see `GET /tasks/meta/options`. Categories are managed per household, so this is not a fixed list.' },
  priority: taskPriority,
  status: {
    type: 'string',
    enum: ['open', 'in_progress', 'done'],
    description: 'The state of the task. `archived` is not a status here: filing away is the separate axis `archived_at`.',
  },
  start_date: isoDay('`YYYY-MM-DD`, a plain calendar day without a time zone.'),
  due_date: isoDay('`YYYY-MM-DD`, a plain calendar day without a time zone.'),
  due_time: { type: ['string', 'null'], pattern: '^\\d{2}:\\d{2}$', description: '`HH:MM`, wall-clock time of the household.' },
  assigned_to: { type: ['integer', 'null'], description: 'The primary assignee, the first of `assigned_users`.' },
  created_by: { type: 'integer' },
  parent_task_id: { type: ['integer', 'null'], description: 'Set on a subtask. There are at most two levels.' },
  is_recurring: flag('1 when the task repeats, in the form 0 or 1.'),
  recurrence_rule: { type: ['string', 'null'], description: 'RRULE of the series. A task synced over CalDAV may carry more than the vocabulary the API accepts.' },
  recurrence_from_completion: flag('1 when the next occurrence counts from the day of completion instead of the due date.'),
  recurrence_origin_id: { type: ['integer', 'null'], description: 'The task this one followed in its series.' },
  recurrence_series_id: { type: ['integer', 'null'] },
  points: { type: 'integer', minimum: 0, maximum: 10000 },
  visibility: taskVisibility,
  countdown: flag('1 when the task shows as a countdown.'),
  locked: flag('1 when the definition of the task is closed to everyone but its creator and administrators (#830).'),
  sort_order: { type: ['integer', 'null'], description: 'Rank in the hand order of the category, null without a rank.' },
  archived_at: { type: ['string', 'null'], format: 'date-time', description: 'UTC instant with `Z`, null while the task is not filed away.' },
  created_at: utcStamp('UTC instant with `Z`, to the second.'),
  updated_at: utcStamp('UTC instant with `Z`, to the second.'),
  external_source: { type: 'string', enum: ['local', 'caldav'], description: '`caldav` for a task that lives on a CalDAV reminder list.' },
  external_uid: { type: ['string', 'null'] },
  external_account_id: { type: ['integer', 'null'] },
  external_object_url: { type: ['string', 'null'] },
  target_caldav_account_id: { type: ['integer', 'null'], description: 'The reminder list a local task is sent to.' },
  target_caldav_list_url: { type: ['string', 'null'] },
  outbound_dirty: flag(SYNC_BOOKKEEPING),
  outbound_attempts: { type: 'integer', minimum: 0, description: SYNC_BOOKKEEPING },
  seen_on_server: flag(SYNC_BOOKKEEPING),
  assigned_name: { type: ['string', 'null'], description: 'Name of `assigned_to`.' },
  assigned_color: { type: ['string', 'null'], description: 'Colour of `assigned_to`.' },
  assigned_avatar: avatarField('Picture of `assigned_to`.'),
  assigned_users: { type: 'array', items: { $ref: '#/components/schemas/AssignedPerson' } },
  tags: { type: 'array', items: { type: 'string' }, description: 'Free-form labels, distinct from the single `category`.' },
};

const taskRequired = [
  'id', 'title', 'description', 'category', 'priority', 'status', 'start_date', 'due_date', 'due_time',
  'assigned_to', 'created_by', 'parent_task_id', 'is_recurring', 'recurrence_rule', 'points', 'visibility',
  'countdown', 'locked', 'archived_at', 'created_at', 'updated_at', 'external_source',
  'assigned_name', 'assigned_color', 'assigned_avatar', 'assigned_users', 'tags',
];

// `urgentTasks` der Uebersicht liest `t.*` mit den Zugewiesenen, ohne Bild und Tags.
const { assigned_avatar: _assignedAvatar, tags: _tags, ...dashboardTaskProperties } = taskProperties;

const DOCUMENT_COUNT_FIELD = {
  type: ['integer', 'null'],
  minimum: 0,
  description: 'Linked documents the caller may see. Null without access to the Documents module: not told, which is not the same as 0.',
};

const taskInputProperties = {
  title: { type: 'string', minLength: 1, maxLength: 200 },
  description: { type: ['string', 'null'], maxLength: 5000 },
  category: { type: 'string', description: 'Key of a category of the household, see `GET /tasks/meta/options`; anything else answers 400. Defaults to `misc` on create.' },
  priority: { ...taskPriority, description: 'Defaults to `none` on create.' },
  start_date: isoDay('`YYYY-MM-DD`; has to be a real calendar day.'),
  due_date: isoDay('`YYYY-MM-DD`; has to be a real calendar day.'),
  due_time: { type: ['string', 'null'], pattern: '^([01]\\d|2[0-3]):[0-5]\\d$', description: '`HH:MM` wall-clock time of the household.' },
  assigned_to: {
    description: 'One user id, a list with the primary assignee first, or null for nobody. New assignees have to be household members (400 otherwise).',
    ...calendarOccurrenceMutationProperties.assigned_to,
  },
  tags: {
    description: 'A list, or one string with the tags separated by commas. At most 32 tags of 64 characters; more is cut off without an error, and tags differing only in case collapse. Omitted on update, the tags stay; an empty list removes them.',
    oneOf: [
      { type: 'array', items: { type: 'string' } },
      { type: 'string' },
      { type: 'null' },
    ],
  },
  is_recurring: { type: 'boolean', description: 'Read as true or false, so 0 and 1 work as well.' },
  recurrence_rule: {
    type: ['string', 'null'],
    maxLength: 300,
    description: 'RRULE without the `RRULE:` prefix: `FREQ=DAILY|WEEKLY|MONTHLY|YEARLY`, optional `INTERVAL`, `BYDAY`, for MONTHLY `BYMONTHDAY=-1`, and either `UNTIL` or `COUNT`. A value equal to the stored rule is accepted unchecked on update.',
  },
  recurrence_from_completion: { type: 'boolean', description: 'Read as true or false, so 0 and 1 work as well.' },
  points: {
    type: ['integer', 'null'],
    minimum: 0,
    maximum: 10000,
    description: 'Cut to a whole number from 0 to 10000 rather than refused. Omitted on create, a top-level task takes the default of the household (`default_points`), a subtask 0.',
  },
  visibility: { ...taskVisibility, description: 'An unknown value falls back to `all` on create and keeps the stored one on update, without an error.' },
  countdown: { type: 'boolean', description: 'Read as true or false, so 0 and 1 work as well.' },
  locked: { type: 'boolean', description: 'Read as true or false, so 0 and 1 work as well.' },
  sync_target: {
    type: ['string', 'null'],
    description: '`caldav:<accountId>|<listUrl>` from `GET /tasks/sync-targets`, or null or empty for local only. Ignored on a subtask, and on update once the task is on the server.',
  },
};

export const schemas = {
        CalendarImportInput: {
          type: 'object',
          description: 'Import an ICS document or URL into a household local calendar.',
          properties: {
            ics: { type: 'string', description: 'Raw ICS file text. Required when url is omitted.' },
            url: { type: 'string', format: 'uri', description: 'Shared calendar URL. Required when ics is omitted.' },
            color: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$', description: 'Fallback event color for imported events without their own color.' },
            local_calendar_id: { type: 'integer', minimum: 1, description: 'Target local calendar. Omit to use the default calendar.' },
            assignee_user_ids: {
              type: 'array', uniqueItems: true, items: { type: 'integer', minimum: 1 },
              description: 'People for this run (#1940), household members only; not stored. Every new event of the run is assigned to them (the first one primary). An event the caller already imported with the same UID - in any local calendar - is not created again: the people are added to the ones already on it, nobody is removed and nothing else changes. Omit for the behaviour without people.',
            },
            assignee_user_id: { type: 'integer', minimum: 1, description: 'One person, the short form of `assignee_user_ids`.' },
          },
          oneOf: [{ required: ['ics'] }, { required: ['url'] }],
        },
        LocalCalendarCreateInput: {
          type: 'object', required: ['name'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 80 },
            color: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
          },
        },
        LocalCalendarReorderInput: {
          type: 'object', required: ['order'], properties: {
            order: { type: 'array', uniqueItems: true, items: { type: 'integer', minimum: 1 } },
          },
        },
        LocalCalendarUpdateInput: {
          type: 'object',
          minProperties: 1,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 80 },
            color: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
            sort_order: { type: 'integer', minimum: 0 },
          },
        },
        ApiError: {
          type: 'object',
          properties: {
            error: { type: 'string' },
            code: { type: 'integer' },
            reason: { type: 'string' },
            params: {
              type: 'object',
              additionalProperties: { type: 'integer' },
              description: 'Only next to a `reason` whose cause carries a number (waste import and URL sources): the limit or status itself, e.g. `{ "limit_mb": 5 }`, so a client can put it into its own sentence instead of parsing `error`.',
            },
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
            reason: { type: 'string', const: 'outlook_auto_sync_overrides' },
            linked_override_count: { type: 'integer', minimum: 1 },
          },
        },
        NoteCategory: {
          type: 'object',
          required: ['id', 'name', 'scope', 'sort_order'],
          properties: {
            id: { type: 'integer' },
            name: { type: 'string', minLength: 1, maxLength: NOTE_CATEGORY_NAME_MAX_LENGTH },
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
            visibility: { type: 'string', enum: ['all', 'private'] },
            locked: { type: 'integer', enum: [0, 1] },
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
        BirthdayCreateInput: {
          type: 'object',
          required: ['name', 'birth_date'],
          properties: birthdayInputProperties,
        },
        BirthdayUpdateInput: {
          type: 'object',
          properties: birthdayInputProperties,
        },
        NoteCategoryInput: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: NOTE_CATEGORY_NAME_MAX_LENGTH },
            scope: { type: 'string', enum: ['personal', 'household'], default: 'personal' },
          },
        },
        NoteCategoryRenameInput: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: NOTE_CATEGORY_NAME_MAX_LENGTH },
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
            scope: { type: 'string', enum: ['household', 'user'], description: 'Read-only. The channel routes create and update household channels only.' },
            userId: { type: ['integer', 'null'], description: 'Read-only.' },
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
            subject_user_id: { type: ['integer', 'null'], description: 'The household member this document is about. Changes who is reminded, never who can see the document.' },
            subject_name: { type: ['string', 'null'] },
            subject_color: { type: ['string', 'null'] },
            expires_at: { type: ['string', 'null'], format: 'date', description: 'YYYY-MM-DD, e.g. a passport or permit expiry.' },
            expiry_reminder_days: { type: ['integer', 'null'], description: 'Days before expires_at to remind, 0-365. The same day marks the document as expiring soon; without a value that is 30 days before and no reminder is sent.' },
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
        // ZWEI SCHEMATA, weil Anfrage und Antwort nicht dieselbe Menge sind
        // (#1364): eine Anfrage mit `Z` oder Offset wird in die Haushaltszone
        // umgerechnet und kommt als Wanduhrzeit zurueck, ein aus einem
        // Fremdkalender synchronisierter Termin behaelt dagegen seinen Instant
        // samt Offset. Ein gemeinsames Schema hat beides als "normalized"
        // beschrieben und damit das Abschneiden wie eine Umrechnung aussehen
        // lassen.
        CalendarDateOrDateTime: {
          description: 'A calendar date or date-time as stored and returned. Events created or edited through the API or the app carry household wall-clock time; events that came in through calendar sync (CalDAV, Google, Outlook, ICS) keep the instant they arrived with, including its Z or numeric offset.',
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
              description: 'Yuvomi local wall-clock value in the household time zone, without offset.',
            },
            {
              type: 'string',
              pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?(?:Z|[+-]\\d{2}:?\\d{2})$',
              description: 'Instant with Z or a numeric offset, as stored for a synchronized event. Returned unchanged.',
            },
          ],
        },
        CalendarDateOrDateTimeInput: {
          description: 'A calendar date or date-time accepted by calendar mutations. What is stored is household wall-clock time: a value without offset is taken as such, a value with Z or a numeric offset is converted into the household time zone.',
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
              description: 'Yuvomi local wall-clock value in the household time zone. Seconds and fractional seconds are optional and are dropped; stored as YYYY-MM-DDTHH:MM.',
            },
            {
              type: 'string',
              pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?(?:Z|[+-]\\d{2}:?\\d{2})$',
              description: 'UTC or numeric-offset input. Read as an instant and converted into household wall-clock time, stored as YYYY-MM-DDTHH:MM - 2026-09-21T16:00:00Z in a Europe/Berlin household becomes 2026-09-21T18:00. For an all-day event only the date counts: the value is stored as its YYYY-MM-DD date as sent, so a midnight-UTC start stays on its day west of UTC. In the hour a DST change repeats, two instants map to the same wall-clock time; the stored value cannot tell them apart, so one of the two reads back an hour off.',
            },
          ],
        },
        AssignedPerson: {
          type: 'object',
          description: 'A person assigned to a task or an event.',
          required: ['id', 'display_name', 'color', 'avatar_data'],
          properties: {
            id: { type: 'integer' },
            display_name: { type: 'string' },
            color: { type: 'string', description: 'Avatar colour as #RRGGBB.' },
            avatar_data: avatarField('Picture of the person.'),
          },
        },
        Task: {
          type: 'object',
          description: 'A task as `POST /tasks` returns it, and each entry of `subtasks` in the single-task answers.',
          required: taskRequired,
          properties: taskProperties,
        },
        TaskSubtaskSummary: {
          type: 'object',
          description: 'The short form of a subtask in the list.',
          required: ['id', 'title', 'status'],
          properties: {
            id: { type: 'integer' },
            title: { type: 'string' },
            status: taskProperties.status,
          },
        },
        TaskListItem: {
          type: 'object',
          description: 'A top-level task in `GET /tasks`. Subtasks the caller may not see count nowhere.',
          required: [...taskRequired, 'subtask_total', 'subtask_done', 'subtasks', 'document_count'],
          properties: {
            ...taskProperties,
            subtask_total: { type: 'integer', minimum: 0 },
            subtask_done: { type: 'integer', minimum: 0 },
            subtasks: { type: 'array', items: { $ref: '#/components/schemas/TaskSubtaskSummary' } },
            document_count: DOCUMENT_COUNT_FIELD,
          },
        },
        TaskLinkedDocument: {
          type: 'object',
          description: 'A document linked to a task that the caller may see.',
          required: ['id', 'name', 'category', 'original_name', 'mime_type', 'file_size', 'storage_backend', 'linked_at'],
          properties: {
            id: { type: 'integer' },
            name: { type: 'string' },
            category: { type: 'string' },
            original_name: { type: 'string' },
            mime_type: { type: 'string' },
            file_size: { type: 'integer', minimum: 0 },
            storage_backend: { type: 'string' },
            linked_at: utcStamp('UTC instant with `Z`, to the second.'),
          },
        },
        TaskDetail: {
          type: 'object',
          description: 'A top-level task in `GET /tasks/{id}`, with full subtasks and its documents.',
          required: [...taskRequired, 'subtasks', 'document_count', 'documents'],
          properties: {
            ...taskProperties,
            subtasks: { type: 'array', items: { $ref: '#/components/schemas/Task' } },
            document_count: DOCUMENT_COUNT_FIELD,
            documents: {
              type: ['array', 'null'],
              items: { $ref: '#/components/schemas/TaskLinkedDocument' },
              description: 'Null without access to the Documents module: not told, which is not the same as an empty list.',
            },
          },
        },
        TaskUpdated: {
          type: 'object',
          description: 'A task after `PUT /tasks/{id}`. Documents are not part of this answer.',
          required: [...taskRequired, 'subtasks', 'next_due_date'],
          properties: {
            ...taskProperties,
            subtasks: { type: 'array', items: { $ref: '#/components/schemas/Task' } },
            next_due_date: isoDay('`YYYY-MM-DD` of the next occurrence the caller can see when this call moved a recurring task into `done`, null in every other case.'),
          },
        },
        TaskResponse: {
          type: 'object',
          required: ['data'],
          properties: { data: { $ref: '#/components/schemas/Task' } },
        },
        TaskListResponse: {
          type: 'object',
          required: ['data'],
          properties: { data: { type: 'array', items: { $ref: '#/components/schemas/TaskListItem' } } },
        },
        TaskDetailResponse: {
          type: 'object',
          required: ['data'],
          properties: { data: { $ref: '#/components/schemas/TaskDetail' } },
        },
        TaskUpdatedResponse: {
          type: 'object',
          required: ['data'],
          properties: { data: { $ref: '#/components/schemas/TaskUpdated' } },
        },
        TaskStatusResponse: {
          type: 'object',
          required: ['data'],
          properties: {
            data: {
              type: 'object',
              required: ['id', 'status', 'archived_at'],
              properties: {
                id: { type: 'integer' },
                status: taskProperties.status,
                archived_at: taskProperties.archived_at,
                next_due_date: isoDay('`YYYY-MM-DD`. Left out after sending `archived`.'),
              },
            },
          },
        },
        TaskCheckResponse: {
          type: 'object',
          required: ['data'],
          properties: {
            data: {
              type: 'object',
              required: ['id', 'description'],
              properties: {
                id: { type: 'integer' },
                description: { type: 'string', description: 'The whole description after the change.' },
              },
            },
          },
        },
        TaskCategory: {
          type: 'object',
          description: 'A task category. A built-in one has `label_key` and no `name`; one the household created or renamed has `name` and no `label_key`.',
          required: ['key', 'name', 'label_key', 'sort_order'],
          properties: {
            key: { type: 'string' },
            name: { type: ['string', 'null'] },
            label_key: { type: ['string', 'null'], description: 'Translation key of a built-in category.' },
            sort_order: { type: 'integer' },
          },
        },
        TaskOptionsResponse: {
          type: 'object',
          description: 'The values of the task editor and its filters. Unlike the other task answers this one has no `data` wrapper.',
          required: ['users', 'priorities', 'statuses', 'categories', 'tags', 'default_points'],
          properties: {
            users: {
              type: 'array',
              description: 'Household members, in their order.',
              items: {
                type: 'object',
                required: ['id', 'display_name', 'avatar_color', 'sort_order'],
                properties: {
                  id: { type: 'integer' },
                  display_name: { type: 'string' },
                  avatar_color: { type: 'string' },
                  sort_order: { type: ['integer', 'null'], description: 'Position among the household members, null for an unplaced member.' },
                },
              },
            },
            priorities: { type: 'array', items: taskPriority },
            statuses: {
              type: 'array',
              description: 'What the `status` filter and input take. `archived` stands for the archive here; a task never reads back with it.',
              items: { type: 'string', enum: ['open', 'in_progress', 'done', 'archived'] },
            },
            categories: { type: 'array', items: { $ref: '#/components/schemas/TaskCategory' } },
            tags: {
              type: 'array',
              description: 'Tags on tasks the caller can see, most used first.',
              items: {
                type: 'object',
                required: ['tag', 'count'],
                properties: {
                  tag: { type: 'string' },
                  count: { type: 'integer', minimum: 1 },
                },
              },
            },
            default_points: { type: 'integer', minimum: 0, maximum: 10000, description: 'Points a new top-level task takes when the request names none. 0 means no default.' },
          },
        },
        TaskCreateInput: {
          type: 'object',
          required: ['title'],
          properties: {
            ...taskInputProperties,
            status: {
              type: ['string', 'null'],
              enum: ['open', 'in_progress', 'done', 'archived', null],
              description: 'Defaults to `open`. `archived` and null fall back to `open`, see the operation.',
            },
            parent_task_id: { type: ['integer', 'null'], minimum: 1, description: 'Creates a subtask. Its parent must be a top-level task the caller can see.' },
          },
        },
        TaskUpdateInput: {
          type: 'object',
          description: 'Every field is optional: what is left out stays as stored.',
          properties: {
            ...taskInputProperties,
            status: {
              type: 'string',
              enum: ['open', 'in_progress', 'done', 'archived'],
              description: '`archived` files the task away and leaves the status as it is.',
            },
          },
        },
        TaskStatusInput: {
          type: 'object',
          required: ['status'],
          properties: {
            status: { type: 'string', enum: ['open', 'in_progress', 'done', 'archived'] },
            done_by_user_id: {
              type: ['integer', 'null'],
              minimum: 1,
              description: 'Who did the task, see the operation. Read only on the transition into `done`.',
            },
          },
        },
        TaskCheckInput: {
          type: 'object',
          required: ['line', 'checked'],
          properties: {
            line: { type: 'integer', minimum: 0, description: 'Line of the description, counted from 0.' },
            checked: { type: 'boolean' },
            expect: { type: ['string', 'null'], description: 'The line as the caller saw it, including `- [ ]`. A different line answers 409 with reason `stale`.' },
          },
        },
        CalendarEventCreateInput: {
          type: 'object',
          required: ['title', 'start_datetime'],
          properties: {
            ...calendarEventMutationProperties,
            local_calendar_id: {
              type: ['integer', 'null'],
              minimum: 1,
              description: 'A local calendar of the household. Omit or send null for the default calendar. Not together with a sync target (400).',
            },
          },
        },
        CalendarEventUpdateInput: {
          type: 'object',
          description: 'Every field is optional: what is left out stays as stored. Null in `end_datetime`, `description` or `location` clears the field, null in `color` clears the event\'s own colour.',
          properties: {
            ...calendarEventMutationProperties,
            local_calendar_id: {
              type: 'integer',
              minimum: 1,
              description: 'Moves a local event to another local calendar. Null answers 400, and so does an event that is no local one.',
            },
            remove_attachment: { type: 'boolean', description: 'Unlinks the attachment; the document stays in the library.' },
            confirmed_orphan_count: { type: 'integer', minimum: 0, description: 'The count from a 409 with `calendar_override_orphans`, see the operation.' },
          },
        },
        LocalCalendarListItem: {
          type: 'object',
          required: ['id', 'name', 'color', 'is_default', 'sort_order', 'feed_token', 'feed_url', 'event_count', 'uploads_to_icloud'],
          properties: {
            id: { type: 'integer' },
            name: { type: 'string' },
            color: { type: 'string', description: 'Colour as #RRGGBB.' },
            is_default: { type: 'boolean' },
            sort_order: { type: 'integer', minimum: 0 },
            feed_token: { type: ['string', 'null'], description: 'Null without an active feed, and always for anyone but an administrator.' },
            feed_url: { type: ['string', 'null'], description: 'Null without an active feed, and always for anyone but an administrator.' },
            event_count: { type: 'integer', minimum: 0, description: 'Events of this calendar the caller can see.' },
            uploads_to_icloud: { type: 'boolean' },
          },
        },
        CalendarEvent: {
          type: 'object',
          description: 'Calendar event. New attachments use document URLs; attachment_data remains available for legacy stored blobs.',
          properties: {
            id: { type: 'integer' },
            title: { type: 'string' },
            description: { type: ['string', 'null'] },
            start_datetime: { $ref: '#/components/schemas/CalendarDateOrDateTime' },
            end_datetime: {
              oneOf: [
                { $ref: '#/components/schemas/CalendarDateOrDateTime' },
                { type: 'null' },
              ],
              description: 'Inclusive last day for an all-day event, the end for a timed one. Null without an end.',
            },
            all_day: flag('1 for an all-day event, in the form 0 or 1. Start and end are then normally `YYYY-MM-DD`.'),
            tzid: { type: ['string', 'null'], description: 'IANA zone an imported or synchronized event was written in; its start and end then usually are instants with `Z`. Null for an event carrying household wall-clock time.' },
            location: { type: ['string', 'null'], description: 'May run over several lines for a place chosen through a map search.' },
            icon: { type: 'string', description: 'Icon name of the event editor.' },
            recurrence_rule: { type: ['string', 'null'], description: 'RRULE of the series, null for a single event. On an expanded occurrence the rule of its series. A synchronized series may carry more than the vocabulary the API accepts.' },
            visibility: taskVisibility,
            countdown: flag('1 when the event shows as a countdown.'),
            assigned_to: { type: ['integer', 'null'], description: 'The primary assignee.' },
            assigned_name: { type: ['string', 'null'], description: 'Name of `assigned_to`.' },
            assigned_color: { type: ['string', 'null'], description: 'Colour of `assigned_to`.' },
            assigned_users: { type: 'array', items: { $ref: '#/components/schemas/AssignedPerson' } },
            created_by: { type: 'integer' },
            creator_name: { type: ['string', 'null'], description: 'Name of `created_by`. Not part of `GET /calendar/upcoming`.' },
            created_at: utcStamp('UTC instant with `Z`, to the second.'),
            updated_at: utcStamp('UTC instant with `Z`, to the second.'),
            external_source: {
              type: 'string',
              enum: ['local', 'google', 'apple', 'ics', 'caldav'],
              description: 'Where the event lives. `local` also for one sent to a provider that has not come back from the sync yet, and for an imported one.',
            },
            external_calendar_id: { type: ['string', 'null'] },
            external_object_url: { type: ['string', 'null'] },
            subscription_id: { type: ['integer', 'null'], description: 'The ICS subscription the event came from.' },
            calendar_ref_id: { type: ['integer', 'null'], description: 'The synced calendar the event came from.' },
            caldav_account_id: { type: ['integer', 'null'] },
            cal_name: { type: ['string', 'null'], description: 'Name of the synced calendar or ICS subscription.' },
            source_calendar_ref_id: { type: ['integer', 'null'], description: 'The synced calendar, also for an event still waiting for its upload.' },
            source_calendar_name: { type: ['string', 'null'] },
            source_calendar_color: { type: ['string', 'null'] },
            ...calendarProviderTargetProperties,
            user_modified: flag('1 once a synced event was edited in Yuvomi.'),
            color_modified: flag(SYNC_BOOKKEEPING),
            series_authored: flag(SYNC_BOOKKEEPING),
            outbound_dirty: flag(SYNC_BOOKKEEPING),
            outbound_attempts: { type: 'integer', minimum: 0, description: SYNC_BOOKKEEPING },
            outbound_move_to: { type: ['string', 'null'], description: SYNC_BOOKKEEPING },
            housekeeping_visit_id: { type: ['integer', 'null'], description: 'The housekeeping visit behind the event. `GET /calendar/{id}` fills it, the other answers carry null.' },
            birthday_name: { type: 'string', description: 'Only on an event generated from the birthdays module.' },
            birthday_date: { type: ['string', 'null'], format: 'date', description: 'Only on a generated event. Null when the year of birth is unknown.' },
            birthday_event_kind: { type: 'string', enum: ['birthday', 'name_day'], description: 'Only on a generated event.' },
            name_day: { type: ['string', 'null'], pattern: '^\\d{2}-\\d{2}$', description: '`MM-DD`, only on a generated event.' },
            is_recurring_instance: flag('Present on a row expanded from a series: 0 on the first slot of the series, 1 on every later one.'),
            is_series_start: flag('Present on a row expanded from a series: 1 for its first occurrence.'),
            color: {
              type: ['string', 'null'],
              description: 'The event\'s own colour as #RRGGBB, or null when it has none. Null is the normal state for an event nobody picked a colour for: it then borrows the colour of the first assigned member, and failing that cal_color. On PUT the field distinguishes two cases - omit it to leave the colour untouched, send null to deliberately clear it.',
            },
            cal_color: {
              type: ['string', 'null'],
              description: 'Inherited colour of the source calendar or ICS subscription, read-only. Applies to every event of that source and therefore says nothing about this one; it is the fallback below color and the assignee.',
            },
            local_calendar_id: {
              type: ['integer', 'null'],
              description: 'Resolved local calendar for an authored event; null for generated or externally synchronized events and events with a Google/CalDAV target. Omit on create to resolve to the default without storing it. Membership applies to a whole series, never a single occurrence.',
            },
            local_calendar_name: {
              type: ['string', 'null'],
              description: 'Display name of the local Yuvomi calendar, read-only.',
            },
            local_calendar_color: {
              type: ['string', 'null'],
              description: 'Colour of the local Yuvomi calendar, read-only. Used after event, assignee, and external source colours.',
            },
            attachment_name: { type: ['string', 'null'], description: 'Null when the event has no attachment or the caller may not read its document (see attachment_document_id).' },
            attachment_mime: { type: ['string', 'null'], description: 'Null when the event has no attachment or the caller may not read its document (see attachment_document_id).' },
            attachment_size: { type: ['integer', 'null'], description: 'Null when the event has no attachment or the caller may not read its document (see attachment_document_id).' },
            attachment_document_id: {
              type: ['integer', 'null'],
              description: 'The attachment\'s document in the Documents module. Null unless the caller may read that document: access to the Documents module (for API tokens a `documents:read` scope) and the document\'s own visibility. Without it the event carries no attachment at all - id, URLs, name, MIME type and size are null.',
            },
            attachment_locked: {
              type: ['boolean', 'null'],
              description: 'True when the event has an attachment whose document the caller may not see (for example a private document of another member); it names nothing about that document, and such an attachment cannot be replaced or removed by this caller. False otherwise. Null without read access to the Documents module (for API tokens a `documents:read` scope).',
            },
            attachment_preview_url: { type: ['string', 'null'], description: 'Null whenever attachment_document_id is null.' },
            attachment_download_url: { type: ['string', 'null'], description: 'Null whenever attachment_document_id is null.' },
            attachment_data: {
              type: ['string', 'null'],
              description: 'Legacy attachment data URL. Null for attachments linked through attachment_document_id.',
            },
            ...calendarOccurrenceProperties,
          },
          required: [
            'id',
            'title',
            'start_datetime',
            'end_datetime',
            'all_day',
            'attachment_document_id',
            'attachment_preview_url',
            'attachment_download_url',
            'attachment_data',
          ],
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
            product: {
              type: 'string',
              enum: ['yuvomi'],
              description: 'Identifies a Yuvomi instance. `app_name` cannot do that: a household can rename it.',
            },
            client_api: {
              type: 'integer',
              minimum: 0,
              description: 'The contract a native client relies on. It rises only when a client cannot work '
                + 'without the change, not with every release, so a client can tell a server that is too old '
                + 'before anyone signs in. 0 means no contract yet.',
            },
            app_name: { type: 'string' },
            setup_required: { type: 'boolean' },
            password_reset_enabled: {
              type: 'boolean',
              description: 'True when self-service password reset can actually deliver a mail '
                + '(SMTP configured AND BASE_URL set) and there are passwords to reset at all '
                + '(AUTH_ALLOW_PASSWORD_LOGIN not switched off). The login page gates the '
                + '"forgot password" link on this flag so it is never a dead end.',
            },
            max_upload_bytes: {
              type: 'integer',
              minimum: 0,
              description: 'The largest upload this server accepts. Only with a valid credential, like `version`: '
                + 'before sign-in there is nothing to upload.',
            },
          },
          required: ['product', 'client_api', 'app_name', 'setup_required', 'password_reset_enabled'],
        },
        ShoppingList: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            name: { type: 'string' },
            created_by: { type: 'integer' },
            created_at: { type: 'string', format: 'date-time' },
            updated_at: { type: 'string', format: 'date-time' },
          },
          required: ['id', 'name', 'created_by', 'created_at', 'updated_at'],
        },
        ShoppingListSummary: {
          description: 'A list with its counters, as `GET /shopping` carries it.',
          allOf: [
            { $ref: '#/components/schemas/ShoppingList' },
            {
              type: 'object',
              properties: {
                item_total: { type: 'integer', minimum: 0 },
                item_checked: { type: 'integer', minimum: 0 },
                accepts_new_items: {
                  type: 'integer',
                  enum: [0, 1],
                  description: '0 on a list that mirrors a CalDAV reminder list which is read-only for its account.',
                },
              },
              required: ['item_total', 'item_checked', 'accepts_new_items'],
            },
          ],
        },
        ShoppingListCreateInput: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 200, description: 'Trimmed before it is stored.' },
          },
          required: ['name'],
        },
        ShoppingListResponse: {
          type: 'object',
          properties: { data: { $ref: '#/components/schemas/ShoppingList' } },
          required: ['data'],
        },
        ShoppingListsResponse: {
          type: 'object',
          properties: { data: { type: 'array', items: { $ref: '#/components/schemas/ShoppingListSummary' } } },
          required: ['data'],
        },
        ShoppingListVersion: {
          type: 'object',
          properties: {
            list_id: { type: 'integer' },
            version: { type: 'integer', minimum: 0 },
          },
          required: ['list_id', 'version'],
        },
        ShoppingListVersionsResponse: {
          type: 'object',
          properties: { data: { type: 'array', items: { $ref: '#/components/schemas/ShoppingListVersion' } } },
          required: ['data'],
        },
        ShoppingListChange: {
          type: 'object',
          description: 'The change counter of a list around one write. When `before` equals the state a client holds, everything up to `after` is its own write. One write can move the counter by more than 1.',
          properties: {
            list_id: { type: 'integer' },
            before: { type: 'integer', minimum: 0 },
            after: { type: 'integer', minimum: 0 },
          },
          required: ['list_id', 'before', 'after'],
        },
        ShoppingCategory: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            name: { type: 'string' },
            icon: { type: 'string' },
            sort_order: { type: 'integer' },
            created_at: { type: 'string', format: 'date-time' },
          },
          required: ['id', 'name', 'icon', 'sort_order', 'created_at'],
        },
        ShoppingCategoriesResponse: {
          type: 'object',
          properties: { data: { type: 'array', items: { $ref: '#/components/schemas/ShoppingCategory' } } },
          required: ['data'],
        },
        ShoppingSuggestion: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            category: { type: 'string' },
            quantity: { type: ['string', 'null'] },
          },
          required: ['name', 'category', 'quantity'],
        },
        ShoppingSuggestionsResponse: {
          type: 'object',
          properties: { data: { type: 'array', maxItems: 8, items: { $ref: '#/components/schemas/ShoppingSuggestion' } } },
          required: ['data'],
        },
        ShoppingItem: {
          type: 'object',
          description: 'The fields from `external_uid` on are the bookkeeping of the CalDAV sync. They come with every item and a client has no use for them, so they are not required.',
          properties: {
            id: { type: 'integer' },
            list_id: { type: 'integer' },
            name: { type: 'string' },
            quantity: { type: ['string', 'null'], description: 'Free text, there is no separate unit.' },
            category: { type: 'string', description: 'The name of a shopping category.' },
            is_checked: { type: 'integer', enum: [0, 1] },
            notes: { type: ['string', 'null'] },
            url: { type: ['string', 'null'] },
            price_cents: { type: ['integer', 'null'], description: 'What was paid, in whole cents.' },
            store_id: { type: ['integer', 'null'] },
            sort_order: { type: 'integer', description: 'Rank within the category of this list.' },
            added_from_meal: { type: ['integer', 'null'], description: 'The meal the item was transferred from.' },
            created_at: { type: 'string', format: 'date-time' },
            updated_at: { type: 'string', format: 'date-time' },
            external_uid: { type: ['string', 'null'] },
            external_source: { type: 'string', description: '`local`, or `caldav` on an item mirrored from a CalDAV list.' },
            external_account_id: { type: ['integer', 'null'] },
            external_object_url: { type: ['string', 'null'] },
            outbound_dirty: { type: 'integer' },
            outbound_attempts: { type: 'integer' },
            outbound_move: { type: 'integer' },
            outbound_move_attempts: { type: 'integer' },
            outbound_move_since: { type: ['string', 'null'], description: 'UTC as `YYYY-MM-DD HH:MM:SS`.' },
            outbound_move_by: { type: ['integer', 'null'] },
            seen_on_server: { type: 'integer' },
          },
          required: [
            'id', 'list_id', 'name', 'quantity', 'category', 'is_checked', 'notes', 'url', 'price_cents', 'store_id',
            'sort_order', 'added_from_meal', 'created_at', 'updated_at',
          ],
        },
        ShoppingListItem: {
          description: 'An item as a list delivers it. Only reading a list adds `tags`, the answers of the item writes do not carry them.',
          allOf: [
            { $ref: '#/components/schemas/ShoppingItem' },
            {
              type: 'object',
              properties: {
                tags: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'The CATEGORIES of the mirrored CalDAV object, separate from `category`. Empty on a local item.',
                },
              },
              required: ['tags'],
            },
          ],
        },
        ShoppingItemsResponse: {
          type: 'object',
          properties: {
            data: { type: 'array', items: { $ref: '#/components/schemas/ShoppingListItem' } },
            list: { $ref: '#/components/schemas/ShoppingList' },
            categories: { type: 'array', items: { $ref: '#/components/schemas/ShoppingCategory' } },
            version: { type: 'integer', minimum: 0, description: 'The change counter that belongs to exactly these items.' },
          },
          required: ['data', 'list', 'categories', 'version'],
        },
        ShoppingItemCreateInput: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 200, description: 'Trimmed before it is stored.' },
            quantity: { type: ['string', 'null'], maxLength: 100, description: 'Free text. Empty means none.' },
            category: {
              type: ['string', 'null'],
              description: 'The name of an existing category, otherwise 400. Without it, `Sonstiges` while the household has that category, else the last one in shop order.',
            },
            notes: { type: ['string', 'null'], maxLength: 5000 },
            url: { type: ['string', 'null'], format: 'uri', maxLength: 2000, description: 'http or https only.' },
          },
          required: ['name'],
        },
        ShoppingItemUpdateInput: {
          type: 'object',
          description: 'Every field is optional, and one that is not sent stays as it is. Unlike creating an item, this route checks no length on `name` and `quantity`: the limits of `ShoppingItemCreateInput` are the ones to keep to.',
          properties: {
            is_checked: { type: 'boolean', description: 'Read as true or false by truthiness, so 0 and 1 work as well. Responses carry 0 or 1.' },
            name: { type: 'string', minLength: 1 },
            quantity: { type: ['string', 'null'] },
            category: { type: 'string', minLength: 1, description: 'The name of an existing category. It cannot be cleared.' },
            notes: { type: ['string', 'null'], maxLength: 5000 },
            url: { type: ['string', 'null'], format: 'uri', maxLength: 2000, description: 'http or https only.' },
            price_cents: {
              type: ['integer', 'null'],
              minimum: 0,
              maximum: 100000000,
              description: 'Whole cents. `null` or an empty string clears it, a string of digits is read as a number.',
            },
            store_id: {
              type: ['integer', 'null'],
              minimum: 1,
              description: '`null` or an empty string clears it, a string of digits is read as a number.',
            },
            list_id: {
              type: ['integer', 'null'],
              minimum: 1,
              description: 'Moves the item to this list. `null` or the list it is on means no move, a string of digits is read as a number.',
            },
          },
        },
        ShoppingItemResponse: {
          type: 'object',
          properties: {
            data: { $ref: '#/components/schemas/ShoppingItem' },
            list_change: { $ref: '#/components/schemas/ShoppingListChange' },
          },
          required: ['data', 'list_change'],
        },
        ShoppingItemDeleteResponse: {
          allOf: [
            { $ref: '#/components/schemas/OkResponse' },
            {
              type: 'object',
              properties: { list_change: { $ref: '#/components/schemas/ShoppingListChange' } },
              required: ['list_change'],
            },
          ],
        },
        ShoppingCheckedDeleteInput: {
          type: 'object',
          properties: {
            ids: {
              type: 'array',
              minItems: 1,
              items: { type: 'integer', minimum: 1 },
              description: 'Leaving the field out means every checked item. An empty array is refused with 400, not read as "all of them".',
            },
          },
        },
        ShoppingCheckedDeleteResponse: {
          type: 'object',
          properties: {
            deleted: { type: 'integer', minimum: 0 },
            list_change: {
              type: 'object',
              description: 'As in `ShoppingListChange`. `before` and `after` are null when the list does not exist.',
              properties: {
                list_id: { type: 'integer' },
                before: { type: ['integer', 'null'], minimum: 0 },
                after: { type: ['integer', 'null'], minimum: 0 },
              },
              required: ['list_id', 'before', 'after'],
            },
          },
          required: ['deleted', 'list_change'],
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
            access_scope: {
              type: 'string',
              description: 'What kind of account this is, for example `family`, `split_guest` or `display`.',
            },
            created_at: { type: 'string', format: 'date-time' },
            deactivated_at: {
              type: ['string', 'null'],
              format: 'date-time',
              description: 'Since when the account is deactivated, null for an active one.',
            },
            changelog_seen: {
              type: 'object',
              description: 'What the account last looked at in the changelog. Null means it never looked, which is another state than having seen everything.',
              properties: {
                version: { type: ['string', 'null'], description: 'The installed version at that moment.' },
                latest: { type: ['string', 'null'], description: 'The last published version known at that moment.' },
              },
              required: ['version', 'latest'],
            },
            phone: { type: ['string', 'null'] },
            email: { type: ['string', 'null'] },
            birth_date: { type: ['string', 'null'], format: 'date' },
            birth_year_unknown: { type: 'boolean', description: 'Only day and month of `birth_date` are known (#2095); the server then stores the placeholder year 2000 whatever year is sent. Without it, the stored flag only goes when a different date arrives.' },
            onboarding_pending: {
              type: 'boolean',
              description: 'Whether this account still needs the onboarding walkthrough. Derived from '
                + 'the account, not from the browser, so a new device does not repeat it. '
                + 'POST /auth/onboarding-seen clears it.',
            },
            sso_only: {
              type: 'boolean',
              description: 'Only present on GET /auth/users for administrators, and on GET /auth/me about '
                + 'the own account: the account carries no password and can only be entered through SSO.',
            },
            sort_order: {
              type: ['integer', 'null'],
              description: 'Position in the household member order, or null: for a member that has not been '
                + 'placed, and for every account that is no household member (staff, guest, deactivated).',
            },
            is_household_member: {
              type: 'boolean',
              description: 'Whether the account is a household member - the accounts GET /family/members '
                + 'lists and the only ones the member order takes.',
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
            birth_year_unknown: { type: 'boolean', description: 'Only day and month of `birth_date` are known (#2095); the server then stores the placeholder year 2000 whatever year is sent. Without it, the stored flag only goes when a different date arrives.' },
            created_at: { type: 'string', format: 'date-time' },
            sort_order: {
              type: ['integer', 'null'],
              description: 'Position in the household member order (set with PATCH /family/members/reorder), '
                + 'or null for a member that has not been placed. Placed members come first, by position; '
                + 'unplaced ones after them, by display name.',
            },
          },
          required: ['id', 'display_name', 'avatar_color', 'family_role'],
        },
        FamilyMemberReorderInput: {
          type: 'object',
          required: ['order'],
          properties: {
            order: {
              type: 'array',
              minItems: 1,
              uniqueItems: true,
              items: { type: 'integer', minimum: 1 },
              description: 'The ids of all household members, in the wanted order.',
            },
          },
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
            ...accountContextProperties,
            csrfToken: { type: 'string' },
          },
          required: ['user', 'permissions', 'householdSize', 'initialsRoster', 'othersCanRead', 'csrfToken'],
        },
        MeResponse: {
          type: 'object',
          properties: {
            user: { $ref: '#/components/schemas/User' },
            ...accountContextProperties,
            csrfToken: { type: 'string', description: 'Absent with a Bearer credential, which needs none.' },
            sessionExpiresAt: {
              type: ['integer', 'null'],
              description: 'When this browser session ends without further use, in milliseconds since the epoch. Absent with a Bearer credential.',
            },
            gravatarAvailable: {
              type: 'boolean',
              description: 'Whether the calling account may use the one-time Gravatar import '
                + '(`POST /api/v1/auth/me/avatar/gravatar`): true only when the operator set `GRAVATAR_BASE_URL` '
                + 'and the account is a household member. The configured URL itself is never exposed.',
            },
            gravatarHost: {
              type: ['string', 'null'],
              description: 'Host name of the service the operator configured in `GRAVATAR_BASE_URL` '
                + '(e.g. `gravatar.com` or a Libravatar mirror), so the account page can name where the hash goes. '
                + 'Host name only - no scheme, port, path or credentials. `null` unless `gravatarAvailable` is true, '
                + 'and `null` when the configured value is not a valid public https URL.',
            },
          },
          required: ['user', 'permissions', 'householdSize', 'initialsRoster', 'othersCanRead', 'gravatarAvailable', 'gravatarHost'],
        },
        SetupRequest: {
          type: 'object',
          properties: {
            username: { type: 'string' },
            display_name: { type: 'string' },
            password: { type: 'string' },
            language: {
              type: 'string',
              nullable: true,
              description: 'Optional. Language code of a supported app locale (e.g. `de`, `pt`, `fil`). '
                + 'Sets the household data language (the language of server-generated titles such as birthday events), '
                + 'unless the automatic choice already yields it. Region, currency and date format are not derived from it. '
                + 'Unsupported values are rejected with 400; omitted, null or empty keeps the previous behaviour.',
            },
            timezone: {
              type: 'string',
              nullable: true,
              description: 'Optional. IANA time zone of the household (e.g. `Europe/Berlin`). '
                + 'Unknown zones are rejected with 400; omitted, null or empty keeps the fallback to TZ, the system zone and UTC.',
            },
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
            birth_year_unknown: { type: 'boolean', description: 'Only day and month of `birth_date` are known (#2095); the server then stores the placeholder year 2000 whatever year is sent. Without it, the stored flag only goes when a different date arrives.' },
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
            birth_year_unknown: { type: 'boolean', description: 'Only day and month of `birth_date` are known (#2095); the server then stores the placeholder year 2000 whatever year is sent. Without it, the stored flag only goes when a different date arrives.' },
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
                invited_by: { type: ['string', 'null'], description: 'Display name of the member who created the invitation, or null when that account is gone.' },
                password_required: { type: 'boolean' },
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
            active: { type: 'boolean', description: 'Whether the token still signs in: not revoked and not past `expires_at`, judged by the server clock. Only a token with `active: false` can be removed.' },
            last_used_at: { type: ['string', 'null'], format: 'date-time' },
            created_at: { type: 'string', format: 'date-time' },
          },
          required: ['id', 'name', 'token_prefix', 'created_by', 'subject_user_id', 'created_at'],
        },
        ApiTokenCreateRequest: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            subject_user_id: { type: 'integer', minimum: 1, description: 'Optional family-member subject. Defaults to the administrator creating the token. Split-expense guests and wall displays are not eligible - neither can sign in, so neither may carry a credential beside its own.' },
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
        SignedInDevice: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            name: { type: 'string' },
            platform: { type: 'string', description: 'A short lowercase name, for example `ios`.' },
            last_used_at: { type: ['string', 'null'], format: 'date-time' },
            created_at: { type: 'string', format: 'date-time' },
            current: { type: 'boolean', description: 'Whether this device made the request.' },
          },
          required: ['id', 'name', 'platform', 'created_at', 'current'],
        },
        SignedInDeviceList: {
          type: 'object',
          properties: {
            data: { type: 'array', items: { $ref: '#/components/schemas/SignedInDevice' } },
          },
          required: ['data'],
        },
        SignedInDeviceCreateRequest: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 100 },
            platform: { type: 'string', pattern: '^[a-z][a-z0-9-]{1,19}$' },
            device_id: {
              type: 'string',
              pattern: '^[A-Za-z0-9._-]{8,128}$',
              description: 'Chosen by the client and stable per installation. Sending the same value again replaces the earlier credential.',
            },
          },
          required: ['name', 'platform', 'device_id'],
        },
        SignedInDeviceCreateResponse: {
          type: 'object',
          properties: {
            data: { $ref: '#/components/schemas/SignedInDevice' },
            credential: { type: 'string', description: 'The device credential, shown once. Send it as a Bearer token.' },
          },
          required: ['data', 'credential'],
        },
        ClientPermissions: {
          type: 'object',
          description: 'The resolved rights of the account, for hiding what it cannot reach. The server enforces them either way. A device is an ordinary member here, also for an administrator.',
          properties: {
            admin: { type: 'boolean' },
            modules: {
              type: 'object',
              description: 'Per module key. Extension modules bring their own keys.',
              additionalProperties: { type: 'string', enum: ['none', 'read', 'write'] },
            },
            widgets: {
              type: 'object',
              description: 'Per dashboard widget id.',
              additionalProperties: { type: 'string', enum: ['none', 'allow'] },
            },
            capabilities: {
              type: 'object',
              description: 'Per capability key.',
              additionalProperties: { type: 'string', enum: ['none', 'allow'] },
            },
          },
          required: ['admin', 'modules', 'widgets', 'capabilities'],
        },
        TwoFactorChallengeResponse: {
          type: 'object',
          description: 'The password was right, but no session exists yet. Continue with POST /auth/2fa/verify in the same cookie session.',
          properties: {
            twoFactorRequired: { type: 'boolean', enum: [true] },
            recoveryAvailable: { type: 'boolean', description: 'Whether unused recovery codes are left.' },
          },
          required: ['twoFactorRequired', 'recoveryAvailable'],
        },
        TwoFactorVerifyRequest: {
          type: 'object',
          properties: {
            code: { type: 'string', maxLength: 64, description: 'The six-digit TOTP code or a recovery code.' },
          },
          required: ['code'],
        },
        TwoFactorVerifyResponse: {
          type: 'object',
          properties: {
            user: { $ref: '#/components/schemas/User' },
            ...accountContextProperties,
            csrfToken: { type: 'string' },
            twoFactorMethod: { type: 'string', enum: ['totp', 'recovery'] },
            recoveryRemaining: { type: 'integer', minimum: 0 },
          },
          required: ['user', 'permissions', 'householdSize', 'initialsRoster', 'othersCanRead', 'csrfToken',
            'twoFactorMethod', 'recoveryRemaining'],
        },
        OidcConfigResponse: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean', description: 'OIDC is configured and enabled.' },
            password_login_enabled: { type: 'boolean' },
            guest_password_login_enabled: {
              type: 'boolean',
              description: 'True only where password login is off and split-expense guests exist, who are exempt from the switch.',
            },
          },
          required: ['enabled', 'password_login_enabled', 'guest_password_login_enabled'],
        },
        ReminderMoveNotice: {
          type: 'object',
          description: 'A move of a shopping item that was taken back. The names are a snapshot of the moment.',
          properties: {
            item_name: { type: 'string' },
            back_list_id: { type: ['integer', 'null'], description: 'Null once the list is gone.' },
            back_list_name: { type: 'string' },
            target_list_name: { type: 'string' },
            reason: { type: 'string', enum: ['refused', 'waited'] },
          },
          required: ['item_name', 'back_list_id', 'back_list_name', 'target_list_name', 'reason'],
        },
        PendingReminder: {
          type: 'object',
          properties: reminderProperties,
          required: ['id', 'entity_type', 'entity_id', 'remind_at', 'created_by'],
        },
        PendingReminderList: {
          type: 'object',
          properties: {
            data: { type: 'array', items: { $ref: '#/components/schemas/PendingReminder' } },
          },
          required: ['data'],
        },
        ReminderDismissResponse: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: { id: { type: 'integer' } },
              required: ['id'],
            },
          },
          required: ['data'],
        },
        DashboardWeekPerson: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            display_name: { type: 'string' },
            color: { type: 'string' },
          },
          required: ['id', 'display_name', 'color'],
        },
        DashboardUser: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            display_name: { type: 'string' },
            avatar_color: { type: 'string' },
            avatar_data: { type: ['string', 'null'] },
            sort_order: { type: ['integer', 'null'] },
          },
          required: ['id', 'display_name', 'avatar_color', 'avatar_data', 'sort_order'],
        },
        DashboardWeekEvent: {
          type: 'object',
          description: 'An appointment in the compact shape of the week strip.',
          properties: {
            id: { type: 'integer' },
            title: { type: 'string' },
            start_datetime: { type: 'string', description: 'A date alone for an all-day appointment.' },
            end_datetime: { type: ['string', 'null'] },
            all_day: { type: 'integer', enum: [0, 1] },
            color: { type: ['string', 'null'] },
            cal_color: { type: ['string', 'null'] },
            assigned_to: { type: ['integer', 'null'] },
            assigned_users: { type: 'array', items: { $ref: '#/components/schemas/DashboardWeekPerson' } },
            birthday_name: { type: ['string', 'null'] },
            birthday_date: { type: ['string', 'null'] },
            birthday_event_kind: { type: ['string', 'null'] },
          },
          required: ['id', 'title', 'start_datetime', 'end_datetime', 'all_day', 'color', 'cal_color', 'assigned_to',
            'assigned_users', 'birthday_name', 'birthday_date', 'birthday_event_kind'],
        },
        DashboardTask: {
          type: 'object',
          description: 'A task of `urgentTasks`: the fields of `Task` without the picture of `assigned_to` and the tags.',
          properties: dashboardTaskProperties,
          required: taskRequired.filter((field) => field in dashboardTaskProperties),
        },
        DashboardMemberTaskCount: {
          type: 'object',
          properties: {
            user_id: { type: 'integer' },
            open_count: { type: 'integer' },
          },
          required: ['user_id', 'open_count'],
        },
        DashboardWallTasks: {
          type: 'object',
          properties: {
            user_id: { type: 'integer' },
            open_count: { type: 'integer' },
            done_count: { type: 'integer' },
            open: {
              type: 'array',
              maxItems: 6,
              items: {
                type: 'object',
                properties: {
                  id: { type: 'integer' },
                  title: { type: 'string' },
                  due_date: { type: 'string', format: 'date' },
                },
                required: ['id', 'title', 'due_date'],
              },
            },
            done: {
              type: 'array',
              maxItems: 6,
              items: {
                type: 'object',
                properties: {
                  id: { type: 'integer' },
                  title: { type: 'string' },
                },
                required: ['id', 'title'],
              },
            },
          },
          required: ['user_id', 'open_count', 'done_count', 'open', 'done'],
        },
        DashboardMeal: {
          type: 'object',
          description: 'A paired wall display reads with `audience=household` and gets only the required fields.',
          properties: {
            id: { type: 'integer' },
            date: { type: 'string', format: 'date' },
            meal_type: { type: 'string' },
            title: { type: 'string' },
            notes: { type: ['string', 'null'] },
            recipe_url: { type: ['string', 'null'] },
            recipe_id: { type: ['integer', 'null'] },
            recurrence_template_id: { type: ['integer', 'null'] },
            cook_user_id: { type: ['integer', 'null'] },
            cook_name: { type: ['string', 'null'] },
            cook_color: { type: ['string', 'null'] },
            recipe_has_image: { type: ['integer', 'null'] },
            recipe_has_own_image: { type: ['integer', 'null'] },
            recipe_image_version: { type: ['string', 'null'] },
            created_by: { type: ['integer', 'null'] },
            created_at: { type: 'string' },
            updated_at: { type: 'string' },
          },
          required: ['id', 'date', 'meal_type', 'title', 'recipe_id', 'cook_user_id', 'cook_name', 'cook_color',
            'recipe_has_image', 'recipe_has_own_image'],
        },
        DashboardNote: {
          type: 'object',
          required: ['id', 'content', 'pinned', 'categories'],
          properties: {
            id: { type: 'integer' },
            title: { type: ['string', 'null'] },
            content: { type: 'string' },
            color: { type: 'string' },
            pinned: { type: 'integer', enum: [0, 1] },
            visibility: { type: 'string', enum: ['all', 'private'] },
            locked: { type: 'integer', enum: [0, 1] },
            created_by: { type: ['integer', 'null'] },
            author_name: { type: ['string', 'null'] },
            author_color: { type: ['string', 'null'] },
            created_at: { type: 'string' },
            updated_at: { type: 'string' },
            categories: { type: 'array', items: { $ref: '#/components/schemas/NoteCategory' } },
          },
        },
        DashboardShoppingItem: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            name: { type: 'string' },
            quantity: { type: ['string', 'null'] },
            is_checked: { type: 'integer', enum: [0] },
          },
          required: ['id', 'name', 'quantity', 'is_checked'],
        },
        DashboardShoppingList: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            name: { type: 'string' },
            open_count: { type: 'integer' },
            total_count: { type: 'integer' },
            items: {
              type: 'array',
              maxItems: 6,
              items: { $ref: '#/components/schemas/DashboardShoppingItem' },
            },
          },
          required: ['id', 'name', 'open_count', 'total_count', 'items'],
        },
        DashboardShoppingTile: {
          type: 'object',
          properties: {
            lists: { type: 'array', maxItems: 3, items: { $ref: '#/components/schemas/DashboardShoppingList' } },
            openCount: { type: 'integer' },
            listCount: { type: 'integer', description: 'Every selected list that exists, also beyond the three in `lists`.' },
          },
          required: ['lists', 'openCount', 'listCount'],
        },
        DashboardBirthday: {
          type: 'object',
          description: 'One occasion: a person with a birthday and a name day has two rows.',
          properties: {
            id: { type: 'integer' },
            name: { type: 'string' },
            kind: { type: 'string', enum: ['birthday', 'name_day'] },
            next_date: { type: 'string', format: 'date' },
            days_until: { type: 'integer' },
            birth_date: { type: 'string', format: 'date' },
            year_unknown: { type: 'integer', enum: [0, 1] },
            name_day: { type: ['string', 'null'], description: '`MM-DD`.' },
            next_birthday: { type: 'string', format: 'date' },
            next_age: { type: ['integer', 'null'], description: 'Null on a name day and when the year is unknown.' },
            next_name_day: { type: ['string', 'null'], format: 'date' },
            name_day_days_until: { type: ['integer', 'null'] },
            notes: { type: ['string', 'null'] },
            photo_data: { type: ['string', 'null'] },
            family_user_id: { type: ['integer', 'null'] },
            family_user_color: { type: ['string', 'null'] },
            contact_id: { type: ['integer', 'null'] },
            calendar_event_id: { type: ['integer', 'null'] },
            name_day_calendar_event_id: { type: ['integer', 'null'] },
            reminder_offset: { type: ['string', 'null'] },
            reminder_custom_amount: { type: ['integer', 'null'] },
            reminder_custom_unit: { type: ['string', 'null'] },
            created_by: { type: ['integer', 'null'] },
            created_at: { type: 'string' },
            updated_at: { type: 'string' },
          },
          required: ['id', 'name', 'kind', 'next_date', 'days_until', 'birth_date'],
        },
        DashboardCountdown: {
          type: 'object',
          properties: {
            source: { type: 'string', enum: ['event', 'task', 'document'] },
            id: { type: 'integer' },
            title: { type: 'string' },
            date: { type: 'string', format: 'date' },
            days_until: { type: 'integer', description: 'Negative within the grace period after the date.' },
            icon: { type: ['string', 'null'] },
            color: { type: ['string', 'null'] },
            recurring: { type: 'boolean' },
            person_name: { type: ['string', 'null'], description: 'Only on `document`.' },
            series_id: { type: ['integer', 'null'], description: 'Only on an appointment that replaces one occurrence.' },
            recurrence_id: { type: ['string', 'null'], description: 'Only on an appointment that replaces one occurrence.' },
            is_occurrence_override: { type: 'boolean', description: 'Only on an appointment that replaces one occurrence.' },
            assignment_owner_id: { type: ['integer', 'null'], description: 'Only on an appointment that replaces one occurrence.' },
            attachment_owner_id: { type: ['integer', 'null'], description: 'Only on an appointment that replaces one occurrence.' },
            reminder_owner_id: { type: ['integer', 'null'], description: 'Only on an appointment that replaces one occurrence.' },
            reminder_anchor_start: { type: ['string', 'null'], description: 'Only on an appointment that replaces one occurrence.' },
          },
          required: ['source', 'id', 'title', 'date', 'days_until', 'icon', 'color', 'recurring'],
        },
        DashboardQuickLink: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            name: { type: 'string' },
            url: { type: 'string' },
            icon_data: { type: ['string', 'null'] },
            icon_name: { type: ['string', 'null'] },
            color: { type: ['string', 'null'] },
            visibility: { type: 'string' },
            created_by: { type: ['integer', 'null'] },
            position: { type: 'integer' },
            created_at: { type: 'string' },
            updated_at: { type: 'string' },
            can_edit: { type: 'boolean' },
          },
          required: ['id', 'name', 'url', 'can_edit'],
        },
        DashboardSplitBalance: {
          type: 'object',
          properties: {
            net: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  currency: { type: 'string' },
                  netMinor: { type: 'integer', description: 'In minor units, negative when the caller owes.' },
                  amount: { type: 'string', description: 'The same value as a decimal string.' },
                },
                required: ['currency', 'netMinor', 'amount'],
              },
            },
            positions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  direction: { type: 'string', enum: ['owe', 'owed'] },
                  userId: { type: 'integer' },
                  name: { type: 'string' },
                  groupId: { type: 'integer' },
                  groupName: { type: 'string' },
                  currency: { type: 'string' },
                  amountMinor: { type: 'integer' },
                  amount: { type: 'string', description: 'The same value as a decimal string.' },
                },
                required: ['direction', 'userId', 'name', 'groupId', 'groupName', 'currency', 'amountMinor', 'amount'],
              },
            },
          },
          required: ['net', 'positions'],
        },
        DashboardRewards: {
          type: 'object',
          properties: {
            view: {
              type: ['string', 'null'],
              enum: ['approver', 'self', 'family', null],
              description: '`approver` sees every participant and all open requests, `self` only the own row and requests, `family` everybody by name without requests. Null without access to the module.',
            },
            me: { type: 'integer', description: 'The caller. Missing without access to the module.' },
            standings: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'integer' },
                  display_name: { type: 'string' },
                  avatar_color: { type: 'string' },
                  avatar_data: { type: ['string', 'null'] },
                  family_role: { type: 'string' },
                  sort_order: { type: ['integer', 'null'] },
                  balance: { type: 'integer' },
                },
                required: ['id', 'display_name', 'avatar_color', 'avatar_data', 'family_role', 'sort_order', 'balance'],
              },
            },
            participantCount: { type: 'integer' },
            pending: { type: 'integer', description: 'Open requests for rewards.' },
            moneyPending: { type: 'integer', description: 'Open requests for money.' },
            catalog: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'integer' },
                  name: { type: 'string' },
                  cost: { type: 'integer' },
                  remaining: { type: ['integer', 'null'], description: 'Null when the reward has no limit.' },
                },
                required: ['id', 'name', 'cost', 'remaining'],
              },
            },
            recent: {
              type: 'array',
              maxItems: 3,
              items: {
                type: 'object',
                properties: {
                  delta: { type: 'integer' },
                  type: { type: 'string', enum: ['earn', 'bonus'] },
                  reason: { type: ['string', 'null'] },
                  created_at: { type: 'string', format: 'date-time' },
                },
                required: ['delta', 'type', 'reason', 'created_at'],
              },
            },
          },
          required: ['view', 'standings', 'participantCount', 'pending', 'moneyPending', 'catalog', 'recent'],
        },
        DashboardNutrientTotals: {
          type: 'object',
          properties: {
            energy_kcal: { type: 'number' },
            fat_g: { type: 'number' },
            saturated_fat_g: { type: 'number' },
            carbs_g: { type: 'number' },
            sugar_g: { type: 'number' },
            protein_g: { type: 'number' },
            salt_g: { type: 'number' },
            fiber_g: { type: 'number' },
          },
          required: ['energy_kcal', 'fat_g', 'saturated_fat_g', 'carbs_g', 'sugar_g', 'protein_g', 'salt_g', 'fiber_g'],
        },
        DashboardNutrientTarget: {
          type: 'object',
          description: 'Null in a field means no target for this nutrient, which is another statement than a target of 0.',
          properties: {
            energy_kcal: { type: ['number', 'null'] },
            fat_g: { type: ['number', 'null'] },
            saturated_fat_g: { type: ['number', 'null'] },
            carbs_g: { type: ['number', 'null'] },
            sugar_g: { type: ['number', 'null'] },
            protein_g: { type: ['number', 'null'] },
            salt_g: { type: ['number', 'null'] },
            fiber_g: { type: ['number', 'null'] },
          },
        },
        DashboardNutrition: {
          type: 'object',
          properties: {
            date: { type: ['string', 'null'], format: 'date', description: 'Null without access to the module.' },
            target: { oneOf: [{ $ref: '#/components/schemas/DashboardNutrientTarget' }, { type: 'null' }] },
            totals: { $ref: '#/components/schemas/DashboardNutrientTotals' },
            entryCount: { type: 'integer' },
          },
          required: ['date', 'target', 'totals', 'entryCount'],
        },
        DashboardHousekeeping: {
          type: 'object',
          properties: {
            configured: { type: 'boolean' },
            present: { type: 'boolean' },
            presentSince: {
              type: ['string', 'null'],
              format: 'date-time',
              description: 'A check-in as stored, with milliseconds.',
            },
            workerName: { type: ['string', 'null'] },
            visitsThisMonth: { type: 'integer' },
            unpaidAmount: { type: ['number', 'null'], description: 'Null for a caller who may not see amounts.' },
            lastVisit: {
              type: ['string', 'null'],
              format: 'date-time',
              description: 'A check-in as stored, with milliseconds.',
            },
          },
          required: ['configured', 'present', 'presentSince', 'workerName', 'visitsThisMonth', 'unpaidAmount', 'lastVisit'],
        },
        DashboardWastePickup: {
          type: 'object',
          properties: {
            date_key: { type: 'string', format: 'date' },
            type_id: { type: 'integer' },
            type_name: { type: 'string' },
            type_icon: { type: ['string', 'null'] },
            type_color: { type: ['string', 'null'] },
            deep_link: { type: 'string' },
          },
          required: ['date_key', 'type_id', 'type_name', 'type_icon', 'type_color', 'deep_link'],
        },
        DashboardShift: {
          type: 'object',
          properties: {
            date_key: { type: 'string', format: 'date' },
            source: { type: 'string', enum: ['pattern', 'override', 'extra'] },
            crosses_midnight: { type: 'boolean' },
            shift_type: {
              type: 'object',
              properties: {
                id: { type: 'integer' },
                name: { type: 'string' },
                short_code: { type: ['string', 'null'] },
                start_time: { type: ['string', 'null'] },
                end_time: { type: ['string', 'null'] },
                color: { type: ['string', 'null'] },
                icon: { type: ['string', 'null'] },
              },
              required: ['id', 'name', 'short_code', 'start_time', 'end_time', 'color', 'icon'],
            },
          },
          required: ['date_key', 'source', 'crosses_midnight', 'shift_type'],
        },
        DashboardPantryExpiring: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              maxItems: 5,
              items: {
                type: 'object',
                properties: {
                  id: { type: 'integer' },
                  name: { type: 'string' },
                  quantity: { type: 'number' },
                  unit: { type: ['string', 'null'] },
                  expires_on: { type: 'string', format: 'date' },
                  days_left: { type: 'integer', description: 'Negative for what has expired.' },
                  location_name: { type: ['string', 'null'] },
                  location_icon: { type: ['string', 'null'] },
                },
                required: ['id', 'name', 'quantity', 'unit', 'expires_on', 'days_left', 'location_name', 'location_icon'],
              },
            },
            todayItems: {
              type: 'array',
              maxItems: 5,
              description: 'What expires today. A paired wall display gets the names only.',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'integer' },
                  name: { type: 'string' },
                  quantity: { type: 'number' },
                  unit: { type: ['string', 'null'] },
                },
                required: ['name'],
              },
            },
            total: { type: 'integer' },
            expiredCount: { type: 'integer' },
            todayCount: { type: 'integer' },
          },
          required: ['items', 'todayItems', 'total', 'expiredCount', 'todayCount'],
        },
        DashboardResponse: {
          type: 'object',
          description: 'Every field listed here stays in the response without access to its module, in its empty form; only `shoppingTile` comes and goes. Depending on module access the response can carry further fields that are not listed here (at the moment `budget`, `health` and `fasting`): they are no part of this contract, and a client ignores what it does not know.',
          additionalProperties: true,
          properties: {
            users: { type: 'array', items: { $ref: '#/components/schemas/DashboardUser' } },
            upcomingEvents: { type: 'array', items: { $ref: '#/components/schemas/CalendarEvent' } },
            familyEvents: { type: 'array', items: { $ref: '#/components/schemas/CalendarEvent' } },
            weekEvents: { type: 'array', items: { $ref: '#/components/schemas/DashboardWeekEvent' } },
            birthdays: { type: 'array', maxItems: 8, items: { $ref: '#/components/schemas/DashboardBirthday' } },
            birthdayCount: { type: 'integer', description: 'Persons, whereas `birthdayTotal` counts occasions.' },
            birthdayTotal: { type: 'integer' },
            birthdaySoonCount: { type: 'integer', description: 'Occasions within three days, uncapped.' },
            urgentTasks: { type: 'array', maxItems: 5, items: { $ref: '#/components/schemas/DashboardTask' } },
            openTaskCount: { type: ['integer', 'null'], description: 'Null when the count failed, which is not the same as none.' },
            overdueTaskCount: { type: ['integer', 'null'], description: 'Null when the count failed, which is not the same as none.' },
            memberTodayTasks: { type: 'array', items: { $ref: '#/components/schemas/DashboardMemberTaskCount' } },
            tasksDoneToday: { type: 'integer' },
            wallTasks: { type: 'array', items: { $ref: '#/components/schemas/DashboardWallTasks' } },
            todayMeals: { type: 'array', items: { $ref: '#/components/schemas/DashboardMeal' } },
            pinnedNotes: { type: 'array', maxItems: 5, items: { $ref: '#/components/schemas/DashboardNote' } },
            pinnedNotesCount: { type: 'integer' },
            notesTotal: { type: 'integer' },
            shoppingLists: { type: 'array', maxItems: 3, items: { $ref: '#/components/schemas/DashboardShoppingList' } },
            shoppingOpenCount: { type: ['integer', 'null'], description: 'Null when the count failed, which is not the same as none.' },
            shoppingOpenLists: { type: 'integer' },
            shoppingTile: { $ref: '#/components/schemas/DashboardShoppingTile' },
            countdowns: { type: 'array', items: { $ref: '#/components/schemas/DashboardCountdown' } },
            countdownTotal: { type: 'integer' },
            quicklinks: { type: 'array', items: { $ref: '#/components/schemas/DashboardQuickLink' } },
            splitBalance: { $ref: '#/components/schemas/DashboardSplitBalance' },
            rewards: { $ref: '#/components/schemas/DashboardRewards' },
            nutrition: { $ref: '#/components/schemas/DashboardNutrition' },
            housekeeping: { $ref: '#/components/schemas/DashboardHousekeeping' },
            wastePickups: { type: 'array', items: { $ref: '#/components/schemas/DashboardWastePickup' } },
            myShiftsToday: { type: 'array', items: { $ref: '#/components/schemas/DashboardShift' } },
            pantryExpiring: {
              oneOf: [{ $ref: '#/components/schemas/DashboardPantryExpiring' }, { type: 'null' }],
              description: 'Null when the read failed, which is not the same as nothing expiring.',
            },
          },
          required: ['users', 'upcomingEvents', 'familyEvents', 'weekEvents', 'birthdays', 'birthdayCount', 'birthdayTotal',
            'birthdaySoonCount', 'urgentTasks', 'openTaskCount', 'overdueTaskCount', 'memberTodayTasks', 'tasksDoneToday',
            'wallTasks', 'todayMeals', 'pinnedNotes', 'pinnedNotesCount', 'notesTotal', 'shoppingLists', 'shoppingOpenCount',
            'shoppingOpenLists', 'countdowns', 'countdownTotal', 'quicklinks', 'splitBalance', 'rewards', 'nutrition',
            'housekeeping', 'wastePickups', 'myShiftsToday', 'pantryExpiring'],
        },
        OkResponse: {
          type: 'object',
          description: 'The answer of a write that has nothing else to say.',
          properties: { ok: { type: 'boolean', enum: [true] } },
          required: ['ok'],
        },
        DevicePairingRequest: {
          type: 'object',
          properties: {
            server: {
              type: 'string',
              description: 'The http(s) origin of this page, without a path. It goes into the link a client opens, and may take up to 170 characters once percent-encoded, so that the link still fits a QR code.',
              example: 'https://yuvomi.example.org',
            },
          },
          required: ['server'],
        },
        DevicePairingResponse: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                code: { type: 'string', description: 'The code to type, shown once.' },
                expires_at: { type: 'string', format: 'date-time' },
                link: { type: 'string', description: 'Opens the app on this device: `yuvomi://pair?server=<origin>&code=<code>`.' },
                qr: { type: 'string', description: 'The same link as a QR code, an SVG data URL.' },
              },
              required: ['code', 'expires_at', 'link', 'qr'],
            },
          },
          required: ['data'],
        },
        DevicePairingRedeemRequest: {
          type: 'object',
          properties: {
            code: { type: 'string', description: 'Case, spaces and hyphens do not matter.' },
            name: { type: 'string', minLength: 1, maxLength: 100 },
            platform: { type: 'string', pattern: '^[a-z][a-z0-9-]{1,19}$' },
            device_id: {
              type: 'string',
              pattern: '^[A-Za-z0-9._-]{8,128}$',
              description: 'Chosen by the client and stable per installation. Sending the same value again replaces the earlier credential.',
            },
          },
          required: ['code', 'name', 'platform', 'device_id'],
        },
        UpcomingReminder: {
          type: 'object',
          properties: {
            ...reminderProperties,
            fires_at: {
              type: 'string',
              format: 'date-time',
              description: 'The moment the reminder fires, in UTC with `Z`, whole seconds.',
            },
          },
          required: ['id', 'entity_type', 'entity_id', 'remind_at', 'fires_at', 'created_by'],
        },
        UpcomingReminderList: {
          type: 'object',
          properties: {
            data: { type: 'array', maxItems: 200, items: { $ref: '#/components/schemas/UpcomingReminder' } },
          },
          required: ['data'],
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
            settings: {
              type: ['object', 'null'],
              description: 'Optional settings sheet. sections controls visibility only; the module API enforces authorization.',
              required: ['entry', 'sections'],
              properties: {
                entry: { type: 'string', description: 'Protected module asset URL for the settings JavaScript entry.' },
                sections: {
                  type: 'array', minItems: 1, maxItems: 2, uniqueItems: true,
                  items: { type: 'string', enum: ['mine', 'household'] },
                  description: 'mine is visible to members; household only to administrators. No default.',
                },
                labelKey: { type: ['string', 'null'] },
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
            manifestVersion: { type: 'integer', description: 'Manifest format version the module is written for (absent on errored modules).' },
            entry: { type: 'string', description: 'Entry file relative to the module folder (absent on errored modules).' },
            style: { type: ['string', 'null'], description: 'Stylesheet relative to the module folder, or null.' },
            page: {
              type: 'object',
              description: 'Normalized page declaration (absent on errored modules).',
              properties: {
                composition: { type: 'string', enum: ['reading', 'data', 'dashboard', 'form', 'split', 'full'] },
                width: { type: 'string', enum: ['reading', 'content', 'wide'] },
                navigation: { type: 'string', enum: ['standard'] },
                responsive: { type: 'string', enum: ['standard'] },
              },
            },
            install: { $ref: '#/components/schemas/ExtensionModuleInstall' },
          },
          required: ['id', 'name', 'enabled', 'status'],
        },
        ExtensionModuleInstall: {
          type: ['object', 'null'],
          description: 'How the module was installed from Settings (read from `.yuvomi-install.json` in its folder) and whether an admin has approved it since. null when the folder was copied onto the server by hand. Only present in the admin listing (`GET /api/v1/modules?admin=1` by an admin) and in install responses.',
          properties: {
            source: { type: 'string', enum: ['zip', 'github'] },
            url: { type: ['string', 'null'], description: 'GitHub repository URL.' },
            ref: { type: ['string', 'null'], description: 'Branch, tag or commit that was downloaded.' },
            commit: { type: ['string', 'null'], description: 'Commit SHA of the GitHub archive, when known.' },
            path: { type: ['string', 'null'], description: 'Folder inside the archive the module came from.' },
            installedAt: { type: ['string', 'null'], format: 'date-time' },
            approved: { type: 'boolean', description: 'False after every install and replace; true once an admin enabled the module from a browser session. While false the module is disabled whatever the household switch says, so a restored or fresh database cannot turn on code nobody looked at. Stored in the module folder.' },
            installedByName: { type: ['string', 'null'], description: 'Display name of the admin who installed it, resolved from the user id in the record; null when that account no longer exists. Only in the admin listing.' },
          },
          required: ['source', 'approved'],
        },
        ModuleInstallInfoResponse: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                writable: { type: 'boolean', description: 'False when the modules folder is read-only; installs then answer 503.' },
                persistent: { type: ['boolean', 'null'], description: 'Best-effort guess whether the modules folder survives an update of the server. False when Yuvomi runs in a container and the folder is not on a volume or bind mount (installed modules would be lost with the next image update); null when it cannot be determined. The routes still answer when false; the Settings page then shows the manual way, like for a read-only folder.' },
                webInstall: { type: 'boolean', description: 'Whether the operator switched installing from Settings on (`MODULES_ALLOW_WEB_INSTALL=true`). False by default; the install and delete routes then answer 403 `module_web_install_disabled`.' },
                maxZipMb: { type: 'integer', description: 'Archive size limit in MB.' },
              },
              required: ['writable', 'persistent', 'webInstall', 'maxZipMb'],
            },
          },
          required: ['data'],
        },
        ModuleInstallGithubRequest: {
          type: 'object',
          properties: {
            url: { type: 'string', maxLength: 2000, description: 'GitHub URL or `owner/repo`.' },
            ref: { type: 'string', maxLength: 200, description: 'Branch, tag or commit; overrides the ref from the URL.' },
            path: { type: 'string', maxLength: 500, description: 'Folder inside the repository that holds module.json. Overrides the folder of a tree URL; an empty string selects the repository root.' },
            overwrite: { type: 'boolean', description: 'Replace an installed module with the same id.' },
          },
          required: ['url'],
        },
        ModuleInstallResponse: {
          type: 'object',
          properties: {
            data: { $ref: '#/components/schemas/ExtensionModule' },
            replaced: { type: 'boolean', description: 'True when an installed module with the same id was replaced.' },
            skipped: { type: 'array', items: { type: 'string' }, description: 'Files in the module folder that were not copied (not a web asset type, or a dotfile).' },
          },
          description: 'The module is disabled either way, after a fresh install and after a replace: `data.install.approved` is false until an admin enables it from a browser session.',
          required: ['data', 'replaced', 'skipped'],
        },
        ModuleInstallError: {
          type: 'object',
          properties: {
            error: { type: 'string' },
            code: { type: 'integer' },
            reason: { type: 'string', description: 'Stable machine-readable reason.' },
            existing: {
              type: 'object',
              description: 'With `exists`: the installed module.',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                version: { type: 'string' },
                install: { $ref: '#/components/schemas/ExtensionModuleInstall' },
              },
            },
            incoming: {
              type: 'object',
              description: 'With `exists`: the module in the archive. A replace (retry with overwrite) always leaves the module disabled until it is approved again.',
              properties: { id: { type: 'string' }, name: { type: 'string' }, version: { type: 'string' } },
            },
            candidates: {
              type: 'array',
              description: 'With `multiple`: the modules found in the archive.',
              items: {
                type: 'object',
                properties: {
                  path: { type: 'string' },
                  id: { type: ['string', 'null'] },
                  name: { type: ['string', 'null'] },
                  version: { type: ['string', 'null'] },
                },
                required: ['path'],
              },
            },
            resetAt: { type: 'string', format: 'date-time', description: 'With `rate_limited` from GitHub, when GitHub names a time: when to try again (from `retry-after` for its secondary limit, otherwise from `x-ratelimit-reset`). Left out when GitHub names none.' },
          },
          required: ['error', 'code'],
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
            last_error: { type: ['string', 'null'], description: 'The English message of the last failed attempt, for logs and API consumers. Omitted for a caller without module write access, like url.' },
            last_error_reason: { type: ['string', 'null'], description: 'The case of the last failed attempt (#1909): the same reason a manual refresh answers with (waste_source_fetch_http_status, waste_source_fetch_too_large, waste_source_fetch_blocked, waste_source_fetch_unreachable, waste_source_fetch_no_events, or the reason of a failed import). null when the attempt failed without a typed case, or before the first failure recorded after #1909. Omitted together with last_error.' },
            last_error_params: { type: ['object', 'null'], description: 'The numbers of that case (status, limit_mb), as the refresh answer carries them in params. Omitted together with last_error.' },
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
            type_ids: { type: 'array', items: { type: 'integer' }, description: 'Every type this label maps to, ascending; one pickup per type is created for each of its entries. Empty when the label is ignored.' },
            type_id: { type: ['integer', 'null'], deprecated: true, description: 'The lowest of type_ids, or null. Kept for callers from before a label could map to several types; read type_ids instead.' },
            ignored: { type: 'boolean', description: 'True exactly when type_ids is empty.' },
          },
        },
        WasteSourceMappingUpdateInput: {
          type: 'object',
          description: 'Either ignored: true, or the label\'s full new type set as type_ids (or a single type_id) - never both, and never type_id together with type_ids.',
          properties: {
            type_ids: { type: 'array', items: { type: 'integer' }, minItems: 1, description: 'Replaces the label\'s whole type set.' },
            type_id: { type: 'integer', description: 'Shorthand for type_ids with one entry.' },
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
            remembered_type_ids: { type: 'array', items: { type: 'integer' }, description: 'Every type this label was mapped to on the source\'s last commit, on a re-import preview; empty otherwise.' },
            remembered_type_id: { type: ['integer', 'null'], deprecated: true, description: 'The lowest of remembered_type_ids, or null. Kept for callers from before a label could map to several types.' },
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
          description: 'Either ignored: true, or at least one type: existing ones as type_ids (or a single type_id), a new_type to create inline, or both together. One decision is required per distinct label reported by the preview; each entry of a label becomes one pickup per type.',
          properties: {
            normalized_label: { type: 'string' },
            type_ids: { type: 'array', items: { type: 'integer' } },
            type_id: { type: 'integer', description: 'Shorthand for type_ids with one entry; not together with type_ids.' },
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
              description: 'committed: every label had a remembered decision, applied via the same atomic path as a file re-import. unchanged: a conditional GET reported no change (304). needs_mapping: content changed but at least one label (or blocking diagnostic) has no remembered decision - see source.needs_mapping and the preview field. error: the fetch failed - see reason for its class and source.last_error for the stored message (source.last_error_reason keeps the same class for a later read).',
            },
            reason: {
              type: 'string',
              enum: ['waste_source_fetch_http_status', 'waste_source_fetch_too_large', 'waste_source_fetch_blocked', 'waste_source_fetch_unreachable', 'waste_source_fetch_no_events', 'waste_source_url_invalid', 'waste_source_url_not_https'],
              description: 'Only with outcome=error: the class of the failed fetch. http_status: the other side answered, but not with a success (params.status). too_large: the response exceeds the upload limit (params.limit_mb). blocked: a private or blocked address. unreachable: everything else (DNS, refused or reset connection, TLS, timeout, a redirect that is not followed). no_events: the other side answered with a success, but without a single calendar entry (a maintenance or login page, an empty calendar) - nothing is applied and the imported pickups stay (#1938). url_invalid / url_not_https: the stored URL no longer passes validation. Stored with the source as last_error_reason (and last_error_params) since #1909.',
            },
            params: { type: 'object', additionalProperties: { type: 'integer' }, description: 'Only with a reason that carries a number: `{ "status": 404 }` or `{ "limit_mb": 5 }`.' },
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
