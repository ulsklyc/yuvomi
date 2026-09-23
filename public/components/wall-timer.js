/**
 * Modul: Kuechentimer der Wandflaeche (#844)
 * Zweck: Ein von Hand gestarteter Kurzzeitwecker auf dem Wandtablet - Minuten,
 *        kein Datum, kein Server.
 * Abhaengigkeiten: /i18n.js (t), /utils/wall-mode.js (nur als Nachbar, kein Import)
 *
 * ── WARUM ER IM BROWSER LEBT UND NICHT AUF DEM SERVER ─────────────────────
 *
 * Der Wunsch kam als Timer PLUS geraeteuebergreifende Benachrichtigung. Genau
 * die Benachrichtigung haette einen serverseitigen Timer erzwungen, weil ein
 * Telefon die Seite suspendiert, sobald der Bildschirm sperrt. Der Melder hat
 * selbst zurueckgesteckt: nur der Timer auf der Wand. Was bleibt, laeuft im
 * Browser des Geraets, das ohnehin an der Wand haengt und nicht schlafen geht -
 * kein Endpunkt, keine Tabelle, keine Migration.
 *
 * ── ZWEI DINGE, DIE AEHNLICH AUSSEHEN UND ES NICHT SIND ───────────────────
 *
 * Countdowns (#647) zaehlen in Tagen auf ein Datum zu, Erinnerungen haengen an
 * einem Termin. Dieser hier hat kein Datum, wird von Hand gestartet und ist in
 * Minuten vorbei. Er teilt deshalb bewusst nichts mit den beiden.
 *
 * ── DER ZUSTAND IST EINE ZAHL ─────────────────────────────────────────────
 *
 * Gespeichert wird nur der Endzeitpunkt, geraetelokal wie der Wandmodus selbst.
 * Alles andere leitet sich daraus ab: kein Eintrag heisst "keiner laeuft", ein
 * Zeitpunkt in der Zukunft "laeuft", einer in der Vergangenheit "abgelaufen,
 * noch nicht quittiert". Die Flaeche baut sich beim stillen Refresh neu auf;
 * ein Zustand im DOM waere bei jedem Aufbau weg, und einer im Modul waere beim
 * naechsten Laden der Seite weg.
 */

import { t } from '../i18n.js';

const TIMER_KEY = 'yuvomi-wall-timer';

/**
 * Die waehlbaren Dauern, in Minuten.
 *
 * Fuenf Knoepfe, keine Zahleneingabe: aus zwei Metern ist ein Tastenfeld nicht
 * bedienbar, und die Kueche braucht keine Minute 17. Die Reihe deckt das
 * Uebliche - Ei, Nudeln, Ziehzeit, Ofen.
 */
export const WALL_TIMER_PRESETS = [3, 5, 10, 15, 30];

/**
 * Solange ein Timer laeuft, traegt die Wurzel dieses Attribut. Der
 * Foto-Screensaver liest es und legt sich nicht darueber - eine Anzeige, die
 * hinter einem Bild verschwindet, waere kein Timer.
 *
 * Beim Ablaufen faellt es WEG, nicht erst beim Quittieren: das Signal ist dann
 * der Ton, und wer davon kommt, wischt ein Bild ohnehin beiseite. Andernfalls
 * bliebe der Screensaver blockiert, bis jemand den Knopf findet.
 */
const RUNNING_ATTR = 'data-wall-timer';

function safeGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    // Privatmodus/Quota: dann gibt es auf diesem Geraet eben keinen Timer.
    return null;
  }
}

function safeSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch { /* siehe safeGet */ }
}

function safeRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch { /* siehe safeGet */ }
}

/**
 * Der Zustand, wie er sich aus der einen gespeicherten Zahl ergibt.
 *
 * @param {number} [now] Millisekunden, injizierbar fuer Tests.
 * @returns {{ state: 'idle'|'running'|'done', remainingMs: number }}
 */
