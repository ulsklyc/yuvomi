<div align="center">
  <img src="docs/logo.svg" alt="" width="92" />

  <h1>Yuvomi</h1>

  <p><strong>Ein privates Zuhause für alles, was einen Haushalt am Laufen hält.</strong></p>

  <p>
    Aufgaben, Kalender, Budget, Einkauf, Mahlzeiten, Gesundheit und mehr - für eine Familie,
    ein Paar oder nur dich. Zwanzig Module für einen Haushalt, meist zwei bis sechs Personen, auf
    einem Server, der dir gehört, und ab Werk ist das Einzige, was ihn verlässt, eine Versionsprüfung.
  </p>

  <p>
    <a href="https://github.com/ulsklyc/yuvomi/releases"><img src="https://img.shields.io/github/v/release/ulsklyc/yuvomi?style=flat-square&color=6C3AED&label=release" alt="Neuestes Release"></a>
    <a href="https://github.com/ulsklyc/yuvomi/stargazers"><img src="https://img.shields.io/github/stars/ulsklyc/yuvomi?style=flat-square&color=6C3AED&label=stars" alt="GitHub-Sterne"></a>
    <a href="https://github.com/ulsklyc/yuvomi/pkgs/container/yuvomi"><img src="https://img.shields.io/badge/ghcr.io-yuvomi-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker-Image"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT-Lizenz"></a>
  </p>

  <p>
    <a href="#installieren"><strong>→ In Minuten installieren</strong></a>&nbsp;&nbsp;·&nbsp;
    <a href="https://yuvomi.cloud/"><strong>Screenshots &amp; Rundgang</strong></a>&nbsp;&nbsp;·&nbsp;
    <a href="#dokumentation"><strong>Doku</strong></a>&nbsp;&nbsp;·&nbsp;
    <a href="CHANGELOG.md"><strong>Changelog</strong></a>
  </p>

  <sub>Die englische Fassung (<a href="README.md">README.md</a>) ist die maßgebliche; diese Übersetzung folgt ihr.</sub>

  <br><br>

  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/de/dashboard-dark-web.webp">
    <img src="docs/screenshots/de/dashboard-light-web.webp" alt="Das Yuvomi-Dashboard: Aufgaben, Termine, Mahlzeiten und Einkaufsliste des Tages auf einem Bildschirm" width="820">
  </picture>

  <sub><b>20</b> Module&nbsp;&nbsp;·&nbsp; <b>24</b> Sprachen&nbsp;&nbsp;·&nbsp; <b>0</b> Tracker&nbsp;&nbsp;·&nbsp; optionale&nbsp;<b>AES&#8209;256</b>&#8209;Datenbankverschlüsselung&nbsp;&nbsp;·&nbsp; <b>MIT</b></sub>
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
| **Aufgaben** | Kanban-Board mit Fristen, Unteraufgaben, Wiederholungen, Kommentaren und einem Verlauf, wer was abgehakt hat. |
| **Einkauf** | Geteilte Listen nach Gang sortiert, mit Wischgesten und Ein-Tipp-Import aus dem Essensplan. |
| **Mahlzeiten** | Wochenplaner per Drag-and-drop mit Rezept-Seitenleiste und direktem Export in die Einkaufsliste. |
| **Rezepte** | Rezepte anlegen und skalieren, Mahlzeiten vorbelegen oder eine Mealie- oder Tandoor-Instanz lesend spiegeln. |
| **Vorrat** | Menge, Lagerort und Mindesthaltbarkeit, mit einer Erinnerung, bevor etwas abläuft. |
| **Kalender** | Zwei-Wege-Sync mit Google und CalDAV, Outlook-Push, Kalender-Abos, Feiertage und Sichtbarkeit je Termin. |
| **Dokumente** | Getaggte, durchsuchbare Familiendateien in Ordnern, lokal, auf WebDAV oder in Google Drive. |
| **Inventar** | Was dir gehört, mit Kaufpreis, Garantie, verknüpften Belegen und Erinnerungen vor Fristablauf. Standardmäßig aus. |
| **Budget** | Einnahmen, Ausgaben, Konten, Darlehen, Abos und gemeinsame Ausgaben mit Schuldenvereinfachung. |
| **Hauswirtschaft** | Haushaltshilfen: Dienstpläne, Ein- und Ausstempeln, Abrechnung, Aufgaben und Materialwünsche. |
| **Entsorgung** | Abholtermine je Abfallart, auch „der letzte Freitag", oder ein abonnierter kommunaler ICS-Kalender. Standardmäßig aus. |
| **Belohnungen** | Punkte aus Aufgaben, ein elterlich freigegebener Katalog und ein nachvollziehbares Konto. |
| **Gesundheit** | Vitalwerte, Medikamente, Laborwerte, Aktivität und Zyklus je Mitglied, mit Verlaufsdiagrammen. |
| **Schichtplan** | Rotierende Schichten und feste Wochenpläne, als Ebene im Kalender eingeblendet. Standardmäßig aus. |
| **Notizen &amp; Kontakte** | Markdown-Haftnotizen mit antippbaren Checklisten, dazu Kontakte mit CardDAV-Sync und vCard-Import/-Export. |
| **Geburtstage** | Geburtstage und optionale Namenstage, mit Kalendereinträgen, Alter und Erinnerungen. |
| **Familie** | Mitgliedsprofile mit Rollen und Einladungslinks, über die neue Mitglieder ihr Passwort selbst wählen. |
| **Erinnerungen** | An Aufgaben, Termine, Garantien, Mindesthaltbarkeit und Abfuhr - in der App, per Push, Gotify, ntfy, Webhook oder E-Mail. |
| **API-Token** | Bearer-Token mit OpenAPI-3.0-Spezifikation und eingebautem MCP-Endpunkt für KI-Agenten. |
| **Backup** | Manuelle und geplante Sicherungen mit Rollback vor dem Wiederherstellen und optionalem Cloud-Upload. |

