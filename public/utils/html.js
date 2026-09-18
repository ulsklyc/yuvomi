/**
 * Modul: HTML Utilities
 * Zweck: XSS-Schutz fuer innerHTML-basiertes Rendering
 * Abhaengigkeiten: /utils/markdown-checklist.js
 */

import { matchChecklistLine } from './markdown-checklist.js';
import { esc } from './html-escape.js';

// esc() wohnt seit #944 nebenan und wird hier weiter angeboten: die rund
// siebzig Aufrufer im Frontend importieren es unveraendert von hier, waehrend
// der Mail-Versand im Backend nur das schmale Modul zieht statt dieser Datei
// samt Notiz-Renderer. Eine Funktion, zwei Adressen - keine zweite Fassung.
export { esc };

/**
 * Normalisiert einen iCalendar LOCATION-String fuer die Anzeige.
 * Entfernt ICS-Backslash-Escapes (RFC 5545 §3.3.11) und fasst
 * mehrzeilige Adressen zu einem einzeiligen String zusammen.
 *
 * @param {string|null|undefined} raw
 * @returns {string}
 */
/**
 * Wendet Inline-Markdown auf ein bereits zeilenweise zerlegtes Segment an.
 * Escapet zuerst vollständig (XSS), führt danach nur vertrauenswürdige Tags ein.
 * Unterstützt: <u>Unterstreichung</u> (vom Editor als Literal eingefügt),
 * `Code`, [Text](url) (nur http/https/mailto), **fett**, ~~durchgestrichen~~, *kursiv*.
 *
 * @param {string} segment
 * @returns {string} HTML-sicheres Inline-Fragment
 */
function inlineMarkdown(segment) {
  let out = esc(segment);
  // Unterstreichung: der Editor fügt literale <u>…</u> ein → nach esc() reaktivieren
  out = out.replace(/&lt;u&gt;/g, '<u>').replace(/&lt;\/u&gt;/g, '</u>');
  // Inline-Code zuerst, damit Marker darin nicht als Emphase interpretiert werden
  out = out.replace(/`([^`]+?)`/g, '<code class="note-md-code">$1</code>');
  // Links: nur sichere Schemata, sonst als Literal belassen. url ist bereits escaped.
  out = out.replace(/\[([^\]]+?)\]\(([^)\s]+?)\)/g, (whole, label, url) => {
    if (!/^(https?:\/\/|mailto:)/i.test(url)) return whole;
    return `<a class="note-md-link" href="${url}" target="_blank" rel="noopener noreferrer nofollow">${label}</a>`;
  });
  // Emphase: fett vor kursiv (verbraucht **), durchgestrichen beliebig
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/~~(.+?)~~/g, '<s>$1</s>');
  out = out.replace(/\*([^*]+?)\*/g, '<em>$1</em>');
  return out;
}

/**
 * Entfernt die Inline-Marker aus einem Segment und gibt reinen Text zurück.
 *
 * Für Attributwerte, die kein Markup vertragen — namentlich den zugänglichen
 * Namen eines Kästchens. `**Milch** kaufen` soll dort als „Milch kaufen"
 * ankommen und nicht als „Sternchen Sternchen Milch".
 *
 * @param {string} segment
 * @returns {string} Klartext (noch nicht HTML-escaped)
 */
function stripInlineMarkdown(segment) {
  return String(segment ?? '')
    .replace(/<\/?u>/g, '')
    .replace(/`([^`]+?)`/g, '$1')
    .replace(/\[([^\]]+?)\]\(([^)\s]+?)\)/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/\*([^*]+?)\*/g, '$1')
    .trim();
}

/**
 * Rendert die Markdown-Teilmenge des Notiz-Editors zu sicherem HTML — in
 * voller Parität mit der Editor-Toolbar: Überschriften (#–###), ungeordnete
 * und geordnete Listen, Checklisten (- [ ] / - [x]), Zitate (>), Trennlinien
 * (---), Inline-Code, Links sowie **fett** / *kursiv* / ~~strike~~ / <u>.
 *
 * Alle Nutzertexte werden über esc()/inlineMarkdown() escaped; nur statische,
 * vertrauenswürdige Block-Tags werden eingeführt. Rückgabe ist für
 * insertAdjacentHTML bestimmt.
 *
 * Checklisten-Kästchen sind standardmäßig Dekoration (`aria-hidden`), weil der
 * Renderer nicht wissen kann, ob sein Aufrufer den Text auch zurückschreiben
 * kann. Wer das kann, setzt `checklist.interactive` und bekommt echte
 * Bedienelemente mit der Quellzeilennummer am Element — der Aufrufer schaltet
 * dann über den Index um, nicht über den Text. Das Dashboard darf das
 * ausdrücklich nicht: es zeigt einen gekürzten Auszug, dessen Zeilennummern
 * nicht die der Notiz sind.
 *
 * DIE DRITTE FORM IST FÜR DEN, DER DEN GANZEN TEXT SIEHT UND TROTZDEM NICHT
 * SCHREIBEN DARF (#467): `checklist.stateLabels` macht aus dem Kästchen ein
 * Zustandszeichen statt eines Bedienelements. Die Dekorationsform wäre dort zu
 * wenig - sie ist `aria-hidden`, und damit verlöre ein Nur-lesen-Nutzer genau
 * die Auskunft, die diese Zeile trägt: ob der Punkt erledigt ist. Dieselbe
 * Bauart wie die `--static`-Zeichen in den Aufgaben (public/styles/tasks.css):
 * was Zustand ANZEIGT, bleibt lesbar; was nur handelt, verschwindet.
 *
 * @param {string|null|undefined} text
 * @param {{ checklist?: { interactive?: boolean, toggleLabel?: string,
 *           stateLabels?: { checked: string, unchecked: string } } }} [options]
 * @returns {string} HTML string
 */