export function readWallTimer(now = Date.now()) {
  const raw = safeGet(TIMER_KEY);
  const endsAt = raw === null ? NaN : Number(raw);
  // Ein unlesbarer Eintrag ist kein Timer: lieber keiner als ein NaN, das sich
  // als "00:NaN" durch die Anzeige zieht.
  if (!Number.isFinite(endsAt)) return { state: 'idle', remainingMs: 0 };
  const remainingMs = endsAt - now;
  if (remainingMs > 0) return { state: 'running', remainingMs };
  return { state: 'done', remainingMs: 0 };
}

/** Startet einen Timer ueber `minutes` Minuten. */
export function startWallTimer(minutes, now = Date.now()) {
  safeSet(TIMER_KEY, String(now + minutes * 60_000));
}

/** Beendet ihn - abgebrochen wie quittiert gehen denselben Weg. */
export function clearWallTimer() {
  safeRemove(TIMER_KEY);
}

/** mm:ss, aufgerundet: 0,4 Sekunden Rest sind fuer den Lesenden noch "1". */
export function formatWallTimer(remainingMs) {
  const total = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Der Timer als Markup - die Anzeige oben, die Bedienung unten im Fuss.
 *
 * Beide Teile kommen aus EINER Funktion, weil sie einen Zustand zeigen: waeren
 * es zwei, koennte die eine Haelfte "laeuft" behaupten, waehrend die andere
 * noch die Startknoepfe anbietet.
 *
 * @returns {{ display: string, controls: string }}
 */
export function renderWallTimer({ state, remainingMs } = readWallTimer()) {
  if (state === 'idle') {
    // Die Startknoepfe stehen direkt da, ohne Auswahl-Ebene davor. Ein Menue
    // waere ein zweiter Tipp aus zwei Metern - und sein offener Zustand lebte
    // nur im DOM, das der stille Refresh regelmaessig neu baut.
    const buttons = WALL_TIMER_PRESETS.map((minutes) => `
        <button type="button" class="wall__timer-preset" data-wall-timer-start="${minutes}">
          ${t('dashboard.wallTimerMinutes', { count: minutes })}
        </button>`).join('');
    return {
      display: '',
      controls: `
      <div class="wall__timer-presets" role="group" aria-label="${t('dashboard.wallTimerLabel')}">
        ${buttons}
      </div>`,
    };
  }

  const done = state === 'done';
  // `role="timer"`, nicht `status`: eine Statusregion ist hoeflich live, und
  // der Sekundentakt schreibt in sie hinein - der Screenreader sagte „09:59",
  // „09:58", … an, solange der Timer lief. Die Timer-Rolle ist genau dafuer da
  // und schweigt (aria-live off). Die ZUSTANDSWECHSEL sagt `wireWallTimer`
  // ueber die Region des Aufrufers an: eine Region, die mit jedem Render neu
  // entsteht, wird von Screenreadern nicht verlaesslich gehoert.
  return {
    display: `
      <div class="wall__timer" data-state="${done ? 'done' : 'running'}" role="timer">
        <span class="wall__timer-value">${done ? t('dashboard.wallTimerDone') : formatWallTimer(remainingMs)}</span>
      </div>`,
    controls: `
      <button type="button" class="wall__foot-btn" id="wall-timer-stop"
              aria-label="${t(done ? 'dashboard.wallTimerAcknowledge' : 'dashboard.wallTimerCancel')}">
        <i data-lucide="${done ? 'check' : 'x'}" aria-hidden="true"></i>
        <span class="wall__foot-btn-label" aria-hidden="true">${t(done ? 'dashboard.wallTimerAcknowledge' : 'dashboard.wallTimerCancel')}</span>
      </button>`,
  };
}

/**
 * Drei kurze Toene, aus dem Nichts erzeugt.
 *
 * Keine Audiodatei: die haette vendort, ausgeliefert und im Service Worker
 * gecacht werden muessen, fuer anderthalb Sekunden Piepen. Der Kontext wird
 * beim START angelegt und nicht erst hier - eine Autoplay-Sperre laesst Ton nur
 * aus einer Nutzergeste heraus zu, und die Geste ist der Startknopf, nicht das
 * Ablaufen.
 */
function chime(ctx) {
  if (!ctx) return;
  try {
    const now = ctx.currentTime;
    for (let i = 0; i < 3; i++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      // Weich ein und aus: ein hart geschalteter Oszillator knackt.
      const at = now + i * 0.45;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.25, at + 0.02);
      gain.gain.linearRampToValueAtTime(0, at + 0.32);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.35);
    }
  } catch { /* Kein Ton ist besser als ein Fehler auf der Wand. */ }
}

