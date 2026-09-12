/**
 * Modul: Review-Nachweis
 * Zweck: haelt fest, dass ein gruener `claude-review`-Haken den AKTUELLEN Stand
 *        meint. Der alte Nachweis zaehlte ueber die ganze Lebensdauer des PR und
 *        war gruen, sobald irgendein claude-Kommentar existierte - und weil das
 *        Plugin genau dann abbricht, wenn schon einer existiert, faerbte
 *        derselbe Kommentar jeden weiteren Abbruch gruen. Beide Seiten der Zange
 *        hingen am selben Nagel.
 * Gegenprobe: die Nutzdaten unten sind ECHT (PR #1066, #1029 und #1094),
 *        nicht auf null gezwungen. Die entscheidende Probe ist das Paar
 *        "derselbe PR, zwei Laeufe": der Lauf, der wirklich geprueft hat, wird
 *        gruen, der Abbruch danach rot - und im roten Fall stehen die alten
 *        claude-Kommentare weiter in der Liste, so wie sie es damals taten.
 *        Jede Probe sieht nur, was ihr Lauf damals sehen konnte; die ganze
 *        PR-Geschichte auf einmal waere eine Lage, die es nie gab.
 * Beleg: seit der dritten Runde zu #1096 eine ADRESSE, die im Strom des Laufs
 *        steht UND die die API als claude-Aeusserung nach dem Laufbeginn kennt.
 *        Die Form des Befehls entscheidet nichts mehr; die Proben am Ende fahren
 *        jede Befehlsform, an der die Befehlstext-Pruefung gescheitert ist,
 *        gegen alte, neue und fremde Adressen.
 * Ausfuehren: npm run test:review-proof
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  adressenImStrom, beurteile, bejaht, bejahtIrgendwo, zaehleBelege, zaehleSeit
} from '../.github/scripts/review-verdict.mjs';

const fixture = JSON.parse(
  readFileSync(new URL('./review-proof-fixture.json', import.meta.url), 'utf8')
);

/** Alle drei Stroeme, so wie der Workflow sie hintereinander in das Urteil kippt. */
const alleAeusserungen = [
  ...fixture.aeusserungen.zusammenfassungen,
  ...fixture.aeusserungen.reviews,
  ...fixture.aeusserungen.inline
];

/**
 * Was ein Lauf wirklich gesehen hat.
 *
 * Der Nachweis laeuft unmittelbar nach seiner Review, also bevor der naechste
 * Push existiert. Wuerde eine Probe ihm die ganze PR-Geschichte auf einmal
 * vorlegen, pruefte sie eine Lage, die es nie gab - und ausgerechnet in die
 * Richtung, die gruen macht.
 */
const wieGesehen = (lauf) =>
  alleAeusserungen.filter((a) => a.zeit !== '' && a.zeit <= fixture.laeufe[lauf].ende);

const ECHTE_REVIEW = '34315259346';
const ABBRUCH_LAUF = '34320151190';
/** Der Lauf, aus dem `strom.gepostet` stammt: saubere Review, eine Zusammenfassung. */
const SAUBER = '34316389826';
const seit = (lauf) => fixture.laeufe[lauf].beginn;
const kopf = (lauf) => fixture.laeufe[lauf].head;
const ABBRUCH = fixture.ergebnisse['abbruch-schon-kommentiert'];
const NICHTS = { adressen: 0, erfolge: 0 };

/** Der echte Postbefehl aus #1066, gemessen gegen das, was sein Lauf von der API sah. */
const geliefert = () => zaehleBelege(fixture.strom.gepostet, wieGesehen(SAUBER), seit(SAUBER));

test('DER FALL AUS #1066: alter Kommentar plus neuer Push wird rot', () => {
  // Der Ablauf, wie er wirklich war: claude sprach dreimal (05:41:30Z,
  // 05:57:53Z, 06:04:45Z), danach kam Push 8a87a5cd. Der Lauf dazu dauerte
  // 1m18s und hinterliess nichts - der Haken stand trotzdem gruen.
  const urteil = beurteile({
    seit: seit(ABBRUCH_LAUF),
    ergebnis: ABBRUCH,
    aeusserungen: wieGesehen(ABBRUCH_LAUF)
  });
  assert.equal(urteil.ausgang, 'stumm', 'dieser Stand ist ungeprueft und muss rot sein');
  assert.equal(urteil.grund, 'schon-kommentiert');
  assert.match(urteil.meldung, /UNGEPRUEFT/);
});

test('und genau diese Lage haette der alte Nachweis gruen genannt', () => {
  // Die halbe Gegenprobe waere, den Zaehler auf null zu zwingen. Das hier ist
  // die ganze: an DENSELBEN Daten war die alte Regel ("irgendwo am PR steht ein
  // claude-Kommentar") erfuellt - dreifach sogar.
  const gesehen = wieGesehen(ABBRUCH_LAUF);
  const ueberDieGanzeLebensdauer = gesehen.filter((a) =>
    a.login.toLowerCase().includes('claude')
  ).length;
  // Fuenf Zeilen aus drei Gelegenheiten: eine Review steht sowohl in der
  // Review- als auch in der Inline-Liste. Genau diese Zeilen hat der alte
  // Nachweis addiert, und schon eine haette ihm gereicht.
  assert.equal(
    ueberDieGanzeLebensdauer,
    5,
    'ohne alte claude-Zeilen stellt diese Probe den Fehlerfall gar nicht nach'
  );
  assert.equal(zaehleSeit(gesehen, seit(ABBRUCH_LAUF), kopf(ABBRUCH_LAUF)).gesamt, 0);
});

test('derselbe PR, der Lauf, der wirklich geprueft hat: gruen', () => {
  // Dasselbe Fixture, ein Lauf frueher: 9m41s auf b1ce599e, Befund um 05:41:30Z
  // gepostet. Ohne diese Probe waere der neue Nachweis nur ein anderer blinder
  // Fleck - einer, der immer rot ist.
  const urteil = beurteile({
    seit: seit(ECHTE_REVIEW),
    kopf: kopf(ECHTE_REVIEW),
    ergebnis: fixture.ergebnisse['echte-review'],
    aeusserungen: wieGesehen(ECHTE_REVIEW)
  });
  assert.equal(urteil.ausgang, 'geprueft');
  assert.equal(urteil.grund, 'gebunden', 'Review und Inline nennen genau diesen Commit');
  // Zwei und nicht eine: derselbe Befund steht in beiden Listen, einmal als
  // Review und einmal als ihre Inline-Anmerkung. Der Nachweis zaehlt
  // Aeusserungen und keine Befunde - fuer die Frage "hat sie gesprochen?"
  // reicht das, und die Zahl in der Log-Zeile ist keine Befundzahl.
  assert.equal(urteil.neu, 2, 'Review und Inline-Anmerkung von 05:41:30Z');
});

test('fremde Stimmen zaehlen nicht, auch wenn sie fleissig sind', () => {
  // An #1066 hat codex JEDEN Push kommentiert - waehrend claude schwieg. Ein
  // Nachweis, der nur "es steht etwas Neues am PR" prueft, waere dadurch die
  // ganze Zeit gruen gewesen.
  const waehrendDesLaufs = alleAeusserungen.filter(
    (a) => a.zeit > seit(ABBRUCH_LAUF) && a.zeit <= '2026-09-09T06:55:00Z'
  );
  assert.ok(waehrendDesLaufs.length > 0, 'nach diesem Push wurde sehr wohl geredet');
  assert.ok(
    waehrendDesLaufs.some((a) => a.login.includes('codex')),
    'und zwar unter anderem von codex'
  );
  assert.equal(zaehleSeit(waehrendDesLaufs, seit(ABBRUCH_LAUF), kopf(ABBRUCH_LAUF)).gesamt, 0);
});

test('der triviale Abbruch bleibt gruen, sagt aber, dass er nichts geprueft hat', () => {
  // #1029: zwei Zeilen `{ timeout: 5000 }`. Das Plugin steigt zugesichert aus,
  // und rot waere hier ein Fehlalarm. Der Unterschied zum Fall oben steht nur
  // im result-Text, sonst ist alles gleich: 4 Turns, keine Verweigerungen.
  const urteil = beurteile({
    seit: seit(ABBRUCH_LAUF),
    ergebnis: fixture.ergebnisse['abbruch-trivial'],
    aeusserungen: wieGesehen(ABBRUCH_LAUF)
  });
  assert.equal(urteil.ausgang, 'ausgesetzt');
  assert.equal(urteil.grund, 'trivial');
  assert.match(urteil.meldung, /nicht "geprueft"/);
});

