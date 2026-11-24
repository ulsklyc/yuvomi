export default {
    version: 130,
    description: 'health: caregivers may record for a dependent member (#584)',
    up: `
      -- Fieber messen und Medikamente geben tut im Alltag ein Elternteil, nicht
      -- das Kind selbst. Bis hierher war das unmoeglich: jedes INSERT im
      -- Gesundheitsmodul setzte user_id hart auf den angemeldeten Nutzer, also
      -- konnte jede Person ausschliesslich fuer sich selbst eintragen (#584).
      --
      -- Die Beziehung ist gerichtet und explizit: subject_id ist die betreute
      -- Person, caregiver_id die eintragende. Sie wird NICHT aus family_role
      -- abgeleitet ("dad/mom duerfen fuer alle child"), obwohl die Rollen es
      -- hergaeben. Eine solche Automatik haette bestehenden Installationen beim
      -- Update stillschweigend Mitleser fuer die privaten Gesundheitsdaten jeder
      -- Person mit der Rolle 'child' gegeben - auch fuer den 17-Jaehrigen, der
      -- die Rolle nur traegt, weil sie am besten passte. Wer fuer wen eintragen
      -- darf, entscheidet ein Admin pro Person; ohne Eintrag aendert sich nichts.
      --
      -- Das Recht umfasst Lesen UND Schreiben der Daten der betreuten Person,
      -- auch der als 'private' markierten. Nur schreiben zu duerfen waere
      -- unbrauchbar: der eingetragene Fieberwert verschwaende fuer die
      -- eintragende Person im selben Moment aus der Ansicht.
      CREATE TABLE IF NOT EXISTS health_care_grants (
        subject_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        caregiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        PRIMARY KEY (subject_id, caregiver_id),
        -- Niemand ist sein eigener Betreuer: der Eigentuemer darf ohnehin alles,
        -- und eine solche Zeile waere eine zweite Wahrheit ueber dasselbe Recht.
        CHECK (subject_id <> caregiver_id)
      );

      -- Die haeufigste Abfrage ist "fuer wen darf ich eintragen?" (Sicht des
      -- Betreuers); der Primaerschluessel deckt nur die Gegenrichtung ab.
      CREATE INDEX IF NOT EXISTS idx_health_care_grants_caregiver
        ON health_care_grants(caregiver_id);
    `,
  };
