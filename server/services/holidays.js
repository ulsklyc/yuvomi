/**
 * Modul: Feiertage & Schulferien (Holidays)
 * Zweck: Fetch von der OpenHolidays API, Caching in holiday_cache-Tabelle,
 *        periodischer Sync. Kein API-Key erforderlich.
 * Quelle: https://openholidaysapi.org (open source, kostenlos)
 * Abhängigkeiten: node-fetch, server/db.js
 */

import nodeFetch from 'node-fetch';
import { createLogger } from '../logger.js';
import * as db from '../db.js';
import { resolveHouseholdLocale } from '../utils/i18n.js';

const log = createLogger('Holidays');

const BASE_URL          = 'https://openholidaysapi.org';
const FETCH_TIMEOUT_MS  = 15_000;
const SYNC_YEARS_BACK   = 1;
const SYNC_YEARS_AHEAD  = 2;
const THROTTLE_MS       = 30 * 24 * 60 * 60 * 1000;
// WARTEZEIT NACH EINEM GESCHEITERTEN SPRACH-NACHLAUF. Ein Sprachwechsel wirkt
// sofort - aber wenn der Abruf scheitert, bleibt der Merker offen, und ohne
// diese Bremse liefe bei einem Ausfall der Fremd-API alle
// SYNC_INTERVAL_MINUTES (Voreinstellung 15) ein neuer Anlauf.
const LANGUAGE_RETRY_MS = 60 * 60 * 1000;

// Injizierbare fetch-Implementierung (Default: node-fetch). Nur Tests
// überschreiben dies via __setFetchImpl, um die OpenHolidays-API zu mocken.
let fetchImpl = nodeFetch;
function __setFetchImpl(fn) { fetchImpl = fn ?? nodeFetch; }

// --------------------------------------------------------
// API-Abfragen
// --------------------------------------------------------

