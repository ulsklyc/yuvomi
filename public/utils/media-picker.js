/**
 * EIN BEDIENELEMENT FUER EIN BILD (Critique R24, Bausteine (5)).
 *
 * Bild, Logo und Symbol wurden mit zwei oder drei Bedienelementen gewaehlt:
 * die Scheibe des Geburtstags UND ein Stift-Knopf daneben (beide oeffneten
 * dieselbe Dateiwahl), die Abo-Kachel UND "Logo hochladen" darunter, das
 * Schichtart-Symbol mit einem durchgestrichenen Bild ("image-off"), das wie
 * ein Fehler aussah. Die Form ist jetzt EINE: das Vorschaubild ist der Knopf,
 * ein kleines Abzeichen an seiner Ecke sagt, dass man es aendern kann
 * (`.media-picker` + `.media-picker__badge`, layout.css). Entfernen ist eine
 * eigene Handlung und steht - nur wenn es etwas zu entfernen gibt - als Text
 * darunter (`.media-picker__remove`).
 *
 * Das Abzeichen ist Schmuck (`aria-hidden`): den Namen traegt der Knopf.
 */
export function mediaPickerBadgeHtml(icon = 'pencil') {
  return `<span class="media-picker__badge" aria-hidden="true"><i data-lucide="${icon}"></i></span>`;
}
