// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 258,
    description: 'health: existing child accounts start without the cycle tab (#2148)',
    // BESTEHENDE KINDERKONTEN BEKOMMEN DIE ZYKLUS-VORGABE NACHGEZOGEN (#2148,
    // Ulas 2026-10-22). Seit R21 schreibt `applyChildStartPermissions()` fuer
    // ein NEUES Kind `health_cycle_enabled:user:<id>` = '0' in `sync_config`;
    // Kinder von vor v2.79.0 sahen "Zyklus" weiter, obwohl die Gesundheit
    // sagt, er sei Erwachsenensache.
    //
    // NUR WO NICHTS STEHT. Die persoenliche Zeile entsteht ausschliesslich
    // durch eine Wahl (PUT /preferences `health_cycle_enabled_user` schreibt
    // '1' oder '0', geloescht wird sie nur mit dem Konto). Keine Zeile heisst
    // also eindeutig "nie gewaehlt"; jede Zeile bleibt, auch eine '1'.
    // `ON CONFLICT DO NOTHING` macht den zweiten Lauf wirkungslos.
    //
    // WER DEN ZYKLUS SCHON BENUTZT, BEHAELT IHN (Ulas 2026-10-22). Ein Kind mit
    // eigener Zeile in `cycle_periods`, `cycle_day_logs` oder `cycle_settings`
    // (geschrieben nur durch Eintragen, Import oder Speichern der Einstellungen,
    // nie durch blosses Oeffnen) hat den Tab gewaehlt, auch ohne den Schalter
    // anzufassen. Symptome, Gefuehle und Erinnerungsanker haengen an diesen
    // Zeilen oder werden aus ihnen abgeleitet.
    //
    // DAS FASTEN BLEIBT AUSSEN VOR. Fuer `health_use_fasting` ist "nie
    // geaendert" nicht erkennbar: "Erben" im Rechte-Blatt und "Alle
    // zuruecksetzen" loeschen die Mitglied-Zeile, und ein ausdrueckliches
    // `allow` im Rollenprofil wird nie gespeichert (sparse). Keine Zeile kann
    // damit auch eine Elternwahl FUER das Fasten sein.
    //
    // EINGEFROREN wie Migration 250: die Auswahl steht hier als Text (kein
    // Admin, Familienrolle `child`), nicht als Aufruf der Laufzeitregel.
    up(database) {
      database.prepare(`
        INSERT INTO sync_config (key, value)
        SELECT 'health_cycle_enabled:user:' || u.id, '0' FROM users u
        WHERE u.family_role = 'child' AND u.role != 'admin'
          AND NOT EXISTS (SELECT 1 FROM cycle_periods cp WHERE cp.user_id = u.id)
          AND NOT EXISTS (SELECT 1 FROM cycle_day_logs cl WHERE cl.user_id = u.id)
          AND NOT EXISTS (SELECT 1 FROM cycle_settings cs WHERE cs.user_id = u.id)
        ON CONFLICT(key) DO NOTHING
      `).run();
    },
  };
