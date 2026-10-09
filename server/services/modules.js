/**
 * Module: Third-party module registry
 * Purpose: Discover Yuvomi modules from /modules, validate manifests, and expose enabled client modules.
 * Dependencies: node:fs/promises, server/db.js
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import * as db from '../db.js';
import { createLogger } from '../logger.js';
import { getSupportedLocales } from '../utils/i18n.js';
import { normalizeCapabilities, buildExtensionCatalog, MODULE_ID_RE as ID_RE } from './module-capabilities.js';
import { setExtensionScopeModules } from '../scopes.js';
import { setExtensionPermissionCatalog } from '../permissions.js';

const log = createLogger('Modules');

const MODULES_DIR = path.resolve(process.env.MODULES_DIR || path.join(import.meta.dirname, '..', '..', 'modules'));
const DISABLED_KEY = 'third_party_disabled_modules';
// Die hoechste Manifest-Formatversion, die diese Fassung lesen kann. Wer ein
// Feld aus `capabilities` entfernt oder umbenennt, hebt SIE an - der Guard in
// test/test-modules.js besteht darauf. Neue OPTIONALE Felder brauchen keine
// Anhebung: ein aelteres Modul laesst sie weg und verhaelt sich wie zuvor.
export const SUPPORTED_MANIFEST_VERSION = 1;

const SAFE_RELATIVE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/;
const MENU_LABEL_KEY_RE = /^[a-z][a-z0-9._-]{0,79}$/;
const MODULE_LOCALE_FILE_RE = /^([a-z]{2,3})\.json$/;
const EXTENSION_DEFAULT_LOCALE = 'en';

/** Sync cache for permissions/scopes — refreshed on each listModules(). */
let _extensionCatalog = {
  permissionModules: [],
  permissionWidgets: [],
  scopeModules: [],
};

function cfgGet(key) {
  const row = db.get().prepare('SELECT value FROM sync_config WHERE key = ?').get(key);
  return row ? row.value : null;
}

function cfgSet(key, value) {
  db.get().prepare(`
    INSERT INTO sync_config (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                   updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  `).run(key, value);
}

