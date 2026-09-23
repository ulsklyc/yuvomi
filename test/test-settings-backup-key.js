/**
 * Tests: Feld fuer den Schluessel eines fremden Backups im Restore-Dialog (#1267)
 * Zweck: Die Regel, wann das Feld erscheint, bleibt oder geleert wird, laeuft
 *        hier als Programm - ebenso das Markup, dessen `aria-describedby` die
 *        HTTP-Warnung erreichen muss (der Fokus springt direkt ins Feld), und
 *        die Kodierung, die der Server wieder zu denselben Bytes lesen muss.
 * Ausführen: node --loader ./test/test-browser-loader.mjs --test test/test-settings-backup-key.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const { backupKeyFieldHtml, keyFieldAfterError, keyFieldDescribedBy, encodeBackupKey } = await import('../public/settings/backup-key.js');

function describedIds(html) {
  const input = html.match(/<input[^>]*id="backup-restore-key"[^>]*>/s)?.[0];
  assert.ok(input, 'Vorbedingung: das Eingabefeld ist im Markup');
  return input.match(/aria-describedby="([^"]+)"/)?.[1]?.split(/\s+/).sort() ?? [];
}

test('ueber HTTP verweist aria-describedby auf Hinweis UND Warnung, und beide IDs stehen im Markup', () => {
  const html = backupKeyFieldHtml('http:');
  const ids = describedIds(html);
  assert.deepEqual(ids, ['backup-restore-key-hint', 'backup-restore-key-http']);
  // Gegenprobe: ein Verweis auf eine ID, die es nicht gibt, beschreibt nichts.
  for (const id of ids) assert.match(html, new RegExp(`id="${id}"`), `${id} muss im Markup existieren`);
  assert.match(html, /id="backup-restore-key-http"[^>]*>settings\.backupRestoreKeyHttpWarning</, 'die Warnung traegt ihren Text');
  assert.equal(keyFieldDescribedBy('http:'), ids.join(' '), 'dieselbe Regel setzt das Blatt beim Einblenden');
});

test('ueber HTTPS verweist aria-describedby NICHT auf die (versteckte) Warnung', () => {
  // accname liest ein per aria-describedby verknuepftes Element auch dann vor,
  // wenn es hidden ist - die Warnung kaeme sonst auf jeder HTTPS-Seite.
  assert.deepEqual(describedIds(backupKeyFieldHtml('https:')), ['backup-restore-key-hint']);
  assert.equal(keyFieldDescribedBy('https:'), 'backup-restore-key-hint');
});

test('das Feld ist ein Passwortfeld ohne Autovervollstaendigung', () => {
  const input = backupKeyFieldHtml().match(/<input[^>]*>/s)[0];
  assert.match(input, /type="password"/);
  assert.match(input, /autocomplete="off"/);
});

test('Gruende: Schluessel gefragt zeigt das Feld, bewiesener Schluessel behaelt es, der Rest leert es', () => {
  for (const reason of ['backup_key_required', 'backup_key_wrong', 'backup_key_invalid']) {
    assert.equal(keyFieldAfterError(reason), 'show', reason);
  }
  // Der Schluessel stimmte, die Datei war kaputt: nicht leeren (Review #1417).
  for (const reason of ['backup_damaged', 'backup_unreadable', 'backup_corrupt', 'restore_in_progress', 'restore_busy']) {
    assert.equal(keyFieldAfterError(reason), 'keep', reason);
  }
  for (const reason of ['own_key_missing', undefined, 'irgendwas']) {
    assert.equal(keyFieldAfterError(reason), 'reset', String(reason));
  }
});

test('jeder Grund, den der Server kennt, hat im Dialog eine Regel', () => {
  // Die Liste steht im Server; faellt dort ein neuer Grund dazu, muss er hier
  // bewusst eingeordnet werden, statt still auf „reset" zu fallen.
  const db = readFileSync(new URL('../server/db.js', import.meta.url), 'utf8');
  const route = readFileSync(new URL('../server/routes/backup.js', import.meta.url), 'utf8');
  const reasons = new Set([...`${db}\n${route}`.matchAll(/'((?:backup|own|restore)_[a-z_]+)'/g)].map((m) => m[1]));
  const known = {
    backup_key_required: 'show', backup_key_wrong: 'show', backup_key_invalid: 'show',
    backup_damaged: 'keep', backup_unreadable: 'keep', backup_corrupt: 'keep', restore_in_progress: 'keep', restore_busy: 'keep', own_key_missing: 'reset',
  };
  assert.deepEqual([...reasons].sort(), Object.keys(known).sort(), 'Gruende im Server');
  for (const [reason, action] of Object.entries(known)) assert.equal(keyFieldAfterError(reason), action, reason);
});

test('die Kodierung liefert dem Server dieselben UTF-8-Bytes zurueck', () => {
  for (const key of ['abc', ' mit Leerzeichen am Rand ', 'schlüssel-€-ü', '鍵🔑']) {
    const encoded = encodeBackupKey(key);
    assert.match(encoded, /^[A-Za-z0-9+/]+={0,2}$/, 'nur Base64-Zeichen - so prueft die Route');
    assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), key);
  }
});

// --------------------------------------------------------
// Das Formular als Programm (a11y-Audit zu #1417)
// --------------------------------------------------------
//
// `bindRestoreEvents()` laeuft hier gegen ein Formular aus Attrappen, die nur
// das koennen, was der Handler anfasst: Attribute, Listener, `hidden`,
// `disabled` und `focus()`. `focus()` folgt der Browserregel, die hier zaehlt:
// ein `disabled` Knopf und ein Feld in einer versteckten Gruppe nehmen den
// Fokus nicht an. Das Modal ist eine Attrappe mit der Reihenfolge von
// `_doClose()` in public/components/modal.js: waehrend der Rueckfrage liegt
// der Fokus im Dialog, erst nach `ms` gibt es ihn an den Ausloeser zurueck,
// und nimmt der ihn nicht an, faellt er auf `#main-content`. Mobil sind das
// bis zu 400 ms (Schliess-Animation).

const LONG_ENGLISH = "Backup file could not be decrypted with this instance's DB_ENCRYPTION_KEY. A backup carries the encryption of the instance that wrote it";

class FakeEl {
  constructor(doc, id, { parent = null } = {}) {
    this.doc = doc;
    this.id = id;
    this.parent = parent;
    this.attrs = new Map();
    this.listeners = {};
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.value = '';
  }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  removeAttribute(name) { this.attrs.delete(name); }
  hasAttribute(name) { return this.attrs.has(name); }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  async dispatch(type) {
    for (const fn of this.listeners[type] ?? []) await fn({ type, preventDefault() {} });
  }
  /** Nimmt den Fokus an oder nicht - wie der Browser, still. */
  focus() {
    const blocked = this.disabled || this.hidden || this.parent?.hidden;
    if (!blocked) this.doc.activeElement = this;
  }
}

