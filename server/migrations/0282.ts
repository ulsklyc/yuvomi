// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 282,
    description: 'rewards: late completion decay audit fields',
    // Spaeterledigung mit Punkteabzug (Haushalt opt-in): ist
    // `tasks_late_decay_enabled` auf '1', verbucht awardForCompletion() pro
    // Ueberfaelligkeitstag einen Punkt weniger, mindestens bleibt 1 - eine
    // Erledigung lohnt immer. Die Ledger-Zeile haelt fest, was die Rechnung
    // war: `decay_days` (Tage ueber der Faelligkeit) und `base_points`
    // (Punktwert vor dem Abzug), damit die Oberflaeche Grundwert und Abzug
    // zeigen kann und die Buchung auch bei spaeterer Aenderung von Faelligkeit
    // oder Punktwert erklaerbar bleibt. Ohne Abzug bleiben beide NULL.
    up(database) {
      const cols = database.prepare('PRAGMA table_info(reward_ledger)').all();
      if (!cols.some((c) => c.name === 'decay_days')) {
        database.exec('ALTER TABLE reward_ledger ADD COLUMN decay_days INTEGER');
      }
      if (!cols.some((c) => c.name === 'base_points')) {
        database.exec('ALTER TABLE reward_ledger ADD COLUMN base_points INTEGER');
      }
    },
  };
