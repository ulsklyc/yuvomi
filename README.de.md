<div align="center">
  <img src="docs/logo.svg" alt="" width="92" />

  <h1>Yuvomi</h1>

  <p><strong>Ein privates Zuhause für alles, was einen Haushalt am Laufen hält.</strong></p>

  <p>
    Aufgaben, Kalender, Budget, Einkauf, Mahlzeiten, Gesundheit und mehr - für eine Familie,
    ein Paar oder nur dich. Zwanzig Module für einen Haushalt von bis zu sechs Personen, auf
    einem Server, der dir gehört, und das Einzige, was ihn verlässt, ist eine Versionsprüfung.
  </p>

  <p>
    <a href="https://github.com/ulsklyc/yuvomi/releases"><img src="https://img.shields.io/github/v/release/ulsklyc/yuvomi?style=flat-square&color=6C3AED&label=release" alt="Neuestes Release"></a>
    <a href="https://github.com/ulsklyc/yuvomi/stargazers"><img src="https://img.shields.io/github/stars/ulsklyc/yuvomi?style=flat-square&color=6C3AED&label=stars" alt="GitHub-Sterne"></a>
    <a href="https://github.com/ulsklyc/yuvomi/pkgs/container/yuvomi"><img src="https://img.shields.io/badge/ghcr.io-yuvomi-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker-Image"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT-Lizenz"></a>
  </p>

  <p>
    <a href="#installieren"><strong>→ In Minuten installieren</strong></a> &nbsp;·&nbsp;
    <a href="https://yuvomi.cloud/"><strong>Screenshots &amp; Rundgang</strong></a> &nbsp;·&nbsp;
    <a href="#dokumentation"><strong>Doku</strong></a> &nbsp;·&nbsp;
    <a href="CHANGELOG.md"><strong>Changelog</strong></a>
  </p>

  <sub>Die englische Fassung (<a href="README.md">README.md</a>) ist die maßgebliche; diese Übersetzung folgt ihr.</sub>

  <br><br>

  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/de/dashboard-dark-web.webp">
    <img src="docs/screenshots/de/dashboard-light-web.webp" alt="Das Yuvomi-Dashboard: Aufgaben, Termine, Mahlzeiten und Einkaufsliste des Tages auf einem Bildschirm" width="820">
  </picture>

  <sub><b>20</b> Module &nbsp;·&nbsp; <b>24</b> Sprachen &nbsp;·&nbsp; <b>0</b> Tracker &nbsp;·&nbsp; optionale <b>AES-256</b>-Datenbankverschlüsselung &nbsp;·&nbsp; <b>MIT</b></sub>
</div>

Die meisten Haushalte kleben ihren Alltag aus einem Dutzend Bezahl-Apps zusammen, jede mit eigenem
Konto, eigenem Abo und einer eigenen Kopie deiner Daten auf fremden Servern. Yuvomi bringt das alles
an einen Ort, der dir gehört, als Container auf jedem Home-Server oder NAS. Jedes Modul ist
eigenständig - nutze, was passt, und schalte ab, was nicht passt.

---

## Eine App statt einem Dutzend Abos

| Statt zu jonglieren mit… | gibt dir Yuvomi |
|---|---|
| einer To-do- &amp; Aufgaben-App | **Aufgaben** - Kanban, Fristen, Wiederholungen, Mehrfachzuweisung |
| einem Abo für den geteilten Kalender | **Kalender** - Sync, Abos, Sichtbarkeit je Termin |
| einer App fürs Kostenteilen | **Gemeinsame Ausgaben** - geteilte Kosten mit Schuldenvereinfachung |
| einer Budget-App | **Budget** - Einnahmen, Ausgaben, Konten, Sparziele |
| einer Essensplaner- &amp; Rezept-App | **Mahlzeiten &amp; Rezepte** - Wochenplaner mit Einkaufsexport |
| einer Einkaufslisten-App | **Einkauf** - geteilte, nach Gang sortierte Listen |
| einem Vorrats- und Ablauf-Tracker | **Vorrat** - Bestand, Lagerort, Mindesthaltbarkeit |
| einem Dokumentenmanager | **Dokumente** - getaggte, durchsuchbare Familiendateien |
| einer Hausinventar-App | **Inventar** - Besitz, Kaufpreis, Garantie, verknüpfte Belege |
| einer Notiz-App &amp; Kontakte-Sync | **Notizen &amp; Kontakte** - Markdown-Notizen, CardDAV-Sync |

## Die Module reden miteinander

Das ist der Teil, den ein Ordner voller Einzel-Apps nicht kann:

