/**
 * Modul: Medikamenten-Logik (Health)
 * Zweck: Reine, DOM-freie Kernfunktionen für den Medikamente-Tab — Fälligkeit
 *        aus Einnahmeplänen (computeDueDoses), Adherence-Quote (computeAdherence)
 *        und Bestands-/Refill-Status (refillState) plus Wochentags-Masken-Helfer.
 *        Analog zu health-vitals.js bewusst OHNE i18n/DOM, damit die Funktionen in
 *        Node ohne Browser-Umgebung getestet werden können.
 * Abhängigkeiten: /utils/date.js (ebenfalls DOM-frei).
 */

import { parseLocalDateKey, addLocalDays } from '/utils/date.js';

// Wochentags-Konvention der days_mask: Bit 0 = Montag … Bit 6 = Sonntag.
// NULL/undefined = täglich (jeder Wochentag). 0 = kein Wochentag.
export const WEEKDAY_COUNT = 7;

/** Wochentag-Index eines Datums (YYYY-MM-DD) mit Montag = 0 … Sonntag = 6. */
export function weekdayIndex(dateKey) {
  const d = parseLocalDateKey(dateKey);
  return (d.getDay() + 6) % 7;
}

/** Prüft, ob eine days_mask den gegebenen Wochentag (Mo=0…So=6) enthält. */
export function daysMaskMatches(mask, weekdayIdx) {
  if (mask === null || mask === undefined || mask === '') return true; // täglich
  return (Number(mask) & (1 << weekdayIdx)) !== 0;
}

/** days_mask → Array der gesetzten Wochentag-Indizes (Mo=0…So=6). NULL → alle. */
export function daysMaskToIndices(mask) {
  const out = [];
  for (let i = 0; i < WEEKDAY_COUNT; i++) {
    if (daysMaskMatches(mask, i)) out.push(i);
  }
  return out;
}

/**
 * Array von Wochentag-Indizes → days_mask.
 * Gibt null zurück, wenn alle oder kein Tag gewählt ist (= täglich).
 */
export function indicesToDaysMask(indices) {
  const set = new Set((Array.isArray(indices) ? indices : []).map(Number));
  if (set.size === 0 || set.size >= WEEKDAY_COUNT) return null;
  let mask = 0;
  for (const i of set) {
    if (i >= 0 && i < WEEKDAY_COUNT) mask |= (1 << i);
  }
  return mask === 0 ? null : mask;
}

/**
 * DIE Regel "dieses Medikament zaehlt heute" (#1950).
 *
 * Ein abgeschaltetes Medikament (`medications.active = 0`) bleibt in der Liste
 * und behaelt sein Protokoll, erzeugt aber keine faellige Dosis mehr. Die
 * Gesundheitsseite sammelte die Plaene JEDES geladenen Medikaments ein und
 * nannte deshalb eine offene Dosis, zu der die Startseite
 * (`server/routes/dashboard.js`, `WHERE active = 1`) und der Erinnerungslauf
 * (`server/services/medication-scheduler.js`, `m.active = 1`) schwiegen.
 *
 * Sie steht EINMAL hier und nicht an jedem Leser: wer wissen will, ob ein
 * Medikament Dosen erzeugt, fragt diese Funktion oder nimmt `currentSchedules()`.
 * Eine weitere Bedingung (etwa ein Enddatum) gehoert in diese Funktion.
 *
 * `active` am PLAN ist eine andere Frage und bleibt bei `computeDueDoses()`.
 *
 * @param {Object|null|undefined} med - Medikamenten-Zeile mit `active`.
 * @returns {boolean}
 */
export function medicationCountsToday(med) {
  return Boolean(med && med.active);
}

/**
 * Die Einnahmeplaene der Medikamente, die heute zaehlen - der eine Eingang fuer
 * jeden Leser der Faelligkeit (Heute faellig, naechste Erinnerungen,
 * Einnahmetreue, Serie).
 *
 * @param {Array<Object>} meds - Medikamenten-Zeilen, wie die Seite sie laedt.
 * @param {Object<string, Array<Object>>} schedulesByMed - Plaene je Medikamenten-Id.
 * @returns {Array<Object>}
 */
