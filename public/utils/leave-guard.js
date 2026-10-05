/**
 * Modul: Verlassen-Schutz
 * Zweck: Eine Seite mit ungespeicherter Arbeit darf fragen, bevor sie
 *        verschwindet - egal, ueber welchen Weg der Wechsel kommt
 *        (Seitenleiste, Tab-Leiste, Mehr-Blatt, Befehlspalette, Zurueck).
 * Abhaengigkeiten: keine
 *
 * WARUM EINE EIGENE STELLE (Re-Critique 2026-09-28, A7 P2-1). Der
 * Anpassen-Modus der Uebersicht fragte beim Abbrechen nach, aber ein Tipp auf
 * "Kalender" in der Tab-Leiste warf die halbe Anordnung wortlos weg: jeder
 * dieser Wege endet in `navigate()` des Routers, und keiner davon kannte die
 * Seite. Statt jedem Weg einzeln beizubringen, was eine Seite zu verlieren
 * hat, fragt der Router HIER - und die Seite meldet sich an, solange sie
 * etwas zu verlieren hat.
 *
 * EIN Waechter, nicht eine Liste: es ist immer genau eine Seite sichtbar. Wer
 * sich anmeldet, bekommt eine Abmeldung zurueck, die nur den EIGENEN Waechter
 * entfernt - raeumt eine Seite spaet auf, nimmt sie der naechsten nichts weg.
 */

let guard = null;

/**
 * Meldet einen Waechter an. `fn(toPath)` liefert (oder verspricht) `false`,
 * wenn der Wechsel unterbleiben soll; alles andere laesst ihn zu.
 * @param {(toPath: string) => (boolean|Promise<boolean>)} fn
 * @returns {() => void} Abmeldung, die nur diesen Waechter entfernt
 */
export function setLeaveGuard(fn) {
  guard = typeof fn === 'function' ? fn : null;
  return () => {
    if (guard === fn) guard = null;
  };
}

/**
 * Hat die sichtbare Seite gerade etwas zu verlieren? Synchron, damit der
 * Router ohne Waechter gar nicht erst wartet: jedes `await` vor
 * `isNavigating = true` waere eine Luecke, in der ein zweiter Aufruf noch
 * durchkaeme.
 * @returns {boolean}
 */
export function hasLeaveGuard() {
  return guard !== null;
}

/**
 * Darf die sichtbare Seite verlassen werden? Ohne Waechter sofort ja.
 *
 * Ein Waechter, der WIRFT, haelt niemanden fest: ein Programmierfehler in der
 * Rueckfrage darf nicht die ganze Navigation sperren. Er wird aber gemeldet,
 * nicht verschluckt.
 * @param {string} toPath
 * @returns {Promise<boolean>}
 */
export async function mayLeave(toPath) {
  const current = guard;
  if (!current) return true;
  try {
    return (await current(toPath)) !== false;
  } catch (err) {
    console.error('[leave-guard]', err);
    return true;
  }
}
