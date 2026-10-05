/**
 * Tests: Pluralformen in t() (Audit-Befund nach #534)
 * Zweck: `{{count}}`-Strings waren hart im Plural formuliert - „1 Adressbücher
 *        aktiviert". t() wählt jetzt über Intl.PluralRules die passende Variante
 *        (`key_one`, `key_few`, …) und fällt auf den Basisschlüssel zurück,
 *        wenn eine Locale die Variante nicht kennt.
 * Ausführen: node test/test-i18n-plural.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const LOCALE_DIR = new URL('../public/locales/', import.meta.url);
const localeFile = (locale) => JSON.parse(readFileSync(new URL(`${locale}.json`, LOCALE_DIR), 'utf8'));

/** Verschachtelte Locale-Datei zu einer flachen Map `a.b.c` -> Wert. */
const flattenLocale = (obj, prefix = '', out = new Map()) => {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') flattenLocale(v, key, out);
    else out.set(key, v);
  }
  return out;
};

// i18n.js ist Browser-Code: Umgebung stellen, bevor das Modul geladen wird.
const store = new Map();
global.localStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
global.document = { documentElement: { lang: '', dir: '' } };
global.window = { dispatchEvent: () => {}, matchMedia: () => ({ matches: false }) };
global.CustomEvent = class { constructor(type, init) { this.type = type; Object.assign(this, init); } };
global.fetch = async (url) => {
  const locale = String(url).replace('/locales/', '').replace('.json', '');
  return { ok: true, json: async () => localeFile(locale) };
};
Object.defineProperty(global, 'navigator', {
  value: { languages: ['de-DE'], language: 'de-DE' },
  writable: true,
  configurable: true,
});

const { initI18n, setLocale, t } = await import('../public/i18n.js');
await initI18n();

test('Deutsch: Singular und Plural je nach count', async () => {
  await setLocale('de');
  assert.equal(t('settings.enabledReminderListCount', { count: 1 }), '1 Erinnerungsliste aktiviert');
  assert.equal(t('settings.enabledReminderListCount', { count: 2 }), '2 Erinnerungslisten aktiviert');
  assert.equal(t('settings.enabledReminderListCount', { count: 0 }), '0 Erinnerungslisten aktiviert');
});

test('Abos: „1 Tag überfällig", nicht „1 Tage" (Critique 2026-09-25)', async () => {
  await setLocale('de');
  assert.equal(t('subscriptions.overdueDays', { count: 1 }), '1 Tag überfällig');
  assert.equal(t('subscriptions.overdueDays', { count: 3 }), '3 Tage überfällig');
  assert.equal(t('subscriptions.reminderMeta', { count: 1 }), '1 Tag vorher');
  await setLocale('en');
  assert.equal(t('subscriptions.overdueDays', { count: 1 }), '1 day overdue');
});

test('Englisch: Singular und Plural je nach count', async () => {
  await setLocale('en');
  assert.equal(t('settings.enabledReminderListCount', { count: 1 }), '1 reminder list enabled');
  assert.equal(t('settings.enabledReminderListCount', { count: 3 }), '3 reminder lists enabled');
  assert.equal(t('settings.calendarImport.success', { count: 1 }), '1 event imported.');
  assert.equal(t('settings.calendarImport.success', { count: 4 }), '4 events imported.');
});

test('Fasting-Zielabdeckung flektiert nach erfassten Zielen, nicht nach allen Fasten', async () => {
  await setLocale('en');
  assert.equal(
    t('health.fasting.goalCoverage', { count: 1, records: 1, total: 2 }),
    'Goal recorded for 1 of 2 fasts',
  );
  assert.equal(
    t('health.fasting.goalCoverage', { count: 2, records: 2, total: 3 }),
    'Goals recorded for 2 of 3 fasts',
  );
});

test('Kalender-Override-Bestätigung lokalisiert genau den bestätigten count', async () => {
  await setLocale('de');
  assert.equal(
    t('calendar.overrideOrphanConfirmTitle', { count: 1 }),
    '1 bearbeiteten Termin beibehalten?',
  );
  assert.equal(
    t('calendar.overrideOrphanConfirmTitle', { count: 3 }),
    '3 bearbeitete Termine beibehalten?',
  );
  await setLocale('en');
  assert.equal(
    t('calendar.overrideOrphanConfirmTitle', { count: 1 }),
    'Keep 1 edited occurrence?',
  );
  assert.equal(
    t('calendar.overrideOrphanConfirmTitle', { count: 3 }),
    'Keep 3 edited occurrences?',
  );
});

test('Sprachen ohne Zahlflexion liefern für jede Anzahl denselben Satz', async () => {
  await setLocale('ja');
  const one = t('settings.enabledReminderListCount', { count: 1 });
  const many = t('settings.enabledReminderListCount', { count: 5 });
  assert.equal(one.replace('1', 'N'), many.replace('5', 'N'));
});

test('Polnisch: das zaehlunabhaengige „Label: N"-Muster bleibt in jeder Kategorie korrekt', async () => {
  await setLocale('pl');
  // pl kennt one/few/many/other; hier tragen alle Varianten dasselbe neutrale
  // Muster, das fuer jede Zahl stimmt (1 one, 2 und 22 few, 5 many).
  for (const count of [1, 2, 5, 22]) {
    assert.match(t('settings.enabledReminderListCount', { count }), /Włączone listy przypomnień: \d+/);
  }
});