- **Der Wochenplan schreibt die Einkaufsliste.** Donnerstag geplant, und die Zutaten stehen auf der Liste, bevor jemand losgeht.
- **Das letzte Glas aus dem Vorrat steht schon auf der Liste.** Was nach dem Einkauf abgehakt ist, bucht sich mit Menge und Einheit zurück in den Vorrat.
- **Eine erledigte Aufgabe zahlt aus.** Punkte auf einer Aufgabe landen auf dem Konto der zugewiesenen Person, und der Belohnungskatalog gibt sie aus.
- **Ein abgelegter Beleg hängt an der Buchung.** Einmal hochgeladen, gehört er gleichzeitig zur Buchung, zur geteilten Ausgabe und zum Inventargegenstand.

## Die zwanzig Module

Schalte an, was dein Haushalt braucht; der Rest bleibt aus dem Weg.

| Modul | In einer Zeile |
|---|---|
| **Aufgaben** | Kanban-Board mit Fristen, Prioritäten, Unteraufgaben, Tags, Wiederholungen und Mehrfachzuweisung. Dokumente anhängen und in Kommentaren besprechen. Ein Verlauf zeigt nach Tagen, was erledigt wurde und wer abgehakt hat - und wann eine wiederkehrende Aufgabe zuletzt dran war. Eine Aufgabe lässt sich sperren, sodass nur Ersteller:in und Admins sie umschreiben, alle anderen sie aber weiter abhaken können. |
| **Einkauf** | Geteilte Listen nach Gang gruppiert und in der Reihenfolge deines Ladens, mit Wischgesten und Ein-Tipp-Import aus dem Essensplan. Schick die Liste per E-Mail an den, der einkaufen geht. |
| **Mahlzeiten** | Wochenplaner per Drag-and-drop mit Rezept-Seitenleiste und direktem Export in die Einkaufsliste. |
| **Rezepte** | Rezepte anlegen, duplizieren und skalieren, Mahlzeiten damit vorbelegen oder die Zutaten auf eine Einkaufsliste schicken. Eine Mealie- oder Tandoor-Instanz lässt sich lesend spiegeln. |
| **Vorrat** | Was wirklich im Haus ist: Menge, Lagerort und Mindesthaltbarkeit, mit Filtern für Ablauf und knappe Bestände und einer Meldung, bevor ein Datum erreicht ist. |
| **Kalender** | Zwei-Wege-Sync mit Google und CalDAV, einseitiger Outlook-Push via Microsoft Graph, Kalender-Abos, Wiederholungen, Feiertage, Filter nach Person und Sichtbarkeit je Termin. |
| **Dokumente** | Familiendateien hochladen, taggen, ansehen und ordnen, optional auf WebDAV oder Google Drive. |
| **Inventar** | Was dir gehört: Kaufpreis, Garantie, Zustand und Lagerort, mit verknüpften Belegen und Erinnerungen vor Fristablauf. Standardmäßig aus; Haushalte schalten es an. |
| **Budget** | Einnahmen, Ausgaben, Konten, Darlehen, Abos und Planung je Kategorie, mit persönlichem Modus. Ein Eintrag kann seinen Betrag teilen und Titel und Kategorie für sich behalten, damit der Stand eines geteilten Kontos stimmt. |
| **Hauswirtschaft** | Haushaltshilfen: Dienstpläne, Ein- und Ausstempeln, Tages- oder Stundenabrechnung, Aufgaben und Materialwünsche. |
| **Entsorgung** | Wöchentliche oder feste monatliche Abholtermine je Abfallart, mit Einzelterminen und Verschieben oder Ausfallenlassen je Termin. Standardmäßig aus. |
| **Belohnungen** | Punkte auf Aufgaben schreiben der zugewiesenen Person gut, mit elterlich freigegebenem Katalog und nachvollziehbarem Konto. |
| **Gesundheit** | Vitalwerte, Medikamente, Laborwerte, Aktivität und Zyklus je Mitglied, mit Verlaufsdiagrammen. |
| **Schichtplan** | Rotierende Schichtmuster und feste Wochenpläne aus einem Zyklusmodell, mit Ausnahmen je Tag und einem ausdrücklichen freien Tag. Der Kalender zeigt sie als schreibgeschützte Ebene, beim Lesen berechnet - eine Musteränderung lässt keine veralteten Termine zurück. Standardmäßig aus. |
| **Notizen &amp; Kontakte** | Farbige Markdown-Haftnotizen mit Checklisten, die man antippt statt zu bearbeiten, plus ein Kontaktverzeichnis mit CardDAV-Sync und vCard-Import/-Export. |
| **Geburtstage** | Geburtstagsliste mit optionalen Namenstagen, automatischen Kalendereinträgen, Altersanzeige und Erinnerungen. |
| **Familie** | Mitgliedsprofile mit Rollen, Fotos und Kontaktdaten. Neue Mitglieder kommen über einen Einladungslink und wählen ihr Passwort selbst. |
| **Erinnerungen** | Erinnerungen an Aufgaben, Termine, Abo-Verlängerungen, Garantien, Inventar-Fristen und Mindesthaltbarkeit, per In-App-Kennzeichen, optionalem Push und Gotify-, ntfy-, Webhook- oder E-Mail-Kanälen des Haushalts. Eine Erinnerung an einem geteilten Termin erreicht alle Zugewiesenen, jeden mit einer eigenen Kopie zum Verschieben oder Verwerfen. |
| **API-Token** | Bearer- / X-API-Key-Token mit OpenAPI-3.0-Spezifikation und eingebautem MCP-Endpunkt für KI-Agenten. Schreibende Aufrufe sind über einen optionalen `Idempotency-Key`-Header wiederholbar. |
| **Backup** | Manuelle und geplante Sicherung und Wiederherstellung mit Rollback davor und optionalem Cloud-Upload. |

