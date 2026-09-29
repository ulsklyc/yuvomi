/**
 * Modul: Tages-Beschriftung
 * Zweck: Einen Kalendertag so benennen, wie ein Mensch ihn nennt - „Heute",
 *        „Gestern", sonst der Wochentag mit Datum.
 * Abhaengigkeiten: i18n.js, utils/date.js, utils/timezone.js
 *
 * Steht hier und nicht in der Aufgabenseite, weil zwei Verlaeufe dieselbe Frage
 * stellen: die Verlaufsansicht des Moduls und der Serienverlauf in der
 * Leseansicht einer Aufgabe - und die Leseansicht wird inzwischen auch von der
 * Uebersicht und vom Kalender geoeffnet.
 *
 * Dazu die Stufung der Uebersicht nach vorn (`relativeDateLabel`: heute, morgen,
 * Wochentag, Tag und Monat) und der Beginn einer offenen Haushaltshilfe-Sitzung
 * (`housekeepingSinceLabel`) - beide lesen Uebersicht UND Heute-Blatt (#1452).
 */

import { t, getLocale, formatDate, formatDayMonth, formatTime } from '/i18n.js';
import { todayKey, addLocalDays } from '/utils/date.js';
import { zonedUTCProxy, zonedDateKey } from '/utils/timezone.js';

/**
 * Die Tages-Überschrift zu einem Datums-Key der Anzeigezone.
 *
 * DREI FALLEN AUF ENGEM RAUM, jede davon hier einmal eingebaut gewesen:
 *
 * 1. „Gestern" kommt aus `addLocalDays(today, -1)`, also aus Arithmetik auf dem
 *    KEY. Ein `Date` minus 86400000 ms trifft an der Sommerzeitgrenze den
 *    vorletzten Tag - und sobald die Anzeigezone von der des Browsers abweicht,
 *    liegt es ohnehin daneben, weil `parseLocalDateKey` seine Mitternacht in
 *    der Browserzone baut.
 * 2. Der Key geht ROH an `formatDate`. Ein Umweg über ein `Date` macht aus dem
 *    zonenlosen Kalendertag einen Zeitpunkt, den die Anzeigezone anschließend
 *    wieder umrechnet - und die Überschrift kann auf dem Nachbartag landen,
 *    während die Zeilen darunter alle vom richtigen stammen.
 * 3. `formatDate` nimmt genau EIN Argument (public/i18n.js). Ein
 *    Optionsobjekt daneben wird stillschweigend verworfen, und die als
 *    „Montag, 24. August" gedachte Zeile stand als „24.08.2026" da. Der
 *    Wochentag kommt deshalb über den `zonedUTCProxy`-Weg, wie im Dashboard.
 */
export function historyDayLabel(dayKey) {
  const today = todayKey();
  if (dayKey === today) return t('common.today');
  if (dayKey === addLocalDays(today, -1)) return t('common.yesterday');
  const proxy = zonedUTCProxy(`${dayKey}T12:00:00`);
  if (!proxy) return formatDate(dayKey);
  return new Intl.DateTimeFormat(getLocale(), {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC',
  }).format(proxy);
}

