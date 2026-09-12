export const ENV_SCHEMA = [
  { key: 'SESSION_SECRET',              type: 'auto',    label: 'Session Secret',           required: true,  group: 'core',    writeToEnv: true },
  { key: 'DB_ENCRYPTION_KEY',           type: 'auto',    label: 'Database Encryption Key',  required: true,  group: 'core',    writeToEnv: true },
  { key: 'WEATHER_LAT',                 type: 'user',    label: 'Weather Latitude',         required: false, group: 'weather', writeToEnv: true },
  { key: 'WEATHER_LON',                 type: 'user',    label: 'Weather Longitude',        required: false, group: 'weather', writeToEnv: true },
  { key: 'WEATHER_CITY',                type: 'default', label: 'City Display Name',        default: '',       group: 'weather', writeToEnv: true },
  { key: 'WEATHER_UNITS',               type: 'default', label: 'Units',                    default: 'metric', group: 'weather', writeToEnv: true },
  { key: 'FIXER_API_KEY',               type: 'user',    label: 'Fixer API Key',            required: false, group: 'subscriptions', writeToEnv: true, secret: true },
  // E-Mail / SMTP für „Passwort vergessen". Alle optional; ohne HOST bleibt der
  // Versand deaktiviert. Passwort wird als Secret maskiert.
  { key: 'EMAIL_SMTP_HOST',             type: 'user',    label: 'SMTP Host',                required: false, group: 'email',   writeToEnv: true },
  { key: 'EMAIL_SMTP_PORT',             type: 'default', label: 'SMTP Port',                default: '587',  group: 'email',   writeToEnv: true },
  { key: 'EMAIL_SMTP_SECURE',           type: 'default', label: 'SMTP Security',            default: 'starttls', group: 'email', writeToEnv: true },
  { key: 'EMAIL_SMTP_USER',             type: 'user',    label: 'SMTP Username',            required: false, group: 'email',   writeToEnv: true },
  { key: 'EMAIL_SMTP_PASS',             type: 'user',    label: 'SMTP Password',            required: false, group: 'email',   writeToEnv: true, secret: true },
  { key: 'EMAIL_FROM_ADDRESS',          type: 'user',    label: 'From Address',             required: false, group: 'email',   writeToEnv: true },
  { key: 'EMAIL_FROM_NAME',             type: 'default', label: 'From Name',                default: '',     group: 'email',   writeToEnv: true },
  { key: 'GOOGLE_CLIENT_ID',            type: 'user',    label: 'Google Client ID',         required: false, group: 'google',  writeToEnv: true },
  { key: 'GOOGLE_CLIENT_SECRET',        type: 'user',    label: 'Google Client Secret',     required: false, group: 'google',  writeToEnv: true },
  { key: 'GOOGLE_REDIRECT_URI',         type: 'user',    label: 'Google Redirect URI',      required: false, group: 'google',  writeToEnv: true },
  { key: 'GOOGLE_DRIVE_CLIENT_ID',      type: 'user',    label: 'Google Drive Client ID',   required: false, group: 'googleDrive', writeToEnv: true },
  { key: 'GOOGLE_DRIVE_CLIENT_SECRET',  type: 'user',    label: 'Google Drive Client Secret', required: false, group: 'googleDrive', writeToEnv: true, secret: true },
  { key: 'GOOGLE_DRIVE_REDIRECT_URI',   type: 'user',    label: 'Google Drive Redirect URI', required: false, group: 'googleDrive', writeToEnv: true },
  { key: 'APPLE_USERNAME',              type: 'user',    label: 'Apple ID (email)',          required: false, group: 'apple',   writeToEnv: true },
  { key: 'APPLE_APP_SPECIFIC_PASSWORD', type: 'user',    label: 'App-Specific Password',    required: false, group: 'apple',   writeToEnv: true },
  { key: 'APPLE_CALDAV_URL',            type: 'default', label: 'CalDAV URL',               default: 'https://caldav.icloud.com', group: 'apple', writeToEnv: true },
  // Outlook-Push (Microsoft Graph), optional; alle drei zusammen oder keiner.
  // Die Redirect-URI leitet der Wizard aus der geplanten Origin ab
  // (.../api/v1/calendar/outlook/callback), wie bei Google Calendar.
  { key: 'MS_CLIENT_ID',                type: 'user',    label: 'Microsoft Client ID',      required: false, group: 'outlook', writeToEnv: true },
  { key: 'MS_CLIENT_SECRET',            type: 'user',    label: 'Microsoft Client Secret',  required: false, group: 'outlook', writeToEnv: true, secret: true },
  { key: 'MS_REDIRECT_URI',             type: 'user',    label: 'Microsoft Redirect URI',   required: false, group: 'outlook', writeToEnv: true },
  { key: 'SYNC_INTERVAL_MINUTES',       type: 'default', label: 'Sync Interval (minutes)', default: '15',   group: 'sync',    writeToEnv: true },
  // ICS-Abos: der SSRF-Guard blockt Feeds im eigenen LAN (Home Assistant, *arr).
  // Ohne diesen Schalter scheitert genau der häufigste Self-Hoster-Fall stumm.
  { key: 'ICS_SUBSCRIPTION_ALLOW_PRIVATE_NETWORK', type: 'default', label: 'Allow ICS Feeds from Private Network', default: 'false', required: false, group: 'sync', writeToEnv: true },
  // Rezept-Provider-Spiegel (Mealie/Tandoor): derselbe SSRF-Guard, derselbe
  // häufigste Self-Hoster-Fall wie bei den ICS-Abos oben.
  { key: 'RECIPE_PROVIDER_ALLOW_PRIVATE_NETWORK', type: 'default', label: 'Allow Private Network Recipe Provider Target', default: 'false', required: false, group: 'sync', writeToEnv: true },
  // Waste-URL-Quellen (#1063 Phase 7): derselbe SSRF-Guard, derselbe häufigste
  // Self-Hoster-Fall wie bei den ICS-Abos/Rezept-Providern oben - ein
  // kommunales Abfuhrkalender-Feed im eigenen LAN scheitert sonst stumm.
  { key: 'WASTE_SOURCE_ALLOW_PRIVATE_NETWORK', type: 'default', label: 'Allow Waste Source Feeds from Private Network', default: 'false', required: false, group: 'sync', writeToEnv: true },
  // Zeitzone des Containers: Logzeitstempel und Backup-Cron, und der DEFAULT für
  // die Haushaltszone. Seit v2.34.0 (#829) ist die Haushaltszone eine eigene
  // Einstellung in der App (sync_config `household_timezone`) und gewinnt, wo es
  // beide gibt - deshalb bleibt dieser Wert hier eine Vorbelegung und wird nicht
  // zur einzigen Möglichkeit, die Zone zu setzen.
  { key: 'TZ',                          type: 'default', label: 'Timezone',                 default: 'UTC',  group: 'system',  writeToEnv: true },
  { key: 'OIKOS_HTTP_PORT',             type: 'default', label: 'HTTP Port',                default: '3000', group: 'system',  writeToEnv: true },
  // Host-Ordner für Datenbank und App-Daten. Der Container-Pfad steht fest, der
  // Host-Pfad ist auf einem NAS der erste Handgriff (Daten aufs Array, nicht
  // neben die Compose-Datei). Ohne Eintrag im Installer musste er von Hand in
  // die .env - und ein zweiter Lauf hätte ihn wieder gelöscht.
  { key: 'DATA_DIR',                    type: 'default', label: 'Host Data Folder',         default: './data', required: false, group: 'system', writeToEnv: true },
  // BACKUP_DIR und MODULES_DIR fehlen hier bewusst, und der Grund ist EINE Regel,
  // nicht zwei Einzelfaelle: DATA_DIR steht im Wizard, weil die App den Namen NIE
  // liest - er existiert ausschliesslich als Compose-Substitution fuer die
  // Mount-Quelle. BACKUP_DIR und MODULES_DIR liest die App dagegen selbst
  // (server/services/backup-scheduler.js, server/services/modules.js), und dort
  // bedeutet der Name etwas anderes: das Ziel IM Container. Ein Host-Pfad wie
  // './backups' in der .env wird dort zu /app/backups, ausserhalb des gemounteten
  // Volumes und fuer den node-User nicht anlegbar - das war #579.
  //
  // Die Compose-Descriptoren fangen das ab, indem sie BACKUP_DIR unter
  // "environment:" auf /backups pinnen (environment schlaegt env_file), und ein
  // Guard erzwingt das in jedem Ziel. Darauf ruht die Ausnahme aber NICHT: die
  // .env.example warnt ausdruecklich davor, die Datei einem blanken
  // "docker run --env-file" zu geben, und dort gibt es kein Override. MODULES_DIR
  // pinnt ohnehin kein Descriptor.
  //
  // Wer die Sicherungen auf ein NAS-Array legen will, aendert deshalb den MOUNT
  // in der Compose-Datei, nicht diese Variable - so steht es in
  // docs/installation.md. Ein Wizard-Feld waere der bequemere und der falsche Weg.
  // Absolute Origin für Passwort-Reset-Links & Push. Vom Installer aus Schema/Host/Port
  // abgeleitet, nie aus dem Request-Host-Header (Reset-Poisoning-Schutz).
  { key: 'BASE_URL',                    type: 'default', label: 'Base URL',                 default: '',     group: 'system',  writeToEnv: true },
  // Reverse-Proxy / HTTPS. SESSION_SECURE wird nur für Direktzugriff ohne HTTPS
  // geschrieben (=false); hinter einem Proxy bleibt der sichere Default aktiv.
  { key: 'SESSION_SECURE',              type: 'user',    label: 'Secure Session Cookies',   required: false, group: 'proxy',   writeToEnv: true },
  { key: 'TRUST_PROXY',                 type: 'user',    label: 'Trust Proxy',              required: false, group: 'proxy',   writeToEnv: true },
  // Single Sign-On (OIDC). Server aktiviert OIDC nur, wenn alle vier gesetzt sind.
  { key: 'OIDC_ISSUER',                 type: 'user',    label: 'OIDC Issuer',              required: false, group: 'oidc',    writeToEnv: true },
  { key: 'OIDC_CLIENT_ID',              type: 'user',    label: 'OIDC Client ID',           required: false, group: 'oidc',    writeToEnv: true },
  { key: 'OIDC_CLIENT_SECRET',          type: 'user',    label: 'OIDC Client Secret',       required: false, group: 'oidc',    writeToEnv: true },
  { key: 'OIDC_REDIRECT_URI',           type: 'user',    label: 'OIDC Redirect URI',        required: false, group: 'oidc',    writeToEnv: true },
  // Manche IdPs (u. a. Authentik in Standardkonfiguration) liefern kein
  // email_verified. Ohne diesen Schalter verweigert die Anmeldung dort die
  // Kontoverknüpfung, ohne dass irgendwo stünde, warum.
  { key: 'OIDC_TRUST_EMAIL_WITHOUT_VERIFIED_CLAIM', type: 'default', label: 'Trust Email Without Verified Claim', default: 'false', required: false, group: 'oidc', writeToEnv: true },
  // Wer den IdP nicht nur fuer diesen Haushalt betreibt, teilt sonst sein
  // ganzes Verzeichnis: bisher bekam jeder, der sich dort anmelden konnte,
  // beim ersten SSO-Klick ungefragt ein Konto (#654). Default 'true' - jede
  // bestehende Installation bleibt nach dem Update, wie sie war.
  { key: 'OIDC_ALLOW_SIGNUP',           type: 'default', label: 'Allow SSO Account Creation', default: 'true', required: false, group: 'oidc', writeToEnv: true },
  // SSO als einziger Weg hinein (#847): schaltet Anmeldeformular und
  // Passwort-Reset ab. Der Server ignoriert den Schalter, solange OIDC nicht
  // vollstaendig konfiguriert ist, und meldet das beim Start - sonst spaerrte
  // eine einzelne Zeile den Haushalt aus seiner eigenen App aus.
  { key: 'AUTH_ALLOW_PASSWORD_LOGIN',   type: 'default', label: 'Allow Password Login',     default: 'true', required: false, group: 'oidc', writeToEnv: true },
  // Automatische Backups.
  { key: 'BACKUP_ENABLED',              type: 'default', label: 'Backups Enabled',          default: 'true', group: 'backup',  writeToEnv: true },
  { key: 'BACKUP_SCHEDULE',             type: 'default', label: 'Backup Schedule (cron)',   default: '0 2 * * *', group: 'backup', writeToEnv: true },
  { key: 'BACKUP_KEEP',                 type: 'default', label: 'Backups to Keep',          default: '7',    group: 'backup',  writeToEnv: true },
  // Zusätzliches externes Backup-Ziel per WebDAV (Nextcloud usw.). Alle optional.
  { key: 'WEBDAV_BACKUP_ENABLED',       type: 'default', label: 'WebDAV Backups Enabled',   default: 'false', required: false, group: 'backup', writeToEnv: true },
  { key: 'WEBDAV_BACKUP_URL',           type: 'user',    label: 'WebDAV Backup URL',        required: false, group: 'backup',  writeToEnv: true },
  { key: 'WEBDAV_BACKUP_USERNAME',      type: 'user',    label: 'WebDAV Backup Username',   required: false, group: 'backup',  writeToEnv: true },
  { key: 'WEBDAV_BACKUP_PASSWORD',      type: 'user',    label: 'WebDAV Backup Password',   required: false, group: 'backup',  writeToEnv: true, secret: true },
  { key: 'WEBDAV_BACKUP_PATH',          type: 'user',    label: 'WebDAV Backup Path',       required: false, group: 'backup',  writeToEnv: true },
  { key: 'WEBDAV_BACKUP_KEEP',          type: 'default', label: 'WebDAV Backups to Keep',   default: '7',    group: 'backup',  writeToEnv: true },
  // Web-Push-Kontaktadresse (an Push-Dienste gesendet). VAPID-Schlüssel werden
  // bei Erstnutzung automatisch erzeugt; nur das Subject ist hier konfigurierbar.
  { key: 'VAPID_SUBJECT',               type: 'default', label: 'Push Contact (VAPID Subject)', default: '', group: 'push',  writeToEnv: true },
  // Optionaler lokaler Ordner-Speicher (Host-Mount) für neu hochgeladene Dokumentdateien.
  // Obergrenze fuer JEDEN Upload (#806). Sie ist kein Speicherlimit, sondern ein
  // Prozesslimit: express.json puffert den Body vollstaendig im Arbeitsspeicher,
  // bevor eine Route ihn sieht. Deshalb ist der Wert im Server auf 1-100 MB
  // gedeckelt, statt beliebig zu sein.
  { key: 'MAX_UPLOAD_MB',                    type: 'default', label: 'Max Upload Size (MB)',             default: '5',          required: false, group: 'documentStorage', writeToEnv: true },
  { key: 'DOCUMENT_STORAGE_LOCAL_ENABLED',   type: 'default', label: 'Local Document Storage Enabled',   default: 'false',      required: false, group: 'documentStorage', writeToEnv: true },
  { key: 'DOCUMENT_STORAGE_LOCAL_PATH',      type: 'default', label: 'Local Document Storage Path',      default: '/documents', required: false, group: 'documentStorage', writeToEnv: true },
  // Der Host-Ordner, der auf DOCUMENT_STORAGE_LOCAL_PATH gemountet wird. Fehlte
  // er, blieb das Volume-Ziel auf /documents stehen, während die App woanders
  // hinschrieb: die Uploads landeten im Container-Overlay und waren beim
  // nächsten `pull && up -d` weg, die DB-Referenzen blieben.
  { key: 'DOCUMENT_STORAGE_LOCAL_DIR',       type: 'default', label: 'Local Document Storage Host Folder', default: './documents', required: false, group: 'documentStorage', writeToEnv: true },
  // Optionaler WebDAV-Speicher für neu hochgeladene Dokumentdateien.
  { key: 'DOCUMENT_STORAGE_WEBDAV_ENABLED',  type: 'default', label: 'WebDAV Document Storage Enabled',  default: 'false', required: false, group: 'documentStorage', writeToEnv: true },
  { key: 'DOCUMENT_STORAGE_WEBDAV_URL',      type: 'user',    label: 'WebDAV Document Storage URL',      required: false, group: 'documentStorage', writeToEnv: true },
  { key: 'DOCUMENT_STORAGE_WEBDAV_USERNAME', type: 'user',    label: 'WebDAV Document Storage Username', required: false, group: 'documentStorage', writeToEnv: true },
  { key: 'DOCUMENT_STORAGE_WEBDAV_PASSWORD', type: 'user',    label: 'WebDAV Document Storage Password', required: false, group: 'documentStorage', writeToEnv: true, secret: true },
  { key: 'DOCUMENT_STORAGE_WEBDAV_PATH',     type: 'user',    label: 'WebDAV Document Storage Path',     required: false, group: 'documentStorage', writeToEnv: true },
  // Das typische WebDAV-Ziel eines Self-Hosters ist ein Nextcloud im LAN, und
  // genau das blockt der SSRF-Guard. Der Wizard fragte die URL ab und bot
  // keinen Ausweg an: das Feld scheiterte im häufigsten Fall stumm.
  { key: 'DOCUMENT_STORAGE_WEBDAV_ALLOW_PRIVATE_NETWORK', type: 'default', label: 'Allow Private Network WebDAV Target', default: 'false', required: false, group: 'documentStorage', writeToEnv: true },
];
