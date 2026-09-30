/**
 * Modul: Welche Pluralvarianten eine Locale tragen darf (#1473)
 * Zweck: Geteilter Leser fuer die Schluesselparitaet der App-Locales
 *        (test-i18n.js, test-frontend-audit.js). Jede Locale traegt den
 *        Schluesselsatz von de.json; darueber hinaus darf sie genau die
 *        Pluralvarianten `<key>_<kategorie>` tragen, die ihre eigene Sprache
 *        braucht - und nur fuer Schluessel, die in de.json eine `_one`-Variante
 *        haben. Allowlist statt Denylist: alles andere bleibt ein Fehler.
 *
 *        Warum nicht einfach der volle Satz in jeder Sprache (Stand bis #1473):
 *        de.json ist zugleich die Rueckfall-Locale von t(). Traegt de eine
 *        Variante, die eine Sprache nicht hat, zieht t() dort den DEUTSCHEN Text.
 *        Also darf de nur Varianten tragen, die das Deutsche selbst waehlt (one,
 *        other), und die Sprachen mit few/two/many tragen ihre Formen allein.
 */

const VARIANT = /^(.+)_(zero|one|two|few|many|other)$/;

/** CLDR-Kategorien einer Locale laut Laufzeit (ganze Zahlen UND Brueche). */
export function pluralCategories(locale) {
  try {
    return new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
  } catch {
    return [];
  }
}

const keyList = (keys) => (keys instanceof Map ? [...keys.keys()] : [...keys]);

/**
 * Darf `locale` den Schluessel `key` tragen, obwohl die Referenz ihn nicht hat?
 * Nur als Pluralvariante eines Schluessels mit `_one` in der Referenz, und nur
 * fuer eine Kategorie, die Intl.PluralRules(locale) kennt.
 */
export function allowedPluralVariant(key, reference, locale) {
  const m = VARIANT.exec(key);
  if (!m) return false;
  return reference.has(`${m[1]}_one`) && pluralCategories(locale).includes(m[2]);
}

/**
 * Vergleich eines Schluesselsatzes mit der Referenz. `missing`: Referenz-
 * Schluessel, die fehlen (streng - sonst faellt t() auf de zurueck). `extra`:
 * Schluessel, die weder in der Referenz stehen noch eine erlaubte Variante sind.
 */
export function keySetDiff(reference, keys, locale) {
  const own = new Set(keyList(keys));
  return {
    missing: keyList(reference).filter((k) => !own.has(k)),
    extra: [...own].filter((k) => !reference.has(k) && !allowedPluralVariant(k, reference, locale)),
  };
}

/**
 * Pluralvarianten der Referenz selbst, die ihre eigene Sprache nie waehlt
 * (`_few` in de.json). Jede andere Locale muesste sie dann tragen, und wo sie
 * fehlt, landet der deutsche Text in der Oberflaeche.
 */
export function foreignReferenceVariants(reference, referenceLocale) {
  const cats = pluralCategories(referenceLocale);
  return keyList(reference).filter((k) => {
    const m = VARIANT.exec(k);
    return m && reference.has(`${m[1]}_one`) && !cats.includes(m[2]);
  });
}
