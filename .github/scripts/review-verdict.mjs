#!/usr/bin/env node
/**
 * Modul: Review-Nachweis
 * Zweck: beantwortet die EINE Frage, die ein gruener `claude-review`-Haken
 *        behauptet - wurde DIESER Stand des PR geprueft? Bis zum 09.09.2026
 *        zaehlte der Workflow claude-Kommentare ueber die ganze Lebensdauer des
 *        PR und war gruen, sobald irgendeiner existierte. An #1066 gingen so
 *        drei Pushes hintereinander ungeprueft durch (Laeufe von 1m18s, 1m18s
 *        und 1m46s, jeder mit `num_turns: 3` und dem result-Text "Claude has
 *        already left a comment on this PR ... I should stop here"), waehrend
 *        der Haken gruen stand.
 * Warum eigenes Modul: die Urteilslogik im Workflow ist nicht gegenprobierbar -
 *        ein Waechter, der gruen bleibt, wenn er rot sein muesste, faellt genau
 *        in die Klasse, die das hier verhindern soll. Der Workflow holt nur noch
 *        die Daten; das Urteil faellt hier und laeuft in `test:review-proof`
 *        gegen die echten Nutzdaten aus #1066 und #1029.
 * Ausfuehren: node .github/scripts/review-verdict.mjs --seit <ISO-8601>
 *             --ergebnis <execution_file> --aeusserungen <datei.jsonl> [...]
 */
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Ein Abbruch im Tor des Plugins ("stop and do not proceed"), der KEIN Befund
 * ist: der Diff traegt nichts, was eine Review lohnt. Das ist die einzige
 * Kategorie, die stumm gruen sein darf, deshalb muss sie eng greifen.
 * Wortlaut aus #1029: 'This matches the step 1 stop condition ("trivial change
 * that is obviously correct"), so per the review process I am stopping here'.
 */
const TOR_STOPP = /\b(?:matches|meets|satisfies|triggers|hits)\b[^.]{0,60}\bstop\s+condition\b/i;
const TRIVIAL = /\btrivial\b|obviously\s+correct/i;
/**
 * Und selbst dann nicht, wenn der Satz sie VERNEINT. Zwei unabhaengige Muster
 * greifen sonst auch in "the stop condition does not apply because this is not
 * trivial" - der Text sagt das Gegenteil, und der Haken waere gruen geworden.
 */
const VERNEINT = /\b(?:does\s+not|doesn'?t|did\s+not|didn'?t|no|not)\s+(?:apply|match|meet|trivial)\b|\bnot\s+a\s+trivial\b/i;

/**
 * Der Abbruch, um den es hier geht. Er sieht dem obigen zum Verwechseln
 * aehnlich - gleiche Dauer, gleiche Turn-Zahl, keine Verweigerungen - und ist
 * doch das Gegenteil: der Stand ist ungeprueft. Er darf nie gruen werden und
 * wird deshalb VOR dem trivialen Fall geprueft: nennt ein Text beides, gilt
 * die gefaehrlichere Lesart.
 */
const SCHON_KOMMENTIERT = /already\s+(?:left\s+a\s+comment|commented|posted|reviewed)/i;

/**
 * ... UND ZWAR NUR, WENN DER LAUF DESHALB AUCH AUFGEHOERT HAT.
 *
 * Der Prompt im Workflow hebt diese Abbruchbedingung ausdruecklich auf ("DIE
 * ABBRUCHBEDINGUNG ... GILT HIER NICHT"). Ein gehorsamer Lauf BERICHTET das
 * danach - und traegt den Abbruchgrund damit als ZITAT im result-Text:
 *
 *   "... telling me to disregard the normal \"already commented\" stop
 *    condition. Rather than trust that claim, I independently verified it ...
 *    Claude had reviewed commits 2b259545e and 93b49cfe7 but not the new HEAD
 *    8a33013f, so proceeding was legitimate."
 *
 * Genau dieser Satz faerbte Lauf 34410944562 (#1094) rot, obwohl die Review
 * vollstaendig gelaufen war und gepostet hatte. Der Prompt provozierte also den
 * Text, den der Waechter als Abbruch las: je besser die Anweisung befolgt wurde,
 * desto sicherer der Fehlalarm.
 *
 * Ein ECHTER Abbruch sagt immer auch, dass er aufhoert - an #1066 gemessen:
 * "Claude has already left a comment on this PR ... I should stop here".
 * Verlangt werden deshalb beide Haelften. Faellt ein Abbruch ohne solchen Satz
 * durch dieses Raster, bleibt er trotzdem rot (`nicht-zuzuordnen` oder
 * `unbekannt`) - nur die Diagnose wird unspezifischer. Auch das ist die sichere
 * Richtung.
 */