// Relatives Datumslabel: „Heute"/„Morgen", sonst das locale-formatierte Datum.
// Eigene Funktion, damit Aufrufer nur den Datumsteil brauchen, ohne ein
// zusammengesetztes „Datum, Zeit" per Komma zu zerschneiden (locale-fragil:
// manche Locales setzen selbst ein Komma ins Datum).
/**
 * „Heute"/„Morgen", sonst das Datum in Locale-Schreibweise.
 *
 * NIMMT EINEN DATUMS-KEY ODER EINEN ZEITPUNKT, und der Unterschied ist genau
 * der, den utils/timezone.js fuehrt: ein Key ('2026-08-25') ist zonenlos und
 * wird GELESEN, ein Zeitpunkt traegt seine Zone und wird UMGERECHNET.
 *
 * DIE PFLICHT LIEGT BEIM AUFRUFER. Ein `Date`, das jemand aus einem Key gebaut
 * hat, ist die gefaehrliche Mitte: `parseLocalDateKey('2026-08-25')` ist
 * Mitternacht der BROWSER-Zone und sieht damit aus wie ein Zeitpunkt, meint aber
 * einen Kalendertag. Durch die Anzeigezone gerechnet ist es einen Tag daneben -
 * derselbe Fehler, gegen den dieser Fix angetreten ist, nur ueber einen anderen
 * Weg. Wer einen Key hat, gibt den KEY her und baut kein Date daraus (#851).
 *
 * `zonedDateKey` unterscheidet die beiden Formen selbst: einen zonenlosen String
 * liest es, einen Zeitpunkt rechnet es um. Ein zweiter Zweig hier waere ein
 * Duplikat dieser Regel und wuerde beim naechsten Mal auseinanderlaufen.
 *
 * Vorher stand hier `d.toDateString() === new Date().toDateString()` - beide
 * Seiten in der Browser-Zone, also fuer jeden Betrachter ein anderes „heute".
 */
/*
 * NACH „MORGEN" KOMMT DER WOCHENTAG, NICHT DAS JAHR. Hier sprang das Label
 * direkt auf „26.09.2026" - drei Tage voraus mit Jahreszahl, wo ein Mensch
 * „Sa." sagt (Critique 2026-09-23). Die Stufen: heute, morgen, bis sechs Tage
 * voraus der kurze Wochentag (ab sieben waere er mehrdeutig: „Mi." hiesse
 * heute oder in einer Woche), danach Tag und Monat, das Jahr nur, wenn es
 * nicht das laufende ist. Vergangenes bekommt nie einen Wochentag - „Mo." fuer
 * letzten Montag liest sich als der naechste.
 *
 * Gerechnet wird auf den KEYS der Haushaltszone, nie auf einem `Date`: der
 * Abstand kommt aus `Date.UTC` ueber Jahr/Monat/Tag (zonenfrei und
 * sommerzeitfest), der Name aus demselben UTC-Mittag mit `timeZone: 'UTC'` -
 * die Technik von `zonedUTCProxy`. Der Name folgt der App-Sprache
 * (`getLocale`), Tag und Monat der Datumsschreibweise der Region.
 */
const WEEKDAY_LABEL_DAYS = 6;

function dayKeyNoonUtc(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12) : NaN;
}

export function relativeDateLabel(value) {
  if (value === null || value === undefined || value === '') return '';
  const day = zonedDateKey(value);
  if (!day) return formatDate(value);
  const today = todayKey();
  if (day === today) return t('common.today');
  if (day === addLocalDays(today, 1)) return t('common.tomorrow');
  const dayNoon = dayKeyNoonUtc(day);
  const ahead = Math.round((dayNoon - dayKeyNoonUtc(today)) / 86400000);
  if (ahead > 1 && ahead <= WEEKDAY_LABEL_DAYS) {
    return new Intl.DateTimeFormat(getLocale(), { weekday: 'short', timeZone: 'UTC' }).format(new Date(dayNoon));
  }
  // Der KEY geht an die Formatierer, nicht `value`: ein Zeitpunkt ist oben
  // schon in die Anzeigezone umgerechnet, ein zweites Mal waere doppelt.
  return day.slice(0, 4) === today.slice(0, 4) ? formatDayMonth(day) : formatDate(day);
}

/** „08:00" fuer einen Beginn heute, „22.09., 08:00" fuer einen aelteren -
 * eine offene Sitzung von gestern ist eine vergessene Abmeldung, keine
 * Anwesenheit, und die blosse Uhrzeit verschwiege genau das.
 *
 * Hier und nicht in der Uebersicht, weil Kennzahl-Kachel, Haushaltshilfe-
 * Widget UND Heute-Blatt dieselbe Sitzung beschreiben: das Blatt las nur die
 * Uhrzeit und sagte fuer den Beginn von gestern „seit 08:30" (#1452). */
export function housekeepingSinceLabel(since) {
  const time = formatTime(since);
  return zonedDateKey(since) === todayKey() ? time : `${relativeDateLabel(since)}, ${time}`;
}