function parseDisabledModules() {
  try {
    const parsed = JSON.parse(cfgGet(DISABLED_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function setDisabledModules(ids) {
  const unique = [...new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && ID_RE.test(id)))];
  cfgSet(DISABLED_KEY, JSON.stringify(unique));
  return unique;
}

function isSafeRelativeFile(value) {
  if (typeof value !== 'string' || !SAFE_RELATIVE_RE.test(value)) return false;
  if (value.includes('..') || value.startsWith('/') || value.includes('\\')) return false;
  return true;
}

function modulePublicUrl(id, relPath) {
  return `/api/v1/modules/assets/${encodeURIComponent(id)}/${relPath.split('/').map(encodeURIComponent).join('/')}`;
}

// Exportiert fuer test/test-modules.js: der Formatvertrag wird an DIESER
// Funktion geprueft, nicht ueber den Umweg des Dateisystems - ein Test, der
// dafuer Ordner anlegt, veraendert die Liste, die andere Tests zaehlen.
export function normalizeManifest(raw, folderName) {
  const manifest = raw && typeof raw === 'object' ? raw : {};
  const id = String(manifest.id || folderName || '').trim();
  if (!ID_RE.test(id)) throw new Error('module.json must define a lowercase id using letters, numbers and hyphens.');
  if (id !== folderName) throw new Error('module id must match the folder name.');

  // FORMATVERSION DES MANIFESTS, nicht Version des Moduls (das ist `version`).
  //
  // WARUM DAS HIER STEHT UND NICHT SPAETER: seit #919 ist `capabilities` eine
  // zugesagte Oberflaeche - Widgets, `ext:<id>`-Rechte, ein API-Praefix, eine
  // Locale-Kette. `modules/` ist gitignored, die Module kommen zur Laufzeit,
  // und niemand hier sieht, wer die Oberflaeche mit welchen Annahmen benutzt.
  // Ohne diese Zahl waere jede kuenftige Umbenennung eines Feldes ein stiller
  // Bruch: das Modul laedt, das Feld fehlt, und der Haushalt merkt es an einem
  // Widget, das nichts mehr tut.
  //
  // FEHLT DIE ANGABE, gilt 1. Das ist keine Nachlaessigkeit, sondern der
  // einzige Wert, der die Manifeste nicht bricht, die es seit #919 schon geben
  // kann - sie beschreiben genau dieses Format.
  //
  // EINE ZU HOHE ZAHL WIRD ABGEWIESEN, statt teilweise gelesen zu werden. Ein
  // Manifest fuer ein Format, das diese Yuvomi-Fassung nicht kennt, halb zu
  // laden hiesse, Felder stillschweigend zu ignorieren, die es fuer wesentlich
  // haelt - und der Betreiber saehe ein Modul, das laeuft und etwas anderes
  // tut als beschrieben. Die Fehlermeldung nennt beide Zahlen, damit klar ist,
  // wer wen ueberholt hat.
  const rawManifestVersion = manifest.manifestVersion;
  const manifestVersion = rawManifestVersion === undefined || rawManifestVersion === null
    ? SUPPORTED_MANIFEST_VERSION
    : Number(rawManifestVersion);
  if (!Number.isInteger(manifestVersion) || manifestVersion < 1) {
    throw new Error('module.json manifestVersion must be a positive integer.');
  }
  if (manifestVersion > SUPPORTED_MANIFEST_VERSION) {
    throw new Error(
      `module.json declares manifestVersion ${manifestVersion}, but this Yuvomi supports up to `
      + `${SUPPORTED_MANIFEST_VERSION}. Update Yuvomi, or use a build of the module for this version.`,
    );
  }

  const entry = String(manifest.entry || '').trim();
  if (!isSafeRelativeFile(entry) || !entry.endsWith('.js')) {
    throw new Error('module.json entry must be a safe relative JavaScript file path.');
  }

  const style = manifest.style ? String(manifest.style).trim() : '';
  if (style && (!isSafeRelativeFile(style) || !style.endsWith('.css'))) {
    throw new Error('module.json style must be a safe relative CSS file path.');
  }

  const name = String(manifest.name || id).trim().slice(0, 80);
  const version = String(manifest.version || '').trim().slice(0, 40);
  const description = String(manifest.description || '').trim().slice(0, 240);
  const icon = String(manifest.icon || 'box').trim().slice(0, 40);
  const accent = /^#[0-9a-fA-F]{6}$/.test(manifest.accent || '') ? manifest.accent : '#6366F1';
  const menu = manifest.menu && typeof manifest.menu === 'object' ? manifest.menu : {};
  const showInMenu = menu.show !== false;
  let menuLabelKey = menu.labelKey ? String(menu.labelKey).trim().slice(0, 80) : null;
  if (menuLabelKey && !MENU_LABEL_KEY_RE.test(menuLabelKey)) {
    throw new Error('menu.labelKey is invalid.');
  }
  const label = String(menu.label || name).trim().slice(0, 40);
  const menuIcon = String(menu.icon || icon).trim().slice(0, 40);
  const order = Number.isFinite(Number(menu.order)) ? Number(menu.order) : 1000;
  const pathValue = String(menu.path || `/m/${id}`).trim();
  const routePath = pathValue === `/m/${id}` ? pathValue : `/m/${id}`;

  const COMPOSITION = new Set(['reading', 'data', 'dashboard', 'form', 'split', 'full']);
  const WIDTHS = new Set(['reading', 'content', 'wide']);
  const pageRaw = manifest.page && typeof manifest.page === 'object' ? manifest.page : {};
  const composition = COMPOSITION.has(String(pageRaw.composition || '').trim())
    ? String(pageRaw.composition).trim()
    : 'reading';
  const width = WIDTHS.has(String(pageRaw.width || '').trim())
    ? String(pageRaw.width).trim()
    : (composition === 'data' ? 'content' : composition === 'dashboard' ? 'wide' : 'reading');
  // Dieselbe Regel wie fuer composition und width: ein unbekannter Wert
  // faellt auf den unterstuetzten zurueck, statt roh weitergereicht zu werden.
  // MODULES.md verspricht `context.page` als NORMALISIERTE Erklaerung und
  // nennt fuer beide Felder nur `standard`; ein Tippfehler im Manifest darf
  // im Client keinen Zustand erzeugen, den es nicht gibt.
  const NAVIGATION = new Set(['standard']);
  const RESPONSIVE = new Set(['standard']);
  const navigation = NAVIGATION.has(String(pageRaw.navigation || '').trim())
    ? String(pageRaw.navigation).trim()
    : 'standard';
  const responsive = RESPONSIVE.has(String(pageRaw.responsive || '').trim())
    ? String(pageRaw.responsive).trim()
    : 'standard';

  return {
    id,
    name,
    version,
    // Nach aussen sichtbar, damit ein Betreiber in der Admin-Liste sieht, nach
    // welchem Format ein Modul gebaut ist - und nicht raten muss, warum eines
    // sich anders verhaelt als das daneben.
    manifestVersion,
    description,
    icon,
    accent,
    entry,
    style: style || null,
    page: {
      composition,
      width,
      navigation,
      responsive,
    },
    route: {
      path: routePath,
      entry: modulePublicUrl(id, entry),
      style: style ? modulePublicUrl(id, style) : null,
    },
    menu: {
      show: showInMenu,
      label,
      ...(menuLabelKey ? { labelKey: menuLabelKey } : {}),
      icon: menuIcon,
      order,
    },
  };
}

async function scanModuleLocales(basePath) {
  const dir = path.join(basePath, 'locales');
  const supported = new Set(getSupportedLocales());
  try {
    const entries = await fs.readdir(dir);
    return entries
      .map((file) => file.match(MODULE_LOCALE_FILE_RE)?.[1])
      .filter((loc) => loc && supported.has(loc))
      .sort();
  } catch {
    return [];
  }
}

function normalizeModuleI18n(rawI18n, availableLocales) {
  const supported = getSupportedLocales();
  const block = rawI18n && typeof rawI18n === 'object' ? rawI18n : {};
  let defaultLocale = String(block.defaultLocale || EXTENSION_DEFAULT_LOCALE).trim();
  if (!supported.includes(defaultLocale)) defaultLocale = EXTENSION_DEFAULT_LOCALE;
  if (availableLocales.length) {
    if (!availableLocales.includes(defaultLocale)) {
      defaultLocale = availableLocales.includes(EXTENSION_DEFAULT_LOCALE)
        ? EXTENSION_DEFAULT_LOCALE
        : availableLocales[0];
    }
  }
  return {
    defaultLocale,
    availableLocales,
    coreLocales: supported,
  };
}

function clientCapabilities(caps) {
  if (!caps) return null;
  return {
    permissionModuleKey: caps.permissionModuleKey,
    permissionModule: caps.permissionModule,
    apiPrefix: caps.apiPrefix,
    scopeKey: caps.scopeKey,
    widgets: (caps.widgets || []).map((w) => ({
      id: w.id,
      shortId: w.shortId,
      entry: w.entry,
      label: w.label,
      labelKey: w.labelKey || null,
      icon: w.icon,
      defaultSize: w.defaultSize,
      defaultVisible: w.defaultVisible,
      optionsSchema: w.optionsSchema,
      moduleKey: w.moduleKey,
    })),
  };
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// Wer ein Modul ueber die Einstellungen installiert hat, legt diese Datei in den
// Modulordner (server/services/module-install.js). Sie nennt Quelle und
// Zeitpunkt - und sie traegt den PRUEFSTAND des Moduls (DECISIONS.md, 12):
// `approved: false` schreibt jede Installation, jedes Ersetzen und das
// Ausschalten, `true` setzt erst ein Admin aus einer Browser-Sitzung
// (setModuleEnabled) - "ein Admin hat diese Fassung eingeschaltet". Der Stand wohnt
// in der Datei und nicht in der Datenbank, weil kein Backup `modules/` enthaelt:
// eine zurueckgespielte Datenbank oder eine frische ueber einem behaltenen
// Modulordner darf kein Modul einschalten, das nie jemand angesehen hat.
// Fehlt die Datei, laedt das Modul wie bisher - es wurde dann eben von Hand
// kopiert, und dafuer gilt allein die Sperrliste. Ist sie DA, aber nicht
// lesbar (abgeschnitten, von Hand verdorben), gilt das Gegenteil: die Datei
// sagt "hier hat die Oberflaeche installiert", und was sie nicht freigibt,
// bleibt aus - als Fehler, damit der Admin sieht, warum der Schalter fehlt.
export const INSTALL_META_FILE = '.yuvomi-install.json';
const INSTALL_META_MAX_BYTES = 4096;
const INSTALL_SOURCES = new Set(['zip', 'github']);

// Was das Dateisystem sagt, wenn der Server in den Ordner nicht schreiben darf.
// EINE Liste fuer die Installation (module-install.js assertWritable) und die
// Freigabe hier: beide antworten damit 503 `not_writable`, nie eine rohe
// Meldung mit dem absoluten Pfad der Temp-Datei.
export const NOT_WRITABLE_CODES = new Set(['EACCES', 'EPERM', 'EROFS']);

// Test-Haken wie in module-install.js: ein schreibgeschuetzter Modulordner
// laesst sich nicht auf jedem System herstellen (chmod auf Ordnern ist unter
// Windows wirkungslos). Tests tauschen die Primitive statt des Dateisystems.
const fsOps = {
  writeFile: (p, data, opts) => fs.writeFile(p, data, opts),
};

export function __setModulesFsOpsForTests(overrides = {}) {
  const previous = { ...fsOps };
  Object.assign(fsOps, overrides);
  return () => Object.assign(fsOps, previous);
}

// ── Installationssperre ──────────────────────────────────────────────────────
// Eine Installation, ein Loeschen ODER eine Freigabe zu einer Zeit; eine
// zweite wird abgewiesen statt eingereiht. Zwei Admins, die dasselbe Modul
// zugleich ersetzen, liefen sonst auf den Sicherungsordner auf, und der
// zweite ueberschriebe den ersten stillschweigend. Die Sperre wohnt HIER und
// nicht in module-install.js, weil auch die Freigabe (setModuleEnabled) sie
// nehmen muss: sie liest die Liste und schreibt dann `approved: true` in die
// Datei, die in dem Moment im Ordner liegt - landete ein Ersetzen dazwischen,
// bekaeme die neue Fassung die Freigabe, die der alten galt, und niemand
// haette sie angesehen. module-install.js importiert von hier; umgekehrt
// waere es ein Kreis.
let installBusy = false;

/** Nimmt die Sperre. Gibt die Freigabe-Funktion zurueck, oder null, wenn sie vergeben ist. */
export function acquireInstallLock() {
  if (installBusy) return null;
  installBusy = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    installBusy = false;
  };
}

/**
 * Die geprueften Felder der Datei, samt `installedBy` (Nutzer-Id). Fuer den
 * Service; eine Antwort bekommt die Form aus readInstallMeta().
 */
export async function readInstallRecord(basePath) {
  try {
    const file = path.join(basePath, INSTALL_META_FILE);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > INSTALL_META_MAX_BYTES) return null;
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || !INSTALL_SOURCES.has(raw.source)) return null;
    const str = (v, max) => (typeof v === 'string' && v ? v.slice(0, max) : null);
    return {
      source: raw.source,
      url: str(raw.url, 500),
      ref: str(raw.ref, 200),
      commit: str(raw.commit, 64),
      path: str(raw.path, 500),
      installedAt: str(raw.installedAt, 40),
      // Nur das Literal `true` zaehlt: eine Datei, die das Feld nicht kennt
      // (oder "true" als Text traegt), ist nicht freigegeben.
      approved: raw.approved === true,
      installedBy: Number.isInteger(raw.installedBy) ? raw.installedBy : null,
    };
  } catch {
    return null;
  }
}

