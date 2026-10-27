/**
 * Test: Sichtbarkeit und Sperre in der Pinnwand (#1514, #1602)
 * Zweck: Eine gesperrte fremde Notiz zeigt keine Schreibwege - auch das
 *        Kaestchen der Checkliste ist dann Zeichen statt Knopf, denn die
 *        Sperre gilt ganz. Der Editor bietet Sichtbarkeit nur der Autorin,
 *        die Sperre Autorin und Admins. Die Karte nennt beides leise.
 * Ausführen: npm run test:notes-access-ui
 */
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };
const { installMiniDom } = await import('./mini-dom.js');
const cleanup = installMiniDom();
test.after(() => cleanup?.());

const { setPermissions, clearPermissions } = await import('../public/permissions.js');
const { renderMarkdownLight } = await import('../public/utils/html.js');
const { __test: notes } = await import('../public/pages/notes.js');

const AUTHOR = 7;
const OTHER = 8;
const note = (over = {}) => ({
  id: 3, title: 'Einkauf', content: '- [x] Milch\n- [ ] Brot', color: '#EFE3BE', pinned: 0,
  created_by: AUTHOR, creator_name: 'Ada', categories: [], visibility: 'all', locked: 0, ...over,
});

function as(userId, role, fn) {
  setPermissions({ admin: role === 'admin', modules: { notes: 'write' }, widgets: {}, capabilities: {} });
  const before = notes.state.user;
  notes.state.user = { id: userId, role };
  const md = globalThis.__renderMarkdownLight;
  globalThis.__renderMarkdownLight = renderMarkdownLight;
  try { return fn(); } finally {
    notes.state.user = before;
    if (md === undefined) delete globalThis.__renderMarkdownLight; else globalThis.__renderMarkdownLight = md;
    clearPermissions();
  }
}

test('locked foreign note: no pin, no delete, the checkbox is a sign', () => {
  as(OTHER, 'member', () => {
    const html = notes.renderNoteCard(note({ locked: 1 }));
    assert.doesNotMatch(html, /data-action="pin"/);
    assert.doesNotMatch(html, /data-action="delete"/);
    assert.doesNotMatch(html, /role="checkbox"/, 'kein antippbares Kaestchen');
    assert.match(html, /<span class="note-md-box" role="img"/);
    assert.match(html, /note-card__mark" role="img" aria-label="notes\.lockedBadge"/);
  });
});

test('locked note: author and admins keep every way to change it', () => {
  for (const [id, role] of [[AUTHOR, 'member'], [OTHER, 'admin']]) {
    as(id, role, () => {
      const html = notes.renderNoteCard(note({ locked: 1 }));
      assert.match(html, /data-action="pin"/, role);
      assert.match(html, /data-action="delete"/, role);
      assert.match(html, /class="note-md-box" role="checkbox"/, role);
    });
  }
});

test('unlocked foreign note: ticking stays open as before', () => {
  as(OTHER, 'member', () => {
    assert.match(notes.renderNoteCard(note()), /class="note-md-box" role="checkbox"/);
    assert.doesNotMatch(notes.renderNoteCard(note()), /note-card__mark/);
  });
});

test('private note carries its mark for the author', () => {
  as(AUTHOR, 'member', () => {
    assert.match(notes.renderAccessMarks(note({ visibility: 'private' })), /data-lucide="eye-off"/);
    assert.match(notes.renderAccessMarks(note({ visibility: 'private' })), /aria-label="common\.visibility\.private"/);
  });
});

test('editor: visibility for the author only, the lock for author and admins', () => {
  as(AUTHOR, 'member', () => {
    const html = notes.renderAccessFields(note({ visibility: 'private', locked: 1 }));
    assert.match(html, /id="note-visibility"/);
    assert.match(html, /<option value="private" selected>/);
    assert.match(html, /id="note-locked"/);
  });
  as(OTHER, 'admin', () => {
    const html = notes.renderAccessFields(note());
    assert.doesNotMatch(html, /id="note-visibility"/);
    assert.match(html, /id="note-locked"/);
  });
  as(OTHER, 'member', () => assert.equal(notes.renderAccessFields(note()), ''));
  as(OTHER, 'member', () => assert.match(notes.renderAccessFields(null), /id="note-visibility"[\s\S]*id="note-locked"/, 'neue Notiz'));
});
