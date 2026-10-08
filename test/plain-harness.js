/**
 * Modul: Der handgeschriebene test()-Lauf der aelteren Suiten, mit abgewartetem async-Rumpf (#1783)
 * Zweck: Rund dreissig Suiten bringen ihr eigenes `test(name, fn)` mit:
 *
 *            try { fn(); console.log('  ✓ ...'); passed++; }
 *            catch (err) { console.error('  ✗ ...'); failed++; }
 *
 *        Das ruft `fn()` und wartet nicht. Ein Test mit `async`-Rumpf gilt als
 *        bestanden, sobald er sein Promise zurueckgibt; was nach dem ersten
 *        `await` scheitert, kommt nie bei `failed` an - der Bericht sagt
 *        "bestanden", und der Prozess stirbt bestenfalls danach an der
 *        unbehandelten Rejection. Ein Rumpf, der nie fertig wird, ist ganz
 *        gruen. In #1779 war die erste Fassung eines Wisch-Tests so gruen,
 *        ohne etwas zu messen.
 *
 * WAS SICH NICHT AENDERT: ein synchroner Rumpf laeuft wie bisher sofort und an
 * seiner Stelle in der Datei - die Suiten teilen sich Zustand (eine Datenbank,
 * `globalThis.document`), und ihre Reihenfolge traegt Bedeutung.
 *
 * WAS NEU IST: gibt der Rumpf ein Promise zurueck, zaehlt der Test erst, wenn
 * es sich entschieden hat - erfuellt gruen, abgelehnt rot. `test()` gibt dieses
 * Warten zurueck: wer geteilten Zustand anfasst, schreibt `await test(...)` und
 * haelt damit die Reihenfolge. `finish()` wartet am Dateiende auf alles, was
 * noch laeuft; ohne dieses Warten zaehlte das Ergebnis vor dem Test.
 *
 * Benutzt von test/test-calendar.js. Die uebrigen Suiten mit derselben
 * Bauart tragen heute keinen async-Rumpf (gezaehlt am 2026-10-08) und sind
 * nicht umgestellt.
 */

/**
 * @param {string} label Name in der Ergebniszeile, z.B. "Calendar-Test"
 * @param {{ log?: (line: string) => void, error?: (line: string) => void }} [io]
 */
export function createHarness(label, { log = console.log, error = console.error } = {}) {
  let passed = 0;
  let failed = 0;
  /** @type {Map<Promise<void>, string>} laufende async-Ruempfe mit ihrem Namen */
  const pending = new Map();

  const pass = (name) => { log(`  ✓ ${name}`); passed++; };
  const fail = (name, err) => { error(`  ✗ ${name}: ${err?.message ?? err}`); failed++; };

  /**
   * @param {string} name
   * @param {() => unknown} fn
   * @returns {Promise<void> | undefined} das Warten auf einen async-Rumpf, sonst nichts
   */
  function test(name, fn) {
    let result;
    try {
      result = fn();
    } catch (err) {
      fail(name, err);
      return undefined;
    }
    if (result && typeof result.then === 'function') {
      const settled = Promise.resolve(result)
        .then(() => pass(name), (err) => fail(name, err))
        .finally(() => pending.delete(settled));
      pending.set(settled, name);
      return settled;
    }
    pass(name);
    return undefined;
  }

  /** Wartet auf jeden noch laufenden Rumpf und meldet das Ergebnis. */
  async function finish() {
    // Ein Rumpf, der NIE fertig wird, laesst dieses Warten offen. Node beendet
    // den Lauf dann mit Exit 13 (offenes Top-Level-await) und sagt nicht,
    // welcher Test es war - das sagt diese Zeile.
    const nameStuck = () => {
      for (const name of pending.values()) error(`  ✗ ${name}: der async-Rumpf ist nie fertig geworden`);
    };
    process.once('exit', nameStuck);
    // Ein async-Rumpf kann selbst weitere Tests anmelden: warten, bis nichts mehr laeuft.
    while (pending.size) await Promise.all([...pending.keys()]);
    process.off('exit', nameStuck);
    log(`\n[${label}] Ergebnis: ${passed} bestanden, ${failed} fehlgeschlagen\n`);
    return { passed, failed };
  }

  return { test, finish };
}
