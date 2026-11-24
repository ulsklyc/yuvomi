// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 170,
    description: 'Subscriptions: seed categories and payment methods carry a label key, so they speak the reader language (#950)',
    // GEMELDET WAR EINE HALBE UEBERSETZUNG. Im Feld "Kategorien und
    // Zahlungsarten verwalten" standen die Kategorien auf Spanisch und die
    // Zahlungsarten daneben auf Englisch - dieselbe Liste, zwei Sprachen.
    //
    // Der Grund: BEIDE Tabellen speichern ihre sieben bzw. sechs Vorgaben als
    // englischen TEXT ('Credit Card', 'Entertainment'). Die Kategorien hatten
    // im Frontend eine Karte, die diesen Text auf einen i18n-Schluessel abbog;
    // die Zahlungsarten hatten keine. Es war also nie eine zweite Uebersetzung
    // noetig, sondern die erste an der falschen Stelle: eine Karte im Frontend
    // kann nur raten, ob 'Other' die Vorgabe oder eine selbst angelegte Zeile
    // desselben Namens meint.
    //
    // DIE ANTWORT STEHT IM PROJEKT SCHON VIERMAL: task_categories,
    // contact_categories, inventory_categories und die Dokumentordner tragen
    // ihren uebersetzten Namen als `label_key` und ihren freien Namen als
    // `name`. Gelesen wird `label_key ? t(label_key) : name`. Damit ist die
    // Frage "Vorgabe oder eigene Zeile" eine Eigenschaft der ZEILE, keine
    // Namensuebereinstimmung - und Umbenennen loescht den Schluessel, womit
    // der eigene Name gilt (so machen es die drei Routen oben auch).
    //
    // SCHLUESSEL UND NAME MUESSEN ZUSAMMENGEHOEREN, nicht bloss je einzeln
    // vorkommen. Der Name allein reicht nicht: wer eine Vorgabe geloescht und
    // danach eine EIGENE Kategorie 'Entertainment' angelegt hat, bekaeme sonst
    // einen Schluessel aufgedrueckt, und sein gewaehlter Name waere still durch
    // Uebersetzungen ersetzt. `budget_subcategory_key` ist der Anker dafuer -
    // Migration 145 hat den Vorgaben feste Schluessel gegeben
    // ('subscription_entertainment'), waehrend jede spaeter angelegte Zeile
    // 'subscription_category_<id>' traegt.
    //
    // Der Schluessel ALLEIN reicht auch nicht: er bleibt an der Zeile, wenn
    // jemand 'Entertainment' in 'Filme' umbenennt - dann waere ihr Name genauso
    // weg.
    //
    // UND ZWEI GETRENNTE IN-LISTEN REICHEN EBENFALLS NICHT: wer 'Other'
    // loescht und 'Entertainment' in 'Other' umbenennt, erfuellt beide Listen
    // und bekaeme die Beschriftung seines ALTEN Schluessels - die Zeile hiesse
    // fortan "Unterhaltung", obwohl er "Other" geschrieben hat. Beide Befunde
    // kamen aus der PR-Durchsicht, der zweite erst, nachdem der erste behoben
    // war. Deshalb steht hier je ein UPDATE pro Vorgabe: die Paarung ist damit
    // nicht zu uebersehen und nicht versehentlich aufzutrennen.
    //
    // BEI DEN ZAHLUNGSARTEN GIBT ES KEINEN SOLCHEN ANKER, und der Name traegt
    // dort auch allein: die sechs uebrigen Bezeichnungen sind Marken oder
    // feste Begriffe, deren Uebersetzung dasselbe meint ('PayPal' bleibt
    // 'PayPal', 'Credit Card' wird 'Kreditkarte'). Wer 'Credit Card' laengst
    // umbenannt hat, wird nicht getroffen und behaelt seinen Namen - das ist
    // der gewuenschte Ausgang, nicht der verpasste. Eine Annahme ueber die
    // vergebenen id-Werte waere der scheinbar schaerfere, in Wahrheit
    // fragilere Anker: sie steht nirgends im Schema.
    up: `
      ALTER TABLE subscription_categories     ADD COLUMN label_key TEXT;
      ALTER TABLE subscription_payment_methods ADD COLUMN label_key TEXT;

      UPDATE subscription_categories SET label_key = 'budget.subcatSubscriptionEntertainment'
        WHERE budget_subcategory_key = 'subscription_entertainment' AND name = 'Entertainment';
      UPDATE subscription_categories SET label_key = 'budget.subcatSubscriptionProductivity'
        WHERE budget_subcategory_key = 'subscription_productivity'  AND name = 'Productivity';
      UPDATE subscription_categories SET label_key = 'budget.subcatSubscriptionUtilities'
        WHERE budget_subcategory_key = 'subscription_utilities'     AND name = 'Utilities';
      UPDATE subscription_categories SET label_key = 'budget.subcatSubscriptionHealth'
        WHERE budget_subcategory_key = 'subscription_health'        AND name = 'Health';
      UPDATE subscription_categories SET label_key = 'budget.subcatSubscriptionEducation'
        WHERE budget_subcategory_key = 'subscription_education'     AND name = 'Education';
      UPDATE subscription_categories SET label_key = 'budget.subcatSubscriptionOther'
        WHERE budget_subcategory_key = 'subscription_other'         AND name = 'Other';

      UPDATE subscription_payment_methods SET label_key = CASE name
        WHEN 'Credit Card'   THEN 'subscriptions.paymentMethodCreditCard'
        WHEN 'Debit Card'    THEN 'subscriptions.paymentMethodDebitCard'
        WHEN 'PayPal'        THEN 'subscriptions.paymentMethodPaypal'
        WHEN 'Apple Pay'     THEN 'subscriptions.paymentMethodApplePay'
        WHEN 'Google Pay'    THEN 'subscriptions.paymentMethodGooglePay'
        WHEN 'Bank Transfer' THEN 'subscriptions.paymentMethodBankTransfer'
        WHEN 'Other'         THEN 'subscriptions.paymentMethodOther'
      END
      WHERE name IN ('Credit Card', 'Debit Card', 'PayPal', 'Apple Pay', 'Google Pay', 'Bank Transfer', 'Other');
    `,
  };
