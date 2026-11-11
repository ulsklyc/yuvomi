/**
 * Modul: Test-Infrastruktur - Workflow-Laufzeitdeckel
 * Zweck: Ein Job ohne `timeout-minutes` erbt den GitHub-Default von SECHS
 *        STUNDEN. Hängt ein Prozess - etwa eine Suite, deren Test-Helfer den
 *        Event-Loop offenhält (#903) -, verbrennt der Lauf einen halben
 *        Arbeitstag Runner-Zeit und liest sich die ganze Zeit als „in
 *        progress" statt als rotes X. Der Deckel macht aus „hängt" wieder
 *        „fällt durch".
 * Regel statt Allowlist: geprüft wird JEDER Job in JEDEM Workflow unter
 *        `.github/workflows/`, damit ein neu angelegter Workflow nicht
 *        stillschweigend am Guard vorbeiläuft. Jobs aus GitHubs Default-Setups
 *        (CodeQL: `Analyze`, `CodeQL`) haben dort keine Datei - sie behalten
 *        den 6-Stunden-Default, und dieser Guard kann sie nicht sehen.
 * Ausnahme: ein Job, der ein wiederverwendbares Workflow aufruft (`uses:` auf
 *        Job-Ebene), darf laut GitHub KEIN `timeout-minutes` tragen - der
 *        Parser lehnt den Schlüssel dort ab. Erlaubt ist das nur für einen
 *        Workflow aus DIESEM Ordner (`uses: ./.github/workflows/<datei>`): der
 *        liegt hier und wird selbst geprüft, sein Job trägt den Deckel. Erster
 *        Fall: `restore-drill` in ci.yml (Phase 1b, Abschnitt B).
 * Ausführen: node --test test/test-workflow-timeouts.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const DIR = new URL('../.github/workflows/', import.meta.url);

// Ein Deckel am 6-Stunden-Default wäre keiner. Die Obergrenze hält den Guard
// davon ab, eine wirkungslose Zahl durchzuwinken.
const MAX_MINUTES = 120;

/**
 * Liest die Job-Ebene eines Workflows ohne YAML-Parser: Job-Keys stehen auf
 * Indent 2 unterhalb von `jobs:`, ihre Eigenschaften auf Indent 4. Ein
 * `timeout-minutes` tiefer drin gehört einem STEP und deckelt den Job nicht -
 * deshalb zählt hier ausschliesslich Indent 4.
 *
 * KEIN STILLES ÜBERGEHEN. Die erste Fassung erkannte `  deploy:` nur ohne
 * alles dahinter - ein gültiges `  deploy: # produktiv` fiel durch, der Job
 * wurde nicht gezählt, UND sein `timeout-minutes` landete beim Job davor.
 * Der Guard wäre grün geblieben und hätte dabei genau das Gegenteil dessen
 * belegt, was er behauptet. Eine Zeile auf Indent 2, die nach einem Schlüssel
 * aussieht und trotzdem nicht passt, wirft deshalb, statt weiterzulaufen:
 * lieber ein Guard, der über eine unbekannte Schreibweise stolpert, als
 * einer, der sie für nicht vorhanden hält.
 */
function jobsOf(source, file) {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => l === 'jobs:');
  if (start === -1) return [];

  const jobs = [];
  let current = null;
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (!line.startsWith(' ')) break; // zurück auf Top-Level: jobs-Sektion vorbei

    if (/^ {2}\S/.test(line)) {
      // Indent 2: hier steht ein Job-Name und sonst nichts. Optionale
      // Anführungszeichen, optionaler Kommentar dahinter.
      const jobKey = line.match(/^ {2}(?:"([\w-]+)"|'([\w-]+)'|([\w-]+)):\s*(?:#.*)?$/);
      assert.ok(jobKey, `${file}: unverstandene Zeile auf Job-Ebene: "${line}"`);
      current = { name: jobKey[1] ?? jobKey[2] ?? jobKey[3], timeout: null, calls: null };
      jobs.push(current);
      continue;
    }
    if (!current) continue;

    const calls = line.match(/^ {4}uses:\s*\.\/\.github\/workflows\/([\w.-]+\.ya?ml)\s*(?:#.*)?$/);
    if (calls) current.calls = calls[1];

    const timeout = line.match(/^ {4}timeout-minutes:\s*(\d+)\s*(?:#.*)?$/);
    if (timeout) current.timeout = Number(timeout[1]);
  }
  return jobs;
}

const files = readdirSync(DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

test('es gibt überhaupt Workflows zu prüfen', () => {
  assert.ok(files.length > 0, 'keine Workflow-Datei gefunden - der Guard läuft ins Leere');
});

for (const file of files) {
  test(`${file}: jeder Job hat einen Laufzeitdeckel`, () => {
    const jobs = jobsOf(readFileSync(new URL(file, DIR), 'utf8'), file);
    assert.ok(
      jobs.length > 0,
      `${file}: kein Job erkannt - erwartet Job-Keys auf Indent 2 unter einem `
      + "LF-'jobs:'. Ein anderer Indent-Stil (4 Spaces, CRLF) fällt hier "
      + 'absichtlich auf, statt still übergangen zu werden'
    );

    for (const job of jobs) {
      if (job.calls) {
        // Der gerufene Workflow liegt hier und läuft durch diese Schleife.
        assert.ok(files.includes(job.calls), `${file}, Job "${job.name}": ruft ${job.calls}, das hier fehlt`);
        assert.strictEqual(job.timeout, null, `${file}, Job "${job.name}": GitHub lehnt timeout-minutes an einem Aufruf ab`);
        continue;
      }
      assert.notStrictEqual(
        job.timeout,
        null,
        `${file}, Job "${job.name}": timeout-minutes fehlt - der Job erbt 6 Stunden`
      );
      assert.ok(
        job.timeout > 0 && job.timeout <= MAX_MINUTES,
        `${file}, Job "${job.name}": timeout-minutes ${job.timeout} liegt ausserhalb 1..${MAX_MINUTES}`
      );
    }
  });
}