export function currentSchedules(meds, schedulesByMed) {
  return (Array.isArray(meds) ? meds : [])
    .filter(medicationCountsToday)
    .flatMap((m) => (schedulesByMed && schedulesByMed[m.id]) || []);
}

/**
 * Berechnet die fälligen Dosen aus aktiven Einnahmeplänen für einen Zeitraum.
 *
 * Welche MEDIKAMENTE dabei sind, entscheidet der Aufrufer ueber
 * `currentSchedules()` - diese Funktion sieht nur Plaene.
 *
 * @param {Array<Object>} schedules - Einnahmeplan-Zeilen. Erwartete Felder:
 *        id, medication_id, time_of_day ('HH:MM'), days_mask (int|null),
 *        dose_qty, start_date, end_date, active.
 * @param {Object} range
 * @param {string} range.from - Start-Datum (YYYY-MM-DD, inklusiv)
 * @param {string} range.to   - End-Datum (YYYY-MM-DD, inklusiv)
 * @returns {Array<{ scheduleId:number|null, medicationId:number|null, date:string,
 *                   time:string, scheduledAt:string, dose_qty:number|null }>}
 *          scheduledAt ist ein lokaler 'YYYY-MM-DDTHH:MM'-Zeitstempel (kein UTC-Shift).
 */
export function computeDueDoses(schedules, range = {}) {
  const { from, to } = range;
  if (!from || !to || from > to) return [];
  const list = Array.isArray(schedules) ? schedules : [];
  const doses = [];

  let dateKey = from;
  let guard = 0;
  while (dateKey <= to && guard < 1000) {
    const wd = weekdayIndex(dateKey);
    for (const s of list) {
      if (!s) continue;
      if (s.active === 0 || s.active === false) continue;
      if (s.start_date && dateKey < s.start_date) continue;
      if (s.end_date && dateKey > s.end_date) continue;
      if (!daysMaskMatches(s.days_mask, wd)) continue;
      const time = s.time_of_day || '00:00';
      doses.push({
        scheduleId: s.id ?? null,
        medicationId: s.medication_id ?? null,
        date: dateKey,
        time,
        scheduledAt: `${dateKey}T${time}`,
        dose_qty: s.dose_qty ?? null,
      });
    }
    dateKey = addLocalDays(dateKey, 1);
    guard += 1;
  }

  doses.sort((a, b) => {
    if (a.scheduledAt !== b.scheduledAt) return a.scheduledAt < b.scheduledAt ? -1 : 1;
    return (a.scheduleId || 0) - (b.scheduleId || 0);
  });
  return doses;
}

/**
 * Nur die Dosen, die zu einem Zeitpunkt geplant WAREN.
 *
 * Die Basis jeder Adhaerenz-Rechnung: `planned` zaehlt Eintraege aus den
 * Einnahmeplaenen, und eine Bedarfsdosis gehoert zu keinem. Sichtbar wurde das
 * erst mit #700 - vorher fielen Bedarfsdosen schon am Zeitraumfilter der Route
 * heraus, seit dem Fix kommen sie mit. Drei von sieben geplanten Dosen plus acht
 * Kopfschmerztabletten haetten sonst „100 %, 11 von 11" ergeben.
 *
 * Unterschieden wird an `scheduled_at` und NICHT an `schedule_id`: die
 * Plan-Referenz traegt `ON DELETE SET NULL` (Migration 65). Wer einen alten
 * Einnahmeplan loescht, setzt sie damit auf allen historischen Zeilen zurueck -
 * ueber `schedule_id` gerechnet wuerde die Vergangenheit dadurch zu lauter
 * Bedarfsdosen, und Adhaerenz wie Serie fielen rueckwirkend in sich zusammen,
 * ohne dass jemand eine Dosis anders genommen haette. Der Zeitpunkt bleibt.
 *
 * @param {Array<Object>} logs
 * @returns {Array<Object>}
 */
export function scheduledLogs(logs) {
  return (Array.isArray(logs) ? logs : []).filter((l) => l && l.scheduled_at);
}

