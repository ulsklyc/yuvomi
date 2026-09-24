/**
 * Modul: Heute-Blatt - der Beitrags-Vertrag
 * Zweck: Welche Module im Blatt „Heute wichtig" sprechen, in welcher Form, und
 *        nach welcher Regel das Blatt sortiert, deckelt und seine Coda setzt.
 * Abhaengigkeiten: /i18n.js, /permissions.js, /nav-icons.js, /utils/timezone.js,
 *                  /utils/pantry-status.js
 *
 * WARUM ES DIESEN VERTRAG GIBT (Dashboard-Critique 23.09.2026, P1). Das Blatt
 * las nur Termine, Aufgaben, Essen und Einkauf und schloss mit „Danach steht
 * heute nichts mehr an" - waehrend dieselbe Antwort von /dashboard zwei offene
 * Dosen und eine wartende Freigabe trug. Jede Quelle, die das Blatt nicht
 * kannte, war eine Stelle, an der die Coda log. Deshalb steht hier EINE Liste
 * von Quellen mit EINER Zeilenform, und Cockpit wie Wand lesen dieselbe.
 *
 * DIE ZEILE. Jede Quelle liefert Objekte dieser Form:
 *   kind      'dose' | 'approval' | ... - was die Zeile ist (Anker, Dedupe)
 *   sortKey   'HH:MM' - Platz im Tag; Zeitloses ordnet sich ein:
 *             00:00 schon faellig, 00:01 den ganzen Tag, 00:02 heute ohne Zeit
 *   tone      Raum der Zeile (CSS `today-cockpit-card--<tone>`, `wall-row--<tone>`)
 *   icon      Siegel-Zeichen (Name aus MODULE_ICON)
 *   title     was (Textfarbe), sub: woher (ruhiger Untertitel)
 *   timeLabel optionale Zeitangabe rechts; overdue faerbt sie
 *   route     Ziel beim Antippen
 *   who       Person, die die Zeile angeht (Ueberlappungszeichen) oder null
 *   priority  kleiner = wichtiger; entscheidet, was unter dem Deckel bleibt
 *   open      ist hier noch etwas ZU TUN? Nur offene Zeilen halten die Coda auf
 *
 * EINE NEUE QUELLE ANDOCKEN: ein Eintrag in TODAY_SHEET_SOURCES mit `module`,
 * `widget` und `collect(data, ctx)`, der aus einem Feld der /dashboard-Antwort
 * Zeilen dieser Form macht, dazu die Tonklassen `today-cockpit-card--<tone>` und
 * `wall-row--<tone>` in dashboard.css. Modulschalter, Widget-Recht und die
 * Kein-Echo-Regel prueft `sourceSpeaks()` fuer alle gleich; die Quelle muss nur
 * ihre Daten lesen. Das juengste Beispiel ist der Vorrat (`id: 'pantry'`,
 * liest `pantryExpiring.todayItems`/`todayCount`).
 */

import { t, formatTime } from '/i18n.js';
import { canSeeWidget as canSeeWidgetDefault, isPermAdmin, moduleAccess } from '/permissions.js';
import { MODULE_ICON } from '/nav-icons.js';
import { zonedTimeKey } from '/utils/timezone.js';
import { pantryExpiryPhrase } from '/utils/pantry-status.js';

/** Zeitlose Plaetze im Tag - dieselben drei Stufen, die das Programm schon kennt. */
export const SORT_DUE_NOW = '00:00';
export const SORT_ALL_DAY = '00:01';
export const SORT_TODAY = '00:02';

/* DIE TONNE IST UM MITTAG ABGEHOLT. Die Abfuhr kennt keine Uhrzeit und keinen
 * Haken „abgeholt" - aber eine Tonne, die heute rausmusste, ist am Nachmittag
 * keine offene Sache mehr. Die Zeile bleibt als Auskunft stehen, haelt die
 * Coda aber nicht mehr auf. Mittag, weil die Abfuhr in aller Regel vormittags
 * faehrt; wer das anders erlebt, liest weiterhin „Abholung heute". */
const WASTE_PICKUP_SETTLED = '12:00';
/* Rausstellen heisst: am Vorabend. Die Zeile fuer die Abholung von morgen
 * steht deshalb im Programm am Abend. */
const WASTE_PUT_OUT_SORT = '18:00';

