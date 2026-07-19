# UX-Audit - Phase 2/3 Changelog

Stand: 2026-07-19 · Branch `audit/ux-ui-full-2026-07` · 16 Fix-Commits (`3b2dd230..16b4d3fd`, nach Audit-Commit `8c9974e4`)
Verifikation: kompletter Testlauf `npm test` grün (Exit 0; ein einmaliger Socket-Flake in `test-calendar-exceptions` unter Volllast, isoliert 2x grün, kein Bezug zu den Änderungen) + Live-Prüfung im Browser (Light+Dark, Desktop+Mobile, Service-Worker-Cache vor der Verifikation geleert - der SW liefert sonst alte Page-Module aus).

## Geschlossene Findings (16 von 17)

| ID | Commit | Was geändert wurde |
|----|--------|--------------------|
| F-02 | `3b2dd230` | Shopping-Zeilenaktionen (`item-details`/`item-delete`) von Disabled-Farbe+Opacity (~1.2:1) auf row-action-Grammatik: dauerhaft tertiär sichtbar, Hover mit Flächenfarbe. Redundanter Mobile-Sonderfall entfernt. Klassen/Geometrie beibehalten (Test-Pins). |
| F-01 | `9463d457` | Sidebar: `positionSidebarIndicator` scrollt das aktive Item in Sicht (manuelles Container-Scrolling, offsetTop-Mathe); neues `wireScrollFade` (utils/ux.js) setzt vertikale Fade-Masken; Item-Höhe Desktop 48→40px, Sektionslabels enger (scrollHeight 788→668 bei 13 Einträgen). |
| F-03 | `d5650602` | Shopping-Listenkopf Mobile: Zeile 1 Name (voll breit), Zeile 2 eine nowrap-Aktionsleiste, Abgehakt-löschen-Label ellipsiert; Inline-Styles der Header-Buttons in Klassen überführt. |
| F-04 | `3dfb3458` | Meals-Wochenboard 1024-1439px: neues `formatDayMonth()` (i18n.js, präferenz-treues Datum ohne Jahr), Typ-Label-Span mit Ellipsis (Farb-Dot bleibt), Karten-Titel 2-zeilig mit Silbentrennung, Rezept-Sidebar 272px unter 1440px, Header-nowrap-Schutz. |
| F-05 | `aa21e510` | `quick-add__btn` auf `--module-accent` (vorher App-Violett neben Modul-Pink). |
| F-10 | `b76a1605` | Fokus-Ringe: Quick-Add Menge/Kategorie (Box-Shadow-Ring statt nur Border-Farbwechsel, zugleich auf Modul-Akzent vereinheitlicht), Settings-Avatar (echter Outline-Ring statt nur Schatten+Lift). |
| F-07 | `57cfbf1f` | `check-pop` (Tasks-Status, Subtask-Checkbox, Shopping-Abhaken) unter `prefers-reduced-motion` deaktiviert. |
| F-08 | `d97c27f7` | `weatherLocateUnsupported` in de.json von Sie- auf Du-Form (einziger Ausreißer; andere Locales folgen ihrer eigenen Anredekonvention und blieben unberührt). |
| F-09 | `22c6da64` | Mehr-Sheet-Labels: `overflow-wrap:anywhere` → `hyphens:auto` + `break-word`-Backstop; live verifiziert („Einstellun-gen", „Haushaltshil-fe" = korrekte Silbengrenzen mit Trennstrich). |
| F-11 | `22d64230` | Health-Vitals-Kachel: Label bricht mit Silbentrennung statt aus der Kachel zu laufen („Sauerstoffsättigung"). |
| F-12 | `fc6bbca8` | Einkaufslisten-Löschung (Container) über `confirmModal(danger)` mit vorhandenem `deleteListConfirm`-Key + sofortigem Delete; Undo-Toast bleibt Muster für Einzel-Artikel. |
| F-06 | `cfd27b51` | Geteilte Scroll-Fade-Affordanz: `wireScrollFade` um MutationObserver + `{update, destroy}` erweitert; `has-fade-*`-Masken zentral in filter-chip.css. Budget ersetzt lokale Kopie (deren Initial-Update nie lief - Ursache des Desktop-Clips ohne Fade), Dokumente geben `is-scrollable/is-at-end` auf; NEU angeschlossen: Kontakte-Kategorien, Health-Personen-Chips (zentral in `wireTablistKeys`), Kalender-Ansichts-Umschalter mobil. |
| F-13 | `d758c842` | Undo-Löschmuster zentralisiert: `scheduleUndoableDelete` (ux.js) mit pagehide-Flush per `keepalive`-Fetch; api.js post/put/delete reichen fetch-Optionen durch. **14 Stellen** migriert (Audit schätzte 6): Tasks einzeln+bulk, Notizen, Rezepte, Kontakte einzeln+bulk, Kalender Termin+Serie-kürzen+Einzeltermin, Einkauf Artikel+Abgehakte, Budget Eintrag+Serie+Darlehen+Rate, Dokumente bulk. Nebenbefund behoben: Budget-Serien-Undo stellte die UI nie wieder her. |
| F-16 | `b3acab81` | Inset-Fokusringe: Abo-Combobox-Optionen (`:focus-visible`, unterscheidet Fokus von Hover/aria-selected) + Kontakt-Menüpunkte. |
| F-14 | `c6b2911d` | Motion-Skala: `--duration-2xs..2xl` (80-400ms) in tokens.css; 50 Zeit-Literale tokenisiert, 28 Ausreißer auf ms-Notation vereinheitlicht (Timings unverändert, reine Äquivalenz); Konvention dokumentiert. `--transition-*` selbst auf ms-Notation. |
| F-15 | `16b4d3fd` | Einkauf nutzt den geteilten `yuvomi-category-manager`: `_keyOf`-Helper (String-`key` oder numerische `id`), Icon-Rendering in Zeilen; 221-Zeilen-Duplikat `shopping-category-manager.js` entfernt (inkl. SW-Precache, `.shopping-cat-*`-Styles, Typo-Rollen); Test-Verträge in test-shopping.js/test-frontend-audit.js neu gepinnt; Deep-Link `?manage=categories` live verifiziert. |

## Bewusste Nicht-Änderungen

- **F-17 (Demo-Seed auf Deutsch): verworfen.** Der Seed ist nachweislich absichtlich englisch - er benennt sogar die deutschen Default-Kategorien explizit um (`scripts/seed-demo.js:140-157` „Renaming shopping categories to English…") und dient den EN-Marketing-Screenshots (Screenshot-Pipeline unterstützt `SHOT_LOCALE`). Eine Übersetzung würde diese dokumentierte Entscheidung zerstören. Sauberer Weg wäre ein `--locale`-Parameter im Seed - als mögliche Folgeaufgabe notiert, außerhalb dieses Audit-Scopes.
- **Gepinnte Verträge unangetastet:** zwei Modulkopf-Familien, Undo-Toast als Einzel-Item-Muster, Kitchen-Tab-Ellipsis, Region-Fokusziele mit `outline:none` (dokumentiert), Notes-Grid.
- **Swipe-Löschen im Einkauf bleibt direkt** (ohne Undo): die Swipe-Geste ist selbst die Bestätigung; nur Button-Löschungen laufen über das Undo-Muster.
- **Settings blieb im Scroll-Bereich der Sidebar** (F-01-Empfehlung c war „und/oder"): Dichte + Auto-Scroll + Fades lösen das Problem; ein Umzug in die Footer-Region hätte die More-Sheet-Parität gebrochen.

## Offen / manuell zu prüfen

- Echtes iOS-Safari/PWA-Standalone (Safe-Areas, `keepalive` beim pagehide, Popover-Verhalten) - Harness rendert kein echtes WebKit.
- Screenreader-Durchlauf (VoiceOver/NVDA) - codeseitig geprüft (ARIA, Fokusreihenfolge), nicht gehört.
- Der einmalige Testlauf-Flake (`test-calendar-exceptions`, „other side closed" unter paralleler Suite-Last) ist vorbestehend; bei Wiederauftreten Port-/Server-Teardown der Suite prüfen.
- Kein Release durchgeführt (auf Freigabe wartend, gemäß Arbeitsvereinbarung): docs-sync/release-prep stehen aus; beim Release den SW-`APP_RELEASE`-Bump nicht vergessen.
