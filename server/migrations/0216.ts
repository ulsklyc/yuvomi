// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 216,
    description: 'Display devices remember when their cookie was last re-dated, separate from last seen (#1208)',
    // ZWEI UHREN, WEIL ES ZWEI FRAGEN SIND.
    //
    // `last_seen_at` beantwortet "wann war dieses Tablett zuletzt da" - es ist
    // die Begruendung des Widerruf-Knopfs in den Einstellungen und wird bei
    // JEDEM Request neu gesetzt. Die Frage "muss das Cookie nachdatiert werden"
    // daran zu haengen, war ein Zirkelschluss: der erste Zugriff setzt
    // last_seen_at auf jetzt, damit ist die Frist nie wieder um, und das Cookie
    // wurde nach der ersten Auffrischung nie mehr angefasst - die Jahresfrist
    // lief also doch ab, genau wie vor dem Fix (Codex-Review zu #1241).
    //
    // Deshalb eine eigene Spalte. NULL heisst "noch nie nachdatiert" und faellt
    // damit sofort faellig - richtig fuer jedes Bestandsgeraet, das vor dieser
    // Migration gekoppelt wurde.
    up: `
      ALTER TABLE display_devices ADD COLUMN cookie_refreshed_at TEXT;
    `,
  };
