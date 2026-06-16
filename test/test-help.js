/**
 * Tests: Help overlay row builder (public/utils/help.js)
 * Fokus: Desktop liefert Tastenkürzel-Zeilen, Touch/Mobile liefert
 *        Klartext-Zeilen mit Icons. Pure Funktion, kein DOM.
 * Ausführen: node test/test-help.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildHelpRows } = await import('../public/utils/help.js');

// Minimaler t-Stub: gibt den Key zurück (Vollständigkeit über Key-Präsenz prüfbar)
const t = (key) => key;
const shortcuts = [
  { key: '/', description: () => 'shortcuts.search' },
  { key: '?', description: () => 'shortcuts.help' },
];

test('Desktop (coarsePointer:false) liefert Tastenkürzel-Zeilen', () => {
  const rows = buildHelpRows({ coarsePointer: false, shortcuts, t });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { key: '/', desc: 'shortcuts.search' });
  assert.equal(rows[1].key, '?');
  assert.ok(rows.every((r) => 'key' in r && !('icon' in r)));
});

test('Touch (coarsePointer:true) liefert Klartext-Zeilen mit Icons', () => {
  const rows = buildHelpRows({ coarsePointer: true, shortcuts, t });
  assert.ok(rows.length >= 4);
  assert.ok(rows.every((r) => 'icon' in r && 'desc' in r && !('key' in r)));
  // Die Mobile-Zeilen ziehen ihre Texte aus help.*-Keys
  assert.deepEqual(
    rows.map((r) => r.desc),
    ['help.mobileNavigate', 'help.mobileCreate', 'help.mobileSearch', 'help.mobileSettings']
  );
});

test('Touch-Zeilen verwenden vorhandene Lucide-Iconnamen', () => {
  const rows = buildHelpRows({ coarsePointer: true, shortcuts, t });
  assert.deepEqual(
    rows.map((r) => r.icon),
    ['navigation', 'plus-circle', 'search', 'settings']
  );
});
