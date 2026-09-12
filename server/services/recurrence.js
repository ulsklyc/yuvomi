/**
 * Modul: Wiederholungsregeln (Recurrence)
 * Zweck: RRULE-Subset-Parser (FREQ=DAILY/WEEKLY/MONTHLY, BYDAY, INTERVAL, UNTIL)
 *        + Berechnung des nächsten Fälligkeitsdatums für wiederkehrende Aufgaben
 * Abhängigkeiten: keine
 */

const DAY_MAP = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 0 };

// Ein BYDAY-Token trägt optional eine Ordinalzahl voran ("2MO" = zweiter
// Montag, "-1FR" = letzter Freitag). Nur bei FREQ=MONTHLY sinnvoll (RFC 5545
// erlaubt es auch bei YEARLY, das bleibt hier bewusst aussen vor - #960s
// eigene Regel: nur lesen, was sich vollstaendig und ohne Klemmen/Ausfallen
// ausrechnen laesst).
const BYDAY_TOKEN_RE = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/;
// NUR 1 BIS 4 UND -1. Jeder Monat hat MINDESTENS vier Vorkommen jedes
// Wochentags (der laengste Abstand zwischen Monatsanfang und dem ersten
// Treffer ist sechs Tage, plus drei weitere Wochen sind es hoechstens 28) -
// das vierte und das letzte liegen deshalb IMMER innerhalb des Monats. Ein
// "5." nicht: der existiert nur in manchen Monaten, und das waere wieder das
// Klemmen-oder-Ausfallen-Problem, das dieser Datei schon bei BYMONTHDAY=31
// den Verzicht wert war.
const ORDINAL_BYDAY_VALUES = new Set([-1, 1, 2, 3, 4]);

/**
 * Parsed einen RRULE-String in ein Objekt.
 * Beispiel: "FREQ=WEEKLY;BYDAY=MO,TH;INTERVAL=1;COUNT=10"
 * @param {string} rule
 * @returns {{ freq, interval, byday, until, count, bymonthday, bydayOrdinal }|null}
 */
function parseRRule(rule) {
  if (!rule) return null;
  // Strip "RRULE:" prefix if present (ICS stores rules as "RRULE:FREQ=...")
  const raw = rule.startsWith('RRULE:') ? rule.slice(6) : rule;
  const parts = {};
  for (const segment of raw.split(';')) {
    const eq = segment.indexOf('=');
    if (eq === -1) continue;
    parts[segment.slice(0, eq).toUpperCase()] = segment.slice(eq + 1);
  }

  const freq     = parts.FREQ ?? null;
  const freqRaw  = String(freq ?? '').toUpperCase();
  const interval = parseInt(parts.INTERVAL ?? '1', 10) || 1;
  // Jedes Token einzeln lesen: ein waagerechtes Ordinal-Praefix ("2MO") faellt
  // beim reinen DAY_MAP-Zugriff still durch (unveraendertes Verhalten fuer
  // jede Regel, die dieses Modul nicht als vollstaendig ordinal erkennt -
  // siehe bydayOrdinal unten). `byday` bleibt deshalb genau die Menge der
  // NICHT-ordinalen Tage, wie bisher.
  const byDayEntries = (parts.BYDAY ?? '').split(',')
    .map((d) => d.trim().toUpperCase())
    .filter(Boolean)
    .map((tok) => {
      const m = BYDAY_TOKEN_RE.exec(tok);
      if (!m) return null;
      return { ordinal: m[1] ? parseInt(m[1], 10) : null, weekday: DAY_MAP[m[2]] };
    })
    .filter((e) => e !== null);
  const byday = byDayEntries.filter((e) => e.ordinal === null).map((e) => e.weekday);
  // NUR EIN EINZELNES ORDINAL-TOKEN, UND NUR BEI MONTHLY. Mehrere ordinale
  // Tage ("2MO,2TU") oder ein ordinales Token neben einem einfachen sind
  // Kombinationen, die dieses Modul nicht rechnet - dieselbe Zurueckhaltung
  // wie bei BYMONTHDAY: lieber gar nicht lesen als falsch rechnen.
  let bydayOrdinal = null;
  if (freqRaw === 'MONTHLY' && byDayEntries.length === 1 && byDayEntries[0].ordinal !== null
    && ORDINAL_BYDAY_VALUES.has(byDayEntries[0].ordinal)) {
    bydayOrdinal = { ordinal: byDayEntries[0].ordinal, weekday: byDayEntries[0].weekday };
  }
  const until    = parts.UNTIL ? parseUntilDate(parts.UNTIL) : null;
  // COUNT begrenzt die Serie auf N Vorkommen (DTSTART = Vorkommen 1). Der
  // stateless nextOccurrence() kann COUNT nicht selbst durchsetzen – das
  // übernimmt die Expansion (expandRecurringEvents), die von DTSTART zählt.
  const countRaw = parts.COUNT ? parseInt(parts.COUNT, 10) : null;
  const count    = Number.isInteger(countRaw) && countRaw > 0 ? countRaw : null;
  // NUR `-1`, UND NUR BEI MONTHLY. Die erste Fassung las den ganzen
  // RFC-Wertebereich, "weil Fremdkalender ihn liefern" - und hat damit sieben
  // Fehlerfaelle aufgemacht, die sie nicht bedienen konnte: `BYMONTHDAY=31`
  // muesste im Februar AUSFALLEN statt zu klemmen, `1,15` meint zwei Tage im
  // Monat, `FREQ=YEARLY;BYMONTHDAY=-1` meint zwoelf Vorkommen im Jahr und nicht
  // eines, und bei DAILY/WEEKLY filtert es Tage, statt sie zu setzen.
  //
  // Was diese Funktion nicht ausdruecken kann, darf sie nicht annehmen: eine
  // gelesene, aber falsch gerechnete Angabe verschiebt Termine still, waehrend
  // eine ignorierte die Serie bei ihrem DTSTART-Tag laesst - dem Verhalten von
  // vor #960. Genau `-1` bei `FREQ=MONTHLY` ist die eine Aussage, die die
  // Oberflaeche erzeugt und die hier vollstaendig implementiert ist.
  const bymonthday = freqRaw === 'MONTHLY' && String(parts.BYMONTHDAY ?? '').trim() === '-1'
    ? -1
    : null;

  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return null;

  return { freq, interval, byday, until, count, bymonthday, bydayOrdinal };
}

