/**
 * Test: Antippbare Checklisten in Notizen (Discussion #704)
 *
 * Deckt ab:
 *  - toggleChecklistLine: die eine Zeile aendert sich, der Rest bleibt zeichengetreu
 *  - die optimistische Sperre (`expect`) faengt einen veralteten Zeilenindex ab
 *  - renderMarkdownLight: Kaestchen sind ohne Opt-in Dekoration und mit Opt-in
 *    ein Bedienelement mit Quellzeilennummer
 *  - PATCH /:id/check: zwei Mitglieder haken verschiedene Zeilen ab, ohne dass
 *    einer den anderen ueberschreibt (der Grund, warum die Route existiert)
 *  - das Dashboard bekommt die interaktive Fassung ausdruecklich NICHT
 *  - i18n: die neuen Keys in allen Locales
 * Ausfuehren: node --experimental-sqlite --test test/test-notes-checklist.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { readFile, readdir } from 'node:fs/promises';
import { renderMarkdownLight } from '../public/utils/html.js';
import {
  toggleChecklistLine,
  matchChecklistLine,
  splitKeepingLineEndings,
} from '../public/utils/markdown-checklist.js';

// --------------------------------------------------------------------------
// Die geteilte Regel
// --------------------------------------------------------------------------

test('matchChecklistLine erkennt die Formen, die auch der Editor einfuegt', () => {
  assert.equal(matchChecklistLine('- [ ] Milch')?.checked, false);
  assert.equal(matchChecklistLine('- [x] Milch')?.checked, true);
  assert.equal(matchChecklistLine('- [X] Milch')?.checked, true);
  assert.equal(matchChecklistLine('  * [ ] Milch')?.checked, false);
  assert.equal(matchChecklistLine('+ [ ] Milch')?.checked, false);
  assert.equal(matchChecklistLine('- Milch'), null, 'ohne Kaestchen kein Eintrag');
  assert.equal(matchChecklistLine('Text [ ] mitten drin'), null);
  assert.equal(matchChecklistLine(''), null);
});

test('matchChecklistLine liefert den Eintragstext ohne Kaestchen', () => {
  assert.equal(matchChecklistLine('- [ ] **Milch** kaufen').text, '**Milch** kaufen');
});

test('toggleChecklistLine aendert genau eine Zeile', () => {
  const before = '# Einkauf\n\n- [ ] Milch\n- [ ] Brot\n- [x] Butter';
  const r = toggleChecklistLine(before, 2, true);
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.equal(r.content, '# Einkauf\n\n- [x] Milch\n- [ ] Brot\n- [x] Butter');
});

test('toggleChecklistLine loest einen Haken wieder', () => {
  const r = toggleChecklistLine('- [x] Milch', 0, false);
  assert.equal(r.content, '- [ ] Milch');
});

test('toggleChecklistLine laesst Zeilenenden und Einzug unangetastet', () => {
  // Eine Notiz aus einem Windows-Client: CRLF ueberall. Ein naives
  // split('\n')/join('\n') schriebe jede Zeile um, nicht nur die angehakte.
  const before = '- [ ] eins\r\n  * [ ] zwei\r\n- [ ] drei';
  const r = toggleChecklistLine(before, 1, true);
  assert.equal(r.content, '- [ ] eins\r\n  * [x] zwei\r\n- [ ] drei');
  assert.equal(before.length, r.content.length, 'nur ein Zeichen tauscht');
});

test('toggleChecklistLine: derselbe Zustand ist kein Fehler, aber auch kein Schreibvorgang', () => {
  const r = toggleChecklistLine('- [x] Milch', 0, true);
  assert.equal(r.ok, true);
  assert.equal(r.changed, false, 'zwei Leute, die sich einig sind, sollen sich nicht stoeren');
});

test('toggleChecklistLine weist Zeilen ab, die kein Kaestchen tragen', () => {
  const r = toggleChecklistLine('# Einkauf\n- [ ] Milch', 0, true);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_a_checklist_line');
});

test('toggleChecklistLine weist Indizes ausserhalb des Textes ab', () => {
  assert.equal(toggleChecklistLine('- [ ] Milch', 9, true).reason, 'out_of_range');
  assert.equal(toggleChecklistLine('- [ ] Milch', -1, true).reason, 'out_of_range');
  assert.equal(toggleChecklistLine('- [ ] Milch', 1.5, true).reason, 'out_of_range');
});

test('expect faengt den verschobenen Index ab', () => {
  // Jemand hat oben eine Zeile eingefuegt, waehrend die Ansicht offen war:
  // Index 0 zeigt jetzt auf "Eier", nicht mehr auf "Milch".
  const now = '- [ ] Eier\n- [ ] Milch';
  const r = toggleChecklistLine(now, 0, true, '- [ ] Milch');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'stale', 'lieber ein Konflikt als ein Haken in der falschen Zeile');
});

test('expect laesst den unveraenderten Fall durch', () => {
  const r = toggleChecklistLine('- [ ] Milch\n- [ ] Brot', 1, true, '- [ ] Brot');
  assert.equal(r.ok, true);
  assert.equal(r.content, '- [ ] Milch\n- [x] Brot');
});

test('splitKeepingLineEndings ist verlustfrei', () => {
  for (const text of ['a\nb', 'a\r\nb\rc', '', 'nur eine Zeile', 'ende\n']) {
    assert.equal(splitKeepingLineEndings(text).join(''), text);
  }
});

// --------------------------------------------------------------------------
// Renderer: Zeilennummer und Bedienelement nur auf Opt-in
// --------------------------------------------------------------------------

test('ohne Opt-in bleibt das Kaestchen Dekoration (unveraendertes Verhalten)', () => {
  const html = renderMarkdownLight('- [ ] Milch');
  assert.match(html, /<span class="note-md-box" aria-hidden="true">/);
  assert.doesNotMatch(html, /data-md-line/, 'ohne Ruecksschreibweg keine Zeilennummer');
  assert.doesNotMatch(html, /<button/);
});

test('mit Opt-in wird das Kaestchen ein Bedienelement mit Quellzeilennummer', () => {
  const html = renderMarkdownLight('# Einkauf\n\n- [ ] Milch\n- [x] Brot', {
    checklist: { interactive: true, toggleLabel: 'Eintrag abhaken' },
  });
  assert.match(html, /<button type="button" class="note-md-box" role="checkbox"/);
  assert.match(html, /aria-checked="false" data-md-line="2"/, 'Milch steht auf Quellzeile 2');
  assert.match(html, /aria-checked="true" data-md-line="3"/,  'Brot steht auf Quellzeile 3');
});

test('die Zeilennummer zaehlt Quellzeilen, nicht Eintraege', () => {
  const html = renderMarkdownLight('\n\n\n- [ ] spaet', { checklist: { interactive: true } });
  assert.match(html, /data-md-line="3"/, 'drei Leerzeilen zaehlen mit');
});

test('CRLF verschiebt die Zeilennummer nicht', () => {
  const text = '- [ ] eins\r\n- [ ] zwei';
  const html = renderMarkdownLight(text, { checklist: { interactive: true } });
  assert.match(html, /data-md-line="1"[^>]*aria-label="zwei"/);
  // Und der Server findet unter derselben Nummer dieselbe Zeile.
  assert.equal(toggleChecklistLine(text, 1, true).content, '- [ ] eins\r\n- [x] zwei');
});

test('das Kaestchen traegt den Eintragstext als Namen, ohne Markdown-Marker', () => {
  const html = renderMarkdownLight('- [ ] **Milch** und [Brot](https://example.com)', {
    checklist: { interactive: true },
  });
  assert.match(html, /aria-label="Milch und Brot"/);
  // Der Eintragstext selbst bleibt formatiert - nur der Name ist Klartext.
  assert.match(html, /<strong>Milch<\/strong>/);
});

test('ein Link im Eintrag landet NICHT im Bedienelement', () => {
  // <a> in <button> waere ungueltiges HTML; deshalb umschliesst das Kaestchen
  // den Text nicht, sondern benennt ihn.
  const html = renderMarkdownLight('- [ ] [Rezept](https://example.com) kaufen', {
    checklist: { interactive: true },
  });
  assert.doesNotMatch(html, /<button[^>]*>[^<]*<a /, 'kein Anker im Button');
  assert.match(html, /<\/button><span>.*<a class="note-md-link"/);
});

test('der Renderer maskiert auch im interaktiven Modus', () => {
  const html = renderMarkdownLight('- [ ] <img src=x onerror=alert(1)>', {
    checklist: { interactive: true },
  });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

// --------------------------------------------------------------------------
// Die Aufrufer: wer darf zurueckschreiben?
// --------------------------------------------------------------------------

test('das Dashboard rendert Notizen NICHT interaktiv', async () => {
  const src = await readFile(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
  const call = src.match(/renderMarkdownLight\([^)]*\)/g) ?? [];
  assert.ok(call.length > 0, 'das Dashboard rendert Notizen');
  for (const c of call) {
    assert.doesNotMatch(c, /checklist|interactive/,
      'das Dashboard zeigt einen gekuerzten Auszug - seine Zeilennummern sind nicht die der Notiz');
  }
});

/* DIESER GUARD STAND FRUEHER ANDERSHERUM.
 *
 * Er hielt fest, dass die Aufgaben ihre Beschreibung NICHT interaktiv rendern -
 * und die Begruendung war "sie haben keinen zeilengenauen Rueckschreibweg".
 * Das war eine Aussage ueber den STAND, nicht ueber die Absicht: mit #917 haben
 * sie einen (PATCH /tasks/:id/check, dieselbe Regel aus markdown-checklist.js).
 * Die Bedingung, die wirklich gilt, ist eine andere und steht unveraendert im
 * Renderer: interaktiv darf nur, wer den VOLLSTAENDIGEN Text zeigt. Genau die
 * prueft der Guard jetzt - das Dashboard darueber faellt weiterhin darunter.
 *
 * Die eigenen Faelle der Aufgaben liegen in test-tasks-checklist.js. */
