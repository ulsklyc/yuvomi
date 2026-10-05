/**
 * OpenAPI structure guard.
 *
 * Sichert die modulare Aufteilung von server/openapi.js: jede
 * server/openapi/paths/<modul>.js muss in paths/index.js importiert und in
 * buildPaths() gespreadet sein, jedes Fragment nicht leer, und kein Pfad-Key
 * darf über zwei Modul-Dateien kollidieren. Verhindert, dass eine kuenftig
 * angelegte Modul-Datei still aus der Spec faellt.
 *
 * Seit #1344 dazu die Verweise IM Dokument: jeder `$ref` der fertigen Spec
 * (paths UND components) ist ein String und zeigt auf ein Ziel, das im selben
 * Dokument existiert. Die uebrigen Tests hier und in test:openapi-coverage
 * pruefen die Liste der Routen oder einzelne, namentlich genannte Schemas -
 * keiner lief ueber alle Verweise. Ein `jsonBody(schemaObjekt)` statt
 * `jsonBody('#/components/schemas/Name')` war dort so gruen wie ein Verweis
 * auf ein Schema, das es nicht gibt.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { buildPaths } from '../server/openapi/paths/index.js';
import { buildOpenApiSpec } from '../server/openapi.js';

const pathsDir = new URL('../server/openapi/paths/', import.meta.url);
test('fasting clients receive concrete lifecycle schemas, revision transports and date filters', () => {
  const paths = buildOpenApiSpec({}).paths;
  const schema = (path, method) => paths[`/api/v1/health/${path}`][method].requestBody.content['application/json'].schema;
  const create = schema('fasting', 'post');
  assert.deepEqual(create.required, ['start_tzid']);
  assert.equal(create.properties.goal_minutes.multipleOf, 60);
  assert.equal(create.properties.goal_minutes.maximum, 20160);
  assert.equal(create.properties.end_at.nullable, true);
  assert.equal(create.properties.note.maxLength, 2000);
  assert.deepEqual(schema('fasting/{id}', 'patch').required, ['expected_revision']);
  assert.deepEqual(schema('fasting/{id}/finish', 'post').required, ['expected_revision']);
  assert.ok(paths['/api/v1/health/fasting'].post.responses[201]);
  assert.ok(paths['/api/v1/health/fasting/{id}'].delete.responses[204]);
  assert.ok(paths['/api/v1/health/fasting/{id}'].delete.parameters.some((p) => p.name === 'expected_revision' && !p.required));
  assert.match(paths['/api/v1/health/fasting/settings'].put.description, /Personal settings are owner-only/);
  assert.doesNotMatch(paths['/api/v1/health/fasting/settings'].put.description, /Caregivers may submit/);
  assert.match(paths['/api/v1/health/fasting/acknowledge-safety'].post.description, /authenticated owner only/);
  assert.match(paths['/api/v1/permissions/role/{familyRole}'].put.description, /health_use_fasting/);
  for (const alias of ['fasting', 'fasting/history']) {
    const names = paths[`/api/v1/health/${alias}`].get.parameters.map((p) => p.name);
    for (const name of ['user_id', 'from', 'to', 'limit', 'before_at', 'before_id']) assert.ok(names.includes(name));
    assert.ok(!names.includes('offset'));
  }
  assert.ok(!paths['/api/v1/health/fasting/stats'].get.parameters.some((p) => p.name === 'now'));
  assert.match(paths['/api/v1/health/fasting/stats'].get.description, /allTime\/year\/last30Days summaries \{count,totalMinutes,averageMinutes\}/);
  assert.match(paths['/api/v1/health/fasting/stats'].get.description, /Statistics, history and CSV date filters use the household display time zone/);
  assert.match(paths['/api/v1/health/fasting/history'].get.description, /Date filters select completion dates in the household display time zone/);
  assert.match(paths['/api/v1/health/export/fasting'].get.description, /same household display-zone completion-date filters as history/);
  assert.ok(paths['/api/v1/health/export/fasting'].get.responses[200].content['text/csv']);
});
test('meals apply-plan describes what the route does: additive without replace_existing, 201', () => {
  // Die Route (server/routes/meals.js, POST /apply-plan) hat belegte Slots nie
  // uebersprungen; die Spec versprach es seit v2.52.0. Pinnt den korrigierten
  // Vertrag, das Verhalten selbst halten die Tests in test:meals-routes.
  const post = buildOpenApiSpec({}).paths['/api/v1/meals/apply-plan'].post;
  assert.doesNotMatch(post.description, /instead of skipping/);
  assert.match(post.description, /added next to any meal already planned for the same date and meal type/);
  assert.match(post.description, /date and meal type pair named in `assignments` is deleted first/);
  assert.ok(post.responses[201]);
  assert.ok(!post.responses[200]);
  assert.ok(post.responses[400]);
});
test('meals apply-plan documents skip_occupied and the skipped answer (Discussion #1380)', () => {
  // Die Route legt mit skip_occupied nur in vorher leere Slots an und nennt
  // die uebrigen in `skipped`; das Verhalten halten die Tests in test:meals-routes.
  const post = buildOpenApiSpec({}).paths['/api/v1/meals/apply-plan'].post;
  const body = post.requestBody.content['application/json'].schema;
  assert.equal(body.properties.skip_occupied.type, 'boolean');
  assert.equal(body.properties.replace_existing.type, 'boolean');
  assert.deepEqual(body.required, ['assignments']);
  const ok = post.responses[201].content['application/json'].schema;
  assert.deepEqual(ok.required, ['data']);
  assert.deepEqual(ok.properties.skipped.items.required, ['index', 'date', 'meal_type', 'reason']);
  assert.equal(ok.properties.skipped.items.properties.index.type, 'integer');
  assert.deepEqual(ok.properties.skipped.items.properties.reason.enum, ['occupied']);
  assert.match(post.description, /`skip_occupied` and `replace_existing` together are refused with 400/);
  assert.match(post.responses[400].description, /`skip_occupied` that is not a boolean/);
});
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

test('jede Variable im Pfad hat ihren Parameter', () => {
  // OPENAPI VERLANGT ES, UND ES IST KEINE FORMSACHE: fehlt zu `{id}` der
  // Eintrag, weisen Validatoren das ganze Dokument ab, und ein erzeugter Client
  // bekommt keine Stelle, an der er die Id uebergeben koennte - der Aufruf
  // laeuft dann in das 400 der Route. Aufgefallen an den Display-Routen aus
  // #1208, wo alle drei parametrierten Operationen ihre Variablen verschwiegen;
  // der uebrige Katalog war zu dem Zeitpunkt sauber, dieser Ratchet kostet also
  // nichts und faengt die naechste vergessene Zeile statt nur einen Rueckfall
  // in genau diesen dreien.
  const fehlend = [];
  for (const [pfad, operationen] of Object.entries(buildPaths())) {
    const variablen = [...pfad.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
    if (!variablen.length) continue;
    for (const [methode, operation] of Object.entries(operationen)) {
      const deklariert = new Set(
        (operation?.parameters || []).filter((p) => p.in === 'path').map((p) => p.name),
      );
      for (const name of variablen) {
        if (!deklariert.has(name)) fehlend.push(`${methode.toUpperCase()} ${pfad} -> {${name}}`);
      }
    }
  }
  assert.deepEqual(fehlend, [],
    `Diese Operationen nennen eine Pfadvariable nicht als Parameter:\n  ${fehlend.join('\n  ')}`);
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

/**
 * Jeder `$ref` der fertigen Spec, mit seinem Fundort.
 *
 * DIE GANZE SPEC, NICHT NUR `paths`. Verweise stehen auch in
 * `components.schemas` (Schema auf Schema) und in den 409-Antworten, die
 * `buildOpenApiSpec` erst nachtraegt; ein Leser, der Teile auslaesst, prueft
 * sie nie und meldet trotzdem gruen. Gelaufen wird deshalb rekursiv durch
 * Objekte UND Arrays (`allOf`, `oneOf`, `parameters`, `items`). `$ref` zaehlt
 * als eigene Eigenschaft auch mit dem Wert `undefined`: im ausgelieferten JSON
 * faellt so ein Schluessel still weg und hinterlaesst ein Schema, das alles
 * erlaubt.
 */
