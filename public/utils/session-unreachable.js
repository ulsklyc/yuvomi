/**
 * Modul: Sitzung nicht pruefbar
 * Zweck: Der Fehlerzustand der Shell, wenn `/auth/me` beim Start NICHT mit
 *        "nicht angemeldet" (401) antwortet, sondern gar nicht oder mit einer
 *        Bremse (429), einem Serverfehler (5xx) oder ohne Netz.
 * Abhaengigkeiten: i18n.js, utils/empty-state.js, utils/friendly-error.js
 *
 * Bis hierher fuehrte JEDER Fehler der Sitzungspruefung zur Anmeldung
 * (Critique R19, 2026-10-16): ein Neustart des NAS, ein haengender Proxy oder
 * das Abruflimit, das sich hinter einem Proxy alle Geraete teilen, zeigte der
 * Familie das Anmeldeformular - mit gueltigen Cookies. Wer sich dann anmeldete,
 * lief obendrein in die Bremse der Anmeldung (5/min). Nur ein 401 sagt
 * "nicht angemeldet"; alles andere sagt "gerade nicht pruefbar", und dafuer
 * gibt es diesen Zustand: ein Satz zur Ursache, "Erneut versuchen" und ein
 * automatischer Versuch mit wachsendem Abstand, der `Retry-After` achtet.
 *
 * Die Entscheidung 401 oder nicht faellt in navigate() (utils/router-navigate.js);
 * dieses Modul zeichnet nur und plant den naechsten Versuch.
 */
import { t } from '/i18n.js';
import { emptyStateEl } from '/utils/empty-state.js';
import { loadErrorSentence } from '/utils/friendly-error.js';

/**
 * Wartezeit vor dem naechsten automatischen Versuch, in Millisekunden.
 *
 * Exponentiell ab 2 s bis 30 s (2, 4, 8, 16, 30, 30 ...). Nennt der Server mit
 * `Retry-After` eine laengere Pause - Sekunden oder ein HTTP-Datum -, gilt
 * seine: ein Versuch VOR dieser Zeit traefe nur wieder die Bremse. Gekappt bei
 * 10 Minuten, damit ein verirrter Kopf die Seite nicht fuer Stunden einfriert;
 * der Knopf "Erneut versuchen" bleibt ohnehin jederzeit.
 *
 * @param {number} attempt - 0 fuer den ersten Wiederholversuch
 * @param {string|number|null|undefined} retryAfter - Kopf `Retry-After`
 * @param {number} now - Date.now() des Aufrufers (fuer ein HTTP-Datum)
 * @returns {number}
 */
export function sessionRetryDelay(attempt, retryAfter, now) {
  const step = Math.max(0, Math.floor(Number(attempt)) || 0);
  const backoff = Math.min(30_000, 2000 * 2 ** Math.min(step, 10));
  let asked = 0;
  if (retryAfter != null && retryAfter !== '') {
    const text = String(retryAfter).trim();
    if (/^\d+$/.test(text)) {
      asked = Number(text) * 1000;
    } else {
      const at = Date.parse(text);
      if (Number.isFinite(at)) asked = at - now;
    }
  }
  return Math.min(600_000, Math.max(backoff, asked));
}

/** Der laufende Zustand: Zeitgeber, Netz-Lauscher und der gezeichnete Knoten. */
let episode = null;

function endEpisode() {
  if (!episode) return;
  episode.clearTimer(episode.timer);
  episode.win.removeEventListener('online', episode.onOnline);
  episode = null;
}

/**
 * Zeichnet den Fehlerzustand in `container` und plant den naechsten Versuch.
 *
 * Ein Aufruf, waehrend der vorige Zustand noch steht, zaehlt als weiterer
 * Fehlversuch derselben Folge (der Abstand waechst). Hat ein Versuch die Seite
 * gezeichnet, ist der Knoten weg, und die naechste Folge beginnt wieder bei 2 s.
 *
 * @param {HTMLElement} container - `#app`
 * @param {unknown} err - der Fehler aus `auth.me()`
 * @param {() => unknown} retry - startet die Navigation erneut
 * @param {object} [env] - fuer Tests: Uhr, Zeitgeber, window
 * @returns {HTMLElement|null} der gezeichnete Zustand
 */
export function showSessionUnreachable(container, err, retry, {
  now = Date.now,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  win = window,
} = {}) {
  if (!container) return null;
  const continued = Boolean(episode?.box?.isConnected);
  const attempt = continued ? episode.attempt + 1 : 0;
  endEpisode();

  const delay = sessionRetryDelay(attempt, err?.retryAfter, now());
  const seconds = Math.max(1, Math.round(delay / 1000));
  const status = Number(err?.status);

  const box = emptyStateEl({
    variant: 'error',
    icon: 'cloud-off',
    title: t('common.sessionUnreachableTitle'),
    description: loadErrorSentence(err) ?? t('common.loadErrorDescription'),
    hint: t('common.sessionRetryHint', { seconds }),
    details: {
      summary: t('common.errorDetails'),
      text: Number.isInteger(status) && status > 0
        ? `HTTP ${status} /auth/me`
        : `${err?.name ?? 'Error'}: ${err?.message ?? ''} /auth/me`,
    },
    action: {
      label: t('common.retry'),
      icon: 'refresh-cw',
      attrs: { 'data-action': 'session-retry' },
      onClick: () => runRetry(),
    },
    className: 'session-unreachable',
  });
  box.tabIndex = -1;

  const current = {
    attempt,
    box,
    win,
    clearTimer,
    timer: null,
    onOnline: () => runRetry(),
  };

  // EIN Versuch zur Zeit: Knopf, Zeitgeber und das `online`-Ereignis laufen
  // hier zusammen. Der Zustand bleibt stehen, bis die Navigation entschieden
  // hat - ein erneuter Fehler zeichnet ihn neu (Abstand waechst), ein Erfolg
  // ersetzt ihn durch die Seite.
  function runRetry() {
    if (episode !== current || current.running) return;
    current.running = true;
    current.clearTimer(current.timer);
    win.removeEventListener('online', current.onOnline);
    box.setAttribute('aria-busy', 'true');
    const button = box.querySelector('[data-action="session-retry"]');
    if (button) button.disabled = true;
    const hint = box.querySelector('.empty-state__hint');
    if (hint) hint.textContent = t('common.sessionRetrying');
    retry();
  }

  episode = current;
  current.timer = setTimer(runRetry, delay);
  win.addEventListener('online', current.onOnline);

  container.replaceChildren(box);
  if (win.lucide) win.lucide.createIcons({ el: box });
  box.focus?.({ preventScroll: true });
  return box;
}