test('nennt ein Text beides, gilt die gefaehrlichere Lesart', () => {
  // Modellprosa ist kein Protokoll. Sagt sie "trivial" UND "schon kommentiert",
  // darf nicht die Lesart gewinnen, die gruen macht.
  const urteil = beurteile({
    seit: seit(ABBRUCH_LAUF),
    ergebnis: {
      num_turns: 3,
      subtype: 'success',
      is_error: false,
      permission_denials: [],
      result:
        'Claude has already commented on this PR, and the new commit is a ' +
        'trivial change that is obviously correct, so this matches the step 1 ' +
        'stop condition. Stopping here.'
    },
    aeusserungen: wieGesehen(ABBRUCH_LAUF)
  });
  assert.equal(urteil.ausgang, 'stumm');
  assert.equal(urteil.grund, 'schon-kommentiert');
});

test('"has not previously commented" ist kein Abbruch aus diesem Grund', () => {
  // Der echte #1029-Text enthaelt genau diesen Satz. Ein zu gieriges Muster
  // haette den trivialen Fall in den gefaehrlichen umgedeutet.
  assert.match(fixture.ergebnisse['abbruch-trivial'].result, /has not previously commented/);
  assert.equal(
    beurteile({
      seit: seit(ABBRUCH_LAUF),
      ergebnis: fixture.ergebnisse['abbruch-trivial'],
      aeusserungen: wieGesehen(ABBRUCH_LAUF)
    }).grund,
    'trivial'
  );
});

test('ohne Stand wird rot, nicht gruen', () => {
  // Der leere Fallback waere hier der gefaehrlichste: ein leerer Vergleichswert
  // laesst JEDE Aeusserung als "neu" durchgehen.
  for (const kaputt of ['', undefined, '2026-09-09', '2026-09-09T06:40:30+00:00']) {
    const urteil = beurteile({ seit: kaputt, ergebnis: ABBRUCH, aeusserungen: wieGesehen(ABBRUCH_LAUF) });
    assert.equal(urteil.ausgang, 'stumm', `Stand ${JSON.stringify(kaputt)} muss rot werden`);
    assert.equal(urteil.grund, 'kein-stand');
  }
});

test('ein unlesbares result-Objekt wird rot und nennt seinen eigenen Grund', () => {
  const urteil = beurteile({ seit: seit(ABBRUCH_LAUF), ergebnis: null, aeusserungen: wieGesehen(ABBRUCH_LAUF) });
  assert.equal(urteil.ausgang, 'stumm');
  assert.equal(urteil.grund, 'kein-ergebnis');
});

test('unlesbare Kommentar-Zeilen werden nicht als Schweigen gelesen', () => {
  // Sonst waere der Haken rot aus dem falschen Grund - und die naechste Runde
  // suchte den Fehler im Prompt statt in der Datenbeschaffung.
  const urteil = beurteile({
    seit: seit(ABBRUCH_LAUF),
    ergebnis: ABBRUCH,
    aeusserungen: wieGesehen(ABBRUCH_LAUF),
    kaputt: 1
  });
  assert.equal(urteil.grund, 'daten-kaputt');
});

test('die bekannten Fehlschlaege behalten ihre eigene Diagnose', () => {
  const faelle = [
    [{ permission_denials: [{ tool_name: 'Bash' }], result: 'ready to post' }, 'werkzeugsperre'],
    [
      { permission_denials: [], result: "I'll wait for both background agents to complete." },
      'agenten'
    ],
    [{ permission_denials: [], result: 'Done.' }, 'unbekannt'],
    [{ permission_denials: [], is_error: true, result: 'boom' }, 'lauf-fehler'],
    [{ permission_denials: [], subtype: 'error_max_turns', result: 'boom' }, 'lauf-fehler']
  ];
  for (const [ergebnis, grund] of faelle) {
    const urteil = beurteile({ seit: seit(ABBRUCH_LAUF), ergebnis, aeusserungen: wieGesehen(ABBRUCH_LAUF) });
    assert.equal(urteil.ausgang, 'stumm');
    assert.equal(urteil.grund, grund);
  }
});

test('zaehleSeit vergleicht die Zeitstempel und nicht die Reihenfolge', () => {
  const liste = [
    { login: 'claude[bot]', zeit: '2026-09-09T06:40:29Z' },
    { login: 'claude[bot]', zeit: '2026-09-09T06:40:30Z' },
    { login: 'claude[bot]', zeit: '2026-09-09T06:40:31Z' },
    { login: 'Claude[BOT]', zeit: '2026-09-09T07:00:00Z' },
    { login: 'claude[bot]', zeit: '' }
  ];
  // Die Sekunde des Laufbeginns selbst zaehlt nicht mit: strikt spaeter.
  assert.equal(zaehleSeit(liste, '2026-09-09T06:40:30Z').gesamt, 2);
});

test('gebunden und ungebunden werden getrennt gezaehlt', () => {
  // Die Commit-SHA ist der Unterschied zwischen "jemand hat geredet" und "zu
  // DIESEM Commit wurde geredet". An #1066 traegt die Zusammenfassung keine.
  const liste = [
    { login: 'claude[bot]', zeit: '2026-09-09T06:00:00Z', commit: 'aaa' },
    { login: 'claude[bot]', zeit: '2026-09-09T06:00:00Z', commit: 'bbb' },
    { login: 'claude[bot]', zeit: '2026-09-09T06:00:00Z', commit: null }
  ];
  const zahl = zaehleSeit(liste, '2026-09-09T05:00:00Z', 'aaa');
  assert.deepEqual(zahl, { gebunden: 1, frei: 2, gesamt: 3 });
});

// ---------------------------------------------------------------------------
// Vier Befunde aus der Codex-Runde zu PR #1073. Jede Probe faellt ohne ihren
// Fix - nachgeprueft, indem die alte Fassung wieder eingesetzt wurde.
// ---------------------------------------------------------------------------

test('eine FREMDE claude-Aeusserung faerbt einen Abbruch nicht gruen', () => {
  // Ein Zeitstempel allein belegt nicht, dass eine Aeusserung aus DIESEM Lauf
  // stammt: der Mention-Pfad (.github/workflows/claude.yml) antwortet als
  // derselbe Bot, und ein per cancel-in-progress abgebrochener Vorgaenger kann
  // noch posten, nachdem der Nachfolger seinen Laufbeginn notiert hat. Vorher
  // schloss "irgendwer hat nach dem Laufbeginn geredet" kurz, bevor das
  // result-Objekt ueberhaupt gelesen wurde.
  const fremd = [
    ...wieGesehen(ABBRUCH_LAUF),
    { login: 'claude[bot]', zeit: '2026-09-09T06:41:00Z', commit: null }
  ];
  const urteil = beurteile({
    seit: seit(ABBRUCH_LAUF),
    kopf: kopf(ABBRUCH_LAUF),
    ergebnis: ABBRUCH,
    aeusserungen: fremd
  });
  assert.equal(urteil.ausgang, 'stumm', 'das Protokoll des Laufs schlaegt die Zaehlung');
  assert.equal(urteil.grund, 'schon-kommentiert');
});

test('eine VERNEINTE Tor-Bedingung ist keine Ausnahme', () => {
  // "the stop condition does not apply because this is not trivial" trug beide
  // Woerter und haette die einzige stille Gruen-Ausnahme ausgeloest.
  const urteil = beurteile({
    seit: seit(ABBRUCH_LAUF),
    kopf: kopf(ABBRUCH_LAUF),
    ergebnis: {
      num_turns: 6,
      subtype: 'success',
      is_error: false,
      permission_denials: [],
      result:
        'The step 1 stop condition does not apply because this is not a trivial ' +
        'change, so I continued.'
    },
    aeusserungen: wieGesehen(ABBRUCH_LAUF)
  });
  assert.equal(urteil.ausgang, 'stumm');
  assert.equal(urteil.grund, 'unbekannt');
});

