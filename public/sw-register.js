/**
 * Modul: Service Worker Registrierung
 * Zweck: Ausgelagert aus index.html um CSP-Inline-Script-Verletzung zu vermeiden.
 *        Handhabt nahtlose Updates via controllerchange.
 * Abhängigkeiten: keine
 */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
      .then((registration) => registration.update())
      .catch((err) => {
        console.warn('[SW] Registrierung fehlgeschlagen:', err);
      });
  });

  // SW-Update: Auf iOS-PWA fuehrt ein sofortiger Reload bei controllerchange
  // zu Timing-Problemen (leere Seite, verlorene Cookies). Stattdessen nur
  // nachladen wenn die Seite gerade nicht mitten im Initialisieren ist.
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    // Kurz warten damit der neue SW vollstaendig aktiviert ist und
    // clients.claim() abgeschlossen hat, bevor die Seite neu laedt.
    // Auf iOS-Standalone verhindert das den "leere Seite"-Bug.
    setTimeout(() => window.location.reload(), 200);
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
