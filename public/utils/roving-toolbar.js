/**
 * Modul: Symbolleiste mit rovingem tabindex (APG toolbar)
 * Zweck: Eine Gruppe sichtbarer Aktionen ist EIN Tab-Stopp; die Pfeiltasten
 *        laufen innerhalb der Gruppe. Gebaut fuer die Aktionen je Dokument
 *        (Critique 2026-09-25, Sam: drei Tab-Stopps je Dokument, 27 bei neun
 *        Dokumenten) - die Aktionen bleiben sichtbar und klickbar, nur die
 *        Tab-Taste springt von Dokument zu Dokument.
 * Abhaengigkeiten: keine. `rovingIndex` ist rein und laeuft in
 *        test:documents-ux als Programm; `wireRovingToolbars` haengt einen
 *        einzigen delegierten Listener an den Traeger, damit ein Neuzeichnen
 *        der Liste keinen Listener je Zeile hinterlaesst.
 *
 * Markup-Vertrag: `[role="toolbar"]` mit genau einem Eintrag `tabindex="0"`
 * und allen weiteren auf `tabindex="-1"`.
 */

/**
 * Wohin eine Taste den Fokus in einer Leiste mit `count` Eintraegen schickt.
 * Links/Rechts laufen im Kreis, Pos1/Ende springen an den Rand. Hoch und
 * Runter gehoeren NICHT dazu: eine waagerechte Leiste in einer scrollenden
 * Liste nimmt der Seite nicht das Scrollen weg.
 *
 * @returns {number|null}  neuer Index, oder null, wenn die Taste nicht zur Leiste gehoert
 */
export function rovingIndex(key, index, count) {
  if (!count) return null;
  if (key === 'ArrowRight') return (index + 1) % count;
  if (key === 'ArrowLeft') return (index - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

/** Die bedienbaren Eintraege einer Leiste - ausgeblendete (display: none) zaehlen nicht. */
export function toolbarItems(toolbar) {
  return [...toolbar.querySelectorAll('[tabindex]')].filter((el) => el.getClientRects().length > 0);
}

/** Den Tab-Stopp der Leiste auf `target` legen. */
function setStop(toolbar, target) {
  for (const el of toolbar.querySelectorAll('[tabindex]')) el.tabIndex = el === target ? 0 : -1;
}

/**
 * Verdrahtet alle `[role="toolbar"]` unter `root` - einmal je Traeger. Faellt
 * der Tab-Stopp auf einen ausgeblendeten Eintrag (Herunterladen unter 30rem),
 * waere die Leiste per Tab unerreichbar; deshalb greift beim Fokus-Eintritt
 * und bei jeder Taste der erste SICHTBARE Eintrag.
 */
export function wireRovingToolbars(root) {
  if (!root || root.dataset.rovingToolbars === 'wired') return;
  root.dataset.rovingToolbars = 'wired';
  root.addEventListener('keydown', (event) => {
    const toolbar = event.target.closest?.('[role="toolbar"]');
    if (!toolbar || !root.contains(toolbar)) return;
    const items = toolbarItems(toolbar);
    const next = rovingIndex(event.key, Math.max(0, items.indexOf(event.target)), items.length);
    if (next === null) return;
    event.preventDefault();
    setStop(toolbar, items[next]);
    items[next].focus();
  });
  // Ein Klick oder Fokus auf einen Eintrag macht ihn zum Einstieg der Leiste:
  // wer zurueck-tabbt, landet dort, wo er zuletzt war.
  root.addEventListener('focusin', (event) => {
    const toolbar = event.target.closest?.('[role="toolbar"]');
    if (!toolbar || !root.contains(toolbar) || !event.target.matches('[tabindex]')) return;
    setStop(toolbar, event.target);
  });
  // WAS SICHTBAR IST, ENTSCHEIDET DIE BREITE, NICHT DAS ZEICHNEN. Unter 30rem
  // blenden die Dokumentzeilen Auge und Herunterladen aus (Re-Critique
  // 2026-09-25). Wer breit anfaengt und schmal wird - Drehen, Fenster, die
  // Ordnerleiste klappt auf -, hat den Einstieg noch auf dem Auge, und ein
  // Einstieg auf display: none nimmt die ganze Leiste aus der Tab-Kette. Der
  // Traeger aendert dabei seine Groesse, also zieht das der Beobachter nach.
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => repairRovingStops(root)).observe(root);
  }
}

/**
 * Nach dem Zeichnen: steht der Einstieg einer Leiste auf einem ausgeblendeten
 * Eintrag, rueckt er auf den ersten sichtbaren.
 */
export function repairRovingStops(root) {
  for (const toolbar of root?.querySelectorAll('[role="toolbar"]') ?? []) {
    const stop = toolbar.querySelector('[tabindex="0"]');
    if (stop && stop.getClientRects().length > 0) continue;
    const first = toolbarItems(toolbar)[0];
    if (first) setStop(toolbar, first);
  }
}

/**
 * Der Einstieg der ersten Leiste unter `root`, sofern er sichtbar ist - das
 * Ziel der Sprungmarke "Zu den Dokumenten". Vorher `repairRovingStops`
 * gelaufen, ist das der erste sichtbare Eintrag des ersten Dokuments.
 *
 * @returns {HTMLElement|null}
 */
export function firstRovingStop(root) {
  for (const toolbar of root?.querySelectorAll('[role="toolbar"]') ?? []) {
    const stop = toolbar.querySelector('[tabindex="0"]');
    if (stop && stop.getClientRects().length > 0) return stop;
  }
  return null;
}
