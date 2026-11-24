// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 161,
    description: 'Task completions: erledigen wird ein Ereignis, nicht nur ein Zustand (#791)',
    up: `
      -- WARUM EINE TABELLE UND NICHT ZWEI SPALTEN. Eine Aufgabe traegt heute
      -- 'done' - und 'done' ist ein Zustand, kein Ereignis. Es beantwortet
      -- "steht das noch an", aber keine der vier Fragen aus #791: was habe ich
      -- heute erledigt, was gestern, wann war eine wiederkehrende Sache zuletzt
      -- dran, und wer hat sie gemacht.
      --
      -- Zwei Spalten (completed_at, completed_by) am Datensatz waeren die
      -- billigere Antwort und die falsche: eine wiederkehrende Aufgabe legt
      -- beim Abhaken eine Folgeinstanz an (recurrence_origin_id), und die
      -- Historie einer Serie verteilt sich damit ueber eine Kette von Zeilen,
      -- deren Glieder einzeln geloescht werden koennen. Genau die Frage "wann
      -- war das zuletzt dran" haengt an dieser Kette.
      --
      -- WAS HIER NICHT STEHT: kein Titel, keine Kategorie, kein Name. Ein
      -- Schnappschuss waere eine zweite Wahrheit neben der Aufgabe - und die
      -- gefaehrliche davon, weil auch die SICHTBARKEIT eine ist. Wer eine
      -- Aufgabe nachtraeglich auf privat stellt, hat sie versteckt; ein
      -- Verlaufseintrag, der seine eigene Kopie der alten Stufe mitbringt,
      -- verriete sie weiter. Der Lesepfad joint deshalb immer die Aufgabe und
      -- haengt dasselbe visibilityWhere an wie jede andere Aufgabenliste.
      --
      -- DER PREIS, bewusst bezahlt: ON DELETE CASCADE. Wer eine Aufgabe
      -- loescht, loescht ihre Erledigungen mit. Das ist die Kehrseite der einen
      -- Wahrheit, und sie ist die richtige Seite - eine Zeile, die ueberlebt,
      -- was sie beschreibt, muesste ihre eigene Antwort auf "wer darf das
      -- sehen" mitbringen.
      CREATE TABLE IF NOT EXISTS task_completions (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id      INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,

        -- Die Wurzel der Wiederholungskette, sonst die Aufgabe selbst. Einmal
        -- beim Schreiben ermittelt statt bei jedem Lesen: der Wert ist ab dann
        -- stabil, auch wenn spaeter ein Glied der Kette wegfaellt und die
        -- rekursive Suche eine andere Wurzel faende. Kein Fremdschluessel - die
        -- Wurzel darf verschwinden, ohne die spaeteren Eintraege mitzureissen.
        series_id    INTEGER NOT NULL,

        -- WER ABGEHAKT HAT, nicht wer zustaendig war. Der reward_ledger
        -- entscheidet das bewusst anders (rewardTargets: die Zustaendigen, sonst
        -- die handelnde Person), weil Punkte ein Verdienst sind und sich teilen
        -- lassen. Eine Erledigung ist ein Vorgang: sie passiert einmal, und sie
        -- passiert durch genau einen Klick. SET NULL statt CASCADE, damit das
        -- Ausscheiden eines Mitglieds nicht den Verlauf des Haushalts loescht.
        user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,

        completed_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      -- Eine Aufgabe ist einmal erledigt. Das Zuruecknehmen loescht die Zeile,
      -- statt eine Gegenbuchung zu schreiben - dasselbe Muster wie
      -- reverseTaskEarnings, und aus demselben Grund: ein Haken, der dreimal
      -- hin und her geht, ist kein Verlauf, sondern Rauschen. Der Index ist
      -- zugleich das Idempotenz-Netz, falls derselbe Statuswechsel zweimal
      -- ankommt.
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_task_completion ON task_completions(task_id);

      -- Der Verlauf liest absteigend nach Zeit; die Serienansicht liest eine
      -- Serie, ebenfalls nach Zeit. Zwei Lesepfade, zwei Indizes.
      CREATE INDEX IF NOT EXISTS idx_task_completions_at     ON task_completions(completed_at);
      CREATE INDEX IF NOT EXISTS idx_task_completions_series ON task_completions(series_id, completed_at);
    `,
  };