/**
 * Der Tag im Zielmonat fuer eine ordinale BYDAY-Regel ("2MO", "-1FR").
 * `ordinal` ist -1 (letzter) oder 1-4 (n-ter) - beide Faelle liegen laut
 * `ORDINAL_BYDAY_VALUES`s eigener Begruendung IMMER innerhalb des Monats,
 * keine Klemmung noetig.
 * @param {number} year
 * @param {number} month  0-basiert, darf > 11 sein (Date.UTC normalisiert)
 * @param {number} weekday 0 (So) - 6 (Sa)
 * @param {number} ordinal -1 oder 1-4
 * @returns {number} Tag im Monat (1-28)
 */
function nthWeekdayOfMonth(year, month, weekday, ordinal) {
  if (ordinal === -1) {
    const lastDate = new Date(Date.UTC(year, month + 1, 0));
    const diff = (lastDate.getUTCDay() - weekday + 7) % 7;
    return lastDate.getUTCDate() - diff;
  }
  const firstDate = new Date(Date.UTC(year, month, 1));
  const diff = (weekday - firstDate.getUTCDay() + 7) % 7;
  return 1 + diff + (ordinal - 1) * 7;
}

/** Ist `day` (ein Date in UTC-Tagesgranularitaet) das n-te/letzte `weekday` seines eigenen Monats? */
function isNthWeekdayOfMonth(day, weekday, ordinal) {
  if (day.getUTCDay() !== weekday) return false;
  return day.getUTCDate() === nthWeekdayOfMonth(day.getUTCFullYear(), day.getUTCMonth(), weekday, ordinal);
}

/**
 * Der Tag im Zielmonat: der letzte, wenn die Regel ihn nennt, sonst der
 * gemeinte aus Anker oder Basisdatum - geklemmt wie eh und je.
 *
 * DAS KLEMMEN GILT NUR FUER DEN FALLBACK. Ein Datum auf den letzten Tag eines
 * kurzen Monats zu ziehen ist eine Hausregel fuer Serien, die aus ihrem
 * Startdatum leben (ein 31. Januar wird im Februar zum 28.); auf eine
 * ausdrueckliche Regel angewandt waere es etwas anderes - RFC 5545 laesst ein
 * `BYMONTHDAY=31` im Februar AUSFALLEN, statt es zu verschieben. Deshalb liest
 * `parseRRule` nur `-1`, und deshalb steht hier kein Zahlenbereich mehr.
 */
function monthDayFor(bymonthday, lastDay, fallbackDay) {
  if (bymonthday === -1) return lastDay;
  return Math.min(Math.max(fallbackDay, 1), lastDay);
}

function parseUntilDate(str) {
  // Akzeptiert YYYYMMDD oder YYYYMMDDTHHmmssZ
  const clean = str.replace(/[TZ]/g, '');
  const y = parseInt(clean.slice(0, 4), 10);
  const m = parseInt(clean.slice(4, 6), 10) - 1;
  const d = parseInt(clean.slice(6, 8), 10);
  return new Date(Date.UTC(y, m, d));
}

/**
 * Berechnet das nächste Fälligkeitsdatum nach dem gegebenen Basisdatum.
 *
 * ── DER ANKER, UND WARUM ES IHN GIBT ──────────────────────────────────────
 *
 * Ohne ihn ist der gemeinte Tag der des VORIGEN Vorkommens - und weil ein
 * kurzer Monat ihn klemmt, ist er danach ein anderer. Eine am 31. Januar
 * begonnene Serie fiel so ab dem Februar dauerhaft auf den 28., und eine
 * jährliche am 29. Februar kam auch im nächsten Schaltjahr nicht zurück
 * (#978). Die Klemmung ist ein Wegwerf-Ergebnis; wer sie als Ausgangspunkt
 * nimmt, schreibt sie fest.
 *
 * Zwei Wege führen aus dem Kreis, und beide sind hier drin:
 *  - Die REGEL trägt den Tag (`BYMONTHDAY`, #960). Sie sticht alles andere,
 *    weil sie eine Aussage ist und kein Nebenprodukt.
 *  - Der AUFRUFER trägt ihn: wer DTSTART kennt, reicht es als `anchor` durch.
 *    Kalender-Expansion, ICS-Parser und die Serienrechnung tun das; sie
 *    iterieren ohnehin ab dem Serienstart. `nextDueAfterCompletion` kann es
 *    nicht - eine Aufgabenserie ist eine Kette einzelner Zeilen und kennt
 *    ihren Ursprung nicht -, und dort bleibt es beim bisherigen Verhalten.
 *
 * @param {string} baseDateStr - ISO-Datums-String (YYYY-MM-DD)
 * @param {string} rrule       - RRULE-String
 * @param {object} [opts]
 * @param {string} [opts.anchor] - DTSTART der Serie (YYYY-MM-DD). Bestimmt Tag
 *        (und bei YEARLY den Monat), wenn die Regel selbst keinen nennt.
 * @returns {string|null}      - Nächstes Datum als YYYY-MM-DD oder null (Ende der Serie)
 */
