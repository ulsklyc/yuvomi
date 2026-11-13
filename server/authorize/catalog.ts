/**
 * Module: the permission catalog (phase 2, section B2; until then server/permissions.js)
 * Purpose: what rights EXIST and how permission rows are read and written. The
 *          shared permission model for interactive users (Discussion #467): which
 *          modules a family member may see or edit and which dashboard widgets and
 *          capabilities they have - configurable per family role (default) and per
 *          member (override). Next to it, in modules.ts, the questions that DECIDE
 *          with these rights.
 *
 * Contract / invariants (moved from the header of server/permissions.js):
 *   - SPARSE storage: only deviations from the default land in
 *     `access_permissions`. No row -> module 'write', widget 'allow'. That keeps
 *     installations from before migration v74 unchanged (no forced lockout).
 *   - This default was decided for the MIGRATION, not for the INVITE. That an
 *     account without rows sees everything is right for an existing household and
 *     only inherited for a newly invited member (#869). The answer to that does
 *     NOT live here: turning the default round would lock out, on the next update,
 *     exactly the households v74 was meant to protect. It lives in the preset of
 *     the invite form (settings/pages/admin-family.js), which starts narrow - a
 *     form preset, not a stored default.
 *   - Admins (users.role = 'admin') bypass the system completely: always full
 *     access, no scoping. So nobody can lock themselves out.
 *   - Resolution order for a member: member override ?? role profile ?? default.
 *   - Widgets inherit the module lock: module 'none' -> its widgets locked.
 *
 * The module keys are IDENTICAL to the scope module keys of server/scopes.js, so
 * the backend enforcement uses the same check: a restricted member gets a
 * module -> access map that the /api/v1 middleware evaluates like a scoped token.
 *
 * resolvePermissions() lives here and not in modules.ts: it reads the permission
 * rows into the effective matrix of an account and decides nothing itself; the
 * writer applyChildStartPermissions() needs it, and modules.ts may import this
 * file, never the other way round.
 *
 * Dependencies without side effects only (server/scopes.js,
 * server/display-scopes.js; no express, NEVER server/db.js, not even
 * transitively - see actor.ts) - usable in middleware, routes, migrations and
 * tests. The connection is always a parameter.
 * Erasable TS syntax only (runs through type stripping, no build).
 */

import { MODULE_KEYS, getModuleKeys } from '../scopes.js';
// NUR die reinen Listen, NICHT den Dienst: der zieht server/db.js mit, und damit
// legte jede Suite, die bloss Rechte aufloest, eine echte yuvomi.db im Repo an
// (test:db-isolation nannte vier davon).
import { DISPLAY_SCOPE_MODULES } from '../display-scopes.js';

/** The statement surface used here; better-sqlite3 and node:sqlite both provide it. */
type Statement = {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number | bigint };
};

/** A database connection (better-sqlite3 in production, node:sqlite in tests). */
export type Database = {
  prepare(sql: string): Statement;
  exec(sql: string): unknown;
};

type ModuleLevel = 'none' | 'read' | 'write';
type GrantLevel = 'none' | 'allow';

/** The account fields a resolution reads; nothing else. */
export type PermissionUser = { id?: number | null; role?: string | null; family_role?: string | null };

export type ResolvedPermissions = {
  admin: boolean;
  modules: Record<string, ModuleLevel>;
  widgets: Record<string, GrantLevel>;
  capabilities: Record<string, GrantLevel>;
};

type PermissionModule = {
  key: string;
  labelKey?: string | null;
  label?: string | null;
  icon?: string;
  navIds?: readonly string[];
  extensionModuleId?: string | null;
};

/** The fifteen core modules carry a label key, an icon and their nav ids. */
type CorePermissionModule = PermissionModule & { labelKey: string; icon: string; navIds: readonly string[] };

type PermissionWidget = { id: string; module: string | null; label?: string | null; labelKey?: string | null };

type PermissionCapability = { key: string; module: string; labelKey: string; default: GrantLevel };

/** A stored row of `access_permissions`, as read here. */
type PermissionRow = { resource_type: string; resource_key: string; access: string };

/** The input of the permission sheet (PUT body): resource -> access, per axis. */
type PermissionInput = {
  modules?: Readonly<Record<string, string>> | null;
  widgets?: Readonly<Record<string, string>> | null;
  capabilities?: Readonly<Record<string, string>> | null;
};

// Familienrollen (Subjekt-Achse „role"). Spiegelt den CHECK-Constraint der
// users.family_role-Spalte (Migration, db.js).
const FAMILY_ROLES = Object.freeze([
  'dad', 'mom', 'parent', 'child', 'grandparent', 'relative', 'other',
]);

