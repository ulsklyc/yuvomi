<div align="center">
  <img src="docs/logo.svg" alt="Yuvomi-Logo" width="92" />

  <h1>Yuvomi</h1>

  <p><strong>Der selbst gehostete Familienplaner.<br>Ein Zuhause statt vieler Abos.</strong></p>

  <p>
    Aufgaben, Kalender, Budget, Mahlzeiten, Gesundheit und mehr für eine Familie, ein Paar oder
    euch allein, auf einem Server, der euch gehört.
  </p>

  <p>
    <a href="https://github.com/ulsklyc/yuvomi/releases"><img src="https://img.shields.io/github/v/release/ulsklyc/yuvomi?style=flat-square&color=6C3AED&label=release" alt="Neuestes Release"></a>
    <a href="https://github.com/ulsklyc/yuvomi/stargazers"><img src="https://img.shields.io/github/stars/ulsklyc/yuvomi?style=flat-square&color=6C3AED&label=stars" alt="GitHub-Sterne"></a>
    <a href="https://github.com/ulsklyc/yuvomi/pkgs/container/yuvomi"><img src="https://img.shields.io/badge/image-ghcr.io%2Fulsklyc%2Fyuvomi-6C3AED?style=flat-square" alt="Container-Image ghcr.io/ulsklyc/yuvomi"></a>
    <a href="#installieren"><img src="https://img.shields.io/badge/platforms-amd64%20%7C%20arm64-6C3AED?style=flat-square" alt="Läuft auf amd64 und arm64"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-6C3AED?style=flat-square" alt="MIT-Lizenz"></a>
  </p>

  <p>
    <a href="https://yuvomi.cloud/"><strong>→ Rundgang auf yuvomi.cloud</strong></a>&nbsp;&nbsp;·&nbsp;
    <a href="#installieren"><strong>Installieren</strong></a>&nbsp;&nbsp;·&nbsp;
    <a href="#dokumentation">Doku</a>&nbsp;&nbsp;·&nbsp;
    <a href="CHANGELOG.md">Changelog</a>&nbsp;&nbsp;·&nbsp;
    <a href="README.md" hreflang="en">English&nbsp;(maßgeblich)</a>
  </p>

  <p><b>20</b>&nbsp;Module&nbsp;&nbsp;·&nbsp; <b>27</b>&nbsp;Sprachen&nbsp;&nbsp;·&nbsp; <b>0</b>&nbsp;Tracker&nbsp;&nbsp;·&nbsp; <b>1</b>&nbsp;SQLite&#8209;Datei&nbsp;&nbsp;·&nbsp; ab&nbsp;<b>256&nbsp;MB</b>&nbsp;RAM</p>

  <picture>
    <source media="(max-width: 600px) and (prefers-color-scheme: dark)" srcset="docs/screenshots/de/dashboard-dark-mobile.webp" width="200">
    <source media="(max-width: 600px)" srcset="docs/screenshots/de/dashboard-light-mobile.webp" width="200">
    <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/de/dashboard-dark-web.webp">
    <img src="docs/screenshots/de/dashboard-light-web.webp" alt="Die Yuvomi-Übersicht: Termine, Aufgaben und Einkauf des Tages für die ganze Familie, darunter Familie, Geburtstage und Belohnungen" width="820">
  </picture>
</div>

Die meisten Haushalte kleben ihren Alltag aus einem Dutzend Bezahl-Apps zusammen, jede mit eigenem
Konto, eigenem Abo und einer eigenen Kopie eurer Daten auf fremden Servern. Yuvomi bringt das alles
an einen Ort, der euch gehört, als Container auf jedem Home-Server oder NAS.

---

## Viele Apps, ein Ort

