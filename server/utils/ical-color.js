/**
 * Modul: iCalendar-Farb-Auflöser
 * Zweck: Die iCalendar-COLOR-Property (RFC 7986) trägt keinen Hex-Wert, sondern
 *        einen CSS3-Farbnamen ("cornflowerblue", "tomato"). Yuvomi speichert
 *        Event-Farben dagegen als `#RRGGBB`. Diese Funktion normalisiert beide
 *        Schreibweisen auf ein Hex-Tripel, damit CalDAV-/Apple-/ICS-Events ihre
 *        eigene Farbe behalten können, statt pauschal die Kalenderfarbe zu erben.
 *
 * Rückgabe: `#RRGGBB` (Großbuchstaben) oder null, wenn der Wert leer/unbekannt
 * ist — dann fällt der Aufrufer bewusst auf die Kalenderfarbe zurück.
 *
 * Die Tabelle deckt die vollständige CSS-Color-Module-Level-3-Namensliste ab
 * (inkl. der grey/gray- und aqua/cyan-Synonyme).
 */

const CSS_COLOR_NAMES = {
  aliceblue: '#F0F8FF', antiquewhite: '#FAEBD7', aqua: '#00FFFF',
  aquamarine: '#7FFFD4', azure: '#F0FFFF', beige: '#F5F5DC',
  bisque: '#FFE4C4', black: '#000000', blanchedalmond: '#FFEBCD',
  blue: '#0000FF', blueviolet: '#8A2BE2', brown: '#A52A2A',
  burlywood: '#DEB887', cadetblue: '#5F9EA0', chartreuse: '#7FFF00',
  chocolate: '#D2691E', coral: '#FF7F50', cornflowerblue: '#6495ED',
  cornsilk: '#FFF8DC', crimson: '#DC143C', cyan: '#00FFFF',
  darkblue: '#00008B', darkcyan: '#008B8B', darkgoldenrod: '#B8860B',
  darkgray: '#A9A9A9', darkgreen: '#006400', darkgrey: '#A9A9A9',
  darkkhaki: '#BDB76B', darkmagenta: '#8B008B', darkolivegreen: '#556B2F',
  darkorange: '#FF8C00', darkorchid: '#9932CC', darkred: '#8B0000',
  darksalmon: '#E9967A', darkseagreen: '#8FBC8F', darkslateblue: '#483D8B',
  darkslategray: '#2F4F4F', darkslategrey: '#2F4F4F', darkturquoise: '#00CED1',
  darkviolet: '#9400D3', deeppink: '#FF1493', deepskyblue: '#00BFFF',
  dimgray: '#696969', dimgrey: '#696969', dodgerblue: '#1E90FF',
  firebrick: '#B22222', floralwhite: '#FFFAF0', forestgreen: '#228B22',
  fuchsia: '#FF00FF', gainsboro: '#DCDCDC', ghostwhite: '#F8F8FF',
  gold: '#FFD700', goldenrod: '#DAA520', gray: '#808080',
  green: '#008000', greenyellow: '#ADFF2F', grey: '#808080',
  honeydew: '#F0FFF0', hotpink: '#FF69B4', indianred: '#CD5C5C',
  indigo: '#4B0082', ivory: '#FFFFF0', khaki: '#F0E68C',
  lavender: '#E6E6FA', lavenderblush: '#FFF0F5', lawngreen: '#7CFC00',
  lemonchiffon: '#FFFACD', lightblue: '#ADD8E6', lightcoral: '#F08080',
  lightcyan: '#E0FFFF', lightgoldenrodyellow: '#FAFAD2', lightgray: '#D3D3D3',
  lightgreen: '#90EE90', lightgrey: '#D3D3D3', lightpink: '#FFB6C1',
  lightsalmon: '#FFA07A', lightseagreen: '#20B2AA', lightskyblue: '#87CEFA',
  lightslategray: '#778899', lightslategrey: '#778899', lightsteelblue: '#B0C4DE',
  lightyellow: '#FFFFE0', lime: '#00FF00', limegreen: '#32CD32',
  linen: '#FAF0E6', magenta: '#FF00FF', maroon: '#800000',
  mediumaquamarine: '#66CDAA', mediumblue: '#0000CD', mediumorchid: '#BA55D3',
  mediumpurple: '#9370DB', mediumseagreen: '#3CB371', mediumslateblue: '#7B68EE',
  mediumspringgreen: '#00FA9A', mediumturquoise: '#48D1CC', mediumvioletred: '#C71585',
  midnightblue: '#191970', mintcream: '#F5FFFA', mistyrose: '#FFE4E1',
  moccasin: '#FFE4B5', navajowhite: '#FFDEAD', navy: '#000080',
  oldlace: '#FDF5E6', olive: '#808000', olivedrab: '#6B8E23',
  orange: '#FFA500', orangered: '#FF4500', orchid: '#DA70D6',
  palegoldenrod: '#EEE8AA', palegreen: '#98FB98', paleturquoise: '#AFEEEE',
  palevioletred: '#DB7093', papayawhip: '#FFEFD5', peachpuff: '#FFDAB9',
  peru: '#CD853F', pink: '#FFC0CB', plum: '#DDA0DD',
  powderblue: '#B0E0E6', purple: '#800080', rebeccapurple: '#663399',
  red: '#FF0000', rosybrown: '#BC8F8F', royalblue: '#4169E1',
  saddlebrown: '#8B4513', salmon: '#FA8072', sandybrown: '#F4A460',
  seagreen: '#2E8B57', seashell: '#FFF5EE', sienna: '#A0522D',
  silver: '#C0C0C0', skyblue: '#87CEEB', slateblue: '#6A5ACD',
  slategray: '#708090', slategrey: '#708090', snow: '#FFFAFA',
  springgreen: '#00FF7F', steelblue: '#4682B4', tan: '#D2B48C',
  teal: '#008080', thistle: '#D8BFD8', tomato: '#FF6347',
  turquoise: '#40E0D0', violet: '#EE82EE', wheat: '#F5DEB3',
  white: '#FFFFFF', whitesmoke: '#F5F5F5', yellow: '#FFFF00',
  yellowgreen: '#9ACD32',
};