// Gateable, nutzer-sichtbare Module. `key` === Scope-Modulschlüssel (scopes.js),
// `navIds` = zugehörige Navigations-/Kitchen-IDs im Frontend (für die Nav-Filterung;
// mehrere Nav-Einträge können sich ein Modul teilen, z. B. calendar+birthdays).
export const PERMISSION_MODULES: readonly CorePermissionModule[] = Object.freeze([
  { key: 'calendar',     labelKey: 'nav.calendar',     icon: 'calendar',      navIds: ['calendar', 'birthdays'] },
  { key: 'tasks',        labelKey: 'nav.tasks',        icon: 'check-square',  navIds: ['tasks'] },
  { key: 'notes',        labelKey: 'nav.notes',        icon: 'sticky-note',   navIds: ['notes'] },
  { key: 'contacts',     labelKey: 'nav.contacts',     icon: 'book-user',     navIds: ['contacts'] },
  { key: 'meals',        labelKey: 'nav.kitchen',      icon: 'utensils',      navIds: ['meals', 'recipes'] },
  { key: 'shopping',     labelKey: 'nav.shopping',     icon: 'shopping-cart', navIds: ['shopping'] },
  { key: 'pantry',       labelKey: 'nav.pantry',       icon: 'archive',       navIds: ['pantry'] },
  { key: 'inventory',    labelKey: 'nav.inventory',    icon: 'package',       navIds: ['inventory'] },
  { key: 'budget',       labelKey: 'nav.budget',       icon: 'wallet',        navIds: ['budget'] },
  { key: 'documents',    labelKey: 'nav.documents',    icon: 'folder-lock',   navIds: ['documents'] },
  { key: 'housekeeping', labelKey: 'nav.housekeeping', icon: 'paintbrush',    navIds: ['housekeeping'] },
  { key: 'waste',        labelKey: 'nav.waste',        icon: 'trash-2',       navIds: ['waste'] },
  { key: 'rewards',      labelKey: 'nav.rewards',      icon: 'award',         navIds: ['rewards'] },
  { key: 'health',       labelKey: 'nav.health',       icon: 'heart-pulse',   navIds: ['health'] },
  { key: 'schedule',     labelKey: 'nav.schedule',     icon: 'calendar-clock', navIds: ['schedule'] },
]);

// Dashboard-Widgets mit ihrem Trägermodul (aus dashboard.js MODULE_FOR_WIDGET).
// `module: null` → kein Modul-Gate (family/weather sind infrastrukturell).
// Das cycle-Widget hängt am Modul health, ist aber separat sperrbar — so lässt
// es sich z. B. für einzelne Mitglieder ausblenden, ohne Gesundheit ganz zu
// sperren (#467).
export const PERMISSION_WIDGETS: readonly PermissionWidget[] = Object.freeze([
  { id: 'tasks',        module: 'tasks' },
  { id: 'calendar',     module: 'calendar' },
  { id: 'meals',        module: 'meals' },
  { id: 'shopping',     module: 'shopping' },
  { id: 'birthdays',    module: 'calendar' },
  { id: 'budget',       module: 'budget' },
  { id: 'rewards',      module: 'rewards' },
  { id: 'health',       module: 'health' },
  { id: 'cycle',        module: 'health' },
  { id: 'fasting',      module: 'health' },
  // Wie Zyklus und Fasten am Modul health und trotzdem einzeln sperrbar:
  // wer sein Essen protokolliert, teilt damit nicht zwangslaeufig die
  // Medikamentenkachel - und umgekehrt (#467, derselbe Grund wie bei cycle).
  { id: 'nutrition',    module: 'health' },
  { id: 'housekeeping', module: 'housekeeping' },
  { id: 'schedule',     module: 'schedule' },
  { id: 'waste',        module: 'waste' },
  // „Läuft bald ab" (Critique 2026-09-23): Chargen aus dem Vorrat.
  { id: 'pantry',       module: 'pantry' },
  { id: 'notes',        module: 'notes' },
  { id: 'family',       module: null },
  { id: 'weather',      module: null },
  { id: 'clock',        module: null },
  // `module: null` wie Familie, Wetter und Uhr, und hier aus einem eigenen
  // Grund: die Kennzahlreihe gehoert keinem Modul, sie zeigt vier davon. Eine
  // Zuordnung zu einem einzelnen waere falsch, und sie wird auch nicht
  // gebraucht - jede EINZELNE Kachel prueft ihr Modul schon selbst
  // (`renderMetricTiles` filtert ueber `isWidgetModuleEnabled`), ein gesperrtes
  // Budget hat also nie eine Budget-Kachel. Was hier fehlte, ist die Sperre auf
  // die REIHE als solche.
  { id: 'metrics',      module: null },
  // `module: null` aus demselben Grund wie die Kennzahlreihe: der Countdown
  // (#647) sammelt aus Kalender UND Aufgaben ein, gehört also keinem der
  // beiden. Was aus einem gesperrten Modul stammt, filtert die Kachel schon
  // selbst - hier steht die Sperre auf das Widget als solches.
  { id: 'countdown',    module: null },
  // `module: null` wie Familie, Wetter und Uhr: eine Reihe Haushaltslinks
  // (#469) gehoert keinem Modul. Die private Achse setzt die Route selbst
  // durch; hier steht die Sperre auf die REIHE - ein Haushalt, der seinen
  // Kindern die Startseite nicht zur Startrampe machen will, hat damit einen
  // Schalter.
  { id: 'quicklinks',    module: null },
]);

