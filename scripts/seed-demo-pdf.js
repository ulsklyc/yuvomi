/**
 * Modul: Demo-PDF-Erzeuger
 * Zweck: Baut für den Demo-Seed eine echte, gültige PDF-Datei von Hand - eine
 *        A4-Seite, Titel und ein paar Textzeilen. Vorher lag unter jedem
 *        Demo-"PDF" Klartext, und jede Vorschau und jeder Screenshot im
 *        Dokumente-Modul zeigte einen Fehler (#1511).
 * Abhängigkeiten: keine (nur Buffer)
 *
 * Bewusst klein gehalten: PDF 1.4, die Standardschriften Helvetica und
 * Helvetica-Bold (kein Font-Embedding), ein unkomprimierter Inhaltsstrom,
 * klassische xref-Tabelle. Keine Zeitstempel und keine /ID - dieselbe Eingabe
 * ergibt dieselben Bytes.
 *
 * Text läuft als WinAnsiEncoding (Windows-1252) in die Seite: das deckt die
 * beiden Seed-Sprachen (en, de) samt Umlauten und ß. Ein Zeichen ausserhalb
 * von WinAnsi wird zu "?" - sichtbar statt still verschluckt, und nie ein
 * Byte, das die Seite an anderer Stelle als etwas anderes zeigt.
 *
 * Alle Offsets der xref-Tabelle sind BYTE-Offsets: gezählt wird an Buffern,
 * nie an Strings (ein "ä" ist ein Zeichen, in UTF-8 aber zwei Bytes).
 */

// A4 in PDF-Punkten (1/72 Zoll).
const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN = 56;

// Windows-1252 weicht nur im Bereich 0x80-0x9F von Latin-1 ab. Die fünf dort
// unbelegten Bytes (0x81, 0x8D, 0x8F, 0x90, 0x9D) fehlen absichtlich.
const CP1252_SPECIALS = new Map([
  [0x20AC, 0x80], [0x201A, 0x82], [0x0192, 0x83], [0x201E, 0x84], [0x2026, 0x85],
  [0x2020, 0x86], [0x2021, 0x87], [0x02C6, 0x88], [0x2030, 0x89], [0x0160, 0x8A],
  [0x2039, 0x8B], [0x0152, 0x8C], [0x017D, 0x8E], [0x2018, 0x91], [0x2019, 0x92],
  [0x201C, 0x93], [0x201D, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02DC, 0x98], [0x2122, 0x99], [0x0161, 0x9A], [0x203A, 0x9B], [0x0153, 0x9C],
  [0x017E, 0x9E], [0x0178, 0x9F],
]);

const QUESTION_MARK = 0x3F;
const SPACE = 0x20;

/**
 * Text → WinAnsi-Bytes. Steuerzeichen werden zum Leerzeichen, alles ausserhalb
 * von Windows-1252 zu "?".
 *
 * @param {string} text
 * @returns {Buffer}
 */
export function toWinAnsi(text) {
  const bytes = [];
  for (const char of String(text ?? '').normalize('NFC')) {
    const cp = char.codePointAt(0);
    if (cp < 0x20 || cp === 0x7F) bytes.push(SPACE);
    else if (cp < 0x7F) bytes.push(cp);
    else if (cp >= 0xA0 && cp <= 0xFF) bytes.push(cp);
    else bytes.push(CP1252_SPECIALS.get(cp) ?? QUESTION_MARK);
  }
  return Buffer.from(bytes);
}

/**
 * WinAnsi-Bytes → PDF-Literalstring `( ... )`. Klammern und Backslash würden
 * den String sonst beenden oder umdeuten.
 */
function pdfLiteral(text) {
  const out = [0x28];
  for (const byte of toWinAnsi(text)) {
    if (byte === 0x28 || byte === 0x29 || byte === 0x5C) out.push(0x5C);
    out.push(byte);
  }
  out.push(0x29);
  return Buffer.from(out);
}

/**
 * Metadaten-String als UTF-16BE-Hexstring mit BOM: die Info-Felder lesen
 * PDFDocEncoding, nicht WinAnsi, und die beiden weichen gerade bei den
 * typografischen Zeichen voneinander ab. UTF-16 trägt jedes Zeichen.
 */
function pdfTextString(text) {
  const value = String(text ?? '').normalize('NFC');
  let hex = 'FEFF';
  for (let i = 0; i < value.length; i += 1) {
    hex += value.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0');
  }
  return `<${hex}>`;
}

