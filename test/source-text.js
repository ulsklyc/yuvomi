/**
 * Modul: Test-Infrastruktur - Quelltext neutralisieren, bevor ein Guard ihn liest.
 * Zweck: Kommentare aus einer Quelle schneiden, ohne dabei eine Falle zu bauen.
 * Ausfuehren: keine eigene Suite - Helfer, importiert von den Guard-Suiten.
 *
 * WARUM UEBERHAUPT: ein Guard, der im Quelltext nach einem Muster sucht, findet
 * es auch in einem KOMMENTAR. Genau diese Falle hat in Etappe 4 einen Guard rot
 * gemacht, der inhaltlich recht hatte - der Kommentar nannte den alten Namen,
 * und `includes()` liest einen Kommentar als Regel.
 *
 * WARUM EIN FIXPUNKT UND KEIN EINFACHES `replace`: ein einzelner Durchlauf ueber
 * `<!--[\s\S]*?-->` kann das Trennzeichen STEHEN LASSEN. Bei `<!--a<!--b-->`
 * frisst der non-greedy Match von der ersten Klammer bis zum ersten `-->` und
 * laesst nichts uebrig; bei `<!--<!-- -->` bleibt dagegen ein `<!--` zurueck.
 * CodeQL nennt das `js/incomplete-multi-character-sanitization` und stuft es
 * hoch ein. Im Testbaum ist daraus keine Luecke abzuleiten - hier wird eine
 * Repo-Datei gelesen, nicht Fremdeingabe in HTML geschrieben -, aber der
 * SCHNITT ist trotzdem unvollstaendig, und ein Guard, der auf unvollstaendig
 * geschnittenem Text urteilt, urteilt auf einem Text, den es so nicht gibt.
 *
 * WARUM HIER UND NICHT DREIMAL: `test-budget-ui.js` hatte diese Schleife samt
 * Begruendung bereits, `test-frontend-audit.js` die Kette ohne sie. Zwei Kopien
 * desselben Musters haben in diesem Repo schon zweimal zwei verschiedene
 * Blindstellen ueberlebt (siehe den Kopf von `css-rules.js`) - deshalb steht der
 * Schnitt jetzt an einer Stelle. `css-rules.js` ist ausdruecklich nicht dieser
 * Ort: es ist der Regelscanner fuer STYLESHEETS und sagt das in seiner ersten
 * Zeile.
 */

/**
 * Schneidet HTML-Kommentare heraus, bis nichts mehr uebrig bleibt.
 * @param {string} src
 * @returns {string}
 */
export function withoutHtmlComments(src) {
  let out = src;
  let previous;
  do {
    previous = out;
    out = out.replace(/<!--[\s\S]*?-->/g, '');
  } while (out !== previous);
  return out;
}

/**
 * Schneidet JS-Blockkommentare heraus, ebenfalls bis zum Fixpunkt.
 *
 * Erhaelt die Zeilenzahl NICHT - wer gemeldete Zeilennummern braucht, ersetzt
 * stattdessen durch Leerzeichen (so macht es `stripComments` in
 * `test-typography.js` fuer CSS, und aus genau diesem Grund steht es dort).
 * @param {string} src
 * @returns {string}
 */
