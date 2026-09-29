/**
 * Modul: Test-Infrastruktur - der Browser-Harness gibt auf, statt zu haengen (#1446)
 * Zweck: Scheitert `startHarness()` nach dem Serverstart - der Browser startet
 *        nicht, die Anmeldung oder der Erinnerungs-Abgleich schlaegt fehl -,
 *        dann lehnt es mit dem eigentlichen Fehler ab UND hinterlaesst keinen
 *        Serverprozess und kein Temp-Verzeichnis.
 * Ausfuehren: npm run test:document-guards-harness (haengt an test:document-guards)
 *
 * ANLASS (#1446): fehlte lokal der gepinnte Chrome (`npx puppeteer browsers
 * install chrome`), warf `puppeteer.launch()`, und nichts stoppte den eben
 * gestarteten `node server/index.js`. Der Kindprozess hielt den Testprozess am
 * Leben: die Suite hing, statt rot zu werden, und wer sie abbrach, liess den
 * Server weiterlaufen. Jede Browser-Suite geht durch diese Funktion.
 *
 * GEMESSEN WIRD DAS ENDE DES PROZESSES, NICHT DIE ABLEHNUNG. Die Ablehnung kam
 * auch vor dem Fix - nur blieb der Prozess danach stehen. Deshalb faehrt der
 * Harness hier in einem eigenen Kindprozess (diese Datei, mit
 * `HARNESS_PROBE=1`), der nach der Ablehnung NICHTS mehr tut: er endet von
 * selbst genau dann, wenn kein Serverprozess mehr an ihm haengt. Bleibt er
 * stehen, beendet der Test die ganze Prozessgruppe - samt verwaistem Server -
 * und meldet den Haenger als Fehler statt selbst zu haengen.
 *
 * Der Browser scheitert ueber `PUPPETEER_EXECUTABLE_PATH` auf eine Datei, die
 * es nicht gibt - derselbe Wurf wie ein fehlender gepinnter Chrome, nur ohne
 * vom Zustand der Maschine abzuhaengen. Einen Browser braucht die Suite also
 * nicht; sie haengt trotzdem an `test:document-guards`, weil sie wie dort einen
 * eigenen Serverprozess samt Seed hochfaehrt.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHarness } from './document-guards-harness.js';
import { tempDir } from './tmp-dir.js';

if (process.env.HARNESS_PROBE === '1') {
  // Der Kindprozess: einmal starten, das Ergebnis melden, sonst nichts. Kein
  // `process.exit()` - das Ende des Prozesses IST die Messung.
  try {
    const harness = await startHarness();
    console.log('HARNESS_STARTED');
    await harness.close();
  } catch (err) {
    console.log(`HARNESS_REJECTED ${err.message.split('\n')[0]}`);
  }
} else {
  test('ein Browser, der nicht startet, laesst weder Server noch Temp-Verzeichnis zurueck', async () => {
    // Eigener Temp-Ordner: gezaehlt wird nur, was DIESER Lauf anlegt.
    const tmp = tempDir('yuvomi-harness-probe-');
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      env: {
        ...process.env,
        HARNESS_PROBE: '1',
        PUPPETEER_EXECUTABLE_PATH: join(tmp, 'kein-chrome'),
        TMPDIR: tmp,
        DOCUMENT_GUARDS_BASE_URL: '',
      },
      // Eigene Prozessgruppe: haengt der Kindprozess, geht der Server, den er
      // gestartet hat, mit ihm - auch dann, wenn genau das der Befund ist.
      detached: true,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });

    // Migration, Seed und zwei Serverstarts brauchen wenige Sekunden; wer
    // nach einer Minute noch laeuft, haengt.
    const LIMIT_MS = 60_000;
    let timer;
    const ended = await Promise.race([
      new Promise((resolve) => child.once('exit', () => resolve(true))),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), LIMIT_MS); }),
    ]);
    clearTimeout(timer);
    if (!ended) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* schon weg */ }
    }

    assert.match(out, /HARNESS_REJECTED/, `startHarness() lehnt ab - Ausgabe des Kindprozesses: ${out}`);
    assert.ok(ended,
      `Der Kindprozess lief ${LIMIT_MS / 1000} s nach der Ablehnung weiter: ein Serverprozess `
      + 'haengt an ihm, den startHarness() nach dem Fehlschlag nicht gestoppt hat (#1446).');
    assert.deepEqual(readdirSync(tmp).filter((name) => name.startsWith('yuvomi-document-guards-')), [],
      'das Temp-Verzeichnis des Harness ist nach dem Fehlschlag weggeraeumt');
  });
}