test('die Aufgaben rendern ihre Notiz interaktiv - sie zeigen den ganzen Text', async () => {
  // Die Leseansicht wohnt seit #918 in der geteilten Komponente. Die Bedingung
  // bleibt dieselbe - sie zeigt den vollstaendigen Text und kennt die Id -,
  // und sie gilt jetzt auch dort, wo die Uebersicht die Aufgabe oeffnet.
  const src = await readFile(new URL('../public/components/task-detail.js', import.meta.url), 'utf8');
  // DER GANZE RUMPF, NICHT DER AUFRUF-AUSSCHNITT. Hier stand
  // `/renderMarkdownLight\([^)]*\)/`, und `[^)]*` bricht an der ersten
  // schliessenden Klammer ab: seit die Optionen ein `t('...')` enthalten
  // (#467), endete der Ausschnitt vor `interactive` und der Guard meldete eine
  // richtige Aenderung als Fehler (PR #1252). Ein Ausdruck, der an der
  // Formatierung seines Prueflings haengt, misst frueher oder spaeter etwas
  // anderes als gemeint.
  const fn = src.slice(src.indexOf('function descriptionNode('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /renderMarkdownLight\(/, 'die Aufgaben rendern ihre Beschreibung');
  assert.match(body, /interactive:\s*true/,
    'die Detailansicht kennt die Aufgaben-Id und zeigt den vollen Text - sie darf');
  // SIE DARF, WENN SIE AUCH ZURUECKSCHREIBEN DARF. Bei `tasks: read` wird aus
  // dem Kaestchen ein Zustandszeichen: `PATCH /tasks/:id/check` verlangt
  // Schreibrecht, und ein Haken, der optimistisch umspringt und nach dem 403
  // zurueckfaellt, ist die schlechtere Auskunft als gar kein Bedienelement.
  assert.match(body, /isNavModuleReadOnly\('tasks'\)/,
    'die Freischaltung haengt am Modulrecht');
  assert.match(body, /stateLabels/,
    'und ohne das Recht traegt das Kaestchen den Zustand, statt zu verschwinden');
});

test('die Notizenseite schaltet die Kaestchen frei und faengt den Klick ab', async () => {
  const src = await readFile(new URL('../public/pages/notes.js', import.meta.url), 'utf8');
  assert.match(src, /interactive:\s*true/, 'die Notizen schalten die Kaestchen frei');
  assert.match(src, /notes\/\$\{noteId\}\/check/, 'sie schreiben ueber die schmale Route zurueck');
  assert.match(src, /note-md-box\[data-md-line\]/, 'ein Klick auf das Kaestchen wird erkannt');
  assert.match(src, /e\.stopPropagation\(\);\s*\n\s*const owner/,
    'ein Haken auf der Karte darf die Notiz nicht oeffnen');
});

test('der Lesemodus ist nur am gespeicherten Stand bedienbar', async () => {
  const src = await readFile(new URL('../public/pages/notes.js', import.meta.url), 'utf8');
  assert.match(
    src,
    /live:\s*isEdit\s*&&\s*viewContent\.value\s*===\s*note\.content/,
    'ungespeicherte Aenderungen zaehlen andere Zeilen als der Server kennt',
  );
});

test('typography.css macht das Bedienelement bedienbar', async () => {
  const css = await readFile(new URL('../public/styles/typography.css', import.meta.url), 'utf8');
  assert.match(css, /button\.note-md-box\s*\{/, 'die Button-Vorgaben muessen getilgt sein');
  assert.match(css, /button\.note-md-box:focus-visible/, 'Tastaturfokus muss sichtbar sein');
  assert.match(css, /button\.note-md-box::before/, 'die Trefferflaeche muss ueber 1em hinausgehen');
});

// --------------------------------------------------------------------------
// Die Route
// --------------------------------------------------------------------------

const dbmod = await import('../server/db.js');
const { default: notesRouter } = await import('../server/routes/notes.js');
const database = dbmod.get();

const U = database
  .prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('u','Uli','x','member')")
  .run().lastInsertRowid;

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = U;
  req.session = { userId: U, role: 'member' };
  next();
});
app.use('/', notesRouter);
const server  = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* 204 */ }
  return { status: res.status, body: json };
}

