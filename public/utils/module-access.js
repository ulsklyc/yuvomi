/**
 * Modul: Darf ich in dieses Modul schreiben? (#1265, Fundament)
 * Zweck: EINE Antwort auf diese Frage - fuer das EIGENE Modul einer Seite und
 *        fuer ein FREMDES, in das ein Bedienelement schreibt. Gefragt wird mit
 *        dem API-Pfad, den die Handlung beschreiben wuerde, so wie `api.post()`
 *        ihn bekommt (ohne `/api/v1`). Beantwortet wird er aus derselben
 *        Zuordnung, nach der der Server urteilt (`server/scopes.js`), und aus
 *        denselben Rechten, aus denen `applyModuleReadonly()` im Router liest
 *        (`/permissions.js`, fail-open wie dort).
 * Abhaengigkeiten: /permissions.js
 *
 * WARUM AM PFAD UND NICHT AM NAMEN. Wer vom Pfad auf das Modul schliesst, raet
 * falsch: `calendar` besitzt auch `/reminders` und `/birthdays`, `meals` auch
 * `/recipes` und `/recipe-providers`, `budget` auch `/split-expenses`. Genau so
 * zeigte der Aufgaben-Dialog einen Erinnerungs-Schalter, dessen Speichern mit
 * 403 endete (#1253) - die Seite fragte `tasks`, der Server urteilte `calendar`.
 *
 * WARUM EINE KOPIE DER TABELLE UND KEIN ENDPUNKT. Ein Browser-Modul kann
 * `server/scopes.js` nicht importieren. Die Zuordnung ueber `/auth/me`
 * auszuliefern hiesse: eine Serveraenderung, eine Antwort, die bei jedem Start
 * mitwaechst, und eine Frage, die vor dem Laden anders ausfaellt als danach.
 * Die Tabelle aendert sich dagegen nur mit dem Code - also steht sie hier, und
 * `npm run test:module-write-access` haelt sie gegen das Original: die Tabelle
 * Eintrag fuer Eintrag und das URTEIL fuer jeden Pfad, den `public/` an die API
 * schickt, je Modul und Zugriffsstufe gegen `sessionModuleAccessRequirement()`
 * und `moduleAccessVerdict()` des Servers. Laeuft eine Seite auseinander, ist
 * die Suite rot, bevor ein Knopf das Falsche verspricht.
 *
 * DREI ZUSTAENDE, NICHT ZWEI. `pathAccess()` liefert `none`, `read` oder
 * `write`; `mayWritePath()` beantwortet nur die Schreibfrage. Wer zwischen
 * „sperren" und „entfernen" unterscheiden muss, braucht die drei Stufen
 * (`isNavModuleReadOnly()` prueft nur `=== 'read'` und sieht `none` nicht).
 *
 * WAS NICHT GESPERRT WIRD. Ein Pfad ohne Modul (`/auth`, `/preferences`) und
 * ein Scope-Modul ohne Rechte-Eintrag (`dashboard` mit `/quick-links`,
 * `weather`, `family`, `search`) sind fuer eine Sitzung nie eingeschraenkt:
 * `server/permissions.js` fuehrt sie nicht, die Rechte aus `/auth/me` nennen
 * sie also nie, und `moduleAccessVerdict()` laesst ein nicht genanntes Modul
 * durch. Der Helfer sagt dort deshalb `write`. `components/quick-links-manager.js`
 * bleibt bewusst ohne Sperre - eine UI-Sperre gegen ein Serverrecht, das es
 * nicht gibt, waere eine zweite Wahrheit.
 *
 * ---------------------------------------------------------------------------
 * REGELN FUER DIE SEITEN AUS #1265 (P1-P8) - hier, weil hier sucht, wer fragt.
 * ---------------------------------------------------------------------------
 *
 * 1. EIGENES MODUL: die Seite fuehrt EIN `readOnly()` (`waste.js` ist das
 *    Vorbild) - `!mayWritePath('/<praefix>')` ist gleichwertig zu
 *    `isNavModuleReadOnly('<nav>')` der fertigen Seiten. FREMDES MODUL: immer
 *    dieser Helfer, mit dem Pfad, den die Handlung schreibt, gefragt AM
 *    Bedienelement. `applyModuleReadonly()` urteilt nur ueber das gerade offene
 *    Nav-Modul und kann einen Kreuzpfad grundsaetzlich nicht fangen.
 *
 * 2. ZUSTAND BLEIBT ALS ZEICHEN, HANDLUNG VERSCHWINDET, und die Antwort folgt
 *    dem DATENSATZ: ein gesetzter Wert wird gesperrt, ein leerer entfaellt;
 *    `none` entfernt (#1252, #1253). Zwei Linien: das Markup nimmt die
 *    Affordanz, eine `READ_SAFE_ACTIONS`-Positivliste im delegierten Handler
 *    nimmt den Effekt - eine morgen ergaenzte Schreib-Aktion ist so
 *    standardmaessig zu.
 *
 * 3. WISCHEN UND ZIEHEN (`shopping.js` Wischgeste, `meals.js` Ziehen) haben KEIN
 *    Markup, das man wegnehmen koennte. Bei Nur-lesen bleibt die VERDRAHTUNG
 *    aus: kein `wireSwipeRows()`, kein `makeSortable()`, keine `drop`-Listener.
 *    Ein Riegel im Ende-Handler reicht nicht - dann ist die Zeile schon
 *    verschoben oder weggewischt, bevor jemand fragt. Vorbild ist
 *    `components/document-attach.js`: ohne Hochladen-Recht haengt am Feld kein
 *    `drop`.
 *
 * 4. WANDTABLETT: eine Ausnahme, die ERLAUBNIS steuert, kommt nur aus
 *    `server/display-scopes.js` (`DISPLAY_WRITE_ROUTES`), und jede betroffene
 *    Stelle fragt `actingAsDisplay()` ZUERST (#1209). `DISPLAY_ACTING_MODULES`
 *    in `router.js` steuert nur einen Hinweistext - wer daraus eine Erlaubnis
 *    ableitet, baut die zweite Wahrheit. Dieser Helfer kennt das Display
 *    nicht: die Rechte aus `/auth/me` stehen dort schon auf read/none, aber fuer
 *    Module ohne Rechte-Eintrag (dashboard, weather) sagt er `write`, waehrend
 *    die Token-Scopes des Geraets nur lesen lassen.
 *
 * 5. `/schedule/preferences` (S-12): der Server senkt fuer GENAU diesen Pfad das
 *    noetige Niveau auf `read` (`sessionModuleAccessRequirement`). Der Helfer
 *    bildet das exakt ab, damit er nie strenger urteilt als der Server. NICHT
 *    als Vorlage kopieren: eine Ausnahme entsteht am Server und nur dort; eine
 *    Seite, die sich selbst eine baut, verspricht einen Knopf, den der Server
 *    abweist.
 *
 * 6. NAMENSKOLLISION: `renderExpenses(readOnly)` in `split-expenses.js` meinte
 *    „archivierte Gruppe", nicht das Modulrecht. Seit P7 heisst der Parameter
 *    `asList`, und der Aufrufer odert Archiv und Modulrecht ausdruecklich
 *    hinein. Dieselbe Regel fuer jede weitere Stelle: zwei Bedeutungen unter
 *    einem Namen sind ein Rueckfall, der beim naechsten Umbau passiert.
 *
 * 7. KATEGORIE-VERWALTER (`components/category-manager.js`): der AUFRUFER
 *    versteckt den Ausloeser mit seinem `readOnly()`, die Komponente fragt
 *    nicht selbst. Jeder `basePath` gehoert dem Modul der Seite, die ihn
 *    oeffnet (der Guard in der Suite haelt das), also ist die Frage dieselbe,
 *    die die Seite fuer ihre anderen Knoepfe ohnehin stellt. Vorbild:
 *    `tasks.js` (`#btn-manage-categories` hinter `readOnly()`).
 *
 * 8. KREUZTRANSFER DER KUECHE, ENTSCHIEDEN (#1290): `POST /meals/:id/to-shopping-list`,
 *    `/meals/week-to-shopping-list` und `/recipes/:id/to-shopping-list`
 *    schreiben Einkaufsdaten, obwohl der Pfad-Guard sie als `meals` misst.
 *    Der Server verlangt dort jetzt zusaetzlich das Schreibrecht auf
 *    `shopping` - und umgekehrt `meals` fuer
 *    `/shopping/:listId/import-meal-plan`. Die Knoepfe fragen BEIDE Riegel,
 *    den Pfad, den sie posten (der Pfad-Guard), UND das Ziel (Regel 1):
 *    `mayTransferMealToShopping()`, `mayTransferRecipeToShopping()` und
 *    `mayImportMealPlan()` in `utils/kitchen-transfer.js`. Fuer das REZEPT
 *    senkt der Server den Pfad-Guard auf `meals: read` (entschieden am
 *    22.09.2026: die Route liest die Quelle und schreibt nur das Ziel;
 *    `READ_LEVEL_WRITES` in server/scopes.js, fuer Mitglieder und Tokens).
 *    `mayWritePath()` bildet das ueber die Kopie derselben Tabelle exakt ab
 *    wie Regel 5 - dieselbe Warnung gilt: keine Seite baut sich so etwas
 *    selbst. Die Mahlzeit bleibt bei `meals: write`, ihre Route kippt
 *    `on_shopping_list` im Plan. Nur das Ziel zu fragen zeigte dort einem
 *    Mitglied mit `meals: read` einen Knopf, den der Pfad-Guard abweist. Das
 *    Zielrecht gilt nur fuer AUSDRUECKLICHE Uebertraege.
 *    VORRAT UND EINKAUF (#1265 P4) sind das einfachere Paar: beide Routen
 *    lesen die Quelle nur. Der Pfad-Guard misst das ZIEL -
 *    `POST /shopping/:id/import-pantry` als `shopping`,
 *    `POST /pantry/import-shopping` als `pantry` -, das Leserecht der QUELLE
 *    fragt die Route selbst (`mayReadModule()` in server/permissions.js).
 *    Am Knopf ist das keine zweite Frage: er steht auf der Seite der Quelle,
 *    und die sieht nur, wer sie lesen darf. Also EIN Riegel je Richtung:
 *    `mayTransferPantryToShopping()` und `mayTransferShoppingToPantry()`,
 *    ebenfalls in `utils/kitchen-transfer.js`. Wandert einer dieser Knoepfe
 *    auf eine fremde Seite, braucht er das Quellrecht als zweiten Riegel.
 *    Was eine Aktion bloss MITerzeugt (der Check-in der Haushaltshilfe legt
 *    Termin und Zahlungsaufgabe an), fragt kein Zielrecht, weder am Server
 *    noch am Knopf - die Abgrenzung steht in docs/DECISIONS.md, Abschnitt 10.
 *
 * 9. LESEANSICHT BEI `read`, ENTSCHIEDEN (#1265): ein Datensatz oeffnet bei
 *    `read` eine Leseansicht mit ALLEM, was der Editor zeigt - nicht den
 *    Editor mit abgeschalteten Teilen und nicht bloss die Felder der Zeile.
 *    Vorbild ist `openNoteReadModal()` in `notes.js` (P1, #1311). Damit gilt
 *    Regel 2 auch fuer Felder, die NUR im Editor stehen: wer lesen darf, sieht
 *    sie, als Zeichen statt als Eingabe. Und ein Leertext, der zu einer
 *    Handlung einlaedt („Tippe auf + ...“), entfaellt bei `read` zusammen mit
 *    dem Knopf, den er meint: `action: readOnly() ? null : ...` allein laesst
 *    `hint` und `description` des Leerzustands stehen.
 *    FUEHRT DER TIPP SCHON WOANDERSHIN, weil er nicht den Datensatz selbst
 *    oeffnet, steht ein Wert, der sonst nur im Editor stand, bei `read` dort,
 *    wo der Tipp landet - einen neuen Knopf nur zum Lesen gibt es nicht. Ein
 *    Konto oeffnet den Kontoauszug, also kommt der Kreditrahmen in dessen
 *    Kopf; eine Split-Gruppe wird per Tipp nur ausgewaehlt, also kommen
 *    Standardwaehrung, Standardaufteilung und Mitglieder als kompakte Zeile
 *    in den Gruppenkopf (entschieden am 21.09.2026 fuer #1352).
 */

