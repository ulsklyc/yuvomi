/**
 * Modul: Service Worker Registrierung
 * Zweck: Ausgelagert aus index.html um CSP-Inline-Script-Verletzung zu vermeiden.
 *        Meldet Updates via controllerchange an den Router.
 * Abhängigkeiten: keine
 */

/**
 * EIN UPDATE IST DER WECHSEL VON EINEM ALTEN AUF EINEN NEUEN CONTROLLER.
 *
 * `controllerchange` feuert auch beim allerersten Besuch: der frisch
 * installierte Worker uebernimmt die Seite (`skipWaiting` + `clients.claim()`
 * in sw.js), und vorher gab es keinen. Bis R18 lud die Seite dann nach 200 ms
 * neu - gemessen 1,0 bis 4,5 s nach dem Start, mitten ins Anmeldeformular,
 * dessen Eingabe damit weg war. Ein Erstinstall ist kein Update: es gibt keine
 * alte Shell, gegen die eine neue Seite gebunden werden koennte.
 *
 * WAS BEI EINEM UPDATE GESCHIEHT, ENTSCHEIDET DER ROUTER (utils/app-update.js),
 * nicht diese Datei: nur er weiss, ob gerade ein Dialog offen ist, eine Seite
 * ungespeicherte Arbeit haelt oder jemand tippt. Diese Datei meldet das Update
 * nur. Sie kann vor dem Router fertig sein, deshalb merkt sie es sich: wer sich
 * spaeter anmeldet, erfaehrt es sofort.
 */
let updatePending = false;
const updateListeners = new Set();

/**
 * Meldet einen Empfaenger fuer "ein neuer Service Worker hat uebernommen" an.
 * War das Update schon da, wird er sofort gerufen.
 * @param {() => void} fn
 * @returns {() => void} Abmeldung
 */
export function onServiceWorkerUpdate(fn) {
  updateListeners.add(fn);
  if (updatePending) fn();
  return () => updateListeners.delete(fn);
}

/**
 * So lange wartet ein Update auf einen Empfaenger, bevor diese Datei selbst neu
 * laedt. Der Empfaenger ist der Router; meldet er sich nicht, ist er nicht
 * geladen (Ladefehler, kaputte Shell) - dann gibt es auch niemanden, den ein
 * Reload unterbraeche, und er ist der einzige Weg, auf dem eine reparierte
 * Version die Seite von selbst erreicht.
 */
export const UPDATE_ORPHAN_RELOAD_MS = 10000;

/**
 * Wartezeit vor einem Reload nach `controllerchange`. Auf iOS-Standalone fuehrt
 * ein sofortiger Reload zu Timing-Problemen (leere Seite, verlorene Cookies):
 * der neue Worker soll vollstaendig aktiviert sein und `clients.claim()`
 * abgeschlossen haben. utils/app-update.js haelt dieselbe Frist ein.
 */
export const UPDATE_RELOAD_DELAY_MS = 200;

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
      .then((registration) => registration.update())
      .catch((err) => {
        console.warn('[SW] Registrierung fehlgeschlagen:', err);
      });
  });

  // Stand beim Laden DIESES Dokuments. Danach traegt jeder Wechsel den
  // Vorgaenger selbst bei: nach dem Erstinstall ist die Seite kontrolliert,
  // der naechste Wechsel also ein echtes Update.
  let controlled = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    const hadController = controlled;
    controlled = true;
    if (!hadController || updatePending) return;
    updatePending = true;
    if (updateListeners.size) {
      updateListeners.forEach((fn) => fn());
      return;
    }
    setTimeout(() => {
      if (!updateListeners.size) window.location.reload();
    }, UPDATE_ORPHAN_RELOAD_MS);
  });

  const refreshSw = () => {
    navigator.serviceWorker.getRegistration()
      .then((registration) => registration?.update())
      .catch(() => {});
  };

  window.addEventListener('focus', refreshSw);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshSw();
  });
}

/**
 * Weist den aktiven Service Worker an, den Read-only-Offline-API-Cache zu leeren.
 * Aufgerufen bei Logout und Session-Ende, um Daten-Leaks bei Nutzerwechsel am
 * selben Gerät zu verhindern. Defensive Guards: kein SW / kein Controller → No-Op.
 */
/**
 * Den API-Cache leeren - und WARTEN, bis er wirklich leer ist.
 *
 * DAS ABSCHICKEN ALLEIN REICHT NICHT. `postMessage` kehrt sofort zurueck, das
 * Loeschen im Worker laeuft in einem `waitUntil`, und wer danach unmittelbar
 * neu laedt, kann von seinem eigenen, noch nicht geleerten Cache bedient
 * werden - beim Koppeln eines Tabletts waeren das die privaten Antworten der
 * Person, die das Geraet vorher benutzt hat. Der Worker quittiert deshalb ueber
 * einen MessageChannel, und diese Funktion liefert ein Versprechen darauf.
 *
 * DIE FRIST IST KEIN SCHMUCK: gibt es keinen Controller, ist der Worker gerade
 * am Wechseln oder antwortet er nicht, darf der Aufrufer nicht ewig haengen -
 * eine Kopplung, die nicht weitergeht, ist schlimmer als ein Cache, der ein
 * paar Sekunden zu lange lebt. Das Versprechen erfuellt sich dann trotzdem; der
 * Aufrufer entscheidet nichts anders, er wartet nur nicht laenger.
 */
export function clearApiCache({ timeoutMs = 2000 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    try {
      const worker = 'serviceWorker' in navigator ? navigator.serviceWorker.controller : null;
      if (!worker) return finish();
      const channel = new MessageChannel();
      channel.port1.onmessage = finish;
      worker.postMessage({ type: 'CLEAR_API_CACHE' }, [channel.port2]);
      setTimeout(finish, timeoutMs);
      return undefined;
    } catch (err) {
      console.warn('[SW] clearApiCache fehlgeschlagen:', err);
      return finish();
    }
  });
}
