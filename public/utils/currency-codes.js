/**
 * Die Liste der wählbaren Währungen - EINMAL, für Frontend und Backend.
 *
 * Vorher stand sie viermal wörtlich im Repo (Einstellungen, Abos, Preferences-
 * Route, Geteilte Ausgaben), zusammengehalten von zwei Guards, die den Quelltext
 * der vier Stellen per Regex verglichen. Das hat funktioniert, aber es war die
 * teure Antwort auf die falsche Frage: eine Währung aufzunehmen hiess, vier
 * Listen anzufassen, und wer eine vergass, bekam genau den Zustand, den der
 * Kommentar in test-settings-navigation.js beschreibt - KRW, IDR und IRR waren
 * im Haushalt einstellbar und in Abos und Geteilten Ausgaben nicht wählbar.
 *
 * ISOMORPH UND DESHALB GETEILT (Allowlist in test/test-layer-boundary.js): die
 * Datei ist eine reine Konstante ohne DOM- und ohne Node-Bezug. Der Server
 * validiert damit, der Browser baut daraus seine Auswahl - dieselbe Begründung
 * wie bei sync-target.js: zwei Definitionen desselben Vorrats wachsen
 * auseinander, und zwar dort, wo es niemandem auffaellt.
 *
 * ALPHABETISCH SORTIERT nach ISO-4217-Code. Die Reihenfolge ist zugleich die
 * Reihenfolge im Dropdown (die Anzeige ergänzt der Browser über
 * Intl.DisplayNames), also ist die Sortierung Teil der Zusage, nicht Kosmetik.
 *
 * Nachkommastellen und Symbol stehen bewusst NICHT hier: beides liefert
 * Intl.NumberFormat aus dem CLDR - JPY ohne Nachkommastellen, ILS mit ₪ (#841).
 * Eine eigene Tabelle dafür waere die naechste zweite Wahrheit.
 *
 * VND STEHT HIER, WEIL EINE AUSGELIEFERTE SPRACHE IHRE WAEHRUNG BRAUCHT (#297).
 * Der Code war beim Vereinheitlichen der vier Kopien (#340) unter den Tisch
 * gefallen, waehrend `vi.json` weiter ausgeliefert wurde und
 * `services/split-expenses.js` VND weiter als nachkommastellenfreie Waehrung
 * fuehrte - ein vietnamesischer Haushalt konnte die App auf seiner Sprache
 * benutzen und seine Waehrung nicht waehlen. Zwei Monate hat das niemand
 * gemeldet, deshalb haelt der Guard in `test:region-presets` jetzt jede
 * gelieferte Locale gegen mindestens ein Region-Preset.
 */
export const CURRENCY_CODES = Object.freeze([
  'AED', 'ARS', 'AUD', 'BBD', 'BOB', 'BRL', 'BSD', 'BYN', 'BZD', 'CAD', 'CHF', 'CLP',
  'CNY', 'COP', 'CRC', 'CUP', 'CZK', 'DKK', 'DOP', 'EUR', 'GBP', 'GTQ', 'GYD',
  'HNL', 'HTG', 'HUF', 'IDR', 'ILS', 'INR', 'IRR', 'JMD', 'JPY', 'KRW', 'KZT', 'MXN',
  'MYR', 'NIO', 'NOK', 'NZD', 'PAB', 'PEN', 'PHP', 'PLN', 'PYG', 'RUB', 'SAR',
  'SEK', 'SGD', 'SRD', 'TRY', 'TTD', 'UAH', 'USD', 'UYU', 'VES', 'VND', 'XCD', 'ZAR',
]);