test('„N von M"-Zähler nutzt bei einem Eintrag die Singularform', async () => {
  // Die _one-Variante ging beim Umbenennen einer früheren Runde verloren:
  // „1 von 1 Adressbüchern aktiv". t() wählt über count (= Gesamtzahl).
  await setLocale('de');
  assert.equal(
    t('settings.addressbooksEnabledOfTotal', { enabled: 1, total: 1, count: 1 }),
    '1 von 1 Adressbuch aktiv',
  );
  assert.equal(
    t('settings.addressbooksEnabledOfTotal', { enabled: 1, total: 3, count: 3 }),
    '1 von 3 Adressbüchern aktiv',
  );
  await setLocale('en');
  assert.equal(
    t('settings.calendarsEnabledOfTotal', { enabled: 0, total: 1, count: 1 }),
    '0 of 1 calendar active',
  );
  assert.equal(
    t('settings.calendarsEnabledOfTotal', { enabled: 2, total: 4, count: 4 }),
    '2 of 4 calendars active',
  );
});

test('Standard-Punkte (#578): zählende Strings nutzen die Singularform', async () => {
  // Review-Fund: die vier count-Strings des Features waren hart im Plural
  // formuliert („1 Aufgaben aktualisiert").
  await setLocale('de');
  assert.equal(t('tasks.pointsSummary', { count: 1 }), '1 Punkt');
  assert.equal(t('tasks.pointsSummary', { count: 10 }), '10 Punkte');
  assert.equal(t('settings.rewardsDefaultPointsRebased', { count: 1 }), '1 Aufgabe aktualisiert.');
  assert.equal(t('settings.rewardsDefaultPointsRebased', { count: 3 }), '3 Aufgaben aktualisiert.');
  assert.match(t('settings.rewardsDefaultPointsRebaseTitle', { count: 1, from: 10, to: 15 }), /^1 Aufgabe von 10 auf 15 /);

  await setLocale('en');
  assert.equal(t('tasks.pointsSummary', { count: 1 }), '1 point');
  assert.equal(t('tasks.pointsSummary', { count: 4 }), '4 points');
  assert.equal(t('settings.rewardsDefaultPointsRebased', { count: 1 }), '1 task updated.');
  assert.equal(t('settings.rewardsDefaultPointsRebased', { count: 2 }), '2 tasks updated.');
});

test('Garantie-Restlaufzeit (Inventar, Stufe 4): zählender String nutzt die Singularform', async () => {
  // Review-Fund: der String wurde mit `days` interpoliert. t() wählt die
  // Pluralvariante ausschließlich über einen numerischen `count` - daher stand
  // dort "in 1 Tagen".
  await setLocale('de');
  assert.equal(t('inventory.warrantyStatusExpiringSoon', { count: 1 }), 'Garantie läuft in 1 Tag ab');
  assert.equal(t('inventory.warrantyStatusExpiringSoon', { count: 12 }), 'Garantie läuft in 12 Tagen ab');

  await setLocale('en');
  assert.equal(t('inventory.warrantyStatusExpiringSoon', { count: 1 }), 'Warranty ends in 1 day');
  assert.equal(t('inventory.warrantyStatusExpiringSoon', { count: 30 }), 'Warranty ends in 30 days');
});

test('Schlüssel ohne Pluralvarianten funktionieren unverändert', async () => {
  await setLocale('de');
  assert.equal(t('common.save'), localeFile('de').common.save);
  // count-Parameter ohne passende Variante (7 → „other"): Basisschlüssel plus Interpolation.
  assert.equal(
    t('settings.enabledReminderListCount', { count: 7 }),
    '7 Erinnerungslisten aktiviert',
  );
});

test('unbekannter Schlüssel liefert den Schlüssel selbst zurück - auch mit count', async () => {
  await setLocale('de');
  assert.equal(t('gibt.es.nicht'), 'gibt.es.nicht');
  assert.equal(t('gibt.es.nicht', { count: 2 }), 'gibt.es.nicht');
});

test('jede Pluralvariante hat einen zählenden Basisschlüssel in allen Locales', () => {
  const files = readdirSync(LOCALE_DIR).filter((f) => f.endsWith('.json'));
  // Pluralvariante = Suffix einer CLDR-Kategorie UND ein {{count}} im Wert.
  // Das trennt sie von echten Enum-Werten wie `budget.accountType_other`.
  for (const file of files) {
    const entries = flattenLocale(JSON.parse(readFileSync(new URL(file, LOCALE_DIR), 'utf8')));
    for (const [key, value] of entries) {
      if (!/_(zero|one|two|few|many|other)$/.test(key)) continue;
      if (typeof value !== 'string' || !value.includes('{{count}}')) continue;
      const base = key.replace(/_(zero|one|two|few|many|other)$/, '');
      assert.ok(entries.has(base), `${file}: ${key} ohne Basisschlüssel ${base}`);
      assert.match(entries.get(base), /\{\{count\}\}/, `${file}: ${base} zählt nicht`);
    }
  }
});

