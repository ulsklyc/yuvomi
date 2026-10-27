/**
 * Modul: Die eine Regel fuer "dieser Satz der API ist deutsch" (#1694, #1695)
 * Zweck: `error` ist Teil der zugesagten `/api/v1`-Oberflaeche und spricht
 *        Englisch. test:budget-error-language (Budget) und
 *        test:api-error-language (alle uebrigen Routen) lesen dieselbe Regel
 *        und denselben Leser, damit ein Satz, den der eine Guard durchlaesst,
 *        nicht am anderen haengen bleibt.
 *
 *        GERMAN: Umlaute und ß, dazu die Woerter, aus denen die alten Saetze
 *        und Feldnamen bestanden, und die naheliegenden Nachbarn. Wortgrenzen,
 *        damit "Type" nicht an "Typ" haengen bleibt. "Name", "Bank" und
 *        "Region" sind in beiden Sprachen dasselbe Wort und fehlen deshalb.
 *
 *        AUSNAHME, bewusst: "must be one of: <Schluessel>" zaehlt die
 *        erlaubten Werte auf, und die Schluessel der mitgelieferten
 *        Einnahmekategorien sind deutsche Woerter ("Erwerbseinkommen"). Das
 *        sind gespeicherte Daten, kein Wortlaut; die Aufzaehlung wird vor der
 *        Pruefung ausgeblendet.
 */

export const GERMAN = new RegExp(
  '[äöüÄÖÜß]|\\b(?:'
  + 'muss|müssen|darf|dürfen|sein|liegen|haben|zwischen|und|oder|nicht|ist|sind|kein|keine|als|'
  + 'ungültig|ungueltig|gültig|gueltig|gefunden|erforderlich|fehlt|groesser|kleiner|höchstens|mindestens|'
  + 'Zeichen|Betrag|Titel|Datum|Monat|Kategorie|Unterkategorie|Intervall|Anzahl|Wiederholung|'
  + 'Konto|Kontotyp|Startsaldo|Kreditlimit|Farbe|Waehrung|Typ|Darlehen|Buchung|Eintrag|Serie|'
  + 'Interner|Fehler|Erlaubt|erwartet|Mahlzeit|Zeitzone|Sprache|Wochenstart|Anbieter|Einheit|'
  + 'Authentifizierung|Abrufen|Notiz|Kontakt|Inhalt|Termin|Kalender|Abonnement|Kilometerstand|'
  + 'Ländercode|Regionscode|Gruppencode|Erinnerungen|maximal|enthält|beim|bei|der|das|'
  + 'Unbekannte|Unbekannter|Nutzer|Aufgaben|zu|nur|'
  + 'Vorname|Nachname|Zweitname|Namenszusatz|Namenssuffix|Telefon|Adresse|Notizen|Geburtstag|Pflichtfeld|Menge'
  + ')\\b',
  'i',
);

/** Die Aufzaehlung erlaubter Werte ist Datenbestand, kein Wortlaut (siehe Kopf). */
const withoutKeyList = (sentence) => sentence.replace(/must be one of: [^.]*\./g, 'must be one of: <keys>.');

/** Das erste deutsche Wort im Satz, oder null. */
export function germanIn(sentence) {
  const m = withoutKeyList(String(sentence)).match(GERMAN);
  return m ? m[0] : null;
}

// Gelesen werden nur Zeilen, an denen ein Satz die Datei Richtung Antwort
// verlaesst: ein `error:`, ein `refusal(`, ein Aufruf eines geteilten
// Validators (dessen zweites Argument als Feldname im Satz landet). Kommentare
// bleiben deutsch und zaehlen nicht.
const OUTBOUND = /\berror:|\brefusal\(|\b(?:str|num|oneOf|rrule|collectErrors|validateDate|validateMonth|validateColor)\(/;
const LITERAL = /'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;

/** Die Literale der Zeilen, an denen ein Satz oder Feldname hinausgeht. */
export function outboundLiterals(source) {
  const found = [];
  source.split('\n').forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
    if (!OUTBOUND.test(line)) return;
    for (const m of line.matchAll(LITERAL)) found.push({ line: i + 1, text: m[1] ?? m[2] });
  });
  return found;
}
