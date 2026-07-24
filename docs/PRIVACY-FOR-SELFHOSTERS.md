# Datenschutz-Hinweise für Selfhoster (Yuvomi)

> **Stand: 14.07.2026** - Diese Hinweise sind eine technisch orientierte
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
| OIDC-Provider | `server/auth.js`, `server/services/oidc.js` | nur wenn konfiguriert | abhängig vom Provider | meistens ja (siehe 2.4) |
| WebDAV-Backup | `server/services/backup-webdav.js` | nur wenn konfiguriert | abhängig vom Provider | ja, bei kommerziellen Anbietern (siehe 2.5) |
| WebDAV-Dokumentspeicher | `server/services/document-storage.js` | nur wenn konfiguriert | abhängig vom Provider | ja, bei kommerziellen Anbietern (siehe 2.6) |
| Google-Drive-Dokumentspeicher | `server/services/google-drive-storage.js` | nur nach OAuth-Verbindung und expliziter Auswahl | USA/Google; DPF-Status prüfen | ja (siehe 2.7) |
| Abonnement-Integrationen | `server/services/subscription-*` | nur wenn konfiguriert/ausgelöst | abhängig von Fixer, Benachrichtigungs- oder KI-Provider | abhängig vom Provider (siehe 2.8) |
| MCP-Endpoint (KI-/Agent-Zugriff) | `server/index.js:338`, `server/mcp/*` | nur wenn Nutzer ein API-Token erstellt und einen MCP-Client anbindet | **lokaler Client: nein** · Cloud-Client: abhängig vom Anbieter | lokaler Client: nein · Cloud-Client: ggf. gegenüber dem Anbieter (siehe 2.9) |

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
  | Mailbox-Provider Drittland (sonstige) | Einzelfall | individuelle TIA |
- **AVV:** ja, bei kommerziellen Anbietern.
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
  ist eine ausdrückliche Deployment-Freigabe erforderlich.

### 2.9 MCP-Endpoint (KI-/Agent-Zugriff)

- **Code-Stellen:** `server/index.js:338` (Mount `/mcp`, nur mit
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
| 2 | Kalender / Termine | Haushaltskoordination | Art. 6 Abs. 1 lit. b | Nutzer, ggf. Eingeladene | Termintitel, Teilnehmer, Ort | CalDAV-Server (falls Sync) | <<je nach Anbieter>> | bis Löschung durch Nutzer | TLS, AVV |
| 3 | Kontakte / CardDAV | Adressbuch | Art. 6 Abs. 1 lit. b/f | Nutzer, Kontakte | Name, Adresse, Telefon, E-Mail | CardDAV-Server (falls Sync) | <<je nach Anbieter>> | bis Löschung | TLS, AVV |
| 4 | Wetter | Anzeige Vorhersage | Art. 6 Abs. 1 lit. b | Nutzer | Koordinaten/Ortsname | Open-Meteo (CH); ggf. OpenWeather (UK) | CH/UK Angemessenheit | sofort nach Anfrage | TLS |
| 5 | Backups | Datensicherung | Art. 6 Abs. 1 lit. f | Nutzer und alle Datensubjekte der App | Vollbackup der DB | <<WebDAV-Provider>> | <<Aufbewahrungs-Konzept, z. B. 30 Tage rollierend>> | Verschlüsselung vor Upload, AVV |
| 6 | Dokumentablage | Gemeinsame Ablage und Kalenderanhänge | Art. 6 Abs. 1 lit. b/f | Nutzer und in Dokumenten genannte Personen | Dokumentdateien, Anhänge, Metadaten | <<lokaler Hoster, WebDAV-Provider oder Google Drive, falls aktiv>> | <<je nach Anbieter; Google ggf. USA>> | bis Löschung durch Nutzer, Provider-Papierkorb prüfen | TLS, eigener Pfad, AVV, Drive-ACL-Grenze, separates Backup |
| 7 | Sicherheits-/Betriebs-Logs | Missbrauchserkennung, Fehlersuche | Art. 6 Abs. 1 lit. f | Nutzer / Login-Versuchende | IP bei fehlgeschlagenen Logins, Fehler-Stacktraces | nur lokal | nein | **max. 30 Tage** | Rotation, Zugangsbeschränkung |
| 8 | MCP-/KI-Anbindung (falls genutzt) | Zugriff eines angebundenen KI-/Agent-Clients auf Instanzdaten | Art. 6 Abs. 1 lit. a/f; bei Art.-9-Daten zusätzlich Art. 9 Abs. 2 lit. a | Nutzer und in den Daten genannte Personen | je nach Token-Scope: Aufgaben, Termine, Einkauf, ggf. health/housekeeping | lokaler Client: keiner · Cloud: <<Anbieter>> | lokaler Client: nein · Cloud: <<je nach Anbieter>> | bis Token-Widerruf | Token-Scoping (Least Privilege), TLS; bei Cloud: AVV, DPF/SCCs+TIA |

### 5.3 Auftragsverarbeiter (Art. 28)

| Auftragsverarbeiter | Leistung | AVV abgeschlossen am | Drittland | Garantien |
|---|---|---|---|---|
| <<z. B. Hetzner Online GmbH>> | Server-Hosting | <<Datum>> | DE | AVV nach Art. 28; ISO 27001 |
| <<OpenWeather Ltd.>> | Wetter-API (falls aktiv) | <<Datum>> | UK | Angemessenheit; DPA |
| <<OIDC-Provider>> | Authentifizierung | <<Datum>> | <<EU/USA>> | <<AVV; ggf. DPF + SCCs>> |
| <<WebDAV-Provider>> | Backup- und/oder Dokument-Storage | <<Datum>> | <<je nach Anbieter>> | <<AVV; Verschlüsselung für Backups; Zugriffsbeschränkung>> |
| <<Google Ireland/Google LLC>> | Google-Drive-Dokumentspeicher (falls aktiv) | <<Datum>> | EU/USA | <<Google-DPA; DPF-Status; ggf. SCCs/TIA; drive.file>> |

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
