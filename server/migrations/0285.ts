// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 285,
    description: 'contacts: a synced photo stored without its data-URL prefix gets one (#2128)',
    // Bis #2128 schrieb der CardDAV-Sync die nackten Base64-Zeichen in
    // `contacts.photo` (`vcard.photo = value`). Jedes Foto, das vorher
    // synchronisiert wurde, liegt also OHNE `data:`-Praefix da - und
    // `maybeUpdate()` schreibt eine belegte Spalte nie neu, die Zeilen heilen
    // sich beim naechsten Sync also auch nicht. Ohne diesen Nachtrag beantwortet
    // `GET /contacts/:id/photo` jedes Bestandsfoto mit einer Absage.
    //
    // DER TYP WIRD ERKANNT, NICHT GERATEN. Der alte Sync nahm pauschal
    // `image/jpeg` an (`TYPE=` fehlt in den meisten vCards); ein PNG mit diesem
    // Etikett ist genau der Fall, den die Inhaltspruefung danach abweist. Hier
    // entscheidet die Signatur der ersten Bytes.
    //
    // Eine Zeile, deren Bytes zu keinem bekannten Bildtyp passen, bleibt
    // UNANGETASTET: sie zu loeschen waere ein Datenverlust auf einen Verdacht
    // hin, und der Leser der Route kommt mit ihr zurecht (422 statt 500).
    up(database) {
      const cols = database.prepare('PRAGMA table_info(contacts)').all();
      if (!cols.some((c) => c.name === 'photo')) return;

      // Nur die ohne Praefix; `LIKE 'data:%'` ist bereits normalisiert.
      const rows = database.prepare(
        "SELECT id, photo FROM contacts WHERE photo IS NOT NULL AND photo <> '' AND photo NOT LIKE 'data:%'",
      ).all();
      if (!rows.length) return;

      // Dieselbe Reihenfolge und dieselben Signaturen wie
      // PHOTO_MIMES/decodeStoredPhoto in routes/contacts.js.
      const SIGS = [
        ['image/jpeg', (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
        ['image/png', (b) => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
          && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a],
        ['image/webp', (b) => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP'],
        ['image/gif', (b) => b.length >= 6 && ['GIF87a', 'GIF89a'].includes(b.toString('ascii', 0, 6))],
      ];

      const update = database.prepare('UPDATE contacts SET photo = ? WHERE id = ?');
      for (const row of rows) {
        const raw = String(row.photo).replace(/\s/g, '');
        if (!/^[A-Za-z0-9+/=]+$/.test(raw)) continue;
        let buffer;
        try { buffer = Buffer.from(raw, 'base64'); } catch { continue; }
        if (!buffer.length) continue;
        const hit = SIGS.find(([, test]) => test(buffer));
        if (!hit) continue;
        update.run(`data:${hit[0]};base64,${raw}`, row.id);
      }
    },
  };
