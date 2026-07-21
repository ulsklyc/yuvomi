/**
 * Modul: vCard-Parser (public/utils/vcard.js)
 * Zweck: Reine, DOM-freie Extraktion von Kontaktdaten aus vCard-3.0/4.0-Text.
 *        Unterstuetzt Dateien mit mehreren Kontakten (Multi-Card) und das
 *        Geburtsdatum (BDAY -> contacts.birthday, ISO YYYY-MM-DD).
 * Abhaengigkeiten: public/utils/contact-name.js (rein, DOM-frei).
 */

import { composeDisplayName, normalizeNameParts } from './contact-name.js';

/**
 * Entpackt vCard-Escapes (`\,` `\;` `\\` `\n`/`\N`) in EINEM Durchlauf.
 * Der Single-Pass ist reihenfolge-sicher: sequenzielle `.replace()`-Ketten
 * lösen `\\` erst am Ende auf und können dabei zuvor freigelegte Backslashes
 * falsch weiterverarbeiten. Verhaltensgleich zu
 * server/services/cardav-sync.js#unescapeVCardValue.
 */
function unescapeVCard(s) {
  return String(s || '').replace(/\\([\\,;nN])/g, (_, ch) =>
    (ch === 'n' || ch === 'N') ? '\n' : ch
  );
}

/**
 * Zerlegt einen strukturierten vCard-Wert an *unescapten* Trennzeichen.
 * Verhaltensgleich zu server/services/cardav-sync.js#splitVCardValue.
 * @param {string} value
 * @param {string} separator - Einzelzeichen (';' oder ',')
 * @returns {string[]}
 */
function splitUnescaped(value, separator) {
  const parts = [];
  let current = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '\\' && i + 1 < value.length) {
      current += ch + value[i + 1];
      i++;
    } else if (ch === separator) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

/**
 * Erkennt Quoted-Printable-Transfer-Encoding (vCard 2.1) im Parameter-Teil
 * einer Property-Zeile, z. B. `N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE`.
 * Verhaltensgleich zu server/services/cardav-sync.js#isQuotedPrintableParams.
 */
function isQuotedPrintable(params) {
  return /(?:^|;)ENCODING=(?:QUOTED-PRINTABLE|QP)(?:;|$)/i.test(params || '');
}

/**
 * Liest den CHARSET-Parameter einer Property-Zeile (Default 'utf-8').
 * Verhaltensgleich zu server/services/cardav-sync.js#charsetOfParams.
 */
function charsetOf(params) {
  const m = /(?:^|;)CHARSET=([^;]+)/i.exec(params || '');
  return (m ? m[1].trim() : '') || 'utf-8';
}

/**
 * Dekodiert einen Quoted-Printable-Wert (RFC 2045, vCard 2.1) in Text.
 * Sammelt `=XX`-Oktette (und literale Bytes) und dekodiert die Byte-Folge als
 * `charset` - nur so werden Mehrbyte-Zeichen wie das tuerkische "ı" (UTF-8
 * C4 B1) oder "ş" (C5 9F) korrekt, statt buchstaeblich als "=C4=B1" zu landen.
 * Soft-Line-Breaks (`=` am Zeilenende) werden zuvor entfernt. Unbekanntes
 * Charset faellt auf UTF-8 zurueck. Verhaltensgleich zu
 * server/services/cardav-sync.js#decodeQuotedPrintable.
 */
function decodeQuotedPrintable(value, charset) {
  const joined = String(value == null ? '' : value).replace(/=\r?\n/g, '');
  const bytes = [];
  for (let i = 0; i < joined.length; i++) {
    const ch = joined[i];
    if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(joined.substr(i + 1, 2))) {
      bytes.push(parseInt(joined.substr(i + 1, 2), 16));
      i += 2;
    } else {
      bytes.push(ch.charCodeAt(0) & 0xff);
    }
  }
  const octets = Uint8Array.from(bytes);
  try {
    return new TextDecoder(charset || 'utf-8').decode(octets);
  } catch {
    return new TextDecoder('utf-8').decode(octets);
  }
}

/**
 * Entfaltet einen vCard-Text: zuerst Quoted-Printable-Soft-Line-Breaks (vCard
 * 2.1) zusammenziehen - nur bei QP-Property-Zeilen, damit Base64-Folding und
 * normale Werte unberuehrt bleiben -, danach regulaeres Folding (RFC 6350 3.2,
 * Folgezeile beginnt mit Space/Tab).
 */
function unfoldVCard(text) {
  const lines = String(text || '').split(/\r?\n/);
  const merged = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const colon = line.indexOf(':');
    const head = colon === -1 ? line : line.slice(0, colon);
    if (isQuotedPrintable(head)) {
      while (/=[ \t]*$/.test(line) && i + 1 < lines.length) {
        line = line.replace(/=[ \t]*$/, '') + lines[i + 1];
        i++;
      }
    }
    merged.push(line);
  }
  return merged.join('\n').replace(/\r?\n[ \t]/g, '');
}

