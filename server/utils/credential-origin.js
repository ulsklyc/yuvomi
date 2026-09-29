/**
 * Modul: Empfaenger gespeicherter Zugangsdaten
 * Zweck: Eine Regel fuer CalDAV und CardDAV. DAS GESPEICHERTE PASSWORT EINES
 *        KONTOS GEHOERT ZU EINEM SERVER UND EINEM BENUTZER: wer beim Bearbeiten
 *        Server oder Benutzernamen wechselt, muss es neu eingeben. Sonst reichte
 *        eine fremde Adresse und ein leeres Passwortfeld, und der naechste
 *        Verbindungstest oder Sync schickte die Zugangsdaten des Haushalts per
 *        Basic Auth dorthin.
 */

/**
 * Ob zwei Konto-Adressen denselben Empfaenger fuer die Zugangsdaten meinen:
 * Schema, Host und Port, normalisiert ueber `URL` (Host in Kleinschrift,
 * Standardport entfaellt). Der Pfad zaehlt nicht - er waehlt auf demselben
 * Server nur eine andere Sammlung. Eine Adresse, die `URL` nicht versteht,
 * zaehlt nur bei woertlicher Gleichheit als dieselbe.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function sameCredentialOrigin(a, b) {
  const origin = (raw) => {
    try { return new URL(String(raw).trim()).origin; } catch { return null; }
  };
  const oa = origin(a);
  const ob = origin(b);
  if (oa === null || ob === null || oa === 'null' || ob === 'null') {
    return String(a).trim() === String(b).trim();
  }
  return oa === ob;
}
