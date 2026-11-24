export default {
    version: 172,
    description: 'Personal default visibility per health area, so new entries follow a choice instead of a fixed value (#958)',
    // GEMELDET WAR EIN ANDERER WUNSCH: Blutdruck moege standardmaessig
    // `family` sein, weil im Notfall jemand die ueblichen Werte kennen muss.
    // Den ausgelieferten Standard umzudrehen waere die kleine Aenderung
    // gewesen und die falsche: gespeicherte Zeilen tragen ihre Sichtbarkeit
    // selbst, es leckt also nichts rueckwirkend - aber wer gelernt hat, dass
    // Gesundheitswerte privat sind, teilt nach dem Update, ohne etwas getan zu
    // haben. Eine Oeffnung, die niemand ausgeloest hat, ist die eine Sorte
    // Aenderung, die sich nicht zuruecknehmen laesst: der Standard ist in
    // einer Zeile zurueckgedreht, die inzwischen geschriebenen Zeilen nicht.
    //
    // DIE ANTWORT STEHT IM MODUL SCHON: `cycle_settings.default_visibility`
    // (v153) laesst die PERSON entscheiden, was neue Zyklus-Eintraege sind,
    // und `PATCH /cycle/visibility` zieht die bestehenden mit. Der
    // sensibelste Bereich hat den Schalter, die vier anderen haben ihn nicht -
    // das ist die eigentliche Ungereimtheit, nicht der Wert des Standards.
    //
    // JE METRIK UND NICHT JE BEREICH bei den Vitalwerten: wer den Blutdruck
    // teilen will, will damit nicht die Stimmung teilen. Beide stehen in
    // derselben Liste (`VITAL_METRICS`), und eine Voreinstellung fuer
    // "Vitalwerte" haette genau die Vermengung erzeugt, gegen die der
    // ausgelieferte Standard verteidigt wurde. Medikamente, Laborbefunde und
    // Aktivitaeten haben je eine, weil sie je EINE Sorte Eintrag sind.
    //
    // SPARSE wie `access_permissions`: gespeichert wird nur, was vom
    // ausgelieferten `private` abweicht. Eine fehlende Zeile ist damit kein
    // Sonderfall, sondern der Normalfall, und ein Konto ohne jede Zeile
    // verhaelt sich exakt wie vor dieser Migration.
    //
    //   scope_key  'vital:<type>' aus VITAL_METRICS, sonst 'meds' | 'labs'
    //              | 'activities'. Kein CHECK: die Metrikliste waechst, und
    //              eine append-only-Migration darf sie nicht einfrieren -
    //              dieselbe Ueberlegung wie bei `invites.family_role`.
    up: `
      CREATE TABLE IF NOT EXISTS health_visibility_defaults (
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        scope_key  TEXT    NOT NULL,
        visibility TEXT    NOT NULL CHECK(visibility IN ('private', 'family')),
        updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        PRIMARY KEY (user_id, scope_key)
      );
    `,
  };