// ---------------------------------------------------------------------------
// Die Gegenrichtung: ein zählender Schlüssel OHNE Variante (#1010)
//
// Der Test oben geht von der Variante aus und findet deshalb nur den Fehler
// „Variante da, Basis fehlt". Der Fehler, den Menschen tatsächlich machen, ist
// der andere: `{{count}}` schreiben und die `_one`-Variante vergessen. Zwei
// unabhängige PRs lieferten am 2./3.09. je drei solcher Schlüssel bei gruener
// CI - „1 Dateien hochladen".
//
// Gemessen wird `de.json`, die Referenz-Locale: was dort eine Variante braucht,
// braucht sie ueberall. Der umgekehrte Fall (eine Sprache braucht eine Variante,
// wo Deutsch keine braucht) ist eine groessere Frage und nicht die dieses Guards.
//
// WARUM EINE AUSNAHMEKARTE UND KEIN STRIKTES ROT: der Bestand traegt 70 solcher
// Schluessel. Ein Guard, der beim ersten Lauf 70-mal scheitert, wird abgeschwaecht
// statt erfuellt - danach prueft er wieder nichts. Die Karte friert den Bestand
// ein; jeder NEUE zaehlende Schluessel ohne Variante ist ab sofort rot.
//
// BEKANNTE GRENZE: erkannt wird ein zaehlender Schluessel am `{{count}}` im WERT.
// Ein Aufrufer darf `count` aber auch nur zur Pluralwahl uebergeben, waehrend der
// Text andere Platzhalter interpoliert - `settings.addressbooksEnabledOfTotal` macht
// genau das (`{{enabled}} von {{total}}`, Aufruf mit `count: addressbooks.length`,
// sync-contacts.js:163). Solche Schluessel sieht dieser Guard nicht; sie zu finden
// hiesse, jeden `t()`-Aufruf auf ein `count:`-Argument zu lesen. Bewusst offen
// gelassen: die haeufige Luecke ist die hier gepruefte.
//
// Die Kategorie sagt, WARUM der Schluessel keine Variante braucht - und sie ist
// am AUFRUFER belegt, nicht am Wortlaut. Ein String, der klingt, als koenne er
// nicht bei 1 stehen, kann es meistens doch (#1010 nennt zwei Faelle, die genau
// so durchgefallen sind).
// ---------------------------------------------------------------------------

/**
 * Zaehlende Basisschluessel ohne `_one` - der eingefrorene Bestand.
 *
 * NO_NOUN        Auf die Zahl folgt kein Substantiv („3 ausgewaehlt", „3 aktiv").
 *                Im Deutschen numerusneutral, braucht keine Variante.
 * PARENTHETICAL  Die Zahl steht in Klammern oder hinter einem Doppelpunkt UND der
 *                uebrige Satz traegt keinen Numerus ("Importieren (3)",
 *                "fehlgeschlagen: 3"). ACHTUNG: die Klammer allein macht nichts
 *                neutral - "Dateikonflikte (1)" ist falsch, weil das Substantiv
 *                davor im Plural steht. Vor dieser Kategorie den GANZEN String
 *                lesen, nicht nur die Klammer.
 * ABBREV         Die Einheit ist eine numerusneutrale Abkuerzung („3 Min.").
 * PAIR_LEGACY    Handgebautes Paar aus der Zeit vor `_one` (Suffix `Plural`,
 *                `Many`/`One`, `Singular`). Heute korrekt, nur alte Schreibweise.
 *                Ein Umbau auf `_one` waere ein eigener Vorgang: 20+ Aufrufstellen.
 * NOT_A_COUNT    `count` ist gar kein Zaehler, sondern ein Zahlenwert oder ein
 *                bereits formatierter String. Plural-Regeln greifen hier nicht.
 * GUARDED        n=1 ist AM AUFRUFER ausgeschlossen - mit Datei und Zeile belegt.
 * DEAD_KEY       Der Schluessel wird nirgends aufgerufen (in allen Locales
 *                vorhanden, im Code nicht). Aufraeumen ist eine eigene Aenderung -
 *                24 Sprachdateien, und sie duerfen nicht reserialisiert werden.
 * TODO_ONE       Echte Luecke: n=1 ist erreichbar und der Satz ist dann falsch.
 *                Steht hier, damit der Guard scharf gestellt werden kann, ohne
 *                24 Locales in derselben Aenderung anzufassen.
 */