test('eine Werkzeugsperre schlaegt die Tor-Ausnahme', () => {
  // Die Reihenfolge war umgekehrt: ein Lauf, der an einer Sperre gescheitert
  // war, wurde gruen, wenn sein Text zufaellig nach dem trivialen Tor klang.
  // Die einzige stille Gruen-Ausnahme darf nicht vor der Fehlerpruefung liegen.
  const urteil = beurteile({
    seit: seit(ABBRUCH_LAUF),
    kopf: kopf(ABBRUCH_LAUF),
    ergebnis: {
      num_turns: 12,
      subtype: 'success',
      is_error: false,
      permission_denials: [{ tool_name: 'Bash' }],
      result: 'This matches the step 1 stop condition (trivial change).'
    },
    aeusserungen: wieGesehen(ABBRUCH_LAUF)
  });
  assert.equal(urteil.ausgang, 'stumm');
  assert.equal(urteil.grund, 'werkzeugsperre');
});

test('der echte #1029-Wortlaut bleibt die Ausnahme', () => {
  // Das geschaerfte Muster darf den Fall, fuer den es gebaut ist, nicht
  // verlieren. Der Wortlaut steht als Beleg im Fixture.
  assert.match(fixture.ergebnisse['abbruch-trivial'].result, /matches the step 1 stop condition/);
  assert.equal(
    beurteile({
      seit: seit(ABBRUCH_LAUF),
      kopf: kopf(ABBRUCH_LAUF),
      ergebnis: fixture.ergebnisse['abbruch-trivial'],
      aeusserungen: wieGesehen(ABBRUCH_LAUF)
    }).ausgang,
    'ausgesetzt'
  );
});

test('eine Zusammenfassung ohne SHA zaehlt ueber ihre Adresse im Strom', () => {
  // Sie ist der einzige Beleg, den das Plugin bei einem sauberen PR am PR
  // hinterlaesst, und traegt keine SHA. Die Zuordnung kommt deshalb aus dem
  // Strom des Laufs: dort steht die Adresse, die der Postbefehl zurueckbekam,
  // und die API kennt genau sie als claude-Aeusserung von 05:57:53Z - neun
  // Minuten nach dem Beginn dieses Laufs. Alles echt, aus Lauf 34316389826.
  const urteil = beurteile({
    seit: seit(SAUBER),
    kopf: kopf(SAUBER),
    ergebnis: fixture.ergebnisse['saubere-review'],
    aeusserungen: wieGesehen(SAUBER),
    gepostet: geliefert()
  });
  assert.equal(urteil.ausgang, 'geprueft');
  assert.equal(urteil.grund, 'adresse');
});

/* Und dieselbe Vorfahrt gegen die ABBRUCHBEHAUPTUNG - der Fall aus #1082.
 *
 * Am 09.09. liefen an einem PR zwei Laeufe hintereinander:
 *
 *   Lauf 1  num_turns 21, Verweigerungen 8, Postbefehle 1 von 5 ohne Fehler
 *   Rerun   num_turns 4,  Verweigerungen 0, Postbefehle 0 von 0
 *
 * Der Rerun ist der echte Abbruch und gehoert rot. Lauf 1 hatte geprueft und
 * gepostet - der Kommentar steht bis heute am PR - und wurde trotzdem rot,
 * weil sein result-Text nebenbei "already ... commented" sagte. Ein Abbruch im
 * Tor hinterlaesst aber nichts; wer nachweislich geliefert hat, hat nicht im
 * Tor abgebrochen.
 */
test('eine belegte Lieferung schlaegt die Abbruchbehauptung (#1082)', () => {
  const urteil = beurteile({
    seit: seit(SAUBER),
    kopf: kopf(SAUBER),
    ergebnis: ABBRUCH,                       // derselbe Text, der #1066 rot faerbt
    aeusserungen: wieGesehen(SAUBER),
    gepostet: geliefert()
  });
  assert.equal(urteil.ausgang, 'geprueft',
    'ein Lauf, der nachweislich geliefert hat, kann nicht im Tor abgebrochen sein');
  assert.equal(urteil.grund, 'adresse');
});

/* Und ein Befehl, der zwar so AUSSIEHT, aber nichts angelegt hat (Review zu
 * #1085). `--help` endet mit 0 und postet nichts, `--delete-last --yes` endet
 * mit 0 und loescht sogar einen. Ohne Adresse im Ergebnis gibt es keinen Beleg. */
const stromMit = (befehl, inhalt, { fehler = false } = {}) => [
  { type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'toolu_probe', name: 'Bash', input: { command: befehl } }
  ] } },
  { type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: 'toolu_probe', content: inhalt, is_error: fehler }
  ] } }
];

test('ein Postbefehl OHNE Adresse im Ergebnis ist kein Beleg (#1085)', () => {
  for (const [befehl, inhalt] of [
    ['gh pr comment --help', 'Add a comment to a pull request\n\nUSAGE\n  gh pr comment ...'],
    ['gh pr comment 1085 --repo ulsklyc/yuvomi --delete-last --yes', 'Deleted comment.']
  ]) {
    const gepostet = zaehleBelege(stromMit(befehl, inhalt), wieGesehen(ABBRUCH_LAUF), seit(ABBRUCH_LAUF));
    assert.deepEqual(gepostet, NICHTS, `${befehl}: endet mit 0, legt aber nichts an`);

    const urteil = beurteile({
      seit: seit(ABBRUCH_LAUF),
      kopf: kopf(ABBRUCH_LAUF),
      ergebnis: ABBRUCH,
      aeusserungen: [],
      gepostet
    });
    assert.equal(urteil.ausgang, 'stumm', `${befehl} darf die Abbruchbehauptung nicht aushebeln`);
    assert.equal(urteil.grund, 'schon-kommentiert');
  }
});

/* Der Bypass aus der zweiten Runde zu #1085: der Befehl traegt den Namen, das
 * ERGEBNIS traegt eine fremde, alte Adresse - gepostet hat er nichts.
 *
 *   gh pr comment --help; gh pr view 1085 --json comments --jq '.comments[-1].url'
 *
 * Bis zur dritten Runde zu #1096 fing das die Kettenpruefung auf dem Befehlstext.
 * Jetzt faengt es die Tatsache: die gedruckte Adresse ist die echte
 * Zusammenfassung aus #1066 von 05:57:53Z, und dieser Lauf begann um 06:40:37Z. */
test('eine FREMDE, ALTE Adresse im Ergebnis ist kein Beleg (#1085, zweite Runde)', () => {
  const ketten = [
    "gh pr comment --help; gh pr view 1085 --json comments --jq '.comments[-1].url'",
    "gh pr comment 1085 --body x --help; gh pr view 1085 --json comments --jq '.comments[-1].url'",
    "gh pr comment 1085 --body x --help && gh pr view 1085 --jq '.comments[-1].url'",
    "gh pr comment 1085 --body x --help || gh pr view 1085 --jq '.comments[-1].url'"
  ];
  const alt = 'https://github.com/ulsklyc/yuvomi/pull/1066#issuecomment-5596556584';
  assert.ok(wieGesehen(ABBRUCH_LAUF).some((a) => a.anker === 'issuecomment-5596556584' && a.zeit < seit(ABBRUCH_LAUF)),
    'die Adresse gehoert zu einer Aeusserung, die VOR diesem Lauf entstand');
  for (const befehl of ketten) {
    const gepostet = zaehleBelege(stromMit(befehl, alt), wieGesehen(ABBRUCH_LAUF), seit(ABBRUCH_LAUF));
    assert.deepEqual(gepostet, { adressen: 1, erfolge: 0 }, befehl);

    const urteil = beurteile({
      seit: seit(ABBRUCH_LAUF), kopf: kopf(ABBRUCH_LAUF),
      ergebnis: ABBRUCH, aeusserungen: wieGesehen(ABBRUCH_LAUF), gepostet
    });
    assert.equal(urteil.ausgang, 'stumm', befehl);
    assert.equal(urteil.grund, 'schon-kommentiert', befehl);
  }
});

test('der echte Postbefehl mit Heredoc bleibt ein Beleg', () => {
  // Die Gegenrichtung: die Fassung aus #1066 traegt Zeilenumbrueche im Body.
  assert.deepEqual(geliefert(), { adressen: 1, erfolge: 1 });
});

/* Nur der eigene Strom traegt die Aussage "DIESER Lauf hat geliefert" (#1085,
 * zweite Runde). Eine Aeusserung mit der SHA dieses Stands sagt nicht, WER sie
 * geschrieben hat - der Mention-Pfad antwortet als derselbe Bot, und ein
 * abgebrochener Vorgaenger kann noch posten. Bei einem gescheiterten Lauf wies
 * die Meldung sie sonst diesem Lauf zu. */