const newNote = async (content) => (await call('POST', '/', { content })).body.data;

test('PATCH /:id/check setzt genau einen Haken', async () => {
  const note = await newNote('- [ ] Milch\n- [ ] Brot');
  const r = await call('PATCH', `/${note.id}/check`, { line: 0, checked: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.content, '- [x] Milch\n- [ ] Brot');
});

test('PATCH /:id/check nimmt ihn wieder zurueck', async () => {
  const note = await newNote('- [x] Milch');
  const r = await call('PATCH', `/${note.id}/check`, { line: 0, checked: false });
  assert.equal(r.body.data.content, '- [ ] Milch');
});

test('zwei Mitglieder haken verschiedene Zeilen ab - beide Haken bleiben', async () => {
  // Der eigentliche Grund fuer diese Route. Ueber PUT (ganzer content) haette
  // der zweite Schreiber den ersten Haken still verworfen.
  const note = await newNote('- [ ] Milch\n- [ ] Brot\n- [ ] Butter');
  const [a, b] = await Promise.all([
    call('PATCH', `/${note.id}/check`, { line: 0, checked: true, expect: '- [ ] Milch' }),
    call('PATCH', `/${note.id}/check`, { line: 2, checked: true, expect: '- [ ] Butter' }),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const after = (await call('GET', '/')).body.data.find((n) => n.id === note.id);
  assert.equal(after.content, '- [x] Milch\n- [ ] Brot\n- [x] Butter');
});

test('PATCH /:id/check: veraltete Zeile → 409 statt falschem Haken', async () => {
  const note = await newNote('- [ ] Milch');
  await call('PUT', `/${note.id}`, { content: '- [ ] Eier\n- [ ] Milch' });
  const r = await call('PATCH', `/${note.id}/check`, { line: 0, checked: true, expect: '- [ ] Milch' });
  assert.equal(r.status, 409);
  assert.equal(r.body.reason, 'stale');
  const after = (await call('GET', '/')).body.data.find((n) => n.id === note.id);
  assert.equal(after.content, '- [ ] Eier\n- [ ] Milch', 'nichts wurde angehakt');
});

test('PATCH /:id/check: Zeile ohne Kaestchen → 409', async () => {
  const note = await newNote('# Einkauf\n- [ ] Milch');
  const r = await call('PATCH', `/${note.id}/check`, { line: 0, checked: true });
  assert.equal(r.status, 409);
  assert.equal(r.body.reason, 'not_a_checklist_line');
});

test('PATCH /:id/check: Zeile hinter dem Textende → 409', async () => {
  const note = await newNote('- [ ] Milch');
  const r = await call('PATCH', `/${note.id}/check`, { line: 42, checked: true });
  assert.equal(r.status, 409);
  assert.equal(r.body.reason, 'out_of_range');
});

test('PATCH /:id/check: fehlende oder falsch getypte Angaben → 400', async () => {
  const note = await newNote('- [ ] Milch');
  assert.equal((await call('PATCH', `/${note.id}/check`, { checked: true })).status, 400);
  assert.equal((await call('PATCH', `/${note.id}/check`, { line: '0', checked: true })).status, 400);
  assert.equal((await call('PATCH', `/${note.id}/check`, { line: 0 })).status, 400);
  assert.equal((await call('PATCH', `/${note.id}/check`, { line: 0, checked: 'ja' })).status, 400);
  assert.equal((await call('PATCH', `/${note.id}/check`, { line: 0, checked: true, expect: 7 })).status, 400);
});

test('PATCH /:id/check auf eine unbekannte Notiz → 404', async () => {
  const r = await call('PATCH', '/999999/check', { line: 0, checked: true });
  assert.equal(r.status, 404);
});

test('ein folgenloser Tap sortiert die Pinnwand nicht um', async () => {
  const note = await newNote('- [x] Milch');
  const before = (await call('GET', '/')).body.data.find((n) => n.id === note.id).updated_at;
  const r = await call('PATCH', `/${note.id}/check`, { line: 0, checked: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.updated_at, before, 'kein Schreibvorgang, kein neues updated_at');
});

// --------------------------------------------------------------------------
// i18n
// --------------------------------------------------------------------------

test('die neuen Keys stehen in allen Locales und sind uebersetzt', async () => {
  const dir   = new URL('../public/locales/', import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 20, 'alle Locales werden geprueft');

  const de = JSON.parse(await readFile(new URL('de.json', dir), 'utf8'));
  for (const key of ['checklistToggle', 'checkConflict']) {
    for (const f of files) {
      const d = JSON.parse(await readFile(new URL(f, dir), 'utf8'));
      const value = d.notes?.[key];
      assert.equal(typeof value, 'string', `${f}: notes.${key} fehlt`);
      assert.ok(value.trim().length > 0, `${f}: notes.${key} ist leer`);
      assert.doesNotMatch(value, /\[de:/, `${f}: notes.${key} traegt einen Platzhalter`);
      if (f !== 'de.json') {
        assert.notEqual(value, de.notes[key], `${f}: notes.${key} ist unuebersetztes Deutsch`);
      }
    }
  }
});

test.after(() => server.close());
