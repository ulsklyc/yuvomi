/**
 * Modul: Help-Overlay-Inhalt
 * Zweck: Entscheidet, welche Zeilen das Hilfe-Overlay zeigt — auf Desktop die
 *        Tastenkürzel, auf Touch/Mobile eine Klartext-Schnellhilfe (Tastenkürzel
 *        sind ohne Tastatur nutzlos). Pure Funktion ohne DOM, damit testbar.
 *
 * Rückgabe: Array von Zeilen.
 *   Desktop: { key: string, desc: string }
 *   Touch:   { icon: string, desc: string }  (icon = Lucide-Name)
 */
export function buildHelpRows({ coarsePointer, shortcuts, t }) {
  if (coarsePointer) {
    return [
      { icon: 'navigation',  desc: t('help.mobileNavigate') },
      { icon: 'plus-circle', desc: t('help.mobileCreate') },
      { icon: 'search',      desc: t('help.mobileSearch') },
      { icon: 'settings',    desc: t('help.mobileSettings') },
    ];
  }
  return shortcuts.map((s) => ({ key: s.key, desc: s.description() }));
}