test('eine SHA-gebundene Aeusserung wird einem gescheiterten Lauf nicht zugeschrieben', () => {
  const urteil = beurteile({
    seit: seit(ABBRUCH_LAUF),
    kopf: kopf(ABBRUCH_LAUF),
    ergebnis: { num_turns: 3, subtype: 'error_during_execution', is_error: true, permission_denials: [] },
    aeusserungen: [{ login: 'claude[bot]', zeit: '2026-09-09T06:41:00Z', commit: kopf(ABBRUCH_LAUF) }],
    gepostet: zaehleBelege(fixture.strom.nichts_gepostet, [], seit(ABBRUCH_LAUF))
  });
  assert.equal(urteil.ausgang, 'stumm');
  assert.equal(urteil.grund, 'lauf-fehler');
  assert.ok(!/zwar gepostet/.test(urteil.meldung),
    'ohne eigenen Beleg darf die Meldung diesem Lauf keinen Post zuschreiben');
  assert.match(urteil.meldung, /wer sie geschrieben hat, sagt der Strom DIESES Laufs aber nicht/);
});

test('die Adresse zaehlt auch aus einer JSON-Antwort', () => {
  // `gh api .../comments` gibt ein Objekt zurueck, keine nackte Adresse. Die
  // Adresse ist die echte Inline-Anmerkung aus Lauf 34315259346 (05:41:30Z).
  const strom = stromMit(
    'gh api repos/ulsklyc/yuvomi/pulls/1066/comments -f body=x',
    { html_url: 'https://github.com/ulsklyc/yuvomi/pull/1066#discussion_r3965014733' }
  );
  assert.deepEqual(
    zaehleBelege(strom, wieGesehen(ECHTE_REVIEW), seit(ECHTE_REVIEW)),
    { adressen: 1, erfolge: 1 }
  );
});

/* Die Meldung darf nur behaupten, was der Aufrufer ihr mitgegeben hat (Review
 * zu #1085). Bei einem Lauf, der geliefert hat und danach auf seine Agenten
 * wartet, bleibt es rot, aber weil er UNFERTIG ist, nicht weil nichts
 * zuzuordnen waere. */
test('ein Lauf, der gepostet hat und dann wartet, wird richtig benannt', () => {
  const urteil = beurteile({
    seit: seit(ABBRUCH_LAUF),
    kopf: kopf(ABBRUCH_LAUF),
    ergebnis: {
      num_turns: 9, subtype: 'success', is_error: false, permission_denials: [],
      result: "I'll wait for both background agents to complete before continuing."
    },
    aeusserungen: [{ login: 'claude[bot]', zeit: '2026-09-09T06:41:00Z', commit: kopf(ABBRUCH_LAUF) }],
    gepostet: geliefert()
  });
  assert.equal(urteil.ausgang, 'stumm');
  assert.equal(urteil.grund, 'agenten', 'der Grund bleibt die Unvollstaendigkeit');
  assert.match(urteil.meldung, /zwar gepostet/);
  assert.match(urteil.meldung, /ABGESCHLOSSENE Pruefung/);
  assert.ok(!/keine davon belegt DIESEN Lauf/.test(urteil.meldung),
    'das waere falsch: die Aeusserung traegt die SHA dieses Laufs');
});

/* Und der Fallback muss bei einer Abbruchbehauptung ueberhaupt erreichbar sein
 * (Review zu #1085, dritte Runde). Ohne `zahl.gebunden === 0` in der Bedingung
 * kehrt der Abbruchzweig vorher zurueck.
 *
 * Der Fall: eine Inline-Anmerkung, deren tool_result keine Adresse traegt (oder
 * ein Lauf ohne `show_full_output: true`), plus Prosa, die nebenbei "already
 * commented" sagt. Die Frage dieses Moduls ist "wurde DIESER STAND geprueft" -
 * eine Aeusserung mit der SHA des Kopfes beantwortet sie mit ja. */
test('eine SHA-gebundene Aeusserung macht den Fallback auch bei Abbruchprosa erreichbar', () => {
  const urteil = beurteile({
    seit: seit(ABBRUCH_LAUF),
    kopf: kopf(ABBRUCH_LAUF),
    ergebnis: ABBRUCH,
    aeusserungen: [{ login: 'claude[bot]', zeit: '2026-09-09T06:41:00Z', commit: kopf(ABBRUCH_LAUF) }],
    gepostet: zaehleBelege(fixture.strom.nichts_gepostet, [], seit(ABBRUCH_LAUF))
  });
  assert.equal(urteil.ausgang, 'geprueft');
  assert.equal(urteil.grund, 'gebunden');
});

test('OHNE gebundene Aeusserung bleibt die Abbruchbehauptung rot', () => {
  // Die Gegenrichtung, damit die zweite Haelfte der Bedingung nicht zur Tuer
  // wird: der Fall aus #1066 hat keine Aeusserung mit der SHA dieses Kopfes.
  const urteil = beurteile({
    seit: seit(ABBRUCH_LAUF),
    kopf: kopf(ABBRUCH_LAUF),
    ergebnis: ABBRUCH,
    aeusserungen: [{ login: 'claude[bot]', zeit: '2026-09-09T06:41:00Z', commit: 'ein-anderer-stand' }],
    gepostet: zaehleBelege(fixture.strom.nichts_gepostet, [], seit(ABBRUCH_LAUF))
  });
  assert.equal(urteil.ausgang, 'stumm');
  assert.equal(urteil.grund, 'schon-kommentiert');
});

test('ein GESCHEITERTER Postbefehl rettet die Abbruchbehauptung nicht', () => {
  // Die Gegenrichtung, damit die Ausnahme oben nicht zur Tuer wird: gezaehlt
  // werden nur Ergebnisse ohne `is_error` - auch dann, wenn das gescheiterte
  // Ergebnis die ECHTE neue Adresse traegt.
  const fehlschlaege = [
    fixture.strom.post_gescheitert,
    stromMit('gh pr comment 1066 --body x',
      'https://github.com/ulsklyc/yuvomi/pull/1066#issuecomment-5596556584', { fehler: true })
  ];
  for (const strom of fehlschlaege) {
    const gepostet = zaehleBelege(strom, wieGesehen(SAUBER), seit(SAUBER));
    assert.deepEqual(gepostet, NICHTS);
    const urteil = beurteile({
      seit: seit(SAUBER), kopf: kopf(SAUBER),
      ergebnis: ABBRUCH, aeusserungen: [], gepostet
    });
    assert.equal(urteil.ausgang, 'stumm');
    assert.equal(urteil.grund, 'schon-kommentiert');
  }
});

test('die Meldung nennt die Zahl, die der Schritt darueber ausgegeben hat', () => {
  // Hier stand pauschal "nichts hinterlassen", waehrend der Job-Log zwei Zeilen
  // hoeher "Aeusserungen von claude seit dem Laufbeginn: 1" ausgab. Zwei Zeilen
  // desselben Logs widersprachen sich, und der Leser sucht dann falsch.
  const urteil = beurteile({
    seit: seit(ABBRUCH_LAUF),
    ergebnis: fixture.ergebnisse['stumm-unbekannt'],
    aeusserungen: [{ login: 'claude[bot]', zeit: '2026-09-09T06:41:00Z' }],
    gepostet: zaehleBelege(fixture.strom.nichts_gepostet, [], seit(ABBRUCH_LAUF))
  });
  assert.equal(urteil.ausgang, 'stumm');
  assert.equal(urteil.neu, 1);
  assert.match(urteil.meldung, /1 Aeusserung\(en\) nach dem Laufbeginn/);
  assert.ok(!/in diesem Lauf nichts hinterlassen/.test(urteil.meldung),
    'die Meldung darf nicht behaupten, es sei gar nichts gesagt worden');
});

test('ZUORDNUNG AUS ABWESENHEIT TRAEGT NICHT: "Done." bleibt rot', () => {
  // Der Befund aus der zweiten Codex-Runde. Ein Lauf, der still mit "Done."
  // endet, hat nichts gepostet - eine fremde Zusammenfassung (Mention-Pfad oder
  // Nachzuegler eines abgebrochenen Vorgaengers) darf ihn nicht gruen faerben.
  const urteil = beurteile({
    seit: seit(ABBRUCH_LAUF),
    kopf: kopf(ABBRUCH_LAUF),
    ergebnis: fixture.ergebnisse['stumm-unbekannt'],
    aeusserungen: [{ login: 'claude[bot]', zeit: '2026-09-09T06:41:00Z', commit: null }],
    gepostet: zaehleBelege(fixture.strom.nichts_gepostet, [], seit(ABBRUCH_LAUF))
  });
  assert.equal(urteil.ausgang, 'stumm');
  assert.equal(urteil.grund, 'nicht-zuzuordnen');
});