function nextOccurrence(baseDateStr, rrule, {
  anchor = null, fromArbitraryDate = false, utcDiffersFromLocal = false,
} = {}) {
  const parsed = parseRRule(rrule);
  if (!parsed || !baseDateStr) return null;

  const base = new Date(baseDateStr + 'T00:00:00Z');
  if (isNaN(base.getTime())) return null;

  // Ein unlesbarer Anker ist kein Anker: lieber das bisherige Verhalten als ein
  // NaN, das sich als Datum durch die ganze Serie zieht.
  const anchorDate = anchor ? new Date(anchor + 'T00:00:00Z') : null;
  const anchorDay = anchorDate && !isNaN(anchorDate.getTime()) ? anchorDate.getUTCDate() : null;

  const { freq, interval, byday, until } = parsed;
  const next = new Date(base);

  if (freq === 'DAILY' && byday.length === 0) {
    next.setUTCDate(next.getUTCDate() + interval);

  } else if (freq === 'WEEKLY' || (freq === 'DAILY' && byday.length > 0)) {
    if (byday.length === 0) {
      // Kein BYDAY → selber Wochentag, nächste Woche
      next.setUTCDate(next.getUTCDate() + 7 * interval);
    } else {
      // FREQ=DAILY;BYDAY zählt Tage, nicht Wochen: das nächste Vorkommen ist
      // schlicht der nächste passende Wochentag, ohne Wochen-Intervall-Sprung.
      // Apple/iOS serialisiert "jeden Werktag" so (#549).
      const weekInterval = freq === 'WEEKLY' ? interval : 1;
      // Finde den nächsten passenden Wochentag (nach heute)
      const currentDay = base.getUTCDay();
      const sorted = [...byday].sort((a, b) => {
        const da = (a - currentDay + 7) % 7 || 7;
        const db = (b - currentDay + 7) % 7 || 7;
        return da - db;
      });
      // Tage bis zum nächsten Vorkommen (mind. 1, damit nicht derselbe Tag)
      let daysUntil = (sorted[0] - currentDay + 7) % 7;
      if (daysUntil === 0) {
        // Selber Wochentag → ganzes Intervall überspringen
        daysUntil = 7 * weekInterval;
      } else if ((sorted[0] + 6) % 7 < (currentDay + 6) % 7) {
        // Wochengrenze überschritten (ISO-Woche MO–SO) → interval-1 Wochen extra überspringen
        daysUntil += 7 * (weekInterval - 1);
      }
      next.setUTCDate(next.getUTCDate() + daysUntil);
    }

  } else if (freq === 'MONTHLY') {
    // DIE KLEMMUNG MUSS VOR DEM MONATSWECHSEL STEHEN, NICHT DANACH.
    //
    // Vorher lief hier `setUTCMonth(+interval)` auf einem Datum, das noch den
    // 31. trug - und ein 31. Februar rollt in JavaScript still auf den 3. März
    // weiter. Die Korrektur danach griff deshalb nie: `lastDay` wurde für den
    // Monat gerechnet, in den der Überlauf schon geraten war. Der kurze Monat
    // fiel nicht auf seinen letzten Tag, er fiel ganz aus. Eine monatliche
    // Aufgabe am 31. kam in sieben von zwölf Monaten, und bei INTERVAL=2 kippte
    // obendrein der Takt: vom 31. Juli ging es drei Monate weiter auf den
    // 31. Oktober, weil der übersprungene September den Rhythmus verschob.
    //
    // `Date.UTC` normalisiert einen Monatsindex jenseits von 11 von sich aus,
    // deshalb braucht der Jahreswechsel keine eigene Zeile - und `(month + 1, 0)`
    // ist der letzte Tag von `month`, gerechnet BEVOR irgendetwas überläuft.
    //
    // WAS DAS NICHT BEHEBT: die Klemmung ist ein Wegwerf-Ergebnis. Das nächste
    // Vorkommen wird vom geklemmten Datum aus weitergerechnet, also bleibt eine
    // am 31. Januar begonnene Serie ab dem Februar dauerhaft auf dem 28. Dafür
    // müsste die Regel den gemeinten Tag tragen (BYMONTHDAY, #960) oder die
    // Serie ihren Ursprung kennen; beides ist mehr als eine Rechenkorrektur.
    // DAS NAECHSTE VORKOMMEN KANN IM SELBEN MONAT LIEGEN. Bei `BYMONTHDAY=-1`
    // und einem Basisdatum vor dem Monatsletzten ist der naechste Termin dieser
    // Monatsletzte, nicht der des Folgemonats - sonst faellt er ganz aus. Der
    // Fall entsteht, sobald DTSTART nicht selbst auf der Regel liegt: eine am
    // 15. angelegte Serie lief bis hierher vom 15. Januar direkt auf den
    // 28. Februar, und der 31. Januar wurde nie erzeugt.
    //
    // NUR WENN `base` EIN VORKOMMEN SEIN SOLL. `nextDueAfterCompletion` reicht
    // bei "ab Erledigung" (#658) den Tag des Abhakens herein - ein beliebiges
    // Datum, das die Serie gar nicht kennt. Dort faengt das Intervall an diesem
    // Tag NEU an; die Abkuerzung wuerde es verschlucken und aus "alle drei
    // Monate, erledigt am 10. Maerz" den 31. Maerz machen statt des 30. Juni.
    const year  = base.getUTCFullYear();
    let   month = base.getUTCMonth() + interval;
    let targetDay;
    if (parsed.bydayOrdinal) {
      // ORDINALE BYDAY-REGEL ("2MO", "-1FR"): derselbe "kann im selben Monat
      // liegen"-Fall wie BYMONTHDAY=-1 unten, aus demselben Grund - eine am
      // 1. angelegte "zweiter Montag"-Serie soll den zweiten Montag DIESES
      // Monats liefern, nicht den des Folgemonats.
      const { weekday, ordinal } = parsed.bydayOrdinal;
      if (!fromArbitraryDate && !utcDiffersFromLocal) {
        const targetInBaseMonth = nthWeekdayOfMonth(year, base.getUTCMonth(), weekday, ordinal);
        if (base.getUTCDate() < targetInBaseMonth) month = base.getUTCMonth();
      }
      targetDay = nthWeekdayOfMonth(year, month, weekday, ordinal);
    } else {
      // DAS NAECHSTE VORKOMMEN KANN IM SELBEN MONAT LIEGEN. Bei `BYMONTHDAY=-1`
      // und einem Basisdatum vor dem Monatsletzten ist der naechste Termin
      // dieser Monatsletzte, nicht der des Folgemonats - sonst faellt er ganz
      // aus (siehe Modulkopf-Kommentar oben fuer das volle Beispiel).
      if (parsed.bymonthday === -1 && !fromArbitraryDate && !utcDiffersFromLocal) {
        const letzterImBasismonat = new Date(Date.UTC(year, base.getUTCMonth() + 1, 0)).getUTCDate();
        if (base.getUTCDate() < letzterImBasismonat) month = base.getUTCMonth();
      }
      const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
      // BEI EINER SERIE MIT EIGENER ZONE WIRD DIE ANGABE GAR NICHT ANGEWANDT.
      // Sie meint einen LOKALEN Monatsletzten, gerechnet wird hier aber auf
      // UTC-Tagen - ein Termin am 31. Januar um 20:00 New Yorker Zeit liegt in
      // UTC am 1. Februar, und die Rechnung machte daraus den 27. Februar lokal.
      // Ohne sie laeuft die Serie auf ihrem festen UTC-Tag weiter, und der
      // gleichbleibende Versatz trifft den lokalen Monatsletzten von selbst.
      // Yuvomis eigene Termine sind davon nicht betroffen: sie tragen keine
      // fremde Zone, also stimmt ihr UTC-Tag mit dem lokalen ueberein.
      //
      // WAS DAS NICHT LOEST: ueber eine Sommerzeitumstellung hinweg trifft der
      // feste UTC-Tag den lokalen Monatsletzten NICHT mehr - eine New Yorker
      // Serie am 31.01. 23:30 landet nach der Umstellung auf dem 1. April statt
      // dem 31. Maerz. Dafuer muesste die Expansion in der Ereigniszone rechnen
      // und je Vorkommen zurueckrechnen; das ist ein eigener Vorgang.
      const wirksam = utcDiffersFromLocal ? null : parsed.bymonthday;
      targetDay = monthDayFor(wirksam, lastDay, anchorDay ?? base.getUTCDate());
    }
    next.setTime(Date.UTC(year, month, targetDay));

  } else if (freq === 'YEARLY') {
    // Monat UND Tag kommen aus dem Anker, wenn es einen gibt: sonst ist der 29.
    // Februar nach dem ersten Nicht-Schaltjahr fuer immer der 28. (#978).
    // `anchorDay !== null`, nicht `anchorDate`: eine Invalid Date ist ein
    // truthy Objekt, und `getUTCMonth()` daraus ist NaN. Das floss bis in
    // `Date.UTC` und liess `toISOString()` mit RangeError abbrechen - genau das,
    // was der Guard oben verhindern soll. Der Fallback-Test deckte nur MONTHLY.
    const targetMonth = anchorDay !== null ? anchorDate.getUTCMonth() : base.getUTCMonth();
    const year        = base.getUTCFullYear() + interval;
    const lastDay     = new Date(Date.UTC(year, targetMonth + 1, 0)).getUTCDate();
    // Feb 29 in einem Nicht-Schaltjahr → Feb 28, aber ohne den Anker zu verlieren.
    const targetDay = monthDayFor(parsed.bymonthday, lastDay, anchorDay ?? base.getUTCDate());
    next.setTime(Date.UTC(year, targetMonth, targetDay));
  }

  // UNTIL-Grenze prüfen
  if (until && next > until) return null;

  return next.toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * So viele Einzelschritte holt das Aufholen höchstens nach.
 *
 * DIE ZAHL IST EIN SICHERHEITSNETZ, KEINE REICHWEITE. Sie war es einmal nicht:
 * bei 1000 Schritten gab eine tägliche Serie ab 2023 auf und eine wöchentliche
 * ab 2005 ebenso - beides gewöhnliche Einträge, keine Randfälle. Das Ergebnis
 * war ein Datum in der Vergangenheit, das der Aufrufer als "gibt es nicht mehr"
 * las: ein Termin, der heute stattfindet, verschwand (#877).
 *
 * Die Reichweite kommt jetzt vom Vorsprung darunter, der in Intervallschritten
 * springt statt zu zählen. Was danach noch iteriert wird, sind die Fälle mit
 * BYDAY, und dort liegt die Schrittweite unter einer Woche - 2000 Schritte
 * decken damit gut drei Jahrzehnte ab.
 */
const CATCH_UP_STEPS = 2000;

/**
 * Springt in Intervallschritten dicht an `notBeforeStr` heran.
 *
 * WARUM RECHNEN STATT ZAEHLEN. Eine tägliche Serie von 2015 bis heute sind
 * viertausend Einzelschritte, jeder mit einem eigenen Date-Objekt - und das
 * bei jedem Aufbau der Übersicht. Wie viele Intervalle dazwischenliegen, lässt
 * sich für die Frequenzen ohne Wochentagsfilter direkt ausrechnen.
 *
 * MIT BYDAY WIRD NICHT GESPRUNGEN. Dort bestimmt nicht das Intervall allein,
 * wann das nächste Vorkommen liegt ("jeden zweiten Montag und Donnerstag"),
 * und ein Sprung könnte über ein Vorkommen hinweggehen. Diese Fälle laufen
 * weiter über die Schleife - ihre Schritte sind klein genug.
 *
 * BEWUSST EIN STUECK ZU KURZ: der Sprung landet garantiert NICHT hinter dem
 * Ziel, damit die Schleife danach das erste passende Vorkommen findet. Ein
 * Sprung, der zu weit ginge, überspränge genau das Vorkommen, das gesucht ist.
 *
 * MONATLICH UND JAEHRLICH NUR BIS ZUM 28. Eine Serie am 31. läuft nicht auf
 * einem festen Monatsraster: der 31. Juni existiert nicht, `nextOccurrence()`
 * schiebt sie auf den nächsten Monat, und ab da DRIFTET sie - aus "alle fünf
 * Monate ab dem 31. Januar" wird der 31. Juli statt des 30. Juni. Die Zahl der
 * Kalendermonate ist dann nicht mehr die Zahl der Schritte, und ein Sprung
 * darüber landet Monate daneben (gemessen: 2026-12-31 statt 2026-08-31).
 *
 * Diese Serien laufen weiter über die Schleife. Das kostet nichts: monatlich
 * sind zwölf Schritte im Jahr, die Grenze von 2000 reicht für Jahrhunderte -
 * anders als täglich, wo genau das der gemeldete Fehler war.
 *
 * @returns {string} das Datum, ab dem weitergezählt wird (nie hinter notBefore)
 */
function fastForward(fromKey, parsed, notBeforeKey) {
  const { freq, interval, byday, bydayOrdinal } = parsed;
  // Eine ordinale BYDAY-Regel laeuft so wenig auf einem festen Kalenderraster
  // wie eine mit BYDAY-Wochentagsfilter (Kommentar unten) - "zweiter Montag"
  // ist nicht "plus ein Monat" auf einem festen Tag.
  if (byday.length || bydayOrdinal) return fromKey;

  const from = new Date(`${fromKey}T00:00:00Z`);
  const to   = new Date(`${notBeforeKey}T00:00:00Z`);
  if (isNaN(from.getTime()) || isNaN(to.getTime()) || to <= from) return fromKey;
  if ((freq === 'MONTHLY' || freq === 'YEARLY') && from.getUTCDate() > 28) return fromKey;

  const days = Math.floor((to - from) / 86400000);
  let steps;
  if (freq === 'DAILY')       steps = Math.floor(days / interval);
  else if (freq === 'WEEKLY')  steps = Math.floor(days / (7 * interval));
  else {
    // MONTHLY und YEARLY über Kalendermonate, nicht über Tage: ein Monat ist
    // keine feste Anzahl Tage, und eine Näherung liefe über die Jahre auseinander.
    const months = (to.getUTCFullYear() - from.getUTCFullYear()) * 12
      + (to.getUTCMonth() - from.getUTCMonth());
    steps = Math.floor(months / (freq === 'YEARLY' ? 12 * interval : interval));
  }
  // Einen Schritt Sicherheitsabstand - siehe oben.
  steps -= 1;
  if (!Number.isFinite(steps) || steps <= 0) return fromKey;

  const jumped = new Date(from);
  if (freq === 'DAILY')        jumped.setUTCDate(jumped.getUTCDate() + steps * interval);
  else if (freq === 'WEEKLY')  jumped.setUTCDate(jumped.getUTCDate() + steps * 7 * interval);
  else if (freq === 'MONTHLY') jumped.setUTCMonth(jumped.getUTCMonth() + steps * interval);
  else                          jumped.setUTCFullYear(jumped.getUTCFullYear() + steps * interval);

  const key = jumped.toISOString().slice(0, 10);
  // MONTHLY kippt bei einem 31. in einen kürzeren Monat um ein paar Tage
  // vorwärts (JS-Datumsarithmetik). Dann lieber gar nicht springen als
  // daneben - die Schleife kann es ohnehin.
  return key > notBeforeKey || key < fromKey ? fromKey : key;
}

/**
 * Wie nextOccurrence, überspringt aber alle Vorkommen vor `notBeforeStr`, bis das
 * erste Vorkommen >= notBeforeStr gefunden ist (Aufholen übersprungener Serien).
 * Gibt null zurück, wenn die Serie (UNTIL) vorher endet oder kein Basisdatum existiert.
 *
 * `seriesStart` SETZT ZUSAETZLICH `COUNT` DURCH. Ohne die Angabe bleibt es beim
 * bisherigen Verhalten - `nextOccurrence()` ist zustandslos und kann nicht
 * wissen, das wievielte Vorkommen es gerade liefert. Wer den Serienanfang
 * kennt, kann zählen: das letzte erlaubte Vorkommen ist `seriesStart` plus
 * (COUNT - 1) Intervalle, und alles danach gibt es nicht mehr.
 *
 * WARUM DAS NICHT IMMER GILT: `nextDueAfterCompletion()` reicht als Basis das
 * Fälligkeitsdatum der gerade erledigten Instanz herein, nicht den Serienstart.
 * Von dort zu zählen ergäbe eine Serie, die sich bei jedem Abhaken verlängert -
 * also lieber gar nicht zählen als falsch. Deshalb ist es eine Angabe des
 * Aufrufers und keine Vermutung dieser Funktion.
 *
 * @param {string} baseDateStr  - ISO-Datums-String (YYYY-MM-DD)
 * @param {string} rrule        - RRULE-String
 * @param {string} notBeforeStr - Untere Schranke (YYYY-MM-DD); Ergebnis ist >= dieser
 * @param {{seriesStart?: string|null}} [opts]
 * @returns {string|null}       - Nächstes zukünftiges Datum als YYYY-MM-DD oder null
 */
function nextOccurrenceAfter(baseDateStr, rrule, notBeforeStr, { seriesStart = null } = {}) {
  const parsed = parseRRule(rrule);
  if (!parsed) return null;

  const lastAllowed = seriesStart ? lastOccurrenceOf(seriesStart, parsed) : null;
  // Die Serie ist aufgebraucht, bevor die Schranke ueberhaupt erreicht wird.
  if (lastAllowed && notBeforeStr && lastAllowed < notBeforeStr) return null;

  const start = notBeforeStr ? fastForward(baseDateStr, parsed, notBeforeStr) : baseDateStr;
  let current = nextOccurrence(start, rrule, { anchor: seriesStart });
  // Vergleich per lexikografischem YYYY-MM-DD-String (Format ist fix, daher sicher).
  let guard = 0;
  // AUFHOLEN HEISST: BIS ALLE FILTER PASSEN, NICHT NUR BIS ZUR SCHRANKE.
  // `BYMONTHDAY=-1` zusammen mit `BYDAY=MO` meint die Schnittmenge, aber
  // `nextOccurrence` springt nur von Monatsletztem zu Monatsletztem - ohne die
  // zweite Bedingung kam ein Mittwoch zurueck, waehrend die Kalender-Expansion
  // (die `matchesRRuleByday` anwendet) den naechsten Montag zeigte. Zwei
  // Antworten auf dieselbe Frage, je nachdem wer fragt. `seriesStartFor` laeuft
  // aus demselben Grund bis zum Treffer.
  while (
    current
    && guard++ < CATCH_UP_STEPS
    && ((notBeforeStr && current < notBeforeStr) || !matchesRRuleByday(current, rrule))
  ) {
    current = nextOccurrence(current, rrule, { anchor: seriesStart });
  }
  // OHNE TREFFER LIEBER NICHTS ALS DAS FALSCHE DATUM. Es gibt Kombinationen
  // ohne jedes Vorkommen (ein 31., der ein Sonntag ist, mit INTERVAL); ein
  // Datum zurueckzugeben, das die eigene Regel verfehlt, waere genau der
  // Fehler, den diese Schleife gerade behebt.
  if (current && !matchesRRuleByday(current, rrule)) return null;
  if (current && lastAllowed && current > lastAllowed) return null;
  return current;
}

/**
 * Das letzte Vorkommen einer Serie mit COUNT - oder null, wenn sie keines hat.
 *
 * DTSTART IST VORKOMMEN 1, deshalb (COUNT - 1) Intervalle. Mit BYDAY laesst
 * sich das nicht ausrechnen: dort haengt an einem Intervall mehr als ein
 * Vorkommen, und die Zahl derer vor der Schranke ist nicht die Zahl der
 * Intervalle. Solche Serien werden nicht begrenzt - lieber einer zu lang als
 * einer zu kurz, denn das Zuviel sieht man, das Zuwenig fehlt lautlos.
 *
 * @returns {string|null} YYYY-MM-DD
 */
function lastOccurrenceOf(seriesStart, parsed) {
  const { freq, interval, byday, count, bymonthday, bydayOrdinal } = parsed;
  // Dieselbe Zurueckhaltung wie bei plain BYDAY (mehrere Wochentage): dort
  // haengt an einem Intervall mehr als ein Vorkommen, und das laesst sich
  // nicht als feste Multiplikation zaehlen - lieber unbegrenzt als falsch
  // begrenzt. `bydayOrdinal` ist ANDERS: eine ordinale Regel ("2MO", "-1FR")
  // hat laut ORDINAL_BYDAY_VALUES' eigener Begruendung GENAU EIN Vorkommen je
  // Intervall (jeder Monat hat mindestens vier von jedem Wochentag und genau
  // einen letzten), also unten wie BYMONTHDAY=-1 direkt ausgerechnet statt
  // ebenfalls unbegrenzt gelassen.
  if (!count || byday.length) return null;

  const start = new Date(`${String(seriesStart).slice(0, 10)}T00:00:00Z`);
  if (isNaN(start.getTime())) return null;

  if (bydayOrdinal) {
    const { weekday, ordinal } = bydayOrdinal;
    // Wie bei BYMONTHDAY=-1 gilt: DTSTART ist nur dann Vorkommen 1, wenn sein
    // eigener Tag auf oder vor dem Zieltag desselben Monats liegt. Anders als
    // dort kann das hier tatsaechlich fehlschlagen (ein Monatsletzter ist
    // immer >= jedem Tag desselben Monats, ein "zweiter Montag" nicht) - liegt
    // DTSTART spaeter im Monat als der Zieltag, faellt Vorkommen 1 in den
    // Folgemonat, exakt wie nextOccurrence()'s eigene "kann im selben Monat
    // liegen"-Pruefung oben, nur umgekehrt geprueft.
    const targetInStartMonth = nthWeekdayOfMonth(start.getUTCFullYear(), start.getUTCMonth(), weekday, ordinal);
    const firstMonth = start.getUTCDate() <= targetInStartMonth ? start.getUTCMonth() : start.getUTCMonth() + 1;
    const zielMonat = firstMonth + (count - 1) * interval;
    const zielTag = nthWeekdayOfMonth(start.getUTCFullYear(), zielMonat, weekday, ordinal);
    return new Date(Date.UTC(start.getUTCFullYear(), zielMonat, zielTag)).toISOString().slice(0, 10);
  }

  /* EINE -1-SERIE LAEUFT NICHT AUF DEM RASTER IHRES STARTDATUMS, ABER AUF EINEM.
   * `FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=3` ab dem 15. Januar bedeutet Jan 15
   * (DTSTART ist Vorkommen 1), Feb 28, Mrz 31 - (COUNT - 1) Intervalle ab dem
   * Start ergaeben dagegen den 15. Maerz, und eine Grenze dort schneidet das
   * letzte Vorkommen ab.
   *
   * Die Grenze GANZ abzuschalten war die falsche Antwort darauf: dann lief eine
   * Serie mit COUNT=1 fuer immer weiter. Sie laesst sich hier genau rechnen,
   * weil jedes Vorkommen ausser dem ersten der letzte Tag seines Monats ist. */
  if (bymonthday === -1) {
    // AUCH HIER GILT: DTSTART IST NUR DANN VORKOMMEN 1, WENN ES AUF DER REGEL
    // LIEGT. Bei einem unsynchronisierten Start (15. Januar) ist das erste
    // Vorkommen der 31., und eine Grenze auf dem 15. wies genau dieses eine
    // Vorkommen ab - eine Serie mit COUNT=1 verschwand, sobald DTSTART vorbei
    // war, obwohl die Expansion sie noch lieferte.
    const erstes = new Date(Date.UTC(
      start.getUTCFullYear(), start.getUTCMonth() + 1, 0
    )).toISOString().slice(0, 10);
    if (count === 1) return erstes;
    const zielMonat = start.getUTCMonth() + (count - 1) * interval;
    const letzter = new Date(Date.UTC(start.getUTCFullYear(), zielMonat + 1, 0));
    return letzter.toISOString().slice(0, 10);
  }

  /* MONATLICH UND JAEHRLICH NUR BIS ZUM 28., aus demselben Grund wie beim
   * Sprung darueber: eine Serie am 31. laeuft nicht auf einem festen
   * Monatsraster, sondern driftet an jedem kurzen Monat. (COUNT - 1) Intervalle
   * waeren dann nicht ihr letztes Vorkommen, sondern irgendeines davor - und
   * eine zu frueh gesetzte Grenze schneidet Termine ab, die es noch gibt.
   * Solche Serien werden nicht begrenzt: einer zu lang sieht man, einer zu
   * kurz fehlt lautlos. */
  if ((freq === 'MONTHLY' || freq === 'YEARLY') && start.getUTCDate() > 28) return null;

  const steps = count - 1;
  const last = new Date(start);
  if (freq === 'DAILY')        last.setUTCDate(last.getUTCDate() + steps * interval);
  else if (freq === 'WEEKLY')  last.setUTCDate(last.getUTCDate() + steps * 7 * interval);
  else if (freq === 'MONTHLY') last.setUTCMonth(last.getUTCMonth() + steps * interval);
  else if (freq === 'YEARLY')  last.setUTCFullYear(last.getUTCFullYear() + steps * interval);
  else return null;

  return last.toISOString().slice(0, 10);
}

/**
 * Das nächste Fälligkeitsdatum, nachdem etwas Wiederkehrendes erledigt wurde.
 *
 * Zwei Verankerungen, und die Wahl gehört dem einzelnen Vorgang (#658):
 *
 * - `fromCompletion: false` (Vorgabe): die Serie hängt am Fälligkeitsdatum. Das
 *   Raster bleibt stehen, egal wann jemand abhakt - richtig für alles, was an
 *   einem äußeren Takt hängt (Müllabfuhr, Miete, Vereinsabend). Übersprungene
 *   Vorkommen werden aufgeholt, damit die nächste Instanz nicht selbst schon
 *   überfällig entsteht.
 * - `fromCompletion: true`: die Serie hängt am Tag des Abhakens. Richtig für
 *   alles, dessen Intervall erst mit der Handlung beginnt (Filter reinigen,
 *   Pflanzen düngen). Ein Aufholen entfällt: das Ergebnis liegt bei jedem
 *   positiven Intervall ohnehin in der Zukunft.
 *
 * Bewusst hier und nicht in der Route: #647 will dieselbe „ab dem Moment, wo du
 * es angefasst hast"-Rechnung für zurücksetzbare Countdowns.
 *
 * @param {object}  opts
 * @param {string}  opts.anchorDate      Fälligkeitsdatum der erledigten Instanz (YYYY-MM-DD)
 * @param {string}  opts.rule            RRULE-String
 * @param {string}  opts.completedOn     Tag des Abhakens (YYYY-MM-DD)
 * @param {boolean} [opts.fromCompletion] true = ab Erledigungstag rechnen
 * @returns {string|null} Nächstes Datum als YYYY-MM-DD oder null (Serienende)
 */
function nextDueAfterCompletion({ anchorDate, rule, completedOn, fromCompletion = false }) {
  if (fromCompletion) {
    return completedOn ? nextOccurrence(completedOn, rule, { fromArbitraryDate: true }) : null;
  }
  return nextOccurrenceAfter(anchorDate, rule, completedOn);
}

/**
 * Prüft, ob ein Datum zum BYDAY-Wochentagsfilter der Regel passt.
 * Ohne BYDAY (oder ohne parsebare Regel) gilt jedes Datum als passend – dann
 * steuern allein DTSTART und nextOccurrence die Serie. Fängt Serien ab, deren
 * DTSTART nicht auf einen Regeltag fällt (z.B. Anker am Wochenende, #549).
 * @param {string} dateStr - YYYY-MM-DD
 * @param {string} rrule   - RRULE-String
 * @returns {boolean}
 */
function matchesRRuleByday(dateStr, rrule, { utcDiffersFromLocal = false } = {}) {
  const parsed = parseRRule(rrule);
  if (!parsed) return true;
  const day = new Date(dateStr + 'T00:00:00Z');
  if (isNaN(day.getTime())) return true;

  // BYMONTHDAY GEHOERT HIERHER, NICHT NUR BYDAY. Der Name sagt das eine, die
  // Aufgabe ist die andere: "erfuellt dieses Datum die Regel?" Solange nur BYDAY
  // geprueft wurde, ging ein DTSTART, das nicht auf der Regel liegt, als
  // Vorkommen durch - eine am 15. angelegte Monatsletzten-Serie zeigte den
  // 15. Januar als ersten Termin, obwohl er keiner ist.
  //
  // NICHT AUF EINEM DATUM, DAS NICHT DAS LOKALE IST. Ein Termin am 31. Januar
  // um 20:00 New Yorker Zeit liegt in UTC schon am 1. Februar; die Pruefung
  // saehe dort den ersten statt des letzten Tages und wuerfe das Vorkommen
  // still weg. Wo der Aufrufer weiss, dass die beiden Kalendertage
  // auseinanderfallen koennen, wird nicht gefiltert - lieber ein Vorkommen zu
  // viel als eines, das lautlos verschwindet. (Der BYDAY-Zweig darunter hat
  // dieselbe Schwaeche seit jeher; sie wird hier nicht verschlimmert.)
  if (parsed.bymonthday === -1 && !utcDiffersFromLocal) {
    const letzter = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 0)).getUTCDate();
    if (day.getUTCDate() !== letzter) return false;
  }

  // Dieselbe Begruendung wie beim BYMONTHDAY-Zweig darueber, fuer eine
  // ordinale BYDAY-Regel ("2MO", "-1FR"): ein DTSTART, das nicht der zweite
  // Montag seines Monats ist, ist kein Vorkommen.
  if (parsed.bydayOrdinal && !utcDiffersFromLocal) {
    if (!isNthWeekdayOfMonth(day, parsed.bydayOrdinal.weekday, parsed.bydayOrdinal.ordinal)) return false;
  }

  if (parsed.byday.length === 0) return true;
  return parsed.byday.includes(day.getUTCDay());
}

