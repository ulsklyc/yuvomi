# Review-Auftrag: Health/Rewards-Settings + Zyklus-Gate + Rewards-Toggle-Fix

> Diesen Prompt in ein **frisches Kontextfenster** geben. Ziel: unabhängige, vollständige
> Überprüfung der unten beschriebenen, **noch nicht committeten** Implementierung.
> **Kein `/docs-sync`, kein `/release-prep`, kein Commit/Push/Tag/Release ausführen.**

## Kontext

Zwei gemeldete Probleme in Yuvomi (self-hosted Family-Planner, Vanilla-JS, kein Build-Step):

1. **„Zyklus"-Tab unter Gesundheit bleibt beim Aufruf leer.**
2. **In den Einstellungen fehlen Menüreiter (Modul-Konfigurationsseiten) für die neuen Module
   Gesundheit und Belohnungen** — bewusste Entscheidung oder Versehen?

## Diagnose (aus der Implementierungs-Session)

- **Problem 1:** Der Zyklus-Code ist korrekt. Der Tab wurde end-to-end im Browser verifiziert
  (leerer Zustand **und** mit Perioden-Daten, Direktaufruf **und** alle Cross-Tab-Soft-Navigationen);
  Content rendert vollständig und sichtbar. Alle 20 Zyklus-Tests grün. `maybeMountCycle` ist
  strukturgleich zu den funktionierenden Tabs. Das gemeldete „leer" war **nicht reproduzierbar** →
  wahrscheinlichste Ursache: veraltet gecachtes `health.js` auf dem Endgerät (Stale-Cache).
  Reaktion: Zyklus-Tab wurde zu einem **haushaltweiten Opt-in** gemacht (an per Default) und die
  fehlenden Modul-Einstiegspunkte in den Service-Worker-Precache aufgenommen (Offline/Versionierung).
  **Wichtig zu prüfen:** ob diese Änderungen das Symptom plausibel adressieren oder ob eine echte
  Regressionsquelle übersehen wurde.
- **Problem 2:** Bestätigter Gap. Health & Rewards **sind** bereits in Settings → Module →
  *Navigation* (Sichtbarkeit/Sortierung), hatten aber keine **dedizierte Konfigurationsseite** wie
  Kitchen/Budget/etc. Zusätzlich echter Backend-Bug gefunden: `rewards` war im Frontend
  (`modules-navigation.js` `BUILT_IN_MODULES`) als umschaltbar/sortierbar gelistet, fehlte aber im
  Backend (`TOGGLEABLE_MODULES`, `MODULE_ORDER_RE`, `MOBILE_NAV_ORDER_RE`) → An/Aus und Sortierung
  von „Belohnungen" waren ein stiller No-op. (Health war überall korrekt.)

Der Nutzer hat „volle Config-Seiten" gewählt.

## Umgesetzte Änderungen (Working-Tree, uncommittet)

**Backend**
- `server/routes/preferences.js`
  - `rewards` zu `TOGGLEABLE_MODULES`, `MODULE_ORDER_RE`, `MOBILE_NAV_ORDER_RE` ergänzt (Bugfix).
  - Zwei neue haushaltweite Boolean-Preferences über `sync_config`, beide **Default true**
    (`cfgGet(...) !== '0'`): `health_cycle_enabled`, `rewards_require_approval`.
    GET liefert beide; PUT validiert (boolean) und ist **admin-only** für diese beiden Felder.
- `server/routes/rewards.js`
  - Helper `requiresApproval(d)` (liest `sync_config`, Default true).
  - `POST /redemptions`: bei deaktivierter Freigabe wird die Einlösung **sofort** als `fulfilled`
    angelegt (`decided_by`, `decided_at` gesetzt); Punkte bleiben abgezogen (keine Rückbuchung).
- `server/openapi.js`: PUT-/preferences-Beschreibung um die zwei Admin-Booleans ergänzt.

**Frontend**
- `public/utils/health-tabs.js`: `HEALTH_TABS({ cycleEnabled })` filtert den Zyklus-Tab;
  `renderHealthTabsBar(container, activeRoute, { cycleEnabled })`.
- `public/pages/health.js`: Modul-State `cycleEnabled`, `loadHealthPrefs()` (aus `/preferences`),
  `normalizeHealthPath` leitet `/health/cycle` bei deaktiviertem Opt-in auf `/health` um; Panels
  filtern den Zyklus-Eintrag; `render()` lädt Prefs vor dem Panel-Aufbau; `update()` reicht
  `cycleEnabled` an die Tab-Leiste durch.
- `public/settings/registry.js`: zwei neue Leaves unter Domäne `modules` (adminOnly):
  `modules-rewards` (`/settings/modules/rewards`), `modules-health` (`/settings/modules/health`).
- `public/settings/pages/modules-health.js` (neu): Toggle `health_cycle_enabled`.
- `public/settings/pages/modules-rewards.js` (neu): Toggle „Belohnungen aktivieren"
  (schreibt `disabled_modules` ± `rewards`, ruft `window.yuvomi.setDisabledModules`) +
  Toggle `rewards_require_approval`.
- `public/sw.js`: `PAGE_MODULES` um `/pages/health.js`, `/pages/rewards.js`,
  `/settings/pages/modules-rewards.js`, `/settings/pages/modules-health.js` ergänzt.