Zwei Dinge gibt es nur auf dem eigenen Server: der **Wandmodus** macht aus dem Küchen-Tablet eine
Anzeige, die man quer durch den Raum liest, und ein **Immich-Bildschirmschoner** lässt die eigenen
Fotos laufen, wenn der Bildschirm still steht. Jedes Modul im Detail steht in der
[Spezifikation](docs/SPEC.md); wie du ein eigenes Modul einhängst - mit eigenen
Dashboard-Widgets, Rechten und Übersetzungen -, steht im [Modulhandbuch](MODULES.md).

---

## Installieren

- **Image** - `ghcr.io/ulsklyc/`<wbr>`yuvomi:latest`, rund 500 MB.
- **Braucht** - 256 MB RAM und einen Port, standardmäßig 3000.
- **Schreibt** - vier Volumes, die dir gehören: Daten, Backups, Module, Dokumente.
- **Nach außen** - eine Update-Abfrage an die GitHub-Releases-API, sonst nichts. Blockier sie, und es geht nichts verloren: der Änderungsverlauf liest dann den Stand, der mit deiner Installation ausgeliefert wurde, nur der Hinweis auf eine neuere Version bleibt aus. Wetter, Kalender-Sync und Cloud-Backup bleiben aus, bis du Zugangsdaten einträgst.
- **Deine Daten** - eine SQLite-Datei unter `/data/yuvomi.db`. Sie zu kopieren ist der ganze Export, solange der Dokumentenspeicher nicht auf einem Ordner, WebDAV oder Drive liegt; diese Dateien brauchen dann eine eigene Sicherung.

### Docker oder Podman

```bash
curl -O https://raw.githubusercontent.com/ulsklyc/yuvomi/main/docker-compose.yml
curl -O https://raw.githubusercontent.com/ulsklyc/yuvomi/main/.env.example
cp .env.example .env
# zwei Werte: einer für SESSION_SECRET, einer für DB_ENCRYPTION_KEY
openssl rand -hex 32
openssl rand -hex 32
```

> **Öffne jetzt `.env` und ersetze beide `REPLACE_WITH_…`-Platzhalter** durch die zwei eben
> erzeugten Werte. Ist eine Datenbank einmal verschlüsselt, öffnet ein verlorener oder geänderter
> Schlüssel sie nie wieder, weder für dich noch für uns - schreib den Wert also auf. Ohne
> Verschlüsselung: die Zeile leeren statt sie zu füllen.

```bash
docker compose up -d
```

Öffne `http://localhost:3000`. Der erste Besuch führt dich durch das Anlegen des Admin-Kontos.

Unter Podman nimmst du oben `podman-compose.yml` statt `docker-compose.yml` und startest mit
`podman compose -f podman-compose.yml up -d`; darin stecken die SELinux-`:Z`-Labels, die RHEL,
Fedora und CentOS Stream brauchen. Beide Installationswege erkennen Podman von selbst.

### Geführte Einrichtung

Ein Einrichtungsassistent im Browser, in 24 Sprachen. Er erkennt Docker oder Podman, richtet HTTPS,
Single Sign-on und geplante Backups ein, startet dann den Container und legt dein Admin-Konto an.

```bash
git clone https://github.com/ulsklyc/yuvomi.git && cd yuvomi
node tools/installer/install-server.js
```

Öffne **http://localhost:8090**. Braucht Node.js 18+ auf dem Host; der Container bringt sein eigenes Node 22 mit.