/**
 * Normalisiert einen vCard-BDAY-Wert auf ISO YYYY-MM-DD.
 * Spiegelt server/services/cardav-sync.js#parseBirthday (Layer-Boundary
 * verbietet den direkten Import von Server-Code im Frontend). Verhalten muss
 * mit dem CardDAV-Sync identisch bleiben, damit contacts.birthday einheitlich
 * ist und der #518-Geburtstags-Import beide Quellen gleich behandelt.
 * @param {string} value - Roher BDAY-Wert (z. B. "1990-01-01", "19900101", "1990")
 * @returns {string|null} ISO-Datum oder null, wenn nicht verwertbar
 */
export function parseBirthdayValue(value) {
  if (!value) return null;

  // Alle Zeichen ausser Ziffern und Bindestrich entfernen (TZ-Suffixe etc.)
  const cleaned = String(value).replace(/[^\d-]/g, '');

  // ISO (YYYY-MM-DD)
  if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) return cleaned;

  // Kompakt (YYYYMMDD)
  if (/^\d{8}$/.test(cleaned)) {
    return `${cleaned.slice(0, 4)}-${cleaned.slice(4, 6)}-${cleaned.slice(6, 8)}`;
  }

  // Nur Jahr
  if (/^\d{4}$/.test(cleaned)) return `${cleaned}-01-01`;

  return null;
}

/**
 * Zerlegt einen vCard-Text in einzelne BEGIN:VCARD..END:VCARD-Bloecke.
 * Ohne Markup wird der Gesamttext als eine Karte behandelt.
 * @param {string} text
 * @returns {string[]}
 */
export function splitVCards(text) {
  const src = String(text || '');
  const matches = src.match(/BEGIN:VCARD[\s\S]*?END:VCARD/gi);
  if (matches && matches.length) return matches;
  return src.trim() ? [src] : [];
}

/**
 * Parst eine einzelne vCard.
 * @param {string} text - Eine vCard (ein BEGIN..END-Block).
 * @param {{ resolveCategory?: (rawCategories: string) => (string|null), fallbackCategory?: string }} [opts]
 * @returns {{ name: string|null, phone: string|null, email: string|null,
 *             address: string|null, notes: string|null, birthday: string|null,
 *             category: string }}
 */
export function parseVCard(text, opts = {}) {
  const { resolveCategory, fallbackCategory = 'misc' } = opts;

  // Quoted-Printable-Soft-Line-Breaks (vCard 2.1) + Folding (RFC 6350) entfalten.
  const unfolded = unfoldVCard(text);

  // Liefert { params, value } einer Property-Zeile; params ohne fuehrendes ';'.
  const getField = (prop) => {
    const re = new RegExp(`^${prop}(;[^:]*)?:(.*)$`, 'im');
    const m = re.exec(unfolded);
    if (!m) return null;
    return { params: m[1] ? m[1].slice(1) : '', value: m[2].trim() };
  };

  // Rohwert mit aufgeloestem Transfer-Encoding (Quoted-Printable), aber ohne
  // vCard-Escapes. QP wird nur bei deklariertem ENCODING angewandt, damit
  // literale `=` in normalen Werten (URLs, Notizen) unangetastet bleiben.
  const getRaw = (prop) => {
    const f = getField(prop);
    if (!f) return null;
    return isQuotedPrintable(f.params)
      ? decodeQuotedPrintable(f.value, charsetOf(f.params))
      : f.value;
  };

  const get = (prop) => {
    const raw = getRaw(prop);
    return raw === null ? null : unescapeVCard(raw);
  };

  // Strukturierte N-Komponenten erhalten (#535). An *unescapten* Semikola
  // trennen, damit ein maskiertes `\;` innerhalb einer Komponente bleibt -
  // spiegelt server/services/cardav-sync.js#splitVCardValue.
  const nRaw = getRaw('N');
  const nParts = nRaw ? splitUnescaped(nRaw, ';').map(unescapeVCard) : [];
  const nameParts = normalizeNameParts({
    lastName:   nParts[0],
    firstName:  nParts[1],
    middleName: nParts[2],
    namePrefix: nParts[3],
    nameSuffix: nParts[4],
  });

  // Anzeigename einheitlich aus N; FN nur als Fallback (#535).
  const name = composeDisplayName(nameParts) || get('FN') || null;
  const phone = get('TEL') || null;
  const email = get('EMAIL') || null;

  // ADR: ;;street;city;region;postal;country
  const adrRaw = get('ADR');
  let address = null;
  if (adrRaw) {
    const parts = adrRaw.split(';').map((p) => p.trim()).filter(Boolean);
    address = parts.join(', ') || null;
  }

  const notes = get('NOTE') || null;
  const birthday = parseBirthdayValue(get('BDAY'));
  const catRaw = get('CATEGORIES') || '';
  const category = (resolveCategory && resolveCategory(catRaw)) || fallbackCategory;

  return { name, ...nameParts, phone, email, address, notes, birthday, category };
}

/**
 * Parst alle Kontakte einer (moeglicherweise mehrfachen) vCard-Datei.
 * @param {string} text
 * @param {Parameters<typeof parseVCard>[1]} [opts]
 * @returns {ReturnType<typeof parseVCard>[]}
 */
export function parseVCards(text, opts = {}) {
  return splitVCards(text).map((card) => parseVCard(card, opts));
}
