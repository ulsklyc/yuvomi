/**
 * Neutraler Ersatz-Avatarhintergrund, wenn ein Benutzer keine eigene Farbe hat.
 * Als konkreter Hex nötig, weil getReadableTextColor die Luminanz berechnet —
 * eine CSS-Variable ließe sich hier nicht auswerten. Einzige Quelle der Wahrheit
 * für alle Avatar-Renderer (neutrales Systemgrau, farbtonlos).
 */
export const AVATAR_FALLBACK_COLOR = '#8E8E93';

/**
 * Die Farben, die ein Objekt ohne Bild bekommt - Mitglieder seit jeher, und
 * seit #469 auch die Kacheln der Schnellzugriffe.
 *
 * SIE STEHT HIER UND NICHT MEHR IN admin-family.js, weil sie ab jetzt zwei
 * Aufrufer hat. Eine zweite Palette daneben hätte ausgesehen wie eine
 * Entscheidung und wäre eine Abschrift gewesen: eine Kachel neben einem
 * Mitgliedsbild spricht dieselbe Sprache oder sie fällt auf. Die Kalenderfarben
 * bleiben davon unberührt - sie beantworten eine andere Frage (#856) und teilen
 * mit dieser Liste bewusst keinen Wert.
 */
export const AVATAR_COLORS = ['#007AFF', '#34C759', '#FF9500', '#FF3B30', '#AF52DE', '#FF2D55'];

/**
 * DIE EINE STARTPALETTE FUER NUTZERFARBEN (Re-Critique 2026-09-28, P9).
 *
 * Schichtplan-Presets, Abfallarten, der Haushaltshilfe-Default und neue
 * Budget-Kategorien zogen ihre Startwerte aus vier eigenen Listen nach zwei
 * Regeln: die Abfall-Palette gegen beide Themes gewaehlt, die Schicht-Presets
 * nur gegen Weiss (im Dark lagen 14 von 15 unter 3:1), und zwei davon trugen
 * #7C3AED - im Dark exakt die Flaeche des Primaerknopfs.
 *
 * Jede Farbe hier haelt >= 3:1 (Nicht-Text-Kontrast, WCAG 1.4.11) auf
 * `--color-surface` UND `--color-surface-raised`, Light (#FFFFFF/#FBFBFD) wie
 * Dark (#2B2825/#37332E); keine liegt im Markenband (Hue 245-275). Der Test
 * in test-waste-ui.js rechnet das gegen tokens.css nach.
 *
 * NUR STARTWERTE: Bestandsdaten behalten ihre Farbe (keine Migration); ein
 * Farbwaehler zeigt eine fremde Bestandsfarbe als eigenen Swatch.
 * Reihenfolge = Reihenfolge im Raster; die Namen fuehrt jeder Aufrufer.
 */
export const USER_COLORS = [
  '#78808C', '#3B82F6', '#16A34A', '#D97706', '#059669',
  '#D946EF', '#EF4444', '#0891B2', '#EA580C', '#EC4899',
];

/** Vorgabe fuer einen neuen Datensatz ohne eigene Wahl (Cyan, wie der Schichtplan-Default). */
export const USER_COLOR_DEFAULT = '#0891B2';

/**
 * Returns the design-system text token with the stronger WCAG contrast
 * against an arbitrary six-digit hex background.
 */
export function getReadableTextColor(background) {
  const rgb = parseHexColor(background);
  if (!rgb) return 'var(--color-text-primary)';

  const luminance = relativeLuminance(rgb);
  const whiteContrast = 1.05 / (luminance + 0.05);
  const blackContrast = (luminance + 0.05) / 0.05;

  return whiteContrast >= blackContrast
    ? 'var(--color-text-on-accent)'
    : 'var(--color-ink-on-bright)';
}

function parseHexColor(value) {
  const match = String(value || '').trim().match(/^#([0-9a-f]{6})$/i);
  if (!match) return null;

  return [0, 2, 4].map((offset) => Number.parseInt(match[1].slice(offset, offset + 2), 16));
}

function relativeLuminance([red, green, blue]) {
  const linearize = (channel) => {
    const value = channel / 255;
    return value <= 0.03928
      ? value / 12.92
      : ((value + 0.055) / 1.055) ** 2.4;
  };

  return 0.2126 * linearize(red)
    + 0.7152 * linearize(green)
    + 0.0722 * linearize(blue);
}