/** Bricht an Leerzeichen um; ein einzelnes zu langes Wort wird hart geteilt. */
function wrap(text, maxChars) {
  const lines = [];
  let current = '';
  for (const word of String(text ?? '').split(/\s+/).filter(Boolean)) {
    let rest = word;
    while (rest.length > maxChars) {
      if (current) { lines.push(current); current = ''; }
      lines.push(rest.slice(0, maxChars));
      rest = rest.slice(maxChars);
    }
    if (!current) current = rest;
    else if (current.length + 1 + rest.length <= maxChars) current += ` ${rest}`;
    else { lines.push(current); current = rest; }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Baut eine einseitige A4-PDF.
 *
 * @param {object}   input
 * @param {string}   input.title     Überschrift der Seite und Titel in den Metadaten.
 * @param {string}  [input.subtitle] Eine Zeile unter der Überschrift.
 * @param {string[]} [input.lines]   Textzeilen unter der Trennlinie.
 * @param {string}  [input.footer]   Fusszeile am unteren Seitenrand.
 * @returns {Buffer} die fertige Datei
 */
export function buildDemoPdf({ title, subtitle = '', lines = [], footer = '' } = {}) {
  // ── Inhaltsstrom ──────────────────────────────────────────────────────────
  const ops = [];
  const text = (font, size, x, y, value) => {
    ops.push(Buffer.from(`BT /${font} ${size} Tf ${x} ${y} Td `, 'latin1'), pdfLiteral(value), Buffer.from(' Tj ET\n', 'latin1'));
  };

  let y = PAGE_HEIGHT - MARGIN - 20;
  for (const line of wrap(title, 40)) { text('F2', 20, MARGIN, y, line); y -= 26; }
  y -= 2;
  for (const line of wrap(subtitle, 80)) { text('F1', 12, MARGIN, y, line); y -= 16; }
  y -= 4;
  ops.push(Buffer.from(`0.6 G 0.75 w ${MARGIN} ${y} m ${PAGE_WIDTH - MARGIN} ${y} l S\n`, 'latin1'));
  y -= 24;
  for (const entry of lines) {
    const wrapped = wrap(entry, 85);
    if (!wrapped.length) { y -= 10; continue; } // leere Zeile = Absatzabstand
    for (const line of wrapped) {
      if (y < MARGIN + 40) break; // die Demo-Seite bleibt EINE Seite
      text('F1', 11, MARGIN, y, line);
      y -= 16;
    }
  }
  if (footer) {
    ops.push(Buffer.from('0.45 g\n', 'latin1'));
    text('F1', 9, MARGIN, MARGIN, wrap(footer, 100)[0] || '');
  }
  const stream = Buffer.concat(ops);

  // ── Objekte ───────────────────────────────────────────────────────────────
  const font = (base) => `<< /Type /Font /Subtype /Type1 /BaseFont /${base} /Encoding /WinAnsiEncoding >>`;
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'latin1'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'latin1'),
    Buffer.from(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      '/Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
      'latin1'
    ),
    Buffer.from(font('Helvetica'), 'latin1'),
    Buffer.from(font('Helvetica-Bold'), 'latin1'),
    Buffer.concat([
      Buffer.from(`<< /Length ${stream.length} >>\nstream\n`, 'latin1'),
      stream,
      Buffer.from('endstream', 'latin1'),
    ]),
    Buffer.from(`<< /Title ${pdfTextString(title)} /Producer ${pdfTextString('Yuvomi demo seed')} >>`, 'latin1'),
  ];

  // ── Datei: Kopf, Objekte, xref, Trailer ───────────────────────────────────
  // Die zweite Zeile trägt vier Bytes über 127: daran erkennen Werkzeuge, dass
  // die Datei binär ist und nicht als Text umkodiert werden darf.
  const parts = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  let offset = parts[0].length;
  const offsets = [];
  objects.forEach((body, index) => {
    const chunk = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1'),
    ]);
    offsets.push(offset);
    parts.push(chunk);
    offset += chunk.length;
  });

  // Jeder xref-Eintrag ist exakt 20 Bytes lang: 10 Ziffern, Leerzeichen,
  // 5 Ziffern, Leerzeichen, Kennung, dann die zwei Bytes " \n".
  const entry = (at, generation, kind) => `${String(at).padStart(10, '0')} ${String(generation).padStart(5, '0')} ${kind} \n`;
  const xref =
    `xref\n0 ${objects.length + 1}\n` +
    entry(0, 65535, 'f') +
    offsets.map((at) => entry(at, 0, 'n')).join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\n` +
    `startxref\n${offset}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'latin1'));

  return Buffer.concat(parts);
}
