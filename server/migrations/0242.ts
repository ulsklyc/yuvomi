// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 242,
    description: 'Tasks: manual order within a category (tasks.sort_order)',
    // NULL = nie von Hand eingeordnet. Solche Aufgaben behalten die bisherige
    // Reihenfolge (Faelligkeit, dann Prioritaet) und stehen HINTER den von Hand
    // eingeordneten: eine neue Aufgabe landet damit am Ende ihrer Kategorie,
    // statt eine bestehende Handordnung zu verschieben. Kein Backfill - bis zum
    // ersten Zug aendert sich nichts an der Anzeige.
    //
    // Der Rang gilt in der Kategorie, in der er vergeben wurde: wechselt eine
    // Aufgabe die Kategorie, setzt PUT /tasks/:id ihn auf NULL zurueck, und sie
    // steht dort, wo jede neue Aufgabe steht. Die Folgeinstanz einer
    // Wiederholung erbt den Rang ihrer Vorgaengerin. Gelesen wird er nur beim
    // Gruppieren nach Kategorie.
    up(db) {
      const has = (table, column) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
      if (!has('tasks', 'sort_order')) db.exec('ALTER TABLE tasks ADD COLUMN sort_order INTEGER');
    },
  };