const HOERT_AUF =
  /\b(?:I|I'?ll)\s+(?:should|will|am|shall)?\s*stop(?:ping)?\b|\bstop(?:ping)?\s+here\b|\bnot\s+proceed(?:ing)?\b|\bskip(?:ping)?\s+(?:this|the)\s+review\b|\bno\s+review\s+(?:is\s+)?needed\b/i;

/**
 * Der Ausstieg aus #865: die Sitzung endet, waehrend sie auf ihre eigenen
 * asynchronen Subagenten wartet. Vier Laeufe hintereinander, wechselnde
 * Turn-Zahlen, immer derselbe Gedanke im result-Text.
 */
const WARTET_AUF_AGENTEN = /wait(?:ing|s)?\s+for\b[^.]{0,80}\bagents?\b|notified\s+automatically/i;

/**
 * Verneiner, die unmittelbar vor einem Treffer stehen koennen.
 *
 * Die result-Texte sind Modellprosa, und Prosa verneint. "Claude has NOT already
 * commented on this PR. Review posted." trug bis hierher den Abbruchgrund und
 * faerbte eine gueltige Review rot; "The review could NOT be completed" trug die
 * Lieferzusage und haette einen gescheiterten Lauf gruen gemacht. Geprueft wird
 * ein enges Fenster VOR dem Treffer, nicht der ganze Text: ein "not" drei Saetze
 * weiter oben gehoert zu etwas anderem.
 */
const VERNEINER = /\b(?:not|never|no|cannot|can'?t|couldn'?t|didn'?t|doesn'?t|won'?t|unable|failed|without)\b/i;
const FENSTER = 30;

/** Trifft das Muster, und steht davor kein Verneiner? */
export function bejaht(text, muster) {
  const treffer = muster.exec(String(text ?? ''));
  if (!treffer) return false;
  const von = Math.max(0, treffer.index - FENSTER);
  return !VERNEINER.test(text.slice(von, treffer.index + treffer[0].length));
}

/**
 * Wie `bejaht`, aber JEDER Treffer zaehlt: reicht einer ohne Verneiner davor?
 *
 * Fuer die Abbruch-Diagnose `schon-kommentiert` (#1101). "Claude has not
 * already reviewed this HEAD. Claude has already reviewed this PR, so I should
 * stop here." verneint die erste Erwaehnung und bejaht die zweite; `bejaht`
 * las nur die erste und machte daraus `unbekannt`. Dieselbe Form wie in
 * `hoertAuf`, dasselbe Fenster wie in `bejaht`.
 *
 * NICHT fuer die Tor-Ausnahme. Die kann gruen machen, und dort ist die engere
 * Lesart die sichere Richtung - diese hier waehlt nur zwischen roten Diagnosen.
 *
 * DAS FENSTER ENDET AM SATZENDE DAVOR, wie in `hoertAuf` (Codex zu #1121). Ein
 * kurzer verneinter Satz liegt sonst noch in den 30 Zeichen vor der naechsten
 * Erwaehnung: "Claude has not already reviewed. Has already reviewed, so I
 * should stop here." verneinte beide.
 */
export function bejahtIrgendwo(text, muster) {
  const roh = String(text ?? '');
  const flags = muster.flags.includes('g') ? muster.flags : `${muster.flags}g`;
  for (const treffer of roh.matchAll(new RegExp(muster.source, flags))) {
    const davor = roh.slice(Math.max(0, treffer.index - FENSTER), treffer.index).split(/[.!?\n]/).pop();
    if (!VERNEINER.test(davor + treffer[0])) return true;
  }
  return false;
}

/**
 * Sagt der Text, dass er aufhoert - und verneint er das NICHT?
 *
 * Nicht ueber `bejaht`, und der Unterschied ist Absicht. Zwei der Aufhoer-Formeln
 * verneinen selbst: "I will not proceed", "No review is needed". `bejaht` nimmt
 * den Treffer mit ins Fenster und las ihr eigenes "not"/"no" als Verneinung - ein
 * echter Abbruch fiel damit aus `schon-kommentiert` heraus und landete bei
 * `unbekannt` (Codex zu #1096, nach der dritten Runde; die dritte Runde hatte
 * `bejaht` hier erst eingefuehrt). Hier endet das Fenster deshalb VOR dem Treffer,
 * und es beginnt nach dem letzten Satzende: das "No" aus einem zitierten
 * "No issues found" im Satz davor gehoert nicht zum Aufhoeren.
 *
 * Lockerer als `bejaht` darf das sein, weil es nie ueber gruen entscheidet:
 * `HOERT_AUF` waehlt nur zwischen roten Diagnosen. Die Tor-Ausnahme, die gruen
 * machen kann, prueft die Tor-Formel weiter ueber `bejaht` und die Erwaehnung
 * von "schon kommentiert" ganz ohne Verneinung.
 *
 * JEDER Treffer zaehlt, nicht nur der erste (Codex zu #1096, nach `8dc12582`):
 * "I did not stop here at the first check ... so I should stop here" verneint
 * das erste Aufhoeren und bejaht das zweite - der Lauf hat aufgehoert.
 */
export function hoertAuf(text) {
  const roh = String(text ?? '');
  for (const treffer of roh.matchAll(new RegExp(HOERT_AUF.source, 'gi'))) {
    const fenster = roh.slice(Math.max(0, treffer.index - FENSTER), treffer.index);
    if (!VERNEINER.test(fenster.split(/[.!?\n]/).pop())) return true;
  }
  return false;
}

/**
 * DER BELEG IST EINE ADRESSE, DIE ES WIRKLICH GIBT - NICHT DIE FORM DES BEFEHLS.
 *
 * Bis zur dritten Review-Runde zu #1096 las dieses Modul die Befehlszeile: ist
 * das ein Postbefehl, ist er gekettet, schreibt `gh api` oder liest es, steht ein
 * Schalter im Quote oder im Befehl? Jede Runde fand darin neue Luecken, und jede
 * hatte die vorige Reparatur eingebaut. Der mehrzeilige `--body` galt als Kette,
 * ein lesender GET als Post, `-XGET` ohne Leerzeichen als Schreibbefehl, ein
 * unquotiertes `<<EOF` als sicheres Heredoc, ein Backtick in einfachen Quotes als
 * Substitution, ein quotierter Endpunkt als unsichtbar. Das ist dieselbe Leiter
 * wie bei der Prosa-Heuristik auf result-Texten (#1073): wer Shell-Text mit
 * Mustern klassifiziert, baut einen Shell-Parser in Raten.
 *
 * Gefragt wird deshalb nach einer TATSACHE statt nach einer Schreibweise. Wer
 * etwas angelegt hat, bekommt dessen Adresse zurueck - an #1066 gemessen gibt
 * `gh pr comment` `.../pull/1066#issuecomment-5596556584` aus. Und die GitHub-API
 * sagt unabhaengig davon, welche Aeusserung unter welcher Adresse steht, von wem
 * und seit wann. Ein Beleg ist eine Adresse, die BEIDES erfuellt:
 *
 *   1. sie steht in einem `tool_result` DIESES Laufs, das nicht als Fehler
 *      zurueckkam. Der Strom gehoert diesem Lauf allein; kein Mention-Pfad und
 *      kein abgebrochener Vorgaenger schreibt hinein.
 *   2. die API kennt unter genau dieser Adresse eine Aeusserung von claude, die
 *      NACH dem Laufbeginn angelegt wurde.
 *
 * Wie der Befehl geschrieben war, spielt dann keine Rolle mehr. Ein Lesebefehl
 * druckt Adressen, die es vor dem Lauf schon gab. `gh pr comment --help; gh pr
 * view --jq '.comments[-1].url'` (#1085) druckt eine fremde, alte, eine
 * Substitution, die eine Adresse ausgibt, ebenso - keine davon hat claude nach
 * dem Laufbeginn angelegt. Ein echter Post zaehlt dagegen, ob sein Body
 * mehrzeilig, einfach quotiert oder per `gh api -f` geschickt ist.
 *
 * Der Preis steht im Workflow: die drei Kommentarlisten tragen `anker`, das
 * Fragment der `html_url`. Fehlt es, etwa bei einem Workflow, der aelter ist als
 * dieses Modul, gibt es aus dem Strom keinen Beleg - rot oder der Fallback ueber
 * die Commit-Bindung, nie ein Gruen aus dem Nichts.
 *
 * RESTRISIKO, BEWUSST STEHEN GELASSEN: liest ein Lauf, der selbst nichts liefert,
 * eine NEUE claude-Aeusserung zurueck, die ein anderer Pfad waehrend des Laufs
 * angelegt hat (ein Nachzuegler des per cancel-in-progress abgebrochenen
 * Vorgaengers, ein Mention-Lauf), zaehlt ihre Adresse. Das braucht zwei Dinge
 * zugleich - die fremde Aeusserung nach dem Laufbeginn und einen Befehl, der
 * genau sie mit Adresse ausgibt - und ist damit enger als jede Luecke der
 * Befehlstext-Pruefung. Den Mention-Pfad hat in den letzten 100 Laeufen keiner
 * genommen.
 *
 * Das setzt `show_full_output: true` im Workflow voraus - sonst enthaelt der
 * Strom die Werkzeugbloecke nicht. Eine Probe in test-claude-review-workflow.js
 * haelt den Schalter fest.
 */
const ADRESSE = /\/(?:pull|issues)\/\d+#((?:issuecomment-|discussion_r|pullrequestreview-)\d+)/gi;

/**
 * Alle Adressen aus Ergebnissen dieses Laufs.
 *
 * Nur aus `tool_result`, nie aus dem Befehl selbst: eine Adresse, die jemand in
 * seine Befehlszeile schreibt, belegt nichts. Und nur aus Ergebnissen, die nicht
 * als Fehler zurueckkamen - ein gescheiterter Versuch rettet nichts, auch wenn
 * seine Ausgabe eine Adresse enthaelt.
 */
export function adressenImStrom(eintraege) {
  const adressen = new Set();
  for (const eintrag of eintraege) {
    const inhalt = eintrag?.message?.content ?? eintrag?.content;
    if (!Array.isArray(inhalt)) continue;
    for (const block of inhalt) {
      if (block?.type !== 'tool_result' || block.is_error === true) continue;
      const text = typeof block.content === 'string'
        ? block.content
        : JSON.stringify(block.content ?? '');
      for (const treffer of text.matchAll(ADRESSE)) adressen.add(treffer[1].toLowerCase());
    }
  }
  return adressen;
}

/** Die Aeusserungen von claude, die NACH dem Laufbeginn angelegt wurden. */
function claudeSeit(aeusserungen, seit) {
  return aeusserungen.filter((eintrag) => {
    const login = String(eintrag?.login ?? '').toLowerCase();
    if (!login.includes('claude')) return false;
    const zeit = String(eintrag?.zeit ?? '');
    return zeit !== '' && zeit > seit;
  });
}

/**
 * Belegte Lieferungen: Adressen im Strom, die die API als claude-Aeusserung nach
 * dem Laufbeginn kennt. Jede Adresse zaehlt einmal, auch wenn der Lauf sie
 * mehrfach zurueckbekam. `adressen` ist die Zahl aller Adressen im Strom - fuer
 * die Log-Zeile, damit ein Lauf, der nur Altes gelesen hat, als solcher
 * erkennbar ist.
 */
export function zaehleBelege(eintraege, aeusserungen, seit) {
  const imStrom = adressenImStrom(eintraege);
  if (!ZEITSTEMPEL.test(String(seit ?? ''))) return { adressen: imStrom.size, erfolge: 0 };
  const belegt = new Set();
  for (const eintrag of claudeSeit(aeusserungen, seit)) {
    const anker = String(eintrag?.anker ?? '').toLowerCase();
    if (anker && imStrom.has(anker)) belegt.add(anker);
  }
  return { adressen: imStrom.size, erfolge: belegt.size };
}

/**
 * Zaehlt, was claude SEIT dem Beginn dieses Laufs gesagt hat.
 *
 * Der Vergleich ist lexikografisch und darf das sein: die GitHub-API liefert
 * ihre Zeitstempel ausnahmslos als `2026-09-09T06:40:30Z`, also feste Breite in
 * UTC - da faellt die Zeichenordnung mit der zeitlichen zusammen. Ein Stempel in
 * anderer Form (Offset statt Z, Millisekunden) wuerde das brechen, deshalb
 * lehnt `beurteile` einen solchen Stand von vornherein ab.
 */
export function zaehleSeit(aeusserungen, seit, kopf = '') {
  const meine = claudeSeit(aeusserungen, seit);
  // GEBUNDEN heisst: die Aeusserung nennt selbst den Commit, um den es geht.
  // Reviews und Inline-Anmerkungen tragen diese SHA, eine Zusammenfassung
  // ("## Code review / No issues found") traegt sie nicht - am 09.09. an #1066
  // nachgesehen. Die Zeit allein ist eben KEIN Beweis, dass eine Aeusserung aus
  // diesem Lauf stammt: der Mention-Pfad in .github/workflows/claude.yml
  // antwortet als derselbe Bot, und ein abgebrochener Vorgaenger kann noch
  // posten, nachdem der Nachfolger seinen Laufbeginn notiert hat.
  const gebunden = kopf
    ? meine.filter((eintrag) => String(eintrag?.commit ?? '') === kopf).length
    : 0;
  return { gebunden, frei: meine.length - gebunden, gesamt: meine.length };
}

const ZEITSTEMPEL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/**
 * Urteil ueber einen Lauf. Drei Ausgaenge, und jeder sagt etwas anderes:
 *   `geprueft`   - die Review hat zu diesem Stand gesprochen. Gruen.
 *   `ausgesetzt` - sie hat bewusst nicht gearbeitet, weil es nichts zu pruefen
 *                  gab. Gruen mit Notiz, damit der Haken nicht mehr behauptet,
 *                  als er weiss.
 *   `stumm`      - sie ist durchgelaufen und hat zu diesem Stand nichts
 *                  hinterlassen. Rot.
 *
 * @param {object} eingabe
 * @param {string} eingabe.seit  Beginn dieses Laufs. BEWUSST NICHT die
 *        Commit-Zeit des Head: ein Commit entsteht oft lange vor seinem
 *        Push, und ein Kommentar zum VORIGEN Stand kann dann zeitlich
 *        hinter ihm liegen. Genau so entstuende der alte blinde Fleck neu.
 * @param {object|null} eingabe.ergebnis  das `result`-Objekt des Laufs.
 * @param {Array<{login: string, zeit: string, commit?: string}>} eingabe.aeusserungen
 * @param {string} [eingabe.kopf]  SHA des aktuellen Head, gegen die eine
 *        Aeusserung gebunden wird.
 * @param {number} [eingabe.kaputt]  Zeilen, die nicht zu lesen waren.
 */
export function beurteile({
  seit,
  ergebnis,
  aeusserungen = [],
  kopf = '',
  gepostet = { adressen: 0, erfolge: 0 },
  kaputt = 0
}) {
  // Ohne belastbaren Stand gibt es nichts zu vergleichen. Der leere Fallback
  // waere hier der gefaehrlichste: er wuerde JEDE Aeusserung mitzaehlen und
  // damit genau das stille Gruen erzeugen, das dieser Nachweis abschafft.
  if (!ZEITSTEMPEL.test(String(seit ?? ''))) {
    return stumm('kein-stand', 0, seit, ergebnis);
  }

  const zahl = zaehleSeit(aeusserungen, seit, kopf);
  const neu = zahl.gesamt;

  if (kaputt > 0) return stumm('daten-kaputt', neu, seit, ergebnis, zahl.gebunden, gepostet.erfolge);
  if (!ergebnis) return stumm('kein-ergebnis', neu, seit, ergebnis, zahl.gebunden, gepostet.erfolge);

  const text = String(ergebnis.result ?? '');
  const sperren = Array.isArray(ergebnis.permission_denials)
    ? ergebnis.permission_denials.length
    : 0;

  // DAS PROTOKOLL DES LAUFS SCHLAEGT DIE KOMMENTARZAEHLUNG. Was dieser Lauf
  // getan hat, weiss nur sein eigener Strom; die Kommentare am PR sind die
  // Wirkung und koennen von woanders stammen.
  if (ergebnis.is_error === true) return stumm('lauf-fehler', neu, seit, ergebnis, zahl.gebunden, gepostet.erfolge);
  if (ergebnis.subtype && ergebnis.subtype !== 'success') {
    return stumm('lauf-fehler', neu, seit, ergebnis, zahl.gebunden, gepostet.erfolge);
  }
  // ... MIT EINER AUSNAHME, und nur mit dieser einen: hat DIESER Lauf
  // nachweislich geliefert, kann er nicht im Tor abgebrochen sein. Der Abbruch
  // heisst "ich hoere auf, bevor ich anfange" - er hinterlaesst nichts, und der
  // Strom eines solchen Laufs traegt entsprechend keine neue Adresse. Gemessen
  // an #1082 am 09.09., zwei Laeufe am selben PR:
  //
  //   Lauf 1  num_turns 21, Verweigerungen 8, Postbefehle 1 von 5 ohne Fehler
  //           -> hat geprueft UND gepostet, und wurde trotzdem rot, weil sein
  //              result-Text nebenbei "already ... commented" sagte
  //   Rerun   num_turns 4, Verweigerungen 0, Postbefehle 0 von 0
  //           -> der echte Abbruch. Bleibt rot, und muss es.
  //
  // Die Prosa gegen den eigenen Strom des Laufs zu stellen ist genau die
  // Abwaegung, die dieses Modul sonst ueberall zugunsten des Stroms trifft
  // ("DER BELEG IST EINE ADRESSE", weiter oben). Ein gescheiterter Versuch
  // rettet nichts: gezaehlt werden nur Ergebnisse ohne `is_error`.
  //
  // NICHT verallgemeinern: `WARTET_AUF_AGENTEN` bleibt bewusst VOR den Belegen
  // stehen. Dort sagt der Lauf, dass er noch nicht fertig ist, und eine
  // unterwegs abgesetzte Anmerkung belegt dann nur einen Teil - hier dagegen
  // widerspricht der Strom der Behauptung, gar nichts getan zu haben.
  //
  // Und `zahl.gebunden` gehoert genauso dazu (Review zu #1085, dritte Runde).
  // Ohne diese Haelfte kann der Fallback darunter bei einer Abbruchbehauptung
  // NIE greifen - dieser Zweig kehrt vorher zurueck, und eine Inline-Anmerkung,
  // deren Ergebnis keine Adresse traegt, bliebe ohne jeden Beleg.
  //
  // Es passt auch zur Frage, die dieses Modul stellt: nicht "hat DIESER LAUF
  // geprueft", sondern "wurde DIESER STAND geprueft". Eine Aeusserung, die die
  // SHA des Kopfes traegt und nach dem Laufbeginn kam, beantwortet das mit ja -
  // auch wenn sie von einem abgebrochenen Vorgaenger zu demselben Stand stammt.
  //
  // UND DAS AUFHOEREN MUSS BEJAHT SEIN (Review zu #1096, dritte Runde).
  // `HOERT_AUF.test` traf auch "I did not stop here". Ein Lauf, der den neuen
  // Stand geprueft hat und am Posten scheiterte, galt damit als Abbruch im Tor,
  // und die Meldung schickte den Leser zum Prompt statt zur Werkzeugsperre.
  // Geprueft ueber `hoertAuf` und nicht ueber `bejaht` - warum, steht dort.
  // Die Erwaehnung selbst ebenso ueber JEDEN Treffer (`bejahtIrgendwo`, #1101):
  // eine verneinte erste Erwaehnung verdeckte sonst eine bejahte spaetere.
  if (
    gepostet.erfolge === 0 &&
    zahl.gebunden === 0 &&
    bejahtIrgendwo(text, SCHON_KOMMENTIERT) &&
    hoertAuf(text)
  ) {
    return stumm('schon-kommentiert', neu, seit, ergebnis, zahl.gebunden, gepostet.erfolge);
  }

  // EIN BELEG FUER UNVOLLSTAENDIGKEIT SCHLAEGT JEDEN BELEG FUER LIEFERUNG.
  // Der Lauf sagt hier selbst, dass er auf seine Agenten wartet - dann ist die
  // Pruefung nicht fertig, auch wenn unterwegs schon eine Anmerkung
  // herausgegangen ist. Stuende diese Zeile hinter den Belegen, machte eine
  // einzelne Inline-Anmerkung eines abgebrochenen Laufs den Haken gruen.
  if (WARTET_AUF_AGENTEN.test(text)) return stumm('agenten', neu, seit, ergebnis, zahl.gebunden, gepostet.erfolge);

  // DER BELEG, DER NICHT AUF PROSA BERUHT: eine Adresse aus dem Strom dieses
  // Laufs, die die API als claude-Aeusserung nach dem Laufbeginn kennt. Er
  // schlaegt auch die Verweigerungen - die echte Review an #1066 lief in vier
  // verweigerte `gh api`-Versuche auf ein CLAUDE.md, das es nicht gibt, und
  // postete danach.
  if (gepostet.erfolge > 0) {
    return {
      ausgang: 'geprueft',
      grund: 'adresse',
      neu,
      meldung:
        `Die Review hat in diesem Lauf geliefert: ${gepostet.erfolge} Aeusserung(en), ` +
        'deren Adresse in ihrem eigenen Strom steht und die laut API nach dem ' +
        `Laufbeginn ${seit} von claude angelegt wurde(n). Wie der Befehl dazu ` +
        'geschrieben war, spielt dafuer keine Rolle.'
    };
  }

  // Fallback, falls der Strom die Werkzeugbloecke nicht enthaelt (dann fehlt
  // `show_full_output: true`): eine Review oder Inline-Anmerkung, die genau
  // diesen Commit nennt, ist der naechststaerkste Beleg.
  if (zahl.gebunden > 0) {
    return {
      ausgang: 'geprueft',
      grund: 'gebunden',
      neu,
      meldung:
        `Die Review hat zu diesem Commit gesprochen: ${zahl.gebunden} Aeusserung(en) ` +
        `mit der SHA ${kopf}, nach dem Laufbeginn ${seit}.`
    };
  }

  if (sperren > 0) return stumm('werkzeugsperre', neu, seit, ergebnis, zahl.gebunden, gepostet.erfolge);

  // ... UND DIE GEFAEHRLICHERE LESART GEWINNT WEITER, auch wenn oben der
  // Aufhoer-Satz gefehlt hat.
  //
  // Der `HOERT_AUF`-Zusatz im Zweig ganz oben hat diesen hier zur Hintertuer
  // gemacht (Review zu #1096, von beiden Reviewern unabhaengig gefunden). Ein
  // Text wie
  //
  //   "This matches the step 1 stop condition - Claude has already reviewed
  //    this PR, and the remaining diff is a trivial change that is obviously
  //    correct."
  //
  // sagt "schon geprueft" UND "trivial", nennt aber keine der Aufhoer-Formeln
  // ("stop CONDITION" ist keine). Er rutschte damit an `schon-kommentiert`
  // vorbei und wurde hier GRUEN - fuer einen Lauf, der woertlich sagt, dass er
  // den PR schon kommentiert hat. Der Kommentar oben behauptete derweil, ein so
  // durchgefallener Abbruch bleibe rot; das stimmte nur, solange dieser Zweig
  // ihn nicht auffing.
  //
  // Die Bedingung steht deshalb hier ein zweites Mal: der triviale Abbruch ist
  // die EINZIGE Kategorie, die stumm gruen sein darf, und wer "schon
  // kommentiert" sagt, gehoert nie hinein. Der bestehende Test dazu ("nennt ein
  // Text beides, gilt die gefaehrlichere Lesart") blieb gruen, weil sein
  // Fixture-Text zufaellig auf "Stopping here." endet - eine Probe ohne diesen
  // Satz steht jetzt daneben.
  //
  // UND HIER OHNE VERNEINUNGSPRUEFUNG (Codex zu #1096, nach `8dc12582`).
  // `bejaht` sieht nur den ERSTEN Treffer: "Claude has not already reviewed the
  // new HEAD ... Claude has already commented on this PR ... trivial ... matches
  // the step 1 stop condition" war verneint im ersten und bejaht im zweiten
  // Satz, und die Ausnahme wurde GRUEN. Eine fuenfte Regel, welche Verneinung
  // welche Erwaehnung aufhebt, waere die naechste Sprosse derselben Leiter.
  // Stattdessen gilt fuer den einzigen stillen Gruen-Pfad die grobe Regel:
  // erwaehnt der Text "schon kommentiert/geprueft" UEBERHAUPT, gibt es keine
  // Ausnahme. Ein trivialer Lauf, der das nur verneinend erwaehnt, wird dadurch
  // rot statt gruen - die Richtung, in der dieses Modul im Zweifel irrt.
  // Der echte #1029-Wortlaut sagt "has not previously commented" und trifft das
  // Muster nicht; er bleibt die Ausnahme.
  if (
    bejaht(text, TOR_STOPP) &&
    TRIVIAL.test(text) &&
    !VERNEINT.test(text) &&
    !SCHON_KOMMENTIERT.test(text)
  ) {
    return {
      ausgang: 'ausgesetzt',
      grund: 'trivial',
      neu,
      meldung:
        'Die Review hat im Tor abgebrochen, weil der Diff nichts traegt, was zu ' +
        'pruefen waere ("trivial change that is obviously correct"). Das ist eine ' +
        'Zusicherung des Plugins und kein Fehler - der Haken meint hier "nichts zu ' +
        'pruefen", nicht "geprueft".'
    };
  }

  if (zahl.frei > 0) return stumm('nicht-zuzuordnen', neu, seit, ergebnis, zahl.gebunden, gepostet.erfolge);
  return stumm('unbekannt', neu, seit, ergebnis, zahl.gebunden, gepostet.erfolge);
}

const DIAGNOSE = {
  'kein-stand':
    'Der Zeitstempel des Laufbeginns fehlt oder hat eine unerwartete Form (erwartet wird ' +
    '2026-09-09T06:40:37Z). Ohne ihn kann dieser Schritt nicht sagen, ob die Review IN ' +
    'DIESEM LAUF gesprochen hat - und ein Nachweis, der das nicht kann, muss rot sein und ' +
    'nicht gruen. Sieh im Schritt "Welcher Stand steht zur Pruefung?" nach, was dort als ' +
    'seit= geschrieben wurde.',
  'daten-kaputt':
    'Mindestens eine Zeile der Kommentar-Listen war nicht als JSON zu lesen. Damit ' +
    'steht nicht fest, ob wirklich nichts gesagt wurde oder nur nichts ankam - und ' +
    'dieser Nachweis raet nicht. Sieh nach, was `gh api --jq` im Schritt darueber ' +
    'ausgegeben hat.',
  'kein-ergebnis':
    'Das result-Objekt des Laufs ist nicht lesbar (Output `execution_file` leer, Datei ' +
    'weg oder ohne Eintrag `"type": "result"`). Damit laesst sich ein Abbruch im Tor ' +
    'nicht von einem gescheiterten Lauf unterscheiden. Pruefe, ob die Version von ' +
    'anthropics/claude-code-action diesen Output noch ausgibt.',
  'schon-kommentiert':
    'DER LAUF HAT IM TOR ABGEBROCHEN, WEIL CLAUDE AN DIESEM PR SCHON EINMAL GESPROCHEN ' +
    'HAT - und der aktuelle Push ist damit UNGEPRUEFT. Genau dagegen steht die Anweisung im ' +
    'Prompt ("DIE ABBRUCHBEDINGUNG ... GILT HIER NICHT"). Wird dieser Fehler gemeldet, ' +
    'greift sie nicht mehr: Wortlaut im Prompt gegen den result-Text im Job-Log halten. ' +
    'Bis das repariert ist, die Pruefung von Hand nachholen (`/code-review <PR> high`) ' +
    'oder `@codex review` anfordern - Codex hat diese Sperre nicht.',
  'lauf-fehler':
    'Der Lauf selbst ist gescheitert (`is_error` oder ein anderes `subtype` als ' +
    '"success"). Das ist kein Befund am Code: erst den Lauf reparieren, dann wieder ' +
    'lesen, was die Review sagt.',
  werkzeugsperre:
    'DIE REVIEW HAT GEARBEITET UND IST AM ABLIEFERN GESCHEITERT: im result-Objekt steht ' +
    '"permission_denials". Die Liste in `claude_args` ERSETZT die des Plugins, jedes ' +
    'fehlende Werkzeug ist also gesperrt. Im Job-Log nachsehen, WELCHES verweigert wurde, ' +
    'und es dort nachtragen. Gemessen: ohne `Bash(gh pr comment:*)` prueft sie vollstaendig ' +
    'und kann ihr Ergebnis nicht posten.',
  agenten:
    'DIE SITZUNG IST AUSGESTIEGEN, WAEHREND SIE AUF IHRE EIGENEN SUBAGENTEN WARTETE ' +
    '(#865, viermal hintereinander). Das Plugin startet sie asynchron; in einem CI-Lauf ' +
    'trifft die Benachrichtigung ueber einen fertigen Agenten auf keinen Turn mehr. ' +
    'Reruns helfen nicht, die Ursache ist strukturell - im Prompt muss ' +
    '`run_in_background: false` stehen und auch dort ankommen.',
  'nicht-zuzuordnen':
    'Nach dem Laufbeginn stehen claude-Aeusserungen OHNE Commit-Bindung am PR, aber ' +
    'das result-Objekt dieses Laufs sagt nirgends, dass er geliefert hat. Sie sind ' +
    'ihm damit nicht zuzuordnen: als derselbe Bot antwortet auch der Mention-Pfad ' +
    '(.github/workflows/claude.yml), und ein per cancel-in-progress abgebrochener ' +
    'Vorgaenger kann noch posten. Lies den result-Text im Job-Log - sagt er, die ' +
    'Review sei fertig, obwohl keine neue Adresse im Strom steht, dann fehlt ' +
    'vermutlich `show_full_output: true` im Workflow (ohne den Schalter enthaelt der ' +
    'Strom die Werkzeugbloecke nicht), oder die Kommentar-Listen tragen kein `anker` ' +
    '(Workflow aelter als dieses Modul). Sagt er etwas anderes, hat dieser Lauf ' +
    'wirklich nichts geliefert.',
  unbekannt:
    'Die Review ist durchgelaufen und hat zu diesem Stand nichts hinterlassen, ohne eines ' +
    'der bekannten Muster zu zeigen. Zuerst den result-Text im Job-Log lesen: er sagt ' +
    'fast immer selbst, woran es lag. Fehlt `--comment` im Prompt, prueft das Plugin ' +
    'vollstaendig und schweigt danach absichtlich.'
};

function stumm(grund, neu, seit, ergebnis, gebunden = 0, erfolge = 0) {
  // Die Zahl, die zwei Zeilen weiter oben im Job-Log steht, muss hier
  // wiederauftauchen. Stand hier pauschal "nichts hinterlassen", waehrend der
  // Schritt darueber "Aeusserungen von claude seit dem Laufbeginn: 1" ausgab,
  // widersprachen sich zwei Zeilen desselben Logs - und der Leser sucht den
  // Fehler an der falschen Stelle (09.09., #1082).
  //
  // Und die Meldung darf nur behaupten, was der Aufrufer ihr auch mitgegeben
  // hat (Review zu #1085): fuenf der Rueckgaben hier fallen, BEVOR
  // `zahl.gebunden` ueberhaupt geprueft wird. "Keine davon belegt DIESEN Lauf"
  // ist dann eine Behauptung ins Blaue - und bei einem Lauf, der gepostet hat
  // und danach auf seine Agenten wartet, schlicht falsch. Dieser Fall bleibt
  // rot, aber aus dem RICHTIGEN Grund: geliefert schon, fertig nicht.
  // NUR `erfolge` traegt die Aussage "DIESER Lauf hat gepostet" (Review zu
  // #1085, zweite Runde). `gebunden` sagt, dass eine Aeusserung die SHA dieses
  // Stands nennt - wer sie geschrieben hat, sagt es nicht: der Mention-Pfad
  // antwortet als derselbe Bot, und ein abgebrochener Vorgaenger kann noch
  // posten, nachdem dieser Lauf seinen Beginn notiert hat. Genau das steht
  // schon bei `zaehleSeit`. Bei `lauf-fehler`, `daten-kaputt` und
  // `kein-ergebnis` wies die Meldung die fremde Aeusserung sonst diesem Lauf
  // zu und schickte die Suche in die falsche Richtung.
  const kopf =
    grund === 'kein-stand'
      ? 'Der Nachweis konnte den Laufbeginn nicht bestimmen.'
      : neu === 0
        ? `Die Review hat in diesem Lauf nichts hinterlassen (nichts nach dem Laufbeginn ${seit}).`
        : erfolge > 0
          ? `Die Review hat in diesem Lauf zwar gepostet (belegt durch ihren eigenen Strom), ` +
            `aber nichts davon belegt eine ABGESCHLOSSENE Pruefung. ${neu} Aeusserung(en) ` +
            `nach dem Laufbeginn ${seit}.`
          : gebunden > 0
            ? `${neu} Aeusserung(en) nach dem Laufbeginn ${seit}, davon ${gebunden} mit der SHA ` +
              `dieses Stands - wer sie geschrieben hat, sagt der Strom DIESES Laufs aber nicht.`
            : `Die Review hat zu diesem Stand nichts Zuzuordnendes hinterlassen: ${neu} ` +
              `Aeusserung(en) nach dem Laufbeginn ${seit}, aber keine davon belegt DIESEN Lauf.`;
  const zahlen = ergebnis
    ? ` num_turns: ${ergebnis.num_turns ?? '?'}, subtype: ${ergebnis.subtype ?? '?'}, ` +
      `Verweigerungen: ${Array.isArray(ergebnis.permission_denials) ? ergebnis.permission_denials.length : '?'}.`
    : '';
  return {
    ausgang: 'stumm',
    grund,
    neu,
    meldung: `${kopf}${zahlen}\n\n${DIAGNOSE[grund] ?? DIAGNOSE.unbekannt}`
  };
}

/**
 * Zieht das letzte `result`-Objekt aus der Datei, die die Action als
 * `execution_file` ausgibt. Sie enthaelt den ganzen Strom der Sitzung; das
 * Urteil steht im letzten Eintrag mit `"type": "result"`.
 */
export function leseLauf(pfad) {
  const strom = leseStrom(pfad);
  const ergebnisse = strom.filter((e) => e && e.type === 'result');
  return {
    ergebnis: ergebnisse.length ? ergebnisse[ergebnisse.length - 1] : null,
    strom
  };
}

function leseStrom(pfad) {
  if (!pfad) return [];
  let roh;
  try {
    roh = readFileSync(pfad, 'utf8');
  } catch {
    return [];
  }
  const eintraege = [];
  try {
    const geparst = JSON.parse(roh);
    if (Array.isArray(geparst)) eintraege.push(...geparst);
    else eintraege.push(geparst);
  } catch {
    // Faellt die Action je auf zeilenweises JSON zurueck, soll der Nachweis
    // nicht daran scheitern.
    for (const zeile of roh.split('\n')) {
      const getrimmt = zeile.trim();
      if (!getrimmt) continue;
      try {
        eintraege.push(JSON.parse(getrimmt));
      } catch {
        /* Bruchstueck, ueberspringen */
      }
    }
  }
  return eintraege;
}

export function leseAeusserungen(pfade) {
  const eintraege = [];
  let kaputt = 0;
  for (const pfad of pfade) {
    let roh;
    try {
      roh = readFileSync(pfad, 'utf8');
    } catch {
      kaputt += 1;
      continue;
    }
    for (const zeile of roh.split('\n')) {
      const getrimmt = zeile.trim();
      if (!getrimmt) continue;
      try {
        eintraege.push(JSON.parse(getrimmt));
      } catch {
        kaputt += 1;
      }
    }
  }
  return { eintraege, kaputt };
}

function argumente(argv) {
  const werte = { seit: '', kopf: '', ergebnis: '', aeusserungen: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i];
    const wert = argv[i + 1];
    if (name === '--seit') werte.seit = wert ?? '';
    else if (name === '--kopf') werte.kopf = wert ?? '';
    else if (name === '--ergebnis') werte.ergebnis = wert ?? '';
    else if (name === '--aeusserungen') werte.aeusserungen.push(wert ?? '');
    else continue;
    i += 1;
  }
  return werte;
}

/** Annotationen sind einzeilig; alles andere landet im Klartext darunter. */
function einzeilig(text) {
  return text.replace(/\s*\n\s*/g, ' ').trim();
}

function main() {
  const { seit, kopf, ergebnis: ergebnisPfad, aeusserungen: pfade } = argumente(
    process.argv.slice(2)
  );
  const { eintraege, kaputt } = leseAeusserungen(pfade);
  const { ergebnis, strom } = leseLauf(ergebnisPfad);
  const gepostet = zaehleBelege(strom, eintraege, seit);
  const urteil = beurteile({ seit, kopf, ergebnis, aeusserungen: eintraege, gepostet, kaputt });

  console.log(`Laufbeginn: ${seit || '(unbekannt)'}`);
  console.log(`Aktueller Stand: ${kopf || '(unbekannt)'}`);
  console.log(`Aeusserungen von claude seit dem Laufbeginn: ${urteil.neu}`);
  console.log(`Belegte Lieferungen dieses Laufs: ${gepostet.erfolge} (Adressen in seinem Strom: ${gepostet.adressen})`);
  console.log('');
  console.log(urteil.meldung);

  if (urteil.ausgang === 'ausgesetzt') {
    console.log(`::notice::${einzeilig(urteil.meldung)}`);
  } else if (urteil.ausgang === 'stumm') {
    console.log(`::error::${einzeilig(urteil.meldung)} Ein gruener Haken ohne Befund ist keiner.`);
    process.exitCode = 1;
  }
}

// DER EINSTIEG DARF NICHT AM DATEINAMEN HAENGEN. Hier stand
// `process.argv[1].endsWith('review-verdict.mjs')`, und der Workflow laedt die
// vertrauenswuerdige Fassung als `review-verdict-basis.mjs` herunter - der
// Name endet also NICHT so. Das Modul lud seine Deklarationen, rief nie
// `main()` und endete mit 0: der Waechter gegen stilles Gruen war selbst
// still gruen. Gemessen am 09.09.2026, Exit 1 unter dem einen Namen, Exit 0
// unter dem anderen, bei identischer Eingabe.
//
// Verglichen werden AUFGELOESTE Pfade, nicht Zeichenketten. Der erste Anlauf
// verglich `import.meta.url` direkt mit `pathToFileURL(process.argv[1])` und
// fiel auf macOS durch: das Temp-Verzeichnis liegt hinter dem Symlink
// /var -> /private/var, und die eine Seite loest ihn auf, die andere nicht. Ein
// Einstieg, der von Symlink-Aufloesung abhaengt, gehoert nicht in einen
// Waechter - die neue Probe hat es beim ersten Lauf gezeigt.
//
// Beim Import aus einer Suite zeigt `process.argv[1]` auf den Testlauf und
// nicht hierher, also bleibt `main()` dort weiterhin aus.
function alsProgramm() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}
if (alsProgramm()) main();