/**
 * Adherence-Quote: genommene Dosen / geplante Dosen im Zeitraum.
 *
 * @param {Array<Object>} logs - Dosis-Log-Zeilen mit `status`
 *        ('taken'|'skipped'|'pending').
 * @param {number} [planned]   - Anzahl geplanter Dosen (z. B. computeDueDoses().length).
 *        Fehlt der Wert, werden getroffene Entscheidungen (taken+skipped) als Basis genutzt.
 * @returns {{ taken:number, skipped:number, pending:number, planned:number, rate:number|null }}
 *          rate ∈ [0,1] oder null, wenn keine Basis existiert.
 */
export function computeAdherence(logs, planned) {
  const list = Array.isArray(logs) ? logs : [];
  const taken = list.filter((l) => l && l.status === 'taken').length;
  const skipped = list.filter((l) => l && l.status === 'skipped').length;
  const pending = list.filter((l) => l && l.status === 'pending').length;

  const plannedCount = Number.isFinite(planned) && planned >= 0 ? planned : (taken + skipped);
  // Nenner nie kleiner als die Zahl genommener Dosen (schützt vor >100 % bei Ad-hoc-Logs).
  const denom = Math.max(plannedCount, taken);
  const rate = denom > 0 ? taken / denom : null;

  return { taken, skipped, pending, planned: plannedCount, rate };
}

// ---- Bedarfsmedikation (#700) ----

/**
 * Ein gespeicherter Zeitpunkt als echter Moment.
 *
 * In `medication_logs` liegen zwei Schreibweisen nebeneinander: `scheduled_at`
 * ist Wanduhrzeit ohne Zone ('2026-08-16T18:40'), `created_at` und aeltere
 * `taken_at` enden auf 'Z'. Wer beides mit `new Date()` liest, verschiebt die
 * Wanduhrzeit um den eigenen UTC-Abstand - oestlich von Greenwich in die
 * Zukunft, westlich in die Vergangenheit. Beim Countdown waere das kein
 * Schoenheitsfehler, sondern eine falsche Auskunft darueber, wann die naechste
 * Dosis erlaubt ist.
 *
 * @param {string|Date|null} value
 * @returns {Date|null} null bei leerem oder unlesbarem Wert.
 */
export function parseLogInstant(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const raw = String(value ?? '').trim();
  if (!raw) return null;

  const local = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (local) {
    const [, y, mo, d, h, mi, s] = local;
    return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s || 0));
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Ein Zeitpunkt als 'YYYY-MM-DDTHH:MM' in Wanduhrzeit.
 *
 * Das Gegenstueck zu parseLogInstant fuer den Schreibweg: `toISOString()` waere
 * hier falsch, weil die Route den Wert auf Minuten kuerzt und die Zone dabei
 * verliert - die Einnahme stuende dann mit der UTC-Zahl im Protokoll.
 *
 * Damit ist auch gesagt, was der Countdown NICHT kann: Wanduhrzeit gilt in der
 * Zone des Haushalts (`TZ`, siehe server/utils/timezone.js), so wie
 * `scheduled_at`, `due_time` und der ganze Kalender es halten. Wer eine Dosis in
 * Berlin bucht und sie in New York abliest, liest 12:00 als 12:00. Das ist die
 * Konvention des Hauses und keine Nachlaessigkeit dieser Funktion: ein echter
 * Instant nur fuer `taken_at` haette zwei Formate in einer Spalte und einen
 * Countdown, der zwei Zeitrechnungen vergleicht - teurer als der Fall, den er
 * loest, solange ein Haushalt an einem Ort wohnt.
 *
 * @param {Date} [value]
 * @returns {string}
 */
