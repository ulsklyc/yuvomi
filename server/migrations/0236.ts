export default {
    version: 236,
    description: 'Rewards: pocket money - a unit per ledger row, money requests and a credit plan (#1734)',
    // TASCHENGELD LEBT AUF DEM LEDGER DER BELOHNUNGEN, NICHT IM BUDGET (#1734,
    // Discussion #916). Ein Budgetkonto hat keinen Besitzer, Budget kennt kein
    // "dieses Kind und die Eltern, nicht die Geschwister" und keine Anfrage,
    // die einer stellt und ein anderer entscheidet. Ledger, Anfrage, Freigabe
    // und Gegenbuchung gibt es hier schon (docs/DECISIONS.md, Eintrag 6).
    //
    // `reward_ledger.unit` SAGT, WAS DIE ZAHL ZAEHLT. Bis hierher war jede
    // Zeile ein Punkt. Der Default 'points' ist der Bestand, ohne Backfill -
    // und ADD COLUMN baut die Tabelle nicht neu: die fuenf Indizes
    // (idx_reward_ledger_user, _redemption, _task, _series, _reverses)
    // bleiben, und `uniq_reward_earn` kommt nicht zurueck (Migration 230).
    // Geld steht in ganzen kleinsten Einheiten (Cent) MIT SEINEM WAEHRUNGSCODE,
    // wie `amount_minor` und `currency` der geteilten Ausgaben.
    //
    // `reward_money_accounts` IST DAS KONTO: eine Zeile je Person, und sie
    // traegt die WAEHRUNG - die Haushaltswaehrung des Tages, an dem die Eltern
    // es eroeffnet haben. "Hat ein Konto" ist damit eine Zeile und keine
    // Ableitung aus Plan oder Buchungen, ein Konto kann ohne Plan und ohne
    // Geld bestehen, und "ein Konto hat genau EINE Waehrung" ist eine Spalte.
    // Wechselt der Haushalt seine Waehrung spaeter, bleibt das Konto, wie es
    // ist - 1,00 EUR werden nicht zu 100 Yen. Ein LEERES Konto (kein Plan,
    // Saldo null, nichts offen) laesst sich schliessen; ein neu eroeffnetes
    // nimmt die Waehrung von dann.
    //
    // `currency` STEHT ZUSAETZLICH AN JEDER GELDZEILE, AN JEDER GELD-ANFRAGE
    // UND AM PLAN: eine Zeile sagt selbst, worin ihr Betrag steht, auch
    // nachdem ihr Konto geschlossen und in anderer Waehrung neu eroeffnet
    // wurde. Die CHECKs binden die Spalte an die Einheit: eine Geldzeile ohne
    // Code und eine Punktezeile mit Code lehnt das Schema ab (bei der Anfrage
    // dasselbe ueber `kind`). DASS eine Zeile die Waehrung IHRES Kontos
    // traegt, kann ein CHECK nicht sagen - das prueft die Schreibschicht in
    // der Transaktion jeder Buchung (`postMoney()` in
    // server/services/reward-money.js).
    //
    // KEIN NEUER `type`: der CHECK auf `type` liesse sich nur per Rebuild
    // aendern. Eine Gutschrift nach Plan ist ein `bonus` mit unit 'money',
    // eine Auszahlung ein `redeem`, eine Korrektur der Eltern `bonus`/`adjust`.
    //
    // JEDE SUMME UEBER `delta` BRAUCHT DEN EINHEITEN-FILTER, sonst zaehlen Cent
    // als Punkte. Die Summe steht deshalb an EINER Stelle, die ohne Einheit
    // wirft (`ledgerBalanceSql()` in server/services/rewards.js).
    //
    // `allowance_date` IST DER TERMIN, FUER DEN EINE PLAN-GUTSCHRIFT GILT, und
    // der UNIQUE-Index darueber ist die Idempotenz: je Person und Termin
    // hoechstens eine. Sie steht damit im Schema und nicht nur darin, dass
    // "der Termin in derselben Transaktion weiterrueckt". Der Schluessel ist
    // die PERSON, nicht die Planzeile: ein geloeschter und neu angelegter Plan
    // bucht denselben Tag kein zweites Mal.
    //
    // `reward_redemptions.kind`: 'reward' ist die Einloesung von bisher (und
    // jede Bestandszeile), 'withdrawal' und 'deposit' sind Geld-Anfragen mit
    // freiem Betrag in `cost` (kleinste Einheiten) und ohne Katalogeintrag.
    // EINE Spalte statt `unit` plus Richtung: so gibt es keine Einzahlung in
    // Punkten, die ein zweites Feld erst ausschliessen muesste.
    //
    // `reward_allowances` ist der Plan, eine Zeile je Person, in der Form von
    // `recurring_expenses` (Betrag, Rhythmus, `anchor_day`, `next_run_date`,
    // `paused_at`), damit der Schritt durch dieselbe Rechnung geht
    // (`addInterval()` in server/utils/interval-date.js). `anchor_day` ist
    // monatlich der Tag im Monat (1 bis 31, kuerzere Monate klemmen aufs
    // Monatsende und heben danach wieder an), woechentlich der Wochentag
    // (1 = Montag bis 7 = Sonntag).
    //
    // Ein kuenftiger Rebuild von reward_ledger oder reward_redemptions muss
    // `unit`, `allowance_date`, `currency`, `kind` und den Index mitnehmen.
    up: `
      ALTER TABLE reward_ledger ADD COLUMN unit TEXT NOT NULL DEFAULT 'points'
        CHECK(unit IN ('points', 'money'));
      ALTER TABLE reward_ledger ADD COLUMN allowance_date TEXT;
      ALTER TABLE reward_ledger ADD COLUMN currency TEXT
        CHECK((unit = 'money') = (currency IS NOT NULL));
      CREATE UNIQUE INDEX uniq_reward_allowance_credit
        ON reward_ledger(user_id, allowance_date) WHERE allowance_date IS NOT NULL;

      ALTER TABLE reward_redemptions ADD COLUMN kind TEXT NOT NULL DEFAULT 'reward'
        CHECK(kind IN ('reward', 'withdrawal', 'deposit'));
      ALTER TABLE reward_redemptions ADD COLUMN currency TEXT
        CHECK((kind = 'reward') = (currency IS NULL));

      CREATE TABLE reward_money_accounts (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        currency   TEXT    NOT NULL,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      CREATE TABLE reward_allowances (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id       INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        amount_minor  INTEGER NOT NULL CHECK(amount_minor > 0),
        currency      TEXT    NOT NULL,
        frequency     TEXT    NOT NULL CHECK(frequency IN ('weekly', 'monthly')),
        anchor_day    INTEGER NOT NULL CHECK(anchor_day BETWEEN 1 AND 31),
        next_run_date TEXT    NOT NULL,
        paused_at     TEXT,
        created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );
      CREATE INDEX idx_reward_allowances_next_run ON reward_allowances(next_run_date, paused_at);
    `,
  };