/**
 * Löst einen iCalendar-COLOR-Wert (CSS3-Name oder Hex) auf `#RRGGBB` auf.
 * @param {string|null|undefined} raw - Roher Property-Wert
 * @returns {string|null} Hex-Farbe in Großbuchstaben oder null
 */
export function resolveIcalColor(raw) {
  if (typeof raw !== 'string') return null;
  // iCal erlaubt hinter dem Namen einen optionalen ";"-Parameter — abschneiden.
  const value = raw.trim().split(';')[0].trim().toLowerCase();
  if (!value) return null;

  // Hex direkt (#RGB oder #RRGGBB)
  if (/^#[0-9a-f]{6}$/.test(value)) return value.toUpperCase();
  if (/^#[0-9a-f]{3}$/.test(value)) {
    const [r, g, b] = value.slice(1);
    return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
  }

  return CSS_COLOR_NAMES[value] || null;
}

/** Zerlegt `#RRGGBB` in {r,g,b}; null bei ungültigem Wert. */
function hexToRgb(hex) {
  const m = /^#([0-9a-fA-F]{6})$/.exec(String(hex ?? '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/**
 * Gewichtete RGB-Distanz nach der „redmean"-Näherung. Bildet die menschliche
 * Farbwahrnehmung deutlich besser ab als plain euklidisches RGB, ohne die Kosten
 * einer CIELAB-Konvertierung. Rückgabe ist ein relatives Distanzquadrat (nur zum
 * Vergleichen gedacht, keine echte Einheit).
 */
function redmeanDistance(a, b) {
  const rmean = (a.r + b.r) / 2;
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return (2 + rmean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rmean) / 256) * db * db;
}

/**
 * Findet in einer Paletten-Map (id → `#RRGGBB`) die id mit der geringsten
 * (perzeptuellen) Distanz zum Zielwert. Gebraucht für Outbound-Sync zu Anbietern
 * mit fester Farbpalette (z. B. Googles 11 Event-Farben), wo eine freie Hex-Farbe
 * verlustbehaftet auf die nächste Paletten-ID abgebildet werden muss.
 * @param {string} hex - Zielfarbe `#RRGGBB`
 * @param {Record<string,string>} paletteMap - id → Hex
 * @returns {string|null} nächste id, oder null bei ungültigem Ziel/leerer Palette.
 *   Bei Gleichstand gewinnt die zuerst geprüfte id.
 */
export function nearestColorId(hex, paletteMap) {
  const target = hexToRgb(hex);
  if (!target || !paletteMap) return null;
  let bestId = null;
  let bestDist = Infinity;
  for (const [id, val] of Object.entries(paletteMap)) {
    const rgb = hexToRgb(val);
    if (!rgb) continue;
    const dist = redmeanDistance(target, rgb);
    if (dist < bestDist) { bestDist = dist; bestId = id; }
  }
  return bestId;
}

export const __test = { CSS_COLOR_NAMES, hexToRgb };