/**
 * Welche Erinnerungen das Blatt zeigt, und in wessen Ton.
 *
 * Nicht jede faellige Erinnerung ist eine Blatt-Zeile: Abfuhr und Schicht
 * haben hier eine eigene Quelle (eine zweite Zeile waere ein Echo), Zyklus und
 * Fasten sind Stupser ihrer eigenen Kacheln, und der Vorrat spricht ueber seine
 * eigene Quelle (`pantry`). Was hier nicht steht, spricht weiter ueber Toast
 * und Glocke. `echo` nennt das Widget, das dasselbe Objekt schon zeigen wuerde;
 * `widget` das Widget, dessen Sperre die Erinnerung stumm schaltet (nur wo das
 * Modul eine Kachel hat - sonst gilt allein das Modulrecht).
 */
const REMINDER_SHEET_ORIGINS = {
  task:                   { module: 'tasks',     widget: 'tasks',    tone: 'task',      icon: MODULE_ICON.tasks,     route: '/tasks',     kind: 'task',  echo: 'tasks' },
  event:                  { module: 'calendar',  widget: 'calendar', tone: 'event',     icon: MODULE_ICON.calendar,  route: '/calendar',  kind: 'event', echo: 'calendar' },
  subscription:           { module: 'budget',    widget: 'budget',   tone: 'budget',    icon: MODULE_ICON.budget,    route: '/budget' },
  inventory_item:         { module: 'inventory',                     tone: 'inventory', icon: MODULE_ICON.inventory, route: '/inventory' },
  inventory_tracked_date: { module: 'inventory',                     tone: 'inventory', icon: MODULE_ICON.inventory, route: '/inventory' },
  document_expiry:        { module: 'documents',                     tone: 'documents', icon: MODULE_ICON.documents, route: '/documents' },
  health_prevention_due:  { module: 'health',    widget: 'health',   tone: 'health',    icon: MODULE_ICON.health,    route: '/health' },
};

function openDoseCount(health) {
  const total = Number(health?.dosesTotal) || 0;
  const done = (Number(health?.dosesTaken) || 0) + (Number(health?.dosesSkipped) || 0);
  return Math.max(0, total - done);
}

function joinNames(names) {
  return [...new Set(names.filter(Boolean))].join(', ');
}

/**
 * Die Quellen neben Termin, Aufgabe und Essen (die baut das Programm in
 * dashboard.js selbst). Reihenfolge egal: das Blatt sortiert nach Tag.
 */