/**
 * Die Form fuer Antworten. installedBy bleibt draussen: die Admin-Liste zeigt
 * stattdessen den Namen (installedByName, siehe readModule). Der Rest geht nur
 * an Admins - listModules() nimmt `install` aus der Liste fuer alle anderen
 * heraus (Quelle und Commit sagen einem Mitglied nichts, einem Angreifer aber,
 * woher der Code kommt).
 */
export async function readInstallMeta(basePath) {
  const record = await readInstallRecord(basePath);
  if (!record) return null;
  // eslint-disable-next-line no-unused-vars
  const { installedBy, ...meta } = record;
  return meta;
}

/**
 * Schreibt `approved` in die Datei um, atomar (Temp-Datei + rename), damit
 * ein Absturz mittendrin nie eine halbe Datei hinterlaesst, die readInstallRecord()
 * als "kaputt" liest - das Modul liefe dann als von Hand kopiert. Alle anderen
 * Felder bleiben, wie die Installation sie geschrieben hat.
 */
export async function writeInstallApproval(basePath, approved) {
  const file = path.join(basePath, INSTALL_META_FILE);
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  if (!raw || typeof raw !== 'object') throw new Error('install record is not an object.');
  raw.approved = approved === true;
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsOps.writeFile(tmp, JSON.stringify(raw, null, 2), { flag: 'wx', mode: 0o644 });
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

// Der Name zum installedBy der Datei, fuer die Details der Admin-Liste. null
// fuer ein geloeschtes Konto (die Seite sagt dann "ein frueheres Mitglied")
// und fuer eine Datei ohne Id.
function installedByName(userId) {
  if (!Number.isInteger(userId)) return null;
  const row = db.get().prepare('SELECT display_name FROM users WHERE id = ?').get(userId);
  return row?.display_name || null;
}

/**
 * Laedt und prueft einen Modulordner - DERSELBE Weg fuer den Loader und fuer die
 * Installation aus den Einstellungen. Die Installation prueft den Staging-Ordner
 * hiermit, bevor er an seinen Platz rueckt: was hier durchgeht, laedt auch der
 * Loader, und was der Loader ablehnt, wird gar nicht erst installiert.
 * Wirft mit der Meldung, die der Loader als `error` zeigen wuerde.
 */
export async function loadModuleDir(basePath, folderName) {
  const stat = await fs.stat(basePath);
  if (!stat.isDirectory()) throw new Error('module path is not a directory.');
  const manifestPath = path.join(basePath, 'module.json');
  const raw = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const manifest = normalizeManifest(raw, folderName);
  const entryPath = path.resolve(basePath, manifest.entry);
  if (!entryPath.startsWith(`${basePath}${path.sep}`) || !(await pathExists(entryPath))) {
    throw new Error('entry file does not exist.');
  }
  if (manifest.style) {
    const stylePath = path.resolve(basePath, manifest.style);
    if (!stylePath.startsWith(`${basePath}${path.sep}`) || !(await pathExists(stylePath))) {
      throw new Error('style file does not exist.');
    }
  }
  const capabilities = await normalizeCapabilities(
    raw,
    manifest.id,
    basePath,
    modulePublicUrl,
    pathExists,
    isSafeRelativeFile,
  );
  const availableLocales = await scanModuleLocales(basePath);
  const i18n = normalizeModuleI18n(raw.i18n, availableLocales);
  return { manifest, capabilities, i18n };
}

async function readModule(folderName, disabledSet, { withInstaller = false } = {}) {
  const basePath = path.join(MODULES_DIR, folderName);
  let install = null;
  try {
    const recordPresent = await fs.lstat(path.join(basePath, INSTALL_META_FILE))
      .then((stat) => stat.isFile(), () => false);
    const stat = await fs.stat(basePath);
    if (!stat.isDirectory()) return null;
    // Kosten je Modul und Listenaufruf: ein lstat, hoechstens 4 KiB lesen und
    // eine Zeile aus `users` - neben module.json, Entry und Locales, die
    // listModules() ohnehin jedes Mal neu liest. Ein Cache lohnte die Frage
    // nach seiner Gueltigkeit nicht (jede Installation schreibt die Datei neu,
    // ein Betreiber kann sie loeschen).
    const record = await readInstallRecord(basePath);
    if (recordPresent && !record) {
      throw new Error(`${INSTALL_META_FILE} is present but unreadable; fix or remove it on the server.`);
    }
    if (record) {
      // eslint-disable-next-line no-unused-vars
      const { installedBy, ...meta } = record;
      // Den Namen schlaegt nur die Admin-Liste nach: fuer jede Asset-Antwort
      // (resolveAssetPath) waere das eine Zeile aus `users` je Modul, und das
      // Mitglied bekommt `install` ohnehin nicht zu sehen.
      install = { ...meta, installedByName: withInstaller ? installedByName(installedBy) : null };
    }
    const { manifest, capabilities, i18n } = await loadModuleDir(basePath, folderName);
    // Ein Modul mit Installationsdatei ist aus, bis die Datei die Freigabe
    // traegt - was auch immer die Sperrliste sagt (sie kann aus einem Backup
    // von vor der Installation stammen). Danach, und fuer einen von Hand
    // kopierten Ordner von Anfang an, entscheidet die Sperrliste allein.
    const enabled = (record ? record.approved : true) && !disabledSet.has(manifest.id);
    return {
      ...manifest,
      i18n,
      capabilities: clientCapabilities(capabilities),
      install,
      enabled,
      status: enabled ? 'enabled' : 'disabled',
      error: null,
    };
  } catch (err) {
    return {
      id: folderName,
      name: folderName,
      version: '',
      description: '',
      icon: 'triangle-alert',
      accent: '#EF4444',
      route: null,
      menu: { show: false, label: folderName, icon: 'triangle-alert', order: 1000 },
      capabilities: null,
      install,
      enabled: false,
      status: 'error',
      error: err?.message || 'Module could not be loaded.',
    };
  }
}

function refreshExtensionCatalog(modules) {
  const enabled = modules.filter((m) => m.enabled && m.status === 'enabled');
  _extensionCatalog = buildExtensionCatalog(
    enabled.map((m) => ({
      ...m,
      capabilities: m.capabilities ? {
        permissionModuleKey: m.capabilities.permissionModuleKey,
        permissionModule: m.capabilities.permissionModule,
        widgets: m.capabilities.widgets,
        apiPrefix: m.capabilities.apiPrefix,
        scopeKey: m.capabilities.scopeKey,
      } : null,
    })),
  );
  setExtensionScopeModules(_extensionCatalog.scopeModules);
  setExtensionPermissionCatalog(_extensionCatalog);
}

async function listModules({ admin = false } = {}) {
  await fs.mkdir(MODULES_DIR, { recursive: true });
  const disabledSet = new Set(parseDisabledModules());
  const entries = await fs.readdir(MODULES_DIR).catch((err) => {
    log.error('Could not read modules directory:', err);
    return [];
  });

  // Eintraege mit fuehrendem Punkt sind keine Module: die Installation legt dort
  // ihre Staging- und Sicherungsordner ab (`.install-*`, `.backup-*`), und ein
  // `.git` oder `.DS_Store` eines Betreibers gehoert ebenso wenig in die Liste.
  const modules = (await Promise.all(entries
    .filter((entry) => !entry.startsWith('.'))
    .map((entry) => readModule(entry, disabledSet, { withInstaller: admin }))))
    .filter(Boolean)
    .sort((a, b) => (a.menu?.order ?? 1000) - (b.menu?.order ?? 1000) || a.name.localeCompare(b.name));

  refreshExtensionCatalog(modules);

  if (admin) return modules;
  return modules
    .filter((module) => module.enabled && module.status === 'enabled')
    // eslint-disable-next-line no-unused-vars
    .map(({ install, ...rest }) => rest);
}

async function setModuleEnabled(id, enabled) {
  if (!ID_RE.test(String(id || ''))) {
    const err = new Error('Invalid module id.');
    err.status = 400;
    throw err;
  }
  // Einschalten braucht die Sperre: es liest die Liste und schreibt dann in
  // die Datei im Ordner, und dazwischen darf kein Ersetzen landen (siehe
  // acquireInstallLock). Ausschalten nimmt sie nur, wenn sie frei ist, denn
  // auch sein `approved: false` liest und schreibt die Datei um - ein Ersetzen
  // dazwischen truege die Herkunft der alten Fassung in den neuen Ordner. Ist
  // sie vergeben, schaltet es trotzdem aus und laesst nur die Datei liegen:
  // Ausschalten nimmt Code weg und wartet auf nichts, auch nicht auf einen
  // GitHub-Download, der bis zu 30 s dauern kann.
  const release = acquireInstallLock();
  if (enabled && !release) {
    const err = new Error('Another module install or delete is in progress. Try again in a moment.');
    err.status = 409;
    err.reason = 'busy';
    throw err;
  }
  try {
    return await applyModuleEnabled(id, enabled, { writeRecord: Boolean(release) });
  } finally {
    release?.();
  }
}

async function applyModuleEnabled(id, enabled, { writeRecord = true } = {}) {
  const modules = await listModules({ admin: true });
  const target = modules.find((module) => module.id === id);
  if (!target) {
    const err = new Error('Module not found.');
    err.status = 404;
    throw err;
  }
  if (target.status === 'error' && enabled) {
    const err = new Error(target.error || 'Module has errors and cannot be enabled.');
    err.status = 400;
    throw err;
  }

  // `approved` heisst: ein Admin hat DIESE Fassung eingeschaltet. Einschalten
  // schreibt es in die Datei, BEVOR die Sperrliste faellt - scheitert das
  // Schreiben, bleibt das Modul aus. Ausschalten geht den umgekehrten Weg:
  // erst die Sperrliste (sie allein entscheidet schon), dann `approved: false`
  // in die Datei, damit auch "aus" mit dem Ordner reist - eine zurueckgespielte
  // Datenbank schaltete sonst wieder ein, was der Admin abgeschaltet hatte.
  // Dieses zweite Schreiben ist Zugabe: Ausschalten nimmt Code weg und darf
  // nie daran scheitern, dass der Ordner schreibgeschuetzt ist oder gerade
  // eine Installation die Sperre haelt (log.warn, die Datei bleibt dann).
  // Ein Ersetzen schreibt ohnehin seine eigene Datei mit `approved: false`.
  // Eine Installation oder ein Ersetzen setzt die Freigabe ebenfalls zurueck
  // (module-install.js).
  if (enabled && target.install && !target.install.approved) {
    try {
      await writeInstallApproval(path.join(MODULES_DIR, id), true);
    } catch (err) {
      // Ein schreibgeschuetzter Modulordner ist der eine Fall, den der Admin
      // selbst einordnen kann: 503 wie bei der Installation, mit Grund. Alles
      // andere (die Datei ist zwischen Lesen und Schreiben verschwunden) bleibt
      // ein 500 - die Route schickt dann einen festen Satz, nie err.message,
      // denn die nennt den absoluten Pfad der Temp-Datei.
      if (NOT_WRITABLE_CODES.has(err?.code)) {
        const refused = new Error(`The folder modules/${id} on the server is not writable, so the approval cannot be recorded. Make it writable for the server, then try again.`);
        refused.status = 503;
        refused.reason = 'not_writable';
        throw refused;
      }
      throw err;
    }
  }
  const disabled = new Set(parseDisabledModules());
  if (enabled) disabled.delete(id);
  else disabled.add(id);
  setDisabledModules([...disabled]);
  if (!enabled && target.install?.approved) {
    if (!writeRecord) {
      log.warn(`Module ${id} is off, but its install record still says approved (an install or delete holds the lock, so it was left as it is).`);
    } else {
      try {
        await writeInstallApproval(path.join(MODULES_DIR, id), false);
      } catch (err) {
        log.warn(`Module ${id} is off, but its install record still says approved (could not write it):`, err?.message);
      }
    }
  }
  return (await listModules({ admin: true })).find((module) => module.id === id);
}

/**
 * Setzt nur den gespeicherten Schalter, ohne das Modul zu laden. Fuer das
 * Loeschen (module-install.js): der Ordner ist dann schon weg, und
 * setModuleEnabled() verlangt ein ladbares Modul. Dass ein NEUES Modul aus
 * landet, besorgt nicht mehr die Sperrliste, sondern `approved: false` in
 * seiner Installationsdatei - die liegt im Staging-Ordner, bevor er an seinen
 * Platz rueckt, es gibt also keinen Moment, in dem fremder Code schon
 * ausgeliefert wuerde.
 */
function setModuleDisabledFlag(id, disabled) {
  if (!ID_RE.test(String(id || ''))) return;
  const set = new Set(parseDisabledModules());
  if (disabled) set.add(id);
  else set.delete(id);
  setDisabledModules([...set]);
}

function isModuleDisabled(id) {
  return parseDisabledModules().includes(id);
}

async function resolveAssetPath(id, relPath) {
  const modules = await listModules({ admin: false });
  const module = modules.find((item) => item.id === id);
  if (!module) {
    const err = new Error('Module not found or disabled.');
    err.status = 404;
    throw err;
  }
  // Punktdateien werden nie ausgeliefert - allen voran `.yuvomi-install.json`,
  // die der Installer in jeden Modulordner legt (sie nennt den installierenden
  // Admin). 404 statt 400: von aussen sieht so eine Datei aus wie keine. `.`
  // und `..` bleiben der Traversal-Pruefung darunter (400) ueberlassen.
  if (String(relPath).split('/').some((seg) => seg.startsWith('.') && seg !== '.' && seg !== '..')) {
    const err = new Error('Module asset not found.');
    err.status = 404;
    throw err;
  }
  if (!isSafeRelativeFile(relPath)) {
    const err = new Error('Invalid module asset path.');
    err.status = 400;
    throw err;
  }
  const basePath = path.join(MODULES_DIR, id);
  const assetPath = path.resolve(basePath, relPath);
  if (!assetPath.startsWith(`${basePath}${path.sep}`)) {
    const err = new Error('Invalid module asset path.');
    err.status = 400;
    throw err;
  }
  if (!(await pathExists(assetPath))) {
    const err = new Error('Module asset not found.');
    err.status = 404;
    throw err;
  }
  return assetPath;
}

function getExtensionPermissionCatalog() {
  return _extensionCatalog;
}

export {
  MODULES_DIR,
  listModules,
  setModuleEnabled,
  setModuleDisabledFlag,
  isModuleDisabled,
  resolveAssetPath,
  getExtensionPermissionCatalog,
};

export { extensionPermissionKey } from './module-capabilities.js';
