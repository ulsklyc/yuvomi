/**
 * Modul: Modul → Ton
 * Zweck: EIN MODUL, EIN TON - die Zuordnung Modul-Id auf Farb-Token, an genau
 *        einer Stelle. Das Gegenstueck zu `MODULE_ICON` (nav-icons.js), und aus
 *        demselben Anlass entstanden wie jenes.
 * Ausfuehren: keine eigene Suite - gehalten von `test:frontend-audit`
 *        (Vollton-Regel, Sidebar-Legende) und `test:kitchen-tabs`.
 * Dependencies: keine. Das ist Absicht, siehe unten.
 *
 * SIE STAND PRIVAT IN router.js, und wer sie ausserhalb der Leisten brauchte,
 * hatte keinen Zugriff: die MODUL-LISTE DER EINSTELLUNGEN fiel deshalb fuer
 * jede eingebaute Zeile auf `--color-accent` zurueck. Solange ihre Scheibe eine
 * 16-%-Waschung war, ist das niemandem aufgefallen - achtzehn blasse
 * Violett-Kacheln sehen aus wie achtzehn graue. Unter der Vollton-Regel
 * (DESIGN.md, Colors) waere daraus eine Wand identischer Violett-Scheiben
 * geworden, also genau die Aussage, die v2.20 abgeschafft hat: ein Modul sieht
 * gleich aus, wo immer es sich nennt. Die Regel hat den Rueckstand sichtbar
 * gemacht, nicht verursacht.
 *
 * WARUM DIE KUECHEN-IDS HIER STEHEN UND NICHT IN kitchen-tabs.js. Sie standen
 * dort, und der erste Anlauf hat sie von dort importiert - woraufhin sechzehn
 * Suiten mit „does not provide an export named KITCHEN_MODULES" starben, weil
 * der Browser-Loader kitchen-tabs.js stubt. Der naheliegende Ausweg (die Liste
 * in den Stub kopieren) ist genau die Bauart, die test-browser-loader-stubs.js
 * fuer /utils/date.js schon einmal aufgeraeumt hat: „ein Stub ist eine zweite
 * Kopie, die nur auseinanderlaufen kann". Also laeuft die Ableitung jetzt
 * andersherum - hier die Ids, dort die Routen daraus (`'/' + id`). Diese Datei
 * importiert nichts und braucht deshalb keinen Stub.
 */

/**
 * Die Kuechen-Gruppe, in der Reihenfolge ihres Kreislaufs:
 * planen → kochen → einkaufen → lagern. `KITCHEN_ROUTES` in kitchen-tabs.js
 * leitet sich hieraus ab.
 *
 * DIE BELEGBARE LAGE, an allen drei Stellen derselbe Satz (DESIGN.md,
 * tokens.css, hier): die Kueche ist im ROUTING vier Module - vier Eintraege in
 * ROUTES mit vier eigenen `module:`-Werten -, in NAVIGATION, AKZENT und
 * STATUSBAR aber eines. Ein Farbwechsel beim Tabwechsel sendete dieselbe
 * Botschaft wie ein Modulwechsel (Critique 2026-07-29).
 */
export const KITCHEN_MODULES = Object.freeze(['meals', 'recipes', 'shopping', 'catalog', 'pantry']);

/** Der Sammelname der Gruppe: er taucht in der Navigation auf, nie im Routing. */
const KITCHEN_GROUP_ID = 'kitchen';

/**
 * Das Farb-Token eines Moduls.
 * @param {string} mod Modul-Id (`navItems().module`, `BUILT_IN_MODULES[].id`)
 * @returns {string} Name der Custom Property, '' fuer eine leere Id
 */
export function moduleAccentToken(mod) {
  if (!mod) return '';
  return KITCHEN_MODULES.includes(mod) || mod === KITCHEN_GROUP_ID
    ? `--module-${KITCHEN_GROUP_ID}`
    : `--module-${mod}`;
}

/**
 * Derselbe Ton als fertiger `var()`-Ausdruck fuer ein style-Attribut.
 * @param {string} mod Modul-Id
 * @returns {string} `var(--module-x)` oder ''
 */
export function moduleAccentVar(mod) {
  const token = moduleAccentToken(mod);
  return token ? `var(${token})` : '';
}