test('ohne jede Aeusserung bleibt der stille Lauf schlicht unbekannt', () => {
  // Die beiden Gruende sind verschieden und sollen es bleiben: "es steht etwas
  // da, das ich dir nicht zuschreiben kann" ist eine andere Lage als "es steht
  // nichts da".
  assert.equal(
    beurteile({
      seit: seit(ABBRUCH_LAUF),
      kopf: kopf(ABBRUCH_LAUF),
      ergebnis: fixture.ergebnisse['stumm-unbekannt'],
      aeusserungen: []
    }).grund,
    'unbekannt'
  );
});


// ---------------------------------------------------------------------------
// Fuenf Befunde aus der dritten Codex-Runde zu PR #1073.
// ---------------------------------------------------------------------------

test('die Adresse im Strom ist der Beleg, nicht der Satz darueber', () => {
  // Sie steht im Strom des Laufs, den nur dieser Lauf schreibt - kein
  // Mention-Pfad und kein abgebrochener Vorgaenger kommt da hinein.
  assert.deepEqual(geliefert(), { adressen: 1, erfolge: 1 });
  assert.deepEqual(zaehleBelege(fixture.strom.nichts_gepostet, wieGesehen(SAUBER), seit(SAUBER)), NICHTS);
  // Ein Postbefehl, der FEHLSCHLAEGT, ist kein Beleg. Genau das war die alte
  // Ursache: ohne `Bash(gh pr comment:*)` prueft die Review vollstaendig und
  // kann ihr Ergebnis nicht abliefern.
  assert.deepEqual(zaehleBelege(fixture.strom.post_gescheitert, wieGesehen(SAUBER), seit(SAUBER)), NICHTS);
});

test('ein Beleg fuer Unvollstaendigkeit schlaegt die Lieferung', () => {
  // Ein Lauf, der EINE Anmerkung postet und dann auf seine Agenten wartet, ist
  // nicht fertig - dasselbe gilt fuer eine Anmerkung, die ein abgebrochener
  // Vorgaenger am selben Head hinterlassen hat. Stuende der Beleg davor, waere
  // der Haken gruen ueber einer abgebrochenen Pruefung.
  const urteil = beurteile({
    seit: seit(ABBRUCH_LAUF),
    kopf: kopf(ABBRUCH_LAUF),
    ergebnis: {
      num_turns: 9, subtype: 'success', is_error: false, permission_denials: [],
      result: "I'll wait for both background agents to complete before continuing."
    },
    aeusserungen: [{ login: 'claude[bot]', zeit: '2026-09-09T06:41:00Z', commit: kopf(ABBRUCH_LAUF) }],
    gepostet: geliefert()
  });
  assert.equal(urteil.ausgang, 'stumm');
  assert.equal(urteil.grund, 'agenten');
});

test('eine belegte Lieferung schlaegt eine harmlose Verweigerung', () => {
  // Die saubere Review hat KEINEN gebundenen Beleg - nur die Zusammenfassung.
  // Stuende die Sperrpruefung vor der Lieferung, waere jeder saubere PR mit
  // einer belanglosen verweigerten Abfrage rot. Das ist nicht hypothetisch: die
  // echte Review an #1066 verweigerte vier `gh api`-Aufrufe auf ein CLAUDE.md.
  const urteil = beurteile({
    seit: seit(SAUBER),
    kopf: kopf(SAUBER),
    ergebnis: { ...fixture.ergebnisse['saubere-review'], permission_denials: [{ tool_name: 'Bash' }] },
    aeusserungen: wieGesehen(SAUBER),
    gepostet: geliefert()
  });
  assert.equal(urteil.ausgang, 'geprueft');
  assert.equal(urteil.grund, 'adresse');
});

test('eine VERNEINTE Abbruchbehauptung faerbt eine gueltige Review nicht rot', () => {
  // Modellprosa verneint: "Claude has not already commented on this PR."
  // Ohne Verneinungspruefung trug dieser Satz den Abbruchgrund.
  const urteil = beurteile({
    seit: seit(SAUBER),
    kopf: kopf(SAUBER),
    ergebnis: {
      num_turns: 14, subtype: 'success', is_error: false, permission_denials: [],
      result: 'Claude has not already commented on this PR. Review posted.'
    },
    aeusserungen: wieGesehen(SAUBER),
    gepostet: geliefert()
  });
  assert.equal(urteil.ausgang, 'geprueft');
});

test('der echte Abbruchtext bleibt trotz Verneinungspruefung erkannt', () => {
  // Die Gegenrichtung: das geschaerfte Muster darf den Fall nicht verlieren,
  // fuer den es gebaut ist.
  assert.equal(bejaht(ABBRUCH.result, /already\s+(?:left\s+a\s+comment|commented|posted|reviewed)/i), true);
  assert.equal(
    bejaht('Claude has not already commented on this PR.', /already\s+commented/i),
    false
  );
});

// ---------------------------------------------------------------------------
// Der Aufruf selbst, nicht nur das Urteil.
//
// Bis zum 09.09.2026 hat NICHTS das Skript als Programm gefahren - die Proben
// oben rufen `beurteile()` direkt, die Workflow-Suite liest nur Text. Genau
// dazwischen fiel der schwerste Fehler dieses Zweigs durch: der Einstieg hing
// am Dateinamen (`endsWith('review-verdict.mjs')`), und der Workflow laedt die
// vertrauenswuerdige Fassung als `review-verdict-basis.mjs` herunter. Das Modul
// lud seine Deklarationen, rief nie `main()` und endete mit 0 - der Waechter
// gegen stilles Gruen war selbst still gruen.
// ---------------------------------------------------------------------------

const SKRIPT = fileURLToPath(new URL('../.github/scripts/review-verdict.mjs', import.meta.url));

/** Faehrt das Skript als Programm, unter einem frei waehlbaren Dateinamen. */
function fahre(dateiname, { ergebnis, aeusserungen = [], seit = '2026-09-09T06:40:37Z', kopf = 'abc' }) {
  const ordner = mkdtempSync(join(tmpdir(), 'review-proof-'));
  const ziel = join(ordner, dateiname);
  copyFileSync(SKRIPT, ziel);
  const strom = join(ordner, 'exec.json');
  writeFileSync(strom, JSON.stringify(ergebnis));
  const liste = join(ordner, 'aeusserungen.jsonl');
  writeFileSync(liste, aeusserungen.map((a) => JSON.stringify(a)).join('\n'));
  return spawnSync(process.execPath, [
    ziel, '--seit', seit, '--kopf', kopf, '--ergebnis', strom, '--aeusserungen', liste
  ], { encoding: 'utf8' });
}

const ABBRUCH_STROM = [{ ...fixture.ergebnisse['abbruch-schon-kommentiert'], type: 'result' }];
const GELIEFERT_STROM = [
  ...fixture.strom.gepostet,
  { ...fixture.ergebnisse['saubere-review'], type: 'result' }
];
const NEUE_ZUSAMMENFASSUNG = {
  login: 'claude[bot]', zeit: '2026-09-09T06:41:00Z', commit: null, anker: 'issuecomment-5596556584'
};

test('DAS SKRIPT URTEILT AUCH UNTER FREMDEM DATEINAMEN', () => {
  // Der Workflow kopiert es als `review-verdict-basis.mjs` - der Name endet
  // also nicht auf den erwarteten. Haengt der Einstieg am Namen, laeuft hier
  // gar nichts, und Exit 0 heisst dann "kein Befund" statt "nicht geprueft".
  const lauf = fahre('review-verdict-basis.mjs', { ergebnis: ABBRUCH_STROM });
  assert.equal(lauf.status, 1, `Exit 0 heisst hier: main() lief nicht.\n${lauf.stdout}`);
  assert.match(lauf.stdout, /UNGEPRUEFT/);
  assert.match(lauf.stdout, /::error::/);
});

test('und unter einem beliebigen anderen Namen genauso', () => {
  // Nicht die eine Ausnahme nachbauen, sondern die Regel: der Name ist egal.
  const lauf = fahre('irgendwas.mjs', { ergebnis: ABBRUCH_STROM });
  assert.equal(lauf.status, 1);
});