export const TODAY_SHEET_SOURCES = [
  {
    // Offene Dosen - die EIGENEN Medikamente (die Antwort fuehrt nur die des
    // Betrachters, #592). Genommene und ausgelassene zaehlen nicht als offen;
    // sind alle erledigt, entfaellt die Zeile und die Quelle meldet „erledigt".
    id: 'doses',
    module: 'health',
    widget: 'health',
    settled: (data) => (Number(data?.health?.dosesTotal) || 0) > 0 && openDoseCount(data.health) === 0,
    collect(data, ctx) {
      const open = openDoseCount(data?.health);
      if (!open) return [];
      const next = data.health.nextDose ?? null;
      const time = next?.time ? String(next.time).slice(0, 5) : null;
      return [{
        kind: 'dose',
        objectId: null,
        sortKey: time ?? SORT_TODAY,
        timeLabel: time ? formatTime(time) : '',
        overdue: Boolean(time && time < ctx.nowTime),
        title: open === 1 && next?.name ? next.name : t('dashboard.todayDosesOpen', { count: open }),
        sub: open === 1 || !next?.name ? t('dashboard.todayDose') : t('dashboard.todayNextUp', { event: next.name }),
        icon: MODULE_ICON.health,
        tone: 'health',
        route: '/health',
        who: null,
        priority: 10,
        open: true,
      }];
    },
  },
  {
    // Wartende Freigaben - entscheiden duerfen nur Admins (PATCH
    // /rewards/redemptions/:id), also spricht die Zeile nur zu ihnen. Ein Kind
    // sieht seine eigene Anfrage auf der Belohnungsseite, nicht als Auftrag.
    // Wer freigibt, sagt die ANTWORT (`rewards.view`, dieselbe Pruefung wie
    // das Modul): in der Sicht `self` zaehlt `pending` die eigenen Bitten des
    // Kindes, und die waeren hier als „Freigabe" gelesen worden.
    id: 'approvals',
    module: 'rewards',
    widget: 'rewards',
    collect(data) {
      if (data?.rewards?.view !== 'approver') return [];
      const pending = Number(data?.rewards?.pending) || 0;
      if (!pending) return [];
      return [{
        kind: 'approval',
        objectId: null,
        sortKey: SORT_TODAY,
        timeLabel: '',
        title: t('dashboard.rewardsPending', { count: pending }),
        sub: t('nav.rewards'),
        icon: MODULE_ICON.rewards,
        tone: 'rewards',
        route: '/rewards',
        who: null,
        priority: 20,
        open: true,
      }];
    },
  },
  {
    // Abfuhr: heute abgeholt (offen bis Mittag) und morgen abgeholt (heute
    // Abend rausstellen, offen). Mehrere Tonnen eines Tages sind EINE Zeile -
    // man geht einmal zur Strasse, nicht dreimal.
    id: 'waste',
    module: 'waste',
    widget: 'waste',
    collect(data, ctx) {
      const pickups = Array.isArray(data?.wastePickups) ? data.wastePickups : [];
      const rows = [];
      const today = pickups.filter((p) => p.date_key === ctx.todayKey);
      const tomorrow = pickups.filter((p) => p.date_key === ctx.tomorrowKey);
      if (today.length) {
        rows.push({
          kind: 'waste',
          objectId: null,
          sortKey: SORT_ALL_DAY,
          timeLabel: '',
          title: joinNames(today.map((p) => p.type_name)),
          sub: t('dashboard.todayWasteToday'),
          icon: MODULE_ICON.waste,
          tone: 'waste',
          route: `/waste${today[0].deep_link ?? ''}`,
          who: null,
          priority: 15,
          open: ctx.nowTime < WASTE_PICKUP_SETTLED,
        });
      }
      if (tomorrow.length) {
        rows.push({
          kind: 'waste',
          objectId: null,
          sortKey: WASTE_PUT_OUT_SORT,
          timeLabel: '',
          title: joinNames(tomorrow.map((p) => p.type_name)),
          sub: t('dashboard.todayWasteTonight'),
          icon: MODULE_ICON.waste,
          tone: 'waste',
          route: `/waste${tomorrow[0].deep_link ?? ''}`,
          who: null,
          priority: 25,
          open: true,
        });
      }
      return rows;
    },
  },
  {
    // Geburtstag und Namenstag heute. Steht er schon als Termin in der Antwort
    // (die Geburtstage laufen im Kalender mit, #927), spricht der Kalender fuer
    // ihn - im Blatt oder in seiner Kachel -, und hier kommt keine zweite Zeile.
    id: 'birthdays',
    module: 'calendar',
    widget: 'birthdays',
    collect(data, ctx) {
      const list = Array.isArray(data?.birthdays) ? data.birthdays : [];
      const events = Array.isArray(data?.upcomingEvents) ? data.upcomingEvents : [];
      const asEvent = new Set(events
        .filter((e) => e.birthday_name && String(e.start_datetime ?? '').slice(0, 10) === ctx.todayKey)
        .map((e) => e.birthday_name));
      return list
        .filter((b) => Number(b.days_until) === 0 && !asEvent.has(b.name))
        .map((b) => ({
          kind: 'birthday',
          objectId: b.id ?? null,
          sortKey: SORT_ALL_DAY,
          timeLabel: '',
          title: b.name,
          sub: b.kind === 'name_day' ? t('birthdays.nameDay') : t('contacts.birthdayLabel'),
          icon: MODULE_ICON.birthdays,
          tone: 'birthdays',
          route: '/birthdays',
          who: null,
          priority: 60,
          open: false,
        }));
    },
  },
  {
    // Vorrat, der HEUTE ablaeuft (Dashboard-Critique 23.09.2026, #1448). Wie
    // die Tonne: mehrere Chargen eines Tages sind EINE Zeile, und sie ist ein
    // Auftrag (heute aufbrauchen), haelt also die Coda auf. Abgelaufenes und
    // „bald" bleiben der Vorrats-Kachel - das Blatt kennt nur heute. Die
    // Namen kommen gedeckelt (`todayItems`), die Zahl ungedeckelt
    // (`todayCount`); was darueber hinausgeht, steht als „+N weitere" da.
    id: 'pantry',
    module: 'pantry',
    widget: 'pantry',
    collect(data) {
      const slice = data?.pantryExpiring;
      const items = Array.isArray(slice?.todayItems) ? slice.todayItems : [];
      if (!items.length) return [];
      const names = joinNames(items.map((item) => item.name));
      const rest = Math.max(0, (Number(slice.todayCount) || 0) - items.length);
      const phrase = pantryExpiryPhrase(0);
      return [{
        kind: 'pantry',
        objectId: null,
        sortKey: SORT_ALL_DAY,
        timeLabel: '',
        title: rest ? `${names} ${t('dashboard.pantryExpiringMore', { count: rest })}` : names,
        sub: t(phrase.key),
        icon: MODULE_ICON.pantry,
        tone: 'pantry',
        route: '/pantry?filter=soon',
        who: null,
        priority: 30,
        open: true,
      }];
    },
  },
  {
    // Die eigene Schicht. Kein Auftrag, sondern ein Rahmen des Tages - wie ein
    // Termin haelt sie die Coda nicht auf.
    id: 'shifts',
    module: 'schedule',
    widget: 'schedule',
    collect(data, ctx) {
      const shifts = Array.isArray(data?.myShiftsToday) ? data.myShiftsToday : [];
      return shifts.map((entry) => {
        const type = entry.shift_type ?? {};
        const start = type.start_time ? String(type.start_time).slice(0, 5) : null;
        const end = type.end_time ? String(type.end_time).slice(0, 5) : null;
        return {
          kind: 'shift',
          objectId: type.id ?? null,
          sortKey: start ?? SORT_ALL_DAY,
          timeLabel: start && end ? `${formatTime(start)} - ${formatTime(end)}` : '',
          title: type.short_code ? `${type.short_code} · ${type.name}` : type.name,
          sub: t('nav.schedule'),
          icon: MODULE_ICON.schedule,
          tone: 'schedule',
          route: '/schedule',
          who: ctx.viewer ?? null,
          priority: 50,
          open: false,
        };
      });
    },
  },
  {
    // Faellige Erinnerungen - die, um die man ausdruecklich gebeten hat. Eine
    // Erinnerung an eine Aufgabe, die ohnehin als Zeile im Blatt steht, ist
    // keine zweite Zeile wert.
    id: 'reminders',
    module: null,
    widget: null,
    collect(data, ctx) {
      const list = Array.isArray(data?.pendingReminders) ? data.pendingReminders : [];
      const rows = [];
      for (const reminder of list) {
        const origin = REMINDER_SHEET_ORIGINS[reminder.entity_type];
        if (!origin || ctx.moduleOff(origin.module)) continue;
        // Die Quelle selbst hat kein Widget, ihre Herkunft schon: ein gesperrtes
        // Gesundheits-Widget schweigt auch ueber die faellige Vorsorge (#467).
        if (origin.widget && !ctx.canSeeWidget(origin.widget)) continue;
        if (origin.echo && ctx.widgetShown(origin.echo)) continue;
        if (origin.kind && ctx.existing.some((row) => row.kind === origin.kind
          && String(row.objectId) === String(reminder.entity_id))) continue;
        rows.push({
          kind: 'reminder',
          objectId: reminder.id ?? null,
          sortKey: SORT_DUE_NOW,
          timeLabel: '',
          title: reminder.entity_title || t('reminders.toastTitle'),
          sub: t('reminders.toastTitle'),
          icon: origin.icon,
          tone: origin.tone,
          route: origin.route,
          who: null,
          priority: 5,
          open: true,
        });
      }
      return rows;
    },
  },
  {
    // Die Haushaltshilfe ist gerade da. Eine Auskunft, kein Auftrag.
    id: 'housekeeping',
    module: 'housekeeping',
    widget: 'housekeeping',
    collect(data) {
      const hk = data?.housekeeping;
      if (!hk?.present) return [];
      const since = hk.presentSince ? String(hk.presentSince) : '';
      // Der Check-in ist ein Zeitpunkt (oft UTC, 'Z'): sein Platz im Tag ist die
      // Wanduhr des Haushalts, dieselbe, die die Beschriftung rechts zeigt.
      const sinceTime = since ? (zonedTimeKey(since) || null) : null;
      return [{
        kind: 'housekeeping',
        objectId: null,
        sortKey: sinceTime ?? SORT_ALL_DAY,
        timeLabel: sinceTime ? t('dashboard.housekeepingSince', { time: formatTime(since) }) : '',
        title: hk.workerName || t('dashboard.housekeepingPresent'),
        sub: hk.workerName ? t('dashboard.housekeepingPresent') : t('nav.housekeeping'),
        icon: MODULE_ICON.housekeeping,
        tone: 'housekeeping',
        route: '/housekeeping',
        who: null,
        priority: 70,
        open: false,
      }];
    },
  },
];

