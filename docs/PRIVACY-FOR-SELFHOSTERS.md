# Datenschutz-Hinweise für Selfhoster (Yuvomi)

> **Stand: 06.08.2026** - Diese Hinweise sind eine technisch orientierte
> Hilfestellung für Betreiber. Prüfe die Aktualität von Angemessenheitsbeschlüssen
> und DPF-Listungen selbst (siehe Abschnitt „Quellen").

> Dieses Dokument richtet sich an **Betreiber, die Yuvomi in einer Umgebung
> einsetzen, die unter die DSGVO fällt** — also typischerweise an einen
> Wohnsitz, ein Unternehmen oder eine Organisation in der EU/EWR. Wenn du Yuvomi
> ausschließlich für dich selbst und deine Familie betreibst, ohne Daten Dritter
> zu verarbeiten, prüfe vorrangig den Abschnitt
> [„Haushaltsausnahme"](#4-haushaltsausnahme-art-2-abs-2-lit-c-dsgvo).
> Sobald du Daten **anderer Personen** (Mitbewohner, Familienmitglieder,
> Freunde, Kunden, Mitarbeitende …) verarbeitest **und/oder** die Instanz über
> rein-private Zwecke hinaus betreibst, gilt für dich die DSGVO in vollem
> Umfang. Du bist dann der **Verantwortliche** im Sinne von Art. 4 Nr. 7 DSGVO.

---

## Inhalt

1. [Wer ist Verantwortlicher?](#1-wer-ist-verantwortlicher)
2. [Externe Dienste, die Yuvomi kontaktiert](#2-externe-dienste-die-yuvomi-kontaktiert)
   - 2.1 [Open-Meteo (Wetter-Standard)](#21-open-meteo-wetter-standard)
   - 2.2 [OpenWeatherMap (Wetter-Optional)](#22-openweathermap-wetter-optional)
   - 2.3 [CalDAV/CardDAV-Sync](#23-caldavcarddav-sync)
   - 2.4 [OIDC-Provider (Single Sign-On)](#24-oidc-provider-single-sign-on)
   - 2.5 [WebDAV-Backup](#25-webdav-backup)
   - 2.6 [WebDAV-Dokumentspeicher](#26-webdav-dokumentspeicher)
   - 2.7 [Google-Drive-Dokumentspeicher](#27-google-drive-dokumentspeicher)
   - 2.8 [Abonnement-Integrationen](#28-abonnement-integrationen)
   - 2.9 [MCP-Endpoint (KI-/Agent-Zugriff)](#29-mcp-endpoint-ki-agent-zugriff)
   - 2.10 [Web Push & Benachrichtigungs-Kanäle](#210-web-push--benachrichtigungs-kanäle)
   - 2.11 [E-Mail-Versand (SMTP)](#211-e-mail-versand-smtp)
   - 2.12 [Versions-/Changelog-Abruf (GitHub)](#212-versions-changelog-abruf-github)
   - 2.13 [Mealie-Rezept-Sync](#213-mealie-rezept-sync)
   - 2.14 [DMS-Anbindung (Paperless-ngx / Papra)](#214-dms-anbindung-paperless-ngx--papra)
   - 2.15 [ICS-Kalender-Abos](#215-ics-kalender-abos)
   - 2.16 [Outlook-Push (Microsoft Graph)](#216-outlook-push-microsoft-graph)
3. [Logging und Speicherbegrenzung](#3-logging-und-speicherbegrenzung-art-5-abs-1-lit-e-dsgvo)
4. [Haushaltsausnahme](#4-haushaltsausnahme-art-2-abs-2-lit-c-dsgvo)
5. [Verarbeitungsverzeichnis-Vorlage (Art. 30 DSGVO)](#5-verarbeitungsverzeichnis-vorlage-art-30-dsgvo)
6. [Quellen](#6-quellen)

---

## 1. Wer ist Verantwortlicher?

Sobald die Haushaltsausnahme (Abschnitt 4) **nicht** greift, bist **du als
Betreiber** der Yuvomi-Instanz Verantwortlicher i. S. v. Art. 4 Nr. 7 DSGVO. Das
bedeutet u. a.:

- Du brauchst eine **Rechtsgrundlage** für jede Verarbeitung (typischerweise
  Art. 6 Abs. 1 lit. b „Vertrag", lit. f „berechtigtes Interesse" oder
  lit. a „Einwilligung").
- Du musst die Betroffenen nach **Art. 13/14 DSGVO** informieren
  (Datenschutzerklärung).
- Du musst ein **Verarbeitungsverzeichnis** nach Art. 30 DSGVO führen (Vorlage
  siehe Abschnitt 5).
- Bei jedem externen Dienst, der personenbezogene Daten in deinem Auftrag
  verarbeitet, brauchst du einen **Auftragsverarbeitungsvertrag (AVV)** nach
  Art. 28 DSGVO.
- Bei Übermittlung in **Drittländer** (außerhalb EWR) zusätzlich die
  Voraussetzungen nach Art. 44 ff. DSGVO (Angemessenheitsbeschluss, SCCs +
  Transfer Impact Assessment).

> **NIS2 (nur in bestimmten Sektoren):** Das NIS2UmsuCG ist seit 06.12.2025 in
> Kraft (BSI-Registrierungsfrist lief am 06.03.2026 ab). Für den normalen
> Familien-/Privatbetrieb ist es **nicht** einschlägig. Betreibst du die Instanz
> dagegen in einer **Einrichtung eines besonders wichtigen oder wichtigen
> Sektors** oberhalb der Größenschwellen, prüfe die NIS2-Registrierungs- und
> Meldepflichten eigenständig.

---

## 2. Externe Dienste, die Yuvomi kontaktiert

Die folgende Tabelle dokumentiert, **welche Komponenten der App vom Backend aus
welche externen Endpunkte kontaktieren** und welche Pflichten für dich als
Betreiber daraus resultieren.

| Dienst | Code-Stelle | Standard aktiv? | Drittland? | AVV nötig? |
|---|---|---|---|---|
| Open-Meteo | `server/routes/weather.js` | ja (Default) | CH — Angemessenheitsbeschluss | nein (siehe 2.1) |
| OpenWeatherMap | `server/routes/weather.js` | nur wenn `OPENWEATHER_API_KEY` gesetzt | UK — Angemessenheitsbeschluss | empfohlen (siehe 2.2) |
| CalDAV/CardDAV-Server | `server/services/caldav-sync.js`, `server/services/cardav-sync.js` | nur wenn Nutzer einen Sync konfiguriert | abhängig vom Provider | ja, bei kommerziellen Anbietern (siehe 2.3) |
| Google-Kalender-Sync (REST-API) | `server/services/google-calendar.js` | nur nach OAuth-Verbindung | USA/Google; DPF-Status prüfen | ja (siehe 2.3) |
| OIDC-Provider | `server/auth.js`, `server/services/oidc.js` | nur wenn konfiguriert | abhängig vom Provider | meistens ja (siehe 2.4) |
| WebDAV-Backup | `server/services/backup-webdav.js` | nur wenn konfiguriert | abhängig vom Provider | ja, bei kommerziellen Anbietern (siehe 2.5) |
| WebDAV-Dokumentspeicher | `server/services/document-storage.js` | nur wenn konfiguriert | abhängig vom Provider | ja, bei kommerziellen Anbietern (siehe 2.6) |
| Google-Drive-Dokumentspeicher | `server/services/google-drive-storage.js` | nur nach OAuth-Verbindung und expliziter Auswahl | USA/Google; DPF-Status prüfen | ja (siehe 2.7) |
| Abonnement-Integrationen | `server/services/subscription-*` | nur wenn konfiguriert/ausgelöst | abhängig von Fixer, Benachrichtigungs- oder KI-Provider | abhängig vom Provider (siehe 2.8) |
| MCP-Endpoint (KI-/Agent-Zugriff) | `server/index.js` (Mount `/mcp`), `server/mcp/*` | nur wenn Nutzer ein API-Token erstellt und einen MCP-Client anbindet | **lokaler Client: nein** · Cloud-Client: abhängig vom Anbieter | lokaler Client: nein · Cloud-Client: ggf. gegenüber dem Anbieter (siehe 2.9) |
| Web Push | `server/services/push.js` | nur wenn ein Nutzer Push auf einem Gerät aktiviert | Push-Dienst des jeweiligen Browsers (Google/Apple/Mozilla) — USA möglich; Inhalte verschlüsselt | nein (siehe 2.10) |
| Benachrichtigungs-Kanäle (Gotify/ntfy …) | `server/services/notification-channels.js`, `server/services/notification-providers/` | nur wenn ein Admin einen Kanal konfiguriert | abhängig vom Ziel (meist selbst gehostet) | i. d. R. nein (siehe 2.10) |
| E-Mail-Versand (SMTP) | `server/services/email.js` | nur wenn SMTP konfiguriert | abhängig vom Provider | ja, bei kommerziellen Anbietern (siehe 2.11) |
| Versions-/Changelog-Abruf | `server/routes/changelog.js` | ja — beim Öffnen des Änderungsverlaufs bzw. der Versionsprüfung (30-Min-Server-Cache) | USA — GitHub/Microsoft, DPF | nein (siehe 2.12) |
| Mealie-Rezept-Sync | `server/services/mealie/` | nur wenn eine Mealie-Instanz verbunden ist | i. d. R. selbst gehostet | i. d. R. nein (siehe 2.13) |
| DMS-Anbindung (Paperless-ngx/Papra) | `server/services/dms/` | nur wenn ein DMS verbunden ist | i. d. R. selbst gehostet | i. d. R. nein (siehe 2.14) |
| ICS-Kalender-Abos | `server/services/ics-subscription.js` | nur wenn ein Nutzer einen Feed abonniert | abhängig vom Feed-Anbieter | nein (siehe 2.15) |
| Outlook-Push (Microsoft Graph) | `server/services/outlook-calendar.js` | nur wenn alle `MS_*` gesetzt sind **und** ein Konto per OAuth verbunden wurde | USA/Microsoft; DPF-Status prüfen | für private Microsoft-Konten **nicht abschließbar** (siehe 2.16) |

### 2.1 Open-Meteo (Wetter-Standard)

- **Betreiber:** Open-Meteo (Bruno Ledergerber), Schweiz.
- **Was wird übertragen:** Geo-Koordinaten oder Ortsname (je nach
  Benutzer-Einstellung) sowie die IP-Adresse deines Yuvomi-Servers (nicht die
  IP des Endgeräts — die Anfrage geht vom Backend aus).
- **Rechtsgrundlage:** Art. 6 Abs. 1 lit. b DSGVO (Vertragserfüllung — Wetter
  ist eine angeforderte Funktion).
- **Drittland-Bewertung:** Schweiz — **Angemessenheitsbeschluss der
  EU-Kommission vom 26.07.2000** (zuletzt in der konsolidierten Liste der
  Kommission bestätigt). Keine Notwendigkeit für SCCs oder Transfer Impact
  Assessment.
- **AVV:** Open-Meteo nutzt nur die Koordinaten/Ortsnamen zur Antwort und
  speichert nach eigenen Angaben keine Personendaten. Eine AVV-Pflicht nach
  Art. 28 DSGVO ist daher in der Regel nicht gegeben (es ist keine
  „Verarbeitung im Auftrag" im engeren Sinne). **Praxis-Tipp:** in der
  Datenschutzerklärung trotzdem transparent erwähnen (Art. 13 Abs. 1 lit. f).

### 2.2 OpenWeatherMap (Wetter-Optional)

- **Betreiber:** OpenWeather Ltd., London, Vereinigtes Königreich.
- **Aktiv nur, wenn:** der Selfhoster die Umgebungsvariable
  `OPENWEATHER_API_KEY` setzt. Ohne Key wird ausschließlich Open-Meteo genutzt.
- **Was wird übertragen:** Geo-Koordinaten/Ortsname, API-Key, Server-IP.
- **Drittland-Bewertung:** UK — **Angemessenheitsbeschluss
  2021/1772 vom 28.06.2021**, gültig bis **27.06.2025**; die Kommission hat
  die Geltung mit Beschluss 2025/650 **um sechs Monate verlängert** und arbeitet
  an einem neuen Beschluss. Aktualität der Liste prüfen unter
  `commission.europa.eu` (siehe Abschnitt 6).
- **AVV:** Empfohlen — OpenWeather bietet Standard-DPA-Templates an. Wenn du
  OpenWeatherMap aktivierst, lade das DPA herunter und gegenzeichne es vor
  Produktivnutzung.
- **TIA:** Wegen Angemessenheitsbeschluss derzeit nicht erforderlich; sollte
  der Beschluss auslaufen ohne Ersatz, gilt UK wieder als „klassisches"
  Drittland und SCCs + TIA werden Pflicht.
- **Hinweis in deiner Datenschutzerklärung:** Empfänger
  „OpenWeather Ltd., London, UK", Zweck „Bereitstellung
  Wettervorhersage", Rechtsgrundlage Art. 6 Abs. 1 lit. b, Drittland-Hinweis
  „UK – Angemessenheitsbeschluss".

### 2.3 CalDAV/CardDAV-Sync

- **Code-Stellen:** `server/services/caldav-sync.js`,
  `server/services/caldav-reminders-sync.js`, `server/services/cardav-sync.js`,
  `server/routes/cardav.js`.
- **Wer ist Empfänger?** Der **vom Nutzer konfigurierte** CalDAV-/CardDAV-
  Server (z. B. Nextcloud, Apple iCloud, Mailbox.org, Google, eigener Radicale).
  Yuvomi selbst leitet nichts weiter.
- **Drittland-Bewertung — abhängig vom Anbieter:**
  | Anbieter | Standort | Bewertung |
  |---|---|---|
  | Nextcloud (selbst gehostet/EU) | EU | unkritisch, kein Drittland |
  | Mailbox.org / Posteo / mailcow | DE | unkritisch |
  | Apple iCloud | USA (Apple Inc.) | DPF-zertifiziert; AVV via Apple Business |
  | Google Workspace | USA (Google LLC) | DPF-zertifiziert; AVV + DPF-Status prüfen |
  | Outlook.com / Microsoft 365 | USA (Microsoft Corp.) | **kein CalDAV** — eigener Kanal, siehe Abschnitt 2.16 |
  | Mailbox-Provider Drittland (sonstige) | Einzelfall | individuelle TIA |
- **AVV:** ja, bei kommerziellen Anbietern.
- **Google-Kalender-Sync läuft nicht über CalDAV:** Yuvomi synchronisiert Google
  über die **Google-Calendar-REST-API** mit eigenem OAuth-Flow
  (`server/services/google-calendar.js`, Endpunkt `www.googleapis.com`).
  Übertragen werden Termindaten der freigegebenen Kalender in beide Richtungen
  sowie OAuth-Zugriffs-/Refresh-Token; die Token liegen in der Datenbank und
  sind nur bei aktiviertem `DB_ENCRYPTION_KEY` verschlüsselt. Drittland- und
  AVV-Bewertung wie in der Tabelle oben für Google (USA/DPF-Status prüfen,
  Google-AVV/DPA abschließen) — analog zu Abschnitt 2.7.
- **Outlook.com spricht kein CalDAV:** Microsoft hat den CalDAV-Zugang für
  Outlook.com abgeschaltet; ein CalDAV-Konto lässt sich dort gar nicht erst
  einrichten. Yuvomi schreibt stattdessen über die **Microsoft-Graph-API**
  (`server/services/outlook-calendar.js`) — und zwar nur in eine Richtung,
  Yuvomi → Outlook. Weil dabei Freitext-Inhalte an ein privates
  Microsoft-Konto gehen und ein AVV für solche Konten nicht existiert, hat
  dieser Kanal einen **eigenen Abschnitt 2.16**; die Bewertung in dieser
  Tabelle greift für ihn nicht.
- **Empfehlung:** Trage die konkret eingerichteten Sync-Endpoints in dein
  Verarbeitungsverzeichnis (Abschnitt 5) ein — Yuvomi kennt sie nicht zentral,
  jeder Nutzer kann andere konfigurieren.

### 2.4 OIDC-Provider (Single Sign-On)

- **Code-Stellen:** `server/auth.js`, `server/services/oidc.js`.
- **Aktiv nur, wenn:** du eine OIDC-Discovery-URL und Client-Credentials
  konfigurierst. Standard ist lokales Login.
- **Was wird übertragen:** Login-Identifier (E-Mail, Username, Subject-ID),
  ggf. Profilfelder (Name, Avatar), IP des Browsers während des Redirects.

**Empfehlung für DSGVO-Komfortzone:**

- **Bevorzugt EU-Provider:** Keycloak (selbst gehostet),
  Authentik (selbst gehostet), ZITADEL Cloud (EU-Region), Nextcloud-OIDC,
  Kanidm. Bei EU-Hosting entfällt die Drittland-Frage komplett.
- **Bei US-Providern (Google, Microsoft Entra ID, Auth0, Okta, AWS Cognito):**
  1. **DPF-Status verifizieren:** Anbieter auf
     `https://www.dataprivacyframework.gov/list` suchen. Microsoft, Google und
     Okta sind dort gelistet (Stand 2026-06-09 — bitte selbst nachprüfen).
  2. **AVV abschließen** (Art. 28 DSGVO). Microsoft: Product Terms +
     Data Protection Addendum (DPA). Google: Cloud Identity DPA.
  3. **TIA dokumentieren** — auch bei DPF empfiehlt die DSK eine kurze
     Bewertung (Stichworte: FISA 702, Cloud Act, Bulk-Interception).
  4. **In Datenschutzerklärung aufnehmen:** Empfänger, Zweck, Rechtsgrundlage
     Art. 6 Abs. 1 lit. f, Drittland-Hinweis.

**Hinweis Schrems III:** Eine NOYB-Klage gegen den DPF läuft. Sollte der
DPF fallen, brauchst du sofort SCCs + ergänzende Maßnahmen. Halte die
Konfiguration so, dass du auf einen EU-Provider umstellen könntest.

### 2.5 WebDAV-Backup

- **Code-Stelle:** `server/services/backup-webdav.js`, gesteuert via
  `server/routes/backup.js` und `server/services/backup-scheduler.js`.
- **Aktiv nur, wenn:** du WebDAV-Backups in deinen Backup-Einstellungen
  konfigurierst.
- **Was wird übertragen:** Backup-Archive deiner Yuvomi-Instanz mit allen
  SQLite-Nutzdaten — Kontakte, Termine, Notizen sowie Dokument-Metadaten und
  lokal gespeicherte Dokumentdateien. Dateien aus dem separaten
  WebDAV-Dokumentspeicher sind nicht enthalten. Das Backup ist
  datenschutzrechtlich ein besonders sensibler Datenstrom.
- **Drittland-Bewertung — abhängig vom Anbieter:**
  | Anbieter | Standort | Bewertung |
  |---|---|---|
  | Nextcloud-Instanz (selbst, EU-Hetzner, Hetzner Storage Box) | EU | kein Drittland; AVV mit Hoster |
  | Strato HiDrive, IONOS HiDrive Cloud | EU | AVV mit Strato/IONOS |
  | OneDrive (Microsoft) | USA | DPF + AVV (Microsoft DPA) |
  | Apple iCloud Drive (kein natives WebDAV, nicht empfohlen) | USA | nicht empfohlen |
  | pCloud (CH) | CH/USA | Angemessenheit CH; Region wählen, AVV abschließen |
- **AVV:** **immer** erforderlich, sobald Personendaten Dritter im Backup
  enthalten sind (also außerhalb der Haushaltsausnahme).
- **Empfehlung:** Verschlüssele Backups **vor** der Übertragung (Yuvomi bietet
  Backup-Verschlüsselung in den Einstellungen — aktivieren). Damit wird der
  WebDAV-Provider zum reinen Speicheranbieter ohne Klartextzugriff. Halte
  die Verschlüsselungs-Passphrase getrennt vom Backup-Speicherort.

### 2.6 WebDAV-Dokumentspeicher

- **Code-Stelle:** `server/services/document-storage.js`, gesteuert über
  `server/routes/documents.js`.
- **Aktiv nur, wenn:** ein Admin WebDAV als Ziel für neue Dokumentdateien
  aktiviert oder die entsprechenden `DOCUMENT_STORAGE_WEBDAV_*`-Variablen
  setzt.
- **Was wird übertragen:** neu hochgeladene Dokumentdateien einschließlich
  neuer Kalenderanhänge, außerdem Basic-Auth-Zugangsdaten und die IP-Adresse
  des Yuvomi-Servers. Dateinamen werden nicht als Objektpfad übernommen; die
  Dateien können dennoch unmittelbar personenbezogene oder besonders
  schützenswerte Inhalte enthalten.
- **Drittland und AVV:** Es gelten dieselben providerabhängigen Bewertungen
  wie beim WebDAV-Backup in Abschnitt 2.5. Bei einem kommerziellen Hoster ist
  außerhalb der Haushaltsausnahme ein AVV erforderlich; bei Anbietern außerhalb
  des EWR sind zusätzlich Angemessenheitsbeschluss, DPF oder SCCs mit TIA zu
  prüfen.
- **Empfehlung:** Bevorzuge einen selbst gehosteten oder in der EU betriebenen
  WebDAV-Dienst, beschränke den Zugriff auf ein eigenes Verzeichnis und sichere
  dieses Ziel separat. SQLite-Backups enthalten nur Metadaten und
  Speicher-Schlüssel, nicht die dort abgelegten Binärdateien.

### 2.7 Google-Drive-Dokumentspeicher

- **Code-Stelle:** `server/services/google-drive-storage.js`, gesteuert über die
  Dokumentenspeicher-Einstellungen. Aktiv erst nach OAuth-Verbindung **und**
  ausdrücklicher Auswahl als Upload-Ziel.
- **Was wird übertragen:** neue Dokumentdateien und Kalenderanhänge, generierte
  Dateinamen, Server-IP sowie OAuth-Zugriffs-/Refresh-Token. Yuvomi liest zusätzlich
  die Google-Kontoidentität (Permission-ID, E-Mail, Anzeigename) zur sicheren
  Wiederverbindung. Es wird ausschließlich der Scope `drive.file` angefordert.
- **Empfänger und Drittland:** Google LLC/Google Ireland; Verarbeitung kann in den
  USA stattfinden. Prüfe aktuellen DPF-Status, schließe den Google-AVV/DPA ab und
  dokumentiere bei Bedarf SCCs und TIA. Für besonders sensible Dokumente ist ein
  EU-gehosteter WebDAV- oder lokaler Speicher die datensparsamere Alternative.
- **Zugriffsgrenze:** Yuvomis Sichtbarkeitseinstellungen steuern nur den Zugriff
  über Yuvomi. Alle Personen mit Zugriff auf den verbundenen Google-Drive-Ordner
  `Yuvomi/Documents` können sämtliche dort gespeicherten Dateien sehen. Teile diesen Ordner nicht unnötig.
- **Löschung und Aufbewahrung:** Das Löschen eines Drive-Dokuments in Yuvomi löscht
  die zugehörige Drive-Datei; ein bereits fehlendes Objekt gilt als gelöscht.
  Trennen entfernt nur lokale Token und widerruft keine gemeinsam genutzten
  Google-Credentials. Google-Papierkorb-, Audit- und Backup-Fristen sind separat zu
  prüfen.
- **Backup:** SQLite-Backups enthalten Konto-/Datei-Referenzen, aber keine
  Drive-Binärdateien. Exportiere oder sichere den Ordner separat und bewahre ihn
  zusammen mit dem passenden Datenbankstand auf.

### 2.8 Abonnement-Integrationen

- **Standardverhalten:** Abonnementdaten, lokale Erinnerungen und Budgets
  bleiben vollständig in der selbst gehosteten Instanz. Externe Übertragungen
  erfolgen nur nach aktiver Konfiguration oder einem expliziten Logo-Aufruf.
- **Fixer:** Bei gesetztem `FIXER_API_KEY` werden Währungscodes und die
  Server-IP an Fixer übertragen. Namen einzelner Abonnements werden nicht
  gesendet.
- **Logo-Suche:** Überträgt die konfigurierte öffentliche HTTPS-Website und
  die Server-IP an den jeweiligen Website-Betreiber. Private, Loopback- und
  Link-Local-Ziele werden blockiert; Skripte der Website werden nicht
  ausgeführt.
- **Benachrichtigungsdienste:** Je nach Agent werden Name, Betrag, Währung und
  Fälligkeitsdatum eines Abonnements an SMTP, Discord, Telegram, Pushover,
  Gotify, Serverchan, Ntfy oder einen Webhook übertragen. Für private/LAN-Ziele
  ist eine ausdrückliche Deployment-Freigabe erforderlich. Dieselben Kanäle
  transportieren auch andere Erinnerungen der App — einschließlich
  Medikamenten-Erinnerungen, siehe Abschnitt 2.10.

### 2.9 MCP-Endpoint (KI-/Agent-Zugriff)

- **Code-Stellen:** `server/index.js` (Mount `/mcp`, nur mit
  Authentifizierung), `server/mcp/server.js`, `server/mcp/protocol.js`,
  `server/mcp/tools.js`; Token-Verwaltung `server/scopes.js`.
- **Was ist das?** Yuvomi stellt einen **MCP-Endpoint** bereit, über den ein
  **von dir angebundener** KI-/Agent-Client (MCP-Client) per API-Token auf
  Instanzdaten zugreifen und Tools ausführen kann. Der Endpoint ist
  **provider-neutral** - er funktioniert mit einem **lokal gehosteten LLM**
  (z. B. Ollama, LM Studio, llama.cpp) genauso wie mit einem Cloud-Client
  (z. B. Claude Desktop). Yuvomi selbst ruft **keinen** KI-Anbieter auf; der
  Client verbindet sich mit dem Endpoint und zieht die Daten.
- **Aktiv nur, wenn:** du in den Einstellungen ein **API-Token** erstellst und in
  einem MCP-Client hinterlegst. Ohne angebundenen Client verlässt kein Datum die
  Instanz.
- **Datenschutz — hängt an deiner Client-Wahl:**
  | Client | Datenfluss | Pflichten |
  |---|---|---|
  | **Lokales LLM / EU-gehostet** | Daten bleiben in der Instanz bzw. im EWR | **kein Drittland, kein AVV.** Datensparsamste Option. |
  | **Cloud-Client (z. B. US-Anbieter)** | Token-freigegebene Daten fließen an den Anbieter | Wie bei jedem Auftragsverarbeiter: **AVV (Art. 28)**, bei Drittland zusätzlich **Art. 44 ff.** (DPF/SCCs + TIA), Aufnahme in die **Datenschutzerklärung** (Art. 13). |
- **Empfehlungen:**
  1. **Least Privilege:** Erstelle das Token **nur mit den Modulen und Rechten**,
     die der Client wirklich braucht (die Token-UI bietet Modul- und
     Lese-/Schreib-Scoping). Schließe sensible Module wie `health` oder
     `housekeeping` aus, wenn nicht zwingend nötig.
  2. **Lokal/EU bevorzugen:** Ein lokal laufendes oder in der EU gehostetes Modell
     vermeidet den externen Transfer vollständig - dann entfallen AVV- und
     Drittland-Fragen für diesen Kanal.
  3. **Nur bei Cloud-Client:** Empfänger, Zweck, Rechtsgrundlage (i. d. R.
     Art. 6 Abs. 1 lit. a oder lit. f), Drittland-Hinweis und freigegebene
     Datenkategorien in die Datenschutzerklärung aufnehmen; AVV/DPF-Status prüfen.
  4. **Token widerrufbar halten:** Tokens einzeln widerrufbar; dokumentiere,
     welcher Client welches Token nutzt.

### 2.10 Web Push & Benachrichtigungs-Kanäle

- **Code-Stellen:** `server/services/push.js`, `server/services/push-scheduler.js`,
  `server/services/medication-scheduler.js`; Haushalts-Kanäle:
  `server/services/notification-channels.js`, `server/services/notification-providers/`.
- **Web Push — aktiv nur, wenn:** ein Nutzer Push auf einem Gerät einschaltet
  (Opt-in je Gerät unter Einstellungen → Persönlich → Benachrichtigungen).
  Der **Server** sendet die Nachricht dann an den Push-Dienst des jeweiligen
  Browsers — Google (FCM), Apple oder Mozilla, Verarbeitung in den USA möglich.
- **Was der Push-Dienst sieht:** Die Nachrichten-**Inhalte** (z. B. der
  Medikamentenname einer Erinnerung) sind nach dem Web-Push-Standard
  (RFC 8291) **Ende-zu-Ende zwischen Server und Browser verschlüsselt** — der
  Push-Dienst kann sie nicht lesen. Er sieht aber **Metadaten**: den
  Geräte-Endpoint, Zeitpunkt, Häufigkeit und Größe der Nachrichten, die IP
  deines Yuvomi-Servers und die `VAPID_SUBJECT`-Kontaktangabe.
- **Besonderheit Gesundheitsdaten:** Erinnerungen des Medikamenten-Moduls
  tragen den Medikamentennamen im (verschlüsselten) Inhalt. Aus den Metadaten
  allein ist das nicht erkennbar; wer auch das Metadaten-Muster vermeiden
  will, lässt Push für Gesundheits-Erinnerungen aus und nutzt die In-App-Anzeige.
- **Haushalts-Kanäle (Gotify, ntfy …):** Diese senden Erinnerungs-Inhalte —
  auch Medikamenten-Erinnerungen — im **Klartext** an den konfigurierten
  Dienst. Bei einem selbst gehosteten Gotify/ntfy im eigenen Netz bleibt alles
  bei dir; bei einem fremdbetriebenen Ziel (z. B. ntfy.sh) ist der Betreiber
  Empfänger von Gesundheitsdaten (Art. 9 DSGVO) — dann nur mit ausdrücklicher
  Einwilligung aller Betroffenen und AVV, besser: selbst hosten.
- **AVV:** Für die Browser-Push-Dienste nicht abschließbar (Infrastruktur des
  Browser-Herstellers); Transparenzhinweis in der Datenschutzerklärung genügt
  nach h. M., da Inhalte verschlüsselt sind. Für fremdbetriebene
  Gotify-/ntfy-Ziele: ja.

### 2.11 E-Mail-Versand (SMTP)

- **Code-Stelle:** `server/services/email.js`; genutzt vom
  Passwort-Reset-Flow, von Einladungs-Mails, vom SMTP-Verbindungstest und von
  Abonnement-Benachrichtigungen (Abschnitt 2.8).
- **Aktiv nur, wenn:** SMTP konfiguriert ist (Env oder
  Einstellungen → Administration → E-Mail).
- **Was wird übertragen:** Empfänger-Adresse, Betreff/Inhalt der jeweiligen
  Mail (Reset-Link mit Token, Einladungs-Link, Abo-Erinnerung), Absenderdaten
  und die IP deines Yuvomi-Servers — an den von dir konfigurierten SMTP-Server.
- **Drittland/AVV:** abhängig vom Mail-Provider — für EU-Provider
  (Mailbox.org, Posteo, eigener mailcow) unkritisch; bei US-Providern gelten
  dieselben DPF-/SCC-Überlegungen wie in Abschnitt 2.4. AVV bei kommerziellen
  Anbietern abschließen; Mail-Metadaten fallen zusätzlich beim Provider an.

### 2.12 Versions-/Changelog-Abruf (GitHub)

- **Code-Stelle:** `server/routes/changelog.js` — ein authentifizierter Proxy,
  der `api.github.com/repos/ulsklyc/yuvomi/releases` abruft.
- **Standard aktiv:** ja. Der Abruf passiert, wenn ein angemeldeter Nutzer den
  Änderungsverlauf öffnet bzw. die App nach einer neueren Version sieht
  (Versions-Hinweis an der Navigation); die Antwort wird serverseitig
  **30 Minuten gecacht**, sodass GitHub nicht bei jedem Klick kontaktiert wird.
- **Was wird übertragen:** ausschließlich die IP deines Yuvomi-Servers und der
  User-Agent `Yuvomi/1.0` — keine Nutzerdaten, keine Instanz-Kennung, keine
  installierte Version. Anfragen gehen vom Backend aus, nie vom Browser.
- **Drittland:** GitHub Inc./Microsoft, USA — DPF-zertifiziert (Status prüfen).
- **AVV:** nein (keine Verarbeitung personenbezogener Nutzerdaten im Auftrag);
  Transparenzhinweis in der Datenschutzerklärung genügt. Wer den Kanal ganz
  vermeiden will, blockiert ausgehende Verbindungen zu `api.github.com` — die
  App funktioniert dann vollständig weiter, nur Änderungsverlauf und
  Versions-Hinweis bleiben leer.

### 2.13 Mealie-Rezept-Sync

- **Code-Stellen:** `server/services/mealie/`, `server/services/mealie-sync.js`.
- **Aktiv nur, wenn:** ein Admin eine Mealie-Instanz verbindet
  (Einstellungen → Synchronisation).
- **Was wird übertragen:** API-Token, Rezeptdaten (Titel, Zutaten, Bilder-URLs)
  in beide Richtungen sowie die Server-IP — an die konfigurierte
  Mealie-Instanz.
- **Drittland/AVV:** Mealie ist typischerweise selbst gehostet im eigenen
  Netz — dann kein Drittland, kein AVV. Bei einer fremd betriebenen
  Mealie-Instanz gelten die üblichen Prüfungen (Standort, AVV).

### 2.14 DMS-Anbindung (Paperless-ngx / Papra)

- **Code-Stellen:** `server/services/dms/` (`paperless.js`, `papra.js`),
  `server/routes/dms.js`.
- **Aktiv nur, wenn:** ein Admin ein Dokumenten-Management-System verbindet.
- **Was wird übertragen:** API-Token, Dokument-Metadaten und -Inhalte im
  Rahmen der Anbindung sowie die Server-IP — an das konfigurierte DMS.
  Dokumente können besonders schützenswerte Inhalte tragen.
- **Drittland/AVV:** Paperless-ngx/Papra sind typischerweise selbst gehostet —
  dann kein Drittland, kein AVV. Bei gehosteten Angeboten: Standort und AVV
  prüfen; für sensible Dokumente EU-/Selbsthosting bevorzugen.

### 2.15 ICS-Kalender-Abos

- **Code-Stelle:** `server/services/ics-subscription.js`.
- **Aktiv nur, wenn:** ein Nutzer einen ICS-Feed abonniert.
- **Was wird übertragen:** Der Server **ruft** die konfigurierte Feed-URL
  regelmäßig **ab** (Intervall `SYNC_INTERVAL_MINUTES`). Zum Feed-Betreiber
  fließen dabei nur die IP deines Yuvomi-Servers und die Feed-URL selbst —
  die allerdings bei vielen Anbietern ein **privates Zugriffs-Token im Pfad**
  trägt. Kalenderdaten fließen ausschließlich herein, nie hinaus.
- **Drittland/AVV:** abhängig vom Feed-Anbieter; für reine Abrufe ohne
  Personenbezug genügt der Transparenzhinweis. Feed-URLs mit eingebettetem
  Token wie Zugangsdaten behandeln (sie erlauben jedem den Kalenderabruf).

### 2.16 Outlook-Push (Microsoft Graph)

- **Code-Stellen:** `server/services/outlook-calendar.js`,
  `server/routes/calendar/outlook.js`.
- **Was ist das?** Ein **einseitiger Push Yuvomi → Outlook.com** für private
  Microsoft-Konten (outlook.com, hotmail.com, M365 Family). Outlook.com bietet
  kein CalDAV mehr (siehe Abschnitt 2.3), deshalb läuft dieser Weg über die
  Microsoft-Graph-API. Yuvomi bleibt die führende Quelle: Änderungen in Outlook
  werden beim nächsten Lauf auf den Yuvomi-Stand zurückgesetzt.
- **Aktiv nur, wenn:** alle drei Variablen `MS_CLIENT_ID`, `MS_CLIENT_SECRET`
  und `MS_REDIRECT_URI` gesetzt sind **und** ein Admin ein Microsoft-Konto per
  OAuth verbunden hat. Fehlt eine der Variablen, ist der Kanal vollständig
  inert — es gibt keinen Weg, ein Konto ohne den OAuth-Flow anzulegen.
- **Endpunkte:** `login.microsoftonline.com/consumers/oauth2/v2.0`
  (Authorize/Token) und `graph.microsoft.com/v1.0`. Der `/consumers`-Pfad
  bedeutet: ausschließlich private Microsoft-Konten, keine Arbeits- oder
  Schulkonten.
- **Scopes:** `offline_access Calendars.ReadWrite User.Read` — kein Zugriff auf
  Mail, Kontakte oder Dateien.

**Was je Termin an Microsoft übertragen wird:**

| Feld | Übertragen? |
|---|---|
| Titel — **einschließlich der Anzeigenamen zugewiesener Mitglieder** (`Abendessen (Anna, Ben)`) | ja |
| Beschreibung/Notizen, als Klartext-Body | ja |
| Ort | ja, wenn gesetzt |
| Start/Ende, Ganztags-Kennzeichen, Zeitzone `Europe/Berlin` | ja |
| Wiederholungsregel | ja, wenn gesetzt |
| Teilnehmer, Erinnerungen, Anhänge, Farbe, Termin-Icon, Yuvomi-ID | **nein** |

- **Hinweis zu Gesundheitsdaten (Art. 9 DSGVO):** Titel, Beschreibung und Ort
  sind **Freitext**, und im Familienkalender steht dort typischerweise genau
  das — Arzttermine, Therapiestunden, Medikamente. Das medizinische Termin-Icon
  bleibt lokal, der Text nicht. Push-fähig sind auch automatisch erzeugte
  Termine, denn sie sind gewöhnliche lokale Termine: Geburtstage
  (`server/services/birthdays.js`) und Haushaltshilfe-Einsätze **samt Namen der
  Beschäftigten** (`server/routes/housekeeping.js`). Wer das nicht möchte, hält
  den Freitext knapp oder stellt den Termin auf `private` — er erreicht dann nur
  noch das Konto der erstellenden Person und nicht das eines anderen
  Familienmitglieds (siehe Sichtbarkeit).
- **Offenlegung gegenüber dem Kontoinhaber:** Der Auto-Sync schiebt Termine in
  das Postfach **einer** Person. Ist ein Termin anderen Familienmitgliedern
  zugewiesen, stehen deren Klarnamen im Titel in einem fremden
  Microsoft-Konto — eine Übermittlung an Microsoft **und** an den Kontoinhaber.
- **Was hereinkommt und gespeichert wird:** einmalig beim Verbinden das
  Graph-Profil (`id`, Anzeigename, `mail`/`userPrincipalName`), die Kalenderliste
  (Id, Name, Farbe, Schreibrecht) und je Zielkalender eine Liste aus Event-Id
  und `changeKey` zur Drift-Erkennung. **Inhalte fremder Outlook-Termine werden
  nie abgerufen**, und es gibt keinen Inbound-Sync: nichts aus Outlook wird zu
  Yuvomi-Termindaten.
- **Sichtbarkeit:** Der **Auto-Sync** respektiert die In-App-Sichtbarkeit —
  private Termine anderer Personen landen nicht im Postfach des Kontoinhabers.
  Ein **ausdrücklich am einzelnen Termin gesetztes** Outlook-Ziel wird dagegen
  nicht gefiltert; das entspricht dem Google-/CalDAV-Outbound und dem
  ICS-Export-Feed, denn die Sichtbarkeit ist eine In-App-Kontrolle und keine
  Ausleitungssperre.
- **Tokens:** Zugriffs- und Refresh-Token liegen pro Konto-Zeile in der Tabelle
  `outlook_accounts` — **im Klartext**, geschützt nur durch die optionale
  Datenbank-Verschlüsselung `DB_ENCRYPTION_KEY` (dieselbe Lage wie bei den
  Google-Tokens, Abschnitt 2.3). Über die API werden sie nie zurückgegeben. Bei
  privaten Microsoft-Konten verfallen Refresh-Token nach rund 90 Tagen ohne
  Nutzung; das Konto verlangt dann einen Reconnect.
- **Drittland:** Microsoft Corp., USA — DPF-zertifiziert, Status selbst prüfen
  (Abschnitt 6).
- **AVV: für private Microsoft-Konten nicht abschließbar.** Für ein
  outlook.com-Konto gilt der Microsoft-Servicevertrag: Microsoft tritt dort
  gegenüber dem **Kontoinhaber** auf, nicht als dein Auftragsverarbeiter — ein
  Vertrag nach Art. 28 DSGVO existiert für diese Konstellation schlicht nicht.
  **Konsequenz:** Außerhalb der Haushaltsausnahme (Abschnitt 4) ist dieser Kanal
  kaum rechtssicher zu betreiben. Im reinen Familienbetrieb greift Abschnitt 4
  und die Frage stellt sich nicht; sobald du Daten Dritter verarbeitest, ist die
  datenschutzkonforme Alternative ein CalDAV-Ziel (Abschnitt 2.3) statt Outlook.
  Ein AVV-fähiger Microsoft-Weg wäre Microsoft 365 Business gegen ein
  Arbeitskonto — den unterstützt Yuvomi wegen des `/consumers`-Endpunkts nicht.
- **Löschung und Aufbewahrung:**
  1. Ein in Yuvomi gelöschter Termin wird erst im **nächsten Sync-Lauf** in
     Outlook gelöscht (bis zu `SYNC_INTERVAL_MINUTES` Verzug, Default 15 Minuten).
     Dasselbe gilt, wenn ein Termin die Sichtbarkeit für den Kontoinhaber
     verliert oder sein Ziel verliert.
  2. **Beim Trennen eines Kontos bleiben bereits gepushte Termine in Outlook
     stehen.** Wer sie loswerden will, löscht sie **vor** dem Trennen in Yuvomi
     (oder anschließend von Hand in Outlook).
  3. Die lokalen Tokens werden beim Trennen gelöscht, **ein Widerruf bei
     Microsoft erfolgt aber nicht**. Entziehe die Freigabe zusätzlich unter
     <https://account.live.com/consent/Manage>, sonst bleibt die erteilte
     Berechtigung dort bestehen.
- **Intervall:** der gemeinsame Sync-Lauf (`SYNC_INTERVAL_MINUTES`, Default
  15 Minuten), zusätzlich einmal beim Serverstart, direkt nach dem
  OAuth-Callback und über einen manuellen Admin-Trigger.
- **Empfehlungen:** einen **dedizierten Kalender** in Outlook als Ziel wählen
  (nicht den Hauptkalender), `DB_ENCRYPTION_KEY` setzen, damit die Tokens nicht
  im Klartext auf der Platte liegen, und bei Gesundheitsbezug den Freitext knapp
  halten. Das Client-Secret der Entra-App gehört wie ein Passwort behandelt und
  läuft nach spätestens 24 Monaten ab.

---

## 3. Logging und Speicherbegrenzung (Art. 5 Abs. 1 lit. e DSGVO)

Yuvomi verwendet einen **eigenen, dependency-freien Logger**
(`server/logger.js`): strukturierte JSON-Ausgabe nach `stdout` in der
Produktion, lesbar in der Entwicklung, gesteuert über die Umgebungsvariable
`LOG_LEVEL` (Default `info`). Es kommt **kein** externer Logging-Dienst zum
Einsatz, und es gibt **kein** Access-Logging, das pauschal jede Anfrage mit
IP/User-Agent protokolliert.

**Was die App an personenbeziehbaren Daten loggt:**

- **Fehlgeschlagene/blockierte Login-Versuche** schreiben die **Client-IP**
  (`req.ip`) zusammen mit dem versuchten Benutzernamen und dem Grund
  (`server/auth.js`). Zweck: Erkennung von Brute-Force-/Missbrauchsversuchen
  (berechtigtes Interesse, Art. 6 Abs. 1 lit. f DSGVO).
- Der **globale Error-Handler** (`server/index.js`) loggt **nur das
  Fehler-Objekt** (Name, Message, Stacktrace) — **keine** Client-IP und
  **keinen** User-Agent.
- Ein User-Agent-String wird durch die App **nicht** geloggt.

**Rechtslage:** IP-Adressen sind personenbezogene Daten i. S. v. Art. 4 Nr. 1
DSGVO (EuGH C-582/14 „Breyer", 19.10.2016). Art. 5 Abs. 1 lit. e DSGVO verlangt
Speicherbegrenzung — sicherheitsrelevante Login-Logs dürfen also nicht „für
immer" liegenbleiben.

**Konkrete Empfehlungen für Selfhoster:**

1. **Maximale Aufbewahrungsdauer: 30 Tage.** Für reine Betriebs-Logs hält die
   DSK 7–14 Tage für ausreichend; bei Sicherheits-Logs sind bis 90 Tage
   vertretbar, wenn dokumentiert. 30 Tage sind ein guter Default.
2. **Docker-Setup:** in `docker-compose.yml` Log-Rotation aktivieren:

   ```yaml
   services:
     yuvomi:
       logging:
         driver: json-file
         options:
           max-size: "10m"
           max-file: "5"
   ```

   Damit rotiert Docker automatisch und es bleiben max. 50 MB Logs pro
   Container vorhanden.
3. **Systemd-Setup:** in `journald.conf` (`/etc/systemd/journald.conf.d/`):

   ```ini
   [Journal]
   MaxRetentionSec=30day
   SystemMaxUse=500M
   ```

4. **Reverse Proxy:** Wenn du Caddy/Traefik/Nginx vorschaltest, protokolliert
   **dieser** in der Regel jede Anfrage mit Client-IP. Konfiguriere dort
   separat eine Retention (z. B. logrotate `daily`/`rotate 30`) oder schalte
   das Access-Log ab, wenn du es nicht brauchst.
5. **PII-Reduktion:** Setze in der Produktion `LOG_LEVEL=info` (nicht `debug`)
   und vermeide es, eigene Logs mit personenbezogenen Payloads zu erweitern.
6. **Dokumentation:** Trage die gewählte Retention in dein
   Verarbeitungsverzeichnis (Abschnitt 5) ein.

---

## 4. Haushaltsausnahme (Art. 2 Abs. 2 lit. c DSGVO)

> Die DSGVO gilt nicht für die Verarbeitung personenbezogener Daten
> „durch natürliche Personen zur Ausübung **ausschließlich persönlicher oder
> familiärer Tätigkeiten**".

Wenn du Yuvomi **nur für dich selbst** oder **mit Familienmitgliedern unter
einem Dach** betreibst (klassischer „Haushalts-Kalender, Einkaufsliste,
Geburtstage in der Familie") und **keine Daten Dritter** verarbeitest, greift
diese Ausnahme. Dann brauchst du keine Datenschutzerklärung, kein VVT und
keinen AVV.

**Ausnahme von der Ausnahme — DSGVO greift dann doch:**

- Du speicherst Kontakte von Personen **außerhalb** deiner Familie (Freunde,
  Kollegen) und nutzt diese in einer Weise, die über reine private
  Kommunikation hinausgeht.
- Du nutzt Yuvomi für **berufliche/geschäftliche Zwecke** (z. B. Steuerberater,
  Selbstständiger, Verein).
- Du gibst Zugang zur Instanz an Personen **außerhalb deines Haushalts**
  (Babysitter, Pflegekraft, Putzhilfe — sobald deren Daten dort liegen).
- Die Instanz ist **öffentlich aus dem Internet erreichbar** und du erlaubst
  Registrierungen Dritter.

**EuGH zur Reichweite (zur Vorgängernorm RL 95/46):** C-101/01 „Lindqvist"
(06.11.2003) und C-212/13 „Ryneš" (11.12.2014) legen die Ausnahme **eng** aus
— im Zweifel: Vorsicht walten lassen, DSGVO als anwendbar behandeln.

---

## 5. Verarbeitungsverzeichnis-Vorlage (Art. 30 DSGVO)

Diese Tabelle ist ein **Ausgangspunkt**, kein vollständiges VVT. Trage deine
konkrete Konfiguration ein und ergänze um eigene Verarbeitungen.

### 5.1 Stammdaten Verantwortlicher

| Feld | Inhalt |
|---|---|
| Verantwortlicher | <<BITTE ERGÄNZEN: Name, Anschrift, ggf. Vertreter>> |
| Kontakt Datenschutz | <<BITTE ERGÄNZEN: E-Mail, ggf. DSB nach § 38 BDSG ab 20 ständig mit automatisierter Verarbeitung befassten Personen>> |

### 5.2 Verarbeitungstätigkeiten

| # | Bezeichnung | Zweck | Rechtsgrundlage | Kategorien Betroffener | Kategorien Daten | Empfänger | Drittland | Löschfrist | TOMs |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Nutzerkonten / Authentifizierung | Login, Identifizierung | Art. 6 Abs. 1 lit. b | Nutzer der Instanz | E-Mail, Username, Passwort-Hash | <<OIDC-Provider falls aktiv>> | <<EU/Drittland>> | bis Account-Löschung | bcrypt-Hash (Cost 12), HTTPS |
| 2 | Kalender / Termine | Haushaltskoordination | Art. 6 Abs. 1 lit. b; bei Gesundheitsangaben im Freitext zusätzlich Art. 9 Abs. 2 lit. a | Nutzer, ggf. Eingeladene | Termintitel, Teilnehmer, Ort, Freitext-Notizen (ggf. Gesundheitsangaben) | CalDAV-Server, Google Calendar und/oder Outlook/Microsoft Graph (falls Sync) | <<je nach Anbieter; Google/Microsoft ggf. USA>> | bis Löschung durch Nutzer; Outlook-Push löscht erst im nächsten Sync-Lauf, beim Trennen gar nicht | TLS, AVV (für private Microsoft-Konten nicht abschließbar, siehe 2.16) |
| 3 | Kontakte / CardDAV | Adressbuch | Art. 6 Abs. 1 lit. b/f | Nutzer, Kontakte | Name, Adresse, Telefon, E-Mail | CardDAV-Server (falls Sync) | <<je nach Anbieter>> | bis Löschung | TLS, AVV |
| 4 | Wetter | Anzeige Vorhersage | Art. 6 Abs. 1 lit. b | Nutzer | Koordinaten/Ortsname | Open-Meteo (CH); ggf. OpenWeather (UK) | CH/UK Angemessenheit | sofort nach Anfrage | TLS |
| 5 | Backups | Datensicherung | Art. 6 Abs. 1 lit. f | Nutzer und alle Datensubjekte der App | Vollbackup der DB | <<WebDAV-Provider>> | <<je nach Anbieter>> | <<Aufbewahrungs-Konzept, z. B. 30 Tage rollierend>> | Verschlüsselung vor Upload, AVV |
| 6 | Dokumentablage | Gemeinsame Ablage und Kalenderanhänge | Art. 6 Abs. 1 lit. b/f | Nutzer und in Dokumenten genannte Personen | Dokumentdateien, Anhänge, Metadaten | <<lokaler Hoster, WebDAV-Provider oder Google Drive, falls aktiv>> | <<je nach Anbieter; Google ggf. USA>> | bis Löschung durch Nutzer, Provider-Papierkorb prüfen | TLS, eigener Pfad, AVV, Drive-ACL-Grenze, separates Backup |
| 7 | Sicherheits-/Betriebs-Logs | Missbrauchserkennung, Fehlersuche | Art. 6 Abs. 1 lit. f | Nutzer / Login-Versuchende | IP bei fehlgeschlagenen Logins, Fehler-Stacktraces | nur lokal | nein | **max. 30 Tage** | Rotation, Zugangsbeschränkung |
| 8 | MCP-/KI-Anbindung (falls genutzt) | Zugriff eines angebundenen KI-/Agent-Clients auf Instanzdaten | Art. 6 Abs. 1 lit. a/f; bei Art.-9-Daten zusätzlich Art. 9 Abs. 2 lit. a | Nutzer und in den Daten genannte Personen | je nach Token-Scope: Aufgaben, Termine, Einkauf, ggf. health/housekeeping | lokaler Client: keiner · Cloud: <<Anbieter>> | lokaler Client: nein · Cloud: <<je nach Anbieter>> | bis Token-Widerruf | Token-Scoping (Least Privilege), TLS; bei Cloud: AVV, DPF/SCCs+TIA |
| 9 | Benachrichtigungen (Web Push / Kanäle / SMTP, falls genutzt) | Zustellung von Erinnerungen und Hinweisen | Art. 6 Abs. 1 lit. a/b; bei Medikamenten-Erinnerungen Art. 9 Abs. 2 lit. a | Nutzer der Instanz | Erinnerungsinhalte (ggf. Medikamentenname), Geräte-Endpoints, E-Mail-Adressen | Push-Dienst des Browsers (Inhalte verschlüsselt) · <<Gotify/ntfy-Ziel>> · <<SMTP-Provider>> | Push: USA möglich · sonst <<je nach Ziel>> | bis Abbestellung/Geräte-Abmeldung | RFC-8291-Verschlüsselung (Push), TLS, Selbsthosting der Kanäle |

### 5.3 Auftragsverarbeiter (Art. 28)

| Auftragsverarbeiter | Leistung | AVV abgeschlossen am | Drittland | Garantien |
|---|---|---|---|---|
| <<z. B. Hetzner Online GmbH>> | Server-Hosting | <<Datum>> | DE | AVV nach Art. 28; ISO 27001 |
| <<OpenWeather Ltd.>> | Wetter-API (falls aktiv) | <<Datum>> | UK | Angemessenheit; DPA |
| <<OIDC-Provider>> | Authentifizierung | <<Datum>> | <<EU/USA>> | <<AVV; ggf. DPF + SCCs>> |
| <<WebDAV-Provider>> | Backup- und/oder Dokument-Storage | <<Datum>> | <<je nach Anbieter>> | <<AVV; Verschlüsselung für Backups; Zugriffsbeschränkung>> |
| <<Google Ireland/Google LLC>> | Google-Drive-Dokumentspeicher (falls aktiv) | <<Datum>> | EU/USA | <<Google-DPA; DPF-Status; ggf. SCCs/TIA; drive.file>> |
| <<Microsoft Corp.>> | Outlook-Kalender-Push (falls aktiv) | **entfällt — kein AVV für private Konten** | USA | <<DPF-Status; Microsoft-Servicevertrag statt AVV; außerhalb der Haushaltsausnahme CalDAV-Ziel bevorzugen — siehe 2.16>> |

---

## 6. Quellen

- DSGVO konsolidiert (EUR-Lex CELEX 32016R0679):
  <https://eur-lex.europa.eu/legal-content/DE/TXT/?uri=CELEX:32016R0679>
- BDSG: <https://www.gesetze-im-internet.de/bdsg_2018/>
- Liste der Angemessenheitsbeschlüsse der EU-Kommission:
  <https://commission.europa.eu/law/law-topic/data-protection/international-dimension-data-protection/adequacy-decisions_en>
- UK-Angemessenheitsbeschluss 2021/1772:
  <https://eur-lex.europa.eu/legal-content/DE/TXT/?uri=CELEX:32021D1772>
- Verlängerung 2025/650:
  <https://eur-lex.europa.eu/legal-content/DE/TXT/?uri=CELEX:32025D0650>
- CH-Angemessenheitsbeschluss 2000/518/EG:
  <https://eur-lex.europa.eu/legal-content/DE/TXT/?uri=CELEX:32000D0518>
- EU-US Data Privacy Framework 2023/1795:
  <https://eur-lex.europa.eu/legal-content/DE/TXT/?uri=CELEX:32023D1795>
- DPF-Liste:
  <https://www.dataprivacyframework.gov/list>
- DSK – Anwendungshinweise zum EU-US-DPF (04.09.2023):
  <https://www.datenschutzkonferenz-online.de/media/ah/230904_DSK_Ah_EU_US.pdf>
- EuGH C-582/14 „Breyer" (IP-Adressen als personenbezogene Daten):
  <https://curia.europa.eu/juris/liste.jsf?num=C-582/14>
- EuGH C-311/18 „Schrems II":
  <https://curia.europa.eu/juris/liste.jsf?num=C-311/18>
- EuGH C-212/13 „Ryneš" (enge Auslegung Haushaltsausnahme):
  <https://curia.europa.eu/juris/liste.jsf?num=C-212/13>
- EuGH C-101/01 „Lindqvist":
  <https://curia.europa.eu/juris/liste.jsf?num=C-101/01>
- BfDI – FAQ Drittland-Transfer:
  <https://www.bfdi.bund.de/DE/Buerger/Inhalte/AllgemeinDSGVO/InternationalerDatenverkehr/DrittstaatenuebermittlungArt44ff.html>
- EDSA Empfehlungen 01/2020 (ergänzende Maßnahmen):
  <https://edpb.europa.eu/our-work-tools/our-documents/recommendations/recommendations-012020-measures-supplement-transfer_de>
- Open-Meteo Datenschutz:
  <https://open-meteo.com/en/terms>
- OpenWeather Datenschutz / DPA:
  <https://openweather.co.uk/privacy-policy>

---

**Hinweis zur Aktualität:** Bitte Stand der Angemessenheitsbeschlüsse, des
DPF und der DPF-Listung deiner Dienstleister mindestens **halbjährlich**
verifizieren. Eine zentrale Quelle ist die o. g. Kommissions-Seite.
