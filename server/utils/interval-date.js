/**
 * Modul: Monats-/Jahres-Addition mit Tages-Klemmung (Server-Eingang)
 * Zweck: die Rechnung steht in public/utils/interval-date.js, damit der Dialog
 *        der geteilten Ausgaben mit DERSELBEN Datei zaehlt wie der Buchungslauf
 *        (#1748). Diese Datei reicht sie nur durch; die Server-Module
 *        importieren weiter von hier.
 */
export * from '../../public/utils/interval-date.js';