/**
 * EIN Kontext je Seitensitzung, nicht je Render.
 *
 * Er stand bis zum Review in der Closure von `wireWallTimer` - und genau dort
 * konnte er nie wirken: der Startknopf erzeugt ihn und ruft sofort `rerender()`,
 * der die Flaeche neu baut und `wireWallTimer` mit einer frischen Closure
 * aufruft. Die beiden Renderzustaende schliessen einander aus: der Ruhezustand
 * hat den Knopf, aber keinen Sekundentakt; der laufende hat den Takt, aber
 * keinen Knopf, der den Kontext je gesetzt haette. Der Wecker lief also jedes
 * Mal auf `chime(null)` und blieb still.
 *
 * Modulweit heisst hier auch: er wird NICHT geschlossen. Ein `close()` beim
 * Seitenwechsel naehme dem naechsten Timer den Kontext, den er nur aus einer
 * Nutzergeste heraus wiederbekommen kann.
 */
let audioCtx = null;

/**
 * Der laufende Sekundentakt, modulweit gehalten.
 *
 * `wireWallTimer` wird auf einer Seite MEHRFACH gerufen: einmal auf der
 * Ladeflaeche, sobald sie im DOM steht, und noch einmal, wenn die Daten da sind.
 * Ein Intervall in der Aufruf-Closure ergaebe dann zwei Takte, die beim Ablauf
 * beide laeuten und beide neu zeichnen. Ein Aufruf raeumt deshalb den
 * vorherigen ab, bevor er seinen eigenen setzt.
 */
let tick = null;

function stopTick() {
  clearInterval(tick);
  tick = null;
}

function makeAudioContext() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    const ctx = new Ctx();
    ctx.resume?.();
    return ctx;
  } catch {
    return null;
  }
}

/**
 * Verdrahtet Start, Abbruch und den Sekundentakt.
 *
 * @param {HTMLElement} wall     Die `.wall`-Flaeche.
 * @param {() => void}  rerender Baut die Flaeche neu - fuer die Zustandswechsel.
 * @param {AbortSignal} signal   Raeumt Listener und Intervall beim Seitenwechsel ab.
 * @param {{ announce?: (message: string) => void }} [options]
 *   `announce` sagt Start, Abbruch und Ablauf an - ueber eine Live-Region, die
 *   den Neuaufbau der Flaeche ueberlebt. Ohne sie bleibt der Timer stumm wie
 *   bisher.
 */
