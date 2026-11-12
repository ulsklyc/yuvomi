/**
 * Die Faelligkeit einer Aufgabe ausserhalb des Formulars entfernen.
 *
 * EINE AKTION FUER ALLES, WAS AN DER FAELLIGKEIT HAENGT. Wer eine Aufgabe
 * „ohne Datum" haben wollte, musste im Formular das Datum leeren, die Uhrzeit
 * leeren und die Erinnerung abschalten - drei Felder an zwei Enden des Dialogs,
 * und wer die Erinnerung vergass, bekam die Meldung ganz unten, unter der Falz.
 * Hier ist das ein Aufruf: Datum und Uhrzeit gehen zusammen, der Countdown
 * (ohne Faelligkeit zaehlt er auf nichts, `wireCountdownGate`) geht mit.
 *
 * DIE ERINNERUNGEN RAEUMT DER SERVER (#2705): wird `due_date` leer, loescht
 * der Trigger aus Migration 283 alle Erinnerungen der Aufgabe, die eigenen und
 * die der anderen Mitglieder. „Rueckgaengig" kann nur die EIGENE zurueckholen -
 * die fremden hat dieser Nutzer nie gesehen (`server/routes/reminders.js`
 * filtert nach `created_by`), also kennt er sie nicht. Wie viele es waren, sagt
 * die Antwort (`reminders_removed_others`), damit die Oberflaeche es nennen kann.
 *
 * Kein DOM, kein i18n: der Aufrufer reicht `api` herein, damit die Naht ohne
 * Browser messbar bleibt (test:task-clear-due).
 */

/**
 * Der Koerper fuer PUT /tasks/:id, der die Faelligkeit entfernt. Der Countdown
 * wird nur mitgeschickt, wenn er gesetzt war - nicht mitgeschickt heisst am
 * Server „nicht angefasst" (#647).
 *
 * @param {{countdown?: number|boolean}|null|undefined} task
 * @returns {{due_date: null, due_time: null, countdown?: 0}}
 */
export function dueClearBody(task) {
  return { due_date: null, due_time: null, ...(task?.countdown ? { countdown: 0 } : {}) };
}

/**
 * Die eigenen, gespeicherten Erinnerungszeitpunkte - so, wie die Leseansicht
 * sie bekommt (ein Objekt, eine Liste oder nichts).
 *
 * @param {object|object[]|null|undefined} reminders
 * @returns {string[]}
 */
export function ownRemindAts(reminders) {
  const list = Array.isArray(reminders) ? reminders : (reminders ? [reminders] : []);
  return list
    .map((r) => /** @type {{remind_at?: unknown}|null} */ (r)?.remind_at)
    .filter((at) => typeof at === 'string' && at.length > 0)
    .map((at) => /** @type {string} */ (at));
}

/**
 * Entfernt die Faelligkeit einer Aufgabe; der Server nimmt Countdown-Feld und
 * alle Erinnerungen der Aufgabe im selben Schritt mit.
 *
 * @param {{put: Function}} api
 * @param {{id: number|string, due_date?: string|null, due_time?: string|null, countdown?: number|boolean}} task
 * @param {object|object[]|null} reminders  die eigenen Erinnerungen an der Aufgabe
 * @returns {Promise<{ownReminderGone: boolean, othersRemoved: number, restore: () => Promise<void>}>}
 */
export async function clearTaskDue(api, task, reminders) {
  const before = {
    due_date: task.due_date ?? null,
    due_time: task.due_time ?? null,
    countdown: task.countdown ? 1 : 0,
  };
  const remindAts = ownRemindAts(reminders);
  const response = await api.put(`/tasks/${task.id}`, dueClearBody(task));
  const othersRemoved = Math.max(0, Number(response?.data?.reminders_removed_others) || 0);
  const ownReminderGone = remindAts.length > 0 && !!before.due_date;

  return {
    ownReminderGone,
    othersRemoved,
    /**
     * Der Gegenweg fuer „Rueckgaengig": die alte Faelligkeit und, wenn sie mit
     * weg war, die eigene Erinnerung. PUT /reminders ersetzt die Menge in einem
     * Zug, auch wenn es mehr als eine war. Die Erinnerungen der anderen kommen
     * nicht zurueck - der Toast sagt das vorher.
     */
    restore: async () => {
      await api.put(`/tasks/${task.id}`, {
        due_date: before.due_date,
        due_time: before.due_time,
        ...(before.countdown ? { countdown: 1 } : {}),
      });
      if (ownReminderGone) {
        await api.put(`/reminders?entity_type=task&entity_id=${task.id}`, { remind_ats: remindAts });
      }
    },
  };
}