/**
 * Wiederholungsregeln liegen in `calendar_events.recurrence_rule` in ZWEI
 * Schreibweisen: lokal angelegte Termine speichern den nackten Wert
 * (`FREQ=WEEKLY;...`), aus ICS oder CalDAV eingelesene Serien den vollen
 * Property-String mitsamt `RRULE:`-Praefix (ics-parser.js). Beides ist
 * gewachsen und wird nicht vereinheitlicht - eine zweite Schreibweise in der
 * Datenbank zu erzwingen waere teurer als eine Migration.
 *
 * Deshalb muss JEDER Ausgabepfad die Doppeldeutigkeit aufloesen, und genau das
 * ist die Stelle, an der es schiefging: fuenf Module bauten die Zeile je selbst,
 * vier lagen richtig, der ICS-Feed setzte das Praefix blind davor und schickte
 * `RRULE:RRULE:FREQ=...` (#761). Apple schluckt das, strikte Parser wie der von
 * Home Assistant lehnen das Event ab.
 */

/** Der nackte Regelwert, ohne `RRULE:` - fuer APIs, die nur den Wert wollen. */
export function rruleValue(rule) {
  return String(rule ?? '').replace(/^RRULE:/i, '');
}

/** Die vollstaendige ICS-Zeile mit GENAU einem `RRULE:`-Praefix. */
export function rruleLine(rule) {
  return `RRULE:${rruleValue(rule)}`;
}

