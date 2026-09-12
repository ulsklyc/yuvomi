/**
 * OpenAPI structure guard.
 *
 * Sichert die modulare Aufteilung von server/openapi.js: jede
 * server/openapi/paths/<modul>.js muss in paths/index.js importiert und in
 * buildPaths() gespreadet sein, jedes Fragment nicht leer, und kein Pfad-Key
 * darf über zwei Modul-Dateien kollidieren. Verhindert, dass eine kuenftig
 * angelegte Modul-Datei still aus der Spec faellt.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { buildPaths } from '../server/openapi/paths/index.js';
import { buildOpenApiSpec } from '../server/openapi.js';

const pathsDir = new URL('../server/openapi/paths/', import.meta.url);
const indexSrc = readFileSync(new URL('index.js', pathsDir), 'utf8');
const moduleFiles = readdirSync(pathsDir)
  .filter((f) => f.endsWith('.js') && f !== 'index.js')
  .sort();

async function fragmentOf(file) {
  const mod = await import(new URL(file, pathsDir));
  const fnNames = Object.keys(mod).filter((k) => typeof mod[k] === 'function');
  assert.equal(fnNames.length, 1, `${file} muss genau eine Pfad-Funktion exportieren`);
  return { fn: fnNames[0], frag: mod[fnNames[0]]() };
}

test('es existiert eine plausible Zahl an Modul-Dateien', () => {
  assert.ok(moduleFiles.length >= 20, `unerwartet wenige Modul-Dateien: ${moduleFiles.length}`);
});

test('jede Modul-Datei ist importiert, gespreadet und liefert gueltige Pfade', async () => {
  for (const file of moduleFiles) {
    const { fn, frag } = await fragmentOf(file);
    assert.ok(indexSrc.includes(`from './${file}'`), `${file} wird in paths/index.js nicht importiert`);
    assert.ok(indexSrc.includes(`...${fn}()`), `${fn}() wird in buildPaths() nicht gespreadet`);
    const keys = Object.keys(frag);
    assert.ok(keys.length > 0, `${file} liefert ein leeres Pfad-Fragment`);
    for (const key of keys) {
      assert.ok(key.startsWith('/'), `${file}: ungueltiger Pfad-Key ${key}`);
    }
  }
});

test('keine Pfad-Kollision ueber Modul-Dateien (keine still verlorenen Routen)', async () => {
  let fragTotal = 0;
  const seen = new Set();
  for (const file of moduleFiles) {
    const { frag } = await fragmentOf(file);
    for (const key of Object.keys(frag)) {
      assert.ok(!seen.has(key), `Pfad ${key} kommt in mehreren Modul-Dateien vor`);
      seen.add(key);
      fragTotal += 1;
    }
  }
  const combined = Object.keys(buildPaths()).length;
  assert.equal(combined, fragTotal, 'buildPaths() Pfad-Zahl weicht von der Summe der Fragmente ab');
});

test('buildOpenApiSpec spiegelt buildPaths() vollstaendig', () => {
  const spec = buildOpenApiSpec({}, 'test');
  assert.deepEqual(Object.keys(spec.paths), Object.keys(buildPaths()));
  assert.ok(spec.tags.length > 0, 'tags fehlen in der Spec');
  assert.ok(Object.keys(spec.components.schemas).length > 0, 'schemas fehlen in der Spec');
});

test('kein Pfad-Parameter mit Namens-Bedeutung ist als Zahl deklariert', () => {
  // idParam() setzt hart `type: integer`; fuer Namen und Schluessel gibt es
  // stringPathParam(). Wird der falsche Helfer genommen, ist die Spec still
  // falsch: ein Client, der daraus generiert, weigert sich bei
  // `PUT /tasks/tags/Garten` oder schickt eine Zahl. Aufgefallen ist das beim
  // Tag-Endpunkt (#586), der das Muster von der Kategorie-Zeile daneben geerbt
  // hatte - beide waren betroffen, in Tasks wie in Contacts.
  //
  // Die Regel greift in der wirksamen Richtung: ein numerischer Parameter heisst
  // `id`, endet auf `Id` oder benennt eine POSITION. Umgekehrt darf ein `id`
  // durchaus ein String sein (Modul-IDs sind Slugs), deshalb wird nur die
  // Zahl-Seite geprueft.
  //
  // Warum ein Index dazugehoert und keine Ausnahme ist: der Guard faengt einen
  // frei waehlbaren NAMEN, der faelschlich als Zahl deklariert wurde - ein Tag
  // heisst "Garten", ein Modul traegt einen Slug. Ein Index ist kein Bezeichner,
  // sondern eine Stelle in einer Folge; er ist per Definition eine Zahl und
  // kann gar kein Wort sein. Wer hier etwas ergaenzt, muss dasselbe zeigen
  // koennen.
  const NUMERIC_BY_NATURE = /^(position|index)$/;
  const paths = buildPaths();
  const offenders = [];

  for (const [path, operations] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      for (const parameter of operation.parameters ?? []) {
        if (parameter.in !== 'path') continue;
        if (parameter.schema?.type !== 'integer') continue;
        if (/^id$|Id$/.test(parameter.name)) continue;
        if (NUMERIC_BY_NATURE.test(parameter.name)) continue;
        offenders.push(`${method.toUpperCase()} ${path} -> {${parameter.name}}`);
      }
    }
  }

  assert.deepEqual(offenders, [],
    `Diese Pfad-Parameter tragen einen Namen, sind aber als integer deklariert:\n${offenders.join('\n')}`);
});

test('calendar occurrence conflicts and split successes have exact schemas', () => {
  const spec = buildOpenApiSpec({}, 'test');
  const conflictRef = '#/components/schemas/CalendarOverrideOrphanConflict';
  const eventRef = '#/components/schemas/CalendarOccurrenceResponse';
  const genericPut = spec.paths['/api/v1/calendar/{id}'].put;
  const followingPut = spec.paths[
    '/api/v1/calendar/{seriesId}/occurrences/{recurrenceId}/following'
  ].put;

  assert.equal(
    genericPut.responses[409].content['application/json'].schema.$ref,
    conflictRef,
  );
  assert.equal(
    followingPut.responses[409].content['application/json'].schema.$ref,
    conflictRef,
  );
  for (const status of [200, 201]) {
    assert.equal(
      followingPut.responses[status].content['application/json'].schema.$ref,
      eventRef,
    );
  }
  assert.deepEqual(spec.components.schemas.CalendarOverrideOrphanConflict.required, [
    'error', 'code', 'conflict', 'orphaned_override_count',
  ]);
  assert.deepEqual(spec.components.schemas.CalendarOverrideOrphanConflict.properties, {
    error: { type: 'string' },
    code: { type: 'integer', const: 409 },
    conflict: { type: 'string', const: 'calendar_override_orphans' },
    orphaned_override_count: { type: 'integer', minimum: 0 },
  });
});

test('calendar event responses expose optional occurrence metadata on every client entry point', () => {
  const spec = buildOpenApiSpec({}, 'test');
  const calendar = spec.paths['/api/v1/calendar'];
  const detail = spec.paths['/api/v1/calendar/{id}'];
  assert.equal(
    calendar.get.responses[200].content['application/json'].schema.$ref,
    '#/components/schemas/CalendarEventsResponse',
  );
  assert.equal(
    spec.components.schemas.CalendarEventsResponse.properties.data.items.$ref,
    '#/components/schemas/CalendarEvent',
  );
  for (const operation of [calendar.post, detail.get, detail.put]) {
    const status = operation === calendar.post ? 201 : 200;
    assert.equal(
      operation.responses[status].content['application/json'].schema.$ref,
      '#/components/schemas/CalendarEventResponse',
    );
  }
  assert.equal(
    spec.components.schemas.CalendarEventResponse.properties.data.$ref,
    '#/components/schemas/CalendarEvent',
  );

  const occurrenceFields = [
    'series_id', 'recurrence_id', 'is_occurrence_override',
    'is_local_recurring_series', 'can_override_occurrence', 'can_detach_occurrence',
    'assignment_owner_id', 'attachment_owner_id', 'reminder_owner_id',
    'reminder_anchor_start',
  ];
  const event = spec.components.schemas.CalendarEvent;
  for (const field of occurrenceFields) {
    assert.ok(event.properties[field], `CalendarEvent is missing optional ${field}`);
    assert.ok(!event.required.includes(field), `CalendarEvent requires standalone-only ${field}`);
  }

  const occurrence = spec.components.schemas.CalendarOccurrence.allOf[1];
  assert.deepEqual(occurrence.required, occurrenceFields);
  for (const field of occurrenceFields) {
    assert.deepEqual(occurrence.properties[field], event.properties[field]);
  }
  assert.equal(event.properties.recurrence_id.format, 'date');
  assert.equal(event.properties.reminder_anchor_start.$ref,
    '#/components/schemas/CalendarDateOrDateTime');
  for (const field of ['assignment_owner_id', 'attachment_owner_id', 'reminder_owner_id']) {
    assert.equal(event.properties[field].type, 'integer');
  }
});

test('calendar occurrence endpoints expose route-specific requests and occurrence responses', () => {
  const spec = buildOpenApiSpec({}, 'test');
  const onlyPut = spec.paths[
    '/api/v1/calendar/{seriesId}/occurrences/{recurrenceId}'
  ].put;
  const followingPut = spec.paths[
    '/api/v1/calendar/{seriesId}/occurrences/{recurrenceId}/following'
  ].put;
  assert.equal(
    onlyPut.requestBody.content['application/json'].schema.$ref,
    '#/components/schemas/CalendarOccurrenceOnlyMutation',
  );
  assert.equal(
    followingPut.requestBody.content['application/json'].schema.$ref,
    '#/components/schemas/CalendarOccurrenceFollowingMutation',
  );
  assert.equal(
    onlyPut.responses[200].content['application/json'].schema.$ref,
    '#/components/schemas/CalendarOccurrenceResponse',
  );
  for (const status of [200, 201]) {
    assert.equal(
      followingPut.responses[status].content['application/json'].schema.$ref,
      '#/components/schemas/CalendarOccurrenceResponse',
    );
  }

  const sharedFields = [
    'title', 'description', 'start_datetime', 'end_datetime', 'all_day',
    'location', 'color', 'icon', 'assigned_to', 'visibility', 'countdown',
    'attachment_name', 'attachment_data', 'remove_attachment',
    'document_folder_name', 'document_name', 'document_description',
    'reminder_offsets',
  ];
  const onlyMutation = spec.components.schemas.CalendarOccurrenceOnlyMutation;
  const followingMutation = spec.components.schemas.CalendarOccurrenceFollowingMutation;
  assert.deepEqual(Object.keys(onlyMutation.properties), sharedFields);
  assert.deepEqual(Object.keys(followingMutation.properties), [
    ...sharedFields,
    'target_google_calendar_id',
    'target_caldav_account_id',
    'target_caldav_calendar_url',
    'target_outlook_account_id',
    'target_outlook_calendar_id',
    'recurrence_rule',
    'confirmed_orphan_count',
  ]);
  assert.equal(onlyMutation.properties.recurrence_rule, undefined);
  assert.equal(onlyMutation.properties.confirmed_orphan_count, undefined);
  assert.equal(onlyMutation.properties.start_datetime.$ref,
    '#/components/schemas/CalendarDateOrDateTime');
  assert.deepEqual(onlyMutation.properties.end_datetime.oneOf[1], { type: 'null' });
  assert.equal(onlyMutation.properties.reminder_offsets.maxItems, 5);
  assert.equal(onlyMutation.properties.reminder_offsets.items.minimum, 0);
  assert.equal(followingMutation.properties.confirmed_orphan_count.minimum, 0);
  assert.deepEqual(followingMutation.properties.recurrence_rule.type, ['string', 'null']);
});

test('calendar datetime schema distinguishes dates, local wall-clock values, and offsets', () => {
  const spec = buildOpenApiSpec({}, 'test');
  const dateTime = spec.components.schemas.CalendarDateOrDateTime;
  assert.equal(dateTime.oneOf.length, 3);
  assert.deepEqual(dateTime.oneOf.map((variant) => variant.format), ['date', undefined, undefined]);
  assert.deepEqual(dateTime.oneOf.map((variant) => variant.pattern), [
    '^\\d{4}-\\d{2}-\\d{2}$',
    '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?$',
    '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?(?:Z|[+-]\\d{2}:?\\d{2})$',
  ]);
  assert.ok(dateTime.oneOf[1].description.includes('local wall-clock'));
  assert.ok(dateTime.oneOf[2].description.includes('normalized'));
});

test('Outlook account activation documents its exact linked-override conflict', () => {
  const spec = buildOpenApiSpec({}, 'test');
  const update = spec.paths['/api/v1/calendar/outlook/accounts/{id}'].put;
  assert.equal(
    update.responses[409].content['application/json'].schema.$ref,
    '#/components/schemas/OutlookAutoSyncOverrideConflict',
  );
  const conflict = spec.components.schemas.OutlookAutoSyncOverrideConflict;
  assert.deepEqual(conflict.required, [
    'error', 'code', 'conflict', 'linked_override_count',
  ]);
  assert.deepEqual(conflict.properties, {
    error: { type: 'string' },
    code: { type: 'integer', const: 409 },
    conflict: { type: 'string', const: 'outlook_auto_sync_overrides' },
    linked_override_count: { type: 'integer', minimum: 1 },
  });
});

test('calendar occurrence errors consistently document numeric API codes', () => {
  const spec = buildOpenApiSpec({}, 'test');
  const occurrencePaths = [
    spec.paths['/api/v1/calendar/{seriesId}/occurrences/{recurrenceId}'],
    spec.paths['/api/v1/calendar/{seriesId}/occurrences/{recurrenceId}/following'],
  ];
  const sharedResponses = {
    400: '#/components/responses/BadRequest',
    401: '#/components/responses/Unauthorized',
    403: '#/components/responses/Forbidden',
    500: '#/components/responses/InternalServerError',
  };

  for (const operations of occurrencePaths) {
    for (const operation of [operations.put, operations.delete]) {
      for (const [status, responseRef] of Object.entries(sharedResponses)) {
        assert.equal(operation.responses[status].$ref, responseRef);
      }
      assert.equal(
        operation.responses[404].content['application/json'].schema.$ref,
        '#/components/schemas/ApiError',
      );
    }
  }
  assert.equal(spec.components.schemas.ApiError.properties.code.type, 'integer');
  assert.equal(
    spec.components.schemas.CalendarOverrideOrphanConflict.properties.code.type,
    'integer',
  );
});