// Feinere Schreibrechte, die kein ganzes Modul sperren sollen. Persoenliche
// Notiz-Kategorien bleiben immer Sache ihres Besitzers; dieser Schalter
// betrifft ausschliesslich den gemeinsamen Haushaltskatalog.
export const PERMISSION_CAPABILITIES: readonly PermissionCapability[] = Object.freeze([
  {
    key: 'notes_manage_household_categories',
    module: 'notes',
    labelKey: 'noteCategories.permissionLabel',
    default: 'none',
  },
  {
    key: 'health_use_fasting',
    module: 'health',
    labelKey: 'health.fasting.permissionLabel',
    default: 'allow',
  },
  // Loehne, Zahlungen und Betraege der Haushaltshilfe (R20). Das Modulrecht
  // sagt, OB jemand die Haushaltshilfe sieht und bedient; dieser Schalter
  // sagt, ob er dabei Geld sieht. Ein Kind soll wissen, wann Maria kommt und
  // was sie heute macht - nicht, was sie verdient und was noch offen ist.
  // `allow` als Standard, damit jedes bestehende Konto unveraendert bleibt.
  // Durchgesetzt am Server (server/routes/housekeeping.js, /dashboard), nicht
  // nur in der Oberflaeche: ohne das Recht fehlen die Felder in der Antwort.
  {
    key: 'housekeeping_view_amounts',
    module: 'housekeeping',
    labelKey: 'housekeeping.amountsPermissionLabel',
    default: 'allow',
  },
  // FREMDES AENDERN (R23, D5). Das Modulrecht `write` sagt, OB jemand dort
  // anlegt und bearbeitet; diese Schalter sagen, ob das auch fuer das gilt, was
  // ANDERE angelegt haben. Ohne sie: lesen ja, anlegen ja, bearbeiten und
  // loeschen nur Eigenes (`mayChangeRecord()` unten, durchgesetzt in den
  // Routen). Wie `housekeeping_view_amounts` ohne Migration: `allow` als
  // Standard laesst jedes bestehende Konto, wie es ist; neue Kinderkonten
  // starten ohne (CHILD_START_PERMISSIONS). Kontakte fehlen bewusst: ein
  // Kontakt traegt keinen Ersteller, "Eigenes" waere dort geraten.
  {
    key: 'calendar_edit_others',
    module: 'calendar',
    labelKey: 'settings.permCapabilityCalendarEditOthers',
    default: 'allow',
  },
  {
    key: 'notes_edit_others',
    module: 'notes',
    labelKey: 'settings.permCapabilityNotesEditOthers',
    default: 'allow',
  },
  {
    key: 'inventory_edit_others',
    module: 'inventory',
    labelKey: 'settings.permCapabilityInventoryEditOthers',
    default: 'allow',
  },
  // Kaufpreise im Inventar (R23, D5): wie die Betraege der Haushaltshilfe -
  // ohne das Recht fehlen `purchase_price` und `currency` in jeder Antwort,
  // und ein Schreiben laesst den gespeicherten Preis stehen.
  {
    key: 'inventory_view_prices',
    module: 'inventory',
    labelKey: 'settings.permCapabilityInventoryPrices',
    default: 'allow',
  },
  // Die Handordnung der Aufgaben gehoert dem Haushalt (tasks.js PATCH
  // /reorder): ein Zug aendert die Reihenfolge fuer alle. Kinder lesen sie
  // (R23, D15), sortieren sie aber nicht um.
  {
    key: 'tasks_reorder_family',
    module: 'tasks',
    labelKey: 'settings.permCapabilityTasksReorder',
    default: 'allow',
  },
]);

const MODULE_ACCESS_LEVELS = Object.freeze(['none', 'read', 'write']);
const WIDGET_ACCESS_LEVELS = Object.freeze(['none', 'allow']);
const CAPABILITY_ACCESS_LEVELS = Object.freeze(['none', 'allow']);
const MODULE_DEFAULT = 'write';
const WIDGET_DEFAULT = 'allow';
const CAPABILITY_DEFAULT = 'none';

// Startrechte einer Einladung (#869). Drei Vorlagen, keine Rechteverwaltung im
// Einladungsformular: wer feiner steuern will, tut das nach der Annahme im
// Rechte-Blatt, das es dafuer schon gibt.
//
//   'restricted'  Module mit persoenlichen Daten starten gesperrt
//   'role'        was das Rollenprofil sagt (bis v2.61 das stille Verhalten)
//
// ES GIBT BEWUSST KEIN 'full'. Sparse heisst auch: ein Mitglied-Override kann
// ein Rollenprofil nicht AUFWEICHEN. `normalizePermissionInput()` verwirft
// jeden Standardwert, ein gespeichertes `write` gibt es also gar nicht, und
// damit auch keine Zeile, die ein einschraenkendes Rollenprofil ueberstimmt.
// Das ist keine Luecke dieser Aenderung, sondern seit v74 so; eine Vorlage
// namens "voller Zugriff", die bei eingeschraenkter Rolle nichts tut, waere
// eine Zusage, die nicht haelt. Wer allen einer Rolle mehr geben will, aendert
// das Rollenprofil.
const INVITE_PRESETS = Object.freeze(['restricted', 'role']);
export const INVITE_PRESET_DEFAULT = 'restricted';