function collectRefs(node, path = [], out = []) {
  if (node === null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    node.forEach((child, i) => collectRefs(child, [...path, i], out));
    return out;
  }
  if (Object.hasOwn(node, '$ref')) out.push({ path: [...path, '$ref'], value: node.$ref });
  for (const [key, child] of Object.entries(node)) collectRefs(child, [...path, key], out);
  return out;
}

/** Fundort lesbar wie ein Zugriff: `paths["/api/v1/x"].post.requestBody...` */
function refLocation(path) {
  return path.map((key, i) => {
    if (typeof key === 'number') return `[${key}]`;
    if (/^[A-Za-z_$][\w$]*$/.test(key)) return i === 0 ? key : `.${key}`;
    return `[${JSON.stringify(key)}]`;
  }).join('');
}

/**
 * Loest `#/a/b/c` gegen das DOKUMENT auf, nie gegen eine angenommene Sektion.
 *
 * Gemessen fuer #1344: ein Pruefer, der nur in `components.schemas`
 * nachschlug, meldete vier Fehlalarme - `#/components/responses/Unauthorized`
 * und seine drei Geschwister leben unter `components.responses`. Derselbe
 * Pruefer waere in der Gegenrichtung blind fuer jeden Verweis in eine Sektion,
 * die er nicht kennt. Gefolgt wird deshalb genau dem Pfad, den der Verweis
 * nennt (JSON Pointer nach RFC 6901: `~1` ist `/`, `~0` ist `~`), und nur ueber
 * EIGENE Schluessel: `(o || {})[k]` faende unter `#/components/schemas/constructor`
 * die Funktion aus dem Prototyp und hielte den Verweis fuer aufgeloest.
 *
 * Ein Ziel ist immer ein Objekt (Schema, Antwort, Parameter); ein Verweis auf
 * einen Text wie `#/info/title` ist kaputt, obwohl es den Pfad gibt. Verweise
 * ausserhalb des Dokuments (`other.json#/...`) loesen nie auf: die Spec wird
 * als EINE Datei ausgeliefert, ein Integrator hat nichts anderes in der Hand.
 * `undefined` heisst hier "kaputt" und wird gemeldet, nicht verschluckt.
 */
