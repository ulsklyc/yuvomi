/**
 * Test: Notizen Reader-Modus (Discussion #507)
 *
 * Deckt ab:
 *  - renderMarkdownLight erzeugt Blockstruktur (Grundlage der Leseansicht)
 *  - notes.js: Umschalter-/Pane-Markup und Reader-Default für bestehende Notizen
 *  - notes.css: Umschalter- und Leseansicht-Styles vorhanden
 *  - i18n: neue Keys in ALLEN Locales (de ist Referenz), nicht leer
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { renderMarkdownLight } from '../public/utils/html.js';

const NEW_KEYS = ['viewNote', 'modeRead', 'modeEdit', 'modeSwitchLabel', 'readEmpty'];

const notesSrc = () => readFile(new URL('../public/pages/notes.js', import.meta.url), 'utf8');
const notesCss = () => readFile(new URL('../public/styles/notes.css', import.meta.url), 'utf8');

test('renderMarkdownLight renders markdown blocks used by the reader view', () => {
  const html = renderMarkdownLight('# Titel\n\n- eins\n- zwei');
  assert.match(html, /note-md-h1/, 'heading should render');
  assert.match(html, /note-md-ul/, 'list should render');
  assert.match(html, /eins/);
  assert.equal(renderMarkdownLight(''), '', 'empty content renders nothing');
});

test('notes.js wires the read/edit toggle with both panes', async () => {
  const src = await notesSrc();
  assert.match(src, /function renderNoteReadHtml\(/, 'read-view renderer must exist');
  assert.match(src, /note-mode-switch/, 'mode switch markup must exist');
  assert.match(src, /data-pane="read"/, 'read pane must exist');
  assert.match(src, /data-pane="edit"/, 'edit pane must exist');
  assert.match(src, /notes\.modeRead/, 'read toggle label key must be used');
  assert.match(src, /notes\.modeEdit/, 'edit toggle label key must be used');
  assert.match(src, /function setView\(/, 'toggle handler must exist');
});

test('mode switch reuses the shared .sub-tab tablist grammar (consistency)', async () => {
  const src = await notesSrc();
  assert.match(src, /role="tablist"/, 'switch must be a tablist');
  assert.match(src, /class="sub-tab/, 'toggle buttons must reuse the shared .sub-tab component');
  assert.match(src, /role="tab"/, 'toggle buttons must be tabs');
  assert.match(src, /role="tabpanel"/, 'panes must be tabpanels');
  assert.match(src, /ArrowRight|ArrowLeft/, 'tablist must support arrow-key navigation');
});

test('existing notes default to the read view, new notes to the editor', async () => {
  const src = await notesSrc();
  assert.match(
    src,
    /initialView\s*=\s*isEdit\s*\?\s*'read'\s*:\s*'edit'/,
    'default view must be read for existing notes and edit for new notes',
  );
});

test('notes.css defines switch and reader styles', async () => {
  const css = await notesCss();
  assert.match(css, /\.note-mode-switch\s*\{/);
  assert.match(css, /\.note-read-view\s*\{/, 'reader surface must be styled');
  assert.match(css, /--note-color/, 'reader surface must tint with the note color');
  assert.match(css, /\.note-read__body\s*\{/);
  assert.match(css, /\.note-read__empty\s*\{/);
  assert.match(css, /prefers-reduced-motion/, 'pane transition must have a reduced-motion fallback');
});

test('all locales define the new notes reader keys (non-empty)', async () => {
  const dir = new URL('../public/locales/', import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 20, 'expected the full locale set');

  for (const file of files) {
    const json = JSON.parse(await readFile(new URL(file, dir), 'utf8'));
    const notes = json.notes ?? {};
    for (const key of NEW_KEYS) {
      assert.equal(typeof notes[key], 'string', `${file}: notes.${key} must be a string`);
      assert.ok(notes[key].trim().length > 0, `${file}: notes.${key} must not be empty`);
    }
  }
});
