/**
 * Modul: Toast-Fläche
 * Zweck: WO Toasts leben - einmal, für die Shell, die die Container anlegt, und
 *        für jeden, der einen Toast anhängt.
 *
 * ANLASS (2026-08-10): die Erinnerungs-Toasts suchten `#toast-container`. Den
 * gab es bis v0.52.15; dann teilte die Shell ihn in eine höfliche und eine
 * bestimmte Live-Region und benannte beide um. `reminders.js` fand seitdem
 * nichts mehr und brach still ab (`if (!container) return`) - fast drei Monate
 * lang erschien keine einzige In-App-Erinnerung, während im Quelltext alles
 * richtig dastand. Dieselbe Sorte Bruch wie bei den Wischgesten im Einkauf:
 * sichtbar nur im gerenderten Dokument, nie im Diff.
 *
 * DIE ANTWORT IST NICHT „richtige ID eintragen", sondern EIN Ort für den Namen.
 * Wer den Container anlegt und wer ihn sucht, lesen dieselbe Konstante; ein
 * Umbenennen kann damit nicht mehr die eine Seite treffen und die andere nicht.
 * Ein Guard hält es (`ein Toast-Container hat genau einen Namensgeber`,
 * test:frontend-audit).
 *
 * DIE DRINGLICHKEIT WÄHLT DIE REGION, nicht der Aufrufer nach Gefühl: `polite`
 * ist die Voreinstellung, `assertive` gehört den Meldungen, die eine Vorlesung
 * unterbrechen dürfen (Fehler, Warnungen).
 */

export const TOAST_SURFACES = Object.freeze({
  polite: 'toast-container-polite',
  assertive: 'toast-container-assertive',
});

/**
 * Der Container für eine Dringlichkeit, oder null, solange die Shell noch nicht
 * steht.
 * @param {'polite'|'assertive'} [urgency='polite']
 * @returns {HTMLElement|null}
 */
export function toastSurface(urgency = 'polite') {
  return document.getElementById(TOAST_SURFACES[urgency] ?? TOAST_SURFACES.polite);
}

/**
 * DAUERHAFTE TOASTS - die, die nicht nach Sekunden von selbst gehen, sondern
 * stehen bleiben, bis jemand sie verwirft (die faellige Erinnerung, 30 s).
 * Eine Rueckmeldung mit Frist darf kurz ueber einem Dialog liegen; ein
 * dauerhafter Toast lag dort eine halbe Minute ueber dem Formular (Re-Critique
 * 2026-09-27, Casey; R9 M14). Die Toast-Lage (toast-placement.js) laesst ihn
 * deshalb weichen, und mobil ist er kompakt (layout.css).
 *
 * Der Name steht HIER, weil hier steht, wo Toasts leben: wer einen neuen
 * dauerhaften Toast baut, setzt `data-toast-persistent` und muss die Lage-Regel
 * nicht kennen.
 */
export const PERSISTENT_TOAST_SELECTOR = '.toast--reminder, [data-toast-persistent]';

/**
 * PLATZ FUER EINEN NEUEN DAUERHAFTEN TOAST: HOECHSTENS `max` TOASTS STEHEN,
 * UND WEICHEN DARF NUR EIN DAUERHAFTER (R22 S10).
 *
 * Erinnerungen sind ein eigener Kanal neben der einen Rueckmeldung (D18): sie
 * sind zeitgebunden und bleiben 30 s, die Rueckmeldung ersetzt nur sich selbst.
 * Bis hierher machte die Erinnerung Platz, indem sie den AELTESTEN Toast der
 * Flaeche entfernte - war das die Rueckmeldung, verschwand ihr "Rueckgaengig"
 * vor der Frist. Jetzt weicht die aelteste Erinnerung; die Zahl der Toasts
 * insgesamt bleibt bei `max` (mit dem neuen).
 * @param {HTMLElement|null} container
 * @param {number} [max=3]
 */
export function capPersistentToasts(container, max = 3) {
  const toasts = Array.from(container?.children ?? []).filter((el) => el.classList?.contains('toast'));
  const persistent = toasts.filter((el) => el.matches?.(PERSISTENT_TOAST_SELECTOR));
  let count = toasts.length;
  while (count >= max && persistent.length) {
    persistent.shift().remove();
    count -= 1;
  }
}