test('ein gelieferter Lauf endet als Programm mit 0', () => {
  // Die Gegenrichtung, damit die Probe nicht nur "faellt immer" beweist.
  const lauf = fahre('review-verdict-basis.mjs', {
    ergebnis: GELIEFERT_STROM,
    aeusserungen: [NEUE_ZUSAMMENFASSUNG]
  });
  assert.equal(lauf.status, 0, lauf.stdout + lauf.stderr);
  assert.match(lauf.stdout, /Belegte Lieferungen dieses Laufs: 1 \(Adressen in seinem Strom: 1\)/);
});

test('ohne `anker` in den Listen wird derselbe Lauf als Programm nicht gruen', () => {
  // Die Adressen kommen aus dem Workflow. Fehlen sie - ein Workflow, der aelter
  // ist als dieses Modul -, darf die Lieferung nicht aus dem Nichts belegt sein.
  // Rot, nicht gruen; die Diagnose schickt zum `anker`.
  const { anker, ...ohneAnker } = NEUE_ZUSAMMENFASSUNG;
  const lauf = fahre('review-verdict-basis.mjs', {
    ergebnis: GELIEFERT_STROM,
    aeusserungen: [ohneAnker]
  });
  assert.equal(lauf.status, 1, lauf.stdout);
  assert.match(lauf.stdout, /Belegte Lieferungen dieses Laufs: 0 \(Adressen in seinem Strom: 1\)/);
  assert.match(lauf.stdout, /`anker`/);
});

/* ===================================================================
 * DER ZWEITE PUSH AN #1094 (Lauf 34410944562, 09.09.2026)
 *
 * Der Fall, den #1073 nachweisen wollte und der in #1076/#1078 mangels
 * zweitem Push ungeprueft blieb. Er sah aus wie der Abbruch aus #1066 -
 * derselbe rote Haken, dieselbe Diagnose `schon-kommentiert` - und war
 * dessen Gegenteil: die Review lief 29 Turns lang vollstaendig durch und
 * postete issuecomment-5609521451. Der Nachweis verwarf dabei seinen
 * eigenen Beleg und meldete "0 von 3 Postbefehlen".
 * =================================================================== */

const LAUF_1094 = fixture.ergebnisse['gehorsam-erwaehnt-abbruch'];
const SEIT_1094 = fixture.quelle_1094.seit;
const KOPF_1094 = fixture.quelle_1094.kopf;
const GESEHEN_1094 = fixture.quelle_1094.aeusserungen;
const LIEFERUNG_1094 = 'issuecomment-5609521451';

test('der mehrzeilige Postbefehl aus #1094 ist ein Beleg, ohne dass jemand seine Zeilen liest', () => {
  // Der echte Befehl aus dem Job-Log, zeichengleich: mehrzeilig, weil ein
  // Review-Kommentar Absaetze hat. Die Befehlstext-Pruefung hielt den Absatz
  // fuer einen zweiten Befehl. Die Adresse fragt nicht danach.
  const strom = fixture.strom.gepostet_mehrzeilig;
  const befehl = strom[0].message.content[0].input.command;
  assert.match(befehl, /^gh pr comment 1094 /, 'die Fixture traegt den echten Befehl');
  assert.ok(befehl.includes('\n'), 'und der ist wirklich mehrzeilig');
  assert.ok(GESEHEN_1094.some((a) => a.anker === LIEFERUNG_1094 && a.zeit > SEIT_1094),
    'die API kennt die Adresse als claude-Aeusserung nach dem Laufbeginn');

  assert.deepEqual(zaehleBelege(strom, GESEHEN_1094, SEIT_1094), { adressen: 1, erfolge: 1 },
    'der Beleg des Laufs darf nicht an seinen eigenen Absaetzen scheitern');
});

test('ein Lauf, der nur liest, bekommt nur Adressen zurueck, die es schon gab (#1094)', () => {
  // Die gefaehrliche Haelfte der Befehlstext-Pruefung: die Antwort eines GET
  // auf `/comments` traegt die `html_url` BESTEHENDER Kommentare. Mit den
  // ECHTEN claude-Adressen, die an #1094 vor diesem Lauf entstanden sind, und
  // in der angeklebten Form `-XGET`, an der die letzte Fassung scheiterte.
  assert.deepEqual(zaehleBelege(fixture.strom.nur_gelesen, GESEHEN_1094, SEIT_1094),
    { adressen: 1, erfolge: 0 }, 'die gelesene Adresse kennt die API nicht als neu');

  const alt = GESEHEN_1094
    .filter((a) => a.login.includes('claude') && a.zeit < SEIT_1094)
    .map((a) => ({ html_url: `https://github.com/ulsklyc/yuvomi/pull/1094#${a.anker}` }));
  assert.equal(alt.length, 4, 'zwei Reviews und zwei Inline-Anmerkungen von claude lagen vor dem Lauf');
  const lesen = stromMit('gh api repos/ulsklyc/yuvomi/pulls/1094/reviews -XGET -f per_page=100', JSON.stringify(alt));
  assert.deepEqual(zaehleBelege(lesen, GESEHEN_1094, SEIT_1094), { adressen: 4, erfolge: 0 });
});

test('EIN LAUF, DER NUR LIEST, WIRD NICHT GRUEN (#1094)', () => {
  // Dieselbe Lage im Urteil: ohne die eigene Zusammenfassung stehen nur alte
  // Aeusserungen in den Listen, und der Strom traegt nur gelesene Adressen.
  const ohneLieferung = GESEHEN_1094.filter((a) => a.anker !== LIEFERUNG_1094);
  const urteil = beurteile({
    seit: SEIT_1094,
    kopf: KOPF_1094,
    ergebnis: { result: 'Ich habe die vorhandenen Kommentare gelesen.', subtype: 'success',
      is_error: false, num_turns: 3, permission_denials: [] },
    aeusserungen: ohneLieferung,
    gepostet: zaehleBelege(fixture.strom.nur_gelesen, ohneLieferung, SEIT_1094)
  });
  assert.equal(urteil.ausgang, 'stumm', 'Lesen ist kein Liefern');
});

test('die ERWAEHNUNG der Abbruchbedingung ist kein Abbruch (#1094)', () => {
  // Der result-Text des Laufs, zeichengleich aus dem Job-Log. Er ZITIERT die
  // Bedingung genau deshalb, weil der Prompt sie aufhebt und der Lauf das brav
  // berichtet: 'telling me to disregard the normal "already commented" stop
  // condition ... so proceeding was legitimate'. Je genauer die Anweisung
  // befolgt wurde, desto sicherer schlug der Waechter an.
  const text = String(LAUF_1094.result);
  assert.match(text, /"already commented" stop condition/,
    'die Fixture traegt den echten Wortlaut - das ZITAT der Bedingung');
  assert.match(text, /Review complete/, 'und derselbe Text sagt, dass geprueft wurde');

  const urteil = beurteile({
    seit: SEIT_1094,
    kopf: KOPF_1094,
    ergebnis: LAUF_1094,
    aeusserungen: GESEHEN_1094,
    gepostet: zaehleBelege(fixture.strom.gepostet_mehrzeilig, GESEHEN_1094, SEIT_1094)
  });
  assert.equal(urteil.ausgang, 'geprueft', urteil.meldung);
  assert.equal(urteil.grund, 'adresse');
});

test('der ECHTE Abbruch aus #1066 bleibt davon unberuehrt', () => {
  // Die Gegenrichtung, ohne die der Fix nur "faerbt alles gruen" hiesse.
  // Dieser Text sagt beides: schon kommentiert UND "I should stop here".
  const abbruch = fixture.ergebnisse['abbruch-schon-kommentiert'];
  assert.match(String(abbruch.result), /stop here/i, 'der echte Abbruch sagt, dass er aufhoert');

  const urteil = beurteile({
    seit: seit(ABBRUCH_LAUF),
    kopf: kopf(ABBRUCH_LAUF),
    ergebnis: abbruch,
    aeusserungen: alleAeusserungen,
    gepostet: NICHTS
  });
  assert.equal(urteil.ausgang, 'stumm');
  assert.equal(urteil.grund, 'schon-kommentiert');
});

