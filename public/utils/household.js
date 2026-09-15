/**
 * Wie gross der Haushalt ist - und was die Oberflaeche daraus ableiten darf.
 *
 * DIE REGEL: WAS NUR EINE SINNVOLLE BELEGUNG HAT, WIRD NICHT GEFRAGT.
 *
 * PRODUCT.md fuehrt seit 2026-08-06 Solo-Nutzer als bestaetigte zweite
 * Zielgruppe, und die Oberflaeche wusste davon nichts (Critique 2026-08-10,
 * Persona Miriam): das prominenteste Widget des Dashboards zeigte ihr eine
 * grosse 1 mit „im Haushalt" - ein Zaehler, dessen einziger Inhalt ist, dass
 * sie allein ist. Jede Aufgabe trug das Pflichtfeld „Sichtbarkeit: Alle
 * Familienmitglieder" mit dem Hilfetext „Legt fest, wer diesen Eintrag sieht",
 * fuer einen Haushalt von einer Person also ein Feld mit genau einer Antwort,
 * auf jeder Karte. „Zugewiesen an" bot sie selbst und „- Niemand -".
 *
 * EIN STILLER SCHALTER, KEINE EINSTELLUNG. Der Haushalt hat eine Groesse, die
 * App kann sie zaehlen, und ein Schalter fuer etwas Zaehlbares waere ein
 * Formular fuer eine Frage, die niemand stellen wollte - dazu einer, den
 * Solo-Nutzer erst faenden, nachdem sie die Bevormundung schon gesehen haben.
 * Es ist derselbe Mechanismus, den der Block-2-Brief fuer das
 * Ueberlappungszeichen bereits festgelegt hat: „erscheint nur, wenn es mehr als
 * einen moeglichen Beteiligten gibt; im Solo-Haushalt entfaellt es still".
 *
 * WAS DER SCHALTER NICHT TUT: er aendert keine Daten. Ein Eintrag behaelt seine
 * `visibility` und seine Zuweisung; nur gefragt wird nicht mehr danach. Kommt
 * ein zweites Mitglied dazu, stehen alle Felder wieder da, und alles, was
 * waehrenddessen entstanden ist, hat schon die richtigen Werte. Ein Schalter,
 * der Daten wegnimmt, waere eine Migration - dieser ist eine Darstellung.
 *
 * WARUM AUCH EINE WURZELKLASSE: manche Stellen sind reines Layout (die Breite
 * einer Zuweisungs-Spalte, ein Trenner zwischen zwei Feldern) und haben gar
 * kein JS, das fragen koennte. `html.household-solo` ist fuer die dieselbe
 * Antwort wie `isSoloHousehold()` fuer den Rest - eine Quelle, zwei Wege.
 */

let _size = null;

/**
 * Uebernimmt die Haushaltsgroesse aus einer Auth-Antwort (`/auth/me`,
 * `/auth/login`) und spiegelt sie an die Wurzel.
 *
 * Ein fehlender Wert setzt NICHT zurueck: aeltere Antworten (ein Client, der
 * waehrend eines Updates offen bleibt) wuerden den Haushalt sonst kurzzeitig
 * auf „unbekannt" stellen und die Felder flackern lassen.
 *
 * @param {number|undefined} size
 */
export function setHouseholdSize(size) {
  if (!Number.isFinite(size) || size < 1) return;
  _size = size;
  document.documentElement.classList.toggle('household-solo', size === 1);
}

/** Setzt den Zustand beim Abmelden zurueck - der naechste Nutzer zaehlt neu. */
export function clearHouseholdSize() {
  _size = null;
  _otherReaders = null;
  document.documentElement.classList.remove('household-solo');
}

/**
 * Genau ein Mensch im Haushalt.
 *
 * Die Voreinstellung ist `false`, solange nichts bekannt ist: eine Oberflaeche,
 * die im Zweifel zu VIEL fragt, ist unbequem - eine, die im Zweifel zu wenig
 * fragt, verliert eine Angabe, die der Nutzer machen wollte.
 */
export function isSoloHousehold() {
  return _size === 1;
}

/** Die gezaehlte Groesse, oder `null`, solange keine Auth-Antwort da war. */
export function getHouseholdSize() {
  return _size;
}

let _otherReaders = null;

/**
 * Die Module, die ausser dem angemeldeten Konto noch jemand lesen kann
 * (`othersCanRead` aus einer Auth-Antwort). Ein fehlender Wert setzt NICHT
 * zurueck - aus demselben Grund wie bei setHouseholdSize().
 *
 * @param {string[]|undefined} modules
 */
export function setOtherReaders(modules) {
  if (!Array.isArray(modules)) return;
  _otherReaders = new Set(modules);
}

/** Kann ausser dem angemeldeten Konto noch jemand dieses Modul lesen? */
export function othersCanRead(moduleKey) {
  return _otherReaders?.has(moduleKey) ?? false;
}

/**
 * Verschwinden die Schutzsteuerungen eines Moduls (Sichtbarkeit, Sperre,
 * Freigabe)?
 *
 * SCHUTZ IST KEINE LISTE (#1207). Die Haushaltsgroesse zaehlt nur Mitglieder,
 * ein Haushalt aus einer Person und Hauspersonal ist also solo - fuer die
 * Anzeige (Familien-Widget, Avatar-Marken) richtig. Eine Sichtbarkeit aber
 * schuetzt vor allen, die mitlesen koennen: kann ausser dem Nutzer irgendein
 * Konto das Modul lesen - Mitglied, Hauspersonal oder Gast mit Zugriff -,
 * bleiben die Felder stehen. Sonst bliebe jeder neue Eintrag bei "alle" und
 * waere fuer genau diese Konten lesbar.
 */
export function hidesPrivacyControls(moduleKey) {
  return isSoloHousehold() && !othersCanRead(moduleKey);
}
