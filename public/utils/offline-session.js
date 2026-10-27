/**
 * Modul: Ungepruefte Sitzung nach einem Kaltstart ohne Verbindung (#2293)
 * Zweck: Der Service Worker hat den Start aus dem Abzug der letzten Sitzung
 *        bedient (sw.js API_SNAPSHOTS, `offlineSnapshot: true`). Die App zeigt
 *        den gespeicherten Stand, aber die Sitzung hat niemand geprueft. Dieses
 *        Modul haelt den Zustand "ungeprueft", fragt `/auth/me` erneut, sobald
 *        es Grund zur Hoffnung gibt (online, Rueckkehr in den Vordergrund, alle
 *        `intervalMs`), und meldet das Ergebnis:
 *          - echte Antwort (kein Abzug)  -> onVerified(result), Zustand endet
 *          - 401                         -> Zustand endet; die Abmeldung macht
 *                                           `auth:expired` wie bei jeder Seite
 *          - Netzfehler oder wieder Abzug -> bleibt ungeprueft
 * Abhaengigkeiten: keine (Fenster, Dokument und Abfrage kommen von aussen,
 *        damit der Test ohne Browser faehrt)
 */

export const OFFLINE_SESSION_RETRY_MS = 30000;

/**
 * @param {object} deps
 * @param {EventTarget} deps.window
 * @param {{ visibilityState?: string, addEventListener: Function, removeEventListener: Function }} deps.document
 * @param {() => Promise<any>} deps.verify - fragt `/auth/me`
 * @param {(result: any) => (void|Promise<void>)} deps.onVerified
 * @param {(active: boolean) => void} deps.onChange
 * @param {number} [deps.intervalMs]
 */
export function createOfflineSession({ window, document, verify, onVerified, onChange, intervalMs = OFFLINE_SESSION_RETRY_MS }) {
  let active = false;
  let checking = false;
  let timer = null;

  const onVisible = () => { if (document.visibilityState !== 'hidden') check(); };

  function stop() {
    if (!active) return;
    active = false;
    window.removeEventListener('online', check);
    document.removeEventListener('visibilitychange', onVisible);
    if (timer !== null) clearInterval(timer);
    timer = null;
    onChange(false);
  }

  async function check() {
    if (!active || checking) return;
    checking = true;
    try {
      const result = await verify();
      if (!active || result?.offlineSnapshot === true) return;
      stop();
      await onVerified(result);
    } catch (err) {
      if (err?.status === 401) stop();
    } finally {
      checking = false;
    }
  }

  return {
    start() {
      if (active) return;
      active = true;
      window.addEventListener('online', check);
      document.addEventListener('visibilitychange', onVisible);
      timer = setInterval(check, intervalMs);
      onChange(true);
    },
    stop,
    check,
    isActive: () => active,
  };
}