function restoreForm({ protocol = 'https:' } = {}) {
  const doc = { activeElement: null };
  const main = new FakeEl(doc, 'main-content');
  const group = new FakeEl(doc, 'backup-restore-key-group');
  const els = {
    'backup-restore-form': new FakeEl(doc, 'backup-restore-form'),
    'backup-restore-file': new FakeEl(doc, 'backup-restore-file'),
    'backup-selected-file': new FakeEl(doc, 'backup-selected-file'),
    'backup-restore-btn': new FakeEl(doc, 'backup-restore-btn'),
    'backup-restore-error': new FakeEl(doc, 'backup-restore-error'),
    'backup-restore-key-group': group,
    'backup-restore-key': new FakeEl(doc, 'backup-restore-key', { parent: group }),
    'backup-restore-key-http': new FakeEl(doc, 'backup-restore-key-http'),
  };
  // Ausgangszustand wie im Markup von renderPage()/backupKeyFieldHtml().
  group.hidden = true;
  els['backup-restore-key-http'].hidden = true;
  els['backup-restore-error'].hidden = true;
  els['backup-restore-key'].setAttribute('aria-describedby', keyFieldDescribedBy(protocol));
  els['backup-restore-file'].files = [{ name: 'fremd.db', size: 4096 }];
  const container = {
    querySelector: (sel) => els[sel.replace(/^#/, '')] ?? null,
    contains: (node) => Object.values(els).includes(node),
  };
  globalThis.window = { location: { protocol, reload() {} }, yuvomi: { showToast() {} } };
  globalThis.document = doc;
  return {
    doc, main, container, els,
    form: els['backup-restore-form'],
    btn: els['backup-restore-btn'],
    key: els['backup-restore-key'],
    error: els['backup-restore-error'],
  };
}

/** Modal-Attrappe: bestaetigt sofort, schliesst nach `ms` und gibt dann den Fokus zurueck. */
function delayedModal(f, ms) {
  let closed;
  const done = new Promise((resolve) => { closed = resolve; });
  let calls = 0;
  globalThis.__confirmModal = async () => {
    calls += 1;
    const trigger = f.doc.activeElement;
    // Waehrend der Rueckfrage liegt der Fokus IM Dialog (auf „Bestaetigen").
    new FakeEl(f.doc, 'confirm-modal-ok').focus();
    setTimeout(() => {
      // Das Overlay geht aus dem DOM, sein Knopf mit ihm: der Fokus steht auf body.
      f.doc.activeElement = null;
      trigger?.focus();
      if (f.doc.activeElement !== trigger) f.main.focus();
      closed();
    }, ms);
    return true;
  };
  globalThis.__whenModalClosed = () => done;
  return { done, calls: () => calls };
}

function rejectAfter(ms, reason, message = LONG_ENGLISH) {
  let calls = 0;
  globalThis.__apiStub = {
    rawPost: () => {
      calls += 1;
      return new Promise((_, reject) => setTimeout(() => {
        const err = new Error(message);
        err.status = 400;
        err.data = reason ? { error: message, code: 400, reason } : { error: message, code: 400 };
        reject(err);
      }, ms));
    },
  };
  return { calls: () => calls };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const { bindRestoreEvents } = await import('../public/settings/pages/admin-backup.js');

/** Klick auf „Wiederherstellen": der Knopf hat den Fokus, dann submit. */
async function submitAndSettle(f, modal) {
  f.btn.focus();
  await Promise.all([f.form.dispatch('submit'), modal.done]);
  await tick();
}

test('Fehlertext: der Grund wird zum uebersetzten Text, nicht zur englischen Serverzeile', async () => {
  const f = restoreForm();
  bindRestoreEvents(f.container);
  const modal = delayedModal(f, 5);
  rejectAfter(1, 'backup_key_required');
  await submitAndSettle(f, modal);
  assert.equal(f.error.hidden, false, 'Vorbedingung: die Fehlerbox ist sichtbar');
  assert.equal(f.error.textContent, 'settings.backupRestoreErrorKeyRequired');
  assert.doesNotMatch(f.error.textContent, /DB_ENCRYPTION_KEY|decrypted/, 'kein englischer Rohtext');
});

test('Fehlertext: jeder bekannte Grund hat einen eigenen Key, ein unbekannter den allgemeinen', async () => {
  const { restoreErrorText } = await import('../public/settings/backup-key.js');
  // Der Stub von t() liefert den Key; mehrteilige Texte kommen als Folge von Keys.
  const expected = {
    backup_key_required: ['settings.backupRestoreErrorKeyRequired'],
    backup_key_wrong: ['settings.backupRestoreErrorKeyWrong', 'settings.backupRestoreErrorKeyRightButNotDb', 'settings.backupRestoreErrorNothingChanged'],
    backup_key_invalid: ['settings.backupRestoreErrorKeyInvalid'],
    own_key_missing: ['settings.backupRestoreErrorOwnKeyMissing', 'settings.backupRestoreErrorNeverEncrypted', 'settings.backupRestoreErrorNothingChanged'],
    backup_damaged: ['settings.backupRestoreErrorDamaged'],
    backup_unreadable: ['settings.backupRestoreErrorUnreadable'],
    backup_corrupt: ['settings.backupRestoreErrorCorrupt'],
    restore_in_progress: ['settings.backupRestoreErrorInProgress'],
    restore_busy: ['settings.backupRestoreErrorBusy'],
  };
  for (const [reason, keys] of Object.entries(expected)) {
    assert.equal(restoreErrorText({ message: LONG_ENGLISH, data: { reason } }), keys.join(' '), reason);
  }
  // Jeder Grund aus dem Server steht in der Tabelle - dieselbe Quelle wie oben.
  const db = readFileSync(new URL('../server/db.js', import.meta.url), 'utf8');
  const route = readFileSync(new URL('../server/routes/backup.js', import.meta.url), 'utf8');
  const reasons = new Set([...`${db}\n${route}`.matchAll(/'((?:backup|own|restore)_[a-z_]+)'/g)].map((m) => m[1]));
  assert.deepEqual([...reasons].sort(), Object.keys(expected).sort());
  for (const reason of ['irgendwas_neues', 'toString', '__proto__']) {
    assert.equal(restoreErrorText({ message: LONG_ENGLISH, data: { reason } }), 'settings.backupRestoreErrorGeneric', reason);
  }
  // Ohne Grund traegt nur der Text die Auskunft (etwa ein neueres Schema).
  assert.equal(restoreErrorText({ message: 'Update Yuvomi first, then restore.' }), 'Update Yuvomi first, then restore.');
  assert.equal(restoreErrorText(undefined), 'common.errorGeneric');
  // Und jeden Key gibt es in jeder Sprache.
  const locales = new URL('../public/locales/', import.meta.url);
  for (const file of readdirSync(locales).filter((name) => name.endsWith('.json'))) {
    const settings = JSON.parse(readFileSync(new URL(file, locales), 'utf8')).settings;
    for (const key of [...Object.values(expected).flat(), 'settings.backupRestoreErrorGeneric']) {
      assert.equal(typeof settings[key.replace('settings.', '')], 'string', `${file}: ${key}`);
    }
  }
});

/**
 * DIE ZWEITE MOEGLICHKEIT GEHOERT IN DEN TEXT (Review zu #1427) - dieselbe
 * Symmetrie, die `nenntSchluesselUndAlternative()` in test-db-encryption.js fuer
 * die Servertexte haelt. Ohne Klartext-Kopf ist eine Datei verschluesselt ODER
 * gar keine Datenbank, und `SQLITE_NOTADB` sagt nicht, welches von beiden. Ein
 * Text, der nur den Schluessel nennt, schickt einen Admin ohne eigenen
 * Schluessel los, einen zu setzen, den er nicht braucht.
 *
 * Strukturell fuer ALLE Sprachen: die Alternative ist ein eigener Key, den
 * `restoreErrorText()` anhaengt - oben geprueft -, und hier steht fest, dass
 * jede Sprache ihn mit Inhalt fuellt und der Haupttext den Schlusssatz nicht
 * doppelt traegt. Fuer de und en dazu der Wortlaut.
 */
test('Fehlertext: own_key_missing und backup_key_wrong nennen auch „keine Yuvomi-Datenbank"', () => {
  const locales = new URL('../public/locales/', import.meta.url);
  const files = readdirSync(locales).filter((name) => name.endsWith('.json'));
  assert.equal(files.length, 24, 'Vorbedingung: alle Sprachen gelesen');
  for (const file of files) {
    const s = JSON.parse(readFileSync(new URL(file, locales), 'utf8')).settings;
    for (const key of ['backupRestoreErrorNeverEncrypted', 'backupRestoreErrorKeyRightButNotDb', 'backupRestoreErrorNothingChanged']) {
      assert.ok(typeof s[key] === 'string' && s[key].includes('Yuvomi') !== (key === 'backupRestoreErrorNothingChanged'), `${file}: ${key}`);
    }
    for (const key of ['backupRestoreErrorOwnKeyMissing', 'backupRestoreErrorKeyWrong']) {
      assert.ok(!s[key].includes(s.backupRestoreErrorNothingChanged), `${file}: ${key} traegt den Schlusssatz selbst`);
    }
  }
  const de = JSON.parse(readFileSync(new URL('de.json', locales), 'utf8')).settings;
  assert.match(de.backupRestoreErrorNeverEncrypted, /nie verschlüsselt.*keine gültige Yuvomi-Datenbank/);
  assert.match(de.backupRestoreErrorKeyRightButNotDb, /Schlüssel richtig.*keine Yuvomi-Datenbank.*abgeschnitten/);
  const en = JSON.parse(readFileSync(new URL('en.json', locales), 'utf8')).settings;
  assert.match(en.backupRestoreErrorNeverEncrypted, /never encrypted.*not a valid Yuvomi database/);
  assert.match(en.backupRestoreErrorKeyRightButNotDb, /key is right.*not a Yuvomi database.*cut short/);
});

test('describedby: die Fehlerbox kommt dazu, Hinweis und HTTP-Warnung bleiben, und sie geht wieder', async () => {
  const f = restoreForm({ protocol: 'http:' });
  bindRestoreEvents(f.container);
  let modal = delayedModal(f, 5);
  rejectAfter(1, 'backup_key_required');
  await submitAndSettle(f, modal);
  assert.equal(f.els['backup-restore-key-group'].hidden, false, 'Vorbedingung: das Feld ist sichtbar');
  assert.deepEqual(
    f.key.getAttribute('aria-describedby').split(/\s+/).sort(),
    ['backup-restore-error', 'backup-restore-key-hint', 'backup-restore-key-http'],
  );
  // Neuer Versuch: die Box wird versteckt, der Verweis darf nicht auf ihren
  // alten Text zeigen (accname liest auch versteckte Ziele vor).
  modal = delayedModal(f, 5);
  let release;
  globalThis.__apiStub = { rawPost: () => new Promise((_, reject) => { release = reject; }) };
  f.btn.focus();
  const pending = f.form.dispatch('submit');
  await modal.done;
  await tick();
  assert.equal(f.error.hidden, true, 'Vorbedingung: die Box ist waehrend des Versuchs versteckt');
  assert.deepEqual(
    f.key.getAttribute('aria-describedby').split(/\s+/).sort(),
    ['backup-restore-key-hint', 'backup-restore-key-http'],
  );
  release(Object.assign(new Error('x'), { data: { reason: 'backup_key_required' } }));
  await pending;
});

test('aria-invalid: ein falscher Schluessel markiert das Feld, neue Eingabe nimmt es zurueck', async () => {
  const f = restoreForm();
  bindRestoreEvents(f.container);
  const modal = delayedModal(f, 5);
  rejectAfter(1, 'backup_key_wrong');
  await submitAndSettle(f, modal);
  assert.equal(f.key.getAttribute('aria-invalid'), 'true');
  f.key.value = 'neu';
  await f.key.dispatch('input');
  assert.equal(f.key.hasAttribute('aria-invalid'), false);
  // Ein Grund, der den Schluessel NICHT widerlegt, markiert ihn auch nicht.
  const g = restoreForm();
  bindRestoreEvents(g.container);
  const modal2 = delayedModal(g, 5);
  rejectAfter(1, 'backup_key_required');
  await submitAndSettle(g, modal2);
  assert.equal(g.els['backup-restore-key-group'].hidden, false, 'Vorbedingung: das Feld ist sichtbar');
  assert.equal(g.key.hasAttribute('aria-invalid'), false);
});

test('Fokus: schliesst das Modal NACH der Antwort (mobil), endet er trotzdem im Schluesselfeld', async () => {
  const f = restoreForm();
  bindRestoreEvents(f.container);
  const modal = delayedModal(f, 60);
  rejectAfter(5, 'backup_key_required');
  await submitAndSettle(f, modal);
  assert.equal(f.doc.activeElement?.id, 'backup-restore-key');
});

test('Fokus: schliesst das Modal VOR der Antwort, faellt er nicht auf main-content', async () => {
  // Ohne Feld (own_key_missing setzt zurueck) ist der Knopf das Ziel - und der
  // darf dazu waehrend des Requests nicht `disabled` sein.
  const f = restoreForm();
  bindRestoreEvents(f.container);
  const modal = delayedModal(f, 1);
  rejectAfter(30, 'own_key_missing');
  f.btn.focus();
  await Promise.all([f.form.dispatch('submit'), modal.done]);
  await tick();
  assert.equal(f.doc.activeElement?.id, 'backup-restore-btn');
});

test('Fokus: wer waehrend einer langen Anfrage weitergearbeitet hat, wird nicht zurueckgerissen', async () => {
  // Review zu #1427: der Fokus wurde bedingungslos gesetzt. Nur wo ihn das
  // Modal abgelegt hat (Knopf, #main-content, body) oder wo er ohnehin im Feld
  // steht, ist er noch „unser" - alles andere hat jemand selbst gewaehlt.
  const f = restoreForm();
  bindRestoreEvents(f.container);
  const modal = delayedModal(f, 1);
  rejectAfter(40, 'backup_key_required');
  f.btn.focus();
  const pending = f.form.dispatch('submit');
  await modal.done;
  await tick();
  const elsewhere = new FakeEl(f.doc, 'webdav-url');
  elsewhere.focus();
  await pending;
  await tick();
  assert.equal(f.els['backup-restore-key-group'].hidden, false, 'Vorbedingung: das Feld ist erschienen');
  assert.equal(f.doc.activeElement?.id, 'webdav-url');
});

test('Sperre: waehrend des Requests loest ein zweiter Klick keinen zweiten Restore aus', async () => {
  const f = restoreForm();
  bindRestoreEvents(f.container);
  const modal = delayedModal(f, 1);
  const api = rejectAfter(40, 'backup_key_required');
  f.btn.focus();
  const first = f.form.dispatch('submit');
  await modal.done;
  await tick();
  assert.equal(f.btn.getAttribute('aria-disabled'), 'true', 'die Sperre ist angesagt');
  assert.equal(f.btn.disabled, false, 'aber nicht disabled - sonst verliert der Knopf den Fokus');
  await f.form.dispatch('submit');
  await first;
  assert.equal(api.calls(), 1, 'ein Restore');
  assert.equal(modal.calls(), 1, 'keine zweite Rueckfrage');
  assert.equal(f.btn.hasAttribute('aria-disabled'), false, 'nach der Antwort wieder frei');
});