const PLURAL_EXCEPTIONS = {
  // --- kein Substantiv nach der Zahl -------------------------------------
  'contacts.selectCount': 'NO_NOUN',
  'contacts.importSelectedStatus': 'NO_NOUN',
  'contacts.importDetailBirthday': 'NO_NOUN',
  'contacts.importDetailFailed': 'NO_NOUN',
  'documents.selectCount': 'NO_NOUN',
  'tasks.bulkSelectedCount': 'NO_NOUN',
  'dashboard.todayShoppingCount': 'NO_NOUN',
  'dashboard.rewardsPending': 'NO_NOUN',
  'dashboard.healthRefill': 'NO_NOUN',
  'health.labs.abnormalBadge': 'NO_NOUN',
  'subscriptions.activeCount': 'NO_NOUN',

  // --- Zahl in Klammern / hinter Doppelpunkt ------------------------------
  'category.errorInUse': 'PARENTHETICAL',
  'category.errorSubInUse': 'PARENTHETICAL',
  'shopping.clearChecked': 'PARENTHETICAL',
  'contacts.importSubmit': 'PARENTHETICAL',
  'health.cycle.settings.applyToAllDone': 'PARENTHETICAL',

  // --- numerusneutrale Abkuerzung ----------------------------------------
  'settings.calendarDurationMinutes': 'ABBREV',

  // --- handgebaute Paare, alte Schreibweise -------------------------------
  'search.resultCountOne': 'PAIR_LEGACY',
  'search.resultCountMany': 'PAIR_LEGACY',
  'contacts.countMany': 'PAIR_LEGACY',
  'contacts.importedCountToast': 'PAIR_LEGACY',
  'contacts.importedCountToastSingular': 'PAIR_LEGACY',
  'dashboard.eventsChip': 'PAIR_LEGACY',
  'dashboard.eventsChipPlural': 'PAIR_LEGACY',
  'dashboard.urgentTasksChip': 'PAIR_LEGACY',
  'dashboard.urgentTasksChipPlural': 'PAIR_LEGACY',
  'dashboard.overdueTasksChip': 'PAIR_LEGACY',
  'dashboard.overdueTasksChipPlural': 'PAIR_LEGACY',
  'reminders.pendingBadgeTitle': 'PAIR_LEGACY',
  'reminders.pendingBadgeTitlePlural': 'PAIR_LEGACY',

  // --- `count` ist kein Zaehler ------------------------------------------
  // fmtNum() (health.js:1256) liefert einen fertig formatierten String bzw. '–'.
  // Eine Dosis „1,5×" ist kein Zaehlwert, Intl.PluralRules greift hier nicht.
  'health.meds.doseQty': 'NOT_A_COUNT',

  // --- n=1 am Aufrufer ausgeschlossen ------------------------------------
  // subscriptions.js:135 - `cycle_interval === 1 ? t(key) : t('everyCycle', …)`.
  'subscriptions.everyCycle': 'GUARDED',
  // personal-calendar.js:214 - der Wert ist die Konstante MAX_DEFAULT_REMINDERS.
  'settings.calendarDefaultRemindersMax': 'GUARDED',
  // subscriptions.js:150-154 - dueLabel() faengt d<0, d===0 und d===1 vorher ab,
  // diese Zeile sieht nur noch d >= 2.
  'subscriptions.dueInDays': 'GUARDED',

  // --- echte Luecken, eingefroren statt behoben ---------------------------
  // Alle unten sind bei n=1 grammatisch falsch und n=1 ist erreichbar.
  // Diese drei standen faelschlich unter PARENTHETICAL: die Klammer ist neutral, das
  // Substantiv davor nicht. renderFolderUploadPreview zeigt sie ab EINEM Konflikt.
  'documents.folderUpload.fileConflictsTitle': 'TODO_ONE',
  'documents.folderUpload.folderConflictsTitle': 'TODO_ONE',
  'documents.folderUpload.rejectedTitle': 'TODO_ONE',
  'dashboard.shoppingMore': 'TODO_ONE',             // dashboard.js:1485/2987/3530, Guard ist `> 0`
  'calendar.moreEvents': 'TODO_ONE',
  'calendar.searchCount': 'TODO_ONE',
  'contacts.bulkDeletedToast': 'TODO_ONE',
  'contacts.importSkippedNote': 'TODO_ONE',
  'birthdays.importSelected': 'TODO_ONE',
  'birthdays.importSubmit': 'TODO_ONE',
  'birthdays.importSuccess': 'TODO_ONE',
  'documents.bulkArchivedToast': 'TODO_ONE',
  'documents.bulkDeleteConfirm': 'TODO_ONE',
  'documents.bulkDeletedToast': 'TODO_ONE',
  'documents.bulkMovedToast': 'TODO_ONE',
  'documents.bulkRestoredToast': 'TODO_ONE',
  'documents.bulkUploadedToast': 'TODO_ONE',
  'documents.selectedFilesLabel': 'TODO_ONE',
  'budget.chartSummary': 'TODO_ONE',
  'budget.showAllCategories': 'TODO_ONE',        // Knopf erst ab 4 Kategorien (CHART_LEAD), Zahl in Klammern
  'budget.statsDonutSummary': 'TODO_ONE',
  'health.labs.analyteCount': 'TODO_ONE',
  'health.cycle.status.inDays': 'TODO_ONE',
  'health.cycle.status.overdue': 'TODO_ONE',
  'inventory.navLabelAttention': 'TODO_ONE',        // router-Badge, Guard ist `> 0`
  'tasks.navLabelOverdue': 'TODO_ONE',              // router.js:1151, Guard ist `> 0`
  'subscriptions.metaInUseWarning': 'TODO_ONE',     // umgeht den Plural im String: „Abonnement(s)"
  'settings.recipeProviderDeleteAccountConfirm': 'TODO_ONE',

  // --- tote Schluessel: in allen Locales, im Code nirgends ----------------
  // Gemessen am 06.09.2026: 0 Treffer ausserhalb von public/locales/, auch
  // nicht dynamisch zusammengesetzt. Aufraeumen: eigener Vorgang.
  'housekeeping.monthTotal': 'DEAD_KEY',
  'housekeeping.moreWorkers': 'DEAD_KEY',
  'tasks.overdueDay': 'DEAD_KEY',
  'tasks.bulkDeleteConfirm': 'DEAD_KEY',
};

test('ein zaehlender Schluessel ohne Variante steht in der Ausnahmekarte (#1010)', () => {
  const entries = flattenLocale(localeFile('de'));
  const ohneVariante = [];
  for (const [key, value] of entries) {
    if (/_(zero|one|two|few|many|other)$/.test(key)) continue;
    if (typeof value !== 'string' || !value.includes('{{count}}')) continue;
    // Nicht nur `has()`: ein `_one`, das null, eine Zahl oder ein leerer String ist,
    // faellt zur Laufzeit auf den Plural-Basisschluessel zurueck (oder laesst `t()`
    // `.replace()` auf einem Nicht-String rufen) - die Variante waere da und wirkungslos.
    const variante = entries.get(`${key}_one`);
    if (typeof variante === 'string' && variante.trim() !== '') continue;
    ohneVariante.push(key);
  }

  const neu = ohneVariante.filter((k) => !(k in PLURAL_EXCEPTIONS));
  assert.deepEqual(neu, [],
    'Neue zaehlende Schluessel ohne `_one`-Variante. Entweder eine Variante anlegen '
    + '(public/locales/*.json, alle Sprachen) oder mit begruendeter Kategorie in '
    + `PLURAL_EXCEPTIONS eintragen: ${neu.join(', ')}`);

  // Die Karte darf nicht verrotten: ein Eintrag, der keine Ausnahme mehr ist -
  // weil der Schluessel eine Variante bekam oder geloescht wurde -, muss raus.
  // Ohne diese Haelfte waechst die Karte und niemand raeumt sie je auf
  // (dasselbe Muster wie INTENTIONALLY_NOT_IN_INSTALLER).
  const veraltet = Object.keys(PLURAL_EXCEPTIONS).filter((k) => !ohneVariante.includes(k));
  assert.deepEqual(veraltet, [],
    `Ausnahmekarte veraltet - diese Schluessel brauchen keine Ausnahme mehr: ${veraltet.join(', ')}`);
});

