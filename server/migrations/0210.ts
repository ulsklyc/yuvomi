export default {
    version: 210,
    description: 'Health: cervical mucus, LH/pregnancy test results and intimacy as optional day-log scalars',
    // Vier weitere Skalarwerte je Tag, gleiche Bauart wie Migration 179
    // (basal_temp): ein ALTER TABLE ADD COLUMN KANN durchaus einen
    // spalten-eigenen CHECK tragen (siehe Migration 212, perimenopause_mode/
    // show_pms) - das ist hier nicht der Grund, warum diese vier Werte-Listen
    // stattdessen in der Route leben. Der eigentliche Grund ist Konsistenz mit
    // dem bestehenden Vorbild `basal_temp_unit` (Migration 179): dieselbe Zeile
    // (cycle_day_logs) validiert alle ihre geschlossenen, aber nullbaren
    // Text-Skalare an derselben Stelle, statt manche per CHECK und manche per
    // Route zu pruefen.
    //
    // `intimacy` ist bewusst KEIN sichtbarkeitsgesteuertes Feld wie die
    // anderen drei: die Route liefert es nur an den Eigentuemer selbst zurueck,
    // unabhaengig von `visibility` (siehe cycle.js GET /cycle/logs) - ein
    // Sexualleben-Eintrag soll nicht ueber "family" fuer andere
    // Haushaltsmitglieder mitlesbar werden, nur weil der restliche Tag geteilt
    // ist.
    up: `
      ALTER TABLE cycle_day_logs ADD COLUMN cervix_mucus TEXT;
      ALTER TABLE cycle_day_logs ADD COLUMN lh_test TEXT;
      ALTER TABLE cycle_day_logs ADD COLUMN pregnancy_test TEXT;
      ALTER TABLE cycle_day_logs ADD COLUMN intimacy TEXT;
    `,
  };
