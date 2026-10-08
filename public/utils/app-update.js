/**
 * Modul: Update der laufenden App
 * Zweck: EIN Weg von "ein neuer Service Worker hat uebernommen" zum Neuladen -
 *        und nie mitten in einer Eingabe.
 * Abhaengigkeiten: keine (alles kommt von aussen, damit test/test-app-update.js
 *        den Ablauf ohne Browser fahren kann)
 *
 * WARUM EINE EIGENE STELLE (Critique R18, "Start und Laden stolpern"). Bis
 * dahin gab es zwei Wege, die nichts voneinander wussten: sw-register.js lud
 * 200 ms nach jedem `controllerchange` neu, der Router zeigte auf `SW_UPDATED`
 * einen Hinweis und lud nach 8 s. Der erste schlug den zweiten immer, und
 * keiner fragte, ob gerade ein Dialog offen ist, eine Seite ungespeicherte
 * Arbeit haelt (utils/leave-guard.js) oder jemand tippt - ein halb
 * ausgefuelltes Formular war dann weg.
 *
 * DIE REGEL. Ein Update macht die Shell SOFORT alt (`onStale`, der Schutz aus
 * #616: ab da laedt der Router kein Seitenmodul mehr nach). Neu geladen wird,
 * wenn es niemanden unterbricht:
 *   - gleich (nach der iOS-Frist), wenn niemand beschaeftigt ist;
 *   - sonst beim naechsten Seitenwechsel (das kann `importPage()` im Router
 *     schon, es fragt vorher den Verlassen-Schutz);
 *   - oder wenn die App in den Hintergrund geht und dann niemand beschaeftigt
 *     ist. Ein offener Dialog bleibt auch im Hintergrund stehen: wer kurz die
 *     App wechselt, um etwas zu kopieren, findet sein Formular wieder.
 * Wer beschaeftigt ist, bekommt den Hinweis mit einem Knopf und entscheidet
 * selbst.
 */

/** Textfelder, in denen eine Eingabe verloren gehen kann. */
const TEXT_INPUT_TYPES = new Set([
  '', 'text', 'search', 'email', 'url', 'tel', 'password', 'number',
  'date', 'time', 'datetime-local', 'month', 'week',
]);

function isTextField(el) {
  if (!el || typeof el !== 'object') return false;
  const tag = String(el.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') return TEXT_INPUT_TYPES.has(String(el.type || '').toLowerCase());
  return el.isContentEditable === true;
}

function fieldText(el) {
  return String(el.value ?? el.textContent ?? '').trim();
}

/**
 * Tippt gerade jemand? Der Fokus steht in einem Textfeld, und dieses Feld oder
 * ein Nachbar im selben Formular traegt Inhalt. Das Formular zaehlt mit, weil
 * die Anmeldung der gemessene Fall ist: Benutzername getippt, Fokus schon im
 * noch leeren Passwortfeld.
 * @param {Document} doc
 * @returns {boolean}
 */
export function isTyping(doc) {
  const el = doc?.activeElement;
  if (!isTextField(el)) return false;
  if (fieldText(el)) return true;
  const form = typeof el.closest === 'function' ? el.closest('form') : null;
  if (!form) return false;
  return Array.from(form.querySelectorAll('input, textarea'))
    .some((field) => isTextField(field) && fieldText(field) !== '');
}

/**
 * Wuerde ein Reload jetzt jemanden unterbrechen?
 * @param {{ document: Document, hasLeaveGuard: () => boolean, hasOpenOverlay: () => boolean }} deps
 * @returns {boolean}
 */
export function isUserBusy({ document, hasLeaveGuard, hasOpenOverlay }) {
  return hasOpenOverlay() || hasLeaveGuard() || isTyping(document);
}

/**
 * @param {object} deps
 * @param {Document} deps.document
 * @param {() => boolean} deps.isBusy - wuerde ein Reload jemanden unterbrechen?
 * @param {() => boolean} deps.reload - laedt neu; `false`, wenn die
 *   Schleifenbremse des Routers (`reloadOnce`) den Reload verweigert hat
 * @param {() => void} deps.onStale - die Shell ist ab jetzt alt (#616)
 * @param {() => void} deps.notify - der Hinweis mit dem Knopf
 * @param {number} deps.delayMs - iOS-Frist vor dem Reload (sw-register.js)
 * @param {(fn: () => void, ms: number) => unknown} [deps.setTimeout]
 * @returns {{ announce: () => void, isStale: () => boolean }}
 */
export function createUpdateFlow({
  document, isBusy, reload, onStale, notify, delayMs,
  setTimeout: later = globalThis.setTimeout,
}) {
  let stale = false;
  let notified = false;
  // Ist die iOS-Frist nach der Uebernahme um? Sie gilt JEDEM Reload-Weg, nicht
  // nur dem ersten: wer in den ersten Millisekunden die App wechselt, loeste
  // sonst genau den sofortigen Reload aus, den die Frist verhindern soll
  // (sw-register.js: leere Seite, verlorene Cookies auf iOS-Standalone).
  let settled = false;

  const notifyOnce = () => {
    if (notified) return;
    notified = true;
    notify();
  };

  // Verweigert die Schleifenbremse den Reload, bleibt die Seite alt, ohne dass
  // es jemand merkt - dann sagt es der Hinweis, und sein Knopf laedt ohne Bremse.
  const reloadOrNotify = () => {
    if (isBusy() || !reload()) notifyOnce();
  };

  document.addEventListener('visibilitychange', () => {
    if (stale && settled && document.visibilityState === 'hidden' && !isBusy()) reload();
  });

  return {
    /** Ein neuer Service Worker hat uebernommen. Mehrfach rufen ist harmlos. */
    announce() {
      if (stale) return;
      stale = true;
      onStale();
      if (isBusy()) {
        notifyOnce();
        // Kein Reload jetzt - aber ab dem Ende der Frist darf der Hintergrund
        // einen ausloesen. Wer bis dahin schon frei UND im Hintergrund ist,
        // wird dann neu geladen; ein sichtbarer Nutzer behaelt den Hinweis.
        later(() => {
          settled = true;
          if (document.visibilityState === 'hidden' && !isBusy()) reload();
        }, delayMs);
        return;
      }
      // Erst nach der Frist entscheiden: in ihr kann jemand einen Dialog
      // geoeffnet oder zu tippen begonnen haben.
      later(() => {
        settled = true;
        reloadOrNotify();
      }, delayMs);
    },
    isStale: () => stale,
  };
}