test('erwaehnt und NICHT geliefert: die Diagnose muss die richtige sein (#1094)', () => {
  // Derselbe result-Text, aber nichts geliefert - der Lauf hatte 14
  // Verweigerungen, und ohne die geglueckte Lieferung waere das Abliefern
  // daran gescheitert (das Muster aus #708). Rot ist das in jedem Fall. Die
  // Frage ist, WOHIN die Meldung den Leser schickt: "im Tor abgebrochen, der
  // Prompt greift nicht mehr" ist eine andere Baustelle als "hat geprueft, kam
  // nicht zum Posten".
  const urteil = beurteile({
    seit: SEIT_1094,
    kopf: KOPF_1094,
    ergebnis: LAUF_1094,
    aeusserungen: [],
    gepostet: { adressen: 1, erfolge: 0 }
  });
  assert.equal(urteil.ausgang, 'stumm', 'ohne Lieferung bleibt es rot');
  assert.equal(urteil.grund, 'werkzeugsperre',
    'die 14 Verweigerungen sind der Grund - nicht ein Abbruch, den es nie gab');
  assert.doesNotMatch(urteil.meldung, /IM TOR ABGEBROCHEN/,
    'ein Lauf, der 29 Turns lang geprueft hat, hat nicht im Tor abgebrochen');
});

test('SCHON KOMMENTIERT SCHLAEGT TRIVIAL AUCH OHNE AUFHOER-SATZ (#1096)', () => {
  // Der `HOERT_AUF`-Zusatz hatte den trivialen Zweig zur Hintertuer gemacht:
  // dieser Text nennt beides, aber keine der Aufhoer-Formeln - "stop CONDITION"
  // ist keine. Er rutschte an `schon-kommentiert` vorbei und wurde im trivialen
  // Zweig gruen, fuer einen Lauf, der woertlich sagt, er habe den PR schon
  // geprueft.
  const urteil = beurteile({
    seit: seit(ABBRUCH_LAUF),
    kopf: kopf(ABBRUCH_LAUF),
    ergebnis: {
      num_turns: 3, subtype: 'success', is_error: false, permission_denials: [],
      result:
        'This matches the step 1 stop condition - Claude has already reviewed ' +
        'this PR, and the remaining diff is a trivial change that is obviously ' +
        'correct.'
    },
    aeusserungen: [],
    gepostet: NICHTS
  });
  assert.notEqual(urteil.ausgang, 'ausgesetzt',
    'die gefaehrlichere Lesart gewinnt, egal wie das Aufhoeren formuliert ist');
  assert.equal(urteil.ausgang, 'stumm');
  // Bewusst `unbekannt` und nicht `schon-kommentiert`: ohne Aufhoer-Satz weiss
  // dieses Modul nicht, ob abgebrochen wurde, und behauptet es nicht.
  assert.equal(urteil.grund, 'unbekannt');
  assert.doesNotMatch(urteil.meldung, /IM TOR ABGEBROCHEN/,
    'was nicht belegt ist, wird nicht behauptet');
});

/* ===================================================================
 * DRITTE RUNDE (Review zu #1096): DER BELEG VERLAESST DEN BEFEHLSTEXT
 *
 * Codex und claude[bot] fanden sechs weitere Stellen, zwei davon machten
 * einen ungeprueften Push gruen. Alle sechs lagen in der Klassifikation der
 * Befehlszeile, und drei Runden lang hatte jede Reparatur dort die naechste
 * Luecke eingebaut. Statt einer vierten Regex-Runde fragt der Nachweis jetzt
 * nach einer Tatsache: steht die Adresse im Strom, und kennt die API sie als
 * claude-Aeusserung nach dem Laufbeginn?
 * =================================================================== */

const PROBE_SEIT = '2026-09-10T08:00:00Z';
const PROBE_LISTE = [
  // vor dem Lauf von claude angelegt
  { login: 'claude[bot]', zeit: '2026-09-10T07:59:59Z', commit: null, anker: 'issuecomment-100' },
  // waehrend des Laufs von claude angelegt
  { login: 'claude[bot]', zeit: '2026-09-10T08:05:00Z', commit: null, anker: 'issuecomment-200' },
  // waehrend des Laufs von einer fremden Stimme angelegt
  { login: 'chatgpt-codex-connector[bot]', zeit: '2026-09-10T08:05:00Z', commit: null, anker: 'issuecomment-300' }
];
const url = (n) => `https://github.com/ulsklyc/yuvomi/pull/1096#issuecomment-${n}`;

/** Jede Befehlsform, an der die Pruefung auf dem Befehlstext gescheitert ist. */
const BEFEHLSFORMEN = [
  ['einfach quotierter Body mit Backticks (Codex P2, claude[bot])',
    "gh pr comment 1096 --body 'Please preserve `foo`.'"],
  ['quotierter Endpunkt mit Feld (Codex P2)',
    'gh api "repos/ulsklyc/yuvomi/issues/1096/comments" -f body=hello'],
  ['angeklebtes -XGET mit Feld (Codex P1, claude[bot])',
    'gh api repos/ulsklyc/yuvomi/issues/1096/comments -XGET -f per_page=5'],
  ['unquotiertes Heredoc mit Substitution (claude[bot])',
    'gh pr comment 1096 --body "$(cat <<EOF\n$(echo ADRESSE >&2; true)\nEOF\n)" --help'],
  ['Kette mit --help (#1085)',
    "gh pr comment --help; gh pr view 1096 --json comments --jq '.comments[-1].url'"],
  ['mehrzeiliger Body (#1094)',
    'gh pr comment 1096 --body "## Code review\n\nNo issues found."']
];

test('WIE DER BEFEHL GESCHRIEBEN IST, ENTSCHEIDET NICHTS MEHR (#1096, dritte Runde)', () => {
  for (const [form, befehl] of BEFEHLSFORMEN) {
    assert.deepEqual(zaehleBelege(stromMit(befehl, url(100)), PROBE_LISTE, PROBE_SEIT),
      { adressen: 1, erfolge: 0 }, `${form}: eine ALTE claude-Adresse belegt nichts`);
    assert.deepEqual(zaehleBelege(stromMit(befehl, url(300)), PROBE_LISTE, PROBE_SEIT),
      { adressen: 1, erfolge: 0 }, `${form}: eine FREMDE neue Adresse belegt nichts`);
    assert.deepEqual(zaehleBelege(stromMit(befehl, url(200)), PROBE_LISTE, PROBE_SEIT),
      { adressen: 1, erfolge: 1 }, `${form}: eine NEUE claude-Adresse belegt die Lieferung`);
  }
});

test('eine Adresse in der BEFEHLSZEILE ist kein Beleg', () => {
  // Wer eine Adresse in seinen Befehl schreibt, hat damit nichts angelegt.
  // Gelesen wird nur, was zurueckkam.
  const strom = stromMit(`gh pr comment 1096 --body "siehe ${url(200)}"`, 'gh: Not Found (HTTP 404)');
  assert.equal(adressenImStrom(strom).size, 0);
  assert.deepEqual(zaehleBelege(strom, PROBE_LISTE, PROBE_SEIT), NICHTS);
});

test('die API muss die Adresse kennen: eine erfundene zaehlt nicht, eine Liste ohne `anker` belegt nichts', () => {
  assert.deepEqual(zaehleBelege(stromMit('gh pr comment 1096 --body x', url(999)), PROBE_LISTE, PROBE_SEIT),
    { adressen: 1, erfolge: 0 }, 'eine Adresse, die es laut API nicht gibt');
  const ohneAnker = PROBE_LISTE.map(({ anker, ...rest }) => rest);
  assert.deepEqual(zaehleBelege(stromMit('gh pr comment 1096 --body x', url(200)), ohneAnker, PROBE_SEIT),
    { adressen: 1, erfolge: 0 }, 'ohne `anker` kein Abgleich - und damit kein Gruen aus dem Nichts');
});

test('jede Adresse zaehlt einmal, und eine alte neben einer neuen bleibt alt', () => {
  const strom = [
    ...stromMit('gh pr comment 1096 --body x', url(200)),
    { type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'toolu_zwei', is_error: false,
        content: [{ type: 'text', text: JSON.stringify([{ html_url: url(100) }, { html_url: url(200) }]) }] }
    ] } }
  ];
  assert.deepEqual(zaehleBelege(strom, PROBE_LISTE, PROBE_SEIT), { adressen: 2, erfolge: 1 });
});

test('eine Aeusserung GENAU zum Laufbeginn gilt nicht als neu', () => {
  const liste = [{ login: 'claude[bot]', zeit: PROBE_SEIT, commit: null, anker: 'issuecomment-400' }];
  assert.equal(zaehleBelege(stromMit('gh pr comment 1096 --body x', url(400)), liste, PROBE_SEIT).erfolge, 0);
});

