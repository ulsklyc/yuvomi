// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 145,
    description: 'ship the Inventory module disabled by default (households opt in)',
    up(db) {
      // Erstes Modul, das abgeschaltet ausgeliefert wird. Grund ist nicht die
      // Qualitaet, sondern die Reichweite: jedes Modul ist ein dauerhafter
      // Eintrag in der Navigation *jedes* Haushalts, auch derer, die nie ein
      // Fahrrad erfassen werden (Diskussion #696). Wer es will, schaltet es
      // einmal ein; wer nicht, sieht es nie. Sollte sich zeigen, dass die
      // Haelfte es nutzt, ist der Default eine Zeile weit zurueckdrehbar.
      //
      // Kein separater Seed-Pfad noetig: migrate() faehrt auf einer frischen
      // Datenbank die komplette MIGRATIONS-Liste, dieser Eintrag deckt also
      // Neuinstallation und Bestandshaushalt gleichermassen ab.
      const row = db.prepare("SELECT value FROM sync_config WHERE key = 'disabled_modules'").get();

      // Defensiv genau wie parseDisabledModules (server/routes/preferences.js):
      // fehlend, kein Array oder kaputtes JSON zaehlen als "nichts abgeschaltet".
      let disabled = [];
      if (row?.value) {
        try {
          const parsed = JSON.parse(row.value);
          if (Array.isArray(parsed)) disabled = parsed.filter((m) => typeof m === 'string');
        } catch { /* kaputter Wert wird ersetzt, nicht respektiert */ }
      }

      // Mergen statt ersetzen: ein Haushalt kann bereits Module abgeschaltet
      // haben, die ihm ein blindes INSERT OR REPLACE stillschweigend
      // wieder einschalten wuerde.
      if (disabled.includes('inventory')) return;
      disabled.push('inventory');

      db.prepare(`
        INSERT INTO sync_config (key, value) VALUES ('disabled_modules', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      `).run(JSON.stringify(disabled));
    },
  };