// Was 'restricted' sperrt. Die Trennlinie ist nicht "wenig Module", sondern
// WELCHE: das sind die drei, deren Inhalt einer PERSON gehoert und nicht dem
// Haushalt - Gesundheitswerte, Finanzen und Ausweise/Vertraege. Kalender,
// Aufgaben, Einkauf und der Rest sind das, wofuer jemand eingeladen wird; sie
// zu sperren erzeugt eine leere App und einen Anruf, keine Privatsphaere.
// Widgets brauchen hier nichts: `resolvePermissions()` sperrt sie mit ihrem
// Modul mit, das cycle-Widget also ueber `health`.
export const INVITE_RESTRICTED_MODULES = Object.freeze(['health', 'budget', 'documents']);

// Startrechte eines NEUEN Kinderkontos (R20, entschieden 2026-10-17): kein
// Budget, die Haushaltshilfe nur zum Lesen und ohne Betraege, kein Fasten.
//
// NUR BEIM ANLEGEN, NIE RUECKWIRKEND. Die Liste wird einmal als Mitglied-
// Zeilen geschrieben, wenn das Konto entsteht (Admin legt an, Einladung wird
// angenommen) - kein Rollenprofil, kein Standard. Ein Rollenprofil fuer
// `child` haette jedes BESTEHENDE Kinderkonto mitgenommen, und genau das soll
// nicht passieren: was ein Haushalt seinen Kindern heute zeigt, bleibt so.
// Aus demselben Grund aendert ein spaeterer Wechsel der Familienrolle
// (child <-> Erwachsener) die Rechte nicht; sie stehen danach im Rechte-Blatt.
//
// NUR VERSCHAERFEN. Ein Rollenprofil oder eine Einladungsvorlage, die schon
// strenger ist (`housekeeping: none`), bleibt strenger: eine Mitglied-Zeile
// gewinnt in `resolvePermissions()`, und ein `read` ueber einem `none` waere
// eine Oeffnung, die niemand gewaehlt hat.
//
// R23 (D5, D15): die Entsorgung nur zum Lesen, und Fremdes in Kalender,
// Notizen und Inventar nur lesen, keine Kaufpreise, keine Handordnung der
// Aufgaben. Dieselbe Regel: nur neue Konten, die heutigen Kinder bleiben.
export const CHILD_START_PERMISSIONS = Object.freeze({
  modules: Object.freeze({ budget: 'none', housekeeping: 'read', waste: 'read' }),
  capabilities: Object.freeze({
    health_use_fasting: 'none',
    housekeeping_view_amounts: 'none',
    calendar_edit_others: 'none',
    notes_edit_others: 'none',
    inventory_edit_others: 'none',
    inventory_view_prices: 'none',
    tasks_reorder_family: 'none',
  }),
});

// Persoenliche Vorgaben eines NEUEN Kinderkontos (R21, Critique 2026-10-21,
// D6): der Zyklus-Tab startet ausgeblendet. Er ist kein Recht, sondern die
// persoenliche Abwahl aus #760 (`health_cycle_enabled` je Person, gelesen von
// `healthCycleViews()` in server/routes/preferences.js) - dieselbe Zeile, die
// das Kind in seinen Einstellungen selbst umschaltet. Gemessen sah ein Kind
// "Zyklus" und "Fasten" in der Bereichsliste, obwohl die Gesundheit selbst
// sagt, beides sei Erwachsenensache; das Fasten nimmt schon die Capability
// oben, der Zyklus braucht diese Zeile. Wie die Rechte: beim Anlegen, und nur,
// wo noch nichts steht. Fuer Kinder von vor v2.79.0 hat Migration 258 (#2148)
// dieselbe Zeile einmal nachgezogen, als eingefrorene Kopie - eine Aenderung
// hier erreicht sie nicht mehr, und das Fasten blieb dort bewusst aussen vor.
// Der Schluessel folgt
// `userCfgKey()` (preferences.js): `<key>:user:<id>` in `sync_config`.
export const CHILD_START_PREFERENCES = Object.freeze({ health_cycle_enabled: '0' });

const MODULE_ACCESS_RANK: Readonly<Record<string, number>> = Object.freeze({ none: 0, read: 1, write: 2 });
const CAPABILITY_ACCESS_RANK: Readonly<Record<string, number>> = Object.freeze({ none: 0, allow: 1 });

/** Extension catalog injected at runtime by the module registry — keeps this file off db.js. */
let _extensionPermissionModules: PermissionModule[] = [];
let _extensionPermissionWidgets: PermissionWidget[] = [];