// Die Pruefung oben misst `de.json` als Referenz. Das beantwortet die Frage, OB ein
// Schluessel eine Variante braucht - nicht, ob die vorhandene Variante ueberall etwas
// taugt: ein `_one`, das in de steht und in fr leer ist, faellt zur Laufzeit genau
// dort auf den Plural zurueck, wo niemand hinsieht, und die Schluessel-Paritaet merkt
// nichts davon. Der Bestand ist sauber (95 Varianten x 24 Locales, 0 unbrauchbar),
// also darf diese Pruefung strikt sein und braucht keine Ausnahmekarte.
test('jede _one-Variante traegt in JEDER Locale einen brauchbaren Wert (#1010)', () => {
  const referenz = flattenLocale(localeFile('de'));
  const varianten = [...referenz.keys()].filter((k) => k.endsWith('_one'));
  assert.ok(varianten.length > 50,
    `nur ${varianten.length} _one-Varianten gefunden - misst der Filter noch?`);

  const kaputt = [];
  for (const file of readdirSync(LOCALE_DIR).filter((f) => f.endsWith('.json'))) {
    const entries = flattenLocale(JSON.parse(readFileSync(new URL(file, LOCALE_DIR), 'utf8')));
    for (const key of varianten) {
      const wert = entries.get(key);
      if (wert === undefined) { kaputt.push(`${file}: ${key} fehlt`); continue; }
      if (typeof wert !== 'string' || wert.trim() === '') {
        kaputt.push(`${file}: ${key} = ${JSON.stringify(wert)}`);
      }
    }
  }
  assert.deepEqual(kaputt, [],
    `unbrauchbare Singular-Varianten (leer, null oder keine Zeichenkette): ${kaputt.join(', ')}`);
});

// ---------------------------------------------------------------------------
// `_one` ist nicht „genau eins" (#1549)
//
// CLDR `one` deckt in vielen Sprachen mehr als die 1: in ru/uk auch 21, 31,
// 101 ..., in fr/pt/hi/fa auch die 0, im Filipino sogar 2, 3, 5, 7, 8, 10 ...
// Ein `_one` mit fest geschriebener Eins ("1 событие", "Каждый месяц", "1 kaganapan")
// stand deshalb bei 21 Terminen als "1 событие" und bei 5 Terminen im Filipino
// als "1 kaganapan" in der Oberflaeche. In solchen Sprachen muss `_one` den
// `{{count}}` tragen.
//
// Ausnahme nur, wenn der AUFRUFER die Zahl so begrenzt, dass `one` dort nur noch
// die 1 trifft. Die Karte nennt den Bereich (`min`/`max` oder feste `counts`) und
// die Belegstelle; welche Sprachen er deckt, rechnet der Test selbst aus
// Intl.PluralRules nach - "fr ja, ru nein" steht nirgends von Hand.
// ---------------------------------------------------------------------------
const ONE_WITHOUT_COUNT = {
  // calendar.js periodArrowLabels/periodStepOf: 'days' ist 3 (Telefon-Woche) oder
  // 30 (Agenda); die Eins geht an calendar.prevDay/nextDay.
  'calendar.prevDays': { counts: [3, 30], where: 'public/pages/calendar.js periodStepOf' },
  'calendar.nextDays': { counts: [3, 30], where: 'public/pages/calendar.js periodStepOf' },
  // dashboard.js: count ist die Konstante EXPIRY_SOON_DAYS = 7 (utils/pantry-status.js).
  'dashboard.pantryExpiringEmpty': { counts: [7], where: 'public/utils/pantry-status.js EXPIRY_SOON_DAYS' },
  // cron-label.js formatCronSchedule: `count < 1 || count > 23` -> null.
  'settings.backupSchedulerCronHourly': { min: 1, max: 23, where: 'public/settings/cron-label.js formatCronSchedule' },
  // modules-health.js typeIntervalLabel: 0/leer -> healthPreventionOneOff, sonst >= 1.
  'settings.healthPreventionIntervalMonths': { min: 1, where: 'public/settings/pages/modules-health.js typeIntervalLabel' },
  'settings.healthPreventionIntervalYears': { min: 1, where: 'public/settings/pages/modules-health.js typeIntervalLabel' },
  // health-cycle.js: source 'history' erst ab MIN_HISTORY_GAPS Luecken, count = Perioden >= 2.
  'health.cycle.stats.source.history': { min: 2, where: 'public/utils/health-cycle.js source/count' },
  'health.cycle.stats.source.historyOther': { min: 2, where: 'public/utils/health-cycle.js source/count' },
  // server/db.js: cycle_length INTEGER NOT NULL CHECK (cycle_length BETWEEN 1 AND 366).
  'schedule.cycleDaysHint': { min: 1, max: 366, where: 'server/db.js shift_patterns.cycle_length CHECK' },
};

/** Zahlen ausser der 1, fuer die `locale` im Bereich der Ausnahme `one` waehlt. */
const oneBeyondOne = (locale, range) => {
  const rules = new Intl.PluralRules(locale);
  const counts = range?.counts
    ?? Array.from({ length: Math.min(range?.max ?? 1000, 1000) - (range?.min ?? 0) + 1 }, (_, i) => (range?.min ?? 0) + i);
  return counts.filter((n) => n !== 1 && rules.select(n) === 'one');
};