### Aus dem App-Store deines NAS

**TrueNAS SCALE**, **Umbrel** und **Unraid** führen Yuvomi alle: im Katalog suchen und installieren,
ganz ohne Terminal. Neu bei Containern? Die
**[Installationsanleitung](docs/installation.md)** führt Schritt für Schritt durch Engine, HTTPS,
Backups und Fehlersuche.

<details>
<summary><b>Lesenswert, bevor du live gehst</b></summary>

<br>

> **Gesundheit ist kein Medizinprodukt.** Es werden keine diagnostischen Aussagen getroffen. Gesundheitsdaten sind sensibel - aktiviere die Datenbankverschlüsselung (`DB_ENCRYPTION_KEY`, SQLCipher).

> **Externer Dokumentenspeicher braucht eine eigene Sicherung.** Datenbank-Backups enthalten Metadaten und Verknüpfungen, nicht die Dateien selbst, wenn sie in einem lokalen Ordner, auf WebDAV oder in Google Drive liegen; sichere das gewählte Ziel separat. Yuvomis Sichtbarkeitseinstellungen regeln nur den Zugriff über Yuvomi. Wer Zugriff auf den verbundenen Google-Drive-Ordner `Yuvomi/Documents` hat, sieht alle dort abgelegten Dateien.

> **Interne Ziele (LAN / private IP) sind standardmäßig blockiert.** Der serverseitige Anfrageschutz weist private, Loopback-, Link-Local- und intern auflösende URLs für Kalender-Abos, WebDAV-Dokumentenspeicher und Rezept-Spiegel ab. Für eine intern auflösende URL setzt du das passende Opt-in in deiner Deployment-Umgebung. Siehe [Installationsanleitung](docs/installation.md#environment-variables).

> **Manche Katalog-Slugs tragen weiter den alten Namen `oikos`** (z. B. Unraid `oikos-…`). Die App heißt und installiert sich überall als Yuvomi; wo der technische Slug `oikos` bleibt, bleibt er, damit bestehende Installationen nahtlos aktualisieren. Suche nach **Yuvomi**; taucht in einem Store noch ein Eintrag als *oikos* auf, ist das dieselbe App.

</details>

---

## Bevor du dich festlegst

**Was, wenn dieses Projekt aufhört?** Auf deiner Maschine ändert sich nichts. Yuvomi ist
MIT-lizenziert und selbstgehostet, auf dem Weg steht kein Server von uns, und das Einzige, was deine
Maschine verlässt, ist eine Versionsprüfung gegen die GitHub-Releases-API. Der Container, den du
schon geholt hast, läuft weiter wie heute, mit uns oder ohne uns.

**Was, wenn du deine Daten woanders haben willst?** Eine Datei zu kopieren ist der ganze Export,
solange die Dokumente in der Datenbank liegen. Alles Übrige steht in dieser einen SQLite-Datei auf
deiner eigenen Platte. Geplante Backups schreiben
zusätzlich ein wiederherstellbares Archiv, und die dokumentierte API holt alles in der Form heraus,
die du brauchst.

**Was kostet es?** Nichts. Yuvomi ist kostenlos und MIT-lizenziert. Du stellst den Server; es gibt
kein Abo, keinen Upsell und keine Bezahlstufe.

---

## Unter der Haube

- **Kein Build-Schritt** - reine ES-Module und einfaches CSS. Kein Bundler, kein Transpiler, kein Framework, kein CDN zur Laufzeit.
- **Apple HIG in der Liquid-Glass-Sprache** - Systemschrift und Apples Typoskala, Kapsel-Bedienelemente, eingerückte Listengruppen und federnde Bewegung, in Hell und Dunkel gegen WCAG AA geprüft.
- **Privatsphäre zuerst** - vollständig selbstgehostet, optionale SQLCipher-AES-256-Datenbankverschlüsselung, keine Telemetrie.
- **Anmeldung für einen ganzen Haushalt** - optionale Zwei-Faktor-Anmeldung (TOTP mit Wiederherstellungscodes, auf Wunsch für alle verpflichtend), optionales Single Sign-on über jeden OIDC-Anbieter (mit einem Schalter dafür, ob eine unbekannte Identität ein Konto bekommt - ein Anbieter, der mehr als diesen Haushalt bedient, reicht damit nicht jedem einen Zugang - und einem zweiten dafür, SSO zum einzigen Weg hinein zu machen), Einladungslinks statt weitergereichter Passwörter und optionaler Self-Service-Passwort-Reset per E-Mail.
- **24 Sprachen** mit automatischer Erkennung. Eine eigene Haushaltseinstellung bestimmt die Sprache der Einträge, die Yuvomi selbst anlegt - so spricht ein exportierter Kalender die Sprache deines Haushalts statt Englisch.

<p align="center">
  <img src="https://img.shields.io/badge/Express-000000?style=flat-square&logo=express&logoColor=white" alt="Express">
  <img src="https://img.shields.io/badge/SQLite%20%2F%20SQLCipher-003B57?style=flat-square&logo=sqlite&logoColor=white" alt="SQLite / SQLCipher">
  <img src="https://img.shields.io/badge/Vanilla_JS_(ES_Modules)-F7DF1E?style=flat-square&logo=javascript&logoColor=black" alt="Vanilla JS">
  <img src="https://img.shields.io/badge/Plain_CSS-1572B6?style=flat-square&logo=css3&logoColor=white" alt="Plain CSS">
  <img src="https://img.shields.io/badge/Node.js-%E2%89%A522-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js 22 oder neuer">
  <img src="https://img.shields.io/badge/Docker-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker">
  <img src="https://img.shields.io/badge/Podman-892CA0?style=flat-square&logo=podman&logoColor=white" alt="Podman">
  <img src="https://img.shields.io/badge/PWA-5A0FC8?style=flat-square&logo=pwa&logoColor=white" alt="PWA">
</p>

---

## Dokumentation

[Installation](docs/installation.md) &nbsp;·&nbsp; [Spezifikation &amp; Datenmodell](docs/SPEC.md) &nbsp;·&nbsp; [Fremdmodule](MODULES.md) &nbsp;·&nbsp; [Benachrichtigungs-Webhooks](docs/notification-webhooks.md) &nbsp;·&nbsp; [Immich-Bildschirmschoner](docs/immich-screensaver.md) &nbsp;·&nbsp; [Mitwirken](CONTRIBUTING.md) &nbsp;·&nbsp; [Veröffentlichen](docs/RELEASING.md) &nbsp;·&nbsp; [Sicherheit](SECURITY.md) &nbsp;·&nbsp; [Changelog](CHANGELOG.md) &nbsp;·&nbsp; [Backlog](BACKLOG.md) &nbsp;·&nbsp; [Rahmen](docs/SCOPE.md) &nbsp;·&nbsp; [Entscheidungen](docs/DECISIONS.md) &nbsp;·&nbsp; [Roadmap](docs/ROADMAP.md)

**Nutzerhandbuch (aus der Community):** @Kyrodan schreibt eine [Nutzerdokumentation](https://kyrodan.github.io/yuvomi-docs/)
in seinem eigenen Repository. Sie gehört nicht zu diesem Projekt und kann hinter einem Release
zurückliegen; wo sie und die Quellen oben sich widersprechen, gelten die oben.

Wenn du Yuvomi im DSGVO-Kontext betreibst (EU/EWR, Verarbeitung fremder Daten), lies vorher
[Datenschutz für Selfhoster](docs/PRIVACY-FOR-SELFHOSTERS.md). Dort stehen Drittlandsbewertungen für
jeden externen Dienst, Hinweise zur Auftragsverarbeitung, Empfehlungen zur Log-Aufbewahrung und eine
Vorlage für das Verarbeitungsverzeichnis.

<details>
<summary>Kommst du von <b>Oikos</b>? Das Projekt wurde umbenannt, an der App ändert sich nichts.</summary>

<br>

Yuvomi wurde von **Oikos** umbenannt, um einen Markenkonflikt mit einem unabhängigen Produkt zu vermeiden. Gleicher Code, gleiche Daten, gleicher Maintainer.

- Alte Links (`github.com/ulsklyc/oikos`) leiten automatisch hierher weiter.
- Das Docker-Image liegt jetzt unter `ghcr.io/ulsklyc/yuvomi`; das alte `ghcr.io/ulsklyc/oikos` funktioniert weiter, du kannst also in Ruhe umstellen.
- Bestehende Daten und Einstellungen bleiben beim Update vollständig erhalten.

</details>

---

<div align="center">
  <br>
  <h3>Hol dir die Daten deiner Familie zurück.</h3>
  <p>
    Einmal installiert, und danach gehört es dir. Kein Konto bei uns,<br>
    kein Abo, und nichts von uns zwischen deinem Haushalt und seinen Daten.
  </p>
  <p>
    <a href="#installieren"><strong>→ In Minuten installieren</strong></a> &nbsp;·&nbsp;
    <a href="https://github.com/ulsklyc/yuvomi/discussions"><strong>Frag nach</strong></a>
  </p>
  <br>
  <sub>MIT-lizenziert, siehe <a href="LICENSE">LICENSE</a>.</sub>
</div>