function resolveRef(doc, ref) {
  if (!ref.startsWith('#/')) return undefined;
  let node = doc;
  for (const raw of ref.slice(2).split('/')) {
    let key;
    try {
      key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
    } catch {
      return undefined;
    }
    if (node === null || typeof node !== 'object' || !Object.hasOwn(node, key)) return undefined;
    node = node[key];
  }
  return node !== null && typeof node === 'object' ? node : undefined;
}

// Die Verweis-Tests lesen die fertige Spec, nicht buildPaths(): nur dort
// stehen `components` und die nachgetragenen Antworten mit drin.
const refSpec = buildOpenApiSpec({}, 'test');
const specRefs = collectRefs(refSpec);

test('der $ref-Sammler erreicht jeden Verweis der Spec (#1344)', () => {
  // Gegen einen Sammler, der gruen ist, weil er nichts findet: die Zahl darf
  // wachsen und schrumpfen, aber nicht auf null fallen.
  assert.ok(specRefs.length > 0,
    'kein einziger $ref gefunden - der Sammler laeuft ins Leere, und die Tests unten pruefen nichts');
  // Und gegen einen Sammler, der nur TEILE erreicht: eine zweite, unabhaengige
  // Zaehlung ueber den serialisierten Text. Ein `$ref`-Schluessel steht dort
  // genau einmal als `"$ref":`, in einem Text-Wert waeren die Anfuehrungszeichen
  // maskiert. Verglichen werden nur Verweise, die JSON ueberhaupt schreibt -
  // ein `$ref: undefined` faellt beim Serialisieren weg und meldet sich unten.
  const textual = JSON.stringify(refSpec).match(/"\$ref":/g)?.length ?? 0;
  const serialised = specRefs.filter((r) => r.value !== undefined).length;
  assert.equal(serialised, textual,
    `der Sammler sieht ${serialised} Verweise, der Text der Spec enthaelt ${textual} - `
    + 'er laesst einen Teil des Dokuments aus');
});

