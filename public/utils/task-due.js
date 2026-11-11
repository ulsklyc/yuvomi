/**
 * Die Faelligkeit einer Aufgabe ausserhalb des Formulars aendern.
 *
 * EINE AKTION FUER ALLES, WAS AN DER FAELLIGKEIT HAENGT. Wer eine Aufgabe
 * „ohne Datum" haben wollte, musste im Formular das Datum leeren, die Uhrzeit
 * leeren und die Erinnerung abschalten - drei Felder an zwei Enden des Dialogs,
 * und wer die Erinnerung vergass, bekam die Meldung ganz unten, unter der Falz.
 * Hier ist das ein Aufruf: Datum und Uhrzeit gehen zusammen, der Countdown
 * (ohne Faelligkeit zaehlt er auf nichts, `wireCountdownGate`) und die eigene
 * Erinnerung (ohne Datum lehnt das Formular sie ab) gehen mit.
 *
 * NUR DIE EIGENEN ERINNERUNGEN. Erinnerungen gehoeren einer Person
 * (`server/routes/reminders.js` filtert GET, Upsert und DELETE nach
 * `created_by`); die eines anderen Mitglieds kann dieser Aufruf weder sehen noch
 * loeschen - dieselbe Grenze wie beim Speichern des Formulars.
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
  return list.map((r) => r?.remind_at).filter((at) => typeof at === 'string' && at.length > 0);
}

/**
 * Entfernt die Faelligkeit einer Aufgabe samt Countdown und eigener Erinnerung.
 *
 * Reihenfolge: erst die Aufgabe, dann die Erinnerung. Scheitert die Aufgabe,
 * ist nichts passiert (der Fehler geht an den Aufrufer). Scheitert danach das
 * Loeschen der Erinnerung, ist die Faelligkeit trotzdem weg - das Ergebnis sagt
 * es mit `reminderError`, statt den halben Erfolg zu verschweigen.
 *
 * @param {{put: Function, delete: Function}} api
 * @param {{id: number|string, due_date?: string|null, due_time?: string|null, countdown?: number|boolean}} task
 * @param {object|object[]|null} reminders  die eigenen Erinnerungen an der Aufgabe
 * @returns {Promise<{reminderGone: boolean, reminderError: Error|null, restore: () => Promise<void>}>}
 */
export async function clearTaskDue(api, task, reminders) {
  const before = {
    due_date: task.due_date ?? null,
    due_time: task.due_time ?? null,
    countdown: task.countdown ? 1 : 0,
  };
  const remindAts = ownRemindAts(reminders);
  await api.put(`/tasks/${task.id}`, dueClearBody(task));

  let reminderGone = false;
  let reminderError = null;
  if (remindAts.length) {
    try {
      await api.delete(`/reminders?entity_type=task&entity_id=${task.id}`);
      reminderGone = true;
    } catch (err) {
      reminderError = err instanceof Error ? err : new Error(String(err));
    }
  }

  return {
    reminderGone,
    reminderError,
    /**
     * Der Gegenweg fuer „Rueckgaengig": die alte Faelligkeit und, wenn sie mit
     * weg war, die alte Erinnerung. PUT /reminders ersetzt die Menge in einem
     * Zug, auch wenn es mehr als eine war.
     */
    restore: async () => {
      await api.put(`/tasks/${task.id}`, {
        due_date: before.due_date,
        due_time: before.due_time,
        ...(before.countdown ? { countdown: 1 } : {}),
      });
      if (reminderGone) {
        await api.put(`/reminders?entity_type=task&entity_id=${task.id}`, { remind_ats: remindAts });
      }
    },
  };
}