/**
 * Spricht diese Quelle fuer diesen Betrachter? Drei Riegel, fuer jede Quelle
 * gleich: das Modul ist an, das Widget ist ihm nicht verwehrt (#467 - ein
 * gesperrtes Gesundheits-Widget heisst auch: keine Dosen im Blatt), und die
 * Kachel steht NICHT sichtbar im Raster (Kein-Echo: jede Domaene hat genau
 * eine Repraesentation, Blatt ODER Kachel).
 */
export function sourceSpeaks(source, ctx) {
  if (source.module && ctx.moduleOff(source.module)) return false;
  if (source.widget && !ctx.canSeeWidget(source.widget)) return false;
  if (source.widget && ctx.widgetShown(source.widget)) return false;
  return source.allowed ? Boolean(source.allowed(ctx)) : true;
}

/**
 * Der Kontext, den jede Quelle liest. Die Riegel kommen von aussen, damit
 * Cockpit (mit Widget-Konfiguration) und Wand (ohne) dieselben Quellen fragen.
 */
export function todaySheetContext({
  todayKey, tomorrowKey, nowTime, cfg = [], isAdmin = isPermAdmin(), viewer = null,
  isModuleDisabled = () => false,
  canSeeWidget = canSeeWidgetDefault,
  existing = [],
} = {}) {
  const widgetShown = (id) => Array.isArray(cfg) && cfg.some((w) => w.id === id && w.visible);
  // Zwei Achsen, wie ueberall (#467): der Haushaltsschalter des Moduls und das
  // Modulrecht des Betrachters. Der Server liefert gesperrte Module ohnehin
  // leer - der Riegel hier haelt auch einen alten Stand im Speicher stumm.
  const moduleOff = (module) => Boolean(isModuleDisabled(module)) || moduleAccess(module) === 'none';
  return { todayKey, tomorrowKey, nowTime, isAdmin, viewer, moduleOff, canSeeWidget, widgetShown, existing };
}

