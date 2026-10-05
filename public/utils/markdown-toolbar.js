/**
 * Modul: Markdown-Formatierungsleiste
 * Zweck: Die eine Leiste ueber jedem Textfeld, dessen Inhalt als Markdown
 *        gelesen wird - damit niemand Syntax auswendig koennen muss.
 * Abhaengigkeiten: /i18n.js, /utils/html.js, /utils/ux.js
 *
 * Sie stand bis zuletzt in notes.js, und die Aufgaben rendern ihre Notiz seit
 * v2.7.0 durch denselben Renderer, hatten aber kein Werkzeug, sie zu schreiben
 * (#731). Eine Kopie waere die zweite Fassung von 13 Buttons und ihren
 * Einfuegeregeln gewesen; deshalb liegt sie hier, und deshalb heissen ihre
 * i18n-Schluessel `markdown.*` statt `notes.*` - sie gehoert keinem Modul mehr.
 */

import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { expandIn, wireScrollFade } from '/utils/ux.js';

// Reihenfolge = Anzeige-Reihenfolge; null trennt zwei Gruppen.
const FORMAT_ACTIONS = () => [
  { format: 'bold',          icon: 'bold',          label: t('markdown.bold') },
  { format: 'italic',        icon: 'italic',        label: t('markdown.italic') },
  { format: 'underline',     icon: 'underline',     label: t('markdown.underline') },
  { format: 'strikethrough', icon: 'strikethrough', label: t('markdown.strikethrough') },
  null,
  { format: 'heading',       icon: 'heading',       label: t('markdown.heading') },
  { format: 'list',          icon: 'list',          label: t('markdown.list') },
  { format: 'ordered-list',  icon: 'list-ordered',  label: t('markdown.orderedList') },
  { format: 'checklist',     icon: 'list-checks',   label: t('markdown.checklist') },
  null,
  { format: 'link',          icon: 'link',          label: t('markdown.link') },
  { format: 'code',          icon: 'code',          label: t('markdown.code') },
  { format: 'quote',         icon: 'quote',         label: t('markdown.quote') },
  { format: 'divider',       icon: 'minus',         label: t('markdown.divider') },
];

/**
 * Formatierungsleiste als HTML-Fragment.
 *
 * Datengetrieben - eine Quelle fuer Reihenfolge, Icon und Beschriftung. Die
 * Trenner sind `role="separator"` und nicht bedeutungslose Spans, und jeder
 * Button traegt einen echten Namen statt nur ein `title`.
 *
 * EIN WERKZEUG DES FELDS, KEIN DAUERGAST (Critique 2026-10-05, R16). Die Leiste
 * stand ueber jeder Notiz, auch ueber der leeren: zwoelf Knoepfe, mobil in drei
 * Reihen (162px), zwoelf Tab-Stopps zwischen Titel und Text. Im Aufgaben-Dialog
 * schob sie die Faelligkeit auf y=700 von 844. Drei Regeln seitdem:
 *
 *  1. Sie kommt `hidden` und erscheint mit dem Fokus im Feld
 *     (`wireMarkdownToolbar`). Danach BLEIBT sie: ein Ausblenden beim Verlassen
 *     verschoebe genau das Feld, auf das der Finger gerade zielt.
 *  2. Sie laeuft einzeilig und scrollt (markdown-toolbar.css).
 *  3. Sie ist EIN Tab-Stopp (`role="toolbar"` mit wanderndem `tabindex`):
 *     Umschalt+Tab aus dem Feld fuehrt hinein - sie steht davor, im Bild wie
 *     im Baum -, die Pfeiltasten wandern, Tab fuehrt zurueck ins Feld.
 *
 * @returns {string} HTML fuer insertAdjacentHTML
 */
