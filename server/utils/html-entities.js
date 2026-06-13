/**
 * Modul: HTML-Entity-Decoder
 * Zweck: Externe Texte (z. B. Kalendernamen aus der Google Calendar API für
 *        Import-Kalender) kommen gelegentlich HTML-entity-encoded zurück
 *        ("Termine &amp; Verabredungen"). Vor dem Speichern werden sie zu
 *        Klartext normalisiert — die DB hält Rohtext, die Render-Schicht
 *        escaped genau einmal. Ohne diese Normalisierung erscheint im UI das
 *        literale "&amp;".
 *
 * Bewusst klein gehalten (keine externe Abhängigkeit): deckt die fünf
 * vordefinierten XML-Entities plus numerische (dezimal/hex) Referenzen ab —
 * das genügt für Provider-Namen. `&amp;` wird zuletzt aufgelöst, damit doppelt
 * codierte Sequenzen wie "&amp;lt;" nicht versehentlich zu "<" werden.
 */

export function decodeHtmlEntities(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/&#x([0-9a-fA-F]+);/g, (m, hex) => codePoint(parseInt(hex, 16), m))
    .replace(/&#(\d+);/g, (m, dec) => codePoint(parseInt(dec, 10), m))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// Wandelt einen Code Point sicher in ein Zeichen; bei ungültigem Wert bleibt
// die ursprüngliche Entity erhalten statt einen RangeError zu werfen.
function codePoint(num, original) {
  if (!Number.isInteger(num) || num < 0 || num > 0x10ffff) return original;
  try {
    return String.fromCodePoint(num);
  } catch {
    return original;
  }
}