/**
 * Hat diese Serie ueberhaupt ein Vorkommen?
 *
 * `FREQ=MONTHLY;BYMONTHDAY=-1;UNTIL=20260120` ab dem 15. Januar ist eine Regel,
 * die der Validator annimmt und die trotzdem leer ist: der erste Monatsletzte
 * liegt hinter dem UNTIL. Die Routen lehnen die Eingabe deshalb ab, statt eine
 * Serie zu speichern, die nie stattfindet.
 */
function hasAnyOccurrence(dateKey, rrule, { utcDiffersFromLocal = false } = {}) {
  if (!dateKey || !rrule) return true;
  const tag = String(dateKey).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tag)) return true;
  const parsed = parseRRule(rrule);
  // Dieselbe Frage gilt fuer eine ordinale BYDAY-Regel wie fuer BYMONTHDAY=-1:
  // ein DTSTART vor dem UNTIL kann trotzdem hinter dem einzigen "zweiten
  // Montag" der Serie liegen.
  if (parsed?.bymonthday !== -1 && !parsed?.bydayOrdinal) return true;
  return seriesStartFor(tag, rrule, { utcDiffersFromLocal }) !== tag
    || matchesRRuleByday(tag, rrule, { utcDiffersFromLocal });
}

/**
 * Das erste Vorkommen der Regel am oder nach `dateKey`.
 *
 * NUR LESEND. Ein DTSTART, das die eigene Regel nicht erfuellt, wird damit
 * NICHT korrigiert - der gespeicherte Wert bleibt, was eingegeben oder
 * eingelesen wurde. Der Versuch, ihn beim Speichern zu ziehen, stand einmal
 * hier und ist zurueckgenommen: `start_datetime` und `due_date` haengen an
 * Vorlauf, Erinnerung, Folgeinstanz und optimistischem Render, und jede dieser
 * Stellen rechnete danach auf einem Datum, das der Server hinterher geaendert
 * hatte. Wer den ersten Tag braucht, fragt hier - und laesst den Datensatz in
 * Ruhe.
 *
 * Was das offen laesst: nach draussen bleibt ein unsynchronisiertes DTSTART
 * mehrdeutig, RFC 5545 nennt das Ergebnis dort ausdruecklich "undefined". Das
 * gehoert in die Ausgabe-Serialisierer, nicht in die Schreibroute.
 *
 * Ohne Regel oder ohne Datum bleibt alles, wie es ist.
 *
 * @param {string} dateKey YYYY-MM-DD (oder ein ISO-Zeitstempel; der Tag zaehlt)
 * @param {string} rrule
 * @returns {string} derselbe Tag, wenn er passt - sonst der naechste, der passt
 */
