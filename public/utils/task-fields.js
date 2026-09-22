/**
 * Modul: Aufgaben-Felder (geteilte Domaenenschicht)
 * Zweck: Was ein Feld einer Aufgabe BEDEUTET - liegt sie in der Ablage, darf
 *        ich sie umschreiben, wie heisst ihre Kategorie, wie liest sich ihre
 *        Faelligkeit. Reine Funktionen ohne DOM und ohne Seiten-State.
 * Abhaengigkeiten: i18n.js (t, Datums-/Zeitformate), utils/date.js,
 *                  utils/timezone.js, utils/document-preview.js
 *
 * Warum eigene Datei: Diese Regeln beantworten dieselbe Frage in der Liste, in
 * der Leseansicht und - seit die Uebersicht dieselbe Leseansicht oeffnet - auch
 * dort. Solange sie in `pages/tasks.js` wohnten, war die einzige Art, sie
 * anderswo zu benutzen, sie abzuschreiben; genau das war in `dashboard.js`
 * passiert. Eine Regel, die an zwei Stellen steht, ist eine Regel, die
 * auseinanderlaeuft.
 */

import { t, formatDate, formatDayMonth, formatTime } from '/i18n.js';
import { parseLocalDateKey } from '/utils/date.js';
import { nowFields } from '/utils/timezone.js';
import { isPreviewable } from '/utils/document-preview.js';
import { isNavModuleReadOnly } from '/permissions.js';

// --------------------------------------------------------
// Prioritaet und Status
// --------------------------------------------------------

export const PRIORITIES = () => [
  { value: 'urgent', label: t('tasks.priorityUrgent'), color: 'var(--color-priority-urgent)' },
  { value: 'high',   label: t('tasks.priorityHigh'),   color: 'var(--color-priority-high)'   },
  { value: 'medium', label: t('tasks.priorityMedium'), color: 'var(--color-priority-medium)' },
  { value: 'low',    label: t('tasks.priorityLow'),    color: 'var(--color-priority-low)'    },
  { value: 'none',   label: t('tasks.priorityNone'),   color: 'var(--color-priority-none)'   },
];

export const PRIO_ORDER = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };

// Die Zustände, die eine Aufgabe im Lauf durchläuft. Das Archiv steht seit #688
// NICHT mehr darunter: Ablegen und Erledigen sind zwei Aussagen, und solange sie
// sich ein Feld teilten, löschte das Ablegen das Erledigt-Sein.
export const STATUSES = () => [
  { value: 'open',        label: t('tasks.statusOpen')       },
  { value: 'in_progress', label: t('tasks.statusInProgress') },
  { value: 'done',        label: t('tasks.statusDone')       },
];

// In der Filterleiste bleibt das Archiv ein Wert neben den Status - dort ist es
// eine Frage („was zeige ich?"), keine Eigenschaft. Der Server nimmt
// `status=archived` genau dafür entgegen.
export const FILTER_STATUSES = () => [...STATUSES(), { value: 'archived', label: t('tasks.statusArchived') }];

export const PRIORITY_LABELS = () => Object.fromEntries(PRIORITIES().map((p) => [p.value, p.label]));
export const STATUS_LABELS   = () => Object.fromEntries(FILTER_STATUSES().map((s) => [s.value, s.label]));

/**
 * Wie heisst dieser Zustand? Fuer jedes Zeichen, das den Zustand NENNT statt
 * eine Handlung anzubieten (Leserecht, Tablett). Es sind drei Zustaende, nicht
 * zwei: die Frage „erledigt oder nicht?" rief eine begonnene Aufgabe „offen",
 * waehrend der Ring daneben gelb „in Bearbeitung" zeigte. Ein unbekannter Wert
 * liest sich als offen - so, wie ihn auch der Ring zeichnet.
 */
export function statusLabel(status) {
  const labels = STATUS_LABELS();
  return labels[status] ?? labels.open;
}

// --------------------------------------------------------
// Ablage und Sperre
// --------------------------------------------------------

/** Liegt die Aufgabe in der Ablage? Einzige Stelle, die das entscheidet. */
export function isArchived(task) {
  return !!task?.archived_at;
}