test('jeder $ref der Spec ist ein String (#1344)', () => {
  // `jsonBody()` nimmt einen Verweis-STRING und baut `{ $ref: schemaRef }`.
  // Bekommt es ein Schema-Objekt, entsteht `{ $ref: { type: 'object', ... } }`:
  // gueltiges JSON, kein gueltiges OpenAPI, und der Request-Body der Route
  // beschreibt still nichts. Beim Bau von #1326 nur durch Lesen der Spec
  // aufgefallen, kein Test hatte hineingeschaut.
  const kaputt = specRefs
    .filter((r) => typeof r.value !== 'string')
    .map((r) => `${refLocation(r.path)} = ${JSON.stringify(r.value)?.slice(0, 120) ?? String(r.value)}`);
  assert.deepEqual(kaputt, [],
    'Diese $ref sind kein String. jsonBody() nimmt nur einen Verweis wie \'#/components/schemas/Name\'; '
    + 'ein Schema-Objekt gehoert nach components.schemas oder ohne $ref direkt unter `schema`:\n  '
    + kaputt.join('\n  '));
});

test('jeder $ref-String zeigt auf ein Ziel im selben Dokument (#1344)', () => {
  // Die zweite Haelfte: ein String allein ist noch kein Verweis. Ein Tippfehler
  // im Namen oder ein umbenanntes Schema laesst `#/components/schemas/Alt`
  // ins Leere zeigen, und ein Pruefer, der nur den Typ ansieht, bleibt gruen.
  const toteVerweise = specRefs
    .filter((r) => typeof r.value === 'string' && resolveRef(refSpec, r.value) === undefined)
    .map((r) => `${refLocation(r.path)} -> ${r.value}`);
  assert.deepEqual(toteVerweise, [],
    'Diese $ref zeigen auf kein Objekt in der Spec:\n  ' + toteVerweise.join('\n  '));
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
    '#/components/schemas/CalendarDateOrDateTimeInput');
  assert.equal(onlyMutation.properties.end_datetime.oneOf[0].$ref,
    '#/components/schemas/CalendarDateOrDateTimeInput');
  assert.deepEqual(onlyMutation.properties.end_datetime.oneOf[1], { type: 'null' });
  assert.equal(onlyMutation.properties.reminder_offsets.maxItems, 5);
  assert.equal(onlyMutation.properties.reminder_offsets.items.minimum, 0);
  assert.equal(followingMutation.properties.confirmed_orphan_count.minimum, 0);
  assert.deepEqual(followingMutation.properties.recurrence_rule.type, ['string', 'null']);
});

test('calendar datetime schema distinguishes dates, local wall-clock values, and offsets', () => {
  const spec = buildOpenApiSpec({}, 'test');
  const patterns = [
    '^\\d{4}-\\d{2}-\\d{2}$',
    '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?$',
    '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?(?:Z|[+-]\\d{2}:?\\d{2})$',
  ];
  // Anfrage und Antwort sind zwei Schemata (#1364): dieselben drei Formen,
  // aber eine Anfrage mit Offset wird umgerechnet, ein synchronisierter
  // Termin behaelt seinen. Ein Schema fuer beides nannte das Abschneiden
  // "normalized" und beschrieb damit keine der beiden Seiten richtig.
  for (const name of ['CalendarDateOrDateTime', 'CalendarDateOrDateTimeInput']) {
    const dateTime = spec.components.schemas[name];
    assert.equal(dateTime.oneOf.length, 3, name);
    assert.deepEqual(dateTime.oneOf.map((variant) => variant.format), ['date', undefined, undefined], name);
    assert.deepEqual(dateTime.oneOf.map((variant) => variant.pattern), patterns, name);
    assert.ok(dateTime.oneOf[1].description.includes('local wall-clock'), name);
    assert.ok(!dateTime.oneOf[2].description.includes('normalized'), `${name} calls a conversion "normalized"`);
  }
  const input = spec.components.schemas.CalendarDateOrDateTimeInput.oneOf[2].description;
  assert.ok(input.includes('converted into household wall-clock time'), input);
  assert.ok(input.includes('only the date counts'), input);
  const stored = spec.components.schemas.CalendarDateOrDateTime.oneOf[2].description;
  assert.ok(stored.includes('synchronized event'), stored);
  assert.ok(!stored.includes('converted'), stored);
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