export function setExtensionPermissionCatalog(
  catalog: { permissionModules?: unknown; permissionWidgets?: unknown } | null | undefined,
): void {
  _extensionPermissionModules = Array.isArray(catalog?.permissionModules)
    ? catalog.permissionModules.filter((m) => m && typeof m.key === 'string')
    : [];
  _extensionPermissionWidgets = Array.isArray(catalog?.permissionWidgets)
    ? catalog.permissionWidgets.filter((w) => w && typeof w.id === 'string')
    : [];
}

function extensionPermissionModules(): PermissionModule[] {
  return _extensionPermissionModules;
}

function extensionPermissionWidgets(): PermissionWidget[] {
  return _extensionPermissionWidgets;
}

function allPermissionModules(): PermissionModule[] {
  return [...PERMISSION_MODULES, ...extensionPermissionModules()];
}

function allPermissionWidgets(): PermissionWidget[] {
  return [...PERMISSION_WIDGETS, ...extensionPermissionWidgets()];
}

function moduleKeySet() {
  return new Set(allPermissionModules().map((m) => m.key));
}

function widgetIdSet() {
  return new Set(allPermissionWidgets().map((w) => w.id));
}

const CAPABILITY_KEY_SET = new Set(PERMISSION_CAPABILITIES.map((item) => item.key));
const MODULE_ACCESS_SET = new Set(MODULE_ACCESS_LEVELS);
const WIDGET_ACCESS_SET = new Set(WIDGET_ACCESS_LEVELS);
const CAPABILITY_ACCESS_SET = new Set(CAPABILITY_ACCESS_LEVELS);
const FAMILY_ROLE_SET = new Set(FAMILY_ROLES);

// Sicherheitsnetz: jeder Permissions-Modulschlüssel muss ein echtes Scope-Modul
// sein, sonst greift die Backend-Durchsetzung ins Leere.
for (const m of PERMISSION_MODULES) {
  if (!MODULE_KEYS.includes(m.key)) {
    throw new Error(`[permissions] Unknown scope module: ${m.key}`);
  }
}

/** Liest die gespeicherten (abweichenden) Rechte-Zeilen eines Subjekts. */
function loadSubjectRows(database: Database, subjectType: string, subjectId: string | number): PermissionRow[] {
  return database
    .prepare('SELECT resource_type, resource_key, access FROM access_permissions WHERE subject_type = ? AND subject_id = ?')
    .all(subjectType, String(subjectId)) as PermissionRow[];
}

/**
 * Löst die effektiven Rechte eines konkreten Nutzers auf.
 * @param {import('better-sqlite3-multiple-ciphers').Database} database
 * @param {{ id: number, role: string, family_role?: string }} user
 * @returns {{ admin: boolean, modules: Record<string,'none'|'read'|'write'>, widgets: Record<string,'none'|'allow'>, capabilities: Record<string,'none'|'allow'> }}
 */
export function resolvePermissions(
  database: Database,
  user: PermissionUser | null | undefined,
  { isDisplay = false }: { isDisplay?: boolean } = {},
): ResolvedPermissions {
  const isAdmin = user?.role === 'admin';
  const modules: Record<string, ModuleLevel> = {};
  const widgets: Record<string, GrantLevel> = {};
  const capabilities: Record<string, GrantLevel> = {};
  for (const m of allPermissionModules()) modules[m.key] = isAdmin ? 'write' : MODULE_DEFAULT;
  for (const w of allPermissionWidgets()) widgets[w.id] = isAdmin ? 'allow' : WIDGET_DEFAULT;
  for (const item of PERMISSION_CAPABILITIES) capabilities[item.key] = isAdmin ? 'allow' : (item.default ?? CAPABILITY_DEFAULT);
  if (isAdmin) return { admin: true, modules, widgets, capabilities };

  const MODULE_KEY_SET = moduleKeySet();
  const WIDGET_ID_SET = widgetIdSet();

  const apply = (rows: PermissionRow[]) => {
    for (const r of rows) {
      if (r.resource_type === 'module' && MODULE_KEY_SET.has(r.resource_key) && MODULE_ACCESS_SET.has(r.access)) {
        modules[r.resource_key] = r.access as ModuleLevel;
      } else if (r.resource_type === 'widget' && WIDGET_ID_SET.has(r.resource_key) && WIDGET_ACCESS_SET.has(r.access)) {
        widgets[r.resource_key] = r.access as GrantLevel;
      } else if (r.resource_type === 'capability' && CAPABILITY_KEY_SET.has(r.resource_key) && CAPABILITY_ACCESS_SET.has(r.access)) {
        capabilities[r.resource_key] = r.access as GrantLevel;
      }
    }
  };

  // 1. Rollen-Profil, 2. Mitglied-Override (gewinnt).
  if (user?.family_role && FAMILY_ROLE_SET.has(user.family_role)) {
    apply(loadSubjectRows(database, 'role', user.family_role));
  }
  if (user?.id != null) {
    apply(loadSubjectRows(database, 'user', user.id));
  }

  // EIN WANDTABLETT BEKOMMT SEINE RECHTE AUS SEINER SCOPE-LISTE, NICHT AUS DER
  // RECHTEMATRIX (#1208).
  //
  // `isDisplay` KOMMT VOM AUFRUFER, diese Datei fragt die Datenbank nicht danach.
  // Der erste Anlauf tat genau das - ein `SELECT 1 FROM display_accounts` hier -
  // und machte damit aus einer Tabelle des Display-Features eine harte
  // Abhaengigkeit jeder Rechteaufloesung: FUENF Suiten mit handgebautem Schema
  // fielen nacheinander mit `no such table` um, jede an einer Stelle, die mit
  // Displays nichts zu tun hat. Wer die Antwort schon hat, reicht sie herein -
  // `requireAuth()` weiss es aus `req.authMethod`, ohne eine einzige Abfrage.
  // Der Standard ist `false`, also verhaelt sich jeder andere Aufrufer wie zuvor.
  //
  // Der Block steht NACH den beiden apply()-Durchgaengen:
  // was ein Display darf, ist eine Produktentscheidung, kein Feld, das ein
  // Administrator aufbohren kann - eine gespeicherte Zeile fuer dieses Konto
  // wird hier bewusst ueberschrieben.
  //
  // UND ES STEHT VOR DER WIDGET-VERERBUNG DARUNTER, weil genau die den Rest
  // erledigt: die Uebersicht bot dem Tablett Kacheln fuer Geburtstage, Budget
  // und Notizen an, die der Server dann leer liess (im Browser gesehen). Eine
  // zweite Liste im Frontend haette das auch behoben - und waere die zweite
  // Wahrheit darueber gewesen, was ein Display sieht. So folgt alles derselben
  // Quelle: Navigation, Kacheln und der Anlege-Knopf, der bei `read` verschwindet.
  //
  // `read` und nicht `write`: in diesem Schritt schaut ein Display nur zu. Die
  // beiden Aktionen kommen mit #1209, und dann aendert sich DISPLAY_SCOPES,
  // nicht diese Stelle.
  if (isDisplay) {
    const allowed = new Set(DISPLAY_SCOPE_MODULES);
    for (const key of Object.keys(modules)) {
      modules[key] = allowed.has(key) ? 'read' : 'none';
    }
  }

  // Widgets erben die Modulsperre.
  for (const w of allPermissionWidgets()) {
    if (w.module && modules[w.module] === 'none') widgets[w.id] = 'none';
  }
  return { admin: false, modules, widgets, capabilities };
}