test('in Sprachen, deren one mehr als die 1 deckt, traegt _one den {{count}} (#1549)', () => {
  const de = flattenLocale(localeFile('de'));
  const counting = [...de.keys()]
    .filter((k) => k.endsWith('_one'))
    .map((k) => k.slice(0, -4))
    .filter((b) => typeof de.get(b) === 'string' && de.get(b).includes('{{count}}'));
  const betroffen = readdirSync(LOCALE_DIR).filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .filter((l) => oneBeyondOne(l).length > 0);
  // Ohne diese Probe liefe der Test gruen, wenn oneBeyondOne() nie etwas findet.
  for (const l of ['ru', 'uk', 'fr', 'pt', 'fil']) assert.ok(betroffen.includes(l), `${l} muss als betroffen erkannt werden`);
  assert.ok(!betroffen.includes('de') && !betroffen.includes('pl'), 'de und pl waehlen one nur fuer die 1');

  const falsch = [];
  const genutzt = new Set();
  for (const locale of betroffen) {
    const entries = flattenLocale(localeFile(locale));
    for (const base of counting) {
      const wert = entries.get(`${base}_one`);
      if (typeof wert !== 'string' || wert.includes('{{count}}')) continue;
      const ausnahme = ONE_WITHOUT_COUNT[base];
      const treffer = oneBeyondOne(locale, ausnahme ?? {});
      if (ausnahme && treffer.length === 0) { genutzt.add(base); continue; }
      falsch.push(`${locale}: ${base}_one = ${JSON.stringify(wert)} (one auch bei ${treffer.slice(0, 3).join(', ')})`);
    }
  }
  assert.deepEqual(falsch, [], `${falsch.length} _one-Werte ohne {{count}} in Sprachen, deren one mehr als die 1 deckt`);
  const veraltet = Object.keys(ONE_WITHOUT_COUNT).filter((k) => !genutzt.has(k));
  assert.deepEqual(veraltet, [], 'ONE_WITHOUT_COUNT: diese Ausnahmen braucht keine Sprache mehr - streichen');
});

// ---------------------------------------------------------------------------
// Platzhalter-Ersetzung
//
// Die Werte kommen aus Nutzereingaben (Namen, Titel, Notizen). Sie werden
// eingesetzt, nicht interpretiert - weder als Regex-Rückverweis noch als
// weiterer Platzhalter.
// ---------------------------------------------------------------------------

test('Werte mit Ersetzungssyntax werden wörtlich eingesetzt', async () => {
  await setLocale('de');
  // `$&` steht in einem String-Ersatz für den Treffer, `` $` `` für den Text
  // davor. Vorher wurde aus "A $& B" ein "A {{name}} B" und `` $` `` zog den
  // halben Satz in den Namen.
  assert.equal(t('birthdays.calendarEventTitle', { name: 'A $& B' }), 'Geburtstag: A $& B');
  assert.equal(t('birthdays.calendarEventTitle', { name: 'X $` Y' }), 'Geburtstag: X $` Y');
  assert.equal(t('birthdays.calendarEventTitle', { name: "Z $' W" }), "Geburtstag: Z $' W");
  assert.equal(t('birthdays.calendarEventTitle', { name: 'P $$ Q' }), 'Geburtstag: P $$ Q');
});

test('ein Wert, der wie ein Platzhalter aussieht, wird nicht erneut ersetzt', async () => {
  await setLocale('de');
  // Nacheinander ersetzt, hätte der date-Durchgang den eingesetzten Namen
  // nochmals durchsucht und das Datum zweimal geschrieben.
  assert.equal(
    t('birthdays.calendarEventDescription', { name: '{{date}}', date: '01.01.2000' }),
    'Geburtstagserinnerung für {{date}} (01.01.2000).',
  );
});

test('unbekannte Platzhalter bleiben sichtbar stehen', async () => {
  await setLocale('de');
  // Ein vergessener Parameter soll auffallen, nicht still ein Loch hinterlassen.
  assert.equal(
    t('birthdays.calendarEventDescription', { name: 'Emma' }),
    'Geburtstagserinnerung für Emma ({{date}}).',
  );
});

test('Zahlen und Pluralformen ersetzen weiterhin normal', async () => {
  await setLocale('de');
  assert.equal(t('settings.enabledReminderListCount', { count: 1 }), '1 Erinnerungsliste aktiviert');
  assert.equal(t('settings.enabledReminderListCount', { count: 7 }), '7 Erinnerungslisten aktiviert');
});

// Deliberately kept at the existing end-of-file boundary: #1055 adds its own
// plural regression after the English baseline, so this placement avoids an
// otherwise content-free merge conflict between the independent changes.
test('Notiz-Kategorieueberlauf benennt eine und mehrere weitere Kategorien', async () => {
  await setLocale('en');
  assert.equal(t('noteCategories.moreAction', { count: 1 }), '1 more category');
  assert.equal(t('noteCategories.moreAction', { count: 2 }), '2 more categories');

  await setLocale('cs');
  assert.equal(t('noteCategories.moreAction', { count: 1 }), '1 další kategorie');
  assert.equal(t('noteCategories.moreAction', { count: 3 }), '3 další kategorie');
  assert.equal(t('noteCategories.moreAction', { count: 5 }), '5 dalších kategorií');
});

test('tschechische Fastenanzeige dekliniert zusaetzliche Tage', async () => {
  await setLocale('cs');
  assert.equal(t('health.fasting.extraDays', { count: 1 }), '+1 den');
  assert.equal(t('health.fasting.extraDays', { count: 2 }), '+2 dny');
  assert.equal(t('health.fasting.extraDays', { count: 5 }), '+5 dní');
});