export function withoutBlockComments(src) {
  let out = src;
  let previous;
  do {
    previous = out;
    out = out.replace(/\/\*[\s\S]*?\*\//g, '');
  } while (out !== previous);
  return out;
}

/**
 * Schneidet Block- UND Zeilenkommentare heraus und ERHAELT die Zeilenzahl.
 *
 * Fuer Guards, die zeilenweise urteilen und die gefundene Zeile melden - dort
 * ist `withoutBlockComments` nicht brauchbar, weil es Zeilen zusammenzieht und
 * jede gemeldete Nummer daneben laege.
 *
 * WARUM ES DIESEN DRITTEN SCHNITT BRAUCHT: ein auskommentierter Aufruf ist tot,
 * steht aber weiter im Text. Ein Guard, der `refocusAfterRender(` sucht, findet
 * ihn in `// refocusAfterRender();` und meldet gruen - gemessen genau so
 * passiert, die Gegenprobe zum Guard blieb still. Toter Code besteht einen
 * Textguard, solange der Guard den Text nicht erst neutralisiert.
 *
 * WARUM EIN DURCHGANG MIT ZUSTAENDEN: die fruehere Fassung nahm erst alle
 * Blockkommentare heraus, dann alle Zeilenkommentare, und kannte keine Strings.
 * Ein Zeilenkommentar mit `Accept: *` und `/` dahinter enthaelt einen
 * Blockanfang; der Schnitt blendete von dort alles bis zum naechsten Blockende
 * irgendwo spaeter in der Datei aus, echten Code eingeschlossen (gemessen an
 * `server/utils/http.js` und `server/index.js`, gefunden am
 * Admin-Praedikat-Guard in `test-settings-admin-gate.js`). Ein Guard, der eine
 * vorhandene Zeile nicht mehr sieht, meldet einen Fehler, den es nicht gibt -
 * oder uebersieht einen, den es gibt. Der Scanner liest deshalb Zeichen fuer
 * Zeichen und weiss, ob er in Code, Kommentar, String, Template-Literal (samt
 * `${}`-Ersetzung) oder Regex-Literal steht. Escapes gelten ueberall, so bleiben
 * `/^https?:\/\//i` und `'http://x'` heil. Einen Fixpunkt braucht es nicht: ein
 * Durchgang laesst kein halbes Trennzeichen stehen.
 *
 * Blockkommentare werden durch Leerzeichen ersetzt und behalten ihre
 * Zeilenumbrueche, Zeilenkommentare fallen bis zum Zeilenende weg - so behaelt
 * jede Zeile ihre Nummer.
 *
 * GRENZE: ob ein `/` ein Regex-Literal oeffnet oder teilt, entscheidet das
 * Zeichen davor. Nach einem Bezeichner (ausser Schluesselwoertern wie `return`
 * oder `typeof`), einer Zahl, `)`, `]`, `}` oder einem fertigen String- oder
 * Template-Literal gilt es als Division, ebenso ein Kandidat ohne schliessendes
 * `/` in derselben Zeile. Hinter `${` (auch direkt nach `}${` und in einem
 * Template innerhalb einer Ersetzung) beginnt dagegen ein Ausdruck, dort oeffnet
 * es ein Regex-Literal. Ein Regex-Literal an einer Divisionsstelle
 * (`if (x) /[/*]/.test(s)`) liest der Scanner als Code: escapte Zeichen bleiben
 * dort heil, ein unescaptes `/*`, `//` oder Anfuehrungszeichen in einer
 * Zeichenklasse oeffnet dagegen Kommentar oder String. Umgekehrt gilt ein `/`
 * nach `++` oder `--` als Regex-Anfang, wenn die Zeile noch einen `/` hat. Ein
 * einfacher oder doppelter String endet spaetestens am Zeilenende. Das gilt auch
 * fuer ein Regex-Literal als Anweisung direkt hinter einem Block
 * (`if (ok) {}` und darunter `/[/*]/.test(s)`): dort blendet der Scanner ab dem
 * `/*` alles bis zum naechsten Blockende aus. Bewusst so gelassen (Entscheidung
 * vom 15.09.2026): Anweisungsgrenzen sicher zu erkennen braucht einen Parser.
 * Gemessen am selben Tag: in `server/`, `public/` (ohne vendor) und `tools/`
 * beginnen sieben Zeilen mit einem Regex-Literal, keines traegt ein unescaptes
 * `/*`, `//` oder Anfuehrungszeichen.
 * @param {string} src
 * @returns {string}
 */
export function withoutCommentsKeepingLines(src) {
  const n = src.length;
  let out = '';
  let i = 0;
  // Je offener `${`-Ersetzung ihre Klammertiefe; die `}` bei Tiefe 0 schliesst sie.
  const ersetzungen = [];
  // Letztes bedeutsames Code-Zeichen und der Bezeichner davor: Regex oder Division?
  let zuletzt = '';
  let wort = '';
  let wortZu = false;

  // Template-Text ab `j` bis hinter das schliessende Backtick oder hinter `${`.
  const templateBis = (j) => {
    while (j < n) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === '`') return j + 1;
      if (src[j] === '$' && src[j + 1] === '{') { ersetzungen.push(0); return j + 2; }
      j++;
    }
    return n;
  };
  // Ende eines Regex-Literals ab dem oeffnenden `/`, oder -1 ohne Schluss in der Zeile.
  const regexBis = (j) => {
    let klasse = false;
    for (j += 1; j < n; j++) {
      const z = src[j];
      if (z === '\n' || z === '\r') return -1;
      if (z === '\\') { j++; continue; }
      if (klasse) { if (z === ']') klasse = false; continue; }
      if (z === '[') klasse = true;
      else if (z === '/') {
        j++;
        while (j < n && /[a-z]/i.test(src[j])) j++;
        return j;
      }
    }
    return -1;
  };
  const alsWert = (bis) => {
    out += src.slice(i, bis);
    i = Math.min(bis, n);
    zuletzt = ')';
    wort = '';
  };
  // Template-Text lesen. Endet er am Backtick, ist das Literal ein fertiger Wert;
  // endet er an `${`, beginnt dahinter ein Ausdruck, und ein `/` oeffnet ein Regex.
  const imTemplate = (j) => {
    const offen = ersetzungen.length;
    alsWert(templateBis(j));
    if (ersetzungen.length > offen) zuletzt = '';
  };

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n' && src[i] !== '\r') i++;
      wortZu = true;
    } else if (c === '/' && d === '*') {
      const ende = src.indexOf('*/', i + 2);
      const bis = ende === -1 ? n : ende + 2;
      out += src.slice(i, bis).replace(/[^\n]/g, ' ');
      i = bis;
      wortZu = true;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      alsWert(src[j] === c ? j + 1 : j);
    } else if (c === '`') {
      imTemplate(i + 1);
    } else if (c === '}' && ersetzungen.length && ersetzungen.at(-1) === 0) {
      ersetzungen.pop();
      imTemplate(i + 1);
    } else if (c === '/' && regexErlaubt(zuletzt, wort) && regexBis(i) !== -1) {
      alsWert(regexBis(i));
    } else {
      if (c === '{' && ersetzungen.length) ersetzungen[ersetzungen.length - 1]++;
      if (c === '}' && ersetzungen.length) ersetzungen[ersetzungen.length - 1]--;
      out += c;
      i++;
      if (/\s/.test(c)) {
        wortZu = true;
      } else {
        wort = /[\w$]/.test(c) ? (wortZu ? '' : wort) + c : '';
        wortZu = false;
        zuletzt = c;
      }
    }
  }
  return out;
}

/** Nach diesen Woertern beginnt ein Ausdruck, ein `/` dort oeffnet ein Regex-Literal. */
const VOR_AUSDRUCK = new Set([
  'await', 'case', 'delete', 'do', 'else', 'in', 'instanceof', 'new', 'of',
  'return', 'throw', 'typeof', 'void', 'yield',
]);

function regexErlaubt(zuletzt, wort) {
  if (zuletzt === '') return true;
  if (/[\w$]/.test(zuletzt)) return VOR_AUSDRUCK.has(wort);
  return !')]}'.includes(zuletzt);
}