/**
 * Darf ich die DEFINITION dieser Aufgabe ändern? (#830)
 *
 * Spiegelt die Serverregel Wort für Wort: gesperrt heißt, nur Ersteller:in und
 * Admins dürfen umschreiben, ablegen oder löschen - abhaken, kommentieren und
 * sich selbst eintragen bleibt für alle offen. Der Server entscheidet, hier
 * wird nur die Oberfläche danach gerichtet; laufen die beiden auseinander,
 * bietet das UI einen Knopf an, der in einem 403 endet.
 *
 * `parent` ist die Elternaufgabe einer Unteraufgabe: die erbt die Sperre, weil
 * sie ein Punkt derselben Anweisung ist.
 *
 * WER FRAGT, STEHT IM AUFRUF. Solange die Regel in der Aufgabenseite wohnte,
 * las sie den Betrachter aus deren `state` - unsichtbar fuer jeden anderen
 * Aufrufer, und damit eine Regel, die sich nur an einer Stelle stellen liess.
 *
 * @param {object|null} task
 * @param {object|null} parent
 * @param {{isAdmin?: boolean, currentUserId?: number|string|null}} viewer
 */
export function canEditTaskDefinition(task, parent = null, viewer = {}) {
  // NUR-LESEN SCHLAEGT DIE EIGENE URHEBERSCHAFT. Die Sperre aus #830 fragt, wem
  // eine einzelne Aufgabe gehoert; das Modulrecht fragt, ob dieser Nutzer
  // ueberhaupt in Aufgaben schreiben darf - und die zweite Frage kommt zuerst.
  // Sie steht hier und nicht in den Renderern, weil sonst dieselbe Antwort in
  // der Zeile, in der Leseansicht und im Unteraufgaben-Knopf je einmal
  // geschrieben stuende. Der Server entscheidet verbindlich (#467); dies ist
  // die ehrliche Oberflaeche dazu.
  if (isNavModuleReadOnly('tasks')) return false;
  const lock = task?.locked ? task : (parent?.locked ? parent : null);
  if (!lock) return true;
  if (viewer.isAdmin) return true;
  return Number(lock.created_by) === Number(viewer.currentUserId);
}

// --------------------------------------------------------
// Kategorien
// --------------------------------------------------------

// Fallback-Kategorie (kanonischer Key). Kategorien sind seit #494 benutzer-
// verwaltbar und werden aus /tasks/meta/options in state.categories geladen.
export const FALLBACK_CATEGORY = 'misc';

// Label einer Kategorie auflösen: Seed-Kategorien tragen label_key (i18n),
// benutzerdefinierte tragen name. Unbekannte Keys (z. B. Due-Gruppen-Strings)
// werden unverändert zurückgegeben.
export function catLabel(key, categories = []) {
  const c = (categories ?? []).find((x) => x.key === key);
  if (!c) return key;
  return c.label_key ? t(c.label_key) : (c.name || c.key);
}

// DIE REIHENFOLGE DER KATEGORIEN STEHT IN DEN DATEN, NICHT IM ALPHABET (#845).
//
// Hier sortierte die Gruppierung `a.localeCompare(b, 'de')` - über den KEY, und
// über eine fest verdrahtete Sprache. Das war gleich dreifach falsch: die im
// Kategorie-Verwalter gezogene Reihenfolge (`sort_order`, seit #494 per
// PATCH /tasks/categories/reorder gespeichert) blieb wirkungslos, sortiert
// wurde der interne Schlüssel statt des sichtbaren Labels (`misc` steht unter
// M, angezeigt wird „Sonstiges"), und eine französische Oberfläche bekam
// deutsche Sortierregeln.
//
// `state.categories` kommt vom Server bereits nach `sort_order` sortiert -
// die Position IN dieser Liste ist damit die einzige Wahrheit über die
// Reihenfolge. Dieselbe Regel führt contacts.js seit #357.
export function catSortIndex(key, categories = []) {
  const i = (categories ?? []).findIndex((c) => c.key === key);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}

// --------------------------------------------------------
// Tags (#586)
// --------------------------------------------------------

export const MAX_TAGS = 32;
export const MAX_TAG_LEN = 64;

