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
 * Werkzeugaufrufe, mit denen dieser Lauf etwas an den PR geschrieben hat.
 *
 * DAS IST DIE EINZIGE ZUORDNUNG, DIE NICHT AUF PROSA BERUHT. Der Strom in
 * `execution_file` gehoert diesem Lauf allein - kein Mention-Pfad und kein
 * abgebrochener Vorgaenger schreibt hinein. Ein `tool_use` mit dem Postbefehl
 * und ein `tool_result` ohne Fehler dazu sind ein Beleg, den der Text daneben
 * weder herbeireden noch wegreden kann. An #1066 gemessen:
 *
 *   tool_use    { name: "Bash", input.command: "gh pr comment 1066 --repo ..." }
 *   tool_result { tool_use_id: ..., is_error: false,
 *                 content: ".../pull/1066#issuecomment-5596556584" }
 *
 * Das setzt voraus, dass `show_full_output: true` im Workflow steht - sonst
 * enthaelt der Strom diese Bloecke nicht. Der Schalter ist damit tragend, und
 * eine Probe in test-claude-review-workflow.js haelt ihn fest.
 */
const POSTBEFEHL = /\bgh\s+pr\s+(?:comment|review)\b|\bgh\s+api\b[^"]*\/(?:comments|reviews)\b/i;
const POSTWERKZEUG = /inline_comment|create_.*comment/i;

export function zaehleGepostet(eintraege) {
  const versuche = new Set();
  const bloecke = [];
  for (const eintrag of eintraege) {
    const inhalt = eintrag?.message?.content ?? eintrag?.content;
    if (Array.isArray(inhalt)) bloecke.push(...inhalt);
  }
  for (const block of bloecke) {
    if (block?.type !== 'tool_use') continue;
    const name = String(block.name ?? '');
    const befehl = String(block.input?.command ?? '');
    if (POSTWERKZEUG.test(name) || POSTBEFEHL.test(befehl)) versuche.add(block.id);
  }
  let erfolge = 0;
  for (const block of bloecke) {
    if (block?.type !== 'tool_result') continue;
    if (!versuche.has(block.tool_use_id)) continue;
    if (block.is_error === true) continue;
    erfolge += 1;
  }
  return { versuche: versuche.size, erfolge };
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
  const meine = aeusserungen.filter((eintrag) => {
    const login = String(eintrag?.login ?? '').toLowerCase();
    if (!login.includes('claude')) return false;
    const zeit = String(eintrag?.zeit ?? '');
    return zeit !== '' && zeit > seit;
  });
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
  gepostet = { versuche: 0, erfolge: 0 },
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

  if (kaputt > 0) return stumm('daten-kaputt', neu, seit, ergebnis);
  if (!ergebnis) return stumm('kein-ergebnis', neu, seit, ergebnis);

  const text = String(ergebnis.result ?? '');
  const sperren = Array.isArray(ergebnis.permission_denials)
    ? ergebnis.permission_denials.length
    : 0;

  // DAS PROTOKOLL DES LAUFS SCHLAEGT DIE KOMMENTARZAEHLUNG. Was dieser Lauf
  // getan hat, weiss nur sein eigener Strom; die Kommentare am PR sind die
  // Wirkung und koennen von woanders stammen.
  if (ergebnis.is_error === true) return stumm('lauf-fehler', neu, seit, ergebnis);
  if (ergebnis.subtype && ergebnis.subtype !== 'success') {
    return stumm('lauf-fehler', neu, seit, ergebnis);
  }
  if (bejaht(text, SCHON_KOMMENTIERT)) return stumm('schon-kommentiert', neu, seit, ergebnis);

  // EIN BELEG FUER UNVOLLSTAENDIGKEIT SCHLAEGT JEDEN BELEG FUER LIEFERUNG.
  // Der Lauf sagt hier selbst, dass er auf seine Agenten wartet - dann ist die
  // Pruefung nicht fertig, auch wenn unterwegs schon eine Anmerkung
  // herausgegangen ist. Stuende diese Zeile hinter den Belegen, machte eine
  // einzelne Inline-Anmerkung eines abgebrochenen Laufs den Haken gruen.
  if (WARTET_AUF_AGENTEN.test(text)) return stumm('agenten', neu, seit, ergebnis);

  // DER EINE BELEG, DER NICHT AUF PROSA BERUHT: dieser Lauf hat den Postbefehl
  // ausgefuehrt, und er kam ohne Fehler zurueck. Er schlaegt auch die
  // Verweigerungen - die echte Review an #1066 lief in vier verweigerte
  // `gh api`-Versuche auf ein CLAUDE.md, das es nicht gibt, und postete danach.
  if (gepostet.erfolge > 0) {
    return {
      ausgang: 'geprueft',
      grund: 'postbefehl',
      neu,
      meldung:
        `Die Review hat in diesem Lauf gepostet: ${gepostet.erfolge} von ` +
        `${gepostet.versuche} Postbefehl(en) kam ohne Fehler zurueck. Das steht in ` +
        'ihrem eigenen Strom und laesst sich von aussen nicht herbeifuehren.'
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

  if (sperren > 0) return stumm('werkzeugsperre', neu, seit, ergebnis);

  if (bejaht(text, TOR_STOPP) && TRIVIAL.test(text) && !VERNEINT.test(text)) {
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

  if (zahl.frei > 0) return stumm('nicht-zuzuordnen', neu, seit, ergebnis);
  return stumm('unbekannt', neu, seit, ergebnis);
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
    'Review sei fertig, obwohl kein Postbefehl im Strom steht, dann fehlt vermutlich ' +
    '`show_full_output: true` im Workflow - ohne den Schalter enthaelt der Strom die ' +
    'Werkzeugbloecke nicht. Sagt er etwas anderes, hat dieser Lauf wirklich nichts ' +
    'geliefert.',
  unbekannt:
    'Die Review ist durchgelaufen und hat zu diesem Stand nichts hinterlassen, ohne eines ' +
    'der bekannten Muster zu zeigen. Zuerst den result-Text im Job-Log lesen: er sagt ' +
    'fast immer selbst, woran es lag. Fehlt `--comment` im Prompt, prueft das Plugin ' +
    'vollstaendig und schweigt danach absichtlich.'
};

function stumm(grund, neu, seit, ergebnis) {
  const kopf =
    grund === 'kein-stand'
      ? 'Der Nachweis konnte den Laufbeginn nicht bestimmen.'
      : `Die Review hat in diesem Lauf nichts hinterlassen (nichts nach dem Laufbeginn ${seit}).`;
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
  const eintraege = leseStrom(pfad);
  const ergebnisse = eintraege.filter((e) => e && e.type === 'result');
  return {
    ergebnis: ergebnisse.length ? ergebnisse[ergebnisse.length - 1] : null,
    gepostet: zaehleGepostet(eintraege)
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
  const { ergebnis, gepostet } = leseLauf(ergebnisPfad);
  const urteil = beurteile({ seit, kopf, ergebnis, aeusserungen: eintraege, gepostet, kaputt });

  console.log(`Laufbeginn: ${seit || '(unbekannt)'}`);
  console.log(`Aktueller Stand: ${kopf || '(unbekannt)'}`);
  console.log(`Aeusserungen von claude seit dem Laufbeginn: ${urteil.neu}`);
  console.log(`Postbefehle dieses Laufs: ${gepostet.erfolge} von ${gepostet.versuche} ohne Fehler`);
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
