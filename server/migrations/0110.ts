// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 110,
    description: 'Google Calendar: force one full resync so series arrive as masters (#593)',
    up: `
      -- Der Google-Abruf stellt von singleEvents:true auf false um: eine Serie
      -- kommt künftig als EIN Master mit ihrer Wiederholungsregel statt als
      -- hunderte Einzelvorkommen, so wie CalDAV und ICS sie liefern und wie
      -- Yuvomi Serien lokal führt.
      --
      -- Der gespeicherte syncToken gehört zu den alten Abrufparametern. Google
      -- beantwortet ihn nach der Umstellung mit 410 GONE, was der Sync zwar
      -- abfängt, aber erst nach einem vergeblichen Request. Ihn hier zu leeren
      -- macht den ersten Lauf deterministisch - und dieser Full-Resync ist es,
      -- der die alten Einzelvorkommen in ihre Serie zurückführt.
      --
      -- Nur der Token wird angefasst, keine Termine: das Zusammenführen passiert
      -- im Sync gegen die echten Google-Daten, nicht per Rateschluss über
      -- ID-Muster. Termine, die dabei lokale Anpassungen tragen, bleiben als
      -- eigenständige Einträge erhalten.
      UPDATE google_calendar_selection SET sync_token = NULL;
    `,
  };
