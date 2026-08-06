# Test-Suiten

Vollständige, annotierte Liste aller `npm run test:*`-Suiten - welche Suite deckt welche Invariante ab.

Testinfrastruktur: In-Memory-SQLite (`--experimental-sqlite`), Node >= 22. Kein laufender Server nötig - Tests importieren die Route-Handler direkt.

Neue Suite - drei Schritte, alle drei Pflicht: (1) `test/test-[module].js` anlegen, (2) `test:[module]`-Skript in `package.json` eintragen, (3) das Skript in die `test`-Kette (`package.json`, Script `test`) einhängen - sonst läuft die Suite weder unter `npm test` noch in CI. Genau so sind fünf Suiten monatelang CI-blind geblieben. Imports von App-Code (`server/`, `public/`, `tools/`) und Root-Dateien via `../`.

```bash
npm test             # Alle Suiten (Node >=22)
npm run test:db
npm run test:rename-migration   # Oikos→Yuvomi Identifier-Migration: seamless rename invariants
npm run test:schema-reconcile   # Schema-Selbstheilung gegen Migrations-Drift (#538): reconcileCriticalSchema ergänzt fehlende Spalten, obwohl die Migration als angewendet vermerkt ist
npm run test:db-encryption      # DB_ENCRYPTION_KEY wirkt wirklich: Datei-Header verschlüsselt, Bestands-DB wird migriert, falscher Key bricht den Start ab
npm run test:db-isolation       # Test-Isolation: keine Suite lädt server/db.js ohne wirksames DB_PATH (init() beim Import würde sonst eine echte yuvomi.db im Repo-Root anlegen); prüft auch die Reihenfolge, da eine Zuweisung nach einem statischen Import zu spät kommt
npm run test:tasks
npm run test:tasks-recurrence   # recurring task catch-up: nextOccurrenceAfter + Folgeinstanz über BEIDE Wege (PATCH status und PUT /:id, #650), Rücknahme, Vorlauf start_date→due_date; Atomarität via Trigger (scheitert der Spawn, bleibt die Aufgabe offen); Anker ab Erledigungstag (#658): nextDueAfterCompletion, Vererbung des Ankers auf die Folgeinstanz, POST/PUT-Rundreise (TZ=UTC festgenagelt, sonst wackelt "heute")
npm run test:tasks-routes       # Tasks-Routen-Schicht: PUT/:id, meta/options, Kategorie-CRUD (404/400/409), Filter (Mehrfachwerte je Achse ODER-verknüpft, #671), Verschachtelung, PATCH-Status, DELETE
npm run test:task-default-points # Standard-Punkte (#578): Preference admin-only + Validierung, Prefill nur ohne expliziten Wert und nur für Hauptaufgaben, Rebase fasst nur offene Hauptaufgaben an (erledigte Punkte sind im Ledger gebucht)
npm run test:task-categories    # Aufgaben-Kategorien (#494/#357): Migration (Seed, Sonstiges→misc, Orphan-Adoption) + CRUD-Guards
npm run test:visibility         # Sichtbarkeit (#474): all|assignees|private Durchsetzung (Tasks+Termine), kein Admin-Bypass, normalizeVisibility
npm run test:sync-default-assignee   # Standard-Zuweisung pro Sync-Ziel (#459): assignDefaultToEvent (neu-only, idempotent, No-op bei verwaister Person)
npm run test:rewards            # Belohnungen: Punkte-Vergabe/Storno/Idempotenz, Katalog, Einlösen mit Freigabe, Bonus, Ledger
npm run test:rewards-routes     # Belohnungs-Routen: requireAdmin-Gates, Redemption-Autorisierung (Nicht-Admin nur für sich/Admin stellvertretend), Eltern-Freigabe pending vs. autoFulfill, 409-Idempotenz, Punkte-Reservierung/Rückbuchung
npm run test:health-overview    # Gesundheit: Übersichts-Tab
npm run test:health-vitals      # Gesundheit: Vitalwerte-Tab - Zeitraum-Bucketing/Aggregation plus das Anzeigeformat je Metrik (Paar/Dauer/Skala), Schlaf-Umrechnung Stunden↔Dezimalstunden und die Stufen-Klemmung der Stimmungsskala
npm run test:health-meds        # Gesundheit: Medikamente-Tab
npm run test:health-labs        # Gesundheit: Laborwerte-Tab
npm run test:health-activity    # Gesundheit: Aktivitäts-Tab
npm run test:health-cycle       # Gesundheit: Zyklus-Tab (#450)
npm run test:health-export      # Gesundheit: CSV-Export - Formel-Injection-Schutz, Header/Spaltenbreiten-Kopplung über HEALTH_EXPORT_HEADERS, Labor-Fan-out und Zyklus-Längenberechnung
npm run test:health-api         # Gesundheit: Route-Handler + Betreuung (#584): Betreuer schreibt und liest fuer die betreute Person, Fremde erhalten 403, der Zyklus-Tab bleibt ausgenommen
npm run test:health-nav         # Gesundheit: Tab-Navigation
npm run test:health-structure   # Gesundheit: Routen-Split-Guard (45-Routen-Tabelle + Cluster-Disjunktheit)
npm run test:medication-scheduler   # Medikations-Erinnerungs-Scheduler
npm run test:shopping
npm run test:shopping-routes   # Shopping-Routen: Listen/Artikel-CRUD, Kategorie-Rename-Kaskade + Delete-Fallback + Letzte-Sperre, Essensplan-Import-Aggregation
npm run test:meals
npm run test:meals-routes   # Meals-Routen: Validierung/404, Wiederholungs-Serien (Template/Exceptions/Instanzen, scope=series), Zutaten-CRUD, Zutaten→Einkaufsliste-Transfer inkl. Rücknahme (added_ids; das Undo setzt auch on_shopping_list zurück, sonst bliebe die Mahlzeit für immer „schon übertragen")
npm run test:recipes-routes   # Recipes-Routen: owner-403-Gate (kein Admin-Bypass), Validierung/404, Zutaten-Regeln (leerer Name, category-Default, Slicing), meal_types-Normalisierung, Replace-Set + CASCADE, Zutaten→Einkaufsliste-Transfer inkl. exakter Rücknahme über added_ids, gespiegelte Mealie-Rezepte sind serverseitig schreibgeschützt (403 auf PUT/DELETE, nicht nur in der UI ausgeblendet), Thumbnail-Proxy mit MIME-Allowlist
npm run test:pantry-routes    # Vorrats-Routen (#596): Validierung/404, Mengen-Normalisierung (Rundung/Klemmung/Default 1 statt 0), Einheit wird normalisiert statt abgelehnt, Lagerort-Guards (letzter Ort, NOCASE-Konflikt, ON DELETE SET NULL erhält Bestand), PATCH als Teil-Update, beide Import-Richtungen inkl. Chargen-Regel (gleiches MHD addiert, abweichendes MHD = eigene Zeile) Scope-Trennung (import-shopping räumt die Einkaufsliste nicht ab) und die geteilte Rücknahme (POST /shopping/items/undo-transfer: unbekannte IDs werden übergangen, removed sagt was zurückging)
npm run test:pantry-ownership-migration   # Migration v109 (#596 Follow-up): created_by nullable + ON DELETE SET NULL statt CASCADE - der Tabellen-Rebuild erhält Bestand, Lagerort, Indizes und updated_at-Trigger; das Löschen eines Mitglieds entkoppelt nur die Herkunft und vernichtet nicht den Haushaltsvorrat
npm run test:module-registry-parity       # Client-/Server-Modulregister-Parität: SCOPE_MODULE_KEYS gegen MODULE_KEYS, NAV_TO_MODULE gegen PERMISSION_MODULES.navIds, MODULE_ACCENT-Abdeckung, die drei Kitchen-Child-Listen, KITCHEN_NAV_IDS, TOGGLEABLE_MODULES und die sw.js-Caches. Fängt die Drift, die beim Vorrat alle sechs Client-Zwillinge übersprang, während der Server lückenlos verdrahtet war
npm run test:pantry-status    # Vorrats-Ableitungen (#596): Ablauf-Schwelle EXPIRY_SOON_DAYS (inklusiv, exakte Grenze), daysUntil über Monatswechsel, "fast leer" vs. "leer" (disjunkt), Filter-Zählung mit Mehrfachtreffern, Einheiten-/Mengen-Normalisierung und Stepper-Schrittweiten
npm run test:birthdays-routes   # Birthdays-Routen: Validierung/404 (Foto-Data-URL + Größenlimit), partielle COALESCE-Updates, limit-Clamp, GET-Sync-Seiteneffekt (calendar_events), Löschung inkl. Artefakt-Aufräumen
npm run test:birthday-import    # Geburtstags-Import aus Kontakten (#518): Migration v90 (contact_id + Unique-Index), Kandidaten/Import-Service (idempotent), Routen GET /import/candidates + POST /import
npm run test:birthday-localization   # Geburtstags-Lokalisierung (#524, #631, #632): Kalender-Read liefert birthday_name/birthday_date für die Client-Übersetzung; der gespeicherte Titel folgt der Datensprache des Haushalts (language → region → en), ein Sprachwechsel betitelt Bestandstermine um, der ICS-Feed exportiert die lokalisierte Fassung; Locale-Key-Parität
npm run test:calendar
npm run test:ncb            # notes, contacts, budget
npm run test:notes-routes   # Notes-Routen: Validierung (Inhalt-Pflicht, HEX-Farbe)/404, CRUD, Pin-Toggle, Pinned-zuerst-Sortierung
npm run test:contact-categories   # Kontakt-Kategorien (#357): Migration (Seed mit Icons, DE-Namen→Keys, Orphan-Adoption) + CRUD-Guards
npm run test:notes-reader   # Notizen Reader-Modus: Lese/Bearbeiten-Umschalter, i18n-Parität
npm run test:budget-recurrence   # recurring budget intervals + virtual budgeting; seit #636 Einheit + Anzahl (weekly/monthly/yearly, "alle N"): Terminaufzählung im Monat, Monatsende-Kappung, Skip je Fälligkeitstag
npm run test:budget-stats   # statistics tab: computeStatsRange, computeStats, GET /budget/stats, range CSV export
npm run test:subscriptions  # Budget subscription tracker: CRUD, renewals, currencies, SSRF-protected logo lookup
npm run test:budget-structure   # Budget-Routen-Split: 35-Routen-Tabelle + Re-Export-Fläche gepinnt; seit #637 zusätzlich die Regel, dass JEDE Summe über budget_entries erwartete Buchungen ausschließt
npm run test:budget-accounts    # Budget-Konten (#495): CRUD, laufender Saldo (Startsaldo + zugeordnete Einträge), Nettovermögen
npm run test:budget-ui          # Budget-UI-Verträge: TAB_CAPS (Zeitbezug/Neu-Aktion je Tab), Eintragsdatum folgt Monat, Tablist-/Filter-ARIA, Chart-Textalternativen + Datenreihen-Tokens, keine Text-/Farbliterale; geteilte Bausteine (v1.63.0/v1.64.0, als Regel über alle Modul-Dateien statt als Allowlist): ein Geld-Formatierer mit vier Rollen, eine Kennzahlkarte, Panel-Fläche + Kopfleiste geteilt, Arbeitsflächen opak (Glass nur mit Overlay-Rolle im Selektor), eingebettete Untertabs ohne eigenes Seiten-Chrome, eine Zeitachse (kein zweiter Stepper im Panel, Kopf-Slot nie leer), eine Umschalter-Optik (.budget-segmented, kein role="group" mit Auswahlzustand, jede tablist/radiogroup an wireTablist), Kontrast hängt nie an einer Datenfarbe; #636/#637: Intervall-Feld (Einheit + Anzahl, Einheitenwort aus rrule-ui statt zweiter Zuordnung), erwartete Buchung in der Zeile + Bestätigen-Dialog + Hinweiszeile unter den Karten
npm run test:budget-plans       # Budgetplan (#468): computePlanProgress (Plan vs. Ist + Sparziel), GET/PUT/DELETE /budget/plans
npm run test:budget-visibility  # Budget-Sichtbarkeit (#476/#505): owner-basiertes Modell (private/shared), Ansichts-Scope mine/household
npm run test:budget-routes-scope   # Budget-Routen im Personal-Modus (#476/#505): End-to-End über den echten Router, Default-Sichtbarkeit, Lese-Scope
npm run test:budget-loans-routes   # Loans-Routen: owner_id/visibility-Enforcement (#476/#505), mayEdit-Gates (kein Admin-Bypass), Repayment-Erbung, shared-Kontrast, Zins-Darlehen-Ableitung (#569), remaining_principal vs. remaining_amount in API + Summenkarte
npm run test:budget-loans-amortization   # Zins-Darlehen-Mathematik (#569): konstante Annuität, Phasenwechsel nach Zinsbindung, Restschuld nach Zinsbindung/Laufzeit-Ableitung, einphasiger variabler Modus, Schutzfälle (tilgt nicht / zu lang); Restschuld zum Ratenstand liegt unter der Summe der Restraten (Differenz = Restzinsen)
npm run test:budget-loans-migration   # Loans-Tabellen-Rebuild v101 (#569-Nachtrag, variabler Zins): Ratenzahlungen/Trigger/Indizes überleben den DROP, neuer Enum-Wert erlaubt, foreignKeysOff ist Pflicht
npm run test:budget-interval-migration # v128 (#636): half_year → monatlich x 6, Skip-Vermerke vom Monat auf den Fälligkeitstag (inkl. Monatsende-Kappung), verwaiste Vermerke fallen weg, PK/Kaskade der neuen Tabelle
npm run test:budget-entries-routes   # Eintrags-Routen: summary/export (CSV-Injektion), Filter, virtuelles Budget, Loan-Payment-Kopplung, Serien-Sichtbarkeitspropagation, Skip-Markierung (seit #636 je Tag); #637: erwartete Buchungen fehlen in allen Summen, PATCH /:id/confirm inkl. Vorzeichen-Erhalt und CSV-Status-Spalte
npm run test:split-expenses-attachments   # Belege an geteilten Ausgaben (#583-Nachrüstung): Sichtbarkeitsprüfung beim Verknüpfen/Serialisieren (privater Beleg bleibt vor der Gruppe und vor Admins verborgen), PUT ohne Feld lässt Belege stehen, fremder privater Beleg überlebt fremdes Speichern, proof_document_id einer Zahlung wird geprüft
npm run test:budget-attachments   # Belege an Buchungen (#583): attachment_document_ids in POST/PUT, Batch-Laden in GET; Sichtbarkeit des Dokumente-Moduls gilt weiter (privater Fremd-Beleg weder lesbar noch beim Speichern löschbar, kein Admin-Bypass), unbekannte IDs still verworfen, PUT ohne Feld lässt Belege stehen, Serien-PUT fasst sie nicht an, Cascade in beide Richtungen
npm run test:calendar-routes    # Kalender-Routen: GET//upcoming/search, Sichtbarkeit (kein Admin-Bypass), Serien-Expansion, requireAdmin-Sync-Gates, subscriptions/import/feed/holidays, CRUD, reset/exceptions (EXDATE)
npm run test:calendar-structure  # Kalender-Routen-Split: 46-Routen-Tabelle + Cluster-Disjunktheit + /:id-Reihenfolge-Vertrag + Re-Export-Fläche gepinnt
npm run test:calendar-exceptions  # Einzeltermin-Ausnahmen für Serien (EXDATE, #489): Migration v85 + POST /calendar/:id/exceptions
npm run test:calendar-defaults    # Standardwerte für neue Termine (#497/#498): per-User calendar_default_reminders (Offset-Liste, Cap, Validierung)
npm run test:preferences-calendar-target  # Standard-Sync-Ziel (#620): GET-Default '', PUT google:/caldav:-Kennungen, Formfehler -> 400, Per-User-Isolation, Wert auch in der PUT-Antwort
npm run test:sync-target        # Kennungsformat der Sync-Ziele (#620): bauen/zerlegen invers, Pipe in der CalDAV-URL überlebt, entfallenes Ziel bleibt sichtbar statt still zu verschwinden
npm run test:recurring-scope    # Serientermin-Scope (#532): truncateRuleBefore (RRULE-UNTIL-Kürzung) + shiftSeriesStart/shiftEndForStart + End-to-End-Expansion
npm run test:family-routes      # Family-Route GET /members: Worker-Ausschluss, NOCASE-Sortierung, LEFT JOIN contacts/birthdays
npm run test:modules        # Third-Party-Modul-Registry: Manifest-Validierung, Path-Traversal-Schutz, error-Fallback, admin-Filter, enable-Toggle, Asset-MIME
npm run test:budget-categories-routes   # Budget-Kategorien-Routen: CRUD Kategorien/Subkategorien, 409-Dubletten (NOCASE), in-use/letzte-Sperren, reorder, lokalisierte Leseliste
npm run test:reminders
npm run test:multi-reminders   # multiple reminders per calendar event: GET /reminders/all, PUT /reminders replace-set (#436)
npm run test:reminders-routes  # Reminders-Routen: HTTP-Schicht gegen den echten Router
npm run test:reminder-offset   # reminder remind_at offset calculation
npm run test:push           # Web Push: VAPID resolution, subscribe/unsubscribe routes, delivery, scheduler
npm run test:email          # SMTP-Service: config/env resolution, masking, sendMail/sendTest, admin routes
npm run test:password-reset # Reset tokens: create/verify/consume/cleanup + forgot/reset-password routes
npm run test:admin-password-reset # PATCH /auth/users/:id password field: admin sets existing member's password (#372)
npm run test:password-normalization # Passwort-Unicode: NFC-Hashing, Login mit NFD-Eingabe (Firefox/macOS), stille Migration alter NFD-Hashes, /me/password (#608)
npm run test:invites        # Einladungslinks: Token-Lebenszyklus (nur der Hash liegt in der DB, alle vier Ausschlussgründe beim Prüfen, Einlösen markiert statt löscht) + Routen: requireAdmin-Gate, CSRF, und Rolle/Familienrolle stammen aus der Einladung, nie aus dem Body des Eingeladenen
npm run test:notifications  # Notification-Kanäle (Gotify/ntfy): Provider-Mapping, Reminder-Fan-out, Admin-Routen, Payload-Body je entity_type (#581)
npm run test:mcp            # MCP-Server: JSON-RPC-Dispatch (initialize/tools/list/tools/call) + Tool-Logik (Tasks, Shopping, Kalender)
npm run test:token-scopes   # API-/MCP-Token-Scopes: scopes.js-Modell + Enforcement (tools/list-Filter, tools/call-Deny)
npm run test:permissions    # Rollen & Rechte: Resolver (Admin-Bypass, Rolle/Mitglied-Override, Widget-Kaskade), Session-Enforcement-Map, Sparse-Speicherung (#467); dazu der Abgleich der drei Widget-Listen (WIDGET_IDS in dashboard.js, PERMISSION_WIDGETS serverseitig, WIDGET_LABEL_KEYS in der Rechte-UI) - ein neues Widget fehlt sonst still in den Rechten oder trägt dort seinen rohen Slug
npm run test:permissions-routes   # Rechte-Routen: requireAdmin-Gate (kein Privilege-Escalation), Payload-Validierung, sparse-Persistenz/Round-Trip, Admin-Ziel-Sonderregel
npm run test:dashboard
npm run test:ics-parser
npm run test:ics-sub        # ICS-Abos: SSRF-Guards, ETag/304, und unveränderte Läufe schreiben nicht (kein Rowid-Verbrauch, kein info-Log)
npm run test:ics-export     # ICS-Kalenderexport
npm run test:ics-import     # einmaliger ICS-/Feed-Import als bearbeitbare lokale Termine (#437)
npm run test:modal-utils
npm run test:detail-view    # Leseansicht vor dem Formular (Kalender, Aufgaben, Kontakte): Präsentationsweiche (Popover nur ab 768px UND mit Anker), die drei Fallen des Pane-Wechsels in fester Reihenfolge, Fußzeilen-Aktionen schließen mit force (versteckte Formulare zählen in den Dirty-Check), showEventPopup rückstandslos weg, neue i18n-Keys in allen Locales. Für Kontakte zusätzlich: beide Einstiege (Liste + Deep-Link) führen in die Leseansicht, edit.ready sperrt den Wechsel bis die Mehrfachwerte da sind (sonst löscht das Speichern die Zweitnummern), alle Nummern/Mails/Adressen statt der Legacy-Einzelwerte, Kontaktdaten nur über textContent, und die neuen Keys liegen unter contacts statt shopping
npm run test:category-manager   # generic oikos-category-manager component + budget wiring
npm run test:sortable-reorder   # SortableJS-Wrapper + Drag-and-Drop-Reorder im Category-Manager (Teil-Render, Fokus-Restore, aria-live, SW-Precache)
npm run test:datepicker         # yuvomi-datepicker: ISO-Wertkontrakt, form-association, Popover/Touch, min/max, i18n-Vollständigkeit
npm run test:ux-utils        # UX-Helfer: stagger/vibrate/withBusy, Datums-/Zeit-Parser, WCAG-Ink-Wahl; Undo-Löschen läuft ausschließlich über scheduleUndoableDelete (Undo verhindert den Server-Delete, ohne Undo commit nach Ablauf) - die alte deleteWithUndo-API löschte sofort und ist gesperrt
npm run test:skeleton-utils
npm run test:date-utils
npm run test:time-input     # flexible Zeiteingabe: 0930/09.30/9h30 → HH:MM parsing (#442)
npm run test:html-entities
npm run test:help
npm run test:changelog      # Changelog: GitHub-Releases-Proxy (normalizeVersion/cleanMarkdownText/parseReleaseBody/buildChangelogPayload) + der Versionsvergleich hinter dem Update-Punkt (#490): numerisch statt lexikografisch (1.10.0 > 1.9.0), v-Präfix der Tags, Vorabversion unter ihrem Release, Unlesbares löst nie einen Hinweis aus
npm run test:i18n           # App-Locales: Dateiabdeckung, Schlüsselidentität zu de.json, Platzhalter-Parität ({{name}}), 4-Space-Format
npm run test:i18n-plural    # Pluralformen in t(): Intl.PluralRules-Auswahl, Fallback auf Basisschlüssel, Varianten-Parität; dazu die Platzhalter-Ersetzung: Nutzerwerte werden eingesetzt statt interpretiert (kein `$&`/`` $` ``-Rückverweis, kein zweiter Durchgang über bereits Eingesetztes), unbekannte Platzhalter bleiben sichtbar
npm run test:lang-init
npm run test:sw-api-cache   # Service Worker: Read-only-Offline-API-Cache (Whitelist, Fallback, CLEAR_API_CACHE, activate-Cleanup)
npm run test:sw-precache    # Service Worker: Precache-Vollständigkeit (#616) - transitiver Modulgraph lückenlos gecacht, Bucket == fetch-Routing, jeder Pfad existiert (addAll ist All-or-Nothing)
npm run test:api
npm run test:openapi-structure   # OpenAPI-Modul-Split: jede paths/<modul>.js importiert+gespreadet, keine Pfad-Kollision
npm run test:multi-assignment
npm run test:kitchen-tabs
npm run test:caldav         # CalDAV-Sync: Multi-Account, Event-Loop-Yield (#519), Serien-Overrides (#549), No-op-Läufe bleiben still und schreiben unveränderte Termine nicht neu
npm run test:caldav-recurrence   # CalDAV/iOS-Serien mit Wochentags-Wiederholung (#549): FREQ=DAILY;BYDAY + DTSTART am Wochenende
npm run test:caldav-reminders   # VTODO-Inbound: Feld-Abbildung, Prune-Leerguard (#508), DUE als Wanduhrzeit statt UTC (#617; TZ=Europe/Berlin fixiert), RELATED-TO-Hierarchie inkl. Reihenfolge/Enkel/Zyklus (#671)
npm run test:caldav-todo-outbound   # Rückrichtung VTODO (#617): Patcher lässt Alarme/Kategorien stehen, Erledigt = STATUS+COMPLETED+PERCENT-COMPLETE (und weg beim Wiederöffnen), bandtreue Priorität/Status halten urgent und in_progress, DUE-Roundtrip zonenrichtig, Inbound überschreibt keine wartende Bearbeitung und legt Gelöschtes nicht neu an, ein gelöschtes Konto entkoppelt seine Spiegelzeilen statt sie unlöschbar zu machen (v123)
npm run test:caldav-event-target
npm run test:google-multi   # multiple Google calendars + per-event sync target
npm run test:google-outbound   # Löschen + Ändern + Umziehen Yuvomi → Google (#593): Tombstones, Dirty-Marker, events.move, 404/410, Retry-Limit, Inbound-Konfliktschutz; dazu Serien als Master (EXDATE aus Absagen/Verschiebungen, Altbestand-Zusammenführung nur beim Full-Resync)
npm run test:calendar-outbound-migration   # Migrationen v103-v106 gegen befüllte Bestands-DB: additiv, kein Rebuild, Marker starten neutral
npm run test:caldav-outbound   # Löschen + Ändern + Umziehen Yuvomi → CalDAV/Apple (#593): ICS-Patcher (Teilnehmer/Alarme/Overrides bleiben), Objekt-URL-Auflösung, Umzug = create+delete, Sofortversuch ohne Kalenderabruf
npm run test:google-calendar   # Google: Datumskonvertierung, Farbauflösung (#427/#219), unveränderte Events werden beim Full-Resync nicht neu geschrieben
npm run test:housekeeping
npm run test:housekeeping-routes   # Housekeeping-Routen: Worker-Anlage (Admin-Gate), Check-in/out-Lifecycle + Doppelbuchungs-Guard, Pay/Delete, Decay-CRUD, Supply-Requests, Maintenance-Log; dazu die Besuchs-Artefakte: Fallback-Titel folgen der Datensprache (ohne gesetzte Sprache bleibt Englisch), ein verschobener Besuch wird für den Provider-Push vorgemerkt und ein gelöschter räumt die Kopie beim Provider mit ab - beides nur bei gespiegelten Terminen
npm run test:documents          # Dokument-Preview: CSP-Header je MIME-Typ
npm run test:documents-ux       # Dokumente-UX-Verträge: Leerzustände, Kategorie-Facetten, Upload-Modal, Auswahlmodus, Popover-Menü
npm run test:document-storage   # Dokument-Storage-Migration und Invarianten
npm run test:google-drive-storage   # Google Drive als Dokument-Ablage: eigenes Credential-Paar (fail-closed bei halber Konfiguration), OAuth-Callback legt Yuvomi/Documents an und wählt nie Drive als Kalender
npm run test:document-folders   # Dokument-Ordner-Routen: umbenennen/löschen (PUT/DELETE) + ON DELETE SET NULL (#453)
npm run test:task-documents     # Task↔Dokument-Verknüpfungen (#503): GET/PUT /tasks/:id/documents, Sichtbarkeit, Replace-Set, document_count, CASCADE
npm run test:task-tags          # Aufgaben-Tags (#586): v114-Rebuild lässt Indizes/Suchtrigger intakt, Tags bleiben von der Kategorie getrennt, /tags und meta/options zeigen nur Sichtbares (#474), Serien erben ihre Tags, Umbenennen/Zusammenführen/Löschen und Bulk-Vergabe fassen nur Sichtbares an, die globale Suche findet Tags und gibt sie beim Entfernen wieder her (v117-Trigger auf den Tag-Tabellen), Einkaufsposten teilen die Achse ohne ihre Kategorie zu berühren, Unteraufgaben liefern ihre Tags mit
npm run test:dms-adapter        # DMS-Adapter: Paperless-ngx
npm run test:dms-routes         # DMS-Routen: account management, search, link, push
npm run test:dms-papra-adapter  # DMS-Adapter: Papra
npm run test:recipe-provider-adapter   # Recipe-Provider-Adapter: Mealie (#530): Bearer-Auth, Paginierung, Zutaten-Flattening (quantity 0 = Mealies "keine Menge"), Deep-Link aus external_url, Thumbnail-Abruf
npm run test:recipe-provider-tandoor-adapter   # Recipe-Provider-Adapter: Tandoor (#530): Bearer-Auth, next-Link-Paginierung, is_header-Zeilen werden übersprungen, no_amount unterdrückt die Menge, Deep-Link über id (kein linkContext nötig), Thumbnail 404 bei fehlendem Bildpfad
npm run test:recipe-provider-sync   # Recipe-Provider-Sync (#530): Upsert statt Neuanlage über recipe_provider_accounts (Mahlzeitenplan-Verknüpfungen überleben ein Rename), unveränderte Rezepte werden übersprungen, ein fehlgeschlagener/leerer Abruf löscht NIE bestehende Spiegel, recipe_url wird providerübergreifend aus id/slug neu gebaut
npm run test:recipe-provider-routes   # Recipe-Provider-Routen (#530): Konto-CRUD admin-only inkl. provider-Auswahl (Fallback 'mealie' bei ungültigem Wert), Token nie in der Antwort, /status für alle Angemeldeten, manueller Sync, Verbindungstest
npm run test:weather            # Open-Meteo + OWM-Legacy provider resolution
npm run test:preferences-routes    # Preferences-Routen: HTTP-Schicht von server/routes/preferences.js gegen den echten Router
npm run test:preferences-budget-mode   # Budget-Modus in der Preferences-API (#476/#505): GET-Default 'shared', PUT shared/personal
npm run test:preferences-weather   # weather config fields in preferences API
npm run test:preferences-navigation   # preferences side-navigation language refresh
npm run test:preferences-weekstart   # household week-start preference (#484/#465): GET default, PUT monday/sunday/saturday, invalid rejected
npm run test:holidays           # holiday cache lookup, layer toggles, OpenHolidays sync (mocked)
npm run test:carddav        # CardDAV: vCard-Parser, Merge/Adoption (#531/#535), Multi-Values ohne Dubletten des primären Eintrags bei wiederholtem Sync
npm run test:carddav-addressbook-toggle   # Adressbuch-Umschaltung (#534): Frontend↔Router-Vertrag (PUT /addressbooks/:id), Feldnamen, 400/404
npm run test:carddav-account-lifecycle    # CardDAV-Konto: Bearbeiten (PUT, Passwort-Beibehaltung, 409/404), Sammelschalter, sichtbare Sync-Fehler (Migration 92/93)
npm run test:family-contacts
npm run test:contacts-routes   # Kontakt-Routen: Multi-Value (phones/emails/addresses) POST/PUT-Replacement, GET-Filter (category/q), vCard-Export + Escaping (inkl. BDAY), birthday-Persistenz, validateAddresses-Feldzweige, 404/403 (family-Löschschutz)
npm run test:vcard-parser      # vCard-Parser (public/utils/vcard.js): Multi-Card-Split, Feldextraktion, BDAY→birthday-Normalisierung
npm run test:contact-names     # Strukturierte Namensteile (#535): geteilter Helper, POST/PUT-Ableitung, Sortierung, vCard-N-Export, Familien-Spiegel, Dialog-Verträge
npm run test:phone             # Telefon: Frontend-Wrapper (Formatierung/tel:-E.164/Plausibilität/roher Fallback, netz-frei geprimt), server-E.164-Util, Migration-95-Backfill, format-unabhängiges CardDAV-Matching (Duplikat + NULL-Fallback)
npm run test:backup-scheduler
npm run test:backup-webdav
npm run test:backup-routes  # Backup-/Restore-Routen: requireAdmin-Gate, /status, /trigger, /database, /restore (400/413/Roundtrip), WebDAV-Konfig + Loopback-Stub
npm run test:split-expenses
npm run test:split-expenses-routes   # Split-Expenses-Routen: Autorisierung (requireGroupAccess/canManageGroup, Gast-Confinement) + Geld/Ledger-Integrität (Salden, Settlement, Edit/Delete) + Archivieren/Wiederherstellen (#574). Das Gast-Confinement deckt auch den verwaisten Gast ab (Gruppe gelöscht) und den Gast, der zusätzlich in einer fremden Gruppe steht: Gruppenliste, Dashboard-Salden, jüngste Ausgaben, Suche und /expenses/:id bleiben ihm verschlossen
npm run test:split-guest-migration   # Rebuild von split_expense_guest_users (v124): die Zeile trägt "ist beschränkt" (Existenz) und "worauf" (group_id) - das CASCADE aus v40 löschte beim Gruppen-Löschen beide und wertete den Gast zum Vollkonto auf. Prüft Bestandsübernahme (auf frischer DB ist die Tabelle bei v124 leer, der INSERT..SELECT liefe sonst ungetestet), Index, SET-NULL-Verhalten + Gegenbeweis auf dem Vor-v124-Stand
npm run test:search
npm run test:calendar-search   # calendar toolbar search (#471): FTS event search endpoint, location index, recurring next-instance, keyboard
npm run test:search-diacritics # diacritic-insensitive FTS (unicode61 remove_diacritics 2) + ß↔ss query expansion
npm run test:mobile-scroll-layout
npm run test:frontend-audit  # A11y- und Hard-Constraint-Guards des UX-Audits (innerHTML, i18n-Key-Parität, Touch-Targets, Kontraste, page-inline-pad) + Konsistenz-Invarianten: kanonische Breakpoints (640/768/1024/1440), Icon-Skala kollisionsfrei und ohne Inline-Größen, keine nativen Browser-Dialoge, border-radius nur via Token, Modal-Footer als Klasse statt Inline-Style, eine Antwort auf „keine Einkaufsliste", Rücknehmbarkeit jedes Ein-Tipp-Transfers, `{ force: true }` an jedem Löschen-Knopf im Modal, `confirmOverModal` statt `confirmModal` aus einem offenen Modal heraus, ein Folgentext (`detail`) an jedem `danger: true`-Dialog, ein eigener Folgentext je Nutzer des geteilten Category-Managers und eine Render-Funktion mit mehreren Aufrufern, die ihre Lucide-Icons selbst materialisiert (alle sieben Guards durchsuchen den Bestand statt einer Dateiliste)
npm run test:layer-boundary  # Schicht-Guard: public/ importiert nie server/; server/ nur geteilte isomorphe Utils (Allowlist)
npm run test:typography      # Typo-Guard: font-size/letter-spacing nur via Token, Breakpoint- & Rollen-Schicht
npm run test:settings-copy      # Beschriftungswahrheit der Settings-Blätter: Registry-Metadaten und Blatt-Inhalte dürfen nicht auseinanderlaufen
npm run test:settings-navigation
npm run test:settings-cron-label  # Backup-Zeitplan als Klartext: Cron-Muster (täglich/wöchentlich/monatlich/Stundenintervall), null-Fallback für alles Übrige, Locale-Vollständigkeit
npm run test:region-presets   # Region/Format-Presets: Mapping-Validierung + detectRegion-Reverse-Lookup + BCP-47-Formprüfungen ({2,3}, damit fil-PH durchkommt)
npm run test:docker-publish   # Docker-Publish-Workflow: Tags, Plattformen, Trigger
npm run test:auth-userid
npm run test:setup
npm run test:oidc
npm run test:ssrf            # zentraler SSRF-Schutz (server/utils/ssrf.js): kanonische Klassifikationslogik
npm run test:http            # node-nativer Safe-HTTP-Client (server/utils/http.js) gegen echten lokalen Server
npm run test:router-guest-guard   # Regression Split-Guest-Redirect-Schleife (#480)
npm run test:installer-schema
npm run test:installer-env-write
npm run test:installer-static
npm run test:installer-i18n
npm run test:installer-cli-i18n
npm run test:installer-prereq
npm run test:installer-a11y
```
