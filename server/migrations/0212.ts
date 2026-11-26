export default {
    version: 212,
    description: 'Health: cycle_settings extensions - contraception, perimenopause mode, PMS toggle, opt-in partner notification',
    up: `
      -- Kein CHECK auf der Spalte: die Werte-Liste lebt in der Route (gleiche
      -- Aufteilung wie basal_temp_unit/flow ueberall sonst in diesem Modul).
      -- Eine Teilmenge dieser Werte (hormonell) schaltet clientseitig die
      -- Eisprung-/Fruchtbarkeitsvorhersage ab (siehe public/utils/health-cycle.js,
      -- suppressesFertility()).
      ALTER TABLE cycle_settings ADD COLUMN contraception TEXT;

      -- Standard 0 (aus): ein Bestandshaushalt sieht ohne aktives Zutun keine
      -- geaenderte Vorhersage-Darstellung.
      ALTER TABLE cycle_settings ADD COLUMN perimenopause_mode INTEGER NOT NULL DEFAULT 0
        CHECK(perimenopause_mode IN (0, 1));

      -- Standard 1 (an): die PMS-Einblendung ist rein abgeleitet (kein
      -- gespeicherter Zeitraum) und rendert ohnehin nur bei einem echten
      -- erkannten Muster - ein Bestandshaushalt sieht also nur dann ueberhaupt
      -- etwas Neues, wenn die eigenen Daten es hergeben.
      ALTER TABLE cycle_settings ADD COLUMN show_pms INTEGER NOT NULL DEFAULT 1
        CHECK(show_pms IN (0, 1));

      -- Opt-in-Benachrichtigung: der Eigentuemer veroeffentlicht, die
      -- Partnerperson braucht keine eigene Freigabe - deshalb genuegt ein
      -- einfacher Verweis ohne Gegenzeichnung. SET NULL statt CASCADE:
      -- verlaesst die verwiesene Person den Haushalt, verliert die
      -- Einstellung nur ihr Ziel, nicht die eigene Zeile.
      ALTER TABLE cycle_settings ADD COLUMN notify_partner_user_id INTEGER
        REFERENCES users(id) ON DELETE SET NULL;
      ALTER TABLE cycle_settings ADD COLUMN notify_partner_days_before INTEGER;
    `,
  };