export function wireWallTimer(wall, rerender, signal, { announce = () => {} } = {}) {
  // Auch ohne Flaeche: ein Takt aus einem frueheren Aufruf haette sonst
  // weitergezaehlt und in ein DOM geschrieben, das es nicht mehr gibt.
  stopTick();
  if (!wall) return;

  const setRunningAttr = (running) => {
    document.documentElement.toggleAttribute(RUNNING_ATTR, running);
  };

  wall.querySelectorAll('[data-wall-timer-start]').forEach((btn) => {
    /* DER ERSTE ZEIGER AUF EINER SCHLAFENDEN WAND WECKT NUR (Critique
     * 2026-09-23). Die Wand bringt ihren Betrachtern bei, dass eine Beruehrung
     * sie weckt (`data-wall-awake`, wireWallSurface) - und die Startknoepfe
     * liegen im Fussband, genau dort, wo so eine Beruehrung landet. Ein Tipp,
     * der die Flaeche wecken sollte, startete einen Timer, der Minuten spaeter
     * im leeren Flur laeutet und bis dahin den Screensaver blockiert.
     *
     * Gemessen wird der Zustand BEIM pointerdown: das Wecken haengt als
     * Bubble-Listener am window und setzt das Attribut erst danach, der click
     * kaeme also immer auf eine wache Wand. Die Tastatur (click mit detail 0,
     * ohne pointerdown) ist davon ausgenommen - wer fokussiert, sieht den
     * Knopf per :focus-visible bereits voll.
     *
     * Der Ausstieg und der Abbruch-Knopf sind NICHT gedrosselt: der eine ist
     * der Notausgang der Flaeche, der andere beendet einen Timer, den man
     * laufen sieht. */
    let pressedWhileAsleep = false;
    btn.addEventListener('pointerdown', () => {
      pressedWhileAsleep = !wall.hasAttribute('data-wall-awake');
    }, { signal });
    btn.addEventListener('click', (event) => {
      const wakeOnly = pressedWhileAsleep && event.detail !== 0;
      pressedWhileAsleep = false;
      if (wakeOnly) return;
      // Angelegt bei der ersten Geste - eine Autoplay-Sperre laesst Ton nur
      // daraus zu, und spaeter gibt es keine mehr.
      audioCtx = audioCtx ?? makeAudioContext();
      const minutes = Number(btn.dataset.wallTimerStart);
      startWallTimer(minutes);
      setRunningAttr(true);
      rerender();
      announce(t('dashboard.wallTimerStarted', { duration: t('dashboard.wallTimerMinutes', { count: minutes }) }));
    }, { signal });
  });

  wall.querySelector('#wall-timer-stop')?.addEventListener('click', () => {
    const wasDone = readWallTimer().state === 'done';
    clearWallTimer();
    setRunningAttr(false);
    rerender();
    // Quittieren braucht keine Ansage: das Laeuten war die Nachricht, und der
    // Knopf, auf dem der Fokus lag, heisst schon „Timer aus".
    if (!wasDone) announce(t('dashboard.wallTimerCancelled'));
  }, { signal });

  const value = wall.querySelector('.wall__timer-value');
  const running = wall.querySelector('.wall__timer[data-state="running"]');
  setRunningAttr(!!running);
  if (!running || !value) return;

  // Der Sekundentakt schreibt NUR in den einen Textknoten. Ein rerender() je
  // Sekunde baute die halbe Seite neu und liesse den Screensaver nie zur Ruhe
  // kommen - der Zustandswechsel am Ende ist der einzige, der einen braucht.
  tick = setInterval(() => {
    const next = readWallTimer();
    if (next.state === 'running') {
      value.textContent = formatWallTimer(next.remainingMs);
      return;
    }
    stopTick();
    setRunningAttr(false);
    chime(audioCtx);
    rerender();
    // Das Laeuten ist die Nachricht fuer den Flur, die Ansage die fuer den
    // Screenreader: die neu gebaute Anzeige selbst spricht nicht (role timer).
    announce(t('dashboard.wallTimerDone'));
  }, 1000);
  // DAS ATTRIBUT GEHOERT NICHT DEM INTERVALL. Wer den Wandmodus mit laufendem
  // Timer verlaesst, bricht dieses Verdrahten ab - und ausserhalb der Wand
  // verdrahtet niemand mehr, der es zuruecknehmen koennte. Das Attribut waere
  // fuer den Rest der Sitzung an `<html>` haengengeblieben und haette den
  // Screensaver auf JEDER Seite unterdrueckt.
  signal.addEventListener('abort', () => {
    stopTick();
    setRunningAttr(false);
  });
}