/** Die Zeilen aller sprechenden Quellen, plus ob eine davon „heute erledigt" meldet. */
export function collectSourceRows(data, ctx, sources = TODAY_SHEET_SOURCES) {
  const rows = [];
  let settled = false;
  for (const source of sources) {
    if (!sourceSpeaks(source, ctx)) continue;
    rows.push(...source.collect(data, ctx));
    if (source.settled?.(data, ctx)) settled = true;
  }
  return { rows, settled };
}

/**
 * Welche Quellen tragen fuer diesen Betrachter gerade eine Zeile ins Blatt?
 * Die Kennzahlreihe fragt das, damit eine Zahl, die das Blatt schon nennt
 * (offene Freigaben), nicht noch einmal als Kachel daneben steht - die
 * Kein-Echo-Regel in die andere Richtung.
 */
export function speakingSourceIds(data, ctx, sources = TODAY_SHEET_SOURCES) {
  const ids = new Set();
  for (const source of sources) {
    if (sourceSpeaks(source, ctx) && source.collect(data, ctx).length) ids.add(source.id);
  }
  return ids;
}

const bySortKey = (a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0);
const byPriority = (a, b) => (a.priority ?? 50) - (b.priority ?? 50);

/**
 * Sortieren, deckeln, zaehlen - fuer Cockpit und Wand dieselbe Rechnung.
 *
 * Unter dem Deckel bleibt zuerst, was OFFEN ist: eine Auskunft (Schicht,
 * Geburtstag) darf keinen Auftrag hinter „+N weitere" schieben. Innerhalb
 * derselben Offenheit entscheidet die Prioritaet, dann der Platz im Tag.
 * Gezeigt wird danach wieder chronologisch - das Blatt ist ein Programm, keine
 * Rangliste.
 */
export function composeTodaySheet(rows, { cap }) {
  const sorted = [...rows].sort((a, b) => bySortKey(a, b) || byPriority(a, b));
  const openCount = sorted.filter((row) => row.open).length;
  if (sorted.length <= cap) return { rows: sorted, allRows: sorted, overflow: 0, openCount };
  const keep = new Set([...sorted]
    .sort((a, b) => (Number(Boolean(b.open)) - Number(Boolean(a.open))) || byPriority(a, b) || bySortKey(a, b))
    .slice(0, cap));
  const visible = sorted.filter((row) => keep.has(row));
  return { rows: visible, allRows: sorted, overflow: sorted.length - visible.length, openCount };
}

/**
 * Die Coda („Danach steht heute nichts mehr an") ist eine Entwarnung, und sie
 * darf nur fallen, wenn sie stimmt: es gibt Zeilen, keine davon ist noch offen,
 * und keine verschwindet hinter „+N weitere". Eine offene Dosis, eine wartende
 * Freigabe oder die Tonne am Morgen halten sie auf.
 */
export function codaAllowed(sheet) {
  return sheet.rows.length > 0 && sheet.overflow === 0 && sheet.openCount === 0;
}