export function renderMarkdownToolbar() {
  let first = true;
  const items = FORMAT_ACTIONS().map((a) => {
    if (a === null) return '<span class="md-toolbar__sep" role="separator" aria-orientation="vertical"></span>';
    const tabindex = first ? 0 : -1;
    first = false;
    return `<button type="button" class="md-toolbar__btn" data-format="${a.format}" tabindex="${tabindex}"
               title="${esc(a.label)}" aria-label="${esc(a.label)}">
         <i data-lucide="${a.icon}" class="icon-md" aria-hidden="true"></i>
       </button>`;
  }).join('');

  return `<div class="md-toolbar" role="toolbar" aria-label="${t('markdown.toolbarLabel')}" hidden>${items}</div>`;
}

/**
 * Haengt die Leiste an ein Textfeld: Klicks auf die Buttons, die drei
 * Tastenkuerzel, die jeder aus einem Textverarbeitungsprogramm mitbringt, das
 * Erscheinen mit dem Fokus und die Pfeiltasten innerhalb der Leiste.
 *
 * @param {ParentNode} root Container, der Leiste UND Textfeld enthaelt
 * @param {HTMLTextAreaElement} textarea
 */
export function wireMarkdownToolbar(root, textarea) {
  const bar = root.querySelector('.md-toolbar');
  const buttons = [...root.querySelectorAll('.md-toolbar__btn[data-format]')];

  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      applyFormat(textarea, btn.dataset.format);
      textarea.focus();
    });
  });

  textarea.addEventListener('keydown', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    if (e.key === 'b') { e.preventDefault(); applyFormat(textarea, 'bold'); }
    if (e.key === 'i') { e.preventDefault(); applyFormat(textarea, 'italic'); }
    if (e.key === 'u') { e.preventDefault(); applyFormat(textarea, 'underline'); }
  });

  if (!bar) return;

  // Erscheinen: einmal, und dann stehenbleiben. Das Aufziehen nimmt dem Feld
  // den Sprung - es rueckt um die Hoehe der Leiste nach unten, waehrend der
  // Cursor schon darin steht (`expandIn` schweigt unter reduzierter Bewegung).
  const reveal = ({ animate = true } = {}) => {
    if (!bar.hidden) return;
    bar.hidden = false;
    wireScrollFade(bar);
    if (animate) expandIn(bar);
  };
  textarea.addEventListener('focus', () => reveal());
  if (typeof document !== 'undefined' && document.activeElement === textarea) reveal({ animate: false });

  // Wandernder Tab-Stopp (WAI-ARIA Toolbar): genau ein Knopf traegt
  // tabindex="0" - der zuletzt besuchte, damit die Rueckkehr dort ansetzt.
  const moveTo = (index) => {
    const next = buttons[(index + buttons.length) % buttons.length];
    buttons.forEach((b) => { b.tabIndex = b === next ? 0 : -1; });
    next.focus();
    next.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  };
  bar.addEventListener('keydown', (e) => {
    const at = buttons.indexOf(e.target);
    if (at < 0) return;
    const rtl = typeof document !== 'undefined' && document.documentElement?.dir === 'rtl';
    const step = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 }[e.key];
    if (step) { e.preventDefault(); moveTo(at + step); }
    else if (e.key === 'Home') { e.preventDefault(); moveTo(0); }
    else if (e.key === 'End') { e.preventDefault(); moveTo(buttons.length - 1); }
  });
}

/**
 * Fuegt Markdown-Marker um die Auswahl ein oder an den Zeilenanfang.
 *
 * Der Platzhaltertext bei leerer Auswahl kommt aus der Uebersetzung: er landet
 * IM Textfeld und damit in der Notiz, also ist er Oberflaechentext wie jeder
 * andere. Bis zur Verschiebung hierher stand er fest auf Deutsch im Quelltext,
 * und ein englischer Haushalt bekam beim Klick auf "Link" ein `[Linktext](url)`.
 *
 * @param {HTMLTextAreaElement} textarea
 * @param {string} format
 */
