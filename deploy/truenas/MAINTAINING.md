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
