# Pflege des TrueNAS-Katalogeintrags

Die Dateien neben dieser hier sind ein **wortgleicher Spiegel** von
`ix-dev/community/yuvomi/` in [`truenas/apps`](https://github.com/truenas/apps).
Wortgleich ist Absicht: nur so zeigt ein `diff` gegen Upstream, was wirklich
auseinanderläuft. Prozesswissen gehört deshalb in diese Datei und nicht in
`README.md` - die ist der Katalogtext und muss dem Upstream-Stand entsprechen.

## Wo geändert wird

`trains/` in `truenas/apps` ist **generiert und darf nicht bearbeitet werden**
(steht so in deren `CONTRIBUTIONS.md`). Jede Änderung geht nach
`ix-dev/community/yuvomi/`; die CI baut daraus den Train-Eintrag.

Ein Config-PR umfasst je nach Änderung:

| Datei | wofür |
|---|---|
| `questions.yaml` | Installationsformular (Gruppen, Ports, Storage, Secrets) |
| `templates/docker-compose.yaml` | Jinja2-Rendering des Containers |
| `templates/test_values/basic-values.yaml` | Werte für deren CI-Render-Test |
| `item.yaml` | Kategorien, Icon-/Screenshot-URLs, Tags |
| `app.yaml` / `ix_values.yaml` | Chart-Version, `app_version`, Image-Tag |

`app.yaml` und `ix_values.yaml` spiegeln wir bewusst **nicht**: sie tragen die
Chart-Version, die TrueNAS bei jedem Bump selbst hochzählt. Ein Spiegel davon
wäre binnen Tagen falsch.

Nach einer Strukturänderung an `questions.yaml` verlangt deren Anleitung
zusätzlich `app_migrations.yaml` plus Migrationsskript, damit Bestandsinstallationen
ihre Werte behalten.

## Abgleich mit Upstream

Seit dem 2026-09-14 ist der Spiegel mit `ix-dev/community/yuvomi/` byte-identisch
(`questions.yaml`, `templates/docker-compose.yaml`,
`templates/test_values/basic-values.yaml`, `item.yaml`). Bis dahin fehlte hier der
`modules`-Speicher (`/app/modules`) samt zwei Tippfehler-Korrekturen, und
`questions.yaml` trug lokal eine `description` zur Zeitzonen-Frage, die mit dem
Release-Commit von v2.34.0 hinzukam und Upstream nie erreicht hat. Sie ist
zurückgenommen: TrueNAS-Nutzer sehen ohnehin nur den Katalog, und was sie sagte,
steht für alle Ziele in `docs/installation.md` (Variable `TZ`).

Nachprüfen je Datei:

```bash
gh api repos/truenas/apps/contents/ix-dev/community/yuvomi/questions.yaml --jq .content | base64 -d | diff - deploy/truenas/questions.yaml
```

### Offen gegen Upstream: die optionalen Secrets (#2507)

Seit v2.85.0 erzeugt der Server `SESSION_SECRET` und `DB_ENCRYPTION_KEY` beim
ersten Start selbst, wenn beide leer sind. `questions.yaml` verlangte
`session_secret` aber weiter (`required: true`), fragte also nach etwas, das
niemand mehr setzen muss. Hier geändert am 2026-11-04:

- `session_secret`: `required: true` → `default: ""`, Beschreibung wie die von
  `db_encryption_key`.
- `templates/docker-compose.yaml`: `SESSION_SECRET` wird nur noch gesetzt, wenn
  ein Wert da ist (`{% if %}`, genau wie `db_encryption_key` eine Zeile darunter).
  Ein leerer Wert gilt dem Server zwar als ungesetzt (Test in
  `test/test-auto-secrets.js`), aber die Variable gar nicht zu setzen ist das,
  was `db_encryption_key` schon tut.
- `db_encryption_key`: nur die **Beschreibung** neu formuliert. Sie sagt jetzt,
  dass der Server bei einer neuen Installation selbst einen Schlüssel erzeugt,
  dass ein leeres Feld auf einer bereits verschlüsselten Datenbank *keinen*
  neuen erzeugt (der Start wird abgewiesen, `server/db.js:647-660`), und sie
  verweist für `DB_ENCRYPTION_AUTO_KEY=false` auf *Additional Environment
  Variables* statt auf ein Feld „below", das es im Formular nie gab. Label,
  Name, Pfad und Schema bleiben unverändert.

`min_length: 16` ist bei `session_secret` **absichtlich weggefallen** und nicht
wieder eingebaut: ob TrueNAS die Prüfung auf den leeren Default anwendet, lässt
sich von hier aus nicht feststellen, und tut es das, wäre das Feld wieder
Pflicht - genau das, was dieser Change aufhebt. Damit ist TrueNAS so streng wie
jeder andere Weg: der Server prüft die Länge nirgends, er weist nur den
veröffentlichten Platzhalter ab (`server/auth.js:359`). Eine echte Mindestlänge
gehört serverseitig in einen eigenen Change, nicht in einen Deskriptor.

**Alle drei brauchen einen Upstream-PR, bis dahin zeigt der `diff` genau diese
Abweichungen.** Eine `app_migrations.yaml` ist nicht nötig: Name und Pfad der Frage
bleiben, Bestandsinstallationen behalten ihren gesetzten Wert, es entfällt nur die
Pflichtprüfung des Formulars.

## Namensraum: `yuvomi`, nicht `oikos`

Anders als beim ghcr-Image, dem Quadlet und der Datenbank ist der TrueNAS-Eintrag
**vollständig umbenannt**. Upstream existieren zwei Einträge:

- `community/oikos` - Titel „Oikos (Deprecated)", eingefroren
- `community/yuvomi` - der aktive Eintrag

Entsprechend heißen dort der Fragen-Block `yuvomi:`, die Konstante
`consts.yuvomi_container_name` und die Medien-URLs `apps/yuvomi/...`. Das ist
keine Verletzung der „Legacy-Slugs bleiben oikos"-Regel: Bestandsinstallationen
hängen am deprecateten `oikos`-Eintrag und werden davon nicht berührt.

## Versions-Bumps: nicht unsere Aufgabe, und keine PRs

TrueNAS zieht neue Versionen mit einem eigenen Bot und hat ausdrücklich darum
gebeten, **dafür keine Pull Requests zu öffnen**. Das gilt auch dann, wenn der
Katalog sichtbar hinterherhängt - zeitweise lag dort eine `app_version` viele
Minor-Versionen hinter dem aktuellen Release, und ein Bot-PR wie
[truenas/apps#5494](https://github.com/truenas/apps/pull/5494) („yuvomi: update to
1.71.0") kann tagelang mergebar herumliegen. Beides ist deren Warteschlange,
nicht unser Rückstand.

Der Rückstand ist damit kein Handlungsauftrag, sondern höchstens ein Grund
nachzufragen. Nichts von unserer Seite pushen.

Für eine echte **Config**-Änderung (neues Pflicht-Secret, Port, Volume) gilt das
Bot-Argument nicht - die propagiert er nicht. Auch hier aber erst mit den
Maintainern klären, statt ungefragt einen PR aufzumachen.