/** Voller Katalog für die Admin-UI (Module, Widgets, Rollen). */
export function permissionCatalog() {
  return {
    modules: allPermissionModules().map((m) => ({
      key: m.key,
      labelKey: m.labelKey || null,
      label: m.label || null,
      icon: m.icon,
      extensionModuleId: m.extensionModuleId || null,
    })),
    widgets: allPermissionWidgets().map((w) => ({
      id: w.id,
      module: w.module,
      label: w.label || null,
      labelKey: w.labelKey || null,
    })),
    capabilities: PERMISSION_CAPABILITIES.map((item) => ({ ...item })),
    roles: [...FAMILY_ROLES],
    moduleAccessLevels: [...MODULE_ACCESS_LEVELS],
    widgetAccessLevels: [...WIDGET_ACCESS_LEVELS],
    capabilityAccessLevels: [...CAPABILITY_ACCESS_LEVELS],
    defaults: { module: MODULE_DEFAULT, widget: WIDGET_DEFAULT, capability: CAPABILITY_DEFAULT },
    // Startrechte-Vorlagen fuer das Einladungsformular (#869). Der Server
    // sagt, WELCHE Module die enge Vorlage sperrt - das Formular soll sie
    // benennen koennen, ohne die Liste ein zweites Mal zu fuehren.
    invitePresets: {
      values: [...INVITE_PRESETS],
      default: INVITE_PRESET_DEFAULT,
      restrictedModules: [...INVITE_RESTRICTED_MODULES],
    },
    // Was ein neues Kinderkonto zusaetzlich mitbringt (R20) - das Formular
    // nennt es unter der Familienrolle, ohne die Liste ein zweites Mal zu fuehren.
    childStart: {
      modules: { ...CHILD_START_PERMISSIONS.modules },
      capabilities: { ...CHILD_START_PERMISSIONS.capabilities },
    },
    scopeModuleKeys: getModuleKeys(),
  };
}

/**
 * Liefert die GESPEICHERTEN (abweichenden) Rechte eines Subjekts als Maps —
 * für die Admin-UI, die den Ist-Zustand editiert. Nicht gelistete Ressourcen
 * stehen implizit auf Standard.
 * @param {'role'|'user'} subjectType
 * @param {string|number} subjectId
 */
export function getSubjectPermissions(database: Database, subjectType: 'role' | 'user', subjectId: string | number) {
  const rows = loadSubjectRows(database, subjectType, subjectId);
  const modules: Record<string, string> = {};
  const widgets: Record<string, string> = {};
  const capabilities: Record<string, string> = {};
  const MODULE_KEY_SET = moduleKeySet();
  const WIDGET_ID_SET = widgetIdSet();
  for (const r of rows) {
    if (r.resource_type === 'module' && MODULE_KEY_SET.has(r.resource_key)) modules[r.resource_key] = r.access;
    else if (r.resource_type === 'widget' && WIDGET_ID_SET.has(r.resource_key)) widgets[r.resource_key] = r.access;
    else if (r.resource_type === 'capability' && CAPABILITY_KEY_SET.has(r.resource_key)) capabilities[r.resource_key] = r.access;
  }
  return { modules, widgets, capabilities };
}

