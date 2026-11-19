/**
 * Modul: Abfuhr - die Anfrage-Schemata des OpenAPI-Dokuments (#2810)
 * Zweck: Die Koerper, die validateRequest() vor den Handlern unter
 *        server/routes/waste/ prueft. Das Schema traegt Form und Grenzen;
 *        die Regeln der Domaene (Anker passt zum Monatstag, Ordinal-Vorkommen,
 *        die Art existiert, der Termin ist ein berechneter) bleiben samt
 *        `reason` im Handler (server/services/waste-domain.js, waste-store.js).
 *        Ein `x-reason` steht nur an einer Regel, die auf JEDER Eingabe mit
 *        dem Handler uebereinstimmt, damit der Grund, den die App uebersetzt,
 *        nicht verloren geht.
 *        Listen und Grenzen kommen aus server/services/waste-fields.js, die
 *        auch die Handler lesen. Diese Datei zieht nichts aus node_modules:
 *        server/openapi.js muss ohne sie ladbar bleiben.
 */

import { MAX_URL } from '../middleware/validate.js';
import { COLOR_PATTERN, DATE_PATTERN, TIME_PATTERN } from '../utils/datetime-pattern.js';
import {
  MAPPING_PROFILE_VERSION, MAX_OFFSET_DAYS, MAX_REFRESH_INTERVAL_MINUTES, MIN_OFFSET_DAYS, MIN_REFRESH_INTERVAL_MINUTES,
  NOTE_MAX, RECURRENCE_KINDS, SOURCE_NAME_MAX, TYPE_ICON_MAX, TYPE_NAME_MAX, WEEKDAY_CODES,
} from '../services/waste-fields.js';

// Ziffern-Text ist eine Altform (#2810): `type_id: "7"` traf die Zeile 7, weil
// SQLite den Text an der INTEGER-Spalte wandelt. Die App schickt Zahlen.
const LEGACY_NOTE = 'Digit text is accepted as a legacy form.';

/**
 * A type id in the body of a schedule or one-off pickup: a whole number, digit
 * text as the legacy form. Missing on create is the route's own reason
 * `waste_selected_type_not_found`; an id without a type is the route's 400.
 */
const typeIdBase = {
  anyOf: [{ type: 'integer' }, { type: 'string', pattern: '^[0-9]+$' }],
  description: `The waste type, a whole number; it must exist (else 400 \`waste_selected_type_not_found\`). ${LEGACY_NOTE}`,
};
const typeIdField = { ...typeIdBase, 'x-reason': { required: 'waste_selected_type_not_found' } };

/**
 * A text of at most `max` characters as sent; the route trims and counts again.
 * @param {number} max
 * @param {boolean} nullable
 * @param {string} description
 */
const text = (max, nullable, description) => ({
  type: nullable ? ['string', 'null'] : 'string',
  maxLength: max,
  description: `${description} At most ${max} characters as sent.`,
});

const typeFields = {
  name: text(TYPE_NAME_MAX, false, 'The name; empty after trimming spaces is refused.'),
  icon: text(TYPE_ICON_MAX, true, 'A Lucide icon name; `null` is `trash-2`, `""` is refused.'),
  color: { type: ['string', 'null'], pattern: COLOR_PATTERN, description: 'A HEX color `#RRGGBB`; `null` is `#22C55E`.' },
  archived: { type: 'boolean', description: 'Archive (true) or restore (false); read on update only.' },
  sort_order: { type: 'integer', description: 'The position in the list; read on update only.' },
};

// Komma-Text (`"MO,TH"`) liest der Handler auch, aber kein eigener Aufrufer
// schickt ihn: der Dialog sendet ein Array (weekdayPickerValue in
// public/pages/waste.js), das versteckte Feld `weekdays` geht nie in den Koerper.
const weekdaysField = {
  anyOf: [
    { type: 'array', items: { type: 'string', enum: [...WEEKDAY_CODES] } },
    { type: ['string', 'null'], enum: [...WEEKDAY_CODES, null] },
  ],
  description: 'weekly: the BYDAY codes as an array (`["MO","TH"]`). '
    + 'monthly_ordinal_weekday: exactly one code (`"MO"`). For monthly_fixed_day it is accepted and stored as null, '
    + 'so a dialog that changes the kind may still send it.',
};

