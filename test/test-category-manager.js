/**
 * Modul: Category-Manager-Test
 * Zweck: Sichert Struktur und API-Nutzung der generischen Komponente + Budget-Verdrahtung
 * Ausführen: node --experimental-sqlite test/test-category-manager.js
 */
import { readFileSync } from 'node:fs';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}: ${err.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion fehlgeschlagen'); }

console.log('\n[Category-Manager-Test]\n');

const comp = readFileSync(new URL('../public/components/category-manager.js', import.meta.url), 'utf8');

test('Definiert das Custom Element oikos-category-manager', () => {
  assert(/customElements\.define\(\s*'oikos-category-manager'/.test(comp), 'Tag-Name muss oikos-category-manager sein');
});
test('Bietet eine configure()-Methode für Properties', () => {
  assert(/configure\s*\(/.test(comp), 'configure() muss existieren');
});
test('Lädt Kategorien relativ zu basePath via api.get', () => {
  assert(/api\.get\(\s*this\._basePath/.test(comp) || /api\.get\(`?\$\{this\._basePath\}/.test(comp), 'Muss api.get(basePath) nutzen');
});
test('Mutiert über post/put/patch/delete relativ zu basePath', () => {
  assert(/api\.post\(/.test(comp), 'POST zum Hinzufügen');
  assert(/api\.put\(/.test(comp), 'PUT zum Umbenennen');
  assert(/api\.patch\(/.test(comp), 'PATCH zum Reorder');
  assert(/api\.delete\(/.test(comp), 'DELETE zum Löschen');
});
test('Dispatcht category-manager-changed nach Mutationen', () => {
  assert(/category-manager-changed/.test(comp), 'Event muss dispatcht werden');
});
test('Räumt Listener in disconnectedCallback auf', () => {
  assert(/disconnectedCallback\s*\(\)\s*\{[\s\S]*removeEventListener/.test(comp), 'Listener-Cleanup nötig');
});
test('Nutzt kein innerHTML', () => {
  assert(!/\.innerHTML/.test(comp), 'innerHTML ist verboten');
});
test('Escaped Nutzerdaten via esc()', () => {
  assert(/import \{[^}]*esc[^}]*\} from '\/utils\/html\.js'/.test(comp), 'esc muss importiert werden');
});
test('Zeigt Server-Fehler (in-use/last) als Toast', () => {
  assert(/showToast\(\s*err\.message/.test(comp), 'Fehlermeldung des Servers muss als Toast erscheinen');
});
test('Unterstützt Subkategorien unter basePath/:key/subcategories', () => {
  assert(/subcategories/.test(comp), 'Subkategorie-Pfad muss vorkommen');
  assert(/this\._supportsSub/.test(comp), 'supportsSubcategories muss ausgewertet werden');
});

const budgetPage = readFileSync(new URL('../public/pages/budget.js', import.meta.url), 'utf8');
test('Budget importiert die generische Komponente', () => {
  assert(/components\/category-manager\.js/.test(budgetPage), 'budget.js muss die Komponente importieren');
  assert(/oikos-category-manager/.test(budgetPage), 'budget.js muss das Element verwenden');
});
test('Budget konfiguriert basePath /budget/categories und Gruppen', () => {
  assert(/configure\(/.test(budgetPage), 'configure() muss aufgerufen werden');
  assert(/\/budget\/categories/.test(budgetPage), 'basePath /budget/categories nötig');
  assert(/supportsSubcategories:\s*true/.test(budgetPage), 'Subkategorien müssen aktiviert sein');
});
test('Budget reagiert auf category-manager-changed', () => {
  assert(/category-manager-changed/.test(budgetPage), 'Listener auf category-manager-changed nötig');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