/**
 * Validiert und normalisiert eine eingehende Rechte-Map (aus dem PUT-Body) zu
 * einer flachen Zeilen-Liste. Nur bekannte Schlüssel/Access-Werte werden
 * übernommen; Standard-Werte werden verworfen (Sparse-Prinzip). Wirft bei
 * ungültigen Werten.
 * @returns {{ resource_type: string, resource_key: string, access: string }[]}
 */
export function normalizePermissionInput(
  { modules = {}, widgets = {}, capabilities = {} }: PermissionInput = {},
  { subjectType = 'role' }: { subjectType?: string } = {},
): PermissionRow[] {
  const rows: PermissionRow[] = [];
  const MODULE_KEY_SET = moduleKeySet();
  const WIDGET_ID_SET = widgetIdSet();
  for (const [key, access] of Object.entries(modules || {})) {
    if (!MODULE_KEY_SET.has(key)) throw new Error(`Unknown module: ${key}`);
    if (!MODULE_ACCESS_SET.has(access)) throw new Error(`Invalid module access: ${access}`);
    if (access === MODULE_DEFAULT) continue; // Standard nicht speichern
    rows.push({ resource_type: 'module', resource_key: key, access });
  }
  for (const [id, access] of Object.entries(widgets || {})) {
    if (!WIDGET_ID_SET.has(id)) throw new Error(`Unknown widget: ${id}`);
    if (!WIDGET_ACCESS_SET.has(access)) throw new Error(`Invalid widget access: ${access}`);
    if (access === WIDGET_DEFAULT) continue;
    rows.push({ resource_type: 'widget', resource_key: id, access });
  }
  for (const [key, access] of Object.entries(capabilities || {})) {
    if (!CAPABILITY_KEY_SET.has(key)) throw new Error(`Unknown capability: ${key}`);
    if (!CAPABILITY_ACCESS_SET.has(access)) throw new Error(`Invalid capability access: ${access}`);
    // Rollenprofile bleiben sparse und erben damit auch kuenftige Defaults.
    // Nur ein Mitglied-Override muss `none` speichern koennen, um ein vom
    // Rollenprofil geerbtes `allow` ausdruecklich aufzuheben.
    const defaultAccess = PERMISSION_CAPABILITIES.find((item) => item.key === key)?.default ?? CAPABILITY_DEFAULT;
    if (access === defaultAccess && subjectType !== 'user') continue;
    rows.push({ resource_type: 'capability', resource_key: key, access });
  }
  return rows;
}

/**
 * Ersetzt die gespeicherten Modul- und Widget-Rechte eines Subjekts atomar
 * (delete + insert der abweichenden Einträge). Capabilities bleiben
 * unverändert, wenn das Feld fehlt; ein ausdrücklich mitgegebenes
 * `capabilities` ersetzt dagegen auch diese Achse. Transaktion vom Aufrufer
 * bereitgestellt oder hier gekapselt.
 * @param {import('better-sqlite3-multiple-ciphers').Database} database
 */
export function replaceSubjectPermissions(
  database: Database,
  subjectType: 'role' | 'user',
  subjectId: string | number,
  input: PermissionInput | undefined,
) {
  // Portable Transaktion (BEGIN/COMMIT/ROLLBACK): funktioniert sowohl mit
  // better-sqlite3 (Produktion) als auch node:sqlite (Tests). Kein
  // database.transaction()-Helfer, den node:sqlite nicht kennt.
  database.exec('BEGIN');
  try {
    writeSubjectPermissions(database, subjectType, subjectId, input);
    database.exec('COMMIT');
  } catch (err) {
    database.exec('ROLLBACK');
    throw err;
  }
  return getSubjectPermissions(database, subjectType, subjectId);
}

/**
 * Wie `replaceSubjectPermissions()`, aber OHNE eigene Transaktionsklammer -
 * fuer Aufrufer, die schon in einer stecken. Ersetzt Modul- und Widget-Zeilen;
 * Capability-Zeilen nur dann, wenn `input.capabilities` ausdrücklich vorliegt.
 *
 * Es gibt sie, weil das Annehmen einer Einladung Nutzer, Kontakt-Artefakte und
 * Startrechte in EINER Transaktion schreibt (#869). Ein `BEGIN` darin waere
 * ein Fehler, kein verschachtelter Bereich, und haette den ganzen Vorgang
 * abgebrochen: das Konto entstuende, die Rechte nicht - und die Einladung
 * waere verbraucht.
 */