| Statt zu jonglieren mit… | bekommt ihr mit Yuvomi |
|---|---|
| einer To-do- &amp; Aufgaben-App | **Aufgaben** - Kanban, Fristen, Wiederholungen, mehrere Zuständige |
| einer Familienkalender-App | **Kalender** - Sync, Abos, Sichtbarkeit je Termin |
| einer Essensplaner- &amp; Rezept-App | **Mahlzeiten &amp; Rezepte** - Wochenplaner mit Einkaufsexport |
| einer Einkaufslisten-App | **Einkauf** - geteilte, nach Gang sortierte Listen |
| einer App für Budget und Kostenteilen | **Budget** - Einnahmen, Ausgaben, Konten, Sparziele, geteilte Kosten mit vereinfachten Schulden |
| einer Dokumenten-App | **Dokumente** - durchsuchbare Familiendateien in Ordnern |

## Die Module reden miteinander

Das ist der Teil, den ein Ordner voller Einzel-Apps nicht kann:

- **Ein Import macht aus dem Wochenplan eine Einkaufsliste.** Die nächsten sieben Tage sind vorausgewählt, und jede Zutat landet nach Gang sortiert auf der gemeinsamen Liste.
- **Das letzte Glas aus dem Vorrat kommt mit einem Tipp auf die Liste.** Nach dem Einkauf bucht ein Knopf, was ihr abgehakt habt, mit Menge und Einheit zurück in den Vorrat.
- **Eine erledigte Aufgabe zahlt aus.** Punkte auf einer Aufgabe bekommt, wer sie erledigt hat - die zugewiesene Person oder die beim Abhaken ausgewählte -, und eingelöst werden sie in einem Belohnungskatalog, den ihr selbst bestimmt.
- **Ein abgelegter Beleg hängt an der Buchung.** Einmal hochgeladen, gehört er gleichzeitig zur Buchung, zur geteilten Ausgabe und zum Inventargegenstand.

## An der Küchenwand, in jeder Hosentasche

<p align="center">
  <picture>
    <source media="(max-width: 600px) and (prefers-color-scheme: dark)" srcset="docs/screenshots/de/dashboard-wall-dark-web.webp" width="324">
    <source media="(max-width: 600px)" srcset="docs/screenshots/de/dashboard-wall-light-web.webp" width="324">
    <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/de/dashboard-wall-dark-web.webp">
    <img src="docs/screenshots/de/dashboard-wall-light-web.webp" alt="Yuvomi im Wand-Modus auf einem Tablet im Querformat: die Uhrzeit in großer Schrift, Termine, Aufgaben und Einkauf des Tages, wer heute dran ist, das Wetter und Küchentimer auf Fingertipp" width="600">
  </picture>
  <picture>
    <source media="(max-width: 600px) and (prefers-color-scheme: dark)" srcset="docs/screenshots/de/shopping-dark-mobile.webp" width="170">
    <source media="(max-width: 600px)" srcset="docs/screenshots/de/shopping-light-mobile.webp" width="170">
    <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/de/shopping-dark-mobile.webp">
    <img src="docs/screenshots/de/shopping-light-mobile.webp" alt="Die geteilte Einkaufsliste auf dem Handy, nach Gang sortiert: Obst und Gemüse, Backwaren, Milchprodukte, Fleisch und Fisch" width="207" hspace="12">
  </picture>
</p>

- **Das Tablet an der Küchenwand** zeigt im Wand-Modus den Tagesplan und wer heute dran ist, lesbar quer durch den Raum. Es hat ein eigenes Konto: Aufgabe antippen, auswählen, wer sie erledigt hat, und die Punkte gehen an diese Person. Steht es still, kann ein Immich-Bildschirmschoner eure eigenen Fotos zeigen.
- **Die App auf jedem Handy** kommt direkt aus dem Browser auf den Startbildschirm, ohne App Store. Erinnerungen kommen als Mitteilung, auch wenn die App zu ist (dafür braucht euer Server HTTPS), und die zuletzt geöffnete Einkaufsliste bleibt lesbar, wenn kein Netz da ist.
- **Jedes Mitglied kommt per Einladungslink** und wählt sein Passwort selbst; ein Kind ohne Handy bekommt sein Konto direkt angelegt. Je Familienrolle ist jedes Modul voll, nur lesen oder gar nicht freigegeben.