// ---------------------------------------------------------------------------
// Jede ganzzahlige Pluralkategorie hat ihre Variante (#1472, #1473)
//
// cs, pl, ru und uk waehlen fuer 2-4 (pl/ru/uk auch 22-24 ...) die CLDR-Kategorie
// `few`, pl/ru/uk fuer 5-20 `many`; Arabisch hat fuer 2 den Dual (`two`), fuer
// 3-10 `few` und fuer 11-99 `many`. Fehlt `key_<kategorie>`, faellt
// resolvePluralKey auf `_other` und dann auf den Basisschluessel zurueck - und
// der traegt in diesen Sprachen die Form fuer einen ANDEREN Zahlenbereich:
// "za 2 dní" statt "za 2 dny" (cs), "через 2 дн." statt "через 2 дня" (ru),
// "خلال 2 أيام" statt des Duals "خلال يومين" (ar).
//
// Gemessen wird jeder zaehlende Schluessel, der in de.json eine `_one`-Variante
// hat. Welche Kategorien eine Sprache braucht, sagt Intl.PluralRules selbst: jede
// Kategorie, die sie fuer eine ganze Zahl 0..1000 waehlt, ausser `one` (eigener
// Guard oben), `other` (das IST der Rueckfall) und `zero` (nur ar, fuer die 0;
// der Rueckfall liefert dort die Pluralform "0 أيام", die im Arabischen fuer die
// Null gebraeuchlich ist). Die Kategorien kommen aus der Laufzeit, nicht aus einer
// Liste - eine neue Sprache mit `few` ist ab ihrer ersten Datei geprueft.
//
// Die Varianten stehen NUR in den Sprachen, die sie waehlen: de.json ist die
// Rueckfall-Locale von t() und traegt nur one/other, sonst zoege eine Sprache ohne
// die Variante den deutschen Text (Paritaetsregel: test/i18n-plural-keys.js).
//
// Bis #1473 fror FEW_GAPS_LEGACY 110 Luecken ein; die Karte ist leer und
// entfernt, der Guard ist strikt.
// ---------------------------------------------------------------------------
const integerCategories = (locale) => {
  const rules = new Intl.PluralRules(locale);
  const seen = new Set();
  for (let n = 0; n <= 1000; n += 1) seen.add(rules.select(n));
  return [...seen].filter((c) => !['one', 'other', 'zero'].includes(c)).sort();
};

test('der Kategorienleser kennt die Sprachen, um die es geht', () => {
  // Ohne diese Probe liefe der Guard unten auch dann gruen, wenn integerCategories()
  // fuer jede Sprache [] liefert - er pruefte dann gar nichts.
  assert.deepEqual(integerCategories('cs'), ['few']);
  for (const locale of ['pl', 'ru', 'uk']) assert.deepEqual(integerCategories(locale), ['few', 'many'], locale);
  assert.deepEqual(integerCategories('ar'), ['few', 'many', 'two']);
  assert.deepEqual(integerCategories('de'), []);
});

test('zaehlende Schluessel tragen in jeder Sprache jede ganzzahlige Pluralkategorie (#1473)', () => {
  const files = readdirSync(LOCALE_DIR).filter((f) => f.endsWith('.json'));
  const load = (f) => flattenLocale(JSON.parse(readFileSync(new URL(f, LOCALE_DIR), 'utf8')));
  const de = load('de.json');
  const counting = [...de.keys()]
    .filter((k) => k.endsWith('_one'))
    .map((k) => k.slice(0, -4))
    .filter((b) => typeof de.get(b) === 'string' && de.get(b).includes('{{count}}'));
  assert.ok(counting.length > 100, `nur ${counting.length} zaehlende Schluessel - misst der Filter noch?`);
  const gepruefte = files.filter((f) => integerCategories(f.replace(/\.json$/, '')).length > 0);
  assert.ok(gepruefte.length >= 5, `nur ${gepruefte.join(', ')} - cs, pl, ru, uk und ar muessen dabei sein`);
  const fehlt = [];
  for (const file of gepruefte) {
    const entries = load(file);
    for (const category of integerCategories(file.replace(/\.json$/, ''))) {
      for (const base of counting) {
        const wert = entries.get(`${base}_${category}`);
        // Nicht nur `has()`: ein leerer oder nicht-String-Wert faellt zur Laufzeit
        // genauso auf den Basisschluessel zurueck wie ein fehlender.
        if (typeof wert !== 'string' || wert.trim() === '') fehlt.push(`${file}: ${base}_${category}`);
      }
    }
  }
  assert.deepEqual(fehlt, [], `${fehlt.length} Pluralvarianten fehlen oder sind leer - echte Form je Sprache anlegen`
    + ' (nur in dieser Sprache - de und die uebrigen Locales tragen sie nicht, siehe test/i18n-plural-keys.js)');
});