import { moduleAccess } from '/permissions.js';

/**
 * Kopie von `SCOPE_MODULES` aus server/scopes.js - Reihenfolge und Inhalt
 * gleich, der Drift-Guard vergleicht Eintrag fuer Eintrag. Aendern heisst:
 * dort aendern, hier nachziehen.
 */
export const SCOPE_MODULES = Object.freeze([
  { key: 'tasks',        prefixes: ['tasks'] },
  { key: 'shopping',     prefixes: ['shopping'] },
  { key: 'meals',        prefixes: ['meals', 'recipes', 'recipe-providers'] },
  { key: 'pantry',       prefixes: ['pantry'] },
  { key: 'inventory',    prefixes: ['inventory'] },
  { key: 'calendar',     prefixes: ['calendar', 'reminders', 'birthdays'] },
  { key: 'notes',        prefixes: ['notes'] },
  { key: 'contacts',     prefixes: ['contacts'] },
  { key: 'schedule',     prefixes: ['schedule'] },
  { key: 'budget',       prefixes: ['budget', 'split-expenses'] },
  { key: 'documents',    prefixes: ['documents'] },
  { key: 'health',       prefixes: ['health'] },
  { key: 'rewards',      prefixes: ['rewards'] },
  { key: 'housekeeping', prefixes: ['housekeeping'] },
  { key: 'waste',        prefixes: ['waste'] },
  { key: 'weather',      prefixes: ['weather'] },
  { key: 'family',       prefixes: ['family'] },
  { key: 'dashboard',    prefixes: ['dashboard', 'quick-links'] },
  { key: 'search',       prefixes: ['search'] },
].map((mod) => Object.freeze({ key: mod.key, prefixes: Object.freeze(mod.prefixes) })));