**Von eurer Familie eingeladen?** Öffnet den Einladungslink, den euer Admin geschickt hat; er gilt
sieben Tage. Wählt einen Benutzernamen, falls die Einladung keinen vorgibt, und euer eigenes
Passwort (keins, wenn sich euer Haushalt per Single Sign-on anmeldet). Dann meldet euch an und holt
Yuvomi auf den Startbildschirm: Installieren antippen, wenn die App es anbietet, oder auf iPhone
und iPad Teilen und dann Zum Home-Bildschirm wählen.

[Mehr auf yuvomi.cloud](https://yuvomi.cloud/#family)

## Die zwanzig Module

Schaltet ab, was euer Haushalt nicht braucht, und es verschwindet für alle aus dem Menü. Inventar,
Entsorgung und Schichtplan sind anfangs aus.

<details>
<summary>
Alle 20 Module, je in einer Zeile<br>
<b>Planen</b> - Aufgaben · Kalender · Belohnungen · Notizen &amp; Kontakte · Schichtplan<br>
<b>Haushalt</b> - Küche (Mahlzeiten · Rezepte · Einkauf · Vorrat) · Haushaltshilfe · Entsorgung · Dokumente · Inventar<br>
<b>Menschen</b> - Gesundheit · Geburtstage<br>
<b>Finanzen</b> - Budget<br>
<b>Einstellungen</b> - Familie · Erinnerungen · API-Tokens · Backup
</summary>

| Modul | In einer Zeile |
|---|---|
| **Aufgaben** | Kanban-Board mit Fristen, Unteraufgaben, Wiederholungen, Kommentaren und einem Verlauf, wer was abgehakt hat. |
| **Kalender** | Zwei-Wege-Sync mit Google und CalDAV, Outlook-Push, Kalender-Abos, Feiertage und Sichtbarkeit je Termin. |
| **Belohnungen** | Punkte aus Aufgaben, ein elterlich freigegebener Katalog, ein nachvollziehbares Konto und Taschengeld je Kind. |
| **Notizen &amp; Kontakte** | Markdown-Haftnotizen mit antippbaren Checklisten, dazu Kontakte mit CardDAV-Sync und vCard-Import/-Export. |
| **Schichtplan** | Rotierende Schichten und feste Wochenpläne, als Ebene im Kalender eingeblendet. Standardmäßig aus. |
| **Mahlzeiten** | Wochenplaner per Drag-and-drop mit Rezept-Seitenleiste und direktem Export in die Einkaufsliste. |
| **Rezepte** | Rezepte anlegen und skalieren, Mahlzeiten vorbelegen oder eine Mealie- oder Tandoor-Instanz lesend spiegeln. |
| **Einkauf** | Geteilte Listen nach Gang sortiert, mit Wischgesten und einem Import aus dem Essensplan. |
| **Vorrat** | Menge, Lagerort und Mindesthaltbarkeit, mit einer Erinnerung, bevor etwas abläuft. |
| **Haushaltshilfe** | Für Hilfen im Haushalt: Dienstpläne, Ein- und Ausstempeln, Abrechnung, Aufgaben und Materialwünsche. |
| **Entsorgung** | Abholtermine je Abfallart, auch „der letzte Freitag", oder ein abonnierter kommunaler ICS-Kalender. Standardmäßig aus. |
| **Dokumente** | Durchsuchbare Familiendateien in Ordnern, lokal, auf WebDAV oder in Google Drive. |
| **Inventar** | Was ihr besitzt, mit Kaufpreis, Garantie, verknüpften Belegen, einem Wartungsprotokoll und wiederkehrenden Erinnerungen vor Fristablauf. Standardmäßig aus. |
| **Gesundheit** | Vitalwerte, Medikamente, Vorsorge, Laborwerte, Aktivität, Zyklus, ein Fastentagebuch und ein Ernährungstagebuch je Mitglied, mit Verlaufsdiagrammen. |
| **Geburtstage** | Geburtstage und optionale Namenstage, mit Kalendereinträgen, Alter und Erinnerungen. |
| **Budget** | Einnahmen, Ausgaben, Konten, Darlehen, Abos und gemeinsame Ausgaben mit vereinfachten Schulden. |
| **Familie** | Mitgliedsprofile mit Rollen und Einladungslinks, über die neue Mitglieder ihr Passwort selbst wählen. |
| **Erinnerungen** | An Aufgaben, Termine, Medikamente, Garantien, Mindesthaltbarkeit, ablaufende Dokumente und Abfuhr - in der App, per Push, Gotify, ntfy, Webhook oder E-Mail. |
| **API-Tokens** | Bearer-Tokens mit OpenAPI-3.1-Spezifikation und eingebautem MCP-Endpunkt für KI-Agenten. |
| **Backup** | Manuelle und geplante Sicherungen mit optionalem WebDAV-Upload und Rollback vor dem Wiederherstellen; auch das Backup einer anderen Installation spielt ihr direkt im Browser zurück. |

</details>

Jedes Modul im Detail steht in der [Spezifikation](docs/SPEC.md); wie ihr ein eigenes Modul
einhängt - mit eigenen Dashboard-Widgets, Rechten und Übersetzungen -, steht im [Modulhandbuch](MODULES.md).

---

## Bevor ihr euch festlegt

**Was, wenn dieses Projekt aufhört?** Auf eurer Maschine ändert sich nichts. Yuvomi ist
MIT-lizenziert und selbstgehostet, und auf dem Weg steht kein Server von uns. Der Container, den ihr
schon geholt habt, läuft weiter wie heute, mit uns oder ohne uns.

**Was, wenn ihr eure Daten woanders haben wollt?** Alles liegt in einer SQLite-Datei auf eurer
eigenen Platte, und sie zu kopieren ist der ganze Export, solange die Dokumente in der Datenbank
liegen. Geplante Backups schreiben zusätzlich ein wiederherstellbares Archiv, und die dokumentierte
API holt alles in der Form heraus, die ihr braucht.

**Wie sicher ist der Zugang von außen?** Jedes Konto kann einen zweiten Faktor bekommen (TOTP, mit
Wiederherstellungscodes), und ein Admin kann ihn für den ganzen Haushalt verlangen; neue Mitglieder
kommen per Einladungslink und wählen ihr Passwort selbst. Mit Single Sign-on über einen OIDC-Anbieter
lässt sich die Passwort-Anmeldung für den Haushalt abschalten, und ein verlorenes Handy meldet ihr
von jedem eurer anderen Geräte aus ab.

**Was kostet es?** Nichts. Yuvomi ist kostenlos und MIT-lizenziert. Ihr stellt den Server; es gibt
kein Abo, keinen Upsell und keine Bezahlstufe.

**Telefoniert es nach Hause?** Von sich aus fragt Yuvomi nur bei GitHub, ob es eine neuere Version
gibt, und wer das blockiert, macht nichts kaputt. Alles andere wartet, bis ihr eine Funktion nutzt
oder einschaltet, die es braucht; jede Verbindung steht im Abschnitt [Installieren](#installieren)
unter *Voraussetzungen, Netzwerk und eure Daten*.

---

## Installieren

**Aus dem App-Store eures NAS** - [TrueNAS SCALE](https://yuvomi.cloud/install.html#truenas),
[Umbrel](https://yuvomi.cloud/install.html#umbrel) oder [Unraid](https://yuvomi.cloud/install.html#unraid):
im Katalog nach Yuvomi suchen und installieren, ganz ohne Terminal.

**Mit Docker** auf jedem Server. Das Image `ghcr.io/ulsklyc/yuvomi:latest` ist rund 500 MB groß und
läuft auf amd64 und arm64 (Raspberry Pi 4/5); Yuvomi braucht einen Port, standardmäßig 3000.

```bash
curl -O https://raw.githubusercontent.com/ulsklyc/yuvomi/main/docker-compose.yml
curl -O https://raw.githubusercontent.com/ulsklyc/yuvomi/main/.env.example
cp .env.example .env
openssl rand -hex 32   # SESSION_SECRET
openssl rand -hex 32   # DB_ENCRYPTION_KEY
```

> **Öffnet jetzt `.env` und ersetzt beide `REPLACE_WITH_…`-Platzhalter** durch die zwei Werte, in
> dieser Reihenfolge, und schreibt den zweiten auf: er ist der Datenbankschlüssel, und ein
> verlorener oder geänderter Schlüssel öffnet die Datenbank nie wieder, weder für euch noch für
> uns. Bleibt ein Platzhalter stehen, startet Yuvomi nicht. Ohne Verschlüsselung: die Zeile
> `DB_ENCRYPTION_KEY` leeren statt sie zu füllen.

```bash
docker compose up -d
```

Öffnet `http://localhost:3000` und legt euer Admin-Konto an. Podman, Proxmox, HTTPS, Backups und
Fehlersuche Schritt für Schritt: die [Installationsanleitung auf yuvomi.cloud](https://yuvomi.cloud/install.html)
und die [Installationsanleitung im Repository](docs/installation.md).

<details>
<summary><b>Podman, Proxmox, die geführte Einrichtung und der Schlüssel</b></summary>

- **Podman** - ladet `podman-compose.yml` statt `docker-compose.yml` und startet mit
  `podman compose -f podman-compose.yml up -d`; darin stecken die SELinux-`:Z`-Labels, die RHEL,
  Fedora und CentOS Stream brauchen.
- **Seite lädt nicht** - `docker compose logs` (unter Podman
  `podman compose -f podman-compose.yml logs`) nennt meist den Grund, und die
  [Fehlersuche](docs/installation.md#troubleshooting) deckt die häufigen Fälle ab.
- **Proxmox** - dieselben Schritte laufen in einem kleinen Debian-LXC: siehe die
  [Proxmox-Anleitung auf yuvomi.cloud](https://yuvomi.cloud/install.html#proxmox).
- **Schlüssel** - optional, aber ohne Weg zurück. Die geführte Einrichtung und Umbrel erzeugen ihn
  für euch; mit Compose, TrueNAS oder Unraid setzt ihr ihn selbst, also schreibt ihn auf.
- **Geführte Einrichtung** - ein lokalisierter Einrichtungsassistent im Browser. Er erkennt Docker
  oder Podman, richtet Single Sign-on und geplante Backups ein, bereitet Yuvomi auf einen
  HTTPS-Reverse-Proxy vor (das Zertifikat bleibt Sache des Proxys), startet dann den Container und
  legt euer Admin-Konto an.

  ```bash
  git clone https://github.com/ulsklyc/yuvomi.git && cd yuvomi
  node tools/installer/install-server.js
  ```

  Öffnet **http://localhost:8090** auf dem Server selbst; woanders antwortet der Assistent nicht.
  Von einem anderen Gerät aus öffnet ihr zuerst einen Tunnel, `ssh -L 8090:localhost:8090 user@server`,
  und dann dort dieselbe Adresse. Braucht Node.js 22.14+ oder 23.6+ auf dem Host; der Container
  bringt sein eigenes Node 24 mit.

</details>

<details>
<summary><b>Voraussetzungen, Netzwerk und eure Daten</b></summary>

- **Browser** - alles wie vorgesehen ab Chrome und Edge 117, Firefox 129 und Safari 17.5. Bis hinunter zu Chrome 87, Firefox 79 und Safari 14.1 (iOS 14.5) startet und scrollt es noch, schlichter und mit einzelnen fehlenden Funktionen ([gemessen am 21. September 2026](docs/installation.md#browser-support)).
- **Schreibt** - vier Volumes, die euch gehören: Daten, Backups, Module, Dokumente.
- **Nach außen** - von sich aus eine Update-Abfrage an die GitHub-Releases-API. Blockiert sie, und nichts geht kaputt, nur der Hinweis auf eine neuere Version bleibt aus. Alles andere geht erst nach außen, wenn ihr eine Funktion nutzt oder einschaltet, die es braucht:
  - **Wenn ihr sie nutzt** - das Öffnen der Kalender-Einstellungen lädt die Liste der Feiertagsländer von openholidaysapi.org; die Logo-Suche für ein Abo ruft die Website des Dienstes auf.
  - **Wenn der Betreiber es einschaltet** - das Holen des Profilbilds von Gravatar schickt einen Hash eurer E-Mail-Adresse an gravatar.com oder den vom Betreiber gewählten Spiegel; ist die Web-Installation erlaubt, kann ein Admin Erweiterungsmodule von GitHub installieren.
  - **Sobald ihr sie einschaltet** - Wetter, Feiertage, Wechselkurse, Kalender- und Kontakte-Sync, Rezept-Spiegel, Immich, Paperless oder Papra, Push- und Benachrichtigungskanäle, Cloud-Speicher und Backup.
- **Euer LAN** - Kalender-Abos, Benachrichtigungskanäle (Webhook, Gotify, ntfy), WebDAV-Dokumentenspeicher, Rezept-Spiegel und Abfuhr-Feeds unter privaten oder internen Adressen bleiben blockiert, bis ihr sie freigebt ([wie](docs/installation.md#environment-variables)). Paperless und Papra sind die Ausnahme: sie dürfen ab Werk ins LAN.
- **Eure Daten** - eine SQLite-Datei unter `/data/yuvomi.db`, dazu Ordner, WebDAV oder Drive, falls die Dokumente dort liegen.

</details>

<details>
<summary><b>Bevor ihr live geht: Gesundheitsdaten, Google-Drive-Freigabe und DSGVO</b></summary>

<br>

> **Gesundheit ist kein Medizinprodukt.** Es werden keine diagnostischen Aussagen getroffen. Gesundheitsdaten sind sensibel - aktiviert die Datenbankverschlüsselung (`DB_ENCRYPTION_KEY`, SQLCipher).

> **Externer Dokumentenspeicher braucht eine eigene Sicherung.** Datenbank-Backups enthalten Metadaten und Verknüpfungen, nicht die Dateien selbst, wenn sie in einem lokalen Ordner, auf WebDAV oder in Google Drive liegen; sichert das gewählte Ziel separat. Yuvomis Sichtbarkeitseinstellungen regeln nur den Zugriff über Yuvomi. Wer Zugriff auf den verbundenen Google-Drive-Ordner `Yuvomi/Documents` hat, sieht alle dort abgelegten Dateien.

> **Selbst hosten im DSGVO-Kontext?** Wenn ihr Yuvomi in der EU oder im EWR betreibt und fremde Daten verarbeitet, lest vorher [Datenschutz für Selfhoster](docs/PRIVACY-FOR-SELFHOSTERS.md). Dort stehen Drittlandsbewertungen für jeden externen Dienst, Hinweise zur Auftragsverarbeitung, Empfehlungen zur Log-Aufbewahrung und eine Vorlage für das Verarbeitungsverzeichnis.

</details>

<details>
<summary>Kommt ihr von <b>Oikos</b> oder seht <code>oikos</code> in einem App-Store? Dieselbe App, umbenannt.</summary>

<br>

Yuvomi wurde von **Oikos** umbenannt, um einen Markenkonflikt mit einem unabhängigen Produkt zu vermeiden. Gleicher Code, gleiche Daten, gleicher Maintainer.

- Alte Links (`github.com/ulsklyc/oikos`) leiten automatisch hierher weiter.
- Das Docker-Image liegt jetzt unter `ghcr.io/ulsklyc/yuvomi`; das alte `ghcr.io/ulsklyc/oikos` funktioniert weiter, ihr könnt also in Ruhe umstellen.
- Bestehende Daten und Einstellungen bleiben beim Update vollständig erhalten.
- Manche Katalog-Slugs behalten den technischen Namen `oikos` (z. B. Unraid `oikos-…`), damit bestehende Installationen nahtlos aktualisieren. Sucht nach **Yuvomi**; ein Eintrag, der noch als *oikos* erscheint, ist dieselbe App.

</details>

---

## Unter der Haube

- **Kein Build-Schritt** - reine ES-Module und einfaches CSS. Kein Bundler, kein Transpiler, kein Framework, kein CDN zur Laufzeit.
- **Fühlt sich an wie eine native App** - gebaut nach Apples Gestaltungsrichtlinien: Systemschrift, Kapsel-Knöpfe, gruppierte Listen und federnde Bewegung, mit in Hell und Dunkel geprüftem WCAG-AA-Kontrast.
- **Privatsphäre zuerst** - vollständig selbstgehostet, optionale SQLCipher-AES-256-Datenbankverschlüsselung, keine Telemetrie.
- **Anmeldung für einen ganzen Haushalt** - Zwei-Faktor-Anmeldung, Einladungslinks, optionaler Passwort-Reset per E-Mail und Single Sign-on mit jedem OIDC-Anbieter; siehe [wie sicher der Zugang von außen ist](#bevor-ihr-euch-festlegt).
- **Eure Sprache, automatisch erkannt.** Eine eigene Haushaltseinstellung bestimmt die Sprache der Einträge, die Yuvomi selbst anlegt - so spricht ein exportierter Kalender die Sprache eures Haushalts statt Englisch.
- **Technik** - Node.js und Express mit SQLite (SQLCipher), ein Container für Docker oder Podman, eine PWA auf jedem Handy.

---

## Dokumentation

- **Ansehen** - [Rundgang und Screenshots auf yuvomi.cloud](https://yuvomi.cloud/)&nbsp;&nbsp;·&nbsp; [Installationsanleitung auf yuvomi.cloud](https://yuvomi.cloud/install.html)
- **Betreiben** - [Installation](docs/installation.md)&nbsp;&nbsp;·&nbsp; [Sicherheit](SECURITY.md)&nbsp;&nbsp;·&nbsp; [Datenschutz für Selfhoster](docs/PRIVACY-FOR-SELFHOSTERS.md)&nbsp;&nbsp;·&nbsp; [Benachrichtigungs-Webhooks](docs/notification-webhooks.md)&nbsp;&nbsp;·&nbsp; [Immich-Bildschirmschoner](docs/immich-screensaver.md)
- **Darauf aufbauen** - [Spezifikation &amp; Datenmodell](docs/SPEC.md)&nbsp;&nbsp;·&nbsp; [Fremdmodule](MODULES.md)&nbsp;&nbsp;·&nbsp; [Mitwirken](CONTRIBUTING.md)
- **Dem Projekt folgen** - [Changelog](CHANGELOG.md)&nbsp;&nbsp;·&nbsp; [Roadmap](docs/ROADMAP.md)&nbsp;&nbsp;·&nbsp; [Entscheidungen](docs/DECISIONS.md)&nbsp;&nbsp;·&nbsp; [Rahmen](docs/SCOPE.md)&nbsp;&nbsp;·&nbsp; [Backlog](BACKLOG.md)&nbsp;&nbsp;·&nbsp; [Veröffentlichen](docs/RELEASING.md)

**Nutzerhandbuch (aus der Community):** @Kyrodan schreibt eine [Nutzerdokumentation](https://kyrodan.github.io/yuvomi-docs/)
in seinem eigenen Repository. Sie gehört nicht zu diesem Projekt und kann hinter einem Release
zurückliegen; wo sie und die Quellen oben sich widersprechen, gelten die oben.

---

<div align="center">
  <br>
  <img src="docs/logo.svg" alt="Yuvomi-Logo" width="48" />
  <p><strong>Ein Zuhause für euren Haushalt. Und es bleibt eures.</strong></p>
  <p>
    Einmal installiert. Kein Konto bei uns, kein Abo,<br>
    und nichts von uns zwischen eurem Haushalt und seinen Daten.
  </p>
  <p>
    <a href="#installieren"><strong>→ Installieren</strong></a>&nbsp;&nbsp;·&nbsp;
    <a href="https://yuvomi.cloud/"><strong>Rundgang ansehen</strong></a>&nbsp;&nbsp;·&nbsp;
    <a href="https://github.com/ulsklyc/yuvomi/discussions"><strong>Fragt nach</strong></a>
  </p>
  <br>
  <sub>MIT-lizenziert, siehe <a href="LICENSE">LICENSE</a>. Mehr auf <a href="https://yuvomi.cloud/">yuvomi.cloud</a>.</sub>
</div>