export function writeSubjectPermissions(
  database: Database,
  subjectType: 'role' | 'user',
  subjectId: string | number,
  input: PermissionInput | undefined,
): number {
  const rows = normalizePermissionInput(input, { subjectType });
  const deleteModulesAndWidgets = database.prepare(`
    DELETE FROM access_permissions
    WHERE subject_type = ? AND subject_id = ?
      AND resource_type IN ('module', 'widget')
  `);
  const deleteCapabilities = database.prepare(`
    DELETE FROM access_permissions
    WHERE subject_type = ? AND subject_id = ? AND resource_type = 'capability'
  `);
  const ins = database.prepare(`
    INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES (?, ?, ?, ?, ?)
  `);
  deleteModulesAndWidgets.run(subjectType, String(subjectId));
  if (Object.prototype.hasOwnProperty.call(input || {}, 'capabilities')) {
    deleteCapabilities.run(subjectType, String(subjectId));
  }
  for (const r of rows) ins.run(subjectType, String(subjectId), r.resource_type, r.resource_key, r.access);
  return rows.length;
}

/**
 * Loest eine Einladungs-Vorlage zu dem Rechte-Set auf, das beim ersten Login
 * gilt.
 *
 * `null` heisst ausdruecklich "nichts eigenes schreiben": bei 'role' soll das
 * Rollenprofil greifen, und das tut es von selbst, weil `resolvePermissions()`
 * es vor dem Mitglied-Override anwendet. Eine Kopie des Profils als
 * user-Zeilen zu schreiben waere eine zweite Wahrheit - sie wuerde bei jeder
 * spaeteren Aenderung des Profils zurueckbleiben, ohne dass jemand sie
 * angelegt haben wollte.
 *
 * 'restricted' schreibt dagegen echte Mitglied-Zeilen. Sie kommen ZUSAETZLICH
 * zum Rollenprofil zur Wirkung: das Profil laeuft zuerst, diese drei Module
 * gewinnen danach. Eine Rolle, die ohnehin mehr sperrt, bleibt also strenger.
 *
 * @param {'restricted'|'role'} preset
 * @returns {{ modules: Record<string,string>, widgets: Record<string,string> }|null}
 */
export function invitePresetPermissions(
  preset: string | null | undefined,
): { modules: Record<string, string>; widgets: Record<string, string> } | null {
  if (preset !== 'restricted') return null;
  const modules: Record<string, string> = {};
  for (const key of INVITE_RESTRICTED_MODULES) modules[key] = 'none';
  return { modules, widgets: {} };
}

/**
 * Schreibt die Kinder-Startrechte fuer ein GERADE ANGELEGTES Konto.
 *
 * Aufrufer: die Anlagewege mit Familienrolle - `POST /auth/users` und das
 * Annehmen einer Einladung (server/auth.js), jeweils in der Transaktion, die
 * das Konto anlegt. OIDC legt Konten ohne Familienrolle an, die
 * Ersteinrichtung legt einen Admin an; beide brauchen das nicht.
 *
 * Laeuft NACH einer Einladungsvorlage und liest den aufgeloesten Stand, damit
 * nur Zeilen entstehen, die wirklich verschaerfen (siehe
 * CHILD_START_PERMISSIONS). Ein Admin umgeht die Rechte ohnehin.
 *
 * @param {import('better-sqlite3-multiple-ciphers').Database} database
 * @param {{ id: number, role: string, family_role?: string|null }} user
 * @returns {number} Anzahl geschriebener Zeilen
 */
export function applyChildStartPermissions(database: Database, user: PermissionUser | null | undefined): number {
  if (!user || user.id == null || user.role === 'admin' || user.family_role !== 'child') return 0;
  const current = resolvePermissions(database, user);
  const upsert = database.prepare(`
    INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('user', ?, ?, ?, ?)
    ON CONFLICT(subject_type, subject_id, resource_type, resource_key) DO UPDATE SET access = excluded.access
  `);
  let written = 0;
  for (const [key, access] of Object.entries(CHILD_START_PERMISSIONS.modules)) {
    if (!(key in current.modules)) continue;
    if (MODULE_ACCESS_RANK[access] >= MODULE_ACCESS_RANK[current.modules[key]]) continue;
    upsert.run(String(user.id), 'module', key, access);
    written += 1;
  }
  for (const [key, access] of Object.entries(CHILD_START_PERMISSIONS.capabilities)) {
    if (!(key in current.capabilities)) continue;
    if (CAPABILITY_ACCESS_RANK[access] >= CAPABILITY_ACCESS_RANK[current.capabilities[key]]) continue;
    upsert.run(String(user.id), 'capability', key, access);
    written += 1;
  }
  const preference = database.prepare(`
    INSERT INTO sync_config (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO NOTHING
  `);
  for (const [key, value] of Object.entries(CHILD_START_PREFERENCES)) {
    written += preference.run(`${key}:user:${Number(user.id)}`, value).changes as number;
  }
  return written;
}

export function isValidInvitePreset(preset: string): boolean {
  return INVITE_PRESETS.includes(preset);
}

export function isValidFamilyRole(role: string): boolean {
  return FAMILY_ROLE_SET.has(role);
}