export function renderMarkdownLight(text, options = {}) {
  if (!text) return '';

  const liveChecklist = options.checklist?.interactive === true;
  const toggleLabel   = options.checklist?.toggleLabel ?? '';
  // Nur ohne `interactive` - ein Kästchen ist entweder Bedienelement oder
  // Zeichen, nie beides.
  const stateLabels   = liveChecklist ? null : options.checklist?.stateLabels ?? null;

  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  let list = null;      // { tag: 'ul' | 'ol', checklist: boolean }
  let para = [];

  const flushPara = () => {
    if (para.length) { html.push(`<p class="note-md-p">${para.join('<br>')}</p>`); para = []; }
  };
  const closeList = () => {
    if (list) { html.push(`</${list.tag}>`); list = null; }
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    // Trennlinie
    if (/^ {0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushPara(); closeList(); html.push('<hr class="note-md-hr">'); continue;
    }
    // Überschrift (#–###)
    let m = line.match(/^ {0,3}(#{1,3})\s+(.+?)\s*#*\s*$/);
    if (m) {
      flushPara(); closeList();
      html.push(`<div class="note-md-h${m[1].length}">${inlineMarkdown(m[2])}</div>`);
      continue;
    }
    // Zitat
    m = line.match(/^ {0,3}>\s?(.*)$/);
    if (m) {
      flushPara(); closeList();
      html.push(`<blockquote class="note-md-quote">${inlineMarkdown(m[1])}</blockquote>`);
      continue;
    }
    // Checklisten-Eintrag — dieselbe Regel, nach der die Route zurückschreibt
    const item = matchChecklistLine(line);
    if (item) {
      flushPara();
      if (!list || list.tag !== 'ul' || !list.checklist) {
        closeList(); html.push('<ul class="note-md-ul note-md-checklist">'); list = { tag: 'ul', checklist: true };
      }
      // Das Kästchen trägt seinen Namen selbst statt den Eintragstext zu
      // umschließen: der darf einen Link enthalten, und ein <a> in einem
      // <button> ist kein gültiges HTML. Die Trefferfläche wächst deshalb per
      // CSS über die 1em der Box hinaus, nicht über das Markup.
      const zustandsLabel = stateLabels
        ? `${stripInlineMarkdown(item.text)}: ${item.checked ? stateLabels.checked : stateLabels.unchecked}`
        : '';
      const box = liveChecklist
        ? `<button type="button" class="note-md-box" role="checkbox" aria-checked="${item.checked}"`
          + ` data-md-line="${index}" data-md-checked="${item.checked ? '1' : '0'}"`
          + ` aria-label="${esc(stripInlineMarkdown(item.text) || toggleLabel)}"></button>`
        : stateLabels
          ? `<span class="note-md-box" role="img" aria-label="${esc(zustandsLabel)}"></span>`
          : '<span class="note-md-box" aria-hidden="true"></span>';
      html.push(`<li class="note-md-check${item.checked ? ' is-checked' : ''}">${box}<span>${inlineMarkdown(item.text)}</span></li>`);
      continue;
    }
    // Ungeordnete Liste
    m = line.match(/^ {0,3}[-*+]\s+(.*)$/);
    if (m) {
      flushPara();
      if (!list || list.tag !== 'ul' || list.checklist) {
        closeList(); html.push('<ul class="note-md-ul">'); list = { tag: 'ul', checklist: false };
      }
      html.push(`<li>${inlineMarkdown(m[1])}</li>`);
      continue;
    }
    // Geordnete Liste
    m = line.match(/^ {0,3}\d+[.)]\s+(.*)$/);
    if (m) {
      flushPara();
      if (!list || list.tag !== 'ol') {
        closeList(); html.push('<ol class="note-md-ol">'); list = { tag: 'ol' };
      }
      html.push(`<li>${inlineMarkdown(m[1])}</li>`);
      continue;
    }
    // Leerzeile → Absatz-Grenze
    if (line.trim() === '') { flushPara(); closeList(); continue; }
    // Fließtext
    closeList();
    para.push(inlineMarkdown(line));
  }
  flushPara();
  closeList();
  return html.join('');
}

export function fmtLocation(raw) {
  if (!raw) return '';
  return raw
    .replace(/\\[Nn]/g, '\n')   // \n / \N → newline
    .replace(/\\,/g,  ',')      // \, → ,
    .replace(/\\;/g,  ';')      // \; → ;
    .replace(/\\\\/g, '\\')     // \\ → \
    .replace(/[\n\r;]+/g, ', ') // newlines / semicolons → ", "
    .replace(/\s*,\s*/g, ', ')  // normalize spaces around commas
    .replace(/(?:,\s*){2,}/g, ', ') // collapse double commas
    .replace(/  +/g, ' ')
    .replace(/^[,\s]+|[,\s]+$/g, ''); // trim leading/trailing commas
}