export function toLocalStamp(value = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
    + `T${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

/**
 * Der Bedarfs-Stand eines Medikaments: wann zuletzt genommen, ab wann wieder
 * erlaubt, wie lange es noch dauert.
 *
 * Bewusst aus dem gespeicherten Zeitstempel abgeleitet und nicht aus einer
 * mitlaufenden Uhr: der Wert muss einen Reload und ein zweites Geraet
 * ueberleben. `nextAllowedAt` ist der absolute Zeitpunkt - die Zahl, die man
 * auch Stunden spaeter noch lesen kann; `remainingMs` ist nur die Lesehilfe
 * dazu.
 *
 * @param {Object} med   - Medikament mit min_interval_hours
 * @param {Array<Object>} logs - Dosis-Log-Zeilen dieses Medikaments
 * @param {Date} [now]
 * @returns {{ lastTakenAt: Date|null, nextAllowedAt: Date|null,
 *             remainingMs: number, allowed: boolean, intervalHours: number|null }}
 */
export function prnDoseState(med, logs, now = new Date()) {
  const hours = med && med.min_interval_hours != null && Number.isFinite(Number(med.min_interval_hours))
    ? Number(med.min_interval_hours)
    : null;
  const intervalHours = hours !== null && hours > 0 ? hours : null;

  // Nur genommene Dosen zaehlen. Eine uebersprungene oder noch ausstehende sagt
  // nichts darueber, wann der Koerper zuletzt etwas bekommen hat.
  let lastTakenAt = null;
  for (const entry of (Array.isArray(logs) ? logs : [])) {
    if (!entry || entry.status !== 'taken') continue;
    const at = parseLogInstant(entry.taken_at || entry.scheduled_at || entry.created_at);
    if (!at) continue;
    if (!lastTakenAt || at > lastTakenAt) lastTakenAt = at;
  }

  if (!lastTakenAt || intervalHours === null) {
    return { lastTakenAt, nextAllowedAt: null, remainingMs: 0, allowed: true, intervalHours };
  }

  const nextAllowedAt = new Date(lastTakenAt.getTime() + intervalHours * 3600 * 1000);
  const remainingMs = Math.max(0, nextAllowedAt.getTime() - now.getTime());
  return { lastTakenAt, nextAllowedAt, remainingMs, allowed: remainingMs === 0, intervalHours };
}

/**
 * Eine Restdauer in Stunden und Minuten, aufgerundet auf die volle Minute.
 *
 * Aufgerundet, weil abgerundet die letzten 59 Sekunden als "0 Min." dastuenden
 * und die Anzeige damit eine Dosis freigaebe, die es noch nicht ist.
 *
 * @param {number} ms
 * @returns {{ hours:number, minutes:number }}
 */
export function splitRemaining(ms) {
  const totalMinutes = Math.max(0, Math.ceil(ms / 60000));
  return { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 };
}

/**
 * Bestands-/Refill-Status eines Medikaments.
 *
 * @param {Object} med - Medikament mit stock_qty, refill_threshold.
 * @returns {{ level:'none'|'ok'|'low'|'out', stock:number|null,
 *             threshold:number|null, below:boolean }}
 *          level 'none' = kein Bestand erfasst; 'out' = leer; 'low' = <= Schwelle.
 */
export function refillState(med) {
  const rawStock = med && med.stock_qty != null ? Number(med.stock_qty) : null;
  const threshold = med && med.refill_threshold != null && Number.isFinite(Number(med.refill_threshold))
    ? Number(med.refill_threshold)
    : null;

  if (rawStock === null || !Number.isFinite(rawStock)) {
    return { level: 'none', stock: null, threshold, below: false };
  }
  if (rawStock <= 0) {
    return { level: 'out', stock: rawStock, threshold, below: true };
  }
  if (threshold !== null && rawStock <= threshold) {
    return { level: 'low', stock: rawStock, threshold, below: true };
  }
  return { level: 'ok', stock: rawStock, threshold, below: false };
}

// --------------------------------------------------------
// Wiederholbare Dosis-Buchung (#2069)
// --------------------------------------------------------

/**
 * Zufaelliger Idempotency-Key, 128 Bit hex.
 *
 * `crypto.getRandomValues` statt `crypto.randomUUID`: randomUUID gibt es nur
 * im sicheren Kontext, und Yuvomi laeuft im Heimnetz oft ueber plain HTTP.
 */
export function randomIdempotencyKey() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Weiss der Aufrufer nach diesem Fehler nicht, ob der Server gebucht hat?
 * Netzfehler (Status 0), Zeitueberschreitung, Bremse und Serverfehler: die
 * Anfrage kann angekommen sein, nur die Antwort fehlt. Jede andere Absage ist
 * eindeutig - gebucht wurde nichts, und ein neuer Versuch ist ein neuer Vorgang.
 * @param {{ status?: number }} err
 */
export function doseOutcomeUnknown(err) {
  const status = err?.status;
  // 409 "noch in Arbeit": die erste Anfrage mit diesem Schluessel laeuft noch,
  // gebucht ist vielleicht schon. Jede andere 409 ist eindeutig.
  if (status === 409) return err?.data?.reason === 'idempotency_in_progress';
  return status === 0 || status === 408 || status === 429 || (typeof status === 'number' && status >= 500);
}

/** So lange gilt ein Tipp nach offenem Ausgang als Wiederholung derselben Dosis. */
export const DOSE_RETRY_WINDOW_MS = 2 * 60 * 1000;

/**
 * Gedaechtnis fuer Dosis-Buchungen, deren Ausgang offen ist.
 *
 * Geht die Antwort auf `POST .../logs` verloren, ist die Dosis vielleicht
 * gebucht und der Bestand vielleicht abgezogen. Der naechste Tipp auf dieselbe
 * Dosis schickt deshalb DENSELBEN Schluessel und DENSELBEN Rumpf (die
 * Idempotenz-Middleware vergleicht den Rumpf; ein neues `taken_at` waere ein
 * Konflikt): kam der erste Versuch an, antwortet der Server mit dessen Antwort,
 * statt ein zweites Mal zu buchen. Nach Erfolg oder eindeutiger Absage ist der
 * Vorgang vorbei, und der naechste Tipp ist eine neue Dosis.
 *
 * NUR FUER DEN UNMITTELBAREN WIEDERHOLVERSUCH. Eine Bedarfsdosis hat kein
 * Vorkommen, das sie von der naechsten unterscheidet - ihr Schluessel ist nur
 * das Medikament. Bliebe ein offener Versuch liegen, schickte eine SPAETERE,
 * gewollte zweite Dosis den alten Schluessel, der Server spielte die alte
 * Antwort zurueck (24 h lang), und die neue Dosis fehlte still. Deshalb endet
 * ein offener Versuch auf zwei Wegen:
 *   - nach DOSE_RETRY_WINDOW_MS: wer spaeter tippt, meint eine neue Dosis;
 *   - mit dem ersten Laden der Dosis-Daten, das NACH dem Fehlschlag begann
 *     (`confirmedBy`): ab dann zeigt die Seite den echten Stand - gebucht oder
 *     nicht -, und ein weiterer Tipp ist eine bewusste neue Aktion. Ein Laden,
 *     das schon vorher lief, kann den Stand vor der Buchung zeigen und zaehlt
 *     nicht.
 * Ein Versuch, dessen Anfrage noch laeuft, bleibt in beiden Faellen stehen.
 *
 * @param {{ newKey?: () => string, now?: () => number, retryWindowMs?: number }} [options]
 */
export function createDoseAttempts({
  newKey = randomIdempotencyKey, now = () => Date.now(), retryWindowMs = DOSE_RETRY_WINDOW_MS,
} = {}) {
  const pending = new Map();
  const expired = (entry) => entry.failedAt !== null && now() - entry.failedAt > retryWindowMs;
  return {
    /** Schluessel und Rumpf fuer diese Aktion - beim Wiederholversuch die alten. */
    attempt(actionKey, buildBody, medId = null) {
      let entry = pending.get(actionKey);
      if (!entry || expired(entry)) {
        entry = { key: newKey(), body: buildBody(), failedAt: null, medId };
        pending.set(actionKey, entry);
      }
      entry.failedAt = null; // laeuft wieder
      return entry;
    },
    /** Nach der Antwort: vergessen, ausser der Ausgang ist offen. */
    settle(actionKey, err = null) {
      const entry = pending.get(actionKey);
      if (!entry) return;
      if (!err || !doseOutcomeUnknown(err)) pending.delete(actionKey);
      else entry.failedAt = now();
    },
    /**
     * Ein Laden der Dosis-Daten ist durch, das zum Zeitpunkt `startedAt` begann
     * und die Medikamente `medIds` zeigt: jeder offene Versuch fuer eines davon,
     * der davor scheiterte, ist damit geklaert. Die Ansicht einer anderen Person
     * klaert nichts an diesen Medikamenten.
     */
    confirmedBy(startedAt, medIds) {
      const shown = new Set(medIds);
      for (const [actionKey, entry] of pending) {
        if (entry.failedAt !== null && entry.failedAt <= startedAt && shown.has(entry.medId)) pending.delete(actionKey);
      }
    },
    has: (actionKey) => {
      const entry = pending.get(actionKey);
      return Boolean(entry) && !expired(entry);
    },
  };
}
