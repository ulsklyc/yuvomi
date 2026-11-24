// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 221,
    description: 'rewards: per-reward quantity for the household plus a machine-readable rejection reason',
    up: `
      -- STUECKZAHL JE PRAEMIE, FUER DEN GANZEN HAUSHALT (#1310). Der Katalog ist
      -- haushaltsweit und kennt keine Zuordnung Praemie-zu-Kind; ein physischer
      -- Gegenstand stand deshalb JEDEM Kind gleichzeitig offen und liess sich
      -- beliebig oft einloesen. Die Zahl begrenzt die Praemie fuer den Haushalt,
      -- nicht je Mitglied - ein Ziel je Kind waere eine andere Frage.
      --
      -- WARUM KEIN DEFAULT UND DAMIT NULL: jede bestehende Praemie war bisher
      -- unbegrenzt einloesbar und muss das bleiben. NULL ist der einzige Wert,
      -- der "keine Grenze" sagt, ohne eine zu erfinden. Eine Zahl, auch eine
      -- grosse, schluege irgendwann zu, und 0 hiesse "sofort vergriffen" und
      -- naehme jedem Bestandskatalog auf einen Schlag alles weg. ALTER TABLE ADD
      -- COLUMN ohne DEFAULT fuellt die Bestandszeilen mit genau diesem NULL.
      ALTER TABLE reward_catalog ADD COLUMN quantity INTEGER;

      -- WARUM EINE EINLOESUNG ABGELEHNT WURDE - als Code, nicht als Satz. Ist die
      -- letzte Einheit vergeben, wird eine noch offene Anfrage bei der
      -- Entscheidung abgelehnt und ihre Punkte gehen ueber die bestehende
      -- Gegenbuchung zurueck; die Zeile muss danach sagen koennen, warum. Der
      -- Server kennt die Sprache des Lesers nicht, deshalb ein maschinenlesbarer
      -- Schluessel, den die Oberflaeche ueber t() uebersetzt. Bisher gibt es
      -- genau einen: 'out_of_stock'. NULL heisst "von Hand entschieden" und ist
      -- damit auch der richtige Wert fuer jede Bestandszeile.
      ALTER TABLE reward_redemptions ADD COLUMN decision_reason TEXT;
    `,
  };
