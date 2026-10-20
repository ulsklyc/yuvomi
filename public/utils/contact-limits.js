/**
 * Modul: Kontakt-Grenzen (public/utils/contact-limits.js)
 * Zweck: Wie lang eine Telefonnummer eines Kontakts sein darf - EINE Zahl fuer
 *        das Einzelfeld `phone`, die Liste `phones[]` und das Eingabefeld des
 *        Formulars.
 * Abhaengigkeiten: keine (isomorph: Frontend und Server teilen dieses Modul,
 *        siehe Allowlist in test/test-layer-boundary.js)
 *
 * Hintergrund (#1909): Das Formular schickt die erste Nummer doppelt, als
 * `phone` und als ersten Eintrag von `phones`. Das Einzelfeld liess 100 Zeichen
 * zu, die Liste 50: eine Nummer mit 101 Zeichen hiess "hoechstens 100", nach
 * dem Kuerzen auf 60 "hoechstens 50".
 */

/** Hoechstlaenge einer Telefonnummer (Zeichen), Einzelfeld wie Listeneintrag. */
export const CONTACT_PHONE_MAX_LENGTH = 100;