const scheduleFields = {
  type_id: typeIdField,
  recurrence_kind: { type: 'string', enum: [...RECURRENCE_KINDS] },
  anchor_date: {
    type: 'string',
    pattern: DATE_PATTERN,
    'x-reason': 'waste_schedule_anchor_date_invalid',
    description: 'The first occurrence `YYYY-MM-DD`; a day that does not exist is refused by the route with the same reason.',
  },
  interval: {
    type: 'integer',
    minimum: 1,
    'x-reason': { minimum: 'waste_schedule_interval_invalid' },
    description: 'Every how many weeks or months; left out is 1 on create. The upper bound depends on the kind (52 weekly, 24 monthly) and stays the route\'s (`waste_schedule_interval_invalid`).',
  },
  weekdays: weekdaysField,
  month_day: {
    type: ['integer', 'null'],
    description: 'monthly_fixed_day: 1-31 or -1 (last day). monthly_ordinal_weekday: the ordinal position, -1 (last) or 1-4 (nth). '
      + 'For a weekly schedule it is accepted and stored as null.',
  },
  valid_until: { type: ['string', 'null'], pattern: DATE_PATTERN, description: 'The last day `YYYY-MM-DD`, or null for open-ended.' },
  active: { type: 'boolean', description: 'false pauses the schedule. A boolean, not text or a number.' },
};

const pickupDate = {
  type: 'string',
  pattern: DATE_PATTERN,
  'x-reason': 'waste_pickup_date_invalid',
  description: 'The day `YYYY-MM-DD`; a day that does not exist is refused by the route with the same reason.',
};

const mappingTypeIds = {
  type: ['array', 'null'],
  items: { type: 'integer' },
  description: 'The label\'s whole type set, whole numbers. `null` is the same as left out.',
};

/** The portable mapping profile as a request carries it; every shape rule answers `waste_profile_invalid`. */
const mappingProfileInput = {
  type: 'object',
  required: ['mappings'],
  'x-reason': 'waste_profile_invalid',
  description: 'A mapping profile as exported. Any shape other than an object with a `mappings` array of `{ pattern, type_name }` texts is refused with `waste_profile_invalid`.',
  properties: {
    version: {
      type: 'integer',
      enum: [MAPPING_PROFILE_VERSION],
      description: `The profile format; the export always writes ${MAPPING_PROFILE_VERSION}. Not required: the route does not read it.`,
    },
    source_name: { type: 'string', description: 'Informational only, as exported.' },
    mappings: {
      type: 'array',
      'x-reason': 'waste_profile_invalid',
      items: {
        type: 'object',
        required: ['pattern', 'type_name'],
        'x-reason': 'waste_profile_invalid',
        properties: {
          pattern: { type: 'string', 'x-reason': 'waste_profile_invalid', description: 'Normalized source label; empty after trimming is refused by the route.' },
          type_name: { type: 'string', 'x-reason': 'waste_profile_invalid', description: 'A waste type name; empty after trimming is refused by the route.' },
        },
      },
    },
  },
};

const mappingDecision = {
  type: 'object',
  description: 'Either ignored: true, or at least one type: existing ones as type_ids (or a single type_id), a new_type to create inline, or both together. One decision is required per distinct label reported by the preview; each entry of a label becomes one pickup per type.',
  properties: {
    normalized_label: { type: 'string' },
    type_ids: mappingTypeIds,
    type_id: { type: ['integer', 'null'], description: 'Shorthand for type_ids with one entry; not together with type_ids.' },
    new_type: { anyOf: [{ $ref: '#/components/schemas/WasteTypeInput' }, { type: 'null' }] },
    ignored: { type: 'boolean' },
  },
};