/** Tag-Liste säubern; Groß-/Kleinschreibung eint (erste Schreibweise gewinnt). */
export function normalizeTagList(list) {
  const out = [];
  const seen = new Set();
  for (const item of list ?? []) {
    const tag = String(item ?? '').trim().slice(0, MAX_TAG_LEN).trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

// --------------------------------------------------------
// Verknüpfte Dokumente (#503, #733)
// --------------------------------------------------------

export function docMime(doc) {
  return String(doc.mime_type || '').split(';')[0].trim().toLowerCase();
}

// Vorschaubar -> /preview (inline), sonst /download. Welche Typen das sind, steht
// einmal in utils/document-preview.js, nicht hier.
export function docHref(doc) {
  return isPreviewable(doc.mime_type)
    ? `/api/v1/documents/${doc.id}/preview`
    : `/api/v1/documents/${doc.id}/download`;
}

export function docIcon(doc) {
  const mime = docMime(doc);
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'file-text';
  return 'file';
}

// --------------------------------------------------------
// Fälligkeit
// --------------------------------------------------------

export function formatDueDate(dateStr, timeStr, isDone = false) {
  if (!dateStr) return null;

  // Zonenlose WANDUHRZEIT, nicht Zeitpunkt. `new Date(`${dateStr}T${timeStr}`)`
  // machte aus "21:00" einen Zeitpunkt der BROWSER-Zone, den formatTime
  // anschliessend in die Anzeigezone umrechnete - mit Haushalt auf Honolulu und
  // Browser in Berlin stand an einer fuer 21:00 eingetragenen Aufgabe 9:00.
  // Dieselbe Uhr entschied ueber "heute"/"morgen", und die Gruppierung nebenan
  // folgt seit #829 laengst `todayKey()`: dieselbe Ansicht ging damit nach zwei
  // Uhren, eine Aufgabe konnte unter "Morgen" stehen und "Heute faellig" heissen.
  const dayKey = String(dateStr).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) return null;
  const dueTime = timeStr ? String(timeStr).slice(0, 5) : null;
  if (timeStr && !/^\d{2}:\d{2}$/.test(dueTime)) return null;
  const dueStamp = `${dayKey}T${dueTime ?? '23:59'}`;

  const now = nowFields();
  if (!now) return null;
  const p2 = (n) => String(n).padStart(2, '0');
  const todayDay = `${now.year}-${p2(now.month)}-${p2(now.day)}`;
  const nowStamp = `${todayDay}T${p2(now.hour)}:${p2(now.minute)}`;

  // Kalendertage, nicht Millisekunden: ueber eine Sommerzeitgrenze liegen zwei
  // Tage nicht 24h auseinander, ihre Keys aber immer genau einen.
  const calDayDiff = Math.round(
    (parseLocalDateKey(dayKey) - parseLocalDateKey(todayDay)) / (1000 * 60 * 60 * 24),
  );

  const timeLabel = dueTime ? ` – ${formatTime(dueStamp)}` : '';

  /* DAS JAHR STEHT NUR DA, WO ES ETWAS UNTERSCHEIDET.
   *
   * Gemessen bei 390px: die Metazeile hat 228px, und „Überfällig – 11.08.2026"
   * allein belegte 154px davon - mit dem Prioritäts-Chip davor lief die Zeile
   * über und schnitt sich selbst an („11.08.202|6"). Das Jahr war dabei die
   * einzige Angabe, die nichts beitrug: eine Aufgabe, die dieses Jahr fällig
   * ist, sagt mit „11.08." dasselbe in 35px weniger.
   *
   * Über `formatDayMonth` und nicht per slice: die Reihenfolge und das
   * Trennzeichen hängen an der Datumsformat-Präferenz (dmy, mdy, ymd), und ein
   * abgeschnittener String hätte sie in drei von sieben Formaten verdreht. */
  const dateLabel = dayKey.slice(0, 4) === todayDay.slice(0, 4)
    ? formatDayMonth(dayKey)
    : formatDate(dayKey);
  const fullLabel = dueTime ? `${dateLabel}, ${formatTime(dueStamp)}` : dateLabel;

  // Erledigte/archivierte Aufgaben können nicht überfällig sein - neutrales Datum.
  if (isDone) {
    return { label: fullLabel, cls: '' };
  }

  // Beide Seiten sind Wanduhrzeit DERSELBEN Zone und damit als Text vergleichbar.
  if (dueStamp < nowStamp) {
    return { label: `${t('tasks.overdue')} – ${fullLabel}`, cls: 'due-date--overdue' };
  }
  if (calDayDiff === 0) {
    return { label: `${t('tasks.dueToday')}${timeLabel}`, cls: 'due-date--today' };
  }
  if (calDayDiff === 1) {
    return { label: `${t('tasks.dueTomorrow')}${timeLabel}`, cls: '' };
  }
  return { label: fullLabel, cls: '' };
}
