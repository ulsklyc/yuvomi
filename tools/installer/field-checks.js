/**
 * Feldpruefungen des Web-Installers, die eine Regel des SERVERS spiegeln.
 *
 * Reine Funktionen ohne DOM: install.html ruft sie in den Schritt-Handlern auf,
 * test/test-installer-validation.js bindet jede an die Stelle im Server, deren
 * Regel sie vorwegnimmt. Der Anlass ist derselbe in allen Faellen: der Wizard
 * nahm einen Wert an, an dem der Server erst nach dem Speichern scheiterte -
 * still (Backups aus, Kalender ohne Verbindung) oder mit einem Startabbruch,
 * der im Wizard nur als "Container konnte nicht gestartet werden" ankam.
 */

/**
 * Wertebereiche der Cron-Felder (Sekunde, Minute, Stunde, Tag, Monat,
 * Wochentag) wie node-cron 4 (server/services/backup-scheduler.js). Die Sekunde
 * ist optional: fuenf Felder heissen Sekunde 0. Wochentag 7 ist wie 0 der
 * Sonntag. Namen nur bei Monat und Wochentag, kurz (jan, mon) oder voll
 * (january, monday), ohne Ruecksicht auf Gross-/Kleinschreibung.
 */
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const SECOND = { min: 0, max: 59 };
const CRON_FIELDS = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31, question: true },
  { min: 1, max: 12, names: [MONTHS, MONTHS.map(n => n.slice(0, 3))], base: 1 },
  { min: 0, max: 7, names: [WEEKDAYS, WEEKDAYS.map(n => n.slice(0, 3))], base: 0, question: true },
];

/** Die Kurzformen, die node-cron vor dem Pruefen in fuenf Felder aufloest. */
const CRON_NICKNAMES = {
  '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@hourly': '0 * * * *',
};

function cronValue(token, field) {
  if (/^\d+$/.test(token)) {
    const n = Number(token);
    return n >= field.min && n <= field.max ? n : null;
  }
  const name = token.toLowerCase();
  for (const list of field.names || []) {
    const idx = list.indexOf(name);
    if (idx !== -1) return idx + field.base;
  }
  return null;
}

function cronItem(item, field) {
  const [range, step, extra] = item.split('/');
  if (extra !== undefined) return false;
  if (step !== undefined && !(/^\d+$/.test(step) && Number(step) >= 1 && Number(step) <= field.max)) return false;
  if (range === '*') return true;
  const bounds = range.split('-');
  if (bounds.length === 1) {
    // "5/10" lehnt der Scheduler ab: ein Schritt braucht * oder einen Bereich.
    return step === undefined && cronValue(bounds[0], field) !== null;
  }
  if (bounds.length !== 2) return false;
  const lo = cronValue(bounds[0], field);
  const hi = cronValue(bounds[1], field);
  return lo !== null && hi !== null && lo <= hi;
}

function cronPart(part, field) {
  // `?` steht bei node-cron nur als ganzes Feld und nur bei Tag und Wochentag.
  if (part === '?') return Boolean(field.question);
  return part.split(',').every(item => item !== '' && cronItem(item, field));
}

/**
 * Ein Cron-Ausdruck in der Grammatik des Backup-Schedulers (node-cron): fuenf
 * Felder oder sechs mit fuehrender Sekunde, je Feld `*`, `*\/n`, Zahl, Name,
 * Bereich `a-b`, Bereich mit Schritt `a-b/n` und Listen daraus, `?` bei Tag und
 * Wochentag, dazu die Kurzformen @daily usw.
 *
 * Absichtlich eine Teilmenge von node-cron (server/services/backup-scheduler.js,
 * `cron.validate`): was hier durchgeht, nimmt der Scheduler garantiert an - der
 * Test haelt genau diese Richtung fest, und fuer die gaengigen Formen auch die
 * Gegenrichtung. Aussen vor bleiben L, W, # und rueckwaerts laufende Bereiche.
 * Vorher zaehlte der Wizard nur die Felder, `99 * * * *` ging durch, und der
 * Server schaltete die Backups beim Start still ab (nur eine Logzeile).
 */
export function isValidCron(expr) {
  const raw = String(expr ?? '').trim();
  const resolved = CRON_NICKNAMES[raw.toLowerCase()] ?? raw;
  const parts = resolved.split(/\s+/);
  if (parts.length === CRON_FIELDS.length + 1) {
    if (!cronPart(parts.shift(), SECOND)) return false;
  }
  if (parts.length !== CRON_FIELDS.length) return false;
  return parts.every((part, i) => cronPart(part, CRON_FIELDS[i]));
}

/**
 * Container-Pfad (DOCUMENT_STORAGE_LOCAL_PATH): absolut. docker-compose.yml
 * bindet den Host-Ordner an genau diesen Pfad
 * (`${DOCUMENT_STORAGE_LOCAL_DIR}:${DOCUMENT_STORAGE_LOCAL_PATH}`), und das
 * Ziel eines Mounts muss absolut sein - sonst scheitert schon `compose up`,
 * und der Wizard meldete nur einen fehlgeschlagenen Start.
 */
export function isAbsoluteContainerPath(path) {
  return String(path ?? '').startsWith('/');
}

/**
 * Das Praefix der Platzhalter aus .env.example. server/auth.js und server/db.js
 * brechen beim Start daran ab (`startsWith('REPLACE_WITH_')`); der Wizard
 * nimmt den Wert deshalb gar nicht erst an.
 */
export const PLACEHOLDER_PREFIX = 'REPLACE_WITH_';

export function isPlaceholderSecret(value) {
  return String(value ?? '').startsWith(PLACEHOLDER_PREFIX);
}

/**
 * Paar aus ID und Secret (Google, Outlook, Apple): welches Feld fehlt?
 *
 * 'secret' : die ID steht, das Secret fehlt - eingetippt UND in der .env
 * 'id'     : ein Secret ist eingetippt, die ID fehlt
 * null     : vollstaendig oder ganz leer
 *
 * `secretKept` heisst: das Secret steht schon in der bestehenden .env (Rerun,
 * Feld bewusst leer). Ein uebernommenes Secret ohne ID meldet nichts: der
 * Server bewahrt eine leer gesendete ID ohnehin, ein Fehler hier blockierte
 * nur jeden Rerun.
 */
export function pairGap(id, typedSecret, secretKept) {
  if (id && !(typedSecret || secretKept)) return 'secret';
  if (!id && typedSecret) return 'id';
  return null;
}

/**
 * WebDAV (Dokumente oder Backups) ist eingeschaltet, aber ohne Adresse.
 *
 * Der Server liest jedes WebDAV-Feld aus der Umgebung ODER aus den
 * App-Einstellungen. Bei einer Erstinstallation sind die leer, ein
 * eingeschaltetes Ziel ohne URL ist dann nur ein Fehler, der erst beim ersten
 * Upload bzw. der ersten Sicherung auffaellt. Laeuft die bestehende .env schon
 * genau so (eingeschaltet, URL in der App gepflegt), meldet der Rerun nichts:
 * `rerun` sind die uebernommenen Werte, `enabledKey`/`urlKey` ihre Schluessel.
 */
export function enabledWithoutUrl(enabled, url, rerun, enabledKey, urlKey) {
  if (!enabled || url) return false;
  const runsThatWay = Boolean(rerun) && rerun[enabledKey] === 'true' && !rerun[urlKey];
  return !runsThatWay;
}