**i18n**
- 14 neue Keys unter `settings.*` in **allen 23** `public/locales/*.json` (JSON gültig, 4-Space,
  8-Space-Keys). `de` = kanonisch (Deutsch), `en` = echtes Englisch, die **21 übrigen Locales
  erhielten den englischen Wert als Platzhalter** (noch nicht muttersprachlich übersetzt).

**Docs**
- `docs/SPEC.md`: Rewards-Freigabe als konfigurierbar dokumentiert; Zyklus-Tab als Opt-in
  dokumentiert.

**Tests**
- `test/test-rewards.js`: Auto-Fulfill ohne Freigabe.
- `test/test-health-nav.js`: `HEALTH_TABS({cycleEnabled:false})` blendet Zyklus aus; Rewards-Backend-Parität.
- `test/test-settings-navigation.js`: Leaf-Zähler 21 → 23.

**Bewusst NICHT getan:** Release-Artefakte wurden nach einem abgebrochenen `release-prep`-Lauf
**zurückgesetzt** — `package.json`/`sw.js` `APP_RELEASE` stehen wieder auf **0.98.2**, kein
CHANGELOG-Block, kein Commit/Tag/Push/Release.

## Testlage

Grün gelaufen (Einzelsuiten): `settings-navigation` (65), `rewards` (15, inkl. Auto-Fulfill),
`health-nav` (19, inkl. Zyklus-Gate + Rewards-Parität), `frontend-audit` (138, prüft t()-Keys über
alle Locales), `lang-init` (11), `sw-api-cache` (9), `api` (11). Die **vollständige `npm test`-Suite lief grün** (Exit 0, 58 Suiten,
0 Fehler) — der Lauf erfolgte auf dem inzwischen zurückgesetzten 0.98.3-Stand, der sich nur im
(konsistenten) Versionsstring vom jetzigen 0.98.2 unterscheidet. Reviewer sollte dennoch frisch
`npm test` ausführen.

## Umgebungs-Vorbehalt (wichtig)

Während der Session war der Dateizugriff auf das Projektverzeichnis **zeitweise instabil**
(vermutlich iCloud/Desktop-Sync; `ETIMEDOUT`/`getcwd`-Fehler, Locale-Dateien zeitweise „dataless").
Deshalb: **Live-Browser-Verifikation der neuen Settings-Seiten und des Zyklus-Gates konnte nicht
zuverlässig durchgeführt werden** (Dev-Server startete in schlechten FS-Fenstern nicht durch). Die
Logik ist unit-getestet, aber die UI-Ansichten sind **nicht live geprüft**.

## Dein Auftrag (frischer Kontext)

Führe eine **vollständige, kritische Überprüfung** der obigen Implementierung durch:

1. **Korrektheit & Hard Constraints** (siehe `CLAUDE.md`): `import`/`export` only, kein `innerHTML`
   (nur `insertAdjacentHTML`/DOM-API + `esc()`), alle UI-Strings via `t()`, Tokens statt Hardcodes,
   Migrationen append-only (hier keine neue Migration — via `sync_config`; prüfen ob korrekt),
   jede Route in try/catch.
2. **Zyklus-Gate**: `render()` macht jetzt bei jedem Full-Render ein zusätzliches
   `await api.get('/preferences')` — Latenz/Fehlerpfade ok? `update()` frischt `cycleEnabled` **nicht**
   auf (nur `render()`); reicht das, damit ein Toggle ohne Hard-Reload greift? `/health/cycle` bleibt
   im Router registriert und wird bei deaktiviertem Opt-in nur umgeleitet (URL bleibt stehen) — ok?
3. **Rewards Auto-Fulfill**: `decided_by` = handelnde Person (bei Selbst-Einlösung ohne Freigabe das
   Kind selbst) — semantisch akzeptabel? Ledger-/Saldo-Invarianten unverändert korrekt?
4. **Admin-Gating**: die zwei neuen Prefs sind in PUT admin-only, `housekeeping_payment_tasks` ist es
   nicht — Inkonsistenz bewerten.
5. **Settings-Seiten**: `modules-rewards.js` schreibt `disabled_modules` direkt und über die
   Navigations-Seite — zwei Quellen, gleiche Preference; Race/Drift möglich?
6. **i18n**: 21 Locales tragen englische Platzhalter statt Übersetzungen — Konvention ok oder nachziehen?
7. **Service-Worker-Precache**: sind die vier neuen Einträge korrekt (Pfade existieren, keine Änderung
   an der cacheFirst/networkFirst-Strategie nötig)? Adressiert der Precache Problem 1 wirklich, oder
   nur die Offline-Verfügbarkeit?
8. **Live-Verifikation nachholen**: Dev-Server starten, als Admin einloggen, prüfen:
   (a) Settings → Module zeigt „Gesundheit" und „Belohnungen"; beide Seiten rendern mit
   übersetzten Labels; (b) Zyklus-Toggle aus → Zyklus-Tab verschwindet, `/health/cycle` leitet auf
   Übersicht um; (c) Rewards-Toggle in Navigation persistiert jetzt; (d) Freigabe-Toggle aus →
   Einlösung sofort `fulfilled`.
9. Vollständige `npm test`-Suite grün?

Melde Findings nach Schweregrad. **Nimm keine Release-/Docs-Sync-Schritte vor** und committe nicht —
nur Review (bei Bedarf gezielte Korrekturen am Working-Tree).