test('ohne gueltigen Laufbeginn gibt es keinen Beleg', () => {
  for (const kaputt of ['', undefined, '2026-09-10', '2026-09-10T08:00:00+00:00']) {
    assert.equal(zaehleBelege(stromMit('gh pr comment 1096 --body x', url(200)), PROBE_LISTE, kaputt).erfolge, 0,
      `Laufbeginn ${JSON.stringify(kaputt)}`);
  }
});

test('ein VERNEINTES Aufhoeren ist kein Abbruch im Tor (#1096, Codex P2)', () => {
  // "I did not stop here" traf das Aufhoer-Muster, obwohl es das Gegenteil
  // sagt. Ein Lauf, der den neuen Stand geprueft hat und am Posten scheiterte,
  // wurde damit als Abbruch im Tor gemeldet - dieselbe falsche Richtung, gegen
  // die dieser PR angetreten ist.
  const urteil = beurteile({
    seit: SEIT_1094,
    kopf: KOPF_1094,
    ergebnis: {
      num_turns: 22, subtype: 'success', is_error: false, permission_denials: [{ tool_name: 'Bash' }],
      result: 'Claude has already reviewed older commits, but not this HEAD. I did not stop here.'
    },
    aeusserungen: [],
    gepostet: NICHTS
  });
  assert.equal(urteil.ausgang, 'stumm');
  assert.equal(urteil.grund, 'werkzeugsperre',
    'die Sperre ist der Grund, nicht ein Abbruch, den der Text verneint');
  assert.doesNotMatch(urteil.meldung, /IM TOR ABGEBROCHEN/);
});

test('ein Aufhoeren, das SELBST verneint, bleibt ein Abbruch (#1096, Codex nach Runde 3)', () => {
  // "I will not proceed" und "No review is needed" tragen ihr "not"/"no" im
  // eigenen Wortlaut. Die dritte Runde pruefte das Aufhoeren ueber `bejaht`, und
  // dessen Fenster schliesst den Treffer ein: ein echter Abbruch landete bei
  // `unbekannt`. Die Reparatur der Verneinung hatte die naechste Luecke gebaut.
  for (const result of [
    'Claude has already commented on this PR, so I will not proceed.',
    'Claude has already commented on this PR. No review is needed.',
    // Das "No" des zitierten Befunds steht im Satz DAVOR und gehoert nicht zum Aufhoeren.
    'Claude has already left a comment on this PR (a "No issues found" review). No review is needed.'
  ]) {
    const urteil = beurteile({
      seit: seit(ABBRUCH_LAUF),
      kopf: kopf(ABBRUCH_LAUF),
      ergebnis: { num_turns: 3, subtype: 'success', is_error: false, permission_denials: [], result },
      aeusserungen: [],
      gepostet: NICHTS
    });
    assert.equal(urteil.grund, 'schon-kommentiert', result);
  }

  // Die Gegenrichtung: doppelt verneint heisst weitermachen, und die Sperre
  // bleibt der Grund.
  const weiter = beurteile({
    seit: seit(ABBRUCH_LAUF),
    kopf: kopf(ABBRUCH_LAUF),
    ergebnis: {
      num_turns: 20, subtype: 'success', is_error: false, permission_denials: [{ tool_name: 'Bash' }],
      result: 'Claude has already reviewed older commits. I did not want to not proceed, so the review continued.'
    },
    aeusserungen: [],
    gepostet: NICHTS
  });
  assert.equal(weiter.grund, 'werkzeugsperre');
});

test('eine VERNEINTE erste Erwaehnung oeffnet die Gruen-Ausnahme nicht (#1096, Codex P1 nach 8dc12582)', () => {
  // `bejaht` sieht nur den ersten Treffer. Verneint im ersten Satz, bejaht im
  // zweiten, dazu "trivial" und die Tor-Formel: das wurde GRUEN, fuer einen
  // Lauf, der sagt, dass er den PR schon kommentiert hat. Fuer den einzigen
  // stillen Gruen-Pfad gilt deshalb: jede Erwaehnung sperrt ihn.
  const urteil = beurteile({
    seit: seit(ABBRUCH_LAUF),
    kopf: kopf(ABBRUCH_LAUF),
    ergebnis: {
      num_turns: 3, subtype: 'success', is_error: false, permission_denials: [],
      result:
        'Claude has not already reviewed the new HEAD. Claude has already commented on this PR, ' +
        'and the remaining diff is a trivial change that is obviously correct, so this matches ' +
        'the step 1 stop condition.'
    },
    aeusserungen: [],
    gepostet: NICHTS
  });
  assert.notEqual(urteil.ausgang, 'ausgesetzt',
    'eine Erwaehnung von "schon kommentiert" oeffnet den stillen Gruen-Pfad nie');
  assert.equal(urteil.ausgang, 'stumm');
});

test('ein spaeteres bejahtes Aufhoeren zaehlt auch nach einem verneinten (#1096, Codex P2 nach 8dc12582)', () => {
  // Der erste Treffer ist verneint, der zweite nicht. Nur den ersten zu lesen
  // schickte den Leser zu `unbekannt`, obwohl der Lauf im Tor aufgehoert hat.
  const urteil = beurteile({
    seit: seit(ABBRUCH_LAUF),
    kopf: kopf(ABBRUCH_LAUF),
    ergebnis: {
      num_turns: 4, subtype: 'success', is_error: false, permission_denials: [],
      result:
        'I did not stop here at the first check. Claude has already left a comment on this PR, ' +
        'so I should stop here.'
    },
    aeusserungen: [],
    gepostet: NICHTS
  });
  assert.equal(urteil.grund, 'schon-kommentiert');
});

test('eine spaetere bejahte Erwaehnung zaehlt auch nach einer verneinten (#1101)', () => {
  // Dieselbe Luecke wie beim Aufhoeren, eine Bedingung weiter vorn: `bejaht`
  // sah nur die ERSTE Erwaehnung von "schon geprueft". Verneint im ersten Satz,
  // bejaht im zweiten, und der Lauf hat aufgehoert - die Diagnose lautete
  // trotzdem `unbekannt` und schickte den Leser zum fehlenden `--comment` statt
  // zum Tor, das den Lauf angehalten hat. Rot war der Haken in beiden Faellen.
  const urteil = beurteile({
    seit: seit(ABBRUCH_LAUF),
    kopf: kopf(ABBRUCH_LAUF),
    ergebnis: {
      num_turns: 4, subtype: 'success', is_error: false, permission_denials: [],
      result: 'Claude has not already reviewed this HEAD. Claude has already reviewed this PR, so I should stop here.'
    },
    aeusserungen: [],
    gepostet: NICHTS
  });
  assert.equal(urteil.grund, 'schon-kommentiert');
});

test('bejahtIrgendwo liest jede Erwaehnung, bejaht weiter nur die erste (#1101)', () => {
  const muster = /already\s+(?:left\s+a\s+comment|commented|posted|reviewed)/i;
  const gemischt = 'Claude has not already reviewed this HEAD. Claude has already reviewed this PR.';
  assert.equal(bejahtIrgendwo(gemischt, muster), true);
  // Die Tor-Ausnahme, die GRUEN machen kann, prueft weiter ueber `bejaht`: dort
  // bleibt die engere Lesart die sichere Richtung.
  assert.equal(bejaht(gemischt, muster), false);
  assert.equal(bejahtIrgendwo('Claude has not already commented. It has never already posted.', muster), false);
  assert.equal(bejahtIrgendwo('', muster), false);
  assert.equal(bejahtIrgendwo(undefined, muster), false);
  // Das Fenster endet am Satzende davor (Codex zu #1121): ein kurzer verneinter
  // Satz lag sonst noch in den 30 Zeichen vor der naechsten Erwaehnung.
  assert.equal(bejahtIrgendwo('Claude has not already reviewed. Has already reviewed, so I should stop here.', muster), true);
});

test('ein kurzer verneinter Satz verneint die naechste Erwaehnung nicht mit (#1121, Codex P2)', () => {
  const urteil = beurteile({
    seit: seit(ABBRUCH_LAUF),
    kopf: kopf(ABBRUCH_LAUF),
    ergebnis: {
      num_turns: 4, subtype: 'success', is_error: false, permission_denials: [],
      result: 'Claude has not already reviewed. Has already reviewed, so I should stop here.'
    },
    aeusserungen: [],
    gepostet: NICHTS
  });
  assert.equal(urteil.grund, 'schon-kommentiert');
});