async function apiFetch(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${BASE_URL}${path}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Alle verfügbaren Länder abrufen.
 *
 * ZUSAETZLICH ZU OPENHOLIDAYS: ein paar Laender fuehrt OpenHolidays selbst
 * nicht (#965 - u. a. die USA fehlten ganz), obwohl ihre Feiertage sich ohne
 * Fremd-API aus reiner Datumsarithmetik herleiten lassen (LOCAL_COUNTRIES
 * weiter unten). Die liefert die API selbst nachtraeglich, gewinnt der
 * API-Eintrag - unsere Liste ist ein Zusatz, keine Kopie. Jeder lokale
 * Eintrag traegt `schoolHolidays: false`: es gibt fuer keinen von ihnen eine
 * Datenquelle fuer Schulferien (die sind in den betroffenen Laendern
 * regional/bezirksweise geregelt, nicht national einheitlich), und das
 * Frontend nutzt das Feld, um den Schulferien-Schalter dafuer ehrlich
 * auszugrauen statt eine leere Ebene stillschweigend nichts synchronisieren
 * zu lassen.
 * @returns {Promise<Array<{isoCode: string, name: string, schoolHolidays?: boolean}>>}
 */
async function getCountries() {
  // FAELLT DIE API AUS, BLEIBEN DIE LOKALEN LAENDER WAEHLBAR (Review-Fund zu
  // #965): ohne diesen Fang wurde aus dem Fetch-Fehler ein 502 der Route, das
  // Frontend fiel auf eine leere Liste zurueck - und ausgerechnet die Laender,
  // die gar kein Netz brauchen, waren nicht mehr auswaehlbar. Ein Ausfall der
  // Fremd-API kostet dann nur deren eigene 36 Eintraege, nicht die lokalen.
  let raw = [];
  try {
    raw = await apiFetch('/Countries');
  } catch (err) {
    log.warn(`Fetch /Countries failed (${err.message}) - serving the locally computed countries only`);
    raw = [];
  }
  const apiCountries = (raw ?? []).map((c) => ({
    isoCode: c.isoCode,
    name: resolveName(c.name),
  }));
  const apiCodes = new Set(apiCountries.map((c) => c.isoCode));
  const local = Object.keys(LOCAL_COUNTRIES)
    .filter((isoCode) => !apiCodes.has(isoCode))
    .map((isoCode) => ({ isoCode, name: LOCAL_COUNTRIES[isoCode].name, schoolHolidays: false }));
  return [...apiCountries, ...local].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Unterteilungen (Bundesländer etc.) für ein Land abrufen.
 *
 * GB fuehrt OpenHolidays selbst nicht (siehe getCountries) - die vier
 * britischen Nationen unterscheiden sich in ihren Feiertagen zu stark fuer
 * eine gemeinsame Landesliste (Schottland kennt z. B. keinen Ostermontag,
 * Nordirland zwei zusaetzliche Feiertage), daher werden sie hier synthetisch
 * als Subdivisionen gefuehrt statt die API zu befragen.
 * @param {string} countryIsoCode z.B. 'DE'
 * @returns {Promise<Array<{isoCode: string, name: string}>>}
 */
async function getSubdivisions(countryIsoCode) {
  if (countryIsoCode === 'GB') return GB_SUBDIVISIONS.slice();
  const raw = await apiFetch(`/Subdivisions?countryIsoCode=${encodeURIComponent(countryIsoCode)}`);
  return (raw ?? []).map((s) => ({
    isoCode: s.isoCode ?? s.code,
    name: resolveName(s.name) || s.shortName || s.isoCode || s.code,
  })).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Schulferien-Gruppen einer Subdivision abrufen. Manche Subdivisionen (v. a.
 * mehrsprachige Schweizer Kantone) teilen sich in mehrere Schulferien-Regime
 * mit abweichenden Terminen, die OpenHolidays nur über das "groups"-Feld
 * unterscheidet – z. B. CH-BE → CH-BE-VS (deutschsprachig) / CH-BE-EO (Berner
 * Jura). Erst ab zwei Gruppen ist die Auswahl relevant; bei 0/1 Gruppe gibt es
 * keine Mehrdeutigkeit und der Picker bleibt ausgeblendet. Die API liefert für
 * diese Gruppen keinen lesbaren Namen, daher wird shortName als Label genutzt. (#434)
 * @param {string} countryIsoCode  z.B. 'CH'
 * @param {string} subdivisionCode z.B. 'CH-BE'
 * @returns {Promise<Array<{code: string, name: string}>>}
 */
async function getGroups(countryIsoCode, subdivisionCode) {
  // GB hat keine Schulferien-Gruppen (kein Datenanbieter, siehe getCountries)
  // - ein Abruf gegen die echte API mit einem erfundenen Laendercode waere
  // sinnlos und koennte nur einen Fehlschlag ernten.
  if (countryIsoCode === 'GB') return [];
  const raw = await apiFetch(`/Subdivisions?countryIsoCode=${encodeURIComponent(countryIsoCode)}`);
  const match = (raw ?? []).find((s) => (s.code ?? s.isoCode) === subdivisionCode);
  const groups = Array.isArray(match?.groups) ? match.groups : [];
  return groups
    .map((g) => ({
      code: g.code ?? g.isoCode,
      name: resolveName(g.name) || g.shortName || g.code || g.isoCode,
    }))
    .filter((g) => g.code)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Den Anzeigenamen aus dem name-Array waehlen: Wunschsprache, sonst Englisch,
 * sonst die erste angebotene.
 *
 * DIE ZWEITE STUFE IST DER PUNKT. Vorher hiess die Kaskade "Wunsch, sonst die
 * erste" - und was OpenHolidays als erste liefert, ist die Landessprache. Ein
 * englischsprachiger Haushalt in Katalonien bekam damit fuer jeden Feiertag,
 * den die API nicht auf Englisch fuehrt, den spanischen Namen, ohne dass das
 * irgendwo zu sehen gewesen waere. Englisch ist die Sprache, die OpenHolidays
 * fuer nahezu jedes Land mitliefert; sie ist die bessere Auskunft als "was der
 * Server zufaellig zuerst nennt". Die erste bleibt als letzter Halt.
 *
 * @param {Array<{language, text}>} nameArr
 * @param {string} [preferLang='EN'] Sprachcode in Grossbuchstaben
 */
function resolveName(nameArr, preferLang = 'EN') {
  if (!Array.isArray(nameArr) || nameArr.length === 0) return '';
  const pick = (lang) => nameArr.find((n) => n.language === lang);
  return (pick(preferLang) ?? pick('EN') ?? nameArr[0]).text ?? '';
}

function formatIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function utcDate(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day));
}

function addDays(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return utcDate(year, month, day);
}

// --------------------------------------------------------
// Lokal berechnete Feiertage (#965)
//
// OpenHolidays deckt 36 Laender ab, ueberwiegend Europa plus BR/MX/ZA - kein
// Fremddienst dazwischen bedeutet aber, dass ein fehlendes Land (die USA
// waren der gemeldete Fall) sich nur ueber eine LOKALE Liste nachruesten
// laesst, nicht ueber einen zweiten Anbieter (bewusste Entscheidung: ein
// zweiter Live-Dienst waere ein zweiter Ausfallpunkt fuer ein einzelnes Land).
// Diese Liste ist reine Datumsarithmetik - kein Netzwerk, kein Cache-Sonderfall
// - und laeuft ueber denselben Weg wie die Brasilien-Ersatzliste, die es schon
// vor #965 gab; Brasilien ist unten selbst auf dieses Schema umgestellt, damit
// seine bestehenden Tests als Gleichheitsbeweis fuer die Umstellung dienen.
//
// AUFGENOMMEN WURDE NUR, WAS SICH OHNE JAHR-FUER-JAHR-DEKRET HERLEITEN LAESST:
// feste Daten, "n-ter Wochentag", Osterversatz, plus - fuer Matariki - eine von
// der neuseeländischen Regierung bereits bis 2052 veroeffentlichte Tabelle
// (kein Mondkalender-Algorithmus, eine echte amtliche Liste). Bewusst NICHT
// aufgenommen: monderechnete Feiertage (z. B. islamische Feste - Mondsichtung,
// keine Formel), jahresweise dekretierte Bruecktage (Argentinien u. a.) und
// Feiertage, die sich je Bundesstaat/Provinz unterscheiden (US-Bundesstaaten,
// australische Bundesstaaten). Diese Laender bleiben bewusst aussen vor, statt
// eine falsche Zuversicht vorzutaeuschen - siehe die ICS-Abo-Empfehlung in den
// Einstellungen fuer genau diesen Fall.
// --------------------------------------------------------

const SUN = 0, MON = 1, TUE = 2, WED = 3, THU = 4, FRI = 5, SAT = 6;

/** n-tes Vorkommen eines Wochentags in einem Monat; n=-1 -> letztes Vorkommen. */
function nthWeekdayOfMonth(year, month, weekday, n) {
  if (n === -1) {
    const last = utcDate(year, month + 1, 0); // Tag 0 des Folgemonats = letzter Tag dieses Monats
    const diff = (last.getUTCDay() - weekday + 7) % 7;
    return addDays(last, -diff);
  }
  const first = utcDate(year, month, 1);
  const diff = (weekday - first.getUTCDay() + 7) % 7;
  return addDays(first, diff + (n - 1) * 7);
}

/**
 * Letzter Montag an oder vor `maxDay` des Monats. Fuer Kanadas Victoria Day
 * ("Monday preceding May 25", gesetzlich der Montag zwischen dem 18. und 24.
 * Mai inklusive - NICHT einfach "letzter Montag im Mai": faellt der 25. Mai
 * selbst auf einen Montag, bleibt Victoria Day trotzdem der 18., weil das
 * Gesetz "preceding May 25" sagt, nicht "on or before").
 */
function lastMondayOnOrBefore(year, month, maxDay) {
  const d = utcDate(year, month, maxDay);
  const diff = (d.getUTCDay() - MON + 7) % 7;
  return addDays(d, -diff);
}

/** US-Beobachtungsregel: Samstag -> Freitag davor, Sonntag -> Montag danach. */
function usObserved(date) {
  const dow = date.getUTCDay();
  if (dow === SAT) return addDays(date, -1);
  if (dow === SUN) return addDays(date, 1);
  return date;
}

/**
 * Kanadas Regel (Holidays Act / Bills of Exchange Act, belegt fuer Canada Day
 * woertlich im Gesetzestext, fuer die uebrigen vier per Arbeitsrecht-Praxis):
 * nur Sonntag verschiebt auf den folgenden Montag. Samstag bleibt bewusst
 * unveraendert - dafuer gibt es keine einheitliche landesweite Regel, sondern
 * abweichende Provinz-Praxis (siehe Recherche zu #965), und eine erfundene
 * Verschiebung waere schlimmer als gar keine.
 */
function sundayToMonday(date) {
  return date.getUTCDay() === SUN ? addDays(date, 1) : date;
}

/**
 * "Mondayisation" (UK/Neuseeland): faellt der Tag auf Samstag oder Sonntag,
 * gilt der naechste Montag als Feiertag.
 */
function mondayised(date) {
  const dow = date.getUTCDay();
  if (dow !== SAT && dow !== SUN) return date;
  return addDays(date, (MON - dow + 7) % 7);
}

/**
 * Verschiebungstabelle fuer ein Feiertags-PAAR an aufeinanderfolgenden Tagen
 * (Weihnachten/Boxing Day in UK und Neuseeland; Neujahr/2. Januar in
 * Schottland und Neuseeland) - amtlich bestaetigt (siehe #965-Recherche,
 * u. a. GOV.UK, mygov.scot): faellt Tag 1 auf einen Werktag, bleibt beides
 * unveraendert. Faellt Tag 1 auf Freitag, ist nur Tag 2 (Samstag) betroffen
 * und ruesckt auf den folgenden Montag. Faellt Tag 1 auf Samstag, ruecken
 * BEIDE vor - Tag 1 auf Montag, Tag 2 (Sonntag) auf Dienstag, damit sie sich
 * nicht denselben Tag teilen. Faellt Tag 1 auf Sonntag, bleibt Tag 2 (der
 * bereits Montag ist) unveraendert, und nur Tag 1 ruesckt auf Dienstag vor.
 * Kein Algorithmus rekonstruiert das zuverlaessiger als die Tabelle selbst -
 * sie deckt alle sieben moeglichen Wochentage ab.
 */
const PAIR_SHIFT_DAYS = {
  [MON]: [0, 0], [TUE]: [0, 0], [WED]: [0, 0], [THU]: [0, 0],
  [FRI]: [0, 2], [SAT]: [2, 2], [SUN]: [2, 0],
};

function mondayisedPair(day1Date) {
  const [off1, off2] = PAIR_SHIFT_DAYS[day1Date.getUTCDay()];
  return [addDays(day1Date, off1), addDays(day1Date, 1 + off2)];
}

/**
 * Namen-Kaskade fuer lokal berechnete Feiertage: dieselbe Regel wie
 * resolveName fuer API-Namen (Wunschsprache, sonst Englisch, sonst was da
 * ist) - Konsistenz ist der Punkt, nicht nur Bequemlichkeit (#946 galt genauso
 * fuer den alten Brasilien-Ersatz).
 * @param {string|Record<string,string>} names einzelner String oder Sprachcode-Map
 */
function resolveLocalName(names, langCode) {
  if (typeof names === 'string') return names;
  const lang = String(langCode || '').toUpperCase();
  return names[lang] ?? names.EN ?? Object.values(names)[0];
}

/**
 * Ein einzelnes Regel-Datum fuer ein Jahr aufloesen. `table`-Regeln ohne
 * Eintrag fuer das gefragte Jahr liefern `null` - lieber eine Luecke als ein
 * geratenes Datum (gilt fuer Matariki ausserhalb der von der neuseelaendischen
 * Regierung veroeffentlichten Jahre 2022-2052).
 */
function resolveRuleDate(rule, year) {
  switch (rule.type) {
    case 'fixed': return utcDate(year, rule.month, rule.day);
    case 'nth': return nthWeekdayOfMonth(year, rule.month, rule.weekday, rule.n);
    case 'lastMondayOnOrBefore': return lastMondayOnOrBefore(year, rule.month, rule.maxDay);
    case 'easter': return addDays(easterSunday(year), rule.offset);
    case 'table': {
      const raw = rule.dates[year];
      if (!raw) return null;
      const [m, d] = raw.split('-').map(Number);
      return utcDate(year, m, d);
    }
    default: throw new Error(`Unbekannter Regeltyp: ${rule.type}`);
  }
}

function applyObservance(date, observance) {
  switch (observance) {
    case 'us': return usObserved(date);
    case 'sundayToMonday': return sundayToMonday(date);
    case 'mondayised': return mondayised(date);
    default: return date;
  }
}

/** Ein Eintrag-Array (siehe LOCAL_COUNTRIES) fuer ein Jahr in Cache-Zeilen expandieren. */
function expandCountryEntries(entries, year, langCode) {
  const out = [];
  for (const entry of entries) {
    if (entry.rule.type === 'pair') {
      const day1 = utcDate(year, entry.rule.month, entry.rule.day1);
      const [d1, d2] = mondayisedPair(day1);
      out.push([d1, entry.names[0]], [d2, entry.names[1]]);
      continue;
    }
    const base = resolveRuleDate(entry.rule, year);
    if (!base) continue;
    out.push([applyObservance(base, entry.observance), entry.names]);
  }
  return out
    .map(([date, names]) => {
      const iso = formatIsoDate(date);
      return { startDate: iso, endDate: iso, name: resolveLocalName(names, langCode) };
    })
    .sort((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0));
}

// ---- Brasilien ---------------------------------------------------------
// Selbst auf das Regel-Schema umgestellt (vorher eigene brazilPublicHolidays/
// localizedBrazilHolidayName-Funktionen) - die bestehende Testsuite dieser
// Liste liefert damit den Gleichheitsbeweis, dass die Umstellung nichts
// veraendert hat.
const BR_PUBLIC_HOLIDAYS = [
  { names: { PT: 'Confraternização Universal', EN: 'Universal Brotherhood Day' }, rule: { type: 'fixed', month: 1, day: 1 } },
  { names: { PT: 'Sexta-feira Santa', EN: 'Good Friday' }, rule: { type: 'easter', offset: -2 } },
  { names: { PT: 'Tiradentes', EN: 'Tiradentes Day' }, rule: { type: 'fixed', month: 4, day: 21 } },
  { names: { PT: 'Dia do Trabalho', EN: 'Labour Day' }, rule: { type: 'fixed', month: 5, day: 1 } },
  { names: { PT: 'Independência do Brasil', EN: 'Independence Day' }, rule: { type: 'fixed', month: 9, day: 7 } },
  { names: { PT: 'Nossa Senhora Aparecida', EN: 'Our Lady of Aparecida' }, rule: { type: 'fixed', month: 10, day: 12 } },
  { names: { PT: 'Finados', EN: "All Souls' Day" }, rule: { type: 'fixed', month: 11, day: 2 } },
  { names: { PT: 'Proclamação da República', EN: 'Republic Proclamation Day' }, rule: { type: 'fixed', month: 11, day: 15 } },
  { names: { PT: 'Dia Nacional de Zumbi e da Consciência Negra', EN: 'National Zumbi and Black Consciousness Day' }, rule: { type: 'fixed', month: 11, day: 20 } },
  { names: { PT: 'Natal', EN: 'Christmas Day' }, rule: { type: 'fixed', month: 12, day: 25 } },
];

// ---- USA ------------------------------------------------------------
// 11 Bundesfeiertage. Beobachtungsregel per Executive-Order-Praxis (OPM):
// Samstag -> Freitag davor, Sonntag -> Montag danach; die "n-ter Wochentag"-
// Feiertage fallen konstruktionsbedingt nie aufs Wochenende. Nur EN-Namen -
// bewusst dokumentierte Einschraenkung, siehe PR-Beschreibung.
const US_PUBLIC_HOLIDAYS = [
  { names: "New Year's Day", rule: { type: 'fixed', month: 1, day: 1 }, observance: 'us' },
  { names: 'Martin Luther King, Jr. Day', rule: { type: 'nth', month: 1, weekday: MON, n: 3 } },
  { names: "Washington's Birthday", rule: { type: 'nth', month: 2, weekday: MON, n: 3 } },
  { names: 'Memorial Day', rule: { type: 'nth', month: 5, weekday: MON, n: -1 } },
  { names: 'Juneteenth National Independence Day', rule: { type: 'fixed', month: 6, day: 19 }, observance: 'us' },
  { names: 'Independence Day', rule: { type: 'fixed', month: 7, day: 4 }, observance: 'us' },
  { names: 'Labor Day', rule: { type: 'nth', month: 9, weekday: MON, n: 1 } },
  { names: 'Columbus Day', rule: { type: 'nth', month: 10, weekday: MON, n: 2 } },
  { names: 'Veterans Day', rule: { type: 'fixed', month: 11, day: 11 }, observance: 'us' },
  { names: 'Thanksgiving Day', rule: { type: 'nth', month: 11, weekday: THU, n: 4 } },
  { names: 'Christmas Day', rule: { type: 'fixed', month: 12, day: 25 }, observance: 'us' },
];

// ---- Kanada -----------------------------------------------------------
// 10 landesweite gesetzliche Feiertage (fuer bundesrechtlich geregelte
// Arbeitsverhaeltnisse - der ueblich zitierte Referenzsatz). EN+FR-Namen,
// wie bei Brasilien PT+EN - durchlaeuft dieselbe Sprachkaskade. Kanada fuehrt
// nur Karfreitag, keinen Ostermontag als Bundesfeiertag.
//
// BEOBACHTUNG NUR SONNTAG->MONTAG (sundayToMonday oben), UNABHAENGIG PRO TAG -
// anders als UK/Neuseeland gibt es hier KEIN Paar-Schema, das eine Kollision
// zwischen Weihnachten und Boxing Day vermeidet. Faellt Weihnachten auf einen
// Sonntag (z. B. 2022), ruecken beide - der verschobene Weihnachtstag UND der
// unveraenderte Boxing Day - auf denselben Montag (26.12.2022): zwei Zeilen,
// ein Datum. Fuer einen Familienkalender ist das unschaedlich (zwei Balken am
// selben Tag statt einer), aber bewusst dokumentiert, damit es nicht als
// uebersehener Fehler gilt - fuer Kanada ist keine Quelle gefunden worden, die
// eine UK-Stil-Kollisionsvermeidung belegt, und eine erfundene waere schlimmer
// als die dokumentierte Ueberschneidung.
// Victoria Day per Sonderregel (lastMondayOnOrBefore).
const CA_PUBLIC_HOLIDAYS = [
  { names: { EN: "New Year's Day", FR: "Jour de l'An" }, rule: { type: 'fixed', month: 1, day: 1 }, observance: 'sundayToMonday' },
  { names: { EN: 'Good Friday', FR: 'Vendredi saint' }, rule: { type: 'easter', offset: -2 } },
  { names: { EN: 'Victoria Day', FR: 'Fête de la Reine' }, rule: { type: 'lastMondayOnOrBefore', month: 5, maxDay: 24 } },
  { names: { EN: 'Canada Day', FR: 'Fête du Canada' }, rule: { type: 'fixed', month: 7, day: 1 }, observance: 'sundayToMonday' },
  { names: { EN: 'Labour Day', FR: 'Fête du Travail' }, rule: { type: 'nth', month: 9, weekday: MON, n: 1 } },
  { names: { EN: 'National Day for Truth and Reconciliation', FR: 'Journée nationale de la vérité et de la réconciliation' }, rule: { type: 'fixed', month: 9, day: 30 } },
  { names: { EN: 'Thanksgiving', FR: 'Action de grâce' }, rule: { type: 'nth', month: 10, weekday: MON, n: 2 } },
  { names: { EN: 'Remembrance Day', FR: 'Jour du Souvenir' }, rule: { type: 'fixed', month: 11, day: 11 }, observance: 'sundayToMonday' },
  { names: { EN: 'Christmas Day', FR: 'Noël' }, rule: { type: 'fixed', month: 12, day: 25 }, observance: 'sundayToMonday' },
  { names: { EN: 'Boxing Day', FR: 'Lendemain de Noël' }, rule: { type: 'fixed', month: 12, day: 26 }, observance: 'sundayToMonday' },
];

// ---- Vereinigtes Koenigreich --------------------------------------------
// Keine gemeinsame Landesliste: die vier Nationen unterscheiden sich zu
// stark (Schottland ohne Ostermontag, mit eigenem Sommertermin und 2.
// Januar; Nordirland mit zwei Zusatzfeiertagen) - je Subdivision eine
// vollstaendige eigene Liste statt eines "Basis + Zuschlag"-Schemas, das an
// der Realitaet vorbeigegangen waere. GB_SUBDIVISIONS (unten) ist die
// Auswahl dafuer; ohne gewaehlte Subdivision gilt England & Wales.
const GB_ENGLAND_WALES_HOLIDAYS = [
  { names: "New Year's Day", rule: { type: 'fixed', month: 1, day: 1 }, observance: 'mondayised' },
  { names: 'Good Friday', rule: { type: 'easter', offset: -2 } },
  { names: 'Easter Monday', rule: { type: 'easter', offset: 1 } },
  { names: 'Early May Bank Holiday', rule: { type: 'nth', month: 5, weekday: MON, n: 1 } },
  { names: 'Spring Bank Holiday', rule: { type: 'nth', month: 5, weekday: MON, n: -1 } },
  { names: 'Summer Bank Holiday', rule: { type: 'nth', month: 8, weekday: MON, n: -1 } },
  { names: ['Christmas Day', 'Boxing Day'], rule: { type: 'pair', month: 12, day1: 25 } },
];

const GB_SCOTLAND_HOLIDAYS = [
  // '2nd January' in GOV.UK-Schreibweise (bank-holidays.json), nicht '2 January'.
  { names: ["New Year's Day", '2nd January'], rule: { type: 'pair', month: 1, day1: 1 } },
  { names: 'Good Friday', rule: { type: 'easter', offset: -2 } },
  { names: 'Early May Bank Holiday', rule: { type: 'nth', month: 5, weekday: MON, n: 1 } },
  { names: 'Spring Bank Holiday', rule: { type: 'nth', month: 5, weekday: MON, n: -1 } },
  // Schottlands Sommertermin ist der ERSTE Montag im August, nicht der letzte
  // wie in England/Wales - keine Tippfehler-Variante derselben Regel.
  { names: 'Summer Bank Holiday', rule: { type: 'nth', month: 8, weekday: MON, n: 1 } },
  // St Andrew's Day IST mondayised: der St Andrew's Day Bank Holiday
  // (Scotland) Act 2007 s.1(2) verlegt ihn auf den folgenden Montag, wenn der
  // 30.11. auf ein Wochenende faellt - GOV.UK (bank-holidays.json) fuehrt
  // entsprechend 2019-12-02, 2024-12-02 und 2025-12-01 als Ersatztage. Ein
  // frueherer Kommentar hier behauptete das Gegenteil, und genau daran hing
  // der Review-Fund zu #965: 2025 (Sonntag) lag im Sync-Fenster und stand
  // einen Tag zu frueh im Kalender.
  { names: "St Andrew's Day", rule: { type: 'fixed', month: 11, day: 30 }, observance: 'mondayised' },
  { names: ['Christmas Day', 'Boxing Day'], rule: { type: 'pair', month: 12, day1: 25 } },
];

const GB_NORTHERN_IRELAND_HOLIDAYS = [
  ...GB_ENGLAND_WALES_HOLIDAYS.slice(0, -1),
  { names: "St Patrick's Day", rule: { type: 'fixed', month: 3, day: 17 }, observance: 'mondayised' },
  { names: 'Battle of the Boyne (Orangemen’s Day)', rule: { type: 'fixed', month: 7, day: 12 }, observance: 'mondayised' },
  ...GB_ENGLAND_WALES_HOLIDAYS.slice(-1),
];

const GB_SUBDIVISIONS = [
  { isoCode: 'GB-ENG', name: 'England and Wales' },
  { isoCode: 'GB-NIR', name: 'Northern Ireland' },
  { isoCode: 'GB-SCT', name: 'Scotland' },
];

function gbHolidaysFor(subdivision) {
  if (subdivision === 'GB-SCT') return GB_SCOTLAND_HOLIDAYS;
  if (subdivision === 'GB-NIR') return GB_NORTHERN_IRELAND_HOLIDAYS;
  return GB_ENGLAND_WALES_HOLIDAYS;
}

// ---- Australien ---------------------------------------------------------
// Nur landesweite Feiertage. KEINE Wochenend-Verschiebung: es gibt kein
// Bundesgesetz dafuer, jeder Bundesstaat erlaesst seine eigene Ersatztag-
// Regel (siehe #965-Recherche) - ein erfundenes bundesweites Ausweichdatum
// waere in mindestens einem Bundesstaat schlicht falsch. Feiertage, die je
// Bundesstaat variieren (Queen's/King's Birthday, Labour Day), bleiben aussen
// vor wie bei jedem anderen Land dieser Liste.
const AU_PUBLIC_HOLIDAYS = [
  { names: "New Year's Day", rule: { type: 'fixed', month: 1, day: 1 } },
  { names: 'Australia Day', rule: { type: 'fixed', month: 1, day: 26 } },
  { names: 'Good Friday', rule: { type: 'easter', offset: -2 } },
  { names: 'Easter Monday', rule: { type: 'easter', offset: 1 } },
  { names: 'Anzac Day', rule: { type: 'fixed', month: 4, day: 25 } },
  { names: 'Christmas Day', rule: { type: 'fixed', month: 12, day: 25 } },
  { names: 'Boxing Day', rule: { type: 'fixed', month: 12, day: 26 } },
];

// ---- Neuseeland -----------------------------------------------------------
// "Mondayisation" seit Holidays (Full Recognition of Waitangi Day and ANZAC
// Day) Amendment Act 2013 fuer sechs feste Termine (Neujahr/2. Januar als
// Paar, Waitangi, Anzac, Weihnachten/Boxing Day als Paar) - King's Birthday,
// Matariki und Labour Day liegen konstruktionsbedingt bereits auf einem
// Montag/Freitag und werden nie verschoben.
//
// MATARIKI IST EINE TABELLE, KEINE FORMEL: die Termine werden vom
// Matariki-Beirat anhand des Maori-Mondkalenders bestimmt und von der
// Regierung (MBIE) im Voraus bis 2052 veroeffentlicht - nicht algorithmisch
// herleitbar, aber eine echte amtliche Liste, kein Schaetzwert. Jenseits von
// 2052 liefert resolveRuleDate() bewusst `null` statt zu raten.
const NZ_MATARIKI_DATES = {
  2022: '06-24', 2023: '07-14', 2024: '06-28', 2025: '06-20', 2026: '07-10',
  2027: '06-25', 2028: '07-14', 2029: '07-06', 2030: '06-21', 2031: '07-11',
  2032: '07-02', 2033: '06-24', 2034: '07-07', 2035: '06-29', 2036: '07-18',
  2037: '07-10', 2038: '06-25', 2039: '07-15', 2040: '07-06', 2041: '07-19',
  2042: '07-11', 2043: '07-03', 2044: '06-24', 2045: '07-07', 2046: '06-29',
  2047: '07-19', 2048: '07-03', 2049: '06-25', 2050: '07-15', 2051: '06-30',
  2052: '06-21',
};

const NZ_PUBLIC_HOLIDAYS = [
  { names: ["New Year's Day", 'Day after New Year’s Day'], rule: { type: 'pair', month: 1, day1: 1 } },
  { names: 'Waitangi Day', rule: { type: 'fixed', month: 2, day: 6 }, observance: 'mondayised' },
  { names: 'Good Friday', rule: { type: 'easter', offset: -2 } },
  { names: 'Easter Monday', rule: { type: 'easter', offset: 1 } },
  { names: 'Anzac Day', rule: { type: 'fixed', month: 4, day: 25 }, observance: 'mondayised' },
  { names: "King's Birthday", rule: { type: 'nth', month: 6, weekday: MON, n: 1 } },
  { names: 'Matariki', rule: { type: 'table', dates: NZ_MATARIKI_DATES } },
  { names: 'Labour Day', rule: { type: 'nth', month: 10, weekday: MON, n: 4 } },
  { names: ['Christmas Day', 'Boxing Day'], rule: { type: 'pair', month: 12, day1: 25 } },
];

/**
 * Registry der lokal berechneten Laender. `schoolHolidays: false` in
 * getCountries() wird aus den hier gefuehrten Schluesseln abgeleitet - fuer
 * keins von ihnen existiert eine Schulferien-Quelle.
 */
const LOCAL_COUNTRIES = {
  BR: { name: 'Brazil', holidays: () => BR_PUBLIC_HOLIDAYS },
  US: { name: 'United States', holidays: () => US_PUBLIC_HOLIDAYS },
  CA: { name: 'Canada', holidays: () => CA_PUBLIC_HOLIDAYS },
  GB: { name: 'United Kingdom', holidays: (subdivision) => gbHolidaysFor(subdivision) },
  AU: { name: 'Australia', holidays: () => AU_PUBLIC_HOLIDAYS },
  NZ: { name: 'New Zealand', holidays: () => NZ_PUBLIC_HOLIDAYS },
};

function localHolidayFallback(country, type, year, langCode, subdivision) {
  if (type !== 'public') return [];
  const local = LOCAL_COUNTRIES[country];
  if (!local) return [];
  return expandCountryEntries(local.holidays(subdivision), year, langCode);
}

// --------------------------------------------------------
// Sync-Logik
// --------------------------------------------------------

/**
 * Ein Bereich, fuer den nichts zu speichern ist - und die beiden Faelle darin
 * gehen VERSCHIEDEN aus.
 *
 * Ein GESCHEITERTER Abruf sagt nichts ueber den Bestand: der bleibt liegen,
 * dieser Bereich steht danach weiter in der alten Sprache, und `failed` haelt
 * den Sprach-Merker offen.
 *
 * Ein GEGLUECKTER Abruf mit leerem Ergebnis ist dagegen eine Auskunft: hier
 * gibt es nichts. Dann muss auch nichts liegenbleiben - sonst behielte
 * ausgerechnet dieser Bereich seine alten, fremdsprachigen Zeilen, waehrend der
 * Lauf als vollstaendig verbucht wird (gefunden in der PR-Durchsicht: die
 * HTTP-erfolgreiche Leerantwort nimmt einen eigenen Weg, den der Fix fuer den
 * Fehlerfall nicht mit abdeckte). Der Cache spiegelt die API, auch wenn sie
 * "nichts" sagt.
 */
function finishEmpty(fetchFailed, country, type, year) {
  if (fetchFailed) return { count: 0, failed: true };
  db.get().prepare('DELETE FROM holiday_cache WHERE type = ? AND country = ? AND year = ?')
    .run(type, country, year);
  return { count: 0, failed: false };
}

/**
 * Ein Jahr eines Typs holen und in den Cache legen.
 *
 * @param {string} langCode Sprachcode in GROSSBUCHSTABEN, wie OpenHolidays ihn
 *   im `name`-Array fuehrt ('ES', 'EN'). Aufrufer normalisieren, nicht diese
 *   Funktion - sonst stuende dieselbe Umwandlung an zwei Stellen.
 * @returns {Promise<{count: number, failed: boolean}>} `failed` heisst: der
 *   Abruf ist GESCHEITERT und kein lokaler Ersatz sprang ein. Das ist etwas
 *   anderes als `count: 0` - manche Laender fuehren schlicht keine Schulferien,
 *   und diese beiden Faelle auseinanderzuhalten ist der ganze Punkt: nur der
 *   erste darf den Sprach-Merker unten zurueckhalten.
 */
async function syncYearAndType(country, subdivision, year, type, langCode) {
  const from = `${year}-01-01`;
  const to   = `${year}-12-31`;
  const endpoint = type === 'public' ? 'PublicHolidays' : 'SchoolHolidays';

  // OHNE languageIsoCode, UND DAS IST DER FIX ZU #946. Mit dem Parameter
  // liefert OpenHolidays je Feiertag nur EINEN Namen - und wenn es den in der
  // gefragten Sprache nicht gibt, den der Landessprache. Die Kaskade in
  // resolveName (Wunsch, sonst Englisch, sonst die erste) laeuft dann ueber ein
  // einelementiges Array und kann nichts mehr waehlen: sie bekam "Navidad"
  // gereicht und hatte keine Alternative danebenliegen. Ohne den Parameter
  // kommt das vollstaendige name-Array, und die Wahl faellt hier - wo bekannt
  // ist, welche Sprache der Haushalt lesen will. Der Preis ist eine groessere
  // Antwort fuer ein paar Dutzend Eintraege im Jahr.
  let params = `countryIsoCode=${encodeURIComponent(country)}&validFrom=${from}&validTo=${to}`;
  if (subdivision) params += `&subdivisionCode=${encodeURIComponent(subdivision)}`;

  let holidays;
  let fetchFailed = false;
  // KEIN LIVE-ABRUF FUER DIE LOKAL BERECHNETEN LAENDER (Review-Fund zu #965):
  // /PublicHolidays antwortet fuer sie belegt mit 200 [] (fuer BR und US
  // gemessen, GB fuehrt die API gar nicht) - der Request loeste also nur den
  // Fallback aus, der hier ohnehin die Daten liefert. Der Kurzschluss spart
  // nicht bloss vier Requests pro Lauf: er macht den Offline-Fall fuer diese
  // Laender per Konstruktion funktionsfaehig, statt ihn vom Scheitern eines im
  // Voraus bekannten sinnlosen Abrufs abhaengig zu machen. Schulferien nehmen
  // weiter den API-Weg - fuer sie gibt es keinen lokalen Ersatz, und die leere
  // Antwort bleibt dort die ehrliche Auskunft.
  if (type === 'public' && LOCAL_COUNTRIES[country]) {
    holidays = localHolidayFallback(country, type, year, langCode, subdivision);
  } else {
    try {
      holidays = await apiFetch(`/${endpoint}?${params}`);
      // NUR EIN ECHTES LEERES ARRAY IST EINE AUSKUNFT. Ein HTTP 200 mit einem
      // anderen Rumpf - ein Fehlerobjekt eines vorgeschalteten Proxys, eine
      // geaenderte Antwortform - sagt gar nichts, und seit `finishEmpty` einen
      // leeren Bereich RAEUMT, waere daraus Datenverlust geworden: der Cache
      // gelöscht, der Scope als vollstaendig verbucht, und die Feiertage 30 Tage
      // lang weg. Ein Nicht-Array zaehlt deshalb wie ein gescheiterter Abruf
      // (gefunden in der PR-Durchsicht, als Folgefehler genau dieser Aenderung).
      if (!Array.isArray(holidays)) {
        log.warn(`Fetch ${endpoint} ${country}/${subdivision ?? '-'}/${year}: unexpected response shape (${typeof holidays})`);
        fetchFailed = true;
      }
    } catch (err) {
      log.warn(`Fetch ${endpoint} ${country}/${subdivision ?? '-'}/${year}: ${err.message}`);
      fetchFailed = true;
      holidays = localHolidayFallback(country, type, year, langCode, subdivision);
    }
  }

  if (!Array.isArray(holidays) || holidays.length === 0) {
    holidays = localHolidayFallback(country, type, year, langCode, subdivision);
  }
  if (!Array.isArray(holidays) || holidays.length === 0) return finishEmpty(fetchFailed, country, type, year);

  // OpenHolidays liefert für Sub-Regionen abweichende Varianten desselben
  // Feiertags/derselben Ferien als eigene, mit "Exception" getaggte Einträge
  // (z. B. Schleswig-Holstein: separate Sommer-/Herbstferien nur für die Inseln
  // Sylt, Föhr, Amrum, Helgoland, Halligen). Diese haben abweichende Start-/
  // Enddaten und lassen sich daher lesen-seitig nicht kollabieren – im Kalender
  // erscheinen sie als zweiter, früher endender/startender Ferien-Eintrag.
  // Für einen Familienkalender ist der reguläre Regions-Eintrag maßgeblich; die
  // Insel-Ausnahmen werden verworfen. (#434)
  holidays = holidays.filter((h) => !(Array.isArray(h.tags) && h.tags.includes('Exception')));
  if (holidays.length === 0) return finishEmpty(fetchFailed, country, type, year);

  const insert = db.get().prepare(`
    INSERT INTO holiday_cache (type, country, subdivision, start_date, end_date, name, year, group_code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertAll = db.get().transaction((rows) => {
    for (const h of rows) {
      const name = typeof h.name === 'string'
        ? h.name
        : resolveName(h.name, langCode);
      // Schulferien-Gruppe (z. B. CH-BE-VS), falls die Subdivision mehrere
      // Regime kennt. Öffentliche Feiertage tragen i. d. R. keine Gruppe → NULL,
      // gilt dann für die gesamte Subdivision. (#434)
      const groupCode = Array.isArray(h.groups) && h.groups.length > 0
        ? (h.groups[0].code ?? h.groups[0].isoCode ?? null)
        : null;
      insert.run(type, country, subdivision ?? null, h.startDate, h.endDate, name, year, groupCode);
    }
  });

  // Alle Einträge dieses Landes/Jahres/Typs löschen – auch aus zuvor gewählten
  // Regionen bzw. dem länderweiten (NULL-)Scope. Verhindert doppelte Feiertage
  // beim Wechsel der Region: es ist immer nur genau eine Region konfiguriert,
  // daher darf nur der aktuell gefetchte Scope im Cache verbleiben (#434).
  db.get().prepare(
    'DELETE FROM holiday_cache WHERE type = ? AND country = ? AND year = ?'
  ).run(type, country, year);

  insertAll(holidays);
  return { count: holidays.length, failed: false };
}

/**
 * Sync Feiertage und/oder Schulferien für das konfigurierte Land/Region.
 * Wird vom Auto-Scheduler und manuell aus den Settings aufgerufen.
 */
/**
 * ZWEI LAEUFE DUERFEN SICH NICHT VERSCHRAENKEN. Der Scheduler ruft `sync()`
 * alle SYNC_INTERVAL_MINUTES, der Knopf "Jetzt synchronisieren" ruft
 * `sync(true)` - beide ohne Absprache. Ueber die await-Punkte im Jahres-Loop
 * konnten sie sich mischen: der aeltere Lauf (alte Sprache) ueberschreibt
 * Jahre, die der neuere schon umgestellt hat, und der neuere verbucht am Ende
 * SEINEN Scope als vollstaendig. Der Cache steht dann zweisprachig da und gilt
 * fuer 30 Tage als aktuell (gefunden in der PR-Durchsicht).
 *
 * Vorher war dasselbe Rennen harmlos - es holte hoechstens ein Jahr doppelt.
 * Erst der Merker macht daraus einen festgeschriebenen Mischzustand.
 *
 * Der zweite Aufruf WARTET und laeuft dann selbst, statt das Ergebnis des
 * ersten zu bekommen: er liest seine Konfiguration erst, wenn er dran ist,
 * sieht also den neuen Stand - und stellt fest, dass nichts mehr zu tun ist,
 * wenn der erste schon alles erledigt hat.
 */
let laufenderSync = Promise.resolve();

async function sync(force = false) {
  const dran = laufenderSync.then(() => syncNow(force), () => syncNow(force));
  // Der Fehler gehoert dem Aufrufer, nicht der Warteschlange - sonst risse ein
  // gescheiterter Lauf alle nachfolgenden mit.
  laufenderSync = dran.then(() => {}, () => {});
  return dran;
}

async function syncNow(force = false) {
  const country     = db.get().prepare("SELECT value FROM sync_config WHERE key='holiday_country'").get()?.value;
  const subdivision = db.get().prepare("SELECT value FROM sync_config WHERE key='holiday_subdivision'").get()?.value ?? null;
  const showPublic  = db.get().prepare("SELECT value FROM sync_config WHERE key='holiday_show_public'").get()?.value === '1';
  const showSchool  = db.get().prepare("SELECT value FROM sync_config WHERE key='holiday_show_school'").get()?.value === '1';

  if (!country) {
    log.debug('No holiday country configured – skipping sync.');
    return { synced: 0 };
  }

  if (!showPublic && !showSchool) {
    log.debug('Both holiday layers disabled – skipping sync.');
    return { synced: 0 };
  }

  // DIE SPRACHE KOMMT AUS DER EINSTELLUNG, NICHT AUS DEM LAND. Hier stand eine
  // Karte von Land auf Sprache: wer Spanien waehlte, bekam spanische Namen -
  // auch wenn "Sprache gespeicherter Eintraege" auf Englisch stand und der
  // Hinweis darunter ausdruecklich "Wirkt auf API, Kalender-Feed und
  // Synchronisierung" verspricht (#946). Feiertage SIND selbst erzeugte
  // Eintraege; sie fallen unter genau diese Zusage, und `resolveHouseholdLocale`
  // ist die eine Stelle, die sie beantwortet - dieselbe, aus der Geburtstage,
  // Darlehensraten und Benachrichtigungen ihre Sprache holen.
  const langCode = resolveHouseholdLocale(db.get()).toUpperCase();

  // WAS DEN INHALT DES CACHES BESTIMMT, IST MEHR ALS DIE SPRACHE: Sprache,
  // Land, Region und welche Ebenen ueberhaupt geholt werden. Genau diese vier
  // bilden den SCOPE, und der steht neben dem Zeitstempel.
  //
  // Der Merker trug zuerst nur die Sprache, und daran hingen drei Befunde aus
  // der PR-Durchsicht, die alle dieselbe Wurzel hatten: eine abgeschaltete
  // Ebene wurde beim Sprachwechsel nicht mitgeholt, aber als erledigt verbucht
  // (beim Wiedereinschalten blieben ihre alten Namen stehen); ein Wechsel des
  // Landes lief in dieselbe Falle; und ein Fehlschlag OHNE Sprachwechsel wurde
  // gar nicht wiederholt, weil die Reparatur an `languageChanged` hing.
  const scope = [langCode, country, subdivision ?? '', showPublic ? 'P' : '', showSchool ? 'S' : ''].join('|');
  const lastScope = db.get().prepare("SELECT value FROM sync_config WHERE key='holiday_last_sync_scope'").get()?.value ?? null;
  const scopeChanged = lastScope !== scope;

  // EINE OFFENE REPARATUR GILT UNABHAENGIG DAVON, OB SICH ETWAS GEAENDERT HAT.
  // Sie entsteht nur nach einem gescheiterten Abruf und traegt den Scope, bei
  // dem es schiefging: derselbe Scope wird eine Stunde lang nicht erneut
  // versucht (der Scheduler laeuft alle SYNC_INTERVAL_MINUTES, Voreinstellung
  // 15 - ein Ausfall der Fremd-API darf keine Dauerschleife werden), danach
  // schon, und zwar OHNE auf die 30-Tage-Sperre zu warten.
  const retryAfterStr = db.get().prepare("SELECT value FROM sync_config WHERE key='holiday_retry_after'").get()?.value;
  const retryScope    = db.get().prepare("SELECT value FROM sync_config WHERE key='holiday_retry_scope'").get()?.value;
  const repairOpen    = Boolean(retryAfterStr) && retryScope === scope;
  if (!force && repairOpen) {
    const retryAfter = new Date(retryAfterStr);
    if (!Number.isNaN(retryAfter.getTime()) && Date.now() < retryAfter.getTime()) {
      log.debug('Holiday repair is still on hold – skipping automatic sync.');
      return { synced: 0 };
    }
  }

  // Der normale Auffrischungstakt gilt nur, wenn nichts Neues gewaehlt wurde.
  //
  // EINE OFFENE REPARATUR MUSS HIER NICHT NOCHMAL GEPRUEFT WERDEN, und das ist
  // kein Zufall, sondern der Grund, warum ein Fehlschlag den Merker LOESCHT
  // statt ihn nur nicht zu setzen: danach gilt jeder Scope als neu, also ist
  // `scopeChanged` ohnehin wahr. Eine zusaetzliche `!repairOpen`-Bedingung stand
  // hier kurz und war toter Code - sie sah aus wie ein Schutz und konnte nie
  // greifen, weil Merker und Reparaturmarke sich gegenseitig ausschliessen.
  const lastSyncStr = db.get().prepare("SELECT value FROM sync_config WHERE key='holiday_last_sync'").get()?.value;
  if (!force && !scopeChanged && lastSyncStr) {
    const lastSyncDate = new Date(lastSyncStr);
    if (!Number.isNaN(lastSyncDate.getTime()) && Date.now() - lastSyncDate.getTime() < THROTTLE_MS) {
      log.debug('Holidays synced recently – skipping automatic sync.');
      return { synced: 0 };
    }
  }

  const currentYear = new Date().getFullYear();
  const years = [];
  for (let y = currentYear - SYNC_YEARS_BACK; y <= currentYear + SYNC_YEARS_AHEAD; y++) {
    years.push(y);
  }

  // JAHRE, DIE NUR NOCH IM CACHE LIEGEN, KOMMEN BEI EINEM SCOPE-WECHSEL MIT.
  // Das Fenster wandert (currentYear-1 .. +2), der Cache nicht: eine
  // Installation, die 2025 lief, hat Zeilen fuer 2024 liegen, und die faellt
  // 2027 aus dem Fenster. `getForRange()` kennt keine Fenstergrenze und zeigt
  // sie beim Zurueckblaettern weiter - nach einem Sprachwechsel also in der
  // alten Sprache, unbegrenzt lange (gefunden in der PR-Durchsicht).
  //
  // Sie zu loeschen waere konsistent gewesen, haette aber alte Jahre leer
  // gelassen; sie stehen zu lassen heisst, dass der Kalender zwei Sprachen
  // zeigt. Beides unnoetig: es sind wenige Jahre, sie sind bei OpenHolidays
  // abrufbar, und der Zusatzaufwand faellt nur an, wenn sich wirklich etwas
  // geaendert hat. Liefert die Quelle fuer so ein Jahr nichts mehr, raeumt
  // `finishEmpty` es weg - auch dann bleibt nichts Fremdsprachiges stehen.
  if (scopeChanged) {
    const imCache = db.get().prepare('SELECT DISTINCT year FROM holiday_cache WHERE country = ? ORDER BY year').all(country);
    for (const { year } of imCache) {
      if (!years.includes(year)) years.push(year);
    }
  }

  let total = 0;
  let anyFailed = false;
  for (const year of years) {
    for (const type of [showPublic && 'public', showSchool && 'school'].filter(Boolean)) {
      const res = await syncYearAndType(country, subdivision, year, type, langCode);
      total += res.count;
      anyFailed ||= res.failed;
    }
  }

  const now = new Date().toISOString();
  const remember = db.get().prepare(`
    INSERT INTO sync_config (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                   updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  `);
  remember.run('holiday_last_sync', now);
  // DER SPRACH-MERKER ERST NACH EINEM VOLLSTAENDIGEN LAUF. Scheitert auch nur
  // ein Jahr, steht dieser Bereich weiter in der alten Sprache - ihn trotzdem
  // als erledigt zu verbuchen hiesse, einen halb uebersetzten Cache fuer die
  // naechsten 30 Tage festzuschreiben. Genau die Sorte Fehler, bei der ein
  // Cursor ueber einen Fehlschlag hinweglaeuft und die Luecke nie wieder
  // zugeht (#839).
  const forget = db.get().prepare('DELETE FROM sync_config WHERE key = ?');
  if (anyFailed) {
    // DER MERKER WIRD GELOESCHT, NICHT BLOSS NICHT GESETZT. Nach einem
    // Teilfehlschlag steht der Cache GEMISCHT da - einige Bereiche neu, andere
    // alt. Bliebe der alte Scope stehen, waere ein Zurueckwechseln auf ihn
    // "unveraendert", die 30-Tage-Sperre griffe, und die bereits umgestellten
    // Bereiche behielten ihre neuen Namen fuer einen Monat. Ohne Merker gilt
    // jeder Scope als neu, bis einer vollstaendig durchgelaufen ist; gegen die
    // Dauerschleife steht die Reparaturmarke.
    forget.run('holiday_last_sync_scope');
    remember.run('holiday_retry_after', new Date(Date.now() + LANGUAGE_RETRY_MS).toISOString());
    remember.run('holiday_retry_scope', scope);
  } else {
    remember.run('holiday_last_sync_scope', scope);
    forget.run('holiday_retry_after');
    forget.run('holiday_retry_scope');
  }

  // "complete" nur, wenn es das war. Genau diese Zeile hat der Melder von #946
  // zitiert, um zu zeigen, dass die Synchronisierung durchgelaufen sei - eine
  // Erfolgsmeldung ueber einem halb geholten Bestand haette ihn ein zweites Mal
  // in die Irre gefuehrt.
  const wo = `${country}${subdivision ? '/' + subdivision : ''}`;
  if (anyFailed) log.warn(`Holiday sync INCOMPLETE: ${total} entries for ${wo} - some requests failed, the next run retries`);
  else log.info(`Holiday sync complete: ${total} entries for ${wo}`);
  return { synced: total, lastSync: now, incomplete: anyFailed };
}

/**
 * Kollabiert überlappende, gleichnamige Einträge desselben Typs zu einer
 * Union-Spanne (frühester Start, spätestes Ende). Verhindert doppelte Balken,
 * wenn OpenHolidays für eine Subdivision mehrere Schulferien-Varianten mit
 * abweichenden Terminen liefert (regionale Schulkalender, z. B. CH-Kantone).
 * Nicht überlappende gleichnamige Einträge bleiben getrennt. (#434)
 * @param {Array<{id, type, start_date, end_date, name}>} rows nach start_date sortiert
 */
function mergeOverlappingByName(rows) {
  const byKey = new Map();
  for (const r of rows) {
    const key = `${r.type}\x00${r.name}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  }

  const out = [];
  for (const group of byKey.values()) {
    group.sort((a, b) => (a.start_date < b.start_date ? -1 : a.start_date > b.start_date ? 1 : 0));
    let cur = null;
    for (const r of group) {
      // Überlappung/Berührung (start des nächsten <= aktuelles Ende) → vereinen.
      if (cur && r.start_date <= cur.end_date) {
        if (r.end_date > cur.end_date) cur.end_date = r.end_date;
        cur.id = Math.min(cur.id, r.id);
      } else {
        cur = { ...r };
        out.push(cur);
      }
    }
  }

  out.sort((a, b) => (a.start_date < b.start_date ? -1 : a.start_date > b.start_date ? 1 : 0));
  return out;
}

/**
 * Feiertage/Ferien für einen Datumsbereich aus dem Cache lesen.
 * @param {string} from YYYY-MM-DD
 * @param {string} to   YYYY-MM-DD
 * @returns {Array<{id, type, start_date, end_date, name}>}
 */
function getForRange(from, to) {
  const country     = db.get().prepare("SELECT value FROM sync_config WHERE key='holiday_country'").get()?.value;
  const subdivision = db.get().prepare("SELECT value FROM sync_config WHERE key='holiday_subdivision'").get()?.value ?? null;
  const group       = db.get().prepare("SELECT value FROM sync_config WHERE key='holiday_group'").get()?.value || null;
  const showPublic  = db.get().prepare("SELECT value FROM sync_config WHERE key='holiday_show_public'").get()?.value === '1';
  const showSchool  = db.get().prepare("SELECT value FROM sync_config WHERE key='holiday_show_school'").get()?.value === '1';
  const pubColor    = db.get().prepare("SELECT value FROM sync_config WHERE key='holiday_public_color'").get()?.value ?? '#FF3B30';
  const schColor    = db.get().prepare("SELECT value FROM sync_config WHERE key='holiday_school_color'").get()?.value ?? '#34C759';

  if (!country || (!showPublic && !showSchool)) return [];

  const types = [];
  if (showPublic) types.push('public');
  if (showSchool) types.push('school');

  const placeholders = types.map(() => '?').join(', ');

  // Ist eine Schulferien-Gruppe konfiguriert (mehrsprachiger Kanton), werden nur
  // die Zeilen dieser Gruppe sowie gruppenlose Zeilen (group_code NULL, z. B.
  // Feiertage) gezeigt. So bleibt genau EIN korrektes Ferien-Regime übrig und der
  // Union-Merge unten wird zum No-op. Ohne Gruppen-Auswahl greift der Merge als
  // Fallback und kollabiert überlappende Varianten wie bisher. (#434)
  const groupClause = group ? 'AND (group_code IS NULL OR group_code = ?)' : '';
  const groupArgs   = group ? [group] : [];

  // GROUP BY kollabiert identische Feiertage, die aus mehreren Scopes im Cache
  // liegen (z. B. länderweite NULL-Zeilen aus der Zeit vor #434 neben dem heutigen
  // Regions-Scope). So sieht der Kalender nie Duplikate, selbst wenn ein alter
  // Cache-Bestand nie sauber neu synchronisiert wurde. (#434)
  const rows = db.get().prepare(`
    SELECT MIN(id) AS id, type, start_date, end_date, name
    FROM holiday_cache
    WHERE country = ?
      AND (subdivision IS NULL OR subdivision = ? OR subdivision = '')
      ${groupClause}
      AND type IN (${placeholders})
      AND start_date <= ?
      AND end_date   >= ?
    GROUP BY type, start_date, end_date, name
    ORDER BY start_date ASC
  `).all(country, subdivision ?? '', ...groupArgs, ...types, to, from);

  // OpenHolidays modelliert innerhalb EINER Subdivision teils mehrere
  // gleichnamige Schulferien-Varianten mit abweichenden Datumsbereichen –
  // z. B. Kanton Bern: deutsch- vs. französischsprachige Schulregion
  // (groups CH-BE-VS / CH-BE-EO). Diese tragen KEIN "Exception"-Tag und haben
  // unterschiedliche Start-/Enddaten, daher greifen weder der sync-seitige
  // Exception-Filter noch das exakte GROUP BY oben. Für den Familienkalender
  // werden überlappende gleichnamige Einträge desselben Typs zu einer
  // Union-Spanne kollabiert, sodass nie zwei Balken übereinanderliegen.
  // Nicht überlappende gleichnamige Einträge (z. B. mehrere bewegliche
  // Ferientage) bleiben bewusst getrennt. (#434)
  const merged = mergeOverlappingByName(rows);

  return merged.map((r) => ({
    ...r,
    color: r.type === 'public' ? pubColor : schColor,
  }));
}

export { sync, getCountries, getSubdivisions, getGroups, getForRange, __setFetchImpl };

// Reine Regel-Engine fuer #965: hand-verifizierte Jahres-Fixtures (siehe
// test-holidays.js) laufen direkt hierueber statt ueber sync()'s begrenztes
// currentYear-1..+2-Fenster - so laesst sich z. B. der Jahresgrenzfall Neujahr
// 2028 (Samstag -> Silvester 2027) unabhaengig vom aktuellen Kalenderjahr
// pruefen, in dem die Tests laufen.
export const __test = { localHolidayFallback, expandCountryEntries, LOCAL_COUNTRIES };
