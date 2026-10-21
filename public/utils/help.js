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
      // „Mehr“ = vollständiger Modulkatalog; Favoriten in den Einstellungen.
      { icon: 'layout-grid', desc: t('nav.moreCatalogHint') },
      { icon: 'settings',    desc: t('help.mobileSettings') },
    ];
  }
  // `label` nennt Zweitbelegungen mit („k / ←"); ohne sie steht die Taste selbst.
  // `hidden`: ein Kuerzel, das wirkt, aber schon im Label eines anderen steht
  // (`g s` in „g s / g k s") - ein Ziel, eine Zeile.
  return shortcuts.filter((s) => !s.hidden).map((s) => ({ key: s.label?.() ?? s.key, desc: s.description() }));
}
