# Test-Suiten

Vollständige, annotierte Liste aller `npm run test:*`-Suiten. Ausgelagert aus `CLAUDE.md`, damit die pro Session geladene Projekt-Instruktion schlank bleibt.

Testinfrastruktur: In-Memory-SQLite (`--experimental-sqlite`), Node >= 22. Kein laufender Server nötig - Tests importieren die Route-Handler direkt.

Neue Suite: `test/test-[module].js` anlegen + `test:[module]`-Skript in `package.json` eintragen. Imports von App-Code (`server/`, `public/`, `tools/`) und Root-Dateien via `../`.

```bash
npm test             # Alle Suiten (Node >=22)
npm run test:db
npm run test:rename-migration   # Oikos→Yuvomi Identifier-Migration: seamless rename invariants
npm run test:tasks
npm run test:tasks-recurrence   # recurring task catch-up: nextOccurrenceAfter + PATCH status follow-up
npm run test:tasks-routes       # Tasks-Routen-Schicht: PUT/:id, meta/options, Kategorie-CRUD (404/400/409), Filter, Verschachtelung, PATCH-Status, DELETE
npm run test:task-categories    # Aufgaben-Kategorien (#494/#357): Migration (Seed, Sonstiges→misc, Orphan-Adoption) + CRUD-Guards
npm run test:visibility         # Sichtbarkeit (#474): all|assignees|private Durchsetzung (Tasks+Termine), kein Admin-Bypass, normalizeVisibility
npm run test:sync-default-assignee   # Standard-Zuweisung pro Sync-Ziel (#459): assignDefaultToEvent (neu-only, idempotent, No-op bei verwaister Person)
npm run test:rewards            # Belohnungen: Punkte-Vergabe/Storno/Idempotenz, Katalog, Einlösen mit Freigabe, Bonus, Ledger
npm run test:rewards-routes     # Belohnungs-Routen: requireAdmin-Gates, Redemption-Autorisierung (Nicht-Admin nur für sich/Admin stellvertretend), Eltern-Freigabe pending vs. autoFulfill, 409-Idempotenz, Punkte-Reservierung/Rückbuchung
npm run test:health-overview    # Gesundheit: Übersichts-Tab
npm run test:health-vitals      # Gesundheit: Vitalwerte-Tab
npm run test:health-meds        # Gesundheit: Medikamente-Tab
npm run test:health-labs        # Gesundheit: Laborwerte-Tab
npm run test:health-activity    # Gesundheit: Aktivitäts-Tab
npm run test:health-cycle       # Gesundheit: Zyklus-Tab (#450)
npm run test:health-api         # Gesundheit: Route-Handler
npm run test:health-nav         # Gesundheit: Tab-Navigation
npm run test:health-structure   # Gesundheit: Routen-Split-Guard (41-Routen-Tabelle + Cluster-Disjunktheit)
npm run test:medication-scheduler   # Medikations-Erinnerungs-Scheduler
npm run test:shopping
npm run test:shopping-routes   # Shopping-Routen: Listen/Artikel-CRUD, Kategorie-Rename-Kaskade + Delete-Fallback + Letzte-Sperre, Essensplan-Import-Aggregation
npm run test:meals
npm run test:meals-routes   # Meals-Routen: Validierung/404, Wiederholungs-Serien (Template/Exceptions/Instanzen, scope=series), Zutaten-CRUD, Zutaten→Einkaufsliste-Transfer
npm run test:recipes-routes   # Recipes-Routen: owner-403-Gate (kein Admin-Bypass), Validierung/404, Zutaten-Regeln (leerer Name, category-Default, Slicing), meal_types-Normalisierung, Replace-Set + CASCADE
npm run test:birthdays-routes   # Birthdays-Routen: Validierung/404 (Foto-Data-URL + Größenlimit), partielle COALESCE-Updates, limit-Clamp, GET-Sync-Seiteneffekt (calendar_events), Löschung inkl. Artefakt-Aufräumen
npm run test:birthday-import    # Geburtstags-Import aus Kontakten (#518): Migration v90 (contact_id + Unique-Index), Kandidaten/Import-Service (idempotent), Routen GET /import/candidates + POST /import
npm run test:birthday-localization   # Geburtstags-Lokalisierung im Kalender (#524): Kalender-Read liefert birthday_name/birthday_date, Client übersetzt Titel/Beschreibung; Locale-Key-Parität
npm run test:calendar
npm run test:ncb            # notes, contacts, budget
npm run test:notes-routes   # Notes-Routen: Validierung (Inhalt-Pflicht, HEX-Farbe)/404, CRUD, Pin-Toggle, Pinned-zuerst-Sortierung
npm run test:contact-categories   # Kontakt-Kategorien (#357): Migration (Seed mit Icons, DE-Namen→Keys, Orphan-Adoption) + CRUD-Guards
npm run test:notes-reader   # Notizen Reader-Modus: Lese/Bearbeiten-Umschalter, i18n-Parität
npm run test:budget-recurrence   # recurring budget intervals + virtual budgeting
npm run test:budget-stats   # statistics tab: computeStatsRange, computeStats, GET /budget/stats, range CSV export
npm run test:subscriptions  # Budget subscription tracker: CRUD, renewals, currencies, SSRF-protected logo lookup
npm run test:budget-structure   # Budget-Routen-Split: 33-Routen-Tabelle + Re-Export-Fläche gepinnt
npm run test:budget-accounts    # Budget-Konten (#495): CRUD, laufender Saldo (Startsaldo + zugeordnete Einträge), Nettovermögen
npm run test:budget-ui          # Budget-UI-Verträge: TAB_CAPS (Monatsnav/Neu-Aktion je Tab), Eintragsdatum folgt Monat, Tablist-/Filter-ARIA, Chart-Textalternativen + Datenreihen-Tokens, keine Text-/Farbliterale
npm run test:budget-plans       # Budgetplan (#468): computePlanProgress (Plan vs. Ist + Sparziel), GET/PUT/DELETE /budget/plans
npm run test:budget-visibility  # Budget-Sichtbarkeit (#476/#505): owner-basiertes Modell (private/shared), Ansichts-Scope mine/household
npm run test:budget-routes-scope   # Budget-Routen im Personal-Modus (#476/#505): End-to-End über den echten Router, Default-Sichtbarkeit, Lese-Scope
npm run test:budget-loans-routes   # Loans-Routen: owner_id/visibility-Enforcement (#476/#505), mayEdit-Gates (kein Admin-Bypass), Repayment-Erbung, shared-Kontrast
npm run test:budget-entries-routes   # Eintrags-Routen: summary/export (CSV-Injektion), Filter, virtuelles Budget, Loan-Payment-Kopplung, Serien-Sichtbarkeitspropagation, Skip-Markierung
npm run test:calendar-routes    # Kalender-Routen: GET//upcoming/search, Sichtbarkeit (kein Admin-Bypass), Serien-Expansion, requireAdmin-Sync-Gates, subscriptions/import/feed/holidays, CRUD, reset/exceptions (EXDATE)
npm run test:calendar-structure  # Kalender-Routen-Split: 45-Routen-Tabelle + Cluster-Disjunktheit + /:id-Reihenfolge-Vertrag + Re-Export-Fläche gepinnt
npm run test:calendar-exceptions  # Einzeltermin-Ausnahmen für Serien (EXDATE, #489): Migration v85 + POST /calendar/:id/exceptions
npm run test:calendar-defaults    # Standardwerte für neue Termine (#497/#498): per-User calendar_default_reminders (Offset-Liste, Cap, Validierung)
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
npm run test:notifications  # Notification-Kanäle (Gotify/ntfy): Provider-Mapping, Reminder-Fan-out, Admin-Routen
npm run test:mcp            # MCP-Server: JSON-RPC-Dispatch (initialize/tools/list/tools/call) + Tool-Logik (Tasks, Shopping, Kalender)
npm run test:token-scopes   # API-/MCP-Token-Scopes: scopes.js-Modell + Enforcement (tools/list-Filter, tools/call-Deny)
npm run test:permissions    # Rollen & Rechte: Resolver (Admin-Bypass, Rolle/Mitglied-Override, Widget-Kaskade), Session-Enforcement-Map, Sparse-Speicherung (#467)
npm run test:permissions-routes   # Rechte-Routen: requireAdmin-Gate (kein Privilege-Escalation), Payload-Validierung, sparse-Persistenz/Round-Trip, Admin-Ziel-Sonderregel
npm run test:dashboard
npm run test:ics-parser
npm run test:ics-sub
npm run test:ics-export     # ICS-Kalenderexport
npm run test:ics-import     # einmaliger ICS-/Feed-Import als bearbeitbare lokale Termine (#437)
npm run test:modal-utils
npm run test:category-manager   # generic oikos-category-manager component + budget wiring
npm run test:sortable-reorder   # SortableJS-Wrapper + Drag-and-Drop-Reorder im Category-Manager (Teil-Render, Fokus-Restore, aria-live, SW-Precache)
npm run test:datepicker         # yuvomi-datepicker: ISO-Wertkontrakt, form-association, Popover/Touch, min/max, i18n-Vollständigkeit
npm run test:ux-utils
npm run test:skeleton-utils
npm run test:date-utils
npm run test:time-input     # flexible Zeiteingabe: 0930/09.30/9h30 → HH:MM parsing (#442)
npm run test:html-entities
npm run test:help
npm run test:changelog      # Changelog: GitHub-Releases-Proxy (normalizeVersion/cleanMarkdownText/parseReleaseBody/buildChangelogPayload)
npm run test:i18n-plural    # Pluralformen in t(): Intl.PluralRules-Auswahl, Fallback auf Basisschlüssel, Varianten-Parität
npm run test:lang-init
npm run test:sw-api-cache   # Service Worker: Read-only-Offline-API-Cache (Whitelist, Fallback, CLEAR_API_CACHE, activate-Cleanup)
npm run test:api
npm run test:openapi-structure   # OpenAPI-Modul-Split: jede paths/<modul>.js importiert+gespreadet, keine Pfad-Kollision
npm run test:multi-assignment
npm run test:kitchen-tabs
npm run test:caldav
npm run test:caldav-recurrence   # CalDAV/iOS-Serien mit Wochentags-Wiederholung (#549): FREQ=DAILY;BYDAY + DTSTART am Wochenende
npm run test:caldav-reminders
npm run test:caldav-event-target
npm run test:google-multi   # multiple Google calendars + per-event sync target
npm run test:google-calendar
npm run test:housekeeping
npm run test:housekeeping-routes   # Housekeeping-Routen: Worker-Anlage (Admin-Gate), Check-in/out-Lifecycle + Doppelbuchungs-Guard, Pay/Delete, Decay-CRUD, Supply-Requests, Maintenance-Log
npm run test:documents          # Dokument-Preview: CSP-Header je MIME-Typ
npm run test:documents-ux       # Dokumente-UX-Verträge: Leerzustände, Kategorie-Facetten, Upload-Modal, Auswahlmodus, Popover-Menü
npm run test:document-storage   # Dokument-Storage-Migration und Invarianten
npm run test:document-folders   # Dokument-Ordner-Routen: umbenennen/löschen (PUT/DELETE) + ON DELETE SET NULL (#453)
npm run test:task-documents     # Task↔Dokument-Verknüpfungen (#503): GET/PUT /tasks/:id/documents, Sichtbarkeit, Replace-Set, document_count, CASCADE
npm run test:dms-adapter        # DMS-Adapter: Paperless-ngx
npm run test:dms-routes         # DMS-Routen: account management, search, link, push
npm run test:dms-papra-adapter  # DMS-Adapter: Papra
npm run test:weather            # Open-Meteo + OWM-Legacy provider resolution
npm run test:preferences-routes    # Preferences-Routen: HTTP-Schicht von server/routes/preferences.js gegen den echten Router
npm run test:preferences-budget-mode   # Budget-Modus in der Preferences-API (#476/#505): GET-Default 'shared', PUT shared/personal
npm run test:preferences-weather   # weather config fields in preferences API
npm run test:preferences-navigation   # preferences side-navigation language refresh
npm run test:preferences-weekstart   # household week-start preference (#484/#465): GET default, PUT monday/sunday/saturday, invalid rejected
npm run test:holidays           # holiday cache lookup, layer toggles, OpenHolidays sync (mocked)
npm run test:carddav
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
npm run test:split-expenses-routes   # Split-Expenses-Routen: Autorisierung (requireGroupAccess/canManageGroup, Gast-Confinement) + Geld/Ledger-Integrität (Salden, Settlement, Edit/Delete)
npm run test:search
npm run test:calendar-search   # calendar toolbar search (#471): FTS event search endpoint, location index, recurring next-instance, keyboard
npm run test:search-diacritics # diacritic-insensitive FTS (unicode61 remove_diacritics 2) + ß↔ss query expansion
npm run test:mobile-scroll-layout
npm run test:frontend-audit
npm run test:layer-boundary  # Schicht-Guard: public/ importiert nie server/; server/ nur geteilte isomorphe Utils (Allowlist)
npm run test:typography      # Typo-Guard: font-size/letter-spacing nur via Token, Breakpoint- & Rollen-Schicht
npm run test:settings-navigation
npm run test:region-presets   # Region/Format-Presets: Mapping-Validierung + detectRegion-Reverse-Lookup
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
