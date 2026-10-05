/**
 * Test: Geteilte Markdown-Formatierungsleiste (Discussion #731)
 *
 * Deckt ab:
 *  - applyFormat: jede Aktion fuegt ein, was renderMarkdownLight auch liest
 *  - kein Platzhaltertext mehr fest im Quelltext (er landet IM Text des Nutzers)
 *  - beide Aufrufer benutzen dieselbe Datei, keiner baut eine zweite Leiste
 *  - die Leiste ist eine geteilte Komponente: eigenes CSS, global eingebunden
 *  - i18n: die `markdown.*`-Sektion in allen Locales, `notes.format*` ist weg
 * Ausfuehren: node --loader ./test/test-browser-loader.mjs --test test/test-markdown-toolbar.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { renderMarkdownLight } from '../public/utils/html.js';

const read = (rel) => readFile(new URL(`../${rel}`, import.meta.url), 'utf8');

// --------------------------------------------------------------------------
// applyFormat gegen ein minimales Textarea-Doppel
//
// Kein DOM in dieser Suite (npm test laeuft ohne Browser), aber setRangeText
// und die Selektionsfelder sind vollstaendig beschreibbar - genau die
// Oberflaeche, die applyFormat benutzt.
// --------------------------------------------------------------------------

function fakeTextarea(value, selectionStart = value.length, selectionEnd = selectionStart) {
  return {
    value, selectionStart, selectionEnd,
    setRangeText(replacement, start, end) {
      this.value = this.value.slice(0, start) + replacement + this.value.slice(end);
      this.selectionStart = this.selectionEnd = start + replacement.length;
    },
  };
}

// Ueber den Browser-Loader: er loest die browser-absoluten Pfade auf und
// stubt `t(key)` auf den Schluessel selbst. Fuer die Platzhalter ist das genau
// die richtige Probe - sichtbar wird, DASS einer benutzt wird.
const de = JSON.parse(await read('public/locales/de.json'));
const { applyFormat } = await import('/utils/markdown-toolbar.js');

const apply = (text, format, start, end) => {
  const ta = fakeTextarea(text, start ?? text.length, end ?? start ?? text.length);
  applyFormat(ta, format);
  return ta.value;
};

test('die Umschliess-Formate setzen ihre Marker um die Auswahl', () => {
  assert.equal(apply('Milch kaufen', 'bold', 0, 5), '**Milch** kaufen');
  assert.equal(apply('Milch kaufen', 'italic', 0, 5), '*Milch* kaufen');
  assert.equal(apply('Milch kaufen', 'underline', 0, 5), '<u>Milch</u> kaufen');
  assert.equal(apply('Milch kaufen', 'strikethrough', 0, 5), '~~Milch~~ kaufen');
  assert.equal(apply('Milch kaufen', 'code', 0, 5), '`Milch` kaufen');
});

test('die Zeilen-Formate praefixen die leere Zeile ohne fuehrenden Umbruch', () => {
  assert.equal(apply('', 'list'), '- ');
  assert.equal(apply('', 'ordered-list'), '1. ');
  assert.equal(apply('', 'checklist'), '- [ ] ');
  assert.equal(apply('', 'quote'), '> ');
});

test('auf einer beschriebenen Zeile beginnt der Eintrag auf einer neuen', () => {
  assert.equal(apply('Einkauf', 'checklist'), 'Einkauf\n- [ ] ');
  assert.equal(apply('Einkauf', 'list'), 'Einkauf\n- ');
});

test('eine mehrzeilige Auswahl wird zeilenweise praefixiert', () => {
  const text = 'Milch\nBrot\nButter';
  assert.equal(apply(text, 'checklist', 0, text.length), '- [ ] Milch\n- [ ] Brot\n- [ ] Butter');
  assert.equal(apply(text, 'list', 0, text.length), '- Milch\n- Brot\n- Butter');
  assert.equal(apply(text, 'quote', 0, text.length), '> Milch\n> Brot\n> Butter');
});

test('ein schon gesetztes Praefix wird nicht verdoppelt', () => {
  const text = '- [ ] Milch\nBrot';
  assert.equal(apply(text, 'checklist', 0, text.length), '- [ ] Milch\n- [ ] Brot');
});

test('die nummerierte Liste zaehlt neu statt zu praefixen', () => {
  const text = '3. Milch\n7. Brot';
  assert.equal(apply(text, 'ordered-list', 0, text.length), '1. Milch\n2. Brot');
});

test('die Ueberschrift geht eine Stufe tiefer und nach ### wieder zurueck', () => {
  assert.equal(apply('Titel', 'heading', 5), '## Titel');
  assert.equal(apply('## Titel', 'heading', 8), '### Titel');
  assert.equal(apply('### Titel', 'heading', 9), 'Titel');
});

test('der Trenner steht in eigenen Absaetzen', () => {
  assert.equal(apply('Text', 'divider'), 'Text\n\n---\n\n');
});

test('was die Leiste einfuegt, liest der Renderer auch', () => {
  // Die Parität, auf der die Leiste steht: kein Knopf erzeugt Text, den die
  // Leseansicht danach als Fliesstext zeigt.
  const cases = [
    ['checklist', /note-md-check/],
    ['list',      /note-md-ul/],
    ['ordered-list', /note-md-ol/],
    ['quote',     /note-md-quote/],
    ['divider',   /note-md-hr/],
    ['heading',   /note-md-h2/],
  ];
  for (const [format, expected] of cases) {
    const written = apply(format === 'heading' ? 'Titel' : '', format, format === 'heading' ? 5 : 0);
    const text = format === 'divider' ? written : `${written}Eintrag`;
    assert.match(renderMarkdownLight(text), expected, `${format} muss gerendert werden`);
  }
});

test('bold/italic/code werden im Renderer wieder zu Markup', () => {
  assert.match(renderMarkdownLight(apply('Milch', 'bold', 0, 5)), /<strong>Milch<\/strong>/);
  assert.match(renderMarkdownLight(apply('Milch', 'italic', 0, 5)), /<em>Milch<\/em>/);
  assert.match(renderMarkdownLight(apply('Milch', 'code', 0, 5)), /<code[^>]*>Milch<\/code>/);
});

test('der Link ist ein Link, den der Renderer als sicher durchlaesst', () => {
  const written = apply('Rezept', 'link', 0, 6);
  assert.match(written, /^\[Rezept\]\(.+\)$/);
  const withUrl = written.replace(/\((.+)\)$/, '(https://example.com)');
  assert.match(renderMarkdownLight(withUrl), /<a class="note-md-link" href="https:\/\/example.com"/);
});

// --------------------------------------------------------------------------
// Kein Oberflaechentext fest im Quelltext
// --------------------------------------------------------------------------

test('die Platzhalter kommen aus der Uebersetzung, nicht aus dem Quelltext', async () => {
  const src = await read('public/utils/markdown-toolbar.js');
  // Sie landen IM Text des Nutzers, sind also Oberflaeche wie jede andere.
  for (const literal of ["'Text'", "'Code'", "'Linktext'", "'url'"]) {
    assert.ok(!src.includes(`|| ${literal}`), `Platzhalter ${literal} steht noch fest im Quelltext`);
  }
  for (const key of ['placeholderText', 'placeholderCode', 'placeholderLinkText', 'placeholderUrl']) {
    assert.match(src, new RegExp(`markdown\\.${key}`), `markdown.${key} muss benutzt werden`);
  }
});

// --------------------------------------------------------------------------
// Eine Leiste, zwei Aufrufer
// --------------------------------------------------------------------------

test('Notizen und Aufgaben ziehen dieselbe Leiste aus derselben Datei', async () => {
  for (const page of ['public/pages/notes.js', 'public/pages/tasks.js']) {
    const src = await read(page);
    assert.match(src, /from '\/utils\/markdown-toolbar\.js'/, `${page} muss die geteilte Leiste importieren`);
    assert.match(src, /renderMarkdownToolbar\(\)/, `${page} muss sie rendern`);
    assert.match(src, /wireMarkdownToolbar\(/, `${page} muss sie verdrahten`);
    assert.ok(!/function applyFormat\s*\(/.test(src), `${page} darf keine eigene Fassung halten`);
  }
});

test('die Aufgaben-Notiz traegt die Leiste ueber ihrem Textfeld', async () => {
  const src = await read('public/pages/tasks.js');
  const i = src.indexOf('${renderMarkdownToolbar()}');
  assert.ok(i > 0, 'die Leiste muss im Markup stehen');
  const after = src.slice(i, i + 400);
  assert.match(after, /id="task-description"/, 'sie gehoert direkt ueber das Notizfeld');
});

test('die Leiste ist eine geteilte Komponente mit eigenem, global geladenem CSS', async () => {
  const css = await read('public/styles/markdown-toolbar.css');
  assert.match(css, /\.md-toolbar\s*\{/);
  assert.match(css, /\.md-toolbar__btn\s*\{/);
  assert.match(css, /\.md-toolbar__sep\s*\{/);
  // Beide Textfeld-Klassen: Notizen tragen .form-input, Aufgaben .input.
  // Nur solange die Leiste steht: verborgen (R16) behaelt das Feld seine Ecken.
  assert.match(css, /\.md-toolbar:not\(\[hidden\]\) \+ \.form-input/);
  assert.match(css, /\.md-toolbar:not\(\[hidden\]\) \+ \.input/);

  const html = await read('public/index.html');
  assert.match(html, /href="\/styles\/markdown-toolbar\.css"/, 'sie gehoert nicht zu einer Seite');

  const notesCss = await read('public/styles/notes.css');
  assert.ok(!notesCss.includes('note-format'), 'die alte Fassung darf nicht liegen bleiben');
});

test('die Leiste ist eine Toolbar mit benannten Knoepfen und echten Trennern', async () => {
  const src = await read('public/utils/markdown-toolbar.js');
  assert.match(src, /role="toolbar"/);
  assert.match(src, /role="separator"/);
  assert.match(src, /aria-label="\$\{esc\(a\.label\)\}"/, 'ein title allein ist kein Name');
});

// --------------------------------------------------------------------------
// i18n
// --------------------------------------------------------------------------

test('die markdown-Sektion steht in allen Locales und traegt jeden Schluessel', async () => {
  const dir   = new URL('../public/locales/', import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  const keys  = Object.keys(de.markdown);
  assert.ok(keys.length >= 17, `erwartet werden 13 umgezogene + 4 neue, gefunden: ${keys.length}`);

  for (const f of files) {
    const d = JSON.parse(await readFile(new URL(f, dir), 'utf8'));
    assert.ok(d.markdown, `${f}: markdown-Sektion fehlt`);
    for (const key of keys) {
      const value = d.markdown[key];
      assert.equal(typeof value, 'string', `${f}: markdown.${key} fehlt`);
      assert.ok(value.trim().length > 0, `${f}: markdown.${key} ist leer`);
      assert.doesNotMatch(value, /\[de:/, `${f}: markdown.${key} traegt einen Platzhalter`);
    }
    // Die alten Schluessel sind umgezogen, nicht kopiert - sonst gaebe es zwei
    // Fassungen derselben Beschriftung und eine davon veraltete still.
    for (const old of Object.keys(d.notes)) {
      assert.ok(!/^format/.test(old), `${f}: notes.${old} muss nach markdown.* umgezogen sein`);
    }
  }
});

// --------------------------------------------------------------------------
// Die Leiste als Werkzeug des FELDS (Critique 2026-10-05, R16)
//
// Sie stand dauerhaft ueber jeder Notiz: zwoelf Knoepfe, mobil dreireihig
// (162px), zwoelf Tab-Stopps - im Aufgaben-Dialog schob sie die Faelligkeit
// auf y=700 von 844. Sie erscheint jetzt mit dem Fokus im Feld, bleibt dann
// stehen (ein Ausblenden beim Verlassen verschoebe das Feld, auf das der
// Finger gerade zielt), laeuft einzeilig und ist EIN Tab-Stopp.
// --------------------------------------------------------------------------

const { renderMarkdownToolbar, wireMarkdownToolbar } = await import('/utils/markdown-toolbar.js');

function fakeToolbarDom() {
  const listeners = (target) => {
    target.handlers = {};
    target.addEventListener = (type, fn) => { (target.handlers[type] ??= []).push(fn); };
    target.fire = (type, evt = {}) => (target.handlers[type] ?? []).forEach((fn) => fn(evt));
    return target;
  };
  const buttons = ['bold', 'italic', 'list'].map((format) => listeners({
    dataset: { format },
    tabIndex: -1,
    focused: false,
    focus() { buttons.forEach((b) => { b.focused = false; }); this.focused = true; },
    scrollIntoView() {},
    matches: (sel) => sel.includes('md-toolbar__btn'),
  }));
  buttons[0].tabIndex = 0;
  const bar = listeners({
    hidden: true,
    classList: { add() {}, remove() {}, toggle() {} },
    querySelectorAll: (sel) => (sel.includes('md-toolbar__btn') ? buttons : []),
    animate: undefined,
  });
  const textarea = listeners({ focusCalls: 0, focus() { this.focusCalls += 1; } });
  const root = {
    querySelector: (sel) => (sel === '.md-toolbar' ? bar : null),
    querySelectorAll: (sel) => (sel.includes('md-toolbar__btn') ? buttons : []),
  };
  return { root, bar, textarea, buttons };
}

test('R16: die Leiste kommt verborgen und als EIN Tab-Stopp aus dem Renderer', () => {
  const html = renderMarkdownToolbar();
  assert.match(html, /<div class="md-toolbar" role="toolbar"[^>]*\shidden>/, 'verborgen, bis das Feld den Fokus hat');
  assert.equal((html.match(/tabindex="0"/g) ?? []).length, 1, 'genau ein Knopf steht in der Tab-Folge');
  assert.equal((html.match(/tabindex="-1"/g) ?? []).length, 11, 'die anderen elf erreicht man mit den Pfeiltasten');
});

test('R16: der Fokus im Feld zeigt die Leiste, und sie bleibt stehen', () => {
  const { root, bar, textarea } = fakeToolbarDom();
  wireMarkdownToolbar(root, textarea);
  assert.equal(bar.hidden, true, 'ohne Fokus bleibt sie verborgen');
  textarea.fire('focus');
  assert.equal(bar.hidden, false, 'der Fokus im Feld zeigt sie');
  textarea.fire('blur');
  assert.equal(bar.hidden, false, 'sie verschwindet nicht wieder - das naechste Feld spraenge sonst unter dem Finger weg');
});

test('R16: ein Feld, das beim Verdrahten schon den Fokus hat, zeigt die Leiste sofort', () => {
  const { root, bar, textarea } = fakeToolbarDom();
  const before = globalThis.document;
  globalThis.document = { activeElement: textarea };
  try { wireMarkdownToolbar(root, textarea); } finally { globalThis.document = before; }
  assert.equal(bar.hidden, false);
});

test('R16: Pfeiltasten wandern durch die Leiste, der Tab-Stopp wandert mit', () => {
  const { root, bar, textarea, buttons } = fakeToolbarDom();
  wireMarkdownToolbar(root, textarea);
  const key = (k, target) => {
    const evt = { key: k, target, prevented: false, preventDefault() { this.prevented = true; } };
    bar.fire('keydown', evt);
    return evt;
  };
  assert.equal(key('ArrowRight', buttons[0]).prevented, true);
  assert.equal(buttons[1].focused, true);
  assert.deepEqual(buttons.map((b) => b.tabIndex), [-1, 0, -1]);
  key('End', buttons[1]);
  assert.equal(buttons[2].focused, true);
  key('ArrowRight', buttons[2]);
  assert.equal(buttons[0].focused, true, 'am Ende laeuft die Auswahl um');
  key('ArrowLeft', buttons[0]);
  assert.equal(buttons[2].focused, true);
  key('Home', buttons[2]);
  assert.deepEqual(buttons.map((b) => b.tabIndex), [0, -1, -1]);
  assert.equal(key('a', buttons[0]).prevented, false, 'fremde Tasten bleiben unangetastet');
});

test('R16: die Leiste laeuft einzeilig und scrollt, statt umzubrechen', async () => {
  const css = (await read('public/styles/markdown-toolbar.css')).replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = css.match(/\.md-toolbar\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(rule, /flex-wrap:\s*nowrap/);
  assert.match(rule, /overflow-x:\s*auto/);
  assert.doesNotMatch(css, /flex-wrap:\s*wrap/, 'kein Umbruch: dreireihig waren es 162px vor dem Textfeld');
  // `display` an einem per `hidden` geschalteten Element schluege das UA-[hidden].
  assert.match(css, /\.md-toolbar\[hidden\]\s*\{\s*display:\s*none/, 'verborgen heisst verborgen, trotz display: flex');
});