const commitFields = {
  ics: { type: 'string', description: 'The raw ICS file text of a FILE source (re-parsed on commit). A URL source fetches its own address and ignores it. Missing or empty for a file is the route\'s 400 `waste_import_empty_file`; its upload limit counts UTF-8 bytes and stays the route\'s.' },
  mappings: { type: 'array', items: { $ref: '#/components/schemas/WasteImportMappingDecision' } },
  skip_event_keys: { type: 'array', items: { type: 'string' }, description: 'Blocking-diagnostic event_key values explicitly acknowledged and excluded.' },
  preview_digest: { type: ['string', 'null'], description: 'The digest returned by the matching preview; a mismatch (the parsed content changed since that preview) is refused with 409.' },
};

/** The components of the request schemas of the Waste module. */
export function wasteInputSchemas() {
  return {
    WasteTypeInput: {
      type: 'object',
      required: ['name'],
      properties: typeFields,
    },
    WasteTypeUpdateInput: {
      type: 'object',
      description: 'A partial update: a field left out stays as it is.',
      properties: {
        ...typeFields,
        name: text(TYPE_NAME_MAX, false, 'The name; `null` or empty after trimming spaces is refused.'),
        icon: text(TYPE_ICON_MAX, true, 'A Lucide icon name; `null` resets it to `trash-2`, `""` is refused.'),
        color: { type: ['string', 'null'], pattern: COLOR_PATTERN, description: 'A HEX color `#RRGGBB`; `null` resets it to `#22C55E`.' },
      },
    },
    WasteScheduleInput: {
      type: 'object',
      required: ['type_id', 'recurrence_kind', 'anchor_date'],
      properties: scheduleFields,
    },
    WasteScheduleUpdateInput: {
      type: 'object',
      description: 'A partial update: a field left out keeps the stored value.',
      properties: {
        ...scheduleFields,
        type_id: { ...typeIdBase, description: `${typeIdBase.description} \`null\` is refused.` },
      },
    },
    WasteScheduleOverrideInput: {
      type: 'object',
      description: 'The whole override: both fields are required (#2810), `replacement_date: null` skips the occurrence. Up to v2.93 an empty body skipped the occurrence and a missing `note` wiped the stored one.',
      required: ['replacement_date', 'note'],
      properties: {
        replacement_date: {
          type: ['string', 'null'],
          pattern: DATE_PATTERN,
          // Only the shape: a missing field is the generic `validation` of the
          // full-representation rule, not "date required" of the move dialog.
          'x-reason': { type: 'waste_override_date_invalid', pattern: 'waste_override_date_invalid' },
          description: 'A date `YYYY-MM-DD` to move this occurrence to, or null to skip it.',
        },
        note: { type: ['string', 'null'], description: 'A note; the route sets no length limit.' },
      },
    },
    WasteOneOffPickupInput: {
      type: 'object',
      required: ['type_id', 'date'],
      properties: {
        type_id: typeIdField,
        date: pickupDate,
        note: text(NOTE_MAX, true, 'A note; `null` or `""` means none.'),
      },
    },
    WasteOneOffPickupUpdateInput: {
      type: 'object',
      description: 'A partial update: a field left out keeps the stored value.',
      properties: {
        type_id: { description: 'Ignored: a pickup keeps its type. The app sends it with the rest of the dialog.' },
        date: pickupDate,
        note: text(NOTE_MAX, true, 'A note; `null` or `""` clears it.'),
      },
    },
    WasteSourceRenameInput: {
      type: 'object', required: ['name'], properties: { name: text(SOURCE_NAME_MAX, false, 'The new name.') },
    },
    WasteSourceMappingUpdateInput: {
      type: 'object',
      description: 'Either ignored: true (type_ids empty or left out), or the label\'s full new type set as type_ids (or a single type_id) - never both, and never type_id together with type_ids.',
      properties: {
        type_ids: mappingTypeIds,
        type_id: { type: ['integer', 'null'], description: 'Shorthand for type_ids with one entry.' },
        ignored: { type: 'boolean' },
      },
    },
    WasteImportPreviewInput: {
      type: 'object',
      properties: { ics: commitFields.ics },
    },
    WasteImportMappingDecision: mappingDecision,
    WasteImportCommitInput: {
      type: 'object',
      required: ['name'],
      properties: {
        ...commitFields,
        name: text(SOURCE_NAME_MAX, false, 'The name of the new source.'),
      },
    },
    WasteReimportCommitInput: {
      type: 'object',
      required: ['expected_version'],
      properties: {
        ...commitFields,
        name: text(SOURCE_NAME_MAX, false, 'A new name; left out keeps the source\'s.'),
        expected_version: { type: 'integer', description: 'The source\'s version as last seen in the preview; a different one is refused with 409 `source_changed`.' },
      },
    },
    WasteUrlSourceCreateInput: {
      type: 'object',
      required: ['name', 'url'],
      properties: {
        name: text(SOURCE_NAME_MAX, false, 'The name; empty after trimming spaces is refused.'),
        url: {
          type: 'string',
          maxLength: MAX_URL,
          'x-reason': { required: 'waste_source_url_invalid' },
          description: `https:// only by default; http:// is accepted only under the operator opt-in WASTE_SOURCE_ALLOW_PRIVATE_NETWORK. At most ${MAX_URL} characters as sent.`,
        },
        refresh_interval_minutes: {
          type: ['integer', 'null'],
          // Die Grenzen bleiben im Handler: seine Absage traegt sie als
          // `params` ({ min, max }), aus denen die App ihren Satz baut; die
          // Absage des Schemas kennt keine `params`.
          description: `Bounded ${MIN_REFRESH_INTERVAL_MINUTES}-${MAX_REFRESH_INTERVAL_MINUTES} (hourly to monthly) by the route, which answers \`waste_source_interval_invalid\` with \`params.min\` and \`params.max\`; \`null\` or left out is 1440.`,
        },
      },
    },
    WasteReminderSettingUpdateInput: {
      type: 'object',
      description: 'The whole setting: all three fields are required (#2810). Up to v2.91 a missing `enabled` switched the reminder off and a missing lead time or time reset it to 1 day / 08:00.',
      required: ['enabled', 'offset_days', 'delivery_time'],
      properties: {
        enabled: { type: 'boolean' },
        offset_days: {
          type: 'integer',
          minimum: MIN_OFFSET_DAYS,
          maximum: MAX_OFFSET_DAYS,
          'x-reason': { minimum: 'waste_reminder_offset_invalid', maximum: 'waste_reminder_offset_invalid' },
          description: `Lead time before the pickup, in days, ${MIN_OFFSET_DAYS}-${MAX_OFFSET_DAYS}.`,
        },
        delivery_time: {
          type: 'string',
          pattern: TIME_PATTERN,
          'x-reason': { pattern: 'waste_reminder_time_invalid' },
          description: 'Household-local `HH:MM` the reminder is delivered at.',
        },
      },
    },
    WasteFeedTypeSelectionInput: {
      type: 'object',
      required: ['type_ids'],
      properties: {
        type_ids: {
          type: ['array', 'null'], items: { type: 'integer' },
          description: 'Waste type ids to include, or null to include every active type again.',
        },
      },
    },
    WasteMappingProfileInput: mappingProfileInput,
    WasteMappingProfileImportPreviewInput: {
      type: 'object', required: ['profile'], properties: { profile: { $ref: '#/components/schemas/WasteMappingProfileInput' } },
    },
    WasteMappingProfileImportCommitInput: {
      type: 'object',
      required: ['profile', 'profile_digest'],
      properties: {
        profile: { $ref: '#/components/schemas/WasteMappingProfileInput' },
        profile_digest: { type: 'string', description: 'The digest of the preview; a different one is refused with 409 `waste_profile_changed`.' },
      },
    },
  };
}