Zwei Dinge gibt es nur auf dem eigenen Server: der **Wandmodus** macht aus dem Küchen-Tablet eine
Anzeige, die man quer durch den Raum liest, und ein **Immich-Bildschirmschoner** lässt die eigenen
Fotos laufen, wenn der Bildschirm still steht. Jedes Modul im Detail steht in der
[Spezifikation](docs/SPEC.md); wie du ein eigenes Modul einhängst - mit eigenen
Dashboard-Widgets, Rechten und Übersetzungen -, steht im [Modulhandbuch](MODULES.md).

---

## Bevor du dich festlegst

**Was, wenn dieses Projekt aufhört?** Auf deiner Maschine ändert sich nichts. Yuvomi ist
MIT-lizenziert und selbstgehostet, und auf dem Weg steht kein Server von uns. Der Container, den du
schon geholt hast, läuft weiter wie heute, mit uns oder ohne uns.

**Was, wenn du deine Daten woanders haben willst?** Alles liegt in einer SQLite-Datei auf deiner
eigenen Platte, und sie zu kopieren ist der ganze Export, solange die Dokumente in der Datenbank
liegen. Geplante Backups schreiben zusätzlich ein wiederherstellbares Archiv, und die dokumentierte
API holt alles in der Form heraus, die du brauchst.

**Was kostet es?** Nichts. Yuvomi ist kostenlos und MIT-lizenziert. Du stellst den Server; es gibt
kein Abo, keinen Upsell und keine Bezahlstufe.

---

## Installieren

