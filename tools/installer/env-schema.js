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
  { key: 'SYNC_INTERVAL_MINUTES',       type: 'default', label: 'Sync Interval (minutes)', default: '15',   group: 'sync',    writeToEnv: true },
  { key: 'TZ',                          type: 'default', label: 'Timezone',                 default: 'UTC',  group: 'system',  writeToEnv: true },
  { key: 'OIKOS_HTTP_PORT',             type: 'default', label: 'HTTP Port',                default: '3000', group: 'system',  writeToEnv: true },
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
  { key: 'DOCUMENT_STORAGE_LOCAL_ENABLED',   type: 'default', label: 'Local Document Storage Enabled',   default: 'false',      required: false, group: 'documentStorage', writeToEnv: true },
  { key: 'DOCUMENT_STORAGE_LOCAL_PATH',      type: 'default', label: 'Local Document Storage Path',      default: '/documents', required: false, group: 'documentStorage', writeToEnv: true },
  // Optionaler WebDAV-Speicher für neu hochgeladene Dokumentdateien.
  { key: 'DOCUMENT_STORAGE_WEBDAV_ENABLED',  type: 'default', label: 'WebDAV Document Storage Enabled',  default: 'false', required: false, group: 'documentStorage', writeToEnv: true },
  { key: 'DOCUMENT_STORAGE_WEBDAV_URL',      type: 'user',    label: 'WebDAV Document Storage URL',      required: false, group: 'documentStorage', writeToEnv: true },
  { key: 'DOCUMENT_STORAGE_WEBDAV_USERNAME', type: 'user',    label: 'WebDAV Document Storage Username', required: false, group: 'documentStorage', writeToEnv: true },
  { key: 'DOCUMENT_STORAGE_WEBDAV_PASSWORD', type: 'user',    label: 'WebDAV Document Storage Password', required: false, group: 'documentStorage', writeToEnv: true, secret: true },
  { key: 'DOCUMENT_STORAGE_WEBDAV_PATH',     type: 'user',    label: 'WebDAV Document Storage Path',     required: false, group: 'documentStorage', writeToEnv: true },
];