const PREFIX_TO_MODULE = new Map(
  SCOPE_MODULES.flatMap((mod) => mod.prefixes.map((prefix) => [prefix, mod.key])),
);

/** Den Pfad so zuschneiden, wie ihn der Server als `req.path` sieht: ohne Query und Anker. */
function requestPath(path) {
  return String(path ?? '').split(/[?#]/, 1)[0];
}

/**
 * Das Scope-Modul eines API-Pfads - dieselbe Regel wie `moduleForPath()` in
 * server/scopes.js: Schreibweise gefaltet (Express routet ohne sie), erst ein
 * zweiteiliger Praefix, dann das erste Segment. Erweiterungen
 * (`/extensions/<id>`) meldet der Server erst zur Laufzeit an; hier bleiben sie
 * `null` und damit ungesperrt - ihre Seiten fragen ueber `permissionModuleKey`.
 * @param {string} path z. B. "/reminders?entity_type=task"
 * @returns {string|null}
 */
export function moduleForApiPath(path) {
  const parts = requestPath(path).replace(/^\/+/, '').toLowerCase().split('/').filter(Boolean);
  if (parts.length >= 2) {
    const compound = PREFIX_TO_MODULE.get(`${parts[0]}/${parts[1]}`);
    if (compound) return compound;
  }
  return PREFIX_TO_MODULE.get(parts[0]) || null;
}

/**
 * Die Zugriffsstufe fuer das Modul hinter einem Pfad: 'none' | 'read' | 'write'.
 * Ohne Modul - oder fuer ein Modul ohne Rechte-Eintrag - ist sie `write`,
 * genau wie am Server (siehe Kopf).
 * @param {string} path
 * @returns {'none'|'read'|'write'}
 */
export function pathAccess(path) {
  const key = moduleForApiPath(path);
  return key ? moduleAccess(key) : 'write';
}

/**
 * Kopie von `READ_LEVEL_WRITES` aus server/scopes.js - die benannten
 * Ausnahmen, fuer die der Server bei einem schreibenden Aufruf `read` reicht
 * (Regel 5 und Regel 8 im Kopf). Der Drift-Guard in
 * `npm run test:module-write-access` vergleicht Eintrag fuer Eintrag. Aendern
 * heisst: dort aendern, hier nachziehen - eine Seite baut sich keine eigene.
 */
export const READ_LEVEL_WRITES = Object.freeze([
  Object.freeze({
    id: 'schedule-preferences',
    pattern: '^\\/schedule\\/preferences$',
    flags: '',
    methods: null,
    axes: Object.freeze(['session']),
  }),
  Object.freeze({
    id: 'recipe-to-shopping',
    pattern: '^\\/recipes\\/\\d+\\/to-shopping-list\\/?$',
    flags: 'i',
    methods: Object.freeze(['POST']),
    axes: Object.freeze(['session', 'token']),
  }),
]);

// Die Oberflaeche ist eine Sitzung: sie liest nur die Eintraege dieser Achse.
// Die Methode kennt der Helfer nicht - `mayWritePath()` fragt immer nach einem
// Schreibaufruf, und unter den Pfaden der Tabelle gibt es jeweils nur die
// Methoden, die sie nennt.
const SESSION_READ_LEVEL = READ_LEVEL_WRITES
  .filter((entry) => entry.axes.includes('session'))
  .map((entry) => new RegExp(entry.pattern, entry.flags));

/**
 * Wuerde der Server einen SCHREIBENDEN Aufruf auf diesen Pfad annehmen?
 * Fuer die Pfade aus `READ_LEVEL_WRITES` reicht `read` (nie `none`).
 * @param {string} path
 * @returns {boolean}
 */
export function mayWritePath(path) {
  const access = pathAccess(path);
  const p = requestPath(path);
  if (SESSION_READ_LEVEL.some((re) => re.test(p))) return access !== 'none';
  return access === 'write';
}