Such dir deinen Weg aus: [Docker oder Podman](#docker-oder-podman) für volle Kontrolle, die
[geführte Einrichtung](#geführte-einrichtung) im Browser oder den
[App-Store deines NAS](#aus-dem-app-store-deines-nas) ganz ohne Terminal.

- **Image** - `ghcr.io/ulsklyc/`<wbr>`yuvomi:latest`, rund 500 MB.
- **Braucht** - 256 MB RAM und einen Port, standardmäßig 3000.
- **Schreibt** - vier Volumes, die dir gehören: Daten, Backups, Module, Dokumente.
- **Nach außen** - ab Werk eine Update-Abfrage an die GitHub-Releases-API. Blockier sie, und nichts geht kaputt, nur der Hinweis auf eine neuere Version bleibt aus. Alles andere geht erst nach außen, wenn du eine Funktion nutzt oder einschaltest, die es braucht: das Öffnen der Kalender-Einstellungen lädt die Liste der Feiertagsländer von openholidaysapi.org, die Logo-Suche für ein Abo ruft die Website des Dienstes auf, und Wetter, Feiertage, Wechselkurse, Kalender- und Kontakte-Sync, Rezept-Spiegel, Immich, Paperless oder Papra, Push- und Benachrichtigungskanäle, Cloud-Speicher und Backup verbinden sich erst, wenn du sie einschaltest.
- **Dein LAN** - Kalender-Abos, WebDAV-Speicher und Rezept-Spiegel unter privaten oder internen Adressen bleiben blockiert, bis du sie freigibst ([wie](docs/installation.md#environment-variables)).
- **Schlüssel** - optional, aber ohne Weg zurück: ein verlorener oder geänderter Schlüssel öffnet die Datenbank nie wieder, weder für dich noch für uns. Die geführte Einrichtung und Umbrel erzeugen ihn für dich; mit Compose, TrueNAS oder Unraid setzt du ihn selbst, also schreib ihn auf.
- **Deine Daten** - eine SQLite-Datei unter `/data/yuvomi.db`, dazu Ordner, WebDAV oder Drive, falls die Dokumente dort liegen.

### Docker oder Podman

Unter Podman lädst du `podman-compose.yml` statt `docker-compose.yml` und startest mit
`podman compose -f podman-compose.yml up -d`; darin stecken die SELinux-`:Z`-Labels, die RHEL,
Fedora und CentOS Stream brauchen.

```bash
curl -O https://raw.githubusercontent.com/ulsklyc/yuvomi/main/docker-compose.yml
curl -O https://raw.githubusercontent.com/ulsklyc/yuvomi/main/.env.example
cp .env.example .env
openssl rand -hex 32   # SESSION_SECRET
openssl rand -hex 32   # DB_ENCRYPTION_KEY
```

> **Öffne jetzt `.env` und ersetze beide `REPLACE_WITH_…`-Platzhalter** durch die zwei eben
> erzeugten Werte, in dieser Reihenfolge, und schreib den zweiten auf: er ist der
> Datenbankschlüssel, und nichts kann ihn wiederherstellen. Ohne Verschlüsselung: die Zeile leeren
> statt sie zu füllen.

```bash
docker compose up -d
```

Öffne `http://localhost:3000`. Der erste Besuch führt dich durch das Anlegen des Admin-Kontos. Lädt
die Seite nicht, nennt `docker compose logs` (unter Podman `podman compose -f podman-compose.yml logs`)
meist den Grund, und die
[Fehlersuche](docs/installation.md#troubleshooting) deckt die häufigen Fälle ab.

### Geführte Einrichtung

Ein Einrichtungsassistent im Browser, in 24 Sprachen. Er erkennt Docker oder Podman, richtet HTTPS,
Single Sign-on und geplante Backups ein, startet dann den Container und legt dein Admin-Konto an.

```bash
git clone https://github.com/ulsklyc/yuvomi.git && cd yuvomi
node tools/installer/install-server.js
```

Öffne **http://localhost:8090**. Braucht Node.js 22+ auf dem Host; der Container bringt sein eigenes Node 24 mit.

### Aus dem App-Store deines NAS

**TrueNAS SCALE**, **Umbrel** und **Unraid** führen Yuvomi alle: im Katalog suchen und installieren,
ganz ohne Terminal. Neu bei Containern? Die
**[Installationsanleitung](docs/installation.md)** führt Schritt für Schritt durch Engine, HTTPS,
Backups und Fehlersuche.

<details>
<summary><b>Bevor du live gehst: Gesundheitsdaten, Google-Drive-Freigabe und DSGVO</b></summary>

<br>

> **Gesundheit ist kein Medizinprodukt.** Es werden keine diagnostischen Aussagen getroffen. Gesundheitsdaten sind sensibel - aktiviere die Datenbankverschlüsselung (`DB_ENCRYPTION_KEY`, SQLCipher).

> **Externer Dokumentenspeicher braucht eine eigene Sicherung.** Datenbank-Backups enthalten Metadaten und Verknüpfungen, nicht die Dateien selbst, wenn sie in einem lokalen Ordner, auf WebDAV oder in Google Drive liegen; sichere das gewählte Ziel separat. Yuvomis Sichtbarkeitseinstellungen regeln nur den Zugriff über Yuvomi. Wer Zugriff auf den verbundenen Google-Drive-Ordner `Yuvomi/Documents` hat, sieht alle dort abgelegten Dateien.

> **Selbst hosten im DSGVO-Kontext?** Wenn du Yuvomi in der EU oder im EWR betreibst und fremde Daten verarbeitest, lies vorher [Datenschutz für Selfhoster](docs/PRIVACY-FOR-SELFHOSTERS.md). Dort stehen Drittlandsbewertungen für jeden externen Dienst, Hinweise zur Auftragsverarbeitung, Empfehlungen zur Log-Aufbewahrung und eine Vorlage für das Verarbeitungsverzeichnis.

</details>

<details>
<summary>Kommst du von <b>Oikos</b> oder siehst <code>oikos</code> in einem App-Store? Dieselbe App, umbenannt.</summary>

<br>

Yuvomi wurde von **Oikos** umbenannt, um einen Markenkonflikt mit einem unabhängigen Produkt zu vermeiden. Gleicher Code, gleiche Daten, gleicher Maintainer.

- Alte Links (`github.com/ulsklyc/oikos`) leiten automatisch hierher weiter.
- Das Docker-Image liegt jetzt unter `ghcr.io/ulsklyc/yuvomi`; das alte `ghcr.io/ulsklyc/oikos` funktioniert weiter, du kannst also in Ruhe umstellen.
- Bestehende Daten und Einstellungen bleiben beim Update vollständig erhalten.
- Manche Katalog-Slugs behalten den technischen Namen `oikos` (z. B. Unraid `oikos-…`), damit bestehende Installationen nahtlos aktualisieren. Suche nach **Yuvomi**; ein Eintrag, der noch als *oikos* erscheint, ist dieselbe App.

</details>

---

## Unter der Haube

- **Kein Build-Schritt** - reine ES-Module und einfaches CSS. Kein Bundler, kein Transpiler, kein Framework, kein CDN zur Laufzeit.
- **Apple HIG in der Liquid-Glass-Sprache** - Systemschrift und Apples Typoskala, Kapsel-Bedienelemente, eingerückte Listengruppen und federnde Bewegung, in Hell und Dunkel gegen WCAG AA geprüft.
- **Privatsphäre zuerst** - vollständig selbstgehostet, optionale SQLCipher-AES-256-Datenbankverschlüsselung, keine Telemetrie.
- **Anmeldung für einen ganzen Haushalt** - optionale Zwei-Faktor-Anmeldung (TOTP mit Wiederherstellungscodes, auf Wunsch für alle verpflichtend), Einladungslinks statt weitergereichter Passwörter und optionaler Self-Service-Passwort-Reset per E-Mail. Optionales Single Sign-on klappt mit jedem OIDC-Anbieter. Ein Schalter entscheidet, ob eine unbekannte Identität ein Konto bekommt, damit ein über deinen Haushalt hinaus geteilter Anbieter keine Tür öffnet, und ein zweiter macht SSO zum einzigen Weg hinein.
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

- **Betreiben** - [Installation](docs/installation.md)&nbsp;&nbsp;·&nbsp; [Sicherheit](SECURITY.md)&nbsp;&nbsp;·&nbsp; [Datenschutz für Selfhoster](docs/PRIVACY-FOR-SELFHOSTERS.md)&nbsp;&nbsp;·&nbsp; [Benachrichtigungs-Webhooks](docs/notification-webhooks.md)&nbsp;&nbsp;·&nbsp; [Immich-Bildschirmschoner](docs/immich-screensaver.md)
- **Darauf aufbauen** - [Spezifikation &amp; Datenmodell](docs/SPEC.md)&nbsp;&nbsp;·&nbsp; [Fremdmodule](MODULES.md)&nbsp;&nbsp;·&nbsp; [Mitwirken](CONTRIBUTING.md)
- **Dem Projekt folgen** - [Changelog](CHANGELOG.md)&nbsp;&nbsp;·&nbsp; [Roadmap](docs/ROADMAP.md)&nbsp;&nbsp;·&nbsp; [Entscheidungen](docs/DECISIONS.md)&nbsp;&nbsp;·&nbsp; [Rahmen](docs/SCOPE.md)&nbsp;&nbsp;·&nbsp; [Backlog](BACKLOG.md)&nbsp;&nbsp;·&nbsp; [Veröffentlichen](docs/RELEASING.md)

**Nutzerhandbuch (aus der Community):** @Kyrodan schreibt eine [Nutzerdokumentation](https://kyrodan.github.io/yuvomi-docs/)
in seinem eigenen Repository. Sie gehört nicht zu diesem Projekt und kann hinter einem Release
zurückliegen; wo sie und die Quellen oben sich widersprechen, gelten die oben.

---

<div align="center">
  <br>
  <img src="docs/logo.svg" alt="" width="48" />
  <p><strong>Ein Zuhause für deinen Haushalt. Und es bleibt deins.</strong></p>
  <p>
    Einmal installiert. Kein Konto bei uns, kein Abo,<br>
    und nichts von uns zwischen deinem Haushalt und seinen Daten.
  </p>
  <p>
    <a href="#installieren"><strong>→ In Minuten installieren</strong></a>&nbsp;&nbsp;·&nbsp;
    <a href="https://github.com/ulsklyc/yuvomi/discussions"><strong>Frag nach</strong></a>
  </p>
  <br>
  <sub>MIT-lizenziert, siehe <a href="LICENSE">LICENSE</a>.</sub>
</div>
