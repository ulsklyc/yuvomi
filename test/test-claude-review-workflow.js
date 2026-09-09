/**
 * Modul: Review-Workflow-Guard
 * Zweck: Die Bedingungen, ohne die `claude-review` durchlaeuft und nichts
 *        hinterlaesst, stehen fest im Workflow. Jede davon hat schon einmal
 *        mehrere Anlaeufe gekostet, und keine faellt beim Lesen der Datei auf.
 *        Seit dem 09.09.2026 kommt die Frage dazu, zu WELCHEM Stand die Review
 *        gesprochen hat - das Urteil darueber faellt
 *        `.github/scripts/review-verdict.mjs` und haengt in `test:review-proof`.
 * Ausfuehren: npm run test:claude-review-workflow
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';

const workflow = readFileSync(
  new URL('../.github/workflows/claude-code-review.yml', import.meta.url),
  'utf8'
);

test('der Prompt traegt --comment, sonst prueft die Review und schweigt', () => {
  // Die Plugin-Anleitung: "If `--comment` argument was NOT provided, stop here.
  // Do not post any GitHub comments." Ohne das Flag sieht ein vollstaendiger
  // Lauf einer Sperre zum Verwechseln aehnlich.
  assert.match(workflow, /\/code-review:code-review[^\n]*--comment/);
});

test('die Subagenten laufen synchron', () => {
  // #865, 2026-08-25: viermal hintereinander nichts hinterlassen. Das Plugin
  // startet seine Agenten asynchron, und die Benachrichtigung ueber einen
  // fertigen Agenten trifft in einem CI-Lauf auf keinen Turn mehr - die
  // Hauptsession sagt "ich warte" und ist damit fertig. Reruns halfen nicht,
  // weil die Ursache strukturell ist und nicht sprunghaft.
  assert.match(workflow, /run_in_background:\s*false/,
    'die Anweisung, Subagenten synchron zu fahren, fehlt im Prompt');
});

test('Skill und Task stehen in den erlaubten Werkzeugen', () => {
  // `--allowed-tools` ERSETZT die Liste des Plugins. Ohne `Skill` kann die
  // Review ihr eigenes Kommando nicht ausfuehren, ohne `Task` keinen einzigen
  // ihrer Agenten starten - und dann improvisiert das Modell die Pruefung.
  const tools = workflow.match(/--allowed-tools\s*\n?\s*"([^"]+)"/)?.[1] ?? '';
  assert.ok(tools.includes('Skill'), '`Skill` fehlt - das Plugin-Kommando ist dann gesperrt');
  assert.ok(tools.includes('Task'), '`Task` fehlt - die Subagenten sind dann gesperrt');
  assert.ok(tools.includes('Bash(gh pr comment:*)'), 'ohne diesen Weg kann sie ihr Ergebnis nicht abliefern');
});

test('der Job darf schreiben, sonst kommt die Review nicht zu Wort', () => {
  assert.match(workflow, /pull-requests:\s*write/);
});

test('der Nachweis-Schritt prueft die Wirkung, nicht den Ablauf', () => {
  // Ein gruener Haken fuer eine Pruefung, die nie stattgefunden hat, ist
  // schlimmer als gar keiner: er laedt dazu ein, sich auf ihn zu verlassen.
  assert.match(workflow, /Die Review muss gesprochen haben/);
  assert.match(workflow, /node \.github\/scripts\/review-verdict\.mjs/);
});

test('das Urteil liegt ausserhalb des Workflows und ist damit gegenprobierbar', () => {
  // Eine Urteilslogik, die nur in einem YAML-Schritt lebt, laesst sich nicht
  // gegen echte Nutzdaten fahren - und ein Waechter, der gruen bleibt, wenn er
  // rot sein muesste, ist genau die Klasse, um die es hier geht.
  assert.ok(
    existsSync(new URL('../.github/scripts/review-verdict.mjs', import.meta.url)),
    'der Nachweis ruft ein Skript auf, das es nicht gibt'
  );
  assert.match(workflow, /--seit "\$SEIT"/);
  assert.match(workflow, /--ergebnis "\$EXECUTION_FILE"/);
});

test('der Nachweis zaehlt nicht mehr ueber die Lebensdauer des PR', () => {
  // DAS WAR DER BLINDE FLECK (#1066, 09.09.2026): drei Zaehler ueber die ganze
  // Lebensdauer addieren und nur bei Summe null rot werden. Weil das Plugin
  // abbricht, SOBALD ein claude-Kommentar am PR steht, faerbte genau dieser
  // Kommentar danach jeden Abbruch gruen. Drei Pushes gingen so durch.
  assert.doesNotMatch(workflow, /issue \+ review \+ inline/);
  assert.doesNotMatch(workflow, /-eq 0/);
});

test('gemessen wird gegen den Laufbeginn, nicht gegen die Commit-Zeit', () => {
  // DIE COMMIT-ZEIT WAERE DIE NAHELIEGENDE UND FALSCHE WAHL: ein Commit entsteht
  // oft lange vor seinem Push. Wer B um 10:02 committet, um 10:08 die Review zu
  // A bekommt und B erst um 10:09 pusht, haette einen Kommentar von 10:08
  // "nach" B liegen - und der Nachweis haette B fuer geprueft gehalten. Das
  // waere derselbe blinde Fleck in neuer Form.
  assert.match(workflow, /^\s+id: stand$/m);
  assert.match(workflow, /seit=\$\(date -u \+%Y-%m-%dT%H:%M:%SZ\)/);
  assert.doesNotMatch(workflow, /committer\.date/);
  assert.match(workflow, /SEIT: \$\{\{ steps\.stand\.outputs\.seit \}\}/);
});

test('der Prompt hebt die Abbruchbedingung auf, sonst prueft nur der erste Push', () => {
  // Ohne diesen Absatz bricht das Plugin ab dem zweiten Push zugesichert ab,
  // dann waere ein Nachweis, der pro Push zaehlt, dauerhaft rot. Die Aufhebung
  // und die engere Zaehlung gehoeren zusammen; eine allein ist ein anderer
  // blinder Fleck.
  assert.match(workflow, /ABBRUCHBEDINGUNG[^\n]*GILT\s*\n\s*HIER NICHT/);
  assert.match(workflow, /github\.event\.pull_request\.head\.sha/);
});

test('ein Lauf je PR, und zwar der zum neuesten Stand', () => {
  // Seit jeder Push wirklich geprueft wird, stehen sonst mehrere echte Laeufe
  // gleichzeitig in der Luft. An #1066 lieferte einer nach 16m55s seinen Befund
  // zu einem Commit, der da schon zwei Pushes alt war.
  assert.match(workflow, /^concurrency:$/m);
  assert.match(workflow, /cancel-in-progress: true/);
});

test('der Selbst-Uebersprung wird an Zeichengleichheit erkannt', () => {
  // Die Action vergleicht den Inhalt dieser Datei gegen den Default-Branch und
  // ueberspringt sich bei Abweichung - mit outcome=success, also demselben
  // stillen Gruen, das der Nachweis aufdeckt. ZWEI Faelle fallen darunter: ein
  // PR, der die Datei aendert, UND ein Branch, der sie nicht anfasst, aber
  // aelter ist als ihre letzte Aenderung. Nach jedem Zug hier ist das
  // schlagartig jeder offene Branch. Die alte Probe las die Dateiliste des PR
  // und kannte nur den ersten Fall; der zweite waere rot geworden, ohne dass
  // jemand etwas falsch gemacht hat.
  assert.match(workflow, /contents\/\$DATEI\?ref=\$HEAD_SHA/);
  assert.match(workflow, /contents\/\$DATEI\?ref=\$BASIS/);
  assert.match(workflow, /\[ "\$kopf" = "\$basis" \]/);
});

test('die Selbst-Uebersprung-Ausnahme schliesst zu', () => {
  // Ein Ersatzwert bei fehlgeschlagenem Lookup waere bequem und genau falsch
  // herum: zwei ungleiche Platzhalter haetten `self=true` gesetzt, den Nachweis
  // ausgesetzt und den Job gruen gelassen - wegen eines 403 oder 5xx in einer
  // DIAGNOSE-Abfrage. Wer nicht beweisen kann, dass er ausgenommen ist, ist
  // nicht ausgenommen.
  assert.doesNotMatch(workflow, /kopf="fehlt-im-pr"/);
  assert.doesNotMatch(workflow, /basis="fehlt-in-basis"/);
  assert.match(workflow, /if \[ -z "\$kopf" \] \|\| \[ -z "\$basis" \]; then\n\s*echo "self=false"/);
});

test('kein Rerun-Kurzschluss: die Review laeuft bei jedem Anlass', () => {
  // Hier stand eine Abkuerzung: haengt am Head schon eine claude-Aeusserung,
  // spare die Review. Ein Lauf, der EINE Inline-Anmerkung gepostet hat und dann
  // in den Timeout lief, haette damit den ganzen Commit als geprueft gegolten -
  // der Rerun uebersprungen, der Nachweis mit ihm (`outcome: skipped`), und der
  // Haken gruen ueber einer abgebrochenen Pruefung. Ein Rerun kostet jetzt eine
  // zweite Review; das ist der billigere Fehler.
  assert.doesNotMatch(workflow, /steps\.stand\.outputs\.geprueft/);
  assert.doesNotMatch(workflow, /geprueft=true/);
});

test('der Nachweis bindet Aeusserungen an die Commit-SHA', () => {
  // Ein Zeitstempel allein belegt nicht, dass eine Aeusserung aus DIESEM Lauf
  // stammt: der Mention-Pfad antwortet als derselbe Bot, und ein abgebrochener
  // Vorgaenger kann noch posten, nachdem der Nachfolger seinen Laufbeginn
  // notiert hat. Reviews und Inline-Anmerkungen tragen die SHA, eine
  // Zusammenfassung nicht - die bekommt `null`.
  assert.match(workflow, /--kopf "\$HEAD_SHA"/);
  assert.match(workflow, /commit: \.commit_id/);
  assert.match(workflow, /commit: \(\.original_commit_id \/\/ \.commit_id\)/);
  assert.match(workflow, /commit: null/);
});

test('das Urteil laeuft aus einer vertrauenswuerdigen Fassung', () => {
  // SICHERHEIT, NICHT NUR SAUBERKEIT. Hier stand `node .github/scripts/...` aus
  // dem Checkout - also Code, den der PR selbst schreibt, ausgefuehrt in einem
  // Job mit CLAUDE_CODE_OAUTH_TOKEN, einem GH_TOKEN mit Schreibrecht auf Pull
  // Requests und OIDC. Ein PR haette damit beliebiges JavaScript mit diesen
  // Rechten laufen lassen und nebenbei sein eigenes Urteil auf gruen stellen
  // koennen; die Selbst-Uebersprung-Ausnahme vergleicht nur die Workflow-Datei
  // und faengt das nicht.
  // Der Anker ist der ZEILENANFANG: der Kommentar im Workflow zitiert den alten
  // Aufruf absichtlich, und eine Probe, die blosses Vorkommen misst, waere an
  // dieser Erklaerung haengen geblieben statt an der Ausfuehrung.
  assert.doesNotMatch(workflow, /^\s*node \.github\/scripts\/review-verdict\.mjs/m);
  assert.match(workflow, /contents\/\$URTEIL\?ref=\$BASIS/);
  assert.match(workflow, /node "\$BASIS_URTEIL"/);
  // Und ohne vertrauenswuerdige Fassung gibt es kein Urteil und kein Gruen.
  assert.match(workflow, /\[ ! -s "\$BASIS_URTEIL" \]; then\n\s*echo "::error/);
});

test('show_full_output ist tragend, nicht bequem', () => {
  // Der Nachweis liest den Postbefehl aus dem Strom des Laufs - das ist der
  // einzige Beleg, der nicht auf Prosa beruht. Ohne diesen Schalter enthaelt
  // der Strom die Werkzeugbloecke nicht, und der Nachweis faellt auf den
  // schwaecheren, an die Commit-SHA gebundenen Beleg zurueck.
  // Wieder der ZEILENANFANG: ein Kommentar weiter oben nennt den Schalter im
  // Fliesstext, und eine lose Probe blieb daran gruen haengen, waehrend die
  // Einstellung selbst schon auf false stand.
  assert.match(workflow, /^\s*show_full_output:\s*true\s*$/m);
});

test('die Basis ist eine SHA und wird VOR dem Lauf abgelesen', () => {
  // Zwei Fehler in einem: der Vergleich lief erst nach den 6-17 Minuten der
  // Review, und er verglich gegen den BEWEGLICHEN Branchnamen. Wird waehrend
  // eines Laufs eine Aenderung an dieser Datei gemergt, hat die Action noch
  // gegen die ALTE Fassung validiert und gearbeitet - der spaetere Vergleich
  // saehe die neue, meldete eine Abweichung, setzte self=true und liesse den
  // Nachweis aus, obwohl der Lauf sehr wohl haette liefern muessen.
  //
  // Beides ist zu: verglichen wird gegen die unveraenderliche Basis-SHA des
  // Ereignisses, und der Schritt steht vor dem Lauf.
  const schritte = [...workflow.matchAll(/^      - name: (.+)$/gm)].map((m) => m[1]);
  assert.ok(
    schritte.indexOf('Prueft die Review-Datei sich selbst?') <
      schritte.indexOf('Run Claude Code Review'),
    'der Selbst-Uebersprung wird erst nach dem Lauf geprueft'
  );
  for (const zeile of workflow.split('\n')) {
    if (/^\s*BASIS:\s/.test(zeile)) {
      assert.match(zeile, /base\.sha/, `BASIS traegt einen beweglichen Namen: ${zeile.trim()}`);
    }
  }
});

test('Entwurf und Bot-PR sind vom Nachweis ausgenommen', () => {
  // Bei beiden bricht das Plugin zugesichert ab. Sie stehen im Workflow und
  // nicht im Urteil, weil der Workflow sie sicher weiss, waehrend das Urteil
  // sie nur aus dem result-Text raten koennte.
  assert.match(workflow, /github\.event\.pull_request\.draft != true/);
  assert.match(workflow, /github\.event\.pull_request\.user\.type != 'Bot'/);
});
