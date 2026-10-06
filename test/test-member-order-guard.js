/**
 * Guard: unter server/ sortiert keine Personenliste selbst nach dem Namen (#1644)
 * Zweck: Die Haushaltsreihenfolge hat EINEN Leser, `memberOrderSql()` in
 *        server/services/household-members.js. Eine Abfrage, die daneben
 *        `ORDER BY ... display_name` schreibt, ist die zweite Reihenfolge: sie
 *        stimmt, solange niemand die Familie ordnet, und steht danach als
 *        einzige Liste im Alphabet.
 *
 *        Gelesen wird der Quelltext: jede Zeile mit `ORDER BY` (samt der
 *        Folgezeile, wenn sie mit einem Komma endet), die `display_name`
 *        nennt. Die Stellen, die bewusst nach dem Namen sortieren, stehen mit
 *        Grund und Anzahl in der Allowlist - eine neue faellt auf, eine
 *        entfernte auch.
 *
 *        Was der Guard NICHT sieht: eine Liste ganz ohne ORDER BY, eine
 *        Sortierung in JavaScript, und einen Sortierbegriff, der als
 *        Zeichenkette gereicht wird (der Standardwert von groupBalanceRows()
 *        in services/split-expenses.js, fuer Aufrufer, die nur rechnen). Das Verhalten der Routen haelt
 *        test/test-member-order.js.
 * Ausfuehren: npm run test:member-order
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Datei -> erlaubte Zahl solcher Stellen, mit Grund. */
const ALLOWED = {
  'server/routes/housekeeping.js': {
    count: 1,
    reason: 'GET /housekeeping/workers lists housekeeping staff. Staff are no household members and have no position.',
  },
  'server/routes/displays.js': {
    count: 1,
    reason: 'GET /displays lists wall displays (devices), not people.',
  },
  'server/services/ics-export.js': {
    count: 2,
    reason: 'Names written into the title of an exported event ("Title (A, B)"). Following the member order would rewrite every exported event the moment the family is rearranged.',
  },
  'server/services/outlook-calendar.js': {
    count: 1,
    reason: 'The same title suffix for the Outlook push; a changed order would push every event again.',
  },
};

function sourceFiles(dir) {
  return readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(rel);
    return entry.name.endsWith('.js') ? [rel] : [];
  });
}

/** Zeilen einer Quelle, in denen eine ORDER-BY-Klausel `display_name` nennt. */
export function nameOrderings(source) {
  const lines = source.split('\n');
  const hits = [];
  lines.forEach((line, index) => {
    // Kommentarzeilen beschreiben eine Sortierung, sie fuehren keine aus.
    if (/^\s*(\*|\/\/|\/\*)/.test(line)) return;
    const at = line.search(/ORDER\s+BY\b/i);
    if (at === -1) return;
    let clause = line.slice(at);
    for (let next = index + 1; /,\s*$/.test(clause) && next < lines.length; next += 1) clause += ` ${lines[next].trim()}`;
    // Der Leser selbst darf Spalten nennen: `${memberOrderOverColumnsSql({ name: 'display_name', ... })}`.
    const own = clause.replace(/\$\{member(?:Order|Position)[A-Za-z]*\((?:\{[^}]*\}|[^)}]*)\)\}/g, '');
    if (/\bdisplay_name\b/.test(own)) hits.push({ line: index + 1, clause: clause.trim() });
  });
  return hits;
}

// Migrationen und ihr Testspiegel sind Geschichte, die OpenAPI-Texte Prosa.
const SKIP = new Set(['server/db.js', 'server/db-schema-test.js']);

test('self-test: the reader finds a name ordering, on one line and continued over two', () => {
  assert.equal(nameOrderings('SELECT 1 FROM users u\n ORDER BY u.display_name COLLATE NOCASE ASC').length, 1);
  assert.equal(nameOrderings('ORDER BY CASE gm.role WHEN 1 THEN 0 END,\n  u.display_name').length, 1);
  assert.equal(nameOrderings("ORDER BY ${memberOrderSql('u')}").length, 0);
  assert.equal(nameOrderings('SELECT u.display_name FROM users u ORDER BY u.id').length, 0);
  assert.equal(nameOrderings("ORDER BY ${memberOrderOverColumnsSql({ position: 'sort_order', name: 'display_name', id: 'user_id' })}").length, 0);
  assert.equal(nameOrderings("ORDER BY ${memberOrderSql('u')}, u.display_name").length, 1, 'ein zweiter Begriff neben dem Leser zaehlt');
  assert.equal(nameOrderings(' * keine Route schreibt `ORDER BY display_name` selbst.').length, 0);
});

test('no list of people in server/ orders by display_name on its own', () => {
  const found = {};
  for (const file of sourceFiles('server')) {
    if (SKIP.has(file) || file.startsWith('server/openapi/')) continue;
    const hits = nameOrderings(readFileSync(path.join(ROOT, file), 'utf8'));
    if (hits.length) found[file] = hits;
  }
  const problems = [];
  for (const [file, hits] of Object.entries(found)) {
    const allowed = ALLOWED[file]?.count ?? 0;
    if (hits.length !== allowed) {
      problems.push(`${file}: ${hits.length} name ordering(s), ${allowed} allowed -\n`
        + hits.map((hit) => `    line ${hit.line}: ${hit.clause}`).join('\n'));
    }
  }
  for (const file of Object.keys(ALLOWED)) {
    if (!found[file]) problems.push(`${file}: allowlisted, but orders by display_name nowhere any more - remove the entry`);
  }
  assert.deepEqual(problems, [], `Use memberOrderSql() from server/services/household-members.js (#1644):\n${problems.join('\n')}`);
});

test('every allowlisted name ordering gives a reason', () => {
  for (const [file, entry] of Object.entries(ALLOWED)) {
    assert.ok(entry.reason.length > 40, `${file}: a reason somebody can check`);
    assert.ok(Number.isInteger(entry.count) && entry.count > 0, file);
  }
});