test('t() waehlt in cs, pl, ru, uk und ar die Form fuer 2, 5 und 11 (#1473)', async () => {
  // Stichproben durch die echte t(): der Guard oben prueft, DASS die Variante da
  // ist, diese Faelle, dass die Auswahl sie auch trifft.
  const faelle = [
    ['cs', 'dashboard.daysLeft', 2, 'Za 2 dny'],
    ['cs', 'dashboard.daysLeft', 5, 'Za 5 dní'],
    ['pl', 'dashboard.metricPoints', 2, '2 punkty'],
    ['pl', 'dashboard.metricPoints', 5, '5 punktów'],
    ['pl', 'dashboard.metricPoints', 22, '22 punkty'],
    ['ru', 'dashboard.daysLeft', 2, '2 дня'],
    ['ru', 'dashboard.daysLeft', 11, '11 дн.'],
    ['uk', 'tasks.pointsSummary', 3, '3 бали'],
    ['uk', 'tasks.pointsSummary', 12, '12 балів'],
    ['ar', 'dashboard.daysLeft', 2, 'يومان'],
    ['ar', 'dashboard.daysLeft', 5, '5 أيام'],
    ['ar', 'dashboard.daysLeft', 11, '11 يومًا'],
  ];
  for (const [locale, key, count, erwartet] of faelle) {
    await setLocale(locale);
    assert.equal(t(key, { count }), erwartet, `${locale} ${key} bei ${count}`);
  }
  await setLocale('de');
});

// Arabisch hat fuer ganze Zahlen die Kategorien zero, one, two, few, many, other:
// der Basisschluessel traegt dort die few-Form (3-10, "أيام"), die fuer 2 (Dual)
// und 11-99 ("يومًا") falsch ist. Die zwei Tageszaehler aus #1472 waren das Muster
// fuer die Nachpflege in #1473.
test('Arabisch: die Tageszaehler waehlen Dual und many statt der few-Form', async () => {
  await setLocale('ar');
  for (const key of ['birthdays.inDays', 'inventory.deadlineChipInDays']) {
    const few = t(key, { count: 5, label: 'X' });
    assert.notEqual(t(key, { count: 2, label: 'X' }).replace('2', '5'), few, `${key}: 2 braucht den Dual`);
    assert.notEqual(t(key, { count: 11, label: 'X' }).replace('11', '5'), few, `${key}: 11 braucht die many-Form`);
  }
  await setLocale('de');
});

// Vorrats-Einheiten flektieren mit der Menge (Re-Critique 2026-09-27, W2):
// „6 Dose", „3 Packung" standen im Vorrat und in der Uebersicht, weil beide
// `t('pantry.units.X')` ohne count hinter die Zahl setzten. Geprueft wird der
// geteilte Helfer MIT der echten t() UND dass beide Aufrufer ihn nehmen - ein
// Helfer, den niemand ruft, misst nichts.
test('Vorrat: die Einheit flektiert mit der Menge, auch in Bruchzahlen', async () => {
  const { pantryQuantityLabel, PANTRY_UNITS } = await import('../public/utils/pantry-units.js');
  const fmt = (locale) => (n) => new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(n);
  await setLocale('de');
  assert.equal(pantryQuantityLabel(6, 'can', { t, formatNumber: fmt('de') }), '6 Dosen');
  assert.equal(pantryQuantityLabel(1, 'can', { t, formatNumber: fmt('de') }), '1 Dose');
  assert.equal(pantryQuantityLabel(3, 'jar', { t, formatNumber: fmt('de') }), '3 Gläser');
  assert.equal(pantryQuantityLabel(1.5, 'pkg', { t, formatNumber: fmt('de') }), '1,5 Packungen');
  assert.equal(pantryQuantityLabel(250, 'g', { t, formatNumber: fmt('de') }), '250 g');
  // Der Basisschluessel bleibt der Name der Einheit (Auswahlfeld ohne Menge).
  assert.equal(t('pantry.units.can'), 'Dose');
  // Unbekannte Einheit: Rohwert statt Schluessel.
  assert.equal(pantryQuantityLabel(2, 'Kiste', { t, formatNumber: fmt('de') }), '2 Kiste');
  await setLocale('en');
  assert.equal(pantryQuantityLabel(2, 'bottle', { t, formatNumber: fmt('en') }), '2 bottles');
  await setLocale('pl');
  assert.equal(pantryQuantityLabel(2, 'can', { t, formatNumber: fmt('pl') }), '2 puszki');
  assert.equal(pantryQuantityLabel(5, 'can', { t, formatNumber: fmt('pl') }), '5 puszek');
  await setLocale('de');
  // Jede Zaehleinheit traegt in de _one und _other (Paritaet ueber test:i18n).
  // Die metrischen Symbole flektieren nicht („5 g") und brauchen keine Variante.
  const units = localeFile('de').pantry.units;
  for (const unit of PANTRY_UNITS.filter((u) => !['g', 'kg', 'ml', 'l'].includes(u))) {
    assert.ok(units[`${unit}_one`] && units[`${unit}_other`], `pantry.units.${unit}_one/_other fehlt`);
  }
});

test('Vorrat und Uebersicht setzen die Menge ueber den flektierenden Helfer', () => {
  const strip = (src) => {
    let out = src;
    for (let prev = ''; prev !== out;) { prev = out; out = out.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''); }
    return out;
  };
  const body = (src, name) => {
    const at = src.indexOf(`function ${name}(`);
    assert.ok(at >= 0, `${name} fehlt`);
    return src.slice(at, src.indexOf('\n}\n', at));
  };
  const pantry = strip(readFileSync(new URL('../public/pages/pantry.js', import.meta.url), 'utf8'));
  const dashboard = strip(readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8'));
  for (const [src, fn, file] of [[pantry, 'quantityText', 'pantry.js'], [pantry, 'shortfallText', 'pantry.js'],
    [dashboard, 'pantryQuantityText', 'dashboard.js']]) {
    const own = body(src, fn);
    assert.match(own, /pantryQuantityLabel\(/, `${file} ${fn}: Menge ohne flektierende Einheit („6 Dose")`);
    assert.doesNotMatch(own, /pantry\.units\.\$\{|unitLabel\(/, `${file} ${fn}: setzt den Singular selbst hinter die Zahl`);
  }
});
