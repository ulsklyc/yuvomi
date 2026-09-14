# Yuvomi - Umbrel App Store source

`umbrel-app.yml` und `docker-compose.yml` in diesem Ordner sind ein **wortgleicher
Spiegel** des veröffentlichten Pakets in
[`getumbrel/umbrel-apps`](https://github.com/getumbrel/umbrel-apps/tree/master/yuvomi).
Wortgleich ist Absicht: nur so zeigt ein `diff` gegen Upstream, was auseinanderläuft.
Prozesswissen und Begründungen stehen deshalb hier, nicht als Kommentar in den
gespiegelten Dateien.

Die Ersteinreichung `getumbrel/umbrel-apps#5732` ist **gemergt** - Yuvomi ist im
offiziellen App Store. Die Bilder liegen separat in
[`umbrel-apps-gallery`](https://github.com/getumbrel/umbrel-apps-gallery/tree/master/yuvomi)
(`yuvomi/1.webp` … `5.webp` + `icon.svg`).

## Gallery

Der Store nutzt **2160x1350-WebP-Kompositionen** im Umbrel-Hausstil
(Pastellgradient, Headline, Safari-Fenster mit `umbrel.local`) - keine rohen
Screenshots. Die Quellen hier in `gallery/` (`1.webp` … `5.webp`) baut
`scripts/build-umbrel-gallery.mjs` aus den EN-Light-Screenshots unter
`docs/screenshots/` in genau diesem Stil; nach einem Screenshot-Refresh einmal
laufen lassen. Aktualisiert werden die Store-Bilder wahlweise über einen PR an
`umbrel-apps-gallery` (gleiche Dateinamen, dann ist kein Manifest-Change noetig)
oder, der offizielle Weg, indem man die Roh-Screenshots dem naechsten
`umbrel-apps`-PR in den Body legt und das Umbrel-Team um einen Gallery-Refresh
bittet. Die frueheren `1.jpg` … `5.jpg` (1440x900, Stand Oikos v0.65.6) sind
durch die WebP-Quellen ersetzt.

## Wer aktualisiert den Store

Gemessen am 2026-09-14 läuft der Store über genau einen Weg, unseren Workflow:

- **Unser Workflow.** `.github/workflows/umbrel-publish.yml` läuft auf
  `release: published`, löst den Multi-Arch-Index-Digest auf und bearbeitet die
  Upstream-Dateien **in place** (`version`, `releaseNotes`, `@sha256`), damit
  Review-Anpassungen erhalten bleiben. Das Ergebnis landet per Force-Push auf einem
  langlebigen Branch im Fork. Ist dazu schon ein PR offen, zieht der Lauf nur Titel
  und Body nach (`gh pr edit`); erst wenn Umbrel ihn gemergt hat, öffnet der nächste
  Lauf einen neuen. Die PR-Nummer ist deshalb nicht stabil - suchen statt annehmen:
  `gh pr list --repo getumbrel/umbrel-apps --search yuvomi --state all`. Braucht das
  Secret `UMBREL_FORK_TOKEN` (classic PAT mit `repo`-Scope).
- **Umbrel selbst** hat den Eintrag bis v1.77.0 (2026-08-04) direkt auf `master`
  gebumpt, ohne PR. Seitdem nicht mehr: alle 17 Upstream-Commits an
  `yuvomi/umbrel-app.yml` vom 2026-08-11 bis 2026-09-12 sind gesquashte Merges
  unserer Workflow-PRs (#5972 bis #6079), nachzuzählen mit
  `gh api "repos/getumbrel/umbrel-apps/commits?path=yuvomi/umbrel-app.yml&since=2026-08-10T00:00:00Z"`.

Der Workflow ist damit der Kanal, nicht die Absicherung. Ein nachgetragenes altes
Release schiebt den Store nicht zurück: der Schritt „Refuse to walk the store
backwards" vergleicht beim `release`-Ereignis mit dem höchsten veröffentlichten
stabilen Release und überspringt ältere Versionen. Manueller Fallback, auch für
einen gewollten Rückschritt:
`workflow_dispatch` (optionaler `version`-Input), oder Digest von Hand über
`docker buildx imagetools inspect ghcr.io/ulsklyc/yuvomi:<version>` holen.

**Drei Felder dieses Spiegels laufen zwangsläufig hinterher.** Der Workflow schreibt
nur Upstream, nie diesen Ordner. `version`, das Image-Tag samt Digest und
`releaseNotes` stehen hier deshalb auf dem Stand des letzten Handabgleichs, Upstream
auf dem letzten gemergten Bump; ein `diff` zeigt dort immer Abweichung. Aussagekräftig
sind die übrigen Zeilen (Volumes, Environment, `app_proxy`, `port`, `backupIgnore`):
dort war der Abstand zu Upstream am 2026-09-14 null.

## Warum das Paket so aussieht

- **`app_proxy`** ist Pflicht. `APP_PORT: 3000` ist der Port im Container, das
  Manifest-Feld `port:` ist **8180** (extern; der Linter lehnt Kollisionen ab).
  `PROXY_AUTH_ADD` steht im veröffentlichten Paket **nicht** - Umbrels Proxy-Auth
  ist also aktiv. Der frühere Hinweis, Yuvomis eigenes Login führe zu doppelter
  Anmeldung, gilt für den ausgelieferten Stand nicht mehr; entsprechend ist auch
  der unauthentifizierte Erstlauf-Endpunkt (`POST /api/v1/auth/setup`) nicht mehr
  offen im LAN erreichbar.
- **`SESSION_SECRET=${APP_SEED}`** - Umbrel liefert ein deterministisches
  App-Secret, ein interaktiver Installationsschritt entfällt.
- **`DB_ENCRYPTION_KEY=${APP_SEED}`** - seit v1.53.0 verschlüsselt dieser Schlüssel
  die Datenbank wirklich (vorher war er wirkungslos). Er **darf sich nie ändern**:
  ein anderer Wert macht eine bestehende Datenbank unlesbar. `${APP_SEED}` ist pro
  Installation stabil und erfüllt genau das.
- **`backupIgnore`** hält zwei Dinge aus Umbrels Backup heraus:
  `data/app/yuvomi.db.plaintext-backup*` (die Kopie, die die einmalige
  Verschlüsselungs-Migration unverschlüsselt zurücklässt) und `data/backups/*.db`
  (Yuvomis eigene Dumps, die sonst doppelt gesichert würden).
- **Volumes** liegen unter `${APP_DATA_DIR}/data/app` → `/data` und
  `${APP_DATA_DIR}/data/backups` → `/backups`. Achtung: **nicht** `${APP_DATA_DIR}/data`
  direkt - die Pfade wurden nach der Ersteinreichung umgebaut. Eine Änderung daran
  braucht laut Umbrels Update-Regeln einen idempotenten `hooks/pre-start`, sonst
  starten Bestandsinstallationen auf einem leeren Verzeichnis.
- **Kein Modul-Ordner** (`/app/modules`) - bewusst, entschieden am 2026-09-14. Alle
  anderen Ziele mounten ihn, dieses Paket und Upstream nicht. Ihn nachzutragen hieße
  eine Compose-Änderung mit eigenem Versions-Bump neben dem rollierenden Workflow-PR,
  und nach Drittmodulen auf Umbrel hat niemand gefragt. Drittmodule gibt es auf Umbrel
  deshalb nicht; das steht auch in `MODULES.md` und `docs/installation.md` (Option E).
  Beim `diff` gegen Upstream also keine Drift, die zu beheben wäre.
- **Kein `user:`-Override** - der Entrypoint läuft nur zum Chown als root und wechselt
  per gosu auf den unprivilegierten `node`-User. Der Linter meldet das als Info.
- **`SESSION_SECURE=false`** - Umbrel liefert Apps im LAN über einfaches HTTP aus.
- **`gallery`** ist im veröffentlichten Manifest gefüllt (`1.webp` … `5.webp`). Leer
  bleiben musste sie nur für die Ersteinreichung.

## Regeln von Umbrel, die bei Änderungen gelten

Aus `.claude/skills/umbrel-update-app/` in `getumbrel/umbrel-apps`:

- Bild-Tag **und** Digest immer gemeinsam ändern, Multi-Arch mit amd64 + arm64.
- Wer Compose, Templates oder Images ändert, **muss** die Manifest-`version` erhöhen,
  sonst sehen Bestandsinstallationen kein Update. Umgekehrt gilt: `version` nicht
  allein hochziehen.
- `id` niemals ändern - das ist Identität und Datenpfad.
- Vor dem PR `npm run lint:apps -- yuvomi --check-images` laufen lassen und den
  echten Update-Pfad testen, nicht nur eine Neuinstallation.
- `releaseNotes` sind **knapp und für Endnutzer** geschrieben, mit Link auf die
  vollen Notizen; interne Details, CI- und Docs-Änderungen gehören nicht hinein.
- Der PR-Body nennt alte und neue Version, die Quelle, den Testumfang, die
  geprüften Architekturen und etwaige Breaking Changes.

### Die Release-Notizen werden geschrieben, nicht generiert

`.github/umbrel-release-notes.md` im Hauptrepo enthält den Store-Text für den
nächsten Release, samt Versionsmarke; `umbrel-publish.yml` nimmt ihn wörtlich und
bricht ab, wenn die Marke nicht zur veröffentlichten Version passt.

Bis v2.6.0 hat der Workflow stattdessen den GitHub-Release-Body umgeformt -
Überschriften und Aufzählungszeichen weg, Rest als Prosa. Das war syntaktisch
einwandfrei und inhaltlich falsch: unser CHANGELOG ist für Entwickler geschrieben
(Messwerte, Tokennamen, Selektoren) und stand damit im Update-Dialog eines
Haushalts. Umbrels Maintainer hat den Text vor dem Merge von v2.6.0 von Hand
ersetzt und gebeten, künftig ihre `AGENTS.md` zu befolgen (Kommentar an PR #5980).
Die Anleitung dafür steht im Kopf der Datei; **release-prep schreibt sie vor dem
Tag**, nicht danach - der Workflow läuft beim Veröffentlichen des Releases.

## Lokal testen

umbrelOS läuft in Docker, Hardware ist nicht nötig:

```bash
docker run -it --rm --name umbrel --pid=host -p 80:80 \
  -v "${PWD:-.}/umbrel:/data" \
  -v "/var/run/docker.sock:/var/run/docker.sock" \
  --stop-timeout 60 docker.io/dockurr/umbrel
```

Dann <http://localhost> öffnen, Onboarding abschließen und Yuvomi über einen
temporären Community App Store einspielen:

1. Öffentliches Wegwerf-Repo mit diesem Aufbau anlegen:
   ```
   umbrel-app-store.yml       # id: yuvomi-test, name: Yuvomi Test
   yuvomi/umbrel-app.yml      # Kopie des Manifests aus diesem Ordner
   yuvomi/docker-compose.yml  # Kopie der Compose aus diesem Ordner
   ```
2. In umbrelOS → App Store → „Community App Stores" die Repo-URL hinzufügen.
3. Installieren, ersten Account anlegen, App **neu starten** und prüfen, dass
   Kalender-/Aufgaben-/Budgetdaten erhalten bleiben.