function seriesStartFor(dateKey, rrule, { utcDiffersFromLocal = false } = {}) {
  if (!dateKey || !rrule) return dateKey;
  const tag = String(dateKey).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tag)) return dateKey;

  // NUR FUER BYMONTHDAY UND ORDINALE BYDAY-REGELN. Ein DTSTART, das ein
  // einfaches BYDAY-Muster nicht trifft, bleibt ausdruecklich stehen: Apple
  // serialisiert "jeden Werktag" als Serie, deren Start auf ein Wochenende
  // fallen kann, und die Expansion ueberspringt ihn (#549). Diese Entscheidung
  // ist aelter und gilt weiter - hier geht es allein um die Angaben, die
  // Yuvomi selbst erzeugt und die sonst nach draussen uneindeutig waeren.
  const parsedForStart = parseRRule(rrule);
  if (parsedForStart?.bymonthday !== -1 && !parsedForStart?.bydayOrdinal) return dateKey;
  if (matchesRRuleByday(tag, rrule, { utcDiffersFromLocal })) return dateKey;

  // BIS ALLE FILTER PASSEN, NICHT NUR EINEN SCHRITT WEIT. `BYMONTHDAY=-1`
  // zusammen mit `BYDAY=MO` ist gueltig und meint die Schnittmenge: der erste
  // Monatsletzte kann ein Samstag sein, dann ist er kein Vorkommen und es geht
  // weiter. Ein einzelner Aufruf haette wieder ein Datum geliefert, das seine
  // eigene Regel verfehlt - denselben Fehler, gegen den diese Funktion gebaut
  // ist, nur eine Runde spaeter.
  //
  // Die Obergrenze ist ein Sicherheitsnetz, keine Reichweite: eine Kombination
  // ohne Treffer (es gibt sie, etwa jeder 31. der ein Sonntag ist, mit
  // INTERVAL) laeuft sonst bis zum Zeitlimit. Ohne Treffer bleibt das Datum
  // stehen - lieber unveraendert als erfunden.
  let kandidat = tag;
  for (let i = 0; i < 120; i++) {
    const next = nextOccurrence(kandidat, rrule, { anchor: tag });
    if (!next || next <= kandidat) return dateKey;
    kandidat = next;
    if (matchesRRuleByday(kandidat, rrule, { utcDiffersFromLocal })) return String(dateKey).replace(tag, kandidat);
  }
  return dateKey;
}

export {
  parseRRule, nextOccurrence, nextOccurrenceAfter, nextDueAfterCompletion, matchesRRuleByday,
  seriesStartFor, hasAnyOccurrence,
};