export function applyFormat(textarea, format) {
  const start = textarea.selectionStart;
  const end   = textarea.selectionEnd;
  const text  = textarea.value;
  const sel   = text.slice(start, end);

  // Zeilenanfang links vom Cursor - fuer alle Formate, die eine ZEILE praegen.
  const lineHead = () => text.lastIndexOf('\n', start - 1) + 1;
  // Praefix an den Zeilenanfang setzen; auf einer schon beschriebenen Zeile
  // beginnt der Eintrag auf einer neuen, sonst klebte er am Vortext.
  const prefixLine = (marker) => {
    const head = lineHead();
    const onEmptyLine = text.slice(head, start).trim() === '';
    textarea.setRangeText(onEmptyLine ? marker : `\n${marker}`, start, start, 'end');
  };
  // Jede Zeile der Auswahl praefixen, ohne ein bereits gesetztes zu verdoppeln.
  const prefixSelection = (marker, alreadySet) => {
    const lines = sel.split('\n').map((l, i) => alreadySet(l, i) ? l : `${marker(i)}${l}`);
    textarea.setRangeText(lines.join('\n'), start, end, 'end');
  };

  let before, after, insert;
  switch (format) {
    case 'bold':
      before = '**'; after = '**';
      insert = sel || t('markdown.placeholderText');
      break;
    case 'italic':
      before = '*'; after = '*';
      insert = sel || t('markdown.placeholderText');
      break;
    case 'underline':
      before = '<u>'; after = '</u>';
      insert = sel || t('markdown.placeholderText');
      break;
    case 'strikethrough':
      before = '~~'; after = '~~';
      insert = sel || t('markdown.placeholderText');
      break;
    case 'code':
      before = '`'; after = '`';
      insert = sel || t('markdown.placeholderCode');
      break;
    case 'link': {
      const url = t('markdown.placeholderUrl');
      if (sel) {
        textarea.setRangeText(`[${sel}](${url})`, start, end, 'select');
        // Auswahl auf die URL: das ist das Feld, das noch gefuellt werden muss.
        textarea.selectionStart = start + sel.length + 3;
        textarea.selectionEnd   = textarea.selectionStart + url.length;
      } else {
        const label = t('markdown.placeholderLinkText');
        textarea.setRangeText(`[${label}](${url})`, start, end, 'select');
        textarea.selectionStart = start + 1;
        textarea.selectionEnd   = start + 1 + label.length;
      }
      return;
    }
    case 'heading': {
      // Eine Stufe tiefer je Klick, nach ### wieder zurueck auf keine.
      const head    = lineHead();
      const lineEnd = text.indexOf('\n', start);
      const stop    = lineEnd === -1 ? text.length : lineEnd;
      const line    = text.slice(head, stop);
      const match   = line.match(/^(#{1,3})\s/);
      if (match && match[1].length < 3)       textarea.setRangeText('#' + line, head, stop, 'end');
      else if (match)                          textarea.setRangeText(line.replace(/^#{1,3}\s/, ''), head, stop, 'end');
      else                                     textarea.setRangeText('## ' + line, head, stop, 'end');
      return;
    }
    case 'list':
      if (sel) prefixSelection(() => '- ', (l) => l.startsWith('- '));
      else prefixLine('- ');
      return;
    case 'ordered-list':
      // Nicht praefixen, sondern neu durchnummerieren: eine schon nummerierte
      // Auswahl bekaeme sonst "1. 3. Text".
      if (sel) {
        const lines = sel.split('\n').map((l, i) => `${i + 1}. ${l.replace(/^\d+\.\s/, '')}`);
        textarea.setRangeText(lines.join('\n'), start, end, 'end');
      } else prefixLine('1. ');
      return;
    case 'checklist':
      if (sel) prefixSelection(() => '- [ ] ', (l) => l.startsWith('- [ ] '));
      else prefixLine('- [ ] ');
      return;
    case 'quote':
      if (sel) prefixSelection(() => '> ', (l) => l.startsWith('> '));
      else prefixLine('> ');
      return;
    case 'divider':
      textarea.setRangeText('\n\n---\n\n', start, end, 'end');
      return;
    default: return;
  }

  textarea.setRangeText(`${before}${insert}${after}`, start, end, 'select');
  // Auswahl auf den eingefuegten Text setzen (ohne die Marker)
  textarea.selectionStart = start + before.length;
  textarea.selectionEnd   = start + before.length + insert.length;
}
